# 商城新增「知识库」：可发布 / 可下载 / 可升级 —— 落地方案（v2，已核对服务端代码）

> 2026-10-31 · 服务端仓库：`g:\SarosWorkspace\saros-marketplace`（本次已逐文件核对）
> 目标：**任何人可分享发布 · 任何人可下载 · 知识库拥有者可升级**

---

## 0. 结论（v2 重要修正）

上一版我以为"服务端不在本仓、P1 要它配合"。核对后发现：

> **服务端对 `knowledge` 已经端到端打通** —— kind、上传通道、权限、下载、升级检测全都在。
> **真正缺的全在客户端（dsh 插件这一侧）**：打包器不认、安装器不认、装完不登记。

| 需求 | 服务端现状 | 结论 |
|---|---|---|
| 商城里有「知识库」这一项 | `src/packages/kinds.ts` 的 `PACKAGE_KINDS` **含 `knowledge`**；`isBundleKind('knowledge')=true`（可上传 tar.gz 本体） | ✅ **已有** |
| 任何人可分享发布 | `POST /api/v1/packages` → **`requireAuth`**（任何登录用户即可建包） | ✅ **已满足** |
| 任何人可下载 | 列表/详情/下载 → **`optionalAuth`**；`visibility` 默认 `public` ⇒ **未登录也能下** | ✅ **已满足** |
| 拥有者可升级 | `POST /api/v1/packages/:id/versions`（及 `/raw`、`/auto-generate`）→ `requireAuth` + **`assertAuthor`**（非作者非 admin ⇒ 403）；`upgrade/check` 用 `semverGt` 比对 | ✅ **已满足** |
| 知识库能装进客户端 | 客户端 `installers.targetRootOf` **不认 knowledge**、`publisher.PUBLISHABLE_KINDS` **不含 knowledge**、`dispatch` 把它推给 IDE（IDE 也没实现） | ❌ **要做的全在这里** |

---

## 1. 服务端事实清单（逐文件核对）

```
src/packages/kinds.ts
  PACKAGE_KINDS = ['agent','skill','mcp','knowledge','workflow','workbench','plugin']
  注释：「★ 这里列了就是全部。新增 kind 只改这一个文件」⇒ knowledge 已是合法 kind ✓
  isBundleKind(kind) = kind !== 'workbench'  ⇒ knowledge 走"包本体随版本上传" ✓

src/schema.sql（packages 表）
  kind 注释：-- agent | skill | mcp | knowledge | workflow | workbench | plugin
  visibility 默认 'public'；status 默认 'active'（active|pending_review|removed）
  distribution_type 默认 'bundle'；distribution_meta JSON{name,url,sha256,bytes,commit}

src/packages/permissions.ts
  canPublish = isAuthor || isAdmin；assertAuthor() 非作者 ⇒ 403

src/packages/routes.ts
  GET  /packages            optionalAuth      ← 未登录可读
  GET  /packages/:slug      optionalAuth
  POST /packages            requireAuth       ← 登录即可创建 ⇒ 任何人可发布
  PUT  /packages/:id        requireAuth
  DELETE /packages/:id      requireAuth

src/packages/versions.ts
  POST /packages/:id/versions         requireAuth + assertAuthor + multer upload
  POST /packages/:id/versions/raw     requireAuth + assertAuthor + express.raw(200mb)
  POST /packages/:id/versions/auto-generate 同上
  发布后重算 is_latest（按 semver 最大，不是最后上传）

src/packages/download.ts
  optionalAuth；仅 private 且非作者/非 admin 才 403 ⇒ 公开包谁都能下 ✓

src/packages/upgrade.ts
  POST /upgrade/check  optionalAuth；semverGt(latest, current) ⇒ 返回 downloadUrl/sha256/size

src/admin/routes.ts
  PUT /admin/packages/:id/status（active|pending_review|removed）⇒ 审核/上架/下架已有
```

---

