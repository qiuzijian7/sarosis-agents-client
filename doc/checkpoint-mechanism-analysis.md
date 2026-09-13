# 检查点（Checkpoint）机制：开源方案对比与本项目优化建议

> 调研时间：2026-09-12
> 本项目基线：`src/vs/sessions/contrib/agentStudio/**`、`src/vs/sessions/contrib/worktree/**`
> 开源对照：Claude Code、Cline、Aider、Codex CLI（含第三方 agent-rollback）

---

## 0. 摘要（先看结论）

| 维度 | 本项目 | 业界最佳 | 差距 |
|---|---|---|---|
| **触发时机** | 工具写盘**前** + 每轮对话锚点 + 手动 + 工作流每节点 | Claude Code：每轮提示前 | ✅ **本项目更细** |
| **快照粒度** | 单文件全量文本 | Claude Code：内容寻址 + 引用计数 | ❌ 无压缩/无去重 |
| **恢复模式** | 代码+对话 / 仅代码（keepAll） | Claude Code：**6 种**（含仅对话、两种 summarize） | ❌ 缺「仅回退对话」 |
| **配额与淘汰** | **完全没有** | Claude Code：最近 100 个 + 30 天清扫 + 引用计数删除 | ❌ **最大风险** |
| **清理闭环** | 会话删除不清理、临时 diff 目录不清理 | Claude Code：保留期清扫 | ❌ 磁盘泄漏 |
| **工作流断点** | ✅ 节点级 resume | 开源 agent **普遍没有** | ✅ **本项目独有** |
| **体系数量** | 4 套（含 1 套死代码），零复用 | Cline：1 套；Claude Code：1 套 | ❌ 认知/维护成本 |

**一句话**：本项目的**触发粒度与工作流断点领先业界**，但**生命周期管理（配额/淘汰/清理）几乎空白**，且恢复模式比 Claude Code 少一档。优化优先级应放在 P0（生命周期）而非 P2（体验）。

---

## 1. 本项目现状

### 1.1 四套并存的体系

| # | 体系 | 存储 | 粒度 | 触发 | 恢复 | 使用方 |
|---|---|---|---|---|---|---|
| ① | **agentStudio 检查点** | JSON 文件<br>`.sarosworkspace/checkpoints/<agentId>/<sessionId>/{index.json, snapshots/*.json}` | **单文件全量内容** | 工具写盘前 / 每轮锚点 / 手动 | 写回或删除 + ghost 标记 | `NativeChatEditorPane`、webview 控制器 |
| ② | **worktree 检查点** | git ref<br>`refs/vssaros/checkpoints/<sessionId>/{baseline, request-<id>}` | **整棵工作树** | 请求开始/结束 / 手动 | `git reset --hard` | copilot 会话、agentHost 会话 |
| ③ | **VS Code 原生 chatEditing** | 内存时间线 + baseline | 编辑会话内文件 | 编辑请求 / undo stop | `navigateToCheckpoint` | 核心 chatEditing |
| ④ | **工作流断点** | JSON<br>`checkpoints/{executionId}.json` | 节点状态 + context + sharedMemory | 每节点成功后 | `resumeFromCheckpoint` 复用 completed | 工作流执行服务 |

**关系**：并列、互补、**代码零共享**。①管「聊天里 agent 改了哪些文件」；②管「整树在每轮请求前后的 git 状态」；③管「编辑器内 undo/redo」；④管「工作流崩溃续跑」。

### 1.2 关键实现细节（体系 ①）

- **数据结构**（`common/checkpointTypes.ts`）：`ICheckpoint{ id, agentId, sessionId, type:'user_edit'|'tool_edit', label, createdAt, fileSnapshotIds[], isGhost, messageId, files[] }`；`IFileSnapshot{ id, checkpointId, uri, languageId, content /*全量*/, existedBefore? }`
- **无压缩、无去重**：每次编辑生成新的 `snapshots/<uuid>.json`，内容是文件**完整文本**（`browser/checkpointService.ts:298-316`）
- **`existedBefore=false`** 语义正确：新建文件回退时**删除**而非写空（`:370-380, 423-431`）
- **聚合时逻辑去重**：回退取每个 URI 的**最早**快照（`getAggregatedFileSnapshots:531-556`、`revertAllCheckpoints:469-524`）
- **ghost 机制**：回退后把更晚的检查点标 `isGhost`（不删除，可追溯），ghost 不参与聚合与 UI
- **对话不进快照**：仅以 `messageId` 关联，对话历史由 `agentChatService` 独立持久化
- **diff 预览**：单文件写临时文件到 `.sarosworkspace/checkpoint-diffs/<checkpointId>/` 再开内联 diff；多文件用 MultiDiffEditor

