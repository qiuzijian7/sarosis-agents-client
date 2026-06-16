# Native 聊天框对标 React 版完善方案

> 生成时间：2026-06-16  
> 目标：将 `AgentChatPanel` (native) 的功能对标 React webview 版，消除核心体验差距

---

## 一、当前差距总结

| 类别 | 缺失数 | 关键差距 |
|------|--------|---------|
| P0 严重影响体验 | 8 | 交织渲染、5态状态机、斜杠菜单、Hermes回合聚合、上下文圆环、代码高亮/折叠/复制 |
| P1 功能性缺失 | 12 | SubAgent完整版、四级审批、图片Lightbox、编排/工作流卡片、错误重试 |
| P2 增强体验 | 15 | Markdown预处理、终端卡片、KV Cache、背景流等 |

---

## 二、分阶段实施计划

### Phase 1：流式渲染内核升级（P0 核心体验）

> 目标：让流式输出的视觉表现与 React 版一致

#### 1.1 5态 StreamPhase 状态机

**现状**：Native 仅用 `boolean isStreaming` + `currentStep` 字符串  
**React**：`StreamPhase = 'idle' | 'llm_streaming' | 'tool_executing' | 'awaiting_approval' | 'compressing' | 'error'`

**改动**：

- `agentChatTypes.ts` — 新增 `StreamPhase` 类型
  ```ts
  export type StreamPhase = 'idle' | 'llm_streaming' | 'tool_executing' | 'awaiting_approval' | 'compressing' | 'error';
  ```
- `agentChatPanel.ts` — 新增 `_streamPhase: StreamPhase` 状态字段
- `agentChatPanel.ts` — 新增 `setStreamPhase(phase: StreamPhase)` 公开方法
- `_createMessageElement` — 根据 `StreamPhase` 渲染不同的 step-indicator：
  - `llm_streaming` → "AI 正在输出..." + 打字动画
  - `tool_executing` → "正在执行工具..." + 旋转图标
  - `awaiting_approval` → "等待您确认..." + 高亮确认卡
  - `compressing` → "正在压缩上下文..."
  - `error` → 错误样式
- `chatBarPart.ts` — `_handleSendMessage` delta 处理增加 `phase_change` 到 `setStreamPhase` 的映射
- `chatBarPart.ts` — 头部 status dot 根据 StreamPhase 变化动画

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/parts/chatBarPart.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

#### 1.2 InterleavedMarkdownRenderer — 工具卡交织渲染

**现状**：Native 的 `_createMessageElement` 将内容先渲染，工具卡追加在末尾  
**React**：`InterleavedMarkdownRenderer` 按 `textPosition` 将 ToolCallCard 穿插在 Markdown 中

**改动**：

- `agentChatTypes.ts` — `IToolCall` 增加 `textPosition?: number` 字段
- `agentChatPanel.ts` — 新增 `_renderInterleavedContent(bubble, content, toolCalls)` 方法：
  1. 将 `content` 文本按 `toolCalls[].textPosition` 切分成片段
  2. 在每个片段间插入对应的 `_createToolCallCard()`
  3. 无 `textPosition` 的 toolCalls 仍追加在末尾（兼容旧数据）
