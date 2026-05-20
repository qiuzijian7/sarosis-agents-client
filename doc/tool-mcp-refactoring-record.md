# Tool & MCP 架构重构记录

> 基于 OpenClaw 对比分析的 P0/P1 优化建议实施

---

## 重构概览

本次重构基于 `doc/tool-mcp-architecture-comparison.md` 中的优化建议，实施了以下关键改进：

### 实施的优化项

| 优先级 | 编号 | 优化项 | 状态 | 涉及文件 |
|--------|------|--------|------|----------|
| P0 | 10.1 | 工具执行超时机制 | ✅ 完成 | `toolExecutionGuard.ts` |
| P0 | 10.2 | 执行前审批机制 | ✅ 完成 | `toolExecutionGuard.ts`, `providers.ts` |
| P0 | 10.3 | 多 LLM Provider 工具格式适配 | ✅ 完成 | `toolFormatAdapters.ts` |
| P1 | 10.4 | 工具可用性声明式评估 | ✅ 完成 | `toolAvailabilityEvaluator.ts`, `providers.ts` |
| P1 | 10.5 | 多格式文本检测增强 | ✅ 完成 | `agentOSService.ts` |
| P1 | 10.6 | 结构化执行元数据 | ✅ 完成 | `providers.ts`, `builtinToolProvider.ts` |

---

## 1. 工具执行超时机制 (P0)

### 问题
当 MCP 服务器挂起或工具执行无限阻塞时，整个 Agent Loop 会卡死。

### 解决方案

**新增文件：** `src/vs/sessions/contrib/agentStudio/browser/toolExecutionGuard.ts`

```typescript
// 核心 API
async function executeWithTimeout(
  provider: IToolProvider,
  agentId: string,
  toolCall: IToolCall,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<IToolResult>
```

**关键设计：**
- 每个工具执行包装在 `AbortController` + `setTimeout` 中
- 超时后自动 abort 并返回带 `metadata.timedOut: true` 的失败结果
- 支持父级 signal 链接（Agent Loop 取消时所有工具自动取消）
- 根据工具类型动态调整超时：
  - 普通工具：60s
  - MCP 工具 / 慢速工具：120s
  - 危险工具（含审批等待）：300s

**集成点：** `agentOSService.ts` 的 `_executeToolCalls` 和 `_executeToolCallsParallel` 均已使用。

---

## 2. 执行前审批机制 (P0)

### 问题
所有工具直接执行，无法对危险操作（file_write, shell_exec）进行用户确认。

### 解决方案

**新增类型（`providers.ts`）：**
```typescript
enum ToolSecurityLevel { Safe, Cautious, Dangerous }

interface IToolApprovalRequest { ... }
enum ToolApprovalDecision { AllowOnce, AllowAlways, Deny }
interface IToolApprovalHandler { requestApproval(request): Promise<Decision> }
```

**新增服务（`toolExecutionGuard.ts`）：**
```typescript
class ToolApprovalService {
  setApprovalHandler(handler: IToolApprovalHandler): void;
  async checkAndApprove(toolCall, toolDef): Promise<boolean>;
  static inferSecurityLevel(toolDef): ToolSecurityLevel;
  reset(): void; // 新会话重置
}
```

**关键设计：**
- `Safe` 工具直接执行，无需确认
- `Cautious` 工具首次使用时询问
- `Dangerous` 工具每次询问
- "Allow Always" 决策会记忆到本会话结束（避免反复确认）
- 未注册 handler 时降级为允许（兼容无 UI 场景）
- `inferSecurityLevel()` 基于工具名/类别自动推断等级

**集成点：**
- `agentOSService.ts` 在 Step 3.5 执行审批检查
- `builtinToolProvider.ts` 的 `file_write` 已标记 `securityLevel: Dangerous`
- 公共 API `setToolApprovalHandler()` 供 UI 层注册

---

## 3. 多 LLM Provider 工具格式适配 (P0)

### 问题
当前仅支持 OpenAI Function Calling 格式，限制了模型选择。

### 解决方案

**新增文件：** `src/vs/sessions/contrib/agentStudio/browser/toolFormatAdapters.ts`

```typescript
interface IToolFormatAdapter {
  readonly providerId: string;
  formatToolsForRequest(tools: IToolDefinition[]): unknown[];
  parseToolCallDelta(delta: unknown): IToolCallDeltaParsed | null;
  formatToolResultMessage(result: IToolResult): IChatMessage;
  formatAssistantToolCallMessage(content: string, toolCalls: IToolCallInfo[]): unknown;
  normalizeSchema(schema: Record<string, unknown>): Record<string, unknown>;
}
```

**已实现的适配器：**

| 适配器 | 目标 API | Schema 处理 |
|--------|----------|-------------|
| `OpenAIToolFormatAdapter` | OpenAI / OpenRouter / DeepSeek / Ollama | strict mode + additionalProperties |
| `AnthropicToolFormatAdapter` | Anthropic Messages API | $ref 内联展开 |
| `GeminiToolFormatAdapter` | Google Gemini | 移除 $ref/$defs/additionalProperties |

**便利函数：**
```typescript
function getToolFormatAdapter(providerId: string): IToolFormatAdapter;
function inferToolFormatAdapter(baseUrl: string, modelId?: string): IToolFormatAdapter;
```

---

## 4. 工具可用性声明式评估 (P1)

### 问题
工具只有 enable/disable 开关，无法根据运行时条件自动判断可用性。

### 解决方案

**新增文件：** `src/vs/sessions/contrib/agentStudio/browser/toolAvailabilityEvaluator.ts`

