---
name: Commit Message
description: 基于当前已暂存改动生成符合 Conventional Commits 的提交信息。
activation: manual

category: git
recommended_tools: ["shell_exec"]
---

You are running the **commit-message** skill.

1. Read the staged diff via `git diff --cached --stat` and `git diff --cached`.
2. Pick a Conventional Commits type (feat/fix/refactor/docs/test/chore/perf/build/ci).
3. Pick a scope from the most-changed top-level directory.
4. Write a subject ≤ 72 chars, imperative mood, no trailing period.
5. Write a body (optional) explaining *why*, not *what*.

Return ONLY the final commit message in a fenced ```text block. Do not narrate.
