# 核心问题解决方案 + 分阶段任务拆分

> **文档版本**: 2026-05-09  
> **基于**: OpenClaw-VSCode-Architecture-v2.md (v1.7, 28章, 10660行)  
> **关联**: Architecture-Review-and-Restructuring.md (Review 报告)

---

## 一、5 大核心问题解决方案

### 问题 1：接口体系三套并存

**现状**：文档中存在三套互相覆盖的接口体系，未明确废弃/继承关系：

| 接口 | 出处 | 定位 |
|------|------|------|
| `IChatBackend` / `IChatBackendPlugin` | Ch4.6 (早期) | 平级 Backend 路由，将 Knot/OpenClaw/DirectLLM 视为同层替代品 |
| `IAgentOSService` | Ch4.1.5 | OS 中间层，7 个能力槽统一编排 |
| `IAgentDriverService` | Ch19 | 驱动层，编排 OS 能力槽的执行引擎 |

**解决方案**：

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  统一接口层级关系（唯一事实来源）                                                  │
│                                                                                │
│  UI → IAgentDriverService (Ch19) → IAgentOSService (Ch4.1.5) → IXxxProvider   │
│                                                                                │
│  ❌ IChatBackend / IChatBackendPlugin → 正式废弃                                 │
│  ❌ IAgentChatService.sendMessage() 直连后端 → 重构为委托 Driver                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

**具体操作**：
1. 在文档 Ch4.6 处添加 **`⛔ DEPRECATED`** 标注块，声明 `IChatBackend` / `IChatBackendPlugin` 全部废弃
2. 在 Ch4.1.5 `IAgentOSService` 处添加注释：`executeAgentTurn()` 方法已由 Ch19 `IAgentDriverService` 接管，OS 层不再直接暴露执行入口给 UI
3. 统一数据流描述为：

```
User Message → WebviewController → IAgentDriverService.executeTurn()
  → Driver 内部按 Pipeline 编排调用 IAgentOSService 各 Slot
  → yield IChatStreamDelta → WebviewController → WebView UI
```

4. 将 Ch4 中关于 `IAgentOSService.executeAgentTurn()` 的定义移除（或标注 `@internal`，仅 Driver 内部调用）

**最终关系**：
- `IAgentDriverService`：**UI 面向的唯一入口**（执行 Turn）
- `IAgentOSService`：**Driver 面向的能力仓库**（注册/查询 Provider）
- `IXxxProvider`：**插件面向的实现契约**（Plugin → OS 注册）

---

### 问题 2：两个过时总结 (Ch15 + Ch18)

**现状**：
- Ch15 "总结"（约 Line 5062）— 写于 Ch14 之后，不含 Ch16-28 的内容
- Ch18 "总结"（约 Line 6119）— 写于 Ch17 之后，不含 Ch19-28 的内容
- 两者内容高度重叠（都是"核心成果"列表 + "后续工作"列表）

**解决方案**：

| 操作 | 处理 |
|------|------|
| Ch15 | **完全删除** — 其"核心成果"列表已被 Ch18 涵盖 |
| Ch18 | **完全删除** — 已被 Ch26 "功能关联与 Phase 映射" 取代 |
| 新增 | 文档末尾（Ch28 版本历史之前）保留唯一一个 **"架构总结与当前状态"** 章节 |

**新总结章节内容大纲**：

```markdown
## XX. 架构总结与当前状态

### 统一架构模型
- 四层架构：UI → Driver → OS (7 Slots) → Provider Plugins
- 执行入口：IAgentDriverService.executeTurn()
- 能力编排：Pipeline 配置驱动，支持 Simple Chat / Full Agent / RAG 三种模式

### 已完成设计（接口定义 Level）
- [列出 Ch4-Ch27 中所有已定义的核心接口，按层标注状态]

### 依赖关系总览
- [引用 Ch26 的依赖图]

### 未来路线图入口
- → Phase 实施方案见本文档配套文件
```

---

### 问题 3：空占位章节 (Ch11 + Ch12)

**现状**：
- Ch11 "系统架构总览" — 仅一行 SVG 图片引用 `![系统架构总览](./diagrams/architecture-overview.svg)`
- Ch12 "系统架构总览（含多客户端）" — 同上，仅一行 SVG 引用

**解决方案**：

