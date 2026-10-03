/**
 * Live classifier eval: `npm run eval`. Needs Ollama running with the classifier model.
 * Deliberately not part of `npm test`: results depend on the model build, not on our logic.
 *
 * Gates (spec §10.2): category accuracy >= 90 %, PII recall >= 95 %, and zero cross-lane misroutes
 * (a `code` case labelled `live` or the reverse): those pick the wrong provider, while a miss into
 * `general` only keeps the current lane.
 */

import { readFileSync } from "node:fs";
import {
	CATEGORIES,
	categoryPrompt,
	isAcknowledgement,
	PII_LABELS,
	parseLabel,
	piiPrompt,
	type Prompt,
} from "../../src/classify.ts";
import { loadConfig } from "../../src/config.ts";
import { askOneWord, type OllamaOptions } from "../../src/ollama.ts";

interface Case {
	text: string;
	label: string;
	/** Who wrote the case: "agent" or "user". */
	by?: string;
}

function readCases(file: string): Case[] {
	return readFileSync(new URL(file, import.meta.url), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Case);
}

const loaded = loadConfig();
if (!loaded.ok) {
	console.error(`privacy-router.json invalid: ${loaded.error}`);
	process.exit(2);
}
// Generous timeout: the first call may load the model from disk.
const options: OllamaOptions = {
	baseUrl: loaded.config.ollama.baseUrl,
	model: loaded.config.ollama.classifierModel,
	timeoutMs: 60_000,
	keepAlive: loaded.config.ollama.keepAlive,
};

async function label(prompt: Prompt, allowed: readonly string[]): Promise<string> {
	const output = await askOneWord(options, prompt);
	return parseLabel(output.content, output.logprob, allowed)?.label ?? `?${output.content}`;
}

const misses: string[] = [];

const categoryCases = readCases("./category.jsonl");
let categoryCorrect = 0;
let crossLane = 0;
for (const c of categoryCases) {
	// Mirror routing: bare acknowledgements never reach the category classifier.
	const got = isAcknowledgement(c.text) ? "general" : await label(categoryPrompt(c.text), CATEGORIES);
	if (got === c.label) categoryCorrect++;
	else misses.push(`category  want=${c.label} got=${got}  ${c.text}`);
	if ((c.label === "code" && got === "live") || (c.label === "live" && got === "code")) crossLane++;
}

const piiCases = readCases("./pii.jsonl");
let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;
for (const c of piiCases) {
	const got = await label(piiPrompt(c.text), PII_LABELS);
	if (got === "yes" && c.label === "yes") truePositive++;
	else if (got === "yes") falsePositive++;
	else if (c.label === "yes") falseNegative++;
	if (got !== c.label) misses.push(`pii       want=${c.label} got=${got}  [${c.by ?? "agent"}] ${c.text}`);
}

const accuracy = categoryCorrect / categoryCases.length;
const recall = truePositive / Math.max(1, truePositive + falseNegative);
const precision = truePositive / Math.max(1, truePositive + falsePositive);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`model ${options.model} · ${categoryCases.length} category cases · ${piiCases.length} pii cases`);
console.log(`category accuracy ${pct(accuracy)} (gate >= 90%)`);
console.log(`cross-lane misroutes ${crossLane} (gate = 0)`);
console.log(`pii recall        ${pct(recall)} (gate >= 95%)`);
console.log(`pii precision     ${pct(precision)} (reported, no gate)`);
if (misses.length > 0) console.log(`\nmisses:\n  ${misses.join("\n  ")}`);

const passed = accuracy >= 0.9 && recall >= 0.95 && crossLane === 0;
console.log(passed ? "\nPASS" : "\nFAIL");
process.exit(passed ? 0 : 1);
