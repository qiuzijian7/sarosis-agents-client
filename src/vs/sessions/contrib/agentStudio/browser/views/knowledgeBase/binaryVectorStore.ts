/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  binaryVectorStore.ts — RAG 向量库的紧凑二进制序列化（.kvindex）。
 *
 *  动机（对齐「向量库用成熟后端 / FAISS」诉求）：Electron 渲染进程 sandbox 无法加载
 *  原生 C++ FAISS，但 JSON（.kbrag.json）把 float 存成十进制字符串，体积约为原始
 *  Float32 的 8 倍，且解析开销大。此模块提供 FAISS `save_local` 式的密集二进制布局：
 *   - 向量用 Float32LE 连续存储（比 JSON 小 ~8x，读写零 JSON 解析）。
 *   - 文本 / 元数据放入变长表；多个 chunk 共享的 tag 用 tag 表 + uint16 索引压缩。
 *  检索仍为 cosine 线性扫描；后续可在此二进制之上叠加 HNSW（WASM）近似索引。
 *
 *  布局（小端）：
 *    Magic "KVID"(4) | version u16 | flags u16 | dimensions u32 | chunkCount u32
 *    builtAt f64 | headerTag(u16 len + utf8)
 *    rootCount u16 [ uri(u16+utf8) section(u16+utf8) ]*
 *    tagTableCount u16 [ tag(u16+utf8) ]*
 *    chunkTable [ docId(u16+utf8) docName(u16+utf8) section(u16+utf8)
 *                 start u32 tagIdx u16 text(u32+utf8) ]*
 *    vectorPool: chunkCount * dimensions * Float32LE
 *--------------------------------------------------------------------------------------------*/

import { IKbVectorIndexData, IKbVectorChunk } from './kbVectorIndex.js';
import { KbSection } from './kbTypes.js';

const MAGIC = 0x4b564944; // "KVID"
const BIN_VERSION = 1;

// ─── 变长字节写入器（自动扩容）─────────────────────────────────────────────────

class ByteWriter {
	private _buf = new Uint8Array(1024);
	private _view = new DataView(this._buf.buffer);
	private _len = 0;
	private readonly _enc = new TextEncoder();

	private _ensure(extra: number): void {
		if (this._len + extra <= this._buf.length) { return; }
		let cap = this._buf.length * 2;
		while (cap < this._len + extra) { cap *= 2; }
		const next = new Uint8Array(cap);
		next.set(this._buf.subarray(0, this._len));
		this._buf = next;
		this._view = new DataView(this._buf.buffer);
	}

	u16(v: number): void { this._ensure(2); this._view.setUint16(this._len, v, true); this._len += 2; }
	u32(v: number): void { this._ensure(4); this._view.setUint32(this._len, v >>> 0, true); this._len += 4; }
	f64(v: number): void { this._ensure(8); this._view.setFloat64(this._len, v, true); this._len += 8; }
	f32(v: number): void { this._ensure(4); this._view.setFloat32(this._len, v, true); this._len += 4; }

	str(s: string, lenBytes: 2 | 4 = 2): void {
		const bytes = this._enc.encode(s ?? '');
		if (lenBytes === 2) { this.u16(Math.min(bytes.length, 0xffff)); } else { this.u32(bytes.length); }
		this._ensure(bytes.length);
		this._buf.set(bytes, this._len);
		this._len += bytes.length;
	}

	finish(): Uint8Array {
		return this._buf.subarray(0, this._len).slice();
	}
}

// ─── 读取器 ────────────────────────────────────────────────────────────────

class ByteReader {
	private _pos = 0;
	private readonly _view: DataView;
	private readonly _dec = new TextDecoder();

	constructor(private readonly _buf: Uint8Array) {
		this._view = new DataView(_buf.buffer, _buf.byteOffset, _buf.byteLength);
	}

	get remaining(): number { return this._buf.byteLength - this._pos; }

	u16(): number { const v = this._view.getUint16(this._pos, true); this._pos += 2; return v; }
	u32(): number { const v = this._view.getUint32(this._pos, true); this._pos += 4; return v; }
	f64(): number { const v = this._view.getFloat64(this._pos, true); this._pos += 8; return v; }
	f32(): number { const v = this._view.getFloat32(this._pos, true); this._pos += 4; return v; }

