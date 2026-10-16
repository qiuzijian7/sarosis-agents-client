# 多平台内容导入 dsh 插件 · 方案稿

> 2026-10-15。目标：**一个 URL（平台文章 / 视频）→ 抓回内容 → 写进知识库 `库/raw/`**。
> 参考实现：`G:\CustomWorkspaces\AIProjects\OpenBiliClaw`（MIT；跨语言 ⇒ 只借鉴设计）。
> **这是方案稿，不是实现代码**。动生产代码前等你拍板（§8）。

## 1. 结论先行

OpenBiliClaw 解决的是「**发现**」（feed / 搜索 / 榜单 + 推荐画像），不是「**按 URL 读单条**」——
它唯一到 URL 级的路径（`sources/link_ingest.py`）只在 B站走 `/view` API，**其余平台只抓 `<title>`/og 元数据，
不抓正文、不抓字幕**；内容模型里**没有正文字段也没有字幕字段**。所以它不是"拿来改一改就行"的对象，
但它有三样东西值得借（§3）。

我们真正要的链路（`URL → ContentRecord → 知识库`）**在 OpenBiliClaw 里不存在**，要自己写；
而「抓」这一半我们仓库里**已经有现成的**（IDE 侧 `web_extract` / `video_analyze` / `kbImportController`，
dsh 侧 `browser`）—— 本插件是把它们**收拢成一个 dsh 工具 + 对齐知识库落盘契约**。

## 2. 与既有资产的关系（不重复造）

| 资产 | 位置 | 关系 |
|---|---|---|
| `web-content-import` 技能 | `resources/.agents/skills/web-content-import/` | **它是"告诉模型怎么做"的手册**（IDE 侧，activation auto）；本插件是"一个工具直接做"。两者并存，手册在插件缺席时兜底 |
| IDE `kbImportController.importUrl` | `browser/kbImportController.ts` | 已有完整流水线（reader-mode → OG → yt-dlp → 字幕 → 图片本地化 → 落库），**但只在 IDE 侧、且只服务"导入链接"按钮** ⇒ 本插件是它的 dsh 侧等价物（功能重叠是刻意的：两侧独立可跑） |
| `vssaros-browser` | `dsh-plugins/vssaros-browser` | **可选依赖**：登录墙平台（小红书图文、知乎问答）才走它 |
| `vssaros-kb` | `dsh-plugins/vssaros-kb` | **落盘契约对齐它**（`kbRoot` / vault / `库/raw` / 原子写 + 锁）；本插件**不进** kb 的构建/笔记层 |

## 3. 架构

```
URL
 └─ resolveUrl()        短链展开（b23.tv / xhslink.com / youtu.be）→ 平台识别 → 内容 id 提取
     └─ Adapter.for(platform)          ← 借 OpenBiliClaw 的 AdapterRegistry 模式
         ├─ article  → HTTP fetch + reader 提取（正文）
         ├─ video    → yt-dlp（元信息 + 字幕轨；无字幕轨 ⇒ whisper ASR）
         └─ login-walled → browser 插件（可选；没装就如实说"拿不到"）
     └─ ContentRecord（统一模型，见 §5）
     └─ mode=write ⇒ writeToVault(record)
         └─ <kbRoot>/<vault>/库/raw/<slug>.md + assets/<slug>/ + 原子写 + 跨进程锁
```

**借自 OpenBiliClaw 的三样**：① Adapter 注册表（`SourceRecipe`/`AdapterRegistry`，上游平台无关）；
② 登录态分层（能匿名走 HTTP 的走 HTTP；必须登录的借用户浏览器会话；每平台只暴露"是否登录"布尔）；
③ 渐进降级管线（短链展开 → 识别 → API 优先 → og 元数据兜底；单链接失败不阻塞）。

## 4. 平台路由（初版）

| 平台 | 类型 | 首选通道 | 降级 | 已知坑 |
|---|---|---|---|---|
| 微信公众号 `mp.weixin.qq.com` | article | HTTP + reader | browser | 反爬时换通道 |
| 知乎文章 `/p/` | article | HTTP + reader | browser | — |
| 知乎问答 `/question/` | mixed | **browser**（登录墙） | HTTP（只拿前几答） | 未登录只有前几答，别假装读了整页 |
| 掘金 / CSDN | article | HTTP + reader | browser | 反爬 |
| 飞书 | article | HTTP + reader | — | 权限文档读不到就如实说 |
| B站 `bilibili.com` / `b23.tv` | video | **yt-dlp**（元信息 + 官方字幕轨） | — | — |
| YouTube / `youtu.be` | video | **yt-dlp**（字幕轨通常最齐） | — | 直连超时 ⇒ 如实说（别编内容） |
| 抖音 / TikTok / 快手 | video | **yt-dlp** 元信息 → **whisper ASR**（多数无字幕轨） | — | 没 ASR 就只有标题/简介 |
| 小红书 `xiaohongshu.com` / `xhslink.com` | mixed | **browser**（登录墙；**正文常在图里 ⇒ vision**） | HTTP（多半是占位页） | 游客态多数帖子只给「你访问的页面不见了」 |
| 微博 `weibo.com` | mixed | yt-dlp（视频）/ HTTP（图文） | browser | 匿名可读部分 |
| 任意网页 | article | HTTP + reader | browser | — |

路由表**单一真源**在插件侧（`lib/core/routes.js`）；与 IDE 侧 `common/webPlatformRoutes.ts` 的对账由
dshHarness 守卫钉住（先例：技能页那张表就是这么对的）。

## 5. ContentRecord（统一模型，刻意带"没拿到"字段）

