/*---------------------------------------------------------------------------------------------
 *  Context Management Types
 *  Inspired by Paperclip's multi-level context management system
 *--------------------------------------------------------------------------------------------*/

import type { Agent, ChatMessage, PlanTaskStatus } from './types.js';
import type { AgentType } from '../../../common/agentStudioTypes.js';

// ─── Context Levels (from bottom to top) ───────────────────────────────────────────

/**
 * Workspace Context - Current workspace information
 */
export interface IWorkspaceContext {
	readonly workspaceId: string;
	readonly workspaceName: string;
	readonly workspacePath?: string;
	readonly agents: ReadonlyArray<Agent>;
	readonly connections: ReadonlyArray<WorkspaceConnection>;
	readonly layout?: WorkspaceLayout;
	/** Root/Fork management info */
	readonly rootInfo?: WorkspaceRootInfo;
}

/**
 * Project Context - Project-level settings and structure
 */
export interface IProjectContext {
	readonly projectId: string;
	readonly projectName: string;
	readonly description?: string;
	readonly rootInfo?: WorkspaceRootInfo;
	readonly settings?: Record<string, unknown>;
	/** Project dependencies */
	readonly dependencies?: ReadonlyArray<ProjectDependency>;
	/** Project structure (files, directories) */
	readonly structure?: ProjectStructure;
}

/**
 * Task Context - Current task information
 */
export interface ITaskContext {
	readonly taskId: string;
	readonly title: string;
	readonly description?: string;
	readonly status: PlanTaskStatus;
	readonly priority?: 'low' | 'medium' | 'high' | 'critical';
	/** Detailed dependency information */
	readonly dependencies?: ReadonlyArray<{
		readonly taskId: string;
		readonly status: PlanTaskStatus;
		readonly assigneeId?: string;
		readonly assigneeName?: string;
	}>;
	/** Tasks that depend on this task */
	readonly dependents?: ReadonlyArray<{
		readonly taskId: string;
		readonly status: PlanTaskStatus;
		readonly assigneeId?: string;
		readonly assigneeName?: string;
	}>;
	readonly assigneeId?: string;
	readonly assigneeName?: string;
	readonly result?: string;
	readonly error?: string;
	readonly workMode?: 'auto' | 'review' | 'manual';
	/** Task execution context snapshot */
	readonly executionContext?: IContextSnapshot;
	/** Collaboration group ID (for multi-agent collaboration) */
	readonly collaborationGroup?: string;
	/** Task start time */
	readonly startTime?: string;
	/** Task end time */
	readonly endTime?: string;
	/** Retry count */
	readonly retryCount?: number;
}

/**
 * Agent Context - Agent configuration and state
 */
export interface IAgentContext {
	readonly agentId: string;
	readonly agentName: string;
	readonly agentRole: string;
	readonly agentType?: AgentType;
	readonly model?: string;
	readonly provider?: string;
	readonly skills?: ReadonlyArray<string>;
	readonly config?: Record<string, unknown>;
	/** Agent's memory */
	readonly memory?: IAgentMemory;
	/** Agent's current status */
	readonly status: 'idle' | 'working' | 'thinking' | 'error' | 'offline';
	/** Agent's current task ID (if assigned) */
	readonly currentTaskId?: string;
	/** Agent's performance metrics */
	readonly metrics?: {
		readonly tasksCompleted: number;
		readonly tasksFailed: number;
		readonly averageResponseTime: number;
	};
}

/**
 * Shared Context - Context shared across multiple agents in orchestration
 */
export interface ISharedContext {
	readonly orchestrationId: string;
	readonly orchestrationGoal: string;
	readonly orchestrationStatus: 'planning' | 'executing' | 'completed' | 'failed';
	/** All active agents in this orchestration */
	readonly activeAgents: ReadonlyArray<IAgentContext>;
	/** All tasks in this orchestration */
	readonly allTasks: ReadonlyArray<ITaskContext>;
	/** Global state shared across agents */
	readonly globalState: Record<string, unknown>;
	/** Orchestration start time */
	readonly startTime: string;
	/** Orchestration metadata */
	readonly metadata?: Record<string, unknown>;
}

