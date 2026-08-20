# 动态工作流 · 落地方案与测试用例（Implementation Plan）

> 依据：`doc/Dynamic-Workflow-Integration-Design.md`（架构设计 §3/§5）+ UI 设计（报告第 8 章）。
> 覆盖：M1 引擎+工具 / M2 画布数据桥 / M3 编排节点 / M4 Canvas-Code 双模式。
> 原则：每个里程碑独立可发布、独立可回归；测试先于实现细节冻结（用例即契约）。
> 日期：2026-08-18

---

## 第一部分 · 落地方案（重新设计）

### 1.1 里程碑依赖图

```
M1 引擎+工具（Chat 闭环）─────────────┐
  ├─ W1.1 类型与协议（无依赖）         │
  ├─ W1.2 worker 源码（依赖 W1.1）     ├─→ M2 画布数据桥 ─┐
  ├─ W1.3 host 引擎（依赖 W1.1/1.2）  │                  ├─→ M4 Canvas/Code 双模式
  ├─ W1.4 dispatch 子代理桥（并行）    │                  │    M4a 导出（依赖画布 spec，不依赖 M2）
  ├─ W1.5 workflow 工具（依赖 1.3/1.4）│                  │    M4b 投影（依赖 M1 事件流）
  └─ W1.6 聊天卡片 UI（依赖 1.5）     ├─→ M3 编排节点执行 ┘    M4c 双向 sync（依赖 M3+M4a）
                                      │
                                      └─→ 全程：观测（事件面）+ 回归基线维护
```

发布节奏：**M1 一个 PR 系列可独立上线**（Chat 内完整可用）；M2/M3/M4 各自独立开关（feature flag `sessions.agentStudio.workflow.canvasBridge` / `orchestrationNodes` / `dualMode`），默认关闭灰度。

### 1.2 M1 · 引擎 + 工具（Chat 闭环）

| WS | 任务 | 交付文件 | 依赖 | 规模 |
|---|---|---|---|---|
| W1.1 | 类型 + 协议 + fatal 错误分级 + schema 子集校验器 | `common/workflow/types.ts`、`protocol.ts`、`schemaSubset.ts` | 无 | S |
| W1.2 | worker 源码（字符串常量）：hooks realm、FIFO slot、cancel 边界、contain()、materializeFromRealm、环境遮蔽 | `browser/workflow/workflowWorkerMain.source.ts` | W1.1 | L |
| W1.3 | host 引擎：spawn（createBlobWorker）、child RPC 桥、liveAgents 账本、cancel/grace/quiescence、terminate、事件扇出 | `browser/workflow/workflowEngine.ts` | W1.1/1.2 | L |
| W1.4 | dispatch 子代理桥：startWorkflowChild（schema 注入 + StructuredOutputParser + fiber/预算/权限档复用，绕过 completionGate） | `common/unifiedSubAgentDispatch.ts`（增改）+ `common/workflowChildBridge.ts` | W1.1 | M |
| W1.5 | workflow 工具：DESCRIPTION 契约、execute、事件→stream record、NonRetryableToolError 映射；toolset exactNames、系统提示 section、toolExecutionGuard 长超时档、NEVER_PARALLEL_TOOLS 登记 | `browser/providers/tool/workflowTool.ts` + 4 处注册点 | W1.3/1.4 | M |
| W1.6 | 聊天卡片：renderType `WorkflowRun`（pending/running/completed/cancelled/error 5 态 + 折叠持久化 + per-agent 分段进度 + phase 条 + 结果 JSON 卡） | webview `toolDisplayRegistry.ts` + `WorkflowRunCard.tsx` | W1.5 | M |

**M1 验收标准（端到端场景）**
1. 显式要求 workflow → 模型产出合法脚本 → fan-out ≥3 子代理（含 1 个失败项）→ 脚本 filter(Boolean) → 返回 JSON → 助手总结；卡片全程 5 态正确流转
2. Stop 取消 → ≤5s run settled（cancelled）、子代理全部 interrupt、无残留 worker/child；重启窗口后无孤儿
3. `while(true){}` 死循环脚本 → cancel → terminate → UI 恢复可用
4. AGENT_CAP / 语法错 / meta 缺字段 → isError 结果带明确原因 → 模型下一轮自我修正重调成功
5. blob worker 被 CSP 拦截 → 工具拒启 + 明确提示（不降级主线程）

