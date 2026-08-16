# Agent 驱动画布 · 编排设计方案

> 目标：把「AgentLoop 会话编排」与「LiteGraph 工作流画布」从两套平行体系，收敛为 **Agent 即画布操作者** 的闭环：Agent 规划 → 画布可视化 → 执行 → 结果回传 → Agent 反思。
>
> 参考：TapCanvas（LangGraph + React Flow，LLM 侧 4 工具 + 前端 15 handler）、infinite-canvas（本地 MCP server，35 工具 + apply_ops 原子批 + SSE 双向闭环）。两者共同洞察：**agent 是画布的一等操作者，而非旁观者**。

---

## 1. 现状与差距

### 1.1 本项目已有能力

| 层 | 现状 |
|----|------|
| Agent 本体 | `agentLoopStrategy.ts` 五钩子 + 7 范式（react/plan-explore/budgeted-react/graph/delegation/readonly/mimo）；`interceptToolCall` 可拦截控制类工具；`prepareIteration` 可控制本轮工具面 |
| 任务编排 | `taskDag.ts` 纯函数：`topologicalSort`（分层 depth + priority）、`getReadyTasks`（maxConcurrency 就绪任务选择）；`taskDecomposer.ts` 拆解 |
| 画布执行 | `workflowRun.ts` `runGraphExecution`：`buildExecutionPlan`（`executionGraph.ts` Kahn 拓扑）→ **串行** for-of 执行 → `runNodeOrStage` 统一路由（llm→provider RPC / schema→ComfyTV / native→单节点 / instant / fx 链 / 8 内嵌编辑器） |
| 节点注册 | `registry.ts` `registerNodeSpec`（Map + version bump，支持 overwrite）；NodeKind = react/schema/native/llm；已有 Saros 13 编排节点 + 178 ComfyTV stage + ComfyUI 原生 + ProviderPicker |
| 媒体 | `MediaSnapshotStore`（内存快照，key=`nodeId:port:index`）+ `cardStateStore`（执行状态）；主进程 MediaService 资产库见《生成图片管理-设计方案.md》 |

### 1.2 关键差距

| # | 差距 | 影响 |
|---|------|------|
| 1 | **Agent 无法创建/连接/执行画布节点** | 用户在对话里说"生成一张赛博朋克图"，Agent 只能文字回答，无法把 `taskDag` 的编排结果落到画布并执行 |
| 2 | **画布状态不回传 Agent** | Agent 不知道哪步成功/失败/产出什么，无法自省修正，无法基于结果继续创作 |
| 3 | **全图串行执行** | 同层无依赖的 provider 节点（多路 ModelImageGen）只能逐个跑；ComfyTV 批量 stage 无并行收益 |
| 4 | **无跨会话任务追踪** | 生成即焚（刷新丢状态），无法查询"上次那张图"的进度/结果 |
| 5 | **Agent 操作不可撤销、无审批** | 覆盖节点/删图等高风险操作无确认机制 |
| 6 | **无节点插件生态** | 第三方无法以 URL 形式动态扩展画布能力（infinite-canvas 最大亮点） |
| 7 | **无 Subflow / 无引用语法 / 无自动布局** | 复杂流程不可复用、prompt 无法引用上游产物、Agent 建图后布局混乱 |

---

## 2. 总体设计

### 2.1 闭环架构

```
┌─ 用户 ──────────────────────────────────────────────┐
│  "生成一张赛博朋克夜景图，拆成 3 个风格变体"          │
└───────────────┬─────────────────────────────────────┘
                ▼
┌─ AgentLoop（会话编排）───────────────────────────────┐
│  plan-explore → taskDag 拆解 → 循环 ReAct            │
│  prepareIteration: 注入 canvas_* 工具面              │
│  interceptToolCall: 拦截 canvas_* → CanvasBridge     │
└───────────────┬─────────────────────────────────────┘
                ▼  tool_call (canvas_apply_ops / canvas_run_*)
┌─ CanvasBridge（主进程/浏览器桥）──────────────────────┐
│  applyOps: 写 workflow store（nodes/edges 原子批）    │
│  execute:  走 runGraphExecution / runNodeOrStage     │
│  undoStack: 每次 op 前快照受影响节点 → 单步撤销       │
│  confirmTools: 高风险 op → pendingApprovals          │
└───────────────┬─────────────────────────────────────┘
                ▼  画布 store 变更（React 驱动重渲染）
┌─ LiteGraphCanvas ────────────────────────────────────┐
│  节点/连线即时可视化；runState/快照经 cardStateStore  │
└───────────────┬─────────────────────────────────────┘
                ▼ 结果写 MediaSnapshotStore + cardState
┌─ 状态回传（UserMessageEnricher 新标签）──────────────┐
│  <canvas_context> 节点运行结果（成功/失败/快照引用）  │
│  注入下一轮 user 消息 → Agent 反思 → 继续闭环         │
└──────────────────────────────────────────────────────┘
```

