/*---------------------------------------------------------------------------------------------
 *  Context Management Types
 *  Inspired by Paperclip's multi-level context management system
 *--------------------------------------------------------------------------------------------*/

import type { Employee, ChatMessage, PlanTaskStatus } from './types.js';
import type { AgentType } from '../../../common/agentStudioTypes.js';

// ─── Context Levels (from bottom to top) ───────────────────────────────────────────

/**
 * Workspace Context - Current workspace information
 */
export interface IWorkspaceContext {
	readonly workspaceId: string;
	readonly workspaceName: string;
	readonly workspacePath?: string;
	readonly employees: ReadonlyArray<Employee>;
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
	readonly dependencies?: ReadonlyArray<string>;
	readonly dependents?: ReadonlyArray<string>;
	readonly assigneeId?: string;
	readonly assigneeName?: string;
	readonly result?: string;
	readonly error?: string;
	readonly workMode?: 'auto' | 'review' | 'manual';
	/** Task execution context snapshot */
	readonly executionContext?: IContextSnapshot;
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
};
