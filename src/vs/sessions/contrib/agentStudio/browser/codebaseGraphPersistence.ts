/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Graph Persistence — 压缩制品持久化。
 *
 * 复刻 codebase-memory-mcp 的 artifact 逻辑（src/pipeline/artifact.c）：
 *
 * codebase-memory-mcp 方案：
 *   1. graph.db.zst = zstd 压缩的 SQLite DB 文件（纯压缩流，无自定义 header）
 *   2. artifact.json = 独立元数据文件（schema_version, original_size, commit, node/edge counts）
 *   3. 原子写入：先写 .tmp，再 rename
 *   4. .gitattributes 防止 git 合并冲突
 *
 * 本项目方案（浏览器环境，无 zstd/SQLite）：
 *   1. graph.db.zst = gzip 压缩的 JSON（纯 gzip 流，无自定义 header）
 *   2. artifact.json = 独立元数据文件（同 codebase-memory-mcp 结构）
 *   3. 原子写入：先写 .tmp，再 rename
 *   4. 压缩格式记录在 artifact.json 中（compression: "gzip"），加载时自动探测
 *
 * 向后兼容：
 *   - 旧格式 CBMG header（MAGIC + VERSION + uncompressedSize + gzip）仍可读取
 *   - 纯 JSON 文件仍可读取
 */

import { CodebaseGraphStore } from './codebaseGraphStore.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
// ★ 2026-09-16：切换工作区「卡住」诊断 —— 本文件的 `loadMerge` 是切换后最重的同步段（分阶段计时见该方法）。
import { takeMaxBlockMs, wsStage } from './wsSwitchDiag.js';
import { IAgentStudioLogService } from './agentStudioLogService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { SLICE_CHECK_EVERY, sliceBudgetExceeded, yieldToEventLoop } from '../common/asyncSlice.js';

// Legacy format header (for backward compatibility)
const LEGACY_MAGIC = 0x43424d47;  // "CBMG" = CodeBase Memory Graph

// Artifact metadata schema version (matches codebase-memory-mcp)
const ARTIFACT_SCHEMA_VERSION = 1;
const ARTIFACT_COMPRESSION = 'gzip'; // browser doesn't support zstd

/** Artifact metadata (matches codebase-memory-mcp artifact.json structure) */
interface ArtifactMeta {
	schema_version: number;
	compression: string;        // "gzip" (browser) or "zstd" (codebase-memory-mcp)
	original_size: number;      // uncompressed JSON size in bytes
	compressed_size: number;    // compressed file size in bytes
	node_count: number;
	edge_count: number;
	created_at: string;         // ISO 8601 timestamp
}

// ---------------------------------------------------------------------------
// 流式加载：把「解压后的整段 JSON 一次性 JSON.parse」改为
// 「按顶层数组元素**分批** JSON.parse 并让出主线程」，消除启动 / 切换工作区加载
// 图谱时，因单次同步解析几十万节点/边而卡死 UI 的问题。
//
// ★ 2026-09-15：让出频率从**固定条数**（原每 2000 个元素）改为**时间预算**
// （`SLICE_BUDGET_MS` = 8ms，见 `common/asyncSlice.ts`）—— 固定条数在「元素大 /
// 机器慢」时单次连续占用仍可达几十~上百毫秒，表现为可感知的抽搐式卡顿。
//
// ★ 2026-09-16：在「时间预算」之上再加一层**批**（`PARSE_BATCH_ELEMENTS`）——
// 真机实测大头不是原生解析本身，而是**逐元素的搬运开销**（每个元素一次 `json.slice()`
// + 一次 `JSON.parse()` 调用）：一个 folder 的「解析 JSON」阶段 **10177ms**（合计 12369ms）。
// 按批后同样内容只需几百次调用 ⇒ **语义完全不变，开销直降**。
// ---------------------------------------------------------------------------

/**
 * 进度文案的最小推送间隔（ms）。
 *
 * 让出已按 8ms 预算细化 ⇒ 解析/合并过程中「每让出一次就报一次」会到每秒上百次，
 * 把 UI（提示条）刷爆。250ms 足够让人**看到在动**，又不会成负担。
 */
const PROGRESS_THROTTLE_MS = 250;

function _isWs(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** 跳过一个 JSON 值（字符串/对象/数组/原始值），返回该值之后的索引。字符串与嵌套结构均正确识别转义。 */
function _skipJsonValue(json: string, start: number): number {
	const n = json.length;
	let i = start;
	while (i < n && _isWs(json.charCodeAt(i))) { i++; }
	if (i >= n) { return i; }
	const c = json.charCodeAt(i);
	if (c === 0x22 /* " */) {
		i++;
		while (i < n) {
			const ch = json.charCodeAt(i);
			// 必须先判转义符，否则 \"（转义引号）会被误判为字符串结束
			if (ch === 0x5c /* \ */) { i += 2; continue; }
			if (ch === 0x22 /* " */) { return i + 1; }
			i++;
		}
		return i;
	}
	if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
		const close = c === 0x7b ? 0x7d : 0x5d;
		let depth = 0;
		let inStr = false;
		let esc = false;
		for (; i < n; i++) {
			const ch = json.charCodeAt(i);
			if (inStr) {
				if (esc) { esc = false; }
				else if (ch === 0x5c /* \ */) { esc = true; }
				else if (ch === 0x22 /* " */) { inStr = false; }
				continue;
			}
			if (ch === 0x22 /* " */) { inStr = true; }
			else if (ch === c) { depth++; }
			else if (ch === close) { depth--; if (depth === 0) { return i + 1; } }
		}
		return i;
	}
	// 原始值（数字/布尔/null）：遇到 , } ] 或空白即结束
	while (i < n) {
		const ch = json.charCodeAt(i);
		if (ch === 0x2c /* , */ || ch === 0x7d /* } */ || ch === 0x5d /* ] */ || _isWs(ch)) { break; }
		i++;
	}
	return i;
}