/**
 * Orchestration Context - Context for the entire orchestration
 */
export interface IOrchestrationContext {
	readonly orchestrationId: string;
	readonly orchestrationGoal: string;
	readonly orchestrationStatus: 'planning' | 'executing' | 'completed' | 'failed';
	/** Global progress */
	readonly globalProgress: {
		readonly totalTasks: number;
		readonly completedTasks: number;
		readonly failedTasks: number;
		readonly inProgressTasks: number;
	};
	/** All agents in this orchestration */
	readonly agents: ReadonlyArray<IAgentContext>;
	/** All tasks in this orchestration */
	readonly tasks: ReadonlyArray<ITaskContext>;
	/** Orchestration start time */
	readonly startTime: string;
	/** Orchestration end time (if completed) */
	readonly endTime?: string;
	/** Orchestration metadata */
	readonly metadata?: Record<string, unknown>;
}

/**
 * Context Handoff - Context passed from one agent to another
 */
export interface IContextHandoff {
	readonly fromAgentId: string;
	readonly fromAgentName: string;
	readonly toAgentId: string;
	readonly toAgentName: string;
	readonly taskId: string;
	readonly contextSnapshot: IContextSnapshot;
	readonly handoffReason: string;
	readonly timestamp: string;
	/** Handoff metadata */
	readonly metadata?: Record<string, unknown>;
}

/**
 * Context Version - Version information for a context
 */
export interface IContextVersion {
	readonly versionId: string;
	readonly contextKey: string;
	readonly snapshotId: string;
	readonly timestamp: string;
	readonly parentVersionId?: string;
	readonly metadata?: Record<string, unknown>;
}

/**
 * Context Event - Event emitted when context changes
 */
export interface IContextEvent {
	readonly eventId: string;
	readonly eventType: 'context_created' | 'context_updated' | 'context_deleted' | 'snapshot_created' | 'version_created';
	readonly contextKey: string;
	readonly timestamp: string;
	readonly data?: unknown;
	readonly metadata?: Record<string, unknown>;
}

/**
 * Context Event Handler - Handler for context events
 */
export type IContextEventHandler = (event: IContextEvent) => void | Promise<void>;

/**
 * Context Compression Config - Configuration for context compression
 */
export interface IContextCompressionConfig {
	/** Compression threshold (0-1, percentage of maxTokens) */
	readonly compressionThreshold: number;
	/** Maximum recent messages to keep after compression */
	readonly maxRecentMessages: number;
	/** Minimum messages before compression kicks in */
	readonly minMessagesToCompress: number;
	/** Model to use for summary generation */
	readonly summaryModelId?: string;
}

/**
 * Context Compression Result - Result of context compression
 */
export interface IContextCompressionResult {
	readonly originalMessageCount: number;
	readonly compressedMessageCount: number;
	readonly summary: string;
	readonly compressedMessages: ReadonlyArray<ChatMessage>;
	readonly metadata?: Record<string, unknown>;
}

/**
 * Session Context - Chat session information
 */
export interface ISessionContext {
	readonly sessionId: string;
	readonly messages: ReadonlyArray<ChatMessage>;
	/** Context snapshot for recovery */
	readonly contextSnapshot?: IContextSnapshot;
	/** Continuation summary for cross-session state */
	readonly continuationSummary?: string;
	/** Session metadata */
	readonly metadata?: Record<string, unknown>;
}

// ─── Context Snapshot ─────────────────────────────────────────────────────────────

/**
 * Context Snapshot - Complete context state at a point in time
 * Used for persistence, recovery, and debugging
 */
export interface IContextSnapshot {
	readonly snapshotId: string;
	readonly timestamp: string;
	readonly version: number;

