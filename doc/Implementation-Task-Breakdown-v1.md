# Sarosis Agents Client — 分阶段实现与测试任务文档

> **版本**: v1.0  
> **日期**: 2026-05-11  
> **基于**: Four-Layer-Architecture-Framework.md v1.1  
> **目标**: 将四层架构设计拆分为可独立实现、独立测试、独立合并的原子任务

---

## 总体原则

### 实施策略
1. **每个任务可独立 PR** — 确保任意任务完成后代码可编译、可合并
2. **测试前置** — 接口定义完成时即编写测试桩，实现时补全断言
3. **渐进增强** — 先实现最小可用版本(L1)，再逐步提升到生产级(L3)
4. **并行友好** — 无依赖的任务可同时推进

### Level 定义
| Level | 含义 | 标准 |
|-------|------|------|
| L0 | 接口定义 | `.ts` 文件存在，类型完整，编译通过 |
| L1 | 空壳实现 | DI 可注入，方法返回空/默认值 |
| L2 | 功能实现 | 核心路径可用，无 edge case 处理 |
| L3 | 生产就绪 | 错误处理、日志、超时、重试、指标完备 |

### 通用验收检查表（每个任务均适用）
- [ ] TypeScript 编译通过 (`npm run compile`)
- [ ] 无循环依赖 (`madge --circular`)
- [ ] 新增接口有 JSDoc 注释
- [ ] DI 注册/绑定正确（contribution 文件更新）
- [ ] 现有功能不退化（冒烟测试通过）
- [ ] 单元测试覆盖率 ≥ 80%（核心路径）

---

## Phase 0: 基础整理（1 周）

### P0-1: 统一 IChatStreamDelta 定义
**目标**: 消除 `common/providers.ts` 和 `common/agentStudio.ts` 中 IChatStreamDelta 的重复定义

| 属性 | 值 |
|------|-----|
| 优先级 | P0 |
| 预估工时 | 0.5d |
| 依赖 | 无 |
| 产出文件 | `common/protocol.ts` (新建) |
| Level | L0 → L2 |

**任务步骤**:
1. 创建 `common/protocol.ts`，统一所有流事件类型定义
2. 将 `IChatStreamDelta`、`StreamDeltaType`、`ITurnState` 等移入
3. 原位置改为 re-export（保持向后兼容）
4. 确保所有 import 路径更新

**验收标准**:
- [ ] `common/protocol.ts` 为唯一定义源
- [ ] 无任何重复类型定义
- [ ] 编译通过，无 breaking change

**测试策略**:
- 编译验证 + grep 确认无重复定义

---

### P0-2: 创建测试基础设施
**目标**: 为后续阶段建立统一测试框架

| 属性 | 值 |
|------|-----|
| 优先级 | P0 |
| 预估工时 | 1d |
| 依赖 | 无 |
| 产出文件 | `test/` 下新建测试目录结构 |
| Level | L2 |

**任务步骤**:
1. 创建 `test/sessions/contrib/agentStudio/common/` 目录
2. 创建 `test/sessions/contrib/agentStudio/browser/` 目录
3. 编写 Mock Provider 基础设施 (`mockProviders.ts`)
4. 编写 Mock OS Service (`mockAgentOS.ts`)
5. 编写测试工具函数 (`testUtils.ts`)

**验收标准**:
- [ ] Mock 工厂可创建任意 Provider 类型的 Mock 实例
- [ ] 测试命令 `npm run test -- --grep "agentStudio"` 可执行

**测试策略**:
- 元测试：验证 Mock 工厂本身能正确创建 Mock

---

### P0-3: 清理 AgentChatService 兼容层
**目标**: 明确 AgentChatService 的过渡定位，标记 deprecated

| 属性 | 值 |
|------|-----|
| 优先级 | P0 |
| 预估工时 | 0.5d |
| 依赖 | 无 |
| 产出文件 | `browser/agentChatService.ts` (修改) |
| Level | L2 |

**任务步骤**:
1. 为 `IAgentChatService` 添加 `@deprecated` JSDoc 标记
2. 内部调用全部委托到 `IAgentDriverService`
3. 添加迁移注释指引新代码使用 Driver

**验收标准**:
- [ ] 所有方法调用链转到 Driver
- [ ] 编译器显示 deprecated 警告

**测试策略**:
- 现有调用方行为不变（回归测试）

---

## Phase 1: OS 层骨架（2 周）

### P1-1: 重构 IAgentOSService 接口（接口规范化）
**目标**: 确保 OS 接口严格为"注册中心"，剥离执行逻辑

| 属性 | 值 |
|------|-----|
| 优先级 | P1 |
| 预估工时 | 1d |
| 依赖 | P0-1 |
| 产出文件 | `common/agentOS.ts` (修改) |
| Level | L0 |

**任务步骤**:
1. 审查 `IAgentOSService` 接口，确认仅包含注册/查询方法
2. 将 `executeAgentTurn()` 相关逻辑标记为内部方法（非接口暴露）
3. 补充 JSDoc，明确每个方法的语义

**验收标准**:
- [ ] 接口中无 `execute*` 方法
- [ ] JSDoc 完整描述每个方法

**测试策略**:
- 编译验证 + 接口一致性检查

---

### P1-2: SlotRegistry 能力槽注册表增强
**目标**: 完善现有 SlotRegistry，支持全部 7 个槽位的优先级排序

| 属性 | 值 |
|------|-----|
| 优先级 | P1 |
| 预估工时 | 1.5d |
| 依赖 | P1-1 |
| 产出文件 | `browser/slotRegistry.ts` (修改) |
| Level | L1 → L2 |

**任务步骤**:
1. 确认 7 个槽位（含 Model、Kanban）均在 Registry 中注册
2. 实现优先级排序逻辑（priority 字段 + fallback 链）
3. 添加 `onDidChangeSlot` 事件通知
4. 实现 `getProviderChain(slot)` 获取 fallback 序列

**验收标准**:
- [ ] 7 个槽位均有对应的注册/查询/卸载方法
- [ ] 注册多个同槽 Provider 时按优先级排序
- [ ] 卸载后自动切换到次高优先级

**测试策略**:
```
测试用例组:
1. 注册单个 Provider → getActive 返回它
2. 注册多个 → 按优先级排序
3. 卸载最高优先级 → 自动切换
4. 全部卸载 → getActive 返回 undefined
5. 事件通知在变更时触发
```

---

### P1-3: Provider 接口标准化（7 个 Slot 接口）
**目标**: 确保 7 个 Provider 接口定义完整、统一风格

| 属性 | 值 |
|------|-----|
| 优先级 | P1 |
| 预估工时 | 2d |
| 依赖 | P1-1 |
| 产出文件 | `common/providers.ts` (修改) |
| Level | L0 |

**任务步骤**:
1. 统一所有 Provider 接口继承 `IBaseProvider`（id + displayName + dispose）
2. 补充 IKanbanProvider 完整接口
3. 为每个接口添加完整 JSDoc
4. 增加 `IProviderMetadata` 类型（version, capabilities, healthCheck）

