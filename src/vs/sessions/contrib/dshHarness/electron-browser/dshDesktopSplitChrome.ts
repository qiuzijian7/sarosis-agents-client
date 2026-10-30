/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **桌面窗口多格的外壳**（2026-10-30，按已确认的效果图 `doc/mockups/dsh-split-panes.html` 实现）。
 *
 * 每一格 = 一个原生 `WebContentsView`（画在 aux 窗口 DOM **之上**）。所以：
 *  · 标题栏 / 分隔条 / 落点提示都是 aux 窗口里的 **DOM**，只能放在原生视图**让出来**的地方：
 *    标题栏在每格顶部（视图从标题栏下面开始）、分隔条在格与格之间的缝里、落点提示靠
 *    "**挖洞**"（拖动时宿主把目标格的原生视图缩到另一半，提示框就露出来）✓；
 *  · 右键菜单用 **Electron 原生菜单**（`popup`，主进程弹在当前聚焦窗口、画在所有视图之上）——
 *    DOM 菜单会被原生视图盖住 ✗；
 *  · 撤销提示 / 拖动状态放在**自绘标题条**里（那条永远可见）。
 *
 * ⚠ 两条硬规矩（真机踩过两次）：① 元素一律用**主窗口 document** 建（aux 子窗口禁 createElement）；
 *   ② 可交互元素一律显式 `pointer-events:auto`（aux 的 DOM 层默认不可交互）。
 *
 * 本类只管 DOM 与指针交互；树怎么改、视图怎么摆由宿主（`IDshSplitChromeActions`）决定。
 */

import { mainWindow } from '../../../../base/browser/window.js';
import { popup } from '../../../../base/parts/contextmenu/electron-browser/contextmenu.js';
import type { IContextMenuItem } from '../../../../base/parts/contextmenu/common/contextmenu.js';
import { dropHintRect, pickDropTarget, type DshDropTarget, type DshDropZone, type IDshDividerBar, type IDshPaneBox, type IDshSplitRect } from '../common/dshSplitLayout.js';

/** 每格标题栏高度（px）。 */
export const DESKTOP_PANE_HEAD_H = 32;

/** 起拖阈值（px）：按下后移动超过它才算拖（否则是点击）。 */
const DRAG_THRESHOLD = 8;

export interface IDshChromePane {
	readonly id: string;
	readonly title: string;
	readonly meta: string;
	readonly geo: IDshPaneBox;
}

export interface IDshChromeModel {
	/** 容器左上角（窗口坐标）⇒ DOM 绝对定位要减掉它。 */
	readonly origin: { readonly x: number; readonly y: number };
	readonly zoom: number;
	/** 主栏外框（窗口坐标）。 */
	readonly main: IDshSplitRect;
	/** 主栏与内容区之间那条缝（没有右侧格子时为 undefined）。 */
	readonly mainDivider: IDshSplitRect | undefined;
	readonly panes: readonly IDshChromePane[];
	readonly dividers: readonly IDshDividerBar[];
	readonly maxId: string | undefined;
	readonly count: number;
	readonly maxCount: number;
	readonly narrowTip: string | undefined;
}

export interface IDshSplitChromeActions {
	move(sourceId: string, targetId: string, zone: DshDropTarget): void;
	close(id: string): void;
	split(id: string, zone: DshDropZone): void;
	toggleMax(id: string): void;
	resizeDivider(divider: IDshDividerBar, pointer: number, commit: boolean): void;
	equalizeDivider(divider: IDshDividerBar): void;
	resizeMain(mainWidth: number, commit: boolean): void;
	resetMain(): void;
	/** 拖动中的"挖洞"：目标格让出落点那一半（undefined = 恢复）。 */
	hole(hole: { id: string; zone: DshDropTarget } | undefined): void;
	menuItems(id: string): IContextMenuItem[];
	undo(): void;
	log(message: string): void;
}

interface IHeadEls {
	readonly root: HTMLElement;
	readonly title: HTMLElement;
	readonly meta: HTMLElement;
	readonly maxBtn: HTMLElement;
}

type DropHit = { readonly reject: true; readonly label: string } | { readonly reject: false; readonly id: string; readonly zone: DshDropTarget; readonly rect: IDshSplitRect; readonly label: string };

const ZONE_CN: Record<DshDropZone, string> = { left: '左侧', right: '右侧', top: '上方', bottom: '下方' };

