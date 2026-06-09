---
name: vssarosis-release-pipeline
description: 一键完成 VsSarosis（VS Code fork：sarosis-agents-client）端到端发版流程——预检品牌 → 打包 win32-x64 system + user 安装包 → 基于 git log 自动生成 release notes（中文）→ 创建 git tag → 上传到工蜂（origin / git.woa.com）+ GitHub backup 双 Release → 同步更新热更新 manifest。当用户说"打包发版"、"发布新版本"、"出一个 release"、"打 tag 并发布"、"VsSarosis 发版"、"上传 release"、"生成版本说明 / changelog"、"VsSarosis release"、"release pipeline" 时触发。
description_zh: VsSarosis 一键打包发版
description_en: VsSarosis end-to-end release
disable: false
agent_created: true
---

# vssarosis-release-pipeline

VsSarosis（`sarosis-agents-client`，路径：`G:\CustomWorkspaces\AIProjects\sarosis-agents-client`）端到端发版流程。覆盖：品牌预检 → 双安装包打包 → release notes 生成 → tag → 双远程 Release 上传 → 热更新 manifest 同步。

## When to use（触发场景）

- "打包发版" / "发布新版本" / "出一个 release" / "打 tag 并发布"
- "VsSarosis 发版" / "上传 release" / "release pipeline"
- "生成版本说明 / changelog / release notes"
- 仅"打包"也可走本流程的 Stage 1，仅"发版"可走 Stage 2-5

## 前置约定（必读）

1. **项目根**：`G:\CustomWorkspaces\AIProjects\sarosis-agents-client`
2. **构建产物父目录**：`G:\CustomWorkspaces\AIProjects\VSCode-win32-x64\`（不在仓库 .build 内）
3. **安装包输出路径**：
   - `system → .build/win32-x64/system-setup/VsSarosisSetup.exe`
   - `user   → .build/win32-x64/user-setup/VsSarosisUserSetup.exe`
4. **远程**：
   - `origin`  → `https://git.woa.com/zijianqiu/sarosis-agents-client.git`（**工蜂主**）
   - `backup`  → `https://github.com/qiuzijian7/sarosis-agents-client.git`（备份）
   - `upstream`→ microsoft/vscode（**禁止 push**）
5. **product.json**：`quality: "sarosis"`，`updateUrl` 指向 Worker / 自托管 feed
6. **package.json scripts**：已有 `verify-branding` / `fix-branding`
7. **打包工具**：gulp + Inno Setup（已就绪），约 5-10 分钟/包

## 阶段总览

```
Stage 0  品牌预检（fix-branding）
Stage 1  双安装包打包（system + user）
Stage 2  生成 release notes（基于 git log，中文）
Stage 3  打 git tag 并 push
Stage 4  上传到工蜂 + GitHub Release（双远程）
Stage 5  更新热更新 manifest（gen-manifest.mjs）
```

每个 stage 失败必须**立刻停止**并报告，不要试图静默重试或跳过。

---

## Stage 0：品牌预检（必跑）

```bash
cd /g/CustomWorkspaces/AIProjects/sarosis-agents-client
npm run verify-branding
# 不一致 → npm run fix-branding 自动修
```

**为什么必跑**：`product.json` 的品牌字段（特别是 4 个双大括号 AppId）容易被 git rebase / upstream merge 还原成 `Code - OSS`，会导致 Inno Setup 报 `Unknown constant`。

如果触发了 fix，必须 `git diff product.json` 让用户确认修复内容，然后才能继续。

---

## Stage 1：打包

**必须先关闭 VsSarosis 进程**，否则 .dll/.node 文件被锁导致 EPERM：

```powershell
Get-Process -Name "VsSarosis" -ErrorAction SilentlyContinue | Stop-Process -Force
```

然后顺序打两个包（不能并行，会抢 Inno Setup 临时目录）：

```bash
# 后台运行，约 3-5 分钟
npx gulp vscode-win32-x64-system-setup
npx gulp vscode-win32-x64-user-setup
```

**校验产物**：

```bash
ls -la .build/win32-x64/system-setup/VsSarosisSetup.exe \
       .build/win32-x64/user-setup/VsSarosisUserSetup.exe \
| awk '{printf "%s  %.2f MiB\n", $NF, $5/1048576}'
```

期望体积约 90-100 MiB（参考：当前稳妥方案 95.60 MiB）。**异常体积**（< 70 MiB 或 > 150 MiB）必须停下来检查 `code.iss` Excludes 是否被误改。

---

## Stage 2：生成 release notes（中文）

调用本 skill 自带的脚本：

```bash
node resources/.agents/skills/vssarosis-release-pipeline/scripts/gen-release-notes.mjs \
  --version 1.2.3 \
  --since <last-tag-or-commit> \
  --out RELEASE_NOTES.md
```

脚本逻辑（已实现，详见 scripts/gen-release-notes.mjs）：

