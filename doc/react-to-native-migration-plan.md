# React版聊天框切换为Native聊天框 — 迁移方案

**文档版本**: v1.0  
**创建日期**: 2025-06-16  
**作者**: AI Agent  
**状态**: 待评审

---

## 一、执行摘要

### 1.1 背景
当前 Agent Studio 使用 React + WebView 架构实现聊天功能，存在以下问题：
- WebView 生命周期管理复杂（`iframe` 销毁/重建导致状态丢失）
- 跨域通信开销（`postMessage` RPC 延迟）
- 样式同步问题（resize 时底部间隙）
- 维护成本高（Zustand stores + WebView bridge 双层状态）

### 1.2 目标
将聊天功能从 React WebView 架构迁移到 Native DOM 架构，实现：
- ✅ 消除 WebView 通信层
- ✅ 简化状态管理（Zustand stores → 类私有字段）
- ✅ 提升性能（减少 RPC 开销）
- ✅ 提高可维护性（单一代码库）

### 1.3 范围
**包含**：
- `agentStudioWebviewController.ts` → Native 回调机制
- `AgentStudioEditorPane.tsx` → `NativeChatEditorPane.ts`
- `index.tsx` + `streamHandler.ts` + `messageClient.ts` → `AgentChatPanel.ts`
- Zustand stores → `AgentChatPanel` 私有字段
- CSS 样式迁移（`chat-enhanced.css` → `agentChat.css`）

**不包含**：
- 后端 `agentChatService.ts`（完全不受影响）
- 其他 WebView 功能（如 Taskboard、Workflow Editor）

---

## 二、迁移策略

### 2.1 总体策略：分阶段渐进式迁移

采用 **Strangler Fig 模式**（绞杀者无花果树模式）：
1. **阶段 1**：准备基础设施（不影响现有功能）
2. **阶段 2**：并行运行（React + Native 双版本）
3. **阶段 3**：切换默认（Native 成为默认，React 作为 fallback）
4. **阶段 4**：移除 React（完全迁移到 Native）

### 2.2 为什么选择渐进式？
- **风险可控**：每个阶段可独立验证
- **回滚简单**：随时可切回 React 版本
- **并行开发**：不阻塞新功能开发

### 2.3 关键决策点

| 决策点 | 选项 A | 选项 B | 推荐 | 理由 |
|--------|--------|--------|------|------|
| **迁移方式** | 大爆炸式（一次性替换） | 渐进式（分阶段） | **渐进式** | 风险低，可回滚 |
| **Native 入口** | `chatBarPart.ts` | `nativeChatEditorPane.ts` | **两者都支持** | 已兼容，按需选择 |
| **状态管理** | 完全重写 | 适配器模式（逐步迁移） | **完全重写** | 代码更简洁，长期维护成本低 |
| **CSS 迁移** | 逐一移植 | 全新编写 | **混合** | 保留 `agentChat.css`，补充缺失样式 |

---

## 三、迁移阶段详解

### 阶段 1：准备基础设施（Week 1-2）

**目标**：搭建 Native 版本的运行环境，不影响现有 React 版本。

#### 1.1 任务清单

| # | 任务 | 负责人 | 依赖 | 状态 |
|---|------|--------|------|------|
| 1.1 | 确认 `NativeChatEditorPane.ts` 已完整支持 `AgentChatPanel` | - | 无 | ✅ 已完成 |
| 1.2 | 确认 `chatBarPart.ts` 已完整支持 `AgentChatPanel` | - | 无 | ✅ 已完成 |
| 1.3 | 创建 Feature Flag：`enableNativeChat`（默认 false） | 后端 | 无 | 🔲 待做 |
| 1.4 | 添加配置开关：`agentStudio.useNativeChat` | 后端 | 1.3 | 🔲 待做 |
| 1.5 | 创建迁移分支：`feat/react-to-native-migration` | - | 无 | 🔲 待做 |

#### 1.2 交付物
- [ ] Feature Flag 配置文件
- [ ] 迁移分支创建完成
- [ ] 单元测试框架搭建（Jest + jsdom）

---

### 阶段 2：核心 WebView 替换（Week 3-5）

**目标**：用 Native 版本替换 React WebView 核心逻辑，保持功能 parity。

#### 2.1 任务清单

