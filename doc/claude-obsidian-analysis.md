# claude-obsidian 源码拆解：核心机制分析

> 仓库：`github.com/agricidaniel/claude-obsidian`（AgriciDaniel/claude-obsidian）
> 定位：Self-organizing AI second brain for Obsidian + Claude Code。把任意来源"投喂"给 Claude，它读取、链接、归档进一个你完全拥有的纯 Markdown 知识图谱。基于 Karpathy 的 LLM Wiki 模式（raw → 提取 → 呈现）。
> 形态：不是 Obsidian 插件二进制，而是一套 **Agent Skills**（`.md` 技能定义 + `scripts/` 下的 Python/Bash 脚本），由 Claude Code / Codex / Cursor / Gemini CLI 等宿主驱动。
> 与本项目关系：我们前面几轮在讨论「AI 笔记按场景（生活/工作/学习/项目）自动分类」。claude-obsidian 解决的是**知识层**（这是什么）的自组织与检索，其「组织」靠 Methodology Mode 配置驱动；它**没有**我们设计的语义场景轴、置信度路由、反馈闭环。本文拆解其机制，并标出可借鉴点与差异。

---

## 1. 总体架构：三层模型（Karpathy LLM Wiki 模式）

```
vault/
├── .raw/       # Layer 1: 不可变源文档（原子写入，永不修改）
├── wiki/       # Layer 2: LLM 生成的知识库（index/hot/log + 分类目录）
└── CLAUDE.md   # Layer 3: schema 与指令（即插件本身）
```

知识库标准布局（`wiki/`）：

```
wiki/
├── index.md            # 主目录：所有页面的 master catalog
├── log.md              # 操作的时间线记录（append-only，新条目置顶）
├── hot.md              # 热缓存：最近上下文摘要（~500 词），覆盖写
├── overview.md         # 全局执行摘要
├── sources/            # 每个源一份摘要页
├── entities/           # 人物 / 组织 / 产品 / 仓库（_index.md 子索引）
├── concepts/           # 想法 / 模式 / 框架
├── domains/            # 顶层主题域
├── comparisons/        # 并排对比分析
├── questions/          # 已归档的问答
└── meta/               # 仪表盘 / lint 报告 / 约定
```

`.raw/` 在 Obsidian 中隐藏（文件浏览器与图谱视图都不显示），专门用于存放原始资料。

**关键设计哲学**（来自 `skills/wiki/SKILL.md`）：
- "The wiki is the product. Chat is just the interface." —— 产物是持久化的知识库，不是对话。
- 与 RAG 的区别：wiki 是**持久化制品**。交叉引用已经存在、矛盾已标注、综合已反映全部已读内容。知识像利息一样复利增长（"compounding vault"）。

---

## 2. 核心机制一：自组织与分类（Methodology Mode）

这是我们最关心的「如何自动整理」部分。claude-obsidian 的答案是**配置/规则驱动的方法论模式**，而非语义自由分类。

### 2.1 Mode Router
`scripts/wiki-mode.py route <type> "<name>"` 根据 vault 的方法论模式，返回页面应落到的相对路径。

```bash
python3 scripts/wiki-mode.py route source "Karpathy 2025 LLM Wiki essay"
# generic:      wiki/sources/Karpathy-2025-LLM-Wiki-essay.md
# lyt:          wiki/notes/Karpathy-2025-LLM-Wiki-essay.md   (+ 更新相关 MOC)
# para:         wiki/resources/incoming/Karpathy-2025-LLM-Wiki-essay.md
# zettelkasten: wiki/20260517123456-Karpathy-2025-LLM-Wiki-essay.md
```

四种模式（`references/modes.md` 定义）：
- **generic**：扁平 `wiki/<type>/` 目录
- **LYT**（Linking Your Thinking）：原子笔记 `wiki/notes/`，并维护 MOC（Map of Content）索引页
- **PARA**（Projects/Areas/Resources/Archives）：新内容默认落 `wiki/resources/incoming/`，**不自动猜主题，留给用户审阅**
- **Zettelkasten**：文件名带时间戳 ID（`20260517123456-*.md`），frontmatter 填 `id:`

`.vault-meta/mode.json` 缺失时回退到 generic（向后兼容）。

### 2.2 Vault Use Case（与 Mode 正交）
v1.0+ 的「Vault Use Case」（Website / GitHub / Business…）描述 vault 的**用途/内容类型**，与 Methodology Mode **可组合**：一个用 PARA 方法论的 "Business" vault 是合法配置。

