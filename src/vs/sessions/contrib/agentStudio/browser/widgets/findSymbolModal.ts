/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Find Symbol 模态对话框（对齐 Visual Studio / Visual Assist X 的 Find Symbol in Solution）。
 *
 *  - 标题：Find Symbol
 *  - 提示：当前匹配计数 [N of M]（动态更新）
 *  - 内容：搜索框（防抖 150ms）+ 双列表格（Symbol | Definition）
 *  - 底部：复选框（Show only symbols defined in current solution / Only classes, structs & namespaces）
 *  - 按钮：OK（跳转定义）/ Cancel
 *  - 键盘：↑↓ 移动选择、Enter 触发 OK、Esc 关闭
 *
 * 数据源：ICodebaseGraphService.searchGraphAsync + getCodeSnippet（Definition 列第一行源码预览）
 */

import * as dom from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICodebaseGraphService, GraphNode } from '../codebaseGraphService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ITextEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { CodebaseGraphModal } from './codebaseGraphModal.js';

const NODE_TYPE_CODICON: Record<string, string> = {
	'function': '$(symbol-method)',
	'class': '$(symbol-class)',
	'interface': '$(symbol-interface)',
	'enum': '$(symbol-enum)',
	'variable': '$(symbol-variable)',
	'module': '$(symbol-namespace)',
};

export class FindSymbolModal {

	private _modal!: CodebaseGraphModal;
	private _searchInput!: HTMLInputElement;
	private _table!: HTMLElement;
	private _titleHint!: HTMLElement;
	private _onlyCurrentSol!: HTMLInputElement;
	private _onlyClasses!: HTMLInputElement;
	private _rows: GraphNode[] = [];
	private _selectedIndex = 0;
	private _disposables = new DisposableStore();
	private _searchToken = 0;
	private _initialQuery = '';
	private _disposed = false;

	constructor(
		@ICodebaseGraphService private readonly _graphService: ICodebaseGraphService,
		@IFileService private readonly _fileService: IFileService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
	}

	open(initialQuery?: string): void {
		this._initialQuery = initialQuery ?? '';
		this._modal = new CodebaseGraphModal({
			title: localize('findSymbol.title', 'Find Symbol'),
			width: 760,
			height: 520,
			renderBody: (body) => this._renderBody(body),
			onOk: () => { void this._accept(); },
			onDispose: () => this.dispose(),
		});
		// 用初始 query（光标单词）触发首次搜索
		this._scheduleSearch();
	}

