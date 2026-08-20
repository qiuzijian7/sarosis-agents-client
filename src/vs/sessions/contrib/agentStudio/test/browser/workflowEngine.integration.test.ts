/*---------------------------------------------------------------------------------------------
 *  WF-E(host) — 引擎 host 侧状态机（MockWorker 驱动，不跑真脚本）。
 *  覆盖实施计划 §2.4 E3 的 host 半边：账本恰好配对、grace 强收、dispose 幂等、
 *  cancel 竞速裁决、admission refusal。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	WorkflowEngine, type IWorkflowChildHandle, type IWorkflowChildPort,
	type IWorkflowWorkerLike, type WorkflowWorkerFactory,
} from '../../browser/workflow/workflowEngine.js';
import type { IWorkflowChildStartRequest } from '../../common/workflow/protocol.js';
import type { WorkflowEngineEvent } from '../../common/workflow/types.js';

/** MockWorker：测试以 worker 身份回放消息序列；记录 host 发来的消息。 */
class MockWorker implements IWorkflowWorkerLike {
	readonly posted: Array<Record<string, unknown>> = [];
	terminated = 0;
	onmessage: (ev: { data: unknown }) => void = () => { };
	onerror: (err: unknown) => void = () => { };
	postMessage(m: unknown): void { this.posted.push(m as Record<string, unknown>); }
	terminate(): void { this.terminated++; }
	/** worker → host */
	receive(m: unknown): void { this.onmessage({ data: m }); }
}

class EngineHarness {
readonly worker = new MockWorker();
readonly engine: WorkflowEngine;
readonly events: WorkflowEngineEvent[] = [];
readonly childStarts: IWorkflowChildStartRequest[] = [];
/** 竞速用例的 run 挂点。 */
run?: { cancel(reason?: string): void; result: Promise<{ stopReason: string; error?: string }> };
	private _childSeq = 0;
	/** 可编程 child 终态。 */
	childSettle: (req: IWorkflowChildStartRequest, childId: string) => Promise<{ success: boolean; output?: string; structured?: unknown; stopReason?: string }> =
		async () => ({ success: true, output: 'ok', stopReason: 'completed' });

	readonly childPort: IWorkflowChildPort = {
		start: async (request, _signal) => {
			this.childStarts.push(request);
			const childId = `child-${++this._childSeq}`;
			const handle: IWorkflowChildHandle = {
				id: childId,
				result: this.childSettle(request, childId),
				dispose: async () => { /* mock：dispose 即完成 */ },
			};
			return handle;
		},
	};
	/** M2 快照查询记录（断言用）。 */
	readonly snapshotQueries: Array<{ stageUid: string; slot?: number }> = [];
	/** 可编程 snapshotPort.get。 */
	snapshotResolve: (q: { stageUid: string; slot?: number }) => Promise<unknown> = async () => null;
	/** P0 stage 执行记录（断言用）。 */
	readonly stageRequests: Array<{ stageUid: string; overrides?: Record<string, unknown> }> = [];
	/** 可编程 stagePort.run。 */
	stageResolve: (r: { stageUid: string; overrides?: Record<string, unknown> }) => Promise<unknown> = async () => null;

	constructor(graceMs = 60, opts?: { withSnapshotPort?: boolean; withStagePort?: boolean }) {
		const factory: WorkflowWorkerFactory = () => this.worker;
		this.engine = new WorkflowEngine(
			{
				childPort: this.childPort,
				...(opts?.withSnapshotPort === false ? {} : { snapshotPort: { get: async q => { this.snapshotQueries.push(q); return this.snapshotResolve(q); } } }),
				...(opts?.withStagePort === false ? {} : { stagePort: { run: async r => { this.stageRequests.push(r); return this.stageResolve(r); } } }),
				disposeGraceMs: graceMs,
				workerFactory: factory,
			},
			() => { /* 静默日志 */ },
		);
	}

