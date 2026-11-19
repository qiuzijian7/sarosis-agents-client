# VENDOR — `dsh-vision-router`

## 这是什么

`dsh-plugins/dsh-vision-router/` 是第三方 DSH 插件 [`dsh-vision-router`](https://github.com/ysr666/dsh-vision-router)
**v3.4.0** 的随包（vendored）副本，取自 npm 发布包 `dsh-vision-router@3.4.0`（`npm pack`，MIT，
5.3 MB / 333 个文件）。包名**保留上游的** `dsh-vision-router`（不带 scope、不改 `@vssaros/*`），
与 `dsh-plugins/dsh-ego-browser/` 同一取舍：装进 profile 后和 npm 上是同一个包，用户别处再装一份
不会变成两个 provider。

产品要求：**VsSaros 内置 `dsh-vision-router`**。本仓「内置」的定义（见 `dsh-plugins/README.md`
与 `vssaros-archify/VENDOR.md`）是随产品分发的 `dsh-plugins/` 目录 + 启动序列默认自动安装，
而不是让用户去插件中心点推荐卡片。

> 用户原话写作 `dsh-visison-router`（笔误）；npm 上不存在该拼写，真包是
> `dsh-vision-router`。本目录与所有登记都用纠正后的名字。

## 带来的能力

- 图片轮的**视觉模型路由**（失败降级 / 分类报错 / 图片答案缓存），以及 14 个按需视觉工具：
  `vision_describe` / `vision_ground` / `vision_crop` / `vision_pixel_diff` / `vision_ocr` /
  `vision_html_screenshot` / `vision_screenshot` / `vision_trace` / `vision_colors` / `vision_detect` /
  `vision_materialize` / `vision_present` / `vision_extract_foreground` / `vision_activate`。
- Web 侧「👁 识图」开关、设置卡片、`doctor` 诊断 CLI（`bin.dsh-vision-router`）。
- 与 `vssaros-media` 的 `vision_analyze` **不重名**（`vision_analyze` 是 IDE 侧桥接的单图读图；
  这里的是 Host 侧像素工具链）⇒ 两者并存，无工具名冲突，也无需退役任何自研插件。

## 随包登记（改一处就要改全部）

| 位置 | 作用 |
| --- | --- |
| `src/vs/sessions/contrib/dshHarness/common/dshHarness.ts` | `DSH_VISION_ROUTER_PLUGIN_NAME` |
| `src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts` | 解析 `dsh-plugins/dsh-vision-router/` |
| `src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts` | `visionRouterPluginDir` + 伴生安装清单 |
| `build/prepack-dsh-runtime.mjs` | `discoverRepoPluginDirs` 白名单（首启零下载的种子） |
| `src/vs/sessions/contrib/dshHarness/test/common/dshPluginPackages.test.ts` | `VENDORED_THIRD_PARTY` 版本/包名登记 + 接线守卫 |
| `build/saros/strip-before-pack.mjs` | 无需改：整个 `dsh-plugins/` 逐文件随包 |

它没有 `vssaros.module`（不是 VsSaros UI 模块）⇒ 与 archify / `dsh-ego-browser` 同属**伴生插件**，
不进 `listBundledPlugins()` 的模块自发现，也不进插件中心「随包模块」段。装配靠自带的
`cordis.patch.yml`（`- id: vision-router` / `name: dsh-vision-router`）。

⚠ 该 patch 还会覆盖三条**官方核心行**：`modules`（追加 `inject: [webServer]`）、
`connection`（追加 `inject: [webStartup, webServer]`）、`attachment-local`（放大图片准入上限）。
本仓 `renderHostOverlays` 只写 `vssaros-*` / skill / mcp 等行，**不写这三个 id** ⇒ 没有
「同一行被两份覆盖层打 ⇒ config 整体替换」的冲突。但 `hideOfficialDeepseek` 让桥接隐藏官方
`deepseek-official` provider 时，Vision Router 的「+ 自动识图」包装路由可能挂不上 —— 这条组合
**必须真机验一次**（见升级流程）。

## 本地对上游包做的改动

只改 `package.json`（**未改 `lib/` / `entry.js` / `index.js` / `cordis.patch.yml` / `docs/` 的任何字节**）：

- 删 `scripts`：上游有 `prepare: pnpm build` / `prepack: pnpm license:check && pnpm build`，
  本地 `file:` 安装会触发 `prepare` 去跑仓库里根本没有的构建链 ⇒ 必须去掉；其余都是开发/测试脚本，
  不随产品分发。`scripts/install-native-ocr.mjs` 这个文件本身仍随包（用户可手动调）。
- 删 `devDependencies`（含多个 `@deepseek-ai/*` 固定版本，只用于上游 CI）。
- 删 `packageManager`（上游 pin pnpm 11.20.0；本仓 pnpm 单一真源是根 `package.json` 的 11.28.5）。
- `@deepseek-ai/schemastery` 从 `dependencies` 移到 `peerDependencies`（optional）：它由 dsh 运行时提供，
  而本仓守卫禁止把随 dsh 分发的包声明成 `dependencies`。
- 保留 5 个**真实运行时依赖**（`@visioncortex/vtracer` / `puppeteer-core` / `semver` / `undici` / `zod`）
  与 3 个 optional peer（`@deepseek-ai/dsh-llm-deepseek` / `@deepseek-ai/schemastery` / `sharp`）。

### 与 `dsh-ego-browser` 的差别：依赖解析时机

`dsh-ego-browser` 是零依赖打包产物；本包**不是**。`lib/` 里的 200 个 JS 是真源码模块，
真的 import 上面那 5 个包和 `sharp`，不能靠删依赖假装离线。口径是：

- **产品构建期**（有网络）：`build/prepack-dsh-runtime.mjs` 把本目录作为 `file:` 源做
  `dsh plugin add`，pnpm 解析依赖并把整棵依赖树烘进 profile 种子 ⇒ **装机后首启零网络** ✓；
- **dev 全新 profile**（没有种子）：`dshHostSupervisor` 的伴生安装会经 pnpm 解析这些依赖 ⇒
  **需要一次网络**。这是本包与 ego-browser 的已知差异，不是回归。
- 原生 OCR 二进制/模型**不随包**（上游明确「公开分发未获放行」），用户可选手动安装；
  不装时按插件既有授权/隐私设置回退。

### ⚠ 默认隐私策略（内置 = 默认对所有人启用）

上游默认 `localOnlyVision: false` + `freeFallback: true` ⇒ **会把图片发给匿名 OVH 视觉端点**。
本次内置**不改上游默认**（不擅自改变产品行为），但这是一条明确的产品决策：
需要纯本地时在 profile / composition 补丁里给 `vision-router` 行设
`localOnlyVision: true`（同时 `freeFallback` 不生效），并配本地视觉端点；严格端到端纯本地还需要
本地聊天模型。上游 `README.zh.md` 的「数据流向与严格纯本地配置」一节写了完整口径。

## 守卫豁免（每条都有理由，且不是静默跳过）

- `check-plugin-files.mjs`「入口真的能 import」、`dshPluginPackages.test.ts`「Host 入口必须能被加载」：
  上游 `lib/public-entry.js` 静态 import `@deepseek-ai/*` 与 5 个运行时依赖，只有 dsh Host 的
  module loader / profile 的 `node_modules` 解析得到 ⇒ 离线 import 必然失败。守卫改判
  「入口仍是上游源码形态」并打印一行，真机加载按下面流程核对。
- `dshPluginPackages.test.ts`「Slot 目录比对」：上游 client 注入 `settings.section` /
  `settings.section.icon` / `tool.call.toolview`，属于**上游自己的宿主契约**（见 `dsh.client.inject`
  的四个 `@deepseek-ai/dsh-client-*` peer），拿本仓运行时目录去判会假红。
- `check-spawn-hide.mjs`：上游 `lib/` 有 12 个文件起子进程（OCR supervisor / doctor / 截图 /
  self-update）。它们由上游负责，我们承诺不改字节 ⇒ 该目录整体豁免，守卫每次运行打印一行；
  自研插件仍逐处受检。
- `check-theme-hardcodes.mjs`：`lib/client-presentation-boundary-main.js` 有自己的深色底，
  不跟本仓 `--dsw-alias-*` 令牌走 ⇒ 该目录整体豁免（守卫打印一行），自研在页脚本仍逐个受检。
- `dshPluginPackages.test.ts`「插件不许用同步解压」：`lib/legacy-session-repair.js` 的
  `zstdDecompressSync` 只在一次性遗留会话修复里用、且带 `maxOutputLength` 上限 ⇒ 逐条登记
  `ALLOW`（不是 129MB 图谱那种热路径）。
- `tools-snapshot.mjs`：目录名不带 `vssaros-` 前缀，且工具面依赖 Host 服务 ⇒ 不进
  `tools-snapshot.json`（理由写在那个脚本的扫描处）。

`.gitignore` 为 `assets/licenses/*.txt` 加了放行规则（全局 `*.txt` 会吞掉
`THIRD_PARTY_NOTICES.md` 指向的许可原文）；`check-plugins-tracked.mjs` 会盯着 `files` 白名单里的
333 个文件是否都入库。

## 许可与署名

插件本体 MIT（`LICENSE`）；内置/可选第三方组件的逐项来源见 `THIRD_PARTY_NOTICES.md`，
许可原文随包在 `assets/licenses/`。**原生 OCR 二进制与模型不随包**。

## 升级流程

1. `npm pack dsh-vision-router@<新版本>`，用发布包内容覆盖本目录（保留 `VENDOR.md`）；
2. 按上面「本地对上游包做的改动」重新收敛 `package.json`；
3. 同步 `VENDORED_THIRD_PARTY` 的 `version`、`VENDOR.md` 的版本号与许可清单；
4. 跑 `npm run check:dsh-plugins`、`node build/saros/check-dsh-release.mjs`，
   再重建一次 profile 种子（依赖树变了必须重烘）；
5. F5 真机核对：启动日志出现 `dsh-vision-router` 的安装行、`profile bundles` 里有它、
   `👁 识图` 开关可见、`doctor` 无红；并**专门验一次 `hideOfficialDeepseek` 打开时**
   视觉路由是否仍挂得上（见上面「核心行」那段）。
