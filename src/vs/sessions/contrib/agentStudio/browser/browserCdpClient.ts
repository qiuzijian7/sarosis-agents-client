/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `browser_*` 工具的 renderer 侧高层客户端（P1-2，2026-09-24）：把 CDP 的裸命令编排成
 * 工具语义（导航 / 快照 / 点击 / 输入 / 滚动 / 后退）。
 *
 * 与 `browser/providers/tool/browserTools.ts` 的分工同 webTools/webSearchProviders：
 * 本文件是**能力层**（CDP 命令组合 + 页面状态判断），tools 文件只是工具定义与参数校验。
 *
 * 三个关键实现决定：
 *
 * ① **真实输入事件而非 `el.click()` / 直接改 value**。`Input.dispatchMouseEvent` /
 *    `Input.insertText` 走的是浏览器输入管线（会触发 :hover、focus、input 事件），
 *    React 受控组件与带反自动化检测的站点都能正常工作；直接操作 DOM 属性则会静默失效。
 *
 * ② **坐标取 `getBoundingClientRect`（视口坐标）**，与 `Input.dispatchMouseEvent` 的
 *    坐标系一致 —— 不需要减滚动偏移（这是 client rect 与 offsetTop 的关键差别）。
 *
 * ③ **点击/导航后自动带回新快照**。这两类操作几乎必然改变 DOM，旧 ref 随即失效；不自动
 *    带回的话模型要额外花一轮 `browser_snapshot`（而它无论如何都需要）。`browser_type`
 *    刻意**不**自动快照 —— 连续填多个输入框时，每次都回整页快照会成倍放大 token。
 */

import { IMAGES_SCRIPT, READY_STATE_SCRIPT, SAROS_REF_ATTR, SNAPSHOT_SCRIPT, formatSnapshot, isDocumentComplete, normalizeRawImages, normalizeRawSnapshot } from './browserCdpSnapshot.js';
import { CDP_COMMAND_TIMEOUT_MS } from '../common/browserCdp.js';
import type { BrowserCdpRequest, IBrowserCdpPage, IBrowserCdpResponse, IBrowserCdpStatus } from '../common/browserCdp.js';
import type { ICdpLogger } from '../common/browserCdp.js';
import type { IRawImages, IRawSnapshot } from './browserCdpSnapshot.js';

/** 调主进程通道（由 builtinToolProvider 注入 `ipcRenderer.invoke` 的封装）。 */
export interface IBrowserCdpInvoker {
	(req: BrowserCdpRequest): Promise<IBrowserCdpResponse>;
}

/** 导航类命令的超时（页面可能很慢；比默认 20s 宽）。 */
const NAVIGATE_TIMEOUT_MS = 45_000;
/** 等 `document.readyState === 'complete'` 的上限。 */
const READY_STATE_TIMEOUT_MS = 15_000;
/** readyState 轮询间隔。 */
const READY_STATE_POLL_MS = 250;

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * 少数常用键的 CDP 定义（`text` 非空 = 需要额外发一条 `char` 事件才生效）。
 * 其余按键走 fallback：只发 rawKeyDown/keyUp（够用于方向键、功能键）。
 */
const KEY_DEFINITIONS: Readonly<Record<string, { code: string; key: string; vk: number; text: string }>> = {
	Enter: { code: 'Enter', key: 'Enter', vk: 13, text: '\r' },
	Tab: { code: 'Tab', key: 'Tab', vk: 9, text: '\t' },
	Escape: { code: 'Escape', key: 'Escape', vk: 27, text: '' },
	Backspace: { code: 'Backspace', key: 'Backspace', vk: 8, text: '' },
	Delete: { code: 'Delete', key: 'Delete', vk: 46, text: '' },
	ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38, text: '' },
	ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40, text: '' },
};

export class BrowserCdpClient {

	/** 最近一次协商到的页面（缓存避免每条命令都重新 attach）。 */
	private _page: IBrowserCdpPage | undefined;

	constructor(
		private readonly _invoke: IBrowserCdpInvoker,
		private readonly _logger?: ICdpLogger,
	) { }