	/** Context hierarchy */
	readonly workspace: IWorkspaceContext;
	readonly project?: IProjectContext;
	readonly task?: ITaskContext;
	readonly agent: IAgentContext;
	readonly session: ISessionContext;

	/** Additional metadata */
	readonly metadata?: Record<string, unknown>;
}

// ─── Execution Context (passed to agent) ──────────────────────────────────────────

/**
 * Execution Context - Complete context passed to agent during execution
 * This is the main interface that agents use to access context
 */
export interface IExecutionContext {
	/** Core context hierarchy */
	readonly workspace: IWorkspaceContext;
	readonly project?: IProjectContext;
	readonly task?: ITaskContext;
	readonly agent: IAgentContext;
	readonly session: ISessionContext;

	/** Environment variables derived from context */
	readonly env: Readonly<Record<string, string>>;

	/** Prompt sections for agent */
	readonly prompts: IContextPrompts;

	/** Raw context snapshot (for advanced use cases) */
	readonly snapshot: IContextSnapshot;

	/** Orchestration context (if this agent is part of an orchestration) */
	readonly orchestration?: IOrchestrationContext;
}

/**
 * Context Prompts - Different prompt sections for agent
 */
export interface IContextPrompts {
	/** System prompt (agent identity, rules) */
	readonly systemPrompt?: string;
	/** Bootstrap prompt (initialization instructions) */
	readonly bootstrapPrompt?: string;
	/** Wake prompt (task-specific instructions) */
	readonly wakePrompt?: string;
	/** Heartbeat prompt (periodic check-in instructions) */
	readonly heartbeatPrompt?: string;
	/** Continuation prompt (summary of previous context) */
	readonly continuationPrompt?: string;
}

// ─── Supporting Types ────────────────────────────────────────────────────────────

/**
 * Workspace Connection (simplified from Connection)
 */
export interface WorkspaceConnection {
	readonly id: string;
	readonly sourceId: string;
	readonly targetId: string;
	readonly type: string;
	readonly label?: string;
}

/**
 * Workspace Layout
 */
export interface WorkspaceLayout {
	readonly nodes: ReadonlyArray<WorkspaceNode>;
	readonly edges: ReadonlyArray<WorkspaceEdge>;
	readonly viewport?: { x: number; y: number; zoom: number };
}

export interface WorkspaceNode {
	readonly id: string;
	readonly type: string;
	readonly position: { x: number; y: number };
	readonly data: Record<string, unknown>;
}

export interface WorkspaceEdge {
	readonly id: string;
	readonly source: string;
	readonly target: string;
	readonly type?: string;
	readonly data?: Record<string, unknown>;
}

/**
 * Workspace Root Info
 */
export interface WorkspaceRootInfo {
	readonly isRoot: boolean;
	readonly rootWorkspaceId?: string;
	readonly forkLevel: number;
	readonly parentWorkspaceId?: string;
	readonly childWorkspaceIds?: ReadonlyArray<string>;
}

/**
 * Project Dependency
 */
export interface ProjectDependency {
	readonly name: string;
	readonly version?: string;
	readonly type: 'npm' | 'pip' | 'cargo' | 'maven' | 'other';
}

/**
 * Project Structure - File/directory tree
 */
export interface ProjectStructure {
	readonly rootPath: string;
	readonly files: ReadonlyArray<ProjectFile>;
	readonly directories: ReadonlyArray<ProjectDirectory>;
}

export interface ProjectFile {
	readonly path: string;
	readonly name: string;
	readonly size?: number;
	readonly lastModified?: string;
	readonly language?: string;
}

export interface ProjectDirectory {
	readonly path: string;
	readonly name: string;
	readonly children?: ReadonlyArray<ProjectFile | ProjectDirectory>;
}

/**
 * Agent Memory
 */
