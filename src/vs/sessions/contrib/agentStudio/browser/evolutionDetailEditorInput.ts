/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEvolutionRecord } from '../common/selfEvolution.js';

/**
 * EditorInput for the Evolution Detail panel.
 *
 * Each evolution record opens in the editor area as an HTML-rendered detail page.
 * Uses a singleton pattern per record ID — reopening the same record reuses the instance.
 */
export class EvolutionDetailEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.evolutionDetailInput';

	private static _instance: EvolutionDetailEditorInput | undefined;
	private static _currentRecord: IEvolutionRecord | undefined;

	static getOrCreate(record: IEvolutionRecord): EvolutionDetailEditorInput {
		EvolutionDetailEditorInput._currentRecord = record;
		if (!EvolutionDetailEditorInput._instance || EvolutionDetailEditorInput._instance.isDisposed()) {
			EvolutionDetailEditorInput._instance = new EvolutionDetailEditorInput();
		}
		return EvolutionDetailEditorInput._instance;
	}

	static getCurrentRecord(): IEvolutionRecord | undefined {
		return EvolutionDetailEditorInput._currentRecord;
	}

	constructor() {
		super();
		if (EvolutionDetailEditorInput._instance && !EvolutionDetailEditorInput._instance.isDisposed()) {
			console.warn('[EvolutionDetailEditorInput] Use EvolutionDetailEditorInput.getOrCreate() to get the singleton.');
		}
		EvolutionDetailEditorInput._instance = this;
	}

	override get typeId(): string {
		return EvolutionDetailEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'workbench.editor.evolutionDetail';
	}

	override get resource(): URI | undefined {
		const record = EvolutionDetailEditorInput._currentRecord;
		return URI.from({
			scheme: 'agent-studio-evolution',
			path: record ? `/${record.id}` : '/unknown',
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	get record(): IEvolutionRecord | undefined {
		return EvolutionDetailEditorInput._currentRecord;
	}

	override getName(): string {
		const record = EvolutionDetailEditorInput._currentRecord;
		return record ? `🧬 ${record.agentName} — ${record.summary}` : 'Evolution Detail';
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof EvolutionDetailEditorInput;
	}
}
