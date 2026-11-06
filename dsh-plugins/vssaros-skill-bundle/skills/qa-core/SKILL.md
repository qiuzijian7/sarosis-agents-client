---
name: qa-core
description: QA 引擎层——提供 qa_agent.py CLI 与门禁判定能力。当其他 qa-* skill 需要初始化项目布局、生成 spec-task 蓝图、执行门禁校验（completion / code-review / readiness）、渲染 HTML 报告时加载。它不直接面向用户，是阶段 skill 的共享底座。
activation: manual
match: ["qa-core", "qa agent cli", "门禁校验", "render-report"]
category: development
recommended_tools: ["terminal", "file_read", "file_write"]
---

# QA Core — 引擎与门禁底座

本 skill 是 QA 流水线的**能力层**，被 `qa-context-profiling` / `qa-script-generation` /
`qa-execution-repair` / `qa-quality-review` / `qa-acceptance-report` 共同依赖。
它自己不编排流程——编排在 `qa-orchestrator` agent。

## CLI 位置

```
<本 skill 目录>/scripts/qa_agent.py
```

Windows 执行前必须设置编码，否则中文产物乱码：

```bash
export PYTHONIOENCODING=utf-8
python "<SKILL_DIR>/scripts/qa_agent.py" version    # → 2.0.0
```

依赖：Python 3.9+，仅标准库，无第三方包。

## 命令索引

| 命令 | 用途 |
|---|---|
| `init-project --repo .` | 建 `.qa-agent/` 布局 |
| `generate-spec-tasks --cases … --output …` | 用例 → spec-task 蓝图 |
| `run-with-env --repo . --spec …` | 带环境变量执行测试 |
| `assert-completion --cases … --spec-tasks … --output …` | completion 门禁 |
| `assert-code-review --code-review … --output …` | review 门禁 |
| `assert-readiness --completion-check … --code-review … --output …` | 最终就绪判定 |
| `render-report --cases … --run … --output …` | 渲染 HTML 报告 |

完整语法见 ming-qa 原 `references/cli-reference.md`（本 skill 未随迁，需要时从
`G:/CustomWorkspaces/AIProjects/ming-qa/skills/quality-assurance-agent/references/` 查阅）。

## 门禁语义

- **completion-check**：P0/P1/P2 各优先级的 spec 是否都已执行且通过
- **code-review-check**：`code-review.json` 中是否存在 P0/P1 blocking 项
- **readiness-check**：取前两者交集，四档判定
  1. 就绪 — 两者全通过
  2. 有条件就绪 — P0 通过，P2 有遗留
  3. 未就绪 — 存在 P0/P1 未通过
  4. 未完成 — 门禁未跑完

## 安全边界

CLI 会**修改产品代码、执行测试脚本、连接数据库**。仅在用户明确要求验收/回归时使用，
且必须先在非生产仓库试跑。
