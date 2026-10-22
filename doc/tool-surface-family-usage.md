# 工具面族级用量：**谁占地方、谁真被用**（2026-10-21 真机实测）

> 目的：给"还要不要继续收敛"提供**数据依据**，而不是感觉。
> 数据源：① 最近一次 native 请求的**真实 wire 头**（工具 schema 的真实字符，不是估算）；
> ② 现行 `denyTools`（从 `preset-vssaros.rows.yml` 读，不手抄）；
> ③ 全部真机会话日志里的 `tool/call`（29 个有请求的会话，累计 958 次调用）。

## 0. 当前可见工具面（已含 denyTools）

```
可见面 ≈ 23,454 tok（159 个工具的 wire 形状）
已隐藏：comfy 39 个 ≈15.5k + memory 19 个 ≈3,695   ← 合计省掉 ≈19.2k（占原始 42.3k 的 45%）
```

## 1. 族级账（面 token vs 真实调用）

| 族 | 可见工具 | 面 token | 占比 | 调用 | 判定 |
|---|---|---|---|---|---|
| core（单工具：pwsh/read/grep/glob/edit…） | 16 | 4,595 | 19.6% | **820** | 保留（绝对主力） |
| `codebase_*` | 21 | 3,695 | 15.8% | 2 | 保留（本文另述：样本偏差） |
| `kb_*` | 13 | 2,568 | 10.9% | **114** | 保留 |
| 其它（单工具） | 5 | 1,503 | 6.4% | 4 | 保留 |
| **`kanban_*`** | 13 | **1,497** | 6.4% | 0 | ★ 大头但 0 调用 ⇒ **能力类**（见 §3） |
| `unreal_*` | 7 | 1,005 | 4.3% | 1 | 保留（Unreal 场景） |
| **`workflow_*`** | 7 | **919** | 3.9% | 0 | ★ 大头但 0 调用 ⇒ **场景类** |
| **`feishu_*`** | 5 | **887** | 3.8% | 0 | ★ **零损失可藏**（通道未配置 ⇒ 调了必失败 ✓） |
| `memory_*` | 4 | 666 | 2.8% | 0 | 已收拢（19 个已藏，2026-10-21） |
| `skill_*` / `web_*` / `video_*` / `list_*` / `subagent_*` / `mcp_*` / `dashboard_*` / `image_*` / `extract_*` / `text_*` / `vision_*` / `create_*` / `send_*` / `open_*` / `interrupt_*` / `media_*` / `exit_*` / `show_*` / `session_*` / `taskboard_*` / `update_*` / `get_*` | 1–4 each | 25–500 each | ~1% each | 0 | 零散小族 |

调用最多的工具：`pwsh` 505 · `read` 192 · `kb_search` 40 · `browser` 36 · `kb_write_note` 22 · `kb_list` 20 · `edit` 19 · `kb_read` 17 · `grep` 16 · `glob` 14。

## 2. ⚠ 样本偏差（读这张表前必须知道）

这 29 个会话里，**绝大多数不是代码/看板任务**（是知识库、记忆、文档、浏览器）⇒
**"某族 0 调用"≠"该族无用"**：
- `codebase_*` 只 2 次调用，是因为这些会话**没问代码**（我们刚做完交接，代码类会话还没在日志里出现）；
- `kanban_*` / `workflow_*` 0 调用同理 —— 没人在这批会话里用看板/编排。
⇒ **正确用法**：这张表只用来判断"**能不能无损地藏**"（藏了会不会让人做不了事），
**不能**用来判断"这个族有没有价值"。

## 3. 三档处置建议（按"藏了会不会丢人"排序）

| 档 | 族 | 收益 | 风险 | 判据 |
|---|---|---|---|---|
| **A：立刻可做（零损失）** | `feishu_*` | **-887 tok（3.8%）** | **无** —— 通道未配置 ⇒ 工具调用必然失败 | 已在 `denyTools` 落地（agents 0.2.101）；将来接了飞书就删这行 |
| **B：场景类（用 preset 分层）** | `workflow_*`（919）· `unreal_*`（1,005）· `video_*`/`image_*`/`vision_*`/`media_*`（862）· `dashboard_*`（195）· `web_*`（417）· `mcp_*`（261）· `skill_*`（493） | **≈4.4k（19%）** | 需要时切 preset | **建 `vssaros-lite` preset**（插件级不挂 ⇒ 工具**根本不注册** ⇒ 不占 schema；full preset 仍可用 ⇒ 能力不丢 ✓） |
| **C：能力类（**不要**在默认 preset 藏）** | `kanban_*`（1,497）· `memory_*`（4 个可见）· `codebase_*`（3,695）· `kb_*`（2,568） | — | 藏 = **剥夺能力**（看板/记忆/代码图谱/知识库是随时可能被要的） | 只在 **lite preset** 里不挂（能力仍在 full preset ✓） |

## 4. 建议的下一步

1. **A 档已落地**（`feishu_*` 进 denyTools，agents 0.2.101）⇒ 需重启 Host 才生效。
2. **B 档（lite preset）** 是真正的下一步：它把"场景专用"的插件在**插件级**摘掉
   （而不是 mask 掉）⇒ 工具不注册 ⇒ 不占 schema；**能力不丢**（full preset 里照常）✓
   ⇒ 预计省 **≈4.4k tok/会话（19%）**。
   ⚠ 实现要点：① 只能摘**纯工具插件**（有页面/路由的摘了会 `never started` ⇒ 会话打不开）；
   ② 需要一条"lite ⊂ full"的守卫（防止 lite 里少得连自己都不完整）；
   ③ 与 PTC 那条一样要保证"**只有一个变量**"（lite vs full 只差被摘的行）⇒ 才好归因。
3. **要更准的用量数据**：按**场景**分层统计（代码类会话里的 `codebase_*` 调用率、看板类会话里的 `kanban_*`）
   ⇒ 现在这张表是"混着"的，不能用来判"有用没用"。

## 5. 怎么复现

```bash
npm run ab:dsh-session -- --last 4      # 会话级：preset / toolsTokens / 命中 / 步数
```

- wire 头：`<dshHome>/sessions/<ws>/<id>/session.v4.jsonl.zstd`（**多帧 zstd** ⇒ 走
  `vssaros-sessions/lib/core/sessionLog.js` 的 `decodeZstdFrames`；单帧解码器只解第一帧 ✗）。
- 运行时自算的账：`<dshHome>/storages/session_projcache/sessions/<id>.json`
  （`record.rows.<key>.val.contextBreakdown.breakdown` / `tokenUsage.totals` / `sessionStats`）。
- 现行 denyTools：`dsh-plugins/vssaros-agents/preset-vssaros.rows.yml`（**唯一真源** ✓）。