### 1.3 M2 · 画布数据桥（feature flag）

| WS | 任务 | 要点 |
|---|---|---|
| W2.1 | `nodeOutput(stageUid, slot?)` hook + 协议扩展（`node-output{callId,uid,slot}` / `node-output-result` / `node-output-error`） | host 桥接快照查询；查无 uid → fatal INVALID_ARGUMENT（fail-loud） |
| W2.2 | 快照查询代理 | browser 侧 `IMediaSnapshotQueryService` 薄代理（经既有 webview RPC 通道）；SAROS_JSON→json 原值 / TEXT→string / IMAGE·VIDEO→{kind:'media'} |
| W2.3 | 结果归档 | run 完成 → `{kind:'SAROS_JSON', value}` 按锚点 stageUid 写快照总线（走 registerAlias 双前缀合并）；NodeCard OUTPUT 渲染折叠 JSON 卡 |
| W2.4 | UI 联动 | 卡片头部画布徽标（🔗）→ `sarosis.canvas.revealNode` 定位锚点 |

**M2 验收**：画布节点已出图 → Chat 脚本 `nodeOutput()` 取到 media → 子代理消费 → 结果回流画布 OUTPUT 显示 JSON；双向 stageUid 键一致（读写同源断言）。

### 1.4 M3 · 画布编排节点执行语义

| WS | 任务 | 要点 |
|---|---|---|
| W3.1 | `Saros.Agent` 执行器 | isExecutableSpec 放行；prompt=widget/上游 TEXT；输出 SAROS_JSON 快照；复用 startWorkflowChild |
| W3.2 | `Saros.Task` | 复用 TaskDecomposer 分解 → 顺序/并行子 Agent |
| W3.3 | `Saros.IfElse/Switch` | 门节点：读上游 json 判定字段裁剪后续波次（不产生值） |
| W3.4 | `Saros.AskUser` | 暂停波次 → clarify 卡片 → 答复物化 TEXT 继续 |
| W3.5 | 波次混排 | buildParallelExecutionPlan 不变量保持：媒体节点（ComfyUI）与编排节点（child 桥）同波次可混排；类型不符 fail-loud（ErrorBanner，不静默） |

**M3 验收**：纯画布 `Prompt→Agent→IfElse→Agent→End` run 串联正确；类型不符节点报错不串值；波次 barrier 不变量（下游启动时上游快照必在）在混排下依然成立。

### 1.5 M4 · Canvas/Code 双模式（feature flag `dualMode`）

| WS | 任务 | 要点 | 依赖 |
|---|---|---|---|
| W4.1 | **M4a 画布→脚本导出** | buildExecutionPlan 拓扑序 → 生成器（节点→agent()、边→变量、波次→pipeline/parallel、IfElse→if、Group→phase）；产物进 Chat 为可编辑起点；单向不回写 | 画布 spec（可提前做） |
| W4.2 | **M4b 运行时投影** | WorkflowEngineEvent → 只读投影图（agent()→Saros.Agent 🔵projected 节点；并发关系→边；phase→Group）；动态扇出真实呈现；结束保留为运行快照图（stageUid 归档）；chat 卡片「在画布中查看」 | M1 事件流 |
| W4.3 | **M4c 静态子集双向 sync** | 真源=LiteGraph JSON；Code 视图（Monaco）实时 lint 可同步子集（绿色 Canvas Sync 徽标）；AST 解析（acorn）Code→Canvas 重建；越界降级「仅代码」；单侧编辑会话锁 | M3+M4a |
| W4.4 | 切换控件 | 画布标题栏 `Canvas | Code` 分段控件；M4a/b 阶段=导出/投影按钮，M4c=真双视图 | W4.1-3 |

**M4 验收**：见测试用例 M4 组。

### 1.6 观测与运维（贯穿）

- 引擎日志：`[WorkflowEngine]`/`[WorkflowWorker]` 前缀进 ILogService；关键路径（spawn/start/settle/terminate/child RPC）必打
- 指标：run 计数、agentsStarted 分布、cancel 率、error code 分布（复用既有 telemetry 若有）
- delegationLedger 增记 run→children 从属（M1 W1.5 顺带）

---

