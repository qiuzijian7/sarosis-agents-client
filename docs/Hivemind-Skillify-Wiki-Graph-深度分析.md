# Hivemind 三大子系统深度技术分析

> 日期：2026-06-15 | 项目：`@deeplake/hivemind` v0.7.94 | 分析范围：Skillify / Wiki Summaries / Codebase Graph

---

## 一、Skillify — 智能技能自动挖掘系统

### 1.1 系统架构总览

Skillify 包含四个管道，由 **39 个源文件** 组成：

```
┌────────────────────────────────────────────────────────────────┐
│                      Skillify 系统                            │
├────────────┬──────────────┬──────────────┬────────────────────┤
│ 挖掘管道    │ 拉取/传播     │ SkillOpt     │ 本地离线挖掘        │
│ (核心)      │ (pull/unpull) │ (优化反馈)   │ (mine-local)       │
└────────────┴──────────────┴──────────────┴────────────────────┘
```

### 1.2 挖掘管道 — 完整工作流

#### 阶段 1：触发（triggers.ts）

**两种触发机制：**

| 触发方式 | 函数 | 机制 | 触发条件 |
|---------|------|------|---------|
| **Stop Counter** | `tryStopCounterTrigger()` | 每次 Stop/assistant-complete 事件递增计数器 | `counter >= 20`（可配置） |
| **SessionEnd** | `forceSessionEndTrigger()` | 会话结束时无条件触发 | 总是触发（捕获"尾部知识"） |

```
Stop hook 触发
  → tryStopCounterTrigger()
    → bumpStopCounter(cwd)              // 递增计数器（RMW 锁保护）
    ← state.counter = N
    if N < 20: return                   // 不满足阈值，静默返回
    → tryAcquireWorkerLock(key)         // 获取项目级文件锁
    → resetCounter(key)                 // 计数器归零
    → spawnSkillifyWorker(...)          // 启动分离子进程
```

**关键设计：**
- SessionEnd 在启动 worker **前** 先调用 `resetCounter()`，防止双重触发
- 锁通过 `openSync(path, "wx")` 原子创建，最大过期 10 分钟
- 状态文件：`~/.deeplake/state/skillify/<projectKey>.json`

#### 阶段 2：会话数据获取

**Worker 执行** (`skillify-worker.ts` 第 352 行)：

```
1. 读取水印 lastDate（确保只挖掘新会话）
2. SQL 查询候选会话：
   SELECT path, MAX(creation_date) AS last_msg
   FROM "<sessionsTable>"
   WHERE project = '<project>'
     AND author = '<userName>'          -- scope=team 时为 IN(<team>)
     AND creation_date > '<lastDate>'   -- 水印过滤
   GROUP BY path ORDER BY last_msg DESC
   LIMIT 20                            -- SESSIONS_TO_MINE × 2

3. 过滤当前会话（isCurrentSession）
4. 修剪至 SESSIONS_TO_MINE = 10 个会话
5. 逐会话获取完整消息行
6. extractPairs(rows) 提取 prompt/answer 对
```

**提取规则** (`extractors/index.ts`)：
- `user_message` → 待处理 prompt
- `assistant_message` → 缓存的回答（多条 assistant 消息拼接）
- `tool_call` → **静默丢弃**
- 无后续回答的 prompt → 不发出（如进行中的最后一条）

#### 阶段 3：Gate 门控判定（核心算法）

**提示构建** (`buildPrompt()`，`skillify-worker.ts` 第 265 行)：

