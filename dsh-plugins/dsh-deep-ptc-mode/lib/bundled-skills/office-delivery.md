# 办公交付与跨文件核对

先确定读者要拿成品做什么。需要筛选、更新和重算时用工作簿；需要审批或保留论证时用文档；需要现场讲解决策时用演示。修改现有材料时沿用模板、术语和用户指定的编辑范围。

在当前 Skill 目录里查 `office`。宿主提供时按任务加载 `office-docx`、`office-xlsx` 或 `office-pptx`；重算、渲染和导出分别查 `office-recalculate`、`office-render`、`office-export-pdf`。以返回的依赖路径为准。缺少 provider 时使用当前环境已具备的格式库，并说明实际能验证的环节。

以「把销售表整理成月报」为例：
- 核对期间、货币、含税口径、退款与去重规则。保留原始数据，对汇总值建立独立对账，例如分类合计应等于总计。
- 工作簿把输入、计算和读者视图区分开，用公式链接可变数字。修改已有文件时保留无关工作表、公式和格式。重算后检查代表性单元格、总额和公式错误。
- 文档或幻灯片从同一份已核对的汇总读取数字。每张关键表或图标明单位与期间，说明异常来自哪些记录。渲染交付版本，查看换页、裁切、字体、表格和图例。
- 交付可编辑文件；用户要求分享版时同时导出 PDF，并核对页数和关键数字。说明用的输入版本、对账结果和仍待确认的口径。

### 从交易行生成可编辑的两件成品

附带的 [月报生成器](examples/office_report.py) 使用 Python、xlsxwriter、python-docx。输入 UTF-8 CSV，列为 `id,team,amount`，金额限同币种、两位小数，退款记负数。运行 `python office_report.py sales.csv out`，输出目录应是新路径。示例用十进制数汇总，重复交易 ID 直接报出行号；团队名称中的通配符按普通字符对待。

输出 report.xlsx 有原始表、冻结表头、筛选、按团队引用原始行的公式及初始计算值；report.docx 有同口径的总额和团队表。重新读取两份文件，比较团队、行数与总额。修改已有金额可在 Excel 里直接重算；新增交易或团队时重新运行生成器。需要 PPT 时直接以这份已对账的数据为图表输入，再走 office-pptx 与渲染流程。

复用 DSH Office provider 的现有操作 Skill；工作簿交付另参考 [Anthropic 官方 xlsx Skill](https://github.com/anthropics/skills/tree/main/skills/xlsx)。
