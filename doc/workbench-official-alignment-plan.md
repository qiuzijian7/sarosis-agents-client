# 工作台对齐官方范式 · 优化方案（提案）

- 状态：**提案**（2026-10-21）。本文是 `doc/workbench-authoring-standard.md`（v1.0，稿 A）的**修订提案**，不是已生效规范；条款级改动见 §6。
- 对标物：dsh-desktop 的**官方工作台规范**（`G:\CustomWorkspaces\AIProjects\dsh-desktop\docs\workbench-standard.zh.md`）与**宿主插件**（`packages/dsh-desktop-workbenches`）。
- 配套规范稿：`doc/workbench-authoring-standard.md`（Pane × 承载容器，稿 A）
- 适用：`dsh-plugins/vssaros-*` 里全部 11 个有页面的工作台（dashboard / kb / memory / codebase / media / kanban / workflow / skills / sessions / scheduler / agents / imagegen）
- 落点纪律：能力全部落在 **dsh 侧**（`dsh-plugins/`）；IDE 侧只做"承载与转发"，不产业务内容。

---

## 0. 一句话

**官方工作台的本质不是"一个页面"，而是"一份被注册的身份 + 一套宿主渲染契约"。**

我们目前只有"页面"这一半：身份散在 3 份表里、布局靠约定、归属靠猜、组件只有一层 CSS、响应式只有 1 个工作台在做。

本方案把这个"另一半"补齐，**不推翻稿 A 的三层模型**（Pane / Surface / Host）—— 稿 A 的方向是对的，缺的是把它从**约定**升级成**声明 + 契约**。

---

## 1. 对标物的事实基线（先纠正三个容易照着想象抄的点）

### 1.1 官方仓库里**没有**工作台实例包

`G:\CustomWorkspaces\AIProjects\dsh-desktop` 全仓 grep `desktopWorkbenches.register` 只命中 3 个文件：宿主插件自身 + 规范文档里的示例代码。**没有任何第三方/官方工作台包在仓内**；市场目录是远端 JSON（`market.dshdesktop.com/index.json`），仓内不镜像。

⇒ **"以官方工作台为模板"实际可抄的模板只有两个**：
1. **规范**（`docs/workbench-standard.zh.md`，与 `packages/dsh-desktop-workbenches/development-guide.zh.md` 同源，由 `scripts/build-workbench-guide.mjs` 同步）；
2. **宿主契约**（`packages/dsh-desktop-workbenches/index.js` + `client.js` 2451 行）。

唯一可抄的"包格式样板"是 `packages/dsh-image-generation`（它是**能力插件**，不注册工作台，但包结构是官方 6 包一致的形状）。

### 1.2 官方工作台 = 三重身份 + 一个注册动作

| 身份 | 载体 | 用途 |
|---|---|---|
| npm 包名 | `package.json.name` | 安装、依赖解析、`cordis.patch.yml` 的 `name:` |
| 插件条目 id | `cordis.patch.yml` 的 `insert.id` | Harness 插件树定位 |
| 工作台身份 | `register({ repository })` 解析出的 `owner/repo` | 市场卡片、侧栏入口、会话归属共用 |

宿主 `identityForSource`（`client.js:421-431`）做**三方交叉核对**：安装记录 / 市场 `distribution.name` / 声明的 `repository` 必须一致且唯一，**否则该 provider 不暴露**。这正是我们上一轮结论"官方工作台装得上打不开"的反面：我们**零核对**。

### 1.3 宿主真实能力清单（我们要对照补齐的部分）

**服务端**（`packages/dsh-desktop-workbenches/index.js`）：

- 只读归属服务：`ctx.reflect.provide('desktopWorkbenchOwnership', { async read() { … } })`（73-80 行）→ 返回 `{ revision, sessionBindings, added }`
- HTTP 前缀统一 `/api/desktop-workbenches/`（14 个端点），`state.json` 原子写 + `0o600` + revision 乐观锁
- `desktopPnpm` 是**可选注入**（219 行）—— 没有它，市场只读不可安装

**客户端**（`client.js`）：

| 能力 | 位置 |
|---|---|
| `desktopWorkbenches.register(descriptor, Component) → dispose()` | 852-883 行（**含校验规则**，见 §1.4） |
| `desktopWorkbenches` 其余 API | `open/home/leave/remove/toggle/add/openNative/currentSession/newSession/newWorkspaceSession/ensureSession/saveNote/…` |
| `desktop.workbench.frame` slot | 2414 行，组件签名 `Frame({ service, conversation })` |
| 宿主**直接渲染**业务组件（不需要业务方 `createRoot`） | 2388 行（标准分栏）/ 2372 行（customFrame） |
| 原生会话 `conversation` 节点（`createPortal` 挂载） | 2371 行 / `ConversationMount` 2200-2208 |
| `PanelBoundary` → `PanelFailure` 错误边界 | 2186-2197 行 |
| 共享 UI 组件库 | 外部包 `@deepseek-ai/dsh-client-ui-primitives`（宿主注入，仓内无源码） |
| 主题变量 | `--dsw-alias-*`；帧变量 `--dsh-frame-top-clearance`(48px) / `--dsh-frame-leading-clearance`(160px) / `--workbench-business-width` |

### 1.4 官方 `register()` 的校验规则（我们要抄成我们的"描述符校验"）

`client.js:852-883`：

- `descriptor.title` **必填**，且 `Component` 必须是函数
- `descriptor.repository` **必须是 GitHub URL**（宿主据此小写化成 `owner/repo`）
- `customFrame` 必须是布尔
- `headerLayout ∈ { 'default', 'compact' }`
- `layout.businessSide ∈ { 'left', 'right' }`
- `layout.businessWidth ∈ [0.25, 0.7]`
- 默认值：`category:'其他'`、`screenshot:''`、`screenshotPosition:'center'`、`layout:{ businessSide:'right', businessWidth:0.36 }`
- 返回值**即注销函数**（官方没有独立 `unregister()`），必须交给 `ctx.effect` 管理
- **同一来源重复注册直接抛错**：`if (this.providers.has(source)) throw new Error('Duplicate workbench provider')`（859 行）—— 幂等是宿主侧的责任，不许业务方自己吞掉

> 官方这几条校验全是**抛异常**（不是 warn），符合它规范里"必须/建议/可选"的分级哲学：**"必须"项不满足 = 加载失败，不是降级**。这是我们要抄的关键语义。

### 1.5 官方规范里最该抄的三条硬纪律

