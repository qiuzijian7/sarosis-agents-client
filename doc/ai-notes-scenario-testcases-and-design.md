# AI 笔记 · 场景自动分类：测试用例与设计方案

> 目标：在 llm-wiki 式「知识层」（概念 / 实体 / 对比）之上，叠加一层「场景层」（生活 / 工作 / 学习 / 项目…）。
> 两者**正交**：场景层是知识层的**引用视图**，不复制原文，一条内容可挂多个场景，删场景不伤知识层。
> 本文件先定义**测试用例**（把"要验证什么"钉死），再据此给出**可落地的设计方案**。

---

## 1. 测试用例设计

### 1.1 覆盖策略

按「功能正确性 → 边界 → 异常 → 闭环 → 运维」五层覆盖，确保：
- 正常路径（高/中/低置信）都有断言
- 多场景归属、规则优先、冲突等边界被覆盖
- 抓取失败、删除场景、批量导入等异常不崩
- 反馈闭环与夜间循环可被验证

### 1.2 详细用例

**组 A · 单场景 · 高置信（静默归档，P0/P1）**

| 用例ID | 输入 | 前置 | 预期行为 | 断言 | 优先级 |
|--------|------|------|----------|------|--------|
| TC-A01 | 技术文《React 大型表格性能优化》源技术社区 | 默认 Schema | `work → 前端重构项目`，conf ≥ 0.85 | `SceneBinding.method ∈ {llm, fewshot}`、`status=active`、不弹确认 | P0 |
| TC-A02 | 菜谱《番茄炒蛋》源美食号 | 默认 Schema | `life → 美食`，conf ≥ 0.85 | 静默归档 | P1 |
| TC-A03 | 论文《Transformer 综述》源 arXiv | 默认 Schema | `study → 深度学习` | 静默归档 | P1 |

**组 B · 单场景 · 中置信（建议确认，P0）**

| 用例ID | 输入 | 前置 | 预期行为 | 断言 | 优先级 |
|--------|------|------|----------|------|--------|
| TC-B01 | 健身文《晨跑的好处》 | 默认 Schema | `life → 健身` 0.6，给出次选项 `study → 健康` | UI 推一条可一键确认/改；绑定 `status=pending` | P0 |
| TC-B02 | 《SQL 优化笔记》半工作半学习 | 默认 Schema | `study` 0.7，次选项 `work → 项目` | 建议确认，且返回 top-2 候选 | P0 |

**组 C · 低置信（进 Inbox，P1）**

| 用例ID | 输入 | 前置 | 预期行为 | 断言 | 优先级 |
|--------|------|------|----------|------|--------|
| TC-C01 | 工作群聊截图，无上下文 | 默认 Schema | conf < 0.5 → Inbox | 生成 `InboxItem`，`reason=low_confidence` | P1 |
| TC-C02 | 纯图片，OCR 无有效文本 | 默认 Schema | 进 Inbox 待处理 | `InboxItem.reason=no_text` | P2 |

**组 D · 多场景归属（P0）**

| 用例ID | 输入 | 前置 | 预期行为 | 断言 | 优先级 |
|--------|------|------|----------|------|--------|
| TC-D01 | 《React 性能优化》 | 默认 Schema | 同时挂 `work → 前端重构项目` 与 `study → 前端进阶` | `SceneBinding` 数 = 2，分别有独立 conf | P0 |
| TC-D02 | 《家庭旅行攻略》 | 默认 Schema | 挂 `life → 旅行`，可选 `project → 家庭项目` | 至少 2 个绑定，互不影响 | P1 |

**组 E · 硬规则优先（P0）**

| 用例ID | 输入 | 前置 | 预期行为 | 断言 | 优先级 |
|--------|------|------|----------|------|--------|
| TC-E01 | `github.com/owner/repo` 仓库页 | 规则 `github.com → github-repos` | 规则命中，不经 LLM | `SceneBinding.method=rule` | P0 |
| TC-E02 | 公司域名内部文档 `corp.wiki/...` | 规则 `corp.wiki → work/公司项目`(高优) | 直接归工作，conf=1.0 | `method=rule`、`status=active` | P0 |
| TC-E03 | 内容同时满足规则与 LLM 不同判定 | 规则优先级 > LLM | 规则胜 | `method=rule`，忽略 LLM 结果 | P0 |

**组 F · 反馈闭环（P0）**

