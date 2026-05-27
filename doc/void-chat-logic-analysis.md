# Void vs Sarosis 聊天框逻辑层深度对比分析与优化建议

> 生成日期：2026-05-27
> 分析范围：消息处理、流式管理、状态机、工具执行、错误恢复、取消机制

---

## 一、架构总览对比

| 维度 | Void | Sarosis |
|------|------|---------|
| **核心架构** | VS Code 服务 + React 全局变量桥接 | VS Code 服务 + WebView postMessage + Zustand |
| **状态管理** | `ChatThreadService` 单一服务集中管理 | Zustand Store + StreamHandler 双层管理 |
| **消息类型** | 联合类型 `ChatMessage`（6 种工具子状态） | `ChatMessage` 接口 + `ToolCallState` 数组 |
| **流式状态** | `ThreadStreamState` 标记联合（5 种 `isRunning`） | `StreamState` 接口 + RAF 批量通知 |
| **工具审批** | 三类别（edits/terminal/MCP）+ 自动批准配置 | `ToolApprovalService` 安全等级检查 |
| **错误恢复** | 简单重试 + 无 Fallback | 三级 Fallback + 结构化错误分类 |
| **取消机制** | `interrupt` Promise + `signal.aborted` | 三级 AbortController 链 + 保留部分内容 |
| **持久化** | VS Code State 存储 + 文件快照 | Memento 存储 + 会话历史 |
| **代码组织** | 单一大文件 `chatThreadService.ts`（2000+行） | 分层模块化（Service → Driver → OS → Provider） |

### 数据流对比

**Void**:
```
React UI ←(全局变量+Listener)→ ChatThreadService ←(IPC)→ LLMMessageService ←(IPC)→ LLMMessageChannel
                                                                                              ↓
                                                                                     sendLLMMessage → Provider SDK
```

**Sarosis**:
```
React UI ←(postMessage)→ Controller ←→ AgentChatService ←→ AgentDriverService ←→ AgentOSService
                              ↑                                    ↓                     ↓
                         Zustand Store                    ToolApprovalService    ModelProvider / ExecutionProvider
```

---

## 二、状态管理深度对比

### 2.1 Void: 单一服务集中式

Void 的 `ChatThreadService` 是唯一的状态真相源（Single Source of Truth），管理：

- **持久化状态** `ThreadsState`: `{ allThreads, currentThreadId }`
- **瞬态状态** `streamState`: 每线程独立的流式状态

核心更新入口 `_setState()` + `_setStreamState()`，所有修改都通过这两个方法，触发 `_onDidChangeCurrentThread` 事件通知 UI。

**优势**：
- 状态一致性有保证，不存在多个 Store 之间的同步问题
- 调试简单，只需查看一个服务

**劣势**：
- 单一大类（2000+ 行），内聚性低
- React 桥接层使用**全局变量 + Listener Set**（非 React 惯用模式），时序问题难以追踪

### 2.2 Sarosis: 双层分离式

Sarosis 使用 **Zustand（持久消息状态） + StreamHandler（实时流状态）** 双层架构：

- **Zustand Store** `useChatStore`: 管理消息列表、输入框、加载状态等
- **StreamHandler**: 独立管理实时流（`textBuffer`, `thinkingBuffer`, `toolCalls`），通过观察者模式通知 UI

**关键设计**：
- **RAF 批量通知**: Host 已在 16ms 节流，WebView 再用 `requestAnimationFrame` 合并，避免每帧多次重渲染
- **前后台流切换**: 切换 Agent 时，当前流保存到 `backgroundStreams`，目标流恢复，支持多 Agent 并行流式
- **原子提交**: `onStreamComplete` 中 `messages` 和 `streamState` 必须在同一个 `set()` 中更新，防止"流消失但消息未出现"的闪烁

**优势**：
- 关注点分离，流式高频更新与消息持久化解耦
- 多 Agent 并行流式响应不丢失数据

