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
import { IEventBridgeService } from '../../common/eventBridge.js';
import { IMcpService, IMcpServer, McpConnectionState, McpServerCacheState } from '../../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { startServerAndWaitForLiveTools } from '../../../../../workbench/contrib/mcp/common/mcpTypesUtils.js';
import { IWorkbenchMcpManagementService } from '../../../../../workbench/services/mcp/common/mcpWorkbenchManagementService.js';
import { timeout } from '../../../../../base/common/async.js';
import { BUNDLED_MCP_PRESETS } from '../../common/bundled-tools/bundledMcpPresets.js';
import { McpServerEditorInput } from '../mcpServerEditorInput.js';
import { McpDetailEditorInput } from '../mcpDetailEditorInput.js';
import { CodebaseMemoryDetailEditorInput } from '../codebaseMemoryDetailEditorInput.js';
import { IMarketplaceService, PackageKind } from '../../common/marketplace.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IAuthenticationQueryService } from '../../../../../workbench/services/authentication/common/authenticationQuery.js';
import { IAuthenticationService } from '../../../../../workbench/services/authentication/common/authentication.js';
import { IAgentStudioLogService } from '../agentStudioLogService.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../../common/sarosPaths.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { isMcpSourcedTool, mcpServerIdOf } from '../../common/toolApprovalPolicy.js';
import type { IToolDefinition } from '../../common/providers.js';

// ─── Types ──────────────────────────────────────────────────────────────────

// ★ P3（2026-11-07）：技能页签已下线（技能浏览/安装统一在 dsh 侧 /x/skills/ 与 /x/marketplace/）。
//   只保留 MCP 页签；容器 id / 视图 id / 布局持久化键一个字都不动。
type IntegrationTab = 'mcp';

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



// ─── IntegrationViewPane ─────────────────────────────────────────────────────

/**
 * 统一入口视图 —— 将原本独立的 Skills、Tools、MCP 三个 ActivityBar 入口
 * 合并为一个，页面顶部通过三个页签切换。
 */
export class IntegrationViewPane extends ViewPane {

	// ── Tab state ──────────────────────────────────────────────────
	private activeTab: IntegrationTab = 'mcp';
	private tabBar!: HTMLElement;
	private contentContainer!: HTMLElement;

	// Track whether tabs have been rendered at least once (lazy init)
	private tabsRendered: Set<IntegrationTab> = new Set();

	// ── MCP state ─────────────────────────────────────────────────
	private mcpTools: McpToolUI[] = [];
	private mcpServers: McpServerUI[] = [];
	/** Preset IDs currently being started (from EventBridge 'add' event, cleared when tools appear) */
	private _startingMcpIds: Set<string> = new Set();
	/** Server definition ID → IMcpServer instances for start/stop operations */
	private _mcpServerRefs: Map<string, IMcpServer> = new Map();
	/** Server IDs the user manually turned OFF (persisted in storage) */
	private _mcpDisabledIds: Set<string> = new Set();

	// ── Tools/MCP search state ────────────────────────────────────
	private mcpSearchQuery = '';
	private mcpSearchInput!: HTMLInputElement;
	private static readonly MCP_DISABLED_STORAGE_KEY = 'agentStudio.mcpDisabledServers';
	/**
	 * Server definition IDs that are NOT MCP servers (e.g. model providers, built-in collections).
	 * 需要排除新的非 MCP 条目时往这里加；当前为空（原 knot-agui 条目已随插件移除）。
	 */
	private static readonly NON_MCP_SERVER_IDS = new Set<string>();
	/** Check whether a server ID (raw or sanitized) should be excluded */
	private static _isNonMcpServer(id: string): boolean {
		if (IntegrationViewPane.NON_MCP_SERVER_IDS.has(id)) { return true; }
		// Also check sanitized form
		const norm = id.replace(/[^A-Za-z0-9_]/g, '_');
		if (IntegrationViewPane.NON_MCP_SERVER_IDS.has(norm)) { return true; }
		return false;
	}