```
=== 系统角色 ===
你是 "${project}" 项目的技能策展人。判断最近的 Agent 活动是否包含值得固化的重复模式。

=== 判定规则 ===
KEEP  → 模式在 ≥3 次交流中重复出现，非显而易见，未被现有技能覆盖
MERGE → 是对现有技能的有意义扩展（name 必须在 mergeTargetNames 中）
SKIP  → 一次性事件、通用工程、已被覆盖

=== 现有技能 === (截断至 30,000 字符)
[project, author=alice]: deploy
[global, read-only, author=bob]: testing

=== 最近交流 === (10 个会话，每对截断至 2,000 字符，总计 40,000 字符)
--- exchange 1 (session abc123, agent claude_code) ---
USER: How do I deploy to staging?
ASSISTANT: Run ./deploy.sh staging --env=production

=== 任务 ===
输出 JSON: { "verdict": "KEEP"|"SKIP"|"MERGE", "name": "...", "body": "...", ... }
```

**LLM 调用** (`gate-runner.ts`)：

| Agent | CLI 命令 |
|-------|---------|
| Claude Code | `claude -p <prompt> --no-session-persistence --model haiku --permission-mode bypassPermissions` |
| Codex | `codex exec --dangerously-bypass-approvals-and-sandbox <prompt>` |
| Cursor | `cursor-agent --print --model auto --force --output-format text <prompt>` |
| Hermes | `hermes -z <prompt> --provider openrouter -m anthropic/claude-haiku-4-5 --yolo` |

- 超时：120,000 ms
- 缓冲区：8 MB
- 递归防护：`HIVEMIND_WIKI_WORKER=1` + `HIVEMIND_CAPTURE=false`

**判定解析** (`gate-parser.ts`)：
- 优先在 ```json ... ``` 代码块中查找
- 回退到平衡大括号 `{...}`
- 验证 `verdict ∈ {KEEP, SKIP, MERGE}`

#### 阶段 4：技能生成

**KEEP → `writeNewSkill()`**：
```
~/.claude/skills/<name>/SKILL.md
---
name: <kebab-case>
description: "..."
trigger: "..."
author: user@example.com
source_sessions: [session-uuids]
version: 1
created_by_agent: claude_code
created_at: 2025-06-15T...
---

(body — LLM 生成的完整 SKILL.md 内容)
```

**MERGE → `mergeSkill()`**：
- 读取现有 SKILL.md，解析 YAML front matter
- `version += 1`
- 合并 `source_sessions`（去重联合）
- 跨作者合并自动提升 `scope` 为 `"team"`
- 如果目标不存在 → fallback 到 `writeNewSkill()`

**SKIP →** 仅推进水印

#### 水印策略

```
水印 = 被挖掘的最旧会话（而非最新）
原因：SQL LIMIT 可能遗漏旧会话；
      重新挖掘是良性的（相同输入 → SKIP）
```

### 1.3 Pull / Unpull — 技能传播

**Pull** (`pull.ts` 456 行)：

```
1. 从 Deeplake skills 表查询队友技能
2. 本地目录：~/.claude/skills/<name>--<author>/
3. 比较 remoteVersion vs localVersion
4. 写入前备份现有 SKILL.md → SKILL.md.bak
5. fanOutSymlinks() — 创建到其他 Agent 根目录的符号链接：
   ~/.agents/skills/<name>--<author> → ~/.claude/skills/<name>--<author>
   ~/.hermes/skills/<name>--<author> → ...
6. 记录拉取清单 ~/.deeplake/state/skillify/pulled.json
```

**自动拉取** (`auto-pull.ts`)：
- 每次 SessionStart 触发
- 相当于 `hivemind skillify pull --all-users --to global`
- 5 秒超时，所有错误静默吞掉
- 可通过 `HIVEMIND_AUTOPULL_DISABLED=1` 禁用

**Unpull** (`unpull.ts`)：
- 由拉取清单驱动（目录命名启发式不可靠）
- `(install, installRoot, dirName)` 三元组去重
- 检测目录是否仍存在，先修剪再删除
- 清理对应符号链接

### 1.4 SkillOpt — 技能持续优化

**触发机制** (`skillopt-trigger.ts`)：

