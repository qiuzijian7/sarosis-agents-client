# VsSaros 部署下一步操作

## 🎉 已完成的工作

### 1. ✅ 构建完成
- **安装包**: `G:\CustomWorkspaces\AIProjects\saros-agents-client\.build\win32-x64\user-setup\VsSarosUserSetup.exe`
- **大小**: 158.25 MB
- **SHA256**: `3369FEE8E9E7209946EA19F556261632EB23BDC1097D2A7DC54EC20B72F52595`
- **Git Commit**: `d7440c06c8f7d55c9b3ffd5b234b84e91a4b4da3`
- **版本**: 1.120.0

### 2. ✅ 更新服务器准备完成
- **代码位置**: `deploy-package/update-server/`
- **manifest.json 已更新**: 包含正确的版本信息和下载URL
- **部署脚本就绪**: `deploy-package/scripts/`

### 3. ✅ 文档齐全
- `QUICK_START.md` - 快速开始指南
- `DEPLOYMENT_GUIDE.md` - 完整部署指南
- `README.md` - 部署包说明

## 🚀 下一步操作（3个选项）

### 选项 A: 手动部署到服务器 zijianqiu-any1.devcloud.woa.com（推荐）

#### A1. 上传更新服务器代码到服务器

```bash
# 方式 1: 使用 SCP (Linux服务器)
scp -r deploy-package/update-server/ root@zijianqiu-any1.devcloud.woa.com:/opt/vssaros-update/

# 方式 2: 先压缩再上传（如果SCP慢）
# 在本地压缩
Compress-Archive -Path deploy-package\update-server -DestinationPath update-server.zip
# 然后上传 update-server.zip 到服务器并解压
```

#### A2. 在服务器上启动更新服务器

```bash
# SSH 登录服务器
ssh root@zijianqiu-any1.devcloud.woa.com

# 进入目录
cd /opt/vssaros-update/update-server

# 安装 PM2 (如果未安装)
npm install -g pm2

# 启动更新服务器
PORT=3030 pm2 start server.mjs --name vssaros-update

# 查看日志确认启动成功
pm2 logs vssaros-update

# 测试服务
curl http://localhost:3030/health
```

**预期响应**:
```json
{"ok":true,"service":"vssaros-update-server","mode":"manifest"}
```

#### A3. 配置防火墙

确保端口 3030 可访问：

```bash
# Linux (firewalld)
firewall-cmd --permanent --add-port=3030/tcp
firewall-cmd --reload

# 测试外部访问（在本地执行）
curl http://zijianqiu-any1.devcloud.woa.com:3030/health
```

#### A4. 上传安装包到更新服务器

```bash
# 在服务器上创建 downloads 目录
ssh root@zijianqiu-any1.devcloud.woa.com "mkdir -p /opt/vssaros-update/downloads"

# 上传安装包
scp "G:\CustomWorkspaces\AIProjects\saros-agents-client\.build\win32-x64\user-setup\VsSarosUserSetup.exe" root@zijianqiu-any1.devcloud.woa.com:/opt/vssaros-update/downloads/VsSarosUserSetup.exe
```

#### A5. 验证部署

在浏览器或命令行测试：

```bash
# 测试更新 API
curl "http://zijianqiu-any1.devcloud.woa.com:3030/api/update/win32-x64-user/saros/0000000000000000000000000000000000000000"
```

**预期响应**:
```json
{
  "version": "d7440c06c8f7d55c9b3ffd5b234b84e91a4b4da3",
  "productVersion": "1.120.0",
  "url": "http://zijianqiu-any1.devcloud.woa.com:3030/downloads/VsSarosUserSetup.exe",
  "sha256hash": "3369FEE8E9E7209946EA19F556261632EB23BDC1097D2A7DC54EC20B72F52595",
  "timestamp": 1717372800000
}
```

---

### 选项 B: 使用 AnyDev 自动部署（需修复 AnyDev）

如果 AnyDev 环境问题修复，我可以自动部署：

1. **修复 AnyDev 环境**
   - 访问 [AnyDev 控制台](https://anydev.woa.com/)
   - 检查环境 `evnIns-6s4sape346ni` 状态
   - 重启环境或等待 Agent 初始化完成

2. **通知我重新部署**
   - AnyDev 修复后，告诉我 "AnyDev 已修复"
   - 我会重新尝试自动部署

---

### 选项 C: 我帮你完成服务器端操作（需要你提供访问方式）

如果你能提供服务器访问方式，我可以直接操作：

1. **SSH 访问**
   - 提供 SSH 命令或凭证
   - 我直接执行部署命令

2. **远程桌面 / VNC**
   - 提供远程访问方式
   - 我远程操作服务器

3. **其他部署方式**
   - 告诉我你的想法

---

## 📋 部署检查清单

- [ ] 更新服务器代码已上传到 `zijianqiu-any1.devcloud.woa.com:/opt/vssaros-update/`
- [ ] 更新服务器已启动 (PM2 或 node)
- [ ] 端口 3030 已开放防火墙
- [ ] 安装包已上传到 `/opt/vssaros-update/downloads/`
- [ ] `manifest.json` 已更新（已完成，在 `deploy-package/update-server/`）
- [ ] 更新服务器 API 测试通过 (`/health` 和 `/api/update/...`)
- [ ] 客户端可以访问更新服务器

---

## 🔧 故障排查

### 更新服务器无法启动

```bash
# 检查端口占用
netstat -tlnp | grep 3030

# 查看 PM2 日志
pm2 logs vssaros-update

# 手动启动测试
cd /opt/vssaros-update/update-server
node server.mjs
```

### 无法访问更新服务器

```bash
# 在服务器上测试本地访问
curl http://localhost:3030/health

# 在本地测试外部访问
curl http://zijianqiu-any1.devcloud.woa.com:3030/health

# 检查防火墙
iptables -L -n | grep 3030
firewall-cmd --list-ports
```

### manifest.json 配置错误

检查 `/opt/vssaros-update/update-server/manifest.json`:
- `version` 必须是完整的 40 位 git commit sha
- `url` 必须可访问（测试: `curl <url>`）
- `sha256hash` 必须匹配安装包的 SHA256

---

## 📞 需要帮助？

- **查看详细文档**: `deploy-package/DEPLOYMENT_GUIDE.md`
- **快速开始**: `deploy-package/QUICK_START.md`
- **部署包说明**: `deploy-package/README.md`

---

## ✅ 完成后验证

部署成功后，你应该能够：

1. **访问更新服务器**: http://zijianqiu-any1.devcloud.woa.com:3030/health
2. **查看更新 API 响应**: http://zijianqiu-any1.devcloud.woa.com:3030/api/update/win32-x64-user/saros/0000000000000000000000000000000000000000
3. **安装客户端并测试更新**: 安装 `VsSarosUserSetup.exe`，打开 VS Code，等待更新检测

---

**请告诉我你选择哪个选项（A/B/C），我会相应协助！**
