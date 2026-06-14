# OpenClaw-VSCode-Architecture-v2.md 框架设计 Review & 目录重构方案

> **审阅日期**: 2026-05-09  
> **文档版本**: v1.5 (7911 行, 22 章)  
> **目标**: 识别结构问题，优化目录组织，输出可阶段实施、阶段验证的可行性方案

---

## 一、总体评审意见

### 1.1 核心架构评价

架构设计质量高，四层模型清晰合理：

```
UI (WebView) → Driver Layer → OS Layer (7 Slots) → Provider Plugins
                                                  ↓
                              Workspace Registry + Agent Instance Service
```

**优点**：
- OS 中间层 7 个能力槽位设计灵活可组合
- 驱动层与 OS 层分离，职责清晰
- 工作区完全隔离设计正确
- Agent 实例目录结构与 OpenClaw 兼容

**核心问题**：文档是**追加式增长**，不是**架构式组织**。22 章按时间堆积，存在严重的结构性问题。

### 1.2 十大结构问题

| # | 问题 | 严重性 | 位置 |
|---|------|--------|------|
| 1 | **接口体系分裂** — Ch4 定义 `IChatBackendPlugin`，Ch19 引入 `IAgentDriverService`，Ch4.1.5 定义 `IAgentOSService`，三套体系并存未统一 | 🔴 P0 | Ch4/Ch19 |
| 2 | **两个"总结"章节** — Ch15 和 Ch18 内容高度重复且都已过时（不含 Ch19-21 的内容） | 🟡 P1 | Ch15/Ch18 |
| 3 | **空占位章节** — Ch11 和 Ch12 仅一行引用 SVG 图片，无实际内容 | 🟡 P1 | Ch11/Ch12 |
| 4 | **重复内容** — 目录结构出现 3 次（Ch5.1, Ch5.4, Appendix B.2），插件对比表出现 2 次 | 🟡 P1 | Ch5/AppB |
| 5 | **迁移计划过时** — Ch8 仅覆盖"后端抽象重构"Phase 1，未涵盖 OS层/Driver层/工作区/实例化 | 🔴 P0 | Ch8 |
| 6 | **附录打断主体** — 附录 A/B 夹在 Ch9 和 Ch10 之间（Line 2799-3150），破坏阅读连续性 | 🟡 P1 | App A/B |
| 7 | **"无 Extension 策略"自相矛盾** — Ch2.2 声明不用 Extension，但 Ch4.2.4 和 Ch5 全部基于 `extensions/openclaw/` 目录 | 🟡 P1 | Ch2/Ch4 |
| 8 | **早期章节概念被后期推翻** — Ch4 的 `IChatBackend` 概念在 Ch19 被 `IAgentDriverService` 取代，但未标注废弃 | 🔴 P0 | Ch4/Ch19 |
| 9 | **实现细节过度** — 接口定义后紧跟完整实现代码（如 Ch13.6 升级机制 200+ 行实现），增加阅读负担 | 🟡 P1 | 多处 |
| 10 | **缺少依赖关系图** — 各 feature 之间的实现依赖关系不明确，无法看出什么先做什么后做 | 🔴 P0 | 全局 |

### 1.3 设计矛盾清单

| 矛盾点 | Ch A 说法 | Ch B 说法 | 建议采纳 |
|---------|-----------|-----------|----------|
| Extension 策略 | Ch2.2: 不用 Extension | Ch4/5: `extensions/openclaw/` | **采纳 Extension**（Ch19+ 确认了插件化方向） |
| 后端抽象模型 | Ch4.6: `IChatBackend` + `IChatBackendPlugin` | Ch19: `IAgentDriverService` + `IAgentOSService` | **采纳 Ch19+**（更成熟的四层模型） |
| 数据流入口 | Ch6: `AgentChatService → activeBackend.send()` | Ch19: `AgentDriverService.executeTurn()` | **采纳 Ch19**（Driver 统一入口） |
| OpenClaw 获取方式 | Ch4.4: npm 包 | Ch16: 引擎源码直接集成 | **两者并存**（Phase 依赖） |
| Gateway 模式 | Ch7: UtilityProcess 或外部进程 | Ch20: 每工作区独立 Gateway 实例 | **采纳 Ch20**（隔离性优先） |

---

## 二、推荐目录结构重组

### 2.1 新目录结构（从 22 章 → 4 Part + 12 章）

