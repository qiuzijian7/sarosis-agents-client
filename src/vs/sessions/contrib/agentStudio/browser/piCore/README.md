# ⚠ 已废弃（DEPRECATED）—— 请用 `../piLoop/`

> **本目录（piCore）已于 2026-09-19 晚并入 `../piLoop/`（今早的 pi 手工复刻）。**
> 收口决策：保留 piLoop 为内核（可读 / 可逐行对上游 diff / 20 项行为测试 / 真实接口），
> 本目录独有的 EventAdapter（聊天契约缝）+ hostBridge + 对拍测试已**移植进 piLoop**
> （`piLoop/eventAdapter.ts`、`piLoop/hostBridge.ts`、`test/browser/piLoopDualRun.test.ts`）。
> ⚠ 本目录曾被安全护栏拒绝删除（trash-failed）⇒ 暂留存作参考，**请勿在其中新增/修改代码**；
> 由人工在文件管理器里删除整个 `piCore/` 目录即可。
> 设计文档仍以 `doc/agentloop-pi-core-redesign.md` 为准（六件套思路不变，落点改为 piLoop）。

---

# piCore —— pi 作为 agentloop 核心的适配层

> 设计文档：`doc/agentloop-pi-core-redesign.md`（目标 / 六件套 / 兼容矩阵 / 迁移路线）。
> 上游：[`@earendil-works/pi-agent-core@0.85.1`](https://github.com/earendil-works/pi)（MIT）。

## 这是什么

用 pi 的**轻量 agent loop**（`agentLoop` / `Agent`）替换 `executeAgentTurnDirect` 的**内核**，
**对外契约 `IChatStreamDelta` 不变** ⇒ 聊天框 UI / 会话 / 审批 / 代码库 / 记忆 **零改动**。

```
聊天框 / agentChatService（canonical）        ← 不动
        │  IChatStreamDelta（不变）
        ▼
PiTurnDriver = 六件套适配层（本目录）
        ├─ streamFnAdapter   我方 LMBridge 流  →  pi StreamFn
        ├─ eventAdapter      pi AgentEvent     →  我方 IChatStreamDelta
        ├─ toolAdapter       我方工具 + MCP    →  pi AgentTool
        ├─ contextAdapter    convertToLlm + 压缩/记忆注入（P1）
        ├─ stateAdapter      pi turn ↔ AgentRunState（P1）
        └─ guardrailBridge   我方护栏族 → pi beforeToolCall / agentLoopContinue（P1）
```

## 目录

```
piCore/
  streamFnAdapter.ts    （核心适配器，已实现）
  eventAdapter.ts       （核心适配器，已实现）
  toolAdapter.ts        （已实现：JSON Schema 透传 + execute 委托 + isError→throw）
  contextAdapter.ts     （convertToLlm 已实现；压缩/记忆注入 TODO P1）
  stateAdapter.ts       （骨架，P1）
  guardrailBridge.ts    （骨架，P1）
  piTurnDriver.ts       （craft 最小路径驱动，已实现）
  index.ts
  vendor/               ← vendored pi 内核（见 vendor/VENDORED.md：来源 / 改动 / 许可）
    piAgentLoop.bundle.ts   ← esbuild 从 checkout 源码打包的自洽 bundle（含 typebox 校验；@ts-nocheck）
    piLoop.ts               ← 对 bundle 的类型化包装（唯一类型边界）
    build-pi-bundle.mjs     ← 打包脚本（升级 pi 时重跑）
```

## ⚠ 打包约束（本目录的硬规则）

1. **桌面 renderer 不能裸引 npm 包**：本仓 `out/` 产物里 **0 条**裸 npm 导入（构建会改写/打包所有
   npm 依赖）⇒ 运行时的 ESM loader 无法解析 bare specifier。
2. **pi-agent-core 的根入口会连带 harness**（`harness/session`=fs、`harness/tools`=child_process），
   且其 `exports` 映射**没有** `./agent-loop` 子路径。

⇒ 因此本目录的铁律是：**类型** `import type`（运行时擦除）⇒ 不产生对 npm 的运行时依赖；
**运行时**只从 `./vendor/*`（相对路径）取。**不要**在本目录写 `import { … } from '@earendil-works/…'`
（值导入）；发现即视为破坏打包约束。

## 状态

- **P0（本次）**：适配层骨架 + 两个核心适配器 + vendored 内核 + 单测。**未接 `executeAgentTurnDirect`**。
- **P1**：内核替换（`agentloop.core=legacy|pi` 双跑对拍，现有 81 套 1871 例测试全绿为准入）。
- **P2**：吸收 pi 增强（存储不变量测试族 / 写类工具三段式 / 结构化遥测 / 分支摘要 / effect-gate）。
