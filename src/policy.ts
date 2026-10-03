/**
 * The routing brain. Pure: `decide()` maps signals gathered by index.ts to a target and new state.
 *
 * Privacy-path failures end in an error or the local lane, never a silent cloud route.
 * Category-path failures mean "stay on the current lane".
 */

import type { Category } from "./classify.ts";
import type { PinTarget, RouterConfig } from "./config.ts";
import type { CloudLane, Lane, LockReason, RouterState } from "./state.ts";

export class RouterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RouterError";
	}
}

export type Reason = "user" | "continuation" | "retry" | "direct";

export type Target =
	| { kind: "lane"; lane: Lane }
	| { kind: "ref"; ref: string; lane: CloudLane }
	| { kind: "previous" }
	| { kind: "failed" };

export interface Signals {
	reason: Reason;
	branchReadable: boolean;
	lockRequested: boolean;
	cwdSensitive: boolean;
	privateTag: boolean;
	/** Sensitive path named in the user's message. */
	pathMention?: string;
	/** e.g. "github-token in tool result". */
	secret?: string;
	pinName?: string;
	pin?: PinTarget;
	/** Set by index.ts only when `needsClassification()` is true. */
	pii?: "yes" | "no" | "error";
	category?: { label: Category; p: number } | "error";
	hasPrevious: boolean;
	previousLane?: Lane;
	hasFailed: boolean;
	failedLane?: Lane;
	failedIsQuota: boolean;
	/** Cloud lanes whose model is missing from the catalog or lacks credentials. */
	disabled: readonly CloudLane[];
	now: number;
}

export interface Decision {
	target: Target;
	/** New state to store; undefined keeps the current state. */
	state?: RouterState;
	notice?: string;
	/** Short label for the footer and /router, e.g. "code", "lock:secret", "pin:claude-max". */
	why: string;
}

export type PolicyConfig = Pick<
	RouterConfig,
	"defaultLane" | "minProb" | "quotaCooldownMinutes" | "onPrivacyCheckFailure" | "ollama"
>;

export interface LaneChoiceInput {
	/** Lane this session is on; undefined before any router state exists. */
	current: CloudLane | undefined;
	/** Lane of the model that answered last, when it maps to a cloud lane. */
	previous: CloudLane | undefined;
	category: Category;
	p: number;
	/** Disabled lanes and lanes in quota cooldown. */
	unavailable: ReadonlySet<CloudLane>;
}

/**
 * Hysteresis: only a confident `code` or `live` label moves the session, and only to an available
 * lane. Spec §5.1.
 */
export function chooseLane(input: LaneChoiceInput, config: Pick<RouterConfig, "defaultLane" | "minProb">): CloudLane {
	const start = input.current ?? input.previous ?? config.defaultLane;
	if (input.category === "general" || input.p < config.minProb) return start;
	const target: CloudLane = input.category === "code" ? "claude" : "gpt";
	return input.unavailable.has(target) ? start : target;
}

/**
 * Plan usage exhausted ("usage limit reached", "quota exceeded"). Transient throttling (a bare 429,
 * a per-minute rate limit, "overloaded") is retried by pi and must not switch lanes for an hour.
 */
export function isQuotaError(message: string): boolean {
	return /usage limit|quota|out of extra usage/i.test(message) && !/overloaded/i.test(message);
}

function otherLane(lane: CloudLane): CloudLane {
	return lane === "claude" ? "gpt" : "claude";
}

export interface QuotaFailoverInput {
	state: RouterState | undefined;
	/** Lane of the model whose reply failed, and its error message. */
	failure: { lane: Lane; message: string };
	disabled: readonly CloudLane[];
	now: number;
}

/**
 * pi retries only transient errors, so a usage limit it does not retry (Anthropic's 400 "out of
 * extra usage") ends the turn. The settle hook uses this to cool the lane down and retry the turn on
 * the other lane. Undefined when that lane is disabled or cooling down too: no bouncing.
 */
export function planQuotaFailover(
	input: QuotaFailoverInput,
	config: Pick<RouterConfig, "quotaCooldownMinutes">,
): { from: CloudLane; to: CloudLane; until: string } | undefined {
	const { lane } = input.failure;
	if (!isCloud(lane) || !isQuotaError(input.failure.message)) return undefined;
	const to = otherLane(lane);
	if (input.disabled.includes(to) || inCooldown(input.state, to, input.now)) return undefined;
	return { from: lane, to, until: new Date(input.now + config.quotaCooldownMinutes * 60_000).toISOString() };
}