**劣势**：
- 两个状态源之间的同步点（StreamHandler → Zustand）需要小心处理
- 更多样板代码

### 2.3 对比总结

| 特性 | Void | Sarosis |
|------|------|---------|
| 状态源数量 | 1（ChatThreadService） | 2+（Zustand + StreamHandler + 其他 Store） |
| React 集成 | 全局变量 + 手动 Listener | Zustand Hook（原生 React） |
| 多 Agent 并行 | 不支持（单线程） | 支持（前后台流切换） |
| 高频更新优化 | 无特殊优化 | RAF 批量通知 |
| 状态同步复杂度 | 低 | 中等 |

---

## 三、消息类型系统对比

### 3.1 Void: 精细的联合类型

Void 的 `ChatMessage` 是**标记联合类型**，工具消息有 6 种渐进子状态：

```
ChatMessage = UserMessage | AssistantMessage | ToolMessage | DecorativeCanceledTool | CheckpointEntry

ToolMessage 子状态:
  1. invalid_params   — 参数校验失败
  2. tool_request     — 等待用户审批
  3. running_now      — 正在执行
  4. tool_error       — 执行出错
  5. success          — 执行成功
  6. rejected         — 用户拒绝
```

**优势**：TypeScript 可穷举检查，UI 可精确匹配每种状态渲染不同组件。

### 3.2 Sarosis: 扁平接口 + 状态字段

Sarosis 的 `ChatMessage` 是**单一接口**，工具调用状态存储在 `toolCalls` 数组中：

```typescript
interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    toolCalls?: ToolCallState[];   // 工具调用状态数组
    thinking?: string;
    error?: StreamError;
}

interface ToolCallState {
    id: string;
    name: string;
    status: 'pending' | 'running' | 'completed' | 'error';
    // ...
}
```

**优势**：简单直观，一条消息可以同时包含文本 + 多个工具调用。

**劣势**：类型安全性弱于联合类型，`status` 字段容易遗漏处理。

---

## 四、流式处理对比

### 4.1 Void: 基于 interrupt 的流式控制

Void 的流式处理核心是 `ThreadStreamState`，通过 `isRunning` 字段区分 5 种状态：

```
isRunning:
  'LLM'           — LLM 正在流式输出（携带 displayContentSoFar/reasoningSoFar/toolCallSoFar）
  'tool'          — 工具正在执行（携带 toolName/toolParams/content）
  'awaiting_user' — 等待用户审批工具调用
  'idle'          — 空闲（循环中间状态）
  undefined       — 完全停止
```

**interrupt 机制**：在 `'LLM'` 状态时携带一个 `interrupt: Promise`，当用户发送新消息时 resolve 此 Promise，实现流式中断。

### 4.2 Sarosis: 基于 AbortController 的三级取消链

Sarosis 的取消信号从 UI → ChatService → Driver → OS 逐级传递：

```
UI cancelStream()
  → sendRequest('chat.cancel')           ← 通知 Host
  → resetStreamSilent()                  ← 本地立即清理
  → commit partial content               ← 保留已生成内容
     ↓
Host AgentChatService.cancelStream()
  → controller.abort()
  → _activeStreams.delete(key)
     ↓
AgentDriverService.cancelTurn()
  → _updateTurnStatus(turnId, Cancelling)
  → controller.abort()
     ↓
AgentOSService.cancelAgentLoop()
  → _loopAbortController.abort()
  → _executionTracker.cancelAll()        ← 取消所有活跃工具执行
```

**关键设计**：取消不是"丢弃一切"，而是**保留已生成的内容**作为标记了 `cancelled_` 前缀的消息。VS Code Copilot Chat 也采用此模式。

### 4.3 对比

| 特性 | Void | Sarosis |
|------|------|---------|
| 取消机制 | `interrupt` Promise | `AbortController` 三级链 |
| 取消后内容 | 丢弃 | 保留部分内容 |
| 流式状态机 | 5 种 isRunning 状态 | isStreaming + toolCalls 状态数组 |
| 多流并行 | 不支持 | 支持（backgroundStreams） |
| 工具级取消 | 不支持 | 支持（executeWithTimeout + 父子信号链接） |

