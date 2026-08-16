# 任务完成检测机制对比分析：OpenClaw vs Saros Agents Client

> 本文档分析了 OpenClaw 和 Saros Agents Client (VS Code Copilot) 两个项目中如何判断 Agent 任务是否完成，并进行了详细对比。

---

## 1. 概述

### 1.1 OpenClaw 的任务完成检测

OpenClaw 采用**被动检测**方式：不要求 Agent 显式声明任务完成，而是依赖 LLM 自主决定何时停止，同时通过**工具循环检测（Tool Loop Detection）**机制防止 Agent 陷入无限循环。

**核心思路**：
- LLM 自主决定何时停止生成（输出结束标记或停止调用工具）
- 系统通过循环检测防止 LLM 陷入重复工具调用的死循环
- 当检测到循环时，系统向 LLM 发送警告或强制停止消息

### 1.2 Saros Agents Client 的任务完成检测

Saros Agents Client (VS Code Copilot) 采用**主动声明**方式：要求 Agent 必须调用 `task_complete` 工具来显式声明任务已完成。

**核心思路**：
- Agent 必须通过调用 `task_complete` 工具来声明任务完成
- 如果 Agent 在未调用 `task_complete` 的情况下停止，系统会发送提醒消息（nudge）督促 Agent 继续
- 通过 `ToolCallingLoop` 管理工具调用循环，结合 Hooks 机制控制停止条件

---

## 2. OpenClaw 的任务完成检测机制

### 2.1 工具循环检测（Tool Loop Detection）

**核心文件**：`src/agents/tool-loop-detection.ts`

OpenClaw 实现了一个复杂的工具循环检测系统，用于识别 Agent 是否陷入重复工具调用的死循环。

#### 2.1.1 检测的循环类型

| 循环类型 | 描述 | 触发条件 |
|---------|------|---------|
| `unknown_tool_repeat` | Agent 反复尝试调用不存在的工具 | 连续 10 次尝试未知工具 |
| `known_poll_no_progress` | Agent 反复轮询同一个命令无进展 | 连续 20 次相同轮询调用 |
| `ping_pong` | Agent 在两个工具调用间来回切换无进展 | 连续 20 次交替调用且无进展 |
| `global_circuit_breaker` | 全局断路器：过多重复调用无进展 | 连续 30 次相同调用无进展 |
| `generic_repeat` | 通用重复检测：相同工具调用无进展 | 连续 20 次相同调用无进展 |

#### 2.1.2 检测阈值配置

```typescript
const DEFAULT_LOOP_DETECTION_CONFIG = {
  enabled: false,                      // 默认关闭
  historySize: 30,                    // 保留最近 30 次工具调用历史
  warningThreshold: 10,               // 警告阈值：10 次重复
  unknownToolThreshold: 10,            // 未知工具阈值：10 次
  criticalThreshold: 20,              // 严重阈值：20 次重复
  globalCircuitBreakerThreshold: 30,   // 全局断路器阈值：30 次
  detectors: {
    genericRepeat: true,              // 启用通用重复检测
    knownPollNoProgress: true,         // 启用已知轮询无进展检测
    pingPong: true,                   // 启用乒乓循环检测
  },
};
```

#### 2.1.3 检测逻辑

**核心函数**：`detectToolCallLoop(state, toolName, params, config, scope)`