| # | 任务 | 详细描述 | 优先级 | 状态 |
|---|------|----------|--------|------|
| 2.1 | **替换 `agentStudioWebviewController.ts`** | 移除 WebView 创建/管理逻辑，改为实例化 `NativeChatEditorPane` 或直接调用 `AgentChatPanel` 回调 | 🔴 P0 | 🔲 待做 |
| 2.2 | **移除 `index.tsx` 消息路由** | 将 `routeWorkflowTrace` / `dispatchConfigMdEvent` 等逻辑迁移到 `AgentChatPanel` 或直接调用回调 | 🔴 P0 | 🔲 待做 |
| 2.3 | **替换 `streamHandler.ts`** | 将流式处理逻辑（`handleStreamDelta` / `handleStreamComplete` / `handleStreamError`）迁移到 `AgentChatPanel._streamingTick()` | 🔴 P0 | 🔲 待做 |
| 2.4 | **替换 `messageClient.ts`** | 移除 `sendRequest` / `postMessage` RPC 封装，改为回调函数直接调用 | 🔴 P0 | 🔲 待做 |
| 2.5 | **迁移 Zustand stores** | 将 6 个 store 文件的状态管理迁移到 `AgentChatPanel` 私有字段 | 🟡 P1 | 🔲 待做 |
| 2.6 | **迁移 CSS 样式** | 将 `chat-enhanced.css` + `chat-cards.css` + `themes.css` 迁移到 `agentChat.css` | 🟡 P1 | 🔲 待做 |

#### 2.2 详细实施步骤

##### 任务 2.1：替换 `agentStudioWebviewController.ts`

**当前状态**：
```typescript
// agentStudioWebviewController.ts (145KB，过于庞大)
export class AgentStudioWebviewController {
  private _webviewPanel: WebviewPanel | undefined;
  
  // WebView 生命周期管理
  private async _createWebviewPanel(): Promise<void> { ... }
  private _postMessage(message: WebviewMessage): void { ... }
  private _onDidReceiveMessage(message: WebviewMessage): void { ... }
  
  // 消息路由
  private _handleChatSend(message: string): void { ... }
  private _handleChatActiveSessionChanged(sessionId: string): void { ... }
}
```

**目标状态**：
```typescript
// agentStudioWebviewController.ts (简化版，仅保留必要逻辑)
export class AgentStudioWebviewController {
  private _nativeChatPanel: AgentChatPanel | undefined;
  
  // Native 面板管理
  private async _createNativeChatPanel(container: HTMLElement): Promise<void> {
    this._nativeChatPanel = new AgentChatPanel({
      onSendMessage: (text, explicitSkillIds) => this._handleChatSend(text, explicitSkillIds),
      onCancelExecution: () => this._handleChatCancel(),
      // ... 其他回调
    });
    this._nativeChatPanel.render(container);
  }
  
  // 消息处理（直接调用回调）
  private _handleChatSend(text: string, explicitSkillIds?: string[]): void {
    // 直接调用 agentChatService.sendMessage()
  }
}
```

**实施步骤**：
1. 创建 `AgentStudioWebviewControllerNative` 类（继承或组合）
2. 添加 Feature Flag 判断：如果 `enableNativeChat=true`，使用 Native 版本
3. 逐步迁移方法：先迁移消息发送，再迁移会话管理
4. 保留旧版本作为 fallback

##### 任务 2.2：移除 `index.tsx` 消息路由

**当前状态**：
```typescript
// index.tsx (WebView 入口)
initMessageClient({
  onMessage: (message) => {
    routeWorkflowTrace(message);
    dispatchConfigMdEvent(message);
    handleStreamDelta(message);
    handleStreamComplete(message);
    // ...
  }
});
```

**目标状态**：
```typescript
// 消息路由由 agentStudioWebviewController 直接调用回调处理
// index.tsx 不再需要，或简化为空壳
```

**实施步骤**：
1. 将 `routeWorkflowTrace` 逻辑迁移到 `agentStudioWebviewController._handleWorkflowTrace()`
2. 将 `dispatchConfigMdEvent` 逻辑迁移到 `agentStudioWebviewController._handleConfigMdEvent()`
3. 将 `handleStreamDelta` 等逻辑迁移到 `AgentChatPanel._streamingTick()`
4. 删除 `index.tsx` 或保留作为 Native 版本的空壳

##### 任务 2.3：替换 `streamHandler.ts`

**当前状态**：
```typescript
// streamHandler.ts (React 版本)
export function handleStreamDelta(chunk: StreamChunk): void {
  // 更新 Zustand store
  useChatStore.getState().updateStreamingMessage(chunk);
}
```

**目标状态**：
```typescript
// AgentChatPanel.ts (Native 版本)
private _streamingTick(chunk: StreamChunk): void {
  // 直接操作 DOM 或更新私有字段
  this._updateStreamingMessage(chunk);
}
```

**实施步骤**：
1. 将 `StreamChunk` 类型定义迁移到 `agentChatTypes.ts`
2. 将 `handleStreamDelta` 逻辑重写为 `AgentChatPanel._handleStreamDelta()`
3. 将 `handleStreamComplete` 逻辑重写为 `AgentChatPanel._handleStreamComplete()`
4. 将 `handleStreamError` 逻辑重写为 `AgentChatPanel._handleStreamError()`
5. 添加单元测试验证流式处理逻辑

