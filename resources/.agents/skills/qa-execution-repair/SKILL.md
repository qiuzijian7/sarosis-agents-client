---
name: qa-execution-repair
description: QA 阶段 4——执行测试、分类失败、修最小根因、跑 completion 门禁。当需要执行测试、排查失败原因、修复并复跑、校验完成度时触发。
activation: auto
match: ["执行测试", "跑测试", "失败修复", "completion 门禁", "回归执行"]
category: development
recommended_tools: ["terminal", "file_read", "patch", "trace_path"]
---

# QA Execution & Repair — 执行与修复

输入：`test-spec-tasks.json` + 测试脚本。输出：`latest-run.json` + `completion-check.json`。

## 工作流

### 1. 执行

```bash
export PYTHONIOENCODING=utf-8
python "<qa-core>/scripts/qa_agent.py" run-with-env --repo . --spec <spec路径>
```

先确认服务已就绪；未就绪就先拉起，不要直接判定失败。

### 2. 失败分类（不要一上来就改代码）

| 类型 | 判据 | 处置 |
|---|---|---|
| **测试写错** | 断言与需求不符、选择器失效 | 改测试，不动产品代码 |
| **产品缺陷** | 断言与需求一致但行为不符 | 修产品代码 |
| **环境问题** | 服务未起、数据缺失、超时 | 修环境，重跑 |

**先分类，再动手。** 分错了会把产品 bug 掩盖成测试问题。

### 3. 最小根因修复

- 只改导致失败的最小范围，不顺手重构、不扩大改动
- 改产品代码前播报：`修复：<file> — <一句话根因>`，然后立刻继续
- 用 `trace_path` 确认改动的下游影响，避免引入新问题

### 4. completion 门禁

```bash
python "<qa-core>/scripts/qa_agent.py" assert-completion \
  --cases .qa-agent/current/test-cases.json \
  --spec-tasks .qa-agent/current/test-spec-tasks.json \
  --priorities P0,P1,P2 --min-specs-by-priority P0=1,P1=1,P2=1 \
  --output .qa-agent/current/completion-check.json
```

## 纪律

- 不判定质量，只确保**该跑的都跑了且通过**
- 失败无法归类时如实上报阻塞，不要强行改代码凑绿
- 修产品代码是高风险动作，改前必须说明根因
