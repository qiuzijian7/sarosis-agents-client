---
name: Ponytail Debt
description: >
  收集代码库中所有 ponytail: 注释到技术债务台账，让 ponytail 留下的有意简化
  和延后处理得到跟踪，而不是腐烂成"以后就是永不"。当用户说"ponytail debt"、
  "/ponytail-debt"、"what did ponytail defer"、"list the shortcuts"、
  "ponytail ledger" 时激活。一次性报告，不修改任何内容。
activation: manual
match: ["ponytail-debt", "ponytail debt", "what did ponytail defer", "list the shortcuts", "ponytail ledger", "技术债务", "ponytail债务", "延迟处理"]
category: code
recommended_tools: ["file_read", "terminal"]
---

Every deliberate ponytail shortcut is marked with a `ponytail:` comment naming
its ceiling and upgrade path. This collects them into one ledger so a deferral
can't quietly become permanent.

## Scan

Grep the repo for comment markers, skipping `node_modules`, `.git`, and build
output:

`grep -rnE '(#|//) ?ponytail:' .`  (add other comment prefixes if your stack uses them)

Each hit is one ledger row. The comment prefix keeps prose that merely mentions
the convention out of the ledger.

## Output

One row per marker, grouped by file:

`<file>:<line>, <what was simplified>. ceiling: <the limit named>. upgrade: <the trigger to revisit>.`

The convention is `ponytail: <ceiling>, <upgrade path>`, so pull the ceiling
and the trigger straight from the comment. Want an owner per row too? add
`git blame -L<line>,<line>`.

Flag the rot risk: any `ponytail:` comment that names no upgrade path or
trigger gets a `no-trigger` tag, those are the ones that silently rot.

End with `<N> markers, <M> with no trigger.` Nothing found: `No ponytail: debt. Clean ledger.`

## Boundaries

Reads and reports only, changes nothing. To persist it, ask and it writes the
ledger to a file (e.g. `PONYTAIL-DEBT.md`). One-shot. "stop ponytail-debt" or
"normal mode" to revert.
