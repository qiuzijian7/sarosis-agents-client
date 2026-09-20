/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * piTurnKernel 测试（2026-09-20，doc §5 P1 门控实现）。
 *
 * 钉住四件事：
 *   1. 纯文本 turn：text → assistant_turn → done，且**不调**工具；
 *   2. 工具 turn：piLoop 的 toolCall 经 `host._executeToolCalls`（legacy 总线）执行，
 *      参数以 **JSON 字符串**传递（IToolCallInfo 契约），结果回灌后自动续跑；
 *   3. 种子历史转换：system/user/assistant(reasoning+toolCalls)/tool 全映射，
 *      toolResult 的 toolName 由 toolCallId 反查，孤儿 tool 消息丢弃；
 *   4. 门控：默认关；plan/chatOnly/resumeFrom/subAgent 形态回落 legacy。
 */
import assert from 'assert';
import type { IAgentTurnRequest, IChatStreamDelta, IModelDelta, IModelProvider, IModelSelection, IToolCallInfo } from '../../common/providers.js';
import {
	isPiKernelEnabled,
	loopMessagesToPiMessages,
	piKernelSupports,
	piMessagesToLoopMessages,
	runPiKernelTurn,
	type IPiKernelHost,
} from '../../browser/piLoop/piTurnKernel.js';
import type { IContextCompactionManager } from '../../browser/parts/turnContextCompaction.js';

const silentLog = { info() { /* */ }, warn() { /* */ }, error() { /* */ } } as unknown as IPiKernelHost['_logService'];
const fakeSelection = { providerId: 'p', modelId: 'test-model' } as unknown as IModelSelection;
const fakeRequest = { agentId: 'a1', sessionId: 's1' } as IAgentTurnRequest;

function makeHost(overrides?: Partial<IPiKernelHost>): IPiKernelHost {
	return {
		_logService: silentLog,
		_executeToolCalls: async (tcs) => tcs.map(tc => ({ toolCallId: tc.id, content: 'ok', success: true })),
		_totalInputTokens: 0,
		_totalOutputTokens: 0,
		_totalCachedTokens: 0,
		_lastRealPromptTokensByAgent: new Map(),
		_lastAssistantAtByAgent: new Map(),
		_turnKey: (a, s) => `${a ?? ''}:${s ?? ''}`,
		_scheduleSave: () => { /* */ },
		getActiveMemoryProvider: () => undefined, // 默认无记忆 ⇒ 检索注入不触发
		_setCurrentModel: () => { /* */ },
		_resolveContextWindow: async () => 128000,
		_storeTurnObservations: async () => { /* */ },
		_retrieveContextOnly: async () => null,
		_injectRetrievalSystemMessage: (msgs) => msgs,
		_estimateMessagesTokens: (msgs) => msgs.length * 100, // 默认低压 ⇒ 压缩不触发
		_lastCompressionTime: 0,
		_lastHardPruneBaselineTokens: 0,
		_compressionCount: 0,
		_compressionIneffectiveCount: 0,
		_compressionBeforeTokens: 0,
		_compressionAfterTokens: 0,
		_currentWorkspaceId: 'ws-test',
		_retrieveCompactionContext: async () => null,
		...overrides,
	};
}

async function collect(gen: AsyncGenerator<IChatStreamDelta, void>): Promise<IChatStreamDelta[]> {
	const out: IChatStreamDelta[] = [];
	for await (const d of gen) { out.push(d); }
	return out;
}

