import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { MAX_CLASSIFY_CHARS, MAX_PII_WINDOWS } from "../src/classify.ts";
import router, { deltaText, type RouterDeps } from "../src/index.ts";
import { RouterError } from "../src/policy.ts";
import { COMMAND_ENTRY, VIRTUAL_MODEL_STATE_ENTRY } from "../src/state.ts";

// Every test runs against built-in defaults, never the user's real privacy-router.json.
process.env.PI_PRIVACY_ROUTER_CONFIG = join(mkdtempSync(join(tmpdir(), "pi-router-index-")), "absent.json");

type Model = { provider: string; id: string; baseUrl: string; api: string; contextWindow?: number; maxTokens?: number };
type Handler = (event: unknown, ctx: unknown) => unknown;

const models: Model[] = [
	{ provider: "anthropic", id: "claude-sonnet-5", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
	{ provider: "anthropic", id: "claude-opus-5", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
	{
		provider: "openai-codex",
		id: "gpt-6-sol",
		baseUrl: "https://chatgpt.com/backend-api",
		api: "openai-codex-responses",
	},
	{
		provider: "google",
		id: "gemini-3-pro",
		baseUrl: "https://generativelanguage.googleapis.com",
		api: "google-generative-ai",
	},
	{
		provider: "openrouter",
		id: "anthropic/claude-x",
		baseUrl: "https://openrouter.ai/api/v1",
		api: "openai-completions",
	},
	{
		provider: "ollama",
		id: "qwen3.6:35b-pi",
		baseUrl: "http://localhost:11434/v1",
		api: "openai-completions",
		contextWindow: 65_536,
		maxTokens: 16_384,
	},
	{ provider: "ollama", id: "llama3", baseUrl: "http://localhost:11434/v1", api: "openai-completions" },
	{ provider: "privacy-router", id: "auto", baseUrl: "", api: "pi-virtual" },
];
const find = (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id);

type Entry = { type: string; customType?: string; data?: unknown };

function harness(catalog: Model[] = models, deps?: RouterDeps, auth: (model: Model) => boolean = () => true) {
	const lookup = (provider: string, id: string) => catalog.find((m) => m.provider === provider && m.id === id);
	let branchAt: ((fromId: string) => Entry[]) | undefined;
	let idle = true;
	let status: string | undefined;
	let cwd = join(homedir(), "Coding", "app");
	const navigations: { id: string; options: unknown }[] = [];
	let aborts = 0;
	let modelSets = 0;
	let setModelResult = true;
	let branchBroken = false;
	let branchAtBroken = false;
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const entries: Entry[] = [];
	const notices: string[] = [];
	let virtualModel:
		| {
				contextWindow?: number;
				maxTokens?: number;
				route: (request: unknown, ctx: unknown) => Promise<{ model: Model; state?: unknown }>;
		  }
		| undefined;
	let activeTools = ["read", "bash", "edit", "web_search", "askClaude"];
	let selected: Model | undefined = find("privacy-router", "auto");

	const pi = {
		registerVirtualModel: (definition: typeof virtualModel) => {
			virtualModel = definition;
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, options);
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getActiveTools: () => activeTools,
		getAllTools: () => ["read", "bash", "edit", "web_search", "askClaude"].map((name) => ({ name })),
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
		setModel: async (model: Model) => {
			if (setModelResult) selected = model;
			modelSets++;
			return setModelResult;
		},
	};
	router(pi as never, deps);

	const ctx = () => ({
		cwd,
		hasUI: true,
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, text: string) => {
				status = text;
			},
		},
		sessionManager: {
			getBranch: (fromId?: string) => {
				if (fromId ? branchAtBroken : branchBroken) throw new Error("unreadable branch");
				return fromId && branchAt ? branchAt(fromId) : entries;
			},
		},
		modelRegistry: {
			find: lookup,
			hasConfiguredAuth: (model: Model) => auth(model),
			getApiKeyAndHeaders: async (model: Model) => ({ ok: true, apiKey: `key-${model.provider}` }),
		},
		model: selected,
		isIdle: () => idle,
		waitForIdle: async () => {},
		navigateTree: async (id: string, options: unknown) => {
			navigations.push({ id, options });
			return { cancelled: false };
		},
		abort: () => {
			aborts++;
		},
	});

	async function route(request: Record<string, unknown>) {
		assert.ok(virtualModel);
		const result = await virtualModel.route({ thinkingLevel: "medium", ...request }, ctx());
		// Emulate pi: persist returned state on the branch.
		if (result.state !== undefined) {
			entries.push({
				type: "custom",
				customType: VIRTUAL_MODEL_STATE_ENTRY,
				data: { provider: "privacy-router", modelId: "auto", state: result.state },
			});
		}
		return result;
	}

	return {
		route,
		virtualModel: () => virtualModel,
		entries,
		notices,
		status: () => status,
		tools: () => activeTools,
		selected: () => selected,
		/** Selects a model the way pi does on startup or resume: no model_select event. */
		setModelResult: (value: boolean) => {
			setModelResult = value;
		},
		breakBranch: (value: boolean) => {
			branchBroken = value;
		},
		breakBranchAt: (value: boolean) => {
			branchAtBroken = value;
		},
		select: (model: Model | undefined) => {
			selected = model;
		},
		aborts: () => aborts,
		modelSets: () => modelSets,
		navigations,
		setCwd: (path: string) => {
			cwd = path;
		},
		setIdle: (value: boolean) => {
			idle = value;
		},
		setBranchAt: (fn: (fromId: string) => Entry[]) => {
			branchAt = fn;
		},
		setTools: (names: string[]) => {
			activeTools = names;
		},
		replaceBranch: (next: Entry[]) => {
			entries.splice(0, entries.length, ...next);
		},
		hasLockCommand: () =>
			entries.some((e) => e.customType === COMMAND_ENTRY && (e.data as { kind?: string })?.kind === "lock"),
		emit: (event: string, payload: unknown) => handlers.get(event)?.(payload, ctx()),
		command: (name: string, args = "") => commands.get(name)?.handler(args, ctx()),
		commandNames: () => [...commands.keys()],
	};
}

let ollama: {
	category: string;
	pii: string;
	/** When set, a privacy prompt is answered "yes" only if its text contains this marker, else "no". */
	piiMarker?: string;
	down: boolean;
	calls: string[];
	piiCalls: number;
};
const realFetch = globalThis.fetch;

