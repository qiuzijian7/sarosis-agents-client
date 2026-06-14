/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
import { IRequestService, asText } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IModelSelectorService } from '../../agentStudio/common/modelSelector.js';
import { IAgentDriverService, AgentTurnStatus } from '../../agentStudio/common/agentDriver.js';
import { IAgentStudioService } from '../../agentStudio/common/agentStudio.js';

/**
 * TDB-AM Memory ViewPane — 在 saros sidebar 中显示 L0/L1/L2/L3 四层记忆。
 *
 * 数据通路：
 *   ViewPane --(HTTP)--> http://127.0.0.1:<tdbam.gatewayPort>/...
 *   - GET  /health                  健康检查（轮询）
 *   - POST /list/conversations      L0 原始消息全量（最近 N 条）
 *   - POST /list/memories           L1/L2/L3 全量（按 type 过滤）
 *
 *   说明：之前用 /search/conversations + /search/memories + query='*' 的方案
 *   不可行。vendor 的 search 端点是 FTS5 关键词检索，buildFtsQuery('*') 会被
 *   token 过滤器丢弃（'*' 不匹配 [\\p{L}\\p{N}_]+），返回 null token 集导致空
 *   结果。面板"展开 layer 看里面有什么"是无 query 的浏览语义，必须走 /list/*。
 *
 * 端口由 IConfigurationService 读取 `tdbam.gatewayPort`（默认 8420），
 * 与 tdb-am-gateway 扩展保持一致。
 */
type LayerId = 'L0' | 'L1' | 'L2' | 'L3';

interface LayerSpec {
	readonly id: LayerId;
	readonly label: string;
	readonly desc: string;
}

/**
 * Normalised list item used by the panel renderer.
 *
 * - `title` is shown bold in the summary line (used by L2/L3 to display
 *   filename, empty for L0 / L1).
 * - `role` is the speaker badge for L0 (`user` / `assistant` / system / ...).
 * - `sessionKey` is shown only when expanded (L0 only).
 * - `content` is the full body, revealed on `<details>` open.
 * - `timestamp` is rendered short-form in the summary prefix (`MM-DD HH:mm:ss`).
 */
interface ListItem {
	readonly id: string;
	readonly title?: string;
	readonly role?: string;
	readonly sessionKey?: string;
	readonly content: string;
	readonly timestamp: string;
}

interface ListResult {
	readonly items: ListItem[];
	readonly total: number;
	readonly note?: string;
}

/**
 * A user-question + assistant-answer pair, the natural unit of a chat L0 dump.
 *
 * Pairing rules (see {@link TdbamViewPane._pairConversationTurns}):
 *  1. Bucket rows by `sessionKey` — turns never cross sessions.
 *  2. Within a session, sort by `timestamp ASC` so user precedes assistant.
 *  3. A turn opens on a user message; subsequent assistant messages (zero,
 *     one, or many) accrue to that turn's answer until the next user message.
 *  4. Consecutive user messages (user re-sends without waiting) each open
 *     their own turn — the previous turn closes with whatever assistant
 *     content has accumulated (possibly empty).
 *  5. Trailing assistant messages with no preceding user (rare: tool-only
 *     turns or system kickoff) form an "answer-only" turn with empty `question`.
 *
 * `timestamp` on the turn is the user message's timestamp (or the first
 * assistant message if it's an answer-only turn). The list is then re-sorted
 * newest-first for display.
 */
interface TurnItem {
	readonly id: string;
	/** Combined user-message text. Empty for answer-only turns. */
	readonly question: string;
	/** Combined assistant-message text. Empty for unanswered (still-pending) turns. */
	readonly answer: string;
	/** ISO timestamp string used for the summary line prefix. */
	readonly timestamp: string;
	/** Session key the turn belongs to (shown in the expanded metadata foot). */
	readonly sessionKey?: string;
	/** True if no assistant reply was found for this user question. */
	readonly unanswered: boolean;
	/** True if assistant message has no preceding user (answer-only). */
	readonly answerOnly: boolean;
	/**
	 * Underlying L0 record_ids that compose this turn (user + all assistant
	 * folded rows + any system/tool rows). Used by the per-row delete button
	 * to remove the whole turn from SQLite.
	 */
	readonly recordIds: readonly string[];
}

interface TurnResult {
	readonly turns: TurnItem[];
	/** Total number of underlying L0 messages (not turns). */
	readonly totalMessages: number;
}

interface RawConversationItem {
	record_id: string;
	session_key?: string;
	session_id?: string;
	role?: string;
	message_text?: string;
	recorded_at?: string;
	timestamp?: number;
}

interface RawConversationListResponse {
	items?: RawConversationItem[];
	results?: string;
	total?: number;
	error?: string;
}

interface RawMemoryItem {
	id: string;
	title?: string;
	subtitle?: string;
	content?: string;
	timestamp?: string;
}

interface RawMemoryListResponse {
	items?: RawMemoryItem[];
	results?: string;
	total?: number;
	type?: string;
	note?: string;
	error?: string;
}

const LAYERS: readonly LayerSpec[] = [
	{ id: 'L0', label: 'L0', desc: 'JSONL append-only event log' },
	{ id: 'L1', label: 'L1', desc: 'Per-session summaries' },
	{ id: 'L2', label: 'L2', desc: 'Cross-session knowledge' },
	{ id: 'L3', label: 'L3', desc: 'Long-term skills & habits' },
];

const HEALTH_POLL_INTERVAL_MS = 5000;
const DEFAULT_GATEWAY_PORT = 8420;
const SEARCH_LIMIT = 20;
/** 对话完成后自动刷新的防抖延迟（ms）。避免同一轮次多次 Done 事件触发多次请求。 */
const AUTO_REFRESH_DEBOUNCE_MS = 800;

type HealthStatus = 'unknown' | 'ok' | 'degraded' | 'disconnected';

interface HealthInfo {
	status: HealthStatus;
	/** 充填在状态栏末尾的诊断文本（错误原因、HTTP code 等）。 */
	detail?: string;
}

export class TdbamViewPane extends ViewPane {

	private _container: HTMLElement | undefined;
	private _statusEl: HTMLElement | undefined;
	private _layerBodies = new Map<LayerId, HTMLElement>();
	private _layerCarets = new Map<LayerId, HTMLElement>();
	private _expandedLayers = new Set<LayerId>();
	private _healthTimer: number | undefined;
	private _disposed = false;
	/** 当前 L0 面板激活的 tab：'agent' 只看当前 Agent，'workspace' 看当前 Workspace 全部 Agent，'all' 看全部 */
	private _l0ActiveTab: 'agent' | 'workspace' | 'all' = 'workspace';
	/** 当前 Workspace 下的 agentId 集合（懒加载缓存）。undefined = 未加载 */
	private _workspaceAgentIds: Set<string> | undefined;
	/** 是否正在加载 workspace agents（避免并发） */
	private _workspaceAgentsLoading: Promise<Set<string>> | undefined;
	/** 当前活跃的 agentId（从 onDidChangeTurnStatus 的 turnId 提取，用于 L0 过滤） */
	private _activeAgentId: string | undefined;
	/** 当前活跃的 Knot agentSessionId（如 "1779700214535-einbd4x"），用于精确匹配 L0 sessionKey 前缀 */
	private _activeAgentSessionId: string | undefined;
	/** L1 重蒸是否正在进行中（跨 tab 切换保持状态） */
	private _l1Reextracting: boolean = false;

