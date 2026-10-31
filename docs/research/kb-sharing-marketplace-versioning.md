# 知识库：团队分享 · 商城分发 · 版本管理 —— 调研与优化建议

> 调研日期：2026-10-31
> 范围：`dsh-plugins/vssaros-kb`（知识库）、`vssaros-market` / `vssaros-marketplace`（商城）、`vssaros-kb-refs`（引用源）
> 方法：① **实测本仓代码**（关键词/路由/协议统计，见下）；② **外网检索**开源方案（Outline / Wiki.js / SiYuan / Trilium / Logseq / Anytype / AppFlowy / Obsidian 生态 / Quartz / Foam / Docusaurus / MkDocs / ctxpkg 等）对比。
> 标注约定：**【实测】**= 本仓代码里查到的；**【外部】**= 公开资料/社区结论。

---

## 0. 结论摘要（TL;DR）

| 维度 | 现状 | 建议主线 |
|---|---|---|
| **团队分享** | 只有**飞书同步**（导出到飞书知识库）+ 手动拷文件夹；无权限、无多端同步、无只读发布 | **先做"只读发布 + 引用"**（成本低、不引入服务端），再谈"多人协同" |
| **商城分发** | 商城协议完备（schemaVersion 2、三种分发、带 sha/license），但**可发布种类里没有"知识库"** | 新增 `kind: knowledge` 的**知识库包（kbpkg）**：manifest + 内容 + 附件策略，复用现成的 github-release / github-source 通道 |
| **版本管理** | **完全没有**（`share/publish/commit/diff` 命中 0）；只有 `/api/backup` 快照 | **分三层**：L0 自动快照（已有，加固） → L1 **Git**（本仓是 VS Code fork，自带 `extensions/git` v10，成本最低） → L2 页面级历史（基于 Git 或轻量 revision） |

三条主线里，**版本管理应该先做**：它既是分享/分发的前提（没有版本就没有"更新"和"回滚"），也是最容易出事的地方（误删、误覆盖）。

---

## 1. 现状盘点（本仓实测）

### 1.1 知识库的数据形态 【实测】

```
E:\VsSarosVault\            ← 一个"库"= 一个本地文件夹（不是 git 仓库，.git 不存在）
  ├── 笔记\                 ← 成稿区（可写）
  ├── 库\                   ← 原始素材区（只读；本轮新开了 库/raw 作为受控可写子区）
  ├── .kbkernel.json 类索引 / .kb-build-cache.json
  ├── .feishu-sync.json / .feishu-space-map.json   ← 飞书同步的映射与索引
  └── .canvas-text-migration-backup / .obsidian    ← 备份痕迹 + Obsidian 残留
```

- 库 = **外部文件夹登记**（`.extra-vaults.json` 记 `id / name / path`），一个库就是一个磁盘目录。
- 服务端路由（`/x/kb/api/*`）共 30+ 条：view-data / new / rename / delete / doc / search / graph / canvas / backup / feishu-* …

### 1.2 三个维度的关键词命中 【实测，`vssaros-kb/lib/index.js`】

| 关键词 | 命中次数 | 含义 |
|---|---|---|
| `share` | **0** | 没有任何"分享"概念 |
| `publish` | **0** | 没有发布 |
| `commit` / `diff` | **0 / 0** | **没有任何版本管理** |
| `git` | 1 | 无关（非集成） |
| `sync` | 177 | 全是**飞书同步** |
| `backup` / `snapshot` / `restore` | 56 / 43 / 有 `/api/backup`、`/api/backup/restore`、`/api/restore` | 只有**快照式备份** |
| `import` / `export` | 48 / 11 | 多是 JS import 与附件导出，不构成"库级导入导出" |

### 1.3 商城现状 【实测】

`vssaros-market/lib/catalog.js` 头部注释写明目录协议 **schemaVersion 2**，对齐 dsh 工作台公共市场；`vssaros-marketplace/lib/githubSource.js` 写明三种分发：

```
npm             → name = 包名
github-release  → url  = Release 资产直链（https）
github-source   → name = owner/repo（commit 可选）
```

- 可发布种类（`dispatch.js` 提取）：**skill / workflow / agent / mcp / plugin / workbench** ⇒ **没有 knowledge / 知识库** ❌
- 已有要素：`version`（22 处）、`sha`（7 处，可校验）、`license`（5 处）⇒ **包级别的版本与校验是现成的**，只需扩种类。

### 1.4 引用现状 【实测】