export interface IAgentMemory {
	readonly shortTerm: ReadonlyArray<MemoryEntry>;
	readonly longTerm: ReadonlyArray<MemoryEntry>;
	readonly summary?: string;
}

export interface MemoryEntry {
	readonly id: string;
	readonly type: 'short_term' | 'long_term';
	readonly content: string;
	readonly timestamp: string;
	readonly metadata?: Record<string, unknown>;
}

// ─── Context Manager Interface ────────────────────────────────────────────────────

/**
 * Context Manager Interface
 * Provides comprehensive context management inspired by Paperclip
 */
export interface IContextManager {

	// === Context Building ===

	/**
	 * Build execution context for agent
	 * This is the main method to get complete context for agent execution
	 */
	buildExecutionContext(options: {
		agentId: string;
		sessionId?: string;
		taskId?: string;
		workspaceId?: string;
	}): Promise<IExecutionContext>;

	// === Context Snapshot ===

	/**
	 * Save context snapshot
	 * Persists current context state for recovery/debugging
	 */
	saveSnapshot(snapshot: IContextSnapshot): Promise<void>;

	/**
	 * Load context snapshot by ID
	 */
	loadSnapshot(snapshotId: string): Promise<IContextSnapshot | undefined>;

	/**
	 * List all snapshots for an agent/session
	 */
	listSnapshots(options: {
		agentId?: string;
		sessionId?: string;
		limit?: number;
	}): Promise<ReadonlyArray<IContextSnapshot>>;

	// === Continuation Summary ===

	/**
	 * Get continuation summary for cross-session state
	 */
	getContinuationSummary(agentId: string, sessionId: string): Promise<string | undefined>;

	/**
	 * Update continuation summary
	 */
	updateContinuationSummary(agentId: string, sessionId: string, summary: string): Promise<void>;

	// === Prompt Template Rendering ===

	/**
	 * Render prompt template with context
	 * Template can use {{context.field}} syntax to reference context fields
	 */
	renderTemplate(template: string, context: IExecutionContext): string;

	/**
	 * Build default prompts from context
	 */
	buildDefaultPrompts(context: IExecutionContext): IContextPrompts;

	// === Orchestration Support (new for multi-agent) ===

	/**
	 * Build orchestration context for multi-agent scenarios
	 * This provides a global view of the entire orchestration
	 */
	buildOrchestrationContext(options: {
		orchestrationId: string;
		agentIds?: ReadonlyArray<string>;
		taskIds?: ReadonlyArray<string>;
	}): Promise<IOrchestrationContext>;

	/**
	 * Handoff context from one agent to another
	 * Used when transferring task ownership between agents
	 */
	handoffContext(options: {
		fromAgentId: string;
		toAgentId: string;
		taskId: string;
		reason: string;
	}): Promise<IContextHandoff>;

	/**
	 * Get shared context for an orchestration
	 * Returns context shared across all agents in the orchestration
	 */
	getSharedContext(orchestrationId: string): Promise<ISharedContext | undefined>;

	/**
	 * Update shared context for an orchestration
	 */
	updateSharedContext(orchestrationId: string, context: ISharedContext): Promise<void>;

	// === Context Validation & Diffing (P1 improvements) ===

	/**
	 * Validate context integrity before passing to agents
	 * @returns Validation result with errors if any
	 */
	validateContext(context: IExecutionContext): { valid: boolean; errors: string[] };

	/**
	 * Compare two context snapshots and return the differences
	 * Useful for tracking context changes over time
	 */
	diffContexts(snapshot1: IContextSnapshot, snapshot2: IContextSnapshot): IContextDiff;

	// === Context Versioning (P1 improvements) ===

	/**
	 * Get all versions for a context
	 * @param contextKey Unique key identifying the context (e.g., "agentId:sessionId")
	 */
	getContextVersions(contextKey: string): Promise<ReadonlyArray<IContextVersion>>;

