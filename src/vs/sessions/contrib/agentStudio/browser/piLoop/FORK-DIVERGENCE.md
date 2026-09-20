# piLoop fork 与上游的差异清单（机器可读）

> **用途**（方案主线 D）：每次动 `piLoop/` 时必须同步本表。升级上游布局时，
> 按「差异是否经 config 钩子」分类处理：钩子类 = 重写适配层即可；内核类 = 需逐条移植评估。
>
> **上游基点**：`earendil-works/pi @ e98f287ee498e0116546f4e9aa083fdec9793cd2`（旧布局
> `agent-loop.ts`）。⚠ 上游 main 已演进到 `harness/` 架构（compaction/execution/runtime/
> session/jsonl/pico3 子目录）——**我们 fork 的是旧架构**，布局升级需专门评估（见方案 D3）。

## A. 内核本体差异（agentLoop.ts / types.ts —— 升级时需移植评估）

| # | 差异 | 位置 | 理由（legacy 对齐依据） |
|---|---|---|---|
| A1 | 无 `getDefaultStreamFn()` 回落，`streamFn` 必填 | agentLoop.ts | 本仓模型层由 IModelProvider 提供，无内置实现可言 |
| A2 | 未复刻 `declareToolChanges` / `withToolChanges` | — | 依赖 pi 的工具集热变更声明机制；本仓工具集在 turn 起点即固定 |
| A3 | steering **顶部统一轮询**（替代 pi 的 173/203/263 三处分写） | agentLoop.ts runLoop | 宿主 DeliveryQueue 是零成本空 lease ⇒ 统一轮询等价且简单 |
| A4 | **撞顶/强制收尾轮**：`maxTurns` 撞顶且模型仍在要工具（或 `requestWrapUp` 钩子返回文案）⇒ 禁工具收尾轮（`toolChoice:'none'` + 提醒注入）再硬停；收尾轮工具调用不执行 | agentLoop.ts runLoop | legacy `classifyBudgetGate` wrap-up + `wrapUp.forced`（撞顶直接结束会让末轮 delegate_task 成果 100% 丢弃） |
| A5 | `textToolCallLeakGuard` 缝：伪 XML 工具调用文本 ⇒ 丢弃不入 transcript + 纠正指令 + 重试 ≤2 + `discard_streamed_text` | types.ts + agentLoop.ts | legacy executor:2294-2368（XML_TOOL_LEAK_RETRY_LIMIT=2） |
| A6 | `incompleteTurnRetry` 缝：空/只有思考/截断/tool-call-lost ⇒ 按类阶梯指令续跑（每类独立上限）；length/truncated-text 保留半截文本不 discard | types.ts + agentLoop.ts | legacy executor:2375-2470（未完成轮安全续跑） |
| A7 | `AgentEvent` 增补 `discard_streamed_text` 成员 | types.ts | 通知 UI 清掉已流式文本（对齐 legacy `discard_prior_text` delta） |
| A8 | `getSteeringMessages` 轮询钩子 | types.ts（pi 原有 Agent 类 steer/followUp；loop 级轮询为本仓增补） | 本仓没有 pi 的 Agent 包装类，插话走宿主 DeliveryQueue |
| A9 | runLoop 跳出条件不含 `!wrapUpDone` 门 | agentLoop.ts | 2026-09-20 OOM 实证：强制收尾 + turnIndex<maxTurns 时该门导致无限循环 |
| A10 | **转录卫生**：pruneOrphanedToolCalls 每轮流式前 + 收尾轮跳过执行时就地摘除孤儿 tool 对（新增 onTranscriptPruned 钩子） | kernelTranscriptHygiene.ts + agentLoop.ts | 2026-09-20 实证：pi 权威 transcript 的孤儿此前永不清理，LMBridge 每轮重剥同一批（3→6 条且在涨）；legacy 靠回写真历史天然免疫 |

## B. 适配层差异（升级时重写即可，内核不受影响）

| # | 差异 | 位置 | 说明 |
|---|---|---|---|
| B1 | `buildModelOptions` 增补 `toolChoice` 直通 | streamAdapter.ts | 收尾轮禁工具语义依赖（legacy executor:1428） |
| B2 | `createPiStreamFn`：pi StreamFn ⇒ `IModelProvider.chat` 桥（delta 互转、usage 终态合并、abort 传播） | streamAdapter.ts | 本仓模型层替代 pi-ai 注册表 |
| B3 | `piLoopConvertToLlm`：过滤 UI-only 消息 | hostBridge.ts | 本仓 transcript 携带 customMessage 等 UI 条目 |
| B4 | `toAgentTools` / `ToolExecutor`：pi AgentTool ⇒ 宿主工具执行总线 | toolAdapter.ts | 审批/沙箱/副作用全在 legacy `_executeToolCalls` 里 |
| B5 | `createPiLoopEventMapper`：pi 事件 ⇒ `IChatStreamDelta` | eventAdapter.ts | UI 契约缝 |
| B6 | 驱动器族（护栏/引导/plan/checkpoint/检索/压缩装配） | piTurnKernel.ts + kernel*.ts | 全部 legacy 行为面的承载层 —— 与上游无关，本仓私有 |

