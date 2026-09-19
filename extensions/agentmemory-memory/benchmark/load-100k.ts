/**
 * Load harness — seeds N synthetic memories against a local agentmemory
 * gateway, then drives a matrix of (N, concurrency, endpoint) cells and
 * records p50 / p90 / p99 latency + throughput per cell.
 *
 * Ported from upstream agentmemory benchmark/load-100k.ts (2026-09-19).
 * Adapted for this project's gateway endpoints:
 *   - POST /provider/writeMemory (instead of /agentmemory/remember)
 *   - POST /search/<agentId> (instead of /agentmemory/smart-search)
 *   - GET  /kv/<scope>?values=true (instead of /agentmemory/memories?latest=true)
 *   - GET  /health (instead of /agentmemory/livez)
 *
 * Runs against an already-running gateway at `http://127.0.0.1:3112` by
 * default (dev gateway). The gateway is spawned by the main process and
 * cannot be auto-started by this harness.
 *
 * Env knobs:
 *   AGENTMEMORY_URL               base URL of the gateway (default: http://127.0.0.1:3112)
 *   BENCH_AGENT_ID                agent ID for search endpoint (default: benchmark-agent)
 *   BENCH_SCOPE                   KV scope for seeded memories (default: benchmark)
 *   BENCH_N                       comma-separated N sizes (default: 1000,10000)
 *   BENCH_C                       comma-separated concurrency levels (default: 1,10,100)
 *   BENCH_OPS                     ops per cell during measurement (default: 200)
 *   BENCH_SEED                    seed for the mulberry32 RNG (default: 0xC0FFEE)
 *   BENCH_OUT_DIR                 results dir (default: benchmark/results)
 *
 * The harness writes one JSON file per run named
 * `load-100k-<short-git-sha>.json`. The git sha is best-effort — falls
 * back to a timestamp when run outside a checkout.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { pXX } from "./lib/percentiles.js";

/** Seedable PRNG. Mulberry32 — 32-bit state, uniform output in [0, 1). */
function mulberry32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const NOUNS = [
	"cache", "queue", "router", "stream", "shard", "lock", "buffer", "worker",
	"engine", "trigger", "function", "memory", "index", "graph", "vector",
	"session", "observation", "summary", "embedding", "tokenizer", "scheduler",
	"consumer", "producer", "channel", "actor", "pipeline", "watcher", "pool",
];
const VERBS = [
	"flushes", "rotates", "compacts", "rebalances", "drains", "warms",
	"expires", "deduplicates", "snapshots", "replays", "promotes", "demotes",
	"merges", "splits", "indexes", "scans", "compresses", "uploads",
];
const CONCEPTS = [
	"throughput", "latency", "backpressure", "consistency", "isolation",
	"durability", "idempotency", "fan-out", "cardinality", "skew",
	"hot-path", "cold-start", "tail-latency", "saturation", "quiescence",
];

function buildContent(rng: () => number, i: number): string {
	const n = NOUNS[Math.floor(rng() * NOUNS.length)]!;
	const v = VERBS[Math.floor(rng() * VERBS.length)]!;
	const c1 = CONCEPTS[Math.floor(rng() * CONCEPTS.length)]!;
	const c2 = CONCEPTS[Math.floor(rng() * CONCEPTS.length)]!;
	const k = Math.floor(rng() * 9999);
	return `seed-${i} the ${n} ${v} ${c1} under ${c2} pressure (k=${k})`;
}

interface RunConfig {
	baseUrl: string;
	agentId: string;
	scope: string;
	Ns: number[];
	Cs: number[];
	opsPerCell: number;
	seed: number;
	outDir: string;
}

function parseIntList(raw: string | undefined, fallback: number[]): number[] {
	if (!raw) return fallback;
	const out = raw
		.split(",")
		.map((s) => parseInt(s.trim(), 10))
		.filter((n) => Number.isFinite(n) && n > 0);
	return out.length > 0 ? out : fallback;
}