| 用例ID | 输入 | 前置 | 预期行为 | 断言 | 优先级 |
|--------|------|------|----------|------|--------|
| TC-F01 | 例 A 被误分 `study`，用户纠正为 `work` | 已有 1 条类似内容 | 写 `CorrectionSample`；重判同类文章归 `work` | 同类新内容 `SceneBinding.sceneId=work` | P0 |
| TC-F02 | 同类纠正样本 ≥ N（默认 5） | 夜间循环 | 自动提炼规则建议 | 生成 `RuleSuggestion` 待确认 | P1 |
| TC-F03 | 静默归档后用户撤销 | 绑定已 active | 转 `pending` 或回 Inbox | 原绑定 `status` 变更，可恢复 | P1 |

**组 G · 夜间循环（P1）**

| 用例ID | 输入 | 前置 | 预期行为 | 断言 | 优先级 |
|--------|------|------|----------|------|--------|
| TC-G01 | 某 `project` 场景 30 天无更新且标记完结 | 夜间循环 | 提出归档建议 | 生成 `ArchiveSuggestion` | P1 |
| TC-G02 | Inbox 中 5 条聚类为同主题 | 夜间循环 | 建议新建场景 | 生成 `SceneSuggestion` | P1 |
| TC-G03 | 周期触发 | 夜间循环 | 生成整理周报 | 输出统计：新归类数 / Inbox 余量 / 潜在场景 | P2 |

**组 H · 异常 / 边界（P1/P2）**

| 用例ID | 输入 | 前置 | 预期行为 | 断言 | 优先级 |
|--------|------|------|----------|------|--------|
| TC-H01 | 抓取失败 / 空内容 | 入站 | 不崩溃，进 Inbox 待修 | 生成 `InboxItem.reason=fetch_failed` | P1 |
| TC-H02 | 删除某场景 | 该场景有绑定 | 仅清 `SceneBinding`，`KnowledgePage` 保留 | 知识层不受影响，引用计数归零 | P1 |
| TC-H03 | 冲突规则（两条命中不同场景） | 规则集 | 取高优先级规则 | 仅 1 条 `rule` 绑定生效 | P2 |
| TC-H04 | 批量导入 1000 条 | 队列 | 限流 / 分批，不丢 | 全部进入流水线，无遗漏 | P2 |

### 1.3 覆盖矩阵（机制 × 场景）

| 机制 \ 场景 | 工作 | 学习 | 生活 | 项目 | Inbox |
|-------------|------|------|------|------|-------|
| 规则命中 | TC-E02 | – | TC-A02* | TC-E01 | – |
| LLM 判定 | TC-A01 | TC-A03 | TC-B01 | TC-D01 | TC-C01 |
| few-shot 纠正 | TC-F01 | – | – | – | – |
| 多归属 | TC-D01 | – | TC-D02 | – | – |
| 低置信兜底 | – | – | – | – | TC-C02 |

---

## 2. 设计方案

### 2.1 系统架构（分层）

```
Ingest Layer      抓取正文 + 元数据（来源/时间/作者）
   │
Knowledge Layer   概念/实体/对比抽取（复用 llm-wiki 能力）→ KnowledgePage
   │
Scene Classifier  ① 硬规则  ② LLM 判定  ③ 注入 few-shot 历史纠正
   │
Confidence Router  ≥0.85 静默  |  0.5–0.85 建议  |  <0.5 Inbox
   │
Scene View        引用聚合（不复制原文，支持多挂）
   ▲                                  │
   │         Feedback Store ──────────┘  (纠正样本回灌 few-shot)
   │
Nightly Loop      归档检查 / Inbox 聚类 / 周报  ──► 回灌 Classifier
```

### 2.2 核心数据模型

| 实体 | 关键字段 | 说明 |
|------|----------|------|
| `ContentRecord` | `id, source, url, rawText, concepts(JSON), entities(JSON), createdAt` | 入站原文 + 知识层抽取结果 |
| `KnowledgePage` | `id, title, type(concept\|entity\|compare), links[]` | 知识层节点（与场景正交） |
| `SceneSchema` | `id, name, profile(prompt), rules[], substructure, lifecycle` | 可配置场景定义 |
| `SceneBinding` | `id, contentId, sceneId, confidence, method(rule\|llm\|fewshot), status(active\|pending\|archived), createdAt` | 场景层引用（核心） |
| `CorrectionSample` | `id, contentFeatures, oldScene, newScene, createdAt` | 反馈闭环样本 |
| `InboxItem` | `id, contentId, reason, suggestedScene, createdAt` | 低置信待处理 |
| `RuleSuggestion` / `SceneSuggestion` / `ArchiveSuggestion` | `id, payload, status` | 夜间循环产出，待用户确认 |

