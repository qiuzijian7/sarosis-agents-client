# VsSaros：基于 Better Sidebar 的三栏布局重构方案

> 文档状态：**【计划·提案】**，2026-11-19。本文不是工作台开发规范。
> 本轮交付：交互 HTML + 源码核对后的重构方案；**未修改生产布局、未安装或重启 Harness**。
> 效果稿：`doc/layout-mockup/dsh-sidebar-layout.html`（无外部依赖，可离线打开）。
> 实施遵循唯一流程源 `doc/workbench-development-standard.md`；承载规范变更须同步其生成副本与随包技能，不再建立第二套规范。

## 1. 目标与确定的交互

| 区域 | 目标 | 不允许发生 |
| --- | --- | --- |
| 左栏 | 工作区、会话列表、新会话、官方设置；保留品牌和回 IDE | 再出现“主页”面板入口；工作台打开后把左栏切成另一套导航 |
| 中栏 | 官方会话聊天窗口，消息流、工具卡、输入框与模型选择 | 中栏工作台页签条、主页页、业务面板；点击工作台把聊天卸载或挪到右栏 |
| 右栏 | 原生右 Sidebar；“开始”页内容变成现有 VsSaros 主页；工作台、文件、图片、工具资源各自在右页签展示 | 两个 guide 接管者；从主页打开工作台时替换或关闭开始页 |
| 目录 | 所有已启用、可导航的工作台页面自动进入主页；新增/卸载/启停同步 | 向主页与导航分别追加固定名单；自动恢复已下线业务 |
| 点击工作台 | **每次点击新建一个右侧业务页签**；开始页保留，当前中栏会话不变 | 仅设置 `single:false` 就误以为是多实例；依赖全局 `active` 决定实例归属 |
| 图片/文件 | 原生工具卡保持内联；点击资源另开右预览，同一资源可聚焦已开实例 | 所有资源强制 CodeMirror；把 `@image:` 当成图片生成工具；从文件名猜附件 ID |

本提案默认不自动恢复 `OFFLINE_WORKBENCH_ROUTES` 或隐藏内部页。工作台“每个页签”指可导航业务页；隐藏 diff 等内部载体不转成主页卡片。仅适合底部的 `terminal-bottom` 不伪装成右栏 tab，主页使用宿主原生终端入口。

“开始”是常驻的产品主页入口：打开业务后仍可一键回到它。若宿主 guide 可由用户关闭，则下一次点击“+ / 开始”恢复唯一主页实例；不得靠改写宿主私有 DOM 强制禁止关闭。

## 2. 本轮原型的范围

HTML 使用 DSH 0.2.2-rc.2 的表面/文字/边框语义：中性深底、低对比描边、圆角卡片、系统字体，参考用户提供的右栏卡片截图；少量色彩用于文件、终端和状态，未采用营销式渐变/大面积彩色 UI。

可验证的交互：

1. 右侧默认“开始”：搜索/分类 + 常用工具 + 工作台目录；不展示欢迎标题、说明、统计或最近资源。
2. 搜索/分类；打开知识库、记忆、代码库、媒体库、商城、历史会话、自动化任务、SuperAgent 示例业务页。
3. 重复点击同一工作台创建多个右侧实例，关闭和切换都不改中栏聊天。
4. “模拟新增工作台”一次加入“概览 / 数据表”两个**已声明**子页；注销后入口消失，已开页显示不可用。
5. 左侧两个会话各自保存页签与输入草稿；图片资源按会话展示。
6. `@image:image.png` chip 和 `read_image` 工具卡均可打开右侧预览；资源失效/重试、向中栏草稿添加引用。
7. 明暗主题、拖动/键盘调整右栏宽度、Tab 键/箭头键切换右页签、小屏抽屉。
8. 开始页没有“最近资源”；工作台卡片的常显锚点支持鼠标/触屏拖拽和键盘双轴排序、取消，位置会被保存。常用工具末尾的紧凑“更多”行打开锚定菜单，包含“浏览更多插件 / 创建你的插件 / 调整顺序”；区标题保留“全部工具”入口用于搜索和打开已有工具。
9. 菜单右边缘对齐触发器，空间不足向上展开；点击外部、失焦、Escape 关闭并正确恢复焦点，支持上下方向键导航。浏览进入右侧商城示例页；“创建你的插件”切到中栏主会话，填入 `创建一个带右侧栏入口的 DSH 插件。`，显示“创造模式”，不弹表单、不生成预览卡片、不自动发送；调整常用工具顺序提供上移/下移、完成保存、取消恢复。

效果稿仅用自己的 `vssaros-layout-mockup:workbench-order:v1` 与 `vssaros-layout-mockup:tool-order:v1` localStorage 键分别保存工作台和常用工具顺序，不读取或写入任何生产布局键。排序是全局主页偏好，跨会话共享；页签与聊天草稿仍按会话隔离。正式版应迁到已有 Host 设置的版本化排序字段，采用修订号 CAS 更新，不能直接沿用这个原型键。

所有数据和业务页为**演示占位**。示例图片是内嵌 SVG，不是工作区真实 `image.png`；不读取本地文件、不生成 attachmentId、不调用模型、不启动终端、不访问外部站点。原型的内存 Map 不等于生产持久化方案。

## 3. 已验证的源码事实

### 3.1 工作台不是单一入口

