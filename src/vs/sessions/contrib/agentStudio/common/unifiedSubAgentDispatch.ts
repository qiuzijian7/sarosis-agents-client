/*---------------------------------------------------------------------------------------------
 *  Unified SubAgent Dispatch
 *
 *  Unifies the three previous dispatch paths into a single coherent architecture:
 *  1. SubAgentManager (common/) — lightweight budget-aware execution
 *  2. TaskOrchestrationService (browser/) — DAG-based orchestration
 *  3. delegate_task tool — LLM autonomous delegation (was a stub)
 *
 *  Design principles (inspired by OpenCode):
 *  - SubAgentType determines tool permissions (explore=readonly, general=readwrite, scout=external)
 *  - IterationBudget from SubAgentManager is retained for resource control
 *  - TaskOrchestrationService delegates actual execution here
 *  - delegate_task tool routes through TaskOrchestrationService.createPlan()
 *--------------------------------------------------------------------------------------------*/

import { IterationBudget } from './iterationBudget.js';
import type { IAgentTurnRequest, IChatStreamDelta, IChatMessage } from './providers.js';

// ─── SubAgent Types (inspired by OpenCode's agent types) ──────────────────

/**
 * SubAgent type determines the permission profile and tool access.
 * Aligned with OpenCode's explore/general/scout pattern.
 */
export const enum SubAgentType {
	/** Read-only codebase explorer — can grep/glob/read, cannot edit or execute */
	Explore = 'explore',
	/** General-purpose agent — can read and write, but cannot spawn sub-agents */
	General = 'general',
	/** External research agent — can clone repos and fetch web, read-only */
	Scout = 'scout',
}

/**
 * Tool permission profile for each SubAgent type.
 * Inspired by OpenCode's permission system.
 */
export const SUB_AGENT_PERMISSIONS: Record<SubAgentType, {
	readonly canRead: boolean;
	readonly canWrite: boolean;
	readonly canExecute: boolean;
	readonly canWebFetch: boolean;
	readonly canWebSearch: boolean;
	readonly canCloneRepo: boolean;
	readonly canSpawnSubAgent: boolean;
	readonly allowedToolPatterns: readonly string[];
	readonly deniedToolPatterns: readonly string[];
}> = {
	[SubAgentType.Explore]: {
		canRead: true,
		canWrite: false,
		canExecute: false,
		canWebFetch: true,
		canWebSearch: true,
		canCloneRepo: false,
		canSpawnSubAgent: false,
		allowedToolPatterns: ['grep', 'glob', 'list', 'read', 'webfetch', 'websearch', 'repo_overview'],
		deniedToolPatterns: ['*'],
	},
	[SubAgentType.General]: {
		canRead: true,
		canWrite: true,
		canExecute: true,
		canWebFetch: true,
		canWebSearch: true,
		canCloneRepo: false,
		canSpawnSubAgent: true,
		allowedToolPatterns: ['*'],
		deniedToolPatterns: ['todowrite'],
	},
	[SubAgentType.Scout]: {
		canRead: true,
		canWrite: false,
		canExecute: false,
		canWebFetch: true,
		canWebSearch: true,
		canCloneRepo: true,
		canSpawnSubAgent: false,
		allowedToolPatterns: ['grep', 'glob', 'list', 'read', 'webfetch', 'websearch', 'repo_overview', 'repo_clone'],
		deniedToolPatterns: ['*'],
	},
};

// ─── SubAgent Instance Types ─────────────────────────────────────────────

