# 工作台外壳四处联调：面板守卫 / agent preset / 浮动工具条 / 生效路径

> **来源**：2026-10-28 给「媒体库」做 customFrame 工作台（`vssaros-media` 0.7.20 → 0.7.29）时真机踩的全套坑。
> 适用对象：**任何带右侧对话列的注册式工作台**（萨罗斯平台 / 商城 / 媒体库 / 以后的新工作台）。
> 这份文档只讲**外壳联调**；清单字段、chunk 规则看 `manifest-and-registration.md`，
> 助手本体与 preset 基础看 `embedding-ai-assistant.md`。

---

## 0. 四个症状 ↔ 四个根因（先看这张表定位）

| 用户说的 | 真根因 | 在哪一节 |
|---|---|---|
| 「打开工作台后，点工作区里的**会话 item 没反应**」 | 外壳把 `selectPanel(null)` **拦住了（对）但没有"接住"** —— 没把刚选中的会话停靠进工作台的对话列 ⇒ 状态变了、界面不动 | §1 |
| 「右侧对话列显示的**不是我的 agent**」（显示成别的插件的 agent） | ① 本插件的 agent **根本不存在**（只有工具没有 agent）② `newSession` 被别的插件先包走、你的补丁放弃了 | §2 |
| 「**多余**的浮动工具栏」/「浮条被右边缘裁掉」/「文字常显、样式全乱」 | ① 页面自带浮条 + 外壳浮条**重合** ② 浮条挂在内容容器里被挤出去 ③ CSS **一条未闭合规则**吞掉后面所有后代规则 | §3 |
| 「右侧**业务面板（编辑区）不见了**」 | 窄屏断点把面板自动 `hide`，而工作台面板正好落在断点里 | §4 |

**还有一条不在症状表里但每次都要问**：改完为什么不生效？→ §5（模块半边 vs 前端半边）。

---

## 1. 面板守卫：点会话「没反应」

### 真机现象

打开任意 customFrame 工作台后，左侧工作区的会话 item 点了**毫无反应**：
工作台页签不动、右侧对话列也不切换。（媒体库、商城都报过同一个问题。）

### 根因（**在外壳里，不在业务插件里**）

`dsh-client-ui-workspace` 的 `openSession()`：

```
openSession(target) → replaceMain(target, …, 'reveal')
                        ├─ ① selection.set({ sessionId })          ← 会话**已经换选了**
                        └─ ② if (panel === 'reveal') layout.selectPanel(null)
```

而 `@vssaros/dsh-workbenches` 外壳**早就装了一个拦截器**：前台是整页工作台（customFrame）时，
把 `selectPanel(null)` **拦住并 `return`** —— 这是**对的**（否则中栏会跳成原生会话页，工作台被换掉）。

**问题出在"只拦不接"**：拦下之后**没人把刚选中的会话停靠进工作台的对话列** ⇒
会话在状态里换了、界面一动不动 ⇒ 用户看到的就是"点了没反应"。

> 所以：**别再往业务插件里加 `selectPanel` 守卫**（媒体库/商城都加过一层，那是"防御层"，
> 真正该修的是外壳那个 `guarded()` 函数 —— 一处修好，三个工作台同时好）。

### 修法（改外壳）

```js
// vssaros-workbenches/lib/client.js 里那个 layout.selectPanel 拦截器
const currentMainSessionId = () => {
  // 优先：uiWorkspace 的 selection 快照（replaceMain 里刚 set 过，最及时）
  try {
    const snap = ctx.uiWorkspace?.selection?.getSnapshot?.();
    if (typeof snap?.sessionId === 'string' && snap.sessionId) { return snap.sessionId; }
  } catch { /* 换下一种 */ }
  // 兜底：找 retainedBy.mainView > 0 的那条会话
  try {
    const byId = ctx.sessions.list.getSnapshot().byId || {};
    return Object.values(byId).find((s) => (s?.retainedBy?.mainView || 0) > 0)?.id;
  } catch { return undefined; }
};

const guarded = (panel) => {
  if (panel === null && service.active && service.docksConversation(service.active)) {
    const sid = currentMainSessionId();
    // ★ 关键：拦下之后要**接住** —— 把会话停靠进本工作台的对话列
    if (sid) { service.showSession(sid); }
    return;                       // 中栏保持工作台
  }
  return original(panel);
};
```

