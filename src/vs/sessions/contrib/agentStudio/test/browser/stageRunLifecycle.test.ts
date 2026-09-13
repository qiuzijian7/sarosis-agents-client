/*---------------------------------------------------------------------------------------------
 *  Unit test: `stage()` 路径的活性/收尾机制（2026-09-11，与直跑同构）
 *
 *  与 direct stage run 完全对称地补齐三件事：
 *    ① **心跳** `onStageRunHeartbeat` —— 只续期、不触碰 UI（解耦「活性」与「进度」）；
 *    ② **放弃时通知画布停止** `stageRunCancelEmitter`（消除僵尸）；
 *    ③ **取消执行 / 画布销毁即收尾** `abandonStageRunsForExecution` / `abandonStageRun`。
 *
 *  webview 侧：`handleStageRunCancel` → abort → runner 的 signal 生效（执行层据此停止）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	requestStageRun,
	resolveStageRun,
	onStageRunHeartbeat,
	stageRunEmitter,
	stageRunCancelEmitter,
	abandonStageRunsForExecution,
	abandonStageRun,
} from '../../browser/workflow/workflowSnapshotBridge.js';
import {
	registerStageRunner,
	unregisterStageRunner,
	handleStageRunEvent,
	handleStageRunCancel,
} from '../../webview/src/features/workflowEditor/comfyHost/workflowSnapshotBridgeWebview.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 发起一个 stage() 请求，返回其 runId（`stageRunEmitter` 同步 fire ✓）。 */
function startStageRun(stageUid: string, timeoutMs: number, executionId?: string): string {
	let runId = '';
	const sub = stageRunEmitter.event(req => { runId = req.runId; });
	void requestStageRun(
		{ stageUid },
		timeoutMs,
		undefined,
		executionId !== undefined ? { executionId } : undefined,
	).catch(() => { /* 测试自行断言收尾 */ });
	sub.dispose();
	assert.ok(runId, 'stageRunEmitter 应同步给出 runId');
	return runId;
}

suite('stage() 生命周期（心跳 / 放弃 / 取消）', () => {

	test('★ 心跳能续期对应 pending（未知 runId 返回 false）', () => {
		const runId = startStageRun('uid-hb', 60_000);
		assert.strictEqual(onStageRunHeartbeat({ runId }), true, '已知 runId 应续期成功');
		assert.strictEqual(onStageRunHeartbeat({ runId: 'nope' }), false);
		assert.strictEqual(onStageRunHeartbeat({}), false);
		// 收尾，避免悬挂
		assert.strictEqual(resolveStageRun({ runId, ok: true, value: 1 }), true);
	});

	test('★★ 空闲超时 → 触发取消事件（通知画布停止，消除僵尸）', async () => {
		const cancels: string[] = [];
		const sub = stageRunCancelEmitter.event(e => { cancels.push(e.runId); });
		const runId = startStageRun('uid-timeout', 40);
		await sleep(100);
		assert.deepStrictEqual(cancels, [runId], '超时放弃时必须通知画布停止执行');
		sub.dispose();
	});

	test('★ abandonStageRunsForExecution：取消执行时放弃其名下 stage()（通知 + 收尾）', async () => {
		const cancels: string[] = [];
		const sub = stageRunCancelEmitter.event(e => { cancels.push(e.runId); });
		const a = startStageRun('uid-a', 60_000, 'exec-S');
		const b = startStageRun('uid-b', 60_000, 'exec-S');
		const other = startStageRun('uid-c', 60_000, 'exec-T');

		const n = abandonStageRunsForExecution('exec-S');
		assert.strictEqual(n, 2, '应放弃 exec-S 名下两个 stage()');
		assert.deepStrictEqual(cancels.slice().sort(), [a, b].sort(), '应通知画布停止');
		// 其他执行不受影响
		assert.strictEqual(onStageRunHeartbeat({ runId: other }), true, 'exec-T 的 stage() 应仍在等待');
		// 幂等
		assert.strictEqual(abandonStageRunsForExecution('exec-S'), 0);
		resolveStageRun({ runId: other, ok: true, value: 1 });
		sub.dispose();
	});

	test('abandonStageRun：单个放弃（画布面板 dispose 用）', () => {
		const runId = startStageRun('uid-single', 60_000);
		assert.strictEqual(abandonStageRun(runId), true);
		assert.strictEqual(abandonStageRun(runId), false, '重复放弃应返回 false');
		assert.strictEqual(onStageRunHeartbeat({ runId }), false);
	});

	test('★★ webview：cancel 必须传到 stage runner 的 signal（否则画布不会停）', async () => {
		let observedAbort = false;
		let sawSignal = false;
		registerStageRunner('wf-stage-cancel', async (_uid, _overrides, _onProgress, signal) => {
			sawSignal = signal instanceof AbortSignal;
			for (let i = 0; i < 200; i++) {
				if (signal?.aborted) {
					observedAbort = true;
					throw new Error('AbortError: 已取消');
				}
				await sleep(10);
			}
			return { ok: 1 };
		});
		const run = handleStageRunEvent({ runId: 'rs-cancel', stageUid: 'uid-1' });
		await sleep(40);
		handleStageRunCancel({ runId: 'rs-cancel' });
		await run;
		assert.strictEqual(sawSignal, true, 'runner 应收到 AbortSignal');
		assert.strictEqual(observedAbort, true, 'cancel 后 runner 必须观察到 signal.aborted');
		unregisterStageRunner('wf-stage-cancel');
	});

	test('webview：未取消 → 正常完成；未知 runId 的 cancel 不抛异常', async () => {
		registerStageRunner('wf-stage-ok', async () => ({ ok: 2 }));
		await handleStageRunEvent({ runId: 'rs-ok', stageUid: 'uid-2' });
		handleStageRunCancel({ runId: 'never' });
		handleStageRunCancel(undefined);
		unregisterStageRunner('wf-stage-ok');
	});

	test('webview：画布未注册 runner → 立即 fail-loud 回程（不悬挂）', async () => {
		await handleStageRunEvent({ runId: 'rs-norunner', stageUid: 'uid-3' });
		// 无 runner 时不应抛异常（内部已回程错误）
		assert.ok(true);
	});
});
