# 网页抓取的「登录态 / 验证码 / 扫码 / Cookie」优化方案

> 面向平台：知乎、小红书、抖音、YouTube、微信公众号、博客
> 调研日期：2026-10-13
> 调研对象：本地 `G:\CustomWorkspaces\AIProjects` 下 8 个开源项目 + 2 次外部检索
> 结论落点：**`dsh-plugins/vssaros-browser`（Host 侧）为主**，IDE 壳侧只保留引导/审批 UI

---

## 0. 一句话结论

**登录态的正解不是"逆向 cookie / 模拟登录"，而是"让 agent 驱动用户已经登录好的真实浏览器"**——`browser-harness`、`Agent-Reach`（借 OpenCLI）、`openclaw`（extension relay）三个互不相关的项目独立收敛到同一结论。我们已有的 CDP 通道方向是对的，缺的是四件事：① 登录态的落盘与多账号；② 遇到登录墙/验证码/扫码时"停下并请人"的状态机；③ 平台路由表；④ 一条受控的 cookie 通道。

---

## 0.5 实施状态（2026-10-13 当日落地）

用户拍板「能力在 dsh 侧 + 做 cookie 通道」后，**P0 三项全部实现**。落点 `dsh-plugins/vssaros-browser`（0.1.0 → **0.2.0**）：

| 项 | 落点 | 状态 |
|---|---|---|
| **P0-1 登录闭环** | `lib/index.js` 新 op `login`（两次调用：打开页面 → `done:true` 验证）；`lib/core/loginProbe.js`（页面探针 + 两条独立证据的判据） | ✓ 守卫 8 条 + 真机验证 |
| **P0-2 登录墙单列** | `common/webPageQuality.ts` 新增 `kind: 'login-required'` + `LOGIN_WALL_PATTERNS` + 三分支文案；`webSearchParse.ts` 三路分派 | ✓ 单测 70 + 5 |
| **P0-3 cookie 通道** | `lib/core/cookies.js`（纯逻辑）+ `lib/core/cookieStore.js`（原子写 I/O）+ op `cookies`（`inspect`/`export`/`import`） | ✓ 真机 12/12 |

**与方案的偏离（重要）**：§5 写的"复用 `__clarify__` 卡片协议" **在 Host 侧不成立** —— 那套协议与渲染在 IDE 聊天面板里，Host 是常驻进程、没有渲染进程。所以 `login` 落地为「**两次调用 + 文本指引**」：不带 `done` 时把页面开好并返回"请你自己去登录 + 绝不索要凭据"的指引（模型转达、用户看得见窗口）；用户说好了之后模型带 `done: true` 再调一次做**验证**。它比卡片弱，但**不依赖壳、完全可用**；卡片体验可作为壳侧后续增强。

**实现时被守卫/真机抓出来的三个真问题**（都已修）：
1. **通用 cookie 名启发式命中不了主流中文站点** —— 知乎的登录 cookie 叫 `z_c0`、微博叫 `SUB`，通用词表（session/token/auth…）一条都不匹配 ⇒ "明明登录了却判没登录"。修法：补**按站点白名单**（zhihu/xiaohongshu/bilibili/douyin/weibo/youtube/x/twitter/reddit/github/linkedin），并把短名字（`a1`/`ct0`/`SUB`）从通用表移出 —— 守卫钉住"白名单必须**按站点**生效"（换站点就不认）。
2. **只读 op 会凭空开 tab** —— `checkLogin` 原实现会经 `page()` → `ensurePage()` 新建 about:blank（凭空开页不是"只读"该有的副作用）。修法：没有已协商页面时**不协商**，页面证据记"不可用"（cookie 证据独立成立）。守卫用**假 invoker 记录请求**钉死（不是源码文本断言）。
3. **跑一次真机测试就漏一批 headless Chrome** —— `launchDedicatedChrome` 是 `detached + unref`（**故意**：用户可能正在那个窗口里登录）；但积累几次后，后续 E2E 从 2.5s 变成 **20s 超时**，症状与代码回归**一模一样**。修法：E2E 的 finally 加 `taskkill /PID <dedicatedPid> /T /F` 兜底（`CdpHost` 为此暴露只读 `dedicatedPid`）。

**验证证据**：
- `dsh-plugin/dshBrowserPlugin.test.ts` **17 passing**（域名后缀边界 / 净化丢 `expires=-1` / 存档判别式 / 登录三态 + 冲突 / 不得凭空开 tab / 两道闸且文案说真话 / 开关拒掉时**不弹审批**）；
- `webSearchParse.test.ts` **70 passing**、新增 `browserPageWallNotice.test.ts` **5 passing**；
- **反向突变 3/3 逐条命中**（域名边界 / 凭空开 tab / `login-required` 退回 `unavailable` ⇒ 连 `sync-snapshot --check` 一起红）；
- **真机 12/12**（`sync-snapshot --check` 绿、工具面快照一致 11 插件 / 85 工具、tsgo 0、`check:dsh-plugins` 违规 0、真机：读到 cookie → 导出落盘 → 清空 → **注入回** → 空集注入如实报 0 → 别的域名过滤为空）。

### P1-1 平台路由表（同日落地）

**单一真源** `common/webPlatformRoutes.ts` 的 `WEB_PLATFORM_ROUTES`：13 条平台 × `{ hostPatterns, type, backends[], needsLogin, risks[] }`，其中 `backends` 是**有序候选通道**（`[0]` 即首选；"顺序即语义"的口径照搬 Agent-Reach `channels/base.py`，另含"除兜底外不许有全能匹配正则"这条防截胡约束）。两个消费点收归一份：

1. **宿主「导入链接」按钮**：`kbUrlScraper.ts` 的 `KB_URL_PLATFORMS` / `detectPlatform` 改为**由真源派生**（值逐字不变）—— 原先那 13 条手写表已删，消除了"宿主一份、skill 一份、彼此不知情"的静默漂移面；
2. **agent 侧 skill**：`web-content-import/SKILL.md` 的表格由守卫**对账**（平台集合 + 每行写出首选通道 + 兜底不许截胡）。

**顺带修掉的真实缺陷（本轮最值）**：SKILL.md 通篇教模型调用 `browser_navigate` / `browser_snapshot` / `browser_get_images` —— 那是**已退役**的 IDE 侧工具名（Host 侧只剩**单个** `browser` 工具的 `op`）。已全部改为 `` `browser`（`op: "..."`） `` 形式（表格 / 第 1 步 / 第 3 步 / 媒体节 / 工具清单共 6 处），并把登录墙处置从"请用户登录一次"升级为**闭环三步**：`op: "login"` 打开页面 → 用户自己登录（扫码也行）→ `op: "login"` + `done: true` **验证** → 通过后再 `op: "snapshot"`；并写死"**不要对着同一堵墙重试**"。

**一次撞车与订正**：`builtinSkillContracts.test.ts` 有一条 2026-09-24 写的断言是"SKILL.md 必须提到 `browser_get_images`"——与本次新守卫**直接对撞**。核实后确认旧断言已过时（工具真的退役了）⇒ 改为 `/op: "images"/`，并在注释里写明"不改的话它会把手册改用新工具名当成回归"。

**验证**：新增守卫 `test/browser/webPlatformRoutes.test.ts` **8 passing**（结构契约 / 除兜底外不许全能匹配 / 顺序即语义的期望表且表不许腐烂 / needsLogin / 宿主派生逐条一致 / 宿主动作回归 / skill 对账 / SKILL.md 不许再出现已退役工具名）；**反向突变 3/3 逐条命中**（真源调换顺序 / 宿主少一条 / SKILL 某行写错通道）；连带全绿：`builtinSkillContracts` 19、`webSearchParse` 70、`browserPageWallNotice` 5、`schemaCorrector` 22；`tsgo 0`。

