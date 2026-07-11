# 知识库 URL 导入 · 数据抓取增强设计方案

> 基于 `obsidian-clipper` 源码分析，对 `kbUrlScraper.ts`（v1）提出升级方案。
> 目标：在知识库「导入链接 / URL」入口下，把小红书 / 抖音 / 知乎 / YouTube / B站 等主流平台的数据、视频可靠抓取到「库」分区。

---

## 一、Obsidian Clipper 源码分析（它强在哪）

### 1.1 运行环境优势：扩展 content script 拿到「实时 DOM」
- Clipper 是浏览器扩展，在页面上下文注入 content script，`document` 是 **JS 渲染后的完整 DOM**。
- 抖音 / YouTube / 小红书这类纯前端渲染（SPA）站点，内容全在运行时 DOM 里 —— 这是它对付 SPA 的根本能力。
- 我们的 `kbUrlScraper` 跑在 **VS Code fork 渲染进程**，没有远程页 DOM，只能 `IRequestService`（main 进程代理）`fetch` 原始 HTML，SPA 站点拿到的是空壳。

### 1.2 defuddle 内容抽取引擎（`src/api.ts` / `src/core/highlights.ts`）
- `new Defuddle(doc, { url }).parse()` 返回：
  `title / author / description / image / published / site / language / wordCount / schemaOrgData / metaTags / variables / content / favicon`。
- `createMarkdownContent(defuddleResult.content, url)`（来自 `defuddle/full`）把抽取出的 HTML 正文转干净 Markdown，并自动把相对 URL 解析为绝对 URL。
- defuddle 内部已处理：正文定位、导航/广告剥离、JSON-LD（`schemaOrgData`）结构化抽取。
- 对比我们 v1 的 `htmlToMarkdown`：只是 `safeSetInnerHtml` 后取 `textContent`，**丢掉标题层级、列表、链接、图片结构，噪声大**。应替换为 defuddle。

### 1.3 环境无关的 DocumentParser 抽象（`src/api.ts`）
- `clip()` 不依赖具体 DOM 实现，调用方传入 `documentParser`：
  - 浏览器用原生 `DOMParser`；
  - CLI（`src/cli.ts`）用 `linkedom`（`linkedomParser.parseFromString`）。
- 同一套抽取逻辑可在 浏览器扩展 / Node CLI / headless 环境复用。这正是我们要借鉴的可移植设计。

### 1.4 fetch 代理 + CORS 处理（`src/core/highlights.ts` `fetchDefuddled`）
- 扩展通过 `browser.runtime.sendMessage({action:'fetchProxy'})` 绕过 CORS；
  CORS 受限时再申请 `<all_urls>` 权限后重试。
- 异步路径（`src/core/reader-view.ts`）：`new Defuddle(doc, { url, fetch: proxyFetchAsResponse }).parseAsync()`，defuddle 可借助传入 fetch 惰性加载更多资源。
- 我们的 main 进程 `IRequestService` 已天然绕过渲染进程 CORS，等价于「扩展 fetch 代理」，可直接复用。

### 1.5 schemaOrgData 结构化数据
- 视频站（YouTube `VideoObject`、B站）页面常内嵌 JSON-LD。defuddle 抽出的 `schemaOrgData` 可拿到 **时长 / 上传日期 / 作者**，弥补 SPA 正文不可见的问题。
- v1 完全没利用结构化数据。

### 1.6 图片 / 媒体本地化
- 扩展侧依赖 Obsidian 1.8「Save images locally」，markdown 产出用绝对 URL，下游落盘时下载。
- 对我们的启发：抽取后要主动把 **正文 `<img>`、封面、视频直链** 下载到 `库/media/` 并把引用改写为本地相对路径（v1 只下了封面和视频直链，没处理正文图片）。

---

## 二、本仓库现状 vs Obsidian 的差距

已具备（v1，`kbUrlScraper.ts` + `knowledgeBaseView.ts`）：
- ✅ 平台识别 `detectPlatform` / `KB_URL_PLATFORMS`
- ✅ OG meta 正则解析 `parseMetaTags`
- ✅ video / article / mixed 分流与媒体 best-effort 下载
- ✅ 落盘 Markdown + 友好报错

