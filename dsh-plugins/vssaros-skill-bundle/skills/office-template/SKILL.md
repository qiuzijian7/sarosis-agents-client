---
name: office-template
description: 用**用户自己的** Word 文件当模板出稿：office_template 读出段落 / run 级 ID，office_template_write 按 ID 替换正文、克隆新增、删除多余段，并保留页面、样式、嵌入字体、表格与页眉页脚。不预置任何案例模板。
whenToUse: 用户给来一份 .docx 说"按这个格式/红头文件/周报模板再出一份"，或要求"套模板""同款文档"时。
activation: auto
match: ["Word 模板", "docx 模板", "套模板", "按这个格式", "红头文件", "同款文档", "office_template"]
category: productivity
recommended_tools: ["read", "write"]
tier: core
---

# 按用户模板出稿（Word）

用户在 `path` 给一份 `.docx` 当模板时走这条路。版式（页面几何、样式定义、嵌入字体、表格、
页眉页脚、红线/边框）**由 worker 保留并在写盘前校验**；你只负责把内容换成当前任务的真实事实。

## 工作流

1. `office_template({ path })` —— 只读，不改文件。返回：
   - `paragraphs[]`：`id`（如 `p7`）、`text`、`can_remove`、`runs[]`（每段内 run 的 `id` / 字体 / 字号 / 是否粗体）
   - `sha256`：模板指纹（同一模板要重跑时先确认没变）
2. 读清单，规划三件事：
   - `replacements`：要改的段落（每个 `id` 一次，`text` 是**整段新文本**，不是差异）
   - `additions`：要新增的段落（`after` 插在哪段之后、`source` 用哪段的样式克隆）
   - `removals`：要删的段落（**只允许 `can_remove=true`**）
3. `office_template_write({ path, output_path, replacements, additions?, removals? })` —— 输出**新**文件，
   worker 会做 6 项版式校验（嵌入字体 / 样式与主题 / 页面几何 / 边框与图形框 / 字体分配 / 段落与 run 属性）。
4. 把 `output_path` 的绝对路径给用户（工作区内的文件由界面展示）。**不要**覆盖用户原来的模板文件。

## 纪律（每条都对应一次真实的失败）

- **整段替换，不要拼片段**：`text` 必须是该段落的完整文本。只想改一句话也给整段——
  worker 会清掉原 run 再按第一个 run 的格式重建。
- **混合字体/局部加粗**才用 `runs`：`[{source: 'p3:r0', text: '…'}, {source: 'p3:r2', text: '…'}]`，
  `source` 必须是清单里出现过的 run ID，且各片段拼接**恰好等于** `text`。
- **表格内段落 `can_remove=false`**：可以替换文字，不能删（删了表格结构就变了，校验会失败）。
  同理含图片、段落边框（红线）、分节属性的段落只能改文字。
- **新增段落靠克隆**：`source` 选一个正文段落（不要选标题、不要选含图片的），新段落就会沿用它的
  字体与间距；想加几个就重复几条 `additions`，`after` 可以都指向同一段（顺序按数组顺序）。
- **删段落要克制**：`removals` 只用于"模板里比这次内容多出来的正文段"。删完记得确认没有留下
  语义断裂（例如"二、"下面空了）。
- **校验失败按原因改，不要绕过**：报 `Preserve the template embedded fonts…` 说明你动了不该动的部件
  （通常是想换字体或改样式定义）；报 `Use the template paragraph styles…` 说明新文本落到了没有
  对应样式的段落——用 `additions` 从正文段落克隆，或改写已有段落。
- **事实来自用户材料**：数字、人名、单位、文号、日期一律不许编；缺的写「待确认」并在交付时说明。

## 做不到的事（如实说，别硬做）

- 不提供"预置模板库"（本仓没有案例资产）：要模板就请用户给文件。
- 不做页眉页脚的**内容**编辑（worker 保留它们原样）；真需要改页眉页脚，走 `office-docx` 的
  Python 流程，并告知用户版式校验覆盖不到那部分。
- 不做 PDF 导出与逐页视觉检查：需要时用 `office-export-pdf` / `office-render`（依赖随包的
  LibreOffice Kit，缺件时这两个技能会明说本部署不支持）。
