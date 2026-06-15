# Goal 工作流实现计划

## 需求分析

用户提出了4个需求：

### 1. 评估节点如何保证返回执行json格式
**问题**：如何确保 Judge LLM 返回正确的 JSON 格式？

**方案**：
- **方案 A：Prompt 工程 + 重试机制**（推荐）
  - 在 system prompt 中明确要求返回 JSON 格式，并提供示例
  - 如果解析失败，重新调用 LLM（最多重试 2 次）
  - Fail-open：重试失败则返回 `done=false`
  
- **方案 B：添加 response_format 字段**（需要修改项目）
  - 在 `IModelOptions` 中添加 `responseFormat?: { type: 'json_object' | 'json_schema'; schema?: object }`
  - 需要修改所有 Model Provider 实现（Knot、Direct OpenAI 等）
  - 工作量较大，但更可靠

**推荐**：先实现方案 A（Prompt 工程 + 重试），如果准确率不够再考虑方案 B。

### 2. 不用实现 executeGoalWorkflow，采用任务看板中，选择 goal 工作流来驱动 goal
**问题**：如何让用户通过任务看板选择 goal 工作流来执行？

**方案**：
- **方案 A：Kanban 任务关联工作流**（推荐）
  - Kanban 任务已有 `workflowId` 字段
  - 当任务状态变为 `Running` 时，自动执行关联的工作流
  - 需要修改 `AgentTaskBoardService`，在任务状态变更时触发工作流执行
  
- **方案 B：Goal 工作流作为特殊工作流**
  - 在内置工作流中添加 `isGoalWorkflow: true` 标记
  - Kanban 中创建任务时，可以选择关联 Goal 工作流
  - 执行时，使用 GoalWorkflowService 管理 Goal 状态

**推荐**：方案 A + 方案 B 结合。Kanban 任务关联工作流，Goal 工作流作为特殊工作流类型。

### 3. Judge LLM 调用 - 实现真正的 LLM 调用
**问题**：如何实现真正的 Judge LLM 调用，替换当前的 mock 实现？

**方案**：
- 使用 `IAgentChatService.sendMessage()` 发送 Judge 评估请求
- 或者直接使用 `IModelProvider.chat()` 调用辅助模型
- Judge 模型配置：从设置中读取 `agentStudio.goalJudge.providerId` 和 `agentStudio.goalJudge.modelId`
- 实现 JSON 格式保证（需求 1）

### 4. Goal 工作流中，支持 goal agent 拆分子 agent
**问题**：如何在 Goal 工作流中支持 goal agent 拆分多个子 agent？

**方案**：
- **方案 A：在工作流中添加 SubAgent 节点**（推荐）
  - 修改 `goal-workflow.json`，在 Judge 评估后添加 SubAgent 节点
  - SubAgent 节点可以调用其他 agent 执行子任务
  - 需要修改工作流执行逻辑，支持 SubAgent 节点
  
- **方案 B：Goal Agent 自动拆解任务**
  - Goal Agent 在执行过程中自动拆解任务，创建子任务
  - 子任务作为新的 Kanban 任务创建
  - 需要修改 GoalWorkflowService，添加任务拆解逻辑

**推荐**：方案 A。在工作流中添加 SubAgent 节点，更灵活且符合工作流设计。

## 实现步骤

### 步骤 1：实现 Judge LLM 调用（需求 3）
1. 修改 `GoalWorkflowService.evaluateGoal()` 方法
2. 添加 Judge LLM 调用逻辑
3. 实现 JSON 格式保证（需求 1 的方案 A）
4. 添加重试机制和错误处理

### 步骤 2：保证 Judge 返回 JSON 格式（需求 1）
1. 设计 Judge Prompt，明确要求返回 JSON
2. 实现 JSON 解析和容错逻辑
3. 添加重试机制（最多 2 次）
4. 实现 Fail-open 策略

### 步骤 3：修改 Goal 工作流，支持 SubAgent 节点（需求 4）
1. 修改 `resources/.agents/builtin-workflows/goal-workflow.json`
2. 在 Judge 评估后添加 SubAgent 节点
3. 添加条件分支：如果需要拆解任务，则执行 SubAgent 节点
4. 修改工作流执行逻辑，支持 SubAgent 节点（如果需要）

### 步骤 4：集成 Kanban，驱动 Goal 工作流执行（需求 2）
1. 修改 `AgentTaskBoardService`，在任务状态变为 `Running` 时触发工作流执行
2. 添加 Goal 工作流特殊标记（`isGoalWorkflow: true`）
3. 修改 Kanban UI，支持选择 Goal 工作流
4. 测试整个流程：创建任务 → 选择 Goal 工作流 → 执行

## 文件清单

### 需要修改的文件
1. `src/vs/sessions/contrib/agentStudio/browser/goalWorkflowService.ts` - 实现 Judge LLM 调用
2. `resources/.agents/builtin-workflows/goal-workflow.json` - 修改工作流，添加 SubAgent 节点
3. `src/vs/sessions/contrib/agentStudio/browser/agentTaskBoardService.ts` - 修改任务状态变更逻辑，触发工作流执行
4. `src/vs/sessions/contrib/agentStudio/common/workflowStorage.ts` - 添加 `isGoalWorkflow` 字段（可选）

### 需要创建的文件
1. （无，所有修改都在现有文件上）

## 风险和建议

### 风险
1. **Judge LLM 调用可能失败**：需要实现重试和容错机制
2. **JSON 解析可能失败**：需要实现容错逻辑，Fail-open 策略
3. **SubAgent 节点可能不支持**：需要确认工作流执行逻辑是否支持 SubAgent 节点
4. **Kanban 集成可能复杂**：需要理解 Kanban 的任务状态变更逻辑

### 建议
1. **先实现 Judge LLM 调用**：这是核心功能，先实现并测试
2. **使用 Mock 测试**：先使用 Mock LLM 测试整个流程，再接入真实 LLM
3. **分步实现**：先实现基本功能，再添加高级功能（如 SubAgent 节点）
4. **充分测试**：每个步骤完成后都要测试，确保功能正常

## 下一步

1. **开始实现步骤 1**：修改 `GoalWorkflowService.evaluateGoal()` 方法，添加 Judge LLM 调用逻辑
2. **实现 JSON 格式保证**：设计 Judge Prompt，实现 JSON 解析和容错逻辑
3. **测试 Judge LLM 调用**：使用 Mock LLM 测试 Judge 评估功能
4. **继续实现其他步骤**：按照实现步骤依次实现

---

**开始实现**：先从步骤 1 开始，修改 `GoalWorkflowService.evaluateGoal()` 方法。
