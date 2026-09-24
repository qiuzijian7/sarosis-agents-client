/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `web_search` 的多后端 provider 抽象（P0-2，2026-09-24）。
 *
 * 背景：`web_search` 此前只有 DuckDuckGo 一族（html→lite + Instant Answer）。其**语义**
 * 是对的（按序短路、全失败才熔断、降级留痕），缺的是**可插拔的检索后端** —— 用户想用
 * 托管 API（Tavily / Brave / Exa）或自建 SearXNG 时无从接入，只能靠 MCP 另起一套路径，
 * 于是工具面里同时存在"内置搜索"与"MCP 搜索"两套互不知情的实现。
 *
 * 本模块**不含 VS Code 依赖**（对齐 webSearchParse.ts 的模式）——每个 provider 只依赖
 * 注入的 `IWebFetchLike`，因此可用假 fetch 喂固定响应独立单测（解析 + 链路选择）。
 *
 * 与 webTools.ts 的分工：
 *   • 本模块 —— provider 实现 + 链路解析 + 响应解析（纯逻辑）
 *   • webTools.ts —— 工具定义/handler + 真实 fetch（主进程 IPC 优先 / requestService
 *     回退）+ 输出渲染
 *
 * 与 MCP 路径的关系：内置 provider 优先（同进程、无子进程开销），MCP 检索服务器仍可
 * 由用户自配作为扩展 —— 两者不冲突，因为工具名与 schema 都没变。
 */

import {
	decodeHtmlEntities,
	parseDuckDuckGoHtmlResults,
	parseDuckDuckGoLiteResults,
	stripHtmlTags,
} from './webSearchParse.js';
import type { IWebSearchResult } from './webSearchParse.js';

// ─── 取回抽象 ────────────────────────────────────────────────────────────────

export interface IWebFetchInit {
	readonly method?: 'GET' | 'POST';
	readonly headers?: Record<string, string>;
	readonly body?: string;
	readonly callSite?: string;
}

/**
 * 统一取回函数（由 webTools.ts 注入）。
 *
 * 契约（provider 依赖它，勿改）：
 *   • **HTTP >= 400 必须抛错** —— 与 webSearchParse 的 `isPermanentHttpStatus` /
 *     `formatHttpErrorDetail` 配套；provider 里不需要再判状态码。
 *   • 成功时返回 `{ status, statusText, body }`，body 为文本。
 *   • 浏览器 UA 兜底与"主进程 IPC / 渲染进程 requestService"的路径选择由实现侧负责，
 *     provider 只管拼 URL、传 headers、解析 body。
 */
export interface IWebFetchLike {
	(url: string, init?: IWebFetchInit): Promise<{ status: number; statusText: string; body: string }>;
}

// ─── 配置 ────────────────────────────────────────────────────────────────────

/** `provider` 取该值 = 按"已配置项"自动成链（末尾永远有 keyless 兜底）。 */
export const WEB_SEARCH_AUTO = 'auto';

/** 可选 provider 的展示顺序（设置 UI 用）。`auto` 由设置项自身补上。 */
export const WEB_SEARCH_PROVIDER_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
	{ value: WEB_SEARCH_AUTO, label: '自动（按已配置项，末尾 DuckDuckGo 兜底）' },
	{ value: 'duckduckgo', label: 'DuckDuckGo（无需 key）' },
	{ value: 'searxng', label: 'SearXNG（自建实例）' },
	{ value: 'tavily', label: 'Tavily（需 key）' },
	{ value: 'brave', label: 'Brave Search（需 key）' },
	{ value: 'exa', label: 'Exa（需 key）' },
];

export interface IWebSearchProviderConfig {
	/** `auto` 或某个 provider id。 */
	readonly provider: string;
	readonly searxngUrl: string;
	readonly tavilyApiKey: string;
	readonly braveApiKey: string;
	readonly exaApiKey: string;
}

export const DEFAULT_WEB_SEARCH_CONFIG: IWebSearchProviderConfig = {
	provider: WEB_SEARCH_AUTO,
	searxngUrl: '',
	tavilyApiKey: '',
	braveApiKey: '',
	exaApiKey: '',
};

// ─── provider 契约 ───────────────────────────────────────────────────────────

/** 可选直答（DDG Instant Answer）。由调用方渲染在结果列表之前。 */
export interface IWebSearchAnswer {
	readonly text: string;
	readonly source?: string;
	readonly url?: string;
}