beforeEach(() => {
	ollama = { category: "general", pii: "no", piiMarker: undefined, down: false, calls: [], piiCalls: 0 };
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		ollama.calls.push(url);
		if (ollama.down) throw new TypeError("fetch failed");
		const body = JSON.parse(String(init.body));
		const isPii = String(body.messages?.[0]?.content ?? "").startsWith("You are a privacy filter");
		if (isPii) ollama.piiCalls++;
		const markerHit = String(body.messages?.[1]?.content ?? "").includes(ollama.piiMarker ?? "");
		const pii = ollama.piiMarker === undefined ? ollama.pii : markerHit ? "yes" : "no";
		const content = isPii ? pii : ollama.category;
		return new Response(JSON.stringify({ message: { content }, logprobs: [{ token: content, logprob: 0 }] }));
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const assistant = { role: "assistant", content: [], provider: "anthropic", model: "claude-sonnet-5" };
const toolResult = (text: string) => ({
	role: "toolResult",
	toolCallId: "t1",
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});

test("a coding request routes to the claude lane", async () => {
	const h = harness();
	ollama.category = "code";
	const result = await h.route({ reason: "user", messages: [user("write a python script")] });
	assert.equal(result.model.id, "claude-sonnet-5");
	assert.deepEqual(result.state, { model: "anthropic/claude-sonnet-5", route: "code", locked: false });
});

test("a live-data request routes to the gpt lane", async () => {
	const h = harness();
	ollama.category = "live";
	const result = await h.route({ reason: "user", messages: [user("weather in Chicago now?")] });
	assert.equal(result.model.id, "gpt-6-sol");
});

test("a secret in a tool result locks the next request to local and restricts tools", async () => {
	const h = harness();
	const previous = { model: find("anthropic", "claude-sonnet-5") };
	const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
	const result = await h.route({
		reason: "continuation",
		previous,
		messages: [user("read config.yml"), assistant, toolResult(`github: ${token}`)],
	});
	assert.equal(result.model.provider, "ollama");
	assert.equal((result.state as { locked: boolean }).locked, true);
	assert.deepEqual(h.tools(), ["read", "edit", "bash"]);
	const next = await h.route({ reason: "user", previous, messages: [user("now explain it")] });
	assert.equal(next.model.provider, "ollama");
});

test("PII in a message locks the session", async () => {
	const h = harness();
	ollama.pii = "yes";
	const result = await h.route({ reason: "user", messages: [user("my salary is 185k, should I max my 401k?")] });
	assert.equal(result.model.provider, "ollama");
});

test("Ollama down blocks the request instead of routing to the cloud", async () => {
	const h = harness();
	ollama.down = true;
	await assert.rejects(h.route({ reason: "user", messages: [user("hello")] }), RouterError);
});

test("cloud lane: the tool guard blocks private paths", async () => {
	const h = harness();
	const blocked = await h.emit("tool_call", { type: "tool_call", toolName: "read", input: { path: "~/.ssh/config" } });
	assert.deepEqual(blocked, {
		block: true,
		reason: "Blocked: this path is private. Ask the user to run /local to work on it.",
	});
	assert.equal(
		await h.emit("tool_call", { type: "tool_call", toolName: "read", input: { path: "src/app.ts" } }),
		undefined,
	);
});

test("locked session: only allowlisted tools run", async () => {
	const h = harness();
	await h.command("local");
	assert.equal(h.entries.at(-1)?.customType, COMMAND_ENTRY);
	const web = (await h.emit("tool_call", { type: "tool_call", toolName: "web_search", input: {} })) as {
		block: boolean;
	};
	assert.equal(web.block, true);
	assert.equal(
		await h.emit("tool_call", { type: "tool_call", toolName: "read", input: { path: "~/.ssh/config" } }),
		undefined,
	);
});

test("locked session: selecting a cloud model is reverted", async () => {
	const h = harness();
	await h.command("local");
	await h.emit("model_select", { type: "model_select", model: find("anthropic", "claude-sonnet-5"), source: "set" });
	assert.equal(h.selected()?.provider, "privacy-router");
	assert.match(h.notices.at(-1) ?? "", /locked to local/);
});

test("locked session: cache warming stops", async () => {
	const h = harness();
	assert.equal(await h.emit("cache_warming_decision", { type: "cache_warming_decision" }), undefined);
	await h.command("local");
	assert.deepEqual(await h.emit("cache_warming_decision", { type: "cache_warming_decision" }), { action: "stop" });
});

test("/route pins a target and /route auto releases it", async () => {
	const h = harness();
	ollama.category = "live";
	await h.command("route", "claude-max");
	const pinned = await h.route({ reason: "user", messages: [user("weather in Chicago now?")] });
	assert.equal(pinned.model.id, "claude-opus-5");
	await h.command("route", "auto");
	const released = await h.route({ reason: "user", messages: [user("weather in Chicago now?")] });
	assert.equal(released.model.id, "gpt-6-sol");
});

test("/route constructor shows the usage notice and appends no pin", async () => {
	const h = harness();
	await h.command("route", "constructor");
	assert.ok(h.notices.some((n) => n.startsWith("Usage: /route <")));
	assert.equal(h.entries.length, 0);
});

test("a pin command naming constructor routes normally", async () => {
	const h = harness();
	ollama.category = "live";
	h.replaceBranch([{ type: "custom", customType: COMMAND_ENTRY, data: { kind: "pin", target: "constructor" } }]);
	const result = await h.route({ reason: "user", messages: [user("weather in Chicago now?")] });
	assert.equal(result.model.id, "gpt-6-sol");
});

test("an image-only message routes without calling the classifier", async () => {
	const h = harness();
	ollama.down = true; // any classifier call would throw and block the request
	const image = { role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: 0 };
	const result = await h.route({ reason: "user", messages: [image] });
	assert.equal(result.model.id, "claude-sonnet-5");
});

test("a broken router.json fails closed and recovers once fixed", async () => {
	const h = harness();
	const path = join(mkdtempSync(join(tmpdir(), "pi-router-broken-")), "router.json");
	writeFileSync(path, "{ broken");
	const previous = process.env.PI_PRIVACY_ROUTER_CONFIG;
	process.env.PI_PRIVACY_ROUTER_CONFIG = path;
	try {
		await assert.rejects(h.route({ reason: "user", messages: [user("hi")] }), /router\.json invalid/);
		const blocked = (await h.emit("tool_call", {
			type: "tool_call",
			toolName: "read",
			input: { path: "src/a.ts" },
		})) as {
			block: boolean;
		};
		assert.equal(blocked.block, true);
		writeFileSync(path, "{}");
		const fixed = await h.route({ reason: "user", messages: [user("hi")] });
		assert.equal(fixed.model.id, "claude-sonnet-5");
	} finally {
		process.env.PI_PRIVACY_ROUTER_CONFIG = previous;
	}
});

test("compaction in a locked session goes local even when the last reply came from a cloud model", async () => {
	const h = harness();
	await h.route({ reason: "user", messages: [user("#private dentist on Tuesday")] });
	// Direct requests (compaction summaries) carry no router state; the lock must come from the branch.
	const previous = { model: find("anthropic", "claude-sonnet-5") };
	const result = await h.route({
		reason: "direct",
		previous,
		messages: [user("#private dentist on Tuesday"), assistant, user("Summarize the conversation so far.")],
	});
	assert.equal(result.model.provider, "ollama");
});

test("review C1: a message whose privacy check failed is re-checked on the next turn", async () => {
	const h = harness();
	ollama.down = true;
	const first = user("my salary is 185k and dad's chemo is Monday");
	await assert.rejects(h.route({ reason: "user", messages: [first] }), RouterError);
	// Ollama is back; the PII classifier says yes only when it sees the first message.
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		const isPii = String(body.messages?.[0]?.content ?? "").startsWith("You are a privacy filter");
		const sawFirst = String(body.messages?.[1]?.content ?? "").includes("salary");
		const content = isPii ? (sawFirst ? "yes" : "no") : "general";
		return new Response(JSON.stringify({ message: { content }, logprobs: [{ token: content, logprob: 0 }] }));
	}) as typeof fetch;
	const failed = { role: "assistant", content: [], provider: "privacy-router", model: "auto", stopReason: "error" };
	const retry = await h.route({ reason: "user", messages: [first, failed, user("ok, try again")] });
	assert.equal(retry.model.provider, "ollama");
});

