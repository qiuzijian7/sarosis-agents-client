/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { $, clearNode } from '../../../../../base/browser/dom.js';
import { URI } from '../../../../../base/common/uri.js';
import { autorun, IObservable } from '../../../../../base/common/observable.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IAgentOSService } from '../../common/agentOS.js';
import { IToolDefinition } from '../../common/providers.js';
import { ISkillRegistry, ISkillDefinition } from '../../common/skills.js';
import { ISkillInstallService, ISkillHubEntry } from '../../common/skillHubTypes.js';
import { IEventBridgeService } from '../../common/eventBridge.js';
import { IMcpService, IMcpServer, McpConnectionState, McpServerCacheState } from '../../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { startServerAndWaitForLiveTools } from '../../../../../workbench/contrib/mcp/common/mcpTypesUtils.js';
import { IWorkbenchMcpManagementService } from '../../../../../workbench/services/mcp/common/mcpWorkbenchManagementService.js';
import { timeout } from '../../../../../base/common/async.js';
import { BUNDLED_MCP_PRESETS } from '../../common/bundled-tools/bundledMcpPresets.js';
import { KNOT_MCP_MARKET } from '../../common/bundled-tools/knotMcpMarket.js';
import { McpServerEditorInput } from '../mcpServerEditorInput.js';
import { McpDetailEditorInput } from '../mcpDetailEditorInput.js';
import { SkillMarketEditorInput } from '../skillMarketEditorInput.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type IntegrationTab = 'skill' | 'tools' | 'mcp';

interface ToolDefinitionUI {
	id: string;
	name: string;
	category: 'builtin' | 'custom';
	description: string;
	icon: string;
	enabled: boolean;
	provider?: string;
}

interface McpServerUI {
	id: string;
	name: string;
	status: 'connected' | 'disconnected' | 'error';
	toolCount: number;
}

interface McpToolUI {
	id: string;
	name: string;
	description: string;
	serverId: string;
	serverName: string;
	enabled: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function categorizeToolCategory(category: string | undefined): 'builtin' | 'custom' {
	if (!category) { return 'builtin'; }
	if (category === 'utility' || category === 'filesystem' || category === 'web' || category === 'shell') { return 'builtin'; }
	return 'custom';
}

function toolCategoryIcon(c: 'builtin' | 'custom'): string {
	return c === 'custom' ? '🧩' : '🔧';
}

function skillIconFor(s: ISkillDefinition): string {
	switch (s.category) {
		case 'code': return '\u{1F4BB}';
		case 'git': return '\u{1F500}';
		case 'meta': return '\u{1F9E0}';
		case 'docs': return '\u{1F4DD}';
		default: return '\u{1F4A1}';
	}
}

function skillIconForCategory(category?: string): string {
	switch (category) {
		case 'code': return '\u{1F4BB}';
		case 'git': return '\u{1F500}';
		case 'meta': return '\u{1F9E0}';
		case 'docs': return '\u{1F4DD}';
		case 'review': return '\u{1F50D}';
		case 'writing': return '\u270D\uFE0F';
		case 'data': return '\u{1F4CA}';
		default: return '\u{1F4E6}';
	}
}

// ─── IntegrationViewPane ─────────────────────────────────────────────────────

/**
 * 统一入口视图 —— 将原本独立的 Skills、Tools、MCP 三个 ActivityBar 入口
 * 合并为一个，页面顶部通过三个页签切换。
 */
export class IntegrationViewPane extends ViewPane {

	// ── Tab state ──────────────────────────────────────────────────
	private activeTab: IntegrationTab = 'skill';
	private tabBar!: HTMLElement;
	private contentContainer!: HTMLElement;

	// Track whether tabs have been rendered at least once (lazy init)
	private tabsRendered: Set<IntegrationTab> = new Set();

	// ── Skills state ──────────────────────────────────────────────
	private skills: ISkillDefinition[] = [];
	private skillsActiveCategory = 'All';
	private skillsSearchQuery = '';
	private skillsViewMode: 'list' | 'install-hubs' | 'install-entries' = 'list';
	private skillsLoadingHubId: string | undefined;
	private skillsCountBadge!: HTMLElement;
	private skillsSearchInput!: HTMLInputElement;
	private skillsFilterRow!: HTMLElement;

	// ── Tools state ───────────────────────────────────────────────
	private tools: ToolDefinitionUI[] = [];
	private toolsActiveTab = 'all';
	private toolsRetryCount = 0;
	private readonly toolsMaxRetries = 10;

	// ── MCP state ─────────────────────────────────────────────────
	private mcpTools: McpToolUI[] = [];
	private mcpServers: McpServerUI[] = [];
	/** Preset IDs that have been manually connected (synced from McpServerEditorPane) */
	private _connectedMcpPresetIds: Set<string> = new Set();
	/** Preset IDs currently being started (from EventBridge 'add' event, cleared when tools appear) */
	private _startingMcpIds: Set<string> = new Set();
	/** Server definition ID → IMcpServer instances for start/stop operations */
	private _mcpServerRefs: Map<string, IMcpServer> = new Map();
	/** Server IDs the user manually turned OFF (persisted in storage) */
	private _mcpDisabledIds: Set<string> = new Set();
	private static readonly MCP_DISABLED_STORAGE_KEY = 'agentStudio.mcpDisabledServers';
	/** Server definition IDs that are NOT MCP servers (e.g. model providers, built-in collections) */
	private static readonly NON_MCP_SERVER_IDS = new Set(['knot-agui', 'knot_agui']);
	/** Check whether a server ID (raw or sanitized) should be excluded */
	private static _isNonMcpServer(id: string): boolean {
		if (IntegrationViewPane.NON_MCP_SERVER_IDS.has(id)) { return true; }
		// Also check sanitized form
		const norm = id.replace(/[^A-Za-z0-9_]/g, '_');
		if (IntegrationViewPane.NON_MCP_SERVER_IDS.has(norm)) { return true; }
		// Pattern match: IDs containing 'knot' are model providers, not MCP servers
		if (id.toLowerCase().includes('knot')) { return true; }
		return false;
	}

	/**
	 * Resolve a market ID (from KNOT_MCP_MARKET or BUNDLED_MCP_PRESETS) from a
	 * sanitized server ID or display name. The sidebar uses sanitized tool-prefix
	 * IDs (McpToolProvider), but the detail EditorPane is keyed by the original
	 * market ID. Definition IDs like "mcp.config.xxx.name" get sanitized to
	 * "mcp_config_xxx_name" — we extract candidate name parts and try each.
	 */
	private static _resolveMcpMarketId(serverId: string, displayName?: string): string | undefined {
		const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
		const serverIdSan = sanitize(serverId);

		// Build a set of candidate names to try (deduplicated)
		const candidates = new Set<string>();
		candidates.add(serverId);
		candidates.add(serverIdSan);
		// Last segment of dot-separated IDs (e.g. "mcp.config.xxx.github" → "github")
		if (serverId.includes('.')) {
			const parts = serverId.split('.');
			const last = parts[parts.length - 1];
			candidates.add(last);
			candidates.add(sanitize(last));
		}
		// For sanitized definition IDs like "mcp_config_xxx_name", extract meaningful parts
		// after the leading "mcp_config_" prefix
		const defMatch = serverIdSan.match(/^mcp_config_(?:[^_]+_)?(\w+)$/) || serverIdSan.match(/^mcp_config_(\w+)$/);
		if (defMatch) {
			candidates.add(defMatch[1]);
		}
		// Also try each underscore-separated segment >2 chars as a candidate name
		for (const seg of serverIdSan.split('_')) {
			if (seg.length > 2) { candidates.add(seg); }
		}
		// Display name from the MCP server definition
		if (displayName) {
			candidates.add(displayName);
			candidates.add(sanitize(displayName));
		}

		// 1. Built-in presets: id or sanitized(id)
		for (const preset of BUNDLED_MCP_PRESETS) {
			for (const c of candidates) {
				if (preset.id === c || sanitize(preset.id) === c || preset.name === c || sanitize(preset.name) === c) {
					return preset.id;
				}
			}
		}
		// 2. Knot market items: id, name, or displayName
		for (const item of KNOT_MCP_MARKET) {
			for (const c of candidates) {
				if (item.id === c || item.name === c || sanitize(item.name) === c
					|| item.displayName === c || sanitize(item.displayName) === c) {
					return item.id;
				}
			}
		}
		return undefined;
	}

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
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorService private readonly editorService: IEditorService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@IMcpService private readonly mcpService: IMcpService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@ISkillInstallService private readonly skillInstallService: ISkillInstallService,
		@IEventBridgeService private readonly eventBridgeService: IEventBridgeService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Listen for MCP server changes from McpServerEditorPane
		this._register(this.eventBridgeService.on('mcp:servers-changed', (event) => {
			const data = event.data;
			if (data?.action === 'add' && data.presetId) {
				if (!IntegrationViewPane._isNonMcpServer(data.presetId)) {
					this._connectedMcpPresetIds.add(data.presetId);
					// Don't add to _startingMcpIds — EditorPane already started the server
				}
			} else if (data?.action === 'remove' && data.serverId) {
				this._connectedMcpPresetIds.delete(data.serverId);
				this._startingMcpIds.delete(data.serverId);
			}
			if (this.tabsRendered.has('mcp')) {
				void this._reloadMcp().then(() => {
					this._renderMcpContent();
				});
			}
		}));

