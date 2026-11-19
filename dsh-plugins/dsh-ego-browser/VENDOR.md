# VENDOR — `dsh-ego-browser`

## 这是什么

`dsh-plugins/dsh-ego-browser/` 是第三方 DSH 插件 [`dsh-ego-browser`](https://github.com/Fisfzy/dsh-ego-browser)
**v0.14.1** 的随包（vendored）副本，取自 npm 发布包 `dsh-ego-browser@0.14.1`（`npm pack`，MIT）。
包名**保留上游的** `dsh-ego-browser`，不改成 `@vssaros/*`：装进 profile 后与 npm 上那个是同一个包名，
用户另行从插件中心装一份不会变成"两个 provider 各注册一套 `ego_*` 工具"。同一取舍的先例是
`dsh-plugins/vssaros-archify/`（`@tt-a1i/archify-dsh`）。

产品要求：**VsSaros 内置 `dsh-ego-browser`**。本仓"内置"的定义（见 `vssaros-archify/VENDOR.md`、
`dsh-plugins/README.md`）是随产品分发的 `dsh-plugins/` 目录 + 启动序列默认自动安装（本地 `file:` 暂存、
零网络），而不是让用户去插件中心点一次"推荐卡片"。

## 为什么替换自研的 `@vssaros/dsh-ego`

此前 `dsh-plugins/vssaros-ego/` 是 ego lite 的**薄接入**：vendored `skills/ego-browser/` + 4 个工具
（`ego_status` / `ego_guide` / `ego_spaces` / `ego_run`），浏览器本体要用户另装第三方 app。
上游插件自带 `runtime/`（ego-lite 运行时 + 受管 Chrome/CDP）、34 个结构化 `ego_*` 工具、
实时观察窗与随包 `runtime/skills/ego-browser/SKILL.md`。两者 `ego_status` **重名**，而 dsh 里
同名工具会让整条 entry 失效 ⇒ 不能并存。因此本次改为内置上游插件，旧薄接入整包退役
（目录删除；旧 profile 里残留的 bundle 由 `dshPluginActivation.ts` 的一次性迁移摘掉）。

> `vssaros-browser`（CDP 驱动用户本机 Chrome）与它**不是替代关系**，照旧并存、各管一摊。

## 随包登记（改一处就要改全部）

| 位置 | 作用 |
| --- | --- |
| `src/vs/sessions/contrib/dshHarness/common/dshHarness.ts` | `DSH_EGO_BROWSER_PLUGIN_NAME` |
| `src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts` | 解析 `dsh-plugins/dsh-ego-browser/` |
| `src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts` | `egoBrowserPluginDir` + 伴生安装清单 |
| `build/prepack-dsh-runtime.mjs` | `discoverRepoPluginDirs` 白名单（首启零下载的种子） |
| `src/vs/sessions/contrib/dshHarness/test/common/dshPluginPackages.test.ts` | `VENDORED_THIRD_PARTY` 版本/包名登记 |
| `build/saros/strip-before-pack.mjs` | 无需改：整个 `dsh-plugins/` 逐文件随包 |

它没有 `vssaros.module`（不是 VsSaros UI 模块）⇒ 与 archify / 旧 ego 同属**伴生插件**，
不进 `listBundledPlugins()` 的模块自发现，也不进插件中心「随包模块」段。装配靠自带的
`cordis.patch.yml`（`- id: ego-browser` / `name: "dsh-ego-browser"`）。

## 本地对上游包做的唯一改动

只改 `package.json`（**未改任何 `lib/` / `bin/` / `runtime/` 字节**）：

- 删 `devDependencies` / `scripts`：TypeScript 源码、vitest/tsdown 构建链不随产品分发；
- `dependencies` 清空、`@deepseek-ai/schemastery` 移到 `peerDependencies`（optional）、删掉未使用的
  `schemastery`。`lib/index.js` 实际导入的只有 `@deepseek-ai/dsh-tools` 与
  `@deepseek-ai/schemastery`，两者都由 dsh 运行时/ profile 的 `node_modules` 提供
  （随包 runtime 实测存在）。随包插件必须零运行时依赖，否则首启/装机后仍要联网解析 npm。

守卫 `dshPluginPackages.test.ts` 的"不得把随 dsh 分发的包声明为 `dependencies`"、
`check-plugin-files.mjs` 的 `files` 白名单与 `check-plugins-tracked.mjs` 的入库检查都依赖这个收敛。

### 两处有理由的守卫豁免

- `check-plugin-files.mjs` 的"入口真的能 import"：上游打包入口静态 import 的
  `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` 只有 dsh Host 的 module loader 解析得到，
  仓库里离线 import 必然失败 ⇒ 守卫改判"入口仍是上游打包产物"，真机激活按下面升级流程核对。
- `check-spawn-hide.mjs` 的 `windowsHide`：本插件的核心职责就是拉起**有窗口的 Chrome**
  （观察窗 / 人工接管），强制隐藏反而把用户要看的窗口藏掉；且我们承诺不改上游字节 ⇒ 该目录整体豁免，
  守卫每次运行会打印这一行，自研插件仍逐处受检。
- `check-theme-hardcodes.mjs` 的 `--dsw-alias-*` 令牌：上游 client 有自己的主题体系，
  我们承诺不改字节 ⇒ 与 `dsh-vision-router` 一起按目录整体豁免（守卫打印一行）。

`tools-snapshot.mjs` 也不抽它的工具面（同上：打包产物依赖 Host 服务），理由写在那个脚本的扫描处。

⚠ `.gitignore` 顶层有 `dist/`，而上游发布包带 `runtime/ego-browser/dist/out/index.js`（运行时真需要）。
仓库为这个路径加了放行规则；升级时若新增被忽略的运行时文件，`check-plugins-tracked.mjs` 会点名。

## 许可与署名

插件本体 MIT（`LICENSE`），内置 ego-lite 运行时的来源与逐文件清单见
`THIRD_PARTY_NOTICES.md`，本地补丁见 `runtime/PATCHES.md`。可选 FFmpeg 下载涉及 GPL-3.0-or-later
义务，VsSaros 不随包分发该二进制。

## 升级流程

1. `npm pack dsh-ego-browser@<新版本>`，用发布包内容覆盖本目录（保留 `VENDOR.md`）；
2. 重新按上面"本地唯一改动"收敛 `package.json`；
3. 同步 `VENDORED_THIRD_PARTY` 里登记的 `version`、`VENDOR.md` 的版本号，以及
   `src/vs/sessions/contrib/dshHarness/test/common/dshPluginPackages.test.ts` 的用例；
4. bump 后跑 `npm run check:dsh-plugins`，再 F5 一次确认启动日志里出现
   `dsh-ego-browser` 的安装行、`profile bundles` 里有 `dsh-ego-browser` 且没有旧
   `@vssaros/dsh-ego`，最后真机调用一次 `ego_doctor` / `ego_status`。
