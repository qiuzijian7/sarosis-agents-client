// @vssaros/dsh-web-content-import — core（纯逻辑、零 I/O）：HTML 正文/图片提取 + 质量判定。
//
// ⚠ 质量判定**逐形派生**自 IDE 侧真源 `common/webPageQuality.ts`（2026-10-13 版：四类成因 + 四张特征表 +
//   判定顺序）。那是"假成功"防线的核心（拦截页/登录墙绝不能当正文返回 ✗），两侧隔离 ⇒ 各自一份；
//   特征表与阈值由本插件探针钉住关键样本（改一侧要跑另一侧的用例 ✓）。
// ⚠ 正文提取是**简版**（容器优先 + 文本化）：完整 reader-mode 在 IDE 侧主进程，本插件是它的 dsh 侧等价物，
//   加强时对齐它（别在这里另发明一套）。

import { htmlToPlainText, parseMetaTags } from './record.js';

// ─── 质量判定（逐形派生 webPageQuality.ts）──────────────────────────────────────

/** 判定为"有内容"的下限（与真源同值）。 */
export const MIN_USEFUL_CONTENT_LENGTH = 200;
/** 只有短页才套用"弱特征"（与真源同值）。 */
export const SHORT_PAGE_LIMIT = 600;
/** 特征扫描窗口：标题 + 正文前 N 字符（与真源同值）。 */
export const SCAN_HEAD_CHARS = 300;

/**
 * **强**拦截特征：出现即判定"这不是页面内容"，与页面长度无关。
 * 收录纪律（与真源同）：只收**整句短语**（单个词会出现在讲这些技术的文章里 ⇒ 误判的代价远大于漏判）。
 */
const STRONG_BLOCK_PATTERNS = [
	{ re: /checking your browser( before accessing)?/i, label: 'cloudflare-browser-check' },
	{ re: /enable javascript and cookies to continue/i, label: 'js-cookies-required' },
	{ re: /attention required!\s*[|\-–—]\s*cloudflare/i, label: 'cloudflare-block-page' },
	{ re: /ddos protection by/i, label: 'ddos-guard' },
	{ re: /(verifying|checking) (that )?you are (a )?human/i, label: 'human-verification' },
	{ re: /cf-(chl-|browser-verification)/i, label: 'cloudflare-chl' },
	{ re: /(网站|站点|服务)(正在)?(进行)?(安全|人机|身份)?验证/, label: 'zh-verification' },
	{ re: /(请|需要)(启用|开启)\s*(您的)?\s*JavaScript/i, label: 'zh-js-required' },
];

/** **弱**特征：只在**整页很短**时才判定（这些词在正常文章头部非常常见）。 */
const WEAK_BLOCK_PATTERNS = [
	{ re: /just a moment/i, label: 'cloudflare-interstitial' },
	{ re: /(re|h)captcha|turnstile/i, label: 'captcha' },
	{ re: /are you a robot/i, label: 'robot-check' },
	{ re: /access denied|403 forbidden/i, label: 'access-denied' },
	{ re: /too many requests|rate limit(ed)?/i, label: 'rate-limited' },
];

/** **页面级「内容不可用 / 已删除」**（与登录墙分开：成因不同，下一步不同）。 */
const STRONG_UNAVAILABLE_PATTERNS = [
	{ re: /你访问的页面不见了/, label: 'zh-page-gone' },
	{ re: /(当前)?笔记(暂时)?无法(浏览|查看)/, label: 'zh-note-unavailable' },
	{ re: /你要(查看|访问)的页面(不存在|已删除|找不到了)/, label: 'zh-page-removed' },
];

/** **登录墙 / 客户端墙**的弱形态：只在整页很短时才判定（与真源同：通用句式，强匹配会误伤教程）。 */
const LOGIN_WALL_PATTERNS = [
	{ re: /请先登录后(查看|继续|访问)/, label: 'zh-login-required' },
	{ re: /登录后(可)?查看/, label: 'zh-login-to-view' },
	{ re: /请(在|用)(手机|App|客户端)(内|中)?(打开|查看)/i, label: 'zh-app-only' },
];

function kindReason(kind) {
	switch (kind) {
		case 'login-required': return 'page requires login / app';
		case 'unavailable': return 'page reports itself as gone or restricted';
		default: return 'looks like an interstitial, not page content';
	}
}

/**
 * 判定一段提取出来的正文属于「真内容 / 可疑地短 / 根本不是内容」（与真源同一判定顺序）：
 *   1. 强特征（含"页面说自己不可用"那一组）命中 → `blocked`
 *   2. 整页很短 且 弱特征命中 → `blocked`
 *   3. 长度 < 200 → `thin`（**不是失败**：页面可能真的很短 ⇒ 照常返回 + 附告警）
 *   4. 其余 → `ok`
 * `blocked` 才不允许把文本当内容返回 ✓；`thin` 照常返回 + 带 `thin:true` ✓。
 */