1. 自动读取 `package.json.version`（如未传 `--version`）
2. 自动用 `git describe --tags --abbrev=0` 找上一个 tag（如未传 `--since`），第一次发版可手动指定 commit
3. 解析 `git log <since>..HEAD --pretty=format:'%h|%s|%an|%ad' --date=short`
4. 按提交前缀分类：
   - `feat[:：]` / `feat\(...\)[:：]` → ✨ 新功能
   - `fix[:：]`  / `fix\(...\)[:：]`  → 🐛 修复
   - `refactor` → 🔧 重构
   - `perf`     → ⚡ 性能
   - `docs`     → 📝 文档
   - `chore` / `build` / `ci` → 🛠️ 工程
   - `revert`   → ⏪ 回退
   - 其他       → 📦 其他变更
5. 中文冒号"："和英文冒号":" 都识别（项目历史用了"："）
6. 输出 markdown：
   ```
   # VsSarosis v1.2.3

   发布日期：2026-06-04
   提交范围：abcd123..HEAD（共 N 次提交）

   ## ✨ 新功能
   - feat：xxxx (`abc1234`)

   ## 🐛 修复
   - ...

   ## 安装包
   | 包 | 大小 | SHA256 |
   |---|---|---|
   | VsSarosisSetup.exe | 95.60 MiB | `...` |
   | VsSarosisUserSetup.exe | 95.60 MiB | `...` |

   ## 更新方式
   - 已安装用户：客户端会在 1 小时内自动检测到新版本并后台静默下载，重启即应用更新
   - 新用户：从 Release 直接下载安装

   commit: <full-sha>
   sha256-win32-x64: <hash>
   sha256-win32-x64-user: <hash>
   ```
7. 末尾的 `commit:` 和 `sha256-*:` 行是**热更新 Worker 解析必需**（见 build/sarosis/update-server/worker.js），不要删

**生成完毕后必须让用户审阅 RELEASE_NOTES.md**，确认无敏感词 / 内部代号泄漏，再继续。

---

## Stage 3：打 tag 并 push

版本号约定：`v<semver>`（不是裸数字），与 `package.json.version` 对齐：

```bash
git tag -a v1.2.3 -m "VsSarosis v1.2.3"
git push origin v1.2.3
git push backup v1.2.3
```

**先 push tag，再 push 主分支**（避免 CI 触发顺序问题）：

```bash
git push origin HEAD
git push backup HEAD
```

> ⚠️ 不要 `--force` 推 main / master，本项目历史曾有 upstream merge，强推会污染。

---

## Stage 4：上传到双远程 Release

### 4.1 工蜂（origin）—— 主发布渠道

> ✅ **首选路径：通过 `gongfeng` MCP 连接器调用工蜂 API**。
> WorkBuddy 已配置好 `gongfeng` connector（`~/.workbuddy/mcp.json`，URL：`https://mcpgw.knot.woa.com/gongfeng`，已带鉴权 header）。
> 直接用 MCP 工具调用，无需手动管理 token / glab CLI。

#### 路径 A（推荐）：调用 `gongfeng` MCP 工具

调用前先确认连接器已激活：在 WorkBuddy 自定义连接器面板看 `gongfeng-woa` 是否已 Trust。

典型工具命名（由 MCP server 暴露，按实际工具列表为准）：
- `gongfeng_create_release` / `create_release`：创建 Release（仓库 + tag + 标题 + 描述）
- `gongfeng_upload_release_asset` / `upload_release_asset`：上传 exe 资产并绑定到 release
- `gongfeng_create_tag`：（可选）补创 tag

调用参数模板：
```
project_id 或 path:  "zijianqiu/sarosis-agents-client"
tag_name:            "v1.2.3"
name:                "VsSarosis v1.2.3"
description:         <RELEASE_NOTES.md 全文>
assets:              [
  ".build/win32-x64/system-setup/VsSarosisSetup.exe",
  ".build/win32-x64/user-setup/VsSarosisUserSetup.exe"
]
```

如 MCP 工具尚未暴露资产上传，仅创建 release 文本，**资产由路径 B 兜底**。

#### 路径 B（兜底）：CLI / curl

仅当 MCP 不可用时使用：
```bash
glab release create v1.2.3 \
  --repo zijianqiu/sarosis-agents-client \
  --notes-file RELEASE_NOTES.md \
  ".build/win32-x64/system-setup/VsSarosisSetup.exe" \
  ".build/win32-x64/user-setup/VsSarosisUserSetup.exe"
```

或 `curl https://git.woa.com/api/v4/projects/<urlencoded-path>/releases`（需 PRIVATE-TOKEN）。

**踩坑提示**：工蜂 release assets 上传链路偶尔不稳；如失败，立即跳到 4.2 让 GitHub 作主下载源，工蜂只挂 release 文本和 GitHub 资产链接。

### 4.2 GitHub backup —— 下载源 + 热更新 Worker 数据源

```bash
gh release create v1.2.3 \
  --repo qiuzijian7/sarosis-agents-client \
  --title "VsSarosis v1.2.3" \
  --notes-file RELEASE_NOTES.md \
  ".build/win32-x64/system-setup/VsSarosisSetup.exe" \
  ".build/win32-x64/user-setup/VsSarosisUserSetup.exe"
```

