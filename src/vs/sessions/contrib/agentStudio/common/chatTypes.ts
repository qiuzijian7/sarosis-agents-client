/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// import { URI } from '../../../../base/common/uri.js'; // REMOVED: URI not available in webview context

// ============================================================================
// 统一消息格式（Unified Message Format）
// 参考 void 项目的 ChatMessage 设计
// ============================================================================

/**
 * 统一聊天消息格式
 * 这是系统内部使用的消息格式，与具体 LLM 提供商无关
 */
export type ChatMessage =
	| UserMessage
	| AssistantMessage
	| ToolMessage
	| SystemMessage
	| CheckpointMessage;

/**
 * Sidecar 注入种类（标记 synthetic 消息的来源，供压缩/持久化剥离与遥测识别）。
 * 这些消息由框架在发送前临时注入（技能激活、策略提醒、控制流重入等），
 * 并非用户真实输入；标记后应在压缩与持久化前剥离，避免污染干净 transcript。
 * 设计对齐 Hermes 的 `api_content` sidecar 与 MiMo-Code 的 `synthetic: true`。
 */
export type SidecarKind =
	| 'skill'      // 技能激活块（auto/explicit 命中，user placement）
	| 'reminder'   // 策略级预算 reminder
	| 'nudge'      // TaskGate 重入 nudge
	| 'plan'       // 计划任务推进提醒
	| 'reflection' // 反思阶段提示
	| 'memory'     // Agent Memory 上下文（system，session 级幂等）
	| 'retrieval'  // 检索保留上下文（system，压缩时按前缀剥离）
	| 'durable';   // Durable Context（system，checkpoint 持久化）

// ============================================================================
// 用户消息
// ============================================================================

export interface UserMessage {
	readonly role: 'user';
	/** 发送给 LLM 的内容（可能为空字符串） */
	readonly content: string;
	/** 显示给用户的内容（可能不同从 content，例如脱敏后） */
	readonly displayContent: string;
	/** 用户的选区（文件、代码片段、文件夹等） */
	readonly selections: SelectionItem[] | null;
	/** 消息时间戳 */
	readonly timestamp: number;
	/** 消息 ID（可选，用于引用） */
	readonly id?: string;
	/** 是否为「sidecar 注入」消息（技能/策略/控制流临时注入），非用户真实输入。
	 *  标记后压缩与持久化会剥离，避免污染干净 transcript（对齐 Hermes api_content / MiMo synthetic:true）。 */
	readonly synthetic?: boolean;
	/** sidecar 注入种类，便于压缩/遥测识别与排序。 */
	readonly sidecar?: SidecarKind;
}

// ============================================================================
// 助手消息
// ============================================================================

export interface AssistantMessage {
	readonly role: 'assistant';
	/** 文本内容（不含思考链） */
	readonly content: string;
	/** 推理内容（非思考链，用于 step-by-step 推理） */
	readonly reasoning: string;
	/** 思考链（Anthropic 格式，包含 thinking 和 redacted_thinking） */
	readonly thinking: readonly ThinkingBlock[];
	/** 消息时间戳 */
	readonly timestamp: number;
	/** 消息 ID（可选，用于引用） */
	readonly id?: string;
	/** 是否为「sidecar 注入」消息（见 UserMessage.synthetic 说明）。 */
	readonly synthetic?: boolean;
	/** sidecar 注入种类，便于压缩/遥测识别与排序。 */
	readonly sidecar?: SidecarKind;
}

/**
 * 思考块（Anthropic 格式）
 */
export type ThinkingBlock =
	| ThinkingBlockNormal
	| ThinkingBlockRedacted;

export interface ThinkingBlockNormal {
	readonly type: 'thinking';
	readonly thinking: string;
	readonly signature?: string;
}

export interface ThinkingBlockRedacted {
	readonly type: 'redacted_thinking';
	readonly data: string;
}

// ============================================================================
// 工具消息
// ============================================================================

/**
 * 工具消息
 * 参考 void 项目的 ToolMessage 设计，支持多种状态
 */
