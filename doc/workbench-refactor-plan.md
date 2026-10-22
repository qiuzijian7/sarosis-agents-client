# 工作台重构方案：对齐 dsh-desktop 工作台范式

- 状态：**提案**（2026-10-21）。取代同日的 `doc/workbench-official-alignment-plan.md`（该稿已被 `git clean -fd` 删除，内容并入本稿）。
- 对标：`G:\CustomWorkspaces\AIProjects\dsh-desktop`（MIT，Copyright 2026 DataElement）
  - 规范：`docs/workbench-standard.zh.md`、`docs/workbench-market-acceptance.zh.md`
  - 宿主：`packages/dsh-desktop-workbenches/`（服务端 `index.js` + `state.mjs`，客户端 `client.js` 2451 行）
- 范围：`dsh-plugins/vssaros-*` 中 11 个带页面的工作台（dashboard / kb / memory / codebase / media / kanban / workflow / skills / sessions / scheduler / agents），外加 imagegen（目前源码已丢失，见附录 C）。
- ⚠ 本稿是**未入库文件**。`.ci/scripts/align-workspace.ps1` 在本地跑会执行 `git reset --hard` + `git clean -fd`，**先提交再说**。

---

## 0. 结论

**目标形态**：每个工作台都是一个"npm 包 + DSH 插件 + 已注册的工作台"，三重身份齐全；业务面板是 React 组件，交给宿主渲染；会话归属由宿主统一持久化。

**路线**：自建一个**与官方 API 同名同形的宿主** `@vssaros/dsh-workbenches`。服务端照搬官方（MIT），客户端自己写在原版 dsh 能提供的接缝上。**不原样运行官方宿主**，原因见 §2：它依赖 dsh-desktop 打在上游包上的补丁，在我们的原版运行时上实测激活失败。

**节奏**：先用最小的 scheduler 做样板，再逐个迁移。IDE 侧栏的目录页在迁移期间继续用 SSR，不推倒重来。

---

## 1. 范式基线：官方工作台到底是什么

| 维度 | 官方做法 | 证据 |
|---|---|---|
| 身份 | 三重身份：npm 包名 / `cordis.patch.yml` 插件条目 id / 工作台身份 `owner/repo`；旧 `register({id})` 只用于迁移 | `workbench-standard.zh.md` §2 |
| 包格式 | `main`+`exports["."]` 服务端入口；`exports["./client"]` 单文件客户端；`dsh.bundle.patch`；`dsh.client.platform="web"`；`dsh.client.inject` 必含宿主包；`@deepseek-ai/*` 只进 peer，且范围含预发布 | 同上 §3.2 |
| 服务端 | `export name / inject / Config(Schemastery) / apply`；接口在 `/api/<id>/` 前缀下；数据写配置的数据目录；卸载不删用户数据 | 同上 §3.4 |
| 客户端 | `__ModuleLoader__.load` → `ctx.effect(() => ctx.desktopWorkbenches.register(descriptor, Component))`，注销函数交给 `ctx.effect` | 同上 §3.5 |
| 注册校验 | **校验失败直接抛异常**：title 必填；repository 必须是 GitHub URL；`customFrame` 必须是布尔；`headerLayout ∈ {default, compact}`；`businessSide ∈ {left, right}`；`businessWidth ∈ [0.25, 0.7]`；同一来源重复注册抛错 | `client.js:852-883` |
| 渲染 | 宿主直接渲染业务组件（业务方不 `createRoot`）；`PanelBoundary` / `PanelFailure` 错误边界；`conversation` 节点由宿主 `createPortal` 交给业务组件 | `client.js:2186-2208, 2337-2388` |
| 布局 | 两种：**业务整页 + 按需会话**（`customFrame:true`）和**标准分栏**（会话 + 业务区 36%）；按业务容器宽度做响应式；禁止单字竖排、按钮裁切、整页横向溢出 | §4 |
| 顶栏 | `headerLayout:'compact'` 时，同一文档内必须有**唯一**的 `data-dsh-workbench-toolbar`，否则回退默认布局 | `client.js:2210-2233` |
| 归属 | 一个会话最多属于一个工作台；归属**不可改、不可删**；存 `state.json`（原子写 + 0o600 + revision 乐观锁）；服务端只读服务 `desktopWorkbenchOwnership.read()` | `state.mjs:26-117`、`index.js:73-80` |
| 无会话可用 | 业务面板不依赖会话；只有依赖会话的操作才创建或恢复会话；写文件前必须走宿主目录选择器 | §5–6 |
| 模式 | "原生会话"和各工作台是平行模式；当前模式决定可见会话和新建会话的归属 | §7 |
| 验收 | 规则三级（必须 / 建议 / 可选）；自测清单分"插件负责 / 宿主负责"；失败时如实交付未验证项 | §8–9 |
| 安装 | 每个插件装成不可变代际；宿主单例（`react` / `react-dom` / `@deepseek-ai/*` 不许自带副本）；策展 PR 审核 | `dsh-desktop-market-installer/generations/installer.mjs:9-43` |

**注意**：官方仓库里**没有任何工作台实例包**（全仓只有宿主自身调用 `register`）。所以"模板"就是上表的规范和宿主契约，不存在可以逐个照抄的官方工作台。

---

## 2. 决定路线的实测事实（2026-10-21）

**实测环境**：
- 独立沙箱 `DSH_HOME = %TEMP%\wb-probe-home`，用种子 profile 拷贝而来
- Electron 用 VsSaros 同一份（39.8.8）
- 视图参数照抄 `dshViewHost.ts:611-620`
- 没有碰 IDE 实例，也没有碰并发会话正在跑的探针

