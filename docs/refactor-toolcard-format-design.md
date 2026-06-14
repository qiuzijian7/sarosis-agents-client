# 工具卡重构设计文档

## 1. 背景与目标

### 1.1 当前问题
- **消息格式不统一**：当前 saros 项目消息格式（IModelDelta/IChatStreamDelta/StreamChunk）与 void 项目差异较大
- **工具卡耦合严重**：ToolCallCard 组件与特定消息格式耦合，难以扩展支持新格式
- **格式解析分散**：knot-agui 消息格式解析逻辑分散在共享代码中，不利于插件独立维护

### 1.2 重构目标
1. **以 void 项目消息格式为主**：统一消息格式定义，参考 void 的 ChatMessage/LLMChatMessage 设计
2. **工具卡支持多格式**：抽象工具卡渲染接口，兼容不同消息格式（AG-UI、Anthropic、OpenAI、XML等）
3. **knot-agui 格式解析插件化**：将 AG-UI 格式解析逻辑移到 knot-agui 扩展内部，实现插件自治

---

## 2. 消息格式架构设计

### 2.1 格式层次结构

```
┌─────────────────────────────────────────────────────────────┐
│                    UI 渲染层                              │
│  ToolCallCard (格式无关，接收 ToolCardData)                │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │
┌─────────────────────────────────────────────────────────────┐
│                  格式适配层 (Format Adapter)                │
│  - AG-UI Adapter (knot-agui 插件内部)                    │
│  - Anthropic Adapter                                       │
│  - OpenAI Adapter                                         │
│  - XML Adapter                                            │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │
┌─────────────────────────────────────────────────────────────┐
│                  统一消息格式 (Unified Message Format)       │
│  ChatMessage (参考 void 的 ChatMessage)                    │
│  - UserMessage                                            │
│  - AssistantMessage                                       │
│  - ToolMessage                                            │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │
┌─────────────────────────────────────────────────────────────┐
│                  LLM 原始格式 (LLM Raw Format)             │
│  - AnthropicLLMChatMessage                                │
│  - OpenAILLMChatMessage                                  │
│  - GeminiLLMChatMessage                                  │
│  - AGUIMessage (Knot)                                    │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 统一消息格式定义

参考 void 项目的 `ChatMessage` 和 `ToolMessage`，定义 saros 的统一消息格式：

```typescript
// src/vs/sessions/contrib/agentStudio/common/chatTypes.ts

// ============================================================================
// 统一消息格式（Internal Message Format）
// 参考 void 项目的 ChatMessage 设计
// ============================================================================

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | ToolMessage
  | SystemMessage
  | CheckpointMessage;

// 用户消息
export interface UserMessage {
  role: 'user';
  content: string;              // 发送给 LLM 的内容
  displayContent: string;        // 显示给用户的内容
  selections: SelectionItem[] | null;
  timestamp: number;
}

// 助手消息
export interface AssistantMessage {
  role: 'assistant';
  content: string;              // 文本内容
  reasoning: string;            // 推理内容（非思考链）
  thinking: ThinkingBlock[];    // 思考链（Anthropic 格式）
  timestamp: number;
}

// 思考块（Anthropic 格式）
export interface ThinkingBlock {
  type: 'thinking' | 'redacted_thinking';
  thinking?: string;
  signature?: string;
  data?: string;                // redacted_thinking 的数据
}

// 工具消息
export interface ToolMessage {
  role: 'tool';
  id: string;                  // 工具调用 ID
  name: string;                // 工具名称
  params: Record<string, unknown>; // 工具参数（已解析）
  rawParams: Record<string, string | undefined>; // 原始参数字符串
  result: ToolResult | null;   // 工具执行结果
  status: ToolMessageStatus;    // 工具状态
  error?: string;               // 错误信息
  mcpServerName?: string;      // MCP 服务器名称
  timestamp: number;
}

// 工具消息状态（参考 void 的 ToolMessage type）
export type ToolMessageStatus =
  | 'invalid_params'     // 参数无效
  | 'pending';           // 等待执行（可能需要审批）
  | 'running'            // 执行中
  | 'success'            // 执行成功
  | 'error'              // 执行错误
  | 'rejected'           // 用户拒绝
  | 'cancelled';        // 已取消

// 工具执行结果
export interface ToolResult {
  content: ToolResultContent[];
  metadata?: ToolResultMetadata;
}

export interface ToolResultContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;              // base64 or URI
  mimeType?: string;
}

