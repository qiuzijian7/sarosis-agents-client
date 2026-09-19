/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 图谱制品「字节 → JSON 文本」解码核心（2026-09-18）。
 *
 * ── 为什么单独成模块 ─────────────────────────────────────────────────────
 * 这段逻辑原来内联在 `codebaseGraphPersistence._readJsonText()` 里，是`loadMerge` 五段中
 * **唯一整段跑、不可切片**的一段（实测 8MB 制品 `解压制品=506ms`，而其余四段都按 8ms 时间
 * 预算让出主线程）。用户日志 `vscode-app-1789719701320.log` 的看门狗（`[WsSwitchDiag]`）
 * 在该阶段反复量到 **343~1018ms 的交互排队** ⇒ 这是「点一下要等半秒」的直接来源。
 *
 * 拆出来是为了让**两条路径共用同一份语义**：
 *   · 主线程回退路径（`decodeArtifactBytes`）—— 与本模块外的旧行为逐字等价；
 *   · Worker 路径（`graphArtifactDecodeWorker.ts`）—— 同一套步骤搬出主线程。
 * 且本函数是**纯函数式**（无 DI、无 VS Code 依赖）⇒ 可在 Node 里直接单测三种格式的等价性 ✓
 *
 * ⚠ Worker 侧代码是**字符串模板**（不能 import 本文件），两边实现必须保持一致 —— 任何一侧
 * 改动都要同步另一侧（`graphArtifactDecodeWorker.ts` 顶部有对应提醒）。
 */

import { SLICE_BUDGET_MS, yieldToEventLoop } from '../common/asyncSlice.js';

/** Legacy 制品头（`CBMG` = CodeBase Memory Graph）：MAGIC + VERSION + uncompressedSize + gzip。 */
export const LEGACY_MAGIC = 0x43424d47;

/** gzip 魔数（两种变异）。 */
const GZIP_MAGIC_A = 0x1f8b0800;
const GZIP_MAGIC_B = 0x1f8b0808;

/**
 * 制品编码形态。
 * - `plain`：未压缩 JSON（回退路径）
 * - `gzip`：纯 gzip 流（当前格式）
 * - `gzip-legacy`：CBMG 头 + gzip（旧格式，前 12 字节是头）
 */
export type GraphArtifactMode = 'plain' | 'gzip' | 'gzip-legacy';

/** 解码结果 + 分段耗时（诊断用；`[loadMerge] 阶段耗时` 行会带上）。 */
export interface IArtifactDecodeResult {
	text: string;
	/** inflate（解压）耗时（`plain` 恒为 0）。 */
	msInflate: number;
	/** `TextDecoder` 解码耗时（40MB 量级时为百毫秒级，是本模块被搬走的主要原因之一）。 */
	msDecode: number;
}

/**
 * **仅解压**的结果（Phase 1b）：Worker 回传 `bytes`（transferable，零拷贝回主线程），
 * 文本解码交给主线程分块做（见 `decodeUtf8Chunked`）。
 */
export interface IArtifactInflateResult {
	bytes: Uint8Array;
	msInflate: number;
}

/**
 * 按文件头判定编码形态（只读 4 字节，零成本；无需解压）。
 *
 * 判定失败一律返回 `plain` —— 与旧实现「三种格式都试、都不像就按未压缩读」的口径一致。
 */
export function detectArtifactMode(bytes: Uint8Array): GraphArtifactMode {
	if (bytes.length >= 4) {
		const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const magic = dv.getUint32(0, false);
		if (magic === LEGACY_MAGIC) { return 'gzip-legacy'; }
		if (magic === GZIP_MAGIC_A || magic === GZIP_MAGIC_B) { return 'gzip'; }
	}
	return 'plain';
}

/**
 * 仅解压（不含文本解码）。返回解压后的字节。
 *
 * 实现与旧 `_gzipDecompress` 逐字等价（`DecompressionStream` 流式读 + 末尾一次性拼接），
 * 只是把两处行为写明了：① `writer.write/close` 的 promise 挂 `.catch`（避免未处理拒绝告警，
 * 真正的错误仍会从 `reader.read()` 抛出并被调用方捕获）；② 无 `DecompressionStream` 的环境
 * 退化为「假定未压缩」（与旧实现相同）。
 */
