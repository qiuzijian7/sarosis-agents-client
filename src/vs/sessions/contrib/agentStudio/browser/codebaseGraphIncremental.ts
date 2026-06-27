/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Incremental Indexer — 磁盘增量索引。
 *
 * 对标 codebase-memory-mcp 的 pipeline_incremental.c (38KB C)。
 *
 * 核心改进（相比 codebaseGraphService.ts 的 SHA-256 增量）：
 * 1. 使用 mtime+size 快速分类（O(1) per file），避免读取+SHA-256(O(n) per file)
 * 2. 直接操作 store（不重建内存图）
 * 3. 级联删除：删除文件节点时自动删除关联边
 * 4. WAL checkpoint：索引完成后 checkpoint
 *
 * 文件分类：
 * - added:   store 中无记录
 * - modified: mtime 或 size 变化
 * - deleted:  store 有记录但文件不存在
 * - unchanged: mtime+size 完全匹配（跳过）
 */

import { CodebaseGraphStore, FileHash } from './codebaseGraphStore.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

export interface IncrementalFileClassification {
	added: string[];
	modified: string[];
	deleted: string[];
	unchanged: string[];
}

export interface IncrementalIndexResult {
	success: boolean;
	message: string;
	duration: number;
	classification: IncrementalFileClassification;
	nodesExtracted: number;
	edgesExtracted: number;
}

export interface IIncrementalIndexer {
	/** Classify files into added/modified/deleted/unchanged using mtime+size */
	classifyFiles(project: string, currentFiles: string[]): Promise<IncrementalFileClassification>;
	/** Run incremental index — only parse changed files */
	runIncremental(
		project: string,
		rootPath: string,
		files: string[],
		parseFile: (filePath: string, token: CancellationToken) => Promise<{ nodes: any[]; edges: any[] }>,
		token: CancellationToken,
	): Promise<IncrementalIndexResult>;
}

export class CodebaseGraphIncrementalIndexer implements IIncrementalIndexer {
	constructor(
		private readonly _store: CodebaseGraphStore,
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
	) {}

	/** Classify files using mtime+size (fast, no SHA-256 needed) */
	async classifyFiles(project: string, currentFiles: string[]): Promise<IncrementalFileClassification> {
		const result: IncrementalFileClassification = { added: [], modified: [], deleted: [], unchanged: [] };

		// Get tracked files from store
		const trackedHashes = this._store.getAllFileHashes(project);
		const trackedSet = new Map<string, FileHash>();
		for (const hash of trackedHashes) {
			trackedSet.set(hash.relPath, hash);
		}

		const currentSet = new Set(currentFiles);

		// Classify tracked files
		for (const [relPath, _trackedHash] of trackedSet) {
			if (!currentSet.has(relPath)) {
				result.deleted.push(relPath);
			}
		}

		// Classify current files
		for (const filePath of currentFiles) {
			const trackedHash = trackedSet.get(filePath);
			if (!trackedHash) {
				result.added.push(filePath);
				continue;
			}

			// Fast check: mtime + size
			try {
				const stat = await this._fileService.stat(URI.file(filePath));
				const currentMtime = stat.mtime * 1_000_000;  // ms → ns
				const currentSize = stat.size;

				if (trackedHash.mtimeNs === currentMtime && trackedHash.size === currentSize) {
					result.unchanged.push(filePath);
				} else {
					result.modified.push(filePath);
				}
			} catch {
				// File stat failed — treat as deleted
				result.deleted.push(filePath);
			}
		}

		return result;
	}

	/** Run incremental index */
	async runIncremental(
		project: string,
		rootPath: string,
		files: string[],
		parseFile: (filePath: string, token: CancellationToken) => Promise<{ nodes: any[]; edges: any[] }>,
		token: CancellationToken,
	): Promise<IncrementalIndexResult> {
		const startTime = Date.now();
		const LOG_TAG = '[CodebaseGraphIncremental]';

		// 1. Classify files
		this._logService.info(LOG_TAG, 'Classifying files...');
		const classification = await this.classifyFiles(project, files);

		this._logService.info(LOG_TAG,
			`Classification: +${classification.added.length} added, ~${classification.modified.length} modified, -${classification.deleted.length} deleted, =${classification.unchanged.length} unchanged`);

		// 2. Delete nodes for deleted + modified files (cascade edge deletion)
		this._store.beginTransaction();
		try {
			for (const filePath of [...classification.deleted, ...classification.modified]) {
				this._store.deleteNodesByFile(project, filePath);
				this._store.deleteFileHash(project, filePath);
			}
			this._store.commitTransaction();
		} catch (err) {
			this._store.rollbackTransaction();
			throw err;
		}

		// 3. Parse added + modified files
		let nodesExtracted = 0;
		let edgesExtracted = 0;
		const filesToParse = [...classification.added, ...classification.modified];

		for (const filePath of filesToParse) {
			if (token.isCancellationRequested) { break; }

			try {
				const result = await parseFile(filePath, token);

				// Batch upsert nodes and edges
				this._store.beginTransaction();
				try {
					for (const node of result.nodes) {
						this._store.upsertNode({ ...node, project });
						nodesExtracted++;
					}
					for (const edge of result.edges) {
						this._store.insertEdge({ ...edge, project });
						edgesExtracted++;
					}
					this._store.commitTransaction();
				} catch (err) {
					this._store.rollbackTransaction();
					this._logService.warn(LOG_TAG, `Failed to upsert ${filePath}: ${err}`);
				}

				// Update file hash (mtime + size + sha256)
				try {
					const stat = await this._fileService.stat(URI.file(filePath));
					const hash = await CodebaseGraphStore.computeHash(this._fileService, URI.file(filePath));
					this._store.upsertFileHash({
						project,
						relPath: filePath,
						sha256: hash.sha256,
						mtimeNs: stat.mtime * 1_000_000,
						size: stat.size,
					});
				} catch { /* ignore hash update failures */ }

			} catch (err: any) {
				this._logService.debug(LOG_TAG, `Parse failed for ${filePath}: ${err?.message || err}`);
			}
		}

		// 4. Checkpoint
		this._store.checkpoint();

		// 5. Integrity check (lightweight)
		const integrity = this._store.checkIntegrity();
		if (!integrity.ok) {
			this._logService.warn(LOG_TAG, `Integrity check found ${integrity.errors.length} issues`);
		}

		const duration = (Date.now() - startTime) / 1000;
		const message = `Incremental: +${classification.added.length} ~${classification.modified.length} -${classification.deleted.length} =${classification.unchanged.length} (${nodesExtracted} nodes, ${edgesExtracted} edges, ${duration.toFixed(1)}s)`;

		this._logService.info(LOG_TAG, message);

		return {
			success: true,
			message,
			duration,
			classification,
			nodesExtracted,
			edgesExtracted,
		};
	}

	/** Get file stats for mtime+size comparison */
	async getFileStats(filePath: string): Promise<{ mtimeNs: number; size: number } | null> {
		try {
			const stat = await this._fileService.stat(URI.file(filePath));
			return { mtimeNs: stat.mtime * 1_000_000, size: stat.size };
		} catch { return null; }
	}
}
