/**
 * pi-privacy-router: registers `privacy-router/auto`, a virtual model that routes each request.
 *
 * - claude lane: coding and planning; gpt lane: live data; general messages stay put.
 * - Sensitive sessions lock sticky-local to Ollama, and egress tools are blocked.
 * - `route()` runs before every request, so it is the egress chokepoint: it scans the payload about
 *   to leave the machine, including tool results, before choosing a model.
 *
 * Decisions live in policy.ts and taint.ts (pure). This file gathers signals and applies results.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	generateSummary,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import {
	CATEGORIES,
	categoryPrompt,
	isAcknowledgement,
	type Labeled,
	PII_LABELS,
	type Category,
	parseLabel,
	piiPrompt,
} from "./classify.ts";
import { configPath, isLoopbackUrl, laneOfModel, loadConfig, type RouterConfig, splitRef } from "./config.ts";
import {
	estimateInputTokens,
	fileLists,
	handoffNote,
	localSummaryBudget,
	planHandoff,
	rewindTarget,
} from "./handoff.ts";
import { askOneWord, type OllamaOptions, warmUp } from "./ollama.ts";
import {
	applyCooldowns,
	type Decision,
	decide,
	isQuotaError,
	needsClassification,
	planQuotaFailover,
	RouterError,
	type Signals,
} from "./policy.ts";
import {
	type BranchEntry,
	COMMAND_ENTRY,
	type CloudLane,
	firstLockIndex,
	isLocked,
	type Lane,
	type RouterCommand,
	type RouterState,
	ROUTER_MODEL_ID,
	ROUTER_PROVIDER,
	readCommands,
	readRouterState,
} from "./state.ts";
import {
	findSecret,
	findSensitiveToken,
	hasPrivateTag,
	isSensitivePath,
	type PathPolicy,
	toolPathHit,
} from "./taint.ts";

const HOME = homedir();
const PATH_BLOCK_REASON = "Blocked: this path is private. Ask the user to run /local to work on it.";
const SEARCH_BLOCK_REASON =
	"Blocked: this search would reach private folders. Narrow the path to a project folder, or ask the user to run /local.";

type TextBlock = { type: string; text?: string };

function textOf(content: string | readonly TextBlock[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" && block.text ? block.text : "")).join("\n");
}

/**
 * User-authored text and tool output since the latest *successful* assistant message: what this
 * request adds. Failed or aborted replies (including a refused route) do not count, so a message
 * whose privacy check failed is checked again on the next turn instead of riding along unchecked.
 */
export function deltaText(messages: readonly Message[]): { user: string; tool: string } {
	const start =
		messages.findLastIndex(
			(message) => message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted",
		) + 1;
	const user: string[] = [];
	const tool: string[] = [];
	for (const message of messages.slice(start)) {
		if (message.role === "user") user.push(textOf(message.content));
		else if (message.role === "toolResult") tool.push(textOf(message.content));
	}
	return { user: user.join("\n"), tool: tool.join("\n") };
}

