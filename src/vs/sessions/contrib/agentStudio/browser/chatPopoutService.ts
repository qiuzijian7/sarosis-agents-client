/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { NativeChatEditorInput } from './nativeChatEditorInput.js';

/**
 * Snapshot of a chat editor for pop-out / pop-in round-trip.
 */
export interface IChatEditorSnapshot {
	chatId: string;
	agentId?: string;
	sessionId?: string;
	name?: string;
}

/**
 * ChatPopoutService — centralized pop-out / pop-in logic for chat editors.
 *
 * Replaces the scattered popoutChat action (agentStudio.contribution.ts) +
 * reopen-chat handler (workbench.ts) with a single service that can be
 * called directly via DI instead of CustomEvent communication.
 *
 * Flow:
 *   1. popOut() collects all chat editors from all groups, moves them to
 *      an auxiliary window, and hides the AGENT_EDITOR_PART.
 *   2. popIn() (triggered by aux window onWillDispose) restores the
 *      AGENT_EDITOR_PART visibility and re-opens all chat editors.
 */
export class ChatPopoutService extends Disposable {

	constructor(
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	/**
	 * Pop out all chat editors into a new auxiliary window.
	 * Collects chat editors from ALL groups (not just the first one found),
	 * preserving group count for layout restoration.
	 *
	 * @returns true if pop-out succeeded, false if no chat editors found.
	 */
	async popOut(isChatEditor: (ed: EditorInput) => boolean): Promise<boolean> {
		const chatEditors: EditorInput[] = [];
		const editorToGroupId = new Map<EditorInput, number>();
		const groupIdsWithChat: number[] = [];

		for (const group of this._editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */)) {
			let hasChatInGroup = false;
			for (const ed of group.editors) {
				if (isChatEditor(ed)) {
					chatEditors.push(ed);
					editorToGroupId.set(ed, group.id);
					hasChatInGroup = true;
				}
			}
			if (hasChatInGroup) {
				groupIdsWithChat.push(group.id);
			}
		}

		if (chatEditors.length === 0) {
			return false;
		}

		try {
			const auxPart = await this._editorGroupsService.createAuxiliaryEditorPart();
			const auxGroup = auxPart.activeGroup;

			// Temporarily allow move (canMove() is normally locked to prevent
			// users from dragging chat tabs out of the Agent Editor Part).
			NativeChatEditorInput.beginForceMove();
			try {
				// Move each editor from its original group to the aux window
				for (const editor of chatEditors) {
					const sourceGroupId = editorToGroupId.get(editor)!;
					const sourceGroup = this._editorGroupsService.getGroup(sourceGroupId);
					if (sourceGroup) {
						sourceGroup.moveEditors([{ editor, options: { preserveFocus: false } as any }], auxGroup);
					}
				}
			} finally {
				NativeChatEditorInput.endForceMove();
			}

			// Hide the Agent editor (right column)
			this._layoutService.setPartHidden(true, Parts.AGENT_EDITOR_PART);

			// Hide titlebar toggle buttons
			const toggleContainer = mainWindow.document.getElementById('agent-studio-titlebar-toggle-container');
			if (toggleContainer) {
				toggleContainer.style.display = 'none';
			}

			// Build snapshot for restoration
			const snapshots = this._collectSnapshots(chatEditors);

			// Register restoration callback for when aux window closes
			auxPart.onWillDispose(() => {
				this.popIn(snapshots, groupIdsWithChat.length);
			});

			return true;
		} catch (err) {
			this._logService.error('[ChatPopoutService] popOut failed:', err);
			return false;
		}
	}

	/**
	 * Pop in — restore chat editors to the main window's agent part.
	 * Called when the auxiliary window is disposed (onWillDispose).
	 *
	 * @param snapshots Saved editor snapshots
	 * @param groupCount Number of groups before pop-out (for split layout restore)
	 */
	popIn(snapshots: IChatEditorSnapshot[], groupCount: number): void {
		// Restore part visibility
		this._layoutService.setPartHidden(false, Parts.AGENT_EDITOR_PART);

		// Restore titlebar toggle buttons
		const tc = mainWindow.document.getElementById('agent-studio-titlebar-toggle-container');
		if (tc) {
			tc.style.display = '';
		}

		// Wait for layout to settle, then dispatch reopen event
		requestAnimationFrame(() => {
			mainWindow.document.dispatchEvent(new CustomEvent('agent-studio:reopen-chat', {
				detail: { editors: snapshots, groupCount }
			}));
		});
	}

	/**
	 * Collect snapshots from a list of editor inputs.
	 * Only NativeChatEditorInput is supported (AgentStudioEditorInput is legacy).
	 */
	private _collectSnapshots(editors: EditorInput[]): IChatEditorSnapshot[] {
		return editors.map(ed => {
			if (ed instanceof NativeChatEditorInput) {
				return { chatId: ed.chatId, agentId: ed.agentId, sessionId: ed.sessionId, name: ed.name };
			}
			// Legacy fallback
			return { chatId: (ed as any).panelType || 'chat', agentId: undefined, sessionId: undefined, name: 'Agent Chat' };
		});
	}
}
