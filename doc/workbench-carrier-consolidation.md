# 工作台承载收口（iframe → register）方案

> 文档状态：**【计划·进行中】**（2026-11-02）。承载口径与排期，
> **流程**（怎么做、怎么装、怎么验收）只在 `doc/workbench-development-standard.md`。

版本：2026-11-02 · 状态：**进行中**（本文是口径与排期，不是已完成结论）

## 1. 现状：两套承载并存

| 承载 | 怎么来 | 通信方式 | 现有样例 |
|---|---|---|---|
| **A. SSR 页面 + iframe** | `package.json` 的 `vssaros.view = { kind:'page', route:'/x/<module>/' }`；宿主用 iframe 打开，靠 `?surface=` 分版 | 页面 ↔ 页面：`localStorage`（选中项 / rev）；页面 ↔ 宿主：`vssarosDsh` 桥 / `postMessage` | **纯 A**：`dashboard`、`skills`、`imagegen` |
| **B. 注册式 React** | `desktopWorkbenches.register(descriptor, Component)`；宿主直接渲染 `View` | `props.service` / `props.conversation`；同 DOM，无跨文档通信 | `kb`、`kanban`、`codebase`、`memory`、`agents`、`scheduler`、`loop`、`workflow`、`sessions`、`studio`、`media`、`marketplace` |

⚠ **这不是二分法**（2026-11-02 按代码核实，此前的表把 `studio`/`media`/`marketplace`/`sessions` 错列为纯 A）：
上面 B 列里有一半是**混合**——它们既注册了 React，又仍有 SSR 页面：

- `studio` / `media` / `marketplace`：中栏页签走 React，**IDE 活动栏与侧栏版仍加载 SSR 页**；
- `sessions`：会话列表走 React，**`?view=tiles`（会话磁贴）与 IDE 活动栏仍走 iframe**（带查询串的路由不会被自动切换，见 §3.1）。

⇒ 判断"某个工作台是什么承载"要看**具体的入口**（中栏页签 / 侧栏 / 活动栏），不能只看包清单的 `view.kind`。

两套并存的代价（真机都付过一次）：

- **同一件事两种写法**：`?surface=sideview/editor` 的 Pane 拆分，在 B 里根本不需要（宿主自己给分栏 / 整页）；
- **通信绕路**：A 的选中项要写 `localStorage` 再监听（跨 webContents 还可能不触发），B 直接是 props；
- **验收矩阵翻倍**：`doc/workbench-authoring-standard.md` §8 的 10 格，有 4 格是 A 专有；
- **性能两套调优**：A 要"保活页签 / 不预载"，B 要"避免重渲染 / 别把大图同步 parse 放主线程"。

## 2. 目标口径（写进规范，不再摇摆）

1. **新工作台一律走 B**（`desktopWorkbenches.register`）：
   - 需要常驻对话 ⇒ `customFrame: true`（对话嵌在页面里）；
   - 对话是主任务 ⇒ 标准分栏（默认，宿主给左对话 / 右业务）；
   - 明确不要常驻会话 ⇒ `splitConversation: false`。
2. **A 只保留两种合法用途**：
   - **内嵌成熟应用**（整站前端、终端类、旧后台）—— 重写成本远大于收益；
   - **第三方/外部页面**（不在本仓维护、无法改造成 React 组件）。
3. 除上述两种，**不得新增** `vssaros.view.kind = 'page'` 的工作台。
4. A 类页面必须：带 `data-vssaros-surface` 锚点、`?surface=` 未知值回落完整页、按容器宽度响应
   （这三条已有守卫：`check-workbench-style` / 探针 `data-*` 断言）。

## 3. 迁移顺序（按风险从低到高）

| 批次 | 对象 | 理由 | 状态 | 验收 |
|---|---|---|---|---|
| P1 | `sessions` | 只读列表 + 详情，逻辑简单，无跨进程状态 | **已迁（2026-11-02，列表视图）**：固定 / 清空 / 重命名 / 详情 / 磁贴仍在旧页 | `check-sessions-workbench`（真 React + jsdom，59 项） |
| P1 | `skills` | 原设想「只读列表 + 详情」——**实测不成立**（见 §3.3） | **未迁，需单独评估** | — |
| P2 | `dashboard` | 已大量用 `wb-*` 原语，改造成本低 | 未迁 | 卡片网格 + 快捷操作；无 iframe |
| P3 | `media` / `imagegen` | 有大量二进制与滚动列表，需要先量性能 | 未迁 | 列表滚动 60fps；不整文件 parse |
| P4 | `marketplace` / `studio` | 内嵌成熟应用（合法 A 类）| **暂不迁移**，按 §2.2 保留 | — |

每批只做一件事：**先注册（B）+ 保留旧 route（A）双跑一版**，确认无回归后，再在
`DEFAULT_ITEMS` / `WORKBENCH_MODULES` 里切到 `wb:<身份>` 路由，最后删旧页面。
反过来做（先删 A 再补 B）会得到"点开空白"，这是本仓踩过的形态。

### 3.1 实测修正（2026-11-02）：「双跑」与「切换」是同一件事