```
Part I — 基础与现状（只读参考，不产出代码）
  Ch1  项目现状与上游修改清单           ← 原 Ch1
  Ch2  架构设计原则                    ← 原 Ch2 (修正矛盾)
  Ch3  Agent Studio 现有架构分析        ← 原 Ch3

Part II — 核心架构设计（产出接口定义与核心服务）
  Ch4  四层架构总览                    ← 新写，综合 原Ch11/12/4.1.2/19.1
  Ch5  Agent OS 中间层                 ← 原 Ch4.1.3~4.1.7 (能力槽设计)
  Ch6  Agent Driver Layer（驱动层）     ← 原 Ch19
  Ch7  数据流与通信协议                 ← 原 Ch6 (更新为 Driver 入口)

Part III — 扩展机制设计（产出插件框架与具体 Provider）
  Ch8  能力插件体系                    ← 原 Ch4.2~4.3 (插件注册/适配器/Manifest)
  Ch9  Model Provider 与模型选择器      ← 原 Ch4.2.5 + Knot/DirectLLM 插件
  Ch10 Memory 机制                     ← 原 Ch13 (精简，移除实现代码)
  Ch11 Agent Runtime 机制              ← 原 Ch14 (精简)
  Ch12 MCP Gateway 远程工具调用         ← 原 Ch10

Part IV — 运行环境与实例管理（产出工作区基建）
  Ch13 多工作区独立运行                 ← 原 Ch20
  Ch14 Agent 实例化与工作区目录          ← 原 Ch21
  Ch15 Gateway 进程管理                 ← 原 Ch7 (更新为 per-workspace)
  Ch16 OpenClaw 引擎集成与功能适配       ← 原 Ch16+17 (合并精简)

附录
  A  配置全览                          ← 原 附录A (精简)
  B  Git 管理与分支策略                 ← 原 Ch9 (精简)
  C  版本历史                          ← 原 Ch22
```

### 2.2 删除/合并的内容

| 原章节 | 处理方式 | 原因 |
|--------|----------|------|
| Ch8 (迁移计划) | 🗑️ 删除 | 已被 Phase 实施方案取代 |
| Ch11 (架构总览 SVG) | 🗑️ 删除 | 空占位，用新 Ch4 的文字描述取代 |
| Ch12 (多客户端 SVG) | 🗑️ 删除 | 空占位，概念已融入 Ch12(MCP Gateway) |
| Ch15 (总结 1) | 🗑️ 删除 | 过时重复 |
| Ch18 (总结 2) | 🗑️ 删除 | 过时重复 |
| Appendix B | 📝 合并入 Ch8 | 插件依赖图属于插件体系章节 |
| Ch4.8 (旧方案对比) | 🗑️ 删除 | 只有历史参考价值，混淆读者 |
| Ch4.9~4.10 (实施步骤/风险) | 📝 移入 Phase 方案 | 属于执行层面 |

### 2.3 精简原则

1. **接口定义保留，实现代码移除** — 实现代码放到独立 `design-details/` 目录
2. **一个概念只出现一次** — 消除重复的目录结构图和对比表
3. **统一术语** — 全部使用 Ch19+ 的术语体系（Driver/OS/Provider/Instance）
4. **标注废弃** — 对 `IChatBackend`/`IChatBackendPlugin` 明确标注 `@deprecated`

---

## 三、阶段实施方案（5 个 Phase）

### 3.0 依赖关系图

```
Phase 1 ─────────────────────────────────┐
  OS 中间层接口定义                        │
  (IAgentOSService + 7 个能力槽接口)       │
                                          ▼
Phase 2 ───────────────────────┬── Phase 3 ────────────────────┐
  驱动层实现                     │   Model Provider 插件          │
  (IAgentDriverService           │   (Knot AG-UI 迁移)           │
   + Turn 生命周期管理)          │                                │
                                 │                                ▼
                                 │                   Phase 4 ────────────────
                                 │                     工作区隔离 + 实例化
                                 │                     (Registry + Instance)
                                 │                                │
                                 └────────────────────────────────▼
                                                       Phase 5
                                                         Memory/Tool/Planning
                                                         Provider 插件
```

---

### Phase 1：OS 中间层骨架（1~2 周）

**目标**：建立 `IAgentOSService` 核心接口和空壳实现，所有能力槽可注册但暂时无 Provider。

**产出文件**：
| 文件 | 内容 |
|------|------|
| `sessions/contrib/agentStudio/common/agentOS.ts` | `IAgentOSService` 接口 |
| `sessions/contrib/agentStudio/common/providers.ts` | 7 个 Provider 接口定义 |
| `sessions/contrib/agentStudio/common/modelSelector.ts` | `IModelSelectorService` 接口 |
| `sessions/contrib/agentStudio/common/adapters.ts` | `BaseProviderAdapter` 基类 |
| `sessions/contrib/agentStudio/common/errors.ts` | `AgentOSError` 定义 |
| `sessions/contrib/agentStudio/browser/agentOSService.ts` | `AgentOSService` 实现（空壳 + 注册逻辑） |
| `sessions/contrib/agentStudio/browser/slotRegistry.ts` | 能力槽注册表 |