##### 任务 2.4：替换 `messageClient.ts`

**当前状态**：
```typescript
// messageClient.ts (RPC 封装)
export function sendRequest<T>(method: string, params: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = generateId();
    const handler = (event: MessageEvent) => {
      if (event.data.requestId === requestId) {
        resolve(event.data.result);
      }
    };
    window.addEventListener('message', handler);
    postMessage({ requestId, method, params });
  });
}
```

**目标状态**：
```typescript
// 回调函数直接调用，无需 RPC
// 示例：发送消息
this._opts.onSendMessage(text, explicitSkillIds);
```

**实施步骤**：
1. 识别所有 `sendRequest` 调用点
2. 为每个调用点创建对应的回调函数（已定义在 `AgentChatPanel` 构造函数）
3. 将 `sendRequest` 调用替换为回调函数调用
4. 删除 `messageClient.ts`

##### 任务 2.5：迁移 Zustand stores

**当前状态**：
```typescript
// useChatStore.ts
export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isStreaming: false,
  updateStreamingMessage: (chunk) => set(...),
  // ...
}));
```

**目标状态**：
```typescript
// AgentChatPanel.ts
class AgentChatPanel {
  private _messages: ChatMessage[] = [];
  private _isStreaming = false;
  
  private _updateStreamingMessage(chunk: StreamChunk): void {
    // 直接更新 this._messages
  }
}
```

**实施步骤**：
1. 创建状态映射表（Zustand store → `AgentChatPanel` 私有字段）
2. 按优先级迁移：
   - P0: `useChatStore` → `_messages`, `_isStreaming`, `_currentPhase`
   - P1: `useAgentStore` → `_availableAgents`, `_selectedAgentId`
   - P1: `useProviderStore` → `_availableProviders`, `_selectedProviderId`
   - P2: `useOrchestrationStore` → `_activePlan`, `_planTasks`
3. 为每个状态字段添加 getter/setter 方法
4. 添加单元测试验证状态管理逻辑

**状态映射表**：

| Zustand Store | 状态字段 | AgentChatPanel 私有字段 | 迁移优先级 |
|---------------|----------|------------------------|-----------|
| `useChatStore` | `messages` | `_messages` | P0 |
| `useChatStore` | `isStreaming` | `_isStreaming` | P0 |
| `useChatStore` | `currentPhase` | `_currentPhase` | P0 |
| `useChatStore` | `streamingMessageId` | `_streamingMessageId` | P0 |
| `useAgentStore` | `agents` | `_availableAgents` | P1 |
| `useAgentStore` | `selectedAgentId` | `_selectedAgentId` | P1 |
| `useProviderStore` | `providers` | `_availableProviders` | P1 |
| `useProviderStore` | `selectedProviderId` | `_selectedProviderId` | P1 |
| `useOrchestrationStore` | `activePlan` | `_activePlan` | P2 |
| `useOrchestrationStore` | `tasks` | `_planTasks` | P2 |

##### 任务 2.6：迁移 CSS 样式

**当前状态**：
- `chat-enhanced.css` (React 版本主样式)
- `chat-cards.css` (卡片样式)
- `themes.css` (主题样式)

**目标状态**：
- `agentChat.css` (Native 版本统一样式)

**实施步骤**：
1. 对比 `chat-enhanced.css` 和 `agentChat.css` 的差异
2. 将缺失的样式从 `chat-enhanced.css` 移植到 `agentChat.css`
3. 优先级：
   - P0: 消息气泡样式（`.chat-message`, `.message-content`）
   - P0: 输入框样式（`.composer`, `.chat-input`）
   - P1: 卡片样式（`.thinking-card`, `.tool-card`）
   - P2: 主题样式（`.theme-dark`, `.theme-light`）
4. 删除旧的 CSS 文件（或保留作为参考）

#### 2.3 交付物
- [ ] `agentStudioWebviewController.ts` 简化版（支持 Native）
- [ ] `index.tsx` 移除或简化
- [ ] `streamHandler.ts` 逻辑迁移到 `AgentChatPanel`
- [ ] `messageClient.ts` 删除
- [ ] Zustand stores 迁移完成（P0 + P1）
- [ ] CSS 样式迁移完成（P0 + P1）

---

### 阶段 3：功能 Parity 恢复（Week 6-8）

**目标**：恢复 React 版本有但 Native 版本缺失的功能。

#### 3.1 功能缺失清单

