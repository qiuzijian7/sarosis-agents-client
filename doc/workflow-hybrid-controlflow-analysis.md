# 混合编排画布：控制流与共存执行分析（Start/Agent/Prompt 与 ComfyTV 节点）

> 需求：start、agent、prompt 等编排节点与 ComfyTV 节点**共存于同一画布**，并通过**连线控制执行顺序与分支**。
> 本文：开源方案对比 → 本项目不足（带代码证据） → 优化方案（W1–W6）。

---

## 1. 开源方案对比

| 维度 | n8n | Dify Workflow | Rivet（Ironclad） | ComfyUI Logic 生态（rgthree/WAS） | **本项目现状** |
|---|---|---|---|---|---|
| **入口契约** | Trigger 节点（Start/Webhook/Cron）显式定义入口 | **Start 节点**：输入变量 key/type/required，发布即 API 参数 | 图直接 Run，输入经图级 Inputs 节点 | 无（画布即程序） | ❌ 无 Start；Run=全图隐式入口 |
| **分支语义** | IF 双输出 **真路由**（不走分支不执行）；Switch 多输出；错误分支 | IF/ELSE 真路由（else-if 链） | If 真路由 + optional edge 动态 fan-in | **值选择器**（所有分支都执行，Switch 选值下传） | ⚠️ **verdict 判定**（全部执行，下游模板自筛） |
| **汇聚控制** | Merge 节点（append/combine/wait 多模式） | 变量聚合器（首个非空）+ 分支天然合流 | Merge 节点 + partial failure 语义 | 多输入自然合并 | ❌ 仅隐式 AND（barrier 全等） |
| **变量传递** | `{{ $json.field }}` 上游链式引用 | **`{{#nodeId.field#}}` 具名引用** + 点选选择器 | 端口连线即值传递（图式） | 端口连线 | ⚠️ `{{input}}` 单变量=第一上游快照 |
| **循环** | Split-In-Batches / Loop 节点 | Iteration 迭代子图 | **Loop 子图 + Parallel 子图** | 无（外部 Python） | 画布域 ❌（脚本域有 parallel/pipeline） |
| **混合执行域** | 纯集成节点（无本地计算节点） | LLM/Code/工具，无媒体渲染域 | 纯 LLM 编排 | 纯媒体渲染（无 LLM） | ✅ **双域共存**（本项最大优势，但割裂） |
| **执行反馈** | 节点状态徽章 + 分支高亮 | 运行日志 + 节点状态 | 边动画 + 节点状态 + 迭代计数 | 进度条 | ⚠️ 仅快照卡片，无分支路径反馈 |

### 各方案核心洞察

- **n8n**：分支的本质是**输出端口路由**——IF 节点执行后只有匹配端口"点火"，调度器沿点火端口推进。汇聚用显式 Merge 节点声明等待策略，避免"多上游语义不明"。
- **Dify**：Start 节点把"工作流参数"变成**一等契约**（可发布为 API 入参）；`{{#nodeId.field#}}` 让变量引用**显式且可点选**，消灭"第一上游"这种隐式魔法。
- **Rivet**：与本项目场景最接近（LLM agent 可视化编排）。关键设计：**子图节点**（Loop/Parallel 内嵌完整控制流）+ optional edge（动态 fan-in，运行时决定哪些入边等待）。
- **ComfyUI Logic 生态**：证明"不改数据流引擎"的兼容路线=值选择器。**这正是本项目 M3 verdict 降级的模式**——它换来零引擎改动，但分支语义藏进节点、浪费算力。

---

## 2. 本项目不足（代码证据）

