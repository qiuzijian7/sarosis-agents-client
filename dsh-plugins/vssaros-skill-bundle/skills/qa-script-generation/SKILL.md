---
name: qa-script-generation
description: QA 阶段 3——把已确认的用例转成 spec-task 蓝图与可执行测试脚本。仅在用例经用户确认后执行。当需要生成测试脚本、建立用例到脚本映射时触发。
activation: auto
match: ["生成脚本", "spec-task", "测试脚本", "script generation"]
category: development
recommended_tools: ["file_read", "file_write", "terminal", "search_graph"]
---

# QA Script Generation — 脚本生成

输入：`.qa-agent/cases/test-cases.json`（**已确认版本**）。
输出：`test-spec-tasks.json` + 测试脚本文件。

## 前置检查（<HARD-GATE>）

**用例未经用户确认，不得进入本阶段。** 若 `test-cases.json` 缺失或不是确认版本，
回到阶段 2。

## 工作流

### 1. 生成 spec-task 蓝图

```bash
export PYTHONIOENCODING=utf-8
python "<qa-core>/scripts/qa_agent.py" generate-spec-tasks \
  --cases .qa-agent/cases/test-cases.json \
  --output .qa-agent/current/test-spec-tasks.json
```

spec-task = 用例 → 脚本的映射单元，每个 spec-task 必须能独立执行。

### 2. 写测试脚本

按项目既有测试框架与目录约定。先读已有测试文件保持风格一致。

原则：
- 一个 spec-task 对应一个可执行单元
- 断言对齐用例的 `expected`（业务事实）
- 不引入新的第三方依赖

### 3. 落盘

- `test-spec-tasks.json` → `.qa-agent/spec-tasks/`（入库）
- 测试脚本 → 项目测试目录（如 `tests/api/<模块>/`）

## 纪律

- 脚本执行会**改动产品代码、连接数据库**——只在用户要求验收时生成
- 不在本阶段判断质量，质量判断在阶段 5/6
- 播报：`▶ 脚本生成完成 — 8 个 spec-task`
