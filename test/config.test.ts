import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, DEFAULT_CONFIG, isLoopbackUrl, loadConfig, parseConfig } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-router-config-"));
const SONNET = "anthropic/claude-sonnet-5";
const OPUS = "anthropic/claude-opus-5";
const GPT = "openai-codex/gpt-6-sol";
const GEMINI = "google/gemini-3-pro";

test("absent file → defaults", () => {
	const result = loadConfig(join(dir, "missing.json"));
	assert.deepEqual(result, { ok: true, config: DEFAULT_CONFIG, source: "defaults" });
});

test("invalid JSON → error, never defaults", () => {
	const path = join(dir, "broken.json");
	writeFileSync(path, "{ not json");
	const result = loadConfig(path);
	assert.equal(result.ok, false);
});

test("the 0.2 defaults are the 0.1 models in the new shape", () => {
	assert.deepEqual(DEFAULT_CONFIG.routes, { code: [SONNET, GPT], live: [GPT, SONNET], general: "stay" });
	assert.equal(DEFAULT_CONFIG.private, "ollama/qwen3.6:35b-pi");
	assert.equal(DEFAULT_CONFIG.defaultModel, SONNET);
	assert.deepEqual(DEFAULT_CONFIG.pins, { claude: SONNET, "claude-max": OPUS, gpt: GPT });
});

test("file merges over defaults; ollama and routes merge per field", () => {
	const result = parseConfig({ routes: { live: [GEMINI, GPT] }, ollama: { timeoutMs: 900 } });
	assert.ok(result.ok);
	assert.deepEqual(result.config.routes, { code: [SONNET, GPT], live: [GEMINI, GPT], general: "stay" });
	assert.equal(result.config.ollama.timeoutMs, 900);
	assert.equal(result.config.ollama.classifierModel, "qwen3:8b");
	assert.equal(result.source, "file");
});

test("routes take any providers and lengths, and general may be a list", () => {
	const result = parseConfig({
		routes: { code: ["openrouter/anthropic/claude-x"], live: [GEMINI], general: [GPT] },
		defaultModel: GEMINI,
		pins: { fast: GEMINI },
	});
	assert.ok(result.ok, result.ok ? "" : result.error);
	assert.deepEqual(result.config.routes.general, [GPT]);
	assert.deepEqual(result.config.pins, { fast: GEMINI });
});

test("validation rejects bad values", () => {
	const cases: unknown[] = [
		[],
		{ routes: { code: [] } },
		{ routes: { code: ["no-slash"] } },
		{ routes: { live: [GPT, GPT] } },
		{ routes: { general: "sometimes" } },
		{ routes: { general: [] } },
		{ routes: "x" },
		{ routes: null },
		{ routes: [["anthropic/claude-x"]] },
		{ ollama: "x" },
		{ private: "local-model" },
		{ defaultModel: 5 },
		{ pins: { auto: SONNET } },
		{ pins: { mine: "no-slash" } },
		{ minProb: 2 },
		{ onPrivacyCheckFailure: "ignore" },
		{ sensitivePaths: ["relative/dir/**"] },
		{ ollama: { baseUrl: "http://gpu-box.lan:11434" } },
		{ lockedToolAllowlist: "read" },
		// 0.1 keys are still validated before translation.
		{ lanes: { claude: "no-slash" } },
		{ defaultLane: "local" },
		{ pinTargets: { mine: { lane: "local" } } },
		{ pinTargets: { auto: { lane: "claude" } } },
	];
	for (const raw of cases) assert.equal(parseConfig(raw).ok, false, JSON.stringify(raw));
});