> ★ 守卫里的"宿主动作回归"**带自原 `kbUrlScraper.test.ts` 的 17 条代表性用例** —— 那个文件用 `describe/it`（BDD）且不在任何 runner 的发现范围里（`test/browser/*` 只扫本目录、`test/unit/node` 整体排除 agentStudio）⇒ 它**等于没有回归网**。改派生时顺手把它救回到一个真会跑的套件里。

### P1-2 「谁做下一步」的枚举（同日落地）

`common/webPageQuality.ts` 新增 `ManualAction`（8 值：`login-required` / `app-only` / `captcha-required` / `browser-check` / `rate-limited` / `permission-required` / `content-gone` / `unknown`）+ `MANUAL_ACTION_NEEDS_HUMAN` + `assessManualAction()` + `manualActionLine()`，另有 `WEB_PAGE_QUALITY_SIGNAL_LABELS`（四张特征表的全部标签，供守卫遍历）。

三点设计：
1. **按 signal 标签映射，不是只按 kind** —— 同一个 `interstitial` 里"只有人能过的验证码"（`captcha-required`, needsHuman=yes）与"重试就好的反爬"（`browser-check`, needsHuman=no）下一步完全不同；`login-required` 与 `app-only` 都要人，但要做的事不一样。
2. **两条通道都带**，且都在**最后一行**：`browserPageWallNotice`（经 `finishWallNotice` 收尾）与 `webExtractBlockedMessage`（唯一入口处收尾）。格式固定为 `manualAction: <action> (needsHuman=yes|no) — <hint>`。
3. **Host 侧同源**：`loginProbe.judgeLoginState` 也带 `manualActionText`，但文本**由真源生成**（经生成物 `snapshot.js` 转出），Host 只存字符串 ⇒ 措辞零漂移。

**防腐烂守卫**：断言"**每个已登记的特征标签都归入某个 manualAction**"（行为级：构造只含该 label 的假 quality 喂给 `assessManualAction`）—— 新增特征忘登记动作就红。反向突变删掉 `captcha` 那条映射 ⇒ 守卫点名报出 `captcha` ✓。

### 多会话隔离（用户新增要求，同日落地）

**问题**：`browser` 的"当前页"在 `CdpHost` / `BrowserCdpClient` 里是**单值**，而 `CdpTargetManager.ensurePage` 还有一条"URL 匹配 ⇒ 抢用现有 tab"的分支 ⇒ 两个会话并发时会落到**同一条 tab**：互相顶掉页面，并互相清除 `data-saros-ref` 标记（ref 是**页面级**属性）⇒ 症状是"ref 忽然全部失效 / 点到别人页面上"。

**解法**：以 dsh 的 **SessionId** 作归属键（`exec.agent.id`；类型见 `@deepseek-ai/dsh-agent` 的 `interface Agent { readonly id: SessionId }`）：

| 层 | 改动 |
|---|---|
| `CdpTargetManager` | `_owned: Set` → `_ownerOf: Map<targetId, ownerKey>`；**有键时只复用自己名下的 tab、禁用 URL 匹配分支**（那正是串台来源）、没有就新建；无键（旧路径/测试/诊断）保持原行为；新增 `ownedCountOf()` |
| `closeOwned` | 按**归属相等**拒绝（`''` 也只关 `''` 的 —— 否则隔离可绕过） |
| `BrowserCdpClient` | 新增 `forSession(key)` 绑定视图 ⇒ **每个会话各持自己的页面缓存**；`page` / `navigate` / `openForLogin` / `closeOwnedPage` 都透传键 |
| `index.js` | `execute` 用 `sessionKeyOf(exec)` 取键（抽成**可单测的纯函数**；畸形 id 一律不猜 ⇒ 退化为不隔离）；handlers 改为 `createHandlers(client)` 工厂 |

**真机抓到的那个 bug**（本轮的教训）：`navigate` 里的 `ensurePage` **漏传了键** ⇒ 走"无会话"分支 ⇒ 复用别的会话的 tab。真机实测：两个会话拿到**同一个 targetId**、A 的点击落到 B 的页面上（`clicked-B`）。修完补了守卫"**每个会协商页面的入口都必须带键**"（假 invoker 记录每次 `ensurePage` 的 `key`），反向突变验证它能抓住这个 bug ✓。

**为什么不动 `isConcurrencySafe`**：官方语义是"**同一步内**能否与 sibling 并行"（`schema.d.ts:199-203` 的"Whether this call may join a parallel group"），不是全局锁 ⇒ 跨会话本来就不受影响。保持"动作类 false"反而防住了"同一会话内并发动作乱序"。

**验证**：隔离守卫 **10 passing**（各拿自己 tab / 同会话复用 / **URL 匹配不抢** / 断线重连回自己那条 / 用户关页销账 / 跨会话关页拒绝 / 无键保旧行为 / `sessionKeyOf` 不猜 / 键透传 / 每入口必带键）；**反向突变 4/4 逐条命中**（`navigate` 漏键 / owner 检查失效 / 关页校验去掉 / `captcha` 映射删掉）；**真机 14/14**（两会话并发驱动真实 Chrome：不同 target、B 导航后 A 的当前页不变、B 快照后 A 的 ref 仍有效且点得动、A 关页不影响 B、跨会话关页被拒、A 重开不碰 B）；`tsgo 0`、工具面快照一致（11 插件 / 85 工具）、`check:dsh-plugins` 违规 0。插件版本 0.2.0 → **0.3.0**。

### 多会话隔离的闭环：会话结束回收 + 反检测基线（同日落地，插件 0.3.0 → **0.4.0**）

**回收**：订阅 `agent/disposed`（payload `{ agent }` —— `agent.id` **就是**归属键，不必猜、也不必自建会话表）⇒ `CdpHost.closeSessionPages(key)` 逐个 `closeOwned`。三条纪律：

1. **`_conn` 为空就直接返回**（`skipped: 'never-connected'`）—— 我们是**懒连接**的，为"关页面"去连一次 CDP、在没配的机器上还会因此**拉起**浏览器，是本末倒置；而"从没连过 ⇒ 不可能建过 tab"是确定的事实；
2. 归属校验交给 `closeOwned`（用户的标签页永不受影响）；单条失败**不抛**（会话正在结束，没人能处理这个异常）；
3. 订阅 handler **不 await**（与 `vssaros-memory` 挂 `agent/turn-stopping` 同一条纪律）+ try/catch **降级**（事件表随版本变，失败就退回"不回收"）+ `ctx.on` 的返回值归一成函数（假 ctx 可能返回 `undefined`）。

**反检测基线**：`buildDedicatedChromeArgs` 加 `--disable-blink-features=AutomationControlled`，**dsh 侧与 IDE 侧（`common/chromeDebugSetup.ts`）同一行**（守卫钉两侧一致 —— 否则症状是"有时能过检测、有时不能"）。三条明确的**不做**：不注入 JS 补丁（会被反向识别）、不换内核、不改 UA。

**真机又抓到一个竞态**：`Target.closeTarget` **是异步生效的** —— 命令返回 ≠ 已从 `Target.getTargets` 消失。首版断言"关门后立刻查"当场就红了（其实正在关）⇒ 测试加 `waitGone()` 轮询。与前面那次"孤儿 Chrome"同一类教训：**真机断言要看最终状态，不是命令返回**。

