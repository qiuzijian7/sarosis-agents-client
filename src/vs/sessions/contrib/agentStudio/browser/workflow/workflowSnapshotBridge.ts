/*---------------------------------------------------------------------------------------------
 *  workflowSnapshotBridge — dynamic workflow ⇄ workflow-editor webview 数据桥（M2）。
 *
 *  复刻 canvasOpsBridge 的解耦范式（工具层永不直接触碰 controller）：
 *    1. 引擎的 snapshotPort.get(query) → requestSnapshotOutput() 注册 pending
 *       promise 并 fire snapshotQueryEmitter。
 *    2. agentStudioWebviewController 订阅 emitter → 推送
 *       `workflow.snapshotQuery` 事件（queryId + stageUid/slot）到画布 webview。
 *    3. webview 查 mediaSnapshotStore（byNode 前缀合并天然处理 nodeId/uid 别名），
 *       物化为 PortValue（json 原值 / string / {kind:'media',url,mime}）后经
 *       `workflow.snapshotResult` request 回程（queryId + ok/value|error）。
 *    4. controller 收到回程调 resolveSnapshotOutput → 解 pending。
 *
 *  归档（写方向）：run completed 且调用方传 canvasAnchorUid 时，工具层调
 *  archiveWorkflowResult() → snapshotArchiveEmitter → `workflow.snapshotArchive`
 *  事件 → webview store.put SAROS_JSON（kind:'text' + meta.sarosJson，键=锚点 uid，
 *  走既有 nodeId↔uid 别名归档体系，绝不引入第三套键）。
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import type { IWorkflowNodeOutputQuery, IWorkflowStageRunRequest } from '../../common/workflow/protocol.js';
import type { IWorkflowSnapshotPort, IWorkflowStagePort } from './workflowEngine.js';

/** controller 转发给 webview 的查询事件载荷。 */
export interface SnapshotQueryRequest {
	readonly queryId: string;
	readonly stageUid: string;
	readonly slot?: number;
}

/** webview 回程载荷（workflow.snapshotResult request）。 */
export interface SnapshotResultPayload {
	readonly queryId: string;
	readonly ok: boolean;
	readonly value?: unknown;
	readonly error?: string;
}

/** 归档事件载荷（workflow.snapshotArchive）。 */
export interface SnapshotArchiveRequest {
	readonly anchorUid: string;
	/** workflow run 的 return value（plain JSON）。 */
	readonly value: unknown;
	readonly meta: { readonly name: string; readonly runId: string };
}

/** M4b 投影归档载荷（projection.workflow 落盘为可打开的投影工作流）。 */
export interface ProjectionArchiveRequest {
	readonly meta: { readonly name: string; readonly runId: string };
	/** buildWorkflowProjection 产物（layers/phases/edges/agentsStarted/stopReason）。 */
	readonly projection: unknown;
}

/** P0 controller 转发给 webview 的「执行画布节点」事件载荷（写方向）。 */
export interface StageRunRequest {
	readonly runId: string;
	readonly stageUid: string;
	readonly overrides?: Record<string, unknown>;
}

/** webview 回程载荷（workflow.stageRunResult request）。 */
export interface StageRunResultPayload {
	readonly runId: string;
	readonly ok: boolean;
	readonly value?: unknown;
	readonly error?: string;
}

/** webview → host：stage 执行过程中的实时进度（workflow.stageRunProgress）。 */
export interface StageRunProgressPayload {
	readonly runId: string;
	readonly progress: number;
	readonly message?: string;
}

/** 工具/引擎层 → controller：请把查询转发给画布 webview。 */
export const snapshotQueryEmitter = new Emitter<SnapshotQueryRequest>();
/** 工具层 → controller：请把归档转发给画布 webview。 */
export const snapshotArchiveEmitter = new Emitter<SnapshotArchiveRequest>();
/** M4b 工具层 → controller：把运行投影落盘为投影工作流。 */
export const projectionArchiveEmitter = new Emitter<ProjectionArchiveRequest>();
/** P0 引擎层 → controller：请让画布执行指定媒体节点（写方向）。 */
export const stageRunEmitter = new Emitter<StageRunRequest>();

interface PendingQuery {
	resolve: (v: unknown) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
	/** stage run 专属：实时进度回调（ComfyUI 生成进度透传到 UI）。 */
	onProgress?: (progress: number, message?: string) => void;
}

const pendingQueries = new Map<string, PendingQuery>();
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * nodeOutput(stageUid, slot?) 的生产实现：向画布 webview 查询节点输出。
 * webview 不在/超时 → reject（引擎转 node-output-error，worker 侧 fatal fail-loud）。
 */
