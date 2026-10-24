# 第三方工作台调研（2026-10-23）

**范围**：仓库 `dsh-plugins/` 下所有声明 `vssaros.workbench` 的插件，共 **14 个**。其中 **8 个是我们自有的**（workflow / kanban / memory / codebase / kb / agents / scheduler / dashboard，已全部迁成注册式 React 工作台 + 共享 UI 层），**6 个是第三方/未迁**（生图、商城、媒体库、并行 TUI、历史会话、工具）。

本文只写这 **6 个**：它们各自的布局与功能特色、与工作台规范的差距、以及值得借鉴的点。

---

## 0. 一页速览

| 工作台 | 包 / 版本 | 承载形态 | 布局 | 一句话特色 |
|---|---|---|---|---|
| 生图 | `vssaros-imagegen` 0.11.5 | SSR 页 + **打包 React app** + 画布节点图 | 单页工作台（提示词 → 结果网格 → 版本） | **生成 → 版本 → 入库**闭环，画布可当输入 |
| 商城工作台 | `vssaros-marketplace` 0.2.10 | 壳 + **vendor React**（自带 react/react-dom） | 设置式列表（分类 + 卡片 + 详情弹窗） | 把**装插件**做成一等公民（安装/升级/审核/发布） |
| 媒体库 | `vssaros-media` 0.5.8 | SSR（iframe） | 统计卡 → 类型筛选 → 动作条 → 资产列表 | **资产浏览器**：分类 + 收藏 + 回收站 + 占用统计 |
| 并行 TUI | `vssaros-parallel` 0.8.1 | SSR（iframe） | **PTY 网格**（N 格 × 可调列数） | 每格一个**独立 dsh 进程**的真终端 |
| 历史会话 | `vssaros-sessions` 0.5.8 | SSR（iframe） | 列表 / **磁贴**双视图 + 分组 | 会话考古：置顶、隐藏、live 指示、子智能体 |
| 工具 | `vssaros-skills` 0.7.11 | SSR（iframe） | 列表 + 统计 + **抽屉详情** | 技能可发现面 + **「为什么被跳过」** |

**共性**：6 个**全部没有**调 `desktopWorkbenches.register(...)` ⇒ 在 dsh 里仍是 SSR 页 / iframe 承载，不共享我们的 `wb-*` 视觉层与主题令牌（对照：自有 8 个已统一）。清单字段方面只用到了 `title` / `description` / `repository` / `icon` / `customFrame`，**没有一个用 `layout` / `panes` / `headerLayout`**（除 scheduler 的 compact）。

---

## 1. 生图（imagegen）0.11.5

**清单**：`title=生图`、`icon=codicon:paintcan`、`customFrame=true`、`repository=vssaros:imagegen`、有客户端半（`lib/client.js` 324 行，但**不注册工作台**）。

**形态**：页面在 `/x/imagegen/`，由**打包好的 React 应用**渲染；`lib/` 里 15 个文件都围绕"画布 + 生成"：

```
canvasGraph.js / canvasGraphTools.js / canvasImages.js / canvasRoutes.js / canvasRun.js
canvasState.js / canvasTools.js / imageBytes.js / imageEdit.js
studioApi.js / gallery.js / workspaceSave.js / capabilities.js
```

**布局**：单页工作台，三段式

1. **输入**：画面描述（可改）+ 参数（模型 / 尺寸 / 张数）；
2. **结果区**：生成中占位 → 结果网格（`打开大图` / `共 N 张` / `第 N 版`）；
3. **操作**：`重新生成` / `存入工作区` / 版本切换。

**特色（值得借鉴）**

- **生成 → 版本 → 入库**是一条闭环：`/api/generate`、`/api/versions`、`/api/workspace-image`、`/api/save` 各自独立，版本可回看；
- **画布（节点图）可以当输入**：`/canvas-import` + `/canvas-run` 把场景当工作流跑；`canvasState` 有体积上限保护（"画布状态太大（场景里有图）"）；
- **能力探测** `/api/capabilities`：生成前先问"能不能生"，而不是失败后报错；
- 请求体上限与非法 JSON 都有明确文案（`3.4MB`、`请求体不是合法 JSON`）。

**差距**：不注册 ⇒ 与 dsh 主题/共享层无关；页面自带一套 CSS；无 `data-*` 契约（自动化测试难挂）。

---

## 2. 商城工作台（marketplace）0.2.10

**清单**：`title=商城工作台`、`icon=codicon:extensions`、`customFrame` 缺省、**无客户端半**、`repository=vssaros:marketplace`。

**形态**：**壳 + vendor React** —— 页面 `/x/marketplace/page` 只出壳，脚本来自 `/vendor/react.js`、`/vendor/react-dom.js`、`/client`；数据入口 `/api/meta`。

**布局**：设置式（settings-like）单列