| 实际入口 | 当前文件 | 关键问题 |
| --- | --- | --- |
| 注册式 React | `dsh-plugins/vssaros-workbenches/lib/client.js`：`register`、`getSnapshot`、`View` | 快照不给组件；`View` 套完整 `Frame`，可能带第二个聊天；`open` 调 `layout.selectPanel` 会替换中栏 |
| 路由式主页/业务 | `dsh-plugins/vssaros-dashboard/lib/catalog.js`；同包 `lib/index.js`、`lib/app/src/app.jsx` | 主页 `WorkbenchCard` 合并静态目录和父窗口工作台，3 秒复查；点击仍走旧 `vssaros-wb-open` 或 `__vssarosOpenWorkbench` |
| 组件式 | `dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js`；`window.__vssarosPageComponents` 的现有记忆登记 | 记忆不存在独立 `/x/memory/` 页面，必须复用组件；仅扫 SSR 路由会产生假入口 |
| 生命周期 PageView | `vssaros-workbenches/lib/client.js`：`registerPageFrame`、`PageView` | `pageFrames` 不在公开 `workbenches` 快照；它是挂载后产物，不能用来发现尚未打开的业务页面 |

现有主页是 Dashboard 实现，不是 Bot 的 `home.js`。重构必须复用主页的数据整形和业务内容，删除的是重复入口与外壳，不是主页业务本身。

### 3.2 现有中栏布局占用

`dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js` 中：

- `sidebar.panellist` 的 `vssaros-workbench` 条目提供左侧主页。
- `ensureTab` / `TabStrip`、`shell.overlay` 和中心列 32px 顶部补偿提供旧中栏页签。
- `openRegisteredWorkbench` / `openArbitraryPage` / `openWorkbenchTab` 与全局打开函数会选择中栏 main panel。

`dsh-plugins/vssaros-workbenches/lib/client.js` 中：

- `Frame` / `SplitConversationPane` / `ConversationMount` / `makeConversationDock` / `DOCK_SLOT` 提供工作台内部对话或停靠。
- `ownerId()` 与工作区选择依赖全局 `active`，不是多实例右栏上下文。

因此“隐藏页签条 CSS”不足以迁移：会话引用、路由、旧页签存档、main panel 打开链路仍会占用中栏。

### 3.3 Better Sidebar 的真实契约

发布基线：`dsh-better-sidebar@0.32.1`，本仓已 vendored，但上一轮未完成真实 profile/UI 验证。

公开声明：`dsh-plugins/dsh-better-sidebar/lib/types/client/service.d.ts`。

- `registerTab(descriptor)` 返回注销函数；`subscribe` / `getTabs` 订阅类型注册表。
- `TabDescriptor.createTab(state)` 是描述符工厂，**不是**服务上的方法；提供工厂才触发原生面的“每次新实例”。
- 组件 props 是 `ctx / store / scope / tab / visible`；导航参数可存入 `tab.meta`。
- `openTab(seed, scope)` 支持 `type / title / id / meta / target / reveal`；`target:'side'` 代表新 pane，不是普通右侧新 tab，不能误用。
- `src/client/service.ts` 原生分支的 `revealIfOpened` 主要由 `createTab` 是否存在决定；自定义 `dedupeKey` 不参与这条分支的去重。
- `src/client/native/guide.tsx` 现有点击会 `replaceTab:true`，随后 `close()` guide，不符合本次目标。
- `src/client/native/index.ts` 默认接管 `sidebar.right.tab.guide`，`guideTakeover:false` 才释放。
- `src/client/native/guide-catalog.ts` 订阅官方 `sidebarRightTabs.guide()`；仅调用 Better Sidebar 的 `getTabs()` 会漏掉官方终端等入口。
- `src/client/native/index.ts:363–374` 的开始页 `onCreatePlugin` 取 `uiWorkspace`，调用 `startSession(undefined, { agentPreset: 'cordis', prompt: t('guideCreatePrompt'), whenDraftExists: 'append' })`；`src/client/locales.ts` 的中文提示词为 `创建一个带右侧栏入口的 DSH 插件。`（带句号）。`cordis` 在 DSH 0.2.2-rc.2 预设表里显示“创造模式”。官方 `uiWorkspace.startSession` 以显式/当前主会话/最近工作区解析工作区，可能复用匹配 preset 的空白会话，通过 `layout.selectPanel(null)` 显示中栏，并用 `conversation.input.requestDraftInitialization` 准备（而非发送）草稿；`append` 在已有草稿后追加新段落。

本方案不改 vendored 源码字节。集成适配与必要的服务扩展放在自家插件层，并明确区分现有 API 和拟新增 API。

## 4. 目标架构：单目录、单主页、单对话

数据流：

**已激活插件的声明/注册 → 工作台统一目录 → Better Sidebar tab 适配 → 右栏主页卡片 → 新建右 tab → 业务渲染器**。

中栏始终使用官方 conversation factory，右页只提供业务内容；主会话会持续运行，不因业务页隐藏而暂停。

### 4.1 统一目录（拟新增能力，当前不存在）

建议在自有 `vssaros-workbenches` 服务里新增以下接口，名称以实施时类型定义为准：

| 提议接口 | 职责 |
| --- | --- |
| `getCatalogSnapshot()` / `subscribeCatalog()` | 已激活可用页面、不可用原因、版本修订号；包括注册式、声明式路由与组件式 |
| `registerPage(descriptor, renderer)` | 路由/组件业务页登记；在激活期登记，不等打开后才登记 |
| `renderBusiness({workbenchId,pageId,scope,instanceId,visible})` | 实例化业务内容，不含中栏选择、完整 Frame 或 conversation portal |
| `forInstance(scope, instanceId)` | 有界工作台 service facade；所有写操作针对实例上下文而不是全局 active |

每个目录条目至少包含：`workbenchId / pageId / title / description / icon / sourcePackage / kind / enabled / hidden / retired / availability / renderHandle`。

