/*---------------------------------------------------------------------------------------------
 *  多 Agent 协同 / 写冲突互斥（P0②）测试。
 *
 *  背景：子代理**共享父 worktree**（无隔离档、无合并步骤），两个可写子代理并发 = 必然
 *  互相覆盖 / patch 锚点失效。而并行扇出（delegate_task / plan_explore / 画布并行层 /
 *  swarm workers）是本项目核心用法 → 必须在「所有执行路径的公共咽喉」串行化写者，
 *  同时让只读子代理零回归地并行。
 *
 *  本文件覆盖三层：
 *    A. 写能力判定（isWriteTool / hasWriteCapability）—— 含「类型说只读、工具面能写」的
 *       `data` agent 场景（Explore 档 + terminal）。
 *    B. FIFO 写互斥锁语义（互斥 / 公平 / 幂等 / 重入 / abort / withLock / reset / stats）。
 *    C. 调度层集成：两个 General 子代理**不得并发**、两个 Explore 子代理**必须并发**、
 *       排队期间 abort → interrupted（不启动执行）。
 *
 *  放在 test/browser/：该目录被 run-all-browser-tests.mjs 自动发现，也可单跑。
 *  注：`SubAgentType` 是 const enum（编译期内联，运行时无对象）→ 本文件用字符串字面量，
 *  避免依赖转译器的 enum 内联行为。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { createWriteExclusionLock, hasWriteCapability, isWriteTool, WriteLockAbortedError } from '../../common/writeExclusion.js';
import { UnifiedSubAgentDispatch, type SubAgentType } from '../../common/unifiedSubAgentDispatch.js';
import type { IAgentTurnRequest, IChatStreamDelta } from '../../common/providers.js';
import type { IterationBudget } from '../../common/iterationBudget.js';

/** const enum 的运行时等价字面量（见文件头注释）。 */
const GENERAL = 'general' as SubAgentType;
const EXPLORE = 'explore' as SubAgentType;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

suite('多 Agent 协同 / 写能力判定', () => {

	test('写类工具被识别（含此前漏判的 patch / execute_command）', () => {
		for (const tool of ['file_write', 'patch', 'apply_patch', 'execute_command', 'terminal', 'mkdir', 'mv', 'delete_file']) {
			assert.strictEqual(isWriteTool(tool), true, `${tool} 应判为写类`);
		}
	});

	test('只读工具不误判', () => {
		for (const tool of ['file_read', 'search_files', 'search_code', 'search_graph', 'query_graph', 'web_search', 'list_dir', 'get_code_snippet']) {
			assert.strictEqual(isWriteTool(tool), false, `${tool} 不应判为写类`);
		}
	});

	test('大小写不敏感（工具名来自不同 provider，大小写不统一）', () => {
		assert.strictEqual(isWriteTool('FILE_WRITE'), true);
		assert.strictEqual(isWriteTool('Patch'), true);
	});

	test('★ 工具面优先于类型档：Explore 档 + terminal（data agent）必须判为可写', () => {
		// `data` 内置 agent 以 Explore 档派发（SUB_AGENT_PERMISSIONS.Explore.canWrite=false），
		// 但其工具面含 terminal（见 unifiedSubAgentDispatch 的 _EXPLORE_REAL_TOOLS 注释）
		// → 只看类型会漏判，两个 data 子代理并发就会互相覆盖。
		assert.strictEqual(
			hasWriteCapability({ allowedTools: ['search_graph', 'terminal'], canWrite: false, canExecute: false, type: 'explore' }),
			true,
		);
	});

	test('工具面全为只读 → 只读（即使类型档说可写）', () => {
		assert.strictEqual(
			hasWriteCapability({ allowedTools: ['file_read', 'search_files'], canWrite: true, canExecute: true, type: 'general' }),
			false,
		);
	});

	test('excludedTools 会从工具面里剔除（剔除后无写工具 → 只读）', () => {
		assert.strictEqual(
			hasWriteCapability({ allowedTools: ['file_read', 'file_write'], excludedTools: ['file_write'], type: 'general' }),
			false,
		);
	});

	test('无显式工具面 → 回退权限档（general 可写，explore/scout 只读）', () => {
		assert.strictEqual(hasWriteCapability({ canWrite: true, canExecute: true, type: 'general' }), true);
		assert.strictEqual(hasWriteCapability({ canWrite: false, canExecute: false, type: 'explore' }), false);
		assert.strictEqual(hasWriteCapability({ canWrite: false, canExecute: false, type: 'scout' }), false);
	});

	test('canExecute 单独为真也算可写（terminal 能改文件）', () => {
		assert.strictEqual(hasWriteCapability({ canWrite: false, canExecute: true, type: 'general' }), true);
	});

	test('★ 未知类型保守判为可写（宁可串行，不可写冲突）', () => {
		assert.strictEqual(hasWriteCapability({ type: 'some-future-type' }), true);
		assert.strictEqual(hasWriteCapability({}), true);
	});
});

