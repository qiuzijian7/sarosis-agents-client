/*---------------------------------------------------------------------------------------------
 *  Memory Side View — 基于 agentmemory 9 类原生类型
 *
 *  数据源: AgentMemoryProvider（进程内，通过 IAgentDriverService.getActiveMemoryProvider()）
 *  不再依赖 TDB-AM HTTP gateway。
 *
 *  分类: 9 类原生类型
 *    Working   → 原始观察 (working)
 *    Episodic  → 会话摘要 (episodic)
 *    Semantic  → 事实模式 (scene)
 *    Procedural→ 工作流   (persona)
 *--------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IAgentDriverService, AgentTurnStatus } from '../../agentStudio/common/agentDriver.js';
import { IAgentStudioService } from '../../agentStudio/common/agentStudio.js';
import type { IMemoryProvider, IMemoryEntry } from '../../agentStudio/common/providers.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type CategoryId = 'working' | 'pattern' | 'fact' | 'preference' | 'architecture' | 'bug' | 'workflow' | 'semantic' | 'procedural';

interface CategorySpec {
	readonly id: CategoryId;
	readonly label: string;
	readonly color: string;
}

/** 9 类原生类型，与 memoryDetailEditorPane 的 LayerFilter 对齐 */
const CATEGORIES: readonly CategorySpec[] = [
	{ id: 'working', label: 'Working', color: '#569cd6' },
	{ id: 'pattern', label: 'Pattern', color: '#4ec9b0' },
	{ id: 'fact', label: 'Fact', color: '#d4a017' },
	{ id: 'preference', label: 'Preference', color: '#dcdcaa' },
	{ id: 'architecture', label: 'Architecture', color: '#b799ff' },
	{ id: 'bug', label: 'Bug', color: '#f48771' },
	{ id: 'workflow', label: 'Workflow', color: '#f0a04b' },
	{ id: 'semantic', label: 'Semantic', color: '#b799ff' },
	{ id: 'procedural', label: 'Procedural', color: '#ce9178' },
];

interface ActivityItem {
	icon: string;
	text: string;
	time: number;
}

function matchesCategory(mem: IMemoryEntry, cat: CategoryId): boolean {
	return mem.type === cat;
}

function formatTime(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 60_000) return '刚刚';
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
	return new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

const TYPE_LABELS: Record<string, string> = {
	working: 'Working', episodic: 'Episodic', semantic: 'Semantic', procedural: 'Procedural',
	pattern: 'pattern', preference: 'preference', architecture: 'architecture',
	bug: 'bug', workflow: 'workflow', fact: 'fact', instruction: 'instruction',
};

// ─── ViewPane ─────────────────────────────────────────────────────────────────

export class MemoryViewPane extends ViewPane {

	private _container: HTMLElement | undefined;
	private _statsEl: HTMLElement | undefined;
	private _activityEl: HTMLElement | undefined;
	private _layerBodies = new Map<string, HTMLElement>();
	private _expandedCategory: CategoryId | null = null;
	private _allMemories: IMemoryEntry[] = [];
	private _searchQuery = '';
	private _activeAgentId: string | undefined;
	private _activities: ActivityItem[] = [];
	private _memEventUnsub: (() => void) | null = null;
	private _autoRefreshTimer: number | undefined;

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
		@ILogService private readonly _logService: ILogService,
		@ICommandService private readonly _commandService: ICommandService,
		@IAgentDriverService private readonly _agentDriverService: IAgentDriverService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Track active agent
		this._register(this._agentStudioService.onDidSelectAgent(agentId => {
			if (agentId) { this._activeAgentId = agentId; this._loadMemory(); }
		}));