/** Cooldowns written as commands join the stored state; the later end time wins. */
export function applyCooldowns(
	state: RouterState | undefined,
	cooldowns: Partial<Record<CloudLane, string>>,
	defaultLane: CloudLane,
): RouterState | undefined {
	const lanes = Object.keys(cooldowns) as CloudLane[];
	if (lanes.length === 0) return state;
	const merged = { ...state?.cooldowns };
	for (const lane of lanes) {
		const until = cooldowns[lane] as string;
		const stored = merged[lane];
		if (stored === undefined || Date.parse(until) > Date.parse(stored)) merged[lane] = until;
	}
	return { ...(state ?? { lane: defaultLane, locked: false }), cooldowns: merged };
}

function isCloud(lane: Lane | undefined): lane is CloudLane {
	return lane === "claude" || lane === "gpt";
}

/** True when a user request still needs the two classifier calls. */
export function needsClassification(state: RouterState | undefined, signals: Signals): boolean {
	return (
		signals.reason === "user" &&
		signals.branchReadable &&
		state?.locked !== true &&
		!signals.lockRequested &&
		!signals.cwdSensitive &&
		!signals.privateTag &&
		signals.pathMention === undefined &&
		signals.secret === undefined
	);
}

function deterministicLock(signals: Signals): { reason: LockReason; detail: string } | undefined {
	if (signals.lockRequested) return { reason: "command", detail: "/local" };
	if (signals.cwdSensitive) return { reason: "cwd", detail: "working directory is private" };
	if (signals.privateTag) return { reason: "tag", detail: "#private" };
	if (signals.pathMention !== undefined) return { reason: "path", detail: signals.pathMention };
	if (signals.secret !== undefined) return { reason: "secret", detail: signals.secret };
	return undefined;
}

function lockNow(state: RouterState | undefined, reason: LockReason, detail: string): Decision {
	return {
		target: { kind: "lane", lane: "local" },
		state: { ...state, lane: "local", locked: true, lockReason: reason, lockDetail: detail },
		// Spec §7.1: the 35b may need to load from disk, so warn that the first local reply can be slow.
		notice: `🔒 locked · ${reason} · ${detail} · loading local model, first reply may be slow`,
		why: `lock:${reason}`,
	};
}

/** New state only when the lane changes. */
function withLane(state: RouterState | undefined, lane: CloudLane): RouterState | undefined {
	return state?.lane === lane ? undefined : { ...state, lane, locked: false };
}

function inCooldown(state: RouterState | undefined, lane: CloudLane, now: number): boolean {
	const until = state?.cooldowns?.[lane];
	return until !== undefined && Date.parse(until) > now;
}

function unavailableLanes(state: RouterState | undefined, signals: Signals): Set<CloudLane> {
	const unavailable = new Set<CloudLane>(signals.disabled);
	for (const lane of ["claude", "gpt"] as const) if (inCooldown(state, lane, signals.now)) unavailable.add(lane);
	return unavailable;
}

function startLane(state: RouterState | undefined, signals: Signals, config: PolicyConfig): CloudLane {
	const current = isCloud(state?.lane) ? state.lane : undefined;
	const previous = isCloud(signals.previousLane) ? signals.previousLane : undefined;
	const start = current ?? previous ?? config.defaultLane;
	// A lane cooling down after a usage limit cannot be stayed on. A disabled lane is not swapped
	// here: routing to it stays an error, so missing credentials are never hidden.
	const other = otherLane(start);
	const otherUsable = !signals.disabled.includes(other) && !inCooldown(state, other, signals.now);
	return inCooldown(state, start, signals.now) && otherUsable ? other : start;
}

/** A continuation cannot stay on a model whose lane hit its usage limit mid-turn. */
function leaveCooledPrevious(state: RouterState | undefined, signals: Signals, why: string): Decision | undefined {
	const lane = signals.previousLane;
	if (!isCloud(lane) || !inCooldown(state, lane, signals.now)) return undefined;
	const to = otherLane(lane);
	if (signals.disabled.includes(to) || inCooldown(state, to, signals.now)) return undefined;
	return { target: { kind: "lane", lane: to }, state: withLane(state, to), why: `${why} (${lane} cooling down)` };
}