	/** 自动刷新防抖 timer */
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
		@IRequestService private readonly _requestService: IRequestService,
		@ILogService private readonly _logService: ILogService,
		@IModelSelectorService private readonly _modelSelectorService: IModelSelectorService,
		@IAgentDriverService private readonly _agentDriverService: IAgentDriverService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		// 监听 Canvas 中 Agent 选中事件（agentId 如 "coder-4fuqqp3"）
		// 这是 L0 过滤最可靠的来源，因为 L0 写入时用的就是 agentId
		this._register(this._agentStudioService.onDidSelectAgent(agentId => {
			if (agentId) {
				this._activeAgentId = agentId;
				// 如果 L0 已展开，立即刷新以展示新 Agent 的对话
				if (this._expandedLayers.has('L0')) {
					const l0Body = this._layerBodies.get('L0');
					if (l0Body) {
						void this._loadLayer('L0', l0Body);
					}
				}
			}
		}));
		// 监听对话轮次完成事件，自动刷新已展开的记忆面板
		// turnId 格式：`${sessionId}::${agentId}` 或 `${agentId}`
		// 从 turnId 提取 agentId，作为 onDidSelectAgent 的补充（agent 执行时更新）
		this._register(this._agentDriverService.onDidChangeTurnStatus(({ status, turnId }) => {
			// 提取 agentId 和 agentSessionId：turnId 可能是 "sessionId::agentId" 或 "agentId"
			const parts = turnId.split('::');
			const agentId = parts.length >= 2 ? parts[parts.length - 1] : parts[0];
			const agentSessionId = parts.length >= 2 ? parts[0] : undefined;
			if (agentId) {
				this._activeAgentId = agentId;
			}
			if (agentSessionId) {
				this._activeAgentSessionId = agentSessionId;
			}
			if (status === AgentTurnStatus.Done && this._expandedLayers.size > 0) {
				this._scheduleAutoRefresh();
			}
		}));
		// 监听 modelSelectorService Agent 切换事件（兜底）
		this._register(this._modelSelectorService.onDidChangeAgent(() => {
			if (this._expandedLayers.has('L0')) {
				const l0Body = this._layerBodies.get('L0');
				if (l0Body) {
					void this._loadLayer('L0', l0Body);
				}
			}
		}));
		// 监听 agents 变更：当前 Workspace 下 agent 列表变了，需要清缓存并刷新
		this._register(this._agentStudioService.onDidChangeAgents(() => {
			this._workspaceAgentIds = undefined;
			this._workspaceAgentsLoading = undefined;
			if (this._l0ActiveTab === 'workspace' && this._expandedLayers.has('L0')) {
				const l0Body = this._layerBodies.get('L0');
				if (l0Body) {
					void this._loadLayer('L0', l0Body);
				}
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('tdbam-view');
		container.style.height = '100%';
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.overflow = 'hidden';
		this._container = container;
		this._render();
		this._startHealthPolling();
	}

	public override dispose(): void {
		this._disposed = true;
		if (this._healthTimer !== undefined) {
			clearInterval(this._healthTimer);
			this._healthTimer = undefined;
		}
		if (this._autoRefreshTimer !== undefined) {
			clearTimeout(this._autoRefreshTimer);
			this._autoRefreshTimer = undefined;
		}
		super.dispose();
	}

	// ============================================================
	// Render
	// ============================================================

	private _render(): void {
		if (!this._container) {
			return;
		}
		clearNode(this._container);
		this._layerBodies.clear();
		this._layerCarets.clear();

		const root = append(this._container, $('div.tdbam-view-root'));
		root.style.padding = '12px';
		root.style.display = 'flex';
		root.style.flexDirection = 'column';
		root.style.gap = '8px';
		root.style.color = 'var(--vscode-foreground)';
		root.style.fontSize = '13px';
		root.style.height = '100%';
		root.style.boxSizing = 'border-box';

		// ── Header (title + layer tabs + refresh) ──
		const header = append(root, $('div.tdbam-header'));
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.gap = '6px';
		header.style.marginBottom = '4px';

		const title = append(header, $('div.tdbam-title'));
		title.textContent = 'TDB-AM';
		title.style.fontWeight = '600';
		title.style.marginRight = '4px';

		// ── Layer tab buttons ──
		const tabGroup = append(header, $('div.tdbam-layer-tabs'));
		tabGroup.style.display = 'flex';
		tabGroup.style.gap = '3px';
		tabGroup.style.flex = '1';

		for (const layer of LAYERS) {
			const btn = append(tabGroup, $('button.tdbam-layer-tab')) as HTMLButtonElement;
			btn.textContent = layer.label;
			btn.title = layer.desc;
			this._styleLayerTabBtn(btn, false);
			this._layerCarets.set(layer.id, btn);
			btn.addEventListener('click', () => {
				void this._toggleLayerTab(layer.id);
			});
		}

		const refreshBtn = append(header, $('button.tdbam-refresh'));
		refreshBtn.textContent = '⟳';
		refreshBtn.title = 'Refresh health status and reload expanded layers';
		this._styleButton(refreshBtn);
		refreshBtn.addEventListener('click', () => {
			void this._refreshAll();
		});

		// ── Layer content area (only one layer visible at a time) ──
		const layerArea = append(root, $('div.tdbam-layer-area'));
		layerArea.style.flex = '1';
		layerArea.style.minHeight = '0';
		layerArea.style.display = 'flex';
		layerArea.style.flexDirection = 'column';
		for (const layer of LAYERS) {
			const body = append(layerArea, $('div.tdbam-layer-body'));
			body.style.display = 'none';
			body.style.fontSize = '11px';
			body.style.flex = '1';
			body.style.minHeight = '0';
			body.style.overflowY = 'auto';
			body.style.padding = '6px';
			body.style.background = 'transparent';
			body.style.border = '1px solid var(--vscode-panel-border, transparent)';
			body.style.borderRadius = '3px';
			this._layerBodies.set(layer.id, body);
		}

		// ── Footer status ──
		this._statusEl = append(root, $('div.tdbam-hint'));
		this._statusEl.style.opacity = '0.7';
		this._statusEl.style.fontSize = '11px';
		this._statusEl.style.marginTop = '4px';
		this._statusEl.textContent = 'Gateway: checking…';

		// 默认展开 L0
		void this._toggleLayerTab('L0');
	}

	private _styleLayerTabBtn(btn: HTMLElement, active: boolean): void {
		btn.style.cursor = 'pointer';
		btn.style.fontSize = '11px';
		btn.style.padding = '2px 8px';
		btn.style.border = active
			? '1px solid var(--vscode-focusBorder, #007fd4)'
			: '1px solid var(--vscode-button-border, transparent)';
		btn.style.borderRadius = '3px';
		btn.style.background = active
			? 'var(--vscode-button-background)'
			: 'var(--vscode-button-secondaryBackground, transparent)';
		btn.style.color = active
			? 'var(--vscode-button-foreground)'
			: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))';
		btn.style.fontWeight = active ? '600' : '400';
		btn.style.opacity = active ? '1' : '0.7';
	}

	private _styleButton(btn: HTMLElement): void {
		btn.style.cursor = 'pointer';
		btn.style.fontSize = '11px';
		btn.style.padding = '2px 8px';
		btn.style.border = '1px solid var(--vscode-button-border, transparent)';
		btn.style.borderRadius = '3px';
		btn.style.background = 'var(--vscode-button-secondaryBackground, var(--vscode-button-background))';
		btn.style.color = 'var(--vscode-button-secondaryForeground, var(--vscode-button-foreground))';
	}

	// ============================================================
	// Layer tab switch
	// ============================================================

	private async _toggleLayerTab(id: LayerId): Promise<void> {
		// 如果点击已激活的 tab，折叠（隐藏内容区）
		if (this._expandedLayers.has(id)) {
			this._expandedLayers.delete(id);
			const body = this._layerBodies.get(id);
			if (body) { body.style.display = 'none'; }
			const btn = this._layerCarets.get(id);
			if (btn) { this._styleLayerTabBtn(btn, false); }
			return;
		}
		// 切换到新 tab：先隐藏其他所有 layer
		for (const [lid, body] of this._layerBodies) {
			body.style.display = 'none';
			this._expandedLayers.delete(lid);
			const btn = this._layerCarets.get(lid);
			if (btn) { this._styleLayerTabBtn(btn, false); }
		}
		// 激活目标 layer
		this._expandedLayers.add(id);
		const activeBody = this._layerBodies.get(id);
		if (activeBody) { activeBody.style.display = 'block'; }
		const activeBtn = this._layerCarets.get(id);
		if (activeBtn) { this._styleLayerTabBtn(activeBtn, true); }
		if (activeBody) {
			// L1 重蒸进行中时，切回 L1 不重新加载（避免重渲染导致按钮状态丢失）
			if (id === 'L1' && this._l1Reextracting) {
				// 仅确保 toolbar 状态正确，不重新拉取数据
				if (activeBody.querySelector('.tdbam-l1-toolbar') === null) {
					// body 已被清空（例如首次打开），需要渲染一个占位 toolbar
					this._renderL1Toolbar(activeBody);
				}
			} else {
				await this._loadLayer(id, activeBody);
			}
		}
	}

	private async _loadLayer(id: LayerId, body: HTMLElement): Promise<void> {
		clearNode(body);
		body.style.fontFamily = '';        // 重置：详情视图不强制 monospace
		body.style.whiteSpace = '';
		body.style.padding = '6px';
		const loading = append(body, $('div.tdbam-loading'));
		loading.textContent = 'Loading…';
		loading.style.opacity = '0.7';
		try {
			if (id === 'L0') {
				const result = await this._fetchConversationTurns();
				if (this._disposed) {
					return;
				}
				clearNode(body);
				this._renderL0WithTabs(body, result);
			} else {
				const result = await this._fetchMemories(id);
				if (this._disposed) {
					return;
				}
				clearNode(body);
				if (id === 'L1') {
					this._renderL1Toolbar(body);
				}
				this._renderItems(body, id, result);
			}
		} catch (err) {
			if (this._disposed) {
				return;
			}
			const detail = this._describeError(err);
			clearNode(body);
			body.style.whiteSpace = 'pre-wrap';
			body.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
			body.textContent = `Failed: ${detail}\nURL: ${this._gatewayBaseUrl()}\n——————\nIf the status bar shows '❌ disconnected', the gateway is not running.\nCheck OutputChannel "TDB-AM Gateway" for the activation error.`;
			this._logService.warn(`[tdbam] load ${id} failed: ${detail}`);
		}
	}

	// ============================================================
	// L0 两层 Tab 视图
	// ============================================================

	/**
	 * 渲染 L0 层的两层 Tab 视图：
	 *  - Tab "当前 Agent"：过滤 session_key 匹配当前选中 Agent 的对话
	 *  - Tab "所有对话"：展示全部对话
	 */
	private _renderL0WithTabs(body: HTMLElement, result: TurnResult): void {
		// 优先用从 turnId 提取的 agentId（写入 L0 时用的 agentId）
		// 兜底用 modelSelectorService.getSelectedAgentId()（Knot Agent ID，可能不匹配）
		const agentId = this._activeAgentId ?? this._modelSelectorService.getSelectedAgentId();
		// agentSessionId 用于精确匹配 L0 sessionKey 前缀（如 "1779700214535-einbd4x"）
		const agentSessionId = this._activeAgentSessionId;

		// ── Tab 栏 ──
		const tabBar = append(body, $('div.tdbam-tab-bar'));
		tabBar.style.display = 'flex';
		tabBar.style.gap = '4px';
		tabBar.style.marginBottom = '8px';
		tabBar.style.borderBottom = '1px solid var(--vscode-panel-border, transparent)';
		tabBar.style.paddingBottom = '4px';

		const tabAgentBtn = append(tabBar, $('button.tdbam-tab'));
		tabAgentBtn.textContent = '当前 Agent';
		tabAgentBtn.title = agentId
			? `只展示 Agent "${agentId}" 的对话`
			: '未选中 Agent，将展示 session_key 为 "agent:*" 的对话';

		const tabWorkspaceBtn = append(tabBar, $('button.tdbam-tab'));
		tabWorkspaceBtn.textContent = '当前 Workspace';
		tabWorkspaceBtn.title = '展示当前 Workspace 下所有 Agent 的对话';

		const tabAllBtn = append(tabBar, $('button.tdbam-tab'));
		tabAllBtn.textContent = '所有对话';
		tabAllBtn.title = '展示所有 Agent 的全部对话记录';

		// 全量拉取按钮（放在 tab 栏右侧）
		const spacer = append(tabBar, $('span'));
		spacer.style.flex = '1';

		const fetchAllBtn = append(tabBar, $('button.tdbam-l0-fetch-all')) as HTMLButtonElement;
		fetchAllBtn.textContent = '⬇ 全量拉取';
		fetchAllBtn.title = '忽略条数限制，拉取所有历史对话（最多 500 条消息）';
		fetchAllBtn.style.cursor = 'pointer';
		fetchAllBtn.style.fontSize = '11px';
		fetchAllBtn.style.padding = '2px 8px';
		fetchAllBtn.style.border = '1px solid var(--vscode-button-border, transparent)';
		fetchAllBtn.style.borderRadius = '3px';
		fetchAllBtn.style.background = 'var(--vscode-button-secondaryBackground, var(--vscode-button-background))';
		fetchAllBtn.style.color = 'var(--vscode-button-secondaryForeground, var(--vscode-button-foreground))';

		// Tab 内容区
		const tabContent = append(body, $('div.tdbam-tab-content'));

		const styleTab = (btn: HTMLElement, active: boolean) => {
			btn.style.cursor = 'pointer';
			btn.style.fontSize = '11px';
			btn.style.padding = '3px 10px';
			btn.style.border = active
				? '1px solid var(--vscode-focusBorder, #007fd4)'
				: '1px solid var(--vscode-button-border, transparent)';
			btn.style.borderRadius = '3px 3px 0 0';
			btn.style.background = active
				? 'var(--vscode-tab-activeBackground, var(--vscode-editor-background))'
				: 'var(--vscode-tab-inactiveBackground, transparent)';
			btn.style.color = active
				? 'var(--vscode-tab-activeForeground, var(--vscode-foreground))'
				: 'var(--vscode-tab-inactiveForeground, var(--vscode-foreground))';
			btn.style.fontWeight = active ? '600' : '400';
			btn.style.opacity = active ? '1' : '0.75';
		};

		const renderWorkspaceTab = (sourceResult: TurnResult) => {
			clearNode(tabContent);
			if (this._workspaceAgentIds) {
				const filteredResult = this._filterTurnsByWorkspace(sourceResult, this._workspaceAgentIds);
				this._renderTurnItems(tabContent, filteredResult);
				return;
			}
			// 懒加载 workspace agents
			const loading = append(tabContent, $('div.tdbam-list-empty'));
			loading.textContent = '加载 Workspace Agent 列表中…';
			loading.style.opacity = '0.6';
			loading.style.fontStyle = 'italic';
			void (async () => {
				try {
					const ids = await this._loadWorkspaceAgentIds();
					if (this._disposed || this._l0ActiveTab !== 'workspace') return;
					clearNode(tabContent);
					const filteredResult = this._filterTurnsByWorkspace(sourceResult, ids);
					this._renderTurnItems(tabContent, filteredResult);
				} catch (err) {
					if (this._disposed) return;
					clearNode(tabContent);
					const errEl = append(tabContent, $('div.tdbam-list-empty'));
					errEl.textContent = `加载 Workspace Agent 列表失败：${this._describeError(err)}`;
					errEl.style.opacity = '0.6';
				}
			})();
		};

		const renderTab = (tab: 'agent' | 'workspace' | 'all') => {
			this._l0ActiveTab = tab;
			styleTab(tabAgentBtn, tab === 'agent');
			styleTab(tabWorkspaceBtn, tab === 'workspace');
			styleTab(tabAllBtn, tab === 'all');
			if (tab === 'agent') {
				clearNode(tabContent);
				// 优先用 agentSessionId 精确匹配（如 "1779700214535-einbd4x:*"）
				// 兜底用 agentId 后缀匹配（如 "*-4fuqqp3:*"）
				const filteredResult = this._filterTurnsByAgent(result, agentId, agentSessionId);
				this._renderTurnItems(tabContent, filteredResult);
			} else if (tab === 'workspace') {
				renderWorkspaceTab(result);
			} else {
				clearNode(tabContent);
				this._renderTurnItems(tabContent, result);
			}
		};

		tabAgentBtn.addEventListener('click', () => renderTab('agent'));
		tabWorkspaceBtn.addEventListener('click', () => renderTab('workspace'));
		tabAllBtn.addEventListener('click', () => renderTab('all'));

		// 全量拉取：不受 SEARCH_LIMIT 限制，重新请求并刷新当前 tab
		fetchAllBtn.addEventListener('click', () => {
			void (async () => {
				const originalText = fetchAllBtn.textContent ?? '';
				fetchAllBtn.disabled = true;
				fetchAllBtn.style.opacity = '0.6';
				fetchAllBtn.textContent = '拉取中…';
				try {
					const fullResult = await this._fetchAllConversationTurns();
					if (!this._disposed) {
						if (this._l0ActiveTab === 'agent') {
							clearNode(tabContent);
							const filteredResult = this._filterTurnsByAgent(fullResult, agentId, agentSessionId);
							this._renderTurnItems(tabContent, filteredResult);
						} else if (this._l0ActiveTab === 'workspace') {
							renderWorkspaceTab(fullResult);
						} else {
							clearNode(tabContent);
							this._renderTurnItems(tabContent, fullResult);
						}
					}
				} catch (err) {
					this._logService.warn(`[tdbam] fetch all conversations failed: ${this._describeError(err)}`);
				} finally {
					fetchAllBtn.disabled = false;
					fetchAllBtn.style.opacity = '1';
					fetchAllBtn.textContent = originalText;
				}
			})();
		});

		// 默认渲染当前激活的 tab
		renderTab(this._l0ActiveTab);
	}

	/**
	 * 按 Agent ID 过滤 TurnResult。
	 *
	 * session_key 实际格式（来自 tdb-am-memory 扩展 deriveSessionKey）：
	 *  - `${agentSessionId}:${sessionId}`  最常见，如 "1779682088105-4fuqqp3:sess_mpkotbsf_b7izzc"
	 *    其中 agentSessionId = `${timestamp}-${agentIdSuffix}`
	 *  - `agent:${agentId}`（无 sessionId 时的兜底格式）
	 *  - `${agentId}:${sessionId}`（agentId 直接作为前缀）
	 *
	 * 匹配规则：sessionKey 的冒号前部分包含 agentId 后缀（-${agentId} 结尾）
	 * 或者直接以 agentId 开头，或者是 agent:agentId 格式。
	 */
	private _filterTurnsByAgent(result: TurnResult, agentId: string | undefined, agentSessionId?: string): TurnResult {
		if (!agentId && !agentSessionId) {
			// 未选中 Agent：展示所有对话（不过滤）
			return result;
		}
		const filtered = result.turns.filter(t => {
			if (!t.sessionKey) return false;
			const colonIdx = t.sessionKey.indexOf(':');
			const prefix = colonIdx >= 0 ? t.sessionKey.slice(0, colonIdx) : t.sessionKey;
			// 优先：agentSessionId 精确匹配前缀（最可靠）
			if (agentSessionId && prefix === agentSessionId) return true;
			// 兜底：agentId 后缀匹配（"timestamp-agentId:sessionId"）
			if (agentId) {
				if (prefix.endsWith(`-${agentId}`)) return true;
				if (prefix === agentId) return true;
				if (t.sessionKey === `agent:${agentId}`) return true;
			}
			return false;
		});
		return { turns: filtered, totalMessages: result.totalMessages };
	}

	/**
	 * 按当前 Workspace 下的 agentId 集合过滤 TurnResult。
	 *
	 * 复用 {@link _filterTurnsByAgent} 的 sessionKey 拆解规则：
	 *  - prefix 形如 "timestamp-agentId" → 取 "-" 之后的后缀与集合比对
	 *  - prefix 直接等于某个 agentId
	 *  - sessionKey 形如 "agent:agentId"
	 *
	 * 集合为空 → 返回空结果（workspace 内尚无 agent，明确没有对话归属于此 workspace）。
	 */
	private _filterTurnsByWorkspace(result: TurnResult, agentIds: Set<string>): TurnResult {
		if (agentIds.size === 0) {
			return { turns: [], totalMessages: result.totalMessages };
		}
		const filtered = result.turns.filter(t => {
			if (!t.sessionKey) return false;
			const colonIdx = t.sessionKey.indexOf(':');
			const prefix = colonIdx >= 0 ? t.sessionKey.slice(0, colonIdx) : t.sessionKey;
			// "agent:${agentId}" 兜底格式
			if (colonIdx >= 0 && prefix === 'agent') {
				const aid = t.sessionKey.slice(colonIdx + 1);
				if (agentIds.has(aid)) return true;
			}
			// prefix 直接等于 agentId
			if (agentIds.has(prefix)) return true;
			// prefix = "timestamp-agentId"，取最后一个 "-" 之后的部分
			const dashIdx = prefix.lastIndexOf('-');
			if (dashIdx >= 0) {
				const suffix = prefix.slice(dashIdx + 1);
				if (agentIds.has(suffix)) return true;
			}
			return false;
		});
		return { turns: filtered, totalMessages: result.totalMessages };
	}

	/**
	 * 懒加载当前 Workspace 下的 agentId 集合，结果缓存到 {@link _workspaceAgentIds}。
	 * 并发调用共享同一个 Promise，避免重复请求 agents.json。
	 */
	private _loadWorkspaceAgentIds(): Promise<Set<string>> {
		if (this._workspaceAgentIds) {
			return Promise.resolve(this._workspaceAgentIds);
		}
		if (this._workspaceAgentsLoading) {
			return this._workspaceAgentsLoading;
		}
		const p = (async () => {
			const agents = await this._agentStudioService.getAgents();
			const ids = new Set<string>();
			for (const agent of agents) {
				if (agent && typeof agent.id === 'string' && agent.id) {
					ids.add(agent.id);
				}
			}
			this._workspaceAgentIds = ids;
			return ids;
		})();
		this._workspaceAgentsLoading = p;
		p.finally(() => {
			if (this._workspaceAgentsLoading === p) {
				this._workspaceAgentsLoading = undefined;
			}
		});
		return p;
	}

	// ============================================================
	// Item rendering — collapsible per-event view
	// ============================================================

	private _renderItems(
		body: HTMLElement,
		layerId: LayerId,
		result: { items: ListItem[]; total: number; note?: string },
	): void {
		// Header line: total + optional note
		const header = append(body, $('div.tdbam-list-header'));
		header.style.fontSize = '11px';
		header.style.opacity = '0.75';
		header.style.marginBottom = '6px';
		header.textContent = `Total: ${result.total}${result.note ? `  Note: ${result.note}` : ''}`;

		if (result.items.length === 0) {
			const empty = append(body, $('div.tdbam-list-empty'));
			empty.textContent = '(empty)';
			empty.style.opacity = '0.5';
			empty.style.fontStyle = 'italic';
			return;
		}

		const list = append(body, $('div.tdbam-list'));
		list.style.display = 'flex';
		list.style.flexDirection = 'column';
		list.style.gap = '4px';

		for (const item of result.items) {
			this._renderItemRow(list, layerId, item);
		}
	}

	/**
	 * Render a single collapsible row.
	 *
	 * Uses native <details>/<summary> — VS Code's electron renderer fully
	 * supports them and they're keyboard-accessible out of the box.
	 */
	private _renderItemRow(parent: HTMLElement, layerId: LayerId, item: ListItem): void {
		const details = append(parent, $('details.tdbam-item')) as HTMLDetailsElement;
		details.style.border = '1px solid var(--vscode-panel-border, transparent)';
		details.style.borderRadius = '3px';
		details.style.background = 'var(--vscode-editor-background)';
		details.style.padding = '4px 6px';
		details.style.position = 'relative';

		// Per-row delete button (currently L1 only — L2/L3 are profile-sync rows
		// and removing them out-of-band would desync the host's profile cache).
		if (layerId === 'L1' && item.id) {
			this._appendDeleteButton(details, {
				title: '删除这条 L1 记忆',
				confirmMessage: '删除这条 L1 记忆？',
				confirmDetail: this._oneLinePreview(item.content, 200),
				onConfirm: () => this._deleteL1Records([item.id]),
				layerId,
			});
		}

		const summary = append(details, $('summary.tdbam-item-summary'));
		summary.style.cursor = 'pointer';
		summary.style.userSelect = 'none';
		summary.style.fontSize = '11px';
		summary.style.lineHeight = '1.4';
		summary.style.outline = 'none';

		// ── Summary line composition ──
		// L0: "[ts] (role) preview..."
		// L1: "[ts] preview..."
		// L2/L3: "filename — preview..."
		const tsBadge = item.timestamp ? this._formatTimestampShort(item.timestamp) : '';
		const roleBadge = item.role ?? '';
		const titlePart = item.title ?? '';

		const previewLine = this._oneLinePreview(item.content, 80);

		const tsSpan = append(summary, $('span.tdbam-ts'));
		tsSpan.textContent = tsBadge ? `[${tsBadge}] ` : '';
		tsSpan.style.opacity = '0.6';
		tsSpan.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';

		if (roleBadge) {
			const roleSpan = append(summary, $('span.tdbam-role'));
			roleSpan.textContent = roleBadge;
			roleSpan.style.padding = '0 4px';
			roleSpan.style.marginRight = '4px';
			roleSpan.style.borderRadius = '2px';
			roleSpan.style.fontSize = '10px';
			roleSpan.style.fontWeight = '600';
			if (roleBadge === 'user') {
				roleSpan.style.background = 'var(--vscode-charts-blue, #3794ff)';
				roleSpan.style.color = '#fff';
			} else if (roleBadge === 'assistant') {
				roleSpan.style.background = 'var(--vscode-charts-green, #3fb950)';
				roleSpan.style.color = '#fff';
			} else {
				roleSpan.style.background = 'var(--vscode-badge-background)';
				roleSpan.style.color = 'var(--vscode-badge-foreground)';
			}
		}

		if (titlePart) {
			const titleSpan = append(summary, $('span.tdbam-title'));
			titleSpan.textContent = `${titlePart} — `;
			titleSpan.style.fontWeight = '500';
		}

		const previewSpan = append(summary, $('span.tdbam-preview'));
		previewSpan.textContent = previewLine;
		previewSpan.style.opacity = '0.85';

		// ── Body (revealed on expand) ──
		const detailBody = append(details, $('div.tdbam-item-body'));
		detailBody.style.marginTop = '6px';
		detailBody.style.paddingTop = '6px';
		detailBody.style.borderTop = '1px dashed var(--vscode-panel-border, transparent)';
		detailBody.style.fontSize = '11px';
		detailBody.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
		detailBody.style.whiteSpace = 'pre-wrap';
		detailBody.style.wordBreak = 'break-word';
		detailBody.style.maxHeight = '400px';
		detailBody.style.overflowY = 'auto';
		detailBody.textContent = this._stripUndefinedLiterals(item.content || '') || '(no content)';

		// Optional metadata foot (sessionKey for L0)
		if (layerId === 'L0' && item.sessionKey) {
			const meta = append(details, $('div.tdbam-item-meta'));
			meta.style.marginTop = '4px';
			meta.style.fontSize = '10px';
			meta.style.opacity = '0.55';
			meta.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
			meta.textContent = `session: ${item.sessionKey}`;
		}
	}

	/**
	 * Strip literal `undefined` runs that may have been written into vendor
	 * SQLite L0/L1 tables by an earlier-buggy chat write path (see the
	 * 7-layer chat-side fix). Old rows on disk still carry the pollution;
	 * cleaning at render time avoids needing a SQLite migration just to
	 * unblock visual inspection.
	 *
	 * Safe to apply unconditionally: `undefined` cannot legitimately appear
	 * as a contiguous run in any user/assistant content for this product.
	 */
	private _stripUndefinedLiterals(s: string): string {
		if (!s || !s.includes('undefined')) {
			return s;
		}
		return s.replace(/(?:undefined)+/g, '');
	}

	// ============================================================
	// Turn rendering — L0 user/assistant paired view
	// ============================================================

	/**
	 * Render the L0 layer body as a list of turn (Q+A) cards.
	 *
	 * Header shows turn count + raw message count so the user can sanity-check
	 * the pairing (e.g. "12 turns from 26 messages" — an odd remainder usually
	 * means there's a still-pending user question or an answer-only turn).
	 */
	private _renderTurnItems(body: HTMLElement, result: TurnResult): void {
		const header = append(body, $('div.tdbam-list-header'));
		header.style.fontSize = '11px';
		header.style.opacity = '0.75';
		header.style.marginBottom = '6px';
		header.textContent = `Turns: ${result.turns.length}  ·  Messages: ${result.totalMessages}`;

		if (result.turns.length === 0) {
			const empty = append(body, $('div.tdbam-list-empty'));
			empty.textContent = '(empty)';
			empty.style.opacity = '0.5';
			empty.style.fontStyle = 'italic';
			return;
		}

		const list = append(body, $('div.tdbam-list'));
		list.style.display = 'flex';
		list.style.flexDirection = 'column';
		list.style.gap = '4px';

		for (const turn of result.turns) {
			this._renderTurnRow(list, turn);
		}
	}

	/**
	 * Render a single Q+A pair as a collapsible card.
	 *
	 * Summary line: `[ts] Q: <user-preview>  →  A: <assistant-preview>`
	 *   - Empty `Q:` for answer-only turns.
	 *   - "(no reply yet)" placeholder for unanswered turns.
	 * Expanded body: stacked Q-block + A-block, each with its own role badge,
	 * monospace content area, and per-section vertical scroll.
	 */
	private _renderTurnRow(parent: HTMLElement, turn: TurnItem): void {
		const details = append(parent, $('details.tdbam-turn')) as HTMLDetailsElement;
		details.style.border = '1px solid var(--vscode-panel-border, transparent)';
		details.style.borderRadius = '3px';
		details.style.background = 'var(--vscode-editor-background)';
		details.style.padding = '4px 6px';
		details.style.position = 'relative';

		// Per-turn delete button — removes ALL underlying L0 record_ids that compose
		// this Q+A pair (user message + folded assistant rows + any system/tool rows).
		if (turn.recordIds.length > 0) {
			const preview = turn.answerOnly
				? this._oneLinePreview(turn.answer, 200)
				: this._oneLinePreview(turn.question, 200);
			this._appendDeleteButton(details, {
				title: `删除此对话（${turn.recordIds.length} 条 L0 记录）`,
				confirmMessage: `删除此对话？将同时移除 ${turn.recordIds.length} 条底层 L0 记录。`,
				confirmDetail: preview,
				onConfirm: () => this._deleteL0Records(turn.recordIds.slice()),
				layerId: 'L0',
			});
		}

		// ── Summary line ──
		const summary = append(details, $('summary.tdbam-turn-summary'));
		summary.style.cursor = 'pointer';
		summary.style.userSelect = 'none';
		summary.style.fontSize = '11px';
		summary.style.lineHeight = '1.5';
		summary.style.outline = 'none';

		const tsBadge = turn.timestamp ? this._formatTimestampShort(turn.timestamp) : '';
		const tsSpan = append(summary, $('span.tdbam-ts'));
		tsSpan.textContent = tsBadge ? `[${tsBadge}] ` : '';
		tsSpan.style.opacity = '0.6';
		tsSpan.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';

		const qPreview = append(summary, $('span.tdbam-q-preview'));
		qPreview.textContent = turn.answerOnly
			? '(no question)'
			: this._oneLinePreview(turn.question, 80);
		qPreview.style.opacity = turn.answerOnly ? '0.5' : '0.9';

		// ── Expanded body: stacked Q + A blocks ──
		const expanded = append(details, $('div.tdbam-turn-body'));
		expanded.style.marginTop = '6px';
		expanded.style.paddingTop = '6px';
		expanded.style.borderTop = '1px dashed var(--vscode-panel-border, transparent)';
		expanded.style.display = 'flex';
		expanded.style.flexDirection = 'column';
		expanded.style.gap = '6px';

		if (!turn.answerOnly) {
			this._renderTurnSection(expanded, 'user', turn.question || '(empty)');
		}
		if (!turn.unanswered) {
			this._renderTurnSection(expanded, 'assistant', turn.answer || '(empty)');
		} else {
			const placeholder = append(expanded, $('div.tdbam-turn-pending'));
			placeholder.textContent = '(no assistant reply yet)';
			placeholder.style.opacity = '0.5';
			placeholder.style.fontStyle = 'italic';
			placeholder.style.fontSize = '11px';
		}

		// Session metadata foot
		if (turn.sessionKey) {
			const meta = append(details, $('div.tdbam-turn-meta'));
			meta.style.marginTop = '4px';
			meta.style.fontSize = '10px';
			meta.style.opacity = '0.55';
			meta.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
			meta.textContent = `session: ${turn.sessionKey}`;
		}
	}

	/**
	 * Render one section (Q or A) inside an expanded turn card.
	 */
	private _renderTurnSection(parent: HTMLElement, role: 'user' | 'assistant', content: string): void {
		const section = append(parent, $('div.tdbam-turn-section'));
		section.style.display = 'flex';
		section.style.flexDirection = 'column';
		section.style.gap = '3px';

		const badge = append(section, $('span.tdbam-turn-role'));
		badge.textContent = role;
		badge.style.alignSelf = 'flex-start';
		badge.style.padding = '0 5px';
		badge.style.borderRadius = '2px';
		badge.style.fontSize = '10px';
		badge.style.fontWeight = '600';
		badge.style.color = '#fff';
		badge.style.background = role === 'user'
			? 'var(--vscode-charts-blue, #3794ff)'
			: 'var(--vscode-charts-green, #3fb950)';

		const contentEl = append(section, $('div.tdbam-turn-content'));
		contentEl.style.fontSize = '11px';
		contentEl.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
		contentEl.style.whiteSpace = 'pre-wrap';
		contentEl.style.wordBreak = 'break-word';
		contentEl.style.maxHeight = '300px';
		contentEl.style.overflowY = 'auto';
		contentEl.style.padding = '4px 6px';
		contentEl.style.background = 'var(--vscode-textCodeBlock-background, transparent)';
		contentEl.style.borderRadius = '2px';
		contentEl.textContent = this._stripUndefinedLiterals(content);
	}

	private _oneLinePreview(s: string | undefined, maxLen: number): string {
		if (!s) return '(no content)';
		const cleaned = this._stripUndefinedLiterals(s);
		const flat = cleaned.replace(/\s+/g, ' ').trim();
		if (flat.length === 0) return '(no content)';
		if (flat.length <= maxLen) return flat;
		return flat.slice(0, maxLen) + '…';
	}

	private _formatTimestampShort(ts: string): string {
		// ISO 8601 → "MM-DD HH:mm:ss" (drop year + millisecond + Z for compactness)
		// If parsing fails, fall back to the raw value.
		try {
			const d = new Date(ts);
			if (Number.isNaN(d.getTime())) return ts;
			const pad = (n: number) => String(n).padStart(2, '0');
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		} catch {
			return ts;
		}
	}

	// ============================================================
	// HTTP — Health
	// ============================================================

	private _startHealthPolling(): void {
		void this._refreshHealth();
		this._healthTimer = setInterval(() => {
			void this._refreshHealth();
		}, HEALTH_POLL_INTERVAL_MS) as unknown as number;
	}

	private async _refreshHealth(): Promise<void> {
		const info = await this._fetchHealth();
		if (this._disposed) {
			return;
		}
		this._renderStatus(info);
	}

	private _renderStatus(info: HealthInfo): void {
		if (!this._statusEl) {
			return;
		}
		const map: Record<HealthStatus, { text: string; color: string }> = {
			unknown: { text: 'Gateway: checking…', color: 'var(--vscode-foreground)' },
			ok: { text: 'Gateway: ✅ ok', color: 'var(--vscode-charts-green, #3fb950)' },
			degraded: { text: 'Gateway: ⚠ degraded (vector store off)', color: 'var(--vscode-charts-yellow, #d29922)' },
			disconnected: { text: 'Gateway: ❌ disconnected', color: 'var(--vscode-charts-red, #f85149)' },
		};
		const { text, color } = map[info.status];
		const suffix = info.detail ? ` — ${info.detail}` : '';
		this._statusEl.textContent = `${text}${suffix}  (${this._gatewayBaseUrl()})`;
		this._statusEl.style.color = color;
		this._statusEl.style.opacity = '0.85';
	}

	private async _fetchHealth(): Promise<HealthInfo> {
		const url = `${this._gatewayBaseUrl()}/health`;
		try {
			const ctx = await this._requestService.request({
				type: 'GET',
				url,
				callSite: 'tdbam.health',
			}, CancellationToken.None);
			const code = ctx.res.statusCode ?? 0;
			const body = await asText(ctx);
			if (code < 200 || code >= 300) {
				return { status: 'disconnected', detail: `HTTP ${code}` };
			}
			if (!body) {
				return { status: 'disconnected', detail: 'empty body' };
			}
			try {
				const parsed = JSON.parse(body) as { status?: string };
				return parsed.status === 'ok' ? { status: 'ok' } : { status: 'degraded', detail: parsed.status ?? 'unknown' };
			} catch {
				return { status: 'disconnected', detail: `bad JSON: ${body.slice(0, 80)}` };
			}
		} catch (err) {
			const detail = this._describeError(err);
			this._logService.warn(`[tdbam] health check failed: ${detail}`);
			return { status: 'disconnected', detail };
		}
	}

	/**
	 * 把 IRequestService 抛出的 error 转为人读文本。
	 * 常见形态：ECONNREFUSED / ETIMEDOUT / Failed to fetch
	 */
	private _describeError(err: unknown): string {
		const msg = err instanceof Error ? err.message : String(err);
		if (/ECONNREFUSED/i.test(msg)) {
			return 'connection refused (gateway not running)';
		}
		if (/ETIMEDOUT/i.test(msg)) {
			return 'timeout';
		}
		if (/Failed to fetch/i.test(msg)) {
			return 'fetch failed (gateway not running?)';
		}
		return msg;
	}

	// ============================================================
	// HTTP — Delete (per-row removal from L0/L1)
	// ============================================================

	/**
	 * Append a 🗑 button to a `<details>` row. The button is absolutely
	 * positioned at the top-right corner so it doesn't disturb the existing
	 * summary layout (which uses inline elements).
	 *
	 * Click flow:
	 *   1. `e.stopPropagation()` so the click doesn't toggle the parent
	 *      `<details>` open/close state.
	 *   2. Confirmation dialog via IDialogService (matches the rest of
	 *      saros' UX — see skillsView.ts for the precedent).
	 *   3. Run the supplied `onConfirm`. On success, hide the row instantly
	 *      (optimistic update) and trigger a layer refresh so totals match.
	 *      On failure, leave the row intact and surface a notification.
	 */
	private _appendDeleteButton(host: HTMLElement, opts: {
		title: string;
		confirmMessage: string;
		confirmDetail?: string;
		onConfirm: () => Promise<{ deleted: number; failed?: readonly string[] }>;
		layerId: LayerId;
	}): void {
		const btn = append(host, $('button.tdbam-row-delete')) as HTMLButtonElement;
		btn.type = 'button';
		btn.textContent = '🗑';
		btn.title = opts.title;
		btn.style.position = 'absolute';
		btn.style.top = '2px';
		btn.style.right = '4px';
		btn.style.padding = '0 6px';
		btn.style.height = '20px';
		btn.style.lineHeight = '18px';
		btn.style.fontSize = '12px';
		btn.style.cursor = 'pointer';
		btn.style.border = '1px solid var(--vscode-panel-border, transparent)';
		btn.style.borderRadius = '3px';
		btn.style.background = 'var(--vscode-editor-background)';
		btn.style.color = 'var(--vscode-foreground)';
		btn.style.opacity = '0.85';
		btn.style.zIndex = '10';
		btn.addEventListener('mouseenter', () => {
			btn.style.opacity = '1';
			btn.style.background = 'var(--vscode-toolbar-hoverBackground, var(--vscode-editor-background))';
			btn.style.borderColor = 'var(--vscode-charts-red, #f85149)';
			btn.style.color = 'var(--vscode-charts-red, #f85149)';
		});
		btn.addEventListener('mouseleave', () => {
			btn.style.opacity = '0.85';
			btn.style.background = 'var(--vscode-editor-background)';
			btn.style.borderColor = 'var(--vscode-panel-border, transparent)';
			btn.style.color = 'var(--vscode-foreground)';
		});

		btn.addEventListener('click', async (e) => {
			e.stopPropagation();
			e.preventDefault();
			if (btn.disabled) return;

			console.log('[tdbam-delete] click', { layerId: opts.layerId, msg: opts.confirmMessage });

			const confirmed = await this._dialogService.confirm({
				type: 'warning',
				message: opts.confirmMessage,
				detail: opts.confirmDetail,
				primaryButton: '删除',
				cancelButton: '取消',
			});
			console.log('[tdbam-delete] confirm result', { confirmed: confirmed.confirmed });
			if (!confirmed.confirmed) return;

			btn.disabled = true;
			btn.style.opacity = '0.6';
			try {
				console.log('[tdbam-delete] calling onConfirm...');
				const result = await opts.onConfirm();
				console.log('[tdbam-delete] onConfirm returned', result);
				if (this._disposed) return;

				if (result.deleted > 0 && (!result.failed || result.failed.length === 0)) {
					// Optimistic UI: hide the row immediately so the user gets
					// instant feedback, then schedule a refresh to reconcile totals.
					host.style.transition = 'opacity 0.15s ease-out';
					host.style.opacity = '0';
					setTimeout(() => {
						if (host.parentElement) host.remove();
					}, 160);
					this._notificationService.notify({
						severity: Severity.Info,
						message: `已删除 ${result.deleted} 条记录`,
					});
					// Refresh after a short delay so totals (header line) catch up.
					setTimeout(() => {
						if (this._disposed) return;
						const layerBody = this._layerBodies.get(opts.layerId);
						if (layerBody && this._expandedLayers.has(opts.layerId)) {
							void this._loadLayer(opts.layerId, layerBody);
						}
					}, 250);
				} else {
					this._notificationService.notify({
						severity: Severity.Warning,
						message: `删除未完全成功：deleted=${result.deleted}, failed=${result.failed?.length ?? 0}`,
					});
					btn.disabled = false;
					btn.style.opacity = '0.4';
				}
			} catch (err) {
				if (this._disposed) return;
				const detail = this._describeError(err);
				console.error('[tdbam-delete] FAILED', err, detail);
				this._logService.warn(`[tdbam] delete failed: ${detail}`);
				this._notificationService.notify({
					severity: Severity.Error,
					message: `删除失败：${detail}`,
				});
				btn.disabled = false;
				btn.style.opacity = '0.4';
			}
		});
	}

	/**
	 * Call gateway POST /delete/conversation with the supplied L0 record_ids.
	 * Returns the same `{ deleted, failed }` shape the gateway responds with.
	 */
	private async _deleteL0Records(recordIds: readonly string[]): Promise<{ deleted: number; failed: readonly string[] }> {
		if (recordIds.length === 0) return { deleted: 0, failed: [] };
		const url = `${this._gatewayBaseUrl()}/delete/conversation`;
		const ctx = await this._requestService.request({
			type: 'POST',
			url,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({ record_ids: recordIds }),
			callSite: 'tdbam.deleteConversation',
		}, CancellationToken.None);
		const code = ctx.res.statusCode ?? 0;
		const body = await asText(ctx);
		if (code < 200 || code >= 300) {
			throw new Error(`HTTP ${code}: ${body?.slice(0, 120) ?? '(empty)'}`);
		}
		const parsed = body ? JSON.parse(body) as { deleted?: number; failed?: string[]; error?: string } : {};
		if (parsed.error) throw new Error(parsed.error);
		return {
			deleted: typeof parsed.deleted === 'number' ? parsed.deleted : 0,
			failed: Array.isArray(parsed.failed) ? parsed.failed : [],
		};
	}

	/**
	 * Call gateway POST /delete/memory with the supplied L1 record_ids.
	 */
	private async _deleteL1Records(recordIds: readonly string[]): Promise<{ deleted: number; failed: readonly string[] }> {
		if (recordIds.length === 0) return { deleted: 0, failed: [] };
		const url = `${this._gatewayBaseUrl()}/delete/memory`;
		const ctx = await this._requestService.request({
			type: 'POST',
			url,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({ type: 'L1', record_ids: recordIds }),
			callSite: 'tdbam.deleteMemory',
		}, CancellationToken.None);
		const code = ctx.res.statusCode ?? 0;
		const body = await asText(ctx);
		if (code < 200 || code >= 300) {
			throw new Error(`HTTP ${code}: ${body?.slice(0, 120) ?? '(empty)'}`);
		}
		const parsed = body ? JSON.parse(body) as { deleted?: number; failed?: string[]; error?: string } : {};
		if (parsed.error) throw new Error(parsed.error);
		return {
			deleted: typeof parsed.deleted === 'number' ? parsed.deleted : 0,
			failed: Array.isArray(parsed.failed) ? parsed.failed : [],
		};
	}

	// ============================================================
	// HTTP — List (query-free dump for inspection panel)
	// ============================================================

	/**
	 * 全量拉取所有对话（不受 SEARCH_LIMIT 限制，limit=500）。
	 * 供"全量拉取"按钮调用，返回所有 turn，不截断。
	 */
	private async _fetchAllConversationTurns(): Promise<TurnResult> {
		const url = `${this._gatewayBaseUrl()}/list/conversations`;
		const ctx = await this._requestService.request({
			type: 'POST',
			url,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({ limit: 500 }),
			callSite: 'tdbam.listAllConversations',
		}, CancellationToken.None);
		const body = await asText(ctx);
		if (!body) {
			return { turns: [], totalMessages: 0 };
		}
		const parsed = JSON.parse(body) as RawConversationListResponse;
		if (parsed.error) {
			throw new Error(parsed.error);
		}
		const rows = parsed.items ?? [];
		const turns = this._pairConversationTurns(rows);
		return { turns, totalMessages: parsed.total ?? rows.length };
	}

	private async _fetchConversationTurns(): Promise<TurnResult> {
		const url = `${this._gatewayBaseUrl()}/list/conversations`;
		// We pull more raw rows than the visible turn limit because pairing
		// reduces the count (~2:1 typical, more if multi-step tool turns).
		// Server caps at 500 anyway; doubling the visible limit is safe.
		const ctx = await this._requestService.request({
			type: 'POST',
			url,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({ limit: SEARCH_LIMIT * 2 }),
			callSite: 'tdbam.listConversations',
		}, CancellationToken.None);
		const body = await asText(ctx);
		if (!body) {
			return { turns: [], totalMessages: 0 };
		}
		const parsed = JSON.parse(body) as RawConversationListResponse;
		if (parsed.error) {
			throw new Error(parsed.error);
		}
		const rows = parsed.items ?? [];
		const turns = this._pairConversationTurns(rows).slice(0, SEARCH_LIMIT);
		return { turns, totalMessages: parsed.total ?? rows.length };
	}

	/**
	 * Group raw L0 rows into user/assistant turn pairs.
	 *
	 * See {@link TurnItem} for the full pairing rule set. Implementation notes:
	 *
	 * - Bucket by `session_key` first so a user message in session A and an
	 *   assistant message in session B can never accidentally pair (they
	 *   would otherwise look adjacent in a global newest-first sort).
	 * - Within a bucket we sort ASCending by epoch-ms `timestamp` so a single
	 *   forward sweep can pair "the next assistant after this user". We
	 *   prefer numeric timestamp over the ISO string to avoid lexicographic
	 *   surprises (timezone offsets, sub-second precision differences).
	 * - System / non-user / non-assistant roles (rare) are folded into the
	 *   currently-open turn's answer if a turn is open, otherwise skipped.
	 *   This keeps the panel visually clean without losing data — the row
	 *   IDs are still listed in the metadata foot for traceability.
	 * - The output is sorted DESC by turn timestamp so the newest turn is
	 *   on top, matching the user's existing expectation from the per-event
	 *   view.
	 */
	private _pairConversationTurns(rows: readonly RawConversationItem[]): TurnItem[] {
		// Bucket by session_key. Rows missing session_key share an empty bucket
		// (legacy data path); they still get paired but cannot be cross-session
		// disambiguated, which is the best we can do with no key.
		const buckets = new Map<string, RawConversationItem[]>();
		for (const row of rows) {
			const key = row.session_key ?? '';
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = [];
				buckets.set(key, bucket);
			}
			bucket.push(row);
		}

		const turns: TurnItem[] = [];

		for (const [sessionKey, bucket] of buckets) {
			// Sort ASC so user → assistant ordering survives the pairing sweep.
			// 相同时间戳时，user 排在 assistant 前面（稳定排序），
			// 因为 /capture 端点用同一时间戳写入 user+assistant 两条记录。
			const roleOrder = (role: string | undefined) => role === 'user' ? 0 : role === 'assistant' ? 1 : 2;
			bucket.sort((a, b) => {
				const tsDiff = (a.timestamp ?? 0) - (b.timestamp ?? 0);
				if (tsDiff !== 0) { return tsDiff; }
				return roleOrder(a.role) - roleOrder(b.role);
			});

			let openUser: RawConversationItem | undefined;
			let answerParts: string[] = [];
			let answerFirstTs: string | undefined;
			let recordIds: string[] = [];

			const closeOpenTurn = () => {
				if (!openUser && answerParts.length === 0) {
					return;
				}
				const question = openUser?.message_text ?? '';
				const answer = answerParts.join('\n\n');
				const ts = openUser?.recorded_at || answerFirstTs || '';
				turns.push({
					id: openUser?.record_id ?? `answer_${ts}_${turns.length}`,
					question,
					answer,
					timestamp: ts,
					sessionKey: sessionKey || undefined,
					unanswered: !!openUser && answerParts.length === 0,
					answerOnly: !openUser && answerParts.length > 0,
					recordIds: recordIds.slice(),
				});
				openUser = undefined;
				answerParts = [];
				answerFirstTs = undefined;
				recordIds = [];
			};

			for (const row of bucket) {
				const role = row.role ?? '';
				if (role === 'user') {
					// New user message — flush whatever was open and start fresh.
					closeOpenTurn();
					openUser = row;
					if (row.record_id) recordIds.push(row.record_id);
				} else if (role === 'assistant') {
					if (!openUser && answerParts.length === 0) {
						// Answer-only turn opener (no preceding user).
						answerFirstTs = row.recorded_at;
					}
					answerParts.push(row.message_text ?? '');
					if (row.record_id) recordIds.push(row.record_id);
				} else {
					// system / tool / other — fold into current answer if any,
					// otherwise drop silently.
					if (openUser || answerParts.length > 0) {
						answerParts.push(`[${role || 'note'}] ${row.message_text ?? ''}`);
						if (row.record_id) recordIds.push(row.record_id);
					}
				}
			}
			closeOpenTurn();
		}

		// Newest-first for display. Use numeric timestamp from the underlying
		// rows where available; fall back to ISO string compare.
		turns.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
		return turns;
	}

