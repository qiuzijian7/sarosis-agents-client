# 思维导图渲染层改造 POC 计划：maxGraph 替换 LiteGraph

> 目标：将 agentStudio 第三视图（MindMapPanel）的渲染层从 LiteGraph 切换到 **maxGraph 0.24**（mxGraph 官方现代继任者），消除"脑图寄生在 LiteGraph 画布上"的架构错位，同时保留已实现的 `drawioSerializer`（飞书导入资产）与 `common/mindmap` 布局引擎，收敛双引擎债务。

---

## 0. 背景与约束（已核实）

| 事实 | 来源 |
|---|---|
| 脑图侧 LiteGraph 唯一直接依赖 | `webview/src/features/mindmap/MindMapNode.ts:15` — `import { LiteGraph, LGraphNode } from '@comfyorg/litegraph'` |
| MindMapPanel 复用 LiteGraphCanvas 渲染链路 | `MindMapPanel.tsx:7` 注释、`MindMapPanel.tsx:138` 挂载 |
| workflowEditor 整链深度绑定 LiteGraph | `LiteGraphCanvas.tsx:18`、`ComfyGraphAdapter.ts`、`widgetBridge/*` 等 `import from '@comfyorg/litegraph'` |
| drawio 双向序列化已实现 | `mindmap/drawioSerializer.ts`（mxGraphModel ↔ 内部模型） |
| 存在并行 `common/mindmap` 引擎 | `common/mindmap/`（10 文件：layoutEngine / treeModel / nodeOperations / freemindLayout …） |
| 存在并行 `browser/canvasEditor` 方案 | `browser/canvasEditor/`（7 文件，仍被 `agentStudio.contribution.ts` 引用） |
| maxGraph 与 mxGraphModel 同标准 | maxGraph 读取/写出相同 XML 结构，drawio 兼容天然 |

**关键约束**：LiteGraph 不能移除（workflowEditor 依赖）。本 POC **只替换脑图渲染层**，不动 workflowEditor 链路。

---

## 1. 改造策略（三段式）

```
内部模型 (MindMapNodeData / ITreeModel)
   │  ← 复用 common/mindmap/layoutEngine.ts（布局，不依赖渲染器）
   ▼
渲染适配层 (maxGraphGraphRenderer)  ← 【新增，替换 MindMapNode + LiteGraphCanvas 寄生】
   │  ← maxGraph Graph/Vertex/Edge，绘制节点矩形 + 连接线
   ▼
序列化桥 (drawioSerializer.ts)      ← 【保留，仅微调 bug】
   │  ← mxGraphModel XML（飞书导入/导出）
   ▼
外部 drawio / 飞书
```

**不复用 maxGraph 的自动布局**——它提供的是图引擎（增删节点、连线、平移缩放），放射布局仍用本项目已有的 `common/mindmap/layoutEngine.ts`（contour packing + 多方向）。maxGraph 只负责"把算好的坐标画出来 + 交互"。

---

## 2. 文件级改动清单

### 2.1 新增文件

| 文件 | 作用 |
|---|---|
| `webview/src/features/mindmap/maxGraphRenderer.ts` | **核心新增**。封装 maxGraph `Graph` 实例：初始化画布、根据 `ITreeModel` 创建 `mxCell`（vertex=节点矩形，edge=父子连线）、应用 `layoutEngine` 输出的坐标、绑定平移/缩放/选中事件。替代 `MindMapNode.ts` 的 LiteGraph 寄生。 |
| `webview/src/features/mindmap/maxGraphRenderer.types.ts` | maxGraph 渲染层与内部模型之间的映射类型（`MindMapNodeData → mxCell` 字段映射约定）。 |
| `webview/src/features/mindmap/__tests__/maxGraphRenderer.test.ts` | 单测：给定 `ITreeModel`，断言生成正确的 vertex/edge 数量与坐标；验证节点增删后图同步。 |
| `webview/src/features/mindmap/__tests__/mindmap-maxgraph-e2e.mjs` | 仿 `workflowComfyLiteGraphE2E.test.mjs` 的 headless e2e：构造脑图 → 经 `drawioSerializer` 导出 mxGraphModel → 断言 XML 结构。 |

### 2.2 修改文件

