/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Open File in Solution 模态对话框（对齐 Visual Studio / Visual Assist X 的 Open File in Solution）。
 *
 *  - 标题：Open File in Solution
 *  - 提示：当前匹配计数 [N of M]（动态更新）
 *  - 内容：搜索框（防抖 150ms）+ 三列表格（File | Project | Path）
 *  - 底部：复选框（Show only files in the current solution）
 *  - 按钮：OK（打开文件）/ Cancel
 *  - 键盘：↑↓ 移动选择、Enter 触发 OK、Esc 关闭
 *
 * 数据源：ICodebaseGraphService.listIndexedFilePaths
 * 模糊匹配：query 与 basename 或 filePath 的不区分大小写包含
 */

import * as dom from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { basename as pathBasename } from '../../../../../base/common/path.js';
import { ICodebaseGraphService } from '../codebaseGraphService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { CodebaseGraphModal } from './codebaseGraphModal.js';

interface IFileItem {
	filePath: string;
	project: string;
	name: string;
}

const FILE_EXT_CODICON: Record<string, string> = {
	'.cpp': '$(file-code)', '.cc': '$(file-code)', '.cxx': '$(file-code)',
	'.h': '$(file-code)', '.hpp': '$(file-code)', '.hxx': '$(file-code)',
	'.c': '$(file-code)',
	'.ts': '$(file-code)', '.tsx': '$(file-code)',
	'.js': '$(file-code)', '.jsx': '$(file-code)',
	'.lua': '$(file-code)',
	'.py': '$(file-code)',
	'.json': '$(json)',
	'.md': '$(markdown)',
	'.txt': '$(file-text)',
	'.xml': '$(file)',
	'.yml': '$(file)', '.yaml': '$(file)',
};

function iconFor(filePath: string): string {
	const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
	return FILE_EXT_CODICON[ext] ?? '$(file)';
}

export class OpenFileModal {

	private _modal!: CodebaseGraphModal;
	private _searchInput!: HTMLInputElement;
	private _table!: HTMLElement;
	private _titleHint!: HTMLElement;
	private _onlyCurrentSol!: HTMLInputElement;
	private _allFiles: IFileItem[] = [];
	private _rows: IFileItem[] = [];
	private _selectedIndex = 0;
	private _disposables = new DisposableStore();
	private _searchToken = 0;
	private _loaded = false;

	constructor(
		@ICodebaseGraphService private readonly _graphService: ICodebaseGraphService,
		@IFileService private readonly _fileService: IFileService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
	}

	async open(): Promise<void> {
		this._modal = new CodebaseGraphModal({
			title: localize('openFile.title', 'Open File in Solution'),
			width: 780,
			height: 520,
			renderBody: (body) => this._renderBody(body),
			onOk: () => { void this._accept(); },
		});
		void this._loadFiles();
	}

	private async _loadFiles(): Promise<void> {
		try {
			const files = await this._graphService.listIndexedFilePaths();
			this._allFiles = (files || []).map((f: any) => ({
				filePath: f.filePath,
				project: f.project,
				name: pathBasename(f.filePath),
			}));
			this._loaded = true;
			this._filter();
		} catch {
			this._allFiles = [];
			this._loaded = true;
			this._filter();
		}
	}

	private _renderBody(root: HTMLElement): void {
		// 搜索框
		this._searchInput = dom.$('input') as HTMLInputElement;
		this._searchInput.type = 'text';
		this._searchInput.placeholder = localize('openFile.search.placeholder', 'Type file name…');
		this._searchInput.setAttribute('data-modal-initial-focus', 'true');
		this._searchInput.style.cssText = 'flex:0 0 auto;width:calc(100% - 24px);margin:12px 12px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:6px 10px;border-radius:2px;font-size:14px;outline:none;';
		root.appendChild(this._searchInput);

		// 计数提示
		this._titleHint = dom.$('div');
		this._titleHint.textContent = '';
		this._titleHint.style.cssText = 'flex:0 0 auto;padding:0 16px 6px;font-size:12px;color:var(--vscode-descriptionForeground);';
		root.appendChild(this._titleHint);

		// 表格
		this._table = dom.$('div');
		this._table.style.cssText = 'flex:1 1 auto;overflow:auto;border-top:1px solid var(--vscode-editorWidget-border);border-bottom:1px solid var(--vscode-editorWidget-border);';
		root.appendChild(this._table);

		// 复选框
		const checkRow = dom.$('div');
		checkRow.style.cssText = 'flex:0 0 auto;display:flex;gap:18px;padding:8px 12px;font-size:12px;';
		this._onlyCurrentSol = this._makeCheckbox(checkRow, localize('openFile.onlyCurrentSol', 'Show only files in the current solution'));
		this._onlyCurrentSol.checked = true;
		root.appendChild(checkRow);

		// 事件
		this._disposables.add(dom.addDisposableListener(this._searchInput, 'input', () => this._scheduleFilter()));
		this._disposables.add(dom.addStandardDisposableListener(this._searchInput, dom.EventType.KEY_DOWN, (e) => {
			const key = e.browserEvent.key;
			if (key === 'ArrowDown') { e.preventDefault(); this._moveSelection(1); }
			else if (key === 'ArrowUp') { e.preventDefault(); this._moveSelection(-1); }
			else if (key === 'Home') { e.preventDefault(); this._selectIndex(0); }
			else if (key === 'End') { e.preventDefault(); this._selectIndex(this._rows.length - 1); }
		}));
		this._disposables.add(dom.addDisposableListener(this._onlyCurrentSol, 'change', () => this._filter()));
	}

