/*---------------------------------------------------------------------------------------------
 *  WF-E(worker) — 在 node:vm 沙箱内执行 WORKER_SOURCE，完整测试 hooks 语义。
 *  （worker 源码是自包含字符串；沙箱提供 self.postMessage/onmessage 桩。
 *   覆盖实施计划 §2.4 E1/E2/E3/E4 的 worker 侧语义。）
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import vm from 'node:vm';
import { WORKER_SOURCE } from '../../browser/workflow/workflowWorkerMain.source.js';
import type { IWorkflowLimits } from '../../common/workflow/types.js';

interface HostMessage { type: string; [k: string]: unknown; }

const DEFAULT_LIMITS: IWorkflowLimits = { maxConcurrentAgents: 2, maxTotalAgents: 100, maxItemsPerCall: 100 };

interface DriverOpts {
	/** 回复 child-start：返回 childId 或 {fail}（启动失败）。 */
	onChildStart?: (req: { prompt: string; schema?: unknown; agentId?: string; model?: string }) => string | { fail: string };
	/** child 终态；'infraFail' = 基建故障（child-failed）。 */
	settle?: { success: boolean; output?: string; structured?: unknown; stopReason?: string } | 'infraFail';
	/** 按 prompt 定制终态（E1.5 混合结局）。 */
	settleByPrompt?: (prompt: string) => { success: boolean; output?: string; structured?: unknown; stopReason?: string } | 'infraFail';
	/** M2：nodeOutput 查询 → 返回值或 {fail}（fail-loud fatal）。 */
	onNodeOutput?: (query: { stageUid: string; slot?: number }) => unknown | { fail: string };
	/** P0：stage() 执行 → 返回物化值或 {fail}（fail-loud fatal）。 */
	onStageRun?: (request: { stageUid: string; overrides?: Record<string, unknown> }) => unknown | { fail: string };
}

class WorkerHarness {
	readonly toHost: HostMessage[] = [];
	private _onmessage: ((ev: { data: unknown }) => void) | undefined;
	private readonly _ctx: vm.Context;

	constructor() {
		const selfObj: Record<string, unknown> = {};
		Object.defineProperty(selfObj, 'postMessage', { value: (m: HostMessage) => { this.toHost.push(m); } });
		Object.defineProperty(selfObj, 'onmessage', {
			get: () => this._onmessage,
			set: (h: ((ev: { data: unknown }) => void) | undefined) => { this._onmessage = h; },
		});
		// timer 是 Web Worker 标准 API —— 沙箱对齐真实 worker 环境（源码不遮蔽 setTimeout）
		this._ctx = vm.createContext({
			self: selfObj,
			console,
			setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
		});
		vm.runInContext(WORKER_SOURCE, this._ctx, { filename: 'workflow-worker.js' });
	}

	send(msg: unknown): void { this._onmessage?.({ data: msg }); }
	next(): HostMessage | undefined { return this.toHost.shift(); }
	/** 轮询直到 worker 产出下一条消息或超时。 */
	async waitNext(ms = 1000): Promise<HostMessage | undefined> {
		const deadline = Date.now() + ms;
		for (;;) {
			const m = this.next();
			if (m !== undefined) { return m; }
			if (Date.now() > deadline) { return undefined; }
			await new Promise(r => setTimeout(r, 5));
		}
	}
}

/** realm 归一：vm 沙箱对象的原型 ≠ host，deepStrictEqual 会判原型不等 → JSON round-trip。 */
function plain<T>(v: unknown): T { return JSON.parse(JSON.stringify(v)) as T; }

interface RunOutcome {
	result: { value: unknown; stopReason: string; error?: string; agentsStarted: number } | undefined;
	messages: HostMessage[];
}

/**
 * 跑脚本到终态。
 * ★ child-started 与 child-settled 之间用物理延迟（10ms）隔离：若同批微任务发出，
 *   worker 同步查 pendingResult 表时尚未注册 → settled 被静默丢弃 → agent 永挂。
 */