- `_createMessageElement` — 助手消息调用 `_renderInterleavedContent` 替代现有的"先内容后工具"逻辑
- `chatBarPart.ts` — `tool_start` delta 回调中传递 `textPosition`（取自 `delta.textPosition` 或当前 `assistantMsg.content.length`）

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/parts/chatBarPart.ts`

---

#### 1.3 代码语法高亮 + 折叠 + 复制按钮

**现状**：Native 用 VS Code 内置 `renderMarkdown` + `codeBlockRenderer` 返回纯 `<pre><code>`  
**React**：`react-syntax-highlighter` + 30行自动折叠 + 复制按钮

**改动**：

- `agentChatPanel.ts` — 重写 `codeBlockRenderer`：
  1. 使用 VS Code 内置的 `tokenizeToString` (from `vs/editor/common/languages`) 进行基础语法高亮
  2. 代码块超 30 行时添加 `.code-block-collapsed` + 折叠/展开按钮
  3. 每个代码块右上角添加复制按钮（`ClipboardService` 写入）
- `agentChat.css` — 新增样式：
  - `.code-block-wrapper` 容器 + 头部（语言标签 + 复制按钮）
  - `.code-block-expand-btn` / `.code-block-collapse-btn`
  - `.code-block-collapsed` 只显示前 15 行 + 渐隐遮罩
- `agentChatPanel.ts` — `_renderMarkdownContent` 改用自定义 wrapper

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

#### 1.4 Hermes 回合聚合

**现状**：同一 `turnId` 的多条助手消息各自独立显示  
**React**：`displayMessages` 计算属性将相邻同 `turnId` 的助手消息合并为一个气泡

**改动**：

- `agentChatTypes.ts` — `IAgentChatMessage` 增加 `turnId?: string` 字段
- `agentChatPanel.ts` — `setMessages()` 中添加预处理步骤 `_aggregateTurns()`：
  - 遍历消息列表，将连续相同 `turnId` 的助手消息合并：
    - `content` 按顺序拼接
    - `toolCalls` 按顺序合并，保留各自 `textPosition`（相对于合并后 content 的偏移）
    - 保留最后一个消息的 `tokenUsage`、`timestamp`
  - 合并后的消息 id 采用 `turn-{turnId}`
- `chatBarPart.ts` — `_adaptChatMessage` 传递 `turnId` 字段

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/parts/chatBarPart.ts`

---

#### 1.5 上下文使用量圆环增强

**现状**：已有 `_renderContextUsageRing` 基础实现  
**React**：70% warn / 90% danger 配色 + 压缩后回落 + 三层更新

**改动**：

- `agentChatPanel.ts` — `_updateContextRing()` 增强：
  - 70%-89%: 黄色 warn 填充
  - 90%-100%: 红色 danger 填充
  - 增加 `compactedBaseline` 字段，当有压缩信号时用其替代 used 值
- `agentChatPanel.ts` — 新增 `setCompactedBaseline(baseline: number)` 方法
- `chatBarPart.ts` — `context_compacted` delta 调用 `panel.setCompactedBaseline()`
- `agentChat.css` — 圆环 `.warn` / `.danger` 动态 class 样式

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/parts/chatBarPart.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

### Phase 2：输入区增强（P0/P1 交互体验）

> 目标：输入区功能对标 React ChatComposer

#### 2.1 斜杠菜单系统

**现状**：仅检测 `/skill` 模式并改色，无菜单弹出  
**React**：输入 `/` 弹出统一菜单，含技能 + 命令，支持 ↑↓/Enter/Esc/Tab/实时过滤

**改动**：

- `agentChatPanel.ts` — 新增 `_slashMenuEl` / `_slashMenuItems` / `_slashMenuIndex` 状态
- 新增 `_openSlashMenu(filter: string)` 方法：
  - 从 `_onListSkills` 回调获取可用技能列表
  - 渲染 `.slash-menu` 浮动层，定位在 textarea 上方
  - 每个 item 显示图标 + 名称 + 描述
  - ↑↓ 导航 + Enter 选择 + Esc 关闭
  - 选中后插入 `/skill <id> ` 到 textarea
- `agentChatPanel.ts` — textarea input 事件增强：
  - 光标前文本匹配 `/` 开头时调用 `_openSlashMenu(filter)`
  - 非 `/` 开头时关闭菜单
- 新增回调：`onListSkills?: () => Promise<Array<{ id: string; name: string; description: string }>>`
- `chatBarPart.ts` — 实现回调，调用 `_skillRegistry.getSkills()`
- `agentChat.css` — `.slash-menu` / `.slash-menu-item` / `.slash-menu-item.selected` 样式

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/parts/chatBarPart.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

#### 2.2 图片粘贴/拖放增强 + Lightbox 预览

**现状**：基础附件添加，无图片缩放/缩略图/全屏预览  
**React**：自动缩放(2048×768) + 缩略图网格 + Lightbox 全屏

**改动**：

- `agentChatPanel.ts` — `_addFiles()` 增强：
  - 图片文件自动缩放（Canvas resize to max 2048×768）
  - 生成缩略图 URL（`URL.createObjectURL`）
  - 大小限制：图片 10MB / 文件 30MB / 总计 30MB
- `_renderAttachmentPreviews()` 增强：
  - 图片附件渲染为缩略图网格
  - 点击缩略图打开 Lightbox