| # | 事实 | 结论 |
|---|---|---|
| F1 | 官方组件库 `@deepseek-ai/dsh-client-ui-primitives` 打包在 `dsh-web-frontend` 首屏 bundle 的**内置共享模块表**里（同表：react / react-dom / cordis / dsh-client-store / dsh-client-ui-slots / dockkit）。插件直接 `require` 即可，导出 288 个成员，Button / Switch / Toast / Menu / MenuItemButton / Modal / Tooltip / Input / Checkbox 都在；React 18.3.1 | **0.2.1-rc.1 就能用，不用升 rc.2** |
| F2 | React 组件直接注册进 `main` keyed 槽，再调 `ctx.layout.selectPanel(key)`：渲染成功、零 iframe、官方 Button / Switch 正常显示 | dsh 窗口里承载 React 工作台**零基建** |
| F3 | **官方宿主原样装进沙箱**：服务端 `/api/desktop-workbenches/state`、`/catalog`、`/development-guide` 都返回 200；客户端报 `web boot: dsh-desktop-workbenches: failed` | 服务端可以照搬，**客户端不能原样跑** |
| F4 | 失败原因：原版 `uiWorkspace` 上没有官方依赖的 6 个接缝（`registerSessionFilter` / `WorkspaceFilter` / `WorkspaceDeleteHandler` / `SessionStarter` / `SessionReuseFilter` / `SessionOpener` 全是 `undefined`），而官方在 `client.js:2432-2433` **不加判断直接调用**后两个。这 6 个接缝、`sidebar.quickSwitcher`、`desktop.workbench.frame` 的消费方，都来自 dsh-desktop 的 `patches/@deepseek-ai+dsh-client-ui-{workspace,sidebar,conversation}+0.2.1-rc.2.patch`（用 patch-package 施加） | 原样运行 = 引入**补丁层**；我们没有这套机制，而且直接改依赖产物会被静默回滚（已有教训） |
| F5 | 原版能用的接缝：`uiWorkspace.{openSession, createInWorkspace, openWorkspaceSession, startSession, prepareDraft, pickDirectory, createDirectory, watchNavigation, replaceMain…}`、`sessions.{create, list, scope, binding…}`、`sidebarRight.{openTab, place, split, float, dock…}`、`remote.pluginManager`、`locale`、`modules`、`workspaces` | 自建宿主可用的地基 |
| F6 | 单视图代价（私有内存 / JS 堆 / 就绪时间）：SSR 页 26–30MB / 0.8MB / 56–175ms；整份 dsh 客户端 89–93MB / 21.4MB / 0.6–0.95s（27 个请求，12.8MB JS） | IDE 每个"dsh 客户端视图"约 **+64MB、慢 0.5–0.8s** |

---

## 3. 路线比较

| 路线 | 做法 | 符合范式 | 代价与风险 | 判定 |
|---|---|---|---|---|
| **A 原样跑官方宿主** | 装 `dsh-desktop-workbenches`，并给上游 3 个包打补丁（照抄 dsh-desktop 的补丁） | 最高（还能跑第三方官方工作台） | 补丁针对 rc.2（我们是 rc.1）；需要 patch-package 式重放机制；每次升级 dsh 都要逐项审补丁；profile 由 pnpm 安装，补丁位置不稳 | ✗ 现阶段不做 |
| **B 自建兼容宿主** | `@vssaros/dsh-workbenches`：服务端照搬官方（保留版权声明）；客户端在 F5 接缝上自写，服务名与 API **同官方**（`desktopWorkbenches` / `desktopWorkbenchOwnership`） | 高：业务方代码与官方写法一致；缺的只是宿主内部那几个接缝 | 客户端约 1–1.5k 行；会话列表过滤做不到 dsh 原生侧栏里（F4） | **✓ 推荐** |
| C 只改清单和描述 | 只给清单加 `workbench` 描述段，页面仍是 SSR | 低：没有注册、没有 React、没有归属 | 小 | ✗ 不满足"符合范式" |

---

## 4. 目标架构（路线 B）

### 4.1 宿主插件 `dsh-plugins/vssaros-workbenches/`（新建）

```text
package.json          # @vssaros/dsh-workbenches；dsh.bundle + dsh.client
cordis.patch.yml      # insert id: vssaros-workbenches；config.root: !!js dshHomePath('vssaros-workbenches')
index.js              # 服务端：照搬官方 index.js 中与市场无关的部分（state / ownership）
lib/state.mjs         # 照搬官方 state.mjs（原子写 / 乐观锁 / 归属不可篡改）
client.js             # 客户端：desktopWorkbenches 服务 + Frame + 错误边界
THIRD_PARTY.md        # dsh-desktop MIT 版权声明
```

**服务端**（照搬，改名不改逻辑）：
- `ctx.reflect.provide('desktopWorkbenchOwnership', { read })`，返回 `{ revision, sessionBindings, added }`
- HTTP 前缀 `/api/vssaros-workbenches/`：`state`（GET）、`state/write`（POST，带 revision）、`state/migrate`
- 市场相关路由（catalog / market-install）**先不搬**，留给 P4

**客户端** `desktopWorkbenches` 服务（签名同官方，分期实现）：

| API | 期 | 说明 |
|---|---|---|
| `register(descriptor, Component) → dispose` | P1 | 校验规则逐条照抄 `client.js:852-883`（§1）；身份规则见 4.2 |
| `subscribe / getSnapshot` | P1 | 供注册表和中心页订阅 |
| `open(id, sessionId?) / home(id) / leave()` | P1 | 打开 = 设置 `state.active` 并按布局渲染（见 4.3） |
| `add / remove / toggle / toggleFavorite` | P1 | 对应现在 `IWorkbenchManagerService` 的 pin / 显隐 |
| `currentSession / ownsSession / showSession` | P2 | 读 `state.sessionBindings` |
| `ensureSession({folder, sessionId}) / newSession(workspaceId) / newWorkspaceSession()` | P2 | `sessions.create` + `bindOwnedSession`（照抄 `client.js:1135-1165`）；需要目录时先 `uiWorkspace.pickDirectory` |
| `saveNote / hideWorkspace / showWorkspace` | P3 | 按需 |
| `installFromMarket / uninstallFromMarket …` | P4 | 见 §6 |

### 4.2 身份规则

