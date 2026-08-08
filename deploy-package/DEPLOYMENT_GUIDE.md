# VsSaros 完整部署指南

本指南将引导你完成 VsSaros 的完整部署，包括更新服务器搭建和热更升级配置。

## 架构概述

```
[客户端 VsSaros]
    |
    | 每小时检查更新
    v
[更新服务器 http://zijianqiu-any1.devcloud.woa.com:3030]
    |
    | 返回更新信息 (版本、下载URL、SHA256)
    v
[下载服务器 / GitHub Releases]
    |
    | 下载安装包
    v
[客户端后台下载并应用更新]
```

## 部署步骤

### 步骤 1: 准备更新服务器

#### 1.1 上传更新服务器代码到目标服务器

将 `deploy-package/update-server/` 目录上传到服务器 `zijianqiu-any1.devcloud.woa.com` 的 `/opt/vssaros-update/` 目录。

**方式 A: 使用 SCP (Linux服务器)**
```bash
scp -r deploy-package/update-server/ root@zijianqiu-any1.devcloud.woa.com:/opt/vssaros-update/
```

**方式 B: 使用 PowerShell (Windows服务器)**
```powershell
# 在服务器上创建目录并复制文件
New-Item -ItemType Directory -Force -Path C:\vssaros-update
Copy-Item -Recurse -Force deploy-package\update-server C:\vssaros-update\
```

#### 1.2 在服务器上启动更新服务器

**Linux (使用 PM2):**
```bash
ssh root@zijianqiu-any1.devcloud.woa.com
cd /opt/vssaros-update/update-server

# 安装 PM2 (如果未安装)
npm install -g pm2

# 启动更新服务器
PORT=3030 pm2 start server.mjs --name vssaros-update

# 查看日志
pm2 logs vssaros-update

# 测试服务
curl http://localhost:3030/health
```

**Windows (直接运行):**
```powershell
cd C:\vssaros-update\update-server
$env:PORT=3030
node server.mjs
```

#### 1.3 配置防火墙

确保服务器防火墙允许端口 3030 的入站连接：

**Linux (iptables):**
```bash
iptables -A INPUT -p tcp --dport 3030 -j ACCEPT
```

**Windows Firewall:**
```powershell
New-NetFirewallRule -DisplayName "VsSaros Update Server" -Direction Inbound -Protocol TCP -LocalPort 3030 -Action Allow
```

### 步骤 2: 构建 VsSaros 安装包

#### 2.1 修复品牌配置

在本地 `saros-agents-client` 目录执行：

```powershell
cd g:\CustomWorkspaces\AIProjects\saros-agents-client
npm run fix-branding
```

#### 2.2 更新 product.json 中的 updateUrl

编辑 `product.json`，将 `updateUrl` 改为你的更新服务器地址：

```json
"updateUrl": "http://zijianqiu-any1.devcloud.woa.com:3030"
```

#### 2.3 构建安装包

```powershell
# 构建用户级安装包 (推荐)
npm run gulp vscode-win32-x64-user-setup

# 或构建系统级安装包
npm run gulp vscode-win32-x64-system-setup
```

构建完成后，安装包位于：
- 用户级: `.build\win32-x64\user-setup\VsSarosUserSetup.exe`
- 系统级: `.build\win32-x64\system-setup\VsSarosSetup.exe`

### 步骤 3: 上传安装包

#### 方式 A: 上传到更新服务器 (简单方式)

将安装包上传到更新服务器，通过更新服务器提供下载：

```bash
# 在更新服务器上创建 downloads 目录
mkdir -p /opt/vssaros-update/downloads

# 上传安装包
scp .build\win32-x64\user-setup\VsSarosUserSetup.exe root@zijianqiu-any1.devcloud.woa.com:/opt/vssaros-update/downloads/
```

#### 方式 B: 上传到 GitHub Releases (推荐用于公开分发)

1. 在 GitHub 上创建新的 Release
2. 上传安装包作为 Release Asset
3. 在 Release 描述中添加 `commit: <完整git commit sha>`

### 步骤 4: 更新 manifest.json

更新 `deploy-package/update-server/manifest.json` (或服务器上的 `/opt/vssaros-update/update-server/manifest.json`)：

```json
{
  "win32-x64-user": {
    "version": "<完整的git commit sha>",
    "productVersion": "1.0.0",
    "url": "http://zijianqiu-any1.devcloud.woa.com:3030/downloads/VsSarosUserSetup.exe",
    "sha256hash": "<安装包的sha256哈希>",
    "timestamp": 1700000000000
  }
}
```

**计算 SHA256 哈希:**
```powershell
Get-FileHash .build\win32-x64\user-setup\VsSarosUserSetup.exe -Algorithm SHA256
```

### 步骤 5: 重启更新服务器

```bash
# Linux (PM2)
pm2 restart vssaros-update

# Windows
# Ctrl+C 停止，然后重新运行 node server.mjs
```

### 步骤 6: 测试热更新

#### 6.1 测试更新服务器 API

```bash
# 测试健康检查
curl http://zijianqiu-any1.devcloud.woa.com:3030/health

# 测试更新检查 API (使用一个假的 commit)
curl http://zijianqiu-any1.devcloud.woa.com:3030/api/update/win32-x64-user/saros/0000000000000000000000000000000000000000
```

应该返回 JSON：
```json
{
  "version": "...",
  "productVersion": "1.0.0",
  "url": "http://...",
  "sha256hash": "...",
  "timestamp": ...
}
```

#### 6.2 安装并测试客户端

1. 在安装包机器上运行 `VsSarosUserSetup.exe` 安装 VsSaros
2. 打开 VsSaros
3. 等待约 1 小时，或手动触发更新检查（通过帮助菜单）
4. 应该看到更新提示，后台下载并安装更新

## 日常维护

### 发布新版本

1. **构建新版本安装包**
   ```powershell
   npm run gulp vscode-win32-x64-user-setup
   ```

2. **上传安装包到下载服务器**

3. **更新 manifest.json**
   - 更新版本号、URL、SHA256
   - 重启更新服务器

4. **客户端自动检测并更新**
   - 客户端每小时检查一次更新
   - 检测到新版本后后台下载
   - 下次重启时应用更新

### 回滚版本

如果需要回滚到旧版本：

1. 更新 `manifest.json`，将版本信息改回旧版本
2. 重启更新服务器
3. 客户端将检测到"更新"（实际上是回滚）

## 故障排查

### 更新服务器无法启动

- 检查端口 3030 是否被占用: `netstat -an | grep 3030`
- 检查 Node.js 是否安装: `node --version`
- 查看日志: `pm2 logs vssaros-update`

### 客户端无法检测更新

- 检查 `product.json` 中的 `updateUrl` 是否正确
- 检查客户端日志 (Help > Toggle Developer Tools > Console)
- 手动测试更新 API: `curl http://zijianqiu-any1.devcloud.woa.com:3030/api/update/...`

### 更新下载失败

- 检查安装包 URL 是否可访问
- 检查 SHA256 哈希是否正确
- 检查服务器防火墙设置

## 附录: 自动化脚本

本部署包包含以下自动化脚本：

- `scripts/deploy-update-server.ps1` - 部署更新服务器
- `scripts/build-installer.ps1` - 构建安装包
- `scripts/update-manifest.ps1` - 更新 manifest.json

使用方法见各脚本内的注释。
