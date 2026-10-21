/*---------------------------------------------------------------------------------------------
 *  BM25 制品二进制格式（2026-10-21）
 *
 *  背景：旧制品 `bm25-cache.json.gz` = 「JSON 文本 + gzip」。真机 18889 doc / 165366 term /
 *  900917 posting：解压后 37.6MB、gzip 后 7.8MB。保存 = JSON.stringify ≈273ms + gzip ≈900ms；
 *  加载 = gunzip+parse ≈1631ms。gzip 是**唯一**的大头，而它换来的只是 37.6MB → 7.8MB（4.8x）。
 *  二进制把「字符串表 + 整数数组」直接写出：不压缩，体积 ≈7.7MB，编码/解码都在百毫秒级。
 *
 *  布局（小端）：
 *    [0..8)    MAGIC 'AMB35\0\0\x01'（末字节 = 格式版本）
 *    [8..12)   u32    headerLen
 *    [12..)    header UTF-8 JSON：{ ...meta, agents: { <agentId>: { offset, length, v } }, bodyBytes }
 *    body      各 agent 的段（按 header 里的 offset/length 定位）
 *
 *  agent 段：
 *    u32    docCount                （文档 id 字符串表大小）
 *    varint docTableBytes + bytes    （表：每条 = varint 字节长度 + UTF-8 字节）
 *    u32    termCount               （词条字符串表大小）
 *    varint termTableBytes + bytes   （表：同上）
 *    u32    entryCount               → 每条：varint keyIdx, varint innerIdx, varint termCount
 *    u32    invertedCount            → 每条：varint termIdx, varint postingCount,
 *                                        postingCount × varint docIdx
 *    u32    docTermsCount            → 每条：varint docIdx, varint pairCount,
 *                                        pairCount × (varint termIdx, varint count)
 *    f64    totalDocLength
 *
 *  为什么**两张**字符串表（doc / term）而不是一张：
 *    一张表 ⇒ 倒排表里的 docIdx 与 termIdx 混在同一空间（18.9k + 165k ⇒ 3 字节 varint）；
 *    两张表 ⇒ docIdx 只在 18.9k 空间（2 字节）、termIdx 在 165k 空间（3 字节），
 *    而 posting 数量（90 万）远多于 term 数量 ⇒ 省下的正是最多那部分。
 *
 *  编码只查表**一次**：pass 1 把字符串换成下标并把数字拍平成数组，pass 2 直接落盘。
 *  （早期版本两遍都查 Map ⇒ 90 万 posting + 90 万词频各查两次，实测 1154ms，比 gzip 还慢。）
 *
 *  完整性：任何越界/截断/类型不符一律抛错（调用方按「不可用 ⇒ 重建」处理），
 *  绝不返回半份索引 —— 「加载成功 ≠ 有数据」的纪律同向量制品。
 *--------------------------------------------------------------------------------------------*/

/** MAGIC = 'AMB35' + 0x00 0x00 + 0x01（格式版本） */
export const BM25_BIN_MAGIC = Buffer.from([0x41, 0x4d, 0x42, 0x33, 0x35, 0x00, 0x00, 0x01]);

// ── 写入侧：可增长字节缓冲 ───────────────────────────────────────────────
class ByteWriter {
	constructor(initial = 1 << 16) {
		this.buf = Buffer.allocUnsafe(initial);
		this.len = 0;
	}

	ensure(n) {
		const need = this.len + n;
		if (need <= this.buf.length) { return; }
		let cap = this.buf.length;
		while (cap < need) { cap *= 2; }
		const next = Buffer.allocUnsafe(cap);
		this.buf.copy(next, 0, 0, this.len);
		this.buf = next;
	}

	u32(v) {
		this.ensure(4);
		this.buf.writeUInt32LE(v >>> 0, this.len);
		this.len += 4;
	}

	f64(v) {
		this.ensure(8);
		this.buf.writeDoubleLE(v, this.len);
		this.len += 8;
	}

	/** LEB128 无符号变长整数（≤2^53 安全整数范围）。 */
	varint(v) {
		if (!Number.isSafeInteger(v) || v < 0) { throw new Error(`bm25 cache encode: not a non-negative safe integer (${v})`); }
		this.ensure(10);
		let rest = v;
		while (rest >= 0x80) { this.buf[this.len++] = (rest & 0x7f) | 0x80; rest = Math.floor(rest / 128); }
		this.buf[this.len++] = rest;
	}

