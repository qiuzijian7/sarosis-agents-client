# Void vs Saros 聊天框渲染逻辑对比分析

## 一、技术栈对比

| 维度 | Void | Saros |
|------|------|---------|
| UI 框架 | **React** (VDOM diffing) | **原生 DOM 操作** (imperative) |
| Markdown 解析 | `marked.lexer()` — **同步** | VS Code `renderMarkdown` — **含异步代码块** |
| 代码块渲染 | Monaco `CodeEditorWidget` + `setValue()` | 自定义 HTML + `codeBlockRenderer` Promise |
| 消息状态管理 | React hooks (`useState`/`useMemo`) | 类成员数组 `_messages: IAgentChatMessage[]` |
| 虚拟化 | 无 | 无 |

---

## 二、核心差异分析（6 个关键点）

### 差异 1：流式更新策略 — React diff vs 全量重建

#### Void：React VDOM diffing，只更新变化的节点

```tsx
// SidebarChat.tsx:2968 — 已提交消息 useMemo 缓存
const previousMessagesHTML = useMemo(() => {
    return previousMessages.map((message, i) => {
        return <ChatBubble key={i} chatMessage={message} isCommitted={true} ... />
    })
}, [previousMessages, threadId, currCheckpointIdx, isRunning])
// ↑ 流式期间 previousMessages 引用不变 → 已提交消息 NOT 重渲染

// SidebarChat.tsx:2986 — 流式消息单独渲染
const currStreamingMessageHTML = ...
    <ChatBubble chatMessage={{
        role: 'assistant',
        displayContent: displayContentSoFar ?? '',  // 每次都传完整文本
    }} isCommitted={false} />
```

每个 token 到达时：
1. `displayContentSoFar` 更新 → 只有 `currStreamingMessageHTML` 重渲染
2. `previousMessagesHTML` 因 `useMemo` 缓存，**完全不重渲染**
3. React reconciler 对 `ChatMarkdownRender` 做 VDOM diff：
   - `marked.lexer(string)` 重新解析完整文本为 token 数组
   - React diff token 数组，**只更新变化的 DOM 节点**（通常是最后一个文本节点追加字符）

#### Saros：清空容器 + 全量重建

```typescript
// agentChatPanel.ts:1857 — 快速路径 1
if (streamingContainer) {
    streamingContainer.textContent = '';              // ← 清空所有 DOM！
    this._renderMarkdownContent(streamingContainer, msg.content);  // ← 从零重建
    return;
}
```

每个 token 到达时：
1. `updateMessage` → `_updateMessageDom` → 快速路径
2. **清空整个 streaming-container 的所有子节点**
3. 调用 `_renderMarkdownContent` → `renderMarkdown(md, options, parent)` **从零重建所有 markdown DOM 节点**
4. 这意味着已渲染的段落、列表、链接等全部被销毁重建

**性能影响**：消息越长，每次 token 更新的成本越高（O(n)，n=消息长度）。Void 的 React diffing 只 O(1) 追加到最后一个变化节点。

---

### 差异 2：Markdown 渲染 — 同步 vs 异步代码块

#### Void：`marked.lexer()` 完全同步

```tsx
// ChatMarkdownRender.tsx:546
export const ChatMarkdownRender = ({ string, ... }) => {
    const tokens = marked.lexer(string);  // ← 同步解析
    return (
        <>
            {tokens.map((token, index) => (
                <RenderToken key={index} token={token} ... />
            ))}
        </>
    )
}
```

- `marked.lexer()` 同步返回 token 数组
- React 同步渲染所有 token 为 VDOM
- **代码块也是同步渲染**：直接创建 `BlockCode` 组件

#### Saros：`renderMarkdown` 代码块异步插入

```typescript
// agentChatPanel.ts:4000 — codeBlockRenderer 返回 Promise
const options: MarkdownRenderOptions = {
    codeBlockRenderer: (languageAlias, code) => {
        // ... 构建 wrapper ...
        return Promise.resolve(wrapper);  // ← 异步！
    },
};
const disposable = renderMarkdown(md, options, parent);
// VS Code 的 renderMarkdown 对返回 Promise 的 codeBlockRenderer：
// 1. 先创建占位元素插入 DOM
// 2. Promise resolve 后替换占位元素
// → 代码块在微任务中异步插入，scrollHeight 在同步代码中不含代码块高度
```

**性能影响**：
- Void：所有 DOM 变化在一个同步帧内完成 → `scrollHeight` 立即可用
- Saros：代码块异步插入 → 同步 `_scrollToBottom` 读到的 `scrollHeight` 不含代码块 → 视图脱离底部（已用 rAF 循环修复）

---

### 差异 3：代码块更新 — `setValue()` vs 全量重建

#### Void：Monaco `setValue()` 增量更新

```tsx
// inputs.tsx:1609 — BlockCode 组件
useEffect(() => {
    initValueRef.current = initValue
    modelRef.current?.setValue(initValue)  // ← 只更新文本模型，不重建编辑器
}, [initValue])
```

流式过程中代码块未闭合时：
- `initValue` 变化 → `setValue()` 更新 Monaco model
- **编辑器 widget 不销毁、不重建**，只更新文本内容
- 语法高亮由 Monaco 增量 tokenization 处理

#### Saros：每次 token 都清空 + 重建代码块 HTML

```typescript
// agentChatPanel.ts:1858 — 快速路径
streamingContainer.textContent = '';  // ← 代码块 DOM 被销毁
this._renderMarkdownContent(streamingContainer, msg.content);
// → renderMarkdown 重新创建 code-block-wrapper、header、copy button、pre/code 等全部 DOM
```

