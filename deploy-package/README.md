# VsSarosis 热更部署包

本目录包含部署 VsSarosis 更新服务器所需的文件。

## 目录结构

```
deploy-package/
├── README.md                    # 本文件
├── update-server/               # 更新服务器代码
│   ├── server.mjs              # Node.js 更新服务器
│   ├── manifest.json           # 版本清单（需更新）
│   └── package.json            # 依赖配置
├── scripts/
│   ├── deploy-update-server.sh # 部署更新服务器脚本
│   ├── build-and-deploy.sh    # 构建并部署完整流程
│   └── update-manifest.sh     # 更新 manifest.json 脚本
└── config/
    └── nginx.conf              # Nginx 反向代理配置（可选）
```

## 快速开始

### 1. 准备工作

确保目标服务器 (21.91.41.66) 已安装：
- Node.js 18+ 
- npm
- (可选) Nginx 用于反向代理

### 2. 部署更新服务器

```bash
# 在目标服务器上执行
cd /opt/vssarosis-update

# 安装依赖
npm install

# 启动服务器 (使用 PM2 或 systemd 管理进程)
node update-server/server.mjs
```

### 3. 构建安装包

在本地构建 VsSarosis 安装包：

```bash
cd /d g:\CustomWorkspaces\AIProjects\sarosis-agents-client

# 修复品牌配置
npm run fix-branding

# 构建用户级安装包
npm run gulp vscode-win32-x64-user-setup

# 输出: .build/win32-x64/user-setup/VsSarosisUserSetup.exe
```

### 4. 上传安装包

将构建好的 `VsSarosisUserSetup.exe` 上传到更新服务器的下载目录或 GitHub Releases。

### 5. 更新 manifest.json

更新 `update-server/manifest.json` 文件，填入正确的版本信息：

```json
{
  "win32-x64-user": {
    "version": "<完整的git commit sha>",
    "productVersion": "1.0.0",
    "url": "http://21.91.41.66:3030/downloads/VsSarosisUserSetup.exe",
    "sha256hash": "<exe文件的sha256哈希>",
    "timestamp": 1700000000000
  }
}
```

### 6. 更新 product.json

在源代码中更新 `product.json` 的 `updateUrl` 字段：

```json
"updateUrl": "http://21.91.41.66:3030"
```

然后重新构建安装包（使客户端包含正确的更新地址）。

## 热更新工作流程

1. **客户端启动** → 每小时检查更新
2. **请求更新服务器** → `GET http://21.91.41.66:3030/api/update/win32-x64-user/sarosis/<commit>`
3. **服务器响应** → 返回新版本信息或 204（无更新）
4. **客户端下载** → 后台静默下载新版本安装包
5. **应用更新** → 下次重启时由 `inno_updater.exe` 应用更新

## 维护命令

```bash
# 查看更新服务器日志
pm2 logs vssarosis-update

# 重启更新服务器
pm2 restart vssarosis-update

# 检查服务器健康状态
curl http://21.91.41.66:3030/health
```
