/*---------------------------------------------------------------------------------------------
 *  Unit test: _executeWorkflowTurn 的事件订阅收支平衡（2026-09-11 修 listener 泄漏）
 *
 *  实测现象：`base/common/event.ts` 报 `potential listener LEAK detected, having 175
 *  listeners already`，栈顶是 `agentDriverService.ts` 的 `_executeWorkflowTurn` 里
 *  `onDidExecutionStatusChange` 的订阅。
 *
 *  根因：等待终态的 `for(;;)` 每轮都新建一个 `onDidExecutionStatusChange` 订阅，但
 *  **只在「终态到达」分支 dispose**；被「逐格进度唤醒」（`resolve(null)`）的那一轮
 *  从不 dispose → **每收到一条 node_progress 就泄漏一个监听器** ✗
 *  （progressSub 亦只在正常路径 dispose，abort/异常路径同样泄漏）。
 *
 *  本测试用计数式假服务驱动生成器：走「进度唤醒 → 进度唤醒 → 终态」三轮，
 *  断言**创建数 === 释放数**。修复前该断言必然失败（3 创建 / 1 释放）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { AgentDriverService } from '../../browser/agentDriverService.js';

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** 计数式假 IWorkflowExecutionService：暴露创建/释放计数与手动触发入口。 */
class FakeWorkflowExecutionService {
	statusCreated = 0;
	statusDisposed = 0;
	traceCreated = 0;
	traceDisposed = 0;

	private readonly _statusListeners = new Set<(s: unknown) => void>();
	private readonly _traceListeners = new Set<(t: unknown) => void>();

	async executeWorkflow(): Promise<string> { return 'exec1'; }
	async cancelExecution(): Promise<void> { /* noop */ }
	getExecutionState(): undefined { return undefined; }

	onDidExecutionStatusChange(cb: (s: unknown) => void): { dispose(): void } {
		this.statusCreated++;
		this._statusListeners.add(cb);
		return {
			dispose: () => {
				if (this._statusListeners.delete(cb)) { this.statusDisposed++; }
			},
		};
	}

	onDidExecutionTrace(cb: (t: unknown) => void): { dispose(): void } {
		this.traceCreated++;
		this._traceListeners.add(cb);
		return {
			dispose: () => {
				if (this._traceListeners.delete(cb)) { this.traceDisposed++; }
			},
		};
	}

	fireTrace(trace: Record<string, unknown>): void {
		for (const l of [...this._traceListeners]) { l(trace); }
	}

	fireStatus(state: Record<string, unknown>): void {
		for (const l of [...this._statusListeners]) { l(state); }
	}
}

function makeDriver(fakeWf: FakeWorkflowExecutionService): AgentDriverService {
	const noopLog = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };
	return new AgentDriverService(
		{} as never,                                  // IAgentOSService
		{} as never,                                  // ISkillRegistry
		noopLog as never,                             // ILogService
		{ getValue: () => 4 } as never,               // IConfigurationService
		{} as never,                                  // IAgentStudioService（自愈走 catch）
		{} as never,                                  // IWorkspaceContextService
		{} as never,                                  // IMcpService
		{} as never,                                  // IStorageService
		{ invokeFunction: (fn: (a: unknown) => unknown) => fn({ get: () => fakeWf }) } as never,
	);
}

/** 驱动生成器直到结束，返回所有 yield 的 delta。 */
async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
	const out: unknown[] = [];
	for (;;) {
		const r = await gen.next();
		if (r.done) { return out; }
		out.push(r.value);
	}
}

suite('_executeWorkflowTurn 订阅收支平衡（listener 泄漏回归）', () => {

	test('★ 进度唤醒路径也必须释放状态订阅（否则每条 node_progress 泄漏一个）', async () => {
		const fakeWf = new FakeWorkflowExecutionService();
		const driver = makeDriver(fakeWf);

		const gen = (driver as unknown as {
			_executeWorkflowTurn: (r: unknown, t: unknown, c: AbortController) => AsyncGenerator<unknown>;
		})._executeWorkflowTurn(
			{ agentId: 'a1', sessionId: 's1' },
			{ workflowId: 'wf1' },
			new AbortController(),
		);

		// 第 1 轮：等订阅建立后，用一条进度**唤醒**（这条路径不经过终态分支）
		const p1 = gen.next();
		await flush();
		fakeWf.fireTrace({ executionId: 'exec1', kind: 'node_progress', nodeName: 'N1', progress: 40 });
		await p1;

		// 第 2 轮：再来一条进度唤醒
		const p2 = gen.next();
		await flush();
		fakeWf.fireTrace({ executionId: 'exec1', kind: 'node_progress', nodeName: 'N1', progress: 80 });
		await p2;

		// 第 3 轮：终态
		const p3 = gen.next();
		await flush();
		fakeWf.fireStatus({ executionId: 'exec1', status: 'completed', nodeStates: new Map() });
		await p3;

		// 排空剩余 yield（收尾文案）→ 触发 finally
		await drain(gen as AsyncGenerator<unknown>);

		// ★ 核心断言：创建数必须等于释放数（修复前 3 : 1）
		assert.strictEqual(
			fakeWf.statusCreated,
			fakeWf.statusDisposed,
			`onDidExecutionStatusChange 泄漏：创建 ${fakeWf.statusCreated} / 释放 ${fakeWf.statusDisposed}`,
		);
		assert.strictEqual(
			fakeWf.traceCreated,
			fakeWf.traceDisposed,
			`onDidExecutionTrace 泄漏：创建 ${fakeWf.traceCreated} / 释放 ${fakeWf.traceDisposed}`,
		);
		// 三轮等待 → 至少创建 3 个状态订阅（证明上面确实走了多轮，断言不是空转）
		assert.ok(fakeWf.statusCreated >= 3, `应至少创建 3 个状态订阅，实际 ${fakeWf.statusCreated}`);
	});

	test('★ 中途 abort（消费者提前退出）也必须释放两个订阅', async () => {
		const fakeWf = new FakeWorkflowExecutionService();
		const driver = makeDriver(fakeWf);
		const controller = new AbortController();

		const gen = (driver as unknown as {
			_executeWorkflowTurn: (r: unknown, t: unknown, c: AbortController) => AsyncGenerator<unknown>;
		})._executeWorkflowTurn({ agentId: 'a1', sessionId: 's1' }, { workflowId: 'wf1' }, controller);

		const p1 = gen.next();
		await flush();

		// 消费者提前退出（等价于 abort 后上层停止迭代）。
		// 注：异步生成器挂起在 `await` 时，`return()` 的 finally **要等该 await 落定**
		// 才执行 —— 现实里 abort → 工作流进入 cancelled 终态即落定，故此处补一条终态。
		const ret = gen.return(undefined as never);
		await flush();
		fakeWf.fireStatus({ executionId: 'exec1', status: 'cancelled', nodeStates: new Map() });
		await ret.catch(() => { /* return() 会让挂起的 next 结束 */ });
		await p1.catch(() => { /* 同上 */ });

		assert.strictEqual(fakeWf.statusCreated, fakeWf.statusDisposed, '提前退出时状态订阅应被释放');
		assert.strictEqual(fakeWf.traceCreated, fakeWf.traceDisposed, '提前退出时进度订阅应被释放');
	});
});