- **第三方工作台**：`repository` 必须是 `https://github.com/<owner>/<repo>`，身份为小写 `owner/repo`，与官方一致。
- **内置工作台**：官方禁止捏造真实仓库 ⇒ 新增**保留命名空间** `vssaros/<module>`。
  - 只有 `@vssaros/*` 包可以使用，宿主按调用方包名核对。
  - 描述符写 `repository: 'vssaros:<module>'`。
  - 宿主映射规则：`vssaros:<x>` → `vssaros/<x>`。
- **唯一真源**：清单 `vssaros.module` 就是 `<module>`。IDE 侧的 `DSH_MODULE_PAGES` / `DSH_MODULE_CONTAINERS` 和 chat-surface 的 `DEFAULT_ITEMS` 降级为**由注册表派生**，或作为离线兜底。三份真源收敛成一份。

### 4.3 布局在原版运行时上的映射（取代官方 `desktop.workbench.frame`）

| 官方布局 | 我们的承载 | 依据 |
|---|---|---|
| `customFrame: true`（业务整页 + 按需会话） | `main` keyed 槽 `vssaros-wb:<id>` 整页渲染业务组件；"打开 AI 对话"= 宿主提供的 `openConversation()`，调用 `selectPanel(null)` 回到会话，或把会话放进右栏 | F2；原版没有 `conversation` portal 节点，**暂时做不到把会话嵌进业务页**（§8 R2） |
| 标准分栏（会话 + 业务区） | 会话留在 `main`；业务组件注册为 `sidebar.right.pane.tab`（React，不再用 iframe）；`businessWidth` 映射到右栏宽度 | F5（`sidebarRight` 有 `place / split / dock`）；现有 `client.workbenchNav.js` 已经在右栏承载，只是用的 iframe |
| `headerLayout: 'compact'` | 宿主校验唯一的 `[data-dsh-workbench-toolbar]`（照抄 `HeaderHost` 的 MutationObserver），不唯一就回退并 `console.warn` | `client.js:2210-2233` |
| 错误边界 | 每个业务组件外包一层 `PanelBoundary`，失败时显示 `PanelFailure`（含"重试"） | `client.js:2186-2197` |

**IDE 侧两个承载位**：

| 承载 | 迁移期 | 终态 | 代价 |
|---|---|---|---|
| sideview（目录页，常驻、窄） | 保留 SSR `/x/<module>/?surface=sideview` | 保持 SSR（轻） | 无变化 |
| EditorPane（核心页，单例、按需开） | 已迁移的工作台：新增 `DshViewSurface = 'workbench'`，加载 dsh 客户端并直接 `open(id)`，用 CSS 裁掉侧栏（手法同现有 `'chat'`）；未迁移的继续用 SSR | 全部改为 `'workbench'` surface | 每个已打开的编辑区约 +64MB（F6）；需要在 `dshViewHost.ts` 增加 surface、在 `dshPluginPageEditorPane.ts` 切换加载方式 |

### 4.4 单个工作台的目标包形态

```jsonc
{
  "name": "@vssaros/dsh-scheduler",
  "version": "0.2.0",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json", "./cordis.patch.yml": "./cordis.patch.yml" },
  "files": ["index.js", "client.js", "lib", "cordis.patch.yml"],
  "peerDependencies": { "@deepseek-ai/dsh": ">=0.1.7-0 <0.3.0-0" },
  "dependencies": { "@deepseek-ai/schemastery": "~3.18.5" },
  "dsh": {
    "bundle": { "patch": ["./cordis.patch.yml"] },
    "client": { "platform": "web", "inject": ["@vssaros/dsh-workbenches", "@deepseek-ai/dsh-client-ui-slots"] }
  },
  "vssaros": { "manifestVersion": 2, "module": "scheduler", "activityBar": { "…": "…" }, "view": { "kind": "page", "route": "/x/scheduler/" } }
}
```

- **服务端 `index.js`**：
  - `Config` 改用 Schemastery（目前 12 个里只有 kanban / workflow 在用）
  - 业务 JSON 接口统一放到 `/api/<module>/`；`/x/<module>/` 只保留 SSR 目录页，迁移完成后删除
  - 需要判断归属的，注入 `desktopWorkbenchOwnership`
- **客户端 `client.js`**：

  ```js
  ctx.effect(() => ctx.desktopWorkbenches.register({
    title: '定时任务', repository: 'vssaros:scheduler', description: '…',
    icon: 'codicon:clock', customFrame: true, headerLayout: 'compact',
  }, SchedulerPanel))
  ```

  - 组件用官方组件库（F1）+ 容器查询（断点 320 / 520 / 760）
  - 数据只从 `/api/<module>/` 取
- **CSS**：只用宿主主题变量（`--dsw-alias-*` 是否在原版运行时里提供，需在 P1 核实，§8 R4），不许自定义色板。

### 4.5 归属与模式（P2）

- **持久化**：`state.json`（照搬），字段 `added / pinned / favorites / active / sessionBindings / recentSessions / notes / hiddenWorkspaces`。
- **新建会话即登记**：工作台内"开始 AI 协助"调用 `ensureSession`，内部做 `sessions.create`、`bindOwnedSession`（已有归属时抛错）、`uiWorkspace.prepareDraft` 填开场草稿，由用户自己发送。
- **会话列表过滤**：原版**没有** `registerSessionFilter`（F4），dsh 原生侧栏会话列表过滤不了。替代做法：
  - 我们自有的会话视图（`vssaros-sessions` 页、chat-surface 的 sessions chunk）按 `sessionBindings` 分组和筛选；
  - 原生侧栏的会话行目前**也没有** `session.leading` 槽 ⇒ 暂时显示不了归属图标；
  - 如需原生过滤，向上游提议这 6 个接缝（dsh-desktop 的补丁就是现成的设计稿）。
- **模式切换**：原版没有 `quickSwitcher` ⇒ 沿用侧栏那一行（`sidebar.panellist`）+ 启动器；"当前模式" = `state.active`。

### 4.6 安装、单例与审核

