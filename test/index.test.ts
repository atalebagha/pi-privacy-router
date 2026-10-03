import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import router, { type RouterDeps } from "../src/index.ts";
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

function harness(catalog: Model[] = models, deps?: RouterDeps) {
	const lookup = (provider: string, id: string) => catalog.find((m) => m.provider === provider && m.id === id);
	let branchAt: ((fromId: string) => Entry[]) | undefined;
	let idle = true;
	let cwd = join(homedir(), "Coding", "app");
	const navigations: { id: string; options: unknown }[] = [];
	let aborts = 0;
	let modelSets = 0;
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const entries: Entry[] = [];
	const notices: string[] = [];
	let virtualModel:
		| { route: (request: unknown, ctx: unknown) => Promise<{ model: Model; state?: unknown }> }
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
			selected = model;
			modelSets++;
			return true;
		},
	};
	router(pi as never, deps);

	const ctx = () => ({
		cwd,
		hasUI: true,
		ui: { notify: (message: string) => notices.push(message), setStatus: () => {} },
		sessionManager: { getBranch: (fromId?: string) => (fromId && branchAt ? branchAt(fromId) : entries) },
		modelRegistry: {
			find: lookup,
			hasConfiguredAuth: () => true,
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
		entries,
		notices,
		tools: () => activeTools,
		selected: () => selected,
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

let ollama: { category: string; pii: string; down: boolean; calls: string[] };
const realFetch = globalThis.fetch;

beforeEach(() => {
	ollama = { category: "general", pii: "no", down: false, calls: [] };
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		ollama.calls.push(url);
		if (ollama.down) throw new TypeError("fetch failed");
		const body = JSON.parse(String(init.body));
		const isPii = String(body.messages?.[0]?.content ?? "").startsWith("You are a privacy filter");
		const content = isPii ? ollama.pii : ollama.category;
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
	assert.deepEqual(result.state, { lane: "claude", locked: false });
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

test("review M3: a locked session may switch to any localhost model", async () => {
	const h = harness();
	await h.command("local");
	const noticesBefore = h.notices.length;
	await h.emit("model_select", { type: "model_select", model: find("ollama", "llama3"), source: "set" });
	assert.equal(h.modelSets(), 0, "no revert");
	assert.deepEqual(h.notices.slice(noticesBefore), [], "no 'locked to local' warning for a local model");
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
	assert.equal((cooldown.data as { kind: string; lane: string }).kind, "cooldown");
	assert.equal((cooldown.data as { lane: string }).lane, "claude");
	// The failed attempt leaves the model's context, as in pi's own retries.
	assert.deepEqual(omit, { type: "context_edit", targetId: "a1", replacement: null });
	assert.ok(h.notices.some((notice) => /claude.*gpt/.test(notice)));

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
