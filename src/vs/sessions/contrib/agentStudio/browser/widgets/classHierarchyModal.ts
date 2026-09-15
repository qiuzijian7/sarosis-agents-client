/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 类继承关系模态对话框（Alt+Shift+G，对齐 Visual Assist X 的类浏览器）。
 *
 *  - 打开时自动取光标处单词作为根类，getClassHierarchy 沿 INHERITS/IMPLEMENTS 双向 BFS
 *  - 方向三态：基类↑ / 派生↓ / 双向，徽标 B（基类）/ I（接口）/ R（根）区分
 *  - **单击**节点即跳转到该类定义（file:line）并关闭对话框（需求 2026-09-08：
 *    「点击继承的类可跳转到对应的类」——单击直达，不同于侧边栏版的双击）
 *  - 复用 CodebaseGraphModal 骨架（Esc / 遮罩 / X 关闭）
 *
 * 与 views/classHierarchyView.ts（侧边栏 ViewPane 版，双击跳转）数据源相同、交互不同。
 */

import * as dom from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICodebaseGraphService, IClassHierarchyNode } from '../codebaseGraphService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ITextEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ICodebaseMemoryMcpService } from '../codebaseMemoryMcpService.js';
import { CodebaseGraphModal } from './codebaseGraphModal.js';
import { ensureGraphForUi } from './codebaseGraphAutoBuild.js';

type Direction = 'bases' | 'derived' | 'both';

export class ClassHierarchyModal {

