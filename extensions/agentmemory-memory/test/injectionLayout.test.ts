/*---------------------------------------------------------------------------------------------
 *  injectionLayout.test.ts — 注入面的排版与副作用（2026-11-02）
 *
 * 钉住四件事（每一件都是"看起来无差别、实际很贵"的）：
 *   ① **前缀稳定**：输出按 recency **升序**（旧→新）⇒ 新条目追加在**尾部**，
 *      已注入的字节不变（这是 KV 前缀缓存能不能命中的唯一前提）；
 *   ② `skipSessionBlocks`：dsh 注入传的 sessionId 是分区键 ⇒ 摘要/观察两块恒空，
 *      不该再为它们打两次全表 list；
 *   ③ `recordAccess:false`：**注入不是使用**（否则 retention 分数被注入频率灌水）；
 *   ④ `autoPage:false`：下溢交给网关 sweep，注入路径不写库。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { buildContext, coreAdd, lessonSave } from '../src/amFunctions.js';
import { KV } from '../src/amSchema.js';

const AGENT = 'injection-layout-agent';

/** 最小内存 KV；额外记录 `list()` 调用过的 scope（用于断言"没读"）。 */
class MemKV {
	readonly store = new Map<string, Map<string, string>>();
	readonly listCalls: string[] = [];
	async get<T = unknown>(scope: string, key: string): Promise<T | null> {
		const raw = this.store.get(scope)?.get(key);
		return raw ? JSON.parse(raw) as T : null;
	}
	async set<T = unknown>(scope: string, key: string, value: T): Promise<void> {
		if (!this.store.has(scope)) { this.store.set(scope, new Map()); }
		this.store.get(scope)!.set(key, JSON.stringify(value));
	}
	async delete(scope: string, key: string): Promise<void> { this.store.get(scope)?.delete(key); }
	async list<T = unknown>(scope: string): Promise<T[]> {
		this.listCalls.push(scope);
		return [...(this.store.get(scope)?.values() ?? [])].map(v => JSON.parse(v) as T);
	}
	async listKeys(scope: string): Promise<string[]> { return [...(this.store.get(scope)?.keys() ?? [])]; }
	async listScopes(prefix: string): Promise<string[]> { return [...this.store.keys()].filter(s => s.startsWith(prefix)); }
	async clearScope(scope: string): Promise<void> { this.store.delete(scope); }
	async ensureConnected(): Promise<void> { /* noop */ }
	dispose(): void { /* noop */ }
	size(scope: string): number { return this.store.get(scope)?.size ?? 0; }
}

const FOOTER = '</agentmemory-context>';

/** 去掉 footer 的注入正文（"已有前缀"）。 */
function prefixOf(prompt: string): string {
	const at = prompt.lastIndexOf(FOOTER);
	return at === -1 ? prompt : prompt.slice(0, at);
}

/** 收集一段异步副作用（`void` 调用的 recordAccessBatch / autoPage）落地。 */
const settle = () => new Promise<void>(r => setTimeout(r, 20));