## 第二部分 · 测试用例设计

### 2.1 测试分层与文件规划（遵循项目惯例）

| 层 | 位置 | runner | 前缀 |
|---|---|---|---|
| 单元（纯函数/协议） | `src/vs/sessions/contrib/agentStudio/test/common/workflow-*.test.ts` | `run-agentstudio-tests.mjs` 系列（可复制临时 runner 跑单文件） | WF-U |
| 单元（browser 侧，需 fake 上下文） | `test/browser/workflow-*.test.ts` | 同上 | WF-B |
| 引擎集成（真 worker + fake dispatch） | `test/browser/workflowEngine.integration.test.ts` | 临时 runner | WF-E |
| E2E（webview/UI 卡片） | `webview/e2e/`（`node e2e/run.mjs`） | webview 子项目 | WF-V |
| M2/M3/M4 专属 | 同上分层，独立文件 | — | WF-C2 / WF-C3 / WF-C4 |

**基线纪律**：所有新文件首跑必须 100% pass 后才合入；browser 全量基线（73 fail/1241 pass）不得新增 fail；不修复存量。

### 2.2 测试基础设施（先建后写用例）

```
test/common/workflowTestInfra.ts
├─ FakeChildPort            可编程 child 工厂：immediate(text|json) / delayed(ms,val) / failSoft(stopReason:'failed')
│                           / failHard(reject 基建故障) / hang(永不 settle) / scripted(按 prompt 匹配脚本)
├─ makeEngineHarness(opts)  → { engine, events[], workersSpawned, terminateCalls }；注入 FakeChildPort、fake timers(grace)
├─ EventRecorder            收集 WorkflowEngineEvent 快照数组（deepStrictEqual 断言用）
├─ scriptOf(body)           生成 {meta, script, args} 最小合法调用体
└─ expectSettled(p, ms)     result 永不 reject 的断言助手（超时=失败）
```

### 2.3 WF-U · 单元用例（common/workflow）

#### U1 类型与协议（protocol.test.ts）

| # | 用例 | 断言 |
|---|---|---|
| U1.1 | 消息联合闭合 | WorkerToHost/HostToWorker 每个枚举值都有 payload map 条目；多余键编译期即错（类型测试） |
| U1.2 | payload 单一真源 | 遍历枚举构造消息字面量，序列化 round-trip 后字段不变 |
| U1.3 | assertNever 穷尽 | 人为加新枚举值 → 编译失败（类型测试，注释说明） |

#### U2 schema 子集校验器（schemaSubset.test.ts）

| # | 用例 | 断言 |
|---|---|---|
| U2.1 | 合法集 | type/properties/required/additionalProperties/items/enum/const/oneOf 任意组合通过 |
| U2.2 | 非法集 | pattern/format/minimum/maximum/multipleOf/minItems/dependencies/$ref/非 object 根 → WorkflowError('UNSUPPORTED_SCHEMA') |
| U2.3 | 非对象 | schema=数组/null/string → INVALID_ARGUMENT |

#### U3 materializeFromRealm（materialize.test.ts — 从 worker 源码提取的纯函数单测）

| # | 用例 | 断言 |
|---|---|---|
| U3.1 | plain JSON 全通过 | 深层嵌套 object/array/number/string/boolean/null（深度 32）原样返回且与输入无引用共享（深拷贝语义） |
| U3.2 | 拒绝函数 | `{f:()=>{}}` → MaterializeError，消息含路径 `$.f` |
| U3.3 | 拒绝 symbol 键/值 | 同上 |
| U3.4 | 拒绝循环引用 | a.b=a → 报循环路径 |
| U3.5 | 拒绝稀疏数组 | `[1,,3]` → 报 sparse（或按实现填充 null——二选一，用例锁定所选语义） |
| U3.6 | 拒绝非有限数 | NaN/Infinity/-Infinity |
| U3.7 | Map/Set/Date/RegExp/类实例 | 全拒（带构造名） |
| U3.8 | 顶层非对象 | `return 42` / `"str"` / `null`（合法标量返回——与 dsh 对齐：raw===undefined→null，其他标量合法） |

#### U4 WorkflowError 分级（types.test.ts）

