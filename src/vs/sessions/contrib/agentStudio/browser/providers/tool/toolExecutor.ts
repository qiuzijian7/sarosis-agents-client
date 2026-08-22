/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IToolCall, IToolResult, IToolResultContent, NonRetryableToolError } from '../../../common/providers.js';
import { SandboxViolationError } from './workspaceSecurity.js';

/** handler 返回内容：要么直接是 content 数组，要么带额外 details 的包。 */
type ToolHandlerResult = IToolResultContent[] | { content: IToolResultContent[]; details?: Record<string, unknown> };

export interface IExecutableTool {
	readonly handler: (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string, sessionId?: string) => Promise<ToolHandlerResult>;
	/** 标记 stub — 只有 schema 没有真实 handler（理论上不应到达 executeTool）。 */
	readonly isStub?: boolean;
	/** 返回 false 表示当前环境不可用。 */
	readonly available?: () => boolean;
}

export interface ToolExecutorDeps {
	/** 按名字解析已注册工具描述符；未找到返回 undefined。 */
	resolveTool: (name: string) => IExecutableTool | undefined;
	/** 返回当前已注册工具名（用于 not-found 日志诊断）。 */
	listToolNames: () => Iterable<string>;
	readonly logService: ILogService;
}

/**
 * 工具分发核心：按 toolCall 找到 descriptor → 做环境/可用性/stub/abort 前置检查
 * → 调用 handler → 归一化结果为 IToolResult → 捕获异常（含沙箱违规结构化信息）。
 *
 * 抽出为纯函数以便单测；BuiltinToolProvider.executeTool 仅做薄包装（注入 _tools 查找 + logService）。
 */
export async function executeToolImpl(
	deps: ToolExecutorDeps,
	agentId: string,
	toolCall: IToolCall,
	signal?: AbortSignal,
): Promise<IToolResult> {
	const { resolveTool, listToolNames, logService } = deps;
	const t = resolveTool(toolCall.name);
	if (!t) {
		const names = [...listToolNames()].slice(0, 20).join(', ');
		logService.warn(`[BuiltinTools] executeTool: tool "${toolCall.name}" NOT FOUND (callId=${toolCall.id}). Registered tools: ${names}${[...listToolNames()].length > 20 ? '...' : ''}`);
		return {
			toolCallId: toolCall.id,
			success: false,
			content: [],
			error: `Unknown tool: ${toolCall.name}`,
		};
	}
	if (t.isStub) {
		logService.warn(`[BuiltinTools] executeTool: tool "${toolCall.name}" is a STUB — should have been filtered by listTools. Args: ${JSON.stringify(toolCall.arguments).slice(0, 200)}`);
	}
	if (t.available && !t.available()) {
		logService.warn(`[BuiltinTools] executeTool: tool "${toolCall.name}" not available in this environment`);
		return {
			toolCallId: toolCall.id,
			success: false,
			content: [],
			error: `Tool not available in this environment: ${toolCall.name}`,
		};
	}
	// 检查 abort signal
	if (signal?.aborted) {
		return {
			toolCallId: toolCall.id,
			success: false,
			content: [],
			error: 'Tool execution was cancelled',
			metadata: { timedOut: true, retryable: true },
		};
	}
	const startTime = Date.now();
	const argKeys = Object.keys(toolCall.arguments ?? {});
	logService.info(`[BuiltinTools] executeTool: "${toolCall.name}" (callId=${toolCall.id}, args=[${argKeys.join(',')}])`);
	try {
		// 串台防护：把 toolCall 上携带的 sessionId 透传给 handler，使 memory_remember
		// 等写入类工具能把 sessionId 写入 entry.metadata，供记忆事件按会话精确路由。
		const raw = await t.handler(toolCall.arguments ?? {}, signal, agentId, toolCall.sessionId);
		const content = Array.isArray(raw) ? raw : raw.content;
		const details = Array.isArray(raw) ? undefined : raw.details;
		const result: IToolResult = {
			toolCallId: toolCall.id,
			success: true,
			content,
			metadata: { executionTimeMs: Date.now() - startTime },
			...(details ? { details } : {}),
		};
		const contentSummary = content.map(c => c.type === 'text' ? (c.text ?? '').slice(0, 100) : `[${c.type}]`).join(' | ');
		logService.info(`[BuiltinTools] executeTool: "${toolCall.name}" OK (${Date.now() - startTime}ms) → ${contentSummary}`);
		return result;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logService.warn(`[BuiltinTools] executeTool: "${toolCall.name}" FAILED (${Date.now() - startTime}ms): ${msg}`);
		// 安全沙箱违规：附带结构化信息，供 agentOSService 检测并弹出确认卡片。
		// 注意：沙箱违规不可重试（避免 agent loop 无效重试 3 次浪费一轮）。
		if ((err as SandboxViolationError)?.isSandboxViolation) {
			const sv = err as SandboxViolationError;
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [{ type: 'text', text: msg }],
				error: msg,
				metadata: {
					executionTimeMs: Date.now() - startTime,
					retryable: false,
					sandboxViolation: {
						requestedPath: sv.requestedPath,
						resolvedPath: sv.resolvedPath,
						allowedRoots: sv.allowedRoots,
						suggestedPath: sv.suggestedPath,
						isWorktree: sv.isWorktree,
					},
				},
			};
		}
		// 永久性错误（NonRetryableToolError，如 HTTP 404/403）：标记 retryable=false，
		// executeWithRetryAndTimeout 的 runWithRetry 不会重试（避免对确定性失败白费
		// 3 次尝试 + 三倍日志噪音）。
		const retryable = (err as NonRetryableToolError)?.isNonRetryableToolError !== true;
		return {
			toolCallId: toolCall.id,
			success: false,
			// ⚠ 错误文本必须同时进 content（2026-08-21 修，日志 1787311348450）：
			// agentOSService 的三条结果映射路径（顺序/provider/并行）都只把
			// `result.content` 塞进 tool message，**从不读 `result.error`**，
			// 所以此处若留 `content: []`，模型看到的就是空结果 —— 抛错工具的
			// 诊断信息全部丢失，它既不知道失败也不知道原因。
			// 上方 sandboxViolation 分支本来就是这么做的，此处属对齐疏漏。
			content: [{ type: 'text', text: msg }],
			error: msg,
			metadata: { executionTimeMs: Date.now() - startTime, retryable },
		};
	}
}
