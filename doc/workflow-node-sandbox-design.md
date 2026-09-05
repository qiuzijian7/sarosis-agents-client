# 工作流节点「最小真实测试环境」设计方案

> 目标：一个**仅有工作流相关代码**的最小运行时，既能**真实渲染节点 UI**，又能**真实执行节点功能**，且两者闭环（执行结果驱动 UI 更新）。

---

## 一、调研结论：现状是「两套设施，互不打通」

| 设施 | 环境 | 能做什么 | 盲区 |
|---|---|---|---|
| `test/browser/workflow*.test.ts`（**62 个**）<br>+ `run-browser-test.mjs` | Node + esbuild bundle + mocha | 执行节点逻辑、数据契约、纯函数。<br>已有 `fakeRunner` 先例（`workflowComfyNodeExecutor.test.ts:16`） | **无 DOM → 不能渲染 UI** |
| `webview/visual/`<br>（harness + Playwright + 基线） | 浏览器 | 真实渲染 **195 节点 × 4 状态 = 780 场景**，16 条契约断言（R1–R16）+ 像素 diff | **不执行节点**——状态用 `?state=success` **模拟** |

**核心割裂**：Node 侧无 DOM 渲染不了；浏览器侧不调执行器，状态是假的。

一句话：**「渲染」与「执行」被环境劈成两半，而两者其实共享同一个 `__vssarosBridge` mock 契约。**

---

## 二、可行性基础：关键接口已全部就位

| 接口 | 位置 | 作用 |
|---|---|---|
| `createNodeCard(container, meta, opts)` | `nodeCard.tsx:3920` | 渲染卡片，返回 `unmount`；`opts` 注入 `snapshotStore / cardStateStore / nodeId / upstreamNodeIds` |
| `getNodeCardMeta(spec, properties)` | `nodeCard.tsx` | 生成卡片渲染输入（已过滤 hidden fields） |
| `CardStateStore.set(nodeId, state)` | `cardState.ts:41` | 更新 `runState` → `notify()` → **React 自动重渲染** |
| `MediaSnapshotStore(createMemoryBackend())` | `mediaSnapshotStore.ts` | 确定性快照存储（无磁盘、无 IPC） |
| `runNodeOrStage(input)` | `workflowRun.ts:4161` | **统一执行入口**，内部按类型分派到 20+ 个执行器 |
| `IComfyRunner` | `comfyRunner.ts` | 后端接口——测试里已有 `fakeRunner` 实现先例 |
| `installBridgeMock()` / `installNetworkGuard()` | `visual/mocks.ts` | bridge + 网络 mock（**已有**） |

**★ 决定性洞察**：现有 `harness.tsx:mountScenario`（247 行）**已经在做**「`new MediaSnapshotStore(memoryBackend)` + `new CardStateStore()` + `createNodeCard(...)`」，只是 `success` 态的输出图是**手工 `store.put` 塞进去的假图**。

> 把「手工塞假图」换成「真跑 `runNodeOrStage`，让执行器自己 `store.put`」——执行闭环就此成立，**无需新建设施，只需加一层执行**。

---

## 三、方案：抽出环境无关的 `runtime.ts`，在现有 harness 上加执行层

### 3.1 架构

```
visual/runtime.ts  ★新增（环境无关，~200 行）
├─ createSandbox(opts)
│    ① installBridgeMock() + installNetworkGuard()        ← mock 必须先行
│    ② await import(registry / nodeCard / workflowRun / stores)  ← 动态导入
│    ③ registerSarosNodes() + registerDefaultComfyTVStages()
│    ④ seedOrchestrationStores()   ← DEMO_AGENTS/SKILLS/TOOLS/PROVIDERS
│    ⑤ new MediaSnapshotStore(createMemoryBackend()) + new CardStateStore()
│    ⑥ createFakeRunner(outputs)   ← IComfyRunner mock
├─ sandbox.mount(host, type, opts)          → { unmount, meta }
├─ sandbox.run(type, values, opts)          → SingleNodeRunResult（写回 store + cardState）
└─ sandbox.mountAndRun(host, type, values)  → 渲染 + 执行 + UI 自动更新

两种宿主（同一份 runtime，只换宿主）：
  浏览器 → visual/harness.tsx   ：真实 DOM + 布局 + 截图（?run=1）
  Node   → run-browser-test.mjs ：只 run（无 DOM），秒级回归
```

### 3.2 执行 → UI 闭环（4 步）

```
1. mount  createNodeCard(host, meta, { snapshotStore, cardStateStore, nodeId, upstreamNodeIds })
2.        cardStateStore.set(nodeId, { runState: 'running', progress: 0 })
3. run    runNodeOrStage({ runner: fakeRunner, nodeId, type, getSpec, values,
                           store: snapshotStore, upstreams })
          └─ 执行器内部 store.put(...) 写快照
4.        cardStateStore.set(nodeId, { runState: result.status, errorMsg: result.error })
          └─ notify → React 重渲染 → success 显示 OUTPUT / error 显示 ErrorBanner
```

### 3.3 「最小」的边界

