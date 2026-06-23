import assert from 'assert';

suite('Test Verifier', () => {
	test('should pass', () => {
		assert.strictEqual(1 + 1, 2);
	});

	test('should fail', () => {
		assert.strictEqual(1 + 1, 2); // This should pass
	});
});