export interface ToolResultMetadata {
  executionTimeMs?: number;
  truncated?: boolean;
  mcpServer?: string;
  retryable?: boolean;
  timedOut?: boolean;
}

// 系统消息
export interface SystemMessage {
  role: 'system';
  content: string;
  timestamp: number;
}

// 检查点消息
export interface CheckpointMessage {
  role: 'checkpoint';
  type: 'user_edit' | 'tool_edit';
  fileSnapshots: Record<string, FileSnapshot>;
  timestamp: number;
}

// 选择项
export interface SelectionItem {
  type: 'File' | 'CodeSelection' | 'Folder';
  uri: URI;
  language?: string;
  range?: [number, number];
  state: { wasAddedAsCurrentFile: boolean };
}
```

### 2.3 LLM 原始格式定义

参考 void 项目的 `LLMChatMessage`，定义支持的 LLM 原始格式：

```typescript
// src/vs/sessions/contrib/agentStudio/common/llmMessageTypes.ts

// ============================================================================
// LLM 原始消息格式（Provider-Specific Format）
// 参考 void 项目的 LLMChatMessage 设计
// ============================================================================

// Anthropic 格式
export interface AnthropicLLMChatMessage {
  role: 'assistant';
  content: string | AnthropicContentBlock[];
} | {
  role: 'user';
  content: string | AnthropicUserContentBlock[];
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, any>; id: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

export type AnthropicUserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: string };

// OpenAI 格式
export interface OpenAILLMChatMessage {
  role: 'system' | 'user' | 'developer';
  content: string;
} | {
  role: 'assistant';
  content: string | OpenAIContentBlock[];
  tool_calls?: OpenAIToolCall[];
} | {
  role: 'tool';
  content: string;
  tool_call_id: string;
}

export type OpenAIContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; reasoning: string };

export interface OpenAIToolCall {
  type: 'function';
  id: string;
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

// Gemini 格式
export interface GeminiLLMChatMessage {
  role: 'model';
  parts: GeminiPart[];
} | {
  role: 'user';
  parts: GeminiPart[];
}

export type GeminiPart =
  | { text: string }
  | { functionCall: { id: string; name: string; args: Record<string, unknown> } }
  | { functionResponse: { id: string; name: string; response: { output: string } } };

// AG-UI 格式（Knot）
export interface AGUIMessage {
  role: 'assistant';
  content: string;
  tool_calls?: AGUIToolCall[];
} | {
  role: 'tool';
  content: string;
  tool_call_id: string;
}

export interface AGUIToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
  display_name?: string;
  render_type?: string;
  server_executed?: boolean;
}

// 联合类型
export type LLMChatMessage =
  | AnthropicLLMChatMessage
  | OpenAILLMChatMessage
  | GeminiLLMChatMessage
  | AGUIMessage;
```

---

## 3. 工具卡渲染架构设计

### 3.1 工具卡数据接口（格式无关）

抽象出格式无关的工具卡数据接口，使 ToolCallCard 组件不依赖特定消息格式：

```typescript
// src/vs/sessions/contrib/agentStudio/webview/src/features/chat/types.ts

// ============================================================================
// 工具卡数据接口（格式无关）
// ============================================================================

export interface ToolCardData {
  id: string;                    // 工具调用 ID
  name: string;                  // 工具名称
  displayName?: string;           // 显示名称
  renderType?: string;            // 渲染类型（RunTerminal/CodeApply/ListItems等）
  status: ToolCardStatus;         // 工具卡状态
  params?: Record<string, unknown>; // 工具参数
  result?: ToolCardResult;        // 工具执行结果
  error?: string;                 // 错误信息
  isExpanded?: boolean;           // 是否展开
  timestamp?: number;             // 时间戳
}

export type ToolCardStatus =
  | 'pending'             // 等待执行（可能需要审批）
  | 'approval_required'   // 需要审批
  | 'running'             // 执行中
  | 'success'             // 执行成功
  | 'error'               // 执行错误
  | 'rejected'            // 用户拒绝
  | 'cancelled';         // 已取消

export interface ToolCardResult {
  content: ToolCardResultContent[];
  metadata?: ToolCardResultMetadata;
}

export interface ToolCardResultContent {
  type: 'text' | 'image' | 'resource' | 'list_item' | 'terminal_output';
  text?: string;
  data?: string;
  mimeType?: string;
  // 列表项特定字段
  items?: ToolCardListItem[];
  // 终端输出特定字段
  command?: string;
  output?: string;
  exitCode?: number;
}

