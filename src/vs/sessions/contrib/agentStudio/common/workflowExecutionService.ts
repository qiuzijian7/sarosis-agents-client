/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import type { IComfyExecutionDelegate, ComfyExecutionResult } from './comfyBridge.js';

export const IWorkflowExecutionService = createDecorator<IWorkflowExecutionService>('workflowExecutionService');

// ------------------------------------------------------------------------------------------------
// Workflow Execution Service Interface
// ------------------------------------------------------------------------------------------------

export const enum WorkflowExecutionStatus {
	Idle = 'idle',
	Running = 'running',
	Paused = 'paused', // Waiting for user input (AskUser node)
	Completed = 'completed',
	Failed = 'failed',
	Cancelled = 'cancelled',
}

export const enum WorkflowNodeExecutionStatus {
	Pending = 'pending',
	Running = 'running',
	Completed = 'completed',
	Failed = 'failed',
	Skipped = 'skipped',
	/**
	 * 等待用户配置（2026-09-12 用户需求：聊天卡状态实时同步到画布节点 UI）。
	 *
	 * 该节点已**暂停**、等用户在聊天卡里填表单（`node_interaction`）/ 选候选
	 * （`picker_select`）→ 画布据此显示「待配置」视觉（黄色描边 + 角标）✓。
	 * 与 `Running` 刻意区分：后者会让用户以为"在跑"，而实际在等他操作 ✗。
	 */
	AwaitingInput = 'awaiting-input',
	/** v21: node executor was interrupted by `cancelExecution` (the user
	 *  clicked Cancel while this node was mid-flight). Distinct from Failed
	 *  so the UI / trace timeline can render a "已取消" badge instead of an
	 *  error icon. */
	Cancelled = 'cancelled',
}

export interface IWorkflowNodeExecutionState {
	nodeId: string;
	status: WorkflowNodeExecutionStatus;
	startTime?: string;
	endTime?: string;
	error?: string;
	output?: string;
	/** Comfy/ComfyStage 节点的媒体快照（image/video/audio 引用），供聊天卡渲染。 */
	snapshot?: ComfyExecutionResult['snapshot'];
	/** Comfy/ComfyStage 节点执行进度（0-100），供聊天卡进度条。 */
	progress?: number;
}

export interface IWorkflowExecutionState {
	executionId: string;
	workflowId: string;
	status: WorkflowExecutionStatus;
	currentNodeId?: string;
	nodeStates: Map<string, IWorkflowNodeExecutionState>;
	startTime?: string;
	endTime?: string;
	error?: string;
	context: Record<string, unknown>; // Data passed between nodes
	breakpoints?: Set<string>; // Node IDs with breakpoints (for P2 debug)
	/** Execution options (history trimming, context strategies, etc.) */
	readonly options?: IWorkflowExecutionOptions;
	/**
	 * Shared memory for inter-agent communication during workflow execution.
	 * Agents can read/write named values that are visible to all nodes.
	 * Inspired by open-multi-agent's SharedMemory.
	 */
	readonly sharedMemory: Map<string, string>;
	/**
	 * 工作流 session id（2026-09-11 用户需求）：由「聊天 session ↔ 工作流 session」
	 * 绑定解析而来（同一聊天 session 复用同一工作流 session；切换聊天 session 新建），
	 * 用于隔离不同会话生成的内容（快照 / 运行产物）。
	 */
	workflowSessionId?: string;
}

export interface IWorkflowExecutionService {
	readonly _serviceBrand: undefined;

	/** Execution state changes */
	readonly onDidExecutionStatusChange: Event<IWorkflowExecutionState>;
	/** Node execution state changes */
	readonly onDidNodeExecutionStatusChange: Event<{ executionId: string; nodeState: IWorkflowNodeExecutionState }>;
	/** Breakpoint changes */
	readonly onDidChangeBreakpoints: Event<{ executionId: string; nodeIds: string[] }>;
	/** Fine-grained trace events for chat panel rendering (P4) */
	readonly onDidExecutionTrace: Event<IWorkflowTraceEvent>;

	/**
	 * Execute a workflow.
	 * @param workflowId The workflow ID to execute
	 * @param options Execution options
	 * @returns Execution ID
	 */
	executeWorkflow(workflowId: string, options?: IWorkflowExecutionOptions): Promise<string>;

