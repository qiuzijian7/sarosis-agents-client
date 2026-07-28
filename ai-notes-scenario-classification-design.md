# AI 笔记开源项目对比 & 基于场景的自动整理设计方案

> 调研日期：2026-07-28
> 问题：llm-wiki 类工具已按「概念 / 实体 / 对比」维度整理导入内容，如何进一步支持用户按「生活 / 工作 / 学习 / 项目」等场景来整理到笔记中？

---

## 一、开源项目自动整理机制对比

### 1.1 四种自动分类范式

| 范式 | 代表项目 | 机制 | 回答的问题 | 局限 |
|---|---|---|---|---|
| **本体驱动** | llm-wiki / OpenWiki | LLM 将捕获内容「编译」为 Wiki 页（概念、实体、主题、对比），构建知识图谱，自动检测孤立页/断链 | 这是什么？ | 不回答「属于我生活的哪个部分」，缺行动上下文 |
| **标签驱动** | Karakeep（原 Hoarder） | 抓取正文 → LLM 生成标签 → 规则引擎路由到列表（如 github.com → GitHub Repos 列表）；强调「先写好标签分类 prompt」是最高杠杆配置 | 关于什么？ | 标签扁平易膨胀；分类规则靠人手写 |
| **聚类驱动** | NexusMind | Sentence-BERT 向量化 + DBSCAN 聚类自动发现主题 → 长出「领域→主题→子主题→文档」层次树，随内容增加自动优化 | 哪些内容相似？ | 语义相似 ≠ 用户心智中的场景；类目名不稳定 |
| **场景/行动驱动** | PARA 系实践（OpenClaw 笔记流、Hermes para-second-brain）、GBrain | LLM 静默判断落入 Projects/Areas/Resources/Archives；GBrain 用 Schema Pack 定义 22 种页面类型（people/companies/meetings/deal…）+ 43 个 skill 夜间「睡眠循环」自动合并、去重、修正 | 我在什么情境用它？ | 分类目录常写死在 prompt；纠错反馈弱；GBrain 部署重 |

### 1.2 值得借鉴的具体机制

- **llm-wiki 三层架构**（Karpathy 模式）：`raw 原始层（不可变）→ 结构化提取层 → wiki 呈现层`。原始数据永不改动，整理是「编译」出来的，可随时重编译。
- **Karakeep 规则引擎**：硬规则（域名/关键词 → 列表）优先于 AI，确定性高、成本为零。
- **NexusMind 聚类**：不预设类目，从数据中「涌现」主题——适合发现用户没意识到的新场景。
- **GBrain Schema Pack**：「大脑的形状」可声明式配置，`schema detect` 还能扫描现有文件自动推荐类型。
- **GBrain 睡眠循环**：整理不必发生在捕获时刻，夜间批量做合并/去重/矛盾检测。
- **OpenClaw 笔记流的知识浓度分流**：高浓度内容（干货/原则/长文）独立建档；低浓度（闪念/备忘）追加到当日日记，避免碎片化建档污染目录树。
- **PARA 核心原则**：按行动可能性（actionability）而非主题组织；项目完结 → 自动流入 Archives，类目之间有生命周期流动。
- **原子事实 Schema**（PARA+atomic facts 实践）：facts 永不删除，只 `superseded`；`relatedEntities` 交叉引用使其成为图而非孤岛。

---

## 二、关键洞察：知识轴与场景轴正交

llm-wiki 的「概念/实体/对比」是**知识本体轴**（What it is），「生活/工作/学习/项目」是**行动上下文轴**（When/Why I use it）。二者正交：

> 同一篇《React 性能优化》既是知识层「React」实体页的素材，也可能同时属于「工作→前端重构项目」和「学习→前端进阶」。

因此正确设计**不是把 wiki 按场景重新分一遍**（会导致复制、失同步、单一归属困境），而是：

```
场景层（Scene Layer）＝ 视图，只存引用 + 场景内摘要
        │  引用 / transclusion（一条内容可挂多个场景）
        ▼
知识层（Knowledge Layer）＝ llm-wiki 现有的概念/实体/对比页，全局唯一
        ▼
原始层（Raw Layer）＝ 捕获的原始内容，不可变
```

---

## 三、设计方案

### 3.1 数据模型

```jsonc
// capture（原始条目）
{
  "id": "cap-20260728-001",
  "content_ref": "raw/2026/07/28/clip-001.md",
  "source": { "app": "chrome", "domain": "react.dev", "captured_at": "2026-07-28T21:30" },
  "extraction": {              // 知识层已有的抽取结果，分类器直接复用
    "summary": "...",
    "concepts": ["虚拟DOM", "memo"],
    "entities": ["React"],
    "density": "high"          // 知识浓度：high 独立建档 / low 追加日记
  },
  "scene_assignments": [       // 场景层：多归属
    { "scene": "work/frontend-refactor", "confidence": 0.91, "by": "auto", "reason": "..." },
    { "scene": "study/frontend", "confidence": 0.62, "by": "user-confirmed" }
  ]
}
```

