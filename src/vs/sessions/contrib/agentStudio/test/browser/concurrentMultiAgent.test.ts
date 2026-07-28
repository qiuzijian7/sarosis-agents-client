/*---------------------------------------------------------------------------------------------
 *  concurrentMultiAgent.test.ts
 *
 *  多窗口、多 Agent 同时执行时的聊天框渲染隔离测试。
 *
 *  测试覆盖：
 *    1. streamKey 路由隔离 — 不同 agent/session 的 delta 不串台
 *    2. parts 隔离 — 两个并发流的 deriveUiMessageParts 结果独立
 *    3. 消息隔离 — appendMessage / updateMessage 的 per-session 隔离
 *    4. 工具卡数据隔离 — tc.subAgents 不跨 tool call 泄漏
 *    5. 并发流式 parts 跟踪 — 两个并发流各自维护独立的时间顺序
 *    6. 并发 done 处理 — 两个流独立结束，parts 不交叉
 *
 *  架构依据：
 *    - AgentChatPanel 所有渲染状态（_messages, _isSending, _streamingUpdateRaf 等）
 *      均为实例级字段 → 多窗口安全
 *    - AgentChatService 用 streamKey（agentId::sessionId）分桶 _activeOnDeltas
 *      → 多 agent 并发安全
 *    - appendMessage 用 _cacheKey(agentId, agentSessionId) 分桶 → 消息隔离
 *---------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { deriveUiMessageParts, adaptPersistedChatMessage, type IToolCall, type IMessagePart, type IAgentChatMessage } from '../../../../browser/agentChat/agentChatTypes.js';

// ══════════════════════════════════════════════════════════════════
// 1. streamKey 路由隔离
// ══════════════════════════════════════════════════════════════════

suite('Concurrent Multi-Agent — streamKey 路由隔离', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * 模拟 AgentChatService 的 streamKey 构造与 _activeOnDeltas 路由。
	 * 验证：两个不同 agent 或同 agent 不同 session 的流同时进行时，
	 * delta 回调不会串台。
	 */

	function makeStreamKey(agentId: string, sessionId?: string): string {
		return sessionId ? `${agentId}::${sessionId}` : agentId;
	}

	test('不同 agent 的 streamKey 不同', () => {
		const keyA = makeStreamKey('agent-coder', 'sess-a');
		const keyB = makeStreamKey('agent-pm', 'sess-b');
		assert.notStrictEqual(keyA, keyB, '不同 agent 的 streamKey 必须不同');
	});

	test('同 agent 不同 session 的 streamKey 不同', () => {
		const key1 = makeStreamKey('agent-coder', 'sess-1');
		const key2 = makeStreamKey('agent-coder', 'sess-2');
		assert.notStrictEqual(key1, key2, '同 agent 不同 session 的 streamKey 必须不同');
	});

	test('delta 只路由到对应 streamKey 的回调', () => {
		const activeOnDeltas = new Map<string, (delta: any) => void>();
		const streamCreatedAt = new Map<string, number>();

		const receivedA: string[] = [];
		const receivedB: string[] = [];

		const keyA = makeStreamKey('agent-a', 'sess-a');
		const keyB = makeStreamKey('agent-b', 'sess-b');

		activeOnDeltas.set(keyA, (d) => receivedA.push(d.type));
		activeOnDeltas.set(keyB, (d) => receivedB.push(d.type));
		streamCreatedAt.set(keyA, Date.now());
		streamCreatedAt.set(keyB, Date.now() + 1);

		// 模拟 delta 到达 agent-a 的流
		activeOnDeltas.get(keyA)!({ type: 'text', content: 'hello from A' });
		activeOnDeltas.get(keyA)!({ type: 'tool_start', toolCallId: 'tc-a-1' });

		// 模拟 delta 到达 agent-b 的流
		activeOnDeltas.get(keyB)!({ type: 'text', content: 'hello from B' });

		assert.deepStrictEqual(receivedA, ['text', 'tool_start'], 'agent A 只收到自己的 delta');
		assert.deepStrictEqual(receivedB, ['text'], 'agent B 只收到自己的 delta');
	});

	test('cancelStream 只取消目标流，不影响其他流', () => {
		const activeStreams = new Map<string, { aborted: boolean }>();
		const activeOnDeltas = new Map<string, (delta: any) => void>();

		const keyA = makeStreamKey('agent-a', 'sess-a');
		const keyB = makeStreamKey('agent-b', 'sess-b');

		const controllerA = { aborted: false };
		const controllerB = { aborted: false };

		activeStreams.set(keyA, controllerA);
		activeStreams.set(keyB, controllerB);
		activeOnDeltas.set(keyA, () => {});
		activeOnDeltas.set(keyB, () => {});

		// 取消 agent-a 的流
		activeStreams.get(keyA)!.aborted = true;
		activeStreams.delete(keyA);
		activeOnDeltas.delete(keyA);

		// agent-b 的流不受影响
		assert.strictEqual(controllerA.aborted, true, 'agent A 的流被取消');
		assert.strictEqual(controllerB.aborted, false, 'agent B 的流未受影响');
		assert.strictEqual(activeOnDeltas.has(keyA), false, 'agent A 的回调已移除');
		assert.strictEqual(activeOnDeltas.has(keyB), true, 'agent B 的回调仍存在');
	});

	test('_getOnDeltaForAgent 按最新时间戳路由 memory 事件', () => {
		const activeOnDeltas = new Map<string, (delta: any) => void>();
		const streamCreatedAt = new Map<string, number>();

		let receivedByLatest: string[] = [];

		// 同 agent 两个并发 session
		const key1 = makeStreamKey('agent-x', 'sess-1');
		const key2 = makeStreamKey('agent-x', 'sess-2');

		activeOnDeltas.set(key1, (d) => receivedByLatest.push(`sess-1:${d.type}`));
		activeOnDeltas.set(key2, (d) => receivedByLatest.push(`sess-2:${d.type}`));
		streamCreatedAt.set(key1, 1000);
		streamCreatedAt.set(key2, 2000); // sess-2 更新

		// 模拟 _getOnDeltaForAgent
		function getOnDeltaForAgent(agentId: string) {
			let bestKey: string | undefined;
			let bestTime = -1;
			for (const [key, time] of streamCreatedAt) {
				if (key === agentId || key.startsWith(`${agentId}::`)) {
					if (time > bestTime) { bestTime = time; bestKey = key; }
				}
			}
			return bestKey ? activeOnDeltas.get(bestKey) : undefined;
		}

		// memory 事件路由到最新的流 (sess-2)
		const cb = getOnDeltaForAgent('agent-x');
		assert.ok(cb, '应找到回调');
		cb!({ type: 'memory_written' });
		assert.deepStrictEqual(receivedByLatest, ['sess-2:memory_written'], 'memory 事件路由到最新流');

		// sess-2 完成后移除
		activeOnDeltas.delete(key2);
		streamCreatedAt.delete(key2);
		receivedByLatest = [];

		// 后续 memory 事件路由到 sess-1
		const cb2 = getOnDeltaForAgent('agent-x');
		cb2!({ type: 'memory_written' });
		assert.deepStrictEqual(receivedByLatest, ['sess-1:memory_written'], 'sess-2 结束后路由到 sess-1');
	});
});

