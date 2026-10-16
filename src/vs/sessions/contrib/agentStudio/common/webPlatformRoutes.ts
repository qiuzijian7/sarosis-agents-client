/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 多平台抓取的**路由真源**（2026-10-13）。
 *
 * ## 它解决什么
 *
 * "这个链接该怎么抓"这件事原先有**两份**彼此不知情的实现：
 *   ① 宿主「导入链接」按钮：`browser/views/knowledgeBase/kbUrlScraper.ts` 的 `KB_URL_PLATFORMS` / `detectPlatform`；
 *   ② Agent 侧：`resources/.agents/skills/web-content-import/SKILL.md` 里那张**手写**的 markdown 表格。
 * 两份漂移的症状是**静默的**：宿主按 A 分流、agent 按 B 分流，用户在两种入口得到不同结果，而没有任何测试会红。
 *
 * 现在收敛为**一份数据 + 一个纯函数**：
 *   · 宿主按钮：`KB_URL_PLATFORMS` / `detectPlatform` 由本模块**派生**（值逐字不变）；
 *   · Agent 的 skill 表格：由守卫 `test/browser/webPlatformRoutes.test.ts` 做**对账**（每个平台的首个主机名与
 *     主通道必须出现在 SKILL.md 里；平台集合不许腐烂）。
 *
 * ## 两条照搬自 Agent-Reach 的口径（调研结论，别改）
 *
 * ① **`backends` 是「有序候选」：`backends[0]` 是首选，其余按序降级**（`agent_reach/channels/base.py`）。
 *    **顺序即语义** —— 排序调换等于换了一条主路径，所以守卫会钉住顺序，而不是只钉集合。
 * ② 路由只描述"**该怎么抓**"，不描述"**能不能抓**"。可用性由各自的能力探测决定（本仓：宿主的
 *    `toolAvailabilityEvaluator`、视频链的 `probeMediaCapabilities`）—— 把"装了/能跑/真取到内容"三层
 *    分开，是那次调研里最值钱的一条教训。
 *
 * ## 为什么不含"签名逆向"通道
 *
 * 调研结论（见 `doc/web-login-crawl-plan.md`）：MediaCrawler(59.6k★) 与 Spider_XHS(7.8k★) 都主动
 * 放弃了 JS 签名逆向，改"浏览器现取"。所以这里的 `browser` 通道就是那条侧路，**不设** `sign-reverse` 之类的后端。
 */

/** 内容类型（与宿主 `KbUrlPlatformType` 值域一致；本模块不反向依赖宿主，故自行声明）。 */
export type WebPlatformContentType = 'article' | 'video' | 'mixed' | 'unknown';

/**
 * 抓取通道的种类 —— **封闭集合**（守卫会拒绝未登记的 kind）。
 *
 * · `web-extract`    —— HTTP 抓取（reader-mode，自带质量分类；拦截页/登录墙会明确失败而不是给假正文）；
 * · `browser`        —— 真实浏览器（CDP）：SPA、登录墙、需要交互的页面；登录墙另有 `op: "login"` 闭环；
 * · `video-analyze`  —— 视频一次完成：下载 + 字幕轨/本地 ASR 口播转写 + 抽帧；
 * · `ytdlp`          —— 只要字面信息（标题/时长/封面上传者）时直接问 yt-dlp，最省；
 * · `vision-analyze` —— 读**图内文字**（小红书这类"正文就在图片里"的帖子必须配它）。
 */
export const KNOWN_BACKEND_KINDS = ['web-extract', 'browser', 'video-analyze', 'ytdlp', 'vision-analyze'] as const;

export type WebPlatformBackendKind = typeof KNOWN_BACKEND_KINDS[number];

export interface IWebPlatformBackend {
	readonly kind: WebPlatformBackendKind;
	/** 为什么选它 / 它的前提（进 skill 与 UI 的人读说明；不要写"可能有用"这种空话）。 */
	readonly note: string;
}