test("review C1: a lock is persisted even when the local model then fails to resolve", async () => {
	const h = harness(models.filter((m) => m.provider !== "ollama"));
	await assert.rejects(h.route({ reason: "user", messages: [user("#private my notes")] }), RouterError);
	assert.equal(h.hasLockCommand(), true);
});

test("review I1: a /tree summary made from a locked branch locks the destination branch", async () => {
	const h = harness();
	const lockedBranch: Entry[] = [{ type: "custom", customType: COMMAND_ENTRY, data: { kind: "lock" } }];
	h.setBranchAt((fromId) => (fromId === "old-leaf" ? lockedBranch : h.entries));
	await h.emit("session_tree", { type: "session_tree", newLeafId: "new-leaf", oldLeafId: "old-leaf" });
	assert.equal(h.hasLockCommand(), false, "no summary: nothing carried over");
	await h.emit("session_tree", {
		type: "session_tree",
		newLeafId: "new-leaf",
		oldLeafId: "old-leaf",
		summaryEntry: { type: "branch_summary", summary: "private recap" },
	});
	assert.equal(h.hasLockCommand(), true);
	assert.deepEqual(h.tools(), ["read", "edit", "bash"]);
});

test("review M2: a model switch during a run in a locked session aborts the run before reverting", async () => {
	const h = harness();
	await h.command("local");
	h.setIdle(false);
	await h.emit("model_select", { type: "model_select", model: find("anthropic", "claude-sonnet-5"), source: "set" });
	assert.equal(h.aborts(), 1);
	assert.equal(h.selected()?.provider, "privacy-router");
});

test("review I4: letter case cannot bypass the path guard on case-insensitive filesystems", async (t) => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-router-case-")));
	mkdirSync(join(root, "vault"));
	writeFileSync(join(root, "vault", "notes.txt"), "private");
	if (!existsSync(join(root, "VAULT", "notes.txt"))) {
		t.skip("case-sensitive filesystem: no bypass possible");
		return;
	}
	const config = join(mkdtempSync(join(tmpdir(), "pi-router-case-cfg-")), "router.json");
	writeFileSync(config, JSON.stringify({ sensitivePaths: [`${root}/vault/**`] }));
	const previous = process.env.PI_PRIVACY_ROUTER_CONFIG;
	process.env.PI_PRIVACY_ROUTER_CONFIG = config;
	try {
		const h = harness();
		const result = (await h.emit("tool_call", {
			type: "tool_call",
			toolName: "read",
			input: { path: join(root, "VAULT", "notes.txt") },
		})) as { block?: boolean } | undefined;
		assert.equal(result?.block, true);
	} finally {
		process.env.PI_PRIVACY_ROUTER_CONFIG = previous;
	}
});

test("a bare acknowledgement keeps the current lane even if the classifier says code", async () => {
	const h = harness();
	ollama.category = "live";
	await h.route({ reason: "user", messages: [user("weather in Chicago now?")] });
	ollama.category = "code";
	const next = await h.route({ reason: "user", messages: [user("ok, continue")] });
	assert.equal(next.model.id, "gpt-6-sol");
});

test("review M1: resuming a locked session, then /tree to an unlocked point keeps pi's full tool set", async () => {
	const h = harness();
	const locked: Entry[] = [{ type: "custom", customType: COMMAND_ENTRY, data: { kind: "lock" } }];
	// pi restores the transcript's loadout on resume, so a locked session starts already restricted.
	h.replaceBranch(locked);
	h.setTools(["read", "edit", "bash"]);
	await h.emit("session_start", { type: "session_start", reason: "resume" });
	// /tree to a point before the lock: pi restores the full set, then fires session_tree.
	h.replaceBranch([]);
	h.setTools(["read", "bash", "edit", "web_search", "askClaude"]);
	await h.emit("session_tree", { type: "session_tree", newLeafId: "early", oldLeafId: "late" });
	assert.deepEqual(h.tools(), ["read", "bash", "edit", "web_search", "askClaude"]);
});

test("a locked session accepts the configured private model and reverts any other model, localhost or not", async () => {
	const h = harness();
	await h.command("local");
	await h.emit("model_select", {
		type: "model_select",
		model: find("ollama", "qwen3.6:35b-pi"),
		source: "set",
	});
	assert.equal(h.modelSets(), 0, "the private model is accepted");
	await h.emit("model_select", { type: "model_select", model: find("ollama", "llama3"), source: "set" });
	assert.equal(h.modelSets(), 1, "another localhost model may be a remote gateway; reverted");
	assert.equal(h.selected()?.provider, "privacy-router");
});

test("review M4: no classifier warm-up when resuming a locked session", async () => {
	const h = harness();
	await h.command("local");
	ollama.calls.length = 0;
	await h.emit("session_start", { type: "session_start", reason: "resume" });
	assert.deepEqual(
		ollama.calls.filter((url) => url.endsWith("/api/generate")),
		[],
	);
});

test("review M8: a search that would reach private folders gets its own block message", async () => {
	const h = harness();
	const result = (await h.emit("tool_call", {
		type: "tool_call",
		toolName: "grep",
		input: { pattern: "TODO", path: homedir() },
	})) as { block: boolean; reason: string };
	assert.equal(result.block, true);
	assert.match(result.reason, /search would reach private folders/);
});

function lockedHandoff() {
	const earlier = { role: "user", content: "x".repeat(400_000), timestamp: 1 };
	const reply = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		provider: "anthropic",
		model: "claude-sonnet-5",
		stopReason: "stop",
		timestamp: 2,
	};
	const privateMessage = { role: "user", content: "my diagnosis came back positive", timestamp: 3 };
	const branch = [
		{ type: "message", id: "m1", message: earlier },
		{ type: "message", id: "m2", message: reply },
		{ type: "message", id: "m3", message: privateMessage },
		{ type: "custom", id: "c1", customType: COMMAND_ENTRY, data: { kind: "lock" } },
	];
	const event = {
		type: "session_before_compact",
		// pi proposes to summarize past the cloud reply, including the private message.
		preparation: {
			firstKeptEntryId: "c1",
			messagesToSummarize: [earlier, reply, privateMessage],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100_123,
			fileOps: { read: new Set(["src/a.ts"]), written: new Set<string>(), edited: new Set<string>() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		},
		branchEntries: branch,
		customInstructions: "focus on my diagnosis",
		reason: "threshold",
		willRetry: false,
		signal: new AbortController().signal,
	};
	return { branch, event, earlier, reply };
}

type HandoffResult = { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number } } | undefined;

test("a locked session hands its earlier history to the cloud model that already received it", async () => {
	const calls: unknown[][] = [];
	const h = harness(models, {
		summarize: async (...args) => {
			calls.push(args);
			return "cloud summary";
		},
	});
	const { branch, event, earlier, reply } = lockedHandoff();
	h.replaceBranch(branch);
	const result = (await h.emit("session_before_compact", event)) as HandoffResult;
	assert.equal(calls.length, 1);
	const [messages, model, , apiKey, , , customInstructions] = calls[0] as [
		unknown[],
		Model,
		number,
		string,
		unknown,
		unknown,
		string | undefined,
	];
	assert.deepEqual(messages, [earlier, reply]);
	assert.equal(`${model.provider}/${model.id}`, "anthropic/claude-sonnet-5");
	assert.equal(apiKey, "key-anthropic");
	assert.equal(customInstructions, undefined, "/compact instructions typed after the lock stay local");
	assert.deepEqual(calls[0][11], { enabled: true, maxRetries: 3, baseDelayMs: 2000 }, "transient errors are retried");
	assert.ok(!JSON.stringify(calls).includes("diagnosis"), "nothing after the cloud reply reaches the cloud");
	assert.ok(result);
	assert.equal(result.compaction.firstKeptEntryId, "m3");
	assert.equal(result.compaction.tokensBefore, 100_123);
	assert.equal(result.compaction.summary, "cloud summary\n\n<read-files>\nsrc/a.ts\n</read-files>");
});

