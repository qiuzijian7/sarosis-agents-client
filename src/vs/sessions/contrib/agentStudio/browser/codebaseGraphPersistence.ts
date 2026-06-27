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
	constructor(@IFileService private readonly _fileService: IFileService) {}

	/**
	 * Save store as compressed artifact.
	 * Writes graph.db.zst (pure gzip stream, no header) + artifact.json (metadata).
	 * Uses atomic write (write to .tmp, then rename).
	 */
	async save(store: CodebaseGraphStore, targetPath: string): Promise<void> {
		// Yield before heavy operation to let UI update
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		// Step 1: toJSON (creates ~750k objects from Maps — heavy, ~2s for 250k nodes)
		const data = store.toJSON();

		// Yield after toJSON
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		// Step 2: JSON.stringify (serializes ~750k objects — heavy, ~3s)
		const json = JSON.stringify(data);

		// Yield after stringify, before encode
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		// Step 3: encode to bytes (~1s)
		const jsonBytes = new TextEncoder().encode(json);

		// Free references early to reduce memory pressure
		(data as any).nodes = null;
		(data as any).edges = null;

		// Step 4: Compress using gzip (async, doesn't block)
		const compressed = await this._gzipCompress(jsonBytes);

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
		const meta: ArtifactMeta = {
			schema_version: ARTIFACT_SCHEMA_VERSION,
			compression: ARTIFACT_COMPRESSION,
			original_size: jsonBytes.length,
			compressed_size: compressed.length,
			node_count: store.getNodeCount(),
			edge_count: store.getEdgeCount(),
			created_at: new Date().toISOString(),
		};
		const metaPath = targetPath.replace(/graph\.db\.\w+$/, 'artifact.json');
		const metaJson = JSON.stringify(meta, null, 2);
		await this._fileService.writeFile(URI.file(metaPath), VSBuffer.fromString(metaJson));
	}

	/**
	 * Load store from compressed artifact.
	 * Supports: pure gzip stream (new), CBMG header (legacy), plain JSON (fallback).
	 * Uses async chunked loading to avoid UI freeze.
	 */
	async load(store: CodebaseGraphStore, sourcePath: string): Promise<boolean> {
		try {
			const content = await this._fileService.readFile(URI.file(sourcePath));
			const allBytes = content.value.buffer;

			if (allBytes.length === 0) { return false; }

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
				const data = JSON.parse(text);
				await store.fromJSONAsync(data);
				return true;
			}

			const json = new TextDecoder().decode(jsonBytes);
			const data = JSON.parse(json);

			// Async chunked loading to avoid UI freeze
			await store.fromJSONAsync(data);
			return true;
		} catch { return false; }
	}

	/** Export artifact for team sharing (Git branch) */
	async exportArtifact(store: CodebaseGraphStore, targetPath: string): Promise<{ size: number; nodeCount: number; edgeCount: number }> {
		await this.save(store, targetPath);
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

	/** Gzip compress using browser native CompressionStream API */
	private async _gzipCompress(data: Uint8Array): Promise<Uint8Array> {
		if (typeof CompressionStream !== 'undefined') {
			const cs = new CompressionStream('gzip');
			const writer = cs.writable.getWriter();
			writer.write(data as any);
			writer.close();
			const reader = cs.readable.getReader();
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
		// Fallback: no compression
		return data;
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