export interface ToolCardListItem {
  type: 'file' | 'directory' | 'search_result';
  name: string;
  path: string;
  content?: string;
  // ... 其他字段
}

export interface ToolCardResultMetadata {
  executionTimeMs?: number;
  truncated?: boolean;
  mcpServer?: string;
}
```

### 3.2 工具卡渲染器接口

参考 void 项目的 `ChatToolInvocationPart`，抽象出工具卡渲染器：

```typescript
// src/vs/sessions/contrib/agentStudio/webview/src/features/chat/ToolCardRenderer.ts

// ============================================================================
// 工具卡渲染器接口
// 参考 void 项目的 ChatToolInvocationPart 设计
// ============================================================================

export interface IToolCardRenderer {
  /**
   * 渲染工具卡头部
   */
  renderHeader(toolData: ToolCardData): React.ReactNode;

  /**
   * 渲染工具卡主体内容
   */
  renderContent(toolData: ToolCardData): React.ReactNode;

  /**
   * 渲染工具卡操作按钮
   */
  renderActions(toolData: ToolCardData): React.ReactNode;
}

// 默认工具卡渲染器（通用）
export class DefaultToolCardRenderer implements IToolCardRenderer {
  renderHeader(toolData: ToolCardData): React.ReactNode {
    // 默认头部：工具名称 + 状态图标
    return <DefaultToolHeader toolData={toolData} />;
  }

  renderContent(toolData: ToolCardData): React.ReactNode {
    // 根据 renderType 选择不同渲染器
    switch (toolData.renderType) {
      case 'RunTerminal':
        return <TerminalToolContent toolData={toolData} />;
      case 'CodeApply':
      case 'EditFile':
        return <CodeApplyToolContent toolData={toolData} />;
      case 'ListItems':
      case 'ListFiles':
        return <ListItemsToolContent toolData={toolData} />;
      default:
        return <GenericToolContent toolData={toolData} />;
    }
  }

  renderActions(toolData: ToolCardData): React.ReactNode {
    // 根据状态显示不同操作按钮
    if (toolData.status === 'approval_required') {
      return <ApprovalActions toolData={toolData} />;
    }
    return null;
  }
}

// 注册表：renderType -> Renderer
export const toolCardRendererRegistry = new Map<string, IToolCardRenderer>();

export function registerToolCardRenderer(renderType: string, renderer: IToolCardRenderer): void {
  toolCardRendererRegistry.set(renderType, renderer);
}
```

### 3.3 ToolCallCard 组件重构

重构 ToolCallCard 组件，使其使用抽象接口而非特定格式：

```tsx
// src/vs/sessions/contrib/agentStudio/webview/src/features/chat/ToolCallCard.tsx

// 重构后的 ToolCallCard 组件
export const ToolCallCard: React.FC<ToolCallCardProps> = (props) => {
  const { toolData, onApprove, onReject, onToggleExpand } = props;

  // 获取渲染器（从注册表或默认）
  const renderer = toolCardRendererRegistry.get(toolData.renderType || 'default')
    || new DefaultToolCardRenderer();

  // 渲染
  return (
    <div className="tool-call-card" data-status={toolData.status}>
      {/* 头部 */}
      <div className="tool-call-card-header">
        {renderer.renderHeader(toolData)}
      </div>

      {/* 主体内容（可折叠）*/}
      {toolData.isExpanded && (
        <div className="tool-call-card-content">
          {renderer.renderContent(toolData)}
        </div>
      )}

      {/* 操作按钮 */}
      <div className="tool-call-card-actions">
        {renderer.renderActions(toolData)}
      </div>
    </div>
  );
};

interface ToolCallCardProps {
  toolData: ToolCardData;
  onApprove?: (toolCallId: string) => void;
  onReject?: (toolCallId: string) => void;
  onToggleExpand?: (toolCallId: string) => void;
}
```

---

## 4. 格式适配层设计

### 4.1 格式适配器接口

定义格式适配器接口，将不同 LLM 格式转换为统一消息格式：

```typescript
// src/vs/sessions/contrib/agentStudio/common/formatAdapter.ts

// ============================================================================
// 格式适配器接口
// ============================================================================

export interface IFormatAdapter<T> {
  /**
   * 将 LLM 原始格式转换为统一消息格式
   */
  toUnifiedFormat(rawMessage: T): ChatMessage;

