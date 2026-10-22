# 群聊与记忆演化 —— 复刻 DeepSeekBot 对照说明

> 本文件记录「agent 群聊模式」的实现口径与 DSB（DeepSeekBot）的逐条对照。
> ⚠ 工作区有并发会话会跑 `git clean` / `git checkout` ⇒ **未跟踪的新文件会被删**（本文件已中过两次）。
> 备份：`C:\Users\qiuzijian\AppData\Local\Temp\_saros_backup_20261021\`。

## 1. 我们复刻了什么

| DSB 能力 | 我们的落点 | 状态 |
|---|---|---|
| 群（多 agent 同处一室） | `lib/groups.js`（数据面）+ `lib/groupPage.js`（页面） | ✅ |
| 四档唤醒策略 | `all` / `mentions` / `digest` / `silent`（+ digest 阈值与后台冲刷） | ✅ |
| 成员邀请 / 移出 / 待确认区 | 群设置弹层 + 邀请弹层 | ✅ |
| 记忆（SOUL.md / MEMORY.md） | `lib/memory.js`（Git 面）+ 页面右栏「记忆」签 | ✅ |
| 记忆演化（提交 / 版本 / 分支） | 右栏「演化 / 版本 / 分支」三签 | ✅ |
| 群聊页布局 | DSB v3 桌面版三栏（左 236 / 中 / 右 320） | ✅（2026-10-21） |
| 消息分组口径 | DSB 的 `message-groups.ts`（15s / 180s / 8 条） | ✅（2026-10-21） |

## 2. 布局规格（DSB v3 桌面版）

```
┌56 rail┬ 220 频道列表 ┬──── 中间栏 = 群聊页 ────┬ 320 右栏 ┐
│       │ Agent 列表    │ ┌236(可折叠)┬ 聊天 ┐  │ 记忆/演化/│
│       │ 群聊列表      │ │ Agent 列表 │      │  版本/分支/│
│       │               │ │ 群聊列表   │      │  成员/工作 │
└───────┴───────────────┴───────────┴──────┴──────────┘
```

| 元素 | DSB 口径 | 我们 |
|---|---|---|
| header | **居中岛屿胶囊**（不是实心条） | 同（`.gp-island > .gp-pill`） |
| 消息栈 | `max-width: min(560px, calc(100% - 84px))`（**不是**居中大列） | 同 |
| 气泡 | radius 16；组内续接的那条切角收到 4px | 同 |
| composer | **胶囊** radius 25 / min-height 50 / 发送键 34×34 圆钮绝对右下 | 同 |
| 右栏 | 320，tab = 记忆 / 演化 / 版本 / 分支 | 前四个 + 我们另有的 成员 / 工作 |
| 响应式 | ≤1080 右栏变"点开才覆盖"的抽屉 | **优先牺牲左栏、保住右栏**：≤1080 左栏折叠 + 右栏收窄到 280；≤760 右栏才收抽屉 |

> 响应式那条是 2026-10-21 改的：之前照抄 DSB 的 ≤1080 隐藏右栏 ⇒ 群聊页嵌在 IDE 中栏（~840px）时
> **「记忆/演化/版本/分支」永远看不见**（用户报"缺少记忆"）✗。
> 教训：**上游断点按整窗宽度设计，不能照抄到"嵌在别人容器里"的场景**；导航栏可以让位，信息不该消失。

## 3. 消息分组口径（对齐 DSB `message-groups.ts`）

规则 = **同作者 + 同天 + 相邻 ≤15s + 整组跨度 ≤180s + 每组 ≤8 条**，另加 `at - previousAt >= 0`（时间不得倒流）。

> 顺带一个结论：这几条同时成立时，**180s 跨度上限够不到**（8 条 × 15s ⇒ 最多 105s）——
> DSB 那条是防御性兜底，我们照抄即可。

## 4. 样式跟随宿主主题

DSB 是浅色皮，直接抄就是「IDE 深色外壳里嵌一块白底」✗。现在群聊页**跟随宿主主题**：

| 层 | 做法 |
|---|---|
| 群聊页自身 | `--gp-*` 全部指向 `--vscode-*`；字体用 `--vscode-font-family/-size` |
| 不在 IDE 里 | 落到 fallback（默认深色，系统浅色时 `prefers-color-scheme` 换浅色） |
| **iframe 承载时** | iframe 是**独立文档**，拿不到父页面的 `--vscode-*` ⇒ `detail.js` 的 `syncThemeToFrame()` 把 40 个变量灌进 iframe 根元素，并在 `load` + 1.2s 轮询里重复同步（IDE 换配色也跟着变） |

> ⚠ **fallback 要分层**：媒体查询里只能改 `--gp-fb-*`（fallback 值），主链必须写成
> `var(--vscode-x, var(--gp-fb-x))` —— 否则媒体查询会**盖掉**主题变量（有主题也变浅色）✗。

## 5. 群聊页接进 agent 工作台（2026-10-21）

用户反馈「打开 agent 工作台，没看到重构后的 UI」—— 根因：**同一个群聊存在两套 UI**
（DSB 三栏页只挂独立路由，工作台的「群聊」签还是旧的内联面板），工作台指向的还是旧的那套。

改法（`lib/detail.js`）：

1. 「群聊」签的内容换成**同源 iframe 承载 `/x/agents/group/<id>`** ⇒ 群聊 UI 只有一份实现。
   *为什么 iframe 而不是内联*：groupPage 的脚本会挂 `window.*`（`note` / `openNewDialog`），
   内联会与详情页的 `note()` 抢全局 ⇒ iframe 天然隔离 ✓。
2. **默认落点 = 群聊签**（有群时概览签收起），群聊签下收掉名册筛选框（**hero 身份条保留**）。
3. 旧的内联群面板与其脚本（`groupSend` / `groupCreate` / `renderGroupList` / `renderTranscript`）**下线**。
4. 焦点交接 `group:<id>` 改为切 iframe 的 `src`。

## 6. agents 页对齐 mockup（2026-10-21）

参照 `doc/agents-surfaces-v2-mockup.html`：**款 A 为主**（名册卡 + profile hero + 概览首签），
**补齐款 C 的「活动」与款 D 的「时间线」**。

| 块 | 落点 |
|---|---|
| 「活动」（款 C） | 此刻 feed（委派创建/进行中/已回报、群回收回复、审批在途、会话）+「待你处理」（审批 N · unknown-outcome N · 委派 N 在跑）；数据由纯函数模块 `lib/activity.js` 构建（探针可单测），页面侧 toString 内联以支持轮询重建 feed |
| 「时间线」（款 D） | 委派 + 会话 + 记忆快照串成一条线（记忆快照客户端拉 `/x/agents/api/memory?agent=…` 的 Git 提交后追加） |

## 7. 这次的坑（都加了永久守卫）

1. **内联 `onclick` 引用的函数必须挂 `window`** —— 其它插件页（`sideview.js` / `detail.js` 早期）没包 IIFE，
   顶层函数自动是全局；`groupPage.js` 包了 IIFE ⇒ 不挂 window 就是「按钮点了没反应、页面不报错」。
2. **别把 `//` 注释拼进页面脚本字符串** —— 页面脚本是「拼出来的一长行」，`//` 会把**同一行后续所有拼接**吃掉
   ⇒ 花括号不配平 ⇒ 整段脚本 `Unexpected token '}'` ⇒ **页面所有交互静默失效**。
   ⇒ 守卫会**真的渲染页面 → 抠出所有 `<script>` → 逐块 `new Function` 解析**。
