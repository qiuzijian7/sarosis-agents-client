# Mindvas 功能复刻设计方案 —— Saros Canvas 思维导图编辑器

> 源项目：`G:\CustomWorkspaces\AIProjects\mindvas`（Obsidian 插件，v0.3.0，16 个 TS 文件，MIT）
> 目标：在本项目复刻其全部思维导图能力，落地为 **`.canvas`（JSON Canvas）思维导图编辑器**，与 KB 已有的 `kbMindmapGenerator` 产物天然兼容。

---

## 一、Mindvas 源码分析结论

### 1.1 架构分层（原项目）

| 层 | 文件 | 职责 | 环境依赖 |
|---|---|---|---|
| 纯逻辑 | `mindmap/tree-model.ts` | 扁平 nodes+edges → 森林；depth/siblingIndex/direction(left/right) 推断 | 无（仅数据） |
| 纯逻辑 | `mindmap/layout-engine.ts` | **contour-based 树布局**：同级子树按 depth 列轮廓紧密排布、左右分支独立布局并围绕父节点垂直居中；`layoutChildren` 局部重排；`layoutForest` 组内多树网格流式排布 | 仅经 `node.moveTo` 写回 |
| 纯逻辑 | `mindmap/node-operations.ts` | addChild（根按两侧子数均衡选边/非根继承分支方向）、addSibling、deleteAndFocusParent（孤儿子节点重连父）、flipBranch（绕父中心 X 镜像） | 经 CanvasAPI 间接 |
| 纯逻辑 | `mindmap/branch-colors.ts` | 顶层分支轮换调色板（"1"-"6"），级联后代 + 入边 | 间接 |
| 纯逻辑 | `canvas/edge-updater.ts` | dominant-axis 启发式计算边连接侧（dx≥0 → right→left），拖拽中 40ms 节流实时更新 | 间接 |
| 纯逻辑 | `import/freemind-import.ts` | FreeMind/Coggle `.mm` XML → Canvas JSON（高度估算 + 左右布局） | DOMParser |
| 适配层 | `canvas/canvas-api.ts` | Obsidian Canvas 运行时封装：懒建 edge 索引（incoming/outgoing O(1) 查父子）、建/删节点边、选中+zoom | Obsidian API |
| 交互层 | `ui/keyboard-handler.ts` | 编辑/保存/加子/加兄/删除聚焦父/翻转/平衡布局/四向空间导航（侧感知 sibling 导航）；非拉丁键盘物理键 fallback | Obsidian 命令系统 |
| 交互层 | `ui/auto-resize.ts` | 编辑中节点只增不减（≤maxHeight），退出编辑测量预览高度并重排 | DOM/CM |
| 交互层 | `ui/navigation.ts` | Alt+点击=选整树；Ctrl+点击=缩放至分支 | DOM |
| 交互层 | `ui/outline-view.ts` | 大纲侧栏：按组列出树根、搜索过滤、折叠、拖放跨组移动、内联重命名、双向高亮同步 | Obsidian ItemView |
| 交互层 | `canvas/subtree-drag.ts` | 包装 `moveTo` 使拖拽节点同步移动整个子树；Alt=单节点 | DOM |
| 交互层 | `canvas/group-drag.ts` | Alt+拖组只动组框（留下外部节点） | DOM |
| 编排 | `main.ts` | 命令注册、工具栏 mindmap 开关（`data.mindmap` 标志）、Alt+点连接点插入中间节点、组 bounds 自动贴合（padding 20）、导航历史（50 条）、`obsidian://mindvas-navigate` 节点引用协议、resize 重试（离屏虚拟化节点 200ms 重测） | Obsidian |

### 1.2 核心算法要点（必须完整复刻）

