import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	chooseLane,
	decide,
	isQuotaError,
	needsClassification,
	planQuotaFailover,
	RouterError,
	type Signals,
} from "../src/policy.ts";
import type { RouterState } from "../src/state.ts";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const config = DEFAULT_CONFIG;

function signals(overrides: Partial<Signals> = {}): Signals {
	return {
		reason: "user",
		branchReadable: true,
		lockRequested: false,
		cwdSensitive: false,
		privateTag: false,
		hasPrevious: false,
		hasFailed: false,
		failedIsQuota: false,
		disabled: [],
		now: NOW,
		pii: "no",
		category: { label: "general", p: 1 },
		...overrides,
	};
}

const onClaude: RouterState = { lane: "claude", locked: false };
const locked: RouterState = { lane: "local", locked: true, lockReason: "pii", lockDetail: "x" };

test("a locked state routes local for every reason, and a pin cannot override it", () => {
	for (const reason of ["user", "continuation", "retry", "direct"] as const) {
		const d = decide(locked, signals({ reason, hasPrevious: true, pin: { lane: "gpt" }, pinName: "gpt" }), config);
		assert.deepEqual(d.target, { kind: "lane", lane: "local" }, reason);
		assert.equal(d.state, undefined, reason);
	}
});

test("deterministic locks, in precedence order", () => {
	const cases: Array<[Partial<Signals>, string]> = [
		[{ lockRequested: true, secret: "x" }, "command"],
		[{ cwdSensitive: true }, "cwd"],
		[{ privateTag: true }, "tag"],
		[{ pathMention: "~/private-docs/w2.pdf" }, "path"],
		[{ secret: "github-token in tool result", reason: "continuation", hasPrevious: true }, "secret"],
	];
	for (const [overrides, reason] of cases) {
		const d = decide(onClaude, signals(overrides), config);
		assert.deepEqual(d.target, { kind: "lane", lane: "local" });
		assert.equal(d.state?.locked, true);
		assert.equal(d.state?.lockReason, reason);
	}
});

test("a secret in a tool result locks a continuation (egress backstop)", () => {
	const d = decide(
		onClaude,
		signals({ reason: "continuation", hasPrevious: true, secret: "jwt in tool result" }),
		config,
	);
	assert.deepEqual(d.target, { kind: "lane", lane: "local" });
	assert.equal(d.state?.lockDetail, "jwt in tool result");
});

test("PII yes locks at any probability", () => {
	const d = decide(onClaude, signals({ pii: "yes", category: { label: "code", p: 0.01 } }), config);
	assert.equal(d.state?.lockReason, "pii");
});

test("PII check failure: block throws, warn proceeds with a notice", () => {
	assert.throws(() => decide(onClaude, signals({ pii: "error" }), config), RouterError);
	const d = decide(onClaude, signals({ pii: "error" }), { ...config, onPrivacyCheckFailure: "warn" });
	assert.deepEqual(d.target, { kind: "lane", lane: "claude" });
	assert.match(d.notice ?? "", /privacy check unavailable/);
});

test("category routing: code → claude, live → gpt, general stays", () => {
	assert.deepEqual(decide(onClaude, signals({ category: { label: "live", p: 1 } }), config).target, {
		kind: "lane",
		lane: "gpt",
	});
	const onGpt: RouterState = { lane: "gpt", locked: false };
	assert.deepEqual(decide(onGpt, signals({ category: { label: "code", p: 1 } }), config).target, {
		kind: "lane",
		lane: "claude",
	});
	assert.deepEqual(decide(onGpt, signals({ category: { label: "general", p: 1 } }), config).target, {
		kind: "lane",
		lane: "gpt",
	});
});

test("state is only rewritten when the lane changes", () => {
	assert.equal(decide(onClaude, signals({ category: { label: "code", p: 1 } }), config).state, undefined);
	assert.deepEqual(decide(onClaude, signals({ category: { label: "live", p: 1 } }), config).state, {
		lane: "gpt",
		locked: false,
	});
});

test("classifier failure stays on the current lane with a notice", () => {
	const d = decide({ lane: "gpt", locked: false }, signals({ category: "error" }), config);
	assert.deepEqual(d.target, { kind: "lane", lane: "gpt" });
	assert.equal(d.why, "classifier down");
});

