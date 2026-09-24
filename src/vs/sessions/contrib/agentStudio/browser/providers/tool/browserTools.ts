/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `browser_*` 工具的真实实现（P1-2，2026-09-24）—— 通过 CDP 驱动用户本机真实 Chrome。
 *
 * ## 背景：这些名字一直在，只是没有 handler
 *
 * 7 个名字（navigate / snapshot / get_images / click / type / scroll / back）早就进了 `CORE_TOOLS`
 * 白名单与 bundled 定义库，但 `registerBundledTools` 把它们注册成 `isStub: true` ⇒ `listTools`
 * 直接跳过 ⇒ **模型完全看不到**，白名单形同虚设（同 `unreal_*` / `image_gen` 的历史坑）。
 * 本模块在 `_registerBundledTools()` **之前**注册真实 handler，让它们真正可用。
 *
 * 其中 `browser_get_images` 是 2026-09-24 补的第 7 个：它是产品一直预留的 stub，而"图文帖的
 * 正文在图片里"（小红书尤甚）恰恰只靠它 —— 快照**不采集图片**，模型既看不到图，也无法
 * `vision_analyze`（后者需要一个 URL）。它按需调用（图片 URL 很长，塞进快照等于每轮都付）。
 *
 * 顺带校正了一条失真的注释：`toolsetConfig.ts` 里写「用于 LLM 看到浏览器工具但实际被沙箱
 * 限制时仍可调用基础导航」—— 实际上从未可见过（stub 被跳过）。
 *
 * ## 工具语义的约定（与模型的使用流程强相关）
 *
 *   `browser_snapshot` 给每个可交互元素打 `[n]` ref；`browser_click` / `browser_type` 用这些
 *   ref 操作。**导航或页面重渲染会让 ref 失效** —— 所以 navigate / click / back 的结果里
 *   直接带回新快照（省掉模型一次往返），而 `type` 刻意不带（连续填多字段时回整页快照会成倍
 *   放大 token，见 `browserCdpClient.ts` 文件头 ③）。
 *
 * ## 可用性
 *
 * `available` 看三件事（由 `isEnabled` 注入，见 builtinToolProvider 的 `_registerBrowserTools`）：
 *   ① 本环境有 CDP 通道（web/测试环境没有）；
 *   ② 用户没在设置里关掉；
 *   ③ **Chrome 的调试端口真的可达**（带 30s 缓存的探测，见 `_isBrowserCdpUsable`）。
 *
 * ③ 是实测加上的：工具常驻暴露时，没开远程调试的用户每次都会让模型白撞一次
 * `net::ERR_CONNECTION_REFUSED`（且 Chromium 网络栈报这个错要约 2.5 秒，比 Node 慢两个数量级）。
 * 探测不可达就不暴露，模型不会看到、也就不会浪费轮次。
 *
 * 端口不可达时用户仍可能从旧对话/缓存里看到调用，所以 handler 的错误文案依旧带
 * chrome://inspect 的具体步骤 —— 探测只是让绝大多数情况不必走到那一步。
 */

import { NO_PARAMS_SCHEMA, ToolSecurityLevel } from '../../../common/providers.js';
import type { IToolResultContent } from '../../../common/providers.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';
import { BrowserCdpClient, type IBrowserCdpInvoker } from '../../browserCdpClient.js';
import { formatImages, formatSnapshot } from '../../browserCdpSnapshot.js';
import { DEFAULT_CDP_PORT } from '../../../common/browserCdp.js';
import {
	OWN_CHROME_CHOICE_CANCEL,
	OWN_CHROME_CHOICE_KEEP_DEDICATED,
	OWN_CHROME_CHOICE_RECHECK,
	interpretOwnChromeChoice,
	ownChromeGuideQuestion,
	ownChromeOutcomeText,
} from '../../../common/chromeDebugSetup.js';

export interface BrowserToolContext {
	register(registration: IBuiltinToolRegistration): void;
	logService: ILogService;
	/** 调主进程 CDP 通道（`ipcRenderer.invoke` 的封装）。缺省 = 本环境无浏览器能力。 */
	cdp?: IBrowserCdpInvoker;
	/** 用户在设置里是否启用了浏览器工具（默认启用）。 */
	isEnabled?: () => boolean;
	/**
	 * 丢弃旧连接并**立即**重探端点（`browser_use_my_chrome` 用户点完按钮后调用）。
	 *
	 * 为什么必须显式丢弃：候选顺序是「你设置的端口 → 同端口 IPv6 → 专属实例」，而旧连接是在
	 * 用户勾同意框**之前**建立的 ⇒ 它指向专属实例，不丢就永远切不到用户那个 Chrome。
	 */
	recheckEndpoint?: () => Promise<void>;
	/** 端口提示（引导卡要走具体数字：配置端口与专属实例端口）。缺省按默认端口推算。 */
	ports?: () => { configuredPort: number; dedicatedPort: number };
}

