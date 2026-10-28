---
name: workbench-authoring
description: 在 VsSaros / dsh 里新建或改造「工作台」（workbench）时使用 —— 注册式 React 工作台、SSR 页面型、市场第三方包，以及工作台内嵌 AI 助手 / 右侧对话栏 / 默认 agent。覆盖目录结构与打包、清单与注册（desktopWorkbenches、chunk、cordis.patch.yml）、共享 UI 层（wb-* 原语与 --dsw-alias / --wb-* 令牌）、AI 助手栏伸缩的统一做法、数据落盘、探针与守卫、以及真机踩过的坑。当用户说「做一个工作台」「把这个页面改成工作台」「工作台加个 AI 助手 / 右侧对话框」「工作台 UI 统一 / 不跟随主题」「工作台上架商城」「工作台图标是 🧩」时触发。
version: 1.0.0
platforms: [win32, darwin, linux]
user-invocable: true
disable-model-invocation: false
---

# 工作台制作（dsh / VsSaros）

把「一块业务界面」做成 VsSaros 的**工作台**：能注册进宿主、能从启动器/侧栏打开、跟随明暗主题、能被守卫与探针验证、能上架商城。

本技能固化三类契约：**结构**（怎么注册）、**视觉**（怎么长得像 dsh）、**验证**（怎么证明它真的对）。

## 何时用

- 新建工作台（业务页 / 看板 / 画布 / 多窗口）
- 把已有页面改成工作台
- 工作台「不跟随暗色」「图标是 🧩」「页面空白」「点安装没反应」「注册被拒」
- **工作台里要加 AI 助手 / 右侧对话框 / 让新会话默认选中某个 agent** → 先读 `references/embedding-ai-assistant.md`
- 要统一工作台 UI、要写守卫/探针、要上架商城

**不适用**：纯后端插件（没有界面）、只改业务逻辑不动承载形态。

## 第一步：定形态（选错要重写）

| 形态 | 适用 | 成本 | 现状样例 |
|---|---|---|---|
| **注册式 · React 单页**（默认推荐） | 左侧业务区 + 右侧 AI 助手 | 中 | `vssaros-agents`、`vssaros-kanban`、`vssaros-kb` |
| **内嵌成熟应用**（iframe 托管页 + 右侧助手） | 已有成熟前端（站点/后台） | 低 | `vssaros-studio`（`/x/studio/`）、`vssaros-marketplace` |
| **多窗口可拼装** | 多信息源并看 | 高 | `vssaros-dashboard` 一类 |
| **SSR 页面型** | 旧页面 / 终端类 | 低 | 不推荐改注册式 |

注册式工作台由**宿主渲染 React**；`customFrame: true` 时宿主会注入 `props.conversation`（官方对话本体）。

## 第二步：目录与清单（最容易死在这里）

标准目录（以商城为例，逐字对得上仓库现状）：

```
dsh-plugins/vssaros-<module>/
├── package.json          main=lib/index.js；exports 含 ./client；dsh.bundle.patch / dsh.client.inject；files 逐项列全
├── cordis.patch.yml      插件进运行时的唯一入口（缺它 ⇒ 静默不加载）
└── lib/
    ├── index.js          Host 半（服务、路由、数据）
    ├── client.js         客户端入口（apply(ctx)）
    └── client.<name>.js  可选：客户端子块（面板实现）
```

**四条硬规则**：

1. 客户端入口**绝不能写 `chunk:` 字段** —— 装载器按「包内 chunk」校验，`chunk: 'client.js'` 会让**整个 web boot 失败**。入口只声明 `id` + `factory`；子块才是 `chunk: 'client.<name>.js'`。
2. 清单必须有 `exports['./client']` + `dsh.client.inject`；`dsh.bundle.patch` 指向 `cordis.patch.yml`，否则插件不进运行时且**宿主不报错**。
3. 改过任何客户端子块：**升版本号 + touch 入口**（`check-chat-surface-chunks` 按 mtime 判「入口比子块旧」）。
4. 描述符必须带 `repository`（`vssaros:<module>` 或 https 地址），漏了会 `Invalid workbench repository` —— 模块加载成功但注册被拒，只有页面 console 能看到。

字段模板与注册代码见 `references/manifest-and-registration.md`；打包/部署/两套宿主服务名见 `references/directory-and-packaging.md`。

## 第三步：注册