function loadConfig(): RunConfig {
	return {
		baseUrl: (process.env["AGENTMEMORY_URL"] || "http://127.0.0.1:3112").replace(
			/\/+$/,
			"",
		),
		agentId: process.env["BENCH_AGENT_ID"] || "benchmark-agent",
		scope: process.env["BENCH_SCOPE"] || "benchmark",
		Ns: parseIntList(process.env["BENCH_N"], [1000, 10000]),
		Cs: parseIntList(process.env["BENCH_C"], [1, 10, 100]),
		opsPerCell: parseInt(process.env["BENCH_OPS"] || "200", 10) || 200,
		seed: parseInt(process.env["BENCH_SEED"] || "12648430", 10) || 12648430,
		outDir:
			process.env["BENCH_OUT_DIR"] ||
			resolve(process.cwd(), "benchmark", "results"),
	};
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	let lastErr: unknown = null;
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`${baseUrl}/health`, {
				signal: AbortSignal.timeout(2000),
			});
			if (res.ok) return;
			lastErr = new Error(`health HTTP ${res.status}`);
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	const reason =
		lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown");
	throw new Error(
		`gateway at ${baseUrl} did not become ready within ${timeoutMs} ms: ${reason}`,
	);
}

function shortGitSha(): string {
	try {
		const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (sha) return sha;
	} catch {
		/* no git */
	}
	return `nogit-${Date.now().toString(36)}`;
}

interface CellResult {
	endpoint: string;
	N: number;
	C: number;
	ops: number;
	errors: number;
	wall_ms: number;
	throughput_per_sec: number;
	p50_ms: number;
	p90_ms: number;
	p99_ms: number;
	min_ms: number;
	max_ms: number;
}

/**
 * Issue `total` requests against `fetcher`, capped at `concurrency`
 * in-flight at any moment. Records per-request latency in ms.
 */
async function driveLoad(
	concurrency: number,
	total: number,
	fetcher: (i: number) => Promise<void>,
): Promise<{ latencies: number[]; errors: number; wallMs: number }> {
	const latencies: number[] = [];
	let errors = 0;
	let issued = 0;
	const wallStart = performance.now();

	async function worker(): Promise<void> {
		while (true) {
			const i = issued++;
			if (i >= total) return;
			const t0 = performance.now();
			try {
				await fetcher(i);
				latencies.push(performance.now() - t0);
			} catch {
				errors++;
			}
		}
	}

	const workers = Array.from({ length: Math.max(1, concurrency) }, () =>
		worker(),
	);
	await Promise.allSettled(workers);
	const wallMs = performance.now() - wallStart;
	return { latencies, errors, wallMs };
}

function summarize(
	endpoint: string,
	N: number,
	C: number,
	latencies: number[],
	errors: number,
	wallMs: number,
): CellResult {
	const sorted = latencies.slice().sort((a, b) => a - b);
	const ops = sorted.length;
	return {
		endpoint,
		N,
		C,
		ops,
		errors,
		wall_ms: Math.round(wallMs * 1000) / 1000,
		throughput_per_sec:
			wallMs > 0 ? Math.round((ops / (wallMs / 1000)) * 100) / 100 : 0,
		p50_ms: Math.round(pXX(sorted, 50) * 1000) / 1000,
		p90_ms: Math.round(pXX(sorted, 90) * 1000) / 1000,
		p99_ms: Math.round(pXX(sorted, 99) * 1000) / 1000,
		min_ms: ops > 0 ? Math.round(sorted[0]! * 1000) / 1000 : NaN,
		max_ms: ops > 0 ? Math.round(sorted[ops - 1]! * 1000) / 1000 : NaN,
	};
}

