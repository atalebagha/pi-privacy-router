import assert from "node:assert/strict";
import { test } from "node:test";
import {
	containsSensitive,
	findSecret,
	findSensitiveToken,
	hasPrivateTag,
	isSecretFilename,
	isSensitivePath,
	type PathPolicy,
	resolveToolPath,
	toolPathHit,
} from "../src/taint.ts";

const HOME = "/Users/me";
const SENSITIVE = ["~/.ssh/**", "~/private-docs/**", "~/.pi/agent/auth.json"];
const policy: PathPolicy = {
	cwd: "/Users/me/Coding/app",
	home: HOME,
	sensitivePaths: SENSITIVE,
	extraSecretFilenames: [],
};

// Built at runtime so this file never contains a literal token that secret scanners flag.
const fake = (prefix: string, length: number) => prefix + "a1B2c3D4e5F6g7H8".repeat(8).slice(0, length);

test("findSecret detects each provider pattern", () => {
	const cases: Array<[string, string]> = [
		[`-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk`, "private-key-block"],
		[`key ${fake("AKIA", 16).toUpperCase()}`, "aws-access-key-id"],
		[`aws_secret_access_key = ${fake("", 40)}`, "aws-secret-access-key"],
		[`token: ${fake("ghp_", 36)}`, "github-token"],
		[`ANTHROPIC_API_KEY=${fake("sk-ant-api03-", 40)}`, "anthropic-key"],
		[`LANGFUSE_SECRET_KEY=${fake("sk-lf-", 32)}`, "langfuse-secret"],
		[`stripe ${fake("sk_live_", 24)}`, "stripe-key"],
		[`OPENAI_API_KEY=${fake("sk-proj-", 40)}`, "openai-key"],
		[`slack ${fake("xoxb-", 30)}`, "slack-token"],
		[`maps ${fake("AIza", 35)}`, "google-api-key"],
		[`Bearer ${fake("eyJ", 20)}.${fake("eyJ", 20)}.${fake("", 20)}`, "jwt"],
		[`db_password = "${fake("Zq9", 20)}"`, "generic-assignment"],
	];
	for (const [text, pattern] of cases) assert.deepEqual(findSecret(text), { pattern }, text);
});

test("findSecret ignores placeholders and code references", () => {
	const clean = [
		"OPENAI_API_KEY=sk-...",
		"api_key = YOUR_API_KEY_GOES_HERE_123",
		"token: <token>",
		"password = xxxxxxxxxxxxxxxxxxxx",
		"apiKey: process.env.OPENAI_API_KEY_2024",
		"token: ${{ secrets.GITHUB_TOKEN }}",
		'const token = "test-token-1234567890abc"',
		"password: hunter2",
		"",
		// Review I2: routine config and identifiers that must not lock a session for good.
		"token_url: https://accounts.google.com/o/oauth2/token",
		"TOKEN_ENDPOINT=https://login.microsoftonline.com/common/oauth2/v2.0/token",
		'secret_id = "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db"',
		"secret_name: projects/123456/secrets/db-pass/versions/1",
		".sk-cube-grid-animation-delay { animation-delay: 0.2s; }",
		"git checkout sk-learn-integration-tests-2024",
	];
	for (const text of clean) assert.equal(findSecret(text), undefined, text);
});

test("a placeholder does not mask a later real secret", () => {
	assert.deepEqual(findSecret(`sk-xxxxxxxxxxxxxxxxxxxxxxxx then ${fake("sk-proj-", 40)}`), { pattern: "openai-key" });
});

test("hasPrivateTag", () => {
	assert.equal(hasPrivateTag("summarize my notes #private"), true);
	assert.equal(hasPrivateTag("#PRIVATE: journal"), true);
	assert.equal(hasPrivateTag("this.#privateField = 1"), false);
	assert.equal(hasPrivateTag("issue ##private-ish"), false);
	// Review M7: only the bare tag counts, not words that merely start with it.
	assert.equal(hasPrivateTag("a #private-ish note"), false);
	assert.equal(hasPrivateTag("keep this #private."), true);
	assert.equal(hasPrivateTag("#private, please"), true);
});

