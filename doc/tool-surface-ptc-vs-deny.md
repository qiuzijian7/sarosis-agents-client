# 工具面收敛：PTC vs denyTools —— 真机实测账（2026-10-21）

> 结论先说：**PTC 在我们这个形态下是净负优化**；真正有效的是已经落地的 **0 档 `denyTools`**。
> 本文所有数字都来自**真机会话日志 + 运行时自算的上下文账**（不是估算）。

## 1. 两条会话（同一聊天、相邻时间、同一模型）

| 指标（运行时自算） | **PTC**（preset=`ptc`） | **native**（preset=`vssaros-standard`，16:3x） | native（10-20，老基线） |
|---|---|---|---|
| 可见工具数 | **1**（`run_code`） | **159** | 196 |
| 其中 `mcp__comfy-mcp__*` | 0 | **0** ✓（denyTools 已生效） | 39 ⚠ |
| `toolsTokens` | **628** | 27,196 | 42,301 |
| `systemTokens` | **56,909** ⚠ | 5,866 | 5,737 |
| `messageTokens` | 1,542 | 2,463 | 74,181 |
| `surfaceTokens` | **58,451** | 8,329 | 79,725 |
| 缓存命中 | **0.8%** | 35.0% | 91.8% |
| 步数 / 工具调用 | 1 步 / **0** | 2 步 / 0 | 63 步 / 88 |

（老基线那条是 10-20 的 63 步会话，**含 39 个 comfy 工具** ⇒ 它是 denyTools 生效**之前**的账。）

## 2. PTC 到底做了什么（拆开看）

| 维度 | native | PTC | 判定 |
|---|---|---|---|
| 工具 schema | 159 份，共 27,196 tok | **1 份**（`run_code`），628 tok | ✅ **-97.7%**（PTC 的承诺，达成了） |
| SDK 文本 | — | 进 **system**，把 system 从 5,866 顶到 **56,909**（×9.7） | ⚠️ **它比 schema 更长** |
| 单步总上下文 | 8,329 | **58,451（×7.0）** | ❌ **净负优化** |
| 前缀缓存 | 35% | **0.8%** | ❌ SDK 文本在 system 里会变 ⇒ 缓存基本失效 |
| 我们的模块 | `codebase_*` 21 个 + memory/kb/kanban… 都在 | **一个都没有**（只有 `run_code`） | ❌ 官方 `ptc` preset **不含我们的模块** ⇒ 能力直接消失 |

⇒ **PTC 省的"每工具一份 schema"，换来的是"一份巨大的 SDK 文本进 system"**。
它适合"**工具少而深**"的场景（少数几个大工具）；我们是"**工具多而分散**"（159 个、每族 6–23 个）⇒ 负优化。

## 3. 真正生效的是 0 档 `denyTools`（已上机）

`preset-vssaros.rows.yml` 的 `vssaros-agents` 行：`denyTools: ['mcp__comfy-mcp__*']`
⇒ `ctx.tools.restrict({deny})`：**MCP 照连、工具照注册、审批照旧，只是不进模型目录**。

真机效果（16:3x 的 native 会话 vs 10-20 的老基线）：

```
可见工具   196 → 159（-37）        toolsTokens  42,301 → 27,196（-35.7%）
system 不变（5,737 → 5,866）        缓存命中 91.8% → 35.0%（老会话长得多，不可比）
```

⇒ 它的收益结构与 PTC **正好相反**：**砍掉模型可见面，不动 system、不伤缓存** ✓。

## 4. 结论与下一步

1. **默认继续用 native + denyTools**（当前形态最优）。
2. **PTC 别直接上**；若还要评估，必须用 **`PTC (VsSaros)`**（`vssaros-ptc` = 我们的模块 + PTC），
   否则测的是"官方工具集 + PTC"，**不是我们的部署** ⚠。
3. 即便换成 `vssaros-ptc`，SDK 会覆盖我们 159 个工具 ⇒ SDK 文本预计 ≥ 27k tok
   ⇒ **PTC 大概率仍是负优化**（除非同时做"按需激活 + defer"，那是 1 档协议的工作量）。
4. **下一步更值得做的**：把 denyTools 的范围按**族**再收（例如 `memory_*` 23 个 / `codebase_*` 21 个 /
   `kanban_*` 13 个 / `kb_*` 13 个）—— 每一族都可以先用 `watch-metrics`/会话账量"被调用了几次"，
   再决定藏不藏（**按实际使用率藏，而不是按感觉** ✓）。

## 5. 怎么复现这份账

```bash
npm run ab:dsh-session -- --last 4        # 最近几条会话的 preset / toolsTokens / 命中 / 步数
node scripts/dsh-session-ab.mjs --json    # 结构化输出（便于做趋势）
```

会话日志在 `<dshHome>/sessions/<ws>/<id>/session.v4.jsonl.zstd`（**多帧 zstd**，必须走
`vssaros-sessions/lib/core/sessionLog.js` 的 `decodeZstdFrames`；单帧解码器只解第一帧 ✗）。
运行时自算的账在 `<dshHome>/storages/session_projcache/sessions/<id>.json`
（`record.rows.<key>.val.contextBreakdown.breakdown` / `tokenUsage.totals` / `sessionStats`）。
