/**
 * Shared types and utilities for tool call cards
 */

import { sanitizeToolResultText } from '../../../utils/assistantVisibleText';
import { ToolDisplayRegistry } from '../../../utils/toolDisplayRegistry';
import { openFile } from '../../../bridge/fileBridge';

/**
 * Tool call data interface
 */
export interface ToolCallData {
	id: string;
	name: string;
	arguments: string;
	result?: string;
	status: string;
	/** Duration in ms (if available) */
	duration?: number;
	/** Error message (if failed) */
	error?: string;
	/** Whether to show this tool call card in the chat UI. Default true. */
	defaultShow?: boolean;
	/** UI 显示名称（来自模型的 display_name 字段） */
	displayName?: string;
	/** 渲染类型（如 RunTerminal、CodeApply、ListItems 等） */
	renderType?: string;
	/** 工具已在服务端执行（如 Knot AG-UI），客户端不需要再执行 */
	serverExecuted?: boolean;
	/** Security level for approval UI */
	securityLevel?: 'safe' | 'cautious' | 'dangerous';
	/** Exit code from terminal commands */
	exitCode?: number;
	/** Lint/diagnostic errors after edit_file */
	diagnostics?: Array<{ message: string; line?: number; severity: 'error' | 'warning' }>;
	/** Whether the tool call was canceled */
	canceled?: boolean;
	/** Whether the tool call was confirmed by the user */
	confirmed?: boolean;
	/** Confirmation message to show to the user (title + message) */
	confirmationMessage?: string;
	/** Confirmation title to show to the user */
	confirmationTitle?: string;
	/** Terminal command (for terminal tool calls, editable in confirmation) */
	terminalCommand?: string;
}

export interface ToolCallCardProps {
	toolCall: ToolCallData;
}

/** Max chars to show in result preview before truncating */
export const RESULT_PREVIEW_LIMIT = 500;
/** Max chars to show in expanded result before "show all" */
export const RESULT_EXPANDED_LIMIT = 5000;

/** Recognized renderType values */
export const KNOWN_RENDER_TYPES = new Set(['ListItems', 'RunTerminal', 'CodeApply']);

/**
 * Format duration for display.
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) { return `${ms}ms`; }
	if (ms < 60000) { return `${(ms / 1000).toFixed(1)}s`; }
	return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * Extract file path from tool arguments (supports file_path, filePath, path).
 */
export function extractFilePath(args: string): string | null {
	try {
		const parsed = JSON.parse(args || '{}');
		return parsed.file_path || parsed.filePath || parsed.path || null;
	} catch {
		return null;
	}
}

/**
 * Extract search query from tool arguments.
 */
export function extractSearchQuery(args: string): string | null {
	try {
		const parsed = JSON.parse(args || '{}');
		return parsed.query || parsed.pattern || parsed.search_query || null;
	} catch {
		return null;
	}
}

/**
 * Resolve display info via ToolDisplayRegistry.
 * Returns emoji, title/label, and detail summary.
 */
export function resolveToolDisplay(name: string, args: string) {
	return ToolDisplayRegistry.resolve(name, args);
}

/**
 * Sanitize tool result text
 */
export { sanitizeToolResultText };

/**
 * Open file in editor
 */
export { openFile };
