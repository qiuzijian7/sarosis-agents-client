# 0003 官方占位表漏登 goal，id/order 真 tie 守卫报不出

**日期**：2026-10-14
**状态**：已修复（补登 + 挪空档 + bump chat-surface 0.2.68）

## 现象
`vssaros-todo` 条目（`conversation.input.dock`）与官方 `goal` 条目 order 同为 10，真实 tie，但守卫全绿。

## 根因
守卫脚本 `check-chat-surface-chunks.mjs` 的 `OFFICIAL_ENTRIES` 是我们手工登记的官方占位表副本，漏登了 `goal`（`dsh-client-ui-goal/lib/client.js:557-561`）。守卫逻辑本身没错，是**输入数据不全**——登记表漏一条 = 给那条留一个静默 tie 的口子。

## 修复
- 补登 `goal`（dock order 10），`vssaros-todo` 挪到空档 order 5
- 确立流程：升级 dsh 后拿权威清单 `CLIENT_SLOT_API`（`dsh-cordis-client-runner/lib/client.js:2363+`）全量复核 OFFICIAL_ENTRIES

## 永久守卫 / 教训
- 守卫继续做**反向突变验证**（故意制造 tie 确认变红）。
- **教训**：静态登记表必然漂移；凡「对照官方清单」类守卫，必须有从权威生成物重新同步的通道，且清单源要注意 `/dsh-runtime/` 在 .gitignore 里、ripgrep 搜不到。