	/**
	 * Pause execution (for AskUser node or breakpoint).
	 * Returns a promise that resolves with user input when execution is resumed.
	 */
	pauseExecution(executionId: string, nodeId: string, question: string, options: IAskUserOption[]): Promise<string | string[]>;

	/**
	 * Resume execution after user input.
	 */
	resumeExecution(executionId: string, userInput: string | string[]): Promise<void>;
	/**
	 * ★ 断点续跑（2026-09-11）：从磁盘 checkpoint 恢复一次**已中断**的执行
	 * （进程被杀 / 崩溃）——`completed` 节点复用产出，其余节点（含崩溃时 running 的）
	 * 重跑。与 `resumeExecution`（交互暂停恢复，需 pending resolver）语义不同。
	 * 返回 executionId；无可用断点时抛错。
	 */
	resumeFromCheckpoint(executionId: string): Promise<string>;

	/**
	 * Cancel execution.
	 */
	cancelExecution(executionId: string): Promise<void>;

	/**
	 * Get execution state.
	 */
	getExecutionState(executionId: string): IWorkflowExecutionState | undefined;

	/**
	 * Get all active executions.
	 */
	getActiveExecutions(): IWorkflowExecutionState[];

	/**
	 * Get the owner-agent chat session created for this execution (P4 chat trace).
	 * Returns undefined if the workflow has no agentId or session creation failed.
	 */
	getExecutionSession(executionId: string): IWorkflowSessionInfo | undefined;

	/**
	 * Set breakpoint on a node (P2 debug feature).
	 */
	setBreakpoint(executionId: string, nodeId: string): void;

	/**
	 * Clear breakpoint on a node.
	 */
	clearBreakpoint(executionId: string, nodeId: string): void;

	/**
	 * Get all breakpoints for an execution.
	 */
	getBreakpoints(executionId: string): string[];

	// v5a: workflow-level breakpoints (persist across runs).

	/**
	 * Set a breakpoint on a workflow node. Persists to the workflow JSON so
	 * it applies to the next run. Pass `executionId` to also apply it to the
	 * running execution (if any) for immediate effect.
	 */
	setWorkflowBreakpoint(workflowId: string, nodeId: string, executionId?: string): Promise<void>;

	/**
	 * Clear a workflow-level breakpoint.
	 */
	clearWorkflowBreakpoint(workflowId: string, nodeId: string, executionId?: string): Promise<void>;

	/**
	 * Get all workflow-level breakpoints (persisted).
	 */
	getWorkflowBreakpoints(workflowId: string): Promise<string[]>;

	/**
	 * v6: Submit variable values collected before execution starts.
	 * Called by the webview after the user fills in the variable collection card.
	 */
	submitWorkflowVariables(executionId: string, values: Record<string, string>): Promise<void>;

	/**
	 * 注入 Comfy/ComfyStage 节点的执行委托（懒注入，避免构造期 DI 环）。
	 * 未设置时 Comfy 节点跳过。生产实现见 comfyStageBridge.ts。
	 */
	setComfyExecutionDelegate(delegate: IComfyExecutionDelegate | undefined): void;

	/**
	 * 注入 Script 节点（P1-4：Dynamic Workflow 脚本作为 DAG 节点）的执行委托。
	 * 懒注入避免 DI 环；未设置时 Script 节点标 Failed。生产实现见 agentStudioWebviewController。
	 */
	setScriptExecutionDelegate(delegate: IScriptExecutionDelegate | undefined): void;

	/**
	 * ★ 脚本内 `stage()` 的进度 → 归到发起它的 **script 节点卡**（P0 修复，2026-09-13）。
	 *
	 * 背景（质量评估实测）：`node_progress` trace 全仓只有一个发射点，在 Comfy 节点
	 * 执行器内 → 脚本节点在聊天卡上**永远没有进度条**，只有转圈 spinner；而脚本内
	 * `stage()` 的进度其实已经在回传（`workflow.stageRunProgress`），只是仅喂给工具卡。
	 *
	 * 调用方：controller 收到 `workflow.stageRunProgress` 时转交（它知道 runId，
	 * 经 bridge 反查 executionId）。本服务用「当前正在执行的 script 节点」映射
	 * 把它归到具体节点卡。
	 *
	 * 语义说明：脚本可连续调用多个 stage，进度会随 stage 切换**回退**（80% → 0%）。
	 * 这是有意的 —— 比「完全没有反馈」更接近真实状态，且 `message` 会标注来源。
	 * 无对应 script 节点时静默忽略（直跑/工具卡路径的进度走原有通道）。
	 */
	reportScriptStageProgress(executionId: string, progress: number, message?: string): void;

