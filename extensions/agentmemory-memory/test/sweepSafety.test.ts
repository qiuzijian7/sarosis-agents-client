/*---------------------------------------------------------------------------------------------
 *  sweepSafety.test.ts — 定时 sweep 的止血回归（2026-10-20）
 *
 *  背景：IDE 侧聊天框（AgentMemory 唯一的自动写入方）已停用 ⇒ 历史分区不会再有新数据，
 *  而 sweep 仍每 5 分钟跑一次。这里钉住三件事：
 *    ① `evict` / `autoForget` 里**基于 strength 的删除只上报、不执行**（strength 0–10 / 0–1 两套刻度
 *       混用 ⇒「≤2」在 0–1 刻度下等于全部；实测 4027 条会被整批硬删）；
 *       同时证明**合法**的删除路径没被误伤（forgetAfter 到期、被取代的旧版本）。
 *    ② `extractEpisodic` 在**没有新输入**时不再每轮新写一条 episode。
 *  ⚠ 网关侧"冻结长期无写入的分区"在 `agentmemory-gateway/host/host.mjs`，那里没有单测入口，
 *    靠启动日志 `sweep: N/M partition(s) frozen` 验证。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { evict, autoForget } from '../src/amFunctions.js';
import { extractEpisodic } from '../src/amPipeline.js';
import { KV } from '../src/amSchema.js';
import type { Memory } from '../src/amTypes.js';

const DAY = 86_400_000;
const AGENT = 'sweep-safety-agent';

/** 最小内存 KV（与 `src/__tests__/amV2.test.ts` 的 MockStateKV 同形）。 */
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

suite('sweep 止血（2026-10-20）', () => {

	test('evict：strength ≤ 2 且 >90 天 ⇒ 只计数不删除；forgetAfter 到期 / 旧版本 仍照删', async () => {
		const kv = new MemKV();
		await seed(kv, [
			// 0–1 刻度写进来的"最重要"条目（autoPage：importance 10 / 10 = 1.0）—— 修复前会被硬删
			mem('weak-old', 'alpha bravo charlie delta', { strength: 1, ageDays: 100 }),
			mem('strong-old', 'echo foxtrot golf hotel', { strength: 7, ageDays: 100 }),
			mem('ttl-expired', 'india juliet kilo lima', { forgetAfter: new Date(Date.now() - DAY).toISOString() }),
			mem('superseded', 'mike november oscar papa', { isLatest: false, ageDays: 10 }),
		]);
		const stats = await evict(kv as any, AGENT, false);

		assert.strictEqual(stats.lowImportance, 1, 'lowImportance 仍要如实上报（诊断看候选数）');
		assert.ok(kv.has(KV.memories(AGENT), 'weak-old'), '★ strength ≤ 2 的条目不得被删除（刻度混用止血）');
		assert.ok(kv.has(KV.memories(AGENT), 'strong-old'), 'strength 7 本来就不该删');
		assert.ok(!kv.has(KV.memories(AGENT), 'ttl-expired'), 'forgetAfter 到期仍要删（合法路径不能被误伤）');
		assert.ok(!kv.has(KV.memories(AGENT), 'superseded'), '被取代 >7 天的旧版本仍要删');
		assert.strictEqual(stats.expiredMemories, 1);
		assert.strictEqual(stats.nonLatest, 1);
	});

	test('autoForget：strength ≤ 2 且 >180 天 ⇒ 只进 lowValue 不删除', async () => {
		const kv = new MemKV();
		await seed(kv, [
			mem('weak-ancient', 'quebec romeo sierra tango', { strength: 0.5, ageDays: 200 }),
			mem('normal', 'uniform victor whiskey xray', { strength: 7, ageDays: 200 }),
		]);
		const r = await autoForget(kv as any, AGENT, false);

		assert.deepStrictEqual(r.lowValue, ['weak-ancient'], 'lowValue 口径不变');
		assert.ok(kv.has(KV.memories(AGENT), 'weak-ancient'), '★ 不得因 strength 被删除');
		assert.ok(kv.has(KV.memories(AGENT), 'normal'));
	});

	test('extractEpisodic：空分区 / 无新输入 ⇒ 不新写；有新建或更新 ⇒ 新写一条', async () => {
		const kv = new MemKV();
		const episodes = async () => (await kv.list<any>(KV.semantic(AGENT))).filter(e => e.id?.startsWith('epi'));

		assert.deepStrictEqual(await extractEpisodic(kv as any, AGENT, 's', []), [], '空分区不写');
		assert.strictEqual((await episodes()).length, 0);

		const a = mem('a', 'yankee zulu one two', { ageDays: 3 });
		const b = mem('b', 'three four five six', { ageDays: 2 });
		assert.strictEqual((await extractEpisodic(kv as any, AGENT, 's', [a, b])).length, 1, '首次：写一条');
		assert.strictEqual((await extractEpisodic(kv as any, AGENT, 's', [a, b])).length, 0, '★ 同一批输入再跑：不写');
		assert.strictEqual((await extractEpisodic(kv as any, AGENT, 's', [a, b])).length, 0, '★ 再跑一次仍不写（模拟每 5 分钟的 sweep）');
		assert.strictEqual((await episodes()).length, 1);

		// 有一条被**更新**（时间戳晚于最近一条 episode）⇒ 视为新输入
		const bUpdated = { ...b, updatedAt: new Date(Date.now() + 1_000).toISOString() };
		assert.strictEqual((await extractEpisodic(kv as any, AGENT, 's', [a, bUpdated])).length, 1, '有更新 ⇒ 新写一条');

		// 条数变化（新建）⇒ 视为新输入
		const c = mem('c', 'seven eight nine ten', { updatedAt: new Date(Date.now() + 2_000).toISOString() });
		assert.strictEqual((await extractEpisodic(kv as any, AGENT, 's', [a, bUpdated, c])).length, 1, '有新建 ⇒ 新写一条');
		assert.strictEqual((await episodes()).length, 3);
	});
});