| 项 | 做法 | 期 |
|---|---|---|
| 宿主单例 | 守卫 `check-host-singleton.mjs`：插件 `dependencies` 不许命中 `react` / `react-dom` / `@deepseek-ai/*`（`schemastery` 除外，官方也把它当运行时依赖）；客户端 chunk 不许自带 React 副本（白名单：imagegen 画布产物，它跑在独立文档里） | P0 |
| 隔离代际 | 只用于**第三方**工作台安装。照搬 `generations/` 四件（约 87KB）＋主进程投影（约 46KB）；落点 `dshHostSupervisor`（Harness 停着时）；前置条件是安装包自带 pnpm | P4 |
| 策展审核 | 先做"上游目录 + 我们的白名单 / 兼容标记"叠加层；有内部投稿需求再在工蜂上做 YAML + MR + CI，目录由 `saros-marketplace` 新增 `workbench` 类型来提供 | P4 |
| macOS 拖动区 | 不做（只出 Windows 包；工作台页面碰不到窗口顶边） | — |

---

## 5. 迁移清单（11 个工作台 + imagegen）

**规模**为现存工作区的 `lib/**/*.js` 行数（2026-10-21 23:55 统计；多个插件刚被 reset 回 10-19 的版本，见附录 C，数字会随恢复变化）。

| 工作台 | 规模 | 现状 | 目标布局 | 顺序 | 理由 |
|---|---|---|---|---|---|
| scheduler 定时任务 | 416 行 | SSR，不读 surface | customFrame | **1 样板** | 最小；能走通 register / Schemastery / `/api` / 错误边界 / 编辑区全链路 |
| media 媒体库 | 831 | SSR，只读 | customFrame | 2 | 只读，没有写回流 |
| sessions 历史会话 | 1281 | SSR（已有磁贴视图） | customFrame | 3 | P2 的会话归属分组要落在这里 |
| skills 集成 | 1656 | SSR | customFrame | 4 | |
| workflow 工作流 | 2838 | SSR + 客户端工具卡，已用 Schemastery | customFrame | 5 | 运行态要实时刷新，适合 React |
| kanban 看板 | 3798 | SSR + 工具卡，已用 Schemastery | customFrame | 6 | 拖拽要重写 |
| dashboard 主页 | 3873 | SSR + `pageClient.js` | customFrame | 7 | 主页是工作台中心，最后再换会更稳 |
| memory 记忆库 | 7941 | SSR，分版 | 标准分栏（对话为主） | 8 | 边对话边看记忆 |
| codebase 代码库 | 9109 | SSR + 工具卡 | customFrame | 9 | 图谱画布，迁移量大 |
| kb 知识库 | 10946 | SSR，3300+ 行单文件 | customFrame | 10 | 最大，最后迁；先把 `/api` 拆出来 |
| agents | 11614 | SSR，37 处接口 | customFrame | 11 | 与群聊页耦合 |
| imagegen 生图 | —（源码丢失） | 画布本身已是 React（Excalidraw） | customFrame | 恢复后排第 3 | 先恢复源码 |

**每个工作台迁移的固定步骤**（逐个交付、逐个验收）：
1. 把业务数据接口拆到 `/api/<module>/`，SSR 页改为调用这些接口（行为不变，先补回归测试）。
2. 写 `client.js`：注册描述符 + React 业务组件（官方组件库 + 容器查询 + 三态：未选择 / 加载中 / 错误）。
3. dsh 窗口入口从 iframe 切换到 `desktopWorkbenches.open(id)`。
4. IDE 编辑区切换到 `'workbench'` surface；sideview 保留 SSR 目录页。
5. 删除旧的完整页 SSR（先确认没有探针或入口还在用），bump 版本，跑家族探针。

---

## 6. 分期

| 期 | 内容 | 交付判据 |
|---|---|---|
| **P0 地基**（约 1 周，零视觉变更） | ① **先把未入库的插件和文档提交或备份**（附录 C）；② 清单升 `manifestVersion: 2`，加 `vssaros.workbench` 段（title / description / icon / customFrame / headerLayout / layout），校验规则同官方；③ 宿主单例守卫；④ 修页面锚点口径：dashboard 的 `data-vssaros-dashboard-surface` 改为标准的 `data-vssaros-surface`（保留旧属性），`data-vssaros-page` 统一等于 module 名；⑤ 修 `/x/sessions/?view=tiles` 带查询串的问题 | 守卫做反向突变后会变红；探针基线不回退 |
| **P1 宿主 + 样板**（约 2 周） | ① `vssaros-workbenches`：服务端照搬、客户端实现 `register / open / home / leave / subscribe / add / remove`，含 Frame、错误边界、compact 顶栏校验；② scheduler 按 §5 步骤 1–5 完成迁移；③ IDE `'workbench'` surface | §7 验收矩阵中 scheduler 全部格子都有真机证据；编辑区内存增量在预算内（≤ +80MB/个） |
| **P2 归属**（约 1–2 周） | `state.json` + `desktopWorkbenchOwnership` + `ensureSession / newSession`；sessions 工作台按归属分组；media / sessions / skills 迁移 | 归属不可改的守卫（反向突变）；取消目录选择不留任何残留 |
| **P3 主体迁移**（按工作台计，约 6–8 周） | workflow → kanban → dashboard → memory → codebase → kb → agents | 每个迁完：旧完整页 SSR 已删除；家族探针通过 |
| **P4 市场兼容**（按需） | 第三方工作台：在 profile 里提供名为 `dsh-desktop-workbenches` 的兼容别名包（满足它们 `inject` 的加载顺序）；隔离代际安装；策展叠加层 | 至少 1 个真实第三方工作台在我们这里能装、能打开 |

### 6.1 P0 执行记录（2026-10-22）