| # | 功能 | React版有 | Native版有 | 优先级 | 状态 |
|---|------|-----------|-----------|--------|------|
| 3.1 | **技能芯片 (SkillChips)** | ✅ 完整交互 | ⚠️ UI隐藏 (`display: none`) | 🟡 P1 | 🔲 待做 |
| 3.2 | **AgentSession 多会话管理** | ✅ `AgentSessionSwitcher` 完整组件 | ⚠️ 头部会话列表（功能较简） | 🟡 P1 | 🔲 待做 |
| 3.3 | **编排计划审查 UI** | ✅ `OrchestrationPlanModal/Inline/View` | ❌ 无（仅有回调接口） | 🔴 P0 | 🔲 待做 |
| 3.4 | **图片兼容性检查** | ✅ `getImageSupportWarning()` | ❌ 无 | 🟡 P1 | 🔲 待做 |
| 3.5 | **流式错误卡片** | ❌ 无 | ✅ `_createStreamErrorCard()` | 🟢 无风险 | - |
| 3.6 | **语音输入按钮** | ❌ 无 | ✅ UI占位 | 🟢 无风险 | - |
| 3.7 | **联网搜索开关** | ❌ 无 | ✅ `webSearchBtn` | 🟢 无风险 | - |
| 3.8 | **拖拽调整输入框** | ❌ 无 | ✅ `composer-resize-handle` | 🟢 无风险 | - |

#### 3.2 详细实施步骤

##### 任务 3.1：恢复技能芯片 (SkillChips)

**当前状态（React 版）**：
```tsx
// ChatComposer.tsx
<div className="skill-chips-bar">
  {skills.map(skill => (
    <button key={skill.id} className="skill-chip" onClick={() => onSkillClick(skill)}>
      {skill.name}
    </button>
  ))}
</div>
```

**目标状态（Native 版）**：
```typescript
// AgentChatPanel.ts
private _skillChipsBar: HTMLElement;

private _renderSkillChips(): void {
  this._skillChipsBar.innerHTML = '';
  const skills = this._opts.onListSkills?.() || [];
  skills.forEach(skill => {
    const chip = document.createElement('button');
    chip.className = 'skill-chip';
    chip.textContent = skill.name;
    chip.onclick = () => this._onSkillClick(skill);
    this._skillChipsBar.appendChild(chip);
  });
  this._skillChipsBar.style.display = ''; // 移除 display: none
}
```

**实施步骤**：
1. 在 `AgentChatPanel` 中找到 `_skillChipsBar`（已存在但隐藏）
2. 实现 `_renderSkillChips()` 方法
3. 在构造函数中调用 `onListSkills` 回调获取技能列表
4. 添加技能点击处理逻辑
5. 测试技能芯片显示和交互

##### 任务 3.2：增强 AgentSession 多会话管理

**当前状态（React 版）**：
```tsx
// AgentSessionSwitcher.tsx
<div className="agent-session-switcher">
  {sessions.map(session => (
    <div key={session.id} className="session-item" onClick={() => onSelectSession(session.id)}>
      <span className="session-name">{session.name}</span>
      <span className="session-status">{session.status}</span>
    </div>
  ))}
</div>
```

**目标状态（Native 版）**：
```typescript
// AgentChatPanel.ts
private _agentSessionsPopup: HTMLElement;

private _renderAgentSessionsPopup(): void {
  this._agentSessionsPopup.innerHTML = '';
  const sessions = this._agentSessions;
  sessions.forEach(session => {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.onclick = () => this._onSelectSession(session.id);
    
    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = session.name;
    item.appendChild(name);
    
    const status = document.createElement('span');
    status.className = 'session-status';
    status.textContent = session.status;
    item.appendChild(status);
    
    this._agentSessionsPopup.appendChild(item);
  });
}
```

**实施步骤**：
1. 在 `AgentChatPanel` 中找到 `_agentSessionsPopup`（头部弹出）
2. 实现 `_renderAgentSessionsPopup()` 方法
3. 添加会话选择处理逻辑
4. 添加会话创建/删除按钮
5. 测试多会话切换功能

##### 任务 3.3：新建编排计划审查 UI

**当前状态（React 版）**：
```tsx
// OrchestrationPlanModal.tsx
<div className="orch-plan-modal">
  <div className="orch-plan-header">
    <h2>{plan.goal}</h2>
    <button onClick={() => onApprovePlan(plan.id)}>Approve</button>
    <button onClick={() => onRejectPlan(plan.id)}>Reject</button>
  </div>
  <div className="orch-task-list">
    {plan.tasks.map(task => (
      <div key={task.id} className="orch-task-item">
        <span>{task.description}</span>
        <span className="task-status">{task.status}</span>
      </div>
    ))}
  </div>
</div>
```