### 1.3 已识别的缺口（按严重度）

**A. 生命周期完全空白（最严重）**
1. **无配额/无上限/无淘汰/无 TTL** —— 全仓无 `maxCheckpoints`、无 LRU、无 prune（grep 0 命中）
2. **会话删除不清理检查点**：`nativeChatEditorPane.ts:1357-1385` 仅重置 UI（`setCheckpoint(null)`），磁盘数据保留
3. **临时 diff 目录无清理**：`.sarosworkspace/checkpoint-diffs/` 无任何清理代码

**B. 静默失败点（排障黑洞）**
4. 无 active session 时 `captureBeforeToolEdit` 直接 return（`browser/checkpointService.ts:97-101`）
5. 不可读文件静默跳过（`:65-66, 381-383`）
6. `CheckpointManager.handleAction` / `refreshBar` 空 `catch` 吞错（`checkpointManager.ts:83-85, 119-121`）
7. **`agentStudio.openCheckpointDiff` 命令全仓未注册** → 原生「查看变更」动作静默失效（`:111-118`）
8. 工作流检查点保存 best-effort，失败仅日志（`workflowExecutionService.ts:1414`）

**C. 覆盖盲区（用户可能被误导）**
9. `execute_code` / `terminal` 走 shell **不创建检查点**，仓库可被改而无回滚点（`executeCodeGuards.ts:477-483`）
10. `move/rename` 只快照目标文件，原路径消失 → **无法回滚**（`toolApprovalPolicy.ts:48-50`）

**D. 代码卫生**
11. **死代码**：`node/checkpointService.ts` + `node/checkpointStorage.ts`（SQLite 版，无运行时引用）；`checkpointCard.ts` 的 `createCheckpointDetailCard` 无调用方
12. **接口签名漂移**：`ICheckpointService.createCheckpointFromUris` 的 `opts` 未声明 `files`，实现却接受（`common/checkpointService.ts:78` vs `browser:349`）
13. **worktree browser/node 双实现逐行重复**（`browser:26-150` vs `node:20-146`）
14. webview `CheckpointBar.tsx` 源码在本检出缺失（仅 bundle 内有）

---

## 2. 开源方案横向对比

### 2.1 Claude Code（能力最完整，最值得对标）

| 维度 | 做法 |
|---|---|
| **存储** | 会话级快照，与对话一起保存（`resume` 后仍可 `/rewind`） |
| **触发** | **每条开启新回合的提示前**自动快照；回合中途加入的消息**不建点** |
| **恢复** | `/rewind`（输入框空时连按两次 `Esc`）**6 种操作**：<br>① Restore code and conversation ② Restore conversation（保留代码）③ Restore code（保留对话）④ Summarize from here ⑤ Summarize up to here ⑥ Never mind |
| **配额** | **每会话保留最近 100 个 checkpoint** |
| **淘汰** | 丢弃旧 checkpoint 时，删除**不再被任何剩余 checkpoint 引用**的快照文件 |
| **例外** | **每个文件的第一个快照永久保留** —— VS Code 扩展用它作会话 diff 基线 |
| **保留期** | 最后一次保存快照后**约 30 天**清扫；可配 `cleanupPeriodDays` |
| **失败语义** | 快照已消失时回退报 `No files were restored`（**显式失败**，不静默） |
| **明确限制** | ① bash 命令的改动（`rm/mv/cp`）**不跟踪** ② 后台子代理编辑**不恢复** ③ 外部/并发会话改动不跟踪 ④ 符号/硬链接路径跳过并提示 `Restored the code, but skipped N files` ⑤ 明确声明「不能替代版本控制」 |