	/**
	 * ★ 脚本内 `stage()` 产出的媒体 → 累积到发起它的 script 节点（P1-1 修复，2026-09-13）。
	 *
	 * 背景：脚本内 `stage()` 的产物落在画布 webview 的快照库里，而 `_executeScriptNode`
	 * 只写 `output`（文本）→ `subagent_end` 不带 `snapshot` → **脚本节点在聊天卡上
	 * 永远没有缩略图**（同一个产物在画布上却能看到）。
	 *
	 * 现在把回程 payload 的 `value.snapshot` 累积起来，脚本结束时写入
	 * `nodeState.snapshot` → 与 Comfy 节点走**同一条**展示通道（无需新增渲染逻辑）。
	 *
	 * 调用方：controller 的 `workflow.stageRunResult` 分支（须在 `resolveStageRun`
	 * **之前**反查归属 —— resolve 会移除 pending 表项，之后就查不到了）。
	 * 非脚本执行（画布直跑 / 工具卡）→ 静默忽略。
	 */
	collectScriptStageSnapshot(executionId: string, snapshot: ReadonlyArray<{
		port: string;
		kind: 'image' | 'video' | 'audio' | 'text' | 'unknown';
		ref: string;
		meta?: Record<string, unknown>;
	}>): void;
}

/** P1-4：脚本执行委托接口（结构类型，browser 侧实现与 common 声明同构）。 */
export interface IScriptExecutionDelegate {
	execute(input: {
		script: string;
		meta: { name: string };
		args?: unknown;
		/**
		 * 归属的 workflow executionId（2026-09-11）：脚本内 `stage()` 的 pending 归它名下，
		 * 使 `cancelExecution` 能一并中止（否则取消后脚本会一直等到空闲超时 ✗）。
		 */
		executionId?: string;
	}): Promise<{ ok: boolean; error?: string; value?: unknown }>;
}

export interface IWorkflowExecutionOptions {
	/** Initial context data */
	context?: Record<string, unknown>;
	/** Agent ID to use for agent nodes (defaults to workflow's agentId) */
	agentId?: string;
	/**
	 * 复用现有会话作为 owner 会话（而非新建「▶ 工作流名」会话）。
	 * 聊天触发场景（/workflow、/wf、bare /{wf-id}）传入发起聊天的 sessionId，
	 * 使 AskUser 交互卡片与 subagent 进度卡片直接显示在用户正看着的会话中。
	 */
	sessionId?: string;
	/**
	 * Maximum number of conversation history messages to keep when sending
	 * to agent nodes. When exceeded, the oldest messages are trimmed.
	 * Default: undefined (no limit, keep all).
	 */
	maxHistoryMessages?: number;
	/**
	 * Context compression threshold (0-1). Tokens above this ratio of the
	 * model's context window trigger the Hermes 3-segment compression.
	 * Default: 0.25 (25%). Set to 0 to disable compression entirely.
	 */
	compressionThreshold?: number;
	/**
	 * v40: When true, skip the interactive variable collection card and
	 * auto-resolve `{{variable}}` placeholders from context.
	 * Used when executing from task board where variables are pre-filled.
	 */
	skipVariableCollection?: boolean;
}

export interface RetryConfig {
	/** Maximum number of retry attempts (default: 0 — no retry). */
	maxAttempts?: number;
	/** Initial delay before first retry, in milliseconds (default: 1000). */
	initialDelayMs?: number;
	/** Backoff multiplier — each retry delay = previous * multiplier (default: 2). */
	backoffMultiplier?: number;
	/** Maximum delay between retries, in milliseconds (default: 30000). */
	maxDelayMs?: number;
}