/**
 * **一批**元素用一次原生 `JSON.parse` 解析的数量上限（2026-09-16）。
 *
 * ── 为什么要有「批」（用户报「切换工作区卡住」的实测结论）──
 * 真机实测单 folder 阶段耗时：**解析 JSON = 10177ms** / 合计 12369ms（`[loadMerge] 阶段耗时…`）。
 * 而旧实现是「**逐元素** `json.slice()` + **逐元素** `JSON.parse()`」——18 万节点 = 18 万次小解析，
 * 每次都带一次子串分配 + 一次原生调用开销；解析器再快也架不住这种搬运量。
 * 改为「按批切片 + 一次原生解析」：同样内容只需几百次调用，且原生解析器一次吃下整段文本
 * ⇒ **纯搬运开销的消除，语义完全不变**（元素之间本来就是 `,` 分隔，补上外层方括号仍是合法数组）。
 *
 * 取 512：单批文本约 100KB 量级，原生解析 <1ms（远低于 8ms 切片预算），既摊薄了调用开销，
 * 又不会让单批撑破预算（超预算时会在让出**之前**先 `flush`）。
 */
export const PARSE_BATCH_ELEMENTS = 512;

/**
 * ★★★ 2026-09-18（P0 性能）：批量解析的**自适应批上限**（配合 `PARSE_BATCH_ELEMENTS` 作下限）。
 *
 * 问题：批固定 512 时，一份 14 万节点 / 41 万边的制品要上千次 `JSON.parse` + `slice` + 回调 ——
 * 这些**每次批都要付的固定开销**在「解析 JSON」里占比可观（真机 3 folder ≈ 7320ms），
 * 而单批 512 个元素的 `JSON.parse` 实测只有零点几毫秒 ⇒ 批明显偏小。
 *
 * 但不能直接调大：批越大，**单次连续占用**越长（`SLICE_BUDGET_MS = 8ms` 是 UI 卡顿的防线）。
 * ⇒ 用**实测本批解析耗时**自适应（见 `forEachArrayBatch` 的 `flush`）：
 *   · 本批 `parseMs < 4` ⇒ 下次翻倍（摊薄固定开销，上限本常量）；
 *   · 本批 `parseMs ≥ 8` ⇒ 下次减半（不低于 `PARSE_BATCH_ELEMENTS`），把单次切片压回预算内。
 * 效果可由现有诊断直接验证：`stage('nodes', …)` 里的「批量解析 Xms / N 批」。
 */
export const PARSE_BATCH_MAX_ELEMENTS = 4096;

/**
 * 一个顶层数组的解析统计（**诊断用**，2026-09-16）。
 *
 * 为什么要有它：`[loadMerge] 阶段耗时` 只报「解析 JSON = 10177ms」这一个总数，
 * 无法判断时间花在**扫描边界**（纯 `charCodeAt` 循环）还是**原生解析**，也无法判断是
 * nodes / edges / fileHashes 哪一个（或 `bm25`/`layout` 那种**单次整体 parse**）。
 * 实测（2026-09-16 基准，180k 节点 / 40.4MB）：扫描 178ms + 逐元素解析 121ms ⇒ 只占 10.2s 的零头，
 * 说明大头**不在**这条路径上 ⇒ 必须有分解数据才能继续定位（见 `loadMerge` 的「解析分解」行）。
 */
export interface IArrayParseStats {
	/** 已解析元素数。 */
	elements: number;
	/** 扫元素边界（`_skipJsonValue`）累计耗时。 */
	scanMs: number;
	/** 原生 `JSON.parse` 累计耗时。 */
	parseMs: number;
	/** 批次数。 */
	batches: number;
}

/**
 * 遍历数组内的每个顶层元素，**按批**解析后回调 `onBatch`（批内元素顺序与原文一致）。
 *
 * 逗号分隔符即切分，嵌套结构由 `_skipJsonValue` 处理。
 *
 * ★ 让出策略仍是**按时间预算**（`SLICE_BUDGET_MS`，见 `common/asyncSlice.ts`）—— 固定条数在
 * 「元素大 / 机器慢」时单次连续占用仍可达几十~上百毫秒，表现为可感知的抽搐式卡顿。
 * ⚠ 让出**之前**必须先 `flush()`：否则批会跨 yield 越攒越大，单批耗时不再受 512 约束。
 *
 * 导出仅为可测（`codebaseGraphPersistence.test.ts` 直接断言边界与特殊字符）。
 * `stats` 为可选诊断出参（不影响任何行为）。
 */
