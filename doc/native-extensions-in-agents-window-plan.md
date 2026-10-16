# Agents 窗口兼容 VS Code 原生扩展（插件）功能 —— 重构设计方案

> 日期：2026-09-15
> 范围：`src/vs/sessions/**`（agents 窗口）+ 少量上游扩展宿主/贡献点适配
> 相关既有文档：`doc/Plugin-System-Architecture.md`（Agent 插件系统）、`doc/Plugin-vs-Extension-Analysis.md`（两种扩展方式）、`doc/marketplace-integration-analysis.md`（自建商城）、`doc/multi-instance-analysis.md`（同类"先定模型再动手"的范式）

---

## 0. 一句话结论

**技术上没有硬阻塞**：agents 窗口的扩展宿主、扩展管理服务全部在跑，`IExtensionsWorkbenchService` 已注册；真正拦住原生插件的是**三道人为的门 + 一个未配置项**：

| 门 | 位置 | 效果 |
|---|---|---|
| ① 执行门 | `extensionManifestPropertiesService.canExecuteOnSessionsWindow()`（`:93-102`）+ `extensionEnablementService._isDisabledBySessionsWindow()`（`:659-678`） | 第三方带代码扩展一律 `DisabledByEnvironment`（用户不可改） |
| ② 视图可见门 | `viewsExtensionPoint.ts:403-421 / :516-551` 注册扩展容器/视图时**不写 `windowEnablement`** + `viewDescriptorService.isEnabled()`（`:348-353`）只认 `Sessions \| Both` | 即使扩展被启用，其视图/容器在 agents 窗口**恒不可见** |
| ③ UI 未装载门 | `sessions.common.main.ts` 未 import `extensions.contribution.js` / `extensionsViewlet.js` / `chat.view.contribution.js` / `mcp.view.contribution.js`（对照 `workbench.common.main.ts:313-314, 221, 224`） | agents 窗口没有任何原生扩展管理 UI |
| ④ 市场未配置 | `product.json` **无 `extensionsGallery`**（全仓 `*.json` 0 命中） | `CONTEXT_HAS_GALLERY=false` ⇒ 原生市场/热门/推荐视图为空 |

因此本方案不是"加一个视图"，而是**四层递进**：统一入口（UI）→ 策略化放行（执行）→ 贡献落地（可见性）→ 市场与分发（生态）。

---

## 1. 先定口径：三种"兼容"成本差 10 倍

| 口径 | 含义 | 依赖的层 | 风险 |
|---|---|---|---|
| **A. 管理面兼容** | 在 agents 窗口能看见 / 启停 / 卸载 / 装 VSIX | L1（+ 部分 L4-R3） | 低（不改执行策略） |
| **B. 执行面兼容** | 第三方带代码扩展在 agents 窗口**真跑**（命令、状态栏、语言特性、MCP、webview…） | L2 + L3 | 中高（启动耗时、内存、崩溃面、安全面） |
| **C. 生态面兼容** | 接市场（官方 gallery 或自建 gallery 协议），一门式搜索安装 | L4 | 高（网络/合规/服务端改造） |

> **必须先裁决**：目标只做 A，还是 A+B（推荐 A → B 分阶段），是否要 C。
> 本文按 **A → B（白名单渐进）→ C（可选）** 给方案，任一层都可独立交付与回滚。

---

## 2. 现状盘清（证据）

### 2.1 已经就绪的部分（不需要改）

- **扩展宿主照常启动**：`sessions.desktop.main.ts:66`（`IExtensionHostStarter`）、`:90`（`IExtensionService` = `NativeExtensionService`），启动时机 `nativeExtensionService.ts:137-142`（`LifecyclePhase.Ready` + `runWhenWindowIdle(50ms)`）。
- **扩展管理服务全在**（agents 窗口）：`IExtensionsWorkbenchService`（`sessions.common.main.ts:380-382` 手动注册）、`IWorkbenchExtensionManagementService`（`sessions.desktop.main.ts:58`）、`IWorkbenchExtensionEnablementService`（`:145`）、`IExtensionGalleryService`（`:144`）、`IBuiltinExtensionsScannerService`（`:146`）、`IAllowedExtensionsService`（`:228, 236`）等。
- 平台层 `IExtensionManagementService` 在共享进程（`sharedProcessMain.ts:363, 435`）经 IPC 可用 ⇒ **不需要**在 sessions 清单补。
- **扩展贡献点的处理链在**：`sessions.common.main.ts:13`（`extensionHost.contribution.js`）、`:82`（`viewsExtensionPoint.js`）、`:86`（fork 的 `agentCapabilitiesExtensionPoint.js`）。
- **纯声明式扩展 + 内置扩展是放行的**：白名单贡献点 `extensionManifestPropertiesService.ts:25-35`（`themes/iconThemes/productIconThemes/colors/keybindings/jsonValidation/localizations/grammars/languages`）；内置扩展恒放行（`extensionEnablementService.ts:665`）。

### 2.2 fork 已有的「扩展 → Agent」两条桥（这是本方案的最大杠杆）

| 桥 | 定义 | 消费方 | 现状 |
|---|---|---|---|
| `contributes.agentCapabilities` | `agentCapabilitiesExtensionPoint.ts:92-103` + 运行时注册表 `:121-278` | `agentStudio.contribution.ts:2919-2942`（`_activateBuiltInPlugins` / `_watchExtensionPointPlugins`）、`:3224-3293`、`:3405` | 代码在，**但仅 `extensions/*-example` 6 个示例扩展声明**（tool/memory/planning/retrieval/execution/kanban），第三方贡献者因门 ① 无法触发 |
| `contributes.chatPlugins` | `agentPluginServiceImpl.ts:852-878`（扩展点）+ `:880-1003`（`ExtensionAgentPluginDiscovery`），注册于 `chat.contribution.ts:3654-3656` | `IAgentPluginService` → Saros「插件」视图 | 同上，第三方扩展贡献在 agents 窗口不触发 |

> 也就是说：**"让扩展成为 Agent 插件来源"这条路已经修好 90%，只差把门 ① 对这两个贡献点打开。**

### 2.3 两套「插件」入口现状

- Saros 自建：容器 `agentStudio.plugins` / 视图 `agentStudio.pluginsView`（`agentStudio.contribution.ts:3550-3558`，`windowEnablement: WindowEnablement.Both`，order 120），实现 `views/pluginsView.ts`（`ViewPane` + `WorkbenchList`，Installed / Marketplace 两 tab），详情 `pluginDetailEditorPane.ts`。
- 上游：容器 `workbench.view.extensions`（`extensions.contribution.ts:115-130`）+ `agentPluginsView.ts`（注册进该容器，`agentPluginsView.ts:639-665`；其 when 依赖 `DefaultViewsContext` / `SearchAgentPluginsContext`）。
- **`DefaultViewsContext` / `SearchAgentPluginsContext` 的唯一写点在 `extensionsViewlet.ts:857-879`（`ExtensionsViewPaneContainer.doSearch()`）** ⇒ 不引入原生容器时，这些 context key 恒为默认值，上游 `agentPluginsView` 的视图 when **恒 false**（静默不显示）。★ 这是本方案最容易踩的坑，已写入 §4.3。

---

## 3. 目标态设计

### 3.1 用户视角（推荐形态）

activitybar 保留**一个**「插件」入口（`agentStudio.plugins`），内部三 tab：

```
插件
├── Agent 插件   （现 IAgentPluginService：skills/commands/agents/hooks/MCP，来源含扩展的 chatPlugins）
├── 扩展         （新增：VS Code 扩展 = 已装/可装，启停/卸载/详情/VSIX 安装）
└── 商城         （现 IMarketplaceService：agent/skill/mcp/knowledge/workflow [+ extension]）
```

- 不引入原生 `workbench.view.extensions` 容器（避免两个"插件"图标并存、避免连带拉入 25 个原生视图与 welcome/onboarding 等无关面）。
- 扩展详情复用 `IExtensionsWorkbenchService.open(extension)`（打开上游 `ExtensionEditor`）——**需要**引入 `extensions.contribution.ts` 的 editor pane 部分，或者自建一个极简详情 pane（阶段取舍见 §4.3）。

### 3.2 分层方案总览

```
L0 策略与开关（设置 + agentsWindow override）           —— 0 风险，先做
L1 统一「插件」入口（三 tab，含扩展管理）                —— 低风险，A 口径即可交付
L2 执行面放行策略（declarative | allowlist | all）       —— 中风险，白名单渐进
L3 扩展贡献可见性（views/容器 windowEnablement + MCP）   —— 中风险，配合 L2
L4 市场与分发（gallery 适配 / VSIX / 商城加 extension）  —— 高成本，需产品决策
```

---

## 4. 逐层实施方案

### 4.0 L0：策略与开关（0.5 天，可先落地）

