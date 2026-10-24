# dsh-plugins 约定（插件开发 / 生效 / 排查）

本目录是 **dsh 插件的源码真源**（包名 `@vssaros/dsh-*`）。页面与 Host 运行的**不是**这里，
而是被安装进 profile 的那份副本 —— 所以「改完为什么没生效」几乎是必踩的一关。

本文把链路、两条生效通道、硬规则和排查表钉在这里。**改动本目录前先读第 3、4 节。**

---

## 1. 四层位置（从源码到运行）

| 层 | 路径 | 谁读它 |
|---|---|---|
| ① 源码 | `dsh-plugins/<pkg>/`（本目录） | 你 |
| ② 暂存 | `~/.vssaros-dev/dsh-home/profiles/<profile>/.vssaros/plugins/<pkg>-<版本>-<入口指纹>/` | 安装前的中间副本 |
| ③ 安装态 | `<profile>/node_modules/@vssaros/dsh-*` | **Host / 页面真正加载** |
| ④ 运行时 | `~/.vssaros-dev/dsh-runtime/<ver>/node_modules/@deepseek-ai/dsh/lib/bin.js` | 官方 CLI / 静态资源服务 |

- profile 名：开发机为 `vssaros`（`$DSH_HOME = ~/.vssaros-dev/dsh-home`）。
- ③ 的声明形式是 `file:<②的绝对路径>`（见 profile 的 `package.json`）。
- 前端 chunk 由 `@deepseek-ai/dsh-client-modules` 提供，URL 形如
  `/plugins/@vssaros/<pkg>/client.*.js?rev=<12位>`。

## 2. 前端入口与 chunk 约定

- 入口由 `package.json` 的 `exports["./client"]` 指定（本仓一律 `./lib/client.js`）。
- `lib/client.js` 只做注册（`registerNavItem` / `registerWorkbench` …），UI 拆到
  `lib/client.<name>.js` 等 chunk 里，按需动态 import。
- **一个插件所有 chunk 共用入口的 `?rev`**，`rev = sha1(入口 lib/client.js 的 mtimeMs, ctimeMs, size)[:12]`，
  响应头是 `cache-control: public, max-age=31536000, immutable`。
  ⇒ 入口文件元数据不变 = URL 不变 = 浏览器**永远**给旧 chunk（重启也没用）。
- 服务端插件（无 `exports["./client"]`，如 `vssaros-marketplace`）没有 rev 问题，改完重启即读。

## 3. 两条生效通道

### A. 官方通道（pnpm）——提交前必走

```powershell
# 1) 给「内容有差异」的插件自动 +1 补丁版本（不复制文件）
node scripts/dsh-plugin-deploy.mjs --bump
# 2) F5 启动：主进程 _ensurePlugin 判定版本不一致
#    ⇒ 暂存到 ② + `dsh plugin add file:…`（一条命令装多个）
#    ⇒ pnpm 同步 node_modules / pnpm-lock.yaml / dsh.profile.bundles
```

官方等价的单插件手动命令：

```powershell
node "$env:USERPROFILE\.vssaros-dev\dsh-runtime\0.2.1-rc.1\node_modules\@deepseek-ai\dsh\lib\bin.js" `
     plugin --profile vssaros add file:G:/SarosWorkspace/sarosis-agents-client/dsh-plugins/vssaros-chat-surface