文档原先设想"先注册、双跑一版、再手动切路由"。实测导航里 `wbFor()` 对 `/x/<m>/` **自动**按 `vssaros/<m>` 认：
**只要新 chunk 装载并注册成功，dsh 窗口里的页签立刻从 iframe 换成宿主渲染**，不需要改 `DEFAULT_ITEMS`。
所以实际行为是：

- 注册成功 ⇒ 用新组件；没注册（装不上 / 旧版）⇒ **自动回落 iframe**。两种状态在**同一次装载内**，不是时间上的两步；
- **带查询串的路由不会被切**（`/x/sessions/?view=tiles` 不匹配 `^/x/<m>/$`），所以「会话磁贴」仍走 iframe——
  这是**有意**的，也是会静默坏掉的假设（正则一放宽，磁贴就被没有磁贴视图的新组件接管）⇒ 守卫 `check-sessions-workbench` ⑩ 用**导航代码里的真实正则**钉住它；
- 旧 SSR 页**不能删**：IDE 左栏 `vssaros.activityBar`（「历史会话（插件页）」）加载的仍是它。

### 3.2 迁移一个页面型模块的最小清单（sessions 踩出来的）

1. **先看 API 是否与页面同口径**：sessions 的 `/api/sessions` 当时**不认 `scope=current`**（只有页面认），
   注册式组件拿 API 时「仅当前工作区」会静默无效。修在**服务端**并抽成共用函数（`rowsInScope`），
   不要在客户端重算（重算 = 两份口径）。
2. 组件拿 `ctx` 用**闭包**（`install(ctx)` 里 `makePanel(ctx)`）。宿主渲染 View 给的 props 是 `{service, entry, active?, conversation?}`，**没有 ctx**。
3. 清单补 `exports["./client"]`、`files`（入口 + 子块）、`dsh.client.inject: ['@vssaros/dsh-workbenches']`（保证加载顺序）。
4. **先做只读核心闭环，写操作留旧页**，工具栏里给一个「在页面中打开」入口（能力没丢，只是没搬）。一次搬完 = 迁到一半点开空白。
5. 守卫必须是**行为级**（真 React + jsdom），源码字符串断言证明不了「点得动」。
   ⚠ jsdom 守卫的加载顺序：**先挂 jsdom 全局，再动态 `import('react')`**；静态 import 会让受控 `<input>` 的 `onChange` 一次都不触发（`<select>` 却正常）。

### 3.3 `skills` 为什么不是「同批只读」（2026-11-02 读代码核实）

原排期把 `skills` 与 `sessions` 并列为「只读列表 + 详情」。读 `vssaros-skills/lib/index.js` 后这个前提**不成立**：

- 页面是 `renderPage()` 一个函数、约 1100 行（`index.js` 的 2383–3493 行），`index.js` 总共 4400 行；
- 它是**技能 / 工作流 / Agent / MCP / 插件市场**的多 tab 综合页，不是一张列表；
- 带**写操作**：安装 / 删除（`renderItemRow` 的 `delKind / delOp / delPkg`）、MCP 原始 JSON 编辑（`readMcpRawText`）、市场分页与筛选；
- 服务端已经是「返回**已渲染好的卡片 HTML**，客户端 `insertAdjacentHTML`」（`/api/plugins`，注释里写明是为了不在浏览器里再实现一遍卡片模板）。
  迁成 React 就得**反过来**把这些模板在客户端重写一遍 ⇒ 这正是那条注释在避免的「两份迟早漂移」。

⇒ `skills` 不适合照 sessions 的「只迁看、写留旧页」套路：它的「看」和「写」交织在同一套 HTML 模板里，拆不干净。
需要先决定要不要把它**拆成几个工作台**（技能 / MCP / 市场），或先把服务端改成**出 JSON 而非 HTML**，再谈迁移。这是一个独立的设计问题，不是机械搬运。

## 4. 门禁（收口靠守卫，不靠自觉）

- `dsh-plugins/check-workbench-style.mjs`：UNIFIED 名单里的包必须**零 iframe**；
- `dsh-plugins/check-workbench-catalog.mjs`：模块页表 / 主页卡片 / 侧栏白名单三处一致
  （新增工作台漏登记会被当场抓红）；
- `dsh-plugins/check-workbench-guide.mjs`：开发规范必须写明"标准分栏默认 + `splitConversation` 逃生门"，
  且实现里真的有（文档与代码双向对账）。

## 5. 与官方（dsh-desktop）的差异（有意保留）

| 项 | dsh-desktop | 本仓 |
|---|---|---|
| 承载 | 只有 React 组件（同 DOM） | React 为主，**保留 iframe 给成熟应用** |
| 理由 | 单体 Web UI，天然同 DOM | 已有大量 SSR 页面（dashboard/studio/marketplace），重写不划算；iframe 隔离在"大工作台不拖慢主线程"上有实际收益 |

⇒ 收口目标是"**新增只走 B**"，不是"消灭 A"。把 A 限制在少数几个成熟应用上，
就能同时拿到"协议统一"和"隔离收益"。
