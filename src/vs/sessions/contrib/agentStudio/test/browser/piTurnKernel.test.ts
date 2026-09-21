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
 *   4. 门控：默认开（E2 翻转）；显式关断回落 legacy；全形态已接入。
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

	test('门控：默认开（E2 已翻转）；显式 false/0 回落 legacy；全部形态已接入', () => {
		const g = globalThis as { __SAROSIS_PI_KERNEL?: unknown };
		const saved = g.__SAROSIS_PI_KERNEL;
		try {
			delete g.__SAROSIS_PI_KERNEL;
			assert.strictEqual(isPiKernelEnabled(), true, 'E2 翻转后默认必须走 pi 内核');
			g.__SAROSIS_PI_KERNEL = false;
			assert.strictEqual(isPiKernelEnabled(), false, '显式 false ⇒ 回落 legacy（排障逃生门）');
			g.__SAROSIS_PI_KERNEL = true;
			assert.strictEqual(isPiKernelEnabled(), true);
		} finally {
			if (saved === undefined) { delete g.__SAROSIS_PI_KERNEL; } else { g.__SAROSIS_PI_KERNEL = saved; }
		}
		assert.strictEqual(piKernelSupports({} as IAgentTurnRequest), true);
		assert.strictEqual(piKernelSupports({ chatOnly: true } as IAgentTurnRequest), true,
			'chatOnly 已解除排除（写工具过滤在门控分流点之前由 executor 完成）');
		assert.strictEqual(piKernelSupports({ chatMode: 'plan' } as IAgentTurnRequest), true,
			'plan 已接入（批后拦截复用 parts/turnPlanModeTools）');
		assert.strictEqual(piKernelSupports({ resumeFrom: {} } as unknown as IAgentTurnRequest), true,
			'断点续跑已接入（checkpoint 恢复 + 迭代接续 + 每 3 轮落盘）');
		assert.strictEqual(piKernelSupports({ subAgent: { type: 'explore', background: true } } as unknown as IAgentTurnRequest), true,
			'subAgent 已接入（软预算提醒/迭代预算 1000/askRouting 审批路由）');
	});

	test('resumeFrom：checkpoint 消息优先于 deps.messages；迭代计数接续（maxTurns 扣减）', async () => {
		const captured: unknown[] = [];
		let calls = 0;
		const provider = {
			chat: (_id: string, msgs: unknown) => {
				captured.push(structuredClone(msgs));
				calls++;
				return (async function* (): AsyncIterable<IModelDelta> {
					yield { type: 'text', content: 'resumed answer' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		} as unknown as IModelProvider;
		const resumed = {
			...fakeRequest,
			resumeFrom: {
				messages: [
					{ role: 'system', content: 'SYS' },
					{ role: 'user', content: 'RESTORED_USER_MSG' },
				],
				iteration: 99, // 距 100 上限仅 1 轮余量
			},
		} as unknown as IAgentTurnRequest;

		const deltas = await collect(runPiKernelTurn(makeHost(), resumed, {
			modelProvider: provider, selection: fakeSelection, enabledTools: [],
			messages: [{ role: 'user', content: 'SHOULD_BE_IGNORED' }],
		}));

		assert.strictEqual(calls, 1, '余量 1 轮 ⇒ 恰好一次模型调用（迭代接续生效）');
		const msgs = captured[0] as Array<{ role: string; content: string }>;
		assert.ok(msgs.some(m => m.content === 'RESTORED_USER_MSG'), 'checkpoint 消息应成为种子');
		assert.ok(!msgs.some(m => m.content === 'SHOULD_BE_IGNORED'), 'deps.messages 被 checkpoint 覆盖');
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'resumed answer'));
		assert.strictEqual(deltas[deltas.length - 1]!.type, 'done');
	});

	test('checkpoint 落盘：每 3 轮快照一次（含 messages 与 iteration），fire-and-forget', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round <= 4) {
					yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'file_read', arguments: `{"path":"/x${round}"}` } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'fin' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;
		const sinkCalls: unknown[] = [];
		const withSink = {
			...fakeRequest,
			checkpointSink: (snapshot: unknown) => { sinkCalls.push(structuredClone(snapshot)); },
		} as unknown as IAgentTurnRequest;

		await collect(runPiKernelTurn(makeHost(), withSink, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));

		// 4 轮工具轮（turn_end ×4，计数 0..3）+ 末轮文本（计数 4）⇒ 在 0 与 3 落盘
		assert.strictEqual(sinkCalls.length, 2, '每 3 轮一次（absoluteIteration 0 与 3）');
		const snap0 = sinkCalls[0] as { state: { iteration: number; messages: unknown[]; budgetSnapshot?: { consumed: number } } };
		const snap1 = sinkCalls[1] as { state: { iteration: number; messages: unknown[] } };
		assert.strictEqual(snap0.state.iteration, 0);
		assert.strictEqual(snap1.state.iteration, 3);
		assert.ok(snap1.state.messages.length > snap0.state.messages.length, '快照应携带随轮增长的消息');
	});

	test('plan_enter：批后拦截切入 plan 模式 + 建计划文件 + 拦截器 tool 消息回灌 transcript', async () => {
		let round = 0;
		const captured: unknown[] = [];
		const provider = {
			chat: (_id: string, msgs: unknown) => {
				captured.push(structuredClone(msgs));
				return (async function* (): AsyncIterable<IModelDelta> {
					round++;
					if (round === 1) {
						yield { type: 'tool_call', toolCall: { id: 'pe1', name: 'plan_enter', arguments: '{}' } } as IModelDelta;
						yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
					} else {
						yield { type: 'text', content: 'planning...' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		} as unknown as IModelProvider;
		const written: string[] = [];
		const host = makeHost({
			_writePlanFile: async (path) => { written.push(path); },
			_readPlanFile: async () => '',
			_awaitPlanApproval: async () => 'approved',
			_orchestratePlan: async function* () { /* 不会到达 */ },
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'plan_enter', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: '做个计划' }],
		}));

		assert.strictEqual(written.length, 1, 'plan_enter 应创建计划文件骨架');
		assert.ok(deltas.some(d => (d as { workMode?: string }).workMode === 'plan'), '应发 work_mode_changed(plan)');
		// 拦截器补发的 tool_result（带正确 success=true，而非兜底 false）
		assert.ok(deltas.some(d => d.type === 'tool_end' && d.success === true && (d as { toolCallId?: string }).toolCallId === 'pe1'), '拦截器应补发 success=true 的 tool_end');
		// 拦截器追加的 tool 消息应回灌 transcript（第二轮模型可见）
		const round2Msgs = captured[1] as Array<{ role: string; content: unknown }>;
		assert.ok(round2Msgs.some(m => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('Entered internal plan work mode')), '拦截器 tool 消息应进 transcript');
	});

	test('plan_exit：计划文件为空 ⇒ 拦截拒绝（tool_end false）并继续；有效 ⇒ 派发 DAG 并结束 turn', async () => {
		// ── 场景 A：无效计划被拦 ──
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round === 1) {
					yield { type: 'tool_call', toolCall: { id: 'pe1', name: 'plan_enter', arguments: '{}' } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else if (round === 2) {
					yield { type: 'tool_call', toolCall: { id: 'px1', name: 'plan_exit', arguments: '{}' } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'refine plan' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;
		const hostA = makeHost({
			_writePlanFile: async () => { /* */ },
			_readPlanFile: async () => '', // 空计划 ⇒ 无效
			_awaitPlanApproval: async () => 'approved',
			_orchestratePlan: async function* () { throw new Error('不应到达'); },
		});
		const planTools = [
			{ name: 'plan_enter', description: 'x', inputSchema: { type: 'object' } } as never,
			{ name: 'plan_exit', description: 'x', inputSchema: { type: 'object' } } as never,
		];
		const deltasA = await collect(runPiKernelTurn(hostA, fakeRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: planTools,
			messages: [{ role: 'user', content: 'go' }],
		}));
		assert.ok(deltasA.some(d => d.type === 'tool_end' && d.success === false && (d as { toolCallId?: string }).toolCallId === 'px1'), '无效计划 ⇒ plan_exit 以 success=false 收尾');
		assert.ok(deltasA.some(d => d.type === 'text' && d.content === 'refine plan'), '被拦后 turn 应继续（模型可修订计划）');

		// ── 场景 B：有效计划 ⇒ 派发 + turn 结束 ──
		round = 0;
		const orchestrated: unknown[] = [];
		const hostB = makeHost({
			_writePlanFile: async () => { /* */ },
			_readPlanFile: async () => '# Plan\n## Goal\ndo it\n## Tasks\n### Task 1: implement\n- Role: Developer\n- Description: x\n- Files: a.ts\n- Dependencies: none\n- Complexity: medium\n',
			_awaitPlanApproval: async () => 'approved',
			_orchestratePlan: async function* (_req, opts, tasks) {
				orchestrated.push({ opts, tasks });
				yield { type: 'text', content: 'DISPATCHED' } as never;
			},
		});
		const deltasB = await collect(runPiKernelTurn(hostB, fakeRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: planTools,
			messages: [{ role: 'user', content: 'go' }],
		}));
		assert.strictEqual(orchestrated.length, 1, '有效计划 ⇒ _orchestratePlan 派发一次');
		assert.strictEqual((orchestrated[0] as { tasks: unknown[] }).tasks.length, 1, '派发 1 个结构化任务');
		assert.ok(deltasB.some(d => d.type === 'text' && d.content === 'DISPATCHED'), 'orchestration 的 delta 应上屏');
		assert.ok(deltasB.some(d => (d as { workMode?: string }).workMode === 'work'), '应发 work_mode_changed(work)');
		assert.strictEqual(round, 2, "'done' ⇒ turn 立即结束（不得有第三轮模型调用）");
		assert.strictEqual(deltasB[deltasB.length - 1]!.type, 'done');
	});

	test('subAgent 软预算：超 softDeadlineMs ⇒ 收尾引导注入下一条工具结果；审批路由 role=subagent', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round <= 2) {
					yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'file_read', arguments: `{"path":"/x${round}"}` } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'summary' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;
		const askRoutings: unknown[] = [];
		const host = makeHost({
			_executeToolCalls: async (tcs, _a, _w, _s, askRouting) => {
				askRoutings.push(askRouting);
				// 墙钟推进：纯 mock 两轮可能落在同一毫秒内（elapsed 恒 0 永不超预算）⇒ 强制推进
				await new Promise(r => setTimeout(r, 2));
				return [{ toolCallId: tcs[0]!.id, content: 'ok_' + tcs[0]!.id, success: true }];
			},
		});
		const subRequest = {
			...fakeRequest,
			subAgent: { type: 'explore', background: true },
			softDeadlineMs: 1, // 1ms ⇒ 第二个工具调用时必然超预算（0 会被 >0 守卫关掉，与 legacy 同）
		} as unknown as IAgentTurnRequest;

		const deltas = await collect(runPiKernelTurn(host, subRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));
		const toolResults = deltas.filter(d => d.type === 'tool_result').map(d => String(d.content));

		// 墙钟时序：1ms 预算下首轮调用可能仍在同一毫秒内（elapsed=0）⇒ 断「任一结果携带且仅一次」
		const budgetHits = toolResults.filter(r => r.includes('past the soft budget'));
		assert.strictEqual(budgetHits.length, 1, '超软预算 ⇒ 收尾引导注入一次（60s 重提周期内不重发）');
		// 审批路由（executor:3247 deriveAskRoutingContext）：background 子代理 ⇒ role=subagent
		assert.deepStrictEqual(askRoutings[0], { role: 'subagent', subAgentType: 'explore', chatMode: undefined, workMode: undefined });
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'summary'), '软预算提醒不打断，模型可正常收尾');
	});

	test('chatOnly turn：写工具已被上游过滤 ⇒ pi 路径只见只读工具（安全语义继承实证）', async () => {
		// 模拟 executor chatOnly 分支过滤后的 enabledTools（写工具 file_write/execute_command 已被剔除）
		const filteredTools = [
			{ name: 'file_read', description: '读', inputSchema: { type: 'object' } } as never,
			{ name: 'file_exists', description: '查', inputSchema: { type: 'object' } } as never,
		];
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				yield { type: 'text', content: 'ok' } as IModelDelta;
				yield { type: 'done', finishReason: 'stop' } as IModelDelta;
			},
		} as unknown as IModelProvider;
		const deltas = await collect(runPiKernelTurn(makeHost(), { agentId: 'a1', sessionId: 's1', chatOnly: true } as IAgentTurnRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: filteredTools,
			messages: [{ role: 'user', content: 'hi' }],
		}));
		assert.ok(deltas.some(d => d.type === 'text'), 'chatOnly turn 应正常跑通');
		assert.ok(!deltas.some(d => d.type === 'tool_start'), '过滤后的工具集不含写工具 ⇒ 无工具调用发生');
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

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: [],
			messages: [{ role: 'user', content: 'hi' }],
		}));

		assert.strictEqual(host._totalInputTokens, 100);
		assert.strictEqual(host._totalOutputTokens, 20);
		assert.strictEqual(host._totalCachedTokens, 40);
		// 口径（executor:1776-1779）：input(100) >= cached(40) ⇒ 已含缓存 ⇒ realPrompt=100
		assert.strictEqual(host._lastRealPromptTokensByAgent.get('a1:s1'), 100);
		assert.ok(saves >= 1, '_scheduleSave 应被调用');

		// ★★★ 2026-09-20（用户报「输入框 tokens UI 未更新」取证修复）：usage 必须**透出给 pane** ——
		//   此前 pi 路径只把 usage 记进 host 计数器，不产 `usage` delta
		//   （legacy 是 provider delta 直通）⇒ composer 上下文环与消息 tokenUsage 永不刷新 ✗。
		const usageDeltas = deltas.filter(d => d.type === 'usage');
		assert.strictEqual(usageDeltas.length, 1, '每个 message_end 必须补发且仅补发一条 usage delta ✗');
		assert.strictEqual(usageDeltas[0].usage?.inputTokens, 100);
		assert.strictEqual(usageDeltas[0].usage?.outputTokens, 20);
		assert.strictEqual(usageDeltas[0].usage?.cachedTokens, 40);
		assert.strictEqual(usageDeltas[0].usage?.totalTokens, 120);
		// 顺序：usage 先于 assistant_turn（usage 属于刚定稿的这条消息 ⇒ 边界事件在后 ✓）
		const usageIdx = deltas.findIndex(d => d.type === 'usage');
		const turnIdx = deltas.findIndex(d => d.type === 'assistant_turn');
		assert.ok(usageIdx !== -1 && turnIdx !== -1 && usageIdx < turnIdx,
			'usage delta 必须排在 assistant_turn 之前（否则可能被挂到下一轮消息上 ✗）');
	});

	test('usage 缺失（mock/无用量）⇒ 不产空 usage delta（保持既有 delta 序列 ✗）', async () => {
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				yield { type: 'text', content: 'x' } as IModelDelta;
				yield { type: 'done', finishReason: 'stop' } as IModelDelta;
			},
		} as unknown as IModelProvider;
		const deltas = await collect(runPiKernelTurn(makeHost(), fakeRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: [],
			messages: [{ role: 'user', content: 'hi' }],
		}));
		assert.strictEqual(deltas.filter(d => d.type === 'usage').length, 0,
			'无用量信息不得产出 usage delta（否则下游会按 input=0 覆盖基线 ✗）');
	});

	test('★★ 工具名被上游伪 XML 污染 ⇒ 合成错误结果携带纠正指令（勿盲重试）', async () => {
		// 真机取证（http-debug SSE）：上游把并行调用按标记粘进 name —
		// 「index_status</tool_call:6124c78e><tool_call:6124c78e>search_files」。
		// 注：本链路绕过了 LMBridge 归一化（正常流里会在入口归一化为 search_files）；
		// 这里驱动内核直收坏名字，验证内核**兜底**不崩且给纠正指令（而非泛泛「未找到」）。
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				yield { type: 'tool_call', toolCall: { id: 'c1', name: 'index_status</tool_call:6124c78e><tool_call:6124c78e>search_files', arguments: '{"pattern":"*"}' } } as IModelDelta;
				yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
			},
		} as unknown as IModelProvider;
		const deltas = await collect(runPiKernelTurn(makeHost(), fakeRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: [],
			messages: [{ role: 'user', content: 'hi' }],
		}));
		const results = deltas.filter(d => d.type === 'tool_result').map(d => String(d.content));
		// 内核语义：坏名字 → prepareToolCall 立即合成错误结果（**不执行**）。
		// mock provider 每轮都产出同一个坏名字 ⇒ 内核重试直到护栏截停（halt/上限）——
		// 这是既有护栏职责；本用例钉的是**第一次**就给出纠正指令、且自始至终没有任何真实执行。
		assert.ok(results.length >= 1, '必须合成错误结果 ✗');
		assert.ok(results[0].includes('伪 XML 标记'), '首个错误结果必须点名「伪 XML 标记」✗');
		assert.ok(results[0].includes('逐个重新发起调用'), '首个错误结果必须给出纠正指令（勿盲重试 ✗）');
		assert.ok(results.every(r => !r.startsWith('ok:')), '任何一轮都不得真实执行（host mock 的 ok: 标记不得出现 ✗）');
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
			// ⚠ 结果必须各异：恒定结果会先触发 no-progress 护栏（第 3 次即拦，见下一用例）——
			// 本用例测的是 detectToolCallLoop 本身 ⇒ 结果逐次变化，no-progress 不累积。
			_executeToolCalls: async (tcs) => { seen.push(tcs[0]!.id); return [{ toolCallId: tcs[0]!.id, content: 'R_' + tcs[0]!.id, success: true }]; },
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

	test('no-progress 护栏：同签名+同结果第 3 次即拦（比 detectToolCallLoop 的第 4 次更早，executor:2902 分工）', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round <= 4) {
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
			_executeToolCalls: async (tcs) => { seen.push(tcs[0]!.id); return [{ toolCallId: tcs[0]!.id, content: 'IDENTICAL_RESULT', success: true }]; },
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));

		// noProgressBlockAfter=2：c1/c2 执行且结果相同 ⇒ c3 被 no-progress 拦（detectToolCallLoop 的 c4 根本到不了）
		assert.deepStrictEqual(seen, ['c1', 'c2'], '同签名+同结果第 3 次必须被 no-progress 拦（早于循环检测的第 4 次）');
		assert.ok(deltas.some(d => d.type === 'tool_end' && d.success === false), '被拦调用应产出 success=false 的 tool_end');
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'recovered'), '拦截后应续跑收尾');
	});

	test('halt 护栏：同名工具失败 8 次（参数各异）⇒ 整轮收尾后退出主循环', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				// 参数各异 ⇒ 不触发 detectToolCallLoop（同签名）与 no-progress（同结果需成功态）
				yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'file_read', arguments: `{"path":"/x${round}"}` } } as IModelDelta;
				yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
			},
		} as unknown as IModelProvider;
		const host = makeHost({
			_executeToolCalls: async (tcs) => tcs.map(tc => ({ toolCallId: tc.id, content: 'ENOENT: no such file', success: false })),
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));

		assert.strictEqual(round, 8, 'sameToolFailureHaltAfter=8：第 8 次失败后 halt，不得有第 9 轮（实际轮数: ' + round + '）');
		assert.ok(deltas.filter(d => d.type === 'tool_end' && d.success === false).length === 8, '8 次失败执行都应有 tool_end(false)');
		assert.strictEqual(deltas[deltas.length - 1]!.type, 'done');
	});

	test('撞顶收尾轮：maxTurns 撞顶且模型仍在要工具 ⇒ 跑一轮禁工具收尾（toolChoice:none + 提醒注入）再硬停', async () => {
		let round = 0;
		const captured: Array<{ msgs: unknown; opts: unknown }> = [];
		const provider = {
			chat: (_id: string, msgs: unknown, opts: unknown) => {
				captured.push({ msgs: structuredClone(msgs) as unknown, opts });
				return (async function* (): AsyncIterable<IModelDelta> {
					round++;
					if (round <= 2) {
						yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'file_read', arguments: `{"path":"/x${round}"}` } } as IModelDelta;
						yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
					} else {
						yield { type: 'text', content: 'WRAPUP_FINAL' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		} as unknown as IModelProvider;
		const seen: string[] = [];
		const host = makeHost({
			_executeToolCalls: async (tcs) => { seen.push(tcs[0]!.id); return [{ toolCallId: tcs[0]!.id, content: 'ok', success: true }]; },
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
			maxTurns: 2,
		}));

		assert.strictEqual(captured.length, 3, '2 轮正常 + 1 轮收尾');
		// 收尾轮禁工具（对齐 executor:1428 toolChoice:'none'）
		assert.strictEqual((captured[2]!.opts as { toolChoice?: string }).toolChoice, 'none', '收尾轮必须 toolChoice:none');
		// 收尾轮携带提醒注入（hardLimitWrapUpReminder）
		const wrapMsgs = captured[2]!.msgs as Array<{ role: string; content: string }>;
		assert.ok(wrapMsgs.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Iteration limit reached')), '收尾轮应携带撞顶提醒');
		assert.deepStrictEqual(seen, ['c1', 'c2'], '收尾轮不得执行任何工具');
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'WRAPUP_FINAL'), '收尾轮的文本应上屏');
		assert.strictEqual(deltas[deltas.length - 1]!.type, 'done');
	});

	test('XML 泄漏重试：伪 XML 文本被丢弃（不入 transcript）+ 纠正指令续跑 + discard 事件', async () => {
		let round = 0;
		const captured: unknown[] = [];
		const provider = {
			chat: (_id: string, msgs: unknown) => {
				captured.push(structuredClone(msgs));
				return (async function* (): AsyncIterable<IModelDelta> {
					round++;
					if (round === 1) {
						yield { type: 'text', content: '我来调用工具 <tool_calls:6124c78e>\n<arg_key:6124c78e>{"path":"/x"}</arg_key>' } as IModelDelta;
					} else {
						yield { type: 'text', content: 'CLEAN_ANSWER' } as IModelDelta;
					}
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		} as unknown as IModelProvider;

		const deltas = await collect(runPiKernelTurn(makeHost(), fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));

		assert.strictEqual(round, 2, '泄漏轮被丢弃后应续跑一轮纠正');
		assert.ok(deltas.some(d => d.type === 'discard_prior_text' && (d as { metadata?: { reason?: string } }).metadata?.reason === 'xml-tool-call-leak'), '应发 discard_prior_text 清屏事件');
		const round2Msgs = captured[1] as Array<{ role: string; content: string }>;
		assert.ok(round2Msgs.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('NOT executed')), '纠正指令应以 user 消息注入');
		assert.ok(!round2Msgs.some(m => typeof m.content === 'string' && m.content.includes('tool_calls:6124c78e')), '泄漏文本不得留在 transcript（legacy「跳过入库」语义）');
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'CLEAN_ANSWER'), '纠正轮的文本应上屏');
	});

	test('XML 泄漏超限：重试 2 次后 exhausted 丢弃 + 正常收尾（不再续跑）', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				yield { type: 'text', content: `试第${round}次 <tool_calls:ab12>...` } as IModelDelta;
				yield { type: 'done', finishReason: 'stop' } as IModelDelta;
			},
		} as unknown as IModelProvider;

		const deltas = await collect(runPiKernelTurn(makeHost(), fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));

		assert.strictEqual(round, 3, '首发 + 2 次重试 = 3 轮后必须收尾');
		const discards = deltas.filter(d => d.type === 'discard_prior_text');
		assert.strictEqual(discards.length, 3, '每轮泄漏都应发 discard（2 次 retry + 1 次 exhausted）');
		assert.ok(discards.some(d => (d as { metadata?: { reason?: string } }).metadata?.reason === 'xml-tool-call-leak-exhausted'), '末次应为 exhausted');
		assert.strictEqual(deltas[deltas.length - 1]!.type, 'done');
	});

	test('reasonStreak：同 thinking 连击 ≥3 ⇒ 恢复引导注入下一条工具结果（不阻断执行）', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round <= 4) {
					// 同 thinking 主导 streakKey（reason 优先于工具签名）⇒ 参数各异也连击；
					// 结果各异避免 no-progress 先拦。
					// ⚠ thinking delta 的文本在 `content` 字段（streamAdapter:145 appendThinking）。
					yield { type: 'thinking', content: 'I should read the file' } as IModelDelta;
					yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'file_read', arguments: `{"path":"/x${round}"}` } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'done' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;
		const results: string[] = [];
		const host = makeHost({
			_executeToolCalls: async (tcs) => tcs.map(tc => ({ toolCallId: tc.id, content: 'R_' + tc.id, success: true })),
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));
		for (const d of deltas) { if (d.type === 'tool_result') { results.push(String(d.content)); } }

		assert.ok(results.some(r => r.includes('system-reminder')), '连击 ≥3 后恢复引导应注入工具结果（模型可见）');
		assert.strictEqual(results.length, 4, 'streak 提醒不阻断执行（四轮工具都执行了）');
		assert.strictEqual(deltas[deltas.length - 1]!.type, 'done');
	});

	test('连续失败熔断：同名工具连败 3 次 ⇒ 提醒注入结果（任一成功清零）', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round <= 3) {
					// 参数各异：不触发循环检测/no-progress；连败 3 次触发 consecutiveFail
					yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'file_read', arguments: `{"path":"/x${round}"}` } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'fallback' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;
		const host = makeHost({
			_executeToolCalls: async (tcs) => tcs.map(tc => ({ toolCallId: tc.id, content: 'ENOENT', success: false })),
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));
		const toolResults = deltas.filter(d => d.type === 'tool_result').map(d => String(d.content));

		assert.strictEqual(toolResults.length, 3);
		assert.ok(!toolResults[0]!.includes('system-reminder') && !toolResults[1]!.includes('system-reminder'), '前两次失败不应注入');
		assert.ok(toolResults[2]!.includes('system-reminder'), '第 3 次连败的结果应携带 consecutiveFail 提醒');
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'fallback'), '提醒不阻断：模型可收尾');
	});

	test('terminal 空输出连击：3 次 (no output) ⇒ 提醒注入第 3 条结果（非空输出清零）', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round <= 3) {
					yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'terminal', arguments: `{"command":"cmd${round}"}` } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'stop' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;
		// success=true 但内容 '(no output)'（exit 0 空输出 —— 不走失败追踪，需独立检测）
		const host = makeHost({
			_executeToolCalls: async (tcs) => tcs.map(tc => ({ toolCallId: tc.id, content: '(no output)', success: true })),
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'terminal', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));
		const toolResults = deltas.filter(d => d.type === 'tool_result').map(d => String(d.content));

		assert.strictEqual(toolResults.length, 3);
		assert.ok(!toolResults[0]!.includes('system-reminder') && !toolResults[1]!.includes('system-reminder'), '前两次空输出不应注入');
		assert.ok(toolResults[2]!.includes('system-reminder'), '第 3 次空输出的结果应携带提醒');
	});

	test('argument_churn：同工具参数各异连击 5 次 ⇒ 引导注入一次（段内不重发）', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round <= 6) {
					yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'grep_tool', arguments: `{"q":"term${round}"}` } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'ok' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;
		const host = makeHost({
			_executeToolCalls: async (tcs) => tcs.map(tc => ({ toolCallId: tc.id, content: 'hits_' + tc.id, success: true })),
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'grep_tool', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));
		const toolResults = deltas.filter(d => d.type === 'tool_result').map(d => String(d.content));

		assert.strictEqual(toolResults.length, 6, 'churn 提醒不阻断执行');
		const reminded = toolResults.filter(r => r.includes('system-reminder'));
		assert.strictEqual(reminded.length, 1, '同一段连击只注入一次引导');
		assert.ok(reminded[0]!.includes('grep_tool'), '提醒应指名工具');
	});

	test('文本搜索连击硬上限：search_files 连败 8 次 ⇒ 强制禁工具收尾轮（toolChoice:none + wrap-up 提醒）', async () => {
		let round = 0;
		const captured: Array<{ msgs: unknown; opts: unknown }> = [];
		const provider = {
			chat: (_id: string, msgs: unknown, opts: unknown) => {
				captured.push({ msgs: structuredClone(msgs) as unknown, opts });
				return (async function* (): AsyncIterable<IModelDelta> {
					round++;
					if (round <= 8) {
						yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'search_files', arguments: `{"q":"term${round}"}` } } as IModelDelta;
						yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
					} else {
						yield { type: 'text', content: 'FORCED_WRAPUP_ANSWER' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		} as unknown as IModelProvider;
		const seen: string[] = [];
		const host = makeHost({
			_executeToolCalls: async (tcs) => { seen.push(tcs[0]!.id); return [{ toolCallId: tcs[0]!.id, content: 'hits_' + tcs[0]!.id, success: true }]; },
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'search_files', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));

		assert.strictEqual(captured.length, 9, '8 轮搜索 + 1 轮强制收尾');
		assert.deepStrictEqual(seen, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'], '收尾轮不得执行工具');
		assert.strictEqual((captured[8]!.opts as { toolChoice?: string }).toolChoice, 'none', '强制收尾轮必须禁工具');
		const wrapMsgs = captured[8]!.msgs as Array<{ role: string; content: string }>;
		assert.ok(wrapMsgs.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('system-reminder')), '收尾轮应携带 textSearchLoopWrapUpReminder');
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'FORCED_WRAPUP_ANSWER'), '强制收尾轮的文本应上屏');
		assert.strictEqual(deltas[deltas.length - 1]!.type, 'done');
	});

	test('单只读工具连击：连续 4 轮单工具串行 ⇒ 批量并行引导注入第 4 条结果', async () => {
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round <= 4) {
					// 参数+结果各异：隔离其它护栏，只留单工具连击
					yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'file_read', arguments: `{"path":"/f${round}"}` } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'ok' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;
		const host = makeHost({
			_executeToolCalls: async (tcs) => tcs.map(tc => ({ toolCallId: tc.id, content: 'content_' + tc.id, success: true })),
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));
		const toolResults = deltas.filter(d => d.type === 'tool_result').map(d => String(d.content));

		assert.strictEqual(toolResults.length, 4, '引导不阻断执行');
		assert.ok(toolResults[3]!.includes('system-reminder'), '第 4 轮（连击达阈值）的结果应携带批量并行引导');
		assert.ok(!toolResults[0]!.includes('system-reminder') && !toolResults[1]!.includes('system-reminder') && !toolResults[2]!.includes('system-reminder'), '前 3 轮不注入');
	});

	test('全批拦截连击：三档升级（≥2 强提醒直写 transcript / ≥4 强制禁工具收尾轮）', async () => {
		let round = 0;
		const captured: Array<{ msgs: unknown; opts: unknown }> = [];
		const provider = {
			chat: (_id: string, msgs: unknown, opts: unknown) => {
				captured.push({ msgs: structuredClone(msgs) as unknown, opts });
				return (async function* (): AsyncIterable<IModelDelta> {
					round++;
					if (round <= 6) {
						// 同签名+同结果 ⇒ 第 3 轮起每次都被 no-progress 拦（每轮单调用 ⇒ 全批拦截）
						yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'file_read', arguments: '{"path":"/stuck"}' } } as IModelDelta;
						yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
					} else {
						yield { type: 'text', content: 'FORCED_ANSWER' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		} as unknown as IModelProvider;
		const seen: string[] = [];
		const host = makeHost({
			_executeToolCalls: async (tcs) => { seen.push(tcs[0]!.id); return [{ toolCallId: tcs[0]!.id, content: 'STUCK_SAME', success: true }]; },
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
		}));

		// r1/r2 执行，r3-r6 全批被拦（streak 1..4）：r4(streak2) ⇒ 强提醒；r6(streak4) ⇒ 强制收尾
		assert.deepStrictEqual(seen, ['c1', 'c2'], '被拦轮不得执行');
		// 强提醒（streak=2，r4 轮后直写 transcript）⇒ r5 的模型请求可见
		const r5Msgs = captured[4]!.msgs as Array<{ role: string; content: string }>;
		assert.ok(r5Msgs.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('system-reminder')), 'streak≥2 ⇒ 强提醒直写 transcript');
		// streak=4 ⇒ 强制收尾轮（r7）：禁工具 + wrap-up 提醒
		const last = captured[captured.length - 1]!;
		assert.strictEqual((last.opts as { toolChoice?: string }).toolChoice, 'none', 'streak≥4 ⇒ 强制禁工具收尾轮');
		const wrapMsgs = last.msgs as Array<{ role: string; content: string }>;
		assert.ok(wrapMsgs.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('DISABLED')), '收尾轮提醒应明确"工具已被禁用"（allBlockedWrapUpReminder）');
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'FORCED_ANSWER'), '强制收尾轮的文本应上屏');
		assert.strictEqual(deltas[deltas.length - 1]!.type, 'done');
	});

	test('未完成轮续跑：空响应 ⇒ 丢弃+续跑指令重试（上限 2 次后收尾）', async () => {
		let round = 0;
		const captured: unknown[] = [];
		const provider = {
			chat: (_id: string, msgs: unknown) => {
				captured.push(structuredClone(msgs));
				return (async function* (): AsyncIterable<IModelDelta> {
					round++;
					if (round <= 2) {
						// 空响应：无文本无思考无工具，finishReason=stop
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					} else {
						yield { type: 'text', content: 'REAL_ANSWER' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		} as unknown as IModelProvider;

		const deltas = await collect(runPiKernelTurn(makeHost(), fakeRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: [],
			messages: [{ role: 'user', content: 'go' }],
		}));

		assert.strictEqual(round, 3, '2 次空响应各续跑一次 + 第 3 轮出答案');
		assert.strictEqual(deltas.filter(d => d.type === 'discard_prior_text').length, 2, '空轮应发 discard（空文本无参考价值）');
		const round3Msgs = captured[2] as Array<{ role: string; content: string }>;
		assert.ok(round3Msgs.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('system-reminder')).length >= 2, '续跑指令应注入两次');
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'REAL_ANSWER'));
		assert.strictEqual(deltas[deltas.length - 1]!.type, 'done');
	});

	test('未完成轮续跑：length 截断 ⇒ **保留**半截文本续写（不 discard）', async () => {
		let round = 0;
		const captured: unknown[] = [];
		const provider = {
			chat: (_id: string, msgs: unknown) => {
				captured.push(structuredClone(msgs));
				return (async function* (): AsyncIterable<IModelDelta> {
					round++;
					if (round === 1) {
						yield { type: 'text', content: '这是一段完整的半截回答，句子完整收尾。' } as IModelDelta;
						yield { type: 'done', finishReason: 'length' } as IModelDelta;
					} else {
						yield { type: 'text', content: 'CONTINUATION' } as IModelDelta;
						yield { type: 'done', finishReason: 'stop' } as IModelDelta;
					}
				})();
			},
		} as unknown as IModelProvider;

		const deltas = await collect(runPiKernelTurn(makeHost(), fakeRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: [],
			messages: [{ role: 'user', content: 'go' }],
		}));

		assert.strictEqual(round, 2, '截断续写一轮');
		assert.ok(!deltas.some(d => d.type === 'discard_prior_text'), 'length 截断刻意不 discard（半截是有效产物）');
		const round2Msgs = captured[1] as Array<{ role: string; content: string }>;
		assert.ok(round2Msgs.some(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('半截回答')), '半截文本应留在 transcript（续写语义）');
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'CONTINUATION'));
		assert.strictEqual(deltas[deltas.length - 1]!.type, 'done');
	});

	test('转录卫生：种子里的孤儿 tool 对在首次模型调用前被摘除（不再逼 LMBridge 每轮重剥）', async () => {
		const captured: unknown[][] = [];
		const provider = {
			chat: (_id: string, msgs: unknown) => {
				captured.push(structuredClone(msgs) as unknown[]);
				return (async function* (): AsyncIterable<IModelDelta> {
					yield { type: 'text', content: 'ok' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				})();
			},
		} as unknown as IModelProvider;
		// 种子带一条孤儿：assistant 写了 toolCall 但没有任何 result（收尾轮/中断的历史遗留）
		const seed = [
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: [{ type: 'toolCall', id: 'orphan-1', name: 'file_read', arguments: { path: '/x' } }] },
		] as never[];

		await collect(runPiKernelTurn(makeHost(), fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: seed,
		}));

		const sent = JSON.stringify(captured[0]);
		assert.ok(!sent.includes('orphan-1'), `孤儿 tool call 必须在首次模型调用前摘除（实际: ${sent.slice(0, 200)}）`);
	});

	test('转录卫生：收尾轮跳过执行的 tool calls 就地摘除（日志可见计数）', async () => {
		const logs: string[] = [];
		const logger = { info: (m: string) => logs.push(String(m)), warn: () => { /* */ }, error: () => { /* */ }, debug: () => { /* */ }, trace: () => { /* */ } };
		// 模型每轮都要工具 ⇒ 撞 maxTurns 后跑收尾轮，收尾轮里模型仍写工具调用（不执行）
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				yield { type: 'tool_call', toolCall: { id: `c${Math.random()}`, name: 'file_read', arguments: `{"path":"/x${Math.random()}"}` } } as IModelDelta;
				yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
			},
		} as unknown as IModelProvider;
		const host = makeHost({
			_logService: logger as never,
			_executeToolCalls: async (tcs) => tcs.map(tc => ({ toolCallId: tc.id, content: 'R_' + tc.id, success: true })),
		});

		const deltas = await collect(runPiKernelTurn(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection,
			enabledTools: [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never],
			messages: [{ role: 'user', content: 'go' }],
			maxTurns: 2,
		}));

		assert.strictEqual(deltas[deltas.length - 1]!.type, 'done', '收尾轮后必须终结');
		assert.ok(logs.some(l => l.includes('transcript hygiene')), `收尾轮的悬空调用应被摘除并记日志（实际日志: ${logs.filter(l => l.includes('PiKernel')).slice(0, 3).join(' | ')}）`);
	});
});

