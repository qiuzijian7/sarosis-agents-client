/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tool Execution Guard — 超时机制 + 审批流程
 *
 * 参考 OpenClaw 的设计：
 *  - AbortSignal 传递到每个 tool.execute()
 *  - before_tool_call hook + exec.approval.request/waitDecision
 *
 * 本模块提供：
 *  1. executeWithTimeout() — 带超时保护的工具执行包装器
 *  2. ToolApprovalService — 工具执行前审批服务
 *  3. ToolExecutionTracker — 并发工具执行追踪（参考 OpenClaw 的 countActiveToolExecutions）
 */

import type {
	IToolProvider, IToolCall, IToolResult, IToolDefinition,
	IToolApprovalRequest, IToolApprovalHandler,
} from '../common/providers.js';
import { ToolSecurityLevel, ToolApprovalDecision } from '../common/providers.js';
import {
	runWithRetry,
	type RetryPolicy,
} from '../common/resilience.js';

// ─── Constants ──────────────────────────────────────────────────────

/** 默认工具执行超时时间（毫秒） */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000; // 60 seconds

/** MCP 工具的超时时间（MCP 服务器可能更慢） */
export const MCP_TOOL_TIMEOUT_MS = 120_000; // 120 seconds

/** 危险工具（需要审批）的超时时间（包含等待用户确认的时间） */
export const DANGEROUS_TOOL_TIMEOUT_MS = 300_000; // 5 minutes

/** 最大并发工具执行数 */
export const MAX_CONCURRENT_EXECUTIONS = 8;

// ─── Timeout-protected execution ────────────────────────────────────

/**
 * 带超时保护的工具执行。
 *
 * 当工具执行超过 timeoutMs 时，AbortController 会发出 abort 信号，
 * 并返回一个标记 `timedOut: true` 的失败结果。
 *
 * @param provider 工具提供者
 * @param agentId Agent ID
 * @param toolCall 工具调用
 * @param timeoutMs 超时时间（毫秒）
 * @param parentSignal 父级 AbortSignal（如整个 agent loop 被取消）
 * @returns 工具执行结果（含 metadata）
 */
export async function executeWithTimeout(
	provider: IToolProvider,
	agentId: string,
	toolCall: IToolCall,
	timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
	parentSignal?: AbortSignal,
): Promise<IToolResult> {
	const controller = new AbortController();
	const startTime = Date.now();

	// 链接父级 signal
	let parentAbortHandler: (() => void) | undefined;
	if (parentSignal) {
		if (parentSignal.aborted) {
			return _makeTimeoutResult(toolCall, 'Agent loop was cancelled');
		}
		parentAbortHandler = () => controller.abort();
		parentSignal.addEventListener('abort', parentAbortHandler, { once: true });
	}

	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const result = await provider.executeTool(agentId, toolCall, controller.signal);
		const executionTimeMs = Date.now() - startTime;

		// 补充 metadata
		return {
			...result,
			metadata: {
				...result.metadata,
				executionTimeMs,
				timedOut: false,
			},
		};
	} catch (error) {
		const executionTimeMs = Date.now() - startTime;

		if (controller.signal.aborted) {
			// 超时或被父级取消
			const reason = parentSignal?.aborted
				? 'Agent loop was cancelled'
				: `Tool execution timed out after ${timeoutMs}ms`;
			return _makeTimeoutResult(toolCall, reason, executionTimeMs);
		}

		// 其他错误
		return {
			toolCallId: toolCall.id,
			success: false,
			content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
			error: error instanceof Error ? error.message : String(error),
			metadata: {
				executionTimeMs,
				retryable: true,
			},
		};
	} finally {
		clearTimeout(timer);
		if (parentAbortHandler && parentSignal) {
			parentSignal.removeEventListener('abort', parentAbortHandler);
		}
	}
}

function _makeTimeoutResult(toolCall: IToolCall, reason: string, executionTimeMs?: number): IToolResult {
	return {
		toolCallId: toolCall.id,
		success: false,
		content: [{
			type: 'text',
			text: `[Timeout] ${reason}. The tool "${toolCall.name}" did not complete in time. You may retry or try a different approach.`,
		}],
		error: reason,
		metadata: {
			executionTimeMs,
			timedOut: true,
			retryable: true,
		},
	};
}

// ─── Retryable error + retry-with-timeout ───────────────────────────

/**
 * 标记「本次工具执行失败但可重试」的错误。
 * executeWithRetryAndTimeout 在非成功且 metadata.retryable 时抛出它，
 * 让 runWithRetry 据此退避重试（避免对不可重试错误白费重试）。
 */
class ToolRetryableError extends Error {
	readonly isRetryableToolError = true;
	constructor(public readonly result?: IToolResult) {
		super(result?.error || 'tool execution failed (retryable)');
		this.name = 'ToolRetryableError';
	}
}