export interface SubAgentOptions {
	/** SubAgent type — determines tool permissions */
	readonly type?: SubAgentType;
	/** Max iterations for this sub-agent (default: derived from parent budget) */
	readonly maxIterations?: number;
	/** Timeout in ms (default: 300000 = 5min) */
	readonly timeout?: number;
	/** Priority for scheduling (low/medium/high) */
	readonly priority?: 'low' | 'medium' | 'high';
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
	result?: SubAgentResult;
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
	/** Why the sub-agent stopped executing */
	readonly exitReason?: SubAgentExitReason;
	/** Tool call trace — list of tools invoked with their status */
	readonly toolTrace?: ReadonlyArray<SubAgentToolTraceEntry>;
	/** Files modified by this sub-agent (for file change coordination) */
	readonly filesModified?: readonly string[];
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
interface _ExecResult {
	readonly output: string;
	readonly apiCallCount: number;
	readonly budgetExhausted: boolean;
	readonly tokensUsed?: { input: number; output: number };
	readonly toolTrace: SubAgentToolTraceEntry[];
	/** Files that were modified (written/created) by this sub-agent */
	readonly filesModified: string[];
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
export const enum SubAgentEventType {
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
	/** Error message (for Failed / Interrupted) */
	readonly error?: string;
	/** Duration in ms (for Completed / Failed) */
	readonly durationMs?: number;
	/** Token usage (for Completed) */
	readonly tokensUsed?: { input: number; output: number };
	/** Exit reason (for Completed / Failed / Interrupted) */
	readonly exitReason?: SubAgentExitReason;
	/** Group id to cluster parallel sub-agents into one card */
	readonly groupId?: string;
}

/** Why a sub-agent stopped executing. */
export type SubAgentExitReason =
	| 'completed'       // Task finished normally
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

// ─── Unified SubAgent Dispatch ────────────────────────────────────────────

/**
 * UnifiedSubAgentDispatch — the single entry point for all sub-agent operations.
 *
 * Replaces the three previous paths:
 * - SubAgentManager → now a thin wrapper delegating here
 * - TaskOrchestrationService._executeTask() → delegates execution here
 * - delegate_task tool → routes through TaskOrchestrationService which uses this
 *
 * Key improvements over previous SubAgentManager:
 * 1. SubAgentType-based permission profiles (like OpenCode)
 * 2. Context injection (repo_overview, upstream results)
 * 3. Background execution support
 * 4. Permission-aware tool filtering
 */
export class UnifiedSubAgentDispatch {
	private readonly _activeSubAgents = new Map<string, SubAgentInstance>();
	private readonly _parentBudget: IterationBudget;
	private readonly _maxConcurrent: number;
	private readonly _maxSpawnDepth: number;
	/**
	 * Set of sub-agent IDs that have been interrupted.
	 * Checked in _executeWithBudget loop to break out of streaming.
	 * Inspired by Hermes-Agent's interrupt signal propagation.
	 */
	private readonly _interruptedSubAgents = new Set<string>();

	// ─── Global registry (inspired by Hermes _active_subagents) ───────
	/**
	 * Static registry of all active UnifiedSubAgentDispatch instances,
	 * keyed by workspace/session ID. This enables cross-dispatch queries
	 * and UI integration (TaskBoard can enumerate all running sub-agents).
	 *
	 * Inspired by Hermes-Agent's module-level `_active_subagents` dict
	 * which supports TUI queries and interrupt propagation.
	 */
	private static readonly _globalRegistry = new Map<string, UnifiedSubAgentDispatch>();

	/** Register this dispatch instance in the global registry. */
	registerGlobal(sessionId: string): void {
		UnifiedSubAgentDispatch._globalRegistry.set(sessionId, this);
	}

	/** Unregister this dispatch instance from the global registry. */
	unregisterGlobal(sessionId: string): void {
		UnifiedSubAgentDispatch._globalRegistry.delete(sessionId);
	}

	/**
	 * Look up a sub-agent across all dispatch instances.
	 * Useful for UI (TaskBoard) or interrupt propagation across sessions.
	 */
	static findSubAgentGlobal(subAgentId: string): SubAgentInstance | undefined {
		for (const dispatch of UnifiedSubAgentDispatch._globalRegistry.values()) {
			const agent = dispatch._activeSubAgents.get(subAgentId);
			if (agent) { return agent; }
		}
		return undefined;
	}

	/**
	 * Interrupt a sub-agent by ID across all dispatch instances.
	 * Inspired by Hermes interrupt_subagent() which uses module-level lookup.
	 */
	static interruptSubAgentGlobal(subAgentId: string): boolean {
		for (const dispatch of UnifiedSubAgentDispatch._globalRegistry.values()) {
			if (dispatch._activeSubAgents.has(subAgentId)) {
				return dispatch.interruptSubAgent(subAgentId);
			}
		}
		return false;
	}

