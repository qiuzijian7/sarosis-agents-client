---
name: reflection
description: 审阅当前 session 历史，发现错误/低效/问题并输出结构化反思报告，末尾询问用户是否开始优化
displayName: "Reflection Skill"
---

# Reflection Skill

你是 BunnySeek 的内置 reflection 分析器。你的任务是**逐回合审阅当前 session 的完整对话历史**，发现一切可改进之处，输出结构化报告，并在末尾询问用户优化意愿。

## 工作流程

### Phase 1 — 定位目标 session

`sessions` 目录：`.bunnyseek\sessions\`

1. 用 `ls` 列出该目录下所有 `.jsonl` 文件。
2. 每个 session 文件名为 `<timestamp>.<nanos>-<model>.jsonl`，例如 `20260707-083429.188994200-deepseek-v4-pro.jsonl`。**stem** 即去掉 `.jsonl` 后缀的部分。
3. 每个 session 有一个 **标题**（title）：读取 `.jsonl` 第一条 `role: "user"` 消息的 `content` 文本，去掉 `<reasoning-language>`、`<current-time>` 等 XML 前缀块后截取前 80 字符。

**匹配逻辑**（按优先级）：

#### 情况 A：`arguments` 为空

取按文件名时间戳排序**最新**的 session。

#### 情况 B：`arguments` 不为空

按以下顺序尝试匹配，命中即停止：

**B1. 文件名精确匹配** — `arguments` 等于某个 `.jsonl` 文件的完整 stem（大小写不敏感）。

**B2. 文件名前缀匹配** — 某个 stem **以** `arguments` 开头。例如 `arguments = "20260707-0834"` 命中 `20260707-083429.188994200-deepseek-v4-pro.jsonl`。如果有多个命中，取最新（最大时间戳）的那个。

**B3. 文件名包含匹配** — 某个 stem **包含** `arguments`（大小写不敏感）。例如 `arguments = "deepseek-v4-pro"` 可能命中多个，取最新。

**B4. 标题模糊匹配** — 对每个 session，读取其标题（第一条 user content 去前缀后截 80 字符），如果标题**包含** `arguments`（大小写不敏感）则命中。多个命中时取最新。

**B5. 全部未命中** — 列出所有 session（文件名 + 标题），输出"未匹配到 session，可用列表如下"，让用户重新指定。**不要**退回到默认选最新。

#### 匹配后操作

4. 定位到目标 `.jsonl` 后，读取同目录下同名的 `.meta.json`（stem 相同、后缀 `.meta.json`），例如 `20260707-083429.188994200-deepseek-v4-pro.meta.json`。如果 `.meta.json` 不存在，仅记录 "无 meta"。

### Phase 2 — 解析 session 历史

1. 读取 `.jsonl`，逐行解析 JSON。每行结构：
   - `role`: `"user"` | `"assistant"` | `"tool"`
   - `content`: 文本内容（user 消息、assistant 回复、tool 返回结果）
   - `reasoning_content`: assistant 的内部思考链（如有）
   - `tool_calls`: assistant 发起的工具调用列表（如有），每项含 `id`、`name`、`arguments`
   - `tool_call_id`: tool 消息对应的调用 ID

2. 将消息按 **user → assistant(含 reasoning + tool_calls) → tool results** 的交替模式分组为**回合**。一个 user 消息开启一个回合、直到下一个 user 消息之前的所有 assistant + tool 消息属于同一回合。

3. 读取 `.meta.json`，记录：
   - `model`（使用的模型）
   - `system_prompt`（当前的 system prompt 快照）
   - `usage`（累计 token 消耗和费用）
   - `workspace.dir`（工作区路径）

### Phase 3 — 逐回合分析

对每个回合，按以下 5 个维度逐一检查。每个发现都需注明**回合号**（从 1 开始编号）、**严重程度**（🔴 Critical / 🟡 Warning / 🔵 Suggestion）、**具体证据**（引用消息中的关键内容）。

#### 维度 1：错误与失误

检查以下模式并标记：

| 模式 | 例子 |
|---|---|
| 工具调用参数错误 | `file_read` 传了不存在的路径、`patch` 的 `old_string` 匹配失败 |
| 工具返回 `is_error: true` | 执行出错后未修正就继续 |
| 读/写不存在的文件 | `file_read` + `is_error`、`file_write` 到无效路径 |
| 重复失败 | 同一种错误连续出现 ≥2 次 |
| 代码/命令语法错误 | `terminal` 返回非零 exit code、Python 语法错误 |
| 忽略错误继续 | 工具返回 error 后 agent 没有处理而是继续下一个动作 |

#### 维度 2：低效交互

| 模式 | 说明 |
|---|---|
| 冗余文件读取 | 同一文件（或同一段内容）被 ≥2 次 `file_read` 读取且中间未修改 |
| 冗余目录列表 | 同一目录被 `ls` ≥ 2 次且中间未修改 |
| 冗余 grep | 同一 pattern + path 重复搜索 |
| 应并行却串行 | 多个 `read_only=True` 的工具调用未放在同一个 `tool_calls` 数组里并行执行 |
| 不必要的工具调用 | 用工具做了 LLM 已知的事（如 `bash echo hello`、重复读取刚写入的文件） |
| "验证式"浪费 | 写入文件后立即 `file_read` 验证内容——如果 `file_write` 未报错就不需要 |
| 过度的探索 | 在决定行动方向前读了 ≥5 个不相关的文件 |
| 不必要的重试/回退 | 同一个操作因非错误原因被撤销后重做 |

#### 维度 3：推理质量

| 模式 | 说明 |
|---|---|
| reasoning → action 不一致 | reasoning 说要做 A，但 tool_calls 实际做了 B |
| 理解正确但绕远路 | 用户意图明确（如"修复这个 bug"），agent 却先大范围探索而非定位问题 |
| 信息已在上下文中却被忽略 | 前几回合 tool result 已包含所需信息但仍然重复查询 |
| 过早放弃 | 遇到一个非致命错误就换方案，而不是尝试修正 |
| 过度自信 | 不验证就假设某文件/函数存在或行为正确 |
| 用户反馈被忽略 | 用户在后续消息中纠正了 agent，但 agent 未采纳 |

#### 维度 4：Prompt / Skill / Memory 系统问题

| 模式 | 说明 |
|---|---|
| System prompt 误导 | system prompt 中的某条规则导致了低效或错误行为 |
| Skill body 不清晰 | agent 调用某个 skill 后产出质量低，推测是 skill 描述不够明确 |
| Skill 缺失 | 遇到了一个场景，如果有一个专门的 skill 就能显著提效 |
| Memory 过时 | `saved memories` 中的某条信息已不准确但 agent 信任了它 |
| Memory 缺失 | 出现了"上个 session 已知但本 session 忘记"的情况 |
| 工具描述误导 | tool description 或 schema 使 agent 误用了工具 |

#### 维度 5：Python 代码（bunnyseek/*.py）改进点

| 关注点 | 说明 |
|---|---|
| 工具行为 | 某工具的行为/返回格式导致 agent 困惑 |
| 错误处理 | 某处缺少错误处理导致 agent 拿到不友好的错误信息 |
| 性能 | 某操作有明显可优化的 Python 实现（如不必要的 I/O） |
| Prompt 缺陷 | `prompts.py` 中的常量/函数可以改进以预防已发生的低效行为 |
| 缺失能力 | 发现了一个应由 Python 层实现的通用能力但当前缺失 |

### Phase 4 — 输出结构化报告

按以下格式输出报告（Markdown）：

```markdown
# 🔍 Session Reflection Report

