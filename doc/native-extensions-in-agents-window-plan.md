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
