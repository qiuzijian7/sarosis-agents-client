/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内核隔离体的 worker 侧入口（P0 = node worker_threads；P1 换 utilityProcess 时
 * 只换传输三行，协议与 host 代理不变 —— 见 kernelProcProtocol.ts 文件头）。
 *
 * 这里构建的 `IPiKernelHost` 是**父进程真 host 的 RPC 代理**：
 *   · 异步方法（工具执行/模型窗口解析/记忆写回）⇒ 等待回包；
 *   · 模型 chat ⇒ 流式 RPC（rpc-open / rpc-chunk / rpc-end）；
 *   · 计数器与压缩状态 ⇒ **worker 本地累计**，turn 终结时 patch 回父进程并账
 *     （读侧自洽：worker 内产生的值 worker 自己读；父进程 Dashboard 终结时同步）；
 *   · 同步纯函数（_turnKey / _estimateMessagesTokens）⇒ 本地复刻同款实现；
 *   · plan 钩子 ⇒ 不提供（P0 进程档只对只读子代理开放，plan 工具不在其工具集里）；
 *   · 记忆检索 ⇒ P0 不接入（getActiveMemoryProvider 返回 undefined，注入段自动跳过）——
 *     已知差距，P1 评估（子代理 briefing 自包含，影响有限）。
 */

import { runPiKernelTurn, type IPiKernelHost, type PiKernelTurnDeps } from '../piTurnKernel.js';
import { estimateMessagesTokens } from '../../agentContextRetrieval.js';
import type { IModelProvider } from '../../../common/providers.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import { detectChildPort } from './kernelProcTransport.js';
import {
	sanitizeRequestForProc,
	serializeError,
	type IProcTurnStartPayload,
	type ToParentMessage,
	type ToWorkerMessage,
} from './kernelProcProtocol.js';

// 传输自适应：worker_threads 的 parentPort 或 utilityProcess 的 process.parentPort
const port = await detectChildPort();

const post = (msg: ToParentMessage): void => { port.postMessage(msg); };

// ─── RPC 机器 ────────────────────────────────────────────────

let nextRpcId = 1;
const pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const openStreams = new Map<number, { push: (v: unknown) => void; close: (err?: Error) => void }>();

function rpcInvoke<T>(method: string, args: readonly unknown[]): Promise<T> {
	const id = nextRpcId++;
	return new Promise<T>((resolve, reject) => {
		pendingRpc.set(id, { resolve: resolve as (v: unknown) => void, reject });
		post({ t: 'rpc', id, m: method, args });
	});
}

function rpcNotify(method: string, args: readonly unknown[]): void {
	post({ t: 'rpc-notify', m: method, args });
}

/** 流式 RPC（model.chat）：开流 → 逐 chunk 进缓冲 → end/err 收尾。 */
function rpcStream(method: 'model.chat', args: readonly unknown[]): AsyncIterable<unknown> {
	const id = nextRpcId++;
	const buffer: unknown[] = [];
	let waiter: (() => void) | undefined;
	let done = false;
	let failure: Error | undefined;
	openStreams.set(id, {
		push: v => { buffer.push(v); const w = waiter; waiter = undefined; w?.(); },
		close: err => { done = true; failure = err; const w = waiter; waiter = undefined; w?.(); },
	});
	// options（args[2]）可能携带 AbortSignal/函数 ⇒ JSON 往返剥掉（父侧会重注自己的 signal）；
	// 否则 structured clone 直接抛 DataCloneError。
	const safeArgs = args.map((a, i) => (i === 2 && a && typeof a === 'object') ? JSON.parse(JSON.stringify(a)) as unknown : a);
	post({ t: 'rpc-open', id, m: method, args: safeArgs });
	return {
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<unknown>> {
					while (buffer.length === 0 && !done) {
						await new Promise<void>(r => { waiter = r; });
					}
					if (buffer.length > 0) { return { value: buffer.shift(), done: false }; }
					if (failure) { throw failure; }
					return { value: undefined, done: true };
				},
			};
		},
	};
}

