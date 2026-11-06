---
name: web-content-import
description: 多平台内容导入手册（web-content-import）—— 当用户让你把某个链接的内容抓下来 / 存进知识库 / 转成 Markdown，或直接丢来小红书、抖音、B站、快手、微博、知乎、微信公众号、掘金、CSDN、YouTube、TikTok 的帖子、视频、文章链接（含 xhslink.com、b23.tv、youtu.be 等短链），并期望你读它、总结它、归档它时使用。给出按平台分流的抓取路径（静态文章走 web_extract、强 SPA 与登录墙走 browser 工具、视频走随包自带的 yt-dlp 取元信息与字幕）、图片本地化与相对引用规则，并按既有约定把产物落到知识库 `库/raw/<slug>.md`（素材层，无 frontmatter）。Agent 无法触发知识库视图那个「导入链接 / URL」按钮 —— 本手册讲的正是"不靠那个按钮，你自己能做到哪一步"。
activation: auto
match: ["小红书", "抖音", "b站", "bilibili", "知乎", "微信公众号", "公众号", "youtube", "tiktok", "快手", "微博", "掘金", "csdn", "存进知识库", "存到知识库", "导入链接", "抓取链接", "这个链接", "这篇文章", "这个视频", "这个帖子", "转成 markdown", "转成markdown", "转成md", "转 markdown", "视频字幕", "文章归档"]
category: research
---

<!-- 同步指针：本技能只讲「怎么抓、抓成什么形状、放哪」；能力边界由产品实现决定，改链路时同步：
     · **平台表 / 路由真源**（2026-10-13 收敛）：common/webPlatformRoutes.ts 的 `WEB_PLATFORM_ROUTES` ——
       每个平台带**有序候选通道**（`backends[0]` 即首选）。宿主 `KB_URL_PLATFORMS` / `detectPlatform`
       **由它派生**；本文件下面那张表格由守卫 test/browser/webPlatformRoutes.test.ts 对账
       （平台集合 + 每行的首选通道 + 不许出现已退役的 browser_* 工具名）
     · 输出形状：browser/views/knowledgeBase/kbUrlScraper.ts（composeArticleMarkdown / composeVideoMarkdown /
       slugifyTitle / planImagePath / parseSubtitlesToText）
     · 宿主「导入链接」全流程：browser/kbImportController.ts（importUrl：reader-mode → OG → yt-dlp 元信息
       → 字幕 → 图片本地化 → 落 库/raw/<slug>.md）
     · agent 侧唯一的浏览器工具：`browser`（单工具 + `op` 参数；登录墙闭环是 `op: "login"` + `done: true`，
       实现见 dsh-plugins/vssaros-browser/lib/core/loginProbe.js）
     · yt-dlp 的确切命令行：browser/knowledge/kbVideoFetch.ts（--print 模板 / 字幕 flags / 「不下载本体」）
     · 落盘语义（`库` = 数据源层 / `笔记` = 知识体系层）：宿主常量 KB_LIBRARY_SUBPATH / KB_NOTES_SUBPATH
     · 构建侧：技能 kb-build（本技能只把素材放进 `库/raw`，**不写** `笔记/`）
     本技能**不新增工具、不新增依赖**：能力全部来自已有工具 + 随包自带的 ffmpeg / ffprobe / yt-dlp。 -->

# 多平台内容导入（web-content-import）

目标：**一个链接 → 一份可读、可归档的 Markdown**。两件事要分清：

- 用户只是**让你读 / 总结** ⇒ 第 1～3 步拿到内容就能答，**不必落盘**（也省 token）；
- 用户要**存进知识库 / 归档 / 以后还能查** ⇒ 必须走第 4 步的落盘契约，否则等于没存。

### 何时**不**启用（本技能的触发词里有平台名，别被误伤）

- 只是**提到**平台或链接，但没有"读它 / 存它"的意图：如「小红书怎么起号」「抖音算法是什么」「这个链接为什么打不开」⇒ 照常回答；
- 用户要的是**深度分析/拆解**（游戏拆解、爆款结构分析）⇒ 抓取用本手册，分析交给对应技能（`kb-game-teardown` 等）；
- 判断不清时，一句话问清「是要我把它的内容抓下来存进知识库吗」，**不要**默认开始抓。

