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
import { IAgentChatService, IAgentStudioService } from '../../../common/agentStudioService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
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
import { Action, Separator } from '../../../../base/common/actions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';

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

	/** Pinned session keys (agentId\u0000sessionId), persisted across reloads. */
	private readonly pinnedSessions = new Set<string>();
	/** Manual session ordering (agentId\u0000sessionId, display order), persisted. */
	private sessionOrder: string[] = [];
	private static readonly PINNED_KEY = 'sessionHistoryView.pinnedSessions';
	private static readonly ORDER_KEY = 'sessionHistoryView.sessionOrder';
	/** Pending single-click expand timer — cancelled on double-click so the open-chat action wins. */
	private _pendingExpandTimer: any = undefined;

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

		// Load sessions
		this._loadSessions();

		// Sync open/closed state when the active editor changes (agent switch, session switch, etc.)
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this._syncOpenState();
		}));

		// Reload sessions when sessions change in any chat editor (debounced)
		this._register(this.chatService.onDidChangeAgentSessions(() => {
			if (this._reloadTimer) { clearTimeout(this._reloadTimer); }
			this._reloadTimer = setTimeout(() => {
				this._reloadTimer = undefined;
				this.logService.info('[SessionHistoryView] onDidChangeAgentSessions: reloading sessions');
				this._loadSessions();
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

	private async _loadSessions(): Promise<void> {
		try {
			if (this.sessionListEl) {
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

			// Batch-render to avoid blocking the UI with large session lists
			await this._applyFiltersIncremental();
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
	private async _applyFiltersIncremental(): Promise<void> {
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

			// Update the message count badge in the already-rendered item
			const itemEl = this.sessionListEl?.querySelector(`[data-session-id="${sessionId}"]`)?.closest('.session-history-item');
			if (itemEl) {
				const countEl = itemEl.querySelector('.session-history-count');
				if (countEl) { countEl.textContent = String(userMessages.length); }
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
			// Match the session item to its data via the title text + agent badge
			// The item was rendered in order of this.allSessions, so we can use
			// a simpler approach: iterate and update all sessions.
			const statusDot = item.querySelector('.session-history-status-dot');
			const openTag = item.querySelector('.session-history-open-tag');
			const itemHeader = item.querySelector('.session-history-item-header');
			if (!itemHeader || !statusDot) { return; }

			// Find the matching session data by comparing the title and agent badge
			const titleEl = itemHeader.querySelector('.session-history-title');
			const agentBadge = itemHeader.querySelector('.session-history-agent-badge');
			if (!titleEl || !agentBadge) { return; }

			const title = titleEl.textContent ?? '';
			const agentText = agentBadge.textContent?.replace('🤖 ', '') ?? '';

			const sessionData = this.allSessions.find(s =>
				s.info.sessionName === title && s.info.agentName === agentText
			);
			if (!sessionData) { return; }

			const nowOpen = this._findOpenEditorForSession(sessionData.info.agentId, sessionData.info.sessionId) !== null;

			// Update status dot
			if (nowOpen) {
				statusDot.classList.add('open');
				statusDot.setAttribute('title', 'Chat is currently open');
			} else {
				statusDot.classList.remove('open');
				statusDot.setAttribute('title', 'Chat not open');
			}

			// Update or remove "open" tag
			if (nowOpen && !openTag) {
				const tag = document.createElement('span');
				tag.className = 'session-history-open-tag';
				tag.textContent = '● open';
				const countEl = itemHeader.querySelector('.session-history-count');
				if (countEl) {
					countEl.before(tag);
				} else {
					itemHeader.appendChild(tag);
				}
			} else if (!nowOpen && openTag) {
				openTag.remove();
			}

			// Update local cache
			sessionData.chatOpen = nowOpen;
		});
	}

	/**
	 * Start rename mode for a session. Replaces the title span with an inline
	 * input. On Enter / blur, persists via chatService.renameAgentSession().
	 */
	private _startRenameSession(sessionData: SessionData, titleEl: HTMLElement, itemEl: HTMLElement): void {
		const { info } = sessionData;
		const original = titleEl.textContent ?? '';

		// Build input
		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'session-history-rename-input';
		input.value = original;
		input.maxLength = 100;
		input.placeholder = 'Session name';

		// Replace the title with the input
		titleEl.replaceWith(input);
		input.focus();
		input.select();

		let finished = false;
		const finish = async (commit: boolean) => {
			if (finished) { return; }
			finished = true;
			const newName = input.value.trim() || original;
			// Restore the title element
			const newTitle = document.createElement('span');
			newTitle.className = 'session-history-title';
			newTitle.textContent = newName;
			newTitle.title = `${newName} — Double-click to rename`;
			DOM.addStandardDisposableListener(newTitle, DOM.EventType.DBLCLICK, (e) => {
				e.stopPropagation();
				this._startRenameSession(sessionData, newTitle, itemEl);
			});
			input.replaceWith(newTitle);
			titleEl.remove();

			if (commit && newName !== original) {
				try {
					await this.chatService.renameAgentSession(info.agentId, info.sessionId, newName);
					this.logService.info(`[SessionHistoryView] renamed session ${info.sessionId} to "${newName}"`);
					// Update local cache so subsequent reloads reflect the change
					info.sessionName = newName;
				} catch (err) {
					this.logService.warn(`[SessionHistoryView] Failed to rename session ${info.sessionId}:`, err);
				}
			}
		};

		this._register(DOM.addStandardDisposableListener(input, DOM.EventType.KEY_DOWN, (e) => {
			if ((e as unknown as KeyboardEvent).key === 'Enter') {
				e.preventDefault();
				void finish(true);
			} else if ((e as unknown as KeyboardEvent).key === 'Escape') {
				e.preventDefault();
				void finish(false);
			}
		}));
		this._register(DOM.addStandardDisposableListener(input, 'blur', () => {
			void finish(true);
		}));
		this._register(DOM.addStandardDisposableListener(input, 'click', (e) => {
			e.stopPropagation(); // don't trigger item expand on click in input
		}));
		this._register(DOM.addStandardDisposableListener(input, 'mousedown', (e) => {
			e.stopPropagation();
		}));
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

		// Header
		const header = DOM.append(item, $('.session-history-item-header'));
		const agentColor = _getAgentColor(info.agentName);

		// Pin marker
		if (pinned) {
			const pinEl = DOM.append(header, $('.session-history-pin'));
			pinEl.textContent = '📌';
			pinEl.title = 'Pinned';
		}

		const statusDot = DOM.append(header, $('.session-history-status-dot'));
		statusDot.style.setProperty('--agent-color', agentColor);
		if (chatOpen) {
			statusDot.classList.add('open');
			statusDot.title = 'Chat is currently open';
		} else {
			statusDot.title = 'Chat not open';
		}

		const arrow = DOM.append(header, $('.session-history-expand-arrow'));
		arrow.textContent = '▶';

		const infoEl = DOM.append(header, $('.session-history-info'));
		const title = DOM.append(infoEl, $('.session-history-title'));
		title.textContent = info.sessionName || 'Untitled Session';
		title.title = `${info.sessionName || 'Untitled Session'} — Right-click for actions, double-click to open chat`;

		const meta = DOM.append(infoEl, $('.session-history-meta'));
		const agentBadge = DOM.append(meta, $('.session-history-agent-badge'));
		agentBadge.textContent = `🤖 ${info.agentName}`;
		agentBadge.style.setProperty('--agent-color', agentColor);
		agentBadge.style.borderLeftColor = agentColor;
		agentBadge.style.borderLeftStyle = 'solid';
		agentBadge.style.borderLeftWidth = '2px';
		agentBadge.style.paddingLeft = '4px';

		if (chatOpen) {
			const openTag = DOM.append(header, $('.session-history-open-tag'));
			openTag.textContent = '● open';
		}

		// Edit (rename) button — only visible on hover
		const editBtn = DOM.append(header, $<HTMLButtonElement>('.session-history-rename-btn'));
		editBtn.title = 'Rename session';
		{ const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '12'); svg.setAttribute('height', '12'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('fill', 'currentColor'); p.setAttribute('d', 'M11.488 1.65a1.5 1.5 0 0 1 2.122 0l.74.74a1.5 1.5 0 0 1 0 2.122l-1.69 1.69-2.862-2.862l1.69-1.69zM8.92 4.222l2.862 2.862-6.36 6.36-3.39.74a.5.5 0 0 1-.58-.58l.74-3.39 6.728-6.992z'); svg.appendChild(p); editBtn.appendChild(svg); }
		this._register(DOM.addDisposableListener(editBtn, DOM.EventType.CLICK, (e) => {
			e.stopPropagation();
			this._startRenameSession(sessionData, title, item);
		}));

		const count = DOM.append(header, $('.session-history-count'));
		count.textContent = String(messages.length);

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

		// Single click expands/collapses (delayed so a double-click cancels it
		// and opens the chat instead of toggling twice).
		this._register(DOM.addDisposableListener(header, DOM.EventType.CLICK, () => {
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
			// Enter to confirm
			this.newSessionPanelDisposables?.add(DOM.addDisposableListener(nameInput.element, DOM.EventType.KEY_DOWN, (e) => {
				if (e instanceof KeyboardEvent && e.key === 'Enter' && !state.busy) {
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
	}

	private _savePinned(): void {
		this.storageService.store(SessionHistoryViewPane.PINNED_KEY, JSON.stringify([...this.pinnedSessions]), StorageScope.PROFILE, StorageTarget.USER);
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
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: event.clientX, y: event.clientY }),
			getActions: () => [
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
			],
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

	private async _deleteSession(sessionData: SessionData): Promise<void> {
		const { agentId, sessionId, sessionName } = sessionData.info;
		const confirmed = await this.dialogService.confirm({
			message: localize('deleteSession.confirm', "Delete session '{0}'?", sessionName || 'Untitled Session'),
			detail: localize('deleteSession.detail', "This permanently deletes the session and its message history. This action cannot be undone."),
			primaryButton: localize('delete', "Delete"),
		});
		if (!confirmed.confirmed) { return; }

		try {
			await this.chatService.deleteAgentSession(agentId, sessionId);
			this.logService.info(`[SessionHistoryView] deleted session ${sessionId}`);
			const key = this._sessionKey(agentId, sessionId);
			this.pinnedSessions.delete(key);
			this.sessionOrder = this.sessionOrder.filter(k => k !== key);
			this._savePinned();
			this._saveOrder();
			await this._loadSessions();
		} catch (err) {
			this.logService.warn(`[SessionHistoryView] failed to delete session ${sessionId}:`, err);
		}
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

	private async _openSessionChat(sessionData: SessionData): Promise<void> {
		const { agentId, sessionId, sessionName } = sessionData.info;

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
		const agentPart = (this.editorGroupsService as unknown as { agentPart?: IEditorGroupsService }).agentPart;
		if (agentPart?.activeGroup) {
			await agentPart.activeGroup.openEditor(input, { pinned: true });
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