	/** 统一的 invoke 封装：把 `{ok:false}` 转成异常（工具层只需处理异常）。 */
	private async _call<T>(req: BrowserCdpRequest): Promise<T> {
		const res = await this._invoke(req);
		if (!res?.ok) {
			throw new Error(res?.error ?? 'browser CDP call failed');
		}
		return res.result as T;
	}

	async status(): Promise<IBrowserCdpStatus> {
		return this._call<IBrowserCdpStatus>({ op: 'status' });
	}

	/** 丢弃主进程侧连接（设置在改端口后调用，或排障）。 */
	async reset(): Promise<void> {
		this._page = undefined;
		await this._call({ op: 'reset' });
	}

	/**
	 * 取当前页面：优先复用缓存的页面，失效（用户关了 tab / 连接断了）时重新协商一次。
	 *
	 * "失效后重试一次"是必要的：用户随时可能手动关掉浏览器里的 tab，此时缓存的 targetId
	 * 会一直报错；重试一次而不是直接失败，才符合"多步任务中被外部干扰"的真实情况。
	 */
	async page(url?: string): Promise<IBrowserCdpPage> {
		if (this._page && !url) { return this._page; }
		try {
			this._page = await this._call<IBrowserCdpPage>({ op: 'ensurePage', url });
			return this._page;
		} catch (err) {
			if (!this._page) { throw err; }
			this._logger?.warn?.(`[BrowserCdp] cached page unusable (${errMsg(err)}), re-negotiating`);
			this._page = undefined;
			this._page = await this._call<IBrowserCdpPage>({ op: 'ensurePage', url });
			return this._page;
		}
	}

	/** 关掉**本工具创建**的页面（主进程会拒绝关闭用户自己的 tab）。 */
	async closeOwnedPage(): Promise<void> {
		if (!this._page) { return; }
		try {
			await this._call({ op: 'closePage', targetId: this._page.targetId });
		} finally {
			this._page = undefined;
		}
	}

	// ─── CDP 命令封装 ────────────────────────────────────────────────────────

	private async _send(method: string, params?: Record<string, unknown>, timeoutMs: number = CDP_COMMAND_TIMEOUT_MS): Promise<unknown> {
		const page = await this.page();
		return this._call<unknown>({ op: 'command', targetId: page.targetId, sessionId: page.sessionId, method, params, timeoutMs });
	}

