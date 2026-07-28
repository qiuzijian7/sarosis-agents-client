/*---------------------------------------------------------------------------------------------
 *  记忆 读取 / 写入 / 检索 生命周期测试
 *
 *  覆盖 amFunctions.ts 调用图的核心节点（无状态引擎层，不依赖网关进程）：
 *    WRITE  : remember → kv.set(mem:memories)           [指纹去重 / Jaccard 版本链]
 *             writeMemory → coreAdd | remember          [slot/working/normal 路由]
 *    READ   : buildContext / loadContextFn → kv.list(多 scope) [token budget 截断]
 *             getStatsFn → kv.list
 *    RETRIEVE: searchMemories → BM25.search → RRF 融合 → KV 回填
 *             searchMemories('') → fallbackKVRecall        [网关不可用安全网]
 *    LIFECYCLE: forgetMemory / reinforceMemory → kv.set(isLatest/strength)
 *
 *  运行：npm run compile 后，由 tmp/run_rwr_tests.mjs 导入 runMemoryRWRTests() 执行。
 *--------------------------------------------------------------------------------------------*/

import * as fn from '../amFunctions.js';
import { BM25Index } from '../bm25Index.js';
import { KV } from '../amSchema.js';

const AGENT_ID = 'test-rwr';

// ─── MiniStateKV（内存态，深拷贝模拟磁盘 KV）─────────────────────────────
class MiniStateKV {
	private _data = new Map<string, Map<string, any>>();
	private _scope(s: string): Map<string, any> {
		if (!this._data.has(s)) this._data.set(s, new Map());
		return this._data.get(s)!;
	}
	async get<T>(scope: string, key: string): Promise<T | null> {
		const s = this._scope(scope);
		return s.has(key) ? JSON.parse(JSON.stringify(s.get(key))) as T : null;
	}
	async set(scope: string, key: string, value: any): Promise<void> {
		this._scope(scope).set(key, JSON.parse(JSON.stringify(value)));
	}
	async delete(scope: string, key: string): Promise<void> {
		this._scope(scope).delete(key);
	}
	async list<T>(scope: string): Promise<T[]> {
		return Array.from(this._scope(scope).values()).map(v => JSON.parse(JSON.stringify(v))) as T[];
	}
	async listKeys(scope: string): Promise<string[]> {
		return Array.from(this._scope(scope).keys());
	}
	async clearScope(scope: string): Promise<void> {
		this._data.delete(scope);
	}
}