**新增类型（`providers.ts`）：**
```typescript
interface IToolAvailability {
  readonly type: 'always' | 'config' | 'env' | 'platform' | 'custom';
  readonly condition?: string;
  readonly negate?: boolean;
}

interface IToolDefinition {
  // ... existing
  readonly availability?: IToolAvailability[];
}
```

**核心函数：**
```typescript
function evaluateToolAvailability(conditions, context): boolean;
function filterAvailableTools(tools, context): IToolDefinition[];
function explainAvailability(conditions, context): { available, reasons };
function createAvailabilityContext(options): IAvailabilityContext;
```

**使用示例：**
```typescript
// 声明：web_search 需要搜索 API key 配置
{
  name: 'web_search',
  availability: [
    { type: 'config', condition: 'sessions.agentStudio.searchApiKey' },
  ],
}

// 声明：shell_exec 仅在桌面端可用
{
  name: 'shell_exec',
  availability: [
    { type: 'platform', condition: 'desktop' },
  ],
}
```

---

## 5. 多格式文本检测增强 (P1)

### 问题
当前只检测 JSON 格式的文本 tool call，部分模型会输出 XML 或 Bracket 格式。

### 解决方案

在 `agentOSService.ts` 的 `_tryExtractToolCallsFromText` 中新增：

```
检测优先级：
1. JSON 代码块 (```json {...} ```)
2. 裸 JSON 对象 ({...})
3. XML 格式 (<tool_call>...</tool_call>)      ← 新增
4. Bracket 格式 ([TOOL_CALL]...[/TOOL_CALL])  ← 新增
5. ReAct 格式 (Action: ...\nAction Input: ...) ← 新增
6. Thinking 推断 (content=args, thinking=intent)
```

**新增方法：**
- `_extractToolCallsFromXml()` — 支持 tool_call / function_call / tool_use / invoke 标签
- `_extractToolCallsFromBrackets()` — 支持 TOOL_CALL / FUNCTION / TOOL / ACTION 标签
- `_extractToolCallsFromReAct()` — 支持 Action/Action Input 格式

---

## 6. 结构化执行元数据 (P1)

### 问题
`IToolResult` 仅有 success/error 二元状态，缺乏结构化元数据。

### 解决方案

**新增类型（`providers.ts`）：**
```typescript
interface IToolResultMetadata {
  readonly executionTimeMs?: number;
  readonly truncated?: boolean;
  readonly structuredContent?: unknown;
  readonly mcpServer?: string;
  readonly retryable?: boolean;
  readonly timedOut?: boolean;
}

interface IToolResult {
  // ... existing
  readonly metadata?: IToolResultMetadata;
}
```

**已集成的位置：**
- `builtinToolProvider.ts` — executeTool 返回 executionTimeMs
- `toolExecutionGuard.ts` — executeWithTimeout 补充 timedOut/executionTimeMs/retryable
- `agentOSService.ts` — 日志中输出执行耗时

---

## 7. 执行追踪器 (附加优化)

**新增类（`toolExecutionGuard.ts`）：**
```typescript
class ToolExecutionTracker {
  get activeCount(): number;
  get isFull(): boolean;
  track(toolCallId, toolName): AbortController;
  complete(toolCallId): number; // elapsed ms
  cancel(toolCallId): void;
  cancelAll(): void;
  getActiveExecutions(): { toolCallId, toolName, elapsedMs }[];
}
```

**用途：**
- 追踪并发工具执行数量
- 支持单个工具取消
- 支持全部取消（Agent Loop 停止时）
- 供 UI 展示当前正在执行的工具

---

## 文件变更总结

### 新增文件
| 文件 | 用途 |
|------|------|
| `browser/toolExecutionGuard.ts` | 超时保护 + 审批服务 + 执行追踪器 |
| `browser/toolFormatAdapters.ts` | 多 LLM Provider 工具格式适配器 |
| `browser/toolAvailabilityEvaluator.ts` | 声明式可用性评估 |

### 修改文件
| 文件 | 变更内容 |
|------|----------|
| `common/providers.ts` | 新增 ToolSecurityLevel / IToolAvailability / IToolApprovalHandler / IToolResultMetadata 等类型；IToolProvider.executeTool 增加 signal 参数；IToolDefinition 增加 securityLevel / availability 字段 |
| `browser/agentOSService.ts` | 集成超时/审批/追踪器；增强多格式文本检测（XML/Bracket/ReAct）；新增公共 API |
| `browser/providers/tool/builtinToolProvider.ts` | executeTool 支持 AbortSignal；添加 metadata 返回；file_write 标记 Dangerous |

---

## 后续待办 (P2)

以下优化项作为长期演进方向，待本次重构稳定后逐步实施：

1. **工具策略管线** — 参考 OpenClaw 7 层策略，逐步引入 Profile/Sender/Sandbox 策略
2. **MCP 连接池与健康检查** — 心跳检测 + 自动重连 + lease 计数保护
3. **工具执行进度回调** — `onUpdate` 回调机制，支持长时间运行工具报告进度
4. **在 BYOK Provider 中集成 ToolFormatAdapter** — 根据模型 ID 自动选择适配器
5. **Availability 自动过滤集成** — 在 listAllToolsWithState 中调用 filterAvailableTools

---

## 架构演进图

```
Before:
  AgentLoop → parse toolCalls → execute directly (no timeout, no approval)
                                  └─ provider.executeTool(agentId, call)

After:
  AgentLoop → parse toolCalls (JSON + XML + Bracket + ReAct)
           → approval check (securityLevel → Safe/Cautious/Dangerous)
           → executeWithTimeout(provider, call, timeout, loopSignal)
               ├─ AbortController + setTimeout
               ├─ provider.executeTool(agentId, call, signal)
               └─ return IToolResult with metadata { executionTimeMs, timedOut, retryable }
```
