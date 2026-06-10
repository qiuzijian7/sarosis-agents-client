/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * EditorInput for the Skill Marketplace panel.
 *
 * Opens in the editor area as a marketplace page for browsing and installing
 * skills from multiple hubs (Anthropic Skills, Hermes Skills, etc.).
 * Singleton pattern: only one instance, reopening reuses it.
 *
 * Triggered by clicking the "+ Install" button in the Integration sidebar's
 * Skill tab.
 */
export class SkillMarketEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.skillMarketInput';

	private static _instance: SkillMarketEditorInput | undefined;

	static getInstance(): SkillMarketEditorInput {
		if (!SkillMarketEditorInput._instance || SkillMarketEditorInput._instance.isDisposed()) {
			SkillMarketEditorInput._instance = new SkillMarketEditorInput();
		}
		return SkillMarketEditorInput._instance;
	}

	constructor() {
		super();
	}

	override get typeId(): string {
		return SkillMarketEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'workbench.editor.skillMarket';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'agent-studio-skill-market',
			path: '/marketplace',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return '🧩 Skill Marketplace';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof SkillMarketEditorInput;
	}
}