**可借鉴的精华**：引用计数式淘汰 + 「每文件首快照保留」的 diff 基线巧思 + 恢复模式矩阵 + **显式失败而非静默**。

### 2.2 Cline（影子 git 仓库）

| 维度 | 做法 |
|---|---|
| **存储** | **影子 git 仓库** `.cline/checkpoints/.git`，用 `core.worktree` 把工作树指向真实项目 → 主项目不出现多余 `.git`，且与主仓完全隔离 |
| **初始化** | `git init` + `addConfig core.worktree <cwd>` + 关闭 GPG 签名 + 自定义 user.name/email + **写入 LFS 排除模式**（避免大文件入仓）+ 初始 commit |
| **工作区绑定** | 已存在仓库若 `core.worktree !== cwd` → 抛错 `Checkpoints can only be used in the original workspace` |
| **触发** | **每次工具执行完成后** `saveCheckpoint()`：`git add -A` + `git commit --allow-empty -m "checkpoint"` |
| **diff** | 基准取**初始提交**（`git rev-list --max-parents=0 HEAD`）；先 `addAllFiles` 让未跟踪文件也参与；`git diffSummary`；before/after 以 **base64 放进自定义 URI 的 query**，交给 VS Code 虚拟文档渲染（**不落磁盘临时文件**） |
| **恢复** | `git reset --hard <hash>`（先 `git show <hash> --name-only` 校验存在性） |
| **弱点** | 每次 commit 全量 add（大仓库性能）、`--hard` 会丢弃未提交改动（无提示）、清理/配额策略未见实现 |

**可借鉴的精华**：`core.worktree` 隔离手法（比本项目 worktree ref 方案更通用）+ **diff 走虚拟文档不写临时文件**（直接解决本项目缺口 3）+ LFS/大文件排除。

### 2.3 Aider（不做独立体系，直接用用户 git）

| 维度 | 做法 |
|---|---|
| **触发** | ① 每次编辑文件后立即 commit ② **编辑脏文件前先把用户既有改动提交**（保护用户工作，`--no-dirty-commits` 可关） |
| **message** | 由 `--weak-model` 根据 diff + 聊天历史生成，默认 Conventional Commits，`--commit-prompt` 可定制 |
| **撤销** | `/undo` = 撤销并**丢弃**最后一次改动 |
| **归属标记** | author/committer 加 `(aider)` 后缀；`--attribute-commit-message-author` 加 `aider: ` 前缀；`--attribute-co-authored-by` |
| **可关闭** | 三级：`--no-auto-commits` / `--no-dirty-commits` / `--no-git`（官方不推荐） |
| **默认跳过** | pre-commit hooks（`--no-verify`），可用 `--git-commit-verify` 打开 |

**可借鉴的精华**：「编辑脏文件前先提交」——**保护用户未提交工作**的语义，本项目没有对应处理（用户手改 + agent 改混在一起时无法区分）。

### 2.4 Codex CLI（能力最弱，反衬趋势）

- 目前只有 **restore conversation**（双击 `Esc`），**缺代码回退**（issue #11626 正在提该需求）
- 第三方 `agent-rollback` 补位：content-addressed snapshots
- **启示**：「代码 + 对话双回退」已是业界共识，Codex 缺失被用户明确提为 issue

---

## 3. 能力矩阵

| 能力 | Claude Code | Cline | Aider | 本项目 |
|---|---|---|---|---|
| 独立于用户 git 历史 | ✅ 独立快照 | ✅ 影子仓库 | ❌ 共用主仓 | ✅ JSON + git-ref |
| 触发粒度 | 每轮 | 每次工具后 | 每次编辑后 | **工具写盘前 + 每轮 + 手动** |
| 内容去重/压缩 | ✅ 引用计数 | ✅ git 对象去重 | ✅ git 对象去重 | ❌ 全量明文 |
| 配额上限 | ✅ 100/会话 | ❌ 未见 | N/A | ❌ **无** |
| 自动淘汰 | ✅ 引用计数删除 | ❌ | N/A | ❌ |
| 保留期清扫 | ✅ ~30 天 + 可配 | ❌ | N/A | ❌ |
| 只回退代码 | ✅ | ✅（Restore Files） | ✅ `/undo` | ⚠️ 部分（keepAll 语义不同） |
| 只回退对话 | ✅ | ✅（Restore Task） | ❌ | ❌ |
| 对话压缩（summarize） | ✅ 两种 | ❌ | ❌ | ❌ |
| diff 预览 | ✅ | ✅ 虚拟文档 | ✅ `/diff` | ✅ 写临时文件 |
| 时间线/菜单视图 | ✅ `/rewind` 菜单 | ✅ 消息内按钮 | ❌ 命令行 | ⚠️ 底部条 + 气泡悬停 |
| 工作流节点级断点 | ❌ | ❌ | ❌ | ✅ **独有** |
| 整树 git 快照 | ❌ | ✅ | ✅ | ✅（worktree ref） |
| 显式声明限制 | ✅ 详尽 | ⚠️ | ⚠️ | ❌ 无 |