| 操作 | 处理 |
|------|------|
| Ch11 | **删除整章** — 架构总览已由 Ch4.1.2 的 ASCII 图完整表达 |
| Ch12 | **删除整章** — 多客户端概念已融入 Ch20 多工作区隔离设计 |
| SVG 文件 | 如实际存在则移入 `docs/diagrams/` 作为参考资料，如不存在（占位）则无需操作 |

**删除后重新编号影响**：Ch13→Ch11, Ch14→Ch12, ... 为避免大量交叉引用失效，建议改为在原位置插入重定向注释：

```markdown
## 11. [已合并] 系统架构总览
> ⚠️ 本章内容已合并入 Ch4.1.2 分层架构图。详见 §4.1.2。

## 12. [已合并] 多客户端架构
> ⚠️ 本章内容已合并入 Ch20 Multi-Workspace Isolation。详见 §20。
```

---

### 问题 4：迁移计划过时 (Ch8)

**现状**：Ch8 "迁移计划" 仅覆盖了最早期的"后端抽象重构"（将 `AgentChatService` 中的 Knot 硬编码抽取为 Backend 接口），未涵盖：
- OS 中间层构建
- Driver 层构建  
- 工作区隔离
- Agent 实例化
- Scheduler/Consolidation/SelfUpgrade/Crew/EnhancedBoard

**解决方案**：**用全新的 Phase 实施方案完全替换 Ch8**。

新 Ch8 标题改为：**"实施路线图（Phase 方案）"**

内容结构：
```markdown
## 8. 实施路线图

### 8.1 Phase 总览与依赖关系
[依赖关系图 — 见下方问题5解决方案中的图]

### 8.2 Phase 定义表
[P0-P8 各阶段一行摘要]

### 8.3 各 Phase 详细方案
[每阶段：目标/依赖/产出文件/验收标准/关键决策/预估工期]

### 8.4 验证检查表（通用）
[编译/循环依赖/冒烟测试/文档 等]

### 8.5 风险评估
[沿用 Review 报告中的风险表，补充 Ch22-27 新增风险]
```

---

### 问题 5：Ch22-27 与基础 Phase 的耦合不明确

**现状**：Ch22-27 新增 6 大功能，Ch26 虽有一张依赖表，但：
- 未明确到"哪个 Phase 的哪个具体产出（接口/服务）"是前置条件
- 未定义"完成度 Level"要求（是需要 L0 接口定义还是 L2 功能可用？）
- 新功能之间的内部依赖也不清晰（如 Consolidation 需要 Scheduler）

**解决方案**：建立**精确的服务级依赖矩阵**：

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  Ch22-27 新功能依赖矩阵（精确到服务+完成度）                                            │
├──────────────────┬──────────────────────────────────────────────────────────────────────┤
│ 新功能            │ 前置依赖（服务@完成度Level）                                          │
├──────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Ch22 Scheduler   │ IAgentDriverService@L2 (需 executeTurn 可用)                         │
│                  │ IAgentInstanceService@L1 (需实例存在才能调度)                          │
│                  │ IWorkspaceRegistry@L1 (需工作区上下文)                                 │
├──────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Ch23 Consolidation│ IMemoryProvider@L2 (需 loadContext+writeMemory+searchMemory 可用)    │
│                  │ IAgentSchedulerService@L2 (定时触发 consolidation job)                │
│                  │ [可选] IRetrievalProvider@L1 (embedding similarity 去重)              │
├──────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Ch24 SelfUpgrade │ IMemoryProvider@L2 (读取历史记忆做元学习)                               │
│                  │ IAgentDriverService@L2 (监听 onDidEndTurn 事件，收集执行指标)           │
│                  │ IAgentInstanceService@L2 (修改 agent.yaml 应用升级)                   │
│                  │ [可选] IAgentSchedulerService@L1 (定期触发自评估)                      │
├──────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Ch25 Crew/Team   │ IAgentInstanceService@L2 (多实例创建+管理)                            │
│                  │ IWorkspaceRegistry@L2 (工作区完全隔离确认)                             │
│                  │ IAgentIntercom@L2 (实例间通信)                                        │
│                  │ IKanbanProvider@L1 (任务分配可视化)                                    │
├──────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Ch25.2 Template  │ IAgentGalleryService@L1 (模板注册接口)                                │
│                  │ IAgentInstanceService@L1 (instantiateFromTemplate)                    │
├──────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Ch25.5 Health    │ IAgentDriverService@L1 (EventBus 事件订阅)                            │
│ Monitor          │ IAgentOSService@L1 (能力槽状态查询)                                   │
├──────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Ch27 Enhanced    │ IKanbanProvider@L2 (看板 CRUD 完整可用)                                │
│ Task Board       │ IAgentDriverService@L2 (实时 Turn 事件流)                              │
│                  │ ITaskDelegationService@L2 (批次委派)                                   │
│                  │ IAgentInstanceService@L1 (知道哪些实例可被委派)                         │
└──────────────────┴──────────────────────────────────────────────────────────────────────┘

