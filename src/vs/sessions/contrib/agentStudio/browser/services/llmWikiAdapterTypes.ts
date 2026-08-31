/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * llm_wiki ↔ Sarosis Wiki 适配层类型定义。
 *
 * 设计定位：llm_wiki 作为「源权威」（source of truth），本适配层做**单向同步**
 * —— 把 llm_wiki 已生成的 `wiki/*.md`（frontmatter + body）映射为 Sarosis
 * `IWikiTagService` 可消费的 domain/entity 条目，并触发 `IEmbeddingService`
 * 向量化，最终落到 Sarosis 的 wiki library 与本地全文索引。
 *
 * 不反向写回 llm_wiki，避免双写冲突；llm_wiki 的 `.llm-wiki/` 元数据与
 * Sarosis 的 `WikiTagService` proposals/staging/library 审核流各司其职。
 */

import type { TagLevel } from '../../common/wikiTagTypes.js';

/** llm_wiki 文章 frontmatter 中关心的字段（解析自 frontmatter.ts）。 */
export interface ILlmWikiFrontmatter {
	type?: string;
	title?: string;
	tags?: string[];
	aliases?: string[];
	created?: string;
	[key: string]: unknown;
}

/** llm_wiki 已落盘的一篇 wiki 文章（来自 `${projectPath}/wiki/{type}/*.md`）。 */
export interface ILlmWikiPage {
	/** 相对 wiki 根的路径，如 `wiki/concepts/foo.md`。 */
	relativePath: string;
	/** 从路径或 frontmatter 推断出的 wiki 类型（source/entity/concept...）。 */
	wikiType: string;
	frontmatter: ILlmWikiFrontmatter;
	/** 正文（已剥离 frontmatter 块）。 */
	body: string;
}

/** 适配器内部使用的一篇已解析文章（frontmatter + body）。 */
export interface ILlmWikiArticle {
	frontmatter: ILlmWikiFrontmatter;
	/** 正文（已剥离 frontmatter 块）。 */
	body: string;
}

/**
 * llm_wiki wiki 类型 → Sarosis TagLevel 的映射。
 *
 * llm_wiki 的 GENERATION_WIKI_TYPES 偏「内容/笔记语义」，Sarosis 的 TagLevel
 * 偏「分类层级」。这里做保守映射：entity/concept 等实体类 → entity，
 * source 等归到所属 domain 下作为 L2，其余（synthesis/thesis 等）按 domain 聚合。
 */
export const LLM_WIKI_TYPE_TO_TAG_LEVEL: Record<string, TagLevel> = {
	entity: 'entity',
	concept: 'entity',
	comparison: 'entity',
	finding: 'entity',
	methodology: 'entity',
	thesis: 'L2',
	synthesis: 'L2',
	query: 'L2',
	source: 'L2',
};

/** 同步结果状态。 */
export type LlmWikiSyncStatus = 'synced' | 'skipped' | 'error';

/** 一次同步（单篇或全部）的汇总结果。 */
export interface ILlmWikiSyncResult {
	/** 成功同步进 library 的条目数。 */
	synced: number;
	/** 因已存在/无 frontmatter 被跳过的篇数。 */
	skipped: number;
	/** 处理失败（解析/IO/提交异常）的篇数。 */
	failed: number;
	/** 失败原因明细。 */
	errors: string[];
}

/** 一次全量/增量同步的汇总。 */
export interface ILlmWikiSyncSummary {
	total: number;
	synced: number;
	skipped: number;
	errors: number;
	results: ILlmWikiSyncResult[];
	/** 本次同步使用的 embedding tag。 */
	embeddingTag?: string;
}