1. **响应式按"业务容器实际宽度"设计**，不能按整窗 —— 官方规范原文点名"整窗媒体查询不能代表侧栏展开、分栏及嵌入后的可用宽度"，并要求"避免单字竖排、按钮裁切和整页横向溢出"。
   ⇒ **这条正是上一轮商城 item 破版（指标竖排成「★/0」、「安装」竖排两字溢出）的同一法则**，应当上升为全项目工作台通用条款。
2. **新包不填 `register({ id })`** —— id 只用于迁移旧数据，不是新协议；身份只认 `repository`。
   ⇒ 我们对应：**工作台 id 只认清单里的 `module`，页面不得自报 id**。
3. **`cordis.patch.yml` 的 patch 整体替换该行 `config`，不合并** —— 需要保留的键必须全写。
   ⇒ 我们同样适用，且这是"改一行配置结果别的键没了"的经典事故源。

---

## 2. 现状诊断（已证实的差距，按层归组）

> 全部为只读勘察结论，证据路径见各条。

### 2.1 身份层

| # | 现状 | 证据 |
|---|---|---|
| A1 | **三份真源**：插件清单 `vssaros.module` / IDE 侧 `DSH_MODULE_PAGES`+`DSH_MODULE_CONTAINERS` / chat-surface 的 `DEFAULT_ITEMS`（14 条）。靠守卫逐项比对 | `src/vs/sessions/contrib/dshHarness/common/dshModuleContainers.ts:142/249-276`；`dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js:66-82` |
| A2 | `order` 必须**三处同值**（两份表 + `agentStudio.contribution.ts` 的 `_registerModuleToolIcon`），改一处就红 | 规范稿 §7.2；守卫 `dshModuleContainers.test.ts` |
| A3 | 10 个插件**没有** `vssaros` 清单 ⇒ 不进活动栏容器体系、不进 `DSH_MODULE_PAGES`（market / pele / browser / unreal / ego / archify / bridge / chat-surface / foundation / kb-refs） | 同上 |
| A4 | 工作台**没有自己的元数据**：无 title/description/category ⇒ 商城/中心页只能拿 `module` 猜 | `vssaros-dashboard/package.json` 的 `vssaros` 段只有 `activityBar/view/legacyCounterpart` |
| A5 | `exports` 缺 `"./cordis.patch.yml"`（官方建议项） | `vssaros-dashboard/package.json:8-11` |

### 2.2 布局层

| # | 现状 | 证据 |
|---|---|---|
| B1 | 11 个页面工作台里**只有 7 个**读 `?surface=` 分版；`workflow / skills / sessions / scheduler / media` 不读 ⇒ 侧栏与编辑区渲染**同一份完整页** | 各插件 `lib/index.js` |
| B2 | 规范要求的 `lib/views/<module>/{catalog,core,shell}.js` 结构**全仓只有一个文件**（`vssaros-imagegen/lib/views/imagegen/shell.js`）；其余平铺在 `lib/` 下，命名各插件自定 | 同上 |
| B3 | **页面锚点口径三处不一致**（探针断言全靠它）：① `data-vssaros-surface` —— kb / agents / imagegen 都写了标准锚点，但 **dashboard 写成了 `data-vssaros-dashboard-surface`**，而 chat-surface 的探测代码找的是标准锚点 ⇒ dashboard 的目录版探测不到；② `data-vssaros-page` 的**值 ≠ module 名** —— memory 写 `memory-section` / `memory-detail`、agents 写 `agents-sideview`；③ `data-vssaros-page` **在同页出现多次** —— codebase 在 body 之外还在 div / p 上重复 ⇒ 页面内 `querySelector` 可能命中非 body 元素 | `vssaros-dashboard/lib/sideview.js:128`（唯一的错写法）vs `vssaros-kb/lib/index.js:3332` / `vssaros-agents/lib/sideview.js:691` / `vssaros-imagegen/lib/studio/index.html:9`（标准写法）；`vssaros-memory/lib/index.js:599`、`vssaros-agents/lib/sideview.js:691`、`vssaros-codebase/lib/index.js:496/807/849`；探测方 `check-chat-surface-chunks.mjs:1565` 与 `client.workbenchNav.js:595` |
| B4 | dsh 窗口右栏**每个工作台只有一个 kind**（`<id>`），规范 §2.2 要求的 `<id>-catalog` + `<id>-core` **双页签降级未实现** | `client.workbenchNav.js:396-400` |
| B5 | dsh 窗口中栏是 **iframe 嵌整页**（`withSurface(route,'editor')`），不是"同页内 catalog/core 状态联动" ⇒ 规范 §5.1 未实现 | `client.workbenchNav.js:389-392` |
| B6 | `/x/sessions/?view=tiles` **带查询串**，与"只登记整条路由"的白名单口径不一致 | `client.workbenchNav.js:71` vs `dshPluginPage.ts:27-53` |
| B7 | 布局宽度**写死**（catalog 320–380px），没有"按工作台声明"的机制 | 规范稿 §4.3 |

### 2.3 组件层

| # | 现状 | 证据 |
|---|---|---|
| C1 | 外壳只有**样式层真源**（`SHELL_CSS` / `renderShell` / `renderChips`），**没有组件层** —— header/toolbar/table/empty 的 HTML 逐插件手写 | `dsh-plugins/vssaros-foundation/lib/pageShell.js` |
| C2 | `pageShell.js` 以**复制 + 守卫比对逐字节相同**的方式分发（9 份副本）；dashboard 有 `foundationRef.js` 却**没有**委托层 | 各插件 `lib/pageShell.js`；`vssaros-dashboard/lib/` 无 `pageShell.js` |
| C3 | 页面脚本**只有 dashboard 有独立 `pageClient.js`**（44KB），其余**内联模板字符串**写在各自 `lib/index.js` 里 | `vssaros-codebase/lib/index.js:876`、`vssaros-kanban/lib/board.js` |
| C4 | **无错误边界**：页面脚本抛错即白屏（官方有 `PanelBoundary`/`PanelFailure`） | 官方 `client.js:2186-2197` |
| C5 | 页面**零 React 组件**（`window.__ModuleLoader__.load` 只用于 dsh 聊天工具卡） | 各插件 `lib/client.js` 头部 |

### 2.4 归属层

