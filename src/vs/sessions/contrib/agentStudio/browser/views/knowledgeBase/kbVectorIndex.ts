/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbVectorIndex.ts — 知识库 RAG 向量索引（对齐方案 A 为主 / 方案 C 兜底）。
 *
 *  职责：
 *   - 把 vault 内的 .md 按语义切块（优先 heading 边界，超限再切），调用
 *     IEmbeddingService.embed() 批量向量化（embedFn）。
 *   - 持久化为 .kbrag.json（含每块原文 text + provider tag），支持「导入 RAG
 *     构建后的库文件」：tag 匹配激活 provider 时直接复用向量；不匹配则用保存的
 *     text 重新向量化，从而对 provider/model 切换天然鲁棒。
 *   - Phase 3 增量重建：每块冗余存储 tag（${providerId}/${model}@${dim}），provider
 *     切换后调用 rebuildStale() 只重算 tag 不匹配的块，而非全量重建。
 *   - 检索：cosine 相似度，可与现有 BM25 全文索引并行提供语义召回。
 *
 *  设计原则（对齐 kbIndex / kbNativeKernel）：
 *   - sandbox 安全：只用 IFileService + IEmbeddingService，不 require 原生模块。
 *   - embedding 可选：无激活 provider 时 build/search 直接抛出可理解的错误，
 *     不影响 FTS / 图谱 / 反链等已有能力。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { KbSection } from './kbTypes.js';
import { IEmbeddingService } from '../../../common/embeddingProvider.js';
import { embedWithPooling } from '../../knowledge/tokenEmbedder.js';
import { serializeVectorIndexBinary, deserializeVectorIndexBinary } from './binaryVectorStore.js';

/** 持久化向量索引文件名（「导入 RAG 构建后的库文件」的载体）。 */
export const KB_RAG_INDEX_FILE = '.kbrag.json';

/** 紧凑二进制向量库文件名（Float32 密集布局，体积约为 JSON 的 1/8）。 */
export const KB_RAG_INDEX_BINARY_FILE = '.kvindex';

const VECTOR_INDEX_VERSION = 1;
const MAX_CHUNK_CHARS = 1000;
const EMBED_BATCH = 64;

/** 单条向量块。 */
export interface IKbVectorChunk {
	/** 块 ID（docId + 偏移）。 */
	id: string;
	/** 来源文档 URI（uri.toString()）。 */
	docId: string;
	/** 来源文档名（含扩展名）。 */
	docName: string;
	section: KbSection;
	/** 切块后的原文（导入/重建时用于重新向量化）。 */
	text: string;
	/** 向量（行向量，dim 维）。 */
	vector: number[];
	/** 产出该向量的 provider tag（${id}/${model}@${dim}）。 */
	tag: string;
	/** 在源文档中的字符起偏移（用于定位高亮）。 */
	start: number;
}

/** 向量检索命中（cosine 相似度降序）。 */
export interface IKbVectorSearchHit {
	chunkId: string;
	docId: string;
	docName: string;
	section: KbSection;
	text: string;
	/** cosine 相似度 [0,1]。 */
	score: number;
}

/** 序列化结构（.kbrag.json）。 */
export interface IKbVectorIndexData {
	v: number;
	/** 构建时的激活 tag（导入时与当前激活 tag 比对，决定直接复用或重算）。 */
	tag: string;
	dimensions: number;
	builtAt: number;
	roots: { uri: string; section: KbSection }[];
	chunks: IKbVectorChunk[];
}

export interface IKbVectorBuildOptions {
	/** 增量构建：保留 mtime/size 未变且 tag 匹配的块，只重算变更/新增文档。 */
	incremental?: boolean;
	/** 取消令牌。 */
	token?: CancellationToken;
}

export interface IKbVectorStatus {
	built: boolean;
	tag: string | undefined;
	dimensions: number | undefined;
	chunkCount: number;
}

export class KbVectorIndex {

	private _chunks: IKbVectorChunk[] = [];
	private _docMeta = new Map<string, { mtime: number; size: number }>();
	private _roots: { uri: URI; section: KbSection }[] = [];
	private _built = false;
	private _tag: string | undefined;
	private _dimensions: number | undefined;

	constructor(
		private readonly _fileService: IFileService,
		private readonly _embedding: IEmbeddingService | undefined,
		/** 强制使用的 embedding provider id（如 KB agent 的 provider）。覆盖 EmbeddingService 主路径选择。 */
		private readonly _embeddingProviderId?: string,
	) { }

