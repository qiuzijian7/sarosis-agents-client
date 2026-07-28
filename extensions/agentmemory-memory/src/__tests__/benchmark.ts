/**
 * benchmark.ts — 检索质量轻量评测（对齐 agentmemory benchmark/quality-eval.ts 的轻量版）
 *
 * 方法：确定性语料（mulberry32 PRNG，BENCH_SEED 可复现）→ 噪声记忆 N 条 +
 * 目标记忆 M 条（已知显著术语）→ 标注查询（与目标共享关键术语）→
 * searchMemories（真实检索路径：BM25 + 无向量降级）→
 * 每查询指标 hit@1 / recall@5 / recall@10 / MRR / latency → 汇总报告。
 *
 * 运行：npm run compile && node out/__tests__/benchmark.js
 * 环境变量：BENCH_SEED（默认 42）｜ BENCH_SCALES（默认 "100,1000"）｜
 *           BENCH_OUT（JSON 报告输出路径，可选）｜ BENCH_CHECK=1（hit@10 < 0.8 时退出码 1，回归门禁用）
 */
import * as fn from '../amFunctions.js';
import { BM25Index } from '../bm25Index.js';
import { KV } from '../amSchema.js';

const AGENT = 'bench-agent';

/** 内存 Mock KV（与 amV2.test.ts 同款，独立副本避免测试间依赖） */
class MockStateKV {
	private _store = new Map<string, Map<string, string>>();
	async get<T = unknown>(scope: string, key: string): Promise<T | null> {
		const scopeMap = this._store.get(scope);
		if (!scopeMap) return null;
		const raw = scopeMap.get(key);
		if (!raw) return null;
		return JSON.parse(raw) as T;
	}
	async set<T = unknown>(scope: string, key: string, value: T): Promise<void> {
		if (!this._store.has(scope)) this._store.set(scope, new Map());
		this._store.get(scope)!.set(key, JSON.stringify(value));
	}
	async delete(scope: string, key: string): Promise<void> {
		this._store.get(scope)?.delete(key);
	}
	async list<T = unknown>(scope: string): Promise<T[]> {
		const scopeMap = this._store.get(scope);
		if (!scopeMap) return [];
		const results: T[] = [];
		for (const raw of scopeMap.values()) {
			try { results.push(JSON.parse(raw) as T); } catch { /* skip */ }
		}
		return results;
	}
	async listKeys(scope: string): Promise<string[]> {
		const scopeMap = this._store.get(scope);
		return scopeMap ? Array.from(scopeMap.keys()) : [];
	}
	async clearScope(scope: string): Promise<void> {
		this._store.delete(scope);
	}
}

// ─── 确定性 PRNG（对齐原版 mulberry32 语料生成）────────────────────────────
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const NOISE_NOUNS = ['cache', 'widget', 'parser', 'handler', 'buffer', 'socket', 'cursor', 'bundle', 'schema', 'plugin', 'router', 'worker', 'ledger', 'cipher', 'anchor', 'beacon'];
const NOISE_VERBS = ['refactor', 'optimize', 'deprecate', 'migrate', 'sanitize', 'bootstrap', 'throttle', 'serialize', 'paginate', 'debounce'];
const NOISE_TYPES = ['fact', 'pattern', 'workflow', 'preference'] as const;