export class DshDesktopSplitChrome {
	private readonly _heads = new Map<string, IHeadEls>();
	private readonly _dividerEls: HTMLElement[] = [];
	private readonly _mainDividerEl: HTMLElement | undefined;
	private readonly _hintEl: HTMLElement | undefined;
	private _statusEl: HTMLElement | undefined;
	private _countEl: HTMLElement | undefined;
	private _narrowEl: HTMLElement | undefined;
	private _model: IDshChromeModel | undefined;
	private _dragging = false;
	private _toastTimer: ReturnType<typeof setTimeout> | undefined;
	private _statusSticky = false;

	constructor(
		private readonly _win: Window,
		private readonly _container: HTMLElement,
		private readonly _actions: IDshSplitChromeActions,
	) {
		this._mainDividerEl = this._el('div', 'data-vssaros-main-divider',
			'position:absolute;display:none;z-index:6;cursor:col-resize;pointer-events:auto;background:transparent;');
		if (this._mainDividerEl) {
			this._mainDividerEl.title = '拖动调整主栏宽度 · 双击复位';
			this._wireMainDivider(this._mainDividerEl);
		}
		this._hintEl = this._el('div', 'data-vssaros-drop-hint',
			'position:absolute;display:none;z-index:8;pointer-events:none;box-sizing:border-box;border-radius:8px;'
			+ 'border:2px dashed var(--vscode-focusBorder, #5b8cff);background:rgba(91,140,255,.14);'
			+ 'align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--vscode-focusBorder, #86a9ff);');
		this._installTitleExtras();
	}

	/** 当前的拖动状态（自测 / 日志用）。 */
	get dragging(): boolean { return this._dragging; }

	/** 标题栏 / 分隔条元素（自测走真实 DOM 输入路径用）。 */
	headOf(id: string): HTMLElement | undefined { return this._heads.get(id)?.root; }
	buttonOf(id: string, act: string): HTMLElement | undefined {
		return this._heads.get(id)?.root.querySelector(`[data-vssaros-pane-act="${act}"]`) as HTMLElement | undefined ?? undefined;
	}
	get dividerEls(): readonly HTMLElement[] { return this._dividerEls.filter(e => e.style.display !== 'none'); }
	/** 某条分隔条元素对应的模型（方向 / 所属节点）。 */
	dividerOf(el: HTMLElement): IDshDividerBar | undefined { return this._model?.dividers[Number(el.dataset.idx)]; }
	get mainDividerEl(): HTMLElement | undefined { return this._mainDividerEl; }
	get undoButton(): HTMLElement | undefined { return this._statusEl?.querySelector('[data-vssaros-undo]') as HTMLElement | undefined ?? undefined; }

	update(model: IDshChromeModel): void {
		this._model = model;
		const ox = model.origin.x;
		const oy = model.origin.y;
		const live = new Set(model.panes.map(p => p.id));
		for (const [id, els] of this._heads) {
			if (!live.has(id)) { els.root.remove(); this._heads.delete(id); }
		}
		for (const p of model.panes) {
			const els = this._ensureHead(p.id);
			if (!els) { continue; }
			const h = p.geo.head;
			els.root.style.display = 'flex';
			els.root.style.left = (h.x - ox) + 'px';
			els.root.style.top = (h.y - oy) + 'px';
			els.root.style.width = h.width + 'px';
			els.root.style.height = h.height + 'px';
			els.title.textContent = p.title;
			els.meta.textContent = h.width >= 300 ? p.meta : '';
			const maxed = model.maxId === p.id;
			els.maxBtn.className = 'codicon ' + (maxed ? 'codicon-screen-normal' : 'codicon-screen-full');
			els.maxBtn.title = maxed ? '还原（双击标题栏）' : '最大化（双击标题栏）';
			els.maxBtn.style.display = h.width >= 260 ? 'inline-flex' : 'none';
		}
		model.dividers.forEach((d, i) => {
			const el = this._dividerEls[i] ?? this._newDivider();
			if (!el) { return; }
			el.style.display = 'block';
			el.style.cursor = d.dir === 'h' ? 'col-resize' : 'row-resize';
			el.style.left = (d.bar.x - ox) + 'px';
			el.style.top = (d.bar.y - oy) + 'px';
			el.style.width = d.bar.width + 'px';
			el.style.height = d.bar.height + 'px';
			el.dataset.idx = String(i);
		});
		for (let i = model.dividers.length; i < this._dividerEls.length; i++) { this._dividerEls[i].style.display = 'none'; }
		if (this._mainDividerEl) {
			const m = model.mainDivider;
			this._mainDividerEl.style.display = m ? 'block' : 'none';
			if (m) {
				this._mainDividerEl.style.left = (m.x - ox) + 'px';
				this._mainDividerEl.style.top = (m.y - oy) + 'px';
				this._mainDividerEl.style.width = m.width + 'px';
				this._mainDividerEl.style.height = m.height + 'px';
			}
		}
		if (this._countEl) {
			this._countEl.textContent = model.count > 0 ? `窗格 ${model.count} / ${model.maxCount}` : '';
		}
		if (this._narrowEl) {
			this._narrowEl.textContent = model.narrowTip ?? '';
			this._narrowEl.style.display = model.narrowTip ? 'inline' : 'none';
		}
	}

