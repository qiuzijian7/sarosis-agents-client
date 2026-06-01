# Void vs Sarosis 流式消息链路深度对比分析

## 一、架构总览

两个项目均采用 **5 层架构** 从 LLM 流式返回到 UI 显示：

```
LLM Provider API → 解析层 → 传输层 → 状态管理层 → UI 渲染层
```

| 层次 | Void | Sarosis |
|------|------|---------|
| Provider | Electron 主进程 SDK 原生流 | Extension Host 原生 fetch SSE |
| 解析 | extractGrammar wrapper 链 | IModelDelta → IChatStreamDelta 转换 |
| 传输 | Electron IPC Channel + requestId | VS Code postMessage + messageProtocol |
| 状态 | IsRunningType 5 状态机 | boolean isStreaming + StreamState |
| UI | 全局变量 + React listeners | Zustand store + StreamingBubble memo |

---

## 二、逐层对比

### 2.1 LLM Provider 层

| 维度 | Void | Sarosis |
|------|------|---------|
| SDK 依赖 | OpenAI SDK / Anthropic SDK / Google GenAI SDK | 无 SDK 依赖，原生 fetch + SSE 解析 |
| 进程模型 | Electron 主进程（Node.js） | Extension Host 进程（Node.js） |
| Provider 路由 | `sendLLMMessageToProviderImplementation` 映射表 | `IModelProvider` 接口 + DI 注册 |
| 流式方式 | SDK 原生 `stream: true` / `generateContentStream` | 手动 SSE 解析（ReadableStream + TextDecoder） |

**Void 优点**：
- SDK 封装完善，错误处理、重试、类型安全由 SDK 保证
- Anthropic/Gemini 的特殊流事件（thinking_delta、functionCall）有原生支持

**Void 缺点**：
- 依赖多个 SDK，bundle 体积大
- SDK 版本升级可能导致 breaking changes

**Sarosis 优点**：
- 零 SDK 依赖，bundle 体积小
- 统一 SSE 解析逻辑，新增 provider 只需实现 `IModelProvider` 接口
- DI 注册模式更灵活，可运行时切换 provider

**Sarosis 缺点**：
- 手动 SSE 解析需要处理各种边界情况（不完整 JSON、换行、编码）
- 每种 provider 的特殊流事件需要自行适配

---

### 2.2 解析层

| 维度 | Void | Sarosis |
|------|------|---------|
| 核心机制 | `extractGrammar.ts` wrapper 函数链 | `IModelDelta` → `IChatStreamDelta` 格式转换 |
| 文本传递 | **全量 fullTextSoFar** | **增量 delta content** |
| 推理解析 | `extractReasoningWrapper` 状态机 | `IModelDelta.type === 'thinking'` |
| 工具解析 | `extractXMLToolsWrapper` 流式 XML 解析 | 原生 `tool_calls` + `_tryExtractToolCallsFromText` 7 格式兜底 |
| 格式转换 | 集中式（2 层 wrapper） | 分布式（每个 provider 各自转换） + `MessageFormatConverter` 工具类 |

**Void 优点**：
- **全量文本模式**：UI 层无需维护累加器，直接用 `fullTextSoFar` 渲染，避免增量累积的边界问题
- **wrapper 链模式**：条件化组合 `extractReasoningWrapper` + `extractXMLToolsWrapper`，代码复用度高
- `RawToolCallObj.doneParams` 精确跟踪流式中已完成的参数名

**Void 缺点**：
- XML 工具解析仅支持单一格式，不支持 JSON/ReAct 等其他格式
- `extractGrammar.ts` 的状态机逻辑复杂，流式中 `<think` 标签前缀缓冲难以调试

**Sarosis 优点**：
- **7 种文本格式兜底**：覆盖 JSON code block、raw JSON、XML、bracket、ReAct、Python kwargs、thinking 推理
- 原生 tool_calls 直接透传，无需从文本中提取
- `content_replace` 事件支持：提取 tool call 后替换原始文本，避免 UI 闪现 JSON 噪点
- `IModelCapabilityConfig` 声明式配置：新增模型无需修改代码逻辑

**Sarosis 缺点**：
- **增量累积风险**：WebView 侧需要自行维护 `textBuffer += content`，组件卸载/切换期间可能丢失 delta
- 7 种格式提取逻辑集中在 `_tryExtractToolCallsFromText`，正则嵌套深、难以维护
- 分布式格式转换：虽然已有 `MessageFormatConverter`，但 `builtInBYOKModelProvider` 内仍有大量 inline 转换

