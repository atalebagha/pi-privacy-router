/**
 * Classifier prompts and output parsing. The prompts were validated against qwen3:8b; change them
 * only together with `npm run eval`.
 */

export type Category = "code" | "live" | "general";
export const CATEGORIES: readonly Category[] = ["code", "live", "general"];

export type PiiLabel = "yes" | "no";
export const PII_LABELS: readonly PiiLabel[] = ["yes", "no"];

export const MAX_CLASSIFY_CHARS = 6000;

/**
 * The agent works on the user's machine, so "latest commit" or "installed version" is local work,
 * not live data. Without that framing, qwen3:8b sent local file and git questions to the live lane.
 */
export const CATEGORY_SYSTEM = `You route requests for a coding agent that can read files, search the repository, and run shell commands on the user's machine. Reply with exactly one label:
code    = write/modify/debug/review code, scripts, configs, architecture, multi-step plans, or any work on the user's own files, repository, git history, or machine (reading, listing, searching, running commands, checking installed versions or running processes)
live    = needs current or recent information from the internet: weather, news and announcements, sports results, prices and exchange rates, traffic, service outages, new software releases and their docs, or anything else that requires a web lookup
general = everything else: explanations, chit-chat, writing prose, quick facts that don't change
Anything about the user's own files, repository, or machine is "code", never "live".
Reply with only the label.`;

/**
 * The examples must not reuse eval-set wording (test/eval/pii.jsonl), or the eval stops measuring
 * generalization. Without them, qwen3:8b missed family-health messages at full confidence; it also
 * judged reworded private messages by the task ("make this sound kinder") and missed legal matters.
 */
export const PII_SYSTEM = `You are a privacy filter. Answer "yes" if the text contains sensitive personal information that the user would not want sent to a cloud AI provider: health or medical details (including about family members), personal finances (balances, salaries, account numbers, tax, debts, loans to or from friends and family), government IDs, legal matters (custody, divorce, eviction, lawsuits), private details about named people (family, contacts, relationships, private plans or conflicts with a partner, friend, or cofounder), private journal-style content, or home address. Judge the content, not the task: rewording, summarizing, or translating a private message is still "yes". Answer "no" for ordinary technical, coding, or general questions. If you are unsure, answer "yes". Reply with only yes or no.

Examples:
Text: Remind my sister that dad's chemo appointment moved to Monday -> yes
Text: Tell Aisha I can't make dinner because my son has a fever -> yes
Text: My credit card ending 4417 was charged twice, write a complaint -> yes
Text: Rephrase this so it sounds kinder: "Uncle Sami, you have to stop skipping dialysis" -> yes
Text: Summarize my options after my landlord's eviction notice -> yes
Text: Ask my cousin Rami to pay back the $1,200 he borrowed in June -> yes
Text: Help me tell my business partner I want out before our next funding round -> yes
Text: Add a diagnosis field to the Patient model -> no
Text: Write a birthday message for a coworker -> no
Text: Explain how mortgage amortization works -> no`;

const ACKNOWLEDGEMENT_WORDS = new Set([
	"ok",
	"okay",
	"k",
	"alright",
	"thanks",
	"thank",
	"you",
	"ty",
	"thx",
	"cool",
	"great",
	"nice",
	"good",
	"sounds",
	"perfect",
	"right",
	"yes",
	"yep",
	"yeah",
	"sure",
	"please",
	"continue",
	"go",
	"on",
	"ahead",
	"proceed",
	"keep",
	"going",
	"do",
	"it",
	"that",
	"worked",
	"works",
	"done",
	"got",
]);

/**
 * A message made only of acknowledgement words ("ok, continue", "thanks, that worked") carries no
 * new task, so it is routed as `general` and keeps the current lane. The classifier sends some of
 * these to `code`, which would move a GPT conversation to Claude mid-task.
 */
export function isAcknowledgement(text: string): boolean {
	const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
	return words.length > 0 && words.length <= 6 && words.every((word) => ACKNOWLEDGEMENT_WORDS.has(word));
}

export interface Prompt {
	system: string;
	user: string;
}

export interface Labeled<L extends string> {
	label: L;
	/** exp(logprob) of the first generated token; 1 when the server returned no logprobs. */
	p: number;
}

export function lastChars(text: string, max: number = MAX_CLASSIFY_CHARS): string {
	return text.length <= max ? text : text.slice(-max);
}

export function categoryPrompt(text: string): Prompt {
	return { system: CATEGORY_SYSTEM, user: lastChars(text) };
}

export function piiPrompt(text: string): Prompt {
	return { system: PII_SYSTEM, user: `Text:\n<<<\n${lastChars(text)}\n>>>` };
}

/** First word of the output, lower-cased; undefined unless it is one of `allowed`. */
export function parseLabel<L extends string>(
	content: string,
	logprob: number | undefined,
	allowed: readonly L[],
): Labeled<L> | undefined {
	const word = content
		.trim()
		.toLowerCase()
		.match(/^[a-z]+/)?.[0];
	const label = allowed.find((candidate) => candidate === word);
	if (label === undefined) return undefined;
	return { label, p: logprob === undefined ? 1 : Math.exp(logprob) };
}
