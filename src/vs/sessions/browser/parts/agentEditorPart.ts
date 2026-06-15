/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../base/browser/window.js';
import { EditorPart } from '../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorPartCreationOptions, IEditorPartsView } from '../../../workbench/browser/parts/editor/editor.js';
import { Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';

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

		// [Sarosis] Show tab bar when multiple editors are open.
		//
		// The Agent zone can host multiple editors (Native Chat, Canvas,
		// TaskBoard, etc.). `showTabs: 'multiple'` shows the tab bar
		// whenever more than one editor is open, keeping the UI clean
		// when only Agent Chat is present.
		//
		// `enforcePartOptions` re-applies on every option recompute, so a
		// later config change can't revert it.
		this.enforcePartOptions({
			showTabs: 'multiple',
			limit: { enabled: false, value: 10, perEditorGroup: false, excludeDirty: false }
		});
	}

	// [Sarosis] Constrain Agent zone width: prevent the panel from growing
	// wider than 650px or narrower than 450px when dragging the sash.
	override get minimumWidth(): number { return 450; }
	override get maximumWidth(): number { return 650; }

	// [Sarosis] Add a distinguishing class to the part's root element so
	// CSS can target the agent editor's title bar independently of the
	// file editor zone.
	protected override createContentArea(parent: HTMLElement, options?: IEditorPartCreationOptions): HTMLElement {
		const element = super.createContentArea(parent, options);
		// The part's root element gets its classes during create() in the
		// base Part class. We add `agent-editor-part` here so CSS rules
		// like `.agent-editor-part .title` can suppress the tab bar.
		// We must wait a microtask because the base Part.create() populates
		// the element's classList after createContentArea returns.
		queueMicrotask(() => {
			if (this.element) {
				this.element.classList.add('agent-editor-part');
			}
		});
		return element;
	}
}