	// ============================================================
	// L1 manual re-extraction toolbar
	// ============================================================

	/**
	 * 在 L1 面板顶部渲染一个工具栏：↻ 补写 L1 按钮（从 L0 扫描 memory_extract 标签直接写入，不调 LLM）。
	 */
	private _renderL1Toolbar(body: HTMLElement): void {
		const agentId = this._activeAgentId ?? this._modelSelectorService.getSelectedAgentId();

		const bar = append(body, $('div.tdbam-l1-toolbar'));
		bar.style.display = 'flex';
		bar.style.alignItems = 'center';
		bar.style.gap = '8px';
		bar.style.marginBottom = '8px';
		bar.style.padding = '4px 6px';
		bar.style.borderRadius = '3px';
		bar.style.background = 'var(--vscode-editorWidget-background, transparent)';
		bar.style.border = '1px solid var(--vscode-panel-border, transparent)';
		bar.style.fontSize = '11px';

		const spacer = append(bar, $('span'));
		spacer.style.flex = '1';

		const reextractBtn = append(bar, $('button.tdbam-l1-reextract')) as HTMLButtonElement;
		reextractBtn.textContent = '↻ 补写 L1';
		reextractBtn.title = '从 L0 历史扫描 <memory_extract> 标签，直接补写 L1（不调用 LLM）';
		reextractBtn.style.cursor = 'pointer';
		reextractBtn.style.fontSize = '11px';
		reextractBtn.style.padding = '3px 10px';
		reextractBtn.style.border = '1px solid var(--vscode-button-border, transparent)';
		reextractBtn.style.borderRadius = '3px';
		reextractBtn.style.background = 'var(--vscode-button-secondaryBackground, var(--vscode-button-background))';
		reextractBtn.style.color = 'var(--vscode-button-secondaryForeground, var(--vscode-button-foreground))';

		const status = append(bar, $('span.tdbam-l1-reextract-status'));
		status.style.opacity = '0.7';
		status.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';

		// 恢复进行中的状态（切换 tab 后重新渲染 toolbar 时保持禁用）
		if (this._l1Reextracting) {
			reextractBtn.disabled = true;
			reextractBtn.style.opacity = '0.6';
			reextractBtn.textContent = '补写中…';
			status.textContent = '(补写进行中，请稍候)';
		}

		reextractBtn.addEventListener('click', () => {
			if (this._l1Reextracting) return;
			void this._triggerL1Reextract(agentId, reextractBtn, status);
		});
	}