	/**
	 * Rollback context to a previous version
	 * @param versionId The version ID to rollback to
	 * @returns The snapshot at that version
	 */
	rollbackContext(versionId: string): Promise<IContextSnapshot>;

	// === Context Events (P1 improvements) ===

	/**
	 * Subscribe to context events
	 * @param contextKey Unique key identifying the context (e.g., "agentId:sessionId")
	 * @param handler Event handler function
	 * @returns Unsubscribe function
	 */
	subscribeToContextEvents(contextKey: string, handler: IContextEventHandler): () => void;

	/**
	 * Emit a context event
	 * @param event The event to emit
	 */
	emitContextEvent(event: IContextEvent): Promise<void>;

	// === Context Compression (P1 improvements) ===

	/**
	 * Compress context to reduce token usage
	 * @param messages Messages to compress
	 * @param config Compression configuration
	 * @param contextWindow 模型上下文窗口大小（token），用于计算压缩阈值
	 * @param realPromptTokens 上一轮 LLM 响应回传的真实 prompt token（provider usage，含 cache）。
	 *                         P1：触发判定优先采用真实值，>0 时生效，缺省退回粗估。
	 * @returns Compression result with compressed messages
	 */
	compressContext(
		messages: ReadonlyArray<ChatMessage>,
		config?: Partial<IContextCompressionConfig>,
		contextWindow?: number,
		realPromptTokens?: number
	): Promise<IContextCompressionResult>;

	/**
	 * Get compression statistics
	 * @param messages Messages to analyze
	 * @returns Statistics about compression needs
	 */
	getCompressionStats(messages: ReadonlyArray<ChatMessage>): {
		estimatedTokens: number;
		messageCount: number;
		needsCompression: boolean;
		compressionRatio?: number;
	};

	// === Context Templates (P2 improvements) ===

	/**
	 * Create context from a predefined template
	 * @param templateId The template ID to use
	 * @param variables Variables to fill in the template
	 * @returns The created execution context
	 */
	createContextFromTemplate(templateId: string, variables: Record<string, unknown>): Promise<IExecutionContext>;

	/**
	 * Save current context as a template for future reuse
	 * @param name Template name
	 * @param description Template description
	 * @param context The context to save as template
	 * @returns The created template ID
	 */
	saveContextAsTemplate(name: string, description: string, context: IExecutionContext): Promise<string>;

	/**
	 * List all available context templates
	 * @returns Array of context templates
	 */
	listContextTemplates(): Promise<ReadonlyArray<IContextTemplate>>;

	// === Context Isolation (P2 improvements) ===

	/**
	 * Isolate context for sandboxing/security
	 * Creates an isolated copy of context that can be modified without affecting original
	 * @param context The context to isolate
	 * @param config Isolation configuration
	 * @returns Isolated context with metadata
	 */
	isolateContext(context: IExecutionContext, config?: Partial<IContextIsolationConfig>): Promise<IIsolatedContext>;

	/**
	 * Merge isolated context back to original
	 * @param isolatedContext The isolated context to merge
	 * @param strategy Merge strategy
	 * @returns Merged context
	 */
	mergeIsolatedContext(isolatedContext: IIsolatedContext, strategy?: 'overwrite' | 'merge' | 'preserve'): Promise<IExecutionContext>;

	// === Context Persistence (P2 improvements) ===

	/**
	 * Persist context to storage for long-term retention
	 * @param context The context to persist
	 * @param retention Retention policy
	 * @returns Persistence ID
	 */
	persistContext(context: IExecutionContext, retention?: IContextRetentionPolicy): Promise<string>;

	/**
	 * Restore context from persistence
	 * @param persistenceId The persistence ID
	 * @returns The restored context
	 */
	restoreContext(persistenceId: string): Promise<IExecutionContext | undefined>;

	/**
	 * List all persisted contexts
	 * @param filter Optional filter criteria
	 * @returns Array of persistence info
	 */
	listPersistedContexts(filter?: IContextPersistenceFilter): Promise<ReadonlyArray<IContextPersistenceInfo>>;