| # | 用例 | 断言 |
|---|---|---|
| U4.1 | fatal 码表 | SCRIPT_PARSE/INVALID_ARGUMENT/UNSUPPORTED_OPTION/UNSUPPORTED_SCHEMA/AGENT_CAP/ITEM_CAP/AGENT_START/AGENT_RESULT/CANCELLED/RESULT_UNSERIALIZABLE → isFatalWorkflowError===true |
| U4.2 | 不可伪造 | 脚本内 `throw {code:'CANCELLED'}` 构造的普通对象 → isFatalWorkflowError===false（instanceof 判定） |
| U4.3 | 普通子代理失败 | 子代理 soft-fail 不产生 WorkflowError → 组合子内落为 null |

### 2.4 WF-E · 引擎集成用例（真 blob worker + FakeChildPort）

#### E1 正常路径（engine.integration.test.ts）

| # | 用例 | 脚本/设定 | 断言 |
|---|---|---|---|
| E1.1 | 最小 run | `phase('a'); return 1` | result={value:1,stopReason:'completed',agentsStarted:0}；事件序 start→phase→end |
| E1.2 | 单 agent 文本 | `return await agent('hi',{label:'L'})` | FakeChildPort 回 'ok' → value='ok'；事件 agent-start{seq:1,label:'L'}→agent-end{outcome:'completed'} |
| E1.3 | 单 agent schema | FakeChildPort 回合法对象 | value=该对象（非字符串） |
| E1.4 | schema 子代理失败→null | FakeChildPort soft-fail（结构化解析失败） | value=null；agent-end{outcome:'failed'}；run 仍 completed |
| E1.5 | parallel 混合 | 3 thunk：成功/soft-fail/成功 | value=[a,null,c]；stopReason completed |
| E1.6 | pipeline 无 barrier | stage1 延迟 100ms×3 items；stage2 记录进入时间 | item B 的 stage2 开始时间 < item A 的 stage2 结束时间（无 barrier 证据） |
| E1.7 | pipeline stage 抛错 | item2 的 stage1 抛普通 Error | value=[ok,null,null]（item2 跳过 stage2）；其他 item 不受影响 |
| E1.8 | 动态扇出 | `return parallel(args.files.map(f=>()=>agent(f)))` files=5 | 5 个 agent-start；value 长度 5 |
| E1.9 | args 隔离 | 脚本内 `args.x=1` | 引擎侧原 args 对象 x 不变（workerData clone 隔离） |
| E1.10 | log/phase 流 | 交替调用 | 事件顺序与调用序一致；cancel 后 phase/log 不再上报 |

#### E2 失败分级（同文件）

| # | 用例 | 设定 | 断言 |
|---|---|---|---|
| E2.1 | 语法错 | `return {` | 同步抛 SCRIPT_PARSE → 工具 isError；worker 已回收 |
| E2.2 | 非法参数 | `agent(42)` | INVALID_ARGUMENT fatal；run error；已起 agent 数计入 |
| E2.3 | 未知选项 | `agent('p',{effort:'high'})` | UNSUPPORTED_OPTION，消息列出 deferred 列表 |
| E2.4 | 超集 schema | schema 带 pattern | UNSUPPORTED_SCHEMA fatal |
| E2.5 | AGENT_CAP | limits.maxTotalAgents=3，脚本起 4 个 | 第 4 个调用抛 AGENT_CAP；前 3 个 child 已 dispose；run error |
| E2.6 | ITEM_CAP | parallel 4097 thunks | ITEM_CAP fatal |
| E2.7 | 基建故障穿透 | FakeChildPort failHard（reject） | AGENT_RESULT fatal → run error（不是 null！） |
| E2.8 | 返回不可序列化 | `return {f:()=>{}}` | RESULT_UNSERIALIZABLE fatal；run error |
| E2.9 | 并发上限 FIFO | maxConcurrent=2，5 个延迟 agent | 第 3 个 agent-start 时刻 ≥ 第 1 个 agent-end 时刻；完成顺序证明排队 |
| E2.10 | result 永不 reject | 以上全部错误路径 | `await expectSettled(handle.result)` 全部 resolve（无一条 reject） |

#### E3 取消与终止（同文件，fake timers 控制 grace）