export async function inflateArtifactBytes(
	bytes: Uint8Array,
	mode: GraphArtifactMode,
): Promise<IArtifactInflateResult> {
	const t0 = performance.now();
	if (mode === 'plain') { return { bytes, msInflate: 0 }; }
	const payload = mode === 'gzip-legacy' ? bytes.slice(12) : bytes;
	if (typeof DecompressionStream === 'undefined') {
		return { bytes: payload, msInflate: performance.now() - t0 };
	}
	const ds = new DecompressionStream('gzip');
	const writer = ds.writable.getWriter();
	writer.write(payload as unknown as BufferSource).catch(() => { /* 读取侧会抛出真正的错误 */ });
	writer.close().catch(() => { /* 同上 */ });
	const reader = ds.readable.getReader();
	const chunks: Uint8Array[] = [];
	let totalLength = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) { break; }
		chunks.push(value);
		totalLength += value.length;
	}
	const out = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return { bytes: out, msInflate: performance.now() - t0 };
}

/**
 * 主线程解码核心（= Worker 不可用时的回退路径）。
 *
 * ★ 语义契约：**与优化前 `_readJsonText` 的输出逐字相同** —— 任何一级回退失败都不影响正确性，
 * 这也是「先加测量、再搬 Worker」能安全落地的前提。
 *
 * ⚠ 本函数**不让出主线程**（整段跑）：它正是被搬走的那段。若将来还要让它留在主线程，
 * 就必须在这里加分块解码（`TextDecoder.decode(chunk, { stream: true })` + 8ms 预算）。
 */
export async function decodeArtifactBytes(
	bytes: Uint8Array,
	mode: GraphArtifactMode,
): Promise<IArtifactDecodeResult> {
	const inflated = await inflateArtifactBytes(bytes, mode);
	const tDecode = performance.now();
	const text = new TextDecoder().decode(inflated.bytes);
	return { text, msInflate: inflated.msInflate, msDecode: performance.now() - tDecode };
}

/**
 * **分块**解码 utf8 → 字符串（按 `SLICE_BUDGET_MS` 让出主线程）—— Phase 1b（2026-09-18）。
 *
 * ## 为什么需要它（真机实测依据）
 *
 * 第一版把「inflate + `TextDecoder`」整体放 Worker，但 Worker **回传的是字符串** ⇒
 * structured clone 的**反序列化在调用方线程（主线程）**，且是**单块** ✗：
 * ```
 * 真机 vscode-app-1789723324679.log：
 *   解码制品=720ms｜解码=worker(读盘=82 / inflate=167 / decode=65)
 *   ⇒ Worker 内只花 167+65=232ms，整段却 720ms ⇒ 残余 ≈406~442ms 全在“回传 + 拷贝”
 * ```
 * 改法：Worker **只 inflate**，回传 **inflated bytes（transferable ⇒ 零拷贝）**；
 * 主线程再按时间预算**分块**解码 ⇒
 *   · 消掉那次 400ms 级的大克隆 ✓
 *   · 峰值内存下降（不再同时存在"Worker 侧明文字符串 + 主线程克隆副本"两份 70MB）✓
 *   · 解码总量不变（实测仅 65ms），但被切成 ≤8ms 的块，不再形成单块阻塞 ✓
 *
 * ⚠ 口径（别过度解读）：
 *   · 单块大小取 4MB —— 实测解码约 1GB/s ⇒ 单块 ≈4ms，稳在 8ms 预算内；
 *   · 收尾的 `parts.join('')` 是一次**整体拷贝**（70MB ≈ 20~40ms 单块）。这是刻意取舍：
 *     拼成一个大字符串是下游（手写逐字符 JSON 扫描）的前提；若要再压，得连同解析一起搬 Worker（Phase 2）。
 *   · 必须用 `{ stream: true }` 逐块喂，否则**多字节 UTF-8 字符被切断**会产生乱码 ✗（本仓历史事故类型）。
 */
export async function decodeUtf8Chunked(
	bytes: Uint8Array,
	opts?: { budgetMs?: number; chunkBytes?: number },
): Promise<{ text: string; msDecode: number; yields: number }> {
	const budget = opts?.budgetMs ?? SLICE_BUDGET_MS;
	const chunkBytes = opts?.chunkBytes ?? (4 * 1024 * 1024);
	const t0 = performance.now();
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let yields = 0;
	let sliceStart = performance.now();
	for (let i = 0; i < bytes.length;) {
		const end = Math.min(bytes.length, i + chunkBytes);
		parts.push(decoder.decode(bytes.subarray(i, end), { stream: true }));
		i = end;
		if (performance.now() - sliceStart >= budget) {
			await yieldToEventLoop();
			yields++;
			sliceStart = performance.now();
		}
	}
	parts.push(decoder.decode());	// flush 尾部未完成的多字节序列
	return { text: parts.join(''), msDecode: performance.now() - t0, yields };
}
