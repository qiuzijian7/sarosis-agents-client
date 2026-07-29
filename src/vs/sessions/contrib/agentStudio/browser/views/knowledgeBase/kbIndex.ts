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
import { VSBuffer } from '../../../../../../base/common/buffer.js';
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

	/**
	 * Build the index, reusing a persisted cache when available.
	 *
	 * With `cacheUri`: load the cache, then reconcile against the filesystem —
	 * unchanged files (same mtime) are kept as-is (no re-read), only changed /
	 * new files are re-indexed, deleted files are dropped. This turns startup
	 * from "read every file" into "stat every file + read the few that changed".
	 * Without `cacheUri`: full build. The cache is (re)written at the end.
	 */
	async build(roots: IKbIndexRoot[], cacheUri?: URI): Promise<void> {
		let reconciled = false;
		if (cacheUri) {
			const loaded = await this.loadCache(cacheUri);
			if (loaded) {
				await this._reconcile(roots);
				reconciled = true;
			}
		}
		if (!reconciled) {
			this._docs.clear();
			this._postings.clear();
			this._tagIndex.clear();
			this._allTags.clear();
			for (const root of roots) {
				await this.walk(root.uri, root.section);
			}
		}
		this._recomputeStats();
		this._built = true;
		if (cacheUri) {
			await this.saveCache(cacheUri);
		}
	}

	/** Recompute `_totalDocs` / `_avgLen` from the current `_docs` map. */
	private _recomputeStats(): void {
		this._totalDocs = this._docs.size;
		let sum = 0;
		for (const d of this._docs.values()) { sum += d.length; }
		this._avgLen = this._totalDocs ? sum / this._totalDocs : 0;
	}

	/**
	 * Reconcile the in-memory index against the filesystem: keep unchanged docs,
	 * re-index changed/new ones, drop deleted ones. Only changed files are read.
	 */
	private async _reconcile(roots: IKbIndexRoot[]): Promise<void> {
		const seen = new Set<string>(); // docIds still present on disk
		for (const root of roots) {
			await this._reconcileWalk(root.uri, root.section, seen);
		}
		// Drop docs that no longer exist on disk.
		for (const docId of [...this._docs.keys()]) {
			if (!seen.has(docId)) {
				this._removeDoc(docId);
			}
		}
	}

	private async _reconcileWalk(uri: URI, section: KbSection, seen: Set<string>): Promise<void> {
		let stat;
		try { stat = await this.fileService.resolve(uri); } catch { return; }
		if (!stat.children) { return; }
		let _n = 0;
		for (const c of stat.children) {
			if (c.isDirectory) {
				await this._reconcileWalk(c.resource, section, seen);
				continue;
			}
			const ext = c.resource.path.split('.').pop()?.toLowerCase();
			if (!ext || !TEXT_EXTS.has(ext)) { continue; }
			const docId = c.resource.toString();
			seen.add(docId);
			const cached = this._docs.get(docId);
			const mtime = c.mtime ?? 0;
			const size = c.size ?? 0;
			if (cached && cached.mtime === mtime && cached.size === size) {
				continue; // unchanged — keep cached entry, skip re-read
			}
			// changed or new — re-read & re-index
			try {
				if ((size ?? 0) > 2 * 1024 * 1024) {
					this._removeDoc(docId);
					continue;
				}
				const content = await this.fileService.readFile(c.resource);
				this._addOrUpdateDoc({
					uri: c.resource,
					name: c.name,
					path: c.resource.fsPath,
					section,
					mtime,
					size,
					tags: [],
					text: content.value.toString(),
				});
			} catch {
				// ignore single-file read failure
			}
			// 周期性让出事件循环，避免大库冷构建冻结 UI
			if ((++_n & 255) === 0) { await new Promise<void>(r => setTimeout(r, 0)); }
		}
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

	private async walk(uri: URI, section: KbSection): Promise<void> {
		let stat;
		try { stat = await this.fileService.resolve(uri); } catch { return; }
		if (!stat.children) { return; }
		for (const c of stat.children) {
			if (c.isDirectory) {
				await this.walk(c.resource, section);
			} else {
				const ext = c.resource.path.split('.').pop()?.toLowerCase();
				if (!ext || !TEXT_EXTS.has(ext)) { continue; }
				try {
					// Use child.size directly (already in stat.children); the extra
					// resolve() was redundant — it re-stats the same file.
					const size = c.size ?? 0;
					if (size > 2 * 1024 * 1024) { continue; } // skip >2MB
					const content = await this.fileService.readFile(c.resource);
					this._addOrUpdateDoc({
						uri: c.resource,
						name: c.name,
						path: c.resource.fsPath,
						section,
						mtime: c.mtime ?? 0,
						size,
						tags: [],
						text: content.value.toString(),
					});
				} catch {
					// 忽略单个文件读取失败
				}
			}
		}
	}

	/** Remove a doc (and its postings / tag entries) from the index. */
	private _removeDoc(docId: string): void {
		const doc = this._docs.get(docId);
		if (!doc) { return; }
		// postings: remove this docId from every term it appeared in
		for (const term of this._tokenizeOnce(doc)) {
			const pm = this._postings.get(term);
			if (pm) {
				pm.delete(docId);
				if (pm.size === 0) { this._postings.delete(term); }
			}
		}
		// tags
		for (const tag of doc.tags) {
			const normalized = tag.toLowerCase().trim();
			const set = this._tagIndex.get(normalized);
			if (set) {
				set.delete(docId);
				if (set.size === 0) {
					this._tagIndex.delete(normalized);
					this._allTags.delete(normalized);
				}
			}
		}
		this._docs.delete(docId);
	}

	/** Tokens that would be generated for a cached doc (for selective posting removal). */
	private *_tokenizeOnce(doc: IIndexedDoc): Iterable<string> {
		const { cleanText } = this.extractTags(doc.text);
		yield* this.tokenize(doc.name.toLowerCase() + ' ' + cleanText);
	}

	/** Add or replace a doc in the index (re-indexing its postings + tags). */
	private _addOrUpdateDoc(doc: Omit<IIndexedDoc, 'length'>): void {
		const docId = doc.uri.toString();
		if (this._docs.has(docId)) {
			this._removeDoc(docId);
		}

		// 提取并索引 #标签#（从文本中解析，然后从 token 流中去除避免重复索引）
		const { tags, cleanText } = this.extractTags(doc.text);
		const toks = this.tokenize(doc.name.toLowerCase() + ' ' + cleanText);
		const length = toks.length;

		this._docs.set(docId, { ...doc, length, tags });

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

	/** 从 Markdown 文本中提取 #标签#（对齐 SiYuan Lute SetTag 语义）。
	 *  实现：单次扫描 O(L) 增量构建 cleanText，避免在循环内对整串做
	 *  slice + repeat + concat 造成的 O(N·L) 时间与 O(N·L) 临时字符串分配——
	 *  对大笔记（几百 KB+ 多标签）会迅速堆涨乃至撞 V8 4GB 上限。*/
	private extractTags(text: string): { tags: string[]; cleanText: string } {
		const tags: string[] = [];
		// 匹配 #标签# 格式（支持中文标签）
		const tagRe = /#[^#\s\u2000-\u206F]+#/g;
		const parts: string[] = [];
		let lastEnd = 0;
		let m: RegExpExecArray | null;
		while ((m = tagRe.exec(text)) !== null) {
			const raw = m[0];
			const tag = raw.slice(1, -1).trim();
			const valid = tag.length > 0 && tag.length < 64;
			if (valid) { tags.push(tag); }
			// 增量构建：前段原文 + 匹配段（有效则替换为等长空格，无效则保留原文）
			if (m.index > lastEnd) { parts.push(text.slice(lastEnd, m.index)); }
			parts.push(valid ? ' '.repeat(raw.length) : raw);
			lastEnd = m.index + raw.length;
		}
		if (lastEnd === 0) { return { tags, cleanText: text }; }
		if (lastEnd < text.length) { parts.push(text.slice(lastEnd)); }
		return { tags, cleanText: parts.join('') };
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

	/** 获取没有任何标签的文档（用于「#无标签」兜底分组）。 */
	getUntaggedDocs(): IKbSearchHit[] {
		const tagged = new Set<string>();
		for (const docIds of this._tagIndex.values()) {
			for (const id of docIds) { tagged.add(id); }
		}
		const hits: IKbSearchHit[] = [];
		for (const doc of this._docs.values()) {
			if (tagged.has(doc.uri.toString())) { continue; }
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
				matchedBy: 'name',
				score: 0,
				snippet: doc.text.slice(0, 200).replace(/\s+/g, ' ').trim(),
				matchedTags: doc.tags,
			});
		}
		return hits;
	}

	// -----------------------------------------------------------------------
	// 持久化（缓存到 vault 目录，启动时增量 reconcile，避免全量重读）
	// -----------------------------------------------------------------------

	/**
	 * Expose all indexed docs (uri / name / section / mtime / size / text) so
	 * the link graph + mention index can be derived from memory when the FTS
	 * cache was loaded — avoiding a second full disk walk.
	 */
	allDocs(): { uri: URI; name: string; section: KbSection; mtime: number; size: number; text: string }[] {
		return [...this._docs.values()].map(d => ({
			uri: d.uri, name: d.name, section: d.section,
			mtime: d.mtime, size: d.size, text: d.text,
		}));
	}

	/**
	 * 仅 stat 的元数据遍历（不读取文件内容），返回每个可索引文档的
	 * {uri, name, section, mtime, size}。用于：(1) 判定大库（文档数超阈值）；
	 * (2) 驱动 SQLite 增量同步（只重读变更文件），避免对 28000 文件的大库
	 * 在主线程做全量读盘 + 内存倒排索引构建导致 UI 冻结数十分钟。
	 * 遍历过程中周期性让出事件循环，保持 UI 响应。
	 */
	async collectDocMetas(roots: IKbIndexRoot[]): Promise<{ uri: URI; name: string; section: KbSection; mtime: number; size: number }[]> {
		const out: { uri: URI; name: string; section: KbSection; mtime: number; size: number }[] = [];
		let count = 0;
		for (const root of roots) {
			await this._collectMetaWalk(root.uri, root.section, out, () => {
				if ((++count & 511) === 0) {
					return new Promise<void>(r => setTimeout(r, 0));
				}
				return undefined;
			});
		}
		return out;
	}

	private async _collectMetaWalk(
		uri: URI,
		section: KbSection,
		out: { uri: URI; name: string; section: KbSection; mtime: number; size: number }[],
		shouldYield?: () => Promise<void> | undefined,
	): Promise<void> {
		let stat;
		try { stat = await this.fileService.resolve(uri); } catch { return; }
		if (!stat.children) { return; }
		for (const c of stat.children) {
			if (c.isDirectory) {
				await this._collectMetaWalk(c.resource, section, out, shouldYield);
			} else {
				const ext = c.resource.path.split('.').pop()?.toLowerCase();
				if (!ext || !TEXT_EXTS.has(ext)) { continue; }
				const size = c.size ?? 0;
				if (size > 2 * 1024 * 1024) { continue; }
				out.push({ uri: c.resource, name: c.name, section, mtime: c.mtime ?? 0, size });
			}
			const y = shouldYield?.();
			if (y) { await y; }
		}
	}

	/**
	 * Serialize the index to JSON. Stores per-doc metadata + text + tags (not the
	 * postings table — that is cheaply re-derived by re-tokenizing on load, which
	 * keeps the cache roughly the size of the vault text instead of ~2x).
	 */
	serialize(): string {
		const docs = [...this._docs.values()].map(d => ({
			uri: d.uri.toString(),
			name: d.name,
			path: d.path,
			section: d.section,
			mtime: d.mtime,
			size: d.size,
			length: d.length,
			tags: d.tags,
			text: d.text,
		}));
		return JSON.stringify({ v: 1, docs, avgLen: this._avgLen, totalDocs: this._totalDocs });
	}

	/** Restore the index from serialized JSON. Returns false on malformed input. */
	async deserialize(json: string): Promise<boolean> {
		try {
			const data = JSON.parse(json);
			if (!data || data.v !== 1 || !Array.isArray(data.docs)) { return false; }
			this._docs.clear();
			this._postings.clear();
			this._tagIndex.clear();
			this._allTags.clear();
		let _n = 0;
		for (const d of data.docs) {
			const uri = URI.parse(d.uri);
			const doc: IIndexedDoc = {
				uri,
				name: d.name,
				path: d.path,
				section: d.section as KbSection,
				mtime: d.mtime ?? 0,
				size: d.size ?? 0,
				length: d.length ?? 0,
				tags: Array.isArray(d.tags) ? d.tags : [],
				text: typeof d.text === 'string' ? d.text : '',
			};
			const docId = uri.toString();
			this._docs.set(docId, doc);
			// rebuild postings by re-tokenizing (CPU-only, no file I/O)
			const { cleanText } = this.extractTags(doc.text);
			const toks = this.tokenize(doc.name.toLowerCase() + ' ' + cleanText);
			const tf = new Map<string, number>();
			for (const t of toks) { tf.set(t, (tf.get(t) ?? 0) + 1); }
			for (const [term, f] of tf) {
				let pm = this._postings.get(term);
				if (!pm) { pm = new Map(); this._postings.set(term, pm); }
				pm.set(docId, f);
			}
			for (const tag of doc.tags) {
				const normalized = tag.toLowerCase().trim();
				if (!normalized) { continue; }
				this._allTags.add(normalized);
				let set = this._tagIndex.get(normalized);
				if (!set) { set = new Set(); this._tagIndex.set(normalized, set); }
				set.add(docId);
			}
			// 周期性让出事件循环，避免大库缓存加载（re-tokenize）冻结 UI
			if ((++_n & 255) === 0) { await new Promise<void>(r => setTimeout(r, 0)); }
		}
			this._avgLen = data.avgLen ?? 0;
			this._totalDocs = data.totalDocs ?? this._docs.size;
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Remap all absolute paths in a serialized index from a source prefix to a
	 * target prefix. Used when importing a pre-built index from another machine
	 * (e.g. sharing a Feishu KB index across clients).
	 *
	 * @returns The remapped JSON string, or `null` if remapping failed (malformed
	 *          input) or no paths needed changing.
	 */
	static remapPaths(serialized: string, fromPrefix: string, toPrefix: string): string | null {
		try {
			const data = JSON.parse(serialized);
			if (!data || data.v !== 1 || !Array.isArray(data.docs)) { return null; }
			let changed = false;
			for (const d of data.docs) {
				if (typeof d.path === 'string' && d.path.startsWith(fromPrefix)) {
					d.path = toPrefix + d.path.slice(fromPrefix.length);
					changed = true;
				}
				if (typeof d.uri === 'string' && d.uri.startsWith(fromPrefix)) {
					d.uri = toPrefix + d.uri.slice(fromPrefix.length);
					changed = true;
				}
				// Remap file references embedded in document text
				// (e.g. `(/abs/path/media/img.png)` → `(/new/path/media/img.png)`)
				if (typeof d.text === 'string' && d.text.includes(fromPrefix)) {
					d.text = d.text.split(fromPrefix).join(toPrefix);
					changed = true;
				}
			}
			return changed ? JSON.stringify(data) : null;
		} catch {
			return null;
		}
	}

	/**
	 * Validate a serialized index against the current filesystem.
	 * Checks which docs have matching files on disk (by `path`), which are stale
	 * (file exists but mtime/size differ), and which are missing entirely.
	 *
	 * Used after importing a pre-built index to decide whether to load it directly
	 * or trigger a full rebuild.
	 */
	static async validateIndex(
		serialized: string,
		fileService: IFileService,
	): Promise<{ valid: number; stale: number; missing: number; total: number }> {
		const result = { valid: 0, stale: 0, missing: 0, total: 0 };
		try {
			const data = JSON.parse(serialized);
			if (!data || data.v !== 1 || !Array.isArray(data.docs)) { return result; }
			result.total = data.docs.length;
			for (const d of data.docs) {
				if (typeof d.path !== 'string') { result.missing++; continue; }
				try {
					const stat = await fileService.resolve(URI.file(d.path));
					if (!stat.isDirectory && stat.mtime === d.mtime && stat.size === d.size) {
						result.valid++;
					} else {
						result.stale++;
					}
				} catch {
					result.missing++;
				}
			}
		} catch {
			// ignore parse errors — caller treats all as stale
		}
		return result;
	}

	/** Load the index cache from disk. Returns false if missing / invalid. */
	async loadCache(uri: URI): Promise<boolean> {
		try {
			const content = await this.fileService.readFile(uri);
			return await this.deserialize(content.value.toString());
		} catch {
			return false;
		}
	}

	/** Persist the index cache to disk (best-effort). */
	async saveCache(uri: URI): Promise<void> {
		try {
			await this.fileService.writeFile(uri, VSBuffer.fromString(this.serialize()));
		} catch {
			// best-effort: cache failure must not break search
		}
	}

	/**
	 * Incrementally update a single document in the index (used after a note is
	 * saved). Avoids a full rebuild for a one-file change.
	 */
	updateDoc(uri: URI, name: string, section: KbSection, mtime: number, size: number, text: string): void {
		this._addOrUpdateDoc({ uri, name, path: uri.fsPath, section, mtime, size, tags: [], text });
		this._recomputeStats();
	}

	/** Remove a document from the index (used after a note is deleted). */
	removeDoc(uri: URI): void {
		this._removeDoc(uri.toString());
		this._recomputeStats();
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