async function runScript(body: string, opts: { limits?: Partial<IWorkflowLimits>; args?: unknown; driver?: DriverOpts } = {}): Promise<RunOutcome> {
	const h = new WorkerHarness();
	const limits = { ...DEFAULT_LIMITS, ...opts.limits };
	const driver = opts.driver ?? {};
	const settleDefault = driver.settle ?? { success: true, output: 'ok', stopReason: 'completed' };
	const messages: HostMessage[] = [];
	let result: RunOutcome['result'];
	h.send({ type: 'go', init: { meta: { name: 't', description: 'd' }, body, args: opts.args ?? {}, limits } });
	const deadline = Date.now() + 3000;
	while (result === undefined && Date.now() < deadline) {
		await new Promise(r => setTimeout(r, 5));
		let m: HostMessage | undefined;
		while ((m = h.next()) !== undefined) {
			messages.push(m);
			if (m.type === 'result') { result = plain(m.result); break; }
			if (m.type === 'child-start') {
				const callId = m.callId as number;
				const req = m.request as { prompt: string };
				const decision = driver.onChildStart?.(req) ?? `child-${callId}`;
				if (typeof decision === 'string') {
					h.send({ type: 'child-started', callId, childId: decision });
					const settle = driver.settleByPrompt?.(req.prompt) ?? settleDefault;
					setTimeout(() => {
						if (settle === 'infraFail') {
							h.send({ type: 'child-failed', callId, rendered: 'provider exploded' });
						} else {
							h.send({ type: 'child-settled', callId, result: { success: settle.success, output: settle.output, structured: settle.structured, stopReason: settle.stopReason ?? (settle.success ? 'completed' : 'failed') } });
						}
					}, 10);
				} else {
					h.send({ type: 'child-start-error', callId, rendered: decision.fail });
				}
			} else if (m.type === 'child-dispose') {
				h.send({ type: 'child-disposed', callId: m.callId as number });
			} else if (m.type === 'node-output') {
				const callId = m.callId as number;
				const q = m.query as { stageUid: string; slot?: number };
				const decision = driver.onNodeOutput?.(q);
				if (decision !== undefined && typeof decision === 'object' && 'fail' in decision) {
					h.send({ type: 'node-output-error', callId, rendered: decision.fail });
				} else {
					h.send({ type: 'node-output-result', callId, result: { value: decision } });
				}
			} else if (m.type === 'stage-run') {
				const callId = m.callId as number;
				const req = plain<{ stageUid: string; overrides?: Record<string, unknown> }>(m.request);
				const decision = driver.onStageRun?.(req);
				if (decision !== undefined && typeof decision === 'object' && decision !== null && 'fail' in decision) {
					h.send({ type: 'stage-run-error', callId, rendered: (decision as { fail: string }).fail });
				} else {
					h.send({ type: 'stage-run-result', callId, result: { value: decision } });
				}
			}
		}
	}
	return { result, messages };
}

function ok(output = 'ok'): NonNullable<DriverOpts['settle']> { return { success: true, output, stopReason: 'completed' }; }
function fail(): NonNullable<DriverOpts['settle']> { return { success: false, stopReason: 'failed' }; }