## 2. 知识库包（kbpkg）定义

### 2.1 真实格式（从线上已发布的包里解出来的，不是设计稿）

商城数据库里**已经有 2 个 knowledge 包**，带真实包体：

```
vscode-dev-guide   v1.0.0    active/public   → data/assets/knowledge/…/1.0.0/package.tar.gz
sarosis-handbook   v2026.06  active/public   → data/assets/knowledge/…/2026.06/package.tar.gz
```

包内容（`tar -tzf`）：

```
patterns.md
index.json
manifest.json
```

`manifest.json`（**这就是契约，客户端照它产/消**）：

```json
{
  "kind": "knowledge",
  "id": "vscode-dev-guide",
  "name": "VS Code 扩展开发指南",
  "version": "1.0.0",
  "description": "VS Code 扩展开发参考",
  "category": "code",
  "author": "saros",
  "files": ["docs/patterns.md", "index.json"],
  "knowledge": {
    "id": "vscode-dev-guide",
    "name": "VS Code 扩展开发指南",
    "description": "扩展开发参考",
    "embedding": { "provider": "none" }
  }
}
```

⇒ 客户端打包时**必须**带 `knowledge: { id, name, description, embedding }` 块；安装时按 `files` 落盘。
（`embedding.provider: "none"` ⇒ 向量索引是可选能力，先不管。）

### 2.2 我们建议的包内容

解包后的安装根（由客户端 `targetRootOf` 决定：`<数据根>/knowledge/<slug>/`）：

```
  ├── kbpkg.json              清单（kind/id/version/license/entry/counts/checksum）
  ├── 笔记/                    成稿区
  ├── 库/                      素材区（含 raw/）
  ├── assets.sha256            外链附件校验清单（可选）
  └── .kb-index.json           可选：预构建索引（装完即用，免首扫）
```

| 议题 | 决定 | 理由 |
|---|---|---|
| 打包源 | 用户选**一个库** → 整个目录 | 服务端包格式就是"目录镜像"，零新格式 |
| 排除 | `.git/` `.tmp-media/` 索引缓存 `.obsidian/` `.kb-*` | 复用我们已有的 `.gitignore` 口径（体积 + 隐私） |
| 附件 | 默认外链 + sha256 清单，可选内联 | 内联会让包变几十 MB |
| 体积上限 | 建议 50MB（服务端 `/raw` 上限 200mb，够用） | 超出走外部发布源 |
| 版本 | SemVer + sha256（服务端已在校验/记录） | 与现有 catalog 一致 |

---

## 3. 要做的（全在客户端 `dsh-plugins/vssaros-marketplace` + `vssaros-kb`）

### 3.1 发布：让打包器认 knowledge

| 文件 | 改动 |
|---|---|
| `lib/publisher.js` | `PUBLISHABLE_KINDS` 加 `knowledge`；`KIND_DIR.knowledge='knowledge'`；`SIZE_LIMIT.knowledge=50MB`；`preparePublishBundle` 支持**外部源目录**（知识库源在用户选的库目录，不在 `<数据根>/<kind根>/` 下） |
| `lib/localResources.js` | 列出**可发布的库**（调 KB 的 `/x/kb/api/view-data` ⇒ vaults） |
| `lib/publishPreflight.js` | 加知识库专属体检（§4） |
| `lib/dispatch.js` | knowledge 的 publish 纳回 dsh 自持 |

### 3.2 安装：让安装器认 knowledge，并**登记成库**

| 文件 | 改动 |
|---|---|
| `lib/installers.js` | `targetRootOf` 加 `knowledge → <数据根>/knowledge` |
| `lib/installers.js` | 装完**额外一步**：`POST /x/kb/api/vault-add { mode:'attach', path:<安装根>, name }` ⇒ 否则装完在知识库里**看不见** |
| `lib/dispatch.js` | `LOCAL_WRITE_KINDS` 加 `knowledge`（从"推给 IDE"改成 dsh 自持） |
| `lib/installedState.js` | knowledge 的落地物就是那个目录 ⇒ 可查（比 plugin 好办） |

