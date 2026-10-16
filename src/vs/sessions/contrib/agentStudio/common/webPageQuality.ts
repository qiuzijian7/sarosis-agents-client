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
 * **登录墙 / 客户端墙**的**弱**形态：只在整页很短时才判定（2026-10-13 从 `unavailable` 里单列）。
 *
 * 为什么不敢收成强特征：这些是**通用句式**（教程里引用一句"请先登录后查看"完全可能），强匹配会
 * 把好文章拒掉 —— 按本模块的收录纪律，误判的代价远大于漏判。而"整页 < 600 字符"本身就是
 * "这里几乎没有内容"的独立证据，两者叠加才判。
 *
 * 为什么必须与 `unavailable`（内容已删 / 受限）**分开**：两者的下一步动作不同 ——
 *   · 登录墙 ⇒ **请人在真实浏览器里登录一次**就是解药（且是唯一解药）；
 *   · 内容已删 / 受限 ⇒ 登录也没用，只能换来源或承认读不到。
 * 混在同一句里，模型必然在其中一条死路上重试（实测：小红书登录墙下 `web_extract` 重试多少次
 * 都是同一张占位页）。这三种句式在"PC 浏览器里看到登录墙 / 客户端墙"这个语境下是同一件事
 * —— 都要用户在那个窗口里完成身份，所以归为同一个 kind。
 */
const LOGIN_WALL_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
	{ re: /请先登录后(查看|继续|访问)/, label: 'zh-login-required' },
	{ re: /登录后(可)?查看/, label: 'zh-login-to-view' },
	{ re: /请(在|用)(手机|App|客户端)(内|中)?(打开|查看)/i, label: 'zh-app-only' },
];

export interface IExtractQuality {
	readonly verdict: 'ok' | 'thin' | 'blocked';
	/**
	 * `blocked` 时区分**三类成因** —— 它决定给模型的下一步动作（见 `webExtractBlockedMessage` /
	 * `browserPageWallNotice`）：
	 *   · `interstitial`   —— 反爬 / 人机校验页：换来源、换通道都可能有效；
	 *   · `login-required` —— 登录墙 / 客户端墙：**唯一**解药是请用户在真实浏览器窗口里完成登录，
	 *                         重试本通道与换来源都无效（2026-10-13 单列）；
	 *   · `unavailable`    —— 内容已删除 / 区域或账号受限：登录也无效，只能换来源或承认读不到。
	 * `ok` / `thin` 时**不设**（不要用它表达"内容好不好"）。
	 */
	readonly kind?: 'interstitial' | 'unavailable' | 'login-required';
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
	/**
	 * 命中来自哪一组 —— 决定 `kind`（因而决定给模型的下一步动作）。
	 * 优先级（靠前的更强、且**不被靠后的覆盖**）：具体 → 泛化
	 *   `login-required` ＞ `unavailable` ＞ `interstitial`
	 * 即：强不可用覆盖强拦截（既有约定），弱登录墙覆盖弱不可用/弱拦截。
	 */
	let kind: 'interstitial' | 'unavailable' | 'login-required' | undefined;

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
		return {
			verdict: 'blocked',
			kind,
			length,
			reason: `${kindReason(kind)} (${signals.join(', ')})`,
			signals,
		};
	}
	if (length < MIN_USEFUL_CONTENT_LENGTH) {
		return { verdict: 'thin', length, reason: `extracted text is suspiciously short (${length} < ${MIN_USEFUL_CONTENT_LENGTH} chars)`, signals: [] };
	}
	return { verdict: 'ok', length, reason: 'content looks usable', signals: [] };
}

/**
 * `kind` 的**人读原因**（日志与文案共用）。
 *
 * 为什么必须三分：三种成因给模型的下一步动作互不相同（见 `browserPageWallNotice`）——
 * 共用一句话就等于把"该请人登录"和"该承认读不到"混为一谈。
 */
export function kindReason(kind: IExtractQuality['kind']): string {
	switch (kind) {
		case 'login-required': return 'page is behind a login / client-only wall';
		case 'unavailable': return 'page reports itself as gone or restricted';
		default: return 'looks like an interstitial, not page content';
	}
}

/**
 * 四张特征表的全部 label —— 供守卫断言"**每个已登记的拦截特征都被归入某个 manualAction**"
 * （新增特征却忘了登记动作 ⇒ 红；这比"记得改两处"可靠）。
 */
export const WEB_PAGE_QUALITY_SIGNAL_LABELS: readonly string[] = [
	...STRONG_UNAVAILABLE_PATTERNS, ...STRONG_BLOCK_PATTERNS, ...LOGIN_WALL_PATTERNS, ...WEAK_BLOCK_PATTERNS,
].map(p => p.label);