**验收标准**:
- [ ] 7 个接口均继承 `IBaseProvider`
- [ ] 每个方法有 JSDoc
- [ ] 编译通过

**测试策略**:
- 类型编译验证
- 编写 TypeScript 类型测试（确保接口可正确 implement）

---

### P1-4: 内置 Provider 空壳实现（L1）
**目标**: 确保每个内置 Provider 可被 DI 注入，方法返回默认值

| 属性 | 值 |
|------|-----|
| 优先级 | P1 |
| 预估工时 | 2d |
| 依赖 | P1-3 |
| 产出文件 | `browser/providers/` 各文件 |
| Level | L1 |

**任务步骤**:
1. 每个 Provider 实现类确保所有接口方法有空壳返回
2. DI 注册到 contribution 文件
3. SlotRegistry 启动时自动加载内置 Provider

**验收标准**:
- [ ] 启动后 `getActiveXxxProvider()` 不为 undefined（除 Model 外，Model 需配置）
- [ ] 调用方法不抛异常（返回空数组/默认对象）

**测试策略**:
```
测试用例组:
1. DI 容器可解析所有 Provider 服务
2. 所有方法调用返回有效默认值
3. dispose() 不抛异常
```

---

### P1-5: IAgentOSService 实现层重构
**目标**: 将 `agentOSService.ts` 中的执行逻辑分离，使其成为纯注册中心

| 属性 | 值 |
|------|-----|
| 优先级 | P1 |
| 预估工时 | 2d |
| 依赖 | P1-2, P1-4 |
| 产出文件 | `browser/agentOSService.ts` (修改) |
| Level | L2 |

**任务步骤**:
1. 将 `executeAgentTurn()` 逻辑迁移到 Driver 层
2. 将 `_executeWithFallback()` 逻辑迁移到 Driver ErrorRecovery
3. OS 实现层仅保留 register/unregister/getActive 等纯注册逻辑
4. 添加 `onDidChangeCapabilities` 事件发射

**验收标准**:
- [ ] `AgentOSService` 无任何 LLM 调用逻辑
- [ ] Driver 层接管所有执行编排
- [ ] 现有功能不退化（端到端测试通过）

**测试策略**:
```
测试用例组:
1. register → 能力变更事件触发
2. unregister → 能力变更事件触发
3. getActive → 返回最高优先级 Provider
4. hasCapability → 正确反映已注册槽位
```

---

## Phase 2: Driver 层实现（3 周）

### P2-1: Driver 9 组件拆分 — TurnManager
**目标**: 从 agentDriverService.ts 提取独立的 TurnManager

| 属性 | 值 |
|------|-----|
| 优先级 | P2 |
| 预估工时 | 1.5d |
| 依赖 | P1-5 |
| 产出文件 | `browser/driver/turnManager.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 创建 `browser/driver/` 目录
2. 提取 Turn 状态机逻辑: Pending → Running → Completed/Failed/Cancelled
3. 实现 `createTurn()`, `getTurnState()`, `completeTurn()`, `failTurn()`, `cancelTurn()`
4. 添加状态变更事件 (`onDidChangeTurnState`)
5. 在 agentDriverService.ts 中委托给 TurnManager

**验收标准**:
- [ ] Turn 状态转换正确（不允许非法转换如 Completed → Running）
- [ ] agentDriverService.ts 中 Turn 逻辑全部替换为 TurnManager 调用

**测试策略**:
```
测试用例组:
1. 创建 Turn → 状态为 Pending
2. start() → Running
3. complete() → Completed
4. fail() → Failed
5. cancel() 在 Running 状态 → Cancelled
6. cancel() 在 Completed 状态 → 抛异常
7. 并发创建多个 Turn → 各自独立管理
8. 事件通知在每次状态变更时触发
```

---

### P2-2: Driver 9 组件拆分 — PipelineBuilder
**目标**: 实现动态管线构建器，支持 3 种预置管线

| 属性 | 值 |
|------|-----|
| 优先级 | P2 |
| 预估工时 | 2d |
| 依赖 | P2-1 |
| 产出文件 | `browser/driver/pipelineBuilder.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 定义 `IPipelineConfig` 和 `IPipelineStep` 类型
2. 实现 3 种预置管线: `SIMPLE_CHAT`, `FULL_AGENT`, `RAG`
3. 实现管线选择策略（基于 Agent 配置 + 当前可用能力自动选择）
4. 支持运行时覆盖管线 (`setPipelineConfig()`)

**验收标准**:
- [ ] 3 种预置管线可正确生成步骤序列
- [ ] 无可用 Planning/Tool/Memory Provider 时自动降级到 SIMPLE_CHAT
- [ ] 自定义管线可覆盖默认行为

**测试策略**:
```
测试用例组:
1. 全部 Provider 就绪 → FULL_AGENT
2. 仅 Model → SIMPLE_CHAT
3. Model + Memory + Retrieval → RAG
4. 自定义覆盖 → 使用自定义
5. 管线步骤中 optional=true 的 slot 无 Provider → 自动跳过
```

---

### P2-3: Driver 9 组件拆分 — SlotOrchestrator
**目标**: 实现按管线步骤顺序调用 OS Slots 的编排器

| 属性 | 值 |
|------|-----|
| 优先级 | P2 |
| 预估工时 | 2d |
| 依赖 | P2-2, P1-5 |
| 产出文件 | `browser/driver/slotOrchestrator.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 接收 PipelineConfig，按 steps 顺序执行
2. 对每个 step 调用 OS 层对应的 getActiveXxxProvider()
3. 实现 `parallel` 步骤类型（Promise.all）
4. 实现 `conditional` 步骤类型
5. optional slot 无 Provider 时静默跳过
6. 输出 StepStart/StepEnd 事件

**验收标准**:
- [ ] 顺序步骤按序执行
- [ ] 并行步骤并发执行
- [ ] 条件步骤根据条件选择分支
- [ ] optional slot 无 Provider 时不报错

**测试策略**:
```
测试用例组:
1. [Memory, Model, Memory] → 3步顺序执行
2. [parallel(Tool, Retrieval)] → 并行
3. [conditional(hasMemory, Memory, skip)] → 条件分支
4. optional slot 无 Provider → 跳过
5. 非 optional slot 无 Provider → 报错
6. 步骤执行期间取消 → 立即停止
```

---

### P2-4: Driver 9 组件拆分 — LoopEngine
**目标**: 实现 Plan → Act → Observe → Reflect 的 Agent Loop 引擎

| 属性 | 值 |
|------|-----|
| 优先级 | P2 |
| 预估工时 | 2.5d |
| 依赖 | P2-3 |
| 产出文件 | `browser/driver/loopEngine.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 实现 Agent Loop 状态机: Plan → Act → Observe → Reflect → (继续/结束)
2. 集成 `IterationBudget` 控制循环次数
3. 支持 `builtin` 模式（内部循环）和 `delegated` 模式（委托 ExecutionProvider）
4. Loop 内调用 Model.chat() + Tool.executeTool()
5. Observe 步骤收集工具结果
6. Reflect 步骤判断是否终止（LLM 决策 / 预算耗尽 / 无工具调用）

