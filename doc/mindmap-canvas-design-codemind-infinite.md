# 思维导图 Canvas 实现方案（参考 infinite_canvas_vscode + Code-Mind-Map）

> 源项目：
> - `G:\CustomWorkspaces\AIProjects\infinite_canvas_vscode`（lout33，Canvas2D + webview 无限画布）
> - `G:\CustomWorkspaces\AIProjects\Code-Mind-Map`（OlegIGalkin，包装 **MindElixir** 真实思维导图引擎）
>
> 目标：在现有 canvas 编辑器（已实现 mindmap-canvas-replication-plan.md 的 Mindvas 复刻）之上，
> 补齐这两个项目独有的「思维导图语义」能力，形成「自动布局思维导图 + 可自由编辑画布」统一编辑器。
>
> 配套已有方案：`doc/mindmap-canvas-replication-plan.md`（本方案在其基础上增量扩展，不复述已落地部分）。

---

## 0. 现状盘点（已实现，确认可复用）

| 能力 | 位置 | 说明 |
|---|---|---|
| 纯逻辑层 | `common/mindmap/`：`mindmapTypes` / `treeModel` / `layoutEngine` / `nodeOperations` / `branchColors` / `edgeSides` | 森林构建、contour 布局、增删子/兄/翻转/平衡、分支着色、边侧自适应 |
| 编排层 | `browser/canvasEditor/canvasEditorController.ts` | undo/redo、addChild/addSibling/delete/flip/balance、relayout/relayoutSubtree/layoutForest、connectNodes/selectNodes、visit history、generateNodeLink |
| 渲染/交互层 | `view/canvasViewport.ts` | **pan/zoom(含 zoom-to-mouse)**、DOM 节点 + SVG 贝塞尔边、hover 连接点、自由连接虚线、edge 中点插入手柄、rubber-band 框选、节点拖拽子树边跟随 |
| Pane/大纲 | `canvasEditorPane.ts` | **大纲侧栏** `_renderOutline`、**四向空间导航**(direction-aware)、前进/后退、删除、edge 中点插节点 |

> 结论：`infinite_canvas_vscode` 的交互（pan/zoom/连接/框选/组拖拽）大部分已被任务 2 复刻。
> 本方案重点补两类 **GAP**：① Code-Mind-Map 的「思维导图语义」（折叠/展开、方向模式、源码跳转）；② infinite_canvas_vscode 的「resize handles」。

---

## 1. 两个源项目核心机制抽取

### 1.1 infinite_canvas_vscode（lout33）
- **CanvasState**：`nodes/edges/offsetX/offsetY/scale/selection`；`exportCanvasData/loadCanvasData`（**Obsidian `.canvas` 兼容**）；`createConnection` 忽略重复/自连；`getNodesInRect`（框选）；`notifyStateChange`。
- **InputHandler**（`mousedown` 统一分发）：中键/Alt+左 = pan；节点 = 组拖拽（移动所有选中）；`shift`+连接点 = 连线；背景 = 框选 or pan。`wheel`：Ctrl+滚轮 → zoom-to-cursor（clamp 0.1–8）；否则 pan（触控板两指）。`mouseup` 发 `canvas-bus` 事件。
- **CanvasRenderer**：`drawNode` 含 connection points（hover 显）、**resize handles**、**view/edit 按钮**、scrollbar 指示；`drawEdge` 贝塞尔（按 side）；`drawSelectionRect`。

### 1.2 Code-Mind-Map（OlegIGalkin）—— 包装 MindElixir
- **数据模型**：`nodeData` 树 `{ id, topic, children, direction, expanded }`；全局 `direction: 'right'|'left'|'both'|'flower'`；`theme`。
- **交互**：`bus.on('selectNodes' | 'operation' | ...)` 事件总线；**折叠/展开**（Space/点击角标）；**方向模式**切换；**Ctrl+点击节点 → 跳转源码文件:行**（`openExternal`/`commands`）。
- **扩展层**：autosave（`backupData` 写盘）、transparent theme、`urlTransform`。

---

## 2. 融合设计（对照现状找 GAP）

### 2.1 折叠/展开 —— 来自 Code-Mind-Map（**核心新增**）
- `mindmapTypes.ts`：`IMindmapNode` 增加 `expanded?: boolean`（默认 `true`）。
- `treeModel.buildForest`：节点 `!expanded` 时其 `children = []`，后代从森林移除（不渲染不布局）。
- `layoutEngine.computeLayout`：已天然只布局森林中存在的节点 → **折叠自动让出空间**，无需特判。
- `canvasViewport._createNodeElement`：有隐藏后代的节点在角上画 `▸/▾` 折叠角标（overlay，pointer-events 仅角标）。
- `canvasEditorController`：`toggleExpand(nodeId)` = `pushUndo` + 切 `expanded` + `onDataChanged` + 新增 `onExpandChanged` 事件。
- 大纲 `_renderOutline`：折叠节点显示 `▸/▾`，点击同步展开/折叠（双向高亮）。