test("`dir/**` matches the directory itself and dot-files inside it", () => {
	assert.equal(isSensitivePath("/Users/me/.ssh", SENSITIVE, HOME), true);
	assert.equal(isSensitivePath("/Users/me/.ssh/id_ed25519", SENSITIVE, HOME), true);
	assert.equal(isSensitivePath("/Users/me/private-docs/.hidden/w2.pdf", SENSITIVE, HOME), true);
	assert.equal(isSensitivePath("/Users/me/private-docs-old/x", SENSITIVE, HOME), false);
	assert.equal(isSensitivePath("/Users/me/.pi/agent/auth.json", SENSITIVE, HOME), true);
	assert.equal(isSensitivePath("/Users/me/.pi/agent/settings.json", SENSITIVE, HOME), false);
});

test("resolveToolPath expands ~, $HOME, ${HOME} and relative paths", () => {
	assert.equal(resolveToolPath("~/.ssh/config", "/tmp", HOME), "/Users/me/.ssh/config");
	assert.equal(resolveToolPath("$HOME/.ssh", "/tmp", HOME), "/Users/me/.ssh");
	assert.equal(resolveToolPath("${HOME}/x", "/tmp", HOME), "/Users/me/x");
	assert.equal(
		resolveToolPath("../../private-docs/a.pdf", "/Users/me/Coding/app", HOME),
		"/Users/me/private-docs/a.pdf",
	);
});

test("containsSensitive: searching an ancestor of a private dir", () => {
	assert.equal(containsSensitive("/Users/me", SENSITIVE, HOME), true);
	assert.equal(containsSensitive("/", SENSITIVE, HOME), true);
	assert.equal(containsSensitive("/Users/me/Coding", SENSITIVE, HOME), false);
});

test("isSecretFilename", () => {
	for (const name of [".env", ".env.local", "server.pem", "id_ed25519", ".netrc", "auth.json", "credentials"]) {
		assert.equal(isSecretFilename(`/x/${name}`, []), true, name);
	}
	for (const name of [".env.example", ".env.sample", "id_ed25519.pub", "package.json", "env.ts"]) {
		assert.equal(isSecretFilename(`/x/${name}`, []), false, name);
	}
	assert.equal(isSecretFilename("/x/vault.txt", ["vault.txt"]), true);
});

test("toolPathHit: file tools on private paths and secret files", () => {
	assert.equal(toolPathHit("read", { path: "~/.ssh/config" }, policy)?.token, "~/.ssh/config");
	assert.equal(toolPathHit("read", { path: ".env" }, policy)?.token, ".env");
	assert.equal(toolPathHit("edit", { path: "src/app.ts" }, policy)?.token, undefined);
	assert.equal(toolPathHit("ls", { path: "/Users/me" }, policy)?.token, undefined);
	assert.equal(toolPathHit("grep", { pattern: "x", path: "/Users/me" }, policy)?.token, "/Users/me");
	assert.equal(toolPathHit("grep", { pattern: "x", path: "/Users/me" }, policy)?.kind, "search-root");
	assert.equal(toolPathHit("read", { path: "~/.ssh/config" }, policy)?.kind, "private-path");
	assert.equal(toolPathHit("read", { path: ".env" }, policy)?.kind, "secret-file");
	assert.equal(toolPathHit("find", { pattern: "*.ts" }, policy)?.token, undefined);
	assert.equal(toolPathHit("mcp_tool", { path: "~/.ssh/config" }, policy)?.token, undefined);
});

test("toolPathHit follows symlinks through realpath", () => {
	const linked = { ...policy, realpath: (p: string) => (p === "/Users/me/Coding/app/keys" ? "/Users/me/.ssh" : p) };
	assert.equal(toolPathHit("read", { path: "keys" }, linked)?.token, "keys");
});

test("toolPathHit: bash commands naming private paths", () => {
	assert.equal(toolPathHit("bash", { command: "cat ~/.ssh/id_ed25519" }, policy)?.token, "~/.ssh/id_ed25519");
	assert.equal(toolPathHit("bash", { command: "grep -r KEY .env" }, policy)?.token, ".env");
	assert.equal(toolPathHit("bash", { command: "cat $HOME/.aws/credentials" }, policy)?.token, "$HOME/.aws/credentials");
	assert.equal(
		toolPathHit("bash", { command: "cp report.pdf ~/private-docs/2026/" }, policy)?.token,
		"~/private-docs/2026/",
	);
	assert.equal(toolPathHit("bash", { command: "npm test && git status" }, policy)?.token, undefined);
});

test("findSensitiveToken in user text skips secret filenames", () => {
	assert.equal(findSensitiveToken("summarize ~/private-docs/w2.pdf please", policy, false), "~/private-docs/w2.pdf");
	assert.equal(findSensitiveToken("my .env has a bug in DATABASE_URL", policy, false), undefined);
});