suite('多 Agent 协同 / FIFO 写互斥锁', () => {

	test('互斥：并发 withLock 的执行体不重叠', async () => {
		const lock = createWriteExclusionLock();
		let inside = 0;
		let maxInside = 0;
		const work = () => lock.withLock(async () => {
			inside++;
			maxInside = Math.max(maxInside, inside);
			await sleep(3);
			inside--;
		});
		await Promise.all([work(), work(), work(), work()]);
		assert.strictEqual(maxInside, 1, '写者必须串行');
		assert.strictEqual(lock.stats().acquired, 4);
		assert.ok(lock.stats().waits >= 1, '应有排队计数');
	});

	test('公平：按到达顺序授予（FIFO，防写者饿死）', async () => {
		const lock = createWriteExclusionLock();
		const order: string[] = [];
		const release1 = await lock.acquire({ owner: 'a' });
		const p2 = lock.acquire({ owner: 'b' }).then(r => { order.push('b'); return r; });
		const p3 = lock.acquire({ owner: 'c' }).then(r => { order.push('c'); return r; });
		release1();
		const release2 = await p2;
		release2();
		const release3 = await p3;
		order.push('done');
		release3();
		assert.deepStrictEqual(order, ['b', 'c', 'done']);
	});

	test('release 幂等，且二次释放不会误放他人的锁', async () => {
		const lock = createWriteExclusionLock();
		const releaseA = await lock.acquire({ owner: 'a' });
		releaseA();
		const releaseB = await lock.acquire({ owner: 'b' });
		releaseA(); // 重复释放：必须无效
		assert.strictEqual(lock.stats().held, true, 'b 仍应持锁');
		assert.strictEqual(lock.stats().holder, 'b');
		releaseB();
		releaseB();
		assert.strictEqual(lock.stats().held, false);
	});

	test('同 owner 重入不阻塞（防持有者自死锁），且内层释放不放开外层的锁', async () => {
		const lock = createWriteExclusionLock();
		const outer = await lock.acquire({ owner: 'x' });
		const inner = await lock.acquire({ owner: 'x' }); // 不应阻塞
		inner();
		assert.strictEqual(lock.stats().held, true, '内层释放后外层仍持锁');
		outer();
		assert.strictEqual(lock.stats().held, false);
	});

	test('不同 owner 仍互斥（重入只对同 owner 生效）', async () => {
		const lock = createWriteExclusionLock();
		const releaseA = await lock.acquire({ owner: 'a' });
		let acquiredB = false;
		const pB = lock.acquire({ owner: 'b' }).then(r => { acquiredB = true; return r; });
		await sleep(5);
		assert.strictEqual(acquiredB, false, 'b 必须等待');
		releaseA();
		const releaseB = await pB;
		releaseB();
	});

	test('withLock 在抛错路径也释放锁（不会永久占用）', async () => {
		const lock = createWriteExclusionLock();
		await assert.rejects(lock.withLock(async () => { throw new Error('boom'); }), /boom/);
		assert.strictEqual(lock.stats().held, false);
		const release = await lock.acquire(); // 未死锁即证明已释放
		release();
	});

	test('★ 排队期间 abort → 抛 WriteLockAbortedError 并退出队列', async () => {
		const lock = createWriteExclusionLock();
		const release = await lock.acquire({ owner: 'a' });
		const ac = new AbortController();
		const pending = lock.acquire({ owner: 'b', signal: ac.signal });
		assert.strictEqual(lock.stats().waiting, 1);
		ac.abort();
		await assert.rejects(pending, (e: unknown) => e instanceof WriteLockAbortedError);
		assert.strictEqual(lock.stats().waiting, 0, 'abort 后必须退出队列');
		release();
	});

	test('acquire 前已 abort 的 signal → 直接拒绝且不占锁', async () => {
		const lock = createWriteExclusionLock();
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(lock.acquire({ signal: ac.signal }), (e: unknown) => e instanceof WriteLockAbortedError);
		assert.strictEqual(lock.stats().held, false);
		assert.strictEqual(lock.stats().acquired, 0);
	});

	test('onWait 回调报告前方写者数（可解释「为什么变慢」）', async () => {
		const lock = createWriteExclusionLock();
		const release = await lock.acquire();
		const seen: number[] = [];
		const p2 = lock.acquire({ onWait: ahead => seen.push(ahead) });
		const p3 = lock.acquire({ onWait: ahead => seen.push(ahead) });
		assert.deepStrictEqual(seen, [0, 1]);
		release();
		(await p2)();
		(await p3)();
	});

	test('reset 清空排队并以 WriteLockAbortedError 结束等待者（会话重置）', async () => {
		const lock = createWriteExclusionLock();
		await lock.acquire();
		const pending = lock.acquire();
		lock.reset();
		await assert.rejects(pending, (e: unknown) => e instanceof WriteLockAbortedError);
		assert.strictEqual(lock.stats().held, false);
		assert.strictEqual(lock.stats().waiting, 0);
	});

	test('stats 记录等待时长（maxWaitMs 单调不减）', async () => {
		const lock = createWriteExclusionLock();
		const release = await lock.acquire();
		const pending = lock.acquire();
		await sleep(8);
		release();
		(await pending)();
		const stats = lock.stats();
		assert.strictEqual(stats.acquired, 2);
		assert.ok(stats.totalWaitMs >= 5, `应记录等待时长，实得 ${stats.totalWaitMs}`);
		assert.strictEqual(stats.maxWaitMs, stats.totalWaitMs);
	});
});

