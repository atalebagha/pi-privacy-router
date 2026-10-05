import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	decide,
	isQuotaError,
	needsClassification,
	planQuotaFailover,
	RouterError,
	type Signals,
} from "../src/policy.ts";
import type { Availability, RoutedState } from "../src/routes.ts";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const SOON = new Date(NOW + 30 * 60_000).toISOString();
const HOUR = new Date(NOW + 60 * 60_000).toISOString();
const SONNET = "anthropic/claude-sonnet-5";
const OPUS = "anthropic/claude-opus-5";
const GPT = "openai-codex/gpt-6-sol";
const GEMINI = "google/gemini-3-pro";
const config = DEFAULT_CONFIG;
const threeProviders = {
	...DEFAULT_CONFIG,
	routes: { code: [SONNET, GEMINI, GPT], live: [GPT, GEMINI], general: "stay" as const },
};

function signals(overrides: Partial<Signals> = {}, unavailable: Record<string, Availability> = {}): Signals {
	return {
		reason: "user",
		branchReadable: true,
		lockRequested: false,
		cwdSensitive: false,
		privateTag: false,
		failedIsQuota: false,
		availability: (ref) => unavailable[ref] ?? "ok",
		now: NOW,
		pii: "no",
		category: { label: "general", p: 1 },
		...overrides,
	};
}

const onSonnet: RoutedState = { model: SONNET, route: "code", locked: false };
const onGpt: RoutedState = { model: GPT, route: "live", locked: false };
const locked: RoutedState = { locked: true, lockReason: "pii", lockDetail: "x", lane: "local" };
const model = (ref: string) => ({ kind: "model", ref });

test("a locked state routes to the private model for every reason, and a pin cannot override it", () => {
	for (const reason of ["user", "continuation", "retry", "direct"] as const) {
		const d = decide(locked, signals({ reason, previous: SONNET, pin: GPT, pinName: "gpt" }), config);
		assert.deepEqual(d.target, { kind: "private" }, reason);
		assert.equal(d.state, undefined, reason);
	}
});

test("deterministic locks, in precedence order", () => {
	const cases: Array<[Partial<Signals>, string]> = [
		[{ lockRequested: true, secret: "x" }, "command"],
		[{ cwdSensitive: true }, "cwd"],
		[{ privateTag: true }, "tag"],
		[{ pathMention: "~/private-docs/w2.pdf" }, "path"],
		[{ secret: "github-token in tool result", reason: "continuation", previous: SONNET }, "secret"],
	];
	for (const [overrides, reason] of cases) {
		const d = decide(onSonnet, signals(overrides), config);
		assert.deepEqual(d.target, { kind: "private" });
		assert.equal(d.state?.locked, true);
		assert.equal(d.state?.lockReason, reason);
	}
});

test("a lock decision's state passes 0.1's state check, so a downgrade keeps the lock", () => {
	const state = decide(onSonnet, signals({ privateTag: true }), config).state;
	// 0.1's isRouterState: typeof lane === "string" && typeof locked === "boolean".
	assert.equal(typeof state?.lane === "string" && typeof state.locked === "boolean", true);
	assert.equal(state?.lane, "local");
});

test("a secret in a tool result locks a continuation (egress backstop)", () => {
	const d = decide(
		onSonnet,
		signals({ reason: "continuation", previous: SONNET, secret: "jwt in tool result" }),
		config,
	);
	assert.deepEqual(d.target, { kind: "private" });
	assert.equal(d.state?.lockDetail, "jwt in tool result");
});

test("PII yes locks at any probability", () => {
	const d = decide(onSonnet, signals({ pii: "yes", category: { label: "code", p: 0.01 } }), config);
	assert.equal(d.state?.lockReason, "pii");
});

test("PII check failure: block throws, warn proceeds with a notice", () => {
	assert.throws(() => decide(onSonnet, signals({ pii: "error" }), config), RouterError);
	const d = decide(onSonnet, signals({ pii: "error" }), { ...config, onPrivacyCheckFailure: "warn" });
	assert.deepEqual(d.target, model(SONNET));
	assert.match(d.notice ?? "", /privacy check unavailable/);
});

test("category routing: code and live take the first usable entry of their list; general stays", () => {
	assert.deepEqual(decide(onSonnet, signals({ category: { label: "live", p: 1 } }), config).target, model(GPT));
	assert.deepEqual(decide(onGpt, signals({ category: { label: "code", p: 1 } }), config).target, model(SONNET));
	assert.deepEqual(decide(onGpt, signals({ category: { label: "general", p: 1 } }), config).target, model(GPT));
});

test("state is rewritten only when the model or route changes", () => {
	assert.equal(decide(onSonnet, signals({ category: { label: "code", p: 1 } }), config).state, undefined);
	assert.deepEqual(decide(onSonnet, signals({ category: { label: "live", p: 1 } }), config).state, {
		model: GPT,
		route: "live",
		locked: false,
	});
});

