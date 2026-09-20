/*---------------------------------------------------------------------------------------------
 *  piLoop 行为测试 —— 验证复刻的 agentloop 运行时语义
 *
 *  与 pi 原版对齐的关键行为：
 *  1. 无工具调用 → 单轮结束
 *  2. 有工具调用 → 执行后进入下一轮
 *  3. shouldStopAfterTurn 命中即终止
 *  4. maxTurns 兜底
 *  5. 串行/并行工具派发
 *  6. beforeToolCall 拦截 → 合成错误结果
 *  7. afterToolCall 改写结果
 *  8. terminate 终止整批
 *  9. 流失败编码为 error 事件（不抛错）
 * 10. StreamFn 契约：文本增量累积成完整消息
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { runAgentLoop, runAgentLoopContinue } from '../../browser/piLoop/agentLoop.js';
import { createPiStreamFn, convertToChatMessages } from '../../browser/piLoop/streamAdapter.js';
import { toAgentTool, toAgentTools } from '../../browser/piLoop/toolAdapter.js';
import { ContextManager } from '../../common/contextManager.js';
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	StreamFn,
	ToolResultMessage,
} from '../../browser/piLoop/types.js';

const TEST_MODEL: Model = { provider: 'test', id: 'test-model', api: 'test' };

/** 构造一个按脚本产出事件的假模型流。 */
function createScriptedStreamFn(
	script: (turnIndex: number) => AssistantMessageEvent[],
): StreamFn {
	let turn = 0;
	return (): AssistantMessageEventStream => {
		const events = script(turn);
		turn++;
		return createStaticStream(events);
	};
}

/** 把一组事件包装成 pi 契约要求的流。 */
function createStaticStream(events: readonly AssistantMessageEvent[]): AssistantMessageEventStream {
	let finalMessage: AssistantMessage = { role: 'assistant', content: [] };

	for (const event of events) {
		if (event.type === 'done' || event.type === 'error') {
			finalMessage = event.message;
		} else if ('partial' in event) {
			finalMessage = event.partial;
		}
	}

	return {
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield event;
			}
		},
		result: async () => finalMessage,
	};
}

/** 产出一轮「纯文本、无工具」的助手消息事件序列。 */
function textTurn(text: string): AssistantMessageEvent[] {
	const partial: AssistantMessage = {
		role: 'assistant',
		content: [{ type: 'text', text }],
		stopReason: 'stop',
	};
	return [
		{ type: 'start', partial: { role: 'assistant', content: [] } },
		{ type: 'text_delta', delta: text, partial },
		{ type: 'done', message: partial },
	];
}

/** 产出一轮「带工具调用」的助手消息事件序列。 */
function toolTurn(toolCallId: string, toolName: string, args: Record<string, unknown>): AssistantMessageEvent[] {
	const partial: AssistantMessage = {
		role: 'assistant',
		content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: args }],
		stopReason: 'toolUse',
	};
	return [
		{ type: 'start', partial: { role: 'assistant', content: [] } },
		{ type: 'toolcall_delta', delta: '', partial },
		{ type: 'done', message: partial },
	];
}

/** 构造基础配置。 */
function createConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return {
		model: TEST_MODEL,
		convertToLlm: (messages: readonly AgentMessage[]) =>
			messages.map((message) => {
				if (message.role === 'toolResult') {
					const toolResult = message as ToolResultMessage;
					return { role: 'user' as const, content: JSON.stringify(toolResult.content) };
				}
				const assistant = message as AssistantMessage;
				if (Array.isArray(assistant.content)) {
					const text = assistant.content
						.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
						.map((block) => block.text)
						.join('');
					return { role: 'assistant' as const, content: text };
				}
				return { role: 'user' as const, content: String(message.role) };
			}),
		...overrides,
	};
}

/** 收集全部事件。 */
function createCollector(): { events: AgentEvent[]; emit: (event: AgentEvent) => void } {
	const events: AgentEvent[] = [];
	return { events, emit: (event: AgentEvent) => { events.push(event); } };
}

