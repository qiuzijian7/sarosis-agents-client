# 工作台的 React 挂载方式：小红书工作台 vs 其他内置工作台

**调研时间**：2026-10-24 · **样本**：本仓 30 个插件，重点是 14 个声明 `vssaros.workbench` 的工作台 + 宿主 `vssaros-workbenches`

---

## 0. 先回答：小红书工作台**在本仓不挂 React**

| 检查 | 结果 |
|---|---|
| `dsh-plugins/` 下有没有 xhs / note 包 | **没有**（30 个包里无 `*xhs*` / `*note*`） |
| `doc/xhs-note-aiwriting-mockup.html` 里 `react` / `createRoot` / `ReactDOM` | **0 命中** ⇒ 它是一份**纯 HTML/CSS/JS** 的 mockup |
| 那"小红书工作台"真身在哪 | `vssaros-studio` 的 iframe：`http://saroasisstudiosystem.saroasis.woa.com:9999/`（`studio/lib/page.js:13,61`） |

⇒ **它的 React 由"Saroasis Studio System"那个站点自己的构建决定，完全不经过 dsh 的挂载链**。我们这侧只做两件事：给一个 `<iframe>`，给一条站点栏。

所以要回答"它是如何挂载 React 的"，得先分清**我们这侧的五种挂载方式**——小红书（studio 形态）属于最后一种。

---

## 1. 五种挂载方式（按"谁负责建 React 根"分类）

| | 方式 | 谁建 root | React 来源 | 代表工作台 |
|---|---|---|---|---|
| **A** | **宿主托管（slot）** | **不建** —— 宿主把 Panel 当组件渲染 | 宿主的 `require('react')` | workflow / kanban / memory / codebase / kb / agents / scheduler / studio |
| **B** | SSR + 纯 DOM | 不建 | 无 React | media / sessions / skills / parallel |
| **C1** | SSR + **vendor React** | 页面自己 `createRoot` | 页面顺序加载 `vendor/react.js`（`window.React`） | marketplace |
| **C2** | SSR + **自带/预构建 bundle** | bundle 自己 `createRoot` | bundle 内联 React | dashboard（主页）· imagegen（自由画布）· kb 的 sideview 页 |
| **D** | **iframe** | 站点自己建（我们不管） | 站点自己的构建 | **studio（= 小红书所在站点）** / agents 的 groupPage 详情 |

> 口径说明：判 C 类的依据是**真实函数调用** `createRoot(`。A 类包里也会出现 `createRoot` 字样，但都在注释里（"宿主负责渲染（业务方不 createRoot）"）—— 按调用统计，A 类 8 个包**一次都没有**。

---

## 2. A 类：宿主托管（最主流，也是新工作台该用的）

**客户端只交组件，不碰 root。** `vssaros-workbenches/lib/client.js`：

```js
const React = require('react');
const ReactDOM = require('react-dom');

register(descriptor, Component) {
	const entry = normalize(descriptor, Component);      // 校验失败直接抛，不降级
	const Panel = () => h(Frame, { service, entry });    // 宿主自己包一层
	disposeSlot = this.ctx.slots.register({ name: 'main', key: entry.panel }, Panel);
}

open(entry) { this.ctx.layout.selectPanel(entry.panel); }   // 打开 = 选中 main 槽
```

关键事实（都在 `client.js` 注释里）：

- **承载**：每个工作台一个 `main` keyed 面板（`vssaros-wb:<身份>`），`open()` 只是 `layout.selectPanel(key)`；
- **错误边界**：`PanelBoundary` / `PanelFailure`（业务组件抛错 ⇒ 显示失败卡，**不白屏**）；
- **浮层**：抽屉/弹窗用 `ReactDOM.createPortal`（宿主里唯一直接用到 ReactDOM 的地方）；
- **面板守卫**：`selectPanel(null)` 会被拦（否则中栏被切回会话页 —— 小红书工作台当初「点 AI 协助就自动关闭」就是这条）。

**工作台侧长这样**（kb / scheduler 等）：

```js
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-scheduler',
	chunk: 'client.scheduler.js',
	factory: (require) => {
		const react = require('react');                   // ← 拿宿主那份，不是自己带
		function Panel() { return h('div', { className: 'wb wb-sched' }, …); }
		return { Panel };
	},
});
```

**优点**：单一 React 实例（不会 hooks 错乱）、生命周期由宿主管、错误有兜底、主题与锚点统一。
**限制**：必须有宿主（`@vssaros/dsh-workbenches`）；不能直接 `ReactDOM.createRoot`。

---

## 3. B 类：SSR 拼 HTML + 纯 DOM

服务端 `index.js` 拼整页字符串，客户端只做少量交互（`innerHTML` / `appendChild`）。
实测客户端 `innerHTML` 次数：**skills 15 · parallel 4 · sessions 2 · media 0**（media 基本纯静态）。

**优点**：零 React 依赖、首屏就是 HTML、探针好断言。
**限制**：状态一多就退化成手工 DOM diff（skills 的抽屉、sessions 的磁贴都是这么写的）；不共享 `wb-*` 组件。