**验收标准**:
- [ ] 基本循环：问题 → 调工具 → 得到结果 → 生成回答
- [ ] 迭代预算耗尽自动终止
- [ ] 无工具调用时直接终止
- [ ] delegated 模式正确转发到 ExecutionProvider

**测试策略**:
```
测试用例组:
1. 简单问答（无工具）→ 1次迭代后终止
2. 1次工具调用 → 2次迭代
3. 连续3次工具调用 → 4次迭代
4. 达到预算上限 → 强制终止 + 注入提示
5. delegated 模式 → 委托 ExecutionProvider
6. 循环中取消 → 立即停止 + 已完成步骤保留
```

---

### P2-5: Driver 9 组件拆分 — StreamController
**目标**: 实现流式输出管道，含背压控制和帧节流

| 属性 | 值 |
|------|-----|
| 优先级 | P2 |
| 预估工时 | 1.5d |
| 依赖 | P2-1 |
| 产出文件 | `browser/driver/streamController.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 实现 AsyncIterableQueue（生产者-消费者模型）
2. 实现 16ms 帧节流（文本合并）
3. 背压检测（消费者读取速度 < 生产者产出速度时暂停上游）
4. 多路复用（tool_start/tool_end 与 text 流交错）
5. 流结束时发送 `done` 事件

**验收标准**:
- [ ] 文本连续流 16ms 内合并为一帧
- [ ] 背压触发时上游暂停
- [ ] 多工具调用并行时流事件正确交错

**测试策略**:
```
测试用例组:
1. 连续快速 push text → 消费端收到合并帧
2. 背压场景 → 生产者等待
3. push tool_start + text + tool_end → 顺序正确
4. 取消时 → 流立即关闭
5. 异常时 → push error event + 流关闭
```

---

### P2-6: Driver 9 组件拆分 — ErrorRecovery
**目标**: 实现 5 种错误恢复策略

| 属性 | 值 |
|------|-----|
| 优先级 | P2 |
| 预估工时 | 1.5d |
| 依赖 | P2-3 |
| 产出文件 | `browser/driver/errorRecovery.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 定义 `ErrorRecoveryAction` 枚举: Abort, Retry, Skip, Fallback, AskUser
2. 将 agentOSService 中的 `_executeWithFallback()` 迁移至此
3. 实现重试逻辑（指数退避 + 最大重试次数）
4. 实现 Fallback 逻辑（切换到备用 Provider/模型）
5. 实现 AskUser（通过 IChatStreamDelta 向 UI 发送确认请求）
6. Middleware 可注入自定义错误处理策略

**验收标准**:
- [ ] Retry: 最多重试 3 次，每次间隔指数增长
- [ ] Fallback: 切换到备用模型列表中的下一个
- [ ] Skip: 标记步骤跳过，继续管线
- [ ] Abort: 立即终止 Turn，状态 → Failed
- [ ] AskUser: 发送事件到 UI，等待用户选择

**测试策略**:
```
测试用例组:
1. 网络超时 → Retry 3次 → 成功
2. 网络超时 → Retry 3次 → 全失败 → Fallback
3. Fallback 3个模型全失败 → Abort
4. 非关键步骤失败 → Skip
5. 指数退避时间正确（100ms, 200ms, 400ms）
6. AskUser → UI 收到事件 → 用户选择 Retry → 重试
```

---

### P2-7: Driver 9 组件拆分 — CancellationHub
**目标**: 实现令牌传播和超时自动取消

| 属性 | 值 |
|------|-----|
| 优先级 | P2 |
| 预估工时 | 1d |
| 依赖 | P2-1 |
| 产出文件 | `browser/driver/cancellationHub.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 基于 VSCode CancellationTokenSource 封装
2. 实现层级取消令牌（Turn → Step → SubAgent）
3. 超时自动取消（从 IPipelineConfig.timeoutMs 读取）
4. 用户取消传播（cancelTurn → 所有子令牌取消）

**验收标准**:
- [ ] 取消 Turn → 所有进行中的 Step 收到 cancel 信号
- [ ] 超时到达 → 自动取消
- [ ] 子 Agent 独立超时（不影响父 Turn）

**测试策略**:
```
测试用例组:
1. cancelTurn → 子令牌全部 cancelled
2. 300s 超时 → 自动取消
3. 子Agent 5min 超时 → 不影响父 Turn
4. 已完成 Turn 调用 cancel → 无效果
```

---

### P2-8: Driver 9 组件拆分 — StateManager
**目标**: 实现 Turn/Session 状态持久化与垃圾回收

| 属性 | 值 |
|------|-----|
| 优先级 | P2 |
| 预估工时 | 1d |
| 依赖 | P2-1 |
| 产出文件 | `browser/driver/stateManager.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 实现内存状态 Map（TurnId → TurnState）
2. 实现 Session 级别状态聚合
3. GC 策略：已完成 Turn 超过 1h 后清理
4. 状态可选持久化到文件（用于 crash recovery）

**验收标准**:
- [ ] getTurnState 正确返回当前状态
- [ ] 1h 后自动 GC 已完成 Turn
- [ ] Session 级聚合统计正确（total/completed/failed）

**测试策略**:
```
测试用例组:
1. 创建多个 Turn → getAll 返回完整列表
2. 完成 Turn + 模拟时间推进 → GC 清理
3. Session 统计正确
4. 持久化 → 重启后恢复
```

---

### P2-9: Driver 组装 — AgentDriverService 重构
**目标**: 将提取后的 9 组件组装回 AgentDriverService

| 属性 | 值 |
|------|-----|
| 优先级 | P2 |
| 预估工时 | 2d |
| 依赖 | P2-1 ~ P2-8 全部 |
| 产出文件 | `browser/agentDriverService.ts` (重大重构) |
| Level | L2 |

**任务步骤**:
1. AgentDriverService 改为 Facade 角色，DI 注入 9 组件
2. `executeTurn()` 编排: TurnManager → PipelineBuilder → SlotOrchestrator → StreamController
3. 注册 Middleware 扩展点
4. 接入 ErrorRecovery 和 CancellationHub
5. 确保对外接口不变

**验收标准**:
- [ ] 对外 API 不变（IAgentDriverService 接口兼容）
- [ ] 内部逻辑由 9 组件协作完成
- [ ] 完整端到端流程：用户消息 → 流式输出

**测试策略**:
```
集成测试:
1. SIMPLE_CHAT 管线端到端 → 返回模型输出
2. FULL_AGENT 管线端到端 → Memory + Planning + Loop + Memory
3. 中途取消 → 正确停止 + 状态 Cancelled
4. 模型报错 → ErrorRecovery 触发 → Retry/Fallback
5. 超时 → CancellationHub 自动取消
```

