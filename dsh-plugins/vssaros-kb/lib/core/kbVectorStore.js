// @vssaros/dsh-kb — 向量库的紧凑二进制序列化（.kvindex）。
//
// 逐字移植自 `src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/binaryVectorStore.ts`
// （TS → JS，纯函数零依赖，逻辑一字未改 ✓）。两份的**行为一致性**由 round-trip 探针钉住——
// 改了一边没改另一边 ⇒ 探针红 ✓。
//
// 布局（小端）：
//   Magic "KVID"(4) | version u16 | flags u16 | dimensions u32 | chunkCount u32
//   builtAt f64 | headerTag(u16 len + utf8)
//   rootCount u16 [ uri(u16+utf8) section(u16+utf8) ]*
//   tagTableCount u16 [ tag(u16+utf8) ]*
//   chunkTable [ docId(u16+utf8) docName(u16+utf8) section(u16+utf8)
//                start u32 tagIdx u16 text(u32+utf8) ]*
//   vectorPool: chunkCount * dimensions * Float32LE

const MAGIC = 0x4b564944; // "KVID"
const BIN_VERSION = 1;

// ─── 变长字节写入器（自动扩容）─────────────────────────────────────────────────

class ByteWriter {
	constructor() {
		this._buf = new Uint8Array(1024);
		this._view = new DataView(this._buf.buffer);
		this._len = 0;
		this._enc = new TextEncoder();
	}

	_ensure(extra) {
		if (this._len + extra <= this._buf.length) { return; }
		let cap = this._buf.length * 2;
		while (cap < this._len + extra) { cap *= 2; }
		const next = new Uint8Array(cap);
		next.set(this._buf.subarray(0, this._len));
		this._buf = next;
		this._view = new DataView(this._buf.buffer);
	}

	u16(v) { this._ensure(2); this._view.setUint16(this._len, v, true); this._len += 2; }
	u32(v) { this._ensure(4); this._view.setUint32(this._len, v >>> 0, true); this._len += 4; }
	f64(v) { this._ensure(8); this._view.setFloat64(this._len, v, true); this._len += 8; }
	f32(v) { this._ensure(4); this._view.setFloat32(this._len, v, true); this._len += 4; }

	str(s, lenBytes = 2) {
		const bytes = this._enc.encode(s ?? '');
		if (lenBytes === 2) { this.u16(Math.min(bytes.length, 0xffff)); } else { this.u32(bytes.length); }
		this._ensure(bytes.length);
		this._buf.set(bytes, this._len);
		this._len += bytes.length;
	}

	finish() {
		return this._buf.subarray(0, this._len).slice();
	}
}

// ─── 读取器 ────────────────────────────────────────────────────────────────

class ByteReader {
	constructor(buf) {
		this._buf = buf;
		this._view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		this._pos = 0;
		this._dec = new TextDecoder();
	}

	get remaining() { return this._buf.byteLength - this._pos; }

	u16() { const v = this._view.getUint16(this._pos, true); this._pos += 2; return v; }
	u32() { const v = this._view.getUint32(this._pos, true); this._pos += 4; return v; }
	f64() { const v = this._view.getFloat64(this._pos, true); this._pos += 8; return v; }
	f32() { const v = this._view.getFloat32(this._pos, true); this._pos += 4; return v; }

	str(lenBytes = 2) {
		const len = lenBytes === 2 ? this.u16() : this.u32();
		const bytes = this._buf.subarray(this._pos, this._pos + len);
		this._pos += len;
		return this._dec.decode(bytes);
	}
}

// ─── 序列化 ────────────────────────────────────────────────────────────────

/** 把向量索引数据序列化为紧凑二进制（.kvindex）。 */
export function serializeVectorIndexBinary(data) {
	const w = new ByteWriter();
	const chunks = data.chunks ?? [];
	const dimensions = data.dimensions || chunks[0]?.vector.length || 0;

	// tag 表（去重）。
	const tagList = [];
	const tagIndex = new Map();
	const tagOf = (t) => {
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
	const chunkTagIdx = chunks.map(c => tagOf(c.tag || (data.tag || '')));
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
export function deserializeVectorIndexBinary(buf) {
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
		const roots = [];
		for (let i = 0; i < rootCount; i++) {
			const uri = r.str();
			const section = r.str();
			roots.push({ uri, section });
		}

		const tagTableCount = r.u16();
		const tagList = [];
		for (let i = 0; i < tagTableCount; i++) { tagList.push(r.str()); }

		// chunk 元数据
		const metas = [];
		for (let i = 0; i < chunkCount; i++) {
			const docId = r.str();
			const docName = r.str();
			const section = r.str();
			const start = r.u32();
			const tagIdx = r.u16();
			const text = r.str(4);
			metas.push({ docId, docName, section, start, tag: tagList[tagIdx] ?? tag, text });
		}

		// vector pool
		const chunks = [];
		for (let i = 0; i < chunkCount; i++) {
			const vec = new Array(dimensions);
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

/** cosine 相似度（与 legacy `kbVectorIndex.ts` 逐字同算法 ✓：不等长取短的，零向量 ⇒ 0）。 */
export function cosineSimilarity(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) { return 0; }
	let dot = 0, na = 0, nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) { return 0; }
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 语义检索：query 向量 × 全量 chunk 的 cosine，取 top-k（线性扫描；HNSW 留给需要时）。 */
export function searchVectorIndex(indexData, queryVector, { limit = 10, minScore = 0 } = {}) {
	const chunks = indexData?.chunks ?? [];
	const scored = [];
	for (const c of chunks) {
		const score = cosineSimilarity(queryVector, c.vector);
		if (score >= minScore) {
			scored.push({ ...c, score });
		}
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, Math.max(1, Math.min(100, limit)));
}

/** 分块上限（照 legacy `MAX_CHUNK_CHARS` ✓）。 */
export const MAX_CHUNK_CHARS = 1000;

/**
 * 按 heading 边界切 markdown（超 maxChars 再切）。逐字移植自 legacy `chunkMarkdown`
 * （`kbVectorIndex.ts`，TS→JS，逻辑一字未改 ✓）——**建**半的分块与 IDE 同口径 ✓。
 */
export function chunkMarkdown(text, maxChars = MAX_CHUNK_CHARS) {
	const lines = String(text ?? '').split('\n');
	// 预计算每行起偏移
	const starts = new Array(lines.length);
	let off = 0;
	for (let i = 0; i < lines.length; i++) {
		starts[i] = off;
		off += lines[i].length + 1; // +1 折算换行
	}

	const chunks = [];
	let cur = [];
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
