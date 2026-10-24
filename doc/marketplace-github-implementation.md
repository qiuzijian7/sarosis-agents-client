# 商城工作台 · GitHub 源实现分析（2026-10-23）

**范围**：`dsh-plugins/vssaros-marketplace/` 里与 GitHub 相关的四条链路 —— 归一化、发布、安装、安全边界，以及客户端 UI 的入口设计。

**核心需求（2026-10-22）**：「上传的技能 / agent / mcp / 工作台，**本体就是一个 GitHub 地址**」⇒ 商品**不打包**，只登记"从哪拿"，安装时按地址去取。

---

## 1. 分层：四个文件各管一段

| 文件 | 职责 | 规模 |
|---|---|---|
| `lib/githubSource.js` | **纯函数层**：地址归一化 / 域白名单 / 算下载地址 / 定位安装根 / 下载 tar.gz | 11 KB / 242 行 |
| `lib/publisher.js` | **发布**：`publishExternal()` 把归一化结果登记到服务端（不传本体） | 13 KB |
| `lib/index.js` | **安装**：`installFromExternal()` 串四步（取地址 → 下载 → 解包 → 定位根 → 落盘） | 32 KB |
| `lib/client.js` | **UI**：发布抽屉里的「从本机打包 / GitHub 地址」二选一 + 列表上的来源 tag | 29 KB |

**依赖复用**：解包用现成的 `lib/tar.js`（只做 tar.gz）—— 注释写明了"GitHub 的 `codeload.../tar.gz` 天生就是 tar.gz，zip 需要另写解压（`node:zlib` 只有 gzip）⇒ **不引入** zip"。

---

## 2. 归一化：六种地址形态 → 两种分发类型

```54:108:dsh-plugins/vssaros-marketplace/lib/githubSource.js
export function parseGitHubSource(input) {
```

| 用户粘的地址 | 归一化结果 |
|---|---|
| `owner/repo` | `{ type:'github-source', name:'owner/repo' }` |
| `https://github.com/owner/repo` | `github-source` |
| `.../tree/<ref>[/<subdir>]` | `github-source` + `commit:<ref>` |
| `.../blob/<ref>/<file>` | `github-source` + `commit:<ref>`（**取仓库根，忽略文件**） |
| `.../releases/download/<tag>/<asset>` | **`github-release`** + 直链 `url` |
| `codeload.github.com/o/r/tar.gz/<ref>` | `github-source` + `commit:<ref>` |

**为什么只保留两种**：服务端 `DistributionSchema` 本来就有 `npm / github-release / github-source` 三种；dsh 侧只补"用户随便粘的地址 → 这三者之一"。`owner/repo` 与 `.git` 后缀都会被 `stripGit()` 归一。

**注意一个取舍**：`tree/<ref>/<subdir>` 里的 **subdir 被丢弃**（`void rest`）—— 因为服务端没有字段能存子目录，改由安装时"自动定位入口文件"解决。这是一个**有意的降级**，不是遗漏。

---

## 3. 发布：只登记"从哪拿"

```209:227:dsh-plugins/vssaros-marketplace/lib/publisher.js
export async function publishExternal({ market, kind, localId, version, source, changelog = '', meta = {} }) {
```

流程与校验（**顺序即防御顺序**）：

1. `slug` 必须匹配 `^[a-z0-9][a-z0-9_-]*$`（服务端规则，前端先挡一道）；
2. 版本号**非空且非纯空白**；
3. `parseGitHubSource(source)` —— **在这一步就把"只允许 GitHub 域 / 只允许 https"钉死**；
4. `ensurePackage()` 确保包存在（首版自动建）；
5. `POST /packages/:slug/versions/external`，body = `{ version, changelog?, description?, category?, distribution }`。

**与普通发布的对比**：

| 维度 | `publishVersion`（本地打包） | `publishExternal`（GitHub 源） |
|---|---|---|
| 是否上传本体 | 是（`/versions/raw`，tar.gz） | **否**（只传描述） |
| 完整性 | 服务端存 sha256 | **没有 sha256**（服务端没登记） |
| 生效方式 | 装完即用 | 安装时**现场从 GitHub 取** |

---

## 4. 安装：四步 + 一次"猜测的替换"

