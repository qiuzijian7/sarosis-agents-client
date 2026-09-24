/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Web Tools — web_search / web_extract。
 *
 * 从 builtinToolProvider.ts 的 _registerWebTools 抽出，降低主文件体积。
 * 沿用 codebaseTools.ts 的 Context 模式：通过 register() 注入主类，
 * 仅依赖 requestService / logService。
 */

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IRequestService, asText } from '../../../../../../platform/request/common/request.js';
import { IToolResultContent, NonRetryableToolError, ToolSecurityLevel } from '../../../common/providers.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IWebContentExtractorService } from '../../../../../../platform/webContentExtractor/common/webContentExtractor.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';
import {
	DEFAULT_WEB_SEARCH_CHAR_LIMIT,
	WEB_EXTRACT_CHAR_LIMIT,
	classifyExtractQuality,
	extractHtmlTitleAndDescription,
	formatHttpErrorDetail,
	formatWebExtractResult,
	htmlToPlainText,
	isPermanentHttpStatus,
	permanentHttpErrorMessage,
	renderSearchResults,
	selectBetterExtract,
	webExtractBlockedMessage,
	webExtractIncompleteWarning,
	webExtractTruncationWarning,
	webSearchTruncationWarning,
} from './webSearchParse.js';
import {
	DEFAULT_WEB_SEARCH_CONFIG,
	WEB_SEARCH_AUTO,
	describeProviderSetupHint,
	getWebSearchProvider,
	resolveWebSearchChain,
} from './webSearchProviders.js';
import { formatCacheAge, webExtractCacheNotice } from './webPageCache.js';
import type { ICachedPage, IWebCacheLogger } from './webPageCache.js';
import { bucketLimit, searchMemoKey } from './webSearchMemo.js';
import type { WebSearchMemo } from './webSearchMemo.js';
import { binaryPayloadMessage, detectBinaryPayload, stripInlineBase64 } from './webContentGuards.js';
import { buildExtractExcerpt, spillMarkerWithPath, spillMarkerWithoutPath, webExtractSpillNotice } from './webExtractSpill.js';
import type { IWebSearchProviderConfig, IWebSearchProviderOutput } from './webSearchProviders.js';

/**
 * 本地页面缓存的窄接口（P2）。
 *
 * 只暴露 webTools 真正用到的两个动作，**不**把 `WebPageCache` 类本身引进来 ——
 * 这样单测/替换只需给两个函数，也让"缓存不可用"（未注入）成为一个自然状态。
 */
export interface IWebPageCacheLike extends IWebCacheLogger {
	get(url: string): ICachedPage | undefined;
	put(page: Omit<ICachedPage, 'cachedAt'>): void;
}

export interface WebToolContext {
	register(registration: IBuiltinToolRegistration): void;
	requestService: IRequestService;
	logService: ILogService;
	/**
	 * 可选：主进程网页内容提取服务（Electron 桌面，经 ProxyChannel 代理到主进程，
	 * 用 BrowserWindow 加载网页，无 renderer CORS 限制）。非 Electron 环境为
	 * NullWebContentExtractorService（extract 抛 'Not implemented'），此时回退 requestService。
	 */
	webContentExtractorService?: IWebContentExtractorService;
	/**
	 * 可选：读取 web_search 的多后端配置（P0-2）。缺省时用 DEFAULT_WEB_SEARCH_CONFIG
	 * ——即"仅 DuckDuckGo"，与加 provider 抽象之前的行为完全一致（未知环境不回归）。
	 */
	getWebSearchConfig?: () => IWebSearchProviderConfig;
	/**
	 * 可选：`web_extract` 的本地持久化页面缓存（P2）。缺省 = 不缓存
	 * （web/测试等未知环境行为不变）。
	 *
	 * 用 getter（而非值）与 `getWebSearchConfig` 同理：用户在设置里开关缓存应当**下一轮
	 * 立即生效**，不需要重启窗口。
	 */
	getWebCache?: () => IWebPageCacheLike | undefined;
	/**
	 * 可选：`web_search` 的**结果备忘**（内存 + TTL + 单飞）。缺省 = 不缓存（行为回到加它之前）。
	 *
	 * 与 `getWebCache` 同一形态（getter + 可缺省），但语义不同：这是**进程内、短 TTL（20 分钟）**
	 * 的搜索结果备忘，不是跨会话的页面正文缓存 —— 区别与理由见 `webSearchMemo.ts` 文件头。
	 */
	getSearchMemo?: () => WebSearchMemo | undefined;
	/**
	 * 可选：把**超限正文**落盘并返回绝对路径（IO 由主类提供，见 `builtinToolProvider._writeExtractSpill`）。
	 *
	 * 缺省、或返回 undefined（IO 失败/无权限）⇒ 退化为纯截断（行为回到加它之前）。
	 * 落盘目标必须是沙箱允许根（`~/.vssaros/tmp/`），否则模型后续 `file_read` 会撞越界确认卡 ——
	 * 理由与既有两份落盘实现见 `webExtractSpill.ts` 文件头。
	 */
	writeExtractSpill?: (content: string) => Promise<string | undefined>;
}

