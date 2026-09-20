# Playwright E2E 布局示例

这份示例说明仓库模板中 Playwright E2E 的固定落位方式，适合新项目直接复制。

## 角色分工

- `planner`：新 E2E 场景、跨端链路、未建模用户旅程。
- `generator`：确认后的场景转单条 spec。
- `healer`：失败后的 selector / timing / data / environment 修复。

## 目录约定

- 项目侧 HTML 报告：`playwright-report/<scope>/index.html`
- 项目侧原始产物：`test-results/<scope>/`
- QA 运行证据：`.qa-agent/runs/<run-id>/playwright/<scope>/`
- QA scoped 报告：`.qa-agent/reports/<scope>/<run-id>/`
- QA 最新报告：`.qa-agent/reports/<scope>/latest-report.html`

## scope 命名

- 推荐：`admin-acceptance`
- 推荐：`cross-system`
- 推荐：`creator-withdrawal-handoff`
- 要求：同一个 scope 不能混入多个业务流。

## 执行顺序

1. 先 planner 形成 markdown 计划。
2. 确认后 generator 生成 spec。
3. 失败后 healer 修复并复跑。
4. 稳定套件可直接复跑，不必重复规划。

## 证据三件套

- 文件：spec / helper / config / README 路径
- 命令：真实可复制的运行命令
- 结果：`passed` / `failed` / HTML 报告 / trace / screenshot / video