1. **Contoupacking 布局**（layout-engine.ts）：每棵子树独立在 y=0 布局并返回 `Map<depth, {top,bottom}>` 轮廓；`packSubtrees` 逐个下移子树直到在所有共享 depth 列上避开已合并轮廓 + verticalGap；最后将直接子节点块围绕父节点垂直中心整体平移。左/右分支独立执行同一流程（x 方向镜像）。
2. **方向推断**：depth-1 按子节点中心 x ≥ 根中心 x 判 right/left；更深层继承分支方向。`detectDirection` 优先看已有子节点位置，其次看自身相对父的位置。
3. **森林构建**：无入边节点为根；group 节点跳过；children 按 y 排序得 siblingIndex；多根按子树大小降序。
4. **删除重连**：删非根节点时其子节点全部重连到父节点，边侧按分支方向。
5. **平衡布局切换**：全在一侧 → 奇数位镜像到对侧；已分布两侧 → 全部镜像回右侧，随后 `layoutChildren` 清理。

### 1.3 完整功能清单（复刻范围）

键盘编辑（增删子/兄、编辑、保存）、四向空间导航、自动布局（全局/局部/森林）、分支着色、子树拖拽、自动 resize、插入中间节点、平衡布局、分支翻转、大纲面板、节点引用链接、导航历史、FreeMind 导入、mindmap 模式开关、9 项设置。

---

## 二、本项目现状盘点（复用点）

| 已有件 | 位置 | 复用方式 |
|---|---|---|
| `.canvas` 生成器 | `browser/views/knowledge/kbMindmapGenerator.ts` | 数据格式源头；`IKbMindmap/IKbMindmapNode/IKbMindmapEdge` 类型抽到 common 层共享 |
| KB 图谱编辑器范式 | `browser/kbGraphEditorPane.ts` + `views/knowledgeBase/kbGraphView.ts` | 新 EditorPane 的直接模板（EditorPane + vanilla TS view + Emitter） |
| Agent 画布（React Flow） | `webview/src/features/workflowEditor/` | **不复用**——workflow 专用；思维导图编辑器走 browser 层 vanilla 路线（与 kbGraph 一致，避免 webview 通信开销） |
| Canvas 视觉稿 | `_saros_canvas_mockup_v2.html` | CSS 配色/节点样式参考 |
| 纯模块单测基建 | `test/common/run-<name>-tests.mjs` | 纯逻辑层全部可测（布局确定性断言） |

**缺口**：项目目前能**生成** `.canvas` 但无法**查看/编辑**——这正是复刻的切入点。

---

## 三、总体架构

```
contrib/agentStudio/
├── common/mindmap/                    ← 纯逻辑层（环境无关，禁 DOM/VS Code API）
│   ├── mindmapTypes.ts                ← JSON Canvas 数据模型（自 kbMindmapGenerator 提炼扩展：
│   │                                     side/end/color/group/mindmap 标志；IKbMindmap 改从此 re-export）
│   ├── treeModel.ts                   ← buildForest/findTreeForNode/getDescendants/siblings/direction
│   ├── layoutEngine.ts                ← contour packing（输入 data + config，输出 Map<id,{x,y}>）
│   ├── nodeOperations.ts              ← addChild/addSibling/delete/flip/balance 的纯数据计算
│   │                                     （返回 IMindmapMutation：新建节点/边、删除、位移，不碰存储）
│   ├── branchColors.ts                ← 调色板分配纯函数 → Map<id,color>
│   ├── edgeSides.ts                   ← computeEdgeSides / 全量边侧更新
│   └── freemindLayout.ts              ← .mm 树 → Canvas JSON 布局（XML 解析在 browser 层）
│
├── browser/canvasEditor/              ← 编辑器层
│   ├── canvasEditorInput.ts           ← EditorInput（resource=.canvas 文件）
│   ├── canvasEditorPane.ts            ← EditorPane（对齐 kbGraphEditorPane 模式）
│   ├── canvasEditor.contribution.ts   ← 注册 pane + IEditorResolverService 按 .canvas 解析
│   │                                     + 命令/快捷键/设置注册
│   ├── view/
│   │   ├── canvasViewport.ts          ← pan/zoom 容器（transform），DOM 渲染节点 + SVG 贝塞尔边
│   │   ├── canvasNodeElement.ts       ← 节点元素：选中态、contenteditable 内联编辑、
│   │   │                                 自动 resize（测量 scrollHeight，编辑中只增不减）
│   │   ├── canvasEdgeLayer.ts         ← SVG 边渲染、按 edgeSides 实时改连接侧
│   │   ├── canvasSelection.ts         ← 单/多选、Alt=选整树
│   │   └── outlinePanel.ts            ← 大纲：分组树根列表、搜索、折叠、拖拽、高亮同步
│   ├── canvasEditorController.ts      ← 编排：mutation → 应用 → 保存（IFileService 写回 JSON）
│   │                                     键盘命令、子树拖拽、插入中间节点、导航历史、撤销栈
│   ├── freemindImport.ts              ← DOMParser 解析 .mm + 调 common/freemindLayout
│   └── media/canvasEditor.css
│
└── test/common/run-mindmap-tests.mjs  ← 纯逻辑层单测
```

