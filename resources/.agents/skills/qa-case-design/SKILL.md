---
name: qa-case-design
description: QA 阶段 2——把风险分析转成中文业务用例，并等待用户确认。这是整个 QA 流水线唯一的强制人工门禁。当需要设计验收用例、写测试用例、确认用例范围时触发。
activation: auto
match: ["测试用例", "用例设计", "验收用例", "写用例", "case design"]
category: development
recommended_tools: ["file_read", "file_write", "terminal"]
---

# QA Case Design — 用例设计（⏸ 人工门禁）

输入：`risk-analysis.json`。输出：`test-cases.json`。

**这是整条流水线唯一必须停下来等用户确认的环节。** 其余阶段自动衔接。

## 用例格式

```json
{
  "id": "CASE-001",
  "title": "中文业务描述，不是技术术语",
  "priority": "P0|P1|P2",
  "precondition": "前置条件",
  "steps": ["步骤 1", "步骤 2"],
  "expected": "可观测的业务事实（oracle）",
  "riskRef": "关联的 risk id"
}
```

## 纪律

### 1. 用例是业务语言，不是技术语言

- ✅ 「下单后库存扣减 1，订单状态变为待发货」
- ❌ 「调用 POST /order 断言 200」

### 2. 每条高风险必须有对应用例

`risk-analysis.json` 中每条「高」风险至少映射一条 P0 用例。
映射不上说明用例设计有漏，回头补。

### 3. 复用已有用例

先读 `.qa-agent/cases/`。已有用例覆盖的场景**直接复用，不重复生成**。
只在新增场景下追加——增量验收时只让用户确认新增的那几条。

### 4. 强制确认（<HARD-GATE>）

用例写完后**必须停下**，用表格展示给用户，等明确确认：

```
| ID | 优先级 | 用例标题 | 来源风险 |
```

**在用户确认前，禁止进入阶段 3（脚本生成）**，禁止写任何测试代码。
用户可能删减、修改、补充——以确认后的版本为准。

### 5. 确认后落盘

```bash
export PYTHONIOENCODING=utf-8
python "<qa-core>/scripts/qa_agent.py" validate-cases --cases .qa-agent/current/test-cases.json
```

校验通过后写入 `.qa-agent/cases/`（长期资产，入库）。
