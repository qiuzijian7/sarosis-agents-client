/*---------------------------------------------------------------------------------------------
 *  Session History View — sidebar ViewPane
 *
 *  Displays all Agent Studio chat sessions grouped by agent, with:
 *  - Agent filter dropdown
 *  - Workspace/search filter
 *  - Expandable session items showing user messages (newest first)
 *  - Copy button per message
 *  - Click-to-navigate: jumps to the message in the Agent Studio chat editor
 *--------------------------------------------------------------------------------------------*/

import './media/sessionHistoryView.css';
import * as DOM from '../../../../base/browser/dom.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentChatService, IAgentStudioService, IChatStreamDelta } from '../../../common/agentStudioService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { NativeChatEditorInput } from '../../agentStudio/browser/nativeChatEditorInput.js';
import { NativeChatEditorPane } from '../../agentStudio/browser/nativeChatEditorPane.js';
import { EditorsOrder } from '../../../../workbench/common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { ISelectOptionItem } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { defaultSelectBoxStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { userDataRootFromRoamingHome } from '../../../contrib/agentStudio/common/sarosPaths.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { localize } from '../../../../nls.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { DisposableStore, isDisposable } from '../../../../base/common/lifecycle.js';

const $ = DOM.$;

// ─── Agent color palette (aligned with Task Board agentColors.ts) ──────────
// Deterministic per-agentId color for visual differentiation in the session list.

const AGENT_COLOR_PALETTE = [
	'#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#eab308',
	'#06b6d4', '#a855f7', '#f43f5e', '#84cc16', '#6366f1', '#d946ef',
];

/** djb2 hash → palette index. Same agentId always gets the same color. */
function _getAgentColorIndex(agentId: string): number {
	let hash = 5381;
	for (let i = 0; i < agentId.length; i++) {
		hash = ((hash << 5) + hash) + agentId.charCodeAt(i);
		hash = hash & hash; // force 32-bit
	}
	return Math.abs(hash) % AGENT_COLOR_PALETTE.length;
}

function _getAgentColor(agentId: string): string {
	return AGENT_COLOR_PALETTE[_getAgentColorIndex(agentId)];
}

/**
 * 内联 SVG 小图标（16×16 viewBox + currentColor 填充）。
 *
 * 为什么不用 emoji：`🤖`（agent 徽章）与 `📌`（pin）在窄侧栏会因字体缺字
 * 渲染成**紫色方块**（用户截图实证），且与整体气质不符 ⇒ 2026-09-15 起全部改 SVG。
 */
function _icon(path: string, size = 12): SVGSVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	p.setAttribute('fill', 'currentColor');
	p.setAttribute('d', path);
	svg.appendChild(p);
	return svg;
}

const ICON_PENCIL = 'M11.488 1.65a1.5 1.5 0 0 1 2.122 0l.74.74a1.5 1.5 0 0 1 0 2.122l-1.69 1.69-2.862-2.862l1.69-1.69zM8.92 4.222l2.862 2.862-6.36 6.36-3.39.74a.5.5 0 0 1-.58-.58l.74-3.39 6.728-6.992z';
const ICON_TRASH = 'M6.5 1a.5.5 0 0 0-.5.5V2H3.5a.5.5 0 0 0 0 1H4v10a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 12 13V3h.5a.5.5 0 0 0 0-1H10v-.5a.5.5 0 0 0-.5-.5h-3zM5 3h6v10a.5.5 0 0 1-.5.5h-5A.5.5 0 0 1 5 13V3zm2 2.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5z';
const ICON_PIN = 'M9.5 1a.5.5 0 0 1 .5.5v1l2.4 1.6a.5.5 0 0 1 .22.42V7a.5.5 0 0 1-.5.5H9.6V12a.5.5 0 0 1-1 0V7.5H4.9a.5.5 0 0 1-.5-.5V4.52a.5.5 0 0 1 .22-.42L7 2.5v-1a.5.5 0 0 1 .5-.5h2z';

interface SessionInfo {
	agentId: string;
	agentName: string;
	sessionId: string;
	sessionName: string;
	messageCount: number;
	updatedAt: number;
}

interface UserMessageInfo {
	id: string;
	content: string;
	timestamp: number;
}

interface SessionData {
	info: SessionInfo;
	messages: UserMessageInfo[];
	chatOpen: boolean;
	pinned: boolean;
}

/**
 * 会话运行指示灯状态（2026-09-15 用户需求）。
 *
 * - `running`  → 绿色闪烁（执行中）
 * - `awaiting` → 黄色闪烁（等待用户交互：clarify 提问 / 工具审批 / 确认框）
 * - `done`     → 白色常亮（执行完毕，用户查看后熄灭）
 * - `error`    → 红色常亮（执行报错）
 *
 * 数据源：`IAgentChatService.onDidStreamDelta` 的全局广播（`phase_change` /
 * `ask_user_start` / `tool_approval_request` / `done` / `error` 等），
 * **不新增 agent 内核状态**，纯 UI 侧推导。
 */
type SessionRunPhase = 'running' | 'awaiting' | 'done' | 'error';

export class SessionHistoryViewPane extends ViewPane {

	private container: HTMLElement | undefined;
	private sessionListEl: HTMLElement | undefined;
	private agentSelect: SelectBox | undefined;
	private searchInput: InputBox | undefined;
	private newSessionPanel: HTMLElement | undefined;
	private newSessionPanelDisposables: DisposableStore | undefined;
	private newSessionState: { agentId: string; name: string; busy: boolean } | undefined;
	private agentSelectContainer: HTMLElement | undefined;
	private searchInputContainer: HTMLElement | undefined;

	private allSessions: SessionData[] = [];
	private filteredSessions: SessionData[] = [];
	private currentAgentFilter = '';
	private currentSearchTerm = '';
	private _reloadTimer: any = undefined;

	/**
	 * 抖动修复（2026-09-15）：后台刷新期间暂存列表滚动位置。
	 * 列表是 `clearNode` + 全量重建（无 keyed diff），重建会把 `scrollTop` 归零 ✗
	 * —— 发消息触发后台刷新时，用户若已滚到列表中段会被「弹回顶部」，配合
	 * 清空/回填的高度突变即表现为抖动。重建前后各存/取一次即可消除 ✓。
	 */
	private _pendingScrollTop: number | undefined = undefined;

	/** Pinned session keys (agentId\u0000sessionId), persisted across reloads. */
	private readonly pinnedSessions = new Set<string>();
	/** Manual session ordering (agentId\u0000sessionId, display order), persisted. */
	private sessionOrder: string[] = [];
	private static readonly PINNED_KEY = 'sessionHistoryView.pinnedSessions';
	private static readonly ORDER_KEY = 'sessionHistoryView.sessionOrder';
	/** Pending single-click expand timer — cancelled on double-click so the open-chat action wins. */
	private _pendingExpandTimer: any = undefined;

	/**
	 * 运行指示灯：`sessionKey` → 阶段（**内存态**，重启后重置 —— 它本来就是实时语义）。
	 * 由 `onDidStreamDelta` 驱动，就地更新 DOM（不重建列表，避免抖动）。
	 */
	private readonly _runPhases = new Map<string, SessionRunPhase>();

	/**
	 * 已查看过的会话 key（持久化）：`done` 态且命中此集合 ⇒ 白点熄灭。
	 * 只表达「用户看过这个完成态」，与 `updatedAt` 无关。
	 */
	private readonly _readKeys = new Set<string>();
	private static readonly READ_KEY = 'sessionHistoryView.readSessions';
	/** 已读集合上限（超出淘汰最旧的），避免 storage 无限膨胀。 */
	private static readonly MAX_READ_KEYS = 500;

	/**
	 * 多选：当前被选中的会话 key（`agentId::sessionId`）。
	 *
	 * 语义（2026-09-15 用户需求：item 支持多选 + delete 按钮可删除 session）：
	 * - 普通左键 = 单选（并保留原有的展开/折叠行为）；
	 * - Ctrl/Cmd + 左键 = 切换该项选中态（不触发展开）；
	 * - Shift + 左键 = 从锚点到该项的区间选中（不触发展开）；
	 * - 每项的删除按钮：若该项属于「多选集合」且集合 > 1，则删除整个选中集合，
	 *   否则只删除该项（确认框会写明数量）。
	 */
	private readonly selectedKeys = new Set<string>();
	/** Shift 区间选择的锚点 key。 */
	private _selectionAnchorKey: string | undefined;

	/**
	 * 打开会话聊天时的目标 group 解析器。默认 `undefined` ⇒ 走主窗口 Agent 编辑器区；
	 * 独立聊天窗口里的那份会话侧栏会注入一个解析器，让会话在本窗口内打开。
	 */
	private _openGroupResolver: (() => IEditorGroup | undefined) | undefined;

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
		@ILogService private readonly logService: ILogService,
		@IAgentChatService private readonly chatService: IAgentChatService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._loadPersistedState();
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this.container = DOM.append(parent, $('.session-history-container'));

		// Filter bar
		this._renderFilterBar(this.container);

		// Session list
		this.sessionListEl = DOM.append(this.container, $('.session-history-list'));