	/**
	 * 由**工具定义**解析所属 MCP 服务器名（`~/.vssaros/mcp.json` 里的名字）—— **唯一解析点**。
	 *
	 * 单一真源是 `category = mcp:<sanitize(server.definition.id)>`（`mcpServerIdOf`）。
	 * category 里带的是 **definition id** 的 sanitize 形式，与用户可见 server 名不一定
	 * 字面相等（e.g. `mcp_config_usrlocal_tapd` → `tapd`）⇒ 这里按 `sarosServerNames`
	 * 做**后缀匹配**；解析不出返回 `'unknown'`（调用方必须像主分支那样跳过它 ✓）。
	 *
	 * ⚠ **不得改用工具名解析**：工具名来自上游 VS Code 的 `IMcpTool.id`
	 *   （`mcp_<server>_<tool>`，**单**下划线，且 server 名本身可能含下划线），dsh Host
	 *   侧又是另一套 `mcp__<server>__<tool>` ⇒ `split('_')` / `split('__')` 都拆不出
	 *   server。2026-10-12 修的正是重试补偿分支里那处 `split('__')`（恒落 `'unknown'`
	 *   ⇒ UI 多出假服务器、且「启动中」spinner 清不掉）。
	 */
	private static _resolveMcpServerId(tool: IToolDefinition, sarosServerNames: ReadonlySet<string>): string {
		const rawDefId = (mcpServerIdOf(tool) ?? '').toLowerCase();
		if (!rawDefId) { return 'unknown'; }
		for (const name of sarosServerNames) {
			const sanitizedName = name.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
			if (rawDefId.endsWith(sanitizedName)) { return name; }
		}
		return 'unknown';
	}