```322:335:dsh-plugins/vssaros-marketplace/lib/index.js
async function installFromExternal({ dataRoot, kind, storeId, version, distribution, upgrade }) {
```

```
distribution ──resolveDownloadUrl──▶ 可下载的 tar.gz 地址
             ──downloadGitHubTarball──▶ Buffer（带 4 道安全闸）
             ──listTarGzEntries──▶ 扁平文件列表
             ──locateInstallRoot──▶ 剥前缀后的文件集 + root
             ──installBundle──▶ 落盘（复用本地包那条路径）
```

**分流的触发点**：`manifest.distribution` 存在于版本记录里就走外部源，否则走商城下载 —— 也就是说**同一个商品的不同版本可以混用两种来源**。

### 4.1 为什么要"定位安装根"

GitHub archive 解出来顶层是 `<repo>-<ref>/`，而技能仓库常常把入口放在 `skills/<name>/SKILL.md`。不定位就会把**整个仓库**当技能装进去 ⇒ 装完技能列表里什么都没有。

```165:191:dsh-plugins/vssaros-marketplace/lib/githubSource.js
export function locateInstallRoot(files, kind) {
```

三条规则，**宁可报错也不猜**：

| 情况 | 行为 |
|---|---|
| 根目录就有入口文件 | 根就是安装根（`root: ''`） |
| 只有**唯一**目录含入口文件 | 那个目录为根，其余文件按前缀剥掉 |
| 找不到 | 报错：`包里找不到 SKILL.md（这一类商品的根目录必须包含它）` |
| 找到多处 | 报错并列全部候选：`包里有多处 SKILL.md（a、b）⇒ 不知道该装哪一个` |

入口文件按类型查表：`skill → SKILL.md`、`workflow → workflow.json`、`agent → .agent.md`。**其它类型直接报错**（"还没有安装根判据"）—— 这是 `mcp / workbench / knowledge` 目前装不了的原因，不是 UI 缺按钮。

---

## 5. 安全边界（全部是硬闸）

| 闸 | 实现 | 说明 |
|---|---|---|
| **域白名单** | `ALLOWED_HOSTS` 4 个：`github.com` / `codeload.github.com` / `objects.githubusercontent.com` / `raw.githubusercontent.com` | 精确匹配（`gist.github.com` 不放行）防 SSRF |
| **只走 https** | `parseGitHubSource` / `resolveDownloadUrl` / `downloadGitHubTarball` **三处各校验一次** | 不只入口校验，深调用也校验 |
| **体积上限** | `MAX_DOWNLOAD_BYTES = 64MB`；先看 `content-length` **预判**，读完再判一次 | 注释写明"超了立刻中止，不是下完再判" |
| **超时** | `AbortController` + 60s，`AbortError` 转成中文文案 | 不是静默挂死 |
| **重定向** | `redirect: 'follow'`，**但目标域已在白名单内**（Release 资产会 302 到 `objects.githubusercontent.com`） | 白名单恰好覆盖这条跳转链 |
| **npm 分发** | 明确抛错：`npm 分发需要 npm 客户端，dsh 侧暂不支持安装（可以改用 GitHub 地址）` | 不假装支持 |
| **不带商城 JWT** | 下载请求只带 GitHub 自己的重定向，不附带商城凭据 | 避免把凭据发给第三方 |

**一个如实的缺口**：外部源**没有 sha256**（服务端没登记摘要），所以**没有完整性校验** —— 代码注释里直接写明了这一点，没有伪装成"已校验"。

---

## 6. UI 特色（`client.js`）

**① 发布抽屉：来源二选一（分段按钮）**

```287:297:dsh-plugins/vssaros-marketplace/lib/client.js
h('div', { className: 'vs-mp-srcseg' },
```

- 两个按钮「从本机打包」/「GitHub 地址」，**选中的那个是 `primary`**；
- 副标题随模式变：GitHub 模式下写「本体就是一个 GitHub 地址 —— 只登记来源，不打包上传（安装时从 GitHub 取）」⇒ 用户在按「发布」之前就知道**不会上传任何东西**。

**② GitHub 模式的字段顺序**：类型 → 标识（带规则提示「小写字母开头，可含 -_」）→ **GitHub 地址**（placeholder 直接给两种合法形态）→ 名称 → 介绍；**版本 / 更新说明**两种模式共用（在下方）。