	/** 直接把 UTF-8 写进底层缓冲（避免每个字符串一个临时 Buffer）。 */
	writeUtf8(s) {
		const need = Buffer.byteLength(s, 'utf8');
		this.ensure(need);
		const n = this.buf.write(s, this.len, 'utf8');
		this.len += n;
	}
}

// ── 读取侧：带越界检查的游标 ───────────────────────────────────────────
class ByteReader {
	constructor(buf, start = 0, end = buf.length) {
		this.buf = buf;
		this.pos = start;
		this.end = end;
	}

	get remaining() { return this.end - this.pos; }

	u32() {
		if (this.remaining < 4) { throw new Error('bm25 cache: truncated (u32)'); }
		const v = this.buf.readUInt32LE(this.pos);
		this.pos += 4;
		return v;
	}

	f64() {
		if (this.remaining < 8) { throw new Error('bm25 cache: truncated (f64)'); }
		const v = this.buf.readDoubleLE(this.pos);
		this.pos += 8;
		return v;
	}

	varint() {
		let result = 0;
		let shift = 1;
		for (let i = 0; i < 8; i++) {
			if (this.remaining < 1) { throw new Error('bm25 cache: truncated (varint)'); }
			const b = this.buf[this.pos++];
			result += (b & 0x7f) * shift;
			if ((b & 0x80) === 0) { return result; }
			shift *= 128;
		}
		throw new Error('bm25 cache: varint too long');
	}
}

/** varint 编码后的字节数（用于预先算字符串表长度）。 */
function varintSize(v) {
	let n = 1;
	let rest = v;
	while (rest >= 0x80) { rest = Math.floor(rest / 128); n++; }
	return n;
}

/** 写一张字符串表（每条 = varint 字节长度 + UTF-8 字节）。 */
function writeStringTable(w, list) {
	let bytes = 0;
	for (const s of list) { bytes += varintSize(Buffer.byteLength(s, 'utf8')) + Buffer.byteLength(s, 'utf8'); }
	w.varint(bytes);
	for (const s of list) {
		const len = Buffer.byteLength(s, 'utf8');
		w.varint(len);
		w.writeUtf8(s);
	}
}

/** 读一张字符串表（`count` 条，合计 `tableBytes` 字节）。 */
function readStringTable(r, count) {
	const tableBytes = r.varint();
	if (tableBytes < 0 || tableBytes > r.remaining) { throw new Error('bm25 cache: string table length out of range'); }
	const tableEnd = r.pos + tableBytes;
	const list = new Array(count);
	for (let i = 0; i < count; i++) {
		const len = r.varint();
		if (len < 0 || r.pos + len > tableEnd) { throw new Error('bm25 cache: string table overrun'); }
		list[i] = r.buf.toString('utf8', r.pos, r.pos + len);
		r.pos += len;
	}
	if (r.pos !== tableEnd) { throw new Error('bm25 cache: string table length mismatch'); }
	return list;
}

/**
 * 编码单个 agent 段。
 * @param {any} payload `BM25Index.serializePayload()` 的产物
 * @returns {Buffer}
 */