suite('workflow worker — 正常路径 (E1)', () => {

	test('E1.1 最小 run：return 1', async () => {
		const { result } = await runScript('return 1');
		assert.deepStrictEqual(result, { value: 1, stopReason: 'completed', agentsStarted: 0 });
	});

	test('E1.2 agent 文本 + agent-start/end 配对', async () => {
		const { result, messages } = await runScript("const v = await agent('hi', {label:'L'}); return v", { driver: { settle: ok('done') } });
		assert.strictEqual(result?.value, 'done');
		assert.strictEqual(result?.agentsStarted, 1);
		const start = messages.find(m => m.type === 'agent-start');
		const end = messages.find(m => m.type === 'agent-end');
		assert.ok(start, 'agent-start 必须 emit');
		const info = plain<{ label: string; seq: number; childId: string }>(start.info);
		assert.strictEqual(info.label, 'L');
		assert.strictEqual(info.seq, 1);
		assert.strictEqual(plain<{ outcome: string }>(end?.info).outcome, 'completed');
	});

	test('E1.3 agent schema → structured 对象', async () => {
		const schema = { type: 'object', properties: { n: { type: 'integer' } } };
		const { result } = await runScript(`const v = await agent('p', {schema: ${JSON.stringify(schema)}}); return v`, { driver: { settle: { success: true, structured: { n: 3 }, stopReason: 'completed' } } });
		assert.deepStrictEqual(result?.value, { n: 3 });
	});

	test('E1.4 schema 子代理失败 → null（run 仍 completed）', async () => {
		const schema = { type: 'object', properties: { n: { type: 'integer' } } };
		const { result, messages } = await runScript(`const v = await agent('p', {schema: ${JSON.stringify(schema)}}); return v`, { driver: { settle: fail() } });
		assert.strictEqual(result?.value, null);
		assert.strictEqual(result?.stopReason, 'completed');
		assert.strictEqual(plain<{ outcome: string }>(messages.find(m => m.type === 'agent-end')?.info).outcome, 'failed');
	});

	test('E1.5 parallel 混合结局：[v,null,v]', async () => {
		const { result } = await runScript("const r = await parallel([() => agent('good1'), () => agent('bad'), () => agent('good2')]); return r;", {
			driver: { settleByPrompt: p => p === 'bad' ? fail() : ok('v') },
		});
		assert.deepStrictEqual(result?.value, ['v', null, 'v']);
		assert.strictEqual(result?.stopReason, 'completed');
	});

	test('E1.6 pipeline 无 barrier（item 交错推进）', async () => {
		// stage1 对 item1 快、item2 慢；stage2 记录进入序 —— item1 的 stage2 先于 item2 的 stage1 完成
		const body = [
			'const order = [];',
			'const r = await pipeline([1, 2],',
			'  async (p, item) => { if (item === 2) { await new Promise(r => setTimeout(r, 80)); } order.push("s1-" + item); return item; },',
			'  async (p, item) => { order.push("s2-" + item); return item * 10; });',
			'return { r, order };',
		].join('\n');
		const { result } = await runScript(body);
		assert.deepStrictEqual(result?.value, { r: [10, 20], order: ['s1-1', 's2-1', 's1-2', 's2-2'] });
	});

	test('E1.7 pipeline：stage 抛错 → 该 item null，其余不受影响', async () => {
		const body = `const r = await pipeline([1,2,3], (p) => { if (p === 2) { throw new Error('boom'); } return p; }, (p) => p * 10); return r;`;
		const { result } = await runScript(body);
		assert.deepStrictEqual(result?.value, [10, null, 30]);
	});

	test('E1.8 动态扇出：args.files map 5 个 agent', async () => {
		const { result, messages } = await runScript('const r = await parallel(args.files.map(f => () => agent(f))); return r.length;', {
			args: { files: ['a', 'b', 'c', 'd', 'e'] },
			limits: { maxConcurrentAgents: 5 },
			driver: { settle: ok('x') },
		});
		assert.strictEqual(result?.value, 5);
		assert.strictEqual(result?.agentsStarted, 5);
		assert.strictEqual(messages.filter(m => m.type === 'agent-start').length, 5);
	});

	test('E1.9 args 隔离（workerData clone 语义）', async () => {
		const { result } = await runScript('args.x = 1; return args.y', { args: { y: 7 } });
		assert.strictEqual(result?.value, 7);
	});

	test('E1.10 phase/log 事件顺序', async () => {
		const { messages } = await runScript("phase('P1'); log('hello'); return 1");
		const types = messages.filter(m => m.type === 'phase' || m.type === 'log').map(m => m.type);
		assert.deepStrictEqual(types, ['phase', 'log']);
	});
});

