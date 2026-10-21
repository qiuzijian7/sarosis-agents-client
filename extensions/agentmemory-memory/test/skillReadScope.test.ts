/*---------------------------------------------------------------------------------------------
 *  skillReadScope.test.ts — 技能读取口径的回归守卫（2026-10-21）
 *
 *  病根：技能有**两套存储**，而 provider 的读法只认新的一套 ⇒ 技能页长期"总技能 0"，
 *  用户以为"从没提取过技能" ✗✗：
 *   · 新口径（`addSkill` 写）：`mem:procedural:<agent>`，key = `skl-<ts>-<rand>`，值是单条对象
 *     ⇒ 真库里 **0 条**（这条通道基本没被用过）；
 *   · 旧口径（**历史真实数据**在这里）：`mem:skills:<agent>`，key = `data`，值是**技能数组**
 *     （id 前缀 `skill-`）⇒ 真库里有 2 条（`saros-claw` / `wf-test1`）。
 *
 *  本守卫钉住：
 *   ① 旧口径的技能**必须能读到**（`listSkills` / `getSkillStats` 都要算上）；
 *   ② 新旧口径**同时**存在时按 id 去重（不重复计数）。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AgentMemoryProviderV2 } from '../src/agentMemoryProviderV2.js';
import { KV } from '../src/amSchema.js';

declare function suite(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;

const AGENT = 'skill-scope-agent';

/** 最小内存 KV（与 `test/sweepSafety.test.ts` 的 MemKV 同形）。 */
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

/** 旧口径：key='data' 的一个数组（id 前缀 `skill-`）—— 真库里就是这个样子。 */
const LEGACY_SKILLS = [
	{ id: 'skill-1783370611286-whsyn6', trigger: '当遇到错误或异常时', title: '旧口径技能 A', steps: ['a', 'b'], confidence: 0.85 },
	{ id: 'skill-1783370611286-second', trigger: '当需要配置环境时', title: '旧口径技能 B', steps: ['c'], confidence: 0.6 },
];

suite('技能读取口径（旧口径兼容 + 去重）', () => {
	test('① 旧口径（mem:skills 的 data 数组）必须能读到，且总数按数组长度算', async () => {
		const kv = new MemKV();
		await kv.set(KV.skillStore(AGENT), 'data', LEGACY_SKILLS);
		const p = new AgentMemoryProviderV2({ kv, hosted: true });
		const skills = await p.listSkills(AGENT);
		assert.equal(skills.length, 2, `旧口径技能应全部可见，实际 ${skills.length}`);
		assert.ok(skills.some(s => String(s.title) === '旧口径技能 A'));
		const stats = await p.getSkillStats(AGENT);
		assert.equal(stats.totalSkills, 2, `总技能数应按数组长度算（不是键数），实际 ${stats.totalSkills}`);
	});

	test('② 新旧口径同时存在时按 id 去重（不重复计数）', async () => {
		const kv = new MemKV();
		await kv.set(KV.skillStore(AGENT), 'data', LEGACY_SKILLS);
		// 新口径：一条 `skl-` 技能
		await kv.set(KV.procedural(AGENT), 'skl-123-abc', {
			id: 'skl-123-abc', title: '新口径技能', preconditions: ['x'], steps: ['s'], confidence: 0.9,
		});
		const p = new AgentMemoryProviderV2({ kv, hosted: true });
		const skills = await p.listSkills(AGENT);
		assert.equal(skills.length, 3, `新旧合计 3 条，实际 ${skills.length}`);
		const ids = skills.map(s => String(s.id));
		assert.equal(new Set(ids).size, ids.length, 'id 必须唯一（去重生效）');
		const stats = await p.getSkillStats(AGENT);
		assert.equal(stats.totalSkills, 3, `总技能数应为 3，实际 ${stats.totalSkills}`);
	});

	test('③ 没有任何技能时是 0（不能因为兜底逻辑而虚报）', async () => {
		const kv = new MemKV();
		const p = new AgentMemoryProviderV2({ kv, hosted: true });
		assert.equal((await p.listSkills(AGENT)).length, 0);
		assert.equal((await p.getSkillStats(AGENT)).totalSkills, 0);
	});
});