安装语义：**作为新库登记**，不覆盖已有库，同名自动加序号。

### 3.3 升级：复用服务端，补客户端两步

- 服务端 `upgrade/check` 已返回 `latest/downloadUrl/sha256` ⇒ 客户端只要比对 `installedVersion`。
- 客户端补：**升级前先把本地改动 git commit**（装来的库本身就是 Git 仓库），装完若有冲突 ⇒ 走**版本面板**让用户挑。

---

## 4. 知识内容的两道闸（≠ 代码）

### 4.1 隐私体检（发布前，客户端阻断）
扫待打包内容，命中则**默认阻止发布**，除非用户显式勾选"我确认可公开"：
- 绝对路径里的 `C:\Users\<人名>\`、内网域名、工号/邮箱/手机号
- 正文/ frontmatter 里的 `private / 内部 / 保密` 标记
- `.git` 远端地址（可能含内网仓库或 token）

> 知识库是私人笔记 —— 误发布比代码误发布严重得多。

### 4.2 审核（服务端已有钩子，按需开启）
`status` 目前默认 `active`（**发布即上架**）。若要强制审核，只需服务端把 knowledge 的默认改成 `pending_review`：
```sql
-- schema.sql：packages.status 默认值按 kind 决定（knowledge ⇒ pending_review）
```
管理员用已有的 `PUT /admin/packages/:id/status` 上架/下架 ⇒ **不需要新接口**。

---

## 5. 分阶段（v2：工作量比 v1 小很多）

| 阶段 | 内容 | 在哪改 | 依赖服务端 |
|---|---|---|---|
| **P0** | 打包器 + 安装器 + 登记成库（本地闭环） | 客户端（本仓） | **否** |
| **P1** | knowledge 发布后默认 `pending_review`（强制审核） | 服务端 1 行默认值 | 极小 |
| **P2** | 升级（比对 + 一键升级 + 保留本地改动 via Git） | 客户端（复用服务端 upgrade/check） | 否 |
| **P3** | 运营：下载量/评分/安全扫描/下架 | 两端 | 是 |

> **P0 与 P2 完全不依赖服务端改动** —— 现在就能做。

---

## 6. 风险与取舍

1. **发布即上架（status 默认 active）** ⇒ 误发布/垃圾内容会立刻可见。建议 P1 就开 `pending_review`。
2. **误发布私人笔记** ⇒ §4.1 的体检必须做。
3. **升级覆盖本地改动** ⇒ 必须走 Git 提交/冲突挑选（版本面板已具备）。
4. **体积** ⇒ 默认外链附件；内联 50MB 上限（服务端 `/raw` 允许 200MB，有余量）。

---

## 7. 与已做能力的衔接

- 每个装来的库都是 **Git 仓库** ⇒ 升级冲突有解、误改可回滚 ✓
- `.gitignore` 口径已有 ⇒ 打包排除项直接复用 ✓
- **LFS 已开** ⇒ 含素材的包不会把 git 撑大 ✓
- 远端抽象层的 `path` 类型 ⇒ 也可用共享目录分发，不依赖服务器 ✓

---

## 8. 参考文件

**服务端**（`g:\SarosWorkspace\saros-marketplace`）
`src/packages/kinds.ts` · `src/packages/permissions.ts` · `src/packages/routes.ts` ·
`src/packages/versions.ts` · `src/packages/download.ts` · `src/packages/upgrade.ts` ·
`src/schema.sql` · `src/admin/routes.ts`

**客户端**（本仓）
`dsh-plugins/vssaros-marketplace/lib/{publisher,installers,dispatch,installedState,publishPreflight,localResources}.js` ·
`dsh-plugins/vssaros-market/lib/catalog.js` · `dsh-plugins/vssaros-kb/lib/core/kbGit*.js`