---

## 五、工具执行流程对比

### 5.1 Void: 简洁的内置工具链

Void 的工具执行流程相对简单：

```
1. LLM 返回 tool_call
2. 参数校验 (validateParams)
3. 检查是否需要审批 (approvalTypeOfBuiltinToolName)
   → 需要审批: 添加 tool_request 消息，中断循环等待用户
   → 自动批准: 继续
4. 执行工具 (callTool / callMCPTool)
5. 更新消息状态 (running_now → success/tool_error)
6. 将结果添加到消息列表，继续循环
```

**工具审批系统**：
- 三大审批类别：`edits`（文件编辑）、`terminal`（终端命令）、`MCP tools`（外部工具）
- 只读工具（`read_file`, `ls_dir`, `search_*`）自动通过
- 每个类别可独立配置 `autoApprove`
- **即使 autoApprove=true，也先添加 `tool_request` 消息**（UI 加载态），再自动继续

### 5.2 Sarosis: 复杂的 Agent Loop + 多格式兼容

Sarosis 的工具执行流程极其复杂：

```
1. 获取启用工具列表
   └── AgentToolIsolator 根据 employee.tools 配置过滤
   └── filterToolsByChatMode() 按 chatMode 过滤
2. 调用模型 → 收集 streaming tool_calls
   └── StreamingToolCallAssembler 增量组装参数
   └── 参数 buffer 溢出保护
3. 文本解析兜底 (_tryExtractToolCallsFromText)
   └── 7 种格式兼容: JSON code block / 裸 JSON / XML / Bracket / ReAct / Python / Thinking推断
4. 内容清洗
   └── _replaceToolBlocksWithPlaceholders() → <!--TOOL_CARD:id-->
   └── sanitizeAssistantVisibleText() → 多阶段 strip
   └── content_replace delta 通知前端替换
5. Phantom tool 过滤 (render_type="None")
6. Server-executed tool 分离 (Knot AG-UI)
7. 工具执行 (顺序 or 并行)
   └── ToolApprovalService 安全等级检查
   └── executeWithTimeout() 超时守卫
   └── 父-子 AbortSignal 链接
8. 结果反馈 → messages.push({role:'tool'})
9. 守卫: 全部失败 → 检查 "tool not found" → 计数达上限(3次)则终止
10. 循环回到步骤2，直到无工具调用或达到 MAX_TOOL_ITERATIONS=50
```

### 5.3 工具错误处理对比

**Void**:
- 参数无效 → 添加 `invalid_params` 消息，不阻塞循环
- 执行出错 → 添加 `tool_error` 消息，继续循环
- 用户拒绝 → 添加 `rejected` 消息，结束流式状态

**Sarosis**（精细的 5 级容错链）:

| 步骤 | 错误场景 | 处理方式 |
|------|---------|---------|
| 1 | 工具名不存在 | `repairToolName()` 尝试修复，失败则返回可用工具列表 |
| 2 | 参数无效 | `classifyArgumentValidity()` 分为 valid/empty/truncated/repairable/invalid |
| 2a | 参数截断 | 返回不可恢复错误 |
| 2b | 参数可修复 | `repairToolArguments()` 尝试修复 JSON |
| 3 | 参数类型不匹配 | `coerceToolArgs()` 按 JSON Schema 做类型强转 |
| 3.5 | 安全等级拒绝 | `ToolApprovalService` 返回 "denied by user" |
| 4 | 执行超时 | `executeWithTimeout()` 返回 `timedOut: true` |
| 4 | Provider 执行异常 | `sanitizeToolError()` 清洗后尝试下一个 Provider |
| 5 | 反复调用不存在的工具 | 计数达 3 次强制终止循环 |

### 5.4 对比总结

