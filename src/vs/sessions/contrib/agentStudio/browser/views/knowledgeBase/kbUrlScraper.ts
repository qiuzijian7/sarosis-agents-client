/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 知识库 URL 导入 —— 统一的多平台抓取解析层（纯函数，无 DI 依赖）。
 *
 * 设计目标：
 *  - 把原先分散的「飞书 / 小红书 / B站 / 抖音 / 知乎」入口收敛为单一「导入链接」入口，
 *    由本模块根据 URL 自动识别平台（小红书 / 抖音 / 知乎 / YouTube / B站 / 微博 / 公众号 …）。
 *  - 区分两类内容：
 *      · article（图文）：抽取标题 / 作者 / 时间 / 封面 / 正文 → Markdown。
 *      · video（视频）：抽取标题 / 作者 / 时长 / 封面 / 直链，best-effort 下载媒体文件。
 *      · mixed（小红书 / 微博）：图文 + 封面图 / 视频，两者皆抓。
 *
 * 注意：渲染进程受同源策略与反爬限制，纯 HTML 抽取对强 SPA / 登录墙站点（抖音、YouTube 等）
 * 只能拿到 OG 元数据；真正的媒体直链下载在能拿到直链时生效。如需 100% 抓取，可后续接入
 * headless 浏览器（Playwright）或外部下载器（yt-dlp）作为 KbUrlScraper 的扩展点。
 */

export type KbUrlPlatformType = 'article' | 'video' | 'mixed' | 'unknown';

export interface IKbPlatformDef {
	/** 稳定 ID（用于日志 / 分类） */
	id: string;
	/** 展示名（中文） */
	name: string;
	/** 内容类型（决定抓取策略） */
	type: KbUrlPlatformType;
	/** 主机名匹配（不区分大小写） */
	hostPatterns: RegExp[];
}

/** 支持的主流平台（顺序即优先级，通用网页放最后兜底）。 */
export const KB_URL_PLATFORMS: IKbPlatformDef[] = [
	{ id: 'xiaohongshu', name: '小红书', type: 'mixed', hostPatterns: [/xhslink\.com/i, /xiaohongshu\.com/i] },
	{ id: 'douyin', name: '抖音', type: 'video', hostPatterns: [/douyin\.com/i, /iesdouyin\.com/i] },
	{ id: 'tiktok', name: 'TikTok', type: 'video', hostPatterns: [/tiktok\.com/i] },
	{ id: 'kuaishou', name: '快手', type: 'video', hostPatterns: [/kuaishou\.com/i, /gifshow\.com/i] },
	{ id: 'bilibili', name: 'B站', type: 'video', hostPatterns: [/bilibili\.com/i, /b23\.tv/i] },
	{ id: 'youtube', name: 'YouTube', type: 'video', hostPatterns: [/youtube\.com/i, /youtu\.be/i] },
	{ id: 'weibo', name: '微博', type: 'mixed', hostPatterns: [/weibo\.com/i, /weibo\.cn/i] },
	{ id: 'weixin', name: '微信公众号', type: 'article', hostPatterns: [/mp\.weixin\.qq\.com/i] },
	{ id: 'zhihu', name: '知乎', type: 'article', hostPatterns: [/zhihu\.com/i] },
	{ id: 'juejin', name: '掘金', type: 'article', hostPatterns: [/juejin\.cn/i] },
	{ id: 'csdn', name: 'CSDN', type: 'article', hostPatterns: [/csdn\.net/i] },
	{ id: 'feishu', name: '飞书', type: 'article', hostPatterns: [/feishu\.cn/i, /larksuite\.com/i] },
	{ id: 'generic', name: '网页', type: 'article', hostPatterns: [/.*/] },
];

/** 根据 URL 识别平台（无法解析时回退到通用网页）。 */
export function detectPlatform(url: string): IKbPlatformDef {
	let host = '';
	try { host = new URL(url).hostname; } catch { /* ignore */ }
	for (const p of KB_URL_PLATFORMS) {
		if (p.id === 'generic') { continue; }
		if (p.hostPatterns.some(rx => rx.test(host))) { return p; }
	}
	return KB_URL_PLATFORMS[KB_URL_PLATFORMS.length - 1];
}

