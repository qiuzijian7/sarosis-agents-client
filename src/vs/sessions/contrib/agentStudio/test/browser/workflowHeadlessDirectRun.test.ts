/*---------------------------------------------------------------------------------------------
 *  Unit tests for headless direct stage run —— 无画布判定 + unhandled 队列 + 就绪重放。
 *
 *  被测机制（browser/workflow/workflowSnapshotBridge.ts）：
 *    Emitter.fire 是**同步**分发 ⇒ fire 前复位 flag、controller listener 内
 *    markDirectStageRunHandled() ack；fire 返回后 flag 仍为 false ⇒ 没有任何画布
 *    controller 在听 ⇒ 请求入 unhandled 队列 + fire unhandled 事件（pending 不 reject，
 *    90s 兜底仍在），随后 notifyDirectStageRunControllerReady() 重放。
 *
 *  这些断言锁定的是"曾经出错的地方"：
 *   - 无 listener 时必须**不**静默丢失（旧行为：干等 90s 超时）；
 *   - workflowId 必须透传到 unhandled 事件（否则自动开画布只能开"最近一个"）；
 *   - 重放必须能被新 listener 接手且队列清空（不重复重放）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	requestDirectStageRun,
	directStageRunEmitter,
	directStageRunUnhandledEmitter,
	markDirectStageRunHandled,
	notifyDirectStageRunControllerReady,
	resolveDirectStageRun,
	type DirectStageRunPayload,
	type DirectStageRunUnhandledEvent,
} from '../../browser/workflow/workflowSnapshotBridge.js';

suite('headless directStageRun', () => {

	test('★ 有 controller 接手（同步 ack）→ 不产生 unhandled 事件', async () => {
		const seenUnhandled: DirectStageRunUnhandledEvent[] = [];
		const subU = directStageRunUnhandledEmitter.event(e => seenUnhandled.push(e));
		let payload: DirectStageRunPayload | undefined;
		const subR = directStageRunEmitter.event(req => {
			markDirectStageRunHandled();   // controller 的同步 ack
			payload = req;
		});
		try {
			const p = requestDirectStageRun({ stageClass: 'ComfyTV.EmojiStage', values: { prompt: 'cat' } }, 5_000);
			assert.ok(payload, 'listener 应同步收到请求');
			assert.strictEqual(seenUnhandled.length, 0, '已 ack 不应进 unhandled 队列');
			// 回程解 pending，避免测试悬挂
			assert.strictEqual(resolveDirectStageRun({ runId: payload!.runId, ok: true, value: 'done' }), true);
			assert.strictEqual(await p, 'done');
		} finally {
			subU.dispose();
			subR.dispose();
		}
	});

	test('★ 无 controller（无 ack）→ fire unhandled 事件，且 pending 不立即 reject', async () => {
		const seen: DirectStageRunUnhandledEvent[] = [];
		const subU = directStageRunUnhandledEmitter.event(e => seen.push(e));
		try {
			const p = requestDirectStageRun({ stageClass: 'ComfyTV.EmojiStage', values: {}, workflowId: 'wf-42' }, 5_000);
			assert.strictEqual(seen.length, 1, '无 ack 必须 fire unhandled（否则静默等超时）');
			assert.strictEqual(seen[0].request.stageClass, 'ComfyTV.EmojiStage');
			// ★ workflowId 透传：自动开画布要据此打开**正确**的工作流
			assert.strictEqual(seen[0].request.workflowId, 'wf-42');
			// pending 未 reject：仍可被后续重放解决
			let settled = false;
			void p.then(() => { settled = true; }, () => { settled = true; });
			await Promise.resolve();
			assert.strictEqual(settled, false, 'unhandled 不得立即 reject（等自动开画布重放）');

			// 模拟画布就绪 → 重放 → 新 listener 接手并回程
			let replayed: DirectStageRunPayload | undefined;
			const subR = directStageRunEmitter.event(req => { markDirectStageRunHandled(); replayed = req; });
			const n = notifyDirectStageRunControllerReady();
			assert.strictEqual(n, 1, '应重放 1 条挂起请求');
			assert.ok(replayed, '重放的请求应被新 listener 接手');
			assert.strictEqual(replayed!.runId, seen[0].runId, 'runId 必须保持一致（否则回程解不开 pending）');
			resolveDirectStageRun({ runId: replayed!.runId, ok: true, value: 'ok-after-replay' });
			assert.strictEqual(await p, 'ok-after-replay');
			subR.dispose();
		} finally {
			subU.dispose();
		}
	});

	test('重放后队列清空：再次 notifyReady 返回 0（不重复执行）', () => {
		// 前一个用例已消费完队列；此处直接验证空队列语义。
		assert.strictEqual(notifyDirectStageRunControllerReady(), 0);
	});

	test('resolveDirectStageRun 对未知 runId 返回 false（已超时/已解决）', () => {
		assert.strictEqual(resolveDirectStageRun({ runId: 'nope', ok: true, value: 1 }), false);
	});

	test('images 与 workflowId 均为可选（缺省不出现在 payload 中）', () => {
		const seen: DirectStageRunUnhandledEvent[] = [];
		const subU = directStageRunUnhandledEmitter.event(e => seen.push(e));
		try {
			void requestDirectStageRun({ stageClass: 'X', values: {} }, 1_000).catch(() => { /* 让其自然超时 */ });
			assert.strictEqual(seen.length, 1);
			assert.strictEqual('images' in seen[0].request, false);
			assert.strictEqual('workflowId' in seen[0].request, false);
		} finally {
			subU.dispose();
			notifyDirectStageRunControllerReady(); // 清队列，避免污染后续用例
		}
	});
});