---

### 2.3 传输层

| 维度 | Void | Sarosis |
|------|------|---------|
| IPC 机制 | Electron IPC Channel（主进程↔渲染进程） | VS Code postMessage（Host↔WebView） |
| 事件路由 | `requestId` + Emitter | `employeeId` + `sessionId` |
| 批次控制 | 无显式批处理 | Host 侧 16ms frame 节流 |
| 回调传递 | 不能跨 IPC，用事件监听替代 | 同理，messageProtocol RPC |

**Void 优点**：
- Electron IPC Channel 是二进制高效传输，延迟低
- Emitter 模式天然支持多订阅者

**Void 缺点**：
- 无流控机制，LLM 快速输出时可能导致渲染进程消息堆积

**Sarosis 优点**：
- Host 侧 16ms frame 节流，避免 WebView 消息洪水
- `backgroundStreams` 机制：多 Agent 并行流式时，非活跃 Agent 的 delta 在后台累积，切换时恢复
- RAF 批次合并：`scheduleNotify()` 将同一帧内的多次 delta 合并为一次 React 渲染

**Sarosis 缺点**：
- postMessage 是结构化克隆，性能不如 Electron IPC
- 多层 employeeId/sessionId 守卫逻辑复杂，边界情况多

---

### 2.4 状态管理层

| 维度 | Void | Sarosis |
|------|------|---------|
| 状态模型 | `IsRunningType` 5 状态 | `boolean isStreaming` |
| 状态定义 | `'LLM' \| 'tool' \| 'awaiting_user' \| 'idle' \| undefined` | `true \| false` |
| 关联数据 | Discriminated union: `llmInfo` / `toolInfo` / `error` | 扁平 `StreamState` 接口 |
| Agent 循环 | `chatThreadService._runChatAgent` 内部状态机 | `executionProvider` + `agentOSService` 编排 |

**Void 优点**：
- **5 状态精确表达** Agent 循环的每个阶段，UI 可精确响应：
  - `LLM` → 显示流式文本
  - `tool` → 显示工具执行中
  - `awaiting_user` → 显示审批按钮
  - `idle` → 过渡态（LLM↔工具之间）
  - `undefined` → 完全空闲/错误
- Discriminated union 类型安全，TypeScript 编译器可自动推导关联数据
- `idle` 状态携带 `interrupt: Promise<() => void>`，支持在过渡态中断

**Void 缺点**：
- 状态机流转逻辑复杂，需要正确维护 `idle` 过渡态
- 5 状态 + 关联数据导致 `ThreadStreamState` 类型定义庞大

**Sarosis 优点**：
- 简单直观，`isStreaming` boolean 易于理解
- `StreamState` 扁平结构，所有字段平铺，不需要 discriminated union
- 额外的 `toolCalls[].status`（`running/done/error`）提供了细粒度的工具状态

**Sarosis 缺点**：
- **无法区分 "LLM 输出中" 和 "工具执行中"**：都是 `isStreaming=true`
- **无法表达 `awaiting_user`**：需要用户审批的场景只能用 `ConfirmationCard` 单独处理
- `idle` 过渡态缺失：LLM 流结束到工具执行开始之间，`isStreaming` 可能为 false（闪断）
- `isCompressing` 作为附加 boolean 补充，但不如集成到状态机中优雅

---

### 2.5 UI 渲染层

| 维度 | Void | Sarosis |
|------|------|---------|
| 状态订阅 | 全局变量 + `Set<Listener>` | Zustand `subscribeStream` → `set({ streamState })` |
| 流式消息 | `currStreamingMessageHTML` 虚拟 ChatBubble | `StreamingBubble` memo 组件 |
| 已提交消息 | `previousMessages` + `useMemo` | `messages[]` + `ChatMessageComponent` |
| 工具卡片 | `EditToolSoFar` / `ToolHeaderWrapper` | `ToolCallCard` + `InterleavedMarkdownRenderer` |
| Markdown | `ChatMarkdownRender`（marked lexer） | `MarkdownRenderer`（react-markdown） |
| 推理折叠 | 流式展开，完成后自动折叠 | 始终折叠，手动展开 |
| 滚动控制 | `ScrollToBottomContainer` | `chatMessagesRef` + `isAtBottomRef` |
| 多 Agent | 无（单线程聊天） | `SubAgentCard` + `backgroundStreams` |