test("an unlocked session leaves compaction to pi", async () => {
	let called = false;
	const h = harness(models, {
		summarize: async () => {
			called = true;
			return "s";
		},
	});
	const { branch, event } = lockedHandoff();
	const unlocked = branch.filter((entry) => entry.type !== "custom");
	h.replaceBranch(unlocked);
	assert.equal(await h.emit("session_before_compact", { ...event, branchEntries: unlocked }), undefined);
	assert.equal(called, false);
});

test("when the cloud model cannot summarize, a local note of the user's requests takes its place", async () => {
	const h = harness(models, {
		summarize: async () => {
			throw new Error("401 token expired");
		},
	});
	const { branch, event } = lockedHandoff();
	h.replaceBranch(branch);
	const result = (await h.emit("session_before_compact", event)) as HandoffResult;
	assert.ok(result);
	assert.match(result.compaction.summary, /^## Handoff note/);
	assert.match(result.compaction.summary, /401 token expired/);
	assert.equal(result.compaction.firstKeptEntryId, "m3");
	assert.ok(h.notices.some((notice) => notice.includes("could not summarize")));
});

test("history rewritten after the last cloud reply is kept local as a note", async () => {
	let called = false;
	const h = harness(models, {
		summarize: async () => {
			called = true;
			return "s";
		},
	});
	const { branch, event } = lockedHandoff();
	const edited = [...branch, { type: "context_edit", id: "x1", targetId: "m1", replacement: { content: "rewritten" } }];
	h.replaceBranch(edited);
	const result = (await h.emit("session_before_compact", { ...event, branchEntries: edited })) as HandoffResult;
	assert.equal(called, false);
	assert.ok(result);
	assert.match(result.compaction.summary, /^## Handoff note/);
	assert.match(result.compaction.summary, /edited after/);
});

function lockedBranch() {
	return [
		{ type: "message", id: "u1", message: { role: "user", content: "plan the wizard", timestamp: 1 } },
		{
			type: "message",
			id: "a1",
			message: { ...assistant, stopReason: "stop", timestamp: 2 },
		},
		{ type: "message", id: "u2", message: { role: "user", content: "my diagnosis is ...", timestamp: 3 } },
		{ type: "custom", id: "c1", customType: COMMAND_ENTRY, data: { kind: "lock" } },
		{
			type: "message",
			id: "a2",
			message: { role: "assistant", content: [], provider: "ollama", model: "qwen3.6:35b-pi", stopReason: "stop" },
		},
	];
}

test("/leave-local goes back to the last cloud reply before the lock, without a summary, and stays there", async () => {
	const h = harness();
	h.replaceBranch(lockedBranch());
	await h.command("leave-local");
	assert.deepEqual(h.navigations, [{ id: "a1", options: { summarize: false } }]);
	// pi keeps the new position only in memory; an entry there makes a reopened session resume on it.
	const last = h.entries.at(-1) as Entry;
	assert.equal(last.customType, COMMAND_ENTRY);
	assert.deepEqual(last.data, { kind: "leave-local" });
	assert.ok(h.notices.some((notice) => notice.includes("stays on its own branch")));
});

test("/leave-local does nothing in a session that is not locked", async () => {
	const h = harness();
	h.replaceBranch(lockedBranch().filter((entry) => entry.type !== "custom"));
	await h.command("leave-local");
	assert.deepEqual(h.navigations, []);
	assert.ok(h.notices.some((notice) => notice.includes("not locked")));
});

test("/leave-local points to a new session when the lock came before any cloud reply", async () => {
	const h = harness();
	h.replaceBranch(lockedBranch().slice(2));
	await h.command("leave-local");
	assert.deepEqual(h.navigations, []);
	assert.ok(h.notices.some((notice) => notice.includes("/new")));
});

test("/leave-local refuses when pi runs in a private folder, which would lock again", async () => {
	const h = harness();
	h.replaceBranch(lockedBranch());
	h.setCwd(join(homedir(), ".ssh"));
	await h.command("leave-local");
	assert.deepEqual(h.navigations, []);
	assert.ok(h.notices.some((notice) => notice.includes("private folder")));
});

function quotaFailure(provider = "anthropic", model = "claude-sonnet-5", errorMessage?: string) {
	return [
		{ type: "message", id: "u1", message: { role: "user", content: "refactor the wizard", timestamp: 1 } },
		{
			type: "message",
			id: "a1",
			message: {
				role: "assistant",
				content: [],
				provider,
				model,
				stopReason: "error",
				errorMessage:
					errorMessage ??
					`400 {"type":"error","error":{"type":"invalid_request_error","message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."}}`,
				timestamp: 2,
			},
		},
	];
}

type SettleResult =
	| {
			entries: { type: string; customType?: string; data?: unknown; targetId?: string; replacement?: unknown }[];
			continue: boolean;
	  }
	| undefined;

test("a Claude usage-limit error fails the turn over to GPT and retries it there", async () => {
	const h = harness();
	h.replaceBranch(quotaFailure());
	const result = (await h.emit("agent_before_settle", {
		type: "agent_before_settle",
		outcome: "error",
	})) as SettleResult;
	assert.ok(result);
	assert.equal(result.continue, true);
	const [cooldown, omit] = result.entries;
	assert.equal(cooldown.customType, COMMAND_ENTRY);
	assert.equal((cooldown.data as { kind: string }).kind, "cooldown");
	assert.equal((cooldown.data as { provider: string }).provider, "anthropic");
	// The failed attempt leaves the model's context, as in pi's own retries.
	assert.deepEqual(omit, { type: "context_edit", targetId: "a1", replacement: null });
	assert.ok(
		h.notices.some((notice) => /anthropic usage limit reached; retrying on openai-codex\/gpt-6-sol/.test(notice)),
	);

	// pi commits the entries and asks for one more request; the router sends it to GPT.
	h.entries.push(cooldown as Entry);
	ollama.category = "code";
	const retried = await h.route({ reason: "user", messages: [user("refactor the wizard")] });
	assert.equal(retried.model.id, "gpt-6-sol");
});

test("other errors, local sessions and sessions not on the router are left to pi", async () => {
	const settle = { type: "agent_before_settle", outcome: "error" };
	const transient = harness();
	transient.replaceBranch(quotaFailure("anthropic", "claude-sonnet-5", "500 internal server error"));
	assert.equal(await transient.emit("agent_before_settle", settle), undefined);

	const locked = harness();
	locked.replaceBranch([...quotaFailure(), { type: "custom", customType: COMMAND_ENTRY, data: { kind: "lock" } }]);
	assert.equal(await locked.emit("agent_before_settle", settle), undefined);

	const finished = harness();
	finished.replaceBranch(quotaFailure());
	assert.equal(await finished.emit("agent_before_settle", { ...settle, outcome: "completed" }), undefined);
});

test("/privacy shows the router status, and /router is left free for other extensions", async () => {
	const h = harness();
	assert.ok(h.commandNames().includes("privacy"));
	assert.ok(!h.commandNames().includes("router"));
	await h.command("privacy");
	assert.ok(h.notices.some((notice) => notice.startsWith("selected: privacy-router/auto")));
});

async function withConfig<T>(config: object, run: () => Promise<T>): Promise<T> {
	const path = join(mkdtempSync(join(tmpdir(), "pi-router-routes-")), "privacy-router.json");
	writeFileSync(path, JSON.stringify(config));
	const previous = process.env.PI_PRIVACY_ROUTER_CONFIG;
	process.env.PI_PRIVACY_ROUTER_CONFIG = path;
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env.PI_PRIVACY_ROUTER_CONFIG;
		else process.env.PI_PRIVACY_ROUTER_CONFIG = previous;
	}
}

const settleEvent = { type: "agent_before_settle", outcome: "error" };

test("a model without credentials is skipped with one notice per session", async () => {
	const h = harness(models, undefined, (model) => model.provider !== "anthropic");
	ollama.category = "code";
	const first = await h.route({ reason: "user", messages: [user("refactor the parser")] });
	assert.equal(first.model.id, "gpt-6-sol");
	await h.route({ reason: "user", messages: [user("now add tests")] });
	const notices = h.notices.filter((notice) => notice.includes("has no credentials"));
	assert.deepEqual(notices, ["anthropic/claude-sonnet-5 has no credentials; using openai-codex/gpt-6-sol for code"]);
});

test("usage-limit failover continues across three providers", async () => {
	await withConfig(
		{ routes: { code: ["anthropic/claude-sonnet-5", "google/gemini-3-pro", "openai-codex/gpt-6-sol"] } },
		async () => {
			const h = harness();
			h.replaceBranch(quotaFailure());
			const first = (await h.emit("agent_before_settle", settleEvent)) as SettleResult;
			assert.ok(first);
			assert.equal((first.entries[0].data as { provider: string }).provider, "anthropic");
			h.entries.push(first.entries[0] as Entry);
			ollama.category = "code";
			assert.equal(
				(await h.route({ reason: "user", messages: [user("refactor the wizard")] })).model.id,
				"gemini-3-pro",
			);

			h.replaceBranch([...quotaFailure("google", "gemini-3-pro"), first.entries[0] as Entry]);
			const second = (await h.emit("agent_before_settle", settleEvent)) as SettleResult;
			assert.ok(second);
			assert.equal((second.entries[0].data as { provider: string }).provider, "google");
			h.entries.push(second.entries[0] as Entry);
			assert.equal((await h.route({ reason: "user", messages: [user("refactor the wizard")] })).model.id, "gpt-6-sol");
		},
	);
});

test("no failover when no usable model would remain", async () => {
	await withConfig(
		{ routes: { code: ["anthropic/claude-sonnet-5"], live: ["anthropic/claude-sonnet-5"] } },
		async () => {
			const h = harness();
			h.replaceBranch(quotaFailure());
			assert.equal(await h.emit("agent_before_settle", settleEvent), undefined);
		},
	);
});

test("the router's own refusal is never treated as a provider usage limit", async () => {
	const h = harness();
	h.replaceBranch(
		quotaFailure(
			"privacy-router",
			"auto",
			"No usable model for code: anthropic/claude-sonnet-5 (cooling until 14:05) after a usage limit",
		),
	);
	assert.equal(await h.emit("agent_before_settle", settleEvent), undefined);
});

test("a pin whose name left the config is ignored", async () => {
	const h = harness();
	h.replaceBranch([{ type: "custom", customType: COMMAND_ENTRY, data: { kind: "pin", target: "removed" } }]);
	ollama.category = "code";
	const result = await h.route({ reason: "user", messages: [user("write a test")] });
	assert.equal(result.model.id, "claude-sonnet-5");
});

test("a ref with extra slashes routes through pi's registry", async () => {
	await withConfig({ routes: { code: ["openrouter/anthropic/claude-x"] } }, async () => {
		const h = harness();
		ollama.category = "code";
		const result = await h.route({ reason: "user", messages: [user("write a test")] });
		assert.equal(result.model.provider, "openrouter");
		assert.equal(result.model.id, "anthropic/claude-x");
	});
});

test("the footer and /privacy show the current model and route", async () => {
	const h = harness();
	ollama.category = "code";
	await h.route({ reason: "user", messages: [user("write a test")] });
	assert.equal(h.status(), "→ claude-sonnet-5 · code");
	await h.command("privacy");
	assert.ok(h.notices.some((notice) => notice.includes("model: anthropic/claude-sonnet-5 · route: code")));
});

test("/privacy still shows the lock when the config is invalid", async () => {
	await withConfig({ minProb: 2 }, async () => {
		const h = harness();
		h.replaceBranch([{ type: "custom", customType: COMMAND_ENTRY, data: { kind: "lock" } }]);
		await h.command("privacy");
		const status = h.notices.find((notice) => notice.startsWith("selected:"));
		assert.ok(status?.includes("🔒 locked"));
		assert.ok(status?.includes("INVALID"));
	});
});

test("the settle hook never fails over a local model's error, even in an unlocked session", async () => {
	const h = harness();
	h.replaceBranch(quotaFailure("ollama", "qwen3.6:35b-pi", "You have reached your usage limit"));
	assert.equal(await h.emit("agent_before_settle", settleEvent), undefined);
});

test("a 0.1 locked state passed as request.state stays on the private model", async () => {
	const h = harness();
	const state = { lane: "local", locked: true, lockReason: "pii", lockDetail: "x" };
	const previous = { model: find("anthropic", "claude-sonnet-5"), thinkingLevel: "medium" };
	const continued = await h.route({ reason: "continuation", state, messages: [user("go on")] });
	assert.equal(continued.model.provider, "ollama");
	const direct = await h.route({ reason: "direct", state, previous, messages: [user("go on")] });
	assert.equal(direct.model.provider, "ollama");
});

test("a 0.1 gpt cooldown command with a 0.1 unlocked state keeps routing off openai-codex", async () => {
	const h = harness();
	const until = new Date(Date.now() + 60 * 60_000).toISOString();
	h.replaceBranch([{ type: "custom", customType: COMMAND_ENTRY, data: { kind: "cooldown", lane: "gpt", until } }]);
	ollama.category = "code";
	const result = await h.route({
		reason: "user",
		state: { lane: "gpt", locked: false },
		messages: [user("refactor the parser")],
	});
	assert.equal(result.model.id, "claude-sonnet-5");
	assert.ok(Object.keys((result.state as { cooldowns?: object }).cooldowns ?? {}).includes("openai-codex"));
});

// Batch A: the lock holds whatever model is selected.
const CLOUD = () => find("anthropic", "claude-sonnet-5");
const PRIVATE = () => find("ollama", "qwen3.6:35b-pi");

test("session_start: a locked branch with a cloud model selected switches to the router and says so", async () => {
	const h = harness();
	await h.command("local");
	h.select(CLOUD());
	const noticesBefore = h.notices.length;
	await h.emit("session_start", { type: "session_start", reason: "resume" });
	assert.equal(h.selected()?.provider, "privacy-router");
	assert.equal(h.modelSets(), 1);
	assert.deepEqual(h.notices.slice(noticesBefore), [
		"🔒 This session is locked to local; switched from anthropic/claude-sonnet-5 to privacy-router/auto.",
	]);
});

test("session_start: unlocked with a cloud model, or locked with the private model, is left alone", async () => {
	const h = harness();
	h.select(CLOUD());
	await h.emit("session_start", { type: "session_start", reason: "startup" });
	assert.equal(h.modelSets(), 0);
	h.replaceBranch([lockEntry]);
	h.select(PRIVATE());
	await h.emit("session_start", { type: "session_start", reason: "resume" });
	assert.equal(h.modelSets(), 0);
});

test("session_tree: arriving in a locked branch with a cloud model selected switches to the router", async () => {
	const h = harness();
	await h.command("local");
	h.select(CLOUD());
	await h.emit("session_tree", { type: "session_tree", newLeafId: "leaf", oldLeafId: null });
	assert.equal(h.selected()?.provider, "privacy-router");
	assert.equal(h.modelSets(), 1);
	assert.match(h.notices.at(-1) ?? "", /switched from anthropic\/claude-sonnet-5 to privacy-router\/auto/);
});

test("before_provider_request: a locked session with a cloud model gets an empty body and a notice", async () => {
	const h = harness();
	await h.command("local");
	h.select(CLOUD());
	const result = await h.emit("before_provider_request", {
		type: "before_provider_request",
		payload: { messages: [1] },
	});
	assert.deepEqual(result, {});
	assert.equal(
		h.notices.at(-1),
		"🔒 Blocked a request from a locked session to anthropic/claude-sonnet-5; no session content was sent. Select privacy-router/auto.",
	);
});

test("before_provider_request: router or private model in a locked session, or an unlocked session, passes", async () => {
	const h = harness();
	const event = { type: "before_provider_request", payload: { messages: [1] } };
	h.select(CLOUD());
	assert.equal(await h.emit("before_provider_request", event), undefined, "unlocked + cloud");
	await h.command("local");
	h.select(find("privacy-router", "auto"));
	assert.equal(await h.emit("before_provider_request", event), undefined, "locked + router");
	h.select(PRIVATE());
	assert.equal(await h.emit("before_provider_request", event), undefined, "locked + private");
});

test("session_before_compact: a locked session with a cloud model selected cancels", async () => {
	const h = harness();
	const { branch, event } = lockedHandoff();
	h.replaceBranch(branch);
	h.select(CLOUD());
	assert.deepEqual(await h.emit("session_before_compact", event), { cancel: true });
	assert.match(h.notices.at(-1) ?? "", /anthropic\/claude-sonnet-5/);
});

function treeEvent(userWantsSummary: boolean) {
	return {
		type: "session_before_tree",
		preparation: {
			targetId: "t",
			oldLeafId: "old-leaf",
			commonAncestorId: null,
			entriesToSummarize: [],
			userWantsSummary,
		},
		signal: new AbortController().signal,
	};
}

test("session_before_tree: a summary of a locked branch with a cloud model selected cancels", async () => {
	const h = harness();
	const locked: Entry[] = [{ type: "custom", customType: COMMAND_ENTRY, data: { kind: "lock" } }];
	h.setBranchAt((fromId) => (fromId === "old-leaf" ? locked : h.entries));
	h.select(CLOUD());
	assert.deepEqual(await h.emit("session_before_tree", treeEvent(true)), { cancel: true });
	assert.equal(
		h.notices.at(-1),
		"A summary of a private branch would go to anthropic/claude-sonnet-5; navigate without a summary or select privacy-router/auto.",
	);
	assert.equal(await h.emit("session_before_tree", treeEvent(false)), undefined, "no summary requested");
});

test("session_before_tree: an unlocked branch, or a private model, is left alone", async () => {
	const h = harness();
	h.select(CLOUD());
	assert.equal(await h.emit("session_before_tree", treeEvent(true)), undefined, "unlocked branch");
	const locked: Entry[] = [{ type: "custom", customType: COMMAND_ENTRY, data: { kind: "lock" } }];
	h.setBranchAt(() => locked);
	h.select(PRIVATE());
	assert.equal(await h.emit("session_before_tree", treeEvent(true)), undefined, "private model");
});

const lockEntry: Entry = { type: "custom", customType: COMMAND_ENTRY, data: { kind: "lock" } };
const providerEvent = { type: "before_provider_request", payload: { messages: [1] } };

test("an invalid config allows only the router in a locked session, even the private model", async () => {
	await withConfig({ minProb: 2 }, async () => {
		const h = harness();
		h.replaceBranch([lockEntry]);
		h.select(PRIVATE());
		assert.deepEqual(await h.emit("before_provider_request", providerEvent), {});
		await h.emit("session_start", { type: "session_start", reason: "resume" });
		assert.equal(h.selected()?.provider, "privacy-router");
		assert.equal(await h.emit("before_provider_request", providerEvent), undefined, "router passes");
	});
});

test("an unreadable branch counts as locked: a cloud model is switched off and blocked", async () => {
	const h = harness();
	h.breakBranch(true);
	h.select(CLOUD());
	assert.deepEqual(await h.emit("before_provider_request", providerEvent), {});
	await h.emit("session_start", { type: "session_start", reason: "resume" });
	assert.equal(h.selected()?.provider, "privacy-router");
});

test("session_before_tree: an unreadable old leaf counts as locked even when the current branch is not", async () => {
	const h = harness();
	h.breakBranchAt(true);
	h.select(CLOUD());
	assert.deepEqual(await h.emit("session_before_tree", treeEvent(true)), { cancel: true });
	const nullLeaf = treeEvent(true);
	nullLeaf.preparation.oldLeafId = null as never;
	assert.deepEqual(await h.emit("session_before_tree", nullLeaf), { cancel: true });
});

test("when pi refuses the switch, the lock says so instead of claiming it switched, and the backstop blocks", async () => {
	const h = harness();
	await h.command("local");
	h.select(CLOUD());
	h.setModelResult(false);
	const before = h.notices.length;
	await h.emit("session_start", { type: "session_start", reason: "resume" });
	const added = h.notices.slice(before);
	assert.equal(added.length, 1);
	assert.match(added[0], /locked to local/);
	assert.match(added[0], /anthropic\/claude-sonnet-5 will be blocked/);
	assert.ok(!added[0].includes("switched"));
	assert.deepEqual(await h.emit("before_provider_request", providerEvent), {});
});

test("/local switches a selected cloud model to the router", async () => {
	const h = harness();
	h.select(CLOUD());
	await h.command("local");
	assert.equal(h.selected()?.provider, "privacy-router");
	assert.ok(
		h.notices.some((notice) => /switched from anthropic\/claude-sonnet-5 to privacy-router\/auto/.test(notice)),
	);
});

const localReply = {
	role: "assistant",
	content: [],
	provider: "ollama",
	model: "qwen3.6:35b-pi",
	stopReason: "stop",
};
const isCloud = (provider: string, model: string) => provider === "anthropic" && model === "claude-sonnet-5";

test("deltaText starts after the last successful cloud reply, not after a local one", () => {
	const messages = [user("first"), assistant, user("second"), localReply, user("third")];
	assert.equal(deltaText(messages as never, isCloud).user, "second\nthird");
});

test("deltaText: errored and aborted cloud replies never anchor", () => {
	const errored = { ...assistant, stopReason: "error" };
	const aborted = { ...assistant, stopReason: "aborted" };
	const messages = [user("first"), assistant, user("second"), errored, user("third"), aborted, user("fourth")];
	assert.equal(deltaText(messages as never, isCloud).user, "second\nthird\nfourth");
});

test("deltaText: with no cloud reply the whole transcript is the delta", () => {
	const messages = [user("first"), localReply, toolResult("tool out"), user("second")];
	const delta = deltaText(messages as never, isCloud);
	assert.equal(delta.user, "first\nsecond");
	assert.equal(delta.tool, "tool out");
});

test("H2: text written on a local model is scanned once the router goes back to a cloud model", async () => {
	const h = harness();
	const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
	const result = await h.route({
		reason: "user",
		messages: [user("hello"), assistant, user(`#private ${token}`), localReply, user("unrelated")],
	});
	assert.equal(result.model.provider, "ollama");
	assert.equal((result.state as { locked: boolean }).locked, true);
	assert.equal(ollama.piiCalls, 0, "deterministic lock happens before any classifier call");
});

test("H2: a reply from the router itself never anchors the delta", async () => {
	const h = harness();
	const routerReply = { ...assistant, provider: "privacy-router", model: "auto", stopReason: "stop" };
	const messages = [user("#private early note"), routerReply, user("unrelated")];
	const result = await h.route({ reason: "user", messages });
	assert.equal(result.model.provider, "ollama");
});

test("classifier outage: the refusal covers not running, still loading and timeouts", async () => {
	const h = harness();
	ollama.down = true;
	await assert.rejects(
		h.route({ reason: "user", messages: [user("hello")] }),
		(error: Error) =>
			error instanceof RouterError &&
			error.message ===
				"Privacy check unavailable: the local classifier did not answer (not running, still loading, or too slow). Start Ollama, or wait for the model to load, and resend. The classifier settings are under ollama in privacy-router.json.",
	);
});

test("H2: a model missing from pi's registry is not treated as a cloud anchor", async () => {
	const h = harness();
	const unknownReply = { ...assistant, provider: "mystery", model: "unknown" };
	const result = await h.route({
		reason: "user",
		messages: [user("hello"), unknownReply, user("#private note"), unknownReply, user("unrelated")],
	});
	assert.equal(result.model.provider, "ollama");
});

test("H3: personal data only in the first window of a long message locks the session", async () => {
	const h = harness();
	ollama.piiMarker = "MARKER-IN-HEAD";
	const text = `MARKER-IN-HEAD ${"x ".repeat(MAX_CLASSIFY_CHARS)}`;
	assert.ok(text.length > MAX_CLASSIFY_CHARS * 2);
	const result = await h.route({ reason: "user", messages: [user(text)] });
	assert.equal(result.model.provider, "ollama");
	assert.equal(ollama.piiCalls, 1, "stops at the first yes");
});

test("H3: a long message with no personal data in any window is classified window by window and routes on", async () => {
	const h = harness();
	ollama.piiMarker = "NEVER-PRESENT";
	const result = await h.route({ reason: "user", messages: [user("x ".repeat(MAX_CLASSIFY_CHARS))] });
	assert.equal(result.model.provider, "anthropic");
	assert.ok(ollama.piiCalls >= 3);
});

test("H3: an error in any window fails the whole privacy check", async () => {
	const h = harness();
	ollama.pii = "maybe";
	await assert.rejects(h.route({ reason: "user", messages: [user("x ".repeat(MAX_CLASSIFY_CHARS))] }), RouterError);
});

const overCap = () => "x ".repeat(MAX_CLASSIFY_CHARS * MAX_PII_WINDOWS);

test("H3: a message over the window cap is refused with advice and never reaches the classifier", async () => {
	const h = harness();
	await assert.rejects(
		h.route({ reason: "user", messages: [user(overCap())] }),
		(error: Error) =>
			error instanceof RouterError &&
			/^Text since the last cloud reply is too long to check for personal information\. Add #private to keep this session on the local model, use \/tree without a summary to go back to before the long text, or start a new session\.$/.test(
				error.message,
			),
	);
	assert.equal(ollama.piiCalls, 0);
});