**包含**：`registry` / `nodeCard` / `workflowRun` / `stageCardRegistry` / `cardState` / `mediaSnapshot*` / 三个 orchestration store / 各专用编辑器组件。

**排除**（全部 mock 掉）：
- VsSaros 主进程 IPC → `__vssarosBridge` mock
- ComfyUI 后端 → `fakeRunner`
- 真实网络 → `installNetworkGuard()`（拦截一切，返回确定性假图）
- LiteGraph 画布 → **不需要**：节点卡片是纯 React DOM（`nodeCard.tsx` 91 处 inline style），画布只负责定位/端口

### 3.4 文件清单

| 文件 | 动作 | 行数 | 内容 |
|---|---|---|---|
| `visual/runtime.ts` | 新增 | ~200 | 最小运行时内核（createSandbox / mount / run / mountAndRun） |
| `visual/mocks.ts` | 扩展 | ~30 | + `createFakeRunner(outputs)`（确定性 outputs，对齐 `IComfyRunner`） |
| `visual/harness.tsx` | 扩展 | ~60 | `?run=1` 执行模式：卡片「生成」按钮真跑；`?only=&run=1` 单节点聚焦 |
| `visual/visual.spec.mjs` | 扩展 | — | 执行断言（复用现有 Playwright runner + 报告） |
| `test/browser/workflowSandbox.test.ts` | 新增 | — | Node 侧执行回归（复用 `run-browser-test.mjs`，秒级） |

---

## 四、分阶段实施

| 阶段 | 交付 | 验收 |
|---|---|---|
| **P0 骨架** | `runtime.ts` + `createFakeRunner` | Node 侧 `sandbox.run('ComfyTV.ImageStage', {...})` 返回 success 且 store 有快照 |
| **P1 渲染闭环** | harness `?run=1` | 浏览器打开单节点，点「生成」→ 真跑 → 卡片切 success 并显示 OUTPUT |
| **P2 断言** | Playwright 执行断言 + Node mocha 回归 | 执行结果（status/entries/error）与 UI 状态（OUTPUT/ErrorBanner）双向断言 |
| **P3 场景矩阵** | 780 UI 场景 → 扩为「渲染 + 执行」双模 | 全量跑通，抓出「模拟状态掩盖的真 bug」 |

---

## 五、价值：模拟状态掩盖了什么

现有 780 场景的 `success` 态是**手工塞假图**，以下类别**永远测不到**：

1. **执行器返回值与 UI 契约不符**——如 `runStoryboardEditorNode` 三端口（image/images/video）与卡片 OUTPUT 区渲染不匹配
2. **空结果/边界**——执行返回 `entries=[]` 时 UI 是否塌陷（手工塞图时永远有图）
3. **错误态文案**——`error` 态显示的是执行器真实 `error` 字段，模拟时用的是固定文案
4. **picker / loader 的本地解析**——这类节点**不调后端**（`runNodeOrStage` 本地分支），模拟状态完全跳过
5. **执行写回键与读侧不一致**——`snapshotKey`(stageUid) vs `nodeId`，历史踩过（写 nodeId、读 stageUid → OUTPUT 不刷新）

---

## 六、风险与权衡

| 风险 | 缓解 |
|---|---|
| import `workflowRun.ts`（194KB）撑大 harness bundle | 可接受（harness 已 2.5MB）；或动态 import 懒加载，仅 `?run=1` 时加载 |
| 部分节点执行需真实后端（ComfyUI / LLM RPC） | `fakeRunner` 返回确定性 outputs；需真实后端的节点在 fixtures 里标注 `needsBackend` → skip 并在报告里 note |
| Three.js / WebGL 节点在无 GPU 环境塌陷 | **沿用现有 WebGL 探测豁免**（visual/README.md 已记录，避免 12 条假 FAIL） |
| 浏览器执行 vs Node 执行结果不一致 | 同一份 `runtime.ts`，宿主不同；差异只可能来自 DOM/canvas——Node 侧本就不测这些 |
| 副作用：执行会触发真实网络 | `installNetworkGuard()` 已拦截一切非 `data:`/`blob:` 请求 |

---

## 七、备选方案对照

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **A. 扩展现有 visual harness（本方案）** | 复用 780 场景 + Playwright + baseline + 16 条断言；真实浏览器布局（抓 bug 的主力） | 依赖 Playwright（重）；bundle 变大 | **推荐** |
| B. Node 侧加 happy-dom 渲染 | 一条命令跑完，无浏览器依赖，快 | happy-dom/jsdom **布局能力弱**（测不了溢出/高度——而这恰恰是历史上 6 个 bug 里 3 个的类型）；需新增依赖 | 不推荐（丢了最值钱的真实布局） |
| C. 另起一套独立沙箱 | 干净 | 重复建设 bridge mock / registry 注册 / store seeding，与 visual 双份维护 | 不推荐 |

**结论：A 可行且成本最低**——关键基础设施（bridge mock、registry 注册、store seeding、卡片渲染、Playwright runner、断言规则）**全部现成**，新增量只有「把模拟状态换成真跑」这一层（约 290 行）。