身份规则：使用现有稳定工作台身份（`vssaros/<module>`、`local:<包名>`、公开仓库身份），加稳定 `pageId` 构成条目主键。Better Sidebar 类型 ID 使用单一前缀和无歧义编码；不能用显示标题、数组序号或 route 猜身份。

**当前工作台：** `register(descriptor, Component)` 默认生成一个 `pageId:'default'` 目录页，不要求批量修改外部插件。现有 route/组件页迁到统一 `registerPage`。历史固定清单可做一次性兼容读取，但不能保留新旧两份长期真源。

**多页签工作台与后续新增：** 描述符可选 `pages`（拟新增）为每个可导航子页声明稳定 pageId 与渲染/路由。一次插件登记自动产生多个目录项。不能从组件 DOM 按钮或临时 mounted PageView 猜出子页；未声明的内部页签暂按工作台默认入口承载。业务自身的筛选 tabs 不属于全局承载 tabs。

**启停：** catalog 必须跟随实际注册、运行状态、权限和用户隐藏设置，不是只扫描仓库目录。已下线项与隐藏内部项按当前政策排除；注册失败在主页“不可用”诊断区展示原因，不显示可点击假卡片。

### 4.2 Better Sidebar 适配器

在自家客户端增加独立的小型 sidebar adapter，消费 `desktopWorkbenches` 和 `betterSidebar` 两个服务；通过 `ctx.inject` 等待服务，不以 DOM 出现判断可用。

- 读取 catalog 初始快照，再订阅修订；按稳定主键 diff 注册/更新/注销对应 `TabDescriptor`。
- 每个业务 descriptor 定义 `createTab`，生成唯一 instanceId；`single:false` 仅辅助说明，不作为多实例保证。
- 点击使用 `betterSidebar.openTab` 并显式传入来源会话 scope；不传 `replaceTab`、不关闭开始页、不使用 `target:'side'` 强开第二 pane。
- 页面选择、路由参数、工作区和来源实例写入明确 meta，组件通过 `scope/tab.meta` 消费；所有并发动作保持自己的 owner。
- `visible:false` 暂停目录轮询/预览等业务 UI 工作，保留草稿；不卸载主聊天或后台任务。
- 生命周期登记交给 `ctx.effect`；先停止订阅/新打开，再注销类型、释放 service facade，最后回收无草稿实例。已经打开的页显示“插件已停用/卸载”，不静默销毁草稿。
- 注册失败回滚已占的 native type 和 slots，继续记录失败，不能遗留不可重注册的 ID。

**多实例 facade 需要单独实施：** 不能简单把旧 `View` 包进 `TabDescriptor.component`。旧 `Frame` 的 `activate/deactivate` 和 `ownerId()` 会造成实例互串和第二份会话。

### 4.3 唯一的右侧主页

主页复用 Dashboard 的工作台目录与业务能力，改成业务 container 模式或抽出的同源 `HomeView`，不是外加一个视觉相似的独立数据页。开始页不展示欢迎标题、说明文案、今日会话/运行中/可用业务页统计；搜索与功能目录直接置顶。

- 仅移除开始页的信息展示，不删除 `buildDashboardPayload()` 或其他页面仍需的会话/用量数据能力。
- 主页的“工作台”部分消费统一 catalog，不再 3 秒读 `window.parent`，不再维护第二份 static 合并表。
- 常用工具消费官方 guide 类型目录与 Better Sidebar 注册表，明确去重与分组；卡片按右栏容器宽度单双列响应。快捷卡后追加紧凑“更多”行，点击弹出右对齐、约 216px 的原生风格菜单，不使用大块留白或直接打开模态列表。
- “更多”菜单为“浏览更多插件 / 创建你的插件 / 调整顺序”，第三项前有细分隔线，统一线性图标、37px 桌面行高（触屏 44px）、悬停/键盘焦点态；避开视口边界，不截在滚动容器内。Escape、外部点击、触发器移出可见区和上下方向键均有确定行为。
- 浏览动作正式接宿主插件目录。创建动作必须与现有 Better Sidebar 开始页**同一条链路**：调用 `ctx.get('uiWorkspace')?.startSession(undefined, { agentPreset: 'cordis', prompt: t('guideCreatePrompt'), whenDraftExists: 'append' })`（见 `dsh-plugins/dsh-better-sidebar/src/client/native/index.ts:363–374`、`src/client/locales.ts` 的 `guideCreatePrompt`）。`cordis` 对应 UI 文案“创造模式”；提示词写入目标会话草稿，已有文本时追加，不自动发送消息，也不在右栏生成预览插件卡片。
- `startSession(undefined, …)` 的首参是工作区 ID：宿主按当前主会话工作区 → 最近工作区解析；找不到时提示失败，不暗中创建目录。目标会话可能复用工作区内匹配 `cordis` 的空白会话，不保证每次新建；随后用 `layout.selectPanel(null)` 显示中栏主对话。正式实现不得改成“先弹表单、提交后才创建会话”，也不得额外热切换当前非空会话的 preset。
- 效果稿只模拟这次导航后的可见状态：中栏切到创造会话、输入框填入提示词、头部显示“创造模式”、右栏仍保留开始页；不调用模型、不创建真实文件或会话、不安装插件。
- “调整顺序”仅编辑常用工具顺序，不影响工作台的独立拖拽锚点。修改先保存在草稿，完成才提交、取消/Escape 恢复；离开主页或搜索/分类切换丢弃未确认草稿。正式版与已有 Host 设置的修订号/CAS 对齐，不能覆盖其他窗口的新排序。
- 标题右侧“全部工具”打开可搜索工具目录。选择工具另开右侧页签，不替换开始或中栏聊天。工作台卡片点击仍走新 adapter。
- 常驻主页不得把自己作为“工作台”卡片再递归打开；**不展示欢迎/统计信息、“最近资源”区块或原型解释文案**，必要的诊断放在不可用项或错误态。聊天内的图片引用与工具结果仍可在右侧预览。
- 工作台 item 右上角常显六点拖拽锚点（与打开按钮分离），可跨任意行列移动，落点吸附到网格插入位置；拖拽浮层、原位占位和目标描边给出反馈。触屏只在锚点阻止滚动，其余卡片区域正常滚动/点击。
- 松手后保存按稳定 `workbenchId/pageId` 排列的顺序；切换会话、返回主页或刷新后恢复，不因搜索/目录注册变化重置。新增项追加末尾，卸载项不显示但保留顺序记录，以便重装恢复。
- 拖拽超过移动阈值时屏蔽紧随的卡片 click，避免“排序”误开页签；Esc、pointercancel 或窗口失焦取消并恢复。搜索过滤期间禁用排序，避免仅对可见子集排序导致隐藏项意外跳位。
- 键盘使用同一个锚点：空格/Enter 拿起，方向键按网格位置移动，Enter/空格确认，Esc 取消。锚点有可访问名称、焦点反馈和状态播报；存储失败明确提示，不声称已保存。
- `pin/hide/order` 的业务迁移与 IDE 侧活动栏分开：取消“主页在左侧固定且不可取消”的旧 UI 承诺，但不擅自清空 IDE 用户固定设置。“拖拽锚点”不是切换 IDE 固定状态的按钮。