export type ToolMessage = {
	readonly role: 'tool';
	/** 工具调用 ID（对应 LLM 返回的 tool_call_id / tool_use_id） */
	readonly id: string;
	/** 工具名称 */
	readonly name: string;
	/** 工具参数（已解析为对象） */
	readonly params: Readonly<Record<string, unknown>>;
	/** 原始参数字符串（按参数名索引，用于调试和重试） */
	readonly rawParams: Readonly<Record<string, string | undefined>>;
	/** 工具执行结果（如果已执行完成） */
	readonly result: ToolResult | null;
	/** 工具消息状态（参考 void 的 ToolMessage type 联合类型） */
	readonly status: ToolMessageStatus;
	/** 错误信息（如果 status 是 'error'） */
	readonly error?: string;
	/** MCP 服务器名称（如果工具来自 MCP） */
	readonly mcpServerName?: string;
	/** 消息时间戳 */
	readonly timestamp: number;

	// ─── UI 显示字段（从 ToolCallData 迁移）──────────────────────
	/** UI 显示名称（来自模型的 display_name 字段） */
	readonly displayName?: string;
	/** 渲染类型（如 RunTerminal、CodeApply、ListItems 等） */
	readonly renderType?: string;
	/** 工具已在服务端执行（如 Knot AG-UI），客户端不需要再执行 */
	readonly serverExecuted?: boolean;
	/** Security level for approval UI */
	readonly securityLevel?: 'safe' | 'cautious' | 'dangerous';
	/** Exit code from terminal commands */
	readonly exitCode?: number;
	/** Lint/diagnostic errors after edit_file */
	readonly diagnostics?: ReadonlyArray<{ readonly message: string; readonly line?: number; readonly severity: 'error' | 'warning' }>;
	/** Whether to show this tool call card in the chat UI. Default true. */
	readonly defaultShow?: boolean;
	/** Duration in ms (if available) */
	readonly duration?: number;
	/** Whether the tool call was canceled */
	readonly canceled?: boolean;
} & (_ToolMessageInvalidParams | _ToolMessagePending | _ToolMessageRunning | _ToolMessageSuccess | _ToolMessageError | _ToolMessageRejected | _ToolMessageCompleted | _ToolMessageCanceled | _ToolMessageApprovalRequired | _ToolMessageConfirmed);

/** 参数无效（解析失败） */
interface _ToolMessageInvalidParams {
	readonly status: 'invalid_params';
	readonly result: null;
}

/** 等待执行（可能需要用户审批） */
interface _ToolMessagePending {
	readonly status: 'pending';
	readonly result: null;
}

/** 正在执行 */
interface _ToolMessageRunning {
	readonly status: 'running';
	readonly result: null;
}

/** 执行成功 */
interface _ToolMessageSuccess {
	readonly status: 'success';
	readonly result: ToolResult;
}

/** 执行错误 */
interface _ToolMessageError {
	readonly status: 'error';
	readonly result: string; // error message
}

/** 用户拒绝执行 */
interface _ToolMessageRejected {
	readonly status: 'rejected';
	readonly result: null;
}

export type ToolMessageStatus =
	| 'invalid_params'
	| 'pending'
	| 'running'
	| 'success'
	| 'error'
	| 'rejected'
	| 'canceled'
	| 'approval_required'
	| 'confirmed';

/** 执行完成（成功或失败后的终态） */
interface _ToolMessageCompleted {
	readonly status: 'completed';
	readonly result: ToolResult | string | null;
}

/** 用户取消执行 */
interface _ToolMessageCanceled {
	readonly status: 'canceled';
	readonly result: null;
}

/** 等待用户审批 */
interface _ToolMessageApprovalRequired {
	readonly status: 'approval_required';
	readonly result: null;
}

/** 用户确认执行 */
interface _ToolMessageConfirmed {
	readonly status: 'confirmed';
	readonly result: null;
}

// ============================================================================
// 工具执行结果
// ============================================================================

export interface ToolResult {
	/** 结果内容（支持多种类型） */
	readonly content: readonly ToolResultContent[];
	/** 结果元数据（执行时间、是否被截断等） */
	readonly metadata?: ToolResultMetadata;
}

export type ToolResultContent =
	| ToolResultContentText
	| ToolResultContentImage
	| ToolResultContentResource
	| ToolResultContentListItem;

export interface ToolResultContentText {
	readonly type: 'text';
	readonly text: string;
}

