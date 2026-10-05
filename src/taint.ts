/**
 * Deterministic sensitivity detectors. Pure: no I/O except an injectable `realpath`.
 *
 * Path patterns ending in `/**` use prefix matching on purpose: Node's `path.matchesGlob` does not
 * match dot-segments under `**` (`~/tax/**` would miss `~/tax/.hidden/w2.pdf`) or the directory
 * itself (`~/.ssh/**` would miss `~/.ssh`).
 */

import { basename, isAbsolute, matchesGlob, resolve } from "node:path";

export interface SecretPattern {
	name: string;
	/** Must carry the `g` flag; every match is checked so a placeholder cannot mask a real secret. */
	re: RegExp;
	/** Capture group holding the value; whole match when absent. */
	group?: number;
	/** Keyword assignments need extra evidence that the value is a real secret. */
	generic?: boolean;
	/** Extra shape check on the matched value; a match failing it is not a secret. */
	check?: (value: string) => boolean;
}

/** Real provider keys are random base62: digits plus both letter cases. `sk-cube-grid-animation` is not. */
const looksRandom = (value: string): boolean => /\d/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value);

const URL_PASSWORD_WORDS = /pass|secret|example|changeme|dummy|sample|test|fake|mock/i;

/** A password in a URL counts only when it has the shape of a real one: 8+ characters, a digit and a letter, no filler words. */
const urlPasswordLooksReal = (value: string): boolean =>
	value.length >= 8 && /\d/.test(value) && /[A-Za-z]/.test(value) && !URL_PASSWORD_WORDS.test(value);