**验证标准**：
- ✅ DI 注入成功，`IAgentOSService` 可获取实例
- ✅ `registerModelProvider()` / `registerMemoryProvider()` 等方法可调用
- ✅ 无 Provider 时 `getActiveXxxProvider()` 返回 `undefined`
- ✅ 现有 Knot 聊天功能不受影响（OS 层暂时不接入数据流）
- ✅ 编译通过，无 circular dependency

**关键决策**：
- OS 层放在 `sessions/contrib/agentStudio/` 内（不新建顶层目录）
- 能力槽接口设计为 `readonly` + `Event`，便于响应式更新

---

### Phase 2：驱动层实现（2~3 周）

**目标**：实现 `IAgentDriverService`，作为 UI → OS 之间的统一入口。将现有 `AgentChatService.sendMessage()` 重构为委托 Driver。

**依赖**：Phase 1 完成

**产出文件**：
| 文件 | 内容 |
|------|------|
| `sessions/contrib/agentStudio/common/agentDriver.ts` | `IAgentDriverService` 接口 |
| `sessions/contrib/agentStudio/browser/agentDriverService.ts` | 驱动层实现（编排 + Loop + 流控） |
| `sessions/contrib/agentStudio/browser/agentChatService.ts` | ✏️ 重构为薄壳，委托 Driver |
| `sessions/contrib/agentStudio/browser/agentStudioWebviewController.ts` | ✏️ 路由到 Driver |

**核心行为**：
```
用户消息 → WebviewController → DriverService.executeTurn()
  → OS.getActivePlanningProvider()?.analyzeIntent()
  → OS.getActiveMemoryProvider()?.loadContext()
  → OS.getActiveModelProvider().chat()  ← 首轮直接透传
  → OS.getActiveToolProvider()?.executeTool()  ← 按需
  → OS.getActiveMemoryProvider()?.writeMemory()
  → yield IChatStreamDelta
```

**验证标准**：
- ✅ 用户发消息走 Driver → OS → Model Provider 路径
- ✅ 无 Memory/Tool/Planning Provider 时 Driver 退化为"直通模式"（等效现状）
- ✅ 现有 Knot 聊天功能通过 Driver 正常工作
- ✅ `cancelTurn()` 可中断正在执行的 Turn
- ✅ 流式输出正常（16ms 帧节流保持）
- ✅ WebView UI 无感知变化

**关键决策**：
- Driver 不持有会话状态（无状态设计），状态由 `AgentStudioService` 管理
- 兼容模式：若 OS 层只有 Model Provider（无 Execution Provider），Driver 自行编排简单 Loop

---

### Phase 3：Model Provider 插件化（2 周）

**目标**：将现有 Knot 硬编码逻辑抽取为 `IModelProvider` 插件，实现模型选择器 UI。

**依赖**：Phase 1 完成（Phase 2 可并行）

**产出文件**：
| 文件 | 内容 |
|------|------|
| `extensions/knot-agui/package.json` | Knot 插件 Manifest |
| `extensions/knot-agui/src/extension.ts` | 插件入口 |
| `extensions/knot-agui/src/knotModelProvider.ts` | `IModelProvider` 实现 |
| `extensions/knot-agui/src/knotAGUIClient.ts` | AG-UI 协议客户端（从 agentChatService 迁移） |
| `sessions/contrib/agentStudio/browser/modelSelectorService.ts` | 模型选择器服务 |
| WebView: `features/modelSelector/` | 模型选择器 UI 组件 |

**验证标准**：
- ✅ Knot 代码从 `agentChatService.ts` 完全解耦
- ✅ Knot 插件通过 `registerModelProvider()` 注册到 OS 层
- ✅ 模型选择器 UI 展示所有可用 Provider 和模型
- ✅ 切换模型后新对话使用新模型
- ✅ Token 未配置时显示引导提示
- ✅ 无 Knot Token 时编辑器仍可正常启动

---

### Phase 4：工作区隔离 + Agent 实例化（2~3 周）

**目标**：实现多工作区完全隔离和 Agent 实例拖拽创建。

**依赖**：Phase 2 完成

**产出文件**：
| 文件 | 内容 |
|------|------|
| `sessions/contrib/agentStudio/common/workspaceRegistry.ts` | `IWorkspaceRegistry` 接口 |
| `sessions/contrib/agentStudio/common/agentInstance.ts` | `IAgentInstanceService` + `IAgentGalleryService` 接口 |
| `sessions/contrib/agentStudio/browser/workspaceRegistryService.ts` | 注册表实现 |
| `sessions/contrib/agentStudio/browser/agentInstanceService.ts` | 实例化实现 |
| `sessions/contrib/agentStudio/browser/agentGalleryService.ts` | Gallery 实现 |
| `.saros/agents/{id}/agent.yaml` | Agent 实例配置（模板） |
| WebView: `features/gallery/` | Agent Gallery 面板 |

