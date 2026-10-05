import assert from "node:assert/strict";
import { test } from "node:test";
import { VIRTUAL_MODEL_STATE_ENTRY as PI_STATE_ENTRY } from "@earendil-works/pi-coding-agent";
import {
	type BranchEntry,
	COMMAND_ENTRY,
	firstLockIndex,
	isLocked,
	readCommands,
	readRouterState,
	VIRTUAL_MODEL_STATE_ENTRY,
} from "../src/state.ts";

const stateEntry = (state: unknown, provider = "privacy-router", modelId = "auto"): BranchEntry => ({
	type: "custom",
	customType: VIRTUAL_MODEL_STATE_ENTRY,
	data: { provider, modelId, state },
});
const command = (data: unknown): BranchEntry => ({ type: "custom", customType: COMMAND_ENTRY, data });

test("state entry type matches pi's exported constant", () => {
	assert.equal(VIRTUAL_MODEL_STATE_ENTRY, PI_STATE_ENTRY);
});

test("readRouterState returns the latest privacy-router/auto state and ignores other virtual models", () => {
	const branch = [
		stateEntry({ lane: "claude", locked: false }),
		{ type: "message" },
		stateEntry({ lane: "gpt", locked: false }),
		stateEntry({ phase: "plan" }, "jev", "auto"),
	];
	assert.deepEqual(readRouterState(branch), { lane: "gpt", locked: false });
});

test("readRouterState ignores malformed state", () => {
	assert.equal(readRouterState([stateEntry({ lane: 1 })]), undefined);
	assert.equal(readRouterState([]), undefined);
});

test("readRouterState accepts 0.2 state and rejects malformed fields", () => {
	const routed = { model: "anthropic/claude-sonnet-5", route: "code", locked: false };
	assert.deepEqual(readRouterState([stateEntry(routed)]), routed);
	assert.equal(readRouterState([stateEntry({ locked: "yes" })]), undefined);
	assert.equal(readRouterState([stateEntry({ model: 5, locked: false })]), undefined);
	assert.equal(readRouterState([stateEntry({ route: 1, locked: false })]), undefined);
});

test("readCommands: any lock locks; latest pin/unpin wins", () => {
	assert.deepEqual(readCommands([command({ kind: "pin", target: "gpt" })]), {
		lockRequested: false,
		pin: "gpt",
		cooldowns: {},
	});
	assert.deepEqual(readCommands([command({ kind: "pin", target: "gpt" }), command({ kind: "unpin" })]), {
		lockRequested: false,
		pin: undefined,
		cooldowns: {},
	});
	assert.equal(readCommands([command({ kind: "lock" }), command({ kind: "unpin" })]).lockRequested, true);
});

test("isLocked reads state or a lock command", () => {
	assert.equal(isLocked([stateEntry({ lane: "local", locked: true })]), true);
	assert.equal(isLocked([command({ kind: "lock" })]), true);
	assert.equal(isLocked([stateEntry({ lane: "claude", locked: false })]), false);
});

test("firstLockIndex finds where the branch locked, by command or by state", () => {
	const message: BranchEntry = { type: "message" };
	assert.equal(firstLockIndex([message, stateEntry({ lane: "claude", locked: false })]), -1);
	assert.equal(firstLockIndex([message, command({ kind: "pin", target: "gpt" }), command({ kind: "lock" })]), 2);
	// Sessions locked before the router wrote lock commands carry only the state.
	assert.equal(firstLockIndex([message, stateEntry({ lane: "local", locked: true })]), 1);
	assert.equal(
		firstLockIndex([message, stateEntry({ lane: "local", locked: true }), command({ kind: "lock" })]),
		1,
		"the earliest of the two",
	);
});

test("readCommands keeps the latest cooldown per lane", () => {
	const view = readCommands([
		command({ kind: "cooldown", lane: "claude", until: "2026-10-03T10:00:00.000Z" }),
		command({ kind: "cooldown", lane: "gpt", until: "2026-10-03T09:00:00.000Z" }),
		command({ kind: "cooldown", lane: "claude", until: "2026-10-03T11:00:00.000Z" }),
	]);
	assert.deepEqual(view.cooldowns, { claude: "2026-10-03T11:00:00.000Z", gpt: "2026-10-03T09:00:00.000Z" });
	assert.deepEqual(readCommands([]).cooldowns, {});
});

test("a session stored under the pre-release id router/auto keeps its state and its lock", () => {
	const legacy = stateEntry({ lane: "local", locked: true, lockReason: "pii", lockDetail: "x" }, "router", "auto");
	assert.equal(readRouterState([legacy])?.locked, true);
	assert.equal(isLocked([legacy]), true);
	assert.equal(readRouterState([legacy, stateEntry({ lane: "local", locked: true })])?.lockReason, undefined);
});

test("readCommands keeps the latest cooldown per provider, and 0.1 cooldowns under their lane name", () => {
	const view = readCommands([
		command({ kind: "cooldown", provider: "anthropic", until: "2026-10-03T10:00:00.000Z" }),
		command({ kind: "cooldown", provider: "anthropic", until: "2026-10-03T11:00:00.000Z" }),
		command({ kind: "cooldown", lane: "gpt", until: "2026-10-03T09:00:00.000Z" }),
	]);
	assert.deepEqual(view.cooldowns, { anthropic: "2026-10-03T11:00:00.000Z", gpt: "2026-10-03T09:00:00.000Z" });
});