	// === Context Analysis (P2 improvements) ===

	/**
	 * Analyze context usage patterns
	 * @param context The context to analyze
	 * @returns Usage analysis results
	 */
	analyzeContextUsage(context: IExecutionContext): Promise<IContextUsageAnalysis>;

	/**
	 * Get insights from context analysis
	 * @param analysisId The analysis ID from analyzeContextUsage
	 * @returns Insights and recommendations
	 */
	getContextInsights(analysisId: string): Promise<IContextInsights>;

	// === Old API (backward compatible) ===

	/**
	 * OLD API: Check and compress context if needed
	 * @deprecated Use buildExecutionContext() for new code
	 */
	compressIfNeeded(messages: ReadonlyArray<ChatMessage>, maxTokens: number): Promise<ReadonlyArray<ChatMessage>>;

	/**
	 * OLD API: Get context statistics
	 * @deprecated Use buildExecutionContext() for new code
	 */
	getContextStats(messages: ReadonlyArray<ChatMessage>, maxTokens: number): {
		estimatedTokens: number;
		usagePercentage: number;
		messageCount: number;
		needsCompression: boolean;
	};
}

// ─── P2 Improvement Interfaces ─────────────────────────────────────────────────

/**
 * Context Template - Predefined context template for reuse
 */
export interface IContextTemplate {
	readonly templateId: string;
	readonly name: string;
	readonly description: string;
	/** Template variables schema */
	readonly variables: ReadonlyArray<{
		readonly name: string;
		readonly type: 'string' | 'number' | 'boolean' | 'object';
		readonly required: boolean;
		readonly defaultValue?: unknown;
	}>;
	/** Template context snapshot (with placeholders) */
	readonly templateSnapshot: IContextSnapshot;
	/** Created timestamp */
	readonly createdAt: string;
	/** Updated timestamp */
	readonly updatedAt: string;
	/** Metadata */
	readonly metadata?: Record<string, unknown>;
}

/**
 * Context Isolation Config - Configuration for context isolation
 */
export interface IContextIsolationConfig {
	/** Whether to isolate workspace context */
	readonly isolateWorkspace: boolean;
	/** Whether to isolate project context */
	readonly isolateProject: boolean;
	/** Whether to isolate task context */
	readonly isolateTask: boolean;
	/** Whether to isolate agent context */
	readonly isolateAgent: boolean;
	/** Whether to isolate session context */
	readonly isolateSession: boolean;
	/** Whether to create deep copy (true) or shallow copy (false) */
	readonly deepCopy: boolean;
}

/**
 * Isolated Context - Context that has been isolated for sandboxing
 */
export interface IIsolatedContext {
	readonly isolationId: string;
	readonly originalContext: IExecutionContext;
	readonly isolatedContext: IExecutionContext;
	/** Isolation metadata */
	readonly metadata: {
		readonly isolatedAt: string;
		readonly config: IContextIsolationConfig;
		readonly modifications: ReadonlyArray<{
			readonly path: string;
			readonly oldValue: unknown;
			readonly newValue: unknown;
		}>;
	};
}

/**
 * Context Retention Policy - Policy for retaining persisted contexts
 */
export interface IContextRetentionPolicy {
	/** Retention duration in days (0 = permanent) */
	readonly retentionDays: number;
	/** Maximum number of versions to keep (0 = unlimited) */
	readonly maxVersions: number;
	/** Whether to compress old versions */
	readonly compressOldVersions: boolean;
	/** Auto-cleanup policy */
	readonly autoCleanup: 'none' | 'soft' | 'hard';
}

/**
 * Context Persistence Info - Information about a persisted context
 */
export interface IContextPersistenceInfo {
	readonly persistenceId: string;
	readonly contextKey: string;
	readonly persistedAt: string;
	readonly size: number;
	/** Retention policy */
	readonly retention: IContextRetentionPolicy;
	/** Expiration date (if applicable) */
	readonly expiresAt?: string;
	/** Metadata */
	readonly metadata?: Record<string, unknown>;
}

