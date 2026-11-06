<!-- 本文件由 scripts/build-workbench-guide.mjs 生成，不要手改。
     源文件：doc/workbench-development-standard.md（改那里再跑 `node scripts/build-workbench-guide.mjs`） -->

> 随包离线副本：与仓库源文件逐字一致；如与本机文档冲突，以源文件为准。

# 工作台开发规范（VsSaros / dsh）

> 文档状态：**【规范·唯一流程源】**（2026-11-02）
> 版本：2026-11-02 · 面向 **Agent 与第三方开发者**。本文是"把一块业务界面做成工作台"的**唯一流程源**；
> 界面架构细节见 [`workbench-authoring-standard.md`](./workbench-authoring-standard.md)（Pane × 承载容器），
> Agent 执行细则见内置技能 `dsh-plugins/vssaros-skill-bundle/skills/workbench-authoring/SKILL.md`。
> 机器可读版本：响应头 `x-workbench-guide-version`（`<插件版本>/<内容 sha256 前 8 位>`）；
> Agent 交付时要在收尾汇报里带上它。

> 本文由 `scripts/build-workbench-guide.mjs` 生成随包副本
> `dsh-plugins/vssaros-workbenches/lib/workbench-standard.zh.md`，并挂在
> `GET /api/vssaros-workbenches/development-guide` 上供 dsh 侧 Agent 读取。
> 只改本文，**不要**手改副本（`node dsh-plugins/check-workbench-guide.mjs` 会红）。

## 0. 文档地图（哪份是流程，哪份不是）

**写工作台只看两处**：本文（流程 / 纪律 / 验收）+ `dsh-plugins/vssaros-skill-bundle/skills/workbench-authoring/`（实现细节：
形态选择、清单、UI 原语、踩坑、探针）。其余工作台文档都不是步骤依据——每份头部都有 `文档状态：` 标记，
`check-workbench-guide` 会核对标记存在、且历史/计划文档没被当成流程引用。

| 文档 | 状态 | 用途 |
|---|---|---|
| `workbench-development-standard.md`（本文） | **【规范·唯一流程源】** | 流程、Agent 纪律、安装与验收 |
| `workbench-authoring-standard.md` | 【参考·界面架构】 | Pane × 承载容器的界面条款 |
| `workbench-carrier-consolidation.md` | 【计划·进行中】 | 承载收口（iframe → register）排期 |
| `workbench-refactor-plan.md` | 【计划·提案】 | 对齐官方的重构方案（110KB，**不是**流程） |
| `workbench-official-alignment-plan.md` | 【计划·提案】 | 上者之前的提案（已被取代） |
| `workbench-standard-compliance.md` | 【历史·评估】 | 2026-10 的符合度评估 |
| `workbench-framework-conformance.md` | 【历史·调研】 | 2026-10 的框架符合度调研 |
| `workbench-react-mounting.md` | 【历史·调研】 | 2026-10 的挂载方式调研 |
| `third-party-workbenches-survey.md` | 【历史·调研】 | 2026-10-23 第三方工作台调研 |

技能也只有一份内容：`dsh-plugins/vssaros-skill-bundle/skills/workbench-authoring/`。
`.codebuddy/skills/dsh-workbench-authoring/` 是**指针**（2026-11-02 收口，此前它与前者并存且内容不一致）。

## 1. 执行原则（Agent 行为）

- **需求先于代码**：每次只问一个会影响下一步的问题；名称未知就先问名字，允许暂定名。
  业务目标与最小范围明确前，**不创建/修改代码、不构建、不安装**。目录名、示例、已有代码都不等于用户意图。
- **业务语言**：向用户说明"整页展示业务内容、需要时打开 AI 对话"或"边对话边看资料"，
  不要让用户确认 `customFrame`、`register()`、`repository`、`dshHomePath` 这类字段。
- **本地优先**：本地开发/自用不需要仓库、不需要上架。身份可由包名派生（见 §4），
  因此**不得为了本地安装要求用户创建仓库**，也不得编造仓库地址。
- **不擅自重启**：Agent 不得关闭/重启正在被用户使用的 VsSaros 或 dsh Host，也不要用进程探测管理重启。
  安装后需要重启时，请用户点顶部「立即重启」或菜单「Harness → 重启 Harness」。
