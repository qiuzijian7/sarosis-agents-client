/*---------------------------------------------------------------------------------------------
 *  向量制品二进制格式（2026-10-21）
 *
 *  背景：旧制品 `vector-cache.json.gz` 把每个 float32 写成十进制文本（`Array.from(Float32Array)`
 *  ⇒ 每维约 20 字符）。真机 18889 条 × 384 维：解压后 138MB、gzip 后 59.8MB；
 *  保存 = 主线程 `JSON.stringify` ≈1s + 线程池 gzip ≈5.8s；加载 = 主线程 gunzip+parse ≈1.3s。
 *  二进制把 float32 原样写出：28MB，编码 ≈15ms，加载 ≈22ms，数值逐位一致（实测 0 处差异）。
 *
 *  布局（小端）：
 *    [0..8)    MAGIC  'AMVEC\0\0\x01'（末字节 = 格式版本）
 *    [8..12)   u32    headerLen
 *    [12..)    header UTF-8 JSON：{ ...meta, agents: { <agentId>: { dim, ids: string[] } }, blobBytes }
 *    pad       补 0 至 4 字节对齐（Float32Array 视图要求）
 *    blob      所有向量按 agents 的键序、ids 的顺序依次拼接（float32）
 *
 *  不压缩：float32 尾数近似随机，gzip 只能 27.7MB → 24.2MB，换来的却是数秒线程池时间。
 *  完整性：header 记 `blobBytes`，长度对不上一律抛错（调用方按"不可用 ⇒ 重建"处理）。
 *--------------------------------------------------------------------------------------------*/

export const VECTOR_BIN_MAGIC = Buffer.from([0x41, 0x4d, 0x56, 0x45, 0x43, 0x00, 0x00, 0x01]);

const ALIGN = 4;

/**
 * 编码（纯函数）。
 * @param {object} meta 制品元数据（version / fingerprint / mode / agentModes / provider …；不含 agents）
 * @param {Record<string, Array<{id: string, vector: ArrayLike<number>}>>} agents
 * @returns {Buffer}
 */
export function encodeVectorCache(meta, agents) {
	/** @type {Record<string, {dim: number, ids: string[]}>} */
	const headerAgents = {};
	let total = 0;
	for (const [agentId, list] of Object.entries(agents ?? {})) {
		if (!Array.isArray(list) || list.length === 0) { continue; }
		const dim = list[0]?.vector?.length ?? 0;
		if (!dim) { continue; }
		const ids = [];
		const seen = new Set();
		for (const entry of list) {
			// 维度不一致的条目不写（同一分区混维度 ⇒ 余弦无意义；读回时也没法切片）
			if (entry?.vector?.length !== dim || typeof entry.id !== 'string') { continue; }
			// 同 id 重复只留第一条（header 的 ids 与 blob 必须一一对应）
			if (seen.has(entry.id)) { continue; }
			seen.add(entry.id);
			ids.push(entry.id);
		}
		if (ids.length === 0) { continue; }
		headerAgents[agentId] = { dim, ids };
		total += ids.length * dim;
	}
	const blobBytes = total * 4;
	const { agents: _drop, ...rest } = meta ?? {};
	const header = Buffer.from(JSON.stringify({ ...rest, agents: headerAgents, blobBytes }), 'utf8');
	const prefix = VECTOR_BIN_MAGIC.length + 4 + header.length;
	const pad = (ALIGN - (prefix % ALIGN)) % ALIGN;
	const out = Buffer.alloc(prefix + pad + blobBytes);
	VECTOR_BIN_MAGIC.copy(out, 0);
	out.writeUInt32LE(header.length, VECTOR_BIN_MAGIC.length);
	header.copy(out, VECTOR_BIN_MAGIC.length + 4);
	const blob = new Float32Array(out.buffer, out.byteOffset + prefix + pad, total);
	let off = 0;
	for (const [agentId, { dim, ids }] of Object.entries(headerAgents)) {
		const wanted = new Set(ids);
		for (const entry of agents[agentId]) {
			if (!wanted.has(entry.id) || entry.vector.length !== dim) { continue; }
			wanted.delete(entry.id); // 同 id 重复只写第一条（与 ids 列表一一对应）
			blob.set(entry.vector, off);
			off += dim;
		}
	}
	if (off !== total) { throw new Error(`vector cache encode: wrote ${off} floats, expected ${total}`); }
	return out;
}

/**
 * 解码（纯函数）。返回与旧 JSON 制品**同形**的对象（`agents: { id: [{id, vector: Float32Array}] }`），
 * 调用方不用区分新旧格式。向量是同一块**新分配**内存上的视图（不引用文件 Buffer）；
 * `VectorIndex.importVectors` 会再 `new Float32Array(entry.vector)` 逐条拷贝，这块内存随后可回收。
 * @param {Buffer} buf
 * @returns {object}
 */
export function decodeVectorCache(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < VECTOR_BIN_MAGIC.length + 4) { throw new Error('vector cache: too short'); }
	if (!buf.subarray(0, VECTOR_BIN_MAGIC.length).equals(VECTOR_BIN_MAGIC)) { throw new Error('vector cache: bad magic'); }
	const headerLen = buf.readUInt32LE(VECTOR_BIN_MAGIC.length);
	const headerStart = VECTOR_BIN_MAGIC.length + 4;
	if (headerStart + headerLen > buf.length) { throw new Error('vector cache: truncated header'); }
	const header = JSON.parse(buf.toString('utf8', headerStart, headerStart + headerLen));
	const prefix = headerStart + headerLen;
	const pad = (ALIGN - (prefix % ALIGN)) % ALIGN;
	const blobBytes = Number(header.blobBytes);
	if (!Number.isInteger(blobBytes) || blobBytes < 0 || prefix + pad + blobBytes !== buf.length) {
		throw new Error(`vector cache: blob length mismatch (header=${header.blobBytes}, file=${buf.length - prefix - pad})`);
	}
	// 拷贝到对齐的新内存（文件 Buffer 的 byteOffset 不保证 4 字节对齐）
	const floats = new Float32Array(blobBytes / 4);
	new Uint8Array(floats.buffer).set(buf.subarray(prefix + pad, prefix + pad + blobBytes));
	const agents = {};
	let off = 0;
	for (const [agentId, info] of Object.entries(header.agents ?? {})) {
		const dim = Number(info?.dim);
		const ids = Array.isArray(info?.ids) ? info.ids : [];
		if (!Number.isInteger(dim) || dim <= 0) { throw new Error(`vector cache: bad dim for ${agentId}`); }
		if (off + ids.length * dim > floats.length) { throw new Error(`vector cache: agent ${agentId} overruns blob`); }
		agents[agentId] = ids.map(id => {
			const vector = floats.subarray(off, off + dim);
			off += dim;
			return { id, vector };
		});
	}
	if (off !== floats.length) { throw new Error(`vector cache: ${floats.length - off} trailing floats`); }
	const { blobBytes: _b, agents: _a, ...meta } = header;
	return { ...meta, agents };
}

/** 是不是二进制制品（读文件头 8 字节即可判定；用于兼容旧 `.json.gz`）。 */
export function isVectorBinary(buf) {
	return Buffer.isBuffer(buf) && buf.length >= VECTOR_BIN_MAGIC.length && buf.subarray(0, VECTOR_BIN_MAGIC.length).equals(VECTOR_BIN_MAGIC);
}
