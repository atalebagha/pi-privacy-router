import assert from "node:assert/strict";
import { test } from "node:test";
import {
	estimateInputTokens,
	fileLists,
	type HandoffEntry,
	type HandoffInput,
	type HandoffMessage,
	handoffNote,
	localSummaryBudget,
	planHandoff,
	rewindTarget,
} from "../src/handoff.ts";

let clock = 1_000;
const user = (text: string): HandoffMessage => ({ role: "user", content: text, timestamp: clock++ });
const reply = (provider: string, model: string, stopReason = "stop"): HandoffMessage => ({
	role: "assistant",
	content: [{ type: "text", text: `reply from ${model}` }],
	provider,
	model,
	stopReason,
	timestamp: clock++,
});
const claude = (stopReason?: string) => reply("anthropic", "claude-sonnet-5", stopReason);
const local = (stopReason?: string) => reply("ollama", "qwen3.6:35b-pi", stopReason);
const toolResult = (text: string): HandoffMessage => ({ role: "toolResult", content: text, timestamp: clock++ });

let ids = 0;
const entry = (message: HandoffMessage): HandoffEntry => ({ type: "message", id: `e${ids++}`, message });
const custom = (): HandoffEntry => ({ type: "custom", id: `e${ids++}` });
const compaction = (): HandoffEntry => ({ type: "compaction", id: `e${ids++}` });

const isCloud = (provider: string) => provider !== "ollama";

function input(branch: HandoffEntry[], firstKeptEntryId: string, overrides: Partial<HandoffInput> = {}): HandoffInput {
	const keptAt = branch.findIndex((e) => e.id === firstKeptEntryId);
	const toSummarize = branch.slice(0, keptAt).flatMap((e) => (e.message ? [e.message] : []));
	return { branch, toSummarize, firstKeptEntryId, inputTokens: 100_000, localBudget: 39_000, isCloud, ...overrides };
}

test("a summary input the local model can take is left to pi", () => {
	const branch = [entry(user("a")), entry(claude()), entry(user("private")), entry(local())];
	assert.equal(planHandoff(input(branch, branch[2].id, { inputTokens: 39_000 })), undefined);
});

test("a session that was never on a cloud model is left to pi", () => {
	const branch = [entry(user("a")), entry(local()), entry(user("b")), entry(local())];
	assert.equal(planHandoff(input(branch, branch[2].id)), undefined);
});

test("when pi keeps the last cloud reply raw, the cloud model summarizes everything pi would summarize", () => {
	const branch = [
		entry(user("build the wizard")),
		entry(claude("toolUse")),
		entry(toolResult("file contents")),
		entry(claude()),
		entry(user("my diagnosis is ...")),
		entry(local()),
	];
	const plan = planHandoff(input(branch, branch[3].id));
	assert.ok(plan);
	assert.equal(`${plan.provider}/${plan.model}`, "anthropic/claude-sonnet-5");
	assert.deepEqual(plan.messages, [branch[0].message, branch[1].message, branch[2].message]);
	assert.equal(plan.firstKeptEntryId, branch[3].id);
});

test("when pi would summarize past the last cloud reply, the cut moves to just after it", () => {
	const branch = [
		entry(user("build the wizard")),
		entry(claude()),
		custom(),
		entry(user("my diagnosis is ...")),
		entry(local("toolUse")),
		entry(toolResult("private file")),
		entry(local()),
	];
	const plan = planHandoff(input(branch, branch[6].id));
	assert.ok(plan);
	assert.deepEqual(plan.messages, [branch[0].message, branch[1].message]);
	assert.equal(plan.firstKeptEntryId, branch[2].id);
});

test("a cloud reply that called tools stays raw so its tool results keep their call", () => {
	const branch = [
		entry(user("read the config")),
		entry(claude()),
		entry(user("now the secrets file")),
		entry(claude("toolUse")),
		entry(toolResult("API_KEY=...")),
		entry(local()),
	];
	const plan = planHandoff(input(branch, branch[5].id));
	assert.ok(plan);
	assert.deepEqual(plan.messages, [branch[0].message, branch[1].message, branch[2].message]);
	assert.equal(plan.firstKeptEntryId, branch[3].id);
});

test("a failed cloud reply is not proof that the content before it was received", () => {
	const branch = [
		entry(user("a")),
		entry(claude()),
		entry(user("b")),
		entry(claude("error")),
		entry(user("private")),
		entry(local()),
	];
	const plan = planHandoff(input(branch, branch[5].id));
	assert.ok(plan);
	assert.deepEqual(plan.messages, [branch[0].message, branch[1].message]);
	assert.equal(plan.firstKeptEntryId, branch[2].id);
});

test("a summary written after the last cloud reply never goes to the cloud", () => {
	const branch = [
		entry(user("a")),
		entry(claude()),
		entry(user("private")),
		compaction(),
		entry(local()),
		entry(user("more private")),
		entry(local()),
	];
	assert.equal(planHandoff(input(branch, branch[5].id, { previousSummary: "private summary" })), undefined);
});

test("a summary written before the last cloud reply goes along: that model already received it", () => {
	const branch = [compaction(), entry(user("a")), entry(claude()), entry(user("private")), entry(local())];
	const plan = planHandoff(input(branch, branch[4].id, { previousSummary: "earlier summary" }));
	assert.ok(plan);
	assert.equal(plan.previousSummary, "earlier summary");
	assert.deepEqual(plan.messages, [branch[1].message, branch[2].message]);
});