test("H3: a too-long message proceeds with a notice under onPrivacyCheckFailure warn", async () => {
	const h = harness();
	const path = join(mkdtempSync(join(tmpdir(), "pi-router-warn-")), "router.json");
	writeFileSync(path, JSON.stringify({ onPrivacyCheckFailure: "warn" }));
	const previous = process.env.PI_PRIVACY_ROUTER_CONFIG;
	process.env.PI_PRIVACY_ROUTER_CONFIG = path;
	try {
		const result = await h.route({ reason: "user", messages: [user(overCap())] });
		assert.equal(result.model.provider, "anthropic");
		assert.equal(ollama.piiCalls, 0);
		assert.ok(
			h.notices.some((n) =>
				n.includes(
					"⚠ text since the last cloud reply is too long to check for personal information; deterministic checks only",
				),
			),
		);
	} finally {
		process.env.PI_PRIVACY_ROUTER_CONFIG = previous;
	}
});

test("H3: #private on a too-long message still locks locally", async () => {
	const h = harness();
	const result = await h.route({ reason: "user", messages: [user(`#private ${overCap()}`)] });
	assert.equal(result.model.provider, "ollama");
});

// Batch D: pi auto-retries a routing refusal whose text looks transient, as reason "retry" with no failed model.
const cloudReply = { ...assistant, stopReason: "stop" };
const routingRetry = (messages: unknown[]) => ({
	reason: "retry",
	previous: { model: CLOUD(), thinkingLevel: "medium" },
	messages,
});

