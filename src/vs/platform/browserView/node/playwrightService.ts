/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, IDisposable } from '../../../base/common/lifecycle.js';
import { DeferredPromise, disposableTimeout, raceTimeout } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentNetworkFilterService } from '../../networkFilter/common/networkFilterService.js';
import { IInvokeFunctionResult, IPlaywrightDownloadResult, IPlaywrightService } from '../common/playwrightService.js';
import { IBrowserViewGroupRemoteService } from '../node/browserViewGroupRemoteService.js';
import { IBrowserViewGroup } from '../common/browserViewGroup.js';
import { PlaywrightTab, DialogInterruptedError } from './playwrightTab.js';
import { CDPEvent, CDPRequest, CDPResponse } from '../common/cdp/types.js';
import { generateUuid } from '../../../base/common/uuid.js';

// eslint-disable-next-line local/code-import-patterns
import type { Browser, BrowserContext, Page } from 'playwright-core';

interface PlaywrightTransport {
	send(s: CDPRequest): void;
	close(): void;  // Note: calling close is expected to issue onclose at some point.
	onmessage?: (message: CDPResponse | CDPEvent) => void;
	onclose?: (reason?: string) => void;
}

declare module 'playwright-core' {
	interface BrowserType {
		_connectOverCDPTransport(transport: PlaywrightTransport): Promise<Browser>;
	}
}

const DEFERRED_RESULT_CLEANUP_MS = 5 * 60_000; // 5 minutes
const SESSION_INACTIVITY_MS = 30 * 60_000; // 30 minutes

/** Raw cookie shape returned by the CDP `Network.getCookies` command. */
interface RawCDPCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: string;
}

/** Cookie shape accepted by Playwright's APIRequestContext storageState. */
interface PlaywrightDownloadCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	sameSite: 'Strict' | 'Lax' | 'None';
}

function toPlaywrightCookie(c: RawCDPCookie): PlaywrightDownloadCookie {
	const sameSite: 'Strict' | 'Lax' | 'None' =
		c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None' ? c.sameSite : 'Lax';
	return {
		name: c.name,
		value: c.value,
		domain: c.domain,
		path: c.path || '/',
		expires: typeof c.expires === 'number' ? c.expires : -1,
		httpOnly: !!c.httpOnly,
		secure: !!c.secure,
		sameSite,
	};
}


/**
 * Shared-process implementation of {@link IPlaywrightService}.
 *
 * Manages {@link PlaywrightSession} instances keyed by session ID.
 * Each session has its own Playwright browser connection and browser view
 * group, created eagerly by the service when the session is first requested.
 *
 * Page tracking is currently global: tracked pages are shared across all
 * sessions so every session can interact with every tracked page.
 */
export class PlaywrightService extends Disposable implements IPlaywrightService {
	declare readonly _serviceBrand: undefined;

	private readonly _sessions = this._register(new DisposableMap<string, PlaywrightSession>());

	/** In-flight session initializations keyed by session ID. */
	private readonly _pendingInits = new Map<string, Promise<PlaywrightSession>>();

	/** Inactivity timers keyed by session ID. */
	private readonly _inactivityTimers = this._register(new DisposableMap<string, IDisposable>());

	/** Global set of tracked page IDs (shared across all sessions). */
	private readonly _trackedPages = new Set<string>();

	private readonly _onDidChangeTrackedPages = this._register(new Emitter<readonly string[]>());
	readonly onDidChangeTrackedPages: Event<readonly string[]> = this._onDidChangeTrackedPages.event;

	constructor(
		private readonly windowId: number,
		private readonly browserViewGroupRemoteService: IBrowserViewGroupRemoteService,
		private readonly logService: ILogService,
		private readonly agentNetworkFilterService: IAgentNetworkFilterService,
	) {
		super();
	}

	/**
	 * Get or create a fully-initialized {@link PlaywrightSession} for the
	 * given session ID. Creates the CDP group and Playwright browser
	 * connection if the session does not already exist.
	 */
	private async _getOrCreateSession(sessionId: string): Promise<PlaywrightSession> {
		const existing = this._sessions.get(sessionId);
		if (existing) {
			this._touchSession(sessionId);
			return existing;
		}

		// De-duplicate concurrent initialization for the same session.
		const pending = this._pendingInits.get(sessionId);
		if (pending) {
			return pending;
		}

		const initPromise = this._initSession(sessionId);
		this._pendingInits.set(sessionId, initPromise);
		try {
			return await initPromise;
		} finally {
			this._pendingInits.delete(sessionId);
		}
	}

