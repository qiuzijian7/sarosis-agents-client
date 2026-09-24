/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「这段文本到底是不是页面内容」的判定真源（阈值 + 特征表 + 分类器）—— 2026-09-24。
 *
 * ## 为什么在 `common/`（而不在 web_extract 的工具层）
 *
 * 因为**两条通道都要用它**：
 *   · `web_extract`（HTTP 抓取）—— 原文见 `providers/tool/webSearchParse.ts`，那里现在只做转发；
 *   · 浏览器通道（`browser/browserCdpSnapshot.ts` 的 `formatSnapshot` / `formatImages`）——
 *     真正被驱动的浏览器同样会撞上登录墙，而浏览器层**不该**反向依赖工具层（层次倒挂）。
 * 判定真源一旦有两份，就会出现"HTTP 说这是登录墙、浏览器说这是正常页"的口径漂移。
 *
 * ## 历史（谁逼出来的）
 *
 * 实测来源（2026-09-24 用户生产日志）：小红书**未登录**时，reader-mode 抓到的"正文"其实是
 * 站点占位页 —— 标题 `小红书 - 你访问的页面不见了`、正文 1152 字符（导航 + 这句通知）。它既
 * 超过弱特征的 600 字符阈值、又不在任何特征表里，于是被判 `ok`，日志留下
 * `web_extract(reader-mode): … verdict=ok`，**假页面被当成功喂给模型**。
 *
 * 补上 `unavailable` 那一组之后，HTTP 那条路会标签化失败；但**浏览器**那条路上仍无任何标注
 * （页面只是"渲染得很少"），模型于是自己编原因 —— 用户收到的是一张这样的表：
 *
 *   | 正文配图 | ❌ 未获取 | 登录墙下内容图不渲染，仅返回头像/图标 |
 *
 * 而它**从没查过任何证据**（同一份日志里连一次 `browser_*` 调用都没有）。`browserPageWallNotice`
 * 就是为这行字写的：把"这是占位页 + 缺的是登录态 + 下一步在哪个窗口登录"直接摆到模型面前。
 */

import { CHROME_REMOTE_DEBUGGING_PAGE } from './chromeDebugSetup.js';

/**
 * 正文低于此长度即视为 `thin`（可疑）。
 *
 * ⚠ 与 `WebPageLoader.MIN_CONTENT_LENGTH = 100` **不是一回事**，不要合并：那个是"换不换
 * 提取技术"的内部阈值，这个是"够不够模型用"的对外语义。合并会让调内部阈值意外改变
 * 对外行为。
 */
export const MIN_USEFUL_CONTENT_LENGTH = 200;

/** 判定为短页的上限（只有短页才套用"弱特征"，见下方注释）。 */
const SHORT_PAGE_LIMIT = 600;

/** 特征扫描窗口：标题 + 正文前 N 字符（拦截页都很短，窗口足够；避免长文里偶现的短语误判）。 */
const SCAN_HEAD_CHARS = 300;

/**
 * **强**拦截特征：出现即判定"这不是页面内容"，与页面长度无关。
 *
 * 收录纪律（加之前先过这一关，否则容易把好页面变成失败）：
 *   ① 必须是**整句短语**级特征，不收单个词 —— `verify` / `loading` / `blocked` 这类词
 *      会正常出现在讲这些技术的文章里。误判的代价（好内容被拒）远大于漏判（回到旧行为）。
 *   ② 每条都要能回答："它出现在正文里意味着什么？"—— 答不上来就不该收。
 * 中英双语都收：中文站点的"安全验证"页同样常见。
 */
const STRONG_BLOCK_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
	{ re: /checking your browser( before accessing)?/i, label: 'cloudflare-browser-check' },
	{ re: /enable javascript and cookies to continue/i, label: 'js-cookies-required' },
	{ re: /attention required!\s*[|\-–—]\s*cloudflare/i, label: 'cloudflare-block-page' },
	{ re: /ddos protection by/i, label: 'ddos-guard' },
	{ re: /(verifying|checking) (that )?you are (a )?human/i, label: 'human-verification' },
	{ re: /cf-(chl-|browser-verification)/i, label: 'cloudflare-chl' },
	{ re: /(网站|站点|服务)(正在)?(进行)?(安全|人机|身份)?验证/i, label: 'zh-verification' },
	{ re: /(请|需要)(启用|开启)\s*(您的)?\s*JavaScript/i, label: 'zh-js-required' },
];

/**
 * **弱**特征：只在**整页很短**时才判定（这些词出现在正常文章的头部非常常见）。
 * 典型来源：Cloudflare 的 "Just a moment..."、验证码墙、限流页。
 */
