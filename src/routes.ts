/**
 * Model routes: which configured model serves a request, and reading 0.1 router state. Pure:
 * index.ts supplies model availability from pi's registry.
 */

import type { LockReason } from "./state.ts";

/** "provider/model". */
export type ModelRef = string;

/** Which list the current model came from; failover continues down that list. */
export type Route = "code" | "live" | "general" | "pin" | "default";
const ROUTES: readonly string[] = ["code", "live", "general", "pin", "default"];

/** The routing part of RouterConfig. */
export interface RoutesConfig {
	routes: { code: ModelRef[]; live: ModelRef[]; general: "stay" | ModelRef[] };
	defaultModel: ModelRef;
}

/** What pi's model registry says about a model ref. */
export type Availability = "ok" | "missing" | "no-credentials";

export interface Skipped {
	ref: ModelRef;
	reason: "missing" | "no-credentials" | "cooling";
	/** ISO time the provider's cooldown ends; set when `reason` is "cooling". */
	until?: string;
}

export interface Usability {
	availability: (ref: ModelRef) => Availability;
	/** Provider → ISO time until which it is skipped. */
	cooldowns: Readonly<Record<string, string>> | undefined;
	now: number;
}

/** 0.2 router state. */
export interface RoutedState {
	model?: ModelRef;
	route?: Route;
	/** Once true on a branch, never false on that branch. */
	locked: boolean;
	lockReason?: LockReason;
	lockDetail?: string;
	/** Provider → ISO time until which it is skipped after a usage limit. */
	cooldowns?: Record<string, string>;
	/** Written only when locked, so 0.1 (which requires `lane`) still sees the lock after a downgrade. */
	lane?: "local";
}

/**
 * What a state entry may hold: 0.2 state, or 0.1 state (`lane` "claude" | "gpt" | "local", cooldowns
 * keyed by lane name).
 */
export interface StoredState {
	lane?: string;
	model?: string;
	route?: string;
	locked: boolean;
	lockReason?: LockReason;
	lockDetail?: string;
	cooldowns?: Record<string, string>;
}

/** Text before the first "/": `openrouter/anthropic/claude-x` → `openrouter`. */
export function providerOf(ref: ModelRef): string {
	const slash = ref.indexOf("/");
	return slash === -1 ? ref : ref.slice(0, slash);
}

/** ISO end of the provider's cooldown, or undefined when it is not cooling at `now`. */
export function coolingUntil(
	cooldowns: Readonly<Record<string, string>> | undefined,
	provider: string,
	now: number,
): string | undefined {
	const until = cooldowns?.[provider];
	return until !== undefined && Date.parse(until) > now ? until : undefined;
}

/** The first usable entry, and the entries skipped before it with their reasons. */
export function firstUsable(list: readonly ModelRef[], usability: Usability): { ref?: ModelRef; skipped: Skipped[] } {
	const skipped: Skipped[] = [];
	for (const ref of list) {
		const availability = usability.availability(ref);
		if (availability !== "ok") {
			skipped.push({ ref, reason: availability });
			continue;
		}
		const until = coolingUntil(usability.cooldowns, providerOf(ref), usability.now);
		if (until !== undefined) {
			skipped.push({ ref, reason: "cooling", until });
			continue;
		}
		return { ref, skipped };
	}
	return { skipped };
}

export function isUsable(ref: ModelRef, usability: Usability): boolean {
	return firstUsable([ref], usability).ref !== undefined;
}

/** The fallback chain: `[defaultModel, ...code, ...live]`, first occurrence kept. */
export function fallbackChain(config: RoutesConfig): ModelRef[] {
	return [...new Set([config.defaultModel, ...config.routes.code, ...config.routes.live])];
}

/** The list a request continues down when its model's provider is cooling down or hit a usage limit. */
export function routeList(route: Route | undefined, config: RoutesConfig): ModelRef[] {
	if (route === "code" || route === "live") return config.routes[route];
	if (route === "general" && Array.isArray(config.routes.general)) return config.routes.general;
	return fallbackChain(config);
}

function clock(iso: string | undefined): string {
	if (iso === undefined) return "unknown";
	const time = new Date(iso);
	return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

/** `anthropic/x (no credentials), openai/y (cooling until 14:05)`, for errors and notices. */
export function describeSkipped(skipped: readonly Skipped[]): string {
	return skipped
		.map((entry) => {
			if (entry.reason === "cooling") return `${entry.ref} (cooling until ${clock(entry.until)})`;
			return `${entry.ref} (${entry.reason === "missing" ? "not in pi's catalog" : "no credentials"})`;
		})
		.join(", ");
}

/** The 0.2 model a 0.1 lane name stood for. */
export function legacyLaneModel(lane: "claude" | "gpt", config: RoutesConfig): ModelRef {
	return lane === "claude" ? config.routes.code[0] : config.routes.live[0];
}

function cooldownKey(key: string, config: RoutesConfig): string {
	return key === "claude" || key === "gpt" ? providerOf(legacyLaneModel(key, config)) : key;
}

/**
 * Stored state (0.1 or 0.2) plus cooldown commands, as 0.2 state. `locked` is copied
 * unchanged on every path; a 0.1 lane name only ever becomes a model, a route, or a provider key.
 */
export function upgradeState(
	stored: StoredState | undefined,
	commandCooldowns: Readonly<Record<string, string>>,
	config: RoutesConfig,
): RoutedState | undefined {
	const cooldowns: Record<string, string> = {};
	const addCooldown = (key: string, until: string) => {
		const provider = cooldownKey(key, config);
		const current = cooldowns[provider];
		if (current === undefined || Date.parse(until) > Date.parse(current)) cooldowns[provider] = until;
	};
	for (const [key, until] of Object.entries(stored?.cooldowns ?? {})) {
		if (typeof until === "string") addCooldown(key, until);
	}
	for (const [key, until] of Object.entries(commandCooldowns)) addCooldown(key, until);
	if (stored === undefined && Object.keys(cooldowns).length === 0) return undefined;

	const legacyLane = stored?.lane === "claude" || stored?.lane === "gpt" ? stored.lane : undefined;
	const model = stored?.model ?? (legacyLane ? legacyLaneModel(legacyLane, config) : undefined);
	const storedRoute =
		stored?.route !== undefined && ROUTES.includes(stored.route) ? (stored.route as Route) : undefined;
	const route = storedRoute ?? (legacyLane === "claude" ? "code" : legacyLane === "gpt" ? "live" : undefined);
	const locked = stored?.locked === true;
	return {
		...(model !== undefined ? { model } : {}),
		...(route !== undefined ? { route } : {}),
		locked,
		...(stored?.lockReason !== undefined ? { lockReason: stored.lockReason } : {}),
		...(stored?.lockDetail !== undefined ? { lockDetail: stored.lockDetail } : {}),
		...(Object.keys(cooldowns).length > 0 ? { cooldowns } : {}),
		...(locked ? { lane: "local" as const } : {}),
	};
}
