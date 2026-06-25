---
name: vssaros-release-pipeline
description: VsSarosis（VS Code fork）一键发版——编译+bundle+打包用户级安装包 → 上传 DevCloud → 在工蜂 vssaros_issue 创建 Release → 打 git tag。更新代理自动从 Release 解析下载链接+SHA256，已安装用户下次启动自动更新。
description_zh: VsSarosis 一键打包发版
description_en: VsSarosis end-to-end release
disable: false
agent_created: true
---

# vssaros-release-pipeline

VsSarosis（`saros-agents-client`，路径：`G:\CustomWorkspaces\AIProjects\saros-agents-client`）端到端发版流程。

## When to use（触发场景）

- "打包发版" / "发布新版本" / "出一个 release" / "打 tag 并发布"
- "VsSarosis 发版" / "上传 release" / "release pipeline"
- "生成版本说明 / changelog / release notes"

## 前置知识

1. **项目根**：`G:\CustomWorkspaces\AIProjects\saros-agents-client`
2. **安装包**：仅发布用户级 `VsSarosUserSetup.exe`（无需管理员权限）
3. **Release 仓库**：`https://git.woa.com/zijianqiu/vssaros_issue`（项目 ID: 1790708），不是 saros-agents-client
4. **更新代理**：DevCloud `http://zijianqiu-any1.devcloud.woa.com:3030`，自动从工蜂 Release 描述提取下载 URL + SHA256
5. **Git 远程**：`origin`=工蜂 saros-agents-client / `backup`=GitHub / `upstream`=microsoft/vscode（禁止 push）
6. **product.json**：`quality: "saros"`，`updateUrl: "http://zijianqiu-any1.devcloud.woa.com:3030"`
7. **isEmbeddedApp 修复**：已提交到 `src/vs/code/electron-main/main.ts:108`，确保打包 EXE 启动即 Agent Studio

---

## 完整发版流程

### Stage 0：编译 + Bundle（约 3 分钟）

> ⚠️ `gulp vscode-win32-x64` 因扩展下载（tdb-am-gateway GH URL 为空）会失败，所以用两步替代：先 `gulp compile`，再手动 esbuild bundle。

```bash
cd G:/CustomWorkspaces/AIProjects/saros-agents-client

# 1. 编译 TS 源码
npx --node-options="--max-old-space-size=8192" gulp compile

# 2. Bundle 到 out-vscode
node --max-old-space-size=8192 build/next/index.ts bundle --out out-vscode --target desktop --nls

# 3. 复制到 VSCode 打包目录
cp -r out-vscode/* G:/CustomWorkspaces/AIProjects/VSCode-win32-x64/resources/app/out/

# 4. 移除过期 checksums（否则触发 "installation corrupt" 错误）
#    直接编辑 G:/CustomWorkspaces/AIProjects/VSCode-win32-x64/resources/app/product.json
#    删除 "checksums" 字段及内容
```

### Stage 1：打包安装包（约 1.5 分钟）

```bash
# 关闭残留进程
powershell -Command "Get-Process -Name VsSarosis -ErrorAction SilentlyContinue | Stop-Process -Force"

# 打包用户级安装包
npx gulp vscode-win32-x64-user-setup
```

**校验体积**：

```bash
ls -lh .build/win32-x64/user-setup/VsSarosUserSetup.exe
```

期望 ~96 MB，异常（< 70 或 > 150）需检查 `code.iss`。

### Stage 2：上传到更新服务器（HTTP upload 端点）

> ⚠️ DevCloud SSH 仅限内网，**蓝盾 CI 无法 scp**。改用更新服务器的 HTTP 上传端点 `POST /admin/upload`，
> 服务器自动存盘 + 算 sha256 + 更新 manifest，一步完成（无需手动 gen-manifest）。

**方式 A：一键脚本（推荐，蓝盾流水线用）**

```bash
bash deploy-package/scripts/upload-to-update-server.sh \
  --exe .build/win32-x64/user-setup/VsSarosUserSetup.exe \
  --commit $GIT_COMMIT \
  --version 1.120.0 \
  --token $UPLOAD_TOKEN
```

**方式 B：直接 curl**

```bash
curl -sS -X POST \
  -H "X-Upload-Token: $UPLOAD_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @.build/win32-x64/user-setup/VsSarosUserSetup.exe \
  "http://zijianqiu-any1.devcloud.woa.com:3030/admin/upload?platform=win32-x64-user&commit=$GIT_COMMIT&productVersion=1.120.0"
```

响应：`{"ok":true,"platform":"win32-x64-user","version":"...","url":"http://.../downloads/VsSarosUserSetup.exe","sha256hash":"...","size":...}`

