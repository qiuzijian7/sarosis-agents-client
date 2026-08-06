/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Find References 结果窗（对齐 Visual Assist X 的 Find References 结果窗口，Shift+Alt+F）。
 *
 *  - 顶部工具栏：标题（目标符号）+ 读/写过滤三态（全部 / 读 / 写）+ 刷新
 *  - 结果按文件分组，行 = 引用点（边类型徽标 + 符号名 + 行号 + 上下文预览）
 *  - 单击选中、双击跳转定义；读写过滤基于 USAGE 边的 access 属性（P3）
 *
 * 外部通过 `showReferences(qualifiedName, access?)` 驱动（由 sarosis.findGraphReferences 命令调用）。
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
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ICodebaseGraphService, GraphNode } from '../codebaseGraphService.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ITextEditorOptions } from '../../../../../platform/editor/common/editor.js';

type AccessFilter = 'all' | 'read' | 'write';

export class ReferencesResultViewPane extends ViewPane {

	private _body!: HTMLElement;
	private _titleEl!: HTMLElement;
	private _listEl!: HTMLElement;
	private _hintEl!: HTMLElement;

	private _filterAllBtn!: HTMLButtonElement;
	private _filterReadBtn!: HTMLButtonElement;
	private _filterWriteBtn!: HTMLButtonElement;
	private _refreshBtn!: HTMLButtonElement;

	private _accessFilter: AccessFilter = 'all';
	private _currentRefs: { node: GraphNode; edgeType: string; access: 'read' | 'write' }[] = [];
	private _currentTarget = '';
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
		@IFileService private readonly _fileService: IFileService,
		@ICodebaseGraphService private readonly _graphService: ICodebaseGraphService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._body = dom.$('div');
		this._body.style.cssText = 'display:flex;flex-direction:column;height:100%;';
		container.appendChild(this._body);

		// 工具栏：标题 + 读写过滤 + 刷新
		const toolbar = dom.$('div');
		toolbar.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-bottom:1px solid var(--vscode-panel-border);';
		this._titleEl = dom.$('div');
		this._titleEl.style.cssText = 'font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
		toolbar.appendChild(this._titleEl);

		const filterRow = dom.$('div');
		filterRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
		this._filterAllBtn = this._makeFilterBtn(localize('sarosis.refs.all', '全部'), 'all');
		this._filterReadBtn = this._makeFilterBtn(localize('sarosis.refs.read', '读'), 'read');
		this._filterWriteBtn = this._makeFilterBtn(localize('sarosis.refs.write', '写'), 'write');
		this._refreshBtn = dom.$('button') as HTMLButtonElement;
		this._refreshBtn.textContent = '⟳';
		this._refreshBtn.title = localize('sarosis.refs.refresh', '刷新');
		this._refreshBtn.style.cssText = 'padding:2px 8px;border-radius:3px;border:1px solid var(--vscode-button-border, transparent);cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);';
		this._refreshBtn.addEventListener('click', () => this._reload());
		filterRow.appendChild(this._filterAllBtn);
		filterRow.appendChild(this._filterReadBtn);
		filterRow.appendChild(this._filterWriteBtn);
		filterRow.appendChild(this._refreshBtn);
		toolbar.appendChild(filterRow);
		this._body.appendChild(toolbar);

		// 结果列表
		this._listEl = dom.$('div');
		this._listEl.style.cssText = 'flex:1;overflow:auto;padding:4px 4px 12px;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);';
		this._body.appendChild(this._listEl);

