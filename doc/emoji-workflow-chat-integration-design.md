# 聊天框表情包工作流 集成设计（start → prompt → 表情包节点 → end）

> 需求：聊天框选择「表情包工作流」（start/prompt/表情包节点/end），输入参考图，
> 生成 m×n 个动态表情，聊天 UI 显示执行进度与输出表情包。
>
> 本文基于 2026-08-23 源码核对的现状，给出两执行域架构、接线缺口与推荐方案。

---

## 1. 现状：两套「工作流」执行域（割裂的根源）

| 维度 | 域 A：存储工作流 DAG | 域 B：画布（webview LiteGraph） |
|---|---|---|
| 类型定义 | `common/workflowStorage.ts` `WorkflowNodeType`（start/end/task/prompt/agent/…/comfy/comfyStage） | `registry.ts` 注册的 `ComfyTV.*` / `Saros.*` 节点 |
| 执行器 | `browser/workflowExecutionService.ts` `executeWorkflow()` | `webview/.../comfyHost/workflowRun.ts` `runNodeOrStage()` |
| 表情包实现 | 无（`ComfyStage` 只是占位类型） | `runEmojiStageGrid()`（m×n 网格，真跑 ComfyUI） |
| 表情包模板 | 无 | `emojiWorkflows.ts`（Qwen/透明/动态/fallback） |
| 媒体归档 | `nodeState.output`（纯文本 summary） | `mediaSnapshotStore.ts`（image/video/audio 快照） |
| 触发入口 | 聊天 `/workflow <id>` → `agentDriverService._executeWorkflowTurn` → `executeWorkflow` | 画布 Run 按钮 / 动态 `workflow` 工具的 `stage()` 桥 |

**结论**：表情包的 m×n 生成能力只在**域 B**；聊天触发的却是**域 A**。两者之间目前只有一条
已建好的桥（见 §2），且该桥只接在动态 `workflow` 工具上、没接到存储工作流执行器。

---

## 2. 已建好的桥：`stage()` / `nodeOutput()`（P0 画布桥，可复用）

这条桥**已经完整可用**，是本次集成的关键复用点：

```
browser/workflow/workflowSnapshotBridge.ts
  requestStageRun({stageUid, overrides}, timeout, onProgress)
    → stageRunEmitter.fire()
    → agentStudioWebviewController 订阅 → _sendEvent('workflow.stageRun')
    → webview workflowSnapshotBridgeWebview.handleStageRunEvent()
    → StageRunner(stageUid, overrides, onProgress)   // 由 WorkflowEditorPanel 注册
    → runSingleSchemaNode → runNodeOrStage → runEmojiStageGrid / runStageWorkflow
    → 进度: sendRequest('workflow.stageRunProgress') → onStageRunProgress → onProgress
    → 结果: sendRequest('workflow.stageRunResult')   → resolveStageRun → 物化输出
```

**当前唯一消费方**：`WorkflowEngine`（`browser/workflow/workflowEngine.ts` 的 `_stagePort`），
即动态 `workflow` 工具的 `stage(stageUid, overrides)` hook。

**关键限制**：`stage()` 桥按 **`stageUid`**（画布节点 `properties.__sarosStageUid`）定位节点，
而存储工作流 DAG 的 `ComfyStage` 节点**没有** stageUid（它只有 `data.comfy = { mode, stageClass, workflowId }`）。

---

## 3. 三个接线缺口（逐条对应需求）

### 缺口 1：存储工作流的 ComfyStage 节点从不真正执行

- `workflowExecutionService._executeComfyNode()` 调 `this._comfyDelegate.execute(node, input, ctx)`；
  `_comfyDelegate` 由 `setComfyExecutionDelegate()` 注入，但**生产零调用点**（只在单测设过）。
  结果：`/workflow <id>` 跑一个含表情包节点的存储工作流时，该节点被 `warn` 后**静默跳过**。
- 即便注入，`stage()` 桥按 stageUid 定位，而存储工作流节点无 stageUid → 需要一条
  「按 stageClass + 已解析 values 直接跑 stage」的新通路。

### 缺口 2：参考图不流入工作流

- 聊天 `agentChatPanel.send.ts` 里附件走 `_attachments`，随 `_onSendMessage(text, skills, attachments, workflowTrigger)` 发出；
  但 `workflowTrigger = { workflowId, input?, variables? }`（`agentChatPanel.workflowChip.ts`）**不含附件/图**。
- `_executeWorkflowTurn` → `executeWorkflow(context: { input, ...variables })`，`context` 里也没有图引用。
- 表情包模板的 `upstream_image`（参考图）绑定当前是占位，不消费任何上游图片。

### 缺口 3：聊天 UI 无进度 / 无媒体输出卡

- `_executeWorkflowTurn` 只 `yield` 一条「⚙️ 正在执行工作流…」文本，然后 `await executeWorkflow()`；
  DAG 内部每个节点的进度/产物**不透传**到聊天流。
- 存储工作流 `nodeState.output` 是纯文本，没有 `ComfyExecutionResult.snapshot`（image/video/audio 引用）
  的落点 → 聊天卡渲染不出表情包图。

---

## 4. 推荐方案（分三层，由底到顶）

### 4.1 打通「存储工作流 ComfyStage → 画布 stage 执行」（核心）