suite('workflow worker — 失败分级 (E2)', () => {

	test('E2.1 语法错 → SCRIPT_PARSE', async () => {
		const { result } = await runScript('return {');
		assert.match(String(result?.error), /SCRIPT_PARSE/);
		assert.strictEqual(result?.stopReason, 'error');
	});

	test('E2.2 agent(42) → INVALID_ARGUMENT', async () => {
		const { result } = await runScript('await agent(42)');
		assert.match(String(result?.error), /INVALID_ARGUMENT/);
	});

	test('E2.3 未知选项 effort → UNSUPPORTED_OPTION（含 deferred 提示）', async () => {
		const { result } = await runScript("await agent('p', {effort:'high'})");
		assert.match(String(result?.error), /UNSUPPORTED_OPTION/);
		assert.match(String(result?.error), /effort/);
	});

	test('E2.4 schema 超集（pattern）→ UNSUPPORTED_SCHEMA', async () => {
		const { result } = await runScript("await agent('p', {schema: {type:'string', pattern:'^a'}})");
		assert.match(String(result?.error), /UNSUPPORTED_SCHEMA/);
	});

	test('E2.5 AGENT_CAP：maxTotalAgents=1 起第二个 → fatal', async () => {
		const { result } = await runScript('await parallel([() => agent("a"), () => agent("b")])', { limits: { maxTotalAgents: 1 }, driver: { settle: ok() } });
		assert.match(String(result?.error), /AGENT_CAP/);
		assert.strictEqual(result?.stopReason, 'error');
	});

	test('E2.6 ITEM_CAP：parallel 超 maxItemsPerCall', async () => {
		const thunks = Array.from({ length: 5 }, (_, i) => `() => ${i}`).join(',');
		const { result } = await runScript(`await parallel([${thunks}])`, { limits: { maxItemsPerCall: 4 } });
		assert.match(String(result?.error), /ITEM_CAP/);
	});

	test('E2.7 基建故障（child-failed）→ AGENT_RESULT fatal（不是 null）', async () => {
		const { result } = await runScript("await agent('p')", { driver: { settle: 'infraFail' } });
		assert.match(String(result?.error), /AGENT_RESULT/);
		assert.strictEqual(result?.stopReason, 'error');
	});

	test('E2.7b 启动失败（child-start-error）→ AGENT_START fatal', async () => {
		const { result } = await runScript("await agent('p')", { driver: { onChildStart: () => ({ fail: 'no capacity' }) } });
		assert.match(String(result?.error), /AGENT_START/);
	});

	test('E2.8 返回函数 → RESULT_UNSERIALIZABLE', async () => {
		const { result } = await runScript('return { f: () => 1 }');
		assert.match(String(result?.error), /RESULT_UNSERIALIZABLE|not JSON/i);
		assert.strictEqual(result?.stopReason, 'error');
	});

	test('E2.9 并发上限 FIFO：maxConcurrent=1 串行（start/end 交错）', async () => {
		const { result, messages } = await runScript("const t = await parallel([() => agent('first'), () => agent('second')]); return t.length;", {
			limits: { maxConcurrentAgents: 1 },
			driver: { settle: ok('v') },
		});
		assert.strictEqual(result?.value, 2);
		const seq = messages.filter(m => m.type === 'agent-start' || m.type === 'agent-end').map(m => m.type);
		assert.deepStrictEqual(seq, ['agent-start', 'agent-end', 'agent-start', 'agent-end'], '第二个 start 必须在第一个 end 之后（FIFO）');
	});

	test('E2.10 result 永不 reject：全错误路径均产出 result 消息', async () => {
		for (const body of ['return {', 'await agent(42)', 'return (() => 1)']) {
			const { result } = await runScript(body);
			assert.ok(result !== undefined, `脚本 "${body.slice(0, 20)}" 必须产出 result`);
			assert.notStrictEqual(result.stopReason, 'completed');
		}
	});
});

