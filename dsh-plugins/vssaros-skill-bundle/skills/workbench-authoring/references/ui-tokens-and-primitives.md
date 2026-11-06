# UI 共享层：wb-* 原语与令牌

宿主把共享样式全局注入（来源：`dsh-plugins/vssaros-workbenches/lib/client.ui.js`），工作台**直接用类名**，不要再复制一份 CSS。

## 硬规则

1. 颜色**只走** `--dsw-alias-*`，且写成 `var(--dsw-alias-x, <兜底>)`；裸 `#hex` / `rgba()` / `hsl()` 一律不许（守卫 S7）。
2. 间距 / 圆角 / 字号**只走** `--wb-*` 刻度。
3. 机器锚点用 `data-*`；类名属视觉层，UI 统一时会被换掉（探针会「看不见」）。
4. 零 iframe（注册式工作台）；确需内嵌站点时，那种形态整体叫"内嵌成熟应用"，不要混着用。
5. 图标用内联 SVG 或 emoji；`codicon:*` 必须经 `wbIconEmoji()` 映射（dsh 前端没有 codicon 字体，直接渲染就是 🧩）。
6. **token 名字必须是主题里真实定义过的**。写错名字**不会报错**，只会静默落入 `var(..., 兜底)` ⇒ 表面/边/文字色固定在兜底值上，深色主题下整块 UI 与窗口不一致（2026-10-26 真机：外开按钮用了不存在的 `--dsw-alias-border-default`，背景误用 `bg-overlay` 的灰蓝色）。守卫：`dsh-plugins/check-dsw-tokens.mjs`。

### 怎么确认一个 token 真的存在

**判定等价关系（已实测）**：`dsh-client-ui-theme/lib/client.js` 里有 `--dsw-alias-xxx:` 定义 ⇔ 运行时 `getComputedStyle(document.body).getPropertyValue('--dsw-alias-xxx')` 非空。

⚠ 两个容易搞错的点：

- **变量装在 `body` 上，不在 `html` 上**。读 `document.documentElement` 会拿到空串，误判成"不存在"。
- **不要用"前端 CSS 里有没有"判断**：token 是运行时注入的，CSS 文件里只有 `var(...)` 用法，查不到定义。

常见笔误对照（真实存在的写法在右）：

| 错 | 对 |
|---|---|
| `--dsw-alias-border-default` | `--dsw-alias-border-l1` / `border-l2` |
| `--dsw-alias-state-warning-primary` | `--dsw-alias-state-warn-primary` |
| `--dsw-alias-state-danger-primary` | `--dsw-alias-state-error-primary` |
| `--dsw-alias-bg-l2` | `--dsw-alias-bg-layer-2` |
| `--dsw-alias-border-subtle` | `--dsw-alias-border-l1` |

**选表面色的规则**：浮在内容上的小控件（按钮、胶囊、标签）用 `bg-layer-1`（"Primary raised surface"）—— 浅色下等于面板底色（靠 1px 边框 + 阴影区分），深色下比 `bg-base` 略亮。别用 `bg-overlay`（浅色下是 `#e9ecf2` 灰蓝，和白色窗口明显不一致）。

## `--wb-*` 刻度（共享层真实定义）

| 用途 | 令牌 |
|---|---|
| 字号 | `--wb-f-2xs` `--wb-f-xs` `--wb-f-sm` `--wb-f-md` `--wb-f-lg` |
| 行高 | `--wb-lh` |
| 圆角 | `--wb-r-sm` `--wb-r-md` `--wb-r-pill` |
| 间距 | `--wb-s1` `--wb-s2` `--wb-s3` `--wb-s4` |
| 字体 | `--wb-mono` `--wb-font-mono` |
| 其它（个别包定义） | `--wb-shadow-card` `--wb-shadow-dialog` `--wb-scrim` `--wb-brand` `--wb-comp-bg` |

## `wb-*` 原语（共享层里定义为样式的那些）

```
骨架   wb-split  wb-pane  wb-pane-left  wb-pane-right  wb-pane-hd  wb-pane-title
       wb-pane-id  wb-scroll  wb-foot  wb-foot-body  wb-spacer
工具条 wb-toolbar  wb-acts  wb-ghost  wb-chip  wb-chips  wb-badge  wb-num  wb-stat
按钮   wb-btn (可加 is-primary / is-ghost)  wb-input  wb-select
列表   wb-list  wb-row  wb-row-l1  wb-row-l2  wb-row-name  wb-row-desc
表格   wb-table
卡片   wb-card  wb-cards  wb-card-ico  wb-card-label  wb-card-num  wb-card-sub
页签   wb-tabs  wb-tab  wb-caret  wb-chev
其它   wb-title  wb-sub  wb-meta  wb-group-hd  wb-links  wb-drawer  wb-empty
       wb-field-row  wb-code  wb-pre  wb-ul  wb-canvas  wb-canvas-wrap  wb-diag
```

`wb-*` 之外，很多包有自己的前缀类（`ag3-*`、`xb-*`、`vssWb*`），那些属包内视觉，**不要**跨包复用。

## 布局骨架

### A. 业务 + 右侧 AI 助手（最常用）

```js
h('div', { 'data-vssaros-surface': 'workbench', className: 'wb-split' },
  h('section', { className: 'wb-pane wb-pane-left' },
    h('div', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' }, /* 标题 + 动作 */),
    h('div', { className: 'wb-scroll', 'data-tasks-list': '' }, /* 列表 */),
  ),
  // 右侧助手容器（见 embedding-ai-assistant.md）
  h('aside', { 'data-tasks-conv': '', className: 'wb-pane wb-pane-right' }, conversation),
);
```

### B. 卡片总览（首页 / 看板）

```js
h('div', { 'data-vssaros-surface': 'workbench', className: 'wb-scroll' },
  h('div', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' }, h('b', null, '看板')),
  h('div', { className: 'wb-cards', 'data-board-cards': '' },
    items.map(it => h('article', { className: 'wb-card', 'data-board-card': it.id },
      h('div', { className: 'wb-card-label' }, it.title),
      h('div', { className: 'wb-card-num' }, String(it.count)),
    ))),
);
```

### C. 表格 + 抽屉详情

```js
h('div', { 'data-vssaros-surface': 'workbench' },
  h('div', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' }, /* … */),
  h('table', { className: 'wb-table', 'data-rows': String(rows.length) }, /* … */),
  open ? h('div', { className: 'wb-drawer', 'data-drawer': '' }, detail) : null,
);
```

## 探针锚点建议

- 根：`data-vssaros-surface="workbench"`
- 工具栏：`data-dsh-workbench-toolbar`（**恰好 1 个**，宿主据此吸顶）
- 业务块：`data-<module>-<part>`，值给「数量或状态」，让探针能一条断言查完
- 行/卡片：`data-<module>-row` / `data-<module>-card`，并把 id 放进值里

## 容器查询（S9）

工作台会被塞进 320–420px 的侧栏，所以响应式必须按**容器**：

```css
.wb-pane { container-type: inline-size; }
@container (max-width: 380px) {
  .wb-card-num { font-size: var(--wb-f-sm); }
}
```

用 `@media` 判宽度会失效（侧栏与编辑区同窗不同宽）。