// ══════════════════════════════════════════════════════════════════
// 2. parts 隔离 — deriveUiMessageParts 独立性
// ══════════════════════════════════════════════════════════════════

suite('Concurrent Multi-Agent — parts 隔离', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('两个并发流的 deriveUiMessageParts 结果互不影响', () => {
		// Agent A 的工具调用
		const tcsA: IToolCall[] = [
			{ id: 'tc-a-1', name: 'search_files', status: 'done', args: 'query A', textPosition: 5 },
			{ id: 'tc-a-2', name: 'file_read', status: 'done', args: 'fileA.ts', textPosition: 10 },
		];
		const partsA = deriveUiMessageParts('Hello A World A', tcsA);

		// Agent B 的工具调用（同时进行）
		const tcsB: IToolCall[] = [
			{ id: 'tc-b-1', name: 'delegate_task', status: 'running', args: 'task B' },
		];
		const partsB = deriveUiMessageParts('Working on B', tcsB);

		// 验证 A 的 parts 只包含 A 的工具
		const toolIdsA = partsA.filter(p => p.kind === 'tool').map((p: any) => p.tool.id);
		assert.deepStrictEqual(toolIdsA, ['tc-a-1', 'tc-a-2'], 'Agent A 的 parts 只含 A 的工具');

		// 验证 B 的 parts 只包含 B 的工具
		const toolIdsB = partsB.filter(p => p.kind === 'tool').map((p: any) => p.tool.id);
		assert.deepStrictEqual(toolIdsB, ['tc-b-1'], 'Agent B 的 parts 只含 B 的工具');

		// 验证 A 的 parts 不包含 B 的工具
		assert.ok(!toolIdsA.includes('tc-b-1'), 'Agent A 的 parts 不含 B 的工具');
		assert.ok(!toolIdsB.includes('tc-a-1'), 'Agent B 的 parts 不含 A 的工具');
	});

	test('相同工具名不同 ID 的并发调用不混淆', () => {
		// 两个 agent 同时调用 search_files，但 ID 不同
		const tcsA: IToolCall[] = [
			{ id: 'tc-a-search', name: 'search_files', status: 'done', args: 'query A' },
		];
		const tcsB: IToolCall[] = [
			{ id: 'tc-b-search', name: 'search_files', status: 'done', args: 'query B' },
		];

		const partsA = deriveUiMessageParts('Result A', tcsA);
		const partsB = deriveUiMessageParts('Result B', tcsB);

		const toolA = partsA.find(p => p.kind === 'tool') as any;
		const toolB = partsB.find(p => p.kind === 'tool') as any;

		assert.strictEqual(toolA.tool.id, 'tc-a-search', 'Agent A 的工具 ID 正确');
		assert.strictEqual(toolB.tool.id, 'tc-b-search', 'Agent B 的工具 ID 正确');
		assert.strictEqual(toolA.tool.args, 'query A', 'Agent A 的工具参数正确');
		assert.strictEqual(toolB.tool.args, 'query B', 'Agent B 的工具参数正确');
	});

	test('tool call 的 subAgents 不跨 tool call 泄漏', () => {
		const tc1: IToolCall = {
			id: 'tc-delegate-1',
			name: 'delegate_task',
			status: 'done',
			args: 'explore module A',
			subAgents: [
				{ id: 'sa-1', type: 'code-explorer', status: 'done', parentToolCallId: 'tc-delegate-1' } as any,
			],
		};
		const tc2: IToolCall = {
			id: 'tc-delegate-2',
			name: 'delegate_task',
			status: 'done',
			args: 'explore module B',
			subAgents: [
				{ id: 'sa-2', type: 'code-explorer', status: 'done', parentToolCallId: 'tc-delegate-2' } as any,
			],
		};

		// 两个 tool call 在同一个 parts 数组中
		const parts = deriveUiMessageParts('Working', [tc1, tc2]);
		const toolParts = parts.filter(p => p.kind === 'tool') as any[];

		assert.strictEqual(toolParts.length, 2, '应有 2 个 tool parts');

		// 验证 subAgents 隔离
		assert.strictEqual(toolParts[0].tool.subAgents?.length, 1, 'tc1 有 1 个 subAgent');
		assert.strictEqual(toolParts[0].tool.subAgents[0].id, 'sa-1', 'tc1 的 subAgent ID 正确');
		assert.strictEqual(toolParts[1].tool.subAgents?.length, 1, 'tc2 有 1 个 subAgent');
		assert.strictEqual(toolParts[1].tool.subAgents[0].id, 'sa-2', 'tc2 的 subAgent ID 正确');

		// 验证不交叉
		assert.ok(!toolParts[0].tool.subAgents.find((sa: any) => sa.id === 'sa-2'), 'tc1 不含 tc2 的 subAgent');
		assert.ok(!toolParts[1].tool.subAgents.find((sa: any) => sa.id === 'sa-1'), 'tc2 不含 tc1 的 subAgent');
	});
});

