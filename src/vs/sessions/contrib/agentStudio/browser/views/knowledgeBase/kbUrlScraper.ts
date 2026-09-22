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
	/**
	 * 视频**字幕纯文本**（yt-dlp `--write-subs/--write-auto-subs` 抓取后，经
	 * `parseSubtitlesToText()` 清洗）—— 供 agent 总结视频内容；无字幕时为空。
	 */
	subtitleText?: string;
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
// ─── URL 导入：文件名 / 图片路径规划 / HTML 兜底（2026-09-22）─────────────────

/**
 * 由标题（优先）或 URL 生成**安全文件名 slug**：保留中文/字母/数字，其余折叠为 `-`。
 * 用于 `库/raw/<slug>.md` 与图片目录 `库/raw/assets/<slug>/`。
 */
export function slugifyTitle(title: string | undefined, url: string, maxLen = 60): string {
	const base = (title ?? '').trim() || (() => {
		try { return new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''; } catch { return ''; }
	})() || 'untitled';
	const cleaned = base
		.replace(/[\\/:*?"<>|#%{}]+/g, '-')   // 文件系统/URL 非法字符
		.replace(/[\s\u3000]+/g, '-')          // 空白 → 连字符
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '');
	const out = cleaned.slice(0, Math.max(1, maxLen)).replace(/-+$/g, '');
	return out || 'untitled';
}

/**
 * 规划网页图片在知识库内的**相对路径**（相对 markdown 所在目录）。
 * 形如 `assets/<slug>/<序号>-<原名>.<ext>`；序号保证同名图不互相覆盖。
 * ⚠ 该相对形式同时满足两处解析约定：笔记预览 `resolveAssetSrc`（相对笔记目录）
 *    与飞书同步 `extractImages`（`path.dirname(note)`）。
 */
export function planImagePath(slug: string, index: number, imgUrl: string, mime?: string): { rel: string; ext: string } {
	let name = '';
	try { name = decodeURIComponent(new URL(imgUrl).pathname.split('/').filter(Boolean).pop() ?? ''); } catch { /* 非法 URL 用兜底名 */ }
	const stem = name.replace(/\.[A-Za-z0-9]{1,6}$/, '') || 'image';
	const safeStem = stem.replace(/[\\/:*?"<>|#%{}]+/g, '-').replace(/\s+/g, '-').slice(0, 40) || 'image';
	const ext = guessMediaExt(imgUrl, mime).replace(/^\./, '');   // 规范化：去掉可能的点前缀
	return { rel: `assets/${slug}/${index}-${safeStem}.${ext}`, ext };
}

/**
 * 极简 HTML → 纯文本兜底（当主进程提取器不可用时使用）：去掉 script/style，块级标签转换行，
 * 再解码常见实体、压缩空行。**不追求格式保真**，只保证「有正文可用」。
 */
export function htmlToPlainText(html: string): string {
	if (!html) { return ''; }
	let s = html
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '');
	// 保留结构语义：标题/列表/段落 → markdown 近似
	s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => `\n\n${'#'.repeat(Number(lvl))} ${inner}\n\n`);
	s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inner}`);
	s = s.replace(/<\/(p|div|section|article|br|tr|ul|ol|table|h[1-6])>/gi, '\n\n');
	s = s.replace(/<(br)\s*\/?>/gi, '\n');
	s = s.replace(/<[^>]+>/g, '');   // 剩余标签去掉
	return s
		.replace(/&[a-z#0-9]+;/gi, m => ENTITY_MAP[m.toLowerCase()] ?? m)
		.replace(/[ \t\u3000]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// ─── 视频元信息（yt-dlp 扩展点，2026-09-22）───────────────────────────────────

/**
 * yt-dlp `--print` 的字段顺序（与 `kbVideoFetch.PRINT_TEMPLATE` 必须一致）。
 * ⚠ 刻意不用 `--dump-json`：主进程命令通道是**单次缓冲**，dump-json 含 formats 数组可达数百 KB。
 */
export const YTDLP_PRINT_FIELDS = ['title', 'duration', 'thumbnail', 'uploader', 'upload_date', 'description'] as const;

/** `--print` 字段分隔符：用 `|||` 而非 TAB（TAB 经 shell 传递易被规范化/吃掉）。 */
export const YTDLP_SEP = '|||';

/** yt-dlp 不可用字段的输出标记（统一按「无值」处理）。 */
function ytdlpClean(s: string): string {
	const v = (s ?? '').trim();
	return (!v || v === 'NA' || v === 'None') ? '' : v;
}

function truncateText(s: string, max: number): string {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * 解析 `yt-dlp --print` 输出的一行 TSV → 元信息（纯函数，便于单测）。
 * 字段顺序见 `YTDLP_PRINT_FIELDS`；`upload_date` 为 `YYYYMMDD` 时格式化为 `YYYY-MM-DD`。
 */
/**
 * 字幕（WebVTT / SRT）→ 纯文本（纯函数，便于单测）。
 * 去掉 `WEBVTT` 头、NOTE/Kind/Language 行、时间轴、序号与行内标签；**自动字幕逐词重复行会去重**，
 * 并按 `maxChars` 截断（避免把整集字幕塞进 prompt / 笔记）。
 */
export function parseSubtitlesToText(raw: string, maxChars = 20000): string {
	if (!raw) { return ''; }
	const out: string[] = [];
	const seen = new Set<string>();
	let last = '';
	let total = 0;
	for (const line of raw.split(/\r?\n/)) {
		const t = line.trim();
		if (!t) { continue; }
		if (t === 'WEBVTT' || /^NOTE\b/.test(t) || /^(Kind|Language):/.test(t)) { continue; }
		if (t.includes('-->')) { continue; }            // 时间轴行
		if (/^\d+$/.test(t)) { continue; }              // SRT 序号
		const text = t.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
		if (!text || text === last || seen.has(text)) { continue; }
		seen.add(text);
		last = text;
		out.push(text);
		total += text.length;
		if (total > maxChars) { break; }
	}
	return out.join('\n').trim();
}

export function parseYtDlpPrint(line: string, opts?: { platformName?: string }): IKbMetaTags {
	// 分隔符自适应：kbVideoFetch 用 `|||`（避免 shell 转义 TAB），单测/其它调用方可能给真实 TSV
	const parts = (line ?? '').split(line.includes(YTDLP_SEP) ? YTDLP_SEP : '\t');
	const at = (i: number) => ytdlpClean(parts[i] ?? '');
	const dur = Number.parseInt(at(1), 10);
	const rawDate = at(4);
	return {
		title: at(0) || undefined,
		durationSec: Number.isFinite(dur) && dur > 0 ? dur : undefined,
		cover: at(2) || undefined,
		author: at(3) || undefined,
		date: /^\d{8}$/.test(rawDate)
			? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
			: (rawDate || undefined),
		siteName: opts?.platformName || undefined,
		description: at(5) ? truncateText(at(5), 500) : undefined,
	};
}

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
