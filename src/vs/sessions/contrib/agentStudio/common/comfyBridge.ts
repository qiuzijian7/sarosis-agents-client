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
	/**
	 * 发起执行的存储工作流 id（可选，2026-09-09）：透传给 direct stage 桥，
	 * 无画布挂起 → 自动开画布时按它打开正确的工作流（headless 轻量版）。
	 */
	workflowId?: string;
	/**
	 * 上游节点 id 列表（2026-09-11）：按工作流连线（`c.to === node.id`）收集。
	 * webview 侧 `runStageByClass` 此前硬编码 `upstreams: []` → 需要**上游快照**的
	 * stage（如 Saros.AnimatedEmoji 逐格图生视频）永远拿不到参考图，报「动态表情包
	 * 制作需要上游参考图输入」。透传后 webview 可经 store 按 id 取上游快照。
	 */
	upstreams?: string[];
	/**
	 * 工作流 session id（2026-09-11 用户需求：session 隔离）：webview 侧据此
	 * `snapshotStore.setActiveSession()` —— 不同 session（对应不同聊天会话）生成的
	 * 快照互不可见，实现内容隔离。
	 */
	workflowSessionId?: string;
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
	 *
	 * `ctx.onProgress` 第三参 `media`：**本次新产出的格子**（2026-09-11 用户需求
	 * 「动态表情包节点，输出一个就显示一个」）—— 增量语义（同一格只报一次），
	 * 使聊天卡在节点尚未结束时就逐个显示已产出的结果。
	 */
	execute(
		node: WorkflowGraphNode,
		input: ComfyExecutionInput,
		ctx: { executionId: string; onProgress?: (progress: number, message?: string, media?: IStageRunMedia) => void },
	): Promise<ComfyExecutionResult>;
}

/**
 * 逐格媒体回流（2026-09-11）：执行器每产出一格就随进度上报一条（**增量**，同一格只报一次）。
 * 定义在 common 层：delegate 接口（common）与快照桥（browser）共用同一形状。
 */
export interface IStageRunMedia { ref: string; kind: string; port: string; index: number; }
