# Playwright Test Agent Templates

这组文件是仓库模板里可直接复用的 Playwright Test Agent 配置。

## 角色

- `playwright_test_planner.toml`：先探索、先出计划。
- `playwright_test_generator.toml`：把确认后的 plan / case 生成单条可执行 spec。
- `playwright_test_healer.toml`：测试失败后负责定位、修复、复跑。

## 使用顺序

1. 新 E2E 场景先用 planner。
2. 用户确认后用 generator。
3. 失败时用 healer。
4. 已稳定的 suite 直接复跑，不必强制三件套。

## 产物约定

- 项目侧 HTML 报告：`playwright-report/<scope>/index.html`
- 项目侧原始产物：`test-results/<scope>/`
- QA 侧运行证据：`.qa-agent/runs/<run-id>/playwright/<scope>/`
- QA 侧 scoped 报告：`.qa-agent/reports/<scope>/<run-id>/`
- QA 侧最新报告：`.qa-agent/reports/<scope>/latest-report.html`
