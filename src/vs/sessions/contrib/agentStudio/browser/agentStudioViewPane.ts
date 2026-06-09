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
import { ILifecycleService, LifecyclePhase } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
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

	/**
	 * Last layout size reported via {@link layoutBody}. Cached because the
	 * webview is created lazily (on first visibility), and layoutBody may fire
	 * before the controller exists. Replayed once the controller is created.
	 */
	private _lastLayout: { width: number; height: number } | undefined;

	/**
	 * Guards against scheduling more than one deferred webview creation while
	 * we wait for the {@link LifecyclePhase.Restored} phase.
	 */
	private _webviewPending = false;

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
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
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

		// Lazy webview creation: only build the WebView once the view is
		// ACTUALLY visible. Creating it eagerly in renderBody (which fires
		// during workbench restore on startup) makes the webview iframe +
		// service-worker cold-start contend with the busy startup main thread,
		// which was the root cause of the ~27s "process-spawn+html" stall.
		if (this.isBodyVisible()) {
			this._ensureWebview();
		} else {
			const listener = this._register(this.onDidChangeBodyVisibility((visible) => {
				if (visible) {
					listener.dispose();
					this._ensureWebview();
				}
			}));
		}
	}

	/**
	 * Create the webview controller on demand (idempotent).
	 *
	 * Deferred creation: wait until at least {@link LifecyclePhase.Restored}
	 * (views/panels have been restored) so we don't contend with the
	 * workbench layout restore. After Restored, the controller's async
	 * `_createWebviewAsync` reads the bundle from disk (fast, ~20ms) then
	 * builds the webview with inline bundles + disabled service worker,
	 * eliminating the old ~24s SW cold-start stall.
	 *
	 * If the lifecycle is already past Restored (user opened the panel
	 * after startup), `when()` resolves immediately with no delay.
	 */
	private _ensureWebview(): void {
		if (this._webviewController || this._webviewPending || !this._webviewContainer) {
			return;
		}
		this._webviewPending = true;
		this.lifecycleService.when(LifecyclePhase.Restored).then(() => {
			this._webviewPending = false;
			// The view may have been disposed while we were waiting.
			if (this._webviewController || !this._webviewContainer) {
				return;
			}
			this._createWebviewNow();
		});
	}

	/** Synchronously build the controller and replay the last layout. */
	private _createWebviewNow(): void {
		this._webviewController = this._register(
			this.instantiationService.createInstance(AgentStudioWebviewController, this._webviewContainer!, this.panelType, undefined)
		);
		// Replay the most recent layout so the freshly created webview is sized
		// correctly (layoutBody may have fired before the controller existed).
		if (this._lastLayout) {
			this._webviewController.layout(this._lastLayout.width, this._lastLayout.height);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._lastLayout = { width, height };
		this._webviewController?.layout(width, height);
	}

	override dispose(): void {
		this._webviewController = undefined;
		// Clear the container so any pending (post-Restored) creation callback
		// short-circuits instead of building a webview into a dead view.
		this._webviewContainer = undefined;
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
