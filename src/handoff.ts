/**
 * Moving a session's history across the lock. Pure: index.ts gathers the inputs and acts.
 *
 * Into the lock (`planHandoff`):
 *
 * A session that locks mid-conversation moves from a cloud model's large window to the local
 * model's small one. pi's compaction sends everything before its kept tail to the routed model in
 * one request, and under a lock that is the local model: a long cloud history cannot fit, the
 * summary is cut off, and every retry fails the same way.
 *
 * Every request carries the whole branch, so everything up to the last successful cloud reply was
 * already sent to that reply's model. The handoff asks that same model to summarize exactly that
 * part and keeps everything after it raw. Nothing leaves the machine that the model has not
 * already received.
 */

/** The slice of a pi message this module reads. */
export interface HandoffMessage {
	role: string;
	content?: unknown;
	provider?: string;
	model?: string;
	stopReason?: string;
	timestamp?: number;
}

/** The slice of a pi `SessionEntry` this module reads. */
export interface HandoffEntry {
	type: string;
	id: string;
	message?: HandoffMessage;
	/** `context_edit` entries: the edited entry, and its new content (null removes it). */
	targetId?: string;
	replacement?: unknown;
}

export interface HandoffInput<M extends HandoffMessage = HandoffMessage> {
	/** The branch pi is compacting, oldest first. */
	branch: readonly HandoffEntry[];
	/** pi's summary input in branch order: `messagesToSummarize`, then `turnPrefixMessages`. */
	toSummarize: readonly M[];
	/** First entry pi would keep raw. */
	firstKeptEntryId: string;
	previousSummary?: string;
	/** Estimated tokens of `toSummarize` plus `previousSummary`. */
	inputTokens: number;
	/** Largest summary input the local model can take. */
	localBudget: number;
	/** True for a model served from off this machine. */
	isCloud: (provider: string, model: string) => boolean;
}

export interface HandoffPlan<M extends HandoffMessage = HandoffMessage> {
	provider: string;
	model: string;
	/** Messages that model already received, oldest first. */
	messages: M[];
	previousSummary?: string;
	firstKeptEntryId: string;
	/**
	 * An entry up to the reply was rewritten after it, so the model never received the content pi
	 * would send. Nothing may be sent; the history is kept as a local note instead.
	 */
	rewritten: boolean;
}

function isCloudReply(
	message: HandoffMessage | undefined,
	isCloud: HandoffInput["isCloud"],
): message is HandoffMessage & { provider: string; model: string } {
	return (
		message?.role === "assistant" &&
		message.stopReason !== "error" &&
		message.stopReason !== "aborted" &&
		typeof message.provider === "string" &&
		typeof message.model === "string" &&
		isCloud(message.provider, message.model)
	);
}

/** pi replaces a message it edits with a copy, so identity alone can miss the anchor. */
function sameReply(a: HandoffMessage, b: HandoffMessage): boolean {
	return (
		a === b ||
		(a.role === "assistant" &&
			b.timestamp !== undefined &&
			a.timestamp === b.timestamp &&
			a.provider === b.provider &&
			a.model === b.model)
	);
}

function hasToolCall(content: unknown): boolean {
	return Array.isArray(content) && content.some((block: { type?: string }) => block.type === "toolCall");
}

/** pi applies every `context_edit` on the branch, so one written after the reply changes what would be sent. */
function rewrittenAfter(branch: readonly HandoffEntry[], anchorAt: number): boolean {
	const position = new Map(branch.map((entry, index) => [entry.id, index]));
	return branch.slice(anchorAt + 1).some((entry) => {
		if (entry.type !== "context_edit" || entry.replacement === null) return false;
		const target = entry.targetId === undefined ? undefined : position.get(entry.targetId);
		return target !== undefined && target <= anchorAt;
	});
}

/**
 * The cloud summary to run instead of pi's local one, or undefined to leave compaction to pi: the
 * input fits the local model, nothing was ever sent to a cloud model, or the boundary is unclear.
 */