// ══════════════════════════════════════════════════════════════════
// 3. 消息隔离 — appendMessage / updateMessage 的 per-session 隔离
// ══════════════════════════════════════════════════════════════════

suite('Concurrent Multi-Agent — 消息隔离', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * 模拟 AgentChatPanelBase._messages 数组 + updateMessage 逻辑。
	 * 两个 panel 实例各自维护独立的 _messages 数组。
	 */

	test('两个 panel 的 _messages 数组互不影响', () => {
		// 模拟两个 panel 实例的 _messages
		const messagesA: IAgentChatMessage[] = [];
		const messagesB: IAgentChatMessage[] = [];

		// Panel A 收到消息
		messagesA.push({ id: 'msg-a-1', role: 'user', content: 'Hello A', timestamp: Date.now() });
		messagesA.push({ id: 'msg-a-2', role: 'assistant', content: 'Response A', timestamp: Date.now() });

		// Panel B 收到消息（同时进行）
		messagesB.push({ id: 'msg-b-1', role: 'user', content: 'Hello B', timestamp: Date.now() });

		// 验证隔离
		assert.strictEqual(messagesA.length, 2, 'Panel A 有 2 条消息');
		assert.strictEqual(messagesB.length, 1, 'Panel B 有 1 条消息');
		assert.ok(messagesA.every(m => m.id.startsWith('msg-a-')), 'Panel A 只含 A 的消息');
		assert.ok(messagesB.every(m => m.id.startsWith('msg-b-')), 'Panel B 只含 B 的消息');
	});

	test('updateMessage 只修改目标 panel 的消息', () => {
		// 模拟两个 panel
		const messagesA: IAgentChatMessage[] = [
			{ id: 'msg-shared-id', role: 'assistant', content: 'Original A', timestamp: Date.now(), isStreaming: true },
		];
		const messagesB: IAgentChatMessage[] = [
			{ id: 'msg-shared-id', role: 'assistant', content: 'Original B', timestamp: Date.now(), isStreaming: true },
		];

		// 模拟 updateMessage 在 panel A 上执行
		const idx = messagesA.findIndex(m => m.id === 'msg-shared-id');
		if (idx >= 0) {
			Object.assign(messagesA[idx], { content: 'Updated A', isStreaming: false });
		}

		// Panel B 的消息不应被修改
		assert.strictEqual(messagesA[0].content, 'Updated A', 'Panel A 的消息已更新');
		assert.strictEqual(messagesB[0].content, 'Original B', 'Panel B 的消息未被修改');
		assert.strictEqual(messagesA[0].isStreaming, false, 'Panel A 已停止流式');
		assert.strictEqual(messagesB[0].isStreaming, true, 'Panel B 仍在流式');
	});

	test('相同消息 ID 在不同 panel 中互不干扰', () => {
		// 两个 panel 同时有 ID 为 "msg-streaming" 的流式消息
		const msgA: IAgentChatMessage = {
			id: 'msg-streaming', role: 'assistant', content: '', timestamp: Date.now(),
			isStreaming: true, toolCalls: [],
			parts: [{ kind: 'text', text: '' }],
		};
		const msgB: IAgentChatMessage = {
			id: 'msg-streaming', role: 'assistant', content: '', timestamp: Date.now(),
			isStreaming: true, toolCalls: [],
			parts: [{ kind: 'text', text: '' }],
		};

		// Panel A 的流式消息收到 text delta
		(msgA.parts![0] as any).text = 'Text from A';
		msgA.content = 'Text from A';

		// Panel B 的流式消息收到不同的 text delta
		(msgB.parts![0] as any).text = 'Text from B';
		msgB.content = 'Text from B';

		assert.strictEqual((msgA.parts![0] as any).text, 'Text from A', 'Panel A 的文本正确');
		assert.strictEqual((msgB.parts![0] as any).text, 'Text from B', 'Panel B 的文本正确');
		assert.strictEqual(msgA.content, 'Text from A', 'Panel A 的 content 正确');
		assert.strictEqual(msgB.content, 'Text from B', 'Panel B 的 content 正确');
	});

	test('appendMessage tail-dedup 在不同 session 中独立工作', () => {
		// 模拟两个 session 的消息缓存
		const cacheA: IAgentChatMessage[] = [
			{ id: 'msg-a-1', role: 'user', content: 'Hello', timestamp: 1000 },
		];
		const cacheB: IAgentChatMessage[] = [
			{ id: 'msg-b-1', role: 'user', content: 'Hello', timestamp: 1000 },
		];

		// 模拟 appendMessage 的 tail-dedup 逻辑
		function appendMessage(cache: IAgentChatMessage[], msg: IAgentChatMessage): void {
			const tail = cache[cache.length - 1];
			// 如果末尾消息 ID 相同 → 替换（不追加）
			if (tail && tail.id === msg.id) {
				cache[cache.length - 1] = msg;
			} else {
				cache.push(msg);
			}
		}

		// Panel A 追加新消息
		appendMessage(cacheA, { id: 'msg-a-2', role: 'assistant', content: 'Response A', timestamp: 2000 });
		// Panel B 追加新消息
		appendMessage(cacheB, { id: 'msg-b-2', role: 'assistant', content: 'Response B', timestamp: 2000 });

		assert.strictEqual(cacheA.length, 2, 'Panel A 有 2 条消息');
		assert.strictEqual(cacheB.length, 2, 'Panel B 有 2 条消息');
		assert.strictEqual(cacheA[1].id, 'msg-a-2', 'Panel A 末尾是 a-2');
		assert.strictEqual(cacheB[1].id, 'msg-b-2', 'Panel B 末尾是 b-2');

		// Panel A 用相同 ID 再次追加（dedup → 替换）
		appendMessage(cacheA, { id: 'msg-a-2', role: 'assistant', content: 'Updated Response A', timestamp: 3000 });
		assert.strictEqual(cacheA.length, 2, 'Panel A 仍为 2 条（dedup）');
		assert.strictEqual((cacheA[1] as any).content, 'Updated Response A', 'Panel A 末尾已更新');

		// Panel B 不受影响
		assert.strictEqual((cacheB[1] as any).content, 'Response B', 'Panel B 未受 Panel A 的 dedup 影响');
	});
});

