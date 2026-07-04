/*---------------------------------------------------------------------------------------------
 *  Context Manager
 *  Inspired by Paperclip's multi-level context management system
 *
 *  Features:
 *  1. Multi-level context (Workspace → Project → Task → Agent → Session)
 *  2. Context snapshot for persistence and recovery
 *  3. Context passing via environment variables and prompt templates
 *  4. Continuation summary for cross-session state
 *  5. Backward compatible with old ContextManager API
 *--------------------------------------------------------------------------------------------*/

import { IChatMessage } from '../common/providers.js';
import { IModelProvider } from '../common/providers.js';
import type {
	IWorkspaceContext,
	IProjectContext,
	ITaskContext,
	IAgentContext,
	ISessionContext,
	IContextSnapshot,
	IExecutionContext,
	IContextPrompts,
	IContextManager,
	IContextManagerConfig,
	IContextStorage,
	ISharedContext,
	IOrchestrationContext,
	IContextHandoff,
	IContextVersion,
	IContextEvent,
	IContextEventHandler,
	IContextCompressionConfig,
	IContextCompressionResult,
	PreCompactInjectFn,
	IContextTemplate,
	IIsolatedContext,
	IContextIsolationConfig,
	IContextRetentionPolicy,
	IContextPersistenceInfo,
	IContextPersistenceFilter,
	IContextUsageAnalysis,
	IContextInsights,
	IContextDiff,
	IContextDiffEntry,
	WorkspaceConnection,
} from './contextTypes.js';
import {
	ContextVersionNotFoundError,
	ContextSnapshotNotFoundError,
	ContextAnalysisNotFoundError,
	ContextTemplateNotFoundError,
	ContextValidationError,
} from './contextTypes.js';
import type { Agent, ChatMessage, PlanTask, PlanTaskStatus } from './types.js';
import type { IAgentStudioService } from '../../../common/agentStudioService.js';
import type { ITaskOrchestrationService } from '../../../common/agentStudioService.js';

// ─── Logger Interface (避免 common 层依赖 platform) ─────────────────────────────

/** 最小日志接口，供 ContextManager 输出诊断日志到 VS Code Output 面板 */
export interface IContextLogger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string, error?: unknown): void;
	debug(msg: string): void;
}

// ─── Default Configuration ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: IContextManagerConfig = {
	compressionThreshold: 0.40, // 40% threshold — 避免 25% 过低导致频繁压缩（压缩后几条消息又超阈值）
	maxRecentMessages: 20, // Keep 20 recent messages
	minMessagesToCompress: 10, // Minimum 10 messages to compress
	maxSnapshotHistory: 10, // Keep 10 snapshots
	enableContinuationSummary: true,
};

// ─── Context Manager Implementation ─────────────────────────────────────────────

/**
 * Enhanced Context Manager inspired by Paperclip
 *
 * @deprecated The old API (compressIfNeeded, getContextStats) is kept for backward compatibility.
 * Use the new API (buildExecutionContext, saveSnapshot, etc.) for new code.
 */
export class ContextManager implements IContextManager {
	// === Configuration ===
	private readonly _config: IContextManagerConfig;

	// === Old API State (backward compatible) ===
	private readonly _compressionThreshold: number;
	private readonly _maxRecentMessages: number;
	private readonly _minMessagesToCompress: number;
	private readonly _modelProvider: IModelProvider;
	private readonly _modelId: string;

	// === New API State ===
	private readonly _snapshots: Map<string, IContextSnapshot> = new Map();
	private readonly _continuationSummaries: Map<string, string> = new Map();

	// === Dependencies (to be injected) ===
	private _agentStudioService?: IAgentStudioService;
	private _taskOrchestrationService?: ITaskOrchestrationService;
	private _storage?: IContextStorage; // For persisting snapshots and summaries

	// === Orchestration State (new for multi-agent) ===
	private readonly _sharedContexts: Map<string, ISharedContext> = new Map();
	private readonly _handoffs: Map<string, IContextHandoff> = new Map();
	private readonly _orchestrationContexts: Map<string, IOrchestrationContext> = new Map();

	// === Context Versioning State (P1 improvements) ===
	private readonly _contextVersions: Map<string, IContextVersion[]> = new Map();

	// === Context Events State (P1 improvements) ===
	private readonly _eventHandlers: Map<string, Set<IContextEventHandler>> = new Map();

	// === Context Templates State (P2 improvements) ===
	private readonly _contextTemplates: Map<string, IContextTemplate> = new Map();

	// === Context Isolation State (P2 improvements) ===
	private readonly _isolatedContexts: Map<string, IIsolatedContext> = new Map();

	// === Context Persistence State (P2 improvements) ===
	private readonly _persistedContexts: Map<string, IContextPersistenceInfo> = new Map();

	// === Context Analysis State (P2 improvements) ===
	private readonly _contextAnalyses: Map<string, IContextUsageAnalysis> = new Map();
	private readonly _contextInsights: Map<string, IContextInsights> = new Map();

	// === Anti-thrashing State (P2: 防止反复低效压缩抖动) ===
	/** 连续低效压缩计数。达到 MAX_INEFFECTIVE_COMPRESSIONS 后 compressContext 直接 noop。 */
	private _ineffectiveCompressionCount = 0;
	/** 上次压缩时的真实 prompt token 数。用于检测 token 显著增长后重置 anti-thrashing。 */
	private _lastCompressRealTokens: number | null = null;
	/** 上次压缩的时间戳。用于冷却期判定，避免短时间内反复压缩。 */
	private _lastCompressionTime: number = 0;

	// === Logger (可选，由 executionProvider 注入) ===
	private _logger: IContextLogger | undefined;

	constructor(
		modelProvider: IModelProvider,
		modelId: string,
		config?: Partial<IContextManagerConfig>,
	) {
		this._modelProvider = modelProvider;
		this._modelId = modelId;
		this._config = { ...DEFAULT_CONFIG, ...config };

		// Old API state
		this._compressionThreshold = this._config.compressionThreshold;
		this._maxRecentMessages = this._config.maxRecentMessages;
		this._minMessagesToCompress = this._config.minMessagesToCompress;
	}

	/**
	 * 注入日志服务，使压缩诊断日志输出到 VS Code Output 面板而非仅 console。
	 * 未注入时退化为 console.warn/error。
	 */
	setLogger(logger: IContextLogger): void {
		this._logger = logger;
	}

	/** 统一日志输出：有注入 logger 用 logger，否则 fallback 到 console */
	private _log(level: 'info' | 'warn' | 'error' | 'debug', msg: string, error?: unknown): void {
		if (this._logger) {
			this._logger[level](msg, error);
		} else {
			if (level === 'error') { console.error(msg, error ?? ''); }
			else if (level === 'warn') { console.warn(msg); }
			else { console.log(msg); }
		}
	}

	// ─── Dependency Injection ──────────────────────────────────────────────────

	/**
	 * Set AgentStudioService dependency
	 */
	setAgentStudioService(service: IAgentStudioService): void {
		this._agentStudioService = service;
	}

	/**
	 * Set TaskOrchestrationService dependency
	 */
	setTaskOrchestrationService(service: ITaskOrchestrationService): void {
		this._taskOrchestrationService = service;
	}

	/**
	 * Set MemoryProvider dependency
	 * @deprecated Memory provider not yet implemented
	 */
	setMemoryProvider(provider: unknown): void {
		// Memory provider not yet implemented
		// TODO: Implement memory provider integration
	}

	/**
	 * Set ContextStorage dependency for persistence
	 */
	setStorage(storage: IContextStorage): void {
		this._storage = storage;
	}

	// ─── New API: Context Building ─────────────────────────────────────────────

	/**
	 * Build execution context for agent
	 * This is the main method to get complete context for agent execution
	 */
	async buildExecutionContext(options: {
		agentId: string;
		sessionId?: string;
		taskId?: string;
		workspaceId?: string;
	}): Promise<IExecutionContext> {
		const { agentId, sessionId, taskId, workspaceId } = options;

		// 1. Build agent context
		const agentContext = await this._buildAgentContext(agentId);

		// 2. Build workspace context
		const workspaceContext = await this._buildWorkspaceContext(workspaceId || agentContext.agentId);

		// 3. Build project context (derived from workspace)
		const projectContext = await this._buildProjectContext(workspaceContext);

		// 4. Build task context (if taskId provided)
		const taskContext = taskId ? await this._buildTaskContext(taskId) : undefined;

		// 5. Build session context
		const sessionContext = await this._buildSessionContext(sessionId || 'default', agentId);

		// 6. Build environment variables
		const env = this._buildEnvironmentVariables({
			workspace: workspaceContext,
			project: projectContext,
			task: taskContext,
			agent: agentContext,
			session: sessionContext,
		});

		// 7. Build prompts
		const prompts = this.buildDefaultPrompts({
			workspace: workspaceContext,
			project: projectContext,
			task: taskContext,
			agent: agentContext,
			session: sessionContext,
			env,
			prompts: {} as any,
			snapshot: {} as any,
		});

		// 8. Create snapshot
		const snapshot: IContextSnapshot = {
			snapshotId: this._generateId('snapshot-'),
			timestamp: new Date().toISOString(),
			version: 1,
			workspace: workspaceContext,
			project: projectContext,
			task: taskContext,
			agent: agentContext,
			session: sessionContext,
		};

		// 9. Build execution context
		const executionContext: IExecutionContext = {
			workspace: workspaceContext,
			project: projectContext,
			task: taskContext,
			agent: agentContext,
			session: sessionContext,
			env,
			prompts,
			snapshot,
		};

		// 10. Save snapshot and emit event
		await this.saveSnapshot(snapshot);

		// Emit context_created event
		const contextKey = `${agentId}:${sessionId || 'default'}`;
		await this.emitContextEvent({
			eventId: this._generateId('event-'),
			eventType: 'context_created',
			contextKey,
			timestamp: new Date().toISOString(),
			data: { agentId, sessionId, taskId, snapshotId: snapshot.snapshotId },
		});

		return executionContext;
	}

	// ─── New API: Context Snapshot ─────────────────────────────────────────────

	/**
	 * Save context snapshot
	 */
	async saveSnapshot(snapshot: IContextSnapshot): Promise<void> {
		// Save to in-memory cache
		this._snapshots.set(snapshot.snapshotId, snapshot);

		// Trim old snapshots if exceeding max history
		if (this._snapshots.size > this._config.maxSnapshotHistory) {
			const oldestKey = this._snapshots.keys().next().value;
			if (oldestKey) {
				this._snapshots.delete(oldestKey);
			}
		}

		// Persist to storage if available
		if (this._storage) {
			try {
				const key = `snapshot:${snapshot.snapshotId}`;
				await this._storage.write(key, snapshot);
			} catch (error) {
				console.error('[ContextManager] Failed to persist snapshot:', error);
			}
		}

		// Emit snapshot_created event
		const contextKey = `${snapshot.agent.agentId}:${snapshot.session.sessionId}`;
		await this.emitContextEvent({
			eventId: this._generateId('event-'),
			eventType: 'snapshot_created',
			contextKey,
			timestamp: new Date().toISOString(),
			data: { snapshotId: snapshot.snapshotId },
		});
	}

	/**
	 * Load context snapshot by ID
	 */
	async loadSnapshot(snapshotId: string): Promise<IContextSnapshot | undefined> {
		// Check in-memory cache first
		let snapshot = this._snapshots.get(snapshotId);
		if (snapshot) {
			return snapshot;
		}

		// Try to load from storage
		if (this._storage) {
			try {
				const key = `snapshot:${snapshotId}`;
				const data = await this._storage.read(key);
				if (data) {
					snapshot = data as IContextSnapshot;
					// Cache in memory
					this._snapshots.set(snapshotId, snapshot);
					return snapshot;
				}
			} catch (error) {
				console.error('[ContextManager] Failed to load snapshot from storage:', error);
			}
		}

		return undefined;
	}

