/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Incremental Indexer — 磁盘增量索引分类器。
 *
 * 对标 codebase-memory-mcp 的 pipeline_incremental.c (38KB C)。
 *
 * 本类只负责「快速分类」(mtime+size, O(1)/file, 无需 SHA-256)，判断文件是
 * added / modified / deleted / unchanged。实际的节点/边增量写入由调用方
 * (CodebaseGraphService) 通过 GraphStore 包装层完成，以保持 string↔numeric
 * id 映射一致（直接写底层 CodebaseGraphStore 会破坏 id 映射）。
 *
 * 文件分类：
 * - added:    store 中无记录（按 relPath 比对）
 * - modified: mtime 或 size 变化
 * - deleted:  store 有记录但文件不存在（或 stat 失败）
 * - unchanged: mtime+size 完全匹配（跳过）
 */

import { CodebaseGraphStore, FileHash } from './codebaseGraphStore.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

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
	/**
	 * 用 mtime+size 快速分类文件（O(1) per file，无需读取+SHA-256）。
	 * @param currentFiles 当前磁盘上的「绝对路径」列表
	 * @param toRelPath    绝对路径 → 相对路径（须与 store 中 fileHash.relPath 约定一致）
	 * 返回的 added/modified/deleted/unchanged 均为相对路径。
	 */
	classifyFiles(
		project: string,
		currentFiles: string[],
		toRelPath: (absPath: string) => string,
	): Promise<IncrementalFileClassification>;
}

export class CodebaseGraphIncrementalIndexer implements IIncrementalIndexer {
	constructor(
		private readonly _store: CodebaseGraphStore,
		private readonly _fileService: IFileService,
	) {}

	/** Classify files using mtime+size (fast, no SHA-256 needed) */
	async classifyFiles(
		project: string,
		currentFiles: string[],
		toRelPath: (absPath: string) => string,
	): Promise<IncrementalFileClassification> {
		const result: IncrementalFileClassification = { added: [], modified: [], deleted: [], unchanged: [] };

		const trackedHashes = this._store.getAllFileHashes(project);
		const trackedSet = new Map<string, FileHash>();
		for (const hash of trackedHashes) {
			trackedSet.set(hash.relPath, hash);
		}

		const currentRelSet = new Set<string>();
		for (const absPath of currentFiles) {
			const relPath = toRelPath(absPath);
			currentRelSet.add(relPath);

			const tracked = trackedSet.get(relPath);
			if (!tracked) {
				result.added.push(relPath);
				continue;
			}

			// Fast check: mtime + size（stat 用绝对路径，避免相对路径解析失败）
			try {
				const stat = await this._fileService.stat(URI.file(absPath));
				const currentMtime = stat.mtime * 1_000_000;  // ms → ns
				const currentSize = stat.size;
				if (tracked.mtimeNs === currentMtime && tracked.size === currentSize) {
					result.unchanged.push(relPath);
				} else {
					result.modified.push(relPath);
				}
			} catch {
				// stat 失败 → 视为已删除
				result.deleted.push(relPath);
			}
		}

		// 已跟踪但当前不存在 → 删除
		for (const relPath of trackedSet.keys()) {
			if (!currentRelSet.has(relPath)) {
				result.deleted.push(relPath);
			}
		}

		return result;
	}
}