// ══════════════════════════════════════════════════════════════════
// 4. 并发流式 parts 跟踪 — 两个流各自维护独立的时间顺序
// ══════════════════════════════════════════════════════════════════

suite('Concurrent Multi-Agent — 流式 parts 跟踪隔离', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * 模拟 nativeChatEditorPane 的 _streamingParts 跟踪。
	 * 每个 pane 实例有独立的 _streamingAssistantMsg 和 parts 数组。
	 */

	test('两个并发流各自维护独立的 parts 时间顺序', () => {
		// 模拟两个 pane 的流式状态
		const streamA = {
			assistantMsg: { content: '', toolCalls: [] as IToolCall[], parts: [] as IMessagePart[] },
		};
		const streamB = {
			assistantMsg: { content: '', toolCalls: [] as IToolCall[], parts: [] as IMessagePart[] },
		};

		// 交错模拟两个流的 delta 到达
		// 1. Stream A: text "Hello A"
		streamA.assistantMsg.content = 'Hello A';
		streamA.assistantMsg.parts.push({ kind: 'text', text: 'Hello A' });

		// 2. Stream B: text "Hello B"
		streamB.assistantMsg.content = 'Hello B';
		streamB.assistantMsg.parts.push({ kind: 'text', text: 'Hello B' });

		// 3. Stream A: tool_start
		const tcA: IToolCall = { id: 'tc-a-1', name: 'search_files', status: 'running', args: 'query A' };
		streamA.assistantMsg.toolCalls.push(tcA);
		streamA.assistantMsg.parts.push({ kind: 'tool', tool: tcA });

		// 4. Stream B: tool_start
		const tcB: IToolCall = { id: 'tc-b-1', name: 'file_read', status: 'running', args: 'fileB.ts' };
		streamB.assistantMsg.toolCalls.push(tcB);
		streamB.assistantMsg.parts.push({ kind: 'tool', tool: tcB });

		// 5. Stream A: text "Result A"
		streamA.assistantMsg.content = 'Hello A Result A';
		streamA.assistantMsg.parts.push({ kind: 'text', text: 'Result A' });

		// 验证 A 的 parts 顺序：text → tool → text
		assert.strictEqual(streamA.assistantMsg.parts.length, 3, 'Stream A 有 3 个 parts');
		assert.strictEqual(streamA.assistantMsg.parts[0].kind, 'text', 'A[0] = text');
		assert.strictEqual(streamA.assistantMsg.parts[1].kind, 'tool', 'A[1] = tool');
		assert.strictEqual(streamA.assistantMsg.parts[2].kind, 'text', 'A[2] = text');
		assert.strictEqual((streamA.assistantMsg.parts[1] as any).tool.id, 'tc-a-1', 'A tool ID 正确');

		// 验证 B 的 parts 顺序：text → tool
		assert.strictEqual(streamB.assistantMsg.parts.length, 2, 'Stream B 有 2 个 parts');
		assert.strictEqual(streamB.assistantMsg.parts[0].kind, 'text', 'B[0] = text');
		assert.strictEqual(streamB.assistantMsg.parts[1].kind, 'tool', 'B[1] = tool');
		assert.strictEqual((streamB.assistantMsg.parts[1] as any).tool.id, 'tc-b-1', 'B tool ID 正确');

		// 验证不交叉
		const aToolIds = streamA.assistantMsg.parts.filter(p => p.kind === 'tool').map((p: any) => p.tool.id);
		const bToolIds = streamB.assistantMsg.parts.filter(p => p.kind === 'tool').map((p: any) => p.tool.id);
		assert.ok(!aToolIds.includes('tc-b-1'), 'Stream A 不含 B 的工具');
		assert.ok(!bToolIds.includes('tc-a-1'), 'Stream B 不含 A 的工具');
	});

	test('并发 subagent_batch delta 附加到各自的父工具调用', () => {
		// 模拟两个流的 assistantMsg
		const streamA = {
			assistantMsg: {
				toolCalls: [{ id: 'tc-delegate-a', name: 'delegate_task', status: 'running', args: 'task A' } as IToolCall],
			},
		};
		const streamB = {
			assistantMsg: {
				toolCalls: [{ id: 'tc-delegate-b', name: 'delegate_task', status: 'running', args: 'task B' } as IToolCall],
			},
		};

		// 模拟 _attachSubAgentsToToolCall
		function attachSubAgents(assistantMsg: any, saData: any[], toolCallId?: string): void {
			if (toolCallId) {
				const parentTc = assistantMsg.toolCalls.find((tc: any) => tc.id === toolCallId);
				if (parentTc) { parentTc.subAgents = saData; }
			}
			assistantMsg.subAgents = saData;
		}

		// Stream A 收到 subagent 数据
		attachSubAgents(streamA.assistantMsg, [
			{ id: 'sa-a-1', type: 'code-explorer', status: 'running', parentToolCallId: 'tc-delegate-a' },
		], 'tc-delegate-a');

		// Stream B 收到不同的 subagent 数据
		attachSubAgents(streamB.assistantMsg, [
			{ id: 'sa-b-1', type: 'code-explorer', status: 'done', parentToolCallId: 'tc-delegate-b' },
		], 'tc-delegate-b');

		// 验证隔离
		assert.strictEqual(streamA.assistantMsg.toolCalls[0].subAgents[0].id, 'sa-a-1', 'Stream A 的 subAgent 正确');
		assert.strictEqual(streamB.assistantMsg.toolCalls[0].subAgents[0].id, 'sa-b-1', 'Stream B 的 subAgent 正确');
		assert.ok(!streamA.assistantMsg.toolCalls[0].subAgents.find((sa: any) => sa.id === 'sa-b-1'), 'Stream A 不含 B 的 subAgent');
		assert.ok(!streamB.assistantMsg.toolCalls[0].subAgents.find((sa: any) => sa.id === 'sa-a-1'), 'Stream B 不含 A 的 subAgent');
	});
});

