/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  VsSaros addition (2026-11-07, P0 · one browser): what the right sidebar browser's CDP relay lets through.
 *
 *  The right sidebar shows a real WebContentsView (`vssaros-rightbar-browser-<view>`, Global storage, shared by every
 *  session — no per-Bot partition, by the user's decision of 2026-11-05). The Host's `browser` tool used to drive a
 *  separate Chrome, so what a person saw and what the model operated were two pages with two logins. The main process
 *  now relays CDP for those views (`electron-main/dshRightbarCdpRelay.ts`, over the platform's `BrowserViewGroup` +
 *  `CDPBrowserProxy`) on a loopback WebSocket with a random token, and the tool attaches to it first.
 *
 *  This file is the relay's policy, kept pure so it is tested without Electron:
 *   - a method allowlist (what `vssaros-browser` sends, plus the AX tree for P1); never `Target.createTarget` (a hidden
 *     page nobody sees), `Target.closeTarget` (would destroy the person's view), `Browser.close`, browser contexts;
 *   - `Page.navigate` only to http(s) / about:blank, never to cloud metadata addresses;
 *   - the discovery file the Host reads (`<dataRoot>/dsh-run/rightbar-cdp.json`).
 */

/** Browser views the relay exposes: the right sidebar's, by the id `dshHarness.contribution.ts` gives them. */
export const RIGHTBAR_VIEW_ID_PREFIX = 'vssaros-rightbar-browser-';
/**
 * 2026-11-07 (combined approach, after DS Bot): the one right sidebar browser view every dsh view and the Host share.
 * The relay creates it, hidden, when the tool needs a page and none exists (`RIGHTBAR_ENSURE_PAGE_METHOD`); the right
 * sidebar tab shows the same view when a person opens it. One view, not one per Bot or session (decided 2026-11-05).
 */
export const RIGHTBAR_SHARED_VIEW_ID = `${RIGHTBAR_VIEW_ID_PREFIX}shared`;
/**
 * A relay-only command (no CDP domain has it): make sure the right sidebar has a page, creating the shared view hidden
 * when it has none. Never opens a second page: with one already there it does nothing. Answers `{ created, targetId }`.
 */
export const RIGHTBAR_ENSURE_PAGE_METHOD = 'VsSaros.ensureRightbarPage';
/** The discovery file in the Host's run dir (`<userData>/dsh-run`, which is `<dataRoot>/dsh-run`). */
export const RIGHTBAR_CDP_FILE = 'rightbar-cdp.json';
/** The WebSocket path's prefix; the token follows. */
export const RIGHTBAR_CDP_PATH = '/devtools/browser/vssaros-rightbar/';

/** What the discovery file holds. */
export interface IRightbarCdpEndpoint {
	readonly version: 1;
	/** `ws://127.0.0.1:<port><RIGHTBAR_CDP_PATH><token>` */
	readonly wsUrl: string;
	/** The main process that serves it (the Host skips a file whose process is gone). */
	readonly pid: number;
	readonly startedAt: string;
}

/** Browser-level methods (no sessionId) the relay serves. */
export const RIGHTBAR_BROWSER_METHODS: ReadonlySet<string> = new Set([
	'Browser.getVersion',
	'Target.getTargets',
	'Target.getTargetInfo',
	'Target.attachToTarget',
	'Target.detachFromTarget',
	'Target.activateTarget',
	// Answered by the relay itself from the views' Electron session (`session.cookies`), see the relay.
	'Storage.getCookies',
	// Answered by the relay itself: the shared view, created hidden only when the right sidebar has no page (2026-11-07).
	RIGHTBAR_ENSURE_PAGE_METHOD,
]);

/** Page-level methods (with the sessionId of an attached view) the relay forwards. */
export const RIGHTBAR_PAGE_METHODS: ReadonlySet<string> = new Set([
	'Runtime.evaluate',
	'Runtime.enable',
	'Page.enable',
	'Page.navigate',
	'Page.reload',
	'Page.getNavigationHistory',
	'Page.navigateToHistoryEntry',
	'Page.captureScreenshot',
	'Page.getLayoutMetrics',
	'Input.dispatchMouseEvent',
	'Input.dispatchKeyEvent',
	'Input.insertText',
	'Network.setCookies',
	'Network.getCookies',
	'Accessibility.enable',
	'Accessibility.getFullAXTree',
	// 2026-11-07: the ARIA snapshot (`vssaros-browser/lib/core/aria.js`) writes its [n] refs back onto the elements so click / type
	// find them; nothing broader of DOM (no removeNode, no setOuterHTML). `Runtime.evaluate` above already reaches further.
	'DOM.getDocument',
	'DOM.pushNodesByBackendIdsToFrontend',
	'DOM.setAttributeValue',
]);

/** Hosts a page must never be sent to: cloud instance metadata (SSRF onto the machine's credentials). */
const METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata', '100.100.100.200', 'fd00:ec2::254', '[fd00:ec2::254]']);

/**
 * Whether the relay lets a CDP request through.
 * @returns undefined when allowed, else why not (the relay answers it as a CDP error, -32601 or -32602).
 */
export function rightbarCdpRefusal(method: unknown, params: unknown, sessionId: unknown): { code: number; message: string } | undefined {
	if (typeof method !== 'string' || !method) {
		return { code: -32600, message: 'Invalid request' };
	}
	const page = typeof sessionId === 'string' && sessionId.length > 0;
	const allowed = page ? RIGHTBAR_PAGE_METHODS.has(method) || RIGHTBAR_BROWSER_METHODS.has(method) : RIGHTBAR_BROWSER_METHODS.has(method);
	if (!allowed) {
		return { code: -32601, message: `${method} is not allowed on the VsSaros right sidebar browser` };
	}
	if (method === 'Page.navigate') {
		const url = (params as { url?: unknown } | undefined)?.url;
		const why = rightbarNavigationRefusal(url);
		if (why) {
			return { code: -32602, message: why };
		}
	}
	return undefined;
}

/** Why a page of the right sidebar may not go to `url`, or undefined. */
export function rightbarNavigationRefusal(url: unknown): string | undefined {
	if (typeof url !== 'string' || !url.trim()) {
		return 'Page.navigate needs a url';
	}
	if (url === 'about:blank') {
		return undefined;
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return `not a URL: ${url}`;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return `only http(s) pages open in the right sidebar browser, not ${parsed.protocol}`;
	}
	if (METADATA_HOSTS.has(parsed.hostname.toLowerCase())) {
		return `${parsed.hostname} is a cloud metadata address`;
	}
	return undefined;
}

/** Whether a message's token path is the relay's (constant-time compare of the token). */
export function rightbarTokenMatches(path: string | undefined, token: string): boolean {
	if (typeof path !== 'string' || !path.startsWith(RIGHTBAR_CDP_PATH) || !token) {
		return false;
	}
	const given = path.slice(RIGHTBAR_CDP_PATH.length).split('?')[0];
	if (given.length !== token.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < token.length; i++) {
		diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
	}
	return diff === 0;
}

/** An Electron cookie (`session.cookies.get`) as CDP's `Network.Cookie`. */
export function cdpCookieOf(cookie: { name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; session?: boolean; expirationDate?: number; sameSite?: string }): Record<string, unknown> {
	const sameSite = cookie.sameSite === 'strict' ? 'Strict' : cookie.sameSite === 'lax' ? 'Lax' : cookie.sameSite === 'no_restriction' ? 'None' : undefined;
	return {
		name: cookie.name,
		value: cookie.value,
		domain: cookie.domain ?? '',
		path: cookie.path ?? '/',
		expires: typeof cookie.expirationDate === 'number' ? cookie.expirationDate : -1,
		size: cookie.name.length + cookie.value.length,
		httpOnly: cookie.httpOnly === true,
		secure: cookie.secure === true,
		session: cookie.session === true,
		...(sameSite ? { sameSite } : {}),
	};
}
