import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CATEGORIES,
	isAcknowledgement,
	lastChars,
	MAX_CLASSIFY_CHARS,
	PII_LABELS,
	parseLabel,
	piiPrompt,
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