- **如实汇报**：先讲能做什么、实测了什么、哪些仍待验证；修改文件与技术检查放附录。
- **收尾固定三点**：每次工作台开发交接，最终回复的**最后**（在所有说明、自测结果、附录之后，且其后不再追加任何内容）
  放一个醒目的“接下来怎么做”：
  1. **开发结果**：用实际的工作台名称说明开发与安装状态。两者都真的成功才说“已在本机开发并安装”；
     未完成或安装失败就如实说卡在哪，不得说已加载或已通过全部验收。
  2. **如何重启**：安装成功且需要重启时，请用户等当前任务结束后点顶部「立即重启」或菜单「Harness → 重启 Harness」，
     通常只需重启 Harness；无需重启或安装未完成就如实说，**不得**把重启当成安装失败的补救。
  3. **去哪里打开**：重启后展开左侧栏，点工作台入口，在启动器里选择新工作台（写出它的真实名称）；
     没出现就到工作台商城的“已安装”检查运行状态。用户可直接试用，也可回到原对话说“重启好了”让 Agent 继续验收。
- **先读规范，再动手**：开工前先取本规范（`GET /api/vssaros-workbenches/development-guide`），与记忆冲突以规范为准。
- **先干跑，再安装**：见 §7 的 `check_local_workbench`；干跑未通过就不要去调安装。

## 2. 先定形态（选错要重写）

| 形态 | 适用 | 注册方式 | 现状样例 |
|---|---|---|---|
| **整页工作台** | 业务为主（看板、画布、报表、编辑器） | `customFrame: true`，宿主注入 `props.conversation` 到页面里 | `vssaros-agents`、`vssaros-kanban`、`vssaros-kb` |
| **标准分栏** | 对话为主、业务是伴随面板 | 不声明 `customFrame`（默认），宿主给「左对话 / 右业务」 | 新建工作台默认 |
| **SSR 页面型** | 已有成熟页面 / 终端类 | `vssaros.view = { kind: 'page', route: '/x/<module>/' }` + `?surface=` | `vssaros-dashboard`、`vssaros-studio` |

判据：**没有常驻对话也能完成主要工作 ⇒ 整页**；**工作过程本身是对话 ⇒ 标准分栏**。
`splitConversation: false` 可让标准分栏退回"点会话即切到会话页"的旧行为（逃生门）。

**再定归属**（决定要不要碰宿主）：

| 归属 | 身份 | 宿主改动 | 入口 |
|---|---|---|---|
| **外部包**（第三方 / 个人自用） | `local:<npm 包名>`（描述符写 `package`，不写 `repository`） | **0 处**，不写 `vssaros` 清单块 | 装包并重启后，自动出现在工作台启动器 |
| **内置包**（随 VsSaros 发布） | `vssaros:<module>` | 整页模块要登记几张表；**注册式**只登记模块联合体 + `DSH_BUILTIN_MODULES` | 整页：侧栏 / 主页卡片；注册式：启动器自动列出 |

外部包用脚手架一条命令生成并自检：
`node scaffold_workbench.mjs <module> --mode external --package @scope/name`（技能目录 `scripts/` 下）。
它**不会**写 `vssaros` 块、`repository`、`route`、`order`——这些是内置包协议，外部包写了会被误当内置。

## 3. 包格式（缺一项就静默不加载）

```text
dsh-plugins/vssaros-<module>/
├── package.json        main / exports["./client"] / dsh.bundle.patch / dsh.client.inject / files
├── cordis.patch.yml    进插件树的唯一入口（缺它 ⇒ 不加载、不报错）
└── lib/
    ├── index.js        Host 半：服务、路由、数据（/x/<module>/api/*）
    ├── client.js       客户端入口：只做注册
    └── client.<name>.js 客户端子块：UI 实现（可选）
```

四条硬规则：

1. **客户端入口不能写 `chunk:` 字段** —— 整个 web boot 会失败；子块才写 `chunk: 'client.<name>.js'`。
2. `package.json` 必须有 `exports["./client"]`、`dsh.client.inject`（含 `@vssaros/dsh-workbenches` 保证宿主先加载）、
   `dsh.bundle.patch` 指向 `cordis.patch.yml`，且 `files` 逐项列全（否则装出来的包缺文件）。
