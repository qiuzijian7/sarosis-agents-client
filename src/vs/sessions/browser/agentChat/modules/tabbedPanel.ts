/*---------------------------------------------------------------------------------------------
 *  TabbedPanelManager — replaces systemMsgBar + queueBar with a unified tabbed panel.
 *  - Tab 1: 任务列表 (queue items with status, drag-and-drop, action buttons)
 *  - Tab 2: 消息列表 (system messages: compression / memory / codebase notices)
 *  - Collapse button to toggle panel visibility
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import type {
	IQueueItem,
} from '../agentChatTypes.js';

// ── System message types ────────────────────────────────────────────────────
export interface ISystemMsg {
	id: string;
	type: 'compression' | 'memory' | 'codebase';
	icon: string;
	badge: string;
	badgeClass: string;
	content: string;
	details?: string[];
	timestamp: number;
	rawData?: Record<string, unknown>;
	status?: 'pending' | 'saved' | 'failed';
	noticeId?: string;
}

export interface ITabbedPanelContext {
	readonly container: HTMLElement;
	readonly textarea: HTMLTextAreaElement | null;
	readonly isSending: boolean;
	readonly onSendMessage: (text: string) => void;
	readonly agentId?: string;
	readonly onOpenCompressionDetail?: ((data: Record<string, unknown>) => void) | null;
	readonly onOpenMemoryDetail?: ((agentId: string, memoryType?: string, contentPreview?: string) => void) | null;
	readonly onOpenCodebaseDetail?: (() => void) | null;
}

export class TabbedPanelManager extends Disposable {

	// ── DOM ──
	private _panel: HTMLElement | null = null;
	private _header: HTMLElement | null = null;
	private _taskTab: HTMLElement | null = null;
	private _sysTab: HTMLElement | null = null;
	private _taskBody: HTMLElement | null = null;
	private _sysBody: HTMLElement | null = null;
	private _taskList: HTMLElement | null = null;
	private _sysList: HTMLElement | null = null;
	private _activeTab: 'tasks' | 'sysmsg' = 'tasks';

	// ── Queue state ──
	private _items: IQueueItem[] = [];

	// ── System message state ──
	private _systemMessages: ISystemMsg[] = [];

	constructor(private readonly ctx: ITabbedPanelContext) {
		super();
	}

	// ═══════════════════════════════════════════════════════════════
	// DOM lifecycle
	// ═══════════════════════════════════════════════════════════════

	createDom(): void {
		// Panel wrapper
		this._panel = append(this.ctx.container, $('.tabbed-panel'));

		// ── Header ──
		this._header = append(this._panel, $('.tabbed-panel-header'));

		this._taskTab = append(this._header, $('.tbp-tab.active'));
		this._taskTab.dataset.tab = 'tasks';
		this._taskTab.textContent = '任务列表';
		this._register(addDisposableListener(this._taskTab, EventType.CLICK, () => this._switchTab('tasks')));

		this._sysTab = append(this._header, $('.tbp-tab'));
		this._sysTab.dataset.tab = 'sysmsg';
		this._sysTab.textContent = '消息列表';
		this._register(addDisposableListener(this._sysTab, EventType.CLICK, () => this._switchTab('sysmsg')));

		// ── Task body ──
		this._taskBody = append(this._panel, $('.tbp-body.active'));
		this._taskBody.dataset.panel = 'tasks';
		this._taskList = append(this._taskBody, $('.tbp-task-list'));

		// ── System message body ──
		this._sysBody = append(this._panel, $('.tbp-body'));
		this._sysBody.dataset.panel = 'sysmsg';
		this._sysList = append(this._sysBody, $('.tbp-sys-list'));

		this._render();
	}

	removeDom(): void {
		if (this._panel?.isConnected) { this._panel.remove(); }
	}

	// ═══════════════════════════════════════════════════════════════
	// Queue (task list) API
	// ═══════════════════════════════════════════════════════════════

	get items(): ReadonlyArray<IQueueItem> { return this._items; }
	get count(): number { return this._items.length; }

	add(item: IQueueItem): void {
		this._items = [...this._items, item];
		this._render();
	}

	remove(itemId: string): void {
		const before = this._items.length;
		this._items = this._items.filter(it => it.id !== itemId);
		if (this._items.length !== before) { this._render(); }
	}

	getItems(): ReadonlyArray<IQueueItem> { return this._items; }

	update(itemId: string, updates: Partial<Omit<IQueueItem, 'id'>>): void {
		this._items = this._items.map(it => it.id === itemId ? { ...it, ...updates } : it);
		this._render();
	}

	reorder(itemId: string, direction: 'up' | 'down'): void {
		const idx = this._items.findIndex(it => it.id === itemId);
		if (idx < 0) { return; }
		const target = direction === 'up' ? idx - 1 : idx + 1;
		if (target < 0 || target >= this._items.length) { return; }
		const next = this._items.slice();
		const [it] = next.splice(idx, 1);
		next.splice(target, 0, it);
		this._items = next;
		this._render();
	}

	clear(): void {
		if (this._items.length === 0) { return; }
		this._items = [];
		this._render();
	}

	executeNext(): void {
		const idx = this._items.findIndex(it => it.status === 'pending' || !it.status);
		if (idx < 0) { return; }
		const item = this._items[idx];
		this.update(item.id, { status: 'executing' });
		this.ctx.onSendMessage(item.content);
		this.update(item.id, { status: 'done' });
		setTimeout(() => {
			this.remove(item.id);
		}, 600);
	}

	// ═══════════════════════════════════════════════════════════════
	// System message API
	// ═══════════════════════════════════════════════════════════════

	addSystemMessage(msg: Omit<ISystemMsg, 'id' | 'timestamp'>): void {
		this._systemMessages.push({
			...msg,
			id: `sysmsg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
			timestamp: Date.now(),
		});
		this._render();
	}

	updateSystemMessage(noticeId: string, status: 'saved' | 'failed', newContent?: string): void {
		const msg = this._systemMessages.find(m => m.noticeId === noticeId);
		if (!msg) { return; }
		msg.status = status;
		if (newContent) { msg.content = newContent; }
		this._render();
	}

	removeSystemMessage(noticeId: string): void {
		this._systemMessages = this._systemMessages.filter(m => m.noticeId !== noticeId);
		this._render();
	}

	clearSystemMessages(): void {
		if (this._systemMessages.length === 0) { return; }
		this._systemMessages = [];
		this._render();
	}

	// ═══════════════════════════════════════════════════════════════
	// Private: tab switching
	// ═══════════════════════════════════════════════════════════════

	private _switchTab(tab: 'tasks' | 'sysmsg'): void {
		// 点击已激活的 tab → toggle 折叠/展开当前 body
		if (this._activeTab === tab) {
			const body = tab === 'tasks' ? this._taskBody : this._sysBody;
			const tabBtn = tab === 'tasks' ? this._taskTab : this._sysTab;
			if (body) {
				const toggled = !body.classList.contains('active');
				body.classList.toggle('active', toggled);
				tabBtn?.classList.toggle('active', toggled);
			}
			return;
		}
		// 切换到新 tab：激活新 tab + body，停用旧 tab
		this._activeTab = tab;
		this._taskTab?.classList.toggle('active', tab === 'tasks');
		this._sysTab?.classList.toggle('active', tab === 'sysmsg');
		this._taskBody?.classList.toggle('active', tab === 'tasks');
		this._sysBody?.classList.toggle('active', tab === 'sysmsg');
	}

	// ═══════════════════════════════════════════════════════════════
	// Private: full render
	// ═══════════════════════════════════════════════════════════════

	private _render(): void {
		this._renderHeader();
		this._renderTaskList();
		this._renderSysList();
	}

	// ── Header ──
	private _renderHeader(): void {
		const taskTab = this._taskTab;
		const sysTab = this._sysTab;
		if (!taskTab || !sysTab) { return; }

		const taskCount = this._items.length;
		const sysCount = this._systemMessages.length;

		// Update active count in active tab label
		const executingIdx = this._items.findIndex(it => it.status === 'executing');
		const taskLabel = executingIdx >= 0
			? `任务列表 ${executingIdx + 1}/${taskCount}`
			: `任务列表${taskCount > 0 ? ` (${taskCount})` : ''}`;
		taskTab.textContent = taskLabel;

		const sysLabel = sysCount > 0 ? `消息列表 (${sysCount})` : '消息列表';
		sysTab.textContent = sysLabel;
	}

	// ── Task list ──
	private _renderTaskList(): void {
		const list = this._taskList;
		if (!list) { return; }
		while (list.firstChild) { list.removeChild(list.firstChild); }

		// Summary line
		const pending = this._items.filter(i => i.status === 'pending').length;
		if (this._items.length > 0) {
			const summary = document.createElement('div');
			summary.className = 'tbp-task-summary';
			if (this._items.some(i => i.status === 'executing')) {
				const dot = document.createElement('span');
				dot.className = 'tbp-status-dot executing';
				summary.appendChild(dot);
				summary.appendChild(document.createTextNode(`还有 ${pending} 个任务待执行`));
			} else {
				summary.appendChild(document.createTextNode(`共 ${this._items.length} 个任务`));
			}
			list.appendChild(summary);
		}

		for (const item of this._items) {
			list.appendChild(this._createTaskItemEl(item));
		}
	}

	private _createTaskItemEl(item: IQueueItem): HTMLElement {
		const status = item.status ?? 'pending';
		const row = document.createElement('div');
		row.className = `tbp-task-item tbp-task-${status}`;
		row.dataset.taskId = item.id;

		// ── Drag-and-drop ──
		row.draggable = true;
		row.addEventListener('dragstart', (e) => {
			if (status !== 'pending') { e.preventDefault(); return; }
			e.dataTransfer!.setData('text/plain', item.id);
			e.dataTransfer!.effectAllowed = 'move';
			row.classList.add('tbp-task-dragging');
		});
		row.addEventListener('dragend', () => {
			row.classList.remove('tbp-task-dragging');
		});
		row.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.dataTransfer!.dropEffect = 'move';
			const rect = row.getBoundingClientRect();
			row.classList.toggle('tbp-drop-above', e.clientY < rect.top + rect.height / 2);
			row.classList.toggle('tbp-drop-below', e.clientY >= rect.top + rect.height / 2);
		});
		row.addEventListener('dragleave', () => {
			row.classList.remove('tbp-drop-above', 'tbp-drop-below');
		});
		row.addEventListener('drop', (e) => {
			e.preventDefault(); e.stopPropagation();
			row.classList.remove('tbp-drop-above', 'tbp-drop-below');
			const draggedId = e.dataTransfer!.getData('text/plain');
			if (!draggedId || draggedId === item.id) { return; }
			const srcIdx = this._items.findIndex(it => it.id === draggedId);
			if (srcIdx < 0) { return; }
			const rect = row.getBoundingClientRect();
			let targetIdx = this._items.findIndex(it => it.id === item.id);
			if (targetIdx < 0) { return; }
			if (e.clientY >= rect.top + rect.height / 2) { targetIdx++; }
			if (srcIdx < targetIdx) { targetIdx--; }
			const next = this._items.slice();
			const [moved] = next.splice(srcIdx, 1);
			next.splice(targetIdx, 0, moved);
			this._items = next;
			this._render();
		});

		// Grip
		const grip = document.createElement('span');
		grip.className = 'tbp-task-grip';
		grip.textContent = '⋮⋮';
		row.appendChild(grip);

		// Status dot
		const dot = document.createElement('span');
		dot.className = `tbp-task-status tbp-task-status-${status}`;
		row.appendChild(dot);

		// Content
		const content = document.createElement('span');
		content.className = 'tbp-task-content';
		content.textContent = item.content;
		row.appendChild(content);

		// Actions (only for pending)
		if (status === 'pending') {
			const actions = document.createElement('span');
			actions.className = 'tbp-task-actions';

			const sendBtn = document.createElement('button');
			sendBtn.className = 'tbp-task-btn send';
			sendBtn.textContent = '↑';
			sendBtn.disabled = this.ctx.isSending;
			sendBtn.title = this.ctx.isSending ? 'LLM 输出中，请等待' : '发送此任务';
			sendBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.ctx.onSendMessage(item.content);
				this.remove(item.id);
			});
			actions.appendChild(sendBtn);

			const editBtn = document.createElement('button');
			editBtn.className = 'tbp-task-btn';
			editBtn.textContent = '✎';
			editBtn.title = '移回输入框编辑';
			editBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				if (this.ctx.textarea) {
					this.ctx.textarea.value = item.content;
					this.ctx.textarea.focus();
				}
				this.remove(item.id);
			});
			actions.appendChild(editBtn);

			const delBtn = document.createElement('button');
			delBtn.className = 'tbp-task-btn danger';
			delBtn.textContent = '🗑';
			delBtn.title = '删除';
			delBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.remove(item.id);
			});
			actions.appendChild(delBtn);

			row.appendChild(actions);
		}

		return row;
	}

	// ── System message list ──
	private _renderSysList(): void {
		const list = this._sysList;
		if (!list) { return; }
		while (list.firstChild) { list.removeChild(list.firstChild); }

		for (let mi = this._systemMessages.length - 1; mi >= 0; mi--) {
			const msg = this._systemMessages[mi];
			const item = document.createElement('div');
			item.className = 'sysmsg-item sysmsg-item-clickable';
			if (msg.status) { item.classList.add(`mem-status-${msg.status}`); }

			// Icon（复用原系统消息栏 .sysmsg-item-icon）
			const iconEl = document.createElement('span');
			iconEl.className = 'sysmsg-item-icon';
			if (msg.type === 'memory' && msg.status === 'pending') {
				iconEl.textContent = '⏳';
			} else if (msg.type === 'memory' && msg.status === 'saved') {
				iconEl.textContent = '✅';
			} else if (msg.type === 'memory' && msg.status === 'failed') {
				iconEl.textContent = '❌';
			} else {
				iconEl.textContent = msg.icon;
			}
			item.appendChild(iconEl);

			// Body（复用 .sysmsg-item-body / .sysmsg-item-header / .sysmsg-item-badge 等）
			const body = document.createElement('div');
			body.className = 'sysmsg-item-body';

			const header = document.createElement('div');
			header.className = 'sysmsg-item-header';
			const badge = document.createElement('span');
			badge.className = `sysmsg-item-badge ${msg.badgeClass}`;
			badge.textContent = msg.badge;
			header.appendChild(badge);
			const time = document.createElement('span');
			time.className = 'sysmsg-item-time';
			time.textContent = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
			header.appendChild(time);
			body.appendChild(header);

			const content = document.createElement('div');
			content.className = 'sysmsg-item-content';
			content.textContent = msg.content;
			body.appendChild(content);

			if (msg.details?.length) {
				const detail = document.createElement('div');
				detail.className = 'sysmsg-item-detail';
				for (const d of msg.details) {
					const span = document.createElement('span');
					span.textContent = d;
					detail.appendChild(span);
				}
				body.appendChild(detail);
			}
			item.appendChild(body);

			// Click handler
			item.addEventListener('click', (e) => {
				e.stopPropagation();
				if (msg.type === 'compression' && msg.rawData && this.ctx.onOpenCompressionDetail) {
					this.ctx.onOpenCompressionDetail(msg.rawData);
				} else if (msg.type === 'memory' && this.ctx.onOpenMemoryDetail && this.ctx.agentId) {
					const rawData = msg.rawData ?? {};
					const memType = rawData['memoryType'] as string | undefined;
					if (memType === 'skill') {
						this.ctx.onOpenMemoryDetail(
							rawData['agentId'] as string ?? this.ctx.agentId,
							'skill',
							rawData['skillTitle'] as string | undefined,
						);
					} else {
						this.ctx.onOpenMemoryDetail(
							this.ctx.agentId,
							memType,
							rawData['assistantContentPreview'] as string | undefined,
						);
					}
				} else if (msg.type === 'codebase' && this.ctx.onOpenCodebaseDetail) {
					this.ctx.onOpenCodebaseDetail();
				}
			});

			list.appendChild(item);
		}
	}
}
