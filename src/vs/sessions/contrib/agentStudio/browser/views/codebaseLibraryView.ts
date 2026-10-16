/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 代码库（独立工作台，2026-10-12 从「资料库」页的 code tab 提升而来）。
 *
 * 渲染逻辑**逐字搬自** `knowledgeBaseView.ts` 的 `_renderCodePanel` / `_refreshCodeStats` /
 * `_syncCodeLog` / `_appendCodeLog` / `_updateCodeStatusLine` / `_openCodebaseDetailEditor`
 * （只收掉「tab 面板 + 中间容器」那层，见 `renderBody`）。
 *
 * 与容器 `vssaros.dsh.codebase` 对应（该容器在 dsh 引擎下是插件自托管页 `/x/codebase/` ——
 * 本 Pane 是 **legacy 引擎**那一侧的宿主；两者互斥，不会同时注册）。
 *
 * ⚠ 本轮只搬「只读统计 + 日志 + 打开面板」；索引的**生产**入口（触发索引 / 批量构建 / 导入代码
 * 工作区）仍留在知识库页的 kb 区 —— 收尾期再把它们归到这边。
 */

import './media/kbView.css';

import { $ } from '../../../../../base/browser/dom.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { CodebaseGraphViewerEditorInput } from '../codebaseGraphViewerEditorInput.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import { CodebaseMemoryDetailEditorInput } from '../codebaseMemoryDetailEditorInput.js';
import { ICodebaseGraphService } from '../codebaseGraphService.js';
import { headerBtn, statCell, statsHint } from './libraryStatHelpers.js';
import { formatSizeCompact } from './knowledgeBase/kbViewUtils.js';

/** 日志 textarea 的保留行数上限（超出丢弃最老的，避免长会话无限增长）。 */
const CODE_LOG_MAX_LINES = 500;

export class CodebaseLibraryViewPane extends ViewPane {

	/** 统计区容器（异步填充）。 */
	private _statsEl?: HTMLElement;
	/** 索引的实时进度文本（`onDidIndexProgress` 推送，索引中显示）。 */
	private _indexProgress = '';
	/** 状态行（「已就绪 / 正在索引…」）。 */
	private _statusEl?: HTMLElement;
	/** 日志缓冲（只读 textarea 的数据源，带时间戳）。 */
	private _logLines: string[] = [];
	/** 日志的只读 textarea。 */
	private _logEl?: HTMLTextAreaElement;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IEditorService private readonly _editorService: IEditorService,
		@ILogService private readonly _logService: ILogService,
		@ICodebaseGraphService private readonly _codebaseGraphService: ICodebaseGraphService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// 索引进度 / 完成 → 追加日志、刷新状态行与统计（搬自 kb 页构造函数的对应订阅）。
		this._register(this._codebaseGraphService.onDidIndexProgress(msg => {
			this._indexProgress = msg;
			this._appendLog(msg);
			this._updateStatusLine();
		}));
		this._register(this._codebaseGraphService.onDidIndexComplete(() => {
			this._indexProgress = '';
			this._appendLog('索引完成');
			this._updateStatusLine();
			void this._refreshStats();
		}));