test("a low-confidence label stays on the current model", () => {
	const d = decide(onGpt, signals({ category: { label: "code", p: 0.3 } }), config);
	assert.deepEqual(d.target, model(GPT));
	assert.equal(d.state, undefined);
});

test("classifier failure stays on the current model with a notice", () => {
	const d = decide(onGpt, signals({ category: "error" }), config);
	assert.deepEqual(d.target, model(GPT));
	assert.equal(d.why, "classifier down");
	assert.match(d.notice ?? "", /classifier down/);
});

test("a three-provider list skips a cooling provider and reports why", () => {
	const cooling: RoutedState = { ...onSonnet, cooldowns: { anthropic: SOON } };
	const d = decide(cooling, signals({ category: { label: "code", p: 1 } }), threeProviders);
	assert.deepEqual(d.target, model(GEMINI));
	assert.deepEqual(d.skipped, [{ ref: SONNET, reason: "cooling", until: SOON }]);
	assert.equal(d.state?.cooldowns?.anthropic, SOON);
});

test("one provider cooldown covers every model of that account", () => {
	const sameAccount = { ...DEFAULT_CONFIG, routes: { ...DEFAULT_CONFIG.routes, code: [SONNET, OPUS, GPT] } };
	const cooling: RoutedState = { ...onGpt, cooldowns: { anthropic: SOON } };
	const d = decide(cooling, signals({ category: { label: "code", p: 1 } }), sameAccount);
	assert.deepEqual(d.target, model(GPT));
	assert.deepEqual(
		d.skipped?.map((entry) => entry.ref),
		[SONNET, OPUS],
	);
});

test("a model without credentials is skipped and reported", () => {
	const d = decide(onGpt, signals({ category: { label: "code", p: 1 } }, { [SONNET]: "no-credentials" }), config);
	assert.deepEqual(d.target, model(GPT));
	assert.deepEqual(d.skipped, [{ ref: SONNET, reason: "no-credentials" }]);
});

test("general as a list routes confident general messages; low confidence still stays", () => {
	const generalList = { ...DEFAULT_CONFIG, routes: { ...DEFAULT_CONFIG.routes, general: [GEMINI] } };
	const confident = decide(onGpt, signals({ category: { label: "general", p: 0.9 } }), generalList);
	assert.deepEqual(confident.target, model(GEMINI));
	assert.equal(confident.state?.route, "general");
	assert.deepEqual(decide(onGpt, signals({ category: { label: "general", p: 0.3 } }), generalList).target, model(GPT));
});

test("nothing usable refuses with every skipped model and why, never the private model", () => {
	const cooling: RoutedState = { ...onSonnet, cooldowns: { anthropic: SOON } };
	assert.throws(
		() => decide(cooling, signals({ category: { label: "code", p: 1 } }, { [GPT]: "no-credentials" }), config),
		(error: unknown) =>
			error instanceof RouterError &&
			/No usable model for code: anthropic\/claude-sonnet-5 \(cooling until \d\d:\d\d\), openai-codex\/gpt-6-sol \(no credentials\)/.test(
				error.message,
			),
	);
});

test("staying on the current model refuses when it and the whole fallback chain are unusable", () => {
	const allCooling: RoutedState = { ...onSonnet, cooldowns: { anthropic: SOON, "openai-codex": SOON } };
	assert.throws(
		() => decide(allCooling, signals({ category: { label: "general", p: 1 } }), config),
		(error: unknown) => error instanceof RouterError && /^No usable model for general: /.test(error.message),
	);
});

test("a continuation refuses when its provider and the rest of its route list are unusable", () => {
	const allCooling: RoutedState = { ...onSonnet, cooldowns: { anthropic: SOON, "openai-codex": SOON } };
	assert.throws(
		() => decide(allCooling, signals({ reason: "continuation", previous: SONNET }), config),
		(error: unknown) => error instanceof RouterError && /^No usable model for continuation: /.test(error.message),
	);
});

test("staying on a model whose provider is cooling falls back to the chain", () => {
	const cooling: RoutedState = { ...onGpt, cooldowns: { "openai-codex": SOON } };
	const d = decide(cooling, signals({ category: { label: "general", p: 1 } }), config);
	assert.deepEqual(d.target, model(SONNET));
	assert.equal(d.state?.route, "default");
});

test("with no state, the first message uses defaultModel", () => {
	const d = decide(undefined, signals({ category: { label: "general", p: 1 } }), config);
	assert.deepEqual(d.target, model(SONNET));
	assert.deepEqual(d.state, { model: SONNET, route: "default", locked: false });
});

