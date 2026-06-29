---
name: Ponytail Gain
description: >
  显示 ponytail 的实测收益看板：更少代码、更低成本、更快速度，来自基准测试中位数。
  一次性展示，不是持久模式，也不是单个仓库的数字。当用户说"ponytail gain"、
  "what does ponytail save"、"show ponytail impact"、"ponytail scoreboard" 时激活。
activation: manual
match: ["ponytail-gain", "ponytail gain", "what does ponytail save", "show ponytail impact", "ponytail scoreboard", "ponytail收益", "ponytail效果"]
category: meta
recommended_tools: []
---

# Ponytail Gain

Display this scoreboard when invoked. One-shot: do NOT change mode, write flag
files, or persist anything.

The figures are the published benchmark medians (5 everyday tasks: email
validator, debounce, CSV sum, countdown timer, rate limiter; three models:
Haiku, Sonnet, Opus). They are measured, not computed from the current repo.
Source: `benchmarks/` and the README.

## Scoreboard

Render plain ASCII bars. The bar length shows the measured range; the label
carries the exact figure:

```
  ponytail gain                     benchmark median · 5 tasks · 3 models

  Lines of code   no-skill  ████████████████████  100%
                  ponytail  ██▌·················    6–20%   ▼ 80–94%
  Cost            no-skill  ████████████████████  100%
                  ponytail  █████▌··············   23–53%  ▼ 47–77%
  Speed           ponytail  ▸ 3–6× faster

  This repo:  /ponytail-debt  (shortcuts you deferred)
              /ponytail-audit (what's still cuttable)
```

## Honesty boundary

These are benchmark medians, not this repo. NEVER print a per-repo savings
number ("you saved X lines/tokens here"): the unbuilt version was never
written, so there is no real baseline to subtract from in a live repo. The
only real per-repo figures come from `/ponytail-debt` (a counted ledger), and
this card points there instead of inventing one.

## Boundaries

One-shot display. Edits nothing, changes no mode.
"stop ponytail" or "normal mode": revert.