// ─── ★★★ 附件上下文必须进入 pi 转录（2026-09-20：片段-only 消息曾变成空 user 消息 ✗✓）──────

/**
 * 用户报「发送代码片段时，好像 llm 没有收到，回答与提问不匹配」✓。
 *
 * 真机取证（`vscode-app-1789910557666.log` ✓）：`msgLen=0` ✓、全日志**无** `--- File:` ✓、
 * `[AgentOS] pi-kernel gate ON`（本 turn 由 piLoop 驱动 ✓）而 `piLoop/` 里 `contentParts` 零命中 ✗。
 *
 * 根因：本转换器对 user 消息**只取 `content`** ✗ ⇒ 片段-only 消息（用户没打文字 ✓ content 为空 ✗）
 * 到 pi 内核就是**空 user 消息** ⇒ 模型凭空作答 ✓✓。
 * 修法：把 `contentParts` 的**文本块**并进 content ✓（优先取它、否则回落 content，**不叠加** ✓）。
 */
suite('pi 转录必须携带附件上下文（2026-09-20）', () => {

	test('★★★ 片段-only 用户消息（content 空 + contentParts 文本块）⇒ pi content 必须含附件正文', () => {
		const fileBlock = '\n\n--- File: code-snippet.txt ---\nconst a = 1;\n--- End of code-snippet.txt ---';
		const msg: any = {
			role: 'user',
			content: '',
			contentParts: [
				{ type: 'text', text: '<user_query></user_query>' },
				{ type: 'text', text: fileBlock },
			],
		};
		const out = loopMessagesToPiMessages([msg]);
		const content = String((out[0] as { content?: unknown }).content ?? '');
		assert.ok(content.includes('code-snippet.txt'), '片段文件名必须进入转录 ✗（否则模型看不到附件 ✓）');
		assert.ok(content.includes('const a = 1;'), '片段**正文**必须进入转录 ✗✗（本 bug 的核心 ✓）');
	});

	test('★★ 无附件消息不受影响（回落 content，避免行为漂移 ✓）', () => {
		const msg: any = { role: 'user', content: '你好' };
		const out = loopMessagesToPiMessages([msg]);
		assert.strictEqual((out[0] as { content?: unknown }).content, '你好');
	});

	test('★★ contentParts 只有非文本块时不吞掉原 content（防误伤 ✓）', () => {
		const msg: any = { role: 'user', content: '看这张图', contentParts: [{ type: 'image' }] };
		const out = loopMessagesToPiMessages([msg]);
		assert.strictEqual((out[0] as { content?: unknown }).content, '看这张图');
	});
});
