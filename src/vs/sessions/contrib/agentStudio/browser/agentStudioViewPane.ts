/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { AgentStudioWebviewController } from './agentStudioWebviewController.js';
import type { AgentStudioPanelType } from '../common/constants.js';

/**
 * Base ViewPane for Agent Studio panels.
 * Each panel hosts a WebView instance with a specific panelType so the React
 * app knows which component to render (chat / taskboard).
 */
export class AgentStudioViewPane extends ViewPane {

	protected _webviewController: AgentStudioWebviewController | undefined;
	private _webviewContainer: HTMLElement | undefined;

	/** Override in subclass to select a specific panel. undefined = full app (legacy). */
	protected get panelType(): AgentStudioPanelType | undefined {
		return undefined;
	}

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService override readonly instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('agent-studio-view-pane');

		// Create WebView container
		this._webviewContainer = document.createElement('div');
		this._webviewContainer.classList.add('webview-container');
		this._webviewContainer.style.width = '100%';
		this._webviewContainer.style.height = '100%';
		container.appendChild(this._webviewContainer);

		// Initialize WebView controller with the panel type
		this._webviewController = this._register(
			this.instantiationService.createInstance(AgentStudioWebviewController, this._webviewContainer, this.panelType, undefined)
		);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._webviewController?.layout(width, height);
	}

	override dispose(): void {
		this._webviewController = undefined;
		super.dispose();
	}
}

// ─── Specialized Panel ViewPanes ─────────────────────────────────────────────

/**
 * Chat ViewPane — shows the agent chat interface.
 * Can be freely docked anywhere in the workbench.
 */
export class AgentStudioChatViewPane extends AgentStudioViewPane {
	protected override get panelType(): AgentStudioPanelType { return 'chat'; }
}

/**
 * TaskBoard ViewPane — shows the task/kanban board.
 * Can be freely docked anywhere in the workbench.
 */
export class AgentStudioTaskBoardViewPane extends AgentStudioViewPane {
	protected override get panelType(): AgentStudioPanelType { return 'taskboard'; }
}
