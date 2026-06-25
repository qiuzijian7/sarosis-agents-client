# VsSarosis 打包与热更新

本目录是 VsSarosis 品牌固化 + 自动热更新的配套工具集。

## 目录结构

```
build/saros/
├── verify-product-branding.mjs    # 品牌校验/修复脚本（打包前必跑）
└── update-server/
    ├── server.mjs                 # 本地 Update Feed 服务（零依赖 Node）
    ├── worker.js                  # Cloudflare Worker 版（Serverless 部署）
    ├── gen-manifest.mjs           # 发版辅助：算 sha256 + 写 manifest
    └── manifest.json              # 本地模式的版本清单
```

---

## 一、品牌校验脚本

`product.json` 的品牌字段容易被 git 操作或上游构建脚本还原成 `Code - OSS`，
并把 AppId 写成单大括号格式 → 打出错误品牌 / Inno Setup `Unknown constant` 报错。

打包前务必运行：

```bash
npm run verify-branding     # 仅检测，不一致退出码 1（适合 CI / 打包前置）
npm run fix-branding        # 检测并自动修复所有品牌字段
```

校验的字段基准定义在脚本顶部的 `EXPECTED`，包含：
- 全部 VsSarosis 命名字段（nameShort / applicationName / dataFolderName ...）
- 4 个**双大括号** AppId（system + user × x64 + arm64）
- 热更新字段 `quality: "saros"`

---

## 二、打包安装包

源构建产物位于**仓库父目录** `../VSCode-win32-x64/`（不在 .build 内）。

```bash
# 系统级安装包 → .build/win32-x64/system-setup/VsSarosisSetup.exe
npm run gulp vscode-win32-x64-system-setup

# 用户级安装包（免管理员权限）→ .build/win32-x64/user-setup/VsSarosUserSetup.exe
npm run gulp vscode-win32-x64-user-setup
```

> `code.iss` 已改为根据 InstallTarget 区分输出名：
> user → `VsSarosUserSetup.exe`，system → `VsSarosisSetup.exe`，两者不再互相覆盖。

| 维度 | 系统级 (system) | 用户级 (user) |
|------|----------------|---------------|
| 安装路径 | `C:\Program Files\VsSarosis` | `%LOCALAPPDATA%\Programs\VsSarosis` |
| 权限 | 需要管理员 | 普通用户即可 |
| AppId | `win32x64AppId` | `win32x64UserAppId` |
| 更新平台串 | `win32-x64` | `win32-x64-user` |

---

## 三、自动热更新

### 工作原理

客户端每小时请求：

```
GET {updateUrl}/api/update/{platform}/{quality}/{commit}
```

- `updateUrl` ← product.json
- `platform` ← 自动推断（如 `win32-x64-user`）
- `quality`  ← product.json 的 `quality`（本项目为 `saros`）
- `commit`   ← 客户端当前 commit

服务端响应：
- **有更新** → `200` + JSON：`{ version, productVersion, url, sha256hash, timestamp }`
  - `version` = 新版本 commit（客户端用它和自身 commit 比较）
  - `url` = 安装包下载直链
- **无更新** → `204 No Content`

客户端拿到后会**后台静默下载**安装包，下次重启时由 `inno_updater.exe` 应用更新。

### product.json 配置（已写入）

```json
"quality": "saros",
"updateUrl": "https://vssaros-update.example.workers.dev"
```

> ⚠️ `updateUrl` 当前是**占位地址**，部署服务后改成真实地址即可。
> ⚠️ `quality` 不要用 `stable`/`insider`，否则 `code.iss` 会触发 appx 打包分支导致编译失败。

### 部署方式 A：Cloudflare Worker（推荐，免运维）

```bash
npm i -g wrangler
cd build/saros/update-server
# 创建 wrangler.toml（见 worker.js 顶部注释）
wrangler deploy
# 把得到的 URL 写入 product.json 的 updateUrl
```

数据源是 GitHub Releases：发版时上传 `VsSarosUserSetup.exe` / `VsSarosisSetup.exe` 到 release，
并在 release body 写一行 `commit: <40位完整sha>`（可选 `sha256-win32-x64-user: <hash>`）。

### 部署方式 B：本地 / 自托管 Node 服务

```bash
# 本地清单模式（默认）
node build/saros/update-server/server.mjs

# GitHub Releases 模式
GH_REPO=qiuzijian7/saros-agents-client node build/saros/update-server/server.mjs

# 私有仓库
GH_REPO=owner/repo GH_TOKEN=ghp_xxx node build/saros/update-server/server.mjs
```

### 发版流程（本地清单模式）

```bash
# 1. 打包新版本
npm run gulp vscode-win32-x64-user-setup

# 2. 把 exe 上传到你的下载服务器 / GitHub Release

# 3. 生成 manifest 条目（自动算 sha256 + 读当前 git commit）
node build/saros/update-server/gen-manifest.mjs \
  --platform win32-x64-user \
  --exe ".build/win32-x64/user-setup/VsSarosUserSetup.exe" \
  --version 1.2.3 \
  --url "https://your-host/VsSarosUserSetup-1.2.3.exe"

# 4. 重启/部署 update server，旧客户端即可检测到更新
```

### 为什么 git 仓库地址不能直接当 updateUrl

VS Code 客户端要求服务端做**版本比较逻辑**（拿请求 URL 里的 commit 和最新版比），
并返回特定 JSON。纯 git/静态托管做不了这个判断。
正确做法：**GitHub Releases 托管 exe + 一个极薄 feed 服务（Worker/Node）做比较** —— 即本目录的方案。