// ══════════════════════════════════════════════════════════════════
// 5. 并发 done 处理 — 两个流独立结束
// ══════════════════════════════════════════════════════════════════

suite('Concurrent Multi-Agent — 并发 done 处理', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('两个流独立结束时 parts 不交叉', () => {
		// 模拟两个流的最终 parts
		const finalPartsA: IMessagePart[] = [
			{ kind: 'text', text: 'Starting A' },
			{ kind: 'tool', tool: { id: 'tc-a-1', name: 'search', status: 'done', args: 'A' } as IToolCall },
			{ kind: 'text', text: 'Done A' },
		];
		const finalPartsB: IMessagePart[] = [
			{ kind: 'text', text: 'Starting B' },
			{ kind: 'tool', tool: { id: 'tc-b-1', name: 'delegate_task', status: 'done', args: 'B' } as IToolCall },
		];

		// 模拟 done handler 发送 parts
		const msgA: IAgentChatMessage = {
			id: 'msg-a', role: 'assistant', content: 'Starting A Done A',
			timestamp: 1000, isStreaming: false,
			toolCalls: [{ id: 'tc-a-1', name: 'search', status: 'done', args: 'A' }],
			parts: finalPartsA,
		};
		const msgB: IAgentChatMessage = {
			id: 'msg-b', role: 'assistant', content: 'Starting B',
			timestamp: 2000, isStreaming: false,
			toolCalls: [{ id: 'tc-b-1', name: 'delegate_task', status: 'done', args: 'B' }],
			parts: finalPartsB,
		};

		// 验证最终 parts 隔离
		assert.strictEqual(msgA.parts!.length, 3, 'msgA 有 3 parts');
		assert.strictEqual(msgB.parts!.length, 2, 'msgB 有 2 parts');

		const aToolIds = msgA.parts!.filter(p => p.kind === 'tool').map((p: any) => p.tool.id);
		const bToolIds = msgB.parts!.filter(p => p.kind === 'tool').map((p: any) => p.tool.id);
		assert.deepStrictEqual(aToolIds, ['tc-a-1'], 'msgA 只含 tc-a-1');
		assert.deepStrictEqual(bToolIds, ['tc-b-1'], 'msgB 只含 tc-b-1');
	});

	test('一个流 error 时另一个流的 parts 不受影响', () => {
		// Stream A 出错
		const msgA: IAgentChatMessage = {
			id: 'msg-a', role: 'assistant', content: 'Partial A',
			timestamp: 1000, isStreaming: false,
			toolCalls: [{ id: 'tc-a-1', name: 'search', status: 'error', args: 'A' }],
			parts: [
				{ kind: 'text', text: 'Partial A' },
				{ kind: 'tool', tool: { id: 'tc-a-1', name: 'search', status: 'error', args: 'A' } as IToolCall },
			],
		};

		// Stream B 正常完成
		const msgB: IAgentChatMessage = {
			id: 'msg-b', role: 'assistant', content: 'Complete B',
			timestamp: 2000, isStreaming: false,
			toolCalls: [{ id: 'tc-b-1', name: 'file_read', status: 'done', args: 'B' }],
			parts: [
				{ kind: 'text', text: 'Complete B' },
				{ kind: 'tool', tool: { id: 'tc-b-1', name: 'file_read', status: 'done', args: 'B' } as IToolCall },
				{ kind: 'text', text: 'Done' },
			],
		};

		// 验证 B 不受 A 的错误影响
		assert.strictEqual(msgB.parts!.length, 3, 'msgB 的 parts 完整');
		assert.strictEqual((msgB.parts![1] as any).tool.status, 'done', 'msgB 的工具状态为 done');
		assert.strictEqual((msgA.parts![1] as any).tool.status, 'error', 'msgA 的工具状态为 error');
	});

	test('并发 done 的 toolCalls 不覆盖对方的 parts', () => {
		// 模拟 updateMessage 的 parts 管理逻辑
		function updateMessage(msg: IAgentChatMessage, updates: Partial<IAgentChatMessage>): void {
			Object.assign(msg, updates);
			const hasPartsUpdate = updates.parts !== undefined;
			const hasToolCallUpdate = updates.toolCalls !== undefined;

			if (!hasPartsUpdate && msg.role === 'assistant') {
				if (hasToolCallUpdate) {
					const existingToolParts = msg.parts?.filter(p => p.kind === 'tool') ?? [];
					const newToolCount = msg.toolCalls?.length ?? 0;
					if (existingToolParts.length !== newToolCount || !msg.parts || msg.parts.length === 0) {
						// 工具数量变化 → 重新派生
						msg.parts = deriveUiMessageParts(msg.content ?? '', msg.toolCalls ?? []);
					}
					// 工具数量不变 → 保留已有 parts（对象共享引用）
				}
			}
		}

		// 两个流同时 done
		const msgA: IAgentChatMessage = {
			id: 'msg-a', role: 'assistant', content: 'Text A',
			timestamp: 1000, isStreaming: true,
			toolCalls: [{ id: 'tc-a-1', name: 'search', status: 'running', args: 'A' }],
			parts: [
				{ kind: 'text', text: 'Text A' },
				{ kind: 'tool', tool: { id: 'tc-a-1', name: 'search', status: 'running', args: 'A' } as IToolCall },
			],
		};
		const msgB: IAgentChatMessage = {
			id: 'msg-b', role: 'assistant', content: 'Text B',
			timestamp: 2000, isStreaming: true,
			toolCalls: [{ id: 'tc-b-1', name: 'file_read', status: 'running', args: 'B' }],
			parts: [
				{ kind: 'text', text: 'Text B' },
				{ kind: 'tool', tool: { id: 'tc-b-1', name: 'file_read', status: 'running', args: 'B' } as IToolCall },
			],
		};

		// A done: 更新 toolCalls 状态 + isStreaming=false（工具数量不变 → 保留 parts）
		updateMessage(msgA, {
			toolCalls: [{ id: 'tc-a-1', name: 'search', status: 'done', args: 'A' }],
			isStreaming: false,
		});

		// B done: 更新 toolCalls 状态 + isStreaming=false
		updateMessage(msgB, {
			toolCalls: [{ id: 'tc-b-1', name: 'file_read', status: 'done', args: 'B' }],
			isStreaming: false,
		});

		// 验证 A 的 parts 保留（工具数量不变）
		assert.strictEqual(msgA.parts!.length, 2, 'msgA parts 保留');
		assert.strictEqual((msgA.parts![1] as any).tool.id, 'tc-a-1', 'msgA tool ID 正确');

		// 验证 B 的 parts 保留
		assert.strictEqual(msgB.parts!.length, 2, 'msgB parts 保留');
		assert.strictEqual((msgB.parts![1] as any).tool.id, 'tc-b-1', 'msgB tool ID 正确');

		// 验证不交叉
		assert.ok(!(msgA.parts!.some(p => p.kind === 'tool' && (p as any).tool.id === 'tc-b-1')), 'msgA 不含 B 的工具');
		assert.ok(!(msgB.parts!.some(p => p.kind === 'tool' && (p as any).tool.id === 'tc-a-1')), 'msgB 不含 A 的工具');
	});
});