**目标状态（Native 版）**：
```typescript
// AgentChatPanel.ts
private _orchPlanOverlay: HTMLElement;

public showOrchestrationPlanDialog(plan: OrchestrationPlan): void {
  this._orchPlanOverlay.style.display = 'flex';
  this._orchPlanOverlay.innerHTML = '';
  
  // 渲染计划目标
  const header = document.createElement('div');
  header.className = 'orch-plan-header';
  header.innerHTML = `<h2>${plan.goal}</h2>`;
  
  // 渲染任务列表
  const taskList = document.createElement('div');
  taskList.className = 'orch-task-list';
  plan.tasks.forEach(task => {
    const taskItem = this._createTaskItem(task);
    taskList.appendChild(taskItem);
  });
  
  // 添加操作按钮
  const actions = document.createElement('div');
  actions.className = 'orch-plan-actions';
  actions.appendChild(this._createButton('Approve', () => this._opts.onApprovePlan?.(plan.id)));
  actions.appendChild(this._createButton('Reject', () => this._opts.onRejectPlan?.(plan.id)));
  
  this._orchPlanOverlay.appendChild(header);
  this._orchPlanOverlay.appendChild(taskList);
  this._orchPlanOverlay.appendChild(actions);
}
```

**实施步骤**：
1. 在 `AgentChatPanel` 中添加 `_orchPlanOverlay` 属性
2. 实现 `showOrchestrationPlanDialog()` 方法（已有，需完善）
3. 实现 `_createTaskItem()` 方法（渲染单个任务）
4. 实现编辑任务表单（`_showEditTaskForm()`）
5. 实现分解任务按钮（`_showDecomposeTaskForm()`）
6. 添加单元测试验证编排计划 UI

**注意**：此任务已在之前的工作中部分完成，需继续完善。

##### 任务 3.4：移植图片兼容性检查

**当前状态（React 版）**：
```typescript
// ChatComposer.tsx
const warning = getImageSupportWarning(selectedModel, attachedImages);
if (warning) {
  return <div className="image-support-warning">{warning}</div>;
}
```

**目标状态（Native 版）**：
```typescript
// AgentChatPanel.ts
private _checkImageSupport(): void {
  const warning = getImageSupportWarning(this._selectedModelId, this._attachedImages);
  if (warning) {
    this._showImageSupportWarning(warning);
  }
}

private _showImageSupportWarning(warning: string): void {
  const warningEl = document.createElement('div');
  warningEl.className = 'image-support-warning';
  warningEl.textContent = warning;
  this._composerArea.appendChild(warningEl);
}
```

**实施步骤**：
1. 将 `getImageSupportWarning()` 函数从 React 版本移植到 Native 版本
2. 在 `AgentChatPanel` 中添加 `_checkImageSupport()` 方法
3. 在图片附件变化时调用 `_checkImageSupport()`
4. 测试图片兼容性检查功能

#### 3.3 交付物
- [ ] 技能芯片功能恢复（P1）
- [ ] AgentSession 多会话管理增强（P1）
- [ ] 编排计划审查 UI 完善（P0）
- [ ] 图片兼容性检查移植（P1）

---

### 阶段 4：测试与验证（Week 9-10）

**目标**：确保 Native 版本功能完整、性能优于 React 版本、无回归问题。

#### 4.1 测试策略

| 测试类型 | 测试内容 | 工具 | 优先级 |
|----------|----------|------|--------|
| **单元测试** | `AgentChatPanel` 核心逻辑 | Jest + jsdom | P0 |
| **集成测试** | `NativeChatEditorPane` + `AgentChatPanel` 集成 | VS Code Test | P0 |
| **E2E 测试** | 用户完整操作流程 | Playwright | P1 |
| **性能测试** | 消息发送延迟、内存占用 | Chrome DevTools | P1 |
| **回归测试** | 与 React 版本功能对比 | 手动测试 | P0 |

#### 4.2 测试清单

##### 4.2.1 单元测试

| # | 测试案例 | 描述 | 状态 |
|---|----------|------|------|
| 4.1.1 | `AgentChatPanel` 构造函数 | 验证回调函数正确传入 | 🔲 待做 |
| 4.1.2 | `showOrchestrationPlanDialog` | 验证编排计划对话框正确显示 | 🔲 待做 |
| 4.1.3 | `_streamingTick` | 验证流式处理逻辑正确 | 🔲 待做 |
| 4.1.4 | `_handleSendMessage` | 验证消息发送逻辑正确 | 🔲 待做 |
| 4.1.5 | `_renderSkillChips` | 验证技能芯片正确渲染 | 🔲 待做 |

##### 4.2.2 集成测试

| # | 测试案例 | 描述 | 状态 |
|---|----------|------|------|
| 4.2.1 | `NativeChatEditorPane` 创建 | 验证 Native 面板正确创建 | 🔲 待做 |
| 4.2.2 | 消息发送流程 | 验证从 UI 点击到后端调用的完整流程 | 🔲 待做 |
| 4.2.3 | 编排计划审批流程 | 验证编排计划审批完整流程 | 🔲 待做 |
| 4.2.4 | 多会话切换 | 验证多会话切换功能 | 🔲 待做 |