---

### P2-10: Middleware 预置实现
**目标**: 实现 4 个预置 Middleware

| 属性 | 值 |
|------|-----|
| 优先级 | P2 |
| 预估工时 | 1.5d |
| 依赖 | P2-9 |
| 产出文件 | `browser/driver/middleware/` (新建目录) |
| Level | L2 |

**任务步骤**:
1. `LoggingMiddleware` — 记录 Turn/Step 起止 + 耗时
2. `RateLimitMiddleware` — 限制 TPS + Token/min
3. `MetricsMiddleware` — 采集 Token 用量、延迟、成功率
4. `ValidationMiddleware` — 输入内容校验（长度、格式）

**验收标准**:
- [ ] 4 个 Middleware 可独立注册
- [ ] 洋葱模型执行顺序正确（before 正序，after 逆序）

**测试策略**:
```
测试用例组:
1. LoggingMiddleware → 验证日志输出格式
2. RateLimitMiddleware → 超限时抛 RateLimitError
3. MetricsMiddleware → 验证指标采集数值正确
4. ValidationMiddleware → 超长输入拒绝
5. 多 Middleware 组合 → 洋葱模型顺序
```

---

## Phase 3: Model 插件化（2 周，∥ Phase 2）

### P3-1: IModelProvider 抽象层完善
**目标**: 完善 Model Provider 接口，支持模型列表、认证状态、动态切换

| 属性 | 值 |
|------|-----|
| 优先级 | P3 |
| 预估工时 | 1d |
| 依赖 | P1-3 |
| 产出文件 | `common/providers.ts` (修改 Model 部分) |
| Level | L0 |

**任务步骤**:
1. 补充 `IModelInfo` 类型（id, name, provider, maxTokens, capabilities, pricing）
2. 补充 `IAuthStatus` 类型（authenticated, expiresAt, user）
3. 补充 `IChatRequest` 类型（messages, model, temperature, tools, maxTokens）
4. 添加 `getTokenCount(text)` 方法

**验收标准**:
- [ ] 接口定义完整覆盖模型交互需求
- [ ] 编译通过

**测试策略**:
- 类型编译验证

---

### P3-2: Knot AG-UI ModelProvider 抽取
**目标**: 将当前内联的 Knot 调用逻辑抽取为标准 IModelProvider 实现

| 属性 | 值 |
|------|-----|
| 优先级 | P3 |
| 预估工时 | 3d |
| 依赖 | P3-1, P1-2 |
| 产出文件 | `browser/providers/model/knotModelProvider.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 从 agentOSService.ts 中提取 Knot HTTP 调用逻辑
2. 实现 `IModelProvider` 接口完整方法
3. 处理 Knot AG-UI WebSocket/HTTP 协议
4. 实现 `listModels()` — 从 Knot API 获取可用模型
5. 实现 `chat()` — 返回 `AsyncIterable<IChatStreamDelta>`
6. 向 SlotRegistry 注册自身

**验收标准**:
- [ ] 通过 SlotRegistry 获取 → 可正常调用 chat()
- [ ] 流式输出正确转换为 IChatStreamDelta
- [ ] listModels() 返回真实可用模型列表

**测试策略**:
```
测试用例组:
1. 正常对话 → 流式返回 text + done
2. 模型列表 → 返回有效列表
3. Token 过期 → getAuthStatus 返回 unauthenticated
4. 网络错误 → 抛 AgentOSError
5. 取消请求 → 流中止
```

---

### P3-3: DirectLLM ModelProvider（多厂商直连）
**目标**: 实现直接连接 OpenAI/Anthropic/Ollama API 的 ModelProvider

| 属性 | 值 |
|------|-----|
| 优先级 | P3 |
| 预估工时 | 3d |
| 依赖 | P3-1, P1-2 |
| 产出文件 | `browser/providers/model/directLLMProvider.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 实现统一适配层，支持 OpenAI-compatible API
2. 支持 Anthropic Messages API
3. 支持 Ollama local API
4. 配置化选择后端（`saros.directllm.backend`）
5. 各后端的流式响应统一转换为 IChatStreamDelta

**验收标准**:
- [ ] OpenAI GPT-4o 对话成功
- [ ] Anthropic Claude 对话成功
- [ ] Ollama 本地模型对话成功
- [ ] 3 种后端都能正确返回流式输出

**测试策略**:
```
测试用例组:
1. OpenAI 兼容 API → 正确解析 SSE 流
2. Anthropic API → 正确解析事件流
3. Ollama API → 正确解析 NDJSON 流
4. 无效 API Key → 认证错误
5. 模型不存在 → 明确错误信息
```

---

### P3-4: 模型选择器 UI（WebView）
**目标**: 在 WebView 中实现模型选择下拉/面板

| 属性 | 值 |
|------|-----|
| 优先级 | P3 |
| 预估工时 | 2d |
| 依赖 | P3-2 |
| 产出文件 | `webview/src/features/modelSelector/` (新建) |
| Level | L2 |

**任务步骤**:
1. UI 组件：Provider 分组下拉菜单
2. 每个模型展示：名称 + Provider 来源 + 能力标签 + 定价
3. messageProtocol 新增 `getModelList()` / `selectModel()` 方法
4. Host 端处理：将选择传递给 OS 层 `setActiveModelSelection()`

**验收标准**:
- [ ] UI 正确展示所有可用模型（按 Provider 分组）
- [ ] 选择模型后立即生效
- [ ] 当前选中状态正确高亮
- [ ] 新 Provider 注册时列表自动刷新

**测试策略**:
- 手动 E2E 测试（WebView 渲染验证）
- messageProtocol 单元测试

---

## Phase 4: 工作区 + 实例管理（3 周）

### P4-1: IWorkspaceRegistry 实现
**目标**: 实现工作区注册表，管理工作区生命周期

| 属性 | 值 |
|------|-----|
| 优先级 | P4 |
| 预估工时 | 2d |
| 依赖 | P2-9 |
| 产出文件 | `common/workspaceRegistry.ts` + `browser/workspaceRegistryService.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 定义 `IWorkspaceRegistry` 接口 + `IWorkspaceContext`
2. 每个 WorkspaceContext 持有独立的 OS + Driver + QuotaGuard
3. 工作区打开时自动注册，关闭时卸载
4. 添加 `onDidRegister` / `onDidUnregister` 事件

**验收标准**:
- [ ] 打开工作区 → 自动创建 WorkspaceContext
- [ ] 关闭工作区 → dispose 所有服务 + 从 Map 移除
- [ ] 多工作区并行 → 各自独立、互不干扰

**测试策略**:
```
测试用例组:
1. register → activeWorkspaces 包含
2. unregister → activeWorkspaces 不包含
3. 重复 register → 幂等（不创建新实例）
4. unregister → dispose 被调用
5. getWorkspace(不存在的ID) → undefined
```

---

### P4-2: IQuotaGuard 实现
**目标**: 实现本地限流/预算管理

| 属性 | 值 |
|------|-----|
| 优先级 | P4 |
| 预估工时 | 1.5d |
| 依赖 | P4-1 |
| 产出文件 | `browser/quotaGuard.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. Token 预算管理（每工作区独立配额）
2. API 调用频率限制（TPS + TPM）
3. 预算告警（剩余 < 20%）
4. 预算耗尽时阻止新 Turn