`service.showSession(sid)` 内部已经处理好了三种归属（见 `dsh-workbenches` 的服务实现）：

- 已归属本工作台 ⇒ 直接停靠；
- **未归属任何工作台 ⇒ 自动绑定到本工作台再停靠**（用户就在这个工作台里点的，意图明确）；
- 已归属别的工作台 ⇒ 只写 `dockError`，**不会**把用户踢出当前工作台。

### 还有一个更深的坑：**异常在守卫之前就抛了**

上面那条修好之后，用户仍然报"点了没反应" ⇒ 说明真正的断点更靠前。取证方法（**别再猜，直接在页面里量**）：

```js
// 在 dsh 页面（Chrome 打开 http://127.0.0.1:<port>/?token=…）里：
const dw = window.__vssarosMarketDw;      // 各插件会把服务挂到全局
dw.newSession();                          // 新建一条 ⇒ 对话列出现完整聊天界面 ⇒ 停靠机制本身是好的
const byId = dw.ctx.sessions.list.getSnapshot().byId;
// 逐条看侧栏里那些条目：archived / blank / retainedBy
```

结论（媒体库、商城都中招）：侧栏里那几条是 **`blank: true` 的空白草稿**，而 dsh 的 `sessions.retain()` 对
"空白且没被任何视图持有"的会话会抛 `unknown session`；而 `uiWorkspace.openSession()` 的第一步就是
`replaceMain()` → `sessions.retain(target)` ⇒ **异常在 selectPanel 守卫之前就把整条链路打断**
⇒ 选中、停靠、显示全没发生 ⇒ 界面一动不动。

⇒ 修法（**不预判，让 dsh 自己判断、我们接住异常**）：

```js
// vssaros-workbenches：包一层 uiWorkspace.openSession
const patchedOpen = function (target) {
  const sid = typeof target === 'string' ? target : (target && target.sessionId) || '';
  try {
    return originalOpen(target);
  } catch (e) {
    console.warn('[vssaros-workbenches] 打开会话失败：' + sid, e);
    service.markDead(sid, '这条会话已失效（空白草稿或已被删除），打不开');
    service.clearStaleBinding(service.active, sid);   // 清掉指向它的绑定 ⇒ 下次不再卡同一条
    return undefined;                                  // 吞掉异常 ⇒ 界面不卡死，用户看到明确提示
  }
};
```

**两条硬教训（都踩过）**：

1. **不要拿 `sessions.retain()` 当"能不能用"的探针** —— 我用它做预判，结果**刚新建的工作台会话也被判成不可用**
   （新建会话此刻就是 `blank` 且 `retainedBy` 为空）⇒ 自己的会话反而停靠不上 ✗。
   ⇒ 只用"**它还在列表里吗**"（`sessions.list.getSnapshot().byId[sid]`）这种**不会误杀**的判据；
   真正的判断交给权威方（dsh 自己）抛异常，我们只负责**接住 + 自愈 + 提示**。
2. **先定位"异常在哪一层抛"再动手**：我前两轮分别改了"守卫拦的时机"和"预判逻辑"，都因为**异常其实抛在更早的一层**
   （`replaceMain` → `retain`）而白改。判据：在页面里直接复现那一步（`sessions.retain(sid)` 手动调一次），
   看它到底抛不抛 —— 比读代码猜快得多。

### 业务插件**不要再包** `selectPanel` / `openSession`（2026-10-28 二次教训）

媒体库/商城曾照上面"防御层"的写法各自又包了一层，结果**装在外壳守卫的外面**：

```
业务插件的 patchedSelect（active 时 null 直接 return，不往下传）
  └─ 外壳的 guarded（拦下 null ⇒ showSession 停靠）   ← 永远执行不到 ✗
```

⇒ 外壳"拦下后停靠会话"被架空 ⇒ **点会话、点「＋ 新建会话」全都"没反应"**。
（「＋ 新建会话」走 `startSession → connectBlank → replaceMain → selectPanel(null)`，**根本不经过
`uiWorkspace.openSession`**，所以业务插件在 `openSession` 上做的兜底对它也完全无效。）