	private _makeCheckbox(parent: HTMLElement, label: string): HTMLInputElement {
		const wrap = dom.$('label');
		wrap.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;';
		const cb = dom.$('input') as HTMLInputElement;
		cb.type = 'checkbox';
		cb.style.cssText = 'margin:0;';
		const span = dom.$('span');
		span.textContent = label;
		wrap.appendChild(cb);
		wrap.appendChild(span);
		parent.appendChild(wrap);
		return cb;
	}

	private _scheduleFilter(): void {
		const token = ++this._searchToken;
		setTimeout(() => { if (token === this._searchToken) { this._filter(); } }, 150);
	}

	private _filter(): void {
		const q = this._searchInput?.value?.toLowerCase().trim() ?? '';
		const onlyCurrent = this._onlyCurrentSol?.checked ?? true;
		this._rows = this._allFiles.filter(f => {
			if (onlyCurrent && f.project && f.project !== '_default') { return false; }
			if (!q) { return true; }
			return f.name.toLowerCase().includes(q) || f.filePath.toLowerCase().includes(q);
		});
		this._selectedIndex = 0;
		this._renderTable();
	}

	private _renderTable(): void {
		dom.reset(this._table);
		this._titleHint.textContent = this._rows.length > 0
			? localize('openFile.hint', '[1 of {0}{1}]', this._rows.length, this._loaded ? '' : ' …')
			: (this._loaded ? '' : localize('openFile.loading', 'Loading…'));

		// 表头
		const header = dom.$('div');
		header.style.cssText = 'display:flex;position:sticky;top:0;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-editorWidget-border);font-weight:bold;';
		const hFile = dom.$('div');
		hFile.textContent = localize('openFile.col.file', 'File');
		hFile.style.cssText = 'flex:2;padding:4px 8px;';
		const hProj = dom.$('div');
		hProj.textContent = localize('openFile.col.project', 'Project');
		hProj.style.cssText = 'flex:1;padding:4px 8px;';
		const hPath = dom.$('div');
		hPath.textContent = localize('openFile.col.path', 'Path');
		hPath.style.cssText = 'flex:3;padding:4px 8px;';
		header.appendChild(hFile);
		header.appendChild(hProj);
		header.appendChild(hPath);
		this._table.appendChild(header);

		const display = this._rows.slice(0, 500); // 防止渲染过多
		for (let i = 0; i < display.length; i++) {
			const file = display[i];
			const row = dom.$('div');
			row.style.cssText = 'display:flex;align-items:center;padding:3px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;';
			if (i === this._selectedIndex) { row.style.background = 'var(--vscode-list-activeSelectionBackground)'; row.style.color = 'var(--vscode-list-activeSelectionForeground)'; }

			const fileCell = dom.$('div');
			fileCell.style.cssText = 'flex:2;display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;';
			const icon = dom.$('span');
			icon.textContent = iconFor(file.filePath);
			icon.style.cssText = 'flex:0 0 auto;opacity:.8;';
			fileCell.appendChild(icon);
			const name = dom.$('span');
			name.textContent = file.name;
			name.title = file.filePath;
			fileCell.appendChild(name);
			row.appendChild(fileCell);

			const projCell = dom.$('div');
			projCell.textContent = file.project;
			projCell.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
			row.appendChild(projCell);

			const pathCell = dom.$('div');
			pathCell.textContent = file.filePath;
			pathCell.title = file.filePath;
			pathCell.style.cssText = 'flex:3;overflow:hidden;text-overflow:ellipsis;color:var(--vscode-descriptionForeground);';
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
		const rows = this._table.querySelectorAll<HTMLElement>(':scope > div:nth-child(n+2)');
		rows.forEach((r, idx) => {
			if (idx === i) { r.style.background = 'var(--vscode-list-activeSelectionBackground)'; r.style.color = 'var(--vscode-list-activeSelectionForeground)'; }
			else { r.style.background = 'transparent'; r.style.color = ''; }
		});
		rows[i]?.scrollIntoView({ block: 'nearest' });
	}

	private _moveSelection(delta: number): void {
		if (this._rows.length === 0) { return; }
		const next = Math.max(0, Math.min(this._rows.length - 1, this._selectedIndex + delta));
		this._selectIndex(next);
	}

	private async _accept(): Promise<void> {
		const file = this._rows[this._selectedIndex];
		if (!file) { this._modal?.dispose(); return; }
		const roots = this._graphService.getProjectRoots();
		const root = roots[file.project ?? '_default'];
		if (!root) { this._modal?.dispose(); return; }
		const uri = joinPath(URI.file(root), file.filePath);
		try {
			if (await this._fileService.exists(uri)) {
				await this._editorService.openEditor({ resource: uri });
			}
		} catch { /* stale */ }
		this._modal?.dispose();
	}

	dispose(): void {
		this._disposables.dispose();
		this._modal?.dispose();
	}
}
