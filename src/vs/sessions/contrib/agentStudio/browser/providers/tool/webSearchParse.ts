/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * web_search / web_extract 的纯逻辑（无 VS Code 依赖，可独立单测）。
 *
 * 从 webTools.ts 抽出（对齐 pathFilterNormalize.ts 模式）：webTools.ts 含
 * requestService / URI 等重依赖，bundled mocha 无法直接 import。
 *
 * 契约来源：Continue `searchWebImpl` / `fetchUrlContentImpl`（G:\...\continue）。
 */

export interface IWebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

// ── HTML 工具函数 ────────────────────────────────────────────────────────────

export function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&nbsp;/gi, ' ')
		.replace(/&quot;/gi, '"')
		.replace(/&#x27;/gi, "'")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)));
}

export function stripHtmlTags(s: string): string {
	return s.replace(/<[^>]+>/g, '');
}

/** DDG 结果链接是跳转包装 `//duckduckgo.com/l/?uddg=<urlencoded>&rut=...`，需解出真实 URL。 */
export function decodeDuckDuckGoUrl(href: string): string {
	const m = href.match(/[?&]uddg=([^&]+)/);
	if (m) {
		try { return decodeURIComponent(m[1]); } catch { /* fallthrough */ }
	}
	if (href.startsWith('//')) { return 'https:' + href; }
	return href;
}

/**
 * DDG 结果页混入赞助广告（`duckduckgo.com/y.js?ad_domain=...&ad_provider=bingv7aa`）与
 * 站内帮助页。这些不是自然结果，会挤占 max_results 名额，需剔除。
 */
export function isDuckDuckGoAdOrChrome(url: string): boolean {
	return /duckduckgo\.com\/y\.js/i.test(url)
		|| /[?&]ad_(domain|provider|type)=/i.test(url)
		|| /duckduckgo\.com\/duckduckgo-help-pages\//i.test(url);
}

/**
 * 在一段结果块 HTML 中抽取摘要。
 *
 * 用反向引用 `\1` 匹配同名闭合标签：摘要内常含 `<b>关键词</b>` 高亮，若用
 * `<\/[a-z]+>` 收尾，非贪婪会在首个 `</b>` 提前截断（实测 snippet 只剩一个词）。
 */