- 顶栏：刷新 / 登录态提示；
- 分类与筛选：全部 / 已安装 / **可升级** / 审核队列；
- 卡片列表：名称、版本、作者、来源（本地资源 / 远端）；
- 详情弹窗：版本、装了什么、能不能装、票据状态。

**特色（值得借鉴）**

- 把**"装插件"做成一等公民**：安装器分层（`installers.js`：tar / zip / URL / `githubSource.js`），`installedLedger.js` 记台账（"本机真实存在的资源"）；
- **票据/登录态**是显式状态：`本地票据过期、IDE 票据有效`、`没有登录态` —— 不把"装不了"混成"网络错误"；
- **发布链**：`publisher.js` + 审核队列 + "类型与标识不可改；版本请用「发布」"；
- 明确的**自我诊断**：`装好了但技能列表里没有`、`声明有、实际不认` —— 把"装了但没生效"单独列出来。

**差距**：无客户端半 ⇒ 安装/发布这些**写动作**全在 SSR 页里；与 dsh 的依赖注入（`desktopWorkbenches`）无关；vendor 自带 React 与宿主版本可能不一致。

---

## 3. 媒体库（media）0.5.8

**清单**：`title=媒体库`、`icon=codicon:file-media`、`customFrame=true`、**无客户端半**。

**布局**：单列 + 横向分区（SSR）

1. **统计卡**：`N 个资产` / `占用 M` / `回收站 K` / `库文件`；
2. **类型筛选**（`dsh-kinds` → `dsh-kind`）：按 kind 过滤；
3. **动作条**（`dsh-actbar`）：主按钮 + 次按钮；
4. **资产列表**：`dsh-asset`（类型标记 + 收藏 + meta 行）+ 空态 + 诊断；
5. 滚动区（`dsh-scroll`）。

**特色（值得借鉴）**

- **锚点体系最完整的一个**：`data-vssaros-media-root / -count / -assets / -deleted / -bytes / -kind / -dir / -via / -tools / -open` —— 每个数字与每行都可被自动化断言；
- **"收藏 + 回收站"** 这类生命周期动作直接进列表（`dsh-fav`）；
- 统计与列表**同源**（`-count` 与 `-assets` 并列输出，页面不会自相矛盾）。

**差距**：`dsh-*` 前缀与我们 `wb-*` 不同；`dsh-btn` 系列与共享层按钮不通用。

---

## 4. 并行 TUI（parallel）0.8.1

**清单**：`title=并行 TUI 工作台`、`icon=codicon:split-horizontal`、**无客户端半**。

**布局**：**PTY 网格**（不是列表）

- 顶部条：`自动` / `关闭全部` / 列数（`data-cols`）；
- 主体：N 个终端格（`data-pty` / `data-tui`），每格是**一个独立的 dsh 进程**；
- 格太窄时点格头**单格放大**（`banner` / `foot`）；
- 说明文案："每格是一个独立的 dsh 进程"。

**特色（值得借鉴）**

- 三个动作 **`stream` / `input` / `resize`** 就把"多终端"讲清了 —— 分别是"取输出流 / 送键 / 改尺寸"；
- **网格密度自适应**：列数可调 + 单格放大，解决"格太窄看不清"；
- 这是唯一**多进程**的工作台（其余都是"一个页面看数据"）。

**差距**：形态特殊（终端），**不适合套 `wb-*` 卡片原语**；需要 xterm 一类渲染，搬进 React 工作台等于重写终端层 —— 建议**长期保留 SSR/iframe**。

---

## 5. 历史会话（sessions）0.5.8

**清单**：`title=历史会话`、`icon=codicon:comment-discussion`、`customFrame=true`、**无客户端半**；`lib/index.js` **2153 行**（本组最大）。

**布局**：**双视图 + 分组**

- 视图切换：**列表** / **磁贴（多会话窗口）**（"视图：磁贴 ▾"）；
- 分组：按工作区 / 仅当前工作区；组头（`sv-group-header`：名称 + 路径 + roots + 汇总 + 等待中 + live）；
- 会话行：标题行（`sv-title-line`：标题 + 人格 + preset + 时间）、子行、操作（`sv-acts`：置顶 / 展开 / 更多）；
- 详情（`sv-detail` → `sv-detail-row`：cwd / 状态 / 创建 / 最后提问 / 人格 / 子智能体 / 会话 id）；
- 工具栏：搜索（`data-search`）、清空历史（**二次确认**、"只改列表显示，不会删除"）。

**特色（值得借鉴）**

- **两套视图**（列表 / 磁贴）覆盖"扫一眼"与"并排看"两种任务；
- **置顶 / 隐藏**与"删除"严格区分：清空历史 = `data-hidden`，不删盘（文案明说）；
- **live 指示**（`sv-live-dot`）+ 等待中计数，一眼看出哪条在跑；
- 锚点齐全：`data-session-id / -title / -preset / -cwd / -pin / -exp / -hidden / -group-key / -roots`。

