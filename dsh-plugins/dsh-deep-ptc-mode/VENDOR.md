# dsh-deep-ptc-mode —— 随包 vendored 的**第三方** Agent 模式插件

⚠ **这个目录里的东西不是我们写的**：它基于第三方 npm 包 `dsh-deep-ptc-mode@2.3.0`，
除下述两处**本地集成适配**外均为上游原样副本（含 `LICENSE` / 各 README / `CHANGELOG.md` /
`TEST_REPORT.md` / `COMPATIBILITY.md` / `compatibility.json`）。

本地适配只有两处，都在 `package.json`：
① `vssarosModePresets` 声明（运行时模式目录的数据源，见下）；
② `version` 提到 `2.3.1` —— dsh 伴生安装的判据是「版本 + 入口内容」，只改 `package.json`、
   入口不变时同版本**不会重装**，已装副本会一直缺这份声明 ⇒ 必须 bump。
⇒ 本目录字节不再等于 npm 上的 2.3.0；升级整目录替换时记得把这两处带回来（见「升级怎么做」）。

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/lishize20040802-rgb/dsh-deep-ptc-mode |
| 商城条目 | `awesome-dsh-plugin.com` 策展目录，category `workflow`，安装命令 `dsh plugin --profile web add dsh-deep-ptc-mode` |
| npm 包名 | `dsh-deep-ptc-mode`（**保留上游名**，不改成 `@vssaros/*`） |
| 版本 | `2.3.1`（上游内容 = `2.3.0`；本地修订号只为触发 dsh 重装，与 `dshPluginPackages.test.ts` 的 `VENDORED_THIRD_PARTY` 一致 ✓） |
| 许可 | **MIT**（见本目录 `LICENSE`）—— 随分发必须保留 ✓ |
| 内容 | `lib/**`（Host 侧入口 `lib/index.mjs`、客户端 `lib/client.js`、10 个内置 Skill 与示例）、`locale/*.json`、`assets/icon.png`、`cordis.patch.yml`、`compatibility.json` |
| 规模 | 89 个文件、≈1.09 MB |
| 运行时依赖 | `js-yaml@4.3.2`；`lib/upstream.mjs` 通过宿主 module graph 解析它，宿主已带 |
| Host 解析型入口 | `lib/index.mjs` 静态 `import z from '@deepseek-ai/schemastery'` ⇒ 仓库里离线 import 必然失败，由 dsh Host 加载；守卫改用形态标记核对（见 `check-plugin-files.mjs` 的 `HOST_RESOLVED_ENTRIES`） |

## 为什么放在这里（而不是"让用户从 npm 装一次"）

2026-11-21 用户要求：**VsSaros 的 dsh 默认安装 deep-ptc-mode**。本仓"默认安装"的定义就是
**随产品分发的目录**（`dsh-plugins/`），由 `DshHostSupervisor` 在起 Host 前当**伴生插件**
自动安装（本地暂存拷贝 + 一条 `dsh plugin add file:…`）⇒ **零网络**、离线可用、首启只多一次拷贝。

按既有纪律，随包的包**不**进插件中心「添加插件」的策展清单（那档 = 没随发行装上的可选包），
两条路径并存会变成"两条安装路径 + 可能的两个 provider" ✗。本仓 `CURATED_THIRD_PARTY_BUNDLES`
继续保持为空。`wiring` 四处登记见 `dshHarness/test/common/dshPluginPackages.test.ts`。

## 为什么保留上游包名

装进 profile 后它与 npm 上那个是**同一个包名** ⇒ 用户若另外从 npm 装一份，pnpm 更新的是
同一份，不会变成两个 provider 各注册一个同名 preset（理由同 `vssaros-archify/VENDOR.md`）。

## ⚠ 安装 ≠ 启用

它是 **Agent preset 插件**：装上后 VsSaros 自绘模式菜单的「第三方模式（随包内置）」分组会出现
「深度 PTC 模式」。菜单**不写任何 preset id**（2026-11-21 改造）：本包 `package.json` 的
`vssarosModePresets` 声明 → `vssaros-chat-surface` 的 Host 半汇总所有已装插件的声明 →
`/x/chat-surface/api/modes-list` 同源下发 → 前端按数据过滤 / 分组 / 取名；守卫用 fixture
目录 + 反向突变 + 「零 id 字面量」断言钉住。路由挂在 dsh 自己的 `webServer` 上 ⇒
dsh desktop / 全窗（无 VsSaros 控制桥）同样同源可用。
用户仍需**新建会话并选中它**（设置 → 深度 PTC 选执行环境）才生效；已有会话热切换可能被
Host 拒绝（preset 在会话创建时绑定）。本仓默认 preset 仍是 `vssaros-standard`（native），
**没有**改成 deep PTC。

