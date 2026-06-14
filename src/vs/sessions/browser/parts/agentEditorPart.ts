/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../base/browser/window.js';
import { EditorPart } from '../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorPartsView, IEditorPartCreationOptions } from '../../../workbench/browser/parts/editor/editor.js';
import { Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { MainEditorPart as SessionsMainEditorPart } from './editorPart.js';

/**
 * [Sarosis] AgentEditorPart — the second main-window-level EditorPart that
 * hosts the Agent Studio zone (Canvas / Chat) on the right column.
 *
 * It is a thin subclass of the upstream `EditorPart`, identical to the
 * upstream `MainEditorPart` except that it is registered under the
 * dedicated `Parts.AGENT_EDITOR_PART` id instead of `Parts.EDITOR_PART`.
 * The base class already provides a single-grid / single-group layout,
 * which is exactly the Agent zone's initial form — no grid override needed.
 *
 * Physical isolation: because this is a *distinct* Part with its own DOM
 * container and its own editor grid, editors cannot be dragged across the
 * File zone (EDITOR_PART) and the Agent zone (AGENT_EDITOR_PART). Both
 * parts share `mainWindow.vscodeWindowId` (so this is NOT a multi-window /
 * auxiliary part); group→part routing in `EditorParts.getPart(group)`
 * disambiguates them via `part.hasGroup(id)`.
 */
export class AgentEditorPart extends EditorPart {

	constructor(
		editorPartsView: IEditorPartsView,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IHostService hostService: IHostService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		super(editorPartsView, Parts.AGENT_EDITOR_PART, '', mainWindow.vscodeWindowId, instantiationService, themeService, configurationService, storageService, layoutService, hostService, contextKeyService);

		// [Sarosis] ROOT CAUSE FIX for "Canvas/Chat show no tab bar".
		//
		// The base EditorPart only renders a tab bar when its part option
		// `showTabs === 'multiple'` (see editorPart.ts: the line that does
		// `editorTabsVisibleContext.set(this.partOptions.showTabs === 'multiple')`).
		// That option is derived from the GLOBAL user setting
		// `workbench.editor.showTabs`. If the user has it set to 'single' or
		// 'none' (a very common preference), the Agent zone group — even with
		// Canvas + Chat both present — only renders the single active editor,
		// which is exactly the reported "only the last-opened panel shows /
		// no tabs" symptom (and why it flip-flopped between Canvas and Chat).
		//
		// The Agent zone is a *fixed* two-tab layout by product design, so we
		// force `showTabs: 'multiple'` on THIS part only, regardless of the
		// user's global preference. `enforcePartOptions` re-applies on every
		// option recompute, so a later config change can't revert it.
		this.enforcePartOptions({
			showTabs: 'multiple',
			limit: { enabled: false, value: 10, perEditorGroup: false, excludeDirty: false }
		});
	}

	// [Sarosis] Constrain Agent zone width: prevent the panel from growing
	// wider than 650px or narrower than 450px when dragging the sash.
	override get minimumWidth(): number { return 450; }
	override get maximumWidth(): number { return 650; }

	/**
	 * [Sarosis] Reserve a 32-px band at the top of the agent part for the
	 * `AgentStudioWorkspaceToolbar` overlay (workbench.ts).
	 *
	 * The overlay is an `absolute`/`z-index:15` element sitting on
	 * `mainContainer`, NOT a child of this part's grid. Without this
	 * override, the part's grid view (and therefore the EditorGroupView's
	 * tab bar) is rendered at `top = partRect.top` — i.e. exactly where the
	 * toolbar overlay paints, so the tab bar is hidden behind the toolbar.
	 *
	 * Strategy:
	 *   1. After `createContentArea` builds the inner `.content` element,
	 *      we shift it down by `TOOLBAR_HEIGHT` via inline `top` (it is
	 *      positioned by `size()` width/height only, so we are free to set
	 *      its top without breaking upstream metrics).
	 *   2. In `layout()` we forward a `height - TOOLBAR_HEIGHT` to the
	 *      base class so the grid sizes itself for the freed area; the
	 *      `top` argument is informational for the grid (it doesn't
	 *      DOM-position the part container) so we leave it alone.
	 *
	 * The matching change in workbench.ts stops clamping `desiredTop` to
	 * `>= 0`, so the toolbar overlay now anchors to `partRect.top` —
	 * exactly the band we just freed.
	 */
	protected override createContentArea(parent: HTMLElement, options?: IEditorPartCreationOptions): HTMLElement {
		const result = super.createContentArea(parent, options);
		// `this.container` is the inner `.content` element (created via
		// `$('.content')`); `size()` from `dom.ts` only writes width/height,
		// so it's safe to anchor it 32px below the part's top edge.
		const reserved = SessionsMainEditorPart.TOOLBAR_HEIGHT;
		(result as HTMLElement).style.position = 'absolute';
		(result as HTMLElement).style.top = `${reserved}px`;
		(result as HTMLElement).style.left = '0';
		return result;
	}

	override layout(width: number, height: number, top: number, left: number): void {
		const reserved = SessionsMainEditorPart.TOOLBAR_HEIGHT;
		super.layout(
			width,
			Math.max(0, height - reserved),
			top,
			left
		);
	}
}
