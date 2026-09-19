/**
 * LongMemEval-S benchmark — measures retrieval quality (recall_any@K, NDCG@K, MRR)
 * on the LongMemEval-S dataset.
 *
 * Ported from upstream agentmemory benchmark/longmemeval-bench.ts (2026-09-19).
 * Adapted for this project's BM25Index (add(id, content) instead of add(obs)).
 *
 * Modes:
 *   bm25   — BM25 only (default, no embedding provider needed)
 *   hybrid — BM25 + vector (requires embedding provider, not yet ported)
 *
 * Env knobs:
 *   LONGMEMEVAL_DATA   path to longmemeval_s_cleaned.json (default: benchmark/data/longmemeval_s_cleaned.json)
 *                      Download from: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 *                      If not found, falls back to synthetic dataset (benchmark/data/synthetic-longmemeval.json)
 */

import { BM25Index } from "../src/bm25Index.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 编译后 __dirname 是 benchmark/dist/，需要回到 benchmark/ 找数据与保存结果
const BENCH_ROOT = __dirname.endsWith("dist") ? dirname(__dirname) : __dirname;

interface LongMemEvalEntry {
	question_id: string;
	question_type: string;
	question: string;
	question_date: string;
	answer: string;
	answer_session_ids: string[];
	haystack_dates: string[];
	haystack_session_ids: string[];
	haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
}

interface SessionChunk {
	sessionId: string;
	text: string;
	turnCount: number;
}

interface BenchResult {
	question_id: string;
	question_type: string;
	recall_any_at_5: number;
	recall_any_at_10: number;
	recall_any_at_20: number;
	ndcg_at_10: number;
	mrr: number;
	retrieved_session_ids: string[];
	gold_session_ids: string[];
}

function chunkSessionToText(
	turns: Array<{ role: string; content: string }>,
): string {
	return turns
		.map((t) => `${t.role}: ${t.content}`)
		.join("\n");
}

function recallAny(
	retrievedSessionIds: string[],
	goldSessionIds: string[],
	k: number,
): number {
	const topK = new Set(retrievedSessionIds.slice(0, k));
	return goldSessionIds.some((gid) => topK.has(gid)) ? 1.0 : 0.0;
}

function dcg(relevances: boolean[], k: number): number {
	let sum = 0;
	for (let i = 0; i < Math.min(k, relevances.length); i++) {
		sum += (relevances[i] ? 1 : 0) / Math.log2(i + 2);
	}
	return sum;
}

function ndcg(
	retrievedSessionIds: string[],
	goldSessionIds: Set<string>,
	k: number,
): number {
	const rels = retrievedSessionIds
		.slice(0, k)
		.map((id) => goldSessionIds.has(id));
	const idealRels = Array.from(
		{ length: Math.min(k, goldSessionIds.size) },
		() => true,
	);
	const idealDCG = dcg(idealRels, k);
	if (idealDCG === 0) return 0;
	return dcg(rels, k) / idealDCG;
}

function mrr(
	retrievedSessionIds: string[],
	goldSessionIds: Set<string>,
): number {
	for (let i = 0; i < retrievedSessionIds.length; i++) {
		if (goldSessionIds.has(retrievedSessionIds[i])) return 1 / (i + 1);
	}
	return 0;
}