| 特性 | Void | Sarosis |
|------|------|---------|
| 工具调用格式 | 标准 function_call | 7 种格式兼容 |
| 工具审批 | 三类别 + autoApprove | ToolApprovalService 安全等级 |
| 参数修复 | 不支持 | repairToolName + repairToolArguments + coerceToolArgs |
| 执行超时 | 不支持 | executeWithTimeout + 父子信号链接 |
| 无限工具循环防护 | 不支持 | MAX_INVALID_TOOL_RETRIES=3 |
| 并行工具执行 | 不支持 | 支持 |
| MCP 工具 | 支持 | 支持 |

---

## 六、错误恢复对比

### 6.1 Void: 简单重试

Void 的错误恢复策略较为简单：
- 流式错误：结束流式状态，UI 显示错误
- 工具错误：添加错误消息，继续 Agent Loop
- 无 Fallback 机制

### 6.2 Sarosis: 三级 Fallback + 结构化错误

**三级 Fallback 机制** (`_executeWithFallback`):

```
1. 尝试主执行
   ↓ 失败
2. 逐个尝试备用模型 (gpt-4o → gpt-4-turbo → gpt-3.5-turbo)
   最多 3 次
   ↓ 全部失败
3. 返回 "All models failed" 错误
```

**结构化错误分类** (`parseStreamError`):

```typescript
interface StreamError {
    message: string;
    level: 'error' | 'warning' | 'info';
    retryable: boolean;         // 是否可重试
    isRateLimited: boolean;     // 限流
    isQuotaExceeded: boolean;   // 配额超限
}
```

- **错误分级**: 限流降级为 `warning`，其他为 `error`
- **可重试判断**: 网络错误、限流、5xx 可重试；401/403 不可重试
- **UI 可据此展示不同颜色图标和重试按钮**

**子步骤错误不阻塞主流程**：
- Planning 失败 → 跳过，继续
- Memory 加载失败 → 跳过，继续
- Skill 注入失败 → 跳过，继续

### 6.3 对比

| 特性 | Void | Sarosis |
|------|------|---------|
| Fallback 机制 | 无 | 三级 Fallback |
| 错误分类 | 无 | 结构化 5 维度 |
| 子步骤容错 | 不区分 | 独立 try-catch，不阻塞 |
| 重试逻辑 | 无 | 基于 retryable 字段 |
| 限流处理 | 无 | 降级为 warning + 可重试 |

---

## 七、特有功能对比

### 7.1 Void 独有

| 功能 | 描述 | 价值 |
|------|------|------|
| **Checkpoint 系统** | 时间旅行，可回溯到任意检查点 | 用户安全感，方便试错 |
| **File Snapshot** | 检查点时保存文件快照 | 代码变更可逆 |
| **Tool Approval UI** | 6 种工具子状态的精细 UI | 安全控制 |
| **Checkpoint Auto-approve** | 每个类别独立配置自动批准 | 便利性与安全性的平衡 |

### 7.2 Sarosis 独有

| 功能 | 描述 | 价值 |
|------|------|------|
| **多 Agent 并行流** | 前后台流切换，多 Agent 同时流式 | 多 Agent 协作 |
| **Agent Delegation** | Agent 间任务委派与追踪 | 复杂任务分解 |
| **Task Orchestration** | 计划生成、子任务分发、结果聚合 | 结构化工作流 |
| **三级 Fallback** | 主模型 → 备用模型 → 错误消息 | 可靠性 |
| **7 种工具格式兼容** | 兼容各种模型输出格式 | 模型兼容性 |
| **Content Replace Delta** | 工具卡片占位符替换 | UI 性能优化 |
| **chatMode 切换** | craft/ask/plan/workflow 四种模式 | 场景适配 |

---

## 八、优化建议

### 高优先级（建议在 1-2 周内实现）

#### 1. 引入工具审批 UI（Tool Approval System）

