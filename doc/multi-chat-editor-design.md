# 多聊天框 UI — AGENT_EDITOR_PART 方案设计

> 在 `NativeChatEditorPane` 中嵌入 `ChatCompositeBar`（tab bar），支持多 chat 切换/新建/关闭。

---

## 一、当前架构

```
AGENT_EDITOR_PART (默认显示)
├── NativeChatEditorPane (单例 EditorPane)
│   ├── _container: div.native-chat-editor-pane
│   └── _chatPanel: AgentChatPanel (单实例，不随 chat 切换)
│       ├── chat-header (agent 名称 + 状态 + 工具按钮)
│       └── messages + input
└── EditorTitle: [+] [popout] [×]

ChatBarPart (默认隐藏 chatBar: false)
├── ChatCompositeBar (tab bar + 新建按钮)
└── AgentChatPanel (单实例)
```

**问题**：`NativeChatEditorPane` 没有 tab bar，`openNewChatInSession()` 创建新 chat 后无人消费。

## 二、设计方案

```
AGENT_EDITOR_PART
├── NativeChatEditorPane
│   ├── _container
│   │   ├── ChatCompositeBar (tab bar，prepend 到容器顶部)
│   │   │   ├── chat tabs (每个 chat 一个 tab)
│   │   │   └── [+] 新建聊天按钮
│   │   └── _chatPanel: AgentChatPanel (保持单实例，切换 chat 时重载历史)
│   └── EditorTitle: [+] [popout] [×]
```

### 2.1 核心改动

1. **`NativeChatEditorPane`** 注入 `ISessionsManagementService` + `IThemeService` + `IContextMenuService` + `IQuickInputService`
2. **`createEditor()`** 中 prepend `ChatCompositeBar` 到容器顶部
3. **新增 `autorun`** 监听 `activeSession.activeChat`：
   - chat 切换 → 加载该 chat 的历史消息到 `_chatPanel`
   - 保留 `_currentAgentId`（agent 不随 chat 切换）
4. **`ChatCompositeBar` 的 + 按钮** → `openNewChatInSession()` → autorun 感知 → 新 chat 激活 → 清空面板 + 聚焦输入框

### 2.2 不改动的部分

- `AgentChatPanel` 保持单实例（不创建多 panel，切换 chat = 重载 `setMessages()`）
- `AgentChatService` 的并发流修复（`_activeOnDeltas` Map）保持不变
- `ChatCompositeBar` 本身不改（已有 tab + 新建按钮 + 关闭/重命名）

### 2.3 清理

- `ChatBarPart` 相关代码移除（`chatPanelManager.ts`、`chatBarPart.ts` 中的多面板管理、分屏等）
- `agentStudio.contribution.ts` 中注册到 `Menus.ChatBarTitle` 的 action 移除
- `ChatBarPart` 本身保留（layout 可能引用），但移除多面板管理逻辑

## 三、数据流

```
用户点击 [+] 按钮
  → ChatCompositeBar._createNewChat()
  → ISessionsManagementService.openNewChatInSession(session)
  → provider.addChat(sessionId) 创建新 IChat
  → _activeChatObservable.set(chat) 更新活跃 chat
  → NativeChatEditorPane 的 autorun 触发
    → _chatPanel.setMessages([])  清空消息
    → _chatPanel.focusInput()    聚焦输入框
  → ChatCompositeBar 的 autorun 触发
    → _rebuildTabs() 重建 tab 列表（含新 tab）
    → _updateActiveTab() 高亮新 tab

用户点击 tab B
  → ChatCompositeBar._onTabClicked(chatB)
  → ISessionsManagementService.openChat(session, chatB.resource)
  → _activeChatObservable.set(chatB)
  → NativeChatEditorPane 的 autorun 触发
    → _chatService.getHistory(agentId, sessionId) 加载 chatB 历史
    → _chatPanel.setMessages(history) 切换消息
```

## 四、测试用例

### 4.1 ChatCompositeBar（已有，保持）

- tab 创建/切换/关闭/重命名
- + 按钮创建新 chat
- 可见性（>=1 chat 时显示）

### 4.2 NativeChatEditorPane 多 chat 切换

- chat 切换时 `setMessages()` 被调用，加载正确历史
- 新建 chat 时面板清空 + 聚焦输入框
- agent 不随 chat 切换变化
- 并发流不串台（依赖 AgentChatService 的 `_activeOnDeltas` Map）