function generateSyntheticDataset(): LongMemEvalEntry[] {
	// 10 synthetic questions, each with 5-8 sessions (1-2 gold, rest distractors)
	const topics = [
		{ q: "What database did we choose for the project?", a: "PostgreSQL", distractors: ["Redis", "MongoDB", "SQLite", "MySQL"] },
		{ q: "What is the recommended cache TTL?", a: "300 seconds", distractors: ["60 seconds", "3600 seconds", "no cache", "infinite"] },
		{ q: "Which framework for the frontend?", a: "React", distractors: ["Vue", "Angular", "Svelte", "Solid"] },
		{ q: "What is the API rate limit?", a: "1000 requests per hour", distractors: ["100 per minute", "unlimited", "10000 per day"] },
		{ q: "What testing framework?", a: "Vitest", distractors: ["Jest", "Mocha", "Playwright", "Cypress"] },
		{ q: "What CI/CD platform?", a: "GitHub Actions", distractors: ["GitLab CI", "Jenkins", "CircleCI", "Travis"] },
		{ q: "What is the deployment target?", a: "Kubernetes", distractors: ["Docker Swarm", "bare metal", "serverless", "VMs"] },
		{ q: "What logging library?", a: "Winston", distractors: ["console.log", "Pino", "Bunyan", "Log4js"] },
		{ q: "What authentication method?", a: "OAuth 2.0", distractors: ["Basic auth", "API keys", "SAML", "JWT only"] },
		{ q: "What monitoring tool?", a: "Prometheus", distractors: ["Grafana only", "Datadog", "New Relic", "CloudWatch"] },
	];

	return topics.map((topic, qi) => {
		const goldSessionId = `session-${qi}-gold`;
		const distractorIds = topic.distractors.map((_, di) => `session-${qi}-distractor-${di}`);
		const allSessionIds = [goldSessionId, ...distractorIds];

		const haystackSessions = [
			// Gold session (contains the answer)
			[
				{ role: "user", content: `We need to decide on ${topic.q.toLowerCase()}` },
				{ role: "assistant", content: `I recommend ${topic.a} for this use case.`, has_answer: true },
				{ role: "user", content: "Sounds good, let's go with that." },
			],
			// Distractor sessions
			...topic.distractors.map((distractor) => [
				{ role: "user", content: `What about ${distractor}?` },
				{ role: "assistant", content: `${distractor} is also an option, but not recommended.` },
			]),
		];

		return {
			question_id: `q${qi}`,
			question_type: "single-session-user",
			question: topic.q,
			question_date: "2026-09-19",
			answer: topic.a,
			answer_session_ids: [goldSessionId],
			haystack_dates: allSessionIds.map(() => "2026-09-19"),
			haystack_session_ids: allSessionIds,
			haystack_sessions: haystackSessions,
		};
	});
}