	get isBuilt(): boolean { return this._built; }
	get tag(): string | undefined { return this._tag; }
	get dimensions(): number | undefined { return this._dimensions; }
	get chunkCount(): number { return this._chunks.length; }

	/** 当前状态（供 UI / 诊断展示）。 */
	getStatus(): IKbVectorStatus {
		return {
			built: this._built,
			tag: this._tag,
			dimensions: this._dimensions,
			chunkCount: this._chunks.length,
		};
	}

	/** 暴露全部块（供 UI 预览 / 调试）。 */
	allChunks(): IKbVectorChunk[] { return this._chunks; }

	// -----------------------------------------------------------------------
	// 构建（per-folder RAG）
	// -----------------------------------------------------------------------

	/**
	 * 对给定根目录做向量化构建。
	 * - 收集所有 .md / .markdown（>2MB 跳过），按语义切块。
	 * - 复用 IEmbeddingService.embed() 批量向量化（主路径方案A → 失败降级方案C）。
	 * - incremental=true 时只重算 mtime/size 变更的文档，其余块（tag 匹配）保留。
	 */
	async build(roots: { uri: URI; section: KbSection }[], opts?: IKbVectorBuildOptions): Promise<void> {
		if (!this._embedding) {
			throw new Error('向量索引需要激活的 Embedding provider（配置 sessions.agentStudio.embedding.provider）。');
		}
		const activeTag = this._embedding.getTagForProvider(this._embeddingProviderId);
		if (!activeTag) {
			throw new Error('当前没有可用的 Embedding provider（API key 未配置且本地兜底未启用）。');
		}

		this._roots = roots;
		const incremental = opts?.incremental === true && this._built;

		// 1. 收集待重算文档：增量模式下保留未变文档的块，其余丢弃重算。
		const toReembed: { docId: string; name: string; section: KbSection; mtime: number; size: number; text: string }[] = [];
		const seen = new Set<string>();

		for (const root of roots) {
			await this._collectDocs(root.uri, root.section, incremental, seen, toReembed);
		}

		// 增量模式：丢弃已删除文档的块。
		if (incremental) {
			for (const docId of [...this._docMeta.keys()]) {
				if (!seen.has(docId)) {
					this._removeDocChunks(docId);
				}
			}
		}

		// 2. 切块。
		const newChunks: { docId: string; name: string; section: KbSection; text: string; start: number }[] = [];
		for (const doc of toReembed) {
			for (const c of chunkMarkdown(doc.text, MAX_CHUNK_CHARS)) {
				newChunks.push({
					docId: doc.docId,
					name: doc.name,
					section: doc.section,
					text: c.text,
					start: c.start,
				});
			}
		}

		// 3. 批量向量化：token 级切块 + 均值池化（对齐 Hyper-Extract CompatibleEmbeddings），
		//    保证「每个语义块 = 1 个向量」；超长块内部会被切分再聚合，避免超 token 上限报错。
		let builtDimensions: number | undefined;
		if (newChunks.length > 0) {
			const texts = newChunks.map(c => c.text);
			let builtTag: string | undefined;
			const embedFn = async (batch: string[]): Promise<number[][]> => {
				const result = await this._embedding!.embed(batch, { token: opts?.token, providerId: this._embeddingProviderId });
				builtTag = result.tag;
				builtDimensions = result.dimensions;
				return result.vectors;
			};
			const vectors = await embedWithPooling(embedFn, texts, { maxBatchSize: EMBED_BATCH });
			const tag = builtTag ?? activeTag;
			for (let idx = 0; idx < newChunks.length; idx++) {
				const meta = newChunks[idx];
				this._chunks.push({
					id: `${meta.docId}#${meta.start}`,
					docId: meta.docId,
					docName: meta.name,
					section: meta.section,
					text: meta.text,
					vector: vectors[idx],
					tag,
					start: meta.start,
				});
			}
		}

		// 4. 写入 docMeta（仅本次扫描的文档；增量模式下保留未变文档元信息）。
		for (const doc of toReembed) {
			this._docMeta.set(doc.docId, { mtime: doc.mtime, size: doc.size });
		}

		this._tag = activeTag;
		this._dimensions = builtDimensions ?? this._embedding.getActiveDimensions();
		this._built = true;
	}

