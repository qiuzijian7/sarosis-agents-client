/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * EditorInput for the MCP Server Management panel.
 *
 * Opens in the editor area as a management page for MCP servers —
 * view connected servers, their tools, and add/remove servers.
 * Singleton pattern: only one instance, reopening reuses it.
 */
export class McpServerEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.mcpServerInput';

	private static _instance: McpServerEditorInput | undefined;

	static getInstance(): McpServerEditorInput {
		if (!McpServerEditorInput._instance || McpServerEditorInput._instance.isDisposed()) {
			McpServerEditorInput._instance = new McpServerEditorInput();
		}
		return McpServerEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get typeId(): string {
		return McpServerEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'workbench.editor.mcpServer';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'agent-studio-mcp',
			path: '/servers',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '🔌 MCP Servers';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof McpServerEditorInput;
	}
}
