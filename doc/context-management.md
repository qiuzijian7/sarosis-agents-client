# Context Management System

Inspired by Paperclip's multi-level context management, this system provides comprehensive context management for AI agents.

## Overview

The context management system provides:

1. **Multi-level Context** - Workspace → Project → Task → Agent → Session
2. **Context Snapshot** - Persistence and recovery support
3. **Context Passing** - Via environment variables and prompt templates
4. **Continuation Summary** - Cross-session state management
5. **Backward Compatibility** - Old API still works (`compressIfNeeded`, `getContextStats`)

## Architecture

### Context Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                    Workspace Level                         │
│  - Workspace ID, name, path                               │
│  - Employees, connections, layout                         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    Project Level                           │
│  - Project ID, name, description                         │
│  - Dependencies, structure                                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    Task Level                              │
│  - Task ID, title, description, status                   │
│  - Dependencies, result, error                           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    Agent Level                              │
│  - Agent ID, name, role, model                           │
│  - Skills, memory, status                                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    Session Level                           │
│  - Session ID, messages, snapshot                       │
│  - Continuation summary                                   │
└─────────────────────────────────────────────────────────────┘
```

### Key Interfaces

#### `IContextManager`

Main interface for context management.

```typescript
interface IContextManager {
  // Build execution context for agent
  buildExecutionContext(options: {
    agentId: string;
    sessionId?: string;
    taskId?: string;
    workspaceId?: string;
  }): Promise<IExecutionContext>;

  // Context snapshot
  saveSnapshot(snapshot: IContextSnapshot): Promise<void>;
  loadSnapshot(snapshotId: string): Promise<IContextSnapshot | undefined>;
  listSnapshots(options: { ... }): Promise<ReadonlyArray<IContextSnapshot>>;

  // Continuation summary
  getContinuationSummary(agentId: string, sessionId: string): Promise<string | undefined>;
  updateContinuationSummary(agentId: string, sessionId: string, summary: string): Promise<void>;

  // Prompt template rendering
  renderTemplate(template: string, context: IExecutionContext): string;
  buildDefaultPrompts(context: IExecutionContext): IContextPrompts;

  // Old API (deprecated)
  compressIfNeeded(messages: ReadonlyArray<IChatMessage>, maxTokens: number): Promise<ReadonlyArray<IChatMessage>>;
  getContextStats(messages: ReadonlyArray<IChatMessage>, maxTokens: number): { ... };
}
```

#### `IExecutionContext`

Complete context passed to agent during execution.

```typescript
interface IExecutionContext {
  // Core context hierarchy
  workspace: IWorkspaceContext;
  project?: IProjectContext;
  task?: ITaskContext;
  agent: IAgentContext;
  session: ISessionContext;

  // Environment variables
  env: Readonly<Record<string, string>>;

  // Prompt sections
  prompts: IContextPrompts;

  // Raw snapshot
  snapshot: IContextSnapshot;
}
```

#### `IContextSnapshot`

Complete context state at a point in time.

```typescript
interface IContextSnapshot {
  snapshotId: string;
  timestamp: string;
  version: number;

  workspace: IWorkspaceContext;
  project?: IProjectContext;
  task?: ITaskContext;
  agent: IAgentContext;
  session: ISessionContext;

  metadata?: Record<string, unknown>;
}
```

## Usage

### Basic Usage

```typescript
import { ContextManager } from './contextManager.js';
import type { IModelProvider } from './providers.js';

// Create ContextManager
const contextManager = new ContextManager(modelProvider, 'model-id');

// Build execution context
const context = await contextManager.buildExecutionContext({
  agentId: 'agent-1',
  sessionId: 'session-1',
  taskId: 'task-1',
});

// Use context
console.log(context.workspace.workspaceName);
console.log(context.env['TASK_ID']);
console.log(context.prompts.systemPrompt);
```

### Context Snapshot

```typescript
// Save snapshot
await contextManager.saveSnapshot(context.snapshot);

// Load snapshot
const snapshot = await contextManager.loadSnapshot('snapshot-id');

// List snapshots
const snapshots = await contextManager.listSnapshots({
  agentId: 'agent-1',
  limit: 10,
});
```

### Continuation Summary

```typescript
// Get continuation summary
const summary = await contextManager.getContinuationSummary('agent-1', 'session-1');