async function seedMemories(
	baseUrl: string,
	agentId: string,
	count: number,
	rng: () => number,
	seedConcurrency = 32,
): Promise<{ seeded: number; errors: number; wallMs: number }> {
	let issued = 0;
	let seeded = 0;
	let errors = 0;
	const t0 = performance.now();
	async function worker(): Promise<void> {
		while (true) {
			const i = issued++;
			if (i >= count) return;
			const body = JSON.stringify({
				args: [
					agentId,
					{
						id: `bench-seed-${i}`,
						type: "observation",
						content: buildContent(rng, i),
						timestamp: Date.now(),
					},
				],
			});
			try {
				const res = await fetch(`${baseUrl}/provider/writeMemory`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
					signal: AbortSignal.timeout(30_000),
				});
				if (res.ok) {
					seeded++;
				} else {
					errors++;
				}
				// drain body to free the socket
				await res.text().catch(() => "");
			} catch {
				errors++;
			}
		}
	}
	await Promise.allSettled(
		Array.from({ length: seedConcurrency }, () => worker()),
	);
	return { seeded, errors, wallMs: performance.now() - t0 };
}

async function measureRemember(
	baseUrl: string,
	agentId: string,
	rng: () => number,
	N: number,
	C: number,
	ops: number,
): Promise<CellResult> {
	const { latencies, errors, wallMs } = await driveLoad(C, ops, async (i) => {
		const body = JSON.stringify({
			args: [
				agentId,
				{
					id: `bench-measure-${N}-${i}`,
					type: "observation",
					content: buildContent(rng, N + i),
					timestamp: Date.now(),
				},
			],
		});
		const res = await fetch(`${baseUrl}/provider/writeMemory`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			signal: AbortSignal.timeout(30_000),
		});
		await res.text().catch(() => "");
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	});
	return summarize("POST /provider/writeMemory", N, C, latencies, errors, wallMs);
}