**结论**：`layout.selectPanel` / `uiWorkspace.openSession` 只允许**外壳一处**打补丁；
业务插件需要"前台标志"（`props.active`）时只为自己的 preset/停靠逻辑用，**不要碰这两个函数**。
守卫（`check-assistant-collapse`）已钉住：业务插件源码里出现 `layout.selectPanel =` / `ws.openSession =` 即红。

### ★ 先问清「点会话应该发生什么」——两种口径，代码完全不同

同一句「点工作区左侧会话 item」，产品期望可能是**相反**的：

| 口径 | 期望 | 实现 |
|---|---|---|
| A. 留在工作台 | 页签不动，右侧对话列切到该会话 | 拦 `selectPanel(null)` + `service.showSession(sid)` 停靠 |
| B. 切走 | **切到会话页**展示（离开工作台） | **放行** `selectPanel(null)`，让 dsh 原生 `replaceMain` 生效 |

**2026-10-28 真实返工**：先按 A 实现（媒体库/商城都做过），用户后来明确要求 B ⇒ 又得改回来。
**判据**：先看用户是"想在工作台里聊"还是"想去会话页"，别自己假定。

**同时要留住的另一条**：工作台**内部**的「切会话/切工作区」也走 `replaceMain → selectPanel(null)`，
按 B 放行会把用户**踢出工作台**（2026-10-24 报障）。两者在 `selectPanel` 层无法区分 ⇒
**在入口上区分**：包 `uiWorkspace.openSession` / `uiWorkspace.startSession` 打「用户导航」时间戳，
守卫里 `Date.now() - navIntentAt < 2500 ⇒ 放行`（用时间窗，因为 `startSession` 是异步的）。

### 浮动条两处易漏：AI 助手按钮被隐藏 / 能自由拖动

1. **没有页内对话列的工作台（如知识库）看不到「AI 助手」按钮**：
   外壳按面板里**有没有** `[data-vssaros-assist-collapsed]` 决定状态，没有就设 `data-assist="none"`，
   而 CSS `.vssWbActions[data-assist="none"] .wbWrapAssist { display:none }` ⇒ 整组隐藏。
   ⇒ 口径改成 **一律显示**（没有宿主时按「收起」态显示「« 展开 AI 助手」），点击走兜底：
   有页面桥 `bridge.newChat(preset)`；**无桥（桌面窗口）`uiWorkspace.startSession(undefined, { agentPreset })`**。
2. **浮动条不该随便拖**：用户明确要求「只能在 app 最右侧上下移动」⇒ 拖拽与夹取都把
   `x` 固定为 `maxL - 12`（`ACTIONS_RIGHT_GAP`），只有 `y` 变；实测「距右恒 12px」。

### 切走时「会话页空白」——停靠覆盖层把对话抢走了

把 `props.conversation` 通过 `shell.overlay` + session 子槽 **portal 进工作台的 dock 元素**之后：

- 只要 `service.active` 还是那个工作台，覆盖层就一直在 portal；
- 用户导航到会话页时（`selectPanel(null)`）工作台面板被卸载/隐藏，**对话却还被 portal 到已不存在的 dock**
  ⇒ 主面板拿不到对话 ⇒ **会话页空白**（看起来像"切过去了个空页面"）。

⇒ 用户主动导航时必须先 **`service.leave()`**（把 `active` 置空 ⇒ 覆盖层停止 portal，并顺带回会话面板），
再 `return original(panel)`；只放行 `selectPanel(null)` 是不够的。

### 「新建会话没反应」的三条来源（按排查顺序）

1. **Host 根本没跑** —— 页面会刷 `connection lost / ERR_CONNECTION_REFUSED`，`startSession` 拿不到 Host，
   点「新建会话」必然毫无反应。**先查 Host 存活**（`host.json` 的 pid 是否还在、`process.kill(pid,0)`），
   再谈 UI；否则会把"基建挂了"误判成"我的补丁没生效"。