	/** Phase 3：只重算 tag 与激活 provider 不匹配的块（provider/model 切换后调用）。 */
	async rebuildStale(token?: CancellationToken): Promise<number> {
		if (!this._embedding) {
			throw new Error('向量索引需要激活的 Embedding provider。');
		}
		const activeTag = this._embedding.getTagForProvider(this._embeddingProviderId);
		if (!activeTag) {
			throw new Error('当前没有可用的 Embedding provider。');
		}
		const stale = this._chunks.filter(c => c.tag !== activeTag);
		let builtDimensions: number | undefined;
		if (stale.length === 0) {
			this._tag = activeTag;
			return 0;
		}

		// 按 docId 归组，从保存的 text 重新向量化（保持文档级语义）。
		const staleChunks = new Map<string, IKbVectorChunk[]>();
		for (const c of stale) {
			let arr = staleChunks.get(c.docId);
			if (!arr) { arr = []; staleChunks.set(c.docId, arr); }
			arr.push(c);
		}

		const reembed: IKbVectorChunk[] = [];
		for (const arr of staleChunks.values()) {
			reembed.push(...arr);
		}

		// 从索引中移除 stale 块。
		const staleIds = new Set(stale.map(c => c.id));
		this._chunks = this._chunks.filter(c => !staleIds.has(c.id));

		// 用保存的 text 重新向量化（token 级切块 + 均值池化，与 build 同路径）。
		if (reembed.length > 0) {
			const texts = reembed.map(c => c.text);
			let rebuiltTag: string | undefined;
			const embedFn = async (batch: string[]): Promise<number[][]> => {
				const result = await this._embedding!.embed(batch, { token, providerId: this._embeddingProviderId });
				rebuiltTag = result.tag;
				builtDimensions = result.dimensions;
				return result.vectors;
			};
			const vectors = await embedWithPooling(embedFn, texts, { maxBatchSize: EMBED_BATCH });
			const tag = rebuiltTag ?? activeTag;
			for (let idx = 0; idx < reembed.length; idx++) {
				const c = reembed[idx];
				this._chunks.push({
					id: c.id,
					docId: c.docId,
					docName: c.docName,
					section: c.section,
					text: c.text,
					vector: vectors[idx],
					tag,
					start: c.start,
				});
			}
			this._tag = tag;
		} else {
			this._tag = activeTag;
		}

		if (builtDimensions !== undefined) { this._dimensions = builtDimensions; }
		return stale.length;
	}

	// -----------------------------------------------------------------------
	// 检索
	// -----------------------------------------------------------------------

	/** 向量语义检索。无向量或未构建时抛错。 */
	async search(query: string, topK = 8, providerId?: string): Promise<IKbVectorSearchHit[]> {
		if (!this._embedding) {
			throw new Error('向量索引需要激活的 Embedding provider。');
		}
		if (!this._built || this._chunks.length === 0) {
			return [];
		}
		const effectiveProviderId = providerId ?? this._embeddingProviderId;
		const q = query.trim();
		if (!q) { return []; }
		const qv = (await this._embedding.embed([q], { providerId: effectiveProviderId })).vectors[0];
		if (!qv || qv.length === 0) { return []; }

		const hits: IKbVectorSearchHit[] = [];
		for (const c of this._chunks) {
			if (c.vector.length !== qv.length) { continue; } // 维度不一致跳过（理论上 rebuildStale 已处理）
			const sim = cosineSimilarity(qv, c.vector);
			hits.push({
				chunkId: c.id,
				docId: c.docId,
				docName: c.docName,
				section: c.section,
				text: c.text,
				score: sim,
			});
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, topK);
	}

	// -----------------------------------------------------------------------
	// 持久化 / 导入导出（.kbrag.json）
	// -----------------------------------------------------------------------

	/** 构造可序列化数据结构（JSON / 二进制共用）。 */
	private _toData(): IKbVectorIndexData {
		return {
			v: VECTOR_INDEX_VERSION,
			tag: this._tag ?? '',
			dimensions: this._dimensions ?? 0,
			builtAt: Date.now(),
			roots: this._roots.map(r => ({ uri: r.uri.toString(), section: r.section })),
			chunks: this._chunks,
		};
	}

	/** 序列化为 .kbrag.json 内容。 */
	serialize(): string {
		return JSON.stringify(this._toData());
	}

	/** 序列化为紧凑二进制（.kvindex，Float32 密集布局，体积约为 JSON 的 1/8）。 */
	serializeBinary(): Uint8Array {
		return serializeVectorIndexBinary(this._toData());
	}

