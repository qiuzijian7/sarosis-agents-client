# VsSaros 快速部署指南

本指南帮助你在服务器 `zijianqiu-any1.devcloud.woa.com` 上快速部署 VsSaros 更新服务器。

## 前提条件

- 服务器 `zijianqiu-any1.devcloud.woa.com` 已安装 Node.js 18+
- 你有服务器的 SSH 或 RDP 访问权限

## 部署步骤

### 步骤 1: 上传更新服务器代码

#### 方式 A: 使用 SCP (Linux)

```bash
# 在本地执行
scp -r deploy-package/update-server/ root@zijianqiu-any1.devcloud.woa.com:/opt/vssaros-update/
```

#### 方式 B: 使用 PowerShell (Windows 服务器)

```powershell
# 在服务器上执行
New-Item -ItemType Directory -Force -Path C:\vssaros-update
# 然后手动复制 deploy-package\update-server\ 到 C:\vssaros-update\
```

### 步骤 2: 在服务器上启动更新服务器

#### Linux (推荐用 PM2)

```bash
# SSH 登录服务器
ssh root@zijianqiu-any1.devcloud.woa.com

# 进入更新服务器目录
cd /opt/vssaros-update/update-server

# 安装 PM2 (如果未安装)
npm install -g pm2

# 启动更新服务器 (端口 3030)
PORT=3030 pm2 start server.mjs --name vssaros-update

# 查看日志
pm2 logs vssaros-update

# 测试服务
curl http://localhost:3030/health
```

#### Windows (直接运行)

```powershell
# RDP 登录服务器
cd C:\vssaros-update\update-server
$env:PORT=3030
node server.mjs
```

### 步骤 3: 配置防火墙

确保端口 3030 对外开放：

#### Linux (iptables)
```bash
iptables -A INPUT -p tcp --dport 3030 -j ACCEPT
# 或使用 firewalld
firewall-cmd --permanent --add-port=3030/tcp
firewall-cmd --reload
```

#### Windows Firewall
```powershell
New-NetFirewallRule -DisplayName "VsSaros Update Server" -Direction Inbound -Protocol TCP -LocalPort 3030 -Action Allow
```

### 步骤 4: 测试更新服务器

在本地浏览器或命令行测试：

```bash
# 测试健康检查
curl http://zijianqiu-any1.devcloud.woa.com:3030/health

# 测试更新 API (使用一个假的 commit)
curl http://zijianqiu-any1.devcloud.woa.com:3030/api/update/win32-x64-user/saros/0000000000000000000000000000000000000000
```

预期响应 (JSON):
```json
{
  "version": "...",
  "productVersion": "0.0.0",
  "url": "https://...",
  "sha256hash": "",
  "timestamp": 0
}
```

### 步骤 5: 构建 VsSaros 安装包 (可选，如需发布新版本)

在本地 `saros-agents-client` 目录执行：

```powershell
# 1. 修复品牌配置
npm run fix-branding

# 2. 更新 product.json 中的 updateUrl (改为 http://zijianqiu-any1.devcloud.woa.com:3030)

# 3. 构建安装包
npm run gulp vscode-win32-x64-user-setup

# 4. 安装包位于: .build\win32-x64\user-setup\VsSarosUserSetup.exe
```

### 步骤 6: 上传安装包并更新 manifest.json

1. 将安装包上传到服务器或 GitHub Releases
2. 更新 `update-server/manifest.json` 中的版本信息
3. 重启更新服务器: `pm2 restart vssaros-update`

## 验证部署

部署成功后，你应该能够：

1. **访问更新服务器健康检查**: `http://zijianqiu-any1.devcloud.woa.com:3030/health`
   - 预期响应: `{"ok":true,"service":"vssaros-update-server","mode":"manifest"}`

2. **访问更新 API**: `http://zijianqiu-any1.devcloud.woa.com:3030/api/update/win32-x64-user/saros/0000000000000000000000000000000000000000`
   - 预期响应: JSON 包含版本信息

3. **客户端自动检测更新** (安装并运行 VsSaros 后)
   - 客户端每小时检查一次更新
   - 或手动触发: Help > Check for Updates

## 故障排查

### 更新服务器无法启动

```bash
# 检查端口占用
netstat -tlnp | grep 3030  # Linux
netstat -an | findstr 3030  # Windows

# 查看 PM2 日志
pm2 logs vssaros-update

# 手动启动测试
cd /opt/vssaros-update/update-server
node server.mjs
```

### 无法访问更新服务器

- 检查服务器防火墙设置
- 检查安全组/网络ACL设置
- 使用 `telnet zijianqiu-any1.devcloud.woa.com 3030` 测试端口连通性

### manifest.json 配置错误

确保 `manifest.json` 格式正确：
```json
{
  "win32-x64-user": {
    "version": "<40位git commit sha>",
    "productVersion": "1.0.0",
    "url": "http://zijianqiu-any1.devcloud.woa.com:3030/downloads/VsSarosUserSetup.exe",
    "sha256hash": "<sha256哈希>",
    "timestamp": 1700000000000
  }
}
```

## 下一步

部署完成后，你可以：

1. **构建并发布新版本** - 参考 `DEPLOYMENT_GUIDE.md`
2. **配置 CI/CD 自动化** - 自动构建、上传、更新 manifest
3. **监控更新服务器** - 使用 PM2 监控、日志查看

## 文件清单

本部署包包含：

```
deploy-package/
├── QUICK_START.md              # 本文件 - 快速开始指南
├── DEPLOYMENT_GUIDE.md         # 完整部署指南
├── update-server/              # 更新服务器代码
│   ├── server.mjs            # Node.js 更新服务器
│   ├── manifest.json         # 版本清单 (需更新)
│   └── worker.js             # Cloudflare Worker 版本 (可选)
└── scripts/                   # 辅助脚本
    ├── deploy-update-server.ps1   # 部署更新服务器
    ├── build-installer.ps1        # 构建安装包
    └── update-manifest.ps1        # 更新 manifest.json
```

## 需要帮助？

- 查看 `DEPLOYMENT_GUIDE.md` 获取详细步骤
- 查看 `update-server/` 目录中的代码和注释
- 检查更新服务器日志: `pm2 logs vssaros-update`
