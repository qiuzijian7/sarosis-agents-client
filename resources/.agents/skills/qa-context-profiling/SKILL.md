---
name: qa-context-profiling
description: QA 阶段 0——为仓库收集事实画像与环境证据。当需要收集模块代码上下文、索引已有用例与测试、检查服务可达性、准备环境快照时触发。只收集事实，不做风险分析、不写用例、不判断质量。
activation: auto
match: ["qa-context", "收集上下文", "环境快照", "验收准备", "上下文收集"]
category: development
recommended_tools: ["search_graph", "trace_path", "detect_changes", "get_architecture", "terminal", "file_read"]
---

# QA Context Profiling — 上下文收集

你是 QA 流水线的第一阶段。任务很窄：**收集事实，不做判断**。
不分析风险、不设计用例、不写测试代码、不判断质量、不给就绪结论。

## 工作流

### 1. 锁定 scope

从对话提取边界：需求文档、模块名、diff 范围、branch、commit、业务流程。
**scope 不明确就先问清楚**——不能靠猜决定收集哪些文件。

### 2. 初始化项目布局

`.qa-agent/config`、`cases`、`local`、`current` 任一缺失时：

```bash
export PYTHONIOENCODING=utf-8
python "<qa-core>/scripts/qa_agent.py" init-project --repo .
```

### 3. 收集代码事实（用 Saros 原生工具，不用 grep）

| 目标 | 工具 |
|---|---|
| 模块结构与依赖 | `get_architecture` |
| 关键函数定义与调用链 | `search_graph` → `trace_path` |
| 本次改动范围 | `detect_changes` |
| 已有测试索引 | `search_graph` + `label` 过滤 |

优先 `search_graph` 而非文本搜索——它理解调用关系，不会漏掉重命名/间接引用。

### 4. 环境证据

- 服务可达性：检查前后端是否已启动
- 配置与账号：读取 `.qa-agent/local/`（脱敏，禁止回显密钥）
- 记录环境快照到 `.qa-agent/current/context.json`

### 5. 输出

产出 `.qa-agent/current/` 下：
- `context.json` — 仓库事实画像
- `existing-index.json` — 已有用例/spec/测试文件索引

## 纪律

- 遇到缺失就**如实记录缺失**，不要编造、不要用通用描述填充
- 不调用任何 LLM 网关（未配置时相关步骤直接跳过）
- 播报用陈述句：`▶ 上下文收集完成 — 12 个相关模块`，说完立刻继续，不要停下等回复
