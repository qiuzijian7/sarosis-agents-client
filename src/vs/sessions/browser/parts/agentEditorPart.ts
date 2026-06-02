/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../base/browser/window.js';
import { EditorPart } from '../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorPartsView } from '../../../workbench/browser/parts/editor/editor.js';
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
	}
}