	start(body = 'return 1'): void {
		this.engine.start({
			script: body,
			meta: { name: 'test-run', description: 'd' },
			args: {},
			onEvent: ev => this.events.push(ev),
		});
		// 模拟 worker 启动握手
		this.worker.receive({ type: 'ready' });
	}

	/** host → worker 的 go 消息（ready 后引擎发出）。 */
	goMessage(): Record<string, unknown> | undefined {
		return this.worker.posted.find(m => m['type'] === 'go');
	}

	async settle(ms = 300): Promise<void> { await new Promise(r => setTimeout(r, ms)); }
}

suite('workflow engine (host) — 状态机', () => {

	test('E3.0 握手：ready → 引擎回 go（携带 init）', () => {
		const h = new EngineHarness();
		h.start('return 1');
		const go = h.goMessage();
		assert.ok(go, '引擎必须在 ready 后发 go');
		assert.strictEqual((go['init'] as { meta: { name: string } }).meta.name, 'test-run');
		assert.strictEqual(typeof (go['init'] as { body: string }).body, 'string');
	});

	test('E3.6 账本恰好配对：worker 死亡时合成缺失 agent-end', async () => {
		const h = new EngineHarness();
		h.start("await agent('a')");
		await h.settle(20);
		// worker 报 agent-start ×3，然后崩溃（无 agent-end）
		h.worker.receive({ type: 'agent-start', info: { seq: 1, label: 'a', childId: 'c1' } });
		h.worker.receive({ type: 'agent-start', info: { seq: 2, label: 'b', childId: 'c2' } });
		h.worker.onerror(new Error('boom'));
		const result = await Promise.race([
			(async () => { for (let i = 0; i < 40; i++) { await h.settle(10); const ev = h.events.find(e => e.type === 'end'); if (ev) { return ev; } } return undefined; })(),
		]);
		assert.ok(result, 'run 必须 settle');
		assert.strictEqual(result.type === 'end' ? result.stopReason : '', 'error');
		// 恰好配对：2 个 start → 2 个合成 end（cancelled），且都在 end 事件之前
		const seq = h.events.map(e => e.type);
		const starts = h.events.filter(e => e.type === 'agent-start');
		const ends = h.events.filter(e => e.type === 'agent-end');
		assert.strictEqual(starts.length, 2);
		assert.strictEqual(ends.length, 2, '每个 start 恰好一个合成 end');
		for (const e of ends) { assert.strictEqual(e.type === 'agent-end' ? e.info.outcome : '', 'cancelled'); }
		assert.ok(seq.lastIndexOf('agent-end') < seq.lastIndexOf('end'), 'end 之前全部闭合');
	});

	test('E3.4 grace 强收：worker 永不回 result → cancel 后 grace 内 settled + terminate', async () => {
		const h = new EngineHarness(50);
		h.start('while(true){}');
		await h.settle(10);
		const handle = h.engine.start({ script: 'x', meta: { name: 'r2', description: 'd' } });
		void handle;
		// 用第一个 run：cancel
		const h2 = new EngineHarness(50);
		h2.start('parked');
		await h2.settle(10);
		const run = h2.engine.start({ script: 'parked2', meta: { name: 'r3', description: 'd' } });
		// 直接测引擎返回的 handle：cancel 后 grace（50ms）内 settle
		const t0 = Date.now();
		run.cancel('user stop');
		const r = await run.result;
		const elapsed = Date.now() - t0;
		assert.strictEqual(r.stopReason, 'cancelled');
		assert.ok(elapsed < 500, `grace 内收敛（${elapsed}ms）`);
		assert.ok(r.error?.includes('user stop'));
	});

	test('E3.7 dispose 幂等：连续 dispose 不重复 terminate', async () => {
		const h = new EngineHarness(40);
		const run = h.engine.start({ script: 'return 1', meta: { name: 'd', description: 'x' } });
		h.worker.receive({ type: 'ready' });
		h.worker.receive({ type: 'result', result: { value: 1, stopReason: 'completed', agentsStarted: 0 } });
		const r = await run.result;
		assert.strictEqual(r.stopReason, 'completed');
		const d1 = run.dispose();
		const d2 = run.dispose();
		const d3 = run.dispose();
		await Promise.all([d1, d2, d3]);
		assert.strictEqual(h.worker.terminated, 1, 'terminate 恰好一次');
	});

	test('E3.8 取消与结果竞速：cancel 先到 → 报 cancelled（不谎报 completed）', async () => {
		for (let i = 0; i < 10; i++) {
			const h = new EngineHarness(10_000);
			h.start('return 1');
			h.run = h.engine.start({ script: 'r', meta: { name: 'race', description: 'd' } });
			const run = h.run;
			h.worker.receive({ type: 'ready' });
			// cancel 与 result 几乎同时
			run.cancel('race');
			h.worker.receive({ type: 'result', result: { value: 1, stopReason: 'completed', agentsStarted: 0 } });
			const r = await run.result;
			assert.strictEqual(r.stopReason, 'cancelled', `iteration ${i}: cancel 先到必须报 cancelled`);
		}
	});

	test('E3.1 admission refusal：cancel 后 worker 的 child-start 被拒（child-start-error 回 worker）', async () => {
		const h = new EngineHarness(10_000);
		const run = h.engine.start({ script: 'r', meta: { name: 'adm', description: 'd' } });
		h.worker.receive({ type: 'ready' });
		run.cancel('stop');
		h.worker.receive({ type: 'child-start', callId: 7, request: { prompt: 'x' } });
		await h.settle(20);
		const refusal = h.worker.posted.find(m => m['type'] === 'child-start-error' && m['callId'] === 7);
		assert.ok(refusal, '已取消的 run 拒绝新 child 并回 child-start-error');
		assert.match(String(refusal?.['rendered']), /cancelled/);
		assert.strictEqual(h.childStarts.length, 0, 'childPort.start 不得被调');
	});

	test('E3.b child 全链路：child-start → started → settled → 结果回 worker', async () => {
		const h = new EngineHarness();
		h.start("return agent('hi')");
		h.childSettle = async () => ({ success: true, output: 'done', stopReason: 'completed' });
		// 模拟 worker 请求 child
		h.worker.receive({ type: 'child-start', callId: 1, request: { prompt: 'hi' } });
		await h.settle(30);
		// host 应回 child-started
		const started = h.worker.posted.find(m => m['type'] === 'child-started' && m['callId'] === 1);
		assert.ok(started, 'child 启动后回 child-started');
		// 模拟 child 结果 → host 转 child-settled 给 worker
		await h.settle(30);
		const settled = h.worker.posted.find(m => m['type'] === 'child-settled' && m['callId'] === 1);
		assert.ok(settled, 'child 终态转发 child-settled');
		assert.strictEqual((settled?.['result'] as { output: string }).output, 'done');
	});

	test('C2.e1 nodeOutput 成功：snapshotPort.get 被调 → node-output-result 回 worker', async () => {
		const h = new EngineHarness();
		h.snapshotResolve = async q => ({ kind: 'media', url: `u:${q.stageUid}:${q.slot}` });
		h.start("return nodeOutput('uid-x', 0)");
		h.worker.receive({ type: 'node-output', callId: 3, query: { stageUid: 'uid-x', slot: 0 } });
		await h.settle(30);
		const res = h.worker.posted.find(m => m['type'] === 'node-output-result' && m['callId'] === 3);
		assert.ok(res, '查询成功回 node-output-result');
		assert.deepStrictEqual((res?.['result'] as { value: unknown }).value, { kind: 'media', url: 'u:uid-x:0' });
		assert.deepStrictEqual(h.snapshotQueries, [{ stageUid: 'uid-x', slot: 0 }]);
	});

	test('C2.e2 nodeOutput 失败：回 node-output-error（fail-loud，不静默）', async () => {
		const h = new EngineHarness();
		h.snapshotResolve = async q => { throw new Error(`no snapshot for stageUid "${q.stageUid}"`); };
		h.start("return nodeOutput('gone')");
		h.worker.receive({ type: 'node-output', callId: 4, query: { stageUid: 'gone' } });
		await h.settle(30);
		const err = h.worker.posted.find(m => m['type'] === 'node-output-error' && m['callId'] === 4);
		assert.ok(err, '查询失败回 node-output-error');
		assert.match(String(err?.['rendered']), /no snapshot/);
	});

	test('C2.e3 缺省 snapshotPort = fail-loud（无画布上下文时 nodeOutput 明确报错）', async () => {
		const h = new EngineHarness(60, { withSnapshotPort: false });
		h.start("return nodeOutput('any')");
		h.worker.receive({ type: 'node-output', callId: 5, query: { stageUid: 'any' } });
		await h.settle(30);
		const err = h.worker.posted.find(m => m['type'] === 'node-output-error' && m['callId'] === 5);
		assert.ok(err, '缺省 port 也必须显式拒绝');
		assert.match(String(err?.['rendered']), /unavailable/);
	});

	test('C3.e1 stage 成功：stagePort.run 被调（含 overrides）→ stage-run-result 回 worker', async () => {
		const h = new EngineHarness();
		h.stageResolve = async r => ({ kind: 'media', url: `gen:${r.stageUid}:${r.overrides?.['seed']}` });
		h.start("return stage('uid-s', { seed: 42 })");
		h.worker.receive({ type: 'stage-run', callId: 11, request: { stageUid: 'uid-s', overrides: { seed: 42 } } });
		await h.settle(30);
		const res = h.worker.posted.find(m => m['type'] === 'stage-run-result' && m['callId'] === 11);
		assert.ok(res, '执行成功回 stage-run-result');
		assert.deepStrictEqual((res?.['result'] as { value: unknown }).value, { kind: 'media', url: 'gen:uid-s:42' });
		assert.deepStrictEqual(h.stageRequests, [{ stageUid: 'uid-s', overrides: { seed: 42 } }]);
	});

	test('C3.e2 stage 失败：回 stage-run-error（fail-loud，绝不静默 null）', async () => {
		const h = new EngineHarness();
		h.stageResolve = async r => { throw new Error(`canvas run failed for "${r.stageUid}"`); };
		h.start("return stage('gone')");
		h.worker.receive({ type: 'stage-run', callId: 12, request: { stageUid: 'gone' } });
		await h.settle(30);
		const err = h.worker.posted.find(m => m['type'] === 'stage-run-error' && m['callId'] === 12);
		assert.ok(err, '执行失败回 stage-run-error');
		assert.match(String(err?.['rendered']), /canvas run failed/);
	});

	test('C3.e3 缺省 stagePort = fail-loud（无画布上下文时 stage() 明确报错）', async () => {
		const h = new EngineHarness(60, { withStagePort: false });
		h.start("return stage('any')");
		h.worker.receive({ type: 'stage-run', callId: 13, request: { stageUid: 'any' } });
		await h.settle(30);
		const err = h.worker.posted.find(m => m['type'] === 'stage-run-error' && m['callId'] === 13);
		assert.ok(err, '缺省 port 也必须显式拒绝');
		assert.match(String(err?.['rendered']), /unavailable/);
	});

	test('C3.e4 cancel 后 stage 请求被拒（admission refusal，不触发画布执行）', async () => {
		const h = new EngineHarness(10_000);
		const run = h.engine.start({ script: 'r', meta: { name: 'adm-stage', description: 'd' } });
		h.worker.receive({ type: 'ready' });
		run.cancel('stop');
		h.worker.receive({ type: 'stage-run', callId: 14, request: { stageUid: 'uid' } });
		await h.settle(20);
		const refusal = h.worker.posted.find(m => m['type'] === 'stage-run-error' && m['callId'] === 14);
		assert.ok(refusal, '已取消的 run 必须拒绝 stage 请求');
		assert.match(String(refusal?.['rendered']), /cancelled/);
		assert.strictEqual(h.stageRequests.length, 0, 'stagePort.run 不得被调（不能白跑一次 ComfyUI）');
	});
});

// （EngineHarness.run 为公开字段，见类定义）
