/*---------------------------------------------------------------------------------------------
 *  comfyStageBridge — production `IComfyExecutionDelegate` implementation.
 *
 *  The stored-workflow executor (`WorkflowExecutionService`) has no direct HTTP access to
 *  ComfyUI (renderer fetch is CORS-blocked). Instead it delegates Comfy/ComfyStage nodes
 *  here, which forwards the run to the canvas webview via `requestDirectStageRun`
 *  (stageClass + resolved values, no stageUid required). The webview owns the ComfyUI
 *  HTTP client + `runNodeOrStage` (e.g. `runEmojiStageGrid` for `ComfyTV.EmojiStage`).
 *--------------------------------------------------------------------------------------------*/

import type { ComfyExecutionResult, IComfyExecutionDelegate } from '../../common/comfyBridge.js';
import type { WorkflowGraphNode } from '../../common/workflowStorage.js';
import { requestDirectStageRun, type DirectStageRunRequest } from './workflowSnapshotBridge.js';

/** webview 直接 stage 执行回程的结构化结果（与 webview 侧 direct runner 的返回值同构）。 */
export interface DirectStageRunResult {
	status: 'success' | 'error';
	error?: string;
	outputs: Record<string, unknown>;
	snapshot?: ComfyExecutionResult['snapshot'];
	summary?: string;
}

// ★ 12min（2026-09-10 用户需求「画布未打开则等待」）：webview 侧等 runner/画布
//   最多 10min（DIRECT_STAGE_RUNNER_WAIT_MS），host 侧留 2min 余量——webview 先报
//   明确错误（「等待 N 分钟仍无画布」），避免两侧同时超时的竞态歧义。
const DIRECT_STAGE_TIMEOUT_MS = 720_000;

/**
 * 从 ComfyStage 节点的 data 里解析 stageClass。
 *
 * ★ 顺序与过滤（2026-09-10 日志实锤 HTTP 400 `missing_node_type: Node 'comfyStage'
 *   not found`）：画布持久化的 `data.comfy.stageClass` 可能是**归一化占位名**
 *   （'comfyStage'/'comfy'），把它当 ComfyUI 节点类型请求必然 400。执行器
 *   （workflowExecutionService 归一时）会把**原始画布 type**（如
 *   `ComfyTV.ImageLoaderStage`）注入 `data.stageClass` —— 优先用它，并过滤占位值。
 */
function resolveStageClass(node: WorkflowGraphNode): string | undefined {
	const data = (node.data ?? {}) as Record<string, unknown>;
	const comfy = (data['comfy'] ?? {}) as Record<string, unknown>;
	const norm = (v: unknown): string | undefined =>
		(typeof v === 'string' && v && v !== 'comfyStage' && v !== 'comfy') ? v : undefined;
	return norm(data['stageClass']) ?? norm(comfy['stageClass']);
}

/** 参考图：优先取 `images` 端口解析值，兼容数组/单值。 */
function resolveImages(values: Record<string, unknown>): string[] | undefined {
	const raw = values['images'];
	if (Array.isArray(raw)) { return raw.filter((v): v is string => typeof v === 'string'); }
	if (typeof raw === 'string' && raw.length > 0) { return [raw]; }
	return undefined;
}

function toResult(raw: unknown): ComfyExecutionResult {
	const r = raw as DirectStageRunResult;
	if (r && r.status === 'error') {
		throw new Error(r.error ?? 'stage 执行失败');
	}
	return {
		outputs: (r && r.outputs) ?? {},
		summary: (r && r.summary) ?? undefined,
		snapshot: (r && r.snapshot) ?? undefined,
	};
}

/**
 * 生产 `IComfyExecutionDelegate`：把存储工作流的 ComfyStage 节点转发给画布 webview 执行。
 * 通过 `WorkflowExecutionService.setComfyExecutionDelegate(...)` 注入（见 agentStudioWebviewController）。
 */
export function createComfyStageDelegate(logService?: { info(message: string): void }): IComfyExecutionDelegate {
	return {
		async execute(node, input, ctx): Promise<ComfyExecutionResult> {
			const stageClass = resolveStageClass(node);
			if (!stageClass) {
				throw new Error(`ComfyStage 节点 "${node.id}" 缺少 stageClass，无法执行`);
			}
			// ★ 观测面（2026-09-10）：解析出的 stageClass 必须落 logService（console 不进
			//   renderer.log）——此前 HTTP 400 `Node 'comfyStage' not found` 只能靠推断。
			const d = (node.data ?? {}) as Record<string, unknown>;
			const c = (d['comfy'] ?? {}) as Record<string, unknown>;
			logService?.info(
				`[ComfyStageDelegate] node=${node.id} → stageClass='${stageClass}' ` +
				`(data.stageClass='${String(d['stageClass'] ?? '')}' comfy.stageClass='${String(c['stageClass'] ?? '')}' node.type='${node.type}')`,
			);
			const images = resolveImages(input.values);
			const request: DirectStageRunRequest = {
				stageClass,
				values: input.values,
				// ★ 原节点 id 透传（2026-09-10）：webview 侧用它作 snapKey 查快照库，
				//   才能命中用户在该节点上配置的默认图片/素材（此前 webview 生成
				//   新 id `direct-*` 查询 → 必为空 → 误报「请先在节点弹窗中选择文件」）。
				nodeId: node.id,
				...(images !== undefined ? { images } : {}),
				...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
				// ★ 上游节点 id 透传（2026-09-11）：webview 侧按 id 从快照库取上游快照
				//   —— 逐格图生视频（AnimatedEmoji）等 stage 的参考图来源。
				...(input.upstreams && input.upstreams.length > 0 ? { upstreams: input.upstreams } : {}),
				// ★ 工作流 session 透传（2026-09-11）：webview 据此隔离快照库。
				...(input.workflowSessionId ? { workflowSessionId: input.workflowSessionId } : {}),
				// ★ 归属执行 id 透传（2026-09-11）：用户取消该执行时，其名下直跑立即收尾
				//   （通知画布停止 + reject），不必再等空闲超时。
				executionId: ctx.executionId,
			};
			const raw = await requestDirectStageRun(request, DIRECT_STAGE_TIMEOUT_MS, ctx.onProgress);
			return toResult(raw);
		},
	};
}