**guide 所有权策略：** 在 VsSaros 宿主配置层尽力写 `guideTakeover:false`，但不把 live volatile 设置当成硬门槛。`sidebar.right.tab.guide` 是 chain 槽，按 `priority` 升序选举；VsSaros 自家主页注册 `priority:-10` + `select:()=>({})`，稳定压过 shipped `NativeGuide` 的默认 `priority:0`。shipped 条目即使因 live 设置仍注册，也不会被选中渲染，因此不会同时显示两份主页。新配置归宿主组合所有，用户主动改了相关设置时只显示信息性诊断，不进入反复写回循环。

注意：已有 `Config` 通过 volatile settings 热更新，“写了行 config”不等于 live `guideTakeover` 已翻转；因此实现必须由 chain 优先级保证接管，而不是读取 live pref 后短路新布局。显式 `sidebarLayoutV1:false` 才回退旧布局；迁移失败时保留官方 guide 作为可行动退路，不再恢复中栏标签。

### 4.4 三类业务内容承载

| 形态 | 新承载 | 迁移要求 |
| --- | --- | --- |
| 注册式 React | 原生右 tab 内 `renderBusiness` | 复用 Component、Provider、错误边界；新增 `surface:'sidebar'` 等显式上下文；移除内部 conversation 的展示，动作仍使用中栏会话 |
| SSR/成熟网页 | 右 tab 受控 iframe / 页面载体 | 已声明同源 route 才允许加载；验证真实 surface 参数、桥方法、CSP；不能直接追加未实现的 `surface=sidebar` |
| 组件式 | 已注册组件 renderer | 记忆继续复用 MemoryTabView，不请求 `/x/memory/`；入口生命周期迁成订阅而不是全局盲等 |

旧 `customFrame` / splitConversation 对话注入在新模式中不得渲染第二聊天。依赖 `props.conversation` 的业务页需显式改造：保持业务 API，给“向 Agent 发送引用/切换工作台会话”动作接中栏导航。其他已授权的 sidechat/子代理原生工具表面不属于主会话，不主动删除，但不自动嵌进每个业务页。

工作台可以关联多个业务会话；“打开工作台”不创建会话或目录，也不改变已有 ownership。主动选择一个关联会话时允许导航中栏，这是明确用户动作，区别于打开业务 tab 的被动副作用。

## 5. `@image:image.png` 与工具资源展示

**现状：** 本仓相关链路未找到 `@image:` 的字面量解析器。它在原型中是拟支持输入，不能声称现有 runtime 已识别。已有图片消息需要 `attachmentId / mediaType`；已有文件采用 `dsh-resource://file/session/<sessionId>/<编码路径>`。

### 5.1 两条入口统一到资源路由器（拟新增）

1. **输入图片引用**：由结构化 reference chip 或明确 token 化解析器识别 `@image:<path>`；支持空格/中文/Windows 盘符的结构化值，不靠一个模糊正则重写所有文本。代码围栏、内联代码和未完成输入不自动解析。
2. **工具结果图片/文件**：使用官方输出 schema/renderer 提供的 artifact 或 attachment ref，不从展示文字抓路径。
3. 路径相对引用必须锁定**地址所属会话 header cwd**或用户显式声明的工作区基准，解析一次成为绝对路径；linked worktree 导航的活动根与地址基准不能混用。
4. 检查授权/工作区边界/符号链接与 Host 大小、媒体类型准入；需要扩展目录授权时用既有确认通道。Better Sidebar 上游移除路径围栏不意味着新引用解析器也可以静默读任意路径。
5. 经 Host attachments 准入得到 canonical ref，再提交到官方消息协议；不能把 `image.png` 猜成 attachmentId，不能直接把任意文件 URL 当可信图片。
6. 点击右预览通过官方 `sidebarRight.openResource` 和类型匹配；图片/PDF/Office 优先官方 renderer，文本/Markdown 走现有适配，资源 key 包含 ownerSessionId 与对象身份。
7. 加入聊天仅添加中栏 draft reference，不自动发送、执行工具或替换模型。

### 5.2 不干扰原有工具表面

保留官方工具卡的输入/输出/进度/错误/确认/下载；右预览只是额外的打开目标。不同于工具执行权限，渲染成功不能当作执行成功。

