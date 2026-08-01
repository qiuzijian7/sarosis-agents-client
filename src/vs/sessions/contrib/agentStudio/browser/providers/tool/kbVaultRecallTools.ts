/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * KB Vault Recall Tools —— 系统 B（KbNativeKernel）的 Agent 检索入口。
 *
 * 背景：原 `kb_search` / `kb_ask` / `kb_search_repo` 来自已下线的系统 A
 * （Hyper-Extract 抽取式知识引擎 + 每仓库 RAG session）。系统 A 全量删除后，
 * Agent 侧仅保留一个统一入口 `kb_search`，直接复用知识库视图共享的
 * `IKbNativeKernelService`：
 *
 *  - 全文（BM25）：`searchFulltext`，零依赖、无需 embedding，永远可用；
 *  - 语义（向量）：`searchVector`，仅当向量索引已构建时参与，失败即静默降级。
 *
 * 设计原则：知识库未打开 / 未构建时不报错，而是返回可执行的引导文本，
 * 避免 Agent 把「没有知识库」误判为「工具故障」而反复重试。
 */

import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import type { IToolResultContent } from '../../../common/providers.js';
import type { IKbNativeKernelService, IKbFulltextHit } from '../../kbNativeKernelService.js';
import type { IKbVectorSearchHit } from '../../views/knowledgeBase/kbVectorIndex.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

/** 单条归一化后的检索命中。 */
interface IRecallHit {
	/** 文档 URI（file://...）。 */
	uri: string;
	/** 文档标题 / 文件名。 */
	title: string;
	/** 命中片段。 */
	snippet: string;
	/** 归一化得分（用于排序展示）。 */
	score: number;
	/** 命中来源通道。 */
	source: 'fulltext' | 'semantic';
}

const MAX_SNIPPET = 320;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function clampLimit(raw: unknown): number {
	const n = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isFinite(n) || n <= 0) { return DEFAULT_LIMIT; }
	return Math.min(Math.floor(n), MAX_LIMIT);
}

function trimSnippet(text: string): string {
	const s = (text ?? '').replace(/\s+/g, ' ').trim();
	return s.length > MAX_SNIPPET ? `${s.slice(0, MAX_SNIPPET)}…` : s;
}

function fromFulltext(h: IKbFulltextHit): IRecallHit {
	return { uri: h.uri, title: h.title, snippet: trimSnippet(h.snippet), score: h.score, source: 'fulltext' };
}

function fromVector(h: IKbVectorSearchHit): IRecallHit {
	return { uri: h.docId, title: h.docName, snippet: trimSnippet(h.text), score: h.score, source: 'semantic' };
}

/**
 * 双通道结果融合：按 uri 去重（同一文档语义命中优先保留、并标记双通道命中），
 * 再按各自通道内的名次做简化 RRF（1/(k+rank)）排序，避免 BM25 分数与 cosine 相似度
 * 直接比较导致的量纲错位。
 */
function fuse(fulltext: IRecallHit[], semantic: IRecallHit[], limit: number): IRecallHit[] {
	const K = 60;
	const scored = new Map<string, { hit: IRecallHit; rrf: number; channels: Set<string> }>();
	const absorb = (list: IRecallHit[]) => {
		list.forEach((hit, i) => {
			const key = hit.uri;
			const rrf = 1 / (K + i + 1);
			const prev = scored.get(key);
			if (prev) {
				prev.rrf += rrf;
				prev.channels.add(hit.source);
				// 语义片段通常更完整，优先展示。
				if (hit.source === 'semantic' && hit.snippet.length > prev.hit.snippet.length) {
					prev.hit = { ...prev.hit, snippet: hit.snippet };
				}
			} else {
				scored.set(key, { hit, rrf, channels: new Set([hit.source]) });
			}
		});
	};
	absorb(semantic);
	absorb(fulltext);
	return [...scored.values()]
		.sort((a, b) => b.rrf - a.rrf)
		.slice(0, limit)
		.map(e => ({ ...e.hit, source: (e.channels.size > 1 ? 'semantic' : e.hit.source) as IRecallHit['source'] }));
}