**验证**：新增守卫 **4 passing**（冷启动短路 / `ownedTargetsOf` 只列本会话 / `agent/disposed` 确实接上且 handler 容错 / 反检测两侧一致 + 三条边界）；E2E 并入**真机会话回收**段（A 回收后确实从 target 列表消失、B 完好、A 再用时新建而不是复活死页）；**反向突变 4/4 逐条命中**（去掉短路 / 忽略归属 / 改事件名 / 删参数）；`tsgo 0`、工具面 85 工具一致、`check:dsh-plugins` 违规 0；`dshHarness --common` **439 passing**（1 条失败在并发会话在改的 `vssaros-kb`）。

### 受控 `evaluate`：页面里取值（同日落地，插件 0.4.0）

**缺口来源**：`web-content-import/SKILL.md` 自己写着「我们**没有**『在页面里执行任意 JS』的工具」—— 于是"SPA 挂在 `window` 上的页面数据、按选择器批量取属性"这类需求只能退回 `execute_code` + 公开直连 URL，多数情况下取不到。这是**现成的、文档自己承认的**能力缺口。

**为什么不是"加个 eval 就行"**：页面里的 JS 是图灵完备的 —— 它能读该页的 cookie / localStorage。而 `cookies` op 刻意保证"凭据值**不进上下文**"，`evaluate` **做不到**这个保证。既然保证不了就不假装，改成**三道约束**：

1. **默认关闭**：独立开关 `allowEvaluate` / `VSSAROS_BROWSER_ALLOW_EVALUATE=1`（与 `allowActions` **分开** —— "能操作浏览器"与"能在页面里跑任意代码"不是一回事）；
2. **逐次审批**，且**审批文案回显那段代码**（`describeEvaluate`）—— 本 op 最重要的设计点：其余 op 的语义由 op 名定死（`click` 就是点击），而 `evaluate` 的语义**完全由表达式决定**。**用户批的必须是代码，不是"某个叫 evaluate 的动作"**；
3. **有界输出**：表达式 ≤4000 字符；结果 ≤8000 字符（截断并标注丢了多少）；超时夹在 1s～120s。

还有一条顺序硬约束：**开关与表达式校验都在审批之前**（`precheckEvaluate`）—— 开关关着还去问用户，就是一次必然被拒的询问（审批疲劳正是这么来的）。守卫专门钉了这条。

**真机抓到两件事**（都写进了代码注释，因为结论反直觉）：
- `awaitPromise` 必须开：用户的抽取代码常是 async，固定 `false` 等于逼他们绕道；
- **活对象在协议层判不出来**：CDP 对 `document.body` 既不报错、也不回 `objectId`，而是**静默序列化成 `{}`**（`{result:{type:'object',value:{}}}`）—— 与"页面**真的**返回了 `{}`"**无法区分**。所以 client 层拦不住（那里的检查只覆盖其它 CDP 形态），补救是渲染层对空对象给一条**可行动**提示（改成 `el.outerHTML` / `el.textContent`）。E2E 里留了一条**行为锚点**：CDP 哪天改了行为，那条断言必须红。

**文档与能力对齐**：`web-content-import/SKILL.md` 里那句"没有执行 JS 的工具"已改写（否则模型永远不会想到用这条通道），并有守卫钉住它。

**验证**：新增守卫 **11**（表达式校验 / 默认关**不弹**审批 / 无审批通道 fail-closed / **审批回显代码** / 被拒即不执行 / op 表与并发判据 / 渲染与截断 / 空对象提示 / 超时夹取 / 预览 / 文档对齐）+ E2E **真机 4 条**（同步取值、async 取值、活对象行为锚点、页内异常转工具错误）；**反向突变 3/3**（去截断 / 去回显 / 回退文档）；`tsgo 0`、工具面快照已 `--write` 并复查一致、`check:dsh-plugins` 违规 0、`sync-snapshot --check` OK；`dshHarness --common` **451 passing**（1 条失败在并发会话在改的 `vssaros-kb`）。
**顺带被守卫抓到一次真问题**：新文件没进 `package.json` 的 `files` ⇒ 打包会缺文件（`dshPluginPackages` 守卫）。

**仍未做（P2）**：`site-<host>` 薄技能、命名 profile 多账号、代理支持（`--proxy-server`，调研结论是"别照抄，但桌面 IDE 场景可能需要"）。

> ⚠ 关于 `site-<host>`：本轮**刻意没做**。调研里 browser-harness 的 90+ 个 `domain-skills/<site>/` 确实是正解形态（薄、按需加载），但那种技能装的是**实测出来的站点操作细节**（页面结构、翻页方式、登录入口在哪）。凭印象写出来的只会是"看起来具体、其实没验证过"的伪知识 —— 与"文档必须与能力对齐"是同一个纪律。它应该**从真实抓取日志里长出来**：先攒几个平台的实战记录，再逐个落成技能。

## 附：真机失败复盘与修复（2026-10-13，用户提供的两张运行截图）

**现象**：模型**正确地**按登录墙文案去调 `browser.login` ⇒ **先弹授权卡** ⇒ 用户点"允许一次" ⇒ **然后才失败**，错误是裸的 `fetch failed`；随后 `status` 也只给出 `fetch failed` ⇒ 模型只能自己猜 "Chrome not running with CDP"。而**实际有两条现成的出路**（请用户开一次远程调试 / 由工具自动拉起专属实例）**没有任何人告诉它和用户**。

**错误链（逐跳）**：
`browser.login` → `isActionOp` 为真 ⇒ `requestConsent`（**先问用户**）→ handler → `_connection()` → `connectPreferredEndpoint` → `discoverEndpoint` 的 `fetch('http://127.0.0.1:9222/json/version')` → 端口无人监听 ⇒ undici 抛 `TypeError: fetch failed` → `host.js` 的 `if (!winner)` 分支 `first.ok ? new Error('CDP 端点全部不可达') : first.error` ⇒ **`first.ok` 恒为 false**（有 winner 就提前返回了）⇒ **那句人话是死代码，真正抛出去的是裸的 `first.error`**。

**四个缺陷与处置**：

| # | 缺陷 | 处置 |
|---|---|---|
| 1 | **不可达时工具仍对模型可见**（IDE 侧原本"只在探测到端口可达时才出现"，移植时把这个门控丢了） | ⚠ **本轮未修**：彻底修法需要 dsh 支持动态工具集（单独一趟）；本轮用"**前置拒绝 + 可读指引**"作为等价物 |
| 2 | **审批发生在"必然失败"的检查之前**（用户白点一次"允许一次"） | ✅ 新增 `CdpHost.ensureReachable()` + `requireReachable(op)`，插在 `requestConsent` **之前** |
| 3 | **错误不可读**，且现成的指引没用上 | ✅ 新增 `explainEndpointFailure()` 做翻译 + `core/unreachable.js` 的 `unreachableMessage()`（含"重试无用"与三条出路） |
| 4 | **IDE 的 CDP 设置到不了 Host**（`cordis.patch.yml` 是 `config: {}`）⇒ Host 侧 `launchDedicated` 默认 **false**，而 IDE 侧同名设置默认 **true**、UI 写着"开箱即用" | ✅ Host 侧默认值改为 **开**（与 IDE 侧对齐）；要关就显式关 |

**门控的两条"不拦"**（每条都会把本来能走通的路堵死）：
- `launchDedicated` 开着 ⇒ "连不上"**不等于**"会失败"：`_connection()` 会自己拉起专属实例；
- `op: "status"` ⇒ 它的**存在意义**就是如实报告"连不上"（它本身就是诊断入口）。

