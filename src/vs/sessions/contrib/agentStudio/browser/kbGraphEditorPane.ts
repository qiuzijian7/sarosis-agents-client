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
import { KbNoteEditorInput } from './kbNoteEditorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';

/**
 * KnowledgeBaseGraphEditorPane — 在中栏文件编辑器打开知识库「关系图谱」。
 *
 * 挂载 KbGraphView（Canvas 力导向图），节点单击 → 在中间栏打开对应笔记的
 * WYSIWYG 编辑器（KbNoteEditorInput）。完全对齐 SiYuan 的图谱中心 Tab 行为。
 */
export class KnowledgeBaseGraphEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.kbGraphPane';

	private _container: HTMLElement | undefined;
	private _graphView: KbGraphView | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
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