`vssaros-kb-refs`：host 侧**故意空实现**，全部工作在 client 侧 —— 把 `@知识库` 注册为 **`ctx.inputTriggers.registerSource`**（聊天里 @ 引用知识库内容），候选走同源 HTTP 打 KB 的**只读路由**。
⇒ 这是"**引用**"（读别人的库），不是"**分享**"（把我的库给别人）。

### 1.5 一个关键的地利 【实测】

```
extensions/git 存在 = true   name=git version=10.0.0
```

⇒ 本仓是 **VS Code 系 fork，自带完整的 Git 扩展**（暂存、diff、提交、分支、历史、GitLens 式行级追溯）。
⇒ **版本管理最省力的路线就是"把库变成 Git 仓库 + 复用 IDE 现有 Git 能力"**，不必自研 diff/合并引擎。

---

## 2. 维度一：团队之间怎么分享

### 2.1 先把"分享"拆成四种形态（避免一上来做最难的）

| 形态 | 定义 | 难度 | 本项目现状 |
|---|---|---|---|
| **A 同步** | 多端/多人看到同一份内容（可写） | 高（冲突、权限、服务端） | 无 |
| **B 协作** | 权限、评论、审阅、锁定 | 高（要账号体系） | 无 |
| **C 发布** | 生成**只读**副本（站点/导出包/链接）给团队看 | 中低（无需服务端状态） | 只有飞书同步（其实是"搬到飞书"） |
| **D 引用** | 别人的库挂进来当上下文（可只读引用） | 低 | **已有**（`@知识库` 输入源） |

**建议顺序：D（已有）→ C（先做）→ A（再做）→ B（最后，且要账号体系）**。

### 2.2 开源方案对比 【外部】

| 项目 | 形态 | 共享方式 | 版本/历史 | 优点 | 缺点 | 对本项目适配度 |
|---|---|---|---|---|---|---|
| **Outline** | 服务端 Wiki | 团队/组/页面级权限、分享链接 | 页面历史（revision） | 体验接近 Notion、权限成熟、40k star | 要服务端+Postgres+Redis，重 | 低（我们是本地优先，不该引入服务端） |
| **Wiki.js** | 服务端 Wiki | 用户/组/页面级权限、LDAP/SAML | **Git 同步**（原生） | 权限细、Git 同步正好是我们要的 | Node+DB 运维、编辑器偏文档站 | 中（**Git 同步思路值得抄**） |
| **SiYuan 思源** | 本地优先 | 自托管同步、三级权限（只读/注释/编辑） | 快照 + 历史 | 中文生态好、块级引用、自带同步 | 同步要自托管服务 | **高（本地优先 + 块级 + 同步，形态最接近）** |
| **Trilium** | 本地/自托管 | 同步服务器 | **笔记级 revision**（自动版本） | 版本粒度细、树形组织强 | 生态小、UI 旧 | 中高（**revision 模型可抄**） |
| **Logseq** | 本地优先 | Git / 文件同步；DB 版走 RTC | 文件版靠 Git | 大纲/双链强、纯文本 | 实时协同仍在演进 | 中 |
| **Anytype / AppFlowy** | 本地优先 + CRDT | P2P/自托管同步 | CRDT 自带历史 | 冲突自动收敛、离线友好 | 协议复杂、调试难、改造成本高 | 中（**长期目标，不建议现在上**） |
| **Obsidian + Quartz** | 本地 + 静态发布 | **发布为静态站点**（数字花园） | 靠 Git | 零服务端、可公开/内网托管、保留双链与图谱 | 只读、无权限（要么全公开） | **高（分享的最小可用解）** |
| **Foam / Docusaurus / MkDocs** | 文档站生成 | 发布站点 | Git | 工程化成熟、版本化文档（Docusaurus 支持多版本） | 面向"文档"而非"笔记/库" | 中（发布层可借鉴） |
| **Confluence** | 企业 Wiki | 权限/评论/页面历史 | 页面历史 | 权限与流程最成熟 | 重、商业授权 | 低（不符合本地优先定位） |

### 2.3 优缺点小结

- **服务端 Wiki（Outline/Wiki.js/Confluence）**：协作能力最强，但**违背本项目"库 = 本地文件夹"的核心模型**，且要运维服务端 ⇒ 不建议。
- **CRDT（Anytype/AppFlowy）**：体验最好（无冲突），但**协议复杂 + 调试难**，对现有"文件 = 事实"的模型是颠覆性改造 ⇒ **列为长期方向，不要现在做**。
- **Git（Wiki.js 同步 / Obsidian Git / Logseq）**：与"文件即事实"天然契合，且本仓已有 Git 扩展 ⇒ **性价比最高**。代价是冲突需人工解决、不适合实时协同。
- **静态发布（Quartz / Obsidian Publish / Foam）**：**只读分享的最小解**，零服务端 ⇒ **最该先做**。

