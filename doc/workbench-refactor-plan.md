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

### 6.3 第三方工作台打通（2026-10-22）

调研结论（官方市场当日 19 个第三方包，逐个下载分析 + 沙箱实测）：9 个过得了 0.2.1-rc.1 的版本闸；能注册、能渲染，但缺会话接口、没入口、商城安装失败也报成功。按四步处理，前三步已落：

| 步 | 落点 | 说明 |
|---|---|---|
| 1. 商城如实安装 | `vssaros-market` 0.3.0：`lib/inspect.js`（新）+ `installTargets.js` + `index.js` | **装前检查**：兼容判据直接用 Host 启动时同一个函数 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`（运行时版本由 IDE 注入 `VSSAROS_DSH_RUNTIME_VERSION`）；客户端入口打包进 React ⇒ 拒装；依赖带 react 等只警告。**安装通道**：有 IDE 控制桥 ⇒ `ide.request{capability:'workbenches', op:'install'}`，由 IDE **先弹确认框**再走主进程 `InstallLocalPlugin` / `InstallPluginSpec`（暂存 + `dsh plugin add`，与随包插件同源）；没桥才回落 Host `pluginManager`，且 `application:failed` / 错误码 / 待批准构建都如实报失败。Release 包**解进持久目录** `<数据根>/market/packages/`（不再交会被删掉的 tgz，避免 `file:` 悬空）。新路由 `GET /x/market/api/check?id=`；兼容结论缓存进 `<数据根>/market/compat.json` 并挂到目录条目上 |
| 1b. IDE 侧能力 | `vssarosPluginManifest.ts`（白名单加 `workbenches`）、`dshIdeCapabilities.ts`（`case 'workbenches'` + `installWorkbenchPackage?` + 7 分钟预算）、`dshHarnessService.ts`（适配层）、`dshHostSupervisor.ts`（注入运行时版本） | 判定顺序写死：参数形状（包名白名单 / `dir` 与 `spec` 二选一 / spec 只收 `name@version` 或锁死 commit 的 `github:` / dir 必须绝对路径）→ **问用户**（拒绝 ⇒ 不装）→ 装 → 核版本 |
| 2. 第三方有入口 | `client.market.js`、`client.workbenchNav.js`（chat-surface 0.2.196） | 统一入口 `window.__vssarosOpenWorkbench(id)`：开一个 `wb:<身份>` 页签，内容是宿主 View；启动器列出宿主里注册的第三方；商城卡片按宿主注册表给「打开」，带「不兼容 / 待重启」标记与「卸载」；详情里有「检查兼容性」 |
| 3. 宿主会话接口 | `vssaros-workbenches` 0.2.0 | `isActive / currentSession / ownsSession / defaultWorkspace / showSession / newSession / newWorkspaceSession / ensureSession`，语义照官方（归属写 `sessionBindings`，不可改不可删）。**差异**：rc.1 不能把原生对话嵌进业务页（`main.conversation` 子槽归对话模块所有，重复声明会让对话模块激活失败，已实测）⇒ 开会话 = 切到原生对话；customFrame 组件拿到的 `conversation` 是"开始对话 / 回到对话"占位块 |
| 4. 运行时安全 | 部分 ✓（market 0.3.1、chat-surface 0.2.197） | **策略叠加层**：随包 `catalog/policy.json` + 本机 `<数据根>/market/policy.json`，`blocked` 两层取并集（本机放不出产品方停用的）、`allowOnly` 取交集；停用的条目 install / check 连下载都不做（`blocked_by_policy`），目录卡片显示「已停用」。**服务端能力审计**：静态扫描包里非客户端的 JS（启动子进程 / 注册 AI 工具 / 联网 / 写删文件 / 动态执行代码），结果进 IDE 确认框逐条列出；npm / 源码来源装前看不到代码 ⇒ 确认框如实说"看不到"。实测 `mfanoffice/text2demo` 扫出 spawn + 联网 + 写文件 + 动态执行。**未做：隔离代际安装** —— dsh 只从 profile 的 `node_modules` 组合 bundle，官方隔离靠 `generations/` + 主进程投影 + 补丁加载器，rc.1 原版没有接缝；策略只管"装不装"，已装的被停用不会自动卸（要走卸载） |
| 5. 迁移 7 个自家工作台 | **6/7 已迁，且 kb / agents 都进了第二刀（kb 还多第三刀）**：workflow 0.8.9、kanban 0.8.11、memory 0.3.90、codebase 0.6.86、kb 0.5.47（§6.11 + §6.13 + §6.14）、agents 0.2.118（§6.12 + §6.15）；主页由另一条会话迁（打包 React app + JSON 岛，未走 desktopWorkbenches） | 剩下 dashboard / codebase / kb / agents（量级分析见 §6.6；记忆库"要先补 JSON 接口"这条已经落地 ⇒ §6.9） |

### 6.4 P3 迁移：第 1 个 —— workflow 工作台（2026-10-22）

**做了什么**（`@vssaros/dsh-workflow` 0.8.4 → 0.8.7）：

| 步 | 落点 | 说明 |
|---|---|---|
| 1. 业务数据接口 | `lib/index.js` 新增 `GET /x/workflow/api/page` + `collectPageData()` / `workflowRowData()` | **SSR 页与 React 工作台共用同一份取数**（`collectPageData`）⇒ 两个界面的数字 / 筛选 / 画布永远一致 ✓（各写各的 ⇒ 迟早分叉 ✗）。载荷：摘要 + 行数据（排序键在服务端算好）+ 选中项 + 服务端 SVG 画布 + worker 自证 + 已注册工具名 |
| 2. React 业务组件 | **新文件 `lib/client.workbench.js`** | 经 `ctx.desktopWorkbenches.register(DESCRIPTOR, WorkflowPanel)` 注册（描述符与清单 `vssaros.workbench` 同值，守卫逐项比对）。三态（加载中 / 出错 / 空）；搜索 / 排序 / 筛选（全部·有图·运行中·待整理）与旧页脚本**同口径**；行动作：⧉ 打开画布（`/api/open`）、◎ 看图（新增：把某条设为页内画布预览目标）、▶ 执行（`/api/run`）；⤓ 导出 / 🗑 删除 / ＋新建 **仍未迁到 Host**，点了给原因（不假装成功）|
| 3. 入口切换 | 清单 `dsh.client.inject` 加 `@vssaros/dsh-workbenches`；版本 0.8.7；`files` 补 `lib/client.workbench.js` | 清单里加宿主包 ⇒ `hasWorkbenchClient` 变真 ⇒ **IDE 编辑区自动改开 `'workbench'` 视图**（`dshPluginPageEditorPane`），dsh 窗口页签条里 `/x/workflow/` 那条**自动**从 iframe 换成宿主渲染（`workbenchNav` 的 `wbIdOf` 路由映射）⇒ 入口零改动 ✓ |

**两个真踩到的坑**（写下来免得再踩）：
- **子块文件名必须是 `client.<名字>.js`**：装载器只认 `client.*.js` 的相对请求 ⇒ 写成 `workbench.js` 直接被拒（`client-modules: invalid relative chunk request "./workbench.js"`）⇒ 工作台静默不出现。
- **改代码必须 bump 版本**：版本没变 ⇒ profile 里留的是旧字节（探针 p3-17 的"装的就是当前源码"当场抓住）⇒ 改了 `client.js` 忘了升版本 ⇒ 装出来的还是旧的。

**守卫与探针**：
- `dshPluginPackages.test.ts` 两条守卫改为**扫整个 `lib/`** 找 `desktopWorkbenches.register(`（工作台组件常是独立子块 ⇒ 只看入口会把"已迁"判成"没迁" ✗）；新增 `registersWorkbench()` 辅助函数；**静态 `exports.inject` 里写 desktopWorkbenches** 的禁令改为全 lib 生效。
- `p3-17-client-modules.mjs` 新增一条：**React 工作台子块必须真能服务**（子块不在 `files` 里 ⇒ 装出来的包没有它 ⇒ 装载器 404 ⇒ 工作台静默消失，而入口与工具卡都正常 ⇒ 从外面看不出来 ✓）。

**验证**：
- 沙箱真机 11/11（`VsSaros.exe %TEMP%\wb-wf-probe`）：宿主注册表里有 `vssaros/workflow`；`/api/page` 返回真实数据（`wf-dynamic-emoji`）；dsh 窗口里打开「工作流」⇒ **宿主渲染**（`data-vssaros-page="workflow"` + `data-vssaros-surface="workbench"`，页签面板内），**页面里没有 `/x/workflow/` 的 iframe**；列表渲染出真实工作流、界面数字与 JSON 接口一致；搜索过滤（1 → 0 行 + 空态提示）、清空可逆、筛选/排序可用；web boot 无失败条目、无页面异常。
- workflow 家族探针：p3-10 81/81、p3-103 12/12、p3-104 9/9、p3-105 4/4、p3-17 38/38（含新守卫）。
- p3-151 22/23：唯一未过的是「`workflow_*` 出现在**模型请求**的工具列表里」—— 用**改前的 `index.js`** 跑同一条探针同样不过 ⇒ 与本次改动无关（那是 agent/preset 面，另一条会话正在改：preset 生成物已经是 3 个 patch 项而守卫要求 2 个）。
- `dsh-plugins` 全部根守卫绿；IDE 单测 841 通过 / 3 失败（imagegen 的 `--vscode-*` 令牌、preset plane 3 个 patch 项、vssaros-ego 工具覆盖 —— 都不是本轮）。

**未做**（下一步）：
- **旧 SSR 页还没删**（§5 步骤 5）：`p3-10` 还在按 SSR 页的机器锚点断言（`data-vssaros-workflow-*` / `<svg class="node">` …）⇒ 删页前要先把这套锚点改到 React 侧或改探针。
- 工作流仍是**只读切片**：写路径（新建 / 导入 / 删除 / 拖拽排序 / 置顶）没迁，页面上的入口照旧"点了给原因"。
- 引擎仍在渲染进程 worker（未迁到 Host worker_threads）——页面自诊断里那句话照旧。

### 6.5 P3 迁移：第 2 个 —— 看板工作台（2026-10-22）

**做了什么**（`@vssaros/dsh-kanban` 0.8.5 → 0.8.8）：

| 步 | 落点 | 说明 |
|---|---|---|
| 1. 业务数据接口 | `lib/index.js`：`collectBoardData()`（SSR 与 React 共用取数）+ `boardPageJson()`（载荷）+ `GET /x/kanban/api/page` | 载荷：六列定义（`BOARD_COLUMNS`）＋ 卡片（`cardModel` 与页面同款投影）＋ 镜像卡 ＋ 筛选项（看板 / 负责人）＋ 自诊断事实（工具 / 工作区 / runner / 数据文件） |
| 2. React 业务组件 | **新文件 `lib/client.kanban.js`** | 六列 ＋ 卡片 ＋ 镜像卡（只读）＋ 折叠 ＋ 筛选（搜索 / 看板 / 负责人 ⇒ "显示 N / M 张"）＋ 详情抽屉（`/api/task`）＋ **拖拽换列**（指针拖动、幽灵跟手、落列高亮、锁定列拒收、乐观移动、失败回滚、**以服务端回的列为准**）—— 全部照旧页 `BOARD_SCRIPT` 的行为 |
| 3. 入口切换 | 清单 `dsh.client.inject` 加 `@vssaros/dsh-workbenches`；版本 0.8.8；`files` 补 `lib/client.kanban.js` | 同 workflow：IDE 编辑区自动改开 `'workbench'` 视图、dsh 窗口页签条按路由自动换成宿主渲染 |

**又踩到两个坑**（都写进代码注释了）：
- **拖拽监听器必须始终挂着**：把 `pointermove/up` 挂在"拖起来才挂"的 effect 里 ⇒ 第一次 move 没人接 ⇒ 拖动永远起不来 ✗（真机验收当场抓到）。拖动状态住 ref，React 状态只管视觉（幽灵 / 高亮）。
- **落列用几何判定，不用 `elementFromPoint`**：后者取的是**真实指针**位置（元素被盖住时会落到别的元素上）⇒ 旧页的 `columnUnder(x, y)`（横向落在列带内 + 纵向在列范围）才是同款口径 ✓。
- 另：effect 的依赖数组里引用的 `const` 必须在该 effect **之前**定义（渲染时求值 ⇒ 否则 TDZ ⇒ 整个组件炸 ✗）。

**验证**：
- 沙箱真机 11/11（`VsSaros.exe %TEMP%\wb-kb-probe`）：宿主注册表有 `vssaros/kanban`；`/api/page` 返回六列 / 4 张卡 / 筛选项；dsh 窗口里打开「看板」⇒ **宿主渲染**、**页面里没有 `/x/kanban/` 的 iframe**、六列与卡片都在、"显示 4 / 4 张"；搜索过滤（4 → 0 张、计数变 "显示 0 / 4 张"）、清空可逆、下拉候选齐全；**拖拽换列真的生效**：从「待执行」拖到「待分解」⇒ 卡片换列、回话"已移动到「待分解」（待分解）"、**回读服务端也是 triage**（以服务端为准 ✓）；启动无失败条目、无页面异常。
- 看板家族探针：p3-01 25/25、p3-03 2/2、p3-91 19/19、p3-99 10/10、p3-100 5/5、p3-110 36/36、p3-09 89/89 ✓。
- **未过但与本次改动无关**：p3-88（73/74）、p3-15（19/21）、p3-02（61/64）—— 根因是**工具清单早就漂了**：模块注册 13 个工具（多出 `decompose` / `swarm` / `specify`），而客户端工具卡只接 10 个 ⇒ 三条探针都在报这个旧账（另一条会话正在动工具面：`dshToolCoverage` 守卫也为 `vssaros-ego` 报红）。本轮没碰任何工具清单。
- `dsh-plugins` 全部根守卫绿；IDE 单测 841 通过 / 3 失败（imagegen 的 `--vscode-*` 令牌、preset plane 3 个 patch 项、vssaros-ego 工具覆盖 —— 都不是本轮）；类型检查 0 错误。

**未做**：
- 旧 SSR 页还在（`p3-88` 仍按 SSR 页的机器锚点断言）⇒ 删页前要先把锚点改到 React 侧。
- 看板仍是**只读 + 拖拽**（建卡 / 改字段 / 评论 / 依赖这些写路径在 Host 工具里，工作台界面里没有入口）。
- 工具卡与模块的工具清单偏差（13 vs 10）**仍未修**（属另一条线）。

### 6.7 工作流页改**左右两档**（2026-10-22，用户要求）

**要求**：左边显示 workflow item 列表，右边显示工作流画布。

**落点**（`@vssaros/dsh-workflow` 0.8.7 → 0.8.9，React 工作台侧）：
- **左列**（`[data-wf-pane="list"]`）：工作流条目列表（搜索 / 排序 / 筛选仍在顶部工具条里）。**点行 = 选中** ⇒ 右侧换成它的画布（选中项有 `is-selected` 态 + `data-selected="1"`）。
- **右列**（`[data-wf-pane="canvas"]`）：服务端 SVG 画布（`[data-wf-canvas]`）＋ 那条工作流的 id / 节点数 / 边数；图太宽时**横向滚动**（SVG `max-width:100%` ⇒ 缩到栏宽，纵向超出则滚）。
- **轻接口** `GET /x/workflow/api/canvas?id=`：只回 `{ selected, canvas }` ⇒ 点行换图**不重搬整页**（行 + 摘要 + worker 自证）✓（与 `/api/page` 同源于 `collectPageData` ⇒ 两边口径一致 ✓）。
- **旧的「◎ 看图」按钮撤掉**（它就是"选中"的意思 ⇒ 与点行重复）；**「⧉ 在编辑器区打开画布」保留**（那是另一个能力：在 IDE 画布页打开）✓。
- **窄容器不改成上下排**：原先写了 `@container (max-width:900px)` 折成竖排 ⇒ 沙箱里容器宽度不够 ⇒ 真的折了 ⇒ 与要求相反 ⇒ 删掉那条规则，改成**左列收缩（240–340px）+ 画布那栏自己滚** ✓。

**旧的 SSR 页仍是"列表优先 + 画布折叠在页脚"** —— 那是它当初为 **330px 窄侧栏**设计的形态（A 稿），不在本次要求内；真正给用户看的页面现在是 React 工作台（dsh 窗口页签 / IDE 编辑区）⇒ 左右两档 ✓。

**验证**：沙箱真机 15/15（`VsSaros.exe %TEMP%\wb-wf-probe`）：左右两栏**同一行并排**（`leftOfRight` + `sameRow` 都为真）、右栏是服务端 SVG（6 个节点）、**点左列另一条 ⇒ 右栏换成它的画布**（`data-wf-selected` 与 `[data-wf-canvas]` 都切到那条）、`/api/canvas` 轻接口可用；原来的宿主渲染 / 无 iframe / 筛选 / 排序检查照旧全过。workflow 家族探针 p3-10 81/81、p3-103 12/12、p3-104 9/9、p3-105 4/4、p3-17 38/38；`dsh-plugins` 全部根守卫绿；IDE 单测 846 通过 / 3 失败（同前：imagegen 令牌、preset plane、vssaros-ego —— 都不是本轮）；类型检查 0 错误。

**顺带修的两处版本/缓存账**：改了 kanban 的入口注释 ⇒ 升 0.8.9（否则 p3-17 的"装的就是当前源码"当场报红 ✓）；chat-surface 入口的构建标记也补了一次（它的 chunk 被别的会话改过 ⇒ 守卫要求入口比 chunk 新 ✓）。

### 6.8 看板也改**左右两档**（2026-10-22，与 §6.7 同款）

**要求**：看板页也照工作流的形态分左右两档（用户："执行"）。

**落点**（`@vssaros/dsh-kanban` 0.8.9 → 0.8.11，`lib/client.kanban.js`）：
- **左列**（`[data-kb-pane="board"]`，`flex:1`）：六列看板（列内滚动、整块横向滚动照旧）；拖拽换列、筛选、折叠、镜像卡全部不变 ✓。
- **右列**（`[data-kb-pane="detail"]`，380px，`min-width:260px; max-width:46%`）：**卡片详情常驻**。
  - 未选卡片 ⇒ 一句提示（"点左边任意一张卡片看详情（只读）；按住卡片拖动可以换列。"）⇒ 不是空白 ✓；
  - 点左列卡片 ⇒ 右栏拉 `/api/task?id=` 填详情（状态 / 负责人·优先级·来源 / 看板 / 依赖 / 时间 / 描述 / 追加记录），带「关闭」清选中；
  - **原来的右下角浮层撤掉**（`.kb-drawer` 的 `position:fixed` 那套样式换成了 `.kb-pane-detail`）；
  - 机器锚点沿用：`data-kanban-drawer` / `data-kanban-drawer-title` / `data-kanban-drawer-note` / `data-kanban-drawer-close`（只是位置从浮层搬进右栏）+ 新增 `data-kb-layout="split"` / `data-kb-pane="board|detail"` / `data-kanban-drawer-empty`。
- 窄容器同样**不折成上下排**（与工作流页同一条纪律）✓。

**验证**：沙箱真机 14/14（`VsSaros.exe %TEMP%\wb-kb-probe`）：左右两栏同一行并排（左看板在左、右详情在右）、未选时右栏给提示、**点卡片 ⇒ 右栏换成它的详情且「关闭」在右栏内**（证明不是浮层）；原来的宿主渲染 / 无 iframe / 六列 / 卡片 / 筛选 / **拖拽换列（服务端回读一致）** 全部照旧通过。看板家族探针 p3-01 25/25、p3-03 2/2、p3-91 19/19、p3-99 10/10、p3-100 5/5、p3-110 36/36、p3-17 38/38；`dsh-plugins` 全部根守卫绿；IDE 单测 846 通过 / 3 失败（同前三条）；workflow 家族 p3-10 81/81。

**教训（第二次踩，写成规矩）**：**版本号必须是这一包最后一次改动的动作** —— 先 bump 版本、后动入口注释 ⇒ p3-17 的"装的就是当前源码"立刻报红（版本没变 ⇒ profile 里留旧字节）✓。两个包里都已经在注释里写了这条。

### 6.9 P3 迁移：第 3 个 —— 记忆库工作台（2026-10-22）

**做了什么**（`@vssaros/dsh-memory` 0.3.86 → 0.3.90）：

| 步 | 落点 | 说明 |
|---|---|---|
| 1. 业务数据接口 | `GET /x/memory/api/page`（`lib/index.js`） | 与 SSR 页**同一份 `state`**（snapshot / drafts / distill / lastAction）⇒ 数字与文案口径一致 ✓。**刻意不在这里 `void refresh()`** —— 那是"页面每次打开刷一次网关"的副作用，放进 GET 会让轮询把网关打爆 ✗；要新鲜数据由页面上的「刷新」显式触发 ✓。草稿那份仍然读一次（渲染依赖，代价只是读本地 jsonl ✓） |
| 2. React 业务组件 | **新文件 `lib/client.memory.js`** | 主入口（查看完整记忆 ⇒ `/x/memory/detail`）＋ 四张统计卡 ＋ 自动沉淀那组计数 ＋ 固定槽位 chips ＋ 草稿区（最近 5 条，提升/丢弃**照旧打后端那两个 POST 路由** ⇒ 审批闸口径不变 ✓）＋ 上次动作 30 秒内明说一次 ＋ 诊断（折叠，机器锚点照旧在 DOM 里）＋ 工作记忆原文（网关未配置 / 刷新失败都如实说 ✓） |
| 3. 入口切换 | **新建 `lib/client.js`**（本包原先没有客户端半）＋ 清单加 `exports["./client"]` / `dsh.client.inject` / `files`；版本 0.3.90 | `hasWorkbenchClient` 变真 ⇒ IDE 编辑区改开 'workbench' 视图、dsh 窗口页签按路由换成宿主渲染 ✓。描述符与清单同值（`customFrame:false` + `layout: businessSide=right / 0.36`，即"边对话边看记忆"的标准分栏）✓ |

**新踩的坑**：**`exports` 在 factory 里并不存在** —— 我照抄 `module.exports.apply = …` 时写成了 `exports.apply = apply`，真机直接 `web boot: … import failed: exports is not defined`（整个客户端入口不激活）。**入口必须先 `var exports = module.exports;` 再往 `exports` 上挂**（其它插件的入口都是这么写的，我当时只看了尾部 ✗）。

**验证**：沙箱真机 8/8（`VsSaros.exe %TEMP%\wb-mem-probe`）：宿主注册表有 `vssaros/memory`；`/api/page` 可用（8 个固定槽位、网关空）；dsh 窗口里打开「记忆库」⇒ **宿主渲染、页面里没有 `/x/memory/` 的 iframe**；10 张统计卡 + 8 个槽位 + 主入口链接 + 诊断锚点 + 工作记忆区都在；网关未配置时**如实说**"记忆网关未配置：设 VSSAROS_MEMORY_GATEWAY_URL…"（没有冒充空的 ✓）。看板 14/14 回归通过。

**未过但与本次无关**：`p3-07`（127/131）、`p3-36`（9/17）—— 都卡在"假网关的注入状态/账本"上。做过归属实验：**把我的 `/api/page` 接口临时关掉再跑，p3-07 反而 126/131（更差且计数浮动）** ⇒ 是既有的时序/环境问题，不是本轮引入的。

### 6.10 P3 迁移：第 4 个 —— 代码库工作台（2026-10-22）

**做了什么**（`@vssaros/dsh-codebase` 0.6.83 → 0.6.86）：

| 步 | 落点 | 说明 |
|---|---|---|
| 1. 业务数据接口 | 路由里把渲染入参收成一个 `pageData` 对象，`GET /x/codebase/api/page` 直接回这份 JSON | **只装配一次** ⇒ SSR 页与 React 工作台吃同一份（数字/文案不会各算一遍 ✗）。重活（21MB `graph.db.zst` ⇒ 935MB sqlite）**原样留在 Host**，打开页面仍是轻路径 ✓ |
| 2. React 业务组件 | **新文件 `lib/client.codebase.js`** | 四张统计卡（Nodes / Edges / Files / Last Index）+ 检索（按名 / 限定文件）+ 结果列表（**点一条看依赖**：用了什么 / 谁用了它）+ Projects + 形状查询 + 诊断（折叠；`data-vssaros-codebase-*` 锚点照旧在 DOM 里 ✓）+「图谱页 →」（`?view=graph` 那页**留在 SSR**：它要全量图 + 交互，不是这一版的活） |
| 3. 入口切换 | 入口 `lib/client.js` 加 `require.async('./client.codebase.js')`；清单 inject += 宿主包、`files` += 子块；版本 0.6.86 | 同前三个：IDE 编辑区改开 'workbench' 视图、dsh 窗口页签按路由换成宿主渲染 |

**验证**（沙箱指向**真图谱**：仓库根的 `.codebase-memory`，40 万节点 / 125 万边）：
- 沙箱真机 8/8（`VsSaros.exe %TEMP%\wb-cb-probe`）：宿主注册表有 `vssaros/codebase`；`/api/page` 可用（root=仓库根、解析器可用、target=shadow）；dsh 窗口里打开「代码库」⇒ **宿主渲染、无 `/x/codebase/` iframe**；四张卡显示**真实数字**（402642 Nodes / 1251035 Edges / 13435 Files / Last Index 2026-10-22 12:03）；**检索真的出结果**（`q=dsh` ⇒ 30 条）；**点第一条 ⇒ 依赖分区出来**（1 个节点：用出 2 条 / 被用 13 条，逐条列出 CALLS …）。
- 代码库家族探针：p3-39 32/32、p3-43 30/30、p3-47 13/13；p3-11 **174/177**、p3-41 26/28、p3-42 22/23 —— p3-11 的三条全在 **`search_code`** 工具（SKIP_DIRS / 无索引也能搜 / `*.ts` glob 语义），与本轮（页面数据 + JSON 接口）无关 ✓。

**一处实现细节**：`manifest.savedAt` 可能是**时间戳数字**也可能是 ISO 串（IDE 两份清单口径不同）⇒ `Last Index` 卡先判数字再格式化（否则直接显示 `1792670591966` ✗，实测抓到）。

### 6.11 P3 迁移：第 5 个 —— 知识库**第一刀（只读面）**（2026-10-22）

**用户 2026-10-22 拍板 A 方案**：知识库分两刀 —— 这一刀只做**库 + 笔记文件树 + 全量检索 + 正文阅读**；
编辑 / 整理 / 标签管理 / 库设置**仍留在 SSR 页**（第二刀才搬进来），组件里如实留了「旧页 ↗」入口 ✓。

| 步 | 落点 | 说明 |
|---|---|---|
| 1. 业务数据接口 | `GET /x/kb/api/page`（`lib/index.js`） | 库（id / 名字 / 目录 / 索引数 / kernel）+ **两节文件树**（`库` / `笔记`，节点带 `abs` 绝对路径）+ 标签分类 + 自诊断。**正文不塞进来**（库大时是几百 KB 的重复传输 ✗）⇒ 点文件才走现成的 `/api/doc?uri=`；检索走现成的 `/api/search?q=` ✓ |
| 2. React 业务组件 | **新文件 `lib/client.kb.js`** | 左右两档：左 = 库选择 + 检索框 + 文件树（目录可折叠）/ 检索命中列表 + 标签云；右 = 正文阅读面（`<pre>`，截断如实说）。点文件 ⇒ 右列显示正文 |
| 3. 入口切换 | **新建 `lib/client.js`**（本包原先没有客户端半）+ 清单 `exports['./client']` / `dsh.client.inject` / `files`；版本 0.5.42 | 同前四个：IDE 编辑区改开 'workbench' 视图、dsh 窗口页签按路由换宿主渲染 |

**两个真踩到的坑**（都写进注释了）：
- **两节目录是中文**：`LIBRARY_DIR = '库'`、`NOTES_DIR = '笔记'` ⇒ JSON 的键要用**稳定英文名** `library` / `notes`，值才是中文目录名。直接拿中文名当键 ⇒ 客户端读 `sections.library` 拿到 undefined ⇒ **树永远是空的** ✗（夹具一改就复现）。
- **库 id 有形态要求**：`/^\d{8,14}-[a-z0-9]+$/i` ⇒ 沙箱夹具目录名得长成 `20261022120000-demo` 才被认成库（`demo-vault` 不行）。

**验证**：沙箱真机 8/8（`VsSaros.exe %TEMP%\wb-kbprobe`）：宿主注册表有 `vssaros/kb`；`/api/page` 返回 1 个库 + 两节树（`库` 1 个文件 / `笔记` 1 个文件）；dsh 窗口里打开「知识库」⇒ **宿主渲染、无 `/x/kb/` iframe**、左右两档在；**点「一篇笔记.md」⇒ 右列显示真实正文**（`# 一篇笔记…`）；检索「知识库」⇒ **命中 2 条**（索引自动重建）；启动无失败、无异常。

**未过但与本次无关**：`p3-08` 142/150 —— 8 条分别属于：工具清单漂移（多了 `feishu_*` 一整组工具 ⇒ `TOOL_NAMES` 与实际注册不再逐字相同）、`kb_organize` 的审批语义（该 ask 却 allow）、`kb_search` 空命中用例（夹具里其实有文档）、以及**库注入的显示名/图标标记**（页面 HTML，本轮没碰）。这些都不是"加一条 GET JSON 路由"能引起的；我**没有跑改前基线**做逐条归因（p3-08 一次要几分钟），如实标注。

**第二刀要做的**（下一轮）：`kb_write_note` / `kb_mkdir` / `kb_organize` 三个写能力的界面（新建笔记、建目录、整理/归档）、标签管理、库设置入口 ⇒ 做完才删旧 SSR 页。

### 6.12 P3 迁移：第 6 个 —— Agents **第一刀（名册面）**（2026-10-22）

**范围**（与知识库第一刀同口径）：**Agent 名册**——名字 / 角色 / 模型 / 注册状态 / 会话数 / 待处理 / 运行中 / 收件箱，点开看它的会话与收件箱。
用量 / 委派 / 授权 / 群聊 / 记忆 / 演化 六个页签**仍在 SSR 页**（组件右上角「完整页 ↗」）——它们各自是一整套交互（审批模板、outbox 重发、群聊三栏、记忆查看器、演化 diff），一次迁完不现实。

| 步 | 落点 | 说明 |
|---|---|---|
| 1. 业务数据接口 | `GET /x/agents/api/home`（`lib/index.js`） | 名册行 + **每个 agent 的面板数据**（复用现成的 `buildHomeData` ✓：会话 / 需要处理 / 运行中 / 收件箱）+ 摘要 + 实况 + 未读。⚠ 页面上那几份 `await`（assignments / templates / groups / outbox / unread）**收成只取一次**（`assignmentsData` …）⇒ SSR 页与工作台吃同一份 ✓ |
| 2. React 业务组件 | **新文件 `lib/client.agents.js`** | 名册列表（头像底色用服务端算好的 `avatarColorOf`）+ 筛选框（id / 名称 / 描述）+ 点行展开抽屉（描述 / 预设 / 模型 / 工具·人设 / 实况 / 需要处理 / 最近会话 / 收件箱）+「完整页 ↗」 |
| 3. 入口切换 | **新建 `lib/client.js`**（本包原先没有客户端半）+ 清单 `exports['./client']` / `dsh.client.inject` / `files`；版本 0.2.117 | 同前五个：IDE 编辑区改开 'workbench' 视图、dsh 窗口页签按路由换宿主渲染 |

**验证**：沙箱真机 8/8（`VsSaros.exe %TEMP%\wb-ag-probe`，夹具 = **两个真实 agent**（`gr-gc-expert` / `ppt-slides-master`））：
宿主注册表有 `vssaros/agents`；`/api/home` 返回 2 个 agent + 各自面板数据；dsh 窗口里打开「Agents」⇒ **宿主渲染、无 `/x/agents/` iframe**；名册渲染出「GR垃圾回收专家 / PPT专家」+ 角色 + id + 模型；搜索过滤（2 → 0 行 + 空态，清空可逆）；**点一行展开抽屉**（描述 / 预设 `vssaros-gr-gc-expert` / 模型 `hy3-ioa`）；启动无失败、无异常。

**未过但与本次无关**（已用机械判据归因）：
- `p3-149`（9/12）、`p3-151`（8/13）—— 都是**内置 agent 定义**的静态检查（tools 是否 dsh 真名、skills 是否在库里、委派开关文件⇄代码一致）。这两条探针**只读文件**（无 `startHost`、无 `/x/agents` 请求）⇒ 不可能受"加一条 GET 路由 / 把 await 收成一次"影响 ⇒ 是既有的定义漂移（另一条会话正在动 agent 工具面）。
- `p3-92-sessions-subagents`（16/17）同一类。
- `check-dsh-creative-picker.mjs` exit=1 是**在 `dsh-plugins` 里跑**才有的路径问题（它要在仓库根跑，实跑通过 ✓）。

**第二刀要做的**：用量 / 委派 / 授权（含 outbox 重发）/ 群聊三栏 / 记忆查看器 / 演化面板 ⇒ 做完才删旧 SSR 页。

### 6.13 知识库**第二刀**：写动作接进工作台（2026-10-22，0.5.44）

第一刀留的口子补上了：**新建笔记 / 新建目录 / 重命名 / 删除** 现在能在工作台里直接做。

| 动作 | 走的接口 | 说明 |
|---|---|---|
| 新建笔记 / 目录 | `POST /api/new`（现成） | 左列顶部一条「类型 + 名字 + ＋ 新建」；**点「笔记」区的目录 = 改目标目录**（目标路径实时显示，可「回笔记根」）|
| 重命名 | `POST /api/rename`（现成，`mode:'move'`） | 右栏「✎ 重命名」→ 行内输入 → 确定；改完**树与右栏标题一起换**（正文按新路径重读，读不到就留空态、不假装成功）|
| 删除 | `POST /api/delete`（现成） | 右栏「🗑 删除」→ **二次确认**（「确定删 / 取消」）→ 树里消失、右栏回空态 |

**纪律**：这三个动作的围栏（只在「笔记」区动、名字非法字符拒、文件锁 + 派生刷新）**原样复用后端**，前端**不重写**一遍校验 ⇒ 不会出现"两份围栏"✓。界面上只对**笔记区**的文件显示改名/删除按钮（`库` 区只读 ✓）。

**仍未搬**：整理（批量归档）、标签管理、库设置 —— 仍在旧页（「旧页 ↗」）。

**验证**：沙箱真机 11/11（`VsSaros.exe %TEMP%\wb-kbprobe`）：前 8 条（树 / 正文 / 检索 / 左右两档）照旧通过；新增三条 —— **新建笔记真的落盘并在树里出现**（回话「已创建…」）、**重命名生效**（树里换名 + 右栏标题跟着换）、**删除生效**（树里消失 + 右栏回空态）。`p3-08` 142/150、`p3-69` 6/6、`p3-17` 38/38；全部根守卫绿（`check-dsh-creative-picker` 那条需在仓库根跑）。

**两个探针教训**（写下来免得再踩）：①`data-*` 用空串做值不好查（改成按 class 查更稳）；②检索命中列表会**顶掉树**（新建表单在树里）⇒ 探针在测写入前要先清检索。

### 6.14 知识库**第三刀**：整理 = 移动（2026-10-22，0.5.47）

「整理」里最常用的一条是**把笔记挪到别的目录** —— 这条**不需要新接口**：`POST /api/rename` 的 `mode:'move'` 本来就是它（同一把文件锁、同一份「只在笔记区」围栏、同一套派生刷新）✓。

- **界面**：右栏「⇄ 移动」→ 下拉列出「笔记」区所有目录（含根）→ 确定；成功后列表刷新、右栏回空态。
- **目标目录来源**：`vault.sections.notes` 的树（服务端算好的同一棵）⇒ 与左列看到的完全一致 ✓。

**新踩的坑（写进注释了）**：那份目录列表写成 `const noteDirs = (() => …)()` 会**立即执行**，而 `vault` 在组件里是**后面**才声明的 ⇒ TDZ ReferenceError ⇒ **整个组件崩、页面空白**（真机 `hasRoot:false` 当场抓到）✗。必须写成惰性函数 `noteDirsOf()` ✓。

**仍未搬**：批量归档（多选）、标签管理、库设置 —— 标签在 **kernel 索引**里（只有 IDE 侧能写），库设置走 IDE 面板 ⇒ 这两条留在旧页是**如实**的边界，不是偷懒。

**验证**：沙箱真机 **12/12**（`VsSaros.exe %TEMP%\wb-kbprobe`）：新增第 12 条 —— **建目录 → 把笔记移进去 → 用 `/api/page` 回读服务端树确认它真的落在该目录下**（回话「已移动到…」）；原有 11 条（树 / 正文 / 检索 / 新建 / 重命名 / 删除）全过。`p3-08` 142/150（同前，工具面漂移）、`p3-17` 38/38、IDE 单测 866 通过 / 9 失败（全是别处的）。

### 6.15 Agents **第二刀**：三个列表页签搬进工作台（2026-10-22，0.2.118）

第一刀只迁了名册，这轮把**三个"列表型"页签**也搬进来（数据全用现成的 GET 接口，**没有新增 Host 代码** ✓）：

| 页签 | 数据 | 渲染 |
|---|---|---|
| 用量 | `GET /api/usage` | 汇总（会话 / 回合 / token）+ 逐 agent 表 + 「名册外会话」+ 截断提示 |
| 委派 | `GET /api/assignments` | 台账条数 / 运行中 / 上限 + 表（状态 pill / agent / 任务 / 耗时或错误）；**明写"内存态，Host 重启清空"** |
| 授权 | `GET /api/approval-templates` + `GET /api/outbox` | 能力声明（tools allowlist）、审批模板列表、发件箱（状态 + 工具 + 时间）|

**群聊 / 记忆 / 演化不放进来**（如实边界）：
- 群聊是**三栏应用**（DSB v3 群聊页，`/x/agents/group/<id>`），不是列表；
- 记忆有**查看器 + 版本**，演化有**时间线 + 逐行 diff + 回滚**（独立页面 `/x/agents/memory/<id>`）；
⇒ 页签条右侧给「群聊 ↗」「记忆 · 演化 ↗」两个明确入口 ✓（点进去还是那两页，不假装搬完了 ✗）。

**写动作**（改模板 / 重发 outbox / 授权确认 / 建群）仍在完整页 —— 组件里写明了 ✓。

**验证**：沙箱真机 **12/12**（`VsSaros.exe %TEMP%\wb-ag-probe`）：新增 4 条 —— **用量 / 委派 / 授权三个页签都渲染出面板且无报错**、**切回名册列表还在**、页签条上有「群聊」「记忆」两个入口。原有 8 条（注册 / `/api/home` / 宿主渲染 / 名册 / 搜索 / 抽屉）全过。
`p3-06` 98/98、`p3-111` 27/27、`p3-96` 40/40、`p3-17` 38/38；全部根守卫绿；IDE 单测 866 通过 / 9 失败（全是别处的 `parallel` / imagegen / preset / ego）。

### 6.16 Agents **第三刀**：群聊 / 记忆 做成只读页签（2026-10-22，0.2.119）

上一版只给了「群聊 ↗ / 记忆 · 演化 ↗」两个外链；这轮把**能只读展示的部分**搬进来（仍然零新增 Host 代码）：

| 页签 | 数据 | 展示 / 边界 |
|---|---|---|
| 群聊 | `GET /api/groups` | 群名 / 模式 / 成员数 / 消息条数 + **每群「打开 ↗」**（跳 `/x/agents/group/<id>` 那页三栏群聊） |
| 记忆 | `GET /api/memory?agent=&file=&rev=` | agent 选择器（默认第一个）+ 记忆文件列表（点开读正文）+ **历史版本列表**（点开读那一版，`&rev=`）+ 未启用 Git 时如实说 |

**边界照样写清**：建群 / 发消息 / 恢复某版 / 提交快照 / 演化 diff **仍在各自页面** —— 它们都是写动作或多栏编辑器，不是"列表页签"能覆盖的 ✓。

**验证**：沙箱真机 **15/15**（`VsSaros.exe %TEMP%\wb-ag-probe`）：新增 3 条 —— **群聊页签渲染（群列表 + 打开入口）**、**记忆页签渲染（agent 选择 + 文件列表）**、**记忆里点文件真能看到内容**（只读查看通了）；原有 12 条全过。
`p3-06` 98/98、`p3-134` 19/19、`p3-153` 26/26、`p3-17` 38/38；根守卫绿；IDE 单测 866 通过 / 9 失败（全是别处的）。

### 6.17 Agents **第四刀**：演化页签（只读时间线 + 逐行 diff）（2026-10-22，0.2.120）

七个页签里最后一个也进来了（仍然是零新增 Host 代码）：

| 内容 | 走什么 | 说明 |
|---|---|---|
| 时间线 | `GET /api/memory?agent=` 的 `log` | 最近 20 个提交（hash + message），每条两个动作：「看这版」/「对比当前」 |
| 看这版 | `…&file=&rev=` | 只读查看某一版正文 |
| **对比当前** | `…&file=&rev=&against=working` | **diff 由服务端算**（`core/diff.js` 的 `lineDiff`）⇒ 前端只渲染 `diff.rows`（`+` / `-` / 空格），并显示 `+N / -M` 与「粗粒度」提示（文件太大时服务端退化成整块删/增 ✓） |

**回滚是写动作** ⇒ 仍在完整页；按钮旁写明了 ✓。

**验证**：沙箱真机 **17/17**（`VsSaros.exe %TEMP%\wb-ag-probe`）：新增 2 条 —— **演化页签有时间线**（夹具里给 `gr-gc-expert/memory` 建了 git 提交）、**「对比当前」算出逐行 diff 并渲染**（`data-ag-evo-rows` > 0）；原有 15 条全过。
`p3-06` 98/98、`p3-155` 73/73、`p3-137` 17/17、`p3-17` 38/38；根守卫绿；IDE 单测 866 通过 / 9 失败（全是别处的）。

**夹具教训**：`Copy-Item` 目标已存在同名子目录时会**套一层**（`agents/gr-gc-expert/gr-gc-expert/.agent.md`）⇒ 扫描不到 agent、名册 0 行。修法：把内层内容上移。写下来免得下次又当成"代码坏了" ✓。

### 6.18 自有工作台 ⇄ dsh 工作台规范：审计 + 两处修正 + 守卫扩项（2026-10-22）

**审计口径**（三处真源）：清单类型 `IVssarosWorkbench`（`vssarosPluginManifest.ts`）＋ 宿主 `register()` 的 `normalize()`（`vssaros-workbenches/lib/client.js`，逐条照官方）＋ 现有守卫（`dshPluginPackages.test.ts` / `check-chat-surface-chunks.mjs` / `check-workbench-catalog.mjs`）。

**结论**：14 个包声明了 `vssaros.workbench`；**7 个已注册成 React 工作台且合规**（workflow / kanban / memory / codebase / kb / agents / scheduler）；另外 7 个只是"声明了"（dashboard / imagegen / marketplace / media / parallel / sessions / skills）—— 清单字段可选，**声明了≠已迁**，它们在 dsh 里仍是 SSR/iframe 形态。

**查出并修掉的两处（都是"描述符与清单不一致"，宿主不回落 ⇒ 用户可见）**：
| 包 | 问题 | 修法 |
|---|---|---|
| kb 0.5.48 | 描述符缺 `description` ⇒ 注册表里那一项说明为空 | 补上与清单同值的 `description` |
| memory 0.3.91 | 描述符缺 `icon` ⇒ 注册表里图标为空、商城落到 🧩 | 补 `codicon:database` |

**顺带对齐的两个图标**（agents / kanban）：它们的描述符图标（`organization` / `checklist`）与清单 `activityBar.icon`（`robot` / `tasklist`）**本来就不一致**。按"清单是唯一真源、描述符照抄"的原则，给这两个包的 `vssaros.workbench` **显式加了 `icon`**（值 = 描述符值），activityBar 那份保持不变（两者语义不同：IDE 容器图标 vs 工作台图标）⇒ 现在 7/7 逐字一致。

**守卫扩项（把发现变成规矩）**：`dshPluginPackages.test.ts` 里原来只比 `repository` + `title`，现在**加比 `description` 与 `icon`**：
- 期望 `description` = 清单 `workbench.description`；
- 期望 `icon` = `workbench.icon ?? activityBar.icon`（规范口径：workbench.icon 缺省回落 activityBar.icon）；
- 比对**限定在 `const DESCRIPTOR = { … };` 块内**（整个文件里还有别的 `icon:` / `description:`，全会误伤）；
- 注释写明"宿主快照不回落到清单"这条根因。

**验证**：沙箱真机 3/3（`VsSaros.exe %TEMP%\wb-wbaudit-probe`，注册表实测）：7 个自有工作台都在；每个的 `description` 非空；`title` / `description` / `icon` **三项逐字等于清单**。`check-chat-surface-chunks` 绿；IDE 单测 866 通过 / 9 失败（仍是那 6 个套件的旧账：`parallel` 插件、imagegen CSS 令牌、preset plane、vssaros-ego、主进程同步写 —— 与本轮无关）；类型检查 0 错误。

**仍未管的规范项**（记下来，下一轮可选）：第三方注册 `codicon:*` 图标在侧栏启动器里会退化成 🧩（那条判断是 `icon.length <= 4 ? icon : 🧩`，按 emoji 假设写的）—— 查过 dsh 前端**没有任何 codicon 字体/CSS**，而启动器/商城的图标体系整体是 emoji（`DEFAULT_ITEMS` 全是 emoji）⇒ 这是**设计口径不一致**（清单规范说 icon 是 `codicon:xxx`，消费端只会渲染 emoji），不是笔误。要修就得在消费端加一张 `codicon→emoji` 映射表（book→📚 / database→🧠 / robot|organization→🤖 / tasklist|checklist→🗂️ / list-tree→🔀 / type-hierarchy→🕸️ / clock→⏰），或给 dsh 前端补 codicon 字体（后者不在本仓）。

#### 2026-10-22 追加：`compact` 工具栏守卫 + 修掉守卫"空转"

- **新增守卫**：`dshPluginPackages.test.ts` 里加一条 —— 清单声明 `headerLayout: 'compact'` ⇒ 客户端代码里 `data-dsh-workbench-toolbar` 必须**恰好 1 处**（0 处 = 宿主吸了空壳；≥2 处 = 不知道吸哪个）。
- **发现并修掉的守卫缺陷**：这段循环原来用 **per-plugin `assert.*`** ⇒ **第一个不合规的包一抛错，后面所有包就不再被检查**（守卫静默空转 ✗）。改成**收集 `workbenchProblems` 数组、循环后一次性 `deepStrictEqual`** ⇒ 一次报出全部问题。
- **怎么发现的（重要，记下来当方法论）**：用**变异测试**验证新守卫 —— 把 scheduler 的工具栏锚点删掉，跑单测。第一次变异写成 `data-dsh-workbench-toolbar-MUTATION-TEST`，**正则按前缀匹配 ⇒ 计数仍是 1 ⇒ 守卫照旧通过**（假阴性）；改成彻底去掉属性后才红。随后又做**双重变异**（agents 的 description + scheduler 的工具栏）⇒ 两条消息**同时**出现在一次运行里 ⇒ 证明"收集后一次性断言"生效。
- **又一个实测坑**：变异"改坏再改回来"，内容虽然复原，**子块 mtime 已被推进** ⇒ `check-chat-surface-chunks` 立刻报"入口比子块旧"⇒ 必须重新动入口 + 升版本（agents 0.2.122）。这条已写进该包入口注释。
- **验证**：双变异时 865 通过 / 10 失败（两条都点名）；还原后 866 / 9（仍是那 6 个套件的旧账）；类型检查 0 错误；`check-chat-surface-chunks` 绿；其余根守卫绿（`check-dsh-creative-picker` 需在仓库根跑，实跑通过）。

### 6.19 工作台 UI 统一：**共享样式层** + workflow 试点（2026-10-22）

**问题（体检数据）**：7 个自有工作台各写一套 CSS ⇒ **7 套类前缀**（`vssWf` / `kb-` / `mem-` / `cbm-` / `kbt-` / `ag-` / `vssSched`）、11–15 处 `rgba()`、0–11 处裸 `#hex`；令牌用得零散（scheduler 只用 1 种、codebase 3 种）。**裸色值不随主题切换**（`design-platform.css` 里令牌在 `body` 与 `body[data-ds-dark-theme]` 各有一套值，裸色只有一套）。另外 `doc/workbench-authoring-standard.md` 只规范了结构与承载，**没有任何视觉条款** —— 这就是漂移的根。

**落点（方案 A：共享层放宿主包，零新依赖）**：

| 步 | 落点 | 说明 |
|---|---|---|
| 1. 共享样式层 | **新子块 `vssaros-workbenches/lib/client.ui.js`**（0.2.3） | ① `--wb-*` 刻度（间距 4/8/12/16、圆角 6/10/999、字号 11/12/13/16、等宽兜底）；② `wb-*` 原语 16 类（toolbar/split/pane/list/row/badge/btn/chip/input/select/card/table/tabs/pre/empty/diag/foot/drawer/ghost）；③ 颜色**只走** `--dsw-alias-*` 且写成 `var(--x, 兜底)` |
| 2. 注入 | 宿主入口 `client.js` 的 `apply` 里 `require.async('./client.ui.js')` 后 `install()` | 只注入**一次**（`<style id="vssaros-wb-ui">`）⇒ 7 个工作台共用；装不上不影响工作台本体（各包留降级样式） |
| 3. 试点迁移 | workflow 0.8.11（`lib/client.workbench.js`） | 33 个 `vssWf*` 类名 → `wb-*`；**自写的 50 行 CSS 删掉**，只留 3 行布局覆盖。行数 373 → 330 |

**新守卫 `check-workbench-style.mjs`**（四项，**只查已统一的包** —— `UNIFIED` 白名单逐个入列，避免空转）：
① 组件里无裸色值（`var(--…, 兜底)` 内的不算）；② 有 `data-vssaros-surface="workbench"`；③ ≥10 个不同 `wb-*` 类；④ `data-dsh-workbench-toolbar` 恰好 1 个。变异测试确认有效（往 chunk 里塞一行 `'#ff0000'` ⇒ 当场报「1 行裸色值」）。

**真机验证（`VsSaros.exe %TEMP%\wb-wf-probe`，18/18）**：共享样式表注入成功（`#vssaros-wb-ui`，11.3 KB）；workflow 组件用了 **27 个不同的 `wb-*` 类**；**切暗色主题时行背景从 `rgba(38,49,72,.1)` 变成 `rgba(255,255,255,.14)`** ⇒ 令牌真的跟着 dsh 主题走；原有 15 条（左右两档 / 画布 / 搜索 / 排序 / 筛选 / 无 iframe）全过；`/api/canvas` 轻接口照旧。

**回归**：p3-10 81/81、p3-103 12/12、p3-104 9/9、p3-105 4/4、p3-17 38/38；`dsh-plugins` 全部根守卫绿；宿主自检 30/30；IDE 单测 866 通过 / 9 失败（仍是那 6 个套件的旧账）；类型检查 0 错误。

#### 2026-10-22 追加：kanban 迁完（第 2 个）

`@vssaros/dsh-kanban` 0.8.12 → **0.8.13**：

- 通用 UI 类 → `wb-*`（`dsh-kanban`→`wb wb-kanban`、`dsh-header`→`wb-toolbar`、`kb-toolbar`→`wb-field-row`、`kb-main`→`wb-split`、`kb-pane*`→`wb-pane*`、`kb-card`→`wb-card`、`kb-detail`→`wb-drawer`、`kb-ghost`→`wb-ghost`、`dsh-empty/diag`→`wb-empty/wb-diag`），三个控件补 `wb-input` / `wb-select`。
- 自写 CSS 从 68 行压到 **46 行**，只留看板特有的东西（六列、列内滚动、卡片内几行、详情字段），间距走 `--wb-*`、字号走 `--wb-f-*`。
- **修掉一批根本不存在的令牌名**：`--dsw-alias-border-default`、`--dsw-alias-state-focus-primary`、`--dsw-alias-list-dropBackground`、`--dsw-alias-state-warning-primary`、`--dsw-alias-font-family-monospace` —— 它们一直静默回落到硬编码兜底 ⇒ 那些地方**从来没跟随过主题**。现在统一成 `border-l1/l2`、`brand-primary`、`interactive-bg-active`、`state-warn-primary`、`--wb-mono`。
- **优先级三色**（`#ef4444` / `#f59e0b` / `#3b82f6`）改成语义令牌 `state-error-primary` / `state-warn-primary` / `brand-primary`（＋各自 secondary 作底色）——这是守卫 `check-workbench-style.mjs` 当场抓出来的（1 项问题：3 行裸色值）。

**验证**：沙箱真机 **17/17**（`VsSaros.exe %TEMP%\wb-kb-probe`）：新增 3 条 —— 共享样式表注入（`#vssaros-wb-ui`）、组件用了 **17 个 `wb-*` 原语**、**切暗色时列背景跟着变**；原有 14 条（六列 / 卡片 / 筛选 / **拖拽换列且服务端回读一致** / 详情在右栏 / 无 iframe）全过。看板家族 p3-01 25/25、p3-03 2/2、p3-91 19/19、p3-99 10/10、p3-100 5/5、p3-110 36/36、p3-17 38/38、p3-10 81/81；根守卫全绿；IDE 单测 866 通过 / 9 失败（同前那 6 个套件的旧账）。

#### 2026-10-22 追加：memory 迁完（第 3 个）

`@vssaros/dsh-memory` 0.3.90 → **0.3.93**：

- 类名映射：`mem`→`wb wb-mem`、`mem-bar`→`wb-toolbar`、`mem-ver`→`wb-sub`、`mem-link`→`wb-btn is-ghost`、`mem-card`→`wb-card`、`mem-grid`→`wb-cards`、`kb-stat-cell/num/label`→`wb-card`/`wb-card-num`/`wb-card-label`、`mem-section-hd`→`wb-group-hd`、`mem-slots`→`wb-chips`、`mem-slot`→`wb-badge`、`mem-actions`→`wb-acts`、`mem-diag`→`wb-diag`、`mem-pre`→`wb-pre`、`mem-empty`→`wb-empty`。
- CSS 30 → **18 行**（只留 hero 大数字、草稿列表、错误色、按钮形状），其余走共享层。
- 同样修掉不存在令牌：`--dsw-alias-border-default` / `-label-link` / `-font-family-monospace`。
- **机器锚点改 `data-*`**：统计卡 `data-vssaros-memory-stat`、槽位 `data-vssaros-memory-slot`(+容器 `-slots`)。原来探针数的是 `.kb-stat-cell` / `.mem-slot` —— **类名是视觉层**，UI 统一一改就数出 0（当场踩到：stats=0 / slots=0）⇒ 锚点必须与样式解耦。

**验证**：沙箱真机 **11/11**（`VsSaros.exe %TEMP%\wb-mem-probe`）：新增 3 条（共享样式表注入 / **17 个 `wb-*` 原语** / 切暗色卡片背景跟随）；原有 8 条（注册表 / `/api/page` / 宿主渲染无 iframe / 10 张统计卡 + 8 槽位 + 主入口 / 诊断锚点 / 网关未配置如实说）全过。`p3-69` 6/6；`p3-07` 127/131、`p3-36` 9/17 —— **与迁移前完全相同的数字**（§6.9 已归因为假网关注入状态，非本轮）。根守卫全绿；IDE 单测 866 通过 / 9 失败（同前）。

#### 2026-10-22 追加：codebase 迁完（第 4 个）

`@vssaros/dsh-codebase` 0.6.86 → **0.6.88**：

- 类名映射：`cbm`→`wb wb-cbm`、`cbm-bar`→`wb-toolbar`、`cbm-ver`→`wb-sub`、`cbm-cards`→`wb-cards`、`cbm-card`→`wb-card`、`cbm-card-ico/num/label/sub`→`wb-card-ico/num/label/sub`、`cbm-search`→`wb-field-row`、`cbm-link`→`wb-btn is-ghost`、`cbm-section`→`wb-card`、`cbm-section-hd`→`wb-group-hd`、`cbm-count`→`wb-card-sub`、`cbm-empty`→`wb-empty`、`cbm-diag`→`wb-diag`、`cbm-diag-body`→`wb-foot-body`。
- CSS 38 → **26 行**（只留统计卡四色强调、检索控件、节点行、键值对、小节标题）；同样修掉 `--dsw-alias-border-default` / `-label-link` 这两个不存在的令牌。
- **锚点再次改成 `data-*`**：统计卡加 `data-vssaros-codebase-stat`。因为统计卡与"区块卡"现在都是 `wb-card` ⇒ **按类名数会数出 5 张**（迁移当场发生）。这是 memory 那次教训的第二次复现：**机器锚点必须与样式解耦**。

**验证**：沙箱真机 **11/11**（`VsSaros.exe %TEMP%\wb-cb-probe`，仍指向**真图谱**）：新增 3 条（共享样式表注入 / **16 个 `wb-*` 原语** / 切暗色卡片背景跟随）；原有 8 条（注册 / `/api/page` / 宿主渲染无 iframe / **四张统计卡（真实数字）** / **真检索 30 条** / **点结果带依赖**）全过。代码库家族：p3-39 32/32、p3-43 30/30、p3-47 13/13、p3-11 174/177、p3-41 26/28、p3-42 22/23 —— **与迁移前完全相同的数字**（§6.10 已归因为 `search_code` 工具面）。根守卫全绿；IDE 单测 866 通过 / 9 失败（同前）。

**探针侧的两个坑（都是"拿类名当锚点"）**：①根选择器原先写 `.cbm[data-vssaros-page="codebase"]` ⇒ 根类名换成 `wb wb-cbm` 后**页面看起来"没渲染"**（其实渲染了，是选择器没命中）；②统计卡按 `.wb-card` 数会多算区块卡。两处都改成 `data-*` / 属性选择器 ✓。

#### 2026-10-22 追加：kb 迁完（第 5 个）

`@vssaros/dsh-kb` 0.5.48 → **0.5.50**：

- 类名映射：`kbt`→`wb wb-kbt`、`kbt-bar`→`wb-toolbar`、`kbt-main`→`wb-split`、`kbt-pane*`→`wb-pane*`、`kbt-vault`→`wb-select`、`kbt-clear`/`kbt-link`→`wb-btn is-ghost`、`kbt-section-hd`→`wb-group-hd`、`kbt-count`→`wb-card-sub`、`kbt-caret`→`wb-caret`、`kbt-tags`→`wb-chips`、`kbt-tag`→`wb-badge`、`kbt-doc-hd`→`wb-pane-hd`、`kbt-pre`→`wb-pre`、`kbt-ops`→`wb-acts`、`kbt-empty`→`wb-empty`、`kbt-note`→`wb-diag`、`is-danger`→`wb-btn is-danger`。
- CSS 46 → **24 行**（只留文件树行 / 检索命中行 / 正文列 / 新建·重命名输入行）。
- 清掉四个不存在的令牌：`--dsw-alias-border-default` / `-label-link` / `-font-family-monospace` / `-state-focus-primary`。
- **探针锚点改成 `data-*`**（这轮是第三次复现）：新增 `data-kb-file` / `-dir-name` / `-clear` / `-search-form` / `-rename-form`，探针里 8 个类选择器全部换掉（残留 `.kbt` 选择器 0 个）。

**验证**：沙箱真机 **15/15**（`VsSaros.exe %TEMP%\wb-kbprobe`）：新增 3 条（共享样式表注入 / **18 个 `wb-*` 原语** / 切暗色文字色跟随）；原有 12 条全过 —— 宿主渲染无 iframe、两节树（`库` / `笔记`）、**点文件读正文**、**检索命中 2 条**、**新建笔记 / 重命名 / 删除**、**移动到目录（服务端回读一致）**、左右两档。`p3-08` 142/150（同前，工具清单/审批/注入那 8 条）、`p3-17` 38/38；根守卫全绿；IDE 单测 866 通过 / 9 失败（同前）。

#### 2026-10-22 追加：agents 迁完（第 6 个）

`@vssaros/dsh-agents` 0.2.122 → **0.2.123**：

- 通用类 → `wb-*`：`ag`→`wb wb-ag`、`ag-bar`→`wb-toolbar`、`ag-sub`→`wb-sub`、`ag-sp`→`wb-spacer`、`ag-link`→`wb-btn is-ghost`、`ag-tabs`/`ag-tab`→`wb-tabs`/`wb-tab`（`active`→`is-active`）、`ag-table`→`wb-table`、`ag-ul`/`ag-ul-row`→`wb-ul`/`wb-field-row`、`ag-pre`→`wb-pre`、`ag-drawer`/`ag-memview`→`wb-drawer`、`ag-group-hd`→`wb-group-hd`、`ag-search`→`wb-input`、`ag-list`→`wb-list`、`ag-empty`→`wb-empty`、`ag-diag`→`wb-diag`、`ag-pill*`→`wb-badge*`。
- CSS 58 → **30 行**（只留 `ag-item`/`ag-row`/头像/两行信息/事实表/药丸三色）。
- 清掉四个不存在的令牌，并把**写死的药丸色**（`#e0a43a` / `#4C9AFF`）与头像兜底色（`#4C9AFF`）换成语义令牌。
- **探针锚点**：名册行 `data-ag-row`、名字 `data-ag-name`（类选择器清零）。

**验证**：沙箱真机 **20/20**（`VsSaros.exe %TEMP%\wb-ag-probe`，夹具 = 两个真实 agent）：新增 3 条（共享样式表注入 / **18 个 `wb-*` 原语** / 切暗色文字色跟随）；原有 17 条全过 —— 名册 / 搜索 / 抽屉 / **用量·委派·授权三个页签** / **群聊·记忆** / **演化时间线 + 逐行 diff**。Agents 家族：p3-06 98/98、p3-155 73/73、p3-134 19/19、p3-153 26/26、p3-17 38/38；根守卫全绿；IDE 单测 866 通过 / 9 失败（同前）。

**探针小坑**：⑨ 那条最初取 `.ag-item` 判主题跟随 —— 但探针跑完七个页签后停在「演化」，名册行不在 DOM 里 ⇒ 取到 `null`。改成取**常驻的根元素**（`[data-vssaros-page="agents"]`）后通过 ✓。教训：**明暗跟随的取样点要用常驻元素**，别用某个页签里的元素。

#### 2026-10-22 追加：scheduler 迁完（第 7 个，**7 个自有工作台全部统一**）

`@vssaros/dsh-scheduler` 0.2.2 → **0.2.3**：

- 类名映射：`vssSched`→`wb wb-sched`、`vssSchedBar`→`wb-toolbar`、`vssSchedCount`→`wb-stat`、`vssSchedSpacer`→`wb-spacer`、`vssSchedBtn`→`wb-btn`、`vssSchedList`→`wb-list`、`vssSchedTitle`→`wb-row-name`、`vssSchedPill`→`wb-badge`、`vssSchedOps`→`wb-acts`、`vssSchedNote`→`wb-diag`、`vssSchedEmpty`→`wb-empty`；三列行（`vssSchedRow/Main/Rule/Meta`）保留本地。
- **这个包原来是"几乎不用令牌"的典型**（整份只有 **1 个** `--dsw-alias-*`、2 处裸 `#hex`）⇒ 切暗色主题时它基本没跟着变。迁完后颜色全走令牌，真机实测**文字色 `rgb(15,17,21)` ⇄ `rgb(249,250,251)` 跟随** ✓。

**验证**：沙箱真机 **24/24**（`VsSaros.exe %TEMP%\wb-p1-probe`，这是 P1 的样板探针）：新增 3 条（共享样式表注入 / wb-* 原语 / **暗色跟随**）；原有 21 条全过（注册 / `open()` / 宿主渲染零 iframe / 三态渲染 / **compact 顶栏唯一工具栏** / 容器查询）。`p3-97` 9/9；`p3-98` **3/4** —— 失败项是「schedule 服务活着」，**用改动前版本跑同样 3/4、同一条失败**（做过对照实验 ✓）⇒ 预先存在，与本轮无关。根守卫全绿；IDE 单测 866 通过 / 9 失败（同前）。

**两处探针侧调整（都已记进脚本注释）**：① 共享层三条检查最初插在"打开工作台之前"⇒ 页面还不存在、取到 `null`；挪到 `open()` 之后才有效。② scheduler 的夹具是空列表 ⇒ DOM 里只会有少数 `wb-*` 类（list/row/badge 都不渲染）⇒ 探针阈值放到 ≥5，**代码级 ≥10 由守卫 `check-workbench-style.mjs` 保证**。

**7 个自有工作台现在都在共享层上**（`UNIFIED` 白名单 7 项全绿）：workflow 0.8.12、kanban 0.8.13、memory 0.3.93、codebase 0.6.88、kb 0.5.50、agents 0.2.123、scheduler 0.2.3。

**只剩 dashboard** —— 它走的是"静态 app + JSON 岛"、**不注册成工作台** ⇒ 天然不吃这套共享层，永远两套视觉。要么把它改成注册式（能统一），要么在规范里明确它不按工作台契约走。

#### 2026-10-22 追加：`codicon:*` → emoji 映射（把 🧩 那个"假修好"补上）

**问题**：注册表里的 `icon` 按清单规范是**标识符**（`codicon:home`），但 **dsh 前端没有 codicon 字体/CSS**（查过运行时：零 codicon 样式），而启动器/商城的图标体系整体是 emoji（内置 `DEFAULT_ITEMS` 全是 🏠💬🤖…）⇒ 渲染端以前写的是 `icon.length <= 4 ? icon : "🧩"`（按"图标一定是 emoji"的假设）⇒ **我们自己的 8 个入口在启动器/商城列表里全显示 🧩**。

**修法**（`@vssaros/dsh-chat-surface` 0.2.209 → **0.2.211**）：`client.workbenchNav.js` 与 `client.market.js` **各加一张 `WB_ICON_EMOJI`**（20 项）+ `wbIconEmoji(icon)`：

- 表里有的 ⇒ 用映射值（list-tree→🔀 / tasklist|checklist→🗂️ / database→🧠 / type-hierarchy→🕸️ / book→📚 / robot|organization→🤖 / clock→⏰ / home→🏠 …）；
- 本来就是短符号/emoji（非 `codicon:` 前缀且 ≤4 字符）⇒ **原样透传**（保住现有 emoji 用法）；
- 其余（未知 codicon / 空值）⇒ 🧩。

**为什么两张表各存一份**：两个 chunk 之间不能同步 `require`（装载器限制）⇒ 只能复制，由守卫比对**逐字一致**。

**守卫扩项**（`check-workbench-catalog.mjs` 新增第 ④ 组）：
1. 两处 `WB_ICON_EMOJI` **必须存在且逐字一致**（否则启动器与商城显示不同图标）；
2. **每个已注册工作台**（有 `desktopWorkbenches.register` 的包）的 `icon = workbench.icon ?? activityBar.icon` 必须在表里，**且映射值不能是 🧩**（否则等于没修）。

**验证**：`check-workbench-catalog` 绿（20 项映射、8 个已注册工作台全覆盖）；**两次变异都红过** —— ①只从一处删 `clock` ⇒ **同时**报「两处不一致」+「scheduler 图标映射不到」；②两处都把 `book` 改成 🧩 ⇒ 报「vssaros-kb（codicon:book 映射到占位符 🧩）」。另跑一个纯 Node 单测把 `wbIconEmoji` 抠出来验证：自有工作台用到的 10 种图标**全部**映射到非 🧩 的 emoji，emoji 原样透传、未知 codicon 与空值落 🧩。全部根守卫绿、`p3-17` 38/38、IDE 单测 866 通过 / 9 失败（同前）。

**真机验收（补跑，6/6）**：沙箱 exe 改名成 `Saroasis harness.exe` 后跑通。走**页签条**这条路（启动器格子受"用户自定义顺序 + 固定列表"影响，与本次改动无关）：打开 workflow ⇒ 页签显示 **`🔀 Workflow`**（`codicon:list-tree` 的映射值），既没有 `codicon:` 原文、也没有 🧩；同时确认注册表里 8 个 icon **仍是 `codicon:*`**（说明是渲染端映射在起作用，不是把标识符改掉了）。
**探针侧记一笔**：启动器只列**已固定**的工作台，且固定列表 `vssaros.wb.pinned` 存的是 **route**（`/x/workflow/`）不是 `wb:` id —— 想验启动器得先按 route 固定再刷新。

### 6.21 知识库「内容变空」：真因是**注入库被早退丢掉**（2026-10-23，kb 0.5.52）

**现象**（用户 2026-10-23 截图）：工作台「主页 · 知识库」显示 `1 个库 · 0 条索引 · 只读`、`库 0 个文件`、`笔记 0 个文件` —— 而 IDE 侧知识库里有 100+ 篇。

**定位过程**（先证伪"后端坏了"）：

| 检查 | 结果 |
|---|---|
| 真实库结构 `E:\VsSarosVault` | `库` 134 文件 / `笔记` 102 文件 / `.kbkernel.json` 650 KB ✓ |
| 直接跑 `store.listVaultTree('e:\\VsSarosVault')` | 双反斜杠 / 单反斜杠 / 正斜杠**三种写法都是 134 / 102** ⇒ 取数层没问题 |
| `store.listVaults(dev数据根, { external: [注入库] })` | 注入库 `totalDocs=170 docs=170` ✓ |
| IDE 写出的 `~/.vssaros-dev/dsh-run/roots-*.yml` | `kbVaults: '[{"id":"20260922123131-827wo3k",…,"path":"e:\\VsSarosVault"}]'`，三种候选解析**第一种就成功**，路径 `exists=true` ✓ |

⇒ 结论：**数据、注入串、取数函数三者都正常**。真正的问题在 `store.listVaults` 的**早退**：

```js
try { entries = await readdir(root) } catch (e) {
    if (e.code === 'ENOENT') { return { vaults: [], root, missing: root }; }  // ← 这里把注入库一起丢了
}
```

当 `<数据根>/knowledge-base` **不存在**（干净的 dev 数据根很常见）时，函数在合并 `external`（IDE 注入的"内容在别处"库）**之前**就返回空数组 ⇒ 注入库整段消失。而页面此时只剩"扫盘扫到的那 1 个空库"⇒ 正好是截图那三行 0。**沙箱复现**：`vaults: []`（注入串明明解析成功、`injectedNames: true`）—— 与用户现象同源。

**修法**（两处）：

1. **后端** `store.listVaults`：数据根 ENOENT 时**只有没有注入库**才早退；有注入库则 `entries = []` 继续走合并 ⇒ 内容照常出来。
2. **前端** `client.kb.js`（对齐 IDE sideview 的信息密度 + 不再被空库挡住）：
   - **优先选有内容的库**：`activeVault` / 第一个库为空时自动切到有文件的库，并给一句说明（"X 没有文件，已切到有内容的 Y"）；
   - **目录行加条目数**（递归数文件，折叠时也看得出哪层有货）；
   - **文件行加大小 + 按类型区分图标**（md / 图片 / 视频 / pdf / 代码 / 其它）。

**验证**：用**真实库的副本**（`%TEMP%\kb-real`，134+102 文件、650 KB kernel）在沙箱里走 IDE 同形的 `kbVaults` 注入 ⇒ `/x/kb/api/page` 返回 `vaults[0] = { dir: …kb-real, indexed: 211, totalDocs: 170, library.files: 134, notes.files: 102, tags: 198 }`，且 `missing: ""`（以前这里是数据根路径）。修前同一场景 `vaults: []`。已知可用的知识库探针（树 / 正文 / 检索 / 新建 / 改名 / 删除 / 移动 / 共享层 / 暗色）**15/15** 通过；全部根守卫绿；IDE 单测 866 通过 / 9 失败（同前）。

**用户侧要做的一步**：你截图那个实例跑的是**旧版插件字节**（后端早退 + 旧前端）。重启 dev 实例（或重新安装/重建插件）后，知识库应当直接显示 `库 134 / 笔记 102`、索引 170。

**还没做完的部分**（如实）：IDE sideview 的**完整**形态（拖拽分区高度、排序菜单、标签云筛选、富文本渲染、图谱入口）没有搬 —— 这轮只做到"内容能出来 + 行信息对齐"。要完全复刻，建议单独一轮，按 `knowledgeBaseView.ts` 的分区/排序/富渲染逐块对。

### 6.20 主页（dashboard）改**注册式工作台**（2026-10-22，用户拍板方案 1）

> **⚠ 2026-10-23 已下线（用户拍板「执行 2」）**：那一版是**只读网格 + 「编排 ↗」跳旧页**，
> 与模块页 `/x/dashboard/` 形成**两套 UI**（它的工作台卡还是「名字 + `/x/route/`」的一列 `<li>`，
> 用户看到一堆 URL，判定"工作台显示错误"）。现在**只保留模块页**：
> 清单里删掉 `vssaros.workbench` 与 `dsh.client`，删掉 `lib/client.js` / `lib/client.dashboard.js`
> （`files` 21 → 19）。侧栏「主页」仍靠 `activityBar` + `view.kind: page`（`/x/dashboard/`）打开，
> 所以入口没丢。守卫：`p3-46` 新增「只保留一个前端」一条（manifest 不许再声明 workbench / client，
> 两个客户端文件必须不存在，但页面路由必须还在）。
> 下文是**当时**的做法记录，保留以便追溯，**不要再照它加工作台**。


**做了什么**（`@vssaros/dsh-dashboard` 0.4.49 → **0.4.50**）：

| 步 | 落点 | 说明 |
|---|---|---|
| 1. 数据接口 | `lib/index.js`：抽出 **`buildDashboardPayload()`**（汇总 + 组件模型 + 交给客户端的布局）+ 页面路由加 `?format=json` 分支 | **关键是不重复计算**：SSR 页与工作台走**同一次 `resolveLayout()`**（查询参数 → 落盘 → 出厂默认）和**同一份装配**（`summarizeModel` / `sessionRowModel` / `groupByCwd` / `usageBuckets`）⇒ 卡片/文案/计数不会各算一遍 ✓ |
| 2. React 组件 | **新文件 `lib/client.dashboard.js`** | 12 栅格按 `layout.json` 渲染每一项；8 种组件（kpi / diag / sessions / workbench / workspaces / usage / clock / pomodoro）的**只读面**；时钟与番茄钟纯客户端自走；颜色/间距/字号**全走共享层** |
| 3. 入口 | **新文件 `lib/client.js`**（本包原先没有客户端半）+ 清单 `exports['./client']` / `dsh.client.inject` / `files` | 描述符与清单逐字段同值（title / description / activityBar.icon）✓ |

**编排仍在旧页**：拖拽换位 / 缩放 / 增删组件 / 画廊 / 多预设切换还没搬 —— 工作台右上角「编排 ↗」指向旧页，**不假装搬完了** ✓。下一步再搬（落盘的 CAS 写链路 `POST /x/dashboard/api/layout` 已在旧页验证过，可以直接复用）。

**静态验证（已跑）**：`check-workbench-style` **8/8 包全绿**（主页也入列了 `UNIFIED`）；`check-chat-surface-chunks` 绿；`check-workbench-catalog` 绿；**IDE 单测 866 通过 / 9 失败 —— 与改动前同一组**（`dshPluginPackages` 只报 imagegen + parallel 两条，说明**主页的新描述符过了 "description/icon 与清单逐字一致" 那条新守卫** ✓）；`p3-09` **89/89**（重构后 SSR 页的 16 个机器锚点一个没少）；`p3-46` 104/105 —— 唯一失败是「`dataRootOf` 环境变量也没有 ⇒ 默认 `~/.vssaros`」，而 `dataRootOf` 在 `lib/store.js`，**本轮一行没碰**（改的是 `lib/index.js`）⇒ 属既有/环境问题。

**★ 真机验收（2026-10-22 补跑，8/8）**：沙箱 exe 被改名成 `Saroasis harness.exe`（另一个会话品牌化）⇒ 用它跑通了。第一次跑 **3/8**：主页**没进注册表**，控制台报 `client-modules: invalid package-local chunk "client.js"` ⇒ 根因是**入口 `lib/client.js` 多写了一个 `chunk: 'client.js'` 字段**：装载器看到 `chunk` 就按"包内 chunk"校验，而包内 chunk 必须形如 `client.<名字>.js` ⇒ 判非法 ⇒ **整次 web boot `import failed`**（不是"主页坏了"，是把整个 boot 拖下水）。kb / agents / workflow 的入口都**没有**这个字段（入口只声明 `id` + `factory`）⇒ 删掉后 **8/8 通过**。
> ⚠ 教训：**入口里别写 `chunk:`**；写错不是"某页不显示"，而是 `1 entry did not activate` + 全站 boot 失败。

**（历史记录）真机验收曾阻塞**：`.build/electron/VsSaros.exe` 一度不在了（另一会话重建，只剩 dll/pak）⇒ 现已用改名后的 `Saroasis harness.exe` 补跑。原命令：
`node %TEMP%\wb-p1-prep.mjs; node %TEMP%\wb-dash-prep.mjs; node %TEMP%\wb-ctx-prep.mjs; VsSaros.exe %TEMP%\wb-dash-probe`
（探针已写好在 `%TEMP%\wb-dash-probe\probe.mjs`：注册表 / `?format=json` / 宿主渲染无 iframe / **卡片数 == 布局项数** / 共享层注入 / 明暗跟随 / boot 无失败。）

### 6.6 下一个：主页（dashboard）的工作量分析（2026-10-22 记，供下一轮直接开工）

**结论**：主页的工作量**不在 8 种组件的渲染**（`catalog.js` 里 8 个 `render()` 合计只 ~87 行），而在**布局编排引擎**（`pageClient.js` ~1000 行里的那 25 个函数）：卡片拖拽换位、缩放手柄改行高、添加/删除组件、画廊、落盘（`POST /x/dashboard/api/layout`，带 `updatedAt` 的 CAS）、以及**工作台卡片区**（自家 13 个模块 + 第三方卡片 + 固定/打开 + 卡片自身可拖）。⇒ 一次迁完的量级 ≈ 700–900 行 React（含 8 种组件的 React 渲染 + 布局引擎 + 计时器）。

**已探明的落点**（下一轮可直接用）：
- 数据：`lib/index.js` 的 `model`（`summary` / `tally` / `tokenLine` / `toolsRegistered` / `liveServices` / `parts` / `byModel` / `groups` …）⇒ 加 `GET /x/dashboard/api/page`（**与 SSR 页共用同一份 model 装配**，别各算一遍 ⇒ 否则计数会漂）。
- 布局：`<数据根>/dashboard/layout.json`（`lib/layoutStore.js` 读写 + 文件锁）⇒ React 侧落盘走现成的 `POST /x/dashboard/api/layout`（CAS 冲突 ⇒ 整页重载拿最新布局）。
- 组件清单与默认尺寸/配置：`catalog.js` 的 `WIDGETS`（`kind` / `name` / `icon` / `accent` / `defaultSize` / `defaultConfig` / `normalizeConfig`）⇒ React 侧要**复用同一份归一化逻辑**（`normalizeConfig` 逐组件归一，用户填的值也要被纠正后才用 ✓）。
- **工作台卡片区**（`kind: 'workbench'`）：第三方的卡片是**页面侧**从父窗口读宿主注册表补出来的（宿主不知道它们）⇒ React 版同样要读 `window.parent.__vssarosWorkbenchesSnapshot`，并保留「打开 / 固定」两个动作（固定只加到 dsh 侧栏，不进 IDE 活动栏 ✓）。
- 时钟与番茄钟：纯客户端（服务端给初值，客户端自走）⇒ React 里用 `setInterval` 即可。

**没开工的原因**：这一轮已经交付并验收了 workflow 与看板两个迁移（各自 11/11）；主页是剩下 5 个里最大的一个，**做一半比不做更糟**（主页是最常用的页面，半迁移会把它弄坏）⇒ 宁可停在这里、下次整块做。

**剩下 5 个的粗略排序**（按"能不能一次迁完"估）：主页（布局引擎最大，但落点已探明）→ 记忆库（**要先补 JSON 接口**；页面本身是只读快照 + 草稿的提升/丢弃两个动作，UI 不大）→ 代码库（分区 + 图谱 SVG）→ 知识库（最重：38 个 API 路由 + 897 行页内脚本）→ Agents（其实是个多页应用：detail / group / create / memory-evo 四个子页，不是一个工作台）。

**本轮备份**：`refs/backup/workbench-p3-20261022`（整份工作区快照 ⇒ 里面也含别的会话的改动）。


验证：商城自检 106/106（新增 18 条：解包越界拒收、持久目录、兼容判定、Host 回落如实失败、IDE 通道参数、用户拒绝）；宿主自检 27/27（新增会话接口 5 条）；IDE 单测新增 `workbenches.install` 6 条（拒绝不装、参数校验、版本核对、预算）；`check-dsh-ide-capability-decls` 认到 `workbenches` 三关齐备。
沙箱端到端 11/12（`VsSaros.exe %TEMP%\wb-e2e`）：门店选址被判不兼容并在装前拦下、目录卡片带结论；小红书判兼容；无桥回落 Host 时 pnpm 失败**如实** `ok:false` 且不写安装记录；放进 3 个兼容包并重启后都注册进宿主，统一入口打开小红书 ⇒ 页签条在、内容是宿主 View、零 iframe；点「AI 协助」不再报 `newWorkspaceSession is not a function`。**唯一未过**：会话没建成 —— 沙箱 profile 的默认 preset `vssaros-ide` 要 IDE 桥（`agent-preset/invalid … waiting for vssarosBridge`），宿主如实抛错、未写归属；真 dev 实例有桥，需在那里验。
**未验证**：IDE 通道的真实安装（确认框 + `dsh plugin add`）只有单测，没在真 dev 实例跑过。

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