Level 定义:
  L0 = 接口定义(.ts 存在, 编译通过)
  L1 = 空壳实现(DI 可注入, 返回空/默认值)
  L2 = 功能实现(核心路径可用, 无 edge case)
  L3 = 生产就绪(错误处理/日志/超时/重试完备)
```

---

## 二、统一 Phase 方案（P0-P8）

基于以上 5 个问题的解决方案，以下是统一的 Phase 拆分。

### Phase 总览

| Phase | 名称 | 工期 | 并行条件 | 核心产出 |
|-------|------|------|----------|----------|
| **P0** | 文档重组 | 1 周 | 无前置 | 文档结构统一、术语统一、废弃标注 |
| **P1** | OS 中间层骨架 | 2 周 | P0 完成 | IAgentOSService + 7 Provider 接口 + SlotRegistry |
| **P2** | Driver 层实现 | 3 周 | P1@L1 | IAgentDriverService + Turn 管理 + Pipeline + Loop |
| **P3** | Model Provider 插件化 | 2 周 | P1@L1, 可与 P2 并行 | Knot 抽取为插件 + 模型选择器 UI |
| **P4** | 工作区隔离 + 实例化 | 3 周 | P2@L1 | IWorkspaceRegistry + IAgentInstanceService + Gallery |
| **P5a** | Memory Provider | 2 周 | P1@L2 + P2@L2 | IMemoryProvider 实现 + 文件/向量后端 |
| **P5b** | Tool/MCP Provider | 2 周 | P1@L2, 可与 P5a 并行 | IToolProvider + MCP Gateway 对接 |
| **P5c** | Planning + Execution | 2 周 | P5a@L1 + P5b@L1 | 完整 Agent Loop |
| **P6** | Scheduler 定时调度 | 2 周 | P2@L2, 可与 P5 并行 | IAgentSchedulerService + Cron/FileWatch/Event |
| **P7** | Enhanced Task Board | 3 周 | P2@L2 + P4@L1, 可与 P8 并行 | 层级任务树 + 实时监控 + 分析视图 |
| **P8** | 高阶能力 | 4 周 | P5a@L2 + P6@L2 + P4@L2 | Consolidation + SelfUpgrade + Crew |

### Phase 依赖关系图

```
                 P0 (文档重组, 1w)
                       │
                       ▼
                 P1 (OS骨架, 2w)
                   ┌───┴───┐
                   ▼       ▼
          P2 (Driver, 3w)  P3 (Model Plugin, 2w)  ← 并行
                   │              │
                   │    ┌─────────┘
                   ▼    ▼
            P4 (工作区+实例, 3w)
                   │
          ┌────────┼────────────────────────┐
          ▼        ▼                        ▼
  P5a (Memory)  P5b (Tool/MCP)     P6 (Scheduler, 2w) ← P2@L2后可并行
     2w            2w                       │
          │        │                        │
          └───┬────┘                        │
              ▼                             │
     P5c (Planning+Exec, 2w)               │
              │                             │
              ├─────────────────────────────┤
              ▼                             ▼
     P7 (Enhanced TaskBoard, 3w)    P8 (高阶能力, 4w) ← 并行
                                    ├── P8a: Consolidation (P5a+P6)
                                    ├── P8b: SelfUpgrade (P5a+P2)
                                    └── P8c: Crew (P4@L2)