	/**
	 * 页内求值并取回值。
	 *
	 * 处理两件容易漏掉的事：① `Runtime.evaluate` 的返回值包在 `{ result: { value } }` 里；
	 * ② 页内抛异常时 CDP **不报错**，而是回 `exceptionDetails` —— 不检查的话会拿到
	 * `undefined` 并把它当成功，把页面错误变成"空结果"。
	 */
	private async _evaluate<T>(expression: string, timeoutMs: number = CDP_COMMAND_TIMEOUT_MS): Promise<T> {
		const res = await this._send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, timeoutMs) as {
			result?: { value?: unknown };
			exceptionDetails?: { text?: string; exception?: { description?: string } };
		};
		if (res?.exceptionDetails) {
			const desc = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'unknown page error';
			throw new Error(`page evaluation failed: ${desc.split('\n')[0]}`);
		}
		return res?.result?.value as T;
	}

	/** 等 `document.readyState === 'complete'`（超时不抛 —— 由调用方决定是否照常继续）。 */
	private async _waitReady(timeoutMs: number = READY_STATE_TIMEOUT_MS): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				if (isDocumentComplete(await this._evaluate(READY_STATE_SCRIPT, 5000))) { return true; }
			} catch {
				// 导航中可能短暂报错（执行上下文被销毁）—— 继续等。
			}
			await new Promise<void>(r => setTimeout(r, READY_STATE_POLL_MS));
		}
		return false;
	}

	// ─── 工具语义 ────────────────────────────────────────────────────────────

	async snapshot(): Promise<IRawSnapshot> {
		return normalizeRawSnapshot(await this._evaluate(SNAPSHOT_SCRIPT, 20_000));
	}

	/**
	 * 取当前页面的图片清单（`browser_get_images`）。
	 *
	 * 与 `snapshot()` 同一取向：只**采集**并收窄类型，怎么呈现交给 `formatImages`（可单测）。
	 * 超时给 20s：大页面上 `querySelectorAll('img')` + 逐张读 `naturalWidth`/`getBoundingClientRect`
	 * 会触发样式计算，比纯节点遍历慢。
	 */
	async images(): Promise<IRawImages> {
		return normalizeRawImages(await this._evaluate(IMAGES_SCRIPT, 20_000));
	}

	/** 导航到 URL，等加载完，返回格式化快照。 */
	async navigate(url: string): Promise<string> {
		// 让主进程按 URL 复用同名页面（避免每次导航都新开 tab）。
		this._page = await this._call<IBrowserCdpPage>({ op: 'ensurePage', url });
		await this._send('Page.enable').catch(() => undefined);
		await this._send('Page.navigate', { url }, NAVIGATE_TIMEOUT_MS);
		const ready = await this._waitReady();
		const snap = await this.snapshot();
		const note = ready ? '' : '\n\n_(the page had not finished loading when this snapshot was taken — consider `browser_snapshot` again)_';
		return formatSnapshot(snap) + note;
	}

	/** 按 ref 点击：真实鼠标事件（见文件头 ①）。返回新快照。 */
	async click(ref: number): Promise<string> {
		const info = await this._evaluate<{ ok: boolean; reason?: string; x?: number; y?: number; label?: string }>(`
			(() => {
				const el = document.querySelector('[${SAROS_REF_ATTR}="${ref}"]');
				if (!el) { return { ok: false, reason: 'ref-not-found' }; }
				el.scrollIntoView({ block: 'center', inline: 'center' });
				const r = el.getBoundingClientRect();
				return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, label: (el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 80) };
			})()
		`, 10_000);

		if (!info?.ok || typeof info.x !== 'number' || typeof info.y !== 'number') {
			throw new Error(`ref [${ref}] not found on the page (${info?.reason ?? 'unknown'}). Refs are invalidated by navigation or re-render — call browser_snapshot and retry with a fresh ref.`);
		}

		const base = { x: info.x, y: info.y, button: 'left' as const, clickCount: 1 };
		await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y });
		await this._send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
		await this._send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });

		// 点击几乎必然改变 DOM（跳转/展开/提交）⇒ 旧 ref 失效，直接带回新快照。
		await new Promise<void>(r => setTimeout(r, 300));
		const snap = await this.snapshot();
		return `Clicked [${ref}] ${info.label ?? ''}`.trim() + '\n\n' + formatSnapshot(snap);
	}

	/** 按 ref 输入文本（默认先全选以替换原值；`append: true` 保留原值续写）。 */
	async type(ref: number, text: string, opts?: { append?: boolean }): Promise<string> {
		// 默认清空语义：全选后 insertText 会替换选区（对 React 受控组件也生效，因为走的是
		// 真实输入管线而不是直接改 value）。
		const selectFirst = opts?.append !== true;
		const info = await this._evaluate<{ ok: boolean; reason?: string; label?: string }>(`
			(() => {
				const el = document.querySelector('[${SAROS_REF_ATTR}="${ref}"]');
				if (!el) { return { ok: false, reason: 'ref-not-found' }; }
				el.scrollIntoView({ block: 'center', inline: 'center' });
				el.focus();
				if (${selectFirst} && typeof el.select === 'function') { try { el.select(); } catch (e) { } }
				return { ok: true, label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName || '').slice(0, 80) };
			})()
		`, 10_000);

		if (!info?.ok) {
			throw new Error(`ref [${ref}] not found on the page (${info?.reason ?? 'unknown'}). Call browser_snapshot and retry with a fresh ref.`);
		}

		await this._send('Input.insertText', { text });
		// 刻意不自动快照：连续填多个字段时每次回整页会成倍放大 token（见文件头 ③）。
		return `Typed into [${ref}] ${info.label ?? ''} (${text.length} chars). Refs are still valid unless typing triggered a re-render; call browser_snapshot if unsure.`;
	}

	/** 按 Enter（`browser_type` 的 submit 用）。 */
	async pressEnter(): Promise<string> {
		await this.pressKey('Enter');
		return 'Pressed Enter.';
	}

	/**
	 * 按下单个键（走真实键盘事件）。
	 *
	 * Enter 需要三步才真的"提交"：`rawKeyDown`（keydown）→ `char`（插入 \r，这一步才会
	 * 触发表单提交/确认）→ `keyUp`。只发 keyDown/keyUp 的话表单不会提交（实测踩过的坑）。
	 */
	async pressKey(key: string): Promise<void> {
		const definition = KEY_DEFINITIONS[key] ?? { code: key, key, vk: 0, text: '' };
		const base = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.vk, nativeVirtualKeyCode: definition.vk };
		await this._send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
		if (definition.text) {
			await this._send('Input.dispatchKeyEvent', { type: 'char', text: definition.text, ...base });
		}
		await this._send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
	}

	/**
	 * 滚动（真实 wheel 事件，可触发懒加载）。
	 *
	 * `ref` 给定时把滚轮**打在元素中心**而不是视口中心 —— 这样滚轮事件落在那个元素上，
	 * 于是真正被滚动的是它内部的可滚动容器（详情面板、下拉列表等场景）。否则滚的是页面。
	 */
	async scroll(direction: 'up' | 'down', amount: number, ref?: number): Promise<string> {
		const view = await this._evaluate<{ w: number; h: number }>(
			`({ w: window.innerWidth, h: window.innerHeight })`, 5000);
		let x = Math.floor((view?.w ?? 800) / 2);
		let y = Math.floor((view?.h ?? 600) / 2);

		if (ref !== undefined) {
			const box = await this._evaluate<{ ok: boolean; reason?: string; x?: number; y?: number }>(`
				(() => {
					const el = document.querySelector('[${SAROS_REF_ATTR}="${ref}"]');
					if (!el) { return { ok: false, reason: 'ref-not-found' }; }
					el.scrollIntoView({ block: 'center', inline: 'center' });
					const r = el.getBoundingClientRect();
					return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
				})()
			`, 10_000);
			if (!box?.ok || typeof box.x !== 'number' || typeof box.y !== 'number') {
				throw new Error(`ref [${ref}] not found on the page (${box?.reason ?? 'unknown'}). Call browser_snapshot and retry with a fresh ref.`);
			}
			x = Math.floor(box.x);
			y = Math.floor(box.y);
		}

		const deltaY = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
		await this._send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
		await new Promise<void>(r => setTimeout(r, 250));
		// 报了哪个位置必须与"实际被滚的是谁"一致：给了 ref 就是元素内部，否则是页面。
		const after = ref === undefined
			? await this._evaluate<{ y: number; max: number }>(
				`({ y: window.scrollY, max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) })`, 5000)
			: await this._evaluate<{ y: number; max: number }>(`
				(() => {
					const el = document.querySelector('[${SAROS_REF_ATTR}="${ref}"]');
					if (!el) { return { y: 0, max: 0 }; }
					return { y: el.scrollTop, max: Math.max(0, el.scrollHeight - el.clientHeight) };
				})()
			`, 5000);
		const scope = ref === undefined ? 'page' : `element [${ref}]`;
		// 滚动不改变 DOM 结构 ⇒ 不回快照（ref 仍有效），只报位置，避免无谓 token。
		return `Scrolled ${scope} ${direction} by ${Math.abs(amount)}px — now at ${Math.round(after?.y ?? 0)} / ${Math.round(after?.max ?? 0)}px. Refs from the last snapshot are still valid; new content may have lazy-loaded, so call browser_snapshot if you need refs for items that just appeared.`;
	}

	/** 后退一页，返回新快照。 */
	async back(): Promise<string> {
		const history = await this._send('Page.getNavigationHistory') as {
			currentIndex?: number;
			entries?: Array<{ id?: number; url?: string }>;
		};
		const idx = typeof history?.currentIndex === 'number' ? history.currentIndex : 0;
		const entries = Array.isArray(history?.entries) ? history.entries : [];
		if (idx <= 0 || entries.length === 0) {
			return 'Cannot go back: this page has no previous entry in history.';
		}
		const prev = entries[idx - 1];
		if (typeof prev?.id !== 'number') {
			return 'Cannot go back: previous history entry is not addressable.';
		}
		await this._send('Page.navigateToHistoryEntry', { entryId: prev.id }, NAVIGATE_TIMEOUT_MS);
		await this._waitReady();
		const snap = await this.snapshot();
		return `Went back to ${prev.url ?? '(unknown url)'}\n\n` + formatSnapshot(snap);
	}
}
