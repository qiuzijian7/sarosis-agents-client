/*---------------------------------------------------------------------------------------------
 *  archiveRestore.test.ts — 归档列表与恢复（2026-11-02，记忆工作台 v2 · P4）
 *
 *  钉住：
 *   ① 列表按归档时间新→旧；`daysLeft` 与 90 天保留期一致；`total` 是全量、`limit` 只截展示
 *   ② 恢复 = 写回 memories（isLatest=true、去掉归档字段）并**从归档移除**
 *   ③ ★ 同 id 已有**有效**记忆 ⇒ 拒绝覆盖，且归档那份**必须还在**（不能丢）
 *   ④ 同 id 的是已被替代（isLatest=false）的残留 ⇒ 允许覆盖
 *   ⑤ 过期的 forgetAfter 要去掉，否则恢复后下一轮 evict 又会把它删掉
 *   ⑥ 恢复后真的可被 `evict` 放过、归档到期后仍被 `pruneArchive` 清理（出口没被破坏）
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { archiveMemory, evict, listArchive, pruneArchive, restoreArchived, ARCHIVE_TTL_MS } from '../src/amFunctions.js';
import { KV } from '../src/amSchema.js';
import type { Memory } from '../src/amTypes.js';

const DAY = 86_400_000;
const AGENT = 'archive-restore-agent';

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

function mem(id: string, content: string, over: Partial<Memory> = {}): Memory {
	const at = new Date().toISOString();
	return {
		id, createdAt: at, updatedAt: at, type: 'fact', title: id, content,
		concepts: [], files: [], sessionIds: [], strength: 7, version: 1, isLatest: true, ...over,
	};
}

/** 直接往归档里塞一条，`archivedAt` 可指定 N 天前（绕过 archiveMemory 才能控制时间）。 */
async function putArchived(kv: MemKV, m: Memory, daysAgo: number, reason = 'superseded'): Promise<void> {
	await kv.set(KV.archive(AGENT), m.id, {
		...m, isLatest: false, archivedAt: new Date(Date.now() - daysAgo * DAY).toISOString(), archiveReason: reason,
	});
}