/** 目标记忆：显著多术语内容，查询与其共享关键术语（BM25 可检索） */
const TARGETS: Array<{ type: 'bug' | 'pattern' | 'workflow' | 'fact'; content: string; queries: string[] }> = [
	{ type: 'bug', content: 'login page crashes with null pointer when session token expires during oauth redirect', queries: ['login crash null pointer session token', 'oauth redirect expires crash'] },
	{ type: 'pattern', content: 'always use connection pooling with pgbouncer for postgresql database in production', queries: ['postgresql connection pooling pgbouncer', 'database pooling production'] },
	{ type: 'bug', content: 'redis cache invalidation race condition causes stale user profile data after update', queries: ['redis cache invalidation race condition', 'stale user profile cache'] },
	{ type: 'workflow', content: 'run vitest watch mode then fix failing snapshot tests before committing', queries: ['vitest watch snapshot tests failing', 'snapshot tests before commit'] },
	{ type: 'pattern', content: 'use zod schema validation for all api request bodies and return consistent error codes', queries: ['zod schema validation api request', 'api consistent error codes'] },
	{ type: 'bug', content: 'websocket reconnect loop floods server when network flaps every few seconds', queries: ['websocket reconnect loop floods', 'network flaps reconnect storm'] },
	{ type: 'pattern', content: 'cursor based pagination performs better than offset for large post listings', queries: ['cursor pagination vs offset', 'large listings pagination performance'] },
	{ type: 'fact', content: 'jwt access tokens expire after fifteen minutes and refresh tokens rotate weekly', queries: ['jwt access token expiry fifteen minutes', 'refresh token rotation weekly'] },
	{ type: 'bug', content: 'memory leak in image thumbnail generator when processing large batches concurrently', queries: ['memory leak thumbnail generator', 'image batches concurrent leak'] },
	{ type: 'workflow', content: 'deploy staging first run smoke tests then promote to production with canary', queries: ['staging smoke tests canary deploy', 'promote production canary deployment'] },
	{ type: 'pattern', content: 'use exponential backoff with jitter for retrying third party webhook deliveries', queries: ['exponential backoff jitter webhook retry', 'webhook delivery retry strategy'] },
	{ type: 'bug', content: 'graphql n+1 query problem when resolving nested author comments relation', queries: ['graphql n+1 nested author comments', 'n+1 query resolving relation'] },
	{ type: 'fact', content: 'eslint flat config requires typescript eslint plugin version eight or newer', queries: ['eslint flat config typescript plugin', 'typescript eslint version eight'] },
	{ type: 'pattern', content: 'prefer composition over inheritance for react component reuse with hooks', queries: ['react composition over inheritance hooks', 'component reuse composition'] },
	{ type: 'bug', content: 'csrf token mismatch on safari when cookies blocked in private browsing mode', queries: ['csrf token mismatch safari', 'cookies blocked private browsing csrf'] },
	{ type: 'workflow', content: 'write migration rollback script before running destructive database schema changes', queries: ['migration rollback script destructive schema', 'database changes rollback first'] },
	{ type: 'pattern', content: 'structured json logging with pino makes production debugging dramatically easier', queries: ['structured json logging pino', 'pino production debugging logs'] },
	{ type: 'bug', content: 'docker container oom killed during webpack build with source maps enabled', queries: ['docker oom killed webpack build', 'webpack source maps memory container'] },
	{ type: 'fact', content: 'rate limiter allows ten requests per second per api key with sliding window', queries: ['rate limiter ten requests second sliding window', 'api key rate limit sliding'] },
	{ type: 'pattern', content: 'use playwright page object model to keep e2e tests maintainable and readable', queries: ['playwright page object model e2e', 'e2e tests maintainable page object'] },
];

interface QueryMetric {
	query: string;
	targetId: string;
	hitAt1: number;
	recallAt5: number;
	recallAt10: number;
	mrr: number;
	latencyMs: number;
}

async function runScale(kv: MockStateKV, noiseCount: number, seed: number): Promise<{ metrics: QueryMetric[]; seedMs: number }> {
	const rand = mulberry32(seed);
	const targetIds: Array<{ id: string; queries: string[] }> = [];

	// 目标记忆
	for (const t of TARGETS) {
		const r = await fn.remember(kv as any, AGENT, t.content, t.type);
		targetIds.push({ id: r.id!, queries: t.queries });
	}
	// 噪声记忆
	const t0 = performance.now();
	for (let i = 0; i < noiseCount; i++) {
		const n1 = NOISE_NOUNS[Math.floor(rand() * NOISE_NOUNS.length)];
		const n2 = NOISE_NOUNS[Math.floor(rand() * NOISE_NOUNS.length)];
		const v = NOISE_VERBS[Math.floor(rand() * NOISE_VERBS.length)];
		const type = NOISE_TYPES[Math.floor(rand() * NOISE_TYPES.length)];
		const content = `${v} the ${n1} ${n2} module revision ${i} with routine maintenance`;
		await fn.remember(kv as any, AGENT, content, type);
	}
	const seedMs = performance.now() - t0;

	// BM25 索引（与测试一致的接线方式）
	const bm25 = new BM25Index();
	const all = await kv.list<any>(KV.memories(AGENT));
	for (const m of all) { if (m.isLatest !== false && m.content) { bm25.add(m.id, m.content); } }
	fn.setIndexGetters(() => bm25, () => null as any);

	// 查询评测
	const metrics: QueryMetric[] = [];
	for (const target of targetIds) {
		for (const q of target.queries) {
			const q0 = performance.now();
			const results = await fn.searchMemories(kv as any, AGENT, q, 10);
			const latencyMs = performance.now() - q0;
			const ids = results.map(r => r.id);
			const rank = ids.indexOf(target.id);
			metrics.push({
				query: q,
				targetId: target.id,
				hitAt1: rank === 0 ? 1 : 0,
				recallAt5: rank >= 0 && rank < 5 ? 1 : 0,
				recallAt10: rank >= 0 && rank < 10 ? 1 : 0,
				mrr: rank >= 0 ? 1 / (rank + 1) : 0,
				latencyMs,
			});
		}
	}
	return { metrics, seedMs };
}