**验收标准**:
- [ ] Token 扣减正确
- [ ] 超限时拒绝请求 + 明确错误
- [ ] 告警事件正确触发

**测试策略**:
```
测试用例组:
1. 正常使用 → 预算递减
2. 预算耗尽 → 拒绝请求
3. TPS 超限 → 队列等待
4. 重置预算 → 计数归零
```

---

### P4-3: AgentInstanceService 增强
**目标**: 增强现有实例管理，支持 agent.yaml 配置 + 模板系统

| 属性 | 值 |
|------|-----|
| 优先级 | P4 |
| 预估工时 | 2d |
| 依赖 | P4-1 |
| 产出文件 | `browser/agentInstanceService.ts` (修改) |
| Level | L2 → L3 |

**任务步骤**:
1. 支持 YAML 格式 agent 配置（兼容现有 JSON）
2. 实现 `upgradeInstance()` — 版本迁移
3. 实现实例目录完整结构（memory/, sessions/, logs/, state/）
4. 添加实例健康检查

**验收标准**:
- [ ] YAML/JSON 配置均可正常加载
- [ ] 新建实例创建完整目录结构
- [ ] upgradeInstance 正确迁移配置

**测试策略**:
```
测试用例组:
1. createInstance → 目录结构正确
2. 读取 YAML 配置 → 解析正确
3. 读取 JSON 配置 → 向后兼容
4. upgradeInstance → 配置迁移 + 旧配置备份
5. deleteInstance → 目录清理
```

---

### P4-4: AgentGalleryService 增强
**目标**: 模板库支持多来源（内置 / Marketplace / 自定义）

| 属性 | 值 |
|------|-----|
| 优先级 | P4 |
| 预估工时 | 2d |
| 依赖 | P4-3 |
| 产出文件 | `browser/agentGalleryService.ts` (修改) |
| Level | L2 |

**任务步骤**:
1. 实现内置模板加载（从 bundled resources）
2. 定义 Marketplace API 接口（暂用 Mock）
3. 自定义模板导入（从本地 .saros/templates/）
4. 模板搜索/筛选/排序

**验收标准**:
- [ ] 3 种来源的模板可统一展示
- [ ] 筛选/搜索功能正常
- [ ] 从模板创建实例 → 正确初始化

**测试策略**:
```
测试用例组:
1. listTemplates → 返回所有来源
2. filter by source → 正确过滤
3. installTemplate → 本地可用
4. 从模板 createInstance → 配置正确
```

---

### P4-5: WorkspaceTemplate 服务实现
**目标**: 实现工作区模板快照/恢复

| 属性 | 值 |
|------|-----|
| 优先级 | P4 |
| 预估工时 | 3d |
| 依赖 | P4-1 |
| 产出文件 | `browser/workspaceTemplateService.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 实现 `createTemplate()` — 捕获文件 + 布局 + 环境 + Git 状态
2. 实现 `applyTemplate()` — 4 种策略（Merge/Overwrite/Skip/Prompt）
3. 实现 `createSnapshot()` / `restoreSnapshot()` — 版本管理
4. 实现 `exportTemplate()` / `importTemplate()` — 分享
5. diff 能力（比较两个快照）

**验收标准**:
- [ ] 捕获完整工作区状态（文件 + 配置 + 布局）
- [ ] 恢复后状态一致
- [ ] diff 正确标识变更

**测试策略**:
```
测试用例组:
1. createTemplate → 快照内容完整
2. applyTemplate(Merge) → 不覆盖已有文件
3. applyTemplate(Overwrite) → 完全覆盖
4. createSnapshot → 可列出
5. restoreSnapshot → 回到历史状态
6. export → import → 内容一致
```

---

## Phase 5a: Memory Provider（2 周，∥ P5b, P6）

### P5a-1: LocalFileMemory 增强
**目标**: 增强本地文件记忆实现

| 属性 | 值 |
|------|-----|
| 优先级 | P5a |
| 预估工时 | 2d |
| 依赖 | P1-4 |
| 产出文件 | `browser/providers/memory/localFileMemory.ts` (修改) |
| Level | L2 → L3 |

**任务步骤**:
1. 实现 JSON 文件存储后端
2. 实现 `loadContext()` — 按时间/相关性加载
3. 实现 `writeMemory()` — 带元数据（importance, tags, timestamp）
4. 实现 `searchMemory()` — 关键词搜索 + 模糊匹配
5. 实现索引加速（倒排索引）

**验收标准**:
- [ ] 写入后可查到
- [ ] 搜索返回相关结果
- [ ] 性能：1000 条记忆内搜索 < 100ms

**测试策略**:
```
测试用例组:
1. writeMemory → 文件存储 → loadContext 可读
2. searchMemory("关键词") → 返回匹配
3. deleteMemory → 删除后搜索不到
4. 1000 条写入 + 搜索 → 性能基线
5. 并发读写 → 无数据损坏
```

---

### P5a-2: VectorMemory 实现
**目标**: 实现基于 embedding 的向量记忆

| 属性 | 值 |
|------|-----|
| 优先级 | P5a |
| 预估工时 | 3d |
| 依赖 | P5a-1 |
| 产出文件 | `browser/providers/memory/vectorMemory.ts` (修改) |
| Level | L2 |

**任务步骤**:
1. 集成 embedding API（Knot / OpenAI embedding）
2. 本地向量存储（基于 JSON + 余弦相似度）
3. 实现 `searchMemory()` — 语义搜索
4. 实现批量 index + 增量更新
5. 混合搜索（关键词 + 向量，权重可配）

**验收标准**:
- [ ] 语义搜索返回语义相关结果
- [ ] 性能：10000 向量搜索 < 500ms
- [ ] 混合搜索效果优于纯关键词

**测试策略**:
```
测试用例组:
1. 写入 "TypeScript 类型系统" → 搜索 "TS 泛型" → 返回相关
2. 写入多条 → 相似度排序正确
3. 批量 index → 全部可搜
4. 混合搜索 → 关键词 + 语义加权
```

---

## Phase 5b: Tool Provider（2 周，∥ P5a, P6）

### P5b-1: ToolProvider 基础实现增强
**目标**: 完善内置 ToolProvider

| 属性 | 值 |
|------|-----|
| 优先级 | P5b |
| 预估工时 | 2d |
| 依赖 | P1-4 |
| 产出文件 | `browser/providers/tool/toolProvider.ts` (修改) |
| Level | L2 |

**任务步骤**:
1. 实现内置工具集: file-read, file-write, terminal, git, search
2. 实现工具发现 (`listTools()`) — 从配置和内置列表聚合
3. 实现工具执行 (`executeTool()`) — 安全沙箱 + 结果序列化
4. 集成 ToolArgumentRepairer（自动修复 LLM 输出参数）
5. 集成 ParallelToolExecutor（可并行工具并行执行）

**验收标准**:
- [ ] 内置工具可正常调用
- [ ] 参数自动修复（单引号→双引号等）
- [ ] 并行工具正确并行执行

**测试策略**:
```
测试用例组:
1. listTools → 返回完整工具列表
2. executeTool("file-read", {path}) → 返回文件内容
3. executeTool 参数格式错误 → ToolRepair 修复后执行
4. 并行安全工具 → 并行执行
5. 路径冲突工具 → 串行执行
```

---

### P5b-2: MCP Gateway 对接
**目标**: 集成 MCP 协议，支持远程工具调用

| 属性 | 值 |
|------|-----|
| 优先级 | P5b |
| 预估工时 | 3d |
| 依赖 | P5b-1 |
| 产出文件 | `browser/providers/tool/mcpGateway.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 实现 MCP 客户端协议（JSON-RPC over stdio/HTTP）
2. 支持 `tools/list` + `tools/call` MCP 方法
3. 自动发现本地 MCP server（配置 + 自动探测）
4. 远程 MCP server 连接（HTTP transport）
5. 工具结果转换为 `IToolEvent` 流

