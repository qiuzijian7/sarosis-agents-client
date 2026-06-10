/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { autorun } from '../../../../base/common/observable.js';
import { $, clearNode } from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { IAgentOSService } from '../common/agentOS.js';
import { BUNDLED_MCP_PRESETS } from '../common/bundled-tools/bundledMcpPresets.js';
import { IEventBridgeService } from '../common/eventBridge.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { McpServerEditorInput } from './mcpServerEditorInput.js';
import { McpDetailEditorInput } from './mcpDetailEditorInput.js';
import { resolveMcpDetailModel, buildInstallableConfig } from './mcpDetailEditorPane.js';
import { KNOT_MCP_MARKET, IKnotMcpMarketItem } from '../common/bundled-tools/knotMcpMarket.js';
import { IMcpService } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { startServerAndWaitForLiveTools } from '../../../../workbench/contrib/mcp/common/mcpTypesUtils.js';
import { timeout } from '../../../../base/common/async.js';
import { IWorkbenchMcpManagementService } from '../../../../workbench/services/mcp/common/mcpWorkbenchManagementService.js';
import { IInstallableMcpServer } from '../../../../platform/mcp/common/mcpManagement.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface McpServerEntry {
	id: string;
	name: string;
	status: 'connected' | 'disconnected' | 'error';
	toolCount: number;
	tools: McpToolEntry[];
}

interface McpToolEntry {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
}

// ─── EditorPane ──────────────────────────────────────────────────────────────

