/*---------------------------------------------------------------------------------------------
 *  Unit tests for taskStatus — pure cross-session task tracking model (P1).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { buildTaskStatus, formatTaskStatus, type TaskStatus } from '../../webview/src/features/workflowEditor/comfyHost/taskStatus.js';

function successResult() {
	return {
		success: true,
		hasCycle: false,
		ran: ['n1', 'n2'],
		failed: null,
		results: {
			n1: { promptId: '', status: 'success', durationMs: 100, entries: [] },
			n2: { promptId: '', status: 'success', durationMs: 200, entries: [] },
		},
		taskId: 't-1',
		mode: 'parallel',
	};
}

suite('buildTaskStatus', () => {

	test('successful result → success state with per-step status', () => {
		const s = buildTaskStatus('t-1', successResult(), { labels: { n1: '图像-1', n2: '图像-2' } });
		assert.strictEqual(s.state, 'success');
		assert.strictEqual(s.ran, 2);
		assert.strictEqual(s.total, 2);
		assert.strictEqual(s.failed, 0);
		assert.strictEqual(s.progress, 100);
		assert.strictEqual(s.steps.length, 2);
		assert.strictEqual(s.steps[0].label, '图像-1');
		assert.strictEqual(s.steps[0].runState, 'success');
		assert.ok(s.finishedAt, 'finished timestamp set on success');
	});

	test('failed result → error state with the failing step', () => {
		const result = {
			success: false, hasCycle: false, ran: ['n1'], failed: { nodeId: 'n2', error: 'boom' },
			results: { n1: { promptId: '', status: 'success', durationMs: 10, entries: [] } },
			taskId: 't-2',
		};
		const s = buildTaskStatus('t-2', result);
		assert.strictEqual(s.state, 'error');
		assert.strictEqual(s.error, 'boom');
		assert.strictEqual(s.steps.length, 2);
		const failed = s.steps.find(x => x.nodeId === 'n2');
		assert.strictEqual(failed?.runState, 'error');
		assert.strictEqual(failed?.errorMsg, 'boom');
	});

	test('isRunning → running state with progress < 100', () => {
		const s = buildTaskStatus('t-3', successResult(), { isRunning: true, createdAt: new Date().toISOString() });
		assert.strictEqual(s.state, 'running');
		assert.ok(s.progress < 100, 'running task is not at 100%');
		assert.ok(!s.finishedAt, 'running task has no finish time');
	});

	test('snapshotRefsFor maps node → snapshot refs', () => {
		const s = buildTaskStatus('t-4', successResult(), { snapshotRefsFor: id => [`snap:${id}:0`] });
		assert.deepStrictEqual(s.steps[0].snapshotRefs, ['snap:n1:0']);
	});

	test('cycle result → error state with zero steps', () => {
		const s = buildTaskStatus('t-5', { success: false, hasCycle: true, ran: [], failed: null, results: {}, taskId: 't-5' });
		assert.strictEqual(s.state, 'error');
		assert.strictEqual(s.steps.length, 0);
	});

	test('layerStats propagate from the run result', () => {
		const result = { ...successResult(), layerStats: [{ layer: 0, total: 2, ran: 2, failed: 0 }] };
		const s = buildTaskStatus('t-6', result);
		assert.deepStrictEqual(s.layerStats, [{ layer: 0, total: 2, ran: 2, failed: 0 }]);
	});
});

suite('formatTaskStatus', () => {

	test('formats a running task header', () => {
		const s: TaskStatus = {
			taskId: 't-1', state: 'running', createdAt: new Date().toISOString(),
			ran: 1, total: 3, failed: 0, steps: [], progress: 33,
		};
		const text = formatTaskStatus(s);
		assert.ok(text.includes('运行中'));
		assert.ok(text.includes('33%'));
	});

	test('lists steps with refs', () => {
		const s = buildTaskStatus('t-1', successResult(), { labels: { n1: '图像-1' }, snapshotRefsFor: id => [`snap:${id}:0`] });
		const text = formatTaskStatus(s);
		assert.ok(text.includes('✓ 图像-1'));
		assert.ok(text.includes('产物: snap:n1:0'));
	});
});