| # | 现状 | 证据 |
|---|---|---|
| D1 | **工作台 ↔ 会话：零绑定**。`IWorkbenchEntry` 无 sessionId；插件页 view 的 `sessionId` 传 `undefined` | `agentStudio/browser/workbenchManagerService.ts:78-93`；`dshPluginViewPane.ts:392` / `dshPluginPageEditorPane.ts:166` |
| D2 | **无只读归属服务**（全仓 `desktopWorkbenchOwnership` 0 命中），也无等价物 | 全仓 grep |
| D3 | 工作台 ↔ 工作区只有"运行期推送的可变上下文"（桥 `workspace.context` → `foundation/lib/workspaceContext.js`），**不是只读归属** | `common/dshBridgeProtocol.ts:40` |
| D4 | 清单/排序/pin/隐藏由 IDE 侧 `IWorkbenchManagerService` 管，**dsh 侧页面只能单向写、读不回显** | `common/dshPageBridgeProtocol.ts:545-553` |

### 2.5 渲染层（响应式 / 顶栏 / 断链）

| # | 现状 | 证据 |
|---|---|---|
| E1 | 全仓 `container-type` **仅 4 处**（imagegen 3 + chat-surface market 1）⇒ 规范 §4.3 要求的容器查询几乎没落地 | grep |
| E2 | `workflow / skills / sessions / scheduler / media` 不分版 ⇒ 在 320px 侧栏里直接渲染整页 | 同 B1 |
| E3 | 深度链接口径冲突：规范写 `/x/<module>/?surface=editor&sel=<id>`，但 `validatePluginRoute()` **拒绝查询串** | `dshPluginPage.ts:27-53` |

### 2.6 纪律层

| # | 现状 | 证据 |
|---|---|---|
| F1 | 规范稿 §1 首行写"**草案**"，但按项目记录稿 A 已拍板 ⇒ 状态口径不一致 | `doc/workbench-authoring-standard.md:3` |
| F2 | 规范**没有三级分级**（必须/建议/可选），条款无法判定"是否阻塞" | 同上 |
| F3 | 验收矩阵没有"**插件负责 / 宿主负责**"分工，也没有"失败时如何交付"的条款（官方 §8/§9 有） | 同上 vs 官方 §8/§9 |
| F4 | 每个新契约没有"**声明端 / 执行端 / 调用方三关齐**"的检查（缺一关就静默失效） | 参见项目既有教训 |

---

## 3. 目标模型：六层

> 层级按**依赖顺序**排列：L0 是地基，L1 依赖 L0，L2/L4 依赖 L1，L3 可并行，L5 贯穿全程。
> 每层给出：**抄官方的什么 → 我们的等价物 → 字段表 → 落点 → 守卫 → 工作量**。

### L0 身份收敛（地基，必做）

**抄什么**：官方的"一份身份 + 三方交叉核对 + 单一 id 真源"。

**我们的等价物**：`vssaros` 私有清单升级为 manifestVersion 2，新增 `workbench` 段 —— 它就是我们的"描述符"，一次声明**身份 + 元数据 + 布局 + 归属策略**。

```jsonc
"vssaros": {
  "manifestVersion": 2,
  "module": "kb",                       // 工作台 id 的唯一真源（页面不得自报）
  "activityBar": { "containerId": "…", "title": "知识库", "icon": "codicon:book", "order": 40 },
  "view": { "kind": "page", "route": "/x/kb/" },
  "workbench": {
    "title": "知识库",                    // 必须：人类可读名（官方 register.title 同级）
    "description": "本地资料的检索、关系图谱与批量导入。",  // 建议
    "icon": "codicon:book",             // 建议
    "category": "资料",                  // 建议：市场/中心页分组
    "panes": ["catalog", "core"],       // 必须：声明本工作台有哪几个 Pane（驱动 L1）
    "layout": {                         // 建议：布局偏好（官方 layout 同名同义）
      "catalogSide": "left",            //  'left' | 'right'
      "catalogWidth": 0.28,             //  0.2–0.4（catalog 占主内容区比例）
      "businessWidth": 0.36             //  0.25–0.7（对齐官方上限下限）
    },
    "customFrame": false,               // 必须（布尔）：true = 整页型，自己提供首次入口
    "headerLayout": "compact",          // 必须（'default' | 'compact'）：驱动 L4 顶栏
    "capabilities": ["session-owned"],  // 建议：'session-owned' | 'workspace-scoped' | 'read-only'
    "sessionScope": "owned",            // 建议：'owned' | 'shared' | 'none'
    "dataRoot": "kb"                    // 建议：dshHomePath('<dataRoot>')，不写死 ~/.dsh
  },
  "legacyCounterpart": "…"
}
```

**校验规则**（对齐官方 §1.4，落在解析层，不靠人眼）：

| 字段 | 规则 | 违反时 |
|---|---|---|
| `module` | 唯一、小写 kebab | 启动失败（对齐官方"不满足就不能加载"） |
| `workbench.title` | 非空 ≤ 24 字 | 拒绝登记 |
| `panes` | ⊆ `{catalog, core}`，非空 | 拒绝登记 |
| `layout.catalogWidth` | ∈ [0.2, 0.4] | 拒绝登记 |
| `layout.businessWidth` | ∈ [0.25, 0.7] | 拒绝登记 |
| `headerLayout` | ∈ `{default, compact}` | 拒绝登记 |
| `customFrame` | 布尔 | 拒绝登记 |
| `view.route` | 整条路由，**无查询串** | 拒绝登记（对齐 `validatePluginRoute`） |

**落点**：

1. `src/vs/sessions/contrib/dshHarness/common/vssarosPluginManifest.ts` —— `IVssarosPluginManifest` 扩 `workbench?: IVssarosWorkbench`，加 `validateVssarosWorkbench()`（**唯一校验真源**）
2. 各插件 `package.json` 的 `vssaros` 段（11 个文件）
3. `exports` 补 `"./cordis.patch.yml"`（对齐官方建议项）

**收敛三份真源（L0 的真正难点）**：三份表不能删（IDE 侧要在 Electron 主进程启动时就知道有哪些工作台），但可以改成**同源生成**：

- 真源 = 插件清单 `vssaros.workbench`（安装时由插件自述）
- IDE 侧 `DSH_MODULE_PAGES` / `DSH_MODULE_CONTAINERS` **降级为"离线兜底 + 静态基线"**，运行时由 dsh 侧推送覆盖（对齐官方"安装记录交叉核对"）
- chat-surface 的 `DEFAULT_ITEMS` 由清单派生（它已经在 dsh 侧，能读到插件清单）

> ⚠ 这里必须**分两步**（见 §5），一步到位会踩"声明端有了、调用方没跟上 ⇒ 静默失效"的老坑。

**守卫**：

- `check-vssaros-manifest.mjs`（新）：遍历 `dsh-plugins/*/package.json` 的 `vssaros` 段，按上表逐条校验，违规即非 0 退出
- 扩 `dshModuleContainers.test.ts`：把"逐项一致"守卫升级为"以清单为准 + 静态表仅兜底"的断言