export function planHandoff<M extends HandoffMessage>(input: HandoffInput<M>): HandoffPlan<M> | undefined {
	if (input.inputTokens <= input.localBudget) return undefined;
	const anchorAt = input.branch.findLastIndex((entry) => isCloudReply(entry.message, input.isCloud));
	if (anchorAt === -1) return undefined;
	// A summary written after the last cloud reply can hold content that model never received.
	if (input.branch.findLastIndex((entry) => entry.type === "compaction") > anchorAt) return undefined;
	const anchor = input.branch[anchorAt];
	const reply = anchor.message as HandoffMessage & { provider: string; model: string };
	const base = {
		provider: reply.provider,
		model: reply.model,
		previousSummary: input.previousSummary,
		rewritten: rewrittenAfter(input.branch, anchorAt),
	};

	const replyAt = input.toSummarize.findIndex((message) => sameReply(message, reply));
	if (replyAt === -1) {
		// pi keeps the reply raw, so everything it would summarize came before it. If pi's cut is past
		// the reply yet the reply is not in the input, an edit removed it and the boundary is unclear.
		const keptAt = input.branch.findIndex((entry) => entry.id === input.firstKeptEntryId);
		if (keptAt === -1 || keptAt > anchorAt || input.toSummarize.length === 0) return undefined;
		return { ...base, messages: [...input.toSummarize], firstKeptEntryId: input.firstKeptEntryId };
	}
	// A reply that called tools stays raw: its results follow it and must keep their call. pi also
	// answers the calls of a reply cut off at the length limit, with failed results.
	const keepReply = reply.stopReason === "toolUse" || hasToolCall(reply.content);
	const firstKept = keepReply ? anchor : input.branch[anchorAt + 1];
	const messages = input.toSummarize.slice(0, keepReply ? replyAt : replyAt + 1);
	if (firstKept === undefined || messages.length === 0) return undefined;
	return { ...base, messages, firstKeptEntryId: firstKept.id };
}

/**
 * pi caps a summary at 0.8 × reserveTokens or the model's own output cap. The 0.6 factor absorbs
 * estimate error: a real session ran 1.31 real tokens per estimated token. Underestimating breaks
 * the session; overestimating only re-sends history the cloud model already has.
 */
/**
 * Out of the lock (`/leave-local`): the last cloud reply before the lock that ended its turn. That
 * model received everything up to it, so continuing from there on the cloud sends nothing new, and a
 * reply without tool calls is a clean place for the next user message.
 */
export function rewindTarget(
	branch: readonly HandoffEntry[],
	lockAt: number,
	isCloud: HandoffInput["isCloud"],
): HandoffEntry | undefined {
	for (let i = lockAt - 1; i >= 0; i--) {
		const message = branch[i].message;
		if (isCloudReply(message, isCloud) && message.stopReason !== "toolUse" && !hasToolCall(message.content)) {
			return branch[i];
		}
	}
	return undefined;
}

export function localSummaryBudget(contextWindow: number, maxTokens: number, reserveTokens: number): number {
	const summaryCap = Math.min(Math.floor(0.8 * reserveTokens), maxTokens > 0 ? maxTokens : Number.POSITIVE_INFINITY);
	return Math.floor(0.6 * (contextWindow - summaryCap));
}

/** About four characters a token, like pi's own estimate. Images count as their encoded size. */
export function estimateInputTokens(messages: readonly HandoffMessage[], previousSummary: string | undefined): number {
	let chars = previousSummary?.length ?? 0;
	for (const message of messages) chars += JSON.stringify(message.content ?? "").length;
	return Math.ceil(chars / 4);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type?: string; text?: string }) => (block.type === "text" && block.text ? block.text : ""))
		.join("\n");
}

const NOTE_REQUESTS = 30;
const NOTE_REQUEST_CHARS = 400;

/** The local fallback when the cloud model cannot summarize: the user's requests, word for word. */
export function handoffNote(messages: readonly HandoffMessage[], source: string, reason: string): string {
	const requests = messages
		.filter((message) => message.role === "user")
		.map((message) => textOf(message.content).trim())
		.filter((text) => text !== "")
		.map((text) => (text.length > NOTE_REQUEST_CHARS ? `${text.slice(0, NOTE_REQUEST_CHARS)}…` : text));
	const shown = requests.slice(-NOTE_REQUESTS);
	const omitted = requests.length - shown.length;
	return [
		"## Handoff note",
		`This session switched to the local model. The ${messages.length} earlier messages ran on ${source} and were too long for the local model to summarize. They were not summarized by ${source} (${reason}), so only the user's requests are kept.`,
		"",
		"## Earlier user requests (oldest first)",
		...(omitted > 0 ? [`(${omitted} earlier requests omitted)`] : []),
		...shown.map((text, index) => `${index + 1}. ${text}`),
	].join("\n");
}

export interface FileOps {
	read: ReadonlySet<string>;
	written: ReadonlySet<string>;
	edited: ReadonlySet<string>;
}

/** Same lists and tags pi appends to its own summaries. */
export function fileLists(fileOps: FileOps): { readFiles: string[]; modifiedFiles: string[]; text: string } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).sort();
	const modifiedFiles = [...modified].sort();
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return { readFiles, modifiedFiles, text: sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}` };
}
