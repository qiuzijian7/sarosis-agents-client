/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Local Chat Types
 *
 *  Minimal copy of ../../common/chatTypes.ts for webview TypeScript compilation.
 *  This file contains only the types needed by webview (streamHandler.ts, ToolCallCard.tsx, etc.)
 *  The URI import is removed (URI typed as any for webview compatibility).
 *--------------------------------------------------------------------------------------------*/

// ============================================================================
//  Unified Message Format (simplified for webview)
// ============================================================================

export type ChatMessage =
	| UserMessage
	| AssistantMessage
	| ToolMessage
	| SystemMessage
	| CheckpointMessage;

// ============================================================================
//  Assistant Message
// ============================================================================

export interface AssistantMessage {
	readonly role: 'assistant';
	readonly content: string;
	readonly reasoning: string;
	readonly thinking: readonly ThinkingBlock[];
	readonly timestamp: number;
	readonly id?: string;
}

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
//  Tool Message
// ============================================================================

export type ToolMessage = {
	readonly role: 'tool';
	readonly id: string;
	readonly name: string;
	readonly params: Readonly<Record<string, unknown>>;
	readonly rawParams: Readonly<Record<string, string | undefined>>;
	readonly result: ToolResult | string | null;
	readonly status: ToolMessageStatus;
	readonly error?: string;
	readonly mcpServerName?: string;
	readonly timestamp: number;

	// UI display fields (migrated from ToolCallData)
	readonly displayName?: string;
	readonly renderType?: string;
	readonly serverExecuted?: boolean;
	readonly securityLevel?: 'safe' | 'cautious' | 'dangerous';
	readonly exitCode?: number;
	readonly diagnostics?: ReadonlyArray<{ readonly message: string; readonly line?: number; readonly severity: 'error' | 'warning' }>;
	readonly defaultShow?: boolean;
	readonly duration?: number;
	readonly canceled?: boolean;
} & (_ToolMessageInvalidParams | _ToolMessagePending | _ToolMessageRunning | _ToolMessageSuccess | _ToolMessageError | _ToolMessageRejected | _ToolMessageCompleted | _ToolMessageCanceled | _ToolMessageApprovalRequired | _ToolMessageConfirmed);

interface _ToolMessageInvalidParams {
	readonly status: 'invalid_params';
	readonly result: null;
}

interface _ToolMessagePending {
	readonly status: 'pending';
	readonly result: null;
}

interface _ToolMessageRunning {
	readonly status: 'running';
	readonly result: null;
}

interface _ToolMessageSuccess {
	readonly status: 'success';
	readonly result: ToolResult;
}

interface _ToolMessageError {
	readonly status: 'error';
	readonly result: string;
}

interface _ToolMessageRejected {
	readonly status: 'rejected';
	readonly result: null;
}

interface _ToolMessageCompleted {
	readonly status: 'completed';
	readonly result: ToolResult | string | null;
}

interface _ToolMessageCanceled {
	readonly status: 'canceled';
	readonly result: null;
}

interface _ToolMessageApprovalRequired {
	readonly status: 'approval_required';
	readonly result: null;
}

interface _ToolMessageConfirmed {
	readonly status: 'confirmed';
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

// ============================================================================
//  Tool Result
// ============================================================================

export interface ToolResult {
	readonly content: readonly ToolResultContent[];
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
	readonly data: string;
	readonly mimeType: string;
}

export interface ToolResultContentResource {
	readonly type: 'resource';
	readonly data: string;
	readonly mimeType: string;
}

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
	readonly executionTimeMs?: number;
	readonly truncated?: boolean;
	readonly mcpServer?: string;
	readonly retryable?: boolean;
	readonly timedOut?: boolean;
}

// ============================================================================
//  Other Message Types (stubs for compilation)
// ============================================================================

export interface UserMessage {
	readonly role: 'user';
	readonly content: string;
	readonly displayContent: string;
	readonly selections: any | null;
	readonly timestamp: number;
	readonly id?: string;
}

export interface SystemMessage {
	readonly role: 'system';
	readonly content: string;
	readonly timestamp: number;
	readonly id?: string;
}

export interface CheckpointMessage {
	readonly role: 'checkpoint';
	readonly type: 'user_edit' | 'tool_edit';
	readonly fileSnapshots: Readonly<Record<string, any | undefined>>;
	readonly userModifications?: any;
	readonly timestamp: number;
}
