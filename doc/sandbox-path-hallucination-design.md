# 路径幻觉与沙箱拒绝反馈 — 开源方案对比与优化设计

> 2026-09-07 · 背景：patch 传 `g:\...\AIProjects\AIProjects\sarosis-agents-client\...`（前缀重复幻觉）
> 被沙箱拒绝；同族问题还有 webidx 手误、凭记忆拼路径 → patch 连败循环（日志 1788713328385、1788746435013）。

## 一、问题域拆解

路径类失败分三层，治法不同：

| 层 | 表现 | 已有防御（本日落地） |
|---|---|---|
| L1 幻觉产生 | 前缀重复 / 子目录拼错 / 凭记忆拼路径 | 无（模型行为） |
| L2 拒绝反馈 | 沙箱拒绝 / file_read not found 的文本质量 | suggestedPath 两级验证、search_files 引导、nonexistent 修复 |
| L3 拒绝后行为 | 重试猜路径 → 循环 | read-state 关联反馈、exact-repeat 熔断 |

**L1 是根**——L2/L3 再好，也只是让模型更快自愈。开源项目的共识是：在 L1 消除幻觉土壤。

## 二、开源方案对比

### 1. 绝对路径强制 + 接地（Claude Code）—— ★ 实测修正

**初版本文档误记为「相对路径 + cwd 锚定」，核对后更正**：Claude Code 的 Read/Edit
**明确要求绝对路径**（*"The file_path parameter must be an absolute path, not a relative path"*）。
它抗路径幻觉靠的不是相对路径，而是两条**接地（grounding）**机制：
① 路径必须来自工具输出（搜索结果原文复制）；② read-before-edit 硬闸。

- ✅ 多根/多仓天然无歧义（绝对路径唯一确定）
- ✅ 接地机制正面解决「凭记忆拼路径」这一根因
- ⚠️ 绝对路径本身留有拼接空间（前缀重复幻觉），必须靠接地机制压制
- ⚠️ token 略长

### 2. 相对路径 + cwd 锚定（Cline / Aider / SWE-agent / Codex CLI）

做法：path 相对工作区根；cwd 注入 system prompt。

- ✅ 无前缀可拼 → 前缀重复类幻觉消失
- ✅ token 更省
- ⚠️ **多根工作区有歧义**——Cline 为此在 v3.8 专门做了「跨仓库语义路由」
- ⚠️ 各工具的相对解析基准必须严格一致，否则「搜到的路径喂给读工具」会失败

**结论（对本项目）**：VsSaros 是多根工作区（引擎 + 项目）形态，且 `file_*` 的相对路径
只对**首个**允许根解析、而 `search_code` 是逐根尝试——一律推相对路径会把这个语义差异
激活成高频故障。故本项目应走 **Claude Code 路线：接地优先**，相对路径仅作单根场景的便利选项。

`Edit/Write` 前必须成功 `Read` 过该文件，否则硬拒："File has not been read yet. Read it first, then try again."（官方拒绝 auto-read 提案，issue #4230；另有 mtime 检测 "File has been modified since read"）。

- ✅ **结构性保证** patch.search 一定来自真实内容——search not found 类失败概率趋零
- ✅ 与 mtime 检测组合覆盖「读了但文件已变」
- ⚠️ 需要可靠的读状态跟踪（含 mtime）——VsSaros 已有 read-state（Map）与 checkReadDedup（mtime），升级成本低
- ⚠️ 多一轮 read 往返（对超大文件有成本，Claude Code 接受此代价）

### 3. 沙箱 writable roots 提示 + 审批升级（Codex CLI）

`workspace-write` 模式拒绝时提示可写根目录；配合 approval_policy 提供「本次放行 / 提权」升级路径。

- ✅ 拒绝即引导，权限升级显式
- ⚠️ 只告知根，**不解决拼错**——根内路径错了照样盲试
- VsSaros 现状：允许根列表 + 确认卡片（allow_once / allow_workspace / use_suggested）已对齐，甚至更细