	private _renderBody(root: HTMLElement): void {
		// 搜索框
		this._searchInput = dom.$('input') as HTMLInputElement;
		this._searchInput.type = 'text';
		this._searchInput.placeholder = localize('findSymbol.search.placeholder', 'Type symbol name…');
		this._searchInput.setAttribute('data-modal-initial-focus', 'true');
		this._searchInput.style.cssText = 'flex:0 0 auto;width:calc(100% - 24px);margin:12px 12px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:6px 10px;border-radius:2px;font-size:14px;outline:none;';
		// 自动填充光标位置的单词
		this._searchInput.value = this._initialQuery;
		root.appendChild(this._searchInput);

		// 计数提示（在 modal title 旁，renderBody 内先占位，由 modal 注入到 title 栏：先存到 _titleHint）
		// 实际我们让 _titleHint 直接放在 search 下：不需要模态 title 栏（modal title 已是 Find Symbol）。
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

		this._onlyCurrentSol = this._makeCheckbox(checkRow, localize('findSymbol.onlyCurrentSol', 'Show only symbols defined in current solution'));
		this._onlyClasses = this._makeCheckbox(checkRow, localize('findSymbol.onlyClasses', 'Only classes, structs & namespaces'));
		root.appendChild(checkRow);

		// 事件
		this._disposables.add(dom.addDisposableListener(this._searchInput, 'input', () => this._scheduleSearch()));
		this._disposables.add(dom.addStandardDisposableListener(this._searchInput, dom.EventType.KEY_DOWN, (e) => {
			const key = e.browserEvent.key;
			if (key === 'ArrowDown') { e.preventDefault(); this._moveSelection(1); }
			else if (key === 'ArrowUp') { e.preventDefault(); this._moveSelection(-1); }
			else if (key === 'Home') { e.preventDefault(); this._selectIndex(0); }
			else if (key === 'End') { e.preventDefault(); this._selectIndex(this._rows.length - 1); }
		}));
		this._disposables.add(dom.addDisposableListener(this._onlyCurrentSol, 'change', () => this._scheduleSearch()));
		this._disposables.add(dom.addDisposableListener(this._onlyClasses, 'change', () => this._scheduleSearch()));
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

	private _scheduleSearch(): void {
		const token = ++this._searchToken;
		setTimeout(() => { void this._doSearch(token); }, 150);
	}

	private async _doSearch(token: number): Promise<void> {
		if (token !== this._searchToken) { return; } // 过期
		const raw = this._searchInput.value;
		let labelFilter: string | undefined;
		let query = raw.trim();
		if (this._onlyClasses.checked) {
			labelFilter = 'class';
		}
		// 支持类型前缀
		for (const [prefix, label] of [['class:', 'class'], ['method:', 'function'], ['func:', 'function'], ['var:', 'variable'], ['enum:', 'enum'], ['interface:', 'interface'], ['type:', 'class']] as const) {
			if (query.startsWith(prefix)) {
				labelFilter = label;
				query = query.slice(prefix.length).trim();
				break;
			}
		}
		if (!query) {
			this._rows = [];
			this._renderTable();
			return;
		}
		const results = await this._graphService.searchGraphAsync({
			namePattern: query,
			label: labelFilter,
			limit: 200,
		});
		if (token !== this._searchToken) { return; }
		const nodes = (results.nodes || []).filter(n => this._matchesFilter(n));
		this._rows = nodes;
		this._selectedIndex = 0;
		this._renderTable();
	}

	private _matchesFilter(n: GraphNode): boolean {
		if (this._onlyCurrentSol.checked) {
			const project = (n as any).project;
			// 简单把"当前 solution"理解为默认 project
			if (project && project !== '_default') { return false; }
		}
		if (this._onlyClasses.checked) {
			if (n.type !== 'class' && n.type !== 'interface' && (n.label !== 'class' && n.label !== 'interface')) {
				return false;
			}
		}
		return true;
	}

	private _renderTable(): void {
		dom.reset(this._table);
		this._titleHint.textContent = this._rows.length > 0
			? localize('findSymbol.hint', '[1 of {0}]', this._rows.length)
			: '';

		// 表头
		const header = dom.$('div');
		header.style.cssText = 'display:flex;position:sticky;top:0;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-editorWidget-border);font-weight:bold;';
		const hSymbol = dom.$('div');
		hSymbol.textContent = localize('findSymbol.col.symbol', 'Symbol');
		hSymbol.style.cssText = 'flex:1;padding:4px 8px;';
		const hDef = dom.$('div');
		hDef.textContent = localize('findSymbol.col.definition', 'Definition');
		hDef.style.cssText = 'flex:1;padding:4px 8px;';
		header.appendChild(hSymbol);
		header.appendChild(hDef);
		this._table.appendChild(header);

		// 行
		for (let i = 0; i < this._rows.length; i++) {
			const n = this._rows[i];
			const row = dom.$('div');
			row.style.cssText = 'display:flex;align-items:flex-start;padding:3px 8px;cursor:pointer;';
			if (i === this._selectedIndex) { row.style.background = 'var(--vscode-list-activeSelectionBackground)'; row.style.color = 'var(--vscode-list-activeSelectionForeground)'; }

			const symbolCell = dom.$('div');
			symbolCell.style.cssText = 'flex:1;display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;';
			const icon = dom.$('span');
			icon.textContent = NODE_TYPE_CODICON[n.type] ?? '$(symbol-misc)';
			icon.style.cssText = 'flex:0 0 auto;opacity:.8;';
			symbolCell.appendChild(icon);
			const name = dom.$('span');
			name.textContent = n.name;
			name.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
			symbolCell.appendChild(name);
			row.appendChild(symbolCell);

			const defCell = dom.$('div');
			defCell.style.cssText = 'flex:1;min-width:0;white-space:normal;word-break:break-all;color:var(--vscode-descriptionForeground);';
			// Definition 列：使用节点类型 + name + 文件位置作为轻量预览
			// （不做完整 source preview 以避免 N+1 IO，保持模态响应性）
			defCell.textContent = `${n.type ?? n.label ?? ''} ${n.name}` + (n.filePath ? `  —  ${n.filePath}:${n.startLine ?? ''}` : '');
			row.appendChild(defCell);

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
		// 重新渲染选择样式
		const rows = this._table.querySelectorAll<HTMLElement>(':scope > div:nth-child(n+2)');
		rows.forEach((r, idx) => {
			if (idx === i) { r.style.background = 'var(--vscode-list-activeSelectionBackground)'; r.style.color = 'var(--vscode-list-activeSelectionForeground)'; }
			else { r.style.background = 'transparent'; r.style.color = ''; }
		});
		// 滚动到视口
		rows[i]?.scrollIntoView({ block: 'nearest' });
	}

	private _moveSelection(delta: number): void {
		if (this._rows.length === 0) { return; }
		const next = Math.max(0, Math.min(this._rows.length - 1, this._selectedIndex + delta));
		this._selectIndex(next);
	}

	private async _accept(): Promise<void> {
		const node = this._rows[this._selectedIndex];
		if (!node) { this._modal?.dispose(); return; }
		await this._openNode(node);
		this._modal?.dispose();
	}

	private async _openNode(node: GraphNode): Promise<void> {
		if (!node.filePath || !node.startLine) { return; }
		const roots = this._graphService.getProjectRoots();
		const root = roots[(node as any).project ?? '_default'];
		if (!root) { return; }
		const uri = joinPath(URI.file(root), node.filePath);
		try {
			if (!await this._fileService.exists(uri)) { return; }
		} catch { return; }
		const line = Math.max(0, node.startLine - 1);
		const options: ITextEditorOptions = {
			selection: { startLineNumber: line + 1, startColumn: 1, endLineNumber: line + 1, endColumn: 1 },
			revealIfOpened: true,
			pinned: false,
		};
		await this._editorService.openEditor({ resource: uri, options });
	}

	dispose(): void {
		if (this._disposed) { return; }
		this._disposed = true;
		this._disposables.dispose();
		this._modal?.dispose();
	}
}