**Void 优点**：
- 全局变量 + Listener 模式避免了 React Context 的级联 re-render
- `useMemo` 优化已提交消息列表，流式消息独立渲染
- 推理内容自动折叠（完成后），UX 更好
- `EditToolSoFar` 组件支持流式中展示正在生成的工具参数

**Void 缺点**：
- 无虚拟滚动，消息量大时性能下降
- 不支持多 Agent 并行
- 代码集中在单个 `SidebarChat.tsx`（3000+ 行），维护困难

**Sarosis 优点**：
- **StreamingBubble 独立 memo**：父列表不因流式 delta 重新渲染
- **InterleavedMarkdownRenderer**：工具卡片根据 `textPosition` 嵌入 Markdown 流中，视觉连贯
- **backgroundStreams**：多 Agent 并行流式互不干扰
- **原子提交**：`resetStreamSilent()` + `set({ messages, streamState })` 同一批次更新，避免"气泡消失→消息未出现"的闪烁
- **结构化错误**：`StreamError` 接口支持 `level/retryable/isRateLimited`，UI 可区分展示
- **VS Code Copilot Chat 卡片模式**：references/progress/confirmation/todos/tips/questions 6 种富卡片

**Sarosis 缺点**：
- 增量 `textBuffer` 累积：如果 RAF 被取消（如切换 Agent），部分 delta 可能丢失
- `cancelStream` 需要手动保存部分内容为 `cancelled_*` 消息，逻辑复杂
- `loadHistoryForSession` 去重逻辑 3 层嵌套（id → content → planId），过度防御
- 推理始终折叠，流式中看不到推理过程

---

## 三、关键差异深度对比

### 3.1 fullTextSoFar（全量）vs delta（增量）

```
Void:   LLM → fullTextSoFar += newChunk → onText({ fullText }) → UI 直接渲染
Sarosis: LLM → yield { type: 'text', content: newChunk } → textBuffer += newChunk → UI 渲染 textBuffer
```

| 维度 | fullTextSoFar | delta textBuffer |
|------|---------------|-----------------|
| 累积位置 | Provider 层（Host 侧） | WebView 层 |
| 丢失风险 | 无（Host 侧全量） | 有（WebView 切换/卸载时） |
| 传输量 | 较大（每次传全量） | 较小（只传增量） |
| 断点恢复 | 天然支持（全量快照） | 需要额外机制（hostMessage 对比） |
| 内容一致性 | 天然一致 | 需要防御（hostMessage vs buffer 取较长者） |

**Sarosis 的防御措施**：
- `onStreamComplete` 中取 `max(hostText.length, textBuffer.length)` 作为最终内容
- `CONTENT MISMATCH` 检测日志
- `resetStreamSilent()` + 原子提交避免中间态

### 3.2 IsRunningType 5 状态 vs boolean isStreaming

```
Void 状态流转:
  undefined → LLM → idle → tool → idle → LLM → ... → undefined

Sarosis 状态流转:
  false → true (isStreaming) → false
  (内部无法区分 LLM/tool/awaiting_user)
```

**关键问题**：Sarosis 的 `isStreaming=true` 期间，如果 LLM 输出结束、工具开始执行，会出现：
1. LLM 最后一帧 `onText` → `isStreaming=true, textBuffer=完整文本`
2. 工具开始执行 → 仍 `isStreaming=true`，但 `textBuffer` 不再增长
3. UI 层无法得知"LLM 已结束，工具正在执行"，只能靠 `toolCalls` 变化推断

**Void 的 `awaiting_user` 状态** 是 Sarosis 缺失的重要场景：
- 工具执行前需要用户审批（安全工具：文件删除、命令执行）
- Void 直接在 `streamState` 中表达，UI 显示审批按钮
- Sarosis 需要额外的 `ConfirmationCard` 机制，与 `isStreaming` 状态脱节

### 3.3 消息格式转换：集中式 vs 分布式+工具类

```
Void:
  SDK 流 → extractReasoningWrapper → extractXMLToolsWrapper → 统一 onText/onFinalMessage

Sarosis:
  SDK 流 → IModelDelta (per-provider) → IChatStreamDelta (统一) → StreamChunk (webview)
          ↑ formatAdapter.ts          ↑ messageProtocol.ts     ↑ streamHandler.ts
```