### 4. ACI 接口防错设计（SWE-agent）

核心论点：为 LM 设计专门接口（像设计 IDE），关键原则是**简化导航 + guardrails**——他们把「搜索→定位→查看」做成内聚命令流，让模型**少有机会自由拼写路径**。

- ✅ 机制性防错（不依赖模型自觉）
- ⚠️ 工具集改造成本大，属于长期方向
- 借鉴点：搜索结果→文件的引用应该「可复制直用」（VsSaros 的 search_graph 输出已回填绝对路径，对齐此原则）

### 5. 容错解析 / 自动路径修复（少见）

业界罕见主动做——多数只静默 normalize 分隔符。VsSaros 本日已实现的 suggestedPath 结构修复（根末段锚点 + exists 验证）实际上已走在前面；但停留在「建议 + 重试」，还差一步（见方案 B）。

### 对比总表

| 方案 | 治哪层 | 消耗轮次 | 实施成本 | 风险 |
|---|---|---|---|---|
| A 相对路径锚定 | L1 | 0 | 低（prompt+schema） | 多根语义需明确 |
| B 容错解析前置 | L2（免拒绝） | 0（自愈） | 低（复用本日代码） | 修复错意图（exists 验证兜底） |
| C read-before-edit 硬闸 | L1/L3 | +1（读一次） | 低（read-state 已有） | 超大文件多一跳 |
| D 可执行反馈 | L3 | 1 | — | 已实现 |
| E ACI 内聚接口 | L1 | — | 高 | 长期 |

## 二之二、开源路径方案全景对比（2026-09-07 二次核对）

| 方案 | 代表 | 核心做法 | 优点 | 缺点 | 本项目适用性 |
|---|---|---|---|---|---|
| **A 绝对路径 + 接地** | Claude Code | `file_path` 必须绝对；read-before-edit 硬闸；路径一律来自工具输出 | 多根无歧义；**接地**根治"凭记忆拼路径" | 长路径占 token；依赖模型遵守纪律 | ★★★ **已采纳**（P3 硬闸 + P1 接地提示） |
| **B 相对路径 + 根路由** | Cline（v3.8 多根语义路由） | 相对工作区解析；多根用路由消歧 | 短、无前缀可拼 | 多根歧义需额外机制；各工具解析基准必须严格一致 | ★★ 部分采纳（单根可用相对；多根走绝对） |
| **C 容器化统一路径** | OpenHands / Devin | 工作区挂载到固定 `/workspace`，模型只认容器内路径 | **彻底消除宿主路径差异**、可复现 | 需容器；无法访问用户本机多仓、难做 IDE 深度集成 | ✗ 不适用（桌面 IDE 内运行） |
| **D 模糊文件名纠正** | Aider `find_filename()` 多阶段匹配 | 模型给错文件名 → 多阶段匹配仓库内真实文件 | 容错强、直接救活幻觉 | 可能匹配到错误文件（需确认/唯一命中约束） | ★★★ **已采纳**（suggestedPath：结构修复 + basename 限深唯一命中） |
| **E cwd + 写沙箱** | Codex CLI / Gemini CLI | 命令在 shell 中跑，cwd 锚定，写操作限 workspace-write | 简单、贴合开发者习惯 | 路径错即命令失败，靠模型自查 | ★ 参考（terminal / execute_code 通道） |
| **F ACI 接口防错** | SWE-agent | 定制 find/edit 命令集，不让模型自由拼路径 | 机制性防错 | 工具集改造成本高 | ★ 长期方向 |

### 三个深层结论

1. **绝对 vs 相对是伪命题，接地才是本质。**
   Claude Code 强制绝对路径却最抗幻觉，靠的是"路径必须来自工具输出 + read-before-edit"两道接地机制；
   反之，只改路径格式（相对/绝对）而不做接地，幻觉照旧。（本项目初版方案曾误判这一点，已更正。）

