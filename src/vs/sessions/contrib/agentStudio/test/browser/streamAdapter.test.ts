/*---------------------------------------------------------------------------------------------
 *  streamAdapter 专属套件 —— pi 流契约 ⟷ 本仓 IModelDelta 的双向适配
 *
 *  背景（2026-09-20）：`browser/piLoop/streamAdapter.ts`（506 行）是 pi 内核落地本项目的
 *  **核心改造点**（两边的流式契约形状不同），此前只被 `piLoop.test.ts` 的 2-3 例浅覆盖。
 *  它是迁移面上的「翻译层」：翻译错了上游测不出来（mock streamFn 绕过它），真机才炸。
 *
 *  覆盖（每条都对应一个真实踩过的坑或契约铁律）：
 *    A. 报文方向：IModelDelta → pi 事件（text/thinking 合并、tool_call 解析、usage、finish 映射）
 *    B. 契约铁律：StreamFn **不得抛错**（失败编码为 error 事件；中止与错误分开映射）
 *    C. 流语义：每事件携带 partial 快照 / 晚订阅仍可取全 / result() 永不 reject
 *    D. 请求方向：TranscriptContext → IChatMessage[]（toolCallId、thinking 并入文本、派生标记）
 *    E. 选项合并：tools 透传（唯一通道）、temperature/maxTokens/thinkingLevel/toolChoice
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { createPiStreamFn, convertToChatMessages } from '../../browser/piLoop/streamAdapter.js';
import { isChatMessagesDerived } from '../../common/providers.js';
import type { IChatMessage, IModelDelta, IModelOptions } from '../../common/providers.js';
import type {
	AgentTool,
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
} from '../../browser/piLoop/types.js';

const TEST_MODEL: Model = { provider: 'test', id: 'test-model', api: 'test' };

/** 捕获 provider.chat 收到的实参，供「请求方向」用例断言。 */
interface Captured {
	modelId?: string;
	messages?: IChatMessage[];
	options?: IModelOptions;
}

/**
 * 造一个只实现 `chat` 面的 provider 桩。
 *
 * 适配层只依赖 `IModelProvider.chat`，故结构性满足即可（与 piLoop.test.ts 同法）。
 * 每次调用返回**新的**生成器 ⇒ 同一 provider 可被多条用例复用。
 */
function createStubProvider(deltas: readonly IModelDelta[], captured?: Captured): never {
	return {
		id: 'stub',
		name: 'Stub Provider',
		priority: 0,
		chat: (modelId: string, messages: IChatMessage[], options: IModelOptions) => {
			if (captured) {
				captured.modelId = modelId;
				captured.messages = messages;
				captured.options = options;
			}
			return (async function* () {
				for (const delta of deltas) {
					yield delta;
				}
			})();
		},
	} as never;
}

/** 带单个抛错点的 provider 桩：进入生成器即抛（模拟鉴权/网络失败）。 */
function createThrowingProvider(error: unknown, captured?: Captured): never {
	return {
		id: 'stub-throwing',
		name: 'Stub Throwing Provider',
		priority: 0,
		chat: () => (async function* () {
			throw error;
		})(),
	} as never;
}

/** 跑完一条流，返回事件序列与终值。 */
async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<{
	events: AssistantMessageEvent[];
	final: AssistantMessage;
}> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	const final = await (stream as { result(): Promise<AssistantMessage> }).result();
	return { events, final };
}

/** 取助手消息里的文本（合并所有 text 块）。 */
function textOf(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
		.map((block) => block.text)
		.join('');
}

/** 取助手消息里的 thinking 文本。 */
function thinkingOf(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: 'thinking'; thinking: string } => block.type === 'thinking')
		.map((block) => block.thinking)
		.join('');
}