---

## 3. 维度二：上传到商城

### 3.1 现成的基础设施（好消息）【实测】

商城已经有一套**可直接复用**的发布链路：

- 目录协议 `schemaVersion 2`，条目身份 = `owner/repo`（对齐 dsh 公共市场）
- 三种分发：`npm` / `github-release`（Release 资产直链）/ `github-source`（`owner/repo` + 可选 commit）
- 条目已带 `version` / `sha` / `license`
- 安装侧已有"按描述算出下载直链 → 解包 → 找到真正安装根"的能力（`githubSource.js`）

**缺的只是：一个 `kind: knowledge` 的种类 + 知识库包的打包/校验/安装语义。**

### 3.2 业界怎么管"发布" 【外部】

- **Obsidian 社区插件**：GitHub 公开仓库 + `manifest.json` + Release 资产（`main.js`/`styles.css`）→ 提交 PR 改中央注册表 → **自动化校验机器人**（`validate-plugin-entry.yml`）+ 人工审核 → 后续更新由用户端直接拉 GitHub Release。
  ⇒ 启示：**"注册表只登记指针、本体在 GitHub Release"** —— 与本项目 `github-release` 分发完全一致 ✓
- **VS Code Marketplace**：`vsce` 打包 `.vsix` + 校验（manifest、许可、图标、体积）。
- **新兴"上下文包管理器"**：`ctxpkg` / `knowledge-shelf` / `agent-docs`（npm 上已存在）—— **用 npm 式的语义管理"文档集合/上下文依赖"**（版本、依赖、安装目录）。
  ⇒ 启示：**知识库可以像依赖一样被安装**（`kb install @team/game-ui-kb@^1.2`），这对 AI 场景尤其契合。

### 3.3 建议：定义 **kbpkg（知识库包）**

```
game-ui-kb.kbpkg/                    ← 解包后的安装根
  ├── kbpkg.json                     ← 清单（必填）
  ├── 笔记/                          ← 成稿区
  ├── 库/                            ← 素材区（含 raw/）
  ├── assets/                        ← 附件（可选，见策略）
  ├── .kb-index.json                 ← 可选：预构建索引（装完即可用，不必首扫）
  └── README.md / LICENSE
```

`kbpkg.json` 建议字段（与现有 catalog 对齐）：

```json
{
  "schemaVersion": 1,
  "kind": "knowledge",
  "id": "owner/repo",
  "name": { "zh": "游戏 UI 管线", "en": "Game UI Pipeline" },
  "version": "1.2.0",
  "license": "CC-BY-NC-4.0",
  "entry": "笔记/00-索引.md",
  "sections": ["笔记", "库"],
  "assets": { "mode": "external", "base": "https://…/assets/", "sha256Manifest": "assets.sha256" },
  "index": { "file": ".kb-index.json", "buildVersion": "0.5.60" },
  "counts": { "notes": 128, "assets": 42, "bytes": 7340032 },
  "checksum": "sha256:…"
}
```

**关键设计决策：**

| 议题 | 建议 | 理由 |
|---|---|---|
| **附件怎么带** | 默认 `external`（外链 + sha256 清单），可选 `inline` | 知识库常有 PDF/图片，内联会让包变成几十上百 MB；外链也便于增量更新 |
| **要不要带索引** | **带**（可选字段） | 装完即用，省掉首次全量扫描（我们现在的 `/api/reindex` 对大库很慢） |
| **体积上限** | 建议 50MB（不含外链附件），超出走 git-source 或分片 | 与 Release 资产、下载体验匹配 |
| **版本规则** | **SemVer** + `sha256` 校验（现成字段） | 与 npm / 现有 catalog 一致；`^1.2` 语义可支持自动更新 |
| **命名空间** | 复用 `owner/repo` | 与现有商城条目身份一致，零新增概念 |
| **审核** | 自动化（清单校验 + 病毒/敏感词扫描 + license 必填）+ 人工抽检 | 对齐 Obsidian 模式；**知识内容**比代码更容易夹带 PII/版权内容，必须有 license 与扫描 |

---

