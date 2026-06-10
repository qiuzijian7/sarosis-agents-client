/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { KNOT_MCP_MARKET } from '../common/bundled-tools/knotMcpMarket.js';
import { BUNDLED_MCP_PRESETS } from '../common/bundled-tools/bundledMcpPresets.js';

/**
 * EditorInput for the MCP Server Detail page.
 *
 * Opens in the editor area showing a single MCP server's full introduction:
 * icon, name, description, usage guide (markdown), tool list, tags, and an
 * install / delete action button.
 *
 * Parameterized by `marketId` — each market item gets its own input instance
 * (cached by id), so opening different MCP servers shows different pages while
 * reopening the same one reuses the existing editor.
 */
export class McpDetailEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.mcpDetailInput';

	private static readonly _instances = new Map<string, McpDetailEditorInput>();

	static getInstance(marketId: string): McpDetailEditorInput {
		const existing = McpDetailEditorInput._instances.get(marketId);
		if (existing && !existing.isDisposed()) {
			return existing;
		}
		const created = new McpDetailEditorInput(marketId);
		McpDetailEditorInput._instances.set(marketId, created);
		return created;
	}

	constructor(readonly marketId: string) {
		super();
	}

	override get typeId(): string {
		return McpDetailEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'workbench.editor.mcpDetail';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'agent-studio-mcp-detail',
			path: `/detail/${this.marketId}`,
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		const knot = KNOT_MCP_MARKET.find(k => k.id === this.marketId);
		if (knot) {
			return knot.displayName || knot.name;
		}
		const preset = BUNDLED_MCP_PRESETS.find(p => p.id === this.marketId);
		if (preset) {
			return preset.name;
		}
		return 'MCP Server';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof McpDetailEditorInput && otherInput.marketId === this.marketId;
	}

	override dispose(): void {
		McpDetailEditorInput._instances.delete(this.marketId);
		super.dispose();
	}
}