- 新增 `_renderLightbox(src: string)` 方法：
  - 全屏 `.lightbox-overlay` + 居中 `<img>` + 关闭按钮
  - 点击 overlay / Esc 关闭
- 消息内图片附件渲染：`_createMessageElement` 中用户消息渲染图片缩略图
- `agentChat.css` — `.lightbox-overlay` / `.attachment-thumb-grid` 样式

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

#### 2.3 输入区高度拖动调整

**现状**：固定最大高度 120px  
**React**：拖动顶部分割线，100-500px 可调

**改动**：

- `agentChatPanel.ts` — 在 composer-box 顶部添加 `.composer-resize-handle`
- 鼠标拖动动态调整 textarea 高度（`mousedown → mousemove → mouseup`）
- 限制范围：100-500px
- `agentChat.css` — `.composer-resize-handle` 样式（拖动条 + hover 高亮）

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

### Phase 3：卡片组件增强（P1 功能对齐）

> 目标：所有卡片组件达到 React 版功能水平

#### 3.1 SubAgentCard 完整版

**现状**：简单状态展示（icon + 名称 + 状态 + task + output）  
**React**：4种内嵌 block（InputBlock / ThinkingBlock / ToolTraceBlock / OutputBlock）+ 并行分组 + 自动折叠

**改动**：

- `agentChatTypes.ts` — `ISubAgentData` 扩展：
  ```ts
  export interface ISubAgentData {
    // ... 现有字段 ...
    inputBlocks?: Array<{ id: string; title: string; content: string; collapsed: boolean }>;
    thinkingBlocks?: Array<{ id: string; content: string; collapsed: boolean }>;
    toolTraces?: Array<{ id: string; name: string; status: string; args?: string; result?: string }>;
    outputBlocks?: Array<{ id: string; content: string; collapsed: boolean }>;
  }
  ```
- `agentChatPanel.ts` — 重写 `_createSubAgentCard()`：
  1. 按 `groupId` 分组渲染（同组并行显示）
  2. 每个子 Agent 卡片含：头部（类型/状态/任务摘要）+ 折叠体
  3. 折叠体内按序渲染：InputBlock → ThinkingBlock → ToolTraceBlock → OutputBlock
  4. 流式时自动展开 OutputBlock，完成后自动折叠
- `agentChat.css` — `.subagent-input-block` / `.subagent-thinking-block` / `.subagent-tool-trace` / `.subagent-output-block` 样式

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

#### 3.2 ConfirmationCard 四级审批策略

**现状**：仅 `approved`/`rejected` 两个状态  
**React**：`safe`/`cautious`/`dangerous` 安全等级 + `allow_once`/`allow_session`/`allow_workspace`/`allow_always` 四级

**改动**：

- `agentChatTypes.ts` — `IConfirmationData` 扩展：
  ```ts
  export interface IConfirmationData {
    // ... 现有字段 ...
    securityLevel?: 'safe' | 'cautious' | 'dangerous';
    autoConfirmOptions?: Array<{
      id: string;  // 'allow_once' | 'allow_session' | 'allow_workspace' | 'allow_always'
      label: string;
    }>;
  }
  ```
- `agentChatPanel.ts` — `_createConfirmationCard()` 增强：
  1. 头部增加安全等级徽章（safe=绿 / cautious=黄 / dangerous=红）
  2. 操作按钮区：主操作按钮 + 四级自动确认下拉
  3. 自动确认选择后同时回调 `_onConfirmationAction(confirmationId, autoConfirmOptionId)`
- `chatBarPart.ts` — `_handleSendMessage` 增加 `tool_approval_request` / `tool_approval_resolved` delta 处理
- `agentChat.css` — `.security-badge` / `.auto-confirm-dropdown` 样式

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/parts/chatBarPart.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

#### 3.3 错误重试 + 结构化错误显示

**现状**：错误仅以 `⚠` 前缀文本追加到 content  
**React**：`StreamError` 结构化（level/retryable/isRateLimited/isQuotaExceeded）+ Retry 按钮

**改动**：

- `agentChatTypes.ts` — 新增 `IStreamError` 接口：
  ```ts
  export interface IStreamError {
    message: string;
    level: 'info' | 'warning' | 'error';
    retryable?: boolean;
    isRateLimited?: boolean;
    isQuotaExceeded?: boolean;
  }
  ```