### 2.3 与我们场景方案的对比（重要）
| 维度 | claude-obsidian | 我们之前的设计 |
|------|----------------|----------------|
| 组织轴 | 方法论（LYT/PARA/Zettelkasten）+ 全局 Use Case | 语义场景（生活/工作/学习/项目） |
| 驱动方式 | 配置驱动 mode router（规则映射） | 规则 → LLM → few-shot 三连击 |
| 置信度分级 | 无（PARA 仅默认落 incoming 等用户） | 三级路由（≥0.85 静默 / 0.5–0.85 建议 / <0.5 Inbox） |
| 反馈闭环 | 无自动纠正回流 | 纠正即样本，回流 few-shot + 提炼规则 |
| 多场景归属 | 单目录落点 | 一条内容可挂多个场景（引用） |

**结论**：claude-obsidian 的「组织」是**结构层面的方法论选择**，不回答"这条内容属于我生活的哪一部分"。这正是我们设计要补的语义场景层。但它的 mode router 思想（可配置、规则优先、与 Use Case 正交组合）可以直接借鉴为我们的「Scene Schema」实现原型。

---

## 3. 核心机制二：摄取流水线（wiki-ingest）

入口技能 `skills/wiki-ingest/SKILL.md`。单条源通常触碰 **8–15 个 wiki 页面**（源摘要 + 多个实体页 + 概念页 + 域页 + 索引更新）。

### 3.1 摄取类型
- **单文件**：读全文 → 与用户讨论要点 → 建源摘要页 → 建/更实体页、概念页 → 更域页与 _index → 更 overview/index/hot → 追加 log → 查矛盾。
- **URL**：WebFetch → 可选 `defuddle` 清洗（省 40–60% token）→ 生成 slug → 存 `.raw/articles/<slug>-<date>.md` → 走单文件流程。
- **图片**：Read 工具原生视觉读取 → OCR/描述 → 存 `.raw/images/<slug>.md` → 走单文件流程。

### 3.2 Delta Tracking（防重复摄取）
`.raw/.manifest.json` 记录每个源的 `hash / ingested_at / pages_created / pages_updated`。摄取前 `md5sum` 比对，hash 相同则跳过（"Already ingested, use force to re-ingest"）。这是廉价的**幂等层**。

### 3.3 Transport 抽象（多写后端）
任何 vault 写操作前先查 `.vault-meta/transport.json`（由 `detect-transport.sh` 生成），按 fallback chain 选后端：
1. `cli` —— `obsidian-cli write`
2. `mcp-obsidian` / `mcpvault` —— MCP 工具
3. `filesystem` —— Claude 的 `Write`/`Edit`（最终兜底，永远可用）

### 3.4 并发安全（wiki-lock.sh）
v1.7 引入**每文件 advisory lock**（`flock`），解决 v1.6 并行 sub-agent 互相覆盖页面的隐患。规则：
- 每个页面写前必须 `wiki-lock acquire <path>`，写后 `release`。
- 锁粒度 = `sha1(vault-relative-path)`，不同页面可并行。
- 60s 陈旧自动解锁（崩溃恢复）。
- PostToolUse hook 在锁持有期间**推迟 git add**，避免撕裂提交。

### 3.5 矛盾检测（Contradiction）
新信息冲突旧页时，**不静默覆盖**，而是双向加自定义 callout `[!contradiction]`（旧页 + 新页各一条），交由用户裁决。自定义 callout 样式由 scaffold 时安装的 CSS snippet 提供，缺失则回退默认样式。

### 3.6 地址分配（DragonScale Mechanism 2）
每个新建非 meta 页获得稳定 `address: c-<6位>`（creation-order counter）。由 `scripts/allocate-address.sh` 用 `flock` 原子分配，避免 read-use-increment 竞争。计数器**只能**经该脚本变更（直接 Write 会触发 git hook 副作用）。`l-NNNNNN` 用于历史页面回填。

---

## 4. 核心机制三：Contextual Retrieval 检索（最精华，v1.7）

这是 claude-obsidian 最具工程含量的部分，实现 Anthropic 2024-09 的 **Contextual Retrieval** 研究（官方测 35–49% 检索失败率下降）。来源 `skills/wiki-retrieve/SKILL.md` + `scripts/contextual-prefix.py` / `bm25-index.py` / `rerank.py` / `retrieve.py`。

### 4.1 为什么需要它
v1.6 的查询路径是 `Read(hot.md) → Read(index.md) → Read(3-5 页) → synthesize`，**页面级粒度**。当答案藏在某个具体段落而非整页时，页面级检索输给 chunk 级检索。v1.7 升级为 chunk 级混合检索。

