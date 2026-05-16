/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities, GroupIdentifier } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import type { AgentStudioPanelType } from '../common/constants.js';

/**
 * EditorInput for Agent Studio panels (Canvas, TaskBoard, Chat, Settings).
 * Each panel type uses a singleton instance so the same editor tab is reused.
 *
 * Layout rules (Sessions window):
 *   - The editor area is permanently split into exactly TWO zones:
 *     Left = file editors, Right = Agent Studio panels.
 *   - Within each zone, the user may freely split to create sub-groups
 *     (e.g. split Agent Chat left/right or top/bottom inside the
 *     agent-studio zone). New sub-groups are tracked automatically by
 *     `sessions/browser/workbench.ts` (`onDidAddGroup`).
 *   - Agent Studio editors CANNOT be dragged to the left (file) zone.
 *   - File editors CANNOT be dragged to the right (Agent Studio) zone.
 *   - Within a group, tabs can be freely reordered.
 *
 * Enforcement layers:
 *   - `editorDropTarget.ts` (drop overlay + drop handler) blocks
 *     cross-zone drops. Same-zone splits are allowed.
 *   - `sessions/browser/parts/editorPart.ts` overrides `addGroup` to
 *     convert split directions that would escape either zone into
 *     orthogonal directions (e.g. RIGHT→DOWN) when a zone group is
 *     a direct root leaf. Both the file zone and agent-studio zone
 *     share the same containment strategy.
 *   - The Sessions workbench installs a relocation guard that moves
 *     any agent-studio editor back into the zone if it somehow lands
 *     outside (e.g. via API calls bypassing the drop target).
 *   - This file therefore intentionally does NOT veto moves at the
 *     EditorInput layer: returning a string from `canMove()` would
 *     surface a modal dialog via `editorGroupView`, which is exactly
 *     what we want to avoid.
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
	 * Always permit the move at the EditorInput layer. The two-zone
	 * layout is enforced by:
	 *   1. `editorDropTarget.ts` — blocks cross-zone drag-and-drop.
	 *      Same-zone splits are allowed so the user can freely
	 *      rearrange sub-groups within the agent-studio zone.
	 *   2. The Sessions workbench relocation guard
	 *      (`installRelocationGuard` in `sessions/browser/workbench.ts`)
	 *      — moves any agent-studio editor that ends up in the file
	 *      zone back into the agent-studio zone.
	 *
	 * Returning a string here would surface a modal dialog via
	 * `editorGroupView.doMoveOrCopyEditorAcrossGroups`, which is exactly
	 * what we want to avoid. The veto layers above already guarantee the
	 * editor cannot escape the zone.
	 */
	override canMove(_sourceGroup: GroupIdentifier, _targetGroup: GroupIdentifier): true | string {
		return true;
	}

	// ─── Static helpers for drag-drop guards ───────────────────────────

	/**
	 * Check whether a dragged editor is an Agent Studio editor
	 * (uses the `agent-studio` URI scheme).
	 */
	static isAgentStudioScheme(editor: { resource?: URI }): boolean {
		return editor.resource?.scheme === 'agent-studio';
	}

	/**
	 * Check whether a given editor group contains at least one
	 * Agent Studio editor. Used by drag-drop guards to identify
	 * the right-side Agent Studio zone.
	 */
	static isAgentStudioGroup(groupId: GroupIdentifier, editorGroupsService?: IEditorGroupsService): boolean {
		if (editorGroupsService) {
			const group = editorGroupsService.getGroup(groupId);
			if (group) {
				return group.editors.some(e => e instanceof AgentStudioEditorInput);
			}
		}
		return false;
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		if (otherInput instanceof AgentStudioEditorInput) {
			return otherInput._panelType === this._panelType;
		}
		return false;
	}
}