**新增设置**（注册位置参照 `agentStudio.contribution.ts` 的 `id: 'sessions'` 块，`ConfigurationScope.MACHINE` 或 `APPLICATION`）：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `saros.extensions.agentsWindow.mode` | `'declarative' \| 'allowlist' \| 'all'` | `'declarative'` | agents 窗口的扩展执行策略；`declarative` = 上游原行为（零变化） |
| `saros.extensions.agentsWindow.allowlist` | `string[]` | `['saros.tof-authentication']` | 白名单（支持 `publisher.name` / `publisher.*`），把现有硬编码数组制度化 |

- 使用 `agentsWindow: { default: 'declarative' }`（`configurationRegistry.ts:247-258` 已支持该字段，上游多处已在用，如 `extensions.contribution.ts:167` 的 `extensions.ignoreRecommendations`）⇒ **同一份设置文件，两个窗口默认值不同**，无需额外分支。
- `extensionEnablementService.ts:47-50` 的 `VSSAROS_DISABLED_EXTENSIONS`（copilot 系列）保留为**最高优先级黑名单**，优先于任何 allowlist。
- 回滚：改回 `declarative` 即时生效（enablement 重算；必要时 Reload Window）。

**验证**：新增单测（照 `platform/workspaces/test/electron-main/newWindowMode.test.ts` 的写法，用既有 `run-*-tests.mjs` harness）：默认值 / `agentsWindow` 覆盖 / 非法值回落 / 黑名单优先。

---

### 4.1 L1：统一「插件」入口（1–2 天）

**改动点（全部落在 sessions 侧，不碰上游 UI）：**

1. `views/pluginsView.ts`：Installed / Marketplace 两 tab 扩为三 tab（`_activeTab` 类型加 `'extensions'`）。
2. 新增 `views/pluginsExtensionsTab.ts`（或直接内联）：
   - 数据：`IExtensionsWorkbenchService.local`（`IExtensionsWorkbenchService` 已在 `sessions.common.main.ts:382` 注册，**无需新增任何贡献清单**）；
   - 行 UI：优先复用 `AbstractExtensionsListView`（`extensions/browser/extensionsViews.js`，仅 UI 基类），次选直接 `WorkbenchList` + 自绘；
   - 动作：`enable` / `disable` / `uninstall`（`IExtensionsWorkbenchService`）+ 「安装 VSIX…」→ `IWorkbenchExtensionManagementService.installVSIX({ vsix: URI })`（**不依赖** `extensions.contribution.ts` 的命令）；
   - 详情：`IExtensionsWorkbenchService.open(extension)` 需要 `ExtensionEditor`（上游 editor pane，位于 `extensions.contribution.ts:105-113`）⇒ 二选一：
     - **L1a（省事）**：引入 `extensions.contribution.js`（连带 `extensionsViewlet.js`，见 §4.3 的影响清单），只用于 editor pane + 命令，容器用 `WindowEnablement` 或 `hideIfEmpty` 收掉；
     - **L1b（零连带）**：自建 `ExtensionDetailEditorPane`（对齐 `pluginDetailEditorPane.ts` 的做法，复用 `IExtensionsWorkbenchService` 的 observable）。
3. 与 Agent 插件 tab 的关系：两者同列，用「来源」徽标区分（扩展 / 本地目录 / 商城 / 内置能力）。

**必须遵守的两个现状约束：**

- 若决定引入 `extensions.contribution.js`，**先删掉 `sessions.common.main.ts:380-382` 的手动 `registerSingleton(IExtensionsWorkbenchService, …)`**（`extensions.contribution.ts:92` 已注册同一个服务；`registerSingleton` 只做 `push`，`ServiceCollection.set` 是覆盖写 ⇒ 胜者取决于模块求值顺序，属不确定行为）。
- 若复用上游 `agentPluginsView.ts` 的 `AgentPluginsListView`，必须先解决 `agentPluginsView.ts:40` 对 `VIEW_CONTAINER` 的硬依赖，以及 §2.3 的 context key 写点缺失（见 §4.3 的第 2 条）。

**验证**：探针量 activitybar 图标（**带标题**，不只数量）+ 三 tab 各自的列表行数；`tsgo` 0 错；`transpile-client`。

---

### 4.2 L2：执行面放行（2–3 天，白名单渐进）

**改动点（2 个文件）：**

1. `workbench/services/extensions/common/extensionManifestPropertiesService.ts`
   - `canExecuteOnSessionsWindow()`（`:93-102`）策略化：
     ```
     all       → true
     allowlist → 命中 allowlist（publisher.name / publisher.*）
     declarative（默认）→ 原逻辑
     ```
   - `SESSIONS_WINDOW_ALLOWED_CONTRIBUTION_POINTS`（`:25-35`）增加 `'agentCapabilities'`、`'chatPlugins'`；
   - 放宽「有 `main`/`browser` 一律 false」：改为「有代码时，若 `contributes` 所有键 ⊆ 允许集 ⇒ 放行」——
     **否则 §2.2 那两条桥在 agents 窗口永远不会触发**（capability 插件必须有 `main` 才能被 `import()`；`chatPlugins` 也要求扩展被激活）。
2. `workbench/services/extensionManagement/browser/extensionEnablementService.ts`
   - `_isDisabledBySessionsWindow()`（`:659-678`）改为：黑名单 → deny；内置 → allow；allowlist / 策略命中 → allow；否则 `!canExecuteOnSessionsWindow(manifest)`；
   - 硬编码数组改为读设置（L0），保留注释里的历史原因（tof-authentication 超时问题）。

**副作用与缓解（必须写进评审要点）：**

| 副作用 | 成因 | 缓解 |
|---|---|---|
| agents 窗口启动变慢 / 内存上升 | 第三方 code 扩展激活（扩展宿主已在跑，但激活会拉活模块） | ① agents 窗口默认开 `extensions.experimental.deferredStartupFinishedActivation`（用 `agentsWindow: { default: true }`）；② 默认 `allowlist` 而非 `all` |
| 单个扩展拖死窗口 | 扩展同步重活 / 崩溃 | 复用 `IExtensionService.onDidChangeResponsiveChange` 做提示 + 「禁用该扩展」一键入口 |
| 安全面扩大 | 任意第三方代码进入 agents 窗口 | 已是企业可控：`IAllowedExtensionsService`（`sessions.common.main.ts:228`，对应 `extensions.allowed` 策略）+ workspace trust 链路（`extensionEnablementService.ts:473-475`）保持优先于本策略 |
| 用户困惑"能装却跑不起来" | 装了扩展但策略不开 | L1 的扩展行显示状态徽标（`DisabledByEnvironment / 需要在 IDE 窗口启用`），并在详情页给「在 IDE 窗口打开」按钮 |

**验证**：
- 单测：策略矩阵（declarative/allowlist/all × 有无 `main` × 贡献点集合）、黑名单优先级；
- 真机：设 `allowlist: ['工具类扩展 id']` → 日志搜 `DisabledByEnvironment` 是否消失 / 该扩展命令可用；
- 回归：默认 `declarative` 下，内置扩展与声明式扩展行为**逐字节不变**（对照组跑一遍）。

---

### 4.3 L3：扩展贡献的可见性（2–3 天）

**根因**：扩展贡献的容器/视图注册时**没有 `windowEnablement`**，而 `viewDescriptorService.isEnabled()`（`:348-353`）在 sessions 窗口只认 `Sessions | Both` ⇒ 恒不可见。

**推荐方案 A（按扩展粒度）**：在 `workbench/api/browser/viewsExtensionPoint.ts` 注册处（容器 `:403-421`、视图 `:516-551`）写入 `windowEnablement`：该扩展在 agents 窗口被允许（复用 L2 的同一个判定）⇒ `Both`，否则 `Editor`。

- 优点：不改 `viewDescriptorService` 的全局语义；粒度可控；与 L2 同源。
- **不推荐方案 B**：把 `isEnabled(undefined)` 在 sessions 窗口视为 true —— 会一次性放开所有未标注的容器（含大量内置容器），无法按扩展粒度控制。

**顺带必须处理的三件事**：

1. **context key 写点**：`DefaultViewsContext`（`extensions/common/extensions.ts:257`）、`SearchAgentPluginsContext`（`:263`）、`SearchMcpServersContext`（`:262`）的唯一写点是 `extensionsViewlet.ts:857-879`。若引入原生容器，天然就绪；若走自建视图（L1a/L1b），必须在自己的视图里 `bindTo` 并 `set` 这些 key，否则上游 `agentPluginsView` / MCP 视图的 when 恒 false（**表现为"视图静默不出现"，无任何报错**）。
2. **菜单 gate**：`extensions.contribution.ts:628` 的 menubar 项已带 `IsSessionsWindowContext.negate()`，但 `:630-637` 的 `MenuId.GlobalActivity` 项没有 ⇒ 引入原生贡献后要一并 gate（否则 agents 窗口的全局活动菜单会多出「显示扩展」）。
3. **MCP 视图**：`workbench.common.main.ts:224` 的 `mcp.view.contribution.js` 在 sessions 未引 ⇒ 插件体系里的 MCP 服务器管理面缺失，建议同批引入。

**验证**：装一个声明 `contributes.viewsContainers` + `contributes.views` 的测试扩展（allowlist 放行）→ 探针按**容器标题**断言 activitybar 是否出现该图标；未放行的扩展应仍不可见。

