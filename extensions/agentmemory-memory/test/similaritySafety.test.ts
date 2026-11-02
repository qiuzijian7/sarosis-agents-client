/*---------------------------------------------------------------------------------------------
 *  similaritySafety.test.ts — 相似度口径与归档层回归（2026-11-02）
 *
 *  钉住四件会被"静默改坏"的事：
 *   ① 中文可判近重复（旧口径按空白切词 ⇒ 整句只有 1 个 token ⇒ 永远 0）；
 *   ② **空集不再等于 1.0**（旧实现「双空集 ⇒ 1」会把两条短中文记忆判成完全相同
 *      ⇒ 后者把前者标 isLatest=false ⇒ 7 天后被 evict 硬删）；
 *   ③ `remember` 只在**同 type** 内判近重复（跨 type 误判同样会删除旧条）；
 *   ④ 被取代的旧版本进**归档**而不是消失，且归档有 90 天出口。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { evict, remember, pruneArchive, ARCHIVE_TTL_MS } from '../src/amFunctions.js';
import { KV } from '../src/amSchema.js';
import { jaccardSimilarity, similarityTokens } from '../src/similarity.js';
import type { Memory } from '../src/amTypes.js';

const DAY = 86_400_000;
const AGENT = 'similarity-safety-agent';

/** 最小内存 KV（与 sweepSafety.test.ts 的 MemKV 同形）。 */
class MemKV {
	private readonly _store = new Map<string, Map<string, string>>();
	async get<T = unknown>(scope: string, key: string): Promise<T | null> {
		const raw = this._store.get(scope)?.get(key);
		return raw ? JSON.parse(raw) as T : null;
	}
	async set<T = unknown>(scope: string, key: string, value: T): Promise<void> {
		if (!this._store.has(scope)) { this._store.set(scope, new Map()); }
		this._store.get(scope)!.set(key, JSON.stringify(value));
	}
	async delete(scope: string, key: string): Promise<void> { this._store.get(scope)?.delete(key); }
	async list<T = unknown>(scope: string): Promise<T[]> {
		return [...(this._store.get(scope)?.values() ?? [])].map(v => JSON.parse(v) as T);
	}
	async listKeys(scope: string): Promise<string[]> { return [...(this._store.get(scope)?.keys() ?? [])]; }
	async listScopes(prefix: string): Promise<string[]> { return [...this._store.keys()].filter(s => s.startsWith(prefix)); }
	async clearScope(scope: string): Promise<void> { this._store.delete(scope); }
	async ensureConnected(): Promise<void> { /* noop */ }
	dispose(): void { /* noop */ }
	has(scope: string, key: string): boolean { return this._store.get(scope)?.has(key) ?? false; }
}

function mem(id: string, content: string, opts: Partial<Memory> & { ageDays?: number } = {}): Memory {
	const at = new Date(Date.now() - (opts.ageDays ?? 0) * DAY).toISOString();
	return {
		id, createdAt: at, updatedAt: opts.updatedAt ?? at, type: 'fact', title: id, content,
		concepts: [], files: [], sessionIds: [], strength: 7, version: 1, isLatest: true,
		...opts,
	};
}

async function seed(kv: MemKV, items: Memory[]): Promise<void> {
	for (const m of items) { await kv.set(KV.memories(AGENT), m.id, m); }
}

suite('相似度口径（2026-11-02）', () => {

	test('中文：近重复能判出来（旧口径恒 0）', () => {
		const a = '本项目使用 pnpm 管理依赖，并且锁定版本号';
		const b = '本项目使用 pnpm 管理依赖，并锁定版本号';
		const sim = jaccardSimilarity(a, b);
		assert.ok(sim > 0.7, `中文近重复应 > 0.7，实际 ${sim}`);
	});

	test('中文：完全不同的两句 ⇒ 0（不是 1）', () => {
		assert.strictEqual(jaccardSimilarity('构建产物要提交到仓库', '用户偏好在夜间跑全量回归'), 0);
	});

	test('★ 短中文句子不再被判成"完全相同"（旧口径双空集 ⇒ 1.0）', () => {
		// 这两个串在旧口径下 token 全是 ≤2 字符 ⇒ 两边都是空集 ⇒ 旧实现返回 1.0
		assert.strictEqual(jaccardSimilarity('已修复', '已回滚'), 0, '两条短中文必须是 0，否则会互删');
		assert.strictEqual(jaccardSimilarity('', ''), 0, '双空串不得判成相似');
	});

	test('英文行为保持：全同 = 1，不同 = 0', () => {
		assert.strictEqual(jaccardSimilarity('alpha bravo charlie', 'alpha bravo charlie'), 1);
		assert.strictEqual(jaccardSimilarity('alpha bravo charlie', 'delta echo foxtrot'), 0);
	});

	test('tokenizer：CJK bigram 生效，且 token 数有上限', () => {
		// 4 个汉字 ⇒ 3 个 bigram（含跨界的那一个）
		const tokens = similarityTokens('部署端口');
		assert.deepStrictEqual([...tokens].sort(), ['部署', '署端', '端口'].sort());
		const long = similarityTokens('中文'.repeat(2000));
		assert.ok(long.size <= 256, `token 数必须封顶，实际 ${long.size}`);
	});
});