## C. 已知陷阱（升级/移植时必读）

1. pi-ai `AgentToolCall.arguments` 是**对象**（非 JSON 字符串）——按 string 解析会让所有轮
   argsHash 全同 ⇒ reasonStreak 误报（2026-09-20 实证）。
2. thinking delta 文本在 `content` 字段（streamAdapter `appendThinking`），不是 `thinking` 字段。
3. 被 `beforeToolCall` 拦下的调用走 `kind:'immediate'` 路径，**不过 afterToolCall** ——
   依赖 afterToolCall 的提醒投递在全批拦截轮无人接收（须直写 transcript）。
4. piLoop 的 `TranscriptContext` **没有 systemPrompt 通道**（normalizeTranscript 只透传
   messages）——系统提示必须以 `role:'system'` 消息携带。
5. `transformContext` 默认只影响**发送副本**；本仓压缩/plan 改写权威历史 ⇒ 就地 splice
   `context.messages`（保持数组引用）。

## D. 升级路径备忘（方案主线 D2/D3）

### D.0 漂移实测（2026-09-20，`git fetch origin main` 后量化 —— **修正此前"对齐越来越贵"的判断**）

| 指标 | 实测值 | 解读 |
|---|---|---|
| 基点到上游 main 的提交数 | **87**（2026-09-11 → 09-20，9 天，仍在动） | 上游活跃 |
| 我们 fork 的 `agent-loop.ts` | **0 改动**（上游最后一次触碰 09-16，早于 fork 基点 09-17） | **fork 源冻结** |
| 依赖最重的 `types.ts` | **+2 / −1 行**（9 天窗口） | 移植成本 ≈ 分钟级 |
| 近 30 天 `agent-loop.ts` 改动次数 | **3**（周级 cadence，维护态） | 仍有 bugfix 流出（如 preflight abort / compact 时机） |
| 上游 churn 落点 | 几乎全部在**新增** `harness/pico3/*`（`packages/agent/src` 28 文件 +8005/−13） | 与 fork 模块**物理隔离** |
| pico3 成熟度 | 官方原文：*"Design under discussion. Code and traces illustrate the proposed behavior; they are not existing package exports."* | **设计阶段**，跟进即追移动靶 |

⇒ **真实风险画像不是"对齐债务累积"，而是"两条轨道并行"**：
1. **上游 fix 不会自动到手** ⇒ 需周期性 cherry-pick 评估（成本低：单次改动普遍 1-10 行级）；
2. **pico3 是替代架构而非补丁** ⇒ 等其摘掉 experimental/design 标记再按"新架构立项"评估；
3. **语义漂移来自我们自己**（A1-A10 是对齐 legacy 的主动增强，不是债务）⇒ 持续维护本表即可。

### D.1 漂移监控（建议 1-2 周一次；**有输出才需要动作**）

```bash
cd <pi-clone> && git fetch origin main
# 只要这两条有输出 ⇒ 人工评估移植（预计 0.5-1 天/次）
git log --format='%h %ci %s' e98f287e..origin/main -- packages/agent/src/agent-loop.ts packages/agent/src/types.ts
git diff --shortstat e98f287e..origin/main -- packages/agent/src/agent-loop.ts packages/agent/src/types.ts
```
`harness/` 下的变化**直接忽略**（另一条轨道，不构成对我们的影响）。

### D.2 若将来立项跟进

升级动作 = 重写 B 面适配层 + 逐条评估 A 面差异（本表 A1-A10）。
- 每次动 piLoop/ 后：更新本表 + 跑 `piLoop.test.ts`（22）+ `piTurnKernel.test.ts`（32）+
  `piLoopDualRunMatrix.test.ts`（15）+ `piKernelProc.test.ts`（5）四套件。

## E. 新增子目录（纯新增，不改上游语义）

| # | 内容 | 位置 | 说明 |
|---|---|---|---|
| E1 | `proc/` 进程隔离（P0 spike） | proc/kernelProcProtocol.ts + kernelProcWorkerEntry.ts + runPiKernelTurnInProc.ts | 内核跑 worker_threads（P1 换 utilityProcess），模型/工具经 RPC 回父进程（宿主服务零远程化、审批链不断）。与 pi 上游子进程机制的差异：pi 整进程搬迁（自带权限），我们只搬内核。⚠ 教训：streamAdapter 的 chunk 循环不查 signal ⇒ worker abort 必须同时掐断在途 RPC 流，否则 abort 延迟 = 流剩余时长（2026-09-20 实测）。测试 = `piKernelProc.test.ts`（4 例，依赖 transpile 产物）。 |