---

## 4. 本项目的优势（客观）

1. **触发粒度业界最细**：Cline 是「工具执行**后**」commit，Claude Code 是「每轮提示**前**」——本项目是「工具写盘**前**捕获 + 每轮锚点 + 手动」三通道，且 `patch`/`file_write` 都在写盘前捕获，**语义上最准确**（拿到的是真正的「改动前状态」）。
2. **`existedBefore` 语义正确**：新建文件回退时**删除**而非写空文件——这是很多实现会做错的细节。
3. **ghost 机制**：回退后标记而非物理删除，保留可追溯性（开源方案多为直接丢弃）。
4. **工作流节点级断点**：`planWorkflowResume` 能区分「completed 复用 / running 必须重跑」，**开源 agent 普遍没有 DAG 断点续跑能力**。
5. **worktree 用 git ref 而非 commit**：`refs/vssaros/checkpoints/*` 不污染分支历史、不产生游离 commit，比 Cline 的影子仓库更轻。
6. **回退前有审阅 UI**：撤销确认弹窗列出文件 `+N -N` + 逐文件 diff + 「不再提示」开关——比 Aider/Cline 的「一键 reset」更贴合「审阅后回退」的谨慎场景。
7. **`isGhost` + 聚合取最早快照**：正确实现了「撤销全部 = 回到本轮起点」的语义。

## 5. 本项目的劣势与风险

1. **生命周期完全失控（最大风险）**：无配额、无淘汰、无 TTL、会话删除不清理、临时 diff 目录不清理。而快照是**全量明文无压缩**——一个频繁编辑的大文件（如 5000 行 TS）每次工具调用就存一份完整副本，**磁盘增长是 O(编辑次数 × 文件大小)**，远超 Claude Code 的引用计数模型。
2. **缺「只回退对话」**：Claude Code 六模式中最常用的「代码留着、对话回到某点重问」无法实现。
3. **静默失败成体系**：空 catch、命令未注册、无 session 直接 return——排障时无信号（与项目内已确立的「诚实降级」原则相悖）。
4. **覆盖盲区未声明**：`execute_code`/`terminal` 改的文件无法回退、`move/rename` 无法回滚——**但 UI 未告知用户**（Claude Code 会明确列出限制）。
5. **四套体系零复用**：认知成本高（新成员需理解 4 套存储/触发/恢复语义），且 worktree browser/node 双实现逐行重复。
6. **死代码与签名漂移**：SQLite 版整套 + `checkpointCard.ts` 未使用；接口与实现签名不一致。

---

## 6. 优化建议

> 原则：**先补生命周期（P0），再补能力（P1），最后做体验（P2）**。不建议为「架构统一」而做大重构。

### P0 — 生命周期治理（防磁盘失控，最高优先）

**P0-1 引入配额与引用计数淘汰（对齐 Claude Code）**
- 每会话保留最近 **N 个** checkpoint（N 默认 100，可配 `sessions.agentStudio.checkpoint.maxPerSession`）
- 淘汰时删除**不再被任何剩余 checkpoint 引用的快照文件**；**每个文件的第一个快照永久保留**（作 diff 基线）
- 落点：`browser/checkpointService.ts` 的 `createCheckpoint` 末尾（写入后触发 prune）
- 收益：把「无上限」变成「有界」；成本：~80 行 + 单测

