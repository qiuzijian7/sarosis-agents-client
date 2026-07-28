/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CodebaseIndexEditorPane — 独立的「代码库索引」面板。
 * 承载原 Memory「代码图谱」页签的索引控制 UI：状态显示、索引操作、配置、进度日志、
 * 以及跳转到 3D 图谱面板的入口。
 *
 * 无需外部二进制，直接使用 VS Code 内置 tree-sitter WASM。
 * 每个文件由（库中关联的）folderPath 区分，各自独立成 Tab。
 */

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { basename } from '../../../../base/common/path.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ICodebaseGraphService } from './codebaseGraphService.js';
import { ICodebaseMemoryMcpService, IIndexConfig, IndexMode } from './codebaseMemoryMcpService.js';
import { CodebaseIndexEditorInput } from './codebaseIndexEditorInput.js';
import { CodebaseGraphViewerEditorInput } from './codebaseGraphViewerEditorInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';


export class CodebaseIndexEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.codebaseIndex';

	// ── Fields ──
	private _container: HTMLElement | null = null;
	private _logEl: HTMLElement | null = null;
	private _progressDisposables: IDisposable[] = [];
	private _currentFolderPath?: string;
	private _indexCts?: CancellationTokenSource;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICodebaseGraphService private readonly _graphService: ICodebaseGraphService,
		@IEditorService private readonly _editorService: IEditorService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ICodebaseMemoryMcpService private readonly _cbmService: ICodebaseMemoryMcpService,
	) {
		super(CodebaseIndexEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	// ── Lifecycle ──

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('codebase-index-pane');
		this._container.style.cssText =
			'padding:20px 24px 40px;overflow-y:auto;height:100%;box-sizing:border-box;' +
			'font-size:13px;color:var(--vscode-foreground);max-width:800px;margin:0 auto;';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: CodebaseIndexEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		this._currentFolderPath = input.folderPath;
		await this._renderUI();
	}

	override layout(_dimension: { width: number; height: number }): void {
		// Container fills editor via CSS height:100%
	}

	override dispose(): void {
		this._clearProgressListeners();
		this._indexCts?.cancel();
		this._indexCts?.dispose();
		this._indexCts = undefined;
		this._container = null;
		super.dispose();
	}

	// ── UI Rendering ──

	private async _renderUI(): Promise<void> {
		if (!this._container) { return; }
		this._clearProgressListeners();
		clearNode(this._container);

		const rootPath = this._currentFolderPath ?? this._getWorkspaceRoot();
		const rootName = this._currentFolderPath ? basename(this._currentFolderPath) : '当前工作区';

		// 读取已保存的索引配置（持久化到 workspace storage 或 .code-workspace 文件），用于回填表单
		let savedMode: IndexMode = 'fast';
		let savedExcl = 'node_modules,.git,build,dist,out,.next,tmp';
		let savedKeep = '';
		try {
			await this._cbmService.ensureConfigReady();
			const cfg = this._cbmService.getIndexConfig();
			if (cfg.mode) { savedMode = cfg.mode; }
			if (cfg.excludeDirs?.length) { savedExcl = cfg.excludeDirs.join(','); }
			if (cfg.keepDirs?.length) { savedKeep = cfg.keepDirs.join(','); }
		} catch { /* 读取失败时回退到默认值 */ }

		// ── Header ──
		const header = append(this._container, $('div'));
		header.style.cssText = 'margin-bottom:16px;';

		const h1 = append(header, $('h2'));
		h1.textContent = `🧬 代码库索引`;
		h1.style.cssText = 'font-size:17px;font-weight:600;margin:0 0 4px;';

		const subtitle = append(header, $('div'));
		subtitle.textContent = rootPath;
		subtitle.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);word-break:break-all;';

		// ── Status Badge ──
		const statusRow = append(header, $('div'));
		statusRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap;';

		const badge = append(statusRow, $('span'));

		// 获取状态
		let statusText = '○ 未索引';
		let statusColor = '#f48771';
		let statusBg = 'rgba(244,135,113,0.15)';
		let hasData = false;
		let nodeCount = 0;
		let edgeCount = 0;

		try {
			const status = await this._graphService.getGraphStatus(rootPath);
			// 文件存在即视为已索引；节点/边数量仅在 graph 已加载到内存时可用，
			// 因此不能仅凭内存计数判定“未索引”（否则已落盘但内存未加载的目录会误显未索引）
			hasData = status.exists;
			nodeCount = status.nodeCount ?? 0;
			edgeCount = status.edgeCount ?? 0;
			if (this._graphService.isIndexing) {
				statusText = '⏳ 索引中...';
				statusColor = '#dcdcaa';
				statusBg = 'rgba(220,220,170,0.15)';
			} else if (hasData) {
				if (nodeCount > 0 || edgeCount > 0) {
					statusText = `✓ 已索引（${nodeCount} 节点, ${edgeCount} 边）`;
				} else if (status.size) {
					statusText = `✓ 已索引（${(status.size / 1024).toFixed(0)} KB）`;
				} else {
					statusText = '✓ 已索引';
				}
				statusColor = '#4ec9b0';
				statusBg = 'rgba(78,201,176,0.15)';
			}
		} catch {
			statusText = '○ 状态未知';
		}

		badge.textContent = statusText;
		badge.style.cssText = `padding:3px 10px;border-radius:4px;font-size:12px;font-weight:600;background:${statusBg};color:${statusColor};`;

		// ── Actions ──
		const actions = append(statusRow, $('div'));
		actions.style.cssText = 'display:flex;gap:8px;';

		const indexBtn = this._makeBtn('🔍 索引代码库', '#80a0ff');
		indexBtn.onclick = () => { void this._startIndex(rootPath, rootName); };
		const cancelBtn = this._makeBtn('⏹ 取消', '#f48771');
		cancelBtn.onclick = () => this._cancelIndex();
		const graphBtn = this._makeBtn('🌐 3D 图谱', '#4ec9b0');
		graphBtn.onclick = () => {
			const input = new CodebaseGraphViewerEditorInput(this._currentFolderPath);
			void this._editorService.openEditor(input, { pinned: true });
		};

		actions.append(indexBtn, cancelBtn, graphBtn);

		// Disable index button if already indexing
		if (this._graphService.isIndexing) {
			indexBtn.disabled = true;
			indexBtn.style.opacity = '0.5';
			cancelBtn.style.display = 'inline-block';
		} else {
			cancelBtn.style.display = 'none';
		}

		// ── Config ──
		const cfgWrap = append(this._container, $('div'));
		cfgWrap.style.cssText = 'margin:12px 0;padding:12px 14px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:6px;';

		const cfgTitle = append(cfgWrap, $('div'));
		cfgTitle.textContent = '⚙️ 索引配置';
		cfgTitle.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;';

		// Mode selector
		const modeRow = append(cfgWrap, $('div'));
		modeRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px;';
		const modeLabel = append(modeRow, $('span'));
		modeLabel.textContent = '模式:';
		modeLabel.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);min-width:50px;';
		const modeSelect = document.createElement('select') as HTMLSelectElement;
		modeSelect.style.cssText = 'flex:1;padding:4px 8px;font-size:12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;';
		for (const m of ['fast', 'moderate', 'full']) {
			const opt = document.createElement('option');
			opt.value = m; opt.textContent = m;
			if (m === savedMode) { opt.selected = true; }
			modeSelect.appendChild(opt);
		}
		modeRow.appendChild(modeSelect);

		// Exclude dirs
		const exclRow = append(cfgWrap, $('div'));
		exclRow.style.cssText = 'display:flex;align-items:center;gap:10px;';
		const exclLabel = append(exclRow, $('span'));
		exclLabel.textContent = '排除:';
		exclLabel.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);min-width:50px;';
		const exclInput = document.createElement('input') as HTMLInputElement;
		exclInput.type = 'text';
		exclInput.value = savedExcl;
		exclInput.placeholder = '逗号分隔';
		exclInput.style.cssText = 'flex:1;padding:4px 8px;font-size:12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;';
		exclRow.appendChild(exclInput);

		// Keep dirs
		const keepRow = append(cfgWrap, $('div'));
		keepRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:8px;';
		const keepLabel = append(keepRow, $('span'));
		keepLabel.textContent = '保留:';
		keepLabel.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);min-width:50px;';
		const keepInput = document.createElement('input') as HTMLInputElement;
		keepInput.type = 'text';
		keepInput.value = savedKeep;
		keepInput.placeholder = '逗号分隔（可选）';
		keepInput.style.cssText = 'flex:1;padding:4px 8px;font-size:12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;';
		keepRow.appendChild(keepInput);

		// ── Progress Log ──
		const logWrap = append(this._container, $('div'));
		logWrap.style.cssText = 'margin-top:12px;';
		const logHeader = append(logWrap, $('div'));
		logHeader.textContent = '📋 进度日志';
		logHeader.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;';

		this._logEl = append(logWrap, $('div'));
		this._logEl.style.cssText =
			'font-size:11px;font-family:monospace;line-height:1.6;' +
			'padding:10px 12px;background:var(--vscode-input-background);' +
			'border:1px solid var(--vscode-input-border);border-radius:4px;' +
			'max-height:300px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;' +
			'color:var(--vscode-input-foreground);';

		// Subscribe progress
		this._progressDisposables.push(
			this._graphService.onDidIndexProgress(line => this._appendLog(line)),
			this._graphService.onDidIndexComplete(result => {
				this._appendLog(result.success
					? `✅ ${result.message} (${result.stats?.nodesExtracted ?? 0} 节点, ${result.stats?.edgesExtracted ?? 0} 边, ${result.duration}s)`
					: `❌ ${result.message} (${result.duration}s)`);
				// 重新渲染以刷新状态
				setTimeout(() => { void this._renderUI(); }, 500);
			}),
		);

		// Store refs for index action
		(this as any)._cfgModeEl = modeSelect;
		(this as any)._cfgExclEl = exclInput;
		(this as any)._cfgKeepEl = keepInput;
		(this as any)._indexBtnEl = indexBtn;
		(this as any)._cancelBtnEl = cancelBtn;
	}

	// ── Actions ──

	private async _startIndex(rootPath: string, rootName: string): Promise<void> {
		const mode: IndexMode = ((this as any)._cfgModeEl?.value ?? 'fast') as IndexMode;
		const exclRaw = ((this as any)._cfgExclEl?.value ?? '') as string;
		const keepRaw = ((this as any)._cfgKeepEl?.value ?? '') as string;
		const excludeDirs = exclRaw.split(',').map((s: string) => s.trim()).filter(Boolean);
		const keepDirs = keepRaw.split(',').map((s: string) => s.trim()).filter(Boolean);

		const config: IIndexConfig = {
			mode,
			excludeDirs: excludeDirs.length ? excludeDirs : ['node_modules', '.git', 'build', 'dist', 'out', '.next', 'tmp'],
			keepDirs: keepDirs.length ? keepDirs : undefined,
		};

		// 持久化索引配置（排除目录 / 模式 / 保留目录），下次打开编辑器时回填
		try {
			this._cbmService.setIndexConfig(config);
		} catch { /* 持久化失败不阻塞索引 */ }

		this._appendLog(`🚀 开始索引 "${rootName}" (mode=${mode})...`);
		this._appendLog(`  路径: ${rootPath}`);

		const idxBtn = (this as any)._indexBtnEl as HTMLButtonElement | undefined;
		const cancelBtn = (this as any)._cancelBtnEl as HTMLButtonElement | undefined;
		if (idxBtn) { idxBtn.disabled = true; idxBtn.style.opacity = '0.5'; }
		if (cancelBtn) { cancelBtn.style.display = 'inline-block'; }

		this._indexCts = new CancellationTokenSource();
		try {
			const result = await this._graphService.indexWorkspace(rootPath, config, this._indexCts.token);
			if (!result.success && !this._indexCts.token.isCancellationRequested) {
				this._notificationService.warn(`索引失败: ${result.message}`);
			}
		} catch (err: any) {
			this._appendLog(`❌ 异常: ${err?.message || err}`);
			this._notificationService.error(`索引异常: ${err?.message || err}`);
		} finally {
			this._indexCts?.dispose();
			this._indexCts = undefined;
			if (idxBtn) { idxBtn.disabled = false; idxBtn.style.opacity = ''; }
			if (cancelBtn) { cancelBtn.style.display = 'none'; }
		}
	}

	private _cancelIndex(): void {
		const cancelBtn = (this as any)._cancelBtnEl as HTMLButtonElement | undefined;
		if (cancelBtn) { cancelBtn.style.display = 'none'; }
		this._graphService.cancelIndex();
	}

	// ── Helpers ──

	private _appendLog(line: string): void {
		if (!this._logEl) { return; }
		const entry = document.createElement('div');
		entry.textContent = line;
		this._logEl.appendChild(entry);
		this._logEl.scrollTop = this._logEl.scrollHeight;
	}

	private _getWorkspaceRoot(): string {
		const folders = this._workspaceService.getWorkspace().folders;
		return folders.length ? folders[0].uri.fsPath : '';
	}

	private _makeBtn(text: string, color: string): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.textContent = text;
		btn.style.cssText =
			`padding:4px 12px;border:1px solid ${color}44;border-radius:4px;background:transparent;` +
			`color:${color};font-size:12px;cursor:pointer;transition:all .15s;`;
		btn.addEventListener('mouseenter', () => { btn.style.background = `${color}22`; });
		btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
		return btn;
	}

	private _clearProgressListeners(): void {
		for (const d of this._progressDisposables) { d.dispose(); }
		this._progressDisposables = [];
	}
}
