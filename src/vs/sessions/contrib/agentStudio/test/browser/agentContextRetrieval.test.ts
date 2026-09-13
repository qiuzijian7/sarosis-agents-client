/*---------------------------------------------------------------------------------------------
 *  agentContextRetrieval.test.ts
 *
 *  storeTurnObservations 回归（2026-07-25 turn 末写入洪泛卡死）：
 *  - 内容哈希去重：同内容跨调用不重复写（洪泛控制的第一道闸）
 *  - 单条写入失败不阻断后续（配合 fire-and-forget 调用形态安全）
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { storeTurnObservations, type ContextRetrievalDeps } from '../../browser/agentContextRetrieval.js';

function makeDeps(): { deps: ContextRetrievalDeps; maps: Map<string, Set<string>> } {
	const maps = new Map<string, Set<string>>();
	return {
		maps,
		deps: {
			getStoredHashes: (sessionId: string) => {
				let s = maps.get(sessionId);
				if (!s) { s = new Set(); maps.set(sessionId, s); }
				return s;
			},
		},
	};
}

suite('storeTurnObservations', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('按内容哈希去重：同内容跨调用不重复写', async () => {
		const { deps } = makeDeps();
		const written: string[] = [];
		const provider = { observe: async (_a: string, _p: any) => { written.push('obs'); } };
		const messages = [
			{ role: 'system', content: 'skip me' },
			{ role: 'user', content: '用户提出的具体问题内容' },
			{ role: 'assistant', content: '助手给出的详细回答内容' },
		];
		await storeTurnObservations(deps, provider, 'agent-1', 'sess-1', messages);
		assert.strictEqual(written.length, 2, 'system 跳过，user+assistant 各写一条');
		// 同一 session 再次调用（turn 末重复触发场景）→ 全部去重跳过
		await storeTurnObservations(deps, provider, 'agent-1', 'sess-1', messages);
		assert.strictEqual(written.length, 2, '同内容不重复写');
		// 新增一条消息 → 只写增量
		messages.push({ role: 'assistant', content: '这是新增的足够长的回答' });
		await storeTurnObservations(deps, provider, 'agent-1', 'sess-1', messages);
		assert.strictEqual(written.length, 3, '只写增量');
	});

	test('不同 session 各自维护去重集合', async () => {
		const { deps } = makeDeps();
		const written: string[] = [];
		const provider = { observe: async (_a: string, _p: any) => { written.push('obs'); } };
		const messages = [{ role: 'user', content: '两个会话里完全相同的消息内容' }];
		await storeTurnObservations(deps, provider, 'agent-1', 'sess-A', messages);
		await storeTurnObservations(deps, provider, 'agent-1', 'sess-B', messages);
		assert.strictEqual(written.length, 2, '不同 session 各自写一份');
	});

	test('单条写入失败不阻断后续，也不抛出', async () => {
		const { deps } = makeDeps();
		const attempted: string[] = [];
		const provider = {
			observe: async (_a: string, _p: any) => {
				attempted.push('obs');
				if (attempted.length === 1) { throw new Error('gateway unreachable'); }
			},
		};
		const messages = [
			{ role: 'user', content: '这是第一条足够长的消息' },
			{ role: 'assistant', content: '这是第二条足够长的消息' },
			{ role: 'user', content: '这是第三条足够长的消息' },
		];
		await storeTurnObservations(deps, provider, 'agent-1', 'sess-1', messages);
		assert.strictEqual(attempted.length, 3, '失败不阻断后续写入');
		// ★ 契约同步（2026-09-11，R2 2026-09-09）：写失败会**回滚去重标记**
		//   （旧实现「先 add 再吞错」→ 失败的观察永不重试、永久丢失且零痕迹；
		//   见 agentContextRetrieval.ts 的 catch 分支）。故重跑时**只有失败的那条**
		//   会重试，已成功的 2 条仍被去重跳过。
		attempted.length = 0;
		await storeTurnObservations(deps, provider, 'agent-1', 'sess-1', messages);
		assert.strictEqual(attempted.length, 1, '仅失败的那条重试；已成功的去重跳过');
	});

	test('短消息（<8 字符）跳过', async () => {
		const { deps } = makeDeps();
		const written: string[] = [];
		const provider = { observe: async (_a: string, _p: any) => { written.push('obs'); } };
		await storeTurnObservations(deps, provider, 'agent-1', 'sess-1', [
			{ role: 'user', content: '短' },
			{ role: 'user', content: '这条消息足够长会被写入' },
		]);
		assert.strictEqual(written.length, 1);
	});
});
