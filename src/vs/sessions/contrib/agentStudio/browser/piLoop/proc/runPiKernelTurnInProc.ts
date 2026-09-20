/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 父进程侧驱动：在隔离体里跑 piLoop 内核（P0 = worker_threads spike）。
 *
 * 职责单一：spawn worker → 把 worker 的 RPC 请求分发给**本进程的真 host/真 provider**
 * （审批/沙箱/记忆/持久化全部不搬家）→ 把 delta 流原样桥给调用方。
 * 与进程内 `runPiKernelTurn` 的输出契约完全一致（IChatStreamDelta 流），
 * 调用方（P1 的 dispatch `isolation_level:'process'` 档）无感知。
 *
 * 终结并账：worker 的 token/压缩计数器在 turn 结束时 patch 回真 host（语义 =
 * legacy 的累计字段——总量加合、per-agent map 按 key 覆盖）。
 *
 * ⚠ 入口解析约定：默认取本模块的同名 transpile 产物（生产环境 = 同目录
 * kernelProcWorkerEntry.js）；测试经 `opts.workerEntryUrl` 显式指到 out/ 产物
 * （测试从 src/ 以 TS 形态加载本模块，import.meta.url 不含产物路径）。
 */

import type { IAgentTurnRequest, IChatStreamDelta, IModelProvider } from '../../../common/providers.js';
import { sanitizeRequestForProc, type IProcEndPatch, type ToParentMessage, type ToWorkerMessage } from './kernelProcProtocol.js';
import { workerThreadsTransportFactory, type IKernelProcTransport, type KernelProcTransportFactory } from './kernelProcTransport.js';
import type { IPiKernelHost, PiKernelTurnDeps } from '../piTurnKernel.js';

export interface IPiKernelProcOptions {
	/** worker 入口（ transpile 产物 .js 的 file URL/路径）。测试必传（worker_threads 传输）。 */
	readonly workerEntryUrl?: URL;
	/** 传输工厂（P1 生产 = utilityProcess；缺省 = worker_threads + workerEntryUrl）。 */
	readonly transportFactory?: KernelProcTransportFactory;
	/**
	 * 预取的隔离体句柄（门控先 `await factory()` 再传进来，使「fork 失败」能在
	 * **产出任何 delta 之前**被捕获并回落进程内档 —— 见 agentTurnExecutor 的门控）。
	 * 提供时忽略 transportFactory/workerEntryUrl。
	 */
	readonly transport?: IKernelProcTransport;
}

export async function* runPiKernelTurnInProc(
	host: IPiKernelHost,
	request: IAgentTurnRequest,
	deps: PiKernelTurnDeps,
	opts?: IPiKernelProcOptions,
): AsyncGenerator<IChatStreamDelta, void> {
	// 惰性取传输：预取句柄优先（`??` 短路 ⇒ 不构造默认 URL —— 测试 harness 以 CJS 包裹
	// 加载本模块时 `import.meta.url` 不可用，当前置求值会直接抛 Invalid URL）。
	const proc = opts?.transport
		?? await (opts?.transportFactory
			?? workerThreadsTransportFactory(opts?.workerEntryUrl ?? new URL('./kernelProcWorkerEntry.js', import.meta.url)))();

	// 父侧 abort ⇒ 通知隔离体（其本地 AbortController 驱动 loop 停止）；
	// 工具执行侧的天然 abort：RPC 分发时把父侧真实 signal 传给真 host（见下）。
	const parentSignal = host._loopAbortController?.signal;
	const onParentAbort = (): void => { postTo(proc, { t: 'abort' }); };
	parentSignal?.addEventListener('abort', onParentAbort, { once: true });

	// delta 缓冲 + 唤醒（与 runPiKernelTurn 同款桥）
	const pending: IChatStreamDelta[] = [];
	let notify: (() => void) | undefined;
	let ended = false;
	let endError: Error | undefined;
	const wake = (): void => { const n = notify; notify = undefined; n?.(); };

	const fail = (err: Error): void => { if (!ended) { ended = true; endError = err; wake(); } };

	proc.onMessage((msg: ToParentMessage) => {
		switch (msg.t) {
			case 'delta':
				pending.push(msg.delta);
				wake();
				break;
			case 'checkpoint':
				// 快照桥回真 sink（D2 语义跨边界保持）
				void request.checkpointSink?.(msg.snapshot as never);
				break;
			case 'log':
				host._logService[msg.level === 'error' ? 'error' : msg.level](msg.msg);
				break;
			case 'rpc':
				void dispatchRpc(host, proc, msg.id, msg.m, msg.args, parentSignal, deps.modelProvider);
				break;
			case 'rpc-open':
				void dispatchModelChat(proc, msg.id, deps.modelProvider, msg.args, parentSignal);
				break;
			case 'rpc-notify':
				dispatchNotify(host, msg.m, msg.args, deps.modelProvider);
				break;
			case 'end':
				applyPatch(host, msg.patch);
				if (msg.error) {
					const err = new Error(msg.error.message);
					err.stack = msg.error.stack; err.name = msg.error.name ?? 'Error';
					endError = err;
				}
				ended = true;
				wake();
				break;
		}
	});

	proc.onExit(info => {
		if (!ended) { fail(new Error(`[proc] kernel 隔离体过早退出（${info}）`)); }
	});

	postTo(proc, {
		t: 'start',
		payload: {
			request: sanitizeRequestForProc(request),
			selection: deps.selection,
			enabledTools: deps.enabledTools,
			messages: deps.messages,
			maxTurns: deps.maxTurns,
			workspaceId: host._currentWorkspaceId,
		},
	});

	try {
		while (true) {
			while (pending.length > 0) { yield pending.shift()!; }
			if (ended) {
				if (endError) { throw endError; }
				return;
			}
			await new Promise<void>(r => { notify = r; });
		}
	} finally {
		parentSignal?.removeEventListener('abort', onParentAbort);
		await proc.dispose();
	}
}