## 第 -1 步：先核对**你自己的**工具面（这一步最容易白做）

同一个技能会被**两种运行环境**用到，而它们的工具面**不一样**：

| 工具 | 谁有 |
|---|---|
| `browser`（本手册的浏览器通道） | **Host 侧**（Host 插件实现；⚠ 不可达时它会**动态从工具面消失**，见下） |
| `web_extract` / `web_search` | **仅 IDE 侧**（VsSaros 内建的抓取与检索） |
| `video_analyze` / `extract_video_frames` / `vision_analyze` | **仅 IDE 侧**（视频 / 图像链路，含本地 ASR） |
| `execute_code` / `terminal` / `file_read` | **仅 IDE 侧** |

⇒ **下笔之前先看自己的工具列表**，按"**实际有什么**"选路：

- 本手册里出现的任何工具名，只要**不在你的列表里**，就**当作不存在** —— 不要假设它"也许能调"（调一个不存在的工具只会白失败一轮）；
- 缺 `web_extract` ⇒ **文本抓取**用你确实拥有的那条（例如内置的 `fetch` 类工具），并按第 1 步的**质量判定**看待它的返回；
- 缺 `video_analyze` ⇒ **本环境没有视频转写链路**（没有 ASR）⇒ 如实告诉用户拿不到口播内容，**不要**用"我记得这类视频通常……"编造；
- 缺 `browser` ⇒ 浏览器不可用，**见下一节**。

⚠ 这不是可有可无的前言：**工具面不同，"同一条路"能不能走完全不同** —— 照着手册点名一个手里没有的工具，是本技能最容易造成的整轮浪费。

⚠ **`browser` 在不在你的工具列表里**：本工具集的浏览器通道会由 Host 按「本机 Chrome 调试端口是否可达」
**动态增删**（不可达时**不暴露** —— 免得你去试一条必然失败的路）。所以：

- 列表里**有** `browser` ⇒ 按下面各表正常走；
- 列表里**没有** `browser` ⇒ 本机浏览器此刻不可用 —— **不要**假设它"过一会儿会出现"，也**不要**去找别的浏览器工具。
  如实告诉用户："这个页面需要登录态 / JS 渲染，请在 Chrome 里开一次远程调试（地址栏**手输**
  `chrome://inspect/#remote-debugging` 并勾选 'Allow remote debugging for this browser instance'）"。
  然后**先用你手上的文本通道尽力回答**，取不到就承认取不到 —— 不要凭标题或摘要编内容。

## 第 0 步：先分流（这一步选错，后面全白做）

⚠ **Agent 不能触发知识库视图的「导入链接 / URL」按钮**（那是宿主留给用户点的入口：它还会做图片本地化）。
但你**不需要它** —— 下面的工具都能直接对链接工作。

