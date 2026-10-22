# VENDOR — 这个包里哪些是别人的、哪些是我们的

## 上游

| 项 | 值 |
| --- | --- |
| 仓库 | `citrolabs/ego-lite`（本地检出：`G:\CustomWorkspaces\AIProjects\ego-lite`） |
| 许可 | MIT（`LICENSE` 为上游原文，逐字未改） |
| vendored 目录 | `skills/ego-browser/`（含 `LICENSE` 副本） |
| 复制口径 | **整目录逐字复制**，不改一个字（`SKILL.md` + `agents/` + `assets/` + `learnings/` + `references/` + `scripts/`） |
| 上游版本标记 | `SKILL.md` 的 frontmatter：`metadata.version: "2.1.0"`、`metadata.date: "2026-10-08"` |

## 为什么 vendored 而不是让用户自己装技能

`ego-browser` 是**引导型技能**（bootstrap）：它的正文只有 1.6KB，真正的 API 指南由 `ego-browser skill`
从**已安装的 app** 里打印出来（版本对齐）。所以：

· 随包带这份技能的成本极低（~44KB，MIT），收益是"用户装好 app 之后，模型**当回合**就知道有这个浏览器"；
· 正文不带 API 细节 ⇒ **不会因为我们随包而变旧**（指南永远来自用户的 app）。

## 我们自己的部分（`lib/`）

| 文件 | 归属 | 作用 |
| --- | --- | --- |
| `lib/index.js` | 我们写的 | 4 个工具 + packaged skill provider；审批 fail-closed |
| `lib/core/cli.js` | 我们写的 | CLI 定位（**不依赖 PATH**）、`.cmd` 垫片处理、stdin 喂脚本、超时杀**进程树** |
| `lib/core/scripts.js` | 我们写的 | 探测/清单脚本（数组拼，不用模板串）+ 输出渲染 |

**没有一行抄上游的 `package/ego-browser`（Node helper runtime）**：那部分是跑在 app 内部的 helper
（消费 `globalThis.ego`），我们只往 app 的 node 上下文里**喂脚本**，不需要它。

## 与上游 dsh 适配（`@citrolabs/ego-deepseek-harness`）的关系

上游的适配**只注册技能、不注册工具**（`plugins/ego/dsh/src/index.js` 80 行）。我们保留它的技能
语义（`source: 'bundled'`、`rank: 600`、同名不改），额外补 4 个工具。两者**不要同时装**：
技能会各报一份（同名对实测是静默取一，但没必要），工具只有我们这份。

若将来上游适配也加工具，优先切回上游那份（本包的 README 里记了判据）。

## 升级上游技能（谁来做、怎么做）

1. 从上游仓库重新整目录复制到 `skills/ego-browser/`（`robocopy` / `Copy-Item -Recurse -Force`，先删旧的）；
2. `npm --prefix dsh-plugins run check:plugins` 里的 `check-plugin-files` / `check-tool-definitions` 必须仍绿；
3. `node dsh-plugins/vssaros-ego/test/run-ego-check.mjs` 必须仍绿（它会核对 frontmatter 与 `ego-browser skill` 引导句）；
4. **bump 本包版本**（`dsh plugin add` 同版本短路不重装 ⇒ 不 bump 等于没改）。