---

### 4.4 L4：市场与分发（需产品决策）

**调研结论（2026-10-12）：dsh 侧没有"官方插件商城"——不存在 DeepSeek 托管的插件商店/目录服务。**
"商城"的角色由**公共 npm 生态**承担。证据全部取自运行时 `poc/dsh-p0/.runtime/0.2.0-rc.2/node_modules/@deepseek-ai/`：

| # | 证据 | 出处 |
|---|---|---|
| 1 | `dsh plugin --profile <name> <pnpm args>` 的口径是 **"通过在 profile 目录中转发给 pnpm 来管理该 profile 的插件"** ⇒ 没有自己的商店协议 | `dsh/lib/bin.js:116`、`dsh/README.zh.md:18` |
| 2 | 包里的"官方"二字指 **npm 官方源**：导出 `OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/'`、`NPMMIRROR_REGISTRY = 'https://registry.npmmirror.com/'`；`fallbackRegistries` 默认 `[NPMMIRROR_REGISTRY]`，README 明说这两个是**公共注册表** | `dsh-plugin-manager/lib/types/registry.js:10,12`、`README.zh.md:52,79` |
| 3 | 安装来源只有四类：**注册表包名 / Git 地址 / tarball / 本地绝对路径**（`inspect()`：注册表包名用 `pnpm view` 问注册表；绝对路径读 `package.json`；git/tarball 只答复自身） | `dsh-plugin-manager/README.zh.md:46` |
| 4 | **没有任何远端插件目录抓取**：全运行时搜 `plugin-catalog / plugin-index / plugin marketplace` 零命中；插件相关包里 `api.deepseek.com` 零命中 | 全量检索 |
| 5 | 插件管理 UI 只有 **安装 / 切换组合包 / 切换行 / 配置 / 详情页扩展点**，**没有"浏览/发现"页**；其 README 里的 `### store` 指**客户端状态仓库**（`PluginManagerController` 的组合包视图、忙碌键、安装进度），不是商城 | `dsh-client-ui-plugin-manager/README.zh.md:38–58,102` |
| 6 | "官方"内容走**随安装包提供**：`dsh.profile.bundles` 从 dsh 安装目录解析（`dsh-base` / `dsh-web-app` / `dsh-headless` / `dsh-sdk-app`…）；`dsh-base/package.json` 里用 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明 | `dsh/README.zh.md:46`、`dsh-base/package.json:31` |
| 7 | `dsh-agent-preset-registry` / `dsh-skill` 里的 "registry" 都是**进程内注册表**（preset / skill **提供方**注册）；`dsh-skill` README 明说来源可以是"本地目录、嵌入式插件数据或**远程服务**"——**扩展点存在，官方没提供这样的服务**（随附的是本地提供方 `dsh-skill-filesystem`） | `dsh-skill/README.zh.md:2,12,32` |
| 8 | 反证：官方包**确实发布在公共 npm 上**（`npm view @deepseek-ai/dsh-plugin-manager` → `0.1.6-alpha.2`，tarball 由 `registry.npmmirror.com` 提供）⇒ 想找官方 dsh 插件 = 去 npm 搜 `@deepseek-ai/dsh-*`，**没有策展/发现层** | 实跑 `npm view` |

**对照我们自己的产品**：界面里的「商城」是 **VsSaros 自己的** `IMarketplaceService`（服务端地址由设置项 `saros.marketplace.url` 指定，默认线上地址）——与 dsh 无关。
⇒ 若要做"dsh 插件的商城体验"，**只能我们自己提供策展/索引层**，落点是既有的五条安装路径（`dsh plugin add <spec>`：npm 注册表 / git / tarball / 本地路径 / 我们的随包目录）。

#### 4.4.1 一页方案：自建 dsh 插件索引层（2026-10-12）

**可落的接口（已核对）**：`IDshPluginCenterHost`（`agentStudio/browser/dshPluginCenterHost.ts`）——
`inspectBundle(spec)` → `IDshInspectResult`、`installBundle(spec, requestId, approvedBuilds?)` → `IDshInstallResult`、
`removeBundle(name)`、`loadBundles()`、`listBundledPlugins()`。**索引层只需产出 `spec` 字符串，不需要新协议。**

| 形态 | 做法 | 代价 | 判断 |
|---|---|---|---|
| **A 清单（零工程）** ✅**已落地 2026-10-12** | 给现有「添加插件」入口喂一份**已策展的 spec 清单**：点「填入并检查」= 填好 spec + 触发既有预检（**不直接安装**：仍要用户看过预检结果后自己点「安装」，不让人一次误点就改 profile） | 无安装逻辑改动 | **已可用**：索引层退化成一份列表（内容来自运行时里真的声明 `dsh.bundle` 的官方包） |
| **B 进我们商城（推荐）** | 在 `IMarketplaceService`（`saros.marketplace.url`）的条目模型加一类 `kind: 'dsh-plugin'`：`spec` / `sourceType`(npm\|git\|tarball\|local\|bundled) / `dshVersionRange` / `checksum` / `publisher` + 展示字段。UI 落在「插件」页签新增来源分组 **「来自商城」**（与其它来源同一套基础件），按钮直调 `installBundle`，进度复用现有 `installState` 状态机（`idle→checking→starting→running→done\|failed`、`cancelling/applying/unconfirmed`） | 索引内容 + 一段渲染 | **我们产品的正解**：复用既有服务与安装链路，**零新增安装协议** |
| **C 自建 registry（重）** | 起一个**兼容 npm registry 协议**的服务（`/-/ping` + packument），配进 dsh 的 `registry` / `fallbackRegistries` ⇒ 用户 `dsh plugin add <name>` 直接装到我们托管的包 | 协议兼容 + 鉴权 + "我们挂了怎么办"（dsh 会顺延到 fallback，等于**悄悄换源**，需产品决策） | 留到"我们要做平台方"时再谈 |

**三条必须写进方案的风险**（都来自 dsh 的现实）：
1. **可信度没有上游兜底**——dsh **不做审批/签名** ⇒ 若把"任意 npm 包名"当默认路径，等于把 npm 当默认信任源。建议：默认只呈现**白名单条目**，"自定义 spec"留在高级入口（现状正是这个形态）。
2. **跨盘符要暂存**——本地路径安装必须由主进程先复制进 profile 再 `dsh plugin add`（我们已踩过 pnpm 跨盘符限制，e2e 里有专门断言）。
3. **失败会留痕**——dsh 明说失败的安装/卸载可能在 `node_modules` 或 pnpm 缓存留下已下载文件，且卸载是**三段**（移出 `dsh.profile.bundles` → 卸载运行时贡献 → `pnpm remove`），失败不继续 ⇒ UI 文案别承诺"完全清理"。

**推荐路线**：先做 **A**（把策展清单接到现有入口，验证需求），需要"发现感"时做 **B**；**C 不做**，除非我们决定自己当分发方。

#### 4.4.2 已落地（2026-10-13）：装 `dshmarket` + 把它的目录接进「插件商城」

**① 装进本项目（dev）**：`dshmarket`（插件 id `dsh-market`，npm 名 `dshmarket`，v1.66.20）——
`pnpm --dir <dev profile> add dshmarket` + 把它加进 `dsh.profile.bundles`（= 启停真源）。
**dev 的 DSH_HOME = `~/.vssaros-dev/dsh-home`，profile = `vssaros`**（`DSH_DEFAULT_PROFILE`；dev 用独立目录避免与安装版争用会话）。
验证：`dsh --profile vssaros --dump-config` **exit 0** 且树里有 `# == dshmarket / - id: dsh-market`；
运行中的 Host **HMR 已热加载**（`GET /dsh-market/status` 带登录 token 返回 **200** ✓，`boot/pnpm:true`）。

**② 目录接进商城**：新增 `browser/dshMarketCatalog.ts`——直接抓 `https://awesome-dsh-plugin.com/plugins.json`
（**该站带 `access-control-allow-origin: *` ⇒ 渲染进程可直接取**；`dsh-market` 自己也是这份数据，只是另一个前端），
按站点真源映射 `{name, owner, npm, version, stars, downloads, category, description.zh, capabilities[]}`；
**安装源优先级与市场一致：npm 优先、否则回落仓库地址**。视图在**「插件商城」网格**里多一段
**「社区插件市场（dsh-market）· 共 N 条」**：按 star 取前 12 条渲染成卡片（复用基础件），
搜索框的词就地过滤；卡片「安装」= 既有 `inspectBundle → installBundle` 链路（**不新开安装通道**），
状态就地显示；读失败时给一行错误 + 重试（**刻意不做内置快照兜底**：目录每天在长，过时答案就是错误）。
实测映射：**4579 条全部解析成功**（与站点 `count` 一致）；其中 **2229 条无 npm** ⇒ 走 git url。

**事实**：`product.json` 没有 `extensionsGallery` ⇒ `extensionGalleryManifestService.ts:86-89` 直接返回 ⇒ `CONTEXT_HAS_GALLERY=false`（`extensions/common/extensions.ts:259`）⇒ 原生 `marketplace / popular / recommendedList` 视图（`extensionsViewlet.ts:326, 258, 273`）全部不满足 when。这不是 bug，是**未配置**。