**关键设计决策**：

1. **纯逻辑层零依赖化**：Mindvas 的布局/树算法本只读写 `x/y/width/height`，把 `Canvas/CanvasNode` 替换为 plain data 接口后即可原样移植算法，经 `IMindmapMutation` 描述变更，由 Controller 统一应用并落盘。布局引擎由此可 100% 确定性单测（对齐项目"纯逻辑抽纯模块再测"惯例）。
2. **DOM 渲染而非 Canvas 2D**：节点需要内联文本编辑与 DOM 高度测量（auto-resize），与 Obsidian Canvas 同构——viewport 用 CSS transform（translate+scale），节点绝对定位 div，边用 SVG path（贝塞尔，fromSide/toSide 决定控制点方向）。kbGraphView 的 Canvas 2D 路线不适合可编辑场景。
3. **编辑模型**：单文件真相 = `.canvas` JSON。Controller 持有内存模型 → mutation 应用 → 序列化写回（debounce 300ms）。撤销/重做一个轻量快照栈（JSON diff 粒度到 mutation 批）。
4. **不引入 React Flow**：编辑器在 browser 层 vanilla 实现（同 kbGraph），webview React 技术栈不混入。

---

## 四、功能映射与适配方案

| Mindvas 功能 | 本项目方案 | 差异说明 |
|---|---|---|
| buildForest/direction | `common/mindmap/treeModel.ts` 原样移植 | 数据源改为 JSON Canvas 解析结果 |
| Contour 布局三件套（layout/layoutChildren/layoutForest） | `common/mindmap/layoutEngine.ts` 原样移植，输出 positions | 动画由渲染层加 CSS transition class（对齐原作 `mindmap-animating`） |
| addChild/addSibling/delete/flip/balance | `nodeOperations.ts` 纯函数化 | 新节点 id 用 `genId()`（16 hex，同原作） |
| 分支着色 | `branchColors.ts` + 设置开关 | 调色板 "1"-"6" 映射到 sarosis 主题色（mockup 已有 6 色变量） |
| 边侧自适应 | `edgeSides.ts`；拖拽中 40ms 节流 | 同原作 |
| 键盘命令 | 注册为 workbench action + keybinding（Enter 编辑、Tab 加子、Shift+Enter 加兄、Del 删除聚焦父、方向键空间导航） | 弃用 Obsidian checkCallback 模式；非拉丁物理键 fallback **不移植**（VS Code keybinding 按 code 匹配，天然免疫） |
| 自动 resize | contenteditable + MutationObserver/scrollHeight 测量 | 编辑中只增不减；退出编辑测量+局部重排；maxNodeHeight 封顶 |
| 子树拖拽 | pointerdown(capture) 记录后代集，pointermove 同步位移；Alt=单节点 | 无需 moveTo monkey-patch（自绘渲染层，直接改数据） |
| 插入中间节点 | Alt+点击边中点手柄（渲染层在边上画 connection handle） | 原作 Alt+点击连接点；出边批量/入边单个两种语义保留 |
| Alt/Ctrl+点击节点 | Alt=选整树；Ctrl=缩放至分支（viewport fitBBox） | 同原作 |
| 大纲面板 | 编辑器内右侧栏（同 pane 内 grid 布局），搜索/折叠/拖拽/双向高亮 | 不做独立 workbench view，降低首版复杂度 |
| 组（group） | 数据层支持 type:'group' 节点：森林构建跳过、组 bounds 自动贴合(padding 20)、森林网格布局 | 完整保留 |
| FreeMind 导入 | 命令 + 文件 picker（`IFileDialogService`），解析→JSON→落盘并打开 | 同原作 |
| 节点引用 | 复制 `command:sarosis.canvas.revealNode?{...}` 链接 / 内部 URI 处理器 | 替代 obsidian:// 协议 |
| 导航历史 | Controller 内 50 条栈 + 前进/后退命令 | 同原作；鼠标侧键可选设置 |
| mindmap 模式开关 | `.canvas` JSON 顶层 `mindmap: boolean` 标志 + 编辑器工具栏切换按钮 | 与原作 `data.mindmap` 完全同构 |
| 9 项设置 | `IConfigurationService` 注册 `sarosis.canvas.*`（autoLayout/autoColor/hGap/vGap/默认宽高/maxHeight/zoomPadding/mouseNav） | 同原作默认值 |