**工作量**：S（解析 + 校验 + 守卫 ≈ 1 天）＋ M（11 个插件清单补字段 ≈ 1 天）

---

### L1 布局声明化

**抄什么**：官方的"**声明式布局参数**（`businessSide` / `businessWidth` / `customFrame`）+ 宿主据此渲染"，而不是业务方自己决定。

**我们的等价物**：把稿 A 的 `?surface=` 从"**约定**"升级为"**声明的投影**"。

```
manifest.workbench.panes  ──►  宿主派生承载位
   catalog ──►  sideview(IDE 右栏) / 右栏 tab `<id>-catalog` / dsh 全窗右栏
   core    ──►  EditorPane(IDE 中栏) / 中栏 main keyed `vssaros-wb-<id>` / 聊天框右栏 `<id>-core`
```

**规则**：

1. `panes` 里没有 `catalog` ⇒ 侧栏**不注册**该工作台（不出现空侧栏）
2. `panes` 里没有 `core` ⇒ 中栏不注册，页面按"只有目录"的形态渲染
3. **缺省（无 `surface`）永远渲染"完整可用"那一版**，且必须包含 catalog + core 两半（对齐稿 A §4.1、探针口径）
4. 未知 `surface` 值 ⇒ 回落完整页（不报错）
5. **聊天框降级必须实现**：右栏注册 `<id>-catalog` + `<id>-core` 两个 kind，core 优先激活，宽度按 320–420 设计（稿 A §2.2，当前未实现）

**落点**：

- `dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js`：`DEFAULT_ITEMS` 改为从清单派生；右栏 `sidebarRightTabs.register` 改成**双 kind**（B4 的修复）
- 宿主侧：`common/dshPluginPage.ts`（`resolveViewUrl` / `withSurface` 保持）；新增"Pane → 承载位"的映射函数
- 各插件 `lib/index.js`：把 `surface` 分发统一到"按 `panes` 声明渲染"的公共函数

**守卫**：

- `check-chat-surface-chunks.mjs`：新增断言 —— 右栏注册**必须**出现 `<id>-catalog` 与 `<id>-core` 两个 kind；`DEFAULT_ITEMS` **不得**再出现硬编码 route 列表
- 新增 `check-workbench-panes.mjs`：对照插件清单的 `panes`，断言每个工作台在 chat-surface 与 IDE 侧各注册了对应的承载位（**三关齐**：声明端 / 执行端 / 调用方）

**工作量**：M（chat-surface 双 kind + 派生 + 守卫 ≈ 2 天）＋ M（11 个插件的 `panes` 落地 ≈ 2 天）

---

### L2 组件层（把"只有 CSS"补成"有组件"）

**抄什么**：官方的**共享组件库**（`@deepseek-ai/dsh-client-ui-primitives`，宿主注入）＋ **宿主错误边界**（`PanelBoundary` / `PanelFailure`）。

**我们的等价物**：`vssaros-foundation` 升级为**组件真源**。

**L2-a 组件函数**（`foundation/lib/pageShell.js` 扩写）：

```js
export function renderHeader({ title, subtitle, breadcrumb })     // 页头：标题 + 面包屑
export function renderToolbar({ actions })                        // 操作区
export function renderEmpty({ text, action })                      // 空态：文案 + 下一步动作
export function renderError({ reason, retry })                     // 错误态：写明失败原因 + 重试
export function renderBusy({ text })                               // 加载态
export function renderList(items)                                 // 目录列表（状态徽标 + 选中态）
export function renderBadge(status)                               // 'ok'|'warn'|'error'|'busy'
```

> 关键：**每个组件都必须自带"下一步动作"**（空态/错误态不许是纯文字）—— 对齐官方 `.dshWbInit` 引导 + 我们自己的 `feedback_blank_page_three_causes` 教训。

**L2-b 错误边界**（对齐 `PanelBoundary`）：统一 `pageClient.js` 的入口

```js
// 页面脚本统一入口，抛错不再白屏
export function boot(fn) {
  try { fn(); }
  catch (err) {
    console.error('[vssaros-page] fatal', err);
    document.body.insertAdjacentHTML('beforeend', renderError({ reason: String(err?.message || err), retry: true }));
  }
}
```

**L2-c 分发方式改造**：现在 `pageShell.js` 是**手工复制 + 守卫比对逐字节相同**（9 份）⇒ 改成**生成脚本**：

- 真源：`vssaros-foundation/lib/pageShell.js`（唯一手写处）
- 生成：`dsh-plugins/build-page-shell.mjs` → 为每个使用方写出 `lib/pageShell.js` 副本
- 守卫：改为"**跑生成器后 git diff 必须为空**"（比"逐字节比对"更强，能发现漏生成/手改副本）

> 理由：插件是独立安装的包，profile 里没有互相解析路径 ⇒ "复制"这条路走不通；但**手工复制**是复制链里最脆的一环。

**L2-d 独立页面脚本**（对齐"一份 client 层"）：把 11 个插件散落在 `lib/index.js` 里的内联脚本，按工作台拆到 `lib/pageClient.<module>.js`，由服务端读文件内联注入（照抄 dashboard 已有的 `readFileSync(new URL('./pageClient.js', import.meta.url))` 写法，`vssaros-dashboard/lib/index.js:78`）。

**落点**：`dsh-plugins/vssaros-foundation/lib/pageShell.js`（扩写）＋ 11 个插件的 `lib/` ＋ 新增 `dsh-plugins/build-page-shell.mjs`

**守卫**：`check-page-shell-parity.mjs`（改为"生成器输出 == 仓库副本"）＋ 每个工作台页面必须有 `boot()` 包裹的断言

**工作量**：L（组件 7 个 ≈ 2 天）＋ M（生成器 + 14 处副本刷新 ≈ 1 天）＋ M（脚本拆分 ≈ 2 天）

---

### L3 归属与模式（最大的一块，值不值得做取决于方向）

**抄什么**：官方的 `desktopWorkbenchOwnership` 只读服务 + `state.json` 归属存储 + 侧栏顶部单一模式切换器（"原生会话 ↔ 各工作台"平行模式）。

**我们的等价物**（命名对齐官方，便于将来互通）：

```js
// 服务端（vssaros-foundation 或新建 vssaros-workbench-ownership）
ctx.effect(() => ctx.reflect.provide('vssarosWorkbenchOwnership', {
  async read() {
    return { revision, sessionBindings: {…}, added: [...] };   // 与官方同形状
  }
}))
```