export interface IWebSearchProviderOutput {
	readonly results: IWebSearchResult[];
	readonly answer?: IWebSearchAnswer;
	/**
	 * 本次尝试里**失败的分支**（如 DDG 的 instant-answer / ddg-html / ddg-lite 各自失败）。
	 *
	 * 设计取舍：provider **不自己抛错**，而是把失败分支如实上报，由**链路所有者**
	 * （webTools 的 handler）统一定夺何时熔断 —— 否则会出现「provider 抛了错但还带回
	 * 部分结果」这种无法表达的状态，且错误文案会被嵌套两层前缀。
	 *
	 * 语义：`results`/`answer` 非空时 errors 只是**部分降级**信息（调用方照常成功返回，
	 * 仅在日志里留痕）；两者都为空时，errors 非空 = 全失败（应熔断）、空 = 可达但无结果
	 * （不应熔断）。
	 */
	readonly errors?: readonly string[];
}

export interface IWebSearchProvider {
	readonly id: string;
	readonly label: string;
	/**
	 * 该 provider 在当前配置下是否可用于 `auto` 链（缺 key / 缺实例地址 → false）。
	 *
	 * ⚠ 只用于 **auto 链的筛选**；用户显式指定某 provider 时**不**用本方法静默换家 ——
	 * 见 `resolveWebSearchChain`。
	 */
	isAvailable(config: IWebSearchProviderConfig): boolean;
	search(
		query: string,
		maxResults: number,
		config: IWebSearchProviderConfig,
		fetchFn: IWebFetchLike,
	): Promise<IWebSearchProviderOutput>;
}

// ─── 响应解析（纯函数，逐个可单测）────────────────────────────────────────────

function safeJsonParse(text: string): unknown {
	try { return JSON.parse(text); } catch { return undefined; }
}

function firstString(...vals: unknown[]): string {
	for (const v of vals) {
		if (typeof v === 'string' && v.trim()) { return v.trim(); }
	}
	return '';
}

/** 把任意 JSON 数组映射成结果列表；缺 title 时用 URL 兜底（保持列表可读）。 */
function mapResultArray(arr: unknown, read: (r: Record<string, unknown>) => { title: string; url: string; snippet: string }): IWebSearchResult[] {
	if (!Array.isArray(arr)) { return []; }
	const out: IWebSearchResult[] = [];
	for (const raw of arr) {
		if (typeof raw !== 'object' || raw === null) { continue; }
		const { title, url, snippet } = read(raw as Record<string, unknown>);
		if (!url) { continue; }
		out.push({ title: title || url, url, snippet });
	}
	return out;
}

/**
 * SearXNG（自建实例）JSON 输出：`{ results: [{ title, url, content, engine }] }`。
 *
 * ⚠ 前置条件：实例的 `settings.yml` 必须开启 `search.formats` 含 `json`；未开启时返回
 * HTML → 本函数解析出 0 条，属"可达但无结果"（**不熔断**，交调用方正常回"无结果"）。
 */
export function parseSearxngResponse(body: string): IWebSearchResult[] {
	const data = safeJsonParse(body) as { results?: unknown } | undefined;
	return mapResultArray(data?.results, r => ({
		title: firstString(r['title']),
		url: firstString(r['url']),
		snippet: firstString(r['content'], r['snippet']),
	}));
}

/**
 * Tavily `POST /search` → `{ results: [{ title, url, content, score }] }`。
 * Tavily 的 `content` 已是抽取过的正文片段（对 LLM 最省一次抓取），故排在 auto 链首位。
 */
export function parseTavilyResponse(body: string): IWebSearchResult[] {
	const data = safeJsonParse(body) as { results?: unknown } | undefined;
	return mapResultArray(data?.results, r => ({
		title: firstString(r['title']),
		url: firstString(r['url']),
		snippet: firstString(r['content'], r['raw_content'], r['snippet']),
	}));
}

/**
 * Brave `GET /res/v1/web/search` → `{ web: { results: [{ title, url, description }] } }`。
 * ⚠ 层级是 `web.results`（不是顶层 results）；`description` 含 `<strong>` 高亮标签，需去标签。
 */
export function parseBraveResponse(body: string): IWebSearchResult[] {
	const data = safeJsonParse(body) as { web?: { results?: unknown } } | undefined;
	return mapResultArray(data?.web?.results, r => ({
		title: firstString(r['title']),
		url: firstString(r['url']),
		snippet: decodeHtmlEntities(stripHtmlTags(firstString(r['description'], r['snippet']))).replace(/\s+/g, ' ').trim(),
	}));
}

/**
 * Exa `POST /search` → `{ results: [{ title, url, text, publishedDate }] }`。
 * `text` 需在请求里显式要 `contents.text`（见 `exaProvider`），否则为空。
 */
export function parseExaResponse(body: string): IWebSearchResult[] {
	const data = safeJsonParse(body) as { results?: unknown } | undefined;
	return mapResultArray(data?.results, r => ({
		title: firstString(r['title'], r['author']),
		url: firstString(r['url']),
		snippet: firstString(r['text'], r['summary']),
	}));
}

