---
name: qa-acceptance-report
description: QA 阶段 6——汇总门禁产物、渲染 HTML 报告、给出最终就绪判定。这是流水线最后一个阶段，也是最终质量把关口。当需要出验收报告、判定是否可发布、汇总 QA 结论时触发。
activation: auto
match: ["验收报告", "QA 报告", "就绪判定", "能否发布", "验收结论"]
category: development
recommended_tools: ["terminal", "file_read", "file_write"]
---

# QA Acceptance Report — 报告与最终判定

输入：前序所有门禁产物。输出：`reports/latest-report.html` + `readiness-check.json`。

**这是最终质量把关口。** 判定取 completion ∩ code-review 的交集——两者都通过才算「就绪」。

## 工作流

### 1. 校验产物新鲜度

报告必须反映**当前**用例与门禁状态，过期产物会导致误判：

```bash
python "<qa-core>/scripts/qa_agent.py" assert-report-freshness \
  --report .qa-agent/reports/latest-report.html \
  --cases .qa-agent/current/test-cases.json \
  --spec-tasks .qa-agent/current/test-spec-tasks.json \
  --completion-check .qa-agent/current/completion-check.json \
  --risk-analysis .qa-agent/current/risk-analysis.json \
  --code-review .qa-agent/current/code-review.json \
  --output .qa-agent/current/report-freshness-check.json
```

### 2. 最终就绪判定

```bash
python "<qa-core>/scripts/qa_agent.py" assert-readiness \
  --completion-check .qa-agent/current/completion-check.json \
  --code-review .qa-agent/current/code-review.json \
  --report .qa-agent/reports/latest-report.html \
  --report-freshness-check .qa-agent/current/report-freshness-check.json \
  --output .qa-agent/current/readiness-check.json
```

### 3. 渲染报告

```bash
python "<qa-core>/scripts/qa_agent.py" render-report \
  --cases .qa-agent/current/test-cases.json \
  --run .qa-agent/current/latest-run.json \
  --spec-tasks .qa-agent/current/test-spec-tasks.json \
  --completion-check .qa-agent/current/completion-check.json \
  --risk-analysis .qa-agent/current/risk-analysis.json \
  --code-review .qa-agent/current/code-review.json \
  --readiness-check .qa-agent/current/readiness-check.json \
  --output .qa-agent/reports/latest-report.html
```

### 4. 编码校验（Windows 必做）

```bash
python "<qa-core>/scripts/qa_agent.py" check-mojibake \
  .qa-agent/reports/latest-report.html --strict
```

## 四档判定

| 档位 | 条件 | 结论 |
|---|---|---|
| **就绪** | completion 与 review 全通过 | 可发布 |
| **有条件就绪** | P0 全通过，仅 P2 遗留 | 可发布，需跟进 |
| **未就绪** | 存在 P0/P1 未通过 | **不可发布**，列出阻塞项 |
| **未完成** | 门禁未跑完 | 无法判定，先补齐 |

## 纪律

- 判定**只看门禁产物**，不凭印象给结论
- 「未就绪」时必须列出具体阻塞项（`path:line` + 风险等级）
- 不美化结论——门禁不过就是不过