function stay(state: RouterState | undefined, signals: Signals, config: PolicyConfig, why: string): Decision {
	return { target: { kind: "lane", lane: startLane(state, signals, config) }, why };
}

function decideUser(state: RouterState | undefined, signals: Signals, config: PolicyConfig): Decision {
	if (signals.pii === "yes") return lockNow(state, "pii", "personal information in message");
	let notice: string | undefined;
	if (signals.pii !== "no") {
		if (config.onPrivacyCheckFailure === "block") {
			throw new RouterError(
				`Privacy check unavailable: Ollama not reachable at ${config.ollama.baseUrl}. Start Ollama and resend.`,
			);
		}
		notice = "⚠ privacy check unavailable; deterministic checks only";
	}

	if (signals.pin && signals.pinName) {
		if (!inCooldown(state, signals.pin.lane, signals.now)) {
			const target: Target = signals.pin.model
				? { kind: "ref", ref: signals.pin.model, lane: signals.pin.lane }
				: { kind: "lane", lane: signals.pin.lane };
			return { target, state: withLane(state, signals.pin.lane), notice, why: `pin:${signals.pinName}` };
		}
		// The pinned lane hit its usage limit: route normally until the cooldown ends, then the pin resumes.
		const paused = `📌 ${signals.pinName} paused: ${signals.pin.lane} is cooling down after a usage limit`;
		notice = notice ? `${notice}; ${paused}` : paused;
	}

	let lane: CloudLane;
	let why: string;
	if (signals.category === undefined || signals.category === "error") {
		lane = startLane(state, signals, config);
		notice = notice ?? "⚠ classifier down; staying on current lane";
		why = "classifier down";
	} else {
		lane = chooseLane(
			{
				current: startLane(state, signals, config),
				previous: undefined,
				category: signals.category.label,
				p: signals.category.p,
				unavailable: unavailableLanes(state, signals),
			},
			config,
		);
		why = signals.category.label;
	}
	if (signals.disabled.includes(lane)) {
		throw new RouterError(
			`Lane "${lane}" is unavailable: its model is missing from pi's catalog or has no credentials. Log in to its provider, or set "lanes.${lane}" in privacy-router.json to a model you have.`,
		);
	}
	return { target: { kind: "lane", lane }, state: withLane(state, lane), notice, why };
}

function decideRetry(state: RouterState | undefined, signals: Signals, config: PolicyConfig): Decision {
	if (!signals.hasFailed) {
		return signals.hasPrevious ? { target: { kind: "previous" }, why: "retry" } : stay(state, signals, config, "retry");
	}
	const failed = signals.failedLane;
	if (signals.failedIsQuota && isCloud(failed)) {
		const other: CloudLane = failed === "claude" ? "gpt" : "claude";
		if (signals.disabled.includes(other)) return { target: { kind: "failed" }, why: "retry (no failover lane)" };
		const until = new Date(signals.now + config.quotaCooldownMinutes * 60_000).toISOString();
		return {
			target: { kind: "lane", lane: other },
			state: { ...state, lane: other, locked: false, cooldowns: { ...state?.cooldowns, [failed]: until } },
			notice: `${failed} usage limit reached; using ${other} for ${config.quotaCooldownMinutes} min`,
			why: `failover:${failed}→${other}`,
		};
	}
	return { target: { kind: "failed" }, why: "retry" };
}

export function decide(state: RouterState | undefined, signals: Signals, config: PolicyConfig): Decision {
	if (!signals.branchReadable) return { target: { kind: "lane", lane: "local" }, why: "branch unreadable" };
	if (state?.locked) return { target: { kind: "lane", lane: "local" }, why: `locked:${state.lockReason ?? "unknown"}` };
	const lock = deterministicLock(signals);
	if (lock) return lockNow(state, lock.reason, lock.detail);
	switch (signals.reason) {
		case "user":
			return decideUser(state, signals, config);
		case "continuation":
			if (!signals.hasPrevious) return stay(state, signals, config, "continuation");
			return (
				leaveCooledPrevious(state, signals, "continuation") ?? { target: { kind: "previous" }, why: "continuation" }
			);
		case "retry":
			return decideRetry(state, signals, config);
		case "direct":
			if (!signals.hasPrevious) return stay(state, signals, config, "direct");
			return leaveCooledPrevious(state, signals, "direct") ?? { target: { kind: "previous" }, why: "direct" };
	}
}