重点重审 `vssaros-chat-surface/lib/client.tools.js` 与 `lib/client.fileCards.js`：去掉“所有文件一律发 IDE”的强制拦截，保留用户显式“在 IDE 打开”；计划、子代理、图片结果按原生资源类型分流，不能全改成工作台 tab。

与 `dsh-vision-router`、`dsh-ego-browser` 各自的图片工具共存，不注册同名图片执行工具；资源显示层和视觉推理层职责分开。HTML 预览保持 sandbox，不为实现任意展示打开同源脚本权限。

## 6. 状态、恢复与无会话场景

| 状态 | 归属 |
| --- | --- |
| 右 native tab 的打开/聚焦/关闭 | 官方 Sidebar；适配器不另建第二份 pane 状态机 |
| instanceId → 工作台/page/参数 | Better Sidebar tab meta + 自家有版本的业务实例状态 |
| 编辑器草稿与业务选择 | 业务实例；key 含 owner session、workbench/page、instance |
| 主会话选择/输入/模型 | 官方 conversation；工作台打开不能篡改 |
| 主页排序/可见性 | 已有 Host 用户设置迁移；稳定 pageId 顺序跨会话共享，修订号 CAS 提交；目录动态更新不清空顺序，不覆盖 IDE pin 配置 |
| workbench ownership | 现有 `desktopWorkbenchOwnership`；显示位置改变不改会话归属 |

旧中栏页签存档采用读旧写新的一次性迁移：可解析且仍可用的业务页转换到右栏新 meta，未知项标不可用；旧对话页签不迁成右业务，当前聊天继续由官方选中会话恢复。完成前保留原存档备份，不直接删除用户布局键。

没有活动会话时主页和目录仍应可见。Better Sidebar 当前 `openTab` 无 targetSessionId 会直接 return，因此**不能假装零会话右 tab 已支持**：实施必须核对官方全局 surface 或给自家 adapter 增加显式 workspace-only 承载；不支持时显示可行动的“选择/新建会话”状态，只有用户发起聊天才建会话，不能伪造 sessionId。

HMR/注销必须幂等；service context 不再 live 时停止注册，避免在 teardown 中重新占用 native tab ID。

## 7. 分阶段实施与文件范围

| 阶段 | 实施点 | 主要位置 | 完成门槛 |
| --- | --- | --- | --- |
| P0 基线 | 验证 3 个 vendored 插件的真实加载/版本/依赖；记录官方 guide、资源 renderer；冻结当前失败基线 | `dsh-better-sidebar`、`dshHostSupervisor`、profile seed | 无双挂载、Host 与 client 服务确实提供；不擅自重启用户实例 |
| P1 目录 | 新 catalog、注册订阅、路由与组件登记、稳定 pageId；消除主页和左 nav 长期双名单 | `vssaros-workbenches/lib/client.js`、`vssaros-dashboard/lib/catalog.js` | 现有三形态不漏；未来 `register` 自动默认页；动态启停与失败可见 |
| P2 右 tab | 自家 sidebar adapter + BusinessView + instance facade | `vssaros-workbenches` 客户端新增小型子块 | 重复点击新实例；作用域正确；visible/注销/草稿无串台；不挂第二会话 |
| P3 主页与布局 | 唯一 guide HomeView，释放 Better Sidebar 默认 takeover；退役左主页、中栏 TabStrip/main-panel 路由/docking | Dashboard、`client.workbenchNav.js`、`client.brand.js`（保留品牌）、workbench Frame | 主聊天 DOM 与服务不因右页变化卸载；零中栏页签；开始页保留 |
| P4 资源 | reference tokenizer、Host admission、资源打开与 tool/file 拦截重审 | `client.tools.js`、`client.fileCards.js`、现有附件/引用接口 | `@image:`、图片工具结果、文本/PDF/HTML 类型正确；错误/越权可见 |
| P5 状态与验收 | 旧存档迁移、容器响应、明暗主题、启动和 HMR 自证 | 用户状态迁移、workbench/布局/资源 tests 与 doc | 新 profile / 老 profile / no-session / two-session 真机与行为级回归 |

不在 vendored `lib/client.js` 上硬补行为；自家插件改动需 bump 对应版本、touch 客户端入口、同步 `files`、重烘 profile seed。部署“包已在目录”不等于插件已安装，更不等于页面生效。

规范同步在 P3 前完成：`doc/workbench-development-standard.md` 与随包技能的承载描述从“整页/左聊天右业务”扩展为“中栏唯一会话 + 右栏业务”模式，并更新生成副本、catalog/style/frame 守卫；本提案不提前重写当前有效规范。

## 8. 验证矩阵（实施完成后）