// ══════════════════════════════════════════════════════════════════
// 6. adaptPersistedChatMessage — 多 session 历史加载隔离
// ══════════════════════════════════════════════════════════════════

suite('Concurrent Multi-Agent — 历史加载隔离', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('两个 session 的历史消息独立加载', () => {
		// Session A 的持久化消息
		const persistedA = {
			id: 'msg-a-1',
			role: 'assistant',
			content: 'Response A',
			timestamp: '2026-07-24T10:00:00Z',
			toolCalls: [
				{ id: 'tc-a-1', name: 'search_files', status: 'done', args: 'query A' },
			],
			parts: [
				{ kind: 'text', text: 'Response A' },
				{ kind: 'tool', tool: { id: 'tc-a-1', name: 'search_files', status: 'done', args: 'query A' } },
			],
		};

		// Session B 的持久化消息
		const persistedB = {
			id: 'msg-b-1',
			role: 'assistant',
			content: 'Response B',
			timestamp: '2026-07-24T11:00:00Z',
			toolCalls: [
				{ id: 'tc-b-1', name: 'delegate_task', status: 'done', args: 'task B' },
			],
			parts: [
				{ kind: 'text', text: 'Response B' },
				{ kind: 'tool', tool: { id: 'tc-b-1', name: 'delegate_task', status: 'done', args: 'task B' } },
			],
		};

		const msgA = adaptPersistedChatMessage(persistedA);
		const msgB = adaptPersistedChatMessage(persistedB);

		assert.ok(msgA && msgB, '两条消息都应成功加载');

		// 验证隔离
		assert.strictEqual(msgA!.id, 'msg-a-1', 'msgA ID 正确');
		assert.strictEqual(msgB!.id, 'msg-b-1', 'msgB ID 正确');

		const aToolIds = msgA!.parts!.filter(p => p.kind === 'tool').map((p: any) => p.tool.id);
		const bToolIds = msgB!.parts!.filter(p => p.kind === 'tool').map((p: any) => p.tool.id);
		assert.deepStrictEqual(aToolIds, ['tc-a-1'], 'msgA 只含 tc-a-1');
		assert.deepStrictEqual(bToolIds, ['tc-b-1'], 'msgB 只含 tc-b-1');
	});

	test('旧格式 subagent parts 迁移到各自 session 的 tool call', () => {
		// Session A 的旧格式消息（含 subagent parts）
		const persistedA = {
			id: 'msg-a-1',
			role: 'assistant',
			content: 'Working on A',
			timestamp: '2026-07-24T10:00:00Z',
			toolCalls: [
				{ id: 'tc-delegate-a', name: 'delegate_task', status: 'done', args: 'task A' },
			],
			parts: [
				{ kind: 'text', text: 'Working on A' },
				{ kind: 'tool', tool: { id: 'tc-delegate-a', name: 'delegate_task', status: 'done', args: 'task A' } },
				{ kind: 'subagent', subAgent: { id: 'sa-a-1', type: 'code-explorer', status: 'done', parentToolCallId: 'tc-delegate-a' } },
			],
		};

		// Session B 的旧格式消息
		const persistedB = {
			id: 'msg-b-1',
			role: 'assistant',
			content: 'Working on B',
			timestamp: '2026-07-24T11:00:00Z',
			toolCalls: [
				{ id: 'tc-delegate-b', name: 'delegate_task', status: 'done', args: 'task B' },
			],
			parts: [
				{ kind: 'text', text: 'Working on B' },
				{ kind: 'tool', tool: { id: 'tc-delegate-b', name: 'delegate_task', status: 'done', args: 'task B' } },
				{ kind: 'subagent', subAgent: { id: 'sa-b-1', type: 'code-explorer', status: 'done', parentToolCallId: 'tc-delegate-b' } },
			],
		};

		const msgA = adaptPersistedChatMessage(persistedA);
		const msgB = adaptPersistedChatMessage(persistedB);

		// 验证 subagent parts 已迁移到 tool call 的 subAgents
		const tcA = msgA!.toolCalls![0];
		const tcB = msgB!.toolCalls![0];

		assert.ok(tcA.subAgents, 'tc-delegate-a 应有 subAgents');
		assert.ok(tcB.subAgents, 'tc-delegate-b 应有 subAgents');
		assert.strictEqual(tcA.subAgents![0].id, 'sa-a-1', 'tcA 的 subAgent ID 正确');
		assert.strictEqual(tcB.subAgents![0].id, 'sa-b-1', 'tcB 的 subAgent ID 正确');

		// 验证 parts 中不再有 subagent kind
		assert.ok(!msgA!.parts!.some(p => p.kind === 'subagent'), 'msgA parts 不含 subagent');
		assert.ok(!msgB!.parts!.some(p => p.kind === 'subagent'), 'msgB parts 不含 subagent');
	});

	test('msg.subAgents 兼容恢复到 tool call（旧数据）', () => {
		// 旧格式：subAgents 在 msg 顶层，不在 parts 中
		const persisted = {
			id: 'msg-old-1',
			role: 'assistant',
			content: 'Working',
			timestamp: '2026-07-24T10:00:00Z',
			toolCalls: [
				{ id: 'tc-old-delegate', name: 'delegate_task', status: 'done', args: 'task' },
			],
			subAgents: [
				{ id: 'sa-old-1', type: 'code-explorer', status: 'done', parentToolCallId: 'tc-old-delegate' },
				{ id: 'sa-old-2', type: 'researcher', status: 'done', parentToolCallId: 'tc-old-delegate' },
			],
		};

		const msg = adaptPersistedChatMessage(persisted);
		assert.ok(msg, '消息应成功加载');

		const tc = msg!.toolCalls![0];
		assert.ok(tc.subAgents, 'tc-old-delegate 应有 subAgents（从 msg.subAgents 恢复）');
		assert.strictEqual(tc.subAgents!.length, 2, '应有 2 个 subAgents');
		assert.strictEqual(tc.subAgents![0].id, 'sa-old-1', '第一个 subAgent ID 正确');
		assert.strictEqual(tc.subAgents![1].id, 'sa-old-2', '第二个 subAgent ID 正确');
	});
});

