# 第三方代码与素材（THIRD_PARTY）

本插件（`@vssaros/dsh-dashboard`）在下列位置使用了第三方代码/素材。

## `vendor/dsw-theme/` —— dsh 官方主题样式（vendor 副本）

| 项 | 说明 |
| --- | --- |
| 上游 | DeepSeek Harness（dsh），`packages/client/ui-theme/src/styles/` |
| 许可 | MIT，Copyright (c) 2026 DeepSeek（见上游仓库 LICENSE） |
| 收录文件 | `base.css` / `design-platform.css` / `gradient-shadow-text.css` / `scrollbar.css` |
| 收录理由 | 主页是**独立文档**（IDE 编辑区的 WebContentsView / dsh 窗口的 iframe），dsh 客户端壳里的 `--dsw-alias-*`、`--dsw-shadow-*` 变量**不在这个文档的作用域里** ⇒ 不自带一份就没有官方视觉（按钮胶囊、Pill、Modal 遮罩、阴影全靠它）。 |
| 覆盖顺序 | 官方默认（`body` = 亮色，`body[data-ds-dark-theme]` = 暗色）→ 再由 preload 推来的 VsSaros 主题 token（`dataset.vssarosTheme`，`{light,dark}` 双形态）覆盖其中 13 个 alias 变量 ⇒ 最终跟 IDE 主题一致。 |
| 同步方式 | 上游原件在本地检出 `G:\CustomWorkspaces\AIProjects\deepseek-harness`；改前先看上游是否变了（vendor 脚本按上游覆盖写回）。 |

⚠ vendor 副本**只做搬运，不改内容**；任何本地修改都要在上游同步，否则下次覆盖写回会丢。

## 参考实现（未直接搬代码）

- `dsh-plugins/vssaros-workbenches/lib/state.js`、`vssaros-workbenches/lib/client.js` 采用了「照搬官方 + 只做适配」的写法与 MIT 归属声明方式（见该包的 `THIRD_PARTY.md`）。