| 平台（按主机名判） | 类型 | 主路径（首选 → 降级） | 已知坑 / 拿不到的 |
|---|---|---|---|
| 小红书 `xiaohongshu.com`、短链 `xhslink.com` | mixed | **`browser`**（`op: "navigate"` → `"snapshot"`）→ 图内文字用 `vision_analyze` 逐张读 | 游客态多数帖子只给「你访问的页面不见了」⇒ 那是**缺登录态**（见第 3 步末）；正文常在图片里 |
| 抖音 `douyin.com` / `iesdouyin.com` | video | **`video_analyze`**（元信息 + **口播文本** + 画面一次拿到）；只要字面信息就 `yt-dlp --print` | 多数视频**没有字幕轨** ⇒ 口播靠内置**本地 ASR**（whisper），不是抽帧读屏上文字 |
| TikTok `tiktok.com` | video | **`video_analyze`**；只要字面信息就 `yt-dlp --print` | 同上（无字幕轨 ⇒ 本地 ASR） |
| 快手 `kuaishou.com` / `gifshow.com` | video | **`video_analyze`**；只要字面信息就 `yt-dlp --print` | 同上（无字幕轨 ⇒ 本地 ASR） |
| B站 `bilibili.com` / `b23.tv` | video | **`video_analyze`**（字幕轨/ASR + 帧 + 结论一次完成）；只要字面信息就 `yt-dlp --print` | 无字幕轨时同样走本地 ASR |
| YouTube `youtube.com` / `youtu.be` | video | **`video_analyze`**（字幕轨通常齐备，最准的一条）；只要字面信息就 `yt-dlp --print` | 直连 YouTube 超时（需代理的环境）⇒ 如实说明，别编内容 |
| 微博 `weibo.com` / `weibo.cn` | mixed | **`video_analyze`**（图文 + 视频混排时视频那条最值）→ 纯图文帖用 `browser` | 无字幕轨 ⇒ 本地 ASR |
| 微信公众号 `mp.weixin.qq.com` | article | **`web_extract`**（全文 ≤2 万字；超限会落盘并提示翻页） | 反爬拦截 ⇒ 换 `browser`；仍失败就如实说 |
| 知乎 `zhihu.com` | article | 文章页（`/p/`）用 **`web_extract`**；**问答页**（`/question/`）常要求登录 ⇒ 换 `browser` | 未登录只看得到前几条回答，别假装读了整页 |
| 掘金 `juejin.cn` | article | **`web_extract`** | 反爬拦截 ⇒ 换 `browser`；仍失败就如实说 |
| CSDN `csdn.net` | article | **`web_extract`** | 反爬拦截 ⇒ 换 `browser`；仍失败就如实说 |
| 飞书 `feishu.cn` / `larksuite.com` | article | **`web_extract`** | 需要登录/权限的文档读不到就是读不到 —— 如实说明，不要编 |
| 其它任意网页 | article | **`web_extract`** 兜底 | — |

平台名以**主机名**为准，不要凭链接长相猜。

⚠ 上表"主路径"里的 `web_extract` / `video_analyze` 属**仅 IDE 侧**（见第 -1 步）：不在你的工具列表里时，
按那一节的降级办法走 —— **别照名字硬调**。

## 第 1 步：文章类 → 拿全文

1. `web_extract(url)`：reader-mode 优先，且自带**质量分类**（拦截页 / 登录墙会返回**明确失败**，不会给你一段假正文）；
2. 返回里出现 `Truncated` / 「已保存到完整文件」时，按提示用 `file_read` **读完整文件**，不要把摘要当全文；
3. 返回 `Web Extract Blocked` 或 `content unavailable` 时**不要原样重试** —— 文案里已经写了下一步（换浏览器通道 / 换来源 / 让用户登录一次）；
4. **已判登录墙的站点别再打 http**：如果 `browser`（`op: "snapshot"` 或 `op: "images"`）已返回占位页结论（或输出里带 `This is NOT the page content`），就**不要再对这个 URL 调 `web_extract`** —— 实测（日志 1790262747712）：模型拿到浏览器侧结论后又对同一链接打了一次 web_extract，**2598ms 白打一面墙**。
5. 只回答内容问题 ⇒ 直接用结果答，不落盘。

## 第 2 步：视频类 → `video_analyze` 一次完成（文本主线是**口播转写**，不是抽帧读屏）

⚠ **先确认 `video_analyze` 在不在你的工具列表里**（它**仅 IDE 侧**）：不在 ⇒ **本环境整条视频链路都不存在**
（没有字幕抓取、没有本地 ASR、没有抽帧工具）⇒ **如实告诉用户拿不到口播内容**，并给出可选项
（到 VsSaros 里做、或请用户提供字幕 / 文字稿）。**不要**改用"我凭印象总结这个视频"，
也不要拿标题 / 简介冒充内容 —— 那是这类任务最坏的结果。