1. **结构**：左侧无主页条目；中栏零 TabStrip、零 32px 留白；主聊天挂载数量始终 1。
2. **主页**：内容是实际 Dashboard 数据，唯一 guide owner；常用工具和业务目录都有，主页不递归列自己。
3. **发现**：运行时注册一个无宿主名单的新工作台立即出现；声明 2 个业务页得到 2 个目录项；卸载不留假入口。
4. **多实例**：同一工作台连续点击 3 次 → 3 个右实例；开始仍在；实例筛选/选择/动作互不覆盖。
5. **跨会话**：S1/S2 使用同 tab 编号、不同 cwd/草稿；后台注册事件不偷切前台；恢复读正确 owner。
6. **保活**：切 tab 停止不可见页主动 polling，草稿和滚动保留；主 Agent 流输出不中断。
7. **业务兼容**：注册式、SSR、组件式各测一项；记忆不发不存在路由；customFrame 工作台不重复聊天。
8. **资源**：`@image:` 输入、中文/空格/Windows 路径、attachment tool result、PDF/Markdown、链接 line；官方 renderer 不被文本兜底抢走。
9. **安全**：工作区外/符号链接/失效 ref/超限图拒绝或确认；HTML sandbox 不放开；不同会话不会猜同名附件。
10. **关闭/卸载**：未保存内容确认/备份；注销已有类型不丢草稿；HMR 半注册失败可回滚重试。
11. **无会话**：主页能访问；无 session 的 open 不静默 return；不在默认位置创建文件夹。
12. **响应与主题**：1440/1024/768/375 像素；右业务按容器 320/520/760 响应；明暗色/键盘焦点/减弱动效。
13. **旧配置**：中栏历史 tabs 迁移幂等，未知/停用页可诊断，IDE 活动栏固定配置保留。
14. **启动**：loader/context/service 未 ready 显示 loading；Host 断线可行动；不为“恢复布局”循环重启。
15. **工具**：执行中/审批中/失败/图像下载有官方卡片，无伪执行成功；右侧打开不再次执行工具。
16. **开始页内容**：无最近资源区块；“更多”紧凑菜单包含浏览/创建/排序三项，支持视口避让、键盘和外部关闭；“全部工具”保留搜索入口，打开工具不替换开始与聊天。创建严格复用 `startSession(undefined, {agentPreset:'cordis', prompt:t('guideCreatePrompt'), whenDraftExists:'append'})`：切到中栏、显示创造模式、提示词追加到目标草稿、不自动发送、不弹表单或生成预览卡片；重复点击与已有草稿按 append 语义处理。工具排序可确认/取消并在刷新后恢复，不修改工作台排序。
17. **卡片拖拽**：每项有常显独立锚点；鼠标/触屏跨行列拖动、边缘自动滚动、松手插入目标位置；拖拽不触发打开，点击卡片正文仍正常打开。
18. **排序恢复**：刷新、跨会话、搜索清空、新增/注销再注册后顺序稳定；Esc/pointercancel/失焦撤销，键盘可移动并确认；存储不可用或 CAS 冲突有明确提示。

先做类型与层级检查，再跑受影响行为测试；旧基线中 superagent/chat-surface 等失败与新回归分列，不能为了变绿整体豁免新功能。

## 9. 本轮交付与下一步

- 交互效果稿可独立查看，数据明确为样例；生产代码已把 P3 设为默认布局：中间栏顶部不再有工作台页签，右侧「开始」按 v6 效果稿由 VsSaros 主页接管。显式设置 `sessions.dshHarness.sidebarLayoutV1=false` 仍可回退旧布局。
- 关键 blockers：实例 facade 的按 scope 写操作仍待续；聊天正文 `@image:` 文本 chip 已由 `client.imageTokens.js` 落地并接入静态守卫；无会话 `openTab` 仍以可见诊断保守处理；创建入口继续复用原生 `uiWorkspace.startSession`。Host 附件准入 / 官方预览器 / tool-file 拦截、P2 route iframe 替换与 Better Sidebar 无会话策略按用户确认的真机 F5 结果保留为产品/上游决策，本轮不改 vendored 字节。
- 工作台开发流程以 `doc/workbench-development-standard.md`（版本 `2026-11-19`）为唯一流程源；用户已确认真机 F5 验证完成。随包 `guideVersionOf()` 当前预期版本为 `0.3.55/c1d75696`；若后续再改规范副本，仍需在 dsh Host 运行时读取 HTTP 接口并以实际 `x-workbench-guide-version` 为准。
- 用户已确认真机 F5 验证完成；本轮又改了客户端、守卫与规范副本，因此当前窗口仍需用户主动重启 Harness 才能加载新插件字节。下一次启动会生成 `sidebar-layout-*.yml` 覆盖层；即使 live `guideTakeover` 仍为 `true`，VsSaros 主页也会以 `priority:-10` 接管 shipped guide。聊天正文 token chip、目录投影、守卫与文档已代码化收口；官方预览器/tool-file 拦截重审、P2 route iframe 替换与 Better Sidebar 无会话策略保留为产品/上游决策。
- 右栏工作台 tab 内容被截断已修复：`[data-vssaros-wb-sidebar-page]` 根节点、子元素与 route iframe 补齐 `flex:1 1 auto + height:100% + min-height:0` 双保险，避免 `.wb`/iframe 在 auto 高父级上塌成工具条高度；浏览器回归页验证注册式工作台与 iframe 均铺满右栏并可滚动。
- 开始页工作台目录改为按 `page.key` / `page.workbenchId` 下线已知旧入口、按 `page.key` 去重；标题只用于展示与搜索，不再吞掉同名新工作台。保留「商城」并下线已知 legacy 重复项；「自动发现」文案改为「目录自动发现」，静态效果稿同步。`vssaros-home` 自身启用纵向滚动。
- 开始页右侧工作台卡片横向被截断已修复：`.vssaros-home` 根节点改为 `box-sizing:border-box` 并补 `min-width:0/max-width:100%`，工具/工作台网格与卡片同步约束宽度；浏览器回归页验证修复前右列越界、修复后两列完整落在右栏内。
- 安装态/HMR/自动注册口径已收口且不改 Host：v6 开始页短轮询现有 `GET /api/vssaros-workbenches/install-status`（挂载、30 秒、窗口聚焦与重新可见时补刷），显示「已安装，重启 Harness 后出现」；`Workbenches.dispose()` 在清监听器前发布一次空目录；新增 `registerPage()` → 开始页卡片 + native tab 的端到端自检。生产 HomeGuide 渲染验证已确认提示、`目录自动发现` 与新工作台卡片同时出现。
- 开始页每个工作台 item 的「锚点功能」按规范固定为右上角常显六点拖拽锚点，不是 pin / 复制链接 / URL hash 按钮：每张卡片新增稳定 DOM `id`、显式 `data-vssaros-home-anchor`、`aria-roledescription`、锚点稳定 `id` 与 `:target` 定位高亮；拖拽/键盘排序、搜索禁用与 click 抑制链保持不变。浏览器回归页验证 7 张卡片各有 1 个可见且与 key 一一对应的锚点，稳定 id 无重复。
- 统一目录优化已全量收口：新增 `dsh-plugins/workbench-directory.mjs` 单一真源与 `generate-workbench-directory.mjs` 生成器，向 workbenches / chat-surface nav / market / dashboard catalog / dashboard app / skills 写入带 hash 的生成投影；`DEFAULT_ITEMS` 业务条目、`WORKBENCH_MODULES` / `OFFLINE_WORKBENCH_ROUTES`、market/app 对 `__vssarosWorkbenchItems` 的读取、skills 镜像与 `ingestLegacyCatalog()` 兼容 API 均已删除。workbenches 发布 `__vssarosWorkbenchCatalogEntries` / `__vssarosWorkbenchCatalogSubscribe` 与 `vssaros-wb-catalog-change` 事件；route 白名单与深链由 `visibility.routeWhitelist/deepLink` 单独投影。`check-workbench-catalog.mjs` 从三表逐字同步重写为「单一目录 + 生成投影 + 跨包 fallback 反向断言」，`doc/workbench-development-standard.md` 与随包副本同步 `canonicalId/aliases/visibility/一次注册/投影一致性` 规则。P4 新增 `client.imageTokens.js` 文本 chip；仓库级确定性红项（bridge 版本、doc 增量行、rooms 版本快照、windowsHide、fromMain、sessions iframe、migration ledger、kb-refs header、superagent 构建清单）已定点修复。
- 用户报右侧「开始」页出现两张「知识库」：真因是 `vssaros/kb/default` 注册式默认页未登记为 hidden，和 `manifest:/x/kb//vssaros-wb-kb` 同时通过 `selectStartPages()`。单一目录真源补 `vssaros/kb/default` hidden 行并重新生成 6 个区块 / 2 个文件；`registerManifestPages()` 改用目录行的描述、图标与来源，保留一张 manifest 知识库卡；守卫与行为级自检新增开始页标题唯一、隐藏身份、重复卡去重回归。当前版本 `vssaros-workbenches@0.3.55`、`vssaros-chat-surface@0.2.458`。
- 完成真实安装且回执需要重启时，再请用户在任务结束后通过“立即重启”或“Harness → 重启 Harness”；不能用重启掩盖静态接线或安装失败。