// 纯逻辑（HTML 解析 / 结果渲染 / 截断告警 / 提取格式化）在 webSearchParse.ts，
// 无 VS Code 依赖，可独立单测（test/browser/webSearchParse.test.ts）。

// ── web_search：可插拔的多后端检索（P0-2，2026-09-24）────────────────────────
//
// 历史：此前只有 DuckDuckGo 一族（html→lite + Instant Answer 并行）。
//
// 现方案（**语义不变，后端可插拔**）：
//   • provider 链由 `resolveWebSearchChain` 决定 —— `auto` 时「已配置的托管后端
//     （tavily → exa → brave → searxng）→ 末尾永远 DuckDuckGo 兜底」；显式指定则只用
//     那一项（不静默换家，缺配置以明确报错暴露）。
//   • 链是**按序短路**的：前一个返回非空就停，不会让多份 API 同时计费。
//   • 降级纪律（沿用）：某一环失败只记 stageErrors 并继续；**所有**尝试的后端都失败
//     才抛错（触发执行器失败熔断，避免 subagent 死循环）；可达但无结果按正常
//     "无结果"返回，不熔断 —— 这两种情形必须区分，否则要么死循环、要么静默失败。
//   • provider 实现 + 响应解析在 webSearchProviders.ts（无 VS Code 依赖，可单测）。
//
// 对比 void 项目：void 无内置 web search（全靠用户自配 MCP server），无可借鉴的
// provider 机制，此为自研方案。与 MCP 检索服务器的关系：内置 provider 优先（同进程、
// 无子进程开销），MCP 仍可由用户自配作为扩展 —— 工具名与 schema 都没变，互不冲突。

/** 浏览器 UA：DDG HTML/lite 端点会拦截默认 node UA（返回异常页或空结果）；对 API 端点亦安全。 */
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 主进程 webFetch 通道结果契约（与 app.ts vscode:webFetch handler 同步）。 */
interface IWebFetchResult {
	ok: boolean;
	status: number;
	statusText: string;
	body: string;
}

/**
 * 统一取回实现 —— provider 拿到的 `IWebFetchLike` 由此提供。
 *
 * 优先走主进程 IPC `vscode:webFetch`（Chromium net.fetch，无 CORS 限制）：renderer 的
 * requestService 底层是浏览器 fetch()，受 `vscode-file://vscode-app` origin 的 CORS 限制
 * （DDG 已拒绝该 origin，托管 API 亦常拒绝自定义 scheme）。子代理在 renderer 进程同样
 * 受此限制。**通道本身**不可用时（纯 web 环境 / 无 channel / 已 dispose）才回退 requestService。
 *
 * ⚠ 与旧 `_fetchWithBrowserUA` 的一处刻意差异：IPC **返回 HTTP 4xx/5xx** 时直接抛
 * `HTTP <code>`，**不再**回退 renderer。旧实现把 HTTP 错误也当成"通道不可用"从而回退，
 * 后果是 ①托管 API 的 401（key 错）会被降级成 renderer 的 CORS 报错，根因被掩盖；
 * ②同一次请求白跑两遍。现在只有"通道不可用"才回退。
 *
 * 契约（provider 依赖，勿改）：HTTP >= 400 抛错；成功返回 `{ status, statusText, body }`。
 */