function encodeAgentSection(payload) {
	const entries = Array.isArray(payload?.entries) ? payload.entries : [];
	const inverted = Array.isArray(payload?.inverted) ? payload.inverted : [];
	const docTerms = Array.isArray(payload?.docTerms) ? payload.docTerms : [];

	// ── 两张字符串表：doc（文档 id + entry 内层 id）/ term（词条）
	const docIndex = new Map();
	const docList = [];
	const termIndex = new Map();
	const termList = [];
	const docId = (s) => {
		const key = typeof s === 'string' ? s : String(s);
		let i = docIndex.get(key);
		if (i === undefined) { i = docList.length; docList.push(key); docIndex.set(key, i); }
		return i;
	};
	const termId = (s) => {
		const key = typeof s === 'string' ? s : String(s);
		let i = termIndex.get(key);
		if (i === undefined) { i = termList.length; termList.push(key); termIndex.set(key, i); }
		return i;
	};

	// ── pass 1：字符串 → 下标；数字拍平成扁平数组（pass 2 不再查表）
	//  注意：这里**不用 for-of 解构**（90 万 posting + 90 万词频，解构开销实测占比不小）⇒ 全部走索引访问。
	const entryKey = [], entryInner = [], entryLen = [];
	for (let i = 0; i < entries.length; i++) {
		const row = entries[i];
		const key = row[0];
		const entry = row[1];
		const k = typeof key === 'string' ? key : String(key);
		// 内层 id 的兜底规则与 BM25Index.deserializePayload 一致：`entry?.id || key`
		const rawInner = entry?.id;
		const inner = (typeof rawInner === 'string' && rawInner) ? rawInner : k;
		entryKey.push(docId(k));
		entryInner.push(docId(inner));
		entryLen.push(Number(entry?.termCount ?? 0));
	}
	const invTerm = [], invPostOff = [], invPostFlat = [];
	for (let i = 0; i < inverted.length; i++) {
		const row = inverted[i];
		const term = row[0];
		invTerm.push(termId(typeof term === 'string' ? term : String(term)));
		invPostOff.push(invPostFlat.length);
		const list = Array.isArray(row[1]) ? row[1] : [];
		for (let j = 0; j < list.length; j++) {
			const id = list[j];
			invPostFlat.push(docId(typeof id === 'string' ? id : String(id)));
		}
	}
	invPostOff.push(invPostFlat.length); // 末尾哨兵：term i 的 posting = [off[i], off[i+1])
	const dtDoc = [], dtPairOff = [], dtPairTerm = [], dtPairCount = [];
	for (let i = 0; i < docTerms.length; i++) {
		const row = docTerms[i];
		const docIdStr = row[0];
		dtDoc.push(docId(typeof docIdStr === 'string' ? docIdStr : String(docIdStr)));
		dtPairOff.push(dtPairTerm.length);
		const list = Array.isArray(row[1]) ? row[1] : [];
		for (let j = 0; j < list.length; j++) {
			const pair = list[j];
			const term = pair?.[0];
			dtPairTerm.push(termId(typeof term === 'string' ? term : String(term)));
			dtPairCount.push(Number(pair?.[1] ?? 0));
		}
	}
	dtPairOff.push(dtPairTerm.length);

	// ── pass 2：落盘
	const w = new ByteWriter(1 << 20);
	w.u32(docList.length);
	writeStringTable(w, docList);
	w.u32(termList.length);
	writeStringTable(w, termList);

	w.u32(entries.length);
	for (let i = 0; i < entries.length; i++) {
		w.varint(entryKey[i]);
		w.varint(entryInner[i]);
		w.varint(entryLen[i]);
	}

	w.u32(inverted.length);
	for (let i = 0; i < inverted.length; i++) {
		w.varint(invTerm[i]);
		const start = invPostOff[i], end = invPostOff[i + 1];
		w.varint(end - start);
		for (let j = start; j < end; j++) { w.varint(invPostFlat[j]); }
	}

	w.u32(docTerms.length);
	for (let i = 0; i < docTerms.length; i++) {
		w.varint(dtDoc[i]);
		const start = dtPairOff[i], end = dtPairOff[i + 1];
		w.varint(end - start);
		for (let j = start; j < end; j++) { w.varint(dtPairTerm[j]); w.varint(dtPairCount[j]); }
	}

	w.f64(Number(payload?.totalDocLength ?? 0));
	return w.buf.subarray(0, w.len);
}

/**
 * 解码单个 agent 段。
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} length
 * @param {number} v payload 版本号（`deserializePayload` 要求 === 2）
 */
function decodeAgentSection(buf, start, length, v) {
	const r = new ByteReader(buf, start, start + length);
	const docCount = r.u32();
	const docs = readStringTable(r, docCount);
	const termCount = r.u32();
	const terms = readStringTable(r, termCount);

	const readDocIdx = () => {
		const i = r.varint();
		if (i >= docCount) { throw new Error(`bm25 cache: doc index out of range (${i}/${docCount})`); }
		return i;
	};
	const readTermIdx = () => {
		const i = r.varint();
		if (i >= termCount) { throw new Error(`bm25 cache: term index out of range (${i}/${termCount})`); }
		return i;
	};

	const entryCount = r.u32();
	const entries = new Array(entryCount);
	for (let i = 0; i < entryCount; i++) {
		const keyIdx = readDocIdx();
		const innerIdx = readDocIdx();
		const termCount2 = r.varint();
		entries[i] = [docs[keyIdx], { id: docs[innerIdx], termCount: termCount2 }];
	}

	const invertedCount = r.u32();
	const inverted = new Array(invertedCount);
	for (let i = 0; i < invertedCount; i++) {
		const termIdx = readTermIdx();
		const postingCount = r.varint();
		const postings = new Array(postingCount);
		for (let j = 0; j < postingCount; j++) { postings[j] = docs[readDocIdx()]; }
		inverted[i] = [terms[termIdx], postings];
	}

	const docTermsCount = r.u32();
	const docTerms = new Array(docTermsCount);
	for (let i = 0; i < docTermsCount; i++) {
		const docIdx = readDocIdx();
		const pairCount = r.varint();
		const pairs = new Array(pairCount);
		for (let j = 0; j < pairCount; j++) { pairs[j] = [terms[readTermIdx()], r.varint()]; }
		docTerms[i] = [docs[docIdx], pairs];
	}

	const totalDocLength = r.f64();
	if (r.remaining !== 0) { throw new Error(`bm25 cache: ${r.remaining} trailing bytes in agent section`); }
	return { v, entries, inverted, docTerms, totalDocLength };
}