**P0-2 内容去重（低成本高收益）**
- 快照文件名改为 **`<sha256(content)>.json`**，多个 checkpoint 引用同一文件（天然去重）
- 若担心改动面：退一步做「同 URI 内容 hash 相同则复用已有快照文件」
- 收益：典型场景（反复改同一文件）体积下降一个数量级；成本：~40 行

**P0-3 清理闭环**
- 会话删除时删除该会话检查点目录（挂到 `nativeChatEditorPane` 的会话删除路径）
- `.sarosworkspace/checkpoint-diffs/` 改为**用完即删**，或统一走虚拟文档（见 P2-2）后删除该目录概念
- 增加启动时/定期清扫（对齐 `cleanupPeriodDays`，默认 30 天）

**P0-4 消除静默失败**
- 注册 `agentStudio.openCheckpointDiff` 命令（或改为直接调用内部 diff API）
- `CheckpointManager` 的空 `catch` 改为 `logService.warn` + 用户可见提示
- `captureBeforeToolEdit` 无 active session 时**打一条 warn**（当前完全静默 → 事后无法解释「为什么这次没有检查点」）
- 对齐项目内已确立原则：「降级必须可见」

### P1 — 能力对齐

**P1-1 补「只回退对话」（Restore conversation）**
- 现状：`jumpToCheckpoint` 同时回退文件 + 截断对话，无法只截断对话
- 改法：拆分为两个独立动作（`revertFiles` / `truncateConversation`），UI 提供三选：仅代码 / 仅对话 / 两者
- 收益：对齐 Claude Code 最常用模式；成本：~60 行（API 已分离，只需补 UI 与编排）

**P1-2 覆盖盲区诚实声明**
- `execute_code` / `terminal` 工具结果追加一行提示：「此操作通过 shell 执行，不受检查点保护，无法回退」（对齐 Claude Code 的限制声明）
- `move/rename` 补原路径快照（`existedBefore` 语义扩展到「源路径删除」）
- 收益：用户不会被「以为可回退」误导

**P1-3 保护用户未提交改动（对齐 Aider 的 dirty-commit 语义）**
- 场景：用户手改过文件 → agent 又改同一文件 → 回退会把用户的手改一起抹掉
- 改法：`captureBeforeToolEdit` 时若检测到文件有**用户未跟踪的改动**，在检查点 label 中标注「包含用户改动」，回退前提示确认
- 收益：避免最伤用户的数据丢失场景

### P2 — 体验与性能

**P2-1 时间线视图（对齐 `/rewind` 菜单）**
- 当前入口分散（底部条 + 气泡悬停按钮），缺少「一览所有检查点并选择」的视图
- 建议：命令面板 + 快捷键（如连按两次 `Esc`）打开检查点列表，显示时间/标签/文件数/`+N -N`，支持一键回退

**P2-2 diff 改走虚拟文档（对齐 Cline）**
- 现状：写临时文件到 `.sarosworkspace/checkpoint-diffs/` 再开 diff（磁盘副作用 + 需清理）
- 改法：用自定义 URI scheme + base64 query 提供 before/after 内容给 VS Code 虚拟文档（`vscode.changes` 多文件 diff）
- 收益：消除临时目录概念（P0-3 的一半工作自然消失）

**P2-3 大文件/二进制保护**
- 现状：`content` 全量明文，若 agent 写入大二进制/大文件，快照会爆炸
- 改法：超过阈值（如 1MB）或二进制 MIME 的文件**跳过内容快照**，仅记录 URI + 标记 `contentOmitted`，回退时提示「该文件无法回退」

### P3 — 代码卫生（低风险顺手做）

- 删除死代码：`node/checkpointService.ts`、`node/checkpointStorage.ts`、`checkpointCard.ts`（确认无引用后）
- 修正 `ICheckpointService.createCheckpointFromUris` 签名（补 `files` 字段）
- worktree browser/node 双实现：抽出共享逻辑到 common（或明确保留双份的理由并注释）

### 不建议做

- ❌ **不要**改成 Aider 式「直接 commit 到用户 git 历史」——本项目已有 worktree git-ref 隔离方案，更干净；污染用户历史是明确的倒退
- ❌ **不要**为「统一 4 套体系」做大重构——四者职责正交（文件快照 / 整树 git / 编辑器 undo / 工作流断点），强行合并风险远大于收益
- ❌ **不要**为压缩引入重型依赖（如 zstd 原生模块）——内容寻址去重（P0-2）已能拿到主要收益，且零依赖