**Session**: `<stem>`  
**标题**: `<title>`（第一条用户消息截取 80 字符）  
**Model**: `<model>`  
**时间**: `<created_at → updated_at>`  
**总回合数**: `<N>`  
**总 token**: `<prompt + completion>` · 费用 `¥<cost>`

---

## 📊 概览

| 严重程度 | 数量 |
|---|---|
| 🔴 Critical | N |
| 🟡 Warning | N |
| 🔵 Suggestion | N |

---

## 🔴 Critical（必须修复的错误）

### [回合 X] 标题概括

**证据**：
> 引用消息中的关键行

**根因**：
分析为什么发生

**建议**：
具体改进方案（指向文件/代码行/配置）

---

（重复，每个 Critical 一个段落）

---

## 🟡 Warning（低效/偏差）

（同上格式）

---

## 🔵 Suggestion（优化建议）

（同上格式）

---

## 📋 可优化项清单

| # | 类别 | 描述 | 涉及范围 |
|---|---|---|---|
| 1 | Prompt | 在 `prompts.py` 增加规则 X | `bunnyseek/prompts.py` |
| 2 | Skill | 优化 `foo` skill 的 body | `.bunnyseek/skills/foo/SKILL.md` |
| 3 | Memory | 更新 `git-path` memory | `.bunnyseek/memory/git-path.md` |
| ... | ... | ... | ... |

---

## ❓ 下一步

以上共发现 **N** 个可优化项。是否需要我开始优化？请选择：

- **全部优化** — 逐项修复所有问题
- **仅 Critical + Warning** — 跳过 Suggestion
- **选择性优化** — 告诉我具体优化哪些项（按编号）
- **暂不优化** — 仅保留报告供以后参考
```

### Phase 5 — 询问用户

报告输出完毕后，**必须**使用 `clarify` 工具向用户提问，选项如下：

1. **全部优化** — 逐项修复所有问题
2. **仅 Critical + Warning** — 跳过 Suggestion
3. **选择性优化** — 告诉我具体优化哪些项的编号
4. **暂不优化** — 仅保留报告供以后参考

## 约束

- **全部分析在 reasoning 中完成**，最终只输出报告和询问。
- 报告必须引用**具体的行/文件/回合号**，不可泛泛而谈。
- 如果某个维度没有任何发现，写"✅ 未发现明显问题"。
- 对每一项建议，**必须指出涉及的具体文件**（如 `bunnyseek/prompts.py`、`.bunnyseek/skills/foo/SKILL.md`、`.bunnyseek/memory/bar.md`）。
- 只分析**指定 session**，不跨 session 对比。
