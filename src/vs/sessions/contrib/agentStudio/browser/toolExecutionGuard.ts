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
import { ToolSecurityLevel, ToolApprovalDecision, TOOL_APPROVAL_BACKSTOP_MS } from '../common/providers.js';
import { isPlanFileWriteCall } from '../common/planFile.js';
import { isSandboxFileWriteAutoApproved, isDestructiveToolCall } from '../common/toolApprovalPolicy.js';
import { evaluateToolCallShellSafety, isShellToolWithCommandArg, getToolCallCommandArg, ShellCommandSafety } from '../common/shellCommandSafety.js';
import {
	runWithRetry,
	type RetryPolicy,
} from '../common/resilience.js';
import { decideAskRouting, type IAskRoutingContext } from '../common/askRouting.js';

// ─── Constants ──────────────────────────────────────────────────────

/** 默认工具执行超时时间（毫秒） */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000; // 60 seconds

/**
 * 硬超时闸门的额外宽限（2026-08-20）。
 *
 * `executeWithTimeout` 先在 timeoutMs 时刻 abort（协作式，给 handler 自行清理并
 * 返回结构化结果的机会），再在 timeoutMs + 本宽限时刻由 Promise.race 硬闸门
 * 无条件返回超时结果。宽限的意义：让「配合 signal 的 handler」有机会正常收尾
 * 并保留自己的错误信息，只有真正卡死的 handler 才落到硬闸门。
 */
export const HARD_TIMEOUT_GRACE_MS = 5_000; // 5 seconds

/**
 * 编排类工具超时：delegate_task / plan_explore / subagent_batch。
 *
 * 2026-07-26 重构（事故日志 1785053998262）：**0 = 禁用守卫 wall-clock 超时**。
 * 旧值 630s 配套的是已废弃的子代理预算模型（300s/attempt + 1 retry）；现行模型
 * （用户规则 2026-07-25/26）：子代理不限轮数、不限总时长，活性仅由自身
 * 180s 内容停滞看门狗 + 480s 单响应软上限判定。630s 固定帽砍死过健康长任务
 * （34 迭代探索子代理在 630.008s 整被 interrupted）。取消固定帽后：
 * - 活性兜底 = 子代理自身看门狗（180s 无内容 → stall → salvage 部分结果）；
 * - 取消兜底 = 用户手动停止 / 父 turn abort（parentSignal 链路保留）；
 * - 工具级重试仍禁用（见 executeWithRetryAndTimeout 的 ORCHESTRATION 分支）。
 */
export const DELEGATION_TOOL_TIMEOUT_MS = 0;

