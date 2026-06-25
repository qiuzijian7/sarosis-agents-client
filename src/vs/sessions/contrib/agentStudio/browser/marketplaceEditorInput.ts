/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * EditorInput for the VsSaros Marketplace page.

 *
 * Opens in the editor area as a marketplace page for browsing and installing
 * skills/agents/mcp/knowledge-bases from the Sarosis marketplace server.
 * Singleton pattern: only one instance, reopening reuses it.
 *
 * Triggered by clicking the "🛒 Market" button in the Integration sidebar.
 */
export class MarketplaceEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.marketplaceInput';

	private static _instance: MarketplaceEditorInput | undefined;

	static getInstance(): MarketplaceEditorInput {
		if (!MarketplaceEditorInput._instance || MarketplaceEditorInput._instance.isDisposed()) {
			MarketplaceEditorInput._instance = new MarketplaceEditorInput();
		}
		return MarketplaceEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get typeId(): string {
		return MarketplaceEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'workbench.editor.marketplace';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'agent-studio-marketplace',
			path: '/marketplace',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '🛒 VsSaros Marketplace';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof MarketplaceEditorInput;
	}
}