| # | 用例 | 设定 | 断言 |
|---|---|---|---|
| E3.1 | cancel 边界 | 2 agent 运行中 cancel | 在跑 child 收到 interrupt；run stopReason='cancelled'；≤grace 内 settle |
| E3.2 | hook 边界死 | cancel 后脚本再调 agent/log/phase | 对应 hook 抛 CANCELLED，脚本死；无 cancel 后事件泄漏 |
| E3.3 | slot waiter reject | maxConcurrent=1，2 个排队中 cancel | 排队者 reject CANCELLED（不是永久挂起） |
| E3.4 | grace 强收 | 脚本 `await new Promise(()=>{})`（parked）+ cancel | grace 到点 force-settle cancelled + terminateCalls=1 |
| E3.5 | 同步死循环 | `while(true){}` + cancel | terminate 收回；run cancelled；测试进程存活（worker 死不连坐） |
| E3.6 | 账本恰好配对（死亡路径） | 3 agent 运行中杀 worker（engine.terminate 模拟 crash） | 对每个已发 agent-start 恰好一个 agent-end（合成 cancelled）；事件序 end 前全部闭合 |
| E3.7 | dispose 幂等 | 连续 dispose()×3 + cancel 后 dispose | worker terminate 恰 1 次；重复调用同 promise |
| E3.8 | 结果与取消竞速 | 脚本 return 与 cancel 几乎同时（delayed 0ms child + 立即 cancel） | 结果必为 cancelled（cancel 先到则不谎报 completed）；重复 20 次无翻转 |
| E3.9 | unhandled rejection 防护 | 脚本 `agent('a'); return 1`（不 await 直接丢） | run completed；worker 不因 dropped promise 崩溃 |
| E3.10 | turn abort 桥接 | simulate toolSignal.abort() | handle.cancel 被调（W1.5 桥接断言） |

#### E4 worker 环境（engine.integration.test.ts 续）

| # | 用例 | 断言 |
|---|---|---|
| E4.1 | 环境遮蔽 | `return typeof fetch` → 'undefined'（XMLHttpRequest/importScripts/Worker 同） |
| E4.2 | 无宿主注入 | `return Object.getOwnPropertyNames(globalThis).sort()` 与白名单差集为空（防未来误注入） |
| E4.3 | crypto 可用 | worker 内 randomUUID 不抛（降级路径单测：无 crypto 时 uid 格式 `uid-…`） |

### 2.5 WF-B · 工具与桥（browser 侧）

#### B1 startWorkflowChild 桥（workflowChildBridge.test.ts，fake dispatch 上下文）

| # | 用例 | 断言 |
|---|---|---|
| B1.1 | 权限档生效 | agentId=code-explorer → excludedTools 含写工具（对齐既有 explore 档断言风格） |
| B1.2 | schema 注入 | 请求带 schema → 子代理 task 文本含 JSON 输出指令；返回 structured=解析对象 |
| B1.3 | 解析失败 | 子代理回非 JSON → stopReason='failed' → handle.result resolve（非 reject）→ worker 侧 null |
| B1.4 | interrupt 传递 | signal abort → fiber interrupt 子代理；dispose 后无泄漏卡片事件 |
| B1.5 | 预算档 | 子代理 IterationBudget 按档初始化（mock 断言参数） |
| B1.6 | 卡片事件 | 事件进 batchGroup；label/phase 透传到 SubAgentEvent |

#### B2 workflow 工具注册（workflowTool.test.ts）

| # | 用例 | 断言 |
|---|---|---|
| B2.1 | toolset 命中 | getToolsetForTool('workflow')==='workflow'；_filterToolsForLLM 高优先可见 |
| B2.2 | NEVER_PARALLEL | 'workflow' ∈ NEVER_PARALLEL_TOOLS（import 常量断言） |
| B2.3 | 超时档 | getTimeoutForTool('workflow')===DELEGATION_TOOL_TIMEOUT_MS 档 |
| B2.4 | isError 映射 | 引擎 error run → 工具结果 isError=true、文本含 error code |
| B2.5 | 结果截断 | value JSON >maxResultChars → 截断提示（含剩余字符数） |
| B2.6 | meta 校验失败同步抛 | 缺 name/description → execute 抛（非挂起）；模型可见原因 |
| B2.7 | CSP 拦截降级 | createBlobWorker mock null → 工具返回明确「workflow 不可用」错误（fail-loud），不尝试主线程 |
| B2.8 | dispose 必达 | execute 成功/失败两路 → engine.dispose 恰好调用一次（finally 断言） |