async function _webFetch(ctx: WebToolContext, url: string, init?: {
	method?: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
	callSite?: string;
}): Promise<{ status: number; statusText: string; body: string }> {
	const method = init?.method ?? 'GET';
	const headers = {
		'User-Agent': BROWSER_USER_AGENT,
		'Accept': 'text/html,application/xhtml+xml',
		...(init?.headers ?? {}),
	};

	// 优先：主进程 net.fetch（Chromium 网络栈，无 CORS）
	const vscodeBridge = (globalThis as any).vscode;
	if (vscodeBridge?.ipcRenderer?.invoke) {
		let result: IWebFetchResult | undefined;
		try {
			result = await vscodeBridge.ipcRenderer.invoke('vscode:webFetch', {
				url,
				method,
				headers,
				...(init?.body !== undefined ? { body: init.body } : {}),
			}) as IWebFetchResult;
		} catch (ipcErr) {
			ctx.logService?.info?.(`[WebTools] _webFetch: vscode:webFetch channel unavailable, falling back to requestService: ${ipcErr}`);
		}
		if (result) {
			// HTTP 错误直接抛出（不回落 renderer）——见上方刻意差异说明。
			if (result.status >= 400) {
				throw new Error(`HTTP ${result.status} ${result.statusText}`);
			}
			ctx.logService?.info?.(`[WebTools] _webFetch(main-process net.fetch): ${method} ${url} → ${result.body.length} bytes`);
			return { status: result.status, statusText: result.statusText, body: result.body.slice(0, 1024 * 1024) };
		}
	}

	// 回退：renderer requestService（浏览器 fetch，受 CORS 限制）
	const c = await ctx.requestService.request(
		{
			url,
			type: method,
			timeout: 20_000,
			headers,
			...(init?.body !== undefined ? { data: init.body } : {}),
			callSite: init?.callSite ?? 'saros.builtinTool.web_search',
		},
		CancellationToken.None,
	);
	// requestService 对 4xx/5xx 不 reject（只跟 3xx、网络错误才 reject），必须显式查状态码
	// ——否则错误页 HTML 会被当正常结果解析（解析出 0 条，掩盖真实的 403/429）。
	const statusCode = (c.res as { statusCode?: number }).statusCode;
	if (statusCode !== undefined && statusCode >= 400) {
		throw new Error(`HTTP ${statusCode}`);
	}
	const body = await asText(c) ?? '';
	return { status: statusCode ?? 200, statusText: '', body: body.slice(0, 1024 * 1024) }; // 1MB cap
}

/**
 * 经主进程抓取网页并提取 reader-mode 主内容。
 * - 主进程默认不 follow 跨域 redirect：按目标地址再抓一次（仍走主进程，最多一次）。
 * - 抓取失败（error status）抛错，让执行器判定 success=false 以触发失败熔断
 *   （避免 subagent 对不可用抓取反复重试死循环）。
 * @returns 提取的正文文本；extractor 不可用时由调用方捕获后回退 renderer。
 */
async function _extractViaMainProcess(
	extractor: IWebContentExtractorService,
	url: string,
	logService: ILogService,
): Promise<{ text: string; title?: string }> {
	// ⚠ 返回**原始**正文 + 标题，不做质量分类与格式化：调用方要先据质量决定"是否升级到
	// 原始 HTML 路径"，再决定怎么格式化。输出契约（name=标题/description=URL/content=正文
	// +截断告警）在 webSearchParse.ts 的 formatWebExtractResult（可单测）。
	let result = (await extractor.extract([URI.parse(url)]))[0];
	if (result.status === 'redirect') {
		logService?.info?.(`[WebTools] web_extract redirect → ${result.toURI.toString(true)}，按目标重抓`);
		result = (await extractor.extract([result.toURI]))[0];
	}
	if (result.status === 'ok' && result.result) {
		logService?.info?.(`[WebTools] web_extract(main-process reader-mode): ${url} → ${result.result.length} chars`);
		return { text: result.result, title: result.title };
	}
	if (result.status === 'error') {
		// 4xx（除 408/429）是永久性错误（页面不存在/无权限不会因重试改变）→
		// NonRetryableToolError：toolExecutor 标 retryable=false，runWithRetry 不重试。
		// permanentHttpErrorMessage 附 LLM 引导（"不要重试该 URL"，防模型幻觉 URL 重试）。
		if (isPermanentHttpStatus(result.statusCode)) {
			throw new NonRetryableToolError(`Web extract failed: ${permanentHttpErrorMessage(result.error, result.statusCode)}`);
		}
		// formatHttpErrorDetail 去重状态码（上游 error 常已含 "404"，不再追加 "(HTTP 404)"）。
		throw new Error(`Web extract failed: ${formatHttpErrorDetail(result.error, result.statusCode)}`);
	}
	throw new Error(`Web extract failed: unable to load ${url}`);
}

/**
 * 原始 HTML 路径的输出格式化。
 *
 * 保留 `<title>` 与 meta description —— 这是 renderer 回退路径的既有输出形状（抽出成
 * 函数后，**主进程升级路径**与**缓存命中路径**复用同一份，三条路径口径一致）。
 *
 * 只接 `head`（标题/描述）而不接原始 HTML：缓存里只存这两个字段，命中时无法重新解析 HTML。
 */
function _formatRawExtract(url: string, head: { title: string; description: string }, text: string): string {
	const parts: string[] = [`# ${head.title || url}`, '', `URL: ${url}`];
	if (head.description) { parts.push(`**Description**: ${head.description}`); }
	const truncated = text.length > WEB_EXTRACT_CHAR_LIMIT;
	parts.push('', truncated ? text.slice(0, WEB_EXTRACT_CHAR_LIMIT) : text);
	return parts.join('\n') + (truncated ? webExtractTruncationWarning(url) : '');
}