2. **对话列是收起状态** ⇒ 新会话确实建了、也停靠了，但那一列 `data-vssaros-assist-collapsed="1"`（隐藏）
   ⇒ 用户看不出变化。修法：外壳守卫停靠后若还有折叠面板，派发 `vssaros:assist-expand`
   （`detail.workbench = 前台工作台 id`）⇒ **自动展开**。守卫已钉住这条。
3. **侧栏「新建会话」不走 `openSession`** —— 它走
   `startSession → openWorkspaceSession → replaceMain(…, 'reveal') → layout.selectPanel(null)`
   ⇒ 只有**外壳的 selectPanel 守卫**能接住，业务插件在 `openSession` 上做的兜底对它完全无效。

### 外壳守卫的两个实现要点（漏一条就是"没反应"）

1. **目标会话优先取 `uiWorkspace.mainReference.sessionId`** —— `replaceMain()` 在调
   `selectPanel(null)` 的**前一行**刚把它换成目标会话；新建会话此刻**还没进** `sessions.list`
   快照，`selection` 与"retainedBy.mainView"兜底都可能拿不到它。
2. **不要拿 `sessionExists`（查 `sessions.list`）做前置** —— 同理，新建会话会被误判成
   "已不存在"⇒ 新建没反应。真失效的会话交给停靠区自己的 `retain` 判定
   （失败 ⇒ `markDead` + `clearStaleBinding` ⇒ 回到「开始对话」，不卡死）。

### 判据（三层都验）

1. **静态**：外壳的守卫里，`panel === null` 分支必须同时出现 `showSession(`（守卫断言：拦截 = 拦 + 接）；
2. **单测**：前台 `selectPanel(null)` ⇒ 原函数不被调用 **且** `showSession(sid)` 被调用；非前台两者都透传；
3. **真机**：点左侧会话 ⇒ 工作台页签不动、右侧对话列换成该会话；再看 Host/页面 console，
   应该有 `已拦截 selectPanel(null)：前台整页工作台 = <id>；把会话 <sid> 停靠到工作台对话列`。


## 2. 右侧对话列用错 agent：两层原因，别只修一层

### 层 ①：agent 根本不存在（最容易漏）

**症状**：对话列显示成「商城助手」（或任何别的 bot），而不是你的 agent。

**根因**：插件**只有工具、没有 agent** ⇒ 你的 preset id（`vssaros-<slug>`）**在 preset 注册表里不存在**
⇒ `presets.select(sid, 你的id)` 必然失败（`agent-preset/not-found`）⇒ 会话沿用别处给的 preset。

**自查**：直接看数据根的 agents 目录里有没有你的那个：

```
<数据根>/agents/            # dev 是 ~/.vssaros-dev/agents，prod 是 ~/.vssaros/agents
~/.../agents/marketplace-bot/     ← 商城有（所以它能显示"商城助手"）
~/.../agents/media-librarian/     ← 如果没有 ⇒ 你的 preset 根本不存在
```

**修法**：像商城 `lib/marketAgent.js` 那样，把 agent 落成 `.agent.md`（`vssaros-agents` 启动时扫描注册）：

```js
// <数据根>/agents/<agentId>/.agent.md
---
name: 媒体库管家
description: "……"
id: media-librarian              # preset id = 'vssaros-' + slugify(id)
role: 媒体库素材查找与整理专家
source: custom                   # ★ 必须 custom，写 builtin 会被 IDE 下拉静默过滤
storeId: media-librarian
suggestions:                     # ★ 别用半角逗号（YAML 列表会被拼成逗号串再 split）
  - 帮我看看库里最近导入的素材有哪些
---
<人设正文：你是谁 / 手上有哪些工具 / 工作方式 / 边界>
```

**三条纪律**：
1. **只在缺失时创建**（`access(file)` 先判），用户可能改过名字/人设/技能 ⇒ 每次启动覆写会把他的改动冲掉；
2. 失败**只打日志**，绝不能让 `apply` 抛错（它会把整个插件带崩）；
3. `source: custom` + `suggestions` 用「，」——这两条都是"静默失败"型（不报错，只是不出现）。

### 层 ②：`newSession` 被别的插件先包走，你的补丁"礼貌地放弃"了