function render(query: string, hits: IRecallHit[], notes: string[]): string {
	const lines: string[] = [];
	lines.push(`知识库检索「${query}」命中 ${hits.length} 条：`);
	hits.forEach((h, i) => {
		lines.push('');
		lines.push(`${i + 1}. ${h.title}  [${h.source}] score=${h.score.toFixed(3)}`);
		lines.push(`   uri: ${h.uri}`);
		if (h.snippet) { lines.push(`   ${h.snippet}`); }
	});
	if (notes.length) {
		lines.push('');
		lines.push(`说明：${notes.join('；')}`);
	}
	return lines.join('\n');
}

function text(s: string): IToolResultContent[] {
	return [{ type: 'text', text: s }];
}

export interface KbVaultRecallContext {
	register(registration: IBuiltinToolRegistration): IDisposable;
	kernelService: IKbNativeKernelService;
	logService: { warn(msg: string, ...args: unknown[]): void };
}

/**
 * 注册 `kb_search`（系统 B 唯一 Agent 检索入口）。
 */
export function registerKbVaultRecallTools(ctx: KbVaultRecallContext): void {
	ctx.register({
		definition: {
			name: 'kb_search',
			category: 'knowledge',
			description:
				'检索用户知识库（Knowledge Base Vault）中的笔记与已关联文档。' +
				'默认混合检索：BM25 全文 + 语义向量（若向量索引已构建）。' +
				'适用于查找用户自己沉淀的资料、会议纪要、设计文档、剪藏网页等；' +
				'不要用它检索当前代码仓库源码（那应使用 search_code / search_files）。',
			inputSchema: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: '检索查询词（自然语言或关键词）。',
					},
					limit: {
						type: 'number',
						description: `返回条数上限，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}。`,
					},
					mode: {
						type: 'string',
						enum: ['hybrid', 'fulltext', 'semantic'],
						description: '检索模式：hybrid（默认，全文+语义融合）/ fulltext（仅 BM25）/ semantic（仅向量）。',
					},
				},
				required: ['query'],
			},
		},
		handler: async (args) => {
			const query = String(args?.query ?? '').trim();
			if (!query) {
				return text('kb_search 需要非空的 query 参数。');
			}
			const limit = clampLimit(args?.limit);
			const mode = (['hybrid', 'fulltext', 'semantic'] as const).includes(args?.mode as any)
				? (args.mode as 'hybrid' | 'fulltext' | 'semantic')
				: 'hybrid';

			if (!ctx.kernelService.hasActiveVault()) {
				return text(
					'当前没有已打开的知识库（Vault），无法检索。\n' +
					'请先在侧边栏「知识库」视图中打开或创建一个知识库并关联文档；' +
					'若你要查找的是代码仓库内容，请改用 search_code / search_files。'
				);
			}

			const notes: string[] = [];
			let fulltextHits: IRecallHit[] = [];
			let semanticHits: IRecallHit[] = [];

			if (mode !== 'semantic') {
				try {
					fulltextHits = (await ctx.kernelService.searchFulltext(query, limit)).map(fromFulltext);
				} catch (err) {
					ctx.logService.warn('[kb_search] fulltext search failed', err);
					notes.push('全文检索失败，已跳过');
				}
			}

			if (mode !== 'fulltext') {
				try {
					const status = ctx.kernelService.getVectorStatus();
					if (status?.built) {
						semanticHits = (await ctx.kernelService.searchVector(query, limit)).map(fromVector);
					} else if (mode === 'semantic') {
						return text(
							'语义索引尚未构建，无法执行 semantic 检索。\n' +
							'请在「知识库」视图中构建 RAG 向量索引，或改用 mode="fulltext"。'
						);
					}
				} catch (err) {
					ctx.logService.warn('[kb_search] vector search failed', err);
					if (mode === 'semantic') {
						return text('语义检索执行失败，请改用 mode="fulltext" 重试。');
					}
					notes.push('语义检索失败，已降级为全文结果');
				}
			}

			const merged = mode === 'hybrid'
				? fuse(fulltextHits, semanticHits, limit)
				: (mode === 'fulltext' ? fulltextHits : semanticHits).slice(0, limit);

			if (!merged.length) {
				return text(
					`知识库中未找到与「${query}」相关的内容。\n` +
					'可尝试：换用更短的关键词、检查该文档是否已导入知识库，' +
					'或改用 search_files / search_code 在代码仓库中查找。'
				);
			}

			return {
				content: text(render(query, merged, notes)),
				details: {
					query,
					mode,
					count: merged.length,
					hits: merged,
				},
			};
		},
	});
}