suite('多 Agent 协同 / 调度层写互斥（集成）', () => {

	/** 并发探针：记录同时在执行体内的最大个数。 */
	function makeProbe(insideState: { inside: number; max: number }, holdMs: number) {
		return async function* probe(_request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> {
			insideState.inside++;
			insideState.max = Math.max(insideState.max, insideState.inside);
			await sleep(holdMs);
			insideState.inside--;
			yield { type: 'text', content: 'ok' };
		};
	}

	test('★ 两个 General（可写）子代理不得并发执行 —— 写冲突互斥生效', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const probe = { inside: 0, max: 0 };
		const execFn = makeProbe(probe, 12);
		const id1 = dispatch.createSubAgent('parent', 'write task 1', { type: GENERAL });
		const id2 = dispatch.createSubAgent('parent', 'write task 2', { type: GENERAL });

		const [r1, r2] = await Promise.all([
			dispatch.executeSubAgent(id1, execFn),
			dispatch.executeSubAgent(id2, execFn),
		]);

		assert.strictEqual(r1.success, true);
		assert.strictEqual(r2.success, true);
		assert.strictEqual(probe.max, 1, '可写子代理必须串行（共享 worktree）');
		const stats = dispatch.getWriteLockStats();
		assert.strictEqual(stats.acquired, 2);
		assert.strictEqual(stats.waits, 1, '第二个写者应排队一次');
	});

	test('★ 两个 Explore（只读）子代理并行执行，且完全不占写锁 —— 主用法零回归', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const probe = { inside: 0, max: 0 };
		const execFn = makeProbe(probe, 12);
		const id1 = dispatch.createSubAgent('parent', 'explore 1', { type: EXPLORE });
		const id2 = dispatch.createSubAgent('parent', 'explore 2', { type: EXPLORE });

		await Promise.all([
			dispatch.executeSubAgent(id1, execFn),
			dispatch.executeSubAgent(id2, execFn),
		]);

		assert.strictEqual(probe.max, 2, '只读子代理应真正并行');
		assert.strictEqual(dispatch.getWriteLockStats().acquired, 0, '只读不应触碰写锁');
	});

	test('工具面全只读的 General 子代理不占锁（显式工具面优先于权限档）', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const probe = { inside: 0, max: 0 };
		const execFn = makeProbe(probe, 12);
		const readOnlyTools = ['file_read', 'search_files'];
		const id1 = dispatch.createSubAgent('parent', 'review 1', { type: GENERAL, allowedTools: readOnlyTools });
		const id2 = dispatch.createSubAgent('parent', 'review 2', { type: GENERAL, allowedTools: readOnlyTools });

		await Promise.all([
			dispatch.executeSubAgent(id1, execFn),
			dispatch.executeSubAgent(id2, execFn),
		]);

		assert.strictEqual(probe.max, 2, '显式只读工具面 → 应并行');
		assert.strictEqual(dispatch.getWriteLockStats().acquired, 0);
	});

	test('★ 排队期间父 turn 取消 → 第二个写者不启动执行，按 interrupted 收尾', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const started: string[] = [];
		const execFn = async function* (request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> {
			started.push(request.agentId);
			await sleep(30);
			yield { type: 'text', content: 'ok' };
		};
		const ac = new AbortController();
		const id1 = dispatch.createSubAgent('parent', 'writer 1', { type: GENERAL });
		const id2 = dispatch.createSubAgent('parent', 'writer 2', { type: GENERAL });

		const p1 = dispatch.executeSubAgent(id1, execFn, undefined, undefined, ac.signal);
		await sleep(2); // 让 id1 先拿到锁
		const p2 = dispatch.executeSubAgent(id2, execFn, undefined, undefined, ac.signal);
		await sleep(2); // 让 id2 进入排队
		ac.abort();
		const [r1, r2] = await Promise.all([p1, p2]);

		assert.strictEqual(r2.success, false);
		assert.strictEqual(r2.exitReason, 'interrupted');
		assert.ok(r2.error?.includes('write lock'), `错误信息应指明排队被取消，实得 ${r2.error}`);
		assert.strictEqual(started.length, 1, '被取消的排队者不得启动执行（不占 token / 不写文件）');
		assert.strictEqual(dispatch.getWriteLockStats().waiting, 0, '队列必须清空');
		assert.strictEqual(r1.exitReason, 'interrupted', '持锁者同时被父级取消');
	});

	test('★ 写者异常/失败也释放锁（后续写者不被永久阻塞）', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const failing = async function* (): AsyncIterable<IChatStreamDelta> {
			throw new Error('provider exploded');
		};
		const id1 = dispatch.createSubAgent('parent', 'writer fails', { type: GENERAL });
		const r1 = await dispatch.executeSubAgent(id1, failing);
		assert.strictEqual(r1.success, false);

		const probe = { inside: 0, max: 0 };
		const id2 = dispatch.createSubAgent('parent', 'writer 2', { type: GENERAL });
		const r2 = await dispatch.executeSubAgent(id2, makeProbe(probe, 1));
		assert.strictEqual(r2.success, true, '锁必须在失败路径释放，否则后续写者永久排队');
	});
});
