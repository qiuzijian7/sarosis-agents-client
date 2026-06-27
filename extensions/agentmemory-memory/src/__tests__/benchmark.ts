/*---------------------------------------------------------------------------------------------
 *  性能基准测试 — 测试 1000+ 记忆的写入/搜索延迟。
 *  编译后: node out/__tests__/benchmark.js
 *
 *  测试项:
 *    1. BM25 批量索引 1000 条 + 搜索延迟
 *    2. VectorIndex 批量索引 1000 条 + 搜索延迟（使用 embedSync）
 *    3. DedupManager 1000 次去重检查
 *    4. PrivacyFilter 1000 次过滤
 *    5. RRF 融合 4 路 × 1000 结果
 *--------------------------------------------------------------------------------------------*/
import { BM25Index } from '../bm25Index.js';
import { VectorIndex, embedSync } from '../vectorIndex.js';
import { DedupManager } from '../dedup.js';
import { stripPrivateData } from '../privacyFilter.js';
import { rrfFuse, type RRFStream } from '../rrf.js';

const N = 1000;

function generateContent(i: number): string {
	const topics = ['machine learning', 'data structure', 'web development', 'database design',
		'API architecture', 'testing strategy', 'code review', 'deployment pipeline',
		'security analysis', 'performance optimization'];
	const topic = topics[i % topics.length];
	const words = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'has', 'have', 'will',
		'important', 'critical', 'essential', 'useful', 'common', 'rare', 'complex', 'simple'];
	const w1 = words[(i * 3) % words.length];
	const w2 = words[(i * 7) % words.length];
	return `${topic} ${w1} ${w2} document number ${i} with some additional context about implementation details and best practices`;
}

function bench(name: string, fn: () => void): { name: string; totalMs: number; avgMs: number; ops: number } {
	const start = process.hrtime.bigint();
	fn();
	const end = process.hrtime.bigint();
	const totalMs = Number(end - start) / 1_000_000;
	const avgMs = totalMs / N;
	console.log(`  ${name}: ${totalMs.toFixed(1)}ms total, ${avgMs.toFixed(3)}ms/op (${N} ops)`);
	return { name, totalMs, avgMs, ops: N };
}

async function benchAsync(name: string, fn: () => Promise<void>): Promise<{ name: string; totalMs: number; avgMs: number; ops: number }> {
	const start = process.hrtime.bigint();
	await fn();
	const end = process.hrtime.bigint();
	const totalMs = Number(end - start) / 1_000_000;
	const avgMs = totalMs / N;
	console.log(`  ${name}: ${totalMs.toFixed(1)}ms total, ${avgMs.toFixed(3)}ms/op (${N} ops)`);
	return { name, totalMs, avgMs, ops: N };
}

async function main(): Promise<void> {
	console.log(`\n📊 AgentMemory Benchmark — ${N} memories\n`);

	// ── 1. BM25 ──
	console.log('── BM25 Index ──');
	const bm25 = new BM25Index();
	bench('BM25 add', () => {
		for (let i = 0; i < N; i++) {
			bm25.add(`doc-${i}`, generateContent(i));
		}
	});
	const bm25SearchResults: number[] = [];
	bench('BM25 search', () => {
		for (let i = 0; i < N; i++) {
			const results = bm25.search(`machine learning document ${i % 100}`, 20);
			bm25SearchResults.push(results.length);
		}
	});
	const avgResults = bm25SearchResults.reduce((a, b) => a + b, 0) / bm25SearchResults.length;
	console.log(`    avg results per search: ${avgResults.toFixed(1)}`);

	// ── 2. VectorIndex (using embedSync) ──
	console.log('\n── VectorIndex (trigram fallback) ──');
	const vector = new VectorIndex();
	bench('Vector embed+add', () => {
		for (let i = 0; i < N; i++) {
			const vec = embedSync(generateContent(i));
			if (vec) vector.add(`vec-${i}`, vec);
		}
	});
	await benchAsync('Vector search', async () => {
		for (let i = 0; i < N; i++) {
			await vector.search(`learning optimization ${i % 50}`, 20);
		}
	});
	console.log(`    vector index size: ${vector.size}`);

	// ── 3. DedupManager ──
	console.log('\n── DedupManager ──');
	const dedup = new DedupManager();
	await benchAsync('Dedup check (unique)', async () => {
		for (let i = 0; i < N; i++) {
			await dedup.isDuplicate(`unique content ${i}`);
		}
	});
	console.log(`    dedup size: ${dedup.size}`);
	// Test duplicate detection
	const dupStart = process.hrtime.bigint();
	for (let i = 0; i < N; i++) {
		await dedup.isDuplicate(`unique content ${i}`); // should be duplicates
	}
	const dupMs = Number(process.hrtime.bigint() - dupStart) / 1_000_000;
	console.log(`  Dedup check (duplicate): ${dupMs.toFixed(1)}ms total, ${(dupMs / N).toFixed(3)}ms/op`);

	// ── 4. PrivacyFilter ──
	console.log('\n── PrivacyFilter ──');
	bench('PrivacyFilter strip', () => {
		for (let i = 0; i < N; i++) {
			stripPrivateData(`User input ${i} with api_key=sk-test${i}12345678901234567890 and <private>secret</private>`);
		}
	});

	// ── 5. RRF Fusion ──
	console.log('\n── RRF Fusion ──');
	const streams: RRFStream[] = [
		{ results: Array.from({ length: N }, (_, i) => ({ id: `bm25-${i}` })), weight: 0.35 },
		{ results: Array.from({ length: N }, (_, i) => ({ id: `vec-${i}` })), weight: 0.40 },
		{ results: Array.from({ length: N / 2 }, (_, i) => ({ id: `graph-${i}` })), weight: 0.15 },
		{ results: Array.from({ length: N / 4 }, (_, i) => ({ id: `text-${i}` })), weight: 0.10 },
	];
	bench('RRF fuse (4 streams × 1000)', () => {
		rrfFuse(streams, 60);
	});

	// ── 6. Combined write+search (simulates real usage) ──
	console.log('\n── Combined (write + search) ──');
	const combinedBm25 = new BM25Index();
	const combinedVector = new VectorIndex();
	bench('Combined write (BM25+Vector)', () => {
		for (let i = 0; i < N; i++) {
			const content = generateContent(i);
			combinedBm25.add(`c-${i}`, content);
			const vec = embedSync(content);
			if (vec) combinedVector.add(`c-${i}`, vec);
		}
	});
	await benchAsync('Combined search (BM25+Vector+RRF)', async () => {
		const query = 'machine learning optimization';
		const bm25Results = combinedBm25.search(query, 20);
		const vecResults = await combinedVector.search(query, 20);
		rrfFuse([
			{ results: bm25Results, weight: 0.35 },
			{ results: vecResults, weight: 0.40 },
		], 60);
	});

	console.log('\n✅ Benchmark complete.\n');
}

main().catch(err => {
	console.error('Fatal:', err);
	process.exit(1);
});
