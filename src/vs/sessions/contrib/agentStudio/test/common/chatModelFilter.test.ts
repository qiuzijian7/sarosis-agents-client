/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IModelInfo } from '../../common/providers.js';
import { isChatCapableModel, isGenerativeMediaModel } from '../../common/chatModelFilter.js';

function makeModel(overrides: Partial<IModelInfo>): IModelInfo {
	return { id: 'test-model', name: 'Test Model', ...overrides };
}

suite('Chat Model Filter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// #region isGenerativeMediaModel

	test('detects image generation models', () => {
		assert.strictEqual(isGenerativeMediaModel(makeModel({ supportsImageGen: true })), true);
	});

	test('detects video generation models', () => {
		assert.strictEqual(isGenerativeMediaModel(makeModel({ supportsVideoGen: true })), true);
	});

	test('detects 3D model generation models', () => {
		assert.strictEqual(isGenerativeMediaModel(makeModel({ supportsModelGen: true })), true);
	});

	test('detects audio generation models', () => {
		assert.strictEqual(isGenerativeMediaModel(makeModel({ supportsAudioGen: true })), true);
	});

	test('plain model is not a generative media model', () => {
		assert.strictEqual(isGenerativeMediaModel(makeModel({})), false);
	});

	// #endregion

	// #region chatbot models stay visible

	test('plain model is chat capable', () => {
		assert.strictEqual(isChatCapableModel(makeModel({})), true);
	});

	test('vision-only model is chat capable', () => {
		assert.strictEqual(isChatCapableModel(makeModel({ supportsImages: true })), true);
	});

	test('tool-calling model is chat capable', () => {
		assert.strictEqual(isChatCapableModel(makeModel({ supportsToolCall: true })), true);
	});

	test('reasoning model is chat capable', () => {
		assert.strictEqual(isChatCapableModel(makeModel({ supportsReasoning: true })), true);
	});

	// #endregion

	// #region generation models are hidden from the chat list

	test('image generation model is not chat capable', () => {
		assert.strictEqual(isChatCapableModel(makeModel({ supportsImageGen: true })), false);
	});

	test('video generation model is not chat capable', () => {
		assert.strictEqual(isChatCapableModel(makeModel({ supportsVideoGen: true })), false);
	});

	test('3D generation model is not chat capable', () => {
		assert.strictEqual(isChatCapableModel(makeModel({ supportsModelGen: true })), false);
	});

	test('audio generation model is not chat capable', () => {
		assert.strictEqual(isChatCapableModel(makeModel({ supportsAudioGen: true })), false);
	});

	test('lightai-shaped model (all flags off except image gen) is filtered out', () => {
		assert.strictEqual(isChatCapableModel(makeModel({
			id: 'picture_banana_2',
			supportsImages: false,
			supportsToolCall: false,
			supportsImageGen: true,
		})), false);
	});

	// #endregion

	// #region mixed-capability models favour chat

	test('model that both chats and generates images stays selectable', () => {
		assert.strictEqual(isChatCapableModel(makeModel({
			supportsImageGen: true,
			supportsToolCall: true,
		})), true);
	});

	test('model with vision and image generation stays selectable', () => {
		assert.strictEqual(isChatCapableModel(makeModel({
			supportsImageGen: true,
			supportsImages: true,
		})), true);
	});

	// #endregion
});