  /**
   * 将统一消息格式转换为 LLM 原始格式
   */
  fromUnifiedFormat(message: ChatMessage): T;
}

// Anthropic 格式适配器
export class AnthropicFormatAdapter implements IFormatAdapter<AnthropicLLMChatMessage> {
  toUnifiedFormat(rawMessage: AnthropicLLMChatMessage): ChatMessage {
    // 实现转换逻辑
  }

  fromUnifiedFormat(message: ChatMessage): AnthropicLLMChatMessage {
    // 实现转换逻辑
  }
}

// OpenAI 格式适配器
export class OpenAIFormatAdapter implements IFormatAdapter<OpenAILLMChatMessage> {
  // ...
}

// Gemini 格式适配器
export class GeminiFormatAdapter implements IFormatAdapter<GeminiLLMChatMessage> {
  // ...
}

// XML 格式适配器（用于解析模型输出的 XML 格式工具调用）
export class XmlFormatAdapter implements IFormatAdapter<string> {
  /**
   * 从模型输出的 XML 文本中提取工具调用
   */
  toUnifiedFormat(xmlText: string): ChatMessage {
    // 解析 <tool_call> 或 <function_call> 等 XML 格式
  }

  fromUnifiedFormat(message: ChatMessage): string {
    // 将统一格式转换为 XML 格式（用于不支持原生工具调用的模型）
  }
}
```

### 4.2 knot-agui 插件内的 AG-UI 格式适配器

将 AG-UI 格式适配器移到 knot-agui 扩展内部：

```
extensions/knot-agui/
  src/
    formatAdapter/
      AGUIFormatAdapter.ts      // AG-UI 格式适配器
      types.ts                  // AG-UI 类型定义
    extension.ts               // 扩展入口（使用 AGUIFormatAdapter）
```

```typescript
// extensions/knot-agui/src/formatAdapter/AGUIFormatAdapter.ts

import { IFormatAdapter } from '../../../../src/vs/sessions/contrib/agentStudio/common/formatAdapter';
import { ChatMessage } from '../../../../src/vs/sessions/contrib/agentStudio/common/chatTypes';
import { AGUIMessage } from './types';

export class AGUIFormatAdapter implements IFormatAdapter<AGUIMessage[]> {
  toUnifiedFormat(rawMessages: AGUIMessage[]): ChatMessage[] {
    // 将 AG-UI 格式转换为统一消息格式
    return rawMessages.map(msg => this.convertMessage(msg));
  }

  fromUnifiedFormat(messages: ChatMessage[]): AGUIMessage[] {
    // 将统一消息格式转换为 AG-UI 格式
    return messages.map(msg => this.convertMessageBack(msg));
  }

  private convertMessage(msg: AGUIMessage): ChatMessage {
    // 实现单个消息的转换
    if (msg.role === 'assistant') {
      return {
        role: 'assistant',
        content: msg.content,
        reasoning: '',
        thinking: [],
        timestamp: Date.now(),
      };
    }
    // ...
  }
}
```

---

## 5. 数据流重构

### 5.1 当前数据流（需重构）

```
[Model Provider] 
    ↓ IModelDelta
[AgentOS Service / Execution Provider]
    ↓ IChatStreamDelta  
[WebView StreamHandler]
    ↓ StreamChunk → StreamState
[React UI - ToolCallCard]
```

### 5.2 重构后数据流

```
[Model Provider (Knot/Anthropic/OpenAI/etc)] 
    ↓ LLM Raw Format (AG-UI/Anthropic/OpenAI/Gemini)
[Format Adapter (插件内或共享)]
    ↓ ChatMessage (统一格式)
[AgentOS Service]
    ↓ ChatMessage + ToolCardData
[WebView StreamHandler]
    ↓ StreamChunk → StreamState (包含 ToolCardData)
