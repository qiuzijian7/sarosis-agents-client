/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内核进程隔离协议（P0 子代理进程档 spike；2026-09-20）。
 *
 * 设计：**内核跑在隔离体（P0 = node worker_threads；P1 换 Electron utilityProcess），
 * 模型调用与工具执行经 RPC 代理回父进程** —— 宿主服务矩阵（审批/记忆/账本/持久化）
 * 零远程化，askRouting 继承链天然不断（这是与 pi 上游"整进程搬迁"的关键差异：
 * pi 的子进程自带全部权限，我们把权限面留在父进程）。
 *
 * 传输：worker_threads/utilityProcess 的 postMessage = structured clone ⇒
 * 普通数据对象直通，**函数不可传**（`sanitizeRequestForProc` 剥掉 checkpointSink
 * 等函数字段，worker 侧换成本地桩再经消息桥回父进程）。
 *
 * 消息分两组：父→worker（启动/abort/RPC 回包/流回包），worker→父（delta 流/
 * checkpoint 桥/日志转发/RPC 请求/终结 patch）。
 */

import type { IAgentTurnRequest, IChatStreamDelta, IModelDelta, IModelSelection, IToolDefinition } from '../../../common/providers.js';
import type { AgentRunMessage } from '../../../common/agentRunState.js';

// ─── 启动载荷 ────────────────────────────────────────────────

/** 启动载荷里 deps 的可序列化子集（modelProvider/contextManagerFactory/steeringQueue 不过界）。 */
export interface IProcTurnStartPayload {
	readonly request: IAgentTurnRequest;
	readonly selection: IModelSelection;
	readonly enabledTools: readonly IToolDefinition[];
	readonly messages: readonly AgentRunMessage[];
	readonly maxTurns?: number;
	/** host._currentWorkspaceId 的透传（worker 无 configuration 服务）。 */
	readonly workspaceId?: string;
}

// ─── RPC ─────────────────────────────────────────────────────

/** worker→父 的普通异步 RPC（host 方法）。 */
export interface IRpcRequest {
	readonly t: 'rpc';
	readonly id: number;
	readonly m: string;
	readonly args: readonly unknown[];
}

/** worker→父 的流式 RPC（model.chat；delta 逐条回）。 */
export interface IRpcOpen {
	readonly t: 'rpc-open';
	readonly id: number;
	readonly m: 'model.chat';
	readonly args: readonly unknown[];
}

/** 消防栓通知（无回包）。 */
export interface IRpcNotify {
	readonly t: 'rpc-notify';
	readonly m: string;
	readonly args: readonly unknown[];
}

// ─── worker→父 事件 ──────────────────────────────────────────

export interface IProcDeltaMsg { readonly t: 'delta'; readonly delta: IChatStreamDelta }
export interface IProcCheckpointMsg { readonly t: 'checkpoint'; readonly snapshot: unknown }
export interface IProcLogMsg { readonly t: 'log'; readonly level: 'info' | 'warn' | 'error'; readonly msg: string }

/** turn 终结时的计数器/状态 patch（worker 本地累计 ⇒ 父侧并账）。 */
export interface IProcEndPatch {
	readonly totalInputTokens: number;
	readonly totalOutputTokens: number;
	readonly totalCachedTokens: number;
	/** `_lastRealPromptTokensByAgent` / `_lastAssistantAtByAgent` 的 entries。 */
	readonly lastRealPromptTokens: ReadonlyArray<readonly [string, number]>;
	readonly lastAssistantAt: ReadonlyArray<readonly [string, number]>;
	readonly compressionCount: number;
	readonly compressionIneffectiveCount: number;
}

export interface IProcEndMsg {
	readonly t: 'end';
	readonly error?: { readonly message: string; readonly stack?: string; readonly name?: string };
	readonly patch: IProcEndPatch;
}

export type ToParentMessage =
	| IProcDeltaMsg
	| IProcCheckpointMsg
	| IProcLogMsg
	| IRpcRequest
	| IRpcOpen
	| IRpcNotify
	| IProcEndMsg;

// ─── 父→worker 消息 ──────────────────────────────────────────

export interface IProcStartMsg { readonly t: 'start'; readonly payload: IProcTurnStartPayload }
export interface IProcAbortMsg { readonly t: 'abort' }
export interface IRpcResultMsg { readonly t: 'rpc-res'; readonly id: number; readonly ok: boolean; readonly value?: unknown; readonly error?: string }
export interface IRpcChunkMsg { readonly t: 'rpc-chunk'; readonly id: number; readonly value: IModelDelta }
export interface IRpcEndMsg { readonly t: 'rpc-end'; readonly id: number }
export interface IRpcErrMsg { readonly t: 'rpc-err'; readonly id: number; readonly error: string }

export type ToWorkerMessage =
	| IProcStartMsg
	| IProcAbortMsg
	| IRpcResultMsg
	| IRpcChunkMsg
	| IRpcEndMsg
	| IRpcErrMsg;

/**
 * request 的过界净化：剥掉所有函数字段（checkpointSink 等——structured clone 遇函数
 * 直接抛）。采用 JSON 往返：DTO 数据原样通过，函数静默丢弃（这正是目的——
 * worker 侧会为 checkpointSink 装消息桥桩）。⚠ 新增函数字段时无需改这里。
 */
export function sanitizeRequestForProc(request: IAgentTurnRequest): IAgentTurnRequest {
	return JSON.parse(JSON.stringify(request)) as IAgentTurnRequest;
}

/** Error → 可传输形状。 */
export function serializeError(err: unknown): { message: string; stack?: string; name?: string } {
	if (err instanceof Error) { return { message: err.message, stack: err.stack, name: err.name }; }
	return { message: String(err) };
}