/** 工具执行的默认重试策略：3 次、指数退避、仅重试标记 retryable 的失败 */
export const DEFAULT_TOOL_RETRY_POLICY: RetryPolicy = {
	initialInterval: 1000,
	backoffFactor: 2.0,
	maxInterval: 30_000,
	maxAttempts: 3,
	jitter: true,
	retryOn: (err: unknown) => (err as ToolRetryableError)?.isRetryableToolError === true,
};

export interface RetryableToolOptions {
	timeoutMs?: number;
	retryPolicy?: RetryPolicy;
	/** 父级取消信号（整个 agent loop 取消时透传） */
	parentSignal?: AbortSignal;
	/** 本次执行自身的取消信号（优先级高于 parentSignal） */
	signal?: AbortSignal;
	/** 每次重试回调（日志 / 上报） */
	onRetry?: (info: { attempt: number; error: string; delayMs: number }) => void;
}

/**
 * 带「超时 + 指数退避重试」的工具执行。
 *
 * - 内层仍用 executeWithTimeout 提供单次超时保护（每次重试都是独立计时）。
 * - 当某次执行返回 success=false 且 metadata.retryable=true（超时 / 可重试异常）
 *   时，按 retryPolicy 退避后重试；其他情况立即上抛结果（不再重试）。
 * - 受 AbortSignal 控制：取消时立即终止，不再重试。
 *
 * 这是 P0 容错增强：对齐 LangGraph RetryPolicy，解决限流 / 瞬时故障下的
 * 「一次失败即放弃」问题。
 */
export async function executeWithRetryAndTimeout(
	provider: IToolProvider,
	agentId: string,
	toolCall: IToolCall,
	options: RetryableToolOptions = {},
): Promise<IToolResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
	const policy = options.retryPolicy ?? DEFAULT_TOOL_RETRY_POLICY;
	const signal = options.signal ?? options.parentSignal;

	return runWithRetry(
		async () => {
			const result = await executeWithTimeout(provider, agentId, toolCall, timeoutMs, options.parentSignal);
			if (!result.success && result.metadata?.retryable) {
				throw new ToolRetryableError(result);
			}
			return result;
		},
		policy,
		{
			signal,
			onRetry: options.onRetry
				? ({ attempt, error, delayMs }) => options.onRetry!({ attempt, error: error instanceof Error ? error.message : String(error), delayMs })
				: undefined,
		},
	);
}

/**
 * 根据工具类型确定超时时间
 */
export function getTimeoutForTool(toolName: string, toolDef?: IToolDefinition, source?: string): number {
	// MCP 工具给更多时间
	if (source?.includes('mcp') || toolName.includes('__')) {
		return MCP_TOOL_TIMEOUT_MS;
	}

/** 已知慢工具 */
	const slowTools = new Set([
		'web_search', 'http_get', 'browser_navigate',
		'shell_exec', 'terminal', 'execute_command',
	]);

	// Codebase analysis tools — these scan the entire project and can
	// block the UI for tens of seconds on large codebases.  Shorter
	// timeout forces them to fail fast (P2-6 fix).
	const analysisTools = new Set([
		'get_architecture', 'search_graph', 'query_graph',
		'trace_path', 'detect_changes', 'index_repository',
	]);
	if (analysisTools.has(toolName)) {
		return 30_000; // 30 seconds for codebase analysis
	}

	if (slowTools.has(toolName)) {
		return MCP_TOOL_TIMEOUT_MS;
	}

	// 危险工具（可能需等待审批）
	if (toolDef?.securityLevel === ToolSecurityLevel.Dangerous) {
		return DANGEROUS_TOOL_TIMEOUT_MS;
	}

	return DEFAULT_TOOL_TIMEOUT_MS;
}

// ─── Tool Approval Service ──────────────────────────────────────────

/**
 * 工具审批服务 — 管理工具执行前的用户确认流程。
 *
 * 提供：
 *  - 安全等级评估
 *  - "always allow" 记忆（本会话内不再重复询问）
 *  - 异步审批流（UI handler 注入）
 */
export class ToolApprovalService {
	private _handler: IToolApprovalHandler | undefined;

	/** 本会话内已"永久允许"的工具名集合 */
	private readonly _alwaysAllowed = new Set<string>();

	/** 本会话内已"永久拒绝"的工具名集合 */
	private readonly _alwaysDenied = new Set<string>();

	/**
	 * 注册 UI 审批处理器
	 */
	setApprovalHandler(handler: IToolApprovalHandler): void {
		this._handler = handler;
	}

