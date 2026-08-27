/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenuRegistry, MenuId } from '../../../../platform/actions/common/actions.js';
import { ActiveEditorContext } from '../../../../workbench/common/contextkeys.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IAgentChatService } from '../../../common/agentStudioService.js';
import { NativeChatEditorInput } from './nativeChatEditorInput.js';

/**
 * Command id for renaming a chat (Agent Studio) editor tab.
 *
 * Opening the input box updates BOTH the editor tab label and the underlying
 * agent session name, keeping the two in sync:
 *   - editor tab title is refreshed via `NativeChatEditorInput.setAgentInfo`
 *     (which re-renders `agentName (sessionName)`)
 *   - session name is persisted via `IAgentChatService.renameAgentSession`
 *     (which the webview also observes, completing the bidirectional sync)
 */
export const RENAME_CHAT_TAB_COMMAND_ID = 'agentStudio.chat.renameTab';

/**
 * Register the "Rename" entry in the editor tab context menu plus its command.
 *
 * This module is imported for its side effect from `agentStudio.contribution.ts`
 * so registration happens exactly once at startup.
 */
function registerChatTabRename(): void {
	CommandsRegistry.registerCommand({
		id: RENAME_CHAT_TAB_COMMAND_ID,
		handler: async (accessor, editorArg) => {
			const editorService = accessor.get(IEditorService);
			const quickInputService = accessor.get(IQuickInputService);
			const chatService = accessor.get(IAgentChatService);

			// The editor instance is forwarded as the menu `arg` from
			// editorTabsControl.onTabContextMenu, so we target the tab the
			// user right-clicked rather than `activeEditor` (which may be a
			// different editor).
			const editor = editorArg instanceof NativeChatEditorInput
				? editorArg
				: editorService.activeEditor;
			if (!(editor instanceof NativeChatEditorInput)) {
				return;
			}

			const agentId = editor.agentId;
			const sessionId = editor.sessionId;
			if (!agentId || !sessionId) {
				return;
			}

			// Resolve the current session name to prefill the input box.
			let currentName = '';
			try {
				const sessions = await chatService.listAgentSessions(agentId);
				currentName = sessions.find((s) => s.id === sessionId)?.name ?? '';
			} catch {
				// Fallback: use the tab label as-is (it already equals the session name).
				currentName = editor.name;
			}

			const newName = await quickInputService.input({
				title: localize('renameChatTab.title', "Rename Chat Session"),
				placeHolder: localize('renameChatTab.placeHolder', "Enter a new name for this chat session"),
				value: currentName,
				prompt: localize('renameChatTab.prompt', "The session name and editor tab will be updated together."),
				validateInput: async (value) =>
					value.trim().length === 0
						? localize('renameChatTab.empty', "Name must not be empty.")
						: null,
			});
			if (newName === undefined || newName.trim().length === 0) {
				return;
			}

			// 1) Update the editor tab label immediately (session name only).
			editor.setAgentInfo(editor.name, agentId, sessionId, newName);
			// 2) Persist the new session name so the webview stays in sync.
			await chatService.renameAgentSession(agentId, sessionId, newName);
		},
	});

	MenuRegistry.appendMenuItem(MenuId.EditorTitleContext, {
		command: {
			id: RENAME_CHAT_TAB_COMMAND_ID,
			title: localize('renameChatTab.menu', "Rename"),
		},
		when: ActiveEditorContext.isEqualTo(NativeChatEditorInput.EditorID),
		group: '1_rename',
	});
}

registerChatTabRename();