test("pin overrides the category and can swap the model", () => {
	const d = decide(
		onClaude,
		signals({
			category: { label: "live", p: 1 },
			pin: { lane: "claude", model: "anthropic/claude-opus-5" },
			pinName: "claude-max",
		}),
		config,
	);
	assert.deepEqual(d.target, { kind: "ref", ref: "anthropic/claude-opus-5", lane: "claude" });
	assert.equal(d.why, "pin:claude-max");
});

test("continuation and direct reuse the previous model", () => {
	for (const reason of ["continuation", "direct"] as const) {
		assert.deepEqual(decide(onClaude, signals({ reason, hasPrevious: true }), config).target, { kind: "previous" });
	}
	assert.deepEqual(decide(undefined, signals({ reason: "direct" }), config).target, { kind: "lane", lane: "claude" });
});

test("an unreadable branch routes local without persisting a lock", () => {
	const d = decide(onClaude, signals({ branchReadable: false }), config);
	assert.deepEqual(d.target, { kind: "lane", lane: "local" });
	assert.equal(d.state, undefined);
});

test("quota failover goes cloud to cloud with a cooldown", () => {
	const d = decide(
		onClaude,
		signals({ reason: "retry", hasPrevious: true, hasFailed: true, failedLane: "claude", failedIsQuota: true }),
		config,
	);
	assert.deepEqual(d.target, { kind: "lane", lane: "gpt" });
	assert.equal(d.state?.cooldowns?.claude, new Date(NOW + 60 * 60_000).toISOString());
});

test("non-quota retries and retries without a failover lane stay on the failed model", () => {
	const base = { reason: "retry" as const, hasPrevious: true, hasFailed: true, failedLane: "claude" as const };
	assert.deepEqual(decide(onClaude, signals(base), config).target, { kind: "failed" });
	assert.deepEqual(decide(onClaude, signals({ ...base, failedIsQuota: true, disabled: ["gpt"] }), config).target, {
		kind: "failed",
	});
});

test("a lane in cooldown is skipped by category routing", () => {
	const cooling: RouterState = {
		lane: "gpt",
		locked: false,
		cooldowns: { claude: new Date(NOW + 60_000).toISOString() },
	};
	assert.deepEqual(decide(cooling, signals({ category: { label: "code", p: 1 } }), config).target, {
		kind: "lane",
		lane: "gpt",
	});
	const expired: RouterState = { ...cooling, cooldowns: { claude: new Date(NOW - 1).toISOString() } };
	assert.deepEqual(decide(expired, signals({ category: { label: "code", p: 1 } }), config).target, {
		kind: "lane",
		lane: "claude",
	});
});

test("routing to a disabled lane is an error, never a silent substitute", () => {
	assert.throws(() => decide(undefined, signals({ disabled: ["claude"] }), config), RouterError);
	assert.throws(
		() => decide(undefined, signals({ disabled: ["claude"] }), config),
		/lanes\.claude.*privacy-router\.json/,
	);
});

test("chooseLane hysteresis (spec §5.1)", () => {
	const none = new Set<"claude" | "gpt">();
	const base = { current: undefined, previous: undefined, p: 1, unavailable: none };
	assert.equal(chooseLane({ ...base, category: "general" }, config), "claude");
	assert.equal(chooseLane({ ...base, category: "general", previous: "gpt" }, config), "gpt");
	assert.equal(chooseLane({ ...base, category: "general", current: "gpt", previous: "claude" }, config), "gpt");
	assert.equal(chooseLane({ ...base, category: "live", current: "claude" }, config), "gpt");
	assert.equal(chooseLane({ ...base, category: "live", current: "claude", p: 0.59 }, config), "claude");
	assert.equal(chooseLane({ ...base, category: "code", current: "gpt" }, config), "claude");
	assert.equal(
		chooseLane({ ...base, category: "code", current: "gpt", unavailable: new Set(["claude"]) }, config),
		"gpt",
	);
});

test("needsClassification only for clean user turns", () => {
	assert.equal(needsClassification(onClaude, signals()), true);
	assert.equal(needsClassification(onClaude, signals({ reason: "continuation" })), false);
	assert.equal(needsClassification(locked, signals()), false);
	assert.equal(needsClassification(onClaude, signals({ secret: "x" })), false);
	assert.equal(needsClassification(onClaude, signals({ pathMention: "~/x" })), false);
});

