# Keyed Reconciliation 重构方案

> **状态：已全部执行完毕（2026-07-27）**
> 目标：用统一 keyed diff 替代 7 条手写 fast rules，消除"每新场景加一条规则"的维护负担，根治流式闪烁。

---

## 1. 现状与问题

### 当前 fast rules 链（7 条 + 3 条 slow）

```
fast rules（messages.ts:410-418）:
  ① thinking-state-change    → thinking indicator 增删 → rebuild（低频）
  ② thinking-in-place        → thinking 文本流式 → 更新 last thinking card body
  ③ streaming-text-only      → 纯文本流式 → mdScheduler 节流
  ④ tool-cards-in-place      → 有正文+工具卡 → 更新状态+文本
  ⑤ write-file-args-streaming → 写文件参数流式 → 刷新写文件卡片
  ⑥ tool-args-streaming      → 其他工具参数流式 → 仅同步状态
  ⑦ append-new-parts         → 新 part 追加 → 仅 append

slow rules（messages.ts:421-425）:
  ① stream-end-transition    → 流式结束清理
  ② first-tool-start-append  → 首个工具卡追加
  ③ tool-status-sync         → 非流式状态同步

fallback: _rebuildMessageElement → 全量重建
```

### 问题

1. **规则膨胀**：每发现一个新闪烁场景就要加一条规则（已积累 7 条）
2. **规则间重叠**：②③④⑤⑥⑦ 都在处理"part 变化"的不同子集，边界条件互相纠缠
3. **计数式 diff**：`_ruleAppendNewParts` 用"计数"（`domThinking === msgThinking`）判断新旧 part，无法处理 part 修改/删除/重排
4. **缺失 fallback**：任何规则不命中 → `_rebuildMessageElement` 全量重建 → 闪烁

---

## 2. 核心设计

### 2.1 Key 分配策略

每个 part 元素携带 `data-part-key` 属性，key 在同一个 msg 生命周期内稳定：

| part 类型 | key 格式 | 示例 | 稳定性来源 |
|-----------|---------|------|-----------|
| thinking | `thinking:${msgId}#tk${index}` | `thinking:abc#tk0` | msgId + part index |
| text | `text:${msgId}#t${index}` | `text:abc#t1` | msgId + part index |
| tool | `tool:${toolCall.id}` | `tool:call_123` | toolCall.id（服务端分配） |
| subagent | `subagent:${subAgent.id}` | `subagent:sa_456` | subAgent.id |

**为什么 text/thinking 用 index 而非 content hash**：parts 是 append-only 流式序列，index 天然稳定；content hash 有碰撞风险且长文本 hash 计算开销大。

### 2.2 核心算法：`_reconcileParts`

```
输入：bubble（DOM 容器）、msg（新消息数据）
输出：DOM 与 msg.parts 一致（最小操作集）

步骤：
  1. _buildKeyedParts(msg) → 有序 keyed part 列表
  2. 收集 DOM 中已有 [data-part-key] 元素 → Map<key, el>
  3. 遍历 keyed parts：
     - key 存在 → _updatePartInPlace(el, part, msg)（就地更新）
     - key 不存在 → _createPartElement(part) → 插入正确位置
  4. 遍历剩余未匹配 DOM 元素 → remove()
  5. _updateStreamingContainerMark(bubble, msg)（重标 streaming-container）
  6. _updateToolCardStatuses(bubble, msg)（工具卡状态同步）
  7. _ensurePhaseIndicator(bubble, msg)（阶段指示器）
```

### 2.3 简化后的责任链

```
fast rules（2 条）:
  ① thinking-state-change  → thinking indicator 增删 → rebuild（保留，低频）
  ② keyed-reconcile        → 统一 keyed diff（替代原 ②③④⑤⑥⑦）

slow rules（3 条，不变）:
  ① stream-end-transition
  ② first-tool-start-append
  ③ tool-status-sync

fallback: _rebuildMessageElement（保留，仅 thinking-state-change 和极端场景触发）
```

---

## 3. 详细实现

### 3.1 `_buildKeyedParts(msg)` — 构建有序 keyed part 列表

