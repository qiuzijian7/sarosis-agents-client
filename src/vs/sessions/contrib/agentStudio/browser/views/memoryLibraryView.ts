/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 记忆库（独立工作台，2026-10-12 从「资料库」页的 mem tab 提升而来）。
 *
 * 渲染逻辑**逐字搬自** `knowledgeBaseView.ts` 的 `_renderMemoryList` / `_loadMemoryStats` /
 * `_openMemoryDetailEditor`（只把「tab 面板 + 中间容器」那层收掉，见 `renderBody`）。
 * DOM 类名与样式沿用 `views/media/kbView.css`，所以视觉与拆分前完全一致。
 *
 * ⚠ 记忆数据本身由**记忆详情页（React 版）**独立维护，这里只做**计数与入口** ——
 * 一次性渲染 9k+ 条会直接卡死侧栏（原实现的注释原话）。
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
import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IAgentOSService } from '../../common/agentOS.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import { IModelSelectorService } from '../../common/modelSelector.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { headerBtn, statCell, statsHint } from './libraryStatHelpers.js';

/**
 * Episodic 层的 6 个原生类型（与 `memoryDetailEditorPane` 的 EPISODIC_TYPES、
 * 以及 `knowledgeBaseView.ts` 的同名常量**同源**）。数组顺序即统计格子的展示顺序。
 */
const NATIVE_MEMORY_TYPES: readonly string[] = ['pattern', 'fact', 'preference', 'architecture', 'bug', 'workflow'];

/** 固定槽位（与 `MemoryDetailEditorPane` 的 DEFAULT_SLOTS 同源）。 */
const SLOT_NAMES: readonly string[] = [
	'persona', 'user_preferences', 'tool_guidelines', 'project_context',
	'guidance', 'pending_items', 'session_patterns', 'self_notes',
];

export class MemoryLibraryViewPane extends ViewPane {

