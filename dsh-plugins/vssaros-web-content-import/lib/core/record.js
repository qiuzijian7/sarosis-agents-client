// @vssaros/dsh-web-content-import — core（纯逻辑、零 I/O）：落盘形状与解析。
//
// ⚠ 本文件的全部函数**逐形派生**自 IDE 侧真源 `browser/views/knowledgeBase/kbUrlScraper.ts`
//   （composeArticleMarkdown / composeVideoMarkdown / slugifyTitle / planImagePath / parseSubtitlesToText /
//   parseYtDlpPrint / htmlToPlainText / parseMetaTags / guessMediaExt / formatDuration /
//   findMarkdownImageUrls / rewriteMarkdownImageUrls）。两侧隔离 ⇒ 只能各自一份；行为差异由
//   本插件探针（进程内断言）与 IDE 侧 `kbUrlScraper` 用例**共同钉住**（改一边要跑另一边 ✓）。

const ENTITY_MAP = {
	'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
	'&apos;': "'", '&nbsp;': ' ', '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
	'&ldquo;': '“', '&rdquo;': '”', '&lsquo;': '‘', '&rsquo;': '’',
};

function decodeEntities(s) {
	return s.replace(/&[a-z#0-9]+;/gi, m => ENTITY_MAP[m.toLowerCase()] ?? m)
		.replace(/\s+/g, ' ').trim();
}

/**
 * 用正则解析 `<meta>` 元数据（不走 DOMParser —— 那是浏览器侧的事，这里是纯字符串处理 ✓；
 * IDE 真源绕开 DOMParser 是为了规避 Trusted Types，这里同源同形 ✓）。
 * OG / Twitter Card / article 等常见字段均覆盖。
 */
export function parseMetaTags(html) {
	const tags = {};
	const re = /<meta\b([^>]*)\/?>/gi;
	let m;
	while ((m = re.exec(html))) {
		const attrs = m[1];
		const nameM = attrs.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
		const contM = attrs.match(/content\s*=\s*["']([\s\S]*?)["']/i);
		if (nameM && contM) {
			tags[nameM[1].toLowerCase()] = decodeEntities(contM[1]);
		}
	}
	const get = (...keys) => {
		for (const k of keys) { if (tags[k]) { return tags[k]; } }
		return undefined;
	};
	const durationRaw = get('video:duration', 'og:video:duration', 'music:duration');
	let durationSec;
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
export function guessMediaExt(url, mime) {
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

/** 把秒数格式化为 mm:ss / h:mm:ss。 */
export function formatDuration(sec) {
	if (!sec || sec <= 0) { return undefined; }
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = Math.floor(sec % 60);
	const pad = n => String(n).padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * 由标题（优先）或 URL 生成**安全文件名 slug**：保留中文/字母/数字，其余折叠为 `-`。
 * 用于 `库/raw/<slug>.md` 与图片目录 `库/raw/assets/<slug>/`。
 */
export function slugifyTitle(title, url, maxLen = 60) {
	const base = (title ?? '').trim() || (() => {
		try { return new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''; } catch { return ''; }
	})() || 'untitled';
	const cleaned = base
		.replace(/[\\/:*?"<>|#%{}]+/g, '-')   // 文件系统/URL 非法字符
		.replace(/[\s ]+/g, '-')          // 空白 → 连字符
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
export function planImagePath(slug, index, imgUrl, mime) {
	let name = '';
	try { name = decodeURIComponent(new URL(imgUrl).pathname.split('/').filter(Boolean).pop() ?? ''); } catch { /* 非法 URL 用兜底名 */ }
	const stem = name.replace(/\.[A-Za-z0-9]{1,6}$/, '') || 'image';
	const safeStem = stem.replace(/[\\/:*?"<>|#%{}]+/g, '-').replace(/\s+/g, '-').slice(0, 40) || 'image';
	const ext = guessMediaExt(imgUrl, mime).replace(/^\./, '');   // 规范化：去掉可能的点前缀
	return { rel: `assets/${slug}/${index}-${safeStem}.${ext}`, ext };
}

/**
 * 极简 HTML → 纯文本兜底：去掉 script/style，块级标签转换行，再解码常见实体、压缩空行。
 * **不追求格式保真**，只保证「有正文可用」（与 IDE 真源的兜底口径一致 ✓）。
 */
export function htmlToPlainText(html) {
	if (!html) { return ''; }
	let s = html
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '');
	// 保留结构语义：标题/列表/段落 → markdown 近似
	s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, inner) => `\n\n${'#'.repeat(Number(lvl))} ${inner}\n\n`);
	s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${inner}`);
	s = s.replace(/<\/(p|div|section|article|br|tr|ul|ol|table|h[1-6])>/gi, '\n\n');
	s = s.replace(/<(br)\s*\/?>/gi, '\n');
	s = s.replace(/<[^>]+>/g, '');   // 剩余标签去掉
	return s
		.replace(/&[a-z#0-9]+;/gi, m => ENTITY_MAP[m.toLowerCase()] ?? m)
		.replace(/[ \t ]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * 字幕（WebVTT / SRT）→ 纯文本。
 * 去掉 `WEBVTT` 头、NOTE/Kind/Language 行、时间轴、序号与行内标签；**自动字幕逐词重复行会去重**，
 * 并按 `maxChars` 截断（避免把整集字幕塞进 prompt / 笔记）。
 */
export function parseSubtitlesToText(raw, maxChars = 20000) {
	if (!raw) { return ''; }
	const out = [];
	const seen = new Set();
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

/**
 * yt-dlp `--print` 的字段顺序（与 IDE 侧 `kbVideoFetch.PRINT_TEMPLATE` **必须一致**）。
 * ⚠ 刻意不用 `--dump-json`：输出含 formats 数组可达数百 KB ⇒ 用 `--print` 模板只输出一行。
 */
export const YTDLP_PRINT_FIELDS = ['title', 'duration', 'thumbnail', 'uploader', 'upload_date', 'description'];

/** `--print` 字段分隔符：用 `|||` 而非 TAB（TAB 经 shell 传递易被规范化/吃掉）。 */
export const YTDLP_SEP = '|||';

/** yt-dlp 不可用字段的输出标记（统一按「无值」处理）。 */
function ytdlpClean(s) {
	const v = (s ?? '').trim();
	return (!v || v === 'NA' || v === 'None') ? '' : v;
}

function truncateText(s, max) {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** 解析 `yt-dlp --print` 输出的一行 → 元信息（`upload_date` 为 `YYYYMMDD` 时格式化为 `YYYY-MM-DD`）。 */
export function parseYtDlpPrint(line, opts) {
	// 分隔符自适应：真源用 `|||`（避免 shell 转义 TAB），单测/其它调用方可能给真实 TSV
	const parts = (line ?? '').split(line.includes(YTDLP_SEP) ? YTDLP_SEP : '\t');
	const at = i => ytdlpClean(parts[i] ?? '');
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

/** 组装图文 Markdown（标题 / 元信息 / 封面 / 正文）—— 与 IDE 真源逐字同形。 */
export function composeArticleMarkdown({ url, platformName, meta, body, coverLocalPath }) {
	const title = meta.title || url;
	const lines = [`# ${title}`, ''];
	const metaLine = [];
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

/** 组装视频 Markdown（元信息 + 媒体文件引用 + 原链接）—— 与 IDE 真源逐字同形。 */
export function composeVideoMarkdown({ url, platformName, meta, mediaLocalPath, downloaded }) {
	const title = meta.title || url;
	const dur = formatDuration(meta.durationSec);
	const lines = [`# ${title}`, ''];
	const metaLine = [];
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

/** 从 Markdown 正文中抽取所有远程图片 URL（`![alt](url)` 语法）。 */
export function findMarkdownImageUrls(md) {
	const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
	const out = [];
	const seen = new Set();
	let m;
	while ((m = re.exec(md))) {
		if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
	}
	return out;
}

/** 把 Markdown 正文里的远程图片 URL 改写为本地相对路径。 */
export function rewriteMarkdownImageUrls(md, map) {
	let out = md;
	for (const [imgUrl, local] of map) {
		if (imgUrl && local) {
			out = out.split(`](${imgUrl})`).join(`](${local})`);
		}
	}
	return out;
}