**缓存规则**（`ensureReachable` **只缓存失败**，10s）：已连接直接放行（连接在手是最硬的证据）；失败缓存 10s（短到"用户刚开好调试就能立刻成功"，长到"连试几个 op 不会每个都白等一次探测"）；成功但未连接不缓存。

**验证**：新增守卫 **10**（四种错误的翻译 / 文案含三条出路与"重试无用" / 两条路互斥 / 端口非 9222 要提醒 / `ensureReachable` 的可读原因 + 失败缓存 + 已连接短路 / **★ 不可达时 `approvals` 必须为空** / `status` 不受门控 / 默认 `launchDedicated === true` / 显式关生效 / 描述含"别重试"）；**反向突变 3/3**（去掉翻译 / 把门控挪到审批之后 / 去掉"重试无用"）；`tsgo 0`、工具面 `--write` 后一致、`check:dsh-plugins` 违规 0。全套 `dshHarness --common` 剩 **2 条失败，均属并发会话**（`vssaros-kb` 的只读边界、`dshHostSupervisor.ts:1702` 的同步写）。

**也记一笔：模型的行为本身是错的吗？不是 —— 是对的。** 它按我们的文案放弃了重试、去调 `status` 诊断、最后诚实退回本地可验证证据（用户问的"为什么要用 MCP"本是概念问题）。**问题全在工具的可用性与文案**：一条现成的路没被说出来。

**用户侧待办**：① 配 `DEEPSEEK_API_KEY`（否则 `web_search` 不可用，兜底通道也断）；② **重启 Host** 让 `launchDedicated` 的新默认值生效（Host 是常驻进程）。

### 缺陷 1 的彻底修法：工具可见性门控（同日落地）

上一节把缺陷 1 记成"未修"，随后取证发现 **dsh 侧做得到**，于是补上：

- `ctx.tools.register(def)` 返回 disposer，**可在运行时注销**（先例：`vssaros-codebase` 的 `ctx.effect(() => { const ds = […].map(d => ctx.tools.register(d)); return () => ds.forEach(d => d()); })`）；
- `@deepseek-ai/dsh-tools` 的 `'tools/change'` 事件（`@mode emit`，**不做 scope 过滤**）文档原话："A tool was registered or unregistered… a global change concerns **every agent's next assembly**" ⇒ 增删会反映到模型看到的工具面，**不需要我们额外通知**。

**做法**：把工具定义抽成常量（注册/注销共用同一份，避免漂移），按"此刻到底能不能用"决定 register / dispose：

| 条件 | 行为 |
|---|---|
| `launchDedicated` 开（"有兜底"） | **同步注册**（零延迟，也不必先探测）—— "连不上"不等于"用不了" |
| 关 + 探测通 | 注册（异步首探：**通了才露面**） |
| 关 + 探测不通 | **不注册**（模型看不到）—— 这就是缺陷 1 的修法 |

外加 **30s 周期重探**（与 IDE 侧"至多 30 秒重探一次"同口径），定时器 **`unref()`**（绝不阻塞 Host 退出），卸载时 `dropRegistration()`（不留孤儿注册 —— 两个同名工具会让整条 entry 失效）。

**与 `requireReachable` 的分工**：重探有 30s 窗口（刚断开时工具还在列表里）⇒ 前置拒绝仍是必要的第二道防线；两者用**同一条判据**（`launchDedicated` 关 **且** 探测不通），判据不一致就会互相打架。

**让路标记不参与门控**：`provide('vssarosBrowser')` 决定的是"IDE 侧那套 `browser` 要不要让位"，必须在装配期**静态**定下来（异步撤一个 provide 没有意义）。所以极端情况是"两边都没有 browser 工具"—— 那是**对的**：此刻浏览器就是不可用，给模型一个假入口更糟。

**技能同步**：`web-content-import/SKILL.md` 补了一段"**先看 `browser` 在不在你的工具列表里**"（不在 ⇒ 如实请用户去开一次远程调试，并先用文本通道尽力回答）—— 工具会动态消失，模型必须能解释这件事，否则它要么以为工具坏了、要么干等。有守卫钉住这段。

**验证**：新增守卫 **4**（无兜底且不可达 ⇒ **不在工具面里**（等 400ms 再断言，排除"探测还没跑完"的假象）/ 有兜底 ⇒ 同步注册 / 通了才露面 + 断开后拦住授权前的调用而 `status` 仍可诊断 / 卸载 ⇒ 注销）+ 文档断言 2 条；**反向突变 2 条命中**（门控失效改成永远注册、卸载不真撤 ⇒ `1 !== 0`）；全套 `dshHarness --common` **486 passing / 1 failing**（唯一失败仍是并发会话的 `vssaros-kb`）。

⚠ **测试里踩到一个真坑（值得记）**：假 CDP 端点的 `server.close()` 会**永远等** `fetch` 留下的 keep-alive 连接 ⇒ 测试挂死。必须先调 `server.closeAllConnections()`。

## 附二：`site-<host>` 为什么还没写 + 挖出的一个同构真问题（2026-10-13）

### 一、素材取证：结论是**不够，所以不写**

按承诺（"`site-<host>` 要从**真实抓取日志**里长出来"）去挖了本机记录：

| 查了什么 | 结果 |
|---|---|
| `~/.vssaros-dev/chat-history/**`（215 `json` + 13 `jsonl`） | 按平台关键词（小红书/知乎/抖音/YouTube/B站/公众号）命中 15 个文件，但 **`.jsonl` 只存 assistant 文本**（事件全是 `op:"a"`），**没有工具调用与结果** |
| `chat-history/**/*.sidecar/tool_*.json`（14 个） | 这些**是**工具结果原文，但只有 2 个含外部 URL，且都是**技术博客 / GitHub / npm** —— **没有任何目标平台** |
| `~/.vssaros-dev/dsh-run/harness-*.log`（41 个） | 只有 Host 启动信息（KB 级），无抓取细节 |
| `~/.vssaros-dev/logs/*.log`（320 个） | 按 `browser_*` / `xiaohongshu` 等搜：**零命中** |

⇒ 凭现有记录写出来的 `site-<host>` 只能是**伪知识**（"看起来具体、其实没验证过"），与"文档必须与能力对齐"直接冲突 ⇒ **不写**。

⇒ 要让素材长出来，唯一可靠的路是**真的用一次并留下结构化轨迹**（平台 + op + 结果特征 + 耗时）。在那之前，`web-content-import` 第 0 步那张平台表的"已知坑"列就是现有的最好版本。

### 二、顺带挖出一个**同构**的真问题（已修）

核对工具面时发现：**Host 侧 91 个工具里没有** `web_extract` / `web_search` / `video_analyze` / `extract_video_frames` / `vision_analyze` / `execute_code` —— 它们全注册在 **IDE 侧**（`agentStudio/browser/providers/tool/**`）。而 `web-content-import/SKILL.md` 把它们当**主路径**，**我上一轮写的 `unreachableMessage` 也点了 `web_extract`**。

这与真机事故是**同一个病**：让人去调一个手里根本没有的工具（只是那次的工具是 `browser`、这次是 `web_extract`）。三处处置：

1. **`unreachable.js` 第 3 条**改成"换你**手上确实有**的文本通道"，并明说"Host-only 没有 VsSaros 内建的那批工具"——
   ⚠ 但**刻意不写它们的名字**（写了就会有人照着调；守卫也钉着这条）；