suite('workflow worker — 取消与环境 (E3/E4)', () => {

	test('E3.2 cancel 先于 go：脚本不执行，无 phase 泄漏，报 cancelled', async () => {
		const h = new WorkerHarness();
		h.send({ type: 'cancel', reason: 'test' });
		h.send({ type: 'go', init: { meta: { name: 't', description: 'd' }, body: "phase('never'); log('never'); return 1", args: {}, limits: DEFAULT_LIMITS } });
		let result: HostMessage | undefined;
		for (let i = 0; i < 40 && !result; i++) {
			await new Promise(r => setTimeout(r, 5));
			for (let m = h.next(); m !== undefined; m = h.next()) {
				if (m.type === 'result') { result = m; break; }
			}
		}
		const r = plain<{ stopReason: string }>(result?.result);
		assert.strictEqual(r.stopReason, 'cancelled');
		assert.strictEqual(h.toHost.filter(m => m.type === 'phase').length, 0, 'cancel 后 phase 不得 emit');
	});

	test('E4.1 环境遮蔽：fetch/XMLHttpRequest/WebSocket 为 undefined', async () => {
		const { result } = await runScript("return typeof fetch + '/' + typeof XMLHttpRequest + '/' + typeof WebSocket");
		assert.strictEqual(result?.value, 'undefined/undefined/undefined');
	});

	test('E3.9 dropped promise（不 await 的 agent）不杀 worker，run 正常完成', async () => {
		const { result } = await runScript("agent('fire-and-forget'); return 'done'", { driver: { settle: ok('x') } });
		assert.strictEqual(result?.value, 'done');
	});

	test('E2.10b phase 缺 title → INVALID_ARGUMENT', async () => {
		const { result } = await runScript("phase(''); return 1");
		assert.match(String(result?.error), /INVALID_ARGUMENT/);
	});
});

suite('workflow worker — nodeOutput 画布桥 (C2)', () => {

	test('C2.1 json/text/media 三态物化值原样到达脚本', async () => {
		const json = await runScript("const v = await nodeOutput('uid-a'); return v", { driver: { onNodeOutput: () => ({ findings: 3 }) } });
		assert.deepStrictEqual(json.result?.value, { findings: 3 });
		const text = await runScript("const v = await nodeOutput('uid-b'); return v", { driver: { onNodeOutput: () => 'plain text' } });
		assert.strictEqual(text.result?.value, 'plain text');
		const media = await runScript("const v = await nodeOutput('uid-c', 0); return v", { driver: { onNodeOutput: q => ({ kind: 'media', url: `u:${q.stageUid}:${q.slot}` }) } });
		assert.deepStrictEqual(media.result?.value, { kind: 'media', url: 'u:uid-c:0' });
	});

	test('C2.2 查无 uid → node-output-error → fatal INVALID_ARGUMENT（fail-loud）', async () => {
		const { result } = await runScript("await nodeOutput('nope')", { driver: { onNodeOutput: () => ({ fail: 'no snapshot for stageUid "nope"' }) } });
		assert.strictEqual(result?.stopReason, 'error');
		assert.match(String(result?.error), /INVALID_ARGUMENT/);
		assert.match(String(result?.error), /no snapshot/);
	});

	test('C2.3 slot 非法参数 → INVALID_ARGUMENT（不发起 RPC）', async () => {
		const { result } = await runScript("await nodeOutput('uid', -1)");
		assert.match(String(result?.error), /INVALID_ARGUMENT/);
	});

	test('C2.4 nodeOutput 与 agent 串联（读画布 → 扇出 → 汇总）', async () => {
		const body = `
			const img = await nodeOutput('sketch-uid', 0);
			const styles = await parallel(['cyber', 'aqua'].map(s => () => agent(s + ':' + img.url)));
			return { img, styles };
		`;
		const { result, messages } = await runScript(body, {
			driver: {
				onNodeOutput: () => ({ kind: 'media', url: 'blob:x' }),
				settleByPrompt: p => ({ success: true, output: p, stopReason: 'completed' }),
			},
		});
		assert.strictEqual((result?.value as { img: { url: string } }).img.url, 'blob:x');
		assert.deepStrictEqual((result?.value as { styles: string[] }).styles, ['cyber:blob:x', 'aqua:blob:x']);
		assert.strictEqual(messages.filter(m => m.type === 'child-start').length, 2);
	});
});