**症状**：agent 存在、preset id 也对，但新会话还是不绑你的 agent。

**根因**：多个工作台插件都会包 `dw.newSession`（商城、萨罗斯、你）。商城那份的守卫是：

```js
scope.effect(() => {
  if (dw.newSession !== origNewSession) { return; }   // ← 「已被别人包过就放弃」
  dw.newSession = patched;
}, '...');
```

⇒ **后装的那个永远包不上**（`dw.newSession` 已经是别人的 patched）⇒ 不会去 select 自己的 preset。

**修法**：**总是链式包**（拿到"当时的"引用再套一层），并用「前台标志」决定要不要改 preset
（同类的第二处：商城的 `ensureMarketDefaults()` 原本**无条件**在 `newSession` 里跑 ⇒ 打开别的工作台新建会话也会被带成商城助手；0.3.0 起也加了前台判定）：

```js
const orig = dw.newSession;              // ← 可能是别人包过的版本，没关系
const patched = function (...args) {
  const out = orig.apply(dw, args);
  Promise.resolve(out).then((sid) => {
    if (!globalThis.__myWbActive) { return; }       // ★ 关键：别改别的会话
    if (sid && presets && typeof presets.select === 'function') {
      try { presets.select(sid, MY_PRESET); } catch { /* 忽略 */ }
    }
  }).catch(() => {});
  return out;
};
scope.effect(() => {
  dw.newSession = patched;
  return () => { if (dw.newSession === patched) { dw.newSession = orig; } };   // 只在还是自己时才还原
}, 'my-wb: newSession preset');
```

### 层 ③（顺手补一刀）：把**已存在**的会话也纠回来

用户打开工作台时，对话列往往已经绑了一个会话（可能用的是别人的 preset）。前台时主动纠一次：

```js
const sid = dw.dockedSessionOf(WB_ID);          // 外壳给的"当前停靠会话"
if (sid && PRESETS && typeof PRESETS.select === 'function') {
  try { PRESETS.select(sid, MY_PRESET); } catch { /* 忽略 */ }
}
```

> `PRESETS` 要放**模块级**变量：面板组件是模块级函数，拿不到 `apply(ctx)` 的闭包。

### 判据

- 单测：先给 `dw.newSession` 塞一个"别人的 patched"，再 apply 你的插件 ⇒ 调 `dw.newSession()`：
  前台应得到 `[sid, 你的preset]`，**非前台应为 `null`**（不抢别人）。
- 真机：打开工作台 ⇒ 对话列 header 的 agent 是你的；点「+ 新会话」⇒ 还是你的。

---

## 3. 浮动工具条（AI 助手 / 外开）的三类坑

### 3.1 「多余的一条」= 页面自带 + 外壳渲染**重合**

| 来源 | 位置 |
|---|---|
| 页面自己的 `.m-fab` / `.xxx-fab` | iframe 内右缘 `right:12px; top:50%` |
| 外壳（`@vssaros/dsh-workbenches`）的 `.vssWbActions` | 父窗口右缘，**位置/尺寸几乎一样** |

⇒ 两条叠在一起，看起来像"多出来一条工具栏"（还带双重阴影/错位的标签）。

**修法**：**嵌入时不自带浮条**，统一用外壳那条：

```js
// 页面脚本 init 里
if (window.self !== window.top) {
  // 在 iframe 里 ⇒ 外壳已经渲染了浮条 ⇒ 把自己的摘掉
  var own = document.querySelector('[data-media-fab]');
  if (own && own.parentNode) { own.parentNode.removeChild(own); }
} else {
  initFab();          // 顶层独立打开（浏览器直接看）才自带
}
```

### 3.2 浮条被右边缘裁掉 / 被右侧面板盖住

**根因**：浮条挂在**内容容器**里（如 `.m-main`），而内容容器会被网格撑宽或与右侧检查器相邻 ⇒ 浮条被推到不可见区/被后绘制的面板盖住。

**修法**：浮条挂到**页面根层**（视口大小的定位上下文，`position:relative` 的那个 `.m-app`），并确认它是该层最后一个子节点（后绘制 ⇒ 压在上层）。

