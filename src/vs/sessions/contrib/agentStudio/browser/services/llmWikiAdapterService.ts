/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * llm_wiki ↔ Sarosis Wiki 单向同步适配器（P0 骨架）。
 *
 * 设计定位（方案 A 主路径 + 方案 C 兜底）：
 * - llm_wiki 是「源权威」，本适配器只读其已生成的 `wiki/*.md`
 *   （frontmatter: type/title/tags + body），不做反向写回。
 * - 映射为 Sarosis 的 domain / entity / L1 / L2 条目后，写入 WikiTagService
 *   的 proposals.json，并自动 approve + commit 进 library（机器生成，跳过人工审核）。
 * - 全文检索 + 向量化复用 Sarosis 既有能力：
 *   · 全文：用 llm_wiki 已有的 `.llm-wiki/` elasticlunr 索引（search-index.json）做口径对齐；
 *   · 向量：调用 IEmbeddingService.embed()（方案 A：OpenAI/Knot BYOK → 失败降级方案 C 本地模型）。
 *
 * 落盘契约（来自已经确认的双侧代码）：
 * - llm_wiki: 文章 `~/{project}/wiki/{type}/*.md`；元数据 `~/{project}/.llm-wiki/`
 *   （projects/、search-index.json、entity-graph.json、graph-metrics.json、log.md）。
 * - sarosis:  `WikiTagService` WIKI_ROOT（默认 `E:/AITools/LLM-Wiki`）下
 *   proposals.json / staging.json / library 的 domain-registry.json / entity-registry.json / tags。
 */

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import * as fs from 'fs';
import * as path from 'path';

import { IWikiTagService } from './wikiTagService.js';
import { IEmbeddingService } from '../../common/embeddingProvider.js';
import type { IEmbeddingResult } from '../../common/embeddingProvider.js';
import type { TagLevel } from '../../common/wikiTagTypes.js';
import type { ILlmWikiFrontmatter, ILlmWikiArticle, ILlmWikiSyncResult } from './llmWikiAdapterTypes.js';

export const ILLM_WIKI_ADAPTER_SERVICE_ID = 'llmWikiAdapterService';

export interface ILLMWikiAdapterService {
	readonly _serviceBrand: undefined;
	/** 同步一个 llm_wiki 项目目录到 Sarosis Wiki（proposals → staging → library）。 */
	syncProject(projectPath: string): Promise<ILlmWikiSyncResult>;
	/** 同步单篇已生成的 llm_wiki 文章（绝对路径）。 */
	syncArticle(articlePath: string): Promise<ILlmWikiSyncResult>;
}

export const ILLM_WIKI_ADAPTER_SERVICE = createDecorator<ILLMWikiAdapterService>(ILLM_WIKI_ADAPTER_SERVICE_ID);

export class LLMWikiAdapterService implements ILLMWikiAdapterService {
	public readonly _serviceBrand: undefined;