- `IAgentChatMessage` 扩展：`streamError?: IStreamError`
- `agentChatPanel.ts` — `_createMessageElement()` 错误区域增强：
  1. 渲染结构化错误卡片（level 对应图标/颜色）
  2. 速率限制 → 倒计时提示
  3. 可重试 → Retry 按钮（回调 `_onRetry?.(messageId)`）
- 新增回调：`onRetry?: (messageId: string) => void`
- `chatBarPart.ts` — 实现回调，重新发送上一条用户消息
- `agentChat.css` — `.chat-error-card` / `.chat-error-retry-btn` 样式

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/parts/chatBarPart.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

#### 3.4 ThinkingCard 增强 — Markdown 渲染思考内容

**现状**：思考体用纯文本 `textContent`  
**React**：思考内容用 Markdown 渲染

**改动**：

- `agentChatPanel.ts` — `_createThinkingCard()` body 部分改用 `_renderMarkdownContent(body, msg.thinking)` 替代 `body.textContent = msg.thinking`

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`

---

### Phase 4：编排/工作流交互卡片（P1 扩展功能）

> 目标：接入编排系统和工作流交互

#### 4.1 OrchestrationPlanInline 卡片

**现状**：无  
**React**：气泡内嵌计划审批面板，显示目标/摘要/任务列表/角色标签/执行统计 + 批准/拒绝按钮

**改动**：

- `agentChatTypes.ts` — 新增 `IOrchestrationPlan` 接口：
  ```ts
  export interface IOrchestrationPlan {
    id: string;
    goal: string;
    summary: string;
    tasks: Array<{ id: string; title: string; status: string; assignee?: string }>;
    roles?: string[];
    stats?: { total: number; completed: number; failed: number };
  }
  ```
- `IAgentChatMessage` 扩展：`orchestrationPlan?: IOrchestrationPlan`
- `agentChatPanel.ts` — 新增 `_createOrchestrationPlanCard(plan)` 方法
- `_createMessageElement` — 在 content 和 toolCalls 之间渲染 orchestrationPlan 卡片
- 新增回调：`onPlanAction?: (planId: string, action: 'approve' | 'reject') => void`
- `chatBarPart.ts` — 实现回调，调用编排服务
- `agentChat.css` — `.orchestration-plan-card` 样式

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/parts/chatBarPart.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

#### 4.2 AskUserCard（工作流交互卡片）

**现状**：无  
**React**：工作流 AskUser 节点交互卡片，支持单选/多选/提交/取消/过期

**改动**：

- `agentChatTypes.ts` — 新增 `IAskUserData` 接口：
  ```ts
  export interface IAskUserData {
    id: string;
    question: string;
    options: Array<{ id: string; label: string }>;
    multiSelect?: boolean;
    status: 'pending' | 'answered' | 'expired';
    selectedOptionIds?: string[];
  }
  ```
- `IAgentChatMessage` 扩展：`askUser?: IAskUserData`
- `agentChatPanel.ts` — 新增 `_createAskUserCard(data)` 方法
- `_createMessageElement` — 渲染 askUser 卡片
- 新增回调：`onAskUserResponse?: (askId: string, selectedIds: string[]) => void`
- `chatBarPart.ts` — 实现回调
- `agentChat.css` — `.ask-user-card` 样式

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/parts/chatBarPart.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

### Phase 5：流式 Delta 完整处理 + 高级功能（P2 增强）

> 目标：补全缺失的 delta 处理 + 高级 UI 功能

#### 5.1 缺失 Delta 类型补全

**现状**：`content_replace` / `discard_prior_text` / `tool_approval_request` / `tool_approval_resolved` 4个 delta 类型在 `default` 分支中被忽略

**改动**：

- `chatBarPart.ts` — `_handleSendMessage` delta switch 增加：
  ```ts
  case 'content_replace': {
    assistantMsg.content = delta.content ?? assistantMsg.content;
    panel.updateMessage(assistantId, { content: assistantMsg.content });
    break;
  }
  case 'discard_prior_text': {
    // 清空 thinking buffer，保持流式
    assistantMsg.thinking = '';
    panel.updateMessage(assistantId, { thinking: '', isThinking: false });
    break;
  }
  case 'tool_approval_request': {
    // 将安全等级注入当前 running tool call
    const calls = (assistantMsg.toolCalls ?? []).map(c =>
      c.id === delta.toolCallId
        ? { ...c, status: 'approval_required' as const, securityLevel: delta.securityLevel }
        : c
    );
    assistantMsg.toolCalls = calls;
    panel.updateMessage(assistantId, { toolCalls: calls });
    panel.setStreamPhase('awaiting_approval');
    break;
  }
  case 'tool_approval_resolved': {
    panel.setStreamPhase('tool_executing');
    break;
  }
  ```

**涉及文件**：
- `src/vs/sessions/browser/parts/chatBarPart.ts`

---

#### 5.2 ToolCallCard 增强版（ToolHeaderWrapper 架构）

**现状**：简单标题 + 可折叠体  
**React**：`ToolHeaderWrapper` — 圆角卡片 + 可点标题行 + 状态区 + 折叠体

**改动**：

- `agentChatPanel.ts` — 重写 `_createToolCallCard()`：
  1. 统一圆角卡片外壳 `.tool-call-card-shell`
  2. 标题行：状态图标(spinner/✓/✗/🔒) + displayName/renderType + 耗时 + 展开/折叠箭头
  3. `approval_required` 状态时标题行显示安全等级徽章 + 审批按钮
  4. 折叠体：参数/结果按 `renderType` 分流渲染
     - `RunTerminal` → 终端风格（深色背景等宽字体 + 退出码）
     - `CodeEditor` → 代码高亮块
     - 默认 → JSON 格式化展示
- `agentChatTypes.ts` — `IToolCall` 增加 `securityLevel?` / `status` 扩展为含 `approval_required` / `duration?`
- `agentChat.css` — `.tool-call-card-shell` / `.tool-call-status-area` / `.tool-approval-inline` 样式

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

#### 5.3 Token Footer 增强（KV Cache + Credit）

**现状**：仅显示 `total tokens`  
**React**：input/output/total + cached/cacheWrite + credit

**改动**：

- `agentChatTypes.ts` — `IAgentChatMessage.tokenUsage` 扩展：
  ```ts
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cached?: number;
    cacheWrite?: number;
    credits?: number;
  };
  ```
- `agentChatPanel.ts` — footer 渲染增强：
  - 缓存命中：`🔥 cached: {cached}` 徽章
  - Credit：`💰 {credits}` 徽章
  - Tooltip 完整展示 input/output/cached/cacheWrite

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

#### 5.4 Markdown 流式预处理

**现状**：VS Code 内置 `renderMarkdown` 无预处理  
**React**：`normalizeStreamingMarkdown` 修复流式场景下的表格/Unicode 列表/未闭合代码块

**改动**：

- `agentChatPanel.ts` — 新增 `_normalizeStreamingMarkdown(content: string): string` 方法：
  1. 修复未闭合的代码围栏（尾部补充 ` ``` `）
  2. 修复未闭合的表格（补充 `|` 和分割行）
  3. 修复 Unicode 列表标记后的空格