test("a copy pi makes of a reply with no content still anchors the cut", () => {
	const branch = [entry(user("a")), entry(claude()), entry(user("private")), entry(local())];
	// pi's projection replaces null content with [] in a copy; nothing new is in it.
	const copy = { ...(branch[1].message as HandoffMessage), content: [] };
	const plan = planHandoff({
		...input(branch, branch[3].id),
		toSummarize: [branch[0].message as HandoffMessage, copy, branch[2].message as HandoffMessage],
	});
	assert.ok(plan);
	assert.equal(plan.rewritten, false);
	assert.deepEqual(plan.messages, [branch[0].message, copy]);
	assert.equal(plan.firstKeptEntryId, branch[2].id);
});

const edit = (targetId: string, replacement: { content: string } | null): HandoffEntry => ({
	type: "context_edit",
	id: `e${ids++}`,
	targetId,
	replacement,
});

test("history rewritten after the last cloud reply is never sent", () => {
	const branch = [entry(user("a")), entry(claude()), entry(user("private")), entry(local())];
	branch.push(edit(branch[0].id, { content: "rewritten after the lock" }), entry(user("next")));
	const plan = planHandoff(input(branch, branch[5].id));
	assert.ok(plan);
	assert.equal(plan.rewritten, true);
});

test("an edit that only removes received history, or touches later history, does not block the handoff", () => {
	const branch = [entry(user("a")), entry(claude()), entry(user("private")), entry(local())];
	branch.push(edit(branch[0].id, null), edit(branch[3].id, { content: "trimmed local reply" }), entry(user("next")));
	const plan = planHandoff(input(branch, branch[6].id));
	assert.ok(plan);
	assert.equal(plan.rewritten, false);
});

test("a cloud reply cut off mid tool call stays raw so its failed tool results keep their call", () => {
	const branch = [
		entry(user("write the big file")),
		entry(claude()),
		entry(user("again")),
		entry({ ...claude("length"), content: [{ type: "toolCall", id: "t1", name: "write", arguments: {} }] }),
		entry(toolResult("Tool call failed: output truncated")),
		entry(user("private")),
		entry(local()),
	];
	const plan = planHandoff(input(branch, branch[6].id));
	assert.ok(plan);
	assert.deepEqual(plan.messages, [branch[0].message, branch[1].message, branch[2].message]);
	assert.equal(plan.firstKeptEntryId, branch[3].id);
});

test("the local budget leaves room for the summary and a margin for tokenizer error", () => {
	// 65536-token window, pi reserves 16384 and caps the summary at 0.8 of that (13107).
	assert.equal(localSummaryBudget(65_536, 16_384, 16_384), Math.floor(0.6 * (65_536 - 13_107)));
	// A model whose own output cap is lower than pi's summary cap.
	assert.equal(localSummaryBudget(65_536, 4_096, 16_384), Math.floor(0.6 * (65_536 - 4_096)));
});

test("input tokens count the messages and the previous summary at about four characters a token", () => {
	const messages = [user("x".repeat(400))];
	assert.ok(estimateInputTokens(messages, "y".repeat(400)) >= 200);
	assert.ok(estimateInputTokens(messages, undefined) < estimateInputTokens(messages, "y".repeat(400)));
});

test("the fallback note keeps the user's requests, oldest first, and no assistant text", () => {
	const note = handoffNote(
		[user("build the onboarding wizard"), claude(), user("x".repeat(1_000)), claude()],
		"anthropic/claude-sonnet-5",
		"no credentials",
	);
	assert.match(note, /anthropic\/claude-sonnet-5/);
	assert.match(note, /no credentials/);
	assert.match(note, /1\. build the onboarding wizard/);
	assert.ok(note.indexOf("build the onboarding wizard") < note.indexOf("xxxx"));
	assert.doesNotMatch(note, /reply from/);
	assert.ok(!note.includes("x".repeat(1_000)), "long requests are clipped");
});

test("file lists match pi's compaction format", () => {
	const lists = fileLists({
		read: new Set(["src/a.ts", "src/b.ts"]),
		written: new Set(["src/new.ts"]),
		edited: new Set(["src/b.ts"]),
	});
	assert.deepEqual(lists.readFiles, ["src/a.ts"]);
	assert.deepEqual(lists.modifiedFiles, ["src/b.ts", "src/new.ts"]);
	assert.equal(
		lists.text,
		"\n\n<read-files>\nsrc/a.ts\n</read-files>\n\n<modified-files>\nsrc/b.ts\nsrc/new.ts\n</modified-files>",
	);
});

test("leaving local goes back to the last cloud reply that ended its turn before the lock", () => {
	const branch = [
		entry(user("a")),
		entry(claude()),
		entry(user("b")),
		entry({ ...claude("toolUse"), content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] }),
		entry(toolResult("file")),
		entry(claude("error")),
		entry(user("my diagnosis is ...")),
		custom(),
		entry(local()),
	];
	assert.equal(rewindTarget(branch, 7, isCloud)?.id, branch[1].id);
});

test("a local reply is not a point the cloud has seen in full", () => {
	const branch = [
		entry(user("a")),
		entry(claude()),
		entry(user("b")),
		entry(local()),
		entry(user("private")),
		custom(),
	];
	assert.equal(rewindTarget(branch, 5, isCloud)?.id, branch[1].id);
});

test("a session that locked before any cloud reply has nowhere to go back to", () => {
	const branch = [entry(user("my diagnosis is ...")), custom(), entry(local())];
	assert.equal(rewindTarget(branch, 1, isCloud), undefined);
});

test("replies after the lock point are never targets", () => {
	const branch = [entry(user("a")), custom(), entry(claude())];
	assert.equal(rewindTarget(branch, 1, isCloud), undefined);
});