// Update continuation summary
await contextManager.updateContinuationSummary('agent-1', 'session-1', 'Summary of previous conversation...');
```

### Prompt Template Rendering

```typescript
// Render template with context
const template = 'Hello {{agent.agentName}}, your task is {{task.title}}';
const rendered = contextManager.renderTemplate(template, context);
// Result: "Hello Agent 1, your task is Fix bug"

// Build default prompts
const prompts = contextManager.buildDefaultPrompts(context);
console.log(prompts.systemPrompt);
console.log(prompts.bootstrapPrompt);
console.log(prompts.wakePrompt);
```

### Old API (Backward Compatible)

```typescript
// Compress context if needed
const compressedMessages = await contextManager.compressIfNeeded(messages, 128000);

// Get context stats
const stats = contextManager.getContextStats(messages, 128000);
console.log(stats.estimatedTokens);
console.log(stats.usagePercentage);
```

## Environment Variables

The context manager automatically builds environment variables from context:

| Variable | Description |
|----------|-------------|
| `WORKSPACE_ID` | Workspace ID |
| `WORKSPACE_NAME` | Workspace name |
| `WORKSPACE_PATH` | Workspace path |
| `PROJECT_ID` | Project ID |
| `PROJECT_NAME` | Project name |
| `TASK_ID` | Task ID |
| `TASK_TITLE` | Task title |
| `TASK_STATUS` | Task status |
| `TASK_WORK_MODE` | Task work mode |
| `AGENT_ID` | Agent ID |
| `AGENT_NAME` | Agent name |
| `AGENT_ROLE` | Agent role |
| `AGENT_MODEL` | Agent model |
| `SESSION_ID` | Session ID |

## Prompt Sections

The context manager builds different prompt sections:

| Prompt | Description |
|--------|-------------|
| `systemPrompt` | Agent identity, rules |
| `bootstrapPrompt` | Initialization instructions |
| `wakePrompt` | Task-specific instructions |
| `heartbeatPrompt` | Periodic check-in instructions |
| `continuationPrompt` | Summary of previous context |

## Implementation Status

- [x] Type definitions (`contextTypes.ts`)
- [x] ContextManager implementation (`contextManager.ts`)
- [x] Backward compatible old API
- [ ] Full implementation of `_buildAgentContext` (currently returns placeholder)
- [ ] Full implementation of `_buildWorkspaceContext` (currently returns placeholder)
- [ ] Full implementation of `_buildProjectContext` (currently returns undefined)
- [ ] Full implementation of `_buildTaskContext` (currently returns undefined)
- [ ] Full implementation of `_buildSessionContext` (currently returns placeholder)
- [ ] Persist snapshots to disk (TODO in code)
- [ ] Persist continuation summaries to disk (TODO in code)
- [ ] Integration with AgentStudioService
- [ ] Integration with TaskOrchestrationService
- [ ] Integration with MemoryProvider
- [ ] Tests

## Comparison with Paperclip

| Feature | Paperclip | Saros-Agents-Client |
|---------|---------|----------------------|
| Context Hierarchy | Company → Project → Task → Agent | Workspace → Project → Task → Agent → Session |
| Context Snapshot | ✅ `contextSnapshot` field | ✅ `IContextSnapshot` interface |
| Continuation Summary | ✅ `issueContinuationSummary` | ✅ `getContinuationSummary` / `updateContinuationSummary` |
| Context Passing | Environment variables + Prompt templates + Working directory | Environment variables + Prompt templates |
| Session Recovery | ✅ `agentTaskSessions` table | ✅ `ISessionContext` interface |
| Workspace Management | ✅ `executionWorkspaces` table | ❌ Not implemented yet |
| Skill Injection | ✅ Runtime skill injection | ❌ Not implemented yet |

## Next Steps

1. Implement `_buildAgentContext` to fetch real agent data from AgentStudioService
2. Implement `_buildWorkspaceContext` to fetch real workspace data
3. Implement `_buildProjectContext` to derive project context from workspace
4. Implement `_buildTaskContext` to fetch real task data from TaskOrchestrationService
5. Implement `_buildSessionContext` to fetch real session data
6. Persist snapshots and continuation summaries to disk
7. Add integration tests
8. Update executionProvider.ts to use new API (optional)
