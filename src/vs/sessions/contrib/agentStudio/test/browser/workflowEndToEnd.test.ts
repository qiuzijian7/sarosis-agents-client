/*---------------------------------------------------------------------------------------------
 *  WF-E2E — 真实 host 引擎 ⇄ 真实 worker 源码 端到端。
 *
 *  为什么需要这一层（P2 消除测试盲区）：
 *   - workflowEngine.integration.test.ts 用 **MockWorker**：测的是 host 状态机，
 *     worker 的真实消息形状全靠测试手写（写错也测不出）。
 *   - workflowWorker.test.ts 在 node:vm 里跑 **真实 WORKER_SOURCE**，但 host 半边
 *     由测试 driver 手写模拟（引擎真实分支同样测不到）。
 *   → 两侧各自都"通过"，而**协议契约**（字段名、握手时序、限额透传、错误分级、
 *     账本配对、cancel 贯穿、stage/nodeOutput 往返）从未被真实拼接验证过。
 *
 *  本文件把 vm 沙箱包装成 IWorkflowWorkerLike 注入 engine.workerFactory：
 *   engine（真实）→ postMessage → WORKER_SOURCE（真实）→ postMessage → engine
 *  消息过线做 JSON 深拷贝（等价 structured clone，顺带强制协议必须 JSON-clonable），
 *  并**异步投递**（真实 Worker 的宏任务边界语义；同时避免 ready 早于 onmessage 挂载丢失）。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import vm from 'node:vm';
import {
	DEFAULT_MAX_RUN_DURATION_MS,
	WorkflowEngine, type IWorkflowChildHandle, type IWorkflowChildPort,
	type IWorkflowWorkerLike, type WorkflowWorkerFactory,
} from '../../browser/workflow/workflowEngine.js';
import { WORKER_SOURCE } from '../../browser/workflow/workflowWorkerMain.source.js';
import type { IWorkflowChildStartRequest } from '../../common/workflow/protocol.js';
import type { IWorkflowStageRunRequest } from '../../common/workflow/protocol.js';
import type { IWorkflowLimits, WorkflowEngineEvent } from '../../common/workflow/types.js';

/** 过线拷贝：等价 structured clone 的 JSON 子集（协议全为 plain JSON）。 */
function wire<T>(m: T): T { return JSON.parse(JSON.stringify(m)) as T; }

/**
 * 真实 WORKER_SOURCE 跑在 node:vm 里，对外表现为 IWorkflowWorkerLike。
 * 沙箱只提供 self / console / timers —— 与真实 Web Worker 的**下限**一致
 * （无 Blob/URL → worker 走 new Function 编译路径；无 fetch/XHR → 环境遮蔽生效）。
 */
class VmWorker implements IWorkflowWorkerLike {
	terminated = 0;
	/** host 侧收到的 worker 消息（断言用）。 */
	readonly fromWorker: Array<Record<string, unknown>> = [];
	/** worker 侧收到的 host 消息（断言用）。 */
	readonly toWorker: Array<Record<string, unknown>> = [];

	private _hostOnMessage: ((ev: { data: unknown }) => void) | undefined;
	private _workerOnMessage: ((ev: { data: unknown }) => void) | undefined;
	private readonly _inbox: unknown[] = [];

	onerror: (err: unknown) => void = () => { };

	get onmessage(): (ev: { data: unknown }) => void {
		return this._hostOnMessage ?? (() => { });
	}
	set onmessage(h: (ev: { data: unknown }) => void) {
		this._hostOnMessage = h;
		// 挂载前已抵达的消息（如 worker 启动即发的 ready）不能丢。
		for (const m of this._inbox.splice(0)) { this._deliverToHost(m); }
	}

	constructor(source: string) {
		const selfObj: Record<string, unknown> = {};
		Object.defineProperty(selfObj, 'postMessage', {
			value: (m: unknown) => {
				if (this.terminated > 0) { return; }
				const copy = wire(m);
				this.fromWorker.push(copy as Record<string, unknown>);
				if (this._hostOnMessage) { this._deliverToHost(copy); } else { this._inbox.push(copy); }
			},
		});
		Object.defineProperty(selfObj, 'onmessage', {
			get: () => this._workerOnMessage,
			set: (h: ((ev: { data: unknown }) => void) | undefined) => { this._workerOnMessage = h; },
		});
		const ctx = vm.createContext({ self: selfObj, console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask });
		try {
			vm.runInContext(source, ctx, { filename: 'workflow-worker.js' });
		} catch (e) {
			setTimeout(() => this.onerror(e), 0);
		}
	}