// 无参工具的 inputSchema 统一用共享常量 NO_PARAMS_SCHEMA（common/providers.ts）。
// 为什么不能写空 properties、为什么不能把 `_no_params` 当"死参数"删掉、以及共享对象的
// 不可变约定（要改就 spread），全部记在那个常量上 —— 此处不再重复。

/** `ref` 在 schema 里是 string（对齐 bundled 定义），运行时统一收窄成正整数。 */
function parseRef(args: Record<string, unknown>): number {
	const raw = args['ref'];
	const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`ref is required and must be a positive number (got ${JSON.stringify(raw)}). Take it from a browser_snapshot result, e.g. [7] → ref: "7".`);
	}
	return Math.floor(n);
}

// ⚠ 描述尾部那句"简单检索时优先用 web_search / web_extract"**不在这里维护**。
// 它由 `common/schemaCorrector.ts` 的 `TOOL_REFERENCE_HINTS` 按「被引用的工具全部可用才加」
// 统一管理（2026-09-24 合并）。此前是两个文件各持一份同一个字符串，口径是"先无条件写进去、
// 不可用时再按精确匹配删掉" —— 两处字面量漂移即静默失效，所以改成"可用才加"并把句子收敛成一处。
// 详见该文件头（那里也写了为什么修正点在 assembly 之前）。