### 2.2 设计原则

- **工具小而稳**：LLM 侧只暴露「意图级」工具（对齐 TapCanvas：模型不等待工具结果，用 label→id 解析），实现细节在 CanvasBridge。
- **复用纯函数**：拓扑/并发直接复用 `taskDag.ts`；注册复用 `registry.ts`；快照复用 `MediaSnapshotStore`。
- **可观测**：所有 canvas_* 工具调用进 agentloop 既有 tool-call 流式事件，用户可见。
- **不推翻现有**：`runGraphExecution` 保留串行语义（默认），并行作为显式选项/渐进增强。

---

## 3. P0 —— Agent → 画布操作工具集

### 3.1 工具清单（LLM 侧，7 个）

| 工具 | 参数 | 作用 | 对齐 |
|------|------|------|------|
| `canvas_create_node` | `type`、`title?`、`position?`、`data?` | 创建节点，自动命名 + 可选自动布局 | TapCanvas `createNode` / IC `canvas_apply_ops.add_node` |
| `canvas_connect_nodes` | `source`、`target`、`sourcePort?`、`targetPort?` | 按 label/id 连接（端口类型不匹配时返回错误提示候选） | `connectNodes` |
| `canvas_disconnect_nodes` | `source`、`target`、`port?` | 断开 | `disconnectNodes` |
| `canvas_update_node` | `node`、`patch` | 改参数（含 provider/model 路由字段） | `updateNode` |
| `canvas_delete_node` | `node` | 删节点（含下游连线，先确认） | `deleteNode` |
| `canvas_run_node` | `node`、`wait?` | 单节点执行（自动解析上游快照注入）；`wait=false` 返回 taskId | `runNode` + `generation_get_status` |
| `canvas_run_graph` | `mode?('serial'/'parallel')`、`concurrency?`、`onNode?` | 全图执行 | `runDag(concurrency)` |
| `canvas_apply_ops` | `ops[]`（add/update/delete_node、connect/disconnect、select、set_viewport） | **原子批**：多步画布变更一次提交、一次 undo | IC `canvas_apply_ops` |
| `canvas_get_state` | `scope?('all'/'selection')` | 画布快照回传（nodes/edges/运行状态） | IC `canvas_get_state` |

> 节点引用采用 TapCanvas 的 **label→nodeId 三级解析**（id → title/label → 大小写不敏感模糊匹配），模型不必记忆 UUID。

### 3.2 语义化生成流程（一句话 → 完整子图）

新增 `canvas_generate` 工具（对齐 IC `canvas_create_generation_flow`）：

```
入参：goal、provider?、model?、count?、variants?[prompt]
动作：
  1. 自动创建 Saros.Prompt（变体为多个）+ Saros.ModelImageGen + Saros.ProviderPicker（可选）
  2. 自动连线 Prompt → ModelImageGen，自动路由 provider（resolveImageGenDefaults）
  3. 可选 canvas_run_graph 直接执行
返回：新建节点 label 清单 + 执行结果/任务引用
```

**纯函数化**：`buildGenerateFlow(nodes, edges, goal, opts) → { nodes, edges, entryIds }`（DOM-free，可单测），画布只负责应用。

### 3.3 画布状态回传（新标签）

- 复用 `messageEnrichment/builtinTagProviders.ts` 模式，新增 `canvas_context` Provider：
  - 数据源：`MediaSnapshotStore`（节点产出快照引用）+ `cardStateStore`（runState/progress/error/durationMs）
  - 格式：`节点 label → [成功/失败] 类型/尺寸/耗时/快照引用`；失败含 errorMsg
  - 注入预算：≤30%（对齐 working memory 预算纪律），最近 N 个节点
- 触发时机：canvas_run_* 执行完成后、下一轮 LLM 调用前。

### 3.4 审批与撤销（对齐 IC confirmTools / undoAgentOps）

- `CanvasBridge.undoStack`：每次 op 提交前快照受影响节点 JSON（≤50 步），`canvas_undo` 工具（或 UI 撤销按钮）单步回滚。
- `confirmTools`：`canvas_delete_node`（含下游）、覆盖已有节点、`canvas_apply_ops` 中含 delete 时 → 转 `pendingApprovals`，下一轮以 user 消息呈现确认，Agent 再发 `canvas_confirm` 或中止。

