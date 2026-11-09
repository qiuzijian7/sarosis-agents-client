---
name: dataset-health-audit
description: 对 CSV/Excel/TSV/JSON 表格数据执行 12 维质量审计（缺失值、重复行、类型一致性、离群值、格式合规、唯一性、常量列、分布偏斜、列名规范、基数异常、跨列一致性），输出 0-100 分项评分、总分等级与修复建议。
whenToUse: 拿到一张表（CSV/Excel/TSV/JSON）要判断能不能直接用，或清洗前先体检一次（缺失、重复、类型混乱、离群、格式不一致）时。
activation: auto
match: ["数据质量", "数据健康度", "缺失值", "重复行", "异常值检测", "数据清洗"]
category: data-science
recommended_tools: ["read", "pwsh"]
license: MIT
tier: core
---

# data-quality-checker

数据质检工具 —— 对表格数据执行 12 个维度的质量检测，输出每项评分（0-100）、总分和具体修复建议。

## 能力概览

| 维度 | 说明 |
|------|------|
| 缺失值检测 | 每列的空值/NaN 数量与比例 |
| 重复行检测 | 完全重复的行数与比例 |
| 数据类型一致性 | 同列中混杂不同类型（如数字列混入文字） |
| 数值范围/异常值 | 基于 IQR 方法检测离群值 |
| 格式合规性 | 日期、邮箱、手机号等字段的格式一致性 |
| 唯一性约束 | ID 类字段是否存在重复 |
| 空白字符串 | 前后空格、空字符串、仅空白字符 |
| 常量列 | 仅含单一值的列（信息量为零） |
| 数据分布偏斜 | 数值列的偏度是否过大 |
| 列名规范性 | 列名是否含空格、特殊字符、大小写不一致 |
| 基数异常 | 唯一值数量异常（过高或过低） |
| 跨列一致性 | 日期先后、数值大小等跨列逻辑校验 |

## Quick Start

```bash
# 基本质检
python "<SKILL_DIR>/scripts/data_quality_checker.py" data.csv

# 保存报告到 JSON
python "<SKILL_DIR>/scripts/data_quality_checker.py" data.csv --output report.json

# 指定 ID 列（用于唯一性检查）
python "<SKILL_DIR>/scripts/data_quality_checker.py" users.csv --id-columns "user_id,email"

# 指定日期列（用于格式检查）
python "<SKILL_DIR>/scripts/data_quality_checker.py" orders.csv --date-columns "created_at,updated_at"
```

## 详细用法

### 基本调用

```bash
python "<SKILL_DIR>/scripts/data_quality_checker.py" <数据文件> [选项]
```

### 参数说明

| 参数 | 缩写 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `input` | — | 是 | — | 输入文件路径（CSV/TSV/Excel/JSON） |
| `--output` | `-o` | 否 | 标准输出 | 输出 JSON 报告路径 |
| `--id-columns` | `-id` | 否 | 自动检测 | 应唯一的列名，逗号分隔 |
| `--date-columns` | `-dc` | 否 | 自动检测 | 日期类型的列名，逗号分隔 |
| `--sample` | `-s` | 否 | 全量 | 采样行数（大文件时使用） |
| `--encoding` | `-e` | 否 | utf-8 | 文件编码 |

## 输出结构（JSON）

```json
{
  "file": "data.csv",
  "rows": 10000,
  "columns": 15,
  "overall_score": 78.5,
  "grade": "B",
  "dimensions": {
    "missing_values": {
      "score": 85.0,
      "issues": [
        {"column": "age", "missing_count": 150, "missing_pct": 1.5, "suggestion": "用中位数或众数填充"}
      ]
    },
    "duplicates": {
      "score": 95.0,
      "issues": [...]
    }
  },
  "top_suggestions": [
    "列 age 有 1.5% 缺失值，建议用中位数填充",
    "发现 200 行完全重复，建议去重"
  ]
}
```

## 评分标准

| 等级 | 分数范围 | 含义 |
|------|----------|------|
| A+ | 95-100 | 数据质量优秀，可直接使用 |
| A | 90-95 | 质量良好，少量小问题 |
| B | 80-90 | 质量中等，建议修复后使用 |
| C | 60-80 | 质量较差，需重点清洗 |
| D | 40-60 | 质量很差，大量问题需修复 |
| F | 0-40 | 数据基本不可用，需重新采集或大规模清洗 |

## 依赖

- Python 3.8+
- pandas
- numpy

```bash
pip install pandas numpy
```