上游从宿主官方 `@deepseek-ai/dsh-web-app/presets/ptc.patch.yml` 派生自己的预设并继承上游变更；
而 VsSaros 的 PTC 档是 `vssaros-ptc`（官方行 + 我们自己的模块）。两者的模块组成不同：
deep-ptc 派生的 preset **不含`@vssaros/*` 行**，VsSaros 能力全靠 host plane 全局行注册。

### VsSaros 工具在 deep-ptc SDK 里的可见性（2026-11-21 静态判定，待真机复核）

⚠ **结论与早期推测相反**：`codebase_*` / `kb_*` / `workflow_*` / `media_*` / memory 等工具
**默认就出现在 compact SDK 里**，不需要 `deep_ptc_tools` 激活；只有少数能被归因的工具会被折叠。

判据链（均为本包真实代码）：
1. `lib/official-names.mjs:43-64` 的 `installedSource()` 只解析包**入口文件**（`main` / `exports['.']`）
   并 `readFileSync` 那**一个**文件；`toolNamesInSource()` 只认 `defineTool({name:` /
   `tools.register({name:` / `tools.register(helper("name"` 三种写法。
2. VsSaros 多数插件把工具声明分散在 `lib/**` 子模块里，入口只是聚合 ⇒ 按真机读取方式对
   `tools-snapshot.json` 的 149 个工具复算，只有 **30 个**能被归因（kanban 17 / loop 5 /
   mcp 6 / office-template 2）；其余 **119 个是 unattributed**。
3. `lib/tool-policy.mjs:147-149` 的 `external()` 要求「正向外部归属」；`README.md:416` 的
   Runtime boundaries 亦明写 *"Unattributed tools remain available; quarantine requires
   positive external attribution"* ⇒ `external === false` ⇒ `sdkDefinitions(compact=true)`
   (`:218-223`) 的 `!external(def)` 保留它们。
4. 因此：被折叠的只有可归因的那 30 个（含 **`kanban_*` 全部**），它们需要
   `deep_ptc_tools(action="search")` → `action="load"`（每次 1–6 个、16 KB 预算、保留 12 个近期选择）。

⚠ 两个会让结论变化的例外，真机必须一并看：
- `lib/tool-compatibility.mjs:84` 只在 `section.text === cached.original` 时替换 SDK 段 ⇒
  若有第二个 SDK 改写者，compact 整体失效，被折叠的工具也全可见。
- `lib/resident.mjs:18-26`：工具自带 `resident: true` / `screen_*` / `dsh-go` provider 会常驻。

另见 `doc/tool-surface-ptc-vs-deny.md`：本仓实测结论是 PTC 在「工具多而分散」的形态下为
净负优化，默认仍走 native + `denyTools`。**真机复核动作**：新建会话选「深度 PTC 模式」后，
直接让模型调 `codebase_architecture`（应在 SDK）与 `kanban_list`（应需先 `deep_ptc_tools` load）。

## 升级怎么做（不是"改个版本号"）

1. `npm pack dsh-deep-ptc-mode@<v>`，**整目录替换**本目录内容（保持上游文件原样，只保留 `VENDOR.md`）；
2. 把 `package.json` 的 `vssarosModePresets` 声明**加回去**，并把 `version` 提到一个高于上游的本地修订号
   （否则 dsh 判「同版本」不重装，已装副本读不到声明 ⇒ 菜单里这个模式会凭空消失）；
3. 同步 `dshHarness/test/common/dshPluginPackages.test.ts` 的 `VENDORED_THIRD_PARTY['dsh-deep-ptc-mode'].version`
   与本文件的版本表（不一致会红 ✓）；
4. 检查 `lib/index.mjs` 的形态标记、`dsh.client.inject` 的前置包是否仍与守卫里登记的一致
   （上游换了构建方式/宿主契约就要重新评估这两条例外）；
5. 跑：`dshPluginPackages`（包结构与四处登记）、`check-plugin-files`（files / 入口）、
   `check-chat-surface-chunks`（模式目录的数据驱动守卫）、
   `dshFreshProfileInstall`（真机在**全新 profile** 上自动装一遍 —— 这是"默认安装"的端到端证据 ✓）。

## 打包（别漏）

`build/gulpfile.vscode.ts` 的 `dshPlugins` glob 原本只覆盖 `lib/**` / `skills/**` / `LICENSE`；
本包负载还有 `locale/**`、`assets/**`、`compatibility.json` 与若干 `.md`，
已补进 glob。`build/saros/strip-before-pack.mjs` 的完整性门禁按整目录逐文件比对
（只排除 `dev/` 与 `node_modules`），漏一个都会在构建收尾红。
