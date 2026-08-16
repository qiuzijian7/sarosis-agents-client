# 生图管线与编排管线的分层架构设计

> 结论：**不必深度融合，采用「分层解耦 + 边界节点」**。本文档梳理现状、给出分层方案与分阶段执行计划。

---

## 1. 背景与结论

### 1.1 问题

本项目工作流编辑器在 LiteGraph 画布上同时承载了两类本质不同的管线：

| | 生图管线（ComfyUI 系） | 编排管线（Saros Agent 系） |
|---|---|---|
| 执行模型 | 静态 DAG，拓扑一次跑完 | 迭代式，LLM 决策下一步 |
| 控制流 | 无（无 if/loop/交互） | if/switch/loop/askUser |
| 数据流 | 张量（IMAGE/LATENT/MODEL） | 结构化 JSON（SAROS_JSON） |
| 确定性 | 幂等、可缓存 | 不确定（LLM 随机） |
| 后端 | ComfyUI / ComfyTV 引擎 | AgentLoop / provider 引擎 |

两者塞进同一个渲染/存储/执行框架，导致三类副作用：
- **渲染层**：schema 节点卡片与 react 节点卡片生命周期不同，出现「DOM 卡片消失」；
- **存储层**：字符串 id + `data` 语义字段 vs 数字 id + `widgets_values` 位置字段的适配；
- **执行层**：单节点需按 `kind` 路由到不同引擎，边界不清晰时易误连。

### 1.2 结论

开源主流（ComfyUI 官方 MCP/CLI/In-App Agent、n8n/Dify 工具节点）都是「编排层调用生图服务」的**分层解耦**，而非把编排节点混入生图节点图里执行。

本项目通过 **ComfyTV stage 已经实现了这个分层**（stage 本质是生图子流程的封装）。剩下的工作不是继续加深融合，而是**把分层的边界在类型校验、渲染生命周期、引擎就绪状态上落实**。

---

## 2. 现状架构

### 2.1 节点分类（`registry.ts` 的 `NodeKind`）

| kind | 含义 | 后端 | 例子 |
|------|------|------|------|
| `react` | Saros 编排节点 | provider/AgentLoop | `Saros.Start/End/Prompt/Agent/Tool/IfElse` |
| `schema` | ComfyTV 媒体 stage | ComfyTV | `ComfyTV.ImageStage/ImageLoaderStage` |
| `native` | ComfyUI 原生节点 | ComfyUI `/prompt` | `KSampler`（`/object_info` 动态注册） |
| `llm` | Provider 文生图 | provider | `Saros.ModelImageGen` |

`BackendKind = 'comfy' | 'provider'` 驱动 `runNodeOrStage` 的路由。

### 2.2 三层执行链路

```
编排层（react/llm 节点）──SAROS_JSON──▶ 桥接层（schema / ComfyTV stage）
                                              │
                                              ▼
                                       媒体层（native / ComfyUI 原生图）
```

- 编排节点**不直连** ComfyUI 原生节点，而是连 stage（子流程封装）。
- `ComfyTV stage` 就是「生图子流程容器」，对外只暴露 `resolution`/`prompt` 等参数。

### 2.3 现状校验点

- `LiteGraph.isValidConnection = isValidLiteGraphConnection`（`LiteGraphCanvas.tsx` L295）——**只有 type 级矩阵**（`isPortTypeCompatible`），**无跨层约束**。
- `canvasOps.ts` connect op（L223）——已有 type 校验，**同样无跨层约束**。
- 目前 `react` 节点可以直连 `native` 节点（跨层），这正是边界缺失的体现。

---

## 3. 分层方案

### 3.1 核心原则：**边界节点，而非边界系统**

保持单画布 UX，但在类型系统层面钉死边界。定义三个 Layer：

| Layer | 包含 kind |
|-------|-----------|
| `orchestration`（编排层） | `react`, `llm` |
| `bridge`（桥接层） | `schema` |
| `media`（媒体层） | `native` |

### 3.2 跨层连接规则

