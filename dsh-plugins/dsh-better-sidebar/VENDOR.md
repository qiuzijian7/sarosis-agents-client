# VENDOR — `dsh-better-sidebar`

## 这是什么

`dsh-plugins/dsh-better-sidebar/` 是第三方 DSH 插件
[`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) **v0.32.1** 的随包
（vendored）副本，取自 npm 发布包 `dsh-better-sidebar@0.32.1`（`npm pack`，MIT，
543 个文件 / 19.83 MB，含完整 `src/` TS 源码与 `lib/` 打包产物）。包名**保留上游的**
`dsh-better-sidebar`，与 `dsh-ego-browser` / `dsh-vision-router` 同一取舍：装进 profile 后
与 npm 上是同一个包，用户别处再装一份不会变成两个 provider。

产品要求：**VsSaros 内置 `dsh-better-sidebar`**。本仓「内置」的定义（见
`dsh-plugins/README.md` 与 `vssaros-archify/VENDOR.md`）是随产品分发的 `dsh-plugins/` 目录 +
启动序列默认自动安装，而不是让用户去插件中心点推荐卡片。

上游源码/文档/测试的只读检视副本在仓库根 `.tmp-better-sidebar-inspect/`（被 `.gitignore`
的 `.tmp-*` 忽略，**不入库**）：`npm/package/` 是发布包解包、`upstream/` 是 GitHub 浅克隆
（含 `docs/host-contracts.md`、`docs/external-plugin-guide.md`、`tests/`）。注意
`docs/external-plugin-guide.md` 与 `dsh.plugin.json` **不在 npm 发布包里**；后者按上游
`docs/host-contracts.md` 第 11 条「从来不是 DSH 契约」，只服务第三方市场通道，DSH 真正读的是
`package.json` 的 `dsh.bundle.patch` + `dsh.client`。

## 版本线（恰好对齐本仓）

`dsh.plugin.json` 声明 `engines.dsh >=0.2.2-rc.2`，`package.json` 的 14 个
`@deepseek-ai/dsh-*` peer 全部锁 `^0.2.2-rc.2` —— 与本仓 `dsh-plugins/dsh-compat.json`
的 `bundled: 0.2.2-rc.2` 一致。上游 README 明确要求按宿主版本**精确钉版**
（`0.2.2-rc.1` 必须用 `0.32.0`，`0.2.1` 线用 `0.28.2`），升级 DSH 运行时时要一起复核。

## 能力概览（功能逻辑拆解）

- **双工作台**：右栏交给宿主原生 Sidebar（`sidebarRightTabs.register` + `sidebar.right.pane.tab`
  等 slot），插件只自绘**底部 workbench**（拖拽分栏、宿主终端复用、按会话持久化布局）；
  v0.31 起还接管宿主起始页（`sidebar.right.tab.guide`，`guideTakeover` 默认开）。
- **六条功能链路**：文件树（批量列目录 / watch 重列 / git 染色 / 上传 / 打包下载）、
  CodeMirror 可编辑编辑器与 Markdown·Mermaid·HTML·`.jsonl`·媒体预览（>5 MB 转只读分页）、
  Git Changes 与只读提交图、Tasks/子代理拓扑/Agent Team/后台任务、侧边对话（真实子会话 +
  继承父会话日志 + 边界提示词）、起始页/终端。
- **Host 侧** `inject=['webServer','sessions','connection','tools']`，`apply()` 只用 `ctx.effect`
  注册 `/sidebar/api` 等 8 组路由与 3 条 WS，**不 `ctx.provide` 任何服务**；
  唯一 model 工具 `sidebar_open` 由 `agentOpenTools` 开关控制（默认关）。
- **Client 侧** `ctx.provide('betterSidebar', service)`，暴露 `registerTab` /
  `registerFileViewer` / `registerFileIcon` / `registerFileAction` / `registerTabAction`
  五个扩展点；内置 6 tab + 5 viewer 也走同一套 API（dogfooding）。
- **「每个会话独立」= 浏览器 localStorage 分键** `dsh-sidebar:v1:<sessionId>`
  （分栏树 / 打开 tab / 展开集合），草稿另有 `dsh-better-sidebar:draft:`；prefs 在 Host
  settings 文档（`settings.get/update` + `expectedRevision` CAS）。
- **实时机制**：没有 SSE（`rxjs` 是上游残留依赖，源码 0 命中）；3 条 WS
  （`agent-opens` / `fs-watch` / `sidechat`）**只推失效帧**，正文靠 `/sidebar/api` 增量 +
  `usePolling` 2–5s + `changes.ops` 25s 长轮询。启动只拉核心，重依赖按
  `editor` / `mermaid` / `locale` / `terminal` 四个 chunk 经 `/sidebar/bundle/<name>.js` 懒加载。

## 随包登记（改一处就要改全部）

| 位置 | 作用 |
| --- | --- |
| `src/vs/sessions/contrib/dshHarness/common/dshHarness.ts` | `DSH_BETTER_SIDEBAR_PLUGIN_NAME` |
| `src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts` | 解析 `dsh-plugins/dsh-better-sidebar/` |
| `src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts` | `betterSidebarPluginDir` + 伴生安装清单 |
| `build/prepack-dsh-runtime.mjs` | `UNSCOPED_VENDORED` 白名单（首启零下载的种子） |
| `src/vs/sessions/contrib/dshHarness/test/common/dshPluginPackages.test.ts` | `VENDORED_THIRD_PARTY` 版本/包名登记 + 接线守卫 |
| `build/saros/strip-before-pack.mjs` | 无需改：整个 `dsh-plugins/` 逐文件随包 |

它没有 `vssaros.module` ⇒ 与另三个 vendored 包同属**伴生插件**，不进
`listBundledPlugins()` 的模块自发现。装配靠自带的 `cordis.patch.yml`
（`- id: better-sidebar` / `name: 'dsh-better-sidebar'`），该 patch 还用 `!!js`
表达式 `[...ctx.loader.entries()]…` 防聚合包重复挂载（重复会注册两次 `/sidebar/api`，
导致整棵插件树启动失败）。

## 本地对上游包做的改动

只改 `package.json`（**未改 `lib/` / `src/` / `cordis.patch.yml` / `detail/` / `locale/`
的任何字节**）：

- 删 `scripts`：全是上游开发/CI 脚本，不随产品分发（发布包本来就没有 `prepare` /
  `postinstall` 安装钩子 —— 上游 `AGENTS.md` 明令禁止；`scripts/*.mjs|sh|ps1` 这些文件
  本身仍随包，用户可手动调）。
- 删 `devDependencies`：36 个 `@deepseek-ai/*` 精确钉版只服务上游 dev 依赖树，
  且本仓守卫禁止把随 dsh 分发的包声明在 `devDependencies` 里。
- 保留 32 个**真实运行时依赖**（`@codemirror/*` 全家桶、`@lezer/highlight`、
  `@xterm/*`、`mermaid`、`dompurify`、`react-icons`、`ws`、`yaml`、`clsx`、`rxjs`）
  与 19 个 peer（其中 2 个标记 optional：`@huanlin/dsh-plugin-better-locale`、
  `@deepseek-ai/dsh-client-ui-sidebar-right`）。`lib/index.js` 真的 import `ws` / `yaml` /
  `@deepseek-ai/schemastery`，不能靠删依赖假装离线。

发布包里没有被现有 `.gitignore` 规则吞掉的文件（已逐个核对），因此**本轮没有新增
`.gitignore` 例外**；`check-plugins-tracked.mjs` 仍会盯着 `files` 白名单里的文件是否入库。

### 依赖解析时机

与 `dsh-vision-router` 同口径：

- **产品构建期**（有网络）：`build/prepack-dsh-runtime.mjs` 把本目录作为 `file:` 源做
  `dsh plugin add`，pnpm 解析并把整棵依赖树烘进 profile 种子 ⇒ **装机后首启零网络** ✓；
- **dev 全新 profile**（没有种子）：`dshHostSupervisor` 的伴生安装会经 pnpm 解析这些依赖
  ⇒ **需要一次网络**。这是与零依赖的 `dsh-ego-browser` 的已知差异，不是回归。

## ⚠ 安全与权限（内置 = 默认对所有人启用）

上一轮拆解已确认，且上游 `src/path-security.ts` 与
`docs/external-plugin-guide.md` §8.1 白纸黑字写明：

- **工作区围栏被上游主动移除**（v0.23.0「权限放开」）。`resolveTarget()` 只做 `~` 展开 +
  词法 `resolve()`，**无 `realpath`、无 `isWithin`、无 403**。`/sidebar/*` 唯一准入是
  `ctx.connection.requestRejection(req)`（`src/index.ts:1442`），那是"浏览器可信"而非路径边界；
- 因此任何通过 Host 认证的浏览器请求可读/写/递归删/打包下载主机用户可达的任意路径
  （`~`、盘符绝对路径、UNC、WSL、remote mirror 全支持）；
- 上传、下载、`/sidebar/file`、`/sidebar/html` 走流式且**刻意不设大小上限**；
- `htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe` 可让 HTML 预览脱离 opaque-origin 沙箱，
  `customCss` 可注入任意 CSS；`open.external` 允许任意自定义 scheme 交给 OS handler。

本次内置**不改上游默认**（与前两个插件一致，不擅自改变产品行为）：
`agentOpenTools` / `htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe` 上游默认都是 `false`，
是相对安全的起点；但**路径围栏本身没有开关**，这是需要产品侧单独决策的部署前提。
收紧手段与真机核对清单都写在这里，不要当成"装了就完事"。

### 与 VsSaros UI 的冲突面（真机必验）

固定 `/sidebar/*` 路由前缀、`betterSidebar` 服务名、`settings.section(.icon)` 固定 id
`better-sidebar`、抢占宿主内建 `files` kind 与 `dsh-resource://file/**`、
`conversation.session.header.utilities` slot、起始页 `sidebar.right.tab.guide` 接管。
插件自身已用 `aionui-panel` 互斥、`settings.configure({auto:false})`、注册失败回滚 +
诊断条处理三类已知冲突，但与本仓 `vssaros-chat-surface` / `vssaros-workbenches` 等
自绘页面的组合**必须 F5 真机验一次**。

## 守卫豁免（每条都有理由，且不是静默跳过）

- `check-plugin-files.mjs`「入口真的能 import」与 `dshPluginPackages.test.ts`
  「Host 入口必须能被加载」：`lib/index.js` 静态 import `ws` / `yaml` /
  `@deepseek-ai/schemastery`，只有 dsh Host 的 module loader / profile `node_modules`
  解析得到 ⇒ 离线 import 必然失败。守卫改判「入口仍是上游打包形态」（逐条核对字面量）。
- `dshPluginPackages.test.ts`「Slot 目录比对」：客户端注入 `settings.section` /
  `sidebar.right.pane.tab` 等属于上游自己的宿主契约，用本仓运行时目录判会假红 ⇒
  改判 `dsh.client.inject` 里的前置包仍在。
- `check-spawn-hide.mjs`：上游 `lib/index.js` 起 `git` / `zip` / 外部程序，是否隐藏由上游
  按平台决定，我们承诺不改字节 ⇒ 按目录整体豁免并打印一行；自研插件仍逐处受检。
- `check-theme-hardcodes.mjs` 与 `dshPluginPackages.test.ts`「`--vscode-*` 主色令牌」：
  `lib/client*.js` 有自己的主题体系，终端卡沿用 xterm 的 `--vscode-*` 主题变量，不跟本仓
  `--dsw-alias-*` 令牌走 ⇒ 按目录整体豁免（前者打印一行），自研客户端卡仍逐行受检。
- `dshPluginPackages.test.ts` 的 `./client` 成对断言与 Host 入口排除：上游把
  `exports["./client"]` 写成 `{ types, default }` **条件导出对象**（合法形态，前两个
  vendored 包用的是字符串）。这轮把守卫的 `clientEntryOf()` 改成兼容两种形态，属于
  **通用修复**而不是给本包开特例；不修的话 client 入口会被误当 Host 入口去离线 import。
- `check-dsw-tokens.mjs`：三个 vendored client 引用的 `--dsw-alias-accent*` /
  `--dsw-alias-label-*` 等 alias 在本仓 0.2.2-rc.2 主题白名单里不存在，上游会走自己的
  回退色 ⇒ 按目录整体豁免并打印一行（顺带清掉前两个包遗留的同型误报）。
- `tools-snapshot.mjs`：目录名不带 `vssaros-` 前缀且工具面依赖 Host 服务 ⇒ 不进
  `tools-snapshot.json`（理由写在那个脚本的扫描处）。

⚠ 上面 `check-dsw-tokens` 那条不只是守卫噪音：本包 `lib/client*.js` 用到的
`--dsw-alias-accent-soft` / `--dsw-alias-accent` / `--dsw-alias-accent-ink` /
`--dsw-alias-button-info-label` 在**本仓 0.2.2-rc.2 主题里确实没有**，运行时会退化到
上游自带的回退色。若真机上出现配色不一致，需由上游适配或在本仓主题里补同名 alias，
不要靠改 vendored 字节解决。

## 许可与署名

插件本体 MIT（`LICENSE`）；第三方运行时的许可随各自 npm 包分发。
`locale/*.json` 只是插件页展示元数据（`meta.title/description/detail`），**不是 UI 字典**；
UI 文案内嵌在 `lib/client.js`（zh/en）与 `lib/client-locale.js`（19 语言 lazy chunk）。

## 升级流程

1. `npm pack dsh-better-sidebar@<新版本>`，用发布包内容覆盖本目录（保留 `VENDOR.md`）；
2. 按上面「本地对上游包做的改动」重新收敛 `package.json`；
3. 核对新版本的 `engines.dsh` / peer 支持线与本仓 `dsh-compat.json` 的 `bundled`
   是否仍匹配（上游按宿主版本精确钉版，不能只看 `latest`）；
4. 同步 `VENDORED_THIRD_PARTY` 的 `version`、`VENDOR.md` 版本号；
5. 跑 `npm run check:dsh-plugins`、`node build/saros/check-dsh-release.mjs`，
   **重建一次 profile 种子**（依赖树变了必须重烘）；
6. F5 真机核对：启动日志出现 `dsh-better-sidebar` 安装行、`profile bundles` 里有它、
   右栏 tab 与底部工作台都只挂载一次、起始页不出现两个 guide、文件树能开文件；
   并复核上面「安全与权限」「冲突面」两节。
