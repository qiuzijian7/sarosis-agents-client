# Saros 商城使用说明

> 版本：v0.1（mockup）｜ 更新：2026-06-24
> 涵盖：商城网站 + VsSaros 客户端集成 + 资源包格式

---

## 一、访问地址

| 入口 | 地址 | 说明 |
|------|------|------|
| **商城网站** | http://21.6.92.5:3040 | 浏览器访问，网站 + API 同源 |
| **API 根路径** | http://21.6.92.5:3040/api/v1 | 客户端调用 |
| **健康检查** | http://21.6.92.5:3040/health | 运维监控 |
| **管理员账号** | `admin` / `admin123` | 首次部署自动创建 |

> 域名访问：http://zijianqiu-any1.devcloud.woa.com:3040

---

## 二、商城网站使用

### 2.1 注册与登录

1. 访问 http://21.6.92.5:3040
2. 点击右上角「注册」，填写用户名/邮箱/密码
3. 注册成功自动登录并跳转「我的资源」
4. 已有账号点「登录」（支持用户名或邮箱）

> 管理员可直接用 `admin` / `admin123` 登录。

### 2.2 浏览资源

- **首页**：渐变 hero 搜索框 + 资源卡片网格
- **分类 Tab**：全部 / Agent / Skill / MCP / 知识库
- **搜索**：按名称或描述关键词搜索
- **排序**：最近更新 / 下载量 / 名称
- **卡片**：显示类型标签、版本号、分类、下载量，点击进详情

### 2.3 发布资源（需登录）

#### 步骤 1：创建资源包

1. 点击「发布资源」或「我的资源」→「发布新资源」
2. 填写：
   - **资源类型**：agent / skill / mcp / knowledge（创建后不可改）
   - **Slug**：资源标识，将作为 `storeId`（小写字母数字连字符，如 `pdf-skill`）
   - **名称**、**描述**、**分类**、**图标(emoji)**、**标签**
   - **可见性**：公开 / 私有
3. 创建成功后跳转「版本管理」页

#### 步骤 2：上传版本

1. 在版本管理页，拖拽 `package.tar.gz` 到上传区
2. 填写「更新说明 (Changelog)」
3. 点击「发布版本」

> ⚠️ 包内 `manifest.json` 的 `id` 必须等于 Slug，`kind` 必须与资源类型一致，否则上传被拒。

### 2.4 管理资源

- **我的资源**：查看已发布资源列表
- **编辑信息**：卡片操作栏点编辑图标，修改名称/描述/分类/标签/可见性
- **版本管理**：上传新版本、删除旧版本、查看历史
- **下架**：详情页点「下架」（软删除，不再公开展示）
- **详情页**：查看版本历史表，每版本可下载

---

## 三、VsSaros 客户端集成使用

### 3.1 配置

在 VsSaros 设置中配置（`settings.json`）：

```jsonc
{
  // 商城服务端地址
  "saros.marketplace.url": "http://21.6.92.5:3040",
  // 启动时自动检查资源更新
  "saros.marketplace.autoCheckUpdates": true,
  // 检查间隔（秒）
  "saros.marketplace.updateInterval": 3600
}
```

### 3.2 注入服务

```ts
import { IMarketplaceService } from '../common/marketplace.js';

class MyComponent {
  constructor(@IMarketplaceService private readonly marketplace: IMarketplaceService) {}
}
```

### 3.3 登录

```ts
// 登录（token 自动持久化到 StorageService，重启恢复）
if (!this.marketplace.isLoggedIn()) {
  await this.marketplace.login('admin', 'admin123');
}
console.log(this.marketplace.getCurrentUser()); // { id, username, role, ... }

// 退出
this.marketplace.logout();
```

### 3.4 浏览与下载

```ts
// 搜索资源
const { items, total } = await this.marketplace.listPackages({
  kind: 'skill',           // 可选: agent | skill | mcp | knowledge
  q: 'pdf',                // 可选: 关键词
  page: 1,
  pageSize: 20,
  sort: 'recent',          // recent | popular | name
});

// 查看详情（含版本列表）
const detail = await this.marketplace.getPackage('pdf-skill');
console.log(detail.versions); // [{ version: '1.0.0', isLatest: true, ... }]

// 下载安装（自动解压 + 落地到本地目录 + 注册 + 写 installed-packages.json）
const result = await this.marketplace.download('pdf-skill', '1.0.0', 'skill');
console.log(result.targetDir); // ~/.saros/skills-library/pdf-skill/
```

### 3.5 上传发布