export interface ToolResultContentImage {
	readonly type: 'image';
	readonly data: string; // base64
	readonly mimeType: string;
}

export interface ToolResultContentResource {
	readonly type: 'resource';
	readonly data: string; // URI or base64
	readonly mimeType: string;
}

/**
 * 列表项内容（用于 list_files、search 等工具）
 */
export interface ToolResultContentListItem {
	readonly type: 'list_item';
	readonly items: readonly ToolResultListItem[];
}

export interface ToolResultListItem {
	readonly type: 'file' | 'directory' | 'search_result';
	readonly name: string;
	readonly path: string;
	readonly content?: string;
	readonly size?: number;
	readonly modifiedTime?: string;
}

export interface ToolResultMetadata {
	/** 执行耗时（毫秒） */
	readonly executionTimeMs?: number;
	/** 结果是否被截断 */
	readonly truncated?: boolean;
	/** MCP 来源服务器名 */
	readonly mcpServer?: string;
	/** 是否可重试 */
	readonly retryable?: boolean;
	/** 是否因超时而终止 */
	readonly timedOut?: boolean;
}

// ============================================================================
// 系统消息
// ============================================================================

export interface SystemMessage {
	readonly role: 'system';
	/** 系统提示内容 */
	readonly content: string;
	/** 消息时间戳 */
	readonly timestamp: number;
	/** 消息 ID（可选） */
	readonly id?: string;
	/** 是否为「sidecar 注入」消息（见 UserMessage.synthetic 说明）。 */
	readonly synthetic?: boolean;
	/** sidecar 注入种类，便于压缩/遥测识别与排序。 */
	readonly sidecar?: SidecarKind;
}

// ============================================================================
// 检查点消息
// ============================================================================

export interface CheckpointMessage {
	readonly role: 'checkpoint';
	/** 检查点类型 */
	readonly type: 'user_edit' | 'tool_edit';
	/** 文件快照映射（fsPath -> fileSnapshot） */
	readonly fileSnapshots: Readonly<Record<string, FileSnapshot | undefined>>;
	/** 用户修改（用于 user_edit 类型） */
	readonly userModifications?: {
		readonly fileSnapshots: Readonly<Record<string, FileSnapshot | undefined>>;
	};
	/** 消息时间戳 */
	readonly timestamp: number;
}

/**
 * 文件快照（简化版，参考 void 的 VoidFileSnapshot）
 */
export interface FileSnapshot {
	/** 文件 URI */
	readonly uri: any;
	/** 文件内容 */
	readonly content: string;
	/** 语言 ID */
	readonly languageId: string;
	/** 是否已修改 */
	readonly isModified: boolean;
}

// ============================================================================
// 选择项（用于 UserMessage.selections）
// ============================================================================

export type SelectionItem =
	| SelectionItemFile
	| SelectionItemCode
	| SelectionItemFolder;

export interface SelectionItemFile {
	readonly type: 'File';
	readonly uri: any;
	readonly language: string;
	readonly state: {
		readonly wasAddedAsCurrentFile: boolean;
	};
}

export interface SelectionItemCode {
	readonly type: 'CodeSelection';
	readonly uri: any;
	readonly language: string;
	readonly range: readonly [number, number]; // [start, end]
	readonly state: {
		readonly wasAddedAsCurrentFile: boolean;
	};
}

export interface SelectionItemFolder {
	readonly type: 'Folder';
	readonly uri: any;
	readonly language?: undefined;
	readonly state?: undefined;
}

// ============================================================================
// 工具调用信息（用于流式传输）
// ============================================================================

/**
 * 工具调用信息（流式传输中使用）
 * 与 providers.ts 中的 IToolCallInfo 类似，但是只读的
 */
export interface ToolCallStreamInfo {
	readonly id: string;
	readonly name: string;
	readonly arguments: string; // JSON string
	/** UI 显示名称（来自模型的 display_name 字段） */
	readonly displayName?: string;
	/** 渲染类型（如 RunTerminal、CodeEditor 等） */
	readonly renderType?: string;
	/** 是否默认展开显示工具卡（默认 true） */
	readonly defaultShow?: boolean;
	/** 工具已在服务端执行（如 Knot AG-UI），客户端不需要再执行 */
	readonly serverExecuted?: boolean;
}