**现状**：Sarosis 有 `ToolApprovalService` 安全等级检查，但缺少用户侧的审批 UI。工具调用要么被静默拒绝，要么静默执行。

**建议**：借鉴 Void 的 6 种工具子状态，在 `ToolCallState` 中增加 `approval_required` 和 `rejected` 状态：

```typescript
interface ToolCallState {
    // ... existing fields
    status: 'pending' | 'approval_required' | 'running' | 'completed' | 'error' | 'rejected';
    approvalCategory?: 'edits' | 'terminal' | 'mcp';
}
```

在 `ChatMessage.tsx` 中增加审批卡片组件，显示工具名、参数摘要，提供"批准"/"拒绝"按钮。

#### 2. 添加 Checkpoint 系统

**现状**：Sarosis 没有时间旅行功能，用户无法回溯到之前的状态。

**建议**：
1. 在 Agent Loop 的关键节点（每次工具执行前、每次模型调用后）创建 Checkpoint
2. Checkpoint 存储当前消息列表快照 + 文件变更摘要
3. UI 在消息流中显示 Checkpoint 标记，点击可回溯
4. 初期可只存消息快照（不存文件快照），降低复杂度

#### 3. 增强流式状态机

**现状**：Sarosis 的 `StreamState` 只有 `isStreaming` 布尔值，无法区分 LLM 输出中、工具执行中、等待审批等状态。

**建议**：借鉴 Void 的 `isRunning` 标记联合类型：

```typescript
type AgentRunState =
    | { phase: 'idle' }
    | { phase: 'llm_streaming'; contentSoFar: string }
    | { phase: 'tool_executing'; toolName: string; toolId: string }
    | { phase: 'awaiting_approval'; toolName: string; toolId: string }
    | { phase: 'thinking'; contentSoFar: string };
```

UI 可据此显示更精确的状态指示器（如"正在调用 read_file..."、"等待审批 rewrite_file..."）。

### 中优先级（建议在 1 个月内实现）

#### 4. 结构化错误恢复

**现状**：Sarosis 已有 `parseStreamError` 和三级 Fallback，但缺少面向用户的重试 UI。

**建议**：
1. 在错误消息中添加"重试"按钮，仅当 `retryable=true` 时显示
2. 重试逻辑：重新发送最后一条用户消息，携带 `retryFromError: true` 标记
3. 前端可展示 Fallback 模型切换过程（如"主模型失败，正在切换到 gpt-4o..."）

#### 5. 工具调用状态渐进更新

**现状**：工具调用从 `pending` 直接跳到 `completed`/`error`，中间没有渐进状态。

**建议**：借鉴 Void 的工具子状态，实现更细粒度的状态转换：

```
pending → approval_required → running → completed/error
                                         ↑
                                    rejected (用户拒绝)
```

同时，长时运行工具（如 `run_command`）应支持进度回调，在 `ToolCallState` 中增加 `progress` 字段。

#### 6. 消息编辑与重发

**现状**：Sarosis 不支持编辑已发送的消息。

**建议**：在用户消息上添加"编辑"按钮，编辑后重新发送，生成新的响应。这是 Cursor 等 AI 编辑器的标配功能。

#### 7. 前后台流可见性

**现状**：`backgroundStreams` 已实现数据层面的并行，但 UI 层面用户看不到后台 Agent 的流式进度。

**建议**：在 Agent 卡片上添加迷你流式指示器，显示后台 Agent 的实时状态（如"正在思考..."、"正在执行 tool_name..."）。点击可切换到该 Agent 的详细视图。

### 低优先级（建议在 2-3 个月内实现）

#### 8. 工具调用参数修复可视化

**现状**：`repairToolName` 和 `repairToolArguments` 在后台静默修复，用户无感知。

**建议**：当参数被修复时，在工具卡片中显示修复前后的 diff，增加透明度。用户可以选择使用原始参数或修复后的参数。

#### 9. 无限工具循环防护增强

**现状**：仅通过 `invalidToolNameCount >= 3` 防护。