suite('piLoop — pi agentloop 复刻行为', () => {

	test('无工具调用时单轮结束，返回助手消息', async () => {
		const context: AgentContext = { messages: [], tools: [] };
		const { events, emit } = createCollector();

		const result = await runAgentLoop(
			[{ role: 'user', content: '你好' }],
			context,
			createConfig(),
			emit,
			undefined,
			createScriptedStreamFn(() => textTurn('你好，我是助手')),
		);

		assert.strictEqual(result.length, 2, '应返回 user + assistant 两条消息');
		assert.strictEqual(result[1].role, 'assistant');
		assert.deepStrictEqual(
			events.map((event) => event.type),
			['agent_start', 'turn_start', 'message_start', 'message_end', 'message_start', 'message_update', 'message_end', 'turn_end', 'agent_end'],
		);
	});

	test('有工具调用时执行工具并进入下一轮', async () => {
		const executed: string[] = [];
		const echoTool = toAgentTool(
			{ name: 'echo', description: '回显', inputSchema: { type: 'object' } },
			async (toolCall) => {
				executed.push(toolCall.name);
				return { content: `echo:${String(toolCall.arguments.text)}` };
			},
		);

		const context: AgentContext = { messages: [], tools: [echoTool] };
		const { events, emit } = createCollector();

		const result = await runAgentLoop(
			[{ role: 'user', content: '调用 echo' }],
			context,
			createConfig(),
			emit,
			undefined,
			createScriptedStreamFn((turn) =>
				turn === 0 ? toolTurn('call-1', 'echo', { text: 'hi' }) : textTurn('完成'),
			),
		);

		assert.deepStrictEqual(executed, ['echo'], '工具应被执行一次');
		const toolResults = result.filter((message) => message.role === 'toolResult');
		assert.strictEqual(toolResults.length, 1, '应产生一条工具结果消息');
		assert.strictEqual((toolResults[0] as ToolResultMessage).isError, false);

		const eventTypes = events.map((event) => event.type);
		assert.ok(eventTypes.includes('tool_execution_start'), '应发射 tool_execution_start');
		assert.ok(eventTypes.includes('tool_execution_end'), '应发射 tool_execution_end');
	});

	test('shouldStopAfterTurn 返回 true 时立即终止', async () => {
		const context: AgentContext = { messages: [], tools: [] };
		const { emit } = createCollector();
		let turnCount = 0;

		await runAgentLoop(
			[{ role: 'user', content: 'hi' }],
			context,
			createConfig({
				shouldStopAfterTurn: () => true,
			}),
			emit,
			undefined,
			createScriptedStreamFn(() => { turnCount++; return textTurn('x'); }),
		);

		assert.strictEqual(turnCount, 1, 'shouldStopAfterTurn 命中后不应再发起模型调用');
	});

	test('maxTurns 作为兜底上限', async () => {
		const context: AgentContext = { messages: [], tools: [] };
		const { emit } = createCollector();
		let turnCount = 0;

		// 脚本每轮都请求工具：否则「无工具调用」会先让循环正常终止，maxTurns 无从生效。
		await runAgentLoop(
			[{ role: 'user', content: 'hi' }],
			context,
			createConfig({ maxTurns: 3 }),
			emit,
			undefined,
			createScriptedStreamFn((turn) => { turnCount++; return toolTurn(`c${turn}`, 'missing', {}); }),
		);

		// 2026-09-20 起撞顶多一轮**禁工具收尾轮**（对齐 legacy classifyBudgetGate 的 wrap-up
		// 语义：撞顶直接结束会让末轮工具成果被丢弃）⇒ 3 轮正常 + 1 轮收尾 = 4 次调用。
		// 硬停语义仍在：收尾轮之后必然终止（本用例若失控会超时挂掉）。
		assert.strictEqual(turnCount, 4, '应恰好发起 maxTurns 次模型调用 + 1 轮禁工具收尾');
		});

	test('beforeToolCall 拦截时合成错误结果，不执行工具', async () => {
		let executed = false;
		const tool = toAgentTool(
			{ name: 'danger', description: '危险操作', inputSchema: { type: 'object' } },
			async () => { executed = true; return { content: 'ok' }; },
		);

		const context: AgentContext = { messages: [], tools: [tool] };
		const { emit } = createCollector();

		const result = await runAgentLoop(
			[{ role: 'user', content: 'go' }],
			context,
			createConfig({
				beforeToolCall: () => ({ kind: 'blocked', reason: '策略禁止' }),
			}),
			emit,
			undefined,
			createScriptedStreamFn((turn) =>
				turn === 0 ? toolTurn('call-1', 'danger', {}) : textTurn('done'),
			),
		);

		assert.strictEqual(executed, false, '被拦截的工具不应执行');
		const toolResult = result.find((message) => message.role === 'toolResult') as ToolResultMessage;
		assert.strictEqual(toolResult.isError, true, '应标记为错误结果');
		assert.ok(
			JSON.stringify(toolResult.content).includes('策略禁止'),
			'错误文本应包含拦截原因',
		);
	});

	test('afterToolCall 可改写结果', async () => {
		const tool = toAgentTool(
			{ name: 'raw', description: '原样', inputSchema: { type: 'object' } },
			async () => ({ content: '原始内容' }),
		);

		const context: AgentContext = { messages: [], tools: [tool] };
		const { emit } = createCollector();

		const result = await runAgentLoop(
			[{ role: 'user', content: 'go' }],
			context,
			createConfig({
				afterToolCall: () => ({
					kind: 'replace',
					result: { content: [{ type: 'text', text: '改写内容' }] },
				}),
			}),
			emit,
			undefined,
			createScriptedStreamFn((turn) =>
				turn === 0 ? toolTurn('call-1', 'raw', {}) : textTurn('done'),
			),
		);

		const toolResult = result.find((message) => message.role === 'toolResult') as ToolResultMessage;
		assert.ok(
			JSON.stringify(toolResult.content).includes('改写内容'),
			'应使用 afterToolCall 返回的内容',
		);
	});

	test('工具返回 terminate 时终止整批剩余工具', async () => {
		const executed: string[] = [];
		const stopper = toAgentTool(
			{ name: 'stop', description: '终止', inputSchema: { type: 'object' } },
			async () => { executed.push('stop'); return { content: 'stopped', terminate: true }; },
		);

		const context: AgentContext = { messages: [], tools: [stopper] };
		const { emit } = createCollector();

		await runAgentLoop(
			[{ role: 'user', content: 'go' }],
			context,
			createConfig(),
			emit,
			undefined,
			createScriptedStreamFn(() => toolTurn('call-1', 'stop', {})),
		);

		assert.deepStrictEqual(executed, ['stop'], 'terminate 生效后不再发起新的模型轮次');
	});

	test('未找到工具时合成错误结果而非抛错', async () => {
		const context: AgentContext = { messages: [], tools: [] };
		const { emit } = createCollector();

		const result = await runAgentLoop(
			[{ role: 'user', content: 'go' }],
			context,
			createConfig(),
			emit,
			undefined,
			createScriptedStreamFn((turn) =>
				turn === 0 ? toolTurn('call-1', 'ghost', {}) : textTurn('done'),
			),
		);

		const toolResult = result.find((message) => message.role === 'toolResult') as ToolResultMessage;
		assert.strictEqual(toolResult.isError, true);
		assert.ok(JSON.stringify(toolResult.content).includes('ghost'), '错误文本应包含工具名');
	});

	test('工具自身抛错被转为错误结果，不中断 loop', async () => {
		const exploding = toAgentTool(
			{ name: 'boom', description: '抛错', inputSchema: { type: 'object' } },
			async () => { throw new Error('内部爆炸'); },
		);

		const context: AgentContext = { messages: [], tools: [exploding] };
		const { emit } = createCollector();

		const result = await runAgentLoop(
			[{ role: 'user', content: 'go' }],
			context,
			createConfig(),
			emit,
			undefined,
			createScriptedStreamFn((turn) =>
				turn === 0 ? toolTurn('call-1', 'boom', {}) : textTurn('恢复'),
			),
		);

		const toolResult = result.find((message) => message.role === 'toolResult') as ToolResultMessage;
		assert.ok(
			JSON.stringify(toolResult.content).includes('内部爆炸'),
			'异常信息应被捕获并放入结果',
		);
	});

	test('runAgentLoopContinue 拒绝从 assistant 消息续跑', async () => {
		const context: AgentContext = {
			messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }],
			tools: [],
		};
		const { emit } = createCollector();

		await assert.rejects(
			async () => {
				await runAgentLoopContinue(
					context,
					createConfig(),
					emit,
					undefined,
					createScriptedStreamFn(() => textTurn('x')),
				);
			},
			/无法从 assistant 消息续跑/,
		);
	});

	test('runAgentLoopContinue 拒绝空上下文', async () => {
		const context: AgentContext = { messages: [], tools: [] };
		const { emit } = createCollector();

		await assert.rejects(
			async () => {
				await runAgentLoopContinue(
					context,
					createConfig(),
					emit,
					undefined,
					createScriptedStreamFn(() => textTurn('x')),
				);
			},
			/上下文中没有任何消息/,
		);
	});
});

