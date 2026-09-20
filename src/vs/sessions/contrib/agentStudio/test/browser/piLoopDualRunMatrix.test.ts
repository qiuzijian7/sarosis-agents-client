/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * piLoop **对拍矩阵**（2026-09-20，重构方案「阶段 0」的 harness 雏形）。
 *
 * 与 `piLoopDualRun.test.ts`（单形态）的关系：把"同一夹具、两条路径、可观测序列必须一致"
 * 的方法**矩阵化**到 15 种 turn 形态 —— 1-5 基础形态（纯文本/单工具/双工具/错误恢复/无进展
 * 循环）、6-10 交互与上下文（steering 插话/follow-up 续跑/多轮工具链/thinking 流/压缩实触发）、
 * 11-15 晚接入面（XML 泄漏重试/未完成轮重试/length 截断续写/resumeFrom/plan_enter 拦截）。
 *
 * 路径侧用**生产门控路径**（`runPiKernelTurn`，含检索注入跳过、压缩跳过、护栏、usage 记账），
 * 而非裸 `runAgentLoop` —— 对拍的是用户真实会走到的代码。
 *
 * 金标准侧按 executor 契约手工复现（text 即时、tool_start+tool_args 随流、assistant_turn
 * 在消息定稿时（工具执行**之前**）、tool_result/tool_end 随执行、done 收尾）。
 *
 * ⚠ 形态 5（无进展循环）的拦截**文案**两侧实现不同（legacy `buildLoopBlockFeedback` vs
 *   piLoop 合成错误结果），该形态只比对 delta 类型序列与 success 标志 + 执行次数，
 *   不比对拦截文本（对拍豁免项，已记录在重构方案 §测试先行）。
 */
import assert from 'assert';
import type { IAgentTurnRequest, IChatStreamDelta, IModelDelta, IModelProvider, IModelSelection } from '../../common/providers.js';
import { createDeliveryQueue, type DeliveryQueue } from '../../common/deliveryQueue.js';
import { runPiKernelTurn, type IPiKernelHost } from '../../browser/piLoop/piTurnKernel.js';
import type { IContextCompactionManager } from '../../browser/parts/turnContextCompaction.js';