```typescript
interface IKeyedPart {
  key: string;
  part: IMessagePart;
  index: number; // 在 msg.parts 中的原始索引
}

private _buildKeyedParts(msg: IAgentChatMessage): IKeyedPart[] {
  const parts = msg.parts!;
  const result: IKeyedPart[] = [];

  // update_plan 替换语义：只保留最后一张
  let lastUpdatePlanIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as any;
    if (p.kind === 'tool' && p.tool?.name === 'update_plan') { lastUpdatePlanIdx = i; }
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    let key: string | null = null;

    if (part.kind === 'thinking') {
      key = `thinking:${msg.id}#tk${i}`;
    } else if (part.kind === 'text') {
      if (part.text.trim().length === 0) { continue; } // 跳过空 text
      key = `text:${msg.id}#t${i}`;
    } else if (part.kind === 'tool') {
      const tool = (part as any).tool;
      if (tool?.name === 'update_plan' && i !== lastUpdatePlanIdx) { continue; } // 跳过非最后 update_plan
      key = `tool:${tool?.id ?? `auto-${i}`}`;
    } else if (part.kind === 'subagent') {
      key = `subagent:${(part as any).subAgent?.id ?? `auto-${i}`}`;
    }

    if (key) { result.push({ key, part, index: i }); }
  }
  return result;
}
```

**边界处理**：
- 空 text part → 跳过（不生成 key，不创建元素）
- 非最后 update_plan → 跳过（替换语义）
- tool/subagent 无 id → 用 `auto-${index}` 兜底

### 3.2 `_reconcileParts(bubble, msg)` — 统一 keyed diff

```typescript
private _reconcileParts(bubble: HTMLElement, msg: IAgentChatMessage): void {
  const keyedParts = this._buildKeyedParts(msg);

  // 收集已有 keyed 元素
  const existingMap = new Map<string, HTMLElement>();
  for (const el of bubble.querySelectorAll('[data-part-key]')) {
    existingMap.set(el.getAttribute('data-part-key')!, el as HTMLElement);
  }

  // 三路 diff：更新已有、创建新增、标记删除
  let prevEl: HTMLElement | null = null;
  for (const kp of keyedParts) {
    let el = existingMap.get(kp.key);
    if (el) {
      // 已有元素 → 就地更新
      this._updatePartInPlace(el, kp.part, msg);
      existingMap.delete(kp.key); // 标记已处理
    } else {
      // 新元素 → 创建 + 插入
      const newEl = this._createPartElement(kp.part, kp.index, msg, !!msg.isStreaming);
      if (!newEl) { continue; }
      newEl.setAttribute('data-part-key', kp.key);
      el = newEl;
      // 插入到 prevEl 之后
      if (prevEl) {
        prevEl.after(el);
      } else {
        // 首个 part：插在第一个非附件子元素之前
        const firstNonAttach = Array.from(bubble.children).find(
          c => !c.classList.contains('message-attachments')
        );
        if (firstNonAttach) { bubble.insertBefore(el, firstNonAttach); }
        else { bubble.appendChild(el); }
      }
    }
    prevEl = el;
  }

  // 删除残留元素（key 不存在于新 parts 中）
  for (const [, el] of existingMap) { el.remove(); }

  // 后处理
  this._updateStreamingContainerMark(bubble, msg);
  this._updateToolCardStatuses(bubble, msg);
  this._ensurePhaseIndicator(bubble, msg);
}
```

### 3.3 `_updatePartInPlace(el, part, msg)` — 就地更新已有 part

```typescript
private _updatePartInPlace(el: HTMLElement, part: IMessagePart, msg: IAgentChatMessage): void {
  if (part.kind === 'text') {
    // text：mdScheduler 节流更新（增量 markdown 渲染）
    this.mdScheduler.schedule(el, part.text, 'markdown');
  } else if (part.kind === 'thinking') {
    // thinking：更新 header（spinner ↔ ...）+ body（流式文本）
    this._updateThinkingCardHeader(el, msg);
    const body = el.querySelector('.thinking-card-body') as HTMLElement | null;
    if (body && body.dataset.rendered === '1') {
      this._attachStreamCardPin(body);
      this.thinkingMdScheduler.schedule(body, (part as IThinkingMessagePart).text, 'markdown');
    }
  } else if (part.kind === 'tool') {
    // tool：状态类名变化由 _updateToolCardStatuses 统一处理
    // 此处无需操作（_reconcileParts 末尾统一调用）
  }
  // subagent：数据内嵌在 tool card 中，无独立更新
}
```

### 3.4 `_updateStreamingContainerMark(bubble, msg)` — 重标流式容器

```typescript
private _updateStreamingContainerMark(bubble: HTMLElement, msg: IAgentChatMessage): void {
  if (!msg.isStreaming || !msg.parts) { return; }

  // 找到最后一个非空 text part 的 key
  let lastTextKey: string | null = null;
  for (let i = 0; i < msg.parts.length; i++) {
    const p = msg.parts[i];
    if (p.kind === 'text' && p.text.trim().length > 0) {
      lastTextKey = `text:${msg.id}#t${i}`;
    }
  }

  // 重标 streaming-container
  for (const seg of bubble.querySelectorAll('.parts-text-segment[data-part-key]')) {
    const key = seg.getAttribute('data-part-key');
    if (key === lastTextKey) {
      seg.classList.add('streaming-container');
    } else {
      seg.classList.remove('streaming-container');
    }
  }
}
```

### 3.5 `_ruleKeyedReconcile(ctx)` — fast rule 入口

```typescript
private _ruleKeyedReconcile(ctx: IMsgUpdateCtx): boolean {
  if (!ctx.msg.isStreaming || !ctx.hasParts) { return false; }
  const bubble = ctx.el.querySelector('.chat-bubble') as HTMLElement | null;
  if (!bubble) { return false; }
  this._reconcileParts(bubble, ctx.msg);
  return true;
}
```

### 3.6 `_renderPartsContent` 加 key 标记

```typescript
// 在 _renderPartsContent 中为每个 part 元素加 data-part-key
for (let k = 0; k < parts.length; k++) {
  const part = parts[k];
  if (part.kind === 'text') {
    if (part.text.trim().length === 0) { continue; }
    const segEl = append(bubble, $('.message-content.parts-text-segment'));
    segEl.setAttribute('data-part-key', `text:${hostMsg?.id}#t${k}`);  // ← 新增
    if (isStreaming && k === lastTextIdx) { segEl.classList.add('streaming-container'); }
    this._renderMarkdownContent(segEl, part.text, isStreaming);
  } else if (part.kind === 'tool') {
    // ...
    const renderedCard = clarifyCard ?? this._createToolCallCard(toolPart);
    renderedCard.setAttribute('data-part-key', `tool:${toolPart?.id ?? `auto-${k}`}`);  // ← 新增
    bubble.appendChild(renderedCard);
  } else if (part.kind === 'thinking') {
    // ...
    const card = this._createThinkingCard({...});
    card.setAttribute('data-part-key', `thinking:${hostMsg?.id}#tk${k}`);  // ← 新增
    bubble.appendChild(card);
  } else if (part.kind === 'subagent') {
    const card = this._createSubAgentCard(...);
    card.setAttribute('data-part-key', `subagent:${...}`);  // ← 新增
    bubble.appendChild(card);
  }
}
```

### 3.7 `_createPartElement` 加 key 标记

```typescript
protected _createPartElement(part: IMessagePart, partIndex: number, msg: IAgentChatMessage, isStreaming: boolean): HTMLElement | null {
  // ... 现有逻辑不变，在返回前加 key
  if (part.kind === 'text') {
    // ...
    segEl.setAttribute('data-part-key', `text:${msg.id}#t${partIndex}`);  // ← 新增
    return segEl;
  }
  if (part.kind === 'tool') {
    // ...
    const card = clarifyCard ?? this._createToolCallCard(toolPart);
    card.setAttribute('data-part-key', `tool:${toolPart?.id ?? `auto-${partIndex}`}`);  // ← 新增
    return card;
  }
  // thinking / subagent 同理
}
```

---

## 4. 实施阶段

### Phase 1：加 key 标记（零风险）

**改动**：`_renderPartsContent` + `_createPartElement` 加 `data-part-key` 属性

**行为变化**：无（只加属性，不改变渲染逻辑）

**文件**：`markdown.ts`（2 处）

**验证**：F5 后正常聊天，确认 DOM 中有 `data-part-key` 属性

### Phase 2：实现 `_reconcileParts`（中风险）

**改动**：
1. `messages.ts` 新增 `_buildKeyedParts`、`_reconcileParts`、`_updatePartInPlace`、`_updateStreamingContainerMark`、`_ruleKeyedReconcile`
2. 将 `_ruleKeyedReconcile` 注册到 fast rules 链（放在 `append-new-parts` 之前）

**行为变化**：`keyed-reconcile` 优先于 `append-new-parts` 命中，处理所有 part 变化场景

**文件**：`messages.ts`（新增 ~120 行）

**验证**：
- 流式文本输出 → text part 就地更新，不 rebuild
- 新 thinking episode → 仅追加新 thinking card
- 新工具调用 → 仅追加新 tool card
- delegate_task 完成后新 text → 仅追加新 text segment
- 工具参数流式 → tool card 状态同步，不 rebuild

### Phase 3：简化 fast rules（中风险）

**改动**：
1. 从 fast rules 链中移除：`thinking-in-place`、`streaming-text-only`、`tool-cards-in-place`、`write-file-args-streaming`、`tool-args-streaming`、`append-new-parts`
2. 保留：`thinking-state-change`（结构性，低频）
3. 保留 slow rules：全部 3 条

**行为变化**：fast rules 从 7 条减到 2 条，所有 part 变化统一走 `keyed-reconcile`

**文件**：`messages.ts`（删除 ~200 行旧规则）

**验证**：全面回归测试（见第 5 节）

### Phase 4：清理（低风险）

**改动**：
1. 删除 `_hasStreamingStructureChanged`（被 keyed diff 替代）
2. 删除 `_updateStreamingContentInPlace`（被 `_reconcileParts` 吸收）
3. 保留 `_preserveStableSubagentNodes`（仍被 `_updateToolCardStatuses` 和 `_updateSubAgentCardsInPlace` 使用）
4. 保留 `_captureScrollPositions` / `_restoreScrollPositions`（仍被 fallback rebuild 和 card-level rebuild 使用）

**文件**：`messages.ts`（删除 ~40 行）

---

## 5. 测试计划

### 5.1 功能测试矩阵

| 场景 | 预期行为 | 验证方法 |
|------|---------|---------|
| 纯文本流式 | text segment 就地更新，无 rebuild | `__SAROSIS_PARTS_DIAG` 无 REBUILD 日志 |
| thinking 流式 | thinking card body 就地更新 | 观察 thinking card 文本增长 |
| 新 thinking episode | 仅追加新 thinking card | DOM 中 thinking-card 数量 +1 |
| 新工具调用 | 仅追加新 tool card | DOM 中 tool-header-wrapper 数量 +1 |
| 工具参数流式 | tool card 不 rebuild | 观察 tool card 无闪烁 |
| 工具完成 | tool card 状态 class 变化 | 观察 status pill 变为"完成" |
| delegate_task 完成后新 text | 仅追加新 text segment | delegate card 不动 |
| delegate_task 完成后新 thinking | 仅追加新 thinking card | delegate card 不动 |
| update_plan 替换 | 旧 update_plan 卡移除，新卡追加 | DOM 中只有一张 update_plan 卡 |
| clarify 卡片 | clarify 交互卡正确渲染 | 选项按钮可点击 |
| 空 text part | 不创建 DOM 元素 | 无空白 text segment |
| 多工具并行 | 各 tool card 独立更新 | 无交叉闪烁 |

### 5.2 性能测试

| 指标 | 当前（fast rules） | 目标（keyed reconcile） |
|------|-------------------|------------------------|
| 单次更新 DOM 操作数 | O(1) ~ O(N)（取决于规则命中） | O(1) ~ O(K)（K=变化 part 数） |
| 全量 rebuild 频率 | 每新 thinking episode / 新 part | 仅 thinking-state-change（低频） |
| CSS 动画重启次数 | 每 rebuild 一次 | 仅新 part 创建时 |
| 滚动位置丢失 | 每 rebuild 一次 | 仅新 part 创建时（无丢失） |

### 5.3 回归测试

```bash
# 类型检查
npm run compile-check-ts-native