	/**
	 * 从 L0 历史扫描 <memory_extract> 标签，直接补写 L1（不调 LLM）。
	 *
	 * 调用 /admin/l1/rescan-l0，传入当前 agent 的 sessionKey 过滤（可选）。
	 * gateway 侧遍历 L0 assistant 消息，解析标签后直接写入 L1。
	 */
	private async _triggerL1Reextract(
		agentId: string | undefined,
		btn: HTMLElement,
		status: HTMLElement,
	): Promise<void> {
		this._l1Reextracting = true;
		const originalText = btn.textContent ?? '';
		(btn as HTMLButtonElement).disabled = true;
		btn.style.opacity = '0.6';
		btn.textContent = '扫描中…';
		status.textContent = '';

		const startMs = Date.now();
		try {
			// 若有 agentId，先查出对应的 sessionKey 列表，逐一扫描；否则全量扫描（不传 session_key）
			let targetKeys: (string | undefined)[] = [undefined]; // undefined = 全量

			if (agentId) {
				const listUrl = `${this._gatewayBaseUrl()}/list/conversations`;
				const listCtx = await this._requestService.request({
					type: 'POST',
					url: listUrl,
					headers: { 'Content-Type': 'application/json' },
					data: JSON.stringify({ limit: 500 }),
					callSite: 'tdbam.listConversationsForRescan',
				}, CancellationToken.None);
				const listText = await asText(listCtx);
				const listParsed = listText ? JSON.parse(listText) as { items?: Array<{ session_key?: string }> } : {};
				const allKeys = [...new Set(
					(listParsed.items ?? [])
						.map(r => r.session_key ?? '')
						.filter(k => k.length > 0)
				)];
				const filtered = allKeys.filter(k => {
					const colonIdx = k.indexOf(':');
					const prefix = colonIdx >= 0 ? k.slice(0, colonIdx) : k;
					return prefix.endsWith(`-${agentId}`) || prefix === agentId || k === `agent:${agentId}`;
				});
				if (filtered.length > 0) {
					targetKeys = filtered;
				}
			}

			const rescanUrl = `${this._gatewayBaseUrl()}/admin/l1/rescan-l0`;
			let totalScanned = 0;
			let totalStored = 0;
			let totalSkipped = 0;

			for (let i = 0; i < targetKeys.length; i++) {
				const sessionKey = targetKeys[i];
				btn.textContent = targetKeys.length > 1 ? `扫描中 (${i + 1}/${targetKeys.length})…` : '扫描中…';
				const ctx = await this._requestService.request({
					type: 'POST',
					url: rescanUrl,
					headers: { 'Content-Type': 'application/json' },
					data: JSON.stringify(sessionKey ? { session_key: sessionKey } : {}),
					callSite: 'tdbam.adminL1RescanL0',
				}, CancellationToken.None);
				const text = await asText(ctx);
				const parsed = text ? JSON.parse(text) as {
					scanned?: number;
					stored?: number;
					skipped?: number;
					error?: string;
				} : {};
				if (parsed.error) {
					throw new Error(parsed.error);
				}
				totalScanned += parsed.scanned ?? 0;
				totalStored += parsed.stored ?? 0;
				totalSkipped += parsed.skipped ?? 0;
			}

			const elapsed = Date.now() - startMs;
			status.textContent = `✅ scanned=${totalScanned} stored=${totalStored} skipped=${totalSkipped}, ${elapsed}ms`;

			// 补写完成 → 重置状态，重新拉取 L1 列表
			this._l1Reextracting = false;
			const l1Body = this._layerBodies.get('L1');
			if (l1Body && !this._disposed) {
				await this._loadLayer('L1', l1Body);
			}
		} catch (err) {
			const detail = this._describeError(err);
			status.textContent = `失败: ${detail}`;
			status.style.color = 'var(--vscode-errorForeground, #f48771)';
			this._logService.warn(`[tdbam] L1 rescan-l0 failed: ${detail}`);
		} finally {
			this._l1Reextracting = false;
			(btn as HTMLButtonElement).disabled = false;
			btn.style.opacity = '1';
			btn.textContent = originalText;
		}
	}