/**
 * Context Persistence Filter - Filter for listing persisted contexts
 */
export interface IContextPersistenceFilter {
	/** Filter by context key */
	readonly contextKey?: string;
	/** Filter by date range */
	readonly startDate?: string;
	readonly endDate?: string;
	/** Filter by size range */
	readonly minSize?: number;
	readonly maxSize?: number;
	/** Filter by expiration status */
	readonly expired?: boolean;
}

/**
 * Context Usage Analysis - Analysis of context usage patterns
 */
export interface IContextUsageAnalysis {
	readonly analysisId: string;
	readonly contextKey: string;
	readonly analyzedAt: string;
	/** Token usage analysis */
	readonly tokenUsage: {
		readonly totalTokens: number;
		readonly usedTokens: number;
		readonly availableTokens: number;
		readonly usagePercentage: number;
	};
	/** Message analysis */
	readonly messageAnalysis: {
		readonly totalMessages: number;
		readonly userMessages: number;
		readonly assistantMessages: number;
		readonly systemMessages: number;
		readonly toolMessages: number;
	};
	/** Context field usage */
	readonly fieldUsage: ReadonlyArray<{
		readonly field: string;
		readonly accessCount: number;
		readonly lastAccessed: string;
	}>;
	/** Recommendations */
	readonly recommendations: ReadonlyArray<{
		readonly type: 'optimize' | 'compress' | 'prune' | 'archive';
		readonly priority: 'low' | 'medium' | 'high';
		readonly description: string;
	}>;
}

/**
 * Context Insights - Insights derived from context analysis
 */
export interface IContextInsights {
	readonly insightId: string;
	readonly analysisId: string;
	readonly generatedAt: string;
	/** Key insights */
	readonly insights: ReadonlyArray<{
		readonly category: 'performance' | 'usage' | 'optimization' | 'security';
		readonly title: string;
		readonly description: string;
		readonly impact: 'low' | 'medium' | 'high';
	}>;
	/** Actionable recommendations */
	readonly actions: ReadonlyArray<{
		readonly action: string;
		readonly description: string;
		readonly estimatedImpact: string;
	}>;
	/** Metadata */
	readonly metadata?: Record<string, unknown>;
}

// ─── Context Manager Configuration ───────────────────────────────────────────────

/**
 * Context Manager Configuration
 */
export interface IContextManagerConfig {
	/** Compression threshold (0-1, percentage of maxTokens) */
	readonly compressionThreshold: number;
	/** Maximum recent messages to keep after compression */
	readonly maxRecentMessages: number;
	/** Minimum messages before compression kicks in */
	readonly minMessagesToCompress: number;
	/** Maximum context snapshot history to keep */
	readonly maxSnapshotHistory: number;
	/** Whether to enable continuation summary */
	readonly enableContinuationSummary: boolean;
	/** Model to use for summary generation */
	readonly summaryModelId?: string;
	/** Maximum number of context templates to keep */
	readonly maxContextTemplates?: number;
	/** Maximum number of persisted contexts to keep */
	readonly maxPersistedContexts?: number;
	/** Default retention policy for persisted contexts */
	readonly defaultRetentionPolicy?: IContextRetentionPolicy;
}

// ─── Context Storage Interface ─────────────────────────────────────────────────

/**
 * Context Storage Interface
 * Used by ContextManager for persisting snapshots and summaries
 * Implementations can use VS Code storage, file system, or other storage backends
 */
export interface IContextStorage {
	/**
	 * Write data to storage
	 * @param key Unique key for the data
	 * @param data JSON-serializable data
	 */
	write(key: string, data: unknown): Promise<void>;

	/**
	 * Read data from storage
	 * @param key Unique key for the data
	 * @returns Parsed data or undefined if not found
	 */
	read(key: string): Promise<unknown | undefined>;