suite('streamAdapter — 报文方向（IModelDelta → pi 事件）', () => {

	test('start 事件先于一切，partial 是空助手消息（含 model 标识与零 usage）', async () => {
		const stream = createPiStreamFn(createStubProvider([{ type: 'text', content: 'x' }]))(
			TEST_MODEL, { messages: [] },
		);
		const { events } = await drain(stream);

		assert.strictEqual(events[0].type, 'start', '首个事件必须是 start');
		const partial = (events[0] as { partial: AssistantMessage }).partial;
		assert.deepStrictEqual(partial.content, [], 'start 时内容为空');
		assert.strictEqual(partial.model, 'test/test-model', 'model 标识为 provider/id');
		assert.deepStrictEqual(partial.usage, { input: 0, output: 0 });
	});

	test('空串文本增量不产生内容块，但仍发事件（消费者需能感知节拍）', async () => {
		const stream = createPiStreamFn(createStubProvider([
			{ type: 'text', content: 'A' },
			{ type: 'text', content: '' },
			{ type: 'text', content: 'B' },
		]))(TEST_MODEL, { messages: [] });
		const { events, final } = await drain(stream);

		assert.strictEqual(textOf(final), 'AB', '空块不得污染正文');
		assert.strictEqual(final.content.length, 1, '相邻文本块应合并为一块');
		assert.strictEqual(events.filter((e) => e.type === 'text_delta').length, 3, '三条增量各发一个事件');
	});

	test('text / thinking 各自独立成块，交错时保持顺序（text → thinking → text）', async () => {
		const stream = createPiStreamFn(createStubProvider([
			{ type: 'text', content: '前' },
			{ type: 'thinking', content: '想' },
			{ type: 'text', content: '后' },
		]))(TEST_MODEL, { messages: [] });
		const { final } = await drain(stream);

		assert.deepStrictEqual(
			final.content.map((block) => block.type),
			['text', 'thinking', 'text'],
			'交错时必须分块而非合并',
		);
		assert.strictEqual(textOf(final), '前后');
		assert.strictEqual(thinkingOf(final), '想');
	});

	test('tool_call：arguments 由 JSON 字符串解析为对象；同 id 二次出现是更新而非新增', async () => {
		const stream = createPiStreamFn(createStubProvider([
			{ type: 'tool_call', toolCall: { id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' } },
			{ type: 'tool_call', toolCall: { id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts","offset":5}' } },
			{ type: 'tool_call', toolCall: { id: 'call-2', name: 'search_files', arguments: '{"pattern":"x"}' } },
		]))(TEST_MODEL, { messages: [] });
		const { events, final } = await drain(stream);

		const toolCalls = final.content.filter(
			(block): block is { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> } =>
				block.type === 'toolCall',
		);
		assert.strictEqual(toolCalls.length, 2, '同 id 必须 upsert，不得重复入块');
		assert.deepStrictEqual(toolCalls[0].arguments, { path: 'a.ts', offset: 5 }, '同 id 以最后一次为准');
		assert.deepStrictEqual(toolCalls[1].arguments, { pattern: 'x' });
		assert.strictEqual(
			events.filter((e) => e.type === 'toolcall_delta').length, 3,
			'每次 tool_call 增量都应发事件',
		);
	});

	test('tool_call：坏 JSON / 非对象 / 空串一律降级为 {}（不崩流）', async () => {
		const stream = createPiStreamFn(createStubProvider([
			{ type: 'tool_call', toolCall: { id: 'c1', name: 't', arguments: '{不是 json' } },
			{ type: 'tool_call', toolCall: { id: 'c2', name: 't', arguments: '[1,2]' } },
			{ type: 'tool_call', toolCall: { id: 'c3', name: 't', arguments: '' } },
		]))(TEST_MODEL, { messages: [] });
		const { final } = await drain(stream);

		const toolCalls = final.content.filter((b): b is { type: 'toolCall'; arguments: unknown } => b.type === 'toolCall');
		assert.strictEqual(toolCalls.length, 3);
		for (const call of toolCalls) {
			assert.deepStrictEqual(call.arguments, {}, '降级为空对象，交给下游参数校验报错');
		}
	});

	test('usage：inputTokens/outputTokens/cachedTokens → input/output/cacheRead', async () => {
		const stream = createPiStreamFn(createStubProvider([
			{ type: 'usage', usage: { inputTokens: 120, outputTokens: 34, cachedTokens: 88 } },
		]))(TEST_MODEL, { messages: [] });
		const { final } = await drain(stream);

		assert.deepStrictEqual(final.usage, { input: 120, output: 34, cacheRead: 88 });
	});

	test('usage：字段缺失时补 0（不得出现 undefined，下游按数值累加）', async () => {
		const stream = createPiStreamFn(createStubProvider([{ type: 'usage', usage: {} }]))(
			TEST_MODEL, { messages: [] },
		);
		const { final } = await drain(stream);

		assert.strictEqual(final.usage?.input, 0);
		assert.strictEqual(final.usage?.output, 0);
	});

	test('done：finishReason → stopReason 映射矩阵（含截断与工具两类特例）', async () => {
		const cases: Array<[string | undefined, string]> = [
			['length', 'length'],
			['max_tokens', 'length'],
			['tool_calls', 'toolUse'],
			['tool_use', 'toolUse'],
			['error', 'error'],
			['stop', 'stop'],
			['end_turn', 'stop'],
			['content_filter', 'stop'],
			[undefined, 'stop'],
		];

		for (const [finishReason, expected] of cases) {
			const stream = createPiStreamFn(createStubProvider([
				finishReason === undefined ? { type: 'done' } : { type: 'done', finishReason },
			]))(TEST_MODEL, { messages: [] });
			const { final } = await drain(stream);
			assert.strictEqual(final.stopReason, expected, `finishReason=${finishReason} 应映射为 ${expected}`);
		}
	});

	test('缺 done 事件时收尾默认 stopReason=stop（流自然结束不等于异常）', async () => {
		const stream = createPiStreamFn(createStubProvider([{ type: 'text', content: 'hi' }]))(
			TEST_MODEL, { messages: [] },
		);
		const { final } = await drain(stream);

		assert.strictEqual(final.stopReason, 'stop');
		assert.strictEqual(textOf(final), 'hi');
	});

	test('error 增量：stopReason=error + errorMessage；缺省文案兜底', async () => {
		const withMessage = await drain(createPiStreamFn(createStubProvider([
			{ type: 'error', error: '上游 429' },
		]))(TEST_MODEL, { messages: [] }));
		assert.strictEqual(withMessage.final.stopReason, 'error');
		assert.strictEqual(withMessage.final.errorMessage, '上游 429');

		const withoutMessage = await drain(createPiStreamFn(createStubProvider([{ type: 'error' }]))(
			TEST_MODEL, { messages: [] },
		));
		assert.strictEqual(withoutMessage.final.errorMessage, '模型返回未知错误');
	});

	test('tool_progress 不透传（pi 事件面无对应项，仅供 UI/idle）', async () => {
		const stream = createPiStreamFn(createStubProvider([
			{ type: 'tool_progress', toolName: 'file_write', bytes: 512, partialArgs: '{"path"' },
			{ type: 'text', content: 'ok' },
		]))(TEST_MODEL, { messages: [] });
		const { events } = await drain(stream);

		assert.strictEqual(
			events.filter((e) => e.type === 'toolcall_delta').length, 0,
			'tool_progress 不得被误当作 tool_call 事件',
		);
		assert.strictEqual(events.filter((e) => e.type === 'text_delta').length, 1);
	});
});

suite('streamAdapter — 契约铁律与流语义', () => {

	test('provider 抛普通错误 → 不向外抛，编码为 error 事件且 result() 仍可取值', async () => {
		const stream = createPiStreamFn(createThrowingProvider(new Error('网络中断')))(TEST_MODEL, { messages: [] });
		const { events, final } = await drain(stream);

		assert.strictEqual(events.filter((e) => e.type === 'error').length, 1, '必须有一条 error 事件');
		assert.strictEqual(final.stopReason, 'error');
		assert.strictEqual(final.errorMessage, '网络中断', '原始错误信息应保留给上层');
	});

	test('AbortError → stopReason=aborted（与真错误分开，供上层区分用户取消）', async () => {
		const abortError = new Error('aborted by user');
		abortError.name = 'AbortError';
		const stream = createPiStreamFn(createThrowingProvider(abortError))(TEST_MODEL, { messages: [] });
		const { final } = await drain(stream);

		assert.strictEqual(final.stopReason, 'aborted');
		assert.strictEqual(final.errorMessage, '请求已被取消');
	});

	test('signal 已中止时，即便错误不是 AbortError 也判定为 aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const stream = createPiStreamFn(createThrowingProvider(new Error('别的东西炸了')))(TEST_MODEL, {
			messages: [],
		}, { signal: controller.signal });
		const { final } = await drain(stream);

		assert.strictEqual(final.stopReason, 'aborted', 'signal 是权威判据');
	});

	test('生产者同步抛出（不是流内异步抛）也不会逃逸为未捕获异常', async () => {
		const stream = createPiStreamFn(createThrowingProvider(new Error('同步炸')))(TEST_MODEL, { messages: [] });
		const { events, final } = await drain(stream);

		assert.ok(events.some((e) => e.type === 'error'));
		assert.strictEqual(final.errorMessage, '同步炸');
	});

	test('晚订阅仍可取到全部事件（缓冲语义：for await 在生产者结束后才开始）', async () => {
		const stream = createPiStreamFn(createStubProvider([
			{ type: 'text', content: '1' },
			{ type: 'text', content: '2' },
			{ type: 'done', finishReason: 'stop' },
		]))(TEST_MODEL, { messages: [] });

		// 先等生产者跑完（result() 会 await 到终态），此时事件早已全部推送完毕。
		const settled = await stream.result();
		assert.strictEqual(settled.stopReason, 'stop');

		const late: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			late.push(event);
		}
		assert.strictEqual(late.filter((e) => e.type === 'text_delta').length, 2, '晚订阅不得丢事件');
	});

	test('partial 是累积快照：thinking 与 text 交错时快照逐事件增长', async () => {
		const stream = createPiStreamFn(createStubProvider([
			{ type: 'text', content: 'A' },
			{ type: 'thinking', content: 'B' },
			{ type: 'text', content: 'C' },
		]))(TEST_MODEL, { messages: [] });
		const { events } = await drain(stream);

		const snapshots = events
			.filter((event) => 'partial' in event)
			.map((event) => {
				const partial = (event as { partial: AssistantMessage }).partial;
				return `${textOf(partial)}|${thinkingOf(partial)}`;
			});
		assert.deepStrictEqual(snapshots, ['|', 'A|', 'A|B', 'AC|B'], 'start 快照为空，其后逐事件累积');
	});
});

