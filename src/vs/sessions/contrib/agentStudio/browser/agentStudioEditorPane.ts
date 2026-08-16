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
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { AgentStudioEditorInput } from './agentStudioEditorInput.js';
import { AgentStudioWebviewController } from './agentStudioWebviewController.js';
import { AgentStudioActiveContext } from '../../../common/contextkeys.js';
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
	private _chatActiveCtxKey: ReturnType<typeof AgentStudioActiveContext.bindTo>;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super(AgentStudioEditorPane.ID, group, telemetryService, themeService, storageService);
		this._chatActiveCtxKey = AgentStudioActiveContext.bindTo(this.contextKeyService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('agent-studio-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		parent.appendChild(this._container);
		console.log('[AgentStudioEditorPane] createEditor called, container:', this._container, 'parent:', parent);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof AgentStudioEditorInput)) {
			console.warn('[AgentStudioEditorPane] setInput: not an AgentStudioEditorInput, skipping');
			return;
		}

		if (token.isCancellationRequested) {
			console.warn('[AgentStudioEditorPane] setInput: cancelled');
			return;
		}

		const panelType = input.panelType;
		console.log('[AgentStudioEditorPane] setInput:', panelType, 'container:', this._container, 'containerInDOM:', this._container?.isConnected);

		// 更新 Agent Chat 激活状态 context key
		this._chatActiveCtxKey.set(panelType === 'chat');

		// Always recreate the webview controller.
		this._disposeWebview();

		if (this._container) {
			this._webviewController = this.instantiationService.createInstance(
				AgentStudioWebviewController, this._container, panelType, undefined
			);
			console.log('[AgentStudioEditorPane] WebviewController created for', panelType);
		} else {
			console.error('[AgentStudioEditorPane] setInput: _container is null!');
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			// [Saros] The upstream editorGroupView passes (parent - 35) as
			// height to account for the tab bar. We use flex layout:
			// `.editor-container` has `flex: 1 1 0%` → fills space below
			// the tab bar, and this._container fills it with `height: 100%`.
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = '100%';
		}
		this._webviewController?.layout(dimension.width, dimension.height);
	}

	/**
	 * 重新初始化 webview，用于 webview iframe 跨 document 移动后重新建立通信通道。
	 */
	reinitializeWebview(newSyncLayout?: () => void): void {
		this._webviewController?.reinitializeWebview(newSyncLayout);
	}

	/**
	 * 获取内部容器元素（用于 popout 恢复后获取尺寸）。
	 */
	override getContainer(): HTMLElement | undefined {
		return this._container;
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
		this._chatActiveCtxKey.reset();
		this._disposeWebview();
		super.dispose();
	}
}
