/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AgentStudioEditorInput } from './agentStudioEditorInput.js';
import { AgentStudioWebviewController } from './agentStudioWebviewController.js';
import * as DOM from '../../../../base/browser/dom.js';

/**
 * EditorPane for Agent Studio panels (Canvas, TaskBoard, Chat).
 * Renders the WebView-based React UI inside the editor area,
 * supporting free drag-and-drop split layout like regular file editors.
 *
 * IMPORTANT: Each time `setInput()` is called (including when the editor
 * is moved to a new group), a fresh WebviewController is created. This
 * is necessary because IWebviewElement iframes are destroyed by the
 * browser when their DOM parent changes, so reusing an old controller
 * after a move would show a blank pane.
 */
export class AgentStudioEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio';

	private _container: HTMLElement | undefined;
	private _webviewController: AgentStudioWebviewController | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(AgentStudioEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('agent-studio-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		parent.appendChild(this._container);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof AgentStudioEditorInput)) {
			return;
		}

		const panelType = input.panelType;

		// Always recreate the webview controller.
		// When an editor is moved to a new group, VS Code creates a new
		// EditorPane instance with a fresh DOM container. Even if panelType
		// hasn't changed, we need a new IWebviewElement mounted into the
		// new container — reusing an old one is impossible because iframe
		// content is destroyed by the browser on DOM re-parenting.
		this._disposeWebview();

		if (this._container) {
			this._webviewController = this.instantiationService.createInstance(
				AgentStudioWebviewController, this._container, panelType
			);
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
		this._webviewController?.layout(dimension.width, dimension.height);
	}

	private _disposeWebview(): void {
		if (this._webviewController) {
			this._webviewController.dispose();
			this._webviewController = undefined;
		}
		if (this._container) {
			DOM.clearNode(this._container);
		}
	}

	override dispose(): void {
		this._disposeWebview();
		super.dispose();
	}
}
