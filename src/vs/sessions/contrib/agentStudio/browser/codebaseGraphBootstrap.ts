/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Graph Bootstrap — 工作区打开后自动加载/索引代码图谱，用户无感知。
 *
 * 1. 工作区打开时检查是否已有 graph.db.zst
 * 2. 有 → 直接加载（毫秒级）+ 启动文件监听
 * 3. 无 → 延迟 5s 后自动索引（后台，不阻塞 UI）
 * 4. 索引完成后启动文件监听 → 文件变更时自动增量索引
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent } from '../../../../platform/workspace/common/workspace.js';
import { ICodebaseGraphService, IIndexConfig } from './codebaseGraphService.js';
import { ICodebaseGraphWatcher, CodebaseGraphWatcher } from './codebaseGraphWatcher.js';
import { URI } from '../../../../base/common/uri.js';

const LOG_TAG = '[CodebaseGraph]';
const AUTO_INDEX_DELAY_MS = 5000; // 5s delay after workspace open

class CodebaseGraphBootstrapContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codebaseGraphBootstrap';

	private _autoIndexTimer: any;
	private _hasIndexed = false;

	constructor(
		@ICodebaseGraphService private readonly _graphService: ICodebaseGraphService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
		@ICodebaseGraphWatcher private readonly _graphWatcher: CodebaseGraphWatcher,
	) {
		super();

		// Subscribe to index progress logs
		this._register(this._graphService.onDidIndexProgress(line => {
			this._logService.info(LOG_TAG, line);
		}));

		this._register(this._graphService.onDidIndexComplete(result => {
			if (result.success) {
				this._logService.info(LOG_TAG, `Auto-index complete: ${result.message}`);
				this._startWatcher();
			} else {
				this._logService.warn(LOG_TAG, `Auto-index failed: ${result.message}`);
			}
		}));

		// Listen for file changes from watcher
		this._register(this._graphWatcher.onDidChange(e => {
			if (e.type === 'git-head') {
				this._logService.info(LOG_TAG, `Git HEAD changed, scheduling re-index...`);
				this._scheduleAutoIndex();
			} else if (e.type === 'files' && (e.added?.length || e.modified?.length || e.deleted?.length)) {
				this._logService.info(LOG_TAG, `Files changed, triggering incremental index...`);
				this._autoIndex();
			}
		}));

		// Listen for workspace folder changes
		this._register(this._workspaceService.onDidChangeWorkspaceFolders((e: IWorkspaceFoldersChangeEvent) => {
			if (e.added.length > 0) {
				this._scheduleAutoIndex();
			}
		}));

		// Start bootstrap
		this._bootstrap().catch(err => this._logService.error(LOG_TAG, 'Bootstrap failed:', err));
	}

	private async _bootstrap(): Promise<void> {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			this._logService.info(LOG_TAG, 'No workspace folder open, skipping.');
			return;
		}

		const wsUri = folders[0].uri;
		const graphFileUri = URI.joinPath(wsUri, '.codebase-memory', 'graph.db.zst');

		// 1. Try to load existing graph
		try {
			const loaded = await this._graphService.loadGraph(graphFileUri.fsPath);
			if (loaded) {
				this._logService.info(LOG_TAG, 'Existing graph loaded successfully.');
				this._hasIndexed = true;
				return;
			}
		} catch { /* file doesn't exist yet */ }

		// 2. No existing graph — schedule auto-index
		this._logService.info(LOG_TAG, 'No existing graph found, scheduling auto-index...');
		this._scheduleAutoIndex();
	}

	private _scheduleAutoIndex(): void {
		if (this._hasIndexed) { return; }

		clearTimeout(this._autoIndexTimer);
		this._autoIndexTimer = setTimeout(() => {
			this._autoIndex().catch(err =>
				this._logService.warn(LOG_TAG, 'Auto-index failed:', err));
		}, AUTO_INDEX_DELAY_MS);
	}

	private async _autoIndex(): Promise<void> {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		const wsPath = folders[0].uri.fsPath;
		const config: IIndexConfig = {
			mode: 'fast',
			excludeDirs: [], // Use defaults
		};

		this._logService.info(LOG_TAG, `Starting auto-index: ${wsPath}`);
		const result = await this._graphService.indexWorkspace(wsPath, config);
		if (result.success) {
			this._hasIndexed = true;
			this._logService.info(LOG_TAG, `Auto-index completed: ${result.message}`);
		}
	}

	private _startWatcher(): void {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) { return; }
		// Watcher will be started by the service — here we just log
		this._logService.info(LOG_TAG, 'File watcher will detect changes for incremental indexing.');
	}
}

registerWorkbenchContribution2(
	CodebaseGraphBootstrapContribution.ID,
	CodebaseGraphBootstrapContribution as any,
	WorkbenchPhase.AfterRestored,
);