**建议**：增加更多维度的循环检测：
- **重复参数检测**：连续 3 次调用同一工具且参数相似 → 提示用户
- **总工具调用次数限制**：除 `MAX_TOOL_ITERATIONS=50` 外，增加总 token 消耗限制
- **循环模式检测**：检测 A→B→A→B 的交替调用模式

#### 10. 工具执行历史回放

**现状**：工具执行结果一旦显示，无法回看详细参数和结果。

**建议**：在工具卡片中添加"展开详情"按钮，显示完整的参数 JSON 和执行结果。可参考 Void 的 `ToolHeaderWrapper` 设计。

#### 11. 并行工具执行可视化

**现状**：Sarosis 支持并行工具执行，但 UI 上无法区分顺序执行和并行执行。

**建议**：并行执行的工具卡片使用缩进 + 并排排列，顺序执行的卡片使用纵向堆叠。添加连接线指示依赖关系。

#### 12. Agent Loop 生命周期可视化

**现状**：Agent Loop 对用户是黑盒，用户无法理解"AI 正在做什么"。

**建议**：添加一个可折叠的"思考过程"面板，展示：
- 当前 Loop 迭代次数
- 已调用的工具列表及耗时
- 模型推理 token 消耗
- Fallback 历史（如有）

---

## 九、实现路线图

### Phase 1: 基础增强（1-2 周）

```
Week 1:
  ├── [1] 工具审批 UI — 增加 approval_required/rejected 状态 + 审批卡片组件
  ├── [3] 流式状态机增强 — AgentRunState 联合类型 + 状态指示器组件
  └── [4] 错误恢复 UI — 重试按钮 + Fallback 过程展示

Week 2:
  ├── [2] Checkpoint 系统（消息快照版）— Checkpoint 数据结构 + UI 标记 + 回溯逻辑
  ├── [5] 工具调用状态渐进更新 — 子状态转换 + 进度字段
  └── [6] 消息编辑与重发 — 编辑按钮 + 重新发送逻辑
```

### Phase 2: 体验优化（1 个月）

```
Week 3-4:
  ├── [7] 前后台流可见性 — 迷你流式指示器 + Agent 状态同步
  ├── [8] 工具修复可视化 — 修复 diff 展示
  └── [10] 工具执行历史回放 — 展开详情 + 参数/结果 JSON 展示

Week 5-6:
  ├── [9] 循环防护增强 — 重复参数检测 + 总 token 限制 + 交替模式检测
  ├── [11] 并行工具执行可视化 — 缩进/并排排列 + 连接线
  └── [12] Agent Loop 生命周期面板 — 迭代次数 + 工具列表 + token 消耗
```

### Phase 3: 高级功能（2-3 个月）

```
  ├── Checkpoint 文件快照版 — 文件 diff 存储 + 一键还原
  ├── 工具调用录制与回放 — 完整的 Agent Session 录制
  └── 多模态工具支持 — 图片/文件上传 + 预览
```

---

## 十、结论

两个项目代表了两种不同的设计哲学：

- **Void** 追求**简洁与安全**：单一服务、联合类型、工具审批、Checkpoint。适合追求可控性和安全感的用户。
- **Sarosis** 追求**功能与兼容**：多 Agent 协作、7 种工具格式兼容、三级 Fallback、复杂任务编排。适合追求自动化和复杂场景的用户。

**最优策略是取两者之长**：
1. 从 Void 借鉴**工具审批系统**和**Checkpoint 系统**，提升用户安全感
2. 从 Void 借鉴**流式状态机**，提升状态可见性
3. 保持 Sarosis 现有的**多 Agent 并行**、**三级 Fallback**、**7 种格式兼容**等优势
4. 在此基础上增强**错误恢复 UI**、**工具执行可视化**、**Agent Loop 生命周期展示**

这样既能保持 Sarosis 在功能和兼容性上的领先，又能补齐在用户安全感和状态可见性上的短板。