**③ 错误与忙碌态**：错误是**抽屉内一行** `.vs-mp-msg.error`（不弹窗、不清表单）；主按钮 `busy` 时文案变「发布中…」并 disabled。

**④ 列表上的来源标识**：`distributionType !== 'bundle'` 时渲染一个 `vs-mp-tag`（`github-source` / `github-release`）—— 用户能一眼看出"这个商品本体在 GitHub"；可升级时另加 `可升级 → vX` 的 warn tag。

**⑤ 动作层级**：`安装 / 升级` = `primary`，`卸载` = `danger`，其余 ghost 风格；tab 分「我的发布 / 已安装 / 管理」（`mine / installed / admin`）。

---

## 7. 缺口与可改进点（按价值排序）

| # | 缺口 | 影响 | 建议 |
|---|---|---|---|
| 1 | **无完整性校验**（外部源没有 sha256） | 上游仓库被改写/投毒时无法发现 | 发布时记录 `commit`（现已存 ref）并在安装时**校验 archive 内 `<repo>-<ref>` 前缀**是否与登记的 ref 一致；或登记 `sha256` 到服务端 |
| 2 | `commit` 缺省是 `HEAD` | 同一版本号可能装到不同内容（可变） | 发布时要求**必须给 ref**（tag/commit），`HEAD` 只允许预览 |
| 3 | **私有仓库不支持**（无 token） | 内部技能无法用 GitHub 源 | 加可选 token（只读、存 IDE 侧凭据，不落 dsh 配置） |
| 4 | `tree/<ref>/<subdir>` 的 subdir 被丢弃 | 单仓多技能时要靠"唯一入口"猜，多入口直接报错 | 服务端 `distribution` 加 `subdir` 字段，安装时按它定位 |
| 5 | `mcp / workbench / knowledge` 无安装根判据 | 这三类只能打包上传 | `ENTRY_OF` 补：`mcp → package.json`（含 mcp 字段）、`workbench → package.json`（含 vssaros.workbench）、`knowledge → 目录结构` |
| 6 | 无 ETag / 缓存 | 每次安装都全量下载 | 按 `owner/repo/ref` 缓存 archive（现在体积上限 64MB，重复装很浪费） |
| 7 | `github-release` 资产名未校验 | 用户粘任意 GitHub 直链都算合法 | 校验资产名后缀（`.tar.gz` / `.tgz`）并给出"只支持 tar.gz"的明确提示 |
| 8 | UI 没有地址的**即时校验** | 只有提交后才报错 | 输入时用 `parseGitHubSource` 试解析，把归一化结果（`owner/repo@ref`）实时显示在输入框下方 |

---

## 8. 附录：关键常量与错误文案

**常量**

| 名 | 值 | 用处 |
|---|---|---|
| `ALLOWED_HOSTS` | 4 个 GitHub 域 | SSRF 白名单 |
| `MAX_DOWNLOAD_BYTES` | `64 * 1024 * 1024` | 单包上限 |
| 默认超时 | `60_000ms` | 下载 |
| `ENTRY_OF` | `skill:SKILL.md` / `workflow:workflow.json` / `agent:.agent.md` | 安装根判据 |

**错误文案（都是给人看的，不是栈）**

- `看不懂这个地址：xxx（支持 owner/repo 或 https://github.com/...）`
- `只接受 https 的 GitHub 地址（收到 http://）`
- `只支持 GitHub 的地址（收到 gist.github.com）—— 其它域名不允许下载`
- `包里找不到 SKILL.md（这一类商品的根目录必须包含它）`
- `包里有多处 SKILL.md（a、b）⇒ 不知道该装哪一个，请把地址指到具体子目录所在仓库`
- `包太大（Content-Length 120.3MB > 上限 64MB）`
- `GitHub 下载超时（60s）：<url>`
- `npm 分发需要 npm 客户端，dsh 侧暂不支持安装（可以改用 GitHub 地址）`

---

## 9. 优化建议（按优先级，带落点与代价）

### P0：安全与不可变性（建议立即做）

**① 解压炸弹防护**（`lib/tar.js` · S · **已完成 2026-10-23，marketplace 0.2.14**）