	/**
	 * Create and fully initialize a new session: browser view group,
	 * Playwright CDP connection, and page replay.
	 */
	private async _initSession(sessionId: string): Promise<PlaywrightSession> {
		this.logService.debug(`[PlaywrightService] Initializing session ${sessionId}`);

		const group = await this.browserViewGroupRemoteService.createGroup({ mainWindowId: this.windowId, sessionId });

		let browser: Browser;
		try {
			const playwright = await import('playwright-core');
			const sub = group.onCDPMessage(msg => transport.onmessage?.(msg));
			const transport: PlaywrightTransport = {
				close() {
					sub.dispose();
					this.onclose?.();
				},
				send(message) {
					void group.sendCDPMessage(message);
				}
			};
			browser = await playwright.chromium._connectOverCDPTransport(transport);
		} catch (e) {
			group.dispose();
			throw e;
		}

		this.logService.debug(`[PlaywrightService] Connected to browser for session ${sessionId}`);

		// If the service was disposed while we were connecting, clean up.
		if (this._store.isDisposed) {
			browser.close().catch(() => { /* ignore */ });
			group.dispose();
			throw new Error('PlaywrightService was disposed during initialization');
		}

		const session = new PlaywrightSession(
			sessionId,
			browser,
			group,
			this.logService,
			this.agentNetworkFilterService,
		);

		// Keep the global tracked set in sync with group events. When a
		// view is added via external means (e.g. CDP createTarget), the
		// group fires onDidAddView — update _trackedPages accordingly.
		// The Set makes double-adds (from startTrackingPage) harmless.
		// Also replicate the view into other sessions so that CDP-created
		// targets become accessible everywhere, not just the originating session.
		session.registerDisposable(group.onDidAddView(e => {
			if (!this._trackedPages.has(e.viewId)) {
				this._trackedPages.add(e.viewId);
				this._fireTrackedPages();
			}
			for (const [id, other] of this._sessions) {
				if (id !== sessionId) {
					void other.group.addView(e.viewId).catch(() => { });
				}
			}
		}));
		session.registerDisposable(group.onDidRemoveView(e => {
			if (this._trackedPages.delete(e.viewId)) {
				this._fireTrackedPages();
			}
		}));

		// On browser disconnect, dispose the session so it will be
		// recreated fresh on the next tool call.
		browser.on('disconnected', () => {
			this.logService.debug(`[PlaywrightService] Browser disconnected for session ${sessionId}`);
			this._sessions.deleteAndDispose(sessionId);
			this._inactivityTimers.deleteAndDispose(sessionId);
		});

		this._sessions.set(sessionId, session);

		// Replay globally tracked pages into the new session's group.
		// Pages may have been removed since they were tracked — catch and
		// evict stale entries so they don't accumulate.
		for (const viewId of [...this._trackedPages]) {
			try {
				await session.group.addView(viewId);
			} catch {
				this.logService.debug(`[PlaywrightService] Stale tracked page ${viewId} removed during replay`);
				this._trackedPages.delete(viewId);
				this._fireTrackedPages();
			}
		}

		this._touchSession(sessionId);
		return session;
	}

	// --- Page tracking (global) ---

	async startTrackingPage(viewId: string): Promise<void> {
		// Update the canonical set directly so tracking works even when
		// no sessions exist yet. The Set makes the double-add from
		// the group's onDidAddView listener harmless.
		if (!this._trackedPages.has(viewId)) {
			this._trackedPages.add(viewId);
			this._fireTrackedPages();
		}
		for (const session of this._sessions.values()) {
			session.group.addView(viewId);
		}
	}

	async stopTrackingPage(viewId: string): Promise<void> {
		if (this._trackedPages.delete(viewId)) {
			this._fireTrackedPages();
		}
		for (const session of this._sessions.values()) {
			session.group.removeView(viewId);
		}
	}

	async isPageTracked(viewId: string): Promise<boolean> {
		return this._trackedPages.has(viewId);
	}

	async getTrackedPages(): Promise<readonly string[]> {
		return [...this._trackedPages];
	}

