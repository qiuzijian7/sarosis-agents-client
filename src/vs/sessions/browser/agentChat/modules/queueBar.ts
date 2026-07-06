/*---------------------------------------------------------------------------------------------
 *  Queue bar manager — extracted from agentChatPanel.ts
 *  Manages the queue bar DOM, items state, drag-and-drop, and auto-execute logic.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import type {
	IQueueItem,
	IQueueItemActionCallback,
} from '../agentChatTypes.js';

/** Context required by QueueBarManager to interact with the parent panel */
export interface IQueueBarContext {
	/** The chat container element (for DOM appending) */
	readonly container: HTMLElement;
	/** The textarea element (for edit→fill-back) */
	readonly textarea: HTMLTextAreaElement | null;
	/** Whether the agent is currently streaming/sending */
	readonly isSending: boolean;
	/** Send a plain-text message to the backend */
	readonly onSendMessage: (text: string) => void;
}

export class QueueBarManager extends Disposable {
	// ── DOM refs ──
	private _bar: HTMLElement | null = null;
	private _list: HTMLElement | null = null;
	private _expanded = false;

	// ── State ──
	private _items: IQueueItem[] = [];
	private _onAction: IQueueItemActionCallback | null = null;

	constructor(private readonly ctx: IQueueBarContext) {
		super();
		// Register unified callback (promote/delete via itemId lookup)
		this._onAction = (action, itemId) => {
			const item = this._items.find(it => it.id === itemId);
			if (!item) { return; }
			if (action === 'promote') {
				ctx.onSendMessage(item.content);
				this.remove(itemId);
			} else if (action === 'delete') {
				this.remove(itemId);
			}
		};
	}

	// ── DOM lifecycle ──

	/** Create and append queue-bar + queue-list to the container */
	createDom(): void {
		this._bar = append(this.ctx.container, $('.queue-bar'));
		this._list = append(this.ctx.container, $('.queue-list'));
		this._bar.style.display = 'none';
		this._register(addDisposableListener(this._bar!, EventType.CLICK, (e) => {
			const t = e.target as HTMLElement;
			if (t.closest('.queue-item-action-btn, .queue-item-edit-input, .queue-item-edit-actions')) {
				return;
			}
			this._toggle();
		}));
		this._render();
	}

	/** Remove the bar and list from the DOM (before _renderInputArea re-creates them) */
	removeDom(): void {
		if (this._bar?.isConnected) { this._bar.remove(); }
		if (this._list?.isConnected) { this._list.remove(); }
	}

	// ── Public API ──

	get items(): ReadonlyArray<IQueueItem> { return this._items; }
	get count(): number { return this._items.length; }

	/** Add an item to the queue */
	add(item: IQueueItem): void {
		this._items = [...this._items, item];
		this._render();
	}

	/** Remove an item by id */
	remove(itemId: string): void {
		const before = this._items.length;
		this._items = this._items.filter(it => it.id !== itemId);
		if (this._items.length !== before) { this._render(); }
	}

	/** Get read-only snapshot of items */
	getItems(): ReadonlyArray<IQueueItem> { return this._items; }

	/** Update an existing item */
	update(itemId: string, updates: Partial<Omit<IQueueItem, 'id'>>): void {
		this._items = this._items.map(it => it.id === itemId ? { ...it, ...updates } : it);
		this._render();
	}

	/** Reorder: move an item up or down */
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

	/** Clear all items */
	clear(): void {
		if (this._items.length === 0) { return; }
		this._items = [];
		this._render();
	}

	/**
	 * Auto-execute the first pending item (called when loop ends).
	 * Marks as executing → sends → marks as done → removes after 600ms.
	 * Does NOT recurse — the next item is popped on the NEXT setSending(false).
	 */
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

	// ── Private ──

	private _toggle(): void {
		this._expanded = !this._expanded;
		this._render();
	}

	private _render(): void {
		const bar = this._bar;
		const list = this._list;
		if (!bar || !list) { return; }
		const count = this._items.length;

		while (bar.firstChild) { bar.removeChild(bar.firstChild); }

		const toggleEl = document.createElement('span');
		toggleEl.className = 'queue-toggle-icon' + (this._expanded ? ' expanded' : '');
		toggleEl.textContent = '▶';
		bar.appendChild(toggleEl);

		if (count === 0) {
			bar.style.display = 'none';
			list.style.maxHeight = '0';
			list.style.overflowY = 'hidden';
			return;
		}

		bar.style.display = 'flex';
		const labelEl = document.createElement('span');
		labelEl.className = 'queue-bar-label';
		labelEl.textContent = `队列 (${count})`;
		bar.appendChild(labelEl);

		list.style.maxHeight = this._expanded ? '320px' : '0';
		list.style.overflowY = this._expanded ? 'auto' : 'hidden';

		while (list.firstChild) { list.removeChild(list.firstChild); }
		if (!this._expanded) { return; }
		for (const item of this._items) { list.appendChild(this._createItemEl(item)); }
	}

