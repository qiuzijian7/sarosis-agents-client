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
import { IRequestService, asText } from '../../../../../../platform/request/common/request.js';
import { IToolResultContent, ToolSecurityLevel } from '../../../common/providers.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

export interface WebToolContext {
	register(registration: IBuiltinToolRegistration): void;
	requestService: IRequestService;
	logService: ILogService;
}

export function registerWebTools(ctx: WebToolContext): void {
	const mkText = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];
	const source = 'saros.builtin-tools';

	ctx.register({
		definition: {
			name: 'web_search',
			description: 'Search the web using DuckDuckGo. Returns instant answers when available, plus search result titles, URLs, and snippets.',
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

			const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
			try {
				const c = await ctx.requestService.request(
					{ url: apiUrl, type: 'GET', callSite: 'saros.builtinTool.web_search' },
					CancellationToken.None,
				);
				const body = await asText(c) ?? '';
				const raw = body.slice(0, 512 * 1024); // 512KB cap
				const data = JSON.parse(raw) as Record<string, unknown>;

				const lines: string[] = [];
				lines.push(`## Web Search Results for: "${query}"`);
				lines.push('');

				// 1) Instant answer
				const abstractText = typeof data.AbstractText === 'string' ? data.AbstractText.trim() : '';
				const abstractSource = typeof data.AbstractSource === 'string' ? data.AbstractSource : '';
				const abstractURL = typeof data.AbstractURL === 'string' ? data.AbstractURL : '';
				if (abstractText) {
					lines.push(`**Instant Answer**${abstractSource ? ` (source: ${abstractSource})` : ''}:`);
					lines.push(abstractText);
					if (abstractURL) {
						lines.push(`More info: ${abstractURL}`);
					}
					lines.push('');
					lines.push('---');
					lines.push('');
				}

				// 2) Results list
				const results = Array.isArray(data.Results) ? data.Results as Array<Record<string, unknown>> : [];
				const relatedTopics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics as Array<Record<string, unknown>> : [];

				if (results.length > 0) {
					lines.push('**Search Results:**');
					lines.push('');
					const count = Math.min(results.length, maxResults);
					for (let i = 0; i < count; i++) {
						const r = results[i];
						const title = typeof r.Text === 'string' ? r.Text : '';
						const url = typeof r.FirstURL === 'string' ? r.FirstURL : '';
						lines.push(`${i + 1}. **${title || 'Untitled'}**`);
						if (url) { lines.push(`   ${url}`); }
						lines.push('');
					}
				} else if (relatedTopics.length > 0) {
					// 3) Related topics（无 results 时作为回退）
					lines.push('**Related Topics:**');
					lines.push('');
					const count = Math.min(relatedTopics.length, maxResults);
					for (let i = 0; i < count; i++) {
						const t = relatedTopics[i];
						const title = typeof t.Text === 'string' ? t.Text : '';
						const url = typeof t.FirstURL === 'string' ? t.FirstURL : '';
						if (title && url) {
							lines.push(`${i + 1}. ${title}`);
							lines.push(`   ${url}`);
							lines.push('');
						}
					}
				}

				if (lines.length <= 3) {
					return mkText(`No search results found for "${query}". Try a different query or use web_extract if you have a specific URL.`);
				}

				return mkText(lines.join('\n'));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return mkText(`Web search failed: ${msg}`);
			}
		},
	});

	ctx.register({
		definition: {
			name: 'web_extract',
			description: 'Extract readable text content from a web page. Returns title, meta description (if any), and main body text. Use after web_search to read a result page in detail.',
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

				// ── 提取正文 ──────────────────────────────────
				let text = body
					.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
					.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
					.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ')
					.replace(/<[^>]+>/g, ' ')  // strip all tags
					// 常见 HTML 实体
					.replace(/&nbsp;/gi, ' ')
					.replace(/&quot;/gi, '"')
					.replace(/&amp;/gi, '&')
					.replace(/&lt;/gi, '<')
					.replace(/&gt;/gi, '>')
					.replace(/&#x27;/gi, "'")
					.replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
					// 空白规范化
					.replace(/\s+/g, ' ')
					.trim();

				const MAX_TEXT = 65536; // 64KB
				const truncated = text.length > MAX_TEXT;
				if (truncated) {
					text = text.slice(0, MAX_TEXT) + `\n... (${text.length - MAX_TEXT} chars omitted)`;
				}

				const parts: string[] = [];
				if (title) { parts.push(`**Title**: ${title}`); }
				if (description) { parts.push(`**Description**: ${description}`); }
				parts.push('');
				parts.push(text);

				return mkText(parts.join('\n'));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return mkText(`Web extract failed: ${msg}`);
			}
		},
	});

	ctx.logService.info('[BuiltinTools] registerWebTools: web_search + web_extract registered (DuckDuckGo API)');
}