新增一条「**按 stageClass + values 直接跑 stage**」的 webview 通路，让 `IComfyExecutionDelegate`
的注入实现能把存储工作流节点映射到域 B 执行器：

- **browser 侧**：新增 `comfyStageBridge.ts`，实现 `IComfyExecutionDelegate`：
  `execute(node, input, ctx)` → 读 `node.data.comfy.stageClass`（如 `ComfyTV.EmojiStage`），
  把 `input.values` 组装成 `{ stageClass, values, images? }` 走一条新 RPC（复用
  `workflowSnapshotBridge` 的 pending/emitter 范式），带 `onProgress`。
- **webview 侧**：`workflowSnapshotBridgeWebview` 新增 `handleDirectStageRunEvent`，
  路由到 `runNodeOrStage` 里按 `stageClass` 直接调 `runEmojiStageGrid`（不经 stageUid）。
- **接线点**：`agentStudioWebviewController`（`IWorkflowExecutionService` 实例处）调
  `setComfyExecutionDelegate(createComfyStageDelegate(...))`。
- `_executeComfyNode` 已把 `result.summary` / `result.outputs` 写入 `nodeState.output`，
  只需补：`result.snapshot` 也写入 `nodeState`（供 §4.3 渲染媒体卡）。

### 4.2 参考图流入

- `agentChatPanel.workflowChip.ts` / `agentChatPanel.send.ts`：`workflowTrigger` 增可选
  `images?: string[]`（附件里 kind=image 的 data URL / 引用），随 `_onSendMessage` 透传。
- `agentDriverService._executeWorkflowTurn` → `executeWorkflow(context)` 增 `images`；
  `_executeComfyNode` 解析绑定时，把 `context.images[0]` 作为 `images` 端口（`upstream_image`）
  注入 `input.values.images`，再交给 delegate → `runEmojiStageGrid` 的参考图入口。
- 表情包模板侧：`runEmojiStageGrid` 已有参考图绑定占位，接入 `values.images` 即可。

### 4.3 进度 + 媒体输出卡

- **进度**：复用 `stage()` 桥的 `onProgress` → `stage-progress` 事件，逐格（cell）进度透传到
  `_executeWorkflowTurn`，`yield` 成聊天工具卡进度（对齐既有 `workflow.stageRunProgress` 卡渲染）。
- **输出**：`ComfyExecutionResult.snapshot`（image/video/audio 引用）写入 `nodeState`，
  执行完成后 `_executeWorkflowTurn` 把 m×n 产物作为图片卡/工具卡 yield 到聊天流。

---

## 5. 改动清单（文件级）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `browser/workflow/comfyStageBridge.ts`（新） | `createComfyStageDelegate()` + pending/emitter 范式（复用 snapshotBridge 模式） |
| 2 | `browser/workflow/workflowSnapshotBridge.ts` | 新增 direct-stage-run 的 `StageRunRequest` 变体（stageClass + values） |
| 3 | `webview/.../comfyHost/workflowSnapshotBridgeWebview.ts` | 新增 `handleDirectStageRunEvent` → 按 stageClass 调 `runNodeOrStage` |
| 4 | `webview/.../comfyHost/workflowRun.ts` | `runNodeOrStage` 暴露「按 stageClass + values」直跑 EmojiStage 的入口（或复用现有 `runEmojiStageGrid` 签名） |
| 5 | `browser/agentStudioWebviewController.ts` | 订阅 direct-stage-run emitter + 回程；实例化处 `setComfyExecutionDelegate(...)` |
| 6 | `browser/workflowExecutionService.ts` | `_executeComfyNode` 把 `result.snapshot` 写入 `nodeState`；`executeWorkflow` options 增 `images` |
| 7 | `browser/agentDriverService.ts` | `_executeWorkflowTurn` 透传 images + 进度/输出 yield 到聊天流 |
| 8 | `browser/agentChat/agentChatPanel.workflowChip.ts` / `send.ts` | `workflowTrigger` 增 `images`，透传附件图 |
| 9 | `common/workflowExecutionService.ts` | `IWorkflowExecutionOptions` / `context` 增 `images` |

---

## 6. 备选方案（对比）

- **方案 B：表情包工作流做成「画布工作流」，聊天触发委托画布整条跑**。
  更贴合「start/prompt/表情包/end 都在画布」的心智，但要新建「跑整条画布工作流」的 RPC
  （现有 `stage()` 桥只支持单节点），工作量更大。适合后续把**任意**画布工作流都能从聊天一键跑。
- **方案 C：域 A 直接内嵌 EmojiStage 的 ComfyUI HTTP 调用**。被 CORS 铁律否决
  （renderer fetch 全拦，第三方 HTTP 只能走 IPC；且会复制一份 `runEmojiStageGrid` 逻辑，两处漂移）。

**推荐先做方案 A（§4）**：它最大化复用已建好的 `stage()` 桥与 `runEmojiStageGrid`，
改动集中在「桥的接线」而非「新执行逻辑」。

---

## 7. 落地顺序与验收

1. §4.1 核心桥（改 #1–#5）→ 单测：`setComfyExecutionDelegate` 后，含 EmojiStage 的存储工作流真跑出 m×n 图。
2. §4.2 参考图（改 #6/#8/#9）→ 单测 + 真机：附件图成为 EmojiStage 参考图。
3. §4.3 进度/输出（改 #6/#7）→ 真机：聊天卡显示逐格进度 + m×n 表情包图。