	/**
	 * Resolve a market ID from a sanitized server ID or display name.
	 * Checks BUNDLED_MCP_PRESETS first; if not found, returns the display name
	 * (or serverId) as the marketId so the detail pane can read from disk.
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

		// Built-in presets: id or sanitized(id)
		for (const preset of BUNDLED_MCP_PRESETS) {
			for (const c of candidates) {
				if (preset.id === c || sanitize(preset.id) === c || preset.name === c || sanitize(preset.name) === c) {
					return preset.id;
				}
			}
		}
		// Fallback: return display name (or serverId) as marketId — detail pane will
		// read from ~/.vssaros/mcp/{marketId}/config.json
		return displayName || serverId;
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
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorService private readonly editorService: IEditorService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@IMcpService private readonly mcpService: IMcpService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@IEventBridgeService private readonly eventBridgeService: IEventBridgeService,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileService private readonly fileService: IFileService,
		@IAgentStudioLogService private readonly logService: ILogService,
		@IAuthenticationQueryService private readonly authenticationQueryService: IAuthenticationQueryService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Listen for MCP server changes from McpServerEditorPane
		this._register(this.eventBridgeService.on('mcp:servers-changed', (event) => {
			const data = event.data;
			if (data?.action === 'add' && data.presetId) {
				if (!IntegrationViewPane._isNonMcpServer(data.presetId)) {
					// Explicitly enable the newly installed MCP server — this clears
					// any stale "disabled" state persisted from a previous failed auto-start.
					const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
					this._setMcpServerEnabled(sanitize(data.presetId), true);
					this._setMcpServerEnabled(data.presetId, true);
				}
			} else if (data?.action === 'remove' && data.serverId) {
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

		// Lazy-render the only tab (MCP)
		this._switchTab('mcp');
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible && this.tabsRendered.has(this.activeTab)) {
			this._renderActiveTab();
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		// The body element (.integration-view) relies on CSS `height:100%`, which
		// does NOT resolve to a definite height inside this pane layout. The view
		// therefore collapses to 0px and `.integration-content` (overflow:hidden)
		// is clipped, leaving the view blank. Pin an explicit pixel height and
		// flex:none so the inner flexbox (tab bar + content) lays out correctly.
		// Mirrors the fix already used in PresetAgentViewPane.layoutBody.
		if (this.element) {
			this.element.style.height = `${height}px`;
			this.element.style.flex = 'none';
		}
		// .integration-content is flex:1 inside the now-definitely-sized body;
		// clear the fragile fixed pixel height so flex fills the remaining space.
		if (this.contentContainer) {
			this.contentContainer.style.height = '';
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
		const tabOrder: IntegrationTab[] = ['mcp'];
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

		// Search bar
		const searchRow = $('div.skills-search-row');
		this.mcpSearchInput = $('input.skills-search-input') as HTMLInputElement;
		this.mcpSearchInput.type = 'text';
		this.mcpSearchInput.placeholder = '\u{1F50D} \u641C\u7D22 MCP...'; // 🔍 搜索 MCP...
		this.mcpSearchInput.oninput = () => {
			this.mcpSearchQuery = this.mcpSearchInput.value.trim().toLowerCase();
			this._renderMcpContent();
		};
		searchRow.appendChild(this.mcpSearchInput);
		const mcpClearBtn = $('button.skills-search-clear-btn');
		mcpClearBtn.textContent = '\u2715';
		mcpClearBtn.title = 'Clear search';
		mcpClearBtn.onclick = () => {
			this.mcpSearchInput.value = '';
			this.mcpSearchQuery = '';
			this._renderMcpContent();
		};
		searchRow.appendChild(mcpClearBtn);
		container.appendChild(searchRow);

		// Content list — shows all MCP tools directly
		const listContainer = $('div.integration-mcp-list');
		listContainer.id = 'integration-mcp-list';
		container.appendChild(listContainer);
	}

	private async _reloadMcp(): Promise<void> {
		try {
			// 0. Build whitelist from ~/.vssaros/mcp.json — only show servers configured there
			const sarosConfig = await this._readSarosMcpConfig();
			const sarosServerNames = new Set<string>();
			if (sarosConfig?.servers) {
				for (const name of Object.keys(sarosConfig.servers)) {
					sarosServerNames.add(name.toLowerCase());
				}
			}
			this.logService.info('[MCP-Debug] saros mcp.json server names:', Array.from(sarosServerNames));
			this.logService.info('[MCP-Debug] _mcpDisabledIds:', Array.from(this._mcpDisabledIds));

			// 1. Fast path: try AgentOSService (tools via McpToolProvider)
			const toolsWithState = await this.agentOSService.listAllToolsWithState('viewer');
			const mcpTools = toolsWithState.filter(t =>
				t.source?.includes?.('mcp') || t.category === 'mcp'
			);

			const serverMap = new Map<string, McpServerUI>();
			const toolList: McpToolUI[] = [];

			for (const tool of mcpTools) {
				// serverId 由 category（`mcp:<sanitize(defId)>`）解析 —— **唯一解析点**见
				// `_resolveMcpServerId`（不要从工具名拆 server，理由见那里的长注释）。
				const serverId = IntegrationViewPane._resolveMcpServerId(tool, sarosServerNames);
				this.logService.info(`[MCP-Debug] tool: name=${tool.name} category=${tool.category} serverId=${serverId}`);
				// Skip non-MCP server IDs and 'unknown' (not a real MCP tool)
				if (IntegrationViewPane._isNonMcpServer(serverId) || serverId === 'unknown') { continue; }
				const descMatch = tool.description?.match(/\[via MCP server "([^"]+)"/);
				const serverName = descMatch ? descMatch[1] : serverId;
				// Only show servers configured in ~/.vssaros/mcp.json
				if (!sarosServerNames.has(serverName.toLowerCase()) && !sarosServerNames.has(serverId.toLowerCase())) { continue; }

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
				this.logService.info('[IntegrationView] IMcpService.servers:', servers.map(s => `${s.definition.label} (id=${s.definition.id})`));
				const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
				for (const server of servers) {
					const defId = server.definition.id;
					const label = server.definition.label;
					this.logService.info(`[MCP-Debug] mcpService server: defId=${defId} label=${label} inWhitelist=${sarosServerNames.has(label.toLowerCase())}`);
					// Skip non-MCP server IDs (e.g. model providers)
					if (IntegrationViewPane._isNonMcpServer(defId)) { continue; }
					// Only show servers configured in ~/.vssaros/mcp.json
					if (!sarosServerNames.has(label.toLowerCase())) { continue; }
						const normName = sanitize(label);
						const normDefId = sanitize(defId);
						const mapKey = serverMap.has(normName) ? normName
							: serverMap.has(normDefId) ? normDefId
							: normName;
						this.logService.info(`[MCP-Debug] mcpService resolved: label=${label} normName=${normName} normDefId=${normDefId} mapKey=${mapKey} cacheState=${server.cacheState.get()} connState=${JSON.stringify(server.connectionState.get())}`);
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
			this.logService.info('[IntegrationView] getInstalled() returned:', installed.map(s => `${s.name} (id=${(s as any).id ?? '?'}, scope=${(s as any).scope ?? '?'})`));
			const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
			for (const s of installed) {
				const normId = sanitize(s.name);
				if (IntegrationViewPane._isNonMcpServer(normId)) { continue; }
				// Only show servers configured in ~/.vssaros/mcp.json
				if (!sarosServerNames.has(s.name.toLowerCase())) { continue; }
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
				this.logService.warn('[IntegrationView] getInstalled failed:', e);
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
					// 判据同主分支（`category` 前缀）—— 原写的是 `t.category === 'mcp'`，
					// 而真值是 `mcp:<server>`（见 `MCP_TOOL_CATEGORY_PREFIX`）⇒ 恒不成立，
					// 实际只靠 `source` 兜着。
					const retryMcp = retryTools.filter(t =>
						t.source?.includes?.('mcp') || isMcpSourcedTool(t)
					);
					if (retryMcp.length > 0) {
						for (const tool of retryMcp) {
							// ★ 2026-10-12 修复：此处原为 `tool.name.split('__')` —— 工具名是
							//   `mcp_<server>_<tool>`（**单**下划线）⇒ 恒不分割 ⇒ 回落
							//   `(tool as any).serverId`（`IToolDefinition` 上没有该字段）
							//   ⇒ 全部判成 'unknown' ⇒ ① mcpServers 里多出一个假服务器条目；
							//   ② 下面清 `_startingMcpIds` 的循环匹配不到真实 id（本该清掉的
							//   "启动中" spinner 继续转）。现与主分支同口径：解析不出就跳过。
							const serverId = IntegrationViewPane._resolveMcpServerId(tool, sarosServerNames);
							if (serverId === 'unknown') { continue; }
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
		this.logService.info('[MCP-AutoStart] _reloadMcp done. serverMap:', this.mcpServers.map(s => ({
			id: s.id,
			name: s.name,
			status: s.status,
			toolCount: s.toolCount,
			enabled: this._isMcpServerEnabled(s.id),
			inStarting: this._startingMcpIds.has(s.id),
			hasRef: this._mcpServerRefs.has(s.id),
		})));
		this.logService.info('[MCP-AutoStart] _mcpServerRefs keys:', Array.from(this._mcpServerRefs.keys()));
		this.logService.info('[MCP-AutoStart] _mcpDisabledIds:', Array.from(this._mcpDisabledIds));
		for (const srv of this.mcpServers) {
			if (IntegrationViewPane._isNonMcpServer(srv.id)) { continue; }
			// Respect the user's explicit enable/disable intent. A disabled server
			// (in _mcpDisabledIds) must NOT be auto-started or force-re-enabled here,
			// otherwise the MCP toggle-off in the UI would be silently reverted.
			const enabled = this._isMcpServerEnabled(srv.id);
			const notRunning = srv.status !== 'connected';
			const notStarting = !this._startingMcpIds.has(srv.id);
			if (enabled && notRunning && notStarting) {
				this.logService.info(`[MCP-AutoStart] -> triggering _autoStartServer("${srv.id}")`);
				void this._autoStartServer(srv.id);
			} else {
				this.logService.info(`[MCP-AutoStart] skip "${srv.id}": enabled=${enabled} notRunning=${notRunning} notStarting=${notStarting}`);
			}
		}
	} catch (err) {
		this.logService.warn('[IntegrationView] Failed to load MCP data:', err);
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

	// ══════════════════════════════════════════════════════════════════════════
	//  ~/.vssaros/mcp.json CONFIG MANAGEMENT (for preset toggle-on-install)
	// ══════════════════════════════════════════════════════════════════════════

	/** Get ~/.vssaros/mcp.json URI. */
	private async _getSarosMcpConfigUri(): Promise<URI> {
		return resolveSarosPath(this._getSarosRoot(), SarosPath.mcpConfig);
	}