---

## 4. C 类：页面自己带 React（两种来源）

### C1 · marketplace：**vendor 脚本 + 全局 React**

```js
// client.js 头部注释（很关键）
//   ⇒ **不能** `require("react")`（那是 chunk 形态的拿法 ✗）。
var React = window.React;              // 由 vendor/react.js 先注入
var ReactDOM = window.ReactDOM;        // 由 vendor/react-dom.js 先注入
ReactDOM.createRoot(root).render(h(App));
```

页面按序加载 `vendor/react.js` → `vendor/react-dom.js` → `client.js`；React 没装上会显示"React 没有装载成功（vendor/react.js 取不到）"。

### C2 · dashboard：预构建 bundle + JSON 数据岛

- 服务端只出「壳 + 两个 `<script type="application/json">` 岛」（布局 / 目录），`<` 转义成 `\u003c` 防提前闭合；
- `/app/dashboard-app.js` 是**预构建产物**（`app/src/app.jsx` → `import React` + `createRoot`），自己挂载；
- 好处：前后端同一份装配（`buildDashboardPayload`）；代价：**改 UI 必须重新构建**（本仓无 `lib/app` 的构建工具链，只有 dist）。

---

## 5. D 类：iframe（小红书所在的形态）

```html
<iframe id="site" src="http://saroasisstudiosystem.saroasis.woa.com:9999/"
        data-vssaros-studio-site referrerpolicy="no-referrer"></iframe>
```

- **我们这侧**：SSR 页面壳（`page.js`）+ 工作台 React 面板（`studio/lib/client.js`）里的这个 iframe；
- **站点那侧**：独立部署的前端，React（或任何框架）由它自己决定；dsh 只负责给它一块区域；
- **代价**：主题不跟随（暗色要 `postMessage` 传 `data-ds-dark-theme`）、字体/快捷键不统一、探针只能跨域或同源断言；
- 另一处 iframe 用法不同：`agents/lib/detail.js` 用**同源 iframe 隔离 groupPage 的全局变量**（note/openNewDialog 会与本页抢全局）。

---

## 6. 逐工作台归属

| 工作台 | 挂载方式 | 证据 |
|---|---|---|
| workflow / kanban / memory / codebase / kb / agents / scheduler | **A** | 各自 `lib/client.<x>.js` 有 `require('react')` + `desktopWorkbenches.register` |
| **studio** | **A + D** | 面板是 A（注册式 React），面板里再 `iframe` 承载站点 |
| dashboard | **C2** | `lib/app/src/app.jsx`：`import React` + `createRoot`；`/app/dashboard-app.js` 预构建 |
| marketplace | **C1** | `window.React` + `createRoot(#vs-mp-root)`，vendor 脚本按序加载 |
| media / sessions / skills / parallel | **B** | 无 `require('react')`、无 `createRoot(`；服务端拼串 + 客户端少量 `innerHTML`（skills 15 / parallel 4 / sessions 2 / media 0） |
| imagegen | **C2** | `lib/canvas/freeCanvas.js` 有真实 `createRoot(`；画布是**自己的插件页** `/x/imagegen/canvas/`（`index.js:27` 明确"不是 dsh 客户端里的一个页签"） |
| kb（附加形态） | **A + C2** | 工作台面板走 A；`lib/web/kbSideview.js`（IDE 侧栏页）是预构建 React bundle，自己挂载 |
| **小红书笔记（真身）** | **D** | 在 studio 的 iframe 站点里，React 由该站点自建 |

---

## 7. 新工作台该选哪种

| 场景 | 选 | 理由 |
|---|---|---|
| 默认（要做 dsh 里的工作台） | **A** | 单一 React、错误边界、主题/锚点/守卫都现成 |
| 需要 `直开 /x/xxx/` 就能用、要 SSR 首屏 | **A + B 组合**（同一次取数，页面壳 + 注册面板） | 参考 `buildDashboardPayload` 的"一次装配两处用" |
| 页面已有一份独立 React 构建（如商城） | **C1**（vendor） | 但要注意：非 chunk 形态用不了 `require('react')` |
| 要承载**已存在的外部站点** | **D** | 唯一合理用法；需接受主题/交互不统一 |
| 纯展示、几乎无交互 | **B** | 零依赖、探针最好写 |

**一句话**：**A 是默认，C 是例外，B 是退路，D 只在"托别人的站点"时才用**——小红书工作台目前正是 D，所以它看起来"不是我们长出来的"，这是形态决定的，不是实现偷懒。

---

## 8. 附：三条容易踩的边界

1. **A 类里不要 `createRoot`**：会和宿主抢同一个容器；浮层用 `createPortal`（宿主已示范）。
2. **C1 里 `require('react')` 一定失败**：非 chunk 形态的脚本没有模块装载器 ⇒ 只能吃全局 `window.React`（marketplace 的注释就是为此写的）。
3. **D 类主题必须显式传**：iframe 里的文档拿不到父页的 `body[data-ds-dark-theme]`，要么 postMessage，要么站点自己实现跟随 —— 这是 studio 站点与工作台视觉不一致的根因之一。
