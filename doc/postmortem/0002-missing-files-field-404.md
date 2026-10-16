# 0002 package.json 漏 files 导致插件装上即加载失败、整站 404

**日期**：2026-10（真实事故，见记忆 feedback_dsh_plugin_bump_version）
**状态**：已修复 + 已加守卫

## 现象
插件 `dsh plugin add` 显示成功，但页面整站 404 / 加载即失败。

## 根因
`package.json` 的 `files` 字段未覆盖运行时文件（新增 chunk / lib 文件后忘补），发布视图缺文件。npm 打包只带 `files` 命中的内容，安装"成功"但产物残缺。官方同样有此纪律：`packages/client/AGENTS.md` L67「Keep the published payload closed」。

## 修复
补齐 `files`（含 `lib/client.*.js` 通配）+ bump 版本重装。

## 永久守卫 / 教训
- `check-chat-surface-chunks.mjs:299-304` 断言 `files` 含 `lib/client.*.js` 通配，缺 version bump 也报。
- **同版本改内容必须 bump 版本**：`plugin add` 同版本是 no-op（"Already up to date"），守卫逐字节比对装机文件。
- **教训**：安装成功 ≠ 载荷完整；「装上但坏了」优先查 files 与版本。