⚠ **正确流程：下载 → ASR/字幕（文本）→ 抽帧（画面证据）→ 写库**。
**「下载 → 抽帧 → 从帧里读文字（OCR）」是错误流程**（2026-09-25 用户纠正）：帧里只有屏上文字
（标题/UI/封面字），**口播内容一个字都不在画面里** —— 教程/讲解类视频的信息主体是口播，
OCR 帧 = 捡了包装丢了内容。

**主线：`video_analyze(url, query=…)` 一次调用**完成：下载 + 字幕轨抓取（有字幕轨时最准）→
**无字幕轨自动走本地 ASR**（whisper，随包自带，离线）+ 抽帧 + 多模态结论。返回里：
- **口播文本**（`[以下为字幕全文]`）：字幕轨或 ASR 转写 —— 素材里标注来源（ASR 可能有个别错字/简繁混排）；
- **帧图路径 + 时间点**：画面证据，结论挂 `[帧 mm:ss]`；
- 字幕**没有**时会写明「无字幕轨且本地 ASR 不可用/失败」⇒ 那时才如实说口播不可知。

**不要**绕开它手工拼管线（手工 yt-dlp + ffmpeg 循环 + 逐张 vision_analyze 是几倍的往返，
而且**没有 ASR 那一步**）。工具偶发失败（超时/探测抖动）多是瞬态，重试一次或换
`extract_video_frames` + 明说缺口，都比手工重造强。

分工澄清（别再混淆三者）：
- **口播内容** ⇒ ASR/字幕轨（`video_analyze` 内置）；
- **画面证据** ⇒ 抽帧（`extract_video_frames`，产物落 `库/raw/assets/<slug>/` 按相对路径引用）；
- **屏上文字**（PPT/代码/图表类视频的画面字）⇒ 对抽出的帧 `vision_analyze` 逐张读 —— 这是**补充**，
  只有画面字本身是内容主体时才当主线。

只要元信息/直链（不写内容）时的旁路（走 `execute_code`；`terminal` 会弹审批，非必要不用）：

```bash
# 元信息（一行 TSV。刻意不用 --dump-json：含 formats 数组可达数百 KB，会被命令通道截断）
yt-dlp --no-playlist --no-warnings --skip-download \
  --print "%(title)s|||%(duration)s|||%(thumbnail)s|||%(uploader)s|||%(upload_date)s|||%(description)s" "<url>"

# 字幕（要「口播全文」而 video_analyze 那条路走不通时的旁路；与宿主
#   browser/knowledge/kbVideoFetch.ts 的 fetchVideoSubtitles 逐字同口径）
#   ⚠ 字幕是**文件**、不能走 stdout（大字幕会被命令通道截断）⇒ 必须 -o 落盘后再读回
#   ⚠ 「该视频没有字幕」时 yt-dlp 可能以非 0 退出 ⇒ 以「目录里是否真有字幕文件」判定成功
#   ⚠ 读回后按 references/output-template.md 第四节清洗（与宿主 parseSubtitlesToText 同口径）
yt-dlp --no-playlist --no-warnings --skip-download --write-subs --write-auto-subs \
  --sub-langs "zh.*,en.*" --sub-format "vtt/srt/best" \
  -o "<临时目录>/%(id)s.%(ext)s" "<url>"
```

- ⚠ 默认**不下载视频本体进库**（几十 MB~GB，会拖慢索引与飞书同步）；`video_analyze` 内部会下载到临时目录做分析，分析完即删；
- 工具报「未检测到 ffmpeg / yt-dlp」⇒ **原样转告排查指引**（源码运行：`node build/saros/fetch-ffmpeg.mjs`；ASR 缺失跑 `node build/saros/fetch-whisper.mjs`；或设 `FFMPEG_PATH` / `YTDLP_PATH` / `WHISPER_MODEL_PATH`），**不要**改用「我记得这个视频通常…」继续写 —— 那等于编造。

## 第 3 步：小红书 / 抖音 / 微博这类「图文 + 登录墙」