**判据**：`getBoundingClientRect()` 要满足 `right <= innerWidth && left >= 0`；`34×61` 这种尺寸不能被压成十几像素。

### 3.3 「文字常显、样式全乱」= CSS **未闭合花括号**吞掉了后代规则

**症状**：浮条**外框**拿到了新样式（品牌描边、外发光），但里面的按钮/标签/分隔线**全是裸 HTML**
（block 布局、文字常显、宽度撑到 130px、被右边缘裁）。

**根因**：插件 CSS 常写在模板字符串里，一条规则少个 `}`：

```css
.vssWbActions:hover { border-color:rgba(47,129,247,.85);      /* ← 没有 } */
.vssWbActions:hover { box-shadow:...; }                        /* 被当成上一条的声明 */
.vssWbActions .wbWrap { ... }                                  /* 从这里开始的全部后代规则都被吞 */
```

**判据（computed style 对照，一眼可辨）**：

| 属性 | 正常 | 被吞时 |
|---|---|---|
| 浮条尺寸 | 34×61 | 130×54 |
| `.wbWrap` | `flex / relative` | `block / static` |
| `.wbAct` | `26×25`，非黑色 | `23×23`，`rgb(0,0,0)` |
| `.wbLabel` | `absolute / opacity 0 / nowrap` | `static / opacity 1 / normal` |

**修法 + 守卫**：
- 把两条 `:hover` 合成一条（一个 `}`）；
- **纯字符串断言抓不到这类问题**（"两边都有 `rgba(47,129,247,.55)`" 照样全绿）⇒ 守卫里**数花括号**：

```js
const css = src.slice(src.indexOf('const CSS = `') + 13, src.indexOf('`;', ...));
const open = (css.match(/{/g) || []).length;
const close = (css.match(/}/g) || []).length;
ck('花括号配平', open === close, `{ =${open} } =${close}`);
```

- **验证技巧（不依赖宿主）**：把插件里的 CSS 模板**抽出来** + 用同样的 DOM 标记做一个离线 HTML，
  用浏览器量 computed style。这一类"样式错乱"用这招 5 分钟定位，比来回重启宿主快得多。

---

## 4. 右侧业务面板「消失」= 窄屏断点把你自己的面板藏了

**症状**：工作台右侧的编辑区/详情面板不见了（用户直接说"缺少右侧编辑区"）。

**根因**：页面 CSS 里给它设了响应式断点（例：`@media (max-width: 820px)` 转浮层）+ 客户端在窄宽度**自动加 `.hide`**。
而工作台面板的宽度常常就在 700~900px（再减去右侧对话列）⇒ 正好掉进断点。

**修法**：
1. 断点**收到真正窄的值**（如 560px），并且 **CSS 与 JS 阈值必须同步**（一个改一个不改，就会出现"CSS 说浮层、JS 说显示"的怪状态）；
2. 断点以下**转浮层但默认可见**，或给用户一个显式开关；**不要** `innerWidth <= X` 就无条件 `hide`；
3. 判据：在 900 / 760 / 620 / 520 四个宽度下量 `getBoundingClientRect().width` 与 `getComputedStyle().position`，
   确认业务面板在"工作台常见宽度区间"里是常驻列（`static`、宽 > 0）。

---

## 5. 改完为什么不生效：模块半边 vs 前端半边

工作台类插件**天然分成两半**，生效方式完全不同：

| 半边 | 在哪 | 改了之后 |
|---|---|---|
| **模块半边**（`lib/index.js`、工具、路由、`.agent.md` 落盘逻辑） | dsh **Host 进程** | 重启 dsh Host（`dshHarness.restartHost`） |
| **前端半边 · 页面**（`/x/<mod>/` 的 SSR 页与其页面脚本） | 浏览器/dsh 页面，由 Host 现读磁盘发出 | 刷新页面（Host 不用重启也会重新读） |
| **前端半边 · client chunk**（`lib/client.js`、`lib/workbench.js`） | dsh 页面里由 `?rev=` 缓存加载 | **重载 dsh 页面**（关掉页签重开 / `Developer: Reload Window`） |
| **IDE webview 里的代码**（`chat-surface` / `workbenches` 的外壳 client） | IDE 的 webview | **必须重载 IDE 视图**（重启 IDE 最稳） |