	/** host → worker（异步跨宏任务，模拟真实 worker 线程边界）。 */
	postMessage(m: unknown): void {
		if (this.terminated > 0) { return; }
		const copy = wire(m);
		this.toWorker.push(copy as Record<string, unknown>);
		setTimeout(() => {
			if (this.terminated > 0) { return; }
			try { this._workerOnMessage?.({ data: copy }); } catch (e) { this.onerror(e); }
		}, 0);
	}

	terminate(): void { this.terminated++; }

	private _deliverToHost(m: unknown): void {
		setTimeout(() => {
			if (this.terminated > 0) { return; }
			this._hostOnMessage?.({ data: m });
		}, 0);
	}
}

interface HarnessOpts {
	readonly limits?: Partial<IWorkflowLimits>;
	readonly disposeGraceMs?: number;
	readonly maxRunDurationMs?: number;
	/** child 终态（缺省成功）。 */
	readonly childSettle?: (req: IWorkflowChildStartRequest) => { success: boolean; output?: string; structured?: unknown; stopReason?: string };
	/** child 启动失败（返回错误信息）。 */
	readonly childStartFails?: string;
	readonly snapshot?: (q: { stageUid: string; slot?: number }) => unknown;
	readonly stage?: (r: IWorkflowStageRunRequest) => unknown;
}

class E2EHarness {
	worker!: VmWorker;
	readonly engine: WorkflowEngine;
	readonly events: WorkflowEngineEvent[] = [];
	readonly childStarts: IWorkflowChildStartRequest[] = [];
	readonly stageRuns: IWorkflowStageRunRequest[] = [];
	readonly snapshotQueries: Array<{ stageUid: string; slot?: number }> = [];
	private _childSeq = 0;

	constructor(private readonly _opts: HarnessOpts = {}) {
		const childPort: IWorkflowChildPort = {
			start: async request => {
				if (_opts.childStartFails) { throw new Error(_opts.childStartFails); }
				this.childStarts.push(request);
				const settle = _opts.childSettle?.(request) ?? { success: true, output: 'ok', stopReason: 'completed' };
				const handle: IWorkflowChildHandle = {
					id: `child-${++this._childSeq}`,
					// 真实 dispatch 是异步的 —— 保留一个宏任务延迟，逼出 host/worker 的时序 bug。
					result: new Promise(resolve => setTimeout(() => resolve({
						success: settle.success,
						...(settle.output !== undefined ? { output: settle.output } : {}),
						...(settle.structured !== undefined ? { structured: settle.structured } : {}),
						stopReason: settle.stopReason ?? (settle.success ? 'completed' : 'failed'),
					}), 5)),
					dispose: async () => { /* noop */ },
				};
				return handle;
			},
		};
		const factory: WorkflowWorkerFactory = source => { this.worker = new VmWorker(source); return this.worker; };
		this.engine = new WorkflowEngine(
			{
				childPort,
				snapshotPort: { get: async q => { this.snapshotQueries.push(q); return _opts.snapshot?.(q) ?? null; } },
				stagePort: {
					run: async r => {
						this.stageRuns.push(r);
						const v = _opts.stage?.(r);
						if (v !== undefined && typeof v === 'object' && v !== null && 'fail' in v) { throw new Error(String((v as { fail: string }).fail)); }
						return v ?? null;
					},
				},
				...(_opts.limits ? { limits: { maxConcurrentAgents: 5, maxTotalAgents: 1000, maxItemsPerCall: 1000, ..._opts.limits } } : {}),
				disposeGraceMs: _opts.disposeGraceMs ?? 200,
				maxRunDurationMs: _opts.maxRunDurationMs ?? 10_000,
				workerFactory: factory,
			},
			() => { /* 静默日志 */ },
		);
	}

	run(script: string, args?: unknown) {
		return this.engine.start({
			script,
			meta: { name: 'e2e', description: 'end-to-end' },
			...(args !== undefined ? { args } : {}),
			onEvent: ev => this.events.push(ev),
		});
	}

	types(...kinds: WorkflowEngineEvent['type'][]): WorkflowEngineEvent[] {
		return this.events.filter(e => kinds.includes(e.type));
	}
}