3. **别用 emoji 当唯一入口** —— 🧠 在该字体缺字形 ⇒ 按钮静默空白（用户截图里根本没有那个按钮）⇒ 改文字「面板」。
4. **响应式断点按信息优先级排**（见 §2）。
5. **插件版本同版本不重装** ⇒ 改了 `lib/*.js` 必须 bump 版本，IDE 才会拿到新码。
6. **pnpm 的 `file:` 安装会漏文件**（实测漏 `lib/activity.js`）⇒ 插件 import 失败 ⇒ **路由 404**，
   页面看起来 500 而源码是对的 ✗ ⇒ 探针装完必须强制同步源文件（`poc/dsh-p0/scripts/sync-installed.mjs`）。

## 8. 守卫与探针

| 文件 | 作用 |
|---|---|
| `dsh-plugins/check-agents-group-page.mjs` | **入库**守卫（40 项）：DOM 骨架 / DSB 版式常量 / 响应式 / 六 tab / 分组口径 / 主题化 / 工作台接线 / 活动·时间线 / 页面脚本可解析 / API 路径按次数 |
| `poc/dsh-p0/scripts/p3-153-agents-group-page.mjs` | 静态契约（26 项） |
| `poc/dsh-p0/scripts/p3-166-agents-group-page-interaction.mjs` | 真浏览器几何 + 交互（25 项） |
| `poc/dsh-p0/scripts/p3-167-agents-group-theme.mjs` | 真浏览器主题跟随（6 项：深/浅两套变量） |
| `poc/dsh-p0/scripts/p3-97-agents-mockup-parity.mjs` | 与 mockup 的结构对照（20 项，含 E6c/E6d 活动·时间线） |
| `poc/dsh-p0/mockups/group-chat-desktop.html` | DSB 桌面版群聊页交互稿（与实现同构） |
