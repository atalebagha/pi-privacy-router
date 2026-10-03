/**
 * Router configuration: `~/.pi/agent/privacy-router.json` (override the path with PI_PRIVACY_ROUTER_CONFIG).
 *
 * An absent file means built-in defaults. A present but invalid file is an error: silently
 * ignoring it could drop the user's `sensitivePaths`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CloudLane, Lane } from "./state.ts";

export interface PinTarget {
	lane: CloudLane;
	/** "provider/model" that replaces the lane's model while pinned. */
	model?: string;
}

export interface RouterConfig {
	ollama: { baseUrl: string; classifierModel: string; timeoutMs: number; keepAlive: string };
	/** "provider/model" per lane. */
	lanes: Record<Lane, string>;
	defaultLane: CloudLane;
	pinTargets: Record<string, PinTarget>;
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

export const DEFAULT_CONFIG: RouterConfig = {
	ollama: { baseUrl: "http://localhost:11434", classifierModel: "qwen3:8b", timeoutMs: 1500, keepAlive: "30m" },
	lanes: {
		claude: "anthropic/claude-sonnet-5",
		gpt: "openai-codex/gpt-6-sol",
		local: "ollama/qwen3.6:35b-pi",
	},
	defaultLane: "claude",
	pinTargets: {
		claude: { lane: "claude" },
		"claude-max": { lane: "claude", model: "anthropic/claude-opus-5" },
		gpt: { lane: "gpt" },
	},
	minProb: 0.6,
	quotaCooldownMinutes: 60,
	onPrivacyCheckFailure: "block",
	sensitivePaths: ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.config/gh/**", "~/.pi/agent/auth.json"],
	extraSecretFilenames: [],
	lockedToolAllowlist: ["read", "write", "edit", "bash", "grep", "find", "ls", "todo", "ask_user_question"],
};

const LANES: readonly Lane[] = ["claude", "gpt", "local"];
const CLOUD_LANES: readonly string[] = ["claude", "gpt"];
const MODEL_REF = /^[^/\s]+\/\S+$/;

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

function unknownKeys(value: unknown, allowed: readonly string[], where: string): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
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
		...unknownKeys(raw, [...Object.keys(DEFAULT_CONFIG), "$schema"], ""),
		...unknownKeys(raw.ollama, Object.keys(DEFAULT_CONFIG.ollama), "ollama."),
		...unknownKeys(raw.lanes, LANES, "lanes."),
	];
	if (typeof raw.pinTargets === "object" && raw.pinTargets !== null) {
		for (const [name, target] of Object.entries(raw.pinTargets)) {
			errors.push(...unknownKeys(target, ["lane", "model"], `pinTargets.${name}.`));
		}
	}
	return errors;
}

/** Merge a parsed file over the defaults (`ollama` and `lanes` field by field) and validate. */
export function parseConfig(raw: unknown): ConfigResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "privacy-router.json must contain a JSON object" };
	}
	const misspelled = misspelledKeys(raw as Record<string, unknown>);
	if (misspelled.length > 0) return { ok: false, error: misspelled.join("; ") };
	const { $schema: _schema, ...file } = raw as Partial<RouterConfig> & { $schema?: unknown };
	const config: RouterConfig = {
		...DEFAULT_CONFIG,
		...file,
		ollama: { ...DEFAULT_CONFIG.ollama, ...file.ollama },
		lanes: { ...DEFAULT_CONFIG.lanes, ...file.lanes },
	};
	const errors = validate(config);
	return errors.length > 0 ? { ok: false, error: errors.join("; ") } : { ok: true, config, source: "file" };
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validate(config: RouterConfig): string[] {
	const errors: string[] = [];
	for (const lane of LANES) {
		if (typeof config.lanes[lane] !== "string" || !MODEL_REF.test(config.lanes[lane])) {
			errors.push(`lanes.${lane} must be "provider/model"`);
		}
	}
	if (!CLOUD_LANES.includes(config.defaultLane)) errors.push(`defaultLane must be "claude" or "gpt"`);
	if (typeof config.pinTargets !== "object" || config.pinTargets === null) {
		errors.push("pinTargets must be an object");
	} else {
		for (const [name, target] of Object.entries(config.pinTargets)) {
			if (name === "auto") errors.push(`pinTargets: "auto" is reserved`);
			if (!target || !CLOUD_LANES.includes(target.lane))
				errors.push(`pinTargets.${name}.lane must be "claude" or "gpt"`);
			if (target?.model !== undefined && (typeof target.model !== "string" || !MODEL_REF.test(target.model))) {
				errors.push(`pinTargets.${name}.model must be "provider/model"`);
			}
		}
	}
	if (typeof config.minProb !== "number" || config.minProb < 0 || config.minProb > 1) {
		errors.push("minProb must be between 0 and 1");
	}
	if (typeof config.quotaCooldownMinutes !== "number" || config.quotaCooldownMinutes < 0) {
		errors.push("quotaCooldownMinutes must be >= 0");
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
	if (typeof config.ollama.timeoutMs !== "number" || config.ollama.timeoutMs <= 0) {
		errors.push("ollama.timeoutMs must be > 0");
	}
	return errors;
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

/** Lane a physical model belongs to: exact lane or pin-target match first, then by provider. */
export function laneOfModel(provider: string, id: string, config: RouterConfig): Lane | undefined {
	const ref = `${provider}/${id}`;
	for (const lane of LANES) if (config.lanes[lane] === ref) return lane;
	for (const target of Object.values(config.pinTargets)) if (target.model === ref) return target.lane;
	for (const lane of LANES) if (splitRef(config.lanes[lane]).provider === provider) return lane;
	return undefined;
}
