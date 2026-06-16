/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { EditorPartModalContext, IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorCommandsContext, isEditorCommandsContext } from '../../../../workbench/common/editor.js';
import { MultiDiffEditorInput } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { CHANGES_VIEW_ID } from '../../changes/common/changes.js';
import { ChangesViewPane } from '../../changes/browser/changesView.js';
import { prepareMoveCopyEditors } from '../../../../workbench/browser/parts/editor/editor.js';
import { Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { MOVE_MODAL_EDITOR_TO_MAIN_COMMAND_ID } from '../../../../workbench/browser/parts/editor/editorCommands.js';
import { AgentStudioEditorInput } from '../../agentStudio/browser/agentStudioEditorInput.js';

// [Sarosis 2026-06-03] Removed `MaximizeMainEditorPartAction` /
// `RestoreMainEditorPartAction` (the "最大化编辑器区域" / "Maximize Editor
// Area" toolbar button on the right column's EditorTitleLayout). The
// dual-zone layout (file zone | agent zone) makes "maximize" semantically
// confusing — users were toggling agent-zone visibility via a button that
// looked like a per-group maximize, not a layout-mode switch. The action
// is gone entirely; if a programmatic maximize is needed, call
// `layoutService.setEditorMaximized(true)` directly.

class OpenEditorInModalEditorAction extends Action2 {
	static readonly ID = 'workbench.action.agentSessions.openEditorInModal';

	constructor() {
		super({
			id: OpenEditorInModalEditorAction.ID,
			title: localize2('openEditorInModal', "Open in Modal Editor"),
			icon: Codicon.openInWindow,
			f1: false,
			// Menu registration removed - "open in modal" button is no longer shown
			// in the editor title bar. Users can use the "Pop Out" button instead.
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const layoutService = accessor.get(IAgentWorkbenchLayoutService);
		const configurationService = accessor.get(IConfigurationService);
		const editorGroupsService = accessor.get(IEditorGroupsService);

		const isMaximized = layoutService.isEditorMaximized();

		// Resolve the target editor group from the args passed by the
		// EditorCommandsContextActionRunner. Because the menu is created
		// with `shouldForwardArgs: true` AND a preset `arg` (the resource
		// URI), the actual call signature is:
		//   run(accessor, resourceUri, IEditorCommandsContext)
		// So we must scan all args for the `IEditorCommandsContext` shape
		// instead of assuming it is the first parameter.
		const commandsContext = args.find(isEditorCommandsContext) as IEditorCommandsContext | undefined;

		console.log('[OpenEditorInModalEditor] run invoked', {
			argsLength: args.length,
			argTypes: args.map(a => a === null ? 'null' : typeof a),
			commandsContext,
			activeGroupId: editorGroupsService.mainPart.activeGroup.id,
		});

		const targetGroup = commandsContext?.groupId !== undefined
			? editorGroupsService.mainPart.getGroup(commandsContext.groupId) ?? editorGroupsService.mainPart.activeGroup
			: editorGroupsService.mainPart.activeGroup;

		const targetGroupEditors = targetGroup.editors.map(e => ({
			typeId: e.typeId,
			editorId: e.editorId,
			isAgentStudio: e instanceof AgentStudioEditorInput,
			isMultiDiff: e instanceof MultiDiffEditorInput,
		}));

		console.log('[OpenEditorInModalEditor] target group resolved', {
			targetGroupId: targetGroup.id,
			editorCount: targetGroup.editors.length,
			activeEditorPaneId: targetGroup.activeEditorPane?.getId(),
			editors: targetGroupEditors,
		});

		// Filter out AgentStudioEditorInput editors — they are singleton
		// editors bound to the agent-studio zone and must not be moved
		// into a modal part (doing so breaks the dual-zone layout).
		const movableEditors = targetGroup.editors.filter(
			editor => !(editor instanceof AgentStudioEditorInput)
		);

		if (movableEditors.length === 0) {
			console.warn('[OpenEditorInModalEditor] aborted: no movable editors in target group (all are AgentStudio editors). Button should not have been visible — check `when` clause.');
			return; // nothing to move — all editors are agent-studio editors
		}

		// Set the `workbench.editor.useModal` setting to 'all'
		await configurationService.updateValue('workbench.editor.useModal', 'all');

		// Check for multi-file diff editor
		const multiFileDiffEditor = movableEditors
			.find(editor => editor instanceof MultiDiffEditorInput);

		if (multiFileDiffEditor) {
			console.log('[OpenEditorInModalEditor] reopening multi-file diff via ChangesView');
			// Reopen multi-file diff editor as the first editor in the modal editor
			const view = viewsService.getViewWithId<ChangesViewPane>(CHANGES_VIEW_ID);
			await view?.openChanges();

			// Close the multi-file diff editor
			await targetGroup.closeEditor(multiFileDiffEditor);
		}

		// Recompute movable editors after possible multi-diff close
		const editorsAfterClose = targetGroup.editors.filter(
			editor => !(editor instanceof AgentStudioEditorInput) && !(editor instanceof MultiDiffEditorInput)
		);

		if (editorsAfterClose.length === 0) {
			console.log('[OpenEditorInModalEditor] aborted: no editors left after multi-diff handling');
			return; // nothing left to move
		}

		// Move all remaining non-agent-studio editors to the modal editor
		const modalPart = await editorGroupsService.createModalEditorPart();
		const editorsToMove = prepareMoveCopyEditors(targetGroup, editorsAfterClose, true);
		console.log('[OpenEditorInModalEditor] moving editors to modal part', {
			modalPartId: modalPart.activeGroup.id,
			moveCount: editorsToMove.length,
		});
		targetGroup.moveEditors(editorsToMove, modalPart.activeGroup);

		// Maximize
		if (isMaximized && !modalPart.maximized) {
			modalPart.toggleMaximized();
		}

		// Focus
		modalPart.activeGroup.focus();
		console.log('[OpenEditorInModalEditor] done');
	}
}

registerAction2(OpenEditorInModalEditorAction);

class OpenModalEditorInEditorAction extends Action2 {
	static readonly ID = 'workbench.action.agentSessions.openModalEditorInEditor';

	constructor() {
		super({
			id: OpenModalEditorInEditorAction.ID,
			title: localize2('openModalEditorInEditor', "Open in Editor Area"),
			icon: Codicon.openInWindow,
			f1: false,
			menu: {
				id: MenuId.ModalEditorTitle,
				group: 'navigation',
				order: 98,
				when: ContextKeyExpr.and(
					IsSessionsWindowContext,
					EditorPartModalContext)
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const commandService = accessor.get(ICommandService);
		const configurationService = accessor.get(IConfigurationService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const layoutService = accessor.get(IAgentWorkbenchLayoutService);

		const activeEditorPart = editorGroupsService.activeModalEditorPart;
		const activeGroup = activeEditorPart?.activeGroup;
		if (!activeEditorPart || !activeGroup) {
			return;
		}

		const isMaximized = activeEditorPart.maximized;

		// Set the `workbench.editor.useModal` setting back to 'some'
		await configurationService.updateValue('workbench.editor.useModal', 'some');

		// Show the main editor part
		layoutService.setPartHidden(false, Parts.EDITOR_PART);

		// Check for navigation in the modal editor
		const navigation = activeGroup.activeEditorPane?.options?.modal?.navigation;
		if (navigation) {
			const view = viewsService.getViewWithId<ChangesViewPane>(CHANGES_VIEW_ID);
			const changes = view?.viewModel.activeSessionChangesObs.get();

			if (changes && navigation.current < changes.length) {
				// Reopen multi-file diff editor for the current file
				await view?.openChanges(changes[navigation.current].modifiedUri ?? changes[navigation.current].originalUri);

				// Close the editor in the modal editor (assume that the
				// multi-file diff editor is the first editor in the modal
				// editor)
				await activeGroup.closeEditor(activeGroup.editors[0]);
			}
		}

		// Move all remaining editors to the main editor part
		await commandService.executeCommand(MOVE_MODAL_EDITOR_TO_MAIN_COMMAND_ID);

		// Maximize
		if (isMaximized) {
			layoutService.setEditorMaximized(true);
		}

		// Focus
		editorGroupsService.activeGroup.focus();
	}
}

registerAction2(OpenModalEditorInEditorAction);
