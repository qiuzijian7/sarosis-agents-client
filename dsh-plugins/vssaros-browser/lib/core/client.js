/**
 * `browser` 工具的**能力层**（CDP 命令编排：导航 / 快照 / 点击 / 输入 / 滚动 / 后退）。
 * 逐条移植自 `src/vs/sessions/contrib/agentStudio/browser/browserCdpClient.ts`（逻辑不变，
 * 只把"经 IPC 调主进程"换成"调 Host 侧的 invoker"）。
 *
 * 三条关键实现决定（照搬，别"优化"）：
 * ① **真实输入事件**（`Input.dispatchMouseEvent` / `Input.insertText`）而不是 `el.click()` / 直接改 value：
 *    走浏览器输入管线才会触发 :hover/focus/input，React 受控组件与反自动化检测的站点才工作。
 * ② **坐标取 `getBoundingClientRect`（视口坐标）**，与 `Input.dispatchMouseEvent` 的坐标系一致（不减滚动偏移）。
 * ③ **点击/导航/后退后自动带回新快照**（这些操作必然改 DOM，旧 ref 随即失效）；`type` 刻意**不**回快照
 *    （连续填多个字段时每次回整页会成倍放大 token）。
 */

import {
	IMAGES_SCRIPT, READY_STATE_SCRIPT, SAROS_REF_ATTR, SNAPSHOT_SCRIPT,
	formatSnapshot, isDocumentComplete, normalizeRawImages, normalizeRawSnapshot,
} from './snapshot.js';
import { filterCookiesForSite, parseSiteUrl } from './cookies.js';
import { withLivenessRetry } from './interaction.js';
import { PAGE_PROBE_SCRIPT, judgeLoginState, normalizePageProbe } from './loginProbe.js';
import { CDP_COMMAND_TIMEOUT_MS } from './chrome.js';

/** 导航类命令的超时（页面可能很慢；比默认 20s 宽）。 */
const NAVIGATE_TIMEOUT_MS = 45_000;
/** 等 `document.readyState === 'complete'` 的上限。 */
const READY_STATE_TIMEOUT_MS = 15_000;
/** readyState 轮询间隔。 */
const READY_STATE_POLL_MS = 250;

function errMsg(err) {
	return err instanceof Error ? err.message : String(err);
}

/**
 * 少数常用键的 CDP 定义（`text` 非空 = 需要额外发一条 `char` 事件才生效）。
 * 其余按键走 fallback：只发 rawKeyDown/keyUp（够用于方向键、功能键）。
 */
const KEY_DEFINITIONS = {
	Enter: { code: 'Enter', key: 'Enter', vk: 13, text: '\r' },
	Tab: { code: 'Tab', key: 'Tab', vk: 9, text: '\t' },
	Escape: { code: 'Escape', key: 'Escape', vk: 27, text: '' },
	Backspace: { code: 'Backspace', key: 'Backspace', vk: 8, text: '' },
	Delete: { code: 'Delete', key: 'Delete', vk: 46, text: '' },
	ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38, text: '' },
	ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40, text: '' },
};

export class BrowserCdpClient {
	/**
	 * 最近一次协商到的页面（缓存避免每条命令都重新 attach）。
	 *
	 * **每个实例一份** —— 实例按会话创建（见 `forSession`），所以这个缓存在多会话下天然隔离：
	 * 会话 A 的 `navigate` 只改 A 的缓存，不会把 B 的"当前页"顶掉。
	 */
	_page = undefined;

	/**
	 * @param invoke 通道实现（`core/invoker.js`）
	 * @param logger
	 * @param key **会话归属键**（dsh 的 `exec.agent.id`＝SessionId）—— 决定"用谁的 tab"；
	 *   空串＝不隔离（IDE 侧旧路径 / 测试 / 诊断）。
	 */
	constructor(invoke, logger, key = '') {
		this._invoke = invoke;
		this._logger = logger;
		this._key = typeof key === 'string' ? key : '';
	}

	/** 本视图所属的会话键（工具层的报错/描述会用到）。 */
	get sessionKey() { return this._key; }

	/**
	 * 取一个**绑定到某会话**的视图：共享底层连接（一条浏览器级 WS），但各自持有自己的页面缓存。
	 *
	 * 为什么是"绑定视图"而不是给每个方法加一个 key 参数：多会话隔离的全部影响面只有
	 * "**用哪条 tab**"这一件事 —— 把它收进实例字段，其余方法签名与既有逻辑一行都不用改；
	 * 而"每个方法都要记得传 key"正是最容易漏一处的地方（漏一处就串台，且只在并发时复现）。
	 */
	forSession(key) {
		return new BrowserCdpClient(this._invoke, this._logger, key);
	}

