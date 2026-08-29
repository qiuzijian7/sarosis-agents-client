---
name: workflow-node-dev
description: >-
  Use when adding a new workflow node (litegraph / Saros.* node) to the Agent Studio
  workflow canvas, wiring a matching chat tool-card preview (rendered with litegraph so
  it matches the canvas pixel-for-pixel), and verifying the node meets spec via the
  built-in node validation + canvas smoke tests.
metadata:
  allowed-tools: Bash(npx tsc:*), Bash(npx playwright:*), Bash(npm run test:e2e:*)
---

# Workflow New-Node Development

为 Agent Studio 工作流画布新增一个 `Saros.*` 节点，并让聊天框里的工具卡用
**真实的 litegraph 画布**渲染该节点的预览，使其与工作流画布中的最终效果完全一致；
最后用内置校验 + 画布冒烟测试确认节点满足规格。

适用信号：用户要"加一个新节点 / 新工作流节点 / 在聊天里展示某个节点的效果 /
节点预览卡 / 让聊天卡和画布一致"。

## 关键架构事实（必读，否则会踩坑）

| 事实 | 来源 | 影响 |
|------|------|------|
| 节点**两处注册**，且必须保持一致 | `registry.ts` 的 `registerSarosNodes()` + `sarosLiteGraphNodes.ts` 的 `NODE_CONFIGS` | `registerSarosNodes()` 是 spec 单一真源；`NODE_CONFIGS` 是 LiteGraph 真实类。两者端口/widget **数量与名字不一致**会导致 `syncNodePortsToSpec` 在槽位数不等时**直接放弃同步**，画布上端口缺失 |
| 颜色是单一真源 `SAROS_NODE_COLORS` | `registry.ts` 导出，`sarosLiteGraphNodes.ts` 通过 `SAROS_COLORS` 复用 | 不要在 `NODE_CONFIGS` 里硬编码第二份色值（曾导致 palette 图标与画布颜色漂移） |
| 分支端口名**不可改** | `Saros.IfElse`/`Saros.Switch` 的 `true/false/case-1..4/default` | `executionGraph.isEdgeActive` 按 `edge.sourceHandle === 分支名` 路由，改名会让分支静默失效 |
| `Saros.ModelImageGen` 反例 | `sarosLiteGraphNodes.ts` 注释 | schema 节点已在 `registry.ts` 注册并生成 LiteGraph 类；在 `NODE_CONFIGS` 重复声明会 `registerNodeType` 后写覆盖，复活旧 widget（"两层参数 UI" bug）。**新增节点优先走 Saros native 路径** |
| 聊天面板是**纯 DOM**（`src/vs/sessions/browser/agentChat/*`），无 litegraph 实例 | 搜索 `LiteGraph|litegraph` 在 agentChat 包内**零匹配** | "用 litegraph 绘制聊天卡"必须通过**独立小画布实例**渲染真实节点类，不能在聊天卡里手抄 DOM 伪节点 |

## 三步流程

### 第 1 步：新增节点（webview 包内，两处同步）

**1a. spec（单一真源）** — 在
`src/vs/sessions/contrib/agentStudio/webview/src/features/workflowEditor/comfyHost/registry.ts`
的 `registerSarosNodes()` 末尾追加：

```ts
registerNodeSpec({
  type: 'Saros.MyNode',                 // 必须含 "."，否则 validateNodeSpec 报警
  kind: 'native',                       // Saros 自研节点统一用 native
  title: '我的节点',
  category: 'saros',
  inputs:  [{ name: 'in',     type: 'SAROS_JSON' }],
  outputs: [{ name: 'out',    type: 'SAROS_JSON' }],
  widgets: [{ name: 'myParam', type: 'STRING', default: '' }],
  color: SAROS_NODE_COLORS.myNode,      // 在 SAROS_NODE_COLORS 里加一项（见下）
});
```

若 `SAROS_NODE_COLORS` 尚无该 key，先在 `registry.ts` 的 `SAROS_NODE_COLORS` 对象里加
`myNode: '#xxxxxx'`（单一真源，见 `references/node-template.md`）。

**1b. LiteGraph 真实类** — 在
`.../comfyHost/sarosLiteGraphNodes.ts` 的 `NODE_CONFIGS` 数组**末尾、注释块之前**追加：

```ts
{
  type: 'Saros.MyNode', title: '我的节点', color: SAROS_COLORS.myNode,
  inputs:  [{ name: 'in',  type: 'SAROS_JSON' }],
  outputs: [{ name: 'out', type: 'SAROS_JSON' }],
  widgets: [{ type: 'text', name: 'myParam', value: '' }],   // type 用 'text'/'toggle'/'button'
},
```

⚠ **一致性铁律**：`NODE_CONFIGS` 里该项的 `inputs/outputs/widgets` 的**数量、name、
type** 必须与 1a 的 spec 完全一致（widget 的 `name` 对应 spec 的 `name`，`type:'text'`
对应 spec 的 `type:'STRING'`）。否则画布端口缺失或颜色漂移。

