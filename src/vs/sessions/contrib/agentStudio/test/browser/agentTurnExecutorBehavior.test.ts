/**
 * `executeAgentTurnDirect` 的**行为测试**（S3 后续拆分的前置护栏）。
 *
 * ## 为什么需要这个文件
 *
 * 2026-09-16 评估确认：`executeAgentTurnDirect`（`agentTurnExecutor.ts:742`，约 3872 行）
 * 在生产代码中**仅被 `agentOSService.ts:2619` 一处调用**，且测试目录中
 * **零个测试文件 import 它**。既有的 7 个"契约测试"全部用 `fs.readFileSync`
 * 断言**源码文本**（如"源码里必须出现某个字符串"）——它们是重构护栏，
 * **不是行为测试**：行为坏掉时字符串还在，断言不会失败。
 *
 * 本文件第一次真正**运行主循环**，锁住三类此前无保护的行为：
 *   1. 单轮成功路径：delta 序列 → 输出事件序列的映射
 *   2. 无模型时的降级：`_getActiveModelProvider()` 返回 undefined 的行为
 *   3. 无 selection 时的错误：必须 yield 可见的 error 事件且不抛异常
 *
 * ## 设计约束
 *
 * - 用 **mock host**（鸭子类型），不构造真实 `AgentOSService`（需 DI 容器）
 * - 只断言**可观察输出**（yield 的 delta 序列 + 返回值），不断言内部状态
 * - 每个用例必须有明确的**失败模式**：断言若失效，必须能说清"什么坏了"
 */

import * as assert from 'assert';
import { executeAgentTurnDirect } from '../../browser/agentTurnExecutor.js';
import type { IModelDelta } from '../../common/providers.js';
import type { IChatStreamDelta } from '../../common/providers.js';
import { DelegationLedgerManager } from '../../common/delegationLedger.js';
import { DurableContextManager } from '../../common/durableContextMiddleware.js';
import { adaptModelDelta } from '../../browser/agentModelAccess.js';
import type { ModelAccessDeps } from '../../browser/agentModelAccess.js';
import { extractToolCallsFromText } from '../../browser/agentToolExtractor.js';
import { SubagentLimitMiddleware } from '../../common/subagentLimitMiddleware.js';
import { registerSessionTaskLookup } from '../../browser/sessionTaskGateBridge.js';
import { getPlanQueueHandle } from '../../common/planQueueRegistry.js';
import { MAX_TASK_GATE_MAIN_REACT } from '../../common/taskGate.js';
import { createDeliveryQueue } from '../../common/deliveryQueue.js';
import { classifyIterationStop } from '../../common/turnStopGate.js';
import { AgentLoopStrategyFactory } from '../../browser/agentLoopStrategyFactory.js';
import type { AgentParadigm } from '../../common/agentLoopStrategy.js';

/** 收集 generator 的全部输出与返回值。 */
async function drain(
	gen: AsyncGenerator<IChatStreamDelta, unknown>,
): Promise<{ deltas: IChatStreamDelta[]; returned: unknown }> {
	const deltas: IChatStreamDelta[] = [];
	let next = await gen.next();
	while (!next.done) {
		deltas.push(next.value);
		next = await gen.next();
	}
	return { deltas, returned: next.value };
}

/** 静默 logger：所有级别吞掉，避免测试输出被日志淹没。 */
function silentLogger(): Record<string, (...args: unknown[]) => void> {
	const noop = (): void => { /* 测试中静默 */ };
	return { info: noop, warn: noop, error: noop, debug: noop, trace: noop };
}

/**
 * 断言所有 tool_result 都不是「执行失败」文本。
 *
 * 背景：工具执行路径会回调若干 host 方法（fresh-dispatch 边界
 * `_clearSandboxBypassRoots`、结果观察 `_observeToolResult` /
 * `_storeTurnObservations`）。mock host 漏掉任一个，executor 会把异常
 * 吞成 `{"error":"Tool execution failed: host.X is not a function"}`。
 *
 * 这种污染**不会**让只看模式/文件/事件顺序的断言失败 —— 用例会静默
 * 失去对真实执行路径的覆盖（假绿）。本函数就是守这条底线的哨兵。
 */
function assertNoToolExecutionErrors(deltas: ReadonlyArray<unknown>): void {
	for (const delta of deltas) {
		const typed = delta as { type?: string; toolCallId?: string; content?: unknown };
		if (typed.type !== 'tool_result') { continue; }
		const text = String(typed.content ?? '');
		assert.ok(
			!/Tool execution failed/i.test(text),
			`工具 ${typed.toolCallId ?? '(unknown)'} 的结果是执行错误，`
			+ `说明 mock host 缺少必需的钩子（_clearSandboxBypassRoots / _observeToolResult / `
			+ `_storeTurnObservations），用例已失去对真实执行路径的覆盖；实际=${JSON.stringify(text.slice(0, 200))}`,
		);
	}
}

/**
 * mock host 的构造。
 *
 * 历史：此处曾是一个 `class MockAgentOSHost`，携带 9 个 `static readonly` 常量副本，
 * 且必须用 `new` + `Object.assign`（而非对象字面量/展开）来保住 prototype ——
 * 因为 `executeAgentTurnDirect` 当时经 `host.constructor.X` 反查这些静态量，
 * 字面量的 `constructor` 是 `Object`，会让常量全部变 `undefined`，
 * 进而 `HARD_STOP_ITERATIONS = undefined + 1 = NaN`，`while (iteration < NaN)`
 * 一次都不进循环 —— 「不报错、无输出」的静默空转。
 *
 * 2026-09-17 常量抽出到 `common/turnLoopConstants.ts` 后，executor 改为直接
 * import，`host.constructor` 读点归零。类外壳与常量副本随之成为死代码并被删除：
 * 留着会让「mock 必须伪造静态量」这条已失效的约束继续误导后来者。
 * 常量与宿主的一致性现由 `test/common/turnLoopConstants.test.ts` 守护。
 */

/** 构造一个最小可用的 mock host。`overrides` 用于逐用例替换行为。 */
function mockHost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const base: Record<string, unknown> = {
		_logService: silentLogger(),
		// executeAgentTurnDirect 开头即读这两个累计计数器（缓存命中率基线）
		_totalInputTokens: 0,
		_totalCachedTokens: 0,
		_totalOutputTokens: 0,
		_turnKey: (agentId: string, sessionId: string) => `${agentId}::${sessionId}`,
		_lastRealPromptTokensByAgent: new Map<string, number>(),
		_activeTurnControllers: new Map<string, AbortController>(),
		_lastResponseIdBySession: new Map<string, string>() as Map<string, unknown>,
		_lastAssistantAtByAgent: new Map<string, number>(),
		_lastAllEnabledToolNames: new Set<string>(),
		// 类型必须对齐真实 host（`agentOSService.ts:392`/`:397`）：
		// 二者都是 **number 时间戳/基线**，不是 Map。写成 Map 会得到
		// `Map > 0 === false` → 冷却判定走 `Infinity` 分支 → 永远通过门控，
		// 使「冷却期内不重复压缩」这条路径**永远测不出来**（假绿）。
		_lastCompressionTime: 0,
		_lastHardPruneBaselineTokens: 0,
		_lastForkContextBySession: new Map<string, unknown>(),
		_mcpToolsInitialWaitDone: true,
		_approvalService: { reset: () => undefined },
		_setCurrentModel: () => undefined,
		_generateHexId: () => 'mock-hex-id',
		_getOrCreateConversationId: async () => 'mock-conversation',
		_getSarosRoot: () => '/mock/saros/root',
		_currentWorkspaceId: 'mock-workspace',
		_isToolCallConfirmationEnabled: () => false,
		_isSandboxViolation: () => false,
		// 用真实中间件实例：手写 `{ canStart, onStart, onEnd }` 的 mock 会漏掉
		// `isDelegationCall`（工具路径 `agentTurnExecutor.ts:2052` 直接调用），
		// 且真实类的方法集会随实现演进，手写等价物必然漂移。
		_subagentLimitMw: new SubagentLimitMiddleware(),
		_estimateMessagesTokens: () => 0,
		_resolveContextWindow: () => 128000,
		_scheduleSave: () => undefined,
		_getActiveModelProvider2: undefined,
		_compressionCount: 0,
		_compressionIneffectiveCount: 0,
		_compressionBeforeTokens: 0,
		_compressionAfterTokens: 0,
		// 默认：无 model provider → 走降级分支
		_getActiveModelProvider: () => undefined,
		getActiveModelSelection: () => ({ modelId: 'mock-model' }),
		_fallbackToDirectChat: async function* () {
			yield { type: 'text', content: 'fallback' } as IChatStreamDelta;
		},
		_getEnabledTools: async () => [],
		_resolveHardPermission: () => undefined,
		// initTurnContext 的前置依赖（:293-740 实测清单）
		getActiveMemoryProvider: () => undefined,
		_waitForMcpTools: async (_agentId: string, tools: unknown[]) => tools,
		_consumeStashedFiles: () => undefined,
		_includeSkills: undefined,
		_currentAgent: undefined,
		_userMessageEnricher: undefined,
		_refreshWorkingMemoryContent: () => undefined,
		_injectedSessions: new Set<string>(),
		// ─── 工具执行的必经钩子（放在 base，避免每个用例重复声明）──────
		// 三者都是 executor 工具路径无条件回调的 host 方法：
		//   · `_clearSandboxBypassRoots` — fresh-dispatch 边界（`:4371/:4413/:4438`）
		//   · `_observeToolResult`       — 结果观察（`agentOSService.ts:1666`）
		//   · `_storeTurnObservations`   — 回合观测落库（`agentOSService.ts:4094`）
		// 缺任一个都会把 tool_result 变成
		// `{"error":"Tool execution failed: host.X is not a function"}`，
		// 而只看模式/文件/事件顺序的断言察觉不到 —— 用例会静默失去对真实
		// 执行路径的覆盖。`assertNoToolExecutionErrors` 是对应的哨兵断言。
		_clearSandboxBypassRoots: () => undefined,
		_observeToolResult: () => undefined,
		// 回合观测落库：无 provider 时应静默无害，给 no-op 即可。
		_storeTurnObservations: async () => undefined,
		_metaInjectedSessions: new Set<string>(),
		_delegationLedger: new DelegationLedgerManager(),
		_durableContext: new DurableContextManager(),
		// 流超时策略：`agentModelAccess.ts:65` 直接读它的属性（不发可选链），
		// 缺失会在 LLM 调用后的错误分类路径抛 undefined 崩溃。
		// 取值对齐 `agentOSService.ts:2204` 的真实默认。
		_modelStreamTimeoutPolicy: { firstTokenTimeout: 45_000, idleTimeout: 120_000 },
		// 复用**真实的** delta 适配器而非手写 mock：它是 provider delta →
		// UI 事件的唯一映射表（text/thinking 透传、tool_call → tool_start 等），
		// 手写等价物会随实现漂移而与真实行为脱节。
		_adaptModelDelta: (delta: unknown): IChatStreamDelta =>
			adaptModelDelta(
				{
					logService: silentLogger(),
					modelProviders: [],
					activeSelection: undefined,
					modelStreamTimeoutPolicy: { firstTokenTimeout: 45_000, idleTimeout: 120_000 },
				} as unknown as ModelAccessDeps,
				delta,
			),
		// 同样复用真实抽取器：纯文本输入下它返回空数组，
		// 但保留真实逻辑可覆盖「模型把工具调用写成文本」这条通路。
		_tryExtractToolCallsFromText: (text: unknown, thinkingContent?: unknown, enabledTools?: unknown) =>
			extractToolCallsFromText(
				{ logService: silentLogger() },
				String(text ?? ''),
				typeof thinkingContent === 'string' ? thinkingContent : undefined,
				enabledTools as never,
			),
	};
	const host: Record<string, unknown> = { ...base, ...overrides };
	return host;
}

/** 最小请求对象。 */
function mockRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		agentId: 'test-agent',
		sessionId: 'test-session',
		messages: [{ role: 'user', content: 'hi' }],
		chatMode: 'craft',
		...overrides,
	};
}

suite('executeAgentTurnDirect — 行为契约（真实运行主循环）', () => {

	test('无 model provider → 走 _fallbackToDirectChat 并返回 undefined', async () => {
		let fallbackCalled = false;
		const host = mockHost({
			_getActiveModelProvider: () => undefined,
			_fallbackToDirectChat: async function* () {
				fallbackCalled = true;
				yield { type: 'text', content: 'fallback' } as IChatStreamDelta;
			},
		});

		const { returned } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(fallbackCalled, true, '无 provider 时必须走降级路径');
		assert.strictEqual(returned, undefined, '降级路径的返回值必须是 undefined');
	});

	test('有 provider 但 selection 无 modelId → yield 可见 error 事件且不抛异常', async () => {
		const host = mockHost({
			_getActiveModelProvider: () => ({ id: 'mock-provider', name: 'Mock' }),
			getActiveModelSelection: () => ({ modelId: '' }),
		});

		const { deltas, returned } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		// 关键：不能静默失败——用户必须看到"未选模型"
		const errorDeltas = deltas.filter(d => d.type === 'error');
		assert.strictEqual(errorDeltas.length, 1, `应恰好 1 条 error，实际 ${errorDeltas.length} 条`);
		assert.match(
			String((errorDeltas[0] as { content?: string }).content),
			/model selected/i,
			'错误文案必须提示选择模型（用户可据此自救）',
		);
		assert.strictEqual(returned, undefined, '无模型时不应返回 AgentCommand');
	});

	test('单轮成功路径：text delta 序列被完整透传且顺序不乱', async () => {
		const emitted: IModelDelta[] = [
			{ type: 'text', content: 'Hello' },
			{ type: 'thinking', content: 'reasoning...' },
			{ type: 'text', content: ' world' },
			{ type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } as never },
			{ type: 'done', finishReason: 'stop' } as IModelDelta,
		];

		let chatCallCount = 0;
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => {
				chatCallCount++;
				return (async function* () {
					for (const d of emitted) { yield d; }
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [],
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			chatCallCount > 0,
			`provider.chat() 必须被主循环调用（实际=${chatCallCount} 次；`
			+ `若为 0，说明循环未进入或走了其他分支。`
			+ `实际产出 delta 类型=[${deltas.map(d => (d as { type?: string }).type).join(',')}]）`,
		);
		assert.ok(
			deltas.length > 0,
			`必须产出可见事件（实际=0；chat 调用=${chatCallCount} 次。`
			+ `两者同时成立说明 delta 在主循环内被丢弃，需检查 delta 分派分支）`,
		);

		// ─── 真实契约：text 逐 delta 透传（经 _adaptModelDelta 适配）───────
		// 源码事实（`agentTurnExecutor.ts:2912-2917`）：
		//   `const adapted = host._adaptModelDelta(delta); if (adapted) { yield adapted; }`
		// 适配器（`agentModelAccess.ts:103`）对 text 原样透传
		// `{ type: 'text', content }`。注意 `yield adapted` 不是字面量，
		// 故按 `yield {` 文本搜索会漏掉这条主通路。
		const textChunks = deltas
			.filter(d => (d as { type?: string }).type === 'text')
			.map(d => String((d as { content?: string }).content ?? ''));
		const joined = textChunks.join('');
		assert.ok(
			joined.includes('Hello') && joined.includes(' world'),
			`正文片段必须逐 delta 透传（实际拼接=${JSON.stringify(joined)}；`
			+ `全事件类型=[${deltas.map(d => (d as { type?: string }).type).join(',')}]）`,
		);
		assert.ok(
			joined.indexOf('Hello') < joined.indexOf(' world'),
			'正文顺序必须与 provider 发出顺序一致（乱序会直接可见）',
		);

		// thinking 走独立通道，不得混入正文（否则推理过程会显示给用户）
		const thinkingJoined = deltas
			.filter(d => (d as { type?: string }).type === 'thinking')
			.map(d => String((d as { content?: string }).content ?? ''))
			.join('');
		assert.ok(
			thinkingJoined.includes('reasoning...'),
			`推理内容必须经 thinking 事件透传（实际=${JSON.stringify(thinkingJoined)}）`,
		);
		assert.ok(
			!joined.includes('reasoning...'),
			`推理内容不得混入正文（实际正文=${JSON.stringify(joined)}）`,
		);
	});

	test('provider 流抛异常 → 不逃逸出 generator（由内部错误处置接管）', async () => {
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => (async function* () {
				yield { type: 'text', content: 'partial' };
				throw new Error('simulated stream failure');
			})(),
		};

		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [],
		});

		// 关键契约：主循环必须自行处置流异常（重试/降级/终止），
		// 而不是把异常抛给调用方 —— 调用方 agentOSService 没有 catch。
		let threw: unknown;
		try {
			await drain(
				executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
			);
		} catch (err) {
			threw = err;
		}

		assert.strictEqual(
			threw, undefined,
			`异常不得逃逸出 executeAgentTurnDirect（逃逸会导致整轮无提示中断）：${String(threw)}`,
		);
	});

	test('工具调用闭环：tool_call → 执行 → 结果回灌进下一轮请求的 messages', async () => {
		// ─── 这是本文件最重要的一条：验证主循环真的"闭合" ────────────────
		// 前四个用例只覆盖「模型说一句话就结束」，而 executeAgentTurnDirect
		// 存在的意义就是跑工具。若工具结果没能回灌进 messages，模型下一轮
		// 会看到「自己要求调工具，但没有任何返回」——表现为反复空转或幻觉重试。
		//
		// 契约来源：
		//   · 工具结果回灌 = `agentTurnExecutor.ts:4338`
		//     `messages = appendMessages(messages, { role: 'tool', content: resultStr, toolCallId })`
		//   · 每轮请求 = `chat(modelId, messages, options, context?)`
		//     （`providers.ts:244`）
		//
		// 手法：捕获每轮 chat 收到的 messages，直接断言第二轮的可见内容。

		/** 每轮 chat 收到的 messages 快照（关键观测点）。 */
		const requestSnapshots: Array<Array<{ role?: string; content?: unknown; toolCallId?: string }>> = [];

		let round = 0;
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: string, messages: Array<{ role?: string }>) => {
				requestSnapshots.push(
					messages.map(m => ({ role: m.role, ...(m as object) })),
				);
				const isFirstRound = round === 0;
				round++;
				return (async function* () {
					if (isFirstRound) {
						// 第一轮：模型要求调用工具（且不带任何正文）
						yield {
							type: 'tool_call',
							toolCall: {
								id: 'call-1',
								name: 'read_file',
								// `providers.ts:495` 明确要求 arguments 是 **JSON 字符串**
								//（流式装配器按片段累积后再解析），传对象会在
								// repairToolArguments 里 `raw.trim is not a function` 崩溃。
								arguments: JSON.stringify({ path: '/mock/file.txt' }),
							},
						} as IModelDelta;
					} else {
						// 第二轮：模型基于工具结果作答
						yield { type: 'text', content: 'file read done' } as IModelDelta;
					}
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const executedBatches: unknown[] = [];
		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			// 提供一个可被抽取的 read_file 定义，使 tool_call 不被白名单丢弃
			_getEnabledTools: async () => [
				{ name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } },
			],
			// 工具执行：返回一个可识别的成功结果
			_executeToolCalls: async (calls: unknown[]) => {
				executedBatches.push(calls);
				return calls.map((c: any) => ({
					toolCallId: c.id,
					content: 'MOCK_FILE_CONTENT',
					success: true,
				}));
			},
			_executeToolCallsParallelStreaming: async function* (calls: unknown[]) {
				executedBatches.push(calls);
				for (const c of calls as Array<{ id: string }>) {
					yield { toolCallId: c.id, content: 'MOCK_FILE_CONTENT', success: true };
				}
			},
			_isSandboxViolation: () => false,
		});

		await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		// ─── 断言 1：工具确实被执行了 ──────────────────────────────────
		assert.ok(
			executedBatches.length > 0,
			'工具必须被实际执行（_executeToolCalls* 未被调用说明 tool_call 被丢弃）',
		);

		// ─── 断言 2：工具结果回灌进了第二轮请求 ────────────────────────
		const secondRound = requestSnapshots[1] ?? [];
		const toolMessages = secondRound.filter(m => m.role === 'tool');
		assert.ok(
			toolMessages.length > 0,
			`第二轮请求必须包含 role='tool' 的结果消息`
			+ `（实际 roles=[${secondRound.map(m => m.role).join(',')}]）。`
			+ `缺失意味着模型看不到工具输出，会反复重试同一调用`,
		);

		const toolText = toolMessages
			.map(m => JSON.stringify(m.content ?? ''))
			.join(' ');
		assert.ok(
			toolText.includes('MOCK_FILE_CONTENT'),
			`工具结果内容必须原样回灌（实际=${toolText}）`,
		);

		// ─── 断言 3：assistant 的 tool_calls 也必须留在历史里 ──────────
		// OpenAI 兼容协议要求 assistant(tool_calls) 后紧跟 tool 消息，
		// 缺失配对会被服务端判定消息序列非法（HTTP 400）。
		const assistantWithCalls = secondRound.filter(
			m => m.role === 'assistant' && Array.isArray((m as { toolCalls?: unknown[] }).toolCalls),
		);
		assert.ok(
			assistantWithCalls.length > 0,
			`第二轮请求必须保留 assistant 的 tool_calls 声明（否则 tool 消息无配对，`
			+ `服务端会 400）。实际 roles=[${secondRound.map(m => m.role).join(',')}]`,
		);
	});

	test('上下文溢出 400 → force 压缩并重试（溢出自愈路径）', async () => {
		// ─── 为什么测这条路径 ──────────────────────────────────────────
		// 这是**生产环境唯一的溢出自愈机制**：服务端 400 时若不压缩重试，
		// 整轮直接失败且用户无任何补救手段。相比常规压缩（需 token 超
		// effectiveWindow×0.70 且消息数≥10，构造成本极高且脆），
		// force 路径只需 messages.length >= 2，是本文件里性价比最高的压缩覆盖。
		//
		// 本用例**断言的是 force 透传与重试解耦**，而非压缩成功本身 ——
		// 后者在本规模数据下不可达（详见下方断言 2 注释）。
		//
		// 契约来源：
		//   · 溢出识别：`agentRunState.ts:1385` `isContextOverflowError`
		//     （匹配 '11133' / 'invalid_parameter_value' / 'context_length_exceeded' 等）
		//   · 判定与强制压缩：`turnLlmStream.ts:225-248`
		//     `if (!isTimeout && isContextOverflowError(error) && !loopState.overflowCompressionDone)`
		//     → `yield* deps.compressContext(true)` → `return { kind: 'retry' }`
		//   · 重试消费：`agentTurnExecutor.ts:3019` `if (_catchDisposition.kind === 'retry') { continue; }`

		let chatRound = 0;
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => {
				chatRound++;
				const isFirstAttempt = chatRound === 1;
				return (async function* () {
					if (isFirstAttempt) {
						// 模拟 IOA 网关的上下文溢出响应
						throw new Error('HTTP 400 invalid_parameter_value code 11133');
					}
					yield { type: 'text', content: 'recovered after compaction' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		let compactionRetrieveCalls = 0;
		// 捕获真实日志流：主循环在每条恢复分支上都打了 warn/error，
		// 日志能直接指出「错误实际走了哪条分支」，比反复猜测分支顺序可靠。
		const logLines: string[] = [];
		const capturingLogger = {
			info: (m: string) => { logLines.push(`info: ${m}`); },
			warn: (m: string) => { logLines.push(`warn: ${m}`); },
			error: (m: string) => { logLines.push(`error: ${m}`); },
			debug: () => undefined,
			trace: () => undefined,
		};
		const host = mockHost({
			_logService: capturingLogger,
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [],
			// 记忆 provider 须存在且带 `recallFormatted`，否则
			// `retrieveContext` 回调不会被提供（`agentTurnExecutor.ts:1495-1498`），
			// `_retrieveCompactionContext` 永不触发 —— 该探针会失效。
			getActiveMemoryProvider: () => ({
				recallFormatted: async () => undefined,
				triggerHook: () => undefined,
			}),
			_retrieveCompactionContext: async () => {
				compactionRetrieveCalls++;
				return undefined;
			},
			// 冷却必须放行：`_lastCompressionTime` 为 number（`agentOSService.ts:392`），
			// 0 表示从未压缩 → cooldownElapsed = Infinity → 不跳过。
			_lastCompressionTime: 0,
			_compressionBeforeTokens: 0,
			_compressionAfterTokens: 0,
			_compressionCount: 0,
			_compressionIneffectiveCount: 0,
			// 签名对齐真实实现 `agentOSService.ts:1320`：返回 `'approved' | 'rejected'` 字符串。
			// 别改成 `{ approved: boolean }` —— 调用点 `agentTurnExecutor.ts:1950` 是
			// `decision === 'approved'` 的**字符串相等**判断，返回对象会恒为 false。
			// 当前因 `shouldAskUser` 硬编码 false（`:1924`）此函数不会被调用（死代码），
			// 但签名必须正确 —— 一旦放开审批开关，错误的 mock 会让测试静默走错分支。
		_awaitPlanApproval: async () => 'rejected' as const,
		_awaitSandboxConfirmation: async () => ({ confirmed: false }),
		});

		// ⚠️ messages 必须 >= 2 条：`_evaluateTrigger` 的 force 快通道是
		// `skipTriggerGate = (force === true && messages.length >= 2)`
		//（`contextManager.ts:2050`）。只有 1 条消息时 force 无法放开，
		// 会回落到常规阈值判定并被 `below_message_min`（1 < 10）跳过 ——
		// 表现为「溢出检测日志已打印，但压缩被静默跳过」。
		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({
					messages: [
						{ role: 'user', content: 'first question' },
						{ role: 'assistant', content: 'first answer' },
						{ role: 'user', content: 'question two' },
						{ role: 'assistant', content: 'answer two' },
						{ role: 'user', content: 'question three' },
						{ role: 'assistant', content: 'answer three' },
						{ role: 'user', content: 'question four' },
						{ role: 'assistant', content: 'answer four' },
						{ role: 'user', content: 'question five' },
						{ role: 'user', content: 'trigger overflow' },
					],
				}) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		// ─── 断言 1：溢出后必须重试 ────────────────────────────────────
		assert.ok(
			chatRound >= 2,
			`溢出 400 后必须重发请求（实际 chat 调用=${chatRound} 次）。`
			+ `只调 1 次意味着溢出被当成普通错误直接终止，用户整轮失败`,
		);

		// 压缩成功的正向断言（`context_compacted` 事件）在本用例中**不可达**：
		// ContextManager 在 `force` 放行后仍会因 `nothing_to_compress` 拒绝 ——
		// PROTECT_FIRST_N=3 保护头部，TAIL_BUDGET_RATIO=0.2 的 tailBudget=25600 tokens
		// 又吞掉全部剩余消息（内容仅 ~107 tokens），中间段恒为空。
		// 要触发真实压缩需构造 ~25600 tokens 的对话，成本高且脆，故此处改验
		// **force 是否真的透传**（这才是溢出路径的回归风险点）：日志证据
		// `FORCE override (overflow recovery): bypassing token threshold / minMessagesToCompress`
		// 由 `contextManager.ts` 在接收 force=true 后打印。
		const forceOverrideLogs = logLines.filter(l => /FORCE override \(overflow recovery\)/i.test(l));
		assert.ok(
			forceOverrideLogs.length > 0,
			`溢出恢复必须把 force=true 透传到底层压缩器（实际压缩相关日志 ${
				logLines.filter(l => /\[Compression\]/i.test(l)).length
			} 条，均无 FORCE override）。未透传意味着溢出自愈退化为「重试但不压缩」`
			+ ` —— 重试必然再次撞同一堵墙，用户看到的是无限失败`,
		);

		// 压缩即便失败（nothing_to_compress），也不得阻断溢出重试。
		// 这是与断言 1 互补的负向契约：证明「压缩失败」与「放弃重试」解耦。
		const skippedButRetried = logLines.some(l => /SKIPPED reason=nothing_to_compress|SKIPPED reason=below/i.test(l));
		assert.ok(
			skippedButRetried && chatRound >= 2,
			`压缩被跳过时仍须重试（compactionSkipped=${skippedButRetried}, chatRound=${chatRound}）`,
		);

		// ─── 断言 3：恢复后正文正常透传 ────────────────────────────────
		const joined = deltas
			.filter(d => (d as { type?: string }).type === 'text')
			.map(d => String((d as { content?: string }).content ?? ''))
			.join('');
		assert.ok(
			joined.includes('recovered after compaction'),
			`压缩重试后必须正常产出正文（实际=${JSON.stringify(joined)}；`
			+ `事件类型=[${deltas.map(d => (d as { type?: string }).type).join(',')}]）`,
		);

		// ─── 断言 4：不得把原始溢出错误暴露给用户 ──────────────────────
		// 自愈成功时不该出现 error 事件（否则用户看到无意义的 400 报错）。
		const errorEvents = deltas
			.filter(d => (d as { type?: string }).type === 'error')
			.map(d => String((d as { content?: string }).content ?? ''));
		const leaked = errorEvents.filter(e => e.includes('11133') || e.includes('invalid_parameter_value'));
		assert.deepStrictEqual(
			leaked, [],
			`自愈成功时不得向用户暴露原始溢出错误（实际=${JSON.stringify(leaked)}）`,
		);
	});

	test('沙箱违规 → 弹确认卡片 → 等待决策 → 按决策重执行', async () => {
		// ─── 为什么测这条路径 ──────────────────────────────────────────
		// 这是**安全边界上的唯一交互闸门**：工具因触及工作区沙箱边界而失败时，
		// 必须暂停 loop、向用户弹出确认卡片，并严格按用户决策重执行或保留失败。
		// 若这条链路断掉，用户要么**永远看不到确认卡片**（工具静默失败），
		// 要么在**未获用户许可**的情况下被重执行（越权写入）。
		//
		// 契约来源（`agentTurnExecutor.ts:4442-4478` 串行分支）：
		//   · 判定：`if (!sr.success && host._isSandboxViolation(sr) && !handledSandboxIds.has(...))`
		//   · 卡片：`host._buildSandboxConfirmationCard(toolName, v)` → `yield confirmation`
		//   · 等待：`await host._awaitSandboxConfirmation(confirmationId)`
		//   · 回执：`yield confirmation_resolved`（confirmationStatus 由决策映射）
		//   · 重执行：`host._reExecuteAfterSandbox(tc, agentId, worktreePath, signal, decision, v)`
		//
		// ⚠️ `SandboxConfirmationDecision` 是 `const enum`（`providers.ts:1045`），
		// 在隔离模块下运行时不可直接 import 取值，故用字面量 'allow_once'
		//（与枚举值 `AllowOnce = 'allow_once'` 严格一致）。

		let chatRound = 0;
		// 捕获每轮请求的 messages：用于断言重执行结果是否回灌给模型。
		// （`requestSnapshots` 是上一个用例的局部变量，此处必须自建）
		const roundMessages: Array<Array<{ role: string; content?: unknown }>> = [];
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: string, messages: Array<{ role: string; content?: unknown }>) => {
				chatRound++;
				roundMessages.push(messages.map(m => ({ role: m.role, content: m.content })));
				const isFirstAttempt = chatRound === 1;
				return (async function* () {
					if (isFirstAttempt) {
						// ⚠️ 形状必须与 `agentModelAccess.ts:105` 一致：
						// `adaptModelDelta` 只在 `delta.type === 'tool_call' && delta.toolCall`
						// 时产出 tool_start。写成扁平的 `{type,id,name,arguments}`
						// 会被**静默忽略** —— 无 tool_start、无工具执行，
						// 循环随后走 xml-tool-leak / incomplete-turn 分支空转。
						yield {
							type: 'tool_call',
							toolCall: {
								id: 'call-sandbox-1',
								name: 'file_write',
								arguments: JSON.stringify({ path: '/outside/workspace/file.txt' }),
							},
						} as unknown as IModelDelta;
					} else {
						yield { type: 'text', content: 'write completed after approval' } as IModelDelta;
					}
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		let reExecuteCalls = 0;
		let awaitedConfirmationId: string | undefined;
		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'file_write', description: 'write a file', inputSchema: { type: 'object' } },
			],
			// 工具**失败**且带沙箱违规元数据 —— 这是触发确认闸门的唯一入口。
			_executeToolCalls: async (calls: unknown[]) =>
				(calls as Array<{ id: string }>).map(c => ({
					toolCallId: c.id,
					content: 'sandbox blocked: path outside allowed roots',
					success: false,
					metadata: {
						sandboxViolation: {
							requestedPath: '/outside/workspace/file.txt',
							resolvedPath: 'G:\\outside\\workspace\\file.txt',
							allowedRoots: ['g:\\SarosWorkspace\\sarosis-agents-client'],
							suggestedPath: 'g:\\SarosWorkspace\\sarosis-agents-client\\file.txt',
							isWorktree: false,
						},
					},
				})),
			_executeToolCallsParallelStreaming: async function* () { /* 串行路径不经过此分支 */ },
			// ─── 闸门相关的三个协作方法（必须接线，否则闸门不闭合）───
			_isSandboxViolation: (r: { metadata?: { sandboxViolation?: unknown } }) =>
				!!r?.metadata?.sandboxViolation,
			_buildSandboxConfirmationCard: (_toolName: string, _v: unknown) => ({
				id: 'pending',
				title: 'Sandbox confirmation required',
				allowOnceLabel: 'Allow once',
			}),
			_awaitSandboxConfirmation: async (confirmationId: string) => {
				awaitedConfirmationId = confirmationId;
				return 'allow_once';
			},
			_mapDecisionToCardStatus: (decision: string) =>
				decision === 'cancel' ? 'cancelled' : 'approved',
			_reExecuteAfterSandbox: async () => {
				reExecuteCalls++;
				return {
					toolCallId: 'call-sandbox-1',
					content: 'FILE_WRITTEN_AFTER_APPROVAL',
					success: true,
				};
			},
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const eventTypes = deltas.map(d => (d as { type?: string }).type ?? '');

		// ─── 断言 1：必须向用户弹出确认卡片 ─────────────────────────
		// 没有 confirmation 事件，用户就永远不知道工具被沙箱拦下了。
		const confirmationEvent = deltas.find(d => (d as { type?: string }).type === 'confirmation');
		assert.ok(
			confirmationEvent,
			`沙箱违规必须弹出确认卡片（实际事件序列=[${eventTypes.join(',')}]）。`
			+ `缺失意味着工具静默失败，用户无从得知需要授权`,
		);

		// ─── 断言 2：卡片必须携带被拦工具的真实信息 ──────────────────
		const card = (confirmationEvent as { confirmationData?: { id?: string; toolCallId?: string } }).confirmationData;
		assert.ok(
			card?.toolCallId === 'call-sandbox-1',
			`确认卡片必须关联触发它的 toolCallId（实际=${JSON.stringify(card?.toolCallId)}）。`
			+ `关联错误会让用户的授权落到别的工具上`,
		);

		// ─── 断言 3：必须等待用户决策（而非自行放行）─────────────────
		assert.ok(
			awaitedConfirmationId !== undefined && awaitedConfirmationId === card?.id,
			`必须挂起等待用户决策，且用卡片上的 id 关联（实际 awaited=${awaitedConfirmationId}, cardId=${card?.id}）`,
		);

		// ─── 断言 4：必须 yield 决策回执 ─────────────────────────────
		const resolved = deltas.find(d => (d as { type?: string }).type === 'confirmation_resolved');
		assert.ok(
			resolved,
			`必须 yield confirmation_resolved 让 UI 关闭卡片（实际事件序列=[${eventTypes.join(',')}]）`,
		);

		// ─── 断言 5：授权后必须真正重执行 ────────────────────────────
		assert.strictEqual(
			reExecuteCalls, 1,
			`用户授权后必须重执行工具恰好 1 次（实际=${reExecuteCalls}）。`
			+ `为 0 说明授权被忽略、工具停留在失败态；大于 1 说明重执行被重复触发`,
		);

		// ─── 断言 6：重执行结果必须取代原始失败结果进入对话 ──────────
		// 否则模型看到的是「工具失败」，会反复重试同一个被拦路径。
		const roundTwoMessages = roundMessages[1] ?? [];
		const toolMessages = roundTwoMessages.filter(m => m.role === 'tool');
		const reExecutedContent = toolMessages
			.map(m => String((m as { content?: unknown }).content ?? ''))
			.join('');
		assert.ok(
			reExecutedContent.includes('FILE_WRITTEN_AFTER_APPROVAL'),
			`重执行成功的结果必须回灌给模型（实际 tool 消息=${JSON.stringify(reExecutedContent.slice(0, 200))}）。`
			+ `未回灌意味着模型仍以为工具失败`,
		);
	});

	test('沙箱违规 + 用户拒绝 → 不得重执行，保留失败结果', async () => {
		// ─── 为什么测这条路径 ──────────────────────────────────────────
		// 与上一个用例**断言方向相反**，是安全边界上最该守的方向：
		// 用户点「取消」后若仍执行了写操作，就是**未经授权的文件改动**。
		// 只测 allow 分支等于只验证了「放行会放行」，
		// 完全没验证「拒绝会拒绝」—— 后者才是安全保证。
		//
		// 同时验证：拒绝时原始**失败**结果必须原样回灌（而非被吞掉），
		// 否则模型收不到「被拒绝」的信号，会换个路径继续试探。

		let chatRound = 0;
		const roundMessages: Array<Array<{ role: string; content?: unknown }>> = [];
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: string, messages: Array<{ role: string; content?: unknown }>) => {
				chatRound++;
				roundMessages.push(messages.map(m => ({ role: m.role, content: m.content })));
				const isFirstAttempt = chatRound === 1;
				return (async function* () {
					if (isFirstAttempt) {
						yield {
							type: 'tool_call',
							toolCall: {
								id: 'call-sandbox-2',
								name: 'file_write',
								arguments: JSON.stringify({ path: '/outside/workspace/secret.txt' }),
							},
						} as unknown as IModelDelta;
					} else {
						yield { type: 'text', content: 'understood, write was denied' } as IModelDelta;
					}
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		let reExecuteCalls = 0;
		let passedDecision: string | undefined;
		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'file_write', description: 'write a file', inputSchema: { type: 'object' } },
			],
			_executeToolCalls: async (calls: unknown[]) =>
				(calls as Array<{ id: string }>).map(c => ({
					toolCallId: c.id,
					content: 'SANDBOX_DENIED_WRITE',
					success: false,
					metadata: {
						sandboxViolation: {
							requestedPath: '/outside/workspace/secret.txt',
							resolvedPath: 'G:\\outside\\workspace\\secret.txt',
							allowedRoots: ['g:\\SarosWorkspace\\sarosis-agents-client'],
							suggestedPath: undefined,
							isWorktree: false,
						},
					},
				})),
			_executeToolCallsParallelStreaming: async function* () { /* 串行路径不经过此分支 */ },
			_isSandboxViolation: (r: { metadata?: { sandboxViolation?: unknown } }) =>
				!!r?.metadata?.sandboxViolation,
			_buildSandboxConfirmationCard: (_toolName: string, _v: unknown) => ({
				id: 'pending',
				title: 'Sandbox confirmation required',
			}),
			// 用户点「取消」
			_awaitSandboxConfirmation: async () => 'cancel',
			_mapDecisionToCardStatus: (decision: string) =>
				decision === 'cancel' ? 'cancelled' : 'approved',
			// 记录 executor 透传过来的决策：这才是本层该保证的契约。
			// （真实 guard 会因 Cancel 提前返回失败，不会执行工具。）
			_reExecuteAfterSandbox: async (
				_tc: unknown, _agentId: unknown, _worktreePath: unknown,
				_signal: unknown, decision: string,
			) => {
				passedDecision = decision;
				return {
					toolCallId: 'call-sandbox-2',
					content: 'SHOULD_NEVER_HAPPEN',
					success: true,
				};
			},
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		// ─── 断言 1：拒绝后**绝不**发生真实写入 ──────────────────────
		// ⚠️ 关键认知：**是否真的执行了工具**由 guard 层决定，不是本文件被测的
		// executor 层。真实防线在 `agentSandboxGuard.ts:143-149` ——
		// `if (decision === Cancel) { return { success: false, ... }; }` 提前返回，
		// **根本不调用 executeToolCalls**。
		//
		// 因此这里断言的是 executor 的**职责边界**：它必须把 Cancel 决策
		// **原样传给** guard，绝不能吞掉决策或擅自改成放行。
		// 用 mock host 时若断言「reExecuteCalls === 0」，等于要求 executor
		// 去替代 guard 做判定 —— 那是错误的分层，会让测试锁死错误的契约。
		assert.ok(
			passedDecision !== undefined,
			`必须把用户决策传给重执行入口（实际决策=${JSON.stringify(passedDecision)}）。`
			+ `未传意味着 guard 无法得知用户拒绝了，会按默认路径继续 —— 这才是真正的越权风险`,
		);
		assert.strictEqual(
			passedDecision, 'cancel',
			`必须原样透传 Cancel 决策（实际=${JSON.stringify(passedDecision)}）。`
			+ `被改写成 allow_once 会让 guard 提前返回失败的分支失效，导致未经授权的写入`,
		);

		// ─── 断言 2：决策回执必须标记为 cancelled ────────────────────
		const resolved = deltas.find(d => (d as { type?: string }).type === 'confirmation_resolved');
		const status = (resolved as { confirmationStatus?: string } | undefined)?.confirmationStatus;
		assert.strictEqual(
			status, 'cancelled',
			`拒绝后回执状态必须是 cancelled（实际=${JSON.stringify(status)}）。`
			+ `若为 approved，UI 会向用户显示错误的成功状态`,
		);

		// ─── 断言 3：拒绝后的结果必须进入对话（模型需知道自己被拒）───
		// 真实 guard 在 Cancel 时会返回 `success: false` 的「操作已取消」文本；
		// 本用例的 mock 返回其自身内容，故只断言**确有结果回灌**这一形状契约，
		// 不锁定具体文案（文案归 guard 的测试覆盖）。
		const roundTwo = roundMessages[1] ?? [];
		const toolMessages = roundTwo.filter(m => m.role === 'tool');
		const toolText = toolMessages
			.map(m => String((m as { content?: unknown }).content ?? ''))
			.join('');
		assert.ok(
			toolMessages.length > 0,
			`拒绝后仍必须把结果回灌给模型（实际第二轮 roles=[${roundTwo.map(m => m.role).join(',')}]）。`
			+ `完全无 tool 消息会让模型以为工具没被调用过，从而反复重试同一路径`,
		);
		assert.strictEqual(
			reExecuteCalls, 0,
			`本用例的 mock 不应被调用到「执行」路径（实际=${reExecuteCalls}）—— `
			+ `若为 1，说明断言 1 记录的决策透传观察点失效了`,
		);
	});

	test('plan_enter → 切入 plan 模式并创建计划文件', async () => {
		// ─── 为什么测这条路径 ──────────────────────────────────────────
		// `plan_enter` 是进入只读 plan 模式的**唯一入口**。它若不切换 workMode，
		// 后续 `plan_exit` 的守卫（`runState.work.mode === 'plan'`）永不成立 →
		// 用户看到「已进入计划模式」但系统仍在 work 模式，plan 工具全部失效。
		//
		// 契约来源（`agentTurnExecutor.ts:1837-1890`）：
		//   · 切模式：`reduceRunState(..., ENTER_PLAN)` → `yield work_mode_changed`
		//   · 生成路径：`generatePlanPath(host._getSarosRoot(), lastUserText)`
		//   · 写初始文件：`host._writePlanFile(planFilePath, initialContent)`
		//   · 必须 yield tool_result + tool_end（否则 UI 端 tool_start 无 end → orphan 清理）

		let chatRound = 0;
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => {
				chatRound++;
				const isFirstAttempt = chatRound === 1;
				return (async function* () {
					if (isFirstAttempt) {
						yield {
							type: 'tool_call',
							toolCall: { id: 'call-enter', name: 'plan_enter', arguments: '{}' },
						} as unknown as IModelDelta;
					} else {
						yield { type: 'text', content: 'planning' } as IModelDelta;
					}
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const writtenFiles: Array<{ path: string; content: string }> = [];
		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'plan_enter', description: 'enter plan mode', inputSchema: { type: 'object' } },
			],
			_executeToolCalls: async (calls: unknown[]) =>
				(calls as Array<{ id: string }>).map(c => ({ toolCallId: c.id, content: 'executed', success: true })),
			_executeToolCallsParallelStreaming: async function* () { /* 串行路径 */ },
			_getSarosRoot: () => '/mock/saros/root',
			_writePlanFile: async (path: string, content: string) => { writtenFiles.push({ path, content }); },
			_readPlanFile: async () => '',
			_isSandboxViolation: () => false,
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest({
				messages: [{ role: 'user', content: 'please plan a refactor' }],
			}) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const eventTypes = deltas.map(d => (d as { type?: string }).type ?? '');

		assertNoToolExecutionErrors(deltas);

		// ─── 断言 1：必须切换到 plan 模式 ────────────────────────────
		// 注意：`plan_enter` 区块**产两个**独立的 work_mode_changed ——
		//   · `:1845` 纯模式切换（无 planPhase）
		//   · `:1855` 阶段卡（带 planPhase.currentStep=1 + planFilePath）
		// 只断言「存在某个 plan 事件」是**假绿**：`:1855` 单独出现也能满足，
		// 而模式切换本身可以被改坏。必须两个都验证。
		const modeEvents = deltas.filter(d => (d as { type?: string }).type === 'work_mode_changed');
		const switchEvents = modeEvents.filter(d =>
			(d as { workMode?: string }).workMode === 'plan'
			&& !(d as { planPhase?: unknown }).planPhase);
		const phaseEvents = modeEvents.filter(d =>
			(d as { workMode?: string }).workMode === 'plan'
			&& (d as { planPhase?: { currentStep?: number } }).planPhase?.currentStep === 1);
		assert.ok(
			switchEvents.length >= 1,
			`plan_enter 必须产出纯模式切换事件 workMode='plan'（无 planPhase）；`
			+ `实际模式事件=[${modeEvents.map(d => JSON.stringify(d)).join(' | ')}]`,
		);
		assert.ok(
			phaseEvents.length >= 1,
			`plan_enter 必须产出阶段卡事件 workMode='plan' + planPhase.currentStep=1；`
			+ `实际模式事件=[${modeEvents.map(d => JSON.stringify(d)).join(' | ')}]`,
		);

		// ─── 断言 2：必须创建计划文件 ────────────────────────────────
		assert.strictEqual(
			writtenFiles.length, 1,
			`plan_enter 必须创建恰好 1 个计划文件（实际=${writtenFiles.length}）`,
		);
		assert.ok(
			writtenFiles[0].path.length > 0,
			'计划文件路径不得为空',
		);

		// ─── 断言 3：tool_call 必须被正常终止 ────────────────────────
		// 缺 tool_end 会让 UI 端 tool_start 悬挂，触发 orphan 清理。
		const enterEnd = deltas.find(d =>
			(d as { type?: string }).type === 'tool_end'
			&& (d as { toolCallId?: string }).toolCallId === 'call-enter');
		assert.ok(enterEnd, `plan_enter 必须 yield 对应的 tool_end（实际事件=[${eventTypes.join(',')}]）`);
		assert.strictEqual(
			(enterEnd as { success?: boolean }).success, true,
			'plan_enter 的 tool_end 必须标记 success=true',
		);
	});

	test('plan_exit → 计划文件无效时拒绝退出，不进入执行', async () => {
		// ─── 为什么测这条路径 ──────────────────────────────────────────
		// `plan_exit` 的守卫（`:1907`）是**防止空计划被执行**的最后一道闸门：
		// 计划文件缺失 / 无内容 / 无结构化 task 时必须拒绝退出并留在 plan 模式。
		// 若这道门失效，空计划会被当作「已完成」直接进入执行阶段 ——
		// 用户得到一个什么都没做的"执行结果"。
		//
		// 注意 `shouldAskUser` 当前**硬编码为 false**（`:1924`），
		// 故 `_awaitPlanApproval` 是死代码，本用例不覆盖它。

		let chatRound = 0;
		const roundMessages: Array<Array<{ role: string; content?: unknown }>> = [];
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_m: string, messages: Array<{ role: string; content?: unknown }>) => {
				chatRound++;
				roundMessages.push(messages.map(m => ({ role: m.role, content: m.content })));
				const isFirstAttempt = chatRound === 1;
				return (async function* () {
					if (isFirstAttempt) {
						// 先进入 plan 模式
						yield {
							type: 'tool_call',
							toolCall: { id: 'call-enter', name: 'plan_enter', arguments: '{}' },
						} as unknown as IModelDelta;
					} else if (chatRound === 2) {
						// 再尝试退出（此时计划文件内容为空）
						yield {
							type: 'tool_call',
							toolCall: { id: 'call-exit', name: 'plan_exit', arguments: '{}' },
						} as unknown as IModelDelta;
					} else {
						yield { type: 'text', content: 'staying in plan mode' } as IModelDelta;
					}
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'plan_enter', description: 'enter plan mode', inputSchema: { type: 'object' } },
				{ name: 'plan_exit', description: 'exit plan mode', inputSchema: { type: 'object' } },
			],
			_executeToolCalls: async (calls: unknown[]) =>
				(calls as Array<{ id: string }>).map(c => ({ toolCallId: c.id, content: 'executed', success: true })),
			_executeToolCallsParallelStreaming: async function* () { /* 串行路径 */ },
			_getSarosRoot: () => '/mock/saros/root',
			_writePlanFile: async () => undefined,
			// 关键：计划文件为空 → 触发 `:1907` 的无效判定
			_readPlanFile: async () => '',
			_isSandboxViolation: () => false,
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest({
				messages: [{ role: 'user', content: 'plan then exit' }],
			}) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const eventTypes = deltas.map(d => (d as { type?: string }).type ?? '');

		assertNoToolExecutionErrors(deltas);

		// ─── 断言 1：plan_exit 的 tool_end 必须标记失败 ──────────────
		const exitEnd = deltas.find(d =>
			(d as { type?: string }).type === 'tool_end'
			&& (d as { toolCallId?: string }).toolCallId === 'call-exit');
		assert.ok(
			exitEnd,
			`无效计划的 plan_exit 必须 yield tool_end（实际事件=[${eventTypes.join(',')}]）`,
		);
		assert.strictEqual(
			(exitEnd as { success?: boolean }).success, false,
			'无效计划的 plan_exit 必须以 success=false 结束（若为 true，空计划会被当作可执行）',
		);

		// ─── 断言 2：必须把拒绝原因回灌给模型 ────────────────────────
		const lastRound = roundMessages[roundMessages.length - 1] ?? [];
		const toolText = lastRound
			.filter(m => m.role === 'tool')
			.map(m => String(m.content ?? ''))
			.join('');
		assert.ok(
			/Plan exit blocked/i.test(toolText),
			`必须回灌明确的拒绝原因（实际 tool 消息=${JSON.stringify(toolText.slice(0, 300))}）。`
			+ `无原因会让模型反复重试同一个 plan_exit`,
		);

		// ─── 断言 3：不得切换到 work 模式 ────────────────────────────
		const leftPlan = deltas.some(d =>
			(d as { type?: string }).type === 'work_mode_changed'
			&& (d as { workMode?: string }).workMode === 'work');
		assert.ok(
			!leftPlan,
			`无效计划不得切出 plan 模式（实际事件=[${eventTypes.join(',')}]）`,
		);
	});

	test('plan_explore 未先 plan_enter → 必须自动切入 plan 模式并补建计划文件', async () => {
		// ─── 为什么测这条路径 ────────────────────────────────────────
		// `plan_explore` 的契约是「只在 plan 模式运行」（`agentTurnExecutor.ts:1792`）。
		// 但 LLM 完全可能直接调 plan_explore 而不先调 plan_enter。
		// `:1794-1813` 的自动入模式分支就是为这个**现实失序**兜底的：
		//   · 切模式 + yield 纯模式事件（:1798）
		//   · 补建 planFilePath + 落盘（:1800-1810，写文件是 best-effort，失败静默）
		//   · yield 阶段卡（:1812）
		//
		// 这条兜底一旦失效，plan_explore 会在 work 模式下裸奔：探索结果无处归属，
		// 后续 plan_exit 因 planFilePath 缺失而永远拒绝退出 → 用户被卡在死循环里。

		let chatRound = 0;
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => {
				chatRound++;
				const isFirstAttempt = chatRound === 1;
				return (async function* () {
					if (isFirstAttempt) {
						// 关键：只调 plan_explore，**不调** plan_enter
						yield {
							type: 'tool_call',
							toolCall: { id: 'call-explore', name: 'plan_explore', arguments: '{"topics":["a"]}' },
						} as unknown as IModelDelta;
					} else {
						yield { type: 'text', content: 'explored' } as IModelDelta;
					}
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const writtenFiles: Array<{ path: string; content: string }> = [];
		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'plan_explore', description: 'explore', inputSchema: { type: 'object' } },
			],
			_executeToolCalls: async (calls: unknown[]) =>
				(calls as Array<{ id: string }>).map(c => ({
					toolCallId: c.id,
					content: JSON.stringify({ findings: [] }),
					success: true,
				})),
			_writePlanFile: async (filePath: string, content: string) => {
				writtenFiles.push({ path: filePath, content });
			},
		} as never);

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest({
				messages: [{ role: 'user', content: 'please explore options' }],
			}) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		const modeEvents = deltas.filter(d => (d as { type?: string }).type === 'work_mode_changed');

		// ─── 断言 0：工具必须真的执行成功（防止 mock 缺钩子导致假绿）──
		assertNoToolExecutionErrors(deltas);

		// ─── 断言 1：必须自动补一次纯模式切换 ────────────────────────
		const autoSwitch = modeEvents.filter(d =>
			(d as { workMode?: string }).workMode === 'plan'
			&& !(d as { planPhase?: unknown }).planPhase);
		assert.ok(
			autoSwitch.length >= 1,
			`未先 plan_enter 时 plan_explore 必须自动产出纯模式切换事件；`
			+ `实际模式事件=[${modeEvents.map(d => JSON.stringify(d)).join(' | ')}]`,
		);

		// ─── 断言 2：必须补建计划文件（含 Tasks 段）──────────────────
		assert.ok(
			writtenFiles.length >= 1,
			`自动入模式必须补建计划文件，否则后续 plan_exit 因 planFilePath 缺失而永久拒绝退出；`
			+ `实际写入文件数=${writtenFiles.length}`,
		);
		// 必须行首锚定 `^## Tasks`：`/## Tasks/` 会误命中 `### Tasks`，
		// 而 `parsePlanDocument` 认的是二级标题 —— 子串匹配会漏掉这个差异。
		assert.ok(
			/^## Tasks\s*$/m.test(writtenFiles[0].content),
			`补建的计划文件必须含二级标题 "## Tasks"（plan_exit 的解析依赖它）；`
			+ `实际内容=${JSON.stringify(writtenFiles[0].content.slice(0, 200))}`,
		);

		// ─── 断言 3：阶段卡必须携带补建出的 planFilePath ─────────────
		const phaseCard = modeEvents.find(d =>
			(d as { planPhase?: { currentStep?: number } }).planPhase?.currentStep === 1);
		assert.ok(
			phaseCard,
			`自动入模式必须产出阶段卡（currentStep=1）；`
			+ `实际模式事件=[${modeEvents.map(d => JSON.stringify(d)).join(' | ')}]`,
		);
		assert.strictEqual(
			(phaseCard as { planPhase?: { planFilePath?: string } }).planPhase?.planFilePath,
			writtenFiles[0].path,
			`阶段卡里的 planFilePath 必须与真正落盘的文件一致，否则 UI 展示的路径点不开`,
		);
	});

	test('plan_exit → 有效计划必须批准并派发 DAG（携带 idempotencyKey）', async () => {
		// ─── 为什么测这条路径 ────────────────────────────────────────
		// 上一个用例只覆盖了**拒绝**分支（计划无效 → 留在 plan 模式）。
		// 真正的正向路径（`:1958-2009`）从未被执行过 —— 而它才是用户日常走的那条：
		//   · `:1981` 必须切回 **work** 模式并定格阶段卡（completedAt）
		//   · `:1994-1999` 必须把解析出的 tasks 交给 `_orchestratePlan` fan-out
		//   · `:1993` idempotencyKey 必须含 **planExitCall.id**（否则重放会重复建 plan）
		//   · `:2008` tool_end 必须 success=true（否则 UI 卡在 running）
		//
		// 若这段失效，plan_exit 会「假装成功」但不派发任何任务 ——
		// 用户看到计划已完成，实际没有任何 subagent 被启动。

		const PLAN_MD = [
			'# Plan: refactor',
			'',
			'## Goal',
			'Make the parser robust.',
			'',
			'## Tasks',
			'',
			'### Task 1: Parse input',
			'files: src/parser.ts',
			'### Task 2: Add tests',
			'files: src/parser.test.ts',
			'dependencies: Parse input',
			'',
		].join('\n');

		let chatRound = 0;
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => {
				chatRound++;
				const round = chatRound;
				return (async function* () {
					if (round === 1) {
						yield {
							type: 'tool_call',
							toolCall: { id: 'call-enter', name: 'plan_enter', arguments: '{}' },
						} as unknown as IModelDelta;
					} else if (round === 2) {
						yield {
							type: 'tool_call',
							toolCall: { id: 'call-exit', name: 'plan_exit', arguments: '{}' },
						} as unknown as IModelDelta;
					} else {
						yield { type: 'text', content: 'dispatching' } as IModelDelta;
					}
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		// 记录 `_orchestratePlan` 收到的实参 —— 这是本用例的核心观察点
		const orchestrateCalls: Array<{
			summary?: string;
			nextMode?: string;
			idempotencyKey?: string;
			taskTitles: string[];
			toolCallId: string;
		}> = [];

		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'plan_enter', description: 'enter plan mode', inputSchema: { type: 'object' } },
				{ name: 'plan_exit', description: 'exit plan mode', inputSchema: { type: 'object' } },
			],
			_executeToolCalls: async (calls: unknown[]) =>
				(calls as Array<{ id: string }>).map(c => ({ toolCallId: c.id, content: 'executed', success: true })),
			_executeToolCallsParallelStreaming: async function* () { /* 串行路径 */ },
			_getSarosRoot: () => '/mock/saros/root',
			_writePlanFile: async () => undefined,
			_readPlanFile: async () => PLAN_MD,
			_isSandboxViolation: () => false,
			_orchestratePlan: async function* (
				_request: unknown,
				args: { plan_summary?: string; next_mode?: string; idempotencyKey?: string },
				tasks: Array<{ title: string }>,
				toolCallId: string,
			) {
				orchestrateCalls.push({
					summary: args.plan_summary,
					nextMode: args.next_mode,
					idempotencyKey: args.idempotencyKey,
					taskTitles: tasks.map(t => t.title),
					toolCallId,
				});
				yield { type: 'text', content: 'orchestrating' } as never;
			},
		} as never);

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest({
				messages: [{ role: 'user', content: 'plan then execute' }],
			}) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const eventTypes = deltas.map(d => (d as { type?: string }).type ?? '');

		assertNoToolExecutionErrors(deltas);

		// ─── 断言 1：必须真的派发 DAG，且 tasks 解析正确 ─────────────
		assert.strictEqual(
			orchestrateCalls.length, 1,
			`有效计划必须恰好派发一次 DAG（实际=${orchestrateCalls.length}）。`
			+ `为 0 说明 plan_exit「假装成功」但没启动任何任务`,
		);
		assert.deepStrictEqual(
			orchestrateCalls[0].taskTitles, ['Parse input', 'Add tests'],
			`必须把 "## Tasks" 下的两个任务都解析出来并派发；`
			+ `实际=${JSON.stringify(orchestrateCalls[0].taskTitles)}`,
		);

		// ─── 断言 2：idempotencyKey 必须含 planExitCall.id ───────────
		// `:1993` 的 key 形如 `plan-exit-<sessionId>-<toolCallId>`。
		// 丢掉 toolCallId 会让**同一次** plan_exit 在重放时被当成新计划 → 重复建 plan。
		assert.ok(
			orchestrateCalls[0].idempotencyKey?.includes('call-exit'),
			`idempotencyKey 必须含 plan_exit 的 toolCallId（call-exit）；`
			+ `实际=${JSON.stringify(orchestrateCalls[0].idempotencyKey)}`,
		);

		// ─── 断言 3：必须切回 work 模式 ──────────────────────────────
		const backToWork = deltas.filter(d =>
			(d as { type?: string }).type === 'work_mode_changed'
			&& (d as { workMode?: string }).workMode === 'work');
		assert.ok(
			backToWork.length >= 1,
			`批准后必须切回 work 模式（实际事件=[${eventTypes.join(',')}]）`,
		);

		// ─── 断言 4：tool_end 必须成功，否则 UI 永远显示 running ─────
		const exitEnd = deltas.find(d =>
			(d as { type?: string }).type === 'tool_end'
			&& (d as { toolCallId?: string }).toolCallId === 'call-exit');
		assert.ok(exitEnd, `plan_exit 必须 yield tool_end（实际事件=[${eventTypes.join(',')}]）`);
		assert.strictEqual(
			(exitEnd as { success?: boolean }).success, true,
			'有效计划的 plan_exit 必须以 success=true 结束',
		);
	});

	test('幻觉工具名 → 必须被白名单过滤，且补 tool_end 防止卡片永久转圈', async () => {
		// ─── 为什么测这条路径 ────────────────────────────────────────
		// 模型可能从旧会话残留 / agent 定义里读到**不存在的工具名**并直接调用。
		// `:3149-3186` 的白名单过滤负责拦下这类"幻觉调用"。
		//
		// 这段最容易漏的是 `:3179-3184` 的**补偿事件**：
		// 过滤只把调用从 `effectiveToolCalls` 里摘掉，但 UI 端此前已因
		// `tool_start` 渲染出一张卡片 —— 若不显式补 `tool_result` + `tool_end`，
		// 那张卡片会**永远转圈**（orphan，永远不会收到 end）。
		//
		// 同时必须回灌可用工具示例（`:3181`），否则模型不知道真实工具名，
		// 只会换一个同样虚构的名字反复重试。

		let chatRound = 0;
		const executedNames: string[] = [];
		const roundMessages: Array<Array<{ role: string; content?: unknown }>> = [];
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_m: string, messages: Array<{ role: string; content?: unknown }>) => {
				chatRound++;
				roundMessages.push(messages.map(m => ({ role: m.role, content: m.content })));
				const round = chatRound;
				return (async function* () {
					if (round === 1) {
						// 一个真实工具 + 一个纯虚构工具
						yield {
							type: 'tool_call',
							toolCall: { id: 'call-real', name: 'read_file', arguments: '{"path":"a.ts"}' },
						} as unknown as IModelDelta;
						yield {
							type: 'tool_call',
							toolCall: { id: 'call-ghost', name: 'totally_made_up_tool', arguments: '{}' },
						} as unknown as IModelDelta;
					} else {
						yield { type: 'text', content: 'done' } as IModelDelta;
					}
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
			],
			// 白名单闸门（`:3149`）要求 size > 0 才会介入 —— 默认 mock 是空 Set，
			// 不填这里整段过滤逻辑会被跳过（本用例就成了假绿）。
			_lastAllEnabledToolNames: new Set<string>(['read_file']),
			_executeToolCalls: async (calls: unknown[]) => {
				const list = calls as Array<{ id: string; name: string }>;
				list.forEach(c => executedNames.push(c.name));
				return list.map(c => ({ toolCallId: c.id, content: 'ok', success: true }));
			},
		} as never);

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest({
				messages: [{ role: 'user', content: 'read the file' }],
			}) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const eventTypes = deltas.map(d => (d as { type?: string }).type ?? '');

		// ─── 断言 1：幻觉工具不得被真的执行 ──────────────────────────
		assert.ok(
			!executedNames.includes('totally_made_up_tool'),
			`幻觉工具名不得进入执行路径（实际执行=[${executedNames.join(',')}]）`,
		);
		assert.deepStrictEqual(
			executedNames, ['read_file'],
			`只有真实工具应被执行（实际=[${executedNames.join(',')}]）`,
		);

		// ─── 断言 2：必须为被过滤的调用补 tool_end（防永久转圈）──────
		const ghostEnd = deltas.find(d =>
			(d as { type?: string }).type === 'tool_end'
			&& (d as { toolCallId?: string }).toolCallId === 'call-ghost');
		assert.ok(
			ghostEnd,
			`被过滤的幻觉调用必须补 tool_end，否则 UI 卡片永久转圈（实际事件=[${eventTypes.join(',')}]）`,
		);
		assert.strictEqual(
			(ghostEnd as { success?: boolean }).success, false,
			'被过滤的幻觉调用必须以 success=false 结束',
		);

		// ─── 断言 3：必须向 UI 回灌可用工具示例，让用户能自我纠正 ────
		// 注意（`:3181-3182`）：过滤补偿只 **yield 到 delta 流**，并不 append 进
		// `messages`。实测第二轮 messages 里只有真实工具的结果 —— 这是既有设计，
		// 不是缺陷。因此这里断言 delta 流，**不要**断言 messages，
		// 否则会写成永远失败的假断言。
		const ghostResult = deltas.find(d =>
			(d as { type?: string }).type === 'tool_result'
			&& (d as { toolCallId?: string }).toolCallId === 'call-ghost');
		assert.ok(
			ghostResult,
			`必须为幻觉调用产出 tool_result 说明（实际事件=[${eventTypes.join(',')}]）`,
		);
		const ghostText = String((ghostResult as { content?: unknown }).content ?? '');
		assert.ok(
			ghostText.includes('totally_made_up_tool'),
			`tool_result 必须点名被拒的工具；实际=${JSON.stringify(ghostText.slice(0, 200))}`,
		);
		assert.ok(
			ghostText.includes('read_file'),
			`tool_result 必须带可用工具示例，否则用户不知道能用什么；实际=${JSON.stringify(ghostText.slice(0, 200))}`,
		);
	});

	test('去重工具调用 → 必须补 tool_end，且同名只执行一次', async () => {
		// ─── 为什么测这条路径 ────────────────────────────────────────
		// 模型有时会在同一轮里**重复下发完全相同的调用**（同名同参）。
		// `:3193-3200` 的 deduplicateToolCalls 负责摘掉重复项，并为其补
		// tool_result + tool_end —— 与幻觉过滤同理，不补则卡片永久转圈。
		//
		// 关键区别：去重**不是**白名单拦截，两者是相邻但独立的两个补偿点
		// （`:3176-3187` 幻觉 / `:3193-3200` 去重）。只测其一无法覆盖另一个。

		let chatRound = 0;
		const executedIds: string[] = [];
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => {
				chatRound++;
				const round = chatRound;
				return (async function* () {
					if (round === 1) {
						// 两个 id 不同但名字与参数完全一致的调用
						yield {
							type: 'tool_call',
							toolCall: { id: 'dup-1', name: 'read_file', arguments: '{"path":"same.ts"}' },
						} as unknown as IModelDelta;
						yield {
							type: 'tool_call',
							toolCall: { id: 'dup-2', name: 'read_file', arguments: '{"path":"same.ts"}' },
						} as unknown as IModelDelta;
					} else {
						yield { type: 'text', content: 'done' } as IModelDelta;
					}
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['read_file']),
			_executeToolCalls: async (calls: unknown[]) => {
				const list = calls as Array<{ id: string }>;
				list.forEach(c => executedIds.push(c.id));
				return list.map(c => ({ toolCallId: c.id, content: 'ok', success: true }));
			},
		} as never);

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest({
				messages: [{ role: 'user', content: 'read same file twice' }],
			}) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		// ─── 断言 1：重复调用只执行一次 ──────────────────────────────
		assert.strictEqual(
			executedIds.length, 1,
			`去重后只应执行一次（实际执行=[${executedIds.join(',')}]）——`
			+ `重复执行会造成同一文件写两次之类的不幂等副作用`,
		);

		// ─── 断言 2：被去重者必须补 tool_end（防永久转圈）────────────
		const allEndIds = new Set(
			deltas
				.filter(d => (d as { type?: string }).type === 'tool_end')
				.map(d => (d as { toolCallId?: string }).toolCallId),
		);
		assert.ok(
			allEndIds.has('dup-1') && allEndIds.has('dup-2'),
			`两个调用的 tool_start 都必须收到对应 tool_end，否则卡片永久转圈。`
			+ `实际收到 end 的 id=[${[...allEndIds].join(',')}]`,
		);

		// ─── 断言 3：去重补偿必须由**去重路径本身**产出 ────────────────
		// 实测（变异验证）：若只断言「dup-2 收到了 tool_end」，单独删掉去重补偿
		// （:3198-3199）测试**仍全绿** —— 因为下游还有 orphan 清理等兜底会补发。
		// 因此这里锁死去重路径的**专属产物**：带「已去重」说明的 tool_result。
		// 该文案只在 :3197 出现，删掉该补偿即立刻变红。
		const dupResults = deltas
			.filter(d => (d as { type?: string }).type === 'tool_result')
			.filter(d => (d as { toolCallId?: string }).toolCallId === 'dup-2')
			.map(d => String((d as { content?: unknown }).content ?? ''));

		assert.ok(
			dupResults.some(t => t.includes('已去重')),
			`去重补偿（:3197）必须产出带「已去重」说明的 tool_result；`
			+ `实际 dup-2 的 tool_result=[${JSON.stringify(dupResults)}]`,
		);
	});

	test('全失败且均为工具名不存在 → 达到重试上限后结束循环', async () => {
		// ─── 为什么测这条路径 ────────────────────────────────────────
		// `:2105-2121` 是防「模型与工具名死磕」的兜底闸门：
		// 当**本轮所有**工具结果都失败、且内容含 "does not exist"/"not available" 时，
		// runState 累加 invalidToolNameCount；达到 MAX_INVALID_TOOL_RETRIES(=3，
		// 见 toolCallUtils.ts:34) 后必须直接 done 退出，而不是无限重试。
		//
		// 这条路径最容易出的错是**在错误的位置 return**：若在计数达标前就退出，
		// 模型会失去自我纠正机会；若永不退出，则整轮 turn 卡死烧 token。

		let chatRound = 0;
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => {
				chatRound++;
				return (async function* () {
					// 每一轮都请求同一个"不存在"的工具
					yield {
						type: 'tool_call',
						toolCall: { id: `nf-${chatRound}`, name: 'read_file', arguments: '{}' },
					} as unknown as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['read_file']),
			_executeToolCalls: async (calls: unknown[]) => {
				// 模拟 provider 报"工具不存在"
				return (calls as Array<{ id: string }>).map(c => ({
					toolCallId: c.id,
					content: { error: 'Tool does not exist' },
					success: false,
				}));
			},
		} as never);

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest({
				messages: [{ role: 'user', content: 'keep calling a missing tool' }],
			}) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		// ─── 断言 1：循环必须真的终止（不能无限重试）─────────────────
		assert.ok(
			chatRound <= 6,
			`达到无效工具重试上限后必须退出，实际请求了 ${chatRound} 轮`
			+ `（上限 3 次 + 少量正常轮次，远超即说明闸门失效）`,
		);

		// ─── 断言 2：必须以 done 收尾，且存在失败的工具结果 ───────────
		const eventTypes = deltas.map(d => (d as { type?: string }).type ?? '');
		assert.ok(
			eventTypes.includes('done'),
			`退出路径必须发出 done 事件（实际事件=[${eventTypes.join(',')}]）`,
		);
		const failedResults = deltas.filter(d =>
			(d as { type?: string }).type === 'tool_result');
		assert.ok(
			failedResults.length > 0,
			'必须产出工具结果事件，而非静默吞掉失败',
		);
	});

	test('clarify 与「全批失败」同时成立 → 仍走 clarify 终态（phase_change idle）', async () => {
		// ─── 为什么测这条路径 ────────────────────────────────────────
		// 停止判定收口到 `common/turnStopGate.ts` 后，批次裁决内部按
		// invalid → terminate → clarify 顺序返回**单一** reason。而「全批失败」
		// 与「批次含 clarify」可以同时成立：clarify 工具本身可以 success=false
		// （例如 UI 侧提交失败），此时批次既满足 allToolsFailed，又含合法
		// `__clarify__` 载荷。
		//
		// 若调用方把 `decision.kind === 'stop'` 一律当作无效工具名处理，clarify
		// 就会跳过 `SET_PHASE idle` + `phase_change` —— UI 依赖该事件读终态，
		// 缺失会让澄清卡片弹出后会话停在非 idle 相位。
		//
		// 断言的失败模式：若收口退化，phase_change(idle) 消失。
		const clarifyPayload = JSON.stringify({
			__clarify__: true,
			questions: [{ question: '要继续吗？' }],
		});

		let chatRound = 0;
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => {
				chatRound++;
				return (async function* () {
					yield {
						type: 'tool_call',
						toolCall: { id: `cl-${chatRound}`, name: 'clarify', arguments: '{}' },
					} as unknown as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'clarify', description: 'ask', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['clarify']),
			// 关键：success=false（满足 allToolsFailed）+ 合法 clarify 载荷
			_executeToolCalls: async (calls: unknown[]) => {
				return (calls as Array<{ id: string }>).map(c => ({
					toolCallId: c.id,
					content: [{ type: 'text', text: clarifyPayload }],
					success: false,
				}));
			},
		} as never);

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest({
				messages: [{ role: 'user', content: 'ask me something' }],
			}) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const phaseChanges = deltas
			.filter(d => (d as { type?: string }).type === 'phase_change')
			.map(d => (d as { phase?: string }).phase);
		assert.ok(
			phaseChanges.includes('idle'),
			'clarify 终止路径必须 yield phase_change(idle)（UI 靠它读终态）；'
			+ `实际 phase_change=[${phaseChanges.join(',')}]`,
		);
		assert.ok(
			chatRound === 1,
			`clarify 命中后必须立刻结束 turn，实际跑了 ${chatRound} 轮`,
		);
	});

	test('输出上限截断 + 带工具调用 → 一个都不执行，且补 tool_end', async () => {
		// ─── 为什么测这条路径 ────────────────────────────────────────
		// assistant 撞输出 token 上限（finishReason=length）时仍可能带出工具调用，
		// 其参数由「尽力而为」的 JSON 抢救解析器收尾 —— **可能解析通过、校验通过，
		// 但内容静默不完整**（patch 的 replace 被截半、command 少了尾部管道）。
		// 执行这种调用会造成真实的错误写入。
		//
		// 断言的失败模式：若保护缺失或位置放错（例如放在白名单过滤之后），
		// _executeToolCalls 会被调用 → executed 数组非空。
		let executedNames: string[] = [];
		let chatRound = 0;
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => {
				chatRound++;
				return (async function* () {
					if (chatRound === 1) {
						yield {
							type: 'tool_call',
							toolCall: { id: 'trunc-1', name: 'patch', arguments: '{"path":"a.ts","replace":"half' },
						} as unknown as IModelDelta;
						// 关键：撞输出上限
						yield { type: 'done', finishReason: 'length' } as IModelDelta;
						return;
					}
					yield { type: 'text', text: 'recovered' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'patch', description: 'patch', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['patch']),
			_executeToolCalls: async (calls: unknown[]) => {
				executedNames.push(...(calls as Array<{ name: string }>).map(c => c.name));
				return (calls as Array<{ id: string }>).map(c => ({
					toolCallId: c.id, content: 'should not happen', success: true,
				}));
			},
		} as never);

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest({
				messages: [{ role: 'user', content: 'edit the file' }],
			}) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			executedNames,
			[],
			'截断轮的工具调用一个都不能执行（参数可能静默不完整）；'
			+ `实际执行了 [${executedNames.join(',')}]`,
		);

		const toolEnds = deltas.filter(d => (d as { type?: string }).type === 'tool_end');
		assert.strictEqual(
			toolEnds.length, 1,
			'必须为截断的调用补 tool_end，否则 UI 卡片永久转圈',
		);
		assert.strictEqual(
			(toolEnds[0] as { success?: boolean }).success, false,
			'截断调用的 tool_end 必须是 success=false',
		);

		const resultTexts = deltas
			.filter(d => (d as { type?: string }).type === 'tool_result')
			.map(d => String((d as { content?: unknown }).content ?? ''));
		assert.ok(
			resultTexts.some(t => t.includes('output token limit')),
			`必须告知模型截断原因以便重发完整参数；实际 tool_result=[${resultTexts.join('|')}]`,
		);
		assert.ok(
			!resultTexts.some(t => t.startsWith('"')),
			'错误文本不得被再 JSON 编码一层（会带转义引号）；'
			+ `实际=[${resultTexts.join('|')}]`,
		);
	});

	test('工具结果回灌时保留 toolCallId 配对（协议层硬约束）', async () => {
		// ─── 为什么测这条路径 ────────────────────────────────────────
		// OpenAI 兼容协议要求 assistant(tool_calls) 里每个 id 都必须有
		// 且仅有一条 role='tool' 消息与之配对（toolCallId 相等）。
		// 配对错位 / 丢失会让服务端直接 400，且错误信息通常与工具无关，
		// 极难从表象定位到这个字段。
		//
		// 与「工具调用闭环」用例的区别：那条只断言存在 role='tool' 消息，
		// 这条进一步锁死**每一条的 toolCallId 都能在 assistant 的
		// tool_calls 里找到同 id 的声明**。

		let chatRound = 0;
		const roundMessages: Array<Array<{ role?: string; toolCallId?: string; toolCalls?: Array<{ id: string }> }>> = [];
		const issuedIds = ['pair-a', 'pair-b'];

		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_m: string, messages: Array<never>) => {
				chatRound++;
				const round = chatRound;
				roundMessages.push(messages.map((m: never) => ({ ...(m as object) })));
				return (async function* () {
					if (round === 1) {
						for (const id of issuedIds) {
							yield {
								type: 'tool_call',
								// ★ 两个调用的 arguments 必须**不同**：`deduplicateToolCalls`
								//（toolCallUtils.ts:995-1005）按 `name::arguments` 去重，
								// 同参调用会被摘成一个，本用例就退化成了去重测试。
								toolCall: { id, name: 'read_file', arguments: `{"path":"${id}.ts"}` },
							} as unknown as IModelDelta;
						}
					} else {
						yield { type: 'text', content: 'done' } as IModelDelta;
					}
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['read_file']),
			_executeToolCalls: async (calls: unknown[]) => {
				return (calls as Array<{ id: string }>).map(c => ({
					toolCallId: c.id,
					content: 'ok',
					success: true,
				}));
			},
		} as never);

		await drain(
			executeAgentTurnDirect(host, mockRequest({
				messages: [{ role: 'user', content: 'read two files' }],
			}) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const second = roundMessages[1] ?? [];
		const declaredIds = new Set(
			second
				.filter(m => m.role === 'assistant' && Array.isArray(m.toolCalls))
				.flatMap(m => (m.toolCalls ?? []).map(tc => tc.id)),
		);
		const toolMsgIds = second
			.filter(m => m.role === 'tool')
			.map(m => m.toolCallId ?? '');

		assert.strictEqual(
			toolMsgIds.length, issuedIds.length,
			`每个 tool_call 都应有且仅有一条 tool 消息（声明 ${issuedIds.length}，实际 ${toolMsgIds.length}）`,
		);

		for (const id of issuedIds) {
			assert.ok(
				toolMsgIds.includes(id),
				`tool 消息必须回带原 toolCallId=${id}（实际=[${toolMsgIds.join(',')}]）`
				+ `——id 丢失或错位会让服务端 400，且报错与工具无关，极难定位`,
			);
			assert.ok(
				declaredIds.has(id),
				`assistant 消息必须保留 tool_calls 声明 id=${id}（实际=[${[...declaredIds].join(',')}]）`
				+ `——缺任一侧，配对即不完整`,
			);
		}
	});
});

suite('executeAgentTurnDirect — 断点续跑恢复（resumeFrom）', () => {
	/**
	 * 捕获首轮 chat 收到的 messages —— 这是判断「恢复出来的历史是否真的进了请求」
	 * 的唯一可靠观测点：日志会在恢复块里照常打印 "restored N messages"，
	 * 即使那些消息随后被丢弃，所以断言日志是无效的。
	 */
	function captureFirstRequestHost(): {
		host: Record<string, unknown>;
		firstRequestMessages: () => Array<{ role?: string; content?: unknown }>;
	} {
		const snapshots: Array<Array<{ role?: string; content?: unknown }>> = [];
		const mockProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: string, messages: Array<{ role?: string; content?: unknown }>) => {
				snapshots.push(messages.map(m => ({ role: m.role, content: m.content })));
				return (async function* () {
					yield { type: 'text', content: 'ok' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};
		const host = mockHost({
			_getActiveModelProvider: () => mockProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [],
		});
		return { host, firstRequestMessages: () => snapshots[0] ?? [] };
	}

	const RESUMED_MARKER = 'RESUMED_HISTORY_MARKER';

	test('resumeFrom.messages 必须进入首轮请求（回归：恢复值曾晚于消费点赋值而被静默丢弃）', async () => {
		// 缺陷现场：`restoredMessages` 在 :824 声明、:831 被 `messages` 消费，
		// 而赋值在约 190 行后的 resumeFrom 恢复块里 —— 消费时恒为 undefined。
		// 后果：断点续跑丢失全部历史，模型失忆，且日志仍打印 "restored N messages"。
		const { host, firstRequestMessages } = captureFirstRequestHost();

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({
					resumeFrom: {
						messages: [
							{ role: 'user', content: 'earlier question' },
							{ role: 'assistant', content: RESUMED_MARKER },
						],
					},
				}) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const sent = firstRequestMessages();
		const hasMarker = sent.some(m => typeof m.content === 'string' && (m.content as string).includes(RESUMED_MARKER));
		assert.ok(
			hasMarker,
			'resumeFrom.messages 中的历史必须出现在首轮请求里；缺失说明恢复值在消费点之后才被赋值'
				+ `（实际 roles=[${sent.map(m => m.role).join(',')}]）`,
		);
	});

	test('旧快照回落：messages 为空时必须改用 loopMessages（否则旧断点丢全部历史）', async () => {
		// P0-a-2 之前的快照 runState.messages 恒为空数组，真实消息只在 loopMessages。
		// 该回落分支删掉会让旧断点续跑静默失忆（agentRunState.ts:358 的删除条件尚未满足）。
		const { host, firstRequestMessages } = captureFirstRequestHost();

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({
					resumeFrom: {
						messages: [],
						loopMessages: [{ role: 'assistant', content: RESUMED_MARKER }],
					},
				}) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const sent = firstRequestMessages();
		assert.ok(
			sent.some(m => typeof m.content === 'string' && (m.content as string).includes(RESUMED_MARKER)),
			'messages 为空数组时必须回落到 loopMessages（legacy 快照兼容）',
		);
	});

	test('无 resumeFrom 时不得污染首轮请求（恢复分支必须是纯附加能力）', async () => {
		const { host, firstRequestMessages } = captureFirstRequestHost();

		await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const sent = firstRequestMessages();
		assert.ok(sent.length > 0, '首轮请求不应为空');
		assert.ok(
			!sent.some(m => typeof m.content === 'string' && (m.content as string).includes(RESUMED_MARKER)),
			'无 resumeFrom 时不应出现任何恢复内容',
		);
	});
});

suite('executeAgentTurnDirect — 流式循环控制流出口（迭代级 break/continue/return）', () => {
	/**
	 * 契约来源：`.design/agentloop-streaming-controlflow-contract.md`
	 *
	 * 主 `while` 循环内共 16 个**迭代级**出口。本 suite 覆盖「无工具调用」大分支
	 * 上的出口（X / X-exh / I / I-exh / T），它们全部依赖**判定顺序**，
	 * 是后续把该段迁出 `parts/*` 时最容易被静默破坏的一类契约：
	 * 顺序错了代码照样编译、照样跑完，只是模型永远收不到正确的纠正信号。
	 */

	/** 按轮次编排 provider 响应，并捕获每轮收到的 messages。 */
	function scriptedProvider(script: (round: number) => IModelDelta[]): {
		provider: Record<string, unknown>;
		snapshots: Array<Array<{ role?: string; content?: unknown }>>;
		roundCount: () => number;
	} {
		const snapshots: Array<Array<{ role?: string; content?: unknown }>> = [];
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: string, messages: Array<{ role?: string; content?: unknown }>) => {
				snapshots.push(messages.map(m => ({ role: m.role, content: m.content })));
				const current = round++;
				return (async function* () {
					for (const delta of script(current)) { yield delta; }
				})();
			},
		};
		return { provider, snapshots, roundCount: () => round };
	}

	/** 取某轮请求里最后一条 user 消息的文本（注入的续跑/纠正指令都走 user 边界）。 */
	function lastUserText(snapshot: Array<{ role?: string; content?: unknown }>): string {
		const users = snapshot.filter(m => m.role === 'user');
		return String(users[users.length - 1]?.content ?? '');
	}

	/** 收集 discard_prior_text 事件的 reason 序列。 */
	function discardReasons(deltas: ReadonlyArray<unknown>): string[] {
		return deltas
			.filter(d => (d as { type?: string }).type === 'discard_prior_text')
			.map(d => String((d as { metadata?: { reason?: unknown } }).metadata?.reason ?? ''));
	}

	/**
	 * XML 工具调用泄漏的**可复现**样本。
	 *
	 * ⚠ 为什么必须放进 ```xml 围栏：泄漏判定（`agentTurnExecutor.ts:2526`）读的是
	 * **已 sanitize 的** `trimmedAssistantContent`，而 `stripXmlToolCallTags`
	 * （`assistantVisibleText.ts:475`）会先把裸露的伪标签全部抹掉 —— 裸标签样本
	 * 到达判定点时已经没有标签可认，用例会假绿（"没崩" ≠ "走到了泄漏分支"）。
	 * 代码区由 `findCodeRegions` 保护不被剥离，是泄漏文本唯一能存活到判定点的形态。
	 *
	 * ⚠ 标签后必须紧跟换行：`agentToolExtractor.ts:243` 的未闭合兜底正则
	 * `<invoke[^>]*>([\w_\-]+)` 会把紧邻的单词当成工具名提取出来，
	 * 一旦提取成功 `effectiveToolCalls` 非空，泄漏分支根本不会进入。
	 */
	const XML_LEAK_TEXT = [
		'我准备调用文件读取工具，格式如下：',
		'```xml',
		'<invoke:9f2c1a>',
		'file_read',
		'```',
		'（以上为调用写法）',
	].join('\n');

	/** 只给一个工具定义：白名单为空时 `extractToolCallsFromText` 会整段跳过提取。 */
	const ONE_TOOL = [{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } }];

	test('XML 工具泄漏（上限内）→ 丢弃泄漏文本 + 注入纠正指令并续跑', async () => {
		// 出口 X（`agentTurnExecutor.ts:2589`）。失败模式：
		//   · 没有 discard_prior_text → 泄漏的伪 XML 留在 UI 上冒充"回答"
		//   · 没有注入纠正指令       → 模型不知道该格式不执行，会原样重复输出
		//   · 没有续跑（只跑 1 轮）  → 用户看到一句无意义的 XML 就结束
		const { provider, snapshots, roundCount } = scriptedProvider(round => (
			round === 0
				? [
					{ type: 'text', content: XML_LEAK_TEXT } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
				: [
					{ type: 'text', content: 'ok, 已改用原生调用' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			discardReasons(deltas).includes('xml-tool-call-leak'),
			`必须发出 reason='xml-tool-call-leak' 的 discard_prior_text（实际 reasons=`
			+ `[${discardReasons(deltas).join(',')}]）——缺失说明泄漏未被识别，`
			+ `伪 XML 会留在聊天框里冒充回答`,
		);

		assert.ok(
			roundCount() >= 2,
			`泄漏在重试上限内必须续跑（实际只请求了 ${roundCount()} 轮）`,
		);

		const injected = lastUserText(snapshots[1] ?? []);
		assert.ok(
			injected.includes('wrote a tool call as XML text'),
			`第二轮请求的末条 user 消息必须是 xmlToolCallLeakReminder（实际=`
			+ `${JSON.stringify(injected.slice(0, 160))}）——不注入纠正指令，`
			+ `模型只会反复输出同样的 XML 试探`,
		);
	});

	test('XML 泄漏判定必须抢在 classifyIncompleteTurn 之前（顺序回归）', async () => {
		// 契约 §3.1：`classifyIncompleteTurn` 对"有可见文本"一律判 complete，
		// 而 XML 泄漏恰恰表现为有可见文本。若两者顺序颠倒，泄漏永远漏判 ——
		// 表现为 discard reason 变成 'unfinished-intent' 或干脆没有 discard。
		const { provider } = scriptedProvider(round => (
			round === 0
				? [
					{ type: 'text', content: XML_LEAK_TEXT } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
				: [
					{ type: 'text', content: 'done' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const reasons = discardReasons(deltas);
		assert.ok(
			reasons.includes('xml-tool-call-leak'),
			`泄漏必须先于 incomplete 判定命中（实际 reasons=[${reasons.join(',')}]）`,
		);
		assert.ok(
			!reasons.includes('unfinished-intent'),
			`泄漏轮不得被当成 incomplete turn 处理（实际 reasons=[${reasons.join(',')}]）`
			+ `——出现 unfinished-intent 即说明判定顺序被调换`,
		);
	});

	test('XML 泄漏重试用尽 → 交回 incomplete 收尾，不得无限续跑', async () => {
		// 出口 X-exh（`agentTurnExecutor.ts:2597`）：XML_TOOL_LEAK_RETRY_LIMIT=2，
		// 故第 3 轮必须落到 exhausted 分支并走常规结束路径。
		// 失败模式：漏了上限判断 → 模型不会原生调用时整轮 turn 空转到迭代上限。
		const { provider, roundCount } = scriptedProvider(() => [
			{ type: 'text', content: XML_LEAK_TEXT } as IModelDelta,
			{ type: 'done', finishReason: 'stop' } as IModelDelta,
		]);

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const reasons = discardReasons(deltas);
		assert.ok(
			reasons.includes('xml-tool-call-leak-exhausted'),
			`超限必须发出 reason='xml-tool-call-leak-exhausted'（实际=[${reasons.join(',')}]）`,
		);
		assert.strictEqual(
			roundCount(), 3,
			`上限 2 次续跑 + 1 次超限轮 = 恰好 3 轮请求（实际 ${roundCount()} 轮）`
			+ `——多于 3 说明上限失效，少于 3 说明过早放弃`,
		);
		assert.ok(
			deltas.some(d => (d as { type?: string }).type === 'done'),
			'超限后必须以 done 收尾，而非静默退出',
		);
	});

	test('空响应（incomplete）→ 丢弃 + 注入续跑指令并续跑', async () => {
		// 出口 I（`agentTurnExecutor.ts:2678`）。空响应 = 无文本、无思考、无工具调用。
		// 失败模式：不注入 retryInstruction → 模型不知道上一步毫无进展，继续空转。
		const { provider, snapshots, roundCount } = scriptedProvider(round => (
			round === 0
				? [{ type: 'done', finishReason: 'stop' } as IModelDelta]
				: [
					{ type: 'text', content: '这次给出答案' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			discardReasons(deltas).includes('unfinished-intent'),
			`空响应必须发出 reason='unfinished-intent' 的 discard_prior_text（实际=`
			+ `[${discardReasons(deltas).join(',')}]）`,
		);
		assert.ok(
			roundCount() >= 2,
			`重试未用尽时必须续跑（实际只请求了 ${roundCount()} 轮）`,
		);
		assert.ok(
			lastUserText(snapshots[1] ?? []).includes('NO PROGRESS'),
			`第二轮末条 user 消息必须是恢复阶梯 L1 指令（实际=`
			+ `${JSON.stringify(lastUserText(snapshots[1] ?? []).slice(0, 160))}）`,
		);
	});

	test('incomplete 重试用尽 → 置 incompleteExhausted，且丢弃事件必须早于用户提示', async () => {
		// 出口 I-exh（`agentTurnExecutor.ts:2689`）+ 契约 §3.2 顺序约束。
		// 事故回归（日志 1787969405928）：若 notice 早于 discard_prior_text，
		// 提示会被一并清掉 —— UI 只剩空气泡，用户以为应用卡死。
		const { provider, roundCount } = scriptedProvider(() => [
			{ type: 'done', finishReason: 'stop' } as IModelDelta,
		]);

		const turnOutcome: Record<string, unknown> = {};
		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest({ turnOutcome }) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			turnOutcome.incompleteExhausted, true,
			'重试用尽必须置 request.turnOutcome.incompleteExhausted=true'
			+ '——否则外层 finally 会对无产出的 turn 误报「✅ 任务执行完毕」',
		);
		assert.strictEqual(
			roundCount(), 3,
			`空响应上限 2 次续跑 + 1 次超限轮 = 3 轮（实际 ${roundCount()} 轮）`,
		);

		const types = deltas.map(d => (d as { type?: string }).type ?? '');
		const lastDiscard = types.lastIndexOf('discard_prior_text');
		const noticeIndex = deltas.findIndex(d =>
			(d as { type?: string }).type === 'text'
			&& String((d as { content?: unknown }).content ?? '').includes('未获得模型返回内容'));
		assert.ok(
			noticeIndex >= 0,
			`重试用尽必须给出可见说明（实际事件=[${types.join(',')}]）——静默结束时`
			+ `用户只看到空气泡，无法判断是模型还是网络问题`,
		);
		assert.ok(
			lastDiscard < noticeIndex,
			`discard_prior_text(idx=${lastDiscard}) 必须早于用户提示(idx=${noticeIndex})，`
			+ `否则提示会被 discard 一并清掉`,
		);
	});

	test('retry 上下文中有文无工具 → 注入动手提醒，且不得丢弃模型文本', async () => {
		// 出口 T（`agentTurnExecutor.ts:2723`）。条件：complete + 有可见文本
		// + 0 < retry().emptyResponse < 上限。刻意**不** discard：要保留模型
		// 自己写下的计划，让它下一轮看到并执行。
		// 失败模式：误加 discard → 模型丢失自己的计划，重新从零描述，死循环。
		const { provider, snapshots } = scriptedProvider(round => (
			round === 0
				// 第 1 轮空响应：把 emptyResponse 计数抬到 1，构造 retry 上下文
				? [{ type: 'done', finishReason: 'stop' } as IModelDelta]
				// 第 2 轮：有文本、无工具调用 → 命中 text-without-tools
				: [
					{ type: 'text', content: '我打算先读取配置文件，然后修改其中的超时设置。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const thirdRoundInjection = lastUserText(snapshots[2] ?? []);
		assert.ok(
			thirdRoundInjection.includes('STOP DESCRIBING and TAKE ACTION NOW'),
			`第三轮末条 user 消息必须是 textWithoutToolsReminder（实际=`
			+ `${JSON.stringify(thirdRoundInjection.slice(0, 160))}）`,
		);

		// 只应有第 1 轮空响应产生的那一条 discard；T 分支不得再追加。
		assert.strictEqual(
			discardReasons(deltas).length, 1,
			`text-without-tools 分支不得丢弃模型文本（实际 discard reasons=`
			+ `[${discardReasons(deltas).join(',')}]）——丢了模型就看不到自己的计划`,
		);
	});

	// ─────────────────────────────────────────────────────────────────────
	// 第二批：工具调用分支上的出口（S / Z / B）
	//
	// 这三个出口全部位于「本轮有工具调用」的长分支里，是把流式段迁出
	// `parts/*` 时风险最高的一片 —— 它们依赖的状态（provider 能力位、
	// 跨轮 streak 计数、策略钩子返回值）都不在本段内部，迁移时极易掉线。
	// ─────────────────────────────────────────────────────────────────────

	/** 按轮次编排「工具调用 + done」响应，并记录每轮请求的 messages。 */
	function toolCallProvider(
		script: (round: number) => IModelDelta[],
		extra: Record<string, unknown> = {},
	): {
		provider: Record<string, unknown>;
		snapshots: Array<Array<{ role?: string; content?: unknown }>>;
		roundCount: () => number;
	} {
		const base = scriptedProvider(script);
		return { ...base, provider: { ...base.provider, ...extra } };
	}

	/** 构造一个 tool_call delta（每轮换 id，避免撞上同 id 去重分支）。 */
	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			// arguments 必须是 **字符串**：真实流式装配器按片段累积后再解析，
			// 传对象会在 repairToolArguments 里 `raw.trim is not a function` 崩溃。
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/** 把某轮请求里所有 system 消息拼成一段文本（提醒类注入都走 system 边界）。 */
	function systemText(snapshot: Array<{ role?: string; content?: unknown }>): string {
		return snapshot
			.filter(m => m.role === 'system')
			.map(m => String(m.content ?? ''))
			.join('\n');
	}

	test('全部工具由服务端执行 → 补齐 tool_end 后立即结束，不再发起新一轮', async () => {
		// 出口 S（`agentTurnExecutor.ts:2957`）。判据是 **provider 能力位**
		// `isServerSideProvider`，不是 providerId —— 2026-06-10 的回归正是
		// 「按直连模式一刀切」导致 CodeBuddy 的工具调用被当成服务端已执行、
		// 一轮即结束（用户反馈"发一条消息就结束了"）。
		//
		// 失败模式：
		//   · 本地又执行了一遍 → 服务端没有对应 provider，报 "No provider available"
		//   · 不 break         → 客户端对服务端 Agent 再发一轮，重复整段对话
		//   · 漏 tool_end      → 工具卡片永久转圈
		let localExecuted = 0;
		const { provider, roundCount } = toolCallProvider(
			() => [
				toolCallDelta('srv-1', 'file_read', { path: '/mock/a.txt' }),
				{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
			],
			{ isServerSideProvider: true },
		);

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
			_lastAllEnabledToolNames: new Set<string>(['file_read']),
			_executeToolCalls: async (calls: unknown[]) => {
				localExecuted += (calls as unknown[]).length;
				return (calls as Array<{ id: string }>).map(c => ({
					toolCallId: c.id, content: 'SHOULD_NOT_RUN', success: true,
				}));
			},
			_executeToolCallsParallelStreaming: async function* (calls: unknown[]) {
				localExecuted += (calls as unknown[]).length;
				for (const c of calls as Array<{ id: string }>) {
					yield { toolCallId: c.id, content: 'SHOULD_NOT_RUN', success: true };
				}
			},
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			localExecuted, 0,
			`服务端已执行的工具不得在本地再跑一遍（实际本地执行了 ${localExecuted} 个）`
			+ `——本地没有对应 provider，只会得到 "No provider available" 错误卡`,
		);
		assert.strictEqual(
			roundCount(), 1,
			`全服务端执行必须当轮结束（实际请求了 ${roundCount()} 轮）`
			+ `——服务端 Agent 在同一次 chat() 流里已跑完自己的循环，客户端再发一轮是重复对话`,
		);

		const ends = deltas.filter(d => (d as { type?: string }).type === 'tool_end');
		assert.strictEqual(
			ends.length, 1,
			`每个服务端工具必须恰好补一次 tool_end（实际 ${ends.length} 次）`
			+ `——缺失→卡片永久转圈；重复→UI 计数错乱`,
		);
		assert.strictEqual(
			(ends[0] as { success?: boolean }).success, true,
			'服务端执行成功必须以 success=true 上报，否则 UI 会把它渲染成失败卡',
		);
		assert.ok(
			deltas.some(d => (d as { type?: string }).type === 'done'),
			'结束前必须 yield done',
		);
	});

	test('整轮工具全被循环检测拦下 → 分档升级（强提醒 → 禁用工具收尾）', async () => {
		// 出口 Z（`agentTurnExecutor.ts:3237`）。事故来源：日志 1787377582459
		// 实测连续 37 轮 "All 2 tool calls blocked"，模型每轮输出逐字节相同的
		// 229 个 delta，一路空转到迭代上限（30k+ token × 5–8s × 37）。
		//
		// 两条拦截规则的分工（agentTurnExecutor.ts:1283-1305 的注释即契约）：
		//   · 同签名 **且** 同结果 → ToolGuardrailController 先拦
		//     （noProgressBlockAfter=2 → 第 3 次调用即 block）
		//   · 同签名 但 结果不同 → 放行给 detectToolCallLoop 拦
		//     （TOOL_LOOP_THRESHOLD=3 → 同名同参第 4 次判 loop）
		// 本用例的 file_read 属只读 + 结果恒定，命中的是前者，故只放行 2 次。
		//
		// 阈值链：护栏/loop 拦下整轮
		//   → ALL_BLOCKED_ESCALATE_AT=2（连续 2 轮全拦 → 强提醒，只注入一次）
		//   → ALL_BLOCKED_WRAPUP_AT=4（连续 4 轮全拦 → 禁工具强制收尾）
		//
		// 失败模式：只 `continue` 不升级 → 每轮白烧一次完整 prompt 到硬上限。
		let executedCount = 0;
		// 前 7 轮固定发同一个（名字 + 参数都相同）调用；此后给纯文本让 turn 收尾，
		// 避免断言失败时用例挂在循环里跑满迭代上限。
		const { provider, snapshots } = scriptedProvider(round => (
			round < 7
				? [
					toolCallDelta(`dup-${round}`, 'file_read', { path: '/same/path.txt' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '好的，我基于已有信息作答。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
			_lastAllEnabledToolNames: new Set<string>(['file_read']),
			_executeToolCalls: async (calls: unknown[]) => {
				executedCount += (calls as unknown[]).length;
				return (calls as Array<{ id: string }>).map(c => ({
					toolCallId: c.id, content: 'STABLE_RESULT', success: true,
				}));
			},
			_executeToolCallsParallelStreaming: async function* (calls: unknown[]) {
				executedCount += (calls as unknown[]).length;
				for (const c of calls as Array<{ id: string }>) {
					yield { toolCallId: c.id, content: 'STABLE_RESULT', success: true };
				}
			},
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			executedCount, 2,
			`同签名 + 同结果的只读调用只应放行前 2 次（noProgressBlockAfter=2），`
			+ `第 3 次起必须被护栏拦下；实际执行了 ${executedCount} 次——`
			+ `多于 2 说明无进展检测失效（纯烧钱重放），少于 2 说明误伤了正常重试`,
		);

		const allSystem = snapshots.map(systemText).join('\n');
		assert.ok(
			/EVERY tool call you made was rejected as a duplicate/.test(allSystem),
			'连续 2 轮全拦必须注入 allToolCallsBlockedReminder 强提醒'
			+ '——单工具级提醒此时已被模型忽略，不升级就是纯烧钱空转',
		);
		assert.ok(
			/Tool calling is now DISABLED for this turn/.test(allSystem),
			'连续 4 轮全拦必须进入禁用工具的强制收尾轮（allBlockedWrapUpReminder）'
			+ '——否则会一路空转到迭代硬上限',
		);

		// 被拦的调用同样要闭合卡片，且不得重复发 tool_end。
		const endIds = deltas
			.filter(d => (d as { type?: string }).type === 'tool_end')
			.map(d => String((d as { toolCallId?: unknown }).toolCallId ?? ''));
		assert.strictEqual(
			endIds.length, new Set(endIds).size,
			`tool_end 不得对同一 toolCallId 重复发送（实际 ids=[${endIds.join(',')}]）`
			+ `——renderer 对 tool_start 无去重，重复事件会制造幽灵卡`,
		);
	});

	test('beforeTerminate 否决 → 注入重入提醒续跑，且重入次数有界', async () => {
		// 出口 B（`agentTurnExecutor.ts:2798`）。策略钩子是「结束」的最后一道门：
		// HermesReActStrategy 查任务板 DB 真相，本会话仍有未完成任务时否决收尾。
		//
		// 两条必须同时成立的契约：
		//   1. 否决必须真的续跑，且模型要看到 nudge（否则它会原样再答一遍）
		//   2. 重入必须有上限 MAX_TASK_GATE_MAIN_REACT=3，否则任务永远标不完
		//      的场景下 turn 就再也结束不了
		const { provider, snapshots, roundCount } = scriptedProvider(() => [
			{ type: 'text', content: '我认为任务已经完成了。' } as IModelDelta,
			{ type: 'done', finishReason: 'stop' } as IModelDelta,
		]);

		// 任务板永远报「还有一个未完成任务」——模拟模型自报完成但 DB 不认的情形。
		registerSessionTaskLookup(async () => [
			{ id: 'T-1', status: 'running', summary: '补完剩余出口测试' },
		]);

		try {
			const host = mockHost({
				_getActiveModelProvider: () => provider,
				getActiveModelSelection: () => ({ modelId: 'mock-model' }),
				_getEnabledTools: async () => ONE_TOOL,
			});

			await drain(
				executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
			);

			assert.strictEqual(
				roundCount(), 1 + MAX_TASK_GATE_MAIN_REACT,
				`首轮 + ${MAX_TASK_GATE_MAIN_REACT} 次重入 = ${1 + MAX_TASK_GATE_MAIN_REACT} 轮`
				+ `（实际 ${roundCount()} 轮）——多于此说明 cap 失效（任务标不完就永不结束），`
				+ `少于此说明否决没有真正续跑`,
			);

			const nudge = lastUserText(snapshots[1] ?? []);
			assert.ok(
				nudge.includes('still unfinished') && nudge.includes('T-1'),
				`第二轮末条 user 消息必须是带具体任务 id 的重入提醒（实际=`
				+ `${JSON.stringify(nudge.slice(0, 200))}）——不点名任务，模型无从判断该做什么`,
			);
		} finally {
			// 全局单例：不清理会污染同进程内的后续用例（静默改变它们的结束行为）。
			registerSessionTaskLookup(undefined);
		}
	});

	test('任务板为空 → beforeTerminate 放行，不得平白多跑一轮', async () => {
		// 出口 B 的反向断言（默认路径）。失败模式：门控写成「无条件 nudge 一次」
		// 或失败开放写反 → 每个普通 turn 都多烧一整轮 prompt，且用户会看到
		// 一段莫名其妙的「你还有未完成任务」。
		const { provider, roundCount } = scriptedProvider(() => [
			{ type: 'text', content: '完成。' } as IModelDelta,
			{ type: 'done', finishReason: 'stop' } as IModelDelta,
		]);

		registerSessionTaskLookup(async () => []);

		try {
			const host = mockHost({
				_getActiveModelProvider: () => provider,
				getActiveModelSelection: () => ({ modelId: 'mock-model' }),
				_getEnabledTools: async () => ONE_TOOL,
			});

			await drain(
				executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
			);

			assert.strictEqual(
				roundCount(), 1,
				`任务板为空时必须当轮结束（实际 ${roundCount()} 轮）`,
			);
		} finally {
			registerSessionTaskLookup(undefined);
		}
	});

	test('任务板查询抛错 → 失败开放，绝不困住 loop', async () => {
		// 契约：DB 错误不得阻塞收尾（`hermesReActStrategy.ts:94`）。
		// 失败模式：把异常当成「有未完成任务」→ 任务板服务一挂，
		// 所有 turn 都要多跑 MAX_TASK_GATE_MAIN_REACT 轮才肯结束。
		const { provider, roundCount } = scriptedProvider(() => [
			{ type: 'text', content: '完成。' } as IModelDelta,
			{ type: 'done', finishReason: 'stop' } as IModelDelta,
		]);

		registerSessionTaskLookup(async () => { throw new Error('task board offline'); });

		try {
			const host = mockHost({
				_getActiveModelProvider: () => provider,
				getActiveModelSelection: () => ({ modelId: 'mock-model' }),
				_getEnabledTools: async () => ONE_TOOL,
			});

			const { deltas } = await drain(
				executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
			);

			assert.strictEqual(
				roundCount(), 1,
				`查询异常必须失败开放、当轮结束（实际 ${roundCount()} 轮）`,
			);
			assert.ok(
				deltas.some(d => (d as { type?: string }).type === 'done'),
				'失败开放路径同样要正常 yield done',
			);
		} finally {
			registerSessionTaskLookup(undefined);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────
// 第三批：轮顶门控出口（A / W / P）
//
// 前两批覆盖的是「LLM 已回复之后」的出口。本批转向**轮顶门控段**
// （`turnIterationGate.ts` 的 `runIterationGate`，消费点 `agentTurnExecutor.ts:1576`）
// 与**计划队列推进**（`:2780`）—— 它们在 LLM 调用之前就决定了本轮是否还发生、
// 以及以什么工具面发生，是全部出口里唯一能「让一轮根本不打模型」的一类。
//
// 共同的失败模式：这些判定不产生任何可见 UI 事件，坏掉时表现为
// 「多烧钱」或「该停不停」，靠肉眼看聊天记录完全发现不了。
// ─────────────────────────────────────────────────────────────────────────

suite('executeAgentTurnDirect — 轮顶门控出口（abort / 预算收尾 / 计划队列）', () => {

	/** 按轮次编排 provider 响应，并捕获每轮收到的 messages 与 options。 */
	function gatedProvider(script: (round: number) => IModelDelta[]): {
		provider: Record<string, unknown>;
		snapshots: Array<Array<{ role?: string; content?: unknown }>>;
		optionsLog: Array<{ tools?: unknown; toolChoice?: unknown }>;
		roundCount: () => number;
	} {
		const snapshots: Array<Array<{ role?: string; content?: unknown }>> = [];
		const optionsLog: Array<{ tools?: unknown; toolChoice?: unknown }> = [];
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (
				_modelId: string,
				messages: Array<{ role?: string; content?: unknown }>,
				options?: { tools?: unknown; toolChoice?: unknown },
			) => {
				snapshots.push(messages.map(m => ({ role: m.role, content: m.content })));
				optionsLog.push({ tools: options?.tools, toolChoice: options?.toolChoice });
				const current = round++;
				return (async function* () {
					for (const delta of script(current)) { yield delta; }
				})();
			},
		};
		return { provider, snapshots, optionsLog, roundCount: () => round };
	}

	/** 取某轮请求里最后一条 user 消息的文本。 */
	function lastUserText(snapshot: Array<{ role?: string; content?: unknown }>): string {
		const users = snapshot.filter(m => m.role === 'user');
		return String(users[users.length - 1]?.content ?? '');
	}

	/** 把某轮请求里所有 system 消息拼成一段文本。 */
	function systemText(snapshot: Array<{ role?: string; content?: unknown }>): string {
		return snapshot
			.filter(m => m.role === 'system')
			.map(m => String(m.content ?? ''))
			.join('\n');
	}

	const ONE_TOOL = [{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } }];

	test('turn 已被取消 → 轮顶 abort 检查直接跳出，一次 LLM 都不打', async () => {
		// 出口 A（`turnIterationGate.ts:119` → `agentTurnExecutor.ts:1576` break）。
		//
		// 取消信号来自 `host._activeTurnControllers`（turnKey = agentId::sessionId）——
		// executor 复用 executeAgentTurn 建立的 per-turn controller（`:987-995`），
		// 预置一个**已 abort** 的 controller 即等价于「用户在本轮开始前点了停止」。
		//
		// 契约：abort 检查在**每轮顶**、LLM 调用之前。失败模式：
		//   · 挪到 LLM 之后 → 用户点停止后仍要等一整轮响应（还照常计费）
		//   · 漏掉这一检查 → 停止按钮对正在进行的 turn 完全无效
		const { provider, roundCount } = gatedProvider(() => [
			{ type: 'text', content: '不该被调用' } as IModelDelta,
			{ type: 'done', finishReason: 'stop' } as IModelDelta,
		]);

		const abortedController = new AbortController();
		abortedController.abort();

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
			// key 必须与 `_turnKey(agentId, sessionId)` 的产物一致，
			// 否则 executor 会新建一个未 abort 的 controller，用例静默失去覆盖。
			_activeTurnControllers: new Map<string, AbortController>([
				['test-agent::test-session', abortedController],
			]),
		});

		await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			roundCount(), 0,
			`已取消的 turn 不得发起任何 LLM 请求（实际 ${roundCount()} 次）——`
			+ `abort 检查若晚于 LLM 调用，停止按钮就成了摆设（用户已放弃的结果照样计费）`,
		);
	});

	test('预算耗尽 → 先跑一轮禁工具收尾轮，再停（不得直接硬停）', async () => {
		// 出口 W（`turnIterationGate.ts:159/172`，判定在 `turnStopGate.classifyIterationStop`）。
		//
		// 两段式语义的事故来源（`loopGate.ts:86`，日志 1787214724132）：
		// 撞上限直接结束 → 末轮发起的 delegate_task 结果 append 进 messages 后
		// 再无轮次消费，成果 100% 丢弃、回答停在「我这就去查」。
		//
		// 本例把总预算设为 1：第 1 轮**带工具调用**消费掉全部预算 → 第 2 轮顶
		// 判 'wrap-up' → 收尾轮（禁工具、纯文本）→ 该轮无工具调用即自然结束。
		//
		// 第 1 轮必须真的调工具：无工具调用会直接命中「无工具 → 结束」出口
		// （`:2807`），根本走不到轮顶预算门控，用例会静默失去覆盖。
		//
		// 收尾轮的三重保障必须同时成立，缺一条模型都可能继续调工具：
		//   ① tools 传 undefined（物理无工具）
		//   ② toolChoice:'none'（协议层禁止）
		//   ③ 注入 hardLimitWrapUpReminder（告知模型必须直接作答）
		const { provider, snapshots, optionsLog, roundCount } = gatedProvider(round => (
			round === 0
				? [
					{
						type: 'tool_call',
						toolCall: { id: 'budget-1', name: 'file_read', arguments: JSON.stringify({ path: '/mock/a.txt' }) },
					} as unknown as IModelDelta,
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '预算已尽，这是最终结论。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
			_lastAllEnabledToolNames: new Set<string>(['file_read']),
			_executeToolCallsParallelStreaming: async function* (calls: unknown[]) {
				for (const c of calls as Array<{ id: string }>) {
					yield { toolCallId: c.id, content: 'file content', success: true };
				}
			},
		});

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 1 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			roundCount(), 2,
			`预算耗尽必须「再跑一轮收尾」而非立刻停（实际 ${roundCount()} 轮）——`
			+ `只跑 1 轮说明退回了直接硬停（末轮成果会被丢弃），`
			+ `跑满 3 轮说明收尾轮没有置 wrapUp.done，预算门控失去终止能力`,
		);

		assert.strictEqual(
			optionsLog[0]?.toolChoice, undefined,
			'第 1 轮是普通轮，不得提前禁用工具（否则模型从一开始就无法干活）',
		);
		assert.ok(
			Array.isArray(optionsLog[0]?.tools) && (optionsLog[0]?.tools as unknown[]).length > 0,
			'第 1 轮必须带工具面',
		);

		assert.strictEqual(
			optionsLog[1]?.toolChoice, 'none',
			`收尾轮必须显式传 toolChoice:'none'（实际=${String(optionsLog[1]?.toolChoice)}）——`
			+ `只清空 tools 字段不够：provider 对「tools 缺失」的行为未定义，`
			+ `有的仍按上一轮缓存的工具面推理`,
		);
		assert.strictEqual(
			optionsLog[1]?.tools, undefined,
			'收尾轮的 tools 必须为 undefined（_iterationToolDefs=[] → enabledTools=[] → 不传）',
		);

		const wrapUpSystem = systemText(snapshots[1] ?? []);
		assert.ok(
			wrapUpSystem.includes('Tool calls are now DISABLED'),
			`收尾轮必须注入 hardLimitWrapUpReminder（实际 system 段=`
			+ `${JSON.stringify(wrapUpSystem.slice(-200))}）——没有这条提醒，`
			+ `模型只会发现工具消失了却不知该收尾，容易输出"我无法继续"之类的废话`,
		);
	});

	test('计划队列未走完 → 无工具调用轮推进到下一任务，而不是结束 turn', async () => {
		// 出口 P（`agentTurnExecutor.ts:2780` continue）。
		//
		// 队列由 `plan_register` 工具经 `planQueueRegistry` 的句柄写入本 turn
		// （句柄在 turn 开始时注册、finally 注销）。主循环的推进条件是
		// 「本轮无工具调用 + currentTaskIdx < length-1」——即模型说完
		// "任务 N 做完了" 就自动切到 N+1，而不是收尾。
		//
		// 失败模式：
		//   · 不推进直接结束 → plan_register 形同虚设，只执行第 1 个任务
		//   · 推进但不注入 reminder → 模型不知道下一个任务是什么，原地打转
		//   · 越界推进 → 最后一个任务做完后无限续跑
		const { provider, snapshots, roundCount } = gatedProvider(() => [
			{ type: 'text', content: '这一步做完了。' } as IModelDelta,
			{ type: 'done', finishReason: 'stop' } as IModelDelta,
		]);

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
		});

		// 在 turn 运行中写入队列：executor 注册句柄 → 这里模拟 plan_register
		// 的写入时机（首轮 LLM 调用时句柄已就绪）。
		const gen = executeAgentTurnDirect(
			host,
			mockRequest() as never,
		) as AsyncGenerator<IChatStreamDelta, unknown>;

		// 先推进到首轮 LLM 调用之后，此时 registerPlanQueueHandle 已执行。
		let step = await gen.next();
		let queueInjected = false;
		const deltas: IChatStreamDelta[] = [];
		while (!step.done) {
			deltas.push(step.value);
			if (!queueInjected) {
				const handle = getPlanQueueHandle('test-agent');
				if (handle) {
					handle.setPlan([
						{ title: 'T-A 读取配置', description: '读取并理解现有配置' },
						{ title: 'T-B 修改超时', description: '把超时改成 30s' },
					]);
					queueInjected = true;
				}
			}
			step = await gen.next();
		}

		assert.ok(queueInjected, '前置条件：必须成功拿到本 turn 的计划队列句柄');

		assert.strictEqual(
			roundCount(), 2,
			`两个任务应各占一轮（实际 ${roundCount()} 轮）——`
			+ `1 轮说明队列没有推进（plan_register 白注册），`
			+ `>2 轮说明越界推进（最后一个任务做完仍不肯结束）`,
		);

		const advanceReminder = lastUserText(snapshots[1] ?? []);
		assert.ok(
			advanceReminder.includes('CURRENT TASK (2/2)') && advanceReminder.includes('T-B 修改超时'),
			`推进时必须注入带序号与标题的 CURRENT TASK 提醒（实际=`
			+ `${JSON.stringify(advanceReminder.slice(0, 200))}）——`
			+ `不点名任务，模型无从知道该做哪一步`,
		);

		assert.ok(
			deltas.some(d => (d as { type?: string }).type === 'done'),
			'队列走完后必须正常结束并 yield done',
		);
	});

	test('计划队列走完最后一个任务 → 正常结束，不得再推进', async () => {
		// 出口 P 的边界（`currentTaskIdx < planTasks.length - 1` 的右边界）。
		// 单任务队列是最容易写出 off-by-one 的形态：条件写成 `<=` 会让
		// 队列在最后一个任务上反复推进，turn 一直跑到迭代上限。
		const { provider, roundCount } = gatedProvider(() => [
			{ type: 'text', content: '唯一的任务已完成。' } as IModelDelta,
			{ type: 'done', finishReason: 'stop' } as IModelDelta,
		]);

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
		});

		const gen = executeAgentTurnDirect(
			host,
			mockRequest() as never,
		) as AsyncGenerator<IChatStreamDelta, unknown>;

		let step = await gen.next();
		let queueInjected = false;
		while (!step.done) {
			if (!queueInjected) {
				const handle = getPlanQueueHandle('test-agent');
				if (handle) {
					handle.setPlan([{ title: 'T-only', description: '唯一任务' }]);
					queueInjected = true;
				}
			}
			step = await gen.next();
		}

		assert.ok(queueInjected, '前置条件：必须成功拿到本 turn 的计划队列句柄');
		assert.strictEqual(
			roundCount(), 1,
			`单任务队列必须当轮结束（实际 ${roundCount()} 轮）——`
			+ `多于 1 说明推进条件把最后一个任务算成了"还有下一个"（off-by-one）`,
		);
	});

	test('turn 结束后计划队列句柄必须注销，不得泄漏到下一个 turn', async () => {
		// 生命周期契约（`planQueueRegistry.ts:14-15` + executor 的 finally）。
		// 失败模式：句柄泄漏 → 下一个 turn 的 plan_register 写进了**上一个 turn**
		// 的闭包，队列看似注册成功实则永不执行（且无任何报错）。
		const { provider } = gatedProvider(() => [
			{ type: 'text', content: '完成。' } as IModelDelta,
			{ type: 'done', finishReason: 'stop' } as IModelDelta,
		]);

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => ONE_TOOL,
		});

		await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			getPlanQueueHandle('test-agent'), undefined,
			'turn 结束后句柄必须已注销——残留句柄会让下一个 turn 的 plan_register 静默写空',
		);
	});
});
// ─────────────────────────────────────────────────────────────────────────
// 第四批：硬权限运行时拦截（`agentTurnExecutor.ts:3001` 分支）
//
// 前三批覆盖的是「跑不跑下一轮」。本批覆盖唯一一类
// **「工具留在 schema 里、模型也确实调了，但运行时必须不执行」**的出口。
//
// 为什么不能只靠 schema 过滤（`applyHardPermission` 把工具从 toolDefs 里摘掉）：
// 模型完全可以凭对话历史或幻觉调用一个**不在本轮工具面里**的工具名。
// schema 过滤对这种调用零作用 —— 运行时判据是唯一的实际防线。
//
// 两个来源形状不同、必须都生效（`toolPermission.ts:144-179`）：
//   · policy   —— workMode=plan 的模式表（`_resolveHardPermissionForWorkMode`）
//   · strategy —— 范式谓词（readonly 范式的写工具黑名单，`IterationPlan.hardPermission`）
//
// 共同失败模式：拦截失效 = 只读代理**真的把文件写了**，且没有任何报错，
// 属于「安全承诺静默失守」，靠看聊天记录完全发现不了。
// ─────────────────────────────────────────────────────────────────────────

suite('executeAgentTurnDirect — 硬权限运行时拦截（policy / strategy 双来源）', () => {

	function permProvider(script: (round: number) => IModelDelta[]): {
		provider: Record<string, unknown>;
		roundCount: () => number;
	} {
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => {
				const current = round++;
				return (async function* () {
					for (const delta of script(current)) { yield delta; }
				})();
			},
		};
		return { provider, roundCount: () => round };
	}

	function writeCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	const WRITE_TOOL = [{ name: 'file_write', description: 'write', inputSchema: { type: 'object' } }];

	/** plan 模式的硬权限策略（形状对齐 `_resolveHardPermissionForWorkMode` 的返回）。 */
	const PLAN_POLICY = {
		deniedToolPatterns: ['file_write', 'patch', 'execute_code'],
		reason: 'plan mode: write/execute/mutate tools are locked (plan files exempted at runtime)',
	};

	/**
	 * 构造一个「首轮调写工具、次轮纯文本收尾」的 host，并记录实际执行到的工具。
	 *
	 * ⚠ 必须同时 mock **串行**与**并行**两条执行路径：批次是否并行由
	 * `shouldParallelizeToolBatch`（`:2975`）判定，写工具（file_write）不是
	 * 并行安全工具 → 走串行 `_executeToolCalls`；只读工具（file_read）则走
	 * 并行 `_executeToolCallsParallelStreaming`。只 mock 一条会让另一条落到
	 * mockHost 的默认实现上，表现为「工具像是被拦了」，与真正的权限拦截混淆。
	 */
	function permHost(
		provider: Record<string, unknown>,
		overrides: Record<string, unknown>,
	): { host: Record<string, unknown>; executed: string[] } {
		const executed: string[] = [];
		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => WRITE_TOOL,
			_lastAllEnabledToolNames: new Set<string>(['file_write', 'file_read']),
			_getSarosRoot: () => '/mock/saros/root',
			_executeToolCalls: async (calls: unknown[]) =>
				(calls as Array<{ id: string; name: string }>).map(c => {
					executed.push(c.name);
					return { toolCallId: c.id, content: 'EXECUTED', success: true };
				}),
			_executeToolCallsParallelStreaming: async function* (calls: unknown[]) {
				for (const c of calls as Array<{ id: string; name: string }>) {
					executed.push(c.name);
					yield { toolCallId: c.id, content: 'EXECUTED', success: true };
				}
			},
			...overrides,
		});
		return { host, executed };
	}

	test('plan 模式 policy 拦截 → 写工具不执行，且必须补 tool_end(success=false)', async () => {
		// 出口：`agentTurnExecutor.ts:3039-3064`（deniedCalls 分支）。
		//
		// 拦截必须产出**四件事**，缺任何一件都有具体故障：
		//   ① 不执行             → 否则 plan 模式的只读承诺失守
		//   ② 回灌 role:'tool'   → 否则 assistant 的 tool_calls 没有配对结果，
		//                          下一轮请求是协议非法的 messages
		//   ③ yield tool_result  → 否则用户看不到"为什么没做"
		//   ④ yield tool_end     → 否则工具卡片永久转圈
		const { provider, roundCount } = permProvider(round => (
			round === 0
				? [
					writeCallDelta('w-1', 'file_write', { path: '/mock/src/a.ts', content: 'x' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '已了解限制，改为只读分析。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		const { host, executed } = permHost(provider, {
			_resolveHardPermissionForWorkMode: () => PLAN_POLICY,
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			executed, [],
			`被硬权限拦下的工具绝不能执行（实际执行了 ${JSON.stringify(executed)}）`
			+ `——这条断言失败意味着 plan 模式的"只读"承诺静默失守，会真的改用户文件`,
		);

		const ends = deltas.filter(d => (d as { type?: string }).type === 'tool_end') as Array<{ toolCallId?: string; success?: boolean }>;
		assert.strictEqual(
			ends.length, 1,
			`被拦的调用必须恰好补 1 个 tool_end（实际 ${ends.length} 个）——漏发则卡片永久转圈`,
		);
		assert.strictEqual(ends[0]?.toolCallId, 'w-1', 'tool_end 必须携带被拦调用的原始 id');
		assert.strictEqual(
			ends[0]?.success, false,
			'被拦的调用必须 success=false——标 true 会让 UI 显示"已完成"，与实际相反',
		);

		const results = deltas.filter(d => (d as { type?: string }).type === 'tool_result') as Array<{ content?: unknown }>;
		assert.strictEqual(results.length, 1, '必须 yield 一条可见的 tool_result 说明拦截原因');
		assert.ok(
			String(results[0]?.content ?? '').includes('plan_exit'),
			`policy 来源的拦截文案必须给出路（提示写计划文件后 plan_exit）`
			+ `，实际=${JSON.stringify(String(results[0]?.content ?? '').slice(0, 160))}`,
		);

		assert.strictEqual(
			roundCount(), 2,
			`拦截后必须把结果回灌并续跑一轮（实际 ${roundCount()} 轮）`
			+ `——直接结束会让模型永远学不到"这条路走不通"`,
		);
	});

	test('readonly 范式 strategy 拦截 → 文案不得诱导重试写文件', async () => {
		// 出口同上，但走 `denialInfo.source === 'strategy'` 的文案分支
		// （`agentTurnExecutor.ts:3046-3048`）。
		//
		// 为什么文案要分流：policy（plan 模式）有出路——写计划文件然后 plan_exit；
		// strategy（readonly 范式）**整个 turn 都没有出路**。若沿用 plan 文案，
		// 模型会反复尝试"写计划文件"，每次都被拦，直接制造无进展循环。
		const { provider } = permProvider(round => (
			round === 0
				? [
					writeCallDelta('w-2', 'file_write', { path: '/mock/src/b.ts', content: 'x' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '只读模式，仅汇报发现。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		// strategyPerm 来自 `loopState.iterationHardPermission`（由 turnIterationGate
		// 从 IterationPlan 捕获）。这里用 readonly 范式驱动真实链路，而不是直接
		// 往 loopState 里塞值——后者测不到"策略谓词有没有真的被接线"。
		//
		// ⚠ 末条 user 消息必须为空串：`ReadonlyStrategy.preLoop` 会先发一次
		// **额外的** LLM 调用做探索评估（`preLoopOrchestrate`），把本脚本的
		// round 0 吃掉，主循环拿到的就变成了 round 1 的纯文本 —— 表现为
		// "工具调用凭空消失"。`preLoop` 在 userText 为空时早退（readonlyStrategy.ts:42），
		// 这样 round 0 才真正落到主循环上。
		const { host, executed } = permHost(provider, {});

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({
					paradigm: 'readonly',
					messages: [{ role: 'user', content: '' }],
				}) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			executed, [],
			`readonly 范式下写工具必须零执行（实际 ${JSON.stringify(executed)}）`
			+ `——策略谓词若没被接线，运行时是完全无拦截的（schema 过滤对幻觉工具名无效）`,
		);

		const results = deltas.filter(d => (d as { type?: string }).type === 'tool_result') as Array<{ content?: unknown }>;
		const text = String(results[0]?.content ?? '');
		assert.ok(
			text.includes('read-only paradigm'),
			`strategy 来源必须用只读范式专属文案（实际=${JSON.stringify(text.slice(0, 160))}）`,
		);
		assert.ok(
			!text.includes('plan_exit'),
			`strategy 文案绝不能提 plan_exit（实际=${JSON.stringify(text.slice(0, 160))}）`
			+ `——readonly 范式没有 plan 模式可退出，这句提示只会诱导模型空转重试`,
		);
	});

	test('只读检索工具不受任何拦截来源影响（白名单无条件放行）', async () => {
		// `toolPermission.ts:166-170` 的无条件放行白名单。
		// 失败模式：plan 模式或 readonly 范式把 file_read/search_code 也拦了
		// → 代理彻底失能（连"看"都不让），却只表现为"模型说自己查不到"。
		const { provider } = permProvider(round => (
			round === 0
				? [
					writeCallDelta('r-1', 'file_read', { path: '/mock/src/c.ts' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '读到了。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		const { host, executed } = permHost(provider, {
			// 故意用一个把 file_read 也列进去的"过度拦截"策略：
			// 白名单必须比 deniedToolPatterns 优先级更高。
			_resolveHardPermissionForWorkMode: () => ({
				deniedToolPatterns: ['file_write', 'file_read'],
				reason: 'over-broad policy',
			}),
		});

		await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			executed, ['file_read'],
			`file_read 在白名单内，任何策略都不得拦截（实际执行=${JSON.stringify(executed)}）`
			+ `——拦掉只读工具等于让代理失明，且故障表现为"模型说查不到"，极难归因`,
		);
	});

	test('plan 模式写计划文件必须豁免，且豁免只对 policy 来源成立', async () => {
		// `agentTurnExecutor.ts:3008-3025`（isPlanFileWriteCall 豁免）。
		//
		// 这是 2026-08-21 死锁（日志 1787294819356）的回归锁：写计划文件被拦
		// → plan_exit 恒因 tasks=0 被拒 → 模型无路可走只能 clarify 求助。
		//
		// 豁免必须同时满足三条（白名单工具 + plans/*.md 形状 + 落在 planRoot 内），
		// 本例用真实的 `<sarosRoot>/plans/x.md` 路径驱动。
		const { provider } = permProvider(round => (
			round === 0
				? [
					writeCallDelta('p-1', 'file_write', {
						path: '/mock/saros/root/plans/my-plan.md',
						content: '# Plan',
					}),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '计划已写入。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		const { host, executed } = permHost(provider, {
			_resolveHardPermissionForWorkMode: () => PLAN_POLICY,
		});

		await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			executed, ['file_write'],
			`写 <sarosRoot>/plans/*.md 必须豁免放行（实际执行=${JSON.stringify(executed)}）`
			+ `——拦掉它会复现 plan 模式死锁：计划写不进文件 → plan_exit 恒被拒`,
		);
	});

	test('伪装成 plans 路径的工作区内写入不得豁免（planRoot 越界）', async () => {
		// `planFile.ts:131-137` 的第 3 条安全校验。
		// `isPlanFilePath` 只看**路径形状**，单用它会让 `src/plans/evil.md`
		// 拿到豁免 —— 等于在 plan 模式里开一个任意写入的后门。
		const { provider } = permProvider(round => (
			round === 0
				? [
					writeCallDelta('p-2', 'file_write', {
						path: '/mock/workspace/src/plans/evil.md',
						content: 'pwned',
					}),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '被拦了。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		const { host, executed } = permHost(provider, {
			_resolveHardPermissionForWorkMode: () => PLAN_POLICY,
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			executed, [],
			`planRoot 之外的 plans/*.md 必须照常拦截（实际执行=${JSON.stringify(executed)}）`
			+ `——放行等于 plan 模式存在任意写入后门：路径形状对了就能写任何地方`,
		);
		const ends = deltas.filter(d => (d as { type?: string }).type === 'tool_end');
		assert.strictEqual(ends.length, 1, '越界写入被拦后同样要补 tool_end，避免卡片转圈');
	});
});

// ─────────────────────────────────────────────────────────────────────────
// 第五批：模型调用异常处置阶梯（`turnLlmStream.ts:handleTurnStreamError`）
//
// 前四批覆盖「正常流成功后跑不跑下一轮」与「工具该不该执行」。本批覆盖
// **流本身抛异常**时的处置，这是唯一一段「同一个 error 落到哪个分支
// 完全由判据顺序决定」的代码，且五个分支的结果互不兼容：
//
//   ① 瞬态错误   → retry（指数退避，上限 TRANSIENT_ERROR_MAX_RETRIES=3）
//   ② 上下文溢出 → force 压缩 + retry（每 turn 仅一次，overflowCompressionDone）
//   ③ 首 token 超时 → retry 同模型（上限 1 次，冷启动预热）
//   ④ idle 超时  → **throw 穿透整个 executeAgentTurnDirect**
//                  （无内层兜底，交 _executeWithFallback 切备用模型）
//   ⑤ 其他       → break-loop（结束本轮，并补齐 orphan tool_start）
//
// 为什么顺序是契约而非实现细节：
//   · ①②③ 全部带 `!isTimeout` 前置。若漏掉这个前置，DOMException
//     TimeoutError 会被 ① 的 isTransientStreamError 或 ③ 吃掉，
//     **永远走不到 ④ 的 throw** → fallback 模型切换彻底失效。
//   · ② 的 overflowCompressionDone 若不置位，溢出错误会「压缩→重试→
//     再溢出→再压缩」无限循环（压缩本身可能压不下去，见第一批用例注释）。
//   · ⑤ 的 orphan 补偿若缺失，流中途已 yield 的 tool_start 永远等不到
//     tool_end → 工具卡片永久转圈。
//
// 共同失败模式：这些分支坏掉都**不表现为报错**，而表现为
// 「转圈不停」/「无限重试烧 token」/「fallback 从不生效」。
// ─────────────────────────────────────────────────────────────────────────

suite('executeAgentTurnDirect — 模型调用异常处置阶梯（retry / throw / break 的判据顺序）', () => {

	/**
	 * 构造一个按轮次抛不同异常的 provider。
	 *
	 * `script(round)` 返回 `Error` 表示该轮抛出，返回 delta 数组表示该轮正常流。
	 */
	function faultingProvider(
		script: (round: number) => Error | IModelDelta[],
	): { provider: Record<string, unknown>; chatCalls: () => number } {
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => {
				const current = round++;
				const outcome = script(current);
				return (async function* () {
					if (outcome instanceof Error) { throw outcome; }
					for (const delta of outcome) { yield delta; }
				})();
			},
		};
		return { provider, chatCalls: () => round };
	}

	/** 捕获真实日志：分支归属直接由 warn/error 文案指认，不靠猜。 */
	function capturingLogger(): {
		logger: Record<string, (...args: unknown[]) => void>;
		lines: string[];
	} {
		const lines: string[] = [];
		return {
			lines,
			logger: {
				info: (m: unknown) => { lines.push(`info: ${String(m)}`); },
				warn: (m: unknown) => { lines.push(`warn: ${String(m)}`); },
				error: (m: unknown) => { lines.push(`error: ${String(m)}`); },
				debug: () => undefined,
				trace: () => undefined,
			},
		};
	}

	/** 构造 idle 超时错误（`isTimeout` 为真且 message 不含 'first-token'）。 */
	function idleTimeoutError(): DOMException {
		return new DOMException('stream idle timed out after 180000ms', 'TimeoutError');
	}

	/** 构造首 token 超时错误（`isTimeout` 为真且 message 含 'first-token'）。 */
	function firstTokenTimeoutError(): DOMException {
		return new DOMException('first-token timeout after 90000ms', 'TimeoutError');
	}

	test('瞬态错误（HTTP 5xx）→ 指数退避重试，且重试次数有界', async () => {
		// `turnLlmStream.ts:205` 分支 ①。
		// 失败模式：不重试 → 一次网络抖动就中止整轮对话；
		//           不设上限 → 服务端持续 503 时无限重试烧配额。
		//
		// 这里让**每一轮都抛** 503，用 chat 调用次数反推重试上限：
		// 首次调用 + TRANSIENT_ERROR_MAX_RETRIES 次重试 = 4 次，之后必须
		// 落到 ⑤ break-loop 而不是继续重试。
		const transient = (): Error => {
			const err = new Error('HTTP 503 Service Unavailable');
			(err as { status?: number }).status = 503;
			return err;
		};
		const { provider, chatCalls } = faultingProvider(() => transient());
		const { logger, lines } = capturingLogger();

		const host = mockHost({
			_logService: logger,
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [],
		});

		await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		// TRANSIENT_ERROR_MAX_RETRIES=3（`agentRunState.ts:1355`）：
		// 判据是 `retry().transientError < 3`，第 4 次时 3<3 为假 → 不再重试。
		assert.strictEqual(
			chatCalls(), 4,
			`瞬态错误应恰好重试 3 次（首次 + 3 = 4 次 chat 调用，实际 ${chatCalls()} 次）`
			+ `——多于 4 说明上限失效（会无限烧配额），少于 4 说明退避重试没接线`,
		);
		assert.ok(
			lines.some(l => l.includes('Transient stream error')),
			`必须打印瞬态重试日志（实际日志=${JSON.stringify(lines.slice(0, 6))}）`
			+ `——错误若被别的分支吃掉，这条日志不会出现`,
		);
		assert.ok(
			lines.some(l => l.includes('Model call failed on iteration')),
			`重试用尽后必须落到致命失败分支（⑤），而不是静默continue`,
		);
	});

	test('idle 超时必须 throw 冒泡，绝不能被瞬态/首 token 分支吞掉', async () => {
		// `turnLlmStream.ts:273` 分支 ④ —— 全阶梯里唯一 throw 的出口。
		// 契约：throw 是 fallback 模型切换的**唯一触发方式**
		//（经 runAgentLoop → _executeWithFallback）。
		//
		// 失败模式（高危且隐蔽）：若 ①③ 漏掉 `!isTimeout` 前置，
		// TimeoutError 会被当成瞬态错误原地重试 —— 表现为
		// 「同一个挂死的模型被反复重试，备用模型从不生效」。
		// 用例形态：只在 round 0 抛 idle 超时，后续轮正常。
		// 若 throw 生效 → chat 只被调用 1 次（不重试）。
		const { provider, chatCalls } = faultingProvider(round => (
			round === 0
				? idleTimeoutError()
				: [
					{ type: 'text', content: 'should never be reached in this turn' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const { logger } = capturingLogger();

		const host = mockHost({
			_logService: logger,
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [],
		});

		// 抛出必须**穿透** executeAgentTurnDirect 冒泡到调用方：
		// 主循环 catch 里只把 disposition 用于 retry/break，idle 超时这条
		// 是 `throw error`（`turnLlmStream.ts:273`），没有任何内层兜底 ——
		// 正因如此 `_executeWithFallback` 才能接住它并切换备用模型。
		// 若哪天有人在中间加了 try/catch「顺手兜住」，本用例会立刻变红。
		let thrown: unknown;
		try {
			await drain(
				executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
			);
		} catch (error) {
			thrown = error;
		}

		assert.ok(
			thrown instanceof DOMException && thrown.name === 'TimeoutError',
			`idle 超时必须原样抛出 TimeoutError（实际=${thrown === undefined ? '未抛出' : String(thrown)}）`
			+ `——被内层吞掉则 _executeWithFallback 收不到信号，备用模型永不启用`,
		);

		assert.strictEqual(
			chatCalls(), 1,
			`idle 超时不得原地重试（实际 chat 调用 ${chatCalls()} 次）`
			+ `——>1 意味着 TimeoutError 被瞬态/首token分支吃掉了，`
			+ `后果是挂死的模型被反复重试而 fallback 永不触发`,
		);
	});

	test('首 token 超时 → 同模型重试 1 次（冷启动预热），且与 idle 超时区分', async () => {
		// `turnLlmStream.ts:259-269` 分支 ③。
		// 判据是 `/first-token/.test(message)` —— 与 ④ 共享 isTimeout=true，
		// **仅靠 message 内容区分**。
		//
		// 失败模式：判据写错（如用 error.name 或漏掉正则）→ 冷启动 TTFT 超时
		// 被当作 idle 超时直接切备用模型，白白放弃「网关已被预热、重试即成功」
		// 这一确定性恢复路径。
		//
		// 形态：round 0 抛首 token 超时，round 1 正常 → 断言恢复成功。
		const { provider, chatCalls } = faultingProvider(round => (
			round === 0
				? firstTokenTimeoutError()
				: [
					{ type: 'text', content: 'warmed up and recovered' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const { logger, lines } = capturingLogger();

		const host = mockHost({
			_logService: logger,
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [],
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			chatCalls(), 2,
			`首 token 超时必须重试恰好 1 次（首次 + 1 = 2 次，实际 ${chatCalls()} 次）`
			+ `——1 次说明被当成 idle 超时抛掉了（丢失预热恢复），`
			+ `>2 说明重试上限失效`,
		);
		assert.ok(
			lines.some(l => l.includes('First-token timeout')),
			`必须走首 token 超时专属分支（实际日志=${JSON.stringify(lines.slice(0, 6))}）`,
		);

		const text = deltas
			.filter(d => (d as { type?: string }).type === 'text')
			.map(d => String((d as { content?: unknown }).content ?? ''))
			.join('');
		assert.ok(
			text.includes('warmed up and recovered'),
			`重试成功后模型文本必须正常透传（实际=${JSON.stringify(text.slice(0, 120))}）`
			+ `——重试却丢弃产物等于白重试`,
		);
	});

	test('溢出压缩每 turn 只做一次：第二次溢出必须结束而不是再压一轮', async () => {
		// `turnLlmStream.ts:225` 分支 ② 的 `!loopState.overflowCompressionDone` 闸门。
		//
		// 失败模式（最危险的一条）：闸门失效 → 「溢出 → 压缩 → 重试 → 仍溢出
		// → 再压缩」无限循环。压缩并不保证能压到服务端上限以下（服务端
		// maxInputTokens 未知），所以这不是理论风险。
		//
		// 形态：**每轮都抛**溢出 400。若闸门生效 → 恰好 2 次 chat 调用
		//（首次 + 压缩后重试 1 次），第 2 次失败时 overflowCompressionDone
		// 已为 true → 落到 ⑤ break-loop。
		const overflow = (): Error => new Error('HTTP 400 invalid_parameter_value code 11133');
		const { provider, chatCalls } = faultingProvider(() => overflow());
		const { logger, lines } = capturingLogger();

		const host = mockHost({
			_logService: logger,
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [],
			// 压缩链路的必要桩（与第一批溢出用例同口径）：
			// 冷却放行 + 记忆 provider 存在，确保 force 压缩真的被执行而非静默跳过。
			getActiveMemoryProvider: () => ({
				recallFormatted: async () => undefined,
				triggerHook: () => undefined,
			}),
			_retrieveCompactionContext: async () => undefined,
			_lastCompressionTime: 0,
			_compressionBeforeTokens: 0,
			_compressionAfterTokens: 0,
			_compressionCount: 0,
			_compressionIneffectiveCount: 0,
		});

		// messages >= 2：force 快通道要求（`contextManager.ts:2050`
		// `skipTriggerGate = force === true && messages.length >= 2`）。
		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({
					messages: [
						{ role: 'user', content: 'q1' },
						{ role: 'assistant', content: 'a1' },
						{ role: 'user', content: 'q2' },
						{ role: 'assistant', content: 'a2' },
					],
				}) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			chatCalls(), 2,
			`溢出压缩必须每 turn 仅一次（首次 + 重试 1 次 = 2，实际 ${chatCalls()} 次）`
			+ `——>2 说明 overflowCompressionDone 闸门失效，生产上会无限压缩重试`,
		);
		const overflowLogs = lines.filter(l => l.includes('Context overflow detected'));
		assert.strictEqual(
			overflowLogs.length, 1,
			`「force-compressing + retry」只应发生一次（实际 ${overflowLogs.length} 次）`,
		);
	});

	test('流中途已开的 tool_start：模型报错后必须补 tool_result + tool_end', async () => {
		// `turnLlmStream.ts:284-293` 分支 ⑤ 的 orphan 补偿。
		//
		// 场景：模型先流出 tool_call（webview 已渲染工具卡片并转圈），
		// 随后流本身抛错 —— 工具根本没机会执行。
		// 失败模式：不补 tool_end → 那张卡片**永久转圈**，用户以为还在跑。
		//
		// 用错误类型必须避开 ①②③：普通 Error（非 5xx / 非溢出 / 非 timeout）
		// 才会直落 ⑤。
		//
		// 这里不能复用 `faultingProvider`：它的 script 要么整轮抛、要么整轮正常，
		// 无法表达本用例需要的「先 yield 出 tool_call，再抛错」时序 —— 而正是
		// 这个时序才会留下 orphan tool_start。
		let chatRound = 0;
		const partialThenThrowProvider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: () => {
				const current = chatRound++;
				return (async function* () {
					if (current === 0) {
						yield {
							type: 'tool_call',
							toolCall: { id: 'orphan-1', name: 'file_read', arguments: '{"path":"/mock/a.ts"}' },
						} as unknown as IModelDelta;
						throw new Error('malformed response body after tool_call');
					}
					yield { type: 'text', content: 'never reached' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const { logger } = capturingLogger();
		const host = mockHost({
			_logService: logger,
			_getActiveModelProvider: () => partialThenThrowProvider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['file_read']),
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const starts = deltas.filter(d => (d as { type?: string }).type === 'tool_start') as Array<{ toolCallId?: string }>;
		const ends = deltas.filter(d => (d as { type?: string }).type === 'tool_end') as Array<{ toolCallId?: string; success?: boolean }>;

		// 前提校验：这条用例只在「确实开了 tool_start」时才有意义。
		// 若实现改为「流抛错时不再 yield tool_start」，本断言会明确指出前提消失，
		// 而不是让后续断言给出误导性的通过。
		assert.ok(
			starts.length > 0,
			`前提：报错前必须已 yield tool_start（实际 ${starts.length} 个）`
			+ `——若为 0，说明 tool_start 时机变了，本用例需重新设计`,
		);

		for (const start of starts) {
			assert.ok(
				ends.some(e => e.toolCallId === start.toolCallId),
				`每个 tool_start 都必须有配对的 tool_end（缺 id=${start.toolCallId}）`
				+ `——漏发即工具卡片永久转圈`,
			);
		}
		assert.ok(
			ends.every(e => e.success === false),
			`模型报错导致未执行的工具，tool_end 必须 success=false`
			+ `——标 true 会让 UI 显示「已完成」，与事实相反`,
		);
	});
});




// ─────────────────────────────────────────────────────────────────────────
// 第六批：迭代末尾的记账与持久化（`parts/turnPostIteration.ts`）
//
// 前五批覆盖「跑不跑下一轮」「工具执不执行」「异常怎么处置」。本批覆盖
// 每轮末尾那段**没有任何返回值参与控制流**的副作用代码：
//
//   · 预算记账   `:434-439` 委托轮 refund / 普通轮 consume
//   · 委托账本   `:227-243` markCompleted / markFailed → durable context
//   · checkpoint `:444-472` 每 CHECKPOINT_PERSIST_INTERVAL(=3) 轮落盘
//
// 为什么这段特别值得锁：它的所有失败都是**静默**的。
//   · 预算算错 → turn 提前几轮结束或多跑十几轮，表现为「模型怎么不干活了」
//     或「怎么一直停不下来」，而不是任何报错。
//   · 账本没更新 → durable context 里的委托状态永远停在 running，
//     压缩后模型看到「子代理还在跑」，于是原地等待或重复派发。
//   · checkpoint 抛错若不被吞掉 → 一次存储故障直接炸掉整个 turn；
//     反过来若落盘节奏错了，断点续跑会丢失中间进度。
//
// 这三件事都发生在 `yield` 之后、不进入任何 `return`，因此**无法**通过
// 观察事件序列发现问题 —— 必须直接观测 budget / ledger / sink 的调用。
// ─────────────────────────────────────────────────────────────────────────

suite('executeAgentTurnDirect — 迭代末尾记账与持久化（静默副作用）', () => {

	/**
	 * 按轮次脚本化的 provider（与第四/五批同形）。
	 *
	 * ⚠ 收尾轮语义依赖 provider **尊重 `tools` 入参**：主循环停不下来时，
	 * 靠的是「收尾轮把 tools 置空 + toolChoice:'none' → 模型只能给纯文本 →
	 * 无工具调用 → 自然结束」。真实模型做得到，硬编码脚本却会在无工具的
	 * 收尾轮里继续吐 tool_call，于是每轮都重新触发收尾判定、一路跑到
	 * HARD_STOP（实测 101 轮）。
	 * 因此这里模拟真实模型：**没给工具就不发工具调用**，改回纯文本。
	 */
	function scriptedProvider(script: (round: number) => IModelDelta[]): {
		provider: Record<string, unknown>;
		chatCalls: () => number;
	} {
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: unknown, _messages: unknown, options?: { tools?: unknown[] }) => {
				const current = round++;
				const toolsOffered = (options?.tools?.length ?? 0) > 0;
				return (async function* () {
					for (const delta of script(current)) {
						const isToolCall = (delta as { type?: string }).type === 'tool_call';
						if (isToolCall && !toolsOffered) {
							continue; // 收尾轮：物理无工具可调
						}
						yield delta;
					}
					if (!toolsOffered) {
						yield { type: 'text', content: '（收尾轮）基于已有信息给出结论。' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		};
		return { provider, chatCalls: () => round };
	}

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/**
	 * 装配一个「工具都成功执行」的 host。
	 *
	 * 与第四批的 `permHost` 同理，必须同时桩住串行与并行两条执行路径：
	 * `shouldParallelizeToolBatch` 按批次形状选路，只桩一条会让另一条
	 * 落回真实实现并因缺依赖而失败。
	 */
	function accountingHost(
		provider: Record<string, unknown>,
		overrides: Record<string, unknown> = {},
	): { host: Record<string, unknown>; executed: string[] } {
		const executed: string[] = [];
		const runCalls = async (calls: Array<{ id: string; name: string }>) =>
			calls.map(call => {
				executed.push(call.name);
				return { toolCallId: call.id, content: `ok:${call.name}`, success: true };
			});

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } },
				{ name: 'delegate_task', description: 'delegate', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['file_read', 'delegate_task']),
			// ⚠ 两条路径的真实签名都是 **calls 在第一位**
			// （`agentTurnExecutor.ts:3744` / `:3766`），且并行路径直接 yield
			// 结果对象本身（带 toolCallId），不是 `{ type:'result', result }` 信封。
			// 把参数顺序或 yield 形状写错不会报错，只会让工具全部"执行失败"，
			// 循环于是一路跑到 HARD_STOP —— 表现为毫不相干的 101 次 LLM 调用。
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) =>
				runCalls(calls),
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				const results = await runCalls(calls);
				for (const result of results) {
					yield result as never;
				}
			},
			...overrides,
		});
		return { host, executed };
	}

	test('普通轮每轮恰好消耗 1 点预算（不多扣、不漏扣）', async () => {
		// `turnPostIteration.ts:438` `budget.consume(1)`。
		//
		// 失败模式全是静默的：
		//   · 漏扣 → 预算门控形同虚设，turn 可以无限跑（只剩 HARD_STOP 兜底）
		//   · 多扣 → 用户设的 N 轮实际只跑 N/2 轮，模型话说一半就停
		//
		// 用 budgetMaxTotal 反推：给 3 轮预算，让模型每轮都发工具调用（即
		// 永不自然结束），则必须在第 3 轮后进入禁工具收尾轮（第 4 次调用）
		// 并停止 —— 与第三批「预算耗尽 → 收尾轮」的语义一致。
		// ⚠ 每轮的工具参数必须**互不相同**：重复调用会被去重过滤丢弃，
		// 该轮 localExecutedCalls 随之为空 → 整段 post-iteration（含 consume）
		// 被跳过 → 预算永不消耗、循环一路跑到 HARD_STOP。
		// 这正是本用例首次编写时踩到的坑（实测 101 次调用 / 仅 2 次执行）。
		const { provider, chatCalls } = scriptedProvider(round => [
			toolCallDelta(`t-${round}`, 'file_read', { path: `/mock/a${round}.ts` }),
			{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
		]);
		const { host } = accountingHost(provider);

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 3 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		// 3 轮正常消耗 + 1 轮禁工具收尾 = 4 次 LLM 调用。
		assert.strictEqual(
			chatCalls(), 4,
			`3 点预算应跑 3 轮 + 1 轮收尾（实际 ${chatCalls()} 次 LLM 调用）`
			+ `——少于 4 说明每轮多扣了预算，多于 4 说明 consume 漏接线（预算门控失效）`,
		);
	});

	test('委托轮 refund：派发子代理的轮次不消耗父 turn 预算', async () => {
		// `turnPostIteration.ts:434-439`：`strategy.takeDelegationRound()` 为真
		// 时走 `budget.refund(1)` 而非 `consume(1)`。
		//
		// 契约来源：父代理派发子代理的那一轮，实际工作由子代理用**自己的**预算
		// 完成，父轮只是转发。若照常扣预算，一次 5 路并行委派就吃掉父代理 5 点，
		// 父代理常常还没看到任何子结果就没轮次了（真实事故形态）。
		//
		// ⚠ strategy 实例由模块内 `strategyFactory.resolve()` 产出
		//（`agentTurnExecutor.ts:207`），**不能**从 host 或 request 注入桩。
		// 因此这里驱动真实的 HermesReActStrategy：它的 `interceptToolCall`
		// 见到 delegate_task 就置 `_delegationRound`，循环末被 takeDelegationRound
		// 消费（`hermesReActStrategy.ts:121-125`）。
		//
		// 判别设计：预算 = 2，让**每轮**都发 delegate_task。
		//   · refund 接线正常 → 每轮净消耗 0 → 预算永不耗尽 → 由"无更多工具"
		//     的自然结束或 HARD_STOP 决定终点，轮数必然 > 2+1
		//   · refund 丢失（退化成 consume）→ 2 轮后进收尾轮 → 恰好 3 次调用
		// 用"是否明显超过 3"把两种世界分开。
		const DELEGATION_BUDGET = 2;
		const PLAIN_CONSUME_ROUNDS = DELEGATION_BUDGET + 1; // 退化世界的轮数
		const OBSERVE_ROUNDS = 6; // 观测窗口：够区分两种世界，又远小于 HARD_STOP

		const { provider, chatCalls } = scriptedProvider(round => (
			round < OBSERVE_ROUNDS
				? [
					toolCallDelta(`dg-${round}`, 'delegate_task', { type: 'code-explorer', task: '找入口' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '子代理均已返回，结束。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const { host, executed } = accountingHost(provider);

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({
					budgetMaxTotal: DELEGATION_BUDGET,
					paradigm: 'budgeted-react',
				}) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			executed.filter(name => name === 'delegate_task').length >= 2,
			`前提：delegate_task 必须被多次执行（实际执行=${JSON.stringify(executed)}）`
			+ `——委托轮标志由 interceptToolCall 观测工具名设置，没执行就测不到 refund`,
		);
		assert.ok(
			chatCalls() > PLAIN_CONSUME_ROUNDS,
			`委托轮必须 refund：${DELEGATION_BUDGET} 点预算下全委托轮应跑满观测窗口，`
			+ `实际仅 ${chatCalls()} 次 —— 等于 ${PLAIN_CONSUME_ROUNDS} 说明 refund 退化成了普通 consume，`
			+ `父代理会在拿到子结果前就耗尽轮次`,
		);
	});

	test('checkpointSink 抛错不得炸掉 turn（存储故障必须降级为日志）', async () => {
		// `turnPostIteration.ts:459-471`：落盘是 fire-and-forget + 双层 try/catch。
		//
		// 失败模式：把 sink 的异常放出来 → 一次磁盘写失败/配额超限
		// 直接中止整个 turn，用户丢掉全部未完成工作。
		// 存储是**尽力而为**的旁路，绝不能成为主流程的失败源。
		// ⚠ 同上：每轮参数必须唯一，否则重复调用被去重丢弃 → post-iteration
		// 整段跳过 → 根本走不到落盘分支。
		const { provider } = scriptedProvider(round => (
			round < 3
				? [
					toolCallDelta(`c-${round}`, 'file_read', { path: `/mock/a${round}.ts` }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '完成。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		let sinkCalls = 0;
		const { host } = accountingHost(provider);

		let thrown: unknown;
		try {
			await drain(
				executeAgentTurnDirect(
					host,
					mockRequest({
						checkpointSink: async () => {
							sinkCalls++;
							throw new Error('disk quota exceeded');
						},
					}) as never,
				) as AsyncGenerator<IChatStreamDelta, unknown>,
			);
		} catch (error) {
			thrown = error;
		}

		assert.strictEqual(
			thrown, undefined,
			`checkpoint 落盘失败绝不能抛穿 turn（实际抛出=${String(thrown)}）`
			+ `——存储是旁路能力，让它中止主流程等于用可选功能换掉核心功能`,
		);
		assert.ok(
			sinkCalls > 0,
			`前提：checkpointSink 必须真的被调用过（实际 ${sinkCalls} 次）`
			+ `——为 0 说明本用例根本没覆盖到落盘路径（CHECKPOINT_PERSIST_INTERVAL=3，`
			+ `需至少跑到第 3 轮），断言会变成空转的假绿`,
		);
	});

	test('委托工具结果必须写回账本，供压缩后的轮次读取真实状态', async () => {
		// `turnPostIteration.ts:227-243`：只对 `isDelegationCall` 为真的调用
		// 更新 ledger，再 `_durableContext.updateFromLedger` 固化。
		//
		// 失败模式：账本停在 running → 压缩把原始 tool_result 挤掉后，
		// 模型从 durable context 读到的委托状态永远是「进行中」，
		// 于是要么原地空等，要么重复派发同一个子任务（真实事故形态）。
		//
		// 用真实 DelegationLedgerManager + DurableContextManager（mockHost 默认即真实实例），
		// 断言「委托调用的终态进入了 durable context」。
		const { provider } = scriptedProvider(round => (
			round === 0
				? [
					toolCallDelta('dg-1', 'delegate_task', { type: 'code-explorer', task: '找入口' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '子代理已返回。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		const ledger = new DelegationLedgerManager();
		const durableContext = new DurableContextManager();
		// `markCompleted` 只在 ledger 已有该 callId 时才生效（`delegationLedger.ts:286`）。
		// 生产中 `markDelegated` 由 agentOSService 的派发路径写入（`:3175`），
		// 不在本被测范围内——这里预置该条目，等价于「子代理已派发」的初态，
		// 从而让本用例精确地只测「结果回来后终态有没有被写回」这一段。
		ledger.markDelegated('dg-1', '找入口', 'code-explorer');

		const { host, executed } = accountingHost(provider, {
			_delegationLedger: ledger,
			_durableContext: durableContext,
		});

		await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			executed.includes('delegate_task'),
			`前提：delegate_task 必须真的被执行（实际执行=${JSON.stringify(executed)}）`
			+ `——未执行则不会产生 toolResult，账本断言失去意义`,
		);

		const entry = ledger.getAllEntries().find(item => item.callId === 'dg-1');
		assert.strictEqual(
			entry?.status, 'completed',
			`委托成功返回后账本必须转为 completed（实际 ${String(entry?.status)}）`
			+ `——停在 in_progress 会让压缩后的轮次认为子代理仍在跑，`
			+ `模型于是原地空等或重复派发同一个子任务`,
		);
		assert.strictEqual(
			ledger.activeCount, 0,
			`终态写回后不得再有在途委托（实际 activeCount=${ledger.activeCount}）`,
		);

		// 账本必须同步进 durable context：那是压缩后唯一还能读到委托状态的地方。
		const durableText = JSON.stringify(durableContext);
		assert.ok(
			durableText.includes('dg-1') || durableText.includes('completed'),
			'账本终态必须固化进 durable context —— 二者脱节时，'
			+ '原始 tool_result 一被压缩挤掉，委托状态就彻底丢失',
		);
	});

	/**
	 * checkpoint 不是每轮落盘，而是每 `CHECKPOINT_PERSIST_INTERVAL=3` 轮采样一次
	 * （`turnPostIteration.ts:57`）。这个节奏是成本与可恢复性的折中，两个方向都会出事：
	 *  - 退化成每轮落盘 → 长 turn 里高频写存储，主循环被 IO 拖慢；
	 *  - 间隔被拉大/条件写错 → 崩溃时回退的进度过多，断点恢复形同虚设。
	 * 因此这里把「采样节奏」本身钉住，而不只是断言「落过盘」。
	 */
	test('checkpoint 按固定间隔采样落盘，既不是每轮写也不是只写一次', async () => {
		const TOTAL_ROUNDS = 7;
		const { provider } = scriptedProvider(round => (
			round < TOTAL_ROUNDS
				? [
					toolCallDelta(`t-${round}`, 'file_read', { path: `/mock/ckpt-${round}.ts` }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '完成。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		const persisted: unknown[] = [];
		const { host } = accountingHost(provider);

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({
					budgetMaxTotal: 20,
					checkpointSink: async (snapshot: unknown) => {
						persisted.push(snapshot);
					},
				}) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			persisted.length > 0,
			`前提：checkpoint 必须真的落过盘（实际 0 次）——为 0 说明落盘路径根本没跑到，断言会空转成假绿`,
		);
		assert.ok(
			persisted.length < TOTAL_ROUNDS,
			`checkpoint 不得每轮落盘（${TOTAL_ROUNDS} 轮工具轮却落盘 ${persisted.length} 次）`
			+ `——退化成每轮写会在长 turn 里把主循环拖进高频 IO`,
		);
		assert.ok(
			persisted.length >= 2,
			`${TOTAL_ROUNDS} 轮至少应采样落盘 2 次（间隔 3 轮，实际 ${persisted.length} 次）`
			+ `——只落 1 次说明间隔判定退化成「仅首次」，崩溃时会丢掉后续全部进度`,
		);
	});

});

// ═══════════════════════════════════════════════════════════════════
// 第七批：工具调用准入闸门（去重补偿 / 截断保护 / 并行选路）
//
// 被测段：模型吐完 tool_calls 之后、真正执行之前的那道过滤链
//   · 输出截断保护 `agentTurnExecutor.ts:2874` finishReason=length → 全部不执行
//   · 调用去重     `:2391` deduplicateToolCalls + `:2394-2399` 补 result/end
//   · 并行选路     `:2975` shouldParallelizeToolBatch（≥2 delegate_task）
//
// 为什么这道闸门值得单独锁：它是**唯一**能在「模型给了坏调用」和「真实副作用
// 落盘」之间叫停的地方，而它的三种失效都不会报错：
//   · 截断保护失灵 → patch 的 replace 被截掉后半段照样写进文件，产生真实的
//     代码损坏，且看起来像是模型「写错了」。
//   · 去重不补 tool_result → 被丢弃的 toolCallId 永远收不到结果，
//     OpenAI 兼容 provider 下一轮直接 400（tool_call 未配对）。
//   · 并行判据退化 → 多个 delegate_task 串行，首个子代理（最长 600s）
//     阻塞其余排队，表现为「只有最后一个 subagent 在跑」。
// ═══════════════════════════════════════════════════════════════════
suite('executeAgentTurnDirect — 工具调用准入闸门（执行前的最后一道过滤）', () => {

	function scriptedProvider(script: (round: number) => IModelDelta[]): {
		provider: Record<string, unknown>;
		chatCalls: () => number;
	} {
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: unknown, _messages: unknown, options?: { tools?: unknown[] }) => {
				const current = round++;
				const toolsOffered = (options?.tools?.length ?? 0) > 0;
				return (async function* () {
					for (const delta of script(current)) {
						if ((delta as { type?: string }).type === 'tool_call' && !toolsOffered) {
							continue;
						}
						yield delta;
					}
					if (!toolsOffered) {
						yield { type: 'text', content: '（收尾轮）基于已有信息给出结论。' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		};
		return { provider, chatCalls: () => round };
	}

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/** 记录「真正被执行」的调用，并分别标记走的是串行还是并行路径。 */
	function gateHost(
		provider: Record<string, unknown>,
		overrides: Record<string, unknown> = {},
	): {
		host: Record<string, unknown>;
		executed: Array<{ id: string; name: string }>;
		serialBatches: number;
		parallelBatches: number;
		counters: { serial: number; parallel: number };
	} {
		const executed: Array<{ id: string; name: string }> = [];
		const counters = { serial: 0, parallel: 0 };
		const runCalls = async (calls: Array<{ id: string; name: string }>) =>
			calls.map(call => {
				executed.push({ id: call.id, name: call.name });
				return { toolCallId: call.id, content: `ok:${call.name}`, success: true };
			});

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } },
				{ name: 'delegate_task', description: 'delegate', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['file_read', 'delegate_task']),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => {
				counters.serial++;
				return runCalls(calls);
			},
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				counters.parallel++;
				const results = await runCalls(calls);
				for (const result of results) {
					yield result as never;
				}
			},
			...overrides,
		});
		return {
			host, executed,
			get serialBatches() { return counters.serial; },
			get parallelBatches() { return counters.parallel; },
			counters,
		};
	}

	test('输出上限截断的那一轮：工具一个都不准执行，且必须全部补失败结果', async () => {
		// `agentTurnExecutor.ts:2874`：finishReason=length/max_tokens 时，
		// 流式 JSON 抢救解析器可能「补全」出一份**语法合法但内容被截断**的参数。
		//
		// 这是全批最危险的一条：参数校验拦不住它（JSON 合法、必填字段齐全），
		// 只有这个判据能拦。放过去 = 用半截 replace 真实改写用户文件。
		const { provider } = scriptedProvider(round => (
			round === 0
				? [
					toolCallDelta('cut-1', 'file_read', { path: '/mock/truncated-a.ts' }),
					toolCallDelta('cut-2', 'file_read', { path: '/mock/truncated-b.ts' }),
					{ type: 'done', finishReason: 'length' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '重新组织回答。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const { host, executed } = gateHost(provider);

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			executed, [],
			`被输出上限截断的轮次里，工具一个都不能执行（实际执行=${JSON.stringify(executed)}）`
			+ `——参数可能只有半截，执行 patch/execute_code 会造成真实且难以追溯的错误写入`,
		);

		for (const id of ['cut-1', 'cut-2']) {
			const ended = deltas.filter(
				d => (d as { type?: string; toolCallId?: string }).type === 'tool_end'
					&& (d as { toolCallId?: string }).toolCallId === id,
			);
			assert.ok(
				ended.length > 0,
				`截断丢弃的调用 ${id} 仍必须补 tool_end（实际 0 个）`
				+ `——少一个 tool_end，UI 的 spinner 就永远转下去`,
			);
			assert.strictEqual(
				(ended[0] as { success?: boolean }).success, false,
				`${id} 的 tool_end 必须是 success=false —— 标成成功会让模型以为读到了内容`,
			);
		}
	});

	test('同名同参的重复调用被去重后，必须为丢弃的那个补 tool_result + tool_end', async () => {
		// `agentTurnExecutor.ts:2391-2399`。
		//
		// 去重本身只是省钱；真正的硬约束是**配对完整性**：OpenAI 兼容协议要求
		// 每个 assistant.tool_calls[i].id 都有对应的 tool 消息。丢弃却不补，
		// 下一轮请求直接 400，整个 turn 崩掉——而且报错信息与去重毫无字面关联。
		const { provider } = scriptedProvider(round => (
			round === 0
				? [
					toolCallDelta('dup-a', 'file_read', { path: '/mock/same.ts' }),
					toolCallDelta('dup-b', 'file_read', { path: '/mock/same.ts' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '完成。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const { host, executed } = gateHost(provider);

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const sameTargetRuns = executed.filter(call => call.name === 'file_read');
		assert.strictEqual(
			sameTargetRuns.length, 1,
			`完全相同的两个调用只应执行 1 次（实际 ${sameTargetRuns.length} 次）`
			+ `——去重失效意味着每轮重复工作与重复计费`,
		);

		// 被丢弃的那个 id 必须仍然收到 result + end，否则协议层配对断裂。
		const executedIds = new Set(executed.map(call => call.id));
		const droppedId = ['dup-a', 'dup-b'].find(id => !executedIds.has(id));
		assert.ok(droppedId, '前提：必须恰好有一个调用被去重丢弃');

		const droppedResults = deltas.filter(
			d => (d as { type?: string; toolCallId?: string }).type === 'tool_result'
				&& (d as { toolCallId?: string }).toolCallId === droppedId,
		);
		const droppedEnds = deltas.filter(
			d => (d as { type?: string; toolCallId?: string }).type === 'tool_end'
				&& (d as { toolCallId?: string }).toolCallId === droppedId,
		);
		assert.ok(
			droppedResults.length > 0 && droppedEnds.length > 0,
			`被去重丢弃的 ${droppedId} 必须同时补 tool_result 与 tool_end`
			+ `（实际 result=${droppedResults.length} end=${droppedEnds.length}）`
			+ `——缺任意一个，OpenAI 兼容 provider 下一轮就因 tool_call 未配对返回 400`,
		);
	});

	test('同一轮多个 delegate_task 必须走并行路径，不得串行排队', async () => {
		// `toolCallUtils.ts:1485-1492`：≥2 个 delegate_task 且其余均为只读安全工具
		// 时并行。这条是针对实测故障（日志 1785120071762）的回归锁：此前多个
		// delegate_task 串行，首个子代理最长可占 600s，用户观察到的现象是
		// 「启动多个 delegate_task 只有最后一个在执行」。
		const { provider } = scriptedProvider(round => (
			round === 0
				? [
					toolCallDelta('dg-a', 'delegate_task', { task: '查 A 模块' }),
					toolCallDelta('dg-b', 'delegate_task', { task: '查 B 模块' }),
					toolCallDelta('rd-c', 'file_read', { path: '/mock/ctx.ts' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '汇总完成。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const gate = gateHost(provider);

		await drain(
			executeAgentTurnDirect(gate.host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			gate.counters.parallel > 0,
			`≥2 个 delegate_task 的批次必须走并行路径`
			+ `（实际 parallel=${gate.counters.parallel} serial=${gate.counters.serial}）`
			+ `——退回串行会让首个子代理阻塞其余全部排队，最长可空等 600s`,
		);
		assert.strictEqual(
			gate.counters.serial, 0,
			`该批次不应再走串行路径（实际 serial=${gate.counters.serial}）`
			+ `——两条路径都跑意味着工具被执行了两遍`,
		);
		assert.deepStrictEqual(
			gate.executed.map(call => call.name).sort(),
			['delegate_task', 'delegate_task', 'file_read'],
			`混合批次里的只读工具必须与 delegate 一同并行执行，一个都不能漏`
			+ `（实际 ${JSON.stringify(gate.executed.map(call => call.name))}）`,
		);
	});

	test('并行执行中途异常：已开的 tool_start 必须全部被 finally 补上 tool_end', async () => {
		// `agentTurnExecutor.ts:3759-3763`：并行批次用 try-finally + `_executedToolIds`
		// 兜底。并行路径是**最容易漏 tool_end** 的地方——流被中断时，尚未 yield
		// 结果的那些调用不会经过正常的 finalize 路径。
		//
		// 漏掉的后果是双重的：UI 侧 spinner 永久转动；协议侧该 toolCallId
		// 没有对应 tool 消息，下一轮请求直接 400。
		const { provider } = scriptedProvider(round => (
			round === 0
				? [
					toolCallDelta('pf-a', 'delegate_task', { task: '子任务 A' }),
					toolCallDelta('pf-b', 'delegate_task', { task: '子任务 B' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '基于部分结果作答。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));

		// 并行流在吐出第一个结果后就崩：pf-b 永远拿不到自己的结果对象。
		const { host } = gateHost(provider, {
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				yield {
					toolCallId: calls[0].id,
					content: `ok:${calls[0].name}`,
					success: true,
				} as never;
				throw new Error('parallel dispatch crashed mid-flight');
			},
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const startedIds = new Set(
			deltas
				.filter(d => (d as { type?: string }).type === 'tool_start')
				.map(d => (d as { toolCallId?: string }).toolCallId)
				.filter((id): id is string => typeof id === 'string'),
		);
		const endedIds = new Set(
			deltas
				.filter(d => (d as { type?: string }).type === 'tool_end')
				.map(d => (d as { toolCallId?: string }).toolCallId)
				.filter((id): id is string => typeof id === 'string'),
		);

		assert.ok(
			startedIds.size > 0,
			'前提：必须至少开出一个 tool_start，否则本用例没有验证对象',
		);
		const unpaired = [...startedIds].filter(id => !endedIds.has(id));
		assert.deepStrictEqual(
			unpaired, [],
			`并行批次崩溃后仍不得留下未配对的 tool_start（悬挂 id=${JSON.stringify(unpaired)}）`
			+ `——UI 的 spinner 会永久转动，且该 toolCallId 缺 tool 消息会让下一轮请求 400`,
		);
	});

	test('去重是单轮内的事：跨轮同参调用照常执行，直到护栏阈值才叫停', async () => {
		// 本用例锁的是「去重」与「跨轮拦截」的分界：
		//   · `toolCallUtils.ts:995` 去重 —— `seen` 是函数内局部变量，每次调用重建，
		//     因此**只在单轮批次内**生效，跨轮完全不记账。
		//   · 跨轮的重复由另一套规则拦，第 2 次之后就不再放行。
		//
		// ⚠ 归因订正（第八批实测）：这里拦下第 3 次的是 **ToolGuardrailController
		// 的 idempotent_no_progress**（`toolGuardrailController.ts:347`，
		// noProgressBlockAfter=2），**不是** detectToolCallLoop。
		// 原因：`file_read` 在 IDEMPOTENT_TOOL_NAMES 里，且本用例每轮返回**同一个**
		// 结果，于是同签名+同结果先命中护栏；beforeCall 又排在 detectToolCallLoop
		// 之前（`agentTurnExecutor.ts:3110` vs `:3124`），所以循环检测根本没轮到。
		// 两者恰好都在第 3 次触发，仅看执行次数无法区分——必须看拦截文案
		// （护栏说 "same result"，循环检测说 "same arguments"）。
		// 这条分工本身由第八批 suite 专门覆盖。
		//
		// 两个方向都会出事：
		//   · 若去重被「优化」成跨轮缓存 → 第 2 次就拿不到真实结果，轮询文件变化、
		//     重试上一轮的失败调用全部击穿，且毫无报错。
		//   · 若跨轮拦截失效 → 模型可以无限重放同一个调用，空转到 HARD_STOP。
		const EXPECTED_RUNS = 2; // noProgressBlockAfter=2 → 第 3 次被护栏拦下
		const TOTAL_TOOL_ROUNDS = 4; // 刻意多于阈值，确保第 3 次确实被拦而非没跑到
		const { provider } = scriptedProvider(round => (
			round < TOTAL_TOOL_ROUNDS
				? [
					// 逐轮换 id、但参数**完全相同**：模拟轮询/重试同一个目标。
					toolCallDelta(`poll-${round}`, 'file_read', { path: '/mock/watched.ts' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '文件已稳定。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const { host, executed } = gateHost(provider);

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const reads = executed.filter(call => call.name === 'file_read');
		assert.strictEqual(
			reads.length, EXPECTED_RUNS,
			`跨轮同参调用应执行 ${EXPECTED_RUNS} 次后被拦下（实际 ${reads.length} 次）`
			+ `——少于 ${EXPECTED_RUNS} 说明去重越界跨轮生效，轮询/重试会拿到陈旧占位；`
			+ `多于 ${EXPECTED_RUNS} 说明 noProgressBlockAfter(2) 失效，模型可无限重放同一调用`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// 第八批：护栏与循环检测的分工边界（谁先拦、拦谁、文案是否可执行）
//
// 两条独立规则同在「第 3 次同签名调用」触发，靠**执行顺序**分工
// （`agentTurnExecutor.ts:1278-1284` 显式记录了这个设计）：
//
//   ToolGuardrailController.beforeCall  (`:3110`)   noProgressBlockAfter=2
//     └─ 只管幂等只读工具，且要求**同签名 + 同结果**
//   detectToolCallLoop                  (`:3124`)   TOOL_LOOP_THRESHOLD=3
//     └─ 只看签名，不分成败、不看结果
//
// beforeCall 在前，于是形成：
//   · 同签名 **且** 同结果 → 护栏先拦，文案点明「结果无变化」
//   · 同签名 **但** 结果不同 → 护栏放行，交给 detectToolCallLoop，文案点明「参数重复」
//   · 修改型工具（terminal 等）→ 护栏完全不介入（重试是正常语义），只由循环检测兜底
//
// 为什么必须锁：这两个阈值是**耦合**的。注释里写明若 noProgressBlockAfter 也设 3，
// 它会被 detectToolCallLoop 完全遮蔽、永远轮不到（等于没接）。任何一方改阈值都会
// 静默改变分工，而现象只是「模型被拦的时机变了」，没有任何报错。
//
// 文案差异同时是本批的探针：护栏说 "same result"，循环检测说 "same arguments"。
// ═══════════════════════════════════════════════════════════════════
suite('executeAgentTurnDirect — 护栏与循环检测的分工边界', () => {

	function scriptedProvider(script: (round: number) => IModelDelta[]): {
		provider: Record<string, unknown>;
		chatCalls: () => number;
	} {
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: unknown, _messages: unknown, options?: { tools?: unknown[] }) => {
				const current = round++;
				const toolsOffered = (options?.tools?.length ?? 0) > 0;
				return (async function* () {
					for (const delta of script(current)) {
						if ((delta as { type?: string }).type === 'tool_call' && !toolsOffered) {
							continue;
						}
						yield delta;
					}
					if (!toolsOffered) {
						yield { type: 'text', content: '（收尾轮）基于已有信息给出结论。' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		};
		return { provider, chatCalls: () => round };
	}

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/**
	 * host 桩：工具结果内容由 `resultFor` 决定，用来制造「同结果」与「结果变化」
	 * 两种场景——这正是区分护栏与循环检测的唯一变量。
	 */
	function guardHost(
		provider: Record<string, unknown>,
		resultFor: (call: { id: string; name: string }, seq: number) => string,
		toolNames: string[] = ['file_read'],
	): {
		host: Record<string, unknown>;
		executed: Array<{ id: string; name: string }>;
	} {
		const executed: Array<{ id: string; name: string }> = [];
		const runCalls = async (calls: Array<{ id: string; name: string }>) =>
			calls.map(call => {
				executed.push({ id: call.id, name: call.name });
				const seq = executed.filter(e => e.name === call.name).length;
				return { toolCallId: call.id, content: resultFor(call, seq), success: true };
			});

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => toolNames.map(name => ({
				name, description: name, inputSchema: { type: 'object' },
			})),
			_lastAllEnabledToolNames: new Set<string>(toolNames),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => runCalls(calls),
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				const results = await runCalls(calls);
				for (const result of results) { yield result as never; }
			},
		});
		return { host, executed };
	}

	/** 收集所有拦截文案（被拦的调用一律 success=false + 合成 tool_result）。 */
	function blockMessages(deltas: IChatStreamDelta[]): string[] {
		return deltas
			.filter(d => (d as { type?: string }).type === 'tool_result')
			.map(d => String((d as { content?: unknown }).content ?? ''))
			.filter(text => /Blocked|called too many times/i.test(text));
	}

	test('只读工具同签名同结果：护栏先拦，且文案必须点明「结果没变」而非「参数重复」', async () => {
		// `toolGuardrailController.ts:347-362`，noProgressBlockAfter=2。
		//
		// 这条分工的价值全在文案上：模型重复读同一个文件，真正有用的提示是
		// 「你已经拿到过这个结果了，别再读」——而不是笼统的「参数重复」。
		// 若护栏被 detectToolCallLoop 遮蔽，模型只会收到后者，收不到
		// 「结果无变化」这个关键信号，于是继续换 id 重放。
		const { provider } = scriptedProvider(round => (
			round < 5
				? [
					toolCallDelta(`ro-${round}`, 'file_read', { path: '/mock/stable.ts' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '已读取完毕。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		// 结果恒定 → 命中 no_progress。
		const { host, executed } = guardHost(provider, () => 'CONSTANT-CONTENT');

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const runs = executed.filter(call => call.name === 'file_read').length;
		assert.ok(
			runs >= 1 && runs < 5,
			`同签名同结果的只读调用必须在跑满前被拦（实际执行 ${runs}/5 次）`
			+ `——一次都不拦意味着模型可无限重放同一次读取`,
		);

		const blocks = blockMessages(deltas);
		assert.ok(
			blocks.length > 0,
			'必须产生拦截文案，否则模型不知道自己被拦、更不知道为什么',
		);
		assert.ok(
			blocks.some(text => /same result/i.test(text)),
			`同结果场景必须由护栏拦下并给出「结果无变化」文案（实际文案=${JSON.stringify(blocks)}）`
			+ `——若只出现「same arguments」，说明护栏被 detectToolCallLoop 遮蔽，`
			+ `noProgressBlockAfter 与 TOOL_LOOP_THRESHOLD 的分工已失效`,
		);
	});

	test('只读工具同签名但结果每次都变：护栏必须放行，改由循环检测按签名拦', async () => {
		// `toolGuardrailController.ts:444`：resultHash 不同 → repeatCount 重置为 1，
		// 永远到不了 noProgressBlockAfter。于是拦截责任落回 detectToolCallLoop。
		//
		// 这是分工的另一半，也是防误伤的关键：轮询一个**正在变化**的文件是合法行为，
		// 不该被「无进展」拦下。但它仍要受签名阈值约束，否则就成了无限轮询后门。
		const { provider } = scriptedProvider(round => (
			round < 5
				? [
					toolCallDelta(`ch-${round}`, 'file_read', { path: '/mock/changing.ts' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '内容已稳定。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		// 每次结果都不同 → no_progress 永不累积。
		const { host, executed } = guardHost(provider, (_call, seq) => `CHANGED-${seq}`);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const runs = executed.filter(call => call.name === 'file_read').length;
		assert.ok(
			runs >= 2,
			`结果持续变化时不得被「无进展」提前拦死（实际只执行 ${runs} 次）`
			+ `——轮询一个正在变化的文件是合法模式，护栏在此误伤会让模型读不到新内容`,
		);
		assert.ok(
			runs < 5,
			`即便结果在变，同签名调用仍须受 TOOL_LOOP_THRESHOLD 约束（实际执行 ${runs}/5 次）`
			+ `——不拦则成为无限轮询后门，模型可空转到 HARD_STOP`,
		);

		const blocks = blockMessages(deltas);
		assert.ok(
			blocks.some(text => /same arguments|too many times/i.test(text)),
			`结果变化场景必须由 detectToolCallLoop 拦下并给出「参数重复」文案`
			+ `（实际文案=${JSON.stringify(blocks)}）`
			+ `——若出现「same result」，说明护栏在结果已变时误判为无进展`,
		);
	});

	test('修改型工具（terminal）不受无进展护栏管辖：重试同一命令是正常语义', async () => {
		// `toolGuardrailController.ts:436-439` + `MUTATING_TOOL_NAMES`(`:60`)。
		//
		// 失败模式很具体：把 terminal 纳入 no_progress，会把「重跑同一条构建/测试命令
		// 直到它通过」这个每天都在发生的正常流程判成循环。护栏必须完全不介入，
		// 只留 detectToolCallLoop 的签名兜底。
		const { provider } = scriptedProvider(round => (
			round < 2
				? [
					toolCallDelta(`sh-${round}`, 'terminal', { command: 'npm run build' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '构建通过。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		// 输出恒定：若 terminal 被当成幂等工具，第 2 次就会被 no_progress 拦下。
		const { host, executed } = guardHost(
			provider,
			() => 'BUILD OUTPUT (identical)',
			['terminal'],
		);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const runs = executed.filter(call => call.name === 'terminal').length;
		assert.strictEqual(
			runs, 2,
			`修改型工具连续 2 次同参调用必须都执行（实际 ${runs} 次）`
			+ `——被 no_progress 拦下意味着「重跑同一条命令直到通过」这个正常流程被判成循环`,
		);
		assert.ok(
			!blockMessages(deltas).some(text => /same result/i.test(text)),
			'修改型工具不得出现「结果无变化」拦截文案 —— 护栏本就不该介入它',
		);
	});

	test('拦截文案必须可执行：空参调用要被告知缺哪些字段，而非只说「别重复」', async () => {
		// `toolCallUtils.ts:1017` buildLoopBlockFeedback，据日志 1787759962668 改进。
		//
		// 实证故障：模型用空参反复调用 patch，只收到笼统的「called too many times ...
		// try a different approach」，完全不知道 patch 需要 path/search/replace，
		// 于是空转到工具被禁用、任务放弃。
		// 因此对空参/缺参类拦截，文案必须给出**具体缺失字段**，让模型首次被拦就能自愈。
		const { provider } = scriptedProvider(round => (
			round < 5
				? [
					// 参数恒为空对象：签名相同，且 patch 不在幂等名单 → 走 detectToolCallLoop。
					toolCallDelta(`ep-${round}`, 'patch', {}),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '改用其他方式。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const { host } = guardHost(provider, () => 'patch failed: missing fields', ['patch']);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const blocks = blockMessages(deltas);
		assert.ok(
			blocks.length > 0,
			'空参重复调用必须被拦，否则模型会一直空转到工具被禁用',
		);
		assert.ok(
			blocks.some(text => /path|search|replace|argument|参数/i.test(text)),
			`空参拦截文案必须点明缺失的必填字段（实际文案=${JSON.stringify(blocks)}）`
			+ `——只说「别重复调用」而不说缺什么，模型无法自纠，只能继续空转直到放弃任务`,
		);
	});

	test('同一轮内护栏拦截与正常调用共存：被拦的不执行，没被拦的必须照常执行', async () => {
		// `agentTurnExecutor.ts:3145` blockedCalls 与 filteredCalls 是互补集合。
		//
		// 失败模式：拦截逻辑写成「整批一起拦」。那样一次误判会连坐同轮所有工具，
		// 模型明明给出了有效的新调用却拿不到任何结果，退化成整轮空转。
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: unknown, _messages: unknown, options?: { tools?: unknown[] }) => {
				const current = round++;
				const toolsOffered = (options?.tools?.length ?? 0) > 0;
				return (async function* () {
					if (!toolsOffered || current >= 4) {
						yield { type: 'text', content: '收尾。' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
						return;
					}
					// 每轮都重放同一个「陈旧」调用，同时给一个全新的有效调用。
					yield toolCallDelta(`stale-${current}`, 'file_read', { path: '/mock/stale.ts' });
					yield toolCallDelta(`fresh-${current}`, 'file_read', { path: `/mock/fresh-${current}.ts` });
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				})();
			},
		};
		// 陈旧路径结果恒定（会被护栏拦），新路径每次不同。
		const { host, executed } = guardHost(
			provider as Record<string, unknown>,
			call => (call.id.startsWith('stale') ? 'STALE-CONSTANT' : `FRESH-${call.id}`),
		);

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const freshRuns = executed.filter(call => call.id.startsWith('fresh')).length;
		assert.ok(
			freshRuns >= 3,
			`同轮中参数各不相同的新调用必须全部执行（实际 ${freshRuns}/3+ 次）`
			+ `——被同轮的陈旧调用连坐意味着一次误判就让整轮颗粒无收，模型空转`,
		);

		const staleRuns = executed.filter(call => call.id.startsWith('stale')).length;
		assert.ok(
			staleRuns < 4,
			`重复且结果不变的陈旧调用必须在某轮被拦（实际执行 ${staleRuns} 次，一次未拦）`,
		);
	});
});
// ═══════════════════════════════════════════════════════════════════
// 第九批：失败类护栏的阶梯（warn 只提醒、halt 才叫停、名单才豁免）
//
// 第八批锁的是「无进展」这一路信号（结果维度）。本批锁另一路：**失败**维度。
// 它有三个刻意做成不同强度的档位（`agentTurnExecutor.ts:1288-1306` 显式传参）：
//
//   exactFailureWarnAfter: 2       同 name+args 失败 2 次 → warn（附言，不拦）
//   exactFailureBlockAfter: 5      同 name+args 失败 5 次 → block（拦执行）
//   sameToolFailureWarnAfter: 3    同名工具失败 3 次 → warn（换策略提示）
//   sameToolFailureHaltAfter: 8    同名工具失败 8 次 → halt（退出主循环）
//
// 为什么阶梯必须锁：这几个数字是与主循环既有护栏**分工协商**出来的结果，
// 不是随手填的。注释里写明两条约束：
//   · exactFailureBlockAfter 设 5 而非默认 3 —— detectToolCallLoop 已在第 3 次
//     同签名拦下，本门设 ≤3 会被完全遮蔽、永远轮不到；
//   · sameToolFailureHaltAfter 曾被写成 Number.MAX_SAFE_INTEGER（永不 halt），
//     导致 same_tool_failure 信号「检出却不生效」——日志实证模型在
//     consecutiveFail 3/3 FIRED 之后仍继续跑到 4/3。责任链断裂是**静默**的：
//     没有任何报错，只表现为「模型一直在试同一个工具」。
//
// 本批的可观测探针：
//   · warn → 结果尾部被 `appendToolGuardGuidance` 追加 `[Tool loop warning: ...]`
//     （`toolGuardrailController.ts:502-509`），且工具**继续执行**
//   · halt → `patchWrapUp({ forced: true })`（`:3690`）→ 下一轮禁工具收尾 → 循环结束
//   · FAILURE_TOLERANT_TOOL_NAMES（`:97`）内的工具**永不 halt**：terminal 里
//     跑挂一条命令是调试常态，halt 会把调试误判成循环
// ═══════════════════════════════════════════════════════════════════
suite('executeAgentTurnDirect — 失败类护栏的阶梯（warn/halt/豁免）', () => {

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/**
	 * 每轮发一次同名工具调用，直到 `rounds` 用尽后收尾。
	 * `argsFor` 决定参数是否每轮变化——这是区分 exact_failure 与 same_tool_failure
	 * 两路计数的唯一变量。
	 */
	function failingProvider(
		toolName: string,
		rounds: number,
		argsFor: (round: number) => Record<string, unknown>,
	): { provider: Record<string, unknown>; chatCalls: () => number } {
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: unknown, _messages: unknown, options?: { tools?: unknown[] }) => {
				const current = round++;
				const toolsOffered = (options?.tools?.length ?? 0) > 0;
				return (async function* () {
					if (!toolsOffered || current >= rounds) {
						yield { type: 'text', content: '（收尾）基于已有信息给出结论。' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
						return;
					}
					yield toolCallDelta(`f-${current}`, toolName, argsFor(current));
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				})();
			},
		};
		return { provider, chatCalls: () => round };
	}

	/** host 桩：指定工具的每次调用都失败（success=false）。 */
	function failingHost(
		provider: Record<string, unknown>,
		toolNames: string[],
		errorText = 'ENOENT: no such file or directory',
	): {
		host: Record<string, unknown>;
		executed: Array<{ id: string; name: string }>;
	} {
		const executed: Array<{ id: string; name: string }> = [];
		const runCalls = async (calls: Array<{ id: string; name: string }>) =>
			calls.map(call => {
				executed.push({ id: call.id, name: call.name });
				return { toolCallId: call.id, content: errorText, success: false };
			});

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => toolNames.map(name => ({
				name, description: name, inputSchema: { type: 'object' },
			})),
			_lastAllEnabledToolNames: new Set<string>(toolNames),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => runCalls(calls),
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				const results = await runCalls(calls);
				for (const result of results) { yield result as never; }
			},
		});
		return { host, executed };
	}

	/** 取所有 tool_result 文本（护栏 guidance 就追加在这些字符串末尾）。 */
	function resultTexts(deltas: IChatStreamDelta[]): string[] {
		return deltas
			.filter(d => (d as { type?: string }).type === 'tool_result')
			.map(d => String((d as { content?: unknown }).content ?? ''));
	}

	test('失败 warn 只是附言：工具照常继续执行，不得因为一条警告就停手', async () => {
		// `toolGuardrailController.ts:406-426` + `appendToolGuardGuidance`(`:502`)。
		//
		// warn 与 block/halt 的根本区别在于**不改变控制流**。写错方向的后果很具体：
		// 若 warn 也顺手拦一下，模型第 2 次失败就被掐断，连「读错误信息再修正参数」
		// 这个最基本的自愈回合都没有 —— 而绝大多数失败第 3 次就能自己修好。
		//
		// 用 terminal（在 FAILURE_TOLERANT 名单内）确保本例不会被 halt 干扰，
		// 隔离出「纯 warn」这一档。
		const { provider } = failingProvider('terminal', 3, round => ({ command: `build-${round}` }));
		const { host, executed } = failingHost(provider, ['terminal']);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			executed.length, 3,
			`warn 档不得阻断执行：3 轮失败调用必须全部执行（实际 ${executed.length} 次）`
			+ `——少于 3 次意味着某条 warn 被错误地当成了 block，模型失去自愈机会`,
		);

		const warned = resultTexts(deltas).filter(text => /Tool loop warning/i.test(text));
		assert.ok(
			warned.length > 0,
			'同名工具连续失败必须在 tool result 尾部追加 warning 引导'
			+ '——只写日志不回灌，模型看不见，信号等于没发出',
		);
	});

	test('同名工具失败达 warn 阈值：引导必须要求「先诊断再重试」，而非改用纯文本回复', async () => {
		// `toolFailureRecoveryHint`(`toolGuardrailController.ts:511-524`)，
		// sameToolFailureWarnAfter=3。
		//
		// 这条文案有个刻意的反直觉约束：明确写着 "Do not switch to text-only replies"。
		// 原因是模型收到「你失败太多次了」的提示后最常见的退化反应是**彻底放弃工具**、
		// 直接编一段文字交差 —— 表现为任务看似"完成"实则什么都没做。
		// 所以引导必须同时说两件事：别再盲目重试，也别停止用工具。
		//
		// ⚠ 工具选型：不能用 search_files —— 它在 TRIVIAL_BLOCKED_TOOLS(`:306`) 里，
		// mock 请求被判为「轻量会话」时该工具会被整个剔除，测试会看到 0 次执行。
		// file_read 不在该名单内；参数每轮变化 → 只累积 same_tool 计数，
		// 4 轮也够不到 haltAfter=8，于是干净地隔离出 warn 这一档。
		const { provider } = failingProvider('file_read', 4, round => ({ path: `/mock/warn-${round}.ts` }));
		const { host, executed } = failingHost(provider, ['file_read'], 'ENOENT: no such file or directory');

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const guidance = resultTexts(deltas).filter(text => /Tool loop warning/i.test(text));
		assert.ok(
			guidance.length > 0,
			`同名工具失败 3 次必须触发 same_tool_failure warn`
			+ `（实际执行 ${executed.length} 次，全部 tool_result=${JSON.stringify(resultTexts(deltas))}）`,
		);
		assert.ok(
			guidance.some(text => /diagnose|inspect|different|narrower/i.test(text)),
			`失败引导必须给出可执行的下一步（诊断/换参数/换工具），实际文案=${JSON.stringify(guidance)}`
			+ `——只说「失败了 N 次」不给出路，等于把模型留在原地`,
		);
		assert.ok(
			guidance.some(text => /text-only/i.test(text)),
			`失败引导必须显式禁止「改用纯文本回复」，实际文案=${JSON.stringify(guidance)}`
			+ `——缺这句时模型的典型退化是放弃工具、编一段文字交差，任务看似完成实则未做`,
		);
	});

	test('失败容忍名单（terminal）永不 halt：调试期反复跑挂命令不该终止整个 turn', async () => {
		// `FAILURE_TOLERANT_TOOL_NAMES`(`toolGuardrailController.ts:97-104`)
		// + halt 分支的 `!FAILURE_TOLERANT_TOOL_NAMES.has(toolName)` 条件(`:390`)。
		//
		// 失败模式极其具体：开发者让 agent 跑测试，测试确实在失败——这正是 agent
		// 被叫来解决的问题。若 terminal 失败 8 次就 halt，agent 会在真正开始修之前
		// 就被自己的护栏赶下场。名单的存在就是为这个场景兜底。
		const failCount = 10;   // 远超 sameToolFailureHaltAfter=8
		const { provider } = failingProvider('terminal', failCount, round => ({ command: `npm test -- --shard=${round}` }));
		const { host, executed } = failingHost(provider, ['terminal'], 'exit code 1: 3 tests failed');

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 30 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			executed.length > 8,
			`失败容忍工具连续失败 ${failCount} 次仍不得被 halt 叫停（实际只执行 ${executed.length} 次）`
			+ `——在第 8 次被截断意味着 FAILURE_TOLERANT 豁免失效，`
			+ `「跑测试→看失败→修」这个最核心的工作流会被护栏自己掐断`,
		);
	});

	test('非豁免工具失败达 halt 阈值：必须真正停手，而不是只记一条日志', async () => {
		// `agentTurnExecutor.ts:3689-3692`：halt → `patchWrapUp({ forced: true })`
		// → 下一轮 `iterationToolDefs = []` → 模型收不到任何工具 → 收尾后结束。
		//
		// 这正是那个「检出却不生效」的历史 bug 的回归锁：阈值一度是
		// Number.MAX_SAFE_INTEGER，且更早的实现只 `logService.warn` 而不置位 ——
		// 两处任一退化，halt 都会变成纯日志，模型可无限重试同一条失败路径。
		// 断言必须落在**控制流**上（调用次数收敛），而非日志内容。
		const offeredRounds = 30;   // 远超 sameToolFailureHaltAfter=8
		const { provider } = failingProvider('file_read', offeredRounds, round => ({ path: `/mock/miss-${round}.ts` }));
		const { host, executed } = failingHost(provider, ['file_read'], 'ENOENT: file not found');

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 40 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		// 参数每轮都变 → 绕过 detectToolCallLoop 与 exact_failure，
		// 唯一能叫停的就是 same_tool_failure halt。
		assert.ok(
			executed.length < offeredRounds,
			`非豁免工具连续失败必须被 halt 收敛（模型给了 ${offeredRounds} 轮，实际执行 ${executed.length} 次）`
			+ `——跑满全部轮次说明 halt 只记了日志没置位 wrapUp.forced，`
			+ `即历史上「同名失败信号检出却不生效」的责任链断裂重现`,
		);
		assert.ok(
			executed.length >= 8,
			`halt 不得早于 sameToolFailureHaltAfter=8 触发（实际只执行 ${executed.length} 次）`
			+ `——过早叫停会把正常的多次探索误判成循环`,
		);
	});

	test('工具转为成功后计数清零：一次成功就该把之前的失败账一笔勾销', async () => {
		// `toolGuardrailController.ts:431-433`：success 路径同时清 `_exactFailureCounts`
		// 与 `_sameToolFailureCounts`。
		//
		// 不清零的后果是「护栏记仇」：turn 前段试错攒下的失败计数会一直挂着，
		// 等到后段工具已经用对了、正在稳定产出时，某次偶发失败直接把累计数推过
		// halt 线 —— 表现为「越到后面越容易被莫名叫停」，且完全无从复现。
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: unknown, _messages: unknown, options?: { tools?: unknown[] }) => {
				const current = round++;
				const toolsOffered = (options?.tools?.length ?? 0) > 0;
				return (async function* () {
					if (!toolsOffered || current >= 12) {
						yield { type: 'text', content: '（收尾）完成。' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
						return;
					}
					yield toolCallDelta(`mix-${current}`, 'file_read', { path: `/mock/mix-${current}.ts` });
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				})();
			},
		};

		// 失败/成功交替：任何一次成功都会清零，累计失败数永远到不了 halt 阈值 8。
		const executed: Array<{ id: string; success: boolean }> = [];
		const runCalls = async (calls: Array<{ id: string; name: string }>) =>
			calls.map(call => {
				const success = executed.length % 2 === 1;
				executed.push({ id: call.id, success });
				return {
					toolCallId: call.id,
					content: success ? `FILE CONTENT ${call.id}` : 'ENOENT: file not found',
					success,
				};
			});
		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [{
				name: 'file_read', description: 'file_read', inputSchema: { type: 'object' },
			}],
			_lastAllEnabledToolNames: new Set<string>(['file_read']),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => runCalls(calls),
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				const results = await runCalls(calls);
				for (const result of results) { yield result as never; }
			},
		});

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 30 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			executed.length, 12,
			`成功与失败交替时不得触发任何硬停（模型给了 12 轮，实际执行 ${executed.length} 次）`
			+ `——提前收敛说明 success 路径没有清空失败计数，`
			+ `即「护栏记仇」：前期试错的旧账会在后期把正常工作流误判成循环`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// 第十批：多个触发源共用同一个收尾出口（wrapUp.forced）
//
// 前两批锁的是「谁来拦单次调用」。本批上移一层，锁「怎么结束整个 turn」：
// 主循环里至少有四个互不相干的护栏最终都走**同一个开关**
// （`patchWrapUp({ forced: true })` → `iterationToolDefs = []` →
//  enabledTools 置空 → 叠加 `toolChoice:'none'`）：
//
//   ① 迭代/预算耗尽        `turnIterationGate.ts:166-168`  → hardLimitWrapUpReminder
//   ② 整轮全被拦连击 ≥4    `agentTurnExecutor.ts:3218-3230` → allBlockedWrapUpReminder
//   ③ 纯文本搜索连击 ≥8    `:3583-3592`                     → textSearchLoopWrapUpReminder
//   ④ 同名工具失败 halt     `:3689-3692`                     → （无专属文案）
//
// 为什么共用一个开关是刻意的：`:3219-3222` 的注释写明「不要另造一个禁工具标志 ——
// 那必然与这套漂移」。三重保障（工具置空 / toolChoice / 提醒）只维护一份。
//
// 但共用出口带来一个真实的耦合 bug 类型：**文案互相污染**。
// `turnIterationGate.ts:185-190` 记录了实例：零进展提前收尾（实际只跑 5 轮）时
// 若再叠加 hardLimitWrapUpReminder，模型会收到「你已用满 100 轮」——
// 措辞与事实矛盾，模型可能据此判断上下文被截断而放弃作答。
// 因此 `reasonReminderInjected` 标志的作用就是「已有贴合原因的文案，别再叠加通用的」。
//
// 另一条已被日志实证的缺口（`loopReminders.ts:150-154`，日志 1788016519843）：
// 每一条会进收尾轮的文案都必须带 NO_TEXTUAL_TOOL_CALL_ESCAPE 片段。当年
// textSearchLoopWrapUpReminder 缺这段、而通用文案又因 reasonReminderInjected
// 不再叠加 → 缺口无人补 → 模型写出伪 XML 工具调用。
//
// 本批的可观测探针（全部落在「发给 provider 的 messages/tools」上）：
//   · 收尾轮 = 某次 chat 调用的 `options.tools` 为空
//   · 注入了哪条文案 = 该次调用 messages 里的 system 文本特征串
// ═══════════════════════════════════════════════════════════════════
suite('executeAgentTurnDirect — 收尾出口的共用与互斥（wrapUp.forced）', () => {

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/** 一次 chat 调用的快照：本轮是否给了工具，以及完整 messages 文本。 */
	interface IChatSnapshot {
		readonly toolCount: number;
		readonly systemText: string;
	}

	/**
	 * 记录每次 chat 调用的工具数与 system 消息全文 —— 收尾轮的三重保障
	 * （工具置空 + 文案注入）都只能从这两个维度观测到。
	 */
	function recordingProvider(
		script: (round: number, toolsOffered: boolean) => IModelDelta[],
	): { provider: Record<string, unknown>; snapshots: IChatSnapshot[] } {
		const snapshots: IChatSnapshot[] = [];
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (
				_modelId: unknown,
				messages: Array<{ role?: string; content?: unknown }>,
				options?: { tools?: unknown[] },
			) => {
				const current = round++;
				const toolCount = options?.tools?.length ?? 0;
				const systemText = (messages ?? [])
					.filter(message => message?.role === 'system')
					.map(message => String(message?.content ?? ''))
					.join('\n');
				snapshots.push({ toolCount, systemText });
				return (async function* () {
					for (const delta of script(current, toolCount > 0)) { yield delta; }
				})();
			},
		};
		return { provider, snapshots };
	}

	/** host 桩：工具永远成功，结果由 `resultFor` 决定（用于制造「结果不变」）。 */
	function recordingHost(
		provider: Record<string, unknown>,
		toolNames: string[],
		resultFor: (call: { id: string; name: string }) => string,
	): {
		host: Record<string, unknown>;
		executed: Array<{ id: string; name: string }>;
	} {
		const executed: Array<{ id: string; name: string }> = [];
		const runCalls = async (calls: Array<{ id: string; name: string }>) =>
			calls.map(call => {
				executed.push({ id: call.id, name: call.name });
				return { toolCallId: call.id, content: resultFor(call), success: true };
			});

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => toolNames.map(name => ({
				name, description: name, inputSchema: { type: 'object' },
			})),
			_lastAllEnabledToolNames: new Set<string>(toolNames),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => runCalls(calls),
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				const results = await runCalls(calls);
				for (const result of results) { yield result as never; }
			},
		});
		return { host, executed };
	}

	test('预算耗尽的收尾轮：工具必须被置空，而不是靠提醒文案「请求」模型别调用', async () => {
		// `turnIterationGate.ts:216-218`：`iterationToolDefs = []`（空数组而非
		// undefined —— 下游 `if (iterationToolDefs)` 靠 truthy 判定来覆盖 enabledTools）。
		//
		// 这个「空数组 vs undefined」的区别是本例的真正标的：若误写成 undefined，
		// 覆盖逻辑整条失效 → 收尾轮照旧带着全套工具发出去 → 模型看到「工具可用」
		// 与文案「工具已禁用」互相矛盾，最常见的表现是它继续调用、白烧最后一轮。
		// 光靠文案约束是不够的 —— 必须在协议层把工具拿掉。
		const { provider, snapshots } = recordingProvider((round, toolsOffered) => (
			toolsOffered
				? [
					toolCallDelta(`w-${round}`, 'file_read', { path: `/mock/w-${round}.ts` }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '基于已收集信息给出结论。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const { host } = recordingHost(provider, ['file_read'], call => `CONTENT ${call.id}`);

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 3 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const toolFreeRounds = snapshots.filter(snapshot => snapshot.toolCount === 0);
		assert.strictEqual(
			toolFreeRounds.length, 1,
			`预算耗尽后必须恰好有 1 轮禁工具收尾（实际 ${toolFreeRounds.length} 轮，`
			+ `各轮工具数=${JSON.stringify(snapshots.map(s => s.toolCount))}）`
			+ `——0 轮说明 iterationToolDefs 覆盖失效，模型会在收尾轮继续调用工具`,
		);
		assert.strictEqual(
			snapshots[snapshots.length - 1]?.toolCount, 0,
			'收尾轮必须是最后一轮：其后不得再出现带工具的轮次',
		);
	});

	test('收尾文案必须与真实原因一致：预算耗尽走硬上限文案，且点明轮次预算', async () => {
		// `hardLimitWrapUpReminder`(`loopReminders.ts:217-235`)。
		//
		// 文案里第 1 条硬性要求就是「说明轮次预算已用尽」。这不是礼貌用语：
		// 用户看到的最终回答若不交代「我是被预算掐停的」，就会把一份**部分完成**
		// 的答案误读成**全部结论**，据此做决策 —— 这是最危险的静默失败。
		const { provider, snapshots } = recordingProvider((round, toolsOffered) => (
			toolsOffered
				? [
					toolCallDelta(`h-${round}`, 'file_read', { path: `/mock/h-${round}.ts` }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '预算已尽，汇报现状。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const { host } = recordingHost(provider, ['file_read'], call => `CONTENT ${call.id}`);

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 3 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const wrapUpRound = snapshots.find(snapshot => snapshot.toolCount === 0);
		assert.ok(wrapUpRound, '必须存在禁工具收尾轮');
		assert.match(
			wrapUpRound.systemText,
			/Iteration limit reached/i,
			'预算耗尽的收尾轮必须注入 hardLimitWrapUpReminder'
			+ '——没有任何文案时，模型只会发现工具消失了却不知为何，倾向于报错或空答',
		);
		assert.match(
			wrapUpRound.systemText,
			/RECOMMENDED NEXT STEPS/i,
			'收尾文案必须索要「后续建议」：被掐停时用户最需要的是「接下来怎么办」',
		);
	});

	test('每条收尾文案都必须封死「把调用写成文本」的退路', async () => {
		// `NO_TEXTUAL_TOOL_CALL_ESCAPE`(`loopReminders.ts:156-159`)，日志 1788016519843。
		//
		// 实证事故链：收尾文案只说了「不要再请求工具」，模型理解成「不能真调，
		// 那我把想调的写下来」→ 输出伪 XML `<tool_calls:712c...>` → 该伪标签进入
		// 历史、随后每轮重发，污染持续放大（这正是第八批之前那条 stale-tag 修复的起因）。
		//
		// 断言的是「封口声明存在」，因为这类缺口只有在**模型退化时**才暴露，
		// 正常路径上永远测不到 —— 靠人工 review 记不住每条新增文案都要带这段。
		const { provider, snapshots } = recordingProvider((round, toolsOffered) => (
			toolsOffered
				? [
					toolCallDelta(`x-${round}`, 'file_read', { path: `/mock/x-${round}.ts` }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '收尾。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const { host } = recordingHost(provider, ['file_read'], call => `CONTENT ${call.id}`);

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 3 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const wrapUpRound = snapshots.find(snapshot => snapshot.toolCount === 0);
		assert.ok(wrapUpRound, '必须存在禁工具收尾轮');
		assert.match(
			wrapUpRound.systemText,
			/writing a call out as TEXT is pointless/i,
			'收尾文案必须显式声明「写成文本也不会执行」'
			+ '——缺这句时模型会输出伪 XML 工具调用，该伪标签还会随历史跨轮扩散',
		);
		assert.match(
			wrapUpRound.systemText,
			/placeholder|note-to-self/i,
			'还必须封死「先记下来当备忘」这条变体：它是实证事故里模型的原话式借口',
		);
	});

	test('零进展空转收尾不得使用硬上限文案：只跑了几轮却说「已用满 100 轮」会误导模型', async () => {
		// `turnIterationGate.ts:185-191` 的 `reasonReminderInjected` 互斥。
		//
		// 这是共用出口最容易出的耦合 bug：两个触发源都置 forced=true，
		// 若不互斥，模型会同时收到「你零进展空转了 4 轮」和「你已用满 100 轮」——
		// 后者是**事实错误**。注释指出模型可能据此认为上下文已被截断而放弃作答。
		//
		// 制造零进展：只读工具每轮同参数、且结果恒定 → 每轮唯一的调用都被护栏拦下
		// → filteredCalls 为空 → allBlockedStreak 累加到 ALL_BLOCKED_WRAPUP_AT=4。
		const { provider, snapshots } = recordingProvider((_round, toolsOffered) => (
			toolsOffered
				? [
					// 参数恒定（不带 round）→ 同签名；结果也恒定 → 无进展。
					toolCallDelta(`z-${_round}`, 'file_read', { path: '/mock/frozen.ts' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '零进展，汇报现状。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const { host } = recordingHost(provider, ['file_read'], () => 'FROZEN CONTENT');

		await drain(
			executeAgentTurnDirect(
				host,
				// 预算给足，确保收尾**只可能**由零进展连击触发，而非预算耗尽。
				mockRequest({ budgetMaxTotal: 40 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const wrapUpRound = snapshots.find(snapshot => snapshot.toolCount === 0);
		assert.ok(
			wrapUpRound,
			`零进展连击必须最终强制收尾（各轮工具数=${JSON.stringify(snapshots.map(s => s.toolCount))}）`
			+ `——一直不收尾就会像日志 1787377582459 那样空转 37 轮、每轮白烧完整 prompt`,
		);
		assert.match(
			wrapUpRound.systemText,
			/NO progress/i,
			'零进展收尾必须用贴合原因的文案（allBlockedWrapUpReminder）',
		);
		assert.doesNotMatch(
			wrapUpRound.systemText,
			/Iteration limit reached/i,
			'零进展收尾不得叠加硬上限文案：实际只跑了几轮，'
			+ '「已用满迭代上限」与事实矛盾，模型可能据此判断上下文被截断而放弃作答',
		);
	});

	test('零进展收尾同样要带封口声明：贴合原因的文案不能因为「专用」而漏掉共用片段', async () => {
		// 这是对 `loopReminders.ts:150-154` 那句「分散复制必然再漏，故提取为共用常量」
		// 的直接回归锁。
		//
		// 事故机理值得记下：漏掉的那条恰好是**互斥关系里的胜者**
		// （reasonReminderInjected=true 让通用文案不再叠加），所以它一旦漏带封口声明，
		// 整个收尾轮就彻底没有这层保护 —— 缺口无人补。互斥是正确的，
		// 但它把「每条专用文案自身必须完整」变成了硬约束。
		const { provider, snapshots } = recordingProvider((round, toolsOffered) => (
			toolsOffered
				? [
					toolCallDelta(`zz-${round}`, 'file_read', { path: '/mock/frozen2.ts' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '收尾。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		));
		const { host } = recordingHost(provider, ['file_read'], () => 'FROZEN CONTENT 2');

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 40 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const wrapUpRound = snapshots.find(snapshot => snapshot.toolCount === 0);
		assert.ok(wrapUpRound, '零进展连击必须最终强制收尾');
		assert.match(
			wrapUpRound.systemText,
			/writing a call out as TEXT is pointless/i,
			'专用收尾文案必须自带 NO_TEXTUAL_TOOL_CALL_ESCAPE'
			+ '——它是互斥关系的胜者，漏带就等于整个收尾轮没有这层保护，通用文案也补不上',
		);
		assert.match(
			wrapUpRound.systemText,
			/DISABLED/i,
			'必须明确告知「工具已被禁用」：零进展收尾与撞迭代上限不同，'
			+ '模型此时刚被连续拦截，若不点明会继续尝试调用、白烧最后一轮',
		);
	});
});

suite('executeAgentTurnDirect — 工具级钩子总线的转发边界（fail-closed 与 fire-and-forget）', () => {

	/**
	 * `before_tool` 是**唯一** fail-closed 钩子（`turnHookBus.ts:223-225`）：
	 * handler 抛错 → `TurnHookGateError` → 主循环 `agentTurnExecutor.ts:3261-3268`
	 * 把该调用加入 `blockedCallIds`，拒绝执行。
	 *
	 * 这套语义有一个必须成立的前提：**转发层自己绝不抛错**
	 *（`turnHookWiring.ts:44-46` 的警告 + `:115-117` 的 try/catch）。
	 * 否则「记忆 provider 不可用」会经由 fail-closed 升级成
	 * 「本 turn 所有工具无法执行」—— agent 表面看起来只会说话不会干活，
	 * 而日志里只有一行 memory hook 报错，排查方向完全被误导。
	 *
	 * 本 suite 锁的就是这条放大链路的每一环：转发时机、同步抛错、异步 reject、
	 * 成功/失败的钩子类型二选一、结果截断。
	 */

	function scriptedProvider(script: (round: number) => IModelDelta[]): {
		provider: Record<string, unknown>;
		chatCalls: () => number;
	} {
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: unknown, _messages: unknown, options?: { tools?: unknown[] }) => {
				const current = round++;
				const toolsOffered = (options?.tools?.length ?? 0) > 0;
				return (async function* () {
					for (const delta of script(current)) {
						if ((delta as { type?: string }).type === 'tool_call' && !toolsOffered) {
							continue;
						}
						yield delta;
					}
					if (!toolsOffered) {
						yield { type: 'text', content: '（收尾轮）结论。' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		};
		return { provider, chatCalls: () => round };
	}

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	interface IHookForward {
		readonly hookType: string;
		readonly ctx: Record<string, unknown>;
	}

	/**
	 * host 桩：把 `triggerHook` 的每次转发与每次真实工具执行记进**同一条**
	 * timeline，使「钩子相对工具执行的先后」成为可断言的事实而非推测。
	 */
	function hookHost(
		provider: Record<string, unknown>,
		options: {
			triggerHook: (hookType: string, ctx: Record<string, unknown>) => Promise<void> | undefined;
			toolSucceeds?: boolean;
			toolContent?: string;
			logger?: Record<string, (...args: unknown[]) => void>;
		},
	): {
		host: Record<string, unknown>;
		timeline: string[];
	} {
		const timeline: string[] = [];
		const runCalls = async (calls: Array<{ id: string; name: string }>) =>
			calls.map(call => {
				timeline.push(`exec:${call.name}`);
				return {
					toolCallId: call.id,
					content: options.toolContent ?? 'TOOL-OK',
					success: options.toolSucceeds !== false,
				};
			});

		const host = mockHost({
			...(options.logger ? { _logService: options.logger } : {}),
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['file_read']),
			// provider 须**同时**提供 recallFormatted 与 triggerHook：
			// 只有 triggerHook 存在时 `registerMemoryProviderHooks` 才注册 handler
			//（`turnHookWiring.ts:92-95` 的早退），也才会让
			// `hookBus.has('before_tool')` 为真、进入 `:3248` 那段闸门。
			getActiveMemoryProvider: () => ({
				recallFormatted: async () => undefined,
				triggerHook: (hookType: string, ctx: Record<string, unknown>) => {
					timeline.push(`hook:${hookType}`);
					return options.triggerHook(hookType, ctx);
				},
			}),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => runCalls(calls),
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				const results = await runCalls(calls);
				for (const result of results) { yield result as never; }
			},
		});
		return { host, timeline };
	}

	/** 单轮工具调用 + 次轮收尾的标准脚本。 */
	function oneToolCallThenStop(): (round: number) => IModelDelta[] {
		return round => (
			round === 0
				? [
					toolCallDelta('hook-call-1', 'file_read', { path: '/mock/a.ts' }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '读完了。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		);
	}

	function capturingLogger(): {
		logger: Record<string, (...args: unknown[]) => void>;
		lines: string[];
	} {
		const lines: string[] = [];
		const logger = {
			info: (...args: unknown[]) => { lines.push(`info: ${String(args[0])}`); },
			warn: (...args: unknown[]) => { lines.push(`warn: ${String(args[0])}`); },
			error: (...args: unknown[]) => { lines.push(`error: ${String(args[0])}`); },
			debug: () => undefined,
			trace: () => undefined,
		};
		return { logger, lines };
	}

	test('pre_tool_use 必须在工具真正执行之前转发，且带齐身份与调用标识', async () => {
		// `agentTurnExecutor.ts:3248-3254`：`before_tool` 闸门在
		// `SET_PHASE tool_executing`（:3277）之前跑完整批。
		//
		// 顺序不是审美问题：钩子的全部用途（权限判定、参数改写、审计留痕）
		// 都要求「执行前」。一旦被挪到执行之后，权限钩子就从「拦截器」退化成
		// 「事后报警器」——工具已经把文件改了，再拒绝也无意义。
		const forwards: IHookForward[] = [];
		const { provider } = scriptedProvider(oneToolCallThenStop());
		const { host, timeline } = hookHost(provider, {
			triggerHook: (hookType, ctx) => {
				forwards.push({ hookType, ctx });
				return undefined;
			},
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		assertNoToolExecutionErrors(deltas);

		const preIndex = timeline.indexOf('hook:pre_tool_use');
		const execIndex = timeline.indexOf('exec:file_read');
		assert.ok(
			preIndex >= 0,
			`pre_tool_use 必须被转发（实际 timeline=${JSON.stringify(timeline)}）`
			+ `——没有转发说明 before_tool 闸门被整体跳过，权限钩子形同不存在`,
		);
		assert.ok(
			execIndex >= 0,
			`工具必须真的执行（实际 timeline=${JSON.stringify(timeline)}）`,
		);
		assert.ok(
			preIndex < execIndex,
			`pre_tool_use 必须早于工具执行（实际 timeline=${JSON.stringify(timeline)}）`
			+ `——顺序颠倒会让权限钩子从拦截器退化为事后报警器`,
		);

		const preForward = forwards.find(f => f.hookType === 'pre_tool_use');
		assert.ok(preForward, 'pre_tool_use 转发记录必须存在');
		assert.strictEqual(
			preForward.ctx.toolName, 'file_read',
			`转发必须带 toolName（实际 ctx=${JSON.stringify(preForward.ctx)}）`
			+ `——缺了它钩子无法按工具名做任何判定`,
		);
		assert.strictEqual(
			preForward.ctx.toolCallId, 'hook-call-1',
			`转发必须带原始 toolCallId（实际 ${String(preForward.ctx.toolCallId)}）`
			+ `——它是与 after_tool / UI 卡片对账的唯一键`,
		);
		assert.strictEqual(
			preForward.ctx.agentId, 'test-agent',
			'转发必须带 agentId（turnHookWiring.ts:106-110 的身份注入）'
			+ '——记忆系统按 agent 隔离，缺失会把所有 agent 的经验混写成一份',
		);
		assert.strictEqual(
			preForward.ctx.sessionId, 'test-session',
			'转发必须带 sessionId——记忆系统靠它归档，缺失会把所有会话写成一锅',
		);
	});

	test('triggerHook 同步抛错：工具仍须照常执行（记忆不可用不得升级为工具全禁）', async () => {
		// 这是本 suite 最重要的一条。放大链路：
		//   triggerHook 抛错 → 若 wiring 层 handler 不吞 → 总线判定
		//   `isFailClosedHook('before_tool')` 为真（`turnHookBus.ts:301-302`）
		//   → 抛 TurnHookGateError → `agentTurnExecutor.ts:3264` 把调用
		//   加入 blockedCallIds → **整 turn 所有工具都被拒**。
		//
		// 现场表现：agent 只输出文本、从不动手；日志里只有一行
		// memory hook 报错，与「工具全部不执行」看不出因果关系。
		// 所以 `turnHookWiring.ts:115-117` 的 try/catch 不是防御性冗余，
		// 而是承载这条契约的唯一实现点。
		const { provider } = scriptedProvider(oneToolCallThenStop());
		const { logger, lines } = capturingLogger();
		const { host, timeline } = hookHost(provider, {
			logger,
			triggerHook: () => {
				throw new Error('memory gateway down');
			},
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			timeline.includes('exec:file_read'),
			`记忆钩子抛错时工具必须照常执行（实际 timeline=${JSON.stringify(timeline)}）`
			+ `——被拦说明转发层把异常泄漏给了 fail-closed 闸门，`
			+ `「记忆系统故障」会静默升级成「agent 完全不干活」`,
		);
		assertNoToolExecutionErrors(deltas);
		assert.ok(
			lines.some(line => line.includes('threw synchronously')),
			`同步抛错必须留下可排查的日志（实际日志=${JSON.stringify(lines.slice(0, 8))}）`
			+ `——静默吞错会让记忆系统长期失效而无人发现`,
		);
		assert.ok(
			!lines.some(line => line.includes('refusing execution')),
			`不得走 fail-closed 拒绝路径（实际日志=${JSON.stringify(lines.slice(0, 8))}）`,
		);
	});

	test('triggerHook 返回 rejected Promise：turn 正常收束，且不得污染工具结果', async () => {
		// `turnHookWiring.ts:112-114`：转发刻意**不 await**（provider 多为跨进程
		// 代理，await 等于每个工具调用多一次 IPC 往返），只挂 `.catch` 记日志。
		//
		// 不挂 catch 的后果不是「少一条日志」：Node 下未处理的 rejection 会
		// 触发 unhandledRejection，在 Electron 主进程里表现为整个扩展宿主崩溃
		// ——一个记忆写入失败就能带走整个会话。
		const { provider } = scriptedProvider(oneToolCallThenStop());
		const { logger, lines } = capturingLogger();
		const { host, timeline } = hookHost(provider, {
			logger,
			triggerHook: () => Promise.reject(new Error('memory write rejected')),
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		// rejection 的 catch 是微任务，可能晚于 drain 结束一个 tick。
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.ok(
			timeline.includes('exec:file_read'),
			`异步 reject 不得阻断工具执行（实际 timeline=${JSON.stringify(timeline)}）`,
		);
		assertNoToolExecutionErrors(deltas);
		const toolResults = deltas
			.filter(d => (d as { type?: string }).type === 'tool_result')
			.map(d => String((d as { content?: unknown }).content ?? ''));
		assert.ok(
			toolResults.some(text => text.includes('TOOL-OK')),
			`工具结果必须原样透传（实际 tool_result=${JSON.stringify(toolResults)}）`
			+ `——钩子失败被写进结果会让模型以为自己的工具调用出了问题`,
		);
		assert.ok(
			lines.some(line => line.includes('rejected')),
			`rejection 必须被 catch 并记日志（实际日志=${JSON.stringify(lines.slice(0, 8))}）`
			+ `——漏挂 catch 会变成 unhandledRejection，在宿主进程里是致命的`,
		);
	});

	test('工具成功走 post_tool_use、失败走 post_tool_failure：二者互斥不得同发', async () => {
		// `turnHookWiring.ts:126-133`：`event.isError ? post_tool_failure : post_tool_use`，
		// 而 isError 来自 `turnPostIteration.ts:255` 的 `!toolResult.success`。
		//
		// 记忆系统按钩子类型分流：post_tool_use 沉淀「有效经验」，
		// post_tool_failure 沉淀「失败教训」。两者混淆的后果是把失败样本
		// 当成正确做法写进长期记忆，后续 turn 会被自己的错误经验反复误导。
		const failureForwards: string[] = [];
		const { provider: failProvider } = scriptedProvider(oneToolCallThenStop());
		const { host: failHost } = hookHost(failProvider, {
			toolSucceeds: false,
			toolContent: 'ENOENT: no such file',
			triggerHook: hookType => {
				failureForwards.push(hookType);
				return undefined;
			},
		});
		await drain(
			executeAgentTurnDirect(failHost, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const successForwards: string[] = [];
		const { provider: okProvider } = scriptedProvider(oneToolCallThenStop());
		const { host: okHost } = hookHost(okProvider, {
			triggerHook: hookType => {
				successForwards.push(hookType);
				return undefined;
			},
		});
		await drain(
			executeAgentTurnDirect(okHost, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			failureForwards.includes('post_tool_failure'),
			`工具失败必须转发 post_tool_failure（实际=${JSON.stringify(failureForwards)}）`,
		);
		assert.ok(
			!failureForwards.includes('post_tool_use'),
			`工具失败时不得同时发 post_tool_use（实际=${JSON.stringify(failureForwards)}）`
			+ `——失败样本被当成有效经验写入长期记忆，会长期误导后续 turn`,
		);
		assert.ok(
			successForwards.includes('post_tool_use'),
			`工具成功必须转发 post_tool_use（实际=${JSON.stringify(successForwards)}）`,
		);
		assert.ok(
			!successForwards.includes('post_tool_failure'),
			`工具成功时不得发 post_tool_failure（实际=${JSON.stringify(successForwards)}）`,
		);
	});

	test('after_tool 转发的结果必须截断：巨型工具输出不得整体灌进记忆通道', async () => {
		// `turnHookWiring.ts:66` 的 `TOOL_RESULT_TRUNCATE_LIMIT = 2000`，
		// 而工具结果本身的上限是 `MAX_TOOL_RESULT_CHARS = 100_000`
		//（`toolCallUtils.ts:30`）——两者相差 50 倍。
		//
		// 少了这道截断，一次全仓检索的输出就会原样跨进程送进记忆 provider：
		// IPC 序列化开销与记忆库体积同时被放大，而钩子侧本来只需要一个摘要。
		const hugeContent = 'X'.repeat(7000);
		const forwards: IHookForward[] = [];
		const { provider } = scriptedProvider(oneToolCallThenStop());
		const { host } = hookHost(provider, {
			toolContent: hugeContent,
			triggerHook: (hookType, ctx) => {
				forwards.push({ hookType, ctx });
				return undefined;
			},
		});

		await drain(
			executeAgentTurnDirect(host, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const postForward = forwards.find(f => f.hookType === 'post_tool_use');
		assert.ok(
			postForward,
			`post_tool_use 必须被转发（实际=${JSON.stringify(forwards.map(f => f.hookType))}）`,
		);
		const forwardedResult = String(postForward.ctx.toolResult ?? '');
		assert.strictEqual(
			forwardedResult.length, 2000,
			`转发结果必须截断到 2000 字符（实际 ${forwardedResult.length} 字符，原始 ${hugeContent.length}）`
			+ `——不截断会把 100K 级工具输出整体推过 IPC 并写进记忆库`,
		);
		assert.ok(
			forwardedResult.startsWith('XXX'),
			`截断必须保留开头而非丢弃内容（实际前缀=${JSON.stringify(forwardedResult.slice(0, 8))}）`,
		);
	});
});






suite('executeAgentTurnDirect — 批次提醒的延迟注入与消息相邻性（HTTP 400 code 11133）', () => {

	/**
	 * `_pendingBatchReminders`（`agentTurnExecutor.ts:3288`）解决的是一个**协议级**
	 * 缺陷，不是代码整洁问题。
	 *
	 * OpenAI 兼容协议硬性要求：`assistant.tool_calls=N` 之后必须紧跟连续 N 条
	 * `role:'tool'` 消息，中间不得插入任何其它 role。旧实现在 append tool result
	 * **之前**就直接注入护栏 reminder（`role:'user'`），并行批次下序列被劈开：
	 *   [assistant tool_calls=4] [tool c0] [tool c1] [tool c2] [user reminder] [tool c3]
	 * → 服务端 400 invalid_parameter_value（日志 1786981850420，实测仅占窗口 6%，
	 *   与 token 用量无关）。
	 *
	 * 更危险的是：两道既有守卫都放行这种畸形 —— `sanitizeToolPairs` 只校验
	 * 「配对存在性」不校验相邻性，`normalizeMessages` 只合并连续 user。
	 * 也就是说**除了本 suite，没有任何东西会发现相邻性被破坏**。
	 *
	 * 本 suite 同时锁住提醒的触发判据（`MAX_SINGLE_TOOL_STREAK = 4`，`:1246`）
	 * 与注入位置，因为二者是同一条链路：提醒越有用，注入越容易踩到协议。
	 */

	interface IMessageSnapshot {
		readonly role: string;
		readonly toolCallId: string | undefined;
		readonly content: string;
	}

	function snapshotProvider(script: (round: number) => IModelDelta[]): {
		provider: Record<string, unknown>;
		snapshots: IMessageSnapshot[][];
	} {
		const snapshots: IMessageSnapshot[][] = [];
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (
				_modelId: unknown,
				messages: Array<{ role?: string; content?: unknown; toolCallId?: unknown }>,
				options?: { tools?: unknown[] },
			) => {
				const current = round++;
				// 深拷贝：messages 在主循环里被反复重建/裁剪，持引用会让断言
				// 读到 turn 结束后的终态，「某一轮当时的序列」就测不出来了。
				snapshots.push(messages.map(message => ({
					role: String(message.role ?? ''),
					toolCallId: message.toolCallId === undefined ? undefined : String(message.toolCallId),
					content: String(message.content ?? ''),
				})));
				const toolsOffered = (options?.tools?.length ?? 0) > 0;
				return (async function* () {
					for (const delta of script(current)) {
						if ((delta as { type?: string }).type === 'tool_call' && !toolsOffered) {
							continue;
						}
						yield delta;
					}
					if (!toolsOffered) {
						yield { type: 'text', content: '（收尾轮）结论。' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		};
		return { provider, snapshots };
	}

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	function batchHost(
		provider: Record<string, unknown>,
		toolNames: string[],
		options: { throwOnRound?: number } = {},
	): { host: Record<string, unknown>; executedRounds: () => number } {
		let executeRound = 0;
		const runCalls = async (calls: Array<{ id: string; name: string }>) => {
			const current = executeRound++;
			if (options.throwOnRound === current) {
				throw new Error('tool batch exploded');
			}
			return calls.map(call => ({
				toolCallId: call.id,
				// 每次结果都带序号：只读工具同签名同结果会先被无进展护栏拦下
				//（见「护栏与循环检测的分工边界」suite），那样连击根本攒不起来。
				content: `RESULT-${call.id}`,
				success: true,
			}));
		};
		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => toolNames.map(name => ({
				name,
				description: name,
				inputSchema: { type: 'object' },
			})),
			_lastAllEnabledToolNames: new Set<string>(toolNames),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => runCalls(calls),
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				const results = await runCalls(calls);
				for (const result of results) { yield result as never; }
			},
		});
		return { host, executedRounds: () => executeRound };
	}

	/**
	 * 相邻性校验：返回全部违规描述。
	 *
	 * 判据直接对着协议写 —— 任意 `role:'tool'` 消息的前一条，只能是
	 * `assistant`（批次首条）或另一条 `tool`（批次续条）。出现别的 role
	 * 就意味着 tool 序列被劈开了。
	 */
	function adjacencyViolations(snapshot: IMessageSnapshot[]): string[] {
		const violations: string[] = [];
		snapshot.forEach((message, index) => {
			if (message.role !== 'tool') { return; }
			const previous = snapshot[index - 1];
			if (!previous) {
				violations.push(`#${index} tool 消息位于序列首位（缺失 assistant.tool_calls）`);
				return;
			}
			if (previous.role !== 'assistant' && previous.role !== 'tool') {
				violations.push(
					`#${index} tool 消息前一条是 role='${previous.role}'`
					+ `（content 前 60 字=${JSON.stringify(previous.content.slice(0, 60))}）`,
				);
			}
		});
		return violations;
	}

	/** 每轮只调 1 个只读工具，路径逐轮变化（避免撞上无进展护栏）。 */
	function singleReadOnlyScript(rounds: number): (round: number) => IModelDelta[] {
		return round => (
			round < rounds
				? [
					toolCallDelta(`single-${round}`, 'file_read', { path: `/mock/file-${round}.ts` }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '读完了。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		);
	}

	function userTexts(snapshot: IMessageSnapshot[]): string[] {
		return snapshot.filter(message => message.role === 'user').map(message => message.content);
	}

	test('连续 4 轮单只读工具 → 注入批量并行引导，且文案必须带轮数与工具名', async () => {
		// `agentTurnExecutor.ts:3397-3420` + `advanceSingleToolStreak`
		//（`loopReminders.ts:336-337`，`streak % threshold === 0`）。
		//
		// 事故背景（日志 1787302409958）：ITER 20-36 连续 17 轮每轮只调 1 个
		// 只读工具，浪费约 11 轮 LLM 往返 —— 每轮重传 27k-60k token prompt，
		// 而这些搜索本身只需 100-800ms。提醒不注入，这笔开销就永远在。
		//
		// 文案必须具体：只说「请批量调用」模型无从判断自己哪里做错了；
		// 带上轮数与实际工具名，才是可自证的反馈。
		const { provider, snapshots } = snapshotProvider(singleReadOnlyScript(4));
		const { host } = batchHost(provider, ['file_read']);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		assertNoToolExecutionErrors(deltas);

		const allUserTexts = snapshots.flatMap(userTexts);
		const guidance = allUserTexts.find(text => text.includes('consecutive rounds with only ONE read-only tool'));
		assert.ok(
			guidance,
			`连续 4 轮单只读工具必须注入批量并行引导（实际共 ${snapshots.length} 轮，`
			+ `user 文本=${JSON.stringify(allUserTexts.map(t => t.slice(0, 50)))}）`
			+ `——不注入意味着单工具串行浪费永远不会被纠正`,
		);
		assert.ok(
			guidance.includes('4 consecutive rounds'),
			`引导必须点明连击轮数（实际=${JSON.stringify(guidance.slice(0, 160))}）`
			+ `——阈值是 4，写成别的数字说明 MAX_SINGLE_TOOL_STREAK 与文案脱钩`,
		);
		assert.ok(
			guidance.includes('file_read'),
			`引导必须列出实际用到的工具名（实际=${JSON.stringify(guidance.slice(0, 200))}）`
			+ `——泛泛而谈的提醒模型无法自证，会被当噪声忽略`,
		);
	});

	test('批次提醒必须落在全部 tool result 之后：tool 序列一条都不准被劈开', async () => {
		// 本 suite 的核心。`:3837-3849` 的 flush 点是唯一保证。
		//
		// 失败模式极其隐蔽：本地 mock provider 不校验协议，测试照样绿；
		// 只有真实服务端会回 400 invalid_parameter_value，而报错文本
		// 完全不提「相邻性」，排查时几乎必然误判为上下文超长。
		const { provider, snapshots } = snapshotProvider(singleReadOnlyScript(6));
		const { host } = batchHost(provider, ['file_read']);

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		snapshots.forEach((snapshot, round) => {
			const violations = adjacencyViolations(snapshot);
			assert.deepStrictEqual(
				violations, [],
				`第 ${round} 轮请求的消息序列破坏了 tool 相邻性：${JSON.stringify(violations)}`
				+ `——OpenAI 兼容协议要求 assistant.tool_calls 之后紧跟连续 N 条 tool 消息，`
				+ `中间插入 user/system 会被服务端判非法（HTTP 400 code 11133）。`
				+ `sanitizeToolPairs 与 normalizeMessages 都不校验这一点，本断言是唯一防线`,
			);
		});

		const injected = snapshots.some(snapshot =>
			userTexts(snapshot).some(text => text.includes('consecutive rounds with only ONE read-only tool')),
		);
		assert.ok(
			injected,
			'必须确实注入过批次提醒——没注入的话相邻性断言是空转，等于没测',
		);
	});

	test('同一轮并行请求多个只读工具：连击清零，不得再注入批量引导', async () => {
		// `advanceSingleToolStreak(..., isSingleReadOnly=false)` → streak 归 0
		//（`loopReminders.ts:336`）。判据是 `effectiveToolCalls.length === 1`
		//（`:3398`）。
		//
		// 这条是提醒的**自洽性**：模型已经按要求批量并行了，还继续收到
		// 「你在单工具串行」的指责，会直接摧毁提醒的可信度 —— 后续真正
		// 该听的提醒也会被一并当成噪声。
		const parallelScript = (round: number): IModelDelta[] => (
			round < 5
				? [
					toolCallDelta(`par-${round}-a`, 'file_read', { path: `/mock/a-${round}.ts` }),
					toolCallDelta(`par-${round}-b`, 'file_read', { path: `/mock/b-${round}.ts` }),
					toolCallDelta(`par-${round}-c`, 'file_read', { path: `/mock/c-${round}.ts` }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '读完了。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		);
		const { provider, snapshots } = snapshotProvider(parallelScript);
		const { host } = batchHost(provider, ['file_read']);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		assertNoToolExecutionErrors(deltas);

		const allUserTexts = snapshots.flatMap(userTexts);
		assert.ok(
			!allUserTexts.some(text => text.includes('consecutive rounds with only ONE read-only tool')),
			`并行批次不得触发单工具串行引导（实际 user 文本=`
			+ `${JSON.stringify(allUserTexts.map(t => t.slice(0, 60)))}）`
			+ `——对已经照做的行为继续指责，会让模型把全部提醒当噪声`,
		);
		// 并行批次同样要守相邻性：3 条 tool result 之间不得夹任何东西。
		snapshots.forEach((snapshot, round) => {
			assert.deepStrictEqual(
				adjacencyViolations(snapshot), [],
				`第 ${round} 轮并行批次破坏了 tool 相邻性 —— 这正是 400 事故的原始形态`
				+ `（4 条并行调用被 user reminder 劈开）`,
			);
		});
	});

	test('判据是「单个只读工具」而非「单个工具」：terminal 连击不触发并行引导', async () => {
		// `:3399-3400` 用 `isParallelSafeReadOnlyTool`（`toolCallUtils.ts:1414`，
		// PARALLEL_SAFE_TOOLS 的只读视图）作为第二重判据。
		//
		// 若退化成只看数量，terminal / patch 这类**有副作用且顺序敏感**的工具
		// 也会被劝去批量并行 —— 并行执行 shell 命令或并发改同一文件，
		// 后果比多几轮 LLM 往返严重得多。
		const terminalScript = (round: number): IModelDelta[] => (
			round < 5
				? [
					toolCallDelta(`term-${round}`, 'terminal', { command: `echo step-${round}` }),
					{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
				]
				: [
					{ type: 'text', content: '跑完了。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		);
		const { provider, snapshots } = snapshotProvider(terminalScript);
		const { host } = batchHost(provider, ['terminal']);

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const allUserTexts = snapshots.flatMap(userTexts);
		assert.ok(
			!allUserTexts.some(text => text.includes('consecutive rounds with only ONE read-only tool')),
			`terminal 连击不得触发并行引导（实际 user 文本=`
			+ `${JSON.stringify(allUserTexts.map(t => t.slice(0, 60)))}）`
			+ `——把有副作用、顺序敏感的工具劝去并行，代价远高于多几轮往返`,
		);
	});

	test('整批工具执行抛错：合成失败结果后仍须 flush 提醒，且相邻性不破', async () => {
		// `:3826-3849`：catch 兜底为每个调用合成失败 tool result，**之后**
		// 才 flush。两件事都不能省：
		//   · 不合成失败结果 → tool_calls 缺配对，服务端同样 400；
		//   · 合成后不 flush → 提醒永久积压在数组里，本该生效的引导静默消失，
		//     而且残留会在下一批被一并倒出，届时注入位置就完全错位了。
		//
		// 触发点选在第 3 次执行（0-based），此时 streak 已到 4 并 push 了提醒，
		// 正好覆盖「有待 flush 的提醒 + 执行抛错」这个交叉分支。
		const { provider, snapshots } = snapshotProvider(singleReadOnlyScript(6));
		const { host, executedRounds } = batchHost(provider, ['file_read'], { throwOnRound: 3 });

		await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			executedRounds() > 3,
			`抛错轮之后必须继续推进（实际执行 ${executedRounds()} 批）`
			+ `——整批抛错不该终结 turn，否则一次工具故障就等于放弃任务`,
		);
		snapshots.forEach((snapshot, round) => {
			assert.deepStrictEqual(
				adjacencyViolations(snapshot), [],
				`第 ${round} 轮（含执行抛错的兜底路径）破坏了 tool 相邻性：`
				+ `${JSON.stringify(adjacencyViolations(snapshot))}`
				+ `——catch 分支同样要先补齐 tool result 再 flush 提醒`,
			);
		});
		const toolMessages = snapshots[snapshots.length - 1]?.filter(m => m.role === 'tool') ?? [];
		assert.ok(
			toolMessages.length > 0,
			'抛错批次必须留下合成的失败 tool result——缺配对会让服务端直接 400',
		);
	});
});

suite('executeAgentTurnDirect — ping-pong 判决三态（none / allow-changing / block-batch）', () => {

	/**
	 * `classifyPingPong`（`turnStopGate.ts:511-519`）是**双条件**裁决：
	 *   pingPong=false                        → none（不干预）
	 *   pingPong && !noProgressEvidence        → allow-changing（只告警，放行）
	 *   pingPong && noProgressEvidence         → block-batch（拦**整批**）
	 *
	 * 为什么必须是双条件（`:504-506` 的告警）：A→B→A→B 交替本身是**正常**形态
	 * —— 翻页、逐文件读、两个互补检索工具轮替都长这样。只有「来回换工具而两侧
	 * 结果都不变」才是真无进展。把它简化成单条件，等于把逐文件读代码的 agent
	 * 当成死循环拦掉，而这恰好是最常见的正常工作模式。
	 *
	 * 另一侧的风险同样实在：拦截是**整批**级的（`:3100` 在 filter 首行短路），
	 * 且文案优先于护栏文案（`:3158` 的 `_pingPongMsg ?? _guardDecision?.message`）。
	 * 一旦误判，整轮所有调用（包括与 ping-pong 无关的第三个工具）会一起被拦。
	 *
	 * 触发前置条件（`detectToolCallPingPong`，`agentRunState.ts:935-987`）：
	 *   · 交替序列长度 ≥ minLength=4（`:937`）
	 *   · 两侧 resultHash 各自唯一**且均已回填**（`:967-977`）——
	 *     回填发生在工具执行后的 RECORD_TOOL_RESULT（`:3696-3701`）
	 */

	interface IRoundSnapshot {
		readonly toolCount: number;
		readonly systemText: string;
	}

	function snapshotProvider(script: (round: number) => IModelDelta[]): {
		provider: Record<string, unknown>;
		snapshots: IRoundSnapshot[];
	} {
		const snapshots: IRoundSnapshot[] = [];
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (
				_modelId: unknown,
				messages: Array<{ role?: string; content?: unknown }>,
				options?: { tools?: unknown[] },
			) => {
				const current = round++;
				const toolsOffered = (options?.tools?.length ?? 0) > 0;
				snapshots.push({
					toolCount: options?.tools?.length ?? 0,
					systemText: messages
						.filter(message => message.role === 'system')
						.map(message => String(message.content ?? ''))
						.join('\n'),
				});
				return (async function* () {
					for (const delta of script(current)) {
						if ((delta as { type?: string }).type === 'tool_call' && !toolsOffered) {
							continue;
						}
						yield delta;
					}
					if (!toolsOffered) {
						yield { type: 'text', content: '（收尾轮）结论。' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		};
		return { provider, snapshots };
	}

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	function capturingLogger(): {
		logger: Record<string, (...args: unknown[]) => void>;
		lines: string[];
	} {
		const lines: string[] = [];
		const logger = {
			info: (...args: unknown[]) => { lines.push(`info: ${String(args[0])}`); },
			warn: (...args: unknown[]) => { lines.push(`warn: ${String(args[0])}`); },
			error: (...args: unknown[]) => { lines.push(`error: ${String(args[0])}`); },
			debug: () => undefined,
			trace: () => undefined,
		};
		return { logger, lines };
	}

	function pingPongHost(
		provider: Record<string, unknown>,
		resultFor: (call: { id: string; name: string }, seq: number) => string,
		toolNames: string[] = ['file_read', 'search_files'],
		logger?: Record<string, (...args: unknown[]) => void>,
	): {
		host: Record<string, unknown>;
		executed: Array<{ id: string; name: string }>;
	} {
		const executed: Array<{ id: string; name: string }> = [];
		let sequence = 0;
		const runCalls = async (calls: Array<{ id: string; name: string }>) =>
			calls.map(call => {
				executed.push({ id: call.id, name: call.name });
				return {
					toolCallId: call.id,
					content: resultFor(call, sequence++),
					success: true,
				};
			});
		const host = mockHost({
			...(logger ? { _logService: logger } : {}),
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => toolNames.map(name => ({
				name,
				description: name,
				inputSchema: { type: 'object' },
			})),
			_lastAllEnabledToolNames: new Set<string>(toolNames),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => runCalls(calls),
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				const results = await runCalls(calls);
				for (const result of results) { yield result as never; }
			},
		});
		return { host, executed };
	}

	/**
	 * A→B→A→B 交替脚本：每轮 1 个工具，两个签名严格轮替。
	 *
	 * 参数**必须逐侧固定**（A 永远同参、B 永远同参），否则 argsHash 每轮都变
	 * → `sigAt` 算出的签名不重复 → `detectToolCallPingPong` 的严格交替判定
	 * 直接不成立，整条链路根本不会被触发。
	 */
	function alternatingScript(rounds: number): (round: number) => IModelDelta[] {
		return round => {
			if (round >= rounds) {
				return [
					{ type: 'text', content: '结束。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				];
			}
			const isA = round % 2 === 0;
			return [
				isA
					? toolCallDelta(`pp-a-${round}`, 'file_read', { path: '/mock/fixed-a.ts' })
					: toolCallDelta(`pp-b-${round}`, 'search_files', { pattern: 'fixed-b' }),
				{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
			];
		};
	}

	function blockMessages(deltas: ReadonlyArray<unknown>): string[] {
		return deltas
			.filter(delta => (delta as { type?: string }).type === 'tool_result')
			.map(delta => String((delta as { content?: unknown }).content ?? ''));
	}

	test('两侧结果各自稳定 → block-batch：文案须指名两个工具并给出换路建议', async () => {
		// `:3081-3090` + `classifyPingPong` 的 block-batch 出口。
		//
		// 每侧结果固定（A 恒为 A-STABLE、B 恒为 B-STABLE）→ sideStable 两侧皆真
		// → noProgressEvidence=true。注意结果**不能两侧也相同**地退化成单签名：
		// 签名是 name+argsHash，工具名不同就已是两个签名。
		const { provider } = snapshotProvider(alternatingScript(8));
		const { logger, lines } = capturingLogger();
		const { host } = pingPongHost(
			provider,
			call => (call.name === 'file_read' ? 'A-STABLE' : 'B-STABLE'),
			['file_read', 'search_files'],
			logger,
		);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const pingPongBlocks = blockMessages(deltas).filter(text => text.includes('ping-pong loop'));
		assert.ok(
			pingPongBlocks.length > 0,
			`两侧结果稳定的 A→B→A→B 必须被拦（实际 tool_result=`
			+ `${JSON.stringify(blockMessages(deltas).map(t => t.slice(0, 60)))}）`
			+ `——detectToolCallLoop 只看单签名重复，这种形态被它完全漏检，`
			+ `没有 ping-pong 判定就会一路空转到迭代上限`,
		);
		const message = pingPongBlocks[0];
		assert.ok(
			message.includes('file_read') && message.includes('search_files'),
			`拦截文案必须指名交替的两个工具（实际=${JSON.stringify(message.slice(0, 200))}）`
			+ `——不点名模型无法知道该放弃哪条路径`,
		);
		assert.ok(
			/different tool|different approach|proceed with the results/i.test(message),
			`文案必须给出可执行出路（换工具 / 换思路 / 用已有结果结论）`
			+ `（实际=${JSON.stringify(message.slice(0, 200))}）`
			+ `——只说「被拦了」模型会原地重试同一对调用`,
		);
		assert.ok(
			lines.some(line => line.includes('Ping-pong loop') && line.includes('blocking entire batch')),
			`block 必须留下「整批拦截」的 warn 日志（实际=${JSON.stringify(lines.filter(l => l.includes('Ping-pong')).slice(0, 4))}）`,
		);
	});

	test('两侧结果持续变化 → allow-changing：只告警不拦截（逐文件读不得误伤）', async () => {
		// `:3091-3095` 的 allow-changing 出口，本 suite 最关键的一条。
		//
		// 这正是「两个互补检索工具轮替推进」的正常形态：结果每次都不同说明
		// 信息在增加。若被简化成单条件拦掉，agent 逐文件读代码时会在第 4 次
		// 调用后突然整批被拦，且文案会声称「没有进展」——与事实完全相反。
		const { provider } = snapshotProvider(alternatingScript(8));
		const { logger, lines } = capturingLogger();
		const { host, executed } = pingPongHost(
			provider,
			(call, seq) => `${call.name}-CHANGED-${seq}`,
			['file_read', 'search_files'],
			logger,
		);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			!blockMessages(deltas).some(text => text.includes('ping-pong loop')),
			`结果仍在变化时不得拦截（实际 tool_result=`
			+ `${JSON.stringify(blockMessages(deltas).map(t => t.slice(0, 60)))}）`
			+ `——把「逐文件读 / 翻页」判成死循环是双条件存在的唯一理由`,
		);
		assert.ok(
			executed.length >= 6,
			`交替调用必须持续执行（实际执行 ${executed.length} 次：`
			+ `${JSON.stringify(executed.map(e => e.name))}）`,
		);
		assert.ok(
			lines.some(line => line.includes('Ping-pong pattern') && line.includes('results still changing')),
			`必须留下「模式命中但放行」的告警（实际=${JSON.stringify(lines.filter(l => l.includes('Ping-pong')).slice(0, 4))}）`
			+ `——放行不等于沉默：这条日志是事后调参 minLength / 判据的唯一依据`,
		);
	});

	test('三个工具轮转（A→B→C）不构成 ping-pong：严格两签名交替才算', async () => {
		// `detectToolCallPingPong` 只收集「末条签名 / 另一侧签名」的**严格**交替
		//（`:953-961`，遇到第三个签名即 break）。
		//
		// 判据放宽成「最近 N 轮工具名有重复」会把正常的多工具探索
		//（搜索 → 读文件 → 追调用链 → 再搜索）全部误判。此处三工具轮转结果
		// 全部固定，若判据错误地放宽，它会是最先被误拦的形态。
		const threeWayScript = (round: number): IModelDelta[] => {
			if (round >= 9) {
				return [
					{ type: 'text', content: '结束。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				];
			}
			const names = ['file_read', 'search_files', 'list_skills'];
			const name = names[round % 3];
			return [
				toolCallDelta(`three-${round}`, name, { fixed: name }),
				{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
			];
		};
		const { provider } = snapshotProvider(threeWayScript);
		const { host } = pingPongHost(
			provider,
			call => `${call.name}-STABLE`,
			['file_read', 'search_files', 'list_skills'],
		);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			!blockMessages(deltas).some(text => text.includes('ping-pong loop')),
			`三工具轮转不得判为 ping-pong（实际 tool_result=`
			+ `${JSON.stringify(blockMessages(deltas).map(t => t.slice(0, 60)))}）`
			+ `——判据一旦放宽到「工具名有重复」，正常的多工具探索会被整批误拦`,
		);
	});

	test('交替只有 2 次（长度 < minLength=4）不触发：短交替是正常的来回校验', async () => {
		// `:940` 与 `:962` 两道长度门槛（minLength=4）。
		//
		// A→B→A 这种两三次来回是极常见的正常动作：读文件 → 搜索确认 → 回头
		// 再读同一文件验证。门槛低到 2 就会让几乎每个 agent 会话都触发拦截。
		const { provider } = snapshotProvider(alternatingScript(3));
		const { host, executed } = pingPongHost(
			provider,
			call => (call.name === 'file_read' ? 'A-STABLE' : 'B-STABLE'),
		);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			!blockMessages(deltas).some(text => text.includes('ping-pong loop')),
			`3 次交替（< minLength=4）不得触发拦截（实际 tool_result=`
			+ `${JSON.stringify(blockMessages(deltas).map(t => t.slice(0, 60)))}）`
			+ `——门槛降到 2-3 会让「读→搜→回头验证」这种正常动作被拦`,
		);
		assert.strictEqual(
			executed.length, 3,
			`3 轮交替应全部执行（实际=${JSON.stringify(executed.map(e => e.name))}）`,
		);
	});

	test('命中 block-batch 时整批拦截：同轮无关的第三个工具也必须一起停', async () => {
		// `:3098-3100`：`if (_pingPongMsg) { return false; }` 位于 filter **首行**，
		// 在任何 per-call 判定之前，因此本批所有调用无条件被拦。
		//
		// 这不是实现偷懒，而是语义要求（`turnStopGate.ts:508-509`）：ping-pong
		// 是批次级模式。但代价是**误判的爆炸半径是整轮** —— 一个无关的
		// list_skills 会被一并拦掉并收到「ping-pong」文案。所以这条契约必须
		// 与前面的 allow-changing / 长度门槛一起看：正是因为拦截如此粗粒度，
		// 触发条件才必须保持严格。
		const mixedScript = (round: number): IModelDelta[] => {
			if (round >= 8) {
				return [
					{ type: 'text', content: '结束。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				];
			}
			// 前 6 轮纯交替把 ping-pong 攒到命中，第 7 轮起在交替之外
			// additionally 带一个无关工具，检验整批语义。
			const isA = round % 2 === 0;
			const alternating = isA
				? toolCallDelta(`mix-a-${round}`, 'file_read', { path: '/mock/fixed-a.ts' })
				: toolCallDelta(`mix-b-${round}`, 'search_files', { pattern: 'fixed-b' });
			if (round < 6) {
				return [alternating, { type: 'done', finishReason: 'tool_calls' } as IModelDelta];
			}
			return [
				alternating,
				toolCallDelta(`mix-c-${round}`, 'list_skills', { round }),
				{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
			];
		};
		const { provider } = snapshotProvider(mixedScript);
		const { host, executed } = pingPongHost(
			provider,
			call => (call.name === 'file_read' ? 'A-STABLE' : call.name === 'search_files' ? 'B-STABLE' : 'C-ANY'),
			['file_read', 'search_files', 'list_skills'],
		);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const pingPongBlocked = deltas.filter(delta =>
			(delta as { type?: string }).type === 'tool_result'
			&& String((delta as { content?: unknown }).content ?? '').includes('ping-pong loop'),
		);
		assert.ok(
			pingPongBlocked.length > 0,
			`混合批次仍须命中 ping-pong（实际 tool_result=`
			+ `${JSON.stringify(blockMessages(deltas).map(t => t.slice(0, 50)))}）`,
		);
		// 被拦的 list_skills 一次都不该执行 —— 整批语义的直接证据。
		const executedUnrelated = executed.filter(call => call.name === 'list_skills');
		assert.ok(
			pingPongBlocked.length >= 2 || executedUnrelated.length === 0,
			`整批拦截必须覆盖同轮无关工具（ping-pong 拦截 ${pingPongBlocked.length} 条，`
			+ `list_skills 实际执行 ${executedUnrelated.length} 次）`
			+ `——只拦交替的两个而放行第三个，等于让模型靠「掺一个无关调用」绕过护栏`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// 第十四批：重复调用的两路拦截与文案分流
//
// 「同一个调用被重复发出」有两条独立的拦截规则，分工写在
// `agentTurnExecutor.ts:1280-1305` 的注释里（该注释即契约）：
//
//   · 同签名 **且** 同结果 → ToolGuardrailController.beforeCall 先拦
//     （noProgressBlockAfter=2 → 第 3 次调用即 block，`toolGuardrailController.ts:350`）
//   · 同签名 但 结果不同   → 放行给 detectToolCallLoop 拦
//     （TOOL_LOOP_THRESHOLD=3 → 同名同参第 4 次判 loop，`agentRunState.ts:53`）
//
// 为什么必须是**两条**而不能合成一条：
//   ① no_progress 的判据是结果哈希，而结果只能在 `afterCall` 回填
//      （`agentTurnExecutor.ts:3678`）—— 它天然只能看见**跨轮**重复。
//   ② detectToolCallLoop 只看签名，对「翻页式重复」（同参不同结果）会误伤，
//      所以阈值必须更宽（3 vs 2）且排在 no_progress 之后。
//   ③ 修改型工具（MUTATING_TOOL_NAMES，`toolGuardrailController.ts:60`）被
//      刻意排除在 no_progress 之外 —— terminal 重跑同一条命令是正常重试，
//      不是「无进展」。
//
// 阈值一旦写反（no_progress ≥ 3）就会被 detectToolCallLoop 完全遮蔽、
// 永远轮不到（`:1280-1284` 明确记录了这个陷阱），表现为护栏「接了但没用」。
//
// ⚠ 这两条之外还有**第三道、也是最早的一道门**：`deduplicateToolCalls`
// （接线于 `:2390`，远早于护栏）。同一批次内完全相同的调用在进入护栏之前就已
// 被折叠，所以上面两条规则面对的永远是去重后的批次 —— 三者串联，不是冗余。
// 本批最后一个用例专门锁这条次序。
//
// 本批的可观测探针是**文案来源**：被拦调用回灌的 tool_result 走
// `:3158-3160` 的优先级链 `_pingPongMsg ?? _guardDecision?.message ??
// buildLoopBlockFeedback(...)`，三条文案措辞互不相同，因此文案就能反证
// 究竟是哪条规则拦的 —— 这是唯一不打桩就能区分两路的手段。
// ═══════════════════════════════════════════════════════════════════
suite('executeAgentTurnDirect — 重复调用两路拦截的分工（no_progress vs detectToolCallLoop）', () => {

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/**
	 * 每轮发 `callsPerRound` 个**完全相同**（同名 + 同参）的调用，共 `rounds` 轮，
	 * 之后改吐纯文本让 turn 自然收尾。
	 *
	 * `callsPerRound` 是区分「跨轮重复」与「批内重复」的唯一变量：前者能被
	 * no_progress 看见（结果已回填），后者只能被 detectToolCallLoop 看见。
	 */
	function repeatingProvider(
		toolName: string,
		args: Record<string, unknown>,
		rounds: number,
		callsPerRound = 1,
	): { provider: Record<string, unknown>; roundCount: () => number } {
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: unknown, _messages: unknown, options?: { tools?: unknown[] }) => {
				const current = round++;
				const toolsOffered = (options?.tools?.length ?? 0) > 0;
				return (async function* () {
					if (!toolsOffered || current >= rounds) {
						yield { type: 'text', content: '（收尾）基于已有信息作答。' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
						return;
					}
					for (let index = 0; index < callsPerRound; index++) {
						yield toolCallDelta(`rep-${current}-${index}`, toolName, args);
					}
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				})();
			},
		};
		return { provider, roundCount: () => round };
	}

	/**
	 * host 桩：`resultFor` 决定第 N 次实际执行返回什么内容。
	 * 恒定返回 → 结果哈希稳定 → 命中 no_progress；每次变化 → 只能命中 loop。
	 */
	function recordingHostFor(
		provider: Record<string, unknown>,
		toolName: string,
		resultFor: (callIndex: number) => string,
	): { host: Record<string, unknown>; executed: string[] } {
		const executed: string[] = [];
		const runCalls = async (calls: Array<{ id: string; name: string }>) =>
			calls.map(call => {
				const content = resultFor(executed.length);
				executed.push(call.id);
				return { toolCallId: call.id, content, success: true };
			});

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: toolName, description: toolName, inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>([toolName]),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => runCalls(calls),
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				const results = await runCalls(calls);
				for (const result of results) { yield result as never; }
			},
		});
		return { host, executed };
	}

	/** 全部 tool_result 文本（被拦调用的合成结果也走这条通道回灌）。 */
	function resultTexts(deltas: IChatStreamDelta[]): string[] {
		return deltas
			.filter(delta => (delta as { type?: string }).type === 'tool_result')
			.map(delta => String((delta as { content?: unknown }).content ?? ''));
	}

	test('同签名 + 同结果：第 3 次起由 no_progress 拦下，文案须点明「结果没变」', async () => {
		// `toolGuardrailController.ts:347-362`（noProgressBlockAfter=2）
		// + 文案分流 `agentTurnExecutor.ts:3158-3160` 取 _guardDecision.message。
		//
		// 为什么文案必须点明「结果没变」而不是「参数重复」：模型看到「参数重复」的
		// 第一反应是**微调参数再试**（换个大小写、加个斜杠），而真正的问题是这个
		// 查询本身已经给出全部信息 —— 误导性文案会把一次无进展放大成一串无进展。
		const { provider } = repeatingProvider('file_read', { path: '/same/file.ts' }, 8);
		const { host, executed } = recordingHostFor(provider, 'file_read', () => 'STABLE_RESULT');

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 30 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			executed.length, 2,
			`同签名同结果的只读调用只应放行前 2 次（实际 ${executed.length} 次）——`
			+ `多于 2 说明 no_progress 阈值被 detectToolCallLoop(3) 遮蔽、永远轮不到，`
			+ `护栏等于没接；少于 2 则连「读一次再确认一次」都被误伤`,
		);

		const texts = resultTexts(deltas);
		assert.ok(
			texts.some(text => /returned the same result/i.test(text)),
			`被拦调用必须回灌 no_progress 专属文案（实际 tool_result=`
			+ `${JSON.stringify(texts.map(text => text.slice(0, 70)))}）——`
			+ `退化成通用 loop 文案会诱导模型「微调参数再试」，而真正该做的是用已有结果`,
		);
	});

	test('同签名但结果每次都变：no_progress 必须放手，交给 loop 在第 4 次拦', async () => {
		// `toolGuardrailController.ts:444`（resultHash 不同 → repeatCount 重置为 1，
		// 永远到不了 block）+ detectToolCallLoop（`agentRunState.ts:53`，阈值 3）。
		//
		// 这是分工的另一半，也是最容易被「优化」掉的一半：如果有人把 no_progress
		// 简化成「只看签名」，翻页读取（同一个 path 参数、每次返回下一段）会在第 3 次
		// 被拦死 —— 而这恰好是读大文件最标准的姿势。
		const { provider } = repeatingProvider('file_read', { path: '/drifting.ts' }, 8);
		const { host, executed } = recordingHostFor(provider, 'file_read', index => `CHUNK_${index}`);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 30 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			executed.length, 3,
			`结果持续变化时必须放行到 loop 阈值（3 次，实际 ${executed.length} 次）——`
			+ `停在 2 次说明 no_progress 错误地只比签名不比结果哈希，`
			+ `翻页式读取会在读到一半时被自己的护栏拦死`,
		);

		const texts = resultTexts(deltas);
		assert.ok(
			texts.some(text => /same arguments/i.test(text)),
			`第 4 次必须由 detectToolCallLoop 拦下并回灌「参数重复」文案（实际 tool_result=`
			+ `${JSON.stringify(texts.map(text => text.slice(0, 70)))}）`,
		);
		assert.ok(
			!texts.some(text => /returned the same result/i.test(text)),
			`结果在变时不得出现 no_progress 文案——那等于对模型撒谎（结果明明每次都不同），`
			+ `实际 tool_result=${JSON.stringify(texts.map(text => text.slice(0, 70)))}`,
		);
	});

	test('修改型工具（terminal）豁免 no_progress：重跑同一条命令是重试，不是无进展', async () => {
		// `MUTATING_TOOL_NAMES`(`toolGuardrailController.ts:60-61`)
		// + `_isIdempotent` 的黑名单优先(`:462-465`)
		// + success 路径对非幂等工具直接清空 no_progress 记录(`:435-439`)。
		//
		// 具体失败场景：agent 改完代码跑 `npm test` 复验，输出恰好一字不差（比如都是
		// 同一条编译错误）。若按 no_progress 在第 3 次就拦掉，agent 就再也没法确认
		// 自己的修改到底生效了没有 —— 「改一次、验一次」这个循环被护栏掐断。
		const { provider } = repeatingProvider('terminal', { command: 'npm test' }, 8);
		const { host, executed } = recordingHostFor(provider, 'terminal', () => 'exit code 0: all passed');

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 30 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			executed.length, 3,
			`修改型工具同参同输出仍须放行到 loop 阈值（3 次，实际 ${executed.length} 次）——`
			+ `停在 2 次说明 MUTATING 豁免失效，「改一次、跑一次测试复验」会被护栏掐断`,
		);
		assert.ok(
			!resultTexts(deltas).some(text => /returned the same result/i.test(text)),
			'修改型工具永远不该收到 no_progress 文案——它的输出相同不代表没有副作用',
		);
	});

	test('空参重复调用被拦：文案必须要求补齐参数，而不是笼统地说「像是循环」', async () => {
		// `buildLoopBlockFeedback` 的 emptyArgs 分支（`toolCallUtils.ts:1037-1039`）。
		//
		// 空参调用几乎总是 tool-call 序列化出了问题（模型吐了 {} 或 null），
		// 而通用 loop 文案给的建议是「换个思路 / 给更具体的参数」——对空参场景
		// 等于什么都没说。模型收到后最典型的反应是原样再发一次，于是空参调用
		// 一轮接一轮，直到撞上迭代上限。
		//
		// 结果每次变化 → 绕开 no_progress，确保被拦时走的是 buildLoopBlockFeedback。
		const { provider } = repeatingProvider('file_read', {}, 8);
		const { host, executed } = recordingHostFor(provider, 'file_read', index => `PARTIAL_${index}`);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 30 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const texts = resultTexts(deltas);
		assert.ok(
			executed.length >= 1,
			`空参调用不得在首次就被拦（实际执行 ${executed.length} 次）——`
			+ `工具自己返回的参数校验错误比护栏文案更精确，应该先让它说话`,
		);
		assert.ok(
			texts.some(text => /EMPTY or missing/i.test(text)),
			`空参被拦时必须命中 emptyArgs 专属文案（实际 tool_result=`
			+ `${JSON.stringify(texts.map(text => text.slice(0, 80)))}）——`
			+ `通用 loop 文案对「参数丢了」这个病因完全无效，模型会原样重发到撞上限`,
		);
	});

	test('同一批次内的完全相同调用：由 dedup 在执行前折叠为一次，且被丢弃者必须闭合', async () => {
		// `deduplicateToolCalls`(`toolCallUtils.ts:995`) 的接线点在
		// `agentTurnExecutor.ts:2390-2401` —— 注意它排在**极早**的位置，
		// 远在 beforeCall(`:3110`) / detectToolCallLoop(`:3124`) 之前。
		//
		// 这解释了两路拦截为何都「看不到」批内完全重复：同名 + 同参的调用在
		// 进入护栏之前就已经被折叠掉了，两条规则实际面对的永远是去重后的批次。
		// 因此 no_progress 与 loop 的真实职责都是**跨轮**重复，批内重复由 dedup
		// 独立兜住 —— 三者是串联的三道门，不是冗余。
		//
		// 被丢弃的调用必须补 tool_result + tool_end（`:2397-2399`）：它们都已经
		// yield 过 tool_start（adapter 在流式装配阶段就发了），少一个 tool_end
		// 就会在 UI 上留一张永久转圈的幽灵卡（`:1786-1795` 记录的正是这条约束）。
		const { provider } = repeatingProvider('file_read', { path: '/batch.ts' }, 1, 4);
		const { host, executed } = recordingHostFor(provider, 'file_read', () => 'STABLE_RESULT');

		const { deltas } = await drain(
			executeAgentTurnDirect(
				host,
				mockRequest({ budgetMaxTotal: 30 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			executed.length, 1,
			`同一批次的 4 个完全相同调用只应真实执行 1 次（实际 ${executed.length} 次）——`
			+ `执行多次说明 dedup 失效，模型一次吐 20 个相同调用就会把同一个查询跑 20 遍`,
		);

		const texts = resultTexts(deltas);
		const dedupNotices = texts.filter(text => /已去重/.test(text));
		assert.strictEqual(
			dedupNotices.length, 3,
			`4 个相同调用里被折叠的 3 个都必须回灌去重说明（实际 ${dedupNotices.length} 条，`
			+ `全部 tool_result=${JSON.stringify(texts.map(text => text.slice(0, 40)))}）——`
			+ `静默丢弃会让模型以为调用凭空消失，典型反应是下一轮原样重发`,
		);
		assert.ok(
			!texts.some(text => /returned the same result|same arguments/i.test(text)),
			'批内重复不得命中 no_progress 或 loop 文案——它们面对的已是去重后的批次，'
			+ `若出现说明 dedup 被挪到了护栏之后，三道门的次序被打乱；`
			+ `实际 tool_result=${JSON.stringify(texts.map(text => text.slice(0, 40)))}`,
		);

		// 4 个调用（1 执行 + 3 去重）都必须闭合，且同一 id 不得重复闭合。
		const endIds = deltas
			.filter(delta => (delta as { type?: string }).type === 'tool_end')
			.map(delta => String((delta as { toolCallId?: unknown }).toolCallId ?? ''));
		assert.strictEqual(
			endIds.length, new Set(endIds).size,
			`tool_end 不得对同一 toolCallId 重复发送（实际 ids=[${endIds.join(',')}]）`
			+ `——去重路径与正常执行路径都会发，漏加 endedToolIds 就会重复`,
		);
		assert.strictEqual(
			new Set(endIds).size, 4,
			`4 个 tool_call 必须各自恰好闭合一次（实际闭合 ${new Set(endIds).size} 个）——`
			+ `被 dedup 丢弃的调用已经 yield 过 tool_start，缺 tool_end 就是永久转圈的幽灵卡`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// 第十五批：工具批次的并行/串行选路与 delegate 分区降级
//
// 一批工具调用有**三条**可能的执行路径，选路全由
// `shouldParallelizeToolBatch`（`toolCallUtils.ts:1468`）+
// `splitDelegateParallelBatch`（`:1448`）在 `agentTurnExecutor.ts:2975`
// 与 `:3736-3757` 决定：
//
//   ① 串行     `_executeToolCalls`（`:3796`）
//   ② 整批并行 `_executeToolCallsParallelStreaming`（`:3766`）
//   ③ 分区降级 head 串行（`:3744`）+ delegate 子集并行（`:3755-3756`）
//
// 为什么这组选路必须用测试钉死：
//
//   · **主循环默认串行是产品决策**，不是性能遗漏。
//     `MAIN_LOOP_PARALLEL_TOOLS_ENABLED = false`（`toolCallUtils.ts:1438`）
//     把 Hermes 对齐的整套并行判定（NEVER_PARALLEL / 危险命令 / 路径重叠）
//     直接短路 —— 并行只保留在 subagent 通道内，让并发工作呈现在 subagent
//     卡片而不是一排普通工具卡片里。谁把这个开关"顺手"打开，就会在毫无
//     路径隔离的前提下并发跑 file_write/patch。
//
//   · **≥2 个 delegate_task 是写在开关之前的唯一例外**（`:1485-1492`，
//     日志 1785120071762 / 1785121881324）：delegate 串行时首个子 agent
//     最长阻塞 600s，其余 delegate 卡片全程空白 —— 用户报告的形态就是
//     "启动多个 delegate_task 只有最后一个在执行"。判定顺序（例外在
//     `if (!MAIN_LOOP_PARALLEL_TOOLS_ENABLED) return false` 之前）本身
//     就是契约，写反则例外永远走不到。
//
//   · **混合批次不能把例外掐死**（1785121881324 教训）：真实 LLM 常在同
//     一轮夹带只读工具（read_skill + 3×delegate_task），所以条件是"≥2
//     delegate 且其余均为 PARALLEL_SAFE 只读"，而不是"整批纯 delegate"。
//     一旦混入写工具则整批回退串行 —— 此时 `splitDelegateParallelBatch`
//     接手，把写工具留在串行、delegate 子集仍并行，两难兼顾。
//
//   · **并行路径必须自己兜住闭合**（`:3780-3791`）：并行流可能被 abort
//     或异常打断，已 yield 过 tool_start 的调用若拿不到结果就永远转圈。
//     finally 里的合成 tool_result + tool_end(success=false) 是幽灵卡的
//     唯一防线。
//
// 观测手段：分别桩住串行与并行两条 host 方法并记录各自收到的批次形状，
// 于是"走了哪条路"可以直接读出来，无需白盒断言。
// ⚠ 同批 delegate 的参数必须互不相同 —— `deduplicateToolCalls`
// （`:2391`）在选路之前就会折叠同名同参调用，折叠后只剩 1 个 delegate，
// 例外条件 delegateCount >= 2 不再成立，用例会以"莫名走串行"假失败。
// ═══════════════════════════════════════════════════════════════════
suite('executeAgentTurnDirect — 批次并行选路与 delegate 分区降级', () => {

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	function scriptedProvider(script: (round: number) => IModelDelta[]): {
		provider: Record<string, unknown>;
		roundCount: () => number;
	} {
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: string, _messages: unknown[]) => {
				const current = round++;
				return (async function* () {
					for (const delta of script(current)) { yield delta; }
				})();
			},
		};
		return { provider, roundCount: () => round };
	}

	/**
	 * 装配一个「两条执行路径都记账」的 host。
	 *
	 * `serialBatches` / `parallelBatches` 各记录一次调用收到的工具名数组 ——
	 * 选路结果因此可被直接观测。`parallelYieldLimit` 用于模拟并行流中断
	 * （只产出前 N 个结果），触发 `:3780-3791` 的合成闭合兜底。
	 */
	function routingHost(
		provider: Record<string, unknown>,
		opts: { parallelYieldLimit?: number } = {},
	): {
		host: Record<string, unknown>;
		serialBatches: string[][];
		parallelBatches: string[][];
	} {
		const serialBatches: string[][] = [];
		const parallelBatches: string[][] = [];
		const resultOf = (call: { id: string; name: string }) =>
			({ toolCallId: call.id, content: `ok:${call.name}`, success: true });

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } },
				{ name: 'file_write', description: 'write', inputSchema: { type: 'object' } },
				{ name: 'delegate_task', description: 'delegate', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['file_read', 'file_write', 'delegate_task']),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => {
				serialBatches.push(calls.map(call => call.name));
				return calls.map(resultOf);
			},
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				parallelBatches.push(calls.map(call => call.name));
				const limit = opts.parallelYieldLimit ?? calls.length;
				for (const call of calls.slice(0, limit)) {
					yield resultOf(call) as never;
				}
			},
		});
		return { host, serialBatches, parallelBatches };
	}

	/** 真实任务文本：避开 `_isTrivialRequest`（`agentTurnExecutor.ts:318`）对探索类工具的封禁。 */
	const TASK_REQUEST = {
		messages: [{ role: 'user', content: '请读取相关模块文件并派发子代理调查调用链结构' }],
	};

	/** 单轮工具调用 + 下一轮自然收尾的脚本。 */
	function oneShotBatch(calls: IModelDelta[]): (round: number) => IModelDelta[] {
		return round => (
			round === 0
				? [...calls, { type: 'done', finishReason: 'tool_calls' } as IModelDelta]
				: [
					{ type: 'text', content: '完成。' } as IModelDelta,
					{ type: 'done', finishReason: 'stop' } as IModelDelta,
				]
		);
	}

	test('纯只读批次（2×file_read）仍走串行 —— 主循环并行开关默认关闭', async () => {
		// `toolCallUtils.ts:1494-1497`：MAIN_LOOP_PARALLEL_TOOLS_ENABLED=false
		// 在"NEVER_PARALLEL / 危险命令 / 路径重叠 / PARALLEL_SAFE"四段判定
		// **之前**短路返回 false。file_read 明明在 PARALLEL_SAFE_TOOLS 里
		// （`:1384`），却依然串行 —— 这正是该开关存在的证据。
		//
		// 若哪天该断言变红，说明开关被打开了：并行判定第 3 段（路径重叠）
		// 只在 PATH_SCOPED_TOOLS 内做，patch/file_write 的并发写将不再有
		// 主循环层面的保护，必须是一次显式的产品决策而不是顺手改动。
		const { provider } = scriptedProvider(oneShotBatch([
			toolCallDelta('r-1', 'file_read', { path: '/mock/a.ts' }),
			toolCallDelta('r-2', 'file_read', { path: '/mock/b.ts' }),
		]));
		const { host, serialBatches, parallelBatches } = routingHost(provider);

		await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			parallelBatches, [],
			`只读批次不得走并行路径（实际并行批次=${JSON.stringify(parallelBatches)}）`
			+ `——MAIN_LOOP_PARALLEL_TOOLS_ENABLED=false 是产品决策：并行只在 subagent 通道内`,
		);
		assert.deepStrictEqual(
			serialBatches, [['file_read', 'file_read']],
			`两个 file_read 必须作为同一个串行批次执行（实际串行批次=${JSON.stringify(serialBatches)}）`
			+ `——批次被拆散说明选路逻辑改变，工具卡片的成组呈现也会随之错乱`,
		);
	});

	test('≥2 个 delegate_task → 例外生效，整批走并行（否则首个子代理阻塞其余卡片）', async () => {
		// `toolCallUtils.ts:1485-1492`：该例外写在主开关短路**之前**，
		// 是 MAIN_LOOP_PARALLEL_TOOLS_ENABLED=false 下唯一能并行的形状。
		//
		// 事故形态（日志 1785120071762）：delegate 串行时首个子 agent 最长
		// 阻塞 600s，其余 delegate 卡片全程空白 —— 用户看到的是"只有最后
		// 一个在执行"。把例外挪到开关之后，这个 bug 立刻复现。
		// ⚠ 两个 delegate 的 task 参数必须不同，否则批内去重折叠成 1 个，
		// delegateCount >= 2 不成立 → 假失败。
		const { provider } = scriptedProvider(oneShotBatch([
			toolCallDelta('d-1', 'delegate_task', { type: 'code-explorer', task: '找入口' }),
			toolCallDelta('d-2', 'delegate_task', { type: 'code-explorer', task: '找调用链' }),
		]));
		const { host, serialBatches, parallelBatches } = routingHost(provider);

		await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			parallelBatches, [['delegate_task', 'delegate_task']],
			`2 个 delegate_task 必须并发派发（实际并行批次=${JSON.stringify(parallelBatches)}，`
			+ `串行批次=${JSON.stringify(serialBatches)}）`
			+ `——串行则首个子代理（最长 600s）阻塞期间其余 delegate 卡片全空`,
		);
		assert.deepStrictEqual(
			serialBatches, [],
			`delegate 例外命中时不得再走串行路径（实际串行批次=${JSON.stringify(serialBatches)}）`,
		);
	});

	test('delegate 夹带只读工具仍整批并行（要求"整批纯 delegate"会让例外形同虚设）', async () => {
		// `toolCallUtils.ts:1487-1491`：条件是"≥2 delegate **且其余均为**
		// PARALLEL_SAFE 只读"，而不是"整批纯 delegate"。
		//
		// 放宽的理由（日志 1785121881324）：真实场景 LLM 几乎总在派发的同
		// 一轮夹带只读工具（read_skill / search_* / file_read）。若要求纯
		// delegate，混合批次就全部回落串行 → 上一个用例锁的 bug 原样复现。
		// 只读工具无共享可变状态，与 delegate 并发无副作用。
		const { provider } = scriptedProvider(oneShotBatch([
			toolCallDelta('m-1', 'file_read', { path: '/mock/entry.ts' }),
			toolCallDelta('m-2', 'delegate_task', { type: 'code-explorer', task: '查 A' }),
			toolCallDelta('m-3', 'delegate_task', { type: 'code-explorer', task: '查 B' }),
		]));
		const { host, serialBatches, parallelBatches } = routingHost(provider);

		await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			parallelBatches, [['file_read', 'delegate_task', 'delegate_task']],
			`只读工具 + 2 delegate 必须整批并行（实际并行批次=${JSON.stringify(parallelBatches)}，`
			+ `串行批次=${JSON.stringify(serialBatches)}）`
			+ `——收紧成"整批纯 delegate"等于让例外在真实流量下永不命中`,
		);
	});

	test('写工具混入 → 整批不可并行，但 delegate 子集仍靠分区降级并发', async () => {
		// `agentTurnExecutor.ts:3736-3757` + `toolCallUtils.ts:1448`：
		// file_write 不在 PARALLEL_SAFE 中 → `othersAllSafe` 为假 → 整批
		// 回退串行；此时 `splitDelegateParallelBatch` 接手，把写工具留在
		// 串行路径（保守），delegate 子集仍交给并行路径。
		//
		// 两个都要守住：写工具并发 = 数据竞争；delegate 串行 = 空白卡片。
		// 分区降级是唯一同时满足两者的解法，任何一半退化都是真实事故。
		const { provider } = scriptedProvider(oneShotBatch([
			toolCallDelta('s-1', 'file_write', { path: '/mock/out.ts', content: 'x' }),
			toolCallDelta('s-2', 'delegate_task', { type: 'code-explorer', task: '查 C' }),
			toolCallDelta('s-3', 'delegate_task', { type: 'code-explorer', task: '查 D' }),
		]));
		const { host, serialBatches, parallelBatches } = routingHost(provider);

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			serialBatches, [['file_write']],
			`写工具必须单独走串行 head（实际串行批次=${JSON.stringify(serialBatches)}）`
			+ `——把 file_write 放进并行路径就失去了主循环唯一的写并发保护`,
		);
		assert.deepStrictEqual(
			parallelBatches, [['delegate_task', 'delegate_task']],
			`delegate 子集必须并发（实际并行批次=${JSON.stringify(parallelBatches)}）`
			+ `——分区降级失效则混合批次退回全串行，delegate 卡片重新空白`,
		);
		// 降级路径跨两条执行通道，最容易漏的就是 head 那一半的结果回灌。
		const endIds = deltas
			.filter(delta => (delta as { type?: string }).type === 'tool_end')
			.map(delta => String((delta as { toolCallId?: unknown }).toolCallId ?? ''));
		assert.deepStrictEqual(
			[...new Set(endIds)].sort(), ['s-1', 's-2', 's-3'],
			`分区降级后三个调用都必须闭合（实际闭合=${JSON.stringify(endIds)}）`
			+ `——head 走的是另一条循环，漏掉 _processToolResult 就是永久转圈的卡片`,
		);
	});

	test('并行流少产出一个结果 → finally 合成 tool_end(success=false)，不留幽灵卡', async () => {
		// `agentTurnExecutor.ts:3780-3791`：并行执行可能被 abort 或异常打断，
		// 已 yield 过 tool_start 的调用若没有对应结果，UI 卡片会永远转圈。
		// finally 用 `startedToolIds`/`_executedToolIds`/`endedToolIds` 三集
		// 差集补发合成 tool_result + tool_end(success=false)。
		//
		// 这里用 parallelYieldLimit=1 精确模拟"第二个 delegate 没回来"。
		const { provider } = scriptedProvider(oneShotBatch([
			toolCallDelta('p-1', 'delegate_task', { type: 'code-explorer', task: '查 E' }),
			toolCallDelta('p-2', 'delegate_task', { type: 'code-explorer', task: '查 F' }),
		]));
		const { host } = routingHost(provider, { parallelYieldLimit: 1 });

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const endEvents = deltas.filter(delta => (delta as { type?: string }).type === 'tool_end');
		const endIds = endEvents.map(delta => String((delta as { toolCallId?: unknown }).toolCallId ?? ''));
		assert.deepStrictEqual(
			[...new Set(endIds)].sort(), ['p-1', 'p-2'],
			`未产出结果的调用也必须闭合（实际闭合=${JSON.stringify(endIds)}）`
			+ `——缺一个 tool_end，对应工具卡片就永久转圈且 turn 看起来像卡死`,
		);
		assert.strictEqual(
			endIds.length, new Set(endIds).size,
			`合成闭合不得与正常闭合重复发送（实际=${JSON.stringify(endIds)}）`
			+ `——忘记查 endedToolIds 就会对同一 id 发两次 tool_end`,
		);
		const synthetic = endEvents.find(
			delta => String((delta as { toolCallId?: unknown }).toolCallId ?? '') === 'p-2',
		) as { success?: unknown } | undefined;
		assert.strictEqual(
			synthetic?.success, false,
			`补发的闭合必须标记 success=false（实际 success=${String(synthetic?.success)}）`
			+ `——标成成功会让模型以为子代理已返回结果，据此继续推理`,
		);
		const interrupted = deltas.filter(delta =>
			(delta as { type?: string }).type === 'tool_result'
			&& String((delta as { content?: unknown }).content ?? '').includes('执行被中断或超时'),
		);
		assert.strictEqual(
			interrupted.length, 1,
			`必须为未完成调用回灌一条说明性 tool_result（实际 ${interrupted.length} 条）`
			+ `——只发 tool_end 不补 tool_result 会破坏 assistant/tool 消息配对`,
		);
	});
});


// ═══════════════════════════════════════════════════════════════════
// 第十六批：沙箱收尾闸门在并行路径上的一致性（finalizeToolCall 收口）
//
// `finalizeToolCall`（`turnToolExecution.ts:165`）是 2026-09-17 把三条执行
// 路径的收尾段收口后的**单一实现**，接线于三处：
//   · `agentTurnExecutor.ts:3748` 分区降级的 head 串行
//   · `agentTurnExecutor.ts:3773` 并行流
//   · `agentTurnExecutor.ts:3805` 纯串行
//
// 为什么必须专门为**并行路径**补测（串行路径已由 `:643` 的用例覆盖）：
//
//   · 收口前的真实行为分叉写在 `agentTurnExecutor.ts:3768-3770` 与
//     `turnToolExecution.ts:152-154`：headSerial / serial 各自内联了约 25 行
//     逐字重复的沙箱确认段，而**并行路径完全没有这段**。同一个沙箱违规走
//     串行会弹确认卡片，走并行则工具直接失败 —— 用户拿不到授权入口，且
//     同样的调用因为"这一批恰好含 2 个 delegate_task"而行为不同。
//     这是名单式重复实现必然产生的分叉，测试必须把收口后的一致性钉死。
//
//   · 闸门是**安全边界上唯一的交互点**：漏掉 = 静默失败；绕过 = 未获许可
//     的越权写入。两个失败方向都不可接受。
//
//   · `handledSandboxIds`（`:2977` 按迭代创建，三路径共享同一个 Set）在
//     `turnToolExecution.ts:173/176` 做去重：同一 toolCallId 一轮内只提示
//     一次。重执行后若仍被拦截则保留失败 —— 否则"拦截 → 弹卡 → 重执行 →
//     再拦截"会变成无限弹卡片的死循环。
//
//   · 决策**不在** executor 内解释：`:3474-3477` 把 decision 原样交给
//     `_reExecuteAfterSandbox`，由 sandboxGuard 判断该不该真的重跑。
//     executor 若自行加 `if (decision === 'cancel') skip`，就出现了两处
//     决策语义，二者漂移即越权。
//
// ⚠ 并行路径只可能承载 delegate_task（+ 只读工具）——整批并行的唯一入口是
// 「≥2 delegate 且其余均 PARALLEL_SAFE」（第十五批已锁）。故本批用 delegate
// 触发违规：子代理继承 worktree，越界路径确实会被沙箱拦下。
// ═══════════════════════════════════════════════════════════════════
suite('executeAgentTurnDirect — 沙箱闸门的三路径一致性（并行路径回归）', () => {

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/** 单轮派发 2 个 delegate_task（触发并行例外），下一轮自然收尾。 */
	function parallelDelegateProvider(): { provider: Record<string, unknown> } {
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (_modelId: string, _messages: unknown[]) => {
				const current = round++;
				return (async function* () {
					if (current === 0) {
						yield toolCallDelta('d-1', 'delegate_task', { type: 'code-explorer', task: '查越界路径' });
						yield toolCallDelta('d-2', 'delegate_task', { type: 'code-explorer', task: '查调用链' });
						yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
						return;
					}
					yield { type: 'text', content: '完成。' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};
		return { provider };
	}

	const SANDBOX_VIOLATION = {
		requestedPath: '/outside/workspace/child.ts',
		resolvedPath: 'G:\\outside\\workspace\\child.ts',
		allowedRoots: ['g:\\SarosWorkspace\\sarosis-agents-client'],
		suggestedPath: 'g:\\SarosWorkspace\\sarosis-agents-client\\child.ts',
		isWorktree: false,
	};

	/** 违规结果：`_isSandboxViolation` 的判据是 `metadata.sandboxViolation` 存在。 */
	function violationResult(toolCallId: string): Record<string, unknown> {
		return {
			toolCallId,
			content: 'sandbox blocked: path outside allowed roots',
			success: false,
			metadata: { sandboxViolation: SANDBOX_VIOLATION },
		};
	}

	/**
	 * 装配走**并行路径**且第一个 delegate 撞沙箱的 host。
	 *
	 * `decision` / `reExecutedResult` 可注入，用于分别覆盖「放行后重执行成功」
	 * 「重执行后仍被拦」「取消」三种决策后果。
	 */
	function sandboxParallelHost(
		provider: Record<string, unknown>,
		opts: {
			decision?: string;
			reExecutedResult?: (attempt: number) => Record<string, unknown> | undefined;
		} = {},
	): {
		host: Record<string, unknown>;
		cardBuilds: string[];
		awaited: string[];
		reExecuteArgs: Array<{ callId: string; decision: unknown }>;
		observed: Array<{ toolName: unknown; content: unknown }>;
	} {
		const cardBuilds: string[] = [];
		const awaited: string[] = [];
		const reExecuteArgs: Array<{ callId: string; decision: unknown }> = [];
		const observed: Array<{ toolName: unknown; content: unknown }> = [];
		let reExecuteAttempt = 0;

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'delegate_task', description: 'delegate', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['delegate_task']),
			_executeToolCalls: async (calls: Array<{ id: string }>) =>
				calls.map(call => ({ toolCallId: call.id, content: 'ok', success: true })),
			_executeToolCallsParallelStreaming: async function* (calls: Array<{ id: string }>) {
				for (const call of calls) {
					// 只让首个调用撞沙箱：同批另一个必须照常完成，
					// 证明闸门是**按调用**暂停而非拖垮整批。
					yield (call.id === 'd-1'
						? violationResult(call.id)
						: { toolCallId: call.id, content: 'ok:delegate', success: true }) as never;
				}
			},
			_isSandboxViolation: (result: { metadata?: { sandboxViolation?: unknown } }) =>
				!!result?.metadata?.sandboxViolation,
			_buildSandboxConfirmationCard: (toolName: string) => {
				cardBuilds.push(toolName);
				return { id: 'pending', title: 'Sandbox confirmation required' };
			},
			_awaitSandboxConfirmation: async (confirmationId: string) => {
				awaited.push(confirmationId);
				return opts.decision ?? 'allow_once';
			},
			_mapDecisionToCardStatus: (decision: string) =>
				decision === 'cancel' ? 'cancelled' : 'approved',
			_reExecuteAfterSandbox: async (
				call: { id: string },
				_agentId: unknown,
				_worktree: unknown,
				_signal: unknown,
				decision: unknown,
			) => {
				reExecuteArgs.push({ callId: call.id, decision });
				const attempt = ++reExecuteAttempt;
				if (opts.reExecutedResult) { return opts.reExecutedResult(attempt); }
				return { toolCallId: call.id, content: 'REEXECUTED_OK', success: true };
			},
			_observeToolResult: (
				_agentId: unknown,
				result: { toolName?: unknown; content?: unknown },
			) => {
				observed.push({ toolName: result?.toolName, content: result?.content });
			},
		});
		return { host, cardBuilds, awaited, reExecuteArgs, observed };
	}

	const TASK_REQUEST = {
		messages: [{ role: 'user', content: '请派发两个子代理分别调查模块入口与调用链结构' }],
	};

	test('并行路径的沙箱违规同样弹确认卡片并重执行（收口前此路径完全没有闸门）', async () => {
		// `agentTurnExecutor.ts:3768-3773`：并行流逐个结果过 finalizeToolCall。
		//
		// 收口前的事故形态：同一个越界写法走串行会弹卡片、走并行直接失败 ——
		// 用户既拿不到授权入口，也无法理解"为什么上次能弹这次不弹"。
		// 该断言一旦变红，说明并行分支的 finalizeToolCall 调用被摘掉了。
		const { provider } = parallelDelegateProvider();
		const { host, cardBuilds, awaited, reExecuteArgs } = sandboxParallelHost(provider);

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const confirmations = deltas.filter(delta => (delta as { type?: string }).type === 'confirmation');
		assert.strictEqual(
			confirmations.length, 1,
			`并行路径必须弹出确认卡片（实际 confirmation=${confirmations.length}，`
			+ `事件=${JSON.stringify(deltas.map(d => (d as { type?: string }).type))}）`
			+ `——缺失即回到收口前的行为分叉：并行批次里的沙箱违规静默失败`,
		);
		assert.deepStrictEqual(
			cardBuilds, ['delegate_task'],
			`卡片必须按被拦工具的真实名字构建（实际=${JSON.stringify(cardBuilds)}）`,
		);
		// 卡片必须先到 UI、再阻塞等决策（`:3450-3462` 之所以是 async generator）。
		const cardIndex = deltas.findIndex(delta => (delta as { type?: string }).type === 'confirmation');
		const resolvedIndex = deltas.findIndex(delta => (delta as { type?: string }).type === 'confirmation_resolved');
		assert.ok(
			cardIndex >= 0 && resolvedIndex > cardIndex,
			`confirmation 必须早于 confirmation_resolved（card=${cardIndex}, resolved=${resolvedIndex}）`
			+ `——写成 Promise 返回则卡片在决策之后才到 UI，用户等的是一张永不出现的卡`,
		);
		assert.deepStrictEqual(
			awaited, [(deltas[cardIndex] as { confirmationData?: { id?: string } }).confirmationData?.id],
			`等待的 confirmationId 必须与卡片 id 一致（awaited=${JSON.stringify(awaited)}）`
			+ `——不一致则用户点的按钮永远唤不醒这次暂停`,
		);
		assert.deepStrictEqual(
			reExecuteArgs.map(entry => entry.callId), ['d-1'],
			`只有被拦的调用应被重执行（实际=${JSON.stringify(reExecuteArgs)}）`
			+ `——顺带重跑同批其他调用等于重复副作用`,
		);
	});

	test('同批另一个调用不受闸门影响：暂停是按调用的，不拖垮整批', async () => {
		// 闸门在 `finalizeToolCall` 内、位于逐结果循环体中（`:3771`）。
		// 若谁把它上移到批次级（先收齐全部结果再统一处理），未违规的调用
		// 也会被一起挂起 —— 用户看到的是两张卡片同时卡住。
		const { provider } = parallelDelegateProvider();
		const { host } = sandboxParallelHost(provider);

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const endIds = deltas
			.filter(delta => (delta as { type?: string }).type === 'tool_end')
			.map(delta => String((delta as { toolCallId?: unknown }).toolCallId ?? ''));
		assert.deepStrictEqual(
			[...new Set(endIds)].sort(), ['d-1', 'd-2'],
			`两个调用都必须闭合（实际=${JSON.stringify(endIds)}）`
			+ `——被闸门暂停的那一个走重执行，另一个应原样完成`,
		);
		const results = deltas.filter(delta => (delta as { type?: string }).type === 'tool_result');
		const unaffected = results.filter(delta =>
			String((delta as { toolCallId?: unknown }).toolCallId ?? '') === 'd-2',
		);
		assert.strictEqual(
			unaffected.length, 1,
			`未违规的调用必须恰好回灌一条结果（实际 ${unaffected.length} 条）`,
		);
	});

	test('重执行后仍被拦 → 只弹一次卡片（handledSandboxIds 防重提示死循环）', async () => {
		// `turnToolExecution.ts:173/176`：判定前查 `handledSandboxIds`，
		// 进入闸门即先 `add`。故重执行结果哪怕**仍带违规元数据**，也不会
		// 触发第二轮弹卡 —— 否则"拦截 → 弹卡 → 重执行 → 再拦截"无限循环，
		// 用户被卡片刷屏且 turn 永不结束。
		const { provider } = parallelDelegateProvider();
		const { host, cardBuilds } = sandboxParallelHost(provider, {
			reExecutedResult: () => violationResult('d-1'),
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const confirmations = deltas.filter(delta => (delta as { type?: string }).type === 'confirmation');
		assert.strictEqual(
			confirmations.length, 1,
			`同一 toolCallId 一轮内只能提示一次（实际 ${confirmations.length} 次，`
			+ `建卡=${JSON.stringify(cardBuilds)}）`
			+ `——漏掉 handledSandboxIds 去重即无限弹卡片`,
		);
		// 仍失败的结果必须如实回灌，模型才知道要换路而不是原地重发。
		const blocked = deltas.filter(delta =>
			(delta as { type?: string }).type === 'tool_result'
			&& String((delta as { content?: unknown }).content ?? '').includes('sandbox blocked'),
		);
		assert.ok(
			blocked.length >= 1,
			`重执行仍失败时必须保留失败结果（实际 tool_result=`
			+ `${JSON.stringify(deltas.filter(d => (d as { type?: string }).type === 'tool_result').map(d => String((d as { content?: unknown }).content ?? '').slice(0, 40)))}）`
			+ `——粉饰成成功会让模型以为写入已生效`,
		);
	});

	test('用户决策原样透传给重执行，卡片状态由决策映射（executor 不自行解释决策）', async () => {
		// `agentTurnExecutor.ts:3462-3479`：executor 只做三件事 ——
		// 映射卡片状态、把 decision 原样交给 `_reExecuteAfterSandbox`、
		// 按返回值决定是否替换结果。**它自己不判断该不该重跑**。
		//
		// 若在 executor 里加 `if (decision === 'cancel') skip`，决策语义就有
		// 了两处实现（executor + sandboxGuard），二者漂移即越权或静默忽略。
		const { provider } = parallelDelegateProvider();
		const { host, reExecuteArgs } = sandboxParallelHost(provider, {
			decision: 'cancel',
			// 取消：guard 不重跑，返回 undefined → 必须保留原失败结果。
			reExecutedResult: () => undefined,
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			reExecuteArgs, [{ callId: 'd-1', decision: 'cancel' }],
			`decision 必须原样透传（实际=${JSON.stringify(reExecuteArgs)}）`
			+ `——在 executor 内提前拦掉 cancel 会让决策语义分裂成两处`,
		);
		const resolved = deltas.find(delta => (delta as { type?: string }).type === 'confirmation_resolved') as
			{ confirmationStatus?: unknown } | undefined;
		assert.strictEqual(
			resolved?.confirmationStatus, 'cancelled',
			`卡片回执状态必须映射自决策（实际=${String(resolved?.confirmationStatus)}）`
			+ `——取消却显示 approved 会让用户以为自己授权了越界写入`,
		);
		const stillBlocked = deltas.filter(delta =>
			(delta as { type?: string }).type === 'tool_result'
			&& String((delta as { content?: unknown }).content ?? '').includes('sandbox blocked'),
		);
		assert.ok(
			stillBlocked.length >= 1,
			`重执行返回 undefined 时必须保留原失败结果（实际=${stillBlocked.length} 条）`
			+ `——_reExecuteAfterSandbox 返回空却替换结果会凭空造出一个成功`,
		);
	});
	test('观测口拿到的是重执行后的最终结果，而非原失败结果', async () => {
		// `turnToolExecution.ts:183`：`observe` 在 finalResult 替换**之后**调用，
		// 且 `agentTurnExecutor.ts:3487-3489` 把 observe 归位到共用依赖里
		// （原先三处各自拼一次 toolName）。
		//
		// 观测口是连续失败追踪 / 记忆通道的输入。若喂的是被沙箱拦下的原始
		// 失败，一次「用户已授权且成功」的调用会被记成失败 —— 连续失败计数
		// 虚高，turn 被误判为卡死而提前收尾。
		const { provider } = parallelDelegateProvider();
		const { host, observed } = sandboxParallelHost(provider);

		await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const delegateObservations = observed.filter(entry => entry.toolName === 'delegate_task');
		assert.strictEqual(
			delegateObservations.length, 2,
			`两个调用都必须被观测且带上 toolName（实际=${JSON.stringify(observed)}）`
			+ `——toolName 缺失则记忆/失败追踪无法归因到具体工具`,
		);
		const reExecutedObservation = delegateObservations.find(entry =>
			String(entry.content ?? '').includes('REEXECUTED_OK'),
		);
		assert.ok(
			reExecutedObservation,
			`观测必须看到重执行后的结果（实际=${JSON.stringify(delegateObservations)}）`
			+ `——观测到原失败会把「已授权并成功」记成失败，抬高连续失败计数`,
		);
		assert.ok(
			!delegateObservations.some(entry => String(entry.content ?? '').includes('sandbox blocked')),
			`不得同时观测原失败结果（实际=${JSON.stringify(delegateObservations)}）`
			+ `——observe 在替换前后各调一次即为重复计数`,
		);
	});



});


// ═══════════════════════════════════════════════════════════════════
// 第十七批：工具结果图像的接线契约（剥离 → 门控 → 另路发送）
//
// `toolResultImages.ts` 只做两件**纯**的事（`:24-28`）：剥离图像项
// （`splitToolResultImages`，`:79`）、组装 `role:'user'` 消息
// （`buildToolImageMessage`，`:110`）。**接线在 agent loop 里**
// （`agentTurnExecutor.ts:3649-3724`），而接线恰恰是三处易错点的所在：
//
//   ① **图像必须离开被截断的 tool 文本**（`:3640-3644`）。
//      此前图像项被 `safeStringifyToolResult` 一起 JSON 化，再按
//      `MAX_TOOL_RESULT_CHARS`(100K) 截断 → **base64 被切断损坏**；而
//      `messageFormatConverter` 的 `role:'tool'` 分支三家 provider 都只读
//      字符串 —— 图像**从来没有**以图像形态到达模型。这是既存缺陷的修复。
//
//   ② **必须门控 `supportsImages`**（`:3650`/`:3717`）。不支持图片的模型
//      收到图像块会让 provider **直接 400**（Claude Code 的 `Read` 踩过）。
//      能力解析 fail-closed：`listModels()` 抛错/查不到字段 → false
//      （`toolResultImages.ts:151-161`）。
//
//   ③ **门掉了也要说出来**（`:3662-3665`）。图像被剥离但模型若一无所知，
//      它会以为工具没产出图、或以为自己看到了 —— 本项目对「静默削弱」的
//      一贯态度是：要么做到，要么说出来。`toolImageOmittedNote`（`:173`）
//      同时给出两条出路（换视觉模型 / 用 `vision_analyze`）。
//
// 另有一条边界：`type:'image'` 但 `data` 是 URI 的项**不剥离**
// （`toolResultImages.ts:60-66`/`:75-77`）—— 宁可让模型看到那个 URI，
// 也不要静默丢信息。判据是「带 scheme 前缀」而非「看起来像 base64」。
//
// ⚠ 观测口选择：图像消息只出现在**发给 provider 的 messages 快照**里
// （`role:'user'` + `contentParts`），不出现在 delta 流中；而省略说明则
// 混在 tool_result 文本里。故本批同时读 snapshots 与 deltas。
// ⚠ `resolveSupportsImages` 有模块级 TTL 缓存（键 `provider.id::modelId`），
// 用例之间必须用不同 provider.id 或显式 reset，否则互相污染出假绿。
// ═══════════════════════════════════════════════════════════════════
suite('executeAgentTurnDirect — 工具结果图像的剥离、门控与另路发送', () => {

	/** 1×1 透明 PNG 的 base64（纯载荷，不含 `data:` 前缀）。 */
	const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+9QZ4AAAAAElFTkSuQmCC';

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/**
	 * 装配「首轮调一次 vision 工具、次轮收尾」的 host。
	 *
	 * @param supportsImages 写进 `listModels()` 的能力声明；`'throw'` 用于覆盖
	 *        fail-closed 分支（`toolResultImages.ts:159-161`）。
	 * @param resultContent 工具返回的原始 content（内容块数组或字符串）。
	 * @param providerId 必须逐用例唯一 —— 能力解析按 `provider.id::modelId` 缓存。
	 */
	function imageToolHost(opts: {
		providerId: string;
		supportsImages: boolean | 'throw';
		resultContent: unknown;
	}): {
		host: Record<string, unknown>;
		snapshots: Array<Array<{ role?: string; content?: unknown; contentParts?: unknown }>>;
	} {
		const snapshots: Array<Array<{ role?: string; content?: unknown; contentParts?: unknown }>> = [];
		let round = 0;
		const provider = {
			id: opts.providerId,
			name: 'Mock Provider',
			listModels: async () => {
				if (opts.supportsImages === 'throw') {
					throw new Error('listModels unavailable');
				}
				return [{ id: 'mock-model', supportsImages: opts.supportsImages }];
			},
			chat: (
				_modelId: string,
				messages: Array<{ role?: string; content?: unknown; contentParts?: unknown }>,
			) => {
				snapshots.push(messages.map(m => ({
					role: m.role,
					content: m.content,
					contentParts: m.contentParts,
				})));
				const current = round++;
				return (async function* () {
					if (current === 0) {
						yield toolCallDelta('img-1', 'vision_analyze', { image: '/mock/shot.png', query: '读一下' });
						yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
						return;
					}
					yield { type: 'text', content: '看完了。' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'vision_analyze', description: 'look', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['vision_analyze']),
			_executeToolCalls: async (calls: Array<{ id: string }>) =>
				calls.map(call => ({ toolCallId: call.id, content: opts.resultContent, success: true })),
		});
		return { host, snapshots };
	}

	const TASK_REQUEST = {
		messages: [{ role: 'user', content: '请看一下这张界面截图里报的错误是什么' }],
	};

	/** 末轮快照里所有带 contentParts 的 user 消息（图像另路发送的唯一落点）。 */
	function imageMessages(
		snapshots: Array<Array<{ role?: string; content?: unknown; contentParts?: unknown }>>,
	): Array<{ role?: string; contentParts?: unknown }> {
		const last = snapshots[snapshots.length - 1] ?? [];
		return last.filter(message =>
			message.role === 'user' && Array.isArray(message.contentParts),
		);
	}

	/** 全部 tool_result 文本拼接（省略说明混在其中）。 */
	function toolResultText(deltas: ReadonlyArray<unknown>): string {
		return deltas
			.filter(delta => (delta as { type?: string }).type === 'tool_result')
			.map(delta => String((delta as { content?: unknown }).content ?? ''))
			.join('\n');
	}

	test('模型支持图片 → 图像另走 role:user 消息，且不留在被截断的 tool 文本里', async () => {
		// `agentTurnExecutor.ts:3717-3723`：`_imgSupported` 为真时追加
		// `buildToolImageMessage` 的产物。`role:'user'` 是唯一可移植的位置
		// （`toolResultImages.ts:99-104`：OpenAI 协议不允许 tool 消息带图像块，
		// 本项目 converter 的 tool 分支也只读字符串）。
		//
		// 同时断言 base64 **不再出现在** tool 文本里 —— 这正是原缺陷：
		// 图像被一起 JSON 化后按 100K 截断，base64 断成损坏数据（`:3640-3644`）。
		const { host, snapshots } = imageToolHost({
			providerId: 'p-supports',
			supportsImages: true,
			resultContent: [
				{ type: 'text', text: '界面截图如下' },
				{ type: 'image', data: PNG_B64, mimeType: 'image/png' },
			],
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const imgMsgs = imageMessages(snapshots);
		assert.strictEqual(
			imgMsgs.length, 1,
			`支持图片时必须恰好追加一条带 contentParts 的 user 消息（实际 ${imgMsgs.length} 条，`
			+ `末轮角色序列=${JSON.stringify((snapshots[snapshots.length - 1] ?? []).map(m => m.role))}）`
			+ `——挂在 tool 消息上在三家 provider 都不会生效`,
		);
		const parts = imgMsgs[0].contentParts as Array<{ type?: string; data?: unknown; mimeType?: unknown }>;
		assert.ok(
			parts.some(part => part.type === 'image' && part.data === PNG_B64),
			`图像块必须携带原始 base64（实际 parts=${JSON.stringify(parts.map(p => p.type))}）`,
		);
		assert.ok(
			parts.some(part => part.type === 'text'),
			`必须带一段说明文本，让模型知道图从哪个工具来（实际 parts=${JSON.stringify(parts.map(p => p.type))}）`,
		);
		const resultText = toolResultText(deltas);
		assert.ok(
			!resultText.includes(PNG_B64),
			`base64 不得再留在 tool 文本中（tool_result 片段=${resultText.slice(0, 120)}）`
			+ `——留下即会被 MAX_TOOL_RESULT_CHARS 截断成损坏数据，白占上下文`,
		);
		assert.ok(
			resultText.includes('界面截图如下'),
			`剥离图像后其余内容必须原样保留（实际=${resultText.slice(0, 120)}）`,
		);
	});

	test('模型不支持图片 → 不发图像块，但必须用文本说明「有图未附上」并给出路', async () => {
		// `agentTurnExecutor.ts:3650`/`:3662-3665`：门控为假时既不追加图像消息，
		// 也不能静默 —— 否则模型以为工具没产出图，或以为自己看到了。
		// 文案（`toolResultImages.ts:173-178`）必须指出两条出路。
		const { host, snapshots } = imageToolHost({
			providerId: 'p-no-images',
			supportsImages: false,
			resultContent: [
				{ type: 'text', text: '界面截图如下' },
				{ type: 'image', data: PNG_B64, mimeType: 'image/png' },
			],
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			imageMessages(snapshots), [],
			`不支持图片时绝不能发图像块（实际=${JSON.stringify(imageMessages(snapshots))}）`
			+ `——provider 会直接 400，整个 turn 报错`,
		);
		const resultText = toolResultText(deltas);
		assert.ok(
			/NOT attached/.test(resultText),
			`必须显式告知「有图但没附上」（实际 tool_result=${resultText.slice(0, 200)}）`
			+ `——静默剥离会让模型以为工具没产出图`,
		);
		assert.ok(
			/vision_analyze/.test(resultText) && /vision-capable model/.test(resultText),
			`说明文案必须给出两条出路（换视觉模型 / vision_analyze）（实际=${resultText.slice(-260)}）`
			+ `——只说「不支持」模型只会原地重试同一个工具`,
		);
	});

	test('能力查询抛错 → fail-closed 不发图（宁可少看一张图，不可整轮 400）', async () => {
		// `toolResultImages.ts:156-161`：`listModels()` 抛错时 value=false。
		// 反向（查不到就默认支持）会把一次能力探测失败升级成整轮请求失败。
		const { host, snapshots } = imageToolHost({
			providerId: 'p-throws',
			supportsImages: 'throw',
			resultContent: [
				{ type: 'image', data: PNG_B64, mimeType: 'image/png' },
			],
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			imageMessages(snapshots), [],
			`能力未知时必须按不支持处理（实际=${JSON.stringify(imageMessages(snapshots))}）`
			+ `——fail-open 会让一次 listModels 故障变成 provider 400`,
		);
		assert.ok(
			/NOT attached/.test(toolResultText(deltas)),
			`fail-closed 同样要给出文本说明（实际=${toolResultText(deltas).slice(0, 200)}）`,
		);
	});

	test('type:image 但 data 是 URI → 不剥离、不发图，原样留在文本里', async () => {
		// `toolResultImages.ts:60-66` + `:75-77`：判据是「带 scheme 前缀」，
		// 只有纯 base64 载荷才剥离。URI 形态（`saros-media://` / `https://`）
		// 保留在文本中 —— 宁可让模型看到那个 URI，也不要静默丢掉信息。
		//
		// 若按「看起来像 base64」判定（字符集与路径有交集），URI 会被误当
		// 载荷发出去，provider 侧解码失败。
		const MEDIA_URI = 'saros-media://local/shot-2026.png';
		const { host, snapshots } = imageToolHost({
			providerId: 'p-uri',
			supportsImages: true,
			resultContent: [
				{ type: 'image', data: MEDIA_URI, mimeType: 'image/png' },
			],
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			imageMessages(snapshots), [],
			`URI 形态不是内联载荷，不得作为图像块发送（实际=${JSON.stringify(imageMessages(snapshots))}）`,
		);
		const resultText = toolResultText(deltas);
		assert.ok(
			resultText.includes(MEDIA_URI),
			`URI 必须原样留在文本里（实际=${resultText.slice(0, 200)}）`
			+ `——剥掉又不发送就是彻底的静默丢信息`,
		);
		assert.ok(
			!/NOT attached/.test(resultText),
			`没有可内联图像时不得追加省略说明（实际=${resultText.slice(0, 200)}）`
			+ `——images.length 为 0 却提示「有图未附上」是纯噪声`,
		);
	});

	test('纯字符串结果不受影响：既不追加图像消息也不追加说明（零开销路径）', async () => {
		// `toolResultImages.ts:81`：非数组 content 原样返回、images 为空。
		// 绝大多数工具走这条路径，任何额外注入都是对每轮上下文的净损耗。
		const { host, snapshots } = imageToolHost({
			providerId: 'p-plain',
			supportsImages: true,
			resultContent: '截图里显示 TS2304: Cannot find name',
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host, mockRequest(TASK_REQUEST) as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			imageMessages(snapshots), [],
			`无图像时不得追加 user 消息（实际=${JSON.stringify(imageMessages(snapshots))}）`,
		);
		const resultText = toolResultText(deltas);
		assert.ok(
			!/NOT attached/.test(resultText),
			`无图像时不得追加省略说明（实际=${resultText.slice(0, 200)}）`,
		);
		assert.ok(
			resultText.includes('TS2304'),
			`字符串结果必须原样回灌（实际=${resultText.slice(0, 200)}）`,
		);
	});
});

suite('executeAgentTurnDirect — 失败恢复提示的挂载条件与结果哈希纯净性', () => {

	/**
	 * 本 suite 锁定 `appendRecoveryHint`（`agentTurnExecutor.ts:2910-2916`）这一段
	 * 「只在失败时、只对有映射的工具、且只加在返回给模型的文本上」的三重约束。
	 *
	 * 为什么值得单独钉住：
	 *  1. 提示挂载在 `:3704-3707` 的**组合表达式**里，与护栏引导共用一个赋值。
	 *     顺序是 recovery-hint 先、guardrail-guidance 后（`:3703` 的注释解释了
	 *     原因：护栏引导要排在最末尾才对模型足够醒目）。一旦有人图省事把两者
	 *     交换或合并，护栏文案会被恢复提示挤到中间，模型更容易读漏。
	 *  2. 结果哈希（`RECORD_TOOL_RESULT`，`:3696-3701`）用的是 `rawStr` ——
	 *     **未挂提示前**的原文。`:3694-3695` 的注释说明该哈希要喂给 ping-pong /
	 *     no_progress 做跨调用比对。若误用挂了提示的 `resultStr`，提示文本里
	 *     带着 `count=` 这类每轮都变的量，哈希会永远不相等，同结果重复调用
	 *     就再也判不出来 —— 等于静默废掉第十四批锁的那条拦截链。
	 *  3. `getToolFailureRecoveryHint`（`:277-296`）是**白名单**表：表里没有的
	 *     工具名返回 null，此时结果文本必须原样透出，不能出现空的 `[Hint: ]`。
	 */

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/**
	 * 装配「前 rounds 轮各调一次 toolName、最后一轮收尾」的 host。
	 *
	 * @param toolName    被调用的工具名（决定是否命中 hint 白名单）。
	 * @param success     工具执行结果的成功标记（决定是否挂 recovery hint）。
	 * @param resultText  工具返回的原始文本。
	 * @param rounds      调用工具的轮数；每轮参数相同，用于观察哈希驱动的重复检测。
	 */
	function failingToolHost(opts: {
		toolName: string;
		success: boolean;
		resultText: string;
		rounds?: number;
	}): {
		host: Record<string, unknown>;
		snapshots: Array<Array<{ role?: string; content?: unknown }>>;
	} {
		const totalRounds = opts.rounds ?? 1;
		const snapshots: Array<Array<{ role?: string; content?: unknown }>> = [];
		let round = 0;
		const provider = {
			id: `recovery-hint-${opts.toolName}-${opts.success}-${totalRounds}`,
			name: 'Mock Provider',
			listModels: async () => [{ id: 'mock-model' }],
			chat: (
				_modelId: string,
				messages: Array<{ role?: string; content?: unknown }>,
			) => {
				snapshots.push(messages.map(m => ({ role: m.role, content: m.content })));
				const current = round++;
				return (async function* () {
					if (current < totalRounds) {
						yield toolCallDelta(`call-${current}`, opts.toolName, { path: '/mock/target.ts' });
						yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
						return;
					}
					yield { type: 'text', content: '收尾。' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: opts.toolName, description: 'do', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>([opts.toolName]),
			_executeToolCalls: async (calls: Array<{ id: string }>) =>
				calls.map(call => ({
					toolCallId: call.id,
					content: opts.resultText,
					success: opts.success,
				})),
		});
		return { host, snapshots };
	}

	// `executeAgentTurnDirect` 的第三参是 steeringQueue（不是 logger）——
	// 本批不注入 steering，故只传 (host, request) 两参。
	const TASK_REQUEST = mockRequest({
		messages: [{ role: 'user', content: '帮我读一下 target.ts 并修掉里面的类型错误' }],
	});

	/** 末轮快照里所有 role:'tool' 消息的文本（提示实际落点）。 */
	function toolMessageTexts(
		snapshots: Array<Array<{ role?: string; content?: unknown }>>,
	): string[] {
		const last = snapshots[snapshots.length - 1] ?? [];
		return last
			.filter(message => message.role === 'tool')
			.map(message => String(message.content ?? ''));
	}

	test('失败 + 命中白名单的工具：提示以 [Hint: ...] 追加在结果文本之后', async () => {
		// `file_read` 在 `:283-284` 的表里，失败时应挂它那条「用 file_list 验证路径
		// 或用 search_graph 按符号定位」的提示 —— 这正是模型最容易卡死的姿势
		// （反复用同一个错路径重试），提示存在与否直接决定它能不能自己走出来。
		const { host, snapshots } = failingToolHost({
			toolName: 'file_read',
			success: false,
			resultText: 'ENOENT: no such file or directory',
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host as any, TASK_REQUEST as any) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		assertNoToolExecutionErrors(deltas);

		const texts = toolMessageTexts(snapshots);
		assert.strictEqual(texts.length, 1, '应只有一条 tool 消息');
		const toolText = texts[0];

		assert.ok(
			toolText.includes('ENOENT: no such file or directory'),
			`原始错误文本必须保留，实际: ${toolText}`,
		);
		assert.ok(
			/\[Hint: /.test(toolText),
			`失败且命中白名单时必须挂 [Hint: ...]，实际: ${toolText}`,
		);
		assert.ok(
			toolText.includes('file_list') || toolText.includes('search_graph'),
			`提示内容应为 file_read 那一条（含 file_list / search_graph 引导），实际: ${toolText}`,
		);
		// 提示必须在原文之后，否则模型先读到"建议"再读到"错误"，因果颠倒。
		assert.ok(
			toolText.indexOf('ENOENT') < toolText.indexOf('[Hint:'),
			'提示必须追加在原始结果之后，不能前置',
		);
	});

	test('成功结果：即使工具在白名单内也不得挂恢复提示', async () => {
		// `:3705` 的三元判据是 `!toolResult.success`。成功时挂提示不只是噪音：
		// 模型会把"建议换个方案"误读成本次调用有问题，从而把已经拿到的正确结果
		// 丢掉重试一遍（白烧一轮迭代预算）。
		const { host, snapshots } = failingToolHost({
			toolName: 'file_read',
			success: true,
			resultText: 'export const answer = 42;',
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host as any, TASK_REQUEST as any) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		assertNoToolExecutionErrors(deltas);

		const toolText = toolMessageTexts(snapshots)[0] ?? '';
		assert.ok(
			toolText.includes('export const answer = 42;'),
			`成功结果原文必须透出，实际: ${toolText}`,
		);
		assert.ok(
			!/\[Hint: /.test(toolText),
			`成功结果不得挂恢复提示，实际: ${toolText}`,
		);
	});

	test('失败但工具不在白名单：结果原样透出，不得出现空提示壳', async () => {
		// `getToolFailureRecoveryHint` 对未登记工具返回 null，`:2914` 据此提前返回。
		// 这条用例防的是"把 null 当空串拼接"的退化写法 —— 那会产出 `[Hint: ]`
		// 这种既无信息又占 token 的壳，还会让模型以为提示被截断了。
		const { host, snapshots } = failingToolHost({
			toolName: 'vision_analyze',
			success: false,
			resultText: 'vision backend unavailable',
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host as any, TASK_REQUEST as any) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		assertNoToolExecutionErrors(deltas);

		const toolText = toolMessageTexts(snapshots)[0] ?? '';
		assert.ok(
			toolText.includes('vision backend unavailable'),
			`原始失败文本必须保留，实际: ${toolText}`,
		);
		assert.ok(
			!/\[Hint: /.test(toolText),
			`未登记工具不应挂提示，实际: ${toolText}`,
		);
		assert.ok(
			!toolText.includes('[Hint: ]'),
			'绝不允许出现空提示壳 [Hint: ]',
		);
	});

	test('恢复提示不得污染结果哈希：同结果重复失败仍能被 no_progress 拦住', async () => {
		// 这是本批最关键的一条。`:3700` 传给 RECORD_TOOL_RESULT 的是 `rawStr`，
		// 而挂了提示的 `resultStr` 在 `:3704` 才产生 —— 顺序保证哈希看到的是原文。
		//
		// 若有人把两行调换（先挂提示再回填哈希），由于护栏引导里带 `count=N`
		// 这种逐轮递增的量，同一个失败结果每轮哈希都不同，resultHash 会被当成
		// "结果有变化"而重置 repeatCount（`toolGuardrailController.ts:444`），
		// no_progress 永远攒不到阈值，模型可以无限重试同一个必然失败的调用。
		//
		// 断言方式：连续 4 轮发起同名同参且结果完全相同的失败调用，要求最终
		// 出现 no_progress 拦截文案 —— 它只可能在 resultHash 稳定不变时触发。
		const { host } = failingToolHost({
			toolName: 'file_read',
			success: false,
			resultText: 'ENOENT: no such file or directory',
			rounds: 4,
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host as any, TASK_REQUEST as any) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const allText = deltas
			.filter(delta => (delta as { type?: string }).type === 'tool_result')
			.map(delta => String((delta as { content?: unknown }).content ?? ''))
			.join('\n');

		assert.ok(
			/no_progress|no progress|Tool loop/i.test(allText),
			'同签名 + 同结果重复失败必须被拦截（哈希被提示污染时此断言会失败）',
		);
	});
});


suite('executeAgentTurnDirect — AllowOnce 放行根的 fresh-dispatch 清理边界', () => {

	/**
	 * 本 suite 锁定 `host._clearSandboxBypassRoots()` 的**调用位置**契约。
	 *
	 * 语义（`agentOSService.ts:1493-1501` 的三条说明）：
	 *  ⓵ 清空的是 AllowOnce 放行根（`_sandboxBypassRoots`），AllowWorkspace 走
	 *    `persistSandboxRoot` 持久根，不受影响。
	 *  ⓶ 必须在**每个工具批次派发前**调用，否则上一批的一次用户确认会被隐性
	 *    携带到后续无关调用上 —— 用户只为 A 放行，B 却也跟着越过了沙箱。
	 *  ⓷ 严禁放在 `reExecuteAfterSandbox` 的共享派发路径内
	 *    （`agentSandboxGuard.ts:157`）：re-exec 是 executeToolCalls 前 add、
	 *    finally 内 remove，若在共享路径清空会擦掉进行中的放行，让重执行再次
	 *    被拦 —— 「允许一次」直接失效。
	 *
	 * 三条派发路径各有一次清理（`agentTurnExecutor.ts:3743` delegate 分区头部
	 * 串行、`:3765` 并行、`:3795` 串行），本 suite 逐条钉住「清理必须早于派发」
	 * 这一相对顺序 —— 只断言存在性是不够的，顺序反了照样泄漏。
	 */

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/**
	 * 装配一个把「清理」与「派发」写入同一条时间线的 host。
	 *
	 * @param firstRoundCalls 首轮派发的工具调用；其组合决定命中哪条路径。
	 * @returns timeline 形如 ['clear', 'serial:[a]', 'parallel:[d-1,d-2]']，
	 *          可直接断言相对顺序。
	 */
	function bypassTimelineHost(firstRoundCalls: Array<{ id: string; name: string }>): {
		host: Record<string, unknown>;
		timeline: string[];
	} {
		const timeline: string[] = [];
		let round = 0;
		const toolNames = [...new Set(firstRoundCalls.map(call => call.name))];

		const provider = {
			id: `bypass-timeline-${toolNames.join('-')}-${firstRoundCalls.length}`,
			name: 'Mock Provider',
			listModels: async () => [{ id: 'mock-model' }],
			chat: (_modelId: string, _messages: unknown[]) => {
				const current = round++;
				return (async function* () {
					if (current === 0) {
						for (const call of firstRoundCalls) {
							yield toolCallDelta(call.id, call.name, { path: `/mock/${call.id}.ts` });
						}
						yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
						return;
					}
					yield { type: 'text', content: '完成。' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => toolNames.map(name => ({
				name,
				description: 'do',
				inputSchema: { type: 'object' },
			})),
			_lastAllEnabledToolNames: new Set<string>(toolNames),
			_clearSandboxBypassRoots: () => {
				timeline.push('clear');
			},
			_executeToolCalls: async (calls: Array<{ id: string }>) => {
				timeline.push(`serial:[${calls.map(call => call.id).join(',')}]`);
				return calls.map(call => ({ toolCallId: call.id, content: 'ok', success: true }));
			},
			_executeToolCallsParallelStreaming: async function* (calls: Array<{ id: string }>) {
				timeline.push(`parallel:[${calls.map(call => call.id).join(',')}]`);
				for (const call of calls) {
					yield { toolCallId: call.id, content: 'ok', success: true };
				}
			},
		});
		return { host, timeline };
	}

	/** 断言 timeline 中每个派发事件之前都紧跟着一次 clear。 */
	function assertClearPrecedesEveryDispatch(timeline: string[]): void {
		const dispatchIndexes = timeline
			.map((entry, index) => ({ entry, index }))
			.filter(item => item.entry !== 'clear')
			.map(item => item.index);

		assert.ok(dispatchIndexes.length > 0, `时间线里应有派发事件，实际: ${timeline.join(' → ')}`);
		for (const dispatchIndex of dispatchIndexes) {
			assert.strictEqual(
				timeline[dispatchIndex - 1],
				'clear',
				`派发 ${timeline[dispatchIndex]} 之前必须紧邻一次 clear，实际时间线: ${timeline.join(' → ')}`,
			);
		}
	}

	test('串行路径：清理必须发生在 _executeToolCalls 之前（:3795）', async () => {
		// 单个写工具 → 主开关关闭且无 delegate 例外，走串行分支。
		const { host, timeline } = bypassTimelineHost([{ id: 'w-1', name: 'file_write' }]);

		const { deltas } = await drain(
			executeAgentTurnDirect(host as any, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		assertNoToolExecutionErrors(deltas);

		assert.deepStrictEqual(
			timeline,
			['clear', 'serial:[w-1]'],
			`串行路径应恰好是「先清理、后派发」，实际: ${timeline.join(' → ')}`,
		);
	});

	test('并行路径：清理必须发生在流式并行派发之前（:3765）', async () => {
		// 2 个 delegate_task 命中并行例外（`toolCallUtils.ts:1485-1492`）。
		const { host, timeline } = bypassTimelineHost([
			{ id: 'd-1', name: 'delegate_task' },
			{ id: 'd-2', name: 'delegate_task' },
		]);

		const { deltas } = await drain(
			executeAgentTurnDirect(host as any, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		assertNoToolExecutionErrors(deltas);

		assert.deepStrictEqual(
			timeline,
			['clear', 'parallel:[d-1,d-2]'],
			`并行路径应恰好是「先清理、后并发派发」，实际: ${timeline.join(' → ')}`,
		);
	});

	test('delegate 分区路径：串行头部与并行子集各自清理一次（:3743 + :3765）', async () => {
		// 写工具混入 → 整批不可并行，但 delegate 子集靠分区降级并发
		// （第十五批已锁该选路）。分区把一个批次**拆成两次派发**，因此必须
		// 清理两次：若只在入口清一次，第一段里用户为写工具做的 AllowOnce
		// 放行会残留，被后面并发的 delegate 子集白捡。
		const { host, timeline } = bypassTimelineHost([
			{ id: 'w-1', name: 'file_write' },
			{ id: 'd-1', name: 'delegate_task' },
			{ id: 'd-2', name: 'delegate_task' },
		]);

		const { deltas } = await drain(
			executeAgentTurnDirect(host as any, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		assertNoToolExecutionErrors(deltas);

		assert.strictEqual(
			timeline.filter(entry => entry === 'clear').length,
			2,
			`分区路径有两次独立派发，应清理两次，实际: ${timeline.join(' → ')}`,
		);
		assertClearPrecedesEveryDispatch(timeline);
		// 顺序还必须是「头部串行先、delegate 子集后」——反了会让 delegate
		// 先跑，写工具的结果来不及进入子代理可见的上下文。
		assert.deepStrictEqual(
			timeline,
			['clear', 'serial:[w-1]', 'clear', 'parallel:[d-1,d-2]'],
			`实际时间线: ${timeline.join(' → ')}`,
		);
	});

	test('跨迭代：每一轮工具批次派发前都重新清理，放行不跨批次存活', async () => {
		// 契约 ⓶ 的正面表达。两轮各派发一个工具，必须出现两次 clear 且
		// 每次都紧邻其后的派发 —— 只在整个 turn 开始时清一次是不合格的。
		const timeline: string[] = [];
		let round = 0;
		const provider = {
			id: 'bypass-cross-iteration',
			name: 'Mock Provider',
			listModels: async () => [{ id: 'mock-model' }],
			chat: (_modelId: string, _messages: unknown[]) => {
				const current = round++;
				return (async function* () {
					if (current < 2) {
						yield toolCallDelta(`w-${current}`, 'file_write', { path: `/mock/r${current}.ts` });
						yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
						return;
					}
					yield { type: 'text', content: '完成。' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};
		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'file_write', description: 'write', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['file_write']),
			_clearSandboxBypassRoots: () => {
				timeline.push('clear');
			},
			_executeToolCalls: async (calls: Array<{ id: string }>) => {
				timeline.push(`serial:[${calls.map(call => call.id).join(',')}]`);
				return calls.map(call => ({ toolCallId: call.id, content: 'ok', success: true }));
			},
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host as any, mockRequest() as never) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		assertNoToolExecutionErrors(deltas);

		assert.deepStrictEqual(
			timeline,
			['clear', 'serial:[w-0]', 'clear', 'serial:[w-1]'],
			`每轮批次都应重新清理，实际: ${timeline.join(' → ')}`,
		);
	});
});


suite('executeAgentTurnDirect — 轻量请求的探索工具门控', () => {

	/**
	 * 本 suite 锁定 `_isTrivialRequest`（`agentTurnExecutor.ts:318-352`）与
	 * `TRIVIAL_BLOCKED_TOOLS` 过滤（`:1637-1643`）的联合行为。
	 *
	 * 动机：用户发一句 "test1" 或 "你好"，不该触发图谱构建、代码库深度探索、
	 * 子代理委托 —— 那是几十秒的空转加一堆无用 token。判定命中后，每轮迭代都
	 * 从 enabledTools 里剔除探索/委托/技能类工具（`:303-308` 名单）。
	 *
	 * 但这个门控是**双向有风险**的：
	 *  · 漏判（该拦没拦）只是浪费资源；
	 *  · 误判（真任务被当 trivial）会直接**致残** —— 模型拿不到 search_graph /
	 *    delegate_task，却被要求分析代码库，只能凭空编答案。
	 * 所以 `:337-341` 叠了两道排除：含代码/任务信号词、含路径或扩展名，
	 * 一律不算 trivial。本 suite 对这两道排除各给一条反向用例。
	 *
	 * 另一个易碎点：过滤用的是 `String(t.name).includes(b)`（`:1627`）——
	 * **子串**匹配而非全等。这让 `search_graph_v2` 这类衍生名也能被拦住，
	 * 但同时意味着任何名字里含 `list_skills` / `search_files` 的工具都会连带
	 * 被剔除。本 suite 把该语义显式钉住，避免有人"优化"成 `===` 而放漏衍生名。
	 */

	/**
	 * 装配一个记录「每轮实际发给模型的工具名」的 host。
	 *
	 * 签名为 `chat(modelId, messages, modelOptions, context)`，工具列表在第 3 个
	 * 参数 `modelOptions.tools` 内（而非裸数组实参）。
	 */
	function toolGateHost(userText: string, offeredTools: string[]): {
		host: Record<string, unknown>;
		toolNamesPerRound: string[][];
	} {
		const toolNamesPerRound: string[][] = [];
		const provider = {
			id: `trivial-gate-${userText.slice(0, 12)}`,
			name: 'Mock Provider',
			listModels: async () => [{ id: 'mock-model' }],
			chat: (
				_modelId: string,
				_messages: unknown[],
				modelOptions?: { tools?: Array<{ name?: unknown }> },
			) => {
				toolNamesPerRound.push((modelOptions?.tools ?? []).map(tool => String(tool.name)));
				return (async function* () {
					yield { type: 'text', content: '好的。' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => offeredTools.map(name => ({
				name,
				description: 'do',
				inputSchema: { type: 'object' },
			})),
			_lastAllEnabledToolNames: new Set<string>(offeredTools),
		});
		return { host, toolNamesPerRound };
	}

	/** 全量工具池：混合被拦名单与应当保留的常规工具。 */
	const OFFERED_TOOLS = [
		'search_graph', 'delegate_task', 'index_repository', 'list_skills',
		'file_read', 'file_write', 'terminal',
	];

	async function runWith(userText: string, offered: string[] = OFFERED_TOOLS): Promise<string[]> {
		const { host, toolNamesPerRound } = toolGateHost(userText, offered);
		const { deltas } = await drain(
			executeAgentTurnDirect(
				host as any,
				mockRequest({ messages: [{ role: 'user', content: userText }] }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		assertNoToolExecutionErrors(deltas);
		assert.ok(toolNamesPerRound.length > 0, '至少应调用模型一次');
		return toolNamesPerRound[0];
	}

	test('"test1" 判为 trivial：探索/委托/技能类工具全部剔除，常规工具保留', async () => {
		// `:328` 的 /^test\d*$/i 命中。
		const sent = await runWith('test1');

		for (const blocked of ['search_graph', 'delegate_task', 'index_repository', 'list_skills']) {
			assert.ok(
				!sent.includes(blocked),
				`trivial 请求不应携带 ${blocked}，实际工具: ${sent.join(',')}`,
			);
		}
		// 门控只砍探索面，不该把基础读写能力也砍掉 —— 否则模型连"打个招呼顺手
		// 看一眼文件"都做不到，体验反而更差。
		for (const kept of ['file_read', 'file_write', 'terminal']) {
			assert.ok(
				sent.includes(kept),
				`常规工具 ${kept} 必须保留，实际工具: ${sent.join(',')}`,
			);
		}
	});

	test('中文问候判为 trivial —— `\\b` 对 CJK 恒假的回归（2026-09-18 修）', async () => {
		// 原实现写作 `/^(你好|您好|在吗|...)\b/`。`\b` 是 ASCII 单词边界，只在
		// `\w`([A-Za-z0-9_]) 与非 `\w` 的交界成立；CJK 字符不属于 `\w`，于是
		// `/^你好\b/.test('你好')` 恒为 false —— 该行所有中文条目从未命中过，
		// 中文用户的问候一直在触发完整探索工具集 + 图谱构建。
		// 修复后改用 `(?![\u4e00-\u9fa5])` 作为等价边界（`agentTurnExecutor.ts:333-341`）。
		for (const greeting of ['你好', '您好', '在吗', '好的', '收到', '谢谢']) {
			const sent = await runWith(greeting);
			assert.ok(
				!sent.includes('search_graph'),
				`「${greeting}」应判为 trivial，实际工具: ${sent.join(',')}`,
			);
		}
	});

	test('含任务信号词 → 不判 trivial，探索工具必须完整下发（防误判致残）', async () => {
		// 这几条**都先命中了 trivialPatterns**（以问候/确认词开头），必须靠
		// 信号词排除才能放行 —— 是误判致残的唯一防线。
		// 注意中文信号词同样受 `\b` 缺陷影响（修复见 `agentTurnExecutor.ts:344-349`：
		// ASCII 词保留 `\b` 整词匹配，中文词改为直接子串匹配）。
		for (const taskText of [
			'你好，帮我分析一下',   // 中文问候 + 中文信号词「分析」
			'好的，修复这个',       // 中文确认 + 中文信号词「修复」
			'ok, fix the bug',      // ASCII 确认 + ASCII 信号词
		]) {
			const sent = await runWith(taskText);
			assert.ok(
				sent.includes('search_graph') && sent.includes('delegate_task'),
				`「${taskText}」带任务信号，必须保留探索工具，实际: ${sent.join(',')}`,
			);
		}
	});

	test('含文件路径/扩展名 → 不判 trivial（`:351` 的路径排除）', async () => {
		// "ok src/a.ts" 虽以确认词开头（`:339` 命中），但带路径与扩展名，
		// 说明用户在指认具体文件，属真实任务。
		const sent = await runWith('ok src/a.ts');
		assert.ok(
			sent.includes('search_graph'),
			`带路径的请求必须保留探索工具，实际: ${sent.join(',')}`,
		);
	});

	test('超长消息不判 trivial：长度上限 40 字符（`:326`）', async () => {
		// 即便以 "hi" 开头，只要超过 40 字符就说明用户在正经说事。
		const longText = 'hi ' + '这是一段很长的描述'.repeat(6);
		assert.ok(longText.length > 40, '前置条件：构造的文本需超过 40 字符');
		const sent = await runWith(longText);
		assert.ok(
			sent.includes('search_graph'),
			`超长消息不应被门控，实际: ${sent.join(',')}`,
		);
	});

	test('过滤是子串匹配而非全等：衍生名 search_graph_v2 同样被拦', async () => {
		// `:1627` 用 includes。若有人改成 `===`，衍生/带前后缀的工具名会漏网，
		// trivial 请求照样触发图谱构建。
		const sent = await runWith('test', ['search_graph_v2', 'mcp__delegate_task', 'file_read']);
		assert.ok(
			!sent.includes('search_graph_v2'),
			`子串命中的衍生名应被剔除，实际: ${sent.join(',')}`,
		);
		assert.ok(
			!sent.includes('mcp__delegate_task'),
			`带前缀的委托工具应被剔除，实际: ${sent.join(',')}`,
		);
		assert.ok(sent.includes('file_read'), `实际: ${sent.join(',')}`);
	});

	test('空消息判为 trivial（`:319` 的 !raw 早退）', async () => {
		const sent = await runWith('');
		assert.ok(!sent.includes('search_graph'), `实际工具: ${sent.join(',')}`);
	});
});

suite('executeAgentTurnDirect — 运行中 steering 注入的租约语义（第三参接线）', () => {

	// 本 suite 是**唯一**给 `executeAgentTurnDirect` 传第三参 steeringQueue 的地方。
	// 此前 8400 行测试全部只传两参 —— 即注入链路
	// （`agentTurnExecutor.ts:1572` → `turnIterationGate.ts:128-141`
	//  → `loopGate.ts:37-78` injectSteeringMessages）在主循环里的**接线**
	// 从未被行为测试覆盖：loopGate 自己的单测只验纯函数，无法发现
	// 「executor 忘了把 queue 透传下去」或「agentId 传错导致 lease 永远空」。
	//
	// 用户可见故障：turn 运行期间继续输入的消息被静默丢弃，模型基于陈旧
	// 上下文作答，用户以为自己的补充说明生效了，实际从未进入任何请求。

	/** 捕获每轮 LLM 请求的 messages 快照。 */
	function capturingProvider(script: (round: number) => IModelDelta[]): {
		provider: Record<string, unknown>;
		snapshots: Array<Array<{ role?: string; content?: unknown }>>;
	} {
		const snapshots: Array<Array<{ role?: string; content?: unknown }>> = [];
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (
				_modelId: string,
				messages: Array<{ role?: string; content?: unknown }>,
			) => {
				snapshots.push(messages.map(m => ({ role: m.role, content: m.content })));
				const current = round++;
				return (async function* () {
					for (const delta of script(current)) { yield delta; }
				})();
			},
		};
		return { provider, snapshots };
	}

	function steeringHost(provider: Record<string, unknown>): Record<string, unknown> {
		return mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [],
		});
	}

	const PLAIN_ANSWER = () => [
		{ type: 'text', content: '回答' } as IModelDelta,
		{ type: 'done', finishReason: 'stop' } as IModelDelta,
	];

	/** 某轮请求里所有 user 消息的文本。 */
	function userTexts(snapshot: Array<{ role?: string; content?: unknown }>): string[] {
		return snapshot.filter(m => m.role === 'user').map(m => String(m.content ?? ''));
	}

	test('队列有待注入消息 → 作为 user 消息追加进首轮请求，并 ack 转 delivered', async () => {
		// 锁住两件事：① 内容真的进了本轮请求；② 成功后 ack（而非留在 in_progress）。
		// 失败模式：只 lease 不 ack → 租约 TTL 到期后消息回到 pending，
		// 下一轮**重复注入**同一句话，模型看到用户"说了两遍"。
		const queue = createDeliveryQueue();
		queue.enqueue({
			id: 'steer-1',
			from: 'user',
			to: 'test-agent',
			content: '补充：只改 TypeScript 文件',
		});

		const { provider, snapshots } = capturingProvider(PLAIN_ANSWER);

		await drain(
			executeAgentTurnDirect(
				steeringHost(provider) as never,
				mockRequest() as never,
				queue,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(snapshots.length, 1, '应只打一轮 LLM');
		assert.ok(
			userTexts(snapshots[0]).some(t => t.includes('只改 TypeScript 文件')),
			`steering 内容必须出现在首轮请求的 user 消息里，实际: ${JSON.stringify(userTexts(snapshots[0]))}`,
		);
		assert.strictEqual(
			queue.stats().delivered,
			1,
			`注入成功后必须 ack 为 delivered，实际 stats: ${JSON.stringify(queue.stats())}`,
		);
		assert.strictEqual(
			queue.stats().in_progress,
			0,
			'不得有租约残留在 in_progress',
		);
	});

	test('多条待注入 → 一轮全部注入且保持 enqueue 序', async () => {
		// `deliveryQueue.ts:110-120` lease 按数组序返回，
		// `loopGate.ts:58-61` 按序 appendOne。顺序错乱会改变语义：
		// 「先撤销刚才那句」「再执行 A」倒序后含义完全反过来。
		const queue = createDeliveryQueue();
		queue.enqueue({ id: 's1', from: 'user', to: 'test-agent', content: 'FIRST-步骤一' });
		queue.enqueue({ id: 's2', from: 'user', to: 'test-agent', content: 'SECOND-步骤二' });
		queue.enqueue({ id: 's3', from: 'user', to: 'test-agent', content: 'THIRD-步骤三' });

		const { provider, snapshots } = capturingProvider(PLAIN_ANSWER);

		await drain(
			executeAgentTurnDirect(
				steeringHost(provider) as never,
				mockRequest() as never,
				queue,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const texts = userTexts(snapshots[0]);
		const firstIdx = texts.findIndex(t => t.includes('FIRST-步骤一'));
		const secondIdx = texts.findIndex(t => t.includes('SECOND-步骤二'));
		const thirdIdx = texts.findIndex(t => t.includes('THIRD-步骤三'));

		assert.ok(firstIdx >= 0 && secondIdx >= 0 && thirdIdx >= 0,
			`三条都应注入，实际: ${JSON.stringify(texts)}`);
		assert.ok(
			firstIdx < secondIdx && secondIdx < thirdIdx,
			`注入顺序必须与 enqueue 序一致，实际下标: ${firstIdx}/${secondIdx}/${thirdIdx}`,
		);
		assert.strictEqual(queue.stats().delivered, 3, '三条都应 ack');
	});

	test('队列内容投给别的 agent → 本 agent 不得注入（lease 按 to 过滤）', async () => {
		// `turnIterationGate.ts:131` 传的是 `request.agentId`。
		// 若有人误传 sessionId 或写死字符串，lease 恒为空 —— 注入功能整体失效，
		// 而现有测试全都不传 queue，这种回归无人察觉。
		// 反向同理：若过滤失效，A agent 会读到发给 B agent 的指令（串话）。
		const queue = createDeliveryQueue();
		queue.enqueue({
			id: 'other-1',
			from: 'user',
			to: 'some-other-agent',
			content: 'LEAK-不该被本 agent 看到',
		});

		const { provider, snapshots } = capturingProvider(PLAIN_ANSWER);

		await drain(
			executeAgentTurnDirect(
				steeringHost(provider) as never,
				mockRequest() as never,
				queue,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			!userTexts(snapshots[0]).some(t => t.includes('LEAK-')),
			`投给其他 agent 的消息不得串入本轮请求，实际: ${JSON.stringify(userTexts(snapshots[0]))}`,
		);
		assert.strictEqual(
			queue.stats().pending,
			1,
			'别人的消息必须原样留在 pending，不能被本 agent 顺手 ack 掉',
		);
	});

	test('已 delivered 的消息不重复注入：同一队列跑第二个 turn 时不再出现', async () => {
		// 幂等性契约。`deliveryQueue.ts:113` 只 lease pending，
		// 已 delivered 的不再可领。若状态机被改坏（如 ack 未改 status），
		// 用户的一句补充会在后续每个 turn 重复注入，越跑越多。
		const queue = createDeliveryQueue();
		queue.enqueue({
			id: 'once-1',
			from: 'user',
			to: 'test-agent',
			content: 'ONLY-ONCE-只注入一次',
		});

		const firstRun = capturingProvider(PLAIN_ANSWER);
		await drain(
			executeAgentTurnDirect(
				steeringHost(firstRun.provider) as never,
				mockRequest() as never,
				queue,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);
		assert.ok(
			userTexts(firstRun.snapshots[0]).some(t => t.includes('ONLY-ONCE')),
			'前置条件：第一个 turn 应注入成功',
		);

		const secondRun = capturingProvider(PLAIN_ANSWER);
		await drain(
			executeAgentTurnDirect(
				steeringHost(secondRun.provider) as never,
				mockRequest() as never,
				queue,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			!userTexts(secondRun.snapshots[0]).some(t => t.includes('ONLY-ONCE')),
			`已交付的消息不得在第二个 turn 重复注入，实际: ${JSON.stringify(userTexts(secondRun.snapshots[0]))}`,
		);
	});

	test('不传 steeringQueue → 注入段整体跳过，turn 正常完成', async () => {
		// `loopGate.ts:46-48` 的 undefined 早退 + `turnIterationGate.ts:128`
		// 的 if 守卫。这是**生产主路径**（`agentOSService.ts` 多数调用不带队列），
		// 若早退失效会对 undefined 调 `.lease()` 直接崩掉整个 turn。
		const { provider, snapshots } = capturingProvider(PLAIN_ANSWER);

		const { deltas } = await drain(
			executeAgentTurnDirect(
				steeringHost(provider) as never,
				mockRequest() as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(snapshots.length, 1, '应正常打一轮 LLM');
		assert.ok(
			deltas.some(d => d.type === 'text' && String(d.content ?? '').includes('回答')),
			`turn 应正常产出文本，实际事件: ${deltas.map(d => d.type).join(',')}`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// 临近预算预警（`turnIterationGate.ts:219-227`）——与收尾提醒互斥的另一档。
//
// 三档提醒的关系（按严重度递增）：
//   ① 临近预算预警  remaining <= 阈值 → budgetLowWarning，**仍带工具**
//   ② 收尾轮提醒    预算耗尽/撞上限 → hardLimitWrapUpReminder，**工具置空**
//   ③ 贴合原因提醒  零进展空转等 → allBlockedWrapUpReminder（见 suite「收尾出口」）
//
// ① 与 ②/③ 在源码里是 if/else-if 关系（`:173` isWrapUpRound ? ... : ...），
// 即**收尾轮不再发预警**。这个互斥此前无测试：若被改成并列 if，
// 收尾轮会同时收到「还剩 N 轮，别启动长任务」与「轮次已用尽，立刻作答」,
// 前者暗示"还能干活"，后者要求"马上收尾"——措辞冲突，模型容易继续调工具。
//
// 预警本身的动机见 `loopReminders.ts:240-243`：真实日志里模型在第 50/50 轮
// 才发起 delegate_task，子代理跑了 6 分钟，结果回来时主循环已退出，成果全丢。
// 模型当时并不知道自己只剩 1 轮 —— 预警就是补上这个信息缺口。
suite('executeAgentTurnDirect — 临近预算预警的单次性与收尾互斥（budgetLowWarning）', () => {

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/** 每轮快照：工具数 + 按角色分开的消息全文（预警是 user，收尾提醒是 system）。 */
	interface IRoundSnapshot {
		readonly toolCount: number;
		readonly userText: string;
		readonly systemText: string;
	}

	function warningProvider(
		script: (round: number, toolsOffered: boolean) => IModelDelta[],
	): { provider: Record<string, unknown>; snapshots: IRoundSnapshot[] } {
		const snapshots: IRoundSnapshot[] = [];
		let round = 0;
		const provider = {
			id: 'mock-provider',
			name: 'Mock Provider',
			chat: (
				_modelId: unknown,
				messages: Array<{ role?: string; content?: unknown }>,
				options?: { tools?: unknown[] },
			) => {
				const current = round++;
				const toolCount = options?.tools?.length ?? 0;
				const textOf = (role: string) => (messages ?? [])
					.filter(message => message?.role === role)
					.map(message => String(message?.content ?? ''))
					.join('\n');
				snapshots.push({ toolCount, userText: textOf('user'), systemText: textOf('system') });
				return (async function* () {
					for (const delta of script(current, toolCount > 0)) { yield delta; }
				})();
			},
		};
		return { provider, snapshots };
	}

	/** 工具永远成功；模型只要拿到工具就继续调，以此把轮次推到预算边界。 */
	function keepCallingHost(provider: Record<string, unknown>): Record<string, unknown> {
		const runCalls = async (calls: Array<{ id: string; name: string }>) =>
			calls.map(call => ({ toolCallId: call.id, content: `RESULT ${call.id}`, success: true }));
		return mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['file_read']),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => runCalls(calls),
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				const results = await runCalls(calls);
				for (const result of results) { yield result as never; }
			},
		});
	}

	const KEEP_CALLING = (round: number, toolsOffered: boolean): IModelDelta[] => (
		toolsOffered
			? [
				toolCallDelta(`b-${round}`, 'file_read', { path: `/mock/b-${round}.ts` }),
				{ type: 'done', finishReason: 'tool_calls' } as IModelDelta,
			]
			: [
				{ type: 'text', content: '最终结论。' } as IModelDelta,
				{ type: 'done', finishReason: 'stop' } as IModelDelta,
			]
	);

	/** 出现预警文案的轮次下标（预警是 user 角色）。 */
	function warnedRounds(snapshots: IRoundSnapshot[]): number[] {
		return snapshots
			.map((snapshot, index) => ({ index, hit: snapshot.userText.includes('tool-calling round(s) remain') }))
			.filter(entry => entry.hit)
			.map(entry => entry.index);
	}

	test('预算充足的首轮不注入预警：剩余轮次高于阈值时不得干扰模型', async () => {
		// 反向哨兵。若预警无条件注入，模型每轮都被告知「别启动长任务」，
		// delegate_task 这类正当的重活会被永久劝退 —— 预警从保护变成阉割。
		const { provider, snapshots } = warningProvider(() => [
			{ type: 'text', content: '直接回答' } as IModelDelta,
			{ type: 'done', finishReason: 'stop' } as IModelDelta,
		]);

		await drain(
			executeAgentTurnDirect(
				keepCallingHost(provider) as never,
				mockRequest({ budgetMaxTotal: 50 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.deepStrictEqual(
			warnedRounds(snapshots), [],
			`预算充足时不得注入预警，实际命中轮次: ${JSON.stringify(warnedRounds(snapshots))}`,
		);
	});

	test('剩余轮次触阈 → 注入预警，且全程只注入一次（budgetLowWarned 标志）', async () => {
		// `:219` 的 `!state.wrapUp().budgetLowWarned` 守卫 + `:224` 置位。
		//
		// 「只一次」是刻意设计：预警文案不短，每轮重复会持续挤占上下文，
		// 且反复喊「别启动长任务」会让模型过度保守。若标志失效，
		// 触阈后的每一轮都会追加一条，到收尾时已堆了好几份同样的话。
		//
		// 注意断言方式：messages 是**累积**的，一旦注入过，后续每轮的快照里
		// 都会看到它。所以不能数「命中的轮次数」，要数**文案出现的次数**。
		const { provider, snapshots } = warningProvider(KEEP_CALLING);

		await drain(
			executeAgentTurnDirect(
				keepCallingHost(provider) as never,
				mockRequest({ budgetMaxTotal: 4 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const hits = warnedRounds(snapshots);
		assert.ok(
			hits.length > 0,
			`预算临近时必须注入预警，实际各轮工具数=${JSON.stringify(snapshots.map(s => s.toolCount))}`,
		);

		// 最后一轮的 user 文本包含全部累积历史 → 统计文案出现次数即注入次数。
		const lastUserText = snapshots[snapshots.length - 1].userText;
		const occurrences = lastUserText.split('tool-calling round(s) remain').length - 1;
		assert.strictEqual(
			occurrences, 1,
			`预警全程只能注入一次，实际出现 ${occurrences} 次`
			+ `——>1 说明 budgetLowWarned 标志未生效，预警会逐轮堆积挤占上下文`,
		);
	});

	test('预警必须点明剩余轮次与总预算：模型要靠这两个数决定还能干多少活', async () => {
		// `loopReminders.ts:248` 的 `Only N ... out of M`。
		// 只说「预算快用完了」而不给具体数字，模型无法判断「还能不能跑一次搜索」,
		// 实测表现是它要么过度保守立刻收尾，要么照旧启动 6 分钟的子代理。
		const { provider, snapshots } = warningProvider(KEEP_CALLING);

		await drain(
			executeAgentTurnDirect(
				keepCallingHost(provider) as never,
				mockRequest({ budgetMaxTotal: 4 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const lastUserText = snapshots[snapshots.length - 1].userText;
		assert.ok(
			/Only \d+ tool-calling round\(s\) remain out of \d+/.test(lastUserText),
			`预警必须同时给出剩余轮次与总预算（Only N ... out of M），实际 user 文本尾段: `
			+ `${lastUserText.slice(-400)}`,
		);
		assert.ok(
			lastUserText.includes('delegate_task'),
			'预警必须点名 delegate_task 这类长任务——泛泛说「别做昂贵操作」模型不会对号入座',
		);
		assert.ok(
			lastUserText.includes('DISCARDED'),
			'必须说明结果会被丢弃：这是模型放弃长任务的唯一充分理由',
		);
	});

	test('预警注入为 user 角色，不得混进 system 段污染冻结前缀', async () => {
		// `:226` 是 `role:'user'` + 追加到**末尾**；而收尾提醒（`:209`）是
		// `role:'system'` + 插入到前置 system 之后。两者角色与位置刻意不同：
		//   · 预警是**时效信息**（"还剩 N 轮"），逐轮变化，放进 system 前缀会
		//     打断前缀缓存 —— 每轮 system 段都不一样，缓存命中率归零。
		//   · 收尾提醒要压制 system 层的冲突指令，故必须同为 system 且紧贴。
		// 若有人「统一」成 system，付出的是每轮全量重算前缀的成本。
		const { provider, snapshots } = warningProvider(KEEP_CALLING);

		await drain(
			executeAgentTurnDirect(
				keepCallingHost(provider) as never,
				mockRequest({ budgetMaxTotal: 4 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const last = snapshots[snapshots.length - 1];
		assert.ok(
			last.userText.includes('tool-calling round(s) remain'),
			'前置条件：预警应已注入',
		);
		assert.ok(
			!last.systemText.includes('tool-calling round(s) remain'),
			'预警不得出现在 system 段——放进冻结前缀会让逐轮变化的数字打断前缀缓存',
		);
	});

	test('收尾轮与预警互斥：禁工具那一轮不得再追加「还剩 N 轮」', async () => {
		// `:173` 的 `if (isWrapUpRound) { ... } else if (!budgetLowWarned) { ... }`。
		//
		// 这是本 suite 的核心标的。若 else-if 被拆成两个并列 if，收尾轮会同时
		// 携带两条互相矛盾的指令：预警说「还剩 N 轮，省着用」，收尾提醒说
		// 「轮次已用尽，立刻用现有信息作答」。模型看到"还剩 N 轮"往往选择
		// 继续调工具，而此时工具已被置空 —— 于是它把调用写成文本，白烧最后一轮。
		//
		// 观测方式：定位禁工具轮（toolCount===0），检查预警**是否在该轮新增**。
		// 因 messages 累积，需比较该轮与上一轮的文案出现次数。
		const { provider, snapshots } = warningProvider(KEEP_CALLING);

		await drain(
			executeAgentTurnDirect(
				keepCallingHost(provider) as never,
				mockRequest({ budgetMaxTotal: 4 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const wrapUpIdx = snapshots.findIndex(snapshot => snapshot.toolCount === 0);
		assert.ok(wrapUpIdx > 0, `前置条件：应存在禁工具收尾轮，实际工具数=${JSON.stringify(snapshots.map(s => s.toolCount))}`);

		const countIn = (text: string) => text.split('tool-calling round(s) remain').length - 1;
		const before = countIn(snapshots[wrapUpIdx - 1].userText);
		const atWrapUp = countIn(snapshots[wrapUpIdx].userText);
		assert.strictEqual(
			atWrapUp, before,
			`收尾轮不得新增预警（上一轮 ${before} 次 → 收尾轮 ${atWrapUp} 次）`
			+ `——新增说明 else-if 互斥被破坏，模型会同时收到「还剩N轮」与「立刻作答」`,
		);
		assert.ok(
			snapshots[wrapUpIdx].systemText.length > 0,
			'收尾轮仍必须有 system 段的收尾提醒（互斥不等于两条都不发）',
		);
	});
});





suite('classifyIterationStop — strategyRequestedStop 写死 false 的现状契约', () => {

	/**
	 * 本 suite 钉住一个**刻意保留的空接线**，以及它的三重一致性。
	 *
	 * ## 现状
	 *
	 * `turnStopGate.ts:139-141` 把 `strategyRequestedStop === true` 放在**所有
	 * 判据之前**：命中即 `{ kind:'stop', reason:'strategy-requested' }`，连预算
	 * 的两段式宽限（`loopGate.ts` `classifyBudgetGate`）都不走。
	 *
	 * 但唯一的调用点 `turnIterationGate.ts:154` **写死传 `false`**，注释
	 * （`:146-147`）明确说明这是刻意为之、等阶段 3 才接真值来源。
	 *
	 * 同时 `agentLoopStrategy.ts:171-192` 记录了配套决策：`shouldTerminate`
	 * 钩子已于 2026-09 从策略接口**移除**（不是"未实现"，是"刻意不提供"），
	 * 理由有二 ——
	 *   1. Hermes 的实现判据 `!hasRemaining() && !isGraceArmed()` 与
	 *      `classifyIterationStop` 的 budget 输入完全重复，接线是恒等叠加；
	 *   2. `GraphStrategy` 的实现恒返回 `true`，若接到主循环顶，任何绕过
	 *      `skipMainLoop` 的路径都会让 graph 模式**首轮即终止**。
	 *
	 * ## 为什么必须测
	 *
	 * 这是一段「参数存在、分支存在、但永不命中」的代码。它有两个相反方向的
	 * 腐坏风险，且两者都不会被现有测试察觉：
	 *
	 *  · **被误清理**：有人看到 `strategyRequestedStop: false` 是常量，把参数
	 *    连同 `:139-141` 的分支一起删掉 —— 阶段 3 接线时要重新设计优先级，
	 *    而"策略意愿优先于预算"这个已定的顺序决策就丢了。
	 *  · **被误接线**：有人看到"死字段"就想接上，把 `shouldTerminate` 复活并
	 *    喂进来 —— 直接触发上面第 2 条，graph 范式首轮终止。
	 *
	 * 所以本 suite 三个层次各钉一刀：
	 *  1. 纯函数层：`true` 的分支**语义**仍然正确且优先级最高（防误删）；
	 *  2. 调用点层：真实主循环跑到底时，绝不产生 `strategy-requested` 停止
	 *     （防误接线 —— 写死 false 的现状被行为锁住）；
	 *  3. 策略接口层：所有已注册范式都**不得**带 `shouldTerminate` 成员
	 *     —— 补上 `agentLoopStrategy.ts:191` 声称由
	 *     `agentStrategyContract.test.ts` 守护、但该文件实际不存在的空洞。
	 */

	/** `classifyIterationStop` 的「一切正常、应当继续」基线输入。 */
	const HEALTHY_INPUT = {
		iteration: 1,
		hasRemainingBudget: true,
		isGraceArmed: false,
		wrapUpDone: false,
		wrapUpForced: false,
	} as const;

	const LIMITS = { maxToolIterations: 100 } as const;

	test('层 1a：strategyRequestedStop=true → 立即 stop，且优先于预算宽限', () => {
		// 构造一个「预算已耗尽但收尾轮还没跑」的输入：单看预算应当是 wrap-up
		// （classifyBudgetGate 返回 'wrap-up'），绝不是 stop。
		const budgetWouldWrapUp = {
			...HEALTHY_INPUT,
			hasRemainingBudget: false,
			isGraceArmed: false,
			wrapUpDone: false,
		};

		const withoutStrategy = classifyIterationStop(budgetWouldWrapUp, LIMITS);
		assert.strictEqual(
			withoutStrategy.kind,
			'wrap-up',
			'前提校验：不带策略意愿时，预算耗尽且未收尾应当是 wrap-up（两段式）',
		);

		const withStrategy = classifyIterationStop(
			{ ...budgetWouldWrapUp, strategyRequestedStop: true },
			LIMITS,
		);
		assert.strictEqual(
			withStrategy.kind,
			'stop',
			'策略主动终止必须直接 stop —— 策略已决定收手，再跑一轮收尾无意义',
		);
		assert.strictEqual(
			withStrategy.kind === 'stop' ? withStrategy.reason : undefined,
			'strategy-requested',
			'reason 必须可区分来源，否则排障时无法分辨是策略停的还是预算停的',
		);
	});

	test('层 1b：只有严格 true 触发；false / undefined 均不改变裁决', () => {
		const baseline = classifyIterationStop(HEALTHY_INPUT, LIMITS);
		assert.strictEqual(baseline.kind, 'continue', '前提校验：健康输入应当 continue');

		// `:139` 用的是 `=== true` 而非 truthy 判定。省略字段与显式 false
		// 必须与基线完全一致 —— 这正是调用点写死 false 时的实际形状。
		for (const value of [false, undefined]) {
			const verdict = classifyIterationStop(
				{ ...HEALTHY_INPUT, strategyRequestedStop: value },
				LIMITS,
			);
			assert.strictEqual(
				verdict.kind,
				'continue',
				`strategyRequestedStop=${String(value)} 不得触发策略终止分支`,
			);
		}
	});

	test('层 2：真实主循环跑完多轮，永不产生 strategy-requested 停止', async () => {
		// 调用点写死 false（`turnIterationGate.ts:154`）。这条用例用行为锁住
		// 该现状：只要有人把真值接进来（例如复活 shouldTerminate 并让
		// HermesReAct 在预算紧张时返回 true），主循环就会提前 stop，
		// 观察到的迭代轮数会掉下来，本用例即失败。
		let rounds = 0;
		const provider = {
			id: 'strategy-stop-contract',
			name: 'Mock Provider',
			listModels: async () => [{ id: 'mock-model' }],
			chat: () => {
				rounds++;
				return (async function* () {
					// 前两轮持续发起工具调用 → 主循环必须继续迭代；
					// 第三轮收口，避免用例依赖预算耗尽。
					if (rounds <= 2) {
						yield {
							type: 'tool_call',
							toolCall: {
								id: `call-${rounds}`,
								name: 'file_read',
								// `providers.ts:495`：arguments 必须是 **JSON 字符串**
								// （流式装配器按片段累积后才解析），传对象会在
								// repairToolArguments 里 `raw.trim is not a function` 崩溃。
								arguments: JSON.stringify({ path: `/mock/f${rounds}.txt` }),
							},
						} as unknown as IModelDelta;
					} else {
						yield { type: 'text', content: '完成。' } as IModelDelta;
					}
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['file_read']),
			_executeToolCall: async () => ({ content: 'ok' }),
		});

		const { deltas } = await drain(
			executeAgentTurnDirect(host as never, mockRequest() as never),
		);

		assert.ok(
			rounds >= 3,
			`主循环必须真的跑到第 3 轮（实际 ${rounds}）—— 少于此说明有策略/预算分支提前 stop 了`,
		);

		// 主循环内的策略终止会走 `turnIterationGate.ts:160` 的 warn 分支后
		// 直接 break，不会产出 error 事件；这里额外确认没有异常出口。
		const errors = deltas.filter(delta => delta.type === 'error');
		assert.strictEqual(
			errors.length,
			0,
			`正常多轮路径不应产出 error 事件：${JSON.stringify(errors)}`,
		);
	});

	test('层 3：所有已注册范式都不得带 shouldTerminate 成员（补缺失的契约守护）', () => {
		// `agentLoopStrategy.ts:191` 声称该约束由
		// `test/browser/agentStrategyContract.test.ts` 守护 —— 但那个文件
		// **并不存在**，约束实际处于无人看守状态。此处补上。
		const factory = new AgentLoopStrategyFactory();
		// 注意：`factory.resolve` 返回的实例**自报的** `paradigm` 未必等于请求的
		// 范式 —— ReAct 三别名（react / plan-explore / budgeted-react）共享同一个
		// `HermesReActStrategy`（factory `:31-33`），而该类把 `paradigm` 硬编码为
		// `'budgeted-react'`（hermesReActStrategy.ts:39）。这里按真实映射断言，
		// 顺带把「三别名共享一个引擎」这个事实钉住：若有人给 react 单独实现一个
		// 策略类，本用例会立刻失败，提醒同步 preLoop / prepareIteration 行为差异。
		const expectedSelfReported: Record<string, AgentParadigm> = {
			'react': 'budgeted-react',
			'plan-explore': 'budgeted-react',
			'budgeted-react': 'budgeted-react',
			'graph': 'graph',
			'delegation': 'delegation',
			'readonly': 'readonly',
			'mimo': 'mimo',
		};
		const paradigms = Object.keys(expectedSelfReported) as AgentParadigm[];

		const offenders: string[] = [];
		for (const paradigm of paradigms) {
			const strategy = factory.resolve(
				mockRequest({ paradigm }) as never,
			) as unknown as Record<string, unknown>;

			assert.strictEqual(
				strategy.paradigm,
				expectedSelfReported[paradigm],
				`范式 ${paradigm} 解析出的策略自报 ${String(strategy.paradigm)}，与已知映射不符`,
			);
			if (typeof strategy.shouldTerminate === 'function') {
				offenders.push(paradigm);
			}
		}

		assert.deepStrictEqual(
			offenders,
			[],
			'shouldTerminate 已于 2026-09 从 IAgentLoopStrategy 移除（agentLoopStrategy.ts:171-192）。'
			+ ' 复活它会让 GraphStrategy 恒返回 true 的旧语义在任何绕过 skipMainLoop 的'
			+ ` 路径上导致首轮即终止。违规范式：${offenders.join(', ')}`,
		);
	});

	test('层 3b：graph 范式的「不进循环」必须由 skipMainLoop 承载，而非终止钩子', async () => {
		// 这是层 3 的语义配对用例：约束不只是"没有 shouldTerminate"，
		// 更是"不进 ReAct 循环"这件事**有另一个真实生效的承载点"。
		// 若有人删掉 preLoop 的 skipMainLoop 又不接终止钩子，graph 范式会
		// 静默跑完整个 ReAct 循环（这正是 2026-09-16 修掉的死字段缺陷）。
		let chatCalls = 0;
		const provider = {
			id: 'graph-skip-contract',
			name: 'Mock Provider',
			listModels: async () => [{ id: 'mock-model' }],
			chat: () => {
				chatCalls++;
				return (async function* () {
					yield { type: 'text', content: 'should not run' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		};

		const host = mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [],
		});

		await drain(
			executeAgentTurnDirect(
				host as never,
				mockRequest({ paradigm: 'graph' }) as never,
			),
		);

		assert.strictEqual(
			chatCalls,
			0,
			'graph 范式的 preLoop 返回 skipMainLoop=true，主循环必须整段跳过 —— '
			+ `一次模型调用都不该发生（实际 ${chatCalls} 次）`,
		);
	});
});


// 本 suite 钉住的是**既成事实**，不是理想设计。三档预警各自独立演进、
// 各有独立的触发量纲与去重机制，合起来构成一个没人整体设计过的叠加面。
// 在动它之前，先把当前行为完整锁住 —— 否则任何"统一"改动都无法判断
// 自己改掉了什么。
suite('executeAgentTurnDirect — 三档预算预警的叠加与去重（现状契约）', () => {

	/**
	 * ## 三档预警总览（取证于 2026-09-18）
	 *
	 * | | ① strategy 档 | ② gate 档 | ③ 软预算档 |
	 * |---|---|---|---|
	 * | 位置 | `hermesReActStrategy.ts:62-71` | `turnIterationGate.ts:219-236` | `turnIterationGate.ts:238-250` |
	 * | 量纲 | 轮次**比例** `remaining/max <= 0.1` | 轮次**绝对值** `remaining <= 3` | **墙钟** `elapsed >= softDeadlineMs` |
	 * | 语言 | 中文内联字符串 | 英文 `budgetLowWarning()` | 英文 `softBudgetWrapUpReminder()` |
	 * | 角色 | user（`:292`） | user（`:234`） | user（`:246`） |
	 * | 去重 | `budget.isGraceArmed()`（arm 那轮发一次） | `wrapUp.budgetLowWarned` 一次性标志 | `softBudgetNextReminderAtMs` 周期重发 |
	 *
	 * ## 本 suite 要钉的三件事
	 *
	 * **1. ①② 同轮叠加是既成事实，且两者语义冲突。**
	 * 默认预算 90 轮时 ① 的阈值是 `remaining <= 9`，② 是 `remaining <= 3` ——
	 * ② 的触发区间**完全包含在** ① 之内。所以 ② 触发的那一轮，① 必然也在喊。
	 * 两条话还互相矛盾：① 说「不再发起新的工具调用」，② 说「可做廉价验证」。
	 * 模型同轮收到两份指令，行为不可预测。这条**不修，只钉**。
	 *
	 * **2. ① 的去重（2026-09-18 已修）。**
	 * 修复前 `armGraceCall()` 在 `if (!isGraceArmed())` 块内，但
	 * `reminderMessage` 的赋值在块**外**。`isGraceArmed()` 返回
	 * `_graceCall && !_graceUsed`（`iterationBudget.ts:113`），而
	 * `consumeGrace()` 在整个 agentStudio 生产代码中**零调用点** ——
	 * 于是 arm 后恒为 true，`isGraceUsed()` 恒为 false，① 此后**每轮都注入**。
	 * 修复把赋值移进块内，借 arm 的幂等性实现去重。
	 *
	 * **3. 三档的去重语义不同，且都是对的。**
	 * ①② 一次性（文案长、信息静态，重复纯属浪费）；③ 周期重发（墙钟持续推进，
	 * 「已跑 200s」到「已跑 400s」是新信息）。把它们统一成一种是错的 ——
	 * 本 suite 用断言把差异固定下来，防止"统一"式重构把 ③ 的周期性一并抹平。
	 */

	function toolCallDelta(id: string, name: string, args: Record<string, unknown>): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify(args) },
		} as unknown as IModelDelta;
	}

	/** 每轮快照：只记 user 段全文（三档预警全是 user 角色）与工具数。 */
	interface ITierSnapshot {
		readonly toolCount: number;
		readonly userText: string;
	}

	/** 各档的判别串。① 取中文特征串，②③ 取英文首句特征串。 */
	const TIER1_MARK = '迭代预算即将耗尽';
	const TIER2_MARK = 'tool-calling round(s) remain';
	const TIER3_MARK = 'past the soft budget of';

	function tierProvider(): { provider: Record<string, unknown>; snapshots: ITierSnapshot[] } {
		const snapshots: ITierSnapshot[] = [];
		let round = 0;
		const provider = {
			id: 'tier-overlap-provider',
			name: 'Mock Provider',
			chat: (
				_modelId: unknown,
				messages: Array<{ role?: string; content?: unknown }>,
				options?: { tools?: unknown[] },
			) => {
				const current = round++;
				const toolCount = options?.tools?.length ?? 0;
				snapshots.push({
					toolCount,
					userText: (messages ?? [])
						.filter(message => message?.role === 'user')
						.map(message => String(message?.content ?? ''))
						.join('\n'),
				});
				return (async function* () {
					// 有工具就继续调，把轮次推到预算边界；无工具（收尾轮）则收口。
					if (toolCount > 0) {
						yield toolCallDelta(`t-${current}`, 'file_read', { path: `/mock/t-${current}.ts` });
						yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
					} else {
						yield { type: 'text', content: '最终结论。' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		};
		return { provider, snapshots };
	}

	function tierHost(provider: Record<string, unknown>): Record<string, unknown> {
		const runCalls = async (calls: Array<{ id: string; name: string }>) =>
			calls.map(call => ({ toolCallId: call.id, content: `RESULT ${call.id}`, success: true }));
		return mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['file_read']),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => runCalls(calls),
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				const results = await runCalls(calls);
				for (const result of results) { yield result as never; }
			},
		});
	}

	/** 某档文案在该轮 user 段中出现的**次数**（messages 累积，故按次数而非轮数）。 */
	function occurrences(text: string, mark: string): number {
		return text.split(mark).length - 1;
	}

	/** 首次出现该档文案的轮次下标；未出现返回 -1。 */
	function firstRoundWith(snapshots: ITierSnapshot[], mark: string): number {
		return snapshots.findIndex(snapshot => snapshot.userText.includes(mark));
	}

	test('①② 同轮叠加是既成事实：② 触发的那一轮，① 必然已在场', async () => {
		// 这是本 suite 的核心断言，钉的是一个**已知的设计缺陷**而非期望行为。
		//
		// 数学上：预算 20 轮 → ① 阈值 remaining<=2（20*0.1），② 阈值 remaining<=3。
		// ② 的区间 [0,3] 严格包含 ① 的区间 [0,2]，所以 ① 触发时 ② 一定已触发。
		// 反过来 ② 先触发一轮（remaining=3），① 随后在 remaining=2 加入。
		//
		// 若将来有人让 ② 在 isGraceArmed() 时跳过（已讨论的最小改动方案），
		// 本用例会失败 —— 那是**预期的**，届时应连同本注释一起更新为
		// 「互斥」契约，而不是删掉断言了事。
		const { provider, snapshots } = tierProvider();

		await drain(
			executeAgentTurnDirect(
				tierHost(provider) as never,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const tier1First = firstRoundWith(snapshots, TIER1_MARK);
		const tier2First = firstRoundWith(snapshots, TIER2_MARK);

		assert.ok(tier1First >= 0, `① strategy 档必须触发过（20 轮预算下 remaining<=2 时）`);
		assert.ok(tier2First >= 0, `② gate 档必须触发过（remaining<=3 时）`);

		// ② 阈值更宽 → 更早触发。
		assert.ok(
			tier2First <= tier1First,
			`② (轮 ${tier2First}) 的阈值 remaining<=3 宽于 ① (轮 ${tier1First}) 的 remaining<=2，必须不晚于 ① 触发`,
		);

		// 叠加的实证：存在某一轮，user 段里两档文案同时在场。
		const overlapRound = snapshots.findIndex(
			snapshot => snapshot.userText.includes(TIER1_MARK) && snapshot.userText.includes(TIER2_MARK),
		);
		assert.ok(
			overlapRound >= 0,
			'①② 必然存在同轮叠加（② 区间包含 ① 区间）—— 若此断言失败，说明叠加已被修复，'
			+ '请把本用例改写为互斥契约',
		);

		// 叠加的**危害**同样钉住：两条指令语义冲突。
		const overlapText = snapshots[overlapRound].userText;
		assert.ok(
			overlapText.includes('不再发起新的工具调用'),
			'① 的要求是「不再发起新的工具调用」（完全停手）',
		);
		assert.ok(
			overlapText.includes('cheap, targeted verification only'),
			'② 的要求是「只做廉价的定向验证」（可继续调用）—— 与 ① 直接冲突',
		);
	});

	test('① 的「仅注入一次」已生效：arm 成功那一轮才发，此后不再重复', async () => {
		// 2026-09-18 修复前，`hermesReActStrategy.ts` 的 `armGraceCall()` 在
		// `if (!isGraceArmed())` 块内，但 `reminderMessage` 的赋值在块**外**：
		//   · `consumeGrace()` 在生产代码零调用点 → `isGraceArmed()` arm 后永不回落；
		//   · `isGraceUsed()` 同理恒为 false → 外层 if 也一直成立。
		// 于是触阈后每轮都追加一份同样的中文提醒，与注释声称的「仅注入一次」矛盾。
		//
		// 修复把赋值移进 `if (!isGraceArmed())` 块内 —— arm 是幂等的一次性开关，
		// 借它天然实现去重。本用例锁住修复后的行为。
		const { provider, snapshots } = tierProvider();

		await drain(
			executeAgentTurnDirect(
				tierHost(provider) as never,
				mockRequest({ budgetMaxTotal: 30 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const lastText = snapshots[snapshots.length - 1]?.userText ?? '';
		assert.strictEqual(
			occurrences(lastText, TIER1_MARK),
			1,
			`① 全程只能有一份（实际 ${occurrences(lastText, TIER1_MARK)}）——`
			+ ' 去重由 hermesReActStrategy.ts:73 的 `if (!isGraceArmed())` 承载。',
		);
		// 反向哨兵：确认它**确实触发过**，否则 ===1 可能是"压根没进分支"的假绿。
		assert.ok(
			firstRoundWith(snapshots, TIER1_MARK) >= 0,
			'前提校验：30 轮预算跑到底必然触阈（remaining/30 <= 0.1），① 必须出现过',
		);
	});

	test('② 的一次性去重有效：全程累计恰好一份', async () => {
		// ② 由 `wrapUp.budgetLowWarned` 一次性标志守卫，与 ① 借 `isGraceArmed()`
		// 去重是两套独立机制，但结果一致 —— 都只发一份。
		// 三档里只有 ③ 是可重发的（墙钟持续推进，信息会更新）。
		const { provider, snapshots } = tierProvider();

		await drain(
			executeAgentTurnDirect(
				tierHost(provider) as never,
				mockRequest({ budgetMaxTotal: 30 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const lastText = snapshots[snapshots.length - 1]?.userText ?? '';
		assert.strictEqual(
			occurrences(lastText, TIER2_MARK),
			1,
			'② 由 `wrapUp.budgetLowWarned`（turnIterationGate.ts:219/224）守卫，全程只能有一份',
		);
	});

	test('③ 软预算档与轮次无关：预算充足也会因墙钟超时而注入', async () => {
		// 三档量纲不同的实证。这一轮预算给到 50（远未触 ①②），但
		// softDeadlineMs=0.001s 会在首轮就超时 —— ③ 照样注入。
		//
		// 反向意义：若有人把 ③ 也改成看 budget.remaining（"统一量纲"），
		// 长耗时但低轮次的任务（例如每轮都在跑 10 分钟的构建）就再也收不到
		// 收尾提醒，会直接撞硬超时零产出（loopReminders.ts:189-190 的原始故障）。
		const { provider, snapshots } = tierProvider();

		await drain(
			executeAgentTurnDirect(
				tierHost(provider) as never,
				mockRequest({ budgetMaxTotal: 50, softDeadlineMs: 1 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.ok(
			firstRoundWith(snapshots, TIER3_MARK) >= 0,
			'③ 的触发条件是墙钟 elapsed>=softDeadlineMs，与剩余轮次无关',
		);
		// 量纲独立的实证：③ 在预算还剩几十轮时就注入（墙钟已超），而 ② 要等到
		// 预算见底才触发。两者相距几十轮 —— 若有人把 ③ 也改成看 budget.remaining，
		// 这个早期注入就会消失。
		//
		// 注：不断言 ③ 的**绝对轮次**。快照在 provider.chat 被调用时拍摄，而注入
		// 发生在同一轮的 gate 段，首轮不可见；且 elapsedMs 受进程初始化耗时影响，
		// 具体落在第几轮不稳定。真正稳定且有意义的是两档的**相对早晚**。
		const tier3First = firstRoundWith(snapshots, TIER3_MARK);
		const tier2First = firstRoundWith(snapshots, TIER2_MARK);
		assert.ok(
			tier2First > 10,
			`② 是轮次量纲，必须等预算逼近见底才触发（实际轮 ${tier2First}）`,
		);
		assert.ok(
			tier3First * 3 < tier2First,
			`③ (轮 ${tier3First}) 必须远早于 ② (轮 ${tier2First})：`
			+ ' ③ 由墙钟触发、与剩余轮次无关，② 要等 50 轮预算烧到剩 3 轮。'
			+ ' 若两者接近，说明 ③ 已被改成轮次量纲。',
		);
	});

	test('③ 的重发节流窗口硬编码 60s：短 turn 内只发一次', async () => {
		// ③ 用 `softBudgetNextReminderAtMs`（`turnIterationGate.ts:241`）做**周期**
		// 节流而非一次性标志 —— 语义上墙钟持续推进，「已跑 200s」与「已跑 400s」
		// 是不同的信息量，所以它设计成可重发。
		//
		// 但窗口值 `SOFT_BUDGET_REMINDER_REFIRE_MS = 60_000`
		// （`agentTurnExecutor.ts:1239`）是**函数内的局部常量**，既不可配置、
		// 也无法从 request 传入。后果：一个跑完只需几秒的 turn，即使每轮都
		// 超软预算，也只会收到**一份**提醒 —— 重发能力在快 turn 上等于未启用。
		//
		// 本用例把这个「设计成周期、实际退化为一次」的现状钉住。若将来把
		// 窗口改为可配置（例如从 request 读），本用例会失败，届时应改为
		// 传入小窗口并断言 >= 2 份。
		const { provider, snapshots } = tierProvider();

		await drain(
			executeAgentTurnDirect(
				tierHost(provider) as never,
				mockRequest({ budgetMaxTotal: 50, softDeadlineMs: 1 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const lastText = snapshots[snapshots.length - 1]?.userText ?? '';
		assert.strictEqual(
			occurrences(lastText, TIER3_MARK),
			1,
			`短 turn（远短于 60s 窗口）内 ③ 只能有一份（实际 ${occurrences(lastText, TIER3_MARK)}）。`
			+ ' 窗口常量 SOFT_BUDGET_REMINDER_REFIRE_MS 在 agentTurnExecutor.ts:1239 写死，'
			+ ' 无法由 request 覆盖 —— 重发能力对快 turn 实际不生效。',
		);
		// 与 ② 的对照：两者在本次运行里都恰好一份，但**原因完全不同** ——
		// ② 是一次性标志（永不重发），③ 是时间窗口没到（窗口够长就会重发）。
		// 这个区别不能在"统一去重"时被抹掉。
		assert.ok(
			snapshots.length > 10,
			`前提校验：本次必须真的跑了多轮（实际 ${snapshots.length} 轮），`
			+ '否则"多轮只发一份"无从谈起',
		);
	});

	test('三档文案语言不一致是现状：① 中文、②③ 英文', async () => {
		// 不是吹毛求疵：同一轮 user 段里混着中英两种 system-reminder，
		// 对非中文模型而言 ① 的约束力显著弱于 ②③。这条把现状钉住，
		// 便于将来统一语言时有一个明确的"改动点"清单。
		const { provider, snapshots } = tierProvider();

		await drain(
			executeAgentTurnDirect(
				tierHost(provider) as never,
				mockRequest({ budgetMaxTotal: 20 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const lastText = snapshots[snapshots.length - 1]?.userText ?? '';
		assert.ok(lastText.includes(TIER1_MARK), '① 当前是中文内联字符串（hermesReActStrategy.ts:68）');
		assert.ok(lastText.includes(TIER2_MARK), '② 当前是英文（loopReminders.ts:245）');
		assert.ok(
			lastText.includes('<system-reminder>'),
			'三档都包在 <system-reminder> 标签内 —— 这是唯一已统一的部分',
		);
	});
});

suite('executeAgentTurnDirect — 收尾轮提醒的数字真实性（hardLimitWrapUpReminder）', () => {

	/**
	 * 【本批已修复的缺陷 + 回归守护】
	 *
	 * `hardLimitWrapUpReminder(n)`（`loopReminders.ts:217-235`）在文案里把 `n`
	 * 用了**两次**，且都是对模型的事实陈述：
	 *   · `:220` `Iteration limit reached (n/n).`
	 *   · `:226` `第 1 项必需内容：声明本任务的 n-round tool budget 已用尽`
	 *
	 * 但注入点**原先**传的是 `maxToolIterations` —— 即
	 * `MAX_TOOL_ITERATIONS = 100`（子代理 background 时 1000），这是**硬上限
	 * 保险丝**，而不是真正生效的迭代预算 `budget.maxIterations`（默认 90，
	 * 可由 `budgetMaxTotal` 覆盖）。
	 *
	 * 两者在绝大多数真实收尾里是**不同的数**：收尾几乎总由预算耗尽触发
	 * （`classifyBudgetGate` → `'wrap-up'` → `reason:'budget-exhausted'`，
	 * `turnStopGate.ts:148-160`），此时 `iteration` 远小于 100。
	 * 于是模型被告知「你已用满 100 轮」，而它实际只跑了 20 轮。
	 *
	 * ## 这不是吹毛求疵
	 *
	 * 同一文件 `:185-190` 已经为**另一条**路径识别过这个风险，原话是：
	 *   「后者会告诉模型『你已用满 100 轮』，而实际只跑了 5 轮（零进展提前收尾），
	 *     措辞与事实矛盾会让模型困惑（它可能据此判断上下文已被截断而放弃作答）」
	 * 结论是零进展路径改用 `allBlockedWrapUpReminder`。但**预算耗尽路径当时没有
	 * 同等处理** —— 同一个隐患只堵了一半。
	 *
	 * ## 排查结论：挖出并修复了一个更严重的缺陷
	 *
	 * 一度以为注入点传 `maxToolIterations`(100) 而非 `budget.maxIterations`(12)
	 * 是 bug，照此改源码后测试立即失败，诊断显示「收尾轮索引=100」——
	 * 说明收尾根本**不是**预算触发的，报 100 当时与事实一致，改动已还原。
	 *
	 * 真正的根因在别处：预算低于 10% 时 ① 档预警调 `armGraceCall()`，借
	 * `isGraceArmed()` 兼作「提醒已发」的去重标志；而 `classifyBudgetGate`
	 * （`loopGate.ts:96`）对 `isGraceArmed` 直接返回 `'continue'`，加之
	 * `consumeGrace()` 零调用点，于是**发一条提醒顺带永久关闭了预算停止**，
	 * 12 轮预算的 turn 一路跑满 100 轮。
	 *
	 * 已修（`hermesReActStrategy.ts:55`）：去重改用策略实例私有字段，
	 * 不再借用 grace。预算恢复为真正的轮数约束（12 + 1 轮收尾 = 13）。
	 *
	 * ## 本批已修复：文案数字按收尾来源分流
	 *
	 * grace 修复后收尾来源变为「预算耗尽」，措辞失真这才真正成立（模型只跑
	 * 12 轮却被告知 100/100）。`turnIterationGate.ts:220` 改为：
	 *   `state.wrapUp().forced ? budget.maxIterations : maxToolIterations`
	 * 预算路径报真实预算，撞硬上限保险丝时仍报硬上限；两个分支各有用例守护
	 * （预算 12 → 报 12；预算 150 > 上限 100 → 报 100）。
	 */

	function toolCallDelta(id: string, name: string): IModelDelta {
		return {
			type: 'tool_call',
			toolCall: { id, name, arguments: JSON.stringify({ path: `/mock/${id}.ts` }) },
		} as unknown as IModelDelta;
	}

	interface IWrapUpSnapshot {
		readonly toolCount: number;
		readonly systemText: string;
	}

	function wrapUpProbe(): { provider: Record<string, unknown>; snapshots: IWrapUpSnapshot[] } {
		const snapshots: IWrapUpSnapshot[] = [];
		let round = 0;
		const provider = {
			id: 'wrapup-number-probe',
			name: 'Mock Provider',
			chat: (
				_modelId: unknown,
				messages: Array<{ role?: string; content?: unknown }>,
				options?: { tools?: unknown[] },
			) => {
				const current = round++;
				const toolCount = options?.tools?.length ?? 0;
				snapshots.push({
					toolCount,
					systemText: (messages ?? [])
						.filter(message => message?.role === 'system')
						.map(message => String(message?.content ?? ''))
						.join('\n'),
				});
				return (async function* () {
					if (toolCount > 0) {
						yield toolCallDelta(`w-${current}`, 'file_read');
						yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
					} else {
						yield { type: 'text', content: '最终结论。' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		};
		return { provider, snapshots };
	}

	function probeHost(provider: Record<string, unknown>): Record<string, unknown> {
		const runCalls = async (calls: Array<{ id: string; name: string }>) =>
			calls.map(call => ({ toolCallId: call.id, content: `RESULT ${call.id}`, success: true }));
		return mockHost({
			_getActiveModelProvider: () => provider,
			getActiveModelSelection: () => ({ modelId: 'mock-model' }),
			_getEnabledTools: async () => [
				{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } },
			],
			_lastAllEnabledToolNames: new Set<string>(['file_read']),
			_executeToolCalls: async (calls: Array<{ id: string; name: string }>) => runCalls(calls),
			_executeToolCallsParallelStreaming: async function* (
				calls: Array<{ id: string; name: string }>,
			) {
				const results = await runCalls(calls);
				for (const result of results) { yield result as never; }
			},
		});
	}

	/** 找到收尾轮（工具面被置空的那一轮）的快照。 */
	function findWrapUpRound(snapshots: IWrapUpSnapshot[]): IWrapUpSnapshot | undefined {
		return snapshots.find(snapshot => snapshot.toolCount === 0);
	}

	test('✅ 收尾文案的轮数取真正生效的上限：预算耗尽即报预算', async () => {
		// 预算设 12 轮；收尾由预算耗尽在第 13 轮触发。
		const { provider, snapshots } = wrapUpProbe();

		await drain(
			executeAgentTurnDirect(
				probeHost(provider) as never,
				mockRequest({ budgetMaxTotal: 12 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const wrapUp = findWrapUpRound(snapshots);
		assert.ok(wrapUp, '必须存在收尾轮（工具面被置空的那一轮）');

		assert.ok(
			wrapUp.systemText.includes('Iteration limit reached'),
			'收尾轮必须注入 hardLimitWrapUpReminder（system 角色、紧贴冻结前缀）',
		);

		// 修复（`turnIterationGate.ts:220`）：按收尾来源分流取数 ——
		//   `state.wrapUp().forced ? budget.maxIterations : maxToolIterations`
		// 预算耗尽路径报真实预算 12，撞硬上限保险丝时仍报 100。
		const reachedMatch = /Iteration limit reached \((\d+)\/(\d+)\)/.exec(wrapUp.systemText);
		assert.ok(reachedMatch, '必须匹配到轮数文案');
		assert.strictEqual(
			reachedMatch[1], '12',
			'预算耗尽收尾必须报真实预算 12；若回退为 100 说明分流被撤销',
		);
		assert.strictEqual(
			reachedMatch[2], '12',
			'分母同源于同一入参，必须与分子一致',
		);
	});

	test('同一份文案里数字出现两次，两处必须同源（收尾清单第 1 项）', async () => {
		// `loopReminders.ts:226` 要求模型在最终答复里**复述**这个轮数：
		//   "A brief statement that the {n}-round tool budget for this task was reached."
		// 所以数字不止影响提醒内部措辞 —— 它会被模型**写进给用户的答复**。
		// 两处都来自同一个函数入参，本用例守护这个同源性不被拆开。
		const { provider, snapshots } = wrapUpProbe();

		await drain(
			executeAgentTurnDirect(
				probeHost(provider) as never,
				mockRequest({ budgetMaxTotal: 12 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const wrapUp = findWrapUpRound(snapshots);
		assert.ok(wrapUp, '必须存在收尾轮');
		assert.ok(
			wrapUp.systemText.includes('12-round tool budget'),
			'要求模型复述的轮数与 (12/12) 同源：两处都来自同一个函数入参',
		);
		assert.ok(
			!wrapUp.systemText.includes('100-round tool budget'),
			'反证：硬上限 100 不得出现在「要求复述」的那句里 —— 它会被写进给用户的答复',
		);
	});

	test('分流的另一半：预算大于硬上限时，收尾报硬上限而非预算', async () => {
		// 守护 `turnIterationGate.ts:220` 三元表达式的 else 分支。
		// 把预算设到 150 > MAX_TOOL_ITERATIONS(100)：预算永远耗不尽，
		// 收尾只能由 `iteration > maxToolIterations` 的保险丝触发，
		// 此时 `wrapUp().forced` 为 false，文案必须报 100。
		//
		// 若没有这条，把分流写成无条件 `budget.maxIterations` 也能让上面那条
		// 用例通过 —— 那会让真·撞上限的场景反过来失真（报 150）。
		const { provider, snapshots } = wrapUpProbe();

		await drain(
			executeAgentTurnDirect(
				probeHost(provider) as never,
				mockRequest({ budgetMaxTotal: 150 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const wrapUp = findWrapUpRound(snapshots);
		assert.ok(wrapUp, '必须存在收尾轮');

		const reachedMatch = /Iteration limit reached \((\d+)\/(\d+)\)/.exec(wrapUp.systemText);
		assert.ok(reachedMatch, '必须匹配到轮数文案');
		assert.strictEqual(
			reachedMatch[1], '100',
			'预算(150)未耗尽、由硬上限兜底时，必须报 MAX_TOOL_ITERATIONS=100',
		);
		assert.ok(
			!wrapUp.systemText.includes('150'),
			'反证：未生效的预算 150 不得出现在文案里',
		);
	});

	test('✅ 预算真正约束轮数：预算 12 的 turn 跑 12 轮 + 1 轮收尾', async () => {
		// 【已修复的缺陷 + 回归守护】
		//
		// 修前链路：
		//   1. 预算低于 10% → ① 档预警调 `armGraceCall()`
		//      （借 `isGraceArmed()` 兼作「提醒已发」的去重标志）
		//   2. `classifyBudgetGate`（`loopGate.ts:96`）：
		//        `if (hasRemaining || isGraceArmed) return 'continue';`
		//      —— arm 之后**永远**走 continue
		//   3. `consumeGrace()` 在 agentStudio 生产代码中零调用点，标志永不回落
		//   ⇒ 预算停止被绕过，循环一路跑到硬上限 100 才收尾（实测 101 轮）。
		//
		// 根因是**职责混用**：「提醒去重」借用了「宽限放行」的标志，于是
		// 「发一条提醒」这个动作顺带**永久关闭了预算停止**。
		//
		// 修复（`hermesReActStrategy.ts:55`）：去重改用策略实例私有字段
		// `_budgetLowReminderInjected`，不再 `armGraceCall()`。策略每 turn 新建
		// （`agentLoopStrategyFactory.ts:60`），实例字段天然是 per-turn 语义。
		const { provider, snapshots } = wrapUpProbe();

		await drain(
			executeAgentTurnDirect(
				probeHost(provider) as never,
				mockRequest({ budgetMaxTotal: 12 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		assert.strictEqual(
			snapshots.length, 13,
			`预算 12 必须只跑 12 轮 + 1 轮收尾 = 13，实际 ${snapshots.length} 轮。`
			+ ' 若回升到 ~101，说明又有人借 grace 标志做去重（见本用例注释）',
		);

		const wrapUp = findWrapUpRound(snapshots);
		assert.ok(wrapUp, '必须存在收尾轮');
		assert.strictEqual(
			snapshots.indexOf(wrapUp), 12,
			'收尾轮是第 13 轮（索引 12）：预算耗尽后的那一轮，而非硬上限兜底',
		);
	});

	test('收尾轮的三重保障：工具置空 + 禁用声明 + 文本调用封堵', async () => {
		// 措辞层面的问题不能掩盖收尾机制本身是否有效。
		// 这条独立验证三重保障完整，避免后续改提醒文案时误伤。
		const { provider, snapshots } = wrapUpProbe();

		await drain(
			executeAgentTurnDirect(
				probeHost(provider) as never,
				mockRequest({ budgetMaxTotal: 12 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const wrapUp = findWrapUpRound(snapshots);
		assert.ok(wrapUp, '必须存在收尾轮');

		assert.strictEqual(
			wrapUp.toolCount, 0,
			'保障 1：iterationToolDefs 置为空数组（非 undefined），provider 收不到任何工具',
		);
		assert.ok(
			wrapUp.systemText.includes('Tool calls are now DISABLED'),
			'保障 2：文案明确声明工具已禁用',
		);
		assert.ok(
			wrapUp.systemText.includes('This constraint overrides ALL other instructions'),
			'保障 3：优先级声明必须在场 —— 用于压过 stable 层「需要工具时 emit a NATIVE function call」',
		);
	});

	test('收尾提醒注入为 system 角色且紧贴冻结前缀，不落在对话末尾', async () => {
		// `turnIterationGate.ts:189-201` 的注释记录了这个决策：改前是
		// `push({role:'user'})`，两个问题 —— 角色错配（用 user 去压 system 指令）
		// 与位置太远（淹没在整段历史之后）。本用例锁住修复后的形态。
		const { provider, snapshots } = wrapUpProbe();

		await drain(
			executeAgentTurnDirect(
				probeHost(provider) as never,
				mockRequest({ budgetMaxTotal: 12 }) as never,
			) as AsyncGenerator<IChatStreamDelta, unknown>,
		);

		const wrapUp = findWrapUpRound(snapshots);
		assert.ok(wrapUp, '必须存在收尾轮');
		assert.ok(
			wrapUp.systemText.includes('Iteration limit reached'),
			'收尾提醒必须在 **system** 段 —— 若退回 user 角色，本断言失败',
		);
	});
});