**Void 的集中式**：
- 2 个 wrapper 函数覆盖所有 provider
- 条件组合：仅当 `manuallyParseReasoning=true` 时加推理 wrapper，仅当 `!specialToolFormat` 时加 XML wrapper
- 缺点：XML wrapper 仅支持一种格式

**Sarosis 的分布式**：
- 每个 provider 自行将原始响应转换为 `IModelDelta`
- `MessageFormatConverter` 提供共享的格式转换工具
- `_tryExtractToolCallsFromText` 提供 7 种格式兜底
- 缺点：provider 间的转换逻辑不统一，inline 转换代码仍然存在

---

## 四、优缺点总结

### Void 的优势

1. **全量文本模式** — 消除增量累积的一致性风险
2. **5 状态精确表达** — UI 可精确响应 Agent 循环的每个阶段
3. **Wrapper 链模式** — 代码复用度高，条件组合灵活
4. **SDK 原生支持** — 类型安全、错误处理完善
5. **Discriminated union 类型安全** — 编译器可检查状态-数据关联

### Void 的劣势

1. **Bundle 体积大** — 多 SDK 依赖
2. **XML 工具解析单一** — 不支持 JSON/ReAct 等格式
3. **单线程聊天** — 不支持多 Agent 并行
4. **SidebarChat.tsx 过大** — 3000+ 行单文件，维护困难
5. **无虚拟滚动** — 消息量大时性能下降

### Sarosis 的优势

1. **零 SDK 依赖** — bundle 体积小，维护成本低
2. **7 种工具格式兜底** — 覆盖面广，适配开源模型能力强
3. **多 Agent 并行** — backgroundStreams + SubAgentCard
4. **StreamingBubble memo** — 性能优化到位
5. **InterleavedMarkdownRenderer** — 工具卡片嵌入 Markdown 流，视觉连贯
6. **原子提交** — 避免流式→提交的 UI 闪烁
7. **VS Code Copilot Chat 卡片** — references/progress/confirmation 等富内容
8. **声明式能力配置** — `IModelCapabilityConfig` 新增模型无需改代码

### Sarosis 的劣势

1. **增量累积风险** — WebView 侧 textBuffer 可能丢失
2. **状态模型粗糙** — boolean isStreaming 无法区分 LLM/tool/awaiting_user
3. **idle 闪断** — LLM 结束→工具开始之间可能 isStreaming=false
4. **去重逻辑过度** — loadHistoryForSession 3 层去重
5. **分布式转换残留** — MessageFormatConverter 已建但 inline 转换未完全迁移
6. **推理始终折叠** — 流式中无法观察推理过程

---

## 五、优化方案

### 方案 1：引入 StreamPhase 枚举替代 boolean isStreaming（优先级：高）

**目标**：精确表达 Agent 循环的每个阶段，消除 idle 闪断

```typescript
// 替代 boolean isStreaming
export type StreamPhase =
  | 'idle'              // 完全空闲
  | 'llm_streaming'     // LLM 正在流式输出
  | 'tool_executing'    // 工具正在执行
  | 'awaiting_approval' // 等待用户审批
  | 'compressing'       // 正在压缩上下文
  | 'error';            // 错误状态

export interface StreamState {
  phase: StreamPhase;
  // ... 其余字段不变
}
```

**改动点**：
- `streamHandler.ts`：`accumulateChunk()` 根据事件类型设置 `phase`
- `useChatStore.ts`：`syncEmployeeStatus()` 基于 `phase` 推导
- `EmployeeChat.tsx`：`StreamingBubble` 根据 `phase` 显示不同的加载指示器
- `agentOSService.ts`：在 yield 事件中嵌入 phase 信息

**预期收益**：
- UI 可精确显示"AI 正在思考..."、"正在执行命令..."、"等待您确认..."
- 消除 LLM→工具过渡期的 isStreaming 闪断
- `compressing` 状态替代独立的 `isCompressing` boolean

---

### 方案 2：Host 侧全量文本快照（优先级：高）

**目标**：解决增量累积的一致性风险，对齐 Void 的 fullTextSoFar 模式