	private _list?: HTMLElement;
	/** 记忆统计区容器（异步填充：总数 / 分层计数 / 原生类型计数）。 */
	private _statsEl?: HTMLElement;
	/** 统计回填的防竞态令牌：每次刷新自增，回填前校验是否最新。 */
	private _statsToken = 0;

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
		@IAgentOSService private readonly _agentOSService: IAgentOSService,
		@IModelSelectorService private readonly _modelSelectorService: IModelSelectorService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		// 清除 activitybar「有新增」徽标：本视图就是「记忆」这一来源的工作台，打开它（变可见）即视为已读。
		// ⚠ 这一步原先在资料库页的 `_switchTab('mem')` 里 —— tab 拆掉后**必须**搬过来，
		//   否则 `memoryTools` 只发 `kind:'new'`、没有任何地方发 `'idle'`，徽标会一直挂着 ✗。
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) { this._agentStudioService.requestLibraryBadge({ source: 'memory', kind: 'idle' }); }
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('kb-view');

		// 标题栏（原先在「资料库」的 header 上；拆成独立工作台后各带一个）。
		const header = $('div.kb-header');
		const title = $('span.kb-title');
		title.replaceChildren($('span.codicon.codicon-database'), (() => {
			const text = $('span');
			text.textContent = '记忆库';
			return text;
		})());
		header.appendChild(title);
		header.appendChild($('span.kb-spacer'));
		header.appendChild(headerBtn('codicon-refresh', '刷新记忆库', (e) => { e.stopPropagation(); this._renderList(); }));
		container.appendChild(header);

		// 面板骨架：`kb-panel.active` 常驻（本工作台没有 tab，所以直接加 active）。
		const panel = $('div.kb-panel.kb-panel-mem.active');
		const bar = $('div.kb-panel-bar');
		const barLabel = $('span.kb-panel-bar-label');
		barLabel.textContent = '记忆库';
		bar.replaceChildren(barLabel);
		panel.appendChild(bar);

		const content = $('div.kb-panel-content');
		this._list = $('div.kb-mem-list');
		content.appendChild(this._list);
		panel.appendChild(content);
		container.appendChild(panel);

		this._renderList();
	}

	// ─── 渲染（搬自 knowledgeBaseView 的 _renderMemoryList）────────────────────

	private _renderList(): void {
		const list = this._list;
		if (!list) { return; }
		list.replaceChildren();

		// ── ① 入口置顶：打开记忆详情（React 版；2026-10-27 旧面板已下线）──
		const entry = $('div.kb-entry');
		entry.onclick = () => this._openDetailEditor();

		const entryIcon = $('span.kb-entry-icon.codicon.codicon-database');
		const entryText = $('div.kb-entry-text');
		const entryTitle = $('div.kb-entry-title');
		entryTitle.textContent = '查看完整记忆';
		const entryMeta = $('div.kb-entry-meta');
		entryMeta.textContent = '打开记忆详情（React 版）';
		entryText.replaceChildren(entryTitle, entryMeta);
		const entryArrow = $('span.kb-entry-arrow.codicon.codicon-arrow-right');
		entry.replaceChildren(entryIcon, entryText, entryArrow);
		list.appendChild(entry);

		// ── ② 统计区：先渲染骨架，再异步回填（只做计数，不渲染 9k+ 条目）──
		this._statsEl = $('div.kb-stats');
		this._statsEl.appendChild(statsHint('正在读取记忆统计…'));
		list.appendChild(this._statsEl);
		void this._loadStats();

		// ── ③ 固定槽位概览 ──
		const slotsSection = $('div.kb-side-section');
		const slotsHead = $('div.kb-side-section-head');
		const slotsLabel = $('span');
		slotsLabel.textContent = '固定槽位';
		const slotsCount = $('span.kb-count');
		slotsCount.textContent = String(SLOT_NAMES.length);
		slotsHead.replaceChildren(slotsLabel, slotsCount);
		slotsSection.appendChild(slotsHead);
		const slotsHint = $('div.kb-mem-slots');
		for (const slot of SLOT_NAMES) {
			const tag = $('span.kb-slot-chip');
			tag.textContent = slot.replace(/_/g, ' ');
			slotsHint.appendChild(tag);
		}
		slotsSection.appendChild(slotsHint);
		list.appendChild(slotsSection);
	}

	/**
	 * 异步加载记忆统计并回填（搬自 `_loadMemoryStats`）。
	 *
	 * 数据源与 `MemoryDetailEditorPane` 同源（`IAgentOSService.getActiveMemoryProvider()`），
	 * 但**只做计数、不渲染条目**。
	 */
	private async _loadStats(): Promise<void> {
		const token = ++this._statsToken;
		const el = this._statsEl;
		if (!el) { return; }

		const mp = this._agentOSService.getActiveMemoryProvider();
		if (!mp) {
			el.replaceChildren(statsHint('记忆服务未连接（AgentMemory 网关未运行？）'));
			return;
		}
		try {
			// `searchAllAgents` 覆盖全部 agent 的 episodic 层；无此能力时退回本 agent 的 `searchMemory`。
			// 两条路径返回形状不同（`Record<string,unknown>` vs `IMemoryEntry`）⇒ 统一归一化为
			// `{ type, agentId }`，统计只关心这两个字段。
			let rows: Array<{ type: string; agentId?: string }>;
			if (mp.searchAllAgents) {
				const raw = await mp.searchAllAgents('') ?? [];
				rows = raw.map(e => {
					const meta = e['metadata'] as Record<string, unknown> | undefined;
					const aid = meta?.['agentId'] ?? e['agentId'];
					return {
						type: String(e['type'] ?? meta?.['memoryType'] ?? 'working'),
						agentId: typeof aid === 'string' ? aid : undefined,
					};
				});
			} else if (mp.searchMemory) {
				const agentId = this._modelSelectorService.getSelectedAgentId() ?? 'default';
				const raw = await mp.searchMemory(agentId, '') ?? [];
				rows = raw.map(e => ({
					type: String(e.type ?? (e.metadata?.['memoryType'] as string) ?? 'working'),
					agentId: (e.metadata?.['agentId'] as string) ?? agentId,
				}));
			} else {
				el.replaceChildren(statsHint('记忆服务不支持统计查询'));
				return;
			}
			// 防竞态：并发刷新时只有最后一次可以落 DOM
			if (token !== this._statsToken || this._statsEl !== el) { return; }

			const byType = new Map<string, number>();
			const agents = new Set<string>();
			for (const e of rows) {
				byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
				if (e.agentId) { agents.add(e.agentId); }
			}
			const countOf = (t: string) => byType.get(t) ?? 0;
			const episodic = NATIVE_MEMORY_TYPES.reduce((sum, t) => sum + countOf(t), 0);

			// 头部：总数 + Agent 数
			const hero = $('div.kb-stat-hero');
			const heroNum = $('span.kb-stat-hero-num');
			heroNum.textContent = String(rows.length);
			const heroLabel = $('span.kb-stat-hero-label');
			heroLabel.textContent = agents.size > 0 ? `条记忆 · ${agents.size} 个 Agent` : '条记忆';
			hero.replaceChildren(heroNum, heroLabel);

			// 四层计数
			const layerGrid = $('div.kb-stat-grid');
			const layers: Array<[string, number]> = [
				['Working', countOf('working')],
				['Episodic', episodic],
				['Semantic', countOf('semantic')],
				['Procedural', countOf('procedural')],
			];
			for (const [label, count] of layers) { layerGrid.appendChild(statCell(label, count)); }

			// Episodic 原生类型细分
			const typeLabel = $('div.kb-stat-sub');
			typeLabel.textContent = 'Episodic 子类型';
			const typeGrid = $('div.kb-stat-grid');
			for (const t of NATIVE_MEMORY_TYPES) { typeGrid.appendChild(statCell(t, countOf(t))); }

			el.replaceChildren(hero, layerGrid, typeLabel, typeGrid);
		} catch (err) {
			this._logService.warn('[MemoryLibrary] memory stats failed', err);
			if (this._statsEl === el) { el.replaceChildren(statsHint('读取记忆统计失败')); }
		}
	}

	/** 打开「记忆详情」编辑器面板（搬自 `_openMemoryDetailEditor`）。 */
	private _openDetailEditor(): void {
		// ★ 2026-10-27（阶段①下线旧面板）：记忆详情统一走 **React 版**（编辑区标签页）
		try {
			void this._commandService.executeCommand('dshHarness.openMemoryDetailReact');
		} catch (err) {
			this._logService.error(`[MemoryLibrary] 打开记忆详情失败: ${err}`);
		}
	}
}