test("a 0.1 config is translated to 0.2 (spec §3)", () => {
	const result = parseConfig({
		lanes: { claude: OPUS, local: "ollama/llama3" },
		defaultLane: "gpt",
		pinTargets: { deep: { lane: "claude" }, quick: { lane: "gpt", model: GEMINI } },
	});
	assert.ok(result.ok, result.ok ? "" : result.error);
	assert.deepEqual(result.config.routes, { code: [OPUS, GPT], live: [GPT, OPUS], general: "stay" });
	assert.equal(result.config.private, "ollama/llama3");
	assert.equal(result.config.defaultModel, GPT);
	assert.deepEqual(result.config.pins, { deep: OPUS, quick: GEMINI });
});

test("a 0.1 file with some 0.1 keys takes 0.1 defaults for the rest", () => {
	const result = parseConfig({ defaultLane: "gpt" });
	assert.ok(result.ok);
	assert.deepEqual(result.config.routes, DEFAULT_CONFIG.routes);
	assert.equal(result.config.defaultModel, GPT);
	assert.deepEqual(result.config.pins, DEFAULT_CONFIG.pins);
});

test("a 0.1 config whose two lanes share a model lists it once", () => {
	const result = parseConfig({ lanes: { claude: GPT, gpt: GPT } });
	assert.ok(result.ok, result.ok ? "" : result.error);
	assert.deepEqual(result.config.routes.code, [GPT]);
	assert.deepEqual(result.config.routes.live, [GPT]);
});

test("mixing 0.1 and 0.2 keys is an error", () => {
	const result = parseConfig({ lanes: { claude: OPUS }, routes: { code: [OPUS] } });
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /mixes 0\.1 keys \(lanes\) with 0\.2 keys \(routes\)/);
});

test("isLoopbackUrl", () => {
	assert.equal(isLoopbackUrl("http://localhost:11434/v1"), true);
	assert.equal(isLoopbackUrl("http://127.0.0.1:11434"), true);
	assert.equal(isLoopbackUrl("http://[::1]:11434"), true);
	assert.equal(isLoopbackUrl("https://ollama.example.com"), false);
	assert.equal(isLoopbackUrl("not a url"), false);
});

test("review I3: misspelled keys are rejected instead of silently dropping protection", () => {
	for (const raw of [
		{ sensitivePath: ["~/x/**"] },
		{ lockedToolAllowList: ["read"] },
		{ ollama: { timeoutMS: 8000 } },
		{ routes: { cod: [SONNET] } },
		{ pinTargets: { mine: { lane: "claude", modle: "anthropic/claude-opus-5" } } },
	]) {
		assert.equal(parseConfig(raw).ok, false, JSON.stringify(raw));
	}
	assert.equal(parseConfig({ $schema: "./router.schema.json", minProb: 0.5 }).ok, true);
});

test("the config file is privacy-router.json, overridable with PI_PRIVACY_ROUTER_CONFIG", () => {
	const previous = process.env.PI_PRIVACY_ROUTER_CONFIG;
	try {
		delete process.env.PI_PRIVACY_ROUTER_CONFIG;
		assert.equal(configPath(), join(homedir(), ".pi", "agent", "privacy-router.json"));
		process.env.PI_PRIVACY_ROUTER_CONFIG = "/tmp/custom.json";
		assert.equal(configPath(), "/tmp/custom.json");
	} finally {
		if (previous === undefined) delete process.env.PI_PRIVACY_ROUTER_CONFIG;
		else process.env.PI_PRIVACY_ROUTER_CONFIG = previous;
	}
});

test("routes without defaultModel make the first code model the start model", () => {
	const result = parseConfig({ routes: { code: [GPT], live: [GPT] } });
	assert.ok(result.ok);
	assert.equal(result.config.defaultModel, GPT);
});

test("an explicit defaultModel wins over the first code model", () => {
	const result = parseConfig({ routes: { code: [GPT], live: [GPT] }, defaultModel: OPUS });
	assert.ok(result.ok);
	assert.equal(result.config.defaultModel, OPUS);
});

test("a partial routes override that keeps the default code list keeps the default start model", () => {
	const result = parseConfig({ routes: { live: [GEMINI, GPT] } });
	assert.ok(result.ok);
	assert.equal(result.config.defaultModel, SONNET);
});
