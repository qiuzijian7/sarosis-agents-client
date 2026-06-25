/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IAgentOSService } from '../common/agentOS.js';
import { MemoryDetailEditorInput } from './memoryDetailEditorInput.js';

interface IMemoryEntry {
	id: string;
	type: string;
	content: string;
	metadata?: Record<string, unknown>;
	timestamp?: number;
}

type LayerFilter = 'all' | 'short_term' | 'long_term' | 'scene' | 'persona';
type ScopeFilter = 'all' | 'workspace' | 'session' | 'agent';

export class MemoryDetailEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.memoryDetail';

	private _container: HTMLElement | null = null;
	private _agentId: string = 'default';
	private _allMemories: IMemoryEntry[] = [];
	private _layerFilter: LayerFilter = 'all';
	private _scopeFilter: ScopeFilter = 'all';
	private _searchQuery: string = '';
	private _targetContentPreview: string | null = null;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentOSService private readonly _agentOSService: IAgentOSService,
	) {
		super(MemoryDetailEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = append(parent, $('.memory-detail-container'));
		this._injectStyles();
		this._renderLoading();
	}

	private _loadMemoryPromise: Promise<void> | null = null;

	override async setInput(input: MemoryDetailEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._agentId = input.agentId;
		if (input.targetLayer) {
			this._layerFilter = input.targetLayer as LayerFilter;
		}
		await this._loadMemory();
	}

	private _injectStyles(): void {
		if (!this._container) { return; }
		const style = document.createElement('style');
		style.textContent = `
			.memory-detail-container { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
			/* Header */
			.md-header { padding: 16px 20px 8px; flex-shrink: 0; }
			.md-header h1 { font-size: 16px; font-weight: 600; margin-bottom: 8px; color: var(--vscode-foreground); }
			.md-stats { display: flex; gap: 10px; flex-wrap: wrap; }
			.md-stat { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 6px; padding: 6px 14px; }
			.md-stat .label { font-size: 10px; color: var(--vscode-descriptionForeground); }
			.md-stat .value { font-size: 16px; font-weight: 600; color: var(--vscode-foreground); }
			.md-stat.l0 .value { color: #569cd6; } .md-stat.l1 .value { color: #569cd6; }
			.md-stat.l2 .value { color: #b799ff; } .md-stat.l3 .value { color: #f48771; }
			/* Layer tabs */
			.md-layer-tabs { display: flex; border-bottom: 1px solid var(--vscode-widget-border); padding: 0 20px; flex-shrink: 0; }
			.md-layer-tab { padding: 8px 16px; cursor: pointer; font-size: 12px; color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; transition: all 0.15s; display: flex; align-items: center; gap: 4px; }
			.md-layer-tab:hover { color: var(--vscode-foreground); }
			.md-layer-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder, #3794ff); }
			.md-layer-tab .count { background: var(--vscode-badge-background, rgba(128,128,128,0.2)); font-size: 10px; padding: 1px 6px; border-radius: 8px; color: var(--vscode-badge-foreground, #888); }
			/* Filter bar */
			.md-filter-bar { display: flex; align-items: center; gap: 8px; padding: 8px 20px; border-bottom: 1px solid var(--vscode-widget-border); flex-shrink: 0; }
			.md-filter-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
			.md-filter-chip { padding: 3px 10px; border-radius: 12px; font-size: 11px; cursor: pointer; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); transition: all 0.15s; }
			.md-filter-chip:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
			.md-filter-chip.active { background: var(--vscode-focusBorder, #3794ff); color: white; border-color: var(--vscode-focusBorder, #3794ff); }
			.md-search { margin-left: auto; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 4px 10px; color: var(--vscode-input-foreground); font-size: 12px; width: 200px; outline: none; }
			/* Memory list */
			.md-list { flex: 1; overflow-y: auto; padding: 12px 20px; }
			.md-list::-webkit-scrollbar { width: 6px; } .md-list::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 3px; }
			/* Memory card */
			.md-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
			.md-card-header { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid rgba(128,128,128,0.06); cursor: pointer; }
			.md-card-header:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.06)); }
			.md-badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 10px; flex-shrink: 0; }
			.md-badge.l0 { background: rgba(86,156,214,0.1); color: #569cd6; }
			.md-badge.l1 { background: rgba(86,156,214,0.2); color: #569cd6; }
			.md-badge.l2 { background: rgba(183,153,255,0.15); color: #b799ff; }
			.md-badge.l3 { background: rgba(244,135,113,0.15); color: #f48771; }
			.md-card-title { font-size: 12px; color: var(--vscode-foreground); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.md-card-time { font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
			.md-expand { color: var(--vscode-descriptionForeground); font-size: 10px; flex-shrink: 0; transition: transform 0.2s; }
			.md-card.expanded .md-expand { transform: rotate(90deg); }
			.md-content-box { max-height: 0; overflow: hidden; transition: max-height 0.25s ease; }
			.md-card.expanded .md-content-box { max-height: 500px; }
			.md-content { padding: 12px 14px; max-height: 440px; overflow-y: auto; font-size: 13px; line-height: 1.6; color: var(--vscode-foreground); }
			.md-content::-webkit-scrollbar { width: 4px; } .md-content::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.2); border-radius: 2px; }
			/* markdown */
			.md-content h1 { font-size: 16px; font-weight: 600; margin: 8px 0 4px; }
			.md-content h2 { font-size: 14px; font-weight: 600; margin: 8px 0 4px; }
			.md-content h3 { font-size: 13px; font-weight: 600; margin: 6px 0 3px; }
			.md-content p { margin: 4px 0; }
			.md-content code { background: rgba(128,128,128,0.15); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
			.md-content pre { background: rgba(0,0,0,0.3); padding: 8px 12px; border-radius: 6px; margin: 6px 0; overflow-x: auto; }
			.md-content pre code { background: transparent; padding: 0; }
			.md-content ul, .md-content ol { margin: 4px 0 4px 20px; }
			.md-content li { margin: 2px 0; }
			.md-content strong { font-weight: 600; }
			.md-content em { color: var(--vscode-editorWarning-foreground, #dcdcaa); }
			.md-content blockquote { border-left: 3px solid var(--vscode-focusBorder, #3794ff); padding-left: 10px; margin: 6px 0; color: var(--vscode-descriptionForeground); }
			/* meta chips */
			.md-meta { padding: 6px 14px; border-top: 1px solid rgba(128,128,128,0.06); display: flex; flex-wrap: wrap; gap: 4px; }
			.md-meta-chip { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); color: var(--vscode-descriptionForeground); }
			.md-meta-chip.priority { background: rgba(255,165,0,0.12); color: #ffa500; }
			.md-meta-chip.scene { background: rgba(183,153,255,0.1); color: #b799ff; }
			.md-meta-chip.role { background: rgba(78,201,176,0.1); color: #4ec9b0; }
			.md-meta-chip.session { background: rgba(55,148,255,0.1); color: #3794ff; }
			/* target highlight */
			.md-card.target { border-color: var(--vscode-focusBorder, #3794ff); box-shadow: 0 0 0 2px rgba(55,148,255,0.2); }
			/* empty/loading */
			.md-empty { padding: 60px 20px; text-align: center; color: var(--vscode-descriptionForeground); }
			.md-loading { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
		`;
		this._container.appendChild(style);
	}

	private _renderLoading(): void {
		if (!this._container) { return; }
		this._clearExceptStyle();
		append(this._container, $('.md-loading')).textContent = '加载记忆数据...';
	}

	private _clearExceptStyle(): void {
		if (!this._container) { return; }
		const styleEl = this._container.querySelector('style');
		while (this._container.firstChild) { this._container.removeChild(this._container.firstChild); }
		if (styleEl) { this._container.appendChild(styleEl); }
	}

	private async _loadMemory(): Promise<void> {
		// 防止并发加载：如果已有 pending 请求，复用之
		if (this._loadMemoryPromise) {
			return this._loadMemoryPromise;
		}
		this._loadMemoryPromise = this._doLoadMemory().finally(() => {
			this._loadMemoryPromise = null;
		});
		return this._loadMemoryPromise;
	}

	private async _doLoadMemory(): Promise<void> {
		this._renderLoading();
		try {
			const memProvider = this._agentOSService.getActiveMemoryProvider();
			if (!memProvider) {
				if (this._allMemories.length > 0) {
					// 服务不可用但已有缓存数据，直接使用缓存
					this._renderFull();
				} else {
					this._renderEmpty('未找到记忆服务');
				}
				return;
			}
			const results = await memProvider.searchMemory(this._agentId, '');
			const newMemories = (results || []).map(e => ({
				id: e.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
				type: e.type || (e.metadata?.['memoryType'] as string) || 'short_term',
				content: e.content || '',
				metadata: e.metadata,
				timestamp: e.timestamp,
			}));
			// TDB-AM 不可用时 searchMemory 返回空数组（而非抛异常），不覆盖已有缓存
			if (newMemories.length === 0 && this._allMemories.length > 0) {
				console.warn('[MemoryDetailEditorPane] searchMemory returned empty, keeping cached data (TDB-AM may be unavailable)');
				this._renderFull();
			} else {
				this._allMemories = newMemories;
				this._renderFull();
			}
		} catch (err) {
			if (this._allMemories.length > 0) {
				// 网络错误等但已有缓存数据，保留缓存并重新渲染（支持 navigateToTarget 跳转）
				console.warn('[MemoryDetailEditorPane] _loadMemory failed, using cached data:', err);
				this._renderFull();
			} else {
				this._renderEmpty(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	private _renderEmpty(msg: string): void {
		if (!this._container) { return; }
		this._clearExceptStyle();
		const header = append(this._container, $('.md-header'));
		append(header, $('h1')).textContent = `🧠 记忆详情 (${this._agentId})`;
		append(this._container, $('.md-empty')).textContent = msg;
	}

	private _renderFull(): void {
		if (!this._container) { return; }
		this._clearExceptStyle();
		// Header
		const header = append(this._container, $('.md-header'));
		append(header, $('h1')).textContent = `🧠 记忆详情 (${this._agentId})`;
		const stats = append(header, $('.md-stats'));
		this._addStat(stats, '总数', this._allMemories.length, '');
		this._addStat(stats, 'L0', this._countByType('short_term'), 'l0');
		this._addStat(stats, 'L1', this._countByType('long_term'), 'l1');
		this._addStat(stats, 'L2', this._countByType('scene'), 'l2');
		this._addStat(stats, 'L3', this._countByType('persona'), 'l3');
		// Layer tabs
		const layerTabs = append(this._container, $('.md-layer-tabs'));
		this._addLayerTab(layerTabs, 'all', '全部');
		this._addLayerTab(layerTabs, 'short_term', 'L0 对话');
		this._addLayerTab(layerTabs, 'long_term', 'L1 结构化');
		this._addLayerTab(layerTabs, 'scene', 'L2 场景');
		this._addLayerTab(layerTabs, 'persona', 'L3 人格');
		// Filter bar
		const filterBar = append(this._container, $('.md-filter-bar'));
		append(filterBar, $('.md-filter-label')).textContent = '作用域:';
		this._addFilterChip(filterBar, '全部', 'all', true);
		this._addFilterChip(filterBar, '工作区', 'workspace');
		this._addFilterChip(filterBar, '当前会话', 'session');
		this._addFilterChip(filterBar, '当前 Agent', 'agent');
		const search = document.createElement('input');
		search.className = 'md-search'; search.type = 'text'; search.placeholder = '🔍 搜索记忆内容...';
		search.addEventListener('input', () => { this._searchQuery = search.value.toLowerCase().trim(); this._renderList(); });
		filterBar.appendChild(search);
		// List
		this._renderList();
	}

	private _addStat(parent: HTMLElement, label: string, value: number, cls: string): void {
		const card = append(parent, $(`.md-stat.${cls}`));
		append(card, $('.label')).textContent = label;
		append(card, $('.value')).textContent = String(value);
	}

	private _addLayerTab(parent: HTMLElement, layer: LayerFilter, label: string): void {
		const tab = append(parent, $('.md-layer-tab'));
		if (this._layerFilter === layer) { tab.classList.add('active'); }
		const count = this._countByType(layer);
		const text = document.createElement('span'); text.textContent = label; tab.appendChild(text);
		const countEl = document.createElement('span'); countEl.className = 'count'; countEl.textContent = String(count); tab.appendChild(countEl);
		tab.addEventListener('click', () => { this._layerFilter = layer; this._renderFull(); });
	}

	private _addFilterChip(parent: HTMLElement, label: string, scope: ScopeFilter, active = false): void {
		const chip = append(parent, $('.md-filter-chip'));
		chip.textContent = label;
		if (active || this._scopeFilter === scope) { chip.classList.add('active'); }
		chip.addEventListener('click', () => {
			this._scopeFilter = scope;
			this._renderFull();
		});
	}

	private _countByType(type: string): number {
		if (type === 'all') { return this._allMemories.length; }
		return this._allMemories.filter(m => m.type === type).length;
	}

	private _getFiltered(): IMemoryEntry[] {
		let items = this._allMemories;
		if (this._layerFilter !== 'all') { items = items.filter(m => m.type === this._layerFilter); }
		if (this._searchQuery) { items = items.filter(m => m.content.toLowerCase().includes(this._searchQuery)); }
		// Scope filter (simplified — would need session/workspace metadata)
		// For now, 'agent' = all, others filter by metadata
		if (this._scopeFilter === 'session') {
			items = items.filter(m => m.metadata?.['sessionId'] || m.metadata?.['sessionKey']);
		}
		items = items.slice().sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
		return items;
	}

	private _renderList(): void {
		const oldList = this._container?.querySelector('.md-list');
		if (oldList) { oldList.remove(); }
		if (!this._container) { return; }
		const list = append(this._container, $('.md-list'));
		const items = this._getFiltered();
		if (items.length === 0) {
			const emptyMsg = this._allMemories.length === 0
				? '暂无记忆数据（TDB-AM 服务可能未运行，请检查端口 8420）'
				: '暂无符合条件的记忆';
			append(list, $('.md-empty')).textContent = emptyMsg;
			return;
		}
		const typeLabels: Record<string, string> = {
			short_term: 'L0', long_term: 'L1', scene: 'L2', persona: 'L3',
		};
		const typeClasses: Record<string, string> = {
			short_term: 'l0', long_term: 'l1', scene: 'l2', persona: 'l3',
		};
		// 查找匹配 contentPreview 的条目（TDB-AM 返回的记忆 content 是完整 assistant 回复）
		let targetItem: IMemoryEntry | null = null;
		if (this._targetContentPreview) {
			const preview = this._targetContentPreview.trim();
			// 精确前缀匹配
			for (const item of items) {
				if (typeof item.content === 'string' && item.content.startsWith(preview)) {
					targetItem = item;
					break;
				}
			}
			// 回退：忽略空白字符的前缀匹配
			if (!targetItem) {
				const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
				const normPreview = normalize(preview);
				for (const item of items) {
					if (typeof item.content === 'string' && normalize(item.content).startsWith(normPreview)) {
						targetItem = item;
						break;
					}
				}
			}
			// 回退：包含匹配（前缀可能被截断）
			if (!targetItem && preview.length >= 20) {
				for (const item of items) {
					if (typeof item.content === 'string' && item.content.includes(preview.slice(0, 30))) {
						targetItem = item;
						break;
					}
				}
			}
		}

	let targetIndex = -1;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const card = document.createElement('div');
		card.className = 'md-card';
		// 使用 data-index 而非 id（TDB-AM 返回的 ID 含冒号，CSS 选择器不支持）
		card.setAttribute('data-mem-index', String(i));
		// Auto-expand target or first item
		const isTarget = targetItem && item.id === targetItem.id;
		if (isTarget) { targetIndex = i; }
		if (isTarget || (!targetItem && i === 0)) {
				card.classList.add('expanded');
			}
			if (isTarget) {
				card.classList.add('target');
			}
			// Header
			const header = document.createElement('div');
			header.className = 'md-card-header';
			const badge = document.createElement('span');
			badge.className = `md-badge ${typeClasses[item.type] || 'l0'}`;
			badge.textContent = typeLabels[item.type] ?? item.type;
			header.appendChild(badge);
			const title = document.createElement('span');
			title.className = 'md-card-title';
			title.textContent = item.content.slice(0, 80).replace(/\n/g, ' ');
			header.appendChild(title);
			if (item.timestamp) {
				const time = document.createElement('span');
				time.className = 'md-card-time';
				time.textContent = new Date(item.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
				header.appendChild(time);
			}
			const expand = document.createElement('span');
			expand.className = 'md-expand'; expand.textContent = '▶';
			header.appendChild(expand);
			header.addEventListener('click', () => card.classList.toggle('expanded'));
			card.appendChild(header);
			// Content box (scrollable + markdown)
			const contentBox = document.createElement('div');
			contentBox.className = 'md-content-box';
			const content = document.createElement('div');
			content.className = 'md-content';
			this._renderMarkdown(content, item.content);
			contentBox.appendChild(content);
			// Metadata chips
			if (item.metadata) {
				const meta = document.createElement('div');
				meta.className = 'md-meta';
				const entries = Object.entries(item.metadata)
					.filter(([k]) => !['owner', 'userId', 'agentId'].includes(k));
				for (const [k, v] of entries) {
					const chip = document.createElement('span');
					chip.className = this._getMetaChipClass(k);
					chip.textContent = `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
					meta.appendChild(chip);
				}
				if (meta.children.length > 0) { contentBox.appendChild(meta); }
			}
			card.appendChild(contentBox);
			list.appendChild(card);
		}
		// Scroll to target
		if (targetIndex >= 0) {
			setTimeout(() => {
				const targetEl = list.querySelector(`[data-mem-index="${targetIndex}"]`);
				if (targetEl) { (targetEl as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' }); }
				this._targetContentPreview = null;
			}, 100);
		}
	}

	private _getMetaChipClass(key: string): string {
		if (key === 'priority') { return 'md-meta-chip priority'; }
		if (key === 'sceneName' || key === 'scene_name') { return 'md-meta-chip scene'; }
		if (key === 'role') { return 'md-meta-chip role'; }
		if (key === 'sessionId' || key === 'sessionKey') { return 'md-meta-chip session'; }
		return 'md-meta-chip';
	}

	/** Simple markdown → DOM renderer (CSP-safe, no innerHTML) */
	private _renderMarkdown(container: HTMLElement, text: string): void {
		const lines = text.split('\n');
		let inCodeBlock = false;
		let codeLines: string[] = [];
		let listType: 'ul' | 'ol' | null = null;
		let listEl: HTMLElement | null = null;

		const flushList = () => { if (listEl && listType) { listType = null; listEl = null; } };

		for (const line of lines) {
			// Code block
			if (line.trim().startsWith('```')) {
				if (inCodeBlock) {
					const pre = document.createElement('pre');
					const code = document.createElement('code');
					code.textContent = codeLines.join('\n');
					pre.appendChild(code);
					container.appendChild(pre);
					inCodeBlock = false; codeLines = [];
				} else {
					flushList();
					inCodeBlock = true; codeLines = [];
				}
				continue;
			}
			if (inCodeBlock) { codeLines.push(line); continue; }

			// Headers
			if (/^###\s/.test(line)) { flushList(); container.appendChild(this._mkEl('h3', line.slice(4))); continue; }
			if (/^##\s/.test(line)) { flushList(); container.appendChild(this._mkEl('h2', line.slice(3))); continue; }
			if (/^#\s/.test(line)) { flushList(); container.appendChild(this._mkEl('h1', line.slice(2))); continue; }

			// Blockquote
			if (/^>\s/.test(line)) { flushList(); container.appendChild(this._mkEl('blockquote', line.slice(2))); continue; }

			// Lists
			if (/^\d+\.\s/.test(line)) {
				if (listType !== 'ol') { flushList(); listType = 'ol'; listEl = document.createElement('ol'); container.appendChild(listEl); }
				const li = this._mkEl('li', line.replace(/^\d+\.\s/, ''));
				listEl!.appendChild(li);
				continue;
			}
			if (/^[-*]\s/.test(line)) {
				if (listType !== 'ul') { flushList(); listType = 'ul'; listEl = document.createElement('ul'); container.appendChild(listEl); }
				const li = this._mkEl('li', line.replace(/^[-*]\s/, ''));
				listEl!.appendChild(li);
				continue;
			}

			// Empty line
			if (line.trim() === '') { flushList(); continue; }

			// Paragraph
			flushList();
			container.appendChild(this._mkEl('p', line));
		}

		// Flush remaining code block
		if (inCodeBlock && codeLines.length > 0) {
			const pre = document.createElement('pre');
			const code = document.createElement('code');
			code.textContent = codeLines.join('\n');
			pre.appendChild(code);
			container.appendChild(pre);
		}
	}

	/** Create element with inline markdown (bold/italic/code) rendered as child nodes */
	private _mkEl(tag: string, text: string): HTMLElement {
		const el = document.createElement(tag);
		// Parse inline: **bold**, *italic*, `code`
		const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
		let lastIdx = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			if (match.index > lastIdx) {
				el.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
			}
			if (match[2]) { // bold
				const strong = document.createElement('strong'); strong.textContent = match[2];
				el.appendChild(strong);
			} else if (match[3]) { // italic
				const em = document.createElement('em'); em.textContent = match[3];
				el.appendChild(em);
			} else if (match[4]) { // code
				const code = document.createElement('code'); code.textContent = match[4];
				el.appendChild(code);
			}
			lastIdx = match.index + match[0].length;
		}
		if (lastIdx < text.length) {
			el.appendChild(document.createTextNode(text.slice(lastIdx)));
		}
		return el;
	}

	/**
	 * 公共导航方法：应用层级过滤并滚动到匹配 contentPreview 的条目。
	 * 用于系统栏点击记忆条目时跳转（即使编辑器已打开也能调用）。
	 */
	async navigateToTarget(layer?: string, targetContentPreview?: string): Promise<void> {
		if (layer) {
			this._layerFilter = layer as LayerFilter;
		}
		this._targetContentPreview = targetContentPreview ?? null;
		// 如果有 pending 的 _loadMemory，等待它完成（避免竞态：setInput 还在加载时 navigateToTarget 提前判断空列表）
		if (this._loadMemoryPromise) {
			await this._loadMemoryPromise;
		}
		if (this._allMemories.length > 0) {
			this._renderFull();
		} else {
			// 无缓存也无 pending，触发加载（完成后 _renderFull 会自动调用）
			await this._loadMemory();
		}
	}

	override layout(dimension: { width: number; height: number }): void {
		// No special layout needed
	}
}
