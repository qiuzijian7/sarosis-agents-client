/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities, GroupIdentifier } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { AgentStudioPanelType } from '../common/constants.js';

/**
 * EditorInput for Agent Studio panels (Canvas, TaskBoard, Chat).
 * Each panel type uses a singleton instance so the same editor tab is reused.
 * These panels are opened in the right editor group (unlocked for free docking).
 * Zone protection in editorGroupFinder.ts prevents non-agent-studio editors from
 * being routed into groups containing agent-studio editors.
 */
export class AgentStudioEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.agentStudioInput';

	private static _instances = new Map<AgentStudioPanelType, AgentStudioEditorInput>();

	static getOrCreate(panelType: AgentStudioPanelType): AgentStudioEditorInput {
		let instance = AgentStudioEditorInput._instances.get(panelType);
		if (!instance || instance.isDisposed()) {
			instance = new AgentStudioEditorInput(panelType);
			AgentStudioEditorInput._instances.set(panelType, instance);
		}
		return instance;
	}

	private readonly _panelType: AgentStudioPanelType;

	/* @ts-ignore - constructor is effectively private (use getOrCreate), but must be public for SyncDescriptor compatibility */
	constructor(panelType: AgentStudioPanelType) {
		super();
		this._panelType = panelType;
	}

	get panelType(): AgentStudioPanelType {
		return this._panelType;
	}

	override get typeId(): string {
		return AgentStudioEditorInput.TypeID;
	}

	override get editorId(): string {
		return `agentStudio.${this._panelType}`;
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'agent-studio',
			path: `/${this._panelType}`,
		});
	}

	override get capabilities(): EditorInputCapabilities {
		// Note: Singleton is intentionally NOT set here. The getOrCreate() pattern
		// already ensures instance uniqueness. Singleton capability would interfere
		// with standard move/drag-drop behavior (VS Code would refuse to move a
		// singleton editor normally, causing blank windows).
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		switch (this._panelType) {
			case 'canvas': return 'Workspace Canvas';
			case 'chat': return 'Agent Chat';
			case 'taskboard': return 'Task Board';
			case 'settings': return 'Settings';
			default: return 'Agent Studio';
		}
	}

	/**
	 * Allow Agent Studio panels to be freely docked between right-side agent-studio groups.
	 * Cross-zone protection (preventing move to/from non-agent-studio groups) is in doMoveOrCopyEditorAcrossGroups.
	 */
	override canMove(_sourceGroup: GroupIdentifier, _targetGroup: GroupIdentifier): true | string {
		return true;
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		if (otherInput instanceof AgentStudioEditorInput) {
			return otherInput._panelType === this._panelType;
		}
		return false;
	}
}