## 4. 维度三：版本管理

### 4.1 三条路线对比

| 路线 | 代表 | 粒度 | 冲突处理 | 成本 | 适配本项目 |
|---|---|---|---|---|---|
| **① 快照** | 本项目 `/api/backup`、多数笔记软件的"备份" | 整库 | 无（覆盖/并列） | 低（已有） | 已具备，但**只能救急，不能协作** |
| **② Git（文件级）** | Obsidian Git、Wiki.js Git 同步、Logseq | 文件（行级可追溯） | 人工解决冲突（ours/theirs） | **低（本仓自带 Git 扩展）** | **★ 最优：契合"文件即事实"** |
| **③ CRDT / 操作级** | Anytype、AppFlowy、Logseq DB 版 | 块/字符 | 自动收敛 | 高（协议+调试） | 长期目标，现在别做 |

### 4.2 优缺点

**Git 的优点**：历史/回滚/分支/ blame 全都有；可离线；可对接任何远端（GitHub/GitLab/内网）；**本仓已有成熟 Git UI**；纯文本 Markdown diff 友好（正是我们的数据形态）。
**Git 的缺点**：二进制附件（PDF/图片）历史会膨胀（需 LFS 或外链）；移动端/手机上体验差；**冲突要人工解**（不适合多人同时改同一篇）；用户需要懂一点 Git。

**CRDT 的优点**：无冲突、实时协同、离线友好。
**CRDT 的缺点**：协议复杂、调试困难、生态实现少；与"文件即事实"的模型冲突（要改成操作日志）；**改造成本高、风险大**。

### 4.3 建议：分三层（渐进，不颠覆）

```
L0 自动快照（已有，加固）
   · 定时/关键操作前自动快照；保留 N 份 + 可一键回滚
   · 现在的 /api/backup 已有雏形 ⇒ 补：自动触发、保留策略、快照列表 UI

L1 Git（新增，主力）
   · 「把这个库变成 Git 仓库」一键初始化（git init + .gitignore + 首次提交）
   · .gitignore 必须排除：索引/缓存（.kb-html-cache、.kb-build-cache、.feishu-*）、临时目录
   · 自动提交策略：定时 or 空闲 or 关闭库时提交（参考 obsidian-git 的 auto-commit 间隔）
   · 冲突：先做**整文件 ours/theirs 选择**（简单可靠），不做三方合并
   · 直接复用 IDE 的源代码管理视图（diff / 历史 / 回滚）

L2 页面级历史（后做）
   · 方案 a（推荐）：基于 Git 提交做"这篇文档的修改历史"（git log -- <file>）
   · 方案 b：自己存 revision（写 .revisions/<hash>.md），适合没有 Git 的库
```

### 4.4 Git 路线的落地要点（避坑）

1. **先解决"哪些文件不该进版本"**：索引缓存（`.kb-*`）、飞书映射、临时媒体目录 —— 这些每次同步都会变，进 Git 会让历史全是噪音。
2. **附件策略**：默认**不入库**（走外链或 LFS）；否则几十 MB 的 PDF 会让仓库迅速膨胀。
3. **自动提交的提交信息**：`chore(kb): auto snapshot <时间>`，并区分"用户手动提交"。
4. **不要把 `.git` 当成同步**：Git 解决历史，不解决多人实时协同 —— 分享仍要靠 C（发布）或 A（同步）。
5. **冲突体验**：出现冲突时给出**两个版本的并排 diff**（复用 IDE 的合并编辑器），不要静默覆盖。

---

## 5. 分阶段优化建议

### P0（1–2 周，先止血 + 打地基）

| # | 事项 | 落点 |
|---|---|---|
| 1 | 库 → Git：一键 `git init` + `.gitignore` + 首次提交；复用 IDE SCM 视图 | `vssaros-kb/lib/index.js` 新增 `/api/kb-git`（init/status/commit/log/rollback），KB 设置页加开关 |
| 2 | 快照加固：自动触发 + 保留策略 + 快照列表/回滚入口 | 现有 `/api/backup` 扩展 |
| 3 | 商城扩种类：`kind: knowledge` + kbpkg 清单校验（必填 license/version/checksum） | `vssaros-market/lib/catalog.js`（种类白名单）、`vssaros-marketplace`（打包/上传/安装） |
| 4 | 库级导出/导入：`/api/kb-export`（打 kbpkg）、`/api/kb-import`（装 kbpkg，含校验与去重） | `vssaros-kb/lib/index.js` |