**差距**：SSR + 大量手写 DOM 事件（`data-api` / `data-live-api` / `data-prefs-api` 三条接口写在属性里）；与 dsh 的会话侧栏信息重叠（同一份数据两个渲染器）。

---

## 6. 工具（skills）0.7.11

**清单**：`title=工具`、`icon=codicon:extensions`、`customFrame=true`、**无客户端半**；`lib/index.js` 1326 行。

**布局**：列表 + 抽屉

- 顶部：标题 + 统计（`sk-stats`）+ 搜索 + `技能商城` / 设置入口；
- 列表：`sk-row`（名称 + 版本 + 描述 + 激活方式 tag + 齿轮）；
- **抽屉详情**（`sk-drawer` / `data-skill-detail`）：正文（`sk-pre`）、"详情"、"跳过的条目"（`sk-errors`）；
- 激活方式三种 tag：**auto / always / man**（自动 / 总是 / 手动调用）。

**特色（值得借鉴）**

- **把"为什么没生效"做成可见信息**：`跳过的条目`、`技能目录还不存在：…`、`被跳过` —— 这类诊断其它工作台都没有；
- **激活方式是列上的 tag**，不是详情里的设置 ⇒ 扫列表就能看出哪些会自动触发；
- 锚点：`data-skill-row / -skill-id / -skill-detail / -sk-tab / -sk-pane / -sk-search / -sk-count / -sk-kind`，另有 `data-loaded` 标记装载完成（解决"列表空 vs 还没加载"的歧义）。

**差距**：`sk-*` 前缀；抽屉与共享层 `wb-drawer` 功能重叠但不通用。

---

## 7. 横向对比

| 维度 | 生图 | 商城 | 媒体库 | 并行 TUI | 历史会话 | 工具 |
|---|---|---|---|---|---|---|
| 承载 | 静态 app + 画布 | 壳 + vendor React | SSR | SSR | SSR | SSR |
| 注册 `desktopWorkbenches` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 布局骨架 | 输入→结果→版本 | 分类列表 + 弹窗 | 统计→筛选→列表 | **PTY 网格** | 列表/**磁贴** + 分组 | 列表 + 抽屉 |
| 主要动作 | 生成/重生成/入库 | 装/升/发/审 | 分类/收藏/回收站 | stream/input/resize | 置顶/隐藏/视图切换 | 激活方式/商城 |
| 诊断信息 | 能力探测 | 票据/生效状态 | 空态 + diag | 进程状态 | live/等待中 | **跳过原因** |
| `data-*` 锚点 | 少 | 少 | **很全** | 中 | **很全** | **很全** |
| 与共享层 `wb-*` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

---

## 8. 结论与建议

**共同缺口（6/6）**：① 没有注册成 React 工作台 ⇒ 不受共享 UI 层约束，**明暗主题不跟随**（与自有 8 个形成两套视觉）；② 各写一套类前缀（`dsh-*` / `sv-*` / `sk-*` / `vs-*` / 无前缀）；③ 清单里的 `layout` / `panes` / `headerLayout` 一律没用上。

**值得往共享层搬的（按性价比排序）**

1. **媒体库**：结构最规整（统计卡 → 筛选 → 列表 → 空态），锚点最全 ⇒ 迁移成本最低、收益直接（原语全部对得上）。
2. **历史会话**：双视图里**列表**部分与 `wb-list` 完全同构 ⇒ 先把列表视图搬进 React 工作台，磁贴视图留在旧页。
3. **工具**：列表 + 抽屉能直接用 `wb-list` + `wb-drawer`；**"跳过原因"这块诊断要原样保留**（它是最有价值的信息）。
4. **商城**：本质是"列表 + 弹窗 + 安装进度"，可搬；但写动作多（安装/升级/发布），建议**先只搬浏览与已安装**。
5. **生图**：画布 + 版本链是重头，搬等于重做编辑器 ⇒ 建议**只把"结果网格 + 版本"搬进来**，画布留旧页。
6. **并行 TUI**：终端网格**不建议搬**（要重写终端层）；保持 SSR/iframe 是合理边界，只需在规范里注明"终端类工作台豁免共享 UI 层"。

**如果只做一件事**：搬**媒体库**——它是这 6 个里唯一"结构 100% 落在现有 `wb-*` 原语内、且锚点已经齐全"的，可以作为第三方工作台迁移的第二个标杆（第一个是 workflow）。

---

**附：清单字段对照（6 个第三方均未使用我们新增的字段）**

| 字段 | 用途 | 第三方使用情况 |
|---|---|---|
| `layout` | 分栏比例（0.25–0.7） | memory 用了；第三方 0 |
| `panes` | 侧栏/主区块清单 | 0 |
| `headerLayout` | `compact` 紧凑头（唯一 toolbar 锚点） | 仅 scheduler |
| `customFrame` | 页面自带外框 | 4/6 显式 true（imagegen / media / sessions / skills），marketplace 与 parallel 缺省 |