/**
 * 「这一步必须由人来做」的**动作枚举**（2026-10-13，P1-2）。
 *
 * ## 为什么需要它（`kind` 不够用）
 *
 * `kind` 回答的是"这是哪一类墙"，而**下一步该谁做**是另一个问题：
 *   · 有些墙**只有人能解**（登录 / 扫码 / 过验证码 / 在 App 里打开）⇒ 让模型自己重试是永远无解的；
 *   · 有些墙**重试就好**（反爬拦截常能自己过 / 频率限制）⇒ 反过来把用户叫来是白折腾他一次。
 * 不给这个区分，模型两头都会做错：实测在小红书登录墙上反复重试，或在 Cloudflare 拦截页上直接把用户叫来。
 *
 * 口径照 openclaw 的 `MeetingManualActionCategory`（`src/meeting-bot/platform-adapter-contract.ts:6-20`）：
 * **枚举化 + 明确"要不要人"**，而不是一句含糊的"出错了"。
 */
export type ManualAction =
	| 'login-required'       // 需要人在真实浏览器里登录一次（扫码也算）
	| 'app-only'             // 内容只在 App / 客户端里（PC 浏览器读不到）
	| 'captcha-required'     // 人机校验（reCAPTCHA / Turnstile / 中文"安全验证"）—— **只有人**能过
	| 'browser-check'        // 反爬拦截（Cloudflare / DDoS-Guard 那类）—— 常能自己过，重试一次往往就好
	| 'rate-limited'         // 频率限制 —— 等一会儿或换来源
	| 'permission-required'  // 403 / 权限不足 —— 换来源或让用户提供（**不是**登录问题）
	| 'content-gone'         // 内容已删 / 区域或账号受限 —— 登录也救不回来
	| 'unknown';             // 拦住了但认不出是哪一种（如实说，别猜）

/** 这一步**只有人**能解吗（true ⇒ 文案必须禁止模型反复重试）。 */
export const MANUAL_ACTION_NEEDS_HUMAN: Readonly<Record<ManualAction, boolean>> = {
	'login-required': true,
	'app-only': true,
	'captcha-required': true,
	'browser-check': false,
	'rate-limited': false,
	'permission-required': false,
	'content-gone': false,
	unknown: false,
};

/**
 * signal 标签 → manualAction。
 *
 * ⚠ **按具体标签判，不是只按 kind**：同一个 `kind` 里的下一步可以不同 ——
 * `interstitial` 既可能是"只有人能过"的验证码，也可能是"重试就好"的反爬拦截；
 * `login-required` 与 `app-only` 都要人，但要做的事完全不一样。
 */
const MANUAL_ACTION_BY_SIGNAL: Readonly<Record<string, ManualAction>> = {
	'zh-login-required': 'login-required',
	'zh-login-to-view': 'login-required',
	'zh-app-only': 'app-only',
	'captcha': 'captcha-required',
	'human-verification': 'captcha-required',
	'robot-check': 'captcha-required',
	'zh-verification': 'captcha-required',
	'cloudflare-browser-check': 'browser-check',
	'cloudflare-block-page': 'browser-check',
	'cloudflare-interstitial': 'browser-check',
	'cloudflare-chl': 'browser-check',
	'ddos-guard': 'browser-check',
	'js-cookies-required': 'browser-check',
	'zh-js-required': 'browser-check',
	'rate-limited': 'rate-limited',
	'access-denied': 'permission-required',
	'zh-page-gone': 'content-gone',
	'zh-note-unavailable': 'content-gone',
	'zh-page-removed': 'content-gone',
};

/** 人读的下一步。每句都必须**说到点子上** —— 含糊的下一步等于没有下一步。 */
const MANUAL_ACTION_HINT: Readonly<Record<ManualAction, string>> = {
	'login-required': 'ask the user to sign in once in the browser window this toolset drives (a QR code scan is fine)',
	'app-only': 'client/App-only content: ask the user to open it on their phone and paste it, or say so honestly',
	'captcha-required': 'only a human can clear this check — do NOT retry in a loop',
	'browser-check': 'anti-bot check: one retry often passes; if not, use the real browser or find another source',
	'rate-limited': 'back off and retry later, or take the information from another source',
	'permission-required': 'this is not a login problem — it is unavailable to this account/region; find another source',
	'content-gone': 'the content is gone — signing in will not bring it back; find another source',
	unknown: 'unclear which wall this is — say what you actually saw instead of guessing',
};

export interface IManualActionAssessment {
	readonly action: ManualAction;
	/** 这一步**只有人**能解吗（true ⇒ 别让模型反复重试）。 */
	readonly needsHuman: boolean;
	readonly hint: string;
	/** 命中的信号标签（归因用；`unknown` 时缺省）。 */
	readonly signal?: string;
}

/**
 * 把一次提取判定翻成"谁该做下一步"。
 *
 * `verdict !== 'blocked'` ⇒ `undefined`：**没被拦住就不产出人工动作** ——
 * 否则每个正常页面都会带一行"需要人工"，那就成了噪声（"狼来了"的同一教训）。
 */