test("a pin overrides the category", () => {
	const d = decide(onSonnet, signals({ category: { label: "live", p: 1 }, pin: OPUS, pinName: "claude-max" }), config);
	assert.deepEqual(d.target, model(OPUS));
	assert.equal(d.why, "pin:claude-max");
	assert.equal(d.state?.route, "pin");
});

test("a pin pauses while its provider cools down, then normal routing applies", () => {
	const cooling: RoutedState = { ...onGpt, cooldowns: { anthropic: SOON } };
	const d = decide(cooling, signals({ category: { label: "code", p: 1 }, pin: OPUS, pinName: "claude-max" }), config);
	assert.deepEqual(d.target, model(GPT));
	assert.match(d.notice ?? "", /claude-max paused: anthropic is cooling down/);
});

test("a pinned model without credentials refuses instead of falling through", () => {
	assert.throws(
		() => decide(onSonnet, signals({ pin: OPUS, pinName: "claude-max" }, { [OPUS]: "no-credentials" }), config),
		/Pinned model anthropic\/claude-opus-5 has no credentials/,
	);
});

test("continuation and direct reuse the model mid-turn", () => {
	for (const reason of ["continuation", "direct"] as const) {
		assert.deepEqual(decide(onSonnet, signals({ reason, previous: SONNET }), config).target, { kind: "previous" });
	}
	assert.deepEqual(decide(undefined, signals({ reason: "direct" }), config).target, model(SONNET));
});

test("a continuation whose provider is cooling continues down the saved route's list", () => {
	const cooling: RoutedState = { ...onSonnet, cooldowns: { anthropic: SOON } };
	const d = decide(cooling, signals({ reason: "continuation", previous: SONNET }), config);
	assert.deepEqual(d.target, model(GPT));
	assert.match(d.why, /anthropic cooling down/);
	assert.equal(d.state?.model, GPT);
	assert.equal(d.state?.cooldowns?.anthropic, SOON);
});

test("an unreadable branch routes to the private model without persisting a lock", () => {
	const d = decide(onSonnet, signals({ branchReadable: false }), config);
	assert.deepEqual(d.target, { kind: "private" });
	assert.equal(d.state, undefined);
});

test("a usage-limit retry cools the provider and moves to the next usable model", () => {
	const d = decide(
		onSonnet,
		signals({ reason: "retry", previous: SONNET, failed: SONNET, failedIsQuota: true }),
		config,
	);
	assert.deepEqual(d.target, model(GPT));
	assert.equal(d.state?.cooldowns?.anthropic, HOUR);
	assert.match(d.notice ?? "", /anthropic usage limit reached; using openai-codex\/gpt-6-sol for 60 min/);
});

test("other retries, and usage-limit retries with nowhere to go, stay on the failed model", () => {
	const base = { reason: "retry" as const, previous: SONNET, failed: SONNET };
	assert.deepEqual(decide(onSonnet, signals(base), config).target, { kind: "failed" });
	assert.deepEqual(
		decide(onSonnet, signals({ ...base, failedIsQuota: true }, { [GPT]: "no-credentials" }), config).target,
		{ kind: "failed" },
	);
});

test("needsClassification only for clean user turns", () => {
	assert.equal(needsClassification(onSonnet, signals()), true);
	assert.equal(needsClassification(onSonnet, signals({ reason: "continuation" })), false);
	assert.equal(needsClassification(locked, signals()), false);
	assert.equal(needsClassification(onSonnet, signals({ secret: "x" })), false);
	assert.equal(needsClassification(onSonnet, signals({ pathMention: "~/x" })), false);
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
	assert.equal(isQuotaError("429 Too Many Requests"), false);
	assert.equal(isQuotaError("rate_limit_error: Number of requests exceeds your per-minute rate limit"), false);
	assert.equal(isQuotaError("529 overloaded_error"), false);
	assert.equal(isQuotaError("context length exceeded"), false);
});