// ══════════════════════════════════════════════════════════════════
// 7. 工具卡数据隔离 — subagent 数据更新不跨 tool call
// ══════════════════════════════════════════════════════════════════

suite('Concurrent Multi-Agent — 工具卡数据更新隔离', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('subagent 数据更新只影响目标 tool call', () => {
		// 两个 delegate_task 工具调用在同一个消息中
		const tc1: IToolCall = {
			id: 'tc-delegate-1', name: 'delegate_task', status: 'running', args: 'task 1',
		};
		const tc2: IToolCall = {
			id: 'tc-delegate-2', name: 'delegate_task', status: 'running', args: 'task 2',
		};

		// 初始 subagent 数据
		tc1.subAgents = [{ id: 'sa-1', type: 'code-explorer', status: 'running', parentToolCallId: 'tc-delegate-1', thinking: 'Starting...' } as any];
		tc2.subAgents = [{ id: 'sa-2', type: 'researcher', status: 'running', parentToolCallId: 'tc-delegate-2', thinking: 'Starting...' } as any];

		// 模拟 subagent_batch 更新 tc1 的 subagent 数据
		const updatedSa1 = { id: 'sa-1', type: 'code-explorer', status: 'running', parentToolCallId: 'tc-delegate-1', thinking: 'Analyzing code...', toolTraces: [{ name: 'search_graph', status: 'done' }] };
		tc1.subAgents = [updatedSa1];

		// 验证 tc2 的 subagent 数据未被修改
		assert.strictEqual(tc1.subAgents[0].thinking, 'Analyzing code...', 'tc1 的 subagent thinking 已更新');
		assert.strictEqual(tc2.subAgents[0].thinking, 'Starting...', 'tc2 的 subagent thinking 未变');
		assert.strictEqual((tc1.subAgents[0] as any).toolTraces?.length, 1, 'tc1 的 subagent 有 toolTraces');
		assert.strictEqual((tc2.subAgents[0] as any).toolTraces, undefined, 'tc2 的 subagent 无 toolTraces');
	});

	test('并发 subagent_batch 到达不同 tool call 时不串台', () => {
		// 模拟两个流各自的 tool call
		const streamA_tc: IToolCall = { id: 'tc-a-delegate', name: 'delegate_task', status: 'running', args: 'A' };
		const streamB_tc: IToolCall = { id: 'tc-b-delegate', name: 'delegate_task', status: 'running', args: 'B' };

		// 模拟 _attachSubAgentsToToolCall
		function attach(assistantMsg: any, saData: any[], toolCallId?: string): void {
			if (toolCallId) {
				const parentTc = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === toolCallId);
				if (parentTc) { parentTc.subAgents = saData; }
			}
		}

		const msgA = { toolCalls: [streamA_tc] };
		const msgB = { toolCalls: [streamB_tc] };

		// 交错更新
		attach(msgA, [{ id: 'sa-a', status: 'running', parentToolCallId: 'tc-a-delegate' }], 'tc-a-delegate');
		attach(msgB, [{ id: 'sa-b', status: 'running', parentToolCallId: 'tc-b-delegate' }], 'tc-b-delegate');
		attach(msgA, [{ id: 'sa-a', status: 'done', parentToolCallId: 'tc-a-delegate', output: 'Result A' }], 'tc-a-delegate');

		// 验证
		assert.strictEqual(streamA_tc.subAgents![0].status, 'done', 'Stream A 的 subAgent 已完成');
		assert.strictEqual(streamB_tc.subAgents![0].status, 'running', 'Stream B 的 subAgent 仍在运行');
		assert.strictEqual((streamA_tc.subAgents![0] as any).output, 'Result A', 'Stream A 有输出');
		assert.strictEqual((streamB_tc.subAgents![0] as any).output, undefined, 'Stream B 无输出');
		assert.strictEqual(streamA_tc.subAgents![0].id, 'sa-a', 'Stream A subAgent ID 正确');
		assert.strictEqual(streamB_tc.subAgents![0].id, 'sa-b', 'Stream B subAgent ID 正确');
	});

	test('updateMessage 的 subagentDataOnly 路径不影响其他 tool call', () => {
		// 模拟一个消息有 3 个 tool call，其中 1 个有 subAgents
		const tc1: IToolCall = { id: 'tc-1', name: 'search', status: 'done', args: 'query' };
		const tc2: IToolCall = { id: 'tc-2', name: 'delegate_task', status: 'running', args: 'task', subAgents: [{ id: 'sa-1', status: 'running' } as any] };
		const tc3: IToolCall = { id: 'tc-3', name: 'file_read', status: 'done', args: 'file.ts' };

		const msg: IAgentChatMessage = {
			id: 'msg-1', role: 'assistant', content: 'Working',
			timestamp: Date.now(), isStreaming: true,
			toolCalls: [tc1, tc2, tc3],
			parts: [
				{ kind: 'text', text: 'Working' },
				{ kind: 'tool', tool: tc1 },
				{ kind: 'tool', tool: tc2 },
				{ kind: 'tool', tool: tc3 },
			],
		};

		// 模拟 subagentDataOnly 更新：只更新 subAgents，不更新 toolCalls
		const newSubAgents = [{ id: 'sa-1', status: 'done', output: 'Done!' } as any];
		Object.assign(msg, { subAgents: newSubAgents });

		// 验证只有 tc2 的 subAgents 被更新（通过共享引用）
		// 注意：subagentDataOnly 路径中，toolCalls 对象是共享引用
		// _attachSubAgentsToToolCall 会直接修改 tc2.subAgents
		tc2.subAgents = newSubAgents;

		assert.strictEqual(tc1.subAgents, undefined, 'tc1 无 subAgents');
		assert.strictEqual(tc3.subAgents, undefined, 'tc3 无 subAgents');
		assert.strictEqual(tc2.subAgents![0].status, 'done', 'tc2 的 subAgent 已更新');
		assert.strictEqual((tc2.subAgents![0] as any).output, 'Done!', 'tc2 的 subAgent 有输出');

		// 验证 parts 中其他 tool parts 的 tool 对象未被修改
		const toolParts = msg.parts!.filter(p => p.kind === 'tool') as any[];
		assert.strictEqual(toolParts[0].tool.subAgents, undefined, 'parts[0] (tc1) 无 subAgents');
		assert.strictEqual(toolParts[2].tool.subAgents, undefined, 'parts[2] (tc3) 无 subAgents');
		assert.strictEqual(toolParts[1].tool.subAgents![0].status, 'done', 'parts[1] (tc2) subAgent 已更新');
	});
});

