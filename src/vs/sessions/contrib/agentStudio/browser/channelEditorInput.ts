/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { ChannelKey } from '../common/constants.js';

/**
 * EditorInput for a Channel configuration page.
 * Each channel (WhatsApp, Telegram, Discord, etc.) opens a dedicated
 * configuration form in the editor area.
 */
export class ChannelEditorInput extends EditorInput {

	static readonly TypeID = 'workbench.editors.channelInput';

	private static _instances = new Map<ChannelKey, ChannelEditorInput>();

	static getOrCreate(channelKey: ChannelKey): ChannelEditorInput {
		let instance = ChannelEditorInput._instances.get(channelKey);
		if (!instance || instance.isDisposed()) {
			instance = new ChannelEditorInput(channelKey);
			ChannelEditorInput._instances.set(channelKey, instance);
		}
		return instance;
	}

	constructor(
		private readonly _channelKey: ChannelKey,
	) {
		super();
	}

	get channelKey(): ChannelKey {
		return this._channelKey;
	}

	override get typeId(): string {
		return ChannelEditorInput.TypeID;
	}

	override get editorId(): string {
		return 'agentStudio.channel';
	}

	override get resource(): URI | undefined {
		return URI.from({
			scheme: 'agent-studio-channel',
			path: `/${this._channelKey}`,
		});
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return `📡 Channel: ${this._channelKey}`;
	}

	override matches(otherInput: EditorInput | unknown): boolean {
		return otherInput instanceof ChannelEditorInput
			&& otherInput._channelKey === this._channelKey;
	}
}