	// --- Playwright operations (delegated to per-session instances) ---

	async openPage(sessionId: string, url: string): Promise<{ pageId: string; summary: string }> {
		const session = await this._getOrCreateSession(sessionId);
		const result = await session.openPage(url);
		// The creating session's group already has the view. Use
		// startTrackingPage to add it to the canonical set and
		// replicate into other sessions.
		await this.startTrackingPage(result.pageId);
		return result;
	}

	async getSummary(sessionId: string, pageId: string): Promise<string> {
		const session = await this._getOrCreateSession(sessionId);
		return session.getSummary(pageId);
	}

	async invokeFunctionRaw<T>(sessionId: string, pageId: string, fnDef: string, ...args: unknown[]): Promise<T> {
		const session = await this._getOrCreateSession(sessionId);
		return session.invokeFunctionRaw(pageId, fnDef, ...args);
	}

	async downloadBinary(sessionId: string, pageId: string, url: string): Promise<IPlaywrightDownloadResult> {
		const session = await this._getOrCreateSession(sessionId);
		return session.downloadBinary(pageId, url);
	}

	async invokeFunction(sessionId: string, pageId: string, fnDef: string, args: unknown[] = [], timeoutMs?: number): Promise<IInvokeFunctionResult> {
		const session = await this._getOrCreateSession(sessionId);
		return session.invokeFunction(pageId, fnDef, args, timeoutMs);
	}

	async waitForDeferredResult(sessionId: string, deferredResultId: string, timeoutMs: number): Promise<IInvokeFunctionResult> {
		const session = await this._getOrCreateSession(sessionId);
		return session.waitForDeferredResult(deferredResultId, timeoutMs);
	}

	async replyToFileChooser(sessionId: string, pageId: string, files: string[]): Promise<{ summary: string }> {
		const session = await this._getOrCreateSession(sessionId);
		return session.replyToFileChooser(pageId, files);
	}

	async replyToDialog(sessionId: string, pageId: string, accept: boolean, promptText?: string): Promise<{ summary: string }> {
		const session = await this._getOrCreateSession(sessionId);
		return session.replyToDialog(pageId, accept, promptText);
	}

	// --- Session lifecycle ---

	async disposeSession(sessionId: string): Promise<void> {
		if (this._sessions.has(sessionId)) {
			this.logService.debug(`[PlaywrightService] Disposing session ${sessionId}`);
			this._sessions.deleteAndDispose(sessionId);
			this._inactivityTimers.deleteAndDispose(sessionId);
		}
	}

	// --- Private helpers ---

	private _fireTrackedPages(): void {
		this._onDidChangeTrackedPages.fire([...this._trackedPages]);
	}

	/**
	 * Reset the inactivity timer for a session. After
	 * {@link SESSION_INACTIVITY_MS} of no activity the session is
	 * automatically disposed.
	 */
	private _touchSession(sessionId: string): void {
		this._inactivityTimers.deleteAndDispose(sessionId);
		const timer = disposableTimeout(
			() => {
				this.logService.debug(`[PlaywrightService] Session ${sessionId} inactive for ${SESSION_INACTIVITY_MS / 60_000}m, disposing`);
				this._sessions.deleteAndDispose(sessionId);
				this._inactivityTimers.deleteAndDispose(sessionId);
			},
			SESSION_INACTIVITY_MS,
		);
		this._inactivityTimers.set(sessionId, timer);
	}
}

/**
 * A single session's Playwright browser connection, page tracking, and
 * page-matching logic.
 *
 * Receives an already-connected {@link Browser} and {@link IBrowserViewGroup}
 * from the parent {@link PlaywrightService}. Correlates browser view IDs with
 * Playwright {@link Page} instances via FIFO matching of group IPC events and
 * Playwright CDP events.
 */
class PlaywrightSession extends Disposable {

	// --- Page matching ---

	private readonly _viewIdToPage = new Map<string, Page>();
	private readonly _pageToViewId = new WeakMap<Page, string>();
	private readonly _tabs = new WeakMap<Page, PlaywrightTab>();

	/** View IDs received from the group but not yet matched with a page. */
	private _viewIdQueue: Array<{ viewId: string; page: DeferredPromise<Page> }> = [];

	/** Pages received from Playwright but not yet matched with a view ID. */
	private _pageQueue: Array<{ page: Page; viewId: DeferredPromise<string> }> = [];

