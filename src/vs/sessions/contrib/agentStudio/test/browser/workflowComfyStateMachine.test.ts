/*---------------------------------------------------------------------------------------------
 *  Unit tests for nodeStateMachine — workflow node execution state machine.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	NodeStateMachine,
	downstreamOf,
	isStateOrderValid,
	InvalidTransitionError,
} from '../../webview/src/features/workflowEditor/comfyHost/nodeStateMachine.js';

suite('nodeStateMachine', () => {

	suite('valid transitions', () => {

		test('happy path: idle→queued→running→success', () => {
			const m = new NodeStateMachine();
			m.transition('queued');
			m.transition('running');
			m.setProgress(50);
			assert.strictEqual(m.progress, 50);
			m.transition('success');
			assert.strictEqual(m.state, 'success');
			assert.strictEqual(m.progress, 100);
		});

		test('idle→running shortcut allowed', () => {
			const m = new NodeStateMachine();
			m.transition('running');
			assert.strictEqual(m.state, 'running');
		});

		test('error captures message', () => {
			const m = new NodeStateMachine();
			m.transition('running');
			m.transition('error', { error: '429 quota' });
			assert.strictEqual(m.state, 'error');
			assert.strictEqual(m.error, '429 quota');
		});

		test('canceled from queued or running', () => {
			const m1 = new NodeStateMachine();
			m1.transition('queued');
			m1.transition('canceled');
			assert.strictEqual(m1.state, 'canceled');

			const m2 = new NodeStateMachine();
			m2.transition('running');
			m2.transition('canceled');
			assert.strictEqual(m2.state, 'canceled');
		});

		test('blocked records blockedBy', () => {
			const m = new NodeStateMachine();
			m.transition('running');
			m.transition('blocked', { blockedBy: 'n-ks' });
			assert.strictEqual(m.state, 'blocked');
			assert.strictEqual(m.blockedBy, 'n-ks');
		});
	});

	suite('invalid transitions', () => {

		test('success cannot transition further', () => {
			const m = new NodeStateMachine();
			m.transition('queued');
			m.transition('running');
			m.transition('success');
			assert.throws(() => m.transition('running'), InvalidTransitionError);
		});

		test('running→queued illegal', () => {
			const m = new NodeStateMachine();
			m.transition('running');
			assert.throws(() => m.transition('queued'), InvalidTransitionError);
		});

		test('blocked cannot become running', () => {
			const m = new NodeStateMachine();
			m.transition('blocked');
			assert.throws(() => m.transition('running'), InvalidTransitionError);
		});

		test('setProgress outside running throws', () => {
			const m = new NodeStateMachine();
			assert.throws(() => m.setProgress(50), InvalidTransitionError);
		});
	});

	suite('progress clamping', () => {

		test('clamps to 0..100 and rounds', () => {
			const m = new NodeStateMachine();
			m.transition('running');
			m.setProgress(-5);
			assert.strictEqual(m.progress, 0);
			m.setProgress(150);
			assert.strictEqual(m.progress, 100);
			m.setProgress(33.4);
			assert.strictEqual(m.progress, 33);
		});
	});

	suite('downstreamOf (BFS)', () => {

		const adjacency = new Map([
			['a', ['b', 'c']],
			['b', ['d']],
			['c', ['d']],
			['d', []],
			['e', []],
		]);

		test('collects all reachable nodes', () => {
			const result = downstreamOf('a', adjacency).sort();
			assert.deepStrictEqual(result, ['b', 'c', 'd']);
		});

		test('leaf failure blocks nothing', () => {
			assert.deepStrictEqual(downstreamOf('d', adjacency), []);
		});

		test('unknown node returns empty', () => {
			assert.deepStrictEqual(downstreamOf('zz', adjacency), []);
		});

		test('diamond dependencies deduplicated', () => {
			const result = downstreamOf('a', adjacency);
			assert.strictEqual(new Set(result).size, result.length);
		});
	});

	suite('isStateOrderValid', () => {

		test('valid sequence passes', () => {
			assert.strictEqual(isStateOrderValid(['idle', 'queued', 'running', 'success']), true);
			assert.strictEqual(isStateOrderValid(['idle', 'running', 'error']), true);
			assert.strictEqual(isStateOrderValid(['idle', 'queued', 'canceled']), true);
		});

		test('invalid sequence fails', () => {
			assert.strictEqual(isStateOrderValid(['idle', 'success', 'running']), false);
			assert.strictEqual(isStateOrderValid(['idle', 'blocked', 'success']), false);
		});
	});

	suite('snapshot', () => {

		test('serializes current state', () => {
			const m = new NodeStateMachine();
			m.transition('running');
			m.setProgress(40);
			assert.deepStrictEqual(m.snapshot(), { state: 'running', progress: 40, error: undefined, blockedBy: undefined });
		});
	});
});