	private _createItemEl(item: IQueueItem): HTMLElement {
		const status = item.status ?? 'pending';
		const row = document.createElement('div');
		row.className = `queue-item queue-item-${status}`;
		row.dataset.queueId = item.id;

		// ── Drag-and-drop ──
		row.draggable = true;
		row.addEventListener('dragstart', (e) => {
			if (status !== 'pending') { e.preventDefault(); return; }
			e.dataTransfer!.setData('text/plain', item.id);
			e.dataTransfer!.effectAllowed = 'move';
			row.classList.add('queue-item-dragging');
		});
		row.addEventListener('dragend', () => {
			row.classList.remove('queue-item-dragging');
			if (this._list) this._list.querySelectorAll('.queue-drop-zone').forEach(el => el.classList.remove('active'));
		});
		row.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.dataTransfer!.dropEffect = 'move';
			const rect = row.getBoundingClientRect();
			const midY = rect.top + rect.height / 2;
			if (this._list) this._list.querySelectorAll('.queue-drop-zone').forEach(el => el.classList.remove('active'));
			row.classList.toggle('queue-drop-above', e.clientY < midY);
			row.classList.toggle('queue-drop-below', e.clientY >= midY);
		});
		row.addEventListener('dragleave', () => {
			row.classList.remove('queue-drop-above', 'queue-drop-below');
		});
		row.addEventListener('drop', (e) => {
			e.preventDefault(); e.stopPropagation();
			row.classList.remove('queue-drop-above', 'queue-drop-below');
			const draggedId = e.dataTransfer!.getData('text/plain');
			if (!draggedId || draggedId === item.id) { return; }
			const srcIdx = this._items.findIndex(it => it.id === draggedId);
			if (srcIdx < 0) { return; }
			const rect = row.getBoundingClientRect();
			const midY = rect.top + rect.height / 2;
			let targetIdx = this._items.findIndex(it => it.id === item.id);
			if (targetIdx < 0) { return; }
			if (e.clientY >= midY) { targetIdx++; }
			if (srcIdx < targetIdx) { targetIdx--; }
			const next = this._items.slice();
			const [moved] = next.splice(srcIdx, 1);
			next.splice(targetIdx, 0, moved);
			this._items = next;
			this._render();
		});

		// Grip handle
		const grip = document.createElement('span');
		grip.className = 'queue-item-grip';
		grip.title = '拖拽排序';
		grip.textContent = '⋮⋮';
		row.appendChild(grip);

		// Content
		const content = document.createElement('span');
		content.className = 'queue-item-content';
		content.textContent = item.content;
		content.title = item.content;
		row.appendChild(content);

		// Actions
		const actions = document.createElement('span');
		actions.className = 'queue-item-actions';

		// ↑ Send (disabled when streaming)
		const sendBtn = document.createElement('button');
		sendBtn.className = 'queue-item-action-btn accent';
		sendBtn.title = this.ctx.isSending ? 'LLM 输出中，请等待' : '发送此任务';
		sendBtn.textContent = '↑';
		sendBtn.disabled = this.ctx.isSending;
		if (!this.ctx.isSending) {
			sendBtn.addEventListener('click', () => this._onAction?.('promote', item.id));
		}
		actions.appendChild(sendBtn);

		// ✎ Edit → pop back to textarea
		const editBtn = document.createElement('button');
		editBtn.className = 'queue-item-action-btn';
		editBtn.title = '移回输入框编辑';
		editBtn.textContent = '✎';
		editBtn.addEventListener('click', () => {
			if (this.ctx.textarea) {
				this.ctx.textarea.value = item.content;
				this.ctx.textarea.focus();
			}
			this._onAction?.('delete', item.id);
		});
		actions.appendChild(editBtn);

		// 🗑 Delete
		const delBtn = document.createElement('button');
		delBtn.className = 'queue-item-action-btn danger';
		delBtn.title = '删除';
		delBtn.textContent = '🗑';
		delBtn.addEventListener('click', () => this._onAction?.('delete', item.id));
		actions.appendChild(delBtn);

		row.appendChild(actions);
		return row;
	}
}