function postTo(proc: IKernelProcTransport, msg: ToWorkerMessage): void {
	proc.post(msg);
}

// ─── RPC 分发（worker 请求 ⇒ 本进程真 host）───────────────────

/** worker 侧 provider 桩的过界标记（见到即换回真 provider）。 */
function isModelStubMarker(v: unknown): boolean {
	return typeof v === 'object' && v !== null && (v as { __procModelStub?: unknown }).__procModelStub === true;
}

async function dispatchRpc(host: IPiKernelHost, proc: IKernelProcTransport,
	id: number,
	method: string,
	args: readonly unknown[],
	parentSignal: AbortSignal | undefined,
	modelProvider: IModelProvider,
): Promise<void> {
	try {
		let value: unknown;
		switch (method) {
			case '_executeToolCalls': {
				// 第三个参数（abortSignal）不可过界：换成父侧真实 signal —— 父 abort
				// 时父侧工具执行同样中断（与 worker 侧 loop abort 平行生效）。
				const [toolCalls, agentId, worktreePath, , askRouting, agentSessionId] = args;
				value = await host._executeToolCalls(toolCalls as never, agentId as string, worktreePath as string | undefined, parentSignal, askRouting, agentSessionId as string | undefined);
				break;
			}
			case '_resolveContextWindow':
				value = await host._resolveContextWindow(isModelStubMarker(args[0]) ? modelProvider : args[0] as never, args[1] as string);
				break;
			case '_storeTurnObservations':
				value = await host._storeTurnObservations(isModelStubMarker(args[0]) ? modelProvider as never : args[0] as never, args[1] as string, args[2] as string, args[3] as never);
				break;
			case '_retrieveCompactionContext':
				value = await host._retrieveCompactionContext(isModelStubMarker(args[0]) ? modelProvider as never : args[0] as never, args[1]);
				break;
			default:
				throw new Error(`[proc] unknown rpc method: ${method}`);
		}
		postTo(proc, { t: 'rpc-res', id, ok: true, value });
	} catch (err) {
		postTo(proc, { t: 'rpc-res', id, ok: false, error: err instanceof Error ? err.message : String(err) });
	}
}

function dispatchNotify(host: IPiKernelHost, method: string, args: readonly unknown[], modelProvider: IModelProvider): void {
	try {
		switch (method) {
			case '_observeToolResult':
				host._observeToolResult?.(args[0] as string, args[1] as never, args[2] as string | undefined);
				break;
			case '_setCurrentModel':
				host._setCurrentModel(isModelStubMarker(args[0]) ? modelProvider : args[0] as never, args[1] as string | undefined);
				break;
		}
	} catch { /* 通知面吞错：观测性失败不打断 turn */ }
}

/** model.chat 流式分发：真 provider 的 AsyncIterable 逐 chunk 回 worker。
 *  父 abort ⇒ 停止泵流（for-await 退出会对真 provider 迭代器调 return() 卸载流）。 */
async function dispatchModelChat(proc: IKernelProcTransport, id: number, provider: IModelProvider, args: readonly unknown[], parentSignal: AbortSignal | undefined): Promise<void> {
	try {
		const [modelId, messages, options, context] = args;
		for await (const delta of provider.chat(modelId as string, messages as never, options as never, context as never)) {
			if (parentSignal?.aborted) { break; }
			postTo(proc, { t: 'rpc-chunk', id, value: delta });
		}
		postTo(proc, { t: 'rpc-end', id });
	} catch (err) {
		postTo(proc, { t: 'rpc-err', id, error: err instanceof Error ? err.message : String(err) });
	}
}

// ─── 终结并账（worker 本地计数 ⇒ 真 host）─────────────────────

function applyPatch(host: IPiKernelHost, patch: IProcEndPatch): void {
	host._totalInputTokens += patch.totalInputTokens;
	host._totalOutputTokens += patch.totalOutputTokens;
	host._totalCachedTokens += patch.totalCachedTokens;
	for (const [k, v] of patch.lastRealPromptTokens) { host._lastRealPromptTokensByAgent.set(k, v); }
	for (const [k, v] of patch.lastAssistantAt) { host._lastAssistantAtByAgent.set(k, v); }
	const mutable = host as unknown as { _compressionCount: number; _compressionIneffectiveCount: number };
	mutable._compressionCount += patch.compressionCount;
	mutable._compressionIneffectiveCount += patch.compressionIneffectiveCount;
}