// ─── streamAdapter 行为 ──────────────────────────────────────────────────────

/** 极简的本仓 provider 桩件，用于验证适配层。 */
function createStubProvider(deltas: readonly unknown[]): unknown {
	return {
		id: 'stub',
		name: 'Stub',
		priority: 0,
		onDidChangeModels: () => ({ dispose: () => { /* noop */ } }),
		listModels: async () => [],
		onDidChangeAuthStatus: () => ({ dispose: () => { /* noop */ } }),
		getAuthStatus: () => 'ready',
		chat: async function* () {
			for (const delta of deltas) {
				yield delta;
			}
		},
	};
}

suite('piLoop — streamAdapter 契约', () => {

	test('本仓 IModelDelta 增量累积为 pi AssistantMessage', async () => {
		const provider = createStubProvider([
			{ type: 'text', content: '你好' },
			{ type: 'text', content: '，世界' },
			{ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
			{ type: 'done', finishReason: 'stop' },
		]);

		// 适配层只依赖 IModelProvider 的 chat 面，桩件结构性满足即可。
		const streamFn = createPiStreamFn(provider as never);
		const stream = await streamFn(TEST_MODEL, { messages: [{ role: 'user', content: 'hi' }] });

		const collected: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			collected.push(event);
		}

		const deltas = collected.filter((event) => event.type === 'text_delta');
		assert.strictEqual(deltas.length, 2, '应有两条文本增量');

		const finalMessage = await stream.result();
		const text = finalMessage.content
			.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
			.map((block) => block.text)
			.join('');
		assert.strictEqual(text, '你好，世界', '文本应完整累积');
		assert.strictEqual(finalMessage.stopReason, 'stop');
		assert.strictEqual(finalMessage.usage?.input, 10);
	});

	test('每个事件都携带完整 partial 快照', async () => {
		const provider = createStubProvider([
			{ type: 'text', content: 'A' },
			{ type: 'text', content: 'B' },
		]);

		const streamFn = createPiStreamFn(provider as never);
		const stream = await streamFn(TEST_MODEL, { messages: [{ role: 'user', content: 'hi' }] });

		const partials: string[] = [];
		for await (const event of stream) {
			if (event.type === 'text_delta') {
				partials.push(
					event.partial.content
						.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
						.map((block) => block.text)
						.join(''),
				);
			}
		}

		assert.deepStrictEqual(partials, ['A', 'AB'], 'partial 应是累积快照而非纯增量');
	});

	test('provider 抛错时编码为 error 事件，不向外抛', async () => {
		const failingProvider = {
			...createStubProvider([]) as Record<string, unknown>,
			chat: async function* () {
				throw new Error('网络中断');
			},
		};

		const streamFn = createPiStreamFn(failingProvider as never);
		const stream = await streamFn(TEST_MODEL, { messages: [{ role: 'user', content: 'hi' }] });

		const collected: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			collected.push(event);
		}

		const errorEvent = collected.find((event) => event.type === 'error');
		assert.ok(errorEvent, '应产出 error 事件');
		if (errorEvent && errorEvent.type === 'error') {
			assert.strictEqual(errorEvent.message.stopReason, 'error');
			assert.strictEqual(errorEvent.message.errorMessage, '网络中断');
		}
	});

	test('工具调用参数从 JSON 字符串解析为对象', async () => {
		const provider = createStubProvider([
			{ type: 'tool_call', toolCall: { id: 'c1', name: 'echo', arguments: '{"text":"hi"}' } },
			{ type: 'done', finishReason: 'tool_calls' },
		]);

		const streamFn = createPiStreamFn(provider as never);
		const stream = await streamFn(TEST_MODEL, { messages: [{ role: 'user', content: 'hi' }] });

		for await (const _event of stream) { /* 消费至结束 */ }
		const finalMessage = await stream.result();

		const toolCall = finalMessage.content.find((block) => block.type === 'toolCall');
		assert.ok(toolCall, '应解析出工具调用块');
		if (toolCall && toolCall.type === 'toolCall') {
			assert.deepStrictEqual(toolCall.arguments, { text: 'hi' });
		}
		assert.strictEqual(finalMessage.stopReason, 'toolUse');
	});

	test('convertToChatMessages 转换 transcript', () => {
		const converted = convertToChatMessages([
			{ role: 'user', content: '你好' },
			{ role: 'assistant', content: [{ type: 'text', text: '回复' }] },
		]);

		assert.strictEqual(converted.length, 2);
		assert.strictEqual(converted[0].role, 'user');
		assert.strictEqual(converted[0].content, '你好');
		assert.strictEqual(converted[1].role, 'assistant');
		assert.strictEqual(converted[1].content, '回复');
	});

	// ─── toolCallId 契约（2026-09-20 真机报文取证修复）─────────────────────
	// 事故：pi `toolResult` → 本仓 `tool` 转换漏传 toolCallId ⇒ LMBridge 的
	// sanitizeToolPairs 的 respondedIds 恒为空 ⇒ 每轮剥离 assistant 的 tool_calls；
	// 网关收到「tool_call_id 全空串的孤儿工具结果 + 无 tool_calls 的 assistant」
	// （日志 vscode-app-1789900477124 的 http-debug 末次请求实证：61 tool 全空 id）。
	test('★★★ toolResult → 必须携带 toolCallId（否则 sanitizeToolPairs 会全量剥离工具对）', () => {
		const converted = convertToChatMessages([
			{
				role: 'assistant',
				content: [{ type: 'toolCall', id: 'call_1', name: 'file_read', arguments: { path: 'a.ts' } }],
			} as never,
			{
				role: 'toolResult', toolCallId: 'call_1', toolName: 'file_read',
				content: [{ type: 'text', text: '文件内容' }], isError: false,
			} as never,
		]);

		const toolMsg = converted.find(m => m.role === 'tool');
		assert.ok(toolMsg, 'toolResult 应映射为 role=tool 消息');
		assert.strictEqual(toolMsg!.toolCallId, 'call_1',
			'tool 消息必须带 toolCallId（漏传 ⇒ 下游配对判定恒失败 ✗）');

		// 与下游 sanitizeToolPairs 串联验证：配对齐全 ⇒ 一条都不许被剥（本修复的真实回归信号）
		const sanitized = ContextManager.sanitizeToolPairs(converted as never[]);
		assert.strictEqual(sanitized.length, converted.length, '配对齐全时不得剥离任何消息 ✗');
		const asst = sanitized.find((m: never) => (m as { role?: string }).role === 'assistant') as
			{ toolCalls?: unknown[] } | undefined;
		assert.strictEqual(asst?.toolCalls?.length, 1, 'assistant 的 tool_calls 必须存活（此前每轮被剥空 ✗）');
	});

	test('★ toolResult（字符串 content 分支）同样携带 toolCallId', () => {
		const converted = convertToChatMessages([
			{ role: 'toolResult', toolCallId: 'call_9', toolName: 'x', content: '纯字符串结果', isError: false } as never,
		]);
		assert.strictEqual(converted[0].role, 'tool');
		assert.strictEqual(converted[0].toolCallId, 'call_9');
	});
});