##### 4.2.3 E2E 测试

| # | 测试案例 | 描述 | 状态 |
|---|----------|------|------|
| 4.3.1 | 用户发送消息 | 用户输入文本，点击发送，验证消息显示 | 🔲 待做 |
| 4.3.2 | 流式响应 | 验证流式响应正确显示（thinking、tool calls） | 🔲 待做 |
| 4.3.3 | 编排计划审批 | 验证编排计划对话框显示、审批、拒绝 | 🔲 待做 |
| 4.3.4 | 技能芯片点击 | 验证技能芯片点击后正确触发 | 🔲 待做 |

##### 4.2.4 性能测试

| # | 测试指标 | 目标值 | 当前值 | 状态 |
|---|----------|--------|--------|------|
| 4.4.1 | 消息发送延迟 | < 50ms | - | 🔲 待测 |
| 4.4.2 | 流式响应首字节延迟 | < 100ms | - | 🔲 待测 |
| 4.4.3 | 内存占用（空闲） | < 100MB | - | 🔲 待测 |
| 4.4.4 | 内存占用（流式） | < 200MB | - | 🔲 待测 |

#### 4.3 验收标准

**功能验收标准**：
- [ ] 所有 P0 功能与 React 版本功能 parity（消息发送、流式响应、编排计划审批）
- [ ] 所有 P1 功能与 React 版本功能 parity（技能芯片、多会话管理、图片兼容性检查）
- [ ] 无已知 P0/P1 bug

**性能验收标准**：
- [ ] 消息发送延迟 < 50ms（React 版本 ~100ms）
- [ ] 流式响应首字节延迟 < 100ms（React 版本 ~200ms）
- [ ] 内存占用降低 20%（相比 React 版本）

**代码质量验收标准**：
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试覆盖率 > 60%
- [ ] 无 TypeScript 编译错误
- [ ] ESLint 检查通过

#### 4.4 交付物
- [ ] 单元测试代码（覆盖率 > 80%）
- [ ] 集成测试代码（覆盖率 > 60%）
- [ ] E2E 测试代码（Playwright）
- [ ] 性能测试报告
- [ ] 回归测试报告

---

### 阶段 5：切换默认 & 移除 React（Week 11-12）

**目标**：将 Native 版本设为默认，移除 React 版本代码。

#### 5.1 切换默认

**步骤**：
1. 将 Feature Flag `enableNativeChat` 默认值改为 `true`
2. 监控线上错误率（Sentry/Log）
3. 如果错误率 < 1%，继续；否则回滚

#### 5.2 移除 React 版本代码

**移除清单**：

| # | 文件/目录 | 描述 | 优先级 | 状态 |
|---|-----------|------|--------|------|
| 5.2.1 | `src/vs/sessions/contrib/agentStudio/webview/` | React WebView 全部代码 | P0 | 🔲 待做 |
| 5.2.2 | `src/vs/sessions/contrib/agentStudio/browser/agentStudioWebviewController.ts` | WebView 控制器（简化版已创建） | P0 | 🔲 待做 |
| 5.2.3 | `src/vs/sessions/contrib/agentStudio/common/agentStudioWebviewService.ts` | WebView 服务 | P1 | 🔲 待做 |
| 5.2.4 | CSS 文件：`chat-enhanced.css`, `chat-cards.css`, `themes.css` | React 版本样式 | P1 | 🔲 待做 |

**注意**：移除前需确认：
- Native 版本已完全稳定
- 无用户反馈 P0/P1 bug
- 性能测试通过

#### 5.3 交付物
- [ ] Feature Flag `enableNativeChat` 默认值改为 `true`
- [ ] React WebView 代码移除（PR 提交）
- [ ] 迁移完成报告

---

## 四、风险缓解

### 4.1 已识别风险

| # | 风险描述 | 影响程度 | 概率 | 缓解措施 | 负责人 |
|---|----------|----------|------|----------|--------|
| R1 | **功能回归**：Native 版本缺少 React 版本的功能 | 🔴 高 | 中 | 功能 parity 检查清单（阶段 3） | 全员 |
| R2 | **性能下降**：Native 版本性能不如 React 版本 | 🔴 高 | 低 | 性能测试（阶段 4） | 性能工程师 |
| R3 | **兼容性问题**：Native 版本在某些环境下不兼容 | 🟡 中 | 中 | 多环境测试（Windows/Mac/Linux） | QA |
| R4 | **代码冲突**：迁移期间 React 版本有新的提交 | 🟡 中 | 高 | 定期同步 main 分支 | 全员 |
| R5 | **回调地狱**：回调函数过多导致代码难以维护 | 🟡 中 | 中 | 回调函数分组管理（详见 4.2） | 架构师 |

