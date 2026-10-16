/**
 * 「登录态判据」的**纯逻辑** + 页面探针脚本（供 `browser` 的 `login` op 用，2026-10-13）。
 *
 * ## 为什么需要"判据"而不是让模型自己宣布成功
 *
 * 登录是**人工步骤**：我们只能请用户在那个窗口里完成，然后**必须有一条可验证的判据** ——
 * 否则模型的典型失败模式是"我请用户登录了，所以现在应该好了"，接着基于登录墙继续作答
 * （本仓已经栽过一次：占位页被当成功喂给模型，`verdict=ok`，见 `common/webPageQuality.ts` 头注释）。
 *
 * ## 两条**独立**证据（缺一条就退到"说不清"，绝不猜）
 *
 *   · **cookie 证据**：该域名下有"疑似登录态"名字的 cookie（启发式，见 `cookies.js`；
 *     名字不能用于授权判定，但足以支撑"这个 profile 在该站点登录过"）；
 *   · **页面证据**：当前打开的页面**不再被判为墙**（复用 `classifyExtractQuality` 的判定真源，
 *     不另搞一套阈值）。⚠ 页面证据只在"打开的就是目标站点"时才算数 —— 否则你看的是别的页。
 *
 * 冲突时（有 cookie 但页面仍是墙）判 `inconclusive` 并**明确标注冲突**：多半是 cookie 不全、
 * 被风控拦下、或页面还没刷新 —— 此时宣布"已登录"是最坏的结果（模型会继续读一张墙）。
 */

import { classifyExtractQuality, manualActionLine } from './snapshot.js';
import { cookieDomainMatches, filterCookiesForSite, parseSiteUrl, summarizeCookies } from './cookies.js';

/** 页面正文采样上限（判据只关心"是不是墙"，不需要整页）。 */
export const PAGE_PROBE_TEXT_LIMIT = 2000;

/**
 * 轻量页面探针。
 *
 * 刻意**不复用** `SNAPSHOT_SCRIPT`：那个会标记几百个 ref、采集图片/标题层级 —— 对"是不是登录墙"
 * 这个问题是纯粹的浪费（而且它的输出会进模型上下文）。这里只要 url/host/title/正文开头。
 * 纪律同 snapshot 脚本：只采集原始事实，判定不写在这里（要能单测）。
 */
export const PAGE_PROBE_SCRIPT = `(() => {
  const clean = function (t) { return String(t == null ? '' : t).replace(/\\s+/g, ' ').trim(); };
  const out = { url: '', host: '', title: '', text: '' };
  try {
    out.url = location.href;
    out.host = location.hostname || '';
    out.title = document.title || '';
    out.text = document.body ? clean(document.body.innerText || document.body.textContent || '').slice(0, ${PAGE_PROBE_TEXT_LIMIT}) : '';
  } catch (e) { }
  return out;
})()`;

/** 把探针返回收窄成类型（页面可能返回意外形状 —— 与 `normalizeRawSnapshot` 同姿势）。 */
export function normalizePageProbe(raw) {
	const r = raw ?? {};
	const url = typeof r.url === 'string' ? r.url : '';
	const host = typeof r.host === 'string' && r.host ? r.host.toLowerCase() : (parseSiteUrl(url)?.host ?? '');
	return {
		url,
		host,
		title: typeof r.title === 'string' ? r.title : '',
		text: typeof r.text === 'string' ? r.text : '',
	};
}

/**
 * 判定登录态（纯函数，可单测）。
 *
 * @param options.cookies `Storage.getCookies` 的原始返回（**未过滤**，全浏览器的 cookie）
 * @param options.probe   页面探针的返回（原始或已归一）
 * @param options.host    目标站点域名（判据的作用域）
 */
export function judgeLoginState(options) {
	const cookies = Array.isArray(options?.cookies) ? options.cookies : [];
	const probe = normalizePageProbe(options?.probe);
	const host = typeof options?.host === 'string' ? options.host.trim().toLowerCase() : '';

	const site = host ? summarizeCookies(filterCookiesForSite(cookies, host), host) : { total: 0, sessionish: [], hasSessionish: false };
	const quality = classifyExtractQuality(probe.text, probe.title);
	const pageLooksLikeWall = quality.verdict === 'blocked';
	/**
	 * 页面被判墙时，附一条**枚举化的下一步**（P1-2）。
	 *
	 * ⚠ 文本**由真源生成**（`webPageQuality.ts` 的 `manualActionLine`，经生成物 `snapshot.js` 转出），
	 * 本文件只存字符串、不自己拼 —— 否则浏览器通道与 HTTP 通道的措辞迟早各写一份（那正是漂移源）。
	 */
	const manualActionText = pageLooksLikeWall ? manualActionLine(quality) : '';
	/** 页面证据只有在"打开的就是目标站点"时才算数（否则你看的是别的页）。 */
	const onSite = host.length > 0 && probe.host.length > 0 && cookieDomainMatches(probe.host, host);

	const evidence = [];
	if (site.hasSessionish) {
		evidence.push(`cookie evidence: ${site.sessionish.length} login-ish cookie(s) for ${host} (${site.sessionish.join(', ')})`);
	} else {
		evidence.push(`cookie evidence: none for ${host} (${site.total} cookie(s) matched the domain, none with a login-ish name)`);
	}
	if (onSite) {
		evidence.push(pageLooksLikeWall
			? `page evidence: the open page still looks like a wall (${quality.kind ?? 'interstitial'}: ${quality.signals.join(', ') || quality.reason})`
			: `page evidence: the open page no longer looks like a wall (${quality.length} chars, verdict=${quality.verdict})`);
	} else {
		evidence.push(probe.url
			? `page evidence: ignored — the open page is ${probe.host || '(unknown host)'}, not ${host || '(unknown site)'}`
			: 'page evidence: ignored — no page is open in the browser this toolset drives');
	}

	/** 三种结论：`signed-in` / `not-signed-in` / `inconclusive`（说不清就不说清，绝不猜）。 */
	let verdict;
	let conflict = false;
	if (onSite && !pageLooksLikeWall) {
		verdict = 'signed-in';
	} else if (site.hasSessionish && onSite && pageLooksLikeWall) {
		// cookie 说登录过、页面说还是墙 ⇒ 冲突，**不许**宣布成功（多半是 cookie 不全 / 被风控 / 页面没刷新）
		verdict = 'inconclusive';
		conflict = true;
	} else if (site.hasSessionish) {
		// 页面证据不可用（没开页 / 不是目标站），但 cookie 是**独立**证据
		verdict = 'signed-in';
	} else {
		verdict = onSite ? 'not-signed-in' : 'inconclusive';
	}

	return {
		host,
		url: probe.url,
		title: probe.title,
		onSite,
		verdict,
		conflict,
		cookies: site,
		page: { verdict: quality.verdict, kind: quality.kind, signals: quality.signals, length: quality.length },
		evidence,
		/** 被判墙时的枚举化下一步（真源措辞；空串 = 页面没被判墙）。 */
		manualActionText,
	};
}