export interface IWebPlatformRoute {
	/** 稳定 ID（日志 / 分类 / 与宿主 `IKbPlatformDef.id` 同值）。 */
	readonly id: string;
	/** 展示名（中文）。 */
	readonly name: string;
	readonly type: WebPlatformContentType;
	/** 主机名匹配（不区分大小写）。**顺序无关**，但 `generic` 必须在数组最后（它是兜底）。 */
	readonly hostPatterns: readonly RegExp[];
	/** **有序**候选通道：`[0]` 即主路径（顺序即语义）。 */
	readonly backends: readonly IWebPlatformBackend[];
	/** 正常抓取是否需要登录态（true ⇒ 游客态大概率只拿到占位页）。 */
	readonly needsLogin: boolean;
	/** 已知坑（人读；每条都该对应一个实测或一条纪律，不要写猜测）。 */
	readonly risks: readonly string[];
}

/** 视频类站点的共同坑（多处复用，避免同一句话抄五遍 —— 抄五遍就会各写各的）。 */
const VIDEO_NO_SUBTITLE_RISK = '多数视频没有字幕轨 ⇒ 口播走 video_analyze 内置的本地 ASR（whisper，随包自带）';

/**
 * 平台路由表（**顺序 = 匹配优先级**；`generic` 兜底放最后）。
 *
 * ⚠ 增删平台时三处一起动，否则守卫会红：
 *   ① 本表；② `resources/.agents/skills/web-content-import/SKILL.md` 的表格与正文；
 *   ③ 该技能 frontmatter 的 `match` 关键词（用户真要连在一起说的那些词）。
 */