	/**
	 * 检查工具是否需要审批，并执行审批流程。
	 *
	 * @returns true 表示允许执行，false 表示被拒绝
	 */
	async checkAndApprove(
		toolCall: IToolCall,
		toolDef: IToolDefinition | undefined,
	): Promise<boolean> {
		const securityLevel = toolDef?.securityLevel ?? ToolSecurityLevel.Safe;

		// Safe 工具不需要审批
		if (securityLevel === ToolSecurityLevel.Safe) {
			return true;
		}

		// 检查 always-allow / always-deny 缓存
		if (this._alwaysAllowed.has(toolCall.name)) {
			return true;
		}
		if (this._alwaysDenied.has(toolCall.name)) {
			return false;
		}

		// Cautious 工具：首次使用时审批
		// Dangerous 工具：每次审批
		if (!this._handler) {
			// 没有注册 handler — 默认允许（降级到无审批模式）
			return true;
		}

		const request: IToolApprovalRequest = {
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			arguments: toolCall.arguments,
			securityLevel,
			reason: securityLevel === ToolSecurityLevel.Dangerous
				? `Tool "${toolCall.name}" can modify files or execute system commands.`
				: `Tool "${toolCall.name}" may have side effects.`,
		};

		const decision = await this._handler.requestApproval(request);

		switch (decision) {
			case ToolApprovalDecision.AllowOnce:
				return true;
			case ToolApprovalDecision.AllowAlways:
				this._alwaysAllowed.add(toolCall.name);
				return true;
			case ToolApprovalDecision.Deny:
				this._alwaysDenied.add(toolCall.name);
				return false;
			default:
				return false;
		}
	}

	/**
	 * 重置所有审批记忆（新会话时调用）
	 */
	reset(): void {
		this._alwaysAllowed.clear();
		this._alwaysDenied.clear();
	}

	/**
	 * 判断工具的安全等级（基于名称和类别的默认规则）
	 */
	static inferSecurityLevel(toolDef: IToolDefinition): ToolSecurityLevel {
		// 如果工具已声明安全等级，直接使用
		if (toolDef.securityLevel) {
			return toolDef.securityLevel;
		}

		// 基于 category 推断
		const category = toolDef.category?.toLowerCase();
		if (category === 'filesystem') {
			// 文件写入类 → Dangerous；读取类 → Safe
			const name = toolDef.name.toLowerCase();
			if (name.includes('write') || name.includes('delete') || name.includes('create') || name.includes('patch')) {
				return ToolSecurityLevel.Dangerous;
			}
			return ToolSecurityLevel.Safe;
		}
		if (category === 'shell' || category === 'terminal') {
			return ToolSecurityLevel.Dangerous;
		}
		if (category === 'web') {
			return ToolSecurityLevel.Cautious;
		}

		// 基于工具名推断
		const name = toolDef.name.toLowerCase();
		const dangerousPatterns = [
			'write', 'delete', 'remove', 'exec', 'shell', 'terminal',
			'run_command', 'execute_command', 'bash', 'deploy', 'push',
		];
		const cautiousPatterns = [
			'http', 'fetch', 'browser', 'navigate', 'download', 'upload',
		];

		for (const pattern of dangerousPatterns) {
			if (name.includes(pattern)) { return ToolSecurityLevel.Dangerous; }
		}
		for (const pattern of cautiousPatterns) {
			if (name.includes(pattern)) { return ToolSecurityLevel.Cautious; }
		}

		return ToolSecurityLevel.Safe;
	}
}

// ─── Tool Execution Tracker ─────────────────────────────────────────

/**
 * 工具执行追踪器 — 追踪当前活跃的工具执行数量和状态。
 * 参考 OpenClaw 的 `countActiveToolExecutions()`。
 */
export class ToolExecutionTracker {
	private readonly _activeExecutions = new Map<string, {
		toolName: string;
		startTime: number;
		abortController: AbortController;
	}>();

	/** 当前活跃执行数 */
	get activeCount(): number {
		return this._activeExecutions.size;
	}

	/** 是否已达到并发上限 */
	get isFull(): boolean {
		return this._activeExecutions.size >= MAX_CONCURRENT_EXECUTIONS;
	}

	/**
	 * 注册一个新的工具执行
	 */
	track(toolCallId: string, toolName: string): AbortController {
		const controller = new AbortController();
		this._activeExecutions.set(toolCallId, {
			toolName,
			startTime: Date.now(),
			abortController: controller,
		});
		return controller;
	}

	/**
	 * 标记执行完成
	 */
	complete(toolCallId: string): number | undefined {
		const entry = this._activeExecutions.get(toolCallId);
		if (!entry) { return undefined; }
		const elapsed = Date.now() - entry.startTime;
		this._activeExecutions.delete(toolCallId);
		return elapsed;
	}

	/**
	 * 取消指定工具执行
	 */
	cancel(toolCallId: string): void {
		const entry = this._activeExecutions.get(toolCallId);
		if (entry) {
			entry.abortController.abort();
			this._activeExecutions.delete(toolCallId);
		}
	}

	/**
	 * 取消所有活跃执行
	 */
	cancelAll(): void {
		for (const [_id, entry] of this._activeExecutions) {
			entry.abortController.abort();
		}
		this._activeExecutions.clear();
	}

	/**
	 * 获取所有活跃执行的快照
	 */
	getActiveExecutions(): ReadonlyArray<{ toolCallId: string; toolName: string; elapsedMs: number }> {
		const now = Date.now();
		return Array.from(this._activeExecutions.entries()).map(([id, entry]) => ({
			toolCallId: id,
			toolName: entry.toolName,
			elapsedMs: now - entry.startTime,
		}));
	}
}
