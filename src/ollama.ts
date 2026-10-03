/**
 * Minimal Ollama client for the classifier. Uses the native /api/chat endpoint so each call can
 * set `num_ctx` (Ollama's /v1 endpoint uses the server's VRAM-tier default context instead).
 */

import type { Prompt } from "./classify.ts";

export interface OllamaOptions {
	baseUrl: string;
	model: string;
	timeoutMs: number;
	keepAlive: string;
}

export interface OneWord {
	content: string;
	logprob: number | undefined;
}

/** Same context for warm-up and classification, so Ollama never reloads the model between them. */
const CLASSIFIER_NUM_CTX = 4096;

interface ChatResponse {
	message?: { content?: string };
	logprobs?: Array<{ token: string; logprob: number }>;
}

export async function askOneWord(
	options: OllamaOptions,
	prompt: Prompt,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<OneWord> {
	const timeout = AbortSignal.timeout(options.timeoutMs);
	const response = await fetchImpl(`${options.baseUrl}/api/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		body: JSON.stringify({
			model: options.model,
			stream: false,
			think: false,
			keep_alive: options.keepAlive,
			messages: [
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			],
			options: { temperature: 0, num_predict: 2, num_ctx: CLASSIFIER_NUM_CTX },
			logprobs: true,
			top_logprobs: 3,
		}),
	});
	if (!response.ok) throw new Error(`ollama ${response.status}: ${await response.text().catch(() => "")}`);
	const body = (await response.json()) as ChatResponse;
	return { content: body.message?.content ?? "", logprob: body.logprobs?.[0]?.logprob };
}

/** Load the classifier into memory so the first routed message does not pay the cold load. */
export async function warmUp(options: OllamaOptions, fetchImpl: typeof fetch = fetch): Promise<void> {
	const response = await fetchImpl(`${options.baseUrl}/api/generate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		signal: AbortSignal.timeout(30_000),
		body: JSON.stringify({
			model: options.model,
			keep_alive: options.keepAlive,
			options: { num_ctx: CLASSIFIER_NUM_CTX },
		}),
	});
	if (!response.ok) throw new Error(`ollama warm-up ${response.status}`);
}
