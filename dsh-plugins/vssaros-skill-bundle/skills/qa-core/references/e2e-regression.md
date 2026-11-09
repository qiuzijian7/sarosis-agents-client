# E2E 回归链契约（seed / specs / tests / replay）

## 目录布局

```
.qa-agent/
├── cases/              已确认用例（入库，唯一 oracle 真源）
├── specs/<scope>/      规划产出的人可读测试计划（入库）
├── fixtures/           seed.spec.ts / replay-cache.example.json / env.shared
├── local/              storageState.json 等运行时数据（不入库）
├── runs/               run-*.log + .meta.json（执行证据）
└── reports/            latest-report.html
tests/web/<scope>/      生成阶段产出的 *.spec.ts（入库）
```

`scope` 是单一业务流（如 `checkout/guest`），不要一个 scope 塞多条主路径。

## 三个阶段

| 阶段 | 输入 | 产出 | 谁来做 |
|---|---|---|---|
| 规划 | 已确认用例 + 风险清单 | `specs/<scope>/plan.md`（步骤 + 期望 + 数据） | 模型（一次性） |
| 生成 | plan.md | `tests/web/<scope>/*.spec.ts` + seed 引用 | 模型，边在真页面验证定位器边写 |
| 回归 | spec.ts + storageState | 退出码 / trace / 截图 / 报告 | **确定性 runner，零模型调用** |

关键设计：**生成即录制**。生成阶段已经把探索出的步骤固化成 Playwright 代码，
回归阶段直接 `run-e2e` 重放这份代码就等价于「免模型重放」，不需要额外的动作缓存层。
`replay-cache.example.json` 只服务于探索阶段的重复利用，不是回归必需。

## seed：登录态与环境

- `seed.spec.ts` 只跑一次登录，用 `context.storageState()` 写 `.qa-agent/local/storageState.json`。
- 后续 spec 在 `playwright.config` 里用 `use.storageState` 引用它；凭据走
  `.qa-agent/config/env.shared` / `.qa-agent/local/.env`，不写进用例或提示词。
- `webServer` 负责起被测服务；用就绪探针，不要 `sleep`。

## 执行与证据

```bash
export PYTHONIOENCODING=utf-8
python "<SKILL_DIR>/scripts/qa_agent.py" run-e2e --repo . --spec "tests/web/<scope>/xxx.spec.ts"
python "<SKILL_DIR>/scripts/qa_agent.py" aggregate-runs --output .qa-agent/current/latest-run.json
python "<SKILL_DIR>/scripts/qa_agent.py" render-report --embed-screenshots ...
```

配置沿用仓库 `playwright.web.config.ts` 的 `trace: retain-on-failure` /
`screenshot: only-on-failure` / `video: on` / `reporter: [list, html, json]`。
截图判据见 `references/visual-check.md`。

## 缓存失效条件（命中即重新规划，不得静默复用）

1. `appFingerprint`（git HEAD 或被测构建 hash）变化；
2. spec 内容或用例 `expected` 变化；
3. seed / storageState / baseURL 变化；
4. 任一断言失败 —— 失败必须回到「失败分类」，不能靠重放掩盖。

命中缓存时 `modelCalls = 0`；失效时必须重新走规划 → 生成，
且**重新过阶段 2 的人工门禁**（用例或期望变了就必须让人再确认一次）。

### 探索阶段录制

每个探索动作连同断言写进缓存（同一 step 覆盖，重跑不产生重复）：

python "<SKILL_DIR>/scripts/replay_check.py" --cache ".qa-agent/cache/<scope>/actions.json" --repo . --record --step 1 --tool mcp__playwright__browser_click --args '{"element":"加入购物车"}' --assertion "toContainText('1')"

没有断言的动作不允许进缓存 —— 无法证明目标达成的步骤不能被复用。
录制时自动写回 `appFingerprint`（当前 HEAD）与 `specHash`。

### 复用前的机器校验

python "<SKILL_DIR>/scripts/replay_check.py" --cache ".qa-agent/cache/<scope>/actions.json" --repo .

校验 `appFingerprint` 是否等于当前 HEAD、`specHash` 是否匹配、`storageState` 是否存在、
以及 `replay.modelCalls` 是否为 0。任一不满足即输出 `reusable=false` 与原因，
禁止直接复用缓存。判定器只做校验，不执行测试、不调模型。

## 缺陷处置

产品缺陷记入清单（复现步骤 → 期望 → 实际 + 证据路径）并交给开发；
tester 只修定位器与等待，不改产品代码，也不改断言。