		// Load persisted disabled MCP server IDs
		this._loadMcpDisabledState();

		// Listen for MCP server list changes AND per-server state changes.
		// We must read each server's connectionState/cacheState inside the autorun,
		// otherwise a server transitioning disconnected→connected (which keeps the
		// servers array reference stable) would NOT re-trigger this autorun and the
		// UI would stay stuck showing red dots / 0 tools.
		let _mcpReloadTimer: ReturnType<typeof setTimeout> | undefined;
		this._register(autorun(reader => {
			const servers = (this.mcpService.servers as IObservable<readonly IMcpServer[]>).read(reader);
			// Deep-subscribe to each server's runtime state so connection/tool changes wake us up.
			for (const server of servers) {
				server.connectionState.read(reader);
				server.cacheState.read(reader);
			}
			// Only refresh if MCP tab is visible and has been rendered, with 500ms debounce
			if (this.tabsRendered.has('mcp') && servers.length > 0) {
				if (_mcpReloadTimer) { clearTimeout(_mcpReloadTimer); }
				_mcpReloadTimer = setTimeout(() => void this._reloadMcp(), 500);
			}
		}));

		// Listen for skill changes
		this._register(this.skillRegistry.onDidChangeSkills(() => {
			if (this.tabsRendered.has('skill') && this.skillsViewMode === 'list') {
				this._refreshSkills();
			}
		}));
		this._register(this.skillInstallService.onDidChangeEntries(() => {
			if (this.tabsRendered.has('skill') && this.skillsViewMode === 'install-entries' && this.skillsLoadingHubId) {
				this._renderHubEntries(this.skillsLoadingHubId);
			}
		}));
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  RENDER BODY
	// ══════════════════════════════════════════════════════════════════════════

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('integration-view');

		// Tab bar
		this.tabBar = $('div.integration-tab-bar');
		const tabDefs: { id: IntegrationTab; label: string; icon: string }[] = [
			{ id: 'skill', label: 'Skill', icon: '\u{1F4A1}' },
			{ id: 'tools', label: 'Tools', icon: '\u{1F527}' },
			{ id: 'mcp', label: 'MCP', icon: '\u{1F50C}' },
		];
		for (const tab of tabDefs) {
			const btn = $('button.integration-tab');
			btn.textContent = `${tab.icon} ${tab.label}`;
			if (tab.id === this.activeTab) { btn.classList.add('active'); }
			btn.onclick = () => this._switchTab(tab.id);
			this.tabBar.appendChild(btn);
		}
		container.appendChild(this.tabBar);

		// Content area
		this.contentContainer = $('div.integration-content');
		container.appendChild(this.contentContainer);