	/** 标题条里的提示（可带「撤销」）。 */
	toast(message: string, undoable: boolean): void {
		const s = this._statusEl;
		if (!s) { return; }
		this._statusSticky = false;
		s.textContent = '';
		s.style.color = '';
		const text = this._el('span', undefined, 'overflow:hidden;text-overflow:ellipsis;', s);
		if (text) { text.textContent = message; }
		if (undoable) {
			const b = this._el('button', 'data-vssaros-undo',
				'margin-left:10px;padding:1px 10px;border-radius:5px;border:0;cursor:pointer;pointer-events:auto;'
				+ '-webkit-app-region:no-drag;font:inherit;font-weight:600;'
				+ 'background:var(--vscode-button-secondaryBackground, rgba(91,140,255,.2));color:var(--vscode-button-secondaryForeground, #86a9ff);', s);
			if (b) {
				b.textContent = '撤销';
				b.addEventListener('click', () => { this.clearStatus(); this._actions.undo(); });
			}
		}
		if (this._toastTimer) { clearTimeout(this._toastTimer); }
		this._toastTimer = setTimeout(() => { if (!this._statusSticky) { this.clearStatus(); } }, 6000);
	}

	clearStatus(): void {
		if (this._statusEl) { this._statusEl.textContent = ''; this._statusEl.style.color = ''; }
	}

	dispose(): void {
		if (this._toastTimer) { clearTimeout(this._toastTimer); }
		for (const els of this._heads.values()) { els.root.remove(); }
		this._heads.clear();
		for (const el of this._dividerEls) { el.remove(); }
		this._mainDividerEl?.remove();
		this._hintEl?.remove();
		this._statusEl?.remove();
		this._countEl?.remove();
		this._narrowEl?.remove();
	}

	// ---- 内部 ---------------------------------------------------------------------------------

	/** 用**主窗口** document 建元素并挂到容器（或给定父节点）。 */
	private _el(tag: string, anchor: string | undefined, css: string, parent: HTMLElement = this._container): HTMLElement | undefined {
		try {
			const el = mainWindow.document.createElement(tag);
			if (anchor) { el.setAttribute(anchor, '1'); }
			el.style.cssText = css;
			parent.appendChild(el);
			return el;
		} catch (err) {
			this._actions.log('[dshHarness] split chrome: 建元素失败：' + String((err as Error)?.message ?? err));
			return undefined;
		}
	}

	private _installTitleExtras(): void {
		let bar: HTMLElement | null = null;
		try { bar = this._container.querySelector('.vssaros-desk-titlebar'); } catch { bar = null; }
		if (!bar) { return; }
		this._statusEl = this._el('span', 'data-vssaros-split-status',
			'flex:1;min-width:0;display:flex;align-items:center;justify-content:center;overflow:hidden;white-space:nowrap;font-size:12px;', bar);
		this._narrowEl = this._el('span', 'data-vssaros-split-narrow', 'display:none;flex:none;font-size:11px;color:#e3a33b;', bar);
		this._countEl = this._el('span', 'data-vssaros-split-count', 'flex:none;font-size:11px;opacity:.7;margin-right:150px;', bar);
	}