2. **`SKILL.md` 新增「第 -1 步：先核对你的工具面」**：一张"谁有哪个工具"的对照表 + 总则"**不在你的列表里就当作不存在**" + 缺 `web_extract` / `video_analyze` / `browser` 三种情形的降级路径（视频那条尤其重要：Host-only 下**整条视频链路都不存在**，没有 ASR ⇒ 必须如实说拿不到，而不是凭印象编）；
3. **新增守卫 3 条**：
   - 技能提到的 IDE-only 工具必须标"仅 IDE 侧"，且**首次提及那一行**必须标（⚠ 跳过 frontmatter —— 第一版断言抓到的是 `description` 行，那只是技能索引，不是手册正文）；
   - **不可达文案不许点名** IDE-only 工具（这条直接钉住我上一轮犯的错）；
   - 技能必须带"按实际工具面选路"的总则。

**验证**：**反向突变 2/2 命中**（文案点名 `web_extract` / 对照表行去掉声明）；本组守卫 **59 passing**；全套 `dshHarness --common` **489 passing / 1 failing**（唯一失败仍是并发会话的 `vssaros-kb`）。
**另记一条代码侧残留**（不在本轮范围，属 browser 族迁移收尾）：`toolsetConfig.ts` 的 ALWAYS 名单、`schemaCorrector` 的提示串、`toolGuardrailController` / `toolExecutionGuard` / `agentToolIsolator` 里**仍写着已退役的 `browser_*` 工具名** —— 与 SKILL.md 同一类腐烂，但它们在 `src/` 并发会话的地盘上，未动。

---

## 1. 调研方法与取证等级

| 来源 | 方式 | 可信度 |
|---|---|---|
| `browser-use` / `browser-harness` | 读源码（Python，含 cloud 侧占位） | ✓ 已核对 |
| `Agent-Reach` | 读源码（channel + backends + cookie_extract） | ✓ 已核对 |
| `openclaw`（`extensions/browser/**` + `src/plugin-sdk/browser-*` + `docs/tools/browser*.md`） | 读源码 + 读文档 | ✓ 已核对（文档最完整） |
| `defuddle` / `obsidian-clipper` / `BiliNote` / `Hyper-Extract` | 读源码 | ✓ 已核对 |
| `pi-computer-use` | 读源码（浏览器占比小） | ✓ 已核对 |
| OpenCLI（`jackwener/OpenCLI`）、反检测生态 | 外部检索（非本地源码） | ◻ 二手，待自验 |

> 未纳入：MediaCrawler / Spider_XHS（本地无源码）。历史结论（见 `project_web_retrieval_plan.md`）：这两家 59.6k★ / 7.8k★ 主动放弃 JS 签名逆向，改"浏览器现取签名"——**方向与本方案一致，不需要重走**。

---

## 2. 六条横切结论

### 2.1 登录态：三级解法，优先级不可颠倒

| 级别 | 做法 | 谁在用 | 代价 |
|---|---|---|---|
| **L1 复用真实浏览器** | CDP attach / 扩展中继，直接用用户日常 Chrome 的 profile | `browser-harness`（默认 attach）、`openclaw`（`extension` driver）、OpenCLI（BrowserBridge 扩展） | 需用户配合一次（勾选/装扩展）；能力可能被砍 |
| **L2 导入 cookie** | 把用户浏览器的 cookie 复制进隔离 profile | `openclaw`（macOS `action=importprofile`，SQLite `VACUUM INTO` 快照 + Keychain 解密 + `cookiesSetManyViaPlaywright` 注入） | 平台校验（DBSC）可能仍要求重登；cookie 属敏感凭据 |
| **L3 模拟登录** | agent 自己填表单 | **三家都不做** | 触发风控/锁号；凭据进模型上下文 |

**关键细节**（可直接搬）：
- `browser-use` 的 `export_storage_state()` 用 **CDP `Storage.getCookies`** 导出**已解密** cookie（`session.py:1437-1480`）——绕开 keychain 依赖，比自己去读 Chrome 的加密库稳得多。
- `browser-use` 的 `StorageStateWatchdog` **只存 cookie 是不够的**：`localStorage/sessionStorage` 里放 auth 的站点还需 `Page.addScriptToEvaluateOnNewDocument` 补注入（`storage_state_watchdog.py:286-305`）。
- `openclaw` 的登录态**不由 storageState 承载，而是整个 `user-data-dir`**（`chrome.ts:716-717`：`resolveOpenClawUserDataDir(name) = CONFIG_DIR/browser/<profile>/user-data`）⇒ 天然持久、天然多账号。
- `openclaw` 的 `profile="user"`（existing-session）走 **Chrome DevTools MCP**，能力被砍（无 batch/download/pdf/requests/text/emulate）⇒ **不要把"接用户浏览器"做成唯一主力通道**。

### 2.2 验证码：**没有任何一个开源项目自研打码**

- `browser-use`：OSS 侧只有**骨架**——`CaptchaSolverStartedEvent/FinishedEvent`（`events.py:605-633`）+ `wait_if_captcha_solving()`（`service.py:1044-1060`），注释明写"started **by the browser proxy**"；全仓 grep `capsolver/2captcha` **零命中** ⇒ 真正解决在云（stealth + 住宅代理 + 打码）。
- `browser-harness`：完全不碰，`SKILL.md:148,192` 只说"遇到就 stop and ask / 换 Cloud"。
- `openclaw`：**无打码集成**（全仓 grep `capsolver|2captcha` 零命中）；`docs/tools/browser.md:24-26` 把 login/2FA/captcha/摄像头权限**一律定义为 manual action，不许猜**。

**可搬的是"分类 + 暂停等待"这套骨架**（`wait_if_captcha_solving` + `openclaw` 的 manual-action 枚举），不是打码本身。

### 2.3 扫码登录：正确做法不是"解码二维码"

**所有项目都没有二维码解码**（`openclaw` 全仓搜 `qrcode|扫码|otp|2fa|totp` 在浏览器子系统 0 命中；本仓的 `feishuQrCode.ts` 是**生成**二维码，用途无关）。

正确形态是三步，且**判据必须来自页面本身而不是截图识别**：

1. 打开目标站登录页（真实窗口，非无头）；
2. 告诉用户"请在这个窗口用手机扫码"（`__clarify__` 卡片结束当轮）；
3. 用户点"我好了"后**用页面判据验证**（登录后特有的 DOM/cookie/接口），成功才继续，失败如实报告而不是硬闯。

### 2.4 反检测：真实浏览器 > 参数伪装 > JS 补丁

| 手段 | 谁用 | 评价 |
|---|---|---|
| 连**真实 Chrome + 真实 profile + 非无头** | `browser-harness`（默认）、`openclaw` 的 extension driver | **最强，且零维护**——`browser-harness` 连 `navigator` 补丁都没有，因为不需要 |
| `--disable-blink-features=AutomationControlled` | `browser-use`（`profile.py:201`）、`openclaw` 的 `extraArgs`（**默认不加**） | 最保守的一条，值得加 |
| JS 注入 `navigator.webdriver=false` / `plugins` / `chrome.runtime` | **三家都没有**（`browser-use` 全仓 grep 为空） | 不推荐：现代检测能识别"被 patch 过的属性" |
| 自建指纹伪装 / 换内核 | Camoufox（改 Firefox 内核 + Juggler 协议）、Patchright、Rebrowser、Nodriver ◻ | 成本高；与我们"用用户真实浏览器"的路线**冲突**，不建议引入 |
| 云侧 stealth + 住宅代理 | `browser-use` Cloud、Browserbase/Notte | 可作为**用户显式配置的外部后端**，不内置 |

**反向警告**：`openclaw` 托管 Chrome 默认加 `--no-proxy-server` 并剔除全部 `*_PROXY` 环境变量（`chrome.ts:767-769`、`browser-proxy-mode.ts:43-50`）——对"需要代理出口"的抓取是反向的，我们**不能照抄**。

