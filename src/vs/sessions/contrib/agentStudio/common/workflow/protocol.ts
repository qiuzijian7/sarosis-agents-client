/*---------------------------------------------------------------------------------------------
 *  Dynamic Workflow — host ⇄ worker wire protocol
 *
 *  照搬 dsh `workflow-worker-thread/protocol.ts` 的结构：每方向一个字符串枚举 +
 *  payload map（单一真源）+ 判别联合。全部载荷为 plain JSON（postMessage
 *  structured clone 过线）。接收方 switch 穷尽（default: 未知消息丢弃 + 断言日志）。
 *
 *  与 dsh 的差异：provider/model 选项映射为本项目的 {agentId, model}（内置/
 *  自定义 Agent 身份 + 模型 id 覆写）。
 *  设计文档：doc/Dynamic-Workflow-Integration-Design.md §3.2.2
 *--------------------------------------------------------------------------------------------*/

import type { IWorkflowAgentEndInfo, IWorkflowAgentInfo, IWorkflowMeta, IWorkflowResult } from './types.js';

// ─── workerData（spawn 时一次性传入）────────────────────────────────────────

/** spawn 时经 worker 传入的初始化载荷（structured clone 完成 args 隔离拷贝）。 */
export interface IWorkflowWorkerInit {
	readonly meta: IWorkflowMeta;
	/** 纯 JS 脚本体（不含 meta；顶层 await 允许；以 return 结束）。 */
	readonly body: string;
	/** 工具调用的 args，原样（clone 隔离，脚本改不动调用方）。 */
	readonly args?: unknown;
	readonly limits: import('./types.js').IWorkflowLimits;
}

/**
 * nodeOutput(stageUid, slot?) 的查询载荷（M2 画布桥）。
 * 查无 uid / slot 越界 → host 回 node-output-error（worker 侧 fatal INVALID_ARGUMENT，
 * fail-loud —— 绝不静默 undefined 串坏下游链路）。
 */
export interface IWorkflowNodeOutputQuery {
	readonly stageUid: string;
	readonly slot?: number;
}

/** host 物化后的输出值：json 原值 / string / {kind:'media',...}（PortValue 语义）。 */
export interface IWorkflowNodeOutputResult {
	readonly value: unknown;
}

/**
 * stage(stageUid, overrides?) 的执行请求载荷（P0 画布桥，**写方向**）。
 *
 * 与 nodeOutput（只读快照）互补：stage() **真正触发**画布媒体节点执行
 * （ComfyTV.ImageStage / MaterialStage / EraseStage…），复用画布 Run 的同一
 * 执行器（webview runSingleSchemaNode → runNodeOrStage → ComfyUI）。
 * 这打通了「脚本域 ↔ 画布域」割裂 —— 之前媒体节点在导出脚本里只能是 null 占位。
 */
export interface IWorkflowStageRunRequest {
	/** 画布节点的稳定 uid（节点 properties.__sarosId）。 */
	readonly stageUid: string;
	/** 覆写节点 widget 值（如 { seed: 42, batch_size: 2 }）；缺省用画布当前值。 */
	readonly overrides?: Record<string, unknown>;
}

/** stage() 执行结果：物化后的节点输出（与 nodeOutput 同构，便于脚本统一消费）。 */
export interface IWorkflowStageRunResult {
	readonly value: unknown;
}

/** worker 请求 host 启动一个子代理（agent() 的 start 半段；schema 已子集校验）。 */
export interface IWorkflowChildStartRequest {
	readonly prompt: string;
	/** 受限 JSON Schema 子集（schemaSubset 校验过）。 */
	readonly schema?: Record<string, unknown>;
	/** 内置/自定义 Agent 身份（缺省 general 档）。 */
	readonly agentId?: string;
	/** 模型 id 覆写。 */
	readonly model?: string;
}

/**
 * 子代理终态的 JSON 投影。stopReason 只分支 'completed'：
 * success=false → 脚本见 null（dsh 契约）；reject 仅基建故障。
 */
export interface IWorkflowChildResult {
	/** 最终输出文本（success 时）。 */
	readonly output?: string;
	/** 结构化值（请求带 schema 且解析成功时）。 */
	readonly structured?: unknown;
	/** 子代理是否成功完成。 */
	readonly success: boolean;
	readonly stopReason: string;
}

// ─── 枚举与 payload map ─────────────────────────────────────────────────────

/** worker → host 消息标签。 */
export const enum WorkerToHostType {
	Ready = 'ready',
	Phase = 'phase',
	Log = 'log',
	AgentStart = 'agent-start',
	AgentEnd = 'agent-end',
	ChildStart = 'child-start',
	ChildDispose = 'child-dispose',
	NodeOutput = 'node-output',
	StageRun = 'stage-run',
	Result = 'result',
}

/** host → worker 消息标签。 */
export const enum HostToWorkerType {
	Go = 'go',
	Cancel = 'cancel',
	ChildStarted = 'child-started',
	ChildStartError = 'child-start-error',
	ChildSettled = 'child-settled',
	ChildFailed = 'child-failed',
	ChildDisposed = 'child-disposed',
	NodeOutputResult = 'node-output-result',
	NodeOutputError = 'node-output-error',
	StageRunResult = 'stage-run-result',
	StageRunError = 'stage-run-error',
}

export type WorkerToHostMessage =
	| { readonly type: WorkerToHostType.Ready }
	| { readonly type: WorkerToHostType.Phase; readonly title: string }
	| { readonly type: WorkerToHostType.Log; readonly message: string }
	| { readonly type: WorkerToHostType.AgentStart; readonly info: IWorkflowAgentInfo }
	| { readonly type: WorkerToHostType.AgentEnd; readonly info: IWorkflowAgentEndInfo }
	| { readonly type: WorkerToHostType.ChildStart; readonly callId: number; readonly request: IWorkflowChildStartRequest }
	| { readonly type: WorkerToHostType.ChildDispose; readonly callId: number }
	| { readonly type: WorkerToHostType.NodeOutput; readonly callId: number; readonly query: IWorkflowNodeOutputQuery }
	| { readonly type: WorkerToHostType.StageRun; readonly callId: number; readonly request: IWorkflowStageRunRequest }
	| { readonly type: WorkerToHostType.Result; readonly result: IWorkflowResult };

export type HostToWorkerMessage =
	| { readonly type: HostToWorkerType.Go; readonly init: IWorkflowWorkerInit }
	| { readonly type: HostToWorkerType.Cancel; readonly reason: string }
	| { readonly type: HostToWorkerType.ChildStarted; readonly callId: number; readonly childId: string }
	| { readonly type: HostToWorkerType.ChildStartError; readonly callId: number; readonly rendered: string }
	| { readonly type: HostToWorkerType.ChildSettled; readonly callId: number; readonly result: IWorkflowChildResult }
	| { readonly type: HostToWorkerType.ChildFailed; readonly callId: number; readonly rendered: string }
	| { readonly type: HostToWorkerType.ChildDisposed; readonly callId: number }
	| { readonly type: HostToWorkerType.NodeOutputResult; readonly callId: number; readonly result: IWorkflowNodeOutputResult }
	| { readonly type: HostToWorkerType.NodeOutputError; readonly callId: number; readonly rendered: string }
	| { readonly type: HostToWorkerType.StageRunResult; readonly callId: number; readonly result: IWorkflowStageRunResult }
	| { readonly type: HostToWorkerType.StageRunError; readonly callId: number; readonly rendered: string };