| 源 Layer → 目标 Layer | 允许 | 说明 |
|----------------------|------|------|
| orchestration → orchestration | ✅ | 编排节点互连 |
| orchestration → bridge | ✅ | 编排触发 stage |
| bridge → bridge | ✅ | stage 串联 |
| bridge → media | ✅ | stage 封装 native 图 |
| media → media | ✅ | ComfyUI 原生图内部 |
| **orchestration → media** | ❌ | **禁止跨越桥接层** |
| **media → orchestration** | ❌ | 禁止回灌（结果必须经 stage 输出） |

规则一句话：**编排层不能直连媒体层，必须经桥接层（stage）中转**。

---

## 4. 分阶段执行计划

### P0（已完成）—— 修复既有 bug
- [x] Combo 下拉框定位：`widget.last_y` → `widget.y`（LiteGraph 0.17 正确字段）
- [x] ComfyTV 注册时序：`ensureSarosRegistration()` 补 `registerDefaultComfyTVStages()`（修 DOM 卡片首帧消失）
- [x] esbuild 保留 `console.warn/error`（恢复运行时可观测性）
- [x] 5 类 DOM 消失诊断日志打点

### P1 —— 分层边界校验（✅ 已完成）
- [x] `registry.ts` 新增 `nodeLayer(kind)` + `canConnectLayers(srcKind, dstKind)` 纯函数
- [x] `canvasOps.ts` connect op 接入跨层校验（覆盖 agent 程序化建边）
- [x] `LiteGraphCanvas.tsx` 交互建边接入跨层校验（覆盖用户拖线，monkey-patch `LGraphNode.prototype.connect`，幂等）
- [x] 单元测试覆盖 4 类 × 4 类 = 16 种组合（`test/crossLayer.test.ts`，25 项全通过）

### P2 —— 引擎就绪门卫（✅ 已完成）
- [x] schema/native 节点在引擎未连接时显示「未连接」占位态，而非可执行但失败
- [x] 引擎（ComfyTV/ComfyUI runner）连接状态变化时刷新节点可执行态

### P3 —— 渲染层按 kind 分治（✅ 根因已通过 P0+P2 达成，独立模块重构降级）
- [x] schema 卡片生命周期绑定 `getNodeSpec(type)` 可用性 —— 通过 P0 时序修复达成
- [x] 根治「DOM 卡片先显示后消失」 —— 根因是「首次 configure 时 ComfyTV 未注册 → filterNodesForLiteGraph 丢弃 schema 节点」，P0 的 `ensureSarosRegistration()` 提前注册 `registerDefaultComfyTVStages()` 已解决
- [~] 独立 `schemaOverlay` 模块（**降级为可选优化**）：`syncOverlay` 已做到「spec miss 节点进 seen 不 unmount」；`loadComfyTVStages` 是覆盖式（非 unregister），不会导致 spec 短暂 miss。在根因已修复 + P2 引擎门卫 + 5 类诊断日志覆盖下，大重构风险 > 收益，暂缓。

### P4 —— 子工作流节点（✅ 已完成）
- [x] `Saros.Subflow` 节点：`subflow.ts` 模型层已完整（buildSubflowFromGraph/getSubflowPorts/substituteSubflow/flattenSubflows），折叠入口已存在（WorkflowEditorPanel 右键「折叠为子流程」）
- [x] 注册 `Saros.Subflow` spec（registry.ts，kind='react'）+ LiteGraph 节点类（sarosLiteGraphNodes.ts）+ `SAROS_NODE_TYPES` 白名单
- [x] `flattenSubflows` 已在 `runGraphExecution` 执行链路中（执行前展开子图）

---

## 5. 验收标准

1. **P1**：拖线时，编排节点连 native 节点被拒绝并给出明确提示；经 stage 中转则允许。
2. **P2**：断开 ComfyUI runner 后，schema/native 节点显示「未连接」，不可执行，但不从画布消失。
3. **P3**：任何时序下（含首帧、引擎注册延迟、store 重载），schema 节点 DOM 卡片不消失。
4. **P4**：一个完整生图子图可作为单个节点被编排工作流复用。