**验收标准**:
- [ ] 连接本地 MCP server → 获取工具列表
- [ ] 调用 MCP 工具 → 返回正确结果
- [ ] 连接断开 → 优雅降级（从工具列表移除）

**测试策略**:
```
测试用例组:
1. 连接本地 MCP → listTools 返回工具
2. 调用 MCP 工具 → 正确结果
3. MCP server 不可用 → 错误处理
4. 超时处理 → 5s 超时后报错
5. 并发调用 → 互不干扰
```

---

## Phase 5c: Planning + Execution Provider（3 周）

### P5c-1: PlanningProvider 实现
**目标**: 实现意图分析和任务分解

| 属性 | 值 |
|------|-----|
| 优先级 | P5c |
| 预估工时 | 3d |
| 依赖 | P5a-1, P5b-1 |
| 产出文件 | `browser/providers/planning/planningProvider.ts` (修改) |
| Level | L2 |

**任务步骤**:
1. 实现 `analyzeIntent()` — 使用 Model 分析用户意图
2. 实现 `decomposePlan()` — 将目标分解为步骤
3. 实现 `validatePlan()` — 检查计划可行性
4. 系统提示词模板管理
5. 输出结构化 IPlan 对象

**验收标准**:
- [ ] 复杂请求可分解为多步计划
- [ ] 计划包含步骤、依赖关系、预估资源
- [ ] 校验可识别不可行步骤

**测试策略**:
```
测试用例组:
1. 简单请求 → 单步计划
2. 复杂请求 → 多步计划 + 依赖
3. 不可行请求 → validatePlan 报错
4. 上下文影响 → 相同请求不同上下文产出不同计划
```

---

### P5c-2: ExecutionProvider 增强（Agent Loop 实现）
**目标**: 完善 ExecutionProvider 的 Agent Loop 执行能力

| 属性 | 值 |
|------|-----|
| 优先级 | P5c |
| 预估工时 | 3d |
| 依赖 | P5c-1, P2-4 |
| 产出文件 | `browser/providers/execution/executionProvider.ts` (修改) |
| Level | L2 |

**任务步骤**:
1. 实现 `executeLoop()` — 完整 Agent 执行循环
2. 集成 ContextManager（上下文窗口管理）
3. 集成 SubAgentManager（子 Agent 委派）
4. 实现 pause/resume 能力
5. 输出 `ILoopEvent` 流（iteration_start, tool_call, iteration_end）

**验收标准**:
- [ ] 简单任务：1-2 次迭代完成
- [ ] 复杂任务：多次迭代 + 工具调用
- [ ] 上下文过长自动压缩
- [ ] pause/resume 正确暂停恢复

**测试策略**:
```
测试用例组:
1. 简单问答 → 1次迭代
2. 需要工具 → 多次迭代
3. 上下文超长 → 自动压缩
4. 预算耗尽 → 强制终止
5. pause → resume → 继续执行
6. 子Agent委派 → 正确返回结果
```

---

### P5c-3: ITaskDelegationService 实现
**目标**: 实现增强版任务委派服务

| 属性 | 值 |
|------|-----|
| 优先级 | P5c |
| 预估工时 | 2d |
| 依赖 | P5c-2 |
| 产出文件 | `browser/taskDelegationService.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 实现 `delegateTask()` — 创建子 Turn 执行任务
2. 实现 `delegateBatch()` — 批量委派
3. 实现 `cancelTask()` / `pauseTask()` / `resumeTask()` / `retryTask()`
4. 任务状态追踪（进度百分比 + 当前步骤描述）
5. 任务完成通知

**验收标准**:
- [ ] 委派任务 → 子 Agent 独立执行
- [ ] 批量委派 → 并行执行
- [ ] 取消 → 立即停止
- [ ] 进度追踪正确

**测试策略**:
```
测试用例组:
1. delegateTask → 成功返回结果
2. delegateBatch(3) → 3个并行 → 全部返回
3. cancelTask → 状态变更 + 资源释放
4. retryTask → 重新执行
5. 超时 → 自动失败
```

---

## Phase 6: Scheduler（2 周，∥ Phase 5）

### P6-1: AgentSchedulerService 生产化
**目标**: 将已实现的 Scheduler 提升到生产级

| 属性 | 值 |
|------|-----|
| 优先级 | P6 |
| 预估工时 | 2d |
| 依赖 | P2-9, P4-1 |
| 产出文件 | `browser/agentSchedulerService.ts` (修改) |
| Level | L2 → L3 |

**任务步骤**:
1. 添加执行历史持久化（文件存储）
2. 错误重试策略（失败后自动重试 + 退避）
3. 执行超时控制
4. 调度冲突处理（同 Agent 不允许并发触发）
5. 健康日志输出

**验收标准**:
- [ ] 5 种触发模式生产级稳定
- [ ] 历史记录可查询
- [ ] 失败自动重试（最多 3 次）
- [ ] 同 Agent 触发冲突时排队

**测试策略**:
```
测试用例组:
1. Cron 触发 → 正确时间执行
2. FileWatch 触发 → 文件变更后执行
3. Event 触发 → EventBridge 事件后执行
4. 失败 → 重试 → 成功
5. 并发触发同 Agent → 排队执行
6. pause/resume → 暂停恢复
```

---

### P6-2: Scheduler UI（调度管理面板）
**目标**: WebView 中实现调度管理界面

| 属性 | 值 |
|------|-----|
| 优先级 | P6 |
| 预估工时 | 2d |
| 依赖 | P6-1 |
| 产出文件 | `webview/src/features/scheduler/` (新建) |
| Level | L2 |

**任务步骤**:
1. 调度列表展示（Agent + 触发类型 + 上次执行 + 下次执行）
2. 创建/编辑/删除调度
3. 暂停/恢复操作
4. 执行历史查看
5. 实时状态指示（运行中/已暂停/错误）

**验收标准**:
- [ ] CRUD 操作功能完整
- [ ] 执行历史可查看
- [ ] 状态实时更新

**测试策略**:
- 手动 E2E 测试

---

## Phase 7: Enhanced TaskBoard（3 周，∥ Phase 8）

### P7-1: 层级任务树数据模型
**目标**: 实现任务树结构（支持父子关系 + 依赖）

| 属性 | 值 |
|------|-----|
| 优先级 | P7 |
| 预估工时 | 2d |
| 依赖 | P5c-3 |
| 产出文件 | `common/taskBoard.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 定义 ITaskNode（id, parent, children, status, agent, progress, cost）
2. 定义 ITaskTree（root, flatten, filter, sort）
3. 实现任务依赖关系（blockedBy, blocks）
4. 状态传播（子任务全完成 → 父任务完成）
5. 进度聚合（父进度 = 子进度均值）

