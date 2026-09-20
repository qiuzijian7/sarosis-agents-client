/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 子代理实例/事件声明族（A3 同款拆分策略，2026-09-20）：实例选项与结果 / 事件系统 / 退出原因 /
 * 超时错误 / 兼容别名。自 unifiedSubAgentDispatch.ts 原样搬出（零行为改动）。
 * ⚠ 原文件以 `export *` 转出 ⇒ 调用点零改动；SubAgentTimeoutError 改为 export（主文件需 instanceof 匹配）。
 */

import type { IterationBudget } from './iterationBudget.js';
import type { InterruptSignal } from './effectRuntime.js';
import type { StallWatchdog } from './stallWatchdog.js';
import type { SubagentTokenCollector, SubagentTokenUsage } from './subagentTokenCollector.js';
import type { IModelSelection } from './providers.js';
import type { ISubAgentStructuredResult } from './completionGate.js';
import type { ISubAgentPostStopHook } from './subAgentHooks.js';
import type { IForkContext } from './forkContext.js';
import { SubAgentType, type SubAgentIsolationLevel } from './subAgentModel.js';

// ─── SubAgent Instance Types ─────────────────────────────────────────────

export interface SubAgentOptions {
	/** SubAgent type — determines tool permissions */
	readonly type?: SubAgentType;
	/** Max iterations for this sub-agent (default: derived from parent budget) */
	readonly maxIterations?: number;
	/**
	 * 总时长上限（ms，默认 600_000 = 10min，对齐 MiMo actor timeout_ms）。
	 * 超时语义（2026-07-26 规则）：走 salvage 部分完成（保留产出 + P1 总结），
	 * 而非硬失败；0 = 禁用限时（回到「不限总时长」旧规则）。
	 */
	readonly timeout?: number;
	/**
	 * 软预算（wall-clock，ms）：耗时超过该值时主循环注入一次收尾提醒（不打断
	 * 执行）。缺省按 timeout×SUBAGENT_SOFT_BUDGET_RATIO 推导；timeout=0 时禁用。
	 */
	readonly softDeadlineMs?: number;
	/** Priority for scheduling (low/medium/high) */
	readonly priority?: 'low' | 'medium' | 'high';
	/** Parent's stable ChatMode policy. */
	readonly parentChatMode?: string;
	/** Parent's mutable WorkMode; plan subagents inherit the read-only ceiling. */
	readonly parentWorkMode?: 'plan' | 'work';
	/** Additional context to inject (e.g., repo_overview output) */
	readonly context?: string;
	/** Whether this is a background sub-agent (non-blocking) */
	readonly background?: boolean;
	/** Parent session ID for context isolation */
	readonly parentSessionId?: string;
	/**
	 * v17: per-subagent worktree path override. Inherited from the parent
	 * agent's execution context (set by builtinToolProvider before dispatching
	 * delegate_task). When set, the subagent's working directory is locked
	 * to this path (matches `IAgentTurnRequest.worktreePath` semantics).
	 */
	readonly worktreePath?: string;
	/**
	 * v17: per-subagent toolset scope override. When set, the sub-agent's enabled
	 * tools are narrowed to ONLY the listed toolsets (plus bridge tools). Lets a
	 * parent constrain what a delegated sub-agent may do — e.g. an Explore
	 * sub-agent scoped to ['core'] for read-only investigation. Undefined → no
	 * narrowing (current behavior preserved).
	 */
	readonly toolsets?: string[];
	/**
	 * Per-subagent tool-name exclusion — unconditionally hides the listed tools
	 * from the sub-agent regardless of toolset. E.g. an Explore sub-agent must NOT
	 * see `index_repository`: the parent pre-builds the graph itself, and letting
	 * the sub-agent call it makes it stop after "index started" (the "只索引即停"
	 * premature-stop failure). Flows through to `IAgentTurnRequest.excludedTools`.
	 */
	readonly excludedTools?: readonly string[];
	/**
	 * v17: per-subagent model override. When set, the sub-agent runs with this
	 * model selection instead of the session default (matches
	 * `IAgentTurnRequest.modelOverride` semantics).
	 */
	readonly model?: IModelSelection;
	/**
	 * P3（2026-07-26，对齐 MiMo output_schema）：要求子代理最终结论为符合该
	 * JSON Schema 的结构化对象。设置后主执行完成追加一轮禁工具结构化输出
	 * （轻量校验 required 键，1 次重试），validated 对象序列化为 output；
	 * 失败回退自由文本（best effort）。
	 */
	readonly outputSchema?: Record<string, unknown>;
	/**
	 * postStop self-verification hook (MiMo preStop/postStop ReAct). After the main
	 * execution + Completion Gate, if the result is not a clean success-with-acceptance,
	 * a verification prompt is appended and one more bounded turn runs.
	 */
	readonly postStop?: ISubAgentPostStopHook;
		/**
		 * Fork prefix-cache context (MiMo ForkContext). When set, the sub-agent reuses the
		 * parent's frozen system prompt verbatim so the LLM provider's prompt cache hits.
		 */
		readonly forkContext?: IForkContext;
		/**
		 * P2b 隔离档位。默认 'subagent'（层级受控，父 turn abort 级联取消、继承父 worktree）。
		 * 设为 'peer' 表示对等独立 agent：父 turn abort 不级联取消、且不应继承父的敏感
		 * worktree/上下文（由调用方在 delegationTools / swarm 层据此约束最小权限）。
		 */
		readonly isolationLevel?: SubAgentIsolationLevel;
	/**
	 * 内置 Agent 身份 id（如 'code-explorer' / 'researcher' / 'data'）。设置后子代理以
	 * 该内置 Agent 的真实 systemPrompt / tools / model 实例化，而非通用 Explore 折中提示词。
	 * 由 delegationTools（delegate_task type）/ plan_explore / pre-loop 探索解析后写入。
	 */
	readonly agentId?: string;
	/**
	 * 子代理系统提示词覆盖。设置后 `_buildSystemPrompt` 用它替换按 `type` 选取的默认提示词
	 * （仍会拼接全局子代理前后缀）。通常来自内置 Agent 的 `systemPrompt`。
	 */
	readonly systemPrompt?: string;
	/**
	 * 子代理工具白名单（tool 名集合，通常来自内置 Agent 的 `tools`）。设置后子代理可见工具
	 * 收敛为「白名单 ∩ 其余门控结果」，作为对内置 Agent 工具面的忠实还原。
	 * 流向 `IAgentTurnRequest.allowedTools`。
	 */
	readonly allowedTools?: readonly string[];
	}