```

---

## 三、各 Phase 详细任务拆分

---

### P0：文档重组（1 周）

**目标**：解决 5 个核心问题中的文档层面问题，为后续编码提供清晰无矛盾的设计参考。

| # | 子任务 | 产出 | 验收标准 |
|---|--------|------|----------|
| P0.1 | 统一接口体系：在 Ch4.6 添加 DEPRECATED 标注 | 修改 OpenClaw-VSCode-Architecture-v2.md | IChatBackend 相关接口明确标注废弃 |
| P0.2 | 统一数据流：在 Ch4.1.5 的 `executeAgentTurn()` 标注 @internal | 同上 | 明确 UI 只能调 Driver，不直接调 OS |
| P0.3 | 删除 Ch15 总结，替换为重定向注释 | 同上 | 原 Ch15 位置仅保留一行指向新总结 |
| P0.4 | 删除 Ch18 总结，替换为重定向注释 | 同上 | 同上 |
| P0.5 | 处理 Ch11/Ch12 空占位，替换为重定向注释 | 同上 | 不再有纯 SVG 引用空章 |
| P0.6 | 重写 Ch8 为"实施路线图"概要（引用本文档） | 同上 | Ch8 明确指向 Task-Breakdown |
| P0.7 | 新增"架构总结与当前状态"章节（Ch28前） | 同上 | 唯一总结入口，含四层模型+状态矩阵 |
| P0.8 | 创建 `GLOSSARY.md` 统一术语表 | 新文件 | Driver/OS/Provider/Instance/Slot/Pipeline 定义 |
| P0.9 | 在 Ch26 补充精确依赖矩阵（问题5方案） | 修改 v2.md | 每个新功能的服务级+Level 级依赖明确 |

**P0 完成标志**：
- ✅ 文档中不存在无废弃标注的 `IChatBackend` 定义
- ✅ 不存在空章节（Ch11/12/15/18 均已处理）
- ✅ Ch8 不再是过时的"后端抽象迁移"
- ✅ Ch22-27 每个功能都有明确的服务@Level 前置条件

---

### P1：OS 中间层骨架（2 周）

**目标**：建立 IAgentOSService + 7 个 Provider 接口 + SlotRegistry，所有能力槽可注册但暂无活跃 Provider。

**依赖**：P0 完成

| # | 子任务 | 产出文件 | 验收标准 |
|---|--------|----------|----------|
| P1.1 | 定义 IAgentOSService 接口 | `sessions/contrib/agentStudio/common/agentOS.ts` | 包含 7 个 register + get 方法 |
| P1.2 | 定义 7 个 Provider 接口 | `sessions/contrib/agentStudio/common/providers.ts` | IModel/IMemory/ITool/IPlanning/IExecution/IRetrieval/IKanban Provider |
| P1.3 | 定义 IModelSelection + IModelInfo | `sessions/contrib/agentStudio/common/modelSelector.ts` | 模型选择器数据类型 |
| P1.4 | 定义 BaseProviderAdapter 基类 | `sessions/contrib/agentStudio/common/adapters.ts` | 通用生命周期/日志/错误处理 |
| P1.5 | 定义 AgentOSError | `sessions/contrib/agentStudio/common/errors.ts` | 标准错误类型 |
| P1.6 | 实现 AgentOSService（空壳） | `sessions/contrib/agentStudio/browser/agentOSService.ts` | DI 注入成功，register/get 可调用 |
| P1.7 | 实现 SlotRegistry | `sessions/contrib/agentStudio/browser/slotRegistry.ts` | 能力槽注册表（优先级排序） |
| P1.8 | DI 注册 | 修改 `agentStudio.contribution.ts` | registerSingleton 注册 OS Service |
| P1.9 | 验证 | 编译 + 冒烟测试 | 无 circular dependency，现有功能不退化 |

**关键决策**：
- OS 层放在 `sessions/contrib/agentStudio/` 内，不新建顶层目录
- 能力槽接口设计为 `readonly` + `Event`，便于响应式更新
- Model Slot 支持多 Provider 同时注册；其他 Slot 优先级自动选择

---

### P2：Driver 层实现（3 周）

**目标**：实现 IAgentDriverService，作为 UI → OS 的统一执行入口。

**依赖**：P1@L1（OS 接口定义 + 空壳注册可用）

| # | 子任务 | 产出文件 | 验收标准 |
|---|--------|----------|----------|
| P2.1 | 定义 IAgentDriverService 接口 | `common/agentDriver.ts` | executeTurn/cancelTurn/Pipeline/Middleware |
| P2.2 | 定义 Pipeline 配置类型 | `common/pipeline.ts` | IPipelineConfig/IPipelineStep/条件执行 |
| P2.3 | 定义 Turn 状态机 | `common/turnState.ts` | TurnStatus/ITurnState/ITurnContext/ITurnMetrics |
| P2.4 | 实现 TurnManager | `browser/driver/turnManager.ts` | Turn 生命周期（create/run/pause/end） |
| P2.5 | 实现 SlotOrchestrator | `browser/driver/slotOrchestrator.ts` | 按 Pipeline 配置编排 OS Slot 调用 |
| P2.6 | 实现 LoopEngine | `browser/driver/loopEngine.ts` | Agent Loop（内置简单版 + 委托 ExecutionProvider 版） |
| P2.7 | 实现 StreamController | `browser/driver/streamController.ts` | 流管道合并 + 背压控制 |
| P2.8 | 实现 ErrorRecovery | `browser/driver/errorRecovery.ts` | 重试/跳过/降级/询问用户策略 |
| P2.9 | 实现 CancellationHub | `browser/driver/cancellationHub.ts` | 取消令牌协调 + 超时自动取消 |
| P2.10 | 实现 Middleware Chain | `browser/driver/middlewareChain.ts` | 洋葱模型（Logging/RateLimit/Metrics/Validation） |
| P2.11 | 实现 AgentDriverService | `browser/agentDriverService.ts` | 组装上述组件，暴露 IAgentDriverService |
| P2.12 | 重构 AgentChatService | 修改 `browser/agentChatService.ts` | 改为薄壳，sendMessage() 委托 Driver |
| P2.13 | 重构 WebviewController | 修改 `browser/agentStudioWebviewController.ts` | 消息路由到 Driver |
| P2.14 | 预置 Pipeline 配置 | `browser/driver/presetPipelines.ts` | SIMPLE_CHAT / FULL_AGENT / RAG 三套 |
| P2.15 | DI 注册 + 验证 | 修改 contribution.ts + 编译测试 | 用户发消息 → Driver → OS → Model → 流式返回 |

**关键决策**：
- Driver 无状态设计，状态由 TurnManager 持有
- 兼容模式：仅 Model Provider 时 Driver 退化为简单直通
- 预置 Pipeline 可被 agent.yaml 中的配置覆盖

---

### P3：Model Provider 插件化（2 周）

**目标**：将 Knot 硬编码逻辑抽取为 IModelProvider 插件。

**依赖**：P1@L1，可与 P2 并行

| # | 子任务 | 产出文件 | 验收标准 |
|---|--------|----------|----------|
| P3.1 | 创建 Knot 插件项目结构 | `extensions/knot-agui/package.json` + `src/` | 插件 Manifest 定义 |
| P3.2 | 实现 KnotModelProvider | `extensions/knot-agui/src/knotModelProvider.ts` | 实现 IModelProvider 接口 |
| P3.3 | 迁移 AG-UI 协议客户端 | `extensions/knot-agui/src/knotAGUIClient.ts` | 从 agentChatService 剥离 |
| P3.4 | 实现插件入口 | `extensions/knot-agui/src/extension.ts` | registerModelProvider 到 OS |
| P3.5 | 实现 ModelSelectorService | `browser/modelSelectorService.ts` | 管理所有已注册 Model Provider + 当前选择 |
| P3.6 | 实现模型选择器 UI | `webview/src/features/modelSelector/` | 下拉选择 Provider:Model 组合 |
| P3.7 | Settings 配置迁移 | 更新 settings schema | knot.auth.token / knot.endpoint 配置项 |
| P3.8 | 验证 | 端到端测试 | Knot 代码从 agentChatService 完全解耦，通过插件注册后正常工作 |

**关键决策**：
- Knot 插件注册后为默认 Model Provider（priority: 100）
- 无 Token 时 AuthStatus = NotConfigured，不阻塞编辑器启动
- 后续可按同样模式添加 DirectLLM 插件（OpenAI/Anthropic/Ollama）

---

### P4：工作区隔离 + Agent 实例化（3 周）

**目标**：多工作区完全隔离 + Agent 实例拖拽创建。

**依赖**：P2@L1（Driver 接口已定义）

| # | 子任务 | 产出文件 | 验收标准 |
|---|--------|----------|----------|
| P4.1 | 定义 IWorkspaceRegistry 接口 | `common/workspaceRegistry.ts` | 工作区注册/注销/查询 |
| P4.2 | 定义 IAgentInstanceService 接口 | `common/agentInstance.ts` | instantiate/list/delete/upgrade |
| P4.3 | 定义 IAgentGalleryService 接口 | `common/agentGallery.ts` | 模板库 CRUD + 市场安装 |
| P4.4 | 定义 IAgentIntercom 接口 | `common/agentIntercom.ts` | 实例间消息通信 |
| P4.5 | 实现 WorkspaceRegistryService | `browser/workspaceRegistryService.ts` | 每工作区独立 OS+Driver 实例栈 |
| P4.6 | 实现 AgentInstanceService | `browser/instance/agentInstanceServiceImpl.ts` | 目录创建 + yaml 解析 + 注册 |
| P4.7 | 实现 AgentDirectoryManager | `browser/instance/agentDirectoryManager.ts` | .sarosis/agents/ 目录操作 |
| P4.8 | 实现 AgentGalleryService | `browser/gallery/agentGalleryServiceImpl.ts` | 内置模板 + 自定义模板 |
| P4.9 | 实现 Gallery UI | `webview/src/features/gallery/` | 模板卡片 + 拖拽创建 |
| P4.10 | 实现实例列表 UI | `webview/src/features/instance/` | 实例状态展示 + 操作按钮 |
| P4.11 | DI 注册 + 验证 | 编译 + 端到端 | Gallery 拖拽→创建实例→目录结构正确→可发消息 |

---

### P5a：Memory Provider（2 周）

**目标**：实现完整的 IMemoryProvider，支持文件存储和向量检索。

**依赖**：P1@L2 + P2@L2

| # | 子任务 | 产出文件 | 验收标准 |
|---|--------|----------|----------|
| P5a.1 | 实现本地文件 Memory 后端 | `browser/providers/memory/localFileMemory.ts` | JSON 文件读写 |
| P5a.2 | 实现向量检索后端（可选） | `browser/providers/memory/vectorMemory.ts` | embedding + similarity search |
| P5a.3 | 实现 MemoryProvider | `browser/providers/memory/memoryProvider.ts` | 实现 IMemoryProvider 完整接口 |
| P5a.4 | Driver 集成测试 | Pipeline 加载上下文 | loadContext → Driver 注入 → 对话携带历史记忆 |
| P5a.5 | writeMemory 集成 | Pipeline 写回记忆 | Turn 结束后自动写入摘要 |

---

### P5b：Tool/MCP Provider（2 周）

**目标**：实现 IToolProvider，对接 MCP Gateway。

**依赖**：P1@L2，可与 P5a 并行

| # | 子任务 | 产出文件 | 验收标准 |
|---|--------|----------|----------|
| P5b.1 | 实现 MCP Gateway 客户端 | `browser/providers/tool/mcpGatewayClient.ts` | tools/list + tools/call |
| P5b.2 | 实现 ToolProvider | `browser/providers/tool/toolProvider.ts` | 实现 IToolProvider 接口 |
| P5b.3 | 工具发现 UI | `webview/src/features/tools/` | 展示可用工具列表 |
| P5b.4 | Driver 集成 | LoopEngine 内 tool_call 流程 | Model 输出 tool_call → executeTool → 结果回注 |
| P5b.5 | Gateway 进程管理 | 对接现有 McpGatewayService | 自动启动/停止 Gateway 进程 |

---

### P5c：Planning + Execution Provider（2 周）

**目标**：完整 Agent Loop 可用。

**依赖**：P5a@L1 + P5b@L1

| # | 子任务 | 产出文件 | 验收标准 |
|---|--------|----------|----------|
| P5c.1 | 实现 PlanningProvider | `browser/providers/planning/planningProvider.ts` | 意图分析 + 任务分解 |
| P5c.2 | 实现 ExecutionProvider | `browser/providers/execution/executionProvider.ts` | Agent Loop (Plan→Act→Observe→Reflect) |
| P5c.3 | 完整 Pipeline 集成 | FULL_AGENT_PIPELINE 端到端 | 多步任务自动规划执行 |
| P5c.4 | Kanban 同步 | Pipeline 中 kanban step | 任务创建/更新/完成自动同步到看板 |

---

### P6：Scheduler 定时调度（2 周）

**目标**：实现 IAgentSchedulerService，支持 Cron/FileWatch/Event/OneShot 触发。

**依赖**：P2@L2（需 executeTurn 可用），可与 P5 并行

| # | 子任务 | 产出文件 | 验收标准 |
|---|--------|----------|----------|
| P6.1 | 定义 IAgentSchedulerService 接口 | `common/agentScheduler.ts` | 已在 Ch22 定义，直接实现 |
| P6.2 | 实现 CronEngine | `browser/scheduler/cronEngine.ts` | cron 表达式解析 + 定时触发 |
| P6.3 | 实现 FileWatchEngine | `browser/scheduler/fileWatchEngine.ts` | glob 监听 + 防抖 |
| P6.4 | 实现 EventBridge | `browser/scheduler/eventBridge.ts` | Git/Terminal/Build 事件桥接 |
| P6.5 | 实现 SchedulerService | `browser/scheduler/schedulerService.ts` | 整合 + executeTurn 触发 |
| P6.6 | agent.yaml schedules 解析 | `browser/instance/scheduleParser.ts` | 从实例配置中读取 schedule |
| P6.7 | Scheduler UI | `webview/src/features/scheduler/` | 定时任务列表 + 开关控制 |
| P6.8 | 验证 | 端到端 | Cron 触发 → executeTurn → 流式输出正常 |

---

### P7：Enhanced Task Board（3 周）

**目标**：层级任务树 + 实时 Agent 活动监控 + 分析视图。

**依赖**：P2@L2 + P4@L1

| # | 子任务 | 产出文件 | 验收标准 |
|---|--------|----------|----------|
| P7.1 | 扩展 TaskBoardRecord 数据模型 | 修改 `common/types.ts` | 新增 parentTaskId/metrics/turns 等字段 |
| P7.2 | 定义 ITaskDelegationService | `common/taskDelegation.ts` | 单任务委派 + 批次并行委派 |
| P7.3 | 实现 TaskDelegationService | `browser/taskboard/taskDelegationService.ts` | 并发控制 + 任务树管理 |
| P7.4 | 树形视图 UI | `webview/src/features/taskboard/TaskTreeView.tsx` | 实时 Agent 活动树 |
| P7.5 | 树节点组件 | `webview/src/features/taskboard/TaskTreeNode.tsx` | 展开/折叠/控制按钮 |
| P7.6 | 分析视图 UI | `webview/src/features/taskboard/TaskAnalyticsView.tsx` | Token/Cost/Duration 统计 |
| P7.7 | 时间线视图 UI | `webview/src/features/taskboard/TaskTimelineView.tsx` | 甘特图式时间轴 |
| P7.8 | 视图模式切换 | `webview/src/features/taskboard/AgentActivityMonitor.tsx` | 看板/树形/分析/时间线切换 |
| P7.9 | 实时事件流集成 | StreamController → TaskBoard | Turn 事件实时推送到树形视图 |
| P7.10 | 验证 | 端到端 | 委派任务→子任务并行执行→实时监控→成本汇总正确 |

---

### P8：高阶能力（4 周）

**目标**：Memory Consolidation + Self-Upgrade + Crew。

**依赖**：P5a@L2 + P6@L2 + P4@L2

#### P8a：Memory Consolidation（2 周）

| # | 子任务 | 验收标准 |
|---|--------|----------|
| P8a.1 | 实现 Compression Engine | 短期记忆摘要压缩 |
| P8a.2 | 实现 Promotion Engine | 重要记忆提升为长期 |
| P8a.3 | 实现 Deduplication | embedding similarity 去重 |
| P8a.4 | 实现 Decay Engine | 过期记忆衰减/清理 |
| P8a.5 | Scheduler 集成 | 定时触发 consolidation job |
| P8a.6 | Dashboard UI | 记忆统计面板 |

#### P8b：Self-Upgrade（2 周）

| # | 子任务 | 验收标准 |
|---|--------|----------|
| P8b.1 | 实现 Prompt Optimizer | 基于历史表现优化 system prompt |
| P8b.2 | 实现 Skill Extractor | 从成功 Turn 中提取可复用技能 |
| P8b.3 | 实现 Error Learner | 分析失败 Turn，生成避错规则 |
| P8b.4 | 实现 Safety Checker | 升级前校验 + 回滚机制 |
| P8b.5 | Upgrade Dashboard UI | 升级历史 + A/B 对比 |

#### P8c：Crew/Team（2 周）

| # | 子任务 | 验收标准 |
|---|--------|----------|
| P8c.1 | 实现 Orchestrator (Sequential) | 顺序协作编排 |
| P8c.2 | 实现 Orchestrator (Router) | 意图路由到合适 Agent |
| P8c.3 | 实现 CrewBuilder | 从模板组合 Crew |
| P8c.4 | Crew UI | Crew 配置面板 + 执行监控 |
| P8c.5 | Intercom 集成 | 实例间消息 + 任务委派验证 |

---

## 四、甘特图时间线（16 周）

```
Week:  1    2    3    4    5    6    7    8    9    10   11   12   13   14   15   16
       ├────┤
       P0 文档

            ├─────────┤
            P1 OS骨架

                 ├──────────────┤
                 P2 Driver层                    ← 关键路径
                      ├─────────┤
                      P3 Model Plugin (并行P2)

                                ├──────────────┤
                                P4 工作区+实例

                                          ├─────────┤  ├─────────┤
                                          P5a Memory   P5b Tool (并行)
                                                            ├─────────┤
                                                            P5c Plan+Exec

                           ├─────────┤
                           P6 Scheduler (并行P4/P5)

                                                       ├──────────────┤
                                                       P7 TaskBoard (并行P8)

                                                       ├───────────────────────┤
                                                       P8 高阶能力 (Consol+Upgrade+Crew)