### 2.5 平台路由：有序候选数组 + 真跑探活（Agent-Reach 范式）

- 路由单元 = 每个平台一个**有序数组**，`backends[0]` 首选，其余按序降级（`channels/base.py`）；用户可用配置键强制某个后端（`ordered_backends()`）。
- 例：小红书 `["OpenCLI", "xiaohongshu-mcp", "xhs-cli"]`（`channels/xiaohongshu.py:163`）、Twitter `["twitter-cli","OpenCLI","bird CLI"]`、YouTube `["yt-dlp"]`。
- **探活纪律**（值得逐条照搬）：`probe_command()` 真执行 `--version`，区分 `ok/missing/broken/timeout`（`probe.py:47-120`）；`broken` 特指"which 到但 exec 失败"（陈旧 venv shebang）。
- **一条血泪教训**：`opencli doctor` 会自启动 daemon（有副作用）⇒ 健康检查**绝不能用它**，只信 `--version` + 只读 loopback `http://127.0.0.1:19825/status`（`backends/opencli.py:8-17`）。
- **"装了 ≠ 能跑 ≠ 真取到内容"三层必须分开**：`doctor` 成功不代表目标视频有字幕，成功标准是"拿到非空内容"。

### 2.6 内容层：提取内核可插拔 + 站点特化 + 登录墙显式识别

- `defuddle`（`obsidian-clipper` 直接复用它）：Readability 派系自研，**28 个站点特化提取器**（`src/extractor-registry.ts`：twitter/x-article/reddit/youtube/bilibili/github/medium…），并**显式识别登录墙**（`src/extractors/reddit.ts:52-59` 用最终 URL 是否 `/login/` 判定）。
- `Agent-Reach` 也有反爬特征表（`channels/web.py:15-31`：扫前 4096 字节，命中 Jina captcha 警告或 Cloudflare `attention required` + `ray id` 即判拦截）。
- ⇒ 与本仓 `common/webPageQuality.ts` 是**同一件事**，我们已经有（4 张特征表 + `classifyExtractQuality`），只需**扩展 kind 与文案**，不必引入新依赖。

---

## 3. 各平台难点与推荐通道

| 平台 | 未登录可见 | 主要风控 | 推荐通道（按序） |
|---|---|---|---|
| **知乎** | 部分问答可见，详情页/专栏常拦 | 登录墙 + 频率限制 | `web_extract` → 真实浏览器 profile → 登录后重试 |
| **小红书** | 几乎不可用（占位页"你访问的页面不见了"） | 登录墙 + `xsec_token` 绑定（重开笔记必须带原 token，否则跳 app-only 404） | 真实浏览器 profile + 保留 `xsec_token` → `browser` 快照 |
| **抖音** | 分享页有限可见 | 签名（`a_bogus`）+ 风控 | 真实浏览器 profile → 页面内 DOM 取数；**不做签名逆向** |
| **YouTube** | 大部分可（`ytInitialPlayerResponse` / oEmbed 免登录） | 无（age-restricted 除外） | `video_analyze`（yt-dlp 字幕轨）→ 浏览器仅取评论等登录专属 |
| **微信公众号** | 正文可读（`mp.weixin.qq.com`） | 频控 | `web_extract` → 本地缓存 |
| **通用博客** | 可读 | Cloudflare 挑战 | `web_extract` → 命中挑战页时**不重试**，换通道或上报 |

> 表里"小红书 xsec_token"与"YouTube 免登录入口"来自 `browser-harness` 的 `agent-workspace/domain-skills/{xiaohongshu,youtube}/**`（90+ 个 site skill）——**这是最低成本的平台知识沉淀方式**。

---

## 4. 本仓现状（已取证）

### 4.1 落点

- **Host 侧** `dsh-plugins/vssaros-browser`（v0.1.0）：注册**一个** `browser` 工具，11 个 op（`status/snapshot/images/navigate/click/type/pressEnter/pressKey/scroll/back/reset`）；`lib/core/{cdp,chrome,host,client,snapshot,invoker}.js`；动作类 op 默认需审批（无审批通道 ⇒ **fail-closed 拒绝**），可 `config.allowActions` / `VSSAROS_BROWSER_ALLOW_ACTIONS=1` 显式放行。
- **IDE 侧**：`builtinToolProvider.ts` 内 `browser` **0 命中**（执行注册点已退役）；只剩纯逻辑三件套 `common/chromeDebugSetup.ts`、`common/browserCdpSnapshot.ts`、`common/webPageQuality.ts`，以及 `bundledTools.ts` / `toolsetConfig.ts` / `settingsEditorPane.ts` 里的**工具名与设置面**。⚠ 这三处仍在声明 7 个 `browser_*` 工具名，属**迁移中间态**，动手前需与该侧确认。

### 4.2 已经很好的部分（不要重做）

- **端口错开**：专属实例跑 `配置端口 + 1`，9222 留给用户自己的 Chrome；候选顺序 = 用户 Chrome 优先（`chrome.js:35-50`，注释写明"顺序即语义"）。
- **专属 profile 天然持久**：`~/.vssaros/browser-profile`（`chrome.js:82-85`）——"在那个窗口登录一次"后登录态就在里面。
- **CDP 客户端在 Host/主进程**：避开 CORS 与 Chrome 111+ 的 Origin 拒绝（本机 `web-access` 技能要额外起 Node 代理正是因为它跑在 renderer）；Host 侧用全局 `fetch` 还顺带避开 CORS（`host.js:11-13`）。
- **主页质量分类**：`common/webPageQuality.ts`（强/弱拦截、强/弱不可用 4 张表 + `blocked|thin|ok` + `kind: interstitial|unavailable` + 误判护栏"弱特征只在短页生效"）。
- **登录墙自诊断**：`browserPageWallNotice()` 在快照/图片清单**末尾**追加（`browserCdpSnapshot.ts:230,475`），只对 `blocked` 生效，且 `formatImages` 只用 title 判据（点破"有图≠页面正常"）。
- **引导卡协议**：`common/chromeDebugSetup.ts` 的 `OWN_CHROME_CHOICE_*` + `interpretOwnChromeChoice` + `ownChromeGuideQuestion`（`__clarify__` 卡片，选项按**文案字符串**回传）；`turnSignals.ts` 的 `CLARIFY_CAPABLE_TOOL_NAMES` 与 `agentChatPanel.toolCards.ts` 两处**按名字**放行。
- **视频链**：`video_analyze`（yt-dlp 字幕轨 → 本地 whisper ASR）已通；`--cookies-from-browser` 已接线（默认关）。

### 4.3 缺口清单