export interface SubAgentInstance {
	readonly id: string;
	readonly parentAgentId: string;
	readonly type: SubAgentType;
	readonly task: string;
	status: SubAgentStatus;
	readonly budget: IterationBudget;
	readonly createdAt: number;
	readonly timeout: number;
	readonly priority: 'low' | 'medium' | 'high';
	readonly options: SubAgentOptions;
	/** P2b 隔离档位（从 options 解析，默认 'subagent'），供 TaskBoard/UI 与中断逻辑区分两档。 */
	readonly isolationLevel: SubAgentIsolationLevel;
	result?: SubAgentResult;
	/** Per-sub-agent token usage collector (inspired by deer-flow SubagentTokenCollector). */
	readonly tokenCollector: SubagentTokenCollector;
}

export type SubAgentStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface SubAgentResult {
	readonly success: boolean;
	readonly output?: string;
	readonly error?: string;
	readonly completedAt: number;
	/** Execution duration in milliseconds */
	readonly durationMs?: number;
	/** Number of API (LLM) calls made */
	readonly apiCalls?: number;
	/** Token usage (if available from the LLM response) */
	readonly tokensUsed?: { input: number; output: number };
	/** ★ 2026-09-13：累计积分消耗（网关 usage.credit）。 */
	readonly creditUsed?: number;
	/** Detailed per-turn token usage (inspired by deer-flow SubagentTokenCollector). */
	readonly tokenUsage?: SubagentTokenUsage;
	/** Why the sub-agent stopped executing */
	readonly exitReason?: SubAgentExitReason;
	/** Tool call trace — list of tools invoked with their status */
	readonly toolTrace?: ReadonlyArray<SubAgentToolTraceEntry>;
	/** Files modified by this sub-agent (for file change coordination) */
	readonly filesModified?: readonly string[];
	/** Structured Completion-Gate verdict (MiMo TaskGate) — reliable contract for the parent. */
	readonly structured?: ISubAgentStructuredResult;
	}