```ts
// 将本地资源打包发布到商城（需先在网站创建对应 slug 的资源包）
await this.marketplace.publish('my-skill', 'skill', {
  changelog: '初始版本：支持 PDF 处理',
  version: '1.0.0',        // 可选，覆盖 manifest.version
});
```

### 3.6 升级检查

```ts
// 批量检查（自动从 installed-packages.json 读取已安装项）
const updates = await this.marketplace.checkUpgrades();
// [{ kind: 'skill', storeId: 'pdf-skill', current: '1.0.0', latest: '1.2.0', downloadUrl, sha256, size }]

// 或手动指定检查项
const updates2 = await this.marketplace.checkUpgrades([
  { kind: 'skill', storeId: 'pdf-skill', version: '1.0.0' },
  { kind: 'agent', storeId: 'deep-researcher', version: '1.0.0' },
]);

// 有更新则下载升级
for (const u of updates) {
  await this.marketplace.download(u.storeId, u.latest, u.kind);
}
```

---

## 四、资源包格式

上传的 `package.tar.gz` 内含 `manifest.json` + 资源文件。

### 4.1 manifest.json（通用）

```jsonc
{
  "kind": "skill",            // agent | skill | mcp | knowledge
  "id": "pdf-skill",          // 必须等于商城 slug（storeId）
  "name": "PDF 处理技能",
  "version": "1.0.0",         // 语义化版本
  "description": "...",
  "category": "docs",
  "author": "saros",
  "minAppVersion": "1.0.0",
  "files": ["SKILL.md"]       // 包含的文件列表
}
```

### 4.2 各类型包内容

| 类型 | 必含文件 | 可选文件 | kind 专属字段 |
|------|---------|---------|--------------|
| **skill** | `SKILL.md`（frontmatter + 正文） | — | `skill: { activation, match, category }` |
| **agent** | `agent.json`（AgentExportData） | `AGENTS.md` `SOUL.md` `IDENTITY.md` `TOOLS.md` `MEMORY.md` `agent.yaml` | — |
| **mcp** | `config.json`（command/args/url/env） | `README.md` | `mcp: { transport, command, args, url, env }` |
| **knowledge** | `index.json` | `docs/**/*.md` | `knowledge: { embedding: { provider } }` |

### 4.3 各类型示例

#### skill - SKILL.md
```markdown
---
name: pdf-skill
description: PDF 读取与表格抽取
activation: manual
match: [pdf, PDF]
category: docs
version: 1.0.0
storeId: pdf-skill
---
# PDF 处理技能
当用户需要处理 PDF 文件时激活…
```

#### agent - agent.json
```jsonc
{
  "version": 1,
  "exportedAt": "2026-06-23T00:00:00Z",
  "agent": {
    "id": "deep-researcher",
    "name": "深度研究员",
    "role": "researcher",
    "model": "gpt-4o",
    "category": "research",
    "source": "custom"
  },
  "agentConfig": { "name": "deep-researcher", "version": "1.1.0", "model": "gpt-4o" },
  "files": { "agentsMd": "# 操作指南…" }
}
```

#### mcp - config.json
```jsonc
{
  "id": "filesystem-mcp",
  "name": "Filesystem MCP Server",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspace}"]
}
```

#### knowledge - index.json
```jsonc
{
  "name": "Saros 使用手册",
  "version": "2026.06",
  "files": [
    { "path": "docs/intro.md", "title": "简介", "summary": "平台概述" }
  ]
}
```

---

## 五、本地存储路径

下载安装后，资源落地到 `~/.saros/` 下：

| 类型 | 路径 | 说明 |
|------|------|------|
| skill | `~/.saros/skills-library/{id}/SKILL.md` | 安装后自动 `ISkillRegistry.reload()` |
| agent | `~/.saros/agents/custom/{slug}.agent.md` + `custom-agents.json` | 通过 `IAgentStudioService.createAgent()` 落地 |
| mcp | `~/.saros/mcp-servers/{id}/config.json` | 文件落地，需在集成视图手动添加服务器 |
| knowledge | `~/.saros/knowledge-base/{id}/docs/ + index.json` | 文件落地 |

**已安装清单**：`~/.saros/installed-packages.json`
```jsonc
[
  { "kind": "skill", "storeId": "pdf-skill", "version": "1.0.0", "installedAt": "2026-06-24T..." },
  { "kind": "agent", "storeId": "deep-researcher", "version": "1.1.0", "installedAt": "..." }
]
```
> 升级检查 `checkUpgrades()` 统一从此文件读取，无需遍历各 registry。

---

## 六、线上示例资源

商城已预置 8 个示例资源（可通过网站浏览或 API 获取）：