| # | 不足 | 证据 |
|---|---|---|
| 1 | **执行计划不感知端口** | `executionGraph.ts:17` `ExecutionEdgeLike` 只有 `{source,target}`——store 边上的 `sourceHandle/targetHandle`（`store.ts:46-47`，连线时 `canvasOps.ts:245` 还做端口类型校验）在进入执行计划时被丢弃 |
| 2 | **分支是判定不是路由** | `workflowRun.ts:758-767` 注释自认："★ Deliberate downgrade … VERDICT node, not graph-level branch pruning — Port-aware plan pruning is deferred until the execution plan tracks source handles"。后果：①不匹配分支照常执行（浪费子代理调用/Comfy 渲染）②用户"连线控制分支"的心智模型不成立 ③下游模板要自己 `{{input}}.verdict` 判断 |
| 4 | **变量传递贫乏** | `runAgentNodeExecutor`（workflowRun.ts:693）`resolveUpstreamSnapshotText` 取**第一个**上游快照塞进 `{{input}}`；无具名引用、无字段选择 |
| 5 | **无汇聚语义** | 多上游=barrier 全等；分支后合流只能靠模板自筛，无法表达"任一分支完成即走 / 按序等待" |
| 6 | **双域割裂** | 画布域：有 Comfy+Agent，无循环/动态扇出；脚本域：有 parallel/pipeline/phase，但媒体节点导出为 `null` 占位（canvasExport），无法驱动渲染。code 视图的 Run 仍是图执行 |
| 7 | **无输入契约** | 无 Start 节点；同一图换参数重跑=改节点默认值。已具备的基础：workflow 存储 `variables` 字段 + `workflow.submitVariables` RPC（v6）未被画布利用 |
| 8 | **执行反馈无分支概念** | 执行卡片无 skipped 态（`skipped` 现指非可执行节点），无激活路径高亮 |

---

## 3. 优化方案

### W2（核心）端口感知路由执行 —— 对齐 n8n/Rivet

**目标**：IfElse/Switch 升级为真路由——不匹配分支**不执行**。

1. **执行计划升级**：
   - `ExecutionEdgeLike` 增加 `sourceHandle?/targetHandle?`（store 已持久化，零迁移）
   - `buildParallelExecutionPlan` 输出增加**端口激活传播**：波次调度时维护 `activePorts: Map<nodeId, Set<handle>>`；无 handle 的边视为 always-active（兼容存量）
2. **gate 执行器升级**：
   - IfElse 定义双输出 slot（`then`/`else`）、Switch 定义 N 输出（case-1…default）——LiteGraph 多输出已支持（节点 spec outputs）
   - `runGateNodeExecutor` 返回 `{ branch: 'then'|'else'|'case-N' }`，调度器据此只激活对应出边的端口
   - **verdict 快照行为保留**（向后兼容：旧模板仍读 `{{input}}.verdict`）
3. **skip 传播**：某节点所有激活入边为空 → 标记 `skipped`（卡片灰显，非 error）且向下游传播；skipped 不阻塞 AND-join（见 W3）
4. **UI 反馈**：运行后激活连线高亮、未激活分支暗化
5. **脚本导出对齐**：IfElse 从 `Boolean(expr)` 升级为 `if/else` 语句块包裹下游波次（结构化导出）；Switch → switch-case。保留 verdict 兼容模式开关（workflow 级 `export.mode: 'structured' | 'verdict'`）

### W1 Saros.Start 节点 + args 输入契约 —— 对齐 Dify

1. 新节点 `Saros.Start`：定义输入变量（key/type/default/描述），多输出 slot 可连向任意节点
2. Run 时若图含 Start：先弹**参数输入面板**（列 key/default，允许覆盖）→ 注入执行上下文；无 Start 保持现状（全图直接跑）
3. 占位符 `{{args.topic}}` 在 Prompt/Agent 节点全局可用（与 `{{input}}` 同一解析器）
4. 复用既有 `workflow.variables` 存储 + `submitVariables` RPC；Start 节点定义与 workflow.variables 双向同步（画布编辑 vs API 提交同一真源）

### W3 Saros.Merge 汇聚节点 —— 对齐 n8n Merge / Dify 变量聚合