> P0 结束时：**每个库都有历史（Git/快照）**，且**知识库能像一个包一样被导出与安装**（商城的种类打通后即可上架）。

### P1（3–6 周，把"分享"做出来）

| # | 事项 | 说明 |
|---|---|---|
| 5 | **只读发布**：把库（或某个子目录）导出为**静态站点**或**只读包**，可挂内网/公开 | 参考 Quartz/Foam：保留双链与图谱；不需要服务端 |
| 6 | **引用扩展**：`@知识库` 支持引用**团队里别人的库**（含商城装来的库） | 现有 `vssaros-kb-refs` 扩到"远程/已安装库" |
| 7 | **只读权限**：分享出去的库默认只读；写权限仅本地拥有者 | 与现有"库 = 本地文件夹登记"模型兼容 |
| 8 | **更新机制**：商城装来的库可检查新版本（`version` + `sha`）→ 增量更新 + 保留本地改动（冲突走 Git） | 复用 Git：把装来的库也初始化成 Git 仓库 ⇒ 本地改动与上游更新可 merge |

### P2（长期，谨慎）

| # | 事项 | 风险/前提 |
|---|---|---|
| 9 | 多人实时协同（CRDT） | **前提**：已有账号体系与冲突可观测；否则极易变成"数据悄悄被覆盖" |
| 10 | 评论/审阅/建议修改 | 需要服务端或至少共享存储 |
| 11 | 商城的评分/下载量/安全扫描流水线 | 需要后端与运营 |

---

## 6. 明确建议**不要**现在做的事

1. **不要先做"多人实时协同"**：没有版本管理就做协同 = 数据会悄悄被覆盖；且 CRDT 改造会颠覆"文件即事实"。
2. **不要引入服务端 Wiki 架构**（Outline/Confluence 式）：与"库 = 本地文件夹、数据自主"的定位冲突。
3. **不要把索引/缓存类文件纳入版本/发布包**：它们可再生，进去只会产生噪音与体积。
4. **不要一上来做全量附件内联**：PDF/图片让包体积失控；先走外链 + sha256 清单。

---

## 7. 参考（外部）

- Outline（团队 Wiki，开源，40k star）：https://outline.wiki/
- Wiki.js（Markdown + **原生 Git 同步** + 细粒度权限）：https://wiki.requarks.io
- SiYuan 思源（本地优先 + 块级 + 三级权限）：https://github.com/siyuan-note/siyuan
- Trilium（笔记级 revision）：https://github.com/zadam/trilium
- Anytype / AppFlowy（local-first + CRDT）
- Obsidian Git（vault 的 Git 版本管理，12k star）：https://github.com/Vinzent03/obsidian-git
- Obsidian 社区插件发布与审核流程（manifest + GitHub Release + 校验机器人）
- Quartz（笔记 → 静态站点/数字花园）：https://quartz.jzhao.xyz/
- Foam / Docusaurus / MkDocs（发布层与多版本文档）
- ctxpkg / knowledge-shelf / agent-docs（**上下文/文档的包管理器**新物种，npm 上可查）
- CRDT 介绍：https://crdt.tech/

---

## 8. 附录：能否在商城服务器里自建 Git 服务器，让所有用户的知识库版本管理都基于它？

### 8.1 先厘清："商城服务器"现在是什么 【实测】

| 事实 | 证据 |
|---|---|
| 商城**有后端** | `marketplace/lib/marketClient.js` 硬编码 `http://21.6.92.5` |
| 后端提供 | `/api/v1/**`、`/auth/tof`（TOF 登录换 JWT）、`/admin/review`（审核）、`/upgrade/check`（更新检查） |
| 后端**不托管内容** | 内容本体走三种分发：npm / github-release / github-source ⇒ **服务器只做"目录 + 认证 + 审核 + 元数据"** |
| 目录读取 | `market/lib/remoteCatalog.js`：拉一份 catalog（≤2MB，15 分钟缓存，磁盘快照）⇒ **静态目录文件**，不是内容服务 |

⇒ 所以"在商城服务器里搭 Git"**不是"加个功能"，而是"从 0 建一套内容托管服务"**（存储 + 协议 + 鉴权 + 配额 + 备份 + 合规）。

### 8.2 技术可行性：**完全可行**（Git 服务端门槛很低）