	/** 统一的 invoke 封装：把 `{ok:false}` 转成异常（工具层只需处理异常）。 */
	async _call(req) {
		const res = await this._invoke(req);
		if (!res?.ok) {
			throw new Error(res?.error ?? 'browser CDP call failed');
		}
		return res.result;
	}

	async status() {
		return this._call({ op: 'status' });
	}

	/**
	 * 丢弃连接（开发期改端口后调用，或排障）。
	 *
	 * ⚠ 这是**进程级**动作：连接一断，**所有会话**的 `sessionId` 都作废。各自名下的 tab 仍在
	 * （`_ownerOf` 跨断线保留）⇒ 它们下次调用会重新 attach 回**自己的**那一条（见 `CdpTargetManager`）。
	 */
	async reset() {
		this._page = undefined;
		await this._call({ op: 'reset' });
	}

	/**
	 * 取当前页面：优先复用缓存，失效（用户关了 tab / 连接断了）时重试一次重新协商。
	 * "重试一次"是必要的：用户随时可能手动关掉 tab，直接失败不符合"多步任务被外部干扰"的真实情况。
	 */
	async page(url) {
		if (this._page && !url) { return this._page; }
		try {
			this._page = await this._call({ op: 'ensurePage', url, key: this._key });
			return this._page;
		} catch (err) {
			if (!this._page) { throw err; }
			this._logger?.warn?.(`[vssaros-browser] cached page unusable (${errMsg(err)}), re-negotiating`);
			this._page = undefined;
			this._page = await this._call({ op: 'ensurePage', url, key: this._key });
			return this._page;
		}
	}

	/** 关掉**本工具创建**的页面（Host 侧会拒绝关闭用户自己的 tab，也会拒绝关别的会话的）。 */
	async closeOwnedPage() {
		if (!this._page) { return; }
		try {
			await this._call({ op: 'closePage', targetId: this._page.targetId, key: this._key });
		} finally {
			this._page = undefined;
		}
	}

	// ─── CDP 命令封装 ────────────────────────────────────────────────────────

	async _send(method, params, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
		const page = await this.page();
		return this._call({ op: 'command', targetId: page.targetId, sessionId: page.sessionId, method, params, timeoutMs });
	}

