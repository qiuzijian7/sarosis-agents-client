# Agent / Skill / MCP / 知识库 商城方案设计

> 版本：v1.0 ｜ 日期：2026-06-23
> 范围：独立商城服务端（部署于 AnyDev）+ 管理网站 + vsSarosis 客户端上传/下载 + 本地升级机制

---

## 1. 总体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                       AnyDev 云服务器                                │
│   ┌───────────────────────────────────────────────────────────┐     │
│   │   Sarosis Marketplace Server  (Node + Express + SQLite)    │     │
│   │   ├── REST API  (/api/v1/...)                              │     │
│   │   ├── 管理网站  (React 静态站，由 Express 托管)              │     │
│   │   ├── JWT 用户认证                                          │     │
│   │   ├── 资源文件存储  (/data/assets/{type}/{id}/{version})    │     │
│   │   └── SQLite 元数据库  (/data/marketplace.db)              │     │
│   └───────────────────────────────────────────────────────────┘     │
│                  ▲                          ▲                        │
│      HTTPS/API  │                          │  HTTPS/API            │
└─────────────────┼──────────────────────────┼────────────────────────┘
                  │                          │
        ┌─────────┴─────────┐    ┌──────────┴──────────┐
        │  管理网站 (浏览器)  │    │  vsSarosis 客户端     │
        │  登录 / 增删改查     │    │  上传 / 下载 / 升级    │
        └───────────────────┘    └─────────────────────┘
                                          │
                          ┌───────────────┴───────────────┐
                          │  本地资源目录 ~/.saros/          │
                          │  ├── agents/custom/             │
                          │  ├── skills-library/<id>/       │
                          │  ├── mcp-servers/<id>/          │
                          │  └── knowledge-base/<id>/       │
                          └─────────────────────────────────┘
```

### 四类资源统一抽象

商城对四类资源采用**统一的「包(Package)」模型**，区别仅在 `kind` 字段与 payload 结构：

| kind | 本地存储 | 现有可复用结构 |
|------|---------|--------------|
| `agent` | `~/.saros/agents/custom/` | `AgentExportData`（agent 定义 + agent.yaml + 引导文件） |
| `skill` | `~/.saros/skills-library/<id>/SKILL.md` | `ISkillDefinition`（已含 `storeId`/`updateUrl`/`version`/`contentHash`） |
| `mcp` | `~/.saros/mcp-servers/<id>/` | MCP server 配置（命令/参数/env）+ `knotMcpMarket` 预设格式 |
| `knowledge` | `~/.saros/knowledge-base/<id>/` | 新增：文档集合 + 清单（向量索引可选，客户端侧 RAG） |

> 统一抽象的好处：上传/下载/版本/升级/鉴权逻辑只写一套，按 `kind` 分流 payload 解析。

---

## 2. 商城服务端设计

### 2.1 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 运行时 | Node.js 18+ | 与现有 `update-server/server.mjs` 同生态；AnyDev 原生支持 |
| Web 框架 | Express | 轻量、生态成熟；与零依赖 update-server 风格协调 |
| 数据库 | SQLite (better-sqlite3) | 单文件、零运维、AnyDev 单机部署足够；后续可平滑迁移 PostgreSQL |
| 认证 | JWT (jsonwebtoken) + bcrypt | 无状态、易扩展 |
| 文件上传 | multer | Express 事实标准 |
| 校验 | zod | 端到端类型安全 |
| 前端 | React + Vite + Ant Design | 与客户端 webview 技术栈一致（客户端已用 React） |
| 进程管理 | pm2 / systemd（AnyDev webshell 用 nohup 启动） | AnyDev 规则要求 nohup + 重定向 |

### 2.2 目录结构（服务端仓库）

建议在项目内新建独立子项目，与客户端源码解耦：

```
marketplace-server/
├── package.json
├── server.mjs                 # Express 入口（nohup 启动）
├── src/
│   ├── db.ts                  # better-sqlite3 初始化 + 迁移
│   ├── schema.sql             # 建表脚本
│   ├── auth/
│   │   ├── jwt.ts             # 签发/校验 JWT
│   │   └── users.ts           # 注册/登录/资料
│   ├── packages/
│   │   ├── routes.ts          # /api/v1/packages  CRUD + 搜索
│   │   ├── versions.ts        # 版本发布、版本列表
│   │   ├── upload.ts          # multer 上传 + 校验
│   │   ├── download.ts        # 下载（含鉴权/计数）
│   │   ├── upgrade.ts         # 升级检查 feed
│   │   └── parser.ts          # 按 kind 解析 payload（复用客户端类型）
│   ├── admin/
│   │   └── routes.ts          # 审核/下架/统计
│   └── middleware/
│       ├── auth.ts            # requireAuth / optionalAuth
│       └── error.ts
├── web/                       # 管理网站前端（React + Vite）
│   ├── src/
│   │   ├── pages/             # Login, PackageList, PackageEditor, VersionPublish
│   │   ├── components/
│   │   └── api/               # 封装 fetch
│   └── vite.config.ts         # build → ../public (Express 静态托管)
├── public/                    # 构建产物（网站静态资源）
└── data/                      # 运行时数据（gitignore）
    ├── marketplace.db
    └── assets/
        ├── agent/{pkgId}/{version}/package.tar.gz
        ├── skill/{pkgId}/{version}/package.tar.gz
        ├── mcp/{pkgId}/{version}/package.tar.gz
        └── knowledge/{pkgId}/{version}/package.tar.gz