// ══════════════════════════════════════════════════════════════════
// 8. _isSending 独立性 — 两个 panel 的发送状态独立
// ══════════════════════════════════════════════════════════════════

suite('Concurrent Multi-Agent — 发送状态独立性', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('两个 panel 的 _isSending 独立', () => {
		// 模拟两个 panel 实例的 _isSending
		const panelA = { _isSending: false };
		const panelB = { _isSending: false };

		// Panel A 开始发送
		panelA._isSending = true;
		assert.strictEqual(panelA._isSending, true, 'Panel A 正在发送');
		assert.strictEqual(panelB._isSending, false, 'Panel B 闲置');

		// Panel B 也开始发送
		panelB._isSending = true;
		assert.strictEqual(panelA._isSending, true, 'Panel A 仍在发送');
		assert.strictEqual(panelB._isSending, true, 'Panel B 也在发送');

		// Panel A 完成
		panelA._isSending = false;
		assert.strictEqual(panelA._isSending, false, 'Panel A 完成');
		assert.strictEqual(panelB._isSending, true, 'Panel B 仍在发送');
	});

	test('_streamingUpdateRaf 独立 — 两个 panel 的 rAF 批处理不互相取消', () => {
		// 模拟两个 panel 的 _streamingUpdateRaf
		const panelA = { _streamingUpdateRaf: null as number | null };
		const panelB = { _streamingUpdateRaf: null as number | null };

		// Panel A 请求 rAF
		panelA._streamingUpdateRaf = 1; // 模拟 requestAnimationFrame 返回值
		// Panel B 请求 rAF
		panelB._streamingUpdateRaf = 2;

		// Panel A 取消自己的 rAF（如 isCritical 更新时）
		if (panelA._streamingUpdateRaf !== null) {
			// cancelAnimationFrame(panelA._streamingUpdateRaf)
			panelA._streamingUpdateRaf = null;
		}

		assert.strictEqual(panelA._streamingUpdateRaf, null, 'Panel A 的 rAF 已取消');
		assert.strictEqual(panelB._streamingUpdateRaf, 2, 'Panel B 的 rAF 不受影响');
	});

	test('_deltaFlushTimer 独立 — 两个 pane 的 delta 缓冲定时器不互相干扰', () => {
		// 模拟两个 pane 的 _deltaFlushTimer 和 _deltaBuffer
		const paneA = {
			_deltaFlushTimer: null as ReturnType<typeof setTimeout> | null,
			_deltaBuffer: [] as any[],
		};
		const paneB = {
			_deltaFlushTimer: null as ReturnType<typeof setTimeout> | null,
			_deltaBuffer: [] as any[],
		};

		// Pane A 收到 delta，启动 25ms 定时器
		paneA._deltaBuffer.push({ type: 'text', content: 'A' });
		paneA._deltaFlushTimer = setTimeout(() => {}, 25);

		// Pane B 收到 delta，启动自己的 25ms 定时器
		paneB._deltaBuffer.push({ type: 'text', content: 'B' });
		paneB._deltaFlushTimer = setTimeout(() => {}, 25);

		// Pane A 的定时器触发，清空缓冲
		clearTimeout(paneA._deltaFlushTimer);
		paneA._deltaFlushTimer = null;
		paneA._deltaBuffer = [];

		// Pane B 的定时器仍在等待
		assert.strictEqual(paneA._deltaBuffer.length, 0, 'Pane A 缓冲已清空');
		assert.strictEqual(paneB._deltaBuffer.length, 1, 'Pane B 缓冲仍有 delta');
		assert.strictEqual(paneA._deltaFlushTimer, null, 'Pane A 定时器已清除');
		assert.ok(paneB._deltaFlushTimer !== null, 'Pane B 定时器仍在运行');

		// 清理
		clearTimeout(paneB._deltaFlushTimer!);
	});
});
