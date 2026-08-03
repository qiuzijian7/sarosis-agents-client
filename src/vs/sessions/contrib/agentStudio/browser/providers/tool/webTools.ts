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
	decodeHtmlEntities,
	formatHttpErrorDetail,
	formatWebExtractResult,
	isPermanentHttpStatus,
	permanentHttpErrorMessage,
	parseDuckDuckGoHtmlResults,
	parseDuckDuckGoLiteResults,
	renderSearchResults,
	stripHtmlTags,
	webExtractTruncationWarning,
	webSearchTruncationWarning,
} from './webSearchParse.js';
import type { IWebSearchResult } from './webSearchParse.js';

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
}

// 纯逻辑（HTML 解析 / 结果渲染 / 截断告警 / 提取格式化）在 webSearchParse.ts，
// 无 VS Code 依赖，可独立单测（test/browser/webSearchParse.test.ts）。

// ── web_search：DuckDuckGo 抓取（无需 API key）──────────────────────────────
//
// 设计背景：此前实现只用 api.duckduckgo.com 的 Instant Answer JSON API，而该 API
// 仅对**单实体名词**（"TypeScript"、"Albert Einstein"）返回百科直答，对自然语言
// 查询（"如何在 electron 中用 better-sqlite3"、甚至 "france capital"）一律返回空
// —— 这就是 web_search 频繁 "No results" 的根因。
//
// 现方案：
//   • 自然结果主路径 html.duckduckgo.com → 失败/空则降级 lite.duckduckgo.com。
//   • Instant Answer **并行**发起（命中率低但直答质量高），仅作补充头部；串行等待
//     会给绝大多数查询白白加一次 RTT。无自然结果时才用其站内消歧链接兜底。
//   • 三条来源全部网络失败才抛错（触发执行器失败熔断，避免 subagent 死循环）；
//     可达但无结果按正常"无结果"返回，不熔断。
//
// 对比 void 项目：void 无内置 web search（全靠用户自配 MCP server），无可借鉴的
// provider 机制，此为自研无 key 方案。

/** 浏览器 UA：DDG HTML/lite 端点会拦截默认 node UA（返回异常页或空结果）。 */
const DDG_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 主进程 webFetch 通道结果契约（与 app.ts vscode:webFetch handler 同步）。 */
interface IWebFetchResult {
	ok: boolean;
	status: number;
	statusText: string;
	body: string;
}

/**
 * 取回 DDG HTML 页面。
 *
 * 优先走主进程 IPC `vscode:webFetch`（Chromium net.fetch，无 CORS 限制）：
 * renderer 的 requestService 底层是浏览器 fetch()，受 vscode-file://vscode-app
 * origin 的 CORS 限制（DDG 已拒绝此 origin）。子代理在 renderer 进程同样受此限制。
 * 主进程路径不可用时（如纯 web 环境）回退到 requestService。
 */
async function _fetchWithBrowserUA(ctx: WebToolContext, url: string, callSite: string): Promise<string> {
	// 优先：主进程 net.fetch（Chromium 网络栈，无 CORS）
	const vscodeBridge = (globalThis as any).vscode;
	if (vscodeBridge?.ipcRenderer?.invoke) {
		try {
			const result = await vscodeBridge.ipcRenderer.invoke('vscode:webFetch', {
				url,
				headers: {
					'User-Agent': DDG_USER_AGENT,
					'Accept': 'text/html,application/xhtml+xml',
				},
			}) as IWebFetchResult;
			if (result.status >= 400) {
				throw new Error(`HTTP ${result.status} ${result.statusText}`);
			}
			ctx.logService?.info?.(`[WebTools] _fetchWithBrowserUA(main-process net.fetch): ${url} → ${result.body.length} bytes`);
			return result.body.slice(0, 1024 * 1024);
		} catch (ipcErr) {
			ctx.logService?.info?.(`[WebTools] _fetchWithBrowserUA: vscode:webFetch failed, falling back to requestService: ${ipcErr}`);
		}
	}
	// 回退：renderer requestService（浏览器 fetch，受 CORS 限制）
	const c = await ctx.requestService.request(
		{
			url,
			type: 'GET',
			timeout: 20_000,
			headers: {
				'User-Agent': DDG_USER_AGENT,
				'Accept': 'text/html,application/xhtml+xml',
			},
			callSite,
		},
		CancellationToken.None,
	);
	const body = await asText(c) ?? '';
	return body.slice(0, 1024 * 1024); // 1MB cap
}

interface IInstantAnswer {
	abstract: string;
	abstractSource: string;
	abstractURL: string;
	/** Results / RelatedTopics —— 多为 DDG 站内消歧链接，仅在无自然结果时兜底使用。 */
	topics: IWebSearchResult[];
}

/**
 * Instant Answer JSON API：只对**单实体名词**（"TypeScript"、"Albert Einstein"）返回
 * 百科式直答，对自然语言查询（"如何在 electron 中用 better-sqlite3"、"france capital"）
 * 一律返回空 —— 所以它只能作为自然结果的**补充**，不能当作主检索路径。
 *
 * @returns null 表示无任何可呈现内容。
 */
