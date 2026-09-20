/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * pi 内核进程隔离（P0 spike：worker_threads 传输）的行为钉：
 *   1. **双跑对拍**：同一脚本模型/工具，进程内 vs worker 的 delta 序列逐项一致
 *     （工具执行真的回到父进程 —— 审批链不断）；
 *   2. abort：父侧中断 ⇒ worker 内 loop 同步停止，generator 终结不悬挂；
 *   3. checkpoint 桥：worker 的 checkpointSink 桩 ⇒ 父侧真 sink 收到快照（D2 语义跨边界）；
 *   4. 终结并账：worker 的 token 计数在 turn 结束时 patch 回父 host。
 *
 * ⚠ 前置：worker 入口吃 **transpile 产物**（`out/.../proc/kernelProcWorkerEntry.js`）——
 * 跑本套件前先 `npm run transpile-client`（runner 从 src/ 以 TS 加载，worker 不行）。
 */
import assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IAgentTurnRequest, IChatStreamDelta, IModelDelta, IModelProvider, IModelSelection } from '../../common/providers.js';
import { runPiKernelTurn, type IPiKernelHost } from '../../browser/piLoop/piTurnKernel.js';
import { runPiKernelTurnInProc } from '../../browser/piLoop/proc/runPiKernelTurnInProc.js';
import { workerThreadsTransportFactory } from '../../browser/piLoop/proc/kernelProcTransport.js';

const WORKER_ENTRY = path.resolve('out/vs/sessions/contrib/agentStudio/browser/piLoop/proc/kernelProcWorkerEntry.js');

const fakeRequest = { agentId: 'test-agent', sessionId: 'sess-proc', messages: [] } as unknown as IAgentTurnRequest;
const fakeSelection = { modelId: 'm-test', providerId: 'p-test' } as unknown as IModelSelection;

function silentLog(): Record<string, (...a: unknown[]) => void> {
	const noop = (): void => { /* */ };
	return { info: noop, warn: noop, error: noop, debug: noop, trace: noop };
}

function makeHost(overrides?: Partial<IPiKernelHost>): IPiKernelHost {
	return {
		_logService: silentLog() as never,
		_executeToolCalls: async (tcs) => (tcs as Array<{ id: string }>).map(tc => ({ toolCallId: tc.id, content: 'CONTENT_' + tc.id, success: true })),
		_totalInputTokens: 0,
		_totalOutputTokens: 0,
		_totalCachedTokens: 0,
		_lastRealPromptTokensByAgent: new Map(),
		_lastAssistantAtByAgent: new Map(),
		_turnKey: (a, s) => `${a ?? ''}:${s ?? ''}`,
		_scheduleSave: () => { /* */ },
		getActiveMemoryProvider: () => undefined,
		_setCurrentModel: () => { /* */ },
		_resolveContextWindow: async () => 128000,
		_storeTurnObservations: async () => { /* */ },
		_retrieveContextOnly: async () => null,
		_injectRetrievalSystemMessage: (msgs) => msgs,
		_estimateMessagesTokens: (msgs: readonly unknown[]) => msgs.length * 100,
		_lastCompressionTime: 0,
		_lastHardPruneBaselineTokens: 0,
		_compressionCount: 0,
		_compressionIneffectiveCount: 0,
		_compressionBeforeTokens: 0,
		_compressionAfterTokens: 0,
		_currentWorkspaceId: 'ws-test',
		_retrieveCompactionContext: async () => null,
		...overrides,
	} as IPiKernelHost;
}

async function collect(gen: AsyncGenerator<IChatStreamDelta, void>): Promise<IChatStreamDelta[]> {
	const out: IChatStreamDelta[] = [];
	for await (const d of gen) { out.push(d); }
	return out;
}

/** 两轮脚本模型：round1 要工具，round2 文本收尾（带 usage 供并账断言）。 */
function scriptedProvider(): IModelProvider {
	let round = 0;
	return {
		chat: async function* (): AsyncIterable<IModelDelta> {
			round++;
			if (round === 1) {
				yield { type: 'tool_call', toolCall: { id: 'c1', name: 'file_read', arguments: '{"path":"/x"}' } } as IModelDelta;
				yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
			} else {
				yield { type: 'text', content: 'FINAL_ANSWER' } as IModelDelta;
				yield { type: 'usage', usage: { inputTokens: 123, outputTokens: 45, cachedTokens: 10 } } as IModelDelta;
				yield { type: 'done', finishReason: 'stop' } as IModelDelta;
			}
		},
	} as unknown as IModelProvider;
}

