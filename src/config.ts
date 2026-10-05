/**
 * Router configuration: `~/.pi/agent/privacy-router.json` (override the path with PI_PRIVACY_ROUTER_CONFIG).
 *
 * An absent file means built-in defaults. A present but invalid file is an error: silently
 * ignoring it could drop the user's `sensitivePaths`. A 0.1 file (`lanes`, `defaultLane`,
 * `pinTargets`) is translated to 0.2 keys when it loads.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRef } from "./routes.ts";

export interface RouterConfig {
	ollama: { baseUrl: string; classifierModel: string; timeoutMs: number; keepAlive: string };
	/** Per category, models in failover order; `general` may stay on the current model. */
	routes: { code: ModelRef[]; live: ModelRef[]; general: "stay" | ModelRef[] };
	/** Local model for locked sessions; must be served from localhost. */
	private: ModelRef;
	/** Model to use when there is no current model yet. */
	defaultModel: ModelRef;
	/** `/route <name>` pins a model. */
	pins: Record<string, ModelRef>;
	minProb: number;
	quotaCooldownMinutes: number;
	onPrivacyCheckFailure: "block" | "warn";
	sensitivePaths: string[];
	extraSecretFilenames: string[];
	lockedToolAllowlist: string[];
}

export type ConfigResult =
	| { ok: true; config: RouterConfig; source: "file" | "defaults" }
	| { ok: false; error: string };

const SONNET = "anthropic/claude-sonnet-5";
const OPUS = "anthropic/claude-opus-5";
const GPT = "openai-codex/gpt-6-sol";
const LOCAL = "ollama/qwen3.6:35b-pi";