```js
const DESCRIPTOR = {
	title: '任务台',
	description: '一句话说清它替用户做什么',
	repository: 'vssaros:tasks',   // 必填
	icon: 'codicon:checklist',     // codicon 需经 wbIconEmoji 映射，否则渲染成 🧩
	customFrame: true,             // 需要 props.conversation（AI 助手）时必开
	layout: { businessSide: 'left' },
};

function apply(ctx) {
	ctx.inject(['desktopWorkbenches'], (c) => {
		c.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, TasksPanel), 'vssaros-tasks: workbench');
	});
}
```

`ctx.get('desktopWorkbenches')` 拿不到时不要判死 —— 客户端服务要用 `ctx.inject`。

## 第四步：UI（用共享层，别自绘一套）

共享层在 `dsh-plugins/vssaros-workbenches/lib/client.ui.js`，宿主已全局注入样式。

**必须满足的 6 条**（`check-workbench-style.mjs` 逐条查）：

| 条款 | 要求 |
|---|---|
| S6 | 组件里 ≥10 个不同的 `wb-*` 类（证明真在用共享层） |
| S7 | 不出现裸色值（`#hex` / `rgba()` / `hsl()`），只能写在 `var(--dsw-alias-*, 兜底)` 里 |
| S8 | 根节点带 `data-vssaros-surface="workbench"` |
| TOOLBAR | 恰好 1 个 `data-dsh-workbench-toolbar`（宿主据此吸顶） |
| S9 | 有 `@container`（工作台会被塞进 320–420px 的侧栏 ⇒ 必须按**容器**响应，不能用 `@media`） |
| S11 | ≥3 个不同的 `data-*` 锚点（探针只认锚点；类名属视觉层） |

原语清单、令牌映射、布局骨架见 `references/ui-tokens-and-primitives.md`。

## 第五步：AI 助手栏（高频需求）

三句话：

1. **不是调模型**。助手 = 宿主注入的 `props.conversation`（官方 chat-surface 本体，内部含会话/输入框/流式）。
2. **要 `customFrame: true`**；且渲染它的 chunk 必须是**独立子块**（SSR 页脚本不在 chunk 装载器里，拿不到 `require`/`ctx`）。
3. **收起/展开必须用统一做法**：`display:none` 保留 DOM（不卸载）、不收窄条、展开入口放面板**右侧垂直居中**（顶部那行是宿主 header 的按钮，贴顶会重叠）、**展开按钮可拖到任意位置**（左键拖、<3px 算点击、右键复位、落点持久化）、收起入口在栏左上角、拖拽条收起时隐藏、收起态不挂「＋新会话」，状态存 `localStorage`。

⚠ **自绘 iframe 浮层做助手是死路**（两套助手，且浮层里的第二份客户端拿不到会话上下文）。

详见 `references/embedding-ai-assistant.md` 与 `references/assistant-collapse.md`。
**联调外壳时**（点会话没反应 / agent 显示错 / 浮条重复或被裁 / 业务面板消失 / 改完不生效）→ `references/panel-agent-and-chrome-pitfalls.md`。

## 第六步：验证（缺一不算完成）

```bash
node dsh-plugins/check-workbench-style.mjs      # 视觉/结构 6 条（只查 UNIFIED 名单里的包）
node dsh-plugins/check-workbench-catalog.mjs    # 清单 ↔ 注册一致性
node dsh-plugins/check-chat-surface-chunks.mjs  # 入口/子块 mtime 与 chunk 形状
node dsh-plugins/check-plugin-files.mjs         # package.json files 与目录实际文件一致
node dsh-plugins/check-assistant-collapse.mjs   # AI 助手栏伸缩一致性
node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs
```

新包还没进 `UNIFIED` 时，先用 `audit_workbench.mjs` 自查 13 条。**再做两件事**（能抓「假绿」）：

1. **变异测试**：把守卫对应的东西改坏（删一个 `data-*`、塞一行 `#ff0000`、把图标改成 🧩），确认守卫**变红**再还原；
2. **真机**：`VsSaros.exe %TEMP%\wb-<module>` 起沙箱，断言「注册表里有它 / 无 iframe（注册式）/ 切暗色颜色真变 / boot 无失败」。

写法与常见假绿见 `references/verification.md`。

## 必踩坑速查（每条都真机踩过）

