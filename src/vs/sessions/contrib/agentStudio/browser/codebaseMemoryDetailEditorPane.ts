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
import { ICodebaseMemoryMcpService, IIndexConfig } from './codebaseMemoryMcpService.js';
import { ICodebaseGraphService, IGraphStatus } from './codebaseGraphService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';

const CSS_TEXT = `
.cbm-container { padding: 24px 28px 48px; overflow-y: auto; height: 100%; box-sizing: border-box; font-size: 13px; color: var(--vscode-foreground); max-width: 900px; margin: 0 auto; }
.cbm-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
.cbm-header-left { display: flex; align-items: center; gap: 14px; }
.cbm-logo { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #80a0ff, #c586c0); display: flex; align-items: center; justify-content: center; font-size: 22px; box-shadow: 0 0 20px rgba(128,160,255,0.3); flex-shrink: 0; }
.cbm-title-group h1 { font-size: 18px; font-weight: 700; margin: 0; }
.cbm-title-group p { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 2px 0 0; }
.cbm-header-status { display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 20px; }
.cbm-header-status.ready { background: rgba(78,201,176,0.1); border: 1px solid rgba(78,201,176,0.3); }
.cbm-header-status.indexing { background: rgba(220,220,170,0.1); border: 1px solid rgba(220,220,170,0.3); }
.cbm-header-status.empty { background: rgba(244,135,113,0.1); border: 1px solid rgba(244,135,113,0.3); }
.cbm-header-status .dot { width: 8px; height: 8px; border-radius: 50%; }
.cbm-header-status.ready .dot { background: #4ec9b0; box-shadow: 0 0 6px #4ec9b0; animation: cbm-pulse 2s infinite; }
.cbm-header-status.indexing .dot { background: #dcdcaa; animation: cbm-pulse 1s infinite; }
.cbm-header-status.empty .dot { background: #f48771; }
@keyframes cbm-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
.cbm-header-status .text { font-size: 12px; font-weight: 600; }
.cbm-header-status.ready .text { color: #4ec9b0; }
.cbm-header-status.indexing .text { color: #dcdcaa; }
.cbm-header-status.empty .text { color: #f48771; }
.cbm-stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.cbm-stat-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 10px; padding: 14px 16px; transition: all 0.15s ease; position: relative; overflow: hidden; }
.cbm-stat-card:hover { border-color: var(--vscode-input-border); }
.cbm-stat-card::before { content: ''; position: absolute; top: 0; left: 0; width: 3px; height: 100%; }
.cbm-stat-card.accent::before { background: #80a0ff; }
.cbm-stat-card.green::before { background: #4ec9b0; }
.cbm-stat-card.purple::before { background: #c586c0; }
.cbm-stat-card.blue::before { background: #569cd6; }
.cbm-stat-card .stat-icon { font-size: 16px; margin-bottom: 6px; }
.cbm-stat-card .stat-value { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
.cbm-stat-card .stat-label { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
.cbm-stat-card .stat-sub { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.7; margin-top: 2px; }
.cbm-section { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 10px; margin-bottom: 12px; overflow: hidden; }
.cbm-section-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--vscode-widget-border); background: rgba(255,255,255,0.02); cursor: pointer; user-select: none; }
.cbm-section-header:hover { background: rgba(255,255,255,0.05); }
.cbm-section-header h2 { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.cbm-section-header .cbm-collapse-arrow { font-size: 10px; color: var(--vscode-descriptionForeground); transition: transform 0.15s ease; margin-right: 4px; }
.cbm-section.collapsed .cbm-collapse-arrow { transform: rotate(-90deg); }
.cbm-section.collapsed .cbm-section-body { display: none; }
.cbm-section-header .badge { font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
.cbm-section-header .badge.accent { background: rgba(128,160,255,0.15); color: #80a0ff; }
.cbm-section-header .badge.warn { background: rgba(220,220,170,0.15); color: #dcdcaa; }
.cbm-section-header .badge.green { background: rgba(78,201,176,0.15); color: #4ec9b0; }
.cbm-section-body { padding: 14px 16px; }
.cbm-config-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.cbm-config-row:last-child { margin-bottom: 0; }
.cbm-config-label { min-width: 70px; font-size: 12px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
.cbm-segmented { display: flex; gap: 0; border: 1px solid var(--vscode-widget-border); border-radius: 6px; overflow: hidden; flex: 1; }
.cbm-segmented button { flex: 1; padding: 6px 10px; border: none; background: transparent; color: var(--vscode-descriptionForeground); font-size: 12px; cursor: pointer; transition: all 0.15s ease; border-right: 1px solid var(--vscode-widget-border); }
.cbm-segmented button:last-child { border-right: none; }
.cbm-segmented button:hover { background: rgba(255,255,255,0.05); color: var(--vscode-foreground); }
.cbm-segmented button.active { background: rgba(128,160,255,0.15); color: #80a0ff; font-weight: 600; }
.cbm-input { flex: 1; padding: 6px 10px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; color: var(--vscode-input-foreground); font-size: 12px; outline: none; transition: all 0.15s ease; }
.cbm-input:focus { border-color: #80a0ff; box-shadow: 0 0 0 2px rgba(128,160,255,0.15); }
.cbm-input::placeholder { color: var(--vscode-descriptionForeground); opacity: 0.6; }
.cbm-btn-group { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
.cbm-btn { padding: 7px 16px; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; border: 1px solid var(--vscode-widget-border); background: var(--vscode-input-background); color: var(--vscode-foreground); transition: all 0.15s ease; display: flex; align-items: center; gap: 6px; }
.cbm-btn:hover { border-color: var(--vscode-input-border); background: var(--vscode-editorWidget-background); }
.cbm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.cbm-btn.primary { background: #80a0ff; color: #1a1a28; border-color: #80a0ff; font-weight: 600; }
.cbm-btn.primary:hover { background: #90b0ff; box-shadow: 0 0 10px rgba(128,160,255,0.3); }
.cbm-btn.purple { background: #c586c0; color: #fff; border-color: #c586c0; font-weight: 600; }
.cbm-btn.purple:hover { background: #d496d0; }
.cbm-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; }
.cbm-info-item { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; gap: 8px; }
.cbm-info-item .key { color: var(--vscode-descriptionForeground); white-space: nowrap; }
.cbm-info-item .val { color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; text-align: right; word-break: break-all; }
.cbm-progress { height: 4px; background: var(--vscode-input-background); border-radius: 2px; overflow: hidden; margin-top: 10px; }
.cbm-progress-bar { height: 100%; background: linear-gradient(90deg, #80a0ff, #c586c0); border-radius: 2px; transition: width 0.3s ease; }
.cbm-progress-text { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; display: flex; justify-content: space-between; }
.cbm-log { background: var(--vscode-terminal-background, #1a1a28); border: 1px solid var(--vscode-widget-border); border-radius: 6px; padding: 10px 14px; font-family: var(--vscode-terminal-font-family, monospace); font-size: 11px; line-height: 1.7; max-height: 220px; overflow-y: auto; user-select: text; -webkit-user-select: text; cursor: text; }
.cbm-log-line { color: var(--vscode-terminal-foreground, #ccc); user-select: text; }
.cbm-log-line.success { color: #4ec9b0; }
.cbm-log-line.error { color: #f48771; }
.cbm-log-line.warn { color: #dcdcaa; }
.cbm-log-line.info { color: #569cd6; }
.cbm-log-empty { color: var(--vscode-descriptionForeground); font-style: italic; }
.cbm-section-log { background: var(--vscode-terminal-background, #1a1a28); border: 1px solid var(--vscode-widget-border); border-radius: 6px; padding: 8px 12px; font-family: var(--vscode-terminal-font-family, monospace); font-size: 11px; line-height: 1.6; max-height: 180px; overflow-y: auto; margin-top: 10px; display: none; }
.cbm-section-log.visible { display: block; }
.cbm-section-log .log-line { color: var(--vscode-terminal-foreground, #ccc); white-space: pre-wrap; word-break: break-all; }
.cbm-section-log .log-line.success { color: #4ec9b0; }
.cbm-section-log .log-line.error { color: #f48771; }
.cbm-section-log .log-line.warn { color: #dcdcaa; }
.cbm-section-log .log-line.info { color: #569cd6; }
.cbm-progress-bar { height: 4px; background: var(--vscode-input-background); border-radius: 2px; overflow: hidden; margin-top: 8px; display: none; }
.cbm-progress-bar.visible { display: block; }
.cbm-progress-bar-fill { height: 100%; background: linear-gradient(90deg, #80a0ff, #c586c0); border-radius: 2px; transition: width 0.3s ease; width: 0%; }
.cbm-lang-badges { display: flex; gap: 6px; flex-wrap: wrap; }
.cbm-lang-badge { font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
.cbm-lang-badge.ts { background: rgba(86,156,214,0.15); color: #569cd6; }
.cbm-lang-badge.js { background: rgba(220,220,170,0.15); color: #dcdcaa; }
.cbm-lang-badge.py { background: rgba(78,201,176,0.15); color: #4ec9b0; }
.cbm-lang-badge.go { background: rgba(128,160,255,0.15); color: #80a0ff; }
.cbm-lang-badge.rs { background: rgba(206,145,120,0.15); color: #ce9178; }
.cbm-lang-badge.other { background: rgba(197,134,192,0.15); color: #c586c0; }
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--vscode-widget-border); border-radius: 3px; }
`;

export class CodebaseMemoryDetailEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.codebaseMemoryDetail';

	private _container: HTMLElement | null = null;
	private _content: HTMLElement | null = null;
	private _logContent: HTMLElement | null = null;
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
		@ICodebaseGraphService private readonly _graphService: ICodebaseGraphService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(CodebaseMemoryDetailEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = append(parent, $('.cbm-container'));
		const style = document.createElement('style');
		style.textContent = CSS_TEXT;
		this._container.appendChild(style);

		// Subscribe to native graph service events
		this._register(this._graphService.onDidIndexProgress(line => {
			this._appendLogLine(line);
		}));
		this._register(this._graphService.onDidIndexComplete(result => {
			if (result.success) {
				this.notificationService.info(`索引完成 (${result.duration}s)`);
			} else {
				this.notificationService.warn(`索引失败: ${result.message}`);
			}
			this._renderAll();
		}));
	}

	override async setInput(input: CodebaseMemoryDetailEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._renderAll();
	}

	// ─── Main Render ──────────────────────────────────────────────────────

	private async _renderAll(): Promise<void> {
		if (!this._container) { return; }
		const t0 = Date.now();
		this._logService.info('[CodebaseMemory]', `[render] start`);

		const styleEl = this._container.querySelector('style');
		clearNode(this._container);
		if (styleEl) { this._container.appendChild(styleEl); }

		// 先渲染一个 loading 占位
		this._content = append(this._container, $('div'));
		this._content.style.cssText = 'padding:40px;text-align:center;color:var(--vscode-descriptionForeground);';
		this._content.textContent = '⏳ 加载中...';
		await this._yieldToUI();

		// Fetch graph status (异步 I/O)
		const tStatus = Date.now();
		this._graphStatus = await this._graphService.getGraphStatus();
		this._logService.info('[CodebaseMemory]', `[render] getGraphStatus: exists=${this._graphStatus.exists} (${Date.now() - tStatus}ms)`);

		const hasData = this._graphService.hasGraphData();
		this._logService.info('[CodebaseMemory]', `[render] hasGraphData=${hasData}`);

		// 清除 loading，开始渲染实际内容
		clearNode(this._content);
		this._content.style.cssText = '';

		// Header
		this._renderHeader(this._graphService.isIndexing);

		// 同步 CPU 操作之间 yield
		const isIndexing = this._graphService.isIndexing;

		if (this._graphStatus.exists && hasData) {
			await this._yieldToUI();
			const tSchema = Date.now();
			const schema = this._graphService.getGraphSchema();
			this._logService.info('[CodebaseMemory]', `[render] getGraphSchema: ${schema.totalNodes} nodes, ${schema.totalEdges} edges (${Date.now() - tSchema}ms)`);

			await this._yieldToUI();
			const tIdx = Date.now();
			const indexStatus = this._graphService.getIndexStatus();
			this._logService.info('[CodebaseMemory]', `[render] getIndexStatus (${Date.now() - tIdx}ms)`);

			// Stats dashboard
			if (schema && indexStatus) {
				this._renderStats(schema, indexStatus);
			}

			// Index config section
			this._renderIndexConfig();

			// Graph details section
			this._renderGraphDetails(schema);

			// Architecture analysis — deferred for large graphs to avoid UI freeze
			// analyzeArchitecture() iterates all nodes+edges multiple times
			// 阈值：节点 < 10k 且 边 < 50k 才同步计算，否则延迟
			const isLargeGraph = schema.totalNodes >= 10000 || schema.totalEdges >= 50000;
			if (isLargeGraph) {
				this._renderArchitectureDeferred(schema.totalNodes, schema.totalEdges);
			} else {
				await this._yieldToUI();
				const tArch = Date.now();
				this._renderArchitecture();
				this._logService.info('[CodebaseMemory]', `[render] renderArchitecture (${Date.now() - tArch}ms)`);
			}

			// Query console
			this._renderQueryConsole();
			// Analysis tools (P3 API)
			this._renderAnalysisTools();
			// Project management (multi-project)
			this._renderProjectManager();
		} else {
			this._renderIndexConfig();
		}

		// Indexing progress section (only when indexing)
		if (isIndexing) {
			this._renderProgress();
		}

		// Activity log
		this._renderLogSection();
		this._renderLog();

		this._logService.info('[CodebaseMemory]', `[render] done (${Date.now() - t0}ms)`);
	}

	/** Yield 到 UI 线程：让浏览器有机会渲染 DOM */
	private _yieldToUI(): Promise<void> {
		return new Promise<void>(resolve => {
			requestAnimationFrame(() => setTimeout(resolve, 0));
		});
	}

	// ─── Header ───────────────────────────────────────────────────────────

	private _renderHeader(isIndexing: boolean): void {
		if (!this._content) { return; }
		const header = append(this._content, $('.cbm-header'));
		const left = append(header, $('.cbm-header-left'));
		const logo = append(left, $('.cbm-logo'));
		logo.textContent = '🧠';
		const titleGroup = append(left, $('.cbm-title-group'));
		append(titleGroup, $('h1')).textContent = 'Codebase Memory';
		const subtitle = append(titleGroup, $('p'));
		subtitle.textContent = 'Native tree-sitter code graph · No external binary required';

		const statusCls = isIndexing ? 'indexing' : (this._graphStatus?.exists ? 'ready' : 'empty');
		const statusText = isIndexing ? 'Indexing...' : (this._graphStatus?.exists ? 'Ready' : 'Not Indexed');
		const statusEl = append(header, $('.cbm-header-status')) as HTMLElement;
		statusEl.classList.add(statusCls);
		append(statusEl, $('.dot'));
		append(statusEl, $('.text')).textContent = statusText;
	}

	// ─── Section helpers ─────────────────────────────────────────────────

	/** 创建可折叠的 section，返回 { section, body, logEl } */
	private _createCollapsibleSection(title: string, icon: string, badgeText?: string, badgeCls?: string): { section: HTMLElement; body: HTMLElement; logEl: HTMLElement } {
		const section = append(this._content!, $('.cbm-section'));
		const header = append(section, $('.cbm-section-header'));
		const arrow = append(header, $('.cbm-collapse-arrow'));
		arrow.textContent = '▼';
		const h2 = append(header, $('h2'));
		h2.textContent = `${icon} ${title}`;
		if (badgeText) {
			const badge = append(header, $(`.badge.${badgeCls || 'accent'}`));
			badge.textContent = badgeText;
		}
		const body = append(section, $('.cbm-section-body'));
		const logEl = append(body, $('.cbm-section-log'));

		// 折叠/展开
		header.addEventListener('click', (e) => {
			// 不折叠点击按钮/输入框区域
			if ((e.target as HTMLElement).tagName === 'BUTTON' || (e.target as HTMLElement).tagName === 'INPUT') { return; }
			section.classList.toggle('collapsed');
		});

		return { section, body, logEl };
	}

	/** 向 section log 添加日志行 */
	private _appendSectionLog(logEl: HTMLElement, text: string, cls: string = ''): void {
		const line = append(logEl, $('.log-line' + (cls ? '.' + cls : '')));
		const time = new Date().toLocaleTimeString();
		line.textContent = `[${time}] ${text}`;
		logEl.classList.add('visible');
		logEl.scrollTop = logEl.scrollHeight;
	}

	// ─── Stats Dashboard ──────────────────────────────────────────────────

	private _renderStats(schema: { nodeLabels: { label: string; count: number }[]; edgeTypes: { type: string; count: number }[]; totalNodes: number; totalEdges: number }, indexStatus: { project: string; exists: boolean; nodeCount: number; edgeCount: number; fileCount: number }): void {
		if (!this._content) { return; }
		const grid = append(this._content, $('.cbm-stats-grid'));

		// Count file nodes from schema
		const fileCount = schema.nodeLabels.find(l => l.label === 'file')?.count || indexStatus.fileCount || 0;

		// Nodes card
		this._appendStatCard(grid, 'accent', '🔗', String(schema.totalNodes), 'Nodes', 'functions · classes · interfaces');

		// Edges card
		this._appendStatCard(grid, 'green', '↔️', String(schema.totalEdges), 'Edges', 'calls · imports · defines');

		// Files card
		this._appendStatCard(grid, 'blue', '📁', String(fileCount), 'Files', 'indexed source files');

		// Last index card
		const lastModified = this._graphStatus?.lastModified;
		const timeStr = lastModified ? this._formatTime(new Date(lastModified)) : '—';
		this._appendStatCard(grid, 'purple', '⚡', timeStr, 'Last Index', this._graphStatus?.size ? this._formatSize(this._graphStatus.size) : '');
	}

	private _appendStatCard(parent: HTMLElement, cls: string, icon: string, value: string, label: string, sub: string): void {
		const card = append(parent, $(`.cbm-stat-card.${cls}`));
		append(card, $('.stat-icon')).textContent = icon;
		append(card, $('.stat-value')).textContent = value;
		append(card, $('.stat-label')).textContent = label;
		if (sub) { append(card, $('.stat-sub')).textContent = sub; }
	}

	// ─── Index Config Section ─────────────────────────────────────────────

	private _renderIndexConfig(): void {
		if (!this._content) { return; }
		const config = this.cbmService.getIndexConfig();

		const { section, body, logEl } = this._createCollapsibleSection('Index Configuration', '⚙️', config.mode.toUpperCase(), 'accent');
		const badge = section.querySelector('.badge')!;

		// 日志栏移到 body 最后（在所有配置元素之后）
		logEl.remove(); // 从当前位置移除

		// Mode segmented control
		const modeRow = append(body, $('.cbm-config-row'));
		append(modeRow, $('.cbm-config-label')).textContent = 'Mode';
		const segmented = append(modeRow, $('.cbm-segmented')) as HTMLElement;
		const modes: { value: string; label: string }[] = [
			{ value: 'fast', label: '⚡ Fast' },
			{ value: 'moderate', label: '⚖️ Moderate' },
			{ value: 'full', label: '🔬 Full' },
		];
		const modeBtns: HTMLButtonElement[] = [];
		for (const m of modes) {
			const btn = append(segmented, $('button')) as HTMLButtonElement;
			btn.textContent = m.label;
			btn.dataset.mode = m.value;
			if (m.value === config.mode) { btn.classList.add('active'); }
			modeBtns.push(btn);
		}
		// Mode selection toggle
		segmented.addEventListener('click', (e) => {
			const target = e.target as HTMLButtonElement;
			if (target.tagName !== 'BUTTON') { return; }
			modeBtns.forEach(b => b.classList.remove('active'));
			target.classList.add('active');
		});

		// Index path
		const pathRow = append(body, $('.cbm-config-row'));
		append(pathRow, $('.cbm-config-label')).textContent = 'Index Path';
		const pathInput = append(pathRow, $('input.cbm-input')) as HTMLInputElement;
		pathInput.type = 'text';
		pathInput.value = config.subPath || '';
		pathInput.placeholder = 'Leave empty for entire workspace, or e.g. src/vs/sessions';

		// Exclude dirs
		const exclRow = append(body, $('.cbm-config-row'));
		append(exclRow, $('.cbm-config-label')).textContent = 'Exclude';
		const exclInput = append(exclRow, $('input.cbm-input')) as HTMLInputElement;
		exclInput.type = 'text';
		exclInput.value = config.excludeDirs.join(', ');
		exclInput.placeholder = 'node_modules, .git, build, out, dist, Intermediate, Saved, Binaries';

		// Keep dirs (保留目录：即使父目录被排除也保留)
		const keepRow = append(body, $('.cbm-config-row'));
		append(keepRow, $('.cbm-config-label')).textContent = 'Keep';
		const keepInput = append(keepRow, $('input.cbm-input')) as HTMLInputElement;
		keepInput.type = 'text';
		keepInput.value = (config.keepDirs || []).join(', ');
		keepInput.placeholder = 'Content/Script, Content/Blueprints (保留被排除目录的子目录)';

		// Action buttons
		const btnGroup = append(body, $('.cbm-btn-group'));

		// 进度条 + 日志栏（放在 button group 之后，body 末尾）
		const progressEl = append(body, $('.cbm-progress-bar'));
		const progressFill = append(progressEl, $('.cbm-progress-bar-fill'));
		body.appendChild(logEl); // 日志栏移到末尾

		// Index button (primary)
		const indexBtn = append(btnGroup, $('.cbm-btn.primary')) as HTMLButtonElement;
		indexBtn.textContent = '🔍 Index Codebase';
		indexBtn.title = 'Scan and index current codebase';
		indexBtn.onclick = async () => {
			if (this._graphService.isIndexing) {
				indexBtn.disabled = true;
				indexBtn.textContent = '⏳ Cancelling...';
				this._graphService.cancelIndex();
				return;
			}
			// Save config before indexing
			const mode = modeBtns.find(b => b.classList.contains('active'))?.dataset.mode || 'fast';
			const newConfig: IIndexConfig = {
				mode: mode as IIndexConfig['mode'],
				excludeDirs: exclInput.value.split(',').map(s => s.trim()).filter(s => s),
				keepDirs: keepInput.value.split(',').map(s => s.trim()).filter(s => s),
				subPath: pathInput.value.trim() || undefined,
			};
			clearNode(logEl);
			progressEl.classList.add('visible');
			progressFill.style.width = '0%';
			section.classList.remove('collapsed');

			indexBtn.textContent = '✗ Cancel Index';
			indexBtn.title = 'Click to cancel indexing';
			this._appendSectionLog(logEl, '▶ 开始索引代码库...', 'info');

			const folders = this._workspaceService.getWorkspace().folders;
			if (folders.length === 0) {
				this._appendSectionLog(logEl, '✗ 未打开工作区', 'error');
				progressEl.classList.remove('visible');
				indexBtn.disabled = false;
				indexBtn.textContent = '🔍 Index Codebase';
				return;
			}
			const wsPath = folders[0].uri.fsPath;
			this._appendSectionLog(logEl, `📁 工作区: ${wsPath}`);

			// 订阅索引进度
			let progressReceived = 0;
			const progressDisposable = this._graphService.onDidIndexProgress(line => {
				progressReceived++;
				this._appendSectionLog(logEl, line);
				// 从进度文字提取百分比：如 "解析中 (50/100) 50%"
				const pctMatch = line.match(/(\d+)%/);
				if (pctMatch) {
					progressFill.style.width = pctMatch[1] + '%';
				} else {
					// 从 (N/total) 格式计算百分比
					const match = line.match(/\((\d+)\/(\d+)\)/);
					if (match) {
						const pct = Math.min(100, Math.round(parseInt(match[1]) / parseInt(match[2]) * 100));
						progressFill.style.width = pct + '%';
					}
				}
			});

			this._appendSectionLog(logEl, `📋 配置: mode=${newConfig.mode}, subPath=${newConfig.subPath || '(全部)'}, exclude=${newConfig.excludeDirs.length}项, keep=${newConfig.keepDirs?.length || 0}项`);
			this._appendSectionLog(logEl, `▶ 调用 indexWorkspace...`);

			try {
				const result = await this._graphService.indexWorkspace(wsPath, newConfig);
				progressDisposable.dispose();
				this._appendSectionLog(logEl, `📊 进度事件收到 ${progressReceived} 条`);
				if (result.success) {
					this.notificationService.info(`索引完成 (${result.duration}s)`);
					this._appendSectionLog(logEl, `✓ ${result.message} (${result.duration}s)`, 'success');
					progressFill.style.width = '100%';
					// 刷新整个面板
					setTimeout(() => this._renderAll(), 500);
				} else {
					this.notificationService.warn(result.message);
					this._appendSectionLog(logEl, `✗ ${result.message}`, 'error');
				}
			} catch (err: any) {
				progressDisposable.dispose();
				this._appendSectionLog(logEl, `✗ 索引异常: ${err?.message || err}`, 'error');
			}

			indexBtn.disabled = false;
			indexBtn.textContent = '🔍 Index Codebase';
			indexBtn.title = 'Scan and index current codebase';
		};

		// Save config button
		const saveBtn = append(btnGroup, $('.cbm-btn')) as HTMLButtonElement;
		saveBtn.textContent = '💾 Save Config';
		saveBtn.onclick = () => {
			const mode = modeBtns.find(b => b.classList.contains('active'))?.dataset.mode || 'fast';
			const newConfig: IIndexConfig = {
				mode: mode as IIndexConfig['mode'],
				excludeDirs: exclInput.value.split(',').map(s => s.trim()).filter(s => s),
				keepDirs: keepInput.value.split(',').map(s => s.trim()).filter(s => s),
				subPath: pathInput.value.trim() || undefined,
			};
			this.cbmService.setIndexConfig(newConfig);
			badge.textContent = mode.toUpperCase();
			this.notificationService.info(`索引配置已保存 (${mode})`);
		};
	}

	// ─── Graph Details Section ────────────────────────────────────────────

	private _renderGraphDetails(schema: { nodeLabels: { label: string; count: number }[]; edgeTypes: { type: string; count: number }[]; totalNodes: number; totalEdges: number }): void {
		if (!this._content || !this._graphStatus) { return; }

		const sizeText = this._graphStatus.size ? this._formatSize(this._graphStatus.size) : 'graph.json';
		const { body } = this._createCollapsibleSection('Graph Details', '📊', sizeText, 'green');

		// Node/edge type breakdown from schema (no array iteration needed)
		const nodeTypesStr = schema.nodeLabels
			.sort((a, b) => b.count - a.count)
			.map(({ label, count }) => `${label}(${count})`)
			.join(' · ');
		const edgeTypesStr = schema.edgeTypes
			.sort((a, b) => b.count - a.count)
			.map(({ type, count }) => `${type.toLowerCase()}(${count})`)
			.join(' · ');

		const grid = append(body, $('.cbm-info-grid'));
		this._appendInfoItem(grid, 'Storage', this._graphStatus.graphPath || 'N/A');
		this._appendInfoItem(grid, 'Last Modified', this._graphStatus.lastModified ? new Date(this._graphStatus.lastModified).toLocaleString() : 'N/A');
		this._appendInfoItem(grid, 'Node Types', nodeTypesStr);
		this._appendInfoItem(grid, 'Edge Types', edgeTypesStr);

		// Action buttons
		const btnGroup = append(body, $('.cbm-btn-group'));

		// View 3D Graph
		const viewBtn = append(btnGroup, $('.cbm-btn.purple')) as HTMLButtonElement;
		viewBtn.textContent = '🌐 View 3D Graph';
		viewBtn.title = 'Open 3D graph visualization';
		viewBtn.onclick = () => {
			const input = CodebaseGraphViewerEditorInput.getOrCreate();
			this.editorService.openEditor(input, { pinned: true });
		};

		// Refresh
		const refreshBtn = append(btnGroup, $('.cbm-btn')) as HTMLButtonElement;
		refreshBtn.textContent = '🔄 Refresh';
		refreshBtn.onclick = () => { this._renderAll(); };

		// Open directory
		const openBtn = append(btnGroup, $('.cbm-btn')) as HTMLButtonElement;
		openBtn.textContent = '📂 Open Directory';
		openBtn.title = 'Open graph directory in file explorer';
		openBtn.onclick = () => {
			if (this._graphStatus?.graphPath) {
				this._openFolder(this._graphStatus.graphPath);
			}
		};
	}

	private _appendInfoItem(parent: HTMLElement, key: string, val: string): void {
		const item = append(parent, $('.cbm-info-item'));
		append(item, $('.key')).textContent = key;
		append(item, $('.val')).textContent = val;
	}

	// ─── Architecture Analysis ────────────────────────────────────────────

	private _renderArchitecture(): void {
		if (!this._content) { return; }

		let report: any;
		try { report = this._graphService.getArchitecture(); } catch { return; }
		if (!report || report.totalNodes === 0) { return; }

		const { body, section } = this._createCollapsibleSection('Architecture', '🏗️', `${report.communities?.length || 0} communities`, 'green');
		section.classList.add('collapsed'); // 默认折叠

		// Languages
		if (report.languages && report.languages.length > 0) {
			const langRow = append(body, $('.cbm-lang-badges'));
			for (const lang of report.languages.slice(0, 8)) {
				const badge = append(langRow, $('.cbm-lang-badge'));
				badge.textContent = `${lang.language} · ${lang.files}`;
				const cls = lang.language.toLowerCase().includes('type') ? 'ts' :
					lang.language.toLowerCase().includes('java') ? 'js' :
						lang.language.toLowerCase().includes('python') ? 'py' :
							lang.language.toLowerCase().includes('go') ? 'go' : 'other';
				badge.classList.add(cls);
			}
		}

		// Hotspots
		if (report.hotspots && report.hotspots.length > 0) {
			const hotTitle = append(body, $('div'));
			hotTitle.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);margin-top:10px;margin-bottom:4px;';
			hotTitle.textContent = '🔥 Hotspots (top 5 by connections):';
			for (const h of report.hotspots.slice(0, 5)) {
				const row = append(body, $('.cbm-info-item'));
				append(row, $('.key')).textContent = h.node.name;
				append(row, $('.val')).textContent = `in:${h.node.inDegree} out:${h.node.outDegree}`;
			}
		}

		// Layers
		if (report.layers && report.layers.length > 0) {
			const layerCounts: { [key: string]: number } = {};
			for (const l of report.layers) {
				layerCounts[l.layer] = (layerCounts[l.layer] || 0) + 1;
			}
			const layerStr = Object.entries(layerCounts)
				.sort((a, b) => b[1] - a[1])
				.map(([k, v]) => `${k}(${v})`).join(' · ');
			const layerRow = append(body, $('.cbm-info-item'));
			append(layerRow, $('.key')).textContent = 'Layers';
			append(layerRow, $('.val')).textContent = layerStr;
		}

		// Cross-package boundaries
		if (report.crossBoundaries && report.crossBoundaries.length > 0) {
			const cbRow = append(body, $('.cbm-info-item'));
			append(cbRow, $('.key')).textContent = 'Cross-pkg';
			append(cbRow, $('.val')).textContent = `${report.crossBoundaries.length} edges`;
		}
	}

	/** 大图架构分析：显示占位符，异步延迟计算 */
	private _renderArchitectureDeferred(nodeCount: number, edgeCount: number): void {
		if (!this._content) { return; }
		const { body, section } = this._createCollapsibleSection('Architecture', '🏗️', 'Deferred', 'warn');
		section.classList.add('collapsed'); // 默认折叠

		const placeholder = append(body, $('div'));
		placeholder.style.cssText = 'color:var(--vscode-descriptionForeground);font-size:12px;padding:8px 0;';
		placeholder.textContent = `⏳ Architecture analysis deferred for large graphs (${nodeCount} nodes, ${edgeCount} edges). Click to compute.`;

		const computeBtn = append(body, $('.cbm-btn')) as HTMLButtonElement;
		computeBtn.textContent = '🔍 Compute Now';
		computeBtn.style.fontSize = '12px';
		computeBtn.onclick = () => {
			computeBtn.disabled = true;
			computeBtn.textContent = '⏳ Computing...';
			// Defer to next tick so button updates
			setTimeout(() => {
				try {
					section.remove();
					this._renderArchitecture();
				} catch {
					computeBtn.textContent = '❌ Failed';
				}
			}, 0);
		};
	}

	// ─── Query Console ─────────────────────────────────────────────────────

	private _renderQueryConsole(): void {
		if (!this._content) { return; }

		const { body, section } = this._createCollapsibleSection('Query Console', '🔍');
		section.classList.add('collapsed'); // 默认折叠

		// Query input
		const inputRow = append(body, $('.cbm-config-row'));
		const input = append(inputRow, $('input.cbm-input')) as HTMLInputElement;
		input.placeholder = 'MATCH (n:Function) RETURN n.name, n.file_path LIMIT 10';
		input.style.fontFamily = 'monospace';
		input.style.fontSize = '11px';

		// Execute button
		const btnGroup = append(body, $('.cbm-btn-group'));
		btnGroup.style.marginTop = '8px';
		const execBtn = append(btnGroup, $('.cbm-btn.primary')) as HTMLButtonElement;
		execBtn.textContent = '▶ Execute';
		execBtn.style.fontSize = '12px';

		// Semantic search button
		const semBtn = append(btnGroup, $('.cbm-btn')) as HTMLButtonElement;
		semBtn.textContent = '🧠 Semantic';
		semBtn.style.fontSize = '12px';

		// Results area
		const resultsDiv = append(body, $('div')) as HTMLElement;
		resultsDiv.style.cssText = 'margin-top:10px;max-height:300px;overflow-y:auto;background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border);border-radius:6px;padding:8px 12px;font-family:monospace;font-size:11px;';

		const runQuery = () => {
			const query = input.value.trim();
			if (!query) { return; }
			clearNode(resultsDiv);
			resultsDiv.textContent = '⏳ Executing...';
			resultsDiv.style.color = 'var(--vscode-descriptionForeground)';
			execBtn.disabled = true;
			setTimeout(() => {
				try {
					const result = this._graphService.executeCypher(query);
					clearNode(resultsDiv);
					if (result.rows.length === 0) {
						resultsDiv.textContent = 'No results';
						resultsDiv.style.color = 'var(--vscode-descriptionForeground)';
						return;
					}
					// Render table
					const table = append(resultsDiv, $('table')) as HTMLTableElement;
					table.style.cssText = 'width:100%;border-collapse:collapse;';
					const thead = append(table, $('thead'));
					const headerRow = append(thead, $('tr'));
					for (const col of result.columns) {
						const th = append(headerRow, $('th')) as HTMLElement;
						th.textContent = col;
						th.style.cssText = 'text-align:left;padding:4px 8px;border-bottom:1px solid var(--vscode-widget-border);font-weight:600;';
					}
					const tbody = append(table, $('tbody'));
					for (const row of result.rows.slice(0, 50)) {
						const tr = append(tbody, $('tr'));
						for (const cell of row) {
							const td = append(tr, $('td'));
							td.textContent = typeof cell === 'object' ? cell?.name || JSON.stringify(cell).substring(0, 80) : String(cell);
							td.style.cssText = 'padding:3px 8px;border-bottom:1px solid var(--vscode-widget-border);';
						}
					}
				} catch (err: any) {
					resultsDiv.textContent = `Error: ${err.message}`;
					resultsDiv.style.color = 'var(--vscode-errorForeground)';
				} finally {
					execBtn.disabled = false;
				}
			}, 0);
		};

		execBtn.onclick = runQuery;
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { runQuery(); }
		});

		semBtn.onclick = () => {
			const query = input.value.trim();
			if (!query) { return; }
			clearNode(resultsDiv);
			resultsDiv.textContent = '⏳ Searching...';
			resultsDiv.style.color = 'var(--vscode-descriptionForeground)';
			semBtn.disabled = true;
			setTimeout(() => {
				try {
					const results = this._graphService.semanticSearch(query, 20);
					clearNode(resultsDiv);
					if (results.length === 0) {
						resultsDiv.textContent = 'No results';
						return;
					}
					for (const r of results) {
						const row = append(resultsDiv, $('div'));
						row.style.cssText = 'padding:4px 0;border-bottom:1px solid var(--vscode-widget-border);';
						const nameSpan = append(row, $('span'));
						nameSpan.textContent = r.node.name;
						nameSpan.style.cssText = 'color:#80a0ff;font-weight:600;';
						const scoreSpan = append(row, $('span'));
						scoreSpan.textContent = ` (score: ${r.score.toFixed(3)})`;
						scoreSpan.style.cssText = 'color:var(--vscode-descriptionForeground);';
						const fileSpan = append(row, $('div'));
						fileSpan.textContent = r.node.filePath || '';
						fileSpan.style.cssText = 'color:var(--vscode-descriptionForeground);font-size:10px;';
					}
				} catch (err: any) {
					resultsDiv.textContent = `Error: ${err.message}`;
					resultsDiv.style.color = 'var(--vscode-errorForeground)';
				} finally {
					semBtn.disabled = false;
				}
			}, 0);
		};
	}

	// ─── Analysis Tools (P3 API) ──────────────────────────────────────────

	private _renderAnalysisTools(): void {
		if (!this._content) { return; }

		const { body, section } = this._createCollapsibleSection('Analysis Tools', '🔬');
		section.classList.add('collapsed'); // 默认折叠

		// Trace Path
		const traceRow = append(body, $('.cbm-config-row'));
		const traceSource = append(traceRow, $('input.cbm-input')) as HTMLInputElement;
		traceSource.placeholder = 'Source function name...';
		traceSource.style.fontSize = '11px';
		const traceTarget = append(traceRow, $('input.cbm-input')) as HTMLInputElement;
		traceTarget.placeholder = 'Target function (optional)...';
		traceTarget.style.fontSize = '11px';
		const traceBtn = append(body, $('.cbm-btn.primary')) as HTMLButtonElement;
		traceBtn.textContent = '🔍 Trace Path';
		traceBtn.style.fontSize = '12px';
		traceBtn.style.marginTop = '6px';

		const traceResult = append(body, $('div'));
		traceResult.style.cssText = 'margin-top:8px;max-height:200px;overflow-y:auto;background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border);border-radius:6px;padding:8px;font-family:monospace;font-size:11px;';

		traceBtn.onclick = () => {
			const src = traceSource.value.trim();
			if (!src) { return; }
			clearNode(traceResult);
			traceResult.textContent = '⏳ Tracing...';
			traceResult.style.color = 'var(--vscode-descriptionForeground)';
			traceBtn.disabled = true;
			setTimeout(() => {
				try {
					const result = this._graphService.tracePathAdvanced(src, traceTarget.value.trim() || undefined, { mode: 'calls', maxDepth: 10 });
					clearNode(traceResult);
					if (!result || (result.path && result.path.length === 0)) {
						traceResult.textContent = 'No path found';
						traceResult.style.color = 'var(--vscode-descriptionForeground)';
						return;
					}
					if (result.path) {
						for (const node of result.path) {
							const row = append(traceResult, $('div'));
							row.style.cssText = 'padding:2px 0;';
							row.textContent = `→ ${node.name || node.qualifiedName || node.id}`;
						}
						if (result.risk) {
							const risk = append(traceResult, $('div'));
							risk.style.cssText = 'margin-top:6px;color:var(--vscode-errorForeground);font-weight:600;';
							risk.textContent = `⚠ Risk: ${result.risk}`;
						}
					}
				} catch (err: any) {
					traceResult.textContent = `Error: ${err.message}`;
					traceResult.style.color = 'var(--vscode-errorForeground)';
				} finally {
					traceBtn.disabled = false;
				}
			}, 0);
		};

		// Dead Code Detection
		const deadCodeBtn = append(body, $('.cbm-btn')) as HTMLButtonElement;
		deadCodeBtn.textContent = '💀 Detect Dead Code';
		deadCodeBtn.style.fontSize = '12px';
		deadCodeBtn.style.marginTop = '8px';

		const deadCodeResult = append(body, $('div'));
		deadCodeResult.style.cssText = 'margin-top:8px;max-height:200px;overflow-y:auto;background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border);border-radius:6px;padding:8px;font-size:11px;';

		deadCodeBtn.onclick = () => {
			clearNode(deadCodeResult);
			const nodeCount = this._graphService.getTotalNodeCount();
			if (nodeCount > 50000) {
				deadCodeResult.textContent = `⚠️ Graph too large (${nodeCount} nodes). Dead code detection requires <50k nodes.`;
				deadCodeResult.style.color = 'var(--vscode-descriptionForeground)';
				return;
			}
			deadCodeResult.textContent = '⏳ Analyzing...';
			deadCodeResult.style.color = 'var(--vscode-descriptionForeground)';
			deadCodeBtn.disabled = true;
			// Defer to next tick so UI updates before heavy computation
			setTimeout(async () => {
				try {
					const report = await this._graphService.getArchitectureAdvanced(['deadCode']);
					clearNode(deadCodeResult);
					if (report.deadCode) {
						const dc = report.deadCode;
						const summary = append(deadCodeResult, $('div'));
						summary.style.cssText = 'font-weight:600;margin-bottom:6px;';
						summary.textContent = `${dc.deadNodes} dead / ${dc.totalNodes} total (${dc.entryPoints} entry points)`;

						if (dc.deadFunctions.length > 0) {
							const title = append(deadCodeResult, $('div'));
							title.style.cssText = 'color:var(--vscode-descriptionForeground);margin-top:6px;';
							title.textContent = `Dead functions (${dc.deadFunctions.length}):`;
							for (const fn of dc.deadFunctions.slice(0, 20)) {
								const row = append(deadCodeResult, $('div'));
								row.style.cssText = 'padding:1px 0 1px 12px;color:var(--vscode-errorForeground);';
								row.textContent = `  ${fn.name} — ${fn.filePath}`;
							}
						}
					}
				} catch (err: any) {
					deadCodeResult.textContent = `Error: ${err.message}`;
					deadCodeResult.style.color = 'var(--vscode-errorForeground)';
				} finally {
					deadCodeBtn.disabled = false;
				}
			}, 0);
		};

		// Code Snippet Viewer
		const snippetRow = append(body, $('.cbm-config-row'));
		const snippetInput = append(snippetRow, $('input.cbm-input')) as HTMLInputElement;
		snippetInput.placeholder = 'Qualified name (e.g., src/main::getUserInfo)...';
		snippetInput.style.fontSize = '11px';
		const snippetBtn = append(body, $('.cbm-btn')) as HTMLButtonElement;
		snippetBtn.textContent = '📄 View Code';
		snippetBtn.style.fontSize = '12px';
		snippetBtn.style.marginTop = '6px';

		const snippetResult = append(body, $('div'));
		snippetResult.style.cssText = 'margin-top:8px;max-height:300px;overflow-y:auto;background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border);border-radius:6px;padding:8px;font-family:monospace;font-size:11px;white-space:pre-wrap;';

		snippetBtn.onclick = async () => {
			const qn = snippetInput.value.trim();
			if (!qn) { return; }
			clearNode(snippetResult);
			snippetResult.textContent = 'Loading...';
			snippetResult.style.color = 'var(--vscode-descriptionForeground)';
			try {
				const snippet = await this._graphService.getCodeSnippet(qn, 5);
				clearNode(snippetResult);
				if (!snippet) {
					snippetResult.textContent = 'Node not found';
					snippetResult.style.color = 'var(--vscode-descriptionForeground)';
					return;
				}
				snippetResult.style.color = 'var(--vscode-editor-foreground)';
				// Header
				const header = append(snippetResult, $('div'));
				header.style.cssText = 'color:#80a0ff;font-weight:600;margin-bottom:6px;border-bottom:1px solid var(--vscode-widget-border);padding-bottom:4px;';
				header.textContent = `${snippet.filePath}:${snippet.startLine}-${snippet.endLine} (${snippet.language})`;
				// Code content with line numbers
				const code = append(snippetResult, $('div'));
				code.textContent = snippet.content;
				code.style.cssText = 'white-space:pre;';
			} catch (err: any) {
				clearNode(snippetResult);
				snippetResult.textContent = `Error: ${err.message}`;
				snippetResult.style.color = 'var(--vscode-errorForeground)';
			}
		};

		// Change Detection
		const changesBtn = append(body, $('.cbm-btn')) as HTMLButtonElement;
		changesBtn.textContent = '📊 Detect Changes';
		changesBtn.style.fontSize = '12px';
		changesBtn.style.marginTop = '8px';

		const changesResult = append(body, $('div'));
		changesResult.style.cssText = 'margin-top:8px;font-size:11px;color:var(--vscode-descriptionForeground);';

		changesBtn.onclick = async () => {
			clearNode(changesResult);
			changesResult.textContent = 'Analyzing...';
			try {
				const result = await this._graphService.detectChanges({ impactAnalysis: true });
				clearNode(changesResult);
				changesResult.textContent = `Changed: ${result.changedCount} files | Affected: ${result.affectedNodes} nodes | Downstream: ${result.downstreamImpact} | Risk: ${result.riskLevel}`;
				changesResult.style.color = result.riskLevel === 'Critical' || result.riskLevel === 'High'
					? 'var(--vscode-errorForeground)'
					: 'var(--vscode-descriptionForeground)';
			} catch (err: any) {
				changesResult.textContent = `Error: ${err.message}`;
				changesResult.style.color = 'var(--vscode-errorForeground)';
			}
		};
	}

	// ─── Project Manager (Multi-Project) ──────────────────────────────────

	private _renderProjectManager(): void {
		if (!this._content) { return; }

		const { body, section } = this._createCollapsibleSection('Projects', '📁');
		section.classList.add('collapsed'); // 默认折叠

		try {
			const projects = this._graphService.listProjects();
			if (projects.length === 0) {
				const empty = append(body, $('div'));
				empty.style.cssText = 'color:var(--vscode-descriptionForeground);font-size:12px;';
				empty.textContent = 'No indexed projects.';
				return;
			}

			for (const proj of projects) {
				const row = append(body, $('.cbm-info-item'));
				append(row, $('.key')).textContent = proj.name;
				append(row, $('.val')).textContent = `${proj.nodeCount} nodes · ${proj.edgeCount} edges · ${proj.fileCount} files`;

				if (projects.length > 1) {
					const delBtn = append(row, $('.cbm-btn')) as HTMLButtonElement;
					delBtn.textContent = '✗';
					delBtn.style.cssText = 'font-size:10px;padding:1px 6px;margin-left:8px;';
					delBtn.onclick = () => {
						try {
							this._graphService.deleteProject(proj.name);
							this._renderAll().catch(() => { });
						} catch { /* ignore */ }
					};
				}
			}
		} catch { /* ignore */ }
	}

	// ─── Progress Section ─────────────────────────────────────────────────

	private _renderProgress(): void {
		if (!this._content) { return; }
		const section = append(this._content, $('.cbm-section'));
		const header = append(section, $('.cbm-section-header'));
		append(header, $('h2')).textContent = '⏳ Indexing...';
		append(header, $('.badge.warn')).textContent = 'In Progress';

		const body = append(section, $('.cbm-section-body'));
		const progress = append(body, $('.cbm-progress'));
		const bar = append(progress, $('.cbm-progress-bar')) as HTMLElement;
		bar.style.width = '0%';

		// Animate progress bar (indeterminate since we don't have exact progress)
		let pct = 0;
		const interval = setInterval(() => {
			pct = Math.min(95, pct + Math.random() * 15);
			bar.style.width = `${pct}%`;
			if (!this._graphService.isIndexing) {
				clearInterval(interval);
				bar.style.width = '100%';
			}
		}, 1000);
	}

	// ─── Log Section ──────────────────────────────────────────────────────

	private _renderLogSection(): void {
		if (!this._content) { return; }
		const section = append(this._content, $('.cbm-section'));
		const header = append(section, $('.cbm-section-header'));
		append(header, $('h2')).textContent = '📋 Activity Log';

		const copyBtn = append(header, $('.cbm-btn')) as HTMLButtonElement;
		copyBtn.textContent = '📋 Copy All';
		copyBtn.style.padding = '3px 10px';
		copyBtn.style.fontSize = '11px';
		copyBtn.onclick = async () => {
			const text = this._logLines.join('\n');
			try {
				await navigator.clipboard.writeText(text);
				copyBtn.textContent = '✓ Copied';
			} catch {
				const ta = document.createElement('textarea');
				ta.value = text;
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.appendChild(ta);
				ta.select();
				document.execCommand('copy');
				document.body.removeChild(ta);
				copyBtn.textContent = '✓ Copied';
			}
			setTimeout(() => { copyBtn.textContent = '📋 Copy All'; }, 1500);
		};

		const body = append(section, $('.cbm-section-body'));
		this._logContent = append(body, $('.cbm-log'));
	}

	private _renderLog(): void {
		if (!this._logContent) { return; }
		clearNode(this._logContent);
		if (this._logLines.length === 0) {
			this._logContent.textContent = '暂无日志';
			this._logContent.classList.add('cbm-log-empty');
			return;
		}
		this._logContent.classList.remove('cbm-log-empty');
		for (const line of this._logLines) {
			this._appendLogLineEl(line);
		}
		this._logContent.scrollTop = this._logContent.scrollHeight;
	}

	private _appendLogLine(line: string): void {
		this._logLines.push(line);
		if (!this._logContent) { return; }
		if (this._logContent.children.length === 0 || this._logContent.textContent === '暂无日志') {
			clearNode(this._logContent);
			this._logContent.classList.remove('cbm-log-empty');
		}
		this._appendLogLineEl(line);
		this._logContent.scrollTop = this._logContent.scrollHeight;
	}

	private _appendLogLineEl(line: string): void {
		const el = append(this._logContent!, $('.cbm-log-line'));
		const now = new Date();
		const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
		const tsSpan = append(el, $('span'));
		tsSpan.style.color = 'var(--vscode-descriptionForeground)';
		tsSpan.style.marginRight = '8px';
		tsSpan.textContent = ts;
		const textSpan = append(el, $('span'));
		textSpan.textContent = line;
		if (line.startsWith('✓')) { el.classList.add('success'); }
		else if (line.startsWith('✗')) { el.classList.add('error'); }
		else if (line.startsWith('⚠') || line.startsWith('▶')) { el.classList.add('warn'); }
		else if (line.startsWith('📊') || line.startsWith('⏳') || line.startsWith('🔗')) { el.classList.add('info'); }
	}

	// ─── Helpers ──────────────────────────────────────────────────────────

	private _openFolder(filePath: string): void {
		const uri = URI.file(filePath);
		this.commandService.executeCommand('revealFileInOS', uri);
	}

	private _formatSize(bytes: number): string {
		if (bytes > 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(2)} MB`; }
		if (bytes > 1024) { return `${(bytes / 1024).toFixed(2)} KB`; }
		return `${bytes} B`;
	}

	private _formatTime(date: Date): string {
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMin = Math.floor(diffMs / 60000);
		if (diffMin < 1) { return 'just now'; }
		if (diffMin < 60) { return `${diffMin}m ago`; }
		const diffHr = Math.floor(diffMin / 60);
		if (diffHr < 24) { return `${diffHr}h ago`; }
		return date.toLocaleDateString();
	}

	override layout(_dimension: { width: number; height: number }): void {
		// No special layout needed
	}
}
