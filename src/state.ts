/**
 * Router state and the session-branch readers.
 *
 * pi stores the state `route()` returns as a custom entry on the session branch, so it follows
 * `/tree` and forks and survives compaction. Commands cannot write that state; they append
 * `router.command` entries, which `route()` and the guards read from the branch.
 */

import type { StoredState } from "./routes.ts";

export type LockReason = "tag" | "command" | "cwd" | "path" | "secret" | "pii";

/** `leave-local` only marks where /leave-local moved the session, so a reopened session resumes there. */
export type RouterCommand =
	| { kind: "lock" }
	| { kind: "pin"; target: string }
	| { kind: "unpin" }
	| { kind: "leave-local" }
	/** Written when a usage-limit error ends a turn; see the agent_before_settle handler. */
	| { kind: "cooldown"; provider: string; until: string }
	/** 0.1 form, keyed by lane name; upgradeState (routes.ts) translates it to a provider. */
	| { kind: "cooldown"; lane: "claude" | "gpt"; until: string };

export const ROUTER_PROVIDER = "privacy-router";
/** The id before the public release; sessions written under it keep their state and lock. */
export const LEGACY_ROUTER_PROVIDER = "router";
export const ROUTER_MODEL_ID = "auto";
/** Mirrors `VIRTUAL_MODEL_STATE_ENTRY` from pi-coding-agent; test/state.test.ts asserts they match. */
export const VIRTUAL_MODEL_STATE_ENTRY = "pi.virtual-model-state";
export const COMMAND_ENTRY = "router.command";

/** The slice of a pi `SessionEntry` this module reads. */
export interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface CommandView {
	lockRequested: boolean;
	pin: string | undefined;
	/** Latest end time per provider, or per 0.1 lane name ("claude" | "gpt") for 0.1 entries. */
	cooldowns: Record<string, string>;
}

function isStoredState(value: unknown): value is StoredState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Record<string, unknown>;
	return (
		typeof state.locked === "boolean" &&
		(state.lane === undefined || typeof state.lane === "string") &&
		(state.model === undefined || typeof state.model === "string") &&
		(state.route === undefined || typeof state.route === "string")
	);
}

/** Latest stored state (0.1 or 0.2) on the branch for `privacy-router/auto` or the pre-release `router/auto`. */
export function readRouterState(branch: readonly BranchEntry[]): StoredState | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
		const data = entry.data as { provider?: unknown; modelId?: unknown; state?: unknown } | undefined;
		const ours = data?.provider === ROUTER_PROVIDER || data?.provider === LEGACY_ROUTER_PROVIDER;
		if (ours && data?.modelId === ROUTER_MODEL_ID && isStoredState(data.state)) return data.state;
	}
	return undefined;
}

/** Any `lock` command locks; the latest `pin`/`unpin` decides the pin. */
export function readCommands(branch: readonly BranchEntry[]): CommandView {
	let lockRequested = false;
	let pin: string | undefined;
	const cooldowns: Record<string, string> = {};
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== COMMAND_ENTRY) continue;
		const command = entry.data as RouterCommand | undefined;
		if (command?.kind === "lock") lockRequested = true;
		else if (command?.kind === "pin") pin = command.target;
		else if (command?.kind === "unpin") pin = undefined;
		else if (command?.kind === "cooldown") {
			const key = "provider" in command ? command.provider : command.lane;
			const current = cooldowns[key];
			if (current === undefined || Date.parse(command.until) > Date.parse(current)) cooldowns[key] = command.until;
		}
	}
	return { lockRequested, pin, cooldowns };
}

/** Index of the entry where the branch locked (a lock command or a locked state), or -1. */
export function firstLockIndex(branch: readonly BranchEntry[]): number {
	return branch.findIndex((entry) => {
		if (entry.type !== "custom") return false;
		if (entry.customType === COMMAND_ENTRY) return (entry.data as RouterCommand | undefined)?.kind === "lock";
		return readRouterState([entry])?.locked === true;
	});
}

export function isLocked(branch: readonly BranchEntry[]): boolean {
	return readRouterState(branch)?.locked === true || readCommands(branch).lockRequested;
}