**判据（别靠"日志正常"推断前端已生效）**：

1. **构建标记（最快）**：外壳 chunk 顶部有 `globalThis.__vssarosWorkbenchBuild = '<版本>'`
   （守卫钉住它与 package.json 一致）⇒ 在**目标窗口**的 DevTools console 里输
   `__vssarosWorkbenchBuild`：等于当前版本 ⇒ 新代码；`undefined` 或旧值 ⇒ **视图没重载**，
   改什么都白改 —— 先重载窗口（关掉重开 / `Ctrl+R` / 重启 IDE），再谈别的。
2. `wmic process get Name,ProcessId,CreationDate` ⇒ **IDE 进程启动时间 vs 插件安装时间**：视图比安装早 ⇒ 必然是旧 client；
3. 直接看**磁盘上装的那份**有没有本次改动的**特征串**（每个小改动给自己留一个唯一字符串，
   例如新函数名 `assistantPresetOf`、新常量 `MEDIA_PRESET`）⇒ 比看外观可靠；
4. 想验"浏览器实际拿到的是不是新的"：在页面里 `fetch(chunkUrl)` 后 `text.indexOf(特征串)`。

⚠ **页面 console 不进 Host/IDE 的日志文件**（harness 日志只有 Host 侧输出）⇒
"分析日志"查不到守卫是否触发；要么在目标窗口开 DevTools 看，要么用上面的构建标记。

> 补充：装插件的环境坑（C 盘满 / safe-delete shim / profile 写锁 / 悬空 `file:` 依赖 / cmd 的
> `set VAR=value &&` 尾空格）见仓库记忆 `feedback_install_dsh_plugins.md`，这里不重复。

---

## 6. 速查清单（做一个带对话列的工作台，逐条打勾）

**清单 / 注册**
- [ ] `vssaros.workbench.customFrame: true`（否则不注入 `props.conversation`）
- [ ] `dsh.client` + `exports['./client']` + `files` 都有该 chunk
      （**只有 customFrame 没有 client chunk ⇒ 永远只有页面形态、右侧没有对话列**，这个组合最坑）
- [ ] chunk 里 `dw.register(DESCRIPTOR, Panel)`，`DESCRIPTOR.repository` 形如 `vssaros:<mod>`

**面板**
- [ ] 面板渲染 `props.conversation`（右侧对话列）
- [ ] 根节点写 `data-vssaros-assist-collapsed`（外壳据此切 « / »）
- [ ] 监听 `window` 上的 `vssaros:assist-expand / collapse`（CustomEvent 只向上冒泡）
- [ ] `props.active` ⇒ `__myWbActive`，所有"面板级"补丁都靠它开关

**面板守卫**
- [ ] 拦 `selectPanel(null/undefined/'')`（否则点会话"没反应"）
- [ ] `openSession(id)` 后 `dw.showSession(id)`（让会话落到对话列）

**agent**
- [ ] `<数据根>/agents/<id>/.agent.md` 存在（`source: custom`，`suggestions` 用「，」）
- [ ] `newSession` **链式**包（不要"已被包过就放弃"），且只在 `__myWbActive` 时 select preset
- [ ] 前台时用 `dw.dockedSessionOf(WB_ID)` 把已存在的会话也纠一次

**浮条 / 布局**
- [ ] 嵌入时（`window.self !== window.top`）**摘掉页面自带的浮条**（避免与外壳重合）
- [ ] 浮条挂在**页面根层**（视口级定位上下文），`right<=innerWidth`
- [ ] CSS 花括号配平（有守卫）；关键节点的 computed style 有对照表
- [ ] 业务面板的窄屏断点与 JS 阈值**同步**，且不要无条件 `hide`

**验证**
- [ ] 单元级：stub `ModuleLoader + react + 三个服务`，断言"注册 / 面板结构 / 守卫 / preset 链式"四件事
- [ ] 真机：点会话 ⇒ 页签不动、对话列切换；新会话 ⇒ 你的 agent；浮条只有一条、完整可见
