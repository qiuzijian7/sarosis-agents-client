/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAction, Separator, toAction } from '../../../../../base/common/actions.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

/**
 * 卡片条目通用行为（preset agent / skill / workflow 三个列表共用）：
 * 1. 右键上下文菜单（置顶 / 复制 / 升级(按需) / 上传(按需) / 删除）
 * 2. 拖拽排序（HTML5 DnD）
 * 3. 排序 + 置顶持久化（StorageScope.APPLICATION）
 */

// ─── 右键菜单 ────────────────────────────────────────────────

export interface ICardMenuEntries {
	/** 置顶/取消置顶（有则显示，置顶项排在列表最前） */
	readonly pinned?: boolean;
	readonly onTogglePin?: () => void;
	/** 复制（有则显示） */
	readonly onDuplicate?: () => void;
	/** 升级（有则显示），label 如 "升级到 v1.0.1" */
	readonly upgradeLabel?: string;
	readonly onUpgrade?: () => void;
	/** 上传（有则显示） */
	readonly onUpload?: () => void;
	/** 删除（有则显示，内置项不显示） */
	readonly onDelete?: () => void;
}

/** 在鼠标位置弹出标准卡片右键菜单 */
export function showCardContextMenu(
	contextMenuService: IContextMenuService,
	e: MouseEvent,
	entries: ICardMenuEntries,
): void {
	const actions: IAction[] = [];
	if (entries.onTogglePin) {
		const run = entries.onTogglePin;
		actions.push(toAction({ id: 'card.togglePin', label: entries.pinned ? '取消置顶' : '置顶', run }));
	}
	if (entries.onDuplicate) {
		const run = entries.onDuplicate;
		actions.push(toAction({ id: 'card.duplicate', label: '复制', run }));
	}
	if (entries.onUpgrade) {
		const run = entries.onUpgrade;
		actions.push(toAction({ id: 'card.upgrade', label: entries.upgradeLabel ?? '升级', run }));
	}
	if (entries.onUpload) {
		const run = entries.onUpload;
		actions.push(toAction({ id: 'card.upload', label: '上传到商城', run }));
	}
	if (entries.onDelete) {
		actions.push(new Separator());
		actions.push(toAction({ id: 'card.delete', label: '删除', run: entries.onDelete }));
	}
	contextMenuService.showContextMenu({
		getAnchor: () => ({ x: e.clientX, y: e.clientY }),
		getActions: () => actions,
	});
}

// ─── 排序持久化 ──────────────────────────────────────────────

/** 基于 IStorageService 的排序持久化（逗号分隔 id 列表，应用级） */
export class CardOrderStore {
	constructor(
		private readonly storageService: IStorageService,
		private readonly key: string,
	) { }

	load(): string[] {
		const raw = this.storageService.get(this.key, StorageScope.APPLICATION, '');
		return raw ? raw.split(',').filter(Boolean) : [];
	}

	save(ids: string[]): void {
		this.storageService.store(this.key, ids.join(','), StorageScope.APPLICATION, StorageTarget.USER);
	}
}

/** 置顶集合持久化（逗号分隔 id 列表，应用级）。置顶项在排序时排在最前。 */
export class CardPinStore {
	constructor(
		private readonly storageService: IStorageService,
		private readonly key: string,
	) { }

	load(): Set<string> {
		const raw = this.storageService.get(this.key, StorageScope.APPLICATION, '');
		return new Set(raw ? raw.split(',').filter(Boolean) : []);
	}

	isPinned(id: string): boolean {
		return this.load().has(id);
	}

	/** 切换置顶状态并持久化，返回切换后的状态（true=已置顶） */
	toggle(id: string): boolean {
		const set = this.load();
		const nowPinned = !set.has(id);
		if (nowPinned) { set.add(id); } else { set.delete(id); }
		this.storageService.store(this.key, [...set].join(','), StorageScope.APPLICATION, StorageTarget.USER);
		return nowPinned;
	}
}

/**
 * 按保存的顺序排序；未记录的项保持原相对顺序排后。
 * 传入 pinned 时，置顶项整体排在最前（置顶项内部仍按保存顺序/原相对序）。
 */
export function applySavedOrder<T>(
	items: readonly T[],
	order: readonly string[],
	getId: (item: T) => string,
	pinned?: ReadonlySet<string>,
): T[] {
	const rank = new Map(order.map((id, i) => [id, i] as const));
	const MAX = Number.MAX_SAFE_INTEGER;
	return items
		.map((item, i) => ({
			item,
			p: pinned?.has(getId(item)) ? 0 : 1,
			r: rank.get(getId(item)) ?? MAX,
			i,
		}))
		.sort((a, b) => (a.p - b.p) || (a.r - b.r) || (a.i - b.i))
		.map(x => x.item);
}

// ─── 拖拽排序 ────────────────────────────────────────────────

/**
 * 垂直列表拖拽排序。每个列表视图持有一个实例，
 * 渲染时对每个卡片调用 attach(card, id)。
 */
export class CardDragSorter {
	private _draggingId: string | null = null;

	constructor(
		private readonly opts: {
			/** 用于清除指示线的容器 */
			readonly getContainer: () => HTMLElement | undefined;
			/** 当前渲染顺序（可见 id 列表） */
			readonly getVisibleIds: () => string[];
			/** 排序完成回调（持久化 + 重绘） */
			readonly onReorder: (orderedIds: string[]) => void;
		},
	) { }

	attach(card: HTMLElement, itemId: string): void {
		card.draggable = true;

		card.addEventListener('dragstart', (e) => {
			this._draggingId = itemId;
			e.dataTransfer?.setData('text/plain', itemId);
			if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; }
			card.classList.add('dragging');
		});
		card.addEventListener('dragend', () => {
			this._draggingId = null;
			card.classList.remove('dragging');
			this._clearIndicators();
		});
		card.addEventListener('dragover', (e) => {
			if (!this._draggingId || this._draggingId === itemId) { return; }
			e.preventDefault();
			if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
			const before = this._isBeforeHalf(card, e);
			this._clearIndicators();
			card.classList.add(before ? 'drop-before' : 'drop-after');
		});
		card.addEventListener('dragleave', () => {
			card.classList.remove('drop-before', 'drop-after');
		});
		card.addEventListener('drop', (e) => {
			e.preventDefault();
			if (!this._draggingId || this._draggingId === itemId) { return; }
			const before = this._isBeforeHalf(card, e);
			this._reorder(this._draggingId, itemId, before);
			this._draggingId = null;
			this._clearIndicators();
		});
	}

	private _isBeforeHalf(card: HTMLElement, e: DragEvent): boolean {
		const rect = card.getBoundingClientRect();
		return (e.clientY - rect.top) < rect.height / 2;
	}

	private _clearIndicators(): void {
		this.opts.getContainer()?.querySelectorAll('.drop-before, .drop-after')
			.forEach(c => c.classList.remove('drop-before', 'drop-after'));
	}

	private _reorder(draggedId: string, targetId: string, before: boolean): void {
		const ids = this.opts.getVisibleIds().filter(id => id !== draggedId);
		let idx = ids.indexOf(targetId);
		if (idx < 0) { return; }
		if (!before) { idx += 1; }
		ids.splice(idx, 0, draggedId);
		this.opts.onReorder(ids);
	}
}