| 项 | 状态 | 落点 / 证据 |
|---|---|---|
| ① 恢复 + 备份 | ✓ | 五轮恢复（本地历史 / profile 暂存副本 / CodeBuddy agent 快照 / 三方合并 / 外科式补写），见附录 C 的"恢复结果"；整份工作区（含未跟踪）写成备份提交 `refs/backup/reset-recovery-20261022`（不在任何分支上） |
| ② 工作台描述符 | ✓（**偏差**：不升 `manifestVersion`） | `vssarosPluginManifest.ts` 新增 `IVssarosWorkbench` + `parseWorkbench` + `workbenchIdentityOf`；规则逐条照官方 `register()`（title 必填 ≤24 字 / customFrame 布尔 / headerLayout ∈ {default,compact} / businessSide ∈ {left,right} / businessWidth ∈ [0.25,0.7] / 未知字段报错 / 身份 `vssaros:<module>` 只许内置用）。12 个有页面的插件清单已写 `workbench` 段并 bump 版本。**为什么不升到 v2**：`workbench` 是可选段，v1 解析器直接能表达；升版本要改所有清单与夹具，却不带来任何额外约束 |
| ③ 宿主单例守卫 | ✓ | `dsh-plugins/check-host-singleton.mjs`（与官方 `HOST_SINGLETON_PATTERNS` 逐字同款；白名单 schemastery 与 imagegen 画布产物；剥注释防误报） |
| ④ 标准 surface 锚点 | ✓（且新守卫多抓出 3 处） | dashboard / kanban / memory / codebase 的侧栏 body 都补了 `data-vssaros-surface="sideview"`（旧属性保留，探针不受影响）；只改侧栏、不改编辑区版 ⇒ dsh 窗口的 `probeCatalog` 行为不变 |
| ④b `data-vssaros-page` ≡ module | ✗ 暂缓 | agents 侧栏的 `agents-sideview`、memory 的 `memory-section` / `memory-detail` 被 p3-06 / p3-16 等探针钉住；改值要同批改探针 ⇒ 留到各工作台迁移时一起做 |
| ⑤ `/x/sessions/?view=tiles` | 关闭（核实无需修改） | 这条路由只用于 dsh 窗口的 iframe `src`，从不经过 `openModulePage` 白名单 ⇒ 与"宿主入口只认整条路由"不冲突 |

**新增守卫与反向突变**（判据都是"失败数增加 / 退出码非 0"，突变后自动还原）：

| 守卫 | 位置 | 突变结果 |
|---|---|---|
| 描述符校验 5 例 | `test/common/vssarosPluginManifest.test.ts` | M1 放宽 businessWidth 上限 / M2 不校验 headerLayout / M3 第三方冒用 `vssaros:*` / M4 未知字段放行 / M5 身份不小写 ⇒ 5/5 变红 |
| 有页面就必须注册为工作台 | `test/common/dshPluginPackages.test.ts` | 去掉 scheduler 的 workbench 段 / kanban 身份写错 ⇒ 2/2 变红 |
| 读 `?surface=` 就必须打标准锚点 | 同上 | kanban 丢锚点 / dashboard 退回旧锚点 ⇒ 2/2 变红 |
| 宿主单例 | `dsh-plugins/check-host-singleton.mjs` | 依赖里加 react / 加 `@deepseek-ai/*` / 入口打包 React / chunk 打包 React ⇒ 4/4 变红；schemastery 与"注释里的报错原文"两个负对照放行 |

**P0 结束时的基线**：`tsc --noEmit` 0 错误；IDE 侧单测 812 passing / 3 failing。剩下 3 个失败都不是本轮引入的：
- `vssaros-agents` 的 `files` 漏了 `lib/activity.js`：另一个会话 23:35 新加的文件；
- preset 生成物 3 行（期望 2 行）：另一个会话正在改 `vssaros-agents/cordis.presets.yml`；
- `vssaros-ego` 的工具不在探针覆盖表里：ego 是 10-21 新加的插件，覆盖表没跟上。

其它仍红的既有项：`check-spawn-hide`（`check-chat-surface-chunks.mjs:683` 缺 `windowsHide`，另一会话 23:39 的改动）、`check-migration-ledger`（vssaros-bridge 不在台账）、`run-pele-check`（自检夹具缺 `ctx.effect`）、`run-content-import-check`（自检没装 foundation 探针后门）。

### 6.2 P1 执行记录（2026-10-22，进行中）

| 项 | 状态 | 落点 / 证据 |
|---|---|---|
| ① 宿主插件 `@vssaros/dsh-workbenches` 0.1.0 | ✓ | `dsh-plugins/vssaros-workbenches/`。服务端：`lib/state.js`（移植官方 `state.mjs`）+ `lib/index.js`（只读服务 `desktopWorkbenchOwnership`；`GET/POST /api/vssaros-workbenches/state[/write]`；`connection` 走可选注入）；数据在 `$DSH_HOME/vssaros-workbenches/state.json`（已登记 persistence.json）。客户端：`lib/client.js` 提供 `desktopWorkbenches`（`register / open / home / leave / current / has / subscribe / getSnapshot / add / remove`），每个工作台一个 `main` keyed 面板 `vssaros-wb:<身份>`，外框带 `PanelBoundary` 错误边界与 compact 顶栏校验，外框是容器查询容器 `vss-workbench`。MIT 声明在 `THIRD_PARTY.md` |
| ② scheduler 样板（§5 步骤 1–2） | ✓ | 服务端新增 `GET /x/scheduler/api/list`（页面与接口共用 `listSchedules`）；新增 `lib/client.js`：React 业务组件 + 官方组件库 Button（取不到退回原生按钮）+ 三态 + 320/520/760 容器断点；清单补 `icon` / `headerLayout: compact`；版本 0.1.1 → 0.2.0 |
| ③ dsh 窗口入口切到新界面（§5 步骤 3） | ✓（**方案 A**：页签条保留，工作台嵌在页签下面） | 宿主新增 `activate(id)`（记前台 + 首次登记 added，**不切面板**）与嵌入式组件 `View({ id, active })`（同一套外框 / 错误边界 / 顶栏校验）。`client.workbenchNav.js` 只改两处：① 可选注入 `desktopWorkbenches`（宿主可能晚到），订阅其变化发页签刷新事件；② 页签内容分流 —— 路由是**不带查询串**的 `/x/<module>/` 且宿主里有 `vssaros/<module>` ⇒ 渲染 `View`，否则照旧 iframe。页签条、保活、持久化、右栏探测全部不变。chat-surface 0.2.194（build stamp 已动，入口指纹守卫要求）；宿主 0.1.1 |
| ④ IDE `'workbench'` surface（§5 步骤 4） | ✓ | 新视图形态 `DshViewSurface = 'workbench'`：加载 dsh 客户端根路径 `/`（URL 逐字符同官方 Web Client），模块路由经新 preload 参数 `--vssaros-dsh-workbench=` 交给页面（桥字段 `workbenchRoute`），preload 隐藏 dsh 左侧栏。chat-surface 入口 `client.js` 在"非 chat/full 一律 return"前加分支：宿主到场且已注册 ⇒ `open('vssaros/<module>')`；**10 秒不到场 ⇒ 退回 `<route>?surface=editor` 的 SSR 完整页**。判据 `hasWorkbenchClient(package.json)`（workbench 段 + `./client` 入口 + inject 宿主）由主进程算进 `IDshPluginInfo.workbenchClient`，`resolveModulePage` 经 `withWorkbenchClient` 打到模块页上；编辑区只对**模块主页**开 workbench 视图，显式子路由（如 `/x/kb/graph`）仍走 SSR。侧栏 sideview 不变。chat-surface 0.2.195 |
| ⑤ 删除旧完整页 SSR（§5 步骤 5） | 未开始 | 必须在 ③④ 之后（IDE 两个承载位目前仍用 SSR） |