	/** Read and parse ~/.vssaros/mcp.json. Returns undefined on error. */
	private async _readSarosMcpConfig(): Promise<{ servers: Record<string, any> } | undefined> {
		try {
			const configUri = await this._getSarosMcpConfigUri();
			const exists = await this.fileService.exists(configUri);
			if (!exists) { return undefined; }
			const content = await this.fileService.readFile(configUri);
			return JSON.parse(content.value.toString());
		} catch (e) {
			this.logService.warn('[IntegrationView] Failed to read ~/.vssaros/mcp.json:', e);
			return undefined;
		}
	}

	/** Write full config object to ~/.vssaros/mcp.json. */
	private async _writeSarosMcpConfig(data: { servers: Record<string, any> }): Promise<void> {
		const configUri = await this._getSarosMcpConfigUri();
		const dirUri = URI.joinPath(configUri, '..');
		try { await this.fileService.createFolder(dirUri); } catch { /* might already exist */ }
		await this.fileService.writeFile(configUri, VSBuffer.fromString(JSON.stringify(data, null, 2)));
	}

	/** Ensure a server name exists in ~/.vssaros/mcp.json whitelist (add if missing). */
	private async _ensureServerInSarosConfig(name: string): Promise<void> {
		const data = await this._readSarosMcpConfig() ?? { servers: {} };
		if (data.servers && (name in data.servers)) { return; } // already present
		data.servers = data.servers ?? Object.create(null);
		data.servers[name] = {};
		await this._writeSarosMcpConfig(data);
		this.logService.info(`[IntegrationView] Ensured "${name}" in ~/.vssaros/mcp.json.`);
	}

