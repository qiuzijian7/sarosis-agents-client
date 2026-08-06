/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Goto Implementation 结果模态框（独立 UI 展示可跳转的候选项，替代 QuickPick）。
 *
 *  - 标题：Implementations of "word" (N)
 *  - 内容：搜索框（防抖 150ms）+ 列表（icon + 名称 + via + file:line）
 *  - 交互：↑↓ 移动选择、Enter/双击/OK 跳转、Esc/Cancel 关闭
 */

import * as dom from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { URI } from '../../../../../base/common/uri.js';
import { CodebaseGraphModal } from './codebaseGraphModal.js';

export interface IImplementationItem {
	label: string;
	description?: string;
	detail?: string;
	uri?: URI;
	line?: number;
}

export class ImplementationsModal {

	private _modal!: CodebaseGraphModal;
	private _searchInput!: HTMLInputElement;
	private _table!: HTMLElement;
	private _titleHint!: HTMLElement;
	private _allItems: IImplementationItem[] = [];
	private _rows: IImplementationItem[] = [];
	private _selectedIndex = 0;
	private _disposables = new DisposableStore();
	private _searchToken = 0;
	private _disposed = false;

	constructor(
		private readonly _editorService: IEditorService,
	) { }

	open(title: string, items: IImplementationItem[]): void {
		this._allItems = items;
		this._modal = new CodebaseGraphModal({
			title,
			width: 720,
			height: 420,
			renderBody: (body) => this._renderBody(body),
			onOk: () => { void this._accept(); },
			onDispose: () => this.dispose(),
		});
		this._filter();
	}

	private _renderBody(root: HTMLElement): void {
		// 搜索框
		this._searchInput = dom.$('input') as HTMLInputElement;
		this._searchInput.type = 'text';
		this._searchInput.placeholder = localize('implModal.search', 'Filter by name or path…');
		this._searchInput.setAttribute('data-modal-initial-focus', 'true');
		this._searchInput.style.cssText = 'flex:0 0 auto;width:calc(100% - 24px);margin:12px 12px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:6px 10px;border-radius:2px;font-size:14px;outline:none;';
		root.appendChild(this._searchInput);

		// 计数提示
		this._titleHint = dom.$('div');
		this._titleHint.style.cssText = 'flex:0 0 auto;padding:0 16px 6px;font-size:12px;color:var(--vscode-descriptionForeground);';
		root.appendChild(this._titleHint);

		// 列表
		this._table = dom.$('div');
		this._table.style.cssText = 'flex:1 1 auto;overflow:auto;border-top:1px solid var(--vscode-editorWidget-border);border-bottom:1px solid var(--vscode-editorWidget-border);';
		root.appendChild(this._table);

		// 事件
		this._disposables.add(dom.addDisposableListener(this._searchInput, 'input', () => this._scheduleFilter()));
		this._disposables.add(dom.addStandardDisposableListener(this._searchInput, dom.EventType.KEY_DOWN, (e) => {
			const key = e.browserEvent.key;
			if (key === 'ArrowDown') { e.preventDefault(); this._moveSelection(1); }
			else if (key === 'ArrowUp') { e.preventDefault(); this._moveSelection(-1); }
			else if (key === 'Enter') { e.preventDefault(); void this._accept(); }
		}));
	}

	private _scheduleFilter(): void {
		const token = ++this._searchToken;
		setTimeout(() => { if (token === this._searchToken) { this._filter(); } }, 150);
	}

	private _filter(): void {
		const q = this._searchInput?.value?.toLowerCase().trim() ?? '';
		this._rows = q
			? this._allItems.filter(it => (it.label ?? '').toLowerCase().includes(q) || (it.detail ?? '').toLowerCase().includes(q))
			: this._allItems.slice();
		this._selectedIndex = 0;
		this._renderTable();
	}

	private _renderTable(): void {
		dom.reset(this._table);
		this._titleHint.textContent = this._rows.length > 0
			? localize('implModal.hint', '[1 of {0}]', this._rows.length)
			: localize('implModal.empty', 'No matches');

		const display = this._rows.slice(0, 500); // 防止渲染过多
		for (let i = 0; i < display.length; i++) {
			const it = display[i];
			const row = dom.$('div');
			row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;';
			if (i === this._selectedIndex) {
				row.style.background = 'var(--vscode-list-activeSelectionBackground)';
				row.style.color = 'var(--vscode-list-activeSelectionForeground)';
			}

			const icon = dom.$('span');
			icon.textContent = '$(type-hierarchy-sub)';
			icon.style.cssText = 'flex:0 0 auto;opacity:.8;';
			row.appendChild(icon);

			const name = dom.$('span');
			name.textContent = (it.label ?? '').replace(/^\$\([^)]*\)\s*/, '');
			name.title = it.detail ?? '';
			name.style.cssText = 'flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;';
			row.appendChild(name);

			const via = dom.$('span');
			via.textContent = it.description ?? '';
			via.style.cssText = 'flex:0 0 auto;opacity:.75;font-size:11px;';
			row.appendChild(via);

			const pathCell = dom.$('span');
			pathCell.textContent = it.detail ?? '';
			pathCell.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;text-align:right;color:var(--vscode-descriptionForeground);';
			row.appendChild(pathCell);

			row.addEventListener('click', () => this._selectIndex(i));
			row.addEventListener('dblclick', () => { this._selectIndex(i); void this._accept(); });
			row.addEventListener('mouseenter', () => { if (i !== this._selectedIndex) { row.style.background = 'var(--vscode-list-hoverBackground)'; } });
			row.addEventListener('mouseleave', () => { if (i !== this._selectedIndex) { row.style.background = 'transparent'; } });

			this._table.appendChild(row);
		}
	}

	private _selectIndex(i: number): void {
		if (i < 0 || i >= this._rows.length) { return; }
		this._selectedIndex = i;
		const rows = this._table.querySelectorAll<HTMLElement>(':scope > div');
		rows.forEach((r, idx) => {
			if (idx === i) {
				r.style.background = 'var(--vscode-list-activeSelectionBackground)';
				r.style.color = 'var(--vscode-list-activeSelectionForeground)';
			} else {
				r.style.background = 'transparent';
				r.style.color = '';
			}
		});
		rows[i]?.scrollIntoView({ block: 'nearest' });
	}

	private _moveSelection(delta: number): void {
		if (this._rows.length === 0) { return; }
		const next = Math.max(0, Math.min(this._rows.length - 1, this._selectedIndex + delta));
		this._selectIndex(next);
	}

	private async _accept(): Promise<void> {
		const it = this._rows[this._selectedIndex];
		if (!it?.uri || !it.line) { this._modal?.dispose(); return; }
		try {
			await this._editorService.openEditor({
				resource: it.uri,
				options: { selection: { startLineNumber: it.line, startColumn: 1 }, revealIfOpened: true },
			});
		} catch { /* stale */ }
		this._modal?.dispose();
	}

	dispose(): void {
		if (this._disposed) { return; }
		this._disposed = true;
		this._disposables.dispose();
		this._modal?.dispose();
	}
}
