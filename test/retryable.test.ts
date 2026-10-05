import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { decide, type PolicyConfig, RouterError, type Signals } from "../src/policy.ts";

// pi turns a routing refusal into an assistant error message and retries it automatically when the
// text matches pi-ai's transient-error pattern ("timed out", "500", "terminated", ...).

function refusal(overrides: Partial<Signals>, config: PolicyConfig = DEFAULT_CONFIG): string {
	const signals: Signals = {
		reason: "user",
		branchReadable: true,
		lockRequested: false,
		cwdSensitive: false,
		privateTag: false,
		failedIsQuota: false,
		availability: () => "ok",
		now: 0,
		category: { label: "general", p: 1 },
		...overrides,
	};
	try {
		decide(undefined, signals, config);
	} catch (error) {
		if (error instanceof RouterError) return error.message;
		throw error;
	}
	assert.fail(`no refusal for ${JSON.stringify(overrides)}`);
}

const port5000 = { ...DEFAULT_CONFIG, ollama: { ...DEFAULT_CONFIG.ollama, baseUrl: "http://localhost:5000" } };

test("privacy refusals are never retried by pi (texts come from decide(), so any wording change is re-checked)", () => {
	const reasons: Partial<Signals>[] = [
		{ reason: "user" },
		{ reason: "retry", previous: "anthropic/claude-sonnet-5" },
		{ reason: "retry", previous: "anthropic/claude-sonnet-5", failed: "anthropic/claude-sonnet-5" },
		{ reason: "direct", previous: "anthropic/claude-sonnet-5" },
		{ reason: "continuation", previous: "anthropic/claude-sonnet-5" },
	];
	const refusals = reasons.flatMap((reason) => [
		refusal({ ...reason, pii: "too-long", piiLength: 65_003 }),
		refusal({ ...reason, pii: "too-long", piiLength: 500_000 }),
		refusal({ ...reason, pii: "error" }, port5000),
	]);
	for (const text of refusals) {
		assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: text } as never), false, text);
	}
});
