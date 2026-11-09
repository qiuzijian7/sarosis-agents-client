# 截图分析 UI：四档判据

适用范围：tester 在阶段 3–4 做浏览器验收时判断「界面是否正确」。
前提：dsh 侧已挂载 `@playwright/mcp`（运行时工具名带 `mcp__playwright__` 前缀），
本机 `browser` 单工具也可用 `op: screenshot`。

## 一句话原则

**截图是观察，不是判定。** 只有可机器复核的断言才能作为放行依据；
模型看图只能产生「可疑点」，不能单独宣布「通过」。

## 四档判据（从硬到软，逐级兜底）

| 档 | 手段 | 可判什么 | 工具 | 能否作门禁 |
|---|---|---|---|---|
| ① 几何 / DOM | `browser_evaluate` 读 `getBoundingClientRect`、computedStyle、元素存在/可见/层级、重叠与溢出；`browser_snapshot` 读文本与角色 | 遮挡、零高度、被压成竖排、文字溢出、缺少锚点 | `mcp__playwright__browser_evaluate` / `mcp__playwright__browser_snapshot` | ✅ 主判据 |
| ② 像素基线 | 固定条件下截图与基线逐像素比对（容差 0.5%，WebGL 2%） | 大范围视觉回归 | `mcp__playwright__browser_take_screenshot` + 外部 diff | ✅ 需基线更新流程 |
| ③ 结构化视觉查询 | 把问题压成布尔或 JSON，同一问题问 2–3 次取一致 | ① 判不了的语义正确性 | 视觉模型 + 截图 | ⚠ 只做召回 |
| ④ 自由文本审查 | 「描述布局、指出可疑点」 | 找线索、给人复核 | 视觉模型 + 截图 | ❌ 只出观察 |

### 第 ① 档怎么跑

用 `mcp__playwright__browser_evaluate` 取回当前步骤相关元素的 `rect` / `visible` /
`overflow` / `viewport`（需要互相比较的同级元素打同一个 `group`），存成 `geometry.json`，再跑：

python "<SKILL_DIR>/scripts/visual_check.py" --input geometry.json --case-id CASE-001

脚本判 `ZERO_SIZE` / `NO_AREA` / `TEXT_OVERFLOW` / `OUT_OF_VIEWPORT` / `OVERLAP`，
输出 `verdict` 与 `findings`。`verdict=undetermined`（没数据或元素过多）时
必须写「未取证」，不能当成通过；`verdict=fail` 时把 findings 连同截图一起进缺陷清单。

### 第 ② 档怎么跑

用仓库 `webview/visual/visual.spec.mjs` 的 `comparePng`（或任何等价 diff）产出
`{sizeMismatch, ratio, decodeFailed}`，连同 baseline / actual 的**真实路径**写进
`geometry.json` 的 `pixelDiff` 数组，再跑同一个判定器：

python "<SKILL_DIR>/scripts/visual_check.py" --input geometry.json --case-id CASE-001

默认容差 0.5%（WebGL 场景把 `tolerance` 调到 0.02）。`sizeMismatch` 或超容差判 `fail`；
`decodeFailed`、缺 ratio、证据路径不存在判 `undetermined` —— 写「未取证」，不许当成通过。

仓库里已有的对照实现：

- `dsh-plugins/check-desktop-split-e2e.mjs`：全部断言基于 DOM / 几何 / target 计数，截图只取证。
- `src/vs/sessions/contrib/agentStudio/webview/visual/visual.spec.mjs`：唯一像素基线 diff。

## 截图前的固定条件

视口与 DPR、明暗主题、字体、系统时间、动画开关、登录态、测试数据都要固定；
否则 ② 的 diff 与 ① 的几何量都会被噪声污染。一次一屏，`fullPage` 只在整页布局检查时开。

## 每条证据要记的字段

| 字段 | 说明 |
|---|---|
| `caseId` / `stepId` | 关联到已确认用例与具体步骤 |
| `url` / `title` | 当时的页面 |
| `viewport` / `dpr` / `theme` | 截图条件 |
| `attachment` | 工具结果返回的图片附件引用；无附件服务时写「未取证」 |
| `hash` | 图片字节的 sha256 前 12 位，便于跨轮比对 |
| `assertion` | 证明这一步通过的硬断言（没有就写「待判定」） |

## 判定纪律

1. 每个「通过」结论必须绑定至少一条 ① 或 ② 的断言；只有截图时写「观察到…，未判定」。
2. 模型看图的结论一律标为「观察」，与「机器判定」分栏写进报告。
3. 报告里引用的路径 / 附件必须真实存在，取不到就写「未取证」，不要编造。
4. 失败截图必须在缺陷可见时截，并附「复现步骤 → 期望 → 实际」。
5. 产品缺陷只记录，不修改产品代码。

## 为什么不让视觉模型单独当门禁

公开评测里，WebTestBench 报告当前主流模型在端到端 Web 测试上 F1 均低于 30%；
LogicHunter 的对照实验中被动 LLM judge 精度约 29%，原始失败 oracle 精度约 2.8% 且误报率 100%。
生产里决定这套流程可不可信的是**误报率**：模型适合「找可疑」，放行交给确定性断言。