## 10. 实施进度（2026-11-19）

| 阶段 | 状态 | 本轮落地 |
| --- | --- | --- |
| P0 基线 | 已完成 | 核对 `dsh-better-sidebar@0.32.1`、三个无 scope vendored 包、`dsh-compat.json` 的 `0.2.2-rc.2`；本轮全量守卫最终为 **106/109 通过、3 条既有失败**：`superagent/dev test-gate` 的 8 个 dev spec、`check-superagent-ratchet` 的 3 项计数销账、`run-workbenches-check` 的服务端 `/plugin-resources` 路由断言。并行抖动项 `run-marketplace-robustness-check.mjs`（31/0）与 `plugin-source.test.mjs`（14/14）单独通过；发布一致性、规范、目录、chunk、sessions、doc 增量、windowsHide、rooms、migration ledger、kb-refs 等守卫通过，未引入确定性新失败。 |
| P1 统一目录 | 已完成并驱动默认主页 | `vssaros-workbenches` 客户端新增 `getCatalogSnapshot/subscribeCatalog/registerPage/getCatalogRenderer`，`register()` 自动生成 `default` 页并支持声明 `pages[]`；版本升至 `0.3.38`；补充 2 条行为级自检。统一目录现为 v6 开始页的工具/工作台数据来源。 |
| P2 右栏适配器 | 已完成，随默认布局启用 | `vssaros-workbenches` 新增旧全局清单过渡桥、`betterSidebar` 软注入、目录 diff 注册、`createTab` 多实例、无第二会话的 BusinessView、route iframe 占位与 HMR 注销；版本升至 `0.3.39`；补充 2 条行为级自检。native tab type 由 P3 所有权链在配置开启且自有 guide 注册成功后启用。右栏工作台 tab 的 `[data-vssaros-wb-sidebar-page]` 根节点、子元素与 route iframe 补齐 `flex:1 1 auto + height:100% + min-height:0` 双保险，修复内容塌成工具条高度；新增静态防回归断言与浏览器高度回归页。 |
| P3 唯一主页 / 布局退役 | 已完成并设为默认 | IDE 设置、Host 启动选项、预热读取、中立配置 JSON 往返统一改为「默认 true、显式 false 回退」；`renderHostOverlays` 默认生成 `sidebar-layout-*.yml`，按行 id 写 `guideTakeover:false` 与两个客户端 config。`vssaros-chat-surface` 默认跳过中栏 TabStrip / 左主页行 / main 面板 / 旧救援 watchdog，守卫新增「默认模式零中栏页签」与 legacy 模式双断言。`vssaros-workbenches` 以 `priority:-10` 注册唯一 `sidebar.right.tab.guide` chain，修复生产截图里 live `guideTakeover:true` 短路自有主页、右侧只剩工具且「工作台」区缺失的问题；live pref 仅作信息性诊断，不写回用户设置。桌面窗口就绪锚点兼容 `data-vssaros-guide-root`。生产 `HomeGuide` 按 v6 重写：搜索框带 SVG 与 `/`、三分类、双列工具卡带图标/描述/快捷键、紧凑更多菜单（固定定位/右对齐/视口避让/3 项 SVG/分隔线）、全部工具弹窗、工作台双列卡带图标/描述/来源/新标/独立拖拽锚点、拖拽预览与边缘自动滚动、键盘排序帮助、原生 `uiWorkspace.startSession(undefined,{agentPreset:'cordis',prompt,whenDraftExists:'append'})` 创建入口、无会话/服务缺席诊断；顺序经 `state.json` 的 `homeWorkbenchOrder/homeToolOrder` + revision CAS 持久化。开始页另通过策略投影 `selectStartPages()` 只按 `page.key` / `page.workbenchId` 下线已知旧入口、按 `page.key` 去重，标题只用于展示与搜索，避免误吞同名新工作台；「自动发现」改为「目录自动发现」。统一目录优化阶段 0/1 已补 `canonicalId/canonicalKey/state/visibility/aliases/replacedBy`，导出 `selectStartPages/selectNativeTabPages/selectLauncherPages/selectRouteWhitelist/resolveLegacyTabKey/catalogDiagnosticsOf/canonicalConflictsOf` 纯函数；右栏适配器改用 `selectNativeTabPages()`，`publishCatalog()` 输出 active canonical 冲突诊断，并提供只读目录探针。阶段 2 已由冻结的 `WORKBENCH_MANIFEST` 统一生成隐藏/退役/离线四份视图与只读探针；阶段 3 先引入 `catalogPolicyProbeOf()` / `__vssarosWorkbenchPolicy`，最终由单一目录生成器覆盖启动器、商城、dashboard app 与 skills；阶段 4 已硬退役 workbenches 对 `window.__vssarosWorkbenchItems` 的运行时收编：manifest 的 3 条 active route 行经 `registerManifestPages()` 注册进统一目录，10 秒轮询与 `vssaros-wb-tabs-change` 监听移除，`legacyBridgeModeOf()` 返回 `retired`；`ingestLegacyCatalog()` 已物理删除。`check-workbench-catalog.mjs` 已重写为「单一目录 + 投影一致性」守卫；跨包 `DEFAULT_ITEMS` / `WORKBENCH_MODULES` 等字面量 fallback 已删除并由带 hash 的生成投影替换。`.vssaros-home` 自身启用 `overflow-y:auto`，浏览器回归页验证目录投影与纵向滚动；根节点另补 `box-sizing:border-box/min-width:0/max-width:100%`、网格与卡片补宽度约束，修复截图里右列工作台卡片横向越界，浏览器宽度回归页验证修复后裁切像素为 0。开始页短轮询 `install-status` 并显示待重启安装提示；`Workbenches.dispose()` 先发布空目录再清监听器；新增 `registerPage()` → 开始页卡片 + native tab 的端到端自检。每张工作台 item 另补稳定 DOM `id`、显式拖拽锚点数据属性/稳定 `id`、`aria-roledescription` 与 `:target` 定位高亮，浏览器验证 7/7 一一对应。当前版本：`vssaros-workbenches@0.3.55`、`vssaros-chat-surface@0.2.458`；构建标记与入口 STAMP 同步。 |
| P4 资源分流 | 已完成代码化收口 | `vssaros-imagegen` 生图卡发布会话授权 `loadImage`，右侧预览不重新执行工具、不写文件；`vssaros-workbenches` 用同源 `/x/imagegen/api/versions?attachment=` 解析 `@image:name`。新增 `client.imageTokens.js`：用 `TreeWalker(SHOW_TEXT)` 把聊天正文里的 `@image:name` 包装成 `data-vssaros-image-token` chip，点击走 `__vssarosOpenImageReference`，跳过官方工具卡 / 代码 / 链接 / 自身 chip，并由 `check-chat-surface-chunks.mjs` 钉住接线与纯函数。用户已确认真机 F5 完成；Host 附件准入、官方预览器 / tool-file 拦截重审、P2 route iframe 替换保留为产品/上游决策，不改 vendored 字节。 |
| P5 状态迁移与验收 | 已完成（用户确认真机 F5） | `legacyTabKeysOf` / `resolveLegacyTabKey` / `migrateLegacyTabs()` 完成旧 `vssaros.wb.tabs` 一次性映射到 `state.homeWorkbenchOrder`，不改旧存档、不复活下线项；工作台/工具/图片资源均有无会话与保存失败可见诊断，`dispose()` 先发布空目录再清监听器。容器响应、明暗主题、跨会话/无会话行为、安装待重启提示、目录订阅/事件与图片 chip 已由静态守卫和用户确认真机回归覆盖；Better Sidebar 无会话 `openTab` 仍以可见诊断保守处理，作为产品策略留档。 |

**本轮边界**：用户已确认真机 F5 完成；本轮不改 vendored 第三方字节、不安装插件、不代用户重启 Harness，但代码改动后仍需用户重启以加载新字节。`sidebarLayoutV1` 默认 `true`，显式 `false` 才回退旧 TabStrip/主页入口；VsSaros chain 以 `priority:-10` 稳定接管，live `guideTakeover:true` 不再让工作台区消失。单一目录真源、生成投影、跨包 fallback 删除、兼容桥物理退役、守卫/规范重写、开始页知识库重复卡去重、P4 文本 chip 与确定性红项收口均已完成；官方预览器/tool-file 拦截、P2 route iframe 替换、Better Sidebar 无会话 `openTab` 保留为产品/上游决策。仓库全量守卫最终为 106/109 通过，剩余 3 项为既有 superagent dev spec / ratchet 销账 / workbenches 服务端路由断言。