```

### 2.3 数据库模型（schema.sql）

核心表：`users`、`packages`、`package_versions`、`downloads`、`reviews`。

```sql
-- 用户
CREATE TABLE users (
  id            TEXT PRIMARY KEY,            -- uuid
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,               -- bcrypt
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'user', -- user | admin
  avatar_url    TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- 资源包（一个 agent/skill/mcp/knowledge 对应一行）
CREATE TABLE packages (
  id            TEXT PRIMARY KEY,            -- uuid，即 storeId
  kind          TEXT NOT NULL,               -- agent | skill | mcp | knowledge
  slug          TEXT NOT NULL,               -- URL 友好标识，全局唯一
  name          TEXT NOT NULL,
  description   TEXT,
  category      TEXT,                        -- code | review | docs | ...
  icon          TEXT,
  author_id     TEXT NOT NULL REFERENCES users(id),
  visibility    TEXT NOT NULL DEFAULT 'public', -- public | private
  tags          TEXT,                        -- JSON array 字符串
  latest_version TEXT,                       -- 冗余：最新稳定版本号
  featured      INTEGER NOT NULL DEFAULT 0,  -- 精选
  status        TEXT NOT NULL DEFAULT 'active', -- active | pending_review | removed
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_packages_slug ON packages(slug);
CREATE INDEX idx_packages_kind_cat ON packages(kind, category, status);

-- 版本（一个包可发布多个版本，支撑升级）
CREATE TABLE package_versions (
  id            TEXT PRIMARY KEY,
  package_id    TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  version       TEXT NOT NULL,               -- 语义化版本 1.2.3
  changelog     TEXT,                        -- 更新说明
  asset_path    TEXT NOT NULL,               -- data/assets/... 相对路径
  asset_size    INTEGER NOT NULL,            -- 字节
  sha256        TEXT NOT NULL,               -- 完整性校验
  manifest      TEXT NOT NULL,               -- JSON：kind 专属清单（见 §2.4）
  published_by  TEXT NOT NULL REFERENCES users(id),
  is_latest     INTEGER NOT NULL DEFAULT 0,  -- 是否当前最新
  created_at    INTEGER NOT NULL,
  UNIQUE(package_id, version)
);
CREATE INDEX idx_ver_pkg ON package_versions(package_id, created_at DESC);

-- 下载记录（统计 + 防刷）
CREATE TABLE downloads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id    TEXT NOT NULL,
  version_id    TEXT NOT NULL,
  user_id       TEXT,                        -- 可空（匿名/客户端 token）
  client_id     TEXT,                        -- vsSarosis 实例标识
  ip            TEXT,
  created_at    INTEGER NOT NULL
);

-- 评价（可选）
CREATE TABLE reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  rating        INTEGER NOT NULL,            -- 1-5
  comment       TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(package_id, user_id)
);
```

### 2.4 资源包格式（Package Manifest）

上传/下载统一为 **`package.tar.gz`**，内含一个 `manifest.json` + 资源文件。不同 `kind` 的 manifest 与文件结构复用客户端已有定义：

#### agent
```jsonc
// manifest.json
{
  "kind": "agent",
  "id": "my-researcher",
  "name": "深度研究员",
  "version": "1.2.0",
  "description": "...",
  "category": "research",
  "author": "alice",
  "minAppVersion": "1.0.0",
  "files": ["agent.json", "agent.yaml", "AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md", "MEMORY.md"]
}
// agent.json 即 AgentExportData；引导文件来自 agentDir
```

#### skill
```jsonc
{
  "kind": "skill",
  "id": "pdf",
  "name": "PDF Skill",
  "version": "1.0.0",
  "activation": "manual",
  "match": ["pdf"],
  "files": ["SKILL.md"]
}
// SKILL.md 含 frontmatter（id/name/version/description/...）+ prompt 正文
// 与 ISkillDefinition 一一对应
```

#### mcp
```jsonc
{
  "kind": "mcp",
  "id": "filesystem-mcp",
  "name": "Filesystem MCP Server",
  "version": "0.5.0",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspace}"],
  "env": {},
  "files": ["README.md"]
}
// 与 knotMcpMarket 预设 + mcpServerEditorPane 配置结构对齐
```

#### knowledge
```jsonc
{
  "kind": "knowledge",
  "id": "company-handbook",
  "name": "公司手册",
  "version": "2026.06",
  "embedding": { "provider": "none", "model": "" },  // none=纯关键词; 或 openai/bge
  "files": ["docs/**/*.md", "index.json"]
}
// index.json：文件路径 → 标题/摘要 的清单，供客户端 RAG 检索
```

### 2.5 API 设计

所有 API 前缀 `/api/v1`。鉴权头：`Authorization: Bearer <jwt>`。

#### 认证
| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/auth/register` | 公开 | 注册（用户名+邮箱+密码） |
| POST | `/auth/login` | 公开 | 登录，返回 `{ token, user }` |
| GET | `/auth/me` | 必须 | 获取当前用户 |
| PUT | `/auth/me` | 必须 | 更新资料/头像 |