/**
 * 一次提取的产物。
 *
 * `cacheable` 的用途见 `_cacheIfPossible`：`blocked` 时**刻意**为 undefined ——
 * 拦截态不入缓存（拦截是瞬态的，缓存它等于把一次偶发拦截固化 24 小时）。
 */
interface IExtractOutcome {
	readonly formatted: string;
	readonly cacheable?: { title: string; description: string; text: string; source: string };
}

/**
 * reader-mode 结果的处置：分类 → 必要时**信号驱动升级**到原始 HTML → 择优 → 格式化。
 *
 * 升级依据是**可观测信号**（长度 / 命中拦截特征），不是域名猜测 —— 所以同一站点的内容页
 * 不会被牵连；且只在 suspect 时多花一次抓取，happy path（verdict === 'ok'）零额外开销。
 *
 * 为什么两条路都要：reader-mode 走 CDP 可访问性树，**看不到** `noscript` 正文与未进入
 * a11y 树的节点；而原始 HTML（无 JS）**看不到**客户端渲染出来的正文。两者盲区互补，
 * 所以取更可用者而不是简单替换。
 *
 * 处置口径（与 web_search 同一条纪律：网络层失败才熔断，可达但内容不可用返回标签化结果）：
 *   • `blocked` → 返回标签化失败（拦截页文本一律不外传），**不抛错**，且不入缓存；
 *   • `thin`    → 照常返回内容 + 显式"可能不完整"告警（内容是真的，入缓存）；
 *   • `ok`      → 原样返回并入缓存。
 */