suite('workflow E2E — 真实 engine ⇄ 真实 worker', () => {

	test('X1 最小 run：握手 → 脚本求值 → result 贯穿真实协议', async () => {
		const h = new E2EHarness();
		const run = h.run('return 1 + 1');
		const r = await run.result;
		assert.strictEqual(r.stopReason, 'completed');
		assert.strictEqual(r.value, 2);
		// 真实握手：worker 先 ready，host 才发 go（携带 init）
		assert.strictEqual(h.worker.fromWorker[0]?.['type'], 'ready');
		const go = h.worker.toWorker.find(m => m['type'] === 'go');
		assert.ok(go, 'host 必须回 go');
		assert.strictEqual((go['init'] as { meta: { name: string } }).meta.name, 'e2e');
		assert.deepStrictEqual(h.types('start', 'end').map(e => e.type), ['start', 'end']);
	});

	test('X2 agent 全链路：worker agent() ⇄ host childPort，账本恰好配对', async () => {
		const h = new E2EHarness({ childSettle: req => ({ success: true, output: `echo:${req.prompt}` }) });
		const run = h.run("const v = await agent('hello', { label: 'L' }); return v");
		const r = await run.result;
		assert.strictEqual(r.value, 'echo:hello');
		assert.strictEqual(r.agentsStarted, 1);
		assert.deepStrictEqual(h.childStarts.map(c => c.prompt), ['hello']);
		const starts = h.types('agent-start');
		const ends = h.types('agent-end');
		assert.strictEqual(starts.length, 1);
		assert.strictEqual(ends.length, 1, 'agent-start 恰好一个 agent-end');
		assert.strictEqual(starts[0].type === 'agent-start' ? starts[0].info.label : '', 'L');
		assert.strictEqual(ends[0].type === 'agent-end' ? ends[0].info.outcome : '', 'completed');
		// end 事件必须在所有 agent-end 之后（宿主看到的闭合顺序）
		const seq = h.events.map(e => e.type);
		assert.ok(seq.lastIndexOf('agent-end') < seq.lastIndexOf('end'));
	});

	test('X2b schema agent → structured 值；失败 → null（run 仍 completed）', async () => {
		const schema = JSON.stringify({ type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] });
		const okH = new E2EHarness({ childSettle: () => ({ success: true, structured: { n: 5 } }) });
		const okR = await okH.run(`return await agent('p', { schema: ${schema} })`).result;
		assert.deepStrictEqual(okR.value, { n: 5 });
		const badH = new E2EHarness({ childSettle: () => ({ success: false, stopReason: 'failed' }) });
		const badR = await badH.run(`return await agent('p', { schema: ${schema} })`).result;
		assert.strictEqual(badR.value, null, '子代理失败 → 脚本见 null');
		assert.strictEqual(badR.stopReason, 'completed');
		assert.strictEqual(badH.types('agent-end')[0].type === 'agent-end' ? badH.types('agent-end')[0].info.outcome : '', 'failed');
	});

	test('X3 nodeOutput 往返：真实 snapshotPort → 脚本拿到物化值', async () => {
		const h = new E2EHarness({ snapshot: q => ({ kind: 'media', url: `u:${q.stageUid}:${q.slot}` }) });
		const r = await h.run("const v = await nodeOutput('uid-a', 1); return v.url").result;
		assert.strictEqual(r.value, 'u:uid-a:1');
		assert.deepStrictEqual(h.snapshotQueries, [{ stageUid: 'uid-a', slot: 1 }]);
	});

	test('X4 stage() 往返：脚本驱动画布节点执行（P0 链路真实端到端）', async () => {
		const h = new E2EHarness({ stage: r => ({ kind: 'media', url: `gen:${r.stageUid}:${r.overrides?.['seed'] ?? 'none'}` }) });
		const r = await h.run("const a = await stage('s1'); const b = await stage('s1', { seed: 42 }); return [a.url, b.url]").result;
		assert.deepStrictEqual(r.value, ['gen:s1:none', 'gen:s1:42']);
		assert.deepStrictEqual(h.stageRuns, [{ stageUid: 's1' }, { stageUid: 's1', overrides: { seed: 42 } }]);
	});

	test('X4b stage() 失败 → fail-loud 贯穿两侧（run error，绝不给下游 null）', async () => {
		const h = new E2EHarness({ stage: () => ({ fail: 'ComfyUI unreachable' }) });
		const r = await h.run("const a = await stage('s1'); return a").result;
		assert.strictEqual(r.stopReason, 'error');
		assert.match(String(r.error), /ComfyUI unreachable/);
	});

	test('X5 limits 经 go.init 真实透传：maxTotalAgents=1 → AGENT_CAP fatal', async () => {
		const h = new E2EHarness({ limits: { maxTotalAgents: 1 } });
		const r = await h.run("await parallel([() => agent('a'), () => agent('b')]); return 'unreachable'").result;
		assert.strictEqual(r.stopReason, 'error');
		assert.match(String(r.error), /AGENT_CAP/);
	});

	test('X5b maxConcurrentAgents=1 → 真实 FIFO 串行（start/end 严格交错）', async () => {
		const h = new E2EHarness({ limits: { maxConcurrentAgents: 1 } });
		const r = await h.run("const t = await parallel([() => agent('first'), () => agent('second')]); return t.length").result;
		assert.strictEqual(r.value, 2);
		assert.deepStrictEqual(
			h.types('agent-start', 'agent-end').map(e => e.type),
			['agent-start', 'agent-end', 'agent-start', 'agent-end'],
		);
	});

	test('X6 语法错：worker 分级 SCRIPT_PARSE 经真实协议到 host', async () => {
		const h = new E2EHarness();
		const r = await h.run('return {').result;
		assert.strictEqual(r.stopReason, 'error');
		assert.match(String(r.error), /SCRIPT_PARSE/);
	});

	test('X6b childPort 启动抛错 → AGENT_START fatal（host 拒绝语义贯穿）', async () => {
		const h = new E2EHarness({ childStartFails: 'no capacity' });
		const r = await h.run("await agent('p'); return 1").result;
		assert.strictEqual(r.stopReason, 'error');
		assert.match(String(r.error), /AGENT_START|no capacity/);
	});

	test('X7 cancel 贯穿：run 中途取消 → cancelled + 账本闭合 + worker 回收', async () => {
		const h = new E2EHarness({ disposeGraceMs: 120, childSettle: () => ({ success: true, output: 'slow' }) });
		const run = h.run("await agent('long'); return 'done'");
		// 等 agent-start 真实发生后再取消
		for (let i = 0; i < 100 && h.types('agent-start').length === 0; i++) { await new Promise(r => setTimeout(r, 5)); }
		assert.strictEqual(h.types('agent-start').length, 1, 'agent 必须已启动');
		run.cancel('user stop');
		const r = await run.result;
		assert.strictEqual(r.stopReason, 'cancelled');
		assert.strictEqual(h.types('agent-start').length, h.types('agent-end').length, 'cancel 后账本仍恰好配对');
		await run.dispose();
		assert.ok(h.worker.terminated >= 1, 'worker 必须被 terminate');
	});

	test('★ X8 P4 墙钟上限：脚本永挂 → 自动 cancelled + terminate（不再无限悬挂）', async () => {
		const h = new E2EHarness({ maxRunDurationMs: 120, disposeGraceMs: 80 });
		const t0 = Date.now();
		// 无人 cancel、worker 永不回 result —— 旧行为下 await run.result 永久挂起
		const run = h.run('await new Promise(() => {}); return 1');
		const r = await run.result;
		const elapsed = Date.now() - t0;
		assert.strictEqual(r.stopReason, 'cancelled');
		assert.match(String(r.error), /max duration/);
		assert.ok(elapsed < 3000, `必须在墙钟+grace 内收敛（实测 ${elapsed}ms）`);
		assert.ok(h.worker.terminated >= 1, 'worker 必须被 terminate（不泄漏线程）');
	});

	test('X8b 墙钟未到不误伤：正常 run 不受影响', async () => {
		const h = new E2EHarness({ maxRunDurationMs: 5000 });
		const r = await h.run("await new Promise(r => setTimeout(r, 30)); return 'ok'").result;
		assert.strictEqual(r.stopReason, 'completed');
		assert.strictEqual(r.value, 'ok');
	});

	test('X8c 墙钟缺省值存在且合理（30 分钟，不误杀长时 ComfyUI 采样）', () => {
		assert.strictEqual(DEFAULT_MAX_RUN_DURATION_MS, 1_800_000);
	});

	test('X9 dispose 幂等：多次 dispose 只 terminate 一次', async () => {
		const h = new E2EHarness();
		const run = h.run('return 1');
		await run.result;
		await Promise.all([run.dispose(), run.dispose(), run.dispose()]);
		assert.strictEqual(h.worker.terminated, 1);
	});

	test('X10 pipeline + stage + agent 组合：真实混合链路', async () => {
		const h = new E2EHarness({
			stage: r => ({ kind: 'media', url: `img:${r.stageUid}` }),
			childSettle: req => ({ success: true, output: req.prompt.toUpperCase() }),
		});
		const body = [
			"phase('generate');",
			'const r = await pipeline(args.uids,',
			'  async (prev, uid) => (await stage(uid)).url,',
			'  async (url) => await agent(url));',
			'return r;',
		].join('\n');
		const r = await h.run(body, { uids: ['a', 'b'] }).result;
		assert.deepStrictEqual(r.value, ['IMG:A', 'IMG:B']);
		assert.strictEqual(h.stageRuns.length, 2);
		assert.strictEqual(r.agentsStarted, 2);
		assert.ok(h.types('phase').length >= 1, 'phase 事件必须到宿主');
	});

	test('X11 args 隔离（结构化克隆语义：脚本改不动调用方）', async () => {
		const h = new E2EHarness();
		const input = { y: 7 };
		const r = await h.run('args.y = 99; return args.y', input).result;
		assert.strictEqual(r.value, 99, '脚本内可改自己的副本');
		assert.strictEqual(input.y, 7, '调用方对象不受影响');
	});
});