- 富身份节点（`Saros.Agent/Skill/Tool` 风格）：加 `hidden: true` widget，让 DOM 卡片/身份卡接管取值，canvas 不画空框。
- 需要多行提示词：widget 加 `multiline: true`（ComfyUI 风格自动高度）。

**1c. 校验语法** — 跑 `npx tsc --noEmit -p src/tsconfig.json`（webview 子包对应 tsconfig），确保两处都已注册且类型正确。

### 第 2 步：聊天工具卡用 litegraph 渲染（与画布一致）

需求要求"聊天框中增加对应工具卡片，用 litegraph 绘制，效果与工作流画布一致"。
由于聊天面板（主线程 `agentChat` 包）本身无 litegraph，正确做法是：

**在聊天卡里内嵌一个独立的 litegraph 小画布实例，渲染该节点的真实 `LGraphNode` 类。**
这复用 `registerSarosLiteGraphNodes()` 已注册的真实类 + `comfyNodeStyle` 的
`drawNode`/`drawWidgets` 接管，从而保证**像素级一致**（不是手抄 DOM 仿制品）。

实现骨架见 `references/chat-card-litegraph-preview.md`，要点：

1. 在聊天卡组件里 `import { LiteGraph, LGraph, LGraphCanvas } from '@comfyorg/litegraph'`
   并 `import { registerSarosLiteGraphNodes } from '<comfyHost>/sarosLiteGraphNodes.js'`
   （确保只注册一次：`registerSarosLiteGraphNodes` 是幂等的）。
2. 创建 `new LGraph()` + `new LGraphCanvas(canvasEl, graph)`，把真实节点
   `graph.add(new (LiteGraph.getNodeType('Saros.MyNode'))())` 加进去，`canvas.draw()`。
3. 复用 `comfyNodeStyle` 的 `applyComfyNodeStyle(canvas)` 让小画布也走 ComfyUI 风格
   标题栏/widget 绘制 —— 与画布同一套视觉代码，确保一致。
4. 卡片高度用 `node.size` 自适应；监听 `_register` 的 dispose 释放 canvas（`canvas.destroy()`）。
5. 在 `agentChatPanel.toolCards.ts` 的 `_createToolCallCardCore`（**private**，约 575 行；
   公开的 `_createToolCallCard` 在 461 行只做 override + 追加审批区，真正的 key 分发在
   core 内）里为 `Saros.MyNode` 的工具名加分支。注意 core 第一行是
   `const key = (tc.name || '').toLowerCase()`（576 行）—— 即 **key 取自 `tc.name` 的小写**，
   新增分支要照此规则：`if (key === 'my_node') { return this._createMyNodePreviewCard(tc, key); }`
   （参考同方法内 `update_plan` / `workflow` 的专用卡分支写法：每个族的 key 集合由
   `TOOL_XXX_TOOLS` 这类 Set 持有，可仿照新增 `MY_NODE_TOOLS` Set）。

> 备选（仅当严禁引入 litegraph 依赖时）：用 DOM 复刻 `comfyNodeStyle` 节点外观
> （圆角暗色卡片 + `⌄` 标题栏 + widget 字段行）。但这是仿制品，无法保证与画布逐像素一致，
> **不推荐**用于"与画布一致"的硬性要求。

### 第 3 步：测试是否满足要求

**3a. spec 校验（必跑）** — `registry.ts` 已导出 `validateNodeSpec(spec)`，在单测里：

```ts
import { validateNodeSpec, getNodeSpec } from '<comfyHost>/registry.js';
const issues = validateNodeSpec(getNodeSpec('Saros.MyNode')!);
assert.deepStrictEqual(issues, []);   // 无重复端口名 / type 含 "." / 输入输出非空
```

**3b. 画布冒烟（端口数 & 颜色 & widget 一致性）** — 在 agentStudio 的 component fixture /
e2e 里：
- 新建 `Saros.MyNode` 节点，断言 `node.inputs.length === spec.inputs.length`
  且 `node.outputs.length === spec.outputs.length`（验证 `syncNodePortsToSpec` 不放弃同步）；
- 断言 `node.color === SAROS_NODE_COLORS.myNode`；
- 断言 `LiteGraph.getNodeType('Saros.MyNode')` 存在（验证 `NODE_CONFIGS` 注册成功）。

**3c. 聊天卡预览核对** — Playwright 断言聊天卡内 `<canvas>` 存在、尺寸 ≈ 节点 `size`、
且节点标题文字渲染；可选：对 `Saros.MyNode` 的画布截图与聊天卡画布截图做像素/结构 diff
（参考 `references/` 里的 fixture 写法，注意 fixture 固定尺寸与真实产品差异，见
`chat-customizations-editor` 技能的 "Fixture vs real product gaps"）。

**3d. 回归** — 跑 `npm run test:e2e:workflow`（或对应 workflow 包测试），确认老节点
（Start/End/Prompt/IfElse/Switch/Merge/…）未被破坏。

## 完成后

- 在 PR 描述里贴：节点在 palette 的截图、画布渲染截图、聊天卡 litegraph 预览截图。
- 更新 `comfyHost` 相关注释若新增了 widget 类型或富身份节点。
- 若新增了 `SAROS_NODE_COLORS` key，同步检查 palette 图标取色路径。