export function classifyExtractQuality(text, title) {
	const trimmed = (text ?? '').trim();
	const length = trimmed.length;
	const head = `${title ?? ''}\n${trimmed.slice(0, SCAN_HEAD_CHARS)}`;

	const signals = [];
	// 优先级（靠前的更强、且不被靠后的覆盖）：login-required ＞ unavailable ＞ interstitial（与真源同）。
	let kind;

	for (const p of STRONG_UNAVAILABLE_PATTERNS) {
		if (p.re.test(head)) { signals.push(p.label); kind = 'unavailable'; }
	}
	for (const p of STRONG_BLOCK_PATTERNS) {
		if (p.re.test(head)) { signals.push(p.label); kind ??= 'interstitial'; }
	}
	if (signals.length === 0 && length < SHORT_PAGE_LIMIT) {
		for (const p of LOGIN_WALL_PATTERNS) {
			if (p.re.test(head)) { signals.push(p.label); kind = 'login-required'; }
		}
		for (const p of WEAK_BLOCK_PATTERNS) {
			if (p.re.test(head)) { signals.push(p.label); kind ??= 'interstitial'; }
		}
	}
	if (signals.length > 0) {
		return { verdict: 'blocked', kind, length, reason: `${kindReason(kind)} (${signals.join(', ')})`, signals };
	}
	if (length < MIN_USEFUL_CONTENT_LENGTH) {
		return { verdict: 'thin', length, reason: `extracted text is suspiciously short (${length} < ${MIN_USEFUL_CONTENT_LENGTH} chars)`, signals: [] };
	}
	return { verdict: 'ok', length, reason: 'content looks usable', signals: [] };
}

// ─── 正文提取（简版：容器优先 + 文本化）────────────────────────────────────────

/**
 * 优先容器（命中即用它的 innerHTML，否则整页）：
 * `<article>` / `<main>` / `[role="main"]` 是语义容器；后面几个是高频平台正文容器的 class/id 片段。
 * ⚠ 正则对嵌套标签的止境不精确 —— 这是**简版**的已知边界（宁可多带一点，也不少截 ✓）。
 */
const CONTENT_CONTAINER_RES = [
	/<article\b[^>]*>([\s\S]*?)<\/article>/i,
	/<main\b[^>]*>([\s\S]*?)<\/main>/i,
	/<div\b[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
	/<div\b[^>]*id=["']js_content["'][^>]*>([\s\S]*)/i,          // 微信公众号正文
	/<div\b[^>]*class=["'][^"']*(?:Post-RichText|RichText|article-content|post-content|markdown-body|content_views)[^"']*["'][^>]*>([\s\S]*)/i,
];

/**
 * 提取正文：优先容器 → 整页，再 `htmlToPlainText`。
 * 返回 `{ body, container }`（`container` = 命中的容器名或 'whole-page'，诊断用）。
 */
export function extractBody(html) {
	for (let i = 0; i < CONTENT_CONTAINER_RES.length; i++) {
		const m = CONTENT_CONTAINER_RES[i].exec(html);
		if (m?.[1]) {
			const body = htmlToPlainText(m[1]);
			if (body.length >= MIN_USEFUL_CONTENT_LENGTH) {
				return { body, container: `container#${i}` };
			}
		}
	}
	return { body: htmlToPlainText(html), container: 'whole-page' };
}

/**
 * 提取页面图片清单（`<img>`）：`{ url, alt }`，按出现顺序去重。
 * 纪律（与 IDE 侧 `browser_get_images` 同口径）：`data:` 内联图跳过；尺寸未知的**保留**
 * （未进视口不等于没图）；`currentSrc` 一类的懒加载真地址优先（`data-src` / `data-original` / `data-lazy-src`）。
 */
export function extractImages(html, pageUrl) {
	const out = [];
	const seen = new Set();
	const re = /<img\b([^>]*)\/?>/gi;
	let m;
	while ((m = re.exec(html))) {
		const attrs = m[1];
		const attrOf = name => {
			const a = attrs.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
			return a?.[1] ?? '';
		};
		let src = attrOf('data-src') || attrOf('data-original') || attrOf('data-lazy-src') || attrOf('src');
		if (!src || src.startsWith('data:')) { continue; }
		if (src.startsWith('//')) { src = 'https:' + src; }
		else if (src.startsWith('/') && pageUrl) {
			try { src = new URL(src, pageUrl).href; } catch { /* 保留原样 */ }
		}
		if (!/^https?:/i.test(src) || seen.has(src)) { continue; }
		seen.add(src);
		out.push({ url: src, alt: attrOf('alt') });
	}
	return out;
}

/** 一站式提取：元数据 + 正文 + 图片 + 质量判定（页面文本化后才判质量 ✓）。 */
export function extractArticle(html, pageUrl) {
	const meta = parseMetaTags(html);
	if (!meta.title) {
		const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
		if (t?.[1]) { meta.title = t[1].replace(/<[^>]+>/g, '').trim(); }
	}
	const { body, container } = extractBody(html);
	const images = extractImages(html, pageUrl);
	const quality = classifyExtractQuality(body, meta.title);
	return { meta, body, container, images, quality };
}