---

## 4. P1 —— 执行模型增强

### 4.1 分层并行执行

- **纯函数**：`executionGraph.ts` 新增 `buildParallelExecutionPlan(nodes, edges, isExecutable)` → `{ layers: string[][], hasCycle }`，复用 Kahn 分层思路（对齐 `taskDag.topologicalSort` 的 depth 计算）。
- **调度**：`runGraphExecution` 新增 `mode:'parallel'`：
  - 每层内 `Promise.all` + 限流（复用 `getReadyTasks` 的 maxConcurrency 语义）
  - **层间屏障**：全部完成后进入下一层（保快照注入顺序）
- **关键工程决策——按节点类型分级并发**：

| 节点类型 | 并发策略 | 理由 |
|---------|---------|------|
| provider（llm）ModelImageGen | **真并行** | 走 BYOK HTTP RPC，无共享队列，天然并发安全 |
| browser-local（instant / 8 内嵌编辑器 / ProviderPicker / Loader） | 真并行 | 纯前端处理，快照 key 按 nodeId 隔离 |
| schema（ComfyTV stage） | **串行**（限流 1） | 后端 ComfyUI 队列本质串行，并发只会堆积 |
| native（ComfyUI 原生节点） | 串行 | 同上，依赖 runner 队列 |

  实现：`runNodeOrStage` 返回的 `backendKind`（已有 `BackendKind = 'comfy' | 'provider'`）驱动并发槽位分配——comfy 槽位=1，provider/browser 槽位=concurrency。

### 4.2 异步任务 + 跨会话状态查询

- `canvas_run_node(wait:false)` / `canvas_run_graph` 返回 **taskId**（= 执行 id，落 `MediaSnapshotStore` 记录）。
- 新增 `canvas_get_task_status(taskId)` → `{ state, progress, resultSnapshots[], error? }`。
- P1 落地 `MediaService` 后（见生成图片管理方案），taskId 记录持久化，**刷新/重开标签页仍可查**（对齐 IC `generation_get_status`）。
- 纯函数：`buildTaskStatus(store, taskId)` 可单测。

### 4.3 执行结果结构升级

- `GraphRunResult` 增加 `taskId`、`layerStats: { total, ran, failed }`，供 canvas_context 回传与画廊归属（workflow_id 关联）。

---

## 5. P2 —— 节点生态

### 5.1 URL 动态插件节点（对齐 IC CanvasPlugin）

> **✅ 已落地（2026-08-11）**：`comfyHost/pluginLoader.ts`（纯逻辑层）+ `runNodeOrStage` 插件 onRun 钩子。
>
> 与原文的差异：
> - 插件定义走 **`defineNode`**（非直接 registerNodeSpec）：`PluginModule = { register(api) }`，`api = { defineNode(def), getNodeSpec }`
> - **运行时钩子** `def.onRun(ctx)` 存 `pluginLoader` 模块级 `nodeRunners` Map（onRun 是函数不能进 registry JSON），执行时 `getPluginNodeRunner(type)` 查询；unload/回滚清理
> - 表单字段：`fields` → native `widgets`（number/toggle/combo/text 映射）
> - `loadPlugin` 原子（任一失败回滚已注册节点）；`unloadPlugin` prune；同 pluginId 重载替换；`validatePluginManifest`（pluginId 正则 + scriptURL 仅 http(s)）
> - **未做**：插件设置页 UI（URL 白名单）、插件 storage 的持久化后端（当前 localStorage 按 `plugin:<type>:<k>`）

### 5.2 Subflow 组合节点（对齐 TapCanvas subflow）

> **✅ 已落地（2026-08-11）**：`comfyHost/subflow.ts` + `runGraphExecution` 展平。
>
> 与原文的差异：
> - **执行模型改为"展平"而非"递归"**：`flattenSubflows(nodes, edges)` 在执行/导出前把 `data.subflow` 节点展开为内部子图（`substituteSubflow` 前缀防冲突、跨界边重映射），`runGraphExecution` 开头统一展平——零运行时递归复杂度
> - 端口派生：`getSubflowPorts`——entry 节点 outputs[0]→输入端口、exit 节点 inputs[0]→输出端口（未解析回退 'ANY'）
> - **未做**：`Saros.Subflow` 节点类型注册（UI 封装入口：选中子图右键"封装为 Subflow"）、双击嵌套画布编辑