	private async _fetchMemories(type: 'L1' | 'L2' | 'L3'): Promise<ListResult> {
		const url = `${this._gatewayBaseUrl()}/list/memories`;
		const ctx = await this._requestService.request({
			type: 'POST',
			url,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({ type, limit: SEARCH_LIMIT }),
			callSite: 'tdbam.listMemories',
		}, CancellationToken.None);
		const body = await asText(ctx);
		if (!body) {
			return { items: [], total: 0 };
		}
		const parsed = JSON.parse(body) as RawMemoryListResponse;
		if (parsed.error) {
			throw new Error(parsed.error);
		}
		const items: ListItem[] = (parsed.items ?? []).map(r => ({
			id: r.id,
			title: r.title ?? '',
			content: r.content ?? '',
			timestamp: r.timestamp ?? '',
		}));
		return { items, total: parsed.total ?? items.length, note: parsed.note };
	}

	// ============================================================
	// Helpers
	// ============================================================

	private _gatewayBaseUrl(): string {
		const port = this.configurationService.getValue<number>('tdbam.gatewayPort') ?? DEFAULT_GATEWAY_PORT;
		return `http://127.0.0.1:${port}`;
	}

	private async _refreshAll(): Promise<void> {
		await this._refreshHealth();
		// 仅重载已展开的 layer，避免对未关注层级浪费请求
		for (const id of this._expandedLayers) {
			const body = this._layerBodies.get(id);
			if (body) {
				await this._loadLayer(id, body);
			}
		}
	}

	/**
	 * 防抖触发自动刷新，避免同一轮次多次 Done 事件重复请求。
	 * 仅刷新已展开的 layer，不做健康检查（不打扰状态栏）。
	 */
	private _scheduleAutoRefresh(): void {
		if (this._autoRefreshTimer !== undefined) {
			clearTimeout(this._autoRefreshTimer);
		}
		this._autoRefreshTimer = setTimeout(() => {
			this._autoRefreshTimer = undefined;
			if (this._disposed) {
				return;
			}
			this._logService.debug('[tdbam] auto-refresh triggered by new conversation turn');
			for (const id of this._expandedLayers) {
				const body = this._layerBodies.get(id);
				if (body) {
					void this._loadLayer(id, body);
				}
			}
		}, AUTO_REFRESH_DEBOUNCE_MS) as unknown as number;
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}
}