export async function forEachArrayBatch<T>(
	json: string, openIdx: number, closeIdx: number,
	onBatch: (items: T[]) => void,
	stats?: IArrayParseStats,
): Promise<number> {
	let i = openIdx + 1;
	let count = 0;
	let sliceStart = performance.now();
	/** 本批**首个元素起点**与**末个元素终点**：`json.slice(start, end)` 即「去掉外层方括号的整批文本」。 */
	let batchStart = -1;
	let batchEnd = -1;
	let batchCount = 0;
	/** 自适应批大小（见 `PARSE_BATCH_MAX_ELEMENTS`）：初始为下限，按实测单批耗时放大/缩小。 */
	let batchLimit = PARSE_BATCH_ELEMENTS;

	const flush = (): void => {
		if (batchCount === 0) { return; }
		// 元素之间原本就是 `,` ⇒ 补上外层方括号即为合法 JSON 数组（首尾空白与缩进都不影响）
		const t0 = performance.now();
		const items = JSON.parse(`[${json.slice(batchStart, batchEnd)}]`) as T[];
		const parseMs = performance.now() - t0;
		if (stats) { stats.parseMs += parseMs; stats.batches++; stats.elements += items.length; }
		// ★★★ 2026-09-18（P0 性能）：自适应批大小 —— 太快就放大（摊薄每批的固定开销），
		// 太慢就缩小（守住 `SLICE_BUDGET_MS = 8ms` 的单次连续占用预算）。见 `PARSE_BATCH_MAX_ELEMENTS`。
		if (parseMs < 4 && batchLimit < PARSE_BATCH_MAX_ELEMENTS) {
			batchLimit = Math.min(PARSE_BATCH_MAX_ELEMENTS, batchLimit * 2);
		} else if (parseMs >= 8 && batchLimit > PARSE_BATCH_ELEMENTS) {
			batchLimit = Math.max(PARSE_BATCH_ELEMENTS, batchLimit >> 1);
		}
		batchCount = 0;
		batchStart = -1;
		batchEnd = -1;
		onBatch(items);
	};

	while (i < closeIdx) {
		while (i < closeIdx && (_isWs(json.charCodeAt(i)) || json.charCodeAt(i) === 0x2c /* , */)) { i++; }
		if (i >= closeIdx) { break; }
		if (json.charCodeAt(i) === 0x5d /* ] */) { break; }
		const tScan = stats ? performance.now() : 0;
		const eEnd = _skipJsonValue(json, i);
		if (stats) { stats.scanMs += performance.now() - tScan; }
		if (batchCount === 0) { batchStart = i; }
		batchEnd = eEnd;
		batchCount++;
		count++;
		i = eEnd;
		if (batchCount >= batchLimit) { flush(); }
		if ((count % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
			flush();
			await yieldToEventLoop();
			sliceStart = performance.now();
		}
	}
	flush();
	// 返回**闭合方括号之后**的位置 = 该数组值的终点，调用方据此继续下一个键。
	// ★ 有了它，调用方就**不必**先对整个数组做一次「值边界扫描」—— 那正是本次优化省掉的那一遍
	// （实测 141800 节点 / 414285 边那份制品：值边界扫描 489ms + 347ms ≈ **836ms**，
	//  占「解析 JSON 1712ms」的近一半，纯属把同一段文本扫两遍）。
	return json.charCodeAt(i) === 0x5d /* ] */ ? i + 1 : i;
}

/**
 * 增量解析图谱 JSON，返回与旧 _readData 同形的 data 对象，但在解析 nodes/edges/fileHashes
 * 时**按批**解析（`PARSE_BATCH_ELEMENTS`，2026-09-16）并让出主线程，避免单次同步 JSON.parse
 * 卡死 UI、也避免逐元素解析的搬运开销。
 *
 * @param onProgress 解析进度的**文案回调**（2026-09-15，方案 ⑥）：大图解析要几十秒，
 *        只给「正在读取并解析制品…」一句会让用户以为卡死 ⇒ 这里给出「已解析 N 节点 / M 边」。
 *        节流由调用方负责（每批回调一次；早期实现是每 yield 一次回调一次，会到每秒上百次）。
 * @param onStage **分键耗时**回调（2026-09-16，诊断）：逐字段报「边界扫描 / 批量解析 / 单次整体解析」。
 *        2026-09-16 实测教训：只知道「解析 JSON = 10177ms」这一个总数**找不出**优化点 ——
 *        基准显示 nodes/edges 那条路的扫描+解析只占零头，而 `bm25`/`layout` 是**单次整体解析**
 *        （不可切片）⇒ 必须按字段分解才能定位。
 */
async function _parseGraphStreaming(
	json: string,
	onProgress?: (nodes: number, edges: number) => void,
	onStage?: (label: string, ms: number, extra?: string) => void,
	opts?: { skipBm25?: boolean },
): Promise<any> {
	/** 分键耗时上报（诊断）。`onStage` 缺省时只多一次 `if`。 */
	const stage = (label: string, t0: number, extra?: string): void => {
		if (onStage) { onStage(label, Math.round(performance.now() - t0), extra); }
	};
	const data: any = {
		nodes: [], edges: [], fileHashes: [],
		bm25: undefined, layout: [], nextNodeId: 1, nextEdgeId: 1,
	};
	const n = json.length;
	let i = 0;
	while (i < n && json.charCodeAt(i) !== 0x7b /* { */) { i++; }
	if (i >= n) {
		throw new Error('[GraphPersistence] invalid graph artifact: missing root object');
	}
	i++; // 跳过 {
	while (i < n) {
		while (i < n && (_isWs(json.charCodeAt(i)) || json.charCodeAt(i) === 0x2c /* , */)) { i++; }
		if (i >= n) { break; }
		const ch = json.charCodeAt(i);
		if (ch === 0x7d /* } */) { i++; break; }
		if (ch !== 0x22 /* " */) { i++; continue; }
		const keyEnd = _skipJsonValue(json, i);
		const key = JSON.parse(json.slice(i, keyEnd));
		i = keyEnd;
		while (i < n && (_isWs(json.charCodeAt(i)) || json.charCodeAt(i) === 0x3a /* : */)) { i++; }
		const vStart = i;
		const isArrayValue = json.charCodeAt(vStart) === 0x5b /* [ */;
		// ★★ 2026-09-16（第二轮优化）：**数组键不做「值边界扫描」**。
		// `forEachArrayBatch` 的元素扫描本身就会停在 `]` 并返回其后的位置 ⇒ 先整段扫一遍找值边界，
		// 等于把同一段文本扫两遍。实测（141800 节点 / 414285 边那份制品）：值边界 489ms + 347ms ≈ **836ms**，
		// 占「解析 JSON 1712ms」的近一半 —— 这就是本轮省掉的那一遍。
		// 非数组（`bm25` / `layout` / 标量）仍需先扫边界：它们要整段 `json.slice()` 交给 `JSON.parse`。
		const streamedArray = isArrayValue && (key === 'nodes' || key === 'edges' || key === 'fileHashes');
		const tValueScan = performance.now();
		const vEnd = streamedArray ? -1 : _skipJsonValue(json, i);
		// ★ 值边界的**字符级扫描**也是真金白银（`bm25` / `layout` 这类大对象没有切片，一次扫完）。
		// 单列出来，避免把它错算进「原生解析」而找错优化方向。
		const valueScanMs = streamedArray ? 0 : Math.round(performance.now() - tValueScan);
		const raw = streamedArray ? '' : json.slice(vStart, vEnd);
		const tKey = performance.now();
		/** 流式数组的元素终点（由 `forEachArrayBatch` 返回；`-1` = 本键不是流式数组）。 */
		let streamedEnd = -1;
		switch (key) {
			case 'nodes': {
				if (isArrayValue) {
					const st: IArrayParseStats = { elements: 0, scanMs: 0, parseMs: 0, batches: 0 };
					// 上界传 `json.length`：循环在数组的 `]` 处停下并返回其后位置 ⇒ 无需预先算值边界
					streamedEnd = await forEachArrayBatch<any>(json, vStart, json.length, (items) => {
						// 逐个 push（不用 `push(...items)`）：批本身有上限，但避免任何一次性大数组展开
						for (const it of items) { data.nodes.push(it); }
						// 进度按**批**上报（旧实现逐元素；节流在调用方 ⇒ 批内逐条上报纯属浪费）
						onProgress?.(data.nodes.length, data.edges.length);
					}, st);
					stage('nodes', tKey, `${st.elements} 个（元素扫描 ${Math.round(st.scanMs)}ms / 批量解析 ${Math.round(st.parseMs)}ms / ${st.batches} 批；值边界已省）`);
				} else {
					data.nodes = undefined; // 非数组 → 交给 _validateGraphData 拒绝
					stage('nodes', tKey, `⚠ 非数组（值边界 ${valueScanMs}ms）`);
				}
				break;
			}
			case 'edges': {
				if (isArrayValue) {
					const st: IArrayParseStats = { elements: 0, scanMs: 0, parseMs: 0, batches: 0 };
					streamedEnd = await forEachArrayBatch<any>(json, vStart, json.length, (items) => {
						for (const it of items) { data.edges.push(it); }
						onProgress?.(data.nodes.length, data.edges.length);
					}, st);
					stage('edges', tKey, `${st.elements} 个（元素扫描 ${Math.round(st.scanMs)}ms / 批量解析 ${Math.round(st.parseMs)}ms / ${st.batches} 批；值边界已省）`);
				} else {
					data.edges = undefined;
					stage('edges', tKey, `⚠ 非数组（值边界 ${valueScanMs}ms）`);
				}
				break;
			}
			case 'fileHashes': {
				if (isArrayValue) {
					const st: IArrayParseStats = { elements: 0, scanMs: 0, parseMs: 0, batches: 0 };
					streamedEnd = await forEachArrayBatch<any>(json, vStart, json.length, (items) => {
						for (const it of items) { data.fileHashes.push(it); }
					}, st);
					stage('fileHashes', tKey, `${st.elements} 个（元素扫描 ${Math.round(st.scanMs)}ms / 批量解析 ${Math.round(st.parseMs)}ms / ${st.batches} 批；值边界已省）`);
				} else {
					data.fileHashes = undefined;
					stage('fileHashes', tKey, `⚠ 非数组（值边界 ${valueScanMs}ms）`);
				}
				break;
			}
			case 'bm25':
				// ★★★ 2026-09-18（P0 性能）：调用方声明「检索由 FTS5 提供」时**连解析都跳过** ——
				// legacy 全量档制品里的 bm25 可达数 MB，而它是**不可切片的单次整体 parse**。
				if (opts?.skipBm25) {
					stage('bm25', tKey, `${(raw.length / 1024 / 1024).toFixed(1)}MB **跳过解析**（检索走 FTS5，内存倒排改为按需重建）`);
				} else {
					data.bm25 = JSON.parse(raw);
					// ⚠ 这一句是**单次整体解析**，无法切片（`bm25` 是对象，不是可逐元素的数组）
					stage('bm25', tKey, `${(raw.length / 1024 / 1024).toFixed(1)}MB 文本**单次**解析 + 值边界扫描 ${valueScanMs}ms`);
				}
				break;
			case 'layout':
				data.layout = JSON.parse(raw);
				stage('layout', tKey, `${(raw.length / 1024 / 1024).toFixed(1)}MB 文本**单次**解析 + 值边界扫描 ${valueScanMs}ms`);
				break;
			case 'nextNodeId':
				data.nextNodeId = JSON.parse(raw);
				stage('nextNodeId', tKey, `值边界 ${valueScanMs}ms`);
				break;
			case 'nextEdgeId':
				data.nextEdgeId = JSON.parse(raw);
				stage('nextEdgeId', tKey, `值边界 ${valueScanMs}ms`);
				break;
			default:
				stage(key, tKey, `未使用（值边界 ${valueScanMs}ms / ${Math.round(raw.length / 1024)}KB）`);
				break;
		}
		// 流式数组：终点来自元素扫描（省掉了预扫描）；其余键仍用值边界扫描的结果
		i = streamedEnd >= 0 ? streamedEnd : vEnd;
	}
	return data;
}

export class GraphPersistence {
	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IAgentStudioLogService private readonly _logService?: ILogService,
	) { }

	/**
	 * Save store as compressed artifact.
	 * Writes graph.db.zst (pure gzip stream, no header) + artifact.json (metadata).
	 * Uses atomic write (write to .tmp, then rename).
	 * @param opts.slim 双档导出之 slim 档（对齐 C 手动导出 drop indexes + VACUUM）：
	 *   剔除可重建的 bm25 倒排与 layout 3D 坐标 → 制品显著缩小。
	 *   ⚠ 2026-09-18 更正（原注释称「自动保存/watcher 路径不传、全量保真」**与代码不符**，曾误导排查）：
	 *   **当前所有落盘路径都是 slim 档** —— 自动保存 `codebaseGraphService` 的
	 *   `persistence.save(..., { slim: true }, ...)`、`exportArtifact` 默认 `slim = true`（`?? true`）。
	 *   ⇒ 制品里**本就没有** bm25/layout；因此**不需要**「加载侧一律重建倒排」，是否重建改由
	 *   `load()/loadMerge()` 的 `opts.skipBm25`（= 检索是否由 FTS5 提供）决定，
	 *   见 `CodebaseGraphStore._bm25Deferred` 的契约。
	 */
	async save(store: CodebaseGraphStore, targetPath: string, project?: string, opts?: { slim?: boolean }, onProgress?: (writtenMB: number) => void): Promise<void> {
		// Yield before heavy operation to let UI update
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		const savedNodeCount = project ? store.getNodeCount(project) : store.getNodeCount();
		const savedEdgeCount = project ? store.getEdgeCount(project) : store.getEdgeCount();

		// 轻量元数据（不构建 nodes/edges 数组），避免 toJSON 的 2x 峰值
		const meta = store.getMeta(project);

		// slim 档（对齐 C 手动导出档）：剔除可重建的 bm25/layout；自动保存路径为全量档
		const slim = opts?.slim === true;

		// 流式构造 JSON 分片 → 经 gzip 管道写出。
		// 关键：逐块 JSON.stringify 后即喂入压缩流，绝不同时持有「活 store + 序列化对象 + 巨型 JSON 串 + 压缩缓冲」，
		// 把落盘峰值从 ~3x 图体积压到 ~1.x（对齐 codebase-memory-mcp dump_to_sqlite 的分片 + 早释放）。
		const buildChunks = function* (s: CodebaseGraphStore, proj: string | undefined, m: typeof meta): Iterable<string> {
			yield '{"nodes":[';
			let first = true;
			for (const node of s.iterateNodes(proj)) {
				if (!first) { yield ','; }
				first = false;
				yield JSON.stringify(node);
			}
			yield '],"edges":[';
			first = true;
			for (const edge of s.iterateEdges(proj)) {
				if (!first) { yield ','; }
				first = false;
				yield JSON.stringify(edge);
			}
			yield ']';
			yield ',"fileHashes":' + JSON.stringify(m.fileHashes ?? []);
			if (slim) {
				// slim 档：bm25/layout 可重建 → 剔除（对齐 C 手动导出 drop indexes）
				yield ',"bm25":null,"layout":[]';
			} else {
				yield ',"bm25":' + JSON.stringify(m.bm25 ?? null);
				yield ',"layout":' + JSON.stringify(m.layout ?? []);
			}
			yield ',"nextNodeId":' + (m.nextNodeId ?? 1) + ',"nextEdgeId":' + (m.nextEdgeId ?? 1) + '}';
		};

		const { compressed, originalSize } = await this._streamingGzip(buildChunks(store, project, meta), onProgress);

		// Atomic write: write to .tmp, then rename
		const tmpPath = targetPath + '.tmp';
		await this._fileService.writeFile(URI.file(tmpPath), VSBuffer.wrap(compressed));

		// Rename .tmp → target (atomic on most filesystems)
		try {
			await this._fileService.move(URI.file(tmpPath), URI.file(targetPath), true);
		} catch {
			// Fallback: if move fails (e.g., cross-device), write directly
			await this._fileService.writeFile(URI.file(targetPath), VSBuffer.wrap(compressed));
			try { await this._fileService.del(URI.file(tmpPath)); } catch { /* ignore */ }
		}

		// Write artifact.json metadata (same directory as graph.db.zst)
		const metaInfo: ArtifactMeta = {
			schema_version: ARTIFACT_SCHEMA_VERSION,
			compression: ARTIFACT_COMPRESSION,
			original_size: originalSize,
			compressed_size: compressed.length,
			node_count: savedNodeCount,
			edge_count: savedEdgeCount,
			created_at: new Date().toISOString(),
		};
		const metaPath = targetPath.replace(/graph\.db\.\w+$/, 'artifact.json');
		const metaJson = JSON.stringify(metaInfo, null, 2);
		await this._fileService.writeFile(URI.file(metaPath), VSBuffer.fromString(metaJson));
	}

	/**
	 * Load store from compressed artifact.
	 * Supports: pure gzip stream (new), CBMG header (legacy), plain JSON (fallback).
	 * Uses async chunked loading to avoid UI freeze.
	 */
	async load(store: CodebaseGraphStore, sourcePath: string, opts?: { skipBm25?: boolean }): Promise<boolean> {
		const json = await this._readJsonText(sourcePath);
		if (!json) { return false; }
		const data = await _parseGraphStreaming(json, undefined, undefined, opts);
		// ★ 2026-09-18：本方法已改为 async（内部按 8ms 预算让出）⇒ 必须 await，否则校验会与迁移并发
		await this._normalizeLoadedPaths(data, sourcePath);
		// 导入前完整性校验（对齐 C 版 cbm_store_check_integrity_deep 的导入门）
		if (!await this._validateGraphData(data, sourcePath)) { return false; }
		// Async chunked loading to avoid UI freeze
		await store.fromJSONAsync(data);
		// ★★★ 2026-09-18（P0 性能）：调用方声明「检索由 FTS5 提供」（`opts.skipBm25`）⇒ **不再全量重建**
		// 内存倒排，只置「待按需重建」标记（见 `CodebaseGraphStore._bm25Deferred`）：真机此处
		// `BM25 重建=9137ms` / `⛔主线程阻塞 ≈2393ms`，而默认检索走主进程 FTS5 ⇒ 多数时候白付 ✗。
		if (opts?.skipBm25 && (data.nodes?.length ?? 0) > 0) {
			store.markBM25Deferred();
			this._logService?.info('[GraphPersistence]', `[load] 跳过内存 BM25 重建（检索走 FTS5）⇒ 已置「按需重建」标记：${sourcePath}`);
			return true;
		}
		// slim 档制品（无 bm25）→ 加载后重建倒排，否则 search_graph query 静默无结果。
		// force=true：加载路径无脏集，增量模式（默认）会空转导致索引仍为空。
		if (!data.bm25 && (data.nodes?.length ?? 0) > 0) {
			await store.rebuildBM25(undefined, true);
		}
		return true;
	}

	/**
	 * 合并加载：把 sourcePath 的图谱【追加】到 store（不清空），用于多 folder 工作区。
	 * @param projectOverride 覆盖合并进来的所有节点/边的项目名（确保各 folder 项目名唯一）。
	 */
	async loadMerge(store: CodebaseGraphStore, sourcePath: string, projectOverride?: string, onProgress?: (line: string) => void, opts?: { skipBm25?: boolean }): Promise<boolean> {
		// 进度节流（方案 ⑥）：解析/合并已按 8ms 时间预算切片 ⇒ 每让出一次都推 UI 会到每秒上百次。
		let lastReportAt = 0;
		const report = (line: string, force = false): void => {
			if (!onProgress) { return; }
			const now = performance.now();
			if (!force && now - lastReportAt < PROGRESS_THROTTLE_MS) { return; }
			lastReportAt = now;
			onProgress(line);
		};

		// ★★★ 2026-09-16 诊断（用户报「每次切换工作区 app 就卡住」）：把下面五段**逐段计时**并汇总成一行。
		//
		// 为什么必须分段：这五段都是**主线程上的 CPU 重活**，而其中**只有解析与合并**按 8ms 时间预算切片
		// （见 `_parseGraphStreaming` / `mergeFromJSONAsync`），**解压、路径迁移、完整性校验是整段跑的**。
		// 旧日志只有调用方那一行 `merged … (5432ms)`（2026-09-15 实测），无法判断该优化哪一段。
		//
		// 同时给每段打 `wsStage()`：主线程被阻塞时日志**写不出去**，看门狗（`wsSwitchDiag.ts`）
		// 会在阻塞结束后把「当时在哪一段」补报出来 —— 这正是定位卡住所需要的。
		const phases: string[] = [];
		let phasesTotal = 0;
		// 制品文件名（日志里用来区分多 folder —— 本类没有 service 的 `_basename`，就地取末段）
		const label = sourcePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? sourcePath;
		// ★★ 2026-09-19：每段同时记「**该段内主线程最长连续占用**」（`takeMaxBlockMs()` 读+清零 ✓）。
		// 动机（真机日志）：看门狗报 `交互延迟 ≈2039ms（阶段=graph: 写入内存 store（graph.db.zst））` ✗，
		// 但这个阶段名只能说明"当时在跑这一步"——**阶段耗时（含 await）≠ 主线程被占** ✗：
		// `写 store` / `解析 JSON` 这类阶段可能大量在等 IO / worker / GC。
		// 有了 `[阻塞Nms]` 才能区分「**真的占住主线程**」与「只是慢」✓✓
		// （与增量索引 `_seg` 同口径 ✓；注意**不能**用 `asyncSlice.takeMaxSliceMs()`：
		//   它只在切片循环里被喂 ⇒ 这些阶段多数不走切片 ⇒ 必然假阴性 ✗）
		const timed = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
			wsStage(`graph: ${name}（${label}）`);
			const t0 = Date.now();
			try {
				return await fn();
			} finally {
				const ms = Date.now() - t0;
				const blockMs = Math.round(takeMaxBlockMs());
				phasesTotal += ms;
				phases.push(`${name}=${ms}ms${blockMs > 12 ? `[阻塞${blockMs}ms]` : ''}`);
			}
		};
		const logPhases = (note: string): void => {
			this._logService?.info('[GraphPersistence]', `[loadMerge] 阶段耗时（${label}）：${phases.join(' / ')}｜合计 ${phasesTotal}ms${note}`);
		};

		const json = await timed('解压制品', () => this._readJsonText(sourcePath));
		if (!json) { return false; }
		report('已解压，正在解析节点/边…', true);
		// ★ 2026-09-16 诊断：把「解析 JSON」**再分解到字段**（见 `_parseGraphStreaming` 的 `onStage`）。
		// 动机：只知道总数（实测单 folder 10177ms）时无从下手 —— 基准显示 nodes/edges 那条路
		// （元素扫描 + 批量解析）只占零头，而 `bm25` / `layout` 是**单次整体解析**（不可切片），
		// 必须靠这行把两者分开，才能判断该优化哪一边。
		const parseDetail: string[] = [];
		const data = await timed('解析 JSON', () => _parseGraphStreaming(
			json,
			(nodes, edges) => report(`解析中：${nodes} 节点 / ${edges} 边`),
			(label2, ms, extra) => parseDetail.push(`${label2}=${ms}ms${extra ? ` 〔${extra}〕` : ''}`),
			opts,
		));
		if (parseDetail.length > 0) {
			this._logService?.info('[GraphPersistence]', `[loadMerge] 解析分解（${label}）：${parseDetail.join(' / ')}`);
		}
		// 路径格式迁移：旧版本多 folder 下非 folders[0] 的文件路径/QN/哈希键被存成绝对路径
		await timed('路径迁移', () => this._normalizeLoadedPaths(data, sourcePath));
		report('正在校验并写入内存图谱…', true);
		// 导入前完整性校验（合并路径同样适用）
		if (!await timed('完整性校验', () => this._validateGraphData(data, sourcePath))) {
			logPhases('｜⚠ 制品未通过校验，已拒绝导入');
			return false;
		}
		const stats = await timed('写入内存 store', () => store.mergeFromJSONAsync(data, projectOverride, (loaded, total) => report(`写入内存图谱：${loaded}/${total}`)));
		// ★★★ 2026-09-18（P0 性能）：本类**不在合并路径重建 BM25**（重建在 service 侧，且是 3 folder 里
		// 最贵的一段：真机 9137ms / ⛔主线程阻塞 2393ms）。调用方声明「检索走 FTS5」时只置
		// 「待按需重建」标记 ⇒ 省下每次加载都白付的这笔钱 ✓（契约见 `CodebaseGraphStore._bm25Deferred`）。
		if (opts?.skipBm25) {
			store.markBM25Deferred();
			phases.push('BM25=跳过（按需重建）');
		}
		logPhases('');
		// 重复合并必须**可见**（2026-09-15）：实测制品 49.6% 节点是重复的，而旧实现完全静默。
		if (stats.nodesSkipped > 0 || stats.edgesSkipped > 0) {
			this._logService?.warn('[GraphPersistence]', `[loadMerge] deduped ${stats.nodesSkipped} duplicate node(s) / ${stats.edgesSkipped} duplicate edge(s) from ${sourcePath} — artifact had repeats or was merged twice (kept ${stats.nodesAdded} new node(s), ${stats.edgesAdded} new edge(s))`);
		}
		return true;
	}

	/**
	 * 路径格式迁移：旧版 `_getRelativePath` 只试 folders[0]，导致第二 folder 的
	 * filePath/qualifiedName/fileHashes.relPath 全部存成绝对路径——
	 * watcher 的 root-relative 键永远匹配不上（每轮误报全量变更），
	 * 重索引时新旧格式并存产生重复节点。加载时统一归一化为 root 相对路径。
	 */
	private async _normalizeLoadedPaths(data: any, sourcePath: string): Promise<void> {
		// graph.db.zst 位于 <root>/.codebase-memory/ → root 为上两级目录
		const norm = sourcePath.replace(/\\/g, '/');
		const parts = norm.split('/');
		if (parts.length < 3) { return; }
		const root = parts.slice(0, -2).join('/');
		const prefix = root.toLowerCase() + '/';
		const strip = (p: string): string => {
			const n = p.replace(/\\/g, '/');
			return n.toLowerCase().startsWith(prefix) ? n.substring(prefix.length) : n;
		};
		// ★★★ 2026-09-18（P0 性能）：本段原为**整段跑**的 O(节点+哈希) 全量扫描（十几万节点 ⇒
		// 主线程连续占用数百 ms，看门狗会报 `⛔ 主线程阻塞`）。BM25 收口后，它与「完整性校验」
		// 是加载路径上**仅剩的不可切片**重活 ⇒ 同样按 `SLICE_BUDGET_MS = 8ms` 预算让出。
		// ⚠ 语义零变化：`data` 是本次载入的局部对象，让出期间不会被别人改。
		let sliceStart = performance.now();
		let migrated = 0;
		let scanned = 0;
		for (const nd of data.nodes ?? []) {
			if (typeof nd.filePath === 'string') {
				const s = strip(nd.filePath);
				if (s !== nd.filePath) { migrated++; }
				nd.filePath = s;
			}
			if (typeof nd.qualifiedName === 'string') { nd.qualifiedName = strip(nd.qualifiedName); }
			if ((++scanned % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
				await yieldToEventLoop();
				sliceStart = performance.now();
			}
		}
		for (const h of data.fileHashes ?? []) {
			if (typeof h.relPath === 'string') {
				const s = strip(h.relPath);
				if (s !== h.relPath) { migrated++; }
				h.relPath = s;
			}
			if ((++scanned % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
				await yieldToEventLoop();
				sliceStart = performance.now();
			}
		}
		if (migrated > 0) {
			this._logService?.info('[GraphPersistence]', `path migration: normalized ${migrated} absolute paths to root-relative (${sourcePath})`);
		}
	}

	/**
	 * 导入前结构校验（对齐 C 版 integrity deep check）：
	 * - 硬校验：nodes/edges 必须为数组，节点/边关键字段类型必须正确 → 损坏则拒绝导入；
	 * - 悬挂边扫描：>30% 边引用不存在的节点 → 判定损坏拒绝；
	 * - 软校验：artifact.json 的 node/edge 计数与数据不符 → 仅告警（不拒绝）。
	 */
	private async _validateGraphData(data: any, sourcePath: string): Promise<boolean> {
		if (!data || typeof data !== 'object') { return false; }
		// 节点/边必须为数组：缺失或非数组均视为结构损坏，拒绝导入
		if (!Array.isArray(data.nodes)) { return false; }
		if (!Array.isArray(data.edges)) { return false; }
		const nodeArr = (data.nodes ?? []) as any[];
		const edgeArr = (data.edges ?? []) as any[];

		const nodeIds = new Set<number>();
		// ★★★ 2026-09-18（P0 性能）：本函数是**整段跑**的 O(节点+边) 全量扫描（十几万节点 + 数十万边，
		// 实测数百 ms 连续占用主线程）。BM25 收口后，它与「路径迁移」是加载路径上仅剩的不可切片重活
		// ⇒ 同样按 `SLICE_BUDGET_MS = 8ms` 让出（语义零变化：只在本函数的局部数组上读）。
		let sliceStart = performance.now();
		for (let i = 0; i < nodeArr.length; i++) {
			const n = nodeArr[i];
			if (!n || typeof n.id !== 'number' || typeof n.name !== 'string' || typeof n.project !== 'string') {
				this._logService?.warn('[GraphPersistence]', `artifact integrity check failed: bad node at index ${i}`);
				return false;
			}
			nodeIds.add(n.id);
			if ((i % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
				await yieldToEventLoop();
				sliceStart = performance.now();
			}
		}
		let dangling = 0;
		let containsDangling = 0;
		for (let i = 0; i < edgeArr.length; i++) {
			const e = edgeArr[i];
			if (!e || typeof e.id !== 'number' || typeof e.sourceId !== 'number' || typeof e.targetId !== 'number' || typeof e.type !== 'string') {
				this._logService?.warn('[GraphPersistence]', `artifact integrity check failed: bad edge at index ${i}`);
				return false;
			}
			// ★ 切片让出（超预算就还给 UI 一帧；判定结果与不分片时完全一致）
			if ((i % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
				await yieldToEventLoop();
				sliceStart = performance.now();
			}
			if (!nodeIds.has(e.sourceId) || !nodeIds.has(e.targetId)) {
				// CONTAINS 边的 source 是历史格式中的"文件路径伪节点"（旧版本不实体化 file 节点），
				// 属格式特性而非数据腐败——不计入腐败判定（曾致 45.9% 悬空误判拒绝 → 无限重建）
				if (e.type === 'CONTAINS') { containsDangling++; } else { dangling++; }
			}
		}
		if (containsDangling > 0) {
			this._logService?.info('[GraphPersistence]', `artifact has ${containsDangling} legacy CONTAINS edges with virtual file endpoints (tolerated)`);
		}
		if (edgeArr.length > 0 && dangling > edgeArr.length * 0.3) {
			this._logService?.warn('[GraphPersistence]', `artifact integrity check failed: ${dangling}/${edgeArr.length} dangling edges`);
			return false;
		}

		// 软校验：artifact.json 计数交叉验证（不一致仅告警）
		const meta = await this.getArtifactMeta(sourcePath);
		if (meta && (meta.node_count !== nodeArr.length || meta.edge_count !== edgeArr.length)) {
			this._logService?.warn('[GraphPersistence]', `artifact meta mismatch: meta nodes=${meta.node_count}/edges=${meta.edge_count} vs data nodes=${nodeArr.length}/edges=${edgeArr.length} (proceeding)`);
		}
		return true;
	}

	/**
	 * 读取图谱文件为解压后的 JSON 文本（不解析、不写入任何 store）。
	 * 仅负责「读文件 + 探测格式 + 异步解压」，解析交给 _parseGraphStreaming 以分批让出主线程，
	 * 避免一次性 JSON.parse 几十万节点卡死 UI。
	 * 支持：纯 gzip 流（新）/ CBMG header（旧）/ 纯 JSON（回退）。
	 */
	private async _readJsonText(sourcePath: string): Promise<string | null> {
		try {
			const content = await this._fileService.readFile(URI.file(sourcePath));
			const allBytes = content.value.buffer as Uint8Array;

			if (allBytes.length === 0) {
				this._logService?.debug('[GraphPersistence]', `empty graph file: ${sourcePath}`);
				return null;
			}

			// Detect format
			const dv = new DataView(allBytes.buffer, allBytes.byteOffset, allBytes.byteLength);
			const magic = allBytes.length >= 4 ? dv.getUint32(0, false) : 0;

			let jsonBytes: Uint8Array;

			if (magic === LEGACY_MAGIC) {
				// Legacy format: CBMG header (MAGIC + VERSION + uncompressedSize + gzip)
				const uncompressedSize = dv.getUint32(8, false);
				const compressed = allBytes.slice(12);
				jsonBytes = await this._gzipDecompress(compressed, uncompressedSize);
			} else if (magic === 0x1f8b0800 || magic === 0x1f8b0808) {
				// Gzip magic bytes (0x1f 0x8b 0x08 ...) — pure gzip stream (new format)
				jsonBytes = await this._gzipDecompress(allBytes, 0);
			} else {
				// Try plain JSON (uncompressed fallback)
				return new TextDecoder().decode(allBytes);
			}

			return new TextDecoder().decode(jsonBytes);
		} catch (e) {
			this._logService?.error('[GraphPersistence]', `failed to read graph artifact: ${sourcePath}`, e);
			return null;
		}
	}

	/** Export artifact for team sharing (Git branch)。默认 slim 档（剔除可重建的 bm25/layout，对齐 C 手动导出 drop indexes）。 */
	async exportArtifact(store: CodebaseGraphStore, targetPath: string, opts?: { slim?: boolean }): Promise<{ size: number; nodeCount: number; edgeCount: number }> {
		await this.save(store, targetPath, undefined, { slim: opts?.slim ?? true });
		const stat = await this._fileService.stat(URI.file(targetPath));
		return {
			size: stat.size,
			nodeCount: store.getNodeCount(),
			edgeCount: store.getEdgeCount(),
		};
	}

	/** Import artifact from team sharing */
	async importArtifact(store: CodebaseGraphStore, sourcePath: string): Promise<boolean> {
		return this.load(store, sourcePath);
	}

	/**
	 * Save incrementally — append-only changelog.
	 * For now, falls back to full save. Future: WAL-style append log.
	 */
	async saveIncremental(store: CodebaseGraphStore, targetPath: string, _changedNodeIds: Set<number>): Promise<void> {
		await this.save(store, targetPath);
	}

	/**
	 * Read artifact metadata (artifact.json) without loading the full graph.
	 * Matches codebase-memory-mcp's artifact.json structure.
	 */
	async getArtifactMeta(sourcePath: string): Promise<ArtifactMeta | null> {
		const metaPath = sourcePath.replace(/graph\.db\.\w+$/, 'artifact.json');
		try {
			const content = await this._fileService.readFile(URI.file(metaPath));
			return JSON.parse(content.value.toString()) as ArtifactMeta;
		} catch { return null; }
	}

	/** Get artifact info without loading (legacy API, reads artifact.json) */
	async getArtifactInfo(sourcePath: string): Promise<{ version: number; uncompressedSize: number; compressedSize: number } | null> {
		const meta = await this.getArtifactMeta(sourcePath);
		if (meta) {
			return {
				version: meta.schema_version,
				uncompressedSize: meta.original_size,
				compressedSize: meta.compressed_size,
			};
		}

		// Fallback: read file stat
		try {
			const stat = await this._fileService.stat(URI.file(sourcePath));
			return {
				version: 0,
				uncompressedSize: 0,
				compressedSize: stat.size,
			};
		} catch { return null; }
	}

	/**
	 * 流式 gzip 压缩：将 JSON 字符串分片逐块喂入 CompressionStream，
	 * 仅在内存中保留「当前分片 + 累计压缩输出」，避免整串 JSON + 整段压缩缓冲同时驻留。
	 * 无 CompressionStream（旧环境）时退化为拼接后整段压缩。
	 */
	private async _streamingGzip(chunks: Iterable<string>, onProgress?: (writtenMB: number) => void): Promise<{ compressed: Uint8Array; originalSize: number }> {
		let originalSize = 0;

		// 聚合小分片为大块再写入压缩流：百万级小片逐片 await writer.write
		// 会造成海量事件循环往返 + 每片独立的 gzip 调用开销，表现为长时间假死。
		//
		// 2026-09-02：8MB → 2MB。块大小直接决定「单次不让出主线程的时长」——96MB 图谱
		// 按 8MB 切分，单次阻塞约 0.8s（UI 明显卡顿）；2MB 约 0.2s，接近无感。
		// 代价是让出次数 12 → 48，而 setTimeout(0) 单次仅微秒级，相对每块数百毫秒的
		// stringify + gzip 可忽略。2MB 仍属大块，不会退化成「百万级小片」的假死形态。
		// （注：把整段序列化搬进 Worker 不可行——输入是主线程内存里 12.4w 个节点对象，
		//  跨线程传输成本高于序列化本身。）
		const BATCH = 2 * 1024 * 1024;

		if (typeof CompressionStream === 'undefined') {
			const parts: Uint8Array[] = [];
			let total = 0;
			for (const b of this._batchChunks(chunks, BATCH)) {
				originalSize += b.length;
				parts.push(b);
				total += b.length;
				onProgress?.(originalSize / 1048576);
				// 显式让出主线程，保持 UI 可交互
				await new Promise<void>(r => setTimeout(r, 0));
			}
			const out = new Uint8Array(total);
			let off = 0;
			for (const p of parts) { out.set(p, off); off += p.length; }
			return { compressed: out, originalSize };
		}

		const cs = new CompressionStream('gzip');
		const writer = cs.writable.getWriter();
		const reader = cs.readable.getReader();
		const outChunks: Uint8Array[] = [];
		let compTotal = 0;
		const readPromise = (async () => {
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }
				outChunks.push(value);
				compTotal += value.length;
			}
		})();

		for (const b of this._batchChunks(chunks, BATCH)) {
			originalSize += b.length;
			await writer.write(b);
			onProgress?.(originalSize / 1048576);
			// 每批显式让出主线程（微任务不足以触发渲染，必须宏任务）
			await new Promise<void>(r => setTimeout(r, 0));
		}
		await writer.close();
		await readPromise;

		const out = new Uint8Array(compTotal);
		let off = 0;
		for (const c of outChunks) { out.set(c, off); off += c.length; }
		return { compressed: out, originalSize };
	}

	/** 将字符串分片迭代器聚合为 ~batchSize 的 TextEncoder 字节块（惰性生成器，与调用方的让出节奏交错执行）。 */
	private *_batchChunks(chunks: Iterable<string>, batchSize: number): Generator<Uint8Array<ArrayBuffer>> {
		const enc = new TextEncoder();
		let buf: string[] = [];
		let bufLen = 0;
		for (const c of chunks) {
			buf.push(c);
			bufLen += c.length;
			if (bufLen >= batchSize) {
				yield enc.encode(buf.join(''));
				buf = [];
				bufLen = 0;
			}
		}
		if (bufLen > 0) { yield enc.encode(buf.join('')); }
	}

	/** Gzip decompress using browser native DecompressionStream API */
	private async _gzipDecompress(data: Uint8Array, _expectedSize: number): Promise<Uint8Array> {
		if (typeof DecompressionStream !== 'undefined') {
			const ds = new DecompressionStream('gzip');
			const writer = ds.writable.getWriter();
			writer.write(data as any);
			writer.close();
			const reader = ds.readable.getReader();
			const chunks: Uint8Array[] = [];
			let totalLength = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }
				chunks.push(value);
				totalLength += value.length;
			}
			const result = new Uint8Array(totalLength);
			let offset = 0;
			for (const chunk of chunks) {
				result.set(chunk, offset);
				offset += chunk.length;
			}
			return result;
		}
		// Fallback: assume uncompressed
		return data;
	}
}