> 服务器需设置环境变量 `UPLOAD_TOKEN`（鉴权）和 `PUBLIC_BASE_URL`（拼接下载 url，留空则用 Host 头）。

### Stage 3：打 Git Tag

```bash
git tag -a v0.1.X -m "VsSarosis v0.1.X"
git push origin v0.1.X     # 工蜂 saros-agents-client
git push backup v0.1.X     # GitHub
```

### Stage 4：创建工蜂 Release（vssaros_issue）

> ⚠️ **关键**：Release 创建在 `zijianqiu/vssaros_issue` 仓库（ID: 1790708），不是 saros-agents-client。
> 更新代理从 Release 描述中解析下载 URL（格式：`[VsSarosUserSetup.exe](url)`）和 SHA256（格式：`SHA256: 64位hex`）。

**步骤 4.1**：上传 EXE 到工蜂

```bash
curl -s --header "PRIVATE-TOKEN: $GONGFENG_TOKEN" \
  -F "file=@.build/win32-x64/user-setup/VsSarosUserSetup.exe" \
  "https://git.woa.com/api/v3/projects/1790708/uploads"
```

响应示例：`{"url":"/uploads/xxxxxxxx/VsSarosUserSetup.exe"}`，拼接为 `https://git.woa.com/zijianqiu/vssaros_issue/uploads/xxxxxxxx/VsSarosUserSetup.exe`

**步骤 4.2**：在 vssaros_issue 创建 tag（如不存在）

```bash
curl -s --header "PRIVATE-TOKEN: $GONGFENG_TOKEN" \
  --header "Content-Type: application/json" \
  -X POST "https://git.woa.com/api/v3/projects/1790708/repository/tags" \
  -d '{"tag_name":"v0.1.X","ref":"main","message":"VsSarosis v0.1.X"}'
```

**步骤 4.3**：创建 Release

> ⚠️ 工蜂 v3 API 用 `"tag"` 字段，**不是** `"tag_name"`！

```bash
curl -s --header "PRIVATE-TOKEN: $GONGFENG_TOKEN" \
  --header "Content-Type: application/json" \
  -X POST "https://git.woa.com/api/v3/projects/1790708/releases" \
  -d '{
    "tag": "v0.1.X",
    "name": "VsSarosis v0.1.X",
    "description": "## VsSarosis v0.1.X\n\n### 修复内容\n- xxx\n\n### 下载\n\n| 平台 | 类型 | 下载 |\n|------|------|------|\n| Windows x64 | 用户级安装（无需管理员） | [VsSarosUserSetup.exe](http://zijianqiu-any1.devcloud.woa.com:3030/downloads/VsSarosUserSetup.exe) |\n\n### 校验\n```\nSHA256: <64位hash>\n大小: 96 MB\n```\n\n### 提交信息\n- 基于 saros-agents-client commit: `<short-sha>`"
  }'
```

**Release 描述格式要求**（更新代理正则解析）：

| 字段 | 格式 | 正则 |
|------|------|------|
| 下载 URL | `[VsSarosUserSetup.exe](URL)` | `/\[VsSarosUserSetup\.exe\]\(([^)]+)\)/` |
| SHA256 | `SHA256: 64位hex` | `/SHA256[：:]\s*([a-f0-9]{64})/i` |

### Stage 5：验证

```bash
# 测试更新 API（用旧 commit）
curl -s http://zijianqiu-any1.devcloud.woa.com:3030/api/update/win32-x64/saros/old-commit

# 预期返回：{ "version":"v0.1.X", "url":"http://.../downloads/VsSarosUserSetup.exe", "sha256hash":"<hash>" }
```

---

## 踩坑日志

### 2026-06-09

- **工蜂 v3 API 创建 Release 用 `"tag"` 不是 `"tag_name"`**（`tag_name` 报 400 "tag not given"）
- **Release 必须在 vssaros_issue 仓库创建**（不是 saros-agents-client），需要先在 vssaros_issue 建 tag
- **`gulp vscode-win32-x64` 因 tdb-am-gateway 扩展 GH URL 为空而失败**→ 用两步替代：`gulp compile` + 手动 `node build/next/index.ts bundle`
- **checksums 过期导致 "installation corrupt"**→ 打包前需移除 `VSCode-win32-x64/resources/app/product.json` 的 `checksums` 字段
- **`isEmbeddedApp = true` 修复**：`src/vs/code/electron-main/main.ts:108`，确保 EXE 启动即 Agent Studio
- **DevCloud SSH 仅限内网**：本地终端可 SSH，远程代理不可；SCP 上传需在本地执行
