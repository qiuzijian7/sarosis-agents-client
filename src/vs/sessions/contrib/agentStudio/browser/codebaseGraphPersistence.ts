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
import { IAgentStudioLogService } from './agentStudioLogService.js';
import { ILogService } from '../../../../platform/log/common/log.js';

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
	 *   剔除可重建的 bm25 倒排与 layout 3D 坐标 → 制品显著缩小；加载侧自动重建 BM25。
	 *   自动保存/watcher 路径不传（全量保真，对齐 C watcher 档）。
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
	async load(store: CodebaseGraphStore, sourcePath: string): Promise<boolean> {
		const data = await this._readData(sourcePath);
		if (!data) { return false; }
		this._normalizeLoadedPaths(data, sourcePath);
		// 导入前完整性校验（对齐 C 版 cbm_store_check_integrity_deep 的导入门）
		if (!await this._validateGraphData(data, sourcePath)) { return false; }
		// Async chunked loading to avoid UI freeze
		await store.fromJSONAsync(data);
		// slim 档制品（无 bm25）→ 加载后重建倒排，否则 search_graph query 静默无结果
		if (!data.bm25 && (data.nodes?.length ?? 0) > 0) {
			await store.rebuildBM25();
		}
		return true;
	}

	/**
	 * 合并加载：把 sourcePath 的图谱【追加】到 store（不清空），用于多 folder 工作区。
	 * @param projectOverride 覆盖合并进来的所有节点/边的项目名（确保各 folder 项目名唯一）。
	 */
	async loadMerge(store: CodebaseGraphStore, sourcePath: string, projectOverride?: string): Promise<boolean> {
		const data = await this._readData(sourcePath);
		if (!data) { return false; }
		// 路径格式迁移：旧版本多 folder 下非 folders[0] 的文件路径/QN/哈希键被存成绝对路径
		this._normalizeLoadedPaths(data, sourcePath);
		// 导入前完整性校验（合并路径同样适用）
		if (!await this._validateGraphData(data, sourcePath)) { return false; }
		await store.mergeFromJSONAsync(data, projectOverride);
		return true;
	}

	/**
	 * 路径格式迁移：旧版 `_getRelativePath` 只试 folders[0]，导致第二 folder 的
	 * filePath/qualifiedName/fileHashes.relPath 全部存成绝对路径——
	 * watcher 的 root-relative 键永远匹配不上（每轮误报全量变更），
	 * 重索引时新旧格式并存产生重复节点。加载时统一归一化为 root 相对路径。
	 */
	private _normalizeLoadedPaths(data: any, sourcePath: string): void {
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
		let migrated = 0;
		for (const nd of data.nodes ?? []) {
			if (typeof nd.filePath === 'string') {
				const s = strip(nd.filePath);
				if (s !== nd.filePath) { migrated++; }
				nd.filePath = s;
			}
			if (typeof nd.qualifiedName === 'string') { nd.qualifiedName = strip(nd.qualifiedName); }
		}
		for (const h of data.fileHashes ?? []) {
			if (typeof h.relPath === 'string') {
				const s = strip(h.relPath);
				if (s !== h.relPath) { migrated++; }
				h.relPath = s;
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
		if (data.nodes !== undefined && !Array.isArray(data.nodes)) { return false; }
		if (data.edges !== undefined && !Array.isArray(data.edges)) { return false; }
		const nodeArr = (data.nodes ?? []) as any[];
		const edgeArr = (data.edges ?? []) as any[];

		const nodeIds = new Set<number>();
		for (let i = 0; i < nodeArr.length; i++) {
			const n = nodeArr[i];
			if (!n || typeof n.id !== 'number' || typeof n.name !== 'string' || typeof n.project !== 'string') {
				this._logService?.warn('[GraphPersistence]', `artifact integrity check failed: bad node at index ${i}`);
				return false;
			}
			nodeIds.add(n.id);
		}
		let dangling = 0;
		let containsDangling = 0;
		for (let i = 0; i < edgeArr.length; i++) {
			const e = edgeArr[i];
			if (!e || typeof e.id !== 'number' || typeof e.sourceId !== 'number' || typeof e.targetId !== 'number' || typeof e.type !== 'string') {
				this._logService?.warn('[GraphPersistence]', `artifact integrity check failed: bad edge at index ${i}`);
				return false;
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
	 * 读取并解析图谱文件为原始 data 对象（不写入任何 store）。
	 * 支持：纯 gzip 流（新）/ CBMG header（旧）/ 纯 JSON（回退）。
	 */
	private async _readData(sourcePath: string): Promise<any | null> {
		try {
			const content = await this._fileService.readFile(URI.file(sourcePath));
			const allBytes = content.value.buffer;

			if (allBytes.length === 0) { return null; }

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
				const text = new TextDecoder().decode(allBytes);
				return JSON.parse(text);
			}

			const json = new TextDecoder().decode(jsonBytes);
			return JSON.parse(json);
		} catch { return null; }
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

		// 聚合小分片为 ~8MB 大块再写入压缩流：百万级小片逐片 await writer.write
		// 会造成海量事件循环往返 + 每片独立的 gzip 调用开销，表现为长时间假死。
		const BATCH = 8 * 1024 * 1024;

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
