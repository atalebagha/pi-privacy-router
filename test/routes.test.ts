import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Availability,
	describeSkipped,
	fallbackChain,
	firstUsable,
	isUsable,
	legacyLaneModel,
	providerOf,
	type RoutesConfig,
	routeList,
	upgradeState,
	type Usability,
} from "../src/routes.ts";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const SOON = new Date(NOW + 30 * 60_000).toISOString();
const PAST = new Date(NOW - 60_000).toISOString();
const SONNET = "anthropic/claude-sonnet-5";
const OPUS = "anthropic/claude-opus-5";
const GPT = "openai-codex/gpt-6-sol";
const GEMINI = "google/gemini-3-pro";
const config: RoutesConfig = {
	routes: { code: [SONNET, GPT], live: [GPT, SONNET], general: "stay" },
	defaultModel: SONNET,
};

function usability(unavailable: Record<string, Availability> = {}, cooldowns?: Record<string, string>): Usability {
	return { availability: (ref) => unavailable[ref] ?? "ok", cooldowns, now: NOW };
}

test("providerOf is the text before the first slash", () => {
	assert.equal(providerOf(SONNET), "anthropic");
	assert.equal(providerOf("openrouter/anthropic/claude-x"), "openrouter");
});

test("firstUsable returns the first usable entry and why each earlier one was skipped", () => {
	const result = firstUsable(
		[SONNET, OPUS, GEMINI, GPT],
		usability({ [GEMINI]: "no-credentials" }, { anthropic: SOON }),
	);
	assert.equal(result.ref, GPT);
	assert.deepEqual(result.skipped, [
		{ ref: SONNET, reason: "cooling", until: SOON },
		{ ref: OPUS, reason: "cooling", until: SOON },
		{ ref: GEMINI, reason: "no-credentials" },
	]);
	assert.deepEqual(firstUsable([SONNET], usability({ [SONNET]: "missing" })), {
		skipped: [{ ref: SONNET, reason: "missing" }],
	});
});

test("a cooldown that has ended no longer skips its provider", () => {
	assert.equal(isUsable(SONNET, usability({}, { anthropic: PAST })), true);
	assert.equal(isUsable(SONNET, usability({}, { anthropic: SOON })), false);
});

test("fallbackChain is defaultModel, then code, then live, without repeats", () => {
	assert.deepEqual(fallbackChain(config), [SONNET, GPT]);
	assert.deepEqual(fallbackChain({ ...config, defaultModel: GEMINI }), [GEMINI, SONNET, GPT]);
});

test("routeList continues down the route's own list, else the fallback chain", () => {
	assert.deepEqual(routeList("live", config), [GPT, SONNET]);
	assert.deepEqual(routeList("general", config), [SONNET, GPT]);
	assert.deepEqual(routeList("general", { ...config, routes: { ...config.routes, general: [GEMINI] } }), [GEMINI]);
	assert.deepEqual(routeList("pin", config), [SONNET, GPT]);
	assert.deepEqual(routeList(undefined, config), [SONNET, GPT]);
});

test("describeSkipped names each model and why", () => {
	const text = describeSkipped([
		{ ref: SONNET, reason: "no-credentials" },
		{ ref: GEMINI, reason: "missing" },
		{ ref: GPT, reason: "cooling", until: SOON },
	]);
	assert.match(
		text,
		/^anthropic\/claude-sonnet-5 \(no credentials\), google\/gemini-3-pro \(not in pi's catalog\), openai-codex\/gpt-6-sol \(cooling until \d\d:\d\d\)$/,
	);
});

test("0.1 lane names map to the models 0.1 used", () => {
	assert.equal(legacyLaneModel("claude", config), SONNET);
	assert.equal(legacyLaneModel("gpt", config), GPT);
});

test("upgradeState: an unlocked 0.1 state becomes a model and a route", () => {
	assert.deepEqual(upgradeState({ lane: "gpt", locked: false }, {}, config), {
		model: GPT,
		route: "live",
		locked: false,
	});
	assert.deepEqual(upgradeState({ lane: "claude", locked: false }, {}, config), {
		model: SONNET,
		route: "code",
		locked: false,
	});
});

test("upgradeState keeps the lock on every path, from 0.1 or 0.2 state", () => {
	const lock = { locked: true, lockReason: "pii" as const, lockDetail: "x" };
	for (const stored of [
		{ lane: "local", ...lock },
		{ lane: "claude", ...lock },
		{ lane: "local", ...lock, cooldowns: { claude: SOON } },
		{ model: SONNET, route: "code", lane: "local", ...lock },
		{ ...lock },
	]) {
		const upgraded = upgradeState(stored, { gpt: SOON }, config);
		assert.equal(upgraded?.locked, true, JSON.stringify(stored));
		assert.equal(upgraded?.lockReason, "pii", JSON.stringify(stored));
		assert.equal(upgraded?.lane, "local", "0.1 still sees the lock after a downgrade");
	}
});

test("upgradeState translates 0.1 cooldowns, in state and in commands, to providers", () => {
	const upgraded = upgradeState(
		{ lane: "claude", locked: false, cooldowns: { claude: SOON } },
		{ gpt: PAST, google: SOON },
		config,
	);
	assert.deepEqual(upgraded?.cooldowns, { anthropic: SOON, "openai-codex": PAST, google: SOON });
});

test("upgradeState passes 0.2 state through and keeps the later cooldown", () => {
	const later = new Date(NOW + 90 * 60_000).toISOString();
	const stored = { model: GEMINI, route: "general", locked: false, cooldowns: { anthropic: SOON } };
	assert.deepEqual(upgradeState(stored, { anthropic: later }, config), {
		model: GEMINI,
		route: "general",
		locked: false,
		cooldowns: { anthropic: later },
	});
	assert.equal(upgradeState(undefined, {}, config), undefined);
	assert.deepEqual(upgradeState(undefined, { anthropic: SOON }, config), {
		locked: false,
		cooldowns: { anthropic: SOON },
	});
});