#### 资源包 CRUD
| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/packages?kind=&q=&category=&page=&sort=` | 可选 | 搜索/列表（分页） |
| GET | `/packages/:slug` | 可选 | 包详情 + 版本列表 |
| POST | `/packages` | 必须 | 创建包（kind/slug/name/...） |
| PUT | `/packages/:id` | 必须(作者) | 编辑元信息 |
| DELETE | `/packages/:id` | 必须(作者) | 下架（软删除 status=removed） |

#### 版本与文件
| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/packages/:id/versions` | 可选 | 版本列表 |
| POST | `/packages/:id/versions` | 必须(作者) | 发布新版本（multipart：manifest + tar.gz） |
| GET | `/packages/:id/versions/:version/download` | 可选 | 下载包文件（自增计数） |
| DELETE | `/packages/:id/versions/:version` | 必须(作者) | 删除版本 |

#### 升级检查（客户端轮询）
复用现有 update-server 的「commit 比对」思路，改为语义化版本比对：

```
POST /api/v1/upgrade/check
Body: {
  "items": [
    { "kind": "skill",  "storeId": "pdf",        "version": "1.0.0" },
    { "kind": "agent",  "storeId": "my-researcher","version": "1.1.0" },
    { "kind": "mcp",    "storeId": "fs-mcp",     "version": "0.4.0" },
    { "kind": "knowledge","storeId":"handbook",  "version":"2026.05" }
  ]
}
Response: {
  "updates": [
    {
      "kind": "skill", "storeId": "pdf", "current": "1.0.0",
      "latest": "1.2.0", "changelog": "支持表格抽取",
      "downloadUrl": "/api/v1/packages/pdf/versions/1.2.0/download",
      "sha256": "...", "size": 8421
    }
  ]
}
```

> 设计要点：批量检查一次往返，减少客户端请求；返回 `downloadUrl` + `sha256` 供客户端校验完整性。

#### 管理
| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/admin/stats` | admin | 统计（包数/下载量/用户数） |
| POST | `/admin/packages/:id/review` | admin | 审核（通过/拒绝） |
| GET | `/admin/users` | admin | 用户管理 |

### 2.6 用户登录与鉴权流程

```
注册 → bcrypt 哈希密码存 users
登录 → 校验密码 → 签发 JWT { uid, role, exp: 7d }
请求 → middleware 校验 JWT → 注入 req.user
  - 公开浏览/下载：optionalAuth（不强制）
  - 创建/编辑/上传/发布：requireAuth + 作者校验
  - 管理：requireAuth + role=admin