export interface TimeoutConfig {
	/** Hard wall-clock timeout for the entire node execution, in milliseconds. Default: 300000 (5 min). */
	runTimeoutMs?: number;
	/** Maximum idle time without any delta/progress, in milliseconds. Default: 60000 (1 min). */
	idleTimeoutMs?: number;
}

export interface IAskUserOption {
	label: string;
	description?: string;
}

/** D4（2026-09-10）：AskUser 动态参数字段定义（多字段输入表单）。 */
export interface IAskUserField {
	key: string;
	label?: string;
	kind?: 'text' | 'number' | 'textarea' | 'select' | 'image';
	default?: string;
	placeholder?: string;
}

/**
 * 多问题（2026-09-11 用户需求）：一个 AskUser 节点可配置多个问题，每个问题独立
 * 选择「选项按钮」或「参数表单」模式。
 *
 * 节点 `data.questions` 即此数组（JSON 字符串）；为空时执行器回落旧的单问题字段
 * （questionText / options / params / multiSelect / allowCustom）—— 零迁移。
 * 答案聚合为 `{ [key]: value }`（选项模式 = 文案或数组；参数模式 = { 字段key: 值 }）。
 */
export interface IAskUserQuestion {
	/** 答案键名（answer 对象的 key；下游 {{input.q1}} 引用）。 */
	key: string;
	/** 问题文本。 */
	text: string;
	/** 回答方式：选项按钮 / 参数表单。 */
	mode: 'options' | 'params';
	/** 是否必填（仅语义提示；未答也允许提交，卡片给出警示）。 */
	required?: boolean;
	options?: IAskUserOption[];
	/** 参数模式的字段定义（键名与节点 data.params 一致，便于编辑器直读写）。 */
	params?: IAskUserField[];
	multiSelect?: boolean;
	allowCustom?: boolean;
	customLabel?: string;
}

// ─── Trace Event: forwarded to webview so the workflow owner agent's chat
//     can render node execution as subagent cards + tool call list. ───