	/**
	 * List all snapshots for an agent/session
	 */
	async listSnapshots(options: {
		agentId?: string;
		sessionId?: string;
		limit?: number;
	}): Promise<ReadonlyArray<IContextSnapshot>> {
		// Try to load all snapshots from storage first
		let snapshots: IContextSnapshot[] = [];
		
		if (this._storage) {
			try {
				const keys = await this._storage.list('snapshot:');
				for (const key of keys) {
					const data = await this._storage.read(key);
					if (data) {
						snapshots.push(data as IContextSnapshot);
					}
				}
			} catch (error) {
				console.error('[ContextManager] Failed to list snapshots from storage:', error);
				// Fallback to in-memory
				snapshots = Array.from(this._snapshots.values());
			}
		} else {
			snapshots = Array.from(this._snapshots.values());
		}

		// Filter by agentId
		if (options.agentId) {
			snapshots = snapshots.filter(s => s.agent.agentId === options.agentId);
		}

		// Filter by sessionId
		if (options.sessionId) {
			snapshots = snapshots.filter(s => s.session.sessionId === options.sessionId);
		}

		// Sort by timestamp (newest first)
		snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

		// Apply limit
		if (options.limit) {
			snapshots = snapshots.slice(0, options.limit);
		}

		return snapshots;
	}

	// ─── New API: Continuation Summary ─────────────────────────────────────────

	/**
	 * Get continuation summary for cross-session state
	 */
	async getContinuationSummary(agentId: string, sessionId: string): Promise<string | undefined> {
		const key = `${agentId}:${sessionId}`;
		
		// Check in-memory cache first
		let summary = this._continuationSummaries.get(key);
		if (summary) {
			return summary;
		}

		// Try to load from storage
		if (this._storage) {
			try {
				const storageKey = `summary:${key}`;
				const data = await this._storage.read(storageKey);
				if (data && typeof data === 'string') {
					summary = data;
					// Cache in memory
					this._continuationSummaries.set(key, summary);
					return summary;
				}
			} catch (error) {
				console.error('[ContextManager] Failed to load continuation summary from storage:', error);
			}
		}

		return undefined;
	}

	/**
	 * Update continuation summary
	 */
	async updateContinuationSummary(agentId: string, sessionId: string, summary: string): Promise<void> {
		const key = `${agentId}:${sessionId}`;
		this._continuationSummaries.set(key, summary);

		// Persist to storage if available
		if (this._storage) {
			try {
				const storageKey = `summary:${key}`;
				await this._storage.write(storageKey, summary);
			} catch (error) {
				console.error('[ContextManager] Failed to persist continuation summary:', error);
			}
		}
	}

	// ─── New API: Prompt Template Rendering ────────────────────────────────────