function safeRealpath(path: string): string {
	try {
		// .native canonicalizes letter case on case-insensitive filesystems (macOS), so ~/.SSH matches ~/.ssh/**.
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

function readBranch(ctx: ExtensionContext): readonly BranchEntry[] | undefined {
	try {
		return ctx.sessionManager.getBranch();
	} catch {
		return undefined;
	}
}

function readBranchAt(ctx: ExtensionContext, leafId: string): readonly BranchEntry[] | undefined {
	try {
		return ctx.sessionManager.getBranch(leafId);
	} catch {
		return undefined;
	}
}

function requireConfig(): RouterConfig {
	const loaded = loadConfig();
	if (!loaded.ok) throw new RouterError(`privacy-router.json invalid: ${loaded.error}`);
	return loaded.config;
}

function ollamaOptions(config: RouterConfig): OllamaOptions {
	return {
		baseUrl: config.ollama.baseUrl,
		model: config.ollama.classifierModel,
		timeoutMs: config.ollama.timeoutMs,
		keepAlive: config.ollama.keepAlive,
	};
}

function pathPolicy(config: RouterConfig, cwd: string): PathPolicy {
	return {
		cwd,
		home: HOME,
		sensitivePaths: config.sensitivePaths,
		extraSecretFilenames: config.extraSecretFilenames,
		realpath: safeRealpath,
	};
}

function usingRouter(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === ROUTER_PROVIDER && ctx.model.id === ROUTER_MODEL_ID;
}

function modelFor(ref: string, ctx: ExtensionContext, lane: Lane) {
	const { provider, id } = splitRef(ref);
	const model = ctx.modelRegistry.find(provider, id);
	if (!model) throw new RouterError(`Model ${ref} is not in pi's catalog.`);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new RouterError(`Model ${ref} has no credentials.`);
	if (lane === "local" && !isLoopbackUrl(model.baseUrl)) {
		throw new RouterError(`Local lane model ${ref} is not served from localhost (${model.baseUrl}).`);
	}
	return model;
}

function disabledLanes(config: RouterConfig, ctx: ExtensionContext): CloudLane[] {
	return (["claude", "gpt"] as const).filter((lane) => {
		try {
			modelFor(config.lanes[lane], ctx, lane);
			return false;
		} catch {
			return true;
		}
	});
}

async function classifyCategory(config: RouterConfig, text: string, signal?: AbortSignal): Promise<Labeled<Category>> {
	const output = await askOneWord(ollamaOptions(config), categoryPrompt(text), signal);
	const parsed = parseLabel(output.content, output.logprob, CATEGORIES);
	if (!parsed) throw new Error(`unexpected category output ${JSON.stringify(output.content)}`);
	return parsed;
}

async function classifyPii(config: RouterConfig, text: string, signal?: AbortSignal): Promise<"yes" | "no"> {
	const output = await askOneWord(ollamaOptions(config), piiPrompt(text), signal);
	const parsed = parseLabel(output.content, output.logprob, PII_LABELS);
	if (!parsed) throw new Error(`unexpected privacy output ${JSON.stringify(output.content)}`);
	return parsed.label;
}

function footerText(decision: Decision): string | undefined {
	const { target, why } = decision;
	if (target.kind === "lane" && target.lane === "local") return `🔒 local · ${why.replace(/^lock(ed)?:/, "")}`;
	if (why.startsWith("pin:")) return `📌 ${why.slice(4)}`;
	if (why === "classifier down") return "⚠ classifier down";
	if (target.kind === "lane" || target.kind === "ref") return `→ ${target.lane} · ${why}`;
	return undefined;
}

export interface RouterDeps {
	/** pi's compaction summarizer; tests replace it. */
	summarize: typeof generateSummary;
}

const SUMMARY_RETRY = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

const defaultDeps: RouterDeps = {
	// Loaded on first use: pi aliases this package to its own copy, which has the providers registered.
	summarize: async (...args) => (await import("@earendil-works/pi-coding-agent")).generateSummary(...args),
};

function withoutDeletedHeaders(headers: Record<string, string | null> | undefined) {
	if (!headers) return undefined;
	return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

export default function router(pi: ExtensionAPI, deps: RouterDeps = defaultDeps): void {
	let toolsBeforeLock: string[] | undefined;
	let lastNotice: string | undefined;
	let lastDecision = "none";
	let classifierHealth = "not used yet";
	let defaultsNoticeShown = false;

	function restrictTools(config: RouterConfig): void {
		const active = pi.getActiveTools();
		const allowed = new Set(config.lockedToolAllowlist);
		// On resume or reload pi has already restored the locked transcript's loadout; snapshotting that
		// restricted set would later "restore" an unlocked branch to the allowlist.
		if (toolsBeforeLock === undefined && !active.every((name) => allowed.has(name))) toolsBeforeLock = active;
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools(config.lockedToolAllowlist.filter((name) => registered.has(name)));
	}

	function restoreTools(): void {
		if (!toolsBeforeLock) return;
		pi.setActiveTools(toolsBeforeLock);
		toolsBeforeLock = undefined;
	}

	function syncTools(ctx: ExtensionContext): void {
		const branch = readBranch(ctx);
		if (branch === undefined || isLocked(branch)) {
			const loaded = loadConfig();
			if (loaded.ok) restrictTools(loaded.config);
		} else {
			restoreTools();
		}
	}

	function report(ctx: ExtensionContext, decision: Decision, signals: Signals, startedAt: number): void {
		const p = signals.category && signals.category !== "error" ? ` p=${signals.category.p.toFixed(2)}` : "";
		lastDecision = `${decision.why}${p} · ${Date.now() - startedAt} ms`;
		if (!ctx.hasUI) return;
		const footer = footerText(decision);
		if (footer) ctx.ui.setStatus("privacy-router", footer);
		if (decision.notice && decision.notice !== lastNotice) {
			ctx.ui.notify(decision.notice, decision.state?.locked ? "warning" : "info");
		}
		lastNotice = decision.notice;
	}

	function targetModel(
		decision: Decision,
		request: ModelRouteRequest<RouterState>,
		ctx: ExtensionContext,
		config: RouterConfig,
	) {
		const { target } = decision;
		switch (target.kind) {
			case "previous":
				if (!request.previous) throw new RouterError("internal: no previous model to continue on");
				return request.previous.model;
			case "failed":
				if (!request.failed) throw new RouterError("internal: no failed model to retry");
				return request.failed.model;
			case "lane":
				return modelFor(config.lanes[target.lane], ctx, target.lane);
			case "ref":
				return modelFor(target.ref, ctx, target.lane);
		}
	}

	function thinkingFor(decision: Decision, request: ModelRouteRequest<RouterState>) {
		if (decision.target.kind === "previous") return request.previous?.thinkingLevel ?? request.thinkingLevel;
		if (decision.target.kind === "failed") return request.failed?.thinkingLevel ?? request.thinkingLevel;
		return request.thinkingLevel;
	}

	pi.registerVirtualModel<RouterState>({
		provider: ROUTER_PROVIDER,
		id: ROUTER_MODEL_ID,
		name: "Auto (router)",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
		async route(request, ctx) {
			const startedAt = Date.now();
			const config = requireConfig();
			const branch = readBranch(ctx);
			const commands = branch ? readCommands(branch) : { lockRequested: false, pin: undefined, cooldowns: {} };
			const state = applyCooldowns(
				request.state ?? (branch ? readRouterState(branch) : undefined),
				commands.cooldowns,
				config.defaultLane,
			);
			const delta = deltaText(request.messages);
			const policy = pathPolicy(config, ctx.cwd);
			const secretInUser = findSecret(delta.user);
			const secretInTool = secretInUser ? undefined : findSecret(delta.tool);
			const pin = commands.pin === undefined ? undefined : config.pinTargets[commands.pin];

			const signals: Signals = {
				reason: request.reason,
				branchReadable: branch !== undefined,
				lockRequested: commands.lockRequested,
				cwdSensitive: isSensitivePath(safeRealpath(ctx.cwd), config.sensitivePaths, HOME),
				privateTag: hasPrivateTag(delta.user),
				pathMention: findSensitiveToken(delta.user, policy, false),
				secret: secretInUser
					? `${secretInUser.pattern} in message`
					: secretInTool
						? `${secretInTool.pattern} in tool result`
						: undefined,
				pinName: pin ? commands.pin : undefined,
				pin,
				hasPrevious: request.previous !== undefined,
				previousLane: request.previous
					? laneOfModel(request.previous.model.provider, request.previous.model.id, config)
					: undefined,
				hasFailed: request.failed !== undefined,
				failedLane: request.failed
					? laneOfModel(request.failed.model.provider, request.failed.model.id, config)
					: undefined,
				failedIsQuota: request.failed ? isQuotaError(request.failed.message.errorMessage ?? "") : false,
				disabled: disabledLanes(config, ctx),
				now: startedAt,
			};

			if (needsClassification(state, signals)) {
				if (delta.user.trim() === "") {
					// Image-only or empty message: nothing for the classifiers to read (spec §11 gap 3).
					signals.pii = "no";
					signals.category = { label: "general", p: 1 };
				} else {
					const [pii, category] = await Promise.allSettled([
						classifyPii(config, delta.user, request.signal),
						// A bare "ok, continue" carries no new task: keep the lane (the privacy check still runs).
						isAcknowledgement(delta.user)
							? Promise.resolve<Labeled<Category>>({ label: "general", p: 1 })
							: classifyCategory(config, delta.user, request.signal),
					]);
					signals.pii = pii.status === "fulfilled" ? pii.value : "error";
					signals.category = category.status === "fulfilled" ? category.value : "error";
					const failure = [pii, category].find((result) => result.status === "rejected");
					classifierHealth = failure
						? `down: ${String((failure as PromiseRejectedResult).reason)}`
						: `ok · ${Date.now() - startedAt} ms`;
				}
			}

			const decision = decide(state, signals, config);
			report(ctx, decision, signals, startedAt);
			if (decision.state?.locked && !state?.locked) {
				// Persist the lock before resolving the local model: if that throws, pi never stores the
				// returned state, and the triggering content would reach a cloud model on the next turn.
				pi.appendEntry<RouterCommand>(COMMAND_ENTRY, { kind: "lock" });
				restrictTools(config);
			}
			return {
				model: targetModel(decision, request, ctx, config),
				thinkingLevel: thinkingFor(decision, request),
				state: decision.state,
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		syncTools(ctx);
		if (!usingRouter(ctx)) return;
		const loaded = loadConfig();
		if (!loaded.ok) {
			if (ctx.hasUI) ctx.ui.notify(`privacy-router: ${loaded.error}`, "error");
			return;
		}
		const config = loaded.config;
		if (loaded.source === "defaults" && !defaultsNoticeShown && ctx.hasUI) {
			ctx.ui.notify(`privacy-router: ${configPath()} not found; using built-in defaults`, "info");
			defaultsNoticeShown = true;
		}
		const disabled = disabledLanes(config, ctx);
		if (disabled.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`privacy-router: lane ${disabled.join(", ")} unavailable (model missing or no credentials)`,
				"warning",
			);
		}
		// A locked session never classifies, and loading the classifier would evict the local worker.
		const branch = readBranch(ctx);
		if (branch === undefined || isLocked(branch)) return;
		warmUp(ollamaOptions(config)).catch(() => {
			classifierHealth = "warm-up failed: Ollama not reachable";
		});
	});

	pi.on("session_tree", async (event, ctx) => {
		// /tree can attach a summary of the branch being left to the destination. A summary of a
		// locked branch is private content, so the lock follows it.
		if (event.summaryEntry && event.oldLeafId) {
			const left = readBranchAt(ctx, event.oldLeafId);
			const current = readBranch(ctx);
			if ((left === undefined || isLocked(left)) && current !== undefined && !isLocked(current)) {
				pi.appendEntry<RouterCommand>(COMMAND_ENTRY, { kind: "lock" });
				if (ctx.hasUI)
					ctx.ui.notify("🔒 This branch carries a summary of a private branch; locked to local.", "warning");
			}
		}
		syncTools(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// Spec §14 item 9: a session that locks late carries more cloud history than the local model
		// can summarize. The cloud model that already received that history summarizes it instead.
		if (!isLocked(event.branchEntries)) return undefined;
		const loaded = loadConfig();
		if (!loaded.ok) return undefined;
		const localRef = splitRef(loaded.config.lanes.local);
		const local = ctx.modelRegistry.find(localRef.provider, localRef.id);
		if (!local) return undefined;
		const { preparation } = event;
		const toSummarize = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		const plan = planHandoff({
			branch: event.branchEntries as never,
			toSummarize,
			firstKeptEntryId: preparation.firstKeptEntryId,
			previousSummary: preparation.previousSummary,
			inputTokens: estimateInputTokens(toSummarize, preparation.previousSummary),
			localBudget: localSummaryBudget(local.contextWindow, local.maxTokens, preparation.settings.reserveTokens),
			isCloud: (provider, id) => {
				const model = ctx.modelRegistry.find(provider, id);
				return model === undefined || !isLoopbackUrl(model.baseUrl);
			},
		});
		if (!plan) return undefined;

		const source = `${plan.provider}/${plan.model}`;
		const files = fileLists(preparation.fileOps);
		const compaction = (summary: string) => ({
			compaction: {
				summary: summary + files.text,
				firstKeptEntryId: plan.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
			},
		});
		if (plan.rewritten) {
			const reason = `history was edited after ${source} replied`;
			if (ctx.hasUI) ctx.ui.notify(`⚠ Earlier ${reason}; kept your earlier requests as a local note.`, "warning");
			return compaction(handoffNote(plan.messages, source, reason));
		}
		if (ctx.hasUI) {
			ctx.ui.notify(`🔒 Handing off earlier history: ${source} summarizes only what it already received.`, "info");
		}
		try {
			const model = ctx.modelRegistry.find(plan.provider, plan.model);
			if (!model || isLoopbackUrl(model.baseUrl)) throw new Error(`${source} is not in pi's catalog`);
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
			// Only the plan's messages and the cloud-era summary leave; /compact instructions typed after
			// the lock are private, so they are not passed.
			const summary = await deps.summarize(
				plan.messages,
				auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
				preparation.settings.reserveTokens,
				auth.apiKey,
				withoutDeletedHeaders(auth.headers),
				event.signal,
				undefined,
				plan.previousSummary,
				undefined,
				undefined,
				auth.env,
				// pi's default retry settings: one overloaded response must not cost the history.
				SUMMARY_RETRY,
			);
			return compaction(summary);
		} catch (error) {
			// pi rethrows the abort itself.
			if (event.signal.aborted) return undefined;
			const reason = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) {
				ctx.ui.notify(`⚠ ${source} could not summarize (${reason}); kept your earlier requests as a note.`, "warning");
			}
			return compaction(handoffNote(plan.messages, source, reason));
		}
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		// pi does not retry a usage limit it classifies as permanent (Anthropic's 400 "out of extra
		// usage"), so the turn would just end. Cool the lane down and retry the turn on the other one.
		if (event.outcome !== "error" || !usingRouter(ctx)) return undefined;
		const branch = readBranch(ctx);
		if (branch === undefined || isLocked(branch)) return undefined;
		const failed = (branch as readonly { type: string; id: string; message?: Message }[]).findLast(
			(entry) => entry.type === "message",
		);
		const message = failed?.message;
		if (!failed || message?.role !== "assistant" || message.stopReason !== "error") return undefined;
		const loaded = loadConfig();
		if (!loaded.ok) return undefined;
		const config = loaded.config;
		const lane = laneOfModel(message.provider, message.model, config);
		if (lane === undefined) return undefined;
		const failover = planQuotaFailover(
			{
				state: applyCooldowns(readRouterState(branch), readCommands(branch).cooldowns, config.defaultLane),
				failure: { lane, message: message.errorMessage ?? "" },
				disabled: disabledLanes(config, ctx),
				now: Date.now(),
			},
			config,
		);
		if (!failover) return undefined;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`${failover.from} usage limit reached; retrying on ${failover.to} for ${config.quotaCooldownMinutes} min`,
				"warning",
			);
		}
		const cooldown: RouterCommand = { kind: "cooldown", lane: failover.from, until: failover.until };
		return {
			entries: [
				{ type: "custom", customType: COMMAND_ENTRY, data: cooldown },
				// As in pi's own retries, the failed attempt leaves the model's context.
				{ type: "context_edit", targetId: failed.id, replacement: null },
			],
			continue: true,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const branch = readBranch(ctx);
		const locked = branch === undefined || isLocked(branch);
		if (!locked && !usingRouter(ctx)) return undefined;
		const loaded = loadConfig();
		if (!loaded.ok) {
			return {
				block: true,
				reason: `Router config invalid (${loaded.error}); tools are blocked until privacy-router.json is fixed.`,
			};
		}
		const config = loaded.config;
		if (locked) {
			if (config.lockedToolAllowlist.includes(event.toolName)) return undefined;
			return { block: true, reason: `Blocked: ${event.toolName} is not available in a private (local-only) session.` };
		}
		const hit = toolPathHit(event.toolName, event.input as Record<string, unknown>, pathPolicy(config, ctx.cwd));
		if (hit === undefined) return undefined;
		const search = hit.kind === "search-root";
		if (ctx.hasUI) {
			const what = search ? "search from" : "private path";
			ctx.ui.notify(`privacy-router: blocked ${event.toolName} on ${what} ${hit.token}`, "warning");
		}
		return { block: true, reason: search ? SEARCH_BLOCK_REASON : PATH_BLOCK_REASON };
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore" || event.model.provider === ROUTER_PROVIDER) return;
		const branch = readBranch(ctx);
		if (branch !== undefined && !isLocked(branch)) return;
		const loaded = loadConfig();
		const localRef = loaded.ok ? loaded.config.lanes.local : undefined;
		// Any model served from this machine keeps the session private, not just the configured worker.
		if (isLoopbackUrl(event.model.baseUrl)) return;
		const fallback =
			ctx.modelRegistry.find(ROUTER_PROVIDER, ROUTER_MODEL_ID) ??
			(localRef ? ctx.modelRegistry.find(splitRef(localRef).provider, splitRef(localRef).id) : undefined);
		// pi has already switched the model; a running turn's next request would reach it before the revert.
		if (!ctx.isIdle()) ctx.abort();
		if (fallback) await pi.setModel(fallback);
		if (ctx.hasUI) ctx.ui.notify("Session is locked to local. Start a new session for cloud models.", "warning");
	});

	pi.on("cache_warming_decision", async (_event, ctx) => {
		const branch = readBranch(ctx);
		return branch === undefined || isLocked(branch) ? { action: "stop" } : undefined;
	});

	pi.registerCommand("local", {
		description: "Lock this session to the local model (cannot be undone in this session)",
		handler: async (_args, ctx) => {
			const branch = readBranch(ctx);
			if (branch !== undefined && isLocked(branch)) {
				ctx.ui.notify("Session is already locked to local.", "info");
				return;
			}
			pi.appendEntry<RouterCommand>(COMMAND_ENTRY, { kind: "lock" });
			const loaded = loadConfig();
			if (loaded.ok) restrictTools(loaded.config);
			ctx.ui.setStatus("privacy-router", "🔒 local · command");
			ctx.ui.notify("🔒 Session locked to local. Start a new session to use cloud models again.", "warning");
		},
	});

	pi.registerCommand("leave-local", {
		description: "Go back to the last cloud reply before this session locked; the private part stays on its own branch",
		handler: async (_args, ctx) => {
			const branch = readBranch(ctx);
			if (branch === undefined || !isLocked(branch)) {
				ctx.ui.notify("Session is not locked.", "info");
				return;
			}
			const loaded = loadConfig();
			if (!loaded.ok) {
				ctx.ui.notify(`privacy-router: ${loaded.error}`, "error");
				return;
			}
			if (isSensitivePath(safeRealpath(ctx.cwd), loaded.config.sensitivePaths, HOME)) {
				ctx.ui.notify(
					"pi is running in a private folder, so any branch here locks again. Start pi elsewhere.",
					"warning",
				);
				return;
			}
			const target = rewindTarget(branch as never, firstLockIndex(branch), (provider, id) => {
				const model = ctx.modelRegistry.find(provider, id);
				return model === undefined || !isLoopbackUrl(model.baseUrl);
			});
			if (!target) {
				ctx.ui.notify(
					"This session locked before any cloud reply. Start a new session (/new) for cloud models.",
					"warning",
				);
				return;
			}
			await ctx.waitForIdle();
			// Never summarize: a summary of the locked branch is private and would lock the destination.
			const result = await ctx.navigateTree(target.id, { summarize: false });
			if (result.cancelled) return;
			// pi keeps the new position in memory only; an entry there makes a reopened session resume on it.
			pi.appendEntry<RouterCommand>(COMMAND_ENTRY, { kind: "leave-local" });
			ctx.ui.setStatus("privacy-router", "→ auto");
			ctx.ui.notify(
				"↩ Back before the lock; cloud routing resumes on your next message. The private part stays on its own branch (/tree), and going back to it locks again.",
				"info",
			);
		},
	});

	pi.registerCommand("route", {
		description: "Pin a cloud model (/route <target>) or resume automatic routing (/route auto)",
		getArgumentCompletions: (prefix) => {
			const loaded = loadConfig();
			const names = loaded.ok ? [...Object.keys(loaded.config.pinTargets), "auto"] : ["auto"];
			return names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
		},
		handler: async (args, ctx) => {
			const branch = readBranch(ctx);
			if (branch === undefined || isLocked(branch)) {
				ctx.ui.notify("Session is locked to local; /route is unavailable.", "warning");
				return;
			}
			const loaded = loadConfig();
			if (!loaded.ok) {
				ctx.ui.notify(`privacy-router: ${loaded.error}`, "error");
				return;
			}
			const name = args.trim();
			if (name === "auto") {
				pi.appendEntry<RouterCommand>(COMMAND_ENTRY, { kind: "unpin" });
				ctx.ui.setStatus("privacy-router", "→ auto");
				ctx.ui.notify("Routing is automatic again.", "info");
				return;
			}
			if (!(name in loaded.config.pinTargets)) {
				const names = [...Object.keys(loaded.config.pinTargets), "auto"].join(", ");
				ctx.ui.notify(`Usage: /route <${names}>`, "warning");
				return;
			}
			pi.appendEntry<RouterCommand>(COMMAND_ENTRY, { kind: "pin", target: name });
			ctx.ui.setStatus("privacy-router", `📌 ${name}`);
			ctx.ui.notify(`Pinned to ${name} from the next message. /route auto to undo.`, "info");
		},
	});

	pi.registerCommand("privacy", {
		description: "Show router status",
		handler: async (_args, ctx) => {
			const branch = readBranch(ctx) ?? [];
			const state = readRouterState(branch);
			const commands = readCommands(branch);
			const loaded = loadConfig();
			let lock = "";
			if (state?.locked) lock = ` · 🔒 locked (${state.lockReason}: ${state.lockDetail})`;
			else if (commands.lockRequested) lock = " · 🔒 lock requested";
			ctx.ui.notify(
				[
					`selected: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
					`lane: ${state?.lane ?? "(none yet)"}${lock}`,
					`pin: ${commands.pin ?? "none"}`,
					`config: ${loaded.ok ? `${loaded.source} (${configPath()})` : `INVALID: ${loaded.error}`}`,
					`classifier: ${classifierHealth}`,
					`last decision: ${lastDecision}`,
				].join("\n"),
				"info",
			);
		},
	});
}