/** 编排类工具名（超时与禁重试共用）。 */
const ORCHESTRATION_TOOLS = new Set(['delegate_task', 'plan_explore', 'subagent_batch', 'workflow']);

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
): Promise<IToolResult> {	const controller = new AbortController();
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

	// timeoutMs<=0（编排类工具，DELEGATION_TOOL_TIMEOUT_MS=0）：不设 wall-clock
	// 计时器——子代理活性由自身停滞看门狗判定；仅保留父级 signal 取消链路。
	const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

	// ── 硬超时闸门（2026-08-20，修「LLM 卡住、聊天框一直处理中」事故）──────────
	// 此前超时是**协作式**的：只调 controller.abort()，然后仍
	// `await provider.executeTool(...)`。若 handler 内部有不响应 signal 的悬挂
	// await（实测事故：execute_code 调用链上某个 await 永不 resolve），abort
	// 无人响应 → 这个 await 永远不返回 → 整个 agent loop 挂死、UI 永久「处理中」，
	// 且日志里连一条 timed out 都不会打（因为代码根本没走到 catch）。
	// 内置工具 provider 完全不检查 signal（builtinToolProvider 中 signal 零消费），
	// 所以协作式超时对绝大多数工具形同虚设。
	//
	// 改为 Promise.race 硬闸门：到点无条件返回超时结果，让 agent loop 得以继续
	// （模型收到 [Timeout] 反馈后可换策略）。abort 仍然发出，配合的 handler
	// 可借此提前清理；不配合的 handler 会在后台被遗弃（JS 无法强杀 Promise，
	// 但至少不再阻塞主循环——这是可接受的取舍，进程级资源由 handler 自身的
	// spawn 超时/主进程侧 kill 回收）。
	let hardTimer: ReturnType<typeof setTimeout> | undefined;
	const hardTimeoutGate = timeoutMs > 0
		? new Promise<IToolResult>((resolve) => {
			hardTimer = setTimeout(() => {
				resolve(_makeTimeoutResult(
					toolCall,
					`Tool execution timed out after ${timeoutMs}ms (hard gate — handler did not honour the abort signal)`,
					Date.now() - startTime,
				));
			}, timeoutMs + HARD_TIMEOUT_GRACE_MS);
		})
		: undefined;

	try {
		// 串台防护：把 toolCall 上携带的 sessionId 透传给 provider.executeTool → 工具
		// handler，使记忆写入事件能按 agentId::sessionId 精确路由到对应会话。
		const execPromise = provider.executeTool(agentId, toolCall, controller.signal, toolCall.sessionId);
		const result = hardTimeoutGate
			? await Promise.race([execPromise, hardTimeoutGate])
			: await execPromise;
		const executionTimeMs = Date.now() - startTime;

		// 硬闸门胜出：结果已是超时结果，原样返回（不覆盖 timedOut 标记）
		if (result.metadata?.timedOut) {
			return result;
		}

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
		if (timer !== undefined) { clearTimeout(timer); }
		if (hardTimer !== undefined) { clearTimeout(hardTimer); }
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

/**
 * 工具执行的默认重试策略。
 *
 * ⚠ **maxAttempts=1 = 工具级重试已默认禁用**（2026-08-21 数据裁决）。
 *
 * 移除依据（460 份生产日志全量统计，按 callId 配对识别真实重试）：
 *  - 发生真实工具重试的 callId：**216**
 *  - 其中被重试救回（最终成功）：**0**
 *  - 额外（纯浪费）工具执行：**432 次**；纯退避等待累计 **约 648 秒**
 *  - 抽样验证的失败性质：3/3 全为确定性失败（ENOENT ×2、重复读护栏 BLOCKED ×1）
 *
 * 三个额外理由：
 *  1. **重试污染护栏计数器**：实测重复读护栏计数随重试 4→5→6 递增 —— 工具级重试
 *     会把自己的重试计入「模型重复行为」统计，虚增计数、可能误触发其他行为护栏。
 *     这是重试机制与护栏机制的架构性冲突，加豁免无法解决。
 *  2. **黑名单模式追不上**：原策略为「默认可重试 + 显式豁免」，已积累 29 处
 *     NonRetryableToolError，每加一道护栏都要记得同时加豁免。
 *  3. **内部先例**：ORCHESTRATION_TOOLS（delegate_task 等）早在 2026-07-25 事故后
 *     就已完全禁用重试 —— 最该容错的长任务场景自己证明了重试有害。
 *  4. **外部一致**：Continue（callTool.ts 单次 try/catch）、opencode（Effect.orDie）、
 *     Hermes-Agent（tool_executor.py 无 retry）三家均无工具级重试，重试只在 LLM 层。
 *
 * 保留策略结构（而非删除整条链路）的理由：个别确有瞬态特性的场景仍可显式
 * 传入 `options.retryPolicy` opt-in（如 MCP 远端、web 429/5xx）。
 * 29 处 NonRetryableToolError 亦全部保留 —— 它们不再影响重试，但其错误文案
 * 是有价值的模型引导（「别重试，改用 X」）。
 *
 * 真瞬态失败改由**模型自行重发**（多一轮往返），这正是三家开源项目的做法：
 * 见 _makeTimeoutResult 面向模型的 "You may retry or try a different approach"。
 */
export const DEFAULT_TOOL_RETRY_POLICY: RetryPolicy = {
	initialInterval: 1000,
	backoffFactor: 2.0,
	maxInterval: 30_000,
	maxAttempts: 1,
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
 * 带「超时（+ 可选重试）」的工具执行。
 *
 * - 始终用 executeWithTimeout 提供单次超时保护（若重试开启，每次都是独立计时）。
 * - **默认不重试**（DEFAULT_TOOL_RETRY_POLICY.maxAttempts=1，见该常量注释的
 *   460 份日志数据裁决）：失败结果原样返回给调用方，由模型决定是否换做法重发。
 * - 显式传入 `options.retryPolicy`（maxAttempts>1）才启用退避重试；此时仅当某次
 *   执行返回 success=false 且 metadata.retryable=true 时重试，其他情况立即上抛。
 * - 受 AbortSignal 控制：取消时立即终止。
 *
 * 三条不重试路径的语义一致（均原样返回结果，不经异常通道）：
 * ORCHESTRATION_TOOLS（2026-07-25 事故）/ maxAttempts≤1（默认）/ 单次成功。
 */
export async function executeWithRetryAndTimeout(
	provider: IToolProvider,
	agentId: string,
	toolCall: IToolCall,
	options: RetryableToolOptions = {},
): Promise<IToolResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
	// 编排类工具禁止工具级重试：超时结果是 retryable=true，若按默认策略重试会把
	// 整批子代理从头再跑一遍（2026-07-25 事故：同一 delegate_task 连续两个 60s
	// 失败 = 第一次超时 + 一次整批重跑，白耗 120s + 双倍子代理执行）。
	// 直接单次执行，失败结果原样返回（不经 ToolRetryableError 异常通道）。
	if (ORCHESTRATION_TOOLS.has(toolCall.name)) {
		return executeWithTimeout(provider, agentId, toolCall, timeoutMs, options.parentSignal);
	}
	const policy = options.retryPolicy ?? DEFAULT_TOOL_RETRY_POLICY;
	const signal = options.signal ?? options.parentSignal;

	// 单次尝试（默认情况，见 DEFAULT_TOOL_RETRY_POLICY 的移除依据）：直接执行并
	// 原样返回结果，**不经 ToolRetryableError 异常通道**。
	// 这一分支很重要：runWithRetry 在尝试耗尽时以异常抛出，maxAttempts=1 若仍走
	// runWithRetry，则每个失败都会变成异常 —— 调用方 catch 只能拿到 error.message，
	// 丢失 result.content / metadata（timedOut、sandboxViolation、suggestedPath 等
	// 结构化字段，UI 与模型引导都依赖它们）。与 ORCHESTRATION_TOOLS 保持同一语义。
	if ((policy.maxAttempts ?? 1) <= 1) {
		return executeWithTimeout(provider, agentId, toolCall, timeoutMs, options.parentSignal);
	}

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
	// 编排类工具：禁用守卫 wall-clock 超时（0；活性由子代理自身看门狗判定，
	// 见 DELEGATION_TOOL_TIMEOUT_MS 注释与 2026-07-26 事故 1785053998262）
	if (ORCHESTRATION_TOOLS.has(toolName)) {
		return DELEGATION_TOOL_TIMEOUT_MS;
	}
	// execute_code：同样禁用守卫超时（2026-08-29，日志 1787974178941）。
	//
	// 它不在下面 slowTools 里，原本会落到 DEFAULT_TOOL_TIMEOUT_MS(60s)。守卫 abort
	// 是协作式的、handler 不响应，实际靠主进程 app.ts 的 kill timer 收尾（原 120s），
	// 于是出现「60s 发了 abort 却没人理，硬撑到 120s 才被杀」的错位。
	//
	// 该工具有**自带的 timeout 参数**并由主进程强制 kill 收尾（terminate 语义明确、
	// 会杀整棵进程树），不需要外层 wall-clock 再叠一层。交由 handler 自行管控，
	// 避免 `npm run compile` 这类长命令被外层提前掐断。
	if (toolName === 'execute_code') {
		return DELEGATION_TOOL_TIMEOUT_MS;
	}
	// MCP 工具给更多时间
	if (source?.includes('mcp') || toolName.includes('__')) {
		return MCP_TOOL_TIMEOUT_MS;
	}

/** 已知慢工具 */
		const slowTools = new Set([
			'web_search', 'browser_navigate',
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
 * 工具"始终允许"类决策的持久化存储器。
 *
 * 由 agentOSService 注入（其内部持有 IConfigurationService），把 workspace /
 * global 作用域的授权落到用户/工作区设置，从而跨会话生效。未注入时
 * ToolApprovalService 退化为仅本会话内存记忆（与旧行为一致）。
 */
export interface IToolAllowStore {
	/** 该工具（可按命令模式）是否已被持久授权。command 为 shell 工具的命令签名。 */
	isAllowed(toolName: string, command?: string): boolean;
	/** 持久记录授权。command 提供时 key = toolName::command（命令级细粒度）。 */
	remember(toolName: string, scope: 'workspace' | 'global', command?: string): void;
	/** 按完整 key（含可选 command 后缀）撤销持久授权。 */
	revoke(key: string): void;
}

/**
 * 受保护路径（fail-closed，对齐 Claude Code protected paths）。
 *
 * 即便用户对某工具选过「始终允许 / 在工作区允许」，对这类路径的写入仍**一律
 * 重新弹审批**，避免「一键放行」把仓库元数据（.git）或密钥/凭据改写权也交出去。
 * 仅做「命中即拦截」的保守匹配；路径无法判定时不误伤正常放行。
 */
const PROTECTED_EXACT_NAMES = new Set<string>([
	'.git', '.env', '.npmrc', '.git-credentials', '.netrc',
	'id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa', 'id_ecdsa_sk',
	'known_hosts', 'secrets', 'credentials',
]);
const PROTECTED_SUFFIXES = ['.pem', '.key', '.p12', '.keystore', '.jks', '.crt', '.cer'];

// ─── 命令级细粒度授权 key（P1-d）─────────────────────────────────────────
/** key 分隔符：toolName 或 toolName::commandPattern（pattern 可含 `*` 通配）。 */
export const CMD_KEY_SEP = '::';

/** 简易 glob：`*` 匹配任意字符序列，其余按字面。 */
function globMatch(pattern: string, value: string): boolean {
	if (pattern === '*') { return true; }
	const re = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$');
	return re.test(value);
}
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 规范化命令：去首尾空白、合并连续空白，作为稳定 key。 */
function normalizeCommand(cmd: string): string {
	return cmd.trim().replace(/\s+/g, ' ');
}

/** stored entry（toolName 或 toolName::pattern）是否作用于 (toolName, command)。 */
export function entryMatches(entry: string, toolName: string, command: string | undefined): boolean {
	if (!entry.includes(CMD_KEY_SEP)) {
		return entry === toolName; // 工具级 blanket（旧数据 / 非 shell 工具）
	}
	const sepIdx = entry.indexOf(CMD_KEY_SEP);
	const t = entry.slice(0, sepIdx);
	const pattern = entry.slice(sepIdx + CMD_KEY_SEP.length);
	if (t !== toolName && t !== '*') { return false; }
	if (command === undefined) { return false; }
	return globMatch(pattern, command);
}

/** 从工具调用的参数中提取文件路径（兼容已解析对象与 JSON 字符串两种形态）。 */
function getToolCallPathArg(toolCall: { arguments?: unknown }): string | undefined {
	const args = toolCall.arguments;
	let obj: Record<string, unknown> | undefined;
	if (args && typeof args === 'object') {
		obj = args as Record<string, unknown>;
	} else if (typeof args === 'string') {
		try {
			obj = JSON.parse(args) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}
	if (!obj) {
		return undefined;
	}
	for (const key of ['path', 'file_path', 'filePath', 'file', 'target', 'destination']) {
		const v = obj[key];
		if (typeof v === 'string' && v.trim()) {
			return v;
		}
	}
	return undefined;
}

/** 该路径是否命中受保护集合（按路径段精确匹配，规避 `.github` 误伤 `.git` 之类）。 */
function isProtectedPath(p: string | undefined): boolean {
	if (!p) {
		return false;
	}
	const lower = p.toLowerCase().replace(/\\/g, '/');
	const segs = lower.split('/').filter(Boolean);
	for (const seg of segs) {
		if (PROTECTED_EXACT_NAMES.has(seg)) {
			return true;
		}
		if (PROTECTED_SUFFIXES.some(s => seg.endsWith(s))) {
			return true;
		}
		// .env.local / .env.production 等环境文件变体
		if (seg.startsWith('.env.') || seg === '.env') {
			return true;
		}
	}
	// 兜底：路径中任意处出现的 .git 目录（如 repo/.git/config）
	return lower.includes('/.git/') || lower.endsWith('/.git') || lower === '.git';
}

/**
 * 工具审批服务 — 管理工具执行前的用户确认流程。
 *
 * 提供：
 *  - 安全等级评估
 *  - "always allow" 记忆（本会话内不再重复询问；workspace/global 还可持久化）
 *  - 异步审批流（UI handler 注入）
 */
export class ToolApprovalService {
	private _handler: IToolApprovalHandler | undefined;

	/**
	 * 计划目录解析器（`<sarosRoot>/plans`）。
	 *
	 * 由 agentOSService 注入 —— 用于「写计划文件免审批」的豁免判定
	 * （2026-08-21 修 plan 模式死锁，日志 1787294819356）。
	 * 未注入时豁免整体失效（`isPlanFileWriteCall` 收到空 planRoot 返回 false），
	 * 退化为原有的正常审批流程，不会误放行。
	 */
	private _planRootProvider: (() => string) | undefined;

	/** 注入计划目录解析器（延迟求值：sarosRoot 依赖 environmentService，构造期可能未就绪）。 */
	setPlanRootProvider(provider: () => string): void {
		this._planRootProvider = provider;
	}

	/**
	 * 「终端只读/验证构建命令免确认」开关读取器（用户设置 `sessions.agentStudio.tools.autoApproveReadOnlyCommands`）。
	 *
	 * 未注入 / 返回 false 时，终端命令**一律弹审批**（设置默认 true，用户可关闭）——
	 * 这是刻意的"只能升级不能降级"设计（抄 continue 的 getMostRestrictive 思路）：
	 * 命令内容分析只放行「已知只读或验证/构建」命令，且危险命令仍会被拦。
	 */
	private _terminalAutoApproveProvider: (() => boolean) | undefined;

	/** 注入开关读取器（惰性求值：配置可随时被用户改动，不能构造期取一次就固化）。 */
	setTerminalAutoApproveProvider(provider: () => boolean): void {
		this._terminalAutoApproveProvider = provider;
	}

	/** 本会话内已"永久允许"的工具名集合 */
	private readonly _alwaysAllowed = new Set<string>();

	/** 本会话内已"永久拒绝"的工具名集合 */
	private readonly _alwaysDenied = new Set<string>();

	/** 持久化授权存储器（可选，由 agentOSService 注入） */
	private _allowStore: IToolAllowStore | undefined;

	/**
	 * 注册 UI 审批处理器
	 */
	setApprovalHandler(handler: IToolApprovalHandler): void {
		this._handler = handler;
	}

	/**
	 * 注入持久化授权存储器（workspace / global 作用域）。
	 * 未注入时退化为仅本会话内存记忆（旧行为）。
	 */
	setToolAllowStore(store: IToolAllowStore): void {
		this._allowStore = store;
	}

	/**
	 * 撤销某工具的"始终允许 / 在工作区允许"记忆：清掉会话内缓存，
	 * 并委托持久化存储器移除对应设置项。撤销后该工具下次调用将重新弹窗。
	 */
	revoke(key: string): void {
		this._alwaysAllowed.delete(key);
		this._alwaysDenied.delete(key);
		this._allowStore?.revoke(key);
	}

	/** 构造授权 key：命令级时带 normalize 后的 command，否则仅工具名。 */
	private _buildKey(toolName: string, command?: string): string {
		return command ? `${toolName}${CMD_KEY_SEP}${command}` : toolName;
	}

	/** 命令级（含 glob）命中检测：内存集合 + 持久化存储器。 */
	private _isAllowed(toolName: string, command?: string): boolean {
		for (const e of this._alwaysAllowed) {
			if (entryMatches(e, toolName, command)) { return true; }
		}
		return this._allowStore?.isAllowed(toolName, command) ?? false;
	}

	/** 命令级（含 glob）拒绝命中检测（仅内存集合）。 */
	private _isDenied(toolName: string, command?: string): boolean {
		for (const e of this._alwaysDenied) {
			if (entryMatches(e, toolName, command)) { return true; }
		}
		return false;
	}

	/**
	 * 交互审批的兜底等待上限（2026-08-21，修「LLM 被卡住、聊天框永久处理中」事故）。
	 *
	 * ⚠ 这里只是**兜底**：权威超时在 agentOSService 的内置 handler 内
	 * （TOOL_APPROVAL_TIMEOUT_MS，超时会额外 cancelAgentLoop 终止 LLM）。
	 * 因此本值必须**大于** TOOL_APPROVAL_TIMEOUT_MS，否则兜底先触发，
	 * handler 的「终止 LLM」分支永远走不到。
	 *
	 * 同时必须**小于** DANGEROUS_TOOL_TIMEOUT_MS(300s)：审批发生在
	 * executeWithRetryAndTimeout（含硬超时闸门）**之外**，闸门管不到它，
	 * 所以这里必须自带上限，否则一次无人响应的审批就永久挂死 agent loop。
	 */
	private static readonly APPROVAL_WAIT_TIMEOUT_MS = TOOL_APPROVAL_BACKSTOP_MS;

	/**
	 * 检查工具是否需要审批，并执行审批流程。
	 *
	 * @param ctx 发起 turn 的 agent/session（超时终止 loop 时需按 turnKey 精确取消）
	 * @returns true 表示允许执行，false 表示被拒绝
	 */
	async checkAndApprove(
		toolCall: IToolCall,
		toolDef: IToolDefinition | undefined,
		routing?: IAskRoutingContext,
		ctx?: { readonly agentId?: string; readonly sessionId?: string },
	): Promise<boolean> {
		const securityLevel = toolDef?.securityLevel ?? ToolSecurityLevel.Safe;

		// ─── 破坏性操作强制审批（2026-08-21，用户决策）─────────────────────
		// 必须排在下面的 `Safe` 早返回**之前**，否则毫无作用：
		// `checkAndApprove` 读的是 `toolDef?.securityLevel ?? Safe`，而
		// `inferSecurityLevel` 是**死代码（零生产调用）** → 内置工具不声明
		// securityLevel 就等于 Safe、直接放行。审计实测 85 个工具里只有 4 个声明了
		// Dangerous，导致 delete_project / memory_delete / memory_forget /
		// web_recipe_remove / skill_manage(action=delete) /
		// memory_governance(action=bulk_delete) **全部无审批直接执行**。
		//
		// 判定真源 = `common/toolApprovalPolicy.isDestructiveToolCall`（纯函数），
		// 那里说明了为何只按**工具名**匹配（按描述匹配会误伤 kanban_unblock 这类
		// 状态流转工具）、以及为何多操作工具要按**操作参数**而非整体标级
		// （否则 skill_manage(create) / memory_governance(audit) 也会弹窗）。
		//
		// ⚠ 只覆盖 `Safe` 早返回，**不覆盖** `_alwaysAllowed`：后者是用户对该工具的
		// 显式长期授权，继续尊重它，与系统其余部分语义一致。
		const forceApproval = isDestructiveToolCall(toolCall.name, toolCall.arguments);
		// 强制审批时按 Dangerous 呈现（影响卡片文案与 reason），让用户看清风险
		const effectiveSecurityLevel = forceApproval ? ToolSecurityLevel.Dangerous : securityLevel;

		// Safe 工具不需要审批
		if (securityLevel === ToolSecurityLevel.Safe && !forceApproval) {
			return true;
		}

		// ─── 计划文件写入豁免（2026-08-21，修 plan 模式死锁）──────────────
		// 事故日志 1787294819356：plan 模式下 hardPermission **已**豁免写计划文件，
		// 但审批层没有 → file_write 仍按 dangerous 级别要求审批 → 审批 UI 未渲染
		// → 120s 超时被自动拒 → 计划永远写不进去 → plan_exit 恒因 tasks=0 被拒 → 死锁。
		//
		// 写计划文件是 plan 模式的本职动作（且路径被严格限定在 planRoot 内，
		// 见 isPlanFileWriteCall 的三重校验），不应触发面向"改用户代码"的审批。
		// 放在 _alwaysDenied 检查**之前**：即使用户曾对 file_write 选过"总是拒绝"，
		// 也不该把 plan 模式自身的记录能力一起锁死。
		const planRoot = this._planRootProvider?.();
		if (planRoot && isPlanFileWriteCall(toolCall.name, toolCall.arguments, planRoot)) {
			return true;
		}

		// ─── 沙箱内非删除类文件操作免交互审批（2026-08-21，用户决策）──────────
		// 用户策略：**操作沙箱内的文件，非删除类的操作，都可以直接放行。**
		//
		// 判定真源 = `common/toolApprovalPolicy.isSandboxFileWriteAutoApproved`
		// （纯函数、可单测），那里详述了「为什么用规则而非硬编码工具名清单」
		// 以及 shell / delete / move 为何一律排除。
		//
		// 之所以安全，靠的是**三道仍然生效的闸门**，而不是"降低了要求"：
		//   ① 越界写仍被拦：文件类工具的 resolveAndCheckWorkspacePath 走
		//      checkSandbox=true，路径不在允许根内会抛 SandboxViolationError →
		//      agentOSService 弹「安全沙箱限制」卡片交用户裁决（允许本次／允许此
		//      工作区／改用建议路径）。**所以放行的实质只有"沙箱内"，与用户要求一致。**
		//   ② hardPermission 不受影响：ask / plan 等只读档位仍在 executor 层禁写，
		//      本豁免只去掉交互确认，不触碰权限档判定。
		//   ③ 有回滚点：handler 在写盘前调 captureBeforeToolEdit 生成 tool_edit
		//      checkpoint，用户可在检查点条上撤销。（patch 那条是 2026-08-21 补的，
		//      此前只有 file_write 有 —— 否则会变成"既不问也撤不了"。）
		//
		// 仍保留定义里的 securityLevel=Dangerous：它另有用途（300s 的
		// DANGEROUS_TOOL_TIMEOUT_MS、UI 标识、hardPermission 语义），不能改成 Safe。
		// 放在 _alwaysDenied 之前，语义与上面的计划文件豁免一致（即使用户曾对某个
		// 写工具选过"总是拒绝"，也不该把编辑能力永久锁死）。
		// `!forceApproval` 是**纵深防御**：本判定是规则式（动词匹配），若日后有人
		// 放宽 FILE_WRITE_VERBS 或加入某个破坏性 category，破坏性调用可能从这里溜过。
		// 当前 isSandboxFileWriteAutoApproved 已排除 delete/remove 等动词，此处属冗余保险。
		if (!forceApproval && isSandboxFileWriteAutoApproved(toolDef)) {
			return true;
		}

		// ─── 终端只读/验证构建命令免确认（2026-08-21 方案 B + 2026-08-22 扩展）────
		// 判定真源 = `common/shellCommandSafety.evaluateToolCallShellSafety`（纯函数）。
		//
		// 三重前提，缺一不放行：
		//   ① 设置开启（默认 true，用户可关闭；provider 未注入或返回 false → 一律弹审批）；
		//   ② 该工具确实是带 command 参数的 shell 工具（terminal / execute_code）；
		//   ③ 命令通过白名单分析（无危险元字符、每个管道段都是已知只读或验证/构建命令）。
		//
		// 这是「只能升级不能降级」模型（抄 continue `getMostRestrictive` 的思路）：
		// 开启后只放行**已知只读 + 验证/构建**（tsc/esbuild/vite、npm/yarn/pnpm run
		// build/test/lint 等），未知与裸解释器（python3 -c / node -e）一律 fail-closed。
		// 且 handler 层的 HARDLINE 地板与源码写入护栏独立生效，本分支放行不绕过它们。
		//
		// `!forceApproval` 同样作纵深防御（破坏性判定优先）。
		if (
			!forceApproval
			&& isShellToolWithCommandArg(toolCall.name)
			&& this._terminalAutoApproveProvider?.() === true
			&& evaluateToolCallShellSafety(toolCall.name, toolCall.arguments) === ShellCommandSafety.Safe
		) {
			return true;
		}

		// 受保护路径 fail-closed（P1，对齐 Claude Code protected paths）：
		// 即便用户对该工具选过「始终允许 / 在工作区允许」，对 .git / .env / SSH 私钥 /
		// 凭据 / 证书等敏感路径的写入仍一律重新弹审批，避免「一键放行」误交密钥改写权。
		// 仅做命中即拦截的保守匹配；路径无法判定时不误伤正常放行。终端命令无 path 参数，
		// getToolCallPathArg 返回 undefined → 此处恒为 false，故不影响终端「始终允许」免打扰。
		const isProtected = isProtectedPath(getToolCallPathArg(toolCall));

		// 命令级细粒度 key：shell 工具的命令内容作为 key 的一部分，
		// 使「始终允许 terminal」只放行具体命令而非整个终端工具。
		const rawCmd = isShellToolWithCommandArg(toolCall.name)
			? getToolCallCommandArg(toolCall.name, toolCall.arguments)
			: undefined;
		const command = rawCmd ? normalizeCommand(rawCmd) : undefined;

		// 检查 always-allow 缓存（含持久化授权，跨会话生效；命令级 glob 匹配）
		if (!isProtected && this._isAllowed(toolCall.name, command)) {
			return true;
		}
		if (this._isDenied(toolCall.name, command)) {
			return false;
		}

		// ─── P1: 审批路由（MiMo decideAskRouting）─────────────────────
		// 在弹交互确认之前，按发起 turn 的 agent 身份/模式决定路由：
		//   - subagent（后台）→ inherit：非交互放行（工具集已被 SUB_AGENT_PERMISSIONS
		//     收窄，能调到的即在权限档内），不阻塞父级 loop。
		//   - system         → auto-deny：非交互拒绝越权工具，不阻塞 loop。
		//   - foreground / 未提供 → interactive：继续走下方 handler 交互确认。
		if (routing) {
			const decision = decideAskRouting(routing);
			if (decision === 'inherit') {
				return true;
			}
			if (decision === 'auto-deny') {
				return false;
			}
			// 'interactive' → 落入下方交互确认流程
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
			securityLevel: effectiveSecurityLevel,
			reason: forceApproval
				? `Tool "${toolCall.name}" performs a destructive operation (delete/remove) that cannot be undone by a checkpoint.`
				: effectiveSecurityLevel === ToolSecurityLevel.Dangerous
					? `Tool "${toolCall.name}" can modify files or execute system commands.`
					: `Tool "${toolCall.name}" may have side effects.`,
			agentId: ctx?.agentId,
			sessionId: ctx?.sessionId,
		};

		// ── 交互审批（带超时闸门，2026-08-21 修永久挂死）──────────────────
		// requestApproval 的实现（agentStudioWebviewController:291）是
		// `new Promise(resolve => { pendingMap.set(id, resolve); sendEvent(webview) })`
		// —— **无超时、无 reject**，只能由 webview 里的用户点击来 resolve。
		// 因此任何「事件到不了 UI / UI 不显示审批卡片」的情况都会让它永不 settle：
		//   ★ 实测事故（日志 1787276571583）：用户在 **native chat pane** 里工作，
		//     而审批 handler 只由 agentStudioWebviewController 注册、事件只发给
		//     webview（nativeChatEditorPane 对 toolApprovalRequest 零处理）→
		//     terminal 首次调用需审批 → 卡片永远不出现 → `Executing tool: terminal`
		//     之后 15.5 分钟零日志，UI 永久「处理中」。
		//   其它同类：webview 已销毁/未就绪、消息丢失、用户滚开没看到卡片。
		// 关键：审批位于 executeWithRetryAndTimeout（含硬超时闸门）**之外**，
		// 闸门救不了它，必须在此自带上限。
		// 超时按 **拒绝** 处理（安全优先，绝不默认放行危险工具），但日志与返回给
		// 模型的文案要能区分「超时」与「用户主动拒绝」，避免模型误判用户意图。
		const decision = await Promise.race([
			this._handler.requestApproval(request),
			new Promise<ToolApprovalDecision>((resolve) => {
				setTimeout(
					() => resolve(ToolApprovalDecision.Deny),
					ToolApprovalService.APPROVAL_WAIT_TIMEOUT_MS,
				);
			}),
		]);
		// 注：超时后 handler 内部的 pending entry 仍留在其 map 中（本服务无从清理）；
		// 用户事后点击只会 resolve 一个已无人 await 的 Promise，无副作用。
		// 后续可给 IToolApprovalHandler 增设 cancelApproval(toolCallId) 做彻底清理。

		switch (decision) {
			case ToolApprovalDecision.AllowOnce:
				return true;
			case ToolApprovalDecision.AllowSession:
				// 仅本会话内记忆（旧 "allow_always" 的会话级行为）
				this._alwaysAllowed.add(this._buildKey(toolCall.name, command));
				return true;
			case ToolApprovalDecision.AllowWorkspace:
				// 会话内 + 持久化到工作区设置（跨会话生效）
				this._alwaysAllowed.add(this._buildKey(toolCall.name, command));
				this._allowStore?.remember(toolCall.name, 'workspace', command);
				return true;
			case ToolApprovalDecision.AllowAlways:
				// "始终允许"：会话内 + 持久化到用户设置（跨会话生效）
				this._alwaysAllowed.add(this._buildKey(toolCall.name, command));
				this._allowStore?.remember(toolCall.name, 'global', command);
				return true;
			case ToolApprovalDecision.Deny:
				// ⚠ 超时也会走到这里。**不写入 _alwaysDenied**——否则一次「UI 没显示
				// 审批卡片」的超时会把该工具在整个会话内永久拉黑，模型此后每次调用
				// 都被静默拒绝，表现为「这个工具坏了」。只有用户**主动**拒绝才该记忆，
				// 而当前 handler 协议无法区分二者，故一律不记忆（宁可多问一次）。
				return false;
			case ToolApprovalDecision.DenyAlways:
				// 用户显式「始终拒绝」：本会话内该工具（命令级）一律拒绝，不再弹窗
				this._alwaysDenied.add(this._buildKey(toolCall.name, command));
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
			// 'patch' / 'edit' 必须在此（2026-08-21 补，日志 1787311348450）：
			// 它们本来只在 category==='filesystem' 分支里被识别，一旦某个工具把
			// category 写成 'file' 之类的近似值（曾真实发生），就会一路落到这里
			// 并被判 Safe → 写文件却无审批、无 checkpoint。名称兜底与 category
			// 判定互为双保险。
			'write', 'delete', 'remove', 'exec', 'shell', 'terminal',
			'run_command', 'execute_command', 'bash', 'deploy', 'push',
			'patch', 'edit',
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