	str(lenBytes: 2 | 4 = 2): string {
		const len = lenBytes === 2 ? this.u16() : this.u32();
		const bytes = this._buf.subarray(this._pos, this._pos + len);
		this._pos += len;
		return this._dec.decode(bytes);
	}
}

// ─── 序列化 ────────────────────────────────────────────────────────────────

/** 把向量索引数据序列化为紧凑二进制（.kvindex）。 */
export function serializeVectorIndexBinary(data: IKbVectorIndexData): Uint8Array {
	const w = new ByteWriter();
	const chunks = data.chunks ?? [];
	const dimensions = data.dimensions || chunks[0]?.vector.length || 0;

	// tag 表（去重）。
	const tagList: string[] = [];
	const tagIndex = new Map<string, number>();
	const tagOf = (t: string): number => {
		let i = tagIndex.get(t);
		if (i === undefined) { i = tagList.length; tagList.push(t); tagIndex.set(t, i); }
		return i;
	};

	// Header
	w.u32(MAGIC);
	w.u16(BIN_VERSION);
	w.u16(0); // flags
	w.u32(dimensions);
	w.u32(chunks.length);
	w.f64(data.builtAt || Date.now());
	w.str(data.tag || '');

	// roots
	const roots = data.roots ?? [];
	w.u16(Math.min(roots.length, 0xffff));
	for (const r of roots) {
		w.str(r.uri);
		w.str(String(r.section));
	}

	// tag 表占位：先算索引再写表，需要预先构造 tagIdx。
	const chunkTagIdx: number[] = chunks.map(c => tagOf(c.tag || (data.tag || '')));
	w.u16(Math.min(tagList.length, 0xffff));
	for (const t of tagList) { w.str(t); }

	// chunk 表
	for (let i = 0; i < chunks.length; i++) {
		const c = chunks[i];
		w.str(c.docId);
		w.str(c.docName);
		w.str(String(c.section));
		w.u32(c.start >>> 0);
		w.u16(chunkTagIdx[i]);
		w.str(c.text || '', 4);
	}

	// vector pool（Float32，dim 对齐；不足补 0，超出截断）
	for (const c of chunks) {
		const v = c.vector || [];
		for (let d = 0; d < dimensions; d++) { w.f32(d < v.length ? v[d] : 0); }
	}

	return w.finish();
}

// ─── 反序列化 ──────────────────────────────────────────────────────────────

/** 从紧凑二进制（.kvindex）解析向量索引数据。非法返回 null。 */
export function deserializeVectorIndexBinary(buf: Uint8Array): IKbVectorIndexData | null {
	try {
		const r = new ByteReader(buf);
		if (r.u32() !== MAGIC) { return null; }
		const version = r.u16();
		if (version !== BIN_VERSION) { return null; }
		r.u16(); // flags
		const dimensions = r.u32();
		const chunkCount = r.u32();
		const builtAt = r.f64();
		const tag = r.str();

		const rootCount = r.u16();
		const roots: { uri: string; section: KbSection }[] = [];
		for (let i = 0; i < rootCount; i++) {
			const uri = r.str();
			const section = r.str() as KbSection;
			roots.push({ uri, section });
		}

		const tagTableCount = r.u16();
		const tagList: string[] = [];
		for (let i = 0; i < tagTableCount; i++) { tagList.push(r.str()); }

		// chunk 元数据
		const metas: { docId: string; docName: string; section: KbSection; start: number; tag: string; text: string }[] = [];
		for (let i = 0; i < chunkCount; i++) {
			const docId = r.str();
			const docName = r.str();
			const section = r.str() as KbSection;
			const start = r.u32();
			const tagIdx = r.u16();
			const text = r.str(4);
			metas.push({ docId, docName, section, start, tag: tagList[tagIdx] ?? tag, text });
		}

		// vector pool
		const chunks: IKbVectorChunk[] = [];
		for (let i = 0; i < chunkCount; i++) {
			const vec = new Array<number>(dimensions);
			for (let d = 0; d < dimensions; d++) { vec[d] = r.f32(); }
			const m = metas[i];
			chunks.push({
				id: `${m.docId}#${m.start}`,
				docId: m.docId,
				docName: m.docName,
				section: m.section,
				text: m.text,
				vector: vec,
				tag: m.tag,
				start: m.start,
			});
		}

		return {
			v: 1,
			tag,
			dimensions,
			builtAt,
			roots,
			chunks,
		};
	} catch {
		return null;
	}
}