		// Auto-refresh on turn completion
		this._register(this._agentDriverService.onDidChangeTurnStatus(({ status }) => {
			if (status === AgentTurnStatus.Done) {
				this._scheduleAutoRefresh();
			}
		}));
	}

	// ─── Lifecycle ─────────────────────────────────────────────────────────────

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('memory-view');
		container.style.height = '100%';
		container.style.display = 'flex';
		container.style.flexDirection = 'column';

		this._container = append(container, $('.memory-view-root'));
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';

		this._injectStyles();
		this._renderHeader();
		this._renderActivity();
		this._renderLayers();

		// 异步获取上次选择的 agent ID，确保重新加载窗口后能显示正确的记忆数据
		if (!this._activeAgentId) {
			console.log('[MemoryView] renderBody: no _activeAgentId, resolving...');
			this._agentStudioService.getLastSelectedAgentId().then(async agentId => {
				console.log('[MemoryView] getLastSelectedAgentId() returned:', agentId);
				if (!agentId) {
					// 没有上次选择的记录，从 agent 列表中获取第一个
					try {
						const agents = await this._agentStudioService.getAgents();
						console.log('[MemoryView] getAgents() returned:', agents.length, 'agents, ids:', agents.map(a => a.id).join(', '));
						if (agents.length > 0) {
							agentId = agents[0].id;
						}
					} catch (err) {
						console.warn('[MemoryView] getAgents() failed:', err);
					}
				}
				if (agentId && !this._activeAgentId) {
					this._activeAgentId = agentId;
					console.log('[MemoryView] _activeAgentId set to:', agentId);
				} else {
					console.log('[MemoryView] _activeAgentId still:', this._activeAgentId ?? 'undefined');
				}
				this._loadMemory();
			}).catch((err) => {
				console.warn('[MemoryView] getLastSelectedAgentId() failed:', err);
				this._loadMemory();
			});
		} else {
			console.log('[MemoryView] renderBody: _activeAgentId already set:', this._activeAgentId);
			this._loadMemory();
		}
		this._subscribeProviderEvents();
	}

	override dispose(): void {
		if (this._memEventUnsub) { this._memEventUnsub(); this._memEventUnsub = null; }
		if (this._autoRefreshTimer) { clearTimeout(this._autoRefreshTimer); }
		super.dispose();
	}

	// ─── Styles ────────────────────────────────────────────────────────────────

	private _injectStyles(): void {
		if (!this._container) return;
		const style = document.createElement('style');
		style.textContent = `
			.memory-view-root { font-size: 12px; }
			/* Header */
			.mv-header { padding: 8px 10px 6px; flex-shrink: 0; border-bottom: 1px solid var(--vscode-widget-border, #2d2d2d); }
			.mv-header-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
			.mv-title { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 5px; }
			.mv-status { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--vscode-descriptionForeground, #8a8a8a); }
			.mv-status .dot { width: 6px; height: 6px; border-radius: 50%; background: #5dcaa5; box-shadow: 0 0 4px #5dcaa5; }
			.mv-status.off .dot { background: #f48771; box-shadow: none; }
			/* Category chips — 匹配 memoryDetailEditorPane 的芯片风格 */
			.mv-stats { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 6px; }
			.mv-cat-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px 2px 6px; border-radius: 10px; cursor: pointer; transition: all 0.15s; border: 1px solid transparent; font-size: 10px; user-select: none; }
			.mv-cat-chip:hover { background: #333; }
			.mv-cat-chip.active { border-bottom: 2px solid #569cd6; background: rgba(86,156,214,0.1); }
			.mv-cat-chip .cat-label { font-weight: 500; color: var(--vscode-foreground, #ccc); }
			.mv-cat-chip .cat-count { font-weight: 700; font-variant-numeric: tabular-nums; min-width: 12px; text-align: right; }
			.mv-cat-chip[data-cat="working"] { border-left: 2px solid #569cd6; } .mv-cat-chip[data-cat="working"] .cat-count { color: #569cd6; }
			.mv-cat-chip[data-cat="pattern"] { border-left: 2px solid #4ec9b0; } .mv-cat-chip[data-cat="pattern"] .cat-count { color: #4ec9b0; }
			.mv-cat-chip[data-cat="fact"] { border-left: 2px solid #d4a017; } .mv-cat-chip[data-cat="fact"] .cat-count { color: #d4a017; }
			.mv-cat-chip[data-cat="preference"] { border-left: 2px solid #dcdcaa; } .mv-cat-chip[data-cat="preference"] .cat-count { color: #dcdcaa; }
			.mv-cat-chip[data-cat="architecture"] { border-left: 2px solid #b799ff; } .mv-cat-chip[data-cat="architecture"] .cat-count { color: #b799ff; }
			.mv-cat-chip[data-cat="bug"] { border-left: 2px solid #f48771; } .mv-cat-chip[data-cat="bug"] .cat-count { color: #f48771; }
			.mv-cat-chip[data-cat="workflow"] { border-left: 2px solid #f0a04b; } .mv-cat-chip[data-cat="workflow"] .cat-count { color: #f0a04b; }
			.mv-cat-chip[data-cat="semantic"] { border-left: 2px solid #b799ff; } .mv-cat-chip[data-cat="semantic"] .cat-count { color: #b799ff; }
			.mv-cat-chip[data-cat="procedural"] { border-left: 2px solid #ce9178; } .mv-cat-chip[data-cat="procedural"] .cat-count { color: #ce9178; }
			/* Search + Actions */
			.mv-search { width: 100%; background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px; padding: 4px 8px; color: var(--vscode-input-foreground, #ccc); font-size: 11px; outline: none; margin-bottom: 4px; }
			.mv-search:focus { border-color: #569cd6; }
			.mv-search::placeholder { color: var(--vscode-input-placeholderForeground, #6a6a6a); }
			.mv-actions { display: flex; gap: 3px; margin-bottom: 4px; }
			.mv-btn { flex: 1; padding: 3px 4px; border-radius: 3px; font-size: 10px; cursor: pointer; border: 1px solid #3c3c3c; background: var(--vscode-editorWidget-background, #2d2d2d); color: var(--vscode-descriptionForeground, #8a8a8a); transition: all 0.15s; text-align: center; }
			.mv-btn:hover { color: var(--vscode-foreground, #ccc); border-color: #569cd6; background: #333; }
			.mv-btn.primary { background: #569cd6; color: #1a1a28; border-color: #569cd6; font-weight: 600; }
			/* Activity */
			.mv-activity { flex-shrink: 0; border-bottom: 1px solid #2d2d2d; padding: 4px 10px; max-height: 72px; overflow-y: auto; }
			.mv-activity-title { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #6a6a6a; margin-bottom: 3px; }
			.mv-activity-item { display: flex; align-items: center; gap: 4px; padding: 1px 0; font-size: 10px; color: #8a8a8a; }
			.mv-activity-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.mv-activity-time { font-size: 9px; color: #6a6a6a; flex-shrink: 0; }
			/* Layers / Memory list */
			.mv-layers { flex: 1; overflow-y: auto; padding: 2px 0; }
			.mv-layers::-webkit-scrollbar { width: 5px; }
			.mv-layers::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 3px; }
			/* Memory card */
			.mv-mem { padding: 4px 10px 4px 24px; border-bottom: 1px solid #2d2d2d; cursor: pointer; transition: background 0.15s; }
			.mv-mem:hover { background: #333; }
			.mv-mem-top { display: flex; align-items: center; gap: 3px; margin-bottom: 1px; }
			.mv-mem-type { font-size: 8px; padding: 1px 4px; border-radius: 5px; flex-shrink: 0; font-weight: 600; }
			.mv-mem-type.working { background: rgba(86,156,214,0.12); color: #569cd6; }
			.mv-mem-type.pattern, .mv-mem-type.fact, .mv-mem-type.instruction { background: rgba(78,201,176,0.12); color: #4ec9b0; }
			.mv-mem-type.preference { background: rgba(220,220,170,0.12); color: #dcdcaa; }
			.mv-mem-type.architecture { background: rgba(183,153,255,0.12); color: #b799ff; }
			.mv-mem-type.bug { background: rgba(244,135,113,0.12); color: #f48771; }
			.mv-mem-type.workflow { background: rgba(240,160,75,0.12); color: #f0a04b; }
			.mv-mem-type.semantic { background: rgba(183,153,255,0.12); color: #b799ff; }
			.mv-mem-type.procedural { background: rgba(206,145,120,0.12); color: #ce9178; }
			.mv-mem-time { font-size: 9px; color: #6a6a6a; margin-left: auto; flex-shrink: 0; }
			.mv-mem-content { font-size: 10px; color: #8a8a8a; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
			.mv-mem.writing { border-left: 2px solid #569cd6; padding-left: 22px; }
			.mv-mem.saved { border-left: 2px solid #5dcaa5; padding-left: 22px; }
			.mv-mem.failed { border-left: 2px solid #f48771; padding-left: 22px; }
			/* Empty / Loading */
			.mv-empty { padding: 16px 10px; text-align: center; color: #6a6a6a; font-size: 11px; }
			.mv-loading { padding: 20px; text-align: center; color: #6a6a6a; font-size: 11px; }
		`;
		this._container.appendChild(style);
	}

	// ─── Render: Header ─────────────────────────────────────────────────────────

	private _renderHeader(): void {
		if (!this._container) return;
		const header = append(this._container, $('.mv-header'));

		const top = append(header, $('.mv-header-top'));
		const title = append(top, $('.mv-title'));
		title.textContent = '🧠 Memory';
		const status = append(top, $('.mv-status'));
		append(status, $('span.dot'));
		append(status, $('span')).textContent = 'Active';

		// Category chips row — 匹配图2的芯片布局
		const stats = append(header, $('.mv-stats'));
		this._statsEl = stats;
		for (const cat of CATEGORIES) {
			const chip = append(stats, $('.mv-cat-chip'));
			chip.dataset.cat = cat.id;
			chip.title = `${cat.label} — click to filter`;
			append(chip, $('span.cat-label')).textContent = cat.label;
			append(chip, $('span.cat-count')).textContent = '0';
			chip.addEventListener('click', () => this._toggleCategory(cat.id));
		}

		// Search
		const search = document.createElement('input');
		search.className = 'mv-search';
		search.type = 'text';
		search.placeholder = '🔍 搜索记忆...';
		search.addEventListener('input', () => {
			this._searchQuery = search.value.toLowerCase().trim();
			this._renderLayerList();
		});
		header.appendChild(search);

		// Actions
		const actions = append(header, $('.mv-actions'));
		const refreshBtn = append(actions, $('.mv-btn.primary'));
		refreshBtn.textContent = '🔄 刷新';
		refreshBtn.addEventListener('click', () => this._loadMemory());
		const detailBtn = append(actions, $('.mv-btn'));
		detailBtn.textContent = '⬆ 详情';
		detailBtn.addEventListener('click', () => {
			this._commandService.executeCommand('agentStudio.openMemoryDetail', this._activeAgentId ?? 'default');
		});
	}

	// ─── Render: Activity ───────────────────────────────────────────────────────

	private _renderActivity(): void {
		if (!this._container) return;
		const activity = append(this._container, $('.mv-activity'));
		this._activityEl = activity;
		append(activity, $('.mv-activity-title')).textContent = '最近活动';
		this._updateActivity();
	}

	private _updateActivity(): void {
		if (!this._activityEl) return;
		let list = this._activityEl.querySelector('.mv-activity-list') as HTMLElement | null;
		if (!list) { list = append(this._activityEl, $('.mv-activity-list')); }
		clearNode(list);
		const items = this._activities.slice(0, 4);
		if (items.length === 0) {
			const empty = append(list, $('.mv-activity-item'));
			empty.textContent = '暂无活动';
			return;
		}
		for (const item of items) {
			const row = append(list, $('.mv-activity-item'));
			const iconEl = document.createElement('span'); iconEl.textContent = item.icon; row.appendChild(iconEl);
			const textEl = document.createElement('span'); textEl.className = 'mv-activity-text'; textEl.textContent = item.text; row.appendChild(textEl);
			const timeEl = document.createElement('span'); timeEl.className = 'mv-activity-time'; timeEl.textContent = formatTime(item.time); row.appendChild(timeEl);
		}
	}

	private _addActivity(icon: string, text: string): void {
		this._activities.unshift({ icon, text, time: Date.now() });
		if (this._activities.length > 20) this._activities.pop();
		this._updateActivity();
	}

	// ─── Render: Layers ─────────────────────────────────────────────────────────

	private _renderLayers(): void {
		if (!this._container) return;
		const layersEl = append(this._container, $('.mv-layers'));
		this._layerBodies.set('all', layersEl);
	}

	private _toggleCategory(cat: CategoryId): void {
		// Toggle: click same again → deselect (show all)
		if (this._expandedCategory === cat) {
			this._expandedCategory = null;
		} else {
			this._expandedCategory = cat;
		}
		// Update chip active states
		const chips = this._statsEl?.querySelectorAll('.mv-cat-chip');
		if (chips) {
			for (const chip of chips) {
				chip.classList.toggle('active', this._expandedCategory === (chip as HTMLElement).dataset.cat);
			}
		}
		this._renderLayerList();
	}

	private _renderLayerList(): void {
		const body = this._layerBodies.get('all');
		if (!body) return;
		clearNode(body);

		let items = this._allMemories;
		// Filter by selected category
		if (this._expandedCategory) {
			items = items.filter(m => matchesCategory(m, this._expandedCategory!));
		}
		// Filter by search
		if (this._searchQuery) {
			items = items.filter(m => m.content.toLowerCase().includes(this._searchQuery));
		}
		// Sort by timestamp desc
		items.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
		items = items.slice(0, 50);

		if (items.length === 0) {
			append(body, $('.mv-empty', undefined, this._expandedCategory ? '该分类暂无记忆' : '暂无记忆'));
			return;
		}

		for (const mem of items) {
			const card = append(body, $('.mv-mem.saved'));
			const top = append(card, $('.mv-mem-top'));
			const memType = (mem.metadata?.['memoryType'] as string) ?? mem.type;
			const typeLabel = TYPE_LABELS[memType] ?? memType ?? mem.type;
			const typeEl = append(top, $(`.mv-mem-type.${memType}`) ?? $('span.mv-mem-type'));
			typeEl.textContent = typeLabel;
			append(top, $('.mv-mem-time')).textContent = mem.timestamp ? formatTime(mem.timestamp) : '';
			const content = append(card, $('.mv-mem-content'));
			content.textContent = mem.content.slice(0, 200);
		}
	}

	// ─── Data Loading ───────────────────────────────────────────────────────────

	private get _memoryProvider(): IMemoryProvider | undefined {
		return this._agentDriverService.getActiveMemoryProvider();
	}

	private _loadMemory(): void {
		const provider = this._memoryProvider;
		if (!provider) {
			this._renderEmpty('未找到记忆服务');
			return;
		}
		const agentId = this._activeAgentId ?? 'default';

		// Show loading
		const body = this._layerBodies.get('all');
		if (body) { clearNode(body); append(body, $('.mv-loading', undefined, '加载中...')); }

		(async () => {
			try {
				const results = await provider.searchMemory(agentId, '');
				this._allMemories = (results || []).map(e => ({
					id: e.id,
					type: e.type,
					content: e.content,
					metadata: e.metadata,
					timestamp: e.timestamp,
				}));
				this._updateStats();
				this._renderLayerList();
			} catch (err) {
				this._logService.warn('[MemoryView] Failed to load memory:', err);
				this._renderEmpty(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
	}

	private _updateStats(): void {
		if (!this._statsEl) return;
		const chips = this._statsEl.querySelectorAll('.mv-cat-chip');
		for (let i = 0; i < CATEGORIES.length; i++) {
			const cat = CATEGORIES[i];
			const count = this._allMemories.filter(m => matchesCategory(m, cat.id)).length;
			const chip = chips[i] as HTMLElement | undefined;
			const countEl = chip?.querySelector('.cat-count');
			if (countEl) countEl.textContent = String(count);
		}
	}

	private _renderEmpty(msg: string): void {
		if (!this._container) return;
		const layersEl = this._container.querySelector('.mv-layers');
		if (layersEl) {
			clearNode(layersEl as HTMLElement);
			append(layersEl as HTMLElement, $('.mv-empty')).textContent = msg;
		}
	}

	// ─── Provider Events ─────────────────────────────────────────────────────────

	private _subscribeProviderEvents(): void {
		const provider = this._memoryProvider;
		if (!provider?.onMemoryWritten) return;

		this._memEventUnsub = provider.onMemoryWritten((agentId, data) => {
			const tierLabel = data.memoryType ? (TYPE_LABELS[data.memoryType] ?? data.memoryType) : 'Memory';
			this._addActivity('✅', `${tierLabel} 写入成功${data.contentLength ? ` (${data.contentLength} 字符)` : ''}`);
			// Debounced refresh
			this._scheduleAutoRefresh();
		});

		const unsubFailed = provider.onMemoryWriteFailed?.((agentId, data) => {
			this._addActivity('❌', `记忆写入失败: ${data.error}`);
		});
		if (unsubFailed) {
			const origUnsub = this._memEventUnsub;
			this._memEventUnsub = () => { origUnsub?.(); unsubFailed(); };
		}
	}

	private _scheduleAutoRefresh(): void {
		if (this._autoRefreshTimer) clearTimeout(this._autoRefreshTimer);
		this._autoRefreshTimer = setTimeout(() => {
			this._loadMemory();
		}, 800) as unknown as number;
	}
}