> 落地结果：`MAX_UNPACKED_BYTES = 256MB` / `MAX_ENTRIES = 5000`；`listTarGzEntries` 改**流式** `createGunzip`，边解边累加、超限立刻 `destroy()`；`listTarEntries` 加条目计数。两个上限都可被调用方覆盖（测试用更小的值，不必真造 64MB 炸弹）。tar 守卫 **11 → 16 条**，变异测试（把两处 `if` 改成 `false &&`）精确红 3 条。

现状：`listTarGzEntries` = `gunzipAsync(gzBuf)` 然后整包解析 —— **没有解压后大小上限、没有条目数上限**。一个 64MB 的 tar.gz 可以膨胀到数 GB ⇒ OOM / 卡死。

建议：`gunzip` 走流式累加，超限立刻 `destroy()`；同时限制条目数。

```js
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 5000;
// 边解压边累加，超限抛：`包解开后太大（>256MB，疑似压缩炸弹）`
```

**② 下载改流式 + 进度**（`githubSource.downloadGitHubTarball` · S · **已完成 2026-10-23，marketplace 0.2.16**）

> 落地结果：优先用 `resp.body.getReader()` **边收边判上限**（内存只到上限，不再先吃满 64MB）；超限时 `reader.cancel()` **主动断连接**（不让服务端继续推）；新增 `onProgress(received, total)` 供 UI 画进度；**保留 `arrayBuffer()` 回退**（老运行时 / 测试 stub 只有它）。github 守卫 **63 → 70 条**；变异（把流式分支强制关掉）报 **5 条失败** —— 注意第一次变异时测试是**直接崩溃**而不是报 FAIL，因为那条断言没兜异常 ⇒ 已改成"失败即 FAIL"，这类"崩溃看起来像没失败"的坑值得记一笔。

现状：`await resp.arrayBuffer()` 一次性读满（上限 64MB），紧接着 `gunzip` 再复制一份 ⇒ 峰值内存 ≈ 2×64MB + 解压结果。

建议：读 `resp.body` 的 `ReadableStream`，边收边计数、超限即 abort；同时把已收字节数通过回调抛给 UI（"已下载 12.3MB / 64MB"）。**流式之后上限可以放宽**（因为不再占内存），但必须配合 ①。

**③ 发布即锁定 commit**（`publisher.publishExternal` + `githubSource` · M）

现状：`commit` 缺省 `HEAD`；`tree/<branch>` 登记的是分支名 ⇒ **同一个版本号可能装到不同内容**（可变源）。

建议：发布时若 ref 为空或是分支名，调 `GET https://api.github.com/repos/<o>/<r>/commits/<ref>` 拿 `sha` 再登记；登记 `commit: <sha>`。安装时 `resolveDownloadUrl` 用 sha（`codeload.../tar.gz/<sha>`）。

> 依赖：需要 `api.github.com`（可匿名，限流 60/h；带 token 5000/h）——顺带把私有仓库支持（⑥）一起解决。

**④ 完整性校验**（服务端 + 安装侧 · M）

现状：外部源**没有 sha256**，注释也如实写了"不做完整性校验"。

建议两条路（按成本从低到高）：
- **低成本**：安装时校验 archive 内顶层目录前缀 `startsWith('<repo>-')` 且**只有一个顶层目录**，ref 段与登记 ref 一致 ⇒ 至少挡住"装错仓库/装错分支"；
- **彻底**：服务端 `versions/external` 增加可选 `sha256`（发布方算），安装时比对 tar.gz 字节摘要；不匹配则拒装并提示"上游内容已变（可能被改写），请让作者重新发布"。

### P1：能力补齐（下一轮）

**⑤ `subdir` 支持**（服务端 schema + `locateInstallRoot` · M）

现在 `tree/<ref>/<subdir>` 的 subdir 被 `void rest` 丢弃，靠"唯一入口文件"猜 ⇒ **单仓多技能（`skills/a/`、`skills/b/`）必然报错**。

建议：`distribution` 增加 `subdir`（服务端字段），安装时优先按 `subdir` 定位，找不到再退回现有的三条规则。**这是把 GitHub 源用于 monorepo 的前置条件**。

**⑥ 私有仓库 token**（`githubSource` + IDE 凭据 · M）

`Authorization: Bearer <pat>` 只用于 `api.github.com` 与 `codeload`；token **只在内存里传递**，绝不落配置、绝不进日志/错误文案（现在错误文案里带完整 URL，需脱敏）。同时把 `ALLOWED_HOSTS` 保持精确匹配（已做）。