### 2.2 方向模式（right / left / flower / tree）—— 来自 Code-Mind-Map
- `mindmapTypes.ts`：`IMindmapData` 增加 `direction?: 'right'|'left'|'both'|'flower'`（全局默认 `both`）；`IMindmapNode` 增加 `direction?`。
- `layoutEngine.computeLayout` 支持模式：
  - `right`/`left`：整树单侧（flower 变体 = 子节点绕根放射）。
  - `both`：现有左右均衡（= 默认）。
  - `flower`：根居中，直接子按角度放射（参考 MindElixir flower）。
- `controller.setDirection(mode)`：命令 + 工具栏/命令面板切换 → 切后 `relayout()`。
- 与现有 `toggleBalance`/`flipBranch` 区分：方向模式是**全局/子树根设定**；balance 是左右重新分配；二者可叠加。

### 2.3 Resize handles —— 来自 infinite_canvas_vscode（**补 GAP**）
- `canvasViewport._createNodeElement`：选中节点四角画 resize handle（overlay div，z-index 高于 text，仅 handle `pointer-events:auto`）。
- pointerdown on handle → resize 模式；pointermove 改 `node.width/height`（clamp min，编辑中隐藏 handle 防冲突）；pointerup → `relayoutSubtree()` + debounce 保存。
- 与 `kbMindmapGenerator` 生成的固定宽高兼容：resize 后写回 `width/height`。

### 2.4 Ctrl+点击跳转到源码 —— 来自 Code-Mind-Map（**差异化能力**）
- `mindmapTypes.ts`：`IMindmapNode` 增加 `source?: { file: string; line?: number; column?: number }`。
- `kbMindmapGenerator.ts`：生成时填充 `node.source`（来自 KB 条目的源码出处 file/line），使其可溯源。
- `canvasViewport`：Ctrl+click 节点（非拖拽，>阈值判定）触发 `onNavigateToSource(nodeId)`；Pane 用 `IFileService` + `opener`/`revealRange` 打开 file 并 reveal 到 line（复用 VSCode `openTextDocument` + `revealRange`）。
- 有 `source` 的节点角标显示 `↗` 提示可跳转。

### 2.5 主题/分支配色 —— 两者共有（强化）
- 现有 `branchColors` 已做分支配色；补：direction 模式切换时主题色同步；viewport 用 `node.color` 设左边框/连接线色。
- 可选：工具栏主题下拉（light/dark/transparent，类 MindElixir `theme`）。

### 2.6 事件总线 —— 来自 Code-Mind-Map `bus` 思路（**架构改进**）
- 在 `CanvasEditorController` 现有 emitter 风格上新增 `onExpandChanged / onDirectionChanged / onThemeChanged / onNavigateToSource`，替代散落 callback，便于未来 Agent 工具（P3）订阅。

---

## 3. 文件改动映射

| 文件 | 改动 |
|---|---|
| `common/mindmap/mindmapTypes.ts` | `IMindmapNode` +`expanded`/`source`/`color`；`IMindmapData` +`direction`/`autoLayout` |
| `common/mindmap/treeModel.ts` | `buildForest` 支持 `expanded` 过滤后代 |
| `common/mindmap/layoutEngine.ts` | `computeLayout` 支持 `direction` 模式（`right`/`left`/`flower`） |
| `common/mindmap/nodeOperations.ts` | `toggleExpand`、`setDirection` 纯函数 |
| `browser/canvasEditor/canvasEditorController.ts` | `toggleExpand`/`setDirection`/`applyTheme` 命令 + emit 事件 |
| `browser/canvasEditor/view/canvasViewport.ts` | 折叠角标、resize handles、Ctrl+点击跳转、方向/主题渲染 |
| `browser/canvasEditor/canvasEditorPane.ts` | 键盘（Space=折叠、Ctrl+点击=跳转）、方向/主题命令按钮、大纲折叠联动 |
| `browser/canvasEditor/canvasEditor.contribution.ts` | 注册命令（`toggleExpand`/`setDirection*`/`applyTheme`/`navigateToSource`）+ keybindings（Space） |
| `browser/views/knowledge/kbMindmapGenerator.ts` | 生成时填充 `node.source`（file/line） |
| `test/common/run-mindmap-tests.mjs` | 折叠布局 / direction 模式确定性单测 |

---

## 4. 分阶段实施

| 阶段 | 内容 | 验证 |
|---|---|---|
| **P0 折叠/展开** | `expanded` 模型 + treeModel/layout 过滤 + 角标 + Space 键 + 大纲联动 + 单测 | 单测：折叠后子树不布局、expand 往返 |
| **P1 方向模式** | `direction` 数据 + layoutEngine 三模式 + setDirection 命令/工具栏 | 单测：模式确定性布局（不重叠/相对间距） |
| **P2 编辑增强** | resize handles + Ctrl+点击跳源码（kbMindmapGenerator 填 source） | 手测：resize 后局部重排；Ctrl+点击 open file:line |
| **P3 主题/总线/Agent** | 主题下拉 + 事件总线 + Agent 工具（`mindmap_toggle_expand` 等） | 端到端场景 |