		// Lazy-render the default tab (skill)
		this._switchTab('skill');
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible && this.tabsRendered.has(this.activeTab)) {
			this._renderActiveTab();
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.contentContainer) {
			// Height minus tab bar (~36px)
			this.contentContainer.style.height = `${Math.max(0, height - 36)}px`;
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  TAB SWITCHING
	// ══════════════════════════════════════════════════════════════════════════

	private _switchTab(tab: IntegrationTab): void {
		this.activeTab = tab;

		// Update tab button styles
		const allTabs = this.tabBar.querySelectorAll('.integration-tab');
		allTabs.forEach(b => b.classList.remove('active'));
		const tabOrder: IntegrationTab[] = ['skill', 'tools', 'mcp'];
		const idx = tabOrder.indexOf(tab);
		if (idx >= 0) {
			allTabs[idx].classList.add('active');
		}

		// Render content
		this._renderActiveTab();
	}

	private _renderActiveTab(): void {
		clearNode(this.contentContainer);

		switch (this.activeTab) {
			case 'skill':
				if (!this.tabsRendered.has('skill')) {
					// First time: build skill DOM structure
					this._buildSkillsDom();
					this.tabsRendered.add('skill');
					setTimeout(() => this._refreshSkills(), 0);
				} else {
					// Already built: re-attach DOM and refresh
					this._buildSkillsDom();
					this._refreshSkills();
				}
				break;
			case 'tools':
				if (!this.tabsRendered.has('tools')) {
					this._buildToolsDom();
					this.tabsRendered.add('tools');
					void this._reloadTools();
				} else {
					this._buildToolsDom();
					this._renderToolsList();
				}
				break;
			case 'mcp':
				if (!this.tabsRendered.has('mcp')) {
					this._buildMcpDom();
					this.tabsRendered.add('mcp');
					void this._reloadMcp();
				} else {
					this._buildMcpDom();
					this._renderMcpContent();
				}
				break;
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  SKILLS TAB
	// ══════════════════════════════════════════════════════════════════════════

	private _buildSkillsDom(): void {
		const container = this.contentContainer;
		clearNode(container);

		// Header
		const header = $('div.skills-header');
		const title = $('h3.skills-title');
		title.classList.add('integration-section-title');
		title.textContent = '\u{1F4A1} Skills Library';
		header.appendChild(title);

		this.skillsCountBadge = $('span.skills-count');
		header.appendChild(this.skillsCountBadge);

		const installBtn = $('button.skills-install-btn');
		installBtn.textContent = '+ Install';
		installBtn.title = 'Browse and install skills from the marketplace';
		installBtn.onclick = () => {
			const input = SkillMarketEditorInput.getInstance();
			this.editorService.openEditor(input, { pinned: true });
		};
		header.appendChild(installBtn);

		container.appendChild(header);

		// Search bar
		const searchRow = $('div.skills-search-row');
		this.skillsSearchInput = $('input.skills-search-input') as HTMLInputElement;
		this.skillsSearchInput.type = 'text';
		this.skillsSearchInput.placeholder = '\u{1F50D} Search skills by name, description, or id...';
		this.skillsSearchInput.oninput = () => {
			this.skillsSearchQuery = this.skillsSearchInput.value.trim().toLowerCase();
			this._renderSkillsList();
		};
		searchRow.appendChild(this.skillsSearchInput);

		const clearBtn = $('button.skills-search-clear-btn');
		clearBtn.textContent = '\u2715';
		clearBtn.title = 'Clear search';
		clearBtn.onclick = () => {
			this.skillsSearchInput.value = '';
			this.skillsSearchQuery = '';
			this._renderSkillsList();
		};
		searchRow.appendChild(clearBtn);
		container.appendChild(searchRow);

		// Filter row
		this.skillsFilterRow = $('div.skills-filters');
		container.appendChild(this.skillsFilterRow);

		// List container
		const listContainer = $('div.integration-skills-list');
		listContainer.id = 'integration-skills-list';
		container.appendChild(listContainer);
	}

	private _refreshSkills(): void {
		this.skillsViewMode = 'list';
		const allSkills = [...this.skillRegistry.getSkills()];

		// Dedup
		const sourcePriority: Record<string, number> = { workspace: 4, user: 3, extension: 2, memory: 1, builtin: 0 };
		const deduped = new Map<string, ISkillDefinition>();
		for (const s of allSkills) {
			const contentKey = `${s.id}::${s.contentHash ?? 'no-hash'}`;
			const existing = deduped.get(contentKey);
			if (existing) {
				const existingPri = sourcePriority[existing.source] ?? 0;
				const newPri = sourcePriority[s.source] ?? 0;
				if (newPri > existingPri) {
					deduped.set(contentKey, s);
				}
			} else {
				deduped.set(contentKey, s);
			}
		}
		this.skills = [...deduped.values()];
		this._updateSkillsCount();
		this._renderSkillsFilters();
		this._renderSkillsList();
	}

	private _updateSkillsCount(): void {
		const total = this.skills.length;
		const active = this.skills.filter(s => s.activation === 'always' || s.activation === 'auto').length;
		if (this.skillsSearchQuery) {
			const matched = this.skills.filter(s => {
				const q = this.skillsSearchQuery;
				return s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
					|| (s.description ?? '').toLowerCase().includes(q) || (s.category ?? '').toLowerCase().includes(q);
			}).length;
			this.skillsCountBadge.textContent = `${matched}/${total} matched`;
		} else {
			this.skillsCountBadge.textContent = `${active}/${total} auto-activate`;
		}
	}

	private _renderSkillsFilters(): void {
		if (!this.skillsFilterRow) { return; }
		clearNode(this.skillsFilterRow);
		const categories = ['All', ...Array.from(new Set(this.skills.map(s => s.category ?? 'misc')))];
		for (const cat of categories) {
			const btn = $('button.skill-filter-btn');
			btn.textContent = cat;
			if (cat === this.skillsActiveCategory) { btn.classList.add('active'); }
			btn.onclick = () => {
				this.skillsFilterRow.querySelectorAll('.skill-filter-btn').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this.skillsActiveCategory = cat;
				this._renderSkillsList();
			};
			this.skillsFilterRow.appendChild(btn);
		}
	}

	private _renderSkillsList(): void {
		const listEl = this.contentContainer.querySelector('#integration-skills-list') as HTMLElement;
		if (!listEl) { return; }
		clearNode(listEl);

		if (this.skillsViewMode !== 'list') {
			// When in install mode, the panel handles its own rendering
			return;
		}

		let filtered = this.skillsActiveCategory === 'All'
			? this.skills
			: this.skills.filter(s => (s.category ?? 'misc') === this.skillsActiveCategory);

		if (this.skillsSearchQuery) {
			filtered = filtered.filter(s => {
				const q = this.skillsSearchQuery;
				return s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
					|| (s.description ?? '').toLowerCase().includes(q) || (s.category ?? '').toLowerCase().includes(q);
			});
		}

		if (filtered.length === 0) {
			const empty = $('div.skills-empty');
			const p = $('p');
			if (this.skillsSearchQuery) {
				p.append('No skills match "', Object.assign($('b'), { textContent: this.skillsSearchQuery }), '". Try a different search term.');
			} else {
				p.append('No skills in this category. Click ', Object.assign($('b'), { textContent: '+ Install' }),
					' to add from a hub, or drop a SKILL.md into ',
					Object.assign($('code'), { textContent: '.sarosworkspace/agents/<agentDir>/skills/<id>/' }), '.');
			}
			empty.appendChild(p);
			listEl.appendChild(empty);
			return;
		}

		for (const skill of filtered) {
			const item = $('div.skill-item');
			item.classList.toggle('skill-enabled', skill.enabled !== false);

			const toggleContainer = $('div.skill-toggle');
			const toggle = $('input.skill-toggle-input') as HTMLInputElement;
			toggle.type = 'checkbox';
			toggle.checked = skill.enabled !== false;
			toggle.title = skill.enabled !== false ? 'Disable this skill' : 'Enable this skill';
			toggle.onchange = async () => {
				try {
					if (toggle.checked) {
						this.skillRegistry.enableSkill(skill.id);
					} else {
						this.skillRegistry.disableSkill(skill.id);
					}
					skill.enabled = toggle.checked;
					item.classList.toggle('skill-enabled', skill.enabled !== false);
				} catch (err) {
					console.error('[IntegrationView] Failed to toggle skill:', err);
					toggle.checked = !toggle.checked;
				}
			};
			const toggleSlider = $('span.toggle-slider');
			toggleContainer.appendChild(toggle);
			toggleContainer.appendChild(toggleSlider);
			item.appendChild(toggleContainer);

			const iconEl = $('span.skill-icon');
			iconEl.textContent = skillIconFor(skill);
			item.appendChild(iconEl);

			const info = $('div.skill-info');
			const nameRow = $('div.skill-name-row');
			const nameEl = $('span.skill-name');
			nameEl.textContent = skill.name;
			nameRow.appendChild(nameEl);

			const catBadge = $('span.skill-category-badge');
			catBadge.textContent = skill.category ?? 'misc';
			nameRow.appendChild(catBadge);

			const activationBadge = $('span.skill-category-badge');
			activationBadge.textContent = skill.activation;
			activationBadge.classList.add(`skill-activation-${skill.activation}`);
			nameRow.appendChild(activationBadge);

			const sourceBadge = $('span.skill-category-badge');
			sourceBadge.textContent = skill.source;
			nameRow.appendChild(sourceBadge);

			info.appendChild(nameRow);

			const descEl = $('div.skill-desc');
			descEl.textContent = skill.description || '(no description)';
			info.appendChild(descEl);
			item.appendChild(info);

			if (skill.source === 'user') {
				const uninstallBtn = $('button.skill-uninstall-btn');
				uninstallBtn.textContent = '\u2715';
				uninstallBtn.title = 'Uninstall this skill';
				uninstallBtn.onclick = async (e) => {
					e.stopPropagation();
					const confirmed = await this.dialogService.confirm({
						message: `Uninstall skill "${skill.name}"?`,
						detail: 'This will remove the SKILL.md file from your user skills directory.',
						primaryButton: 'Uninstall',
					});
					if (confirmed.confirmed) {
						await this.skillInstallService.uninstallSkill(skill.id);
						this._refreshSkills();
					}
				};
				item.appendChild(uninstallBtn);
			}

			item.style.cursor = skill.resource ? 'pointer' : 'default';
			item.onclick = (e) => {
				const target = e.target as HTMLElement;
				if (target.tagName === 'INPUT' || target.tagName === 'BUTTON' || target.closest('button')) {
					return;
				}
				if (skill.resource) {
					const skillFileUri = URI.joinPath(skill.resource, 'SKILL.md');
					this.editorService.openEditor({
						resource: skillFileUri,
						options: { pinned: false, preserveFocus: false },
					});
				}
			};

			listEl.appendChild(item);
		}
	}

	// ── Skills: Install UI ────────────────────────────────────────

	private _showInstallHubs(): void {
		this.skillsViewMode = 'install-hubs';
		const listEl = this.contentContainer.querySelector('#integration-skills-list') as HTMLElement;
		if (!listEl) { return; }
		clearNode(listEl);

		const panel = $('div.skill-install-panel');

		const header = $('div.skill-install-header');
		const title = $('h4.skill-install-title');
		title.textContent = 'Install Skills';
		header.appendChild(title);

		const backBtn = $('button.skill-install-back-btn');
		backBtn.textContent = '\u2190 Back';
		backBtn.onclick = () => this._refreshSkills();
		header.appendChild(backBtn);
		panel.appendChild(header);

		// From Hub
		const hubSection = $('div.skill-install-section');
		const hubTitle = $('div.skill-install-section-title');
		hubTitle.textContent = 'From Skill Hubs';
		hubSection.appendChild(hubTitle);
		const hubDesc = $('div.skill-install-section-desc');
		hubDesc.textContent = 'Browse and install skills from open-source repositories';
		hubSection.appendChild(hubDesc);

		const hubGrid = $('div.skill-hub-grid');
		const hubs = this.skillInstallService.getHubs();
		for (const hub of hubs) {
			const card = $('div.skill-hub-card');
			if (hub.official) { card.classList.add('skill-hub-card-official'); }

			const hubIcon = $('span.skill-hub-icon');
			hubIcon.textContent = hub.icon ?? '\u{1F4E6}';
			card.appendChild(hubIcon);

			const hubInfo = $('div.skill-hub-info');
			const hubName = $('div.skill-hub-name');
			hubName.textContent = hub.name;
			if (hub.official) {
				const officialBadge = $('span.skill-hub-official-badge');
				officialBadge.textContent = 'Official';
				hubName.appendChild(officialBadge);
			}
			hubInfo.appendChild(hubName);

			const hubDescEl = $('div.skill-hub-desc');
			hubDescEl.textContent = hub.description;
			hubInfo.appendChild(hubDescEl);

			const hubType = $('div.skill-hub-type');
			hubType.textContent = hub.type === 'github' ? 'GitHub' : hub.type === 'url' ? 'URL' : hub.type === 'local' ? 'Local' : hub.type;
			hubInfo.appendChild(hubType);

			card.appendChild(hubInfo);
			card.onclick = () => this._showHubEntries(hub.id);
			hubGrid.appendChild(card);
		}
		hubSection.appendChild(hubGrid);
		panel.appendChild(hubSection);

		// From Local File
		const localSection = $('div.skill-install-section');
		const localTitle = $('div.skill-install-section-title');
		localTitle.textContent = 'From Local File';
		localSection.appendChild(localTitle);
		const localDesc = $('div.skill-install-section-desc');
		localDesc.textContent = 'Import a SKILL.md file from your computer';
		localSection.appendChild(localDesc);

		const localActions = $('div.skill-install-local-actions');
		const fileInput = $('input.skill-file-input') as HTMLInputElement;
		fileInput.type = 'file';
		fileInput.accept = '.md,.markdown';
		fileInput.style.display = 'none';
		fileInput.onchange = async () => {
			const file = fileInput.files?.[0];
			if (!file) { return; }
			const text = await file.text();
			const result = await this.skillInstallService.installFromContent(text);
			if (result.success) {
				this._refreshSkills();
			} else {
				await this.dialogService.info(
					`Failed to install skill: ${result.error ?? 'Unknown error'}`,
					'Installation Failed'
				);
			}
		};
		localActions.appendChild(fileInput);

		const browseBtn = $('button.skill-install-browse-btn');
		browseBtn.textContent = '\u{1F4C1} Browse SKILL.md';
		browseBtn.onclick = () => fileInput.click();
		localActions.appendChild(browseBtn);

		const pasteBtn = $('button.skill-install-paste-btn');
		pasteBtn.textContent = '\u{1F4CB} Paste Content';
		pasteBtn.onclick = () => this._showPasteDialog();
		localActions.appendChild(pasteBtn);

		localSection.appendChild(localActions);
		panel.appendChild(localSection);

		// From URL
		const urlSection = $('div.skill-install-section');
		const urlTitle = $('div.skill-install-section-title');
		urlTitle.textContent = 'From URL';
		urlSection.appendChild(urlTitle);
		const urlDesc = $('div.skill-install-section-desc');
		urlDesc.textContent = 'Install from a direct SKILL.md URL (GitHub raw, Gist, etc.)';
		urlSection.appendChild(urlDesc);

		const urlRow = $('div.skill-install-url-row');
		const urlInput = $('input.skill-url-input') as HTMLInputElement;
		urlInput.type = 'text';
		urlInput.placeholder = 'https://raw.githubusercontent.com/.../SKILL.md';
		urlRow.appendChild(urlInput);

		const urlBtn = $('button.skill-install-url-btn');
		urlBtn.textContent = 'Install';
		urlBtn.onclick = async () => {
			const url = urlInput.value.trim();
			if (!url) { return; }
			urlBtn.textContent = 'Installing...';
			(urlBtn as HTMLButtonElement).disabled = true;
			try {
				const content = await this._fetchUrlContent(url);
				if (!content) { throw new Error('Failed to download content'); }
				const result = await this.skillInstallService.installFromContent(content);
				if (result.success) {
					this._refreshSkills();
				} else {
					await this.dialogService.info(
						`Failed to install: ${result.error ?? 'Unknown error'}`,
						'Installation Failed'
					);
				}
			} catch (err) {
				await this.dialogService.info(
					`Error: ${err instanceof Error ? err.message : String(err)}`,
					'Installation Failed'
				);
			} finally {
				urlBtn.textContent = 'Install';
				(urlBtn as HTMLButtonElement).disabled = false;
			}
		};
		urlRow.appendChild(urlBtn);
		urlSection.appendChild(urlRow);
		panel.appendChild(urlSection);

		listEl.appendChild(panel);
	}

	private async _showHubEntries(hubId: string): Promise<void> {
		this.skillsViewMode = 'install-entries';
		this.skillsLoadingHubId = hubId;
		const listEl = this.contentContainer.querySelector('#integration-skills-list') as HTMLElement;
		if (!listEl) { return; }
		clearNode(listEl);

		const hub = this.skillInstallService.getHubs().find(h => h.id === hubId);

		const header = $('div.skill-install-header');
		const title = $('h4.skill-install-title');
		title.textContent = hub?.name ?? hubId;
		header.appendChild(title);

		const backBtn = $('button.skill-install-back-btn');
		backBtn.textContent = '\u2190 Back to Hubs';
		backBtn.onclick = () => this._showInstallHubs();
		header.appendChild(backBtn);

		const refreshBtn = $('button.skill-hub-refresh-btn');
		refreshBtn.textContent = '\u{1F504} Refresh';
		refreshBtn.onclick = () => { void this.skillInstallService.fetchHubEntries(hubId); };
		header.appendChild(refreshBtn);

		listEl.appendChild(header);

		const loading = $('div.skill-hub-loading');
		loading.textContent = 'Loading skills from hub...';
		listEl.appendChild(loading);

		const entries = await this.skillInstallService.fetchHubEntries(hubId);
		this._renderHubEntries(hubId, entries);
	}

	private _renderHubEntries(hubId: string, entries?: readonly ISkillHubEntry[]): void {
		const listEl = this.contentContainer.querySelector('#integration-skills-list');
		if (!listEl) { return; }

		const loadingEl = listEl.querySelector('.skill-hub-loading');
		if (loadingEl) { loadingEl.remove(); }

		const existingEntries = listEl.querySelectorAll('.skill-hub-entry');
		existingEntries.forEach(el => el.remove());
		const existingEmpty = listEl.querySelector('.skill-hub-entries-empty');
		if (existingEmpty) { existingEmpty.remove(); }

		const allEntries = entries ?? this.skillInstallService.getCachedEntries(hubId);

		if (allEntries.length === 0) {
			const empty = $('div.skill-hub-entries-empty');
			empty.textContent = 'No skills found in this hub. Try refreshing.';
			listEl.appendChild(empty);
			return;
		}

		for (const entry of allEntries) {
			const item = $('div.skill-hub-entry');
			if (entry.installed) { item.classList.add('skill-hub-entry-installed'); }

			const icon = $('span.skill-hub-entry-icon');
			icon.textContent = skillIconForCategory(entry.category);
			item.appendChild(icon);

			const info = $('div.skill-hub-entry-info');
			const nameRow = $('div.skill-hub-entry-name-row');
			const name = $('span.skill-hub-entry-name');
			name.textContent = entry.name;
			nameRow.appendChild(name);

			if (entry.category) {
				const catBadge = $('span.skill-category-badge');
				catBadge.textContent = entry.category;
				nameRow.appendChild(catBadge);
			}
			if (entry.activation) {
				const actBadge = $('span.skill-category-badge');
				actBadge.textContent = entry.activation;
				nameRow.appendChild(actBadge);
			}
			if (entry.installed) {
				const installedBadge = $('span.skill-hub-entry-installed-badge');
				installedBadge.textContent = 'Installed';
				nameRow.appendChild(installedBadge);
			}

			info.appendChild(nameRow);
			const desc = $('div.skill-hub-entry-desc');
			desc.textContent = entry.description || '(no description)';
			info.appendChild(desc);
			item.appendChild(info);

			if (!entry.installed) {
				const installBtn = $('button.skill-hub-entry-install-btn');
				installBtn.textContent = 'Install';
				installBtn.onclick = async (e) => {
					e.stopPropagation();
					installBtn.textContent = 'Installing...';
					(installBtn as HTMLButtonElement).disabled = true;
					const result = await this.skillInstallService.installFromHub(hubId, entry.id);
					if (result.success) {
						entry.installed = true;
						installBtn.textContent = 'Installed \u2713';
						(installBtn as HTMLButtonElement).disabled = true;
						item.classList.add('skill-hub-entry-installed');
						if (!item.querySelector('.skill-hub-entry-installed-badge')) {
							const badge = $('span.skill-hub-entry-installed-badge');
							badge.textContent = 'Installed';
							nameRow.appendChild(badge);
						}
					} else {
						installBtn.textContent = 'Install';
						(installBtn as HTMLButtonElement).disabled = false;
						await this.dialogService.info(
							`Failed to install "${entry.name}": ${result.error ?? 'Unknown error'}`,
							'Installation Failed'
						);
					}
				};
				item.appendChild(installBtn);
			}

			listEl.appendChild(item);
		}
	}

	private async _showPasteDialog(): Promise<void> {
		const overlay = $('div.skill-paste-overlay');
		const dialog = $('div.skill-paste-dialog');

		const title = $('h4');
		title.textContent = 'Paste SKILL.md Content';
		dialog.appendChild(title);

		const textarea = $('textarea.skill-paste-textarea') as HTMLTextAreaElement;
		textarea.placeholder = 'Paste the SKILL.md content here...\n\n---\nname: my-skill\ndescription: ...\n---\nSkill body...';
		dialog.appendChild(textarea);

		const actions = $('div.skill-paste-actions');
		const cancelBtn = $('button');
		cancelBtn.textContent = 'Cancel';
		cancelBtn.onclick = () => overlay.remove();
		actions.appendChild(cancelBtn);

		const installBtn = $('button.primary');
		installBtn.textContent = 'Install';
		installBtn.onclick = async () => {
			const content = textarea.value.trim();
			if (!content) { return; }
			installBtn.textContent = 'Installing...';
			(installBtn as HTMLButtonElement).disabled = true;
			const result = await this.skillInstallService.installFromContent(content);
			if (result.success) {
				overlay.remove();
				this._refreshSkills();
			} else {
				installBtn.textContent = 'Install';
				(installBtn as HTMLButtonElement).disabled = false;
				await this.dialogService.info(
					`Failed to install: ${result.error ?? 'Unknown error'}`,
					'Installation Failed'
				);
			}
		};
		actions.appendChild(installBtn);

		dialog.appendChild(actions);
		overlay.appendChild(dialog);
		this.contentContainer.parentElement?.appendChild(overlay);
	}

	private async _fetchUrlContent(url: string): Promise<string | undefined> {
		try {
			const response = await fetch(url);
			if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
			return await response.text();
		} catch {
			return undefined;
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  TOOLS TAB
	// ══════════════════════════════════════════════════════════════════════════

	private _buildToolsDom(): void {
		const container = this.contentContainer;
		clearNode(container);

		// Header
		const header = $('div.tools-header');
		const title = $('h3.tools-title');
		title.classList.add('integration-section-title');
		title.textContent = '\u{1F527} Built-in Tools';
		header.appendChild(title);

		const refreshBtn = $('button.tools-add-btn');
		refreshBtn.textContent = '\u21BB Refresh';
		refreshBtn.title = 'Reload tools from active provider';
		refreshBtn.onclick = () => { void this._reloadTools(); };
		header.appendChild(refreshBtn);
		container.appendChild(header);

		// Sub-tabs
		const tabs = $('div.tools-tabs');
		const tabDefs = [
			{ id: 'all', label: 'All' },
			{ id: 'builtin', label: 'Built-in' },
			{ id: 'custom', label: 'Custom' },
		];
		for (const tab of tabDefs) {
			const btn = $('button.tools-tab');
			btn.textContent = tab.label;
			if (tab.id === 'all') { btn.classList.add('active'); }
			btn.onclick = () => {
				tabs.querySelectorAll('.tools-tab').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this.toolsActiveTab = tab.id;
				this._renderToolsList();
			};
			tabs.appendChild(btn);
		}
		container.appendChild(tabs);

		// List
		const listContainer = $('div.integration-tools-list');
		listContainer.id = 'integration-tools-list';
		container.appendChild(listContainer);
	}

	private async _reloadTools(): Promise<void> {
		const next: ToolDefinitionUI[] = [];

		try {
			const toolsWithState = await this.agentOSService.listAllToolsWithState('viewer');
			for (const tool of toolsWithState) {
				const cat = categorizeToolCategory(tool.category);
				next.push({
					id: tool.name,
					name: tool.name,
					category: cat,
					description: tool.description ?? '',
					icon: toolCategoryIcon(cat),
					enabled: tool.enabled ?? true,
					provider: (tool as IToolDefinition).source ?? 'unknown',
				});
			}

			if (next.length === 0 && this.toolsRetryCount < this.toolsMaxRetries) {
				this.toolsRetryCount++;
				setTimeout(() => { void this._reloadTools(); }, 2000);
				return;
			}

			if (next.length > 0) {
				this.toolsRetryCount = 0;
			}
		} catch (err) {
			console.error('[IntegrationView] Failed to load tools:', err);
			if (this.toolsRetryCount < this.toolsMaxRetries) {
				this.toolsRetryCount++;
				setTimeout(() => { void this._reloadTools(); }, 2000);
				return;
			}
		}

		this.tools = next;
		this._renderToolsList();
	}

	private _renderToolsList(): void {
		const listEl = this.contentContainer.querySelector('#integration-tools-list') as HTMLElement;
		if (!listEl) { return; }
		clearNode(listEl);

		const filtered = this.toolsActiveTab === 'all'
			? this.tools
			: this.tools.filter(t => t.category === this.toolsActiveTab);

		if (filtered.length === 0) {
			const empty = $('div.tools-empty');
			const p = $('p');
			p.textContent = 'No tools available. Try refreshing to see built-in tools.';
			empty.appendChild(p);
			listEl.appendChild(empty);
			return;
		}

		for (const tool of filtered) {
			const item = $('div.tool-item');
			item.classList.toggle('tool-enabled', tool.enabled);

			const toggleContainer = $('div.tool-toggle');
			const toggle = $('input.tool-toggle-input') as HTMLInputElement;
			toggle.type = 'checkbox';
			toggle.checked = tool.enabled;
			toggle.title = tool.enabled ? 'Disable this tool' : 'Enable this tool';
			toggle.onchange = async () => {
				try {
					if (toggle.checked) {
						await this.agentOSService.enableTool('viewer', tool.id);
					} else {
						await this.agentOSService.disableTool('viewer', tool.id);
					}
					tool.enabled = toggle.checked;
					item.classList.toggle('tool-enabled', tool.enabled);
				} catch (err) {
					console.error('[IntegrationView] Failed to toggle tool:', err);
					toggle.checked = !toggle.checked;
				}
			};
			toggleContainer.appendChild(toggle);
			const toolSlider = $('span.toggle-slider');
			toggleContainer.appendChild(toolSlider);
			item.appendChild(toggleContainer);

			const iconEl = $('span.tool-icon');
			iconEl.textContent = tool.icon;
			item.appendChild(iconEl);

			const info = $('div.tool-info');
			const nameRow = $('div.tool-name-row');
			const nameEl = $('span.tool-name');
			nameEl.textContent = tool.name;
			nameRow.appendChild(nameEl);

			const categoryBadge = $('span.tool-category');
			categoryBadge.textContent = tool.category;
			categoryBadge.classList.add(`cat-${tool.category}`);
			nameRow.appendChild(categoryBadge);
			info.appendChild(nameRow);

			const descEl = $('div.tool-desc');
			descEl.textContent = tool.description;
			info.appendChild(descEl);

			if (tool.provider) {
				const providerEl = $('div.tool-provider');
				providerEl.textContent = `\u{1F4E6} ${tool.provider}`;
				info.appendChild(providerEl);
			}
			item.appendChild(info);

			listEl.appendChild(item);
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  MCP TAB
	// ══════════════════════════════════════════════════════════════════════════

	private _buildMcpDom(): void {
		const container = this.contentContainer;
		clearNode(container);

		// Header
		const header = $('div.mcp-header');
		const title = $('h3.mcp-title');
		title.classList.add('integration-section-title');
		title.textContent = '\u{1F50C} MCP Tools';
		header.appendChild(title);

		const addBtn = $('button.mcp-add-btn');
		addBtn.textContent = '+ Manage Servers';
		addBtn.title = 'Open MCP server management';
		addBtn.onclick = () => {
			const input = McpServerEditorInput.getInstance();
			this.editorService.openEditor(input, { pinned: true });
		};
		header.appendChild(addBtn);
		container.appendChild(header);

		// Content list — shows all MCP tools directly
		const listContainer = $('div.integration-mcp-list');
		listContainer.id = 'integration-mcp-list';
		container.appendChild(listContainer);
	}

	private async _reloadMcp(): Promise<void> {
		try {
			// 1. Fast path: try AgentOSService (tools via McpToolProvider)
			const toolsWithState = await this.agentOSService.listAllToolsWithState('viewer');
			const mcpTools = toolsWithState.filter(t =>
				t.source?.includes?.('mcp') || t.category === 'mcp'
			);

			const serverMap = new Map<string, McpServerUI>();
			const toolList: McpToolUI[] = [];

			for (const tool of mcpTools) {
				const parts = tool.name.split('__');
				const serverId = parts.length >= 2 ? parts[0] : ((tool as any).serverId ?? 'unknown');
				// Skip non-MCP server IDs
				if (IntegrationViewPane._isNonMcpServer(serverId)) { continue; }
				const descMatch = tool.description?.match(/\[via MCP server "([^"]+)"/);
				const serverName = descMatch ? descMatch[1] : serverId;

				if (!serverMap.has(serverId)) {
					serverMap.set(serverId, { id: serverId, name: serverName, status: 'connected' as const, toolCount: 0 });
				}
				serverMap.get(serverId)!.toolCount++;

				toolList.push({ id: tool.name, name: tool.name, description: tool.description ?? '', serverId, serverName, enabled: tool.enabled ?? true });
			}

			// 2. Fallback: always read IMcpService directly regardless of McpToolProvider
			//    This ensures we always have accurate server status (connection state, tool count)
			//    and covers the case where servers are configured but McpToolProvider hasn't propagated.
			{
				const d = autorun(reader => {
					this._mcpServerRefs.clear();
					const servers = (this.mcpService.servers as IObservable<readonly IMcpServer[]>).read(reader);
					const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
					for (const server of servers) {
						const defId = server.definition.id;
						const label = server.definition.label;
						// Skip non-MCP server IDs (e.g. model providers)
						if (IntegrationViewPane._isNonMcpServer(defId)) { continue; }
						// Normalize to the install name (label), not the full definition ID.
						// McpToolProvider uses <sanitize(installName)> as the tool prefix,
						// and _connectedMcpPresetIds also use sanitize(installName).
						// Using sanitize(defId) would produce "mcp_config_xxx_name" which
						// doesn't match the simple prefix → duplicate server entries.
						const normName = sanitize(label);
						const normDefId = sanitize(defId);
						// Prefer the simple name, but check both keys in serverMap
						// in case step 1 (McpToolProvider) uses the full defId prefix.
						const mapKey = serverMap.has(normName) ? normName
							: serverMap.has(normDefId) ? normDefId
							: normName;
						// Store server ref with BOTH possible keys for consistent toggle lookup
						this._mcpServerRefs.set(mapKey, server);
						if (normDefId !== mapKey) {
							this._mcpServerRefs.set(normDefId, server);
						}
						const cacheState = server.cacheState.read(reader);
						const connState = server.connectionState.read(reader);
						const status: 'connected' | 'disconnected' | 'error' =
							connState.state === McpConnectionState.Kind.Running ? 'connected' :
							connState.state === McpConnectionState.Kind.Error ? 'error' : 'disconnected';

						// If McpToolProvider already provided tools for this server, update status only
						if (serverMap.has(mapKey)) {
							serverMap.get(mapKey)!.status = status;
						} else {
							// Server not in McpToolProvider yet — add from IMcpService directly
							serverMap.set(mapKey, { id: mapKey, name: label, status, toolCount: 0 });

							if (cacheState === McpServerCacheState.Live) {
								const rawTools = server.tools.read(reader);
								for (const rawTool of rawTools) {
									const routedName = `${mapKey}__${sanitize(rawTool.definition.name)}`;
									toolList.push({
										id: routedName,
										name: routedName,
										description: rawTool.definition.description
											? `[via MCP server "${label}"] ${rawTool.definition.description}`
											: `MCP tool from "${label}"`,
										serverId: mapKey,
										serverName: label,
										enabled: true,
									});
								}
								serverMap.get(mapKey)!.toolCount = toolList.filter(t => t.serverId === mapKey).length;
							}
						}
					}
				});
				d.dispose();
			}

			// 3. Sync installed server names from management service (for placeholder entries).
			//    Servers are now INSTALLED (not in settings.json's deprecated mcp.servers).
			try {
				const installed = await this.mcpManagementService.getInstalled();
				const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
				for (const s of installed) {
					const normId = sanitize(s.name);
					if (IntegrationViewPane._isNonMcpServer(normId)) { continue; }
					this._connectedMcpPresetIds.add(normId);
					// Cross-check: if serverMap already has an entry under a different
					// (definition-derived) key but with the same install name, skip.
					let alreadyPresent = serverMap.has(normId);
					if (!alreadyPresent) {
						for (const [, entry] of serverMap) {
							if (entry.name === s.name || sanitize(entry.name) === normId) {
								alreadyPresent = true;
								break;
							}
						}
					}
					if (!alreadyPresent) {
						serverMap.set(normId, { id: normId, name: s.name, status: 'disconnected', toolCount: 0 });
					}
				}
			} catch (e) {
				console.warn('[IntegrationView] getInstalled failed:', e);
			}

			// 4. Clear _startingMcpIds for servers that have tools OR are running (prevent stuck spinner)
			for (const serverId of Array.from(this._startingMcpIds)) {
				const srv = serverMap.get(serverId);
				// Clear if: has tools, or server is running (connected/startup finished)
				if (srv && (srv.toolCount > 0 || srv.status === 'connected')) {
					this._startingMcpIds.delete(serverId);
				}
			}

			// 5. Retry: if EventBridge added presets but no tools appeared yet,
			//    poll AgentOSService for a few ticks to let McpToolProvider autorun fire
			if (this._startingMcpIds.size > 0 && toolList.length === 0) {
				for (let attempt = 0; attempt < 5; attempt++) {
					await new Promise(r => setTimeout(r, 300));
					const retryTools = await this.agentOSService.listAllToolsWithState('viewer');
					const retryMcp = retryTools.filter(t =>
						t.source?.includes?.('mcp') || t.category === 'mcp'
					);
					if (retryMcp.length > 0) {
						for (const tool of retryMcp) {
							const parts = tool.name.split('__');
							const serverId = parts.length >= 2 ? parts[0] : ((tool as any).serverId ?? 'unknown');
							if (IntegrationViewPane._isNonMcpServer(serverId)) { continue; }
							const descMatch = tool.description?.match(/\[via MCP server "([^"]+)"/);
							const serverName = descMatch ? descMatch[1] : serverId;
							if (!serverMap.has(serverId)) {
								serverMap.set(serverId, { id: serverId, name: serverName, status: 'connected' as const, toolCount: 0 });
							}
							serverMap.get(serverId)!.toolCount++;
							toolList.push({ id: tool.name, name: tool.name, description: tool.description ?? '', serverId, serverName, enabled: tool.enabled ?? true });
						}
						for (const serverId of Array.from(this._startingMcpIds)) {
							if (serverMap.has(serverId) && serverMap.get(serverId)!.toolCount > 0) {
								this._startingMcpIds.delete(serverId);
							}
						}
						break;
					}
				}
			}

		this.mcpServers = Array.from(serverMap.values());
		this.mcpTools = toolList;

		// 6. Auto-start enabled servers that are not running (fire-and-forget, non-blocking)
		console.log('[MCP-AutoStart] _reloadMcp done. serverMap:', this.mcpServers.map(s => ({
			id: s.id,
			status: s.status,
			toolCount: s.toolCount,
			enabled: this._isMcpServerEnabled(s.id),
			inStarting: this._startingMcpIds.has(s.id),
			hasRef: this._mcpServerRefs.has(s.id),
		})));
		console.log('[MCP-AutoStart] _mcpServerRefs keys:', Array.from(this._mcpServerRefs.keys()));
		for (const srv of this.mcpServers) {
			if (IntegrationViewPane._isNonMcpServer(srv.id)) { continue; }
			const enabled = this._isMcpServerEnabled(srv.id);
			const notRunning = srv.status !== 'connected';
			const notStarting = !this._startingMcpIds.has(srv.id);
			if (enabled && notRunning && notStarting) {
				console.log(`[MCP-AutoStart] -> triggering _autoStartServer("${srv.id}")`);
				void this._autoStartServer(srv.id);
			} else {
				console.log(`[MCP-AutoStart] skip "${srv.id}": enabled=${enabled} notRunning=${notRunning} notStarting=${notStarting}`);
			}
		}
	} catch (err) {
		console.warn('[IntegrationView] Failed to load MCP data:', err);
	}
	this._renderMcpContent();
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  MCP PERSISTENCE
	// ══════════════════════════════════════════════════════════════════════════

	private _loadMcpDisabledState(): void {
		try {
			const raw = this.storageService.get(IntegrationViewPane.MCP_DISABLED_STORAGE_KEY, StorageScope.WORKSPACE, '[]');
			const ids: string[] = JSON.parse(raw);
			this._mcpDisabledIds = new Set(ids);
		} catch {
			this._mcpDisabledIds = new Set();
		}
	}

	private _saveMcpDisabledState(): void {
		const ids = Array.from(this._mcpDisabledIds);
		this.storageService.store(
			IntegrationViewPane.MCP_DISABLED_STORAGE_KEY,
			JSON.stringify(ids),
			StorageScope.WORKSPACE,
			StorageTarget.USER
		);
	}

	private _isMcpServerEnabled(serverId: string): boolean {
		return !this._mcpDisabledIds.has(serverId);
	}

	private _setMcpServerEnabled(serverId: string, enabled: boolean): void {
		if (enabled) {
			this._mcpDisabledIds.delete(serverId);
		} else {
			this._mcpDisabledIds.add(serverId);
		}
		this._saveMcpDisabledState();
	}

	/**
	 * Wait for McpToolProvider's autorun to register tools from the given server into AgentOSService.
	 * The propagation chain is:
	 *   server.tools observable → McpToolProvider autorun → _onDidChangeTools → AgentOSService
	 * The autorun fires asynchronously after the observable changes, so we need to poll.
	 */
private async _waitForAgentOSTools(serverRef: IMcpServer, maxWaitMs: number): Promise<boolean> {
	const startTime = Date.now();
	const defId = serverRef.definition.id;
	const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
	const prefix = sanitize(defId);
	while (Date.now() - startTime < maxWaitMs) {
		const tools = await this.agentOSService.listAllToolsWithState('viewer');
		const mcpTools = tools.filter(t =>
			t.source?.includes?.('mcp') || t.category === 'mcp'
		);
		// Check if any tool belongs to this server (McpToolProvider naming: "prefix__toolName")
		const hasServerTools = mcpTools.some(t => t.name.startsWith(prefix + '__'));
		if (hasServerTools) {
			return true;
		}
		await new Promise(r => setTimeout(r, 200));
	}
	return false;
}

	/**
	 * Fire-and-forget: auto-start a single MCP server.
	 * Runs independently so one stuck server (e.g. waiting for auth) doesn't block others.
	 * Has a 30s timeout to prevent indefinite hanging.
	 * On failure/timeout, marks the server as disabled so it won't auto-start next time.
	 */
	private async _autoStartServer(serverId: string): Promise<void> {
		const ref = this._mcpServerRefs.get(serverId);
		if (!ref) {
			console.warn(`[MCP-AutoStart] NO REF for "${serverId}". Available refs:`, Array.from(this._mcpServerRefs.keys()));
			return;
		}
		console.log(`[MCP-AutoStart] _autoStartServer("${serverId}") ref found: defId=${ref.definition.id} label=${ref.definition.label} connState=${JSON.stringify(ref.connectionState.get())} cacheState=${ref.cacheState.get()}`);

		this._startingMcpIds.add(serverId);
		// Re-render immediately to show spinner
		if (this.tabsRendered.has('mcp')) { this._renderMcpContent(); }

		try {
			const started = await Promise.race([
				(async () => {
					// autoTrustChanges: this server was previously added & enabled by the user,
					// so on app restart we auto-restore it WITHOUT showing a trust dialog.
					// Without this, TrustedOnNonce servers would hang waiting for a trust prompt
					// that the user never sees during background auto-start.
					console.log(`[MCP-AutoStart] "${serverId}" calling startServerAndWaitForLiveTools...`);
					await startServerAndWaitForLiveTools(ref, { promptType: 'all-untrusted', autoTrustChanges: true });
					console.log(`[MCP-AutoStart] "${serverId}" startServerAndWaitForLiveTools RESOLVED. connState=${JSON.stringify(ref.connectionState.get())} cacheState=${ref.cacheState.get()} toolsCount=${ref.tools.get().length}`);
					const propagated = await this._waitForAgentOSTools(ref, 3000);
					console.log(`[MCP-AutoStart] "${serverId}" _waitForAgentOSTools returned ${propagated}`);
					return true;
				})(),
				timeout(30000).then(() => { console.warn(`[MCP-AutoStart] "${serverId}" 30s TIMEOUT branch hit`); return false; }),
			]);

			if (!started) {
				console.warn(`[MCP-AutoStart] Auto-start timed out for ${serverId}, marking as disabled`);
				this._setMcpServerEnabled(serverId, false);
			}
		} catch (err) {
			console.warn(`[MCP-AutoStart] Auto-start FAILED for ${serverId}:`, err);
			// Mark as disabled so it won't retry on next load
			this._setMcpServerEnabled(serverId, false);
		} finally {
			this._startingMcpIds.delete(serverId);
			console.log(`[MCP-AutoStart] "${serverId}" finally: connState=${JSON.stringify(ref.connectionState.get())} cacheState=${ref.cacheState.get()}`);
			// Refresh to show final state
			if (this.tabsRendered.has('mcp')) {
				void this._reloadMcp();
			}
		}
	}

	private _renderMcpContent(): void {
		const listEl = this.contentContainer.querySelector('#integration-mcp-list') as HTMLElement;
		if (!listEl) { return; }
		clearNode(listEl);

		if (this.mcpTools.length === 0 && this.mcpServers.length === 0 && this._connectedMcpPresetIds.size === 0) {
			const empty = $('div.mcp-empty');
			const p = $('p');
			p.append('No MCP tools available. Click ', $('b', undefined, '+ Manage Servers'), ' to add an MCP server.');
			empty.appendChild(p);
			listEl.appendChild(empty);
			return;
		}

		// Build combined list from real tools + mcpServers + placeholder presets
		const byServer = new Map<string, { server: McpServerUI; tools: McpToolUI[] }>();

		// Phase 1: seed all known servers from mcpServers (has runtime status + toolCount)
		for (const srv of this.mcpServers) {
			if (IntegrationViewPane._isNonMcpServer(srv.id)) { continue; }
			byServer.set(srv.id, { server: { ...srv }, tools: [] });
		}

		// Phase 2: add real tools from McpToolProvider / IMcpService fallback
		for (const tool of this.mcpTools) {
			if (!byServer.has(tool.serverId)) {
				const srv = this.mcpServers.find(s => s.id === tool.serverId);
				byServer.set(tool.serverId, {
					server: srv ?? { id: tool.serverId, name: tool.serverName, status: 'connected' as const, toolCount: 0 },
					tools: [],
				});
			}
			byServer.get(tool.serverId)!.tools.push(tool);
		}

		// Phase 3: add placeholder for configured-but-not-yet-discovered presets
		for (const presetId of this._connectedMcpPresetIds) {
			if (!byServer.has(presetId) && !IntegrationViewPane._isNonMcpServer(presetId)) {
				const preset = BUNDLED_MCP_PRESETS.find(p => p.id === presetId);
				if (preset) {
					byServer.set(presetId, {
						server: { id: preset.id, name: preset.name, status: 'disconnected', toolCount: 0 },
						tools: [],
					});
				}
			}
		}

		// Phase 4: sync toolCount/status from mcpServers (runtime truth source)
		for (const srv of this.mcpServers) {
			if (IntegrationViewPane._isNonMcpServer(srv.id)) { continue; }
			const entry = byServer.get(srv.id);
			if (entry) {
				entry.server.status = srv.status;
				if (srv.toolCount > entry.server.toolCount) {
					entry.server.toolCount = srv.toolCount;
				}
			}
		}

		// Phase 5: dedup — merge entries with the same display name (server.name).
		//   Different key sources (tool prefix vs definition ID vs install name) can
		//   produce duplicate entries for the same physical MCP server.
		//   Comparison is case-insensitive and trimmed to handle "filesystem" vs "Filesystem".
		const mergedNames = new Map<string, string>(); // normalized name → canonical key
		const normName = (n: string) => n.trim().toLowerCase();
		for (const [key, group] of byServer) {
			const nn = normName(group.server.name);
			if (mergedNames.has(nn)) {
				const canonKey = mergedNames.get(nn)!;
				const canon = byServer.get(canonKey)!;
				// Prefer the better-cased name
				if (group.server.name[0] === group.server.name[0]?.toUpperCase?.()
					&& canon.server.name[0] === canon.server.name[0]?.toLowerCase?.()) {
					canon.server.name = group.server.name;
				}
				if (group.tools.length > 0) {
					for (const t of group.tools) {
						if (!canon.tools.some(ct => ct.id === t.id)) { canon.tools.push(t); }
					}
				}
				canon.server.toolCount = Math.max(canon.server.toolCount, group.server.toolCount);
				if (group.server.status === 'connected') { canon.server.status = 'connected'; }
				byServer.delete(key);
			} else {
				mergedNames.set(nn, key);
			}
		}

		for (const [, group] of byServer) {
			const groupHeader = $('div.mcp-group-header');
			groupHeader.style.display = 'flex';
			groupHeader.style.alignItems = 'center';
			groupHeader.style.gap = '8px';
			groupHeader.style.padding = '8px 12px';
			groupHeader.style.fontSize = '12px';
			groupHeader.style.fontWeight = '600';
			groupHeader.style.color = 'var(--vscode-descriptionForeground)';
			groupHeader.style.borderBottom = '1px solid var(--vscode-panel-border)';
			groupHeader.style.cursor = 'pointer';

			// Click to open McpDetailEditorPane for this specific MCP server
			groupHeader.onclick = () => {
				const marketId = IntegrationViewPane._resolveMcpMarketId(group.server.id, group.server.name);
				if (marketId) {
					const input = McpDetailEditorInput.getInstance(marketId);
					this.editorService.openEditor(input, { pinned: true });
				} else {
					// Fallback: open the MCP Servers list page if we can't resolve
					this.editorService.openEditor(McpServerEditorInput.getInstance(), { pinned: true });
				}
			};

			const isStarting = this._startingMcpIds.has(group.server.id);
			const isConnected = group.server.status === 'connected' && group.tools.length > 0;
			const hasTools = group.tools.length > 0 || group.server.toolCount > 0;
			const toggleOn = group.server.status === 'connected';
			const serverRef = this._mcpServerRefs.get(group.server.id);

			// Toggle switch — persists enable/disable state to storage
			const isEnabled = this._isMcpServerEnabled(group.server.id);
			const toggleContainer = $('div.tool-toggle');
			toggleContainer.style.flexShrink = '0';
			const toggle = $('input.tool-toggle-input') as HTMLInputElement;
			toggle.type = 'checkbox';
			// Default ON: toggle reflects user intent (enabled/disabled), not runtime connection state
			toggle.checked = isEnabled;
			toggle.disabled = isStarting;
			toggle.title = isEnabled
				? 'MCP server enabled — click to disable'
				: 'MCP server disabled — click to enable';
			toggle.onchange = async (e) => {
				e.stopPropagation();
				if (!serverRef) { return; }
				try {
					if (toggle.checked) {
						toggle.disabled = true;
						this._setMcpServerEnabled(group.server.id, true);
						this._startingMcpIds.add(group.server.id);
						// User explicitly toggled ON → treat as trust intent, skip trust dialog.
						await startServerAndWaitForLiveTools(serverRef, { promptType: 'all-untrusted', autoTrustChanges: true });
						await this._waitForAgentOSTools(serverRef, 5000);
					} else {
						this._setMcpServerEnabled(group.server.id, false);
						await serverRef.stop();
					}
				} catch (err) {
					console.error(`[IntegrationView] MCP server ${group.server.id} toggle failed:`, err);
					toggle.checked = !toggle.checked;
					this._setMcpServerEnabled(group.server.id, !toggle.checked);
				} finally {
					this._startingMcpIds.delete(group.server.id);
					toggle.disabled = false;
					await this._reloadMcp();
				}
			};
			toggleContainer.appendChild(toggle);
			toggleContainer.appendChild($('span.toggle-slider'));
			groupHeader.appendChild(toggleContainer);

			// Left status icon
			if (isConnected) {
				const checkIcon = $('span.mcp-status-icon');
				checkIcon.textContent = '\u2713';
				checkIcon.style.color = 'var(--vscode-testing-iconPassed, #89d185)';
				checkIcon.style.fontWeight = 'bold';
				checkIcon.style.fontSize = '14px';
				checkIcon.style.lineHeight = '1';
				groupHeader.appendChild(checkIcon);
			} else if (isStarting || toggleOn) {
				// Starting or running but waiting for tools → spinner
				const spinner = $('span.mcp-status-spinner');
				spinner.classList.add('mcp-spinner');
				groupHeader.appendChild(spinner);
			} else {
				const statusDot = $('span.mcp-status-dot');
				statusDot.classList.add(`status-${group.server.status}`);
				groupHeader.appendChild(statusDot);
			}

			const serverName = $('span');
			serverName.textContent = group.server.name;
			serverName.style.flex = '1';
			groupHeader.appendChild(serverName);

			// Right side: tool count or spinner
			if (isConnected && hasTools) {
				const countEl = $('span.mcp-group-count');
				countEl.textContent = `${group.tools.length} tool${group.tools.length !== 1 ? 's' : ''}`;
				countEl.style.fontSize = '10px';
				countEl.style.color = 'var(--vscode-testing-iconPassed, #89d185)';
				countEl.style.fontWeight = 'normal';
				groupHeader.appendChild(countEl);
			} else if (isStarting || toggleOn) {
				// Right spinner during loading
				const rs = $('span.mcp-status-spinner');
				rs.classList.add('mcp-spinner');
				groupHeader.appendChild(rs);
			} else {
				const countEl = $('span.mcp-group-count');
				countEl.textContent = '0 tools';
				countEl.style.fontSize = '10px';
				countEl.style.color = 'var(--vscode-descriptionForeground)';
				countEl.style.fontWeight = 'normal';
				groupHeader.appendChild(countEl);
			}

			listEl.appendChild(groupHeader);
		}
	}
}