**验证标准**：
- ✅ 多工作区注册/注销正常
- ✅ 工作区间资源完全隔离（各自 OS + Driver 实例栈）
- ✅ Gallery 面板可展示预设模板
- ✅ 拖拽模板到工作区创建实例，目录结构正确
- ✅ 删除实例清理目录
- ✅ `.saros/agents/` 目录结构与 OpenClaw 兼容

---

### Phase 5：高级 Provider 插件（3~4 周，可增量）

**目标**：按需实现 Memory / Tool / Planning / Execution / Kanban Provider。

**依赖**：Phase 1 + Phase 2 完成

**5a. Memory Provider（1~2 周）**
| 产出 | 内容 |
|------|------|
| `extensions/openclaw/src/adapters/memoryAdapter.ts` | `IMemoryProvider` 实现 |
| Memory 存储后端 | 文件/向量 DB 双后端 |
| 验证 | 对话后记忆可写入/检索，Driver 加载上下文 |

**5b. Tool Provider / MCP Gateway（1~2 周）**
| 产出 | 内容 |
|------|------|
| `extensions/openclaw/src/adapters/toolAdapter.ts` | `IToolProvider` 实现 |
| MCP Gateway 集成 | 对接已有 `McpGatewayService` |
| 验证 | Agent 可调用本地 MCP 工具，tool_start/args/end 事件正常 |

**5c. Planning + Execution Provider（2 周）**
| 产出 | 内容 |
|------|------|
| Planning Adapter | 意图分析 + 任务分解 |
| Execution Adapter | Agent Loop (Plan→Act→Observe→Reflect) |
| 验证 | 多步任务自动规划执行，Kanban 同步更新 |

---

## 四、各 Phase 验证检查表

### 每阶段通用验收标准

- [ ] 编译通过（`npm run compile`）
- [ ] 无 circular dependency（`madge --circular`）
- [ ] 现有功能不退化（冒烟测试）
- [ ] 新接口有 JSDoc 注释
- [ ] DI 注册正确（`registerSingleton` / `contribution`）
- [ ] 可独立 merge 到 main

### Phase 完成度定义

| Level | 含义 | 标准 |
|-------|------|------|
| L0 | 接口定义 | .ts 文件存在，类型完整，编译通过 |
| L1 | 空壳实现 | DI 可注入，方法返回空/默认值 |
| L2 | 功能实现 | 核心路径可用，无 edge case 处理 |
| L3 | 生产就绪 | 错误处理、日志、超时、重试完备 |

---

## 五、风险评估与缓解

| 风险 | 概率 | Phase | 影响 | 缓解 |
|------|------|-------|------|------|
| Phase 2 重构 agentChatService 导致 Knot 功能中断 | 高 | P2 | 🔴 | 先建 Driver 空壳 + 兼容桥接，逐步迁移 |
| Knot 插件化后 Token 丢失 | 中 | P3 | 🟡 | Settings 配置迁移脚本 |
| 工作区隔离引入内存占用过高 | 中 | P4 | 🟡 | Lazy 初始化 + 共享只读资源 |
| OpenClaw npm 包未发布 | 高 | P5 | 🔴 | 先用 git submodule / 本地链接 |
| OS 层接口不够灵活需大改 | 低 | P1 | 🔴 | P1 保持接口 minimal，后续逐步扩展 |

---

## 六、建议的即时行动

1. **统一术语表**：创建 `GLOSSARY.md` 明确 Driver / OS / Provider / Instance / Workspace 的关系
2. **标记废弃**：在原文档 Ch4.6 的 `IChatBackend`/`IChatBackendPlugin` 加 `@deprecated` 注解
3. **消除空章**：删除 Ch11、Ch12 的占位内容
4. **合并总结**：删除 Ch15、Ch18，在文档末尾只保留一个精简总结
5. **拆分文档**：将 7911 行拆为主文档（接口+架构）+ 参考文档（实现细节）

---

## 七、推荐开始点

> **建议从 Phase 1 开始**：定义 OS 层接口是所有后续工作的基础。
> 耗时短（1~2 周），风险低（不改变现有行为），且一旦完成，Phase 2/3/5 可并行。

Phase 1 的第一个 PR 应该是：
```
+ sessions/contrib/agentStudio/common/agentOS.ts
+ sessions/contrib/agentStudio/common/providers.ts
+ sessions/contrib/agentStudio/common/errors.ts
+ sessions/contrib/agentStudio/browser/agentOSService.ts (空壳)
+ sessions/contrib/agentStudio/browser/slotRegistry.ts
∼ sessions/contrib/agentStudio/browser/agentStudio.contribution.ts (注册 OS Service)
```

验证通过后即可开始 Phase 2 和 Phase 3 的并行开发。

---

*本文档为架构 Review 报告，不修改原始架构文档。建议基于此方案进行文档重组后，再开始编码实施。*