export class McpServerEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.mcpServer';

	private _container!: HTMLElement;
	private _refreshBtn!: HTMLButtonElement;

	// Data
	private servers: McpServerEntry[] = [];
	private _loading = false;
	private _filterQuery = '';
	/** Transport filter for the built-in presets section ('All' | 'stdio' | 'http'). */
	private _transportFilter = 'All';
	/** How many knot market items to render (paged with "load more"). */
	private _knotDisplayLimit = 60;
	/** Track preset servers manually added by the user (before real MCP backend connection) */
	private _manuallyAddedIds: Set<string> = new Set();
	/** Which preset/market item is currently being started */
	private _loadingPresetId: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@IEventBridgeService private readonly eventBridgeService: IEventBridgeService,
		@IMcpService private readonly mcpService: IMcpService,
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(McpServerEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = $('div.mcp-server-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		this._container.style.overflow = 'hidden';
		this._container.style.fontSize = '13px';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof McpServerEditorInput)) { return; }

		// Build UI on first open
		if (this._container.childElementCount === 0) {
			this._buildUI();
		}

		// Restore connected preset IDs from installed servers
		await this._syncManualIdsFromConfig();

		// Refresh data every time the pane opens
		await this._refreshServers();
	}

	override layout(dimension: Dimension): void {
		this._container.style.width = `${dimension.width}px`;
		this._container.style.height = `${dimension.height}px`;
	}

	override dispose(): void {
		super.dispose();
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  UI BUILD
	// ══════════════════════════════════════════════════════════════════════════

	private _buildUI(): void {
		clearNode(this._container);

		// ── Toolbar ──────────────────────────────────────────────────
		const toolbar = $('div.mcp-editor-toolbar');
		toolbar.style.display = 'flex';
		toolbar.style.alignItems = 'center';
		toolbar.style.justifyContent = 'space-between';
		toolbar.style.padding = '12px 16px';
		toolbar.style.borderBottom = '1px solid var(--vscode-panel-border)';
		toolbar.style.flexShrink = '0';

		const left = $('div.mcp-editor-toolbar-left');
		left.style.display = 'flex';
		left.style.alignItems = 'center';
		left.style.gap = '12px';

		const title = $('h2.mcp-editor-title');
		title.textContent = '🔌 MCP Servers';
		title.style.margin = '0';
		title.style.fontSize = '18px';
		title.style.fontWeight = '600';
		left.appendChild(title);

		this._refreshBtn = $('button.mcp-editor-refresh-btn') as HTMLButtonElement;
		this._refreshBtn.textContent = '🔄 Refresh';
		this._refreshBtn.title = 'Reload MCP servers from providers';
		this._refreshBtn.style.padding = '6px 12px';
		this._refreshBtn.style.fontSize = '12px';
		this._refreshBtn.style.background = 'var(--vscode-button-secondaryBackground)';
		this._refreshBtn.style.color = 'var(--vscode-button-secondaryForeground)';
		this._refreshBtn.style.border = 'none';
		this._refreshBtn.style.borderRadius = '4px';
		this._refreshBtn.style.cursor = 'pointer';
		this._refreshBtn.onclick = () => { void this._refreshServers(); };
		left.appendChild(this._refreshBtn);

		toolbar.appendChild(left);

		const right = $('div.mcp-editor-toolbar-right');
		right.style.display = 'flex';
		right.style.alignItems = 'center';
		right.style.gap = '8px';

		// Filter input
		const filterInput = $('input.mcp-editor-filter') as HTMLInputElement;
		filterInput.type = 'text';
		filterInput.placeholder = '🔍 Filter presets...';
		filterInput.style.padding = '6px 10px';
		filterInput.style.fontSize = '12px';
		filterInput.style.border = '1px solid var(--vscode-input-border)';
		filterInput.style.borderRadius = '4px';
		filterInput.style.background = 'var(--vscode-input-background)';
		filterInput.style.color = 'var(--vscode-input-foreground)';
		filterInput.style.width = '200px';
		filterInput.style.outline = 'none';
		filterInput.oninput = () => {
			this._filterQuery = filterInput.value.trim().toLowerCase();
			this._renderContent(this._container.querySelector('#mcp-editor-content') as HTMLElement);
		};
		right.appendChild(filterInput);

		const addBtn = $('button.mcp-editor-add-btn') as HTMLButtonElement;
		addBtn.textContent = '+ Add Server';
		addBtn.title = 'Add a new MCP server';
		addBtn.style.padding = '8px 16px';
		addBtn.style.fontSize = '13px';
		addBtn.style.fontWeight = '500';
		addBtn.style.background = 'var(--vscode-button-background)';
		addBtn.style.color = 'var(--vscode-button-foreground)';
		addBtn.style.border = 'none';
		addBtn.style.borderRadius = '4px';
		addBtn.style.cursor = 'pointer';
		addBtn.onclick = () => { this._showAddModal(); };
		right.appendChild(addBtn);

		toolbar.appendChild(right);

		this._container.appendChild(toolbar);

		// ── Content area ────────────────────────────────────────────
		const content = $('div.mcp-editor-content');
		content.id = 'mcp-editor-content';
		content.style.flex = '1';
		content.style.overflowY = 'auto';
		content.style.padding = '16px';
		this._container.appendChild(content);
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  DATA
	// ══════════════════════════════════════════════════════════════════════════

	private async _refreshServers(): Promise<void> {
		if (this._loading) { return; }
		this._loading = true;
		this._refreshBtn.textContent = '⏳ Loading...';
		this._refreshBtn.disabled = true;

		const content = this._container.querySelector('#mcp-editor-content') as HTMLElement;
		if (!content) { return; }

		try {
			const toolsWithState = await this.agentOSService.listAllToolsWithState('viewer');
			const mcpTools = toolsWithState.filter(t =>
				t.source?.includes?.('mcp') || t.category === 'mcp'
			);

			// Group by server
			const serverMap = new Map<string, McpServerEntry>();
			for (const tool of mcpTools) {
				// Parse server prefix from McpToolProvider naming convention: "serverPrefix__toolName"
				const parts = tool.name.split('__');
				const serverId = parts.length >= 2 ? parts[0] : ((tool as any).serverId ?? 'unknown');
				// Derive server label from the description
				const descMatch = tool.description?.match(/\[via MCP server "([^"]+)"/);
				const serverName = descMatch ? descMatch[1] : serverId;

				if (!serverMap.has(serverId)) {
					serverMap.set(serverId, {
						id: serverId,
						name: serverName,
						status: 'connected',
						toolCount: 0,
						tools: [],
					});
				}
				const server = serverMap.get(serverId)!;
				server.toolCount++;
				server.tools.push({
					id: tool.name,
					name: tool.name,
					description: tool.description ?? '',
					enabled: tool.enabled ?? true,
				});
			}

			this.servers = Array.from(serverMap.values());
		} catch (err) {
			console.error('[McpServerEditor] Failed to load MCP servers:', err);
		}

		this._refreshBtn.textContent = '🔄 Refresh';
		this._refreshBtn.disabled = false;
		this._loading = false;

		this._renderContent(content);
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  RENDER
	// ══════════════════════════════════════════════════════════════════════════

	private _renderContent(container: HTMLElement): void {
		clearNode(container);

		// Build set of connected server IDs (sanitized) for quick lookup.
		// this.servers ids are sanitized tool prefixes; _manuallyAddedIds are sanitized names.
		const connectedIds = new Set<string>([
			...this.servers.map(s => s.id),
			...this._manuallyAddedIds,
		]);

		const q = this._filterQuery;

		// ── Connected servers section (live, with tools) ────────────
		if (this.servers.length > 0) {
			const connectedSection = $('div.mcp-editor-section');
			const sectionTitle = $('h3.mcp-editor-section-title');
			sectionTitle.textContent = `已连接 (${this.servers.length})`;
			sectionTitle.style.margin = '0 0 8px 0';
			sectionTitle.style.fontSize = '14px';
			sectionTitle.style.fontWeight = '600';
			connectedSection.appendChild(sectionTitle);

			for (const server of this.servers) {
				const card = $('div.mcp-editor-connected-card');
				card.style.display = 'flex';
				card.style.alignItems = 'center';
				card.style.gap = '10px';
				card.style.padding = '10px 14px';
				card.style.marginBottom = '6px';
				card.style.border = '1px solid var(--vscode-panel-border)';
				card.style.borderRadius = '6px';
				card.style.background = 'var(--vscode-sideBarSectionHeader-background)';

				const statusDot = $('span');
				statusDot.style.width = '8px';
				statusDot.style.height = '8px';
				statusDot.style.borderRadius = '50%';
				statusDot.style.flexShrink = '0';
				statusDot.style.background = 'var(--vscode-testing-iconPassed, #89d185)';
				card.appendChild(statusDot);

				const nameEl = $('span');
				nameEl.textContent = server.name;
				nameEl.style.fontSize = '13px';
				nameEl.style.fontWeight = '500';
				nameEl.style.flex = '1';
				card.appendChild(nameEl);

				const badge = $('span');
				badge.textContent = `${server.toolCount} tools`;
				badge.style.fontSize = '11px';
				badge.style.padding = '2px 8px';
				badge.style.borderRadius = '10px';
				badge.style.background = 'var(--vscode-badge-background)';
				badge.style.color = 'var(--vscode-badge-foreground)';
				card.appendChild(badge);

				const removeBtn = $('button') as HTMLButtonElement;
				removeBtn.textContent = '\u2715';
				removeBtn.title = '删除该服务器';
				removeBtn.style.padding = '2px 6px';
				removeBtn.style.fontSize = '12px';
				removeBtn.style.background = 'transparent';
				removeBtn.style.color = 'var(--vscode-descriptionForeground)';
				removeBtn.style.border = 'none';
				removeBtn.style.borderRadius = '4px';
				removeBtn.style.cursor = 'pointer';
				removeBtn.onclick = (e) => {
					e.stopPropagation();
					void this._removeServer(server.id);
				};
				card.appendChild(removeBtn);

				connectedSection.appendChild(card);
			}
			container.appendChild(connectedSection);

			const divider = $('hr.mcp-editor-divider');
			divider.style.margin = '12px 0';
			divider.style.border = 'none';
			divider.style.borderTop = '1px solid var(--vscode-panel-border)';
			container.appendChild(divider);
		}

		// ── Built-in presets section ────────────────────────────────
		let presets = BUNDLED_MCP_PRESETS.slice();
		if (this._transportFilter !== 'All') {
			presets = presets.filter(p => p.transportType === this._transportFilter);
		}
		if (q) {
			presets = presets.filter(p =>
				p.name.toLowerCase().includes(q) ||
				p.id.toLowerCase().includes(q) ||
				p.description.toLowerCase().includes(q)
			);
		}

		const presetSection = $('div.mcp-editor-section');
		const presetHeader = $('div');
		presetHeader.style.display = 'flex';
		presetHeader.style.alignItems = 'center';
		presetHeader.style.justifyContent = 'space-between';
		presetHeader.style.marginBottom = '10px';

		const presetTitle = $('h3.mcp-editor-section-title');
		presetTitle.textContent = `内置预设 (${presets.length})`;
		presetTitle.style.margin = '0';
		presetTitle.style.fontSize = '14px';
		presetTitle.style.fontWeight = '600';
		presetHeader.appendChild(presetTitle);

		// Transport filter chips
		const filterChips = $('div.mcp-editor-filter-chips');
		filterChips.style.display = 'flex';
		filterChips.style.gap = '4px';
		const transportTypes = ['All', ...Array.from(new Set(BUNDLED_MCP_PRESETS.map(p => p.transportType)))];
		for (const type of transportTypes) {
			const chip = $('button');
			chip.textContent = type === 'All' ? '全部' : type.toUpperCase();
			chip.style.padding = '3px 10px';
			chip.style.fontSize = '11px';
			chip.style.borderRadius = '12px';
			chip.style.border = '1px solid var(--vscode-panel-border)';
			chip.style.cursor = 'pointer';
			const active = this._transportFilter === type;
			chip.style.background = active ? 'var(--vscode-button-background)' : 'transparent';
			chip.style.color = active ? 'var(--vscode-button-foreground)' : 'var(--vscode-descriptionForeground)';
			chip.onclick = () => {
				this._transportFilter = type;
				this._renderContent(container);
			};
			filterChips.appendChild(chip);
		}
		presetHeader.appendChild(filterChips);
		presetSection.appendChild(presetHeader);

		if (presets.length === 0) {
			presetSection.appendChild(this._emptyHint('没有匹配的预设。'));
		} else {
			const grid = this._buildGrid();
			for (const preset of presets) {
				grid.appendChild(this._buildMcpCard({
					marketId: preset.id,
					name: preset.name,
					description: preset.description,
					transportType: preset.transportType,
					tags: preset.envKeys ? preset.envKeys.slice() : [],
				}, connectedIds));
			}
			presetSection.appendChild(grid);
		}
		container.appendChild(presetSection);

		// ── Knot market section ─────────────────────────────────────
		let knotItems: IKnotMcpMarketItem[] = KNOT_MCP_MARKET.slice();
		if (q) {
			knotItems = knotItems.filter(k =>
				k.name.toLowerCase().includes(q) ||
				k.displayName.toLowerCase().includes(q) ||
				k.description.toLowerCase().includes(q) ||
				k.category.toLowerCase().includes(q) ||
				k.tags.some(t => t.toLowerCase().includes(q))
			);
		}

		const divider2 = $('hr.mcp-editor-divider');
		divider2.style.margin = '16px 0 12px';
		divider2.style.border = 'none';
		divider2.style.borderTop = '1px solid var(--vscode-panel-border)';
		container.appendChild(divider2);

		const knotSection = $('div.mcp-editor-section');
		const knotTitle = $('h3.mcp-editor-section-title');
		const totalKnot = KNOT_MCP_MARKET.length;
		knotTitle.textContent = q
			? `Knot 商城 (${knotItems.length}/${totalKnot})`
			: `Knot 商城 (${totalKnot})`;
		knotTitle.style.margin = '0 0 10px 0';
		knotTitle.style.fontSize = '14px';
		knotTitle.style.fontWeight = '600';
		knotSection.appendChild(knotTitle);

		if (knotItems.length === 0) {
			knotSection.appendChild(this._emptyHint('没有匹配的商城 MCP。'));
		} else {
			const limit = this._knotDisplayLimit;
			const shown = knotItems.slice(0, limit);
			const grid = this._buildGrid();
			for (const item of shown) {
				grid.appendChild(this._buildMcpCard({
					marketId: item.id,
					name: item.displayName || item.name,
					description: item.description,
					transportType: item.transportType,
					icon: item.icon,
					tags: item.tags.slice(0, 4),
					installName: item.name,
				}, connectedIds));
			}
			knotSection.appendChild(grid);

			if (knotItems.length > limit) {
				const moreWrap = $('div');
				moreWrap.style.textAlign = 'center';
				moreWrap.style.marginTop = '14px';
				const moreBtn = $('button') as HTMLButtonElement;
				moreBtn.textContent = `加载更多 (${knotItems.length - limit} 项剩余)`;
				moreBtn.style.padding = '8px 20px';
				moreBtn.style.fontSize = '12px';
				moreBtn.style.background = 'var(--vscode-button-secondaryBackground)';
				moreBtn.style.color = 'var(--vscode-button-secondaryForeground)';
				moreBtn.style.border = 'none';
				moreBtn.style.borderRadius = '4px';
				moreBtn.style.cursor = 'pointer';
				moreBtn.onclick = () => {
					this._knotDisplayLimit += 60;
					this._renderContent(container);
				};
				moreWrap.appendChild(moreBtn);
				knotSection.appendChild(moreWrap);
			}
		}
		container.appendChild(knotSection);
	}

	// ── Shared card helpers ──────────────────────────────────────────

	private _emptyHint(text: string): HTMLElement {
		const empty = $('p');
		empty.textContent = text;
		empty.style.color = 'var(--vscode-descriptionForeground)';
		empty.style.fontSize = '13px';
		empty.style.textAlign = 'center';
		empty.style.padding = '24px';
		return empty;
	}

	private _buildGrid(): HTMLElement {
		const grid = $('div.mcp-editor-preset-grid');
		grid.style.display = 'grid';
		grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(280px, 1fr))';
		grid.style.gap = '10px';
		return grid;
	}

	/**
	 * Builds a single MCP market card.
	 *   - Click on the card body → open the detail EditorPane.
	 *   - Click the install button → install + start (does NOT open detail).
	 *   - When installed → button becomes a delete button (uninstall).
	 */
	private _buildMcpCard(model: {
		marketId: string;
		name: string;
		description: string;
		transportType: string;
		icon?: string;
		tags?: string[];
		/** Sanitized-match target for install detection; defaults to marketId. */
		installName?: string;
	}, connectedIds: Set<string>): HTMLElement {
		const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
		const installName = model.installName ?? model.marketId;
		const isInstalled = connectedIds.has(sanitize(installName)) || connectedIds.has(installName) || connectedIds.has(model.marketId);
		const isLoading = this._loadingPresetId === model.marketId;

		const card = $('div.mcp-editor-preset-card');
		card.style.padding = '14px 16px';
		card.style.border = '1px solid var(--vscode-panel-border)';
		card.style.borderRadius = '8px';
		card.style.cursor = 'pointer';
		card.style.transition = 'border-color 0.15s, background 0.15s';
		card.style.display = 'flex';
		card.style.flexDirection = 'column';
		card.style.gap = '8px';
		if (isLoading) { card.style.borderColor = 'var(--vscode-focusBorder, #007fd4)'; }

		card.onmouseenter = () => {
			if (!isLoading) { card.style.borderColor = 'var(--vscode-focusBorder)'; }
			card.style.background = 'var(--vscode-list-hoverBackground)';
		};
		card.onmouseleave = () => {
			card.style.borderColor = isLoading ? 'var(--vscode-focusBorder, #007fd4)' : 'var(--vscode-panel-border)';
			card.style.background = '';
		};
		// Click the card body → open the detail page.
		card.onclick = () => { this._openDetail(model.marketId); };

		// Header: icon + name + action button
		const cardHeader = $('div');
		cardHeader.style.display = 'flex';
		cardHeader.style.alignItems = 'center';
		cardHeader.style.gap = '8px';

		// Icon
		const iconBox = $('div');
		iconBox.style.width = '28px';
		iconBox.style.height = '28px';
		iconBox.style.flexShrink = '0';
		iconBox.style.borderRadius = '6px';
		iconBox.style.display = 'flex';
		iconBox.style.alignItems = 'center';
		iconBox.style.justifyContent = 'center';
		iconBox.style.overflow = 'hidden';
		iconBox.style.fontSize = '16px';
		iconBox.style.background = 'var(--vscode-input-background)';
		if (model.icon) {
			const img = $('img') as HTMLImageElement;
			img.src = model.icon;
			img.style.width = '100%';
			img.style.height = '100%';
			img.style.objectFit = 'cover';
			img.onerror = () => { iconBox.textContent = '\u{1F50C}'; };
			iconBox.appendChild(img);
		} else {
			iconBox.textContent = '\u{1F50C}';
		}
		cardHeader.appendChild(iconBox);

		const nameWrap = $('div');
		nameWrap.style.flex = '1';
		nameWrap.style.minWidth = '0';
		const cardName = $('div');
		cardName.textContent = model.name;
		cardName.style.fontSize = '13px';
		cardName.style.fontWeight = '600';
		cardName.style.whiteSpace = 'nowrap';
		cardName.style.overflow = 'hidden';
		cardName.style.textOverflow = 'ellipsis';
		nameWrap.appendChild(cardName);
		cardHeader.appendChild(nameWrap);

		// Action button / status
		if (isLoading) {
			const loadingBadge = $('span');
			loadingBadge.textContent = '⏳ 安装中';
			loadingBadge.style.fontSize = '10px';
			loadingBadge.style.padding = '3px 8px';
			loadingBadge.style.borderRadius = '8px';
			loadingBadge.style.background = 'rgba(0, 127, 212, 0.15)';
			loadingBadge.style.color = 'var(--vscode-focusBorder, #007fd4)';
			loadingBadge.style.fontWeight = '500';
			loadingBadge.style.flexShrink = '0';
			cardHeader.appendChild(loadingBadge);
		} else if (isInstalled) {
			const delBtn = $('button') as HTMLButtonElement;
			delBtn.textContent = '🗑 删除';
			delBtn.style.fontSize = '11px';
			delBtn.style.padding = '4px 10px';
			delBtn.style.flexShrink = '0';
			delBtn.style.background = 'var(--vscode-inputValidation-errorBackground, #5a1d1d)';
			delBtn.style.color = 'var(--vscode-errorForeground, #f48771)';
			delBtn.style.border = '1px solid var(--vscode-inputValidation-errorBorder, #be1100)';
			delBtn.style.borderRadius = '4px';
			delBtn.style.cursor = 'pointer';
			delBtn.onclick = (e) => {
				e.stopPropagation();
				void this._removeServer(sanitize(installName));
			};
			cardHeader.appendChild(delBtn);
		} else {
			const addBtn = $('button') as HTMLButtonElement;
			addBtn.textContent = '⬇ 安装';
			addBtn.style.fontSize = '11px';
			addBtn.style.padding = '4px 10px';
			addBtn.style.flexShrink = '0';
			addBtn.style.background = 'var(--vscode-button-background)';
			addBtn.style.color = 'var(--vscode-button-foreground)';
			addBtn.style.border = 'none';
			addBtn.style.borderRadius = '4px';
			addBtn.style.cursor = 'pointer';
			addBtn.onclick = (e) => {
				e.stopPropagation();
				void this._installByMarketId(model.marketId);
			};
			cardHeader.appendChild(addBtn);
		}
		card.appendChild(cardHeader);

		// Description
		const cardDesc = $('p');
		cardDesc.textContent = model.description;
		cardDesc.style.margin = '0';
		cardDesc.style.fontSize = '12px';
		cardDesc.style.color = 'var(--vscode-descriptionForeground)';
		cardDesc.style.lineHeight = '1.4';
		cardDesc.style.display = '-webkit-box';
		cardDesc.style.webkitLineClamp = '2';
		(cardDesc.style as any).webkitBoxOrient = 'vertical';
		cardDesc.style.overflow = 'hidden';
		card.appendChild(cardDesc);

		// Footer: transport + tags
		const footer = $('div');
		footer.style.display = 'flex';
		footer.style.flexWrap = 'wrap';
		footer.style.gap = '4px';
		footer.style.alignItems = 'center';

		const transportBadge = $('span');
		transportBadge.textContent = model.transportType ? model.transportType.toUpperCase() : 'STDIO';
		transportBadge.style.fontSize = '10px';
		transportBadge.style.padding = '2px 6px';
		transportBadge.style.borderRadius = '8px';
		transportBadge.style.background = 'var(--vscode-badge-background)';
		transportBadge.style.color = 'var(--vscode-badge-foreground)';
		footer.appendChild(transportBadge);

		for (const tag of (model.tags ?? [])) {
			if (!tag) { continue; }
			const tagBadge = $('span');
			tagBadge.textContent = tag;
			tagBadge.style.fontSize = '10px';
			tagBadge.style.padding = '2px 6px';
			tagBadge.style.borderRadius = '8px';
			tagBadge.style.background = 'var(--vscode-input-background)';
			tagBadge.style.color = 'var(--vscode-descriptionForeground)';
			footer.appendChild(tagBadge);
		}
		card.appendChild(footer);

		return card;
	}

	/** Open the standalone MCP detail EditorPane for the given market id. */
	private _openDetail(marketId: string): void {
		const input = McpDetailEditorInput.getInstance(marketId);
		void this.editorService.openEditor(input, { pinned: true });
	}


	// ══════════════════════════════════════════════════════════════════════════
	//  ADD SERVER MODAL
	// ══════════════════════════════════════════════════════════════════════════

	private _showAddModal(): void {
		// Remove any existing modal overlay
		const existing = this._container.querySelector('.mcp-modal-overlay');
		if (existing) { existing.remove(); return; }

		const overlay = $('div.mcp-modal-overlay');
		overlay.style.position = 'absolute';
		overlay.style.top = '0';
		overlay.style.left = '0';
		overlay.style.right = '0';
		overlay.style.bottom = '0';
		overlay.style.background = 'rgba(0, 0, 0, 0.5)';
		overlay.style.display = 'flex';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.zIndex = '1000';
		overlay.onclick = (e) => {
			if (e.target === overlay) { overlay.remove(); }
		};

		const dialog = $('div.mcp-modal-dialog');
		dialog.style.background = 'var(--vscode-editor-background)';
		dialog.style.border = '1px solid var(--vscode-panel-border)';
		dialog.style.borderRadius = '8px';
		dialog.style.width = '440px';
		dialog.style.display = 'flex';
		dialog.style.flexDirection = 'column';
		dialog.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.35)';
		dialog.onclick = (e) => e.stopPropagation();

		// Dialog header
		const dHeader = $('div.mcp-modal-header');
		dHeader.style.display = 'flex';
		dHeader.style.alignItems = 'center';
		dHeader.style.justifyContent = 'space-between';
		dHeader.style.padding = '16px 20px 12px';
		dHeader.style.flexShrink = '0';

		const dTitle = $('h3.mcp-modal-title');
		dTitle.textContent = 'Add MCP Server';
		dTitle.style.margin = '0';
		dTitle.style.fontSize = '16px';
		dTitle.style.fontWeight = '600';
		dHeader.appendChild(dTitle);

		const dClose = $('button.mcp-modal-close') as HTMLButtonElement;
		dClose.textContent = '\u2715';
		dClose.title = 'Close';
		dClose.style.padding = '4px 8px';
		dClose.style.fontSize = '14px';
		dClose.style.background = 'transparent';
		dClose.style.color = 'var(--vscode-descriptionForeground)';
		dClose.style.border = 'none';
		dClose.style.borderRadius = '4px';
		dClose.style.cursor = 'pointer';
		dClose.onclick = () => overlay.remove();
		dHeader.appendChild(dClose);
		dialog.appendChild(dHeader);

		// Dialog body
		const dBody = $('div.mcp-modal-body');
		dBody.style.padding = '8px 20px 16px';
		dBody.style.display = 'flex';
		dBody.style.flexDirection = 'column';
		dBody.style.gap = '12px';

		// Server Name
		const nameLabel = $('label.mcp-modal-label');
		nameLabel.textContent = 'Server Name';
		nameLabel.style.display = 'block';
		nameLabel.style.fontSize = '12px';
		nameLabel.style.fontWeight = '500';
		nameLabel.style.marginBottom = '0';
		nameLabel.style.color = 'var(--vscode-descriptionForeground)';
		dBody.appendChild(nameLabel);

		const nameInput = $('input.mcp-modal-input') as HTMLInputElement;
		nameInput.type = 'text';
		nameInput.placeholder = 'e.g., my-api-server';
		nameInput.style.display = 'block';
		nameInput.style.width = '100%';
		nameInput.style.padding = '8px 10px';
		nameInput.style.border = '1px solid var(--vscode-input-border)';
		nameInput.style.borderRadius = '4px';
		nameInput.style.background = 'var(--vscode-input-background)';
		nameInput.style.color = 'var(--vscode-input-foreground)';
		nameInput.style.fontSize = '13px';
		nameInput.style.boxSizing = 'border-box';
		nameInput.style.outline = 'none';
		dBody.appendChild(nameInput);

		// Command / URL
		const cmdLabel = $('label.mcp-modal-label');
		cmdLabel.textContent = 'Command or URL';
		cmdLabel.style.display = 'block';
		cmdLabel.style.fontSize = '12px';
		cmdLabel.style.fontWeight = '500';
		cmdLabel.style.marginBottom = '0';
		cmdLabel.style.color = 'var(--vscode-descriptionForeground)';
		dBody.appendChild(cmdLabel);

		const cmdInput = $('input.mcp-modal-input') as HTMLInputElement;
		cmdInput.type = 'text';
		cmdInput.placeholder = 'e.g., npx @modelcontextprotocol/server-filesystem /path or https://...';
		cmdInput.style.display = 'block';
		cmdInput.style.width = '100%';
		cmdInput.style.padding = '8px 10px';
		cmdInput.style.border = '1px solid var(--vscode-input-border)';
		cmdInput.style.borderRadius = '4px';
		cmdInput.style.background = 'var(--vscode-input-background)';
		cmdInput.style.color = 'var(--vscode-input-foreground)';
		cmdInput.style.fontSize = '13px';
		cmdInput.style.boxSizing = 'border-box';
		cmdInput.style.outline = 'none';
		dBody.appendChild(cmdInput);

		dialog.appendChild(dBody);

		// Dialog footer
		const dFooter = $('div.mcp-modal-footer');
		dFooter.style.display = 'flex';
		dFooter.style.justifyContent = 'flex-end';
		dFooter.style.gap = '8px';
		dFooter.style.padding = '12px 20px';
		dFooter.style.borderTop = '1px solid var(--vscode-panel-border)';
		dFooter.style.flexShrink = '0';

		const cancelBtn = $('button.mcp-modal-cancel-btn') as HTMLButtonElement;
		cancelBtn.textContent = 'Cancel';
		cancelBtn.style.padding = '8px 16px';
		cancelBtn.style.fontSize = '13px';
		cancelBtn.style.background = 'var(--vscode-button-secondaryBackground)';
		cancelBtn.style.color = 'var(--vscode-button-secondaryForeground)';
		cancelBtn.style.border = 'none';
		cancelBtn.style.borderRadius = '4px';
		cancelBtn.style.cursor = 'pointer';
		cancelBtn.onclick = () => overlay.remove();
		dFooter.appendChild(cancelBtn);

		const addBtn = $('button.mcp-modal-add-btn') as HTMLButtonElement;
		addBtn.textContent = 'Add Server';
		addBtn.style.padding = '8px 20px';
		addBtn.style.fontSize = '13px';
		addBtn.style.fontWeight = '500';
		addBtn.style.background = 'var(--vscode-button-background)';
		addBtn.style.color = 'var(--vscode-button-foreground)';
		addBtn.style.border = 'none';
		addBtn.style.borderRadius = '4px';
		addBtn.style.cursor = 'pointer';
		addBtn.onclick = () => {
			const name = nameInput.value.trim();
			const cmd = cmdInput.value.trim();
			if (!name || !cmd) { return; }
			console.log('[McpServerEditor] Add custom server:', { name, command: cmd });
			overlay.remove();
			void this._refreshServers();
		};
		dFooter.appendChild(addBtn);

		dialog.appendChild(dFooter);
		overlay.appendChild(dialog);
		this._container.appendChild(overlay);
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  ACTIONS
	// ══════════════════════════════════════════════════════════════════════════

	/**
	 * Install an MCP server by its market id (works for both built-in presets and
	 * knot market items). Resolves the unified detail model, installs via the
	 * management service, then starts and waits for live tools.
	 */
	private async _installByMarketId(marketId: string): Promise<void> {
		const model = resolveMcpDetailModel(marketId);
		if (!model) {
			console.warn('[McpServerEditor] No model found for market id:', marketId);
			return;
		}

		this._loadingPresetId = marketId;
		const content = this._container.querySelector('#mcp-editor-content') as HTMLElement;
		if (content) { this._renderContent(content); }

		const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
		try {
			const config = buildInstallableConfig(model);
			const installable: IInstallableMcpServer = { name: model.name, config };
			console.log('[McpServerEditor] Installing MCP server via management service:', model.name);
			await this.mcpManagementService.install(installable);

			const server = await this._waitForMcpServer(model.name, 10000);
			if (server) {
				const started = await startServerAndWaitForLiveTools(server, { promptType: 'all-untrusted', autoTrustChanges: true });
				console.log('[McpServerEditor] Server auto-start result:', model.name, started ? 'live' : 'failed');
				if (started) {
					await this._waitForMcpToolsInAgentOS(model.name, 5000);
				}
			} else {
				console.warn('[McpServerEditor] Server not found after timeout:', model.name);
			}
		} catch (err) {
			console.error('[McpServerEditor] Failed to install server:', err);
		} finally {
			this._loadingPresetId = undefined;
		}

		await this._refreshServers();

		const norm = sanitize(model.name);
		if (!this.servers.some(s => s.id === norm)) {
			this._manuallyAddedIds.add(norm);
		}

		this.eventBridgeService.emit('mcp:servers-changed', { action: 'add', presetId: norm });

		if (content) { this._renderContent(content); }
	}

	/** Sync _manuallyAddedIds from installed MCP servers (management service). */
	private async _syncManualIdsFromConfig(): Promise<void> {
		try {
			const installed = await this.mcpManagementService.getInstalled();
			this._manuallyAddedIds.clear();
			const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
			for (const s of installed) {
				// Track by sanitized name to match McpToolProvider prefix convention.
				this._manuallyAddedIds.add(sanitize(s.name));
			}
		} catch { /* ignore */ }
	}

	/**
	 * Poll IMcpService.servers for the given server definition ID until found or timeout.
	 * Uses autorun to correctly read the IObservable.
	 */
	private async _waitForMcpServer(presetName: string, maxWaitMs: number): Promise<any> {
		const startTime = Date.now();
		while (Date.now() - startTime < maxWaitMs) {
			let found: any = undefined;

			// autorun fires synchronously on creation, giving us an immediate snapshot
			const d = autorun(reader => {
				const currentServers = this.mcpService.servers.read(reader);
				for (const s of currentServers) {
					// Installed servers get id = "mcp.config.{configId}.{name}" and label = name.
					// We installed with name=presetName, so match by label OR id suffix.
					const defId = s.definition?.id ?? '';
					const label = s.definition?.label ?? '';
					if (label === presetName || defId === presetName || defId.endsWith('.' + presetName)) {
						found = s;
					}
				}
			});
			d.dispose();

			if (found) {
				return found;
			}

			await timeout(300);
		}
		return undefined;
	}

	/**
	 * Poll AgentOSService until MCP tools for the given server appear (or timeout).
	 * McpToolProvider._wire() autorun fires asynchronously after server tools are live,
	 * so we need to wait for tools to propagate through the chain:
	 *   server.tools observable → McpToolProvider autorun → _onDidChangeTools → AgentOSService
	 */
	private async _waitForMcpToolsInAgentOS(serverId: string, maxWaitMs: number): Promise<boolean> {
		const startTime = Date.now();
		while (Date.now() - startTime < maxWaitMs) {
			const tools = await this.agentOSService.listAllToolsWithState('viewer');
			const mcpTools = tools.filter(t =>
				t.source?.includes?.('mcp') || t.category === 'mcp'
			);
			// Tools are named like "serverId__toolName" by McpToolProvider
			const sanitizedPrefix = serverId.replace(/[^A-Za-z0-9_]/g, '_');
			const hasServerTools = mcpTools.some(t =>
				t.name.startsWith(sanitizedPrefix + '__')
			);
			if (hasServerTools) {
				return true;
			}
			await timeout(300);
		}
		return false;
	}

	private async _removeServer(serverId: string): Promise<void> {
		try {
			// Uninstall via management service (servers are installed, not in settings.json).
			// serverId here is the McpToolProvider prefix (sanitized name); find the matching
			// installed server by name and uninstall it.
			const installed = await this.mcpManagementService.getInstalled();
			const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
			const match = installed.find(s => s.name === serverId || sanitize(s.name) === serverId);
			if (match) {
				await this.mcpManagementService.uninstall(match);
				console.log('[McpServerEditor] Server uninstalled:', match.name);
			} else {
				console.warn('[McpServerEditor] No installed server matched for removal:', serverId);
			}
		} catch (err) {
			console.error('[McpServerEditor] Failed to uninstall server:', err);
		}

		this._manuallyAddedIds.delete(serverId);

		// Notify other components
		this.eventBridgeService.emit('mcp:servers-changed', { action: 'remove', serverId });

		await this._refreshServers();
		const content = this._container.querySelector('#mcp-editor-content') as HTMLElement;
		if (content) { this._renderContent(content); }
	}
}
