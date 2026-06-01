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
}

// ─── SubAgent Lifecycle Events (drives the WebView SubAgentCard) ──────────

/**
 * A lifecycle event emitted while a sub-agent runs. The optional event sink
 * passed to dispatch()/executeSubAgent() receives these so the caller (e.g.
 * the webview controller) can translate them into IChatStreamDelta
 * `sub_agent_*` deltas and forward them to the WebView. This is what makes the
 * SubAgentCard actually light up — previously the sub-agent stream was consumed
 * as a black box (_executeWithBudget) and no lifecycle event ever surfaced.
 */
export interface SubAgentLifecycleEvent {
	/** 'start' when execution begins, 'progress' on intermediate steps, 'end' on done/error/cancel */
	readonly kind: 'start' | 'progress' | 'end';
	readonly subAgentId: string;
	readonly subAgentType: SubAgentType;
	readonly task: string;
	readonly parentId: string;
	readonly status: SubAgentStatus;
	/** Human-readable progress note (for kind === 'progress') */
	readonly progress?: string;
	/** Final output text (for kind === 'end' on success) */
	readonly output?: string;
	/** Error message (for kind === 'end' on failure) */
	readonly error?: string;
	/** Group id to cluster parallel sub-agents into one card (optional) */
	readonly groupId?: string;
}

/** Sink that receives sub-agent lifecycle events. Errors thrown here are swallowed. */
export type SubAgentEventSink = (event: SubAgentLifecycleEvent) => void;

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

		const subAgentId = `subagent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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

		// Emit start event — this is what creates the running card in the UI.
		this._emit(eventSink, {
			kind: 'start',
			subAgentId: subAgent.id,
			subAgentType: subAgent.type,
			task: subAgent.task,
			parentId: subAgent.parentAgentId,
			status: 'running',
			groupId,
		});

		try {
			// Build the request with context injection
			const messages = this._buildMessages(subAgent);

			const request: IAgentTurnRequest = {
				agentId: subAgent.id,
				messages,
				systemPrompt: this._buildSystemPrompt(subAgent),
			};

			// Execute with timeout
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error(`SubAgent timeout after ${subAgent.timeout}ms`)), subAgent.timeout);
			});

			const executionPromise = this._executeWithBudget(
				executeFn,
				request,
				subAgent.budget,
				(progress) => this._emit(eventSink, {
					kind: 'progress',
					subAgentId: subAgent.id,
					subAgentType: subAgent.type,
					task: subAgent.task,
					parentId: subAgent.parentAgentId,
					status: 'running',
					progress,
					groupId,
				}),
			);
			const output = await Promise.race([executionPromise, timeoutPromise]);

			subAgent.result = {
				success: true,
				output,
				completedAt: Date.now(),
			};
			subAgent.status = 'done';

			this._emit(eventSink, {
				kind: 'end',
				subAgentId: subAgent.id,
				subAgentType: subAgent.type,
				task: subAgent.task,
				parentId: subAgent.parentAgentId,
				status: 'done',
				output,
				groupId,
			});

			return subAgent.result;

		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			subAgent.result = {
				success: false,
				error: errMsg,
				completedAt: Date.now(),
			};
			subAgent.status = 'error';

			this._emit(eventSink, {
				kind: 'end',
				subAgentId: subAgent.id,
				subAgentType: subAgent.type,
				task: subAgent.task,
				parentId: subAgent.parentAgentId,
				status: 'error',
				error: errMsg,
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
	 */
	async dispatchParallelExplore(
		parentAgentId: string,
		tasks: string[],
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		context?: string,
		perTaskOptions?: Array<Pick<SubAgentOptions, 'priority' | 'maxIterations' | 'timeout'>>,
		eventSink?: SubAgentEventSink,
	): Promise<SubAgentResult[]> {
		const subAgentIds = tasks.map((task, idx) =>
			this.createSubAgent(parentAgentId, task, {
				type: SubAgentType.Explore,
				context,
				priority: perTaskOptions?.[idx]?.priority ?? 'high',
				maxIterations: perTaskOptions?.[idx]?.maxIterations,
				timeout: perTaskOptions?.[idx]?.timeout,
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

	cancelSubAgent(subAgentId: string): boolean {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) { return false; }
		subAgent.status = 'cancelled';
		return true;
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
	 * Execute the sub-agent with budget tracking.
	 *
	 * Budget consumption is the SOLE responsibility of this method.
	 * The executeFn receives the budget object for read-only checks only
	 * (e.g., budget.hasRemaining()) — it must NOT call budget.consume().
	 * This avoids double-counting when tool_end and tool_result fire
	 * for the same tool invocation.
	 */
	private async _executeWithBudget(
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		request: IAgentTurnRequest,
		budget: IterationBudget,
		onProgress?: (note: string) => void,
	): Promise<string> {
		let output = '';
		let toolCount = 0;

		const stream = executeFn(request, budget);
		for await (const delta of stream) {
			if (delta.type === 'text' && delta.content) {
				output += delta.content;
			}
			if (delta.type === 'done' || delta.type === 'error') {
				break;
			}
			// Surface a progress note when the sub-agent starts a tool, so the
			// SubAgentCard can show live activity rather than a frozen spinner.
			if (delta.type === 'tool_start' && onProgress) {
				const toolName = delta.toolName || delta.displayName || 'tool';
				onProgress(`运行工具: ${toolName}`);
			}
			// Consume budget only on tool_end (one consumption per tool call).
			// tool_result often fires alongside tool_end for the same call,
			// so we deliberately skip it to avoid double-counting.
			if (delta.type === 'tool_end') {
				toolCount++;
				budget.consume(1);
				if (onProgress) {
					onProgress(`已完成 ${toolCount} 个工具调用`);
				}
				if (!budget.hasRemaining()) {
					output += '\n\n[Budget exhausted — sub-agent stopped]';
					break;
				}
			}
		}

		return output;
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
}