| 事件 | 动作 |
|------|------|
| **PreToolUse** | 当 Agent 调用 ORG 技能时，`markSkillPending()` 打开 K 条消息的判定窗口 |
| **UserPromptSubmit** | 当用户做出反应时，`runEventTrigger()` 启动评分 worker |

**优化流程** (`skillopt-improve.ts`)：

```
1. 定位会话中的技能调用（5 次重试 + 线性退避，应对 Deeplake 写入可见性延迟）
2. windowAroundInvocation() — 获取调用前后 3/6 回合的转录窗口
3. judgeSuccess() — Haiku 评判器：
   { "success": 0|1, "confidence": 0-1, "reason": "..." }
   失败安全：解析失败/超时 → success=1（保守策略）
4. 如果 success=0（失败） → proposeSkillEdit() — Sonnet 提议者：
   诊断单一反复出现的弱点，提出小规模编辑
   编辑预算 = 3（"文本学习率"）
   操作：append / insert_after / replace / delete
5. publishImprovedSkill() — 直接写入 skills 表，version+1
   元记忆去重：alreadyProposed() 检查相同编辑集是否已尝试
```

**关键设计决策：**
- 评判器用 Haiku（便宜，仅针对锚定窗口运行）
- 提议者用 Sonnet（需要强推理能力）
- `<!-- SLOW_UPDATE_START/END -->` 块不可触碰
- 元记忆以 JSONL 存储 `~/.deeplake/state/skillopt/meta.jsonl`

### 1.5 Mine-Local — 离线模式

无需 Deeplake 认证，扫描本地 JSONL 会话文件：

```
~/.claude/projects/         (Claude Code)
~/.codex/sessions/           (Codex)
~/.hermes/sessions/          (Hermes)
~/.cursor/sessions/          (Cursor)
```

**Epsilon-Greedy 会话选择：**
- `ceil((1-ε) × N)` 个最新的当前目录会话
- `floor(ε × N)` 个最新的非当前目录会话
- 用任意未选取的会话填充剩余位置

**一次性哨兵：** `~/.claude/hivemind/local-mined.json` 存在则跳过（除非 `--force`）

---

## 二、Wiki Summaries — 会话自动摘要系统

### 2.1 系统架构

```
SessionStart
  │── 在 memory 表创建占位摘要（description="in progress"）
  │── 注入检索指令到 Agent context
  │
Session Running（每次 Capture 事件）
  │── 事件写入 sessions 表
  │── bumpTotalCount() 更新 sidecar
  │── shouldTrigger() 检测周期性阈值
  │   └── (满足条件) → spawnWikiWorker() [detached 子进程]
  │
SessionEnd
  │── markSessionEnded()
  │── acquireLock() → spawnWikiWorker()
  │── releaseLock()
```

### 2.2 触发策略

**两种触发机制：**

| 类型 | 触发条件 | 默认阈值 |
|------|---------|---------|
| **周期性** | 消息数 ≥ 50 条 **或** 距上次 ≥ 2 小时且有新消息 | `HIVEMIND_SUMMARY_EVERY_N_MSGS=50`, `HIVEMIND_SUMMARY_EVERY_HOURS=2` |
| **最终** | SessionEnd | 总是触发（递归防护：`HIVEMIND_WIKI_WORKER !== "1"`） |
| **首次** | 达到 10 条消息 | `FIRST_SUMMARY_AT = 10` |

### 2.3 Worker 执行流程

```
1. 从 sessions 表拉取 JSONL 事件
2. 检查已有摘要（resume 场景，从 JSONL offset 恢复）
3. 替换 prompt 模板占位符：
   - __JSONL__        → 会话事件路径
   - __SUMMARY__      → 输出文件路径
   - __SESSION_ID__   → 会话 ID
   - __PROJECT__      → 项目名
   - __PREV_OFFSET__  → 恢复进度
4. 调用 Agent CLI 生成摘要
5. 生成 summary_embedding (768-dim nomic-embed-text-v1.5)
6. uploadSummary() → UPSERT 到 memory 表
7. finalizeSummary() → 更新 sidecar 状态文件
```