	/**
	 * 反序列化。
	 * - 若导入 tag 与当前激活 provider tag 一致 → 直接复用向量（最快路径）。
	 * - 否则（provider/model 切换）→ 用保存的 text 重新向量化，保证维度/语义一致。
	 * 返回是否成功加载（false 表示输入非法）。
	 */
	async deserialize(json: string): Promise<boolean> {
		try {
			const data = JSON.parse(json) as IKbVectorIndexData;
			return await this._populateFromData(data);
		} catch {
			return false;
		}
	}

	/** 从紧凑二进制（.kvindex）反序列化。非法返回 false。 */
	async deserializeBinary(buf: Uint8Array): Promise<boolean> {
		try {
			const data = deserializeVectorIndexBinary(buf);
			if (!data) { return false; }
			return await this._populateFromData(data);
		} catch {
			return false;
		}
	}

	/** 把已解析的索引数据装载进本实例（JSON / 二进制共用），含 tag 比对与按需重向量化。 */
	private async _populateFromData(data: IKbVectorIndexData | null): Promise<boolean> {
		if (!data || data.v !== VECTOR_INDEX_VERSION || !Array.isArray(data.chunks)) {
			return false;
		}
		this._chunks = data.chunks.map(c => ({
			id: c.id,
			docId: c.docId,
			docName: c.docName,
			section: c.section,
			text: c.text,
			vector: Array.isArray(c.vector) ? c.vector : [],
			tag: c.tag,
			start: c.start ?? 0,
		}));
		this._roots = (data.roots ?? []).map(r => ({ uri: URI.parse(r.uri), section: r.section }));
		this._dimensions = data.dimensions || this._chunks[0]?.vector.length || undefined;

		const activeTag = this._embedding?.getActiveTag();
		if (activeTag && data.tag && data.tag === activeTag) {
			// 直接复用
			this._tag = data.tag;
		} else if (this._embedding && activeTag) {
			// 重新向量化
			await this.rebuildStale();
		} else {
			// 无激活 provider：仅载入（下次有 provider 时需 rebuildStale）
			this._tag = data.tag || undefined;
		}
		this._built = true;
		return true;
	}

	/** 导出到磁盘（.kbrag.json）。 */
	async exportToFile(uri: URI): Promise<void> {
		await this._fileService.writeFile(uri, VSBuffer_fromString(this.serialize()));
	}

	/** 导出到磁盘（.kvindex 紧凑二进制）。 */
	async exportToBinaryFile(uri: URI): Promise<void> {
		await this._fileService.writeFile(uri, VSBuffer.wrap(this.serializeBinary()));
	}

	/** 从磁盘导入（.kbrag.json）。返回是否成功。 */
	async importFromFile(uri: URI): Promise<boolean> {
		try {
			const content = await this._fileService.readFile(uri);
			return await this.deserialize(content.value.toString());
		} catch {
			return false;
		}
	}

	/** 从磁盘导入（.kvindex 紧凑二进制）。返回是否成功。 */
	async importFromBinaryFile(uri: URI): Promise<boolean> {
		try {
			const content = await this._fileService.readFile(uri);
			return await this.deserializeBinary(new Uint8Array(content.value.buffer));
		} catch {
			return false;
		}
	}

	/**
	 * 重映射导入索引中的绝对路径前缀（跨机器共享 .kbrag.json 时调用）。
	 * 既改 docId URI，也改块文本中内嵌的文件引用。
	 */
	static remapPaths(serialized: string, fromPrefix: string, toPrefix: string): string | null {
		try {
			const data = JSON.parse(serialized) as IKbVectorIndexData;
			if (!data || data.v !== VECTOR_INDEX_VERSION || !Array.isArray(data.chunks)) { return null; }
			let changed = false;
			for (const c of data.chunks) {
				if (c.docId.startsWith(fromPrefix)) {
					c.docId = toPrefix + c.docId.slice(fromPrefix.length);
					c.id = `${c.docId}#${c.start}`;
					changed = true;
				}
				if (typeof c.text === 'string' && c.text.includes(fromPrefix)) {
					c.text = c.text.split(fromPrefix).join(toPrefix);
					changed = true;
				}
			}
			for (const r of data.roots ?? []) {
				if (r.uri.startsWith(fromPrefix)) {
					r.uri = toPrefix + r.uri.slice(fromPrefix.length);
					changed = true;
				}
			}
			return changed ? JSON.stringify(data) : null;
		} catch {
			return null;
		}
	}