	/**
	 * Get all running sub-agents across all sessions.
	 * Useful for TaskBoard to show global sub-agent status.
	 */
	static getAllRunningGlobal(): SubAgentStatusReport[] {
		const results: SubAgentStatusReport[] = [];
		for (const dispatch of UnifiedSubAgentDispatch._globalRegistry.values()) {
			results.push(...dispatch.getAllSubAgents());
		}
		return results;
	}

	constructor(parentBudget?: IterationBudget, maxConcurrent: number = 3, maxSpawnDepth: number = 2) {
		this._parentBudget = parentBudget || new IterationBudget(90);
		this._maxConcurrent = maxConcurrent;
		this._maxSpawnDepth = maxSpawnDepth;
	}

	/** 获取当前配置（供 delegate_task 动态描述使用） */
	getConfig() {
		return {
			maxConcurrent: this._maxConcurrent,
			maxSpawnDepth: this._maxSpawnDepth,
		};
	}

	/**
	 * 计算指定 agent 的深度（从 root 到该 agent 的层数，root = 0）
	 */
	private _getAgentDepth(agentId: string): number {
		let depth = 0;
		let currentId: string | undefined = agentId;

		while (currentId) {
			const agent = this._activeSubAgents.get(currentId);
			if (!agent) {
				// Reached root agent (not in _activeSubAgents)
				break;
			}
			depth++;
			currentId = agent.parentAgentId;
		}

		return depth;
	}

	/**
	 * Create a sub-agent instance.
	 * Does NOT start execution — call executeSubAgent() separately.
	 */
	createSubAgent(
		parentAgentId: string,
		task: string,
		options?: SubAgentOptions,
	): string {
		// Check spawn depth limit
		const parentDepth = this._getAgentDepth(parentAgentId);
		if (parentDepth >= this._maxSpawnDepth) {
			throw new Error(`Cannot spawn sub-agent: maximum spawn depth (${this._maxSpawnDepth}) reached. Parent agent depth: ${parentDepth}`);
		}

		const subAgentId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
		const budget = this._parentBudget.createChildBudget(options?.maxIterations);
		const type = options?.type ?? SubAgentType.General;

		const subAgent: SubAgentInstance = {
			id: subAgentId,
			parentAgentId,
			type,
			task,
			status: 'pending',
			budget,
			createdAt: Date.now(),
			timeout: options?.timeout ?? 300_000,
			priority: options?.priority ?? 'medium',
			options: options ?? {},
			result: undefined,
		};

		this._activeSubAgents.set(subAgentId, subAgent);
		return subAgentId;
	}

	/**
	 * Execute a previously created sub-agent.
	 * The executeFn is provided by the caller (typically AgentOSService).
	 *
	 * @param eventSink Optional sink receiving start/progress/end lifecycle events.
	 *                  This is the channel that drives the WebView SubAgentCard.
	 * @param groupId   Optional group id to cluster parallel sub-agents into one card.
	 */
	async executeSubAgent(
		subAgentId: string,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		eventSink?: SubAgentEventSink,
		groupId?: string,
	): Promise<SubAgentResult> {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) {
			throw new Error(`SubAgent ${subAgentId} not found`);
		}

		if (subAgent.status !== 'pending') {
			throw new Error(`SubAgent ${subAgentId} is not in pending state (current: ${subAgent.status})`);
		}

		subAgent.status = 'running';
		const startedAt = Date.now();

		// Emit spawned event — sub-agent has been created and is about to run.
		this._emit(eventSink, {
			type: SubAgentEventType.Spawned,
			subAgentId: subAgent.id,
			subAgentType: subAgent.type,
			task: subAgent.task,
			parentId: subAgent.parentAgentId,
			timestamp: startedAt,
			groupId,
		});