suite('注入排版：前缀稳定（2026-11-02）', () => {

	test('★ 新条目追加在尾部：已有前缀逐字节不变（旧实现按降序输出 ⇒ 插在最前）', async () => {
		const kv = new MemKV();
		await lessonSave(kv as any, AGENT, '构建必须走 pnpm，不要用 npm', '构建脚本', 0.6);

		// 先有 lessons 块
		const p1 = (await buildContext(kv as any, AGENT, 'sess', 'proj', 4000)).systemPrompt;
		assert.ok(p1.includes('Lessons Learned'), '应有 lessons 块');

		// 再加一个**明显更新**的 crystal 块（recency 更大）。
		// ⚠ 时间必须拉开：同一毫秒内 `sort` 是稳定的 ⇒ 降序实现也会保持推入顺序，
		//   这个断言就会**假绿**（本次踩到）。
		await kv.set(KV.crystals(AGENT), 'cry1', {
			id: 'cry1', narrative: '完成了一次端口迁移', createdAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const p2 = (await buildContext(kv as any, AGENT, 'sess', 'proj', 4000)).systemPrompt;

		assert.ok(p2.includes('Workflow Crystals'), '应出现 crystals 块');
		assert.ok(p2.startsWith(prefixOf(p1)), '★ 旧前缀必须是新文本的前缀（否则每加一条记忆都会打碎 KV 缓存）');
		// 旧实现（降序输出）会把更新的 crystals 排到 lessons **前面** ⇒ 这一条会红
		assert.ok(p2.indexOf('Lessons Learned') < p2.indexOf('Workflow Crystals'),
			'较旧的块必须在前面（升序输出）');
	});

	test('数据不变 ⇒ 两次装配逐字节相同（前缀稳定）', async () => {
		const kv = new MemKV();
		await lessonSave(kv as any, AGENT, '环境变量收紧在 settings.json', '配置', 0.7);
		const a = (await buildContext(kv as any, AGENT, 's', 'p', 4000)).systemPrompt;
		const b = (await buildContext(kv as any, AGENT, 's', 'p', 4000)).systemPrompt;
		assert.strictEqual(a, b, '同一份数据两次装配必须完全一致');
	});
});

suite('注入副作用：dsh 路径可全关（2026-11-02）', () => {

	test('skipSessionBlocks：不再读 summaries / sessions / 观察', async () => {
		const kv = new MemKV();
		await lessonSave(kv as any, AGENT, '记忆页面看的是分区合并结果', '页面', 0.6);
		kv.listCalls.length = 0;

		await buildContext(kv as any, AGENT, AGENT, 'p', 4000, undefined, { skipSessionBlocks: true });
		const touched = kv.listCalls.join(',');
		assert.ok(!touched.includes('mem:summaries:'), `不该读 summaries，实际读了：${touched}`);
		assert.ok(!touched.includes('mem:sessions:'), `不该读 sessions，实际读了：${touched}`);
		assert.ok(!touched.includes('mem:obs:'), `不该读观察，实际读了：${touched}`);
	});

	test('默认（不传选项）仍然读会话块 —— IDE 侧行为不变', async () => {
		const kv = new MemKV();
		await lessonSave(kv as any, AGENT, '默认路径必须保持原语义', '兼容', 0.6);
		kv.listCalls.length = 0;
		await buildContext(kv as any, AGENT, 'real-session', 'p', 4000);
		const touched = kv.listCalls.join(',');
		assert.ok(touched.includes('mem:summaries:'), '默认路径仍要读 summaries');
		assert.ok(touched.includes('mem:sessions:'), '默认路径仍要读 sessions');
	});

	test('★ recordAccess:false ⇒ 不写访问日志（注入不是使用）', async () => {
		const kv = new MemKV();
		await lessonSave(kv as any, AGENT, '教训块本身带 sourceIds，默认会被记访问', '访问口径', 0.6);

		await buildContext(kv as any, AGENT, 's', 'p', 4000, undefined, { recordAccess: false });
		await settle();
		assert.strictEqual(kv.size(KV.accessLog(AGENT)), 0, '关掉后不得写 mem:access');

		// 反向：默认仍然记（IDE 侧语义不变）
		await buildContext(kv as any, AGENT, 's', 'p', 4000);
		await settle();
		assert.ok(kv.size(KV.accessLog(AGENT)) > 0, '默认路径仍要记访问');
	});

	test('★ autoPage:false ⇒ 注入不把 core 下溢进长期层（交给 sweep）', async () => {
		const kv = new MemKV();
		await coreAdd(kv as any, AGENT, '工作记忆条目一：这条内容足够长，用来触发预算下溢的判断逻辑', 8);
		await coreAdd(kv as any, AGENT, '工作记忆条目二：同样是足够长的内容，确保总 token 超过预算', 8);
		const coreBefore = kv.size(KV.coreMemory(AGENT));
		const memBefore = kv.size(KV.memories(AGENT));
		assert.ok(coreBefore >= 2);

		// 预算压得很小 ⇒ 默认实现会把 core 条目 page 进 memories
		await buildContext(kv as any, AGENT, 's', 'p', 10, undefined, { autoPage: false });
		await settle();
		assert.strictEqual(kv.size(KV.coreMemory(AGENT)), coreBefore, '注入路径不得下溢 core');
		assert.strictEqual(kv.size(KV.memories(AGENT)), memBefore, '不得凭空产生长期记忆');
	});
});