---

## 5. 验证

- **纯逻辑单测**：折叠后子树不参与布局；方向模式确定性（只断言相对位置/间距/不重叠，不断言绝对坐标）；expand 往返一致性；source 字段填充。
- **类型/规范**：`npm run compile-check-ts-native`（tsgo EXIT=0）；`read_lints` 0 错误；渲染层禁 `innerHTML`（DOM API）。
- **手测清单**：KB 生成 `mindmap.canvas` 打开 → 折叠/展开、切方向模式、resize、Ctrl+点击跳源码、大纲双向同步。

---

## 6. 风险与注意

- **折叠态落盘**：`expanded` 入数据模型，undo 快照（`JSON.parse(JSON.stringify(data))`）已含该字段，无需额外处理。
- **方向模式 vs 自由拖拽冲突**：自由拖拽后 `x/y` 固定，切方向模式触发重排会覆盖手拖位置。对策：在 `IMindmapData` 加 `autoLayout: boolean` 开关；`autoLayout=false` 时切模式不重排，保留手拖坐标（对齐 Mindvas `mindmap` 标志思路）。
- **resize 与编辑冲突**：resize handle 用 overlay 且 `z-index` 高于 text；contenteditable 激活时隐藏 handle。
- **源码跳转权限**：`file` 可能跨 workspace，`IFileService` 需处理外部路径；jump 失败优雅降级（toast 提示）。

## 7. 实施进度

### ✅ P0 折叠/展开（已落地 — 2026-07-31）
- `common/mindmap/mindmapTypes.ts`：`IMindmapNode` 增加 `expanded?: boolean`。
- `common/mindmap/treeModel.ts`：`buildForest` 在遇到 `expanded===false` 节点时剪枝其后代；新增 `getVisibleNodeIds(data)`（从根遍历、遇折叠停止深入）。
- `canvasEditorController.ts`：新增 `toggleExpand(nodeId?)`（pushUndo + 切 expanded + computeChildrenLayout 重排子树 + emit onDataChanged/onSelectionChanged/**onExpandChanged**）。
- `view/canvasViewport.ts`：导入 `getVisibleNodeIds`；`syncNodes` 计算可见集合并跳过折叠后代、传递 `hasChildren`；`_syncEdges` 跳过隐藏分支的边；节点角标 `▶/▼`（有子节点时显示，点击切换）；pointerdown 顶部优先处理角标（不触发拖拽/选中）。
- `canvasEditorPane.ts`：接线 `viewport.onToggleExpand`；`cmdToggleExpand`（编辑态 `_editingNodeId` 守卫）；大纲 `_renderOutlineNode` 用 **data 边**判断是否有子（避免被森林剪枝误判），角标可点击切换；工具栏新增「折叠」按钮。
- `agentStudio.contribution.ts`：注册 `sarosis.canvas.toggleExpand` 命令（`KeyCode.Space`）。
- `test/common/mindmap.test.ts`：新增「折叠/展开」套件（默认全展开、折叠中间节点隐藏后代、buildForest 剪枝、折叠不影响根坐标、折叠态 addChild 后展开可见）。
- 验证：`npm run compile-check-ts-native`（tsgo EXIT=0）；`run-mindmap-tests.mjs`（EXIT=0）。

### ✅ P1 方向模式（right/left/flower/tree）
- `mindmapTypes` 加 `MindmapDirection` 类型与 `IMindmapData.direction` 字段。
- layoutEngine `computeLayout`/`computeChildrenLayout` 按 `data.direction` 分派：`right`/`left` 整树强制单向、`both` 每层左右交替（平衡）、`tree` 自上而下树状（`_layoutTree` 两遍 measure+assign，父节点水平居中于子节点）、`flower` 中心发散（`_layoutFlower` 按 2π 扇区递归放射）。
- 边侧 `computeEdgeSides` 升级为 dominant-axis（自动选 left/right/top/bottom）；viewport `_getAnchor` 重写支持 top/bottom 连接面与按方向生成贝塞尔控制点。
- canvasEditorController.setDirection(mode)（写 undo + 整图重排 + onDirectionChanged）；工具栏 '方向' 循环切换按钮 + 命令 `sarosis.canvas.setDirection`（支持传入模式参数，缺省循环）。
- 验证：tsgo EXIT=0；单测 52 passing（含 5 个方向模式用例）。
### ⏳ P2 编辑增强（resize handles + Ctrl+点击跳源码）
### ⏳ P3 主题/事件总线/Agent 工具
