/*---------------------------------------------------------------------------------------------
 *  Unit test: 直跑取消 —— 消除「聊天报失败、画布仍在跑」的僵尸（2026-09-11）
 *
 *  背景：host 侧 `PendingRegistry` 空闲超时后会放弃该直跑，但此前**无从通知画布** ——
 *  ComfyUI 白跑，且用户看到「聊天说失败、画布稍后却出图」的矛盾状态 ✗。
 *
 *  修法：host 超时 → `directStageRunCancelEmitter` → controller `_sendEvent`
 *  (`workflow.stageDirectRunCancel`) → webview `handleDirectStageRunCancel` → `abort()`
 *  → runner 把 signal 透传进 `runNodeOrStage`，执行层据此停止（animatedEmojiExecutor
 *  逐格检查 `input.signal?.aborted`、comfyRunner 轮询检查、emojiExecutor throwIfAborted）。
 *
 *  本测试锁定**最关键的接缝**：cancel 是否真的传到了执行器手里的 signal。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	registerDirectStageRunner,
	unregisterDirectStageRunner,
	handleDirectStageRunEvent,
	handleDirectStageRunCancel,
	DIRECT_STAGE_HEARTBEAT_MS,
} from '../../webview/src/features/workflowEditor/comfyHost/workflowSnapshotBridgeWebview.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

suite('直跑取消（僵尸运行消除）', () => {

	test('★ cancel 必须传到执行器的 signal（否则画布不会停）', async () => {
		let observedAbort = false;
		let sawSignal = false;
		registerDirectStageRunner('wf-cancel', async (_stageClass, _values, _images, _onProgress, _nodeId, _upstreams, _sid, signal) => {
			sawSignal = signal instanceof AbortSignal;
			// 模拟逐格生成：每 10ms 检查一次 signal（与 animatedEmojiExecutor 同款写法）
			for (let i = 0; i < 200; i++) {
				if (signal?.aborted) {
					observedAbort = true;
					throw new Error('AbortError: 已取消');
				}
				await sleep(10);
			}
			return { status: 'success', outputs: {} };
		});

		const run = handleDirectStageRunEvent({ runId: 'r-cancel', stageClass: 'ComfyTV.X', values: {} });
		await sleep(40);
		handleDirectStageRunCancel({ runId: 'r-cancel' });
		await run;   // 内部 catch 已消化取消错误 → 应立即返回

		assert.strictEqual(sawSignal, true, 'runner 应收到 AbortSignal');
		assert.strictEqual(observedAbort, true, 'cancel 后 runner 必须观察到 signal.aborted');
		unregisterDirectStageRunner('wf-cancel');
	});

	test('未取消 → 正常完成', async () => {
		registerDirectStageRunner('wf-ok', async () => {
			await sleep(10);
			return { status: 'success', outputs: { a: 1 } };
		});
		await handleDirectStageRunEvent({ runId: 'r-ok', stageClass: 'ComfyTV.Y', values: {} });
		unregisterDirectStageRunner('wf-ok');
	});

	test('未知 / 非法 runId 的 cancel 不抛异常（幂等、可重复调用）', () => {
		handleDirectStageRunCancel({ runId: 'never-existed' });
		handleDirectStageRunCancel({});
		handleDirectStageRunCancel(undefined);
		handleDirectStageRunCancel(null);
	});

	test('★ 心跳间隔必须远小于 host 空闲窗口（否则心跳形同虚设）', () => {
		// host 侧直跑空闲窗口 = comfyStageBridge 的 DIRECT_STAGE_TIMEOUT_MS = 720s。
		// 若有人把心跳调到接近窗口（如 5 分钟），一次网络抖动就会误判「画布已死」✗。
		const HOST_IDLE_WINDOW_MS = 720_000;
		assert.ok(
			DIRECT_STAGE_HEARTBEAT_MS * 10 <= HOST_IDLE_WINDOW_MS,
			`心跳 ${DIRECT_STAGE_HEARTBEAT_MS}ms 相对空闲窗口 ${HOST_IDLE_WINDOW_MS}ms 余量不足（应 ≥10×）`,
		);
	});

	test('★ 已结束的 run 再 cancel 不抛异常（结束后已从活跃表移除）', async () => {
		registerDirectStageRunner('wf-done', async () => ({ status: 'success', outputs: {} }));
		await handleDirectStageRunEvent({ runId: 'r-done', stageClass: 'ComfyTV.Z', values: {} });
		handleDirectStageRunCancel({ runId: 'r-done' });   // 不应抛
		unregisterDirectStageRunner('wf-done');
	});
});
