# 工作流「手拖节点」沙箱设计方案

> 目标：一个**独立浏览器页面**，打开就是真实工作流画布，能像在 app 里一样**新建节点、拖拽、拉连线、点运行**，
> 用于开发新节点时验证 UI / 功能 / 输入输出 / **上下游联动**；结果可被 LLM 自动判定并驱动回改。

---

## 一、可行性结论：能挂，且成本可控

`LiteGraphCanvas`（`[WEB]/src/features/workflowEditor/LiteGraphCanvas.tsx:472`，`forwardRef`）**全部 props 可选**：

- 不读 VS Code 主题 token（画布颜色硬编码 `#1e1e1e`，`:740`）
- 不读 i18n、不使用 React context
- 不直接调 `acquireVsCodeApi()`（`messageClient.ts:235` 已对无 `window` 环境做 stub 降级）
- 只用浏览器原生：`ResizeObserver` / canvas 2d / pointer 事件 / `getBoundingClientRect` / IndexedDB
- **无 WebGL**（3D 只在 StageCard 内嵌编辑器用，且有兜底降级）

**唯一的硬依赖**是 `globalThis.__vssarosBridge`，且是**模块求值期**依赖：

```ts
// comfyHost/nodeExecutor.ts:24-26
const _bridge = globalThis.__vssarosBridge ?? (() => { throw new Error('vssarosBridge not initialised'); })();
```

传导链：`LiteGraphCanvas.tsx:32` → `workflowRun.ts:18` → `nodeExecutor.ts:24`（`nodeCard.tsx:45` 同款）。
→ **沿用现有 harness 的「先 mock、后 `await import()`」模式即可**（`harness.tsx:18-19`）。

---

## 二、架构

```
visual/canvas/                      ★ 新增
├─ canvasSandbox.ts   挂载画布的最小运行时（bridge 先行 → 注册 → seeding → render）
├─ CanvasHost.tsx     React 根：<LiteGraphCanvas workflowId="…" onNodeRun={…} />
└─ seeding.ts         预置图（声明式 nodes/edges 或导入 toWorkflowData()）
```

复用既有设施（**零新建**）：`bridgeStub.mjs` / `registry` / `workflowRun` / `store.ts` / `CardStateStore` / `MediaSnapshotStore` / `ComfyGraphAdapter`。

### 真相来源：zustand store（`store.ts`）

| 操作 | 方法 | 行 |
|---|---|---|
| 新建节点 | `addNode(type, {x,y}) → id` | `:300` |
| 删除节点 | `removeNode(id)`（连带删边；start/end 拒绝） | `:334` |
| 删除边 | `deleteEdge(id)` | `:364` |
| 新增边 | **没有 `addEdge`**，只能 `setEdges(整份)` | `:292` |
| 序列化 | `toWorkflowData() → {nodes, connections}` | `:599` |

> ⚠ **缺口**：store 缺 `addEdge`。手拖连线走 LiteGraph 原生回写，不受影响；
> 但「测试声明图」时不方便 —— 沙箱层补一个 `addEdge(from, to, port)` 薄封装（内部 `setEdges`）。

### 连线的两条路径（方向相反，必须都知道）

| 场景 | 方向 | 链路 |
|---|---|---|
| **拖到已有端口** | 画布先改 → 回写 store | LiteGraph `linkConnector` 建 link → `graph.on_change`(`:1150`) → `setTimeout(0)` → `syncGraphToStore`(`:2772`) |
| **拖到空白松手** | store 先改 → 同步画布 | `lcEvents 'dropped-on-canvas'`(`:1142`) → `ConnectionDropMenu` → `handleConnDropSelect`(`:2414`) → `addNode`+`setEdges` → `syncStoreToGraph`(`:2693`) → `graph.configure()` |

**节点拖拽**：`dragPointerMove`(`:921`) 只改 `dragRef.node.pos`，松手 `dragPointerUp`(`:943`) 才回写一次；拖拽期间 `on_change` 被 `if (dragRef) return;`(`:1156`) 短路。

---

## 三、三个坑与应对

### 坑 1：`__vssarosBridge` 是求值期 throw
一旦静态 import 顺序错，bundle 在 import 阶段就挂。
**应对**：沿用 harness 模式 —— `bridgeStub` 先行，再 `await import()` 画布模块。**不新增任何静态 import**。

### 坑 2：`syncStoreToGraph` 是全量 `configure()` 重建 → 回环风暴
`store.ts:2746` 每次全量重建（节点对象整个换新），靠 `dragRef` 短路(`:1156`) 和 `suppressStoreSync`(`:2137`) 防回环。
若沙箱自己持续写 store，会触发「configure → on_change → setNodes → 再 configure」风暴，并丢 `lc.selected_nodes`、把卡片高度重置（#59 抖动，`:2729-2761`）。
**应对**：
- seeding **只做一次**（初始化时 `setNodes`+`setEdges`），之后**绝不**由沙箱侧写 store
- 一切变更来自**用户交互**（真实拖拽）或**显式一次性 API** —— 与真实 app 的行为一致，也就不会触发风暴
- 断言只读 store，不写

