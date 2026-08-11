/*---------------------------------------------------------------------------------------------
 *  Unit tests for dagLayout — layered auto-layout (P2).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { computeDagLayout } from '../../webview/src/features/workflowEditor/comfyHost/dagLayout.js';

suite('computeDagLayout', () => {

	test('empty graph → empty layout', () => {
		const layout = computeDagLayout([], []);
		assert.strictEqual(layout.size, 0);
	});

	test('single node sits at origin', () => {
		const layout = computeDagLayout([{ id: 'a' }], []);
		assert.deepStrictEqual(layout.get('a'), { x: 0, y: 0 });
	});

	test('chain A→B→C places them in three columns', () => {
		const layout = computeDagLayout(
			[{ id: 'a' }, { id: 'b' }, { id: 'c' }],
			[{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
			{ columnGap: 100 },
		);
		assert.strictEqual(layout.get('a')!.x, 0);
		assert.strictEqual(layout.get('b')!.x, 100);
		assert.strictEqual(layout.get('c')!.x, 200);
	});

	test('diamond places B and C in the same column', () => {
		const layout = computeDagLayout(
			[{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
			[
				{ source: 'a', target: 'b' },
				{ source: 'a', target: 'c' },
				{ source: 'b', target: 'd' },
				{ source: 'c', target: 'd' },
			],
			{ columnGap: 100 },
		);
		assert.strictEqual(layout.get('a')!.x, 0);
		assert.strictEqual(layout.get('b')!.x, 100);
		assert.strictEqual(layout.get('c')!.x, 100);
		assert.strictEqual(layout.get('d')!.x, 200);
		// B and C are vertically separated.
		assert.ok(layout.get('b')!.y !== layout.get('c')!.y);
	});

	test('independent roots share column 0', () => {
		const layout = computeDagLayout([{ id: 'a' }, { id: 'b' }, { id: 'c' }], []);
		assert.strictEqual(layout.get('a')!.x, 0);
		assert.strictEqual(layout.get('b')!.x, 0);
		assert.strictEqual(layout.get('c')!.x, 0);
		assert.ok(layout.get('a')!.y !== layout.get('b')!.y);
	});

	test('cycle does not hang and all nodes get a position', () => {
		const layout = computeDagLayout(
			[{ id: 'a' }, { id: 'b' }],
			[{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
		);
		assert.strictEqual(layout.size, 2);
		assert.ok(layout.has('a'));
		assert.ok(layout.has('b'));
	});

	test('custom origin and gaps honored', () => {
		const layout = computeDagLayout(
			[{ id: 'a' }, { id: 'b' }],
			[{ source: 'a', target: 'b' }],
			{ originX: 10, originY: 20, columnGap: 50, rowGap: 30 },
		);
		assert.strictEqual(layout.get('a')!.x, 10);
		assert.strictEqual(layout.get('a')!.y, 20);
		assert.strictEqual(layout.get('b')!.x, 60);
	});
});