# 转译
npm run transpile-client

# F5 手动测试
# 1. 发送一条需要多工具调用的消息
# 2. 观察 delegate_task 卡片在生成参数时不闪烁
# 3. 观察 delegate_task 完成后新 thinking/text 追加时卡片不抖动
# 4. 观察 thinking 卡片流式文本增长时无 rebuild
# 5. 观察工具卡片状态从 running → success 变化时无整卡闪烁
```

---

## 6. 影响范围

### 修改文件（2 个）

| 文件 | 改动量 | 说明 |
|------|--------|------|
| `messages.ts` | +120 / -240 行 | 新增 keyed reconcile 方法，删除旧 fast rules |
| `markdown.ts` | +8 行 | `_renderPartsContent` + `_createPartElement` 加 key 标记 |

### 不变文件（16 个）

`base.ts`、`toolCards.ts`、`delegateCards.ts`、`statusCards.ts`、`fileCards.ts`、`workflowCards.ts`、`composer.ts`、`dropdowns.ts`、`searchCard.ts`、`mermaidCard.ts`、`confirmCards.ts`、`send.ts`、`header.ts`、`attachments.ts`、`codebaseCards.ts`、`agentChatTypes.ts`

### 保留机制

- `_thinkingCardState` Map（thinking 折叠态）
- `_toolCallExpandState` Map（工具卡展开态）
- `mdScheduler` / `thinkingMdScheduler`（文本/thinking 流式节流）
- `_preserveStableSubagentNodes`（card-level rebuild 节点保留）
- `_captureScrollPositions` / `_restoreScrollPositions`（rebuild 滚动保存）
- `_updateActiveWriteFileStreams`（写文件流式刷新）
- `_ensurePhaseIndicator`（阶段指示器）
- `_updateToolCardStatuses`（工具卡状态同步）
- `_updateSubAgentCardsInPlace`（subagent 数据更新）

### 废弃机制

- `_hasStreamingStructureChanged`（被 keyed diff 替代）
- `_updateStreamingContentInPlace`（被 `_reconcileParts` 吸收）
- `_ruleThinkingInPlace`（被 keyed reconcile 覆盖）
- `_ruleStreamingTextOnly`（被 keyed reconcile 覆盖）
- `_ruleToolCardsInPlace`（被 keyed reconcile 覆盖）
- `_ruleWriteFileArgsStreaming`（被 keyed reconcile 覆盖）
- `_ruleToolArgsStreaming`（被 keyed reconcile 覆盖）
- `_ruleAppendNewParts`（被 keyed reconcile 覆盖）

---

## 7. 回滚方案

每个 Phase 独立可回滚：

| Phase | 回滚方法 | 风险 |
|-------|---------|------|
| Phase 1 | `git checkout -- markdown.ts` | 零（只加属性） |
| Phase 2 | 从 fast rules 链移除 `_ruleKeyedReconcile` 注册 | 低（旧规则仍在） |
| Phase 3 | `git checkout -- messages.ts` | 中（需重新验证） |
| Phase 4 | `git checkout -- messages.ts` | 低（只删死代码） |

**推荐策略**：Phase 1 + Phase 2 一起部署，观察 1-2 天无异常后再做 Phase 3 + Phase 4。

---

## 8. 关键设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| key 用 index 还是 content hash | index | append-only 流式序列，index 天然稳定；hash 有碰撞风险 |
| 结构 diff 和内容更新是否分离 | 不分离 | `_reconcileParts` 统一处理，减少规则链复杂度 |
| `thinking-state-change` 是否保留 | 保留 | thinking indicator 增删是结构性变化，keyed diff 不处理 |
| `_updateActiveWriteFileStreams` 是否保留 | 保留 | 写文件流式刷新是独立优化，与 keyed diff 正交 |
| `_preserveStableSubagentNodes` 是否保留 | 保留 | card-level rebuild 仍需要（`_updateToolCardStatuses`） |
| 是否引入外部库 | 否 | 手动 keyed diff 足够，零依赖 |