### 2.4 Prompt 模板

```
You are building a personal wiki from a coding session.
Extract every piece of knowledge — entities, decisions, relationships, facts.

# Session __SESSION_ID__
- **Started**: <from JSONL>
- **Ended**: <now>
- **Project**: __PROJECT__

## What Happened        （2-3 句密集描述）
## People                （**Name** -- role -- action）
## Entities              （**entity** (type) -- what was done）
## Decisions & Reasoning （每个决策及原因）
## Key Facts             （原子化事实列表）
## Files Modified        （path + new/modified/deleted）
## Open Questions / TODO （未解决问题）
## Next Steps            （两步决策）
```

**约束：**
- 禁止包含绝对文件系统路径（隐私保护）
- 总长度 ≤ 4,000 字符
- Resume 支持：PREV_OFFSET > 0 时只处理新内容

### 2.5 存储结构

**Deeplake memory 表：**

```sql
INSERT INTO "memory" (
  id, path, filename, summary, summary_embedding,
  author, mime_type, size_bytes,
  project, description, agent, plugin_version,
  creation_date, last_update_date
) VALUES (...)
```

- `path`：`/summaries/<userName>/<sessionId>.md`
- `description`：从 `## What Happened` 提取前 300 字符
- `summary_embedding`：768 维向量（用于语义搜索）
- UPSERT 逻辑：存在则 UPDATE，不存在则 INSERT

### 2.6 SessionStart 检索机制

Agent 上下文注入：

```
Deeplake memory has THREE tiers:
1. ~/.deeplake/memory/index.md      — 最近 50 条摘要索引
2. ~/.deeplake/memory/summaries/    — 压缩 wiki 摘要 (~3KB/条)
3. ~/.deeplake/memory/sessions/     — 原始完整对话 JSONL

检索工作流：
- cat index.md                    → 时间维度浏览
- grep -r "keyword" summaries/    → BM25 + 语义混合搜索
- cat summaries/<match>.md        → 完整摘要
```

**恢复工作流（"pick up where I left off"）：**
1. `cat ~/.deeplake/memory/index.md` 找到当前项目最新行
2. `cat` 匹配的摘要，检查 `## Next Steps`
3. 加载摘要作为上下文，与当前 git 状态交叉验证

### 2.7 并发控制

- Per-session 锁文件：`~/.claude/hooks/summary-state/<sessionId>.lock`
- 锁过期：10 分钟超时自动回收
- Linux 上通过 `/proc/<pid>/stat` 检测 owner 进程存活
- 非 Linux 回退到 mtime 心跳检测

---

## 三、Codebase Graph — 代码库图谱系统

### 3.1 构建管道

```
Source Discovery → Per-File AST Extraction → Cross-File Resolution
    → Snapshot Assembly → Persist + Cloud Push
```

### 3.2 第一阶段：源文件发现

**方法：** `git ls-files --cached --others --exclude-standard -z`
（正确使用 `.gitignore`，包括锚定和嵌套规则）

**两层忽略：**
1. `~/.deeplake/graph-ignore.json` — 用户可编辑（node_modules, venv, .git...）
2. 仓库 `.gitignore`（通过 `git ls-files`）

**文件匹配：** `/\.(tsx?|jsx?|mjs|cjs|pyi?|go|rs|java|rb|cpp|cc|cxx|hpp|[ch])$/`（排除 `.d.ts`）

### 3.3 第二阶段：逐文件 AST 提取

**9 种语言的 Tree-Sitter 语法：**