const toolDefs = [{ name: 'file_read', description: 'x', inputSchema: { type: 'object' } } as never];
const seedMessages = [{ role: 'user', content: 'go' }] as never[];

suite('piKernelProc（P0 进程隔离 spike）', () => {

	test('双跑对拍：worker 与进程内的 delta 序列逐项一致（工具在父进程执行）', async function () {
		if (!fs.existsSync(WORKER_ENTRY)) {
			this.skip(); // 需先 npm run transpile-client
			return;
		}
		const seenExecParent: string[] = [];
		const hostInProc = makeHost();
		const hostProc = makeHost({
			_executeToolCalls: async (tcs) => {
				for (const tc of tcs as Array<{ id: string }>) { seenExecParent.push(tc.id); }
				return (tcs as Array<{ id: string }>).map(tc => ({ toolCallId: tc.id, content: 'CONTENT_' + tc.id, success: true }));
			},
		});

		const inProc = await collect(runPiKernelTurn(hostInProc, fakeRequest, {
			modelProvider: scriptedProvider(), selection: fakeSelection, enabledTools: toolDefs, messages: seedMessages,
		}));
		// 走 transportFactory 缝（与 executor 门控的调用形态一致）
		const inWorker = await collect(runPiKernelTurnInProc(hostProc, fakeRequest, {
			modelProvider: scriptedProvider(), selection: fakeSelection, enabledTools: toolDefs, messages: seedMessages,
		}, { transportFactory: workerThreadsTransportFactory(pathToFileURL(WORKER_ENTRY)) }));

		// delta 类型序列逐项一致
		const typesOf = (ds: IChatStreamDelta[]): string => ds.map(d => d.type + (d.type === 'tool_end' ? `(success=${(d as { success?: boolean }).success})` : '')).join('>');
		assert.strictEqual(typesOf(inWorker), typesOf(inProc), `序列分叉：\nworker: ${typesOf(inWorker)}\ninproc: ${typesOf(inProc)}`);
		// 工具结果内容一致（父进程执行的结果原样回到 worker transcript）
		const resultText = (ds: IChatStreamDelta[]): string[] => ds.filter(d => d.type === 'tool_result').map(d => String((d as { content?: unknown }).content));
		assert.deepStrictEqual(resultText(inWorker), resultText(inProc));
		assert.deepStrictEqual(seenExecParent, ['c1'], '工具必须回父进程执行');
		// 终结并账：worker 的 usage 累计 patch 回父 host
		assert.strictEqual(hostProc._totalInputTokens, 123, 'input tokens 应并账');
		assert.strictEqual(hostProc._totalOutputTokens, 45);
		assert.strictEqual(hostProc._totalCachedTokens, 10);
		assert.ok(hostProc._lastRealPromptTokensByAgent.size > 0, 'lastRealPromptTokens 应同步');
	});

	test('abort：父侧中断 ⇒ worker 内 loop 停止，generator 终结不悬挂', async function () {
		if (!fs.existsSync(WORKER_ENTRY)) { this.skip(); return; }
		const abort = new AbortController();
		// 慢流模型：每 chunk 间隔 50ms，便于中途 abort
		const slowProvider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				for (let i = 0; i < 100; i++) {
					await new Promise(r => setTimeout(r, 50));
					yield { type: 'text', content: `chunk${i}` } as IModelDelta;
				}
				yield { type: 'done', finishReason: 'stop' } as IModelDelta;
			},
		} as unknown as IModelProvider;
		const host = makeHost({ _loopAbortController: abort });

		const t0 = Date.now();
		const deltas: IChatStreamDelta[] = [];
		const gen = runPiKernelTurnInProc(host, fakeRequest, {
			modelProvider: slowProvider, selection: fakeSelection, enabledTools: toolDefs, messages: seedMessages,
		}, { workerEntryUrl: pathToFileURL(WORKER_ENTRY) });
		for await (const d of gen) {
			deltas.push(d);
			if (deltas.length === 2) { abort.abort(); }
		}
		const elapsed = Date.now() - t0;
		assert.ok(elapsed < 5000, `abort 后必须快速终结（实际 ${elapsed}ms）`);
		assert.ok(deltas.length < 100, 'abort 后不得继续消费完整 100 chunk');
	});

	test('checkpoint 桥：worker 内每 3 轮的快照经消息桥到父侧真 sink', async function () {
		if (!fs.existsSync(WORKER_ENTRY)) { this.skip(); return; }
		const snapshots: unknown[] = [];
		const req = { ...fakeRequest, checkpointSink: (s: unknown) => { snapshots.push(s); } } as unknown as IAgentTurnRequest;
		// 3 轮工具 + 收尾文本 ⇒ 第 3 轮触发快照（absoluteIteration % 3 === 0）
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round <= 3) {
					yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'file_read', arguments: `{"path":"/x${round}"}` } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'done' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;

		const deltas = await collect(runPiKernelTurnInProc(makeHost(), req, {
			modelProvider: provider, selection: fakeSelection, enabledTools: toolDefs, messages: seedMessages,
		}, { workerEntryUrl: pathToFileURL(WORKER_ENTRY) }));

		assert.ok(snapshots.length >= 1, '父侧 sink 应至少收到一次快照');
		assert.strictEqual(deltas[deltas.length - 1]!.type, 'done');
	});

	test('门控契约：预取句柄（transport 选项）可用；工厂抛错须在任何 delta 之前 reject', async function () {
		if (!fs.existsSync(WORKER_ENTRY)) { this.skip(); return; }

		// ① 预取句柄路径（executor 门控先 await factory 再传 transport —— fork 失败可捕获回落）
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				yield { type: 'text', content: 'PRE_ACQUIRED_OK' } as IModelDelta;
				yield { type: 'done', finishReason: 'stop' } as IModelDelta;
			},
		} as unknown as IModelProvider;
		const preAcquired = await workerThreadsTransportFactory(pathToFileURL(WORKER_ENTRY))();
		const deltas = await collect(runPiKernelTurnInProc(makeHost(), fakeRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: toolDefs, messages: seedMessages,
		}, { transport: preAcquired }));
		assert.ok(deltas.some(d => d.type === 'text' && d.content === 'PRE_ACQUIRED_OK'), '预取句柄应能正常跑完 turn');

		// ② 工厂抛错（模拟产物缺失/权限失败）：必须在产出任何 delta 前 reject ⇒ 门控可安全回落
		const failing = () => { throw new Error('fork failed (simulated)'); };
		let yielded = 0;
		let rejected = false;
		try {
			const gen = runPiKernelTurnInProc(makeHost(), fakeRequest, {
				modelProvider: provider, selection: fakeSelection, enabledTools: toolDefs, messages: seedMessages,
			}, { transportFactory: failing });
			for await (const _ of gen) { yielded++; }
		} catch (err) {
			rejected = true;
			assert.ok(String(err).includes('fork failed'), `错误应原样上抛以便门控记日志（实际: ${String(err)}）`);
		}
		assert.ok(rejected, '工厂失败应 reject');
		assert.strictEqual(yielded, 0, '产出任何 delta 之前失败（否则回落会导致重复输出）');
	});

	test('护栏在 worker 内生效：同签名第 4 次被拦（状态驻留隔离体）', async function () {
		if (!fs.existsSync(WORKER_ENTRY)) { this.skip(); return; }
		let round = 0;
		const provider = {
			chat: async function* (): AsyncIterable<IModelDelta> {
				round++;
				if (round <= 4) {
					yield { type: 'tool_call', toolCall: { id: `c${round}`, name: 'file_read', arguments: '{"path":"/same"}' } } as IModelDelta;
					yield { type: 'done', finishReason: 'tool_calls' } as IModelDelta;
				} else {
					yield { type: 'text', content: 'recovered' } as IModelDelta;
					yield { type: 'done', finishReason: 'stop' } as IModelDelta;
				}
			},
		} as unknown as IModelProvider;
		const seen: string[] = [];
		// 结果各异避开 no-progress（它第 3 次就拦——本用例钉的是 detectToolCallLoop）
		const host = makeHost({
			_executeToolCalls: async (tcs) => { for (const tc of tcs as Array<{ id: string }>) { seen.push(tc.id); } return (tcs as Array<{ id: string }>).map(tc => ({ toolCallId: tc.id, content: 'R_' + tc.id, success: true })); },
		});

		const deltas = await collect(runPiKernelTurnInProc(host, fakeRequest, {
			modelProvider: provider, selection: fakeSelection, enabledTools: toolDefs, messages: seedMessages,
		}, { workerEntryUrl: pathToFileURL(WORKER_ENTRY) }));

		assert.deepStrictEqual(seen, ['c1', 'c2', 'c3'], 'worker 内护栏第 4 次拦截（不执行）');
		assert.ok(deltas.some(d => d.type === 'tool_end' && (d as { success?: boolean }).success === false), '被拦调用产出 success=false');
	});
});
