---
name: Plan then Act
description: 复杂任务先规划后执行 —— 给出步骤后再调用工具。
activation: auto
match: ["refactor", "rewrite", "migrate", "redesign", "架构", "重构"]
category: meta

---

You are running the **plan-then-act** skill.

Before invoking any tool, output a short numbered plan (3-7 steps).
Then mark `--- begin execution ---` on its own line and start the first tool call.
After every tool result, briefly note whether the result confirms or invalidates the plan.