	private readonly _watchedContexts = new WeakSet<BrowserContext>();
	private _scanTimer: ReturnType<typeof setInterval> | undefined;
	private _openContext: BrowserContext | undefined = undefined;

	/** In-flight deferred results keyed by their generated ID. */
	private readonly _deferredResults = this._register(new DisposableMap<string, {
		pageId: string;
		promise: Promise<unknown>;
	} & IDisposable>());

	/** CDP request/response correlation for raw commands we send via the group. */
	private _cdpRequestId = 1_000_000;
	private readonly _cdpPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

	/**
	 * Cookies captured for a page view, keyed by view id. The TAPD browser
	 * view can be closed/recreated between sequential attachment downloads
	 * (our CDP Target attach/detach, or the host UI destroying the view),
	 * after which `_getPage` can no longer resolve it. Cookies captured while
	 * the page was alive stay valid for the duration of a single import, so we
	 * reuse them for subsequent downloads of the same view instead of
	 * requiring the page to remain matched in `_viewIdToPage`.
	 */
	private readonly _cookieCache = new Map<string, PlaywrightDownloadCookie[]>();

	/**
	 * Session-level fallback cookies. When any TAPD view captures cookies, they are
	 * also stored here so that downloads can proceed even after the original browser
	 * view has been closed (e.g. when the user opens a task detail modal later).
	 */
	private _tapdCookies: PlaywrightDownloadCookie[] | undefined;

	constructor(
		readonly sessionId: string,
		private _browser: Browser,
		readonly group: IBrowserViewGroup,
		private readonly logService: ILogService,
		private readonly agentNetworkFilterService: IAgentNetworkFilterService,
	) {
		super();

		this._register(this.group);
		this._register(this.group.onDidAddView(e => this._onViewAdded(e.viewId)));
		this._register(this.group.onDidRemoveView(e => this._onViewRemoved(e.viewId)));
		// Correlate responses to our own raw CDP commands (Playwright's own
		// traffic shares the same transport but uses different IDs).
		this._register(this.group.onCDPMessage(msg => this._onCDPMessage(msg)));

		this._scanForNewContexts();
	}

	// --- Raw CDP command plumbing (for cookie retrieval) ---

	private _onCDPMessage(msg: CDPResponse | CDPEvent): void {
		if (typeof (msg as CDPResponse).id !== 'number') {
			return; // events have no id
		}
		const id = (msg as CDPResponse).id!;
		const pending = this._cdpPending.get(id);
		if (!pending) {
			return; // not ours
		}
		clearTimeout(pending.timer);
		this._cdpPending.delete(id);
		const response = msg as CDPResponse;
		if (response.error) {
			pending.reject(new Error(`CDP command failed: ${response.error.message}`));
		} else {
			pending.resolve(response.result);
		}
	}