const silentLog = { info() { /* */ }, warn() { /* */ }, error() { /* */ } } as unknown as IPiKernelHost['_logService'];
const fakeSelection = { providerId: 'p', modelId: 'test-model' } as unknown as IModelSelection;
const fakeRequest = { agentId: 'a1', sessionId: 's1' } as IAgentTurnRequest;
const FILE_READ_TOOL = { name: 'file_read', description: '读文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } } as never;
const FILE_STAT_TOOL = { name: 'file_stat', description: '查状态', inputSchema: { type: 'object' } } as never;

interface HostSpy { readonly seenExec: string[]; readonly host: IPiKernelHost }

function makeHostSpy(execResult?: (id: string, name: string) => { content: string; success: boolean }): HostSpy {
	const seenExec: string[] = [];
	const host: IPiKernelHost = {
		_logService: silentLog,
		_executeToolCalls: async (tcs) => {
			seenExec.push(...tcs.map(t => t.id));
			return tcs.map(tc => {
				const r = execResult?.(tc.id, tc.name) ?? { content: 'R_' + tc.name, success: true };
				return { toolCallId: tc.id, content: r.content, success: r.success };
			});
		},
		_totalInputTokens: 0, _totalOutputTokens: 0, _totalCachedTokens: 0,
		_lastRealPromptTokensByAgent: new Map(), _lastAssistantAtByAgent: new Map(),
		_turnKey: (a, s) => `${a ?? ''}:${s ?? ''}`,
		_scheduleSave: () => { /* */ },
		getActiveMemoryProvider: () => undefined,
		_setCurrentModel: () => { /* */ },
		_resolveContextWindow: async () => 128000,
		_storeTurnObservations: async () => { /* */ },
		_retrieveContextOnly: async () => null,
		_injectRetrievalSystemMessage: (msgs) => msgs,
		_estimateMessagesTokens: () => 100, // 低压 ⇒ 压缩恒跳过
		_lastCompressionTime: 0, _lastHardPruneBaselineTokens: 0,
		_compressionCount: 0, _compressionIneffectiveCount: 0,
		_compressionBeforeTokens: 0, _compressionAfterTokens: 0,
		_currentWorkspaceId: 'ws-test',
		_retrieveCompactionContext: async () => null,
	};
	return { seenExec, host };
}

/** 由 fixture 工厂造 provider（每次 chat 调用取下一轮的 delta 序列；可选捕获入参与逐 call 钩子）。 */
function providerOf(
	rounds: ReadonlyArray<ReadonlyArray<IModelDelta>>,
	captured?: Array<{ msgs: unknown; opts: unknown }>,
	onCall?: (roundIndex: number) => void,
): IModelProvider {
	let round = 0;
	return {
		chat: (_id: string, msgs: unknown, opts: unknown): AsyncIterable<IModelDelta> => {
			captured?.push({ msgs: structuredClone(msgs) as unknown, opts });
			onCall?.(round);
			const deltas = rounds[Math.min(round, rounds.length - 1)]!;
			round++;
			return (async function* () { for (const d of deltas) { yield d; } })();
		},
	} as unknown as IModelProvider;
}

interface RunPiExtra {
	readonly tools?: readonly never[];
	readonly steeringQueue?: DeliveryQueue;
	readonly contextManagerFactory?: () => IContextCompactionManager;
	readonly seed?: ReadonlyArray<{ role: string; content: string }>;
	/** 每次模型调用时触发（用于在流式期间入队 steering 等时序敏感操作）。 */
	readonly onCall?: (roundIndex: number) => void;
}

async function runPi(rounds: ReadonlyArray<ReadonlyArray<IModelDelta>>, spy: HostSpy, extra: RunPiExtra = {}, captured?: Array<{ msgs: unknown; opts: unknown }>): Promise<IChatStreamDelta[]> {
	const out: IChatStreamDelta[] = [];
	for await (const d of runPiKernelTurn(spy.host, fakeRequest, {
		modelProvider: providerOf(rounds, captured, extra.onCall), selection: fakeSelection,
		enabledTools: extra.tools ?? [FILE_READ_TOOL],
		messages: (extra.seed ?? [{ role: 'user', content: 'go' }]) as never,
		...(extra.steeringQueue ? { steeringQueue: extra.steeringQueue } : {}),
		...(extra.contextManagerFactory ? { contextManagerFactory: extra.contextManagerFactory } : {}),
	})) { out.push(d); }
	return out;
}

/** 可观测序列（对拍的比较基准）。 */
function observable(deltas: readonly IChatStreamDelta[]): string {
	return deltas.map(d => {
		switch (d.type) {
			case 'text': return `text:${d.content}`;
			case 'thinking': return `thinking:${d.content}`;
			case 'tool_start': return `tool_start:${d.toolName}`;
			case 'tool_args': return `tool_args:${d.content}`;
			case 'tool_result': return `tool_result:${d.content}`;
			case 'tool_end': return `tool_end:${d.success}`;
			case 'assistant_turn': return `assistant_turn:${d.content}`;
			case 'done': return 'done';
			default: return d.type;
		}
	}).join(' > ');
}

function types(deltas: readonly IChatStreamDelta[]): string {
	return deltas.map(d => d.type === 'tool_end' ? `tool_end(${d.success})` : d.type).join(' > ');
}

// ─── 夹具缩写 ───
const T = (content: string): IModelDelta => ({ type: 'text', content } as IModelDelta);
const TC = (id: string, name: string, args: string): IModelDelta => ({ type: 'tool_call', toolCall: { id, name, arguments: args } } as IModelDelta);
const DONE_TOOLS: IModelDelta = { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
const DONE_STOP: IModelDelta = { type: 'done', finishReason: 'stop' } as IModelDelta;

suite('piLoop 对拍矩阵（15 形态 × 生产门控路径 × legacy 金标准）', () => {

	test('形态 1 · 纯文本（无工具）', async () => {
		const spy = makeHostSpy();
		const pi = await runPi([[T('你好。'), DONE_STOP]], spy, { tools: [] });

		const legacy = ['text:你好。', 'assistant_turn:你好。', 'done'].join(' > ');
		assert.strictEqual(observable(pi), legacy);
		assert.deepStrictEqual(spy.seenExec, [], '纯文本不得执行工具');
	});

	test('形态 2 · 单工具单轮', async () => {
		const spy = makeHostSpy();
		const pi = await runPi([
			[T('先读。'), TC('c1', 'file_read', '{"path":"/a"}'), DONE_TOOLS],
			[T('读完了。'), DONE_STOP],
		], spy);

		const legacy = [
			'text:先读。',
			'tool_start:file_read', 'tool_args:{"path":"/a"}',
			'assistant_turn:先读。',
			'tool_result:R_file_read', 'tool_end:true',
			'text:读完了。', 'assistant_turn:读完了。', 'done',
		].join(' > ');
		assert.strictEqual(observable(pi), legacy);
		assert.deepStrictEqual(spy.seenExec, ['c1']);
	});

	test('形态 3 · 同轮双工具（一批两个调用）', async () => {
		const spy = makeHostSpy();
		const pi = await runPi([
			[TC('c1', 'file_read', '{"path":"/a"}'), TC('c2', 'file_stat', '{"path":"/b"}'), DONE_TOOLS],
			[T('两个都好了。'), DONE_STOP],
		], spy, { tools: [FILE_READ_TOOL, FILE_STAT_TOOL] });

		const legacy = [
			'tool_start:file_read', 'tool_args:{"path":"/a"}',
			'tool_start:file_stat', 'tool_args:{"path":"/b"}',
			'assistant_turn:',
			'tool_result:R_file_read', 'tool_end:true',
			'tool_result:R_file_stat', 'tool_end:true',
			'text:两个都好了。', 'assistant_turn:两个都好了。', 'done',
		].join(' > ');
		assert.strictEqual(observable(pi), legacy);
		assert.deepStrictEqual(spy.seenExec.sort(), ['c1', 'c2']);
	});

	test('形态 4 · 工具错误恢复（错误结果回灌后续跑）', async () => {
		const spy = makeHostSpy(() => ({ content: 'EACCES: permission denied', success: false }));
		const pi = await runPi([
			[TC('c1', 'file_read', '{"path":"/root"}'), DONE_TOOLS],
			[T('读不了，换个思路。'), DONE_STOP],
		], spy);

		const legacy = [
			'tool_start:file_read', 'tool_args:{"path":"/root"}',
			'assistant_turn:',
			'tool_result:EACCES: permission denied', 'tool_end:false',
			'text:读不了，换个思路。', 'assistant_turn:读不了，换个思路。', 'done',
		].join(' > ');
		assert.strictEqual(observable(pi), legacy);
		assert.deepStrictEqual(spy.seenExec, ['c1']);
	});

	test('形态 5 · 无进展循环（同签名+同结果：no-progress 第 3 次起持续拦，直到模型换路）', async () => {
		const spy = makeHostSpy();
		const rounds = [
			[TC('c1', 'file_read', '{"path":"/x"}'), DONE_TOOLS],
			[TC('c2', 'file_read', '{"path":"/x"}'), DONE_TOOLS],
			[TC('c3', 'file_read', '{"path":"/x"}'), DONE_TOOLS],
			[TC('c4', 'file_read', '{"path":"/x"}'), DONE_TOOLS],
			[T('不读了，直接回答。'), DONE_STOP],
		];
		const pi = await runPi(rounds, spy);

		// 2026-09-20 起 no-progress 护栏接入（与 legacy 同配置 noProgressBlockAfter=2）：
		// 恒定结果 ⇒ c1/c2 执行，c3 起每次同签名调用都被拦（不再是"第 4 次才拦"）。
		const expectedTypes = [
			'tool_start', 'tool_args', 'assistant_turn', 'tool_result', 'tool_end(true)',
			'tool_start', 'tool_args', 'assistant_turn', 'tool_result', 'tool_end(true)',
			'tool_start', 'tool_args', 'assistant_turn', 'tool_result', 'tool_end(false)',
			'tool_start', 'tool_args', 'assistant_turn', 'tool_result', 'tool_end(false)',
			'text', 'assistant_turn', 'done',
		].join(' > ');
		assert.strictEqual(types(pi), expectedTypes);
		assert.deepStrictEqual(spy.seenExec, ['c1', 'c2'], 'no-progress：第 3 次起同签名+同结果调用全部不得执行');
	});

	test('形态 6 · steering 插话（工具轮之间注入，排进下一次模型调用之前）', async () => {
		const spy = makeHostSpy();
		const queue = createDeliveryQueue();
		queue.enqueue({ from: 'user', to: 'a1', content: '插话：顺便也看下 version 字段' });
		const captured: Array<{ msgs: unknown; opts: unknown }> = [];

		const pi = await runPi([
			[TC('c1', 'file_read', '{"path":"/pkg"}'), DONE_TOOLS],
			[T('都看了：name=vssaros，version 也有。'), DONE_STOP],
		], spy, { steeringQueue: queue }, captured);

		// ① 插话必须出现在第 2 轮模型调用的消息里（user 角色，在工具结果之后）
		assert.strictEqual(captured.length, 2, '两轮模型调用');
		const round2Msgs = captured[1]!.msgs as Array<{ role: string; content: string }>;
		const steeringIdx = round2Msgs.findIndex(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('插话：顺便也看下 version'));
		assert.ok(steeringIdx > 0, `插话应出现在第 2 轮消息中（实际消息: ${JSON.stringify(round2Msgs.map(m => m.role + ':' + String(m.content).slice(0, 20)))})`);
		// ② 队列已确认交付（lease→ack）
		assert.strictEqual(queue.stats().delivered, 1, '插话条目应已 ack');
		// ③ 可观测序列收尾正常
		const t = types(pi);
		assert.ok(t.includes('tool_end(true)') && t.endsWith('text > assistant_turn > done'), `序列: ${t}`);
	});

	test('形态 7 · follow-up 续跑（模型本想停，流式期间到达的插话使其继续）', async () => {
		const spy = makeHostSpy();
		const queue = createDeliveryQueue();
		const captured: Array<{ msgs: unknown; opts: unknown }> = [];

		const pi = await runPi([
			[T('先答这半：name=vssaros。'), DONE_STOP],
			[T('version 是 2.2.26037。'), DONE_STOP],
		], spy, {
			tools: [],
			steeringQueue: queue,
			// ⚠ 场景关键：pi 语义的起始轮询会立即取走预先入队的插话（"user may have typed
			// while waiting"）⇒ 测 follow-up 必须在**第一轮流式期间**入队（第 0 次 call 时）。
			onCall: (roundIndex) => {
				if (roundIndex === 0) { queue.enqueue({ from: 'user', to: 'a1', content: '追问：那 version 呢？' }); }
			},
		}, captured);

		assert.strictEqual(captured.length, 2, '模型本想停（无工具调用），但流式期间到达的插话必须使其续跑出第 2 轮');
		const round2Msgs = captured[1]!.msgs as Array<{ role: string; content: string }>;
		assert.ok(round2Msgs.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('追问：那 version 呢？')), '第 2 轮必须携带插话');
		assert.strictEqual(observable(pi), [
			'text:先答这半：name=vssaros。', 'assistant_turn:先答这半：name=vssaros。',
			'text:version 是 2.2.26037。', 'assistant_turn:version 是 2.2.26037。', 'done',
		].join(' > '));
		assert.strictEqual(queue.stats().delivered, 1);
	});

	test('形态 8 · 多轮工具链（3 个顺序工具轮）', async () => {
		const spy = makeHostSpy();
		const pi = await runPi([
			[TC('c1', 'file_read', '{"path":"/a"}'), DONE_TOOLS],
			[TC('c2', 'file_read', '{"path":"/b"}'), DONE_TOOLS],
			[TC('c3', 'file_read', '{"path":"/c"}'), DONE_TOOLS],
			[T('三份都读完。'), DONE_STOP],
		], spy);

		const legacy = [
			'tool_start:file_read', 'tool_args:{"path":"/a"}', 'assistant_turn:', 'tool_result:R_file_read', 'tool_end:true',
			'tool_start:file_read', 'tool_args:{"path":"/b"}', 'assistant_turn:', 'tool_result:R_file_read', 'tool_end:true',
			'tool_start:file_read', 'tool_args:{"path":"/c"}', 'assistant_turn:', 'tool_result:R_file_read', 'tool_end:true',
			'text:三份都读完。', 'assistant_turn:三份都读完。', 'done',
		].join(' > ');
		assert.strictEqual(observable(pi), legacy);
		assert.deepStrictEqual(spy.seenExec, ['c1', 'c2', 'c3']);
	});

	test('形态 9 · thinking 流（思考增量 + 文本增量）', async () => {
		const spy = makeHostSpy();
		const THINK = (content: string): IModelDelta => ({ type: 'thinking', content } as IModelDelta);
		const pi = await runPi([
			[THINK('先想一步…'), T('结论如下。'), DONE_STOP],
		], spy, { tools: [] });

		assert.strictEqual(observable(pi), [
			'thinking:先想一步…', 'text:结论如下。', 'assistant_turn:结论如下。', 'done',
		].join(' > '));
	});

	test('形态 10 · 压缩实触发（transformContext 真压缩 + context_compacted 上屏 + 写回）', async () => {
		const spy = makeHostSpy();
		let compressCalls = 0;
		const mockManager: IContextCompactionManager = {
			willAttemptCompression: () => true,
			compressContext: async (msgs) => {
				compressCalls++;
				return {
					originalMessageCount: msgs.length, compressedMessageCount: 2, summary: 'S',
					compressedMessages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'SUMMARY' }] as never,
				};
			},
			compressCheckpoint: async (msgs) => ({ originalMessageCount: msgs.length, compressedMessageCount: msgs.length, summary: '', compressedMessages: msgs }),
		};
		const captured: Array<{ msgs: unknown; opts: unknown }> = [];
		// 高压估算 ⇒ 第 1-2 级剪枝门控打开（pressure>=2）
		(spy.host as { _estimateMessagesTokens: (m: readonly unknown[]) => number })._estimateMessagesTokens = (m) => m.length * 50000;

		const pi = await runPi([
			[TC('c1', 'file_read', '{"path":"/x"}'), DONE_TOOLS],
			[T('fin'), DONE_STOP],
		], spy, {
			contextManagerFactory: () => mockManager,
			seed: [
				{ role: 'system', content: 'SYS' }, { role: 'user', content: 'OLD_USER' },
				{ role: 'assistant', content: 'OLD_A' }, { role: 'user', content: 'go' },
			] as never,
		}, captured);

		assert.strictEqual(compressCalls, 1, '压缩应只执行一次（后续撞 cooldown）');
		const t = types(pi);
		assert.ok(t.includes('phase_change') && pi.some(d => d.type === 'context_compacted'), `应有压缩事件: ${t}`);
		// 写回实证：第 2 轮请求携带压缩摘要、不含被丢弃消息
		const round2Msgs = captured[1]!.msgs as Array<{ role: string; content: string }>;
		assert.ok(round2Msgs.some(m => m.content === 'SUMMARY'), '第 2 轮应携带压缩摘要');
		assert.ok(!round2Msgs.some(m => typeof m.content === 'string' && m.content.includes('OLD_USER')), '被压缩丢弃的消息不得再现');
	});

	// ── 形态 11-15：2026-09-20 晚接入面的对拍（XML 泄漏/未完成轮/截断续写/resume/plan）──

	test('形态 11 · XML 泄漏重试（伪 XML 文本丢弃 + discard_prior_text + 纠正续跑）', async () => {
		const spy = makeHostSpy();
		const captured: Array<{ msgs: unknown; opts: unknown }> = [];
		const pi = await runPi([
			[T('调用工具：<tool_calls:ab12cd>\n<arg_key:ab12cd>{"path":"/x"}</arg_key>'), DONE_STOP],
			[T('改用正式调用。'), DONE_STOP],
		], spy, {}, captured);

		// legacy 契约（executor:2294-2368）：泄漏文本 discard + 纠正指令续跑 + transcript 不留泄漏
		const t = types(pi);
		assert.ok(t.includes('discard_prior_text'), `泄漏轮应发 discard_prior_text: ${t}`);
		assert.ok(t.endsWith('text > assistant_turn > done'), `纠正轮正常收尾: ${t}`);
		assert.strictEqual(captured.length, 2, '泄漏轮丢弃后应续跑一轮');
		const round2Msgs = captured[1]!.msgs as Array<{ role: string; content: string }>;
		assert.ok(!round2Msgs.some(m => typeof m.content === 'string' && m.content.includes('tool_calls:ab12cd')), '泄漏文本不得留在 transcript');
		assert.ok(round2Msgs.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('NOT executed')), '纠正指令应注入');
		assert.deepStrictEqual(spy.seenExec, [], '伪 XML 不产生任何真实工具执行');
	});

	test('形态 12 · 未完成轮（空响应：discard + 续跑指令 + 次轮出答案）', async () => {
		const spy = makeHostSpy();
		const captured: Array<{ msgs: unknown; opts: unknown }> = [];
		const pi = await runPi([
			[DONE_STOP], // 空响应：无文本无思考无工具
			[T('这次有答案。'), DONE_STOP],
		], spy, { tools: [] }, captured);

		// legacy 契约（executor:2375-2470）：空轮丢弃 + 续跑指令 + 重试
		assert.strictEqual(captured.length, 2, '空响应应触发一次续跑');
		assert.ok(pi.some(d => d.type === 'discard_prior_text'), '空轮应发 discard_prior_text');
		const round2Msgs = captured[1]!.msgs as Array<{ role: string; content: string }>;
		assert.ok(round2Msgs.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('system-reminder')), '续跑指令应注入第 2 轮');
		assert.ok(types(pi).endsWith('text > assistant_turn > done'), '次轮正常收尾');
	});

	test('形态 13 · length 截断续写（半截文本保留不 discard）', async () => {
		const spy = makeHostSpy();
		const captured: Array<{ msgs: unknown; opts: unknown }> = [];
		const pi = await runPi([
			[T('前半段写完了，句号完整。'), { type: 'done', finishReason: 'length' } as IModelDelta],
			[T('后半段续上。'), DONE_STOP],
		], spy, { tools: [] }, captured);

		// legacy 契约：length/truncated-text 保留半截（incompleteTurnDiscardReason 返回 undefined）
		assert.strictEqual(captured.length, 2, '截断应续写一轮');
		assert.ok(!pi.some(d => d.type === 'discard_prior_text'), 'length 截断刻意不 discard');
		const round2Msgs = captured[1]!.msgs as Array<{ role: string; content: unknown }>;
		assert.ok(round2Msgs.some(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('前半段写完了')), '半截文本应留在 transcript 供续写');
		assert.ok(types(pi).endsWith('text > assistant_turn > done'));
	});

	test('形态 14 · resumeFrom 断点续跑（checkpoint 种子优先 + 迭代扣减）', async () => {
		const spy = makeHostSpy();
		const captured: Array<{ msgs: unknown; opts: unknown }> = [];
		const resumedRequest = {
			...fakeRequest,
			resumeFrom: {
				messages: [
					{ role: 'system', content: 'SYS' },
					{ role: 'user', content: 'RESTORED_QUESTION' },
				],
				iteration: 1,
			},
		} as unknown as IAgentTurnRequest;
		const out: IChatStreamDelta[] = [];
		for await (const d of runPiKernelTurn(spy.host, resumedRequest, {
			modelProvider: providerOf([[T('续跑的答案。'), DONE_STOP]], captured), selection: fakeSelection,
			enabledTools: [], messages: [{ role: 'user', content: 'IGNORED_NEW_MSG' }] as never,
		})) { out.push(d); }

		// legacy 契约（executor:691-711）：checkpoint 消息恢复 > 上下文构建结果
		const msgs = captured[0]!.msgs as Array<{ role: string; content: string }>;
		assert.ok(msgs.some(m => m.content === 'RESTORED_QUESTION'), 'checkpoint 消息应成为种子');
		assert.ok(!msgs.some(m => typeof m.content === 'string' && m.content.includes('IGNORED_NEW_MSG')), '新上下文被 checkpoint 覆盖');
		assert.strictEqual(observable(out), 'text:续跑的答案。 > assistant_turn:续跑的答案。 > done');
	});

	test('形态 15 · plan_enter 批后拦截（模式切换 + 计划文件 + 拦截器消息回灌）', async () => {
		const spy = makeHostSpy();
		// plan 面补齐（IPiKernelHost 的可选 plan 成员）
		const written: string[] = [];
		Object.assign(spy.host as Record<string, unknown>, {
			_writePlanFile: async (p: string) => { written.push(p); },
			_readPlanFile: async () => '',
			_awaitPlanApproval: async () => 'approved',
			_orchestratePlan: async function* () { /* 不到达 */ },
		});
		const captured: Array<{ msgs: unknown; opts: unknown }> = [];
		const pi = await runPi([
			[TC('pe1', 'plan_enter', '{}'), DONE_TOOLS],
			[T('进入计划模式。'), DONE_STOP],
		], spy, { tools: [{ name: 'plan_enter', description: 'x', inputSchema: { type: 'object' } } as never] }, captured);

		// legacy 契约（executor:3667 + turnPlanModeTools）：批后拦截 ⇒ work_mode_changed(plan)
		// + 计划文件创建 + 拦截器 tool 消息回灌 transcript
		assert.strictEqual(written.length, 1, 'plan_enter 应创建计划文件骨架');
		assert.ok(pi.some(d => (d as { workMode?: string }).workMode === 'plan'), '应发 work_mode_changed(plan)');
		assert.ok(pi.some(d => d.type === 'tool_end' && d.success === true && (d as { toolCallId?: string }).toolCallId === 'pe1'), '拦截器补发 success=true 的 tool_end');
		const round2Msgs = captured[1]!.msgs as Array<{ role: string; content: unknown }>;
		assert.ok(round2Msgs.some(m => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('Entered internal plan work mode')), '拦截器 tool 消息应进 transcript');
		assert.ok(types(pi).endsWith('text > assistant_turn > done'), '拦截后 turn 正常收尾');
	});
});
