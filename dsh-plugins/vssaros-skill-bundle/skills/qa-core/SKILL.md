---
name: qa-core
description: QA 引擎层——提供 qa_agent.py CLI 与门禁判定能力。当其他 qa-* skill 需要初始化项目布局、生成 spec-task 蓝图、执行门禁校验（completion / code-review / readiness）、渲染 HTML 报告时加载。它不直接面向用户，是阶段 skill 的共享底座。
activation: manual
match: ["qa-core", "qa agent cli", "门禁校验", "render-report"]
category: development
recommended_tools: ["pwsh", "read", "write"]
tier: extended
---

# QA Core — 引擎与门禁底座

本 skill 是 QA 流水线的**能力层**，被 `qa-context-profiling` / `qa-script-generation` /
`qa-execution-repair` / `qa-quality-review` / `qa-acceptance-report` 共同依赖。
它自己不编排流程——编排者是 `tester` agent（用 `read_skill` 逐阶段加载）。

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
| `init-project --repo .` | 建 `.qa-agent/` 布局并落盘回归资产 |
| `generate-spec-tasks --cases … --output …` | 用例 → spec-task 蓝图 |
| `run-e2e --repo . --spec …` | 跑 Playwright 回归（`npx playwright test`） |
| `run-with-env --repo . --script …` | 带分层 env 跑单文件脚本 |
| `aggregate-runs --output …` | 汇总 sidecar 证据 |
| `assert-completion --cases … --spec-tasks … --output …` | completion 门禁 |
| `assert-code-review --code-review … --output …` | review 门禁 |
| `assert-readiness --completion-check … --code-review … --output …` | 最终就绪判定 |
| `render-report --cases … --run … --output …` | 渲染 HTML 报告（可 `--embed-screenshots`） |

完整语法以 CLI 自身为准，不要依赖未随包的外部文档：

python "<SKILL_DIR>/scripts/qa_agent.py" <command> --help

`<SKILL_DIR>` 用 `read_skill` 返回的技能目录绝对路径替换。

## spec-task.command 契约

`generate-spec-tasks` 产出的 `test-spec-tasks.json` 里，每条 task 的 `command` 字段是
**元数据，不是可直接执行的 shell 命令**：引擎从不执行它，只在 `render-report` 里用它
提取 e2e spec 路径做展示；门禁按 `executionStatus` / `evidence` / `targetFile` 判定。
字段里的 `qa_agent.py` 是简写，真正执行要换成绝对路径并按上面的命令索引调用：

python "<SKILL_DIR>/scripts/qa_agent.py" run-e2e --repo . --spec "tests/e2e/<模块>/<用例>.spec.ts"

不要把 `command` 原样复制进终端，也不要写进 `qa-agent.config.yaml` 的 `commands.<gate>`
—— 只有后者才会被 `run-commands` 交给 shell 执行。

## 门禁语义

- **completion-check**：P0/P1/P2 各优先级的 spec 是否都已执行且通过
- **code-review-check**：`code-review.json` 中是否存在 P0/P1 blocking 项
- **readiness-check**：取前两者交集，四档判定
  1. 就绪 — 两者全通过
  2. 有条件就绪 — P0 通过，P2 有遗留
  3. 未就绪 — 存在 P0/P1 未通过
  4. 未完成 — 门禁未跑完

## 资产状态：Playwright MCP 已挂载

dsh 侧由 `vssaros-mcp/cordis.patch.yml` 声明式挂载 `@playwright/mcp`
（serverName `playwright`）。运行时工具名带命名空间前缀 `mcp__playwright__<tool>`，
技能与提示词用 `mcp__playwright__*` 指代这一组；裸的 `browser_*` 名字在 dsh 会话里不存在。

`assets/playwright/` 下三份 toml 是 Playwright 官方 Test Agents（planner / generator /
healer）的**外部 agent 定义格式**，dsh 不直接消费；其中 `generator_*` / `planner_*` /
`test_*` 属于 `playwright run-test-mcp-server`，本轮未挂载，不要按这些名字发起调用。
可用的只有 `@playwright/mcp` 的 `browser_*` 工具（带上述前缀）。

## 回归链与视觉检查

- `references/e2e-regression.md` — seed / specs / tests / replay 缓存的契约
- `references/visual-check.md` — 截图分析 UI 的四档判据与证据规范
- `assets/playwright/seed.spec.ts` — 登录态 seed 模板
- `assets/playwright/replay-cache.example.json` — 动作缓存格式

两个可执行判定器（Python 3.9+，仅标准库，各自带 `--self-test`）：

python "<SKILL_DIR>/scripts/visual_check.py" --input geometry.json --case-id CASE-001
python "<SKILL_DIR>/scripts/replay_check.py" --cache replay-cache.json --repo .
python "<SKILL_DIR>/scripts/replay_check.py" --cache replay-cache.json --repo . --record --step 1 --tool <工具名> --args '{}' --assertion "<断言>"

`visual_check.py` 接 `elements`（几何 / DOM）与 `pixelDiff`（外部 PNG diff 的 ratio、
容差与证据路径），判成 `pass` / `fail` / `undetermined`；只有 `pass` 能作放行依据，
`undetermined` 必须写「未取证」。证据路径会真检查存在性，编造路径会被判出来。
`replay_check.py` 用 `--record` 录制探索动作（同 step 幂等、每个动作必须有断言、
自动写回 `appFingerprint` 与 `specHash`），复用前校验四类失效条件；
`reusable=false` 就必须重新规划并重过人工门禁。两者都不连浏览器、不调模型。

`init-project` 会把 `assets/` 下的模板随 `.qa-agent/` 布局一起落盘；
`scripts/` 直接在技能目录内，用 `<SKILL_DIR>` 绝对路径调用。

## 安全边界

CLI **只读产品代码，不改产品代码**；它会执行测试、写 `.qa-agent/` 下的产物、连接被测服务。
仅在用户明确要求验收/回归时使用，且必须先在非生产仓库试跑。