三条路线（可并行/递进）：

| 路线 | 做法 | 成本 | 备注 |
|---|---|---|---|
| **R3 VSIX 离线安装**（最小可用，建议先做） | 引入 `INSTALL_EXTENSION_FROM_VSIX_COMMAND_ID`（`extensions.contribution.ts:883`）或直接用 `IWorkbenchExtensionManagementService.installVSIX()`；支持拖拽 .vsix 到窗口 | 低 | 企业内网分发最实用，不依赖 gallery |
| **R2 Saros 商城 → gallery 适配**（推荐中期） | 二选一：① 服务端实现 `_apis/public/gallery` 兼容端点（`extensionquery` / `assetbyname`）；② renderer 侧实现 `IExtensionGalleryService` 适配器，把 Saros 商城包映射成 `IGalleryExtension` | 中 | 原生扩展 UI 零改动即可搜索/安装；`PackageKind`（`agentStudio/common/marketplace.ts:20`）需新增 `'extension'`，包格式约定为 VSIX |
| **R1 接官方 VS Marketplace** | `product.json` 增加 `extensionsGallery`（`serviceUrl` / `itemUrl` / publisherUrl…，并按政策填 `canSendTelemetry` 等） | 低改代码 / 高决策 | 需评估对外网络、合规与遥测条款 |

**配套的产品化动作**：把 `contributes.agentCapabilities` 与 `contributes.chatPlugins` 写进对外发布规范（`doc/marketplace-design.md`），让第三方"以扩展形式发布 Agent 能力"成为正式路径——这样「Agent 插件」与「VS Code 扩展」在生态层面真正合流。

---

## 5. 明确不做的事

- 不把 `workbench.common.main.ts` 整体搬进 sessions：welcome / onboarding / userDataSync / nps survey / gettingStarted 等与插件无关的面一律不进（`sessions.common.main.ts` 的手写精选清单是刻意设计）。
- 不让 agents 窗口**默认**执行任意第三方带代码扩展（保持 `declarative`；`all` 只作逃生门）。
- 不在 agents 窗口引入 profile 管理 UI（上游已用 `IsSessionsWindowContext` gate，如 `userDataProfile.ts:196,206,381`）。
- 不为了"少写代码"而改 `viewDescriptorService.isEnabled()` 的全局语义（方案 B 已否决）。

## 6. 落地顺序与验收

| 阶段 | 交付 | 验收 | 回滚 |
|---|---|---|---|
| P0（0.5d） | L0 设置 + 策略枚举 + 现状单测 | tsgo 0 错；新单测绿；默认行为不变 | 改回 `declarative` |
| P1（1–2d） | L1 三 tab 插件中心（A 口径达成） | 探针按标题断言三 tab；能启停/卸载/装 VSIX | 隐藏新 tab |
| P2（2–3d） | L2 策略化放行 + 白名单（先只放 agentCapabilities/chatPlugins） | 白名单扩展在 agents 窗口激活；默认组无变化 | 白名单清空 |
| P3（2–3d） | L3 views `windowEnablement` + MCP 视图 | 放行扩展的容器出现在 activitybar | 去掉 windowEnablement 写入 |
| P4（视决策） | L4 R3 → R2/R1 | `CONTEXT_HAS_GALLERY` / 市场列表条目 | 移除 gallery 配置 |

**三个需要产品/技术裁决的开放问题**：
1. 目标口径是 A、A+B，还是 A+B+C？
2. agents 窗口是否允许**默认**放行 code 扩展（还是永远"白名单 + 逃生门"）？
3. 市场走 R3（VSIX）/ R2（Saros 商城适配）/ R1（官方 gallery）中的哪条？

---

## 附录：关键位置索引

| 主题 | 位置 |
|---|---|
| agents 窗口贡献清单 | `src/vs/sessions/sessions.common.main.ts`（扩展服务注册 `:380-382`）、`sessions.desktop.main.ts:58,66,69-72,90` |
| 执行策略 | `src/vs/workbench/services/extensions/common/extensionManifestPropertiesService.ts:25-35, 93-102` |
| 启用策略 | `src/vs/workbench/services/extensionManagement/browser/extensionEnablementService.ts:47-58, 481-483, 659-678` |
| 视图可见性 | `src/vs/workbench/services/views/browser/viewDescriptorService.ts:340-353, 87`；`src/vs/workbench/api/browser/viewsExtensionPoint.ts:403-421, 516-551` |
| 原生扩展 UI | `src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts:92-130, 620-1327, 2064`；`extensionsViewlet.ts:97-152, 857-879` |
| 上游 Agent 插件视图 | `src/vs/workbench/contrib/chat/browser/agentPluginsView.ts:40, 42, 639-665`；入口 `chat.view.contribution.ts` |
| Saros 插件视图 | `src/vs/sessions/contrib/agentStudio/browser/views/pluginsView.ts`；详情 `pluginDetailEditorPane.ts` |
| 扩展→Agent 桥 | `agentCapabilitiesExtensionPoint.ts:92-103, 121-278`；`agentPluginServiceImpl.ts:852-1003`；消费 `agentStudio.contribution.ts:2919-2942, 3224-3293, 3405` |
| 自建商城 | `src/vs/sessions/contrib/agentStudio/common/marketplace.ts:20, 152-241`；`browser/marketplaceService.ts` |
| 窗口级设置覆盖 | `src/vs/platform/configuration/common/configurationRegistry.ts:247-258` |
| Gallery 配置现状 | `product.json`（无 `extensionsGallery`）；`extensionGalleryManifestService.ts:86-89`；`extensions/common/extensions.ts:259` |

---

## 7. 实施记录

### 2026-09-16 —— L0（策略 + 设置）与 L1（统一「插件」入口）已落地

改动清单：

| # | 文件 | 内容 |
|---|---|---|
| 1 | `src/vs/platform/extensionManagement/common/agentsWindowExtensionPolicy.ts`（**新建**） | 策略纯函数：`resolveAgentsWindowExtensionPolicy()`（宽容解析）、`matchesExtensionPattern()`（`publisher.name` / `publisher.*` / `*`）、`isAllowedToRunInAgentsWindow()`（黑名单 > 必需名单 > 模式判定）；导出设置键与产品级 `BLOCKLIST` / `REQUIRED` 名单 |
| 2 | `src/vs/workbench/services/extensionManagement/browser/extensionEnablementService.ts` | `_isDisabledBySessionsWindow()` 改为调用策略（**默认 declarative = 上游行为不变**）；硬编码名单 `VSSAROS_DISABLED_EXTENSIONS` / `VSSAROS_SESSIONS_WINDOW_REQUIRED_EXTENSIONS` 迁出到策略模块（单一真源）；新增「策略变化 ⇒ 重算 enablement」的配置监听 + 放行带代码扩展时的 `[agentsWindowPolicy]` 留痕 |
| 3 | `src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts` | 注册设置 `saros.extensions.agentsWindow.mode`（enum，默认 `declarative`）与 `saros.extensions.agentsWindow.allowlist`（默认 `[]`），带 markdown 说明与「改后需 Reload Window」提示 |
| 4 | `src/vs/sessions/contrib/agentStudio/browser/views/pluginsView.ts` | 「插件」视图从两 tab 扩为三 tab（**Installed / Extensions / Marketplace**）；新增「扩展」tab：列表（`IExtensionsWorkbenchService.local`）、搜索、启用/禁用、卸载、打开扩展目录、**安装 VSIX…**、状态徽标（含 `DisabledByEnvironment` 的解释性 tooltip）、header 显示当前策略 |
| 5 | `src/vs/sessions/contrib/agentStudio/browser/views/media/pluginsView.css` | 扩展 tab 的卡片/徽标/按钮样式（`.plugins-ext-*`） |
| 6 | `src/vs/sessions/contrib/agentStudio/test/browser/agentsWindowExtensionPolicy.test.ts`（**新建**） | **11 passing**：7 条纯函数（解析宽容性 / 通配 / 三模式矩阵 / 黑名单与必需名单优先级）+ 4 条源码级接线不变量（服务必须走策略且不得退回硬编码、设置已注册、pluginsView 走服务层数据且**未**引入上游扩展视图容器） |

验证：`npm run compile-check-ts-native` → exit 0 无输出；新套件 11 passing；`npm run transpile-client` exit 0，产物核对（`out/vs/platform/.../agentsWindowExtensionPolicy.js`、`pluginsView.js` 含 `_renderExtensions`、`extensionEnablementService.js` 含 `isAllowedToRunInAgentsWindow`、CSS 含 `plugins-extensions-container`）。

### 2026-09-16（续）—— L2：把两条「扩展 → Agent」桥真正接通

问题：两条桥（`contributes.agentCapabilities` / `contributes.chatPlugins`）**代码早就就绪**，但上游规则
「有 `main`/`browser` 一律禁用」让它们在 agents 窗口**永远收不到贡献**（capability 插件必须有 `main` 才能被 `import()`）。
本次把它们按「**Agent 贡献型扩展**」这一概念显式放行。