| 类型 | Slug | 版本 |
|------|------|------|
| skill | `pdf-skill` | v1.0.0 |
| skill | `code-review-skill` | v1.0.0 |
| mcp | `filesystem-mcp` | v0.5.0 |
| mcp | `fetch-mcp` | v0.4.0 |
| agent | `deep-researcher` | v1.1.0 |
| agent | `code-architect` | v1.0.0 |
| knowledge | `vssaros-handbook` | v2026.06 |
| knowledge | `vscode-dev-guide` | v1.0.0 |

**快速验证**（命令行）：
```bash
# 健康检查
curl http://21.6.92.5:3040/health

# 列表
curl http://21.6.92.5:3040/api/v1/packages?kind=skill

# 登录获取 token
curl -X POST http://21.6.92.5:3040/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# 升级检查
curl -X POST http://21.6.92.5:3040/api/v1/upgrade/check \
  -H "Content-Type: application/json" \
  -d '{"items":[{"kind":"skill","storeId":"pdf-skill","version":"0.9.0"}]}'
```

---

## 七、API 速查

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/v1/auth/register` | 公开 | 注册 |
| POST | `/api/v1/auth/login` | 公开 | 登录，返回 JWT |
| GET | `/api/v1/auth/me` | 必须 | 当前用户 |
| GET | `/api/v1/packages` | 可选 | 列表/搜索（?kind=&q=&page=&sort=） |
| GET | `/api/v1/packages/:slug` | 可选 | 详情 + 版本列表 |
| POST | `/api/v1/packages` | 必须 | 创建资源包 |
| PUT | `/api/v1/packages/:id` | 作者 | 编辑元信息 |
| DELETE | `/api/v1/packages/:id` | 作者 | 下架 |
| GET | `/api/v1/packages/:id/versions` | 可选 | 版本列表 |
| POST | `/api/v1/packages/:id/versions` | 作者 | 发布版本（multipart 上传） |
| POST | `/api/v1/packages/:id/versions/raw` | 作者 | 发布版本（raw gzip，客户端用） |
| GET | `/api/v1/packages/:id/versions/:ver/download` | 可选 | 下载 |
| DELETE | `/api/v1/packages/:id/versions/:ver` | 作者 | 删除版本 |
| POST | `/api/v1/upgrade/check` | 可选 | 批量升级检查 |

> 鉴权头：`Authorization: Bearer <jwt>`

---

## 八、已知限制与后续增强

| 项 | 当前状态 | 后续增强 |
|----|---------|---------|
| MCP 安装 | 文件落地 config.json，需手动在集成视图添加 | 自动调用 `IMcpManagementService.install` 注册 |
| Knowledge RAG | 文件落地 docs/index.json，无检索 | 新建 `IKnowledgeRegistry` 实现向量/全文检索 |
| 客户端 UI | 仅 API 层，无商城浏览/升级面板 | 新建市场视图 + 登录面板 + 升级通知 |
| 升级触发 | 手动调用 checkUpgrades | 配合 autoCheckUpdates 定时轮询 + 通知 |
| 资源审核 | 直接发布 | 管理员审核机制（mcp/agent 可执行类必审） |

---

## 九、开发与运维

### 服务端

```bash
cd G:\CustomWorkspaces\AIProjects\saros-marketplace

# 开发
npm run dev                    # tsx 热重载，http://localhost:3040

# 构建 + 启动
npm run build                  # tsc → dist/ + 复制 schema.sql
npm start                      # node dist/server.js

# 初始化数据库
npm run db:init                # 创建表 + admin 账号
```

### 网站前端

```bash
cd web
npm run dev                    # Vite 开发，http://localhost:5173（代理 API 到 3040）
npm run build                  # 构建到 ../public（服务端托管）
```

### AnyDev 服务器运维

```bash
# 服务目录
/opt/saros-marketplace/
├── dist/              # 服务端编译产物
├── public/            # 网站静态资源
├── node_modules/      # 生产依赖
├── data/              # 运行时（marketplace.db + assets/）
└── server.log         # 日志

# 查看日志
sudo tail -f /opt/saros-marketplace/server.log

# 重启服务
sudo fuser -k 3040/tcp
cd /opt/saros-marketplace && sudo NODE_ENV=production PORT=3040 \
  JWT_SECRET=saros-marketplace-prod-2026-key \
  DATA_DIR=/opt/saros-marketplace/data \
  nohup node dist/server.js > server.log 2>&1 &
```

### 种子脚本（填充示例资源）

```bash
cd G:\CustomWorkspaces\AIProjects\saros-marketplace
node scripts/seed-marketplace.mjs    # 上传 8 个示例资源到线上商城
```