test("isQuotaError", () => {
	assert.equal(isQuotaError("You have reached your usage limit"), true);
	assert.equal(isQuotaError("Claude AI usage limit reached|1759450000"), true);
	assert.equal(isQuotaError("rate_limit_error: quota exceeded"), true);
	assert.equal(
		isQuotaError(
			`400 {"type":"error","error":{"type":"invalid_request_error","message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."}}`,
		),
		true,
	);
	// Review M5: transient throttling is retried by pi, not a reason to switch lanes for an hour.
	assert.equal(isQuotaError("429 Too Many Requests"), false);
	assert.equal(isQuotaError("rate_limit_error: Number of requests exceeds your per-minute rate limit"), false);
	assert.equal(isQuotaError("529 overloaded_error"), false);
	assert.equal(isQuotaError("context length exceeded"), false);
});

test("a lock notice names the reason and warns that the local model may be loading", () => {
	const d = decide(onClaude, signals({ privateTag: true }), config);
	assert.match(d.notice ?? "", /^🔒 locked · tag · #private · loading local model/);
});

test("review M6: a pin pauses while its lane is in quota cooldown", () => {
	const afterFailover: RouterState = {
		lane: "gpt",
		locked: false,
		cooldowns: { claude: new Date(NOW + 30 * 60_000).toISOString() },
	};
	const d = decide(
		afterFailover,
		signals({
			category: { label: "code", p: 1 },
			pin: { lane: "claude", model: "anthropic/claude-opus-5" },
			pinName: "claude-max",
		}),
		config,
	);
	assert.deepEqual(d.target, { kind: "lane", lane: "gpt" });
	assert.match(d.notice ?? "", /claude-max.*paused/);
});

test("a current lane in cooldown gives way to the other lane, even for general messages", () => {
	const soon = new Date(NOW + 60_000).toISOString();
	const cooling: RouterState = { lane: "claude", locked: false, cooldowns: { claude: soon } };
	for (const label of ["general", "code"] as const) {
		const d = decide(cooling, signals({ category: { label, p: 1 } }), config);
		assert.deepEqual(d.target, { kind: "lane", lane: "gpt" }, label);
		assert.equal(d.state?.lane, "gpt", label);
	}
	assert.deepEqual(decide(cooling, signals({ category: "error" }), config).target, { kind: "lane", lane: "gpt" });
	// Both lanes exhausted: nothing better than the current lane.
	const both: RouterState = { ...cooling, cooldowns: { claude: soon, gpt: soon } };
	assert.deepEqual(decide(both, signals({ category: { label: "code", p: 1 } }), config).target, {
		kind: "lane",
		lane: "claude",
	});
});

test("a continuation whose previous lane is cooling down moves to the other lane", () => {
	const cooling: RouterState = {
		lane: "claude",
		locked: false,
		cooldowns: { claude: new Date(NOW + 60_000).toISOString() },
	};
	const d = decide(cooling, signals({ reason: "continuation", hasPrevious: true, previousLane: "claude" }), config);
	assert.deepEqual(d.target, { kind: "lane", lane: "gpt" });
	assert.equal(d.state?.lane, "gpt");
	assert.equal(d.state?.cooldowns?.claude, cooling.cooldowns?.claude);
	// Without a cooldown, a continuation stays on the model that is mid-turn.
	assert.deepEqual(
		decide(onClaude, signals({ reason: "continuation", hasPrevious: true, previousLane: "claude" }), config).target,
		{ kind: "previous" },
	);
});

test("planQuotaFailover: a usage-limit error on one cloud lane fails over to the other for the cooldown", () => {
	const failure = {
		lane: "claude" as const,
		message: "You're out of extra usage. Add more at claude.ai/settings/usage",
	};
	const base = { state: onClaude, disabled: [] as ("claude" | "gpt")[], now: NOW };
	assert.deepEqual(planQuotaFailover({ ...base, failure }, config), {
		from: "claude",
		to: "gpt",
		until: new Date(NOW + 60 * 60_000).toISOString(),
	});
	assert.equal(
		planQuotaFailover({ ...base, failure: { ...failure, message: "500 internal error" } }, config),
		undefined,
	);
	assert.equal(planQuotaFailover({ ...base, failure: { ...failure, lane: "local" } }, config), undefined);
	assert.equal(planQuotaFailover({ ...base, failure, disabled: ["gpt"] }, config), undefined);
	// Both lanes exhausted: stop instead of bouncing between them.
	const gptCooling: RouterState = { ...onClaude, cooldowns: { gpt: new Date(NOW + 60_000).toISOString() } };
	assert.equal(planQuotaFailover({ ...base, state: gptCooling, failure }, config), undefined);
});