| # | 文件 | 内容 |
|---|---|---|
| 1 | `platform/extensionManagement/common/agentsWindowExtensionPolicy.ts` | 新增 `AGENT_PROVIDING_CONTRIBUTION_POINTS`（`agentCapabilities`/`chatPlugins`）、`isAgentContributingContributionSet(points, declarativeAllowedPoints)`（**至少一个 agent 点 且 其余全在（声明式 ∪ agent 点）内**）；策略新增 `allowAgentContributions`（默认 `true`，**只有显式 `false` 才关闭**，含手写字面量缺字段的兜底）；`isAllowedToRunInAgentsWindow()` 增第 4 参 `isAgentContributing`（默认 false ⇒ 旧 3 参调用语义不变） |
| 2 | `workbench/services/extensions/common/extensionManifestPropertiesService.ts` | `SESSIONS_WINDOW_ALLOWED_CONTRIBUTION_POINTS` **导出**（单一真源）并加入 `agentCapabilities` / `chatPlugins` |
| 3 | `platform/extensions/common/extensions.ts` | `IExtensionContributions` 补 `agentCapabilities?: ReadonlyArray<IAgentCapabilityContribution>` + 该结构类型（此前该扩展点只有运行时注册、无类型，导致允许集里写它会编译失败） |
| 4 | `workbench/services/extensionManagement/browser/extensionEnablementService.ts` | `_isDisabledBySessionsWindow()` 计算 `isAgentContributing` 并传给判据；留痕带 `reason=agentContributing \| policy`；配置监听覆盖新设置 |
| 5 | `sessions/contrib/agentStudio/browser/agentStudio.contribution.ts` | 注册 `saros.extensions.agentsWindow.allowAgentContributions`（boolean，默认 `true`） |
| 6 | `workbench/contrib/chat/common/plugins/agentPluginServiceImpl.ts` | **顺带修一个 L2 暴露出来的真 bug**：`_promptUninstallExtension()` 原用命令 `workbench.extensions.uninstallExtension`，而该命令由 `extensions.contribution.ts` 注册、**agents 窗口不加载** ⇒ 点「删除」静默失败。改走服务层 `IExtensionsWorkbenchService.uninstall()`（两窗口都已注册），并换成 `ICommandService` → `IExtensionsWorkbenchService` 注入 |
| 7 | `test/browser/agentsWindowExtensionPolicy.test.ts` | **18 passing**（新增 agent 贡献型判定/默认放行/开关关闭/字面量兜底 + 5 条接线不变量，含「允许集必须导出且含两点」「类型必须声明 agentCapabilities」「不得再用不存在的那条命令」） |

验证：`compile-check-ts-native` exit 0；新套件 18 passing；`transpile-client` exit 0；产物核对
（策略产物含 `isAgentContributingContributionSet` 导出与 `allowAgentContributions`、enablement 已接线、设置已注册、允许集含 `agentCapabilities`、卸载已改走服务层且旧命令字符串已消失）。

**默认行为变化（必须知情）**：第三方扩展若**只**贡献 `agentCapabilities` / `chatPlugins`（+ 声明式点），
现在会**默认在 agents 窗口启用**（这是「扩展给 Agent 提供能力」的正式通道，也是本方案的目的）；
`allowAgentContributions: false` 可回到严格上游行为。其余带代码的第三方扩展仍默认禁用。

### 2026-09-16（续 2）—— L3：让扩展贡献的视图/容器在 agents 窗口可见

根因：`viewsExtensionPoint.ts` 注册扩展容器/视图时**不写 `windowEnablement`**，而
`viewDescriptorService.isEnabled()`（`:348-353`）在 sessions 窗口只认 `Sessions | Both`
⇒ 扩展视图在该窗口**恒不可见**（即使扩展已被 L2 启用）。

| # | 文件 | 内容 |
|---|---|---|
| 1 | `workbench/api/browser/viewsExtensionPoint.ts` | 新增 `resolveExtensionWindowEnablement(extension)`：**非 agents 窗口 ⇒ 返回 `undefined`（上游行为一字不改）**；内置扩展 ⇒ `Both`（与 enablement 服务同口径）；其余按**同一策略纯函数 + 同一上游声明式允许集**判定 ⇒ `Both` / `Editor`。在**容器描述符**与**视图描述符**两处写入（判据同源，避免"扩展禁用但视图占着 activitybar"）；注入 `IConfigurationService` / `IWorkbenchEnvironmentService` / `IExtensionManifestPropertiesService`；留痕仅在「非声明式却被放行」时打一次（按扩展去重，避免按视图刷屏） |
| 2 | `test/browser/agentsWindowExtensionPolicy.test.ts` | **19 passing**（新增 L3 接线断言 + **负向**：`viewDescriptorService` 的会话窗口判定必须仍是「只认 `Sessions \| Both`」——钉住"选了按扩展粒度、不改全局语义"这个决策） |

### 2026-09-16（续 3）—— L4：分发闭环（VSIX 直链）+ 市场路线决策

| # | 文件 | 内容 |
|---|---|---|
| 1 | `views/pluginsView.ts` | 「扩展」tab header 新增 **「从 URL 安装…」**：`IQuickInputService` 输入 + `^https?://…\.vsix$` 校验 → `marketplace.downloadToFile`（扩展宿主 Node **流式落盘**，不经 IPC 搬二进制）→ `extensionsWorkbenchService.install()`；本地文件安装重构为 `_pickVsixAndInstall()` / `_installVsixFromUri()` 共用出口；临时文件落在 Saros 数据目录并在安装后清理 |
| 2 | `views/media/pluginsView.css` | header 允许换行 + 计数独占一行（两个安装按钮 + 策略徽标在窄侧栏下不再被挤扁） |
| 3 | `test/browser/agentsWindowExtensionPolicy.test.ts` | **20 passing**（新增 L4 断言：必须走 `marketplace.downloadToFile`、必须校验地址、下载失败即中止、必须走 `IExtensionsWorkbenchService.install`；**负向**：不得自建 `IRequestService` HTTP 通道） |

**市场路线决策矩阵（需产品/服务端拍板）**：

| 路线 | 前置条件 | 谁做 | 现状 |
|---|---|---|---|
| **R3 VSIX**（本地文件 + 直链） | 无 | 客户端 | ✅ **已完成**（本次补齐直链） |
| **R1 官方 VS Marketplace** | `product.json` 增 `extensionsGallery`（serviceUrl/itemUrl…）+ 对外网络 + 合规/遥测条款评估 | 产品决策 + 客户端 1 行 | ✅ **已实施**（2026-09-16，用户决策"接公网商城"，见 §8.2） |
| **R2 Saros 商城承载扩展** | ① 服务端 `kind='extension'`；② 制品 = **VSIX**（不是 tar.gz）；③ `sha256`；④ 客户端按 §8.1 契约改造 | 服务端 + 客户端 | 未做（客户端半边可随时补） |
| **R2' 商城做成 gallery 协议** | 服务端实现 `_apis/public/gallery`（extensionquery/assetbyname）或客户端写 `IExtensionGalleryService` 适配器 | 服务端（工作量大） | 未做 |

**§8.0 「扩展」tab 的搜索框已接市场搜索**（2026-09-16 追加，用户反馈"应该支持从应用商城中搜索"）：

| 项 | 内容 |
|---|---|
| 交互 | 搜索框输入 → 本地**即时**过滤已安装（原行为）+ **防抖 400ms** 后发起市场搜索；结果分三段渲染：`市场结果（N）` / `商城结果（N）` / `已安装（N）` |
| 双来源 ① 原生扩展市场 | `IExtensionsWorkbenchService.queryGallery({ text, pageSize: 20 }, token)`；结果行带「安装」（`install(IExtension)` 重载）。**仅当 `IExtensionGalleryManifestService.extensionGalleryManifestStatus === Available` 才发请求**（否则只给提示，避免必然失败的请求） |
| 双来源 ② Saros 商城 | `IMarketplaceService.listPackages({ q, pageSize: 20, sort: 'popular' })`；复用商城的卡片与安装链路（agent/skill/MCP/知识库/工作流）——**这条今天就能出结果** |
| 时序 | `CancellationTokenSource` + 每次搜索前 dispose ⇒ 旧结果不会覆盖新结果；防抖定时器与 CTS 随视图销毁清理 |
| 未配置 gallery 时 | 顶部提示条：`未配置扩展市场（extensionsGallery）⇒ 只能搜已安装的扩展；可用「安装 VSIX…／从 URL 安装…」，或切到「商城」tab 搜内部资源。`（搜索框占位文案也相应变化） |

⚠ **关键取证（决定"搜索能不能出结果"）**：`extensionGalleryManifestService.ts:86-90` 的 `doGetExtensionGalleryManifest()` 在
**`productService.extensionsGallery?.serviceUrl` 缺失时直接 return** ⇒ 只设 `extensions.gallery.serviceUrl`
（企业私有市场覆盖键）**不足以**开启市场，`product.json` 必须**先**有 `extensionsGallery` 作为基底。
即：要让「市场结果」真正有数据，必须做 R1（或让内网服务实现 gallery 协议 = R2'）。

