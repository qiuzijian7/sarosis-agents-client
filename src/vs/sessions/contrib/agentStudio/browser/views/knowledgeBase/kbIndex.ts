/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  KbFullTextIndex — 进程内全文倒排索引（对齐 SiYuan / FTS5 的检索语义）。
 *
 *  说明：原生 FTS5 需 SQLite-WASM 持久化索引；此处提供**无外部依赖、纯内存**的等价实现：
 *   - 词元化：ASCII/数字按词边界，CJK + 日文假名按单字 + 二元切分（覆盖中日韩检索）
 *   - 标签索引：#标签# 独立索引，支持标签搜索和前缀补全
 *   - 排序：BM25（含文件名命中加权 + 标签命中加权）
 *   - 首次/失效时扫描一次磁盘构建；后续搜索 O(词项) 命中，支持片段摘要
 *  可作为后续接入 wa-sqlite + FTS5 的过渡实现。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IKbNode, KbSection } from './kbTypes.js';

const TEXT_EXTS = new Set([
	'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'html', 'htm', 'css', 'scss',
	'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'sh', 'bat', 'ps1', 'xml', 'csv', 'log',
]);

/** 搜索命中（文件级 + 评分 + 片段）。 */
export interface IKbSearchHit extends IKbNode {
	matchedBy: 'name' | 'content' | 'tag';
	/** BM25 评分（文件名命中 +10，标签命中 +5） */
	score: number;
	/** 命中片段摘要（纯文本，无 HTML） */
	snippet: string;
	/** 命中的标签列表（仅 matchedBy === 'tag' 时） */
	matchedTags?: string[];
}

interface IIndexedDoc {
	uri: URI;
	name: string;
	path: string;
	section: KbSection;
	mtime: number;
	size: number;
	text: string;
	/** 词元总数，用于 BM25 长度归一 */
	length: number;
	/** 文档中出现的标签 */
	tags: string[];
}

export interface IKbIndexRoot {
	uri: URI;
	section: KbSection;
}

export class KbFullTextIndex {

	private _docs = new Map<string, IIndexedDoc>();          // docId = uri.toString()
	private _postings = new Map<string, Map<string, number>>(); // term -> (docId -> tf)
	/** 标签索引：tag → docId 集合 */
	private _tagIndex = new Map<string, Set<string>>();
	/** 所有已知标签（用于前缀补全） */
	private _allTags = new Set<string>();
	private _totalDocs = 0;
	private _avgLen = 0;
	private _built = false;

	private readonly _k1 = 1.2;
	private readonly _b = 0.75;

	constructor(private readonly fileService: IFileService) { }

	get isBuilt(): boolean { return this._built; }

	async build(roots: IKbIndexRoot[]): Promise<void> {
		this._docs.clear();
		this._postings.clear();
		this._tagIndex.clear();
		this._allTags.clear();
		const lengths: number[] = [];
		for (const root of roots) {
			await this.walk(root.uri, root.section, lengths);
		}
		this._totalDocs = this._docs.size;
		this._avgLen = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
		this._built = true;
	}