// ─── toolAdapter 行为 ────────────────────────────────────────────────────────

suite('piLoop — toolAdapter 契约', () => {

	test('IToolDefinition 转为可执行的 AgentTool', async () => {
		const executed: string[] = [];
		const tool = toAgentTool(
			{ name: 'demo', description: '示例', inputSchema: { type: 'object', properties: {} } },
			async (toolCall) => {
				executed.push(toolCall.name);
				return { content: 'done' };
			},
		);

		assert.strictEqual(tool.name, 'demo');
		assert.strictEqual(tool.description, '示例');

		const result = await tool.execute('call-1', { a: 1 }, undefined, undefined);
		assert.deepStrictEqual(executed, ['demo']);
		assert.strictEqual(result.content[0].type, 'text');
	});

	test('isError 经 details 标记传递给 loop', async () => {
		const tool = toAgentTool(
			{ name: 'fail', description: '失败', inputSchema: { type: 'object' } },
			async () => ({ content: '出错了', isError: true }),
		);

		const result = await tool.execute('call-1', {}, undefined, undefined);
		assert.strictEqual((result.details as { isError?: boolean }).isError, true);
	});

	test('progress 回调转为 tool_execution_update 事件', async () => {
		const context: AgentContext = { messages: [], tools: [] };
		const { events, emit } = createCollector();

		const tool = toAgentTool(
			{ name: 'slow', description: '慢', inputSchema: { type: 'object' } },
			async (_toolCall, _signal, onProgress) => {
				onProgress?.('进行中 50%');
				return { content: 'ok' };
			},
		);
		context.tools = [tool];

		await runAgentLoop(
			[{ role: 'user', content: 'go' }],
			context,
			createConfig(),
			emit,
			undefined,
			createScriptedStreamFn((turn) =>
				turn === 0 ? toolTurn('call-1', 'slow', {}) : textTurn('done'),
			),
		);

		const updates = events.filter((event) => event.type === 'tool_execution_update');
		assert.strictEqual(updates.length, 1, '应透传一次进度更新');
	});

	test('toAgentTools 批量转换', () => {
		const tools = toAgentTools(
			[
				{ name: 'a', description: 'A', inputSchema: { type: 'object' } },
				{ name: 'b', description: 'B', inputSchema: { type: 'object' } },
			],
			async () => ({ content: 'ok' }),
		);

		assert.strictEqual(tools.length, 2);
		assert.deepStrictEqual(tools.map((tool) => tool.name), ['a', 'b']);
	});
});