async function _extractFromMainResult(
	ctx: WebToolContext,
	url: string,
	main: { text: string; title?: string },
): Promise<IExtractOutcome> {
	const quality = classifyExtractQuality(main.text, main.title);
	ctx.logService?.info?.(`[WebTools] web_extract(reader-mode): ${url} → ${quality.length} chars, verdict=${quality.verdict}${quality.signals.length ? ` (${quality.signals.join(', ')})` : ''}`);

	if (quality.verdict === 'ok') {
		return {
			formatted: formatWebExtractResult(url, main.title, main.text),
			cacheable: { title: main.title ?? '', description: '', text: main.text, source: 'reader-mode' },
		};
	}

	let rawHtml: string | undefined;
	let rawText = '';
	try {
		const raw = await _webFetch(ctx, url, { callSite: 'saros.builtinTool.web_extract.escalate' });
		rawHtml = raw.body;
		rawText = htmlToPlainText(raw.body);
	} catch (err) {
		// 升级抓取失败**不影响**主结果：退回对 reader-mode 结果做 suspect 处置。
		ctx.logService?.warn?.(`[WebTools] web_extract escalation fetch failed, using reader-mode result: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (rawHtml === undefined) {
		if (quality.verdict === 'blocked') {
			return { formatted: webExtractBlockedMessage(url, quality) };
		}
		return {
			formatted: formatWebExtractResult(url, main.title, main.text) + webExtractIncompleteWarning(url, quality),
			cacheable: { title: main.title ?? '', description: '', text: main.text, source: 'reader-mode' },
		};
	}

	const rawHead = extractHtmlTitleAndDescription(rawHtml);
	const selection = selectBetterExtract(
		{ text: main.text, title: main.title, source: 'reader-mode' },
		{ text: rawText, source: 'raw-html' },
	);
	ctx.logService?.info?.(
		`[WebTools] web_extract escalate: reader-mode=${quality.verdict}, raw-html=${selection.chosenQuality.verdict}` +
		` → chose ${selection.chosen.source} (${selection.chosenQuality.verdict}, ${selection.chosenQuality.length} chars)`
	);

	if (selection.chosenQuality.verdict === 'blocked') {
		return { formatted: webExtractBlockedMessage(url, selection.chosenQuality) };
	}

	const useRaw = selection.chosen.source === 'raw-html';
	const head = useRaw ? rawHead : { title: main.title ?? '', description: '' };
	const formatted = useRaw
		? _formatRawExtract(url, head, selection.chosen.text)
		: formatWebExtractResult(url, main.title, selection.chosen.text);
	return {
		formatted: selection.chosenQuality.verdict === 'thin'
			? formatted + webExtractIncompleteWarning(url, selection.chosenQuality)
			: formatted,
		cacheable: { title: head.title, description: head.description, text: selection.chosen.text, source: selection.chosen.source },
	};
}

/**
 * 超限正文的**落盘 + 内联片段装配**（主进程路径与原始 HTML 回退路径共用）。
 *
 * 顺序是刻意的：**先落盘拿到路径，再造省略标记** —— 标记里必须自带路径，因为被缓存进
 * `webPageCache` 的正是这段内联片段，而缓存命中时不会再发那条"全文已保存"的通知
 * （否则模型会看到"说有文件、却找不到路径"，比不提示更糟）。理由详见 `webExtractSpill.ts`。
 *
 * 落盘不可用时退化为纯截断：`notice` 为空、标记如实说明"没能保存"。
 */
async function _spillAndExcerpt(
	ctx: WebToolContext,
	url: string,
	fullText: string,
): Promise<{ excerpt: string; notice: string }> {
	if (fullText.length <= WEB_EXTRACT_CHAR_LIMIT) {
		return { excerpt: fullText, notice: '' };
	}
	const path = await ctx.writeExtractSpill?.(fullText);
	const marker = path
		? spillMarkerWithPath(path)
		: spillMarkerWithoutPath('no writable spill location in this environment');
	const { inlineExcerpt } = buildExtractExcerpt(fullText, WEB_EXTRACT_CHAR_LIMIT, marker);
	if (!path) {
		ctx.logService?.warn?.(`[WebTools] web_extract: over budget (${fullText.length} chars) and spill unavailable — degrading to plain truncation`);
		return { excerpt: inlineExcerpt, notice: '' };
	}
	ctx.logService?.info?.(`[WebTools] web_extract: over budget (${fullText.length} chars) → full text spilled to ${path}`);
	return { excerpt: inlineExcerpt, notice: webExtractSpillNotice(path, fullText.length, url) };
}

/**
 * 入库文本的上限 = 输出上限 + 1。
 *
 * **+1 是刻意的**（2026-09-21 加的）：格式化层（`formatWebExtractResult` / `_formatRawExtract`）
 * 用 `text.length > WEB_EXTRACT_CHAR_LIMIT` 判断要不要追加 "Truncation warning"。若把入库文本
 * 正好截到输出上限，命中缓存时该判断会变成 false ⇒ **截断告警消失**，模型会以为拿到了完整页面。
 *
 * 注（2026-09-24）：超限正文现在会先经 `_spillAndExcerpt` 变成「头+省略标记+尾」的内联片段
 * （长度 ≤ 上限，且标记自带落盘路径），走那条路时不再依赖这个 +1；此上限仍作为入库的兜底封顶。
 */
const CACHE_TEXT_CAP = WEB_EXTRACT_CHAR_LIMIT + 1;

/** 把成功产物写入本地缓存。写失败只记日志 —— 缓存是加速器，不是依赖。 */
function _cacheIfPossible(
	ctx: WebToolContext,
	url: string,
	outcome: IExtractOutcome,
	webCache: IWebPageCacheLike | undefined,
): void {
	if (!outcome.cacheable || !webCache) { return; }
	try {
		webCache.put({
			url,
			title: outcome.cacheable.title,
			description: outcome.cacheable.description,
			text: outcome.cacheable.text.slice(0, CACHE_TEXT_CAP),
			source: outcome.cacheable.source,
		});
	} catch (err) {
		ctx.logService?.warn?.(`[WebTools] web_extract cache write failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * 缓存命中的输出：**重跑**分类与格式化，再追加缓存标注。
 *
 * 为什么不直接存"格式化后的字符串"：那样后续改文案/改判定会被**缓存冻住**（旧条目
 * 按旧规则渲染，直到 TTL 过期），升级与回滚都会变得不可预测。存原始产物 + 命中时重算，
 * 保证"命中"与"刚抓取"走的是同一条渲染路径。
 */
function _formatCachedPage(url: string, page: ICachedPage, quality: ReturnType<typeof classifyExtractQuality>): string {
	const base = page.source === 'raw-html'
		? _formatRawExtract(url, { title: page.title, description: page.description }, page.text)
		: formatWebExtractResult(url, page.title, page.text);
	const warn = quality.verdict === 'thin' ? webExtractIncompleteWarning(url, quality) : '';
	return base + warn + webExtractCacheNotice(page.cachedAt, Date.now());
}

export function registerWebTools(ctx: WebToolContext): void {
	const mkText = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];
	const source = 'saros.builtin-tools';

	ctx.register({
		definition: {
			name: 'web_search',
			description: 'Search the web and return result titles, URLs, and snippets. Backed by a configurable provider chain (hosted search APIs / self-hosted SearXNG / keyless DuckDuckGo fallback), so no API key is required to use it. Use this tool sparingly — only for questions requiring specialized, external, or up-to-date knowledge (common programming questions usually do not). Use web_extract to read a specific result page in detail.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Search query' },
					max_results: { type: 'number', description: 'Maximum results (default: 5, max: 10)' },
				},
				required: ['query'],
			},
			category: 'web',
			source,
			securityLevel: ToolSecurityLevel.Safe,
		},
		handler: async (args, signal) => {
			const query = String(args['query'] ?? '').trim();
			if (!query) { throw new Error('query is required'); }
			const maxResults = Math.min(Math.max(Number(args['max_results'] ?? 5), 1), 10);

			const config = ctx.getWebSearchConfig?.() ?? DEFAULT_WEB_SEARCH_CONFIG;
			const chain = resolveWebSearchChain(config);

			// 显式指定某 provider 但它没配好 → 明确报错，**不**静默换家：否则用户会以为在用
			// 自己选的 API（且托管后端可能产生意料外的计费）。NonRetryable：重试不会变好。
			const explicit = (config.provider || '').trim();
			if (explicit && explicit !== WEB_SEARCH_AUTO) {
				const requested = getWebSearchProvider(explicit);
				if (!requested || !requested.isAvailable(config)) {
					throw new NonRetryableToolError(`Web search provider "${explicit}" is not usable — ${describeProviderSetupHint(explicit)}.`);
				}
			}

			const stageErrors: string[] = [];
			let output: IWebSearchProviderOutput | undefined;
			const memo = ctx.getSearchMemo?.();
			// 按**桶**去取（见 webSearchMemo 的 ②）：max_results=3 与 5 共享同一份结果，渲染时再切到
			// 用户要的条数 —— "取了 10 条只显示 3 条"是刻意的，换来的是一份能服务整个桶的结果。
			const fetchCount = bucketLimit(maxResults);

			// 按序**短路**：命中即停（不让多份 API 同时计费）。
			for (const id of chain) {
				const provider = getWebSearchProvider(id);
				if (!provider) {
					stageErrors.push(`${id}: unknown provider`);
					continue;
				}
				// callSite 带 provider id：请求遥测里能区分是哪一个后端发出的。
				const fetchFn = (url: string, init?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }) =>
					_webFetch(ctx, url, { ...init, callSite: `saros.builtinTool.web_search.${id}` });
				const memoKey = searchMemoKey(id, query, maxResults);
				const memoHit = memo?.get(memoKey);
				try {
					let out: IWebSearchProviderOutput;
					if (memoHit) {
						out = memoHit;
						ctx.logService?.info?.(`[WebTools] web_search memo hit: ${id} q="${query}"`);
					} else {
						// 备忘键**含 provider** ⇒ 降级到 DDG 的那次只以 ddg 为键落库，下一轮链路仍会**先试主后端**
						// —— 所以不需要 Hermes 那条"被 rescue 的响应不入缓存"的额外规则（键的构造已排除该形态）。
						const load = () => provider.search(query, fetchCount, config, fetchFn);
						out = memo ? await memo.getOrLoad(memoKey, load) : await load();
					}
					if (out.answer || out.results.length > 0) {
						output = out;
						ctx.logService?.info?.(`[WebTools] web_search via ${id} → ${out.results.length} results${out.answer ? ' + instant answer' : ''}${out.errors?.length ? ` (degraded: ${out.errors.join('; ')})` : ''}`);
						break;
					}
					// 可达但无结果 → 记日志继续下一环（**不是**故障，不进 stageErrors ⇒ 不熔断）。
					ctx.logService?.info?.(`[WebTools] web_search via ${id} → 0 results, trying next provider`);
					for (const e of out.errors ?? []) { stageErrors.push(`${id}: ${e}`); }
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					stageErrors.push(`${id}: ${msg}`);
					ctx.logService?.warn?.(`[WebTools] web_search via ${id} failed: ${msg}`);
				}
			}

			if (output) {
				// 组装，对齐 Continue `searchWebImpl` 契约：每条结果作为独立块
				// （name=标题, description=URL, content=摘要），content 超过 8000 截断，
				// 并追加 "Truncation warning" 说明哪些被截断。
				const sections: string[] = [`## Web Search Results for: "${query}"`, ''];
				if (output.answer) {
					sections.push(`**Instant Answer**${output.answer.source ? ` (source: ${output.answer.source})` : ''}:`);
					sections.push(output.answer.text);
					if (output.answer.url) { sections.push(`More info: ${output.answer.url}`); }
					sections.push('', '---', '');
				}
				if (output.results.length > 0) {
					const rendered = renderSearchResults(output.results, maxResults, DEFAULT_WEB_SEARCH_CHAR_LIMIT);
					sections.push(...rendered.blocks);
					if (rendered.truncated.length > 0) {
						sections.push('**Truncation warning**', '', webSearchTruncationWarning(rendered.truncated), '');
					}
				}
				return mkText(sections.join('\n'));
			}

			// 链上每一环都**网络/协议失败** → 抛错触发失败熔断（避免 subagent 反复重试死循环）。
			if (stageErrors.length > 0) {
				throw new Error(`Web search failed (all providers: ${chain.join(' → ')}): ${stageErrors.join('; ')}`);
			}
			// 每一环都可达但均无结果 → 正常返回"无结果"（非网络故障，不熔断）。
			return mkText(`No search results found for "${query}". Try a different query or use web_extract if you have a specific URL.`);
		},
	});

	ctx.register({
		definition: {
			name: 'web_extract',
			description: 'View the contents of a web page given its URL: extracts the main readable text (with page title). Use after web_search to read a result page in detail. Do NOT use this for local files. Results may be served from a local page cache (cached output is labeled with its capture time) — pass refresh=true when you need the current version of a page that changes.',
			inputSchema: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'URL of the web page to extract content from' },
					refresh: { type: 'boolean', description: 'Bypass the local page cache and fetch the page again (default: false). Use when the page is likely to have changed since it was cached.' },
				},
				required: ['url'],
			},
			category: 'web',
			source,
			securityLevel: ToolSecurityLevel.Cautious,
		},
		handler: async (args, signal) => {
			const url = String(args['url'] ?? '').trim();
			if (!url) { throw new Error('url is required'); }
			if (!/^https?:\/\//i.test(url)) {
				throw new Error('url must start with http:// or https://');
			}
			const refresh = args['refresh'] === true;
			const webCache = ctx.getWebCache?.();

			// ── 本地持久页面缓存（P2）────────────────────────────────────────
			// 命中后**重跑**分类与格式化（不存格式化后的字符串），命中与刚抓取因此走同一条
			// 渲染路径 —— 详见 `_formatCachedPage`。`refresh: true` 跳过读取但仍然写回。
			if (!refresh && webCache) {
				const cached = webCache.get(url);
				if (cached) {
					// 本修复之前写入的缓存条目可能含着内联 base64 ⇒ 先剥离**再**分类：否则长度虚高，
					// 一份其实很薄的正文会被判成正常（classifyExtractQuality 看的正是长度与信号）。
					const cachedText = stripInlineBase64(cached.text).text;
					const entry = cachedText === cached.text ? cached : { ...cached, text: cachedText };
					const cachedQuality = classifyExtractQuality(entry.text, entry.title);
					if (cachedQuality.verdict !== 'blocked') {
						ctx.logService?.info?.(`[WebTools] web_extract cache hit: ${url} (age ${formatCacheAge(Date.now() - entry.cachedAt)}, ${cachedQuality.length} chars)`);
						return mkText(_formatCachedPage(url, entry, cachedQuality));
					}
					// 拦截态**不**从缓存服务：拦截是瞬态的（Cloudflare 放行后同一 URL 就有正文），
					// 用它当结果等于把一次偶发拦截固化 24 小时。
					ctx.logService?.info?.(`[WebTools] web_extract cached entry looks like an interstitial — bypassing cache, refetching ${url}`);
				}
			}

			// 优先：主进程抓取（Electron 桌面）。platform IWebContentExtractorService 在
			// 主进程用 BrowserWindow + CDP 可访问性树加载网页并提取 reader-mode 主内容，
			// 无 renderer CORS 限制（修复 renderer window.fetch 抓跨域网页被 CORS 拦截
			// → "Failed to fetch"）。
			const extractor = ctx.webContentExtractorService;
			if (extractor) {
				let main: { text: string; title?: string } | undefined;
				try {
					main = await _extractViaMainProcess(extractor, url, ctx.logService);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					// 主进程通道不可用（web/无 channel）时静默回退 renderer；
					// 真实抓取失败（HTTP 错误/加载失败）则抛错触发失败熔断。
					if (!/not implemented|invalid call|no channel|disposed/i.test(msg)) {
						ctx.logService?.warn?.(`[WebTools] web_extract failed: ${msg}`);
						// 直接 rethrow：_extractViaMainProcess 的错误已含完整 "Web extract failed: ..."
						// 前缀（含 NonRetryable 标记），不再包一层（避免双重嵌套 + 丢标记）。
						throw err;
					}
					ctx.logService?.info?.(`[WebTools] web_extract main-process path unavailable, fallback to renderer: ${msg}`);
				}

				if (main) {
					// ① 内联 base64 换成占位符：reader-mode 的输出里也可能带 data-URI 图，否则字符预算
					//    会被几 MB 的 base64 吃掉，**正文反而被截掉**（见 webContentGuards 文件头）。
					const stripped = stripInlineBase64(main.text);
					if (stripped.replaced > 0) {
						ctx.logService?.info?.(`[WebTools] web_extract stripped ${stripped.replaced} inline base64 payload(s) from ${url} (−${stripped.removedChars} chars)`);
					}
					// ② 二进制载荷：标签化失败，绝不把字节流当正文外传。
					const binaryKind = detectBinaryPayload(stripped.text);
					if (binaryKind) {
						ctx.logService?.info?.(`[WebTools] web_extract refused binary payload: ${url} → ${binaryKind}`);
						return mkText(binaryPayloadMessage(url, binaryKind, stripped.text.length));
					}
					// ③ 超限则落盘 + 换成「头+标记+尾」的内联片段（P1）：长页的关键结论常在尾部，
					//    而硬截断会把它永久丢掉、逼模型重抓。落盘不可用时自动退化为纯截断。
					const { excerpt, notice } = await _spillAndExcerpt(ctx, url, stripped.text);
					const outcome = await _extractFromMainResult(ctx, url, { ...main, text: excerpt });
					_cacheIfPossible(ctx, url, outcome, webCache);
					return mkText(outcome.formatted + notice);
				}
			}

			// 回退：原始 HTML（`_webFetch` 内部主进程 net.fetch 优先，无 CORS；通道不可用才用
			// requestService）。原先此处直接调 requestService，统一到 `_webFetch` 后顺带拿到了
			// 主进程路径与"HTTP >= 400 抛错"的显式状态码检查。
			try {
				const raw = await _webFetch(ctx, url, { callSite: 'saros.builtinTool.web_extract' });
				// ① 二进制载荷（PDF/zip/SQLite/…）：标签化失败。**必须在 htmlToPlainText 之前** ——
				//    把字节流交给 HTML 解析器只会得到一堆乱码文本，然后被当作"页面内容"喂给模型。
				const binaryKind = detectBinaryPayload(raw.body);
				if (binaryKind) {
					ctx.logService?.info?.(`[WebTools] web_extract refused binary payload: ${url} → ${binaryKind}`);
					return mkText(binaryPayloadMessage(url, binaryKind, raw.body.length));
				}
				// ② 内联 base64 同样在转文本前剥离（HTML 属性里的 data URI 动辄几 MB）。
				const strippedBody = stripInlineBase64(raw.body);
				if (strippedBody.replaced > 0) {
					ctx.logService?.info?.(`[WebTools] web_extract stripped ${strippedBody.replaced} inline base64 payload(s) from ${url} (−${strippedBody.removedChars} chars)`);
				}
				const text = htmlToPlainText(strippedBody.text);
				const quality = classifyExtractQuality(text);
				ctx.logService?.info?.(`[WebTools] web_extract(raw-html): ${url} → ${quality.length} chars, verdict=${quality.verdict}${quality.signals.length ? ` (${quality.signals.join(', ')})` : ''}`);
				if (quality.verdict === 'blocked') {
					// 标签化失败：拦截页自身的文本**一律不外传**（否则模型会基于挑战页内容作答）。
					// 同时**不入缓存** —— 拦截是瞬态的，缓存它会固化一次偶发拦截。
					return mkText(webExtractBlockedMessage(url, quality));
				}
				const head = extractHtmlTitleAndDescription(raw.body);
				// 分类用**全文**（verdict/thin 判定要基于真实长度），格式化用**内联片段**：
				// 超限时后者已含"完整正文在 <路径>"的标记，因此格式化层不会再追加截断告警。
				const { excerpt, notice } = await _spillAndExcerpt(ctx, url, text);
				let out = _formatRawExtract(url, head, excerpt);
				if (quality.verdict === 'thin') { out += webExtractIncompleteWarning(url, quality); }
				_cacheIfPossible(ctx, url, { formatted: out, cacheable: { title: head.title, description: head.description, text: excerpt, source: 'raw-html' } }, webCache);
				return mkText(out + notice);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.logService?.warn?.(`[WebTools] web_extract failed: ${msg}`);
			// `_webFetch` 对 >=400 抛 "HTTP <code>"：4xx（除 408/429）是永久性错误 → 升级为
			// NonRetryableToolError 并附 LLM 引导（与主进程路径同一口径；原先由本处直接读
			// statusCode 完成，现在状态码被封装进消息，故在此还原语义）。
			const httpMatch = /^HTTP (\d{3})\b/.exec(msg);
			if (httpMatch) {
				const code = Number(httpMatch[1]);
				if (isPermanentHttpStatus(code)) {
					throw new NonRetryableToolError(`Web extract failed: ${permanentHttpErrorMessage(`HTTP error ${code}`, code)}`);
				}
				throw new Error(`Web extract failed: HTTP error ${code}`);
			}
			// 已带完整前缀/标记的错误（NonRetryableToolError 等）直接 rethrow：
			// 避免 "Web extract failed: Web extract failed: ..." 双重嵌套 + 丢失不可重试标记。
			if (err instanceof NonRetryableToolError || msg.startsWith('Web extract failed:')) {
				throw err;
			}
			// 同 web_search：网络层失败（CORS 拦截 / 超时）抛错以触发失败熔断，
			// 避免 subagent 对同一不可用抓取反复重试（死循环）。
			throw new Error(`Web extract failed: ${msg}`);
		}
		},
	});

	ctx.logService.info('[BuiltinTools] registerWebTools: web_search (provider chain, DDG keyless fallback) + web_extract (main-process reader-mode + signal-driven escalation) registered');
}