	/**
	 * 页内求值并取回值。处理两件容易漏掉的事：① 返回值包在 `{ result: { value } }` 里；
	 * ② 页内抛异常时 CDP **不报错**而是回 `exceptionDetails` —— 不检查就会把页面错误当成"空结果"。
	 */
	async _evaluate(expression, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
		const res = await this._send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, timeoutMs);
		if (res?.exceptionDetails) {
			const desc = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'unknown page error';
			throw new Error(`page evaluation failed: ${desc.split('\n')[0]}`);
		}
		return res?.result?.value;
	}

	/** 等 `document.readyState === 'complete'`（超时不抛 —— 由调用方决定是否照常继续）。 */
	async _waitReady(timeoutMs = READY_STATE_TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				if (isDocumentComplete(await this._evaluate(READY_STATE_SCRIPT, 5000))) { return true; }
			} catch {
				// 导航中可能短暂报错（执行上下文被销毁）—— 继续等。
			}
			await new Promise(r => setTimeout(r, READY_STATE_POLL_MS));
		}
		return false;
	}

	/**
	 * Input 事件的"**超时 ⇒ 先验活、再重试一次**"封装（2026-10-15；真机现场：重 JS 页面上
	 * `Input.dispatchMouseEvent` 偶发 20s 超时）。
	 *
	 * 判据与文案的唯一真源是 `core/interaction.js` 的 `withLivenessRetry`（可单测 ✓）—— 这里只负责
	 * 把"本连接的 `_send` / 本页的验活探针"绑进去。⚠ 验活探针用 `Runtime.evaluate('1')`：
	 * 它不重、不带副作用，且与 Input 派发走**同一条连接、同一个目标** ⇒ 探活通不通真能说明问题 ✓。
	 */
	async _input(method, params, label) {
		await withLivenessRetry({
			method,
			label,
			run: async () => { await this._send(method, params); },
			probe: ms => this._send('Runtime.evaluate', { expression: '1', returnByValue: true }, ms),
		});
	}

	// ─── 工具语义 ────────────────────────────────────────────────────────────

	async snapshot() {
		return normalizeRawSnapshot(await this._evaluate(SNAPSHOT_SCRIPT, 20_000));
	}

	/** 取当前页面的图片清单（与 snapshot 同一取向：只采集，呈现交给 `formatImages`）。 */
	async images() {
		return normalizeRawImages(await this._evaluate(IMAGES_SCRIPT, 20_000));
	}

	/** 导航到 URL，等加载完，返回格式化快照。 */
	async navigate(url) {
		// ⚠ 必须带 `key`：漏了它 ⇒ 走到"无会话"分支 ⇒ 会**复用别的会话正在用的 tab**（真机实测：两个会话
		//   的 navigate 落进同一条 tab，互相顶掉页面与 ref 标记）。这类漏传只在并发时显形，守卫专门钉它。
		this._page = await this._call({ op: 'ensurePage', url, key: this._key });
		await this._send('Page.enable').catch(() => undefined);
		await this._send('Page.navigate', { url }, NAVIGATE_TIMEOUT_MS);
		const ready = await this._waitReady();
		const snap = await this.snapshot();
		const note = ready ? '' : '\n\n_(the page had not finished loading when this snapshot was taken — consider `browser_snapshot` again)_';
		return formatSnapshot(snap) + note;
	}

	/** 按 ref 点击：真实鼠标事件（见文件头 ①）。返回新快照。 */
	async click(ref) {
		const info = await this._evaluate(`
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

		const base = { x: info.x, y: info.y, button: 'left', clickCount: 1 };
		await this._input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y });
		await this._input('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
		await this._input('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });

		// 点击几乎必然改变 DOM（跳转/展开/提交）⇒ 旧 ref 失效，直接带回新快照。
		await new Promise(r => setTimeout(r, 300));
		const snap = await this.snapshot();
		return `Clicked [${ref}] ${info.label ?? ''}`.trim() + '\n\n' + formatSnapshot(snap);
	}

	/** 按 ref 输入文本（默认先全选以替换原值；`append: true` 保留原值续写）。 */
	async type(ref, text, opts) {
		// 默认清空语义：全选后 insertText 会替换选区（对 React 受控组件也生效，因为走真实输入管线）。
		const selectFirst = opts?.append !== true;
		const info = await this._evaluate(`
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

		await this._input('Input.insertText', { text });
		// 刻意不自动快照：连续填多个字段时每次回整页会成倍放大 token（见文件头 ③）。
		return `Typed into [${ref}] ${info.label ?? ''} (${text.length} chars). Refs are still valid unless typing triggered a re-render; call browser_snapshot if unsure.`;
	}

	/** 按 Enter（`browser_type` 的 submit 用）。 */
	async pressEnter() {
		await this.pressKey('Enter');
		return 'Pressed Enter.';
	}

	/**
	 * 按下单个键（走真实键盘事件）。Enter 需要三步才真的"提交"：
	 * `rawKeyDown` → `char`（插入 \r，这一步才触发表单提交/确认）→ `keyUp`。
	 */
	async pressKey(key) {
		const definition = KEY_DEFINITIONS[key] ?? { code: key, key, vk: 0, text: '' };
		const base = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.vk, nativeVirtualKeyCode: definition.vk };
		await this._input('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
		if (definition.text) {
			await this._input('Input.dispatchKeyEvent', { type: 'char', text: definition.text, ...base });
		}
		await this._input('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
	}

	/**
	 * 滚动（真实 wheel 事件，可触发懒加载）。`ref` 给定时把滚轮**打在元素中心**（滚的是它内部的可滚动
	 * 容器），否则滚页面。
	 */
	async scroll(direction, amount, ref) {
		const view = await this._evaluate(`({ w: window.innerWidth, h: window.innerHeight })`, 5000);
		let x = Math.floor((view?.w ?? 800) / 2);
		let y = Math.floor((view?.h ?? 600) / 2);

		if (ref !== undefined) {
			const box = await this._evaluate(`
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
		await this._input('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
		await new Promise(r => setTimeout(r, 250));
		// 报了哪个位置必须与"实际被滚的是谁"一致：给了 ref 就是元素内部，否则是页面。
		const after = ref === undefined
			? await this._evaluate(`({ y: window.scrollY, max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) })`, 5000)
			: await this._evaluate(`
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
	async back() {
		const history = await this._send('Page.getNavigationHistory');
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

	// ─── 登录态与 cookie（2026-10-13）─────────────────────────────────────────
	//
	// 为什么这几样在「能力层」而不是工具层：它们都是 **CDP 命令编排**（`Storage.getCookies` /
	// `Network.setCookies` / 页内求值），与 navigate/click 同一层次。判定与文案在纯函数里
	// （`loginProbe.js` / `cookies.js`，可单测），工具层只负责参数校验与审批。

	/** 浏览器级取 cookie（**全部**站点）—— 过滤是调用方的事（见 `cookies.js` 的域名边界判断）。 */
	async cookiesGetAll() {
		const res = await this._call({ op: 'command', method: 'Storage.getCookies', params: {} });
		return Array.isArray(res?.cookies) ? res.cookies : [];
	}

	/** 取某站点名下的 cookie。 */
	async cookiesForSite(host) {
		return filterCookiesForSite(await this.cookiesGetAll(), host);
	}

	/** 把 cookie 注进当前页面所在上下文（页面级 `Network.setCookies`）。 */
	async cookiesSet(cookies) {
		const list = Array.isArray(cookies) ? cookies.filter(c => !!c && typeof c.name === 'string' && c.name) : [];
		if (list.length === 0) { return { injected: 0 }; }
		await this._send('Network.setCookies', { cookies: list });
		return { injected: list.length };
	}

	/** 页面事实探针（登录判据用；刻意比 snapshot 轻，理由见 `loginProbe.js`）。 */
	async pageProbe() {
		return normalizePageProbe(await this._evaluate(PAGE_PROBE_SCRIPT, 10_000));
	}

	/**
	 * 在**当前页面**里执行调用方给的 JS，取回值（`evaluate` op 的实现，2026-10-13）。
	 *
	 * 与内部 `_evaluate` 的两点**有意不同**（别合并）：
	 *   · `awaitPromise: true` —— 用户的抽取代码常写成 async（等接口、等元素），固定 false 等于逼他们
	 *     绕道；内部那些固定脚本都是同步的，本来就不需要这个能力。
	 *   · 返回值**不归一化**（原样交回，由 `evaluateResult.js` 渲染）—— 内部脚本的返回值形状是已知的，
	 *     而这个 op 的返回形状**由调用方决定**。
	 *
	 * ⚠⚠ 关于"活对象"（DOM 节点）—— **2026-10-13 真机实测的结论，别被下面那段检查误导**：
	 *   `Runtime.evaluate({ returnByValue: true })` 对 `document.body` 的**真实返回**是
	 *   `{ result: { type: 'object', value: {} } }` —— CDP **不报错**、也**不给 `objectId`**，
	 *   而是把它**静默序列化成一个空对象**。这与"页面真的返回了 `{}`"在协议层**无法区分**，
	 *   所以**这里拦不住它**（下面的分支只在某些 CDP 版本/形态下才会命中）。
	 *   真正的补救在渲染层：`evaluateResult.js` 对"空对象"补了一条可行动提示。
	 *   把这段写在这里，是为了防止后人以为"防线在 client"而不去看渲染层 —— 那会得出"已经防住了"的错误结论。
	 */
	async evaluate(expression, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
		const res = await this._send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
		if (res?.exceptionDetails) {
			const desc = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'unknown page error';
			throw new Error(`page evaluation failed: ${desc.split('\n')[0]}`);
		}
		const result = res?.result;
		if (result && result.value === undefined && typeof result.objectId === 'string') {
			throw new Error('the page returned a live object that cannot be serialised (a DOM node, a window, …)'
				+ ' — return a string or a plain object instead, e.g. `el.outerHTML` / `el.textContent` / `[...el.children].map(c => c.className)`');
		}
		return result?.value;
	}

	/** 打开页面但**不回快照**：登录引导要的是"那个窗口"，模型不需要再多一份 8k 字符元素清单。 */
	async openForLogin(url) {
		this._page = await this._call({ op: 'ensurePage', url, key: this._key });
		await this._send('Page.enable').catch(() => undefined);
		await this._send('Page.navigate', { url }, NAVIGATE_TIMEOUT_MS);
		await this._waitReady();
		return this._page;
	}

	/**
	 * 登录态判定：cookie 证据 + 页面证据（两条独立证据；冲突时判 `inconclusive`）。
	 * `url` 省略时以"当前打开的页面"为准 —— 但要如实处理"当前页根本不是目标站"这种情况。
	 *
	 * ★ **没有已协商的页面就不去协商**：这个 op 对外承诺是只读的，而 `page()` 在无缓存时会
	 * `ensurePage()` —— 那会**新建一个 about:blank tab**（凭空开页不是"只读"该有的副作用）。
	 * 缺页面证据不影响 cookie 证据（两条证据独立，见 `loginProbe.js`）。
	 */
	async checkLogin(url) {
		const pageUrl = this._page?.url ?? '';
		const site = parseSiteUrl(url) ?? parseSiteUrl(pageUrl);
		const host = site?.host ?? '';
		const probe = this._page ? await this.pageProbe() : { url: '', host: '', title: '', text: '' };
		const cookies = host ? await this.cookiesGetAll() : [];
		return judgeLoginState({ cookies, probe, host });
	}
}