export const WEB_PLATFORM_ROUTES: readonly IWebPlatformRoute[] = [
	{
		id: 'xiaohongshu', name: '小红书', type: 'mixed',
		hostPatterns: [/xhslink\.com/i, /xiaohongshu\.com/i],
		backends: [
			{ kind: 'browser', note: '强 SPA + 登录墙：文本抓取只会拿到占位页' },
			{ kind: 'vision-analyze', note: '图文帖的正文常常就在图片里 ⇒ 逐张读图内文字（一次一张）' },
		],
		needsLogin: true,
		risks: [
			'游客态多数帖子只给「你访问的页面不见了」—— 那是缺登录态，不是工具坏了',
			'登录墙下不要重试文本抓取、不要重发同 URL：请用户在那个被驱动的浏览器窗口里登录一次',
		],
	},
	{
		id: 'douyin', name: '抖音', type: 'video',
		hostPatterns: [/douyin\.com/i, /iesdouyin\.com/i],
		backends: [
			{ kind: 'video-analyze', note: '元信息 + 口播文本 + 画面一次拿到' },
			{ kind: 'ytdlp', note: '只要字面信息（标题/时长/作者）时直接问它，最省' },
		],
		needsLogin: false,
		risks: [VIDEO_NO_SUBTITLE_RISK],
	},
	{
		id: 'tiktok', name: 'TikTok', type: 'video',
		hostPatterns: [/tiktok\.com/i],
		backends: [
			{ kind: 'video-analyze', note: '同抖音' },
			{ kind: 'ytdlp', note: '只要字面信息时直接问它' },
		],
		needsLogin: false,
		risks: [VIDEO_NO_SUBTITLE_RISK],
	},
	{
		id: 'kuaishou', name: '快手', type: 'video',
		hostPatterns: [/kuaishou\.com/i, /gifshow\.com/i],
		backends: [
			{ kind: 'video-analyze', note: '同抖音' },
			{ kind: 'ytdlp', note: '只要字面信息时直接问它' },
		],
		needsLogin: false,
		risks: [VIDEO_NO_SUBTITLE_RISK],
	},
	{
		id: 'bilibili', name: 'B站', type: 'video',
		hostPatterns: [/bilibili\.com/i, /b23\.tv/i],
		backends: [
			{ kind: 'video-analyze', note: '字幕轨/ASR + 抽帧 + 结论一次完成' },
			{ kind: 'ytdlp', note: '只要字面信息时直接问它' },
		],
		needsLogin: false,
		risks: [VIDEO_NO_SUBTITLE_RISK],
	},
	{
		id: 'youtube', name: 'YouTube', type: 'video',
		hostPatterns: [/youtube\.com/i, /youtu\.be/i],
		backends: [
			{ kind: 'video-analyze', note: '字幕轨通常齐备，最准的一条' },
			{ kind: 'ytdlp', note: '只要字面信息时直接问它' },
		],
		needsLogin: false,
		risks: [VIDEO_NO_SUBTITLE_RISK, '直连需要代理的环境会超时 ⇒ 如实说明，不要编内容'],
	},
	{
		id: 'weibo', name: '微博', type: 'mixed',
		hostPatterns: [/weibo\.com/i, /weibo\.cn/i],
		backends: [
			{ kind: 'video-analyze', note: '微博帖多为「图文 + 视频」混排，视频那条最值' },
			{ kind: 'browser', note: '纯图文的帖子走真实浏览器读正文与图' },
		],
		needsLogin: false,
		risks: [VIDEO_NO_SUBTITLE_RISK],
	},
	{
		id: 'weixin', name: '微信公众号', type: 'article',
		hostPatterns: [/mp\.weixin\.qq\.com/i],
		backends: [{ kind: 'web-extract', note: '正文可直读（超限会自动落盘并提示翻页）' }],
		needsLogin: false,
		risks: ['被反爬拦截 ⇒ 换 browser 通道；仍失败就如实说，不要凭标题编内容'],
	},
	{
		id: 'zhihu', name: '知乎', type: 'article',
		hostPatterns: [/zhihu\.com/i],
		backends: [
			{ kind: 'web-extract', note: '文章页（/p/）通常可直读' },
			{ kind: 'browser', note: '问答页（/question/）常要求登录 ⇒ 真实浏览器 + 用户登录一次' },
		],
		needsLogin: true,
		risks: ['未登录只看得到前几条回答 —— 别假装读了整页'],
	},
	{
		id: 'juejin', name: '掘金', type: 'article',
		hostPatterns: [/juejin\.cn/i],
		backends: [{ kind: 'web-extract', note: '静态文章，直读' }],
		needsLogin: false,
		risks: ['被反爬拦截 ⇒ 换 browser 通道；仍失败就如实说'],
	},
	{
		id: 'csdn', name: 'CSDN', type: 'article',
		hostPatterns: [/csdn\.net/i],
		backends: [{ kind: 'web-extract', note: '静态文章，直读' }],
		needsLogin: false,
		risks: ['被反爬拦截 ⇒ 换 browser 通道；仍失败就如实说'],
	},
	{
		id: 'feishu', name: '飞书', type: 'article',
		hostPatterns: [/feishu\.cn/i, /larksuite\.com/i],
		backends: [{ kind: 'web-extract', note: '公开链接可直读；需要权限的文档读不到就是读不到' }],
		needsLogin: false,
		risks: ['需要登录/权限的文档，文本抓取拿不到内容 —— 如实说明，不要编'],
	},
	{
		// ⚠ 兜底必须留在**最后**：`routeForUrl` 在遍历时跳过它、循环结束后才用它。
		//   把它挪到前面会让所有站点都落进兜底（静默地全部降级成 HTTP 抓取）。
		id: 'generic', name: '网页', type: 'article',
		hostPatterns: [/.*/],
		backends: [{ kind: 'web-extract', note: '任意网页的兜底路径' }],
		needsLogin: false,
		risks: [],
	},
];

/** 兜底平台（`routeForUrl` 找不到匹配时的返回值；导出是为了让守卫能钉住"它必须在最后"）。 */
export function genericRoute(): IWebPlatformRoute {
	return WEB_PLATFORM_ROUTES[WEB_PLATFORM_ROUTES.length - 1];
}

/**
 * URL → 平台路由（纯函数）。
 *
 * 与宿主原先的 `detectPlatform` **行为等价**（那正是本模块把它收上来的原因）：
 *   · 解析不出主机名（畸形 / 空串）⇒ 直接给兜底，**不抛错**；
 *   · 遍历时跳过 `generic`，循环结束后才用它 —— 否则兜底那条正则（`.*`）会截胡一切。
 */
export function routeForUrl(url: string): IWebPlatformRoute {
	let host = '';
	try { host = new URL(url).hostname.toLowerCase(); } catch { /* 畸形 URL：落到兜底 */ }
	for (const route of WEB_PLATFORM_ROUTES) {
		if (route.id === 'generic') { continue; }
		if (route.hostPatterns.some(rx => rx.test(host))) { return route; }
	}
	return genericRoute();
}