**§8.2 R1 已实施：`product.json` 接入公网 VS Marketplace**（2026-09-16，用户决策）

写入 `product.json`（顶层，紧邻 `webviewContentExternalBaseUrlTemplate`）：

```json
"extensionsGallery": {
	"serviceUrl": "https://marketplace.visualstudio.com/_apis/public/gallery",
	"itemUrl": "https://marketplace.visualstudio.com/items",
	"publisherUrl": "https://marketplace.visualstudio.com/publishers",
	"resourceUrlTemplate": "https://{publisher}.vscode-unpkg.net/{publisher}/{name}/{version}/{path}",
	"controlUrl": "https://main.vscode-cdn.net/extensions/marketplace.json",
	"nlsBaseUrl": "https://www.vscode-unpkg.net/_lp/"
}
```

为什么是这几个键（**以代码消费点为准**，不是照抄）：
- `serviceUrl` —— **唯一硬要求**：`extensionGalleryManifestStatus` 只看它；`serviceUrl/extensionquery`、`/vscode/{publisher}/{name}/latest`、`/publishers/.../stats` 都从它推出（`extensionGalleryManifestService.ts:44-57`）。
- `itemUrl` / `publisherUrl` —— 详情页 / 发布者链接（`:59-75`）。
- `resourceUrlTemplate` —— 扩展资源（readme/图标）按 `{publisher}.vscode-unpkg.net/...` 加载
  （`extensionResourceLoader.ts:109-126` 用 `format2(..., { publisher, name, version, path: 'extension' })`）。
- `controlUrl` —— 推荐/控制数据（`extensionGalleryService.ts:626`）；缺失只是没有推荐，不影响搜索安装。
- `nlsBaseUrl` —— 仅 web 端内置扩展本地化（`builtinExtensionsScannerService.ts:44-48`），桌面忽略。
- **故意不写** `extensionUrlTemplate`（unpkg 兜底）与 `accessSKUs`（企业 SKU）：前者只在 manifest 缺
  `ExtensionLatestVersionUri` 时兜底，后者与公网无关 —— 少写少错。

**取证（本机实测，非推断）**：
- 配置有效性 + 服务层同源判定已写成回归测试（`agentsWindowExtensionPolicy.test.ts` 的
  「extensionsGallery — 公网扩展市场配置」套件）：拿真实 `product.json` 构造
  `ExtensionGalleryManifestService` ⇒ 断言 `extensionGalleryManifestStatus === Available`
  且 `ExtensionQueryService` 端点 === `<serviceUrl>/extensionquery`。
- 网络可达（curl 实测）：`marketplace.visualstudio.com` DNS→`150.171.73.16`，根路径 **HTTP 200**；
  带 `Accept: application/json;api-version=3.0-preview.1` 的 `POST /_apis/public/gallery/extensionquery`
  返回真实结果（搜 "python" 得 **83KB** JSON，`publisher=ms-python`）✓
  ⇒ 公网市场**可达且可用**（VS Code 自己的 gallery service 发的就是同一个 api-version 头）。

**注意事项（务必知情）**：
1. **需要重启 app**（不是 Reload Window）：`product.json` 在进程启动时由 `bootstrap-esm.ts:33`
   读入 `globalThis._VSCODE_PRODUCT_JSON` ⇒ 只 reload 窗口不会生效。安装版还需把改动带到
   `resources/app/product.json`（重新打包或手工替换后重启）。
2. **两个窗口都受影响**：标准 VsSaros 窗口的原生扩展视图也会因此获得市场搜索/安装能力（这是预期收益）。
3. **遥测**：`resolveMarketplaceHeaders()`（`platform/externalServices/common/marketplace.ts:16-39`）
   只在「产品支持遥测 且 遥测级别=USAGE」时才附 `X-Market-User-Id` / `VSCode-SessionId`；
   否则只发 `X-Market-Client-Id` / `User-Agent` ⇒ 默认（遥测关）不会外发机器标识。
4. **合规**：公网 VS Marketplace 的市场条款对「非 VS Code 产品」的使用有限制（VSCodium 因此默认不接）。
   若将来要换成内网镜像：把 `serviceUrl` 指向实现 gallery 协议（`/extensionquery` 等）的内网服务即可，
   **但 `product.json` 的 `extensionsGallery` 必须保留**（`extensions.gallery.serviceUrl` 设置项只是覆盖，
   没有基底时 `doGetExtensionGalleryManifest()` 会直接 return，见 `extensionGalleryManifestService.ts:86-90`）。
5. **回滚**：删掉 `extensionsGallery` 键并重启 ⇒ 回到「只有 VSIX/URL 分发」的旧状态。

**§8.1 为什么本次没顺手给 `PackageKind` 加 `'extension'`**（结论 + 代价）：

`PackageKind` 是穷举联合，新增成员会**同时波及 5+ 处** `Record<PackageKind, …>` 与 switch：
`marketplaceService.KIND_SUBDIR`、`pluginsView.KIND_LABEL/KIND_ICON`、`marketplaceEditorPane.KIND_LABEL/KIND_ICON/_badgeClass`、
`marketplaceUrlHandler.kindLabel`，以及各 Market editor pane 的 kind 分支；还会牵动**发布链路**
（`publish()` 依赖 `IPackageInstaller.preparePack`，扩展类型没有"本地打包"语义）。
⇒ 应**先定服务端契约**再一次性改客户端，否则会得到一堆半成品分支（商城能显示 extension 包，但发布/升级/详情页行为未定义）。

**服务端（`saros-marketplace`）最小契约（对齐用）**：
1. `kind` 允许值加 `extension`；
2. 版本制品**直接是 VSIX 字节**（`GET /api/v1/packages/{slug}/versions/{version}/download` 返回 vsix，`Content-Type: application/octet-stream`）；
3. 保留 `sha256` / `size`（客户端可校验完整性）；
4. 元数据建议附 `extensionId`（`publisher.name`）与 `engines.vscode`（客户端安装前可提示兼容性）。

**明确未做**：

- **MCP 视图 / 上游 agentPlugins 视图（不改动，附原因）**：`mcpServersView.ts:581` 与 `agentPluginsView.ts:639-665`
  都是把视图注册进**上游「扩展」容器** `VIEW_CONTAINER`，且 `when` 依赖 `DefaultViewsContext` /
  `SearchMcpServersContext` —— 这两个 context key 的**唯一写点**是 `ExtensionsViewPaneContainer.doSearch()`
  （`extensionsViewlet.ts:857-879`）。而 L1 已决定不引入 `extensions.contribution.js`（那会连带 25 个原生视图）。
  ⇒ 单独 import `mcp.view.contribution.js` 在 agents 窗口是**空操作**。要做只能二选一：
  ① 引入 `extensions.contribution.js`（L1b 重路线）；② 在自建「插件」视图里加 MCP 区（推荐，后续可做）。
- L4 的**市场侧**（R1/R2/R2'）：等产品/服务端拍板，契约见 §8.1；客户端分发通道（R3）已完成。
- 真机验证：需 Reload Window 后确认三 tab、扩展列表、启停/卸载/VSIX 安装，`mode` / `allowAgentContributions`
  切换后 `Reload Window` 的真实行为，以及**一个声明 `contributes.viewsContainers` 的扩展是否真的在 agents
  activitybar 出现图标**。日志锚点：`[agentsWindowPolicy] views of extension "…" visible in the agents window`
  （仅非声明式被放行时出现）+ `[AgentCapabilities ExtPoint] Discovered: …` + `[ExtensionAgentPluginDiscovery] Registered plugin: …`。

---

## §9 实施记录：item 样式统一（2026-10-11）

**调研结论**：四个页签（`installed` / `extensions` / `marketplace` / `dsh`）的 item 样式**四套并存**——
`installed` 是 WorkbenchList 行（`.agent-plugin-list-item`）、`extensions` 是 `.plugins-ext-*` 卡片、
`marketplace` 是 `.mp-card-*` **第二套卡片**（与前者近乎同构）、而 `dsh` 页签的 **18 个类名一条 CSS 都没有**
（整套样式写在内联 `style.cssText`，另有 `.plugins-ext-btn.off`、`.ellipsis` 这类悬空类）。
字号 13/12/11/10/9px 五档、圆角 3/4/6 三档、徽标三套、按钮两套、空态四套。

**已做（方案 B 第 1–3 步）**：

1. **token 层 + 基础件**（`views/media/pluginsView.css` 顶部）：
   `--plugins-radius-* / --plugins-font-* / --plugins-gap-* / --plugins-pad-* / --plugins-border / --plugins-fg / --plugins-muted`；
   基础件 `.plugins-card`（含 `.is-market/.is-disabled`）· `.plugins-badge`（+`.is-info/ok/warn/danger/off`）·
   `.plugins-btn`（+`.primary/.is-installed/.danger/.off`）· `.plugins-section` · `.plugins-empty` · `.plugins-notice` ·
   `.plugins-name/-version/-meta/-row-head`。**旧类名以别名并入同一组选择器**，被并入的旧定义已删（约 150 行重复）。
   有意保留的差异：`installed` 行内徽标 11px vs 卡片徽标 10px（行更松、卡片更紧）；版本号仍等宽+链接色。
