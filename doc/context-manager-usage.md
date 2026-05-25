# ContextManager 使用指南

本文档说明如何使用新的 `ContextManager` API（基于 Paperclip 的上下文管理系统）。

## 1. 创建 ContextManager

```typescript
import { ContextManager } from '../../contrib/agentStudio/common/contextManager.js';
import type { IModelProvider } from '../../contrib/agentStudio/common/providers.js';

// 创建 ContextManager（需要 modelProvider 和 modelId）
const contextManager = new ContextManager(modelProvider, 'model-id', {
    compressionThreshold: 0.5,
    maxRecentMessages: 20,
    minMessagesToCompress: 10,
    maxSnapshotHistory: 10,
    enableContinuationSummary: true,
});
```

## 2. 注入服务依赖

为了使用新的 API（`buildExecutionContext()`），需要注入服务依赖：

```typescript
import type { IAgentStudioService } from '../../common/agentStudioService.js';
import type { ITaskOrchestrationService } from '../../common/agentStudioService.js';

// 注入 AgentStudioService
contextManager.setAgentStudioService(agentStudioService);

// 注入 TaskOrchestrationService
contextManager.setTaskOrchestrationService(taskOrchestrationService);
```

## 3. 使用 buildExecutionContext() 构建执行上下文

```typescript
// 构建执行上下文
const context = await contextManager.buildExecutionContext({
    agentId: 'agent-1',
    sessionId: 'session-1',
    taskId: 'task-1',  // 可选
    workspaceId: 'workspace-1',  // 可选
});

// 访问上下文字段
console.log(context.workspace.workspaceName);
console.log(context.agent.agentName);
console.log(context.task?.title);
console.log(context.session.continuationSummary);

// 访问环境变量
console.log(context.env['WORKSPACE_ID']);
console.log(context.env['AGENT_ID']);

// 访问提示词
console.log(context.prompts.systemPrompt);
console.log(context.prompts.bootstrapPrompt);
```

## 4. 上下文快照

```typescript
// 保存快照（自动在 buildExecutionContext 中创建）
await contextManager.saveSnapshot(context.snapshot);

// 加载快照
const snapshot = await contextManager.loadSnapshot(snapshotId);

// 列出快照
const snapshots = await contextManager.listSnapshots({
    agentId: 'agent-1',
    limit: 10,
});
```

## 5. 续传摘要

```typescript
// 更新续传摘要
await contextManager.updateContinuationSummary('agent-1', 'session-1', 'Summary of previous conversation...');

// 获取续传摘要
const summary = await contextManager.getContinuationSummary('agent-1', 'session-1');
```

## 6. 提示词模板渲染

```typescript
// 渲染模板
const template = 'Hello {{context.agent.agentName}}, workspace: {{context.workspace.workspaceName}}';
const rendered = contextManager.renderTemplate(template, context);
console.log(rendered); // "Hello Agent 1, workspace: My Workspace"

// 构建默认提示词
const prompts = contextManager.buildDefaultPrompts(context);
console.log(prompts.systemPrompt);
console.log(prompts.bootstrapPrompt);
```

## 7. 向后兼容（旧 API）

旧的 API 仍然可用，但已弃用：

```typescript
// 压缩上下文（如果需要）
const compressedMessages = await contextManager.compressIfNeeded(messages, 128000);

// 获取上下文统计
const stats = contextManager.getContextStats(messages, 128000);
console.log(stats.estimatedTokens);
console.log(stats.usagePercentage);
```

## 8. 在 ExecutionProvider 中使用

在 `executionProvider.ts` 中更新以使用新的 `ContextManager`：

```typescript
// 创建 ContextManager
const contextManager = new ContextManager(modelProvider, this._getModelId(slots));

// 注入服务（需要从 slots 或其他地方获取）
contextManager.setAgentStudioService(agentStudioService);
contextManager.setTaskOrchestrationService(taskOrchestrationService);

// 使用新的 API 构建执行上下文
const context = await contextManager.buildExecutionContext({
    agentId: request.agentId,
    sessionId: request.sessionId,
});

// 使用上下文
const systemPrompt = context.prompts.systemPrompt;
const envVars = context.env;
```

## 9. 类型定义

主要的类型定义在 `contextTypes.ts`：

- `IContextManager` - ContextManager 接口
- `IExecutionContext` - 执行上下文（传递给 agent）
- `IWorkspaceContext` - 工作区上下文
- `IProjectContext` - 项目上下文
- `ITaskContext` - 任务上下文
- `IAgentContext` - Agent 上下文
- `ISessionContext` - 会话上下文
- `IContextSnapshot` - 上下文快照

## 10. 注意事项

1. **服务注入是可选的**：如果不注入服务，`buildExecutionContext()` 仍会工作，但返回的是占位符数据。

2. **持久化未实现**：当前 `saveSnapshot()` 和 `updateContinuationSummary()` 只在内存中工作。持久化需要在调用方实现。

3. **Project Context 未实现**：`_buildProjectContext()` 当前返回 `undefined`。可以在未来实现。

4. **性能考虑**：`_buildTaskContext()` 会调用 `listPlans()` 并搜索所有计划。如果计划很多，可能较慢。