### 4.2 风险缓解措施详解

#### R5：回调地狱缓解措施

**问题**：`AgentChatPanel` 构造函数有 30+ 个回调函数，代码难以维护。

**解决方案**：回调函数分组管理

```typescript
//  before: 所有回调在一个对象中
constructor(opts: {
  onSendMessage: (...) => void;
  onCancelExecution: () => void;
  onSelectAgent: (...) => void;
  // ... 30+ callbacks
})

// after: 回调分组为子对象
constructor(opts: {
  chat: ChatCallbacks;
  agent: AgentCallbacks;
  provider: ProviderCallbacks;
  orchestration: OrchestrationCallbacks;
})

interface ChatCallbacks {
  onSendMessage: (text: string, explicitSkillIds?: string[]) => void;
  onCancelExecution: () => void;
  onToggleCollapse: () => void;
}

interface AgentCallbacks {
  onSelectAgent: (id: string) => void;
  onListSkills: () => ReadonlyArray<...>;
}

interface ProviderCallbacks {
  onSelectProvider: (providerId: string) => void;
  onSelectModel: (modelId: string) => void;
}

interface OrchestrationCallbacks {
  onApprovePlan: (planId: string) => void;
  onRejectPlan: (planId: string) => void;
  // ...
}
```

**实施步骤**：
1. 定义 4 个回调函数接口（`ChatCallbacks`, `AgentCallbacks`, `ProviderCallbacks`, `OrchestrationCallbacks`）
2. 修改 `AgentChatPanel` 构造函数参数
3. 更新所有调用点（`NativeChatEditorPane`, `chatBarPart`）
4. 添加 TypeScript 类型检查

---

## 五、时间线与里程碑

### 5.1 总体时间线

```
Week 1-2:  阶段 1 - 准备基础设施
Week 3-5:  阶段 2 - 核心 WebView 替换
Week 6-8:  阶段 3 - 功能 Parity 恢复
Week 9-10: 阶段 4 - 测试与验证
Week 11-12: 阶段 5 - 切换默认 & 移除 React
```

**总工期**：12 周（约 3 个月）

### 5.2 里程碑

| 里程碑 | 时间 | 交付物 | 成功标准 |
|--------|------|--------|----------|
| **M1: 基础设施就绪** | Week 2 | Feature Flag、迁移分支、单元测试框架 | Feature Flag 可切换 React/Native |
| **M2: 核心替换完成** | Week 5 | Native 版本核心功能可用 | 消息发送、流式响应、编排计划审批可用 |
| **M3: 功能 Parity 达成** | Week 8 | 所有 P0/P1 功能与 React 版本 parity | 功能 parity 检查清单通过 |
| **M4: 测试验证通过** | Week 10 | 单元测试、集成测试、E2E 测试、性能测试 | 所有测试通过，性能达标 |
| **M5: 迁移完成** | Week 12 | React 代码移除，Native 成为默认 | 无 React 代码，Native 稳定 |

### 5.3 关键依赖

| 依赖 | 描述 | 影响 | 缓解措施 |
|------|------|------|----------|
| **后端 `agentChatService.ts` 稳定** | 后端服务不能有大改动 | 如果后端改动，前端迁移需同步 | 与后端团队同步，锁定接口 |
| **VS Code API 稳定** | VS Code 版本升级不能破坏 Native 代码 | 如果 VS Code API 改动，需适配 | 锁定 VS Code 版本，定期升级测试 |
| **测试环境可用** | 需要 Windows/Mac/Linux 测试环境 | 如果环境不可用，测试无法执行 | 申请云测试环境 |

---

## 六、回滚计划

### 6.1 回滚触发条件

满足以下任一条件，触发回滚：
1. **P0 bug 数量 > 5**：上线后 24 小时内发现 > 5 个 P0 bug
2. **错误率 > 1%**：线上错误率 > 1%（Sentry/Log 监控）
3. **性能下降 > 20%**：Native 版本性能比 React 版本下降 > 20%
4. **用户投诉 > 10 条/天**：用户反馈问题 > 10 条/天

### 6.2 回滚步骤

**步骤**：
1. **立即回滚**：将 Feature Flag `enableNativeChat` 改为 `false`
2. **发布公告**：在内部论坛/Slack 发布回滚公告
3. **问题分析**：召开事故分析会，定位问题根因
4. **修复问题**：在迁移分支修复问题
5. **重新发布**：修复后再次发布（回到阶段 4 测试）

**回滚时间**：
- 自动化回滚：< 5 分钟（Feature Flag 切换）
- 手动回滚：< 30 分钟（代码回滚 + 重新部署）

### 6.3 回滚验证

