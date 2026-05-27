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
import type { Employee, ChatMessage, PlanTask, PlanTaskStatus } from './types.js';
import type { IAgentStudioService } from '../../../common/agentStudioService.js';
import type { ITaskOrchestrationService } from '../../../common/agentStudioService.js';

// ─── Default Configuration ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: IContextManagerConfig = {
	compressionThreshold: 0.5, // 50% threshold
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
				const employee = await this._agentStudioService.getEmployee(agentId);
				if (employee) {
					return {
						agentId: employee.id,
						agentName: employee.name || employee.id,
						agentRole: employee.role || 'worker',
						agentType: employee.agentType,
						model: typeof employee.model === 'string' ? employee.model : (Array.isArray(employee.model) ? employee.model[0] : employee.model?.primary),
						provider: employee.provider,
						skills: employee.skills ? [...employee.skills] : undefined,
						status: employee.status || 'idle',
					};
				}
			} catch (error) {
				console.error('[ContextManager] Failed to get employee:', error);
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
					// Fetch employees in this workspace
					const employees = await this._fetchEmployees(workspace.employees);

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
						employees,
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
			employees: [],
			connections: [],
		};
	}

	/**
	 * Fetch employee objects by IDs
	 */
	private async _fetchEmployees(employeeIds: ReadonlyArray<string>): Promise<Employee[]> {
		if (!this._agentStudioService || !employeeIds || employeeIds.length === 0) {
			return [];
		}

		const employees: Employee[] = [];
		for (const id of employeeIds) {
			try {
				const emp = await this._agentStudioService.getEmployee(id);
				if (emp) {
					employees.push(emp);
				}
			} catch (error) {
				console.error(`[ContextManager] Failed to get employee ${id}:`, error);
			}
		}
		return employees;
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
							activeEmployeeId: session.activeEmployeeId,
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

	private _estimateTokens(messages: ReadonlyArray<IChatMessage>): number {
		const totalChars = messages.reduce((sum, m) => {
			return sum + (m.content?.length || 0) + this._estimateToolCallsTokens(m.toolCalls);
		}, 0);

		return Math.ceil(totalChars / 4);
	}

	private _estimateToolCallsTokens(toolCalls?: unknown[]): number {
		if (!toolCalls || toolCalls.length === 0) {
			return 0;
		}

		const toolCallsText = JSON.stringify(toolCalls);
		return Math.ceil((toolCallsText?.length || 0) / 4);
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

	/**
	 * Compress context to reduce token usage
	 */
	async compressContext(
		messages: ReadonlyArray<ChatMessage>,
		config?: Partial<IContextCompressionConfig>
	): Promise<IContextCompressionResult> {
		const compressionConfig: IContextCompressionConfig = {
			compressionThreshold: this._config.compressionThreshold,
			maxRecentMessages: this._config.maxRecentMessages,
			minMessagesToCompress: this._config.minMessagesToCompress,
			summaryModelId: this._config.summaryModelId,
			...config,
		};

		const estimatedTokens = this._estimateTokens(messages as any);
		const maxTokens = 100000; // Assume 100k tokens as max

		// Check if compression is needed
		if (
			estimatedTokens < maxTokens * compressionConfig.compressionThreshold ||
			messages.length < compressionConfig.minMessagesToCompress
		) {
			// No compression needed
			return {
				originalMessageCount: messages.length,
				compressedMessageCount: messages.length,
				summary: '',
				compressedMessages: [...messages],
				metadata: { compressionRatio: 1.0 },
			};
		}

		// Separate system messages (preserve)
		const systemMessages = messages.filter(m => m.role === 'system');
		const nonSystemMessages = messages.filter(m => m.role !== 'system');

		// Keep recent messages
		const recentMessages = nonSystemMessages.slice(-compressionConfig.maxRecentMessages);
		const oldMessages = nonSystemMessages.slice(0, -compressionConfig.maxRecentMessages);

		if (oldMessages.length === 0) {
			return {
				originalMessageCount: messages.length,
				compressedMessageCount: messages.length,
				summary: '',
				compressedMessages: [...messages],
				metadata: { compressionRatio: 1.0 },
			};
		}

		// Generate summary
		const summary = await this._generateSummary(oldMessages as any);

		// Construct compressed messages
		const compressedMessages: ChatMessage[] = [
			...systemMessages,
			{
				role: 'system',
				content: `Previous conversation summary:\n${summary}`,
			} as ChatMessage,
			...recentMessages,
		];

		return {
			originalMessageCount: messages.length,
			compressedMessageCount: compressedMessages.length,
			summary,
			compressedMessages,
			metadata: {
				compressionRatio: compressedMessages.length / messages.length,
				estimatedTokensBefore: estimatedTokens,
				estimatedTokensAfter: this._estimateTokens(compressedMessages as any),
			},
		};
	}

	/**
	 * Get compression statistics
	 */
	getCompressionStats(messages: ReadonlyArray<ChatMessage>): {
		estimatedTokens: number;
		messageCount: number;
		needsCompression: boolean;
		compressionRatio?: number;
	} {
		const estimatedTokens = this._estimateTokens(messages as any);
		const messageCount = messages.length;
		const maxTokens = 100000; // Assume 100k tokens as max
		const needsCompression = estimatedTokens > maxTokens * this._config.compressionThreshold;

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
		const maxTokens = 100000; // Assume 100k tokens as max
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