| 文件 | 改动 |
|---|---|
| `webview/src/features/mindmap/MindMapPanel.tsx` | 移除 `LiteGraphCanvas`（mode="mindmap"）挂载；改为挂载 `<MaxGraphCanvas>`（新组件，内部实例化 `maxGraphRenderer`）。保留 React 工具栏（导入/导出/布局切换）。 |
| `webview/src/features/mindmap/MindMapNode.ts` | **删除或降级为纯数据模型**。`LGraphNode` 寄生逻辑移除；若 `MindMapNodeData` 类型定义在其中，迁移至 `common/mindmap/mindmapTypes.ts`。 |
| `webview/src/features/mindmap/radialLayout.ts` | 保留作为 fallback，但**主路径改用 `common/mindmap/layoutEngine.ts`**（更完整）。或在 `maxGraphRenderer` 中注入布局策略，二选一。 |
| `webview/src/features/mindmap/drawioSerializer.ts` | 修复第 64 行 `mxCell` 属性拼接 bug：当前 `.replace(/></g,'>')` 会错误截断边属性（如 `style`/`source`/`target`）。改为标准 XML 转义 + 属性 join，不影响导出结构。 |
| `webview/src/features/mindmap/markdownImport.ts` | 仅检查导入产出是否仍符合 `MindMapNodeData`/`ITreeModel` 契约；如已对接 `common/mindmap/treeModel.ts` 则无需改。 |
| `webview/package.json` | 新增依赖 `"maxgraph": "^0.24.0"`；保留 `@comfyorg/litegraph`（workflowEditor 仍需）。 |
| `webview/package-lock.json` | 执行 `npm install` 后自动更新（或 `npm i maxgraph`）。 |

### 2.3 收敛 / 待定文件（不在本次 POC 强制范围，但需记录）

| 文件 | 处置建议 |
|---|---|
| `browser/canvasEditor/*`（7 文件） | 并行方案。本 POC 落地后，若 `maxGraphRenderer` 满足需求，**废弃 `canvasEditorPane`**，并从 `agentStudio.contribution.ts` 移除引用。 |
| `common/mindmap/*`（10 文件） | **保留并提为主引擎**。POC 中 `maxGraphRenderer` 直接消费其 `layoutEngine` 与 `treeModel`。 |
| `test/common/mindmap.test.ts` | 保留，作为布局引擎回归基线。 |

---

## 3. POC 实施步骤

1. **依赖与脚手架**
   - `cd webview && npm i maxgraph@^0.24.0`
   - 新建 `maxGraphRenderer.ts` + `.types.ts`，封装 `new Graph(container)` 与 `insertVertex/insertEdge`。

2. **布局对接**
   - `maxGraphRenderer.render(treeModel)`：先调用 `layoutEngine.compute(treeModel)` 获得 `{id → {x,y,w,h}}`，再批量 `graph.batchUpdate(() => { vertices/edges })`.

3. **替换挂载点**
   - `MindMapPanel.tsx` 用 `<div ref={hostRef}/>` 替代 `<LiteGraphCanvas mode="mindmap"/>`；`useEffect` 内 `new MaxGraphRenderer(hostRef.current).render(model)`。

4. **交互迁移**
   - 节点点击/选中 → maxGraph `graph.addListener('click', …)`；键盘增删 → 复用 `common/mindmap/nodeOperations.ts` 改 `treeModel`，再 `renderer.rerender()`。
   - 平移/缩放交给 maxGraph 内置 `mxGraphHandler`/toolbar。

5. **序列化验证**
   - `drawioSerializer` 修复后，导出 `model → mxGraphModel`，与既有飞书导入用例对拍；新增 e2e 断言 XML 含 `<mxCell id=... vertex=1>` 与 `<mxCell edge=1 source=... target=...>`。

6. **双引擎收敛（POC 后）**
   - 验证 `maxGraphRenderer` 覆盖 `canvasEditor` 能力后，删除 `browser/canvasEditor/*` 与 contribution 引用。

---

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| maxGraph API 与 mxGraph 有细微差异（事件名/配置键） | POC 第 1 步先跑通最小 demo（单节点+连线），再扩展。 |
| maxGraph 无内置"思维导图"交互（折叠/键盘导航） | 交互逻辑沿用 `common/mindmap/nodeOperations.ts`，渲染层只负责呈现。 |
| `MindMapNodeData` 与 `IMindmapData` 双模型 | POC 中统一以 `common/mindmap/mindmapTypes.ts` 为准，`drawioSerializer` 加一层适配。 |
| bundle 体积增加（maxGraph ~数百 KB） | 仅脑图视图懒加载；workflowEditor 不受影响。 |

---

## 5. 验收标准

- [ ] `MindMapPanel` 不再 `import` 任何 `@comfyorg/litegraph`（除共享工具类型）。
- [ ] 脑图渲染由 maxGraph 完成，放射布局由 `common/mindmap/layoutEngine` 计算。
- [ ] `drawioSerializer` 导出可被 drawio/飞书正确解析（e2e 通过）。
- [ ] 新增 `maxGraphRenderer.test.ts` + `mindmap-maxgraph-e2e.mjs` 通过。
- [ ] 现有 `test/common/mindmap.test.ts` 不回归。
- [ ] 飞书导入链路（mxGraphModel → 内部模型）端到端可跑。