差距：
1. ❌ 正文抽取用正则，噪声大、丢结构 → 换 defuddle。
2. ❌ 无 SPA 渲染能力：抖音 / YouTube / 小红书 fetch 到空壳 HTML，只能拿 OG meta。
3. ❌ 未利用 `schemaOrgData`（视频时长/作者/发布时间常拿不到）。
4. ❌ 未把**正文内图片**下载本地化（只下了封面和视频直链）。
5. ❌ 抽取与渲染进程强耦合，无环境无关抽象，难复用/测试。

---

## 三、设计方案

### 3.1 总体架构（两梯队 + 环境无关抽层）

```
URL 输入
  │
  ▼
[1] 平台识别  detectPlatform(url)                （已有，扩充视频站 host）
  │
  ▼
[2] 抓取策略路由
  ├─ A 路径（SSR/静态）：fetch HTML → defuddle 抽取 → markdown
  │      适用：知乎 / 掘金 / CSDN / 公众号 / 博客 / 新闻（大多数）
  └─ B 路径（SPA/视频）：headless 渲染 → 取实时 DOM → defuddle
         适用：抖音 / 小红书 / YouTube / B站 / TikTok / 快手
         （复用 agentDriverService / Saros Claw 已具备的 Playwright 能力）
  │
  ▼
[3] 结构化组装
  ├─ schemaOrgData → 视频时长 / 作者 / 发布时间
  ├─ metaTags(OG)  → 封面 / 描述（兜底）
  └─ defuddle.content → 正文 Markdown
  │
  ▼
[4] 媒体本地化
  ├─ 封面图、视频直链 → 库/media/
  └─ 正文内 <img> → 下载 + 改写为本地相对路径
  │
  ▼
[5] 落盘 Markdown（frontmatter + 正文 + 本地媒体引用）
```

### 3.2 关键架构决策：把「抓取 + 抽取」移到 Node / agent 进程
- 渲染进程受本 fork **Trusted Types 策略**限制（DOMParser 被拦截），且拿不到远程 DOM。
- 建议：抓取+抽取在 **main / agent 进程（Node 环境）** 执行，渲染进程只负责 UI 与落盘。
- Node 侧用 **`linkedom` 解析 HTML 喂给 defuddle**（与 obsidian CLI 验证过的组合一致）。
- 顺带支持 B 路径：Node 侧用 **Playwright** 渲染 SPA，再把 DOM 交给 defuddle。

```
渲染进程 (knowledgeBaseView)              Node/agent 进程 (新模块 KbScraperService)
  ┌──────────────────┐                    ┌──────────────────────────────┐
  │ handleImport(url)│ ── IPC ──────────▶ │ fetchHtml(url)              │
  │ importFromUrl    │ ◀─ 结果 ────────── │   ├ A: IRequestService/axios│
  │  · 弹 toast      │                    │   └ B: Playwright 渲染       │
  │  · 落盘 .md      │                    │ extractArticle(html,url)     │
  │  · 落盘 media/   │ ◀─ 媒体流 ─────── │   └ defuddle + linkedom     │
  └──────────────────┘                    │ downloadMedia(url,dir)       │
                                         └──────────────────────────────┘
```

### 3.3 抽取引擎替换 defuddle
- 新增依赖：`defuddle`、`defuddle/full`、`linkedom`（Node 解析）、可选 `playwright`。
- `parseMetaTags` 降级为 OG 兜底；主路径用 `defuddleResult.metaTags / schemaOrgData / image / published`。
- 正文 Markdown：`createMarkdownContent(defuddleResult.content, url)` 替代现有 `htmlToMarkdown` 正则。
- 视频时长/作者：从 `defuddleResult.schemaOrgData` 的 `VideoObject.duration / datePublished / author` 取。
- `extractArticle(html, url)` 封装（对齐 obsidian `clip()` 的 defuddle 调用）。

### 3.4 SPA / 视频站点 headless 渲染（B 路径）
- 在 `agentDriverService` 已有 Playwright 能力上，新增 `renderPageDom(url): Promise<string /*serialized html*/>`。
- 路由规则：平台 `type==='video'`，或检测到 SPA 特征（OG 正文空 + 含 `__NEXT_DATA__` / `window.__INITIAL_STATE__` / `ytInitialData`）→ 走 B 路径。
- 视频直链解析：
  - YouTube / B站：headless 内读 `__NEXT_DATA__` / JSON-LD / `ytInitialData` → `formatStream` 直链 → `streamToBuffer` 下载。
  - 抖音：headless + 反爬 cookie 注入（后续迭代）。
  - m3u8 分片：后续接 `ffmpeg` 合并。

