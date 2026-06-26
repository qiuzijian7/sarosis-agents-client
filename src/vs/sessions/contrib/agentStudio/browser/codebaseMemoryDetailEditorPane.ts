/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { CodebaseMemoryDetailEditorInput } from './codebaseMemoryDetailEditorInput.js';
import { CodebaseGraphViewerEditorInput } from './codebaseGraphViewerEditorInput.js';
import { ICodebaseMemoryMcpService, ICodebaseMemoryMcpStatus, ISyncGraphResult, IGraphStatus, IIndexResult, IIndexConfig } from './codebaseMemoryMcpService.js';

const CSS_TEXT = `
.cbm-container { padding: 24px 32px; overflow-y: auto; height: 100%; box-sizing: border-box; font-size: 13px; color: var(--vscode-foreground); }
.cbm-title { font-size: 18px; font-weight: 600; margin-bottom: 20px; }
.cbm-status-card {
	background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border);
	border-radius: 10px; padding: 16px 20px; margin-bottom: 16px;
}
.cbm-status-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.cbm-status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.cbm-status-dot.running { background: #4ec9b0; box-shadow: 0 0 6px rgba(78,201,176,0.5); }
.cbm-status-dot.installed { background: #569cd6; }
.cbm-status-dot.not_installed { background: #f48771; }
.cbm-status-dot.installing { background: #dcdcaa; animation: cbm-pulse 1s infinite; }
@keyframes cbm-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.cbm-status-label { font-size: 14px; font-weight: 600; }
.cbm-status-label.running { color: #4ec9b0; }
.cbm-status-label.installed { color: #569cd6; }
.cbm-status-label.not_installed { color: #f48771; }
.cbm-status-label.installing { color: #dcdcaa; }
.cbm-info-row { display: flex; gap: 8px; font-size: 12px; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
.cbm-info-row .cbm-info-key { min-width: 70px; flex-shrink: 0; }
.cbm-info-row .cbm-info-val { color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; word-break: break-all; }
.cbm-actions { display: flex; gap: 10px; margin-bottom: 16px; }
.cbm-btn {
	padding: 8px 20px; border-radius: 6px; font-size: 13px; cursor: pointer; border: 1px solid var(--vscode-widget-border);
	background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); transition: opacity 0.15s;
}
.cbm-btn:hover { opacity: 0.85; }
.cbm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.cbm-btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border: none; }
.cbm-btn.mcp-color { background: #c586c0; color: #fff; border: none; }
.cbm-log-section { margin-top: 16px; }
.cbm-log-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
.cbm-log-box {
	background: var(--vscode-terminal-background, #1e1e1e); border: 1px solid var(--vscode-widget-border);
	border-radius: 8px; padding: 12px 16px; font-family: var(--vscode-terminal-font-family, monospace);
	font-size: 12px; line-height: 1.6; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
	user-select: text; -webkit-user-select: text; cursor: text;
}
.cbm-log-line { color: var(--vscode-terminal-foreground, #cccccc); user-select: text; -webkit-user-select: text; }
.cbm-log-line.success { color: #4ec9b0; }
.cbm-log-line.error { color: #f48771; }
.cbm-log-line.warn { color: #dcdcaa; }
.cbm-log-empty { color: var(--vscode-descriptionForeground); font-style: italic; }
.cbm-version-badge {
	font-size: 11px; padding: 2px 8px; border-radius: 10px;
	background: rgba(86,156,214,0.15); color: #569cd6; margin-left: 8px;
}
.cbm-version-badge.upgrade { background: rgba(220,220,170,0.15); color: #dcdcaa; cursor: pointer; }
.cbm-stat-row { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.cbm-stat-card {
	background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border);
	border-radius: 8px; padding: 10px 16px; min-width: 90px;
}
.cbm-stat-card .cbm-stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.cbm-stat-card .cbm-stat-value { font-size: 18px; font-weight: 700; }
.cbm-stat-card.green .cbm-stat-value { color: #4ec9b0; }
.cbm-stat-card.blue .cbm-stat-value { color: #569cd6; }
.cbm-stat-card.mcp .cbm-stat-value { color: #c586c0; }
`;

export class CodebaseMemoryDetailEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.codebaseMemoryDetail';

	private _container: HTMLElement | null = null;
	private _statusContent: HTMLElement | null = null;
	private _logContent: HTMLElement | null = null;
	private _status: ICodebaseMemoryMcpStatus | null = null;
	private _syncResult: ISyncGraphResult | null = null;
	private _graphStatus: IGraphStatus | null = null;
	private _logLines: string[] = [];

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@ICodebaseMemoryMcpService private readonly cbmService: ICodebaseMemoryMcpService,
	) {
		super(CodebaseMemoryDetailEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = append(parent, $('.cbm-container'));
		const style = document.createElement('style');
		style.textContent = CSS_TEXT;
		this._container.appendChild(style);

		// Subscribe to status changes
		this._register(this.cbmService.onDidStatusChange(status => {
			this._status = status;
			this._renderStatus();
		}));
		this._register(this.cbmService.onDidInstallLog(line => {
			this._appendLogLine(line);
		}));
		// Subscribe to graph sync results
		this._register(this.cbmService.onDidSyncGraph(result => {
			this._syncResult = result;
			this._renderSyncResult();
		}));
		// Subscribe to index progress
		this._register(this.cbmService.onDidIndexProgress(line => {
			this._appendLogLine(line);
		}));
		// Subscribe to index complete
		this._register(this.cbmService.onDidIndexComplete((result: IIndexResult) => {
			if (result.success) {
				this.notificationService.info(`索引完成 (${result.duration}s)`);
			} else {
				this.notificationService.warn(`索引失败: ${result.message}`);
			}
			// Refresh graph status after index completes
			this._renderGraphStatus();
		}));
	}

	override async setInput(input: CodebaseMemoryDetailEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._renderSkeleton();
		await this.cbmService.refreshStatus();
	}

	private _renderSkeleton(): void {
		if (!this._container) { return; }
		const styleEl = this._container.querySelector('style');
		clearNode(this._container);
		if (styleEl) { this._container.appendChild(styleEl); }

		append(this._container, $('.cbm-title')).textContent = '🧠 Codebase Memory MCP';

		this._statusContent = append(this._container, $('.cbm-status-content'));
		this._statusContent.textContent = '检测中...';

		// Log section
		const logSection = append(this._container, $('.cbm-log-section'));
		const logTitleRow = append(logSection, $('.cbm-log-title-row')) as HTMLElement;
		logTitleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;';
		const logTitle = append(logTitleRow, $('.cbm-log-title'));
		logTitle.textContent = '安装日志';
		logTitle.style.marginBottom = '0';
		const copyBtn = append(logTitleRow, $('.cbm-copy-btn')) as HTMLButtonElement;
		copyBtn.textContent = '📋 复制全部';
		copyBtn.title = '复制所有日志到剪贴板';
		copyBtn.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:4px;cursor:pointer;border:1px solid var(--vscode-widget-border);background:var(--vscode-editorWidget-background);color:var(--vscode-descriptionForeground);';
		copyBtn.onclick = async () => {
			const text = this._logLines.join('\n');
			try {
				await navigator.clipboard.writeText(text);
				copyBtn.textContent = '✓ 已复制';
			} catch {
				// Fallback: use textarea + execCommand
				const ta = document.createElement('textarea');
				ta.value = text;
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.appendChild(ta);
				ta.select();
				document.execCommand('copy');
				document.body.removeChild(ta);
				copyBtn.textContent = '✓ 已复制';
			}
			setTimeout(() => { copyBtn.textContent = '📋 复制全部'; }, 1500);
		};
		this._logContent = append(logSection, $('.cbm-log-box'));
	}

	private _renderStatus(): void {
		if (!this._statusContent || !this._status) { return; }
		clearNode(this._statusContent);

		const s = this._status;

		// Status card
		const card = append(this._statusContent, $('.cbm-status-card'));
		const statusRow = append(card, $('.cbm-status-row'));
		const dot = append(statusRow, $('.cbm-status-dot'));
		dot.classList.add(s.state);
		const label = append(statusRow, $('.cbm-status-label'));
		label.classList.add(s.state);
		const labels: Record<string, string> = {
			not_installed: '未安装', installing: '安装中...', installed: '已安装', running: '运行中',
		};
		label.textContent = labels[s.state] ?? s.state;

		// Version badge
		if (s.version) {
			const vBadge = append(statusRow, $('.cbm-version-badge'));
			vBadge.textContent = s.version;
		}
		if (s.latestVersion && s.version && s.latestVersion !== s.version) {
			const upBadge = append(statusRow, $('.cbm-version-badge.upgrade'));
			upBadge.textContent = `可升级到 ${s.latestVersion}`;
			upBadge.title = '点击升级';
			upBadge.onclick = () => void this.cbmService.upgrade();
		}

		// Info rows
		if (s.binaryPath) {
			this._appendInfoRow(card, '路径', s.binaryPath);
		}
		if (s.latestVersion) {
			this._appendInfoRow(card, '最新版本', s.latestVersion);
		}
		this._appendInfoRow(card, 'MCP 配置', s.mcpConfigured ? '✓ 已配置' : '✗ 未配置');
		this._appendInfoRow(card, 'MCP 状态', s.mcpRunning ? '✓ 运行中' : '○ 未运行');

		// Stats row (only when running)
		if (s.state === 'running') {
			const statsRow = append(this._statusContent, $('.cbm-stat-row'));
			this._appendStatCard(statsRow, '工具数', '14', 'mcp');
			this._appendStatCard(statsRow, '索引模式', 'FULL', 'blue');
			this._appendStatCard(statsRow, '状态', '●', 'green');
		}

		// Action buttons
		const actions = append(this._statusContent, $('.cbm-actions'));
		if (s.state === 'not_installed') {
			const btn = append(actions, $('.cbm-btn.primary')) as HTMLButtonElement;
			btn.textContent = '📦 安装';
			btn.onclick = () => void this.cbmService.install();
		} else if (s.state === 'installing') {
			const btn = append(actions, $('.cbm-btn')) as HTMLButtonElement;
			btn.textContent = '⏳ 安装中...';
			btn.disabled = true;
		} else {
			if (s.latestVersion && s.version && s.latestVersion !== s.version) {
				const btn = append(actions, $('.cbm-btn.primary')) as HTMLButtonElement;
				btn.textContent = '🔄 升级';
				btn.onclick = () => void this.cbmService.upgrade();
			}
			if (!s.mcpConfigured) {
				const btn = append(actions, $('.cbm-btn.mcp-color')) as HTMLButtonElement;
				btn.textContent = '🔌 配置 MCP';
				btn.onclick = async () => {
					await this.cbmService.install();
				};
			}
			// Sync to team button
			const syncBtn = append(actions, $('.cbm-btn')) as HTMLButtonElement;
			syncBtn.textContent = '🌐 同步到团队';
			syncBtn.title = '将 graph 同步到远程 Git 仓库（团队共享）';
			syncBtn.onclick = async () => {
				syncBtn.disabled = true;
				syncBtn.textContent = '⏳ 同步中...';
				this._appendLogLine('▶ 开始同步 graph 到远程仓库...');
				await this.cbmService.syncGraph();
				syncBtn.disabled = false;
				syncBtn.textContent = '🌐 同步到团队';
			};
			const refreshBtn = append(actions, $('.cbm-btn')) as HTMLButtonElement;
			refreshBtn.textContent = '🔄 刷新';
			refreshBtn.onclick = () => void this.cbmService.refreshStatus();
		}

		// Render sync result if available
		this._renderSyncResult();

		// Render graph status and actions
		this._renderGraphStatus();

		// Render existing log
		this._renderLog();
	}

	private _appendInfoRow(parent: HTMLElement, key: string, val: string): void {
		const row = append(parent, $('.cbm-info-row'));
		append(row, $('.cbm-info-key')).textContent = key;
		append(row, $('.cbm-info-val')).textContent = val;
	}

	private _appendStatCard(parent: HTMLElement, label: string, value: string, cls: string): void {
		const card = append(parent, $(`.cbm-stat-card.${cls}`));
		append(card, $('.cbm-stat-label')).textContent = label;
		append(card, $('.cbm-stat-value')).textContent = value;
	}

	private _renderSyncResult(): void {
		if (!this._statusContent || !this._syncResult) { return; }
		// Remove old sync result if exists
		const old = this._statusContent.querySelector('.cbm-sync-result');
		if (old) { old.remove(); }
		const r = this._syncResult;
		const el = append(this._statusContent, $('.cbm-sync-result'));
		el.style.cssText = 'margin-top:12px;padding:10px 16px;border-radius:8px;font-size:12px;';
		if (r.success) {
			el.style.background = 'rgba(78,201,176,0.1)';
			el.style.border = '1px solid rgba(78,201,176,0.3)';
			el.innerHTML = `<span style="color:#4ec9b0;">✓ ${r.message}</span>` +
				(r.branch ? `<br><span style="color:var(--vscode-descriptionForeground);">分支: ${r.branch}</span>` : '') +
				(r.remote ? `<br><span style="color:var(--vscode-descriptionForeground);">远程: ${r.remote}</span>` : '');
			this._appendLogLine(`✓ 同步成功: ${r.message}`);
		} else {
			el.style.background = 'rgba(244,135,113,0.1)';
			el.style.border = '1px solid rgba(244,135,113,0.3)';
			el.innerHTML = `<span style="color:#f48771;">✗ ${r.message}</span>`;
			this._appendLogLine(`✗ 同步失败: ${r.message}`);
		}
	}

	// ─── Graph Status & Actions ─────────────────────────────────────

	private async _renderGraphStatus(): Promise<void> {
		if (!this._statusContent) { return; }
		// Remove old graph section if exists
		const old = this._statusContent.querySelector('.cbm-graph-section');
		if (old) { old.remove(); }

		// Fetch graph status
		this._graphStatus = await this.cbmService.getGraphStatus();

		const section = append(this._statusContent, $('.cbm-graph-section')) as HTMLElement;
		section.style.cssText = 'margin-top:20px;padding:16px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:8px;';

		// Title
		const title = append(section, $('.cbm-graph-title')) as HTMLElement;
		title.textContent = '🧠 代码库 Graph';
		title.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:12px;';

		if (!this._graphStatus.exists) {
			// No graph yet — show index button to create one
			const empty = append(section, $('.cbm-graph-empty')) as HTMLElement;
			empty.textContent = '暂无 Graph 数据。点击下方按钮索引代码库。';
			empty.style.cssText = 'color:var(--vscode-descriptionForeground);font-size:12px;margin-bottom:12px;';

			// Index button (shown even when no graph exists)
			const noGraphActions = append(section, $('.cbm-graph-actions')) as HTMLElement;
			noGraphActions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
			this._appendIndexConfig(section);
			this._appendIndexButton(noGraphActions);
			return;
		}

		// Graph info
		const info = append(section, $('.cbm-graph-info')) as HTMLElement;
		info.style.cssText = 'margin-bottom:12px;';

		if (this._graphStatus.size !== undefined) {
			const sizeStr = this._graphStatus.size > 1024 * 1024
				? `${(this._graphStatus.size / (1024 * 1024)).toFixed(2)} MB`
				: this._graphStatus.size > 1024
					? `${(this._graphStatus.size / 1024).toFixed(2)} KB`
					: `${this._graphStatus.size} B`;
			const row = append(info, $('.cbm-graph-info-row')) as HTMLElement;
			row.style.cssText = 'display:flex;gap:8px;margin-bottom:4px;font-size:12px;';
			const key = append(row, $('span')) as HTMLElement;
			key.textContent = '大小: ';
			key.style.color = 'var(--vscode-descriptionForeground)';
			const val = append(row, $('span')) as HTMLElement;
			val.textContent = sizeStr;
			val.style.color = 'var(--vscode-foreground)';
		}

		if (this._graphStatus.lastModified) {
			const date = new Date(this._graphStatus.lastModified);
			const row = append(info, $('.cbm-graph-info-row')) as HTMLElement;
			row.style.cssText = 'display:flex;gap:8px;margin-bottom:4px;font-size:12px;';
			const key = append(row, $('span')) as HTMLElement;
			key.textContent = '最后更新: ';
			key.style.color = 'var(--vscode-descriptionForeground)';
			const val = append(row, $('span')) as HTMLElement;
			val.textContent = date.toLocaleString();
			val.style.color = 'var(--vscode-foreground)';
		}

		if (this._graphStatus.gitBranch) {
			const row = append(info, $('.cbm-graph-info-row')) as HTMLElement;
			row.style.cssText = 'display:flex;gap:8px;margin-bottom:4px;font-size:12px;';
			const key = append(row, $('span')) as HTMLElement;
			key.textContent = '分支: ';
			key.style.color = 'var(--vscode-descriptionForeground)';
			const val = append(row, $('span')) as HTMLElement;
			val.textContent = this._graphStatus.gitBranch;
			val.style.color = 'var(--vscode-foreground)';
		}

		if (this._graphStatus.gitCommit) {
			const row = append(info, $('.cbm-graph-info-row')) as HTMLElement;
			row.style.cssText = 'display:flex;gap:8px;margin-bottom:4px;font-size:12px;';
			const key = append(row, $('span')) as HTMLElement;
			key.textContent = '提交: ';
			key.style.color = 'var(--vscode-descriptionForeground)';
			const val = append(row, $('span')) as HTMLElement;
			val.textContent = this._graphStatus.gitCommit;
			val.style.color = 'var(--vscode-foreground)';
		}

		// Actions
		const actions = append(section, $('.cbm-graph-actions')) as HTMLElement;
		actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

		// Index configuration
		this._appendIndexConfig(section);

		// Index repository button (primary action)
		this._appendIndexButton(actions);

		// View 3D Graph visualization button
		const viewBtn = append(actions, $('.cbm-btn.primary')) as HTMLButtonElement;
		viewBtn.textContent = '🌐 查看 3D Graph';
		viewBtn.title = '在新标签页中打开 3D Graph 可视化（Built-in 3D graph visualization）';
		viewBtn.style.background = '#c586c0';
		viewBtn.onclick = () => {
			const input = CodebaseGraphViewerEditorInput.getOrCreate();
			this.editorService.openEditor(input, { pinned: true });
		};

		// Pull from team button
		const pullBtn = append(actions, $('.cbm-btn')) as HTMLButtonElement;
		pullBtn.textContent = '⬇ 下载团队 Graph';
		pullBtn.title = '从远程 Git 仓库拉取团队共享的 Graph';
		pullBtn.onclick = async () => {
			pullBtn.disabled = true;
			pullBtn.textContent = '⏳ 下载中...';
			this._appendLogLine('▶ 开始从远程仓库下载 Graph...');
			const result = await this.cbmService.pullGraph();
			if (result.success) {
				this.notificationService.info(result.message);
				this._appendLogLine(`✓ ${result.message}`);
			} else {
				this.notificationService.warn(result.message);
				this._appendLogLine(`✗ ${result.message}`);
			}
			pullBtn.disabled = false;
			pullBtn.textContent = '⬇ 下载团队 Graph';
			// Refresh graph status
			this._graphStatus = await this.cbmService.getGraphStatus();
			this._renderGraphStatus();
		};

		// Open graph directory button
		const openBtn = append(actions, $('.cbm-btn')) as HTMLButtonElement;
		openBtn.textContent = '📂 打开 Graph 目录';
		openBtn.title = '在文件管理器中打开 Graph 目录';
		openBtn.onclick = () => {
			if (this._graphStatus?.graphPath) {
				this._openFolder(this._graphStatus.graphPath);
			}
		};
	}

	private _appendIndexConfig(parent: HTMLElement): void {
		const config = this.cbmService.getIndexConfig();
		const cfgSection = append(parent, $('.cbm-index-config')) as HTMLElement;
		cfgSection.style.cssText = 'margin-bottom:12px;padding:10px 12px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:8px;';

		// 标题
		const title = append(cfgSection, $('div')) as HTMLElement;
		title.textContent = '⚙ 索引配置';
		title.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:8px;color:var(--vscode-foreground);';

		// Mode 选择
		const modeRow = append(cfgSection, $('div')) as HTMLElement;
		modeRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
		const modeLabel = append(modeRow, $('label')) as HTMLLabelElement;
		modeLabel.textContent = '索引模式:';
		modeLabel.style.cssText = 'font-size:12px;min-width:70px;color:var(--vscode-descriptionForeground);';
		const modeSelect = append(modeRow, $('select')) as HTMLSelectElement;
		modeSelect.style.cssText = 'flex:1;max-width:200px;font-size:12px;padding:2px 4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;';
		const modes: { value: string; label: string }[] = [
			{ value: 'fast', label: 'Fast — 过滤文件，无语义分析（推荐，内存小）' },
			{ value: 'moderate', label: 'Moderate — 过滤文件 + 语义分析' },
			{ value: 'full', label: 'Full — 全部文件 + 语义分析（最慢，内存大）' },
		];
		for (const m of modes) {
			const opt = append(modeSelect, $('option')) as HTMLOptionElement;
			opt.value = m.value;
			opt.textContent = m.label;
			if (m.value === config.mode) { opt.selected = true; }
		}

		// 索引路径（子目录）
		const subRow = append(cfgSection, $('div')) as HTMLElement;
		subRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
		const subLabel = append(subRow, $('label')) as HTMLLabelElement;
		subLabel.textContent = '索引路径:';
		subLabel.style.cssText = 'font-size:12px;min-width:70px;color:var(--vscode-descriptionForeground);';
		const subInput = append(subRow, $('input')) as HTMLInputElement;
		subInput.type = 'text';
		subInput.value = config.subPath || '';
		subInput.placeholder = '留空=整个工作区，或输入子目录如 src/vs/sessions';
		subInput.style.cssText = 'flex:1;font-size:12px;padding:3px 6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;';

		// 排除目录输入
		const exclRow = append(cfgSection, $('div')) as HTMLElement;
		exclRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
		const exclLabel = append(exclRow, $('label')) as HTMLLabelElement;
		exclLabel.textContent = '排除目录:';
		exclLabel.style.cssText = 'font-size:12px;min-width:70px;color:var(--vscode-descriptionForeground);';
		const exclInput = append(exclRow, $('input')) as HTMLInputElement;
		exclInput.type = 'text';
		exclInput.value = config.excludeDirs.join(', ');
		exclInput.placeholder = 'node_modules, .git, build, out, dist';
		exclInput.style.cssText = 'flex:1;font-size:12px;padding:3px 6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;';

		// 保存按钮
		const saveBtn = append(cfgSection, $('.cbm-btn')) as HTMLButtonElement;
		saveBtn.textContent = '💾 保存配置';
		saveBtn.style.cssText = 'font-size:12px;padding:3px 10px;';
		saveBtn.onclick = () => {
			const mode = modeSelect.value as IIndexConfig['mode'];
			const excludeDirs = exclInput.value.split(',').map(s => s.trim()).filter(s => s);
			const subPath = subInput.value.trim();
			const newConfig: IIndexConfig = { mode, excludeDirs, subPath: subPath || undefined };
			this.cbmService.setIndexConfig(newConfig);
			const pathDesc = subPath ? `路径: ${subPath}` : '路径: 整个工作区';
			this.notificationService.info(`索引配置已保存 (模式: ${mode}, ${pathDesc}, 排除 ${excludeDirs.length} 个目录)`);
			// 重新渲染 graph 区域，让 UI 反映最新配置
			this._renderGraphStatus();
		};
	}

	private _appendIndexButton(parent: HTMLElement): void {
		const indexBtn = append(parent, $('.cbm-btn.primary')) as HTMLButtonElement;
		indexBtn.textContent = '🔍 索引代码库';
		indexBtn.title = '扫描并索引当前代码库，构建代码知识图谱';
		indexBtn.onclick = async () => {
			// 正在索引中 → 点击取消
			if (this.cbmService.isIndexing) {
				indexBtn.disabled = true;
				indexBtn.textContent = '⏳ 取消中...';
				this.cbmService.cancelIndex();
				return;
			}
			// 开始索引：按钮变为可取消状态
			indexBtn.textContent = '✗ 取消索引';
			indexBtn.title = '点击取消正在进行的索引操作';
			this._appendLogLine('▶ 开始索引代码库...');
			const result = await this.cbmService.indexRepository();
			if (result.success) {
				this.notificationService.info(`索引完成 (${result.duration}s)`);
				this._appendLogLine(`✓ 索引完成: ${result.message} (${result.duration}s)`);
			} else {
				this.notificationService.warn(result.message);
				this._appendLogLine(`✗ ${result.message}`);
			}
			indexBtn.disabled = false;
			indexBtn.textContent = '🔍 索引代码库';
			indexBtn.title = '扫描并索引当前代码库，构建代码知识图谱';
		};
	}

	private _openFolder(filePath: string): void {
		// 使用 VS Code 内置 revealFileInOS 命令，在文件管理器中打开并选中文件
		// （sandbox 环境下 require('path'/'electron') 不可用，改用此方案）
		const uri = URI.file(filePath);
		this.commandService.executeCommand('revealFileInOS', uri);
	}

	private _renderLog(): void {
		if (!this._logContent) { return; }
		// Merge installLog from status into _logLines (if any new entries)
		if (this._status?.installLog && this._status.installLog.length > 0) {
			for (const line of this._status.installLog) {
				if (!this._logLines.includes(line)) {
					this._logLines.push(line);
				}
			}
		}
		clearNode(this._logContent);
		if (this._logLines.length === 0) {
			this._logContent.textContent = '暂无日志';
			return;
		}
		for (const line of this._logLines) {
			const el = append(this._logContent, $('.cbm-log-line'));
			el.textContent = line;
			if (line.startsWith('✓')) { el.classList.add('success'); }
			else if (line.startsWith('✗')) { el.classList.add('error'); }
			else if (line.startsWith('⚠') || line.startsWith('  !')) { el.classList.add('warn'); }
		}
		// Auto-scroll to bottom
		this._logContent.scrollTop = this._logContent.scrollHeight;
	}

	private _appendLogLine(line: string): void {
		// Persist to instance variable for survival across re-renders
		this._logLines.push(line);
		if (!this._logContent) { return; }
		// Remove "暂无日志" placeholder
		if (this._logContent.children.length === 0 || this._logContent.textContent === '暂无日志') {
			clearNode(this._logContent);
		}
		const el = append(this._logContent, $('.cbm-log-line'));
		el.textContent = line;
		if (line.startsWith('✓')) { el.classList.add('success'); }
		else if (line.startsWith('✗')) { el.classList.add('error'); }
		else if (line.startsWith('⚠') || line.startsWith('  !')) { el.classList.add('warn'); }
		this._logContent.scrollTop = this._logContent.scrollHeight;
	}

	override layout(_dimension: { width: number; height: number }): void {
		// No special layout needed
	}
}