		this._hintEl = dom.$('div');
		this._hintEl.textContent = localize('sarosis.refs.hint', '在编辑器中对符号按 Shift+Alt+F 查找引用。');
		this._hintEl.style.cssText = 'color:var(--vscode-descriptionForeground);padding:12px;';
		this._listEl.appendChild(this._hintEl);
	}

	private _makeFilterBtn(label: string, f: AccessFilter): HTMLButtonElement {
		const btn = dom.$('button') as HTMLButtonElement;
		btn.textContent = label;
		btn.style.cssText = 'padding:2px 8px;border-radius:3px;border:1px solid var(--vscode-button-border, transparent);cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);';
		btn.addEventListener('click', () => {
			this._accessFilter = f;
			this._paintFilterBtns();
			this._render();
		});
		return btn;
	}

	private _paintFilterBtns(): void {
		for (const [btn, f] of [[this._filterAllBtn, 'all'], [this._filterReadBtn, 'read'], [this._filterWriteBtn, 'write']] as const) {
			btn.style.background = f === this._accessFilter ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)';
			btn.style.color = f === this._accessFilter ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)';
		}
	}

	/** 显示某符号的引用。由 sarosis.findGraphReferences 命令调用。 */
	async showReferences(qualifiedName: string, access?: AccessFilter): Promise<void> {
		this._currentTarget = qualifiedName;
		if (access) { this._accessFilter = access; }
		this._paintFilterBtns();
		await this._reload();
	}

	private async _reload(): Promise<void> {
		if (!this._currentTarget) { return; }
		const refs = this._graphService.getNodeReferences(this._currentTarget);
		this._currentRefs = refs ?? [];
		this._render();
	}

	private _render(): void {
		dom.reset(this._listEl);
		this._titleEl.textContent = localize('sarosis.refs.title', 'References to “{0}” ({1})', this._currentTarget || '—', this._currentRefs.length);

		if (this._currentRefs.length === 0) {
			this._listEl.appendChild(this._hintEl);
			return;
		}

		// 读写过滤
		const filtered = this._accessFilter === 'all'
			? this._currentRefs
			: this._currentRefs.filter(r => r.access === this._accessFilter);

		if (filtered.length === 0) {
			const empty = dom.$('div');
			empty.textContent = localize('sarosis.refs.empty', '无匹配（当前过滤: {0}）', this._accessFilter);
			empty.style.cssText = 'color:var(--vscode-descriptionForeground);padding:12px;';
			this._listEl.appendChild(empty);
			return;
		}

		// 按文件分组
		const byFile = new Map<string, typeof filtered>();
		for (const r of filtered) {
			const key = r.node.filePath ?? r.node.qualifiedName ?? '?';
			const list = byFile.get(key);
			if (list) { list.push(r); } else { byFile.set(key, [r]); }
		}

		for (const [file, refs] of byFile) {
			const fileHeader = dom.$('div');
			fileHeader.textContent = `📄 ${file}`;
			fileHeader.style.cssText = 'padding:6px 4px 2px;font-weight:bold;color:var(--vscode-descriptionForeground);font-size:0.95em;';
			this._listEl.appendChild(fileHeader);

			for (const ref of refs) {
				const row = dom.$('div');
				row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 4px 2px 16px;border-radius:3px;cursor:pointer;white-space:nowrap;';
				row.title = `${ref.node.qualifiedName}  (${ref.node.filePath ?? ''}:${ref.node.startLine ?? ''})`;

				const badge = dom.$('span');
				badge.textContent = ref.access === 'write' ? 'W' : (ref.edgeType === 'USAGE' ? 'R' : ref.edgeType.slice(0, 1));
				badge.style.cssText = 'font-size:10px;min-width:16px;text-align:center;font-weight:bold;color:' + (ref.access === 'write' ? 'var(--vscode-charts-red)' : 'var(--vscode-charts-green)') + ';';
				row.appendChild(badge);

				const name = dom.$('span');
				name.textContent = ref.node.name;
				row.appendChild(name);

				const line = dom.$('span');
				line.textContent = `:${ref.node.startLine ?? ''}`;
				line.style.cssText = 'color:var(--vscode-descriptionForeground);';
				row.appendChild(line);

				const edgeTag = dom.$('span');
				edgeTag.textContent = ref.edgeType;
				edgeTag.style.cssText = 'font-size:10px;padding:0 4px;border-radius:3px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);';
				row.appendChild(edgeTag);

				row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground)'; });
				row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
				row.addEventListener('dblclick', () => { this._openNode(ref.node); });

				this._listEl.appendChild(row);
			}
		}
	}

	private async _openNode(node: GraphNode): Promise<void> {
		if (!node.filePath || !node.startLine) { return; }
		const roots = this._graphService.getProjectRoots();
		const root = roots[node.project ?? '_default'];
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

	override dispose(): void {
		this._disposables.dispose();
		super.dispose();
	}
}