	// -----------------------------------------------------------------------
	// 内部
	// -----------------------------------------------------------------------

	private async _collectDocs(
		uri: URI,
		section: KbSection,
		incremental: boolean,
		seen: Set<string>,
		out: { docId: string; name: string; section: KbSection; mtime: number; size: number; text: string }[],
	): Promise<void> {
		let stat;
		try { stat = await this._fileService.resolve(uri); } catch { return; }
		if (!stat.children) {
			// 单文件
			await this._maybeCollectOne(uri, section, incremental, seen, out);
			return;
		}
		for (const c of stat.children) {
			if (c.isDirectory) {
				await this._collectDocs(c.resource, section, incremental, seen, out);
			} else {
				await this._maybeCollectOne(c.resource, section, incremental, seen, out);
			}
		}
	}

	private async _maybeCollectOne(
		uri: URI,
		section: KbSection,
		incremental: boolean,
		seen: Set<string>,
		out: { docId: string; name: string; section: KbSection; mtime: number; size: number; text: string }[],
	): Promise<void> {
		const ext = uri.path.split('.').pop()?.toLowerCase();
		if (ext !== 'md' && ext !== 'markdown') { return; }
		const docId = uri.toString();
		seen.add(docId);

		if (incremental) {
			const cached = this._docMeta.get(docId);
			// 需要从 children 取得 mtime/size：用 resolve 单文件
			let mtime = 0;
			let size = 0;
			try {
				const s = await this._fileService.resolve(uri);
				mtime = s.mtime ?? 0;
				size = s.size ?? 0;
			} catch { return; }
			if (cached && cached.mtime === mtime && cached.size === size) {
				return; // 未变：保留其块
			}
		}

		try {
			const content = await this._fileService.readFile(uri);
			const size = content.value.byteLength;
			if (size > 2 * 1024 * 1024) { return; }
			let mtime = 0;
			try { mtime = (await this._fileService.resolve(uri)).mtime ?? 0; } catch { /* ignore */ }
			out.push({
				docId,
				name: uri.path.split('/').pop() ?? docId,
				section,
				mtime,
				size,
				text: content.value.toString(),
			});
		} catch {
			// 忽略单文件读取失败
		}
	}

	private _removeDocChunks(docId: string): void {
		this._chunks = this._chunks.filter(c => c.docId !== docId);
		this._docMeta.delete(docId);
	}

	/** 重置（测试 / 重新构建前调用）。 */
	reset(): void {
		this._chunks = [];
		this._docMeta.clear();
		this._roots = [];
		this._built = false;
		this._tag = undefined;
		this._dimensions = undefined;
	}
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** cosine 相似度（向量已归一化则等价点积；此处保守地做归一化，避免长度偏差）。 */
export function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) { return 0; }
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 把 Markdown 按语义切块：优先在 heading 边界切分，单块超过 maxChars 时再按行切。
 * 返回每块文本 + 在源文档中的字符起偏移（用于定位高亮）。
 */
export function chunkMarkdown(text: string, maxChars = MAX_CHUNK_CHARS): { text: string; start: number }[] {
	const lines = text.split('\n');
	// 预计算每行起偏移
	const starts: number[] = new Array(lines.length);
	let off = 0;
	for (let i = 0; i < lines.length; i++) {
		starts[i] = off;
		off += lines[i].length + 1; // +1 折算换行
	}

	const chunks: { text: string; start: number }[] = [];
	let cur: string[] = [];
	let curStart = starts[0] ?? 0;
	let curLen = 0;

	const flush = () => {
		if (cur.length > 0) {
			const joined = cur.join('\n').trim();
			if (joined.length > 0) {
				chunks.push({ text: joined, start: curStart });
			}
			cur = [];
			curLen = 0;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const ln = lines[i];
		const isHeading = /^(#{1,6})\s/.test(ln);
		const lineLen = ln.length;
		if (cur.length > 0 && (isHeading || curLen + lineLen + 1 > maxChars)) {
			flush();
		}
		if (cur.length === 0) { curStart = starts[i]; }
		cur.push(ln);
		curLen += lineLen + 1;
	}
	flush();
	return chunks;
}

// VSBuffer 本地引入（避免与 kbIndex 重复 import 路径噪声）
function VSBuffer_fromString(s: string): VSBuffer {
	return VSBuffer.fromString(s);
}