/** A single tool call trace entry, inspired by Hermes tool_trace. */
export interface SubAgentToolTraceEntry {
	readonly toolName: string;
	readonly status: 'ok' | 'error';
	/** Approximate size of tool arguments in bytes */
	readonly argsSizeBytes?: number;
	/** Approximate size of tool result in bytes */
	readonly resultSizeBytes?: number;
	/** Error message (if status === 'error') */
	readonly error?: string;
}

/** Internal execution result from _executeWithBudget, carrying metadata for SubAgentResult. */
export interface _ExecResult {
	readonly output: string;
	readonly apiCallCount: number;
	readonly budgetExhausted: boolean;
	readonly tokensUsed?: { input: number; output: number };
	/** ★ 2026-09-13：累计积分消耗（网关 usage.credit）。 */
	readonly creditUsed?: number;
	readonly toolTrace: SubAgentToolTraceEntry[];
	/** Files that were modified (written/created) by this sub-agent */
	readonly filesModified: string[];
	/** Whether the sub-agent stalled (no progress for idleTimeoutMs) and was aborted. */
	readonly stalled?: boolean;
	/** Whether the sub-agent was interrupted (manual interrupt or parent AbortSignal — P3). */
	readonly interrupted?: boolean;
}

/** Result of a full sub-agent program (execution + completion gates), settled by the fiber. */
export interface _ProgramResult {
	readonly execResult: _ExecResult;
	readonly structured: ISubAgentStructuredResult;
}

/** Event emitter pre-bound to a specific sub-agent (identity fields filled in). */
export type _BoundEmit = (event: Omit<SubAgentEvent, 'subAgentId' | 'subAgentType' | 'task' | 'parentId' | 'timestamp'> & { type: SubAgentEventType }) => void;

/**
 * Tagged error raised when a sub-agent exceeds its hard timeout cap.
 * A distinct class (not a message substring) so retry policies can match it
 * reliably — timeout is NOT retryable.
 */
export class SubAgentTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`SubAgent timeout after ${timeoutMs}ms`);
		this.name = 'SubAgentTimeoutError';
	}
}

/**
 * Per-attempt execution control passed to _executeWithBudget.
 * The watchdog and stall flag are attempt-local (a retry gets a fresh set);
 * the interrupt signal is fiber-scoped (shared across attempts).
 */
export interface _AttemptControl {
	readonly watchdog: StallWatchdog;
	readonly signal: InterruptSignal;
	readonly isStalled: () => boolean;
}

/**
 * 看门狗计活的内容级 delta 类型（2026-07-26 P1，对齐 MiMo chunkTimeout 语义）：
 * 模型产出的任何内容（文本/思考/工具调用装配/工具结果）都算活动；
 * usage/done/phase_change/memory_injected 等帧外事件不算（keep-alive 只证明
 * 连接活着，不证明模型在产出）。
 */
export const _STALL_CONTENT_DELTA_TYPES: ReadonlySet<string> = new Set([
	'text', 'thinking', 'tool_start', 'tool_args', 'tool_result', 'tool_end',
	// tool_progress（2026-07-26 治本）：工具参数流式生成的进度信号——
	// 子代理 file_write 写大文件（10k+ tokens 参数）期间同样续命，
	// 与主 agent 的 resilience 修复对齐（事故 1785049332701）。
	'tool_progress',
]);

/**
 * 子代理软预算比例（2026-07-28）：wall-clock 超过 timeout×该比例时，主循环
 * 注入一次「立即整理发现并收尾」的 system-reminder（不打断执行）。
 * 目的：让长探索任务在硬超时前主动收敛产出（日志 1785224874547：Explore
 * 子代理 78 轮线性探索撞 600s 硬超时、零产出交接）。0.5 = 半程提醒，
 * 给总结留出足够余量。options.softDeadlineMs 可显式覆盖。
 */