export function registerBrowserTools(ctx: BrowserToolContext): void {
	const source = 'saros.builtin-tools';
	const enabled = (): boolean => !!ctx.cdp && (ctx.isEnabled?.() ?? true);
	const mkText = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

	/** 懒建客户端：把 `_page` 缓存的生命周期绑在 provider 上，而不是每次调用重建。 */
	let client: BrowserCdpClient | undefined;
	const getClient = (): BrowserCdpClient => {
		if (!ctx.cdp) {
			throw new Error('Browser tools are not available in this environment (no main-process CDP channel).');
		}
		client ??= new BrowserCdpClient(ctx.cdp, ctx.logService);
		return client;
	};

	ctx.register({
		definition: {
			name: 'browser_navigate',
			description: 'Open a URL in the browser and return a snapshot of the loaded page (title, URL, interactive elements with [n] refs, headings, text excerpt). '
				+ 'Use this when a page needs a real browser session: pages behind a login, single-page apps whose content only exists after JavaScript runs, or when you need to click/type on the page. '
				+ 'It drives the dedicated browser tab this tool creates, not the user\'s other tabs. '
				// ★ 登录墙纪律（2026-09-24）：此前描述里只把 "pages behind a login" 当成使用场景提了一句，
				// 对"撞上登录页该怎么办"零指导 —— 那会诱导模型自己去"解决登录"（编造/试错凭据），
				// 既必然失败（有 2FA）又是把凭据塞进上下文的严重安全问题。此处用一句硬纪律替代。
				+ 'If the page requires a login that this browser session does not already have: do NOT invent, guess, or try credentials, and do not attempt to bypass it. '
				+ 'Stop there and tell the user which URL needs a sign-in — they sign in once inside the browser window this tool drives, and that profile keeps the session for later calls.',
			inputSchema: {
				type: 'object',
				properties: { url: { type: 'string', description: 'Absolute URL to open (must start with http:// or https://)' } },
				required: ['url'],
			},
			category: 'browser',
			source,
			securityLevel: ToolSecurityLevel.Cautious,
		},
		available: enabled,
		handler: async args => {
			const url = String(args['url'] ?? '').trim();
			if (!/^https?:\/\//i.test(url)) {
				throw new Error('url must start with http:// or https://');
			}
			return mkText(await getClient().navigate(url));
		},
	});

	ctx.register({
		definition: {
			name: 'browser_snapshot',
			description: 'Take a fresh snapshot of the current browser page: title, URL, interactive elements with [n] refs (links, buttons, inputs, selects), headings, and a text excerpt. '
				+ 'Call this after any navigation or page re-render, because refs are invalidated by those events. Reading the page only (no clicks) needs nothing more than this.',
			// 零参数工具的 schema 形状见 NO_PARAMS_SCHEMA 处的注释。
			inputSchema: NO_PARAMS_SCHEMA,
			category: 'browser',
			source,
			securityLevel: ToolSecurityLevel.Safe,
		},
		available: enabled,
		handler: async () => mkText(formatSnapshot(await getClient().snapshot())),
	});

	ctx.register({
		definition: {
			name: 'browser_get_images',
			description: 'List the images on the current page (rendered `<img>` elements): image URL, rendered size, alt text. '
				+ 'Use it when the page\'s content lives IN images — image-based posts (小红书 / Xiaohongshu, Instagram-style notes), comics, screenshot-heavy tutorials — where `browser_snapshot` gives you text only and no way to see or fetch the pictures. '
				+ 'Afterwards: call `vision_analyze` with an image URL to read the text inside it (one image per call); or, when archiving the page, download the image with `execute_code` and embed it with a **relative** path. '
				+ 'Limits: same-origin `<img>` only (same-origin iframes included) — CSS background images are not listed; base64 `data:` images are skipped; duplicates collapsed; icon-sized images dropped; at most 40 entries, so scroll and call again for more.',
			// 零参数工具的 schema 形状见 NO_PARAMS_SCHEMA 处的注释。
			inputSchema: NO_PARAMS_SCHEMA,
			category: 'browser',
			source,
			securityLevel: ToolSecurityLevel.Safe,
		},
		available: enabled,
		handler: async () => mkText(formatImages(await getClient().images())),
	});

	ctx.register({
		definition: {
			name: 'browser_click',
			description: 'Click an element by its [n] ref from the latest browser_snapshot. Uses a real mouse event at the element\'s centre (works with React-style controlled components and anti-automation checks). '
				+ 'Returns a fresh snapshot afterwards, since a click almost always changes the page. If the ref is stale you get a clear error — call browser_snapshot and retry.',
			inputSchema: {
				type: 'object',
				properties: { ref: { type: 'string', description: 'Element ref from the latest snapshot, e.g. "7" for [7]' } },
				required: ['ref'],
			},
			category: 'browser',
			source,
			securityLevel: ToolSecurityLevel.Cautious,
		},
		available: enabled,
		handler: async args => mkText(await getClient().click(parseRef(args))),
	});

	ctx.register({
		definition: {
			name: 'browser_type',
			description: 'Type text into an input/textarea by its [n] ref from the latest browser_snapshot. Clears the existing value first unless append=true. Text goes through the real input pipeline, so framework-controlled fields behave as if a human typed. '
				+ 'No snapshot is returned (refs normally stay valid), so call browser_snapshot yourself if the page re-rendered.',
			inputSchema: {
				type: 'object',
				properties: {
					ref: { type: 'string', description: 'Element ref from the latest snapshot, e.g. "3" for [3]' },
					text: { type: 'string', description: 'Text to type' },
					append: { type: 'boolean', description: 'Append to the existing value instead of replacing it (default: false)' },
					submit: { type: 'boolean', description: 'Press Enter after typing (default: false)' },
				},
				required: ['ref', 'text'],
			},
			category: 'browser',
			source,
			securityLevel: ToolSecurityLevel.Cautious,
		},
		available: enabled,
		handler: async args => {
			const ref = parseRef(args);
			const text = String(args['text'] ?? '');
			const append = args['append'] === true;
			const submit = args['submit'] === true;
			const client = getClient();
			let out = await client.type(ref, text, { append });
			if (submit) { out += '\n' + await client.pressEnter(); }
			return mkText(out);
		},
	});

	ctx.register({
		definition: {
			name: 'browser_scroll',
			description: 'Scroll the page with a real wheel event (which also triggers lazy loading). Pass a ref to scroll inside a specific scrollable element instead of the page. '
				+ 'Returns the resulting scroll position; refs from the last snapshot stay valid.',
			inputSchema: {
				type: 'object',
				properties: {
					direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
					amount: { type: 'number', description: 'Scroll amount in pixels (default: 500)' },
					ref: { type: 'string', description: 'Optional element ref to scroll within' },
				},
				required: ['direction'],
			},
			category: 'browser',
			source,
			securityLevel: ToolSecurityLevel.Cautious,
		},
		available: enabled,
		handler: async args => {
			const direction = String(args['direction'] ?? '').trim().toLowerCase();
			if (direction !== 'up' && direction !== 'down') {
				throw new Error('direction must be "up" or "down"');
			}
			const amount = Number(args['amount'] ?? 500);
			const ref = args['ref'] === undefined || args['ref'] === '' ? undefined : parseRef(args);
			return mkText(await getClient().scroll(direction, Number.isFinite(amount) && amount > 0 ? amount : 500, ref));
		},
	});

	ctx.register({
		definition: {
			name: 'browser_back',
			description: 'Go back one entry in the browser history and return a snapshot of the page you land on. Returns a clear message (not an error) when there is no previous entry.',
			// 零参数工具的 schema 形状见 NO_PARAMS_SCHEMA 处的注释。
			inputSchema: NO_PARAMS_SCHEMA,
			category: 'browser',
			source,
			securityLevel: ToolSecurityLevel.Cautious,
		},
		available: enabled,
		handler: async () => mkText(await getClient().back()),
	});

	// ─── browser_use_my_chrome：改用「你自己日常的 Chrome」（2026-09-24）─────────
	//
	// 为什么需要它：专属实例（配置端口 +1）是空 profile —— 遇到小红书这类站点只渲染登录墙
	// （实测 `browser_get_images` 只返回 15 张头像）。用户自己那个 Chrome 带着**全部站点**的
	// 登录态，代价是让他手动勾一次同意框（没法自动化：Chrome 忽略程序传来的 chrome:// 地址）。
	//
	// 两道工序，全程都在聊天框里完成：
	//   ① 首次调用（无参）→ 返回 `__clarify__` **引导卡**（options 即按钮）⇒ 当轮结束，等用户点；
	//   ② 用户点「我已勾选，重新检测」→ 选择作为用户消息回到模型 → 模型带 `confirmed: true`
	//      与 `choice`（按钮原文）再调一次 ⇒ 丢弃旧连接 + 重探 + 给结论。
	//
	// 为什么不做成"一个工具调用里 await 用户点击"：那需要新的 IPC/事件通道（审批卡那条路受
	// `tools.confirmToolCalls` 开关控制，实测该项目里是**关**的 ⇒ 卡片根本不会出现）。
	// 走 `__clarify__` 则复用既有协议：卡片渲染、回传、结束当轮三件事全都是现成的。
	ctx.register({
		definition: {
			name: 'browser_use_my_chrome',
			description: 'Switch to driving the USER\'S OWN Chrome (their everyday browser, with all their site logins) instead of the dedicated empty-profile instance. '
				+ 'Call this when the page you need sits behind a login the dedicated instance does not have (it will only ever show a login wall), or when the user asks for their own browser. '
				+ 'It shows the user a card with the one manual step only they can perform (ticking Chrome\'s remote-debugging consent), then re-detects the endpoint and reports what happened. '
				+ 'Flow: (1) call once with no arguments to raise the guide card; (2) after the user clicks a button, call again with `confirmed: true` and `choice` set to that button\'s label verbatim.',
			inputSchema: {
				type: 'object',
				properties: {
					confirmed: { type: 'boolean', description: 'Set true on the second call — only after the user clicked a button on the guide card.' },
					choice: { type: 'string', description: 'Second call only: the exact label of the button the user clicked.' },
				},
			},
			category: 'browser',
			source,
			securityLevel: ToolSecurityLevel.Safe,
		},
		available: enabled,
		handler: async args => {
			// 生产环境由宿主注入 `ports`；缺省值只为"未注入时不至于报错"，与 `dedicatedPortFor` 同规则。
			const ports = ctx.ports?.() ?? { configuredPort: DEFAULT_CDP_PORT, dedicatedPort: DEFAULT_CDP_PORT + 1 };
			const client = getClient();

			// 已经在你自己的 Chrome 上了 ⇒ 不必打扰用户。
			const before = await client.status();
			if (before.ok && before.selfLaunched === false) {
				return mkText(ownChromeOutcomeText({ kind: 'connected', endpoint: before.endpoint }, ports));
			}

			if (args['confirmed'] !== true) {
				// 第一次调用：只出卡。`__clarify__` 协议见 `common/turnSignals.ts` 的允许名单注释。
				return mkText(JSON.stringify({
					__clarify__: true,
					question: ownChromeGuideQuestion({ configuredPort: ports.configuredPort }),
					options: [OWN_CHROME_CHOICE_RECHECK, OWN_CHROME_CHOICE_KEEP_DEDICATED, OWN_CHROME_CHOICE_CANCEL],
				}));
			}

			switch (interpretOwnChromeChoice(typeof args['choice'] === 'string' ? args['choice'] : undefined)) {
				case 'recheck': {
					await ctx.recheckEndpoint?.();
					// 重新取一次 status（走的是**新**连接）：`selfLaunched === false` 才算真的切过去了。
					const after = await client.status();
					return mkText(after.ok && after.selfLaunched === false
						? ownChromeOutcomeText({ kind: 'connected', endpoint: after.endpoint }, ports)
						: ownChromeOutcomeText({
							kind: 'not-found',
							detail: after.ok ? `这次连上的是专属实例（${after.endpoint}）` : after.error,
						}, ports));
				}
				case 'keep-dedicated':
					return mkText(ownChromeOutcomeText({ kind: 'keep-dedicated' }, ports));
				default:
					return mkText(ownChromeOutcomeText({ kind: 'cancelled' }, ports));
			}
		},
	});

	ctx.logService.info('[BuiltinTools] registerBrowserTools: navigate/snapshot/click/type/scroll/back/get_images/use_my_chrome registered (CDP backend)');
}
