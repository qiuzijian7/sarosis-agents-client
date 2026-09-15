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

import './media/findSymbolModal.css';

import * as dom from '../../../../../base/browser/dom.js';
import { renderLabelWithIcons } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICodebaseGraphService, GraphNode } from '../codebaseGraphService.js';
import { NON_SYMBOL_NODE_TYPES } from '../../common/codebaseIndexDefaults.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ITextEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ICodebaseMemoryMcpService } from '../codebaseMemoryMcpService.js';
import { CodebaseGraphModal } from './codebaseGraphModal.js';
import { ensureGraphForUi } from './codebaseGraphAutoBuild.js';

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
		@IEditorService private readonly _editorService: IEditorService,
		// 2026-09-15：无图时自动建图需要读用户索引配置（cbmService）+ 兜底解析索引根
		// （workspaceService）；日志用于「为什么没建成」这类问题的现场排查。
		@ICodebaseMemoryMcpService private readonly _cbmService: ICodebaseMemoryMcpService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
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
		// 全局键盘（document capture）—— 让焦点在 modal 内任何位置（row / checkbox / div）时
		// 也能 ↑↓ 移动选项 + Enter 跳转；过滤 target 必须在 overlay 内，避免干扰其他应用快捷键。
		// 与下方搜索框 listener 形成互补（document capture 优先；若注册失败搜索框 listener 仍可工作）。
		const overlay = (this._modal as unknown as { _overlay?: HTMLElement })._overlay;
		const docKeyHandler = (e: KeyboardEvent) => {
			if (this._disposed || !overlay) { return; }
			if (!overlay.contains(e.target as Node)) { return; }
			if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); this._moveSelection(1); }
			else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); this._moveSelection(-1); }
			else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); this._selectIndex(0); }
			else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); this._selectIndex(this._rows.length - 1); }
			else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); void this._accept(); }
		};
		document.addEventListener('keydown', docKeyHandler, true);
		this._disposables.add({ dispose: () => document.removeEventListener('keydown', docKeyHandler, true) });
		// 用初始 query（光标单词）触发首次搜索
		this._scheduleSearch();
		// 2026-09-15（用户要求）：**无图也照常打开 UI**。以前 `FindGraphSymbolAction.run` 在
		// `hasGraphData()` 上静默 return —— 连这个模态都不弹，用户只看到「按 Alt+Shift+S 没反应」。
		// 现在：无图则自动建图 + 在提示条实时显示进度，建好自动重跑搜索。
		void ensureGraphForUi(
			{
				graphService: this._graphService,
				cbmService: this._cbmService,
				workspaceService: this._workspaceService,
				logService: this._logService,
			},
			{
				setNotice: (text, kind) => this._modal?.setNotice(text, kind),
				refresh: () => this._scheduleSearch(),
			},
			this._disposables,
		);
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
		this._table = dom.$('div.find-symbol-table');
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
			else if (key === 'Enter' && !e.browserEvent.shiftKey) { e.preventDefault(); void this._accept(); }
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
			// 2026-09-15（用户截图）：Find Symbol 是**符号**检索，必须排除 `label='file'` 的
			// CONTAINS 桩节点 —— 否则 200 条候选被 `toolArgsJson.test.ts` 这类**文件名**命中占满，
			// 真正的 `variable`/`function` 被挤出 LIMIT（搜 "test" 时几乎只剩文件名）。
			excludeTypes: NON_SYMBOL_NODE_TYPES,
			// 2026-09-15（用户截图）：搜的是**符号名**，必须只匹配 `name` 列 —— 否则 QN 里的
			// 文件路径会命中（QN = `<相对路径>::<符号名>`，搜 `test` 会返回
			// `…/knowledge/classifyLLM.test.ts::MockClassifyLLM`）。
			nameOnly: true,
		});
		if (token !== this._searchToken) { return; }
		// 「当前 solution」= 当前工作区所有已注册项目（getProjectRoots 键集合）。
		// 旧实现 `project !== '_default'` 一律排除——图谱节点打的是真实项目名（folder
		// basename），'_default' 只是兜底，勾选复选框会把结果全部滤空（同 openFileModal 修复）。
		const solutionProjects = this._onlyCurrentSol.checked
			? new Set(Object.keys(this._graphService.getProjectRoots()))
			: undefined;
		// fail-open：键集合为空（SQLite-only 启动早期）时不过滤，避免全空
		const useSolFilter = !!solutionProjects && solutionProjects.size > 0;
		const nodes = (results.nodes || []).filter(n => this._matchesFilter(n, useSolFilter ? solutionProjects : undefined));
		this._rows = nodes;
		this._selectedIndex = 0;
		this._renderTable();
	}

	private _matchesFilter(n: GraphNode, solutionProjects: Set<string> | undefined): boolean {
		if (solutionProjects) {
			const project = (n as any).project;
			if (project && !solutionProjects.has(project)) { return false; }
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

		// 空结果 + 图谱残缺 → 明确提示（否则用户只能看到空列表，无法判断是「不存在」
		// 还是「图没建好」。2026-09-09：基线 6017 文件 vs 1196 节点的残缺图长期无提示）
		if (this._rows.length === 0) {
			const health = this._graphService.getIndexHealth?.();
			if (health?.deficient && health.message) {
				const warn = dom.$('div');
				warn.textContent = '⚠ ' + health.message;
				warn.style.cssText = 'padding:10px 12px;color:var(--vscode-inputValidation-warningForeground, var(--vscode-descriptionForeground));';
				this._table.appendChild(warn);
				return; // 空结果：无需渲染表头/行
			}
			// 普通空结果（2026-09-15）：区分三种情况 —— 此前都是**纯空白表格**，用户无法判断
			// 是「自己还没输入」「符号不存在」还是「图谱根本没建」。
			const tip = dom.$('div');
			const typed = this._searchInput.value.trim();
			tip.textContent = !typed
				? '输入符号名开始搜索（支持 class: / method: / var: / enum: / interface: 前缀）。'
				: (this._graphService.hasGraphData()
					? `没有匹配「${typed}」的符号。`
					: '代码图谱尚无数据 —— 见上方提示（正在自动构建时，完成后会自动重新搜索）。');
			tip.style.cssText = 'padding:10px 12px;color:var(--vscode-descriptionForeground);';
			this._table.appendChild(tip);
			return;
		}

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
			// $(codicon) 语法必须经 renderLabelWithIcons 解析成图标元素——直接 textContent
			// 会把 '$(symbol-variable)' 当字面文本显示（Bug 2026-09-08，用户截图）。
			for (const el of renderLabelWithIcons(NODE_TYPE_CODICON[n.type] ?? '$(symbol-misc)')) {
				icon.appendChild(typeof el === 'string' ? document.createTextNode(el) : el);
			}
			icon.style.cssText = 'flex:0 0 auto;opacity:.8;';
			symbolCell.appendChild(icon);
			const name = dom.$('span');
			name.textContent = n.name;
			name.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
			symbolCell.appendChild(name);
			row.appendChild(symbolCell);

			const defCell = dom.$('div.find-symbol-def');
			// Definition 列：**固定两行**（2026-09-15 用户要求）
			//   首行 = 类型 + 符号名 + 连接号（分隔符留在首行末尾）
			//   次行 = 文件路径（:行号），完整值挂 title
			// 旧实现把整串拼在一行、`word-break:break-all` ⇒ 路径被从任意字符处硬折，
			// 一屏里几行的断点还各不相同，很难扫读（用户截图）。样式见 media/findSymbolModal.css。
			// （仍不做完整 source preview：避免 N+1 IO，保持模态响应性）
			const defHead = dom.$('div.find-symbol-def-head');
			const headText = `${n.type ?? n.label ?? ''} ${n.name}`.trim();
			defHead.textContent = headText + (n.filePath ? '  —  ' : '');
			defHead.title = headText;
			const defPath = dom.$('div.find-symbol-def-path');
			const pathText = n.filePath ? `${n.filePath}${n.startLine ? `:${n.startLine}` : ''}` : '';
			defPath.textContent = pathText;
			if (pathText) { defPath.title = pathText; }
			defCell.appendChild(defHead);
			defCell.appendChild(defPath);
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
		// 2026-09-15：统一走 service 级解析器（root 三级回退 + 行号缺省 + 未命中告警）。
		// 原先本文件手拼 root 有两个静默失败点：把 `startLine` 当可跳转前提（而图谱里
		// `label='file'` 的 stub 节点没有行号 ⇒ 最常见的命中双击无反应），以及只认
		// `getProjectRoots()[node.project]` 一项。完整缺陷说明见 `resolveNodeLocation`。
		const loc = await this._graphService.resolveNodeLocation(node);
		if (!loc) { return; } // 未命中的原因由 service 告警（含 node 名 / project / filePath）
		const options: ITextEditorOptions = {
			selection: { startLineNumber: loc.line, startColumn: 1, endLineNumber: loc.line, endColumn: 1 },
			revealIfOpened: true,
			pinned: false,
		};
		await this._editorService.openEditor({ resource: loc.uri, options });
	}

	dispose(): void {
		if (this._disposed) { return; }
		this._disposed = true;
		this._disposables.dispose();
		this._modal?.dispose();
	}
}