**真机验收（沙箱 Host + VsSaros 同款 Electron 39.8.8，21/21）**：宿主加载并提供服务；scheduler 已注册；第三方身份规范化（`https://github.com/probe/boom` → `probe/boom`）；重复注册与 businessWidth 越界都抛；state.json 已读到；web boot 无激活失败；`open()` 后业务组件由宿主渲染进 main 面板（零 iframe）；三态渲染；compact 唯一工具栏 ⇒ `data-dsh-compact-valid=true`；外框 `container-type: inline-size`；open 后 `state.added` 经原子写落盘；过期 revision ⇒ 409；喂 3 条长文本行后在 320 / 520 / 760px 容器宽度下无横向溢出、无单字竖排；业务组件抛错 ⇒ 失败卡 + 重试（不白屏）；`leave()` 回会话；SSR 页与 `/api/list` 仍正常。复跑：`node %TEMP%\wb-p1-prep.mjs` + `VsSaros.exe %TEMP%\wb-p1-probe`。

**沙箱里发现的一个前提**：插件要进组合，profile `package.json` 的 `dsh.profile.bundles` 必须列出它（只放进 `dependencies` 不够，Host 路由 404、客户端不进 boot）。产品里 `dsh plugin add` 会自动追加（`dshCli.ts:39`），所以随包安装应当无需改动 —— **待 dev 实例重启后核实**。

**守卫**：`vssaros-workbenches/test/run-workbenches-check.mjs` 21 条（状态语义 / 客户端校验 / 服务端路由）；`dshPluginPackages.test.ts` 新增"React 工作台的客户端注册与清单同值，且加载链完整"。反向突变 9/9 变红：客户端 repository / title 与清单分叉、漏宿主 inject、漏服务 inject（4 条单测）；允许改会话归属、去掉乐观锁、损坏数据静默重置、允许重复注册、放宽 businessWidth（5 条自检）。

**方案 A 追加（同日）**：自检 +1（`activate` 不切面板 / `View` 已提供）共 22 条；`check-chat-surface-chunks.mjs` +4 条锚点（可选注入宿主 / 订阅刷新 / 页签内渲染 View / 只认不带查询串的路由）。反向突变 5/5 变红（4 条锚点 + "activate 偷偷切面板"）。
沙箱真机 14/14（`VsSaros.exe %TEMP%\wb-p1-tab`，带 `window.vssarosDsh` 桥接桩 —— 没有这座桥 chat-surface 不会装任何 chunk）：经页签面板打开定时任务 ⇒ 页签条在、内容是宿主 View、零 iframe；看板（未迁移）仍是 iframe；点页签条切走再切回 ⇒ 同一 DOM 节点（保活）；回会话后页签条仍在；嵌入式打开同样登记 added。整页打开路径回归 21/21。
⚠ 保活只对"点页签条切换"成立；按条目 key 直接 `selectPanel` 会整面板重挂（iframe 一样，现有设计）。

**步骤 4 追加（同日）**：沙箱 10/10（`VsSaros.exe %TEMP%\wb-p1-editor`，preload 桩同形状）：scheduler ⇒ 停在 `/`、自动整页打开、左侧栏隐藏、宽度占满、无页签条、零 iframe、无页面错误，**加载到打开 940ms**；kanban（未迁移）⇒ 9.9s 后退回 `/x/kanban/?surface=editor` 的 SSR 页。页签 14/14、整页 21/21 回归通过。
守卫：单测 +4（`hasWorkbenchClient` 正反例、`withWorkbenchClient` 只标启用且 module 对得上的、preload 常量与 `workbenchRoute` 暴露、"判据与客户端真的注册了工作台逐包一致"）；chunk 守卫 +3（workbench 分支在 return 闸之前 / SSR 退回 / 按路由打开）。反向突变 6/6 变红。
未做：主进程侧的 Electron 通道探针（`test/electron/channelProbe.ts`）没加 workbench 用例；真 dev 实例未验证。