// ─── DuckDuckGo（keyless 兜底，沿用既有实现语义）──────────────────────────────

const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const DDG_LITE_ENDPOINT = 'https://lite.duckduckgo.com/lite/';
const DDG_INSTANT_ENDPOINT = 'https://api.duckduckgo.com/';

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
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
 * 百科式直答，对自然语言查询（"france capital"）一律返回空 —— 所以它只能作为自然结果
 * 的**补充**，不能当作主检索路径。
 *
 * @returns null 表示无任何可呈现内容。
 */
async function fetchInstantAnswer(query: string, fetchFn: IWebFetchLike): Promise<IInstantAnswer | null> {
	const r = await fetchFn(`${DDG_INSTANT_ENDPOINT}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
	const data = JSON.parse(r.body.slice(0, 512 * 1024)) as Record<string, unknown>;

	const abstract = typeof data['AbstractText'] === 'string' ? (data['AbstractText'] as string).trim() : '';
	const topics: IWebSearchResult[] = [];
	const rawResults = Array.isArray(data['Results']) ? data['Results'] as Array<Record<string, unknown>> : [];
	const relatedTopics = Array.isArray(data['RelatedTopics']) ? data['RelatedTopics'] as Array<Record<string, unknown>> : [];
	for (const t of (rawResults.length > 0 ? rawResults : relatedTopics)) {
		const title = typeof t['Text'] === 'string' ? t['Text'] as string : '';
		const url = typeof t['FirstURL'] === 'string' ? t['FirstURL'] as string : '';
		if (title && url) { topics.push({ title, url, snippet: '' }); }
	}

	if (!abstract && topics.length === 0) { return null; }
	return {
		abstract,
		abstractSource: typeof data['AbstractSource'] === 'string' ? data['AbstractSource'] as string : '',
		abstractURL: typeof data['AbstractURL'] === 'string' ? data['AbstractURL'] as string : '',
		topics,
	};
}

export const duckDuckGoProvider: IWebSearchProvider = {
	id: 'duckduckgo',
	label: 'DuckDuckGo',
	// keyless：无论用户是否配置了别家，它都可用 —— 这是"搜索永远能跑"的最后一道保险。
	isAvailable: () => true,
	async search(query, _maxResults, _config, fetchFn) {
		const stageErrors: string[] = [];

		// Instant Answer 与自然结果**并行**发起：前者只对单实体名词命中（命中率低但直答
		// 质量高），串行等待会给绝大多数查询白白增加一次 RTT。
		const instantPromise = fetchInstantAnswer(query, fetchFn).catch((err: unknown) => {
			stageErrors.push(`instant-answer: ${errMsg(err)}`);
			return null;
		});

		// 自然结果主路径 html.duckduckgo.com，失败或空则降级 lite.duckduckgo.com。
		let organic: IWebSearchResult[] = [];
		try {
			const r = await fetchFn(`${DDG_HTML_ENDPOINT}?q=${encodeURIComponent(query)}`);
			organic = parseDuckDuckGoHtmlResults(r.body);
		} catch (err) {
			stageErrors.push(`ddg-html: ${errMsg(err)}`);
		}
		if (organic.length === 0) {
			try {
				const r = await fetchFn(`${DDG_LITE_ENDPOINT}?q=${encodeURIComponent(query)}`);
				organic = parseDuckDuckGoLiteResults(r.body);
			} catch (err) {
				stageErrors.push(`ddg-lite: ${errMsg(err)}`);
			}
		}

		const instant = await instantPromise;

		return {
			// 自然结果为主体；无自然结果时用 Instant Answer 站内消歧链接兜底。
			results: organic.length > 0 ? organic : (instant?.topics ?? []),
			answer: instant?.abstract
				? { text: instant.abstract, source: instant.abstractSource, url: instant.abstractURL }
				: undefined,
			// 失败分支如实上报，**不在这里抛错**：三条来源（instant / html / lite）全失败时
			// errors.length === 3，由链路所有者据此熔断（避免子代理反复重试死循环）；
			// 有任一部分成功则 errors 只是降级留痕。
			errors: stageErrors,
		};
	},
};

// ─── 托管 API / 自建实例 provider ────────────────────────────────────────────

export const searxngProvider: IWebSearchProvider = {
	id: 'searxng',
	label: 'SearXNG',
	isAvailable: config => !!config.searxngUrl.trim(),
	async search(query, _maxResults, config, fetchFn) {
		const base = config.searxngUrl.trim().replace(/\/+$/, '');
		const r = await fetchFn(`${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`);
		return { results: parseSearxngResponse(r.body) };
	},
};

export const tavilyProvider: IWebSearchProvider = {
	id: 'tavily',
	label: 'Tavily',
	isAvailable: config => !!config.tavilyApiKey.trim(),
	async search(query, maxResults, config, fetchFn) {
		const r = await fetchFn('https://api.tavily.com/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				api_key: config.tavilyApiKey.trim(),
				query,
				max_results: maxResults,
				// basic 深度即可：`content` 已含片段，不需要 Tavily 再代抓全文（省额度 + 省延迟）。
				search_depth: 'basic',
				include_answer: false,
			}),
		});
		return { results: parseTavilyResponse(r.body) };
	},
};

export const braveProvider: IWebSearchProvider = {
	id: 'brave',
	label: 'Brave Search',
	isAvailable: config => !!config.braveApiKey.trim(),
	async search(query, maxResults, config, fetchFn) {
		const r = await fetchFn(
			`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
			{ headers: { 'Accept': 'application/json', 'X-Subscription-Token': config.braveApiKey.trim() } },
		);
		return { results: parseBraveResponse(r.body) };
	},
};