async function runBenchmark(mode: "bm25" | "hybrid") {
	if (mode !== "bm25") {
		console.error(`Mode "${mode}" not yet ported (requires embedding provider)`);
		process.exit(1);
	}

	const dataPath =
		process.env["LONGMEMEVAL_DATA"] ||
		resolve(BENCH_ROOT, "data", "longmemeval_s_cleaned.json");

	let entries: LongMemEvalEntry[];
	if (existsSync(dataPath)) {
		console.log(`Loading LongMemEval-S dataset from ${dataPath}...`);
		const raw = JSON.parse(readFileSync(dataPath, "utf-8")) as LongMemEvalEntry[];
		const abstentionTypes = new Set([
			"single-session-user_abs",
			"multi-session_abs",
			"knowledge-update_abs",
			"temporal-reasoning_abs",
		]);
		entries = raw.filter((e) => !abstentionTypes.has(e.question_type));
		console.log(
			`Loaded ${entries.length} questions (${raw.length - entries.length} abstention excluded)`,
		);
	} else {
		console.log(`Dataset not found at ${dataPath}`);
		console.log(`Using synthetic dataset (10 questions, for framework validation only)`);
		console.log(`Download real dataset from: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned`);
		entries = generateSyntheticDataset();
	}

	const results: BenchResult[] = [];
	let processed = 0;

	for (const entry of entries) {
		const sessionChunks: SessionChunk[] = [];
		for (let i = 0; i < entry.haystack_sessions.length; i++) {
			const sessionId = entry.haystack_session_ids[i]!;
			const turns = entry.haystack_sessions[i]!;
			const text = chunkSessionToText(turns);
			sessionChunks.push({ sessionId, text, turnCount: turns.length });
		}

		const bm25 = new BM25Index();

		for (const chunk of sessionChunks) {
			bm25.add(chunk.sessionId, chunk.text);
		}

		const bm25Results = bm25.search(entry.question, 20);
		const retrievedSessionIds = bm25Results.map((r) => r.id);

		const goldSet = new Set(entry.answer_session_ids);

		const result: BenchResult = {
			question_id: entry.question_id,
			question_type: entry.question_type,
			recall_any_at_5: recallAny(retrievedSessionIds, entry.answer_session_ids, 5),
			recall_any_at_10: recallAny(retrievedSessionIds, entry.answer_session_ids, 10),
			recall_any_at_20: recallAny(retrievedSessionIds, entry.answer_session_ids, 20),
			ndcg_at_10: ndcg(retrievedSessionIds, goldSet, 10),
			mrr: mrr(retrievedSessionIds, goldSet),
			retrieved_session_ids: retrievedSessionIds.slice(0, 10),
			gold_session_ids: entry.answer_session_ids,
		};
		results.push(result);
		processed++;

		if (processed % 50 === 0) {
			const avgRecall5 =
				results.reduce((s, r) => s + r.recall_any_at_5, 0) / results.length;
			console.log(
				`  [${processed}/${entries.length}] running recall_any@5: ${(avgRecall5 * 100).toFixed(1)}%`,
			);
		}
	}

	const avgRecallAny5 =
		results.reduce((s, r) => s + r.recall_any_at_5, 0) / results.length;
	const avgRecallAny10 =
		results.reduce((s, r) => s + r.recall_any_at_10, 0) / results.length;
	const avgRecallAny20 =
		results.reduce((s, r) => s + r.recall_any_at_20, 0) / results.length;
	const avgNdcg10 =
		results.reduce((s, r) => s + r.ndcg_at_10, 0) / results.length;
	const avgMrr =
		results.reduce((s, r) => s + r.mrr, 0) / results.length;

	const byType = new Map<string, BenchResult[]>();
	for (const r of results) {
		if (!byType.has(r.question_type)) byType.set(r.question_type, []);
		byType.get(r.question_type)!.push(r);
	}

	console.log(`\n=== LongMemEval-S Results (${mode}) ===`);
	console.log(`Questions: ${results.length}`);
	console.log(`recall_any@5:  ${(avgRecallAny5 * 100).toFixed(1)}%`);
	console.log(`recall_any@10: ${(avgRecallAny10 * 100).toFixed(1)}%`);
	console.log(`recall_any@20: ${(avgRecallAny20 * 100).toFixed(1)}%`);
	console.log(`NDCG@10:       ${(avgNdcg10 * 100).toFixed(1)}%`);
	console.log(`MRR:           ${(avgMrr * 100).toFixed(1)}%`);

	console.log(`\nBy question type:`);
	for (const [type, typeResults] of byType) {
		const r5 =
			typeResults.reduce((s, r) => s + r.recall_any_at_5, 0) /
			typeResults.length;
		const r10 =
			typeResults.reduce((s, r) => s + r.recall_any_at_10, 0) /
			typeResults.length;
		console.log(
			`  ${type.padEnd(30)} R@5: ${(r5 * 100).toFixed(1)}%  R@10: ${(r10 * 100).toFixed(1)}%  (n=${typeResults.length})`,
		);
	}

	const outPath = resolve(BENCH_ROOT, "data", `longmemeval_results_${mode}.json`);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(
		outPath,
		JSON.stringify(
			{
				mode,
				questions: results.length,
				recall_any_at_5: avgRecallAny5,
				recall_any_at_10: avgRecallAny10,
				recall_any_at_20: avgRecallAny20,
				ndcg_at_10: avgNdcg10,
				mrr: avgMrr,
				per_type: Object.fromEntries(
					Array.from(byType).map(([type, tr]) => [
						type,
						{
							count: tr.length,
							recall_any_at_5:
								tr.reduce((s, r) => s + r.recall_any_at_5, 0) / tr.length,
							recall_any_at_10:
								tr.reduce((s, r) => s + r.recall_any_at_10, 0) / tr.length,
						},
					]),
				),
				per_question: results,
			},
			null,
			2,
		),
	);
	console.log(`\nResults saved to ${outPath}`);
}

const mode = (process.argv[2] || "bm25") as "bm25" | "hybrid";
console.log(`Running LongMemEval-S benchmark in ${mode} mode...`);
runBenchmark(mode).catch(console.error);