	private _sendCDP<T = unknown>(method: string, params?: unknown, sessionId?: string): Promise<T> {
		const id = this._cdpRequestId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._cdpPending.delete(id);
				reject(new Error(`CDP command "${method}" timed out`));
			}, 15000);
			this._cdpPending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			void this.group.sendCDPMessage({ id, method, params, sessionId });
		});
	}

	/** Register a disposable to be cleaned up when this session is disposed. */
	registerDisposable(d: IDisposable): void {
		this._register(d);
	}

	// --- Page operations ---

	async openPage(url: string): Promise<{ pageId: string; summary: string }> {
		if (!this._openContext) {
			this._openContext = await this._browser.newContext();
			this._onContextAdded(this._openContext);
		}

		const page = await this._openContext.newPage();
		const viewId = await this._onPageAdded(page);

		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

		const summary = await this._getSummary(viewId);
		return { pageId: viewId, summary };
	}

	async getSummary(pageId: string): Promise<string> {
		return this._getSummary(pageId, true);
	}

	async invokeFunctionRaw<T>(pageId: string, fnDef: string, ...args: unknown[]): Promise<T> {
		const fn = await this._compileFunction(fnDef);
		return this._runAgainstPage(pageId, (page) => fn(page, args) as T);
	}

	async downloadBinary(pageId: string, url: string): Promise<IPlaywrightDownloadResult> {
		// Resolve auth cookies in priority order:
		// 1. per-view cache (fast path for repeated downloads of the same view)
		// 2. session-level fallback (survives view close, used by task detail modal)
		// 3. fresh CDP capture (only works while the view is still alive)
		let cookies = this._cookieCache.get(pageId) ?? this._tapdCookies;
		if (!cookies) {
			const page = await this._getPage(pageId).catch(() => undefined);
			const pageUrl = page?.url();
			cookies = await this._getCookiesViaCDP(pageUrl);
			this._cookieCache.set(pageId, cookies);
			this._tapdCookies = cookies;
		}

		// The Electron/Chromium build here does NOT implement the CDP
		// `Storage.getCookies` method, so Playwright's cookie-aware
		// `page.request.fetch` fails. Instead we read the page's cookies via
		// the supported `Network.getCookies` CDP command, then perform the
		// download with a standalone, browser-less APIRequestContext that keeps
		// cookies in pure JS memory — no CDP Storage domain involved, no CORS.
		const { request } = await import('playwright-core');
		const ctx = await request.newContext({
			storageState: { cookies, origins: [] },
			timeout: 30000,
			ignoreHTTPSErrors: true,
		});
		try {
			const resp = await ctx.fetch(url, { method: 'GET', timeout: 30000 });
			const buf = await resp.body();
			const contentType = (resp.headers()['content-type'] || '').toLowerCase();
			const contentDisposition = (resp.headers()['content-disposition'] || '');
			this.logService.info(`[PlaywrightSession] downloadBinary ${url} → status=${resp.status()} contentType="${contentType}" contentDisp="${contentDisposition}" bytes=${buf.length}`);
			return {
				ok: resp.ok(),
				status: resp.status(),
				contentType,
				contentDisposition,
				base64: buf.toString('base64'),
			};
		} finally {
			await ctx.dispose();
		}
	}

	/**
	 * Fetch the TAPD page's cookies via the supported `Network.getCookies`
	 * CDP command. We attach a dedicated, temporary CDP session to the page
	 * target so we never disturb Playwright's own session.
	 */
	private async _getCookiesViaCDP(pageUrl: string | undefined): Promise<PlaywrightDownloadCookie[]> {
		const targets = (await this._sendCDP<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets')).targetInfos ?? [];
		let targetInfo = targets.find(t => t.type === 'page' && t.url === pageUrl);
		if (!targetInfo) {
			targetInfo = targets.find(t => t.type === 'page' && t.url.includes('tapd.cn'));
		}
		if (!targetInfo) {
			targetInfo = targets.find(t => t.type === 'page');
		}
		if (!targetInfo) {
			throw new Error('No page target available to read cookies for download');
		}

		const { sessionId } = await this._sendCDP<{ sessionId: string }>('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true });
		try {
			let result: { cookies: RawCDPCookie[] } | undefined;
			try {
				result = await this._sendCDP<{ cookies: RawCDPCookie[] }>('Network.getCookies', {}, sessionId);
			} catch {
				// Some Chromium builds require the Network domain enabled first.
				await this._sendCDP('Network.enable', {}, sessionId).catch(() => { /* ignore */ });
				result = await this._sendCDP<{ cookies: RawCDPCookie[] }>('Network.getCookies', {}, sessionId);
			}
			return (result?.cookies ?? []).map(toPlaywrightCookie);
		} finally {
			await this._sendCDP('Target.detachFromTarget', { sessionId }).catch(() => { /* ignore */ });
		}
	}

	async invokeFunction(pageId: string, fnDef: string, args: unknown[] = [], timeoutMs?: number): Promise<IInvokeFunctionResult> {
		this.logService.info(`[PlaywrightSession] Invoking function on view ${pageId}`);

		if (timeoutMs !== undefined) {
			const fn = await this._compileFunction(fnDef);
			return this._runWithDeferral(pageId, async (page) => fn(page, args ?? []), timeoutMs);
		}

		let result, error;
		try {
			result = await this.invokeFunctionRaw(pageId, fnDef, ...args);
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : String(err);
		}

		const summary = await this._getSummary(pageId);
		return { result, error, summary };
	}

	async waitForDeferredResult(deferredResultId: string, timeoutMs: number): Promise<IInvokeFunctionResult> {
		const entry = this._deferredResults.get(deferredResultId);
		if (!entry) {
			throw new Error(`No deferred result found with ID "${deferredResultId}". It may have been cleaned up or already consumed.`);
		}

		const { pageId, promise } = entry;
		this._deferredResults.deleteAndDispose(deferredResultId);
		return this._runWithDeferral(pageId, () => promise, timeoutMs, deferredResultId);
	}

	async replyToFileChooser(pageId: string, files: string[]): Promise<{ summary: string }> {
		const page = await this._getPage(pageId);
		const tab = this._tabs.get(page);
		if (!tab) {
			throw new Error('Failed to reply to file chooser');
		}
		await tab.replyToFileChooser(files);
		const summary = await tab.getSummary();
		return { summary };
	}

	async replyToDialog(pageId: string, accept: boolean, promptText?: string): Promise<{ summary: string }> {
		const page = await this._getPage(pageId);
		const tab = this._tabs.get(page);
		if (!tab) {
			throw new Error('Failed to reply to dialog');
		}
		await tab.replyToDialog(accept, promptText);
		const summary = await tab.getSummary();
		return { summary };
	}

	// --- Private: page operations ---

	private async _getSummary(pageId: string, full = false): Promise<string> {
		const page = await this._getPage(pageId);
		const tab = this._tabs.get(page);
		if (!tab) {
			throw new Error('Failed to get page summary');
		}
		return tab.getSummary(full);
	}

	private async _runAgainstPage<T>(pageId: string, callback: (page: Page) => T | Promise<T>): Promise<T> {
		const page = await this._getPage(pageId);
		const tab = this._tabs.get(page);
		if (!tab) {
			throw new Error('Failed to execute function against page');
		}
		return tab.safeRunAgainstPage(async () => callback(page));
	}

	private async _runWithDeferral(pageId: string, callback: (page: Page) => Promise<unknown>, timeoutMs: number, existingDeferredId?: string): Promise<IInvokeFunctionResult> {
		const deferred = new DeferredPromise();
		const wrappedPromise = this._runAgainstPage(pageId, async (page) => {
			const promise = callback(page);
			promise.catch(() => { /* prevent unhandled rejection if deferred */ });
			deferred.settleWith(promise);
			return promise;
		});

		let result, error;
		let interrupted = false;

		try {
			result = await raceTimeout(wrappedPromise, timeoutMs, () => { interrupted = true; });
		} catch (err: unknown) {
			if (err instanceof DialogInterruptedError) {
				interrupted = true;
			}
			error = err instanceof Error ? err.message : String(err);
		}

		let deferredResultId: string | undefined;
		if (interrupted) {
			deferredResultId = existingDeferredId ?? generateUuid();
			const cleanup = disposableTimeout(() => this._deferredResults.deleteAndDispose(deferredResultId!), DEFERRED_RESULT_CLEANUP_MS);
			this._deferredResults.set(deferredResultId, { pageId, promise: deferred.p, dispose: () => cleanup.dispose() });
			this.logService.info(`[PlaywrightSession] Execution interrupted, deferred as ${deferredResultId}`);
		}

		const summary = await this._getSummary(pageId);
		return { result, error, summary, deferredResultId };
	}

	private async _compileFunction(fnDef: string): Promise<(page: Page, args: unknown[]) => unknown> {
		const vm = await import('vm');
		return vm.compileFunction(`return (${fnDef})(page, ...args)`, ['page', 'args'], { parsingContext: vm.createContext() }) as (page: Page, args: unknown[]) => unknown;
	}

	// --- Private: page matching (view ↔ page pairing) ---

	private async _getPage(viewId: string): Promise<Page> {
		const resolved = this._viewIdToPage.get(viewId);
		if (resolved) {
			return resolved;
		}
		const queued = this._viewIdQueue.find(item => item.viewId === viewId);
		if (queued) {
			return queued.page.p;
		}
		throw new Error(`Page "${viewId}" not found`);
	}

	private _onViewAdded(viewId: string, timeoutMs = 10000): Promise<Page> {
		const resolved = this._viewIdToPage.get(viewId);
		if (resolved) {
			return Promise.resolve(resolved);
		}
		const queued = this._viewIdQueue.find(item => item.viewId === viewId);
		if (queued) {
			return queued.page.p;
		}

		const deferred = new DeferredPromise<Page>();
		const timeout = setTimeout(() => deferred.error(new Error(`Timed out waiting for page`)), timeoutMs);

		deferred.p.finally(() => {
			clearTimeout(timeout);
			this._viewIdQueue = this._viewIdQueue.filter(item => item.viewId !== viewId);
			if (this._viewIdQueue.length === 0) {
				this._stopScanning();
			}
		});

		this._viewIdQueue.push({ viewId, page: deferred });
		this._tryMatch();
		this._ensureScanning();

		return deferred.p;
	}

	private _onViewRemoved(viewId: string): void {
		this._viewIdQueue = this._viewIdQueue.filter(item => item.viewId !== viewId);
		const page = this._viewIdToPage.get(viewId);
		if (page) {
			this._pageToViewId.delete(page);
		}
		this._viewIdToPage.delete(viewId);
	}

	private _onPageAdded(page: Page, timeoutMs = 10000): Promise<string> {
		const resolved = this._pageToViewId.get(page);
		if (resolved) {
			return Promise.resolve(resolved);
		}
		const queued = this._pageQueue.find(item => item.page === page);
		if (queued) {
			return queued.viewId.p;
		}

		this._onContextAdded(page.context());
		page.once('close', () => this._onPageRemoved(page));
		page.setDefaultTimeout(10000);
		this._tabs.set(page, new PlaywrightTab(page, this.agentNetworkFilterService));

		const deferred = new DeferredPromise<string>();
		const timeout = setTimeout(() => deferred.error(new Error(`Timed out waiting for browser view`)), timeoutMs);
		deferred.p.finally(() => {
			clearTimeout(timeout);
			this._pageQueue = this._pageQueue.filter(item => item.page !== page);
		});

		this._pageQueue.push({ page, viewId: deferred });
		this._tryMatch();

		return deferred.p;
	}

	private _onPageRemoved(page: Page): void {
		this._pageQueue = this._pageQueue.filter(item => item.page !== page);
		const viewId = this._pageToViewId.get(page);
		if (viewId) {
			this._viewIdToPage.delete(viewId);
		}
		this._pageToViewId.delete(page);
	}

	private _onContextAdded(context: BrowserContext): void {
		if (this._watchedContexts.has(context)) {
			return;
		}
		this._watchedContexts.add(context);
		context.on('page', (page: Page) => this._onPageAdded(page));
		context.on('close', () => this._watchedContexts.delete(context));
		for (const page of context.pages()) {
			this._onPageAdded(page);
		}
	}

	// --- Private: matching ---

	private _tryMatch(): void {
		while (this._viewIdQueue.length > 0 && this._pageQueue.length > 0) {
			const viewIdItem = this._viewIdQueue.shift()!;
			const pageItem = this._pageQueue.shift()!;

			this._viewIdToPage.set(viewIdItem.viewId, pageItem.page);
			this._pageToViewId.set(pageItem.page, viewIdItem.viewId);

			viewIdItem.page.complete(pageItem.page);
			pageItem.viewId.complete(viewIdItem.viewId);

			this.logService.debug(`[PlaywrightSession] Matched view ${viewIdItem.viewId} → page`);
		}

		if (this._viewIdQueue.length === 0) {
			this._stopScanning();
		}
	}

	// --- Private: context scanning ---

	private _scanForNewContexts(): void {
		for (const context of this._browser.contexts()) {
			this._onContextAdded(context);
		}
	}

	private _ensureScanning(): void {
		if (this._scanTimer === undefined) {
			this._scanTimer = setInterval(() => this._scanForNewContexts(), 100);
		}
	}

	private _stopScanning(): void {
		if (this._scanTimer !== undefined) {
			clearInterval(this._scanTimer);
			this._scanTimer = undefined;
		}
	}

	override dispose(): void {
		this._stopScanning();
		for (const { reject, timer } of this._cdpPending.values()) {
			clearTimeout(timer);
			reject(new Error('PlaywrightSession disposed'));
		}
		this._cdpPending.clear();
		this._cookieCache.clear();
		this._tapdCookies = undefined;
		this._browser?.close().catch(() => { /* ignore */ });
		for (const { page } of this._viewIdQueue) {
			page.error(new Error('PlaywrightSession disposed'));
		}
		for (const { viewId } of this._pageQueue) {
			viewId.error(new Error('PlaywrightSession disposed'));
		}
		this._viewIdQueue = [];
		this._pageQueue = [];
		super.dispose();
	}
}
