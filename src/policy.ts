/**
 * The routing brain. Pure: `decide()` maps signals gathered by index.ts to a target and new state.
 *
 * Privacy-path failures end in an error or the private model, never a silent cloud route.
 * Category-path failures mean "stay on the current model".
 */

import type { Category } from "./classify.ts";
import type { RouterConfig } from "./config.ts";
import {
	type Availability,
	coolingUntil,
	describeSkipped,
	fallbackChain,
	firstUsable,
	type ModelRef,
	providerOf,
	type Route,
	type RoutedState,
	routeList,
	type Skipped,
	type Usability,
} from "./routes.ts";
import type { LockReason } from "./state.ts";

export class RouterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RouterError";
	}
}

// pi retries an error automatically when its text looks transient ("timed out", "500", ...), so the
// refusals carry no numbers, URLs or timeout wording. test/retryable.test.ts checks them.
const TOO_LONG_REFUSAL =
	"Text since the last cloud reply is too long to check for personal information. Add #private to keep this session on the local model, use /tree without a summary to go back to before the long text, or start a new session.";
const CHECK_UNAVAILABLE_REFUSAL =
	"Privacy check unavailable: the local classifier did not answer (not running, still loading, or too slow). Start Ollama, or wait for the model to load, and resend. The classifier settings are under ollama in privacy-router.json.";

export type Reason = "user" | "continuation" | "retry" | "direct";

export type Target = { kind: "private" } | { kind: "model"; ref: ModelRef } | { kind: "previous" } | { kind: "failed" };

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
	/** Active pin and the model it pins (config `pins`). */
	pinName?: string;
	pin?: ModelRef;
	/** Set by index.ts when `needsClassification()` is true, and on other requests with new user-side text. */
	pii?: "yes" | "no" | "error" | "too-long";
	/** Characters of the checked text, for diagnostics; the refusal leaves it out (see TOO_LONG_REFUSAL). */
	piiLength?: number;
	category?: { label: Category; p: number } | "error";
	/** Model of the latest successful reply (`request.previous`). */
	previous?: ModelRef;
	/** Model whose reply failed (`request.failed`). */
	failed?: ModelRef;
	failedIsQuota: boolean;
	/** pi's registry: whether a model exists and has credentials. */
	availability: (ref: ModelRef) => Availability;
	now: number;
}

export interface Decision {
	target: Target;
	/** New state to store; undefined keeps the current state. */
	state?: RoutedState;
	notice?: string;
	/** Short label for the footer and /privacy, e.g. "code", "lock:secret", "pin:claude-max". */
	why: string;
	/** Models passed over to reach the target; index.ts announces missing ones once per session. */
	skipped?: Skipped[];
}

export type PolicyConfig = Pick<
	RouterConfig,
	"routes" | "defaultModel" | "minProb" | "quotaCooldownMinutes" | "onPrivacyCheckFailure"
>;

/**
 * Plan usage exhausted ("usage limit reached", "quota exceeded", "out of extra usage"). Transient
 * throttling (a bare 429, a per-minute rate limit, "overloaded") is retried by pi and must not cool a
 * provider down for an hour.
 */
export function isQuotaError(message: string): boolean {
	return /usage limit|quota|out of extra usage/i.test(message) && !/overloaded/i.test(message);
}

