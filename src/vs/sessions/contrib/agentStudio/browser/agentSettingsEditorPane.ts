/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as DOM from '../../../../base/browser/dom.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AgentSettingsEditorInput } from './agentSettingsEditorInput.js';
import { AgentStudioWebviewController } from './agentStudioWebviewController.js';

/**
 * AgentSettingsEditorPane — WebView-based editor pane for agent settings.
 *
 * Uses AgentStudioWebviewController with panelType 'agent-settings' to
 * render the AgentEditorPane React component with tabs:
 * System Prompt | Skills | Memory | Knowledge | ConfigMD | Tools | MCP | Rules
 *
 * The agentId is passed via `initialData` and injected as
 * `window.__AGENT_STUDIO_INITIAL_DATA__` into the webview.
 */
export class AgentSettingsEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.agentSettingsPane';

	private _container: HTMLElement | undefined;
	private _webviewController: AgentStudioWebviewController | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(AgentSettingsEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = DOM.$('div.agent-settings-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		_options: IEditorOptions | undefined,
		_context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, _options, _context, token);

		if (!(input instanceof AgentSettingsEditorInput) || !this._container) {
			return;
		}

		if (token.isCancellationRequested) {
			return;
		}

		// Always recreate the webview controller for each open
		this._disposeWebview();

		const agentId = input.agentId;

		this._webviewController = this.instantiationService.createInstance(
			AgentStudioWebviewController,
			this._container,
			'agent-settings' as const,
			// Pass the agentId as initialData — injected as __AGENT_STUDIO_INITIAL_DATA__
			{ type: 'agent-settings', agentId },
		);
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