export const SUBAGENT_SOFT_BUDGET_RATIO = 0.5;

/**
 * P1 停滞强制总结的用户消息（2026-07-26，对齐 MiMo max-steps.txt 模板语义）：
 * 禁工具（excludedTools:['*']），仅基于已完成工作输出「已完成/未完成/建议」。
 * 保持通用表述（不含项目/场景特化内容）。
 */
export const _STALL_SUMMARY_PROMPT = [
	'系统检测到执行已停滞（长时间无响应），本轮执行已被终止。',
	'禁止调用任何工具。请仅基于你目前已经完成的工作，立即输出最终总结：',
	// ─── 封死「把调用写成文本」这条退路（与主 agent hardLimitWrapUpReminder 同一缺陷）──
	// 本轮 excludedTools:['*'] → tools=0 → 结构化调用通道已关闭；但 stable 层系统提示词
	// 每轮仍在说「需要工具时 emit a NATIVE function call」。两者夹击下，模型会把调用
	// **写成文本**当作唯一可行解 —— 日志 1788011997897 实证：SubAgent 轮 toolsSent=0 时
	// 模型在讨论 "Hermes's `tool` role replay" 时举例写下伪 XML
	// （`tool_calls:6124c78e` / `tool_call:...` / `tool_sep:...`），并被下游提取器
	// 当成真实调用执行（[file_read, search_files]）。
	// 故此处必须点明**任何语法都不执行**，而不只是"禁止调用工具" ——
	// 否则模型会理解成"不能真调，但可以先把调用记下来"。
	'工具调用通道已完全关闭：原生函数调用不可用，写成文本（XML 标签、JSON、代码块或散文描述）同样不会执行 —— 任何语法都不行。',
	'不要把工具调用以任何形式写下来当作占位或备忘，它不会运行，只会浪费这次总结。',
	'1. 已完成的部分：关键发现、结论、涉及的文件/位置；',
	'2. 未完成的部分：原计划中尚未完成的事项；',
	'3. 建议的下一步：如果由他人接手，应该怎么做。',
	'直接输出总结文本。',
].join('\n');

/**
 * P3 辅助：从模型输出中提取首个 JSON 对象（容忍 markdown 围栏与前后杂文）。
 * 仅接受对象（非数组/标量）；失败返回 undefined。
 */
export function _tryParseJsonObject(text: string): Record<string, unknown> | undefined {
	let s = text.trim();
	// 剥 markdown 代码围栏（```json ... ``` / ``` ... ```）
	const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fence) { s = fence[1].trim(); }
	// 截取首个 { 到末个 }（容忍结论前后多余的说明文字）
	const start = s.indexOf('{');
	const end = s.lastIndexOf('}');
	if (start < 0 || end <= start) { return undefined; }
	try {
		const parsed: unknown = JSON.parse(s.slice(start, end + 1));
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch { /* not JSON */ }
	return undefined;
}

/** P3 辅助：轻量 schema 校验——仅检查 schema.required 声明的键齐全。 */
export function _matchesRequiredKeys(obj: Record<string, unknown>, schema: Record<string, unknown>): boolean {
	const required = (schema as { required?: unknown }).required;
	if (!Array.isArray(required)) { return true; }
	return required.every(k => typeof k === 'string' && k in obj);
}

// ─── SubAgent Event System (inspired by Hermes DelegateEvent) ───────────

/**
 * Fine-grained sub-agent event types, inspired by Hermes-Agent's DelegateEvent enum.
 * These provide detailed observability into sub-agent execution lifecycle.
 *
 * Hermes DelegateEvent has 7 types: TASK_SPAWNED, TASK_PROGRESS, TASK_COMPLETED,
 * TASK_FAILED, TASK_THINKING, TASK_TOOL_STARTED, TASK_TOOL_COMPLETED.
 * We align with that set and add 'interrupted' for our interrupt mechanism.
 */
