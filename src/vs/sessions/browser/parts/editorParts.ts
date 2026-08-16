/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/editorPart.css';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { EditorParts as EditorPartsBase } from '../../../workbench/browser/parts/editor/editorParts.js';
import { IEditorGroupsService } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { MainEditorPart } from './editorPart.js';
import { AgentEditorPart } from './agentEditorPart.js';

export class EditorParts extends EditorPartsBase {
	protected override createMainEditorPart(): MainEditorPart {
		return this.instantiationService.createInstance(MainEditorPart, this);
	}

	// ── [Saros] Agent zone EditorPart (second main-window part) ──────
	// Lazily created the first time the workbench bootstrap asks for it
	// (during createEditorPart()). It cannot be created eagerly in the
	// constructor because `this.instantiationService` is wired up by the
	// base-class constructor chain that also creates `mainPart`; creating
	// a second part there would re-enter before the parts view is ready.
	//
	// On first access we both instantiate it AND `registerPart()` it so it
	// joins the `_parts` set. Once `_parts.size > 1`, `getPart(group)`
	// routes editor-group operations to the correct part via
	// `part.hasGroup(id)`, giving the two zones physical isolation.
	private _agentPart: AgentEditorPart | undefined;

	get agentPart(): AgentEditorPart {
		if (!this._agentPart) {
			this._agentPart = this._register(this.instantiationService.createInstance(AgentEditorPart, this));
			this._register(this.registerPart(this._agentPart));
		}
		return this._agentPart;
	}
}

registerSingleton(IEditorGroupsService, EditorParts, InstantiationType.Eager);