- **主路径**：`browser`（`op: "navigate"`）→ `browser`（`op: "snapshot"`，给标题 / 正文摘要 / 可交互元素）→ 需要时 `op: "scroll"`、`op: "click"`（`ref` 来自最近一次 snapshot）翻页 → 再 `op: "snapshot"`；
- **图文帖的正文常常是图片**（小红书尤甚）：`op: "snapshot"` 只能给到 alt 与少量文本，**图里的字必须 `vision_analyze` 逐张读**（一次一张、≤8MB），图片清单用 `op: "images"` 取；
- ⚠ 页面里的**数据**（SPA 挂在 `window` 上的状态、按选择器批量取属性、`localStorage` 里的公开配置）可以用 `browser`（`op: "evaluate"`）取 —— 但它**默认关闭**（需要 `allowEvaluate`）且**每次都要用户批准**，批准弹窗里会回显你要跑的那段代码。**不要**用它去搬 cookie / 凭据（那是 `op: "cookies"` 的事，且凭据值本就该留在浏览器里）；未启用或用户不批时：需要该页面 cookie 才能取的图片/接口数据，用 `execute_code` 只能试**公开可直连**的 URL；取不到就**保留远程链接并在产物里说明**，不要伪造；
- 游客态读到「你访问的页面不见了 / 需要登录」⇒ **这就是缺登录态**（不是工具坏了）。**闭环三步**：
  1. `browser`（`op: "login"`，带上该页面 URL）把页面开到那个窗口，然后请用户**在那个窗口里自己登录一次**（扫码也行；专属 profile 会记住这次登录）；
  2. 用户说好了之后，用 `browser`（`op: "login"`, `done: true`）**验证**登录态 —— 它会如实告诉你成没成（cookie 证据 + 页面证据；两者冲突时它说"说不清"，不会说"成了"）；
  3. 验证通过再 `op: "snapshot"` 读页面。
  **绝不**向用户索要账号密码或 cookie，也不要尝试绕过（这是硬纪律）；**更不要对着同一堵墙反复重试** —— 重试**永远**无解。

## 媒体：关键图片 / 视频地址 / 视频关键帧（**归档产物必须包含**）

用户明确要求：转成 md 之后，**网页里的关键图片、视频的 url、或视频的关键帧**要在文件里。三条怎么拿：

**① 关键图片**

- **来源**：静态文章 → `web_extract` 的结果里本就带 `![alt](url)`（正文图）；
  **SPA / 登录墙页面 → 用 `browser`（`op: "images"`）**（⚠ `op: "snapshot"` **不采集图片**，这也是本仓专门补这个 op 的原因：图文帖的正文常常就在图里）。
- **读图内文字**：`vision_analyze(image=<图片 URL>, query=...)` —— 它**直接吃 http(s) URL**，不必先下载；一次一张。
- **入库**：`execute_code` 下载到 `<vault>/库/raw/assets/<slug>/<序号>-<名>.<ext>`，正文用**相对路径**引用；
  小红书这类图 CDN 常校验 `Referer`，脚本里带上 `Referer: <页面 URL>`；403/401 就**保留远程 URL 并说明**，别伪造本地文件。
- **取舍**：只收正文区的**内容图**，跳过头像/图标/表情/1×1 像素/埋点图（`op: "images"` 已按尺寸过滤）；最多 20 张，按出现位置插在正文里，不要全堆到文末。

**② 视频地址**（视频帖必写）

```bash
yt-dlp --no-playlist --no-warnings --skip-download \
  --print "%(webpage_url)s|||%(url)s|||%(ext)s|||%(resolution)s" "<url>"
```

- `webpage_url` = 页面地址（长期有效）；`url` = **直链**（`.mp4` / `.m3u8`，⚠ **有时效**）—— 写进产物时**标明是哪种**；
- 产物里写成一行：`> 视频地址：<webpage_url>（直链：<url>，抓取于 <YYYY-MM-DD>）`；只拿到直链也要把页面地址写上；
- yt-dlp 无输出（站点不支持 / 反爬 / 需登录）⇒ 写页面地址 + 一句「未能解析直链：<原因>」。

**③ 视频关键帧**（用户要看画面、或你要给画面证据时）