2. **`dsh` 页签**：新增整段 CSS（`.plugins-dsh-*`，值取原内联值）；「随包模块」段与「添加插件」段**改用基础件**
   （卡片 / 分组标题 / 空态 / 提示条 / 按钮 / 行内件），删掉 **20 处**内联 `style.cssText`；`.plugins-ext-btn.off` 补上定义。
3. **守卫**：新增 `dsh-plugins-view-styles`（`test/common/dshPluginsViewStyles.test.ts`）——
   **TS 里用到的每个类名必须在 `pluginsView.css` 里有规则**（框架类走白名单），另有一条断言基础件/token 在位。
   这条守卫第一次运行就抓出唯一的悬空类 `.ellipsis`（已补）。

**验证**：`--common` 守卫 **269 passing**（含新守卫 3 条）；`tsgo --noEmit` **0 错**；
`out/…/pluginsView.js`、`out/…/media/pluginsView.css` 已随 watch 转译（22:56 / 22:53）；CSS 侧核对：改动前的
**108 个类名一个未丢**、花括号 123/123 配对。

**第 4 步（页签归并 4 → 3）：4a / 4c 已做，4b 待做**

- **4a 去掉独立的 `Marketplace` 页签**：它的搜索与「扩展」页签的**「商城结果」分组完全重复**，唯一独有的是
  "无搜索词时按热度浏览" ⇒ 把两个商城节点（`.plugins-marketplace-status/-grid`）**并入「扩展」页签的列表末尾**
  （同一滚动区，不再有独立容器与第二根滚动条），在**未输入搜索词**时渲染。踩到的坑：`_renderExtensions` 里有
  "没有已安装扩展就 `return`"的早退——**全新 profile 恰恰最需要看到商城**，所以把该分支改成 if/else，商城块放在其后。
  同时删掉 `.plugins-marketplace-container`（CSS 与字段都没了）、`layoutBody` 里的对应高度块、oninput 里的旧分支。
- **4c 文案统一**：页签 `Installed/Extensions/DSH` → **`插件 / 扩展 / 运行时`**（与本视图其它中文串一致）；
  搜索占位符全中文、去掉 emoji（原 `🔍 搜索商城资源...`）；「未配置扩展市场」提示条不再让人"切到商城 tab"。
- **e2e 兼容**：`poc/dsh-p0/scripts/workbench-e2e.mjs:1478` 原来按文案 `'DSH'` 点页签 ⇒ 改为 `['运行时','DSH']`
  都认（旧构建/新构建都能跑，不因改名假红）。

**4f 把方案 B 的运行时断言补进 e2e（2026-10-11）**：静态守卫只能证明"**源码**里长这样"，证明不了"跑起来确实这样"
⇒ 在 `workbench-e2e.mjs` 的插件中心段（`Plugins view opens…` 之后）补 4 条**只读 DOM** 断言：

| 断言 | 证据 |
|---|---|
| 页签恰三个（插件/扩展/运行时、无商城） | `.plugins-tabs button` 的文案集合（4a/4c） |
| 显隐来自 CSS 默认 + 显式激活 | 当前页签容器 `visible`、另两个 `hidden`（4e 的**运行时**证据） |
| 运行时页签 item 走基础件且无内联 | `.plugins-dsh-bundled-row/_bundle` 上**没有 `style` 属性**、且是 `.plugins-card`（4d/4e） |
| 商城浏览与扩展列表同一滚动区 | `.plugins-extensions-list` **后代**里有 `.plugins-marketplace-grid`、且 `.plugins-marketplace-container` 已不存在（4a）；断言完切回「运行时」 |

**一条操作事实（本轮才想清楚，值得记）**：e2e 的三源指纹是 **`src/vs` / `dsh-plugins` / `out/`** ⇒ 并行那线在跑 harness 时，
我改这三个地方的**任何**文件都会让它的读数作废（本轮前几步的守卫/CSS 改动就有这个副作用）；只有 **`poc/`**（探针、脚本、README）不在指纹里
⇒ **想在不打扰别人的前提下干活，就写 `poc/`**。本节的 4f 正是这么做的。

**4b 第 1 步已做（2026-10-11）：插件页签从 WorkbenchList 换成 DOM 分组列表**

**换法（关键：换承载、不换外观）**——行外观一行没改：`.agent-plugin-list-item` 本来就**自洽**（flex + padding +
hover + cursor，不依赖 `.monaco-list-row`），所以 DOM 版**复用 `PluginListRenderer` 的 `renderTemplate` /
`renderElement`**（同一个模板、同一份 Action 装配），只是把"由列表承载"改成"由 DOM 容器承载"：

| 删掉 | 补上 |
|---|---|
| `PluginListDelegate`（定高 72 + 单模板 id）、`PluginListAccessibilityProvider`、`PLUGIN_LIST_ELEMENT_HEIGHT`、`WorkbenchList` import | 语义化角色：宿主 `role=list`、行 `role=listitem` + `aria-label`（拼法与旧 provider 一致） |
| `layoutBody` 里**懒创建列表**的 72 行（含 selection→详情编辑器、autorun→splice 两条接线） | 构造里的 autorun（数据/搜索变化重绘）+ `_renderInstalledTab` / `_renderPluginRow`；`_switchTab('installed')` 也重绘 |
| 列表自带的滚动 | 容器自己滚（`.plugins-list-container` 改 `overflow-y:auto`） |

**分组判据**：插件接口里唯一可靠的"来源"是 **`IAgentPlugin.fromMarketplace`**（`uri` 前缀随安装位置变、不能当来源）
⇒ 两段：**本地与内置** / **商城安装**（段标题用基础件 `.plugins-section`，与其它页签同一套）。

**顺手去掉一个副作用**：列表时代点行内**动作按钮**也会冒泡成"选中"⇒ 顺带把详情弹出来；DOM 版显式排除
（点 `button` / `.monaco-action-bar` 不算打开详情）。**防泄漏**：整层重绘前逐个 `disposeTemplate`（ActionBar / 动作）。

**验证**：`--common` **277 passing**（守卫第 7 条锁住这一换法：不许再出现 `WorkbenchList` / `IListVirtualDelegate`、
必须有 `_renderInstalledTab` / `_renderPluginRow` / `fromMarketplace` / 新容器 CSS）；`tsgo --noEmit` **0 错**；
`read_lints` **0**；`out/…/pluginsView.js|css` 已转译（含新代码）。

**★ 已获真机证据（2026-10-12，`poc/README` 4.P35）**：一轮**指纹干净**的 e2e（`88/95 passed`）里，
方案 B 的 **4a/4c/4d/4e + 4b 共 6 条断言全 PASS**，其中 4b 读出 `host role=list / rows:2 / items:2 / monacoRows:0 /
sections:["本地与内置（2）"]` ⇒ **DOM 分组列表真的跑起来了，行内 markup 与列表时代一致**。
（本轮为拿到它，先修掉我自己 3 个探针 bug：等待条件没等渲染、`.monaco-list-row` 没限定范围、页签选择器把「运行时」的段按钮也算进来了。）

**4b 第 2 步的提案（待决策，2026-10-11 写出来好让你一眼定）**

| | 现状 | 方案 B 的目标态 |
|---|---|---|
| 「插件」页签 | VsSaros 侧插件（现在分「本地与内置 / 商城安装」两段） | **所有插件的统一入口**，按来源分组：本地与内置 / 商城安装 / **随包模块（dsh）** / **已安装组合包** / **官方随附** |
| 「运行时」页签 | 状态条 + 4 段（随包模块 / 官方 / 已安装 / 添加插件） | 只留 **状态条 + 「添加插件」段**（按 spec 装） |

**代价（必须一起做）**：
1. 5.16 批次 2/3/4 的入口**搬家**（用户习惯变）；
2. `workbench-e2e.mjs` 里 **3 处按段名点击**（`随包模块` / `官方` / `已安装`）+ **1 处 `p.segs.length === 4`** 要改（改成"运行时只剩 2 段"，清单断言改到插件页签做）；
3. dsh 的行有**行级启停 / 卸载 / 安装**等动作（`IDshPluginHost`）⇒ 两套数据（插件服务 + dsh Host）要并进同一个列表的渲染层（我刚做的 DOM 版正好能容纳自由高度的卡片）。

**更小的一步（推荐先做这个）**：只把**「随包模块」**搬过去（它最常用：一键装随产品分发的模块），官方 / 已安装留在运行时 ⇒ 只动 1 处 e2e 段名断言，风险与收益比最好。

**✅ 结论：这一小步已做（2026-10-12，按上面的推荐）**。实现要点：