/** True when a user request still needs the two classifier calls. */
export function needsClassification(state: RoutedState | undefined, signals: Signals): boolean {
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

function lockNow(state: RoutedState | undefined, reason: LockReason, detail: string): Decision {
	return {
		target: { kind: "private" },
		state: { ...state, locked: true, lockReason: reason, lockDetail: detail, lane: "local" },
		// The local model may need to load from disk, so warn that the first local reply can be slow.
		notice: `🔒 locked · ${reason} · ${detail} · loading local model, first reply may be slow`,
		why: `lock:${reason}`,
	};
}

function usabilityOf(state: RoutedState | undefined, signals: Signals): Usability {
	return { availability: signals.availability, cooldowns: state?.cooldowns, now: signals.now };
}

/** New state only when the model or route changes. */
function withModel(state: RoutedState | undefined, model: ModelRef, route: Route): RoutedState | undefined {
	if (state?.model === model && state.route === route) return undefined;
	return { ...state, model, route, locked: false };
}

function noUsable(what: string, skipped: readonly Skipped[]): RouterError {
	return new RouterError(
		`No usable model for ${what}: ${describeSkipped(skipped)}. Log in to a provider, wait for the cooldown, or edit routes in privacy-router.json.`,
	);
}

function currentModel(state: RoutedState | undefined, signals: Signals, config: PolicyConfig): ModelRef {
	return state?.model ?? signals.previous ?? config.defaultModel;
}

/** Stay on the current model if usable, else the first usable model of the fallback chain. */
function stayOrFallback(state: RoutedState | undefined, signals: Signals, config: PolicyConfig, why: string): Decision {
	const usability = usabilityOf(state, signals);
	const current = currentModel(state, signals, config);
	if (firstUsable([current], usability).ref !== undefined) {
		const route: Route = state?.model === current ? (state.route ?? "default") : "default";
		return { target: { kind: "model", ref: current }, state: withModel(state, current, route), why };
	}
	const picked = firstUsable(fallbackChain(config), usability);
	if (picked.ref === undefined) throw noUsable(why, picked.skipped);
	return {
		target: { kind: "model", ref: picked.ref },
		state: withModel(state, picked.ref, "default"),
		why,
		skipped: picked.skipped,
	};
}

/** Text the privacy check could not read: block mode refuses it, warn mode routes on with this notice. */
function uncheckedNotice(pii: "error" | "too-long", config: PolicyConfig): string {
	const block = config.onPrivacyCheckFailure === "block";
	if (pii === "too-long") {
		if (block) throw new RouterError(TOO_LONG_REFUSAL);
		return "⚠ text since the last cloud reply is too long to check for personal information; deterministic checks only";
	}
	if (block) throw new RouterError(CHECK_UNAVAILABLE_REFUSAL);
	return "⚠ privacy check unavailable; deterministic checks only";
}

function decideUser(state: RoutedState | undefined, signals: Signals, config: PolicyConfig): Decision {
	if (signals.pii === "yes") return lockNow(state, "pii", "personal information in message");
	// A user turn whose check did not run counts as a failed check.
	let notice = signals.pii === "no" ? undefined : uncheckedNotice(signals.pii ?? "error", config);

	if (signals.pin !== undefined && signals.pinName !== undefined) {
		const availability = signals.availability(signals.pin);
		if (availability !== "ok") {
			const reason = availability === "missing" ? "is not in pi's catalog" : "has no credentials";
			throw new RouterError(`Pinned model ${signals.pin} ${reason}. Log in, or run /route auto.`);
		}
		const provider = providerOf(signals.pin);
		if (coolingUntil(state?.cooldowns, provider, signals.now) === undefined) {
			return {
				target: { kind: "model", ref: signals.pin },
				state: withModel(state, signals.pin, "pin"),
				notice,
				why: `pin:${signals.pinName}`,
			};
		}
		// The pinned provider hit its usage limit: route normally until the cooldown ends, then the pin resumes.
		const paused = `📌 ${signals.pinName} paused: ${provider} is cooling down after a usage limit`;
		notice = notice ? `${notice}; ${paused}` : paused;
	}

	const category = signals.category;
	if (category === undefined || category === "error") {
		const stayed = stayOrFallback(state, signals, config, "classifier down");
		return { ...stayed, notice: notice ?? "⚠ classifier down; staying on the current model" };
	}
	const confident = category.p >= config.minProb;
	let list: ModelRef[] | undefined;
	if (confident && (category.label === "code" || category.label === "live")) list = config.routes[category.label];
	else if (confident && category.label === "general" && Array.isArray(config.routes.general)) {
		list = config.routes.general;
	}
	if (list === undefined) return { ...stayOrFallback(state, signals, config, category.label), notice };
	const picked = firstUsable(list, usabilityOf(state, signals));
	if (picked.ref === undefined) throw noUsable(category.label, picked.skipped);
	return {
		target: { kind: "model", ref: picked.ref },
		state: withModel(state, picked.ref, category.label),
		notice,
		why: category.label,
		skipped: picked.skipped,
	};
}

function decideMidTurn(
	state: RoutedState | undefined,
	signals: Signals,
	config: PolicyConfig,
	reason: "continuation" | "direct",
): Decision {
	if (signals.previous === undefined) return stayOrFallback(state, signals, config, reason);
	const provider = providerOf(signals.previous);
	if (coolingUntil(state?.cooldowns, provider, signals.now) === undefined) {
		return { target: { kind: "previous" }, why: reason };
	}
	const picked = firstUsable(routeList(state?.route, config), usabilityOf(state, signals));
	if (picked.ref === undefined) throw noUsable(reason, picked.skipped);
	return {
		target: { kind: "model", ref: picked.ref },
		state: withModel(state, picked.ref, state?.route ?? "default"),
		why: `${reason} (${provider} cooling down)`,
		skipped: picked.skipped,
	};
}

function decideRetry(state: RoutedState | undefined, signals: Signals, config: PolicyConfig): Decision {
	if (signals.failed === undefined) {
		return signals.previous !== undefined
			? { target: { kind: "previous" }, why: "retry" }
			: stayOrFallback(state, signals, config, "retry");
	}
	if (!signals.failedIsQuota) return { target: { kind: "failed" }, why: "retry" };
	const provider = providerOf(signals.failed);
	const until = new Date(signals.now + config.quotaCooldownMinutes * 60_000).toISOString();
	const cooled: RoutedState = {
		...(state ?? { locked: false }),
		cooldowns: { ...state?.cooldowns, [provider]: until },
	};
	const picked = firstUsable(routeList(state?.route, config), usabilityOf(cooled, signals));
	// A zero cooldown leaves the failed provider usable; failing over to it would loop forever.
	if (picked.ref === undefined || providerOf(picked.ref) === provider) {
		return { target: { kind: "failed" }, why: "retry (no failover model)" };
	}
	return {
		target: { kind: "model", ref: picked.ref },
		state: { ...cooled, model: picked.ref, route: state?.route ?? "default", locked: false },
		notice: `${provider} usage limit reached; using ${picked.ref} for ${config.quotaCooldownMinutes} min`,
		why: `failover:${provider}→${picked.ref}`,
		skipped: picked.skipped,
	};
}

/**
 * Retries can carry steering messages queued during the failed request, summaries (direct) text a
 * refused turn left behind, and continuations text an extension added when it started the turn, so
 * index.ts runs the privacy check on them as on user turns. `pii` stays undefined when there was no
 * new text to check, as in an ordinary tool loop.
 */
function decideChecked(
	state: RoutedState | undefined,
	signals: Signals,
	config: PolicyConfig,
	reason: Exclude<Reason, "user">,
): Decision {
	if (signals.pii === "yes") return lockNow(state, "pii", "personal information in message");
	const notice =
		signals.pii === "error" || signals.pii === "too-long" ? uncheckedNotice(signals.pii, config) : undefined;
	const decision =
		reason === "retry" ? decideRetry(state, signals, config) : decideMidTurn(state, signals, config, reason);
	if (notice === undefined) return decision;
	return { ...decision, notice: decision.notice ? `${notice}; ${decision.notice}` : notice };
}

export interface QuotaFailoverInput {
	state: RoutedState | undefined;
	/** Model whose reply ended the turn with an error. */
	failed: ModelRef;
	/** Its error message. */
	message: string;
	availability: (ref: ModelRef) => Availability;
	now: number;
}

/**
 * pi retries only transient errors, so a usage limit it does not retry ends the turn. The
 * settle hook cools the provider down and retries the turn, but only when a usable model remains.
 */
export function planQuotaFailover(
	input: QuotaFailoverInput,
	config: Pick<RouterConfig, "routes" | "defaultModel" | "quotaCooldownMinutes">,
): { provider: string; until: string; to: ModelRef } | undefined {
	if (!isQuotaError(input.message)) return undefined;
	const provider = providerOf(input.failed);
	const until = new Date(input.now + config.quotaCooldownMinutes * 60_000).toISOString();
	const picked = firstUsable(routeList(input.state?.route, config), {
		availability: input.availability,
		cooldowns: { ...input.state?.cooldowns, [provider]: until },
		now: input.now,
	});
	// A zero cooldown leaves the failed provider usable; retrying on it would loop forever.
	if (picked.ref === undefined || providerOf(picked.ref) === provider) return undefined;
	return { provider, until, to: picked.ref };
}

export function decide(state: RoutedState | undefined, signals: Signals, config: PolicyConfig): Decision {
	if (!signals.branchReadable) return { target: { kind: "private" }, why: "branch unreadable" };
	if (state?.locked) return { target: { kind: "private" }, why: `locked:${state.lockReason ?? "unknown"}` };
	const lock = deterministicLock(signals);
	if (lock) return lockNow(state, lock.reason, lock.detail);
	switch (signals.reason) {
		case "user":
			return decideUser(state, signals, config);
		case "continuation":
		case "retry":
		case "direct":
			return decideChecked(state, signals, config, signals.reason);
	}
}
