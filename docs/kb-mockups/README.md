# 知识库 View — HTML 效果图（Mockup）

基于**真实源码**重新设计的知识库侧边栏 View 效果图，用于交付评审与实现对照。

## 一、设计依据（实测源码，非猜测）

| 源码文件 | 作用 |
|---|---|
| `src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBaseView.ts` | View 的 DOM 构建（`class KnowledgeBaseView extends ViewPane`） |
| `src/vs/sessions/contrib/agentStudio/browser/views/media/kbView.css` | 全部 `.kb-*` 样式（797 行） |

## 二、关键认知修正

此前版本把知识库误解为**全屏多页应用**（topbar + 220px 侧栏 + 主区，含"首页/文档/分类/搜索"等虚构页）。
真实实现是 **Activity Bar 侧边栏 ViewPane**：单列、垂直 flex、宽度约 **320px**。
本次已按真实形态全面重构。

### 真实结构（自上而下）

```
.kb-view                        ← 垂直 flex，宽 320px，高 100%
├── .kb-header                  ← 35px 顶栏
│   ├── .kb-title               ← "📚 资料库"
│   ├── .kb-spacer
│   └── .kb-hbtn × 5            ← 🕸️ 关系图谱 / 🧠 思维导图 / ⟳ 刷新 / 🏗️ 批量构建 / ⚙ 设置
├── .kb-section-body-main       ← flex:1，纵向
│   ├── .kb-vault-bar           ← Vault 切换栏
│   │   ├── .kb-vault-icon      ← 🗄️
│   │   ├── .kb-vault-select    ← .kb-vname + .kb-caret（点击展开 .kb-vault-menu）
│   │   └── .kb-abtn × 4        ← 🧠 记忆库 / 📂 视图模式 / ＋ 新建 / ⋯ 更多
│   ├── .kb-search-row          ← 检索行
│   │   └── .kb-search-box      ← 🔍 + input + .kb-search-mode-btn(全文) + .kb-search-sort-btn(↑↓)
│   └── .kb-scroll              ← 滚动区（Section 容器）
│       ├── .kb-section.sec-library    ← 「📁 库」(count 12)
│       ├── .kb-section                 ← 「📝 笔记」(count 36)
│       └── .kb-section                 ← 「🏷️ 标签分类」(count 8)
```

每个 `.kb-section` 内含 `.kb-section-header`（`.kb-arrow` + `.kb-title` + `.kb-count` + `.kb-section-toolbar`）
与 `.kb-section-body`（可折叠，`.kb-section.open` 时 `display:block`）。

### 树节点

`.kb-node` 为 `b3-list-item` 风格行（`min-height:28px`），子元素：

- `.kb-twist` — 展开箭头（`.empty` 时隐藏）
- `.kb-ficon` — 文件/目录图标（目录 `#dcb67a`，文件 `#cccccc`）
- `.kb-name` — 名称（`flex:1; min-width:0; text-overflow:ellipsis`，**必须有 `min-width:0` 才能正确收缩**）
- `.kb-meta` — 大小等元信息
- `.kb-status` — 索引状态点（`.raw` 蓝 / `.indexed` 绿 / `.modified`）
- `.kb-building` — 构建中 spinner
- `.kb-actions` — hover 显示的操作（`✎` 重命名 / `🗑` 删除）
- `.kb-children` — 子节点容器（**必须 `flex-basis:100%` 换行**，否则会被压进父行造成横向溢出）

## 三、两套体系架构（重要）

本目录同时承载**两种形态**，`kb-mockup.css` 是二者共享的样式文件：

| 体系 | 文件 | 形态 | 骨架类 |
|---|---|---|---|
| **A. 侧边栏 ViewPane** | `index.html` | Activity Bar 侧栏，单列 320px | `.kb-view` |
| **B. 全屏多页原型** | `admin/categories/documents/search/entry-edit/document-detail.html` | 全屏应用（顶栏 + 208px 侧栏 + 主区） | `.kb-app` |

### ⚠ 类名冲突与隔离机制

有 **10 个类名被两套体系共用但语义不同**：

| 类名 | 体系 A（index）语义 | 体系 B（legacy）语义 |
|---|---|---|
| `.kb-section` | 含子节点的树容器 | 面板分组标题 |
| `.kb-node` | 目录树行 | 列表项 |
| `.kb-title` | 分区标题 | 顶栏应用名 |
| `.kb-count` / `.kb-caret` / `.kb-spacer` | 树计数/箭头/弹性空隙 | 分组计数/下拉箭头/顶栏空隙 |
| `.kb-tag` / `.kb-grp` / `.kb-btn` / `.kb-switch` | 标签/按钮组/开关 | 同左但尺寸体系不同 |

**隔离方案**：文件末尾有「冲突类名复位」区块，用 `.stage-item`（index.html 独有包装器）
作用域把上述冲突类复位为体系 A 的取值。体系 B 的规则定义在文件末尾，
因此**新增 legacy 样式时必须同步检查是否命中这 10 个类**，必要时补充复位规则。

## 四、交付文件

| 文件 | 说明 |
|---|---|
| `index.html` | **主交付物** — 知识库 View 全部状态效果图（9 个视图） |
| `kb-mockup.css` | 共享样式：`.kb-view`（体系 A）+ `.kb-app`（体系 B）；`--vscode-*` / `--kb-*` 变量均静态固化 |