| # | 缺口 | 证据 |
|---|---|---|
| G1 | **无登录墙的"停下请人"闭环**：`browser_use_my_chrome` 只有卡片协议与文案 helper，**没有 handler**；无"请用户登录→验证→继续"的状态机 | 全仓 `browser_use_my_chrome` 仅 3 处（turnSignals / chromeDebugSetup / toolCards） |
| G2 | **无 cookie 读写**：agent 侧 `Storage.getCookies` / `Network.getCookies` / `storage_state` **0 命中** | 唯一 cookie 能力是"借给 yt-dlp"（`videoMediaPipeline.ts:241-264`，默认关） |
| G3 | **无 cookie 导入**（用户 Chrome → 专属 profile），即 openclaw `importprofile` 那一步 | 同上 |
| G4 | **无多账号 / 命名 profile**：只有一个 `browser-profile` | `chrome.js:25` |
| G5 | **无扫码登录引导**：无二维码**解码**（正确），也**没有"打开登录页 + 请人扫 + 判据检测"**这套流程 | 搜 `qrcode|扫码|jsqr|zxing` 命中全是飞书**生成**二维码 |
| G6 | **无人工接管状态机**：只有文案，无"检测→分类→暂停→恢复" | 搜 `captcha|human|takeover` 仅 `webPageQuality.ts:64,76-77` 作检测特征 |
| G7 | **登录墙未单列 kind**：`请先登录后查看` 在 `WEAK_UNAVAILABLE_PATTERNS` 里，与"页面不存在"共用 `unavailable`，**下一步动作其实不同** | `webPageQuality.ts:103-107` |
| G8 | **平台路由表只存在于 skill 的文字表格**，两条通道（agent / 宿主导入按钮）各写一份 | `web-content-import/SKILL.md:37-44` vs `kbUrlScraper.ts:36-60` |
| G9 | **无站点级特化知识**（xsec_token 之类）沉淀到可检索位置 | `resources/.agents/skills/` 下无 site-* 技能 |
| G10 | **无反检测参数**（连最保守的 `AutomationControlled` 都没有） | `buildDedicatedChromeArgs`（`chrome.js:92-101`）只有 4 条参数 |

---

## 5. 优化方案

### P0 — 登录态闭环（不碰凭据、不做逆向）

#### P0-1 「请用户登录一次」闭环（补 G1/G5/G6）— ✓ 已实现，但**不是**下面的卡片形态（见 §0.5）

**目标**：模型在任何通道撞到登录墙时，能一次性把用户请到正确窗口完成登录，并在完成后**自动验证**再继续。

> ⚠ 落地时改了形态：**Host 侧没有 `__clarify__` 卡片协议**（它在 IDE 聊天面板里，Host 是常驻进程）。
> 实际实现 = 「两次调用 + 文本指引」，细节与理由见 **§0.5**。下面保留原始设计以便将来做壳侧卡片增强。

**设计**（原计划：复用已有卡片协议，不新造机制）：
1. `browser` 工具新增 op `login`：参数 `{ url, site? }`。行为 = ① `ensurePage(url)`（专属窗口或用户 Chrome，取决于当前端点）；② 立即返回 `__clarify__` 卡片：
   - `我已完成登录，继续`
   - `打开登录窗口（含扫码）`
   - `换用我自己日常的 Chrome`
   - `取消`
2. 用户点完，选择作为用户消息回灌 → 模型带 `confirmed: true` + `choice` 再调一次 ⇒ 执行**判据检测**：
   - 强判据：`Storage.getCookies` 里出现该站点的登录态 cookie（域名级，不读出值，只判存在）；
   - 弱判据：`browserPageWallNotice` 的 `classifyExtractQuality` 不再判 `blocked`；
   - 两者都指"仍像登录墙" ⇒ 如实回"仍未登录成功"，**禁止连点重试**（与 `web_extract` 的登录墙纪律一致）。
3. `interpretOwnChromeChoice` / `OWN_CHROME_CHOICE_*` 的单一真源扩成两张卡片的选项表（避免"点了没反应"）。

**落点**：`dsh-plugins/vssaros-browser/lib/index.js`（新 op + 卡片返回）+ `lib/core/client.js`（判据）+ `src/vs/.../common/chromeDebugSetup.ts`（选项文案真源）。

**验证**：探针 `poc/dsh-p0/scripts/p3-XX-login-card.mjs`——假 ctx + 假 CDP：① 未确认时不动连接、返回 `__clarify__`；② 未知选项按取消；③ `confirmed+choice` 恰触发一次 cookie 判据；④ 判据为负时**不**返回成功；⑤ 真机（9223 临时实例）跑一次"访问小红书 → 出卡 → 手动登录 → 检测通过"。反向突变：把判据改成恒真 ⇒ ④ 必红。

**版本铁律**：改 `vssaros-browser` 必须 bump `package.json` version（`plugin add` 版本未变是 no-op）且 `files` 含新增文件（漏了会导致插件加载即失败、整站 404）。

#### P0-2 登录墙单列 kind（补 G7）

**目标**：`login-required` 与 `page-unavailable` 分开——前者下一步是"请人登录"，后者是"换来源/认输"。

**设计**：`common/webPageQuality.ts` 的 `kind` 加第三值 `login-required`；把 `WEAK_UNAVAILABLE_PATTERNS` 里"请先登录后查看 / 登录后可查看 / 请用手机App打开"迁入新的 `LOGIN_WALL_PATTERNS`（**保持"只在短页生效"的误判护栏**，强特征表新增小红书"你访问的页面不见了"之外的登录态句式需逐个过"整句短语"两关）；`webExtractBlockedMessage` 与 `browserPageWallNotice` 按新 kind 分派：**login-required ⇒ 唯一出路是 `browser.login`（P0-1）或承认读不到**，明确禁止重试。

**验证**：`test/browser/webSearchParse.test.ts` + 新增 `login-required` 用例（真实形状：小红书未登录占位页、知乎登录提示页）；**反向保护**：正常长文里出现"登录"字样不得触发。本仓口径：强特征任何长度都判、弱特征只在 <600 字符生效。

#### P0-3 cookie 通道（补 G2/G3）

**目标**：让"用户 Chrome 的登录态"可以受控地流到专属 profile，且**cookie 永不进模型上下文**。

**设计**（三级，逐级降级）：
1. **零 cookie**：直接复用当前端点（首选，什么都不做）；
2. **CDP 导出/注入**：`Storage.getCookies`（浏览器自己解密）→ 只写入 `<home>/.vssaros/browser-profile/.saros-cookies/<site>.json`（权限收紧、`chmod 600` 等价物、含 `savedAt`）；
3. 借给外部工具：已有 `--cookies-from-browser`（保持默认关）。

**安全硬约束**（写进工具描述与文档）：
- cookie 值**只落盘、不进工具返回值**（返回"已导入 N 条 / 其中登录态 M 条"这样的计数）；
- 导入必须**显式**（单独 op + 审批闸），不做"自动后台同步"；
- 只接受 `https` 站点、只写自己的 profile 目录、路径三段围栏（绝对路径 / `..` / 拼完前缀复核）；
- 参照 `openclaw` 的 `allowSystemProfileImport`：给一个总开关，默认 **off**。

**验证**：单测覆盖纯函数（cookie 过滤/落盘形状/围栏拒绝的**正例**，防"一律拒"的空壳）；真机用 9223 临时实例 + 本地 http 服务自造 cookie，断言"注入后专属 profile 里能读到"。

### P1 — 路由与接管

#### P1-1 平台路由表升级为声明式数据（补 G8）— ✓ 已实现（见 §0.5 的「P1-1 平台路由表」小节）

**目标**：一份数据，两个消费者（agent 侧路由决策、宿主导入按钮）；失效切换只改顺序。

**设计**：新增 `common/webPlatformRoutes.ts`（纯数据 + 纯函数：`platforms[]`，每项 `{ id, label, matchHosts[], backends: [{ kind: 'http-extract'|'browser'|'video-analyze'|'ytdlp', note }], needsLogin, risks[] }`）；`web-content-import/SKILL.md` 的表格与宿主 `kbUrlScraper.detectPlatform` 都**引用它**（或用守卫做"逐字节同形"）。参照 Agent-Reach：**顺序即语义**，并提供"真跑探活"（不是 `which` 就算数）。

**验证**：守卫（本仓既有范式）——① 每个平台的 `backends[0]` 必须在已知集合内；② 新平台必须同时登记两条通道的消费点；③ 反向突变：改排序/删后端 ⇒ 红。

#### P1-2 人工接管状态机（补 G6）— ✓ 已实现（落地为 `manualAction` 枚举，见 §0.5 的「P1-2」小节）