export const DEFAULT_CONFIG: RouterConfig = {
	ollama: { baseUrl: "http://localhost:11434", classifierModel: "qwen3:8b", timeoutMs: 1500, keepAlive: "30m" },
	routes: { code: [SONNET, GPT], live: [GPT, SONNET], general: "stay" },
	private: LOCAL,
	defaultModel: SONNET,
	pins: { claude: SONNET, "claude-max": OPUS, gpt: GPT },
	minProb: 0.6,
	quotaCooldownMinutes: 60,
	onPrivacyCheckFailure: "block",
	sensitivePaths: ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.config/gh/**", "~/.pi/agent/auth.json"],
	extraSecretFilenames: [],
	lockedToolAllowlist: ["read", "write", "edit", "bash", "grep", "find", "ls", "todo", "ask_user_question"],
};

const MODEL_REF = /^[^/\s]+\/\S+$/;
const V2_KEYS = ["routes", "private", "defaultModel", "pins"];
const LEGACY_KEYS = ["lanes", "defaultLane", "pinTargets"];
const LEGACY_LANES = ["claude", "gpt", "local"];
const LEGACY_DEFAULT_LANES: Record<string, string> = { claude: SONNET, gpt: GPT, local: LOCAL };
const LEGACY_DEFAULT_PIN_TARGETS: Record<string, unknown> = {
	claude: { lane: "claude" },
	"claude-max": { lane: "claude", model: OPUS },
	gpt: { lane: "gpt" },
};

export function configPath(): string {
	return process.env.PI_PRIVACY_ROUTER_CONFIG ?? join(homedir(), ".pi", "agent", "privacy-router.json");
}

export function loadConfig(path: string = configPath()): ConfigResult {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT")
			return { ok: true, config: DEFAULT_CONFIG, source: "defaults" };
		return { ok: false, error: `cannot read ${path}: ${(err as Error).message}` };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { ok: false, error: `invalid JSON in ${path}: ${(err as Error).message}` };
	}
	return parseConfig(raw);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: unknown, allowed: readonly string[], where: string): string[] {
	if (!isObject(value)) return [];
	return Object.keys(value)
		.filter((key) => !allowed.includes(key))
		.map((key) => `unknown key "${where}${key}"`);
}

/**
 * Misspelled keys are errors, not silently ignored: `sensitivePath` instead of `sensitivePaths` would
 * otherwise drop the user's private folders without a word.
 */
function misspelledKeys(raw: Record<string, unknown>): string[] {
	const errors = [
		...unknownKeys(raw, [...Object.keys(DEFAULT_CONFIG), ...LEGACY_KEYS, "$schema"], ""),
		...unknownKeys(raw.ollama, Object.keys(DEFAULT_CONFIG.ollama), "ollama."),
		...unknownKeys(raw.routes, ["code", "live", "general"], "routes."),
		...unknownKeys(raw.lanes, LEGACY_LANES, "lanes."),
	];
	if (isObject(raw.pinTargets)) {
		for (const [name, target] of Object.entries(raw.pinTargets)) {
			errors.push(...unknownKeys(target, ["lane", "model"], `pinTargets.${name}.`));
		}
	}
	return errors;
}

function isModelRef(value: unknown): value is string {
	return typeof value === "string" && MODEL_REF.test(value);
}

/** 0.1 routing keys as 0.2 keys. Missing 0.1 keys take 0.1 defaults first. */
function translateLegacy(raw: Record<string, unknown>): { routing: Partial<RouterConfig>; errors: string[] } {
	const errors: string[] = [];
	const lanes: Record<string, unknown> = { ...LEGACY_DEFAULT_LANES, ...(isObject(raw.lanes) ? raw.lanes : {}) };
	for (const lane of LEGACY_LANES) {
		if (!isModelRef(lanes[lane])) errors.push(`lanes.${lane} must be "provider/model"`);
	}
	const defaultLane = raw.defaultLane ?? "claude";
	if (defaultLane !== "claude" && defaultLane !== "gpt") errors.push(`defaultLane must be "claude" or "gpt"`);
	const pinTargets = raw.pinTargets ?? LEGACY_DEFAULT_PIN_TARGETS;
	const pins: Record<string, ModelRef> = {};
	if (!isObject(pinTargets)) {
		errors.push("pinTargets must be an object");
	} else {
		for (const [name, target] of Object.entries(pinTargets)) {
			if (!isObject(target) || (target.lane !== "claude" && target.lane !== "gpt")) {
				errors.push(`pinTargets.${name}.lane must be "claude" or "gpt"`);
			} else if (target.model !== undefined && !isModelRef(target.model)) {
				errors.push(`pinTargets.${name}.model must be "provider/model"`);
			} else {
				pins[name] = (target.model as string | undefined) ?? (lanes[target.lane as string] as string);
			}
		}
	}
	if (errors.length > 0) return { routing: {}, errors };
	const claude = lanes.claude as string;
	const gpt = lanes.gpt as string;
	return {
		routing: {
			routes: { code: [...new Set([claude, gpt])], live: [...new Set([gpt, claude])], general: "stay" },
			private: lanes.local as string,
			defaultModel: lanes[defaultLane as string] as string,
			pins,
		},
		errors: [],
	};
}

/** Merge a parsed file over the defaults (`ollama` and `routes` field by field) and validate. */
export function parseConfig(raw: unknown): ConfigResult {
	if (!isObject(raw)) return { ok: false, error: "privacy-router.json must contain a JSON object" };
	const misspelled = misspelledKeys(raw);
	if (misspelled.length > 0) return { ok: false, error: misspelled.join("; ") };
	const legacy = LEGACY_KEYS.filter((key) => key in raw);
	const current = V2_KEYS.filter((key) => key in raw);
	if (legacy.length > 0 && current.length > 0) {
		return {
			ok: false,
			error: `privacy-router.json mixes 0.1 keys (${legacy.join(", ")}) with 0.2 keys (${current.join(", ")}); use one format`,
		};
	}
	const { $schema: _schema, lanes: _lanes, defaultLane: _defaultLane, pinTargets: _pinTargets, ...file } = raw;
	let routing: Record<string, unknown> = file;
	if (legacy.length > 0) {
		const translated = translateLegacy(raw);
		if (translated.errors.length > 0) return { ok: false, error: translated.errors.join("; ") };
		routing = { ...file, ...translated.routing };
	}
	if ("routes" in routing && !isObject(routing.routes)) return { ok: false, error: "routes must be an object" };
	if ("ollama" in routing && !isObject(routing.ollama)) return { ok: false, error: "ollama must be an object" };
	const config = {
		...DEFAULT_CONFIG,
		...routing,
		ollama: { ...DEFAULT_CONFIG.ollama, ...(isObject(routing.ollama) ? routing.ollama : {}) },
		routes: { ...DEFAULT_CONFIG.routes, ...(isObject(routing.routes) ? routing.routes : {}) },
	} as RouterConfig;
	// Without an explicit defaultModel, the start model follows the user's own first code model.
	if (!("defaultModel" in routing) && "routes" in routing && isStringArray(config.routes.code)) {
		config.defaultModel = config.routes.code[0] ?? config.defaultModel;
	}
	const errors = validate(config);
	return errors.length > 0 ? { ok: false, error: errors.join("; ") } : { ok: true, config, source: "file" };
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function checkList(value: unknown, path: string, errors: string[]): void {
	if (!Array.isArray(value) || value.length === 0) {
		errors.push(`${path} must be a non-empty list of "provider/model"`);
		return;
	}
	const seen = new Set<unknown>();
	for (const ref of value) {
		if (!isModelRef(ref)) errors.push(`${path} entry ${JSON.stringify(ref)} must be "provider/model"`);
		else if (seen.has(ref)) errors.push(`${path} lists ${ref} twice`);
		seen.add(ref);
	}
}

function validate(config: RouterConfig): string[] {
	const errors: string[] = [];
	if (!isObject(config.routes)) {
		errors.push("routes must be an object");
	} else {
		checkList(config.routes.code, "routes.code", errors);
		checkList(config.routes.live, "routes.live", errors);
		if (config.routes.general !== "stay") {
			if (!Array.isArray(config.routes.general)) errors.push(`routes.general must be "stay" or a list`);
			else checkList(config.routes.general, "routes.general", errors);
		}
	}
	if (!isModelRef(config.private)) errors.push(`private must be "provider/model"`);
	else if (isOllamaCloudModel(splitRef(config.private).id)) {
		errors.push(`private ${config.private} runs on Ollama's cloud; use a local model`);
	}
	if (!isModelRef(config.defaultModel)) errors.push(`defaultModel must be "provider/model"`);
	if (!isObject(config.pins)) {
		errors.push("pins must be an object");
	} else {
		for (const [name, ref] of Object.entries(config.pins)) {
			if (name === "auto") errors.push(`pins: "auto" is reserved`);
			if (!isModelRef(ref)) errors.push(`pins.${name} must be "provider/model"`);
		}
	}
	if (typeof config.minProb !== "number" || config.minProb < 0 || config.minProb > 1) {
		errors.push("minProb must be between 0 and 1");
	}
	if (typeof config.quotaCooldownMinutes !== "number" || config.quotaCooldownMinutes < 1) {
		errors.push("quotaCooldownMinutes must be >= 1");
	}
	if (config.onPrivacyCheckFailure !== "block" && config.onPrivacyCheckFailure !== "warn") {
		errors.push(`onPrivacyCheckFailure must be "block" or "warn"`);
	}
	if (!isStringArray(config.sensitivePaths)) {
		errors.push("sensitivePaths must be an array of strings");
	} else {
		for (const path of config.sensitivePaths) {
			if (!path.startsWith("/") && !path.startsWith("~/")) {
				errors.push(`sensitivePaths entry "${path}" must be absolute or start with ~/`);
			}
		}
	}
	if (!isStringArray(config.extraSecretFilenames)) errors.push("extraSecretFilenames must be an array of strings");
	if (!isStringArray(config.lockedToolAllowlist)) errors.push("lockedToolAllowlist must be an array of strings");
	if (!isLoopbackUrl(config.ollama.baseUrl)) {
		errors.push("ollama.baseUrl must be a localhost URL (classifier input is private text)");
	}
	if (typeof config.ollama.classifierModel === "string" && isOllamaCloudModel(config.ollama.classifierModel)) {
		errors.push(`ollama.classifierModel ${config.ollama.classifierModel} runs on Ollama's cloud; use a local model`);
	}
	if (typeof config.ollama.timeoutMs !== "number" || config.ollama.timeoutMs <= 0) {
		errors.push("ollama.timeoutMs must be > 0");
	}
	return errors;
}

/** Ollama serves `-cloud` / `:cloud` models from its own cloud although the request goes to localhost. */
function isOllamaCloudModel(id: string): boolean {
	return /[-:]cloud$/i.test(id);
}

export function isLoopbackUrl(url: string): boolean {
	try {
		const { protocol, hostname } = new URL(url);
		if (protocol !== "http:" && protocol !== "https:") return false;
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
	} catch {
		return false;
	}
}

export function splitRef(ref: string): { provider: string; id: string } {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}
