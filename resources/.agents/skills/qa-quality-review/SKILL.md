---
name: qa-quality-review
description: QA 阶段 5——独立视角代码审查，产出 code-review.json 并跑 review 门禁。这是流水线中第一个做质量判断的环节。当需要审查改动质量、检查 P0 阻塞项、验收前评审时触发。
activation: auto
match: ["代码审查", "质量评审", "code review 门禁", "验收评审"]
category: development
recommended_tools: ["file_read", "search_graph", "trace_path", "detect_changes", "query_graph"]
---

# QA Quality Review — 代码审查

输入：本次改动的 diff。输出：`code-review.json` + `code-review-check.json`。

**这是流水线第一个做质量判断的环节**（阶段 0–4 都不判断质量）。

## 工作流

### 1. 拿到改动范围

```bash
python "<qa-core>/scripts/qa_agent.py" --help    # 确认 CLI 可用
```

配合 `detect_changes` 拿真实 diff，用 `trace_path` 看下游传播。

### 2. 审查维度（按序）

1. **正确性** — 逻辑错误、边界、空值、并发竞态
2. **业务一致性** — 实现是否匹配需求/用例的 `expected`
3. **影响面** — 用 `query_graph` 查扇入，高扇入改动需更严
4. **可维护性** — 命名、重复、死代码
5. **安全与性能** — 只报具体问题，不空泛评论

### 3. 分级

| 级别 | 含义 | 对门禁的影响 |
|---|---|---|
| P0 blocking | 阻断发布 | review 门禁**不通过** |
| P1 blocking | 必须修 | review 门禁**不通过** |
| P2 建议 | 可遗留 | 不影响判定，降级为「有条件就绪」 |

### 4. 输出与门禁

写 `.qa-agent/current/code-review.json`（每条含 `path:line` 证据），然后：

```bash
python "<qa-core>/scripts/qa_agent.py" assert-code-review \
  --code-review .qa-agent/current/code-review.json \
  --output .qa-agent/current/code-review-check.json
```

## 纪律

- 每条问题必须有 `path:line` 证据，无证据不写
- **置信度 < 80% 的问题单独标注**，不混进 blocking
- 与阶段 4 独立——自己看代码，不采信执行阶段的结论