| 语言 | 文件 | 语法包 | 发现的声明类型 |
|------|------|--------|--------------|
| TypeScript | `extract/typescript.ts` | `tree-sitter-typescript` | function, class, interface, type alias, enum, const, method |
| JavaScript | `extract/javascript.ts` | `tree-sitter-javascript` | function, generator, class, arrow/function var |
| Python | `extract/python.ts` | `tree-sitter-python` | function, class, module-level const |
| Go | `extract/go.ts` | `tree-sitter-go` | function, method（+method_of 边）, struct, interface, const, var |
| Rust | `extract/rust.ts` | `tree-sitter-rust` | function, struct, enum, trait, impl method, mod, const |
| Java | `extract/java.ts` | `tree-sitter-java` | class, interface, enum, method, constructor |
| Ruby | `extract/ruby.ts` | `tree-sitter-ruby` | method, class, module, require |
| C | `extract/c.ts` | `tree-sitter-c` | function, struct, union, enum, preproc_include |
| C++ | `extract/cpp.ts` | `tree-sitter-cpp` | C 全部 + class, namespace, template, using |

**三遍遍历模式（所有提取器统一）：**

```
Pass 1: 提取声明 → declByName: Map<name, GraphNode>
Pass 2: 提取导入    → import_bindings
Pass 3: 提取文件内调用 → raw_calls（caller → callee name）
```

**解析器管理：**
- `parseWithChunks(parser, sourceCode)` — 16KB 分块 API（解决 tree-sitter 0.21 的 32KB 限制）
- `getParser(grammar)` — WeakMap 单例缓存
- TypeScript 特殊处理：`.ts` 用 TypeScript（拒绝 JSX），`.tsx`/`.jsx` 用 TSX

### 3.4 边的五种关系

| 关系 | 源节点 | 目标节点 | 提取方法 |
|------|--------|---------|---------|
| **imports** | 文件模块节点 | 被导入文件模块 / `external:<specifier>` | ImportDeclaration / require() / #include |
| **calls** | 调用者函数/方法 | 被调用者函数/方法 | call_expression → 向上遍历找到调用者声明 |
| **extends** | 子类 | 基类 | extends_clause / superclasses |
| **implements** | 类 | 接口 | implements_clause |
| **method_of** | 类/结构体 | 方法 | 类体遍历 |

### 3.5 第三阶段：跨文件解析

**`resolveCrossFileCalls()`**（`resolve/cross-file.ts`）：

```
算法：
For each file:
  For each raw_call (caller_node_id, callee_name):
    If callee_name matches a named import in import_bindings:
      Resolve target_module from import specifier
      Look up callee_name in target_module's exportIndex
      → emit calls edge (caller_node_id → target_node_id)

置信度策略：
  高置信度：
    - foo() 且 foo 是命名导入（非默认导入）
    - ns.foo() 且 ns 是命名空间导入（import * as ns）
  跳过：
    - 默认导入（不知道哪个导出是 default）
    - 裸标识符（npm 包）
    - 路径别名 / 桶式重导出
    - 动态 import()
    - 实例分派（obj.foo()）
```

**`repointImportEdges()`**：将 `external:<relative_specifier>` 重定向到真实文件模块节点

**`resolveHeritageEdges()`**：解析 `unresolved:<file>:<name>:<kind>` 占位符（先查同文件，再查导入）

**模块解析**（`resolveModule()`）：
- 尝试扩展名：`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`
- 回退到 `index.ts`
- Python 模块单独处理

### 3.6 快照组装与数据模型

**`GraphSnapshot`** 类型：

```typescript
interface GraphSnapshot {
  directed: true;
  multigraph: true;
  graph: { schema_version, generator, commit_sha, repo_key };
  observation: { ts, branch, worktree_path };  // 易变字段
  nodes: GraphNode[];
  links: GraphEdge[];
}
```

**`GraphNode`**：`id`（格式 `<file>:<name>:<kind>`），label, kind, source_file, source_location, language, exported, signature?, doc?, fan_in?, fan_out?, is_entrypoint?

**`GraphEdge`**：source, target, relation, confidence（EXTRACTED/INFERRED/AMBIGUOUS）, ord?

