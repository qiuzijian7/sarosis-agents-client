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
import { IAgentChatService } from '../../../common/agentStudioService.js';
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
}

export class SessionHistoryViewPane extends ViewPane {

	private container: HTMLElement | undefined;
	private sessionListEl: HTMLElement | undefined;
	private agentSelect: SelectBox | undefined;
	private searchInput: InputBox | undefined;
	private agentSelectContainer: HTMLElement | undefined;
	private searchInputContainer: HTMLElement | undefined;

	private allSessions: SessionData[] = [];
	private filteredSessions: SessionData[] = [];
	private currentAgentFilter = '';
	private currentSearchTerm = '';
	private _reloadTimer: any = undefined;

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
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
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
						} as SessionData);
						totalCount++;
					}
				} catch (err) {
					this.logService.warn(`[SessionHistoryView] Failed to list sessions for agent ${agentId}:`, err);
				}
			}

			this.logService.info(`[SessionHistoryView] _loadSessions: total ${totalCount} sessions (history lazy)`);
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
		const { info, messages, chatOpen } = sessionData;

		// Allow finding this item by sessionId for lazy-load updates
		item.setAttribute('data-session-id', info.sessionId);

		// Header
		const header = DOM.append(item, $('.session-history-item-header'));
		const agentColor = _getAgentColor(info.agentName);
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
		title.title = `${info.sessionName || 'Untitled Session'} — Double-click to rename`;
		this._register(DOM.addDisposableListener(title, DOM.EventType.DBLCLICK, (e) => {
			e.stopPropagation();
			this._startRenameSession(sessionData, title, item);
		}));

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

		this._register(DOM.addDisposableListener(header, DOM.EventType.CLICK, () => {
			expanded = !expanded;
			if (expanded) {
				item.classList.add('expanded');
				arrow.textContent = '▼';
				// Lazy-load history on first expand
				this._renderMessages(messagesContainer, sessionData);
			} else {
				item.classList.remove('expanded');
				arrow.textContent = '▶';
				DOM.clearNode(messagesContainer);
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
		// Truncate long messages
		if (msg.content.length > 200) {
			textEl.classList.add('truncated');
		}

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

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override focus(): void {
		super.focus();
	}
}