**验收标准**:
- [ ] 创建父子任务 → 树结构正确
- [ ] 子任务全完成 → 父状态自动变更
- [ ] 依赖关系正确阻塞

**测试策略**:
```
测试用例组:
1. 创建树 → 结构正确
2. 完成所有子任务 → 父完成
3. 依赖未完成 → 不允许开始
4. 进度聚合正确
```

---

### P7-2: 看板视图（Kanban View）
**目标**: 实现 5 列看板 UI

| 属性 | 值 |
|------|-----|
| 优先级 | P7 |
| 预估工时 | 2d |
| 依赖 | P7-1 |
| 产出文件 | `webview/src/features/taskBoard/kanbanView/` (新建) |
| Level | L2 |

**任务步骤**:
1. 5 列布局: Todo → InProgress → Review → Done → Cancelled
2. 卡片拖拽移动
3. 卡片详情（Agent、进度、耗时、Token 消耗）
4. 筛选/排序功能

**验收标准**:
- [ ] 拖拽移动正确更新状态
- [ ] 卡片信息完整展示
- [ ] 实时状态更新

**测试策略**:
- 手动 E2E 测试 + 组件单元测试

---

### P7-3: 树形视图（Activity Tree View）
**目标**: 实时展示 Agent 执行活动树

| 属性 | 值 |
|------|-----|
| 优先级 | P7 |
| 预估工时 | 2d |
| 依赖 | P7-1 |
| 产出文件 | `webview/src/features/taskBoard/treeView/` (新建) |
| Level | L2 |

**任务步骤**:
1. 树形展开/折叠
2. 实时进度条 + Token 消耗
3. Kill / Pause 操作按钮
4. 日志展开（点击节点查看详细输出）
5. 自动滚动到当前执行节点

**验收标准**:
- [ ] 实时展示执行状态
- [ ] Kill/Pause 操作有效
- [ ] 日志可查看

**测试策略**:
- 手动 E2E 测试

---

### P7-4: 分析视图 + 时间线视图
**目标**: Token/Cost 统计 + 甘特图

| 属性 | 值 |
|------|-----|
| 优先级 | P7 |
| 预估工时 | 3d |
| 依赖 | P7-1 |
| 产出文件 | `webview/src/features/taskBoard/analyticsView/` + `timelineView/` (新建) |
| Level | L2 |

**任务步骤**:
1. 分析视图：Token 用量图、Cost 趋势、Duration 分布
2. Agent/Tool 使用排行
3. 时间线视图：甘特图展示任务时间分布
4. 依赖连线展示
5. 时间范围筛选

**验收标准**:
- [ ] 图表正确渲染
- [ ] 数据与实际执行一致
- [ ] 交互操作流畅

**测试策略**:
- 手动 E2E 测试 + 数据对比验证

---

## Phase 8: 高阶能力（4 周，∥ Phase 7）

### P8-1: HealthMonitorService 实现
**目标**: 实现完整健康监控

| 属性 | 值 |
|------|-----|
| 优先级 | P8 |
| 预估工时 | 2d |
| 依赖 | P4-1 |
| 产出文件 | `browser/healthMonitorService.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 实现 `getHealth()` — 综合健康评分
2. Provider 健康检查（定期 ping）
3. 告警规则（threshold + cooldown + action）
4. 指标采集（成功率、延迟、Token 用量）
5. 健康状态变更事件

**验收标准**:
- [ ] 健康报告完整（所有 Provider 状态）
- [ ] Provider 异常 → 告警触发
- [ ] 指标数据准确

**测试策略**:
```
测试用例组:
1. 全部 Provider 正常 → healthy
2. 1个 Provider 异常 → degraded
3. Model Provider 异常 → unhealthy
4. 告警规则匹配 → 通知触发
5. 指标采集数值正确
```

---

### P8-2: MemoryConsolidationService 实现
**目标**: 实现 5 阶段记忆沉淀流程

| 属性 | 值 |
|------|-----|
| 优先级 | P8 |
| 预估工时 | 4d |
| 依赖 | P5a-2 |
| 产出文件 | `browser/memoryConsolidationService.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. [阶段1] 压缩 — 合并连续相似条目（相似度 > 0.85）
2. [阶段2] 提升 — 高重要性条目（> 0.6）升级为长期记忆
3. [阶段3] 去重 — embedding 相似度 > 0.92 的合并
4. [阶段4] 衰减 — 时间衰减函数（exponential/linear/step）+ pinned 保护
5. [阶段5] 知识图谱 — 实体关系抽取（使用 LLM）

**验收标准**:
- [ ] 5 阶段按序执行
- [ ] 压缩后记忆数量减少（不丢失核心信息）
- [ ] Pinned 记忆不被衰减
- [ ] 知识图谱正确提取实体关系

**测试策略**:
```
测试用例组:
1. 10条相似记忆 → 压缩为3条
2. 重要记忆 → 提升到长期
3. 重复记忆 → 去重保留1条
4. 旧记忆衰减 → importance 下降
5. pinned 记忆 → importance 不变
6. 实体抽取 → 知识图谱有边
```

---

### P8-3: AgentSelfUpgradeService 实现
**目标**: 实现 Agent 自升级元学习系统

