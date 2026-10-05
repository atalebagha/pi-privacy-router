/**
 * pi-privacy-router: registers `privacy-router/auto`, a virtual model that routes each request.
 *
 * - Each category (code, live, general) routes to the first usable model of its configured list;
 *   general messages stay put by default. Usage limits cool a provider down and fail over.
 * - Sensitive sessions lock sticky-local to Ollama, and egress tools are blocked.
 * - `route()` runs before every request, so it is the egress chokepoint: it scans the payload about
 *   to leave the machine, including tool results, before choosing a model.
 *
 * Decisions live in policy.ts and taint.ts (pure). This file gathers signals and applies results.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	generateSummary,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import {
	CATEGORIES,
	type Category,
	categoryPrompt,
	isAcknowledgement,
	type Labeled,
	MAX_PII_WINDOWS,
	PII_LABELS,
	parseLabel,
	piiPrompt,
	piiWindows,
} from "./classify.ts";
import { configPath, isLoopbackUrl, loadConfig, type RouterConfig, splitRef } from "./config.ts";
import {
	estimateInputTokens,
	fileLists,
	handoffNote,
	localSummaryBudget,
	planHandoff,
	rewindTarget,
} from "./handoff.ts";
import { askOneWord, type OllamaOptions, warmUp } from "./ollama.ts";
import {
	type Decision,
	decide,
	isQuotaError,
	needsClassification,
	planQuotaFailover,
	RouterError,
	type Signals,
} from "./policy.ts";
import { type Availability, fallbackChain, type StoredState, upgradeState } from "./routes.ts";
import {
	type BranchEntry,
	COMMAND_ENTRY,
	firstLockIndex,
	isLocked,
	ROUTER_MODEL_ID,
	ROUTER_PROVIDER,
	type RouterCommand,
	readCommands,
	readRouterState,
} from "./state.ts";
import {
	findSecret,
	findSensitiveToken,
	hasPrivateTag,
	isSensitivePath,
	type PathPolicy,
	toolPathHit,
} from "./taint.ts";

// Real path of the home directory, so a symlinked home still matches sensitive paths (paths are checked as real paths).
const HOME = safeRealpath(homedir());
const PATH_BLOCK_REASON = "Blocked: this path is private. Ask the user to run /local to work on it.";
const SEARCH_BLOCK_REASON =
	"Blocked: this search would reach private folders. Narrow the path to a project folder, or ask the user to run /local.";

type TextBlock = { type: string; text?: string };

function textOf(content: string | readonly TextBlock[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" && block.text ? block.text : "")).join("\n");
}

/**
 * User-authored text and tool output since the latest *successful cloud* assistant message: what a
 * cloud model has not yet seen. Replies from a local model do not anchor, so text written while one
 * was selected is scanned before the router sends it to a cloud model. Failed or aborted replies
 * (including a refused route) do not anchor either, so a message whose privacy check failed is
 * checked again on the next turn instead of riding along unchecked.
 */
export function deltaText(
	messages: readonly Message[],
	isCloud: (provider: string, model: string) => boolean,
): { user: string; tool: string } {
	const start =
		messages.findLastIndex(
			(message) =>
				message.role === "assistant" &&
				message.stopReason !== "error" &&
				message.stopReason !== "aborted" &&
				isCloud(message.provider, message.model),
		) + 1;
	const user: string[] = [];
	const tool: string[] = [];
	for (const message of messages.slice(start)) {
		if (message.role === "user") user.push(textOf(message.content));
		else if (message.role === "toolResult") tool.push(textOf(message.content));
	}
	return { user: user.join("\n"), tool: tool.join("\n") };
}