1. 入口写 `chunk:` ⇒ **整个 web boot 失败**，不是单个页面坏。
2. 改子块不升版本/touch 入口 ⇒ 守卫红 + 浏览器吃旧缓存。
3. 用**类名**当探针锚点 ⇒ UI 统一后数到 0，看着像没渲染。
4. 裸色值 / 写不存在的令牌名 ⇒ 暗色主题静默回落。
5. 缺 `cordis.patch.yml` 或漏 `dsh.bundle.patch` ⇒ 插件**根本不加载且不报错**。
6. 漏 `repository` ⇒ `Invalid workbench repository`（只在 console）。
7. 用 `@media` 判宽度 ⇒ 侧栏与编辑区同窗不同宽，判不出来；用容器查询。
8. 两套页面各自取数 ⇒ 口径必分叉；取数函数只写一次。
9. 空态只写「暂无数据」⇒ 用户卡住；要给「为什么空 + 下一步」。
10. 助手栏自己发明交互（窄条/浮层/轮询）⇒ 与其它工作台手感不一致，且容易跨工作台串场。
11. 守卫/体检选了**死文件**（子块已并进入口）⇒ 对死代码给"已达标"的假结论。选文件顺序：入口里有 `register(` → 用入口；否则用入口 `require.async('./client.X.js')` 的那个。
12. 未注册的工作台「能装 ≠ 能跑」；界面要显式说「重启后可用」。

19. **`customFrame: true` 写了、但没有 client chunk**（`dsh.client` + `exports['./client']` + `files`）⇒ 永远只有"页面形态"、右侧**永远没有对话列**，而且**不报任何错**。
20. **「打开工作台后点会话 item 没反应」= 没装面板守卫**：会话点击走 `selectPanel(null)` 清空中栏，customFrame 页签却不会因它消失 ⇒ 中栏空了、页签还在。修法：拦 `selectPanel(null/undefined/'')` + `openSession` 后 `dw.showSession(id)`（都只在 `props.active` 时生效）。
21. **浮动工具条「多出一条」/「被右边缘裁掉」/「文字常显样式全乱」**：① 页面自带浮条与外壳 `.vssWbActions` 位置几乎重合（嵌入时摘掉页面那条）② 浮条挂在内容容器里会被挤出去（挂页面根层）③ **CSS 一条未闭合花括号会吞掉其后所有后代规则** —— 纯字符串断言抓不到，守卫要**数花括号**。
22. **改完不生效先分辨"模块半边 / 前端半边"**：`lib/index.js` 类改的是 Host 进程（重启 Host）；`lib/client*.js` 类改的是页面 chunk（重载 dsh 页面）；`chat-surface` / `workbenches` 的外壳 client 在 **IDE webview** 里（重载 IDE 视图）。判据：IDE 进程启动时间 vs 安装时间 + 磁盘那份里搜本次改动的特征串。

## 脚本

```powershell
$S = "<Base directory>\scripts"

# 生成注册式工作台骨架（清单 + Host 入口 + 客户端入口 + 面板）
node "$S\scaffold_workbench.mjs" tasks --dir dsh-plugins/vssaros-tasks --title "任务台" --icon codicon:checklist

# 体检一个包（13 条结构/视觉规则，可用于还没进 UNIFIED 的新包）
node "$S\audit_workbench.mjs" dsh-plugins/vssaros-tasks
```

## 参考文件

| 文件 | 内容 |
|---|---|
| `references/manifest-and-registration.md` | package.json / cordis.patch.yml / DESCRIPTOR / 注册代码 / chunk 规则 |
| `references/directory-and-packaging.md` | 目录结构、files 字段、两套宿主服务名、部署到 profile、版本与 mtime |
| `references/ui-tokens-and-primitives.md` | `wb-*` 原语全清单、`--wb-*` 刻度、`--dsw-alias-*` 用法、三种布局骨架 |
| `references/embedding-ai-assistant.md` | `props.conversation` / customFrame / 默认 agent preset / 布局细节 |
| `references/assistant-collapse.md` | **AI 助手栏伸缩的统一契约**（当前所有工作台必须一致） |
| `references/panel-agent-and-chrome-pitfalls.md` | **外壳四处联调**（媒体库实录）：面板守卫（点会话没反应）/ agent preset 抢占与 `.agent.md` / 浮动工具条重复与位置 / CSS 未闭合花括号 / 右侧面板被窄屏断点藏掉 / 模块半边 vs 前端半边的生效路径 + 逐条打勾清单 |
| `references/verification.md` | 守卫清单、探针写法、变异测试、常见假绿 |
| `scripts/scaffold_workbench.mjs` | 生成工作台骨架 |
| `scripts/audit_workbench.mjs` | 单包体检（13 条） |
| `test/run-workbench-skill-check.mjs` | **本技能自检**（防文档腐烂）：引用路径是否仍存在、代码事实是否还成立 |

> 姊妹文档：`.codebuddy/skills/dsh-workbench-authoring/`（给编码助手用的同主题技能，含更长的实战复盘）。改规范时两份要同步；本文件是**运行期 agent** 读的那份。
