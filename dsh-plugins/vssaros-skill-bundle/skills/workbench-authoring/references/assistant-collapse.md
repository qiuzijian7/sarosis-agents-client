# AI 助手栏：伸缩 + 「S2 一体条」

**所有工作台的助手栏伸缩与展开入口，都用这一套。** 改之前先看本文件，改完跑守卫。

## 契约（10 条）

| # | 规则 | 为什么 |
|---|---|---|
| 1 | 收起 = 助手栏 `display: none`，**DOM 保留** | 卸载会丢会话状态 / 滚动位置 / 正在流式的回复 |
| 2 | **不收成 30px 窄条** | 窄条里塞竖排文字会被拆成两列，实测很难看 |
| 3 | 收起入口：助手栏**左上角**「» 收起」 | 栏内操作，各工作台自己渲染 |
| 4 | 入口：**S2 + S4 一体条**（右边缘垂直居中，「切换」+ 分割线 +「↗」竖向叠成一条），**hover 时左侧滑出文字标签**；切换按钮**随状态换脸**：收起态「« 展开 AI 助手」→ 展开态「» 收起 AI 助手」（**不是消失**）；贴到面板左边时标签自动翻到右侧 | 顶部那行是宿主 header（已加载 / 外部打开），贴顶必重叠；两态都用同一个按钮，用户不必去栏内找收起入口；S4 让纯图标也能自解释 |
| 4b | 外壳用 **三态** `data-assist`：`none`（该工作台没有助手栏 ⇒ 只显示「外开」）/ `1`（已收起 ⇒ «）/ `0`（已展开 ⇒ »） | 没有助手栏的工作台（agents / codebase / kb…）不该出现点了没反应的按钮 |
| 5 | 拖拽条在收起时 `display: none` | 收起后宽度由 state 决定，拖了会被渲染覆盖 |
| 6 | 收起态**不挂**「＋新会话」 | 隐藏的栏里点不到 |
| 7 | 状态存 `localStorage.__vssaros<X>ConvCollapsed` | 关掉再开还是上次状态 |
| 8 | 用 **React state** 驱动 | 用 JS 硬改 DOM 会被后续渲染覆盖 |
| 9 | 宽度下限 `CONV_MIN = 320`，上限 `maxWidth: 70%` | 太窄放不下对话；太宽吃掉业务区 |
| 10 | 一体条**整组可拖**：<3px 算点击、落点夹在面板内且不高于 header 安全区（30px）、右键复位、位置存 `__vssarosWbActionsPos` | 用户可能想把它挪开；不夹取会压住宿主按钮 |

> 双击复位**不可用** —— 第一下点击就展开了，按钮随即消失。用**右键**复位。

## 分工：外壳渲染一次，工作台只写两行

之前踩过的坑：**每个工作台各自实现一份**，两个文件逐渐漂移（一个有右键复位、一个没有；阈值 3px vs 5px）。现在收归外壳。

```
vssaros-workbenches（外壳）
  └─ .vssWbActions            ← S2 一体条：‹«› 段 + 分割线 + «↗› 段
       ├─ [data-vssaros-wb-assist]        点它 → 派发 vssaros:assist-expand
       ├─ .wbDivider                       跟随「«」一起显隐
       └─ [data-vssaros-wb-open-external]  外开（服务端现签 token 的深链）

vssaros-studio / vssaros-marketplace（工作台）
  ① 面板根写 data-vssaros-assist-collapsed="1|0"
  ② 监听 vssaros:assist-expand → setCollapsed(false)
    监听 vssaros:assist-collapse → setCollapsed(true)
```

外壳据此决定「«」显隐（`data-assist="0"` 时隐藏「«」和分割线，整条缩成只剩「↗」）。

### 工作台侧的最小实现

```js
// 1) 面板根上报状态
react.createElement('div', {
	'data-vssaros-studio-panel': '',
	'data-vssaros-assist-collapsed': collapsed ? '1' : '0',
	ref: (el) => { if (el && el !== panelElState[0]) { panelElState[1](el); } },
	/* style: display: flex, position: relative … */
});

// 2) 收到外壳的展开事件就展开
react.useEffect(() => {
	if (!panelEl) { return undefined; }
	const onExpand = () => {
		collapsedState[1](false);
		try { localStorage.setItem(CONV_COLLAPSE_KEY, '0'); } catch { /* ignore */ }
	};
	panelEl.addEventListener('vssaros:assist-expand', onExpand);
	return () => panelEl.removeEventListener('vssaros:assist-expand', onExpand);
}, [panelEl]);
```

**不要**再在自己的插件里写展开按钮 / 拖拽实现 —— 守卫会直接判红。

## 外壳侧的实现要点

```js
const ACTIONS_POS_KEY = '__vssarosWbActionsPos';
const ACTIONS_SAFE_TOP = 30;   // 宿主 header 高度

function attachActionsDrag(el, frameEl) {
	// pointerdown 记录起点（不 preventDefault ⇒ 未拖动时按钮的 onClick 正常生效）
	// pointermove：位移 <3px 不算拖；超过才 setPointerCapture + 改 left/top
	//   落点 = clamp(base + 位移, 0..面板尺寸-组尺寸)，且 y ≥ ACTIONS_SAFE_TOP
	// pointerup：真拖过 ⇒ 写 localStorage + 吞掉紧随的一次 click（否则"松手即展开"）
	// contextmenu：复位到默认位并清存储
}
```

要点：

- **S4 标签**：每个动作包一层 `.wbWrap`，里面放按钮 + `.wbLabel`（`position:absolute; right:34px`，`opacity:0` → hover 1）。标签是 `pointer-events:none`，不抢拖拽。
  组被拖到离面板左边 <110px 时，给容器加 `data-label="right"` 把标签翻到右侧，否则会溢出面板触发横向滚动条。
- **吞 click** 必须同时有「`swallow` 定义」和「`addEventListener('click', swallow, true)`」——只留定义等于没吞。
- 恢复位置时**先夹一次**：窗口变小后旧坐标可能越界。
- 助手收起态变化会让整组变高/变矮 ⇒ 用 `MutationObserver` 监听 `data-vssaros-assist-collapsed`，变化后重新夹取。

## 当前覆盖情况（2026-10-26）

| 工作台 | 助手栏形态 | 一体条 |
|---|---|---|
| 商城 `vssaros-marketplace` | 右侧栏（可收起） | 有「«」+「↗」 |
| 萨罗斯平台 `vssaros-studio` | 右侧栏（可收起） | 有「«」+「↗」 |
| Bots `vssaros-agents` | 对话在**中栏** | 只有「↗」 |
| 小红书笔记 / codebase / kanban / kb / scheduler / workflow | 无右侧助手栏 | 只有「↗」 |

「«」的显隐完全由 `data-vssaros-assist-collapsed` 决定，所以没有助手栏的工作台天然只剩「↗」，不需要写特例。

## 验证

```bash
node dsh-plugins/check-assistant-collapse.mjs                       # 结构契约
node dsh-plugins/vssaros-workbenches/test/run-actions-drag-check.mjs  # 拖拽行为（假 DOM）
node dsh-plugins/vssaros-workbenches/test/run-workbench-open-external-check.mjs  # 深链与外开
```

改完必须做**反向突变**（改坏一处 → 确认变红 → 还原），至少覆盖：安全区、3px 阈值、吞 click、工作台上报状态。
