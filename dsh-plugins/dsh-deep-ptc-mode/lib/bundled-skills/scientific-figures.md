# 科学图表与 Deep PTC 结果卡片

从同一份计算结果生成图、卡片与结论。先记录变量、单位、样本数、缺失值处理和分组方式。每个误差条标清是标准差、标准误还是置信区间；给出区间的计算方法。仅凭几组均值无法反推出样本分布。

| 数据或目的 | 对话卡片 | 导出图 |
| --- | --- | --- |
| 比较少量非负指标 | `bars`，最多 8 项，共用单位；需要分母时加 `rows` 或 `table` | 用点图或柱图，并在有重复样本时展示波动 |
| 等间隔、单序列变化 | `line`，2–48 个有限数值，标签和点一一对应 | 使用实际 x 坐标；不等间隔、断点或多序列用独立图 |
| 两变量关系、误差条、对数轴、热图 | 用 `stats` 或小表给出样本数、关键观测及单位 | 用散点图、误差图或热图，保留坐标、图例、色标和说明 |
| 精确值、负数或缺失 | 用 `table` 写数值或「缺测」 | 按原始数据绘制；缺失值保留间断 |

下面是用于验证卡片格式的**演示数据**，实际任务用真实计算值替换。它是 `ui_card` 的参数对象：

```json
{"action":"show","id":"latency-summary","title":"延迟对比（演示数据）","blocks":[{"type":"bars","title":"中位延迟","unit":"ms","items":[{"label":"版本 A","value":48},{"label":"版本 B","value":36}]},{"type":"rows","items":[{"label":"每组样本","value":"20 次"},{"label":"测量条件","value":"相同输入，预热后计时"}]}]}
```

用显示卡汇报即可继续工作。卡片关闭时以文字或表格给出同一组结果。要求论文、报告或可复用图时输出独立 SVG、PDF 或足够分辨率的 PNG，以及绘图代码或对应数据；在卡片附近给出成品路径。导出后打开图，检查中文字体、负号、轴标签、误差与图例，并抽查卡片数值和成品是否一致。卡片排版细节按需加载 `deep-ptc-cards`。

### 实际生成图、表与卡片

附带的 [绘图与卡片生成器](examples/figure_from_csv.py) 使用 Python 与 Matplotlib。DSH 自带的 Python 不含 Matplotlib（已有 numpy、pandas、openpyxl、XlsxWriter、python-docx/pptx、Pillow）：先用 `python -c "import matplotlib"` 检查，缺少时征得用户同意再安装，或改用已有的环境。输入 UTF-8 CSV，列为 `group,value`。运行 `python figure_from_csv.py measurements.csv out "Latency (ms)"`，输出目录应是新路径。为中文组名选择含相应字形的 Matplotlib 字体并检查导出图。

它写出完整 summary.csv、显示每个观测值及「均值 ± 样本标准差」的 figure.svg，以及可直接作为 ui_card 参数的 card.json。空值不计入 n；n=1 时不绘误差条，结果表和卡片均保留缺测标记；超过八组时卡片明确标出展示比例，完整文件保留全部组。用自己的读取工具解析 card.json，卡片启用时调用 ui_card；把 SVG 和 CSV 路径一并交给用户。

自校验例：A 组输入 48、52，B 组输入 36 与一条空值。A 的均值应为 50、样本标准差约 2.8284；B 的 n 应为 1，标准差应为空。在独立图与卡片中检查同一组的标签、单位和均值。

绘图接口参考 [Matplotlib 误差图文档](https://matplotlib.org/stable/api/_as_gen/matplotlib.pyplot.errorbar.html)。