- 模式：`all`（默认，等全部激活入边）/ `any`（首个完成即走，其余结果丢弃）/ `order`（按入端口序等待）
- 输出=各入边快照数组（`{{input}}` 变 `{then: …, else: …}` 或首个非空，视模式）
- 解决：分支后合流、多上游选择性等待

### W4 变量系统：具名引用 —— 对齐 Dify `{{#nodeId.field#}}`

- 占位符语法：`{{<节点label>.<字段>}}`（如 `{{提示词.text}}`、`{{图片分析.tags}}`）+ `{{args.<key>}}`
- 解析器从快照 store + 输出 schema 取值（agent schema 已支持）；节点 label 重名时回退 id
- Prompt/Agent 编辑器加**插入选择器**（点选上游节点及其输出字段，自动生成占位符）
- `{{input}}` 保留（= 第一上游，兼容）

### W5 双域能力互灌

**5A（推荐先做，画布域补控制流）**：
- `Saros.Loop`：迭代子图节点（items 来源=上游快照数组或手写列表；循环体=子图，对齐 Dify Iteration / Rivet Loop Subgraph）；执行器内逐项跑子图并归档每次迭代快照
- `Saros.Parallel`：显式并发容器（替代全局并行开关的节点级表达；并发度节点属性）
- 复用 subflow.ts 既有展平/封装机制

**5B（远期，脚本域补媒体能力）**：
- 引擎 worker 增加 `comfyStage(nodeId, values)` hook → host 桥到 ComfyUI runner；媒体节点在脚本导出中从 `null` 占位升级为 `comfyStage()` 调用
- 届时 code 视图 Run 可切到 WorkflowEngine 执行（"Run 感知视图模式"），实现脚本驱动媒体节点

### W6 执行反馈增强

- per-edge 数据流动画（LiteGraph link 高亮）
- 节点状态徽章扩展：`queued / running / done / error / skipped`（skipped 区别于现在的"非可执行"）
- Loop 迭代计数徽章（`3/10`）

---

## 4. 落地顺序与风险

| 顺序 | 里程碑 | 核心交付 | 风险/测试 |
|---|---|---|---|
| 1 | **W2** 端口路由 | 计划器端口激活传播 + gate 双/N 输出 + skip 传播 + 结构化导出 | 波次 barrier 不变量必须保持（快照先于消费）；executionGraph 单测扩端口传播矩阵（gate→skip→join 全组合） |
| 2 | **W1** Start 契约 | Saros.Start + 参数面板 + `{{args.*}}` | variables 双真源同步冲突处理（画布编辑优先） |
| 3 | **W3** Merge | 三模式汇聚节点 | any 模式取消未完成上游的实现（AbortSignal 已有） |
| 4 | **W4** 变量 | 具名占位符 + 插入选择器 | label 重名解析规则；旧工作流兼容（未知占位符原样保留） |
| 5 | **W5A** Loop/Parallel | 迭代/并发子图节点 | 子图内 gate 与外层路由的嵌套语义 |
| 6 | **W6** 反馈 | 边动画 + skipped 徽章 + 迭代计数 | LiteGraph 0.17 link 高亮 API 确认 |

**兼容红线**：① 无 handle 的存量边=always-active（旧图行为不变）② verdict 快照与 `{{input}}` 永久保留 ③ 序列化零迁移（sourceHandle 已在 store）。

---

## 5. 结论

本项目"双域共存"（LLM 编排 + 媒体渲染同画布）是相对所有对标项目的**独特优势**；短板集中在**控制流表达**：无入口契约、分支靠判定不靠路由、变量隐式、汇聚缺失。W2 端口感知路由是杠杆最高的改造（数据层端口信息已就位，只差执行计划消费它），配合 W1/W3/W4 即可达到 n8n/Dify 级控制流表达，同时保持 ComfyTV 节点生态零感知。