2. **宽容 vs 严格是真实取舍。**
   Aider 模糊匹配（宽容，省一轮但可能改错文件）↔ Claude Code 硬拒（严格，多一轮但安全）。
   本项目取中间：越界拒绝时给"经存在性验证、唯一命中"的建议由用户确认；patch 走硬闸；搜索输出侧做归一化预防。

3. **容器化是根治但代价不可接受。**
   OpenHands 把工作区挂到 `/workspace` 后，宿主机路径差异从根上消失；但本项目要访问用户本机多个仓库并深度集成 IDE，不能容器化——只能在宿主侧用"归一化 + 校验 + 告警"逼近同等效果。

## 二之三、本地开源项目源码级对比（读 `G:\CustomWorkspaces\AIProjects` 实际代码）

| 维度 | Hermes-Agent | Continue | opencode | 本项目（现状） |
|---|---|---|---|---|
| **路径格式约定** | 宽松：`"absolute, relative, or ~/path"`；仅 Gemini/Gemma 的 prompt 强制绝对（`prompt_builder.py:615`） | **不统一**：read/createNewFile/ls 接受 4 种形式；edit/multiEdit 要求 `relative to the root of the workspace`；readFileRange 明写 `NOT uri or absolute path` | **两代相反**：V1 `must be absolute, not relative`；V2 `Relative paths resolve within the active Location` | 接地优先（单根可用相对，多根建议绝对） |
| **解析 helper** | 单一：`_resolve_path`→`_resolve_path_for_task`（`file_tools.py:373`），锚点 `_resolve_base_dir`（:315，四级回退） | 统一：`resolveInputPath`（`pathResolver.ts:49`） | **V1 每个工具各写一遍**（read/write/edit/glob/grep 五份 `path.isAbsolute` 三元）→ 漂移温床；V2 统一 `LocationMutation.resolve` | 今天统一为 `_absPathOf`（此前是闭包私有 → 模块级） |
| **绝对性判断** | ✅ 三分支（posix/nt/Path）都判断 | ✅ `isAbsolute \|\| \\\\ \|\| 盘符正则` | ✅ | ✅ |
| **read-before-edit** | ❌ 硬闸；仅 mtime 软告警 `_check_file_staleness`（:2111） | ❌ 仅提示词（"read it first"），`Tool` 接口无校验字段 | **V1 空头支票**（edit.txt 说会报错，代码无实现）；V2 = CAS 乐观锁 `writeIfUnchanged` | ✅ 硬闸 + 写后失效（markFileModified） |
| **相似路径建议** | ✅✅ Unicode 等价自动纠正（唯一命中自动改道）+ `difflib` 打分 ≥0.8 给 5 条 | ❌ 完全没有（唯一 fuzzy 是内容匹配且已注释停用） | ⚠️ 仅 V1 read 的 `miss()`（读目录 + 双向子串 + 前 3 条） | ✅ 结构修复 + basename 限深唯一命中 |
| **多根消歧** | 单锚点（会话 cwd） | ✅ 全根遍历 + `fileExists` + **最短唯一相对路径**给模型 | Location 锚定 + external_directory 授权 | 部分（`project` 参数 + 建议绝对） |
| **"合法但可疑"告警** | ✅ `_path_resolution_warning`：相对路径解析到工作区外时明确警告 | ❌ | V2 `PathError`（relative_escape / location_escape） | ⚠️ 仅畸形检测，无越界软告警 |

### 三个反面教材（避免重蹈）

1. **opencode V1「空头支票」**：`edit.txt:4` 承诺 *"This tool will error if you attempt an edit without reading the file"*，但 `edit.ts` / `write.ts` 中**完全没有**读取记录表与校验。→ 本项目 P3 硬闸必须提示词与实现一致（已由 read-state 保证）。
2. **opencode V1 各工具自写解析**：五份 `path.isAbsolute` 三元分散在五个文件，正是「两份实现必然漂移」的实证（与本项目 `_absPath` 事故同源）。
3. **Continue 口径不统一**：读类接受绝对路径、编辑类却要求相对——模型在两类工具间切换时会困惑。

