# vssaros-archify —— 随包 vendored 的**第三方**技能包

⚠ **这个目录里的东西不是我们写的**：它是第三方 npm 包 `@tt-a1i/archify-dsh@1.0.0` 的**原样副本**
（连同上游的 `LICENSE` / `README.md` / `CHANGELOG.md` / `release.json` 一起）。

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/tt-a1i/archify （`integrations/deepseek-harness` 子目录） |
| npm 包名 | `@tt-a1i/archify-dsh`（**保留上游名，没有改成 `@vssaros/*`** —— 理由见下） |
| 版本 | `1.0.0`（与 `dshPluginPackages.test.ts` 的 `VENDORED_THIRD_PARTY`、`dshPluginRecommendations.test.ts` 的 `ARCHIFY_VERSION` 三处一致 ✓） |
| 许可 | **MIT**（见本目录 `LICENSE`）—— 随分发必须保留 ✓ |
| 内容 | `lib/index.js`（682B，bundle 入口）+ `cordis.patch.yml` + `skills/archify/**`（技能本体：SKILL.md / bin / schemas / renderers / references / recipes / migrations / examples…） |
| 规模 | 134 个条目、≈7.3MB |

## 为什么放在这里（而不是"让用户从 npm 装一次"）

2026-10-14 用户要求：archify **默认随包自动装**。本仓"随包"的定义就是**随产品分发的目录**（`dsh-plugins/`），由
`DshHostSupervisor` 在起 Host 前当**伴生插件**自动安装（本地暂存拷贝 + 一条 `dsh plugin add file:…`）
⇒ **零网络**、离线可用、首启只多一次拷贝（而 npm 那条要联网，实测首次 30s+ ✗）。

所以它**不再**出现在插件中心「添加插件」的策展清单里（那档 = "没随发行装上的可选包，必须走 npm 装一次"）；
两条路径并存本身就是缺陷（用户点了、联网装了、跟随包那份又可能不同版本 ✗）。

## 为什么保留上游包名

装进 profile 后它与 npm 上那个是**同一个包名** ⇒ 用户若另外从 npm 装一份，pnpm 更新的是**同一份**，
不会变成"两个 provider 各报一个 `archify` 技能"（2026-10-13 刚消灭掉的那种重复交付 ✗）。
改成 `@vssaros/dsh-archify` 反而会制造这个分裂。

## 升级怎么做（注意：不是"改个版本号"）

1. 取新版内容（`npm pack @tt-a1i/archify-dsh@<v>`，或从装过该版本的 profile 的 `node_modules/` 里取整目录）；
2. **整目录替换**本目录内容（保持原样，别改上游文件；`VENDOR.md` 这个说明文件可以留）；
3. 同步三处记录：本文件的版本表、`dshPluginPackages.test.ts` 的 `VENDORED_THIRD_PARTY[].version`、
   `dshPluginRecommendations.test.ts` 的 `ARCHIFY_VERSION`（不一致就红 ✓）；
4. 跑：`dshPluginPackages`（包结构）、`dshPluginRecommendations`（随包副本在位）、`dshFreshProfileInstall`
   （真机在**全新 profile** 上自动装一遍 —— 这条是"默认随包"的端到端证据 ✓）。

## 打包（别漏）

`build/gulpfile.vscode.ts` 的 `dshPlugins` glob 必须覆盖 `dsh-plugins/*/skills/**`（+ `LICENSE`）：
负载在 `skills/` 而不在 `lib/` 里 ⇒ 不显式列出就是**本地开发一切正常、打包后缺文件**（"能装不能跑" ✗）。