```typescript
export function detectToolCallLoop(
  state: SessionState,
  toolName: string,
  params: unknown,
  config?: ToolLoopDetectionConfig,
  scope?: ToolLoopDetectionScope,
): LoopDetectionResult {
  // 1. 检查是否反复调用未知工具
  if (unknownToolStreak.count >= resolvedConfig.unknownToolThreshold) {
    return { stuck: true, level: "critical", detector: "unknown_tool_repeat", ... };
  }

  // 2. 检查全局断路器（过多重复无进展）
  if (noProgressStreak >= resolvedConfig.globalCircuitBreakerThreshold) {
    return { stuck: true, level: "critical", detector: "global_circuit_breaker", ... };
  }

  // 3. 检查已知轮询工具无进展（警告级别）
  if (knownPollTool && noProgressStreak >= resolvedConfig.warningThreshold) {
    return { stuck: true, level: "warning", detector: "known_poll_no_progress", ... };
  }

  // 4. 检查已知轮询工具无进展（严重级别）
  if (knownPollTool && noProgressStreak >= resolvedConfig.criticalThreshold) {
    return { stuck: true, level: "critical", detector: "known_poll_no_progress", ... };
  }

  // 5. 检查乒乓循环（警告级别）
  if (pingPong.count >= resolvedConfig.warningThreshold) {
    return { stuck: true, level: "warning", detector: "ping_pong", ... };
  }

  // 6. 检查乒乓循环（严重级别）
  if (pingPong.count >= resolvedConfig.criticalThreshold && pingPong.noProgressEvidence) {
    return { stuck: true, level: "critical", detector: "ping_pong", ... };
  }

  // 7. 检查通用重复（警告级别）
  if (recentCount >= resolvedConfig.warningThreshold) {
    return { stuck: true, level: "warning", detector: "generic_repeat", ... };
  }

  // 8. 检查通用重复（严重级别）
  if (noProgressStreak >= resolvedConfig.criticalThreshold) {
    return { stuck: true, level: "critical", detector: "generic_repeat", ... };
  }

  return { stuck: false };
}
```

#### 2.1.4 循环检测的工作流程

```
┌─────────────────────────────────────────────────────────────────┐
│                   工具调用循环检测流程                         │
├─────────────────────────────────────────────────────────────────┤
│  1. Agent 调用工具                                         │
│     └─▶ recordToolCall() - 记录工具调用到历史                 │
│                                                               │
│  2. 工具执行完成                                             │
│     └─▶ recordToolCallOutcome() - 记录调用结果                │
│                                                               │
│  3. 下一轮循环前检测                                         │
│     └─▶ detectToolCallLoop() - 检测是否陷入循环              │
│                                                               │
│  4. 检测结果处理                                             │
│     ├─▶ stuck: false - 未检测到循环，继续                   │
│     ├─▶ stuck: true, level: "warning" - 发送警告消息       │
│     └─▶ stuck: true, level: "critical" - 强制停止循环     │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 任务状态管理

**核心文件**：`src/tasks/task-executor.ts`, `src/tasks/task-registry.types.ts`

OpenClaw 通过任务注册表（Task Registry）跟踪任务状态。

#### 2.2.1 任务状态枚举

```typescript
type TaskStatus =
  | "queued"      // 已排队，等待执行
  | "running"     // 正在执行
  | "succeeded"   // 执行成功
  | "failed"      // 执行失败
  | "timed_out"   // 执行超时
  | "cancelled";  // 已取消
```

#### 2.2.2 任务状态转换

```
┌─────────┐
│ queued   │
└────┬────┘
     │ start
     ▼
┌─────────┐
│ running │◄──────────────────────────┐
└────┬────┘                           │
     │                               │
     ├─ complete ─▶ ┌───────────┐    │
     │             │ succeeded │    │
     │             └───────────┘    │
     │                               │
     ├─ fail ──────▶ ┌───────────┐    │
     │             │  failed   │    │
     │             └───────────┘    │
     │                               │
     ├─ timeout ──▶ ┌───────────┐   │
     │             │ timed_out  │    │
     │             └───────────┘    │
     │                               │
     └─ cancel ───▶ ┌───────────┐   │
                   │ cancelled │   │
                   └───────────┘   │
                                   │
                                   │ retry
                                   │
                                   └──────┘
```

#### 2.2.3 任务完成判定

OpenClaw 没有显式的 `task_complete` 工具。任务完成的判定依赖于：

1. **LLM 停止生成**：LLM 决定不再调用工具，输出最终回复
2. **循环检测触发**：如果 LLM 陷入循环，循环检测会强制停止
3. **外部超时**：任务执行时间超过配置的最大时间
4. **用户取消**：用户主动取消任务

---

## 3. Saros Agents Client 的任务完成检测机制

### 3.1 task_complete 工具

**核心文件**：`src/vs/workbench/contrib/chat/common/tools/builtinTools/taskCompleteTool.ts`

Saros Agents Client 实现了一个专门的 `task_complete` 工具，Agent 必须调用此工具来声明任务完成。

#### 3.1.1 工具定义

```typescript
export const TaskCompleteToolId = 'task_complete';