const WEAK_BLOCK_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
	{ re: /just a moment/i, label: 'cloudflare-interstitial' },
	{ re: /(re|h)captcha|turnstile/i, label: 'captcha' },
	{ re: /are you a robot/i, label: 'robot-check' },
	{ re: /access denied|403 forbidden/i, label: 'access-denied' },
	{ re: /too many requests|rate limit(ed)?/i, label: 'rate-limited' },
];

/**
 * **页面级「内容不可用 / 需要登录」** —— 与上面两类反爬拦截分开，因为**给模型的下一步
 * 动作不同**：反爬页换来源或换通道都可能成；登录墙/已删除则只能**换通道**（真浏览器 + 用户登录
 * 一次）或干脆放弃。混成一句会让模型在无解的路上重试。
 *
 * 收录纪律同强特征（整句短语、能回答"它出现在正文里意味着什么"），另加一条：只收那种
 * "**页面在说它自己不可用**"的句子 —— 正常文章不会整句这么写。
 */
const STRONG_UNAVAILABLE_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
	{ re: /你访问的页面不见了/, label: 'zh-page-gone' },
	{ re: /(当前)?笔记(暂时)?无法(浏览|查看)/, label: 'zh-note-unavailable' },
	{ re: /你要(查看|访问)的页面(不存在|已删除|找不到了)/, label: 'zh-page-removed' },
];

/**
 * 登录 / 客户端墙的**弱**形态：只在整页很短时才判定。
 *
 * 为什么不敢收成强特征：这些是**通用句式**（教程里引用一句"请先登录后查看"完全可能），强匹配会
 * 把好文章拒掉 —— 按本模块的收录纪律，误判的代价远大于漏判。而"整页 < 600 字符"本身就是
 * "这里几乎没有内容"的独立证据，两者叠加才判。
 */
const WEAK_UNAVAILABLE_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
	{ re: /请先登录后(查看|继续|访问)/, label: 'zh-login-required' },
	{ re: /登录后(可)?查看/, label: 'zh-login-to-view' },
	{ re: /请(在|用)(手机|App|客户端)(内|中)?(打开|查看)/i, label: 'zh-app-only' },
];

export interface IExtractQuality {
	readonly verdict: 'ok' | 'thin' | 'blocked';
	/**
	 * `blocked` 时区分**两类成因** —— 它决定给模型的下一步动作（见 `webExtractBlockedMessage`）：
	 *   · `interstitial` —— 反爬 / 人机校验页：换来源、换通道都可能有效；
	 *   · `unavailable`  —— 登录墙 / 内容已删除：只能换通道（真浏览器 + 用户登录一次）或放弃。
	 * `ok` / `thin` 时**不设**（不要用它表达"内容好不好"）。
	 */
	readonly kind?: 'interstitial' | 'unavailable';
	/** `trim()` 后的正文字符数（告警文案要用）。 */
	readonly length: number;
	/** 人读原因（进日志）。 */
	readonly reason: string;
	/** 命中的特征标签（诊断用；`ok` 时为空）。 */
	readonly signals: readonly string[];
}

/**
 * 判定一段提取出来的正文属于「真内容 / 可疑地短 / 根本不是内容」。
 *
 * 判定顺序：
 *   1. 强特征（含"页面说自己不可用"那一组）命中 → `blocked`
 *   2. 整页很短 且 弱特征命中 → `blocked`
 *   3. 长度 < MIN_USEFUL_CONTENT_LENGTH → `thin`
 *   4. 其余 → `ok`
 *
 * 注意 `thin` **不是失败**：页面可能真的很短。调用方的处置是"附告警照常返回"，
 * 而不是拒绝 —— 只有 `blocked` 才不允许把文本当内容返回。
 */