	private _modal!: CodebaseGraphModal;
	private _treeEl!: HTMLElement;
	private _dirBtns: HTMLButtonElement[] = [];
	private _direction: Direction = 'both';
	private _root: IClassHierarchyNode | undefined;
	private _query = '';
	private _disposables = new DisposableStore();
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
		this._query = (initialQuery ?? '').trim();
		this._modal = new CodebaseGraphModal({
			title: localize('sarosis.classHierarchy.title', 'Class Hierarchy'),
			hint: this._query || undefined,
			width: 640,
			height: 520,
			renderBody: (body) => this._renderBody(body),
			okText: localize('sarosis.classHierarchy.close', 'Close'),
			// ★★ 关闭时释放 `_disposables`（2026-09-15，修 `[LEAKED DISPOSABLE]`）。
			// 本类是同一族的 4 个 modal 中**唯一漏了**这一行的 ✗
			// （`implementationsModal.ts:55` 与 `findSymbolModal.ts:68` 都有 ✓）。
			// 调用方 `createInstance(ClassHierarchyModal).open(...)` 是**裸创建** ✗，
			// 而 `open()` 立即返回 ⇒ 调用方无法回收 ✗ ⇒ 必须由模态关闭时自清 ✓。
			onDispose: () => this.dispose(),
		});
		// 打开即查（光标词）；无词则显示提示
		if (this._query) {
			void this._load();
		} else {
			// _treeEl 在 renderBody 里创建，等下一帧再填充提示
			setTimeout(() => this._setHint(localize('sarosis.classHierarchy.noWord', 'Place the cursor on a class name and press Alt+Shift+G, or type a class name in the search box above.')), 0);
		}
		// 2026-09-15（用户要求）：**无图也照常打开 UI**。`ShowClassHierarchyAction.run` 以前在
		// `hasGraphData()` 上静默 return —— 连这个模态都不弹，用户按 Alt+Shift+G 只看到「没反应」。
		// 现在：无图则自动建图 + 提示条显示进度，建好后自动重查（有查询词）或提示可输入。
		void ensureGraphForUi(
			{
				graphService: this._graphService,
				cbmService: this._cbmService,
				workspaceService: this._workspaceService,
				logService: this._logService,
			},
			{
				setNotice: (text, kind) => this._modal?.setNotice(text, kind),
				refresh: () => {
					if (this._query) {
						void this._load();
					} else {
						this._setHint(localize('sarosis.classHierarchy.readyNoQuery', '代码图谱已就绪 —— 输入类名，或把光标放在类名上再按 Alt+Shift+G。'));
					}
				},
			},
			this._disposables,
		);
	}

	private _renderBody(body: HTMLElement): void {
		// 工具条：搜索输入 + 方向三态
		const toolbar = dom.$('div');
		toolbar.style.cssText = 'display:flex;gap:6px;padding:8px 10px;align-items:center;border-bottom:1px solid var(--vscode-panel-border);flex:0 0 auto;';

		const input = dom.$('input') as HTMLInputElement;
		input.placeholder = localize('sarosis.classHierarchy.placeholder', 'Class name…');
		input.value = this._query;
		input.setAttribute('data-modal-initial-focus', 'true');
		input.style.cssText = 'flex:1;min-width:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:3px 8px;outline:none;';
		this._disposables.add(dom.addStandardDisposableListener(input, dom.EventType.KEY_DOWN, (e) => {
			if (e.browserEvent.key === 'Enter') {
				this._query = input.value.trim();
				void this._load();
			}
		}));
		this._disposables.add(dom.addDisposableListener(input, 'input', () => {
			this._query = input.value.trim();
			if (this._query.length >= 2) { void this._load(); }
		}));
		toolbar.appendChild(input);

		this._dirBtns = [
			this._makeDirBtn('↑ ' + localize('sarosis.classHierarchy.bases', 'Bases'), 'bases'),
			this._makeDirBtn('↓ ' + localize('sarosis.classHierarchy.derived', 'Derived'), 'derived'),
			this._makeDirBtn('⇅ ' + localize('sarosis.classHierarchy.both', 'Both'), 'both'),
		];
		for (const btn of this._dirBtns) { toolbar.appendChild(btn); }
		body.appendChild(toolbar);

		// 树容器
		this._treeEl = dom.$('div');
		this._treeEl.style.cssText = 'flex:1 1 auto;overflow:auto;padding:6px 4px 12px;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);';
		if (!this._query) {
			this._setHint(localize('sarosis.classHierarchy.noWord', 'Place the cursor on a class name and press Alt+Shift+G, or type a class name in the search box above.'));
		} else {
			this._setHint(localize('sarosis.classHierarchy.loading', 'Loading…'));
		}
		body.appendChild(this._treeEl);
		this._paintDirBtns();
	}

	private _makeDirBtn(label: string, dir: Direction): HTMLButtonElement {
		const btn = dom.$('button') as HTMLButtonElement;
		btn.textContent = label;
		btn.style.cssText = 'padding:2px 8px;border-radius:3px;border:1px solid var(--vscode-button-border, transparent);cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);white-space:nowrap;';
		btn.addEventListener('click', () => {
			this._direction = dir;
			this._paintDirBtns();
			if (this._query) { void this._load(); }
		});
		return btn;
	}

	private _paintDirBtns(): void {
		const dirs: Direction[] = ['bases', 'derived', 'both'];
		for (let i = 0; i < this._dirBtns.length; i++) {
			const active = dirs[i] === this._direction;
			this._dirBtns[i].style.background = active ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)';
			this._dirBtns[i].style.color = active ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)';
		}
	}

	private _setHint(text: string): void {
		dom.reset(this._treeEl);
		const hint = dom.$('div');
		hint.textContent = text;
		hint.style.cssText = 'color:var(--vscode-descriptionForeground);padding:12px;';
		this._treeEl.appendChild(hint);
	}

	private async _load(): Promise<void> {
		if (!this._query) { return; }
		this._setHint(localize('sarosis.classHierarchy.loading', 'Loading…'));
		try {
			this._root = await this._graphService.getClassHierarchy(this._query, this._direction);
		} catch {
			this._root = undefined;
		}
		this._render();
	}

	private _render(): void {
		dom.reset(this._treeEl);
		if (!this._root) {
			this._setHint(localize('sarosis.classHierarchy.notFound', 'No inheritance information found for "{0}". Try indexing the workspace first (full index).', this._query));
			return;
		}
		const wrapper = dom.$('div');
		this._appendNode(wrapper, this._root, 0, true);
		this._treeEl.appendChild(wrapper);
	}

	private _appendNode(parent: HTMLElement, node: IClassHierarchyNode, depth: number, isRoot: boolean): void {
		const row = dom.$('div');
		row.style.cssText = `display:flex;align-items:center;gap:5px;padding:3px 6px;border-radius:3px;cursor:pointer;white-space:nowrap;margin-left:${depth * 16}px;`;
		row.title = `${node.node.qualifiedName}  (${node.node.filePath ?? ''}:${node.node.startLine ?? ''})  —  ${localize('sarosis.classHierarchy.clickToGo', 'click to open')}`;

		// 徽标：根 R / 接口 I / 基类 B
		const badge = dom.$('span');
		badge.style.cssText = 'font-size:10px;min-width:16px;text-align:center;font-weight:bold;';
		if (isRoot) {
			badge.textContent = 'R';
			badge.style.color = 'var(--vscode-charts-yellow)';
		} else if (node.kind === 'IMPLEMENTS') {
			badge.textContent = 'I';
			badge.style.color = 'var(--vscode-charts-purple)';
		} else {
			badge.textContent = 'B';
			badge.style.color = 'var(--vscode-charts-blue)';
		}
		row.appendChild(badge);

		const name = dom.$('span');
		name.textContent = node.node.name;
		name.style.fontWeight = isRoot ? 'bold' : 'normal';
		row.appendChild(name);

		const loc = dom.$('span');
		loc.textContent = node.node.filePath ? `— ${node.node.filePath}:${node.node.startLine ?? ''}` : '';
		loc.style.cssText = 'color:var(--vscode-descriptionForeground);font-size:11px;overflow:hidden;text-overflow:ellipsis;';
		row.appendChild(loc);

		row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground)'; });
		row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
		// 单击即跳转（需求：点击继承的类可跳转到对应的类）；跳转后关闭对话框
		row.addEventListener('click', () => { void this._openNode(node); });

		parent.appendChild(row);

		for (const b of node.bases) { this._appendNode(parent, b, depth + 1, false); }
		for (const d of node.derived) { this._appendNode(parent, d, depth + 1, false); }
	}

	private async _openNode(node: IClassHierarchyNode): Promise<void> {
		const g = node.node as any;
		// 2026-09-15：统一走 service 级解析器（root 三级回退 + 行号缺省 + 未命中告警）。
		// 原实现 `if (g.filePath && g.startLine)` + 单 root —— 与 Find Symbol 同族的静默失败。
		const loc = await this._graphService.resolveNodeLocation(g);
		if (loc) {
			const options: ITextEditorOptions = {
				selection: { startLineNumber: loc.line, startColumn: 1, endLineNumber: loc.line, endColumn: 1 },
				revealIfOpened: true,
				pinned: false,
			};
			await this._editorService.openEditor({ resource: loc.uri, options });
		}
		// 跳转（或无定义信息）后关闭对话框，回到编辑器上下文
		this.dispose();
	}

	dispose(): void {
		if (this._disposed) { return; }
		this._disposed = true;
		this._disposables.dispose();
		this._modal?.dispose();
	}
}