```yaml
# 场景 Schema（可配置，参考 GBrain Schema Pack）
scenes:
  - id: work
    label: 工作
    profile: "与本职工作、会议、汇报、同事协作、公司业务相关的内容"   # 给 LLM 的判定画像
    rules:                                                        # 硬规则优先于 LLM
      - match: { domain: ["tapd.woa.com", "git.tencent.com"] }
      - match: { time_range: "workday 09:00-19:00", source_app: "wechat-work" }
    substructure: by_project      # 子结构策略：按项目名下钻
  - id: life
    label: 生活
    profile: "健康、财务、家庭、旅行、购物等个人生活内容"
    substructure: by_area
  - id: study
    label: 学习
    profile: "为提升技能/兴趣而收集的教程、课程、论文、方法论"
    substructure: by_topic
  - id: projects
    label: 项目
    profile: "有明确目标和起止时间的个人项目"
    substructure: by_project
    lifecycle: { on_complete: archive }   # PARA 流动性
inbox: { threshold: 0.5 }
```

### 3.2 分类流水线（五阶段）

1. **捕获**：剪贴板 / 浏览器插件 / 对话记录 / RSS，只记录内容 + 来源元数据。
2. **内容理解**：复用知识层已有的 LLM 抽取（摘要、概念、实体、知识浓度），**不重复调用**。
3. **场景分类器（多信号融合）**：
   - **来源信号**（零成本，先跑）：命中场景 rules 的硬规则直接给高置信；
   - **内容信号**：一次轻量 LLM 调用，输入 = 摘要 + 概念/实体 + 场景 profiles，输出 `[{scene, sub_path, confidence, reason}]`（结构化 JSON，允许多个）；
   - **行为信号**：检索该用户最近 N 条人工纠正样本作为 few-shot 注入 prompt。
4. **置信度分级路由**：
   - `≥ 0.85`：静默自动归入，保留可撤销的「AI 已整理」记录（参考 OpenWiki 周报的点赞/忽略反馈）；
   - `0.5 – 0.85`：归入但标记「建议」，UI 上一键确认 / 改派，附 reason；
   - `< 0.5`：进 Inbox，不猜。Inbox 支持周期性批量处理（勾选多条 → 一次派发）。
5. **反馈闭环**：用户每次纠正写入 `corrections.jsonl`（content 摘要 + 错误场景 + 正确场景）。纠正样本用于：① few-shot 注入；② 积累到阈值后由 LLM 提炼成新的硬规则建议（「你 5 次把 xx 域名的内容改到工作，要加条规则吗？」）；③ 更新场景 profile 措辞。

### 3.3 场景内的二级组织

进入场景后不是平铺，按 `substructure` 策略下钻：

- **项目类**（work 子项目 / projects）：`场景/项目名/`，项目页自动维护时间线 + 关联实体列表；项目状态完结时整体移入 `archives/`（PARA 流动）。
- **领域类**（life/study）：`场景/领域主题/`，主题由「预设 + 聚类涌现」混合——预设常用领域，Inbox 与领域内积压内容定期跑聚类（NexusMind 思路），足够聚集时建议新子主题。
- **知识浓度分流**（OpenClaw 实践）：高浓度 → 独立知识卡片文件；低浓度闪念 → 追加到 `场景/journal/YYYY-MM-DD.md`，保持目录树清爽。

### 3.4 场景页 = 生成的视图

场景页本身也是「编译产物」（遵循 llm-wiki 哲学）：

```markdown
# 工作 / 前端重构项目
> 自动维护 · 最后编译 2026-07-28 23:00

## 本周新增（3 条）
- [React 性能优化指南](ref:cap-001) —— 关联实体：[[React]]
## 关键概念（来自知识层）
[[虚拟DOM]] · [[代码分割]] · [[memo]]
## 相关对比页
[[Vite vs Webpack]]
```

引用知识层页面而非复制正文；删除场景不影响知识层；重编译可随时刷新。

### 3.5 夜间维护循环（借鉴 GBrain 睡眠循环）

定时批量任务，不阻塞捕获路径：
- 项目生命周期检查：超过 N 天无新增的项目 → 建议归档；
- Inbox 积压聚类 → 建议新场景/子主题；
- 场景间矛盾检测（同一内容在多场景的摘要不一致）；
- 生成「本周整理报告」：新增分布、纠正统计、分类准确率趋势。

### 3.6 冷启动与迁移

- 首次启用：对存量库跑一遍批量分类（低速队列），全部按「建议」处理而非静默归档，让用户批量确认建立初始纠正样本；
- `scene detect`（参考 GBrain schema detect）：扫描用户现有目录/标签结构，自动推荐场景 Schema 初稿。

---

## 四、方案要点总结

1. **双层正交**：场景层是知识层之上的视图，引用不复制，一条内容可多归属。
2. **场景可配置**：声明式 Scene Schema（profile + rules + substructure + lifecycle），不写死在 prompt。
3. **多信号融合**：硬规则（零成本）→ LLM 语义 → 用户历史 few-shot，逐级兜底。
4. **置信度分级**：高置信静默、中置信建议、低置信进 Inbox——平衡「全自动分错」与「事事确认」。
5. **反馈闭环**：纠正即训练数据，积累后自动提炼规则，系统越用越准。
6. **编译哲学**：raw 不可变，场景页可随时重编译；夜间循环做归档、聚类、矛盾检测。
