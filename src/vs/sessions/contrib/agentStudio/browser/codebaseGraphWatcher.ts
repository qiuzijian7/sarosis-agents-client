/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Graph Watcher — 自适应轮询文件监听，检测变更后触发增量索引。
 *
 * 对标 codebase-memory-mcp 的 watcher.c：
 * - 基础间隔 5s，每 500 文件 +1s，上限 60s
 * - git HEAD 变化时触发全量检查
 * - 文件 SHA-256 变化时触发增量索引
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { CodebaseGraphStore } from './codebaseGraphStore.js';

export interface CodebaseGraphChangeEvent {
	type: 'git-head' | 'files';
	head?: string;
	added?: string[];
	modified?: string[];
	deleted?: string[];
}

export const ICodebaseGraphWatcher = createDecorator<CodebaseGraphWatcher>('ICodebaseGraphWatcher');

const LOG_TAG = '[CodebaseGraphWatcher]';
const BASE_POLL_MS = 5000;
const MAX_POLL_MS = 60000;
const FILES_PER_EXTRA_SEC = 500;

export class CodebaseGraphWatcher extends Disposable {
	private _pollTimer: any;
	private _pollInterval = BASE_POLL_MS;
	private _lastGitHead: string | undefined;
	private _isPolling = false;
	private _disposed = false;

	private readonly _onDidChange = this._register(new Emitter<CodebaseGraphChangeEvent>());
	readonly onDidChange: Event<CodebaseGraphChangeEvent> = this._onDidChange.event;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	start(rootPath: string, store: CodebaseGraphStore, project: string, supportedExtensions: Set<string>): void {
		this.stop();
		this._logService.info(LOG_TAG, `Starting watcher for ${rootPath}`);
		this._lastGitHead = undefined;
		this._schedulePoll(rootPath, store, project, supportedExtensions);
	}

	stop(): void {
		if (this._pollTimer) {
			clearTimeout(this._pollTimer);
			this._pollTimer = null;
		}
		this._isPolling = false;
	}

	private _schedulePoll(rootPath: string, store: CodebaseGraphStore, project: string, exts: Set<string>): void {
		if (this._disposed) { return; }
		this._pollTimer = setTimeout(() => {
			this._poll(rootPath, store, project, exts).catch(err =>
				this._logService.warn(LOG_TAG, `Poll error: ${err?.message || err}`));
		}, this._pollInterval);
	}

	private async _poll(rootPath: string, store: CodebaseGraphStore, project: string, exts: Set<string>): Promise<void> {
		if (this._isPolling || this._disposed) { return; }
		this._isPolling = true;

		try {
			// 1. Check git HEAD
			const head = await this._getGitHead(rootPath);
			if (head && head !== this._lastGitHead) {
				if (this._lastGitHead !== undefined) {
					this._logService.info(LOG_TAG, `Git HEAD changed: ${this._lastGitHead} → ${head}`);
					this._onDidChange.fire({ type: 'git-head', head });
				}
				this._lastGitHead = head;
				// On git HEAD change, do a full file check
				await this._checkFiles(rootPath, store, project, exts);
				return;
			}
			this._lastGitHead = head;

			// 2. Check file changes (hash-based)
			await this._checkFiles(rootPath, store, project, exts);
		} finally {
			this._isPolling = false;
			this._schedulePoll(rootPath, store, project, exts);
		}
	}

	private async _checkFiles(rootPath: string, store: CodebaseGraphStore, project: string, exts: Set<string>): Promise<void> {
		const currentFiles = await this._scanFiles(URI.file(rootPath), exts, new Set(), 0);
		const currentSet = new Set(currentFiles);

		// Get previous file hashes
		const oldHashes = store.getAllFileHashes(project);
		const oldSet = new Set(oldHashes.map(h => h.relPath));

		// Find added/modified/deleted
		const added: string[] = [];
		const modified: string[] = [];
		const deleted: string[] = [];

		for (const relPath of currentSet) {
			if (!oldSet.has(relPath)) {
				added.push(relPath);
			}
		}

		for (const oldHash of oldHashes) {
			if (!currentSet.has(oldHash.relPath)) {
				deleted.push(oldHash.relPath);
			}
		}

		// For existing files, check hash (sample to avoid too much I/O)
		const existing = currentFiles.filter(f => oldSet.has(this._getRelPath(rootPath, f)));
		const sampleSize = Math.min(existing.length, 200); // Sample up to 200 files per poll
		const sample = this._sample(existing, sampleSize);

		for (const absPath of sample) {
			const relPath = this._getRelPath(rootPath, absPath);
			try {
				const newHash = await CodebaseGraphStore.computeHash(this._fileService, URI.file(absPath));
				const oldHash = store.getFileHash(project, relPath);
				if (!oldHash || oldHash.sha256 !== newHash.sha256) {
					modified.push(relPath);
				}
			} catch { /* file might be locked or deleted */ }
		}

		// Adaptive interval based on file count
		this._pollInterval = Math.min(MAX_POLL_MS, BASE_POLL_MS + Math.floor(currentFiles.length / FILES_PER_EXTRA_SEC) * 1000);

		if (added.length > 0 || modified.length > 0 || deleted.length > 0) {
			this._logService.info(LOG_TAG, `Changes: +${added.length} ~${modified.length} -${deleted.length}`);
			this._onDidChange.fire({ type: 'files', added, modified, deleted });
		}
	}

	private async _scanFiles(dirUri: URI, exts: Set<string>, excludeDirs: Set<string>, depth: number): Promise<string[]> {
		if (depth > 30) { return []; }

		let stat;
		try {
			stat = await this._fileService.resolve(dirUri);
		} catch { return []; }

		if (!stat.children) { return []; }

		const results: string[] = [];
		for (const child of stat.children) {
			if (excludeDirs.has(child.name) || (child.name.startsWith('.') && child.name.length > 1)) {
				continue;
			}
			if (child.isDirectory) {
				const sub = await this._scanFiles(child.resource, exts, excludeDirs, depth + 1);
				results.push(...sub);
			} else if (child.isFile) {
				const ext = this._getExtension(child.name);
				if (exts.has(ext)) {
					results.push(child.resource.fsPath);
				}
			}
		}
		return results;
	}

	private _getRelPath(rootPath: string, absPath: string): string {
		if (absPath.startsWith(rootPath)) {
			return absPath.substring(rootPath.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
		}
		return absPath.replace(/\\/g, '/');
	}

	private _getExtension(fileName: string): string {
		const idx = fileName.lastIndexOf('.');
		return idx >= 0 ? fileName.substring(idx).toLowerCase() : '';
	}

	private _sample<T>(arr: T[], n: number): T[] {
		if (arr.length <= n) { return arr; }
		const result: T[] = [];
		const step = arr.length / n;
		for (let i = 0; i < n; i++) {
			result.push(arr[Math.floor(i * step)]);
		}
		return result;
	}

	private async _getGitHead(rootPath: string): Promise<string | undefined> {
		try {
			const headUri = URI.joinPath(URI.file(rootPath), '.git', 'HEAD');
			const content = await this._fileService.readFile(headUri);
			return content.value.toString().trim();
		} catch { return undefined; }
	}

	override dispose(): void {
		this._disposed = true;
		this.stop();
		super.dispose();
	}
}
