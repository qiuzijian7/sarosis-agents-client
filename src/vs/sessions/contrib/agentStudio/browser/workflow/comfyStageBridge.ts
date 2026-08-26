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

const DIRECT_STAGE_TIMEOUT_MS = 600_000; // 10min，与 stage() 桥一致

/** 从 ComfyStage 节点的 data 里解析 stageClass（`data.comfy.stageClass` 或 `data.stageClass`）。 */
function resolveStageClass(node: WorkflowGraphNode): string | undefined {
	const data = (node.data ?? {}) as Record<string, unknown>;
	const comfy = (data['comfy'] ?? {}) as Record<string, unknown>;
	if (typeof comfy['stageClass'] === 'string') { return comfy['stageClass']; }
	if (typeof data['stageClass'] === 'string') { return data['stageClass']; }
	// Comfy 模式节点（`data.comfy.mode === 'workflow'`）用 workflowId 直接跑工作流，
	// 而非 stageClass；当前阶段只支持 stage 模式（EmojiStage 等）。
	return undefined;
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
export function createComfyStageDelegate(): IComfyExecutionDelegate {
	return {
		async execute(node, input, ctx): Promise<ComfyExecutionResult> {
			const stageClass = resolveStageClass(node);
			if (!stageClass) {
				throw new Error(`ComfyStage 节点 "${node.id}" 缺少 stageClass，无法执行`);
			}
			const images = resolveImages(input.values);
			const request: DirectStageRunRequest = {
				stageClass,
				values: input.values,
				...(images !== undefined ? { images } : {}),
			};
			const raw = await requestDirectStageRun(request, DIRECT_STAGE_TIMEOUT_MS, ctx.onProgress);
			return toResult(raw);
		},
	};
}