**目标**：把"阻塞"从**一段文案**升级为**枚举 + 明确暂停语义**。

**设计**（照 `openclaw` `platform-adapter-contract.ts:6-20` 的枚举形态）：`manualAction: 'login-required' | 'captcha-required' | 'permission-required' | 'consent-required' | 'app-only' | 'rate-limited' | 'custom'`；工具返回值带 `manualAction` 字段 + 一句"需要用户做什么"；宿主/卡片侧据此渲染不同按钮。**只上报，不硬闯**（`browser-use` 的 `wait_if_captcha_solving` 是"等外部解决"，我们是"等人"）。

**验证**：探针断言"每种 `blocked` 形状 → 期望的 `manualAction`"（真实样本喂进去）；**负例**：正常页必须无 `manualAction`。这是本仓反复强调的"误报比漏报贵"。

#### P1-3 站点特化知识（补 G9）

**目标**：把"小红书要带 `xsec_token`""YouTube 可走 `ytInitialPlayerResponse` 免登录""B 站登录态检测选择器"这类**经验**沉淀成可检索的薄技能。

**设计**：`resources/.agents/skills/` 下按 host 建 `site-<host>` 薄技能（每个 <2KB：URL 形态 + 稳定判据 + 已知坑 + 登录要求），`activation: auto` + host 关键词；不要做成"大而全"的平台文档（`web-content-import` 已经承担了通用流程）。

**验证**：契约测试（照 `builtinSkillContracts.test.ts` 先例）：关键词真能命中真实用户消息；每条"坑"必须可追溯到源码/实测（不许写猜测）。

### P2 — 派生能力

- **P2-1 命名 profile / 多账号**（补 G4）：`browser-profile` → `browser-profiles/<name>`，端口段错开（照 `openclaw` 18800-18899 的做法）；名字规则 + 目录围栏 + 删除时移入回收站。
- **P2-2 反检测基线**（补 G10）：专属实例参数加 `--disable-blink-features=AutomationControlled`；**不加** JS 注入补丁（理由与反面证据见 §2.4）；可选 `extraArgs` 逃生舱（照 `openclaw` 的配置位置）。
- **P2-3 页面内执行 JS 的受控入口**：`browser_cdp`（`Runtime.evaluate`）目前只有 schema 无 handler；它是"读页面数据"的关键（小红书 `window.__INITIAL_STATE__` 之类），但风险最高 ⇒ 若开，需**只读白名单 + 审批闸 + 返回截断**，并在描述里写明"不要用它改写页面"。

---

## 6. 明确不做

| 不做 | 理由 |
|---|---|
| 自研验证码识别 / 集成 capsolver、2captcha | 三家开源项目都没做；本仓"不引入合规与成本灰区" |
| JS 签名逆向（`a_bogus`/`x-bogus`/`xsec_token` 算法） | MediaCrawler(59.6k★) 与 Spider_XHS(7.8k★) 都放弃了；追版本是无底洞 |
| 二维码**解码** | 真实扫码发生在用户手机上，页面上只是图片；解码毫无用处 |
| 引入 camoufox / patchright / 换内核 | 与"用用户真实浏览器"路线冲突，且放弃 Chrome 的 CDP 生态 |
| 自建 stealth JS 补丁（`navigator.webdriver=false` 等） | 现代检测能识别被 patch 的属性；反成特征 |
| 把 `--no-proxy-server` 那套照抄过来 | 对需要代理出口的抓取是反向的 |
| 让 agent 自己填账号密码 | 凭据进模型上下文 = 不可接受 |
| 自动后台同步 cookie | 敏感凭据的静默搬运；必须显式触发 |

---

## 7. 验证与验收（本仓既定纪律）

1. **探针**：每条 P0/P1 落一个 `poc/dsh-p0/scripts/p3-XX-*.mjs`，走既有 `lib.mjs` 的 `resolveRuntime`/`startHost`/`report`，并登记进 `run-all.mjs`（不登记就要进 `EXCLUDED` 并写明理由——覆盖守卫会逼你对账）。
2. **行为级断言**：闸/副作用一律**行为级**（假 ctx 记录事件），不用源码文本断言（注释会骗人）。
3. **反向突变**：每个守卫写完要**故意改坏被测代码**确认变红；"跳过"一律按红处理。
4. **真机**：`node scripts/verify-browser-cdp.mjs 9223`（临时实例 + 临时 profile，跑完即关）——新增 op 逐条补断言。
5. **跨侧对账**：`common/webPlatformRoutes.ts` 与 dsh 侧若各有一份 ⇒ `check-host-config.mjs` 式的"逐字节同形 + 守卫"。
6. **工具面快照**：改工具后跑 `dsh-plugins/tools-snapshot.mjs --write`（描述变更也会改哈希）。
7. **版本铁律**：改插件内容必须 bump version + 补 `files`（两条都出过真事故）。

---

## 8. 风险与前置

| 风险 | 影响 | 处置 |
|---|---|---|
| IDE 侧 `browser_*` 工具名仍在 `bundledTools/toolsetConfig/settingsEditorPane` 声明（执行点已退役） | 模型可能看到"不存在的工具"；文档与实现不一致 | **动手前先与该侧确认迁移状态**；本方案只改 Host 侧 |
| `vssaros-browser` **故意不声明 `vssaros.module`**（与 `vssaros-ide` 的 `browser` 撞名） | 若被改成模块插件 ⇒ 两处 `browser` 工具静默顶掉/整条 entry 失效 | 加 op **不要**改这个声明；守卫已盯"例外表不许腐烂" |
| 扫码/登录是**人工步骤**，无法自动化验证 | e2e 只能到"出卡 + 判据函数正确" | 真机手工验收一次并留日志；其余靠单元/探针 |
| cookie 通道的合规与安全 | 泄漏用户凭据 | 见 P0-3 的 6 条硬约束；默认 off |
| Windows 侧 Chrome 136+ 忽略默认 profile 的调试开关 | 连不上用户 Chrome | 已有 `--user-data-dir` 强制（`chrome.js:89`）+ 引导文案；沿用 |

---

## 9. 关键引用（便于回查）

- 本仓：`dsh-plugins/vssaros-browser/lib/{index.js,core/chrome.js,core/host.js,core/client.js}`、`src/vs/sessions/contrib/agentStudio/common/{chromeDebugSetup.ts,webPageQuality.ts}`、`browser/browserCdpSnapshot.ts`、`resources/.agents/skills/web-content-import/SKILL.md`
- `browser-harness`：`src/browser_harness/daemon.py:266-342`（端点发现）、`SKILL.md:40-57,148-192`、`agent-workspace/domain-skills/{xiaohongshu,youtube}/*`
- `browser-use`：`browser/watchdogs/storage_state_watchdog.py:101-305`、`session.py:1437-1480`、`browser/profile.py:201,952`、`events.py:605-633`
- `Agent-Reach`：`agent_reach/channels/base.py`（有序候选）、`probe.py:47-120`、`cookie_extract.py:32-57,70-86`、`backends/opencli.py:8-17`
- `openclaw`：`extensions/browser/src/browser/{config.ts,profile-capabilities.ts,chrome.ts,chrome.profile-decoration.ts,system-profiles.ts}`、`extension-relay/*`、`src/meeting-bot/{platform-adapter-contract.ts,browser-controller.ts}`、`src/config/types.browser.ts`、`docs/tools/{browser.md,browser-login.md,browser-control.md}`
- `defuddle`：`src/extractor-registry.ts`、`src/extractors/reddit.ts:52-59`、`src/removals/scoring.ts`