test("a lock notice names the reason and warns that the local model may be loading", () => {
	const d = decide(onSonnet, signals({ privateTag: true }), config);
	assert.match(d.notice ?? "", /^🔒 locked · tag · #private · loading local model/);
});

test("planQuotaFailover: cool the failed provider and continue only if a usable model remains", () => {
	const base = {
		state: onSonnet,
		failed: SONNET,
		message: "You're out of extra usage. Add more at claude.ai/settings/usage",
		availability: (): Availability => "ok",
		now: NOW,
	};
	assert.deepEqual(planQuotaFailover(base, config), { provider: "anthropic", until: HOUR, to: GPT });
	assert.equal(planQuotaFailover({ ...base, message: "500 internal error" }, config), undefined);
	const gptCooling: RoutedState = { ...onSonnet, cooldowns: { "openai-codex": SOON } };
	assert.equal(planQuotaFailover({ ...base, state: gptCooling }, config), undefined);
	const withoutGoogle = (ref: string): Availability => (ref === GEMINI ? "no-credentials" : "ok");
	assert.deepEqual(planQuotaFailover({ ...base, availability: withoutGoogle }, threeProviders), {
		provider: "anthropic",
		until: HOUR,
		to: GPT,
	});
});

test("a zero cooldown never fails over to the failed provider itself", () => {
	const zero = { ...config, quotaCooldownMinutes: 0 };
	const base = {
		state: onGpt,
		failed: GPT,
		message: "You have reached your usage limit",
		availability: (): Availability => "ok",
		now: NOW,
	};
	const onlyGpt = (ref: string): Availability => (ref === GPT ? "ok" : "no-credentials");
	assert.equal(planQuotaFailover({ ...base, availability: onlyGpt }, zero), undefined);
	// On the code route Sonnet comes first, so it is the other provider's usable model.
	assert.deepEqual(planQuotaFailover({ ...base, state: onSonnet }, zero), {
		provider: "openai-codex",
		until: new Date(NOW).toISOString(),
		to: SONNET,
	});

	const retry = decide(
		onGpt,
		signals({ reason: "retry", failed: GPT, failedIsQuota: true }, { [SONNET]: "no-credentials" }),
		zero,
	);
	assert.deepEqual(retry.target, { kind: "failed" });
	assert.equal(retry.why, "retry (no failover model)");
});

// Batch D: retries can carry queued steering messages, summaries (direct) can carry text a refused turn
// left behind, and continuations can carry text an extension added, so all three get the privacy check
// on the text since the last cloud reply.
const warn = { ...config, onPrivacyCheckFailure: "warn" as const };
const midTurn = [
	["retry", { reason: "retry", previous: SONNET, failed: SONNET }],
	["direct", { reason: "direct", previous: SONNET }],
	["continuation", { reason: "continuation", previous: SONNET }],
] as const;

function refusalOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof RouterError) return error.message;
		throw error;
	}
	assert.fail("no refusal");
}

test("retry, direct and continuation requests lock on personal information, like user turns", () => {
	for (const [name, base] of midTurn) {
		const d = decide(onSonnet, signals({ ...base, pii: "yes" }), config);
		assert.deepEqual(d.target, { kind: "private" }, name);
		assert.equal(d.state?.locked, true, name);
		assert.equal(d.state?.lockReason, "pii", name);
	}
});

test("retry, direct and continuation requests whose text could not be checked are refused in block mode, as user turns are", () => {
	for (const [name, base] of midTurn) {
		for (const pii of ["error", "too-long"] as const) {
			const userRefusal = refusalOf(() => decide(onSonnet, signals({ pii }), config));
			assert.equal(
				refusalOf(() => decide(onSonnet, signals({ ...base, pii }), config)),
				userRefusal,
				`${name} ${pii}`,
			);
		}
	}
});

test("retry, direct and continuation requests whose text could not be checked route on with the user turn's notice in warn mode", () => {
	for (const [name, base] of midTurn) {
		for (const pii of ["error", "too-long"] as const) {
			const userNotice = decide(onSonnet, signals({ pii }), warn).notice;
			assert.ok(userNotice?.startsWith("⚠"), pii);
			const d = decide(onSonnet, signals({ ...base, pii }), warn);
			assert.deepEqual(d.target, decide(onSonnet, signals({ ...base, pii: undefined }), warn).target, `${name} ${pii}`);
			assert.equal(d.notice, userNotice, `${name} ${pii}`);
		}
	}
	const failover = decide(onSonnet, signals({ ...midTurn[0][1], failedIsQuota: true, pii: "error" }), warn);
	assert.deepEqual(failover.target, model(GPT));
	assert.match(failover.notice ?? "", /^⚠ privacy check unavailable; deterministic checks only; anthropic usage limit/);
});

test("a clean or absent privacy check leaves retry, direct and continuation routing as it was, quota failover included", () => {
	for (const pii of ["no", undefined] as const) {
		const failover = decide(onSonnet, signals({ ...midTurn[0][1], failedIsQuota: true, pii }), config);
		assert.deepEqual(failover.target, model(GPT));
		assert.equal(failover.state?.cooldowns?.anthropic, HOUR);
		assert.deepEqual(decide(onSonnet, signals({ ...midTurn[0][1], pii }), config).target, { kind: "failed" });
		assert.deepEqual(decide(onSonnet, signals({ ...midTurn[1][1], pii }), config).target, { kind: "previous" });
		assert.equal(decide(onSonnet, signals({ ...midTurn[1][1], pii }), config).notice, undefined);
		assert.deepEqual(decide(onSonnet, signals({ ...midTurn[2][1], pii }), config).target, { kind: "previous" });
	}
});