		// 点击列表空白处清空多选
		this._register(DOM.addDisposableListener(this.sessionListEl, DOM.EventType.MOUSE_DOWN, (e) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('.session-history-item')) { return; }
			this._clearSelection();
		}));

		// Load sessions
		this._loadSessions();

		// Sync open/closed state when the active editor changes (agent switch, session switch, etc.)
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this._syncOpenState();
		}));

		// 运行指示灯（2026-09-15 用户需求）：订阅全局流式 delta，**就地**更新状态点。
		// ⚠ 必须就地更新：本列表是 clearNode 全量重建（无 keyed diff），若每个 delta
		// 都走一次 `_loadSessions`，长会话期间列表会持续抖动（见 `_pendingScrollTop` 注释）。
		this._register(this.chatService.onDidStreamDelta(e => {
			this._onStreamDelta(e.agentId, e.sessionId, e.delta);
		}));

		// Reload sessions when sessions change in any chat editor (debounced)
		this._register(this.chatService.onDidChangeAgentSessions(() => {
			if (this._reloadTimer) { clearTimeout(this._reloadTimer); }
			this._reloadTimer = setTimeout(() => {
				this._reloadTimer = undefined;
				this.logService.info('[SessionHistoryView] onDidChangeAgentSessions: reloading sessions');
				// 抖动修复（2026-09-15）：这条路径每次发消息都会触发（messageCount 变化）。
				// 必须以 silent 刷新 —— 否则列表被清成 "Loading sessions..." 单行 + 跨帧
				// 回填，用户看到的就是列表高度反复崩塌回弹的「抖动」✗。
				// 同时先暂存滚动位置，供重建后还原（本类是 clearNode 全量重建，无 diff）。
				if (this.sessionListEl) {
					this._pendingScrollTop = this.sessionListEl.scrollTop;
				}
				this._loadSessions({ silent: true });
			}, 300);
		}));
	}

	private _renderFilterBar(parent: HTMLElement): void {
		const filterBar = DOM.append(parent, $('.session-history-filter-bar'));

		// Row 1: search (using VS Code native InputBox)
		const searchRow = DOM.append(filterBar, $('.session-history-filter-row'));
		this.searchInputContainer = DOM.append(searchRow, $('.session-history-filter-search-wrapper'));
		this.searchInput = this._register(new InputBox(this.searchInputContainer, this.contextViewService, {
			placeholder: 'Search messages...',
			ariaLabel: 'Search messages',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this._register(this.searchInput.onDidChange((value) => {
			this.currentSearchTerm = value.toLowerCase();
			this._applyFilters();
		}));
		// Enter 提交搜索：`onDidChange` 只覆盖「输入即筛选」，输入法组合态（IME）
		// 或粘贴后立即回车时值可能尚未同步到 `currentSearchTerm`，此处以当前
		// `inputElement.value` 为准强制重跑一次筛选，并交出焦点让列表刷新可见。
		// ⚠ 必须用 `addDisposableListener`（原生 KeyboardEvent）—— 与下方重命名输入框
		// 同理：`addStandardDisposableListener` 包装出的 `StandardKeyboardEvent` 没有
		// `key` 属性，`e.key` 恒为 undefined 会导致 Enter 判定失效。
		const searchInput = this.searchInput;
		this._register(DOM.addDisposableListener(searchInput.inputElement, DOM.EventType.KEY_DOWN, (e) => {
			if ((e as KeyboardEvent).key !== 'Enter') {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.currentSearchTerm = searchInput.value.toLowerCase();
			this._applyFilters();
			searchInput.inputElement.blur();
		}));

		// Row 2: agent filter (using VS Code native SelectBox)
		const filterRow = DOM.append(filterBar, $('.session-history-filter-row'));
		this.agentSelectContainer = DOM.append(filterRow, $('.session-history-filter-select-container'));
		this.agentSelect = this._register(new SelectBox(
			[{ text: '🤖 All Agents' }],
			0,
			this.contextViewService,
			defaultSelectBoxStyles,
			{ useCustomDrawn: true },
		));
		this.agentSelect.render(this.agentSelectContainer);
		// Maintain a parallel agentId list because ISelectOptionItem only carries `text`
		this._agentOptionIds = [''];
		this._register(this.agentSelect.onDidSelect((selected) => {
			const idx = typeof selected.index === 'number' ? selected.index : 0;
			this.currentAgentFilter = this._agentOptionIds[idx] ?? '';
			this._applyFilters();
		}));

		// Row 3: "New session" toggle button
		const newBtn = DOM.append(filterBar, $<HTMLButtonElement>('button.session-history-new-btn'));
		newBtn.title = localize('newSession', "New session");
		newBtn.textContent = `+ ${localize('newSession', "New session")}`;
		this.newSessionPanel = DOM.append(filterBar, $('.session-history-new-panel'));
		this.newSessionPanel.style.display = 'none';
		this._register(DOM.addDisposableListener(newBtn, DOM.EventType.CLICK, () => {
			void this._toggleNewSessionPanel();
		}));
	}

	private _agentOptionIds: string[] = [''];

	/**
	 * Populate the agent filter dropdown with discovered agent IDs.
	 * Called from _loadSessions after agent discovery.
	 */
	private _updateAgentFilterOptions(agentIds: string[]): void {
		if (!this.agentSelect) { return; }
		const options: ISelectOptionItem[] = [
			{ text: '🤖 All Agents' },
			...agentIds.map(id => ({ text: `🤖 ${id}` })),
		];
		this._agentOptionIds = ['', ...agentIds];

		// Preserve current selection if it's still in the list
		const prevId = this.currentAgentFilter;
		const prevIndex = this._agentOptionIds.indexOf(prevId);
		const selectedIndex = prevIndex >= 0 ? prevIndex : 0;

		this.agentSelect.setOptions(options, selectedIndex);
	}

	private async _loadSessions(options: { silent?: boolean } = {}): Promise<void> {
		try {
			// 抖动修复（2026-09-15）：`silent` 表示这是一次**后台刷新**（发消息/改名等
			// messageCount 变化触发的 onDidChangeAgentSessions）而非首次加载。后台刷新
			// 若照常插入 "Loading sessions..." 占位行，列表会在每次发消息时被清空成
			// 一个 40px 的单行 → 高度崩塌 → 重建 → 高度回弹，表现为「抖动」✗。
			// 首次加载（renderBody）仍显示占位 ✓。
			const isBackgroundRefresh = options.silent === true && !!this.sessionListEl?.firstChild;
			if (this.sessionListEl && !isBackgroundRefresh) {
				DOM.clearNode(this.sessionListEl);
				const loading = DOM.append(this.sessionListEl, $('.session-history-empty'));
				DOM.append(loading, $('.session-history-empty-text')).textContent = 'Loading sessions...';
			}

			// Discover agent IDs by scanning the agents data directory.
			const agentIds = await this._discoverAgentIds();
			this.logService.info(`[SessionHistoryView] _loadSessions: discovered ${agentIds.length} agent IDs: ${agentIds.join(', ')}`);

			// Populate agent filter dropdown
			this._updateAgentFilterOptions(agentIds);

			const sessionDataList: SessionData[] = [];
			let totalCount = 0;

			// Load only session index (fast, no history) to avoid blocking the UI
			// when there are hundreds of sessions. History is lazy-loaded on expand.
			for (const agentId of agentIds) {
				try {
					const sessions = await this.chatService.listAgentSessions(agentId);
					this.logService.info(`[SessionHistoryView] agent ${agentId} has ${sessions.length} sessions`);
					for (const session of sessions) {
						const hasOpenChat = this._findOpenEditorForSession(agentId, session.id) !== null;
						sessionDataList.push({
							info: {
								agentId,
								agentName: agentId,
								sessionId: session.id,
								sessionName: session.name,
								messageCount: session.messageCount,
								updatedAt: typeof session.updatedAt === 'string'
									? new Date(session.updatedAt).getTime()
									: Date.now(),
							},
							messages: [],           // lazy-loaded on expand
							_messagesLoaded: false,  // tracks whether history was fetched
							chatOpen: hasOpenChat,
							pinned: this.pinnedSessions.has(this._sessionKey(agentId, session.id)),
						} as SessionData);
						totalCount++;
					}
				} catch (err) {
					this.logService.warn(`[SessionHistoryView] Failed to list sessions for agent ${agentId}:`, err);
				}
			}

			this.logService.info(`[SessionHistoryView] _loadSessions: total ${totalCount} sessions (history lazy)`);
			sessionDataList.sort((a, b) => this._compareSessions(a, b));
			this.allSessions = sessionDataList;

			// 清掉已消失会话的选中态（删除/归档/换工作区后可能残留）
			const aliveKeys = new Set(sessionDataList.map(s => this._sessionKey(s.info.agentId, s.info.sessionId)));
			for (const key of [...this.selectedKeys]) {
				if (!aliveKeys.has(key)) { this.selectedKeys.delete(key); }
			}
			if (this._selectionAnchorKey && !aliveKeys.has(this._selectionAnchorKey)) {
				this._selectionAnchorKey = undefined;
			}

			// Batch-render to avoid blocking the UI with large session lists
			await this._applyFiltersIncremental({ silent: options.silent });
		} catch (err) {
			this.logService.error('[SessionHistoryView] Failed to load sessions:', err);
			if (this.sessionListEl) {
				DOM.clearNode(this.sessionListEl);
				const errorEl = DOM.append(this.sessionListEl, $('.session-history-empty'));
				DOM.append(errorEl, $('.session-history-empty-text')).textContent = 'Failed to load sessions.';
			}
		}
	}

	/**
	 * Apply filters and render session headers incrementally to avoid
	 * blocking the UI when there are hundreds of sessions.
	 */
	private async _applyFiltersIncremental(options: { silent?: boolean } = {}): Promise<void> {
		const agentFilter = this.currentAgentFilter;
		const searchTerm = this.currentSearchTerm;

		this.filteredSessions = this.allSessions.filter(s => {
			if (agentFilter && s.info.agentId !== agentFilter) { return false; }
			if (searchTerm) {
				const inTitle = s.info.sessionName.toLowerCase().includes(searchTerm);
				if (!inTitle) { return false; }
			}
			return true;
		});

		if (!this.sessionListEl) { return; }

		// 抖动修复（2026-09-15）：后台刷新（发消息等）走**同步整帧重建**并还原滚动位置。
		// 原路径在「清空 → 空容器 → 逐帧 rAF 回填」之间会暴露至少一帧的空列表 +
		// 高度突变，表现为抖动 ✗。后台刷新本就发生在已有内容之上，无需分批让出。
		// 分批让出仅保留给**用户显式操作**（首载/改筛选/搜索）——那些场景列表内容
		// 整体换血，分批可避免长任务卡顿 ✓。
		if (options.silent) {
			const previousScrollTop = this._pendingScrollTop ?? this.sessionListEl.scrollTop;
			this._pendingScrollTop = undefined;
			DOM.clearNode(this.sessionListEl);
			this._renderAllSessionsSync(this.sessionListEl);
			// 同帧内同步还原，浏览器不会绘制中间态 ⇒ 视觉上无跳动 ✓。
			this.sessionListEl.scrollTop = previousScrollTop;
			return;
		}

		DOM.clearNode(this.sessionListEl);

		if (this.filteredSessions.length === 0) {
			const empty = DOM.append(this.sessionListEl, $('.session-history-empty'));
			DOM.append(empty, $('.session-history-empty-icon')).textContent = '💬';
			DOM.append(empty, $('.session-history-empty-text')).textContent = 'No sessions found';
			return;
		}

		// Render in batches: 20 items per frame, yielding to the UI between batches
		const BATCH_SIZE = 20;
		const total = this.filteredSessions.length;

		for (let i = 0; i < total; i += BATCH_SIZE) {
			const chunk = this.filteredSessions.slice(i, i + BATCH_SIZE);
			for (const sessionData of chunk) {
				const item = DOM.append(this.sessionListEl, $('.session-history-item'));
				this._renderSessionItem(item, sessionData);
			}
			// Yield to the UI so the user can scroll/interact during rendering
			if (i + BATCH_SIZE < total) {
				await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			}
		}
	}

	/**
	 * 同步渲染全部会话（含空态），供后台刷新走单帧重建使用。
	 * 与 `_applyFiltersIncremental` 的非静默分支共用同一套渲染逻辑。
	 */
	private _renderAllSessionsSync(container: HTMLElement): void {
		if (this.filteredSessions.length === 0) {
			const empty = DOM.append(container, $('.session-history-empty'));
			DOM.append(empty, $('.session-history-empty-icon')).textContent = '💬';
			DOM.append(empty, $('.session-history-empty-text')).textContent = 'No sessions found';
			return;
		}
		for (const sessionData of this.filteredSessions) {
			const item = DOM.append(container, $('.session-history-item'));
			this._renderSessionItem(item, sessionData);
		}
	}

	/**
	 * Lazy-load chat history for a session when first expanded.
	 * Returns the user messages (newest first), or [] on error.
	 */
	private async _loadSessionHistory(sessionData: SessionData): Promise<UserMessageInfo[]> {
		const { agentId, sessionId } = sessionData.info;

		// Prevent duplicate loads
		if ((sessionData as any)._messagesLoaded) {
			return sessionData.messages;
		}
		(sessionData as any)._messagesLoading = true;

		try {
			const history = await this.chatService.getHistory(agentId, sessionId);
			const userMessages: UserMessageInfo[] = history
				.filter(m => m.role === 'user')
				.map(m => ({
					id: m.id,
					content: m.content,
					timestamp: (typeof m.timestamp === 'string' ? new Date(m.timestamp).getTime() : Date.now()),
				}))
				.sort((a, b) => b.timestamp - a.timestamp);

			sessionData.messages = userMessages;
			(sessionData as any)._messagesLoaded = true;
			(sessionData as any)._messagesLoading = false;

			// 更新已渲染 item 的计数（0 不显示 ⇒ 懒加载后首次出现消息时需**新建**该元素）
			const itemEl = this.sessionListEl?.querySelector(`[data-session-id="${sessionId}"]`)?.closest('.session-history-item');
			if (itemEl) {
				const subRight = itemEl.querySelector('.session-history-sub-right');
				if (subRight) {
					let countEl = subRight.querySelector('.session-history-count') as HTMLElement | null;
					if (userMessages.length > 0 && !countEl) {
						countEl = document.createElement('span');
						countEl.className = 'session-history-count';
						subRight.appendChild(countEl);
					}
					if (countEl) {
						countEl.textContent = String(userMessages.length);
						countEl.title = `${userMessages.length} messages`;
					}
				}
			}

			return userMessages;
		} catch (err) {
			this.logService.warn(`[SessionHistoryView] Failed to load history for session ${sessionId}:`, err);
			(sessionData as any)._messagesLoading = false;
			return [];
		}
	}

	/**
	 * Discover agent IDs by scanning the global chat history directory.
	 * Layout: ~/.vssaros/chat-history/{agentId}/sessions.json
	 */
	private async _discoverAgentIds(): Promise<string[]> {
		const agentIds: string[] = [];

		try {
			// userRoamingDataHome = ~/.vssaros/User/ → up one level = ~/.vssaros/
			const userDataRoot = userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
			const chatHistoryRoot = URI.joinPath(userDataRoot, 'chat-history');
			this.logService.info(`[SessionHistoryView] _discoverAgentIds: scanning ${chatHistoryRoot.fsPath}`);

			if (!(await this.fileService.exists(chatHistoryRoot))) {
				this.logService.info(`[SessionHistoryView] _discoverAgentIds: chat-history dir does not exist: ${chatHistoryRoot.fsPath}`);
				return agentIds;
			}

			const children = await this.fileService.resolve(chatHistoryRoot);
			if (children.children) {
				for (const child of children.children) {
					if (child.isDirectory) {
						const indexUri = URI.joinPath(child.resource, 'sessions.json');
						try {
							if (await this.fileService.exists(indexUri)) {
								agentIds.push(child.name);
							}
						} catch {
							// Directory but no sessions.json — skip
						}
					}
				}
			}
		} catch (err) {
			this.logService.warn('[SessionHistoryView] _discoverAgentIds: failed to scan chat-history dir:', err);
		}

		return agentIds;
	}

	/**
	 * Sync the open/closed state for all sessions by re-scanning open editors.
	 * Called when the active editor changes (agent switch, session switch).
	 * In-place updates the status dots and "open" tags without full re-render.
	 */
	private _syncOpenState(): void {
		if (!this.sessionListEl) { return; }

		const items = this.sessionListEl.querySelectorAll('.session-history-item');
		items.forEach((item) => {
			// ★ 2026-09-15：改用 `data-session-key` 直接反查。原实现靠「标题文本 +
			// agent 徽章文本」匹配 —— item 结构一改（本次重构去掉 🤖 emoji）就失效，
			// 且不同 agent 下同名会话会误配。
			const key = item.getAttribute('data-session-key');
			if (!key) { return; }
			const sessionData = this.allSessions.find(s => this._sessionKey(s.info.agentId, s.info.sessionId) === key);
			if (!sessionData) { return; }

			const nowOpen = this._findOpenEditorForSession(sessionData.info.agentId, sessionData.info.sessionId) !== null;
			sessionData.chatOpen = nowOpen;

			// 「open」标记：行 1 标题右侧的绿色小字
			const titleLine = item.querySelector('.session-history-title-line');
			const openTag = item.querySelector('.session-history-open-tag');
			if (nowOpen && titleLine && !openTag) {
				const tag = document.createElement('span');
				tag.className = 'session-history-open-tag';
				tag.textContent = 'open';
				titleLine.appendChild(tag);
			} else if (!nowOpen && openTag) {
				openTag.remove();
			}

			// 会话已打开 ⇒ 视为「用户已查看」，白点熄灭（用户需求）
			if (nowOpen) { this._readKeys.add(key); }

			this._applyDotState(item as HTMLElement, key, sessionData);
		});
	}

	/**
	 * Start rename mode for a session. Replaces the title span with an inline
	 * input. Enter (or blur) commits the new name; Escape restores the original.
	 */
	private _startRenameSession(sessionData: SessionData, titleEl: HTMLElement, itemEl: HTMLElement): void {
		const { info } = sessionData;

		// Never stack a second editor on top of an in-flight rename.
		const existingInput = itemEl.querySelector<HTMLInputElement>('.session-history-rename-input');
		if (existingInput) {
			existingInput.focus();
			existingInput.select();
			return;
		}

		const original = info.sessionName ?? titleEl.textContent ?? '';

		// Build input
		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'session-history-rename-input';
		input.value = original;
		input.maxLength = 100;
		input.placeholder = 'Session name';

		// Replace the title with the input
		titleEl.replaceWith(input);

		// Capture phase so the mousedown never reaches the item's expand handler.
		const swallowEvent = (e: Event) => e.stopPropagation();
		input.addEventListener('mousedown', swallowEvent, true);
		input.addEventListener('click', swallowEvent, true);

		let finished = false;
		const restoreTitle = (text: string): HTMLSpanElement => {
			const newTitle = document.createElement('span');
			newTitle.className = 'session-history-title';
			newTitle.textContent = text;
			newTitle.title = `${text} — Double-click to rename`;
			DOM.addStandardDisposableListener(newTitle, DOM.EventType.DBLCLICK, (e) => {
				e.stopPropagation();
				this._startRenameSession(sessionData, newTitle, itemEl);
			});
			input.replaceWith(newTitle);
			return newTitle;
		};

		/**
		 * Whether another session already carries this display name.
		 *
		 * 重名在 UI 上是允许的（不阻断重命名），仅在日志中留痕，用于排查
		 * 「用户以为改名失败、其实只是和别的会话同名」这类反馈。
		 */
		const isDuplicateName = (name: string): boolean => {
			return this.allSessions.some((other) =>
				other.info.sessionId !== info.sessionId
				&& other.info.agentId === info.agentId
				&& (other.info.sessionName ?? '') === name
			);
		};

		const finish = async (commit: boolean) => {
			if (finished) { return; }
			finished = true;

			input.removeEventListener('mousedown', swallowEvent, true);
			input.removeEventListener('click', swallowEvent, true);

			const typed = input.value.trim();
			const newName = typed || original;
			// Escape (or an emptied box) reverts the displayed title without persisting.
			restoreTitle(commit && typed ? newName : original);

			if (!commit || !typed || newName === original) {
				return;
			}

			if (isDuplicateName(newName)) {
				this.logService.info(`[SessionHistoryView] session ${info.sessionId} renamed to "${newName}" (duplicate display name)`);
			}

			try {
				await this.chatService.renameAgentSession(info.agentId, info.sessionId, newName);
				this.logService.info(`[SessionHistoryView] renamed session ${info.sessionId} to "${newName}"`);
				// Update local cache so subsequent reloads reflect the change
				info.sessionName = newName;
				// 同步已打开的聊天页签 label（否则侧边栏改名后页签名保持不变）
				this._syncEditorTabLabel(info.agentId, info.sessionId, newName);
			} catch (err) {
				this.logService.warn(`[SessionHistoryView] Failed to rename session ${info.sessionId}:`, err);
			}
		};

		// Enter commits the rename, Escape abandons it.
		// ⚠ 必须用 `addDisposableListener`（传**原生** KeyboardEvent）而非
		// `addStandardDisposableListener`：后者会把事件包装成 `StandardKeyboardEvent`，
		// 而该类**没有 `key` 属性**（只有 `keyCode`/`code`，见 `base/browser/keyboardEvent.ts:51-74`）
		// ⇒ `e.key` 恒为 `undefined` ⇒ 条件恒真 ⇒ Enter 永远被 return 掉、重命名无声失效。
		this._register(DOM.addDisposableListener(input, DOM.EventType.KEY_DOWN, (e) => {
			const key = (e as KeyboardEvent).key;
			if (key !== 'Enter' && key !== 'Escape') {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			void finish(key === 'Enter');
		}));
		// Clicking elsewhere confirms the edit, mirroring the Enter key.
		this._register(DOM.addStandardDisposableListener(input, DOM.EventType.BLUR, () => {
			void finish(true);
		}));

		input.focus();
		input.select();
	}

	private _findOpenEditorForSession(agentId: string, sessionId: string): { pane: NativeChatEditorPane; editor: NativeChatEditorInput; groupId: number } | null {
		const editors = this.editorService.getEditors(EditorsOrder.SEQUENTIAL);
		for (const { editor, groupId } of editors) {
			if (editor instanceof NativeChatEditorInput) {
				// Must match both agentId AND sessionId — an editor for the same
				// agent but different session won't have the target messages.
				if (editor.agentId === agentId && editor.sessionId === sessionId) {
					// Find the pane for this editor
					const group = this.editorGroupsService.getGroup(groupId);
					if (group) {
						const pane = group.activeEditorPane;
						if (pane instanceof NativeChatEditorPane) {
							return { pane, editor, groupId };
						}
					}
				}
			}
		}
		return null;
	}

	/**
	 * Push a renamed session name onto the matching open chat editor so its tab
	 * label follows the sidebar. Only the label is touched — the pane's runtime
	 * state (messages, agent binding) is left alone.
	 */
	private _syncEditorTabLabel(agentId: string, sessionId: string, newName: string): void {
		const openEditor = this._findOpenEditorForSession(agentId, sessionId);
		if (!openEditor) {
			return;
		}
		openEditor.editor.setSessionName(newName);
	}

	private _applyFilters(): void {
		const agentFilter = this.currentAgentFilter;
		const searchTerm = this.currentSearchTerm;

		this.filteredSessions = this.allSessions.filter(s => {
			if (agentFilter && s.info.agentId !== agentFilter) { return false; }
			if (searchTerm) {
				const inTitle = s.info.sessionName.toLowerCase().includes(searchTerm);
				const inMessages = s.messages.some(m => m.content.toLowerCase().includes(searchTerm));
				if (!inTitle && !inMessages) { return false; }
			}
			return true;
		});

		this._renderSessionList();
	}

	private _renderSessionList(): void {
		if (!this.sessionListEl) { return; }
		DOM.clearNode(this.sessionListEl);

		if (this.filteredSessions.length === 0) {
			const empty = DOM.append(this.sessionListEl, $('.session-history-empty'));
			const icon = DOM.append(empty, $('.session-history-empty-icon'));
			icon.textContent = '💬';
			const text = DOM.append(empty, $('.session-history-empty-text'));
			text.textContent = 'No sessions found';
			return;
		}

		for (const sessionData of this.filteredSessions) {
			const item = DOM.append(this.sessionListEl, $('.session-history-item'));
			this._renderSessionItem(item, sessionData);
		}
	}

	private _renderSessionItem(item: HTMLElement, sessionData: SessionData): void {
		const { info, messages, chatOpen, pinned } = sessionData;

		// Allow finding this item by sessionId for lazy-load updates
		item.setAttribute('data-session-id', info.sessionId);
		item.setAttribute('data-agent-id', info.agentId);
		item.setAttribute('data-session-key', this._sessionKey(info.agentId, info.sessionId));
		item.draggable = true;

		// F2 renaming: items are focusable so the shortcut can target the item the
		// user is navigating with the keyboard (mirrors the tree/explorer convention).
		item.tabIndex = 0;
		this._register(DOM.addDisposableListener(item, DOM.EventType.KEY_DOWN, (e) => {
			if (e.keyCode !== KeyCode.F2) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this._triggerRename(sessionData);
		}));


		// 多选态：重渲染后按 selectedKeys 还原（选中集合与展开态正交）
		if (this.selectedKeys.has(this._sessionKey(info.agentId, info.sessionId))) {
			item.classList.add('selected');
		}

		// ── Header：精简两行（2026-09-15 重构，用户选定方案 A）─────────────────
		// 行 1：箭头 + 标题（+ open 小字）
		// 行 2：状态点 + agent 名 · 相对时间 ……… 计数（右对齐）
		// 右侧：rename / delete —— **常驻占位**、hover 才可见（避免标题宽度抖动）
		const header = DOM.append(item, $('.session-history-item-header'));

		const arrow = DOM.append(header, $('.session-history-expand-arrow'));
		arrow.textContent = '▶';

		const infoEl = DOM.append(header, $('.session-history-info'));

		// 行 1
		const titleLine = DOM.append(infoEl, $('.session-history-title-line'));
		if (pinned) {
			const pinEl = DOM.append(titleLine, $('.session-history-pin'));
			pinEl.title = 'Pinned';
			pinEl.appendChild(_icon(ICON_PIN, 11));
		}
		const title = DOM.append(titleLine, $('.session-history-title'));
		title.textContent = info.sessionName || 'Untitled Session';
		title.title = `${info.sessionName || 'Untitled Session'} — Double-click to open chat, Ctrl/Cmd+click to multi-select, right-click for actions`;
		if (chatOpen) {
			const openTag = DOM.append(titleLine, $('.session-history-open-tag'));
			openTag.textContent = 'open';
		}

		// 行 2
		const subLine = DOM.append(infoEl, $('.session-history-sub-line'));
		// 状态点由 `_applyDotState(item, …)` 按 DOM 查询后设置，这里不需要引用。
		DOM.append(subLine, $('.session-history-status-dot'));
		const agentNameEl = DOM.append(subLine, $('.session-history-agent-name'));
		agentNameEl.textContent = info.agentName;
		agentNameEl.title = `Agent: ${info.agentName}`;
		const sepEl = DOM.append(subLine, $('.session-history-sep'));
		sepEl.textContent = '·';
		const timeEl = DOM.append(subLine, $('.session-history-time'));
		timeEl.textContent = this._formatRelativeTime(info.updatedAt);
		timeEl.title = info.updatedAt ? new Date(info.updatedAt).toLocaleString() : '';
		const subRight = DOM.append(subLine, $('.session-history-sub-right'));
		// 计数去 badge 化：0 不显示（用户需求：满屏 `0` 圆角块太抢眼）
		if (messages.length > 0) {
			const count = DOM.append(subRight, $('.session-history-count'));
			count.textContent = String(messages.length);
			count.title = `${messages.length} messages`;
		}

		// 右侧操作组（常驻占位 ⇒ hover 时标题不位移）
		const actions = DOM.append(header, $('.session-history-actions'));

		const editBtn = DOM.append(actions, $<HTMLButtonElement>('.session-history-rename-btn'));
		editBtn.title = 'Rename session';
		editBtn.appendChild(_icon(ICON_PENCIL));
		this._register(DOM.addDisposableListener(editBtn, DOM.EventType.CLICK, (e) => {
			e.stopPropagation();
			this._startRenameSession(sessionData, title, item);
		}));

		// Delete button — hover（或选中态）才可见。
		// 多选时（该项属于选中集合且集合 > 1）一次删除整个选中集合。
		const deleteBtn = DOM.append(actions, $<HTMLButtonElement>('.session-history-delete-btn'));
		deleteBtn.appendChild(_icon(ICON_TRASH));
		const isPartOfMultiSelection = () =>
			this.selectedKeys.has(this._sessionKey(info.agentId, info.sessionId)) && this.selectedKeys.size > 1;
		deleteBtn.title = isPartOfMultiSelection() ? 'Delete selected sessions' : 'Delete session';
		this._register(DOM.addDisposableListener(deleteBtn, DOM.EventType.CLICK, (e) => {
			e.stopPropagation();
			void this._deleteSessionsForItem(sessionData);
		}));

		// 运行指示灯：绿闪（执行中）/ 黄闪（等待用户）/ 白常亮（完成未读）/ 红（报错）
		this._applyDotState(item, this._sessionKey(info.agentId, info.sessionId), sessionData);

		// Messages container
		const messagesContainer = DOM.append(item, $('.session-history-messages-container'));

		let expanded = false;

		const toggleExpand = () => {
			expanded = !expanded;
			if (expanded) {
				item.classList.add('expanded');
				arrow.textContent = '▼';
				// Lazy-load history on first expand
				void this._renderMessages(messagesContainer, sessionData);
			} else {
				item.classList.remove('expanded');
				arrow.textContent = '▶';
				DOM.clearNode(messagesContainer);
			}
		};

		// Single click selects the item, then expands/collapses (delayed so a
		// double-click cancels it and opens the chat instead of toggling twice).
		// Modifier clicks extend the selection and never toggle expansion.
		this._register(DOM.addDisposableListener(header, DOM.EventType.CLICK, (e) => {
			const mouseEvent = e as MouseEvent;
			if (mouseEvent.ctrlKey || mouseEvent.metaKey || mouseEvent.shiftKey) {
				this._extendSelection(sessionData, { range: mouseEvent.shiftKey });
				return;
			}
			this._selectSingle(sessionData);
			this._pendingExpandTimer = setTimeout(() => {
				this._pendingExpandTimer = undefined;
				toggleExpand();
			}, 220);
		}));

		// Double click opens the agent chat (focus input if already open).
		this._register(DOM.addDisposableListener(header, DOM.EventType.DBLCLICK, (e) => {
			e.stopPropagation();
			if (this._pendingExpandTimer) {
				clearTimeout(this._pendingExpandTimer);
				this._pendingExpandTimer = undefined;
			}
			void this._openSessionChat(sessionData);
		}));

		// Right-click context menu: pin / rename / delete.
		this._register(DOM.addDisposableListener(header, DOM.EventType.CONTEXT_MENU, (e) => {
			e.preventDefault();
			e.stopPropagation();
			this._showContextMenu(sessionData, e as MouseEvent);
		}));

		// Drag & drop reordering.
		this._register(DOM.addDisposableListener(item, 'dragstart', (e) => {
			const dragEvent = e as DragEvent;
			dragEvent.dataTransfer?.setData('text/plain', item.getAttribute('data-session-key') ?? '');
			if (dragEvent.dataTransfer) { dragEvent.dataTransfer.effectAllowed = 'move'; }
			item.classList.add('dragging');
		}));
		this._register(DOM.addDisposableListener(item, 'dragend', () => {
			item.classList.remove('dragging');
		}));
		this._register(DOM.addDisposableListener(item, 'dragover', (e) => {
			const dragEvent = e as DragEvent;
			dragEvent.preventDefault();
			if (dragEvent.dataTransfer) { dragEvent.dataTransfer.dropEffect = 'move'; }
		}));
		this._register(DOM.addDisposableListener(item, 'drop', (e) => {
			const dragEvent = e as DragEvent;
			e.preventDefault();
			e.stopPropagation();
			const draggedKey = dragEvent.dataTransfer?.getData('text/plain');
			const targetKey = item.getAttribute('data-session-key') ?? '';
			if (draggedKey && targetKey && draggedKey !== targetKey) {
				this._reorderSession(draggedKey, targetKey);
			}
		}));
	}

	private async _renderMessages(container: HTMLElement, sessionData: SessionData): Promise<void> {
		DOM.clearNode(container);

		// Lazy-load history if not yet fetched
		if (!(sessionData as any)._messagesLoaded) {
			// Show loading indicator
			const loading = DOM.append(container, $('.session-history-messages-loading'));
			loading.textContent = 'Loading messages...';
			container.appendChild(loading);

			await this._loadSessionHistory(sessionData);
			if ((sessionData as any)._messagesLoading) { return; } // already loading elsewhere

			// Re-render with loaded messages
			this._renderMessagesLoaded(container, sessionData);
			return;
		}

		this._renderMessagesLoaded(container, sessionData);
	}

	private _renderMessagesLoaded(container: HTMLElement, sessionData: SessionData): void {
		DOM.clearNode(container);

		if (sessionData.messages.length === 0) {
			const empty = DOM.append(container, $('.session-history-messages-empty'));
			empty.textContent = 'No user messages in this session';
			return;
		}

		const header = DOM.append(container, $('.session-history-messages-header'));
		DOM.append(header, $('span')).textContent = 'User Messages';
		DOM.append(header, $('span.sort-indicator')).textContent = '↓ Newest first';

		for (const msg of sessionData.messages) {
			this._renderMessageItem(container, msg, sessionData);
		}
	}

	private _renderMessageItem(container: HTMLElement, msg: UserMessageInfo, sessionData: SessionData): void {
		const msgEl = DOM.append(container, $('.session-history-message'));

		const avatar = DOM.append(msgEl, $('.session-history-avatar'));
		avatar.textContent = 'U';

		const body = DOM.append(msgEl, $('.session-history-message-body'));

		const header = DOM.append(body, $('.session-history-message-header'));
		const roleLabel = DOM.append(header, $('.session-history-message-role'));
		roleLabel.textContent = 'USER';
		const timeLabel = DOM.append(header, $('.session-history-message-time'));
		timeLabel.textContent = this._formatTime(msg.timestamp);

		const textEl = DOM.append(body, $('.session-history-message-text'));
		textEl.textContent = msg.content;

		// Action buttons
		const actions = DOM.append(msgEl, $('.session-history-message-actions'));

		// Go-to button
		const gotoBtn = DOM.append(actions, $<HTMLButtonElement>('.session-history-action-btn.session-history-goto-btn'));
		gotoBtn.title = sessionData.chatOpen ? 'Jump to message in chat' : 'Open chat and jump to message';
		{ const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('fill', 'currentColor'); p.setAttribute('d', 'M13.05 2.95a6.24 6.24 0 0 1 0 8.84L9.1 15.74l-.7-.71l3.95-3.95a5.25 5.25 0 0 0 0-7.42a5.25 5.25 0 0 0-7.42 0l-3.95 4l-.71-.71l3.95-4a6.24 6.24 0 0 1 8.83 0zM5.85 7.42l3.94-3.95l.71.71l-3.95 4a5.24 5.24 0 0 0 0 7.41a5.25 5.25 0 0 0 7.42 0l3.95-4l.71.71l-3.95 4a6.25 6.25 0 0 1-8.84 0a6.24 6.24 0 0 1 0-8.84l.01-.04z'); svg.appendChild(p); gotoBtn.appendChild(svg); }
		this._register(DOM.addDisposableListener(gotoBtn, DOM.EventType.CLICK, (e) => {
			e.stopPropagation();
			this._navigateToMessage(sessionData, msg.id);
		}));

		// Copy button
		const copyBtn = DOM.append(actions, $<HTMLButtonElement>('.session-history-action-btn.session-history-copy-btn'));
		copyBtn.title = 'Copy message';
		{ const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('fill', 'currentColor'); p.setAttribute('d', 'M4 4.085V2.5A1.5 1.5 0 0 1 5.5 1H13.5A1.5 1.5 0 0 1 15 2.5v8A1.5 1.5 0 0 1 13.5 12H13v-1h.5a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5h-8a.5.5 0 0 0-.5.5v.585H4zM2.5 3A1.5 1.5 0 0 0 1 4.5v8A1.5 1.5 0 0 0 2.5 14h8A1.5 1.5 0 0 0 12 12.5v-8A1.5 1.5 0 0 0 10.5 3h-8zM2 4.5a.5.5 0 0 1 .5-.5h8a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8z'); svg.appendChild(p); copyBtn.appendChild(svg); }
		this._register(DOM.addDisposableListener(copyBtn, DOM.EventType.CLICK, (e) => {
			e.stopPropagation();
			this._copyMessage(msg.content, copyBtn);
		}));

		// Click on message body also navigates
		this._register(DOM.addDisposableListener(msgEl, DOM.EventType.CLICK, () => {
			this._navigateToMessage(sessionData, msg.id);
		}));
	}

	private async _navigateToMessage(sessionData: SessionData, messageId: string): Promise<void> {
		const { agentId, sessionId } = sessionData.info;

		try {
			// Check if chat is already open
			const openEditor = this._findOpenEditorForSession(agentId, sessionId);

			if (openEditor) {
				// Already open: switch to the specific editor tab (pinned so close icon shows)
				await this.editorService.openEditor(openEditor.editor, { pinned: true, revealIfOpened: true }, openEditor.groupId);
				await this._retryScrollToMessage(agentId, sessionId, messageId);
			} else {
				// Not open: create new editor input and open
				// Tab title format: agentName (sessionName)
				const displayName = `${sessionData.info.agentName} (${sessionData.info.sessionName})`;
				const input = NativeChatEditorInput.create(
					`session-history-${sessionId}`,
					agentId,
					sessionId,
					displayName,
				);

				const agentPart = (this.editorGroupsService as unknown as { agentPart?: IEditorGroupsService }).agentPart;
				if (agentPart?.activeGroup) {
					await agentPart.activeGroup.openEditor(input, { pinned: true });
				} else {
					await this.editorService.openEditor(input, { pinned: true });
				}

				// Wait for the editor to load the session and messages, then scroll
				await this._retryScrollToMessage(agentId, sessionId, messageId);
			}
		} catch (err) {
			this.logService.error('[SessionHistoryView] Failed to navigate to message:', err);
		}
	}

	/**
	 * Retry scrollToMessage with exponential backoff. Before each attempt,
	 * force-reload the correct session's history into the chat panel so that
	 * the target message appears in the DOM even if the editor restored a
	 * different session from runtime state.
	 */
	private async _retryScrollToMessage(agentId: string, sessionId: string, messageId: string): Promise<void> {
		const delays = [300, 600, 1000, 1500, 2000, 2500, 2000, 1000];
		for (let attempt = 0; attempt < delays.length; attempt++) {
			await new Promise(resolve => setTimeout(resolve, delays[attempt]));
			const openEditor = this._findOpenEditorForSession(agentId, sessionId);
			if (!openEditor) { continue; }
			const chatPanel = (openEditor.pane as any)._chatPanel as any;
			if (!chatPanel || typeof chatPanel.setMessages !== 'function') { continue; }

			// Force-load the correct session's messages into the panel
			try {
				const history = await this.chatService.getHistory(agentId, sessionId);
				const adapted = (openEditor.pane as any)._adaptHistoryMessages
					? (openEditor.pane as any)._adaptHistoryMessages(history)
					: history;
				if (Array.isArray(adapted) && adapted.length > 0) {
					chatPanel.setMessages(adapted);
					// Allow DOM to settle after setMessages
					await new Promise(resolve => setTimeout(resolve, 100));
				}
			} catch (err) {
				this.logService.warn(`[SessionHistoryView] failed to load history for scroll:`, err);
			}

			// Now try scrolling
			chatPanel.scrollToMessage?.(messageId);

			const messagesContainer = chatPanel.messagesContainer as HTMLElement | undefined;
			if (messagesContainer) {
				const found = messagesContainer.querySelector(`[data-msg-id="${messageId}"]`);
				if (found) {
					this.logService.info(`[SessionHistoryView] scrolled to message ${messageId} on attempt ${attempt + 1}`);
					return;
				}
			}
		}
		this.logService.warn(`[SessionHistoryView] failed to scroll to message ${messageId} after ${delays.length} attempts`);
	}

	private _copyMessage(content: string, btn: HTMLButtonElement): void {
		navigator.clipboard.writeText(content).then(() => {
			btn.classList.add('copied');
			setTimeout(() => btn.classList.remove('copied'), 1500);
		}).catch(() => {
			// Fallback
			const ta = document.createElement('textarea');
			ta.value = content;
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			document.body.removeChild(ta);
			btn.classList.add('copied');
			setTimeout(() => btn.classList.remove('copied'), 1500);
		});
	}

	private _formatTime(timestamp: number): string {
		try {
			const d = new Date(timestamp);
			const now = new Date();
			const diffMs = now.getTime() - d.getTime();
			const diffMins = Math.floor(diffMs / 60000);

			if (diffMins < 1) { return 'Just now'; }
			if (diffMins < 60) { return `${diffMins}m ago`; }

			const diffHours = Math.floor(diffMins / 60);
			if (diffHours < 24) { return `${diffHours}h ago`; }

			const diffDays = Math.floor(diffHours / 24);
			if (diffDays < 7) { return `${diffDays}d ago`; }

			return d.toLocaleDateString();
		} catch {
			return '';
		}
	}

	// ─── Multi-selection ──────────────────────────────────────────────────

	/** 单选：清空后只选中当前项。 */
	private _selectSingle(sessionData: SessionData): void {
		const key = this._sessionKey(sessionData.info.agentId, sessionData.info.sessionId);
		this.selectedKeys.clear();
		this.selectedKeys.add(key);
		this._selectionAnchorKey = key;
		this._syncSelectionUi();
	}

	/**
	 * 追加选择：`range` 为真时按当前显示顺序做区间选择（Shift+点击），
	 * 否则切换单项（Ctrl/Cmd+点击）。
	 */
	private _extendSelection(sessionData: SessionData, options: { range: boolean }): void {
		const key = this._sessionKey(sessionData.info.agentId, sessionData.info.sessionId);

		if (options.range && this._selectionAnchorKey) {
			const keys = this.filteredSessions.map(s => this._sessionKey(s.info.agentId, s.info.sessionId));
			const from = keys.indexOf(this._selectionAnchorKey);
			const to = keys.indexOf(key);
			if (from >= 0 && to >= 0) {
				const start = Math.min(from, to);
				const end = Math.max(from, to);
				for (let i = start; i <= end; i++) {
					this.selectedKeys.add(keys[i]);
				}
				this._syncSelectionUi();
				return;
			}
		}

		if (this.selectedKeys.has(key)) {
			this.selectedKeys.delete(key);
		} else {
			this.selectedKeys.add(key);
		}
		this._selectionAnchorKey = key;
		this._syncSelectionUi();
	}

	/** 把选中集合投影到已渲染的 DOM 上（不重建列表）。 */
	private _syncSelectionUi(): void {
		const items = this.sessionListEl?.querySelectorAll<HTMLElement>('.session-history-item');
		items?.forEach(itemEl => {
			const key = itemEl.getAttribute('data-session-key') ?? '';
			itemEl.classList.toggle('selected', this.selectedKeys.has(key));
			const deleteBtn = itemEl.querySelector<HTMLElement>('.session-history-delete-btn');
			if (deleteBtn) {
				const multi = this.selectedKeys.has(key) && this.selectedKeys.size > 1;
				deleteBtn.title = multi ? 'Delete selected sessions' : 'Delete session';
				deleteBtn.classList.toggle('multi', multi);
			}
		});
	}

	private _clearSelection(): void {
		this.selectedKeys.clear();
		this._selectionAnchorKey = undefined;
		this._syncSelectionUi();
	}

	/** 当前选中集合对应的会话数据（按列表显示顺序）。 */
	private _getSelectedSessions(): SessionData[] {
		return this.filteredSessions.filter(s => this.selectedKeys.has(this._sessionKey(s.info.agentId, s.info.sessionId)));
	}

	// ─── Session actions: pin / rename / delete / open / reorder ──────────

	/**
	 * Resolve human-readable agent names for the given agent IDs. Falls back
	 * to the raw ID when the agent definition is unavailable.
	 */
	private async _resolveAgentNames(agentIds: string[]): Promise<ReadonlyMap<string, string>> {
		const names = new Map<string, string>();
		try {
			const agents = await this.agentStudioService.getAgents();
			for (const agent of agents) {
				if (agentIds.includes(agent.id) && agent.name && agent.name.trim()) {
					names.set(agent.id, agent.name.trim());
				}
			}
		} catch (err) {
			this.logService.warn('[SessionHistoryView] failed to resolve agent names:', err);
		}
		return names;
	}

	/**
	 * Toggle the inline "new session" panel that lives just under the
	 * "+ New session" button. The panel lets the user pick an agent (chips)
	 * and name the session, then calls `createAgentSession` on confirm.
	 */
	private async _toggleNewSessionPanel(): Promise<void> {
		if (!this.newSessionPanel) { return; }

		// Already open? Close it.
		if (this.newSessionPanel.style.display !== 'none') {
			this._closeNewSessionPanel();
			return;
		}

		const agentIds = await this._discoverAgentIds();
		if (agentIds.length === 0) {
			await this.dialogService.info(
				localize('newSession.noAgents', "No agents found"),
				localize('newSession.noAgentsDetail', "There are no agents with an existing chat-history directory yet. Create or open an agent chat first."),
			);
			return;
		}

		// Resolve human-readable agent names (id → name) for the dropdown.
		const agentNames = await this._resolveAgentNames(agentIds);

		// Tear down any previous disposable store before re-rendering.
		this._disposeNewSessionPanel();
		this.newSessionPanelDisposables = this._register(new DisposableStore());

		this.newSessionState = {
			agentId: this.currentAgentFilter && agentIds.includes(this.currentAgentFilter) ? this.currentAgentFilter : agentIds[0],
			name: '',
			busy: false,
		};

		DOM.clearNode(this.newSessionPanel);
		this._renderNewSessionPanel(agentIds, agentNames);
		this.newSessionPanel.style.display = 'flex';

		// Focus the session name input for keyboard-driven flow.
		const nameInputEl = this.newSessionPanel.querySelector<HTMLInputElement>('.session-history-new-name-input .input');
		nameInputEl?.focus();
	}

	private _closeNewSessionPanel(): void {
		if (this.newSessionPanel) {
			this.newSessionPanel.style.display = 'none';
			DOM.clearNode(this.newSessionPanel);
		}
		this._disposeNewSessionPanel();
		this.newSessionState = undefined;
	}

	private _disposeNewSessionPanel(): void {
		this.newSessionPanelDisposables?.clear();
		this.newSessionPanelDisposables = undefined;
	}

	private _renderNewSessionPanel(agentIds: string[], agentNames: ReadonlyMap<string, string>): void {
		if (!this.newSessionPanel) { return; }

		const state = this.newSessionState;
		if (!state) { return; }

		// Agent label
		const agentLabel = DOM.append(this.newSessionPanel, $('.session-history-new-label'));
		agentLabel.textContent = localize('newSession.agentLabel', "Agent");

		// Agent select (native dropdown — reuses the same SelectBox as the
		// top-level agent filter for consistency).
		const agentSelectContainer = DOM.append(this.newSessionPanel, $('.session-history-new-agent-select-container'));
		const agentOptions: ISelectOptionItem[] = agentIds.map(id => ({
			text: agentNames.get(id) || id,
			description: agentNames.has(id) ? id : undefined,
		}));
		const initialIdx = Math.max(0, agentIds.indexOf(state.agentId));
		const agentSelect = this.newSessionPanelDisposables?.add(new SelectBox(agentOptions, initialIdx, this.contextViewService, defaultSelectBoxStyles, {
			ariaLabel: localize('newSession.agentAriaLabel', "Agent for the new session"),
			useCustomDrawn: true,
		}));
		if (agentSelect) {
			agentSelect.render(agentSelectContainer);
			this.newSessionPanelDisposables?.add(agentSelect.onDidSelect((selected) => {
				const idx = typeof selected.index === 'number' ? selected.index : 0;
				state.agentId = agentIds[idx] ?? state.agentId;
				// Re-focus the name input for keyboard flow.
				const nameInputEl = this.newSessionPanel?.querySelector<HTMLInputElement>('.session-history-new-name-input .input');
				nameInputEl?.focus();
			}));
		}

		// Name label
		const nameLabel = DOM.append(this.newSessionPanel, $('.session-history-new-label'));
		nameLabel.textContent = localize('newSession.nameLabel', "Session name (optional)");

		// Name input (re-using VS Code InputBox)
		const nameInputContainer = DOM.append(this.newSessionPanel, $('.session-history-new-name-input'));
		const nameInput = this.newSessionPanelDisposables?.add(new InputBox(nameInputContainer, this.contextViewService, {
			placeholder: localize('newSession.namePlaceholder', "Leave blank to use default"),
			ariaLabel: localize('newSession.nameAriaLabel', "Session name"),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		if (nameInput) {
			nameInput.value = state.name;
			this.newSessionPanelDisposables?.add(nameInput.onDidChange((value) => {
				state.name = value;
			}));
			// Enter to confirm.
			// ⚠ 监听挂在真正的 `<input>`（`inputElement`）上，而不是外层容器 `element`：
			// 键盘事件从内层 `.input` 冒泡虽然也能到达容器，但直接挂在输入元素上更可靠，
			// 且避免被容器上其它监听干扰。同时不用 `e instanceof KeyboardEvent` 判断
			// （跨 realm 时会误判），直接读原生事件的 `.key`。
			this.newSessionPanelDisposables?.add(DOM.addDisposableListener(nameInput.inputElement, DOM.EventType.KEY_DOWN, (e) => {
				if ((e as KeyboardEvent).key === 'Enter' && !state.busy) {
					e.preventDefault();
					void this._confirmNewSession();
				}
			}));
		}

		// Actions row
		const actions = DOM.append(this.newSessionPanel, $('.session-history-new-actions'));

		const createBtn = DOM.append(actions, $<HTMLButtonElement>('button.monaco-button.session-history-new-create-btn'));
		createBtn.textContent = localize('newSession.create', "Create");
		this.newSessionPanelDisposables?.add(DOM.addDisposableListener(createBtn, DOM.EventType.CLICK, () => {
			void this._confirmNewSession();
		}));

		const cancelBtn = DOM.append(actions, $<HTMLButtonElement>('button.session-history-new-cancel-btn'));
		cancelBtn.textContent = localize('newSession.cancel', "Cancel");
		this.newSessionPanelDisposables?.add(DOM.addDisposableListener(cancelBtn, DOM.EventType.CLICK, () => {
			this._closeNewSessionPanel();
		}));
	}

	private async _confirmNewSession(): Promise<void> {
		const state = this.newSessionState;
		if (!state || state.busy) { return; }
		state.busy = true;

		const agentId = state.agentId;
		const name = state.name.trim();
		try {
			const created = await this.chatService.createAgentSession(agentId, name || undefined);
			this.logService.info(`[SessionHistoryView] created session ${created.id} for agent ${agentId}`);
			this._closeNewSessionPanel();
			void this._loadSessions();
		} catch (err) {
			state.busy = false;
			this.logService.warn(`[SessionHistoryView] failed to create session for agent ${agentId}:`, err);
		}
	}

	// ─── 运行指示灯（2026-09-15 用户需求）────────────────────────────────────
	//
	// 颜色语义（与用户约定）：
	//   running  → 绿色闪烁（执行中）
	//   awaiting → 黄色闪烁（要求用户交互：clarify 提问 / 工具审批 / 确认框）
	//   done     → 白色常亮（执行完毕），**用户查看后熄灭**
	//   error    → 红色常亮（执行报错）
	//
	// 数据全部来自 `IAgentChatService.onDidStreamDelta` 的全局广播，不新增内核状态。

	/** 收到流式 delta ⇒ 更新指示灯（就地刷新 DOM，不重建列表）。 */
	private _onStreamDelta(agentId: string, sessionId: string, delta: IChatStreamDelta): void {
		const phase = SessionHistoryViewPane._classifyDelta(delta);
		if (!phase) { return; }

		const key = this._sessionKey(agentId, sessionId);
		// delta 是全局广播（含 workflow / 后台任务 / 非本列表会话）⇒ 只关心列表里的
		if (!this.allSessions.some(s => this._sessionKey(s.info.agentId, s.info.sessionId) === key)) { return; }

		const prev = this._runPhases.get(key);
		// 「等待用户」优先级最高：clarify / 审批之后 loop 往往紧接着收尾（done），
		// 若让 done/running 覆盖 awaiting，用户就再也看不到「该你回答了」的提示。
		if (prev === 'awaiting' && (phase === 'done' || phase === 'running')) { return; }

		this._runPhases.set(key, phase);

		if (phase === 'done') {
			// 新一轮完成 ⇒ 清掉「已读」，让白点重新亮起（否则新内容会被当成看过了）
			if (this._readKeys.delete(key)) { this._saveRead(); }
		}

		this._syncRunStateUi();
	}

	/** delta → 指示灯阶段；返回 `undefined` 表示该 delta 不改变灯的状态。 */
	private static _classifyDelta(delta: IChatStreamDelta): SessionRunPhase | undefined {
		switch (delta.type) {
			case 'error':
				return 'error';
			case 'done':
				return 'done';

			// ── 等待用户交互（黄闪）──────────────────────────────────────
			case 'tool_approval_request':
			case 'ask_user_start':
			case 'ask_user_progress':
			case 'questions':
			case 'question_carousel':
			case 'confirmation':
				return 'awaiting';

			case 'phase_change':
				if (delta.phase === 'awaiting_approval') { return 'awaiting'; }
				if (delta.phase === 'error') { return 'error'; }
				if (delta.phase === 'idle') { return 'done'; }
				return 'running';

			// ── 执行中（绿闪）────────────────────────────────────────────
			case 'text':
			case 'thinking':
			case 'tool_start':
			case 'tool_args':
			case 'tool_progress':
			case 'tool_end':
			case 'tool_result':
			case 'progress':
				return 'running';

			default:
				// 其余 delta（memory_* / usage / todos / skill_* / codebase_operation…）
				// 与「这一轮是否在跑」无关 ⇒ 不改灯，避免误报。
				return undefined;
		}
	}

	/** 就地刷新所有 item 的指示灯（列表 DOM 已存在时用；不重建）。 */
	private _syncRunStateUi(): void {
		if (!this.sessionListEl) { return; }
		this.sessionListEl.querySelectorAll('.session-history-item').forEach(el => {
			const item = el as HTMLElement;
			const key = item.getAttribute('data-session-key');
			if (!key) { return; }
			const sessionData = this.allSessions.find(s => this._sessionKey(s.info.agentId, s.info.sessionId) === key);
			if (sessionData) { this._applyDotState(item, key, sessionData); }
		});
	}

	/** 把某个 item 的状态点刷成当前阶段对应的颜色 / 动画。 */
	private _applyDotState(item: HTMLElement, key: string, sessionData: SessionData): void {
		const dot = item.querySelector('.session-history-status-dot') as HTMLElement | null;
		if (!dot) { return; }

		dot.classList.remove('run-running', 'run-awaiting', 'run-done', 'run-error', 'is-read', 'open');

		const phase = this._runPhases.get(key);
		if (!phase) {
			// 无运行状态 ⇒ 回落为「agent 色 + 低透明度」，chat 打开时点亮（原有语义）
			dot.style.setProperty('--agent-color', _getAgentColor(sessionData.info.agentName));
			dot.classList.toggle('open', sessionData.chatOpen);
			dot.title = sessionData.chatOpen
				? `Chat is currently open — ${sessionData.info.agentName}`
				: `Agent: ${sessionData.info.agentName}`;
			return;
		}

		dot.style.removeProperty('--agent-color');

		switch (phase) {
			case 'running':
				dot.classList.add('run-running');
				dot.title = 'Agent is working…';
				break;
			case 'awaiting':
				dot.classList.add('run-awaiting');
				dot.title = 'Waiting for your input';
				break;
			case 'error':
				dot.classList.add('run-error');
				dot.title = 'Last run failed';
				break;
			case 'done': {
				const read = this._readKeys.has(key) || sessionData.chatOpen;
				dot.classList.add('run-done');
				if (read) { dot.classList.add('is-read'); }
				dot.title = read ? 'Completed' : 'Completed — not viewed yet';
				break;
			}
		}
	}

	/** 标记会话已查看（白点熄灭），并持久化。 */
	private _markRead(key: string): void {
		if (this._readKeys.has(key)) { return; }
		this._readKeys.add(key);
		this._saveRead();
		this._syncRunStateUi();
	}

	/** 相对时间（`just now` / `5m` / `3h` / `2d` / 日期）。 */
	private _formatRelativeTime(ts: number): string {
		if (!ts || !Number.isFinite(ts)) { return ''; }
		const diff = Date.now() - ts;
		if (diff < 60_000) { return 'just now'; }
		const minutes = Math.floor(diff / 60_000);
		if (minutes < 60) { return `${minutes}m`; }
		const hours = Math.floor(minutes / 60);
		if (hours < 24) { return `${hours}h`; }
		const days = Math.floor(hours / 24);
		if (days < 30) { return `${days}d`; }
		return new Date(ts).toLocaleDateString();
	}

	private _sessionKey(agentId: string, sessionId: string): string {
		return `${agentId}::${sessionId}`;
	}

	/** Stable ordering: pinned first, then manual order, then updatedAt desc. */
	private _compareSessions(a: SessionData, b: SessionData): number {
		if (a.pinned !== b.pinned) { return a.pinned ? -1 : 1; }
		const aKey = this._sessionKey(a.info.agentId, a.info.sessionId);
		const bKey = this._sessionKey(b.info.agentId, b.info.sessionId);
		const ai = this.sessionOrder.indexOf(aKey);
		const bi = this.sessionOrder.indexOf(bKey);
		if (ai !== -1 || bi !== -1) {
			return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
		}
		return b.info.updatedAt - a.info.updatedAt;
	}

	private _loadPersistedState(): void {
		try {
			const pinnedRaw = this.storageService.get(SessionHistoryViewPane.PINNED_KEY, StorageScope.PROFILE);
			if (pinnedRaw) {
				const arr = JSON.parse(pinnedRaw);
				if (Array.isArray(arr)) {
					for (const k of arr) { if (typeof k === 'string') { this.pinnedSessions.add(k); } }
				}
			}
		} catch { /* ignore corrupt data */ }
		try {
			const orderRaw = this.storageService.get(SessionHistoryViewPane.ORDER_KEY, StorageScope.PROFILE);
			if (orderRaw) {
				const arr = JSON.parse(orderRaw);
				if (Array.isArray(arr)) {
					this.sessionOrder = arr.filter((k): k is string => typeof k === 'string');
				}
			}
		} catch { /* ignore corrupt data */ }
		try {
			// 已读集合（运行指示灯：白色「完成未读」点，用户查看后熄灭）
			const readRaw = this.storageService.get(SessionHistoryViewPane.READ_KEY, StorageScope.PROFILE);
			if (readRaw) {
				const arr = JSON.parse(readRaw);
				if (Array.isArray(arr)) {
					for (const k of arr) { if (typeof k === 'string') { this._readKeys.add(k); } }
				}
			}
		} catch { /* ignore corrupt data */ }
	}

	private _savePinned(): void {
		this.storageService.store(SessionHistoryViewPane.PINNED_KEY, JSON.stringify([...this.pinnedSessions]), StorageScope.PROFILE, StorageTarget.USER);
	}

	/** 持久化已读集合（超出上限时淘汰最旧的，避免 storage 无限膨胀）。 */
	private _saveRead(): void {
		try {
			while (this._readKeys.size > SessionHistoryViewPane.MAX_READ_KEYS) {
				const oldest = this._readKeys.values().next().value as string | undefined;
				if (oldest === undefined) { break; }
				this._readKeys.delete(oldest);
			}
			this.storageService.store(SessionHistoryViewPane.READ_KEY, JSON.stringify([...this._readKeys]), StorageScope.PROFILE, StorageTarget.USER);
		} catch { /* ignore quota errors */ }
	}

	private _saveOrder(): void {
		if (this.sessionOrder.length === 0) {
			this.storageService.remove(SessionHistoryViewPane.ORDER_KEY, StorageScope.PROFILE);
		} else {
			this.storageService.store(SessionHistoryViewPane.ORDER_KEY, JSON.stringify(this.sessionOrder), StorageScope.PROFILE, StorageTarget.USER);
		}
	}

	private _showContextMenu(sessionData: SessionData, event: MouseEvent): void {
		const pinned = sessionData.pinned;

		// ★★ 收集本次菜单创建的 Action，菜单关闭即释放（2026-09-15，修 `[LEAKED DISPOSABLE]`）。
		// 泄漏栈：`new Action`（`base/common/actions.ts:74`）← `Object.getActions`
		// （本文件 :1691/:1695/:1698/:1702）← `ContextMenuHandler.showContextMenu` ✓
		// 成因：Action 是 `Disposable`（`Action extends Disposable` ✓），
		// 而 `showContextMenu` **不接管**它们的生命周期 ✗ ⇒ 每次右键泄漏 4 个 Action ✓。
		//
		// ⚠ 两个写法要点（照 MEMORY.md 第 17 条）：
		//   ① Action 必须**提到 `getActions` 外面**创建 ✓ —— 回调可能被调用多次 ✗，
		//      写在回调里会重复创建、且无法与 `onHide` 一一对应 ✓；
		//   ② `IAction` 在本仓**不继承** `IDisposable` ✗ ⇒ 必须 `isDisposable()` 守卫 ✓
		//      （否则 `store.add(a)` 报 TS2741 ✓）。
		const store = new DisposableStore();
		const actions: IAction[] = [
			new Action('sessionHistory.open', localize('openSession', "Open"), undefined, true, () => {
				void this._openSessionChat(sessionData);
			}),
			new Separator(),
			new Action('sessionHistory.pin', pinned ? localize('unpinSession', "Unpin") : localize('pinSession', "Pin"), undefined, true, () => {
				this._togglePin(sessionData);
			}),
			new Action('sessionHistory.rename', localize('renameSession', "Rename"), undefined, true, () => {
				this._triggerRename(sessionData);
			}),
			new Separator(),
			new Action('sessionHistory.delete', localize('deleteSession', "Delete"), undefined, true, () => {
				void this._deleteSession(sessionData);
			}),
		];
		actions.forEach(a => { if (isDisposable(a)) { store.add(a); } });

		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: event.clientX, y: event.clientY }),
			getActions: () => actions,
			// ⚠ `showContextMenu()` 返回 **void**（不是 Promise）⇒ 不能 `.finally()` ✗；
			//    正确钩子是 delegate 的 `onHide` ✓（`platform/contextview/browser/contextView.ts:43`）
			onHide: () => store.dispose(),
		});
	}

	private _togglePin(sessionData: SessionData): void {
		const key = this._sessionKey(sessionData.info.agentId, sessionData.info.sessionId);
		if (this.pinnedSessions.has(key)) {
			this.pinnedSessions.delete(key);
		} else {
			this.pinnedSessions.add(key);
		}
		sessionData.pinned = this.pinnedSessions.has(key);
		this._savePinned();
		this.allSessions.sort((a, b) => this._compareSessions(a, b));
		this._applyFilters();
	}

	/** 删除按钮入口：属于多选集合时删除整个集合，否则只删除该项。 */
	private async _deleteSessionsForItem(sessionData: SessionData): Promise<void> {
		const key = this._sessionKey(sessionData.info.agentId, sessionData.info.sessionId);
		const targets = this.selectedKeys.has(key) && this.selectedKeys.size > 1
			? this._getSelectedSessions()
			: [sessionData];
		await this._deleteSessions(targets);
	}

	private async _deleteSession(sessionData: SessionData): Promise<void> {
		await this._deleteSessions([sessionData]);
	}

	/**
	 * 删除一个或多个会话（带确认框）。
	 * 多选时确认文案写明数量，避免「只点了一个按钮却删掉一堆」的意外。
	 */
	private async _deleteSessions(sessions: SessionData[]): Promise<void> {
		if (sessions.length === 0) { return; }

		const single = sessions.length === 1;
		const confirmed = await this.dialogService.confirm({
			message: single
				? localize('deleteSession.confirm', "Delete session '{0}'?", sessions[0].info.sessionName || 'Untitled Session')
				: localize('deleteSessions.confirm', "Delete {0} selected sessions?", sessions.length),
			detail: localize('deleteSession.detail', "This permanently deletes the session and its message history. This action cannot be undone."),
			primaryButton: localize('delete', "Delete"),
		});
		if (!confirmed.confirmed) { return; }

		for (const sessionData of sessions) {
			const { agentId, sessionId } = sessionData.info;
			try {
				await this.chatService.deleteAgentSession(agentId, sessionId);
				this.logService.info(`[SessionHistoryView] deleted session ${sessionId}`);
				const key = this._sessionKey(agentId, sessionId);
				this.pinnedSessions.delete(key);
				this.selectedKeys.delete(key);
				this.sessionOrder = this.sessionOrder.filter(k => k !== key);
			} catch (err) {
				this.logService.warn(`[SessionHistoryView] failed to delete session ${sessionId}:`, err);
			}
		}

		this._selectionAnchorKey = undefined;
		this._savePinned();
		this._saveOrder();
		await this._loadSessions();
	}

	/** Trigger rename from the context menu — find the rendered title element and start inline edit. */
	private _triggerRename(sessionData: SessionData): void {
		const { agentId, sessionId } = sessionData.info;
		const items = this.sessionListEl?.querySelectorAll<HTMLElement>('.session-history-item');
		items?.forEach((itemEl) => {
			if (itemEl.getAttribute('data-session-id') === sessionId && itemEl.getAttribute('data-agent-id') === agentId) {
				const titleEl = itemEl.querySelector<HTMLElement>('.session-history-title');
				if (titleEl) {
					this._startRenameSession(sessionData, titleEl, itemEl);
				}
			}
		});
	}

	/**
	 * 注入打开会话的目标 group 解析器（供独立聊天窗口的会话侧栏使用）。
	 * 传 `undefined` 恢复默认行为（主窗口 Agent 编辑器区）。
	 */
	setOpenGroupResolver(resolver: (() => IEditorGroup | undefined) | undefined): void {
		this._openGroupResolver = resolver;
	}

	/**
	 * 打开会话聊天时使用的目标 group。
	 *
	 * 默认 = 主窗口的 Agent 编辑器区（`agentPart`）。独立聊天窗口里的那份
	 * 会话侧栏会通过 `setOpenGroupResolver()` 覆写，让双击会话在**本窗口**内
	 * 打开，而不是跑回主窗口。
	 */
	protected getPreferredOpenGroup(): IEditorGroup | undefined {
		if (this._openGroupResolver) {
			return this._openGroupResolver();
		}
		const agentPart = (this.editorGroupsService as unknown as { agentPart?: IEditorGroupsService }).agentPart;
		return agentPart?.activeGroup;
	}

	private async _openSessionChat(sessionData: SessionData): Promise<void> {
		const { agentId, sessionId, sessionName } = sessionData.info;

		// 打开即视为「已查看」⇒ 完成态白点熄灭（用户需求）
		this._markRead(this._sessionKey(agentId, sessionId));

		// Already open: reveal the tab and focus its input box.
		const openEditor = this._findOpenEditorForSession(agentId, sessionId);
		if (openEditor) {
			await this.editorService.openEditor(openEditor.editor, { pinned: true, revealIfOpened: true }, openEditor.groupId);
			openEditor.pane.focusInput();
			return;
		}

		// Not open: create a new editor input and open it, then focus the input.
		const displayName = `${agentId} (${sessionName})`;
		const input = NativeChatEditorInput.create(`session-history-${sessionId}`, agentId, sessionId, displayName);
		const targetGroup = this.getPreferredOpenGroup();
		if (targetGroup) {
			await targetGroup.openEditor(input, { pinned: true });
		} else {
			await this.editorService.openEditor(input, { pinned: true });
		}
		const opened = this._findOpenEditorForSession(agentId, sessionId);
		if (opened) {
			opened.pane.focusInput();
		}
	}

	private _reorderSession(draggedKey: string, targetKey: string): void {
		const currentKeys = this.filteredSessions.map(s => this._sessionKey(s.info.agentId, s.info.sessionId));
		const fromIdx = currentKeys.indexOf(draggedKey);
		if (fromIdx < 0) { return; }
		currentKeys.splice(fromIdx, 1);
		const toIdx = currentKeys.indexOf(targetKey);
		if (toIdx < 0) { return; }
		currentKeys.splice(toIdx + 1, 0, draggedKey);
		this.sessionOrder = currentKeys;
		this._saveOrder();
		this.allSessions.sort((a, b) => this._compareSessions(a, b));
		this._renderSessionList();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override focus(): void {
		super.focus();
	}
}