```

JWT 载荷示例：`{ "uid": "u-xxx", "role": "user", "iat": ..., "exp": ... }`
刷新策略：客户端在 token 过期前用 `/auth/me` 触发静默续期（返回新 token）。

### 2.7 AnyDev 部署流程

遵循 AnyDev 规则（sudo + nohup + 重定向）：

1. **select_environment**：选择 AnyDev 环境（云服务器）。
2. **构建产物**：本地 `cd marketplace-server && npm install && npm run build`（含 web 构建），打包为 `marketplace-server.tar.gz`。
3. **file_upload**：上传 `marketplace-server.tar.gz` 到 AnyDev。
4. **webshell 执行**（root + nohup）：
   ```bash
   # 检查端口占用，停旧进程
   sudo fuser -k 3040/tcp 2>/dev/null || true
   # 解压
   sudo mkdir -p /opt/saros-marketplace && sudo tar -xzf marketplace-server.tar.gz -C /opt/saros-marketplace
   cd /opt/saros-marketplace
   sudo npm install --omit=dev
   # 初始化数据库
   sudo node src/db.js
   # nohup 启动
   sudo nohup node server.mjs > /var/log/saros-marketplace.log 2>&1 &
   ```
5. 返回访问地址：`http://<anydev-host>:3040`（网站）+ `http://<anydev-host>:3040/api/v1`（API）。

> 端口建议 3040，与现有 update-server（3030）区分。可通过 Nginx 反代到 443。

---

## 3. 管理网站设计

### 3.1 页面结构（React + Ant Design）

```
/ (公开商城浏览)
├── /login, /register          # 登录/注册
├── /explore                   # 浏览全部资源（按 kind Tab 切换）
├── /p/:slug                   # 资源详情页（描述/版本/changelog/下载）
└── /me (需登录)
    ├── /me/packages           # 我发布的资源列表
    ├── /me/packages/new       # 新建资源（选 kind → 填元信息）
    ├── /me/packages/:id/edit  # 编辑元信息
    ├── /me/packages/:id/versions       # 版本管理
    └── /me/packages/:id/versions/new   # 上传新版本（拖拽 tar.gz + 填 changelog）
/admin (管理员)
├── /admin/stats               # 仪表盘
├── /admin/review              # 待审核队列
└── /admin/users               # 用户管理
```

### 3.2 关键交互

- **在线编辑器**：对 agent/skill 支持 Markdown 编辑（AGENTS.md、SKILL.md 等），实时预览。Agent 的结构化字段（model、skills、tools）用表单编辑，引导文件用 Monaco/CodeMirror。
- **版本发布**：上传 `.tar.gz` 或在线打包（网站把表单内容生成 manifest + 文件并提交）。服务端校验 manifest 一致性、计算 sha256。
- **登录态**：JWT 存 localStorage，axios 拦截器自动注入 + 401 跳登录。

---

## 4. vsSarosis 客户端集成（上传/下载）

### 4.1 新增服务：`IMarketplaceService`

在 `src/vs/sessions/contrib/agentStudio/common/` 新增 `marketplace.ts`：

```ts
export const IMarketplaceService = createDecorator<IMarketplaceService>('marketplaceService');

export interface IMarketplaceService {
  readonly _serviceBrand: undefined;
  /** 商城服务端地址（来自配置 saros.marketplace.url，默认 AnyDev 地址） */
  readonly endpoint: string;
  /** 登录态 */
  login(username: string, password: string): Promise<{ token: string; user: UserInfo }>;
  getToken(): string | undefined;
  setToken(token: string | undefined): void;
  /** 浏览/搜索 */
  listPackages(opts: { kind?: PackageKind; q?: string; page?: number }): Promise<PagedPackages>;
  getPackage(slug: string): Promise<PackageDetail>;
  /** 下载安装到本地目录 */
  download(storeId: string, version: string, kind: PackageKind): Promise<InstallResult>;
  /** 上传本地资源到商城 */
  publish(localId: string, kind: PackageKind, changelog: string): Promise<void>;
  /** 升级检查（批量） */
  checkUpgrades(items: UpgradeCheckItem[]): Promise<UpgradeInfo[]>;
}
```

### 4.2 配置项

在 `agentStudio.contribution.ts` 注册配置：
```jsonc
"saros.marketplace.url": { "default": "http://<anydev>:3040", "description": "商城服务端地址" }
"saros.marketplace.autoCheckUpdates": { "default": true, "description": "启动时自动检查资源更新" }
"saros.marketplace.updateInterval": { "default": 3600, "description": "检查间隔(秒)" }
```

### 4.3 下载安装流程（复用现有目录结构）