**⑦ 补齐三类安装根判据**（`ENTRY_OF` · S）

`mcp / workbench / knowledge` 目前直接报错"还没有安装根判据"。补：

| kind | 入口文件 | 二次校验 |
|---|---|---|
| `mcp` | `package.json` | 必须含 `mcp` 字段（或 `mcpServers`） |
| `workbench` | `package.json` | 必须含 `vssaros.workbench` + `exports['./client']` |
| `knowledge` | `笔记/` 或 `库/` 目录 | 至少一个非空 |

**⑧ 归档缓存**（`installFromExternal` · S）

按 `owner/repo@sha` 缓存 tar.gz 到 `<dataRoot>/.cache/github/`，命中直接解包 ⇒ 重装/升级同一版本不再全量下载。**必须先有 ③（sha 不可变）才能安全缓存**。

### P2：体验与可观测（有余力再做）

**⑨ 输入即时校验与规范化预览**（`client.js` · S）

输入框 `onChange` 里试跑 `parseGitHubSource`：合法就显示 `owner/repo@ref`（或 `release: tag/asset`）的绿字预览，非法显示红字原因。**现在只有提交后才报错**，用户得来回试。

**⑩ 错误分四类，给不同动作**（`index.js` + `client.js` · S）

| 类别 | 例子 | UI 动作 |
|---|---|---|
| 输入错 | `只支持 GitHub 的地址` | 聚焦输入框 |
| 网络错 | `下载超时（60s）` | 「重试」按钮 |
| 策略错 | `包太大` | 说明上限 + 「去 GitHub 看看」 |
| 包结构错 | `包里有多处 SKILL.md` | 列出候选 + 「指定子目录」（配合 ⑤） |

**⑪ 可观测性**（`index.js` · S）

安装成功/失败都写一条 op-log：`{ slug, version, distributionType, url(脱敏), bytes, ms, root, outcome }`。现在排查"装上了但列表里没有"只能翻控制台。

**⑫ 多入口时给交互选择**（`locateInstallRoot` 返回候选而非抛错 · M）

把"找不到唯一根"从**硬失败**改成**返回候选列表**，由 UI 让用户选（配合 ⑤）。

**⑬ 302 逐跳校验 + 资产名白名单**（`downloadGitHubTarball` · S）

- `redirect: 'manual'` 手工跟随，**每一跳都校验域**（现在是 follow 后不逐跳看）；
- `github-release` 的资产名限定 `.tar.gz` / `.tgz`，否则提前给"只支持 tar.gz"的明确提示。

---

## 10. 建议的最小批次

| 批次 | 内容 | 依赖 | 预期收益 |
|---|---|---|---|
| **第 1 批** | ① 解压上限（**已完成**）+ ② 流式下载（**已完成**） | 无（纯本仓） | 消除 OOM / 压缩炸弹风险；内存只到上限 ⇒ 体积上限可另行放宽 |
| **第 2 批** | ③ 发布锁 sha + ④ 低成本完整性校验 | 需要 `api.github.com` | 版本**可变 → 不可变**，这是能当正式渠道的前提 |
| **第 3 批** | ⑤ subdir + ⑦ 三类判据 | ⑤ 需服务端加字段 | 覆盖 monorepo 与 mcp/workbench/knowledge |
| **第 4 批** | ⑥ token + ⑧ 缓存 + ⑨⑩ 体验 | ⑥ 需 IDE 凭据 | 私有仓库可用、重装变快、报错可自助 |

> **如果只做一件事**：做 ①（解压上限）。它是唯一"不做就可能在用户机器上把内存打爆"的项，代价最小（十几行）。

---

## 11. 一句话总结

这套实现的**骨架是对的**：把"外部源"抽象成 `distribution` 描述符，发布只登记、安装才拉取，安全边界收敛在**一个纯函数文件**里（易测、易审），UI 也把"不上传本体"这件事明确告诉了用户。真正的短板在**不可变性**（`HEAD` 默认可变 + 无摘要校验）和**覆盖度**（`mcp / workbench / knowledge` 无安装根判据、私有仓库无 token）—— 这三条补上，GitHub 源就能当正式分发渠道用。