		try {
			// Build the request with context injection
			const messages = this._buildMessages(subAgent);

			const request: IAgentTurnRequest = {
				agentId: subAgent.id,
				messages,
				systemPrompt: this._buildSystemPrompt(subAgent),
				// v17: propagate the parent agent's worktree so the subagent's
				// tools (file_read, file_write, terminal_cmd, etc.) all run
				// inside the same worktree the parent was operating in.
				worktreePath: subAgent.options.worktreePath,
			};

			// Execute with timeout
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error(`SubAgent timeout after ${subAgent.timeout}ms`)), subAgent.timeout);
			});

			const executionPromise = this._executeWithBudget(
				executeFn,
				request,
				subAgent.budget,
				(event) => this._emit(eventSink, {
					...event,
					subAgentId: subAgent.id,
					subAgentType: subAgent.type,
					task: subAgent.task,
					parentId: subAgent.parentAgentId,
					timestamp: Date.now(),
					groupId,
				}),
			);
			const execResult = await Promise.race([executionPromise, timeoutPromise]);

			// Determine exit reason
			const exitReason: SubAgentExitReason = execResult.budgetExhausted
				? 'max_iterations'
				: 'completed';

			subAgent.result = {
				success: true,
				output: execResult.output,
				completedAt: Date.now(),
				durationMs: Date.now() - startedAt,
				apiCalls: execResult.apiCallCount,
				tokensUsed: execResult.tokensUsed,
				exitReason,
				toolTrace: execResult.toolTrace,
				filesModified: execResult.filesModified.length > 0 ? execResult.filesModified : undefined,
			};
			subAgent.status = 'done';

			// ── File change coordination (inspired by Hermes file_state) ──
			// If the sub-agent modified files, append a warning to the output
			// so the parent agent knows to re-read those files.
			if (execResult.filesModified.length > 0) {
				const fileList = execResult.filesModified.join(', ');
				subAgent.result = {
					...subAgent.result,
					output: (subAgent.result.output ?? '') +
						`\n\n[NOTE: subagent modified files — re-read before editing: ${fileList}]`,
				};
			}

			this._emit(eventSink, {
				type: SubAgentEventType.Completed,
				subAgentId: subAgent.id,
				subAgentType: subAgent.type,
				task: subAgent.task,
				parentId: subAgent.parentAgentId,
				timestamp: Date.now(),
				output: execResult.output,
				durationMs: Date.now() - startedAt,
				tokensUsed: execResult.tokensUsed,
				toolsCompleted: execResult.apiCallCount,
				exitReason,
				groupId,
			});

			return subAgent.result;

		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			const isTimeout = errMsg.includes('timeout');
			const exitReason: SubAgentExitReason = isTimeout ? 'timeout' : 'error';

			subAgent.result = {
				success: false,
				error: errMsg,
				completedAt: Date.now(),
				durationMs: Date.now() - startedAt,
				exitReason,
			};
			subAgent.status = 'error';

			this._emit(eventSink, {
				type: SubAgentEventType.Failed,
				subAgentId: subAgent.id,
				subAgentType: subAgent.type,
				task: subAgent.task,
				parentId: subAgent.parentAgentId,
				timestamp: Date.now(),
				error: errMsg,
				durationMs: Date.now() - startedAt,
				exitReason,
				groupId,
			});

			return subAgent.result;
		}
	}

	/**
	 * Execute multiple sub-agents in parallel (respecting maxConcurrent).
	 * Inspired by OpenCode's parallel explore pattern.
	 *
	 * Uses Promise.allSettled so that one sub-agent failure does NOT
	 * abort the entire batch. Failed sub-agents produce a SubAgentResult
	 * with success=false, and the caller can inspect each result individually.
	 */
	async executeMultipleSubAgents(
		subAgentIds: string[],
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		eventSink?: SubAgentEventSink,
		groupId?: string,
	): Promise<Map<string, SubAgentResult>> {
		const results = new Map<string, SubAgentResult>();

		// Execute in batches respecting maxConcurrent
		for (let i = 0; i < subAgentIds.length; i += this._maxConcurrent) {
			const batch = subAgentIds.slice(i, i + this._maxConcurrent);
			const settled = await Promise.allSettled(
				batch.map(async (subAgentId) => {
					const result = await this.executeSubAgent(subAgentId, executeFn, eventSink, groupId);
					return { subAgentId, result } as const;
				})
			);

			for (const outcome of settled) {
				if (outcome.status === 'fulfilled') {
					results.set(outcome.value.subAgentId, outcome.value.result);
				} else {
					// Promise rejected (unexpected — executeSubAgent itself
					// catches errors and returns a failed SubAgentResult, so
					// this branch is a safety net for truly exceptional cases).
					const failedId = batch[settled.indexOf(outcome)];
					results.set(failedId, {
						success: false,
						error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
						completedAt: Date.now(),
					});
				}
			}
		}

		return results;
	}

	/**
	 * Convenience: create and execute in one call.
	 */
	async dispatch(
		parentAgentId: string,
		task: string,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		options?: SubAgentOptions,
		eventSink?: SubAgentEventSink,
	): Promise<SubAgentResult> {
		const subAgentId = this.createSubAgent(parentAgentId, task, options);
		return this.executeSubAgent(subAgentId, executeFn, eventSink);
	}

	/**
	 * Convenience: dispatch multiple explore agents in parallel.
	 * Inspired by OpenCode's Phase 1: parallel explore.
	 *
	 * @param perTaskOptions Optional per-task options override. If not provided,
	 *                       defaults to { type: Explore, priority: high, context }.
	 *                       v17: also accepts `worktreePath` for per-task worktree.
	 */
	async dispatchParallelExplore(
		parentAgentId: string,
		tasks: string[],
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		context?: string,
		perTaskOptions?: Array<Pick<SubAgentOptions, 'priority' | 'maxIterations' | 'timeout' | 'worktreePath'>>,
		eventSink?: SubAgentEventSink,
	): Promise<SubAgentResult[]> {
		const subAgentIds = tasks.map((task, idx) =>
			this.createSubAgent(parentAgentId, task, {
				type: SubAgentType.Explore,
				context,
				priority: perTaskOptions?.[idx]?.priority ?? 'high',
				maxIterations: perTaskOptions?.[idx]?.maxIterations,
				timeout: perTaskOptions?.[idx]?.timeout,
				// v17: propagate worktree to each parallel explore subagent.
				worktreePath: perTaskOptions?.[idx]?.worktreePath,
			})
		);

		// Cluster all parallel explore agents under one group so the UI can render
		// them as a single grouped SubAgentCard.
		const groupId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const resultMap = await this.executeMultipleSubAgents(subAgentIds, executeFn, eventSink, groupId);
		return subAgentIds.map(id => resultMap.get(id)!).filter(Boolean);
	}

	// ─── Status & Management ─────────────────────────────────────────────

	getSubAgentStatus(subAgentId: string): SubAgentStatusReport | undefined {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) { return undefined; }
		return {
			id: subAgent.id,
			type: subAgent.type,
			status: subAgent.status,
			task: subAgent.task,
			createdAt: subAgent.createdAt,
			budget: subAgent.budget.getSummary(),
		};
	}

	getAllSubAgents(): SubAgentStatusReport[] {
		return Array.from(this._activeSubAgents.values()).map(sa => ({
			id: sa.id,
			type: sa.type,
			status: sa.status,
			task: sa.task,
			createdAt: sa.createdAt,
			budget: sa.budget.getSummary(),
		}));
	}

	/**
	 * Get the permission profile for a sub-agent type.
	 */
	getPermissions(type: SubAgentType) {
		return SUB_AGENT_PERMISSIONS[type];
	}

	/**
	 * Check if a tool is allowed for a given sub-agent.
	 */
	isToolAllowed(type: SubAgentType, toolName: string): boolean {
		const perms = SUB_AGENT_PERMISSIONS[type];
		// If there's an explicit allow list that's not '*', check against it
		if (perms.allowedToolPatterns.length > 0 && !perms.allowedToolPatterns.includes('*')) {
			const matchesAllow = perms.allowedToolPatterns.some(pattern => {
				if (pattern === toolName) { return true; }
				if (pattern.endsWith('*') && toolName.startsWith(pattern.slice(0, -1))) { return true; }
				return false;
			});
			if (!matchesAllow) { return false; }
		}
		// Check deny list
		if (perms.deniedToolPatterns.includes(toolName) || perms.deniedToolPatterns.includes('*')) {
			// Deny '*' means deny all except explicitly allowed
			if (perms.deniedToolPatterns.includes('*') && perms.allowedToolPatterns.includes(toolName)) {
				return true; // Explicitly allowed overrides deny-all
			}
			return false;
		}
		return true;
	}

	/**
	 * Interrupt a running sub-agent.
	 * Inspired by Hermes-Agent's interrupt signal propagation:
	 * 1. Marks the sub-agent as interrupted so _executeWithBudget breaks out
	 * 2. Recursively interrupts any child sub-agents spawned by this one
	 * 3. Sets status to 'cancelled'
	 *
	 * @returns true if the sub-agent was found and interrupted, false otherwise
	 */
	interruptSubAgent(subAgentId: string): boolean {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) { return false; }

		// Mark for interrupt check in _executeWithBudget loop
		this._interruptedSubAgents.add(subAgentId);
		subAgent.status = 'cancelled';

		// Recursively interrupt all child sub-agents (inspired by Hermes)
		for (const [id, agent] of this._activeSubAgents.entries()) {
			if (agent.parentAgentId === subAgentId && agent.status === 'running') {
				this.interruptSubAgent(id);
			}
		}

		return true;
	}

	/**
	 * Cancel a sub-agent (legacy — now delegates to interruptSubAgent).
	 * @deprecated Use interruptSubAgent instead for recursive propagation.
	 */
	cancelSubAgent(subAgentId: string): boolean {
		return this.interruptSubAgent(subAgentId);
	}

	/**
	 * Interrupt ALL running sub-agents.
	 * Useful when the parent agent itself is interrupted and needs to
	 * clean up all child agents.
	 */
	interruptAll(): void {
		for (const [id, agent] of this._activeSubAgents.entries()) {
			if (agent.status === 'running') {
				this.interruptSubAgent(id);
			}
		}
	}

	cleanup(): void {
		for (const [id, subAgent] of this._activeSubAgents.entries()) {
			if (subAgent.status === 'done' || subAgent.status === 'error' || subAgent.status === 'cancelled') {
				this._activeSubAgents.delete(id);
			}
		}
	}

	get parentBudget(): IterationBudget { return this._parentBudget; }

	// ─── Private Helpers ─────────────────────────────────────────────────

	/**
	 * Build messages array for the sub-agent.
	 * Injects context (e.g., repo_overview) if provided.
	 */
	private _buildMessages(subAgent: SubAgentInstance): IChatMessage[] {
		const messages: IChatMessage[] = [];

		// Inject context as a system-like user message prefix
		if (subAgent.options.context) {
			messages.push({
				role: 'user',
				content: `## Codebase Context\n\n${subAgent.options.context}\n\n---\n\n## Task\n\n${subAgent.task}`,
			});
		} else {
			messages.push({
				role: 'user',
				content: subAgent.task,
			});
		}

		return messages;
	}

	/**
	 * Build system prompt based on SubAgentType.
	 * Inspired by OpenCode's per-agent prompt files.
	 */
	private _buildSystemPrompt(subAgent: SubAgentInstance): string {
		const typePrompts: Record<SubAgentType, string> = {
			[SubAgentType.Explore]: `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path
- Use WebFetch for documentation
- Use WebSearch for searching the web
- DO NOT edit any files — you are in read-only mode
- Be thorough: check multiple directories and file patterns
- Report findings in a structured format`,

			[SubAgentType.General]: `You are a general-purpose agent. You can read, write, and execute commands.
- Complete the task described by the user
- You CAN spawn sub-agents using delegate_task when the task can be decomposed into independent parallel subtasks
- Report your results clearly
- If you encounter errors, explain what went wrong

## When to use delegate_task:
- The task can be decomposed into 2+ independent subtasks
- You need to run multiple independent investigations simultaneously
- The subtask is complex enough to benefit from a dedicated context

## When NOT to use delegate_task:
- The task is simple and can be completed in one turn
- You need to maintain ongoing context/memory across steps
- You are already at maximum spawn depth (check parent agent constraints)`,

			[SubAgentType.Scout]: `You are a research agent for external libraries, dependency source, and documentation.
- Use repo_clone first when the task involves a GitHub repository
- After cloning, use Glob, Grep, Read to inspect the cloned repository
- Use WebFetch for official documentation pages
- Use WebSearch to find relevant documentation
- DO NOT edit any files — you are in read-only mode
- Focus on understanding architecture, patterns, and key abstractions`,
		};

		return typePrompts[subAgent.type] || typePrompts[SubAgentType.General];
	}

	/**
	 * Execute the sub-agent with budget tracking and fine-grained event emission.
	 *
	 * Budget consumption is the SOLE responsibility of this method.
	 * The executeFn receives the budget object for read-only checks only
	 * (e.g., budget.hasRemaining()) — it must NOT call budget.consume().
	 * This avoids double-counting when tool_end and tool_result fire
	 * for the same tool invocation.
	 *
	 * Inspired by Hermes-Agent's _run_single_child which tracks:
	 * - api_calls count
	 * - tool_trace (tool name, args/result size, status)
	 * - token usage (input/output)
	 */
	private async _executeWithBudget(
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		request: IAgentTurnRequest,
		budget: IterationBudget,
		emitEvent?: (partial: Omit<SubAgentEvent, 'subAgentId' | 'subAgentType' | 'task' | 'parentId' | 'timestamp'> & { type: SubAgentEventType }) => void,
	): Promise<_ExecResult> {
		let output = '';
		let apiCallCount = 0;
		let budgetExhausted = false;
		let tokensUsed: { input: number; output: number } | undefined;
		const toolTrace: SubAgentToolTraceEntry[] = [];
		const filesModified: string[] = [];
		let currentToolName: string | undefined;
		let currentToolArgsSize = 0;
		let currentToolArgs: Record<string, unknown> | undefined;
		// Raw JSON string accumulated from streamed `tool_args` deltas. The main
		// execution path does NOT populate `tool_start.metadata`, so the only
		// reliable source of tool arguments is the `tool_args` content stream.
		// We concatenate every chunk (handles both single-shot and streamed
		// argument deltas) and JSON.parse it at `tool_end`.
		let currentToolArgsRaw = '';
		// Size and (on error) text of the most recent tool_result, used to fill
		// SubAgentToolTraceEntry.resultSizeBytes / error at the following tool_end.
		let currentToolResultSize = 0;
		let currentToolResultText: string | undefined;

		const stream = executeFn(request, budget);
		for await (const delta of stream) {
			// ── Text accumulation ──
			if (delta.type === 'text' && delta.content) {
				output += delta.content;
			}

			// ── Thinking (inspired by Hermes TASK_THINKING) ──
			if (delta.type === 'thinking' && emitEvent) {
				const text = typeof delta.content === 'string' ? delta.content : '';
				if (text) {
					emitEvent({
						type: SubAgentEventType.Thinking,
						thinkingText: text.slice(0, 200),
					});
				}
			}

			// ── Tool started (inspired by Hermes TASK_TOOL_STARTED) ──
			if (delta.type === 'tool_start') {
				currentToolName = delta.toolName || 'unknown';
				currentToolArgsSize = 0;
				currentToolArgs = undefined;
				currentToolArgsRaw = '';
				currentToolResultSize = 0;
				currentToolResultText = undefined;
				// Some providers populate metadata with parsed args up-front; if
				// present we seed from it, but the authoritative source remains the
				// `tool_args` stream which is concatenated below.
				if (delta.metadata) {
					try {
						currentToolArgsSize = JSON.stringify(delta.metadata).length;
						currentToolArgs = delta.metadata;
					} catch { /* ignore */ }
				}
				if (emitEvent) {
					emitEvent({
						type: SubAgentEventType.ToolStarted,
						toolName: currentToolName,
						toolArgsPreview: currentToolName,
						toolsCompleted: apiCallCount,
					});
				}
			}

			// ── Tool arguments streaming ──
			if (delta.type === 'tool_args' && delta.content) {
				currentToolArgsSize += delta.content.length;
				// Accumulate the raw argument JSON so it can be parsed at tool_end.
				// This is the primary source of args for file-change detection,
				// since tool_start.metadata is empty on the main execution path.
				currentToolArgsRaw += delta.content;
			}

			// ── Tool result (captured for trace size / error text) ──
			if (delta.type === 'tool_result' && typeof delta.content === 'string') {
				currentToolResultSize = delta.content.length;
				currentToolResultText = delta.content;
			}

			// ── Tool completed (inspired by Hermes TASK_TOOL_COMPLETED) ──
			if (delta.type === 'tool_end') {
				apiCallCount++;
				const toolStatus: 'ok' | 'error' = delta.success === false ? 'error' : 'ok';

				// Resolve tool arguments: prefer the accumulated `tool_args` JSON
				// stream (authoritative on the main path); fall back to metadata
				// seeded at tool_start. Without this, file-change detection never
				// fires because tool_start carries no parameters.
				if (!currentToolArgs && currentToolArgsRaw) {
					try {
						const parsed = JSON.parse(currentToolArgsRaw);
						if (parsed && typeof parsed === 'object') {
							currentToolArgs = parsed as Record<string, unknown>;
						}
					} catch { /* incomplete or non-JSON args — ignore */ }
				}
				if (currentToolArgsRaw && !currentToolArgsSize) {
					currentToolArgsSize = currentToolArgsRaw.length;
				}

				const traceEntry: SubAgentToolTraceEntry = {
					toolName: currentToolName || 'unknown',
					status: toolStatus,
					argsSizeBytes: currentToolArgsSize || undefined,
					resultSizeBytes: currentToolResultSize || undefined,
					error: toolStatus === 'error' ? (currentToolResultText?.slice(0, 500) || undefined) : undefined,
				};
				toolTrace.push(traceEntry);

				// ── File change coordination (inspired by Hermes file_state) ──
				// Track files modified by file-writing tools so the parent agent
				// can be warned that its cached file reads may be stale.
				if (currentToolName && currentToolArgs && toolStatus === 'ok') {
					const filePath = this._extractModifiedFile(currentToolName, currentToolArgs);
					if (filePath && !filesModified.includes(filePath)) {
						filesModified.push(filePath);
					}
				}

				if (emitEvent) {
					emitEvent({
						type: SubAgentEventType.ToolCompleted,
						toolName: currentToolName || 'unknown',
						toolStatus,
						toolsCompleted: apiCallCount,
					});
				}

				budget.consume(1);
				if (!budget.hasRemaining()) {
					output += '\n\n[Budget exhausted — sub-agent stopped]';
					budgetExhausted = true;
					break;
				}
			}

			// ── Usage/token tracking ──
			if (delta.type === 'usage' && delta.usage) {
				// Accumulate across multiple usage events (one per LLM turn) rather
				// than overwriting, so multi-iteration sub-agents report total cost.
				const inTok = delta.usage.inputTokens ?? 0;
				const outTok = delta.usage.outputTokens ?? 0;
				if (!tokensUsed) {
					tokensUsed = { input: inTok, output: outTok };
				} else {
					tokensUsed.input += inTok;
					tokensUsed.output += outTok;
				}
			}

			// ── Terminal events ──
			if (delta.type === 'done' || delta.type === 'error') {
				break;
			}

			// ── Check for interrupt signal ──
			if (this._interruptedSubAgents.has(request.agentId)) {
				output += '\n\n[Interrupted by user or parent agent]';
				if (emitEvent) {
					emitEvent({
						type: SubAgentEventType.Interrupted,
						exitReason: 'interrupted',
					});
				}
				break;
			}
		}

		return { output, apiCallCount, budgetExhausted, tokensUsed, toolTrace, filesModified };
	}

	/** Safely deliver a lifecycle event to the sink, swallowing any sink errors. */
	private _emit(sink: SubAgentEventSink | undefined, event: SubAgentLifecycleEvent): void {
		if (!sink) { return; }
		try {
			sink(event);
		} catch {
			// Event delivery must never break sub-agent execution.
		}
	}

	/**
	 * Extract a file path from a tool call if the tool is a file-modifying tool.
	 * Inspired by Hermes-Agent's file_state coordination which tracks which files
	 * sub-agents read/write to warn the parent about stale cache.
	 */
	private _extractModifiedFile(toolName: string, args: Record<string, unknown>): string | undefined {
		// File-writing tools and their argument key containing the file path
		const FILE_WRITE_TOOLS: Record<string, string> = {
			'write_to_file': 'path',
			'apply_diff': 'path',
			'create_file': 'path',
			'edit_file': 'path',
			'write': 'path',
			'edit': 'path',
			'rename_file': 'path',
			'delete_file': 'path',
			'file_write': 'path',
			'file_edit': 'path',
		};

		const pathKey = FILE_WRITE_TOOLS[toolName];
		if (!pathKey) { return undefined; }

		const filePath = args[pathKey];
		if (typeof filePath === 'string' && filePath.length > 0) {
			return filePath;
		}

		return undefined;
	}
}