```js
{
  url,               // 展开短链后的最终 URL
  platform,          // 'xiaohongshu' | 'douyin' | 'zhihu' | 'youtube' | 'bilibili' | 'wechat' | ...
  kind,              // 'article' | 'video' | 'mixed'
  title, author, publishedAt, description,
  body,              // 正文 markdown（article）或口播文本（video，标注来源 official/asr）
  images,            // [{ url, alt?, localPath? }]   localPath 只在 mode=write 且本地化后有
  video,             // { pageUrl, directUrl?, duration? }  directUrl 有时效，标注抓取日期
  subtitles,         // { kind: 'official'|'asr'|'none', text? }
  status,            // 'ok' | 'partial' | 'blocked'
  notes,             // [string] 没拿到的部分与原因（诚实；不许空着编）
}
```

⚠ 与 OpenBiliClaw 的 `DiscoveredContent` 的本质差别：**它有正文字段、有字幕字段、有 `notes`** ——
它是知识库模型，不是推荐模型。

## 6. 工具签名草案

```
content_import({
  url: string,                 // 必填
  mode?: 'read' | 'write',     // 默认 read：只把内容读回来给你看；write 才落库
  vault?: string,              // 写到哪个库（默认当前/第一个）
  slug?: string,               // 自定义文件名（缺省从标题派生，重名追加 -2/-3）
  images?: boolean,            // write 时是否把图片下载进 assets/（默认 true；失败保留远程 URL 并说明）
})
```

返回 `ContentRecord` + `saved?: { path, assetsDir, imageCount }`。

**审批闸**：`mode=write` 才进 `tools/pre-execute` 的 `ask`（与 `skill_manage` / `kb_organize` 同一把闸）；
`read` 是纯读，不拦。

## 7. 落盘契约（与 kb / web-content-import 逐字对齐）

- 落点 `<kbRoot>/<vault>/库/raw/<slug>.md`，图片 `<vault>/库/raw/assets/<slug>/`
- 素材**不写 YAML frontmatter**（`type/title/sources` 是笔记侧字段）；首行 `# <标题>` + 紧跟一行 `> …` 元信息
- 图片在正文里用**相对路径**引用（`assets/<slug>/…`；绝对路径会让预览与飞书同步双双失效）
- 同名 slug 追加 `-2`/`-3`，不覆盖
- **原子写 + 跨进程锁**（抄 `vssaros-kb/lib/lock.js` 的协议 v2 —— 本仓惯例是"逐字复制的副本"，
  这会是第 N 份；同时要把 `dshWriteOwnership` 的台账加上本插件对 `库/raw/` 的声明）
- 视频**默认不下载本体**（几十 MB~GB，会拖慢索引与同步）；只有用户明说"下载"才落盘

## 8. 待拍板（4 条）

1. **插件名**：`vssaros-content-import`（模块 id `content-import`）行不行？
2. **默认行为**：`mode` 缺省 `read`（先读给你看，你说存才存）还是 `write`（给了链接就直接存）？
   我倾向 `read` —— 与你的既有习惯（先 mockup 再动手）一致。
3. **登录墙平台**（小红书图文、知乎问答）要不要进本期？它们必须依赖 `vssaros-browser`（可选依赖）。
   不做的话，小红书这类链接只能如实说"拿不到正文"。
4. **ASR 要不要进 P0 的抖音**？抖音多数视频没字幕轨 ⇒ 没 ASR 就只有标题/简介（whisper 随包已有，
   就是下载 + 转写会多花 1-3 分钟）。

## 9. 分期

- **P0（最小端到端，先证明 URL → 库 通）**：article 类（公众号 / 知乎文章 / 掘金 / CSDN / 任意网页）
  + 视频元信息与**官方字幕轨**（B站 / YouTube）+ read/write 双模式 + 落盘 + 锁 + slug 派生。
  不带 ASR、不带图片本地化、不带登录墙。
- **P1**：抖音 / 快手 / 小红书视频 → whisper ASR。
- **P2**：图片本地化（下载进 assets/ + 相对路径引用 + Referer 处理）。
- **P3**：登录墙平台（小红书图文、知乎问答）→ 集成 `vssaros-browser`（可选依赖）。
- **P4**：更多平台（微博 / TikTok / Reddit）、只读页面（列最近导入）、飞书同步交接。

## 10. 明确不做

- **不做签名逆向**（X-Bogus / WBI / a_bogus 之类）—— OpenBiliClaw 的抖音直连签名是从 Evil0ctal 移植的，
  维护成本高且会随平台算法版本失效；我们只走"读渲染后的 DOM / yt-dlp 取字幕"这条侧。
- **不做 feed / 发现 / 推荐**（那是 OpenBiliClaw 的活，与"按 URL 读单条"无关）。
- **不做无水印下载**（那是"下载"，不是"读内容"；且要碰签名）。
- **不接管 IDE 侧 `kbImportController`**（那是"导入链接"按钮那条路；两侧独立可跑是刻意的）。

## 11. 风险与开放问题

- **yt-dlp / whisper 在 dsh 插件里怎么 spawn**：dsh 插件跑在 Host 进程（Node），可以 `child_process.spawn`
  随包二进制（`vssaros-browser` 拉起 Chrome 就是这么干的）✓；但**解析随包路径**那条链
  （`resolveBinary` / `build/saros/bin` / `resources/saros/bin`）要在 Host 侧重建一份，或有现成通道。
- **写库的锁与 `owns` 声明**：`dshWriteOwnership.test.ts` 钉死了声明集合，本插件加声明要同步改那条守卫
  （这是一次"新增写者"的正式决策，与 dashboard 落盘那次同性质）。
- **`browser` 作为可选依赖**：没装 / 不可达时，登录墙平台要**如实说拿不到**（不假装读了）。