	/**
	 * Revoke a disabled MCP server's stored OAuth grant (and, when the account is
	 * only used by this server, its auth session) so that re-enabling it triggers
	 * a fresh re-authentication.
	 *
	 * MCP servers that authenticate via VS Code's authentication service keep their
	 * token session alive across stop/start. Without revoking the grant here, a
	 * toggle OFF → ON cycle would silently reuse the cached token and never show
	 * the auth prompt again. This mirrors the behaviour of the MCP "Disconnect
	 * Account" / "Sign Out" server options.
	 */
	private async _revokeMcpAuth(serverRef: IMcpServer): Promise<void> {
		try {
			const defId = serverRef.definition.id;
			const label = serverRef.definition.label;
			const authQuery = this.authenticationQueryService.mcpServer(defId);
			for (const [providerId, accountName] of authQuery.getAllAccountPreferences()) {
				const accountQuery = this.authenticationQueryService.provider(providerId).account(accountName);
				// Revoke this server's access grant so the next connect re-prompts for auth.
				accountQuery.mcpServer(defId).setAccessAllowed(false, label);
				// If the account is used only by this server, also drop the session for a clean re-login.
				if (accountQuery.entities().getEntityCount().total <= 1) {
					const accounts = await this.authenticationService.getAccounts(providerId);
					const account = accounts.find(a => a.label === accountName);
					if (account) {
						const sessions = await this.authenticationService.getSessions(providerId, undefined, { account });
						for (const s of sessions) {
							await this.authenticationService.removeSession(providerId, s.id);
						}
					}
				}
			}
		} catch (err) {
			this.logService.warn('[IntegrationView] Failed to revoke MCP auth on disable (non-fatal):', err);
		}
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
			this.logService.warn(`[MCP-AutoStart] NO REF for "${serverId}". Available refs:`, Array.from(this._mcpServerRefs.keys()));
			return;
		}
		this.logService.info(`[MCP-AutoStart] _autoStartServer("${serverId}") ref found: defId=${ref.definition.id} label=${ref.definition.label} connState=${JSON.stringify(ref.connectionState.get())} cacheState=${ref.cacheState.get()}`);

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
					this.logService.info(`[MCP-AutoStart] "${serverId}" calling startServerAndWaitForLiveTools...`);
					await startServerAndWaitForLiveTools(ref, { promptType: 'all-untrusted', autoTrustChanges: true });
					this.logService.info(`[MCP-AutoStart] "${serverId}" startServerAndWaitForLiveTools RESOLVED. connState=${JSON.stringify(ref.connectionState.get())} cacheState=${ref.cacheState.get()} toolsCount=${ref.tools.get().length}`);
					const propagated = await this._waitForAgentOSTools(ref, 3000);
					this.logService.info(`[MCP-AutoStart] "${serverId}" _waitForAgentOSTools returned ${propagated}`);
					return true;
				})(),
				timeout(30000).then(() => { this.logService.warn(`[MCP-AutoStart] "${serverId}" 30s TIMEOUT branch hit`); return false; }),
			]);

			if (!started) {
				this.logService.warn(`[MCP-AutoStart] Auto-start timed out for ${serverId}, will retry on next reload`);
			}
		} catch (err) {
			this.logService.warn(`[MCP-AutoStart] Auto-start FAILED for ${serverId}:`, err);
		} finally {
			this._startingMcpIds.delete(serverId);
			this.logService.info(`[MCP-AutoStart] "${serverId}" finally: connState=${JSON.stringify(ref.connectionState.get())} cacheState=${ref.cacheState.get()}`);
			// Update server status in-place to avoid _reloadMcp → auto-start infinite loop.
			// Calling _reloadMcp() here would re-trigger step 6 (auto-start) for this server,
			// causing an endless cycle: _reloadMcp → _autoStartServer → finally → _reloadMcp → ...
			const connState = ref.connectionState.get();
			const isRunning = connState.state === McpConnectionState.Kind.Running;
			const srv = this.mcpServers.find(s => s.id === serverId);
			if (srv) {
				srv.status = isRunning ? 'connected' as const
					: connState.state === McpConnectionState.Kind.Error ? 'error' as const
					: 'disconnected' as const;
				if (isRunning) {
					srv.toolCount = ref.tools.get().length;
				}
			}
			if (this.tabsRendered.has('mcp')) {
				this._renderMcpContent();
			}
		}
	}

	private _renderMcpContent(): void {
		const listEl = this.contentContainer.querySelector('#integration-mcp-list') as HTMLElement;
		if (!listEl) { return; }
		clearNode(listEl);

		if (this.mcpTools.length === 0 && this.mcpServers.length === 0) {
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

		// Apply search filter
		let serverEntries = [...byServer.entries()];
		if (this.mcpSearchQuery) {
			serverEntries = serverEntries.filter(([, group]) =>
				group.server.name.toLowerCase().includes(this.mcpSearchQuery) ||
				group.server.id.toLowerCase().includes(this.mcpSearchQuery)
			);
		}

		for (const [, group] of serverEntries) {
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

			// Click to open detail EditorPane for this specific MCP server
			groupHeader.onclick = () => {
				// Special case: codebase-memory-mcp opens its own custom EditorPane
				// (with install/upgrade/status UI), not the generic McpDetailEditorPane.
				const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
				const sid = sanitize(group.server.id);
				const sname = sanitize(group.server.name);
				if (sid.includes('codebase_memory_mcp') || sname.includes('codebase_memory_mcp') ||
					group.server.name === 'codebase-memory-mcp') {
					const input = CodebaseMemoryDetailEditorInput.getOrCreate();
					this.editorService.openEditor(input, { pinned: true });
					return;
				}
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
			toggleContainer.onclick = (ev) => {
				ev.stopPropagation();
				// toolbarViews.css hides the native checkbox (opacity:0; width:0; height:0)
				// and .toggle-slider covers the container, so clicks never reach the input.
				// We must programmatically toggle and dispatch change.
				toggle.checked = !toggle.checked;
				toggle.dispatchEvent(new Event('change'));
			};
			const toggle = $('input.tool-toggle-input') as HTMLInputElement;
			toggle.type = 'checkbox';
			// Toggle reflects user intent (enabled/disabled) for installed servers
			toggle.checked = isEnabled;
			toggle.disabled = isStarting;
			toggle.title = isEnabled
				? 'MCP server enabled — click to disable'
				: 'MCP server disabled — click to enable';
			toggle.onchange = async (e) => {
				e.stopPropagation();

				try {
					if (toggle.checked) {
						// ── Toggle ON ──
						toggle.disabled = true;
						this._setMcpServerEnabled(group.server.id, true);
						// Ensure the server is in ~/.vssaros/mcp.json whitelist
						// (may have been removed by a previous toggle-OFF before we stopped doing that)
						await this._ensureServerInSarosConfig(group.server.name);
						this._startingMcpIds.add(group.server.id);
						if (this.tabsRendered.has('mcp')) { this._renderMcpContent(); }

						if (serverRef) {
							await startServerAndWaitForLiveTools(serverRef, { promptType: 'all-untrusted', autoTrustChanges: true });
							await this._waitForAgentOSTools(serverRef, 5000);
						} else {
							this.logService.warn(`[IntegrationView] Toggle ON for "${group.server.id}" but no serverRef found.`);
						}
					} else {
						// ── Toggle OFF ──
						// Only stop the server and mark as disabled; keep it in the
						// mcp.json whitelist so the item stays visible in the MCP view
						// and can be re-enabled later.
						this._setMcpServerEnabled(group.server.id, false);
						if (serverRef) {
							try { await serverRef.stop(); } catch { /* ignore */ }
							// Revoke the stored OAuth grant/session for this server so that
							// re-enabling it forces a fresh re-authentication (the cached
							// token would otherwise be silently reused and skip the auth
							// prompt). This mirrors VS Code's "Disconnect Account" action.
							await this._revokeMcpAuth(serverRef);
						}
						this.logService.info(`[IntegrationView] Server "${group.server.id}" disabled (stopped, kept in whitelist).`);
					}
				} catch (err) {
					this.logService.error(`[IntegrationView] MCP server ${group.server.id} toggle failed:`, err);
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

			// Action buttons (hover-visible)
			const mcpActions = this._createActionButtons('mcp', group.server.id, group.server.name, { showUpload: true, showDelete: true });
			groupHeader.appendChild(mcpActions);
			this._attachHoverActions(groupHeader);

			listEl.appendChild(groupHeader);
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  UNIFIED ACTION BUTTONS & HANDLERS
	// ══════════════════════════════════════════════════════════════════════════

	/**
	 * Create a hover-visible action button group for a resource card.
	 * Returns a div with inline-styled buttons that appear on card hover.
	 */
	private _createActionButtons(
		kind: PackageKind,
		id: string,
		name: string,
		opts: { showUpgrade?: boolean; showDownload?: boolean; showUpload?: boolean; showDelete?: boolean }
	): HTMLElement {
		const container = $('div.item-actions');

		const makeBtn = (icon: string, title: string, onClick: () => void, extraClass?: string) => {
			const btn = $('button.act-btn');
			if (extraClass) { btn.classList.add(extraClass); }
			btn.textContent = icon;
			btn.title = title;
			btn.onclick = (e) => { e.stopPropagation(); onClick(); };
			return btn;
		};

		if (opts.showUpgrade) {
			container.appendChild(makeBtn('\u2B06', '\u5347\u7EA7\u5230\u65B0\u7248\u672C', // 升级到新版本
				() => this._handleUpgrade(kind, id), 'upgrade'));
		}
		if (opts.showDownload) {
			container.appendChild(makeBtn('\u2B07', '\u4ECE\u5546\u57CE\u4E0B\u8F7D', // 从商城下载
				() => this._handleDownload(kind, id), 'download'));
		}
		if (opts.showUpload) {
			container.appendChild(makeBtn('\u{1F4E4}', '\u4E0A\u4F20\u5230\u5546\u57CE', // 上传到商城
				() => this._handleUpload(this.activeTab, id), 'upload'));
		}
		if (opts.showDelete) {
			container.appendChild(makeBtn('\u2715', `\u5220\u9664"${name}"`, // 删除
				() => this._handleDelete(this.activeTab, id, name), 'delete'));
		}
		return container;
	}

	/** Attach mouseenter/leave to show/hide action buttons on a card */
	private _attachHoverActions(item: HTMLElement): void {
		// CSS handles hover via .skill-item:hover .item-actions — no JS needed
	}

	// ── Upload handler ─────────────────────────────────────────────

	private async _handleUpload(tab: IntegrationTab, id?: string): Promise<void> {
		const kind = this._tabToKind(tab);
		if (!kind || !id) {
			this.notificationService.info('Please select a specific resource to upload.');
			return;
		}
		if (!this.marketplaceService.isLoggedIn()) {
			this.notificationService.info('Please log in to the marketplace first (Settings > Saros > Marketplace).');
			return;
		}
		// 检查所有权：如果包已在商城存在，验证当前用户是否为所有者
		try {
			const pkg = await this.marketplaceService.getPackage(id);
			const currentUser = this.marketplaceService.getCurrentUser();
			if (pkg.author?.id && currentUser?.id && pkg.author.id !== currentUser.id) {
				this.notificationService.error(`上传失败: 您不是 "${id}" 的所有者，无权上传更新`);
				return;
			}
		} catch {
			// 包不存在 → 首次上传，允许
		}
		try {
			this.notificationService.info(`Uploading ${id} to marketplace...`);
		const result = await this.marketplaceService.publish(id, kind, { changelog: `Upload from VsSaros at ${new Date().toISOString()}` });
		this.notificationService.info(`\u2705 Published ${id} v${result.version} to marketplace.`);
		// ★ P3：技能发布回写 / AutoGit 版本快照已随 IDE 技能页签下线（dsh 侧商城自行管理台账）。
		} catch (err) {
			this.notificationService.error(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── Download handler ───────────────────────────────────────────

	private async _handleDownload(kind: PackageKind, storeId: string): Promise<void> {
		if (!this.marketplaceService.isLoggedIn()) {
			this.notificationService.info('Please log in to the marketplace first.');
			return;
		}
		try {
			// Get latest version from marketplace
			const pkg = await this.marketplaceService.getPackage(storeId);
			if (!pkg || !pkg.latestVersion) {
				this.notificationService.warn(`Package "${storeId}" not found on marketplace.`);
				return;
			}
			this.notificationService.info(`Downloading ${storeId} v${pkg.latestVersion}...`);
			await this.marketplaceService.download(storeId, pkg.latestVersion, kind);
			this.notificationService.info(`\u2705 Installed ${storeId} v${pkg.latestVersion}.`);
			// Refresh current tab
			this._refreshActiveTab();
		} catch (err) {
			this.notificationService.error(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async _handleUpgrade(kind: PackageKind, storeId: string): Promise<void> {
		if (!this.marketplaceService.isLoggedIn()) {
			this.notificationService.info('Please log in to the marketplace first.');
			return;
		}
		try {
			const pkg = await this.marketplaceService.getPackage(storeId);
			if (!pkg || !pkg.latestVersion) {
				this.notificationService.warn(`No marketplace package found for "${storeId}".`);
				return;
			}
			this.notificationService.info(`Upgrading ${storeId} to v${pkg.latestVersion}...`);
			await this.marketplaceService.download(storeId, pkg.latestVersion, kind);
			this.notificationService.info(`\u2705 Upgraded ${storeId} to v${pkg.latestVersion}.`);
			this._refreshActiveTab();
		} catch (err) {
			this.notificationService.error(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── Delete handler ─────────────────────────────────────────────

	private async _handleDelete(tab: IntegrationTab, id: string, name: string): Promise<void> {
		const confirmed = await this.dialogService.confirm({
			message: `Delete "${name}"?`,
			detail: `This will remove the local files for "${id}". Marketplace resources are not affected.`,
			primaryButton: 'Delete',
			type: 'warning',
		});
		if (!confirmed.confirmed) { return; }

		// ★ P3（2026-11-07）：技能删除已迁 dsh 侧「工具 / 技能」页；MCP 是内置预设，
		//   只能通过开关禁用 ⇒ 这里不再有可删资源，给一条可读提示（不是静默 return）。
		this.notificationService.info(`"${name}" 是内置 ${tab} 资源：请用开关禁用，或在 dsh 侧管理。`);
	}

	// ── Helpers ────────────────────────────────────────────────────

	private _tabToKind(tab: IntegrationTab): PackageKind | undefined {
		switch (tab) {
			case 'mcp': return 'mcp';
		}
	}

	private _refreshActiveTab(): void {
		switch (this.activeTab) {
			case 'mcp': void this._reloadMcp(); break;
		}
	}

	private _getSarosRoot(): URI {
		return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
	}
}