- **挪的是「随包模块」段**（`_renderDshBundledSegment` → 改成可指定渲染目标的 `_renderBundledInto(target, query, forInstalledTab)`）⇒ 「插件」页签的 DOM 分组列表末尾多一段 **「随包模块插件」**（同样的卡片、同样的「安装 / 已安装 / 升级」按钮）；
- `DshMarketSegment` 去掉 `'bundled'`（**'official' | 'installed' | 'add'**），运行时页签默认段改为 **官方**，段切换条 4 → **3**；
- 这条链**不依赖 Host 运行**（读随包目录 + profile 清单）⇒ 插件页签在 Host 没起来时也能列出并安装；
- 数据惰性加载：首次进插件页签踢一次 `_loadBundledForInstalledTab()`（`_dshBundledLoading` 与运行时页签共用同一份，避免重复读盘）；
- 文案：插件页签里的说明不再指"上面的重启 Host"（那里没有那个按钮），改成指「运行时」页签。

**验证（2026-10-12，指纹干净的一轮）**：`88/95 passed`，其中
`runtime tab has three segments and the bundled module plugins render in the plugins tab` **PASS**、
`bundled list carries the shipped modules (mcp / codebase / kanban) each with a state or an action button` **PASS**、
官方 / 已安装 / 添加插件三段 **全 PASS**、**方案 B 那 6 条断言无回归**（仍全 PASS）。
剩余 7 条红与上一轮**逐条相同**（chat surface 的 preset chip、`DSH tab toggle`、kanban already-installed 级联）⇒ 非本次引入。

**✅ 结论（2026-10-12，按用户要求"全搬"）**：剩下的**三段也全部搬走** ⇒ 「运行时」页签彻底不再有段切换条。

| 页签 | 现在的内容 |
|---|---|
| **插件**（统一入口） | 本地与内置 → 商城安装 → **随包模块** → **已安装组合包** → **官方随附**（全部走同一套基础件；来源判据：`fromMarketplace` / `dshHost.listBundledPlugins` / `listBundles`） |
| **扩展** | 已安装扩展 + 商城浏览（同一滚动区） |
| **运行时** | 状态条（运行中 N/M · HMR · 重启 Host）+ **运行态现场清单（启停开关）** + **添加插件入口** |

实现要点：`_renderDshBundleCard(target, b, kind)` 改为可指定渲染目标（两段现在渲染进插件页签的 DOM 列表）；
`DshMarketSegment` / `_dshSegment` / `_dshSegmentEl` / `_renderDshSegments` **全部删除**（段条取消）；
「添加插件」入口**常驻渲染**（不再需要切段）；死 CSS（`.plugins-dsh-segments*`）一并删除；
守卫补 3 条（不许再出现段机制 / 组合包卡片必须可指定目标 / 插件页签必须渲染那两段）。

**e2e 同步改了 5 处**：段条断言改为"不存在"（`segBars === 0`）、官方随附与已安装组合包改读插件页签、
现场清单留运行时（同一条断言里同时核对两者）、添加插件入口两处去掉"点段"步骤。

**静态验证**：`node --check` + 片段检查器（51 片段 / 0 错 / 0 内含反引号）✓、`read_lints` 0、
`--common` **302 passing**（守卫 7 条）✓、`tsgo` 只剩**并行那线**的 1 处错（`dshActivityBarSource.test.ts:102`，非本视图）。
**真机验证这次没等到窗口**（这一小时并行那线一直在跑 e2e / 改 `src/vs/…/dshHarness/*`，两次运行都在写 JSON 前被中断；
两次 `--wait` 累计约 40 分钟未拿到 10 分钟静默）⇒ 判据脚本随时可用，一满足即跑。

**4b 第 2 步（历史：当时未做，需产品决策）**：把「运行时」页签的三块清单**搬进**插件页签 ⇒ 会**掏空刚做好的 5.16 批次 2/3/4 段**，
而 e2e 现有断言是按那 4 段写的（`segs.length === 4`、按段名点击）⇒ 不是纯技术改动，**故意没做**（等确认 IA）。

**★ 同时纠正一个误判（重要）**：我此前把"`harness=1`"读成"并行那线在跑 e2e"，并据此**连续几轮不跑 e2e / 不做 4b**。
实际那条命中的是**开发 watch 进程**（`npm-run-all watch-client-transpile …`，10:14 就起了）——我的正则
`workbench-e2e|run-all` 被 **`npm-run-all`** 假命中。⇒ **判据要按"进程名 + 参数"双重确认**（`Temp\vssaros-*` 实例数为 0
就说明没有 e2e 在跑）。真正拦住 e2e 的从来只是**三源指纹不稳定**（这一小时里是并行那线在改 `dsh-plugins`）。

**4b（历史记录：待做时的判断，需要真机）**：「插件」页签现在仍是 **WorkbenchList**（虚拟列表 + 单模板渲染器），而方案 B 要求它
按**来源分组**（随包模块 / 本地目录 / 商城 / 官方随附）并把「运行时」页签里的清单搬进来——那意味着**把
WorkbenchList 换成 DOM 分组列表**（与「扩展」页签同一套渲染），顺带消掉最后一种渲染机制。这是渲染机制替换，
编译期看不出来，**必须先有 Reload Window / e2e 的验证窗口再做**（当时并行那线的 harness 一直在跑）。

**4d 收尾（同轮）**：`_renderDshBundleCard`（官方随附 / 已安装**组合包卡片**）也换成基础件
（`.plugins-card` / `.plugins-row-head` / `.plugins-name` / `.plugins-version` / `.plugins-badge` + `.is-ok/.is-off`，
错误文字用新的 `.plugins-error`）⇒ **「运行时」页签整套 item 不再有任何内联样式**，stage 2 收尾。

**4e 内联样式清零（同轮）**：视图里最后 4 处静态 `style.cssText`（扩展容器 / 运行时容器 / 段切换条 / 侧栏小标题）
全部搬进 `pluginsView.css`（那些规则本来就存在，值逐条比对过）⇒ **本视图不再有 `style.cssText`**。
留下的 10 处 `.style.x = 值` 都是**动态**的（按页签切 `display`、`${listHeight}px` 高度），必须留在 TS。

⚠ **两条必须成对记住的约定**（否则页签直接显示不出来）：
1. `_switchTab` **只在点击时调用、构造时不调** ⇒ **初始隐藏的唯一来源是 CSS 的 `display: none`**；
2. 所以激活时**必须给显式值**（`'flex'` / `'block'`）：写 `''` 会清掉内联后**回落到 `none`**。
   守卫用断言把这对约定钉住，而不是只写注释。
3. 另：`.plugins-extensions-container` 原本内联的 `overflow-y:auto` **覆盖**了 CSS 的 `overflow:hidden`
   ⇒ 收敛时按"容器自己滚"的既有事实写成 `overflow-x:hidden; overflow-y:auto`（**不能照抄 CSS 的旧值**）。

**守卫升级**：`dshPluginsViewStyles.test.ts` → **`dshPluginsView.test.ts`**（视图**源码契约**守卫，6 条）：
类名有样式 / 基础件在位 / **页签恰好三个（插件·扩展·运行时）** / **默认隐藏 + 显式激活（无 `style.cssText`）** /
**占位符不许再有 emoji 转义**。
**两次假红都是同一类**：断言"代码里不许再出现某名字"会把**注释**里的引用也算进去（解释"为什么删掉 marketplace"时
引用 `"Marketplace"`、解释"不再有 `style.cssText`"时引用它本身）⇒ 统一抽了个 `codeOnly`（滤掉 `*` / `//` 开头的行），
所有负向断言只喂它。

**验证（4a/4c/4d/4e + 守卫）**：`--common` **272 passing**（新守卫 6 条）；`tsgo --noEmit` **0 错**；
`workbench-e2e.mjs` 语法检查通过；`read_lints` 0；全仓检索无其它地方断言旧页签名。

**§9.1 4b 的两个候选设计（下次带验证窗口时执行，二选一）**

- **A. 保留 WorkbenchList，走多模板**：用 `IListVirtualDelegate.getTemplateId/getHeight` 给列表加
  `section`（分组标题行）与 `bundle`（组合包卡行）两种模板，行元素类型改成联合类型，再把 `IDshPluginHost`
  的异步数据（随包模块 / 官方 / 已安装组合包）并进同一个 observable。**优点**：保留虚拟化与无障碍 provider，
  是上游「扩展」视图的既有做法（`Installed` / `Recommended` 分组就是特殊行）。**代价**：渲染器要拆三份、
  动作要改成 `ActionBar` 的 Action（现在是 DOM `<button>`）。
- **B. 换成 DOM 分组列表**（与「扩展」页签同一套渲染）：**理由**是"统一渲染机制"本身就是这次工作的目标，
  且插件数量很小、「扩展」页签已经在**无虚拟化**地渲染上千张商城卡片。**代价**：失去列表虚拟化与
  `IListAccessibilityProvider`（需用语义化标签 + `aria-*` 补齐），`layoutBody` 的高度计算要重算。

倾向 **B**（一致性收益 > 虚拟化收益），但两者都要**先在真机 Reload 或 e2e 窗口里看**——它是渲染机制替换，
编译期与静态守卫都看不出来。