suite('归档列表与恢复（2026-11-02）', () => {

	test('① 列表：新→旧排序、daysLeft 与保留期一致、total 是全量', async () => {
		const kv = new MemKV();
		await putArchived(kv, mem('old', '部署端口是 8011'), 80);
		await putArchived(kv, mem('new', '本项目使用 pnpm'), 3);
		await putArchived(kv, mem('mid', '导出包放在 dist/'), 21, 'contradiction');
		const out = await listArchive(kv as never, AGENT);
		assert.deepStrictEqual(out.items.map(i => i.id), ['new', 'mid', 'old'], '必须按归档时间新→旧');
		assert.strictEqual(out.total, 3);
		const byId = Object.fromEntries(out.items.map(i => [i.id, i]));
		assert.strictEqual(byId.new.daysLeft, 87, '3 天前归档 ⇒ 剩 87 天');
		assert.strictEqual(byId.old.daysLeft, 10, '80 天前归档 ⇒ 剩 10 天');
		assert.strictEqual(byId.mid.archiveReason, 'contradiction');
		const limited = await listArchive(kv as never, AGENT, Date.now(), 2);
		assert.strictEqual(limited.items.length, 2);
		assert.strictEqual(limited.total, 3, 'limit 只截展示，total 仍是全量');
	});

	test('① 列表：archivedAt 解析不出的排最后，且 daysLeft=null（永不自动清理）', async () => {
		const kv = new MemKV();
		await putArchived(kv, mem('ok', '有时间的'), 1);
		await kv.set(KV.archive(AGENT), 'bad', { ...mem('bad', '没时间的'), isLatest: false, archivedAt: 'not-a-date', archiveReason: 'manual' });
		const out = await listArchive(kv as never, AGENT);
		assert.deepStrictEqual(out.items.map(i => i.id), ['ok', 'bad']);
		assert.strictEqual(out.items[1].daysLeft, null);
		assert.strictEqual(out.items[1].expiresAt, null);
	});

	test('② 恢复：写回 memories（有效、无归档字段）并从归档移除', async () => {
		const kv = new MemKV();
		await putArchived(kv, mem('m1', '本项目使用 pnpm 管理依赖'), 5);
		const r = await restoreArchived(kv as never, AGENT, 'm1');
		assert.strictEqual(r.success, true, r.error);
		const back = await kv.get<Memory & { archivedAt?: string }>(KV.memories(AGENT), 'm1');
		assert.ok(back, '必须写回 memories');
		assert.strictEqual(back!.isLatest, true);
		assert.strictEqual(back!.content, '本项目使用 pnpm 管理依赖');
		assert.strictEqual(back!.archivedAt, undefined, '归档字段不得带回长期层');
		assert.strictEqual((back as any).archiveReason, undefined);
		assert.strictEqual(kv.has(KV.archive(AGENT), 'm1'), false, '恢复后归档里不应再留一份');
	});

	test('③ ★ 同 id 已有有效记忆 ⇒ 拒绝覆盖，归档那份必须还在', async () => {
		const kv = new MemKV();
		await putArchived(kv, mem('dup', '旧版本内容'), 5);
		await kv.set(KV.memories(AGENT), 'dup', mem('dup', '用户后来重新写入的新内容'));
		const r = await restoreArchived(kv as never, AGENT, 'dup');
		assert.strictEqual(r.success, false);
		assert.match(String(r.error), /已经有同 id/);
		const live = await kv.get<Memory>(KV.memories(AGENT), 'dup');
		assert.strictEqual(live!.content, '用户后来重新写入的新内容', '有效记忆不得被覆盖');
		assert.strictEqual(kv.has(KV.archive(AGENT), 'dup'), true, '拒绝时归档必须保留，否则这条就丢了');
	});

	test('④ 同 id 是已失效残留（isLatest=false）⇒ 允许覆盖', async () => {
		const kv = new MemKV();
		await putArchived(kv, mem('ghost', '归档里的内容'), 5);
		await kv.set(KV.memories(AGENT), 'ghost', mem('ghost', '残留的旧值', { isLatest: false }));
		const r = await restoreArchived(kv as never, AGENT, 'ghost');
		assert.strictEqual(r.success, true, r.error);
		const live = await kv.get<Memory>(KV.memories(AGENT), 'ghost');
		assert.strictEqual(live!.content, '归档里的内容');
		assert.strictEqual(live!.isLatest, true);
	});

	test('⑤ 过期的 forgetAfter 要去掉，未过期的保留；恢复后 evict 不会立刻又删掉它', async () => {
		const kv = new MemKV();
		await putArchived(kv, mem('expired', '带过期时间', { forgetAfter: new Date(Date.now() - DAY).toISOString() }), 5);
		await putArchived(kv, mem('future', '带未来过期时间', { forgetAfter: new Date(Date.now() + 30 * DAY).toISOString() }), 5);
		await restoreArchived(kv as never, AGENT, 'expired');
		await restoreArchived(kv as never, AGENT, 'future');
		const expired = await kv.get<Memory>(KV.memories(AGENT), 'expired');
		const future = await kv.get<Memory>(KV.memories(AGENT), 'future');
		assert.strictEqual(expired!.forgetAfter, undefined, '已过期的 forgetAfter 必须去掉');
		assert.ok(future!.forgetAfter, '未过期的 forgetAfter 要保留');
		await evict(kv as never, AGENT);
		assert.ok(await kv.get(KV.memories(AGENT), 'expired'), '恢复后不得被 evict 立刻删除');
	});

	test('⑥ 出口没被破坏：恢复不影响其它归档的到期清理；不存在的 id 报错', async () => {
		const kv = new MemKV();
		await putArchived(kv, mem('stay', '要恢复的'), 5);
		await putArchived(kv, mem('gone', '早过期的'), ARCHIVE_TTL_MS / DAY + 5);
		await restoreArchived(kv as never, AGENT, 'stay');
		assert.strictEqual(await pruneArchive(kv as never, AGENT), 1, '过期那条仍应被清理');
		assert.strictEqual(kv.has(KV.archive(AGENT), 'gone'), false);
		const miss = await restoreArchived(kv as never, AGENT, 'nope');
		assert.strictEqual(miss.success, false);
		assert.strictEqual((await restoreArchived(kv as never, AGENT, '')).success, false, '空 id 要拒');
	});

	test('归档→列表→恢复 闭环：archiveMemory 写入的条目能被列出并恢复', async () => {
		const kv = new MemKV();
		const m = mem('loop', '闭环验证内容');
		await kv.set(KV.memories(AGENT), 'loop', m);
		await archiveMemory(kv as never, AGENT, m, 'superseded');
		assert.strictEqual(kv.has(KV.memories(AGENT), 'loop'), false, '归档后 memories 里不应再有');
		const listed = await listArchive(kv as never, AGENT);
		assert.strictEqual(listed.items[0].id, 'loop');
		assert.strictEqual(listed.items[0].daysLeft, 90);
		assert.strictEqual((await restoreArchived(kv as never, AGENT, 'loop')).success, true);
		assert.strictEqual((await kv.get<Memory>(KV.memories(AGENT), 'loop'))!.isLatest, true);
	});
});
