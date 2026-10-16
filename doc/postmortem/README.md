# Postmortem 归档

编号归档 dsh / VsSaros 集成中的真实事故（仿官方 `docs/postmortem/0001-…` 机制）。
每条格式：**现象 → 根因 → 修复 → 永久守卫**。新事故追加新编号，不改旧条目。

| # | 标题 | 守卫 |
|---|---|---|
| [0001](0001-webserver-missing-all-pending.md) | webServer 缺失导致全部模块插件永久 pending | poc 探针 + bundles 真源校验 |
| [0002](0002-missing-files-field-404.md) | package.json 漏 `files` 导致插件装上即加载失败、整站 404 | check-chat-surface-chunks.mjs files 断言 |
| [0003](0003-official-slot-table-missed-goal.md) | 官方占位表漏登 `goal`，id/order 真 tie 守卫报不出 | OFFICIAL_ENTRIES 补登 + 升级后全量复核流程 |
| [0004](0004-patch-override-silently-ignored.md) | patch 覆写行寻址不存在的 id 静默忽略 | 覆写行必须配目标行存在守卫 |
| [0005](0005-orphan-chrome-false-regression.md) | 孤儿 headless Chrome 造成 E2E「假回归」 | finally 必须 taskkill /T；先查进程再怀疑代码 |