export function requestSnapshotOutput(query: IWorkflowNodeOutputQuery, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<unknown> {
	const queryId = `wfq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	return new Promise<unknown>((resolve, reject) => {
		const timer = timeoutMs > 0
			? setTimeout(() => {
				pendingQueries.delete(queryId);
				reject(new Error(`nodeOutput: 画布未在 ${timeoutMs}ms 内响应（请确认已打开工作流画布且节点 uid="${query.stageUid}" 已运行）`));
			}, timeoutMs)
			: undefined;
		pendingQueries.set(queryId, { resolve, reject, timer });
		snapshotQueryEmitter.fire({ queryId, stageUid: query.stageUid, ...(query.slot !== undefined ? { slot: query.slot } : {}) });
	});
}

/** controller 收到 webview 回程时调用。返回 false = 未知 queryId（已超时/已解决）。 */
export function resolveSnapshotOutput(payload: SnapshotResultPayload): boolean {
	const pending = pendingQueries.get(payload.queryId);
	if (!pending) { return false; }
	pendingQueries.delete(payload.queryId);
	if (pending.timer) { clearTimeout(pending.timer); }
	if (payload.ok) {
		pending.resolve(payload.value);
	} else {
		pending.reject(new Error(payload.error ?? 'canvas snapshot query failed'));
	}
	return true;
}

/** run 结果归档到画布锚点节点（fire-and-forget；webview 不在时静默跳过——归档是增益不是前置）。 */
export function archiveWorkflowResult(anchorUid: string, value: unknown, meta: { name: string; runId: string }): void {
	snapshotArchiveEmitter.fire({ anchorUid, value, meta });
}

/** M4b：运行投影落盘为投影工作流（fire-and-forget；失败由 controller 记日志）。 */
export function archiveWorkflowProjection(meta: { name: string; runId: string }, projection: unknown): void {
	projectionArchiveEmitter.fire({ meta, projection });
}

/** 引擎 deps 用的 IWorkflowSnapshotPort 生产实现。 */
export function createBridgeSnapshotPort(): IWorkflowSnapshotPort {
	return { get: query => requestSnapshotOutput(query) };
}

// ─── P0 stage() 桥（写方向：真正触发画布媒体节点执行）─────────────────────

const pendingStageRuns = new Map<string, PendingQuery>();
/**
 * 画布节点执行超时：媒体生成（ComfyUI 采样）远慢于快照查询，
 * 默认 10 分钟（1K/20step SD1.5 约 20s，但 upscale/多批次可能数分钟）。
 */
const DEFAULT_STAGE_TIMEOUT_MS = 600_000;

/**
 * stage(stageUid, overrides?) 的生产实现：让画布 webview 真正执行该媒体节点。
 * webview 不在/超时/执行失败 → reject（引擎转 stage-run-error，worker 侧 fatal）。
 */
export function requestStageRun(request: IWorkflowStageRunRequest, timeoutMs: number = DEFAULT_STAGE_TIMEOUT_MS, onProgress?: (progress: number, message?: string) => void): Promise<unknown> {
	const runId = `wfs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	return new Promise<unknown>((resolve, reject) => {
		const timer = timeoutMs > 0
			? setTimeout(() => {
				pendingStageRuns.delete(runId);
				reject(new Error(`stage(): 画布未在 ${Math.round(timeoutMs / 1000)}s 内完成节点执行（uid="${request.stageUid}"；请确认已打开工作流画布且 ComfyUI 可达）`));
			}, timeoutMs)
			: undefined;
		pendingStageRuns.set(runId, { resolve, reject, timer, onProgress });
		stageRunEmitter.fire({
			runId,
			stageUid: request.stageUid,
			...(request.overrides !== undefined ? { overrides: request.overrides } : {}),
		});
	});
}

/** controller 收到 webview 回程时调用。返回 false = 未知 runId（已超时/已解决）。 */
export function resolveStageRun(payload: StageRunResultPayload): boolean {
	const pending = pendingStageRuns.get(payload.runId);
	if (!pending) { return false; }
	pendingStageRuns.delete(payload.runId);
	if (pending.timer) { clearTimeout(pending.timer); }
	if (payload.ok) {
		pending.resolve(payload.value);
	} else {
		pending.reject(new Error(payload.error ?? 'canvas stage run failed'));
	}
	return true;
}

/** controller 收到 webview 进度回程时调用。返回 false = 未知 runId。 */
export function onStageRunProgress(payload: StageRunProgressPayload): boolean {
	const pending = pendingStageRuns.get(payload.runId);
	if (!pending) { return false; }
	pending.onProgress?.(payload.progress, payload.message);
	return true;
}

/** 引擎 deps 用的 IWorkflowStagePort 生产实现。 */
export function createBridgeStagePort(onProgress?: (progress: number, message?: string) => void): IWorkflowStagePort {
	return { run: (request, progress) => requestStageRun(request, DEFAULT_STAGE_TIMEOUT_MS, progress ?? onProgress) };
}