- 流式渲染时（`isStreaming=true`）调用预处理，完成渲染时不调用

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`

---

#### 5.5 参考卡片（ReferencesCard）

**现状**：无  
**React**：展示 AI 引用的文件/代码/URL/符号，支持折叠/状态标记

**改动**：

- `agentChatTypes.ts` — 新增 `IReference` / `IReferenceData` 接口
- `IAgentChatMessage` 扩展：`references?: IReferenceData`
- `agentChatPanel.ts` — 新增 `_createReferencesCard()` 方法
- `agentChat.css` — `.references-card` 样式

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

#### 5.6 其他增强卡片（Progress / TodoList / Tip / QuestionCarousel）

**改动**：

- `agentChatTypes.ts` — 每种卡片新增对应接口
- `IAgentChatMessage` — 扩展 `progress?` / `todoList?` / `tip?` / `questionCarousel?`
- `agentChatPanel.ts` — 每种新增 `_createXxxCard()` 方法
- `agentChat.css` — 各卡片样式

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

### Phase 6：高级架构功能（P2 远期）

> 目标：后台流管理、Swarm 拓扑等高阶功能

#### 6.1 背景流管理

**现状**：切换 Agent 后流状态丢失  
**React**：`backgroundStreams` Map 保存非活跃 Agent 的流状态

**改动**：

- `agentChatPanel.ts` — 新增 `_backgroundStreams: Map<string, { messages: IAgentChatMessage[], streamPhase: StreamPhase }>`
- 切换 Agent 时保存/恢复流状态
- `chatBarPart.ts` — Agent 切换时调用 save/restore

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/parts/chatBarPart.ts`