async function measureSearch(
	baseUrl: string,
	agentId: string,
	rng: () => number,
	N: number,
	C: number,
	ops: number,
): Promise<CellResult> {
	const queries = Array.from({ length: 32 }, (_, i) => buildContent(rng, i));
	const { latencies, errors, wallMs } = await driveLoad(C, ops, async (i) => {
		const body = JSON.stringify({
			query: queries[i % queries.length],
			limit: 5,
		});
		const res = await fetch(`${baseUrl}/search/${encodeURIComponent(agentId)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			signal: AbortSignal.timeout(30_000),
		});
		await res.text().catch(() => "");
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	});
	return summarize(
		"POST /search/<agentId>",
		N,
		C,
		latencies,
		errors,
		wallMs,
	);
}

async function measureKvList(
	baseUrl: string,
	scope: string,
	N: number,
	C: number,
	ops: number,
): Promise<CellResult> {
	const { latencies, errors, wallMs } = await driveLoad(C, ops, async () => {
		const res = await fetch(`${baseUrl}/kv/${encodeURIComponent(scope)}?values=true`, {
			method: "GET",
			signal: AbortSignal.timeout(30_000),
		});
		await res.text().catch(() => "");
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	});
	return summarize(
		"GET /kv/<scope>?values=true",
		N,
		C,
		latencies,
		errors,
		wallMs,
	);
}

interface RunReport {
	schema_version: 1;
	generated_at: string;
	git_sha: string;
	base_url: string;
	agent_id: string;
	scope: string;
	seed: number;
	matrix: { N: number[]; C: number[] };
	ops_per_cell: number;
	cells: CellResult[];
	notes: string;
}

async function main(): Promise<void> {
	const cfg = loadConfig();
	console.log(
		`[load-100k] base=${cfg.baseUrl} agent=${cfg.agentId} scope=${cfg.scope} N=${cfg.Ns.join(",")} C=${cfg.Cs.join(",")} ops/cell=${cfg.opsPerCell} seed=${cfg.seed}`,
	);

	try {
		console.log("[load-100k] waiting for /health (timeout 30s)");
		await waitForHealth(cfg.baseUrl, 30_000);

		const cells: CellResult[] = [];
		// N sorted ascending so each cell builds on the previous seed work.
		const sortedNs = cfg.Ns.slice().sort((a, b) => a - b);
		let seededSoFar = 0;
		for (const N of sortedNs) {
			const delta = N - seededSoFar;
			if (delta > 0) {
				console.log(
					`[load-100k] seeding ${delta} memories (target N=${N})`,
				);
				const rng = mulberry32(cfg.seed + seededSoFar);
				const seedRes = await seedMemories(cfg.baseUrl, cfg.agentId, delta, rng);
				seededSoFar += seedRes.seeded;
				console.log(
					`[load-100k]   seeded=${seedRes.seeded} errors=${seedRes.errors} wall=${(
						seedRes.wallMs / 1000
					).toFixed(2)}s`,
				);
				if (seedRes.errors > 0 && seedRes.seeded === 0) {
					throw new Error(
						`seeding produced 0 successes and ${seedRes.errors} errors — gateway misconfigured`,
					);
				}
			}

			for (const C of cfg.Cs) {
				const probeRng = mulberry32(cfg.seed ^ (N * 0x9e3779b1) ^ C);

				console.log(`[load-100k] cell N=${N} C=${C} remember`);
				const remember = await measureRemember(
					cfg.baseUrl,
					cfg.agentId,
					probeRng,
					N,
					C,
					cfg.opsPerCell,
				);
				cells.push(remember);

				console.log(`[load-100k] cell N=${N} C=${C} search`);
				const search = await measureSearch(
					cfg.baseUrl,
					cfg.agentId,
					mulberry32(cfg.seed ^ (N * 0x85ebca77) ^ C),
					N,
					C,
					cfg.opsPerCell,
				);
				cells.push(search);

				console.log(`[load-100k] cell N=${N} C=${C} kv-list`);
				const kvList = await measureKvList(
					cfg.baseUrl,
					cfg.scope,
					N,
					C,
					cfg.opsPerCell,
				);
				cells.push(kvList);
			}
		}

		const report: RunReport = {
			schema_version: 1,
			generated_at: new Date().toISOString(),
			git_sha: shortGitSha(),
			base_url: cfg.baseUrl,
			agent_id: cfg.agentId,
			scope: cfg.scope,
			seed: cfg.seed,
			matrix: { N: sortedNs, C: cfg.Cs.slice() },
			ops_per_cell: cfg.opsPerCell,
			cells,
			notes:
				"Single-process load harness. Latency in milliseconds. " +
				"Throughput is wall-clock ops/sec for the cell (concurrent in-flight = C). " +
				"Ported from upstream agentmemory benchmark/load-100k.ts.",
		};

		mkdirSync(cfg.outDir, { recursive: true });
		const outPath = join(cfg.outDir, `load-100k-${report.git_sha}.json`);
		writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
		console.log(`[load-100k] wrote ${outPath} (${cells.length} cells)`);

		// Compact table to stdout for the verification commit.
		console.log("");
		console.log(
			[
				"endpoint".padEnd(40),
				"N".padStart(8),
				"C".padStart(4),
				"ops".padStart(6),
				"err".padStart(4),
				"p50_ms".padStart(8),
				"p90_ms".padStart(8),
				"p99_ms".padStart(8),
				"tp/s".padStart(9),
			].join(" "),
		);
		for (const c of cells) {
			console.log(
				[
					c.endpoint.padEnd(40),
					String(c.N).padStart(8),
					String(c.C).padStart(4),
					String(c.ops).padStart(6),
					String(c.errors).padStart(4),
					c.p50_ms.toFixed(2).padStart(8),
					c.p90_ms.toFixed(2).padStart(8),
					c.p99_ms.toFixed(2).padStart(8),
					c.throughput_per_sec.toFixed(2).padStart(9),
				].join(" "),
			);
		}
	} catch (err) {
		console.error("[load-100k] failed:", err instanceof Error ? err.stack : err);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("[load-100k] failed:", err instanceof Error ? err.stack : err);
	process.exit(1);
});
