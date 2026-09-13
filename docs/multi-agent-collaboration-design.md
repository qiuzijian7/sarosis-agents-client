# 多 Agent 协同工作解决方案（基于开源源码分析）

> 日期：2026-09-11
> 前置文档：`multi-agent-collaboration-research.md`（开源方案调研与差距分析）
> 源码分析对象：`AIProjects/open-multi-agent`（TS）、`AIProjects/openclaw`（TS）
> 已落地代码：`webview/src/features/workflowEditor/comfyHost/collaboration/`（6 模块）
> 测试：`webview/test/collaboration.test.ts`（**145 断言全绿**，`node test/run-collaboration.mjs`）

---

## 一、目标与设计原则

### 1.1 要解决的四个具体问题

| 问题 | 现状证据 | 影响 |
|---|---|---|
| **上下文两极化** | 画布取**第一个**上游快照全文（`resolveUpstreamSnapshotText`）；headless 注入**全量会话历史** | 前者信息不足、后者上下文爆炸（多 agent 时 token 按节点数×历史增长） |
| **失败悬挂** | serial 首失败即停、下游既不执行也不标记 | 用户看到「图跑一半断了」，下游节点永久无终态 |
| **无共享记忆** | 画布子代理只收 prompt（`workflowChildPort`） | A 的中间结论 B 无从知晓，除非设计期显式连线 |
| **无失控护栏** | Loop/Parallel 递归嵌套无上限；子代理重复行为靠 10 分钟超时兜底 | 静默烧 token（Anthropic 实测多 agent 15× token） |

### 1.2 设计原则

1. **不引入外部编排框架**——画布本身即编排层；只移植**与 LLM/运行时解耦的纯逻辑**。
2. **内核与运行时分离**——协同内核零依赖（无 DOM/LiteGraph/React），可独立单测；节点接入是薄适配层。
3. **拒绝式（default-deny）上下文**——默认只注入直接上游的已完成结果，扩展视野需显式 opt-in。
4. **显式终态优于隐式悬挂**——任何失败/跳过都沿依赖边级联，不留「未执行」。
5. **上限显式化**——迭代/spawn/租约都有明确上限，超限**报错而非静默截断**。

---

## 二、开源源码分析结论（可移植设计）

### 2.1 open-multi-agent（TS，Coordinator + 任务 DAG）

| 设计 | 源码位置 | 移植价值 |
|---|---|---|
| **事件驱动就绪集 + 信号量闸门** | `task-execution.ts:857-983` + `utils/semaphore.ts` + `agent/pool.ts:152` | 不用拓扑排序一次性铺开，`task:ready` 事件驱动、`inFlight` 卡并发；天然支持运行期插入任务 |
| **拒绝式上下文注入** | `orchestrator/task-execution.ts:1789-1887` `buildTaskPrompt` | 默认只注入**直接前驱且 completed** 的结果；非完成态直接跳过；`memoryScope:'all'` 才注入共享摘要；结构化 payload 有 64KB 硬上限（**超限抛错不截断**） |
| **级联终态** | `task/queue.ts:514 cascadeFailure` / `:533 cascadeSkip` | 上游失败/跳过 → 递归把下游标终态并发事件，杜绝永久悬挂 |
| **共享黑板** | `memory/shared.ts:68` | 命名空间 KV（`<agent>/<key>`）+ `getSummary()` 按 agent 分组、**每值截断 200 字符** + TTL 按回合且**只过滤不删除** |
| **循环检测** | `agent/loop-detector.ts:33` | 滑动窗口 + **确定性签名**（对象 key 排序、工具按名排序）+ 连续重复计数 |
| **重试** | `orchestrator/retry.ts:46` | 指数退避 + **equal jitter**（避免限流下锁步碰撞）+ 终态错误不重试 |

### 2.2 openclaw（TS，运行时 spawn + 引导）