export const TaskCompleteToolData: IToolData = {
  id: TaskCompleteToolId,
  displayName: 'Task Complete',
  modelDescription:
    'Signal that the user\'s task is fully done. You MUST call this tool when your work is complete — ' +
    'whether you made code changes, answered a question, or completed any other kind of task. ' +
    'Provide a brief summary of what was accomplished. ' +
    'Do not restate the summary in your message text — it is shown to the user directly.\n\n' +
    'IMPORTANT: Before calling this tool, you MUST output a brief text message summarizing what was done. ' +
    'The task is not complete until both your summary message AND this tool call are present.\n\n' +
    'When to call:\n' +
    '- After answering the user\'s question or completing a conversational request\n' +
    '- After you have completed ALL requested changes\n' +
    '- After verifying results: tests pass, terminal commands succeeded, tool calls returned expected output\n\n' +
    'When NOT to call:\n' +
    '- If a terminal command failed or produced unexpected output\n' +
    '- If an MCP or external tool call returned an error\n' +
    '- If you encountered errors you have not resolved\n' +
    '- If there are remaining steps to complete\n' +
    '- If you have not verified your changes work',
  source: ToolDataSource.Internal,
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Brief summary of what was accomplished. Omit for trivial interactions.',
      },
    },
  },
};
```

#### 3.1.2 工具行为

```typescript
export class TaskCompleteTool implements IToolImpl {
  async invoke(invocation: IToolInvocation, ...): Promise<IToolResult> {
    const params = invocation.parameters as { summary?: string };
    const summary = params?.summary ?? 'All done!';
    return {
      content: [{
        kind: 'text',
        value: summary,
      }],
    };
  }
}
```

**关键点**：
- `task_complete` 工具本身不执行任何实际操作，只是返回一个摘要消息
- 它的存在是为了**让 LLM 显式声明任务完成**
- 工具调用后，系统会检测到 `task_complete` 被调用，从而停止工具调用循环

### 3.2 ToolCallingLoop 主循环

**核心文件**：`extensions/copilot/src/extension/intents/node/toolCallingLoop.ts`

`ToolCallingLoop` 是管理 Agent 工具调用循环的核心类。

#### 3.2.1 主循环逻辑

**核心方法**：`_runLoop(outputStream, token, agentSpan, chatSessionId)`

```typescript
private async _runLoop(outputStream, token, agentSpan, chatSessionId): Promise<IToolCallLoopResult> {
  let i = 0;
  let lastResult: IToolCallSingleResult | undefined;
  let stopHookActive = false;

  while (true) {
    // 1. 检查是否超过工具调用限制
    if (lastResult && i++ >= this.options.toolCallLimit) {
      // 在 Autopilot 模式下，静默增加限制继续
      // 否则，触发工具调用限制处理并跳出循环
      break;
    }

    // 2. 检查 VS Code 是否请求让出（yield）
    if (lastResult && this.options.yieldRequested?.()) {
      if (this.options.request.permissionLevel !== 'autopilot' || this.taskCompleted) {
        break;
      }
    }

    // 3. 执行一轮工具调用
    const result = await this.runOne(outputStream, i, token);

    // 4. 检查是否需要继续执行 Stop Hook
    if (/* stop hook should block */) {
      continue; // 继续执行
    }

    // 5. 检查是否应该停止
    if (!result.round.toolCalls.length || result.response.type !== ChatFetchResponseType.Success) {
      // 没有工具调用或响应失败，停止循环
      break;
    }
  }

  return { toolCallRounds, availableTools, ... };
}
```

#### 3.2.2 Autopilot 模式的继续判断

**核心方法**：`shouldAutopilotContinue(result: IToolCallSingleResult): string | undefined`

这个方法决定了在 Autopilot 模式下，是否应该继续让 Agent 执行。

```typescript
protected shouldAutopilotContinue(result: IToolCallSingleResult): string | undefined {
  // 1. 如果 task_complete 已被调用，停止
  if (this.taskCompleted) {
    return undefined;
  }

  // 2. 检查历史中是否有 task_complete 调用
  const calledTaskComplete = this.toolCallRounds.some(
    round => round.toolCalls.some(tc => tc.name === ToolCallingLoop.TASK_COMPLETE_TOOL_NAME)
  );
  if (calledTaskComplete) {
    this.taskCompleted = true;
    return undefined;
  }

  // 3. 如果模型输出了纯文本响应（无工具调用），视为完成
  if (result.round.toolCalls.length === 0 && result.round.response.trim().length > 0) {
    return undefined;
  }

  // 4. 如果达到最大迭代次数，停止
  if (this.autopilotIterationCount >= ToolCallingLoop.MAX_AUTOPILOT_ITERATIONS) {
    return undefined;
  }

  // 5. 如果之前的提醒没有产生工具调用，停止（避免浪费 token）
  if (this.autopilotStopHookActive && result.round.toolCalls.length === 0) {
    return undefined;
  }

  // 6. 否则，返回提醒消息，督促模型调用 task_complete
  this.autopilotIterationCount++;
  return 'You have not yet marked the task as complete using the task_complete tool. ...';
}
```

#### 2.3.3 停止 Hook 机制

Saros Agents Client 实现了 **Stop Hook** 机制，允许外部钩子阻止 Agent 停止。

**Stop Hook 工作流程**：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Stop Hook 工作流程                           │
├─────────────────────────────────────────────────────────────────┤
│  1. Agent 准备停止（无工具调用或调用了 task_complete）          │
│                                                               │
│  2. 系统执行 Stop Hook                                       │
│     └─▶ executeStopHook() - 调用所有配置的停止钩子           │
│                                                               │
│  3. 检查钩子结果                                             │
│     ├─▶ shouldContinue: false - 所有钩子都允许停止           │
│     │   └─▶ 停止 Agent                                     │
│     └─▶ shouldContinue: true - 有钩子阻止停止               │
│         ├─▶ 收集阻止原因（reasons）                         │
│         ├─▶ 显示阻止消息给用户                              │
│         └─▶ 将原因注入到下一轮提示中                        │
│             └─▶ Agent 看到原因，继续工作                     │
└─────────────────────────────────────────────────────────────────┘
```