	private readonly _queue = new Map<string, Promise<ILlmWikiSyncResult>>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IWikiTagService private readonly wikiTagService: IWikiTagService,
		@IEmbeddingService private readonly embeddingService: IEmbeddingService,
	) { }

	// ─── 公开 API ────────────────────────────────────────────────

	/** 同步整个 llm_wiki 项目：遍历 `wiki/` 下所有 type 子目录的 *.md。 */
	async syncProject(projectPath: string): Promise<ILlmWikiSyncResult> {
		const wikiRoot = path.join(projectPath, 'wiki');
		if (!fs.existsSync(wikiRoot)) {
			this.logService.warn(`[LLMWikiAdapter] wiki root not found: ${wikiRoot}`);
			return { synced: 0, skipped: 0, failed: 0, errors: [`wiki root not found: ${wikiRoot}`] };
		}

		const mdFiles: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) { walk(full); }
				else if (entry.isFile() && entry.name.endsWith('.md')) { mdFiles.push(full); }
			}
		};
		walk(wikiRoot);

		return this._runBatched(mdFiles);
	}

	/** 同步单篇文章，按路径去重防并发重复处理。 */
	async syncArticle(articlePath: string): Promise<ILlmWikiSyncResult> {
		const existing = this._queue.get(articlePath);
		if (existing) { return existing; }
		const task = this._syncOne(articlePath).finally(() => this._queue.delete(articlePath));
		this._queue.set(articlePath, task);
		return task;
	}

	// ─── 内部实现 ────────────────────────────────────────────────

	private async _runBatched(files: string[]): Promise<ILlmWikiSyncResult> {
		const result: ILlmWikiSyncResult = { synced: 0, skipped: 0, failed: 0, errors: [] };
		for (const file of files) {
			const r = await this.syncArticle(file);
			result.synced += r.synced;
			result.skipped += r.skipped;
			result.failed += r.failed;
			result.errors.push(...r.errors);
		}
		return result;
	}

	private async _syncOne(articlePath: string): Promise<ILlmWikiSyncResult> {
		const empty: ILlmWikiSyncResult = { synced: 0, skipped: 0, failed: 0, errors: [] };
		try {
			const raw = fs.readFileSync(articlePath, 'utf-8');
			const article = this._parseFrontmatter(raw);
			if (!article || !article.frontmatter.title) {
				this.logService.warn(`[LLMWikiAdapter] skip (no frontmatter/title): ${articlePath}`);
				return { ...empty, skipped: 1 };
			}

			// 1) 向量化（方案 A → 方案 C 自动降级）
			const embedding = await this._embed(article);

			// 2) 映射为 domain / entity / L1 候选条目并写入 proposals
			const proposals = await this._toProposals(article);

			// 3) 幂等：library 已存在同名条目则跳过 commit（proposal 仍留作审计）
			const existing = await this._existingNames();

			// 4) 自动 approve + commit 进 library（机器生成，确定性同步）
			let committed = 0;
			for (const p of proposals) {
				if (existing.has(this._entryKey(p.level, p.name, p.domain))) {
					this.logService.info(`[LLMWikiAdapter] skip existing: ${p.level}/${p.name}`);
					continue;
				}
				await this.wikiTagService.approveProposal(p.id);
				await this.wikiTagService.commitToLibrary(p.id);
				committed++;
			}
			if (committed === 0) {
				return { ...empty, skipped: 1 };
			}

			this.logService.info(
				`[LLMWikiAdapter] synced "${article.frontmatter.title}" ` +
				`(tags=${article.frontmatter.tags?.length ?? 0}, embedding=${embedding ? 'ok' : 'n/a'})`
			);
			return { ...empty, synced: 1 };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.error(`[LLMWikiAdapter] failed: ${articlePath} — ${msg}`);
			return { ...empty, failed: 1, errors: [msg] };
		}
	}

	/** 解析 llm_wiki 文章（YAML frontmatter + markdown body）。 */
	private _parseFrontmatter(raw: string): ILlmWikiArticle | null {
		const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
		if (!m) { return null; }
		const fmBlock = m[1];
		const body = m[2] ?? '';

		// 轻量 YAML 解析（llm_wiki frontmatter 字段均为标量 / 字符串数组，足够覆盖）
		const fm: Record<string, unknown> = {};
		const lines = fmBlock.split('\n');
		for (const line of lines) {
			const kv = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
			if (!kv) { continue; }
			const key = kv[1];
			let val = kv[2].trim();
			if (val.startsWith('[') && val.endsWith(']')) {
				fm[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
			} else {
				fm[key] = val.replace(/^["']|["']$/g, '');
			}
		}

		const frontmatter: ILlmWikiFrontmatter = {
			type: String(fm['type'] ?? 'note'),
			title: String(fm['title'] ?? ''),
			tags: Array.isArray(fm['tags']) ? (fm['tags'] as string[]) : [],
		};
		return { frontmatter, body };
	}

	/** 调用 EmbeddingService（方案 A 主路径 BYOK，失败降级方案 C 本地）。 */
	private async _embed(article: ILlmWikiArticle): Promise<IEmbeddingResult | null> {
		try {
			const text = `${article.frontmatter.title}\n${article.body}`.slice(0, 8000);
			return await this.embeddingService.embed([text]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[LLMWikiAdapter] embedding skipped: ${msg}`);
			return null;
		}
	}

	/** 把 llm_wiki 文章映射为 Sarosis domain/entity/L1 提议并写入 proposals.json。 */
	private async _toProposals(article: ILlmWikiArticle): Promise<Array<{ id: string; level: TagLevel; name: string; domain?: string }>> {
		const { type = 'note', title = '', tags = [] } = article.frontmatter;
		const out: Array<{ id: string; level: TagLevel; name: string; domain?: string }> = [];

		// type 作为 domain 维度（如 concept/people/event）
		out.push(await this._upsertProposal(`llmwiki-domain-${type}`, 'domain', type, `llm_wiki 类型维度: ${type}`));

		// title 作为 entity 维度（唯一知识节点）
		out.push(await this._upsertProposal(`llmwiki-entity-${this._slug(title)}`, 'entity', title, article.body.slice(0, 200)));

		// 每个 tag 作为 L1 维度（归属上述 domain）
		for (const tag of tags) {
			out.push(await this._upsertProposal(`llmwiki-L1-${this._slug(tag)}`, 'L1', tag, `来自 llm_wiki 标签: ${tag}`, type /* domain */));
		}
		return out;
	}

	/** 收集 library 中已存在的 (level,name[,domain]) 集合，供幂等跳过。 */
	private async _existingNames(): Promise<Set<string>> {
		const set = new Set<string>();
		try {
			const domains = await this.wikiTagService.listDomains();
			// listXxx 返回 Record<名称, 条目>：key 即名称，值类型（IDomainEntry 等）本身无 .name 字段，
			// 故用 Object.keys 取名称而非 Object.values(x).name（后者在类型上不存在）。
			Object.keys(domains).forEach(d => set.add(this._entryKey('domain', d)));
			const entities = await this.wikiTagService.listEntities();
			Object.keys(entities).forEach(e => set.add(this._entryKey('entity', e)));
			for (const d of Object.keys(domains)) {
				const tags = await this.wikiTagService.listTags(d);
				Object.keys(tags).forEach(t => set.add(this._entryKey('L1', t, d)));
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[LLMWikiAdapter] existing-name scan skipped: ${msg}`);
		}
		return set;
	}

	/** 生成条目幂等键：domain/entity 仅按 name，L1 额外带 domain。 */
	private _entryKey(level: TagLevel, name: string, domain?: string): string {
		return level === 'L1' ? `L1:${domain ?? ''}:${name}` : `${level}:${name}`;
	}

	/** 写入 proposals.json（IWikiTagService 未暴露 propose，走文件层以保证不改动既有接口）。返回完整 proposal 对象供调用方收集。 */
	private async _upsertProposal(
		id: string, level: TagLevel, name: string, description: string, domain?: string
	): Promise<{ id: string; level: TagLevel; name: string; domain?: string }> {
		const proposalsPath = await this._proposalsJsonPath();
		let file = this._readJson<{ proposals: Array<Record<string, unknown>> }>(proposalsPath);
		if (!file) { file = { proposals: [] }; }
		const exists = file.proposals.find(p => p.id === id);
		if (!exists) {
			file.proposals.push({
				id, level, name, description,
				synonyms: [], proposed_at: new Date().toISOString(),
				...(domain ? { domain } : {}),
			});
			this._writeJson(proposalsPath, file);
		}
		return { id, level, name, ...(domain ? { domain } : {}) };
	}

	/** 解析 WIKI_ROOT 下的 proposals.json（通过 IWikiTagService.getSettings 获取真实根目录，不外泄私有字段）。 */
	private async _proposalsJsonPath(): Promise<string> {
		const settings = await this.wikiTagService.getSettings();
		return path.join(settings.wikiRoot, 'proposals.json');
	}

	private _slug(s: string): string {
		return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
	}

	private _readJson<T>(p: string): T | null {
		try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return null; }
	}

	private _writeJson(p: string, data: unknown): void {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
	}
}