```typescript
// 在 agentOSService 或 executionProvider 中维护全量快照
let fullTextSnapshot = '';
let fullThinkingSnapshot = '';

for await (const delta of modelStream) {
  if (delta.type === 'text') {
    fullTextSnapshot += delta.content;
    yield { type: 'text', content: delta.content, fullText: fullTextSnapshot };
  }
  if (delta.type === 'thinking') {
    fullThinkingSnapshot += delta.content;
    yield { type: 'thinking', content: delta.content, fullThinking: fullThinkingSnapshot };
  }
}
```

**改动点**：
- `IChatStreamDelta`：新增可选 `fullText` / `fullThinking` 字段
- `messageProtocol.ts`：透传新字段
- `streamHandler.ts`：优先使用 `fullText` 更新 `textBuffer`，回退到增量累积
- `useChatStore.ts`：`onStreamComplete` 中不再需要 `max(hostText, buffer)` 防御

**预期收益**：
- 消除 WebView 侧 textBuffer 与 Host 侧的 MISMATCH 风险
- 断点恢复：WebView 重载后可从 Host 获取全量快照
- 简化 `onStreamComplete` 中的防御逻辑

---

### 方案 3：流式推理展示优化（优先级：中）

**目标**：流式过程中可见推理内容，完成后自动折叠

**改动点**：
- `StreamingBubble`：thinking card 默认展开（与 Void 一致）
- `ChatMessage.tsx`：已提交消息的 thinking card 默认折叠
- 添加 `thinkingAutoCollapse` 逻辑：流式完成时（`onStreamComplete`）自动折叠

```typescript
// StreamingBubble
{thinkingBuffer && (
  <div className="thinking-card active expanded">
    <ThinkingCardHeader
      title="思考中..."
      spinner={true}
    />
    <ThinkingCardBody>
      <MarkdownRenderer content={thinkingBuffer} />
    </ThinkingCardBody>
  </div>
)}

// ChatMessage (已提交)
{message.thinking && (
  <ThinkingCard
    defaultCollapsed={true}  // 默认折叠
    content={message.thinking}
  />
)}
```

---

### 方案 4：统一 Provider 格式转换（优先级：中）

**目标**：完成 `MessageFormatConverter` 的全面迁移，消除 inline 转换

**改动点**：
- `builtInBYOKModelProvider.ts`：将所有 inline 的 `messages.map(...)` 替换为 `MessageFormatConverter.toOpenAI()`
- `geminiNativeModelProvider.ts`：已使用 `MessageFormatConverter.toGemini()`，保持一致
- 新增 Anthropic 原生 provider 时，直接使用 `MessageFormatConverter.toAnthropicFormat()`
- 在 `_tryExtractToolCallsFromText` 之前，优先检查 `IModelCapabilityConfig.specialToolFormat`：有原生格式则跳过文本提取

**预期收益**：
- 格式转换逻辑集中维护
- 新增 provider 只需调用 `MessageFormatConverter` + 声明 `capabilityConfig`
- 减少 `_tryExtractToolCallsFromText` 的调用频率（仅对无原生格式的模型使用）

---

### 方案 5：简化历史加载去重逻辑（优先级：低）

**目标**：`loadHistoryForSession` 的 3 层去重简化为 1 层

**改动点**：
- Host 侧保证消息 ID 唯一（`chat.history` 返回的消息不做重复持久化）
- WebView 侧仅按 `id` 去重，移除 content+timestamp 桶去重
- orchestration_plan 消息由 Host 侧统一管理，WebView 不再重新创建

**预期收益**：
- `loadHistoryForSession` 从 ~180 行降至 ~60 行
- 消除 "3 秒时间桶去重" 的潜在误判

---

## 六、优先级路线图

| 阶段 | 方案 | 预估工作量 | 收益 |
|------|------|-----------|------|
| Phase 1（1-2 周） | 方案 1：StreamPhase 枚举 | 3-4 天 | 消除 isStreaming 闪断，UI 状态精确 |
| Phase 1（1-2 周） | 方案 2：Host 侧全量快照 | 2-3 天 | 消除 textBuffer MISMATCH 风险 |
| Phase 2（1 个月） | 方案 3：推理展示优化 | 1-2 天 | UX 提升，对齐 Void |
| Phase 2（1 个月） | 方案 4：统一格式转换 | 3-4 天 | 代码质量，新增 provider 成本降低 |
| Phase 3（2-3 个月） | 方案 5：简化去重 | 1-2 天 | 代码可维护性 |

**总体策略**：先解决状态模型和一致性问题（Phase 1），再优化 UX 和代码质量（Phase 2），最后清理技术债（Phase 3）。