**为什么值得做**：

- 我们已有 `IWorkbenchManagerService`（pin/order/hidden/lastOpened）与 dsh 侧会话，但**两边对不上**（D1/D4）
- 项目方向是"IDE 聊天框将废弃、投入转 dsh Host" ⇒ **模式切换、侧栏、会话归属正好该在 dsh 侧一次性做对**，而不是在 IDE 侧继续补
- 官方模式一旦成立，商城里的工作台才有"归属"这个概念可展示

**成本与取舍（重要）**：

| 官方做法 | 我们的处境 | 建议 |
|---|---|---|
| `state.json` 原子写 + revision 乐观锁 + 归属不可篡改 | 我们没有归属存储 | **抄**（成本低、收益明确） |
| 只读归属服务（服务端注入） | 我们完全没有 | **抄** |
| 侧栏模式切换器（原生会话 ↔ 工作台） | 我们有活动栏容器 + 侧栏页签 | **P2 抄**，但要等 L1 双 kind 落地 |
| 会话过滤 / 新建会话归属 / 工作区过滤 | 我们会话由 dsh 原生管 | **不抄**：与 dsh 原生会话模型冲突，改为"工作台声明 `sessionScope`，由宿主按声明过滤" |
| 目录选择器（宿主） | 我们有工作区切换 | **P2**：只在需要落盘时补 |

**落点**：新建 `dsh-plugins/vssaros-workbench-ownership/`（服务端），或挂在 `vssaros-foundation` 下；dsh 侧 chat-surface 增加模式切换入口

**守卫**：`check-workbench-ownership.mjs` —— 归属写入必须走同一份存储（禁止插件自建第二套归属），并验证"已有归属不可改/不可删"（对齐官方 `state.mjs:48-54`）

**工作量**：L（服务 + 存储 + 守卫 ≈ 2 天）＋ L（dsh 侧模式切换 ≈ 2 天）＋ M（会话过滤对接 ≈ 2 天）

---

### L4 响应式与顶栏（官方点名过的坑，必须全量落地）

**抄什么**：官方的容器查询纪律 ＋ compact 顶栏协议 ＋ 错误边界。

**L4-a 容器查询全量落地**：

- 断点固定 **320 / 520 / 760**（稿 A §4.3 已定），`container-type: inline-size` 加在**业务根容器**（不是 body）
- **禁止 `@media`**（sideview 与编辑区同窗不同宽，media 判不出来）
- 11 个页面工作台逐个补：catalog 在 ≤520 收单列、隐藏次要列；core 在 ≤520 允许有界滚动
- 验收用"**业务容器宽度**"，不是窗口宽度

**L4-b 顶栏协议**（对齐官方 `data-dsh-workbench-toolbar`）：

| 官方 | 我们 |
|---|---|
| `data-dsh-workbench-toolbar`（文档内**唯一**） | `data-vssaros-workbench-toolbar`（文档内**唯一**） |
| 宿主用 MutationObserver 找唯一命中 | 宿主在装载时校验唯一性；**不唯一 ⇒ 回退 default 并 warn** |
| 宿主内部标记 `data-dsh-compact-toolbar` / `data-dsh-compact-valid` **不得由工作台设置** | 同：`data-vssaros-compact-toolbar` / `-valid` 禁止工作台设置 |
| 工具栏 sticky 占满宿主可用宽度 | 同 |
| 业务根容器不得另加顶部 margin/padding 或独立滚动容器 | 同 |

**L4-c 通用条款（上升为全项目铁律）**：官方原文精神 —— "长中文标题、英文标识、数字和操作按钮均应保持可读可用，**避免单字竖排、按钮裁切和整页横向溢出**"。

> 这条直接来自上一轮商城 item 破版事故（指标竖排成「★/0」、「安装」竖排两字溢出右边界）。应作为**所有工作台页面**的强制验收项，而不只是商城。

**L4-d 不抄的**：官方 `--dsh-frame-top-clearance`(48px) / `--dsh-frame-leading-clearance`(160px) / macOS 拖动层 —— 我们的工作台在 **IDE 侧栏与中栏 EditorPane**（Windows 独立标题栏，无系统控件行），不需要自造拖动区。

**守卫**：

- `check-page-responsive.mjs`：每个页面工作台必须含 `container-type: inline-size` ＋ 三个断点；**不得**出现 `@media`（白名单除外：仅允许打印样式）
- `check-workbench-toolbar.mjs`：顶栏标记唯一性；禁用内部标记

**工作量**：M（11 个页面补容器查询 ≈ 3 天）＋ S（顶栏协议 + 守卫 ≈ 1 天）

---

### L5 纪律与验收（把官方 §8/§9 的做法搬过来）

**L5-a 规范条款三级分级**：把规范稿 v1.0 的每条标成 **必须 / 建议 / 可选**，并给"必须"项配守卫。官方规范的核心价值恰在于"不满足就不能安装或加载"的可判定性。

**L5-b 验收矩阵加"责任方"列**（官方 §8 的做法）：每一格标 **插件负责 / 宿主负责（插件配合核验）/ 仅使用该能力时适用**。

**L5-c 失败交付规则**（官方 §9）：交付时必须列出 —— 修改的文件、包版本、已实测项、**未验证项**（逐条），不得把"装上了"表述为"验收通过"。

**L5-d 三关检查**（我们自己的硬规矩，官方没有，但对 dsh 体系更致命）：任何新契约（描述符字段、Pane、承载位、归属）必须同时具备：

1. **声明端** —— 清单/清单文件里有它
2. **执行端** —— 宿主真的按它行动
3. **调用方** —— 至少一个真实使用点在读它

缺任一关 ⇒ **静默失效**（这是 dsh 插件化最常见的事故形态）。

**工作量**：S（规范改写 ≈ 1 天）

---

## 4. 五项"重件"的取舍（2026-10-21 复核修订）

> 初稿把这五项都列为"不抄"。复核后改判：**四项可抄、一项暂不抄**。
> 改判依据：① dsh-desktop 是 **MIT**（`LICENSE`：Copyright (c) 2026 DataElement；三个相关包 `license` 均为 MIT）⇒ 不只能抄设计，**可以带版权声明 vendor 代码**（与 archify 同一套路）；② 我们 Host 安装链上已经积了一串 pnpm 共享树的坑（见 4.2），正好是代际模型要解决的问题。

