import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, DEFAULT_CONFIG, isLoopbackUrl, laneOfModel, loadConfig, parseConfig } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-router-config-"));

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

test("file merges over defaults; ollama and lanes merge per field", () => {
	const result = parseConfig({ lanes: { claude: "anthropic/claude-opus-5" }, ollama: { timeoutMs: 900 } });
	assert.ok(result.ok);
	assert.equal(result.config.lanes.claude, "anthropic/claude-opus-5");
	assert.equal(result.config.lanes.gpt, DEFAULT_CONFIG.lanes.gpt);
	assert.equal(result.config.ollama.timeoutMs, 900);
	assert.equal(result.config.ollama.classifierModel, "qwen3:8b");
	assert.equal(result.source, "file");
});

test("validation rejects bad values", () => {
	const cases: unknown[] = [
		[],
		{ lanes: { claude: "no-slash" } },
		{ defaultLane: "local" },
		{ pinTargets: { mine: { lane: "local" } } },
		{ pinTargets: { auto: { lane: "claude" } } },
		{ minProb: 2 },
		{ onPrivacyCheckFailure: "ignore" },
		{ sensitivePaths: ["relative/dir/**"] },
		{ ollama: { baseUrl: "http://gpu-box.lan:11434" } },
		{ lockedToolAllowlist: "read" },
	];
	for (const raw of cases) assert.equal(parseConfig(raw).ok, false, JSON.stringify(raw));
});

test("isLoopbackUrl", () => {
	assert.equal(isLoopbackUrl("http://localhost:11434/v1"), true);
	assert.equal(isLoopbackUrl("http://127.0.0.1:11434"), true);
	assert.equal(isLoopbackUrl("http://[::1]:11434"), true);
	assert.equal(isLoopbackUrl("https://ollama.example.com"), false);
	assert.equal(isLoopbackUrl("not a url"), false);
});

test("laneOfModel: exact lane, pin-target model, then provider", () => {
	assert.equal(laneOfModel("anthropic", "claude-sonnet-5", DEFAULT_CONFIG), "claude");
	assert.equal(laneOfModel("anthropic", "claude-opus-5", DEFAULT_CONFIG), "claude");
	assert.equal(laneOfModel("anthropic", "claude-haiku-4-5", DEFAULT_CONFIG), "claude");
	assert.equal(laneOfModel("openai-codex", "gpt-6-luna", DEFAULT_CONFIG), "gpt");
	assert.equal(laneOfModel("ollama", "qwen3.6:35b-pi", DEFAULT_CONFIG), "local");
	assert.equal(laneOfModel("deepseek", "deepseek-flash", DEFAULT_CONFIG), undefined);
});

test("review I3: misspelled keys are rejected instead of silently dropping protection", () => {
	for (const raw of [
		{ sensitivePath: ["~/x/**"] },
		{ lockedToolAllowList: ["read"] },
		{ ollama: { timeoutMS: 8000 } },
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