**输出格式**：NetworkX node-link JSON（按 id/edge 排序的规范化输出，紧凑无空格，确定性）

### 3.7 内容缓存（性能关键）

**缓存布局**：`~/.hivemind/graphs/<repo-key>/.cache/<content-sha256>.json`

```
算法：
1. 对文件 UTF-8 内容计算 SHA-256（非路径派生）
2. 查缓存：如果存在且 schema_version 匹配 → 直接复用
3. 路径重写：将缓存条目的 source_file 改为当前 relativePath
4. 未命中 → 执行 tree-sitter 解析 → 写入缓存

效果：280 文件仓库，1 文件变更：
  2.5 秒 → 85 毫秒（~30x 加速）
```

**快照级 SHA-256**：仅对稳定字段哈希（`observation` 排除 → 跨 worktree 去重）

### 3.8 渲染/可视化

**不是图形可视化**，而是在 VFS 中的**文本管道**：

| VFS 路径 | 渲染器 | 输出 |
|---------|--------|------|
| `cat /graph/index.md` | — | 摘要占位符 |
| `cat /graph/tour` | `tour.ts` | 入口点 + 拓扑排序（Kahn 算法），最多 60 行 |
| `cat /graph/find/<pattern>` | — | 节点匹配 + 保存句柄 |
| `cat /graph/query/<pattern>` | — | 查找 + 一键展开（最多 5 节点 × 8 邻居/关系） |
| `cat /graph/show/<handle>` | — | 通过数字句柄（1-based）或子字符串匹配展开 |
| `cat /graph/impact/<pattern>` | `impact.ts` | 反向 BFS 传递依赖，最多 80 依赖者，最大深度 25 |
| `cat /graph/neighborhood/<file>` | `neighborhood.ts` | 文件内符号 + 跨文件出入边，每方向最多 25 条 |
| `cat /graph/layers` | `layers.ts` | 按路径启发式分组到架构层 |
| `cat /graph/path/<from>/<to>` | `path.ts` | 最短路径 BFS，最多 20 候选项 |

**设计优势**：Agent 通过 `cat /graph/*` 直接读取图信息，零网络调用，纯本地磁盘读取。

### 3.9 Cloud Push / Pull

**Push** (`deeplake-push.ts`)：
```
1. 惰性创建 Deeplake 表
2. SELECT → 检查 snapshot_sha256 是否已存在
3. 不存在 → INSERT（snapshot_jsonb + metadata）
4. 存在但 sha256 不同 → 记录漂移警告（不覆盖）
5. 插入后 SELECT 验证（并发竞争检测）
6. 尽力而为：任何失败只记录日志，不中断构建
```

**Pull** (`deeplake-pull.ts`)：
```
1. 查询最新行 SELECT ... ORDER BY ts DESC LIMIT 1
2. 比较本地 sha256 vs 远程 sha256
3. 本地更新或时间戳更新 → 跳过
4. 远程更新 → 下载并验证 sha256 → 写入本地快照文件
```

**历史记录**：追加 JSONL `~/.hivemind/graphs/<repo-key>/history.jsonl`

### 3.10 Post-Commit 自动构建

```
git commit → .git/hooks/post-commit
  → hivemind graph build --trigger post-commit
  → 构建锁（5 分钟过期）
  → 增量缓存 + 跨文件解析
  → Cloud push（尽力而为）
```

安装/卸载通过 `hivemind graph init` / `hivemind graph uninstall`

---

## 四、三大子系统的协同