/**
 * 编码（纯函数）。
 * @param {object} meta 制品元数据（version / fingerprint / builtAt / docs …；不含 agents）
 * @param {Record<string, any>} agents `<agentId>` → `BM25Index.serializePayload()` 的产物
 * @returns {Buffer}
 */
export function encodeBm25Cache(meta, agents) {
	const body = [];
	let bodyLen = 0;
	const headerAgents = {};
	for (const [agentId, payload] of Object.entries(agents ?? {})) {
		if (!payload) { continue; }
		const section = encodeAgentSection(payload);
		headerAgents[agentId] = { offset: bodyLen, length: section.length, v: Number(payload?.v ?? 2) };
		body.push(section);
		bodyLen += section.length;
	}
	const bodyBuf = Buffer.concat(body, bodyLen);
	const { agents: _drop, ...rest } = meta ?? {};
	const header = Buffer.from(JSON.stringify({ ...rest, agents: headerAgents, bodyBytes: bodyBuf.length }), 'utf8');
	const out = Buffer.alloc(BM25_BIN_MAGIC.length + 4 + header.length + bodyBuf.length);
	BM25_BIN_MAGIC.copy(out, 0);
	out.writeUInt32LE(header.length, BM25_BIN_MAGIC.length);
	header.copy(out, BM25_BIN_MAGIC.length + 4);
	bodyBuf.copy(out, BM25_BIN_MAGIC.length + 4 + header.length);
	return out;
}

/**
 * 解码（纯函数）。返回与旧 JSON 制品**同形**的对象：
 * `{ ...meta, agents: { <agentId>: { v, entries, inverted, docTerms, totalDocLength } } }`
 * —— 调用方（`BM25Index.deserializePayload`）不用区分新旧格式。
 * @param {Buffer} buf
 * @returns {object}
 */
export function decodeBm25Cache(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < BM25_BIN_MAGIC.length + 4) { throw new Error('bm25 cache: too short'); }
	if (!buf.subarray(0, BM25_BIN_MAGIC.length).equals(BM25_BIN_MAGIC)) { throw new Error('bm25 cache: bad magic'); }
	const headerLen = buf.readUInt32LE(BM25_BIN_MAGIC.length);
	const headerStart = BM25_BIN_MAGIC.length + 4;
	if (headerStart + headerLen > buf.length) { throw new Error('bm25 cache: truncated header'); }
	const header = JSON.parse(buf.toString('utf8', headerStart, headerStart + headerLen));
	const bodyStart = headerStart + headerLen;
	const bodyBytes = Number(header.bodyBytes);
	if (!Number.isInteger(bodyBytes) || bodyBytes < 0 || bodyStart + bodyBytes !== buf.length) {
		throw new Error(`bm25 cache: body length mismatch (header=${header.bodyBytes}, file=${buf.length - bodyStart})`);
	}
	const agents = {};
	for (const [agentId, info] of Object.entries(header.agents ?? {})) {
		const offset = Number(info?.offset);
		const length = Number(info?.length);
		if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > bodyBytes) {
			throw new Error(`bm25 cache: agent ${agentId} section out of range`);
		}
		agents[agentId] = decodeAgentSection(buf, bodyStart + offset, length, Number(info?.v ?? 2));
	}
	const { bodyBytes: _b, agents: _a, ...meta } = header;
	return { ...meta, agents };
}

/** 是不是二进制制品（读文件头 8 字节即可判定；用于兼容旧 `.json.gz`）。 */
export function isBm25Binary(buf) {
	return Buffer.isBuffer(buf) && buf.length >= BM25_BIN_MAGIC.length && buf.subarray(0, BM25_BIN_MAGIC.length).equals(BM25_BIN_MAGIC);
}