3. **改了客户端子块 ⇒ 升补丁版本 + touch 入口**（`?rev` 由入口元数据派生，缓存是 immutable）。
4. `cordis.patch.yml` 的 `config.root` 用 `!!js dshHomePath('<module>')`，不要写死 `~/.dsh`。

## 4. 注册与身份

```js
const DESCRIPTOR = {
  title: '任务台',
  description: '一句话说清它替用户做什么',
  customFrame: true,                 // 需要 props.conversation 时必开
  layout: { businessSide: 'left', businessWidth: 0.36 },
};

function apply(ctx) {
  ctx.inject(['desktopWorkbenches'], (c) => {
    c.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, TasksPanel), 'vssaros-tasks: workbench');
  });
}
```

身份（`register` 时解析，决定侧栏入口与会话归属，**不能混用**）：

| 写法 | 身份 | 用途 |
|---|---|---|
| `repository: 'https://github.com/<owner>/<repo>'` | `owner/repo` | 市场/公开仓库工作台 |
| `repository: 'vssaros:<module>'` | `vssaros/<module>` | 本仓内置工作台（保留命名空间） |
| 省略 `repository` + `package: '<npm 包名>'` | `local:<npm 包名>` | 本地开发/第三方自装（scoped 包为 `local:@scope/name`） |

- 三者都拿不到 ⇒ 注册失败（没有稳定身份就无法做会话归属，**不允许猜**）。
- 同一身份重复注册会抛错；`register()` 返回注销函数，必须交给 `ctx.effect`。
- 校验失败一律抛（`businessWidth` 只接受 0.25–0.7，`headerLayout` 只接受 `default`/`compact`）。

## 5. 界面边界

- **业务区按自身容器宽度响应**（`@container`，断点 320 / 520 / 760），**不要用 `@media`**：
  侧栏（≈360px）与编辑区（≈1200px）在同一个窗口里，媒体查询分不开。
- 宿主保留的公共入口（侧栏、工作台切换、设置）**不得遮挡**；整页工作台的根容器不得越出主内容区。
- `headerLayout: 'compact'` 时，文档内必须有**恰好一个** `[data-dsh-workbench-toolbar]`，
  否则宿主回退默认布局并 warn 一次。`data-dsh-compact-toolbar` / `-valid` 只由宿主设置，工作台不得写。
- 视觉一律走共享层（`dsh-plugins/vssaros-workbenches/lib/client.ui.js` 的 `wb-*` 原语与 `--dsw-alias-*` 令牌），
  禁止裸色值；根节点带 `data-vssaros-surface="workbench"`。
- 空态 / 错误态必须有文案与下一步动作，不能是空白。

## 6. 会话与工作区

- 一个工作台可关联多个会话，一个会话最多属于一个工作台；**既有归属不可改、不可删**。
- 打开工作台**不依赖会话**：没有会话时业务面板必须可用；只有"要发给 Agent"的动作才创建/恢复会话。
- 建会话优先 `desktopWorkbenches.newSession(workspaceId)`；需要新目录时走
  `newWorkspaceSession()` / `ensureSession({ folder })`（由宿主弹目录选择器）。
  **不得**在默认位置或推测路径静默创建文件夹；用户取消 ⇒ 不留目录、工作区、会话或绑定。
- 归属判断只读 `desktopWorkbenchOwnership.read()`（或本服务），不要另开设置命名空间。

## 7. 安装与生效

**先干跑，再安装**。`pnpm pack` 之后、调安装之前，先调：

```text
check_local_workbench({ path: "<本机 .tgz 绝对路径>" })
```

它与安装用**同一套**结构校验，另加安装前审计，但**不安装、不弹确认、不需要控制桥、不写盘**。
`ok:false` 时 `errors` 是必须先改的问题（缺 `exports["./client"]`、没注入宿主包、客户端自带 React、路径越界……）；
`warnings` 不阻断；`capabilities` 是服务端代码静态扫描到的行为（提示，不是沙箱）；`identity` 是装上后的身份。
**`ok:true` 只说明「结构 + 静态审计」通过，不等于「装上能跑」**——加载、注册、界面只有装完重启后才能核验，
不得把干跑结果表述成“已验证可用”。