### 坑 3：尺寸与时序
- 容器 `clientHeight=0` → `applyCanvasSize` **静默跳过 resize**(`:714-717`)，画布不渲染
- `zoomToFit` 必须 double-rAF(`:1170-1172`)
- `syncOverlay`(`:1224`) 是每帧 rAF，靠 `node.renderArea/_posSize` 对齐 DOM 卡片 —— 无真实布局会整片漂移

**应对**：`html,body,#root{height:100%}` + 有确定高度的 `#canvas-root`；沿用 `index.html:8-17` 的 `--vscode-*` 变量。

---

## 四、★ 核心设计：手拖一次 → 录制 → 自动回归

这是本方案相对「纯声明式测试」的**增量价值**所在：

```
① 人在浏览器里手拖出一张图（真实交互，所见即所得）
        ↓  点「导出」
② toWorkflowData() → 存成 fixture（graph/*.json）
        ↓
③ Node 侧 sandbox.runGraph(fixture) 复现同样的数据流（秒级，无浏览器）
        ↓
④ 每次改节点代码 → ③ 自动回归（CI/本地都能跑）
```

| 层 | 用途 | 谁用 |
|---|---|---|
| **画布（浏览器）** | 探索性验证：拖节点、看 UI、拉连线、点运行 | 人 |
| **Playwright 驱动画布** | 自动化 UI 断言（截图 + console/pageerror + store 快照） | 人 / LLM |
| **runGraph（Node）** | 秒级回归（同一份 fixture，同一份执行链路） | CI / LLM |

→ 「交互」与「自动测试」共用一张图，**不重复建设**。

---

## 五、LLM 可消费的报告

`visual/canvas/report.json`：

```json
{
  "generatedAt": "…",
  "graph": { "nodes": [{ "id": "a", "type": "Saros.Prompt", "pos": [120, 80] }], "edges": [{ "from": "a", "to": "b", "fromPort": "output" }] },
  "interaction": { "created": ["a", "b"], "connected": 1, "dragged": true },
  "run": {
    "ok": false,
    "order": ["a", "b"],
    "nodes": [{ "id": "a", "type": "…", "status": "error", "error": "请先在节点弹窗中摆灯",
                "upstreams": [], "durationMs": 12 }]
  },
  "ui": {
    "consoleErrors": [], "pageErrors": [],
    "screenshot": "canvas/actual/xxx.png",
    "cardStates": { "a": "error", "b": "skipped" }
  }
}
```

判定链：**`run.ok === false` 或 `ui.pageErrors.length > 0` → 有错 → 回改 → 重跑**。

---

## 六、文件清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `visual/canvas/canvasSandbox.ts` | 新增 | bridge 先行 → 注册 → 一次性 seeding → render |
| `visual/canvas/CanvasHost.tsx` | 新增 | React 根 + 工具栏（新建/导出/运行/清空） |
| `visual/canvas/seeding.ts` | 新增 | 声明式图 → store；补 `addEdge` 薄封装 |
| `visual/build.mjs` | 扩展 | 新增 canvas 入口（IIFE） |
| `visual/canvas.spec.mjs` | 新增 | Playwright：真实拖拽 + 连线 + 运行 + 报告 |
| `test/browser/workflowSandbox.test.ts` | 扩展 | fixture 回放（`runGraph`） |

---

## 七、分阶段

| 阶段 | 交付 | 验收 |
|---|---|---|
| **P0 挂起来** | 空白画布能渲染，能拖节点、拉连线 | 浏览器打开，手拖一条 A→B 连线，store 里出现该 edge |
| **P1 能跑** | 点「运行」真跑，卡片切 success / ErrorBanner | 与 `runGraph` 结果一致 |
| **P2 能导出** | 「导出」存 fixture；Node 侧 `runGraph` 回放 | 同一 fixture，浏览器与 Node 结果**一致** |
| **P3 LLM 闭环** | Playwright 自动跑 + `report.json` | LLM 读报告判定，错则回改重跑 |

---

## 八、风险

| 风险 | 缓解 |
|---|---|
| 回环风暴（持续写 store） | seeding 一次性；断言只读不写 |
| 容器高度 0 → 静默不渲染 | 显式 `height:100%` + 启动后断言 `clientHeight>0` |
| `zoomToFit` 时序 | double-rAF（沿用 `:1170`） |
| bundle 变大（画布 194KB+） | 可接受；或按需动态 import |
| 浏览器与 Node 结果不一致 | 同一份 `runtime.ts`/同一份执行链路；差异只可能来自 DOM，Node 侧本就不测这些 |
| 需真实后端的节点 | `fakeRunner` 返回确定性 outputs；需后端的在 fixture 标注 `needsBackend` → skip |

---

## 九、与既有设施的关系

```
                   ┌──────────────────────────────────────┐
   手拖（人）  →   │  visual/canvas/  真实画布（浏览器）   │ →  导出 fixture
                   └──────────────────────────────────────┘          ↓
                                      ↓ 同一份                        ↓
                   ┌──────────────────────────────────────┐   ┌──────────────┐
   回归（CI） →   │  visual/runtime.ts  宿主无关内核       │ ← │  runGraph    │
                   └──────────────────────────────────────┘   └──────────────┘
                                      ↓
                   ┌──────────────────────────────────────┐
   单卡片渲染  →   │  visual/harness.tsx  780 场景画廊     │
                   └──────────────────────────────────────┘
```

**不重复建设**：画布沙箱只加「交互层」，执行、注册、mock、store 全部复用既有。