### 3.5 媒体本地化
- 封面：`meta.image / og:image` → `库/media/<base>_cover.<ext>`。
- 视频直链：B 路径拿到 → `库/media/<base>.<ext>`（mp4/webm…）；m3u3 暂不支持。
- 正文图片：扫描 `defuddleResult.content` 内 `<img>`，逐个下载，改写 `src` 为本地相对路径。
- 全部失败兜底：保留原始远程 URL（v1 已做）。
- 下载并发限制 ≤ 4，超时 ≤ 15s。

### 3.6 落盘格式（带 frontmatter）

```markdown
---
title: 示例标题
source: https://xhslink.com/xxx
platform: 小红书
author: 某用户
published: 2026-07-10
type: mixed
tags: [穿搭, 教程]
---

# 示例标题
> 摘要：……

![封面](media/xxx_cover.jpg)

正文 Markdown……

视频 / 图片文件：[标题](media/xxx.mp4)  或  ⚠️ 未能直接下载（平台反爬），附原文链接
```

---

## 四、与现有 kbUrlScraper 的兼容 / 迁移

- 保留 `detectPlatform` / `KB_URL_PLATFORMS`（扩充视频站 host：tiktok / kuaishou / vimeo 等）。
- `parseMetaTags` 保留作 OG 兜底；主抽取走 defuddle 封装 `extractArticle`。
- `importFromUrl(url, target)` 改为：发 IPC → `KbScraperService` 的 `scrape(url)` → 拿回结构化结果 → 渲染进程落盘 `.md` 与 `media/`。
- 媒体下载 `tryDownloadMedia` 保留并增强（支持正文图片批量、并发限制、超时）。

---

## 五、测试用例设计

### 5.1 单元测试（纯函数，vitest；复用 obsidian fixtures 思路）
准备真实页面 HTML 样本（`notes/fixtures/`：知乎 / 掘金 / 公众号 / YouTube / B站 / 小红书 / 抖音），断言：

| 用例 | 输入 | 预期 |
|---|---|---|
| T1 平台识别 | `douyin.com/x/…` | ⇒ douyin, type=video |
| T2 平台识别 | `unknown.com` | ⇒ generic, type=article |
| T3 OG 解析 | 含 `og:title/image` 的 HTML | `parseMetaTags` 正确抽取 |
| T4 defuddle 正文 | 知乎文章 HTML | `extractArticle` 产出含标题/作者/正文 markdown，且不含 nav/footer 噪声 |
| T5 视频 schema | YouTube HTML（含 `VideoObject` JSON-LD） | `schemaOrgData` 解析出 duration/published |
| T6 guessMediaExt | `a.mp4?x=1` ⇒ mp4；mime `video/webm` ⇒ webm |
| T7 isDownloadableMedia | `.m3u8` ⇒ false；`.mp4` ⇒ true |
| T8 formatDuration | 201 ⇒ `3:21`；3661 ⇒ `1:01:01` |
| T9 composeArticleMarkdown | meta+body | 标题/来源/封面引用齐全 |
| T10 composeVideoMarkdown | 已下载 ⇒ 含本地路径；未下载 ⇒ ⚠️ 提示 |
| T11 正文图片本地化 | content 含 3 个 `<img>` | 改写后 3 个 `src` 指向 `media/`，远程 URL 被替换 |
| T12 实体解码 | `&amp; &nbsp;` | 解码为 `&` 与空格 |

### 5.2 集成 / 端到端测试
| 用例 | 场景 | 验证 |
|---|---|---|
| E1 SSR 文章 | `importFromUrl(知乎链接)` | 落盘 .md 含正文+作者，库分区刷新，toast 成功 |
| E2 视频 OG 兜底 | 抖音分享链接，未启用 headless | 落盘含 OG 元信息 + ⚠️ 未能下载提示 |
| E3 视频 headless 下载 | 启用 B 路径 + B站 | 媒体落盘 `media/`，md 引用本地路径 |
| E4 封面+正文图本地化 | 小红书 mixed | `media/` 含封面与正文图，md 全本地引用 |
| E5 受限 / CORS 失败 | 返回 403 的 URL | 友好 toast 报错，不崩溃，日志记录 |
| E6 重试 / 幂等 | 同名文件再次导入 | `uniqueName` 处理，不覆盖 |
| E7 超大页面 | 长文 > 5MB | 抽取不 OOM，落盘成功 |