	search(q: string, limit = 50): IKbSearchHit[] {
		const queryTerms = this.tokenize(q);
		if (queryTerms.length === 0) { return []; }

		const N = this._totalDocs || 1;
		const scores = new Map<string, number>();
		const matchedTerms = new Set<string>();

		for (const term of queryTerms) {
			const keys = this.gatherTerms(term);
			for (const key of keys) {
				matchedTerms.add(key);
				const pm = this._postings.get(key);
				if (!pm) { continue; }
				const n = pm.size;
				const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
				for (const [docId, tf] of pm) {
					const doc = this._docs.get(docId);
					if (!doc) { continue; }
					const dl = doc.length || 1;
					const denom = tf + this._k1 * (1 - this._b + this._b * dl / (this._avgLen || 1));
					const s = idf * (tf * (this._k1 + 1)) / denom;
					scores.set(docId, (scores.get(docId) ?? 0) + s);
				}
			}
		}

		// 标签名匹配：搜索词作为标签名命中时，对应文档加权
		const tagDocs = this._tagIndex.get(q.toLowerCase());
		if (tagDocs) {
			for (const docId of tagDocs) {
				scores.set(docId, (scores.get(docId) ?? 0) + 5);
			}
		}

		if (scores.size === 0) { return []; }

		const ql = q.toLowerCase();
		const hits: IKbSearchHit[] = [];
		for (const [docId, score] of scores) {
			const doc = this._docs.get(docId);
			if (!doc) { continue; }
			let matchedBy: IKbSearchHit['matchedBy'] = 'content';
			let sc = score;
			if (doc.name.toLowerCase().includes(ql)) { matchedBy = 'name'; sc += 10; }
			if (doc.tags.some(t => t.toLowerCase() === ql)) { matchedBy = 'tag'; sc += 5; }
			hits.push({
				name: doc.name,
				path: doc.path,
				uri: doc.uri,
				isDirectory: false,
				section: doc.section,
				size: doc.size,
				mtime: doc.mtime,
				ctime: 0,
				childCount: 0,
				matchedBy,
				score: sc,
				snippet: this.snippet(doc, matchedTerms, ql),
			});
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}

	/** 取词项对应的所有 posting key：精确命中 + ASCII 前缀命中（提升子串/前缀召回）。 */
	private gatherTerms(term: string): string[] {
		const keys: string[] = [];
		if (this._postings.has(term)) { keys.push(term); }
		// 仅对 ASCII、长度 >= 2 的词做前缀展开（CJK 单/双字已足够精确）
		if (/^[a-z0-9]{2,}$/.test(term)) {
			for (const key of this._postings.keys()) {
				if (key.length > term.length && key.startsWith(term)) { keys.push(key); }
			}
		}
		return keys;
	}

	private async walk(uri: URI, section: KbSection, lengths: number[]): Promise<void> {
		let stat;
		try { stat = await this.fileService.resolve(uri); } catch { return; }
		if (!stat.children) { return; }
		for (const c of stat.children) {
			if (c.isDirectory) {
				await this.walk(c.resource, section, lengths);
			} else {
				const ext = c.resource.path.split('.').pop()?.toLowerCase();
				if (!ext || !TEXT_EXTS.has(ext)) { continue; }
				try {
					const fstat = await this.fileService.resolve(c.resource);
					if ((fstat.size ?? 0) > 2 * 1024 * 1024) { continue; } // 跳过 >2MB
					const content = await this.fileService.readFile(c.resource);
					this.addDoc({
						uri: c.resource,
						name: c.name,
						path: c.resource.fsPath,
						section,
						mtime: c.mtime ?? 0,
						size: c.size ?? 0,
						tags: [],
						text: content.value.toString(),
					}, lengths);
				} catch {
					// 忽略单个文件读取失败
				}
			}
		}
	}

	private addDoc(doc: Omit<IIndexedDoc, 'length'>, lengths: number[]): void {
		const docId = doc.uri.toString();

		// 提取并索引 #标签#（从文本中解析，然后从 token 流中去除避免重复索引）
		const { tags, cleanText } = this.extractTags(doc.text);
		const toks = this.tokenize(doc.name.toLowerCase() + ' ' + cleanText);
		const length = toks.length;

		this._docs.set(docId, { ...doc, length, tags });
		lengths.push(length);

		// 文本倒排索引
		const tf = new Map<string, number>();
		for (const t of toks) { tf.set(t, (tf.get(t) ?? 0) + 1); }
		for (const [term, f] of tf) {
			let pm = this._postings.get(term);
			if (!pm) { pm = new Map(); this._postings.set(term, pm); }
			pm.set(docId, f);
		}

		// 标签索引
		for (const tag of tags) {
			const normalized = tag.toLowerCase().trim();
			if (!normalized) { continue; }
			this._allTags.add(normalized);
			let set = this._tagIndex.get(normalized);
			if (!set) { set = new Set(); this._tagIndex.set(normalized, set); }
			set.add(docId);
		}
	}

	private tokenize(text: string): string[] {
		const lower = text.toLowerCase();
		const tokens: string[] = [];
		// ASCII / 数字词
		const wordRe = /[a-z0-9][a-z0-9_'-]*/g;
		let m: RegExpExecArray | null;
		while ((m = wordRe.exec(lower))) { tokens.push(m[0]); }
		// CJK + 日文假名：单字 + 相邻二元（覆盖中文/日文检索，对齐 FTS5 unicode61 语义）
		const cjkRe = /[㐀-䶿一-鿿豈-﫿぀-ヾ゠-ヿㇰ-ㇿ㆐-㆟]+/g;
		while ((m = cjkRe.exec(lower))) {
			const s = m[0];
			for (let i = 0; i < s.length; i++) {
				tokens.push(s[i]);
				if (i + 1 < s.length) { tokens.push(s[i] + s[i + 1]); }
			}
		}
		return tokens;
	}

	// -----------------------------------------------------------------------
	// 标签索引
	// -----------------------------------------------------------------------

	/** 从 Markdown 文本中提取 #标签#（对齐 SiYuan Lute SetTag 语义）。 */
	private extractTags(text: string): { tags: string[]; cleanText: string } {
		const tags: string[] = [];
		// 匹配 #标签# 格式（支持中文标签）
		const tagRe = /#[^#\s\u2000-\u206F]+#/g;
		let cleanText = text;
		let m: RegExpExecArray | null;
		while ((m = tagRe.exec(cleanText)) !== null) {
			const tag = m[0].slice(1, -1).trim(); // 去掉前后的 #
			if (tag.length > 0 && tag.length < 64) {
				tags.push(tag);
				// 从清洗文本中移除标签（避免 token 流中混入 # 符号）
				cleanText = cleanText.slice(0, m.index) + ' '.repeat(m[0].length) + cleanText.slice(m.index + m[0].length);
			}
		}
		return { tags, cleanText };
	}

	/** 按标签搜索文档（精确匹配）。 */
	searchByTag(tag: string, limit = 50): IKbSearchHit[] {
		const normalized = tag.toLowerCase().trim();
		const docIds = this._tagIndex.get(normalized);
		if (!docIds) { return []; }

		const hits: IKbSearchHit[] = [];
		for (const docId of docIds) {
			const doc = this._docs.get(docId);
			if (!doc) { continue; }
			hits.push({
				name: doc.name,
				path: doc.path,
				uri: doc.uri,
				isDirectory: false,
				section: doc.section,
				size: doc.size,
				mtime: doc.mtime,
				ctime: 0,
				childCount: 0,
				matchedBy: 'tag',
				score: 15, // 标签命中权重
				snippet: doc.text.slice(0, 200).replace(/\s+/g, ' ').trim(),
				matchedTags: doc.tags,
			});
		}
		return hits.slice(0, limit);
	}

	/**
	 * 标签前缀搜索（用于自动补全）。
	 * 返回匹配 tag prefix 的所有标签名。
	 */
	searchTagsByPrefix(prefix: string): string[] {
		const lower = prefix.toLowerCase().trim();
		const results: string[] = [];
		for (const tag of this._allTags) {
			if (tag.startsWith(lower)) { results.push(tag); }
		}
		results.sort();
		return results.slice(0, 20);
	}

	/** 获取所有标签及其文档数量。 */
	getAllTags(): { tag: string; count: number }[] {
		const result: { tag: string; count: number }[] = [];
		for (const [tag, docIds] of this._tagIndex) {
			result.push({ tag, count: docIds.size });
		}
		result.sort((a, b) => b.count - a.count);
		return result;
	}

	private snippet(doc: IIndexedDoc, matchedTerms: Set<string>, ql: string): string {
		const text = doc.text;
		let idx = text.toLowerCase().indexOf(ql);
		if (idx < 0) {
			for (const t of matchedTerms) {
				const i = text.toLowerCase().indexOf(t);
				if (i >= 0) { idx = i; break; }
			}
		}
		if (idx < 0) { return text.slice(0, 100).replace(/\s+/g, ' ').trim(); }
		const start = Math.max(0, idx - 40);
		const end = Math.min(text.length, idx + 80);
		return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
	}
}