suite('写入侧：近重复判定（2026-11-02）', () => {

	test('★ 跨 type 的近重复不判 supersede（否则旧条被归档、检索里消失）', async () => {
		const kv = new MemKV();
		const a = await remember(kv as any, AGENT, '本项目使用 pnpm 管理依赖，并锁定版本号', 'fact');
		assert.strictEqual(a.action, 'created');
		const b = await remember(kv as any, AGENT, '本项目使用 pnpm 管理依赖，并锁定版本号（注意 workspace）', 'bug');
		assert.strictEqual(b.action, 'created', '跨 type 不得 supersede');
		const first = await kv.get<Memory>(KV.memories(AGENT), a.id!);
		assert.strictEqual(first?.isLatest, true, '原条目必须仍是 latest');
	});

	test('同 type 的近重复仍然 supersede（能力没被削弱）', async () => {
		const kv = new MemKV();
		const a = await remember(kv as any, AGENT, '本项目使用 pnpm 管理依赖，并锁定版本号', 'fact');
		const b = await remember(kv as any, AGENT, '本项目使用 pnpm 管理依赖，并锁定版本号吧', 'fact');
		assert.strictEqual(b.action, 'superseded', `同 type 近重复应 supersede，实际 ${b.action}`);
		const old = await kv.get<Memory>(KV.memories(AGENT), a.id!);
		assert.strictEqual(old?.isLatest, false);
	});
});

suite('归档层（2026-11-02）', () => {

	test('★ evict：被取代的旧版本进归档，不再直接消失', async () => {
		const kv = new MemKV();
		await seed(kv, [mem('superseded', 'mike november oscar papa', { isLatest: false, ageDays: 10 })]);
		const stats = await evict(kv as any, AGENT, false);

		assert.strictEqual(stats.nonLatest, 1);
		assert.strictEqual(stats.archived, 1, '应记一条归档');
		assert.ok(!kv.has(KV.memories(AGENT), 'superseded'), 'memories 里必须移除（否则还会进索引）');
		const archived = await kv.get<Memory & { archivedAt?: string; archiveReason?: string }>(KV.archive(AGENT), 'superseded');
		assert.ok(archived, '★ 归档里必须能读回原条目');
		assert.ok(archived!.archivedAt, '必须带 archivedAt');
		assert.strictEqual(archived!.archiveReason, 'superseded');
	});

	test('dryRun 不写归档（只统计）', async () => {
		const kv = new MemKV();
		await seed(kv, [mem('ghost', 'quebec romeo sierra tango', { isLatest: false, ageDays: 10 })]);
		const stats = await evict(kv as any, AGENT, true);
		assert.strictEqual(stats.nonLatest, 1);
		assert.strictEqual(stats.archived, 0);
		assert.ok(kv.has(KV.memories(AGENT), 'ghost'), 'dryRun 不得动数据');
	});

	test('归档有 90 天出口：超期清掉，未超期保留', async () => {
		const kv = new MemKV();
		const oldAt = new Date(Date.now() - ARCHIVE_TTL_MS - DAY).toISOString();
		const freshAt = new Date(Date.now() - DAY).toISOString();
		await kv.set(KV.archive(AGENT), 'old', { ...mem('old', 'x y z'), archivedAt: oldAt });
		await kv.set(KV.archive(AGENT), 'fresh', { ...mem('fresh', 'x y z'), archivedAt: freshAt });

		const removed = await pruneArchive(kv as any, AGENT);
		assert.strictEqual(removed, 1);
		assert.ok(!kv.has(KV.archive(AGENT), 'old'), '超期归档应被清掉');
		assert.ok(kv.has(KV.archive(AGENT), 'fresh'), '未超期归档必须保留');
	});
});