### 5.3 性能 / 健壮性
- 超时：fetch 超时（≤15s）走兜底 meta。
- 反爬：UA 轮换、可选 cookie 注入（B 路径）。
- 并发：批量导入媒体下载并发 ≤ 4。
- 内存：流式 `streamToBuffer`，禁止整页 HTML 常驻。

---

## 六、落地步骤（建议顺序）

1. 在 Node 侧新建 `KbScraperService`：`fetchHtml`（IRequestService 代理）+ `linkedom` + `defuddle` 抽取 `extractArticle`，先覆盖 A 路径（知乎/掘金/CSDN/公众号/博客）。
2. 渲染进程 `importFromUrl` 改为 IPC 调用 `KbScraperService.scrape(url)`，落盘逻辑复用。
3. 补正文图片本地化 + frontmatter 格式。
4. 接入 B 路径：Playwright 渲染 SPA，先攻 YouTube/B站 直链，再抖音。
5. 补齐 §5 单元测试 + 集成测试。

---

## 七、测试落地状态（实际实现）

> 因调研发现本 fork 已内置 `IWebContentExtractorService`（真实 Chromium 渲染，SPA 可抓），
> v2 实现**未**采用 §三 的 `defuddle + linkedom + 自建 KbScraperService` 路线，而是直接复用该服务。
> 故 §5 用例与代码位置的对应如下：

### 7.1 单元测试（mocha / node，已落地并 23/23 通过）

**文件**：`src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/test/node/kbUrlScraper.test.ts`

- T1~T3 平台识别 / OG 解析：`detectPlatform` + `parseMetaTags`
- T6~T8 媒体扩展名 / 可下载判定 / 时长格式化：`guessMediaExt` / `isDownloadableMedia` / `formatDuration`
- T9~T10 图文 / 视频 Markdown 组装：`composeArticleMarkdown` / `composeVideoMarkdown`
- T11 正文图片本地化（纯函数级）：`findMarkdownImageUrls` + `rewriteMarkdownImageUrls`（从 `importFromUrl.localizeBodyImages` 抽出的纯逻辑）
- T12 实体解码：`parseMetaTags` 经 `decodeEntities`（空白折叠为单空格，属预期行为）
- E1 / E2 / E4（确定性组装逻辑，fixtures 驱动，无网络）：`parseMetaTags` + compose + 图片改写串联

运行：
```bash
npm run gulp compile          # 增量编译（tsb 缓存，约 3min）
npm run test-node -- --run \
  src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/test/node/kbUrlScraper.test.ts
```

### 7.2 集成 / 端到端测试（Playwright，已落地，默认按网络 skip）

**文件**：`tests/web/kb-url-import.spec.ts`

- E1 SSR 文章导入 → 库出现 .md + 成功 toast
- E2 视频 OG 兜底（无直链）→ ⚠️ 提示、不崩溃
- E3 B站 headless 下载 → 媒体落盘
- E4 小红书 mixed → 封面 + 正文图全本地引用
- E5 受限 / 不可达 URL → 友好报错、不崩溃（用 httpstat.us，无需真实内容站点）
- E6 同名幂等 → 再次导入不覆盖（`uniqueName`）
- E7 超大页面 → 不 OOM、落盘成功

> 抓取依赖主进程 `IWebContentExtractorService`（真实 Chromium + 外网），CI / mock webserver 默认 `test.skipIf(!KB_E2E_NETWORK)` 跳过。
> 本地要跑：`KB_E2E_NETWORK=1 npx playwright test tests/web/kb-url-import.spec.ts --config=playwright.web.config.ts`
> （T4 defuddle 正文、T5 视频 schema 属主进程渲染抽取，合并进 E1~E4 的端到端覆盖。）

### 7.3 相对 §三 的取舍
- 未引入 `defuddle` / `linkedom` / `playwright` npm 依赖（VS Code AMD 构建接入第三方包风险高）；改为复用内置 `IWebContentExtractorService`。
- 未加 YAML frontmatter（`composeArticleMarkdown` 沿用「`# 标题` + `> 元信息`」可读格式），避免 KB Markdown 渲染器把 frontmatter 当正文。
- 正文图片本地化：视图层 `localizeBodyImages` 仍用 `IRequestService`/`ISharedWebContentExtractor` 下载落盘，纯解析/改写逻辑抽到 `kbUrlScraper.ts` 的 `findMarkdownImageUrls`/`rewriteMarkdownImageUrls` 以便单测（T11）。

