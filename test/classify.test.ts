import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CATEGORIES,
	isAcknowledgement,
	lastChars,
	MAX_CLASSIFY_CHARS,
	MAX_PII_WINDOWS,
	PII_LABELS,
	parseLabel,
	piiPrompt,
	piiWindows,
} from "../src/classify.ts";
import { askOneWord } from "../src/ollama.ts";

test("parseLabel takes the first word and converts logprob to p", () => {
	assert.deepEqual(parseLabel("code", 0, CATEGORIES), { label: "code", p: 1 });
	assert.deepEqual(parseLabel(" Live\n", Math.log(0.5), CATEGORIES), { label: "live", p: 0.5 });
	assert.deepEqual(parseLabel("yes.", undefined, PII_LABELS), { label: "yes", p: 1 });
});

test("parseLabel rejects unknown output", () => {
	assert.equal(parseLabel("maybe", 0, PII_LABELS), undefined);
	assert.equal(parseLabel("", 0, CATEGORIES), undefined);
	assert.equal(parseLabel("coding", 0, CATEGORIES), undefined);
});

test("classifier input keeps the last MAX_CLASSIFY_CHARS characters", () => {
	const text = `${"a".repeat(10)}${"b".repeat(MAX_CLASSIFY_CHARS)}`;
	assert.equal(lastChars(text), "b".repeat(MAX_CLASSIFY_CHARS));
	assert.ok(piiPrompt(text).user.includes("b".repeat(MAX_CLASSIFY_CHARS)));
	assert.ok(!piiPrompt(text).user.includes("a"));
});

test("the classifier window fits the 4096-token context", () => {
	assert.equal(MAX_CLASSIFY_CHARS, 4000);
	assert.equal(MAX_PII_WINDOWS, 16);
});

test("piiWindows: short text is one window", () => {
	assert.deepEqual(piiWindows(""), [""]);
	assert.deepEqual(piiWindows("hello"), ["hello"]);
	const exact = "a".repeat(MAX_CLASSIFY_CHARS);
	assert.deepEqual(piiWindows(exact), [exact]);
});

test("piiWindows: covers the whole text with 200 characters of overlap", () => {
	const text = Array.from({ length: 10_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
	const windows = piiWindows(text);
	assert.equal(windows.length, 3);
	assert.ok(windows.every((w) => w.length <= MAX_CLASSIFY_CHARS));
	assert.equal(windows[0], text.slice(0, MAX_CLASSIFY_CHARS));
	assert.ok(text.endsWith(windows.at(-1) as string), "last window ends at the text end");
	for (let i = 1; i < windows.length; i++) {
		assert.equal(windows[i - 1].slice(-200), windows[i].slice(0, 200), `window ${i} overlaps by 200`);
	}
	// Rebuilding from the windows (dropping each overlap) gives the text back.
	const rebuilt = windows.map((w, i) => (i === 0 ? w : w.slice(200))).join("");
	assert.equal(rebuilt, text);
});

test("piiWindows: window count grows with length and hits the cap just past the limit", () => {
	const step = MAX_CLASSIFY_CHARS - 200;
	const atCap = MAX_CLASSIFY_CHARS + (MAX_PII_WINDOWS - 1) * step;
	assert.equal(piiWindows("a".repeat(atCap)).length, MAX_PII_WINDOWS);
	assert.equal(piiWindows("a".repeat(atCap + 1)).length, MAX_PII_WINDOWS + 1);
	assert.equal(piiWindows("a".repeat(MAX_CLASSIFY_CHARS + 1)).length, 2);
});

test("askOneWord sends a native /api/chat request with a 4k context and reads logprobs", async () => {
	let sent: { url: string; body: Record<string, unknown> } | undefined;
	const fakeFetch = (async (url: string, init: RequestInit) => {
		sent = { url, body: JSON.parse(String(init.body)) };
		return new Response(JSON.stringify({ message: { content: "live" }, logprobs: [{ token: "live", logprob: -0.1 }] }));
	}) as typeof fetch;
	const options = { baseUrl: "http://localhost:11434", model: "qwen3:8b", timeoutMs: 1000, keepAlive: "30m" };
	const result = await askOneWord(options, { system: "s", user: "u" }, undefined, fakeFetch);
	assert.deepEqual(result, { content: "live", logprob: -0.1 });
	assert.equal(sent?.url, "http://localhost:11434/api/chat");
	assert.equal(sent?.body.think, false);
	assert.deepEqual(sent?.body.options, { temperature: 0, num_predict: 2, num_ctx: 4096 });
});

test("askOneWord throws on HTTP errors and timeouts", async () => {
	const options = { baseUrl: "http://localhost:11434", model: "qwen3:8b", timeoutMs: 20, keepAlive: "30m" };
	const failing = (async () => new Response("model not found", { status: 404 })) as typeof fetch;
	await assert.rejects(askOneWord(options, { system: "s", user: "u" }, undefined, failing), /ollama 404/);
	const hanging = ((_url: string, init: RequestInit) =>
		new Promise((_resolve, reject) => {
			init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
		})) as typeof fetch;
	await assert.rejects(askOneWord(options, { system: "s", user: "u" }, undefined, hanging));
});

test("isAcknowledgement: bare nudges with no new task", () => {
	for (const text of [
		"ok, continue",
		"thanks, that worked",
		"go on",
		"Keep going!",
		"yes please",
		"sounds good",
		"ok",
	]) {
		assert.equal(isAcknowledgement(text), true, text);
	}
	for (const text of [
		"ok, now refactor the auth module",
		"continue the migration plan for the Go service",
		"thanks, now check the weather in Chicago",
		"",
	]) {
		assert.equal(isAcknowledgement(text), false, text);
	}
});
