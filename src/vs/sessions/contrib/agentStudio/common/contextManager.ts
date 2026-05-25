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
	WorkspaceConnection,
} from './contextTypes.js';
import type { Employee, ChatMessage, PlanTask } from './types.js';
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
			snapshotId: `snapshot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
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
						model: employee.model,
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
			dependencies: task.dependencies.length > 0 ? [...task.dependencies] : undefined,
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
}

// ─── Export ─────────────────────────────────────────────────────────────────────

export default ContextManager;