[React UI - ToolCallCard (格式无关)]
```

### 5.3 详细数据流说明

#### 阶段 1：Model Provider → Format Adapter
- **Knot AG-UI**：扩展内部使用 `AGUIFormatAdapter` 将 AG-UI 事件转换为 `ChatMessage`
- **Anthropic API**：使用 `AnthropicFormatAdapter` 将 Anthropic 响应转换为 `ChatMessage`
- **OpenAI API**：使用 `OpenAIFormatAdapter` 将 OpenAI 响应转换为 `ChatMessage`

#### 阶段 2：Format Adapter → AgentOS Service
- AgentOS Service 接收 `ChatMessage[]`，进行管理（存储、历史记录等）
- 当需要执行工具时，AgentOS Service 从 `ToolMessage` 中提取工具调用信息，调用工具执行

#### 阶段 3：AgentOS Service → Webview
- AgentOS Service 将 `ChatMessage` 转换为 `StreamChunk`（或直接使用 `ToolCardData`）
- 通过 `IChatStreamDelta` 协议发送到 webview

#### 阶段 4：Webview → React UI
- `StreamHandler` 接收 `StreamChunk[]`，累积到 `StreamState`
- `ToolCallCard` 组件从 `StreamState` 中读取 `ToolCardData[]`，进行渲染

---

## 6. 实施计划

### 6.1 阶段 1：定义统一消息格式（1-2 天）
- [ ] 创建 `chatTypes.ts`，定义 `ChatMessage` 等统一消息格式
- [ ] 创建 `llmMessageTypes.ts`，定义 LLM 原始格式
- [ ] 更新 `providers.ts`，将现有接口迁移到新格式（保持向后兼容）

### 6.2 阶段 2：实现格式适配器（2-3 天）
- [ ] 实现 `AnthropicFormatAdapter`
- [ ] 实现 `OpenAIFormatAdapter`
- [ ] 实现 `GeminiFormatAdapter`
- [ ] 实现 `XmlFormatAdapter`（从 `agentOSService.ts` 中提取逻辑）
- [ ] 将 `AGUIFormatAdapter` 移到 `extensions/knot-agui/src/formatAdapter/`

### 6.3 阶段 3：重构工具卡组件（2-3 天）
- [ ] 定义 `ToolCardData` 接口（`types.ts`）
- [ ] 实现 `DefaultToolCardRenderer` 和注册表
- [ ] 重构 `ToolCallCard.tsx` 使用 `ToolCardData`
- [ ] 将现有渲染逻辑（ListItems/RunTerminal/CodeApply/GenericToolCallCard）迁移到渲染器

### 6.4 阶段 4：更新数据流（3-4 天）
- [ ] 更新 `agentOSService.ts` 使用新的格式适配器
- [ ] 更新 `executionProvider.ts` 使用 `ChatMessage` 格式
- [ ] 更新 `streamHandler.ts` 支持 `ToolCardData`
- [ ] 更新 `knot-agui/extension.ts` 使用 `AGUIFormatAdapter`

### 6.5 阶段 5：测试与优化（2-3 天）
- [ ] 测试 Knot AG-UI 格式
- [ ] 测试 Anthropic 格式
- [ ] 测试 OpenAI 格式
- [ ] 测试 XML 格式
- [ ] 性能优化

---

## 7. 风险与缓解措施

### 7.1 风险
1. **向后兼容性**：重构可能破坏现有功能
2. **性能影响**：增加格式转换层可能影响性能
3. **复杂度增加**：引入适配器模式增加代码复杂度

### 7.2 缓解措施
1. **渐进式重构**：保留旧接口，逐步迁移，确保每一步都可回滚
2. **性能测试**：在关键路径添加性能测试，确保转换层不会成为瓶颈
3. **文档和示例**：为新架构编写详细文档和示例，降低理解成本

---

## 8. 附录

### 8.1 参考资料
- Void 项目消息格式：`G:\CustomWorkspaces\AIProjects\void\src\vs\workbench\contrib\void\common\sendLLMMessageTypes.ts`
- Void 项目工具消息：`G:\CustomWorkspaces\AIProjects\void\src\vs\workbench\contrib\void\common\chatThreadServiceTypes.ts`
- Sarosis 项目当前消息格式：`G:\CustomWorkspaces\AIProjects\saros-agents-client\src\vs\sessions\contrib\agentStudio\common\providers.ts`

### 8.2 相关文件清单
| 文件 | 当前职责 | 重构后职责 |
|------|----------|--------------|
| `chatTypes.ts` (新建) | - | 定义统一消息格式 `ChatMessage` |
| `llmMessageTypes.ts` (新建) | - | 定义 LLM 原始格式 |
| `formatAdapter.ts` (新建) | - | 定义格式适配器接口和基础实现 |
| `ToolCallCard.tsx` | 渲染工具卡（耦合特定格式） | 渲染工具卡（使用 `ToolCardData` 接口）|
| `agentOSService.ts` | 解析模型输出中的工具调用 | 使用格式适配器解析工具调用 |
| `knot-agui/extension.ts` | 处理 AG-UI 事件 | 使用 `AGUIFormatAdapter` 转换格式 |