**不移植**：Obsidian 专有件（ItemView/协议处理器/CM iframe 测量）、非拉丁键盘 fallback、插件 settings tab（用配置服务替代）。

---

## 五、集成点

1. **KB 打通**：`knowledgeBaseView` 中 `.canvas` 文件双击 → `CanvasEditorPane` 打开；`kbMindmapGenerator` 的 `IKbMindmap*` 类型迁移至 `common/mindmap/mindmapTypes.ts`（原处 re-export 保持兼容）。导入自动生成思维导图后可直接可视化编辑，形成「导入→生成→人工整理」闭环。
2. **Agent 工具（P3 可选，差异化能力）**：注册 `mindmap_add_child`/`mindmap_relayout`/`mindmap_read_outline` 工具（走 builtinToolProvider + toolset 机制），让 Agent 能读写画布——Obsidian 做不到的扩展。
3. **编辑器注册**：`IEditorResolverService` 将 `.canvas` 后缀解析到 `CanvasEditorInput`（先查 kbNote 注册方式对齐）。

---

## 六、分阶段实施

| 阶段 | 内容 | 验证 |
|---|---|---|
| **P0 纯逻辑层** | common/mindmap 7 个模块移植 + `run-mindmap-tests.mjs`（森林构建/direction/布局确定性/删除重连/翻转/着色/边侧/FreeMind 布局） | 单测全绿 + tsgo 全检 |
| **P1 编辑器 MVP** | EditorInput/Pane/注册；viewport 渲染（节点+边+pan/zoom）；选中/拖拽/内联编辑；保存 | 手测：打开 KB 生成的 mindmap.canvas，可浏览可编辑 |
| **P2 交互全集** | 键盘命令、自动布局接入、分支着色、子树拖拽、插入中间节点、平衡/翻转、大纲面板、组支持、FreeMind 导入 | 手测清单对齐 README 功能表逐项过 |
| **P3 集成增强** | KB 视图打通、节点引用、导航历史、设置 UI、Agent 工具 | 端到端场景验证 |

---

## 七、风险与注意

- **布局单测只断言确定性契约**（相对位置/间距/不重叠），不断言绝对坐标——对齐项目测试惯例。
- 渲染层禁 `innerHTML`（项目硬限制），一律 DOM API。
- 大纲拖拽跨组移动节点时需同步更新 group bounds（对齐原作 `updateGroupBounds` 时机：pointerup 后 rAF）。
- 离屏节点高度不可测量问题：首版 DOM 全量渲染（思维导图量级 < 500 节点无压力），不做虚拟化，规避原作 resize-retry 复杂度。