**Stop Hook 输入/输出**：

```typescript
interface StopHookInput {
  stop_hook_active: boolean;  // 是否已有活跃的停止钩子
}

interface StopHookOutput {
  decision: 'allow' | 'block';  // 允许停止或阻止停止
  reason?: string;                // 阻止原因
}
```

### 3.3 任务完成判定的完整流程

```
┌─────────────────────────────────────────────────────────────────┐
│            Saros Agents Client 任务完成判定流程                │
├─────────────────────────────────────────────────────────────────┤
│  用户发送请求                                                 │
│       │                                                       │
│       ▼                                                       │
│  ┌─────────────────────────────────┐                          │
│  │     ToolCallingLoop._runLoop()  │                          │
│  │     （主循环）                   │                          │
│  └─────────────┬───────────────┘                          │
│                │                                           │
│                ▼                                           │
│  ┌─────────────────────────────────┐                          │
│  │     this.runOne()               │                          │
│  │     （执行一轮 LLM 调用）       │                          │
│  └─────────────┬───────────────┘                          │
│                │                                           │
│                ▼                                           │
│  ┌─────────────────────────────────┐                          │
│  │   LLM 返回结果                  │                          │
│  │   - 工具调用？  → 执行工具     │                          │
│  │   - 无工具调用？ → 检查停止   │                          │
│  └─────────────┬───────────────┘                          │
│                │                                           │
│                ▼                                           │
│  ┌─────────────────────────────────┐                          │
│  │   检查是否调用了 task_complete   │                          │
│  │   - 是 → taskCompleted = true  │                          │
│  │   - 否 → 继续检查              │                          │
│  └─────────────┬───────────────┘                          │
│                │                                           │
│                ▼                                           │
│  ┌─────────────────────────────────┐                          │
│  │   执行 Stop Hook                │                          │
│  │   - shouldContinue: false      │                          │
│  │     → 停止循环，任务完成      │                          │
│  │   - shouldContinue: true       │                          │
│  │     → 继续循环，注入原因      │                          │
│  └─────────────┬───────────────┘                          │
│                │                                           │
│                ▼                                           │
│  ┌─────────────────────────────────┐                          │
│  │   检查是否应继续（Autopilot）   │                          │
│  │   shouldAutopilotContinue()    │                          │
│  │   - 返回 undefined → 停止     │                          │
│  │   - 返回消息 → 继续，提醒     │                          │
│  └─────────────┬───────────────┘                          │
│                │                                           │
│                ▼                                           │
│  ┌─────────────────────────────────┐                          │
│  │   任务完成，返回结果            │                          │
│  └─────────────────────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 详细对比

### 4.1 架构对比

| 维度 | OpenClaw | Saros Agents Client |
|------|----------|----------------------|
| **任务完成声明方式** | 被动：LLM 自主决定停止 | 主动：必须调用 `task_complete` 工具 |
| **循环检测机制** | 工具循环检测（5 种检测类型） | 工具调用限制 + Autopilot 继续判断 |
| **防止无限循环** | 循环检测 + 全局断路器 | 工具调用限制 + Stop Hook |
| **外部控制** | 任务注册表 + 状态管理 | Stop Hook + Subagent Stop Hook |
| **用户干预** | 取消任务 | 取消请求 + Yield 请求 |

### 4.2 任务完成判定的触发条件

#### OpenClaw 的触发条件

| 条件 | 描述 | 优先级 |
|------|------|--------|
| LLM 停止生成 | LLM 决定不再调用工具 | 高 |
| 循环检测警告 | 检测到循环，发送警告 | 中 |
| 循环检测严重 | 检测到循环，强制停止 | 高 |
| 全局断路器 | 过多重复调用，强制停止 | 最高 |
| 任务超时 | 执行时间超限 | 高 |
| 用户取消 | 用户主动取消 | 最高 |

#### Saros Agents Client 的触发条件

| 条件 | 描述 | 优先级 |
|------|------|--------|
| `task_complete` 调用 | Agent 调用了 task_complete 工具 | 高 |
| 无工具调用 + 文本响应 | LLM 输出了文本且无工具调用 | 中 |
| Stop Hook 允许停止 | 所有 Stop Hook 都允许停止 | 高 |
| 工具调用限制 | 超过最大工具调用次数 | 中 |
| Autopilot 最大迭代 | Autopilot 模式达到最大迭代次数 | 中 |
| 用户取消 | 用户取消请求 | 最高 |
| VS Code Yield | VS Code 请求让出 | 高 |

### 4.3 循环检测对比

#### OpenClaw 的循环检测

**优势**：
- **精细化的循环类型检测**：能识别 5 种不同的循环模式
- **可配置的阈值**：警告、严重、全局断路器三个级别
- **历史记录**：保留最近 30 次工具调用历史用于分析
- **哈希比较**：通过哈希比较工具参数和结果，准确识别重复

**劣势**：
- **被动响应**：只能在循环发生后检测，无法预防
- **默认关闭**：`enabled: false`，需要手动启用
- **可能产生误报**：某些合理的重复调用可能被误判为循环

#### Saros Agents Client 的循环防止

**优势**：
- **主动预防**：通过 `task_complete` 工具让 Agent 显式声明完成
- **多重保障**：工具调用限制 + Stop Hook + Autopilot 继续判断
- **用户友好**：Autopilot 模式下会自动提醒 Agent 调用 `task_complete`

**劣势**：
- **依赖 LLM 遵循指令**：如果 LLM 不调用 `task_complete`，系统只能被动等待
- **提醒可能无效**：Autopilot 的提醒可能被 LLM 忽略
- **缺乏精细化的循环检测**：没有像 OpenClaw 那样的五类循环检测

### 4.4 代码实现对比

#### OpenClaw: `detectToolCallLoop()`

```typescript
// 核心检测函数
export function detectToolCallLoop(
  state: SessionState,
  toolName: string,
  params: unknown,
  config?: ToolLoopDetectionConfig,
  scope?: ToolLoopDetectionScope,
): LoopDetectionResult {
  const resolvedConfig = resolveLoopDetectionConfig(config);

  // 检测 1: 未知工具重复
  if (unknownToolStreak.count >= resolvedConfig.unknownToolThreshold) {
    return { stuck: true, level: "critical", detector: "unknown_tool_repeat", ... };
  }

  // 检测 2: 全局断路器
  if (noProgressStreak >= resolvedConfig.globalCircuitBreakerThreshold) {
    return { stuck: true, level: "critical", detector: "global_circuit_breaker", ... };
  }

  // 检测 3-5: 轮询无进展、乒乓循环、通用重复
  // ...

  return { stuck: false };
}
```

#### Saros Agents Client: `shouldAutopilotContinue()`

```typescript
protected shouldAutopilotContinue(result: IToolCallSingleResult): string | undefined {
  // 检查 1: task_complete 已调用
  if (this.taskCompleted) {
    return undefined;
  }

  // 检查 2: 历史中有 task_complete
  const calledTaskComplete = this.toolCallRounds.some(...);
  if (calledTaskComplete) {
    this.taskCompleted = true;
    return undefined;
  }

  // 检查 3: 纯文本响应
  if (result.round.toolCalls.length === 0 && result.round.response.trim().length > 0) {
    return undefined;
  }

  // 检查 4: 最大迭代次数
  if (this.autopilotIterationCount >= ToolCallingLoop.MAX_AUTOPILOT_ITERATIONS) {
    return undefined;
  }

  // 检查 5: 之前的提醒无效
  if (this.autopilotStopHookActive && result.round.toolCalls.length === 0) {
    return undefined;
  }

  // 继续：返回提醒消息
  return 'You have not yet marked the task as complete...';
}
```

---

## 5. 优缺点分析

### 5.1 OpenClaw 方案

#### 优点

1. **通用性强**：不依赖特定的工具调用协议，适用于各种 LLM
2. **防护全面**：5 种循环检测类型覆盖大多数异常情况
3. **可配置**：阈值和检测器都可配置，适应不同场景
4. **历史分析**：保留工具调用历史，可进行回溯分析
5. **断路器机制**：全局断路器防止系统资源耗尽

#### 缺点

1. **被动检测**：只能在循环发生后介入，可能有延迟
2. **默认关闭**：需要手动启用，可能遗漏配置
3. **误报风险**：合理的重复调用可能被误判
4. **无显式完成信号**：依赖 LLM 自主判断，可能提前或延迟停止
5. **调试困难**：循环检测的日志可能难以解读

### 5.2 Saros Agents Client 方案

#### 优点

1. **显式完成信号**：`task_complete` 工具提供明确的完成声明
2. **主动提醒**：Autopilot 模式自动提醒 Agent 调用工具
3. **Hook 机制**：Stop Hook 提供外部控制能力
4. **用户友好**：提醒消息指导 Agent 正确行为
5. **易于调试**：工具调用记录清晰，易于追踪

#### 缺点

1. **依赖 LLM 遵循指令**：如果 LLM 不调用 `task_complete`，系统无能为力
2. **提醒可能无效**：LLM 可能忽略提醒继续错误行为
3. **缺乏精细化检测**：没有循环类型识别，只能限制总数
4. **工具调用限制粗糙**：只限制总数，不分析调用模式
5. **复杂性高**：Stop Hook + Autopilot + task_complete 三者交互复杂

---

## 6. 推荐方案

基于以上分析，推荐采用**混合方案**，结合两者的优点：

### 6.1 核心设计

```
┌─────────────────────────────────────────────────────────────────┐
│                    推荐的任务完成检测方案                       │
├─────────────────────────────────────────────────────────────────┤
│  1. 显式完成信号（借鉴 Saros）                          │
│     - 实现 task_complete 工具                                │
│     - Agent 必须调用此工具声明完成                           │
│     - 系统检测到调用后停止循环                              │
│                                                               │
│  2. 循环检测防护（借鉴 OpenClaw）                          │
│     - 实现工具循环检测（5 种类型）                         │
│     - 可配置的阈值和检测器                                 │
│     - 检测到循环时发送警告或强制停止                       │
│                                                               │
│  3. Hook 机制（借鉴 Saros）                              │
│     - 实现 Stop Hook 和 Subagent Stop Hook                  │
│     - 允许外部系统阻止 Agent 停止                          │
│     - 提供原因反馈给 Agent                                │
│                                                               │
│  4. 超时和限制（两者结合）                                │
│     - 工具调用次数限制                                      │
│     - 执行时间限制                                          │
│     - Token 消耗限制                                        │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 实施步骤

