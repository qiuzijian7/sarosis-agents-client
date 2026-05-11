/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';

suite('Minimal Test', () => {
	test('should pass', () => {
		assert.strictEqual(1 + 1, 2);
	});

	test('should handle async', async () => {
		const result = await Promise.resolve(42);
		assert.strictEqual(result, 42);
	});
});