### 2.6 WF-V · 聊天卡片 UI（webview e2e）

| # | 用例 | 断言 |
|---|---|---|
| V1 | 5 态渲染 | 依次投事件序列 → 卡片 class/data-state 对应 pending→running→completed；cancelled/error 分支独立 |
| V2 | 折叠持久化 | 展开→折叠→store 序列化 round-trip → 态保持 |
| V3 | 分段进度 | 12 agent 混合结局 → 段数=12；done/running/failed/pending 类名比例正确 |
| V4 | 失败徽标 | failed agent 行含「failed → null」徽标；卡片整体非 error 态 |
| V5 | 结果 JSON 卡 | completed → 折叠 JSON 渲染；复制按钮写剪贴板（jsdom mock） |
| V6 | 单一动画源 | running 态 DOM 内 animated 元素 ≤2 处（chip dot + 运行段） |
| V7 | toolDisplayRegistry | name='workflow' → {emoji:'🔀', renderType:'WorkflowRun'} |

### 2.7 WF-C2 · M2 画布桥用例

| # | 用例 | 断言 |
|---|---|---|
| C2.1 | nodeOutput json/text/media 三态 | 快照 mock 三类 → 脚本内分别得到 原值/string/{kind:'media',url,mime} |
| C2.2 | 查无 uid fatal | 不存在 stageUid → INVALID_ARGUMENT，run error（不静默 undefined） |
| C2.3 | slot 越界 | slot=5 超输出数 → fatal（消息含实际槽数） |
| C2.4 | 结果归档键 | run 完成 → 快照 store 断言 `uid-<anchor>:output:0` 存在且 kind=SAROS_JSON、值=return value |
| C2.5 | 别名合并 | nodeId 弹窗路径与 uid run 路径先后写 → byNode(nodeId) 与 byNode(uid) 均可读（既有 pruneAliases 安全阀不误删） |
| C2.6 | 大 JSON 引用 | value 2MB → RPC 不全量拷贝超时（走引用/分片，按实现锁定） |
| C2.7 | 徽标定位 | 点击 🔗 → revealNode 命令携带锚点 stageUid（spy 断言） |

### 2.8 WF-C3 · M3 编排节点用例

| # | 用例 | 断言 |
|---|---|---|
| C3.1 | Agent 节点执行 | 画布 run → startWorkflowChild 被调（prompt=上游 TEXT）；输出 SAROS_JSON 快照 |
| C3.2 | 串联不变量 | 混排图（Agent→ComfyTV 生成→Agent）→ 下游启动时上游快照已入 store（时序断言） |
| C3.3 | IfElse 裁剪 | 判定字段 false → 该分支节点不执行、不出现在时间线 |
| C3.4 | 类型不符 fail-loud | TEXT 输出接 SAROS_JSON 输入口 → 节点 ErrorBanner + run 该节点 failed，不静默传值 |
| C3.5 | 上游缺失 | 未运行上游 → 明确「上游节点 X 尚无输出」错误（不 undefined） |
| C3.6 | AskUser 暂停/恢复 | run 到 AskUser 挂起 → clarify 答复 → 物化 TEXT → 下一波次继续 |
| C3.7 | Subflow 展平保持 | Subflow 内含编排节点 → flatten 后计划正确（既有机制回归） |

### 2.9 WF-C4 · M4 双模式用例

#### M4a 导出（canvasExport.test.ts）

| # | 用例 | 断言 |
|---|---|---|
| C4.1 | 线性图 | A→B→C（Agent 节点）→ 脚本含 3 个串行 agent()，变量名链对应边 |
| C4.2 | 菱形 | A→(B,C)→D → 生成 parallel([…B,C…]) 后传 D |
| C4.3 | IfElse | 导出为 if 语句块，两分支节点正确入块 |
| C4.4 | Group→phase | 分组节点导出为 phase(title) 包裹 |
| C4.5 | 媒体节点占位 | ComfyTV 节点导出为注释节点（M3 前媒体节点不可脚本执行——占位+TODO 注释） |
| C4.6 | 脚本可执行 | 导出产物直接喂引擎（FakeChildPort）→ completed（生成器不自产语法错） |