#### 阶段 1：基础框架（1-2 周）

1. **实现 task_complete 工具**
   - 定义工具接口和描述
   - 在工具注册表中注册
   - 在 Agent 循环检测中检查工具调用

2. **实现基础循环检测**
   - 移植 OpenClaw 的 `detectToolCallLoop` 函数
   - 实现工具调用历史记录
   - 添加配置支持

3. **实现 Stop Hook 机制**
   - 定义 Hook 接口和生命周期
   - 实现 Hook 执行引擎
   - 集成到 Agent 停止流程

#### 阶段 2：完善功能（2-4 周）

1. **完善循环检测**
   - 实现 5 种循环类型检测
   - 添加哈希比较和模式识别
   - 实现断路器机制

2. **添加超时和限制**
   - 工具调用次数限制
   - 执行时间限制
   - Token 消耗限制

3. **优化用户体验**
   - Autopilot 模式提醒
   - 错误信息友好化
   - 调试日志完善

#### 阶段 3：测试和优化（2-3 周）

1. **单元测试**
   - 循环检测测试
   - Stop Hook 测试
   - task_complete 工具测试

2. **集成测试**
   - 端到端任务完成流程测试
   - 异常情况处理测试
   - 性能测试

3. **优化和文档**
   - 性能优化
   - 用户文档
   - 开发者指南