suite('streamAdapter — 请求方向与选项合并', () => {

	test('convertToChatMessages：toolResult → role=tool 且携带 toolCallId（丢失会致 400）', () => {
		const messages = convertToChatMessages([
			{
				role: 'toolResult',
				toolCallId: 'call-9',
				toolName: 'read_file',
				isError: false,
				content: [{ type: 'text', text: '文件内容' }],
			},
		] as unknown as Message[]);

		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].role, 'tool');
		assert.strictEqual(messages[0].toolCallId, 'call-9', '缺失该字段会致严格网关拒绝');
		assert.strictEqual(messages[0].content, '文件内容');
	});

	test('convertToChatMessages：assistant 的 thinking 并入文本、toolCall 序列化为 JSON 字符串', () => {
		const messages = convertToChatMessages([
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: '结论' },
					{ type: 'thinking', thinking: '思路' },
					{ type: 'toolCall', id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } },
				],
			},
		] as unknown as Message[]);

		assert.strictEqual(messages[0].content, '结论思路', 'thinking 必须让模型看见（并入文本）');
		assert.deepStrictEqual(messages[0].toolCalls, [
			{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
		], '本仓 toolCalls.arguments 是 JSON 字符串');
	});

	test('convertToChatMessages 的产物被标记为「派生副本」（供 LMBridge 跳过无效回写）', () => {
		const messages = convertToChatMessages([{ role: 'user', content: 'hi' }] as unknown as Message[]);

		assert.strictEqual(isChatMessagesDerived(messages), true, '必须打标，否则 guardian 回写会污染内核 transcript');
	});

	test('context.tools 作为唯一通道送达 options.tools（缺失时模型自称无法访问文件系统）', async () => {
		const captured: Captured = {};
		const tool = {
			name: 'read_file',
			description: '读文件',
			inputSchema: { type: 'object', properties: {} },
			execute: async () => ({}),
		} as unknown as AgentTool;
		const stream = createPiStreamFn(createStubProvider([{ type: 'text', content: 'x' }], captured))(
			TEST_MODEL,
			{ messages: [], tools: [tool] },
		);
		await drain(stream);

		const tools = (captured.options as Record<string, unknown>)['tools'] as Array<Record<string, unknown>>;
		assert.strictEqual(tools.length, 1);
		assert.strictEqual(tools[0].name, 'read_file');
		assert.deepStrictEqual(tools[0].inputSchema, { type: 'object', properties: {} });
	});

	test('context.tools 为空时不设置 options.tools（避免把空数组当"无工具"下发）', async () => {
		const captured: Captured = {};
		await drain(createPiStreamFn(createStubProvider([{ type: 'text', content: 'x' }], captured))(
			TEST_MODEL, { messages: [], tools: [] },
		));

		assert.strictEqual((captured.options as Record<string, unknown>)['tools'], undefined);
	});

	test('streamOptions 覆盖 base 选项：temperature / maxTokens / thinkingLevel→reasoningEffort / toolChoice', async () => {
		const captured: Captured = {};
		await drain(createPiStreamFn(
			createStubProvider([{ type: 'text', content: 'x' }], captured),
			{ modelId: 'pinned-model', modelOptions: { temperature: 0.1, maxTokens: 111 } },
		)(TEST_MODEL, { messages: [] }, {
			temperature: 0.9,
			maxTokens: 222,
			thinkingLevel: 'high',
			toolChoice: 'none',
		}));

		const options = captured.options as Record<string, unknown>;
		assert.strictEqual(captured.modelId, 'pinned-model', 'options.modelId 优先于 model.id');
		assert.strictEqual(options.temperature, 0.9, 'streamOptions 优先');
		assert.strictEqual(options.maxTokens, 222);
		assert.strictEqual(options.reasoningEffort, 'high', 'thinkingLevel 映射到 reasoningEffort');
		assert.strictEqual(options.toolChoice, 'none', '撞顶收尾轮的禁工具语义依赖它');
	});

	test('modelId 缺省时回落到 model.id', async () => {
		const captured: Captured = {};
		await drain(createPiStreamFn(createStubProvider([{ type: 'text', content: 'x' }], captured))(
			TEST_MODEL, { messages: [] },
		));

		assert.strictEqual(captured.modelId, 'test-model');
	});
});