| 官方做法 | 结论 | 一句话理由 | 落点阶段 |
|---|---|---|---|
| **宿主单例** | **抄，立刻** | 最便宜：我们 27 个插件 `dependencies` 全空，先上守卫钉住现状 | P0 |
| **pnpm 隔离代际** | **抄（只用于第三方安装）** | 它的设计动机就是 Windows 上 pnpm 共享树卡死，和我们的坑同源 | P2–P3 |
| **React 组件注册** | **抄宿主契约；页面逐个迁** | dsh 窗口里本来就有 React + slot，只是现在注册的是 iframe | P1（宿主）→ 按工作台迁 |
| **策展审核** | **抄流程，不抄仓库** | 上游的"审核通过"是对 dsh Desktop 的，不是对我们宿主的 | P3 |
| **macOS 拖动区** | **暂不抄** | 只出 Windows 包；工作台页面碰不到窗口顶边 | 出 macOS 包时再做（S） |
| **工作台内部档案 ≡ DSH 工作区** 的产品约定 | 不抄 | 我们的知识库/记忆库有自己的资料模型 | 保留工作区上下文推送（D3），补只读归属视图 |

### 4.1 宿主单例（P0，成本 S）

- **现状**：27 个 `vssaros-*` 插件 `dependencies` **全空**，peer 只有 `@deepseek-ai/dsh >=0.1.7-0 <0.3.0-0` ⇒ 目前零违规。Excalidraw 的 React 18 打进 `vssaros-imagegen/lib/canvas/`，跑在**独立插件页文档**里（不进 dsh 客户端 bundle，见 `vendor/excalidraw/README.md`「只能待在专用视图里」）⇒ 不同 JS realm，不算违规。
- **抄什么**：官方 `HOST_SINGLETON_PATTERNS = [/^react$/, /^react-dom$/, /^@deepseek-ai\//]`（`dsh-desktop-market-installer/generations/installer.mjs:32`）。
- **怎么落**：新守卫 `check-host-singleton.mjs` —— ① 任何插件 `dependencies` 命中模式即红；② `dsh.client` 入口与 `client.*.js` chunk 里不许出现自带的 React 副本（只能 `require('react')`），白名单仅 `vssaros-imagegen/lib/canvas/`；③ 第三方安装落地后（4.2）在安装器里做 hoist（照抄官方）。
- **风险面**：今天守的是"将来有人顺手加依赖"；真正的冲突面在第三方安装。

### 4.2 pnpm 隔离代际（P2–P3，成本 L）

- **为什么值得**：Host 安装链上已经积了一串**共享树**的坑，全部登记在 `src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts`：
  - 种子拷进 profile 后 `.modules.yaml` 指错店 ⇒ `ERR_PNPM_UNEXPECTED_STORE`（`_repairSeededStoreMetadata`）
  - Windows 8.3 短名 ⇒ `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` ⇒ 伴生包装不上 ⇒ Host 退出 code 1
  - 同版本 `file:` 依赖被 pnpm 判"没变化"跳过替换 ⇒ **陈旧副本**（`staleAfterInstall`）
  - 全新 profile 上 Host 内 `pluginManager` 剪掉未声明的树（`Packages: -43`）⇒ `operation-error`
  - 运行时**不带 pnpm**（`build/prepack-dsh-runtime.mjs:58-62`：CI 现场 `'pnpm' is not recognized`）
- **官方的解法**（`installer.mjs:9-29` 原注释）：每个插件装成**不可变代际** —— pnpm 在全新暂存目录里跑，一次 `rename` 提升到按 id 保证全新的路径，之后再也不写；原因写明是 "On Windows … pnpm cannot rename over an existing directory — which is what wedges a shared hoisted install into a no-progress spin"。启动时（Harness 停着）由**启动进程**做 sweep + projection，把 profile `node_modules` 链接到 `desired` 指针（`src/main/state/generation-launch.ts`）。
- **我们的对应位置**：启动进程 = `dshHostSupervisor`（electron-main），天然就是"Harness 停着时"做投影的地方。
- **范围**：**只用于第三方/商城安装**。随包插件仍走现有共享树（官方也是：随包 web bundles 走 app-boot，代际只管市场插件）。
- **成本**（官方实测体量）：`generations/` 四件 ≈ 87KB（installer 34K + projection 23K + registry 18K + package-backend 12.5K）+ 主进程 `generation-migration.ts` 41KB + `generation-launch.ts` 5KB + `pnpm-runner.mjs` 650 行；前置条件是**随包 pnpm**（官方把 `pnpm@10.34.5` 写在 installer 的 `dependencies` 里）。
- **前置依赖**：商城安装通道本身先打通（`project_workbench_market` 的未闭合项②）。代际是"装得稳"，不是"装得上"。

### 4.3 React 组件注册（P1 宿主 → 逐个迁，成本 L，可分摊）

- **两种承载要分开看**：
  - **dsh 窗口**（中栏 `main` / 右栏 tab）：dsh 客户端**已经**提供 React + `__ModuleLoader__` + slots；`client.workbenchNav.js` 现在注册进 `main` 的是一个 **iframe**（389-392 / 848-853）。把 iframe 换成直接注册的组件 = 官方 `Frame` 的做法，几乎零基建成本。
  - **IDE sideview / EditorPane**：是 `WebContentsView` 直接加载 Host webServer 的 HTML（`dshPluginViewPane.ts:392` / `dshPluginPageEditorPane.ts:166`），**没有模块加载器、没有宿主 React**。两条路：
    - (i) 每页自带 React bundle（Excalidraw 已是先例，3.4MB 级）——简单，但每个页面一份 React；
    - (ii) 新增 `DshViewSurface = 'workbench'`：加载 dsh web client、只露出工作台 slot（与现有 `'chat'` 用 CSS 裁剪同一手法，`dshHarness.ts:666`）——全面统一，但**每个侧栏/编辑区视图都起一整份 dsh 客户端**（内存与首屏代价需实测）。
- **抄什么**：宿主侧抄 `register(descriptor, Component) → dispose`（含 852-883 行的校验与"同来源重复注册抛错"）、宿主直接渲染（不让业务方 `createRoot`）、`PanelBoundary/PanelFailure` 错误边界、`conversation` 节点由宿主 `createPortal` 提供。
- **拿不到的一块**：官方共享组件库 `@deepseek-ai/dsh-client-ui-primitives`（dsh-desktop 钉 `0.2.1-rc.2`）**不在我们的运行时里** —— 我们 `0.2.1-rc.1` 的 profile 种子里有 52 个 `dsh-client-ui-*` 包，唯独没有 primitives。⇒ 要么升 rc.2（另行验证），要么组件库自己做（L2 的 foundation 组件改成 React 版）。
- **迁移策略**：宿主契约一次做（P1，放 chat-surface）；**新工作台 React 优先**；存量 11 个按"改动最频繁的先迁"逐个迁，SSR 页在迁完前继续服务 IDE 两个承载位。kb `lib/index.js` 已 3300+ 行，**不建议整体重写**。
- **附带收益**：若宿主 API 与 `desktopWorkbenches` **同形状**，官方工作台的客户端半就能注册进来 —— 这是"装得上打不开"走向"真兼容"的唯一路径（还需 `desktopWorkbenchOwnership` 与 `ensureSession/newSession` 等，见 L3）。

