/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { KbGraphEditorInput } from './kbGraphEditorInput.js';
import { KbGraphView } from './views/knowledgeBase/kbGraphView.js';
import { KbLinkGraph, IKbGraphRoot } from './views/knowledgeBase/kbGraph.js';
import { KbNoteEditorInput } from './kbNoteEditorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * KnowledgeBaseGraphEditorPane — 在中栏文件编辑器打开知识库「关系图谱」。
 *
 * 挂载 KbGraphView（Canvas 力导向图），节点单击 → 在中间栏打开对应笔记的
 * WYSIWYG 编辑器（KbNoteEditorInput）。完全对齐 SiYuan 的图谱中心 Tab 行为。
 *
 * 浮动工具条含「构建图谱」按钮：重新扫描知识库分区（库 + 笔记）的 [[双链]]，
 * 重建力导向图数据并刷新画布（笔记有改动时无需重新从侧边栏打开图谱）。
 */
export class KnowledgeBaseGraphEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.kbGraphPane';

	private _container: HTMLElement | undefined;
	private _graphView: KbGraphView | undefined;
	private _roots: IKbGraphRoot[] = [];

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super(KnowledgeBaseGraphEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = DOM.$('div.kb-graph-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.position = 'relative';
		this._container.style.overflow = 'hidden';
		this._container.style.background = 'var(--vscode-editor-background)';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		_options: IEditorOptions | undefined,
		_context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, _options, _context, token);

		if (!(input instanceof KbGraphEditorInput) || !this._container) {
			return;
		}
		if (token.isCancellationRequested) {
			return;
		}

		this._disposeGraph();
		this._roots = input.roots ?? [];

		const host = DOM.$('div.kb-graph-host');
		host.style.position = 'absolute';
		host.style.inset = '0';
		this._container.appendChild(host);

		const graphView = this.instantiationService.createInstance(KbGraphView);
		graphView.render(host);
		graphView.onNodeClick(e => {
			// 单击文档节点 → 在中间栏打开对应笔记的 WYSIWYG 编辑器
			if (e.node && e.node.type === 'doc') {
				const uri = URI.parse(e.node.id);
				const name = e.node.label;
				this.editorService.openEditor(
					new KbNoteEditorInput(uri, `${name}.md`),
					{ pinned: true },
					this.group,
				);
			}
		});

		graphView.loadGraph(input.nodes, input.links);
		this._graphView = graphView;

		this._renderToolbar();
	}

	/** 浮动工具条：构建图谱 + 重新布局。 */
	private _renderToolbar(): void {
		if (!this._container) { return; }
		const bar = DOM.$('div.kb-graph-toolbar');
		bar.style.cssText = [
			'position:absolute', 'top:10px', 'right:10px', 'z-index:10',
			'display:flex', 'gap:6px', 'padding:4px',
			'background:var(--vscode-editorWidget-background,#252526)',
			'border:1px solid var(--vscode-widget-border,#3c3c3c)',
			'border-radius:6px', 'box-shadow:0 2px 8px rgba(0,0,0,.4)',
		].join(';');

		const buildBtn = DOM.$('button.kb-graph-tbtn') as HTMLButtonElement;
		buildBtn.textContent = '🔄 构建图谱';
		buildBtn.title = '重新扫描知识库（库 + 笔记）的 [[双链]] 并重建图谱';
		buildBtn.style.cssText = this._btnCss();
		buildBtn.onclick = () => void this._rebuildGraph(buildBtn);

		const layoutBtn = DOM.$('button.kb-graph-tbtn');
		layoutBtn.textContent = '⤢ 重新布局';
		layoutBtn.title = '重新执行力导向布局';
		layoutBtn.style.cssText = this._btnCss();
		layoutBtn.onclick = () => this._graphView?.relayout();

		bar.append(buildBtn, layoutBtn);
		this._container.appendChild(bar);
	}

	private _btnCss(): string {
		return [
			'border:none', 'background:transparent', 'color:var(--vscode-foreground,#ccc)',
			'font-size:12px', 'padding:4px 8px', 'border-radius:4px',
			'cursor:pointer', 'white-space:nowrap',
		].join(';');
	}

	/** 重新扫描知识库分区并重建力导向图。 */
	private async _rebuildGraph(btn: HTMLButtonElement): Promise<void> {
		if (!this._graphView) { return; }
		if (this._roots.length === 0) {
			this.logService.warn('[KB Graph] 无可用的知识库分区根目录，无法构建图谱');
			return;
		}
		const original = btn.textContent;
		btn.disabled = true;
		btn.textContent = '⏳ 构建中…';
		btn.style.opacity = '0.6';
		try {
			const linkGraph = new KbLinkGraph(this.fileService);
			await linkGraph.build(this._roots);
			const { nodes, links } = linkGraph.getGraphData();
			this._graphView.loadGraph(nodes, links);
		} catch (err) {
			this.logService.error(`[KB Graph] 构建图谱失败：${err}`);
		} finally {
			btn.disabled = false;
			btn.textContent = original;
			btn.style.opacity = '';
		}
	}

	override layout(dimension: DOM.Dimension): void {
		this._graphView?.resize();
	}

	private _disposeGraph(): void {
		if (this._graphView) {
			this._graphView.dispose();
			this._graphView = undefined;
		}
		if (this._container) {
			DOM.clearNode(this._container);
		}
	}

	override dispose(): void {
		this._disposeGraph();
		super.dispose();
	}
}