	/**
	 * Delete data from storage
	 * @param key Unique key for the data
	 */
	delete(key: string): Promise<void>;

	/**
	 * List all keys with a given prefix
	 * @param prefix Key prefix to filter
	 * @returns Array of matching keys
	 */
	list(prefix: string): Promise<string[]>;
}

// ─── Default Context Manager Configuration ──────────────────────────────────────

/**
 * Default context manager configuration
 */
export const DEFAULT_CONTEXT_MANAGER_CONFIG: IContextManagerConfig = {
	compressionThreshold: 0.8,
	maxRecentMessages: 20,
	minMessagesToCompress: 10,
	maxSnapshotHistory: 10,
	enableContinuationSummary: true,
	maxContextTemplates: 50,
	maxPersistedContexts: 100,
	defaultRetentionPolicy: {
		retentionDays: 30,
		maxVersions: 10,
		compressOldVersions: true,
		autoCleanup: 'soft',
	},
};

// ─── Context Error Classes ─────────────────────────────────────────────────

/**
 * Base error class for context-related errors
 */
export class ContextError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ContextError';
	}
}

/**
 * Error thrown when a context version is not found
 */
export class ContextVersionNotFoundError extends ContextError {
	constructor(versionId: string) {
		super(`Context version ${versionId} not found`);
		this.name = 'ContextVersionNotFoundError';
	}
}

/**
 * Error thrown when a context snapshot is not found
 */
export class ContextSnapshotNotFoundError extends ContextError {
	constructor(snapshotId: string) {
		super(`Context snapshot ${snapshotId} not found`);
		this.name = 'ContextSnapshotNotFoundError';
	}
}

/**
 * Error thrown when a context analysis is not found
 */
export class ContextAnalysisNotFoundError extends ContextError {
	constructor(analysisId: string) {
		super(`Context analysis ${analysisId} not found`);
		this.name = 'ContextAnalysisNotFoundError';
	}
}

/**
 * Error thrown when a context template is not found
 */
export class ContextTemplateNotFoundError extends ContextError {
	constructor(templateId: string) {
		super(`Context template ${templateId} not found`);
		this.name = 'ContextTemplateNotFoundError';
	}
}

/**
 * Error thrown when a context persistence is not found
 */
export class ContextPersistenceNotFoundError extends ContextError {
	constructor(persistenceId: string) {
		super(`Context persistence ${persistenceId} not found`);
		this.name = 'ContextPersistenceNotFoundError';
	}
}

/**
 * Error thrown when context validation fails
 */
export class ContextValidationError extends ContextError {
	constructor(errors: string[]) {
		super(`Context validation failed: ${errors.join(', ')}`);
		this.name = 'ContextValidationError';
		this.errors = errors;
	}

	readonly errors: string[];
}

// ─── Context Diff Types ─────────────────────────────────────────────────

/**
 * Represents a single difference entry between two context snapshots
 */
export interface IContextDiffEntry {
	/** Path to the changed property (e.g., 'workspace', 'project', 'task.status') */
	readonly path: string;
	/** Type of change */
	readonly changeType: 'added' | 'modified' | 'deleted';
	/** Value before change (undefined for 'added') */
	readonly oldValue?: unknown;
	/** Value after change (undefined for 'removed') */
	readonly newValue?: unknown;
}

/**
 * Represents the differences between two context snapshots
 */
export interface IContextDiff {
	/** Snapshot ID of the base context */
	readonly baseSnapshotId: string;
	/** Snapshot ID of the compared context */
	readonly compareSnapshotId: string;
	/** Timestamp of the comparison */
	readonly comparedAt: string;
	/** List of differences */
	readonly differences: ReadonlyArray<IContextDiffEntry>;
	/** Summary of changes */
	readonly summary: {
		readonly added: number;
		readonly removed: number;
		readonly modified: number;
	};
}