function safeRealpath(path: string): string {
	try {
		// .native canonicalizes letter case on case-insensitive filesystems (macOS), so ~/.SSH matches ~/.ssh/**.
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

function readBranch(ctx: ExtensionContext): readonly BranchEntry[] | undefined {
	try {
		return ctx.sessionManager.getBranch();
	} catch {
		return undefined;
	}
}

function readBranchAt(ctx: ExtensionContext, leafId: string): readonly BranchEntry[] | undefined {
	try {
		return ctx.sessionManager.getBranch(leafId);
	} catch {
		return undefined;
	}
}

function requireConfig(): RouterConfig {
	const loaded = loadConfig();
	if (!loaded.ok) throw new RouterError(`privacy-router.json invalid: ${loaded.error}`);
	return loaded.config;
}

function ollamaOptions(config: RouterConfig): OllamaOptions {
	return {
		baseUrl: config.ollama.baseUrl,
		model: config.ollama.classifierModel,
		timeoutMs: config.ollama.timeoutMs,
		keepAlive: config.ollama.keepAlive,
	};
}

function pathPolicy(config: RouterConfig, cwd: string): PathPolicy {
	return {
		cwd,
		home: HOME,
		sensitivePaths: config.sensitivePaths,
		extraSecretFilenames: config.extraSecretFilenames,
		realpath: safeRealpath,
	};
}

function usingRouter(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === ROUTER_PROVIDER && ctx.model.id === ROUTER_MODEL_ID;
}

type ModelRef = { provider: string; id: string };

/**
 * What a locked session may talk to: the router (which decides per request) or the configured
 * private model, when pi serves it from localhost (as privateModel() requires). Not "anything on
 * localhost": Ollama -cloud models and local gateways listen on loopback but run remotely. An
 * invalid config leaves only the router.
 */
function lockAllowsModel(model: ModelRef, ctx: ExtensionContext): boolean {
	if (model.provider === ROUTER_PROVIDER && model.id === ROUTER_MODEL_ID) return true;
	const loaded = loadConfig();
	if (!loaded.ok) return false;
	const { provider, id } = splitRef(loaded.config.private);
	if (model.provider !== provider || model.id !== id) return false;
	const found = ctx.modelRegistry.find(provider, id);
	return found !== undefined && isLoopbackUrl(found.baseUrl);
}

const refOf = (model: ModelRef) => `${model.provider}/${model.id}`;

const blockedNotice = (model: ModelRef) =>
	`🔒 This session is locked to local; requests to ${refOf(model)} will be blocked.`;

/** Where a locked session switches from a model it may not use: the router, else the private model if the lock allows it. */
function lockFallback(ctx: ExtensionContext) {
	const router = ctx.modelRegistry.find(ROUTER_PROVIDER, ROUTER_MODEL_ID);
	if (router) return router;
	const loaded = loadConfig();
	if (!loaded.ok) return undefined;
	const { provider, id } = splitRef(loaded.config.private);
	const local = ctx.modelRegistry.find(provider, id);
	return local && lockAllowsModel(local, ctx) ? local : undefined;
}

function registryModel(ref: string, ctx: ExtensionContext) {
	const { provider, id } = splitRef(ref);
	const model = ctx.modelRegistry.find(provider, id);
	if (!model) throw new RouterError(`Model ${ref} is not in pi's catalog.`);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new RouterError(`Model ${ref} has no credentials.`);
	return model;
}

function privateModel(config: RouterConfig, ctx: ExtensionContext) {
	const model = registryModel(config.private, ctx);
	if (!isLoopbackUrl(model.baseUrl)) {
		throw new RouterError(`Private model ${config.private} is not served from localhost (${model.baseUrl}).`);
	}
	return model;
}

/** Whether pi has the model and credentials for it. */
function availabilityIn(ctx: ExtensionContext): (ref: string) => Availability {
	return (ref) => {
		const { provider, id } = splitRef(ref);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) return "missing";
		return ctx.modelRegistry.hasConfiguredAuth(model) ? "ok" : "no-credentials";
	};
}

/** Configured route models that pi cannot use right now. */
function unusableModels(config: RouterConfig, ctx: ExtensionContext): string[] {
	const general = Array.isArray(config.routes.general) ? config.routes.general : [];
	const availability = availabilityIn(ctx);
	return [...new Set([...fallbackChain(config), ...general])].filter((ref) => availability(ref) !== "ok");
}

async function classifyCategory(config: RouterConfig, text: string, signal?: AbortSignal): Promise<Labeled<Category>> {
	const output = await askOneWord(ollamaOptions(config), categoryPrompt(text), signal);
	const parsed = parseLabel(output.content, output.logprob, CATEGORIES);
	if (!parsed) throw new Error(`unexpected category output ${JSON.stringify(output.content)}`);
	return parsed;
}

/** "too-long" past the window cap; otherwise the privacy classifier's verdict on every window. */
async function checkPii(config: RouterConfig, text: string, signal?: AbortSignal): Promise<"yes" | "no" | "too-long"> {
	const windows = piiWindows(text);
	if (windows.length > MAX_PII_WINDOWS) return "too-long";
	return classifyPii(config, windows, signal);
}

/** Reads every window in order and stops at the first "yes"; any error fails the whole check. */
async function classifyPii(
	config: RouterConfig,
	windows: readonly string[],
	signal?: AbortSignal,
): Promise<"yes" | "no"> {
	for (const window of windows) {
		const output = await askOneWord(ollamaOptions(config), piiPrompt(window), signal);
		const parsed = parseLabel(output.content, output.logprob, PII_LABELS);
		if (!parsed) throw new Error(`unexpected privacy output ${JSON.stringify(output.content)}`);
		if (parsed.label === "yes") return "yes";
	}
	return "no";
}

function footerText(decision: Decision): string | undefined {
	const { target, why } = decision;
	if (target.kind === "private") return `🔒 local · ${why.replace(/^lock(ed)?:/, "")}`;
	if (why.startsWith("pin:")) return `📌 ${why.slice(4)}`;
	if (why === "classifier down") return "⚠ classifier down";
	if (target.kind === "model") return `→ ${splitRef(target.ref).id} · ${why}`;
	return undefined;
}

export interface RouterDeps {
	/** pi's compaction summarizer; tests replace it. */
	summarize: typeof generateSummary;
}

const SUMMARY_RETRY = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

const defaultDeps: RouterDeps = {
	// Loaded on first use: pi aliases this package to its own copy, which has the providers registered.
	summarize: async (...args) => (await import("@earendil-works/pi-coding-agent")).generateSummary(...args),
};

function withoutDeletedHeaders(headers: Record<string, string | null> | undefined) {
	if (!headers) return undefined;
	return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

export default function router(pi: ExtensionAPI, deps: RouterDeps = defaultDeps): void {
	let toolsBeforeLock: string[] | undefined;
	let lastNotice: string | undefined;
	let lastDecision = "none";
	let classifierHealth = "not used yet";
	let defaultsNoticeShown = false;
	/** Each model skipped for missing credentials is announced once per session. */
	const skipNotices = new Set<string>();

	function restrictTools(config: RouterConfig): void {
		const active = pi.getActiveTools();
		const allowed = new Set(config.lockedToolAllowlist);
		// On resume or reload pi has already restored the locked transcript's loadout; snapshotting that
		// restricted set would later "restore" an unlocked branch to the allowlist.
		if (toolsBeforeLock === undefined && !active.every((name) => allowed.has(name))) toolsBeforeLock = active;
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools(config.lockedToolAllowlist.filter((name) => registered.has(name)));
	}

	function restoreTools(): void {
		if (!toolsBeforeLock) return;
		pi.setActiveTools(toolsBeforeLock);
		toolsBeforeLock = undefined;
	}

	function syncTools(ctx: ExtensionContext): void {
		const branch = readBranch(ctx);
		if (branch === undefined || isLocked(branch)) {
			const loaded = loadConfig();
			if (loaded.ok) restrictTools(loaded.config);
		} else {
			restoreTools();
		}
	}

	/** The branch is locked (or unreadable) and the selected model is one the lock does not allow. */
	function lockedOnForeignModel(ctx: ExtensionContext, branch: readonly BranchEntry[] | undefined): boolean {
		if (!ctx.model || lockAllowsModel(ctx.model, ctx)) return false;
		return branch === undefined || isLocked(branch);
	}

	/** Switches a locked session off a model it may not use, to the router (else an allowed private model). */
	async function enforceLockedModel(ctx: ExtensionContext): Promise<void> {
		if (!lockedOnForeignModel(ctx, readBranch(ctx)) || !ctx.model) return;
		const from = ctx.model;
		const target = lockFallback(ctx);
		const switched = target !== undefined && (await pi.setModel(target));
		if (!ctx.hasUI) return;
		if (switched) {
			ctx.ui.notify(`🔒 This session is locked to local; switched from ${refOf(from)} to ${refOf(target)}.`, "warning");
		} else {
			// The before_provider_request backstop keeps blocking requests to this model.
			ctx.ui.notify(blockedNotice(from), "error");
		}
	}

	function report(ctx: ExtensionContext, decision: Decision, signals: Signals, startedAt: number): void {
		const p = signals.category && signals.category !== "error" ? ` p=${signals.category.p.toFixed(2)}` : "";
		lastDecision = `${decision.why}${p} · ${Date.now() - startedAt} ms`;
		if (!ctx.hasUI) return;
		const footer = footerText(decision);
		if (footer) ctx.ui.setStatus("privacy-router", footer);
		if (decision.notice && decision.notice !== lastNotice) {
			ctx.ui.notify(decision.notice, decision.state?.locked ? "warning" : "info");
		}
		lastNotice = decision.notice;
		const chosen = decision.target.kind === "model" ? decision.target.ref : undefined;
		for (const skipped of decision.skipped ?? []) {
			if (chosen === undefined || skipped.reason === "cooling" || skipNotices.has(skipped.ref)) continue;
			skipNotices.add(skipped.ref);
			const reason = skipped.reason === "missing" ? "is not in pi's catalog" : "has no credentials";
			ctx.ui.notify(`${skipped.ref} ${reason}; using ${chosen} for ${decision.why}`, "warning");
		}
	}

	function targetModel(
		decision: Decision,
		request: ModelRouteRequest<StoredState>,
		ctx: ExtensionContext,
		config: RouterConfig,
	) {
		const { target } = decision;
		switch (target.kind) {
			case "previous":
				if (!request.previous) throw new RouterError("internal: no previous model to continue on");
				return request.previous.model;
			case "failed":
				if (!request.failed) throw new RouterError("internal: no failed model to retry");
				return request.failed.model;
			case "private":
				return privateModel(config, ctx);
			case "model":
				return registryModel(target.ref, ctx);
		}
	}

	function thinkingFor(decision: Decision, request: ModelRouteRequest<StoredState>) {
		if (decision.target.kind === "previous") return request.previous?.thinkingLevel ?? request.thinkingLevel;
		if (decision.target.kind === "failed") return request.failed?.thinkingLevel ?? request.thinkingLevel;
		return request.thinkingLevel;
	}

	pi.registerVirtualModel<StoredState>({
		provider: ROUTER_PROVIDER,
		id: ROUTER_MODEL_ID,
		name: "Auto (router)",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
		// After the first response pi uses the limits of the model that answered; these count only
		// before then and after a refused route, which leaves the router on the last assistant message.
		// Unset, they are 0, and every refusal would trigger a threshold compaction (a cloud summary
		// call). A real overflow on a smaller model still compacts through pi's overflow recovery.
		contextWindow: 200_000,
		maxTokens: 32_000,
		async route(request, ctx) {
			const startedAt = Date.now();
			const config = requireConfig();
			const branch = readBranch(ctx);
			const commands = branch ? readCommands(branch) : { lockRequested: false, pin: undefined, cooldowns: {} };
			const state = upgradeState(
				request.state ?? (branch ? readRouterState(branch) : undefined),
				commands.cooldowns,
				config,
			);
			const delta = deltaText(request.messages, (provider, id) => {
				if (provider === ROUTER_PROVIDER) return false;
				const model = ctx.modelRegistry.find(provider, id);
				return model !== undefined && !isLoopbackUrl(model.baseUrl);
			});
			const policy = pathPolicy(config, ctx.cwd);
			const secretInUser = findSecret(delta.user);
			const secretInTool = secretInUser ? undefined : findSecret(delta.tool);
			// A pin whose name left the config is ignored.
			const pin =
				commands.pin !== undefined && Object.hasOwn(config.pins, commands.pin) ? config.pins[commands.pin] : undefined;

			const signals: Signals = {
				// pi retries a routing refusal it considers transient as "retry" with no failed model. The
				// refused turn must get every check again, so it counts as a new user turn.
				reason: request.reason === "retry" && request.failed === undefined ? "user" : request.reason,
				branchReadable: branch !== undefined,
				lockRequested: commands.lockRequested,
				cwdSensitive: isSensitivePath(safeRealpath(ctx.cwd), config.sensitivePaths, HOME),
				privateTag: hasPrivateTag(delta.user),
				pathMention: findSensitiveToken(delta.user, policy, false),
				secret: secretInUser
					? `${secretInUser.pattern} in message`
					: secretInTool
						? `${secretInTool.pattern} in tool result`
						: undefined,
				pinName: pin ? commands.pin : undefined,
				pin,
				previous: request.previous ? `${request.previous.model.provider}/${request.previous.model.id}` : undefined,
				failed: request.failed ? `${request.failed.model.provider}/${request.failed.model.id}` : undefined,
				failedIsQuota: request.failed ? isQuotaError(request.failed.message.errorMessage ?? "") : false,
				availability: availabilityIn(ctx),
				now: startedAt,
			};

			if (needsClassification(state, signals)) {
				if (delta.user.trim() === "") {
					// Image-only or empty message: nothing for the classifiers to read (images are not scanned).
					signals.pii = "no";
					signals.category = { label: "general", p: 1 };
				} else {
					const [pii, category] = await Promise.allSettled([
						checkPii(config, delta.user, request.signal),
						// A bare "ok, continue" carries no new task: keep the current model (the privacy check still runs).
						isAcknowledgement(delta.user)
							? Promise.resolve<Labeled<Category>>({ label: "general", p: 1 })
							: classifyCategory(config, delta.user, request.signal),
					]);
					signals.pii = pii.status === "fulfilled" ? pii.value : "error";
					signals.piiLength = delta.user.length;
					signals.category = category.status === "fulfilled" ? category.value : "error";
					const failure = [pii, category].find((result) => result.status === "rejected");
					classifierHealth = failure
						? `down: ${String((failure as PromiseRejectedResult).reason)}`
						: `ok · ${Date.now() - startedAt} ms`;
				}
			} else if (
				signals.reason !== "user" &&
				needsClassification(state, { ...signals, reason: "user" }) &&
				delta.user.trim() !== ""
			) {
				// Every other request gets the privacy check (no category) on new user-side text: a retry can
				// carry steering queued during the failed request, a summary text a refused turn left behind,
				// and a continuation text an extension added when it started the turn. A tool loop has none.
				// A summary that locks here comes after session_before_compact, so the late-lock handoff does
				// not run: the local model summarizes everything, and a long session can overflow it until
				// pi compacts again.
				signals.piiLength = delta.user.length;
				try {
					signals.pii = await checkPii(config, delta.user, request.signal);
					classifierHealth = `ok · ${Date.now() - startedAt} ms`;
				} catch (error) {
					signals.pii = "error";
					classifierHealth = `down: ${String(error)}`;
				}
			}

			const decision = decide(state, signals, config);
			report(ctx, decision, signals, startedAt);
			if (decision.state?.locked && !state?.locked) {
				// Persist the lock before resolving the local model: if that throws, pi never stores the
				// returned state, and the triggering content would reach a cloud model on the next turn.
				pi.appendEntry<RouterCommand>(COMMAND_ENTRY, { kind: "lock" });
				restrictTools(config);
			}
			return {
				model: targetModel(decision, request, ctx, config),
				thinkingLevel: thinkingFor(decision, request),
				state: decision.state,
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		syncTools(ctx);
		// pi emits no model_select on restore, so a reopened locked session may already sit on a cloud model.
		await enforceLockedModel(ctx);
		if (!usingRouter(ctx)) return;
		const loaded = loadConfig();
		if (!loaded.ok) {
			if (ctx.hasUI) ctx.ui.notify(`privacy-router: ${loaded.error}`, "error");
			return;
		}
		const config = loaded.config;
		if (loaded.source === "defaults" && !defaultsNoticeShown && ctx.hasUI) {
			ctx.ui.notify(`privacy-router: ${configPath()} not found; using built-in defaults`, "info");
			defaultsNoticeShown = true;
		}
		const unusable = unusableModels(config, ctx);
		if (unusable.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`privacy-router: ${unusable.join(", ")} unavailable (not in pi or no credentials); routing skips them`,
				"warning",
			);
		}
		// A locked session never classifies, and loading the classifier would evict the local worker.
		const branch = readBranch(ctx);
		if (branch === undefined || isLocked(branch)) return;
		warmUp(ollamaOptions(config)).catch(() => {
			classifierHealth = "warm-up failed: Ollama not reachable";
		});
	});

	pi.on("session_tree", async (event, ctx) => {
		// /tree can attach a summary of the branch being left to the destination. A summary of a
		// locked branch is private content, so the lock follows it.
		if (event.summaryEntry && event.oldLeafId) {
			const left = readBranchAt(ctx, event.oldLeafId);
			const current = readBranch(ctx);
			if ((left === undefined || isLocked(left)) && current !== undefined && !isLocked(current)) {
				pi.appendEntry<RouterCommand>(COMMAND_ENTRY, { kind: "lock" });
				if (ctx.hasUI)
					ctx.ui.notify("🔒 This branch carries a summary of a private branch; locked to local.", "warning");
			}
		}
		syncTools(ctx);
		await enforceLockedModel(ctx);
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		// Backstop at the provider boundary for agent turns and cache-warming requests. Compaction and
		// /tree summaries do not pass through this hook in pi; session_before_compact and
		// session_before_tree cover them. pi swallows errors thrown in this hook (extensions/runner.js
		// emitBeforeProviderRequest catches them), and the return value replaces the request body, so
		// emptying the body is the only way to stop the content. With the router selected, ctx.model is
		// the router and route() decides, so this stays out of the way.
		if (!lockedOnForeignModel(ctx, readBranch(ctx)) || !ctx.model) return undefined;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`🔒 Blocked a request from a locked session to ${refOf(ctx.model)}; no session content was sent. Select privacy-router/auto.`,
				"warning",
			);
		}
		return {};
	});

	pi.on("session_before_tree", async (event, ctx) => {
		if (!event.preparation.userWantsSummary || !ctx.model) return undefined;
		const { oldLeafId } = event.preparation;
		const left = oldLeafId === null ? undefined : readBranchAt(ctx, oldLeafId);
		if (!lockedOnForeignModel(ctx, left)) return undefined;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`A summary of a private branch would go to ${refOf(ctx.model)}; navigate without a summary or select privacy-router/auto.`,
				"warning",
			);
		}
		return { cancel: true };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (isLocked(event.branchEntries) && ctx.model && !lockAllowsModel(ctx.model, ctx)) {
			// pi would send the summary request to the selected model.
			if (ctx.hasUI) {
				ctx.ui.notify(
					`🔒 Compaction cancelled: this session is locked to local and ${refOf(ctx.model)} is selected. Select privacy-router/auto.`,
					"warning",
				);
			}
			return { cancel: true };
		}
		// A session that locks late can carry more cloud history than the local model
		// can summarize. The cloud model that already received that history summarizes it instead.
		if (!isLocked(event.branchEntries)) return undefined;
		const loaded = loadConfig();
		if (!loaded.ok) return undefined;
		const localRef = splitRef(loaded.config.private);
		const local = ctx.modelRegistry.find(localRef.provider, localRef.id);
		if (!local) return undefined;
		const { preparation } = event;
		const toSummarize = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		const plan = planHandoff({
			branch: event.branchEntries as never,
			toSummarize,
			firstKeptEntryId: preparation.firstKeptEntryId,
			previousSummary: preparation.previousSummary,
			inputTokens: estimateInputTokens(toSummarize, preparation.previousSummary),
			localBudget: localSummaryBudget(local.contextWindow, local.maxTokens, preparation.settings.reserveTokens),
			isCloud: (provider, id) => {
				const model = ctx.modelRegistry.find(provider, id);
				return model === undefined || !isLoopbackUrl(model.baseUrl);
			},
		});
		if (!plan) return undefined;

		const source = `${plan.provider}/${plan.model}`;
		const files = fileLists(preparation.fileOps);
		const compaction = (summary: string) => ({
			compaction: {
				summary: summary + files.text,
				firstKeptEntryId: plan.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
			},
		});
		if (plan.rewritten) {
			const reason = `history was edited after ${source} replied`;
			if (ctx.hasUI) ctx.ui.notify(`⚠ Earlier ${reason}; kept your earlier requests as a local note.`, "warning");
			return compaction(handoffNote(plan.messages, source, reason));
		}
		if (ctx.hasUI) {
			ctx.ui.notify(`🔒 Handing off earlier history: ${source} summarizes only what it already received.`, "info");
		}
		try {
			const model = ctx.modelRegistry.find(plan.provider, plan.model);
			if (!model || isLoopbackUrl(model.baseUrl)) throw new Error(`${source} is not in pi's catalog`);
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
			// Only the plan's messages and the cloud-era summary leave; /compact instructions typed after
			// the lock are private, so they are not passed.
			const summary = await deps.summarize(
				plan.messages,
				auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
				preparation.settings.reserveTokens,
				auth.apiKey,
				withoutDeletedHeaders(auth.headers),
				event.signal,
				undefined,
				plan.previousSummary,
				undefined,
				undefined,
				auth.env,
				// pi's default retry settings: one overloaded response must not cost the history.
				SUMMARY_RETRY,
			);
			return compaction(summary);
		} catch (error) {
			// pi rethrows the abort itself.
			if (event.signal.aborted) return undefined;
			const reason = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) {
				ctx.ui.notify(`⚠ ${source} could not summarize (${reason}); kept your earlier requests as a note.`, "warning");
			}
			return compaction(handoffNote(plan.messages, source, reason));
		}
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		// pi does not retry a usage limit it classifies as permanent (Anthropic's 400 "out of extra
		// usage"), so the turn would just end. Cool the provider down and retry the turn on the next usable model.
		if (event.outcome !== "error" || !usingRouter(ctx)) return undefined;
		const branch = readBranch(ctx);
		if (branch === undefined || isLocked(branch)) return undefined;
		const failed = (branch as readonly { type: string; id: string; message?: Message }[]).findLast(
			(entry) => entry.type === "message",
		);
		const message = failed?.message;
		if (!failed || message?.role !== "assistant" || message.stopReason !== "error") return undefined;
		// A routing refusal comes from the router itself, not from a provider's usage limit.
		if (message.provider === ROUTER_PROVIDER) return undefined;
		const failedModel = ctx.modelRegistry.find(message.provider, message.model);
		if (failedModel && isLoopbackUrl(failedModel.baseUrl)) return undefined;
		const loaded = loadConfig();
		if (!loaded.ok) return undefined;
		const config = loaded.config;
		const failover = planQuotaFailover(
			{
				state: upgradeState(readRouterState(branch), readCommands(branch).cooldowns, config),
				failed: `${message.provider}/${message.model}`,
				message: message.errorMessage ?? "",
				availability: availabilityIn(ctx),
				now: Date.now(),
			},
			config,
		);
		if (!failover) return undefined;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`${failover.provider} usage limit reached; retrying on ${failover.to} for ${config.quotaCooldownMinutes} min`,
				"warning",
			);
		}
		const cooldown: RouterCommand = { kind: "cooldown", provider: failover.provider, until: failover.until };
		return {
			entries: [
				{ type: "custom", customType: COMMAND_ENTRY, data: cooldown },
				// As in pi's own retries, the failed attempt leaves the model's context.
				{ type: "context_edit", targetId: failed.id, replacement: null },
			],
			continue: true,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const branch = readBranch(ctx);
		const locked = branch === undefined || isLocked(branch);
		if (!locked && !usingRouter(ctx)) return undefined;
		const loaded = loadConfig();
		if (!loaded.ok) {
			return {
				block: true,
				reason: `Router config invalid (${loaded.error}); tools are blocked until privacy-router.json is fixed.`,
			};
		}
		const config = loaded.config;
		if (locked) {
			if (config.lockedToolAllowlist.includes(event.toolName)) return undefined;
			return { block: true, reason: `Blocked: ${event.toolName} is not available in a private (local-only) session.` };
		}
		const hit = toolPathHit(event.toolName, event.input as Record<string, unknown>, pathPolicy(config, ctx.cwd));
		if (hit === undefined) return undefined;
		const search = hit.kind === "search-root";
		if (ctx.hasUI) {
			const what = search ? "search from" : "private path";
			ctx.ui.notify(`privacy-router: blocked ${event.toolName} on ${what} ${hit.token}`, "warning");
		}
		return { block: true, reason: search ? SEARCH_BLOCK_REASON : PATH_BLOCK_REASON };
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore" || event.model.provider === ROUTER_PROVIDER) return;
		const branch = readBranch(ctx);
		if (branch !== undefined && !isLocked(branch)) return;
		// Only the router and the configured private model: other loopback endpoints may be gateways to the cloud.
		if (lockAllowsModel(event.model, ctx)) return;
		const fallback = lockFallback(ctx);
		// pi has already switched the model; a running turn's next request would reach it before the revert.
		if (!ctx.isIdle()) ctx.abort();
		const switched = fallback !== undefined && (await pi.setModel(fallback));
		if (!ctx.hasUI) return;
		if (switched) {
			ctx.ui.notify("Session is locked to local. Start a new session for cloud models.", "warning");
		} else {
			// The before_provider_request backstop keeps blocking requests to this model.
			ctx.ui.notify(blockedNotice(event.model), "error");
		}
	});

	pi.on("cache_warming_decision", async (_event, ctx) => {
		const branch = readBranch(ctx);
		return branch === undefined || isLocked(branch) ? { action: "stop" } : undefined;
	});

	pi.registerCommand("local", {
		description: "Lock this session to the local model (cannot be undone in this session)",
		handler: async (_args, ctx) => {
			const branch = readBranch(ctx);
			if (branch !== undefined && isLocked(branch)) {
				ctx.ui.notify("Session is already locked to local.", "info");
				return;
			}
			pi.appendEntry<RouterCommand>(COMMAND_ENTRY, { kind: "lock" });
			const loaded = loadConfig();
			if (loaded.ok) restrictTools(loaded.config);
			ctx.ui.setStatus("privacy-router", "🔒 local · command");
			ctx.ui.notify("🔒 Session locked to local. Start a new session to use cloud models again.", "warning");
			await enforceLockedModel(ctx);
		},
	});

	pi.registerCommand("leave-local", {
		description: "Go back to the last cloud reply before this session locked; the private part stays on its own branch",
		handler: async (_args, ctx) => {
			const branch = readBranch(ctx);
			if (branch === undefined || !isLocked(branch)) {
				ctx.ui.notify("Session is not locked.", "info");
				return;
			}
			const loaded = loadConfig();
			if (!loaded.ok) {
				ctx.ui.notify(`privacy-router: ${loaded.error}`, "error");
				return;
			}
			if (isSensitivePath(safeRealpath(ctx.cwd), loaded.config.sensitivePaths, HOME)) {
				ctx.ui.notify(
					"pi is running in a private folder, so any branch here locks again. Start pi elsewhere.",
					"warning",
				);
				return;
			}
			const target = rewindTarget(branch as never, firstLockIndex(branch), (provider, id) => {
				const model = ctx.modelRegistry.find(provider, id);
				return model === undefined || !isLoopbackUrl(model.baseUrl);
			});
			if (!target) {
				ctx.ui.notify(
					"This session locked before any cloud reply. Start a new session (/new) for cloud models.",
					"warning",
				);
				return;
			}
			await ctx.waitForIdle();
			// Never summarize: a summary of the locked branch is private and would lock the destination.
			const result = await ctx.navigateTree(target.id, { summarize: false });
			if (result.cancelled) return;
			// pi keeps the new position in memory only; an entry there makes a reopened session resume on it.
			pi.appendEntry<RouterCommand>(COMMAND_ENTRY, { kind: "leave-local" });
			ctx.ui.setStatus("privacy-router", "→ auto");
			ctx.ui.notify(
				"↩ Back before the lock; cloud routing resumes on your next message. The private part stays on its own branch (/tree), and going back to it locks again.",
				"info",
			);
		},
	});

	pi.registerCommand("route", {
		description: "Pin a model by name from pins (/route <name>) or resume automatic routing (/route auto)",
		getArgumentCompletions: (prefix) => {
			const loaded = loadConfig();
			const names = loaded.ok ? [...Object.keys(loaded.config.pins), "auto"] : ["auto"];
			return names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
		},
		handler: async (args, ctx) => {
			const branch = readBranch(ctx);
			if (branch === undefined || isLocked(branch)) {
				ctx.ui.notify("Session is locked to local; /route is unavailable.", "warning");
				return;
			}
			const loaded = loadConfig();
			if (!loaded.ok) {
				ctx.ui.notify(`privacy-router: ${loaded.error}`, "error");
				return;
			}
			const name = args.trim();
			if (name === "auto") {
				pi.appendEntry<RouterCommand>(COMMAND_ENTRY, { kind: "unpin" });
				ctx.ui.setStatus("privacy-router", "→ auto");
				ctx.ui.notify("Routing is automatic again.", "info");
				return;
			}
			if (!Object.hasOwn(loaded.config.pins, name)) {
				const names = [...Object.keys(loaded.config.pins), "auto"].join(", ");
				ctx.ui.notify(`Usage: /route <${names}>`, "warning");
				return;
			}
			pi.appendEntry<RouterCommand>(COMMAND_ENTRY, { kind: "pin", target: name });
			ctx.ui.setStatus("privacy-router", `📌 ${name}`);
			ctx.ui.notify(`Pinned to ${name} from the next message. /route auto to undo.`, "info");
		},
	});

	pi.registerCommand("privacy", {
		description: "Show router status",
		handler: async (_args, ctx) => {
			const branch = readBranch(ctx) ?? [];
			const commands = readCommands(branch);
			const loaded = loadConfig();
			const state = loaded.ok ? upgradeState(readRouterState(branch), commands.cooldowns, loaded.config) : undefined;
			// The lock shows even when the config is invalid; the reason comes from the stored state.
			const stored = readRouterState(branch);
			let lock = "";
			if (isLocked(branch)) {
				lock = stored?.locked ? ` · 🔒 locked (${stored.lockReason}: ${stored.lockDetail})` : " · 🔒 locked";
			}
			const now = Date.now();
			const cooling = Object.entries(state?.cooldowns ?? {})
				.filter(([, until]) => Date.parse(until) > now)
				.map(([provider, until]) => `${provider} until ${new Date(until).toLocaleTimeString()}`);
			ctx.ui.notify(
				[
					`selected: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
					`model: ${state?.model ?? "(none yet)"} · route: ${state?.route ?? "-"}${lock}`,
					`pin: ${commands.pin ?? "none"}`,
					`cooldowns: ${cooling.length > 0 ? cooling.join(", ") : "none"}`,
					`config: ${loaded.ok ? `${loaded.source} (${configPath()})` : `INVALID: ${loaded.error}`}`,
					`classifier: ${classifierHealth}`,
					`last decision: ${lastDecision}`,
				].join("\n"),
				"info",
			);
		},
	});
}