---

## 7. 总结

### 7.1 关键发现

1. **OpenClaw** 采用**被动检测**方式，依赖循环检测防止无限循环，不要求 Agent 显式声明完成
2. **Saros Agents Client** 采用**主动声明**方式，要求 Agent 调用 `task_complete` 工具，并通过 Stop Hook 提供外部控制
3. 两种方案各有优劣，推荐采用**混合方案**

### 7.2 对比结论

| 维度 | OpenClaw | Saros Agents Client | 推荐方案 |
|------|----------|----------------------|----------|
| **完成声明** | 被动（LLM 自主） | 主动（task_complete） | 主动 + 被动备份 |
| **循环检测** | 精细化（5 种类型） | 粗糙（总数限制） | 精细化检测 |
| **外部控制** | 任务注册表 | Stop Hook | Stop Hook + 任务注册表 |
| **用户干预** | 取消任务 | 取消 + Yield | 取消 + Yield + 优先级 |
| **实现复杂度** | 中等 | 高 | 中等偏高 |

### 7.3 下一步行动

1. **短期（1-2 周）**：实现 task_complete 工具和基础循环检测
2. **中期（1-2 月）**：完善循环检测类型，实现 Stop Hook 机制
3. **长期（3-6 月）**：优化性能，添加监控，完善文档