| 方案 | 形态 | 资源 | 适配度 |
|---|---|---|---|
| **Forgejo / Gitea** | Go 单二进制 + SQLite/Postgres，SSH+HTTP，带 LFS/镜像/配额/API/token | 几十 MB 内存起 | **★ 推荐**（MIT、轻量、可内网部署、API 完善） |
| `git-http-backend` + nginx | 官方 CGI，裸仓库即可 | 极低 | 可用（但权限/管理要自己写） |
| GitLab | 全家桶 | 4GB+ 内存 | 不推荐（太重） |
| 自研 Git 协议 | — | — | **不要**（轮子已存在且成熟） |

**结论：技术不是障碍，一个 Forgejo 容器就能跑起来。**

### 8.3 真正的障碍：**"所有用户 + 自动"** 这四个字

1. **隐私与合规（红线）**
   知识库是**私人笔记**（可能含 PII、公司内部资料）。"**所有用户的知识库自动**托管到我们的服务器" = **不问自取地上传用户私密数据**。
   ⇒ 必须满足：① **默认关闭**；② **显式授权**（开启时说清存什么、存多久、谁能看）；③ 可随时断开并取回；④ 若托管私人内容，应提供**客户端加密（E2EE）**——但代价是服务端无法 diff/搜索/在线浏览，只能当"加密备份桶"。

2. **存储与带宽**
   知识库常带 PDF/图片。若不限制，仓库会迅速膨胀（Git 对二进制历史极其不友好）。
   ⇒ 必须：① 附件走 **Git LFS** 或**干脆不入库**（外链 + sha256 清单，与 kbpkg 的附件策略一致）；② 配额（每用户体积/仓库数）；③ 定期 gc/清理。

3. **运维责任**
   一旦托管，就要负责：**备份、容灾、升级、监控、审计日志、数据删除请求**。这是持续成本，不是一次性开发。

4. **Git 本身不适合"多人同时改一篇"**
   自建 Git 能提供历史/回滚/分支，但**不解决实时协同与冲突**（冲突仍要人工解）。别把它当成"协同"方案。

### 8.4 三种路线对比

| 路线 | 做法 | 优点 | 缺点 | 建议 |
|---|---|---|---|---|
| **A 纯自建** | 商城服务器跑 Forgejo，**所有**库自动推上去 | 数据完全自主、不依赖 GitHub 可达性（国内网络的真实痛点）、权限/审计可控、与商城账号打通 | 隐私红线、存储/运维/合规成本高 | **仅限"公开库"** |
| **B 纯外部** | 远端由用户选（GitHub/GitLab/自建/纯本地） | 零托管责任、尊重数据自主、开发量最小 | 国内访问 GitHub 不稳、无法统一管控 | **私人库的默认** |
| **C 混合（推荐）** | 本地 Git 打底 + 远端可选（GitHub / GitLab / **自建 Forgejo** 三选一）+ **只有主动发布到商城的库才进自建服务器** | 兼顾自主与责任、风险可控、逐步建设 | 需要一层"远端适配器" | **★ 采用** |

### 8.5 推荐落地路径

```
P0 本地 Git（无服务器依赖，先把价值做出来）
   · 库 → git init + .gitignore + 自动提交，复用 IDE 的 SCM 视图（diff/历史/回滚）
   · 这一步不需要任何服务器 ⇒ 立刻可做，也是后面一切的前提

P1 远端抽象层
   · 定义 remote 适配器：local / github / gitlab / forgejo
   · 用户在库设置里显式选远端并授权（默认 local=只在本机）

P2 自建 Forgejo 上线（作为"可选远端之一"）
   · 内网部署；复用商城 JWT（/auth/tof）自动建号与 namespace（kb/<user>/<vault>）
   · 配额 + 审计 + LFS（或附件不入库）+ 定期快照备份
   · 与 GitHub 并列出现在"远端类型"里，让用户选

P3 公开库的自动托管
   · 只有用户**主动发布到商城**的库，才自动在自建 Git 上建仓库（此时内容是公开/授权的 ⇒ 无隐私风险）
   · 商城的"知识库条目"= 自建 Git 仓库 + version tag + checksum
```

### 8.6 一句话结论

> **能建，而且技术上很省事（一个 Forgejo 就够）。但"所有用户的知识库都自动基于它"不建议——那会把我们的服务器变成用户私密笔记的托管方，隐私、合规、存储、运维四座山同时压过来。**
>
> 正确顺序是：**先做不依赖服务器的本地 Git（P0）** → **把"远端"做成可选项（P1）** → **自建 Forgejo 作为选项之一上线（P2）** → **只有主动发布的公开库才自动托管（P3）**。