	private _ensureHead(id: string): IHeadEls | undefined {
		const existing = this._heads.get(id);
		if (existing) { return existing; }
		const root = this._el('div', 'data-vssaros-pane-head',
			'position:absolute;display:none;z-index:5;box-sizing:border-box;align-items:center;gap:6px;padding:0 4px 0 8px;'
			+ 'cursor:grab;pointer-events:auto;user-select:none;font-size:12px;overflow:hidden;'
			+ 'background:var(--vscode-editorGroupHeader-tabsBackground, #1b1c20);'
			+ 'border-bottom:1px solid var(--vscode-editorGroupHeader-tabsBorder, var(--vscode-panel-border, rgba(128,128,128,.25)));'
			+ 'color:var(--vscode-foreground, #e7e8ea);');
		if (!root) { return undefined; }
		root.setAttribute('data-vssaros-pane-head', id);
		root.title = '拖动标题栏移动这一格 · 双击最大化 · 右键更多';
		const grip = this._el('span', undefined, 'flex:none;opacity:.55;font-size:14px;', root);
		if (grip) { grip.className = 'codicon codicon-gripper'; }
		const title = this._el('span', undefined, 'flex:0 1 auto;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', root)!;
		const meta = this._el('span', undefined, 'flex:none;opacity:.5;font:11px ui-monospace,Consolas,monospace;', root)!;
		this._el('span', undefined, 'flex:1;', root);
		const btn = (act: string, icon: string, tip: string, onClick: () => void): HTMLElement => {
			const b = this._el('button', undefined,
				'flex:none;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0;'
				+ 'border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;pointer-events:auto;opacity:.75;', root)!;
			b.setAttribute('data-vssaros-pane-act', act);
			b.className = 'codicon ' + icon;
			b.title = tip;
			b.addEventListener('mouseenter', () => { b.style.background = act === 'close' ? 'rgba(239,93,106,.18)' : 'var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2))'; b.style.opacity = '1'; });
			b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; b.style.opacity = '.75'; });
			b.addEventListener('mousedown', e => e.stopPropagation());
			b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
			return b;
		};
		btn('split-right', 'codicon-split-horizontal', '向右拆分', () => this._actions.split(id, 'right'));
		btn('split-down', 'codicon-split-vertical', '向下拆分', () => this._actions.split(id, 'bottom'));
		const maxBtn = btn('max', 'codicon-screen-full', '最大化（双击标题栏）', () => this._actions.toggleMax(id));
		btn('close', 'codicon-close', '关闭这一格（会话不会删除，可撤销）', () => this._actions.close(id));
		root.addEventListener('mousedown', e => {
			if (e.button !== 0) { return; }
			e.preventDefault();
			this._startDrag(id, e.clientX, e.clientY);
		});
		root.addEventListener('dblclick', e => {
			if ((e.target as HTMLElement | null)?.closest?.('button')) { return; }
			this._actions.toggleMax(id);
		});
		root.addEventListener('contextmenu', e => {
			e.preventDefault();
			this._popupMenu(id, e.clientX, e.clientY);
		});
		const els: IHeadEls = { root, title, meta, maxBtn };
		this._heads.set(id, els);
		return els;
	}

	private _popupMenu(id: string, x: number, y: number): void {
		const zoom = this._model?.zoom ?? 1;
		try {
			popup(this._actions.menuItems(id), { x: Math.round(x * zoom), y: Math.round(y * zoom) });
		} catch (err) {
			this._actions.log('[dshHarness] split chrome: 原生菜单弹不出来：' + String((err as Error)?.message ?? err));
		}
	}

	private _newDivider(): HTMLElement | undefined {
		const el = this._el('div', 'data-vssaros-splitbar',
			'position:absolute;display:none;z-index:6;pointer-events:auto;cursor:col-resize;background:transparent;');
		if (!el) { return undefined; }
		el.title = '拖动调整大小 · 双击均分';
		el.addEventListener('mouseenter', () => { el.style.background = 'var(--vscode-sash-hoverBorder, #5b8cff)'; });
		el.addEventListener('mouseleave', () => { if (!this._dragging) { el.style.background = 'transparent'; } });
		el.addEventListener('mousedown', e => {
			if (e.button !== 0) { return; }
			const d = this._model?.dividers[Number(el.dataset.idx)];
			if (!d) { return; }
			e.preventDefault();
			this._trackPointer(
				ev => this._actions.resizeDivider(d, d.dir === 'h' ? ev.clientX : ev.clientY, false),
				ev => { el.style.background = 'transparent'; this._actions.resizeDivider(d, d.dir === 'h' ? ev.clientX : ev.clientY, true); },
			);
		});
		el.addEventListener('dblclick', () => {
			const d = this._model?.dividers[Number(el.dataset.idx)];
			if (d) { this._actions.equalizeDivider(d); }
		});
		this._dividerEls.push(el);
		return el;
	}

	private _wireMainDivider(el: HTMLElement): void {
		el.addEventListener('mouseenter', () => { el.style.background = 'var(--vscode-sash-hoverBorder, #5b8cff)'; });
		el.addEventListener('mouseleave', () => { if (!this._dragging) { el.style.background = 'transparent'; } });
		el.addEventListener('mousedown', e => {
			if (e.button !== 0 || !this._model) { return; }
			e.preventDefault();
			const left = this._model.main.x;
			this._trackPointer(
				ev => this._actions.resizeMain(ev.clientX - left, false),
				ev => { el.style.background = 'transparent'; this._actions.resizeMain(ev.clientX - left, true); },
			);
		});
		el.addEventListener('dblclick', () => this._actions.resetMain());
	}

	/** 按下后跟踪指针直到松开（监听挂在 aux 窗口上 ⇒ 指针移到原生视图上方也收得到）。 */
	private _trackPointer(onMove: (e: MouseEvent) => void, onUp: (e: MouseEvent) => void): void {
		this._dragging = true;
		const move = (e: MouseEvent) => onMove(e);
		const up = (e: MouseEvent) => {
			this._win.removeEventListener('mousemove', move, true);
			this._win.removeEventListener('mouseup', up, true);
			this._dragging = false;
			onUp(e);
		};
		this._win.addEventListener('mousemove', move, true);
		this._win.addEventListener('mouseup', up, true);
	}

	private _startDrag(sourceId: string, sx: number, sy: number): void {
		let active = false;
		let hit: DropHit | undefined;
		let lastKey = '';
		let done = false;
		const title = this._heads.get(sourceId)?.title.textContent ?? '';
		const finish = (commit: boolean, why: string) => {
			if (done) { return; }
			done = true;
			this._win.removeEventListener('mousemove', move, true);
			this._win.removeEventListener('mouseup', up, true);
			this._win.removeEventListener('keydown', key, true);
			this._dragging = false;
			this._hideHint();
			this._statusSticky = false;
			this.clearStatus();
			if (!active) { return; }
			this._actions.hole(undefined);
			if (!commit) { this._actions.log(`[dshHarness] pane drag: 取消（${why}）`); return; }
			if (!hit) { this._actions.log('[dshHarness] pane drag: 松在空白处 ⇒ 回到原位'); return; }
			if (hit.reject) { this._actions.log('[dshHarness] pane drag: 拒绝 —— ' + hit.label); this.toast(hit.label, false); return; }
			this._actions.move(sourceId, hit.id, hit.zone);
		};
		const move = (e: MouseEvent) => {
			if (!active) {
				if (Math.hypot(e.clientX - sx, e.clientY - sy) < DRAG_THRESHOLD) { return; }
				active = true;
				this._dragging = true;
			}
			hit = this._hitTest(sourceId, e.clientX, e.clientY);
			const k = !hit ? '-' : hit.reject ? 'x' : `${hit.id}:${hit.zone}`;
			if (k === lastKey) { return; }
			lastKey = k;
			this._statusSticky = true;
			this._setStatus(hit ? hit.label : `正在移动「${title}」：拖到某一格的边缘 = 拆到那一侧，中央 = 交换；Esc 取消`, !!hit?.reject);
			if (hit && !hit.reject) {
				this._actions.hole({ id: hit.id, zone: hit.zone });
				this._showHint(hit.rect, hit.label);
			} else {
				this._actions.hole(undefined);
				this._hideHint();
			}
		};
		const up = () => finish(true, 'mouseup');
		const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); finish(false, 'Esc'); } };
		this._win.addEventListener('mousemove', move, true);
		this._win.addEventListener('mouseup', up, true);
		this._win.addEventListener('keydown', key, true);
	}

	private _hitTest(sourceId: string, x: number, y: number): DropHit | undefined {
		const m = this._model;
		if (!m) { return undefined; }
		const inside = (r: IDshSplitRect) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
		if (inside(m.main)) { return { reject: true, label: '主栏固定在左侧，不能放这里' }; }
		for (const p of m.panes) {
			if (p.id === sourceId || !inside(p.geo.box)) { continue; }
			const zone = pickDropTarget(p.geo.box, x, y);
			if (!zone) { continue; }
			const label = zone === 'center' ? `松手：与「${p.title}」交换位置` : `松手：放到「${p.title}」${ZONE_CN[zone]}`;
			return { reject: false, id: p.id, zone, rect: dropHintRect(p.geo.box, zone), label };
		}
		return undefined;
	}

	private _setStatus(text: string, reject: boolean): void {
		if (!this._statusEl) { return; }
		this._statusEl.textContent = text;
		this._statusEl.style.color = reject ? '#ef5d6a' : 'var(--vscode-focusBorder, #86a9ff)';
	}

	private _showHint(r: IDshSplitRect, label: string): void {
		const el = this._hintEl;
		const m = this._model;
		if (!el || !m) { return; }
		el.textContent = label;
		el.style.display = 'flex';
		el.style.left = (r.x - m.origin.x + 3) + 'px';
		el.style.top = (r.y - m.origin.y + 3) + 'px';
		el.style.width = Math.max(0, r.width - 6) + 'px';
		el.style.height = Math.max(0, r.height - 6) + 'px';
	}

	private _hideHint(): void {
		if (this._hintEl) { this._hintEl.style.display = 'none'; }
	}
}