// ─── worker 本地 abort（父侧 abort 消息驱动）─────────────────

const abortController = new AbortController();

/** provider 桩过界标记（含函数的对象过不了 structured clone；父侧见到标记换回真 provider）。 */
const MODEL_STUB_MARKER = { __procModelStub: true } as const;

/** 记忆检索缺口只报一次（进程级；隔离体每 turn 新建但模块状态同进程）。 */
let memoryGapReported = false;

// ─── host 代理构建 ───────────────────────────────────────────

function buildProxiedHost(payload: IProcTurnStartPayload): IPiKernelHost {
	const logService = {
		info: (m: string) => post({ t: 'log', level: 'info', msg: String(m) }),
		warn: (m: string) => post({ t: 'log', level: 'warn', msg: String(m) }),
		error: (m: unknown) => post({ t: 'log', level: 'error', msg: String(m) }),
		debug: () => { /* 静默 */ },
		trace: () => { /* 静默 */ },
	} as unknown as ILogService;

	const agentId = payload.request.agentId ?? '';
	const sessionId = payload.request.sessionId;

	const host: Record<string, unknown> = {
		_logService: logService,
		_loopAbortController: abortController,

		// 工具执行 ⇒ 父进程（审批/沙箱/副作用全在父侧，跨不断）
		_executeToolCalls: (toolCalls: unknown, _agentId: string, worktreePath?: string, _signal?: unknown, askRouting?: unknown, agentSessionId?: string) =>
			rpcInvoke('_executeToolCalls', [toolCalls, _agentId, worktreePath, undefined, askRouting, agentSessionId]),
		_observeToolResult: (...args: unknown[]) => rpcNotify('_observeToolResult', args),

		// token 计数器：worker 本地累计，终结时 patch（见 main() 的 end 消息）
		_totalInputTokens: 0,
		_totalOutputTokens: 0,
		_totalCachedTokens: 0,
		_lastRealPromptTokensByAgent: new Map<string, number>(),
		_lastAssistantAtByAgent: new Map<string, number>(),
		_turnKey: (a: string | undefined, s: string | undefined) => `${a ?? ''}::${s ?? ''}`,
		_scheduleSave: () => { /* 持久化归父进程 */ },

		// 记忆检索：P0 不接（注入段因 provider undefined 自动跳过）。
		// ⚠ 显式报一次（消除静默降级）：proc 档少的不只是日志，是「检索注入」这个功能面。
		getActiveMemoryProvider: () => {
			if (!memoryGapReported) {
				memoryGapReported = true;
				post({ t: 'log', level: 'warn', msg: '[proc] 记忆检索未接入（P0 遗留）—— 本 turn 无 retrieval 注入（进程内档有）' });
			}
			return undefined;
		},
		// ⚠ 这些方法的 arg0 是 provider 对象 ⇒ 换标记过界（父侧替换回真 provider）
		_setCurrentModel: (_provider: unknown, modelId: unknown) => rpcNotify('_setCurrentModel', [MODEL_STUB_MARKER, modelId]),
		_resolveContextWindow: (_provider: unknown, modelId: unknown) => rpcInvoke('_resolveContextWindow', [MODEL_STUB_MARKER, modelId]),
		_storeTurnObservations: (_provider: unknown, ...rest: unknown[]) => rpcInvoke('_storeTurnObservations', [MODEL_STUB_MARKER, ...rest]),
		_retrieveContextOnly: () => Promise.resolve(null),
		_injectRetrievalSystemMessage: () => { throw new Error('[proc] retrieval 未接入（P0）——不应被调用（provider=undefined 时跳过）'); },

		// 压缩段：估计函数本地同款；计数器本地 + patch；检索上下文走 RPC
		_estimateMessagesTokens: (messages: readonly unknown[]) => estimateMessagesTokens(messages as readonly never[]),
		_lastCompressionTime: 0,
		_lastHardPruneBaselineTokens: 0,
		_compressionCount: 0,
		_compressionIneffectiveCount: 0,
		_compressionBeforeTokens: 0,
		_compressionAfterTokens: 0,
		_currentWorkspaceId: payload.workspaceId,
		_retrieveCompactionContext: (_provider: unknown, req: unknown) => rpcInvoke('_retrieveCompactionContext', [MODEL_STUB_MARKER, req]),

		// plan 钩子：不提供（P0 只读档不暴露 plan 工具）
	};

	void agentId; void sessionId;
	return host as unknown as IPiKernelHost;
}

