/*---------------------------------------------------------------------------------------------
 *  comfyBridge — contract between the workflow executor and a ComfyUI runner.
 *
 *  The browser-side `WorkflowExecutionService` should not depend on the webview's
 *  HTTP client. Instead, a Comfy execution delegate can be injected at runtime
 *  (lazy, avoiding constructor-time DI cycles). When absent, Comfy nodes are
 *  skipped with a warning — same behavior as unknown node types.
 *--------------------------------------------------------------------------------------------*/

import type { WorkflowGraphNode } from './workflowStorage.js';

export interface ComfyExecutionInput {
	/** resolved binding values, keyed by input port name */
	values: Record<string, unknown>;
	/** node-level defaults that were applied */
	defaults: Record<string, unknown>;
}

export interface ComfyExecutionResult {
	/** output values keyed by port name (e.g. image, images[]) */
	outputs: Record<string, unknown>;
	/** human-readable summary for nodeState.output */
	summary?: string;
	/** media snapshot entries (image/video/audio refs) for card previews */
	snapshot?: Array<{
		port: string;
		kind: 'image' | 'video' | 'audio' | 'text' | 'unknown';
		ref: string;
		meta?: Record<string, unknown>;
	}>;
}

export interface IComfyExecutionDelegate {
	/**
	 * Execute a Comfy/ComfyStage node with already-resolved binding values.
	 * Throws on failure (retry loop / cascadeFailure handles it).
	 *
	 * `ctx.onProgress`：ComfyUI 生成进度（0-100），用于把 m×n 表情包等长耗时
	 * 节点的逐格进度透传到聊天卡（可选，未提供时静默忽略）。
	 */
	execute(
		node: WorkflowGraphNode,
		input: ComfyExecutionInput,
		ctx: { executionId: string; onProgress?: (progress: number, message?: string) => void },
	): Promise<ComfyExecutionResult>;
}