/** Order matters: the first pattern with a real match names the hit (`sk-ant-` before `sk-`). */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
	{ name: "private-key-block", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g },
	{ name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{
		name: "aws-secret-access-key",
		re: /aws_secret_access_key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
		group: 1,
	},
	{ name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
	{ name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ name: "langfuse-secret", re: /\bsk-lf-[A-Za-z0-9-]{20,}/g },
	{ name: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
	{ name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, check: looksRandom },
	{ name: "slack-token", re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
	{ name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
	{ name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
	{
		name: "url-credentials",
		// scheme://user:password@host; the quantifiers are bounded so long text cannot make the scan slow.
		re: /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,100}:([^\s@/]{1,256})@/gi,
		group: 1,
		check: urlPasswordLooksReal,
	},
	{
		name: "generic-assignment",
		// No leading \b: keywords sit inside identifiers like DB_PASSWORD and client_secret.
		re: /(?:secret|token|password|passwd|api[_-]?key)\w{0,40}["']?\s*[:=]\s*["']?([^\s"'`,;)]{16,})/gi,
		group: 1,
		generic: true,
	},
];

const PLACEHOLDER = /\.\.\.|x{3,}|your[_-]|[<>]|example|changeme|placeholder|redacted|\*{3,}/i;
const GENERIC_FAKE = /fake|mock|dummy|sample|test/i;
const DOTTED_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

export function isPlaceholder(value: string): boolean {
	return PLACEHOLDER.test(value) || /^(.)\1+$/.test(value);
}

export function shannonEntropy(value: string): number {
	const counts = new Map<string, number>();
	for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let entropy = 0;
	for (const count of counts.values()) {
		const p = count / value.length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

/**
 * `password = process.env.DB_PASSWORD` and `token: ${{ secrets.X }}` are references, not secrets;
 * so are URLs (`token_url: https://…/token`), ARNs and resource paths (`projects/1/secrets/x/versions/1`).
 */
function genericLooksSecret(value: string): boolean {
	return (
		/\d/.test(value) &&
		/[A-Za-z]/.test(value) &&
		!DOTTED_IDENTIFIER.test(value) &&
		!value.startsWith("$") &&
		!value.includes("://") &&
		!value.startsWith("arn:") &&
		(value.match(/:/g)?.length ?? 0) < 2 &&
		(value.match(/\//g)?.length ?? 0) < 2 &&
		!GENERIC_FAKE.test(value) &&
		shannonEntropy(value) >= 3.5
	);
}

export function findSecret(text: string): { pattern: string } | undefined {
	if (text === "") return undefined;
	for (const pattern of SECRET_PATTERNS) {
		for (const match of text.matchAll(pattern.re)) {
			const value = pattern.group === undefined ? match[0] : match[pattern.group];
			if (!value || isPlaceholder(value)) continue;
			if (pattern.generic && !genericLooksSecret(value)) continue;
			if (pattern.check && !pattern.check(value)) continue;
			return { pattern: pattern.name };
		}
	}
	return undefined;
}

/** The bare tag only: `#private-ish` and `#privateField` are other words. */
const PRIVATE_TAG = /(^|[^\w#])#private(?![\w-])/i;

export function hasPrivateTag(text: string): boolean {
	return PRIVATE_TAG.test(text);
}

export function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return home + path.slice(1);
	return path;
}

/** Absolute, normalized path for a tool argument: expands `~`, `$HOME`, `${HOME}`; resolves relative to cwd. */
export function resolveToolPath(path: string, cwd: string, home: string): string {
	const expanded = expandHome(path.replace(/^\$\{?HOME\}?(?=\/|$)/, home), home);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

const GLOB_CHARS = /[*?[\]{}]/;

export function matchesSensitive(absPath: string, pattern: string, home: string): boolean {
	const expanded = expandHome(pattern, home);
	if (expanded.endsWith("/**")) {
		const dir = expanded.slice(0, -3);
		return absPath === dir || absPath.startsWith(`${dir}/`);
	}
	if (GLOB_CHARS.test(expanded)) return matchesGlob(absPath, expanded);
	return absPath === expanded || absPath.startsWith(`${expanded}/`);
}

export function isSensitivePath(absPath: string, patterns: readonly string[], home: string): boolean {
	return patterns.some((pattern) => matchesSensitive(absPath, pattern, home));
}

/** True when a recursive search rooted at `absDir` would reach a sensitive pattern's root. */
export function containsSensitive(absDir: string, patterns: readonly string[], home: string): boolean {
	const prefix = absDir.endsWith("/") ? absDir : `${absDir}/`;
	return patterns.some((pattern) => {
		const expanded = expandHome(pattern, home);
		const globAt = expanded.search(GLOB_CHARS);
		const root = (globAt === -1 ? expanded : expanded.slice(0, globAt)).replace(/\/+$/, "");
		return root.startsWith(prefix);
	});
}

const SECRET_FILENAMES: readonly RegExp[] = [
	/^\.env$/,
	/^\.env\.(?!example$|sample$|template$).+$/,
	/\.(?:pem|key|p12|pfx|kdbx)$/,
	/^id_(?:rsa|ed25519|ecdsa|dsa)$/,
	/^\.(?:netrc|npmrc|pgpass)$/,
	/^(?:auth|credentials)\.json$/,
	/^credentials$/,
];

export function isSecretFilename(path: string, extra: readonly string[]): boolean {
	const name = basename(path);
	return SECRET_FILENAMES.some((re) => re.test(name)) || extra.includes(name);
}

export interface PathPolicy {
	cwd: string;
	home: string;
	sensitivePaths: readonly string[];
	extraSecretFilenames: readonly string[];
	/** Resolves symlinks for existing paths; identity when omitted. */
	realpath?: (path: string) => string;
}

function looksLikePath(token: string): boolean {
	return token.includes("/") || token.startsWith("~") || token.startsWith(".") || token.startsWith("$");
}

/**
 * First token in free text or a shell command that names a sensitive path (or, when
 * `includeSecretFilenames`, a secret filename). Best effort: shell indirection defeats it.
 */
export function findSensitiveToken(
	text: string,
	policy: PathPolicy,
	includeSecretFilenames: boolean,
): string | undefined {
	for (const token of text.split(/[\s;|&<>()`'"=,]+/)) {
		if (token === "") continue;
		if (includeSecretFilenames && isSecretFilename(token, policy.extraSecretFilenames)) return token;
		if (!looksLikePath(token)) continue;
		const abs = resolveToolPath(token, policy.cwd, policy.home);
		if (isSensitivePath(abs, policy.sensitivePaths, policy.home)) return token;
	}
	return undefined;
}

const PATH_TOOLS = new Set(["read", "edit", "write", "ls", "grep", "find"]);
const SEARCH_TOOLS = new Set(["grep", "find"]);

export interface PathHit {
	/** The path or command token as the tool call wrote it. */
	token: string;
	/** `search-root`: the path itself is fine, but a recursive search from it would reach a private folder. */
	kind: "private-path" | "secret-file" | "search-root";
}

/** The private path a built-in tool call would touch, or undefined. Non-built-in tools are not inspected. */
export function toolPathHit(toolName: string, input: Record<string, unknown>, policy: PathPolicy): PathHit | undefined {
	if (toolName === "bash") {
		const token = typeof input.command === "string" ? findSensitiveToken(input.command, policy, true) : undefined;
		return token === undefined ? undefined : { token, kind: "private-path" };
	}
	if (!PATH_TOOLS.has(toolName)) return undefined;
	const raw = typeof input.path === "string" && input.path !== "" ? input.path : ".";
	const abs = resolveToolPath(raw, policy.cwd, policy.home);
	const candidates = policy.realpath ? [abs, policy.realpath(abs)] : [abs];
	for (const path of candidates) {
		if (isSensitivePath(path, policy.sensitivePaths, policy.home)) return { token: raw, kind: "private-path" };
		if (isSecretFilename(path, policy.extraSecretFilenames)) return { token: raw, kind: "secret-file" };
		if (SEARCH_TOOLS.has(toolName) && containsSensitive(path, policy.sensitivePaths, policy.home)) {
			return { token: raw, kind: "search-root" };
		}
	}
	return undefined;
}