本地安装（Agent 调工具，不要让用户填路径）：

```text
install_local_workbench({ path: "<本机 .tgz 绝对路径>", replace: false })
```

返回值 `application` 只有四种，必须按它决定下一步：

| application | 含义 | 下一步 |
|---|---|---|
| `applied` | 已生效 | 直接核验界面 |
| `restart-required` | 已装，等重启 | 请用户重启 Harness（**不要自己重启**） |
| `failed` | 安装失败 | 看 `code` 与 `error`，保留包，不算生效 |
| `cancelled` | 用户取消 | 不算生效 |

`application: 'failed'` 里有两类**被 Host 主动拦下**的情况，看 `code` 区分，它们都不是“安装器坏了”：

| code | 含义 | 下一步 |
|---|---|---|
| `replace_not_authorized` | 同名工作台已装，但没传 `replace:true` | 先向用户确认“要更新这个已安装的工作台”，得到授权后带 `replace:true` 再调 |
| `downgrade_blocked` | 要装的版本比已装的低 | 先向用户确认；确实要回退时再带 `allowDowngrade:true`（通常还需要 `replace:true`） |

引擎不会返回 `overridden`（没有“被更高优先级包覆盖”这条路径）——**文档里不许写不存在的取值**，
`check-workbench-guide` 会双向核对“文档/提示词里点名的取值 ⇔ 代码真的会返回的取值”。

没有该工具时，交付已校验的 `.tgz` 并说明未安装；**不得**声称已加载。
手工安装与两条生效通道见 `dsh-plugins/README.md`（`pnpm` 官方通道 / `--changed` 快通道）。

**覆盖与授权**：安装前 Host 会用 `pluginManager.listBundles()` 查同名包是否已装。
- 已装且没传 `replace:true` ⇒ **不发起安装、不弹确认框**，返回 `failed`（`code: replace_not_authorized`，带已装版本）。
  这时要先**向用户确认“要更新这个已安装的工作台”**，得到授权后才带 `replace:true` 再调；授权来自用户，不是 Agent 自己。
- 已装且 `replace:true` ⇒ 确认框会明说“覆盖：已装 X → 将换成 Y”，并提醒不会保留已装副本上的本机改动；回执带 `replaced:{from,to}`。
- 查不到已装版本（没有插件管理器）⇒ 不阻断，回执 `replaceCheck:"unknown"`——**“没检查过”不等于“没有冲突”**，不得向用户说成“已确认没有冲突”。
- 为什么是版本级检测，而不是官方那种对已装内容算指纹再比对：官方自己管安装目录，我们的安装由 IDE 主进程走 `dsh plugin add`，
  Host 看不到落盘位置，`listBundles()` 也只给 `name/version`；指纹比对在这条链上拿不到“已装内容”那一半。

每次调用（成功、失败、取消）都会往 `<数据根>/vssaros-workbenches/local-installs.json` 记一条安装证据
（包名 / 版本 / 结果 / 时间，最多 50 条）。它是排查用的**历史**，不是状态：删工作台不会删它，
`saros-workbenches/state.json` 也不会被它污染。

**“装了但没能注册”**：包能装上、但 `register()` 校验不过（身份三选一都没写、身份与别的工作台重复）或面板挂载失败时，
宿主会把失败记进快照，**启动器底部会显示「装了但没能注册」+ 包名 + 阶段 + 原因**。
看到这条先按原因改描述符 / 改名再装，不要重复安装同一个包——那不是安装通道的问题。

**生效态**：`restart-required` 之后、用户重启之前，工作台**不会**出现，这是预期而不是失败。
`GET /api/vssaros-workbenches/install-status` 返回 `pending`（已安装、但当前 Host 还没加载的包）：
判据是「某包最新一条记录是 `restart-required`，且记录时间晚于当前 Host 的启动时间」，
所以重启后它自动消失，不需要任何“已读”状态。启动器（右键「工作台」入口）会据此显示
「已安装，重启 Harness 后出现在这里」。Agent 想确认“是不是已经加载”，查这个接口，**不要靠猜**。