> 关键约定：**`SceneBinding` 只存引用**，删场景 = 删绑定，知识层 `KnowledgePage` 不受影响。

### 2.3 场景 Schema（可配置 JSON 示例）

```json
{
  "id": "work-frontend-refactor",
  "name": "工作 / 前端重构项目",
  "profile": "前端工程相关：React、性能优化、组件库、构建部署；且与当前进行中的重构项目强相关",
  "rules": [
    { "match": { "domain": "github.com" }, "scene": "github-repos", "priority": 100 },
    { "match": { "keyword": ["重构", "迭代", "需求"] }, "priority": 80 }
  ],
  "substructure": { "type": "project", "archiveAfterDays": 30 },
  "lifecycle": { "onComplete": "archive" }
}
```

### 2.4 分类流水线算法（伪代码）

```text
function classify(content):
    # ① 硬规则（零成本，优先）
    for rule in sorted(sceneSchema.rules, by=priority desc):
        if match(content, rule):
            return bind(content, rule.scene, conf=1.0, method="rule")

    # ② LLM 判定（注入知识层 + few-shot 纠正）
    fewshot = retrieveSimilarCorrections(content, k=5)
    result = llm.classify(
        content.summary,
        content.concepts,            # 复用知识层
        sceneSchema.profiles,
        examples=fewshot            # 历史纠正做少样本
    )
    # ③ 置信度修正
    conf = adjust(result.conf, fewshotAgreement)
    return route(content, result.scene, conf)
```

### 2.5 置信度与路由

- **规则命中**：`conf = 1.0`，直接 `active`。
- **LLM 判定**：取模型输出概率，再用 `few-shot` 一致性轻微修正（历史一致 +0.05，冲突 -0.1）。
- **路由**：
  - `conf ≥ 0.85` → 静默归档（可撤销，不弹窗）
  - `0.5 ≤ conf < 0.85` → 建议确认（推 top-2 候选，一键确认/改）
  - `conf < 0.5` → 进 Inbox（批量处理）

### 2.6 反馈闭环

1. 用户对 `active` / `pending` 绑定做纠正（拖拽 / 重选场景）→ 写 `CorrectionSample`。
2. 同类新内容在 **2.4 ③** 阶段作为 few-shot 注入，提升命中正确场景概率。
3. 同场景纠正样本 ≥ N（默认 5）→ 夜间循环提炼为 `RuleSuggestion`，用户确认后升为永久规则。

### 2.7 夜间循环

每日低峰触发，三件事：
1. **生命周期检查**：`project` 场景超 `archiveAfterDays` 无更新且标记完结 → `ArchiveSuggestion`。
2. **Inbox 聚类**：对 `InboxItem` 向量聚类，同主题 ≥ K 条 → `SceneSuggestion`（建议新场景）。
3. **整理周报**：统计新归类数、各场景分布、Inbox 余量、潜在新场景。

### 2.8 评价指标（映射用例）

| 指标 | 计算 | 关联用例 | 目标 |
|------|------|----------|------|
| 静默归档准确率 | 1 − (被纠正的静默绑定 / 总静默绑定) | TC-A01, TC-F03 | ≥ 95% |
| 确认接受率 | 用户确认的建议 / 总建议 | TC-B01, TC-B02 | ≥ 80% |
| Inbox 消化率 | 已处理的 Inbox / 总 Inbox | TC-C01, TC-G02 | 周度 > 70% |
| 多归属正确率 | 正确多绑 / 多绑用例 | TC-D01, TC-D02 | 100% |
| 规则优先正确率 | 规则命中且未被误覆盖 | TC-E01~E03 | 100% |
| 崩溃率 | 异常输入导致失败数 | TC-H01, TC-H04 | 0 |

---

## 3. MVP 与演进路线

- **MVP（先上）**：`SceneSchema` + 单次 LLM 分类 + Inbox 兜底 + 基础规则。覆盖 TC-A/B/C/D/E 主干。
- **二期**：反馈闭环（TC-F）+ 置信度修正 + 撤销。
- **三期**：夜间循环（TC-G）+ 规则自动提炼 + 周报。
- **长尾**：批量导入限流（TC-H04）、冲突规则消解（TC-H03）。

> 设计原则：**测试先行**——每个新场景 / 新规则上线前，先补对应 TC（尤其 P0 组），再写实现。
