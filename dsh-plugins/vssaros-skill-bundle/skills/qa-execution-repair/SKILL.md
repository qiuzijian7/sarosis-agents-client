---
name: qa-execution-repair
description: QA 阶段 4——执行测试、分类失败、只修测试侧定位与等待、跑 completion 门禁。当需要执行测试、排查失败原因、复跑、校验完成度时触发。
activation: auto
match: ["执行测试", "跑测试", "失败修复", "completion 门禁", "回归执行"]
category: development
recommended_tools: ["pwsh", "read", "write", "codebase_trace"]
tier: core
---

# QA Execution & Repair — 执行与分类

输入：`test-spec-tasks.json` + 测试脚本。输出：`latest-run.json` + `completion-check.json` + 缺陷清单。

**本阶段不改产品代码。** 判定为产品缺陷时只记录并交给开发，由人决定是否修。

## 工作流

### 1. 执行

Playwright 回归走 `run-e2e`（CLI 内部执行 `npx playwright test`）：

```bash
export PYTHONIOENCODING=utf-8
python "<qa-core>/scripts/qa_agent.py" run-e2e --repo . --spec <spec路径>
```

单文件脚本（非 Playwright）才用 `run-with-env --script <脚本路径>`；两者参数不同，不要混用。

先确认服务已就绪；未就绪就先拉起，不要直接判定失败。

### 2. 失败分类（不要一上来就改代码）

| 类型 | 判据 | 处置 |
|---|---|---|
| **测试写错** | 断言与需求不符、定位器失效 | 只改测试侧的定位器与等待，重跑 |
| **产品缺陷** | 断言与需求一致但行为不符 | 记入缺陷清单，写明「复现步骤 → 期望 → 实际 + 证据路径」，**不改产品代码** |
| **环境问题** | 服务未起、数据缺失、超时 | 修环境，重跑 |

**先分类，再动手。** 分错了会把产品 bug 掩盖成测试问题。

### 3. 测试侧修复边界

- 只准改定位器与等待；禁止改写用例的 `expected`、断言值、跳过标记与超时阈值
  ——把断言改松是让红测试变绿的最便宜路径，等于毁掉 oracle
- 禁止修改产品代码、配置与 fixture 数据；发现这类需要改动的情形一律记为阻塞项
- 用 `codebase_trace` 确认缺陷影响面，只用于写报告，不作为动手修改的依据
- 单个用例最多修 3 轮；仍失败就单列为阻塞项，不要凑绿

### 4. completion 门禁

```bash
python "<qa-core>/scripts/qa_agent.py" assert-completion \
  --cases .qa-agent/current/test-cases.json \
  --spec-tasks .qa-agent/current/test-spec-tasks.json \
  --priorities P0,P1,P2 --min-specs-by-priority P0=1,P1=1,P2=1 \
  --output .qa-agent/current/completion-check.json
```

## 纪律

- 不判定质量，只确保**该跑的都跑了且结论可信**
- 产品缺陷与阻塞项单列，不混进通过率
- 失败无法归类时如实上报阻塞，不要强行改测试凑绿
- 交付前核对：产品代码零改动（`codebase_changes` 或 `git status` 里不应出现产品文件）