## 8. 验收清单

按责任逐项打勾，全部适用项有证据才算完成。**每一条都以责任标签开头**：

- 【插件】作者保证。不满足 ⇒ 改插件。
- 【宿主】VsSaros 宿主保证（`vssaros-workbenches` / `vssaros-chat-surface` / IDE 主进程）。不满足 ⇒
  **不要在插件里绕**，记录现象并反馈给宿主，否则同一个问题会在每个工作台各修一遍。
- 【共同】需要联调。先按【插件】自查，自查通过仍不满足再按【宿主】反馈。

`安装成功` 只说明【宿主】这一段通过，**不等于**【插件】项都验过；不得把前者表述成“全部验收通过”。

**包与注册**

- [ ] 【插件】`node dsh-plugins/check-plugin-files.mjs`：`files` 与目录实际文件一致
- [ ] 【插件】`node dsh-plugins/check-workbench-catalog.mjs`：包清单声明的工作台都可达（整页：侧栏白名单 + 主页卡片；注册式：真的 `register` 且描述符与清单一致）
- [ ] 【插件】`node dsh-plugins/check-workbench-style.mjs`：视觉 6 条（`wb-*` 用量、令牌、锚点、容器查询、工具栏）
- [ ] 【插件】`node dsh-plugins/check-chat-surface-chunks.mjs`：入口比子块新（否则吃旧缓存）

**界面**

- [ ] 【共同】首次进入（无会话）业务可用；有归属会话时对话在预期位置（整页在页面里 / 分栏在左栏）
- [ ] 【插件】侧栏展开与收起、窄窗口（≤520px）下无横向滚动、无单字竖排、按钮不裁切
- [ ] 【宿主】公共入口（工作台切换、设置）不被遮挡
- [ ] 【插件】键盘可到达所有业务操作
- [ ] 【插件】明暗主题切换后颜色真的变化（不是靠兜底色）

**会话**

- [ ] 【宿主】在工作台里新建会话 ⇒ 归属登记成功且停靠在预期位置（不把用户踢出工作台）
- [ ] 【宿主】侧栏点会话 ⇒ 切到会话页（用户主动导航必须放行）
- [ ] 【宿主】需要目录时弹宿主选择器；取消后没有留下目录/工作区/会话

**安装**

- [ ] 【宿主】从 `.tgz` 安装，记录 `application`
- [ ] 【插件】`restart-required` 时请用户重启后再验加载、侧栏入口与真实界面（Agent 不得自己重启）
- [ ] 【插件】登录态/凭据/用户数据未进包

## 9. 反例（做过一次就别再做）

- ❌ 入口写 `chunk:` —— 整个 web boot 失败。
- ❌ 改子块不升版本 / 不 touch 入口 —— 守卫红 + 浏览器吃旧字节。
- ❌ 用类名当探针锚点 —— UI 统一后数到 0，看着像没渲染。
- ❌ 裸色值或不存在的令牌名 —— 暗色主题静默回落。
- ❌ 缺 `cordis.patch.yml` / 漏 `dsh.bundle.patch` —— 插件根本不加载且不报错。
- ❌ 用 `@media` 判宽度；两套页面各自取数；空态只写"暂无数据"。
- ❌ 自绘 iframe 浮层做 AI 助手（两套助手，且拿不到会话上下文）。
- ❌ Agent 自己重启 Host / VsSaros，或安装失败时用重启当解决办法。

## 参考

- 界面架构（Pane / Surface / 承载矩阵 / 验收矩阵）：`doc/workbench-authoring-standard.md`
- 承载收口（新增一律 register；iframe 只留成熟应用）：`doc/workbench-carrier-consolidation.md`
- 技能制作（frontmatter / 技能根 / `activation` 的真实语义）：`doc/skill-authoring-standard.md`
- Agent 执行细则与真机坑位：`dsh-plugins/vssaros-skill-bundle/skills/workbench-authoring/SKILL.md`
- 插件生效链路与排查表：`dsh-plugins/README.md`
- 官方对照：dsh-desktop `docs/workbench-standard.zh.md`（身份/分栏/自测清单口径与本文一致）