// ─── 主流程 ──────────────────────────────────────────────────

async function main(payload: IProcTurnStartPayload): Promise<void> {
	const host = buildProxiedHost(payload);

	// 模型调用 ⇒ 流式 RPC 回父进程真 provider
	const modelProvider = {
		chat: (modelId: string, messages: unknown, options: unknown, context?: unknown) =>
			rpcStream('model.chat', [modelId, messages, options, context]),
	} as unknown as IModelProvider;

	// checkpointSink 函数不可过界 ⇒ worker 本地桩，快照经消息桥回父进程
	const request = sanitizeRequestForProc(payload.request);
	(request as { checkpointSink?: unknown }).checkpointSink = (snapshot: unknown) => {
		post({ t: 'checkpoint', snapshot });
	};

	const deps: PiKernelTurnDeps = {
		modelProvider,
		selection: payload.selection,
		enabledTools: payload.enabledTools,
		messages: payload.messages,
		maxTurns: payload.maxTurns,
		// steeringQueue / contextManagerFactory：P0 不带（子代理无插话；压缩用默认工厂）
	};

	try {
		for await (const delta of runPiKernelTurn(host, request, deps)) {
			post({ t: 'delta', delta });
		}
		post({ t: 'end', patch: buildPatch(host) });
	} catch (err) {
		post({ t: 'end', error: serializeError(err), patch: buildPatch(host) });
	}
}

function buildPatch(host: IPiKernelHost) {
	return {
		totalInputTokens: host._totalInputTokens,
		totalOutputTokens: host._totalOutputTokens,
		totalCachedTokens: host._totalCachedTokens,
		lastRealPromptTokens: [...host._lastRealPromptTokensByAgent.entries()],
		lastAssistantAt: [...host._lastAssistantAtByAgent.entries()],
		compressionCount: (host as unknown as { _compressionCount: number })._compressionCount,
		compressionIneffectiveCount: (host as unknown as { _compressionIneffectiveCount: number })._compressionIneffectiveCount,
	};
}

port.on('message', (raw: unknown) => {
	const msg = raw as ToWorkerMessage;
	switch (msg.t) {
		case 'start':
			void main(msg.payload);
			break;
		case 'abort':
			abortController.abort();
			// ⚠ 同时掐断所有在途模型流：streamAdapter 的 chunk 循环不查 signal
			// （abort 只在错误路径/轮顶检测）——不关流的话 worker 会等到父侧
			// 把流泵完才退出（2026-09-20 P0 实测：abort 延迟 = 流的剩余时长）。
			for (const [id, s] of openStreams) {
				s.close(new Error('aborted'));
				openStreams.delete(id);
			}
			break;
		case 'rpc-res': {
			const p = pendingRpc.get(msg.id);
			if (p) {
				pendingRpc.delete(msg.id);
				if (msg.ok) { p.resolve(msg.value); } else { p.reject(new Error(msg.error ?? 'rpc failed')); }
			}
			break;
		}
		case 'rpc-chunk':
			openStreams.get(msg.id)?.push(msg.value);
			break;
		case 'rpc-end':
			openStreams.get(msg.id)?.close();
			openStreams.delete(msg.id);
			break;
		case 'rpc-err':
			openStreams.get(msg.id)?.close(new Error(msg.error));
			openStreams.delete(msg.id);
			break;
	}
});