- `extract_video_frames(source=<视频或页面 URL>, outDir="<vault>/库/raw/assets/<slug>", frames=...)`
  —— ffmpeg/yt-dlp **随包自带**；返回**每张帧的路径与时间点**（`@ mm:ss`）；
- 产物里内嵌：`![帧 03:12](assets/<slug>/frame-03.png)`；画面结论必须挂 `[帧 mm:ss]`（**没抽到的时段等于没看过**）；
- 抽帧失败（需登录 / 反爬 / 分片流）⇒ **不要**凭标题编画面：写清失败原因、保留视频地址、建议用户给截图；
- ⚠ 抖音 / 快手 / 小红书多数视频**没有字幕轨** ⇒ 口播文本走 `video_analyze` 内置的本地 ASR（whisper）；
  抽帧只给**画面**（它走下载而非登录态，通常仍可行），别拿帧当文本来源。

**三选一按内容类型**：文章 → 关键图片；视频 → 视频地址 **+**（要画面/要证据时）关键帧；图文混排（小红书 / 微博）→ 图片 **+** 视频地址。
样例与自检见 `references/output-template.md`。三者都拿不到时，写清"没有 / 拿不到的原因"，**不要**留空、更不要编。

## 第 4 步：落盘契约（要归档才做；形状必须与宿主「导入链接」产物**完全一致**）

- **正文**：`<vault>/库/raw/<slug>.md`
- **图片**：`<vault>/库/raw/assets/<slug>/<序号>-<原名>.<ext>`；正文里用**相对于笔记文件**的路径
  （绝对路径会让预览与飞书同步**双双失效**）。差一级就全是断图 —— 按笔记实际落点选：
  · 笔记在 `库/raw/<slug>.md` ⇒ `![说明](assets/<slug>/1-xxx.png)`
  · 笔记在 `库/源/<slug>.md` 或任何分类目录（`方法/概念/实体/综合`）⇒ `![说明](../raw/assets/<slug>/1-xxx.png)`
  ⚠ 实测事故（2026-09-24）：10 张帧全写成 `assets/<slug>/…`，而笔记在 `库/源/` ⇒ **预览里一张都显示不出来**，
  用户的观感是"图片和视频都没进笔记"（其实文件都在，只是引用少了一级）。别再犯。
- **落盘前必须自检相对链接**（不通过就不要交付）：以**笔记所在目录**为基准，逐个解析正文里每个 `![…](…)`；
  解析不到真实文件就改对再交。不要只数"我插了几张图"。
- ⚠ **不要为了让"能看见"而改成 `file:///` 或绝对路径**：实测（2026-09-24）产品内置的 Markdown 预览
  **不加载任何本地图片**（相对、`/库/…`、`file:///`、`![[…]]` 六种写法全断 —— 连绝对路径都不显示），
  所以"内置预览里看不到图"**不等于**链接写错了。判别标准是**文件系统层面能否解析到真实文件**
  （上面那条自检），以及**在 Obsidian 里打开是否正常** —— 那才是这些链接真正的渲染环境。
  用 `file:///` 去迁就内置预览，只会让飞书同步与换机双双失效。
- **视频：默认只保留 URL**（`> 视频地址：<url>`），**不下载本体**；只有用户**明确要求下载**时才落盘。
  要画面证据就抽帧（帧是图片，按上一条写相对路径）。
- **`<slug>`**：标题优先（去掉 `\ / : * ? " < > | # % { }`，空白折成 `-`，≤60 字符）；无标题时取 URL 末段；同名不覆盖 ⇒ 追加 `-2` / `-3`
- **素材不写 YAML frontmatter**（`type / title / sources / status / feishu:*` 是**笔记**才有的字段，由构建管线写入）；
  首行 `# <标题>` + 紧跟一行 `> …` 元信息，就是素材的元信息区
- **骨架先读** `references/output-template.md`（文章 / 视频两种形态 + 字幕清洗 + 落盘前自检），按它填
- 正文**不写** HTML / `<iframe>` / 依赖 Obsidian 社区插件的语法（Charts / Dataview 等 —— 预览与飞书都不渲染）
- 落点是 `库/raw`（宿主 URL 导入的真实落点）。⚠ 若某处提示写「库/articles/」，**以本手册为准**