回滚后需验证：
- [ ] React 版本功能正常（消息发送、流式响应、编排计划审批）
- [ ] 无新增 bug
- [ ] 性能恢复到 React 版本水平

---

## 七、资源需求

### 7.1 人力资源

| 角色 | 人数 | 职责 | 投入时间 |
|------|------|------|----------|
| **前端工程师（Lead）** | 1 | 整体架构设计、代码审核、风险决策 | 100% (12 周) |
| **前端工程师** | 2 | 代码实现（阶段 2-3） | 100% (10 周) |
| **测试工程师** | 1 | 测试计划、测试执行、自动化测试 | 50% (8 周) |
| **性能工程师** | 1 | 性能测试、性能优化 | 25% (4 周) |
| **产品经理** | 1 | 需求确认、优先级决策、用户反馈收集 | 10% (12 周) |

**总计**：约 4.5 人（前端 3 + 测试 0.5 + 性能 0.25 + 产品 0.1）

### 7.2 硬件资源

| 资源 | 描述 | 数量 | 用途 |
|------|------|------|------|
| **开发机** | Windows/Mac/Linux 各一台 | 3 | 跨平台开发测试 |
| **测试环境** | CI/CD 流水线 | 1 | 自动化测试 |
| **云测试环境** | BrowserStack 或类似 | 1 | 多浏览器测试 |

### 7.3 预算

| 项目 | 金额（RMB） | 说明 |
|------|------------|------|
| **人力成本** | ~360,000 | 4.5 人 × 3 个月 × 26,667 RMB/人月 |
| **云测试环境** | ~10,000 | BrowserStack 企业版 3 个月 |
| **其他** | ~5,000 | 培训、文档、工具license |
| **总计** | **~375,000 RMB** | - |

---

## 八、沟通计划

### 8.1 沟通频率

| 会议类型 | 频率 | 参与者 | 议程 |
|----------|------|--------|------|
| **每日站会** | 每天 | 前端工程师、测试工程师 | 进度更新、阻塞问题、今日计划 |
| **周会** | 每周一 | 全员 | 本周计划、上周完成、风险讨论 |
| **里程碑评审会** | 每个里程碑结束时 | 全员 + 管理层 | 里程碑交付物评审、下阶段计划 |
| **事故分析会** | 按需 | 相关工程师 + 管理层 | 问题根因分析、改进措施 |

### 8.2 沟通工具

| 工具 | 用途 |
|------|------|
| **Slack/Teams** | 日常沟通、问题讨论 |
| **Jira/Linear** | 任务管理、进度跟踪 |
| **Google Docs** | 文档协作、设计评审 |
| **GitHub** | 代码评审、PR 管理 |
| **Sentry/Log** | 线上监控、错误追踪 |

### 8.3 报告机制

| 报告类型 | 频率 | 接收者 | 内容 |
|----------|------|--------|------|
| ** weekly 报告** | 每周五 | 管理层 | 本周完成、下周计划、风险/issues |
| **里程碑报告** | 每个里程碑结束时 | 管理层 + 全员 | 交付物清单、质量报告、下阶段计划 |
| **事故报告** | 事故发生后 24 小时内 | 管理层 | 事故描述、影响范围、根因分析、改进措施 |

---

## 九、附录

### 9.1 术语表

| 术语 | 定义 |
|------|------|
| **React WebView 版** | 使用 React + WebView 架构的聊天功能（当前版本） |
| **Native 版** | 使用原生 DOM 操作的聊天功能（目标版本） |
| **Feature Flag** | 功能开关，用于动态切换 React/Native 版本 |
| **Parity** | 功能对等，指 Native 版本功能与 React 版本一致 |
| **Strangler Fig 模式** | 渐进式替换模式，逐步将旧系统替换为新系统 |

### 9.2 参考文档

1. [React版聊天框 vs Native版聊天框 — 接口差异及替换影响分析](./react-vs-native-analysis.md)（本文档的依赖分析）
2. [AgentChatPanel.ts 源代码](./src/vs/sessions/browser/agentChat/agentChatPanel.ts)
3. [NativeChatEditorPane.ts 源代码](./src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts)
4. [agentStudioWebviewController.ts 源代码](./src/vs/sessions/contrib/agentStudio/browser/agentStudioWebviewController.ts)

### 9.3 变更日志

| 版本 | 日期 | 作者 | 变更内容 |
|------|------|------|----------|
| v1.0 | 2025-06-16 | AI Agent | 初始版本，基于用户提供的分析创建 |

---

## 十、审批

| 角色 | 姓名 | 审批意见 | 日期 |
|------|------|----------|------|
| **技术负责人** | [待填写] | [待填写] | [待填写] |
| **产品经理** | [待填写] | [待填写] | [待填写] |
| **测试负责人** | [待填写] | [待填写] | [待填写] |

---

**文档结束**
