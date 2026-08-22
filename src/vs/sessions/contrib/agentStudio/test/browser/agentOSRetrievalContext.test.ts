/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AgentOSService } from '../../browser/agentOSService.js';
import { RETRIEVED_CTX_PREFIX } from '../../browser/agentContextRetrieval.js';
import { ContextManager } from '../../common/contextManager.js';

suite('AgentOS Retrieval Context (per-turn injection & observation)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// 直接构造真实 AgentOSService（绕过 DI），仅 stub 构造器所需的 4 个服务。
	// 构造器内 _initDashboardStorage / _registerToolSetChangeListeners 均为异步或按需注册，
	// 对 stub 缺失的接口做了容错，不会在构造期抛错。
	function createAgentOSService(): any {
		// 与 AgentOSService 当前构造签名保持一致：
		// (logService, environmentService, workspaceContextService, pathService, fileService, instantiationService)
		const logService = new NullLogService();
		const envStub: any = { userRoamingDataHome: URI.file('/tmp'), appRoot: '/tmp' };
		const wsStub: any = { getWorkspace: () => ({ folders: [] as any[] }) };
		const pathStub: any = { userHome: async () => URI.file('/tmp') };
		const fileStub: any = {};
		const instStub: any = { invokeFunction: (fn: any) => fn(() => undefined) };
		return new (AgentOSService as any)(logService, envStub, wsStub, pathStub, fileStub, instStub) as any;
	}

	// 记录写入记忆的条目，供断言
	class RecordingMemoryProvider {
		written: any[] = [];
		recallQuery: string | undefined;
		recallArgs: any[] = [];
		compactContext: any[] = [];
		recallResult = 'memory_recall: no results'; // 默认"无结果"，便于测试空回退

		async writeMemory(agentId: string, entry: any): Promise<void> {
			this.written.push(entry);
		}
		// 2026-07-25 P0：storeTurnObservations 改道 observe（mem:obs），
		// 映射为既有断言形状（type/content/metadata.role+source）
		async observe(_agentId: string, payload: any): Promise<void> {
			const data = payload?.data ?? {};
			this.written.push({
				type: 'episodic',
				content: data.content ?? '',
				metadata: { role: data.role, sessionId: payload.sessionId, source: payload.hookType },
			});
		}
		async getCompactContext(_agentId: string, _n: number): Promise<any[]> {
			return this.compactContext;
		}
		async recallFormatted(agentId: string, query: string, opts: any, n: number): Promise<string> {
			this.recallQuery = query;
			this.recallArgs = [agentId, query, opts, n];
			return this.recallResult;
		}
	}

	// ─── 关键契约：注入前缀必须与 contextManager 的剥离前缀完全一致 ────────────────
	test('RETRIEVED_CTX_PREFIX equals contextManager.INJECTED_CONTEXT_PREFIX', () => {
		// 若两者不一致，压缩时 contextManager 不会剥离每轮注入的 system 消息，
		// 会在头部不断累积重复上下文块。这是防止重复累积的关键回归守卫。
		const injectedPrefix = RETRIEVED_CTX_PREFIX;
		const stripPrefix = (ContextManager as any).INJECTED_CONTEXT_PREFIX;
		assert.strictEqual(typeof injectedPrefix, 'string');
		assert.strictEqual(injectedPrefix, stripPrefix);
	});

	test('injected retrieval message is recognized as injected by ContextManager (will be stripped on compression)', () => {
		const svc = createAgentOSService();
		try {
			const base = [{ role: 'system', content: 'base system' }];
			const injected = svc._injectRetrievalSystemMessage(base, 'some retrieved context', 'recall');
			const injectedMsg = injected.find((m: any) => m.content.includes('some retrieved context'));
			assert.ok(injectedMsg, 'injected message should be present');

			// _isInjectedContextMessage 是实例方法，但只引用静态前缀，故可用空 this 调用
			const isInjected = (ContextManager as any).prototype._isInjectedContextMessage.call({}, injectedMsg);
			const isBaseInjected = (ContextManager as any).prototype._isInjectedContextMessage.call({}, base[0]);
			assert.strictEqual(isInjected, true, 'injected message must be stripped during compression');
			assert.strictEqual(isBaseInjected, false, 'ordinary system message must NOT be stripped');
		} finally {
			svc.dispose();
		}
	});

	// ─── _injectRetrievalSystemMessage ───────────────────────────────────────────
	test('_injectRetrievalSystemMessage inserts after existing system messages with prefix', () => {
		const svc = createAgentOSService();
		try {
			const msgs = [{ role: 'system', content: 'base' }, { role: 'user', content: 'hi' }];
			const out = svc._injectRetrievalSystemMessage(msgs, 'retrieved context here', 'recall');

			assert.strictEqual(out.length, 3);
			assert.strictEqual(out[0].content, 'base'); // 原 system 不动
			assert.strictEqual(out[1].role, 'system');
			assert.ok(out[1].content.startsWith(RETRIEVED_CTX_PREFIX));
			assert.ok(out[1].content.includes('retrieved context here'));
			assert.strictEqual(out[2].role, 'user'); // user 位置后移
		} finally {
			svc.dispose();
		}
	});

	test('_injectRetrievalSystemMessage is idempotent (does not double-inject)', () => {
		const svc = createAgentOSService();
		try {
			let msgs = [{ role: 'system', content: 'base' }];
			msgs = svc._injectRetrievalSystemMessage(msgs, 'ctx', 'recall');
			const lenAfterFirst = msgs.length;
			msgs = svc._injectRetrievalSystemMessage(msgs, 'ctx', 'recall');
			assert.strictEqual(msgs.length, lenAfterFirst, 'second inject must not add another message');
		} finally {
			svc.dispose();
		}
	});

	test('_injectRetrievalSystemMessage handles multiple leading system messages', () => {
		const svc = createAgentOSService();
		try {
			const msgs = [
				{ role: 'system', content: 'a' },
				{ role: 'system', content: 'b' },
				{ role: 'user', content: 'c' },
			];
			const out = svc._injectRetrievalSystemMessage(msgs, 'ctx', 'recall');
			assert.strictEqual(out.length, 4);
			assert.strictEqual(out[2].role, 'system');
			assert.ok(out[2].content.startsWith(RETRIEVED_CTX_PREFIX));
			assert.strictEqual(out[3].role, 'user');
		} finally {
			svc.dispose();
		}
	});

	// ─── _storeTurnObservations ─────────────────────────────────────────────────
	test('_storeTurnObservations writes only user/assistant/tool (skips system), with turn_observation source', async () => {
		const svc = createAgentOSService();
		const provider = new RecordingMemoryProvider();
		try {
			const messages = [
				{ role: 'system', content: 'system instruction block' },
				{ role: 'user', content: 'hello world this is a user message' },
				{ role: 'assistant', content: 'ok I will help you with that task' },
				{ role: 'tool', content: 'tool produced some output', tool_call_id: 't1' },
			];
			await svc._storeTurnObservations(provider, 'agent-1', 'sess-1', messages);

			// system 被跳过，仅 3 条真实对话
			assert.strictEqual(provider.written.length, 3);
			const roles = provider.written.map((e: any) => e.metadata.role).sort();
			assert.deepStrictEqual(roles, ['assistant', 'tool', 'user']);
			for (const e of provider.written) {
				assert.strictEqual(e.type, 'episodic');
				assert.strictEqual(e.metadata.source, 'turn_observation');
				assert.ok(e.content.startsWith(`[${e.metadata.role}] `));
			}
		} finally {
			svc.dispose();
		}
	});

	test('_storeTurnObservations is idempotent (dedup by content hash across calls)', async () => {
		const svc = createAgentOSService();
		const provider = new RecordingMemoryProvider();
		try {
			const messages = [
				{ role: 'user', content: 'repeatable user message content' },
				{ role: 'assistant', content: 'repeatable assistant message content' },
			];
			await svc._storeTurnObservations(provider, 'agent-1', 'sess-1', messages);
			const firstCount = provider.written.length;
			// 同 session 再次写入相同内容 → 不应新增
			await svc._storeTurnObservations(provider, 'agent-1', 'sess-1', messages);
			assert.strictEqual(provider.written.length, firstCount);

			// 新增一条不同内容 → 仅 +1
			await svc._storeTurnObservations(provider, 'agent-1', 'sess-1', [
				{ role: 'user', content: 'a brand new distinct message' },
			]);
			assert.strictEqual(provider.written.length, firstCount + 1);
		} finally {
			svc.dispose();
		}
	});

	test('_storeTurnObservations ignores very short content (<8 chars)', async () => {
		const svc = createAgentOSService();
		const provider = new RecordingMemoryProvider();
		try {
			await svc._storeTurnObservations(provider, 'agent-1', 'sess-1', [
				{ role: 'user', content: 'short' },
				{ role: 'assistant', content: 'tool' },
			]);
			assert.strictEqual(provider.written.length, 0);
		} finally {
			svc.dispose();
		}
	});

	// ─── _retrieveContextOnly ───────────────────────────────────────────────────
	test('_retrieveContextOnly prefers getCompactContext over recallFormatted', async () => {
		const svc = createAgentOSService();
		const provider = new RecordingMemoryProvider();
		provider.compactContext = [{
			title: 'Session A parser work',
			narrative: 'refactored the parser module',
			keyDecisions: ['used X'],
			filesModified: ['a.ts'],
		}];
		provider.recallResult = 'recalled from episodic'; // 即便 recall 有结果也应被忽略
		try {
			// ⚠ query 必须与摘要有词汇重叠（'parser'）：2026-08-21 起
			// retrieveContextOnly 会按相关性过滤 compactContext（见
			// filterRelevantSessionSummaries）。原用例的 query 'do something' 与摘要
			// 'did some work' 零重叠，会被正确过滤掉并回退 recall —— 那考察的是过滤
			// 行为，而非本用例要验证的「compact_context 优先级」。
			const r = await svc._retrieveContextOnly(provider, 'agent-1', 'sess-1', [{ role: 'user', content: 'continue the parser refactor' }], 100);
			assert.ok(r, 'should return context');
			assert.strictEqual(r.source, 'compact_context');
			assert.ok(r.context.includes('## Session A parser work'));
			assert.ok(r.context.includes('used X'));
			assert.ok(r.context.includes('a.ts'));
			// recall 不应被调用（compact_context 优先）
			assert.strictEqual(provider.recallQuery, undefined);
		} finally {
			svc.dispose();
		}
	});

	test('_retrieveContextOnly filters irrelevant session summaries and falls back to recall', async () => {
		// 2026-08-21（日志 1787289570191）：getCompactContext 只按「最近」取，不看 query，
		// 无关跨域会话（如 kanban 任务摘要）会被无条件注入 —— 模型被迫花 2 整轮辨识排除
		// （"This appears to be an unrelated kanban task..."），既浪费预算又可能误导。
		// 现按词汇重叠过滤；全部无关时留空并回退到带 query 的语义检索 recallFormatted。
		const svc = createAgentOSService();
		const provider = new RecordingMemoryProvider();
		provider.compactContext = [{
			title: '共享设置脚手架',
			narrative: '创建看板任务用于跟踪进度',
			keyDecisions: ['拆分子任务'],
			filesModified: ['kanban.json'],
		}];
		provider.recallResult = 'recalled episodic context about link menus';
		try {
			const r = await svc._retrieveContextOnly(
				provider, 'agent-1', 'sess-1',
				[{ role: 'user', content: '工作流中点击连线时，弹出的菜单没有删除选项' }],
				100,
			);
			assert.ok(r, 'should fall back rather than return null');
			// 无关摘要被过滤 → 不再是 compact_context
			assert.strictEqual(r.source, 'recall');
			assert.ok(!r.context.includes('共享设置脚手架'), 'irrelevant kanban summary must not be injected');
			assert.strictEqual(r.context, 'recalled episodic context about link menus');
		} finally {
			svc.dispose();
		}
	});

	test('_retrieveContextOnly falls back to recallFormatted when getCompactContext empty', async () => {
		const svc = createAgentOSService();
		const provider = new RecordingMemoryProvider();
		provider.compactContext = []; // 无 SessionSummary
		provider.recallResult = 'recalled episodic context for the task';
		try {
			const middle = [
				{ role: 'system', content: 'sys' },
				{ role: 'user', content: 'find the bug in auth.ts please' },
				{ role: 'assistant', content: 'looking' },
			];
			const r = await svc._retrieveContextOnly(provider, 'agent-1', 'sess-1', middle, 100);
			assert.ok(r, 'should fall back to recall');
			assert.strictEqual(r.source, 'recall');
			assert.strictEqual(r.context, 'recalled episodic context for the task');
			// query 应取自 middle 中最近一条 user 消息
			assert.strictEqual(provider.recallQuery, 'find the bug in auth.ts please');
		} finally {
			svc.dispose();
		}
	});

	test('_retrieveContextOnly returns null when both sources empty', async () => {
		const svc = createAgentOSService();
		const provider = new RecordingMemoryProvider();
		provider.compactContext = [];
		provider.recallResult = 'memory_recall: no results';
		try {
			const r = await svc._retrieveContextOnly(provider, 'agent-1', 'sess-1', [{ role: 'user', content: 'x' }], 100);
			assert.strictEqual(r, null);
		} finally {
			svc.dispose();
		}
	});

	test('_retrieveContextOnly builds query from last user message in middle', async () => {
		const svc = createAgentOSService();
		const provider = new RecordingMemoryProvider();
		provider.compactContext = [];
		provider.recallResult = 'some context';
		try {
			const middle = [
				{ role: 'user', content: 'first question' },
				{ role: 'assistant', content: 'answer' },
				{ role: 'user', content: 'second and latest question about rendering' },
			];
			await svc._retrieveContextOnly(provider, 'agent-1', 'sess-1', middle, 100);
			assert.strictEqual(provider.recallQuery, 'second and latest question about rendering');
		} finally {
			svc.dispose();
		}
	});

	// ─── 端到端组合：turn 开始 = 外置 + 检索 + 注入 ────────────────────────────────
	test('per-turn flow: observations stored → retrieved → injected as system message', async () => {
		const svc = createAgentOSService();
		const provider = new RecordingMemoryProvider();
		provider.compactContext = [];
		provider.recallResult = 'retrieved prior discussion about the feature';
		try {
			const messages = [
				{ role: 'system', content: 'base' },
				{ role: 'user', content: 'continue the work on the parser module' },
			];
			// 1) 外置（模拟 turn 开始）
			await svc._storeTurnObservations(provider, 'agent-1', 'sess-1', messages);
			assert.ok(provider.written.length >= 1, 'turn observation should be stored');

			// 2) 检索 + 3) 注入
			const r = await svc._retrieveContextOnly(provider, 'agent-1', 'sess-1', messages, 100);
			assert.ok(r, 'retrieval should succeed');
			const injected = svc._injectRetrievalSystemMessage(messages, r.context, r.source);

			// 注入消息带正确前缀且会被压缩剥离（契约）
			const injectedMsg = injected.find((m: any) => m.content.includes(r.context));
			assert.ok(injectedMsg);
			const isInjected = (ContextManager as any).prototype._isInjectedContextMessage.call({}, injectedMsg);
			assert.strictEqual(isInjected, true);
		} finally {
			svc.dispose();
		}
	});
});