```
download(storeId, version, kind):
  1. GET /api/v1/packages/{storeId}/versions/{version}/download → package.tar.gz
  2. 校验 sha256
  3. 解压 manifest.json，按 kind 分流安装：
     - agent  → 写入 ~/.saros/agents/custom/{id}/（agent.json + agent.yaml + 引导文件）
                并合并到 custom-agents.json（复用 AgentStudioService.createAgent）
     - skill  → 写入 ~/.saros/skills-library/{id}/SKILL.md
                （复用 ISkillRegistry.reload() 刷新）
     - mcp    → 写入 ~/.saros/mcp-servers/{id}/config.json
                注册到 MCP 管理视图（复用 pluginsView / mcpServerEditorPane）
     - knowledge → 写入 ~/.saros/knowledge-base/{id}/
  4. 写入本地「已安装清单」~/.saros/installed-packages.json：
     { storeId, kind, version, installedAt, contentHash }
  5. 触发对应 registry reload
```

### 4.4 上传发布流程（复用现有导出格式）

```
publish(localId, kind, changelog):
  1. 按 kind 打包本地资源为 package.tar.gz：
     - agent  → 复用现有 AgentExportData 导出逻辑
                （agentStudioService 已有 export，组装 agent.json + agent.yaml + 引导文件）
     - skill  → 读取 ~/.saros/skills-library/{id}/SKILL.md + frontmatter
     - mcp    → 读取 mcp-servers/{id}/config.json
     - knowledge → 打包 docs/ + index.json
  2. 生成 manifest.json（version 取本地版本；无则提示填）
  3. POST /api/v1/packages/{storeId}/versions  (multipart: manifest + tar.gz)
  4. 成功后更新本地 installed-packages.json 的 version/storeId
```

> 关键复用点：Agent 的 `AgentExportData` 已是完整可移植格式；Skill 的 `ISkillDefinition.storeId/updateUrl/version` 字段已为升级预留——上传时把 `storeId` 写回本地 SKILL.md frontmatter。

### 4.5 UI 集成

在 Agent Studio 现有视图基础上新增：
- **资源市场视图**（`marketplaceView.ts`）：浏览/搜索/下载，复用现有 `presetAgentView.ts` 的列表样式。
- **发布按钮**：在 agent 编辑器 / skill 列表 / mcp 详情中加「发布到商城」操作。
- **登录面板**：`marketplaceLoginPanel`，输入用户名密码，token 持久化到 SecretStorage。

---

## 5. 本地升级机制

### 5.1 已安装清单

`~/.saros/installed-packages.json`：

```jsonc
{
  "packages": [
    {
      "kind": "skill",
      "storeId": "pdf",
      "localId": "pdf",
      "version": "1.0.0",
      "contentHash": "sha256:...",
      "installedAt": "2026-06-20T10:00:00Z",
      "updateUrl": "http://<anydev>:3040/api/v1/packages/pdf"
    }
  ],
  "lastUpgradeCheck": "2026-06-23T10:00:00Z"
}
```

> 注意：Skill 的 `ISkillDefinition` 已有 `storeId/updateUrl/version/contentHash`——安装/升级时把这些字段写回 SKILL.md frontmatter，使现有 SkillRegistry 自然成为升级数据源。

### 5.2 升级检查

- **触发时机**：客户端启动后 + 每 `updateInterval` 秒 + 用户手动「检查更新」。
- **批量检查**：读取 installed-packages.json → `POST /api/v1/upgrade/check` → 返回有更新的项。
- **结果展示**：通知/徽章提示「N 个资源可更新」，点击进入升级面板。

### 5.3 升级执行流程

```
upgrade(storeId, kind):
  1. 调用 checkUpgrades 得到 latestVersion + downloadUrl + sha256
  2. 语义化版本比较：latestVersion > currentVersion 才升级
  3. 下载 package.tar.gz，校验 sha256
  4. 备份当前本地目录 → ~/.saros/backup/{kind}/{id}/{oldVersion}/
  5. 解压覆盖安装（同 download 安装流程）
  6. 更新 installed-packages.json：version/contentHash/installedAt
  7. 写回资源自身元数据（SKILL.md frontmatter / agent.json 等）
  8. registry reload；通知用户「升级成功」
  9. 失败则回滚备份
```

### 5.4 版本号语义