---

## 附录

### A. 参考文献

1. OpenClaw 源代码：`G:\CustomWorkspaces\AIProjects\openclaw\src\agents\tool-loop-detection.ts`
2. OpenClaw 源代码：`G:\CustomWorkspaces\AIProjects\openclaw\src\tasks\task-executor.ts`
3. Saros Agents Client 源代码：`G:\CustomWorkspaces\AIProjects\saros-agents-client\src\vs\workbench\contrib\chat\common\tools\builtinTools\taskCompleteTool.ts`
4. Saros Agents Client 源代码：`G:\CustomWorkspaces\AIProjects\saros-agents-client\extensions\copilot\src\extension\intents\node\toolCallingLoop.ts`

### B. 术语表

| 术语 | 定义 |
|------|------|
| **task_complete** | Saros Agents Client 中用于声明任务完成的工具 |
| **Tool Loop Detection** | OpenClaw 中检测工具调用循环的机制 |
| **Stop Hook** | Saros Agents Client 中阻止 Agent 停止的钩子机制 |
| **Circuit Breaker** | 断路器模式，防止系统资源耗尽 |
| **Autopilot Mode** | VS Code Copilot 的自动批准模式 |

### C. 修订历史

| 版本 | 日期 | 作者 | 变更说明 |
|------|------|------|----------|
| 1.0 | 2026-05-22 | AI Assistant | 初始版本，完成 OpenClaw 和 Saros Agents Client 任务完成检测机制对比分析 |