		// 清除 activitybar「有新增」徽标：本视图就是「代码库」这一来源的工作台，打开它（变可见）即视为已读。
		// ⚠ 这一步原先在资料库页的 `_switchTab('code')` 里 —— tab 拆掉后**必须**搬过来：代码索引的
		//   `requestLibraryBadge({source:'codebase', kind:'building'→'new'})` 仍由知识库页的
		//   `_triggerCodebaseIndex`（关联文件夹时后台索引）发出，没有这里就没有任何地方发 `'idle'` ✗。
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) { this._agentStudioService.requestLibraryBadge({ source: 'codebase', kind: 'idle' }); }
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('kb-view');

		const header = $('div.kb-header');
		const title = $('span.kb-title');
		const text = $('span');
		text.textContent = '代码库';
		title.replaceChildren($('span.codicon.codicon-code'), text);
		header.appendChild(title);
		header.appendChild($('span.kb-spacer'));
		header.appendChild(headerBtn('codicon-refresh', '刷新代码库统计', (e) => { e.stopPropagation(); void this._refreshStats(); }));
		container.appendChild(header);

		const panel = $('div.kb-panel.kb-panel-code.active');
		const bar = $('div.kb-panel-bar');
		const barLabel = $('span.kb-panel-bar-label');
		barLabel.textContent = '代码库';
		bar.replaceChildren(barLabel);
		panel.appendChild(bar);

		const content = $('div.kb-panel-content');
		panel.appendChild(content);
		container.appendChild(panel);

		this._renderPanel(content);
	}

	// ─── 渲染（搬自 knowledgeBaseView 的 _renderCodePanel 等）──────────────────

	private _renderPanel(host: HTMLElement): void {
		host.replaceChildren();

		// 入口置顶：CodebaseMemoryDetailEditorPane（与「记忆库」保持同一信息顺序）
		const entry = $('div.kb-entry');
		entry.onclick = () => this._openDetailEditor();
		const icon = $('span.kb-entry-icon.codicon.codicon-code');
		const textBox = $('div.kb-entry-text');
		const title = $('div.kb-entry-title');
		title.textContent = '查看完整代码库';
		const meta = $('div.kb-entry-meta');
		meta.textContent = '打开 CodebaseDetailEditorPane';
		textBox.replaceChildren(title, meta);
		const arrow = $('span.kb-entry-arrow.codicon.codicon-arrow-right');
		entry.replaceChildren(icon, textBox, arrow);
		host.appendChild(entry);

		// 图谱查看器入口（原先由「代码图谱」工作台承担；合并成「代码库」后收进本页）
		const graphEntry = $('div.kb-entry');
		graphEntry.onclick = () => this._openGraphViewer();
		const graphIcon = $('span.kb-entry-icon.codicon.codicon-type-hierarchy');
		const graphText = $('div.kb-entry-text');
		const graphTitle = $('div.kb-entry-title');
		graphTitle.textContent = '打开代码图谱查看器';
		const graphMeta = $('div.kb-entry-meta');
		graphMeta.textContent = '节点 / 关系可视化';
		graphText.replaceChildren(graphTitle, graphMeta);
		const graphArrow = $('span.kb-entry-arrow.codicon.codicon-arrow-right');
		graphEntry.replaceChildren(graphIcon, graphText, graphArrow);
		host.appendChild(graphEntry);

		// 统计骨架（异步回填）
		const stats = $('div.kb-stats');
		this._statsEl = stats;
		stats.appendChild(statsHint('正在读取代码图谱…'));
		host.appendChild(stats);

		// 日志区：只读 textarea（可滚动看完整行，不被状态行的单行省略号截断）
		const logSection = $('div.kb-side-section');
		const logHead = $('div.kb-side-section-head');
		const logLabel = $('span');
		logLabel.textContent = '日志';
		const logClear = $('span.kb-log-clear.codicon.codicon-trash');
		logClear.title = '清空日志';
		logClear.onclick = () => { this._logLines = []; this._syncLog(); };
		logHead.replaceChildren(logLabel, $('span.kb-spacer'), logClear);
		logSection.appendChild(logHead);

		const ta = document.createElement('textarea');
		ta.className = 'kb-log';
		ta.readOnly = true;       // 不可编辑
		ta.spellcheck = false;
		ta.wrap = 'off';          // 不折行：横向滚动看完整内容
		ta.setAttribute('aria-label', '代码库日志');
		this._logEl = ta;
		logSection.appendChild(ta);
		host.appendChild(logSection);
		this._syncLog();

		void this._refreshStats();
	}

	/** 把日志缓冲同步到只读 textarea（保持在底部）。 */
	private _syncLog(): void {
		const ta = this._logEl;
		if (!ta) { return; }
		ta.value = this._logLines.join('\n');
		ta.scrollTop = ta.scrollHeight;
	}

	/** 追加一行日志（带时间戳；超过上限丢弃最老的）。 */
	private _appendLog(message: string): void {
		this._logLines.push(`[${new Date().toLocaleTimeString()}] ${message}`);
		if (this._logLines.length > CODE_LOG_MAX_LINES) {
			this._logLines.splice(0, this._logLines.length - CODE_LOG_MAX_LINES);
		}
		this._syncLog();
	}

	/** 读取代码图谱状态并回填统计区（体积 / 节点 / 关系边 / 最后索引 / 实时状态）。 */
	private async _refreshStats(): Promise<void> {
		const el = this._statsEl;
		if (!el) { return; }
		try {
			const status = await this._codebaseGraphService.getGraphStatus();
			if (this._statsEl !== el) { return; }
			if (!status.exists) {
				el.replaceChildren(statsHint('尚未建立代码图谱索引'));
				return;
			}

			const hero = $('div.kb-stat-hero');
			const heroNum = $('span.kb-stat-hero-num');
			heroNum.textContent = formatSizeCompact(status.size ?? 0);
			const heroLabel = $('span.kb-stat-hero-label');
			heroLabel.textContent = '图谱体积';
			hero.replaceChildren(heroNum, heroLabel);

			const grid = $('div.kb-stat-grid');
			grid.appendChild(statCell('节点', status.nodeCount ?? 0));
			grid.appendChild(statCell('关系边', status.edgeCount ?? 0));

			const meta = $('div.kb-stat-meta');
			const ts = status.lastModified ? new Date(status.lastModified) : undefined;
			meta.textContent = ts && !Number.isNaN(ts.getTime()) ? `最后索引：${ts.toLocaleString()}` : '最后索引：—';

			const statusLine = $('div.kb-code-status');
			this._statusEl = statusLine;

			el.replaceChildren(hero, grid, meta, statusLine);
			this._updateStatusLine();

			// 首次拿到状态时补一条基线日志（否则 textarea 一直是空的）
			if (this._logLines.length === 0) {
				this._appendLog(`图谱就绪：${status.nodeCount ?? 0} 节点 / ${status.edgeCount ?? 0} 关系边`);
			}
		} catch (err) {
			this._logService.warn('[CodebaseLibrary] code stats failed', err);
			if (this._statsEl === el) { el.replaceChildren(statsHint('读取代码图谱失败')); }
		}
	}

	/** 更新状态行（只放短状态词；详细进度进日志 textarea）。 */
	private _updateStatusLine(): void {
		const el = this._statusEl;
		if (!el) { return; }
		const busy = this._codebaseGraphService.isIndexing || !!this._indexProgress;
		el.classList.toggle('busy', busy);
		el.textContent = busy ? '正在索引…' : '已就绪';
	}

	// ─── 打开编辑器面板 ─────────────────────────────────────────────────────

	/** 打开「代码库详情」编辑器面板（搬自 `_openCodebaseDetailEditor`）。 */
	private _openDetailEditor(): void {
		try {
			const input = CodebaseMemoryDetailEditorInput.getOrCreate();
			void this._editorService.openEditor(input, { pinned: true });
		} catch (err) {
			this._logService.error(`[CodebaseLibrary] failed to open CodebaseDetailEditorPane: ${err}`);
		}
	}

	/** 打开代码图谱查看器（原先的独立工作台入口，现收进「代码库」页）。 */
	private _openGraphViewer(): void {
		try {
			const input = CodebaseGraphViewerEditorInput.getOrCreate();
			void this._editorService.openEditor(input, { pinned: true });
		} catch (err) {
			this._logService.error(`[CodebaseLibrary] failed to open CodebaseGraphViewerEditorPane: ${err}`);
		}
	}
}