- 采用语义化版本 `MAJOR.MINOR.PATCH`。
- 知识库等非代码资源可用日期版本 `2026.06`。
- 升级比较：`semver.gt(latest, current)`；非语义化则按字符串/时间戳。

### 5.5 与客户端热更新（update-server）的关系

| 维度 | update-server（已有） | marketplace upgrade（新增） |
|------|----------------------|---------------------------|
| 更新对象 | vsSarosis 客户端本体（exe） | agent/skill/mcp/知识库 资源包 |
| 协议 | `GET /api/update/{platform}/{quality}/{commit}` | `POST /api/v1/upgrade/check` |
| 比较基准 | git commit sha | 语义化版本 |
| 部署位置 | 21.91.41.66:3030 | AnyDev :3040（新服务） |
| 触发 | 客户端启动每小时 | 资源管理面板 + 定时 |

> 两者独立运行、互不干扰。可后续统一到一个域名下用路径区分。

---

## 6. 安全与完整性

| 风险 | 措施 |
|------|------|
| 包被篡改 | 每版本存 sha256；下载/升级时客户端校验 |
| 恶意包 | 上传需登录；管理员审核（status=pending_review）；可加沙箱试运行 |
| 越权编辑 | 服务端校验 author_id；JWT 携带 uid |
| 密码泄露 | bcrypt 哈希；HTTPS（Nginx 反代 + Let's Encrypt） |
| 滥用下载 | 限流（IP/token）；下载计数 |
| 大文件 | multer 限制 size；分 kind 设上限（agent≤5MB, knowledge≤200MB） |

---

## 7. 实施路线（建议分阶段）

| 阶段 | 内容 | 产出 |
|------|------|------|
| **P1 服务端骨架** | Express + SQLite + JWT + packages/versions CRUD + 上传下载 | 可用 API + Postman 验证 |
| **P2 管理网站** | React 登录/浏览/编辑/发布页面 | 可访问的网站 |
| **P3 AnyDev 部署** | 打包 + file_upload + webshell nohup 部署 | 线上可访问 |
| **P4 客户端下载** | `IMarketplaceService` + 市场视图 + 下载安装（先 agent/skill） | 客户端可浏览下载 |
| **P5 客户端上传** | 打包发布流程（复用 AgentExportData / Skill frontmatter） | 客户端可发布 |
| **P6 升级机制** | installed-packages.json + checkUpgrades + 升级面板 | 本地资源可升级 |
| **P7 MCP/知识库** | 补齐 mcp/knowledge 的打包/安装/升级 | 四类资源全覆盖 |

---

## 8. 关键复用清单

| 现有资产 | 文件 | 复用方式 |
|---------|------|---------|
| Agent 可移植格式 | `agentStudioTypes.ts` `AgentExportData` (253-272) | 上传/下载 agent 包的 payload |
| Agent CRUD | `agentStudioService.ts` `AgentStudioService` | 下载安装时 createAgent |
| Skill 升级字段 | `skills.ts` `ISkillDefinition` (storeId/updateUrl/version/contentHash, 66-71) | 升级检查数据源 |
| Skill 目录约定 | `~/.saros/skills-library/<id>/SKILL.md` | skill 安装路径 |
| Skill 注册表 | `skills.ts` `ISkillRegistry.reload()` | 安装/升级后刷新 |
| MCP 市场/编辑器 | `knotMcpMarket.ts`、`mcpServerEditorPane.ts`、`pluginsView.ts` | mcp 包格式 + 安装注册 |
| Agent Gallery | `agentInstance.ts` `IAgentGalleryService` | 市场视图复用展示模式 |
| update-server 思路 | `deploy-package/update-server/server.mjs` | 版本比对/feed 设计参考 |
| AnyDev 规则 | `.codebuddy/rules/anydev/rules/anydev.mdc` | 部署命令规范（sudo+nohup） |

---

## 9. 开放问题（待确认）

1. **知识库的 RAG 实现**：客户端侧是否需要向量检索？还是纯关键词/全文？建议 P7 先做全文，向量索引作为可选增强。
2. **私有/团队可见性**：`visibility=private` 是否需要团队/组织概念？当前设计为作者私有，团队空间可后续扩展。
3. **资源审核**：是否所有上传都需管理员审核，还是仅 mcp/agent（可执行类）需审核？建议可执行类必审，skill/knowledge 自动发布+举报机制。
4. **现有 update-server 是否合并**：是否将 3030 的客户端热更新也迁入 3040 商城服务（同进程不同路由）？建议可合并以减少运维点。