> ✅ **GitHub Release 是热更新 Worker 的真实数据源**。`product.json.updateUrl` 背后的 Worker 直接读 GitHub Releases API，所以 GitHub 这步**不能省**。
> Release body 必须包含 `commit: <full-sha>` 和 `sha256-win32-x64-user: <hash>` 两行（脚本已自动生成）。

---

## Stage 5：更新热更新 manifest（仅当用本地清单模式）

如果用 Worker 模式（默认），**Stage 5 可跳过**——Worker 直接读 GitHub Release，无需手动更新 manifest。

如果用本地 `server.mjs` + `manifest.json` 模式：

```bash
node build/sarosis/update-server/gen-manifest.mjs \
  --platform win32-x64-user \
  --exe ".build/win32-x64/user-setup/VsSarosisUserSetup.exe" \
  --version 1.2.3 \
  --url "https://github.com/qiuzijian7/sarosis-agents-client/releases/download/v1.2.3/VsSarosisUserSetup.exe"

node build/sarosis/update-server/gen-manifest.mjs \
  --platform win32-x64 \
  --exe ".build/win32-x64/system-setup/VsSarosisSetup.exe" \
  --version 1.2.3 \
  --url "https://github.com/qiuzijian7/sarosis-agents-client/releases/download/v1.2.3/VsSarosisSetup.exe"
```

然后提交 manifest 变更：

```bash
git add build/sarosis/update-server/manifest.json
git commit -m "chore: bump update manifest to v1.2.3"
git push origin HEAD && git push backup HEAD
```

---

## 完整一键流程（示例）

用户说"发个 1.2.3 版本"时，按下面顺序执行（每个 stage 完成后再进下一个）：

```bash
# Stage 0
npm run verify-branding || npm run fix-branding

# Stage 1
Get-Process -Name "VsSarosis" -ErrorAction SilentlyContinue | Stop-Process -Force
npx gulp vscode-win32-x64-system-setup
npx gulp vscode-win32-x64-user-setup

# Stage 2
node resources/.agents/skills/vssarosis-release-pipeline/scripts/gen-release-notes.mjs \
  --version 1.2.3 --out RELEASE_NOTES.md

# Stage 3
git tag -a v1.2.3 -m "VsSarosis v1.2.3"
git push origin v1.2.3 && git push backup v1.2.3
git push origin HEAD && git push backup HEAD

# Stage 4 - 工蜂优先走 gongfeng MCP（已配置），exe 资产可由 MCP 上传或回退 glab
# gongfeng MCP: https://mcpgw.knot.woa.com/gongfeng（用户级 ~/.workbuddy/mcp.json 已配置）
gh release create v1.2.3 --repo qiuzijian7/sarosis-agents-client \
  --title "VsSarosis v1.2.3" --notes-file RELEASE_NOTES.md \
  .build/win32-x64/system-setup/VsSarosisSetup.exe \
  .build/win32-x64/user-setup/VsSarosisUserSetup.exe
# 工蜂兜底（MCP 无法上传时使用）
glab release create v1.2.3 --repo zijianqiu/sarosis-agents-client \
  --notes-file RELEASE_NOTES.md \
  .build/win32-x64/system-setup/VsSarosisSetup.exe \
  .build/win32-x64/user-setup/VsSarosisUserSetup.exe

# Stage 5（仅本地清单模式）
node build/sarosis/update-server/gen-manifest.mjs --platform win32-x64-user ...
node build/sarosis/update-server/gen-manifest.mjs --platform win32-x64 ...
```

## 错误处理

- **gulp 报 `Unknown constant`** → product.json 品牌字段被还原，回到 Stage 0 跑 fix-branding
- **gulp EPERM** → VsSarosis 进程未关闭，重跑 Stop-Process
- **`gh` 未登录** → `gh auth login`，要求 user 提供 token
- **`gongfeng` MCP 不可用** → 提醒用户在 WorkBuddy 自定义连接器面板 Trust `gongfeng-woa`；仍不可用回退到 `glab` 或 curl
- **`glab` 未安装/未登录** → 优先走 `gongfeng` MCP；若 MCP 也不行，让用户在工蜂 Web UI 手动上传，或暂时只发 GitHub
- **gen-release-notes 找不到 since 提交** → 第一次发版没有上一 tag，让用户提供起始 commit
- **体积异常** → 检查 build/win32/code.iss Excludes，参考 2026-06-04 memory（90MB 稳妥方案）

## 与现有体系的协作

- `verify-product-branding.mjs`（已有）→ Stage 0 复用
- `gen-manifest.mjs`（已有）→ Stage 5 复用
- `code.iss` Excludes（参考 memory 2026-06-04）→ 决定包体积，本流程不动它
- 热更新 Worker（`build/sarosis/update-server/worker.js`）→ 消费 GitHub Release，本流程产出它的输入

## 经验积累

每次执行本流程踩到新坑（API 变化、远程拒绝、签名问题等），追加到 SKILL.md 末尾"踩坑日志"段落，并把当次具体 sha256 / commit 写入 `.workbuddy/memory/YYYY-MM-DD.md`。

---

## 踩坑日志

（按发版日期倒序追加）