### 4.2 INGEST 侧：chunk + context prefix
`contextual-prefix.py` 对每个 wiki 页：
1. **切 chunk**：按段落边界，目标 ~500 token（字符近似 /4），200 字符重叠。
2. **生成 context prefix**：为**每个 chunk** 生成 1–2 句，把该 chunk 定位到其源页的上下文（"This passage is from the wiki page X. The page opens: …"）。
3. 写入 `.vault-meta/chunks/<address>/chunk-NNN.json`，含 `raw_text` / `contextualized_text` / `prefix_source` / 各层 hash。

**prefix 三层生成策略**（运行期自动选择）：
- **Tier 1**：`ANTHROPIC_API_KEY` 存在 → 直调 Anthropic API（Haiku 4.5）。page body 作为稳定前缀放进 `system` 并打 `cache_control`（body ≥ ~16KB / Haiku 4.5 缓存下限才生效），chunk 放 `messages`。chunk 0 预热前缀，后续 chunk 命中缓存。**成本 ~$12 / 1000 docs**（含 prompt caching）。
- **Tier 2**：PATH 上有 `claude` → `claude -p` 子进程（用 CC 订阅，免 key，但慢 3–10s/chunk）。
- **Tier 3（默认）**：synthetic —— 仅用 frontmatter title + 首段拼前缀。**零成本、全本地、确定性**，但丢失大部分 context 收益（BM25/向量通道仍可用）。

### 4.3 QUERY 侧：BM25 + 余弦重排
```
query → retrieve.py
  ├─ bm25-index.py query "<q>" --top 20     # 稀疏候选集
  ├─ rerank.py "<q>" --candidates -          # 稠密重排（ollama cosine）
  │     cosine(query_embedding, chunk_embedding)
  │     embedding 缓存于 .vault-meta/embed-cache.json（key = body_hash）
  └─ dedupe by page-address → top-N（带 absolute_path）
```
- **BM25 索引**（`bm25-index.py`）：纯 stdlib 实现 Okapi BM25（k1=1.5, b=0.75），对 `contextualized_text` 建倒排索引，写 `.vault-meta/bm25/index.json`。Unicode-aware tokenizer（CJK/西里尔等），保守英文停用词表保召回。写操作 `fcntl` 排他锁 + 原子 `.tmp`+`rename`。
- **重排**（`rerank.py`）：若本地 `ollama` 可达且 `nomic-embed-text` 已拉取 → 对 query 与各候选的 `contextualized_text` 做 cosine 重排，embedding 按 `body_hash` 缓存（避免重复计算）。否则** no-op 重排**（原序返回，下游 drill-into-page 逻辑不变）。远程 ollama 需 `--allow-remote-ollama`（防正文外泄）。

### 4.4 隐私守卫与特性门控（关键工程纪律）
- Tier 1/2 会把 wiki 正文**发送出机**，两层门控：
  1. `contextual-prefix.py --allow-egress`（默认 off）—— 无此 flag 时 `pick_prefix_tier()` **永远返回 synthetic**，无视环境变量或 claude 二进制。
  2. `bin/setup-retrieve.sh` 在首次非 synthetic 运行前弹确认，默认中止。
- **Feature gating**：未运行 `setup-retrieve.sh` 的 vault，其他技能检测到 `retrieve.py` / chunks / index 缺失时，**必须 fallback** 到 v1.6 的 `hot→index→drill` 读序，绝不破坏基础插件。
- 索引**不自动刷新**（v1.7 为手动）：实质摄取后需重跑 `contextual-prefix.py --all` + `bm25-index.py build`。

### 4.5 对我们「知识层」的启示
这套 Contextual Retrieval 管道是**工业级知识层检索底座**，可直接作为我们之前设计的「知识层」实现原型：
- chunk + context prefix 解决"段落脱离页面语境后检索漂移"的经典问题；
- BM25（稀疏）+ cosine rerank（稠密）的混合范式，比单纯向量检索更稳、更省；
- 三层 prefix + 隐私门控，是可复制的"成本/质量/隐私"三角权衡模板。

---

## 5. 核心机制四：热缓存与跨项目引用

### 5.1 hot.md（热缓存）
~500 词的最近上下文摘要。每次 ingest / 重要 query / session 结束**覆盖写**（不是追加）。格式含 Last Updated / Key Recent Facts / Recent Changes / Active Threads。作用是让任意 session（或指向该 vault 的其他项目）无需爬全库即可获得近期上下文。

### 5.2 代币预算纪律
`wiki/index.md`（主目录）每 ingest 更新。跨项目引用协议（写进其他项目 CLAUDE.md）：
1. 先读 `wiki/hot.md`（~500 token）
2. 不够再读 `wiki/index.md`（~1000 token）
3. 再按需读 `wiki/<domain>/_index.md`
4. 最后才读具体页（每页 100–300 token）