```
                         ┌──────────────────────────┐
                         │    Agent Session          │
                         │  (Claude/Codex/Cursor/...) │
                         └──────────┬───────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
    ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐
    │   Wiki Worker   │  │  Skillify Worker │  │  Graph Worker    │
    │                 │  │                  │  │                  │
    │ SessionEnd/     │  │ Stop counter≥20  │  │ Post-commit/     │
    │ Periodic 50msg  │  │ SessionEnd       │  │ Stop/SessionEnd  │
    │                 │  │                  │  │                  │
    │ Generate:       │  │ Generate:        │  │ Generate:        │
    │ Summary.md +    │  │ SKILL.md +       │  │ Snapshot JSON +  │
    │ Embedding       │  │ Skill Registry   │  │ Node-link Graph  │
    └────────┬────────┘  └────────┬─────────┘  └────────┬─────────┘
             │                    │                      │
             ▼                    ▼                      ▼
    ┌──────────────────────────────────────────────────────────┐
    │                  Deeplake 云存储                           │
    │  ┌──────────┬──────────┬──────────┬──────────┬─────────┐ │
    │  │ sessions │  memory  │  skills  │  rules   │  graph  │ │
    │  │ (原始)    │ (摘要)    │ (技能)   │ (规则)   │ (图谱)  │ │
    │  └──────────┴──────────┴──────────┴──────────┴─────────┘ │
    └──────────────────────────────────────────────────────────┘
             │
             ▼
    ┌──────────────────────────────────────┐
    │         SessionStart 注入             │
    │  - 记忆召回 (VFS grep summaries/)     │
    │  - 技能自动拉取 (autopull)            │
    │  - 图谱上下文 (graphContextLine)      │
    └──────────────────────────────────────┘
```

### 协同亮点

1. **Wiki → Skillify 正反馈循环**：摘要中的 `## Key Facts` 和 `## Decisions` 为技能挖掘提供高质量训练数据
2. **Graph → Wiki 交叉验证**：图谱中的函数调用关系可验证摘要中的 `## Files Modified`
3. **Skill → Skillify 去重**：挖掘前先渲染现有技能（30K 字符预算），避免重复生成
4. **共享锁机制**：Wiki 和 Skillify Worker 共享项目级锁，防止并发竞争
5. **统一的 Agent CLI 调度**：三个子系统都通过 `findAgentBin()` + `spawnDetached` 模式启动后台进程

---

## 五、对 Saros 的启示

### 5.1 可立即借鉴的设计

| Hivemind 设计 | Saros 适配建议 |
|-------------|----------------|
| **Stop Counter 触发** | Workflow 节点执行后递增 `executeCounter`，达到阈值触发 Skillify |
| **Gate 三态判定** | 实现 `ISkillGate`，用低成本模型（Knot/DeepSeek）做 KEEP/MERGE/SKIP |
| **内容缓存** | Workflow 节点输出做 SHA-256 缓存，相同输入不重复执行 |
| **VFS 文本管道** | Codebase Graph 不依赖复杂 UI，先实现 `cat /graph/*` 文本接口 |
| **Upsert 模式** | 技能持久化用写入前检查 + 版本比较 + 备份（SKILL.md.bak）|

### 5.2 架构差异需调整

| Hivemind | Saros 差异 | 调整方向 |
|----------|------------|---------|
| 分离 Worker 进程（detached） | VS Code 进程内服务 | 用 `fork()` 或 VS Code `ExtensionHost` 隔离 |
| Deeplake SQL 后端 | TDBAM + JSON 文件 | 扩展 `IMemoryProvider` 支持向量搜索 |
| Agent CLI 作为 LLM 调用层 | `IAgentOSService` Model Provider | 直接调用 `IModelProvider.chat()` |
| `~/.claude/skills/` 文件系统 | `ISkillRegistry` 内存注册表 | 两者可共存：内存注册表 + 文件备份 |
| 跨 Agent 符号链接扇出 | 无 | 实现 Skill 同步到工作区 `.saros/skills/` |

---

> 报告结束。三大子系统总计覆盖 **100+ 源文件**，形成了 Hivemind "记忆-技能-图谱" 三位一体的 Agent 增强体系。Saros 可在保持其"深度工作台"优势的同时，吸收这些横向能力，实现 Agent 智能化水平的飞跃。
