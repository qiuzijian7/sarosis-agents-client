/*---------------------------------------------------------------------------------------------
 *  AgentChatService.appendMessagesBatch —— 批量落盘回归测试（2026-09-11）
 *
 *  背景（真实事故，日志 20260911T193945，用户报「app 卡死」）：
 *  `appendMessage` **每次**调用都会全量重写 —— `_persistGlobalHistory()` 序列化
 *  `_historyCache` 里的**所有会话**，`_persistToSessionFile()` 序列化**整个会话**，
 *  且都用 `JSON.stringify(..., null, 2)`。`sendMessage` 的 finalization 原本逐条
 *  `await appendMessage(...)`：一个 62 轮迭代的 turn 产生 62 条 assistant 消息
 *  → 62 次全量序列化 + 写盘 → 渲染进程被阻塞到日志停滞 2.5 分钟以上。
 *
 *  本测试锁定修复的核心不变量：**N 条消息只触发 O(1) 次文件写入**（每个会话 1 次
 *  会话文件 + 全局历史 1 次），而不是 N 次。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/agentChatBatchPersist.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import { AgentChatService } from '../../browser/agentChatService.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';

import type { ChatMessage } from '../../common/agentStudioService.js';

/** 记录 error，便于断言「没有静默失败」（`_persistToSessionFile` 会吞掉异常）。 */
function makeLog(errors: string[]) {
	return {
		info() { }, warn() { }, debug() { }, trace() { },
		error(...args: unknown[]) { errors.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')); },
	} as any;
}

interface IHarness {
	service: AgentChatService;
	writes: string[];
	errors: string[];
	/** 落盘是 fire-and-forget（不 await），等一个宏任务让写入完成后才能断言。 */
	settle: () => Promise<void>;
}

function makeService(): IHarness {
	const writes: string[] = [];
	const errors: string[] = [];
	const fileService: any = {
		exists: async () => false,          // 无既有文件 → 跳过加载、走 createFolder
		createFolder: async () => { },
		readFile: async () => ({ value: VSBuffer.fromString('[]') }),
		writeFile: async (uri: any) => { writes.push(uri.fsPath ?? String(uri)); },
		resolve: async () => ({ children: [] }),
		// `_updateSessionIndex` 会先探测文件能力（FileSystemProviderCapabilities），
		// 缺这个方法会让 index 更新抛错（会话文件本身已写成功）。
		hasCapability: () => false,
	};
	// ★ `userRoamingDataHome` 必须是真正的 URI 实例：`_resolveAgentPaths` 内部会
	// URI.joinPath(...)，传普通 `{ fsPath }` 会抛错，而 `_persistToSessionFile`
	// 会**静默 catch**（只记 error 日志）→ 表现为「零次写入」的假失败。
	const environmentService: any = { userRoamingDataHome: URI.file('/tmp/vssaros') };
	const service = new AgentChatService(
		makeLog(errors), {} as any, fileService, environmentService,
		{ getValue: () => undefined } as any,
		{ getActiveWorkspaceId: () => undefined, getWorkspace: async () => undefined } as any,
		{ onWillShutdown: () => ({ dispose() { } }) } as any,
	);
	return {
		service, writes, errors,
		settle: () => new Promise<void>(resolve => setTimeout(resolve, 20)),
	};
}

function msg(id: string, sessionId: string, content = 'x'): ChatMessage {
	return { id, role: 'assistant', content, agentSessionId: sessionId, timestamp: new Date().toISOString() } as ChatMessage;
}

suite('AgentChatService.appendMessagesBatch (batch persist)', () => {

	test('★ N 条消息只触发 O(1) 次写入（每个会话 1 次 + 全局历史 1 次）', async () => {
		const h = makeService();
		const msgs = Array.from({ length: 30 }, (_, i) => msg(`m${i}`, 'sess-1'));

		await h.service.appendMessagesBatch('agent-1', msgs);
		await h.settle();

		// 期望：会话文件 1 次 + 全局历史 1 次 = 2 次。
		// 逐条 appendMessage 的老实现会是 30 × 2 = 60 次 —— 这正是「app 卡死」的根因。
		assert.deepStrictEqual(h.errors, [], '不应有落盘错误（静默失败会让本测试失去意义）');
		assert.ok(h.writes.length > 0, '应至少写入一次');
		// 单会话批量的写入次数固定为 3：会话文件 1 + 全局历史 1 + session index 1。
		// 关键是**与条数无关** —— 逐条老实现是 30 × 3 = 90 次，这才是「app 卡死」的根因。
		assert.ok(h.writes.length <= 3,
			`30 条消息应只写 ≤3 次文件（会话文件 + 全局历史 + index），实际 ${h.writes.length} 次：\n${h.writes.join('\n')}`);
	});

	test('★ 写入次数与消息条数无关（30 条 vs 3 条同为 O(1)）', async () => {
		const a = makeService();
		await a.service.appendMessagesBatch('agent-1', Array.from({ length: 30 }, (_, i) => msg(`m${i}`, 'sess-1')));
		await a.settle();

		const b = makeService();
		await b.service.appendMessagesBatch('agent-1', [msg('x', 'sess-1'), msg('y', 'sess-1'), msg('z', 'sess-1')]);
		await b.settle();

		assert.strictEqual(a.writes.length, b.writes.length,
			`写入次数应与条数无关（30 条=${a.writes.length}，3 条=${b.writes.length}）`);
	});

	test('空数组 → 不写任何文件（早退）', async () => {
		const h = makeService();
		await h.service.appendMessagesBatch('agent-1', []);
		await h.settle();
		assert.strictEqual(h.writes.length, 0, '空批量不应产生写入');
	});

	test('★ 无 agentSessionId 的非 system 消息被丢弃（跨会话泄漏守卫）', async () => {
		const h = makeService();
		await h.service.appendMessagesBatch('agent-1', [
			{ id: 'a', role: 'assistant', content: 'x', timestamp: '' } as ChatMessage,
			{ id: 'b', role: 'user', content: 'y', timestamp: '' } as ChatMessage,
		]);
		await h.settle();
		assert.strictEqual(h.writes.length, 0, '无 sessionId 的非 system 消息应被丢弃，不产生写入');
	});

	test('多会话混批 → 每个会话各写一次（不互相污染）', async () => {
		const h = makeService();
		await h.service.appendMessagesBatch('agent-1', [
			msg('a1', 'sess-A'), msg('a2', 'sess-A'),
			msg('b1', 'sess-B'),
		]);
		await h.settle();
		// sess-A 1 次 + sess-B 1 次 + 全局 1 次 = 3
		assert.deepStrictEqual(h.errors, [], '不应有落盘错误');
		// 每个会话 1 次会话文件 + 1 次 index，再加全局历史 1 次 → 2×2+1 = 5。
		assert.ok(h.writes.length >= 4 && h.writes.length <= 5,
			`两个会话应各写一次会话文件与 index（+全局一次），实际 ${h.writes.length} 次：\n${h.writes.join('\n')}`);
	});

	test('方法为公开 API（finalization 与 workflow 修剪历史都依赖它）', () => {
		const h = makeService();
		assert.strictEqual(typeof (h.service as any).appendMessagesBatch, 'function',
			'appendMessagesBatch 必须是公开方法（IAgentChatService 已声明）');
	});
});