export function extractSnippet(block: string, className: string): string {
	const re = new RegExp(`<([a-z]+)[^>]*class=['"][^'"]*\\b${className}\\b[^'"]*['"][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
	const m = block.match(re);
	if (!m) { return ''; }
	return decodeHtmlEntities(stripHtmlTags(m[2])).replace(/\s+/g, ' ').trim();
}

/**
 * 按标题锚点位置把页面切成结果块，块内就近取摘要。
 *
 * 不能分别全局收集 titles / snippets 再按下标配对：广告块、帮助链接等会让两个
 * 数组长度不等，导致摘要整体错位（实测 "more info" 条目配到了别人的摘要）。
 */
export function parseDdgResultBlocks(body: string, linkClass: string, snippetClass: string): IWebSearchResult[] {
	// 遍历所有 <a>，再从属性串里判类名/取 href —— 属性顺序无关（html 端点是
	// class 在前、lite 端点是 href 在前，且 DDG 随时可能调整）。
	const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
	const classRe = new RegExp(`class=['"][^'"]*\\b${linkClass}\\b[^'"]*['"]`, 'i');
	const anchors: Array<{ title: string; url: string; end: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = anchorRe.exec(body)) !== null) {
		const attrs = m[1];
		if (!classRe.test(attrs)) { continue; }
		const href = attrs.match(/href=['"]([^'"]+)['"]/i);
		if (!href) { continue; }
		anchors.push({
			url: decodeDuckDuckGoUrl(href[1]),
			title: decodeHtmlEntities(stripHtmlTags(m[2])).trim(),
			end: m.index + m[0].length,
		});
	}
	const results: IWebSearchResult[] = [];
	for (let i = 0; i < anchors.length; i++) {
		const a = anchors[i];
		if (!a.url || !a.title || isDuckDuckGoAdOrChrome(a.url)) { continue; }
		const blockEnd = i + 1 < anchors.length ? anchors[i + 1].end : body.length;
		results.push({ title: a.title, url: a.url, snippet: extractSnippet(body.slice(a.end, blockEnd), snippetClass) });
	}
	return results;
}

/** 解析 html.duckduckgo.com/html/ 的结果页：result__a（标题+URL）+ result__snippet（摘要）。 */
export function parseDuckDuckGoHtmlResults(body: string): IWebSearchResult[] {
	return parseDdgResultBlocks(body, 'result__a', 'result__snippet');
}

/** 解析 lite.duckduckgo.com/lite/ 的结果页（更简 markup，类名不同）。 */
export function parseDuckDuckGoLiteResults(body: string): IWebSearchResult[] {
	return parseDdgResultBlocks(body, 'result-link', 'result-snippet');
}

// ── web_search 渲染（Continue searchWebImpl 契约）────────────────────────────

/**
 * 单条搜索结果 content 的字符上限（对齐 Continue `searchWebImpl` 的
 * `DEFAULT_WEB_SEARCH_CHAR_LIMIT = 8000`）。超过则截断并记 warning。
 */
export const DEFAULT_WEB_SEARCH_CHAR_LIMIT = 8000;

/**
 * 渲染结果列表，对齐 Continue `searchWebImpl` 的 `ContextItem` 契约：
 * 每条结果作为独立块（name=标题, description=URL, content=摘要），
 * content 超过 `charLimit` 截断到该长度，并把被截断结果的标题记入 `truncated`。
 * 调用方据此追加 truncation warning 块（与 Continue 完全一致）。
 */
export function renderSearchResults(
	results: IWebSearchResult[],
	maxResults: number,
	charLimit: number,
): { blocks: string[]; truncated: string[] } {
	const blocks: string[] = [];
	const truncated: string[] = [];
	const count = Math.min(results.length, maxResults);
	for (let i = 0; i < count; i++) {
		const r = results[i];
		let content = r.snippet ?? '';
		if (content.length > charLimit) {
			truncated.push(r.title || `Result #${i + 1}`);
			content = content.substring(0, charLimit);
		}
		blocks.push(`${i + 1}. **${r.title}**`);
		blocks.push(`   URL: ${r.url}`);
		if (content) { blocks.push(`   ${content}`); }
		blocks.push('');
	}
	return { blocks, truncated };
}

/** Continue `searchWebImpl` 同款截断告警文案（列出被截断结果名）。 */
export function webSearchTruncationWarning(names: string[]): string {
	return `The content from the following search results was truncated because it exceeded the ${DEFAULT_WEB_SEARCH_CHAR_LIMIT} character limit: ${names.join(', ')}. ` +
		'For more detailed information, consider using web_extract on the specific URL.';
}

// ── HTTP 错误分类（重试策略）─────────────────────────────────────────────────

/**
 * 判断 HTTP 状态码是否为**永久性**错误：4xx（除 408 Request Timeout 与
 * 429 Too Many Requests）重试无意义——页面不存在/无权限/请求非法不会因重试改变。
 * 5xx 与网络层错误是瞬态的，可重试；undefined（无状态码，如加载失败）保守按可重试。
 */
export function isPermanentHttpStatus(statusCode: number | undefined): boolean {
	if (statusCode === undefined) { return false; }
	if (statusCode === 408 || statusCode === 429) { return false; }
	return statusCode >= 400 && statusCode < 500;
}

/**
 * 组装 HTTP 错误详情：上游 error 文本常已含状态码（如 "HTTP error 404"），
 * 此时不再追加 " (HTTP 404)" 后缀，避免 "HTTP error 404 (HTTP 404)" 重复。
 */
export function formatHttpErrorDetail(error: string, statusCode?: number): string {
	if (statusCode !== undefined && !error.includes(String(statusCode))) {
		return `${error} (HTTP ${statusCode})`;
	}
	return error;
}

/**
 * 组装**永久** HTTP 错误的完整消息（供 NonRetryableToolError）：错误详情 +
 * 人读原因 + LLM 引导（明确"不要重试该 URL"）。
 *
 * 背景（日志 1785730551341）：模型幻觉 URL（仿 installation/ 猜 introduction/）
 * 404 后，若错误文本不含引导，模型可能再次尝试同一/相似 URL。明确引导可让模型
 * 首轮即换结果或换查询。对齐 Continue：错误一次回模型、由模型自行换策略。
 */
export function permanentHttpErrorMessage(error: string, statusCode?: number): string {
	const detail = formatHttpErrorDetail(error, statusCode);
	let reason = 'Client error';
	if (statusCode === 404) { reason = 'The page does not exist (the URL may be wrong or the page has moved)'; }
	else if (statusCode === 403) { reason = 'Access forbidden (the site likely blocks automated access)'; }
	else if (statusCode === 401) { reason = 'Authentication required'; }
	else if (statusCode === 410) { reason = 'The page is permanently gone'; }
	return `${detail}. ${reason}. Do NOT retry this URL — pick a different result from web_search or try a different query.`;
}

// ── web_extract 格式化（Continue fetchUrlContentImpl 契约）───────────────────

/**
 * web_extract 正文字符上限（对齐 Continue `fetchUrlContentImpl` 的
 * `DEFAULT_FETCH_URL_CHAR_LIMIT = 20000`）。超过则截断并追加 truncation warning。
 */
export const WEB_EXTRACT_CHAR_LIMIT = 20000;

/** Continue `fetchUrlContentImpl` 同款截断告警文案（URL 截断时追加于结果末尾）。 */
export function webExtractTruncationWarning(url: string): string {
	return `\n\n**Truncation warning**\n\nThe content from ${url} was truncated because it exceeded the ${WEB_EXTRACT_CHAR_LIMIT} character limit. ` +
		'If you need more content, consider fetching specific sections or using a more targeted approach.';
}

/**
 * 组装 web_extract 输出，对齐 Continue `getUrlContextItems` 的 ContextItem 契约：
 * name=页面标题, description=URL, content=正文；正文超 20000 截断并追加
 * truncation warning（Continue `fetchUrlContentImpl` 同款）。
 */
export function formatWebExtractResult(url: string, title: string | undefined, content: string): string {
	const truncated = content.length > WEB_EXTRACT_CHAR_LIMIT;
	const body = truncated ? content.slice(0, WEB_EXTRACT_CHAR_LIMIT) : content;
	const head = `# ${title || url}\n\nURL: ${url}\n\n`;
	return head + body + (truncated ? webExtractTruncationWarning(url) : '');
}