suite('workflow worker — stage() 画布写方向桥 (C3)', () => {

	test('C3.1 stage(uid) 触发执行并把物化输出交给脚本', async () => {
		const { result, messages } = await runScript("const img = await stage('stage-uid'); return img", {
			driver: { onStageRun: r => ({ kind: 'media', url: `gen:${r.stageUid}`, mime: 'image/png' }) },
		});
		assert.deepStrictEqual(result?.value, { kind: 'media', url: 'gen:stage-uid', mime: 'image/png' });
		const req = messages.find(m => m.type === 'stage-run');
		assert.ok(req, 'stage() 必须发起 stage-run RPC');
		assert.deepStrictEqual(plain(req.request), { stageUid: 'stage-uid' }, '无 overrides 时不带该字段');
	});

	test('C3.2 overrides 物化为 plain JSON 过线（覆写节点 widget 值）', async () => {
		const { result, messages } = await runScript("return await stage('u', { seed: 42, batch_size: 2, nested: { a: [1,2] } })", {
			driver: { onStageRun: r => r.overrides },
		});
		assert.deepStrictEqual(result?.value, { seed: 42, batch_size: 2, nested: { a: [1, 2] } });
		assert.deepStrictEqual(plain(messages.find(m => m.type === 'stage-run')?.request), {
			stageUid: 'u', overrides: { seed: 42, batch_size: 2, nested: { a: [1, 2] } },
		});
	});

	test('C3.3 节点执行失败 → fatal（fail-loud，绝不给下游 null）', async () => {
		const { result } = await runScript("const a = await stage('u'); return a", {
			driver: { onStageRun: () => ({ fail: 'ComfyUI 不可达（ECONNREFUSED 127.0.0.1:8188）' }) },
		});
		assert.strictEqual(result?.stopReason, 'error');
		assert.match(String(result?.error), /INVALID_ARGUMENT/);
		assert.match(String(result?.error), /ComfyUI/);
	});

	test('C3.4 参数校验（不发起 RPC）：空 uid / 数组 overrides / 不可序列化 overrides', async () => {
		for (const body of ["await stage('')", 'await stage(42)', "await stage('u', [1,2])", "await stage('u', { f: () => 1 })"]) {
			const { result, messages } = await runScript(body);
			assert.strictEqual(result?.stopReason, 'error', `"${body}" 必须 fatal`);
			assert.match(String(result?.error), /INVALID_ARGUMENT|RESULT_UNSERIALIZABLE|not JSON/i, `"${body}" 错误分级`);
			assert.strictEqual(messages.filter(m => m.type === 'stage-run').length, 0, `"${body}" 不得发起 RPC`);
		}
	});

	test('C3.5 stage → agent → stage 全链路（生成 → 评审 → 按评审结果重生成）', async () => {
		const body = `
			const first = await stage('sketch');
			const verdict = await agent('review ' + first.url, { schema: { type: 'object', properties: { seed: { type: 'integer' } }, required: ['seed'] } });
			const second = await stage('sketch', { seed: verdict.seed });
			return { first: first.url, second: second.url };
		`;
		const { result, messages } = await runScript(body, {
			driver: {
				onStageRun: r => ({ kind: 'media', url: `img:${r.overrides?.['seed'] ?? 'default'}` }),
				settle: { success: true, structured: { seed: 7 }, stopReason: 'completed' },
			},
		});
		assert.deepStrictEqual(result?.value, { first: 'img:default', second: 'img:7' });
		assert.strictEqual(messages.filter(m => m.type === 'stage-run').length, 2);
		assert.strictEqual(result?.agentsStarted, 1);
	});

	test('C3.6 parallel 内多个 stage 并发（画布批量生成）', async () => {
		const body = "const r = await parallel(['a','b','c'].map(u => () => stage(u))); return r.map(x => x.url);";
		const { result, messages } = await runScript(body, {
			driver: { onStageRun: r => ({ kind: 'media', url: `u:${r.stageUid}` }) },
		});
		assert.deepStrictEqual(result?.value, ['u:a', 'u:b', 'u:c']);
		assert.strictEqual(messages.filter(m => m.type === 'stage-run').length, 3);
	});
});