test("N1: a retry after a routing refusal is refused again while the classifier is down", async () => {
	const h = harness();
	ollama.down = true;
	const messages = [user("hello"), cloudReply, user("my salary is 185k")];
	await assert.rejects(h.route({ reason: "user", messages }), RouterError);
	await assert.rejects(h.route(routingRetry(messages)), RouterError);
});

test("N1: a retry after a routing refusal locks when the classifier finds personal information", async () => {
	const h = harness();
	ollama.piiMarker = "salary";
	const result = await h.route(routingRetry([user("hello"), cloudReply, user("my salary is 185k")]));
	assert.equal(result.model.provider, "ollama");
	assert.equal(h.hasLockCommand(), true);
});

test("N1: a retry after a routing refusal is routed as a new turn, by category", async () => {
	const h = harness();
	ollama.category = "live";
	const result = await h.route(routingRetry([user("hello"), cloudReply, user("weather in Chicago now?")]));
	assert.equal(result.model.id, "gpt-6-sol");
});

// Batch D: retries and summaries get the privacy check (no category call) on text since the last cloud reply.
const providerFailure = {
	model: CLOUD(),
	thinkingLevel: "medium",
	message: { ...assistant, stopReason: "error", errorMessage: "503 service unavailable" },
};

test("N2: a provider retry that carries a queued steering message with personal information locks", async () => {
	const h = harness();
	ollama.piiMarker = "salary";
	ollama.category = "code";
	const result = await h.route({
		reason: "retry",
		previous: { model: CLOUD(), thinkingLevel: "medium" },
		failed: providerFailure,
		messages: [user("hello"), cloudReply, user("refactor the parser"), user("also, my salary is 185k")],
	});
	assert.ok(ollama.piiCalls >= 1, "the privacy classifier ran");
	assert.equal(result.model.provider, "ollama");
	assert.equal(h.hasLockCommand(), true);
	assert.equal(
		ollama.calls.length,
		ollama.piiCalls,
		"no category call on a retry: the route stays with the failed model",
	);
});