export enum SubAgentEventType {
	/** Sub-agent has been spawned and is about to start execution */
	Spawned = 'spawned',
	/** Sub-agent is thinking (LLM inference in progress) */
	Thinking = 'thinking',
	/** Sub-agent has started a tool call */
	ToolStarted = 'tool_started',
	/** Sub-agent has completed a tool call */
	ToolCompleted = 'tool_completed',
	/** General progress update (e.g., batch progress summary) */
	Progress = 'progress',
	/** Sub-agent completed successfully */
	Completed = 'completed',
	/** Sub-agent failed with an error */
	Failed = 'failed',
	/** Sub-agent was interrupted by user or parent */
	Interrupted = 'interrupted',
	/** Live LLM text delta (streaming output, for real-time card rendering) */
	TextDelta = 'text_delta',
}

/**
 * Sub-agent event emitted during execution.
 * Inspired by Hermes-Agent's DelegateEvent — provides fine-grained
 * observability into the sub-agent lifecycle.
 *
 * The event sink receives these so the caller (e.g. the webview controller)
 * can translate them into IChatStreamDelta deltas and forward to the WebView.
 */
export interface SubAgentEvent {
	/** Fine-grained event type (inspired by Hermes DelegateEvent) */
	readonly type: SubAgentEventType;
	readonly subAgentId: string;
	readonly subAgentType: SubAgentType;
	readonly task: string;
	readonly parentId: string;
	readonly timestamp: number;

	// ── Type-specific payloads ──

	/** Tool name (for ToolStarted / ToolCompleted) */
	readonly toolName?: string;
	/** Tool call arguments preview (for ToolStarted, truncated) */
	readonly toolArgsPreview?: string;
	/** Tool result preview (for ToolCompleted, truncated) */
	readonly toolResultPreview?: string;
	/** Tool execution status (for ToolCompleted) */
	readonly toolStatus?: 'ok' | 'error';
	/** Thinking text (for Thinking) */
	readonly thinkingText?: string;
	/** Human-readable progress note (for Progress) */
	readonly progressNote?: string;
	/** Progress metrics: tool calls completed so far */
	readonly toolsCompleted?: number;
	/** Final output text (for Completed) */
	readonly output?: string;
	/** Live text delta chunk (for TextDelta, accumulates into streamingOutput on the card) */
	readonly textDelta?: string;
	/** Error message (for Failed / Interrupted) */
	readonly error?: string;
	/** Duration in ms (for Completed / Failed) */
	readonly durationMs?: number;
	/** Token usage (for Completed) */
	readonly tokensUsed?: { input: number; output: number };
	/**
	 * ★ 2026-09-13：**累计**积分消耗（网关 usage.credit）。
	 *
	 * 执行中随 `Progress` 事件实时下发（与 `tokensUsed` 同一时机），完成后由
	 * `Completed` 事件给终值 —— 卡片左下角据此展示。
	 */
	readonly creditUsed?: number;
	/** Exit reason (for Completed / Failed / Interrupted) */
	readonly exitReason?: SubAgentExitReason;
	/** Group id to cluster parallel sub-agents into one card */
	readonly groupId?: string;
}

/** Why a sub-agent stopped executing. */
export type SubAgentExitReason =
	| 'completed'       // Task finished normally
	| 'partial'         // Finished its loop but self-reported partial/blocked (findings salvaged, not a failure)
	| 'max_iterations'  // Hit iteration budget
	| 'timeout'         // Exceeded time limit
	| 'interrupted'     // Interrupted by user or parent
	| 'error';          // Unhandled exception

/** Sink that receives sub-agent events. Errors thrown here are swallowed. */
export type SubAgentEventSink = (event: SubAgentEvent) => void;

// ─── Backward-compatible legacy aliases ─────────────────────────────────

/**
 * @deprecated Use SubAgentEvent instead. Kept for backward compatibility
 * with existing callers that reference SubAgentLifecycleEvent.
 */
export type SubAgentLifecycleEvent = SubAgentEvent;

export interface SubAgentStatusReport {
	readonly id: string;
	readonly type: SubAgentType;
	readonly status: SubAgentStatus;
	readonly task: string;
	readonly createdAt: number;
	readonly budget: string;
}