---

## 7. 附：落地优先级速览

| 优先级 | 项 | 预估成本 | 收益 |
|---|---|---|---|
| P0-1 | 配额 + 引用计数淘汰 | ~80 行 | 磁盘有界 |
| P0-2 | sha256 内容寻址去重 | ~40 行 | 体积降一个数量级 |
| P0-3 | 会话删除清理 + diff 目录清理 + 30 天清扫 | ~60 行 | 消除泄漏 |
| P0-4 | 消除静默失败（命令注册 / warn 日志） | ~30 行 | 可排障 |
| P1-1 | 只回退对话 | ~60 行 | 能力对齐 |
| P1-2 | shell/move 盲区诚实声明 | ~30 行 | 防误导 |
| P1-3 | 用户脏改动保护 | ~50 行 | 防数据丢失 |
| P2-1 | 检查点时间线视图 | ~150 行 | 体验 |
| P2-2 | diff 走虚拟文档 | ~80 行 | 消除临时文件 |
| P2-3 | 大文件/二进制跳过 | ~40 行 | 防爆 |

**建议起步**：P0-1 + P0-2 + P0-4（三者共约 150 行，全部落在 `browser/checkpointService.ts` 与 `checkpointManager.ts`，风险可控，收益立竿见影）。

---

## 8. 实施进度（2026-09-12）

### ✅ 已落地