### 4.4 策展审核（P3，成本 M + 持续人力）

- **为什么必须有自己的**：我们现在直接消费 `market.dshdesktop.com` —— 上游的自动检查 + 首次人工阅读（`docs/workbench-market-acceptance.zh.md` §6）验的是"在 **dsh Desktop** 上能装能开"，**不是在我们宿主上** ⇒ 正是"装得上打不开"的来源。上游自己也写明人工阅读"不是完整的安全审计"。
- **抄什么**（流程，全部可复用到工蜂）：每条目一个 YAML（`data/workbenches/<owner>__<repo>.yml`）、MR 即进入审核、自动检查（字段/分类/重复/改动范围 → 仓库可访问且有许可证 → **下载真包**核名/版本/入口/bundle patch/≤8MiB → 截图可访问）、首次人工阅读、状态口径三分（已提交 / 已合并待目录更新 / 已上架）、"检查跳过 ≠ 通过"。
- **两档做法**：
  - **B（先做）· 叠加层**：继续读上游目录，但叠一份我们自己的**白名单 + 兼容标记**（"已在 VsSaros 上验证"/"仅 dsh Desktop"）⇒ 直接落成 P3 的商城条目"宿主契约"标记与按钮降级。
  - **A（有内部投稿需求再做）· 自有目录**：工蜂仓库 + MR + CI；目录 JSON 由 `g:\SarosWorkspace\saros-marketplace`（Express + SQLite，已有 Agent/Skill/MCP/KB 的包管理与按 kind 解析）新增 `workbench` kind 来出；CI 复用商城自检（`vssaros-market/test/run-market-check.mjs`）与 L0 的清单校验。
- **代价**：A 需要有人持续审；没有维护者就别开 A。

### 4.5 macOS 拖动区（暂不抄）

- 只出 Windows 包（发版 = EXE；`.ci/` 下无 macOS 打包流程）。
- 工作台页面碰不到窗口顶边：标题栏是我们自己的 `src/vs/sessions/browser/parts/titlebarPart.ts`（已处理 `-webkit-app-region`），dsh 页面都是窗口内的 `WebContentsView`。
- 官方这块本身也只对 macOS 生效（`client.js:1297-1304 / 1393-1394` 全部带 `html[data-platform=darwin]` 前缀；Windows 走独立标题栏）。
- 将来出 macOS 包时：只需在 L4-b 顶栏协议里补 no-drag 排除规则，成本 S。

---

## 5. 分阶段落地

> 顺序遵循：**先声明 → 再执行 → 最后调用方**；每阶段都能独立验收、独立交付。

### P0 · 地基（1 周内可交付，零视觉变更）

| 项 | 内容 | 守卫 |
|---|---|---|
| P0-1 | `vssarosPluginManifest.ts` 扩 manifestVersion 2 + `validateVssarosWorkbench()` | `check-vssaros-manifest.mjs` |
| P0-2 | 11 个插件清单补 `workbench` 段（含 `panes`/`headerLayout`/`layout`） | 同上 |
| P0-3 | `exports` 补 `"./cordis.patch.yml"` | 同上 |
| P0-4 | 修 dashboard 的 `data-vssaros-dashboard-surface` → 标准锚点（**保留旧属性**做兼容，不破坏既有探针） | `check-chat-surface-chunks.mjs` |
| P0-4b | 统一 `data-vssaros-page` 的值 ≡ `module` 名；同页**只允许 body 上出现一次**（内层重复的改用别的属性名） | 同上 |
| P0-5 | 修 `/x/sessions/?view=tiles` 的带查询串问题（B6） | 同上 |
| P0-6 | 宿主单例守卫：插件 `dependencies` 不得命中 `react` / `react-dom` / `@deepseek-ai/*`；客户端 chunk 不得自带 React 副本（白名单仅 imagegen 画布产物）（§4.1） | `check-host-singleton.mjs`（新） |

**P0 验收**：清单解析单测通过；11 个工作台**行为不变**（页面照旧）；探针基线不回退。

### P1 · 布局与组件（P0 之后 2 周）

| 项 | 内容 | 守卫 |
|---|---|---|
| P1-1 | chat-surface 右栏**双 kind**（`<id>-catalog` / `<id>-core`）＋ 聊天框降级（B4） | `check-chat-surface-chunks.mjs` + 逆向突变 |
| P1-2 | `DEFAULT_ITEMS` 由清单派生（A1 收敛第一步） | 同上 |
| P1-3 | 11 个页面按 `panes` 声明分发（L1） | `check-workbench-panes.mjs`（三关齐） |
| P1-4 | foundation 组件层 7 个组件 + `boot()` 错误边界（L2-a/b） | `check-page-shell-parity.mjs` |
| P1-5 | `pageShell.js` 生成器替代手工复制（L2-c） | 同上（"跑生成器后 diff 为空"） |
| P1-6 | 容器查询全量落地 + 禁 `@media`（L4-a） | `check-page-responsive.mjs` |
| P1-7 | compact 顶栏协议（L4-b） | `check-workbench-toolbar.mjs` |

**P1 验收**：稿 A §8 验收矩阵 10 格全绿；新增"单字竖排 / 按钮裁切 / 横向溢出"三项负对照断言。

### P2 · 归属与模式（P1 之后，可并行 1–2 周）

| 项 | 内容 | 守卫 |
|---|---|---|
| P2-1 | `vssarosWorkbenchOwnership` 只读服务 + `state.json` 归属存储（L3） | `check-workbench-ownership.mjs` |
| P2-2 | dsh 侧模式切换（原生会话 ↔ 工作台）＋ 会话过滤 | 探针（p3 系列） |
| P2-3 | 目录选择器入口（需要落盘时） | 同上 |

### P3 · 商城侧（依赖 P0–P1 完成）