export const exaProvider: IWebSearchProvider = {
	id: 'exa',
	label: 'Exa',
	isAvailable: config => !!config.exaApiKey.trim(),
	async search(query, maxResults, config, fetchFn) {
		const r = await fetchFn('https://api.exa.ai/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-api-key': config.exaApiKey.trim() },
			body: JSON.stringify({
				query,
				numResults: maxResults,
				// 显式要正文片段，否则 results[].text 为空（Exa 默认只回 title/url）。
				contents: { text: { maxCharacters: 2000 } },
			}),
		});
		return { results: parseExaResponse(r.body) };
	},
};

// ─── 注册表与链路解析 ────────────────────────────────────────────────────────

export const WEB_SEARCH_PROVIDERS: Readonly<Record<string, IWebSearchProvider>> = {
	duckduckgo: duckDuckGoProvider,
	searxng: searxngProvider,
	tavily: tavilyProvider,
	brave: braveProvider,
	exa: exaProvider,
};

export function getWebSearchProvider(id: string): IWebSearchProvider | undefined {
	return WEB_SEARCH_PROVIDERS[id];
}

/**
 * `auto` 链里的托管后端顺序（按序**短路**：前一个返回非空就不再调后面的，避免多份 API
 * 同时计费）。排序理由：
 *   tavily  —— 返回的已是抽取过的正文片段，对 LLM 最省一次抓取
 *   exa     —— 语义/神经检索，长尾与论文场景强
 *   brave   —— 独立索引（不依赖 Google/Bing），有免费档
 *   searxng —— 自建可审计，但质量取决于实例
 */
const AUTO_ORDER: readonly string[] = ['tavily', 'exa', 'brave', 'searxng'];

/**
 * 解析本次实际尝试的 provider 链。
 *
 * • `provider='auto'`（默认）：只保留**已配置**的托管后端，末尾**永远**追加
 *   `duckduckgo`（keyless 兜底 —— 保证用户一个 key 都没填时搜索依然可用，
 *   与服务端/网络都无关）。
 * • **显式指定**：只返回该项，**不**自动降级到别家。这是有意的：让"选错了 provider /
 *   忘了填 key"以明确报错暴露出来（见 `describeProviderSetupHint`），而不是静默换家后
 *   让用户以为在用自己选的 API（也不会因此产生意料外的计费）。
 */
export function resolveWebSearchChain(config: IWebSearchProviderConfig): string[] {
	const explicit = (config.provider || '').trim();
	if (explicit && explicit !== WEB_SEARCH_AUTO) { return [explicit]; }
	const chain = AUTO_ORDER.filter(id => WEB_SEARCH_PROVIDERS[id]?.isAvailable(config));
	chain.push('duckduckgo');
	return chain;
}

/** 显式选中但未配置时的引导文案（告诉用户去填哪一项）。 */
export function describeProviderSetupHint(id: string): string {
	switch (id) {
		case 'duckduckgo':
			return 'no configuration required';
		case 'searxng':
			return 'set `sessions.agentStudio.webSearch.searxngUrl` to your SearXNG instance base URL (the instance must enable the JSON output format)';
		case 'tavily':
			return 'set `sessions.agentStudio.webSearch.tavilyApiKey`';
		case 'brave':
			return 'set `sessions.agentStudio.webSearch.braveApiKey`';
		case 'exa':
			return 'set `sessions.agentStudio.webSearch.exaApiKey`';
		default:
			return `unknown provider "${id}" — valid values: auto, duckduckgo, searxng, tavily, brave, exa`;
	}
}