	/**
	 * Render prompt template with context
	 * Template can use {{context.field}} syntax to reference context fields
	 */
	renderTemplate(template: string, context: IExecutionContext): string {
		return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, path) => {
			const value = this._resolvePathValue(context, path);
			return value !== undefined ? String(value) : match;
		});
	}

	/**
	 * Build default prompts from context
	 */
	buildDefaultPrompts(context: IExecutionContext): IContextPrompts {
		const { task, session } = context;

		// Build system prompt
		const systemPrompt = this._buildSystemPrompt(context);

		// Build bootstrap prompt
		const bootstrapPrompt = this._buildBootstrapPrompt(context);

		// Build wake prompt (task-specific)
		const wakePrompt = task ? this._buildWakePrompt(context) : undefined;

		// Build heartbeat prompt
		const heartbeatPrompt = this._buildHeartbeatPrompt(context);

		// Build continuation prompt
		const continuationPrompt = session.continuationSummary
			? `Previous conversation summary:\n${session.continuationSummary}`
			: undefined;

		return {
			systemPrompt,
			bootstrapPrompt,
			wakePrompt,
			heartbeatPrompt,
			continuationPrompt,
		};
	}

	// ─── Old API (backward compatible) ─────────────────────────────────────────

	/**
	 * OLD API: Check and compress context if needed
	 * @deprecated Use buildExecutionContext() for new code
	 */
	async compressIfNeeded(messages: ReadonlyArray<ChatMessage>, maxTokens: number): Promise<ReadonlyArray<ChatMessage>> {
		const estimatedTokens = this._estimateTokens(messages);

		// Check if compression is needed
		if (
			estimatedTokens < maxTokens * this._compressionThreshold ||
			messages.length < this._minMessagesToCompress
		) {
			return [...messages];
		}

		// Separate system messages (preserve)
		const systemMessages = messages.filter(m => m.role === 'system');
		const nonSystemMessages = messages.filter(m => m.role !== 'system');

		// Keep recent messages
		const recentMessages = nonSystemMessages.slice(-this._maxRecentMessages);
		const oldMessages = nonSystemMessages.slice(0, -this._maxRecentMessages);

		if (oldMessages.length === 0) {
			return [...messages];
		}

		// Generate summary
		const summary = await this._generateSummary(oldMessages);

		// Construct compressed messages
		const compressedMessages: ChatMessage[] = [
			...systemMessages,
			{
				role: 'system',
				content: `Previous conversation summary:\n${summary}`,
			} as ChatMessage,
			...recentMessages,
		];

		return compressedMessages;
	}

	/**
	 * OLD API: Get context statistics
	 * @deprecated Use buildExecutionContext() for new code
	 */
	getContextStats(messages: ReadonlyArray<IChatMessage>, maxTokens: number): {
		estimatedTokens: number;
		usagePercentage: number;
		messageCount: number;
		needsCompression: boolean;
	} {
		const estimatedTokens = this._estimateTokens(messages);
		const usagePercentage = (estimatedTokens / maxTokens) * 100;

		return {
			estimatedTokens,
			usagePercentage,
			messageCount: messages.length,
			needsCompression: usagePercentage > this._compressionThreshold * 100,
		};
	}

	// ─── Private: Context Builders ─────────────────────────────────────────────

	private async _buildAgentContext(agentId: string): Promise<IAgentContext> {
		// Try to get agent from AgentStudioService
		if (this._agentStudioService) {
			try {
				const agent = await this._agentStudioService.getAgent(agentId);
				if (agent) {
					return {
						agentId: agent.id,
						agentName: agent.name || agent.id,
						agentRole: agent.role || 'worker',
						agentType: agent.agentType,
						model: agent.model,
						skills: agent.skills ? [...agent.skills] : undefined,
						status: agent.status || 'idle',
					};
				}
			} catch (error) {
				console.error('[ContextManager] Failed to get agent:', error);
			}
		}

		// Fallback: return placeholder
		return {
			agentId,
			agentName: 'Unknown Agent',
			agentRole: 'worker',
			status: 'idle',
		};
	}

	private async _buildWorkspaceContext(workspaceId: string): Promise<IWorkspaceContext> {
		// Try to get workspace from AgentStudioService
		if (this._agentStudioService) {
			try {
				const workspace = await this._agentStudioService.getWorkspace(workspaceId);
				if (workspace) {
					// Fetch agent definitions in this workspace
					const agents = await this._fetchAgents(workspace.agents);

					// Map connections
					const connections: WorkspaceConnection[] = (workspace.connections || []).map(conn => ({
						id: conn.id,
						sourceId: conn.sourceId,
						targetId: conn.targetId,
						type: String(conn.type),
						label: conn.label,
					}));

					return {
						workspaceId: workspace.id,
						workspaceName: workspace.name || workspace.id,
						workspacePath: workspace.path,
						agents,
						connections,
						layout: workspace.layout,
						// Note: workspace.rootInfo is agentStudioTypes.WorkspaceRootInfo, not contextTypes.WorkspaceRootInfo
						// We don't assign rootInfo to avoid type mismatch
					};
				}
			} catch (error) {
				console.error('[ContextManager] Failed to get workspace:', error);
			}
		}

		// Fallback: return placeholder
		return {
			workspaceId,
			workspaceName: 'Unknown Workspace',
			agents: [],
			connections: [],
		};
	}

	/**
	 * Fetch agent definitions by IDs (for workspace context).
	 */
	private async _fetchAgents(agentIds: ReadonlyArray<string>): Promise<Agent[]> {
		if (!this._agentStudioService || !agentIds || agentIds.length === 0) {
			return [];
		}

		const agents: Agent[] = [];
		for (const id of agentIds) {
			try {
				const agent = await this._agentStudioService.getAgent(id);
				if (agent) {
					agents.push(agent);
				}
			} catch (error) {
				console.error(`[ContextManager] Failed to get agent ${id}:`, error);
			}
		}
		return agents;
	}

	private async _buildProjectContext(workspace: IWorkspaceContext): Promise<IProjectContext | undefined> {
		// Derive project context from workspace
		// Project is essentially the workspace in our architecture
		// Note: workspace.rootInfo is agentStudioTypes.WorkspaceRootInfo, not contextTypes.WorkspaceRootInfo
		// We don't assign rootInfo to avoid type mismatch
		return {
			projectId: workspace.workspaceId,
			projectName: workspace.workspaceName,
			settings: {
				// Project-level settings can be derived from workspace
				workspacePath: workspace.workspacePath,
			},
		};
	}

	private async _buildTaskContext(taskId: string): Promise<ITaskContext | undefined> {
		if (!this._taskOrchestrationService) {
			return undefined;
		}

		try {
			// Get all plans (no workspace filter)
			const plans = await this._taskOrchestrationService.listPlans();
			
			// Search through all plans' tasks to find the task
			for (const plan of plans) {
				const task = plan.tasks.find(t => t.id === taskId);
				if (task) {
					// Found the task, map it to ITaskContext
					return this._mapPlanTaskToTaskContext(task);
				}
			}
		} catch (error) {
			console.error('[ContextManager] Failed to get task:', error);
		}

		return undefined;
	}

	/**
	 * Map PlanTask to ITaskContext
	 */
	private _mapPlanTaskToTaskContext(task: PlanTask): ITaskContext {
		// Map priority: 0=critical, 1=high, 2=medium, 3=low
		let priority: 'low' | 'medium' | 'high' | 'critical' | undefined;
		if (task.priority === 0) priority = 'critical';
		else if (task.priority === 1) priority = 'high';
		else if (task.priority === 2) priority = 'medium';
		else if (task.priority === 3) priority = 'low';

		// Determine workMode from reviewStatus
		let workMode: 'auto' | 'review' | 'manual' | undefined;
		if (task.reviewStatus === 'pending') {
			workMode = 'review';
		} else if (task.autoCreateAgent) {
			workMode = 'auto';
		}

		return {
			taskId: task.id,
			title: task.title,
			description: task.description,
			status: task.status,
			priority,
			dependencies: task.dependencies.length > 0 ? task.dependencies.map(depId => ({
				taskId: depId,
				status: 'pending' as PlanTaskStatus,
			})) : undefined,
			assigneeId: task.assigneeId,
			assigneeName: task.assigneeName,
			result: task.result,
			error: task.error,
			workMode,
		};
	}

	private async _buildSessionContext(sessionId: string, agentId: string): Promise<ISessionContext> {
		// Try to get session from AgentStudioService
		if (this._agentStudioService) {
			try {
				const session = await this._agentStudioService.getSession(sessionId);
				if (session) {
					return {
						sessionId: session.id,
						messages: [], // TODO: Get messages from AgentChatService
						continuationSummary: await this.getContinuationSummary(agentId, sessionId),
						metadata: {
							sessionName: session.name,
							workspaceId: session.workspaceId,
							activeAgentId: session.activeAgentId,
							createdAt: session.createdAt,
							updatedAt: session.updatedAt,
							archived: session.archived,
						},
					};
				}
			} catch (error) {
				console.error('[ContextManager] Failed to get session:', error);
			}
		}

		// Fallback: return placeholder
		return {
			sessionId,
			messages: [],
			continuationSummary: await this.getContinuationSummary(agentId, sessionId),
		};
	}

	private _buildEnvironmentVariables(context: {
		workspace: IWorkspaceContext;
		project?: IProjectContext;
		task?: ITaskContext;
		agent: IAgentContext;
		session: ISessionContext;
	}): Record<string, string> {
		const env: Record<string, string> = {};

		// Workspace env vars
		env['WORKSPACE_ID'] = context.workspace.workspaceId;
		env['WORKSPACE_NAME'] = context.workspace.workspaceName;
		if (context.workspace.workspacePath) {
			env['WORKSPACE_PATH'] = context.workspace.workspacePath;
		}

		// Project env vars
		if (context.project) {
			env['PROJECT_ID'] = context.project.projectId;
			env['PROJECT_NAME'] = context.project.projectName;
		}

		// Task env vars
		if (context.task) {
			env['TASK_ID'] = context.task.taskId;
			env['TASK_TITLE'] = context.task.title;
			env['TASK_STATUS'] = context.task.status;
			if (context.task.workMode) {
				env['TASK_WORK_MODE'] = context.task.workMode;
			}
		}

		// Agent env vars
		env['AGENT_ID'] = context.agent.agentId;
		env['AGENT_NAME'] = context.agent.agentName;
		env['AGENT_ROLE'] = context.agent.agentRole;
		if (context.agent.model) {
			env['AGENT_MODEL'] = context.agent.model;
		}

		// Session env vars
		env['SESSION_ID'] = context.session.sessionId;

		return env;
	}

	// ─── Private: Prompt Builders ──────────────────────────────────────────────

	private _buildSystemPrompt(context: IExecutionContext): string {
		const { agent, workspace, task } = context;

		let prompt = `# ${agent.agentName}\n\n`;
		prompt += `You are ${agent.agentName}, a ${agent.agentRole} agent.\n`;
		prompt += `Workspace: ${workspace.workspaceName}\n`;

		if (task) {
			prompt += `\n## Current Task\n`;
			prompt += `Title: ${task.title}\n`;
			if (task.description) {
				prompt += `Description: ${task.description}\n`;
			}
			prompt += `Status: ${task.status}\n`;
		}

		return prompt;
	}

	private _buildBootstrapPrompt(context: IExecutionContext): string {
		const { agent, workspace } = context;

		let prompt = `# Bootstrap\n\n`;
		prompt += `Agent: ${agent.agentName}\n`;
		prompt += `Workspace: ${workspace.workspaceName}\n`;
		prompt += `\nYou are now being bootstrapped into this workspace. Please familiarize yourself with the environment.\n`;

		return prompt;
	}

	private _buildWakePrompt(context: IExecutionContext): string {
		const { task } = context;
		if (!task) return '';

		let prompt = `# Task Wake\n\n`;
		prompt += `You have been woken up to work on a task.\n\n`;
		prompt += `## Task Details\n`;
		prompt += `ID: ${task.taskId}\n`;
		prompt += `Title: ${task.title}\n`;
		if (task.description) {
			prompt += `Description: ${task.description}\n`;
		}
		prompt += `Status: ${task.status}\n`;

		if (task.dependencies && task.dependencies.length > 0) {
			prompt += `\n## Dependencies\n`;
			prompt += `This task depends on: ${task.dependencies.join(', ')}\n`;
		}

		return prompt;
	}

	private _buildHeartbeatPrompt(context: IExecutionContext): string {
		const { task } = context;

		let prompt = `# Heartbeat Check\n\n`;
		prompt += `This is a periodic heartbeat check.\n\n`;

		if (task) {
			prompt += `## Current Task\n`;
			prompt += `Title: ${task.title}\n`;
			prompt += `Status: ${task.status}\n`;
		}

		prompt += `\nPlease check your current status and continue working if appropriate.\n`;

		return prompt;
	}

	// ─── Private: Template Rendering ───────────────────────────────────────────

	private _resolvePathValue(obj: unknown, path: string): unknown {
		const parts = path.split('.');
		let current: unknown = obj;

		for (const part of parts) {
			if (current === null || current === undefined) {
				return undefined;
			}

			if (typeof current === 'object') {
				current = (current as Record<string, unknown>)[part];
			} else {
				return undefined;
			}
		}

		return current;
	}

	// ─── Private: Utility Methods ─────────────────────────────────────────

	/**
	 * Generate a unique ID with prefix
	 */
	private _generateId(prefix: string): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).substring(2, 11);
		return `${prefix}${timestamp}-${random}`;
	}

	// ─── Private: Summary Generation (from old API) ───────────────────────────

	private async _generateSummary(messages: ReadonlyArray<IChatMessage>): Promise<string> {
		try {
			const summaryPrompt = this._buildSummaryPrompt(messages);

			const stream = this._modelProvider.chat(this._modelId, [
				{ role: 'user', content: summaryPrompt } as IChatMessage,
			], {
				temperature: 0.3,
				maxTokens: 500,
			}, {});

			let summary = '';
			for await (const delta of stream) {
				if (delta.type === 'text' && delta.content) {
					summary += delta.content;
				}
				if (delta.type === 'done') {
					break;
				}
			}

			return summary.trim() || 'No summary available.';
		} catch (error) {
			console.error('[ContextManager] Failed to generate summary:', error);
			return 'Previous conversation (summary generation failed).';
		}
	}

	private _buildSummaryPrompt(messages: ReadonlyArray<IChatMessage>): string {
		const conversationText = messages
			.map(m => `${m.role}: ${m.content.substring(0, 200)}`)
			.join('\n');

		return `Please summarize the following conversation concisely, focusing on key decisions, actions taken, and important context for continuing the conversation:\n\n${conversationText}\n\nSummary:`;
	}

	// ─── Hermes-inspired structured summary ──────────────────────────────────

	/**
	 * 生成结构化摘要（Hermes context_compressor 风格）。
	 * 支持迭代摘要：存在 existingSummary 时增量更新而非重写。
	 * LLM 调用失败时退化为确定性本地摘要，绝不抛错。
	 */
	private async _generateStructuredSummary(
		messages: ReadonlyArray<ChatMessage>,
		existingSummary: string
	): Promise<string> {
		try {
			const prompt = this._buildStructuredSummaryPrompt(messages, existingSummary);
			const stream = this._modelProvider.chat(
				this._config.summaryModelId || this._modelId,
				[{ role: 'user', content: prompt } as IChatMessage],
				{ temperature: 0.3, maxTokens: ContextManager.SUMMARY_MAX_TOKENS },
				{}
			);

			let summary = '';
			for await (const delta of stream) {
				if (delta.type === 'text' && delta.content) {
					summary += delta.content;
				}
				if (delta.type === 'done') {
					break;
				}
			}

		const trimmed = summary.trim();
		if (trimmed) {
			return trimmed;
		}
		// 空响应 → fallback
		this._log('warn',
			`[ContextManager][Compression] Summary LLM returned empty, using fallback summary. ` +
			`model=${this._config.summaryModelId || this._modelId} messages=${messages.length}`
		);
		return this._buildFallbackSummary(messages, existingSummary);
	} catch (error) {
		this._log('warn',
			`[ContextManager][Compression] Summary LLM call failed, using fallback summary. ` +
			`model=${this._config.summaryModelId || this._modelId} error=${error instanceof Error ? error.message : String(error)}`,
			error
		);
		return this._buildFallbackSummary(messages, existingSummary);
	}
	}

	/**
	 * 构建结构化摘要 prompt（分区：任务/目标/已完成/状态/进行中/受阻/决策/待办/文件/剩余/关键上下文）。
	 */
	private _buildStructuredSummaryPrompt(
		messages: ReadonlyArray<ChatMessage>,
		existingSummary: string
	): string {
		const conversationText = messages
			.map(m => {
				const roleLabel = m.role.toUpperCase();
				const toolInfo = Array.isArray(m.toolCalls) && m.toolCalls.length > 0
					? ` [调用工具: ${m.toolCalls.map(tc => (tc as { name?: string }).name || 'unknown').join(', ')}]`
					: '';
				return `${roleLabel}${toolInfo}: ${(m.content || '').substring(0, 500)}`;
			})
			.join('\n\n');

		const iterativeHint = existingSummary
			? `\n\n这是已有的早期摘要，请在其基础上**增量更新**（合并新信息，不要丢弃仍然有效的旧信息）：\n"""\n${existingSummary}\n"""\n`
			: '';

		return `你是一个对话压缩器。请将下面的对话历史压缩成结构化摘要，用于在后续对话中保持上下文连续性。${iterativeHint}

请严格按以下分区输出（无内容的分区写"无"）：

## Active Task（当前任务）
逐字保留用户最近正在要求完成的核心任务描述，不要改写。

## Goal（总体目标）
本次会话要达成的整体目标。

## Completed Actions（已完成的动作）
已经做完的关键步骤（按时间顺序，简明列点）。

## Active State（当前状态）
代码/文件/系统当前所处的状态。

## In Progress（进行中）
正在做但尚未完成的工作。

## Blocked（受阻项）
遇到的阻塞、错误或待解决的问题。

## Key Decisions（关键决策）
做出的重要技术/方案决策及其理由。

## Pending User Asks（待响应的用户请求）
用户提出但尚未满足的请求。

## Relevant Files（相关文件）
涉及的关键文件路径及其作用。

## Remaining Work（剩余工作）
后续还需要做的事。

## Critical Context（关键上下文）
其他对继续工作至关重要、不可丢失的信息。

待压缩的对话历史：
"""
${conversationText}
"""

结构化摘要：`;
	}

	/**
	 * 确定性本地摘要（LLM 失败时的兜底）：不调用模型，从消息直接抽取，保证永不丢上下文。
	 */
	private _buildFallbackSummary(
		messages: ReadonlyArray<ChatMessage>,
		existingSummary: string
	): string {
		const userMsgs = messages.filter(m => m.role === 'user');
		const toolNames = new Set<string>();
		for (const m of messages) {
			if (Array.isArray(m.toolCalls)) {
				for (const tc of m.toolCalls) {
					const name = (tc as { name?: string }).name;
					if (name) {
						toolNames.add(name);
					}
				}
			}
		}
		const lines: string[] = [];
		lines.push('## Active Task');
		const lastUser = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1].content : '';
		lines.push(lastUser ? lastUser.substring(0, 400) : '无');
		lines.push('');
		lines.push('## Completed Actions');
		lines.push(toolNames.size > 0 ? `使用过的工具: ${Array.from(toolNames).join(', ')}` : '无');
		lines.push('');
		lines.push('## Critical Context');
		lines.push(`（自动兜底摘要：本段压缩了 ${messages.length} 条早期消息，其中用户消息 ${userMsgs.length} 条。LLM 摘要不可用，已按确定性规则保留要点。）`);
		if (existingSummary) {
			lines.push('');
			lines.push('## 早期摘要（保留）');
			lines.push(existingSummary);
		}
		return lines.join('\n');
	}

	/**
	 * 粗略估算一组消息的输入 token（preflight 用，无需精确）。
	 *
	 * 口径对齐 Hermes `estimate_messages_tokens_rough`：
	 *  1. 对**整条消息**做 JSON 序列化后按 char/4 计 token——天然涵盖
	 *     content / contentParts(text) / toolCalls / toolCallId / role 等
	 *     所有字段，避免旧实现只算 content+toolCalls 漏掉 contentParts、
	 *     thinking、tool_result 造成的系统性低估（中文场景尤甚）。
	 *  2. 图片（contentParts 中 type==='image' 的 base64 data）**先剥离**，
	 *     再按固定 `IMAGE_TOKEN_COST` 平摊——否则一张 1MB 截图的 base64
	 *     会被估成 ~25 万 token 引发误触发压缩。
	 */
	private _estimateTokens(messages: ReadonlyArray<IChatMessage>): number {
		let totalChars = 0;
		let imageTokens = 0;
		for (const m of messages) {
			if (!m) { continue; }
			imageTokens += this._countImageTokens(m);
			totalChars += this._estimateMessageChars(m);
		}
		return Math.ceil(totalChars / 4) + imageTokens;
	}

	/** 单张图片平摊 token 成本（Anthropic 口径），与 Hermes 对齐。 */
	private static readonly IMAGE_TOKEN_COST = 1500;

	/**
	 * 统计一条消息中的图片块数量 × 单张成本。
	 * 图片 base64 不计入字符，避免严重高估。
	 */
	private _countImageTokens(m: IChatMessage): number {
		const parts = (m as { contentParts?: ReadonlyArray<{ type?: string }> }).contentParts;
		if (!Array.isArray(parts)) {
			return 0;
		}
		let count = 0;
		for (const p of parts) {
			if (p && p.type === 'image') {
				count++;
			}
		}
		return count * ContextManager.IMAGE_TOKEN_COST;
	}

	/**
	 * 序列化一条消息用于字符计数，但**剥离图片 base64 data**
	 * （图片成本另由 _countImageTokens 平摊计入）。
	 */
	private _estimateMessageChars(m: IChatMessage): number {
		const shadow: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(m as unknown as Record<string, unknown>)) {
			if (k === 'contentParts' && Array.isArray(v)) {
				shadow[k] = v.map((p) => {
					if (p && typeof p === 'object' && (p as { type?: string }).type === 'image') {
						return { type: 'image', data: '[stripped]' };
					}
					return p;
				});
			} else {
				shadow[k] = v;
			}
		}
		try {
			return JSON.stringify(shadow).length;
		} catch {
			// 循环引用等异常兜底：退化为 content 长度
			return (m.content?.length || 0);
		}
	}

	// ─── New API: Orchestration Support (multi-agent) ──────────────────────

	/**
	 * Build orchestration context for multi-agent scenarios
	 */
	async buildOrchestrationContext(options: {
		orchestrationId: string;
		agentIds?: ReadonlyArray<string>;
		taskIds?: ReadonlyArray<string>;
	}): Promise<IOrchestrationContext> {
		const { orchestrationId, agentIds, taskIds } = options;

		// Build agent contexts
		const agentContexts: IAgentContext[] = [];
		if (agentIds) {
			for (const agentId of agentIds) {
				const agentContext = await this._buildAgentContext(agentId);
				agentContexts.push(agentContext);
			}
		}

		// Build task contexts
		const taskContexts: ITaskContext[] = [];
		if (taskIds) {
			for (const taskId of taskIds) {
				const taskContext = await this._buildTaskContext(taskId);
				if (taskContext) {
					taskContexts.push(taskContext);
				}
			}
		}

		// Calculate progress
		const totalTasks = taskContexts.length;
		const completedTasks = taskContexts.filter(t => t.status === 'done').length;
		const failedTasks = taskContexts.filter(t => t.status === 'error' || t.status === 'cancelled').length;
		const inProgressTasks = taskContexts.filter(t => t.status === 'running').length;

		// Try to get orchestration goal from service
		let orchestrationGoal = 'Auto-generated goal';
		let orchestrationStatus: 'planning' | 'executing' | 'completed' | 'failed' = 'executing';
		if (this._taskOrchestrationService) {
			try {
				const orchestration = await this._taskOrchestrationService.getPlan?.(orchestrationId);
				if (orchestration) {
					orchestrationGoal = orchestration.goal || orchestrationGoal;
					// Map OrchestrationPlanStatus to expected string literals
					const statusMap: Record<string, 'planning' | 'executing' | 'completed' | 'failed'> = {
						'pending_approval': 'planning',
						'approved': 'planning',
						'executing': 'executing',
						'completed': 'completed',
						'rejected': 'failed',
						'error': 'failed',
					};
					orchestrationStatus = statusMap[orchestration.status] || 'executing';
				}
			} catch (error) {
				console.error('[ContextManager] Failed to get orchestration info:', error);
			}
		}

		const orchestrationContext: IOrchestrationContext = {
			orchestrationId,
			orchestrationGoal,
			orchestrationStatus,
			globalProgress: {
				totalTasks,
				completedTasks,
				failedTasks,
				inProgressTasks,
			},
			agents: agentContexts,
			tasks: taskContexts,
			startTime: new Date().toISOString(),
			metadata: {
				generatedBy: 'ContextManager',
			},
		};

		// Cache the orchestration context
		this._orchestrationContexts.set(orchestrationId, orchestrationContext);

		return orchestrationContext;
	}

	/**
	 * Handoff context from one agent to another
	 */
	async handoffContext(options: {
		fromAgentId: string;
		toAgentId: string;
		taskId: string;
		reason: string;
	}): Promise<IContextHandoff> {
		const { fromAgentId, toAgentId, taskId, reason } = options;

		// Build context snapshot for the handoff
		const fromAgentContext = await this._buildAgentContext(fromAgentId);
		const toAgentContext = await this._buildAgentContext(toAgentId);
		const taskContext = await this._buildTaskContext(taskId);
		const workspaceContext = await this._buildWorkspaceContext(fromAgentContext.agentId);

		const snapshot: IContextSnapshot = {
			snapshotId: this._generateId('handoff-'),
			timestamp: new Date().toISOString(),
			version: 1,
			workspace: workspaceContext,
			project: await this._buildProjectContext(workspaceContext),
			task: taskContext,
			agent: fromAgentContext,
			session: await this._buildSessionContext('default', fromAgentId),
		};

		const handoff: IContextHandoff = {
			fromAgentId,
			fromAgentName: fromAgentContext.agentName,
			toAgentId,
			toAgentName: toAgentContext.agentName || 'Unknown',
			taskId,
			contextSnapshot: snapshot,
			handoffReason: reason,
			timestamp: new Date().toISOString(),
			metadata: {
				handoffType: 'task_transfer',
			},
		};

		// Cache the handoff
		this._handoffs.set(`${fromAgentId}-${toAgentId}-${taskId}`, handoff);

		return handoff;
	}

	/**
	 * Get shared context for an orchestration
	 */
	async getSharedContext(orchestrationId: string): Promise<ISharedContext | undefined> {
		// Check cache first
		let sharedContext = this._sharedContexts.get(orchestrationId);
		if (sharedContext) {
			return sharedContext;
		}

		// Try to load from storage
		if (this._storage) {
			try {
				const key = `shared:${orchestrationId}`;
				const data = await this._storage.read(key);
				if (data) {
					sharedContext = data as ISharedContext;
					// Cache in memory
					this._sharedContexts.set(orchestrationId, sharedContext);
					return sharedContext;
				}
			} catch (error) {
				console.error('[ContextManager] Failed to load shared context from storage:', error);
			}
		}

		return undefined;
	}

	/**
	 * Update shared context for an orchestration
	 */
	async updateSharedContext(orchestrationId: string, context: ISharedContext): Promise<void> {
		this._sharedContexts.set(orchestrationId, context);

		// Persist to storage if available
		if (this._storage) {
			try {
				const key = `shared:${orchestrationId}`;
				await this._storage.write(key, context);
			} catch (error) {
				console.error('[ContextManager] Failed to persist shared context:', error);
			}
		}

		// Emit context_updated event
		await this.emitContextEvent({
			eventId: this._generateId('event-'),
			eventType: 'context_updated',
			contextKey: `orchestration:${orchestrationId}`,
			timestamp: new Date().toISOString(),
			data: { orchestrationId, context },
		});
	}

	// ─── New API: Context Validation & Diffing (P1 improvements) ───────────

	/**
	 * Validate context integrity before passing to agents
	 * @returns Validation result with errors if any
	 */
	validateContext(context: IExecutionContext): { valid: boolean; errors: string[] } {
		const errors: string[] = [];

		// Validate workspace context
		if (!context.workspace) {
			errors.push('Missing workspace context');
		} else {
			if (!context.workspace.workspaceId) errors.push('Missing workspaceId');
			if (!context.workspace.workspaceName) errors.push('Missing workspaceName');
		}

		// Validate agent context
		if (!context.agent) {
			errors.push('Missing agent context');
		} else {
			if (!context.agent.agentId) errors.push('Missing agentId');
			if (!context.agent.agentName) errors.push('Missing agentName');
		}

		// Validate session context
		if (!context.session) {
			errors.push('Missing session context');
		} else {
			if (!context.session.sessionId) errors.push('Missing sessionId');
		}

		// Validate task context (if present)
		if (context.task) {
			if (!context.task.taskId) errors.push('Missing taskId');
			if (!context.task.title) errors.push('Missing task title');
			if (!context.task.status) errors.push('Missing task status');
		}

		return {
			valid: errors.length === 0,
			errors,
		};
	}

	/**
	 * Compare two context snapshots and return the differences
	 * Useful for tracking context changes over time
	 */
	diffContexts(snapshot1: IContextSnapshot, snapshot2: IContextSnapshot): IContextDiff {
		const differences: IContextDiffEntry[] = [];

		// Compare workspace
		if (JSON.stringify(snapshot1.workspace) !== JSON.stringify(snapshot2.workspace)) {
			differences.push({
				path: 'workspace',
				changeType: 'modified',
				oldValue: snapshot1.workspace,
				newValue: snapshot2.workspace,
			});
		}

		// Compare project
		if (JSON.stringify(snapshot1.project) !== JSON.stringify(snapshot2.project)) {
			differences.push({
				path: 'project',
				changeType: 'modified',
				oldValue: snapshot1.project,
				newValue: snapshot2.project,
			});
		}

		// Compare task
		if (JSON.stringify(snapshot1.task) !== JSON.stringify(snapshot2.task)) {
			differences.push({
				path: 'task',
				changeType: 'modified',
				oldValue: snapshot1.task,
				newValue: snapshot2.task,
			});
		}

		// Compare agent
		if (JSON.stringify(snapshot1.agent) !== JSON.stringify(snapshot2.agent)) {
			differences.push({
				path: 'agent',
				changeType: 'modified',
				oldValue: snapshot1.agent,
				newValue: snapshot2.agent,
			});
		}

		// Compare session
		if (JSON.stringify(snapshot1.session) !== JSON.stringify(snapshot2.session)) {
			differences.push({
				path: 'session',
				changeType: 'modified',
				oldValue: snapshot1.session,
				newValue: snapshot2.session,
			});
		}

		// Calculate summary
		const summary = {
			added: differences.filter(d => d.changeType === 'added').length,
			removed: differences.filter(d => d.changeType === 'deleted').length,
			modified: differences.filter(d => d.changeType === 'modified').length,
		};

		return {
			baseSnapshotId: snapshot1.snapshotId,
			compareSnapshotId: snapshot2.snapshotId,
			comparedAt: new Date().toISOString(),
			differences,
			summary,
		};
	}

	// ─── New API: Context Versioning (P1 improvements) ──────────────────────

	/**
	 * Get all versions for a context
	 */
	async getContextVersions(contextKey: string): Promise<ReadonlyArray<IContextVersion>> {
		const versions = this._contextVersions.get(contextKey) || [];
		return [...versions].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	}

	/**
	 * Rollback context to a previous version
	 */
	async rollbackContext(versionId: string): Promise<IContextSnapshot> {
		// Find the version by ID
		let targetVersion: IContextVersion | undefined;
		for (const versions of this._contextVersions.values()) {
			const found = versions.find(v => v.versionId === versionId);
			if (found) {
				targetVersion = found;
				break;
			}
		}

		if (!targetVersion) {
			throw new ContextVersionNotFoundError(versionId);
		}

		// Load the snapshot
		const snapshot = await this.loadSnapshot(targetVersion.snapshotId);
		if (!snapshot) {
			throw new ContextSnapshotNotFoundError(targetVersion.snapshotId);
		}

		// Emit context_updated event
		await this.emitContextEvent({
			eventId: this._generateId('event-'),
			eventType: 'context_updated',
			contextKey: targetVersion.contextKey,
			timestamp: new Date().toISOString(),
			data: { versionId, snapshotId: snapshot.snapshotId },
		});

		return snapshot;
	}

	// ─── New API: Context Events (P1 improvements) ──────────────────────

	/**
	 * Subscribe to context events
	 */
	subscribeToContextEvents(contextKey: string, handler: IContextEventHandler): () => void {
		if (!this._eventHandlers.has(contextKey)) {
			this._eventHandlers.set(contextKey, new Set());
		}

		const handlers = this._eventHandlers.get(contextKey)!;
		handlers.add(handler);

		// Return unsubscribe function
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) {
				this._eventHandlers.delete(contextKey);
			}
		};
	}

	/**
	 * Emit a context event
	 */
	async emitContextEvent(event: IContextEvent): Promise<void> {
		const handlers = this._eventHandlers.get(event.contextKey);
		if (!handlers) {
			return;
		}

		// Execute all handlers
		const promises = Array.from(handlers).map(async (handler) => {
			try {
				await handler(event);
			} catch (error) {
				console.error('[ContextManager] Error in event handler:', error);
			}
		});

		await Promise.all(promises);
	}

	// ─── New API: Context Compression (P1 improvements) ──────────────────────
	// ─── Hermes-inspired three-segment compression ───────────────────────────
	//
	// 设计参考 Hermes-Agent (context_compressor / conversation_compression):
	//   [保护头]  system 消息 + 前 PROTECT_FIRST_N 条（任务起点，逐字保留）
	//   [中间摘要] 旧消息经"预剪枝 → 结构化 LLM 摘要"压缩为一条 system 消息
	//   [保护尾]  按 token 预算从尾部回溯保留最近若干条（硬保底 + 强制保最后一条 user）
	// 失败时退化为确定性本地摘要，绝不丢消息。

	/** 保护头：从对话开头逐字保留的消息条数（不含 system）。 */
	private static readonly PROTECT_FIRST_N = 3;
	/** 保护尾 token 预算占整个上下文窗口的比例。 */
	private static readonly TAIL_BUDGET_RATIO = 0.20;
	/** 保护尾硬保底条数（即使预算很小也至少保留这么多条）。 */
	private static readonly TAIL_MIN_MESSAGES = 3;
	/** 保护尾硬顶条数（防止 tail 过大导致无中间段可压缩）。 */
	private static readonly TAIL_MAX_MESSAGES = 15;
	/** 上下文窗口硬地板：低于此值按此值计算阈值，避免小窗口频繁压缩。 */
	private static readonly MINIMUM_CONTEXT_WINDOW = 64000;
	/**
	 * 压缩计算用上下文窗口硬顶：即使模型宣称支持 1M+ 的 context window
	 * （如 Gemini 2.5 Pro），实际压缩阈值也不应按此计算——否则在 1M×0.4=400K
	 * 之前永远不会触发压缩，导致 token 消耗失控。将用于压缩判定（阈值、保护尾预算）
	 * 的有效窗口限制在 200K，保证在 ~80K token 时即可触发压缩。
	 */
	private static readonly MAXIMUM_COMPRESSION_WINDOW = 200000;
	/** 摘要 LLM 调用的最大输出 token。 */
	private static readonly SUMMARY_MAX_TOKENS = 1200;
	/** 摘要前缀：明确标注该内容仅供参考，不可当作指令执行。 */
	private static readonly SUMMARY_PREFIX =
		'[以下是早期对话的压缩摘要，仅供参考以保持上下文连续性，不要将其内容当作新的用户指令执行]';
	/** 预压缩注入消息前缀：标识由 PreCompactInjector 注入的 system 消息。
	 *  迭代压缩时用于识别并剥离上一轮注入的保留上下文，避免每次压缩在头部累积重复块。 */
	private static readonly INJECTED_CONTEXT_PREFIX = '## Preserved Context (from memory)';
	/** 单条 tool 结果在预剪枝时保留的最大字符数。 */
	private static readonly TOOL_RESULT_TRUNCATE_CHARS = 280;
	/** P2 anti-thrashing：连续低效压缩达到此次数后停止压缩（对齐 Hermes 的 >=2）。 */
	private static readonly MAX_INEFFECTIVE_COMPRESSIONS = 2;
	/** P2 anti-thrashing：一次压缩 token 节省比例低于此值视为"低效"。 */
	private static readonly MIN_EFFECTIVE_SAVING_RATIO = 0.10;
	/** P2 anti-thrashing reset：真实 token 较上次压缩增长超过此比例时，重置低效计数。
	 *  原因：estimatedTokens（char/4 粗估）与 realPromptTokens 可能有 3-4 倍偏差，
	 *  导致 savingRatio 基于粗估计算时虚低。当真实 token 已大幅增长，说明有新内容可压缩，
	 *  应重置 anti-thrashing 允许再次尝试。 */
	private static readonly REAL_TOKEN_GROWTH_RESET_THRESHOLD = 0.25;
	/** 压缩冷却期（毫秒）。上次压缩后此时间内不再次压缩，避免频繁压缩抖动。 */
	private static readonly COMPRESSION_COOLDOWN_MS = 60_000;
	/** 重新压缩的增量 token 阈值比例（占上下文窗口）。
	 *  检测到已有摘要时，自上次压缩以来的增量 token 低于此比例则跳过重新压缩，
	 *  解决窗口重载后 ContextManager 内存状态丢失导致每次都重新压缩的问题。
	 *  与增量消息数门槛（minMessagesToCompress）联合判定，两者均达标才允许重新压缩。 */
	private static readonly RECOMPRESSION_DELTA_TOKEN_RATIO = 0.10;
	/** 嵌入摘要消息中的压缩元数据标记前缀，格式：<!-- saros-compaction: msgCount=X estTokens=Y ts=Z --> */
	private static readonly COMPRESSION_META_PATTERN = /<!-- saros-compaction: msgCount=(\d+) estTokens=(\d+) ts=(\d+) -->/;

	/**
	 * Compress context to reduce token usage (Hermes 三段式).
	 *
	 * @param messages 待压缩的完整消息序列
	 * @param config   覆盖默认压缩配置
	 * @param contextWindow 模型上下文窗口大小（token）。用于计算压缩阈值与保护尾预算。
	 *                      省略时回退到 MINIMUM_CONTEXT_WINDOW。
	 * @param realPromptTokens 上一轮 LLM 响应回传的**真实 prompt token**（provider usage，
	 *                      含 cache）。P1：触发判定优先采用真实值——粗估只用于尚无真实
	 *                      usage 的首轮预判，避免后端 char/4 与前端真实 tokenizer 口径割裂
	 *                      导致"已满却不触发"。>0 时生效，缺省/0 时退回粗估。
	 */
	async compressContext(
		messages: ReadonlyArray<ChatMessage>,
		config?: Partial<IContextCompressionConfig>,
		contextWindow?: number,
		realPromptTokens?: number,
		preCompactInject?: PreCompactInjectFn
	): Promise<IContextCompressionResult> {
		const compressionConfig: IContextCompressionConfig = {
			compressionThreshold: this._config.compressionThreshold,
			maxRecentMessages: this._config.maxRecentMessages,
			minMessagesToCompress: this._config.minMessagesToCompress,
			summaryModelId: this._config.summaryModelId,
			...config,
		};

		const estimatedTokens = this._estimateTokens(messages as any);
		// P1: 真实 prompt token 优先。provider 回传的 usage 才是模型实际看到的输入量，
		// 粗估（char/4 序列化）仅作为尚无真实 usage 时的预判兜底。两者择一作为
		// 触发判定的 effectiveTokens——有真实值就用真实值，从根本上消除口径割裂。
		const hasRealUsage = typeof realPromptTokens === 'number' && realPromptTokens > 0;
		const effectiveTokens = hasRealUsage ? realPromptTokens! : estimatedTokens;
		// P2: 消除硬编码——阈值基于真实上下文窗口（含硬地板+硬顶）计算。
		// 硬顶防止宣称 1M+ 窗口的模型（如 Gemini 2.5 Pro）在 400K token
		// 之前永远不触发压缩，导致 token 开销失控。
		const effectiveWindowRaw = Math.max(
			contextWindow ?? ContextManager.MINIMUM_CONTEXT_WINDOW,
			ContextManager.MINIMUM_CONTEXT_WINDOW
		);
		const effectiveWindow = Math.min(effectiveWindowRaw, ContextManager.MAXIMUM_COMPRESSION_WINDOW);
		const thresholdTokens = effectiveWindow * compressionConfig.compressionThreshold;

		// 诊断数据：跳过压缩时一并带回 metadata，供调用方打印日志，
		// 解释"为什么没触发压缩"（估算 token / 阈值 / 窗口 / 消息数门槛）。
		// effectiveTokens = 真实 usage（若有）否则 char/4 粗估；tokenSource 标明口径来源。
		const diagnostics = {
			estimatedTokens,
			realPromptTokens: hasRealUsage ? realPromptTokens! : null,
			effectiveTokens,
			tokenSource: hasRealUsage ? 'real_usage' : 'rough_estimate',
			thresholdTokens,
			effectiveWindow,
			contextWindowArg: contextWindow ?? null,
			compressionThreshold: compressionConfig.compressionThreshold,
			messageCount: messages.length,
			minMessagesToCompress: compressionConfig.minMessagesToCompress,
			ineffectiveCompressionCount: this._ineffectiveCompressionCount,
		};

			const noop = (reason: string): IContextCompressionResult => {
			// ── 诊断日志：跳过压缩时输出 warn，解释"为什么没触发" ──
			this._log('warn',
				`[ContextManager][Compression] SKIPPED reason=${reason} | ` +
				`effectiveTokens=${effectiveTokens} thresholdTokens=${thresholdTokens} ` +
				`(window=${effectiveWindow}×${compressionConfig.compressionThreshold}) | ` +
				`tokenSource=${hasRealUsage ? 'real_usage' : 'rough_estimate'} ` +
				`realPromptTokens=${hasRealUsage ? realPromptTokens! : 'null'} ` +
				`estimatedTokens=${estimatedTokens} | ` +
				`messageCount=${messages.length} minMessagesToCompress=${compressionConfig.minMessagesToCompress} | ` +
				`ineffectiveCompressionCount=${this._ineffectiveCompressionCount}`
			);
			return {
				originalMessageCount: messages.length,
				compressedMessageCount: messages.length,
				summary: '',
				compressedMessages: [...messages],
				metadata: { compressionRatio: 1.0, skipped: reason, ...diagnostics },
			};
		};

		// 触发条件：token 超阈值 且 消息数达到下限。区分具体跳过原因便于诊断。
		// P1: 用 effectiveTokens（真实优先）而非纯粗估判定。
		const belowTokenThreshold = effectiveTokens < thresholdTokens;
		const belowMessageMin = messages.length < compressionConfig.minMessagesToCompress;
		if (belowTokenThreshold || belowMessageMin) {
			const reason = belowTokenThreshold && belowMessageMin
				? 'below_token_threshold_and_message_min'
				: belowTokenThreshold
					? 'below_token_threshold'
					: 'below_message_min';
			return noop(reason);
		}

		// P4: 窗口重载后防止重复压缩 —— 基于摘要嵌入的元数据判断增量
		// ContextManager 每次 runAgentLoop 新建，_lastCompressionTime 等内存状态丢失。
		// 但摘要 system 消息随消息历史持久化，其中嵌入了上次压缩时的 msgCount/estTokens。
		// 检测到已有摘要时，解析元数据计算增量；增量不足则跳过压缩，避免窗口重载后
		// 每次都要重新压缩一遍已经压缩过的内容（原方案仅设 60 秒冷却期，过期后仍会重压）。
		if (this._lastCompressionTime === 0) {
			const summaryMsg = messages.find(m => this._isSummaryMessage(m));
			if (summaryMsg) {
				const meta = this._extractCompressionMeta(summaryMsg);
				if (meta) {
					const deltaMsgCount = messages.length - meta.msgCount;
					const currentEstTokens = this._estimateTokens(messages as any);
					const deltaTokens = Math.max(0, currentEstTokens - meta.estTokens);
					const deltaTokenThreshold = effectiveWindow * ContextManager.RECOMPRESSION_DELTA_TOKEN_RATIO;
					// 双重门槛：增量消息数 AND 增量 token 均需达标才允许重新压缩。
					// 避免窗口重载后 head+tail 本身就占大量 token 导致误触发重新压缩。
					if (deltaMsgCount < compressionConfig.minMessagesToCompress && deltaTokens < deltaTokenThreshold) {
						this._lastCompressionTime = Date.now();
						this._log('info',
							`[ContextManager][Compression] EXISTING_SUMMARY_VALID: ` +
							`deltaMsgCount=${deltaMsgCount} < ${compressionConfig.minMessagesToCompress}, ` +
							`deltaTokens=${deltaTokens} < ${deltaTokenThreshold.toFixed(0)} ` +
							`(meta: msgCount=${meta.msgCount} estTokens=${meta.estTokens}) ` +
							`→ skipping re-compression (window reloaded with existing summary, no significant delta)`
						);
						return noop('existing_summary_valid');
					}
				this._log('info',
					`[ContextManager][Compression] EXISTING_SUMMARY_STALE: ` +
					`deltaMsgCount=${deltaMsgCount} (threshold=${compressionConfig.minMessagesToCompress}), ` +
					`deltaTokens=${deltaTokens} (threshold=${deltaTokenThreshold.toFixed(0)}) ` +
					`→ proceeding with re-compression (iterative summary to merge new content)`
				);
				// 增量充足：不设 _lastCompressionTime，让压缩流程继续执行（P3 冷却期
				// 仅在 _lastCompressionTime > 0 时拦截，此处保持 0 让压缩通过）。
				// 压缩成功后由方法末尾统一设置 _lastCompressionTime 触发后续防抖。
				} else {
					// 有摘要但无元数据（旧版本生成的摘要）—— 无法计算增量，
					// 直接允许压缩流程继续（回退到 P4 添加前的行为），生成带元数据的新摘要。
					// 不设冷却期，避免阻止迭代摘要。
					this._log('info',
						`[ContextManager][Compression] Existing summary detected (no embedded meta) — proceeding with compression to generate meta-enriched summary`
					);
				}
			}
		}

		// P3: 冷却期检查。上次压缩后 60 秒内不再次压缩，避免压缩后几条消息又超阈值
		// 导致频繁压缩抖动。仅在已有压缩历史时生效（首次压缩不受限）。
		if (this._lastCompressionTime > 0) {
			const elapsed = Date.now() - this._lastCompressionTime;
			if (elapsed < ContextManager.COMPRESSION_COOLDOWN_MS) {
				return noop(`cooldown (${Math.round((ContextManager.COMPRESSION_COOLDOWN_MS - elapsed) / 1000)}s remaining)`);
			}
		}

		// P2: anti-thrashing 防抖。连续 N 次压缩均"低效"（节省比例 < 阈值）后，
		// 说明已无可压缩空间（如全是受保护的头尾 + 不可再小的摘要），继续压缩只是
		// 反复抖动、空耗 LLM 摘要调用。此时直接 noop，直到真实 usage 再次显著增长
		// （update 真实 token 时由调用方/下次有效压缩自然重置计数）。对齐 Hermes
		// _ineffective_compression_count >= 2。
		//
		// P3 修复：estimatedTokens（char/4 粗估）与 realPromptTokens 可能有 3-4 倍偏差，
		// 导致 savingRatio 虚低 → anti_thrashing 误触发 → 真实 token 持续增长却无法压缩。
		// 修复：当 realPromptTokens 较上次压缩增长 > 25% 时，重置低效计数，允许再次尝试。
		if (this._ineffectiveCompressionCount >= ContextManager.MAX_INEFFECTIVE_COMPRESSIONS) {
			if (hasRealUsage && this._lastCompressRealTokens !== null) {
				const growthRatio = (realPromptTokens! - this._lastCompressRealTokens) / this._lastCompressRealTokens;
				if (growthRatio >= ContextManager.REAL_TOKEN_GROWTH_RESET_THRESHOLD) {
					this._ineffectiveCompressionCount = 0;
					this._log('info',
						`[ContextManager][Compression] ANTI_THRASHING RESET: ` +
						`realTokens grew ${ (growthRatio * 100).toFixed(1)}% ` +
						`(${this._lastCompressRealTokens}→${realPromptTokens}) ` +
						`≥ ${ContextManager.REAL_TOKEN_GROWTH_RESET_THRESHOLD * 100}% → ` +
						`ineffectiveCompressionCount reset to 0, retrying compression`
					);
					// 不 return，继续往下执行压缩
				} else {
					return noop('anti_thrashing');
				}
			} else {
				return noop('anti_thrashing');
			}
		}

		// ── 1. 拆分三段 ──────────────────────────────────────────────
		const systemMessages = messages.filter(m => m.role === 'system');
		const conversation = messages.filter(m => m.role !== 'system');

		// 保护头：前 N 条对话（任务起点）
		const headCount = Math.min(ContextManager.PROTECT_FIRST_N, conversation.length);
		const head = conversation.slice(0, headCount);

		// 保护尾：从尾部按 token 预算回溯
		const tailBudget = effectiveWindow * ContextManager.TAIL_BUDGET_RATIO;
		const tail = this._selectTailByBudget(
			conversation.slice(headCount),
			tailBudget,
			ContextManager.TAIL_MIN_MESSAGES,
			ContextManager.TAIL_MAX_MESSAGES
		);

		// 中间段 = 既不在头也不在尾的旧消息
		const tailStartIndex = conversation.length - tail.length;
		const middle = conversation.slice(headCount, Math.max(headCount, tailStartIndex));

		if (middle.length === 0) {
			// 没有可压缩的中间段（头尾已覆盖全部）→ 不压缩
			this._log('warn',
				`[ContextManager][Compression] nothing_to_compress: ` +
				`conversation=${conversation.length} head=${head.length} tail=${tail.length} ` +
				`→ head+tail 已覆盖全部对话，无中间段可压缩。` +
				`PROTECT_FIRST_N=${ContextManager.PROTECT_FIRST_N} ` +
				`TAIL_BUDGET_RATIO=${ContextManager.TAIL_BUDGET_RATIO} ` +
				`tailBudget=${tailBudget.toFixed(0)} tokens`
			);
			return noop('nothing_to_compress');
		}

		// ── 2. 预剪枝（LLM 前廉价处理）+ 结构化摘要 ──────────────────
		const prunedMiddle = this._prePruneMessages(middle);
		const existingSummary = this._extractExistingSummary(systemMessages);
		const summary = await this._generateStructuredSummary(prunedMiddle, existingSummary);

		// ── 3. 重组：保护头(system) + 摘要 + 保护头(对话) + 保护尾 ──────
		// 先构造不含元数据的摘要消息，待 sanitized + token 计算完成后回填元数据。
		const summaryMessage = {
			role: 'system',
			content: `${ContextManager.SUMMARY_PREFIX}\n\n${summary}`,
		} as ChatMessage;

		const compressedMessages: ChatMessage[] = [
			...systemMessages.filter(m => !this._isSummaryMessage(m) && !this._isInjectedContextMessage(m)),
			summaryMessage,
			...head,
			...tail,
		];

		// ── 保证 agent.systemPrompt 不被截断 ──
		// 系统消息中长度最大的一条是 agent 自身 systemPrompt + chat mode + tools。
		// 压缩后此消息必须完整保留，如长度异常减小则记录警告。
		const sysMsg = compressedMessages.find(m => m.role === 'system' && !this._isSummaryMessage(m));
		if (sysMsg) {
			const origSys = systemMessages.find(m => m.role === 'system' && !this._isSummaryMessage(m));
			if (origSys && sysMsg.content !== origSys.content) {
				this._log('warn',
					`[Compression] System message content changed after compaction! original=${origSys.content.length}chars compressed=${sysMsg.content.length}chars`);
			}
		}

		const sanitized = this._sanitizeToolPairs(compressedMessages);
		const estimatedTokensAfter = this._estimateTokens(sanitized as any);

		// 回填压缩元数据到摘要消息（随消息历史持久化，供窗口重载后增量判断）。
		// summaryMessage 与 sanitized 中的摘要消息是同一对象引用，修改 content 同步生效。
		// 元数据格式为 HTML 注释，不影响 LLM 理解摘要内容。
		const compressionMetaComment = `<!-- saros-compaction: msgCount=${sanitized.length} estTokens=${estimatedTokensAfter} ts=${Date.now()} -->`;
		summaryMessage.content = `${ContextManager.SUMMARY_PREFIX}\n${compressionMetaComment}\n\n${summary}`;

		// P2: anti-thrashing 计数更新。以 token 节省比例衡量本次压缩是否"有效"。
		// 节省 < MIN_EFFECTIVE_SAVING_RATIO（10%）记为一次低效压缩，连续累计；
		// 一旦有一次有效压缩立即清零。达到上限后由上方判定拦截后续压缩。
		const savingRatio = estimatedTokens > 0
			? (estimatedTokens - estimatedTokensAfter) / estimatedTokens
			: 0;
		if (savingRatio < ContextManager.MIN_EFFECTIVE_SAVING_RATIO) {
			this._ineffectiveCompressionCount++;
			this._log('warn',
				`[ContextManager][Compression] LOW-EFFICIENCY: savingRatio=${(savingRatio * 100).toFixed(1)}% ` +
				`< ${ContextManager.MIN_EFFECTIVE_SAVING_RATIO * 100}% → ` +
				`ineffectiveCompressionCount=${this._ineffectiveCompressionCount}/${ContextManager.MAX_INEFFECTIVE_COMPRESSIONS} ` +
				`(tokens: ${estimatedTokens}→${estimatedTokensAfter}, saved=${estimatedTokens - estimatedTokensAfter})`
			);
		} else {
			this._ineffectiveCompressionCount = 0;
			this._log('info',
				`[ContextManager][Compression] EFFECTIVE: savingRatio=${(savingRatio * 100).toFixed(1)}% ` +
				`→ ineffectiveCompressionCount reset to 0`
			);
		}

		// P3: 记录本次压缩时的真实 token 数，用于后续 anti-thrashing 增长重置判定。
		this._lastCompressRealTokens = hasRealUsage ? realPromptTokens! : effectiveTokens;
		this._lastCompressionTime = Date.now();

		// ── Pre-compact memory injection ──────────────────────────────────
		// After compression succeeds, inject relevant memories to preserve context
		// that would otherwise be lost. The callback provides the injected context.
		//
		// P4 缓存优化（2026-07-04）：对齐 agentmemory 的 context 注入位置策略。
		// 注入消息不再放在 finalMessages 最前面（会破坏所有 system prefix cache），
		// 而是放在固定 system 消息之后、摘要消息之前。这样：
		//   [固定 system (Agent Persona/规则)] ← 缓存命中
		//   [注入的记忆上下文]                  ← 缓存断裂点
		//   [摘要 system + head + tail]        ← 新内容
		// Anthropic cache_control 仍标记最后一个 system message（通常是摘要），
		// 固定前缀不受注入影响，KV cache 只在注入位置起失效。
		let finalMessages = sanitized;
		let injectedTokens = 0;
		if (preCompactInject && estimatedTokens > estimatedTokensAfter) {
			try {
				const tokensSaved = estimatedTokens - estimatedTokensAfter;
				const msgForInject = (messages as any[]).map(m => ({
					role: m.role ?? 'unknown',
					content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
					timestamp: Date.now(),
				}));
				const injectResult = preCompactInject({
					agentId: (messages as any[])[0]?.metadata?.['agentId'] ?? 'default',
					sessionId: (messages as any[])[0]?.metadata?.['sessionId'] ?? '',
					messages: msgForInject,
					tokensSaved,
					contextWindow: effectiveWindow,
				});
				if (injectResult?.injectedContext) {
					// P4: Separate fixed system messages (stable prefix) from dynamic messages.
					// Inject the memory context AFTER fixed system, preserving cache prefix.
					const fixedSystem = sanitized.filter(m =>
						m.role === 'system' &&
						!this._isSummaryMessage(m) &&
						!this._isInjectedContextMessage(m)
					);
					const dynamicMessages = sanitized.filter(m =>
						!(m.role === 'system' &&
						  !this._isSummaryMessage(m) &&
						  !this._isInjectedContextMessage(m))
					);
					finalMessages = [
						...fixedSystem,
						{ role: 'system' as const, content: injectResult.injectedContext } as ChatMessage,
						...dynamicMessages,
					];
					injectedTokens = injectResult.totalTokens;
					this._log('info',
						`[ContextManager][Compression] Pre-compact injection: ` +
						`${injectResult.totalTokens} tokens injected from memory`
					);
				}
			} catch (injectError) {
				this._log('warn',
					`[ContextManager][Compression] Pre-compact injection failed: ` +
					`${injectError instanceof Error ? injectError.message : String(injectError)}`
				);
			}
		}

		return {
			originalMessageCount: messages.length,
			compressedMessageCount: finalMessages.length,
			summary,
			compressedMessages: finalMessages,
			metadata: {
				compressionRatio: finalMessages.length / messages.length,
				estimatedTokensBefore: estimatedTokens,
				estimatedTokensAfter,
				tokensSaved: estimatedTokens - estimatedTokensAfter,
				savingRatio,
				ineffectiveCompressionCount: this._ineffectiveCompressionCount,
				headCount: head.length,
				middleCount: middle.length,
				tailCount: tail.length,
				contextWindow: effectiveWindow,
				thresholdTokens,
				iterativeSummary: !!existingSummary,
				preCompactInjectedTokens: injectedTokens,
			},
		};
	}

	/**
	 * 从对话尾部按 token 预算回溯选取消息，硬保底 minMessages 条，
	 * 并强制保留最后一条 user 消息（保证模型知道当前任务）。
	 */
	private _selectTailByBudget(
		candidates: ReadonlyArray<ChatMessage>,
		tokenBudget: number,
		minMessages: number,
		maxMessages: number
	): ChatMessage[] {
		if (candidates.length === 0) {
			return [];
		}
		const tail: ChatMessage[] = [];
		let usedTokens = 0;
		for (let i = candidates.length - 1; i >= 0; i--) {
			const msg = candidates[i];
			const msgTokens = this._estimateTokens([msg] as any);
			const withinBudget = usedTokens + msgTokens <= tokenBudget;
			const belowMin = tail.length < minMessages;
			const belowMax = tail.length < maxMessages;
			// 修复：belowMin 阶段强制保留；之后必须同时满足预算和最大条数
			if (belowMin || (withinBudget && belowMax)) {
				tail.unshift(msg);
				usedTokens += msgTokens;
			} else {
				break;
			}
		}
		// 强制保留最后一条 user 消息（若被预算挤出，则补回）
		const hasUser = tail.some(m => m.role === 'user');
		if (!hasUser) {
			for (let i = candidates.length - 1; i >= 0; i--) {
				if (candidates[i].role === 'user') {
					tail.unshift(candidates[i]);
					break;
				}
			}
		}
		return tail;
	}

	/**
	 * LLM 前预剪枝：旧 tool 结果单行截断、去除超长 tool 参数，
	 * 降低送入摘要模型的 token，同时保持语义可读。不修改原消息对象。
	 */
	private _prePruneMessages(messages: ReadonlyArray<ChatMessage>): ChatMessage[] {
		return messages.map(m => {
			if (m.role === 'tool') {
				const original = m.content || '';
				if (original.length > ContextManager.TOOL_RESULT_TRUNCATE_CHARS) {
					const truncated = original.slice(0, ContextManager.TOOL_RESULT_TRUNCATE_CHARS);
					return {
						...m,
						content: `${truncated}… [工具结果已截断，原长度 ${original.length} 字符]`,
					} as ChatMessage;
				}
			}
			return m;
		});
	}

	/** 判断一条 system 消息是否为之前生成的压缩摘要。 */
	private _isSummaryMessage(m: ChatMessage): boolean {
		return m.role === 'system'
			&& typeof m.content === 'string'
			&& m.content.startsWith(ContextManager.SUMMARY_PREFIX);
	}

	/** 判断一条 system 消息是否为上一轮 PreCompactInjector 注入的保留上下文。
	 *  迭代压缩时此类消息必须剥离，否则每次压缩都会在头部累积一个新的注入块。 */
	private _isInjectedContextMessage(m: ChatMessage): boolean {
		return m.role === 'system'
			&& typeof m.content === 'string'
			&& m.content.startsWith(ContextManager.INJECTED_CONTEXT_PREFIX);
	}

	/** 从既有 system 消息中提取上一轮摘要正文（用于迭代摘要）。
	 *  自动去除嵌入的压缩元数据注释行，只保留摘要正文。 */
	private _extractExistingSummary(systemMessages: ReadonlyArray<ChatMessage>): string {
		const prev = systemMessages.find(m => this._isSummaryMessage(m));
		if (!prev) {
			return '';
		}
		let body = (prev.content || '').slice(ContextManager.SUMMARY_PREFIX.length);
		// 去除嵌入的压缩元数据注释行
		body = body.replace(ContextManager.COMPRESSION_META_PATTERN, '').trim();
		return body;
	}

	/** 从摘要消息中解析压缩元数据（msgCount/estTokens/ts）。
	 *  元数据在压缩时嵌入摘要消息 content，随消息历史持久化，
	 *  窗口重载后用于计算增量判断是否需要重新压缩。 */
	private _extractCompressionMeta(message: ChatMessage): { msgCount: number; estTokens: number; ts: number } | undefined {
		const content = typeof message.content === 'string' ? message.content : '';
		const match = content.match(ContextManager.COMPRESSION_META_PATTERN);
		if (!match) {
			return undefined;
		}
		return {
			msgCount: parseInt(match[1], 10),
			estTokens: parseInt(match[2], 10),
			ts: parseInt(match[3], 10),
		};
	}

	/**
	 * 修复孤立的 tool_call / tool_result 配对：
	 * 若保留的消息中存在引用不到对应 assistant.toolCalls 的 tool 消息，
	 * 或 assistant.toolCalls 找不到后续 tool 结果，均做温和清理避免协议报错。
	 */
	private _sanitizeToolPairs(messages: ChatMessage[]): ChatMessage[] {
		const toolCallIds = new Set<string>();
		for (const m of messages) {
			if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
				for (const tc of m.toolCalls) {
					const id = (tc as { id?: string }).id;
					if (id) {
						toolCallIds.add(id);
					}
				}
			}
		}
		// 丢弃引用不到 assistant.toolCalls 的孤立 tool 消息
		return messages.filter(m => {
			if (m.role === 'tool') {
				const refId = (m as unknown as { toolCallId?: string }).toolCallId;
				if (refId && !toolCallIds.has(refId)) {
					return false;
				}
			}
			return true;
		});
	}

	/**
	 * Get compression statistics
	 * @param contextWindow 模型上下文窗口（token）。省略时回退到硬地板。
	 */
	getCompressionStats(messages: ReadonlyArray<ChatMessage>, contextWindow?: number): {
		estimatedTokens: number;
		messageCount: number;
		needsCompression: boolean;
		compressionRatio?: number;
	} {
		const estimatedTokens = this._estimateTokens(messages as any);
		const messageCount = messages.length;
		const effectiveWindowRaw = Math.max(
			contextWindow ?? ContextManager.MINIMUM_CONTEXT_WINDOW,
			ContextManager.MINIMUM_CONTEXT_WINDOW
		);
		const effectiveWindow = Math.min(effectiveWindowRaw, ContextManager.MAXIMUM_COMPRESSION_WINDOW);
		const needsCompression = estimatedTokens > effectiveWindow * this._config.compressionThreshold;

		return {
			estimatedTokens,
			messageCount,
			needsCompression,
			compressionRatio: needsCompression ? this._config.maxRecentMessages / messageCount : undefined,
		};
	}

	// ─── New API: Context Templates (P2 improvements) ──────────────────────

	/**
	 * Create context from a predefined template
	 */
	async createContextFromTemplate(templateId: string, variables: Record<string, unknown>): Promise<IExecutionContext> {
		// Get template
		const template = this._contextTemplates.get(templateId);
		if (!template) {
			throw new ContextTemplateNotFoundError(templateId);
		}

		// Validate variables
		for (const varDef of template.variables) {
			if (varDef.required && !(varDef.name in variables)) {
				throw new ContextValidationError([`Missing required variable: ${varDef.name}`]);
			}
		}

		// Create context from template snapshot
		const snapshot = { ...template.templateSnapshot };
		
		// Replace placeholders with variables
		const snapshotStr = JSON.stringify(snapshot);
		let replacedStr = snapshotStr;
		for (const [key, value] of Object.entries(variables)) {
			const placeholder = `{{${key}}}`;
			// Escape special regex characters in placeholder
			const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			replacedStr = replacedStr.replace(new RegExp(escapedPlaceholder, 'g'), String(value));
		}

		const replacedSnapshot = JSON.parse(replacedStr) as IContextSnapshot;

		// Build execution context from snapshot
		const executionContext: IExecutionContext = {
			workspace: replacedSnapshot.workspace,
			project: replacedSnapshot.project,
			task: replacedSnapshot.task,
			agent: replacedSnapshot.agent,
			session: replacedSnapshot.session,
			env: this._buildEnvironmentVariables({
				workspace: replacedSnapshot.workspace,
				project: replacedSnapshot.project,
				task: replacedSnapshot.task,
				agent: replacedSnapshot.agent,
				session: replacedSnapshot.session,
			}),
			prompts: this.buildDefaultPrompts({} as any),
			snapshot: replacedSnapshot,
		};

		return executionContext;
	}

	/**
	 * Save current context as a template for future reuse
	 */
	async saveContextAsTemplate(name: string, description: string, context: IExecutionContext): Promise<string> {
		const templateId = this._generateId('template-');
		const now = new Date().toISOString();

		const template: IContextTemplate = {
			templateId,
			name,
			description,
			variables: [], // TODO: Extract variables from context
			templateSnapshot: context.snapshot,
			createdAt: now,
			updatedAt: now,
			metadata: {
				createdBy: 'ContextManager',
			},
		};

		this._contextTemplates.set(templateId, template);

		// Persist to storage if available
		if (this._storage) {
			try {
				const key = `template:${templateId}`;
				await this._storage.write(key, template);
			} catch (error) {
				console.error('[ContextManager] Failed to persist template:', error);
			}
		}

		// Trim old templates if exceeding max
		if (this._config.maxContextTemplates && this._contextTemplates.size > this._config.maxContextTemplates) {
			const oldestKey = this._contextTemplates.keys().next().value;
			if (oldestKey) {
				this._contextTemplates.delete(oldestKey);
			}
		}

		return templateId;
	}

	/**
	 * List all available context templates
	 */
	async listContextTemplates(): Promise<ReadonlyArray<IContextTemplate>> {
		// Try to load from storage first
		if (this._storage) {
			try {
				const keys = await this._storage.list('template:');
				for (const key of keys) {
					const data = await this._storage.read(key);
					if (data) {
						const template = data as IContextTemplate;
						this._contextTemplates.set(template.templateId, template);
					}
				}
			} catch (error) {
				console.error('[ContextManager] Failed to list templates from storage:', error);
			}
		}

		return Array.from(this._contextTemplates.values())
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	// ─── New API: Context Isolation (P2 improvements) ──────────────────────

	/**
	 * Isolate context for sandboxing/security
	 */
	async isolateContext(context: IExecutionContext, config?: Partial<IContextIsolationConfig>): Promise<IIsolatedContext> {
		const isolationConfig: IContextIsolationConfig = {
			isolateWorkspace: true,
			isolateProject: true,
			isolateTask: true,
			isolateAgent: false, // Don't isolate agent by default
			isolateSession: true,
			deepCopy: true,
			...config,
		};

		const isolationId = this._generateId('isolation-');
		
		// Create isolated copy
		let isolatedContext: IExecutionContext;
		if (isolationConfig.deepCopy) {
			isolatedContext = JSON.parse(JSON.stringify(context));
		} else {
			isolatedContext = { ...context };
		}

		// Apply isolation config - create new object with modifications
		// Since IExecutionContext properties are readonly, we need to create a new object
		isolatedContext = {
			workspace: isolationConfig.isolateWorkspace ? isolatedContext.workspace : context.workspace,
			project: isolationConfig.isolateProject ? isolatedContext.project : context.project,
			task: isolationConfig.isolateTask ? isolatedContext.task : context.task,
			agent: isolationConfig.isolateAgent ? isolatedContext.agent : context.agent,
			session: isolationConfig.isolateSession ? isolatedContext.session : context.session,
			env: isolatedContext.env,
			prompts: isolatedContext.prompts,
			snapshot: isolatedContext.snapshot,
		};

		const isolated: IIsolatedContext = {
			isolationId,
			originalContext: context,
			isolatedContext,
			metadata: {
				isolatedAt: new Date().toISOString(),
				config: isolationConfig,
				modifications: [], // Track modifications separately
			},
		};

		this._isolatedContexts.set(isolationId, isolated);

		return isolated;
	}

	/**
	 * Merge isolated context back to original
	 */
	async mergeIsolatedContext(isolatedContext: IIsolatedContext, strategy: 'overwrite' | 'merge' | 'preserve' = 'merge'): Promise<IExecutionContext> {
		const original = isolatedContext.originalContext;
		const isolated = isolatedContext.isolatedContext;

		let merged: IExecutionContext;

		switch (strategy) {
			case 'overwrite':
				// Simply return isolated context
				merged = isolated;
				break;

			case 'preserve':
				// Return original context (discard isolated changes)
				merged = original;
				break;

			case 'merge':
			default:
				// Merge: prefer isolated values, but keep original if isolated is undefined
				merged = {
					workspace: isolated.workspace || original.workspace,
					project: isolated.project || original.project,
					task: isolated.task || original.task,
					agent: isolated.agent || original.agent,
					session: isolated.session || original.session,
					env: { ...original.env, ...isolated.env },
					prompts: { ...original.prompts, ...isolated.prompts },
					snapshot: isolated.snapshot || original.snapshot,
					orchestration: isolated.orchestration || original.orchestration,
				};
				break;
		}

		// Remove from isolated contexts
		this._isolatedContexts.delete(isolatedContext.isolationId);

		return merged;
	}

	// ─── New API: Context Persistence (P2 improvements) ──────────────────────

	/**
	 * Persist context to storage for long-term retention
	 */
	async persistContext(context: IExecutionContext, retention?: IContextRetentionPolicy): Promise<string> {
		const retentionPolicy = retention || this._config.defaultRetentionPolicy || {
			retentionDays: 30,
			maxVersions: 10,
			compressOldVersions: true,
			autoCleanup: 'soft' as const,
		};

		const persistenceId = this._generateId('persist-');
		const now = new Date().toISOString();
		
		const persistenceInfo: IContextPersistenceInfo = {
			persistenceId,
			contextKey: `${context.agent.agentId}:${context.session.sessionId}`,
			persistedAt: now,
			size: JSON.stringify(context).length,
			retention: retentionPolicy,
			expiresAt: retentionPolicy.retentionDays > 0 
				? new Date(Date.now() + retentionPolicy.retentionDays * 24 * 60 * 60 * 1000).toISOString()
				: undefined,
			metadata: {
				persistedBy: 'ContextManager',
			},
		};

		this._persistedContexts.set(persistenceId, persistenceInfo);

		// Persist to storage if available
		if (this._storage) {
			try {
				const key = `persist:${persistenceId}`;
				await this._storage.write(key, {
					context,
					info: persistenceInfo,
				});
			} catch (error) {
				console.error('[ContextManager] Failed to persist context:', error);
			}
		}

		// Trim old persistences if exceeding max
		if (this._config.maxPersistedContexts && this._persistedContexts.size > this._config.maxPersistedContexts) {
			const oldestKey = this._persistedContexts.keys().next().value;
			if (oldestKey) {
				this._persistedContexts.delete(oldestKey);
			}
		}

		return persistenceId;
	}

	/**
	 * Restore context from persistence
	 */
	async restoreContext(persistenceId: string): Promise<IExecutionContext | undefined> {
		// Check cache first
		const info = this._persistedContexts.get(persistenceId);
		if (info) {
			// Load from storage
			if (this._storage) {
				try {
					const key = `persist:${persistenceId}`;
					const data = await this._storage.read(key);
					if (data && typeof data === 'object' && 'context' in data) {
						return (data as any).context as IExecutionContext;
					}
				} catch (error) {
					console.error('[ContextManager] Failed to restore context from storage:', error);
				}
			}
		}

		// Try to load directly from storage
		if (this._storage) {
			try {
				const key = `persist:${persistenceId}`;
				const data = await this._storage.read(key);
				if (data && typeof data === 'object' && 'context' in data) {
					return (data as any).context as IExecutionContext;
				}
			} catch (error) {
				console.error('[ContextManager] Failed to restore context from storage:', error);
			}
		}

		return undefined;
	}

	/**
	 * List all persisted contexts
	 */
	async listPersistedContexts(filter?: IContextPersistenceFilter): Promise<ReadonlyArray<IContextPersistenceInfo>> {
		let persistences = Array.from(this._persistedContexts.values());

		// Apply filters
		if (filter) {
			if (filter.contextKey) {
				persistences = persistences.filter(p => p.contextKey === filter.contextKey);
			}
			if (filter.startDate) {
				persistences = persistences.filter(p => p.persistedAt >= filter.startDate!);
			}
			if (filter.endDate) {
				persistences = persistences.filter(p => p.persistedAt <= filter.endDate!);
			}
			if (filter.minSize !== undefined) {
				persistences = persistences.filter(p => p.size >= filter.minSize!);
			}
			if (filter.maxSize !== undefined) {
				persistences = persistences.filter(p => p.size <= filter.maxSize!);
			}
			if (filter.expired !== undefined) {
				const now = new Date().toISOString();
				persistences = persistences.filter(p => 
					filter.expired 
						? p.expiresAt && p.expiresAt < now
						: !p.expiresAt || p.expiresAt >= now
				);
			}
		}

		// Sort by persistedAt (newest first)
		persistences.sort((a, b) => b.persistedAt.localeCompare(a.persistedAt));

		return persistences;
	}

	// ─── New API: Context Analysis (P2 improvements) ──────────────────────

	/**
	 * Analyze context usage patterns
	 */
	async analyzeContextUsage(context: IExecutionContext): Promise<IContextUsageAnalysis> {
		const analysisId = this._generateId('analysis-');
		const contextKey = `${context.agent.agentId}:${context.session.sessionId}`;
		const now = new Date().toISOString();

		// Analyze token usage
		const contextStr = JSON.stringify(context);
		const totalTokens = Math.ceil(contextStr.length / 4); // Rough estimate
		// IExecutionContext 未携带模型窗口信息，使用硬地板常量作为分析基准。
		const maxTokens = ContextManager.MINIMUM_CONTEXT_WINDOW;
		const usedTokens = totalTokens;
		const availableTokens = maxTokens - usedTokens;

		// Analyze messages
		const messages = context.session.messages || [];
		const userMessages = messages.filter(m => m.role === 'user').length;
		const assistantMessages = messages.filter(m => m.role === 'assistant').length;
		const systemMessages = messages.filter(m => m.role === 'system').length;
		const toolMessages = messages.filter(m => m.role === 'tool').length;

		// Analyze field usage (simplified)
		const fieldUsage = [
			{ field: 'workspace', accessCount: 1, lastAccessed: now },
			{ field: 'project', accessCount: 1, lastAccessed: now },
			{ field: 'task', accessCount: 1, lastAccessed: now },
			{ field: 'agent', accessCount: 1, lastAccessed: now },
			{ field: 'session', accessCount: 1, lastAccessed: now },
		];

		// Generate recommendations
		const recommendations = [];
		if (usedTokens / maxTokens > 0.8) {
			recommendations.push({
				type: 'compress' as const,
				priority: 'high' as const,
				description: 'Context is near token limit, consider compression',
			});
		}
		if (messages.length > 100) {
			recommendations.push({
				type: 'prune' as const,
				priority: 'medium' as const,
				description: 'Large number of messages, consider pruning old messages',
			});
		}

		const analysis: IContextUsageAnalysis = {
			analysisId,
			contextKey,
			analyzedAt: now,
			tokenUsage: {
				totalTokens,
				usedTokens,
				availableTokens,
				usagePercentage: (usedTokens / maxTokens) * 100,
			},
			messageAnalysis: {
				totalMessages: messages.length,
				userMessages,
				assistantMessages,
				systemMessages,
				toolMessages,
			},
			fieldUsage,
			recommendations,
		};

		this._contextAnalyses.set(analysisId, analysis);

		return analysis;
	}

	/**
	 * Get insights from context analysis
	 */
	async getContextInsights(analysisId: string): Promise<IContextInsights> {
		const analysis = this._contextAnalyses.get(analysisId);
		if (!analysis) {
			throw new ContextAnalysisNotFoundError(analysisId);
		}

		const insightId = this._generateId('insight-');
		const now = new Date().toISOString();

		// Generate insights based on analysis
		const insights = [];
		const actions = [];

		// Performance insights
		if (analysis.tokenUsage.usagePercentage > 80) {
			insights.push({
				category: 'performance' as const,
				title: 'High Token Usage',
				description: `Context is using ${analysis.tokenUsage.usagePercentage.toFixed(1)}% of available tokens`,
				impact: 'high' as const,
			});
			actions.push({
				action: 'compress_context',
				description: 'Compress old messages to reduce token usage',
				estimatedImpact: 'Reduce token usage by 30-50%',
			});
		}

		// Usage insights
		if (analysis.messageAnalysis.totalMessages > 100) {
			insights.push({
				category: 'usage' as const,
				title: 'Large Message History',
				description: `Context contains ${analysis.messageAnalysis.totalMessages} messages`,
				impact: 'medium' as const,
			});
		}

		// Optimization insights
		if (analysis.recommendations.length > 0) {
			insights.push({
				category: 'optimization' as const,
				title: 'Optimization Opportunities',
				description: `${analysis.recommendations.length} optimization recommendations available`,
				impact: 'medium' as const,
			});
		}

		const contextInsights: IContextInsights = {
			insightId,
			analysisId,
			generatedAt: now,
			insights,
			actions,
			metadata: {
				generatedBy: 'ContextManager',
			},
		};

		this._contextInsights.set(insightId, contextInsights);

		return contextInsights;
	}

	// ─── Cleanup ──────────────────────────────────────────────────────────────

	/**
	 * Clean up old/unused data to prevent memory leaks
	 * This method should be called periodically or when memory usage is high
	 */
	async cleanup(): Promise<void> {
		// Clean up old snapshots (keep only maxSnapshotHistory)
		if (this._snapshots.size > this._config.maxSnapshotHistory) {
			const snapshots = Array.from(this._snapshots.values())
				.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
			const toRemove = snapshots.slice(0, snapshots.length - this._config.maxSnapshotHistory);
			for (const snapshot of toRemove) {
				this._snapshots.delete(snapshot.snapshotId);
			}
		}

		// Clean up old context versions (keep only recent versions per contextKey)
		for (const [contextKey, versions] of this._contextVersions.entries()) {
			if (versions.length > 10) { // Keep max 10 versions per context
				const sorted = versions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
				const toRemove = sorted.slice(10);
				for (const version of toRemove) {
					const index = versions.indexOf(version);
					if (index > -1) {
						versions.splice(index, 1);
					}
				}
			}
			// Remove empty version arrays
			if (versions.length === 0) {
				this._contextVersions.delete(contextKey);
			}
		}

		// Clean up old event handlers (remove handlers for contexts that no longer exist)
		// This is a simplified cleanup - in production, we should track handler activity
		// For now, we just log a warning if there are too many handlers
		if (this._eventHandlers.size > 100) {
			console.warn(`[ContextManager] Warning: ${this._eventHandlers.size} event handler groups active`);
		}

		// Clean up old isolated contexts (older than 1 hour)
		const oneHourAgo = Date.now() - 60 * 60 * 1000;
		for (const [isolationId, isolated] of this._isolatedContexts.entries()) {
			const isolatedAt = new Date(isolated.metadata.isolatedAt).getTime();
			if (isolatedAt < oneHourAgo) {
				this._isolatedContexts.delete(isolationId);
			}
		}

		// Clean up old persisted contexts (based on retention policy)
		for (const [persistenceId, info] of this._persistedContexts.entries()) {
			if (info.expiresAt && new Date(info.expiresAt) < new Date()) {
				this._persistedContexts.delete(persistenceId);
			}
		}

		// Clean up old context analyses (older than 1 day)
		const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
		for (const [analysisId, analysis] of this._contextAnalyses.entries()) {
			const analyzedAt = new Date(analysis.analyzedAt).getTime();
			if (analyzedAt < oneDayAgo) {
				this._contextAnalyses.delete(analysisId);
			}
		}

		// Clean up old context insights (older than 1 day)
		for (const [insightId, insight] of this._contextInsights.entries()) {
			const generatedAt = new Date(insight.generatedAt).getTime();
			if (generatedAt < oneDayAgo) {
				this._contextInsights.delete(insightId);
			}
		}

		console.log('[ContextManager] Cleanup completed');
	}
}

// ─── Export ─────────────────────────────────────────────────────────────────────

export default ContextManager;