test("N3: a summary request with unchecked text is refused while the classifier is down", async () => {
	const h = harness();
	ollama.down = true;
	await assert.rejects(
		h.route({
			reason: "direct",
			previous: { model: CLOUD(), thinkingLevel: "medium" },
			messages: [user("hello"), cloudReply, user("my salary is 185k")],
		}),
		RouterError,
	);
});

test("retries and summaries with nothing new since the last cloud reply make no classifier call", async () => {
	const h = harness();
	ollama.down = true; // any classifier call would fail the check and refuse
	const previous = { model: CLOUD(), thinkingLevel: "medium" };
	const messages = [user("hello"), cloudReply];
	const direct = await h.route({ reason: "direct", previous, messages });
	assert.equal(direct.model.id, "claude-sonnet-5");
	const retry = await h.route({ reason: "retry", previous, failed: providerFailure, messages });
	assert.equal(retry.model.id, "claude-sonnet-5");
	assert.deepEqual(ollama.calls, []);
});

test("a locked session's summaries and retries never call the classifier", async () => {
	const h = harness();
	await h.command("local");
	ollama.down = true;
	const previous = { model: CLOUD(), thinkingLevel: "medium" };
	const messages = [user("hello"), cloudReply, user("my salary is 185k")];
	assert.equal((await h.route({ reason: "direct", previous, messages })).model.provider, "ollama");
	assert.equal(
		(await h.route({ reason: "retry", previous, failed: providerFailure, messages })).model.provider,
		"ollama",
	);
	assert.deepEqual(ollama.calls, []);
});

