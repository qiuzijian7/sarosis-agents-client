/*---------------------------------------------------------------------------------------------
 *  UrlContentSanitizer — 内容清洗管道（对齐 llm_wiki ingest-sanitize.ts）
 *
 *  统一不同下载引擎的输出格式：
 *  - 去除 HTML 标签残留
 *  - 去除脚本/样式残留
 *  - 修复常见 LLM 格式错误（代码围栏包裹、frontmatter 前缀）
 *  - 规范化空白字符
 *  - 保留平台特定结构化数据（OG meta、author、date）
 *--------------------------------------------------------------------------------------------*/

export interface SanitizedContent {
	/** 清洗后的文本正文 */
	text: string;
	/** 提取的标题 */
	title?: string;
	/** 元数据（OG/平台特定） */
	metadata: {
		title?: string;
		author?: string;
		date?: string;
		description?: string;
		sourceUrl?: string;
		platform?: string;
	};
}

/**
 * 清洗下载的 URL 内容。
 *
 * 管道顺序（对齐 llm_wiki）：
 * 1. 去除 <script>/<style>/<noscript> 块
 * 2. 去除 HTML 注释 <!-- ... -->
 * 3. 去除 HTML 标签（<...>），保留标签内文本
 * 4. 解码常见 HTML 实体（&amp; &lt; &gt; &quot; &#nnn;）
 * 5. 修复 LLM 格式错误（代码围栏包裹、frontmatter: 前缀）
 * 6. 规范化空白（合并连续空行为双空行，trim 首尾）
 *
 * @param raw    下载引擎返回的原始内容
 * @param sourceUrl 原始 URL（用于注入元数据）
 * @param platform  平台类型标识
 */
export function sanitizeUrlContent(raw: string, sourceUrl?: string, platform?: string): SanitizedContent {
	if (!raw) {
		return { text: '', metadata: {} };
	}

	let text = raw;

	// 1. 去除 <script>/<style>/<noscript> 块（含内容）
	text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
	text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
	text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

	// 2. 去除 HTML 注释
	text = text.replace(/<!--[\s\S]*?-->/g, '');

	// 3. 去除 HTML 标签（保留文本内容，某些标签需要转换为换行）
	text = text.replace(/<\/?(?:br|hr)\s*\/?>/gi, '\n');  // 块级标签转换行
	text = text.replace(/<\/?(?:p|div|h[1-6]|li|tr|section|article|header|footer|nav|main)\b[^>]*>/gi, '\n');
	text = text.replace(/<[^>]+>/g, '');  // 其余标签直接移除

	// 4. 解码 HTML 实体
	text = decodeHtmlEntities(text);

	// 5. 修复 LLM 格式错误（对齐 llm_wiki sanitizeIngestedFileContent）
	// 5a. 去代码围栏包裹整个内容
	text = text.replace(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```\s*$/m, '$1');
	// 5b. 去 frontmatter: 前缀（LLM 有时会误加）
	text = text.replace(/^frontmatter:\s*/gm, '');
	// 5c. 去 wikilink 列表前缀（如 "- List:" 后面的内容被错误包裹）
	text = text.replace(/^\[\[/gm, '- [[');

	// 6. 规范化空白
	text = text.replace(/[ \t]+/g, ' ');          // 合并连续空格/制表符为单空格
	text = text.replace(/\n{3,}/g, '\n\n');       // 合并 3+ 连续空行为双空行
	text = text.replace(/^\n+/, '');              // 去首部空行
	text = text.replace(/\n+$/, '');              // 去尾部空行
	text = text.trim();

	// 提取元数据
	const metadata = extractMetadata(raw, sourceUrl, platform);
	const title = metadata.title || extractTitleFromText(text);

	return { text, title, metadata };
}

/**
 * 从原始 HTML/文本中提取元数据。
 * 优先从 OG meta / Twitter Card / JSON-LD 提取，回退到正则匹配。
 */
function extractMetadata(raw: string, sourceUrl?: string, platform?: string): SanitizedContent['metadata'] {
	const meta: SanitizedContent['metadata'] = {};
	if (sourceUrl) { meta.sourceUrl = sourceUrl; }
	if (platform) { meta.platform = platform; }

	// OG meta tags
	const ogTitle = raw.match(/<meta\s[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i)
		|| raw.match(/<meta\s[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:title["']/i);
	if (ogTitle) { meta.title = ogTitle[1]; }

	// 普通 <title>
	if (!meta.title) {
		const titleTag = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
		if (titleTag) { meta.title = titleTag[1].trim(); }
	}

	// Author
	const author = raw.match(/<meta\s[^>]*name\s*=\s*["']author["'][^>]*content\s*=\s*["']([^"']+)["']/i)
		|| raw.match(/<meta\s[^>]*property\s*=\s*["']article:author["'][^>]*content\s*=\s*["']([^"']+)["']/i);
	if (author) { meta.author = author[1]; }

	// Date
	const date = raw.match(/<meta\s[^>]*property\s*=\s*["']article:published_time["'][^>]*content\s*=\s*["']([^"']+)["']/i)
		|| raw.match(/<meta\s[^>]*name\s*=\s*["']date["'][^>]*content\s*=\s*["']([^"']+)["']/i);
	if (date) { meta.date = date[1]; }

	// Description
	const desc = raw.match(/<meta\s[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']+)["']/i)
		|| raw.match(/<meta\s[^>]*property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']+)["']/i);
	if (desc) { meta.description = desc[1]; }

	return meta;
}

/** 从清洗后的文本首部提取标题（回退方案）。 */
function extractTitleFromText(text: string): string | undefined {
	const firstLine = text.split('\n')[0]?.trim();
	if (firstLine && firstLine.length >= 3 && firstLine.length <= 150) {
		return firstLine.replace(/^#+\s*/, '').trim() || undefined;
	}
	return undefined;
}

/**
 * 解码常见 HTML 实体。
 * 不引入 DOM parser 依赖，仅处理最常见的实体。
 */
function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, '\'')
		.replace(/&apos;/gi, '\'')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
		.replace(/&[a-z]+;/gi, '');  // 其他未识别的实体直接删除
}