function avg(nums: number[]): number {
	return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

export async function run(): Promise<void> {
	const seed = Number(process.env['BENCH_SEED'] ?? 42);
	const scales = (process.env['BENCH_SCALES'] ?? '100,1000').split(',').map(s => Number(s.trim())).filter(n => n > 0);
	const report: Record<string, unknown> = { schema_version: 1, seed, targets: TARGETS.length, queries: TARGETS.length * 2, scales: {} };
	let worstHit10 = 1;

	console.log(`\n=== AgentMemory 检索质量评测（seed=${seed}，targets=${TARGETS.length}，queries=${TARGETS.length * 2}）===`);
	for (const noise of scales) {
		const kv = new MockStateKV();
		const { metrics, seedMs } = await runScale(kv, noise, seed);
		const hit1 = avg(metrics.map(m => m.hitAt1));
		const r5 = avg(metrics.map(m => m.recallAt5));
		const r10 = avg(metrics.map(m => m.recallAt10));
		const mrr = avg(metrics.map(m => m.mrr));
		const lat = metrics.map(m => m.latencyMs).sort((a, b) => a - b);
		const p50 = lat[Math.floor(lat.length * 0.5)] ?? 0;
		const p90 = lat[Math.floor(lat.length * 0.9)] ?? 0;
		worstHit10 = Math.min(worstHit10, r10);
		(report['scales'] as Record<string, unknown>)[`noise_${noise}`] = {
			noise, hit_at_1: +hit1.toFixed(3), recall_at_5: +r5.toFixed(3), recall_at_10: +r10.toFixed(3),
			mrr: +mrr.toFixed(3), latency_p50_ms: +p50.toFixed(2), latency_p90_ms: +p90.toFixed(2), seed_ms: +seedMs.toFixed(0),
		};
		console.log(`\n  corpus=${TARGETS.length} targets + ${noise} noise (seed ${seedMs.toFixed(0)}ms)`);
		console.log(`    hit@1=${hit1.toFixed(2)}  recall@5=${r5.toFixed(2)}  recall@10=${r10.toFixed(2)}  MRR=${mrr.toFixed(3)}`);
		console.log(`    latency p50=${p50.toFixed(2)}ms  p90=${p90.toFixed(2)}ms`);
	}

	const outPath = process.env['BENCH_OUT'];
	if (outPath) {
		const { writeFileSync, mkdirSync } = await import('node:fs');
		const { dirname } = await import('node:path');
		mkdirSync(dirname(outPath), { recursive: true });
		writeFileSync(outPath, JSON.stringify(report, null, 2));
		console.log(`\n报告已写入 ${outPath}`);
	}

	if (process.env['BENCH_CHECK'] === '1' && worstHit10 < 0.8) {
		console.error(`\n[FAIL] worst recall@10 ${worstHit10.toFixed(2)} < 0.8 阈值`);
		process.exit(1);
	}
	console.log('');
}

// 直接执行（与 runAllTests 模式一致）
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!);
if (isMain || process.argv[1]?.endsWith('benchmark.js')) {
	run().catch((err) => { console.error(err); process.exit(1); });
}