**性能影响**：每个 token 都销毁重建代码块的所有 DOM 节点（header、按钮、pre、code），包括重新创建 SVG 图标和事件监听器。

---

### 差异 4：已提交消息隔离 — `useMemo` vs 无隔离

#### Void：`useMemo` 隔离已提交消息

```tsx
const previousMessagesHTML = useMemo(() => {
    return previousMessages.map((message, i) => <ChatBubble ... />)
}, [previousMessages, threadId, currCheckpointIdx, isRunning])
```

流式期间：
- `displayContentSoFar` 变化不触发 `previousMessages` 引用变化
- `useMemo` 命中缓存 → **已提交消息完全不参与重渲染**
- React 只 reconcile `currStreamingMessageHTML` 一棵子树

#### Saros：无隔离，全量操作

```typescript
// agentChatPanel.ts:438 — setMessages
setMessages(messages: IAgentChatMessage[]): void {
    this._messages = messages;
    this._renderMessages();  // ← 清空容器 + 重建所有消息 DOM
}
```

- `setMessages` 每次调用都 `clearNode` + 重建全部消息
- `updateMessage` 虽然只更新单条，但 `_updateMessageDom` 的慢路径 `_rebuildMessageElement` 也会 `replaceChild`
- 没有将"流式中的消息"与"已提交的消息"做渲染隔离

---

### 差异 5：Scroll 时机 — useEffect(commit 后) vs 同步(渲染后立即)

#### Void：`useEffect` 在 React commit 后执行

```tsx
// SidebarChat.tsx:477
useEffect(() => {
    if (isAtBottom) {
        scrollToBottom(divRef);  // ← 此时 DOM 已全部 commit
    }
}, [children, isAtBottom]);
```

React 渲染周期：
1. `render` — 计算 VDOM
2. `commit` — 应用 DOM 变化（同步）
3. `useEffect` — **在 commit 之后执行**，此时 `scrollHeight` 包含所有新内容
4. `scrollTop = scrollHeight` — 读到正确的高度

#### Saros：同步调用，在 DOM 操作之后立即执行

```typescript
// agentChatPanel.ts:809
this._updateMessageDom(idx, m);   // DOM 更新
this._updateContextRing();
this._scrollToBottom(false);      // ← 同步紧跟，异步代码块尚未插入
```

- `_scrollToBottom` 在 `_updateMessageDom` 之后同步执行
- 如果 `renderMarkdown` 有异步内容（代码块 Promise），此时 `scrollHeight` 不含异步内容
- 已用 `_startStreamScroll()` rAF 循环修复（rAF 在微任务后执行，追平异步插入）

---

### 差异 6：DOM 操作粒度 — React reconcile vs textContent=''

#### Void：React 最小化 DOM 操作

React reconciler 对比新旧 VDOM 树：
- 文本节点变化：只更新 `textContent` 或 `nodeValue`
- 列表追加：只 `appendChild` 新节点
- 属性变化：只 `setAttribute` 变化的属性
- **已存在的节点不会被销毁重建**

#### Saros：`textContent = ''` 暴力清空

```typescript
streamingContainer.textContent = '';  // 销毁所有子节点
this._renderMarkdownContent(streamingContainer, msg.content);  // 从零创建
```

- 每个 token 都销毁所有已渲染的 DOM 节点
- `renderMarkdown` 重新创建所有 `<p>`, `<code>`, `<pre>`, `<a>`, `<ul>` 等元素
- 垃圾回收压力大（大量短生命周期 DOM 对象）
- 浏览器需要重新计算布局（reflow）和重绘（repaint）整个容器

---

## 三、性能影响量化

| 操作 | Void (React) | Saros (Raw DOM) |
|------|-------------|-------------------|
| 单 token 更新成本 | O(1) — React diff 只更新最后一个变化节点 | O(n) — 清空 + 重建所有 markdown 节点 |
| 代码块更新 | O(1) — `setValue()` 更新文本模型 | O(m) — 重建代码块全部 DOM (header + buttons + pre + code) |
| 已提交消息 | O(0) — `useMemo` 缓存，不参与重渲染 | O(0) — `updateMessage` 只更新单条，但 `setMessages` 会全量重建 |
| 异步内容 | 无 — `marked.lexer` 同步 | 有 — `renderMarkdown` 代码块 Promise 异步 |
| GC 压力 | 低 — 节点复用 | 高 — 每次销毁重建产生大量短生命周期对象 |
| Reflow/Repaint | 最小化 — 只更新变化节点 | 全量 — 整个容器 reflow |

---

## 四、优化建议（Saros 侧）

### P0：流式更新改为增量追加（而非清空重建）

当前每个 token 都 `textContent = ''` + `renderMarkdown`，改为：
1. 维护已渲染的 markdown token 列表
2. 新 token 到达时，只 diff 最后一个未完成的 token
3. 只更新变化的 DOM 节点，不清空容器

### P1：代码块使用 Monaco `setValue()` 增量更新

参考 Void 的 `BlockCode` 组件：
1. 代码块创建时初始化 Monaco `CodeEditorWidget`（只读）
2. 流式更新时调 `model.setValue(newContent)` 而非重建 DOM
3. 避免 `codeBlockRenderer` 返回 Promise（消除异步插入问题）

### P2：已提交消息渲染隔离

参考 Void 的 `useMemo`：
1. 流式消息与已提交消息分离为不同容器
2. 流式更新只操作流式消息容器
3. 已提交消息 DOM 不被触碰

### P3：替换 `renderMarkdown` 为 `marked.lexer`

1. 使用 `marked.lexer()` 同步解析（消除异步代码块问题）
2. 自定义 token 渲染器（可控的 DOM 创建）
3. 支持增量更新（只渲染新增/变化的 token）
