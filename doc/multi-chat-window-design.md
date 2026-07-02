# 多聊天窗口设计方案

> 基于当前项目代码深度分析 + orca 项目参考，设计右侧栏多聊天窗口功能的完整实现方案。

---

## 一、当前架构瓶颈分析

### 1.1 ChatBarPart 单实例限制

```
ChatBarPart
├── _sessionCompositeBar: ChatCompositeBar    // 多 tab 标签栏
├── _agentChatPanel: AgentChatPanel (单个!)    // ← 核心瓶颈
├── _currentAgentId: string                    // ← 全局单例状态
├── _currentSessionId: string                  // ← 全局单例状态
├── _currentChatMode: ChatMode                 // ← 全局单例状态
└── _currentMaxContextTokens: number            // ← 全局单例状态
```

**问题**：切换 tab 时调用 `setMessages()` 全量替换同一个 panel 的内容，流式状态丢失、DOM 全量重建。

### 1.2 AgentChatService 并发流阻塞

```typescript
// agentChatService.ts:76
private _activeOnDelta: ((delta: IChatStreamDelta) => void) | null = null;
```

**问题**：`_activeOnDelta` 是**单例回调**。第二个 `sendMessage()` 调用会覆盖第一个的 delta 回调，导致第一个流的 memory event 无法到达 UI。

**好消息**：
- `_activeStreams` 是 `Map<string, AbortController>`，key = `agentId::sessionId`，**已支持**多并发流
- `_historyCache` 是 `Map<string, ChatMessage[]>`，key = `agentId::sessionId`，**已支持**多会话缓存

### 1.3 AgentChatPanel 多实例安全性

AgentChatPanel 的所有状态都是**实例级**的（`private _xxx`），**无静态/共享状态**：
- `_messages`、`_agent`、`_isSending`、`_toolCallExpandState` 等
- `STREAMING_MD_INTERVAL` 是 `static readonly` 常量，无副作用

**结论**：`AgentChatPanel` 本身**可以安全多实例化**。

### 1.4 已就绪的数据层

```typescript
// session.ts — 已有多 chat 模型
interface ISession {
  readonly chats: IObservable<readonly IChat[]>;
  readonly mainChat: IChat;
  readonly capabilities: ISessionCapabilities; // supportsMultipleChats
}

// sessionsManagement.ts — 已有多 chat 操作 API
interface ISessionsManagementService {
  openChat(session: ISession, chatUri: URI): Promise<void>;
  deleteChat(session: ISession, chatUri: URI): Promise<void>;
  renameChat(session: ISession, chatUri: URI, title: string): Promise<void>;
}
```

---

## 二、设计方案

### 2.1 整体架构

```
ChatBarPart (Part 容器)
├── ChatToolbar (工具栏：新建/分屏/历史/设置)
├── ChatTabBar (标签栏：管理多个 chat tab)
│   ├── ChatTab × N (每个 chat 一个 tab)
│   └── ChatTabNew (+ 按钮)
├── SplitViewContainer (分屏容器)
│   ├── ChatPanelSlot × 1~2 (最多 2 个分屏)
│   │   └── ChatPanelManager
│   │       ├── ChatPanelState (数据状态)
│   │       └── AgentChatPanel (UI 实例，按需创建/隐藏)
│   └── Sash (可拖拽分隔条)
└── (布局管理器)
```

### 2.2 核心组件设计

#### 2.2.1 ChatPanelManager（新建）

**职责**：管理多个 `AgentChatPanel` 实例的生命周期、切换、缓存。

```typescript
interface IChatPanelEntry {
  readonly chatId: string;
  readonly panel: AgentChatPanel;
  readonly state: ChatPanelRuntimeState;
  element: HTMLElement;
  isVisible: boolean;
}

interface ChatPanelRuntimeState {
  agentId: string;
  sessionId: string | undefined;
  chatMode: ChatMode;
  maxContextTokens: number | undefined;
  isSending: boolean;
  streamPhase: StreamPhase;
  createdAt: number;
  lastActiveAt: number;
}

class ChatPanelManager extends Disposable {
  private readonly _panels = new Map<string, IChatPanelEntry>();
  private _activeChatId: string | undefined;
  private _maxConcurrentPanels = 4;  // 最大并发 panel 数

  // ── Panel 生命周期 ──
  createPanel(chatId: string, opts: AgentChatPanelOpts): AgentChatPanel;
  getPanel(chatId: string): AgentChatPanel | undefined;
  destroyPanel(chatId: string): void;

  // ── 可见性管理（切换 tab = 切 display，不销毁）──
  showPanel(chatId: string): void;
  hidePanel(chatId: string): void;
  getActivePanel(): AgentChatPanel | undefined;

  // ── MRU 栈（最近使用顺序）──
  private _mruStack: string[] = [];
  touchMRU(chatId: string): void;
  getMRU(): string[];

  // ── LRU 淘汰（超过 maxConcurrentPanels 时销毁最久未用的）──
  private _evictIfNeeded(): void;

  // ── 状态查询 ──
  getPanelCount(): number;
  getVisibleChatIds(): string[];
}
```

#### 2.2.2 ChatBarPart 改造

```typescript
export class ChatBarPart extends AbstractPaneCompositePart {
  // 删除：private _agentChatPanel: AgentChatPanel | undefined;
  // 删除：private _currentAgentId / _currentSessionId / _currentChatMode

  // 新增
  private _panelManager: ChatPanelManager;
  private _splitView: SplitView | undefined;  // VS Code 原生 SplitView
  private _splitMode: 'none' | 'horizontal' | 'vertical' = 'none';

  // 保留
  private _sessionCompositeBar: ChatCompositeBar;
  private _chatToolbar: ChatToolbar;
}
```