/** Per-node execution trace event (one per agent node in the workflow). */
export type IWorkflowTraceEvent =
	/** A new subagent (workflow node) starts. */
	| { kind: 'subagent_start'; executionId: string; workflowAgentId: string; sessionId: string;
		nodeId: string; nodeName: string; nodeType: string; task: string;
		/**
		 * ★ 卡片图标（P0 修复，2026-09-13）：host 按**节点描述符**推导
		 * （stage kind → 产物语义；否则引擎类型），与画布卡片语义一致。
		 * 缺省时渲染层回退旧的 4 项硬编码表（历史消息无此字段）。
		 */
		icon?: string }
	/** Streaming delta from the agent model (text/thinking/tool_start/tool_args/tool_result). */
	| { kind: 'delta'; executionId: string; sessionId: string; nodeId: string; delta: unknown }
	/** Subagent finishes successfully. */
	| { kind: 'subagent_end'; executionId: string; sessionId: string; nodeId: string;
		// v21: 'cancelled' is fired when the user clicks Cancel while the node
		// is mid-stream. The sendMessage await returns with partial content
		// (no throw) when AbortController is tripped, so we surface the cancel
		// via this status so the webview card can flip to the cancelled badge
		// instead of the "done" success badge.
		status: 'done' | 'error' | 'cancelled'; output?: string; error?: string;
	// ★ 媒体快照（2026-09-10 用户要求「静态表情包节点生成的 output 要在卡片展示」）：
	//   媒体节点的 output 是引用（ref）而非可读文本，卡片需要它才能渲染缩略图。
	snapshot?: Array<{ port: string; kind: 'image' | 'video' | 'audio' | 'text' | 'unknown'; ref: string; meta?: Record<string, unknown> }> }
	/** AskUser node wants user input — webview should render an interactive card. */
	| { kind: 'ask_user'; executionId: string; sessionId: string; nodeId: string; nodeName: string;
		question: string; options: IAskUserOption[]; multiSelect: boolean;
		/** D3（2026-09-10）：选项尾部渲染自由输入框，用户可回答选项之外的答案。 */
		allowCustom?: boolean; customLabel?: string;
		/** D4：动态参数字段（多字段输入表单），支持上游动态覆盖。 */
		fields?: IAskUserField[];
		/**
		 * ★ 多问题（2026-09-11）：非空 = 多问题模式 —— 卡片按**单页**渲染全部问题，
		 * 一次提交返回 `{ __askUserAnswer:1, answers:{ [key]: value } }`。
		 * 为空 = 旧的单问题形态（question/options/fields 字段生效），行为不变。
		 */
		questions?: IAskUserQuestion[] }
	/** AskUser node has been answered (or cancelled) — webview flips card to "answered" state. */
	| { kind: 'ask_user_end'; executionId: string; sessionId: string; nodeId: string;
		status: 'answered' | 'cancelled' | 'expired'; selection?: string | string[] }
	/**
	 * ImagePicker 节点要求用户**多选**要输出给下游的图像（2026-09-11 用户需求）：
	 * 卡片渲染候选图网格 + 勾选 + 确认；确认后 resume，下游才继续执行。
	 */
	| { kind: 'picker_select'; executionId: string; sessionId: string; nodeId: string; nodeName: string;
		/** 上游候选媒体（image/video/audio），卡片据此渲染缩略图。 */
		candidates: Array<{ port: string; kind: 'image' | 'video' | 'audio' | 'text' | 'unknown'; ref: string; meta?: Record<string, unknown> }>;
		multiSelect: boolean }
	/** ImagePicker 选择已提交（或取消）—— 卡片翻转为「已选择」态。 */
	| { kind: 'picker_select_end'; executionId: string; sessionId: string; nodeId: string;
		status: 'answered' | 'cancelled'; selection?: string[] }
	/**
	 * 节点交互 UI（2026-09-11 用户需求：**通用框架**）：任意节点可在执行前声明
	 * 一张「与用户交互的卡片表单」（如静态表情包的 m×n / 每格提示词 / 风格），
	 * 用户提交后该节点才执行、随后继续下游。载荷由 schema 驱动（fields 内联，
	 * 与 browser/workflow/nodeInteraction/types.ts 的声明同构）。
	 */
	| { kind: 'node_interaction'; executionId: string; sessionId: string; nodeId: string; nodeName: string;
		/** 原始节点全名（如 ComfyTV.StatEmojiStage），卡片可据此做专属渲染。 */
		stageClass?: string;
		title: string; description?: string; submitLabel?: string;
		fields: Array<Record<string, unknown>>;
		/** 字段初始值（来自节点现有配置）。 */
		initialValues: Record<string, unknown> }
	/** 节点交互表单已提交（或跳过）—— 卡片翻转为只读态。 */
	| { kind: 'node_interaction_end'; executionId: string; sessionId: string; nodeId: string;
		status: 'submitted' | 'skipped'; values?: Record<string, unknown> }
	/** v6: Workflow needs variable values before execution. Webview renders text inputs for each. */
	| { kind: 'collect_variables'; executionId: string; sessionId: string;
		variables: Array<{ name: string; defaultValue?: string }> }
	/** v6: Variable collection resolved — webview flips card to "submitted" state. */
	| { kind: 'collect_variables_end'; executionId: string; sessionId: string;
		status: 'submitted' | 'skipped' }
	/** Whole execution finished — owner chat should commit final assistant message. */
	| { kind: 'execution_end'; executionId: string; sessionId: string; status: 'completed' | 'failed' | 'cancelled';
		/**
		 * ★ 执行统计（P2-2 修复，2026-09-13）。
		 *
		 * 此前 `execution_end` 只带 status → 聊天卡的「耗时」由 controller 用
		 * `Date.now()` **现场取**（起止同一时刻）→ **恒显示 0.0s** ✗；成功/失败节点数
		 * 则完全不计算。现在由 host 用真实 `startTime`/`endTime` 与 nodeStates 统计给出。
		 */
		durationMs?: number;
		doneCount?: number;
		errorCount?: number;
		cancelledCount?: number;
		skippedCount?: number }
	/** Comfy/ComfyStage 节点执行进度（逐格/逐帧），供聊天卡进度条。 */
	| { kind: 'node_progress'; executionId: string; sessionId: string; nodeId: string; nodeName: string; progress: number; message?: string };

/** Information about the new chat session created for a workflow run. */
export interface IWorkflowSessionInfo {
	workflowAgentId: string;
	sessionId: string;
	workflowName: string;
}