### 5.3 Prompt 引用语法 `@[node:xxx]`（对齐 IC composer）

> **✅ 已落地（2026-08-11）**：`comfyHost/nodeMentions.ts` + `runProviderImage` 接入。

- 纯函数 `resolveNodeMentions(text, nodes, store) → { text, injected: string[], images: string[] }`：
  - `@[node:promptLabel]` → 注入上游 `TEXT` 快照
  - `@[node:imageLabel]` → 注入上游 `IMAGE` 快照（i2i/参考图）
- 接入点：`runNodeOrStage` 的 llm 节点值预处理 + `canvas_generate` 的 prompt 组装（替换现有 fx packed 的特例）。
- 差异：imageInput 优先级改为「显式值 → mention 图 → 上游 IMAGE 快照」；`NodeExecutionInput.nodes` 用于 label 解析

### 5.4 反推提示词

> **✅ 已落地（2026-08-11）**：完整工具链（`canvas_reverse_prompt` 工具 + `reversePrompt.generate` RPC + `runReversePrompt` 编排）。

- `Saros.ReversePrompt` 节点 或 ModelImageGen 右键菜单"反推提示词"：
  - 上游 IMAGE 快照 → provider LLM（text RPC）→ 写回本节点/下游 Prompt 节点。
  - 纯函数：`buildReversePromptRequest(imageRef, provider) → { prompt, model }`。
- 差异：UI 走 **Agent 工具 `canvas_reverse_prompt`**（非右键菜单）；RPC 为新增 `reversePrompt.generate`（`_resolveImageData` dataURL/HTTP→base64 + `provider.chat` 流式收集）；`runReversePrompt` 编排纯逻辑（目标解析→快照→路由→RPC→写回，单步 undo）

### 5.5 自动布局 + 自动命名

- `computeDagLayout(nodes, edges) → Map<id,{x,y}>`：Kahn 分层 + 层高间距（纯函数，复用 depth 计算）。
- `nextAutoName(kind, existing) → '图像-1' | '视频-2'`：按 kind 计数（纯函数）。
- 触发：`canvas_apply_ops` 提交后可选 `layout:true`；手动创建节点时自动命名。

---

## 6. 分阶段实施与验收

### P0（Agent 闭环）✅ 已落地（2026-08-11）
- [x] `CanvasBridge`（applyOps/undoStack）— `canvasOpsBridge.ts` + `applyCanvasOpsToStore`（原子批+单步撤销）
- [x] 7 个 canvas_* 工具：`canvas_apply_ops` / `canvas_generate`(run/layout 真执行) / `canvas_get_state` / `canvas_get_task_status` / `canvas_undo` / `canvas_redo` / `canvas_reverse_prompt`
- [x] `canvas_generate` 语义化流程 + `buildGenerateFlow`（多变体+自动连线+provider 路由+chainAfterId）
- [x] `<canvas_context>` 标签（CanvasContextTagProvider + canvasContextStore，含 edges/状态/操作摘要）
- 差异：confirmTools（审批）未做——delete 走原子回滚兜底，无二次确认
- 验收：✅ 对话说"生成赛博朋克图 + 2 个变体" → 画布自动建图 → 执行 → `<canvas_context>` 注入结果回传 Agent

### P1（并行 + 异步）✅ 已落地（2026-08-11）
- [x] `buildParallelExecutionPlan` + `runGraphExecution(mode:'parallel')` 分级并发（comfy 槽位=1、provider 池并行、层间屏障）
- [x] taskId + `GraphRunResult.taskId`/`layerStats`；`canvas_get_task_status` 从 canvasContextStore 读当前状态
- [ ] 持久化 taskId（接 MediaService）— 未做（taskId 内存态，刷新即失）
- 差异：分层并发经 UI「并行」复选框接入 handleExecute
- 验收：✅ 3 路 ModelImageGen 并行（测试实测 maxConcurrent=2 真并发）；刷新后可查状态未落地

### P2（生态）✅ 已全部落地（2026-08-11）
- [x] 插件 SDK + `loadPlugin`/`unloadPlugin`/onRun 运行时钩子（pluginLoader.ts）
- [x] **插件管理面板 UI**（PluginManagerPanel：URL 安装/卸载/localStorage 持久化/重启重载）
- [x] Subflow 纯逻辑 + 展平执行（subflow.ts + runGraphExecution 展平）
- [x] **Subflow 封装入口 UI**（工具栏「封装 Subflow」：选中节点→组合定义→替换节点，单步 undo）
- [x] `resolveNodeMentions`（已接入 runProviderImage）+ `buildReversePromptRequest`（纯函数）
- [x] **反推提示词完整链路**（canvas_reverse_prompt 工具 + reversePrompt.generate RPC + runReversePrompt 编排）
- [x] `computeDagLayout`（UI 按钮 + canvas_generate layout:true）+ `nextAutoName`
- 差异：无 URL 白名单（插件面板直接安装）；反推走 Agent 工具而非右键菜单
- 验收：✅ URL 插件即插即用（含运行时钩子）；子图可封装+展平执行；prompt 可引用上游产物；反推可一键写回 prompt