## 第 5 步：交付与交接（别停在「落盘成功」）

1. 给用户一段**结论摘要**（≤5 行）+ 落盘路径 + **哪些内容没拿到、为什么**；
2. 拿到的写事实、没拿到的写「未获取」，两者**分开**；没读到的内容不许用常识补；
3. 要把它变成笔记（归位 / 补链 / 去抽象化门控 / 导航 / 飞书同步）⇒ **先问用户**（有 `clarify` 就用它，避免"问完就当同意"）；
4. 用户同意 ⇒ 调 `kb_build`（`mode:"build"`，**发起后立即返回**、不要等它跑完、不要重复发起），并说明进度在那个新会话里；
5. **不要**自己往 `笔记/` 写（那会绕过补链/门控/台账）。

## 反模式（出现即不合格）

- 把 `web_extract` 的 `Blocked / content unavailable` 文案当成页面内容去总结（那正是"假成功"）；
- 没拿到字幕/ASR 却写「视频里说…」；没跑 `vision_analyze` 却描述图里的文字；
- **用抽帧 + vision 读屏上文字来冒充口播内容**（教程/讲解类视频的信息主体在**音轨**里，不在画面里；
  正确流程：下载 → ASR/字幕 → 抽帧做画面证据 → 写库，2026-09-25 用户明确纠正过）；
- 把登录墙页面靠标题 / 摘要 / 常识**补全**成一篇像样的文章；
- 给 `库/raw` 的素材写 `type / sources / status` 等**构建产物**字段，或直接往 `笔记/` 写；
- 图片引用用绝对路径；或把「视频未下载」说成「已保存视频」；
- 用户明确说「存进知识库」时却只在对话里给一段结论（没落盘 = 没存）；
- 用 `terminal` 当抓取主路径（弹审批、打断流程）—— 抓取统一走 `execute_code`。

## 相关技能与工具

技能：

- `kb-build`：素材 → 笔记（第 5 步的交接对象）
- `kb-game-teardown`：视频类**深度拆解**（本技能只负责「抓下来、存进去」，不做分析框架与证据纪律）
- `youtube-content`：YouTube 字幕 → 章节 / 推文 / 博客（⚠ 它需要 `pip install youtube-transcript-api`；**只取字幕**优先用随包自带的 `yt-dlp`）
- `web-search`：还不知道具体 URL 时先搜
- `kb-feishu-sync` / `kb-category-feishu`：笔记区 → 飞书知识库

工具：

- `web_extract` —— 静态文章全文（主路径）
- `browser` —— **单个工具、按 `op` 分**：`navigate` / `snapshot` / `images` / `click` / `type` / `scroll` / `back` / `status`，
  外加 `login`（登录墙闭环：先把页面开到那个窗口请用户登录，再用 `done: true` 验证）与
  `cookies`（`action: "inspect"` 只报数量；`export` / `import` 默认关闭且每次要审批）。SPA 与登录态页面全靠它
- **`browser`（`op: "images"`）** —— 页面图片清单（URL / 尺寸 / alt）。⚠ `op: "snapshot"` **不给图片**，
  图文帖（小红书尤甚）要拿"关键图片"只能靠它；拿到 URL 后直接用 `vision_analyze` 读图内文字
- `vision_analyze` —— 读单张图（**直接吃 http(s) URL**，不必先下载；一次一张）
- `video_analyze` —— 视频理解**一次完成**：下载 + 字幕轨/本地 ASR 口播转写 + 抽帧 + 视觉结论
  （文本主线是口播转写，无字幕轨时 ASR 自动兜底；whisper 随包自带、离线）
- `extract_video_frames` —— 只抽帧（画面证据落盘，需逐帧追问细节时配 `vision_analyze`）
- `execute_code` —— 跑随包自带的 `yt-dlp` / `ffmpeg`
- `file_read` / `file_write` —— 落盘、读回与翻页