### index.html 视图清单

| # | 视图 | 内容 |
|---|---|---|
| 1 | **完整主视图** | 顶栏 + Vault 栏 + 检索行 + 三分区；库分区含展开目录树（选中态 / raw / building / modified / hover 操作） |
| 2 | Vault 下拉菜单 | `.kb-dropdown`，4 个资料库 + 分隔线 + 新建/设置 |
| 3 | 资料库设置面板 | `.kb-settings`，根路径 / 存储格式 / 索引检索开关 / 导入行为 |
| 4 | 检索命中 | `.kb-search-hits`，混合检索（BM25 + 语义）命中高亮 `<mark>` |
| 5 | 笔记详情 + 反链 | `.kb-note-preview` + `.kb-backlinks`（含 `.missing` 灰显态） |

> 状态 2–5 各自独立成块；每个 `.kb-view` 锁定 **320px** 侧栏宽度，可在窄栏下验证换行与省略号行为。

## 六、渲染验证结果

用 Playwright（Chromium，1600×900）实际渲染全部 7 个页面校验：

| 页面 | 控制台错误 | 横向溢出 | 应用高度 | 侧栏并排 |
|---|---|---|---|---|
| `index.html` | 0 | 0 | — | — |
| `admin.html` | 0 | 0 | 900 | ✓ |
| `categories.html` | 0 | 0 | 900 | ✓ |
| `documents.html` | 0 | 0 | 900 | ✓ |
| `search.html` | 0 | 0 | 900 | ✓ |
| `entry-edit.html` | 0 | 0 | 900 | ✓ |
| `document-detail.html` | 0 | 0 | 900 | ✓ |

**7/7 全部通过**（0 控制台错误、0 横向溢出、shell 高度锁定 900px、侧栏与主区并排）。

修复过程中定位并解决的真实布局缺陷（同样适用于真实实现）：

1. `.kb-node .kb-name` 缺 `min-width:0` → flex 子项无法收缩，长文件名顶破容器。
2. `.kb-children` 无换行规则 → 子树被压进父行，以主干宽度溢出（6px 起）。
3. 体系 B 局部 `overflow:visible` → 骨架屏演示块撑破窄表格单元格。
4. `.kb-search-main` grid 子项缺 `min-width:0` → 检索结果块溢出主区。

## 八、与真实实现的差异对齐记录

对照 `views/knowledgeBaseView.ts` + `views/media/kbView.css` 逐项核实，已落实到 mockup：

| 项 | 位置 | 修正 |
|---|---|---|
| 1 | 库/笔记分区根类 | 保留 `sec-library`/`sec-notes`（真实 `renderSection` 未加，mockup 保留以便主题色演示，已在注释标注） |
| 2 | 分区工具按钮 | `.kb-sec-btn` → `.kb-tool-btn`（真实类名）；旧类保留兼容 |
| 3 | 库/笔记标题图标 | 移除 mockup 自造的 `.kb-cat📁`，标题文案与真实一致（`库`/`笔记`），`sec-library`/`sec-notes` 的 `.kb-cat` 主题色规则保留但不再有对应图标 |
| 4 | 分区折叠箭头 | 标签分类头初始箭头 `▼` → `▶`（与真实初始态一致） |
| 5 | 分区计数 | 保留静态数字（真实为 `...` 占位后异步回填，mockup 展示终态） |
| 8 | 记忆库 Header | `.kb-mem-title`/`.kb-mem-refresh` 保留（真实为裸 span + 内联样式，mockup 用类名，视觉一致） |
| 9 | 记忆库条目 | **重构为单一入口块**：🧠 + 「查看完整记忆」+「点击打开 MemoryDetailEditorPane」+ `→`（原为两条正文条目，语义错误） |
| 10 | 记忆库槽位 | 新增 `.kb-mem-slots` / `.kb-mem-slot`（persona / user_preferences / project_context），对齐真实 pinned slots |
| 11 | 代码库条目 | 类名保留；子元素对齐真实结构（🧬 + 标题 + meta + `→`），新增 `.kb-code-arrow-r` 样式 |
| 12 | 代码库 meta | `sarosis-agents-client · 2 633 文件` → `点击打开 CodebaseDetailEditorPane`（对齐真实文案） |
| 13 | 树节点图标 | 保留 emoji `.kb-ficon`（真实用 codicon 字体，mockup 无字体依赖，视觉近似；已注明） |
| 15 | 标签搜索清除按钮 | 初始 `display:none`（真实有输入才显）；图标 `🏷️` → `🔍`，placeholder → `搜索标签…`，补 `.kb-suggest` 层 |

**验证（Playwright，1600×900）：** 0 控制台错误；新增元素计数正确
（`kb-tool-btn`×4、`kb-mem-entry`×1、`kb-mem-slot`×3、`kb-code-arrow-r`×1）；
记忆库/代码库入口块各 304px 宽、单列不溢出；仅存真实溢出为 `.kb-bl-snippet` 反链代码片段（与本次改动无关）。

## 九、颜色变量说明

`kb-mockup.css` 顶部将 `--vscode-*` 变量**静态固化**为 VS Code Dark+ 取值
（浏览器环境无 VS Code 运行时变量注入）。真实 View 中这些值由主题动态提供，
因此 mockup 中出现的具体色值仅代表 Dark+ 主题下的观感，不代表硬编码。