### 三个高价值借鉴（尚未实施）

1. **Continue「最短唯一相对路径」**（`getShortestUniqueRelativeUriPaths`）：多根下给模型展示**可区分的最短路径**（如 `components/Button.tsx`），比"一律用绝对路径"省 token 且无歧义。
2. **Hermes「越界软告警」**（`_path_resolution_warning`）：相对路径解析后若落在工作区外，明确告知"改动会落到别的目录"——补上我们缺失的「合法但可疑」这一档。
3. **Hermes Unicode 等价纠正**：NFC/NFD、U+202F、弯引号等在渲染上不可见，macOS 场景高发；唯一命中时自动改道。

### 可选下一步（尚未实施）

- **Aider 式多阶段匹配增强**：现仅 basename 唯一命中 + 限深 6，可增加"路径后缀匹配 + 模糊打分"。
- **接地的技术化校验**（最有价值）：Claude Code 靠模型自律遵守"路径来自工具输出"；
  本项目可把它做成机制——校验 `patch` 的 path 是否出现在最近 N 条工具输出中，未出现则提示接地。

## 三、优化方案（按优先级）

### 方案 A：相对路径优先 + 单一工作区锚定（治本，先做）

1. `resolvePathArg` / 工具 schema：path 描述统一为
   *"Workspace-relative path is PREFERRED (resolved against the active workspace root). Absolute paths are accepted only when copied verbatim from a previous tool result."*
2. system prompt：注入 `Active workspace root: <path>` 单一事实源；**不再并列罗列全部允许根**（允许根是内部安全概念，罗列反而诱导模型拼接前缀——本例 AIProjects 重复的直接诱因）。
3. 兼容：绝对路径输入照常解析（沙箱判定不变）。

### 方案 B：容错解析前置（拒绝变自愈）

`resolveAndCheckWorkspacePathImpl` 在 `isAllowed === false` 时：

1. 先跑 `computeSuggestedPath` 的 ① 结构修复（根末段锚点 + exists 验证，已实现）；
2. 修复结果**落在允许根内且存在** → 直接放行，logService.warn 记录自动修正（`path auto-corrected: X → Y`），并让工具结果尾部附一行 `[note] path was auto-corrected to <Y>` 告知模型（透明，不静默）；
3. 修复失败 → 走现有拒绝 + 建议路径流程。

风险控制：仅修前缀（锚点必须是根末段）、exists 硬验证、basename 不变（意图保留）。省一整轮「拒绝→读建议→重试」往返。

### 方案 C：read-before-edit 硬闸（patch 质量闭环）

`patch` handler 在 computePatch 之前查 read-state：

- 该路径从未成功 `file_read` → 抛 NonRetryable：`"This file has not been read yet. Call file_read on it first, then copy the search block verbatim from its output."`（对齐 Claude Code 文案）
- 已读但 read-state 记录的 mtime 与当前不符 → 提示 re-read（可选，二期）

注意：读状态表按 resolvedPath 归一化（已实现）；patch 目标必然存在（readFile 失败已有错误路径），无新建文件兼容问题。

### 方案 D：提示词强化（一行）

工具描述追加："NEVER assemble a path from memory — copy it verbatim from a tool result (search_graph / search_files / file_read)."

## 四、实施顺序与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1（A+D） | prompt/schema 文案 + 系统提示改单一锚点 | AIProjects 重复类不再出现于日志 |
| P2（B） | 容错解析前置 + 透明告知 | 同类路径幻觉一次调用直接成功（logService.warn 可见） |
| P3（C） | patch read-before-edit 硬闸 | 「search not found ×N 循环」日志归零 |

P1/P3 改动极小可当日完成；P2 需要仔细过一遍 sandboxBypassRoots 与 worktree 分支的交互。