INGEST 侧同样有纪律：先读 hot，再读 index 找已有页，每次 ingest 只读 3–5 个现有页，超过即读得太宽；用 PATCH 式精确编辑，不整页重读。

---

## 6. 核心机制五：保存（save）

`skills/save/SKILL.md` 把对话/答案固化为结构化 note。流程：
- **目的地决策**（Step 0）：用户显式覆盖 > 项目/全局 CLAUDE.md 的 `/save` 规则（如个人 vault `~/Documents/Obsidian Vault/`）> 项目自身 `wiki/`。
- **Note Type 决策**：synthesis（问答/对比）/ concept / source / decision / session。
- **写入风格**：陈述式现在时（写知识而非写对话），全 wikilink，引用源。
- 与 ingest 共享 Transport 抽象与 `wiki-lock` 并发规则；更新 index/log/hot 三步一体。

---

## 7. 与我们「场景自动分类」设计的对比与启示

### 7.1 claude-obsidian 已有的（可借鉴）
1. **可配置组织层**：mode router（generic/LYT/PARA/Zettelkasten）+ Use Case 正交组合 → 我们的「Scene Schema」可照搬此配置化思路，把"方法论"扩展为"语义场景"。
2. **工业级知识层检索**：Contextual Retrieval（chunk + prefix + BM25 + rerank）→ 直接作为我们知识层的检索底座。
3. **幂等 / 并发 / 隐私纪律**：`.manifest` delta、per-file flock、egress 门控 → 工程化范本。
4. **矛盾检测而非静默覆盖** → 与我们"反馈闭环"理念一致（都尊重用户裁决）。

### 7.2 claude-obsidian 缺失的（我们设计补的）
1. **语义场景轴**：它没有"生活/工作/学习/项目"这种用户心智场景的自动判定，只有结构方法论。
2. **置信度三级路由**：它没有"静默 / 建议 / Inbox"分级，PARA 仅默认落 incoming。
3. **反馈闭环自动提炼规则**：纠正不会自动回流为分类信号或规则。
4. **夜间维护循环**：无项目归档检查 / Inbox 聚类建议 / 周报。

### 7.3 融合建议
- **知识层**：直接复用 claude-obsidian 的 Contextual Retrieval 管道（含三层 prefix、BM25、ollama rerank、隐私门控）。
- **场景层（新增）**：在知识层之上叠加可配置 Scene Schema（profile/rules/substructure/lifecycle），用 mode router 的同款"配置优先 + 正交组合"实现，但判定维度换成语义场景；接我们的"规则→LLM→few-shot + 三级路由 + 反馈闭环 + 夜间循环"。
- **引用而非复制**：场景层只存 `SceneBinding` 引用，沿用 claude-obsidian 的 frontmatter + wikilink 约定，删除场景不伤知识页。

---

## 8. 可复用代码清单（scripts/）

| 脚本 | 职责 | 复用价值 |
|------|------|----------|
| `scripts/contextual-prefix.py` | chunk + 三层 context prefix 生成 | 知识层检索核心，直接移植 |
| `scripts/bm25-index.py` | 纯 stdlib Okapi BM25 倒排索引 | 零依赖稀疏检索，可直接用 |
| `scripts/rerank.py` | ollama cosine 重排 + embedding 缓存 | 稠密重排，含锁与远程守卫 |
| `scripts/retrieve.py` | 查询编排（BM25→rerank→dedupe） | 混合检索入口 |
| `scripts/wiki-mode.py` | mode router（组织路径决策） | 可改造为 Scene Schema router |
| `scripts/wiki-lock.sh` | per-file flock 并发锁 | 多写者安全范本 |
| `scripts/allocate-address.sh` | 原子地址分配（flock） | DragonScale 稳定 ID 方案 |
| `scripts/detect-transport.sh` | 写后端探测 | Transport 抽象原型 |

---

## 9. 一句话总结

claude-obsidian 的本质是：**用 Agent Skills 把 Karpathy 的三层 LLM Wiki 模式工程化**——`.raw` 不可变源、`wiki` LLM 知识库、`CLAUDE.md` 指令；其"自组织"靠**可配置方法论模式 + 跨项目引用协议**，"检索"靠**Contextual Retrieval 混合管道**。它把知识层（这是什么）做到工业级，却**未触及语义场景层（我在什么情境用它）**——那一层，正是我们前面设计的置信度路由 + 反馈闭环 + 夜间循环要补的。