- 商城条目加"**宿主契约**"标记：无我们契约的官方工作台 ⇒ 按钮降级为「查看安装说明 / 在 dsh Desktop 中安装」（消掉"装得上打不开"的死胡同）
- 若将来要真兼容官方工作台：**最小宿主契约清单** = ① `desktopWorkbenches` 等价服务（`register/remove/open/…`）② `desktop.workbench.frame` 等价 slot ③ 官方 client bundle 依赖的 8 个 dsh 客户端包可用性评估。
  **成本高**（官方 `client.js` 2451 行 + 依赖 8 个客户端包，且与我们的中栏页签体系打架）⇒ **建议先不做**。

---

## 6. 对规范稿 v1.0 的条款级修改建议

| 条款 | 动作 | 内容 |
|---|---|---|
| §1 三层模型 | **保留** | Pane / Surface / Host 的划分经得起官方对照 |
| §2 承载矩阵 | **改** | 承载位从"约定"改为"由 `workbench.panes` 派生"；补聊天框双 kind 的实现状态 |
| §3 内容边界 | **保留 + 扩** | catalog/core 必需要素不变；补"空态/错误态必须带下一步动作" |
| §4 渲染契约 | **改** | ① 缺省页必须包含 catalog+core 两半（已写，补"由 `panes` 决定"）② 深度链接口径改写：`?surface=` 可带，但**宿主入口只认整条路由**（对齐 `validatePluginRoute`），`sel` 由页面自解析（现状可行，需在规范中写明）③ **新增锚点口径条款**：`data-vssaros-page` ≡ module 名且 body 上唯一；`data-vssaros-surface` 必须用标准属性名（补 B3） |
| §4.3 尺寸自适应 | **保留 + 强化** | 加"**业务容器实际宽度**"口径 + "禁 `@media`" + "禁单字竖排/按钮裁切/横向溢出"（L4-c） |
| §5 跨容器联动 | **保留** | S1 localStorage 方案不变 |
| §6 catalog entry 契约 | **保留 + 扩** | `status` 枚举扩 `busy`；加 `readonly`（媒体库类） |
| §7 工程落点 | **改** | 加"清单字段"一步（`vssaros.workbench`）；IDE 侧两张表降级为兜底 |
| §8 验收矩阵 | **扩** | 10 格 → 14 格；每格加"责任方"列；加"负对照断言"要求 |
| §9 反例 | **补 3 条** | ① 用 `@media` 判宽度 ② 清单字段只加在插件侧、不加执行端（静默失效）③ 页面自报工作台 id |
| §10 迁移 | **保留 + 改顺序** | 顺序改为：**清单字段 → Pane 拆分 → `?surface=` 两版 → 容器查询 → IDE 编辑区** |
| 新增 | **§0 状态** | 把首行"草案"改为明确状态（稿 A 已拍板 ⇒ 改成 v1.0 生效，并注明本方案落地项） |

---

## 7. 风险与未闭合

**风险**

| 风险 | 缓解 |
|---|---|
| manifestVersion 升 2 打破既有解析 | 解析层同时接受 v1/v2；v1 缺 `workbench` 时按默认值补齐并 warn |
| 一次改 11 个插件 ⇒ 回归面大 | 每阶段单独交付 + 探针基线不回退；先迁 1 个（建议 kb）做样板 |
| 清单/执行端/调用方三关不齐 ⇒ 静默失效 | 每个新契约配 `check-*` 守卫，且做**反向突变**验证 |
| 商城第三方工作台仍装不上 | P3 明确降级策略，不再让用户走死胡同 |

**未闭合（本方案不假装已解决）**

1. **官方工作台兼容（真兼容）** 未验证可行性 —— 依赖 8 个 dsh 客户端包与 2451 行宿主实现，需单独立项评估。
2. **P2 的会话归属** 与 dsh 原生会话模型存在张力，实际过滤语义需原型验证。
3. **`?surface=` 深链** 在宿主白名单层走不通（`validatePluginRoute` 拒查询串），只能"页面自解析 `searchParams`"—— 这条口径要在规范里写死并加守卫，否则容易复发。
4. **真机验收**：§8 矩阵扩充后的 14 格，需要在真机（dsh 窗口 + IDE 两窗口）逐格过，不能只靠 DOM 断言。
5. **官方规范里的"官方示例"只有最小骨架**（`development-guide.zh.md` §3.5 / §4），无官方模板仓（`dataelement/awesome-dsh-workbench` 本地无副本）⇒ 本方案中"官方范式"部分，**契约层可信度高、UI 形态层可信度中等**。

---

## 附：证据索引

| 主题 | 路径 |
|---|---|
| 官方规范（权威） | `G:\CustomWorkspaces\AIProjects\dsh-desktop\docs\workbench-standard.zh.md` |
| 官方宿主（服务端） | `G:\CustomWorkspaces\AIProjects\dsh-desktop\packages\dsh-desktop-workbenches\index.js` |
| 官方宿主（客户端 2451 行） | 同上 `client.js`（校验 852-883 / 归属 1135-1244 / slot 2414 / 渲染 2371-2388） |
| 官方包格式样板 | `packages\dsh-image-generation\{package.json,index.js,client.js,cordis.patch.yml}` |
| 官方归属存储 | `packages\dsh-desktop-workbenches\state.mjs`（校验 48-54 / 原子写 98-117） |
| 官方代际与宿主单例 | `packages\dsh-desktop-market-installer\generations\installer.mjs`（`HOST_SINGLETON_PATTERNS` 32 行） |
| 官方顶栏布局探针 | `packages\dsh-desktop\scripts\check-workbench-header-layout.cjs` |
| 我方规范稿（稿 A） | `doc\workbench-authoring-standard.md` |
| 我方清单解析真源 | `src\vs\sessions\contrib\dshHarness\common\vssarosPluginManifest.ts` |
| 我方 IDE 镜像表 | `src\vs\sessions\contrib\dshHarness\common\dshModuleContainers.ts`（142 / 249-276） |
| 我方页面路由校验 | `src\vs\sessions\contrib\dshHarness\common\dshPluginPage.ts`（27-53 / 72 / 89） |
| 我方样式真源 | `dsh-plugins\vssaros-foundation\lib\pageShell.js` |
| 我方 dsh 侧入口 | `dsh-plugins\vssaros-chat-surface\lib\client.workbenchNav.js`（66-82 / 389-400 / 848-853） |
| 我方页面承载 | `...\electron-browser\dshPluginViewPane.ts:392` / `dshPluginPageEditorPane.ts:166` / `dshPluginPageEditorInput.ts:42-56` |
| 我方工作台清单管理 | `src\vs\sessions\contrib\agentStudio\browser\workbenchManagerService.ts:78-93` |
| 我方工作区上下文 | `dsh-plugins\vssaros-foundation\lib\workspaceContext.js` |