| 项 | 落地内容 | 关键文件 |
|---|---|---|
| **P0-1** 配额与淘汰 | 新建纯函数模块 `common/checkpointRetention.ts`：`planVersionPrune`（每 URI 保留「最早 1 + 最近 50」）、`planCheckpointEviction`（会话上限 200，**跳过承载最早快照的检查点**）、`selectUnreferencedSnapshotIds`、`collectProtectedSnapshotIds` | `common/checkpointRetention.ts`、`browser/checkpointService.ts` |
| **P0-2** 内容寻址去重 | `snapshotId = sha256(uri + '\0' + existedBefore + '\0' + content)` 前 32 hex；已存在则跳过写入。**`existedBefore` 参与哈希**（区分「新建的空文件」与「已存在的空文件」） | `browser/checkpointService.ts` |
| **P0-2 配套** 引用计数删除 | `deleteCheckpoint` / `deleteAllCheckpoints` / `_pruneSnapshots` 统一经 `_deleteUnreferencedSnapshots` —— 共享快照只在无引用时删除 | `browser/checkpointService.ts` |
| **P0-3** 会话删除清理 | `onDeleteSession` → `deleteSessionCheckpoints`（删整个会话目录） | `browser/nativeChatEditorPane.ts`、`browser/checkpointService.ts` |
| **P0-3** 临时 diff 目录清理 | `_purgeTempDiffDirOnce`：**每进程首次打开 diff 前**清空整个目录（运行期不清，避免影响已打开的 diff） | `browser/agentStudioWebviewController.ts` |
| **P0-3** TTL 清扫 | `CHECKPOINT_TTL_MS = 30 天` + `isSessionExpired`（时间戳 0/缺失 → 不判定过期）+ `pruneStaleSessions`；触发点 = `setActiveSession` 首次调用（fire-and-forget） | `common/checkpointRetention.ts`、`browser/checkpointService.ts` |
| **P0-4** 消除静默失败 | `captureBeforeToolEdit` 无 session 由静默 return 改 warn；`CheckpointManager` 注入 `ILogService`，refreshBar / handleAction / openDiff 三处空 catch 改 warn | `browser/checkpointService.ts`、`browser/checkpointManager.ts` |
| **P1-1** 只回退对话 | 撤销弹窗新增「仅回退对话」按钮；`_revertConversationOnly` 按**最早非 ghost 检查点时间戳**截断历史（保留代码）。锚点计算抽为纯函数 `common/checkpointConversationAnchor.ts` | `agentChatPanel.messages.ts`、`browser/nativeChatEditorPane.ts` |
| **P1-2** 覆盖边界声明 | 撤销弹窗新增范围说明：shell（execute_code / terminal）改动、move/rename 不在回退范围内 | `agentChatPanel.messages.ts` + CSS |
| **P2-3** 大文件/二进制跳过快照 | `common/checkpointSnapshotPolicy.ts`：内容超 1MB **或**开头含 NUL（二进制特征）→ 只存元数据（`contentOmitted: true`）；回退时**跳过**该文件并计入 `skippedFiles`，由 UI 弹通知告知（对齐 Claude Code「skipped N files」）。**绝不写入空内容**（二进制解码后写回会损坏文件，比不回退更糟）。哈希仍用完整原内容 → 不同大文件不碰撞 | `common/checkpointSnapshotPolicy.ts`、`browser/checkpointService.ts`、`browser/checkpointManager.ts`、`browser/nativeChatEditorPane.ts` |
| **P3** 死代码清理 | 删除 `agentStudio/node/checkpointService.ts` + `node/checkpointStorage.ts`（SQLite 版，仅互相引用）+ `browser/agentChat/modules/checkpointCard.ts`（无调用方）；同步清理 `tools/batch1.ts` 中的失效路径引用 | 3 文件删除 + `tools/batch1.ts` |
| **P2-2** diff 走虚拟文档 | 新建 `browser/checkpointDiffContentProvider.ts`（`CheckpointDiffStore` 纯逻辑 + `CheckpointDiffContentProvider` 适配层）；注册自定义 scheme 的 `ITextModelContentProvider`，**快照内容只在内存**。**顺带移除** P0-3 的临时目录清理机制（`_purgeTempDiffDirOnce` + 守卫字段）——少一个生命周期状态；并补 P2-3 的 `contentOmitted` 分支（无内容时不展示空白 diff，明确告知） | `browser/checkpointDiffContentProvider.ts`（新）、`browser/agentStudioWebviewController.ts` |
| **P2-1** 检查点时间线 | 撤销弹窗新增「历史检查点…」按钮 → pane 内 QuickPick 列出本会话全部可回退检查点（标签 / 时间 / 文件数）→ 选中即**回退到该点**（文件 + 对话同时回到该点之前，复用 P1-1 的时间戳锚点纯函数）。对齐 Claude Code `/rewind` 菜单 | `agentChatPanel.messages.ts` + CSS、`browser/nativeChatEditorPane.ts`（注入 `IQuickInputService`）、`iChatPanel.ts` / `agentChatPanel.base.ts` 类型 |
| **P1-3** 用户脏改动保护 | 厘清真实丢失场景后实现：回退写回的是「agent 写入**前**的内容」，故天然保留此前所有人类改动；**唯一**会丢数据的是「agent 改完 → 用户又手改 → 回退」。检测 = 比较**当前磁盘内容**与 agent 最后写入内容（`_lastAgentWrite` 基线，在 `captureBeforeToolEdit` 登记）；`detectExternallyModifiedFiles` 预检 → pane 在 `undoAll` 前用 `prompt` **二次确认**（直接关闭通知视为取消）。保守边界：无基线（窗口重载）/ 读不到 → 跳过，宁可漏报不误报 | `browser/checkpointService.ts`、`common/checkpointService.ts`、`browser/nativeChatEditorPane.ts` |
| **P3** worktree 死代码清理 | 核实 `worktree.contribution.ts:20` 注册的是 **browser 版**、node 版**零引用** → 删除 `worktree/node/worktreeCheckpointServiceImpl.ts`（含空目录）。删除前**移植 node 版唯一更正确之处**：`rollbackToCheckpoint` 的 ref 显式校验（warn「does not exist」而非笼统的「Failed to rollback」）。同时确认 browser 版更优的两点得以保留：args 数组调用 git（**无 shell 注入**，node 版是字符串拼接）、单 ref 删除失败不中断 | `worktree/browser/worktreeCheckpointServiceImpl.ts`、删除 `worktree/node/` |

**验证**：tsgo 0 错误；新增测试 `checkpointRetention`（22）+ `checkpointConversationAnchor`（8）+ `checkpointSnapshotPolicy`（10）+ `checkpointDiffContentProvider`（5）；回归 `executeCodeGuards` 55 / `patchMatcher` 62 / `workflowCheckpoint` 22 全绿；lint 0；transpile 产物已逐项确认（含反向断言：「被删死代码已不在 out/」「旧临时目录机制已移除」「node 版 worktree 实现已消失」）。

