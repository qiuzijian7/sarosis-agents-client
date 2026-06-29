/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * Editor pane ID — exported so the input's `editorId` getter can reference it
 * without creating a circular import (input does not import the pane).
 */
export const ResourceManagerEditorPane_ID = 'workbench.editor.resourceManager';

/**
 * EditorInput for the Resource Manager pane.
 *
 * Provides a unified management interface for Skills / Tools / MCP servers /
 * Knowledge bases / Workflows installed locally. Combines a left sidebar list
 * with a center detail editor (similar to the Marketplace Skill/MCP detail
 * pages) in a single pane.
 *
 * Singleton pattern: only one instance, reopening reuses it.
 */
export class ResourceManagerEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.resourceManagerInput';

	private static _instance: ResourceManagerEditorInput | undefined;

	/** Current item name for dynamic tab title */
	private _currentItemName: string | undefined;

	static getInstance(): ResourceManagerEditorInput {
		if (!ResourceManagerEditorInput._instance || ResourceManagerEditorInput._instance.isDisposed()) {
			ResourceManagerEditorInput._instance = new ResourceManagerEditorInput();
		}
		return ResourceManagerEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get typeId(): string {
		return ResourceManagerEditorInput.TypeID;
	}

	override get editorId(): string {
		return ResourceManagerEditorPane_ID;
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'agent-studio-resource-manager',
			path: '/manager',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	/** Set the displayed name (tab title) and notify the workbench to re-render */
	setItemName(name: string): void {
		if (this._currentItemName !== name) {
			this._currentItemName = name;
			this._onDidChangeLabel.fire();
		}
	}

	/** Reset to default name */
	resetName(): void {
		this.setItemName('');
	}

	override getName(): string {
		return this._currentItemName || '🗂️ Resource Manager';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof ResourceManagerEditorInput;
	}
}
