// @vssaros/dsh-web-content-import — core（纯逻辑、零 I/O）：平台路由表。
//
// ⚠ 真源在 IDE 侧 `src/vs/sessions/contrib/agentStudio/common/webPlatformRoutes.ts`（2026-10-13 收敛）。
//   本表是它的 **JS 派生副本**（插件间不能 import、`src/vs` 与 `dsh-plugins` 互相隔离 ⇒ 只能各自一份）；
//   两侧的平台集合 / 首选通道 / `needsLogin` 由守卫对账（本插件探针 + IDE 侧 `webPlatformRoutes` 测试）✓。
//   ⚠ 增删平台时**三处一起动**：本表 / IDE 真源 / `resources/.agents/skills/web-content-import/SKILL.md` 的表格。
//
// backend `kind` 沿用 IDE 真源的值域（web-extract / browser / video-analyze / ytdlp / vision-analyze）✓；
// 本插件的**分派**把 kind 映射到自己的实现（见 `lib/index.js`）：
//   · web-extract           → HTTP fetch + reader 提取（`lib/core/extract.js`）
//   · ytdlp / video-analyze → yt-dlp 元信息 + 字幕轨；无字幕轨 ⇒ whisper ASR（`lib/core/video.js` + `asr.js`）
//   · browser               → 本插件**不自己驱动浏览器**：先按 HTTP 抓一次，拿到占位页 ⇒ 返回 blocked +
//                             指引（模型用 `browser` 工具抓整页 HTML 后以 `html` 参数喂回本工具 ——
//                             抓取归 browser，提取与写库归本插件 ✓，职责不混 ✓）
//   · vision-analyze        → 仅提示（图内文字要模型自己用 `vision_analyze` 逐张读 —— 插件侧没有视觉模型 ✗）

/** 内容类型（与 IDE 侧 `WebPlatformContentType` 值域一致 ✓）。 */
export const CONTENT_TYPES = ['article', 'video', 'mixed', 'unknown'];

/** 抓取通道的种类（封闭集合，与 IDE 真源同值 ✓；守卫会拒绝未登记的 kind）。 */
export const KNOWN_BACKEND_KINDS = ['web-extract', 'browser', 'video-analyze', 'ytdlp', 'vision-analyze'];

/** 视频类站点的共同坑（与 IDE 真源同一句 ✓ —— 多处复用，别各写各的）。 */
const VIDEO_NO_SUBTITLE_RISK = '多数视频没有字幕轨 ⇒ 口播走 video_analyze 内置的本地 ASR（whisper，随包自带）';

/**
 * 平台路由表（**顺序 = 匹配优先级**；`generic` 兜底必须留**最后**）。
 * ⚠ 与 IDE 真源逐形一致：`id` / `name` / `type` / `hostPatterns` / `backends`（顺序即语义）/ `needsLogin` / `risks`。
 */
export const WEB_PLATFORM_ROUTES = [
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
export function genericRoute() {
	return WEB_PLATFORM_ROUTES[WEB_PLATFORM_ROUTES.length - 1];
}

/**
 * URL → 平台路由（纯函数；与 IDE 真源**行为等价**）：
 *   · 解析不出主机名（畸形 / 空串）⇒ 直接给兜底，**不抛错**；
 *   · 遍历时跳过 `generic`，循环结束后才用它 —— 否则兜底那条正则（`.*`）会截胡一切。
 */
export function routeForUrl(url) {
	let host = '';
	try { host = new URL(url).hostname.toLowerCase(); } catch { /* 畸形 URL：落到兜底 */ }
	for (const route of WEB_PLATFORM_ROUTES) {
		if (route.id === 'generic') { continue; }
		if (route.hostPatterns.some(rx => rx.test(host))) { return route; }
	}
	return genericRoute();
}