suite('piTurnKernel（pi 内核真路径驱动器）', () => {

	test('纯文本 turn：text → assistant_turn → done，不触发工具执行', async () => {
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				yield { type: 'text', content: '你好' } as IModelDelta;
				yield { type: 'done', finishReason: 'stop' } as IModelDelta;
			},
		} as unknown as IModelProvider;
		let toolExecCount = 0;
		const host = makeHost({
			_executeToolCalls: async (tcs) => { toolExecCount++; return tcs.map(tc => ({ toolCallId: tc.id, content: 'x', success: true })); },
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: [],
			messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
		}));

		const types = deltas.map(d => d.type);
		assert.ok(types.includes('text'), `应有 text：${types.join(',')}`);
		assert.ok(types.includes('assistant_turn'), `应有 assistant_turn：${types.join(',')}`);
		assert.strictEqual(types[types.length - 1], 'done', `done 收尾：${types.join(',')}`);
		assert.strictEqual(deltas.filter(d => d.type === 'text').map(d => d.content).join(''), '你好');
		assert.strictEqual(toolExecCount, 0, '纯文本 turn 不得执行工具');
	});

	test('工具 turn：经 host._executeToolCalls（JSON 字符串参数），结果回灌后续跑', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round === 1) {
					yield { type: 'tool_call', toolCall: { id: 'c1', name: 'file_read', arguments: '{"path":"/x"}' } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'done-reading' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;
		const seen: IToolCallInfo[] = [];
		const observed: string[] = [];
		const host = makeHost({
			_executeToolCalls: async (tcs) => { seen.push(...tcs); return [{ toolCallId: tcs[0]!.id, content: 'FILE_BODY', success: true }]; },
			_observeToolResult: (_a, r) => { observed.push(`${r.toolName}:${r.success}`); },
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: '读文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } } as never],
			messages: [{ role: 'user', content: '读 /x' }],
		}));

		assert.strictEqual(seen.length, 1, 'host._executeToolCalls 应被调一次');
		assert.strictEqual(seen[0]!.name, 'file_read');
		assert.strictEqual(typeof seen[0]!.arguments, 'string', 'IToolCallInfo.arguments 必须是 JSON 字符串');
		assert.strictEqual(JSON.parse(seen[0]!.arguments).path, '/x');
		assert.deepStrictEqual(observed, ['file_read:true'], '_observeToolResult 应同步观察');

		const types = deltas.map(d => d.type);
		for (const t of ['tool_start', 'tool_result', 'tool_end']) {
			assert.ok(types.includes(t), `应有 ${t}：${types.join(',')}`);
		}
		assert.ok(deltas.some(d => d.type === 'tool_result' && d.content === 'FILE_BODY'), '工具结果应作为 tool_result 产出');
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'done-reading'), '工具后应续跑第二轮文本');
		assert.strictEqual(types[types.length - 1], 'done');
	});

	test('工具执行异常 → 编码为错误结果而非抛出（模型可自愈）', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round === 1) {
					yield { type: 'tool_call', toolCall: { id: 'c1', name: 'file_read', arguments: '{}' } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'recover' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;
		const host = makeHost({
			_executeToolCalls: async () => { throw new Error('sandbox boom'); },
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));

		assert.ok(deltas.some(d => d.type === 'tool_end' && d.success === false), '工具异常应产出 success=false 的 tool_end');
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'recover'), '异常后内核应续跑而不是中断');
	});

	test('loopMessagesToPiMessages：四类消息全映射 + toolName 反查 + 孤儿丢弃', () => {
		const out = loopMessagesToPiMessages([
			{ role: 'system', content: 'SYS' },
			{ role: 'user', content: 'U1' },
			{ role: 'assistant', content: 'A1', reasoning: 'think', toolCalls: [{ id: 'c1', name: 'file_read', arguments: '{"path":"/a"}' }] },
			{ role: 'tool', content: 'R1', toolCallId: 'c1' },
			{ role: 'tool', content: 'orphan', toolCallId: '' },
		]);

		assert.strictEqual(out.length, 4, '孤儿 tool 消息（无 toolCallId）应丢弃');
		assert.strictEqual((out[0] as { role: string }).role, 'system');
		assert.strictEqual((out[1] as { role: string }).role, 'user');

		const assistant = out[2] as unknown as { role: string; stopReason: string; content: Array<{ type: string }> };
		assert.strictEqual(assistant.stopReason, 'toolUse');
		assert.deepStrictEqual(assistant.content.map(b => b.type), ['thinking', 'text', 'toolCall']);

		const toolResult = out[3] as unknown as { role: string; toolName: string; toolCallId: string; content: Array<{ text: string }> };
		assert.strictEqual(toolResult.role, 'toolResult');
		assert.strictEqual(toolResult.toolCallId, 'c1');
		assert.strictEqual(toolResult.toolName, 'file_read', 'toolName 应由 toolCallId 反查前文 assistant');
		assert.strictEqual(toolResult.content[0]!.text, 'R1');
	});

	test('门控：默认关；plan/chatOnly/resumeFrom/subAgent 回落 legacy', () => {
		assert.strictEqual(isPiKernelEnabled(), false, '默认必须走 legacy');
		assert.strictEqual(piKernelSupports({} as IAgentTurnRequest), true);
		assert.strictEqual(piKernelSupports({ chatMode: 'plan' } as IAgentTurnRequest), false);
		assert.strictEqual(piKernelSupports({ chatOnly: true } as IAgentTurnRequest), false);
		assert.strictEqual(piKernelSupports({ resumeFrom: {} } as unknown as IAgentTurnRequest), false);
		assert.strictEqual(piKernelSupports({ subAgent: {} } as unknown as IAgentTurnRequest), false);
	});

	test('usage 记账：message_end 的 usage 累加进 Dashboard 计数器（含缓存归一口径）', async () => {
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				yield { type: 'text', content: 'x' } as IModelDelta;
				yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40 } } as IModelDelta;
				yield { type: 'done', finishReason: 'stop' } as IModelDelta;
			},
		} as unknown as IModelProvider;
		let saves = 0;
		const host = makeHost({ _scheduleSave: () => { saves++; } });

		await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: [],
			messages: [{ role: 'user', content: 'hi' }],
		}));

		assert.strictEqual(host._totalInputTokens, 100);
		assert.strictEqual(host._totalOutputTokens, 20);
		assert.strictEqual(host._totalCachedTokens, 40);
		// 口径（executor:1776-1779）：input(100) >= cached(40) ⇒ 已含缓存 ⇒ realPrompt=100
		assert.strictEqual(host._lastRealPromptTokensByAgent.get('a1:s1'), 100);
		assert.ok(saves >= 1, '_scheduleSave 应被调用');
	});

	test('工具循环护栏：同签名第 4 次被拦（threshold=3），合成错误结果后续跑', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round <= 5) {
					yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'file_read', arguments: '{"path":"/x"}' } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'recovered' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;
		const seen: string[] = [];
		const host = makeHost({
			_executeToolCalls: async (tcs) => { seen.push(tcs[0]!.id); return [{ toolCallId: tcs[0]!.id, content: 'SAME', success: true }]; },
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));

		assert.deepStrictEqual(seen, ['c1', 'c2', 'c3'], '第 4 次同签名调用应被拦（detectToolCallLoop threshold=3）');
		assert.ok(deltas.some(d => d.type === 'tool_end' && d.success === false), '被拦调用应产出 success=false 的 tool_end');
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'recovered'), '拦截后应续跑收尾');
	});

	test('记忆检索注入：先外置后召回（与 legacy 同序），检索内容随种子送达模型', async () => {
		let captured: unknown;
		const provider = {
			chat: (_id: string, msgs: unknown) => {
				captured = msgs;
				return (async function* (): AsyncIterable<IModelDelta> {
					yield { type: 'text', content: 'ok' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		} as unknown as IModelProvider;
		const calls: string[] = [];
		const host = makeHost({
			getActiveMemoryProvider: () => ({ recallFormatted: () => '' }) as never,
			_storeTurnObservations: async () => { calls.push('store'); },
			_retrieveContextOnly: async () => { calls.push('retrieve'); return { context: 'RETRIEVED_CTX', tokens: 10, source: 'mem' }; },
			_injectRetrievalSystemMessage: (msgs, ctx) => [...msgs, { role: 'system', content: ctx }],
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: [],
			messages: [{ role: 'user', content: 'hi' }],
		}));

		assert.deepStrictEqual(calls, ['store', 'retrieve'], '先外置后检索（executor:1143→1146 同序）');
		const phases = deltas.filter(d => d.type === 'phase_change').map(d => (d as { phase?: string }).phase);
		assert.deepStrictEqual(phases, ['retrieving', 'llm_streaming'], '检索前后应发 phase_change（32s 静默的教训）');
		assert.ok(deltas.some(d => d.type === 'memory_injected'), '应有 memory_injected delta');
		const msgs = captured as Array<{ role: string; content: string }>;
		assert.ok(msgs.some(m => m.role === 'system' && m.content === 'RETRIEVED_CTX'), '检索内容应以 system 消息送达模型');
	});

	test('pi⇄legacy 往返：压缩关注的字段（role/content/reasoning/toolCalls/toolCallId）保真', () => {
		const seed = [
			{ role: 'system', content: 'SYS' },
			{ role: 'user', content: 'U1' },
			{ role: 'assistant', content: 'A1', reasoning: 'think', toolCalls: [{ id: 'c1', name: 'file_read', arguments: '{"path":"/a"}' }] },
			{ role: 'tool', content: 'R1', toolCallId: 'c1' },
		];
		const back = piMessagesToLoopMessages(loopMessagesToPiMessages(seed));

		assert.strictEqual(back.length, 4);
		assert.deepStrictEqual(back[0], { role: 'system', content: 'SYS' });
		assert.deepStrictEqual(back[1], { role: 'user', content: 'U1' });
		assert.deepStrictEqual(back[2], {
			role: 'assistant', content: 'A1', reasoning: 'think',
			toolCalls: [{ id: 'c1', name: 'file_read', arguments: '{"path":"/a"}' }],
		}, 'assistant 的 reasoning + toolCalls（arguments 回 JSON 字符串）应保真');
		assert.deepStrictEqual(back[3], { role: 'tool', content: 'R1', toolCallId: 'c1' });
	});

	test('压缩段接线：transformContext 触发压缩、事件上屏、权威 transcript 写回（第二轮用压缩后历史）', async () => {
		let round = 0;
		const capturedPerRound: Array<Array<{ role: string; content: string }>> = [];
		const provider = {
			chat: (_id: string, msgs: unknown) => {
				capturedPerRound.push(structuredClone(msgs) as Array<{ role: string; content: string }>);
				return (async function* (): AsyncIterable<IModelDelta> {
					round++;
					if (round === 1) {
						yield { type: 'tool_call', toolCall: { id: 'c1', name: 'file_read', arguments: '{"path":"/x"}' } } as IModelDelta;
						yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
					} else {
						yield { type: 'text', content: 'fin' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		} as unknown as IModelProvider;
		let compressCalls = 0;
		const mockManager: IContextCompactionManager = {
			willAttemptCompression: () => true,
			compressContext: async (msgs) => {
				compressCalls++;
				return {
					originalMessageCount: msgs.length,
					compressedMessageCount: 2,
					summary: 'SUMMARY',
					compressedMessages: [
						{ role: 'system', content: 'SYS' },
						{ role: 'user', content: 'SUMMARY' },
					] as never,
				};
			},
			compressCheckpoint: async (msgs) => ({
				originalMessageCount: msgs.length, compressedMessageCount: msgs.length, summary: '', compressedMessages: msgs,
			}),
		};
		const host = makeHost({
			// 高压：触发第 1-2 级剪枝判定路径（pressure>=2）
			_estimateMessagesTokens: (msgs) => msgs.length * 50000,
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [
				{ role: 'system', content: 'SYS' },
				{ role: 'user', content: 'OLD_USER_MSG' },
				{ role: 'assistant', content: 'OLD_A' },
				{ role: 'user', content: 'go' },
			],
			contextManagerFactory: () => mockManager,
		}));

		assert.strictEqual(compressCalls, 1, '压缩应只执行一次（第二次 transformContext 撞 cooldown）');
		assert.ok(deltas.some(d => d.type === 'context_compacted'), '应有 context_compacted delta（UI 压缩卡片）');
		const phases = deltas.filter(d => d.type === 'phase_change').map(d => (d as { phase?: string }).phase);
		assert.ok(phases.includes('compressing') && phases.includes('llm_streaming'), `应进出 compressing 相：${phases.join(',')}`);
		// 写回验证：第二轮请求的历史已是压缩后的（SUMMARY 在、被丢弃的 OLD_USER_MSG 不在）
		assert.strictEqual(capturedPerRound.length, 2, '两轮模型请求');
		const round2 = capturedPerRound[1]!;
		assert.ok(round2.some(m => m.content === 'SUMMARY'), '第二轮应携带压缩摘要（transcript 已写回）');
		assert.ok(!round2.some(m => typeof m.content === 'string' && m.content.includes('OLD_USER_MSG')), '被压缩丢弃的消息不得再现');
	});
});