---

#### 6.2 Swarm 拓扑可视化

**现状**：无  
**React**：Worker/Verifier/Synthesizer 拓扑 + 黑板状态

**改动**：

- 新增 `ISwarmData` 接口和对应卡片渲染
- 需要 `IAgentChatService` 暴露 swarm 事件

**涉及文件**：
- `src/vs/sessions/browser/agentChat/agentChatTypes.ts`
- `src/vs/sessions/browser/agentChat/agentChatPanel.ts`
- `src/vs/sessions/browser/agentChat/media/agentChat.css`

---

## 三、实施优先级与依赖关系

```
Phase 1 (内核升级)
├── 1.1 StreamPhase ──────── 独立，无依赖
├── 1.2 交织渲染 ────────── 依赖 1.1 (StreamPhase)
├── 1.3 代码高亮/折叠/复制 ─ 独立
├── 1.4 Hermes聚合 ──────── 依赖 1.2 (textPosition)
└── 1.5 上下文圆环增强 ──── 依赖 1.1 (StreamPhase)

Phase 2 (输入区增强)
├── 2.1 斜杠菜单 ────────── 独立
├── 2.2 图片/Lightbox ────── 独立
└── 2.3 输入区拖动 ──────── 独立

Phase 3 (卡片增强)
├── 3.1 SubAgent完整版 ──── 独立
├── 3.2 四级审批 ────────── 依赖 1.1 (awaiting_approval phase)
├── 3.3 错误重试 ────────── 独立
└── 3.4 ThinkingCard增强 ── 独立

Phase 4 (编排/工作流)
├── 4.1 OrchestrationPlan ── 独立
└── 4.2 AskUserCard ──────── 独立

Phase 5 (高级功能)
├── 5.1 缺失Delta补全 ───── 依赖 1.1 + 3.2
├── 5.2 ToolCallCard增强 ─── 依赖 5.1 (approval_required)
├── 5.3 Token Footer ─────── 独立
├── 5.4 Markdown预处理 ───── 独立
├── 5.5 ReferencesCard ───── 独立
└── 5.6 其他卡片 ────────── 独立

Phase 6 (远期)
├── 6.1 背景流管理 ──────── 依赖 Phase 1
└── 6.2 Swarm拓扑 ───────── 依赖后端事件
```

---

## 四、预估工作量

| Phase | 改动项 | 预估文件改动 | 预估代码量 |
|-------|--------|------------|-----------|
| 1 | 5 | 4 文件 | ~800 行 |
| 2 | 3 | 3 文件 | ~600 行 |
| 3 | 4 | 4 文件 | ~700 行 |
| 4 | 2 | 4 文件 | ~500 行 |
| 5 | 6 | 4 文件 | ~900 行 |
| 6 | 2 | 3 文件 | ~400 行 |
| **合计** | **22** | **~8 文件** | **~3900 行** |

---

## 五、关键设计决策

### Q1：是否复用 React 组件代码？
**决策**：不复用。Native 版直接调用 VS Code 服务（`IAgentChatService` 等），不经过 `postMessage` 桥接。两者共享的仅有类型定义（`agentChatTypes.ts`）和 CSS 设计 token。

### Q2：代码高亮方案？
**决策**：使用 VS Code 内置 `tokenizeToString` 而非引入 `highlight.js`/`prism`，避免额外依赖。若高亮效果不理想，fallback 到 `<pre><code>` + 主题色。

### Q3：Swarm/Delegation 等远期功能？
**决策**：Phase 6 仅设计接口，实际实现依赖后端事件暴露。当前优先保证 Phase 1-3 的核心聊天体验。

### Q4：Native 独有功能如何处理？
**决策**：保留 `@mention` 高亮、PM 自动编排开关、联网搜索开关 — 这些是 Native 版的增值特性，React 版后续也可回移。