// ─── 断言工具 ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
	if (!cond) { failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) { failures.push(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); console.log(`  ✗ ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
}
async function test(name: string, fnBody: (kv: MiniStateKV) => Promise<void>): Promise<void> {
	console.log(`\n▶ ${name}`);
	const kv = new MiniStateKV();
	const before = failures.length;
	try { await fnBody(kv); }
	catch (e: any) { failures.push(`${name}: exception = ${e?.message}`); console.log(`  ✗ EXCEPTION: ${e?.message}`); }
	if (failures.length === before) { passed++; console.log('  ✅ passed'); }
	else failed++;
}

// ─── 测试主体 ─────────────────────────────────────────────────────────────

export async function runMemoryRWRTests(): Promise<void> {
	passed = 0; failed = 0; failures.length = 0;
	console.log('📦 Memory Read/Write/Retrieve Lifecycle Tests\n');
	console.log('═'.repeat(60));

	// ── WRITE：remember 创建 ──────────────────────────────────────────
	await test('W1: remember 写入 mem:memories，指纹作 ID、isLatest=true、strength=7', async (kv) => {
		const content = 'Use strict mode in TypeScript files for correctness';
		const r = await fn.remember(kv as any, AGENT_ID, content, 'pattern');
		eq(r.success, true, 'success');
		eq(r.action, 'created', 'action');
		const mem = await kv.get<any>(KV.memories(AGENT_ID), r.id!);
		assert(!!mem, 'memory persisted');
		eq(mem.isLatest, true, 'isLatest');
		eq(mem.type, 'pattern', 'type');
		eq(mem.strength, 7, 'strength');
		eq(r.id!.startsWith('mem_'), true, 'id uses mem_ fingerprint prefix');
	});

	// ── WRITE：指纹去重 ───────────────────────────────────────────────
	await test('W2: 相同内容二次 remember → deduplicated，不重复写', async (kv) => {
		const content = 'Duplicate content detection test';
		const r1 = await fn.remember(kv as any, AGENT_ID, content, 'fact');
		const r2 = await fn.remember(kv as any, AGENT_ID, content, 'fact');
		eq(r2.id, r1.id, 'same fingerprint id');
		eq(r2.action, 'deduplicated', 'action');
		const all = await kv.list<any>(KV.memories(AGENT_ID));
		const active = all.filter(m => m.isLatest !== false);
		eq(active.length, 1, 'only 1 active memory');
	});

	// ── WRITE：Jaccard > 0.7 版本链 ──────────────────────────────
	await test('W3: Jaccard >0.7 相似 → superseded，旧版 isLatest=false、version+1', async (kv) => {
		const r1 = await fn.remember(kv as any, AGENT_ID, 'Jaccard base: alpha beta gamma delta epsilon', 'pattern');
		const r2 = await fn.remember(kv as any, AGENT_ID, 'Jaccard base: alpha beta gamma delta epsilon zeta', 'pattern');
		eq(r2.action, 'superseded', 'action');
		assert(r2.id !== r1.id, 'different id for new version');
		const oldMem = await kv.get<any>(KV.memories(AGENT_ID), r1.id!);
		const newMem = await kv.get<any>(KV.memories(AGENT_ID), r2.id!);
		eq(oldMem.isLatest, false, 'old isLatest=false');
		eq(oldMem.version, 1, 'old version=1');
		eq(newMem.isLatest, true, 'new isLatest=true');
		eq(newMem.version, 2, 'new version=2');
		eq(newMem.parentId, r1.id, 'parentId points to old');
	});

	// ── WRITE：writeMemory 路由（working→core / normal→remember / slot→core pinned）──
	await test('W4: writeMemory 路由 — working→coreMemory，normal→memories', async (kv) => {
		await fn.writeMemory(kv as any, AGENT_ID, { type: 'working', content: 'core note', metadata: { importance: 5, pinned: true } } as any);
		await fn.writeMemory(kv as any, AGENT_ID, { type: 'bug', content: 'a bug memory' } as any);
		const core = await kv.list<any>(KV.coreMemory(AGENT_ID));
		assert(core.some(e => e.content === 'core note' && e.pinned === true), 'working routed to pinned core');
		const mems = await kv.list<any>(KV.memories(AGENT_ID));
		assert(mems.some(m => m.type === 'bug' && m.content === 'a bug memory'), 'normal routed to memories');
	});

	await test('W5: writeMemory slot_id 元数据 → coreAdd pinned', async (kv) => {
		await fn.writeMemory(kv as any, AGENT_ID, { type: 'fact', content: 'slot content', metadata: { slot_id: 's1' } } as any);
		const core = await kv.list<any>(KV.coreMemory(AGENT_ID));
		const found = core.find(e => e.content === 'slot content');
		assert(!!found, 'slot content in core');
		eq(found!.pinned, true, 'slot is pinned');
	});

	// ── READ：buildContext / getStatsFn ───────────────────────────────
	// 2026-07-25 mem::context 对齐：注入文本只含策展块（lessons/summaries/…），
	// core/原始 memory 不进注入文本（召回走工具），仅在返回值数组中。
	await test('R1: buildContext（无 query）策展块注入 + core/memory 仅进返回值', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'Important core rule', 9, true);
		await fn.remember(kv as any, AGENT_ID, 'memory A about react patterns', 'pattern');
		await fn.remember(kv as any, AGENT_ID, 'memory B about typescript generics', 'pattern');
		await fn.lessonSave(kv as any, AGENT_ID, 'always lint before push', 'workflow', 0.9);
		const ctx = await fn.buildContext(kv as any, AGENT_ID, 'sess-R1', 'proj', 5000);
		assert(ctx.systemPrompt.includes('<agentmemory-context'), 'XML wrapper present');
		assert(ctx.systemPrompt.includes('always lint before push'), 'lesson injected');
		assert(!ctx.systemPrompt.includes('Important core rule'), 'core NOT injected (tool-driven recall)');
		assert(!ctx.systemPrompt.includes('memory A about react'), 'raw memory NOT injected');
		assert(ctx.longTermMemories.length >= 1, 'longTermMemories populated');
		assert(ctx.shortTermMemories.length >= 1, 'shortTermMemories populated');
		assert((ctx.contextBlocks ?? 0) >= 1, 'contextBlocks metadata present');
		assert((ctx.contextTokens ?? 0) > 0, 'contextTokens metadata present');
	});

	await test('R2: getStatsFn 返回各 scope 计数', async (kv) => {
		await fn.coreAdd(kv as any, AGENT_ID, 'core x', 5);
		await fn.remember(kv as any, AGENT_ID, 'mem x', 'fact');
		await fn.lessonSave(kv as any, AGENT_ID, 'lesson x', 'ctx', 0.9);
		const s = await fn.getStatsFn(kv as any, AGENT_ID);
		eq(s.longTermCount, 1, 'longTermCount');
		eq(s.coreMemoryCount, 1, 'coreMemoryCount');
		eq(s.lessonsCount, 1, 'lessonsCount');
	});

	await test('R3: loadContextFn（带 query）→ 策展块内含 Relevant Memories 附加块', async (kv) => {
		const r = await fn.remember(kv as any, AGENT_ID, 'React server components pattern', 'pattern');
		const bm25 = new BM25Index();
		bm25.add(r.id!, 'React server components pattern');
		fn.setIndexGetters(() => bm25, () => null as any);
		const ctx = await fn.loadContextFn(kv as any, AGENT_ID, 'sess-R3', 'react', 5000);
		// 2026-07-25 P0：query 召回是 ≤30% 预算的附加块，不再替代整个策展
		assert(ctx.systemPrompt.includes('Relevant Memories'), 'relevant memories block injected');
		assert(ctx.systemPrompt.includes('React server components'), 'matched memory in prompt');
		assert(!ctx.systemPrompt.includes('Search Results'), 'old full-dump branch removed');
	});

	// ── RETRIEVE：searchMemories（BM25 命中 / 空查询回退 / KV 安全网）──
	await test('S1: searchMemories BM25 命中 → source=bm25、score>0', async (kv) => {
		const r = await fn.remember(kv as any, AGENT_ID, 'React server components pattern', 'pattern');
		const bm25 = new BM25Index();
		bm25.add(r.id!, 'React server components pattern');
		fn.setIndexGetters(() => bm25, () => null as any);
		const results = await fn.searchMemories(kv as any, AGENT_ID, 'React', 10);
		assert(results.length > 0, 'found results');
		eq(results[0].source, 'bm25', 'source=bm25');
		assert(results[0].score > 0, 'score>0');
		assert(results[0].content.includes('React'), 'content correct');
	});

	await test('S2: searchMemories 空 query → fallbackKVRecall（按 strength 排序，source=kv）', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'fallback memory alpha', 'fact');
		await fn.remember(kv as any, AGENT_ID, 'fallback memory beta', 'fact');
		const results = await fn.searchMemories(kv as any, AGENT_ID, '', 10);
		assert(results.length >= 1, 'returns ranked memories');
		eq(results[0].source, 'kv', 'source=kv');
	});

	await test('S3: 网关不可用时安全网 — BM25 空 + 非空 query → 返回 []（不崩）', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'some memory', 'fact');
		fn.setIndexGetters(() => new BM25Index(), () => null as any); // 空索引
		const results = await fn.searchMemories(kv as any, AGENT_ID, 'nonexistent-xyz', 10);
		eq(results.length, 0, 'empty index + no match → []');
	});

	await test('S4: searchMemoryFn 回填原生 type（来自 KV）', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'typescript strict mode guideline', 'preference');
		const bm25 = new BM25Index();
		const all = await kv.list<any>(KV.memories(AGENT_ID));
		for (const m of all) if (m.isLatest !== false && m.content) bm25.add(m.id, m.content);
		fn.setIndexGetters(() => bm25, () => null as any);
		const results = await fn.searchMemoryFn(kv as any, AGENT_ID, 'typescript');
		assert(results.length > 0, 'found');
		eq(results[0].type, 'preference', 'native type from KV');
	});

	// ── LIFECYCLE：forget / reinforce ────────────────────────────────
	await test('L1: 完整生命周期 — remember→检索命中→forget→检索排除', async (kv) => {
		const r = await fn.remember(kv as any, AGENT_ID, 'lifecycle memory about docker deploy', 'pattern');
		const bm25 = new BM25Index();
		bm25.add(r.id!, 'lifecycle memory about docker deploy');
		fn.setIndexGetters(() => bm25, () => null as any);
		const before = await fn.searchMemories(kv as any, AGENT_ID, 'docker', 10);
		assert(before.length > 0, 'found before forget');
		const ok = await fn.forgetMemory(kv as any, AGENT_ID, r.id!);
		eq(ok, true, 'forget returns true');
		const after = await fn.searchMemories(kv as any, AGENT_ID, 'docker', 10);
		eq(after.length, 0, 'excluded after forget (isLatest=false filtered)');
		const mem = await kv.get<any>(KV.memories(AGENT_ID), r.id!);
		eq(mem.isLatest, false, 'isLatest=false after forget');
	});

	await test('L2: reinforceMemory 提升 strength', async (kv) => {
		const r = await fn.remember(kv as any, AGENT_ID, 'reinforce me please', 'fact');
		const before = (await kv.get<any>(KV.memories(AGENT_ID), r.id!)).strength;
		await fn.reinforceMemory(kv as any, AGENT_ID, r.id!);
		const after = (await kv.get<any>(KV.memories(AGENT_ID), r.id!)).strength;
		eq(after, before + 1, 'strength +1');
	});

	// ── 结果 ───────────────────────────────────────────────────────────
	const total = passed + failed;
	console.log(`\n${'═'.repeat(60)}`);
	console.log(`  RWR Results: ${passed} passed, ${failed} failed, ${total} total`);
	if (failures.length > 0) {
		console.log(`\n  Failures:`);
		for (const f of failures) console.log(`    - ${f}`);
	}
	console.log(`${'═'.repeat(60)}\n`);
}