export function assessManualAction(quality: IExtractQuality): IManualActionAssessment | undefined {
	if (quality.verdict !== 'blocked') { return undefined; }
	for (const signal of quality.signals) {
		const action = MANUAL_ACTION_BY_SIGNAL[signal];
		if (action) {
			return { action, needsHuman: MANUAL_ACTION_NEEDS_HUMAN[action], hint: MANUAL_ACTION_HINT[action], signal };
		}
	}
	return { action: 'unknown', needsHuman: false, hint: MANUAL_ACTION_HINT.unknown };
}

/**
 * 给模型看的**机器可读一行**（守卫按固定前缀 `manualAction:` 断言；三条通道共用同一份措辞）。
 * 正常页面返回空串（调用方直接 `if (line) push(line)`）。
 */
export function manualActionLine(quality: IExtractQuality): string {
	const assessed = assessManualAction(quality);
	if (!assessed) { return ''; }
	return `manualAction: ${assessed.action} (needsHuman=${assessed.needsHuman ? 'yes' : 'no'}) — ${assessed.hint}`;
}

/**
 * 通知的统一收尾：把 `manualAction` 一行追加在**最后**。
 *
 * 位置不是随意的：末尾才是模型开口前的**最后一句** —— 放在前面会被中间那几段"怎么用这些图/下一步"盖过去
 * （与快照追加通知同一理由，见 `browserPageWallNotice` 的说明）。
 */
function finishWallNotice(lines: string[], quality: IExtractQuality): string {
	const actionLine = manualActionLine(quality);
	if (actionLine) { lines.push('', actionLine); }
	return lines.join('\n');
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
	const cause = quality.kind === 'login-required'
		? 'the site is answering with a **login wall / "open in the app" notice** instead of the page'
		: quality.kind === 'unavailable'
			? 'the site is answering with a "content is gone / restricted" notice instead of the page'
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

	// ① 登录墙：唯一解药是"有人在这个浏览器里登录一次"。这一支必须明说"重试无用"。
	if (quality.kind === 'login-required') {
		lines.push(
			'',
			'Why: the browser this toolset is driving is **not signed in** to this site — nothing is wrong with the tools or with page loading, the identity is missing.',
			'',
			'This is the one case where **retrying changes nothing**: the wall comes back every single time until someone signs in. Do not retry, do not fall back to a plain text fetch, and do not reconstruct the content from the title.',
			'',
			'Next step (ask the user for this — never ask for credentials, and never type them yourself):',
			'  1. Get the page open in a real, visible browser window and ask the user to sign in there once (scanning a QR code with their phone is fine). If the window this toolset drives is the dedicated instance, that session stays in its profile and later calls reuse it.',
			`  2. Or switch to the browser that already holds their logins: ask them to open \`${CHROME_REMOTE_DEBUGGING_PAGE}\` in their everyday Chrome and tick "Allow remote debugging for this browser instance". Keep the configured CDP port at 9222 — that toggle has no port option. Our tools prefer that browser over the dedicated instance we launch ourselves.`,
			'  3. Then call `browser` with `op: "login"` together with `done: true` — it inspects the login state and tells you plainly whether it took. Only after that is a fresh snapshot worth taking.',
			'',
			`Then reload ${where} and take a fresh snapshot. Anything read before that is placeholder-only — say so plainly instead of reusing it.`,
		);
		return finishWallNotice(lines, quality);
	}

	// ② 内容已删 / 受限：与身份无关 ⇒ 明确否掉"去登录"这条死路（原先与登录墙共用一句，模型会走错）。
	if (quality.kind === 'unavailable') {
		lines.push(
			'',
			'Why: this is **not** about credentials — the resource itself is gone, or is restricted to certain accounts/regions. Signing in will not bring it back.',
			'',
			'Next step (pick whichever fits):',
			'  1. Say plainly that the item is unavailable / restricted, and stop: do not retry this URL and do not reconstruct it from its title or snippet.',
			'  2. Get the same information elsewhere (search, mirror, the site\'s official API), or ask the user to paste the content.',
			'',
			`A fresh snapshot of ${where} will show the same notice — take one only to confirm the situation changed.`,
		);
		return finishWallNotice(lines, quality);
	}

	// ③ 反爬 / 人机校验：缺的不是身份而是"看起来像不像人"。换真实浏览器或稍后重试都可能有效。
	lines.push(
		'',
		'Why: the site classified this session as automated **before** it served the page. The identity is not the issue here — the "how" is.',
		'',
		'Next step (pick whichever fits, then reload and snapshot again):',
		`  1. Prefer the browser that already holds the user\'s logins and a normal browsing history: ask them to open \`${CHROME_REMOTE_DEBUGGING_PAGE}\` in their everyday Chrome and tick "Allow remote debugging for this browser instance" (keep the configured CDP port at 9222 — that toggle has no port option).`,
		'  2. Retry later — rate limits and challenges are often momentary — or take the information from another source.',
		'',
		`Then reload ${where} and take a fresh snapshot. Anything read before that is placeholder-only — say so plainly instead of reusing it.`,
	);
	return finishWallNotice(lines, quality);
}
