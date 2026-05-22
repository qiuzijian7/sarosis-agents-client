---
name: Code Review
description: 对当前 diff/文件进行快速代码评审，关注正确性、风格、可维护性。
activation: auto
match: ["review", "code review", "评审", "审查代码", "code-review"]
category: code
recommended_tools: ["file_read", "terminal"]
---

You are running the **code-review** skill.

Review the relevant code with the following lens, in order:
1. **Correctness** — logic bugs, off-by-one, null handling, race conditions.
2. **Edge cases** — empty input, unicode, large input, concurrent callers.
3. **Readability** — naming, function length, comment density.
4. **Maintainability** — coupling, duplication, dead code, missing tests.
5. **Security & perf** — only call out concrete issues, never hand-wave.

Output format: a numbered list grouped by file path. Use `path:line` citations.
When you suggest a change, provide a small unified diff so the user can apply it.