| 设计 | 源码位置 | 移植价值 |
|---|---|---|
| **租约式结果回灌队列** | `agent-steering-queue.ts:91/182` + `registry.types.ts:128` | `pending→in_progress(leased)→delivered` 状态机 + `leaseId` 幂等 + **陈旧租约回收**（5min）→ 交付状态可持久化、可重放、顺序确定 |
| **公告投递阶段机** | `announce/subagent-announce-dispatch.ts:91` | `steer-primary/direct-primary/steer-fallback` 有序回退 + disposition（delivered/queued/retryable/…) 把「交付」与「交付是否成功」解耦 |
| **幂等重启恢复凭据** | `registry/subagent-registry-restart-recovery.ts:39` | `reserved→attempted→consumed→accepted→abandoned` 判定「是否已越过不可判定点」，歧义时**终止以防重复副作用** |
| **spawn 输入契约** | `subagent-spawn-contract.ts:9-40` | `mode(run\|session)` / `context(isolated\|fork)` / `sandbox` / `outputSchema` / `cleanup` —— 显式枚举优于隐式行为 |
| **深度/能力模型** | `subagent-capabilities.ts:174-207` + `config/agent-limits.ts:24-30` | 按深度推导角色（main/orchestrator/**leaf**），leaf 的 `canSpawn=false` |

### 2.3 未采纳的设计（及原因）

| 设计 | 来源 | 不采纳原因 |
|---|---|---|
| 对话优先编排（speaker selection） | AutoGen | token 15×、轨迹不可预测；本项目已有确定性 DAG 语义 |
| 完整状态机运行时（Channels + Checkpoint 时间旅行） | LangGraph | 与画布现有 `runGraphExecution` 双引擎冲突；本方案先取「拒绝式注入 + 级联终态」两个可组合子集 |
| 消息总线全量注入 | open-multi-agent `messaging.ts` | 其实现按「读+未读全部」注入不截断，是已知的上下文膨胀点，本方案改为按需注入 |
| 进程内 spawn（Gateway 生命周期） | openclaw | 强依赖其 Gateway/会话存储；本项目子代理已有 `UnifiedSubAgentDispatch` |

---

## 三、总体架构

```
┌───────────────────────────────────────────────────────────────────────┐
│  画布节点层（薄适配，P1 待接入）                                        │
│  Saros.Delegate · Saros.Blackboard · Saros.Agent(contextScope) ·       │
│  Saros.Supervisor(动态委派)                                            │
├───────────────────────────────────────────────────────────────────────┤
│  协同内核 collaboration/（★ 本轮已落地，145 断言覆盖，零运行时依赖）      │
│  ┌──────────────┬────────────────┬──────────────┬──────────────────┐  │
│  │ semaphore    │ collaboration  │ context      │ blackboard       │  │
│  │ 并发闸门      │ Queue          │ Assembly     │ 共享记忆          │  │
│  │              │ 就绪集+级联终态 │ 拒绝式注入    │ 命名空间+摘要      │  │
│  ├──────────────┼────────────────┼──────────────┼──────────────────┤  │
│  │ deliveryQueue│ loopGuard      │              │                  │  │
│  │ 租约式回灌    │ 循环检测+迭代护栏│              │                  │  │
│  └──────────────┴────────────────┴──────────────┴──────────────────┘  │
├───────────────────────────────────────────────────────────────────────┤
│  运行时集成层（P1）                                                     │
│  runGraphExecution(serial/parallel) · runAgentNodeExecutor ·           │
│  UnifiedSubAgentDispatch · workflowChildPort                          │
└───────────────────────────────────────────────────────────────────────┘
```

**分层理由**：内核全部是纯函数/纯状态机，可在 Node 下直接单测（无需 DOM/React/LiteGraph）；节点接入与运行时集成是薄适配，改动面可控且可回滚。

---

## 四、协同内核详设（已落地）

### 4.1 `semaphore.ts` —— 并发闸门

```ts
const sem = createSemaphore(4);              // 上限可运行时 setMax()
await sem.run(() => callLLM(prompt));        // 池满自动排队，异常也释放
const results = await runPooled(items, 4, fn);  // 保序 + 失败回填不中断
```

- **FIFO + 槽位移交**：`release()` 直接把槽位交给等待者（不先减后加），杜绝「释放瞬间被插队」的饥饿。
- **`runPooled` 语义**：返回**顺序对齐**的 `{ok,value}|{ok,error}` 数组——单个任务失败不中断其余（对齐 open-multi-agent `runParallel` 的 allSettled）。
- **用途**：provider 池（4）/ ComfyUI 串行池（1）各自独立闸门；运行期动态派发的任务也能受限。

### 4.2 `collaborationQueue.ts` —— 就绪集 + 级联终态

```ts
const q = createCollaborationQueue([{ id:'plan', title:'拆解' }, { id:'w1', dependsOn:['plan'] }]);
q.on('task:ready', t => dispatch(t));   // ★ 派发信号
q.announceReady();                      // 注册监听后建立初始基线（幂等）
q.complete('plan', 'output');           // 自动：下游就绪 → 广播 task:ready
q.fail('plan', 'provider 500');         // 自动：递归级联下游为 failed
```

**关键语义（三处易错点，均已被测试锁定）**：

1. **`task:ready` 是派发信号 → 必须去重**：`announceReady()` 扫描所有满足依赖的 pending 任务，用 `announcedReady: Set` 保证同一任务只广播一次（否则调度器会重复派发 → 重复调 LLM）。
2. **广播与订阅分离**：初始就绪发生在构造函数返回**之前**，若在构造里广播，调用方监听尚未注册 → 事件丢失。故约定「注册监听后调一次 `announceReady()`」，`add()` 不广播 ready。
3. **级联不覆盖 `in_progress`**：正在运行的节点有自己的终态，不被上游失败强制改写。

**`validateDependencies()`**：DFS 三色着色找环 + 未知依赖 + 自依赖（自依赖只报一条，不重复报环）。

### 4.3 `contextAssembly.ts` —— 拒绝式上下文注入

```ts
const ctx = assembleNodeContext(
  { id:'merge', title:'汇总', description:'合并结论' },
  deps,                                     // 直接上游结果
  { memoryScope:'dependencies',             // 默认拒绝式
    dependencyPayload:'output',             // output | structured | both
    sharedSummary: board.getSummary(),      // 仅 memoryScope='all' 时注入
    messages: busMsgs },                    // 消息总线恒注入
);
// → { text, included:['w1','w2'], skipped:['w0'] }
```

- **非 `completed` 依赖直接跳过**（不给下游看半成品/失败内容）。
- **payload 硬上限 64KB，超限抛 `DependencyPayloadError`**——静默截断会让模型基于半截 JSON 推理，比失败更难排查。
- **`structured` 模式缺结构化值 → 抛错**（`DEPENDENCY_STRUCTURED_RESULT_MISSING`）。
- **`stableStringify`**：对象 key 排序，保证同一结构产出同一字符串（缓存/比对/去重友好）。

### 4.4 `blackboard.ts` —— 共享工作记忆

```ts
const bb = createBlackboard({ summaryValueChars: 200 });
bb.write('agent-a', 'task:t1:result', '结论…', { ttlTurns: 5 });
bb.getSummary({ taskId: 't1' });     // 按 agent 分组 + 每值截断
bb.advanceTurn();                     // TTL 以**回合**为基准（与执行速度无关）
```

- **命名空间** `<agent>/<key>`，支持跨 agent 全限定读取。
- **摘要注入而非全量**：`getSummary()` 每值截断（默认 200 字符）——避免重演「全量历史捆绑」。
- **TTL 只过滤不删除**：过期项读取跳过但保留存储（审计线索 + 避免并发写竞争）。
- **`__` 保留前缀不进摘要**（内部协调数据如检查点）。
- **snapshot/restore**：跨会话/检查点恢复；restore 不回退回合号。

### 4.5 `deliveryQueue.ts` —— 租约式结果回灌

```ts
dq.enqueue({ id:'d1', from:'child-1', to:'parent', content:'结果' });
const batch = dq.lease('parent', 'lease-1');   // pending → in_progress（按 enqueue 序）
dq.ack(batch.map(i => i.id));                  // → delivered
// 或 dq.release('lease-1') 归还（attempts+1）；dq.reclaimStale() 回收超时租约
```

- **原子领取**：只有 `pending` 能被领走；同一目标按 enqueue 序领取（顺序确定）。
- **`leaseId` 幂等**：重复 ack/release 无副作用（openclaw 同款）。
- **陈旧租约回收**（默认 5min）：父节点崩溃/卡住时结果不会永久卡在 `in_progress`。
- **内容上限截断**（默认 6000 字符）：防注入父上下文时膨胀。

### 4.6 `loopGuard.ts` —— 循环检测 + 迭代护栏

```ts
const ld = createLoopDetector({ maxRepetitions: 3, window: 4 });
ld.recordToolCalls([{ name:'read_file', input:{ path:'/a' } }]);  // 连续 3 次 → 命中
const guard = createIterationGuard(50, 'Saros.Loop');             // 每次迭代前 next()
```

- **确定性签名**：工具按 name 排序、参数按 key 排序后序列化——否则参数顺序变化会绕过检测。
- **文本归一化**：连续空白压缩为单空格后比较。
- **迭代护栏**：`next()` 返回 false = 超限（调用方应报明确错误，**不静默截断**——静默会让用户以为「循环正常结束」）。

---

## 五、节点接入设计（P1 待实施）

### 5.1 `Saros.Delegate`（委派节点，最高性价比）

**复用已有能力**：`browser/providers/tool/delegationTools.ts` 的 `delegate_task`（1–5 只读子代理 + `isolation_level` + `output_schema`）已实现，仅缺画布节点包装。

```
spec: Saros.Delegate (kind:'react', category:'controlFlow')
  inputs:  [{ name:'in', type:'SAROS_JSON' }]
  outputs: [{ name:'out', type:'SAROS_JSON' }]
  widgets: agents(COMBO 多选: code-explorer/researcher/data)
           isolationLevel(COMBO: subagent|peer)
           outputSchema(TEXT, 可选 JSON Schema)
           concurrency(INT, 默认 3)          ← 用 semaphore 限流
```

**执行器骨架**：
```ts
async function runDelegateNodeExecutor(input: NodeExecutionInput) {
  const task = resolveUpstreamSnapshotText(input.store, input.upstreams);
  const ctx = assembleNodeContext(self, deps, { memoryScope:'dependencies' });  // 拒绝式
  const results = await runPooled(agents, concurrency, (agent) =>
    delegate({ agent, task: ctx.text, isolation: isolationLevel, schema: outputSchema }));
  return writeSnapshot({ ok: results.filter(r => r.ok).map(r => r.value), failed: … });
}
```

### 5.2 `Saros.Blackboard`（共享黑板节点）

```
widgets: mode(COMBO: write|read|summary) · key(TEXT) · value(TEXT, write 时)
执行：write → board.write(nodeId, key, value) → 透传上游
      read  → 读 key 注入快照
      summary → board.getSummary() 注入下游上下文
```
底层复用内核 `blackboard`（与 Swarm 看板隔离 namespace）。

### 5.3 `Saros.Agent` 接入 `contextScope`

headless 路径已实现（`workflowExecutionService.ts:1714+`）；画布侧只需：
- spec 加 `contextScope` widget（`session|upstream-only|fresh`）；
- `runAgentNodeExecutor` 透传该字段到 payload；
- `workflowChildPort.createSubAgent` 按 scope 决定是否携带会话历史。

### 5.4 `Saros.Supervisor`（动态委派，P1 后段）

对齐 Anthropic orchestrator-worker：输入任务描述 + 可用 agent 列表 → LLM 决策**动态 spawn** → `collaborationQueue.add()` 插入运行期任务 → 汇总。
**强制护栏**：`maxAgents` / `tokenBudget` / `outputSchema` / `maxSpawnDepth`（1→2）。

---

## 六、运行时集成设计（P1）

### 6.1 把级联终态接进画布执行

现有 `runGraphExecution`（serial）首失败即停 → 改为：

```ts
// 执行前把 plan.steps 装入 collaborationQueue（依赖 = plan 的 upstreams 映射）
// 每个 step 完成后 q.complete(step.id, result)；失败 q.fail(step.id, error)
// → 下游自动级联 failed，不再悬挂；GraphRunResult.skippedIds 直接来自 q.summary()
```
收益：失败图也有完整终态与原因，前端可逐节点展示（而非整体报「执行失败」）。

### 6.2 并发改用信号量

`runGraphExecutionParallel` 的「分层 barrier」保留（静态图更简单），但**动态派发任务**走 `semaphore` 池——两者共用同一个 provider 池上限，避免总量超限。

### 6.3 子代理结果回灌

`runAgentNode` 的返回值目前只写本节点快照 → 增补：同时 `deliveryQueue.enqueue({ from: 子代理, to: 父节点 })`，父节点下一轮 `lease()+ack()` 消费。收益：交付状态可持久化（重启后不重复交付）、顺序确定。

### 6.4 上下文注入替换

`resolveUpstreamSnapshotText`（取第一个）→ `assembleNodeContext`（全部直接依赖 + 拒绝式过滤）。**注意**：这是行为变更，需灰度（可先按 `node.contextMode` 开关）。

---

## 七、测试策略

### 7.1 已落地测试（`test/collaboration.test.ts`，145 断言）

| 模块 | 覆盖要点 | 断言数 |
|---|---|---|
| semaphore | 并发上限、FIFO、异常释放、setMax 唤醒、runPooled 失败回填 | ~18 |
| collaborationQueue | 就绪判定、ready 去重、级联失败/跳过、in_progress 保护、动态插入、环检测、事件注销、summary | ~30 |
| contextAssembly | 拒绝式过滤、memoryScope、payload 形态、64KB 上限抛错、stableStringify | ~22 |
| blackboard | 命名空间、TTL 过期过滤不删除、摘要分组/截断、保留前缀、snapshot/restore | ~18 |
| deliveryQueue | 租约原子领取、ack/release 幂等、陈旧回收、内容截断、stats 守恒 | ~20 |
| loopGuard | 签名确定性、连续重复、窗口滑动、文本归一化、迭代护栏 | ~15 |
| e2e 场景 | 主管→3 子任务（并发 2）→汇总（拒绝式注入+黑板）→回灌→循环检测 | ~12 |

**测试暴露并修复的 3 个真实缺陷**（体现测试价值）：
1. `announceReady()` 重复广播 → 调度器可能重复派发（加 `announcedReady` 去重）；
2. 初始就绪事件在构造期广播 → 调用方监听未注册即丢失（改广播/订阅分离）；
3. 自依赖同时触发「依赖自身」与「成环」两条报告（噪音）。

### 7.2 运行方式

```bash
cd src/vs/sessions/contrib/agentStudio/webview
node test/run-collaboration.mjs      # esbuild 打包 + node 执行（与既有测试同机制）
```

### 7.3 后续测试（P1 接入时）

- **节点级**：`Saros.Delegate` 执行器（mock delegate RPC）→ 断言 `runPooled` 限流与失败回填；
- **集成**：serial 执行器接入队列后，构造「上游失败」图 → 断言下游 `failed` 且 `error` 含上游标题；
- **回归**：上下文注入切换后，断言 `{{input}}` 仍能取到全部直接依赖（不破坏既有模板语义）。

---

## 八、实施路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0 内核** | semaphore / collaborationQueue / contextAssembly / blackboard / deliveryQueue / loopGuard + 145 断言测试 | ✅ **本轮完成** |
| **P1a 节点** | `Saros.Delegate`（复用 delegate_task）+ `Saros.Blackboard` + Agent `contextScope` | 待实施（设计见 §5） |
| **P1b 集成** | 级联终态接入 serial 执行器 + 信号量池 + 回灌队列 + 上下文注入灰度切换 | 待实施（设计见 §6） |
| **P1c 动态** | `Saros.Supervisor` 动态委派（护栏：maxAgents/tokenBudget/maxSpawnDepth） | 待实施 |
| **P2 互操作** | A2A 接入（AgentCard + task/sendMessage）、检查点时间旅行 | 见调研文档 |

---

## 九、风险与取舍

| 风险 | 缓解 |
|---|---|
| **上下文注入行为变更**（取第一个 → 取全部依赖）可能改变既有工作流输出 | 按 `node.contextMode` 灰度开关，默认保持旧行为一段时间 |
| **级联终态**会让原本「静默跳过」的下游变成显式 failed | `GraphRunResult` 增加 `cascaded: string[]` 区分「真失败」与「级联失败」，前端分别展示 |
| **黑板成为隐式耦合**（绕过显式连线传递数据） | 摘要注入**必须 opt-in**（`memoryScope:'all'`）；节点 UI 明确提示「黑板是运行期共享，不体现在连线上」 |
| **信号量池上限**与 ComfyUI 串行语义冲突 | ComfyUI 步骤固定走 `createSemaphore(1)` 独立池，不与 provider 池共享 |
| **交付队列增加一次状态往返** | 仅对「父节点需在子任务运行期继续工作」的场景启用（普通 await 返回路径不变） |

---

## 十、代码位置速查

| 内容 | 位置 |
|---|---|
| 协同内核（6 模块 + 统一导出） | `webview/src/features/workflowEditor/comfyHost/collaboration/{semaphore,collaborationQueue,contextAssembly,blackboard,deliveryQueue,loopGuard,index}.ts` |
| 内核测试（145 断言） | `webview/test/collaboration.test.ts` |
| 测试运行脚本 | `webview/test/run-collaboration.mjs` |
| 待接入：画布执行器 | `comfyHost/workflowRun.ts` `runGraphExecution` / `runGraphExecutionParallel` |
| 待接入：agent 执行器 | `comfyHost/graphNodeExecutors.ts` `runAgentNodeExecutor` |
| 待复用：委派工具 | `browser/providers/tool/delegationTools.ts` |
| 待复用：子代理派发 | `common/unifiedSubAgentDispatch.ts` |
| 待复用：画布→子代理桥 | `browser/providers/tool/workflowChildPort.ts` |
| 开源参考 | `AIProjects/open-multi-agent`、`AIProjects/openclaw` |
