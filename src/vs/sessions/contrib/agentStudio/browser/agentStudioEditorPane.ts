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
 * EditorPane for Agent Studio panels (Canvas, TaskBoard).
 * Renders the WebView-based React UI inside the editor area,
 * supporting free drag-and-drop split layout like regular file editors.
 */
export class AgentStudioEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio';

	private _container: HTMLElement | undefined;
	private _webviewController: AgentStudioWebviewController | undefined;
	private _currentPanelType: string | undefined;

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

		// If we already have the correct webview, just layout
		if (this._currentPanelType === panelType && this._webviewController) {
			return;
		}

		// Dispose previous webview controller if panel type changed
		if (this._webviewController) {
			this._webviewController.dispose();
			this._webviewController = undefined;
		}

		// Clear container
		if (this._container) {
			DOM.clearNode(this._container);
		}

		// Create new webview controller for this panel type
		this._currentPanelType = panelType;
		if (this._container) {
			this._webviewController = this._register(
				this.instantiationService.createInstance(AgentStudioWebviewController, this._container, panelType)
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

	override dispose(): void {
		if (this._webviewController) {
			this._webviewController.dispose();
			this._webviewController = undefined;
		}
		super.dispose();
	}
}