**真机报障修复（2026-10-22 08:18）**：dev 实例报「Failed to load plugins / web boot: 1 entry did not activate / @vssaros/dsh-scheduler: pending (waiting for service: desktopWorkbenches)」。
- 根因 ①：宿主插件没有 `vssaros.module`，模块自发现不装它，而伴生安装清单里也没接 ⇒ dev profile 里根本没有宿主。沙箱验证一直是手工把插件拷进 profile，从没走过产品安装链，所以没发现。修：`DSH_WORKBENCHES_PLUGIN_NAME` + channel 解析 `dsh-plugins/vssaros-workbenches` + supervisor 伴生清单（foundation 之后、模块插件之前）。
- 根因 ②：scheduler 客户端把宿主服务写进静态 `exports.inject`，宿主缺席时 dsh 把整次 web boot 判失败、弹报错条。修：改成 `ctx.inject(['desktopWorkbenches'], …)` 可选注入（scheduler 0.2.1）。宿主缺席时只是不出现新界面，SSR 页照常。
- 我上一轮写的守卫**要求**静态 inject，等于把 bug 钉成了规则；已反过来：禁止静态写法、要求可选注入，另加"宿主已接进安装段且排在模块插件前"。
- 验证：沙箱用旧代码 + 撤掉宿主，逐字复现了报错；新代码在无宿主 / 有宿主两种情况下 web boot 都无失败条目（有宿主时 scheduler 已注册），SSR 页都 200。守卫突变 4/4 变红。

---

## 7. 守卫与验收

**新增守卫**（都要做反向突变验证：按目标形态写，`node` 跑，非 0 退出 = 红）：

| 守卫 | 内容 |
|---|---|
| `check-workbench-manifest.mjs` | 清单 v2 字段与校验规则（同官方 §1）；`view.route` 不许带查询串；`exports["./client"]` 存在且 `dsh.client.inject` 含 `@vssaros/dsh-workbenches` |
| `check-host-singleton.mjs` | §4.6 |
| `check-workbench-register.mjs` | 已迁移的工作台 `client.js` 必须有 `ctx.effect(() => ctx.desktopWorkbenches.register(`；描述符里的 `repository` 必须等于 `vssaros:<module>`；**三关齐**：清单声明了、客户端注册了、IDE 或 chat-surface 至少有一处入口在用 |
| `check-workbench-ownership.mjs` | 照搬官方 `validateState`（`state.mjs:48-54`）的单元测试：既有绑定不能改也不能删；新绑定必须对应已添加的工作台 |
| `check-page-responsive.mjs` | 业务根容器有 `container-type: inline-size` + 三个断点；不许用 `@media`（打印样式除外） |

**验收矩阵**（照官方 §8 加"责任方"列；每格要有真机证据）：

| # | 场景 | 期望 | 责任方 |
|---|---|---|---|
| 1 | dsh 窗口打开工作台 | 业务面板立即可用，不依赖会话 | 插件 |
| 2 | 无会话时点"AI 协助" | 创建本工作台会话并登记归属；草稿由用户发送 | 宿主 + 插件 |
| 3 | 320 / 520 / 760px 容器 | 无单字竖排、按钮不裁切、无横向溢出 | 插件 |
| 4 | compact 顶栏 | 唯一工具栏生效；两个工具栏时回退并出现 warn | 宿主 |
| 5 | 业务组件抛错 | 显示 `PanelFailure` + 重试，**不白屏** | 宿主 |
| 6 | IDE 编辑区打开 | 单例；连点 5 次仍只有 1 个页签；内存增量 ≤ +80MB | IDE |
| 7 | IDE sideview | SSR 目录页带 `data-vssaros-surface="sideview"` | 插件 |
| 8 | 卸载或停用工作台 | 会话、业务数据、笔记都还在原位置 | 宿主 + 插件 |
| 9 | 已绑定的会话再绑另一个工作台 | 抛"不能改变已有会话的工作台归属" | 宿主 |
| 10 | 写文件前 | 必须走 `pickDirectory`；取消后不留目录、项目、会话或绑定 | 插件 |

---

## 8. 风险与未闭合

| # | 风险 | 缓解 / 待验证 |
|---|---|---|
| R1 | 原版没有会话过滤接缝 ⇒ dsh 原生侧栏里各工作台的会话混在一起 | 我们自有的会话视图做分组；向上游提接缝；接缝出来之前**不承诺**"工作台模式只显示本工作台会话" |
| R2 | 原版没有 `conversation` portal ⇒ customFrame 页面里嵌不了原生会话 | 先用"切回会话 / 右栏会话"代替；P2 再调研 `dsh-client-ui-conversation` 是否导出了可复用的组件 |
| R3 | `desktopWorkbenches` 与官方同名 ⇒ 用户若另外装了官方宿主，两边的服务端半都会 provide `desktopWorkbenchOwnership`，会冲突 | 我们的宿主启动时检测 `dsh-desktop-workbenches` 是否也在，若在则拒绝启动并给出明确提示；P4 的兼容别名包与此一起设计 |
| R4 | `--dsw-alias-*` 主题变量在原版运行时是否齐全**未核实** | P1 样板第一件事就核实；缺的就映射到现有 `--vscode-*` |
| R5 | IDE `'workbench'` surface 每个视图 +64MB | 只给编辑区用（单例、按需开）；sideview 保持 SSR |
| R6 | 迁移期 SSR 与 React 两套并存（"新入口建了、旧入口没下线"是已知的返工根因） | 每个工作台迁完**同一轮**就删掉旧的完整页 SSR 和 iframe 入口（§5 第 5 步） |
| R7 | 种子 profile 的插件版本偏旧，实测数据是用旧版测的 | 量级结论不受影响；P1 用当前版本复测 |

---

## 附录 A：实测复跑

1. `node %TEMP%\wb-probe-prep.mjs`：把种子 profile 拷到 `%TEMP%\wb-probe-home`，并装上探针插件 `@probe/wb-react`。
2. `.build\electron\VsSaros.exe %TEMP%\wb-probe-electron`：跑 F1、F2、F6，结果写到 `%TEMP%\wb-probe-out\probe-rows.json`。
3. `node %TEMP%\wb-probe-prep-official.mjs`，再跑 `VsSaros.exe %TEMP%\wb-probe-official`：跑 F3、F4、F5。