export function classifyExtractQuality(text: string, title?: string): IExtractQuality {
	const trimmed = (text ?? '').trim();
	const length = trimmed.length;
	const head = `${title ?? ''}\n${trimmed.slice(0, SCAN_HEAD_CHARS)}`;

	const signals: string[] = [];
	/** 命中来自哪一组 —— 决定 `kind`（因而决定给模型的下一步动作）。`unavailable` 覆盖 `interstitial`。 */
	let kind: 'interstitial' | 'unavailable' | undefined;

	for (const p of STRONG_UNAVAILABLE_PATTERNS) {
		if (p.re.test(head)) { signals.push(p.label); kind = 'unavailable'; }
	}
	for (const p of STRONG_BLOCK_PATTERNS) {
		if (p.re.test(head)) { signals.push(p.label); kind ??= 'interstitial'; }
	}
	if (signals.length === 0 && length < SHORT_PAGE_LIMIT) {
		for (const p of WEAK_UNAVAILABLE_PATTERNS) {
			if (p.re.test(head)) { signals.push(p.label); kind = 'unavailable'; }
		}
		for (const p of WEAK_BLOCK_PATTERNS) {
			if (p.re.test(head)) { signals.push(p.label); kind ??= 'interstitial'; }
		}
	}
	if (signals.length > 0) {
		return {
			verdict: 'blocked',
			kind,
			length,
			reason: `${kind === 'unavailable' ? 'page reports itself as unavailable / behind a login wall' : 'looks like an interstitial, not page content'} (${signals.join(', ')})`,
			signals,
		};
	}
	if (length < MIN_USEFUL_CONTENT_LENGTH) {
		return { verdict: 'thin', length, reason: `extracted text is suspiciously short (${length} < ${MIN_USEFUL_CONTENT_LENGTH} chars)`, signals: [] };
	}
	return { verdict: 'ok', length, reason: 'content looks usable', signals: [] };
}

/**
 * 浏览器通道上的「登录墙 / 内容不可用」自诊断 —— 追加在快照或图片清单之后。
 *
 * ## 为什么不沿用 `webExtractBlockedMessage`
 *
 * 那条路是 **HTTP 抓取**：做法是**拒绝返回页面文本**（返回标签化失败）。浏览器这条路不能这么干 ——
 * 快照的语义是"**屏幕上现在是什么**"，用户自己看得见那张占位页；删掉文本会让快照与肉眼所见不一致，
 * 也会让"页面确实换了"这类判断失去依据。所以这里**保留**原文，改用一段显式通知来接管解释权。
 *
 * ## 通知必须回答的三个问题（少一个，模型就会退回"自己编原因"）
 *
 *   ① **这是什么** —— 附上命中的特征标签，排障时能一眼看出判据；
 *   ② **为什么** —— 缺的是**登录态**（不是工具坏了、不是页面没渲染完）。不写这句，
 *      模型会去重试、去换来源，而这两条路在登录墙前都是死的；
 *   ③ **下一步在哪做** —— 两条真出路都点名：用**你自己那个已登录的 Chrome**（勾同意框，
 *      且必须保持配置端口 9222），或在使用专属实例时**在那个窗口里登录一次**。
 *
 * `verdict !== 'blocked'` 时返回空串（调用方直接 `if (notice) push(notice)`）——
 * 正常页面**绝不能**带上这段，否则就是"狼来了"：每次都喊，模型就再也不信它了。
 */
export function browserPageWallNotice(
	url: string,
	quality: IExtractQuality,
	opts?: {
		/**
		 * 是否来自图片清单。为 true 时额外点破那个**最容易骗过模型**的现象：
		 * 登录墙下仍然会渲染出图（头像、站点图标），于是"有图"看起来像"页面正常"。
		 */
		readonly imageList?: boolean;
	},
): string {
	if (quality.verdict !== 'blocked') { return ''; }

	const where = url || 'this page';
	const cause = quality.kind === 'unavailable'
		? 'the site is answering with a "content is gone / sign in first" notice instead of the page'
		: 'the site served an anti-bot / browser-check interstitial instead of the page';

	const lines = [
		'',
		'---',
		'',
		'## ⚠ This is NOT the page content',
		`Everything above was captured from a placeholder: ${cause} (signals: ${quality.signals.join(', ') || quality.reason}).`,
		'Do NOT summarise it, and do NOT guess what the real page says.',
	];
	if (opts?.imageList) {
		lines.push('In particular, do NOT treat the list above as the page\'s images: on a login wall / interstitial the only `<img>` that render are avatars and site icons.');
	}
	lines.push(
		'',
		'Why: the browser this toolset is driving is **not signed in** to this site — nothing is wrong with the tools or with page loading, the identity is missing.',
		'',
		'Next step (pick one, then reload and snapshot again):',
		`  1. Switch to the browser that already holds your logins: open \`${CHROME_REMOTE_DEBUGGING_PAGE}\` in your everyday Chrome and tick "Allow remote debugging for this browser instance". Keep the configured CDP port at 9222 — that toggle has no port option. Our tools prefer that browser over the dedicated instance we launch ourselves.`,
		'  2. Or keep the dedicated instance and **sign in once inside the browser window this toolset drives** — its profile keeps the session for later calls. Never ask the user for credentials or cookies; ask them to sign in themselves.',
		'',
		`Then reload ${where} and take a fresh snapshot. Anything read before that is placeholder-only — say so plainly instead of reusing it.`,
	);
	return lines.join('\n');
}