// Batch D: a locked session allows the configured private model only when it really is local.
const cloudPrivate: Model = {
	provider: "cloudco",
	id: "c2",
	baseUrl: "https://api.cloudco.example/v1",
	api: "openai-completions",
};

test("N4: a locked session reverts /model to a configured private model that is not served from localhost", async () => {
	await withConfig({ private: "cloudco/c2" }, async () => {
		const h = harness([...models, cloudPrivate]);
		await h.command("local");
		await h.emit("model_select", { type: "model_select", model: cloudPrivate, source: "set" });
		assert.equal(h.modelSets(), 1);
		assert.equal(h.selected()?.provider, "privacy-router");
	});
});

test("N4: a locked session blocks requests and compaction to a private model not served from localhost", async () => {
	await withConfig({ private: "cloudco/c2" }, async () => {
		const h = harness([...models, cloudPrivate]);
		await h.command("local");
		h.select(cloudPrivate);
		assert.deepEqual(await h.emit("before_provider_request", providerEvent), {}, "the request body is emptied");
		const { branch, event } = lockedHandoff();
		h.replaceBranch(branch);
		assert.deepEqual(await h.emit("session_before_compact", event), { cancel: true }, "compaction cancels");
	});
});

test("N7: the router declares limits, so a refused route does not look like a full context", () => {
	const definition = harness().virtualModel();
	assert.ok((definition?.contextWindow ?? 0) > 0);
	assert.ok((definition?.maxTokens ?? 0) > 0);
});

// Fix round 1: an extension can start a turn (pi.sendMessage with triggerTurn); pi routes it as a
// continuation, and the text since the last cloud reply can hold unchecked or refused user text.
const routerRefusal = { ...assistant, provider: "privacy-router", model: "auto", stopReason: "error" };
const continuation = (messages: unknown[]) => ({
	reason: "continuation",
	previous: { model: CLOUD(), thinkingLevel: "medium" },
	messages,
});

test("C1: an extension-started turn after a refusal is refused while the classifier is down", async () => {
	const h = harness();
	ollama.down = true;
	const messages = [user("hello"), cloudReply, user("my salary is 185k"), routerRefusal, user("[ext] job finished")];
	await assert.rejects(h.route(continuation(messages)), RouterError);
});

test("C1: an extension-started turn locks when the classifier finds personal information", async () => {
	const h = harness();
	ollama.piiMarker = "salary";
	const messages = [user("hello"), cloudReply, user("my salary is 185k"), routerRefusal, user("[ext] job finished")];
	const result = await h.route(continuation(messages));
	assert.equal(result.model.provider, "ollama");
	assert.equal(h.hasLockCommand(), true);
	assert.equal(ollama.calls.length, ollama.piiCalls, "no category call on a continuation");
});

test("C1: an extension-started turn after a too-long refusal is refused again", async () => {
	const h = harness();
	const messages = [user("hello"), cloudReply, user(overCap()), routerRefusal, user("Background task finished")];
	await assert.rejects(
		h.route(continuation(messages)),
		(error: Error) =>
			error instanceof RouterError && error.message.startsWith("Text since the last cloud reply is too long"),
	);
	assert.equal(ollama.piiCalls, 0);
});

test("C1: shell output (!command) carried by an extension-started turn locks when it holds personal information", async () => {
	const h = harness();
	ollama.piiMarker = "diagnosis";
	const bash = user("Ran `cat ~/notes/health.txt`\n```\ndiagnosis: type 2 diabetes\n```");
	const result = await h.route(continuation([user("hello"), cloudReply, bash, user("Subagent finished")]));
	assert.equal(result.model.provider, "ollama");
	assert.equal(h.hasLockCommand(), true);
});

test("an ordinary tool-loop continuation makes no classifier call and stays on the previous model", async () => {
	const h = harness();
	ollama.down = true; // any classifier call would fail the check and refuse
	const toolCall = { ...assistant, stopReason: "toolUse" };
	const result = await h.route(continuation([user("hello"), cloudReply, user("read a.ts"), toolCall, toolResult("x")]));
	assert.equal(result.model.id, "claude-sonnet-5");
	assert.equal(result.state, undefined);
	assert.deepEqual(ollama.calls, []);
});

// Fix round 1: with the router missing, a locked session falls back to the private model only when the lock allows it.
const withoutRouter = models.filter((m) => m.provider !== "privacy-router");

test("router missing, private model not on localhost: a locked session never selects it and says requests are blocked", async () => {
	await withConfig({ private: "cloudco/c2" }, async () => {
		const h = harness([...withoutRouter, cloudPrivate]);
		await h.command("local");
		await h.emit("model_select", { type: "model_select", model: CLOUD(), source: "set" });
		assert.equal(h.modelSets(), 0, "/model: no switch to the cloud private model");
		assert.equal(
			h.notices.at(-1),
			"🔒 This session is locked to local; requests to anthropic/claude-sonnet-5 will be blocked.",
		);
		h.select(CLOUD());
		const noticesBeforeResume = h.notices.length;
		await h.emit("session_start", { type: "session_start", reason: "resume" });
		assert.equal(h.modelSets(), 0, "resume: no switch to the cloud private model");
		assert.equal(h.selected()?.provider, "anthropic");
		assert.ok(h.notices.length > noticesBeforeResume, "resume: a new notice, not the one /model left");
		assert.match(h.notices.at(-1) ?? "", /requests to anthropic\/claude-sonnet-5 will be blocked/);
		assert.deepEqual(await h.emit("before_provider_request", providerEvent), {});
	});
});

test("router missing, private model on localhost: a locked session falls back to it", async () => {
	const h = harness(withoutRouter);
	await h.command("local");
	await h.emit("model_select", { type: "model_select", model: CLOUD(), source: "set" });
	assert.equal(h.selected()?.id, "qwen3.6:35b-pi");
	h.select(CLOUD());
	await h.emit("session_start", { type: "session_start", reason: "resume" });
	assert.equal(h.selected()?.id, "qwen3.6:35b-pi");
});