---

## 7. 配套测试计划

> 原则：所有新逻辑纯函数化（DOM-free），对齐 `executionGraph.ts`/`taskDag.ts`/`imageGenBackend.ts` 既有测试模式；测试文件放 `webview/src/features/workflowEditor/__tests__/`（browser test，`run-*-tests.mjs` 注册）。

| 功能 | 测试文件 | 关键用例 |
|------|---------|---------|
| `buildGenerateFlow` | `workflowGenerateFlow.test.ts` | 单变体/多变体建图；无 provider 时走 auto-route；端口连线正确；返回 entryIds；纯 provider 图无 runner 依赖 |
| `canvas_apply_ops` 应用器 | `canvasOps.test.ts` | 原子批含 add/connect/update/delete 混合；**任一步失败整批回滚**（快照恢复）；节点引用 label→id 三级解析；端口类型不匹配返回候选提示 |
| `resolveNodeMentions` | `nodeMentions.test.ts` | `@[node:label]` 文本/图像注入；未命中引用保持原样；多层嵌套引用解析顺序 |
| `buildParallelExecutionPlan` | `executionParallel.test.ts` | 分层正确（同层无依赖）；环检测；非可执行节点跳过；**层内乱序不影响快照注入** |
| 分级并发调度 | `graphParallelRun.test.ts` | comfy 槽位=1 而 provider 并行；限流；单节点失败时同层取消/记录、**层间屏障**；abort 传播 |
| `buildTaskStatus` | `taskStatus.test.ts` | running/success/error 状态；resultSnapshots 归属；未知 taskId |
| `buildReversePromptRequest` | `reversePrompt.test.ts` | 参数组装；provider 缺失回退 |
| `computeDagLayout` | `dagLayout.test.ts` | 分层 x/y；环图不挂死；孤立节点落位 |
| `nextAutoName` | `autoName.test.ts` | kind 计数递增；删除后复用计数不回落（对齐 TapCanvas） |
| `canvas_context` 标签组装 | `canvasContextTag.test.ts` | 成功/失败/截断格式；≤30% 预算；节点 label 优先 |
| 插件 SDK | `pluginLoader.test.ts` | 动态加载注册；命名空间冲突拒绝；卸载后 prune；manifest 校验失败 |

> **现有可先落地的补测**（不依赖新功能）：
> - `executionGraph.test.ts` 补：多入口、链式、菱形 DAG 的 `collectUpstreamNodeIds` 顺序稳定性。
> - `workflowRun.test.ts` 补：`runGraphExecution` 失败即停的卡状态断言（error banner 用）。
> - 上轮修复的 llm 卡片跳过属 React 组件行为，建议以 e2e（`webview/e2e/`）覆盖「llm 节点无 DOM 卡片且 canvas 参数区可见」。

---

## 8. 关键决策与风险

| 决策点 | 选择 | 理由 |
|--------|------|------|
| LLM 侧工具粒度 | **意图级（9 个），细节下沉 CanvasBridge** | 对齐 TapCanvas「模型不等待工具结果」；减少 token 与幻觉 |
| 并行粒度 | **层间屏障 + comfy 槽位=1** | 快照注入顺序受保护；ComfyUI 队列串行本质不伪造并发 |
| 工具注入 | `prepareIteration` 控制工具面，`interceptToolCall` 消费 | 复用既有策略钩子，范式无感知 |
| 状态回传 | UserMessageEnricher 新标签 | 复用既有消息富化管道，≤30% 预算 |
| 插件类型命名 | `<pluginId>:<name>` | 防止与 Saros/ComfyTV 冲突；卸载 prune 简单 |

**风险**：
- **模型幻觉 label** → 三级解析 + 失败候选提示（纯函数可测）。
- **并行执行副作用** → 快照 key 按 nodeId 隔离（天然并发安全）；runner 队列不并发。
- **插件安全** → webview 沙箱 + URL 白名单。
- **Subflow 递归深度** → 嵌套上限（如 5 层）防栈溢出。