| 属性 | 值 |
|------|-----|
| 优先级 | P8 |
| 预估工时 | 4d |
| 依赖 | P8-2, P6-1 |
| 产出文件 | `browser/selfUpgradeService.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. Prompt 优化 — 基于成功/失败率调整系统提示词
2. 工具分析 — 记录工具选择策略，优化推荐
3. 技能提取 — 从重复操作模式中提炼 Skill（PrefixSpan 算法简化版）
4. 配置调优 — temperature/maxTokens A/B 对比
5. 安全保障 — constraints 不可修改 + 退化自动回滚

**验收标准**:
- [ ] Prompt 优化后成功率提升（A/B 验证）
- [ ] 退化时自动回滚
- [ ] 每日最多 3 个自动升级
- [ ] constraints 段不可被修改

**测试策略**:
```
测试用例组:
1. 多次失败 → 触发 prompt 优化
2. 优化后退化 → 自动回滚
3. 超过3次/天 → 拒绝升级
4. 尝试修改 constraints → 拒绝
5. 技能提取 → 生成 skill 文件
```

---

### P8-4: AgentCrewService 实现
**目标**: 实现多 Agent 团队协作编排

| 属性 | 值 |
|------|-----|
| 优先级 | P8 |
| 预估工时 | 5d |
| 依赖 | P5c-3, P8-1 |
| 产出文件 | `browser/agentCrewService.ts` (新建) |
| Level | L2 |

**任务步骤**:
1. 实现 4 种编排模式: Sequential / Parallel / Router / Hierarchical
2. 成员间通信机制（消息队列 + 共享上下文）
3. Router 模式：动态路由决策（LLM 选择下一个 Agent）
4. Hierarchical 模式：Orchestrator Agent 分配子任务
5. 执行结果聚合 + 冲突解决

**验收标准**:
- [ ] Sequential: A → B → C 顺序执行
- [ ] Parallel: A ∥ B ∥ C 并行执行
- [ ] Router: 根据输入选择合适 Agent
- [ ] Hierarchical: 领导分配 + 成员执行 + 结果汇总

**测试策略**:
```
测试用例组:
1. Sequential 3成员 → 依次执行
2. Parallel 3成员 → 并行 + 结果聚合
3. Router → 正确路由到对应成员
4. Hierarchical → 领导分配 + 子任务完成 + 汇总
5. 成员失败 → 重试/替换
6. 超时 → 强制终止
```

---

## 任务依赖总图

```
P0-1 ─────┐
P0-2 ────┐│
P0-3 ───┐││
         │││
P1-1 ←───┼┘│
P1-2 ←──P1-1
P1-3 ←──P1-1
P1-4 ←──P1-3
P1-5 ←──P1-2 + P1-4
         │
P2-1 ←──P1-5
P2-2 ←──P2-1
P2-3 ←──P2-2 + P1-5
P2-4 ←──P2-3
P2-5 ←──P2-1
P2-6 ←──P2-3
P2-7 ←──P2-1
P2-8 ←──P2-1
P2-9 ←──P2-1~P2-8 (全部)
P2-10 ←─P2-9
         │
P3-1 ←──P1-3 ──────────────────── (∥ Phase 2)
P3-2 ←──P3-1 + P1-2
P3-3 ←──P3-1 + P1-2
P3-4 ←──P3-2
         │
P4-1 ←──P2-9
P4-2 ←──P4-1
P4-3 ←──P4-1
P4-4 ←──P4-3
P4-5 ←──P4-1
         │
P5a-1 ←─P1-4 ─────────────────── (∥ P5b, P6)
P5a-2 ←─P5a-1
         │
P5b-1 ←─P1-4 ─────────────────── (∥ P5a, P6)
P5b-2 ←─P5b-1
         │
P5c-1 ←─P5a-1 + P5b-1
P5c-2 ←─P5c-1 + P2-4
P5c-3 ←─P5c-2
         │
P6-1 ←──P2-9 + P4-1 ──────────── (∥ P5)
P6-2 ←──P6-1
         │
P7-1 ←──P5c-3 ────────────────── (∥ P8)
P7-2 ←──P7-1
P7-3 ←──P7-1
P7-4 ←──P7-1
         │
P8-1 ←──P4-1 ─────────────────── (∥ P7)
P8-2 ←──P5a-2
P8-3 ←──P8-2 + P6-1
P8-4 ←──P5c-3 + P8-1
```

---

## 测试策略总览

### 测试层次

| 层次 | 范围 | 工具 | 运行频率 |
|------|------|------|----------|
| **单元测试** | 单个类/方法 | VSCode 内置测试框架 (Mocha) | 每次 commit |
| **集成测试** | 多服务协作 | Mocha + Mock Provider | 每次 PR |
| **E2E 测试** | 完整用户流程 | Playwright + WebView | 每日/手动 |
| **性能测试** | 吞吐/延迟基线 | 自定义 bench | 每周 |

### 每 Phase 测试里程碑

| Phase | 测试里程碑 | 通过标准 |
|-------|-----------|----------|
| P0 | 基础设施就位 | Mock 工厂可用，测试命令可执行 |
| P1 | OS 层单元测试 | SlotRegistry + Provider 注册/查询 100% 覆盖 |
| P2 | Driver 层单元+集成 | 9组件单元测试 + executeTurn 集成测试 |
| P3 | Model Provider 端到端 | Knot + DirectLLM 可正常对话 |
| P4 | 工作区生命周期 | 创建/销毁/隔离验证 |
| P5 | 能力层功能测试 | Memory/Tool/Planning 各自独立可用 |
| P6 | Scheduler 稳定性 | 连续运行 24h 无泄漏/无错过触发 |
| P7 | TaskBoard UI 可用性 | 4 种视图渲染正确 + 交互流畅 |
| P8 | 高阶功能验证 | Consolidation/SelfUpgrade/Crew 基本流程通过 |

### 回归测试清单

每次 PR 必须验证:
1. `npm run compile` — 编译通过
2. `npm run lint` — 代码规范
3. `npm run test` — 单元测试全绿
4. 冒烟测试: 启动 → 打开 Agent Studio → 发送一条消息 → 收到回复

---

## 工时估算总览

| Phase | 任务数 | 总工时 | 关键路径贡献 |
|-------|--------|--------|-------------|
| P0 | 3 | 2d | 1w |
| P1 | 5 | 8.5d | 2w |
| P2 | 10 | 16.5d | 3w |
| P3 | 4 | 9d | ∥ (非关键) |
| P4 | 5 | 10.5d | 3w |
| P5a | 2 | 5d | ∥ |
| P5b | 2 | 5d | ∥ |
| P5c | 3 | 8d | 3w |
| P6 | 2 | 4d | ∥ |
| P7 | 4 | 9d | ∥ |
| P8 | 4 | 15d | 4w |
| **总计** | **44** | **~93d** | **关键路径 12w** |

---

## 快速开始（建议首批任务）

如果要立即开始编码，建议按以下顺序执行 **前 5 个任务**（约 1 周可完成）：

1. **P0-1**: 统一 IChatStreamDelta（0.5d）
2. **P0-2**: 创建测试基础设施（1d）
3. **P0-3**: 清理兼容层（0.5d）
4. **P1-1**: OS 接口规范化（1d）
5. **P1-3**: Provider 接口标准化（2d）

完成这 5 项后，项目进入 **可并行开发** 状态：P1-2/P1-4/P1-5 可同时推进。

---

> **维护说明**: 本文档随开发进展持续更新。完成任务后请在对应任务下标注 ✅ 和完成日期。