> **落地统计：14 项全部完成 + 1 项收尾（迁移脚本归档）** —— P0-1/2/3/4（生命周期治理）、P1-1/2/3（能力与防数据丢失）、P2-1/2/3（体验与技术债）、P3×2（agentStudio + worktree 死代码清理）、`tools/` 一次性迁移脚本归档 + 护栏。**无剩余实施项，无待决策项**。

### ⏸ 未做（含原因）

| 项 | 状态 | 原因 |
|---|---|---|
| ~~P1-3 用户脏改动保护~~ | ✅ 已落地 | 见上表。关键是厘清了「回退写回 agent 写入**前**的内容 → 天然保留此前所有人类改动」，故只需检测「agent 写后又被手改」这一**窄场景**——**不需要 git 集成**（此前判断有误） |
| ~~P3 worktree 双实现合并~~ | ✅ 已落地 | 实为删除 node 版死代码（零引用）+ 移植其唯一更正确之处（ref 显式校验）。合并本身不需要——两份实现里 browser 版在安全性与健壮性上更优 |

### ✅ 一次性迁移脚本已归档（2026-09-12）

`tools/` 顶层 8 个 `employeeId → agentId` / store 迁移脚本（batch1 / pass1 / pass2 / phase2 / final-clean / full-clean / migrate-store / rename-employeeId）已移至 **`tools/archive/one-off-migrations/`**；`tools/` 顶层现只剩 `lightai/` 与 `archive/`。

**依据（调查证据）**：
- npm scripts 与全仓代码引用数 **0**（此前搜到的 `pass1` / `batch1` 命中均为同名词巧合——`full-clean.ts` 的内部变量、测试的局部变量）；
- **8/8** 均含 `saveSync()` / `writeFileSync`，会**直接改写 `src/`**；
- 迁移早已完成（代码现在就是 `agentId`），脚本不可能再需要运行。

**残留风险与处置** —— 归档本身**不足以**消除误跑风险：其中 3 个脚本（`migrate-store` / `phase2` / `final-clean`）用 **cwd 相对路径**（`path.resolve('src/...')`），移动目录后仍会命中仓库 `src/`；另外 5 个用 `__dirname` 相对路径（归档后自动失效，但仍统一加护栏以明确语义）。故为**全部 8 个**脚本加了统一**护栏**：未设置 `VSSAROS_ALLOW_ARCHIVED_MIGRATION=1` 时，在模块顶层立即 `throw`（位于任何业务逻辑之前）。

**实证**：Node v22.22.1 可直接执行 `.ts`（type stripping）—— 即误跑风险**真实存在**。运行 `final-clean.ts` 验证：脚本在第 7 行被拦下、**零业务输出**、`src/` 字节总和跑前跑后完全一致（115705091）。

如需彻底删除：`git rm -r tools/archive/one-off-migrations/`（git 历史仍可追溯，参考价值不丢失）。

### 实施中修正的两个调研结论

1. **`move/rename` 与 shell 类工具在审批层已被拦截** —— `common/toolApprovalPolicy.ts` 的 `IRREVERSIBLE_FILE_VERBS` 含 move/rename（注释明确「checkpoint 覆盖不到 → 不放行」），shell/代码执行类「一律不放行」。故 P1-2 的实际缺口只是「审批通过后的改动无法回退」未告知用户。
2. **native 链的「回撤改动」本就只回退代码、保留对话** —— 等价于 Claude Code 的 Restore code；`deleteMessagesAfter` 截断此前只存在于 webview 链。因此 P1-1 的缺口是「只回退对话」而非「只回退代码」。

### 一个诚实的说明

**内容寻址（P0-2）对「同一文件连续编辑」的去重收益有限** —— 每次编辑的内容确实都不同，哈希不会命中。真正解决磁盘膨胀的是**配额淘汰（P0-1）**；内容寻址的价值在「回退后重新编辑产生的重合版本」「多文件相同内容」，以及为引用计数删除提供正确基础。