```

先例与依据（都在仓库里）：`src/vs/sessions/contrib/dshHarness/common/dshCli.ts:39-71`、
`electron-main/dshHostSupervisor.ts:2268-2285`（暂存 + 指纹）、`dsh-plugins/vssaros-mcp/bin/sync-rows.mjs:9-12`。

### B. 开发快通道（毫秒级）——只用于高频迭代

```powershell
node scripts/dsh-plugin-deploy.mjs --changed     # 直接复制差异文件进 ③，并强制刷新入口 mtime
```

F5 用的 `scripts/start-dev-app.mjs` **每次启动都会自动跑 `--changed`**，所以日常「改完按 F5」就够了。

**它会在版本不一致时自动让路**：一旦发现仓库版本 ≠ 已装版本，就跳过复制并打印
`⇒ 交给官方安装（F5 时暂存 + dsh plugin add）`，把安装交回通道 A（否则锁文件会永久漂移）。

## 4. 两条硬规则

### 规则 1：改了内容就要 bump 版本（通道 A 的前提）

`dsh plugin add` 收到的是 `file:<暂存目录>`。**版本没变 ⇒ spec 路径逐字不变 ⇒ pnpm 认为依赖没变化 ⇒
一个字节都不替换**（真机事故记录见 `dshHostSupervisor.ts:2275-2281`）。这就是为什么仓库给暂存目录
加了「入口内容指纹」，也是为什么 **bump 版本一直有效**。

- 补丁位 +1（`0.2.150` → `0.2.151`），预发布后缀原样保留（`1.2.3-rc.1` → `1.2.4-rc.1`）。
- `--bump` 只改**仓库** `package.json`，**故意不复制文件** —— 复制了就等于让 profile 版本追平仓库版本，
  官方会判「已是最新」而跳过。

### 规则 2：插件代码改动必须重启 Host（HMR 不管插件代码）

官方 README（`@deepseek-ai/dsh`）：`dsh-hmr` 监视的是 **profile manifest / profile 与 home 级 patch 文件**，
「**未启用 HMR 时，更改在重启后生效**」。所以：

- 改 `cordis.patch.yml` / `cordis.presets.yml` 这类**配置** ⇒ 可能热生效；
- 改 `lib/*.js` 这类**代码** ⇒ 必须重启（F5 重启整个 app 即可）。

## 5. 常用命令速查

| 命令 | 作用 |
|---|---|
| `node scripts/dsh-plugin-deploy.mjs --changed` | 快通道同步 + 刷 rev（启动器自动跑） |
| `node scripts/dsh-plugin-deploy.mjs --bump [--dry]` | 给有差异的插件 bump 补丁版本（提交前） |
| `node scripts/dsh-plugin-deploy.mjs --verify` | 只打印每个插件当前应有的 `?rev`，不写盘 |
| `node scripts/dsh-plugin-deploy.mjs <pkg>...` | 只处理指定插件 |
| `npm run check:dsh-plugins` | 全部插件守卫（含本目录各 `check-*.mjs`） |

相关开关（VS Code 设置）：

- `sessions.dshHarness.skipPluginInstall`（默认 `false`）：`true` 时**启动不升级**随包插件（省 N×2s，
  但改完插件必须走通道 A 或插件中心的「安装/升级」，否则永远跑旧版本）。
- Host 需要重启才吃新代码（见规则 2）。

## 6. 排查表：改了没生效

| 症状 | 最可能原因 | 处理 |
|---|---|---|
| F5 后界面完全是旧样子 | 只改了 ①，没进 ③ | 跑 `--changed`（或 bump 后走官方通道） |
| 代码已进 ③，界面还是旧的 | 入口 `client.js` 元数据没变 ⇒ `?rev` 不变 ⇒ 浏览器吃 `immutable` 缓存 | 用 `--changed`（会强制刷入口 mtime）；或 bump 版本走官方通道 |
| `--changed` 打印「交给官方安装」 | 仓库版本 ≠ 已装版本（正常让路） | F5 一次，让 `_ensurePlugin` 装；或手动 `dsh plugin add` |
| 官方通道跑了但代码没换 | 版本没 bump ⇒ pnpm 视为无变化 | `--bump` 后再装 |
| 插件中心显示已装，功能却缺 | 版本同、内容不同（历史遗留漂移） | `--bump` + F5；必要时删掉 ② 里旧版本目录 |
| 改的是服务端插件，无 `exports["./client"]` | 无 rev 机制 | 重启 Host 即读新文件 |
| 页面报 chunk 404 / 白屏 | 入口路径与 `exports["./client"]` 不一致 | 检查 `package.json` 的 `exports` 与实际文件 |

查看证据：

- 启动器日志 `~/.vssaros-dev/logs/app-exit.log`：`PLUGIN <pkg> <profile> files=N rev A -> B`（A≠B 才会失效缓存）、
  `LAUNCHJSON synced …`、`READY debug=<port>`。
- Host / 窗口日志：`~/.vssaros-dev/logs/<时间戳>/main.log`（含插件安装与版本审计行）。
- 页面里：`performance.getEntriesByType('resource')` 过滤 `/plugins/`，看 `?rev` 是否变化。

## 7. 提交前 checklist

1. `npm run check:dsh-plugins` 全绿；
2. `node scripts/dsh-plugin-deploy.mjs --bump` 把动过的插件版本 +1；
3. F5 一次，确认启动日志里出现对应的安装行（官方通道），且页面 `?rev` 已变；
4. 提交：`dsh-plugins/<pkg>/package.json` 的版本变更要一起提交（否则别人拉下来会装不上新内容）。