/**
 * 升级 http:// → https:// 以通过渲染进程 connect-src CSP（仅允许 https:/ws:/localhost）。
 * 小红书等短链（如 xhslink.com）默认下发 http 链接，若直接请求会被 CSP 拦截；
 * 绝大多数站点（含 xhslink.com）均支持 https 并会自动跳转，故统一升级为 https。
 */
export function toSecureScheme(url: string): string {
	return /^http:\/\//i.test(url) ? url.replace(/^http:\/\//i, 'https://') : url;
}

export interface IKbMetaTags {
	title?: string;
	author?: string;
	siteName?: string;
	description?: string;
	/** 发布时间（ISO 或原文） */
	date?: string;
	/** 封面 / 头图 URL */
	cover?: string;
	/** 视频直链（og:video / twitter:player:stream 等） */
	videoUrl?: string;
	/** 视频时长（秒，尽量解析） */
	durationSec?: number;
	tags?: string[];
}

const ENTITY_MAP: Record<string, string> = {
	'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
	'&apos;': "'", '&nbsp;': ' ', '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
	'&ldquo;': '“', '&rdquo;': '”', '&lsquo;': '‘', '&rsquo;': '’',
};

function decodeEntities(s: string): string {
	return s.replace(/&[a-z#0-9]+;/gi, m => ENTITY_MAP[m.toLowerCase()] ?? m)
		.replace(/\s+/g, ' ').trim();
}

/**
 * 用正则解析 <meta> 元数据（不走 DOMParser，规避本 fork 的 Trusted Types 策略拦截）。
 * OG / Twitter Card / article 等常见字段均覆盖。
 */
export function parseMetaTags(html: string): IKbMetaTags {
	const tags: Record<string, string> = {};
	const re = /<meta\b([^>]*)\/?>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		const attrs = m[1];
		const nameM = attrs.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
		const contM = attrs.match(/content\s*=\s*["']([\s\S]*?)["']/i);
		if (nameM && contM) {
			tags[nameM[1].toLowerCase()] = decodeEntities(contM[1]);
		}
	}
	const get = (...keys: string[]): string | undefined => {
		for (const k of keys) { if (tags[k]) { return tags[k]; } }
		return undefined;
	};
	const durationRaw = get('video:duration', 'og:video:duration', 'music:duration');
	let durationSec: number | undefined;
	if (durationRaw) {
		const n = Number(durationRaw);
		durationSec = Number.isFinite(n) ? n : undefined;
	}
	return {
		title: get('og:title', 'twitter:title', 'title'),
		author: get('article:author', 'author', 'og:author', 'twitter:creator', 'music:musician'),
		siteName: get('og:site_name'),
		description: get('og:description', 'twitter:description', 'description'),
		date: get('article:published_time', 'article:modified_time', 'date', 'publishdate'),
		cover: get('og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'),
		videoUrl: get('og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream', 'twitter:player:stream:url'),
		durationSec,
		tags: get('article:tag')?.split(/[,\s]+/).filter(Boolean),
	};
}

/** 推断媒体扩展名（用于下载文件落盘）。 */
export function guessMediaExt(url: string, mime?: string): string {
	const u = url.split('?')[0].split('#')[0];
	const ext = u.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
	if (ext && !['html', 'htm', 'php', 'aspx'].includes(ext)) { return ext; }
	if (mime) {
		if (mime.includes('mp4')) { return 'mp4'; }
		if (mime.includes('webm')) { return 'webm'; }
		if (mime.includes('ogg')) { return 'ogg'; }
		if (mime.includes('m3u8')) { return 'm3u8'; }
		if (mime.includes('mpeg') || mime.includes('mp3')) { return 'mp3'; }
		if (mime.includes('jpeg')) { return 'jpg'; }
		if (mime.includes('png')) { return 'png'; }
		if (mime.includes('gif')) { return 'gif'; }
	}
	return 'bin';
}

/** 判断视频直链是否可直接下载（m3u8 需额外处理，本模块不下载）。 */
export function isDownloadableMedia(url: string, mime?: string): boolean {
	const ext = guessMediaExt(url, mime);
	if (ext === 'm3u8') { return false; }
	const lower = (url.split('?')[0].toLowerCase());
	return /\.(mp4|webm|ogg|mov|m4v|mkv)$/i.test(lower)
		|| (!!mime && /video\/(mp4|webm|ogg|quicktime)/i.test(mime));
}

/** 把秒数格式化为 mm:ss / h:mm:ss。 */
export function formatDuration(sec?: number): string | undefined {
	if (!sec || sec <= 0) { return undefined; }
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = Math.floor(sec % 60);
	const pad = (n: number) => String(n).padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * 从 Markdown 正文中抽取所有远程图片 URL（![alt](url) 语法）。
 * 纯函数，便于单测（对应测试用例 T11）。
 */
export function findMarkdownImageUrls(md: string): string[] {
	const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
	const out: string[] = [];
	const seen = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = re.exec(md))) {
		if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
	}
	return out;
}

/**
 * 把 Markdown 正文里出现的远程图片 URL 按 map 改写为本地路径（未命中 map 的保持原样）。
 * 纯函数，与 findMarkdownImageUrls 配对使用。
 */
export function rewriteMarkdownImageUrls(md: string, map: Map<string, string>): string {
	let out = md;
	for (const [imgUrl, local] of map) {
		if (imgUrl && local) {
			out = out.split(`](${imgUrl})`).join(`](${local})`);
		}
	}
	return out;
}

/** 组装图文 Markdown（标题 / 元信息 / 封面 / 正文）。 */
export function composeArticleMarkdown(opts: {
	url: string;
	platformName: string;
	meta: IKbMetaTags;
	body: string;
	coverLocalPath?: string;
}): string {
	const { url, platformName, meta, body, coverLocalPath } = opts;
	const title = meta.title || url;
	const lines: string[] = [`# ${title}`, ''];
	const metaLine: string[] = [];
	if (meta.author) { metaLine.push(`作者：${meta.author}`); }
	if (meta.siteName) { metaLine.push(`来源：${meta.siteName}`); }
	if (meta.date) { metaLine.push(`发布：${meta.date}`); }
	if (metaLine.length) { lines.push(`> ${metaLine.join(' · ')}`); }
	lines.push(`> 平台：${platformName} · 原文：${url}`, '');
	if (coverLocalPath) {
		lines.push(`![封面](${coverLocalPath})`, '');
	} else if (meta.cover) {
		lines.push(`![封面](${meta.cover})`, '');
	}
	if (meta.description) { lines.push(`**摘要**：${meta.description}`, ''); }
	if (body) { lines.push(body.trim(), ''); }
	if (meta.tags?.length) { lines.push(`标签：${meta.tags.join(' / ')}`, ''); }
	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** 组装视频 Markdown（元信息 + 媒体文件引用 + 原链接）。 */
export function composeVideoMarkdown(opts: {
	url: string;
	platformName: string;
	meta: IKbMetaTags;
	mediaLocalPath?: string;
	downloaded: boolean;
}): string {
	const { url, platformName, meta, mediaLocalPath, downloaded } = opts;
	const title = meta.title || url;
	const dur = formatDuration(meta.durationSec);
	const lines: string[] = [`# ${title}`, ''];
	const metaLine: string[] = [];
	if (meta.author) { metaLine.push(`作者：${meta.author}`); }
	if (meta.siteName) { metaLine.push(`平台：${platformName}`); }
	if (dur) { metaLine.push(`时长：${dur}`); }
	if (meta.date) { metaLine.push(`发布：${meta.date}`); }
	if (metaLine.length) { lines.push(`> ${metaLine.join(' · ')}`); }
	lines.push(`> 原文：${url}`, '');
	if (meta.cover) { lines.push(`![封面](${meta.cover})`, ''); }
	if (downloaded && mediaLocalPath) {
		lines.push(`**已抓取视频文件**：[${title}](${mediaLocalPath})`, '');
	} else {
		lines.push(`> ⚠️ 未能直接下载视频文件（平台反爬 / 需登录 / 分片流）。可前往原文手动保存，或接入 headless 浏览器 / yt-dlp 扩展点后重试。`, '');
	}
	if (meta.description) { lines.push(`**简介**：${meta.description}`, ''); }
	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