async function _fetchInstantAnswer(ctx: WebToolContext, query: string): Promise<IInstantAnswer | null> {
	const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
	const c = await ctx.requestService.request(
		{ url: apiUrl, type: 'GET', callSite: 'saros.builtinTool.web_search.instant' },
		CancellationToken.None,
	);
	const body = await asText(c) ?? '';
	const data = JSON.parse(body.slice(0, 512 * 1024)) as Record<string, unknown>;

	const abstract = typeof data.AbstractText === 'string' ? data.AbstractText.trim() : '';
	const topics: IWebSearchResult[] = [];
	const rawResults = Array.isArray(data.Results) ? data.Results as Array<Record<string, unknown>> : [];
	const relatedTopics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics as Array<Record<string, unknown>> : [];
	for (const r of (rawResults.length > 0 ? rawResults : relatedTopics)) {
		const title = typeof r.Text === 'string' ? r.Text : '';
		const url = typeof r.FirstURL === 'string' ? r.FirstURL : '';
		if (title && url) { topics.push({ title, url, snippet: '' }); }
	}

	if (!abstract && topics.length === 0) { return null; }
	return {
		abstract,
		abstractSource: typeof data.AbstractSource === 'string' ? data.AbstractSource : '',
		abstractURL: typeof data.AbstractURL === 'string' ? data.AbstractURL : '',
		topics,
	};
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
): Promise<string> {
	// 输出契约（name=标题/description=URL/content=正文+截断告警）在
	// webSearchParse.ts 的 formatWebExtractResult（可单测）。
	let result = (await extractor.extract([URI.parse(url)]))[0];
	if (result.status === 'redirect') {
		logService?.info?.(`[WebTools] web_extract redirect → ${result.toURI.toString(true)}，按目标重抓`);
		result = (await extractor.extract([result.toURI]))[0];
	}
	if (result.status === 'ok' && result.result) {
		logService?.info?.(`[WebTools] web_extract(main-process): ${url} → ${result.result.length} chars`);
		return formatWebExtractResult(url, result.title, result.result);
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

export function registerWebTools(ctx: WebToolContext): void {
	const mkText = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];
	const source = 'saros.builtin-tools';

	ctx.register({
		definition: {
			name: 'web_search',
			description: 'Search the web using DuckDuckGo (organic web results + instant answers, no API key required). Returns result titles, URLs, and snippets. Use this tool sparingly — only for questions requiring specialized, external, or up-to-date knowledge (common programming questions usually do not). Use web_extract to read a specific result page in detail.',
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

			const stageErrors: string[] = [];

			// Instant Answer 与自然结果**并行**发起：前者只对单实体名词命中（命中率低但
			// 直答质量高），串行等待会给绝大多数查询白白增加一次 RTT。
			const instantPromise = _fetchInstantAnswer(ctx, query).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				stageErrors.push(`instant-answer: ${msg}`);
				ctx.logService?.info?.(`[WebTools] web_search instant-answer failed (non-fatal): ${msg}`);
				return null;
			});

			// 自然结果主路径：html.duckduckgo.com，失败或空则降级 lite.duckduckgo.com。
			let organic: IWebSearchResult[] = [];
			try {
				const html = await _fetchWithBrowserUA(ctx, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 'saros.builtinTool.web_search.html');
				organic = parseDuckDuckGoHtmlResults(html);
				ctx.logService?.info?.(`[WebTools] web_search ddg-html → ${organic.length} results`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				stageErrors.push(`ddg-html: ${msg}`);
				ctx.logService?.info?.(`[WebTools] web_search ddg-html failed, falling back to lite: ${msg}`);
			}
			if (organic.length === 0) {
				try {
					const lite = await _fetchWithBrowserUA(ctx, `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, 'saros.builtinTool.web_search.lite');
					organic = parseDuckDuckGoLiteResults(lite);
					ctx.logService?.info?.(`[WebTools] web_search ddg-lite → ${organic.length} results`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					stageErrors.push(`ddg-lite: ${msg}`);
					ctx.logService?.warn?.(`[WebTools] web_search ddg-lite failed: ${msg}`);
				}
			}

			const instant = await instantPromise;

			// 组装，对齐 Continue `searchWebImpl` 契约：每条结果作为独立块
			// （name=标题, description=URL, content=摘要），content 超过 8000 截断，
			// 并追加 "Truncation warning" 说明哪些被截断。
			const sections: string[] = [`## Web Search Results for: "${query}"`, ''];
			if (instant?.abstract) {
				sections.push(`**Instant Answer**${instant.abstractSource ? ` (source: ${instant.abstractSource})` : ''}:`);
				sections.push(instant.abstract);
				if (instant.abstractURL) { sections.push(`More info: ${instant.abstractURL}`); }
				sections.push('', '---', '');
			}

			// 自然结果为主体；无自然结果时用 Instant Answer 站内消歧链接兜底。
			const results: IWebSearchResult[] = organic.length > 0 ? organic : (instant?.topics ?? []);
			if (results.length > 0) {
				const rendered = renderSearchResults(results, maxResults, DEFAULT_WEB_SEARCH_CHAR_LIMIT);
				sections.push(...rendered.blocks);
				if (rendered.truncated.length > 0) {
					sections.push('**Truncation warning**', '', webSearchTruncationWarning(rendered.truncated), '');
				}
			}

			if (instant?.abstract || organic.length > 0 || instant?.topics.length) {
				return mkText(sections.join('\n'));
			}

			// 三条来源全部网络失败 → 抛错触发失败熔断（避免 subagent 反复重试死循环）。
			if (stageErrors.length >= 3) {
				throw new Error(`Web search failed: ${stageErrors.join('; ')}`);
			}
			// 至少一条来源可达但均无结果 → 正常返回"无结果"（非网络故障，不熔断）。
			return mkText(`No search results found for "${query}". Try a different query or use web_extract if you have a specific URL.`);
		},
	});

	ctx.register({
		definition: {
			name: 'web_extract',
			description: 'View the contents of a web page given its URL: extracts the main readable text (with page title). Use after web_search to read a result page in detail. Do NOT use this for local files.',
			inputSchema: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'URL of the web page to extract content from' },
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

			// 优先：主进程抓取（Electron 桌面）。platform IWebContentExtractorService 在
			// 主进程用 BrowserWindow 加载网页并提取 reader-mode 主内容，无 renderer CORS 限制
			// （修复 renderer window.fetch 抓跨域网页被 CORS 拦截 → "Failed to fetch"）。
			const extractor = ctx.webContentExtractorService;
			if (extractor) {
				try {
					const fromMain = await _extractViaMainProcess(extractor, url, ctx.logService);
					return mkText(fromMain);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					// 主进程通道不可用（web/无 channel）时静默回退 renderer；
					// 真实抓取失败（HTTP 错误/加载失败）则抛错触发失败熔断。
					if (/not implemented|invalid call|no channel|disposed/i.test(msg)) {
						ctx.logService?.info?.(`[WebTools] web_extract main-process path unavailable, fallback to renderer: ${msg}`);
				} else {
					ctx.logService?.warn?.(`[WebTools] web_extract failed: ${msg}`);
					// 直接 rethrow：_extractViaMainProcess 的错误已含完整 "Web extract failed: ..." 前缀，
					// 不再包一层（避免 "Web extract failed: Web extract failed: ..." 双重嵌套）。
					throw err;
				}
				}
			}

			try {
				const c = await ctx.requestService.request(
					{
						url,
						type: 'GET',
						timeout: 30_000,
						callSite: 'saros.builtinTool.web_extract',
					},
					CancellationToken.None,
				);

				// requestService 对 4xx/5xx 不 reject（只跟 3xx、网络错误才 reject），
				// 必须显式查状态码——否则 404 错误页 HTML 会被当正文提取返回。
				const statusCode = (c.res as { statusCode?: number }).statusCode;
				if (statusCode !== undefined && statusCode >= 400) {
					if (isPermanentHttpStatus(statusCode)) {
						throw new NonRetryableToolError(`Web extract failed: ${permanentHttpErrorMessage(`HTTP error ${statusCode}`, statusCode)}`);
					}
					throw new Error(`Web extract failed: HTTP error ${statusCode}`);
				}

				const raw = await asText(c) ?? '';
				if (!raw) { return mkText(`No content returned from ${url}`); }

				const MAX_BODY = 512 * 1024; // 512KB
				const body = raw.slice(0, MAX_BODY);

				// ── 提取 title ──────────────────────────────────
				let title = '';
				const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
				if (titleMatch) {
					title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
				}

				// ── 提取 meta description ───────────────────────
				let description = '';
				const metaMatch =
					body.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ??
					body.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
				if (metaMatch) {
					description = metaMatch[1].trim();
				}

				// ── 提取正文（实体解码/去标签复用 webSearchParse 纯函数）──────
				let text = decodeHtmlEntities(
					stripHtmlTags(
						body
							.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
							.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
							.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ')
							.replace(/<[^>]+>/g, ' ')
					)
				).replace(/\s+/g, ' ').trim();

				// 与主进程路径同契约（对齐 Continue）：标题 + URL + 正文，
				// 正文超 20000 截断并追加 Truncation warning。
				const truncated = text.length > WEB_EXTRACT_CHAR_LIMIT;
				if (truncated) {
					text = text.slice(0, WEB_EXTRACT_CHAR_LIMIT);
				}

				const parts: string[] = [`# ${title || url}`, '', `URL: ${url}`];
				if (description) { parts.push(`**Description**: ${description}`); }
				parts.push('', text);

				return mkText(parts.join('\n') + (truncated ? webExtractTruncationWarning(url) : ''));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.logService?.warn?.(`[WebTools] web_extract failed: ${msg}`);
			// 已带完整前缀/标记的错误（状态码检查抛的 NonRetryableToolError 等）直接 rethrow：
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

	ctx.logService.info('[BuiltinTools] registerWebTools: web_search (DDG html→lite + parallel instant answer) + web_extract registered');
}
