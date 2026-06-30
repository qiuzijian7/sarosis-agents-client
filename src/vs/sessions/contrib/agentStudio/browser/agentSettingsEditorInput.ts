/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { Emitter } from '../../../../base/common/event.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/**
 * EditorInput for Agent Settings editor pane.
 *
 * Carries an agentId so the editor pane can inject it into the
 * webview as initialData, allowing the React AgentEditorPane to
 * render the correct agent's settings tabs.
 */
export class AgentSettingsEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.agentSettings';

	private readonly _agentId: string;
	private _agentName: string;

	constructor(agentId: string, agentName?: string) {
		super();
		this._agentId = agentId;
		this._agentName = agentName ?? agentId;
	}

	get agentId(): string {
		return this._agentId;
	}

	get agentName(): string {
		return this._agentName;
	}

	/** Update the agent name (used when the agent is renamed). */
	setAgentName(name: string): void {
		if (this._agentName !== name) {
			this._agentName = name;
			this._onDidChangeName.fire();
		}
	}

	private readonly _onDidChangeName = this._register(new Emitter<void>());
	readonly onDidChangeName = this._onDidChangeName.event;

	override get typeId(): string {
		return AgentSettingsEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return AgentSettingsEditorInput.ID;
	}

	override get resource(): URI {
		return URI.from({ scheme: 'saros-agent-settings', path: `/${this._agentId}` });
	}

	override getName(): string {
		return `${this._agentName} — 配置`;
	}

	override matches(other: EditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof AgentSettingsEditorInput) {
			return this._agentId === other._agentId;
		}
		return false;
	}
}
