/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 类继承树视图（对齐 Visual Assist X 的 VA View / Hovering Class Browser）。
 *
 *  - 输入类名（或从当前编辑器光标处符号反查）→ getClassHierarchy 沿 INHERITS/IMPLEMENTS 双向 BFS
 *  - 方向三态：基类↑ / 派生↓ / 双向，图标 B（基类）/ D（派生）区分
 *  - 双击节点跳转到定义；右键支持 Find Symbol / 复制 QN
 *  - 纯 DOM 渲染（递归），复用 KnowledgeBaseViewPane 的交互范式
 */

import * as dom from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ViewPane, IViewPaneOptions } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ICodebaseGraphService, IClassHierarchyNode } from '../codebaseGraphService.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ITextEditorOptions } from '../../../../../platform/editor/common/editor.js';

type Direction = 'bases' | 'derived' | 'both';

export class ClassHierarchyViewPane extends ViewPane {

	private _body!: HTMLElement;
	private _input!: HTMLInputElement;
	private _dirBasesBtn!: HTMLButtonElement;
	private _dirDerivedBtn!: HTMLButtonElement;
	private _dirBothBtn!: HTMLButtonElement;
	private _treeEl!: HTMLElement;
	private _hintEl!: HTMLElement;

	private _direction: Direction = 'both';
	private _currentRoot: IClassHierarchyNode | undefined;
	private _disposables = new DisposableStore();

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
		@IEditorService private readonly _editorService: IEditorService,
		@ICodebaseGraphService private readonly _graphService: ICodebaseGraphService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._body = dom.$('div');
		this._body.style.cssText = 'display:flex;flex-direction:column;height:100%;';
		container.appendChild(this._body);

		// 工具条：输入 + 方向三态
		const toolbar = dom.$('div');
		toolbar.style.cssText = 'display:flex;gap:6px;padding:8px 10px;align-items:center;border-bottom:1px solid var(--vscode-panel-border);';
		this._input = dom.$('input') as HTMLInputElement;
		this._input.placeholder = localize('sarosis.classHierarchy.placeholder', 'Class name…');
		this._input.style.cssText = 'flex:1;min-width:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:3px 8px;';
		toolbar.appendChild(this._input);

		this._dirBasesBtn = this._makeDirBtn('↑ B', 'bases');
		this._dirDerivedBtn = this._makeDirBtn('↓ D', 'derived');
		this._dirBothBtn = this._makeDirBtn('⇅ B/D', 'both');
		toolbar.appendChild(this._dirBasesBtn);
		toolbar.appendChild(this._dirDerivedBtn);
		toolbar.appendChild(this._dirBothBtn);
		this._body.appendChild(toolbar);

		// 树容器
		this._treeEl = dom.$('div');
		this._treeEl.style.cssText = 'flex:1;overflow:auto;padding:4px 4px 12px;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);';
		this._body.appendChild(this._treeEl);

		this._hintEl = dom.$('div');
		this._hintEl.textContent = localize('sarosis.classHierarchy.hint', '输入类名（如 MyClass），或打开光标所在类后回车。');
		this._hintEl.style.cssText = 'color:var(--vscode-descriptionForeground);padding:12px;';
		this._treeEl.appendChild(this._hintEl);

		// 事件
		this._disposables.add(dom.addStandardDisposableListener(this._input, dom.EventType.KEY_DOWN, (e) => {
			if (e.browserEvent.key === 'Enter') { this._load(); }
		}));
		this._disposables.add(dom.addDisposableListener(this._input, 'input', () => {
			if (this._input.value.trim().length >= 2) { this._load(); }
		}));
	}

	private _makeDirBtn(label: string, dir: Direction): HTMLButtonElement {
		const btn = dom.$('button') as HTMLButtonElement;
		btn.textContent = label;
		btn.style.cssText = 'padding:2px 8px;border-radius:3px;border:1px solid var(--vscode-button-border, transparent);cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);';
		btn.addEventListener('click', () => {
			this._direction = dir;
			this._paintDirBtns();
			if (this._currentRoot) { this._render(); }
		});
		return btn;
	}

	private _paintDirBtns(): void {
		for (const [btn, dir] of [[this._dirBasesBtn, 'bases'], [this._dirDerivedBtn, 'derived'], [this._dirBothBtn, 'both']] as const) {
			btn.style.background = dir === this._direction ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)';
			btn.style.color = dir === this._direction ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)';
		}
	}

	/** 加载当前编辑器光标处的类（供外部命令调用）。 */
	async loadFromEditor(): Promise<void> {
		const editor = this._editorService.activeTextEditorControl;
		if (!editor || typeof (editor as any).getPosition !== 'function') { return; }
		const model = (editor as any).getModel?.();
		const pos = (editor as any).getPosition?.();
		if (!model || !pos) { return; }
		const word = model.getWordAtPosition(pos)?.word;
		if (word) {
			this._input.value = word;
			this._load();
		}
	}

	private async _load(): Promise<void> {
		const qn = this._input.value.trim();
		if (!qn) { return; }
		const root = await this._graphService.getClassHierarchy(qn, this._direction);
		this._currentRoot = root;
		this._render();
	}

	private _render(): void {
		dom.reset(this._treeEl);
		if (!this._currentRoot) {
			this._treeEl.appendChild(this._hintEl);
			return;
		}
		const wrapper = dom.$('div');
		this._appendNode(wrapper, this._currentRoot, 0, true);
		this._treeEl.appendChild(wrapper);
	}

	private _appendNode(parent: HTMLElement, node: IClassHierarchyNode, depth: number, isRoot: boolean): void {
		const row = dom.$('div');
		row.style.cssText = `display:flex;align-items:center;gap:4px;padding:2px 4px;border-radius:3px;cursor:pointer;white-space:nowrap;margin-left:${depth * 14}px;`;
		row.title = `${node.node.qualifiedName}  (${node.node.filePath ?? ''}:${node.node.startLine ?? ''})`;

		// 徽标：基类 B / 接口 I / 根 R
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

		const icon = dom.$('span');
		icon.textContent = node.node.label === 'interface' ? 'ⓘ' : '◇';
		icon.style.cssText = 'opacity:.8;';
		row.appendChild(icon);

		const name = dom.$('span');
		name.textContent = node.node.name;
		name.style.fontWeight = isRoot ? 'bold' : 'normal';
		row.appendChild(name);

		// 悬停/点击
		row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground)'; });
		row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
		row.addEventListener('dblclick', () => { this._openNode(node); });

		parent.appendChild(row);

		for (const b of node.bases) { this._appendNode(parent, b, depth + 1, false); }
		for (const d of node.derived) { this._appendNode(parent, d, depth + 1, false); }
	}

	private async _openNode(node: IClassHierarchyNode): Promise<void> {
		const g = node.node as any;
		if (!g.filePath || !g.startLine) { return; }
		const roots = this._graphService.getProjectRoots();
		const root = roots[g.project ?? '_default'];
		if (!root) { return; }
		const uri = joinPath(URI.file(root), g.filePath);
		const line = Math.max(0, g.startLine - 1);
		const options: ITextEditorOptions = {
			selection: { startLineNumber: line + 1, startColumn: 1, endLineNumber: line + 1, endColumn: 1 },
			revealIfOpened: true,
			pinned: false,
		};
		await this._editorService.openEditor({ resource: uri, options });
	}

	override dispose(): void {
		this._disposables.dispose();
		super.dispose();
	}
}