```

---

## 五、验证检查表（每 Phase 通用）

- [ ] `npm run compile` 编译通过
- [ ] `madge --circular` 无循环依赖
- [ ] 现有功能冒烟测试通过（Knot 聊天正常）
- [ ] 新接口有完整 JSDoc 注释
- [ ] DI 注册正确（`registerSingleton` / contribution）
- [ ] 可独立 merge 到 main（不依赖未完成的 Phase）
- [ ] 文件路径/命名符合 VSCode 源码规范

---

## 六、风险评估

| 风险 | 概率 | Phase | 影响 | 缓解措施 |
|------|------|-------|------|----------|
| P2 重构 agentChatService 导致 Knot 中断 | 高 | P2 | 🔴 | 先建 Driver 空壳 + 兼容桥接，逐步迁移；保持 sendMessage() 可用直到 Driver 完全接管 |
| Knot 插件化后 Token 丢失 | 中 | P3 | 🟡 | 编写 Settings 迁移脚本；新旧配置路径共存一个版本 |
| 工作区隔离内存占用过高 | 中 | P4 | 🟡 | Lazy 初始化 + 共享只读资源（如 Gallery 数据） |
| OS 层接口后期需大改 | 低 | P1 | 🔴 | P1 保持 minimal 接口，通过中间件扩展而非改接口 |
| 向量检索依赖外部服务 | 中 | P5a | 🟡 | 本地文件后端作为 fallback，向量检索可选 |
| Agent Loop 死循环 | 低 | P5c | 🟡 | maxLoopIterations 硬限制 + CancellationHub 超时 |
| Scheduler 误触发大量 Turn | 中 | P6 | 🟡 | executionPolicy 配置限流 + 全局并发上限 |
| Enhanced TaskBoard 性能（大量实时事件） | 中 | P7 | 🟡 | 虚拟列表 + 事件节流 + 按需展开子树 |

---

## 七、建议的即时行动（本周开始）

1. **立即执行 P0**（纯文档修改，零风险，1 周内完成）
2. **P0 完成后启动 P1**（接口定义不影响现有功能）
3. **P1@L1 完成后同时启动 P2 + P3**（最大化并行）
4. **每完成一个 Phase 做一次 integration 验证**（避免积累债务）

---

*本文档为任务拆分方案，配合 `OpenClaw-VSCode-Architecture-v2.md`（设计细节）和 `Architecture-Review-and-Restructuring.md`（Review 报告）使用。*