/**
 * 把判定结果渲染成给模型的文本。
 *
 * 三条纪律：① 说清**证据**（模型不该自己编）；② 冲突要显式标注（"有 cookie 但页面还是墙"）；
 * ③ 不宣布成功的分支必须**明确禁止重试**（否则模型会连点这个 op，把"没登录成功"变成一串空转）。
 */
/**
 * 结论末尾追加**枚举化的下一步**（P1-2）—— 措辞真源在 `common/webPageQuality.ts`，
 * 本文件只把它拼上去（**不**自己造句子，否则两条通道各写一份必然漂移）。空串 = 不加。
 */
function manualActionSuffix(state) {
	const text = typeof state?.manualActionText === 'string' ? state.manualActionText : '';
	return text ? `\n\n${text}` : '';
}

export function formatLoginVerdict(state) {
	const host = state?.host || '(unknown site)';
	const evidence = (state?.evidence ?? []).map(line => `  · ${line}`).join('\n');

	if (state?.verdict === 'signed-in') {
		return [
			`## Login check — looks signed in (${host})`,
			'',
			evidence,
			'',
			'You may now read the page: `op: "navigate"` to the target URL (or `op: "snapshot"` if it is already open).',
			'If the page still comes back as a wall, say so — do not treat this check as proof that the content is readable.',
		].join('\n') + manualActionSuffix(state);
	}

	if (state?.verdict === 'not-signed-in') {
		return [
			`## Login check — NOT signed in (${host})`,
			'',
			evidence,
			'',
			'Nothing is wrong with the tools: this browser profile has no login for this site yet.',
			'Ask the user to sign in once in the browser window this toolset drives, then call this op again with `done: true`.',
			'Do NOT call this op repeatedly — it cannot sign anyone in, and page evidence will keep saying the same thing.',
		].join('\n') + manualActionSuffix(state);
	}

	if (state?.conflict) {
		return [
			`## Login check — conflicting evidence (${host})`,
			'',
			evidence,
			'',
			'A login-ish cookie exists, but the open page still looks like a wall. Treat this as **not yet usable**:',
			'  1. Ask the user to reload that page in the browser window this toolset drives (a stale page is the usual cause).',
			'  2. If it still looks like a wall, the cookie is probably not the whole session (some sites bind it to more state), or the site is blocking this session.',
			'  3. Say plainly what you see. Do NOT summarise the placeholder, and do NOT retry this op in a loop.',
		].join('\n') + manualActionSuffix(state);
	}

	return [
		`## Login check — inconclusive (${host})`,
		'',
		evidence,
		'',
		'There is no evidence either way, so do not claim the user is signed in and do not claim they are not.',
		'Open the target page first (`op: "navigate"`), ask the user to sign in if needed, then call this op again with `done: true`.',
	].join('\n') + manualActionSuffix(state);
}

/**
 * 登录引导文本（`login` op 不带 `done` 时返回）。
 *
 * 要点：① 说清**去哪个窗口**（当前驱动的是哪一个浏览器）；② 凭据纪律写死在文案里
 * （模型不得索要账号密码/cookie）；③ 给出**可验证**的下一步（`done: true`）。
 */
export function loginGuidanceText(options) {
	const url = typeof options?.url === 'string' && options.url ? options.url : '';
	const endpoint = typeof options?.endpoint === 'string' && options.endpoint ? options.endpoint : '(unknown)';
	const selfLaunched = options?.selfLaunched === true;

	const lines = [
		'## Sign-in needed — this is a manual step',
		'',
		url ? `Opened (or reused) this page in the browser this toolset drives: ${url}` : 'No URL was given, so nothing was opened.',
		`That browser is: ${endpoint}${selfLaunched
			? ' — the **dedicated instance** VsSaros launched (its profile keeps whatever you sign in with, for later calls)'
			: ' — **your own Chrome** (already holds your logins)'}.`,
		'',
		'Ask the user to complete the sign-in **in that window, themselves** — scanning a QR code with their phone is fine.',
		'Never ask for, or type, credentials or cookies. Never try to bypass a login wall.',
		'',
		'When they say they are done, call this op again with `done: true` — that checks the login state and tells you plainly whether it took.',
		'Do not assume it worked, and do not read the page before the check passes.',
	];
	if (!selfLaunched) {
		lines.push(
			'',
			'If the wall persists even after signing in, the session may be bound to a different browser: ask them to keep using this one, or switch with the "use my own Chrome" flow.',
		);
	}
	return lines.join('\n');
}
