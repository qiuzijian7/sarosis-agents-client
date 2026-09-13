/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IModelInfo } from './providers.js';

/**
 * Whether a model can participate in a text chat conversation.
 *
 * Some providers (e.g. the LightAI extension) are bridged into the language
 * model list even though they only expose generative media models — image,
 * video, 3D and audio. The VS Code LM API has no way to express "this model
 * cannot chat", so such providers flatten every media model into the same list
 * as real chat models, and selecting one throws at request time.
 *
 * Rather than hard-coding vendor names, the classification is derived from the
 * capability flags the bridge already computes:
 *
 * - A model is a **chat** model when it advertises vision (`supportsImages`) or
 *   tool calling (`supportsToolCall`).
 * - A model is a **generative-media** model when it advertises any of the
 *   generation capabilities (`supportsImageGen` / `supportsVideoGen` /
 *   `supportsModelGen` / `supportsAudioGen`).
 *
 * Chat wins over media: a hypothetical model offering both stays selectable,
 * since it can genuinely drive a conversation.
 */
export function isChatCapableModel(model: IModelInfo): boolean {
	if (model.supportsImages || model.supportsToolCall) {
		return true;
	}

	return !isGenerativeMediaModel(model);
}

/**
 * Whether a model exclusively generates media (image / video / 3D / audio) and
 * therefore cannot serve a text chat conversation.
 */
export function isGenerativeMediaModel(model: IModelInfo): boolean {
	return Boolean(
		model.supportsImageGen
		|| model.supportsVideoGen
		|| model.supportsModelGen
		|| model.supportsAudioGen
	);
}