#### M4b 投影（runtimeProjection.test.ts）

| # | 用例 | 断言 |
|---|---|---|
| C4.7 | 事件→图重建 | 6 agent（2 并行波次+1 失败）事件回放 → 投影图节点数=6、边表达并发归属、失败节点红态 |
| C4.8 | 动态扇出呈现 | args.files=5 的 map 扇出 → 投影图 5 节点（静态画布做不到的证据用例） |
| C4.9 | 只读保护 | 投影节点 attempts 写操作 → 拒绝（readonly 标记断言） |
| C4.10 | 归档 | run 结束 → 投影图随 stageUid 入快照；重开窗口可还原 |

#### M4c 双向 sync（dualSync.test.ts）

| # | 用例 | 断言 |
|---|---|---|
| C4.11 | 子集识别 | 固定形态脚本（agent/pipeline/parallel/phase/if 直调）→ lint 绿（Canvas Sync 徽标数据源） |
| C4.12 | 越界识别 | 含 for/while/动态 items/高阶包裹 → lint 灰（仅代码） |
| C4.13 | Code→Canvas 重建 | 子集脚本 → AST 提取 → nodes/edges 与预期图 deepEqual |
| C4.14 | 漏判不误判 | `const a=agent; a('x')`（间接调用）→ 判为越界（从严），不产生半成品图 |
| C4.15 | Canvas→Code→Canvas round-trip | 画布导出→脚本→重建 → 图同构（节点/边集合相等；位置不要求） |
| C4.16 | 会话锁 | Code 编辑中 → 画布操作被拒并提示；反向同 |
| C4.17 | 越界拒绝回写 | 仅代码模式脚本尝试切 Canvas → 阻止 + 原因提示；代码内容不丢 |
| C4.18 | 真源裁决 | 两侧模拟并发写（锁旁路）→ 以 LiteGraph JSON 为准，脚本重生成 |

### 2.10 回归与 CI 纪律

| 项 | 要求 |
|---|---|
| 新增测试文件 | `run-workflow-tests.mjs` 临时 runner 全绿后才合入；browser 全量不新增 fail |
| 编译 | `npm run compile-check-ts-native` 零错（worker source 字符串单独 `new Function` 编译校验用例 WF-U E1.1 前置） |
| webview | 改卡片后 `cd webview && npx tsc --noEmit` 只看新增文件；`node e2e/run.mjs` 过 V 组 |
| 性能 | E2.9 并发压测（50 agent FakeChild）在 CI 超时预算内；worker spawn→ready P95 < 150ms（本地基准，不进 CI 硬门槛） |
| 灰度 | M2/M3/M4 各 feature flag 关闭下跑全量（无新路径执行，证明开关隔离） |

### 2.11 用例总数与覆盖映射

| 组 | 数量 | 覆盖设计章节 |
|---|---|---|
| U（单元） | 17 | §3.2.1/3.2.2、§1.5 失败分级 |
| E（引擎集成） | 26 | §3.2.3/3.2.4、§3.4 全部 |
| B（工具/桥） | 14 | §3.2.5/3.2.6 |
| V（卡片 UI） | 7 | 报告 §8 状态机 |
| C2/C3/C4 | 7+7+18 | §3.3.2/3.3.3、§5.3 |
| **合计** | **89** | — |

---

## 第三部分 · 执行顺序建议（4 个 PR 系列）

1. **PR-1**：W1.1 + U1/U2/U4 用例（纯类型/纯函数，零运行时风险）→ 合入
2. **PR-2**：测试基础设施 + W1.2/1.3 + E1-E4（引擎闭环，FakeChildPort 隔离）
3. **PR-3**：W1.4/1.5 + B1/B2 + E3.10（接入真实 dispatch，feature flag `sessions.agentStudio.workflow.enabled`）
4. **PR-4**：W1.6 + V 组（UI 收尾，M1 上线）
5. **PR-5+**：M2（W2.x + C2）→ M3（W3.x + C3）→ M4a（W4.1 + C4.1-6）→ M4b（W4.2 + C4.7-10）→ M4c（W4.3/4.4 + C4.11-18）

每个 PR 系列独立可回滚（flag 或纯增量）；M4c 放最后且独立 flag——它是唯一引入「双编辑器」复杂度的部分。