⚠ 这些都在临时目录里，可能被清掉；做 P1 原型时应把它们搬进 `poc/`。

## 附录 B：证据索引

| 主题 | 路径 |
|---|---|
| 官方规范 | `dsh-desktop/docs/workbench-standard.zh.md`、`workbench-market-acceptance.zh.md` |
| 官方注册校验 | `dsh-desktop/packages/dsh-desktop-workbenches/client.js:852-883` |
| 官方接缝调用（无判断） | 同上 `:2415-2433` |
| 官方渲染 / 错误边界 / 顶栏 | 同上 `:2186-2233, 2337-2388` |
| 官方归属存储 | `…/dsh-desktop-workbenches/state.mjs`、`index.js:73-80` |
| 接缝来源（补丁） | `dsh-desktop/patches/@deepseek-ai+dsh-client-ui-{workspace,sidebar,conversation}+0.2.1-rc.2.patch` |
| 宿主装载行 | `dsh-desktop/build/dsh-desktop.patch.yml` |
| 隔离代际 / 宿主单例 | `…/dsh-desktop-market-installer/generations/installer.mjs:9-43` |
| 我方视图参数 | `src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts:611-620` |
| 我方 dsh 窗口入口 | `dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js` |
| 我方清单解析 | `src/vs/sessions/contrib/dshHarness/common/vssarosPluginManifest.ts` |

## 附录 C：2026-10-21 23:08 工作区被重置（与本方案的关系）

- **起因**：提交 `700004eef2c` 新增的 `.ci/scripts/align-workspace.ps1` 在本地运行时执行了 `git reset --hard` + `git clean -fd`（提交说明里已自述"本地跑时把文件删了 / revert 了"）。reflog `HEAD@{23:08:49}: reset`。
- **影响到工作台的部分**：
  - 已跟踪的文件被改回 HEAD：dsh-plugins 下有 205 个文件 mtime = 23:08:49。kb（工作区 0.4.1，已装副本最新 0.5.38）、workflow（0.5.1 / 0.8.3）、sessions（0.2.0 / 0.5.7）、skills（0.6.0 / 0.7.10）、dashboard（0.4.30 / 0.4.34）、kanban、codebase、media、mcp、bridge、browser、web-content-import 等**都落后于已装副本**。
  - 未跟踪的文件被删：`vssaros-imagegen`、`vssaros-market`、`vssaros-pele`、`vssaros-ego` 整个插件，以及 `doc/workbench-authoring-standard.md` 等未入库文档（被 `.gitignore` 的 `*mockup*.html` 幸存）。
- **恢复来源**：`~/.vssaros-dev/dsh-home/profiles/vssaros/.vssaros/plugins/<包>-<版本>-<指纹>/`（暂存副本；例如 `vssaros-dsh-imagegen-0.11.0-58b44b7c`、`vssaros-dsh-market-0.2.0-5162eed8`）。注意：暂存副本只包含 `files` 白名单里的文件（不含测试和构建脚本）。
- **对本方案的影响**：§5 的规模与现状按 reset 后的工作区统计；**P0 第一项就是恢复并提交**，否则迁移会建立在旧代码上。

### 恢复结果（2026-10-22 执行）

**实际影响面**比初查大：被改写的已跟踪文件 **247 个**（其中 `src/vs` 158 个，不只是 dsh-plugins），另有 4 个整插件与若干文档、测试、脚本被 `git clean -fd` 删掉。

| 轮次 | 来源 | 写入 | 安全闸 |
|---|---|---|---|
| 1 | 本地历史（CodeBuddy CN / WorkBuddy / Code 的 `User/History`）+ profile 暂存副本，取"重置前最新" | 363 | 目标仍是重置态（mtime = 23:08:49）或仍不存在才写；快照必须晚于该文件最后一次提交 |
| 2 | 以 `out/` 里重置前编译的孤儿产物为证据，找对应源文件的历史快照 | 14 | 只补不存在的文件 |
| 3 | **CodeBuddy agent 编辑快照**（`CodeBuddyExtension/.../file-tree/<会话>/files/`，共 16529 个重置前版本）—— agent 直接写盘的改动本地历史抓不到，这里有 | 42 | 文件当前内容必须仍是重置态或"我上一轮写的" |
| 4 | 三方合并（`git merge-file`，base = 快照时刻的提交）+ 外科式补写 | `providers.ts`（3 个可选成员）、`dshHostSupervisor.ts`（16 个冲突块按规则解：被摘出提交的另一条线取快照，22:02 的提交取当前） | 有冲突不自动写；冲突块逐个过目 |
| 5 | 暂存副本有、仓库缺的随包文件（kb 的 `codiconSubset.js` / `graphPage.js` 等） | 14 | 不被 ignore、不覆盖已存在文件 |

**没有任何快照、按别的证据重写的**（已在文件内注明）：
- `middleColumnChatEntry.ts`：按 `out/` 编译产物逐行还原，原文件头约 28 行说明注释没能找回；
- `dshActivityBarContribution.ts` 的 imagegen 视图宿主一行；`dshModuleContainers.ts` 的 `market` 模块登记；`dshModuleContainers.test.ts` 的 imagegen 夹具；
- `resources/.agents/kb/feishu-sync.mjs`：用随包副本（10-21）覆盖了被重置回 09-25 的真源。

**确认找不回的**：`resources/.agents/agents/*/.agent.md` 12 个、`resources/.agents/skills/*/SKILL.md` 12 个、`src/vs/sessions/contrib/agentStudio/webview/media/webview.js` —— 没有任何快照，停在 HEAD。它们重置前是否真有未提交改动无法判断（也可能只是行尾差异被 reset 重写）。

**备份**：每轮写入前的原内容在 `.build/reset-recovery-backup/`（被 ignore，`git clean -fd` 删不到）；恢复后的整份工作区（含未跟踪文件）在 `refs/backup/reset-recovery-20261022`（`git show --stat refs/backup/reset-recovery-20261022` 可看；不在任何分支上，不影响 HEAD 与索引）。