#### 2.2.3 AgentChatService 并发修复

```typescript
// 修改前（单例）：
private _activeOnDelta: ((delta: IChatStreamDelta) => void) | null = null;

// 修改后（Map）：
private readonly _activeOnDeltas = new Map<string, (delta: IChatStreamDelta) => void>();

// sendMessage 中：
const streamKey = options.agentSessionId
  ? `${agentId}::${options.agentSessionId}`
  : agentId;
this._activeOnDeltas.set(streamKey, onDelta);  // ← 替代 this._activeOnDelta = onDelta

// _setupMemoryEventBridge 中：
const onDelta = this._activeOnDeltas.get(streamKey);
if (!onDelta) return;
onDelta({ ... });
```

### 2.3 标签切换流程（核心路径）

```
用户点击 Tab B
  → ChatTabBar._onTabClicked(chatB)
  → ChatPanelManager.showPanel(chatB.id)
    → panelA.element.style.display = 'none'    // 隐藏 A（保留 DOM+状态）
    → panelB.element.style.display = ''          // 显示 B
    → _activeChatId = chatB.id
    → _mruStack.touch(chatB.id)
  → ChatBarPart.layout()  // 重布局
```

**关键**：不调用 `setMessages()`，不重建 DOM，流式状态保留。

### 2.4 分屏流程

```
用户点击工具栏"水平分屏"按钮
  → ChatBarPart._toggleSplit('horizontal')
    → _splitMode = 'horizontal'
    → _splitView = new SplitView(container, { orientation: HORIZONTAL })
    → _splitView.addView({ element: panelA.element, ... })
    → _splitView.addView({ element: panelB.element, ... })
    → 添加 Sash 拖拽支持
```

### 2.5 发送消息流程（多 panel 隔离）

```
Panel B 的 composer 输入 "hello" → 按 Enter
  → panelB.opts.onSendMessage("hello")
  → ChatBarPart._handleSendMessage("hello", panelB.state)
    → _chatService.sendMessage(panelB.state.agentId, "hello", {
        agentSessionId: panelB.state.sessionId,
        chatMode: panelB.state.chatMode,
        ...
      }, (delta) => {
        panelB.handleDelta(delta);  // ← delta 路由到正确的 panel
      })
```

### 2.6 LRU 淘汰策略

当 panel 数量超过 `_maxConcurrentPanels`（默认 4）：
1. 从 `_mruStack` 找到最久未用的 chatId
2. 销毁对应的 `AgentChatPanel` 实例（释放 DOM + disposable）
3. 保留 `ChatPanelRuntimeState`（数据状态）
4. 下次切换到该 chat 时重新创建 panel + 从 `getHistory()` 恢复消息

---

## 三、实现优先级

| 阶段 | 目标 | 改动文件 | 估计工作量 |
|------|------|---------|-----------|
| **P0** | 多 Panel 实例管理 | 新建 `chatPanelManager.ts`，改 `chatBarPart.ts` | 2-3 天 |
| **P0** | AgentChatService 并发修复 | 改 `agentChatService.ts` | 0.5 天 |
| **P1** | 分屏支持 | 新建 `chatSplitView.ts`，改 `chatBarPart.ts` | 1-2 天 |
| **P2** | 布局持久化 | 改 `chatBarPart.ts` + `IStorageService` | 0.5 天 |
| **P3** | LRU 淘汰 + 懒加载 | 改 `chatPanelManager.ts` | 1 天 |

---

## 四、关键设计决策

### 4.1 为什么不直接用 VS Code Editor Group 分屏？

- AgentChatPanel 是原生 DOM 组件，不是 EditorInput
- VS Code Editor Group 管理的是 EditorPane，与 AgentChatPanel 的 Disposable+回调模式不兼容
- 但**数据模型可以借鉴** Editor Group 的 MRU + split 思路

### 4.2 为什么保留 DOM 而非销毁重建？

- 流式状态（rAF 定时器、markdown 节流、滚动位置）无法序列化
- DOM 重建有性能开销（4000+ 行面板，大量消息 DOM 节点）
- 保留 DOM 只需 `display:none`，切换 O(1)

### 4.3 为什么限制最多 2 个分屏？

- 右侧栏宽度有限（480px 默认），3+ 分屏不可用
- 2 个分屏已满足"边看代码边聊天"的核心场景
- 后续可配置化（`chat.multiWindow.maxSplits`）

### 4.4 与 ChatCompositeBar 的关系

`ChatCompositeBar`（已有）管理 **session 级别的多 chat tab**，走 `ISessionsManagementService`。
新增的 `ChatPanelManager` 管理 **UI 级别的多 panel 实例**，走 `IAgentChatService`。

两者关系：
- `ChatCompositeBar` 的 tab 点击 → `ChatPanelManager.showPanel(chatId)`
- `ChatPanelManager` 不直接操作 `ISessionsManagementService`

---

## 五、测试策略

### 5.1 单元测试

| 测试文件 | 测试目标 |
|---------|---------|
| `chatPanelManager.test.ts` | Panel 生命周期、切换、MRU、LRU 淘汰 |
| `agentChatServiceConcurrency.test.ts` | 并发流隔离、delta 路由、cancelStream |
| `chatSplitView.test.ts` | 分屏创建/销毁、sash 拖拽、布局计算 |

### 5.2 集成测试

| 测试场景 | 验证点 |
|---------|-------|
| 多 tab 切换 | DOM 保留、状态不丢失 |
| 并发流 | 两个 panel 同时流式，delta 不串台 |
| 分屏 | 两个 panel 并排显示，独立交互 |
| LRU 淘汰 | 超过上限时销毁最旧 panel，切换回来自动重建 |

详见 `multiChatWindow.test.ts`。
