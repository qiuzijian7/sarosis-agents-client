/*---------------------------------------------------------------------------------------------
 *  codebaseGraphIndexProxy.test.ts — P2-1 Step 3「方案 B（worker 直连）」的**行为**测试。
 *
 *  为什么要有这一份（而不是只靠契约里的源码级断言 ⑨）：
 *    ⑨ 只能证明「文件里写了 createWorker / 常量名对得上」✗，证明不了三条**运行时**性质：
 *      ① **惰性**：构造代理本身不得起进程（否则"打开窗口就多一个进程"✗）；
 *      ② **只起一次**：`createWorker` 的文档写明同一窗口对同一 moduleId 重复调用会**终止前一个进程** ✗
 *         ⇒ 必须确认第二次调用没有重复 createWorker；
 *      ③ **失败不进缓存**：首次启动失败后，下一次调用必须能重试（否则一次瞬时失败永久固化 ✗✓）。
 *    这三条恰恰是本仓反复踩的类型（"静默失效" / "一次失败永久失败"），且**都可离线验证** ✓
 *    —— 真机验收要重载窗口才能做（dev 实例不重载就永远是旧码），所以先把能钉的钉住。
 *
 *  运行：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/test/browser/codebaseGraphIndexProxy.test.ts
 *
 *  ⚠ 不需要 jsdom：本测试只碰 ProxyChannel（纯 IPC 抽象，只依赖 base/common ✓）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import type { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import type { IUtilityProcessWorkerWorkbenchService } from '../../../../../workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { createCodebaseGraphIndexChannel } from '../../browser/codebaseGraphIndexProxy.js';
import { CODEBASE_GRAPH_INDEX_WORKER, ICodebaseGraphIndexChannel } from '../../common/codebaseGraphIndexChannel.js';

/** 让出几轮事件循环/宏任务 —— 用来证明「构造后**空转**也不得起进程」（只查同步是不够的 ✗）。 */
function idleTurns(ms = 20): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** 记录 createWorker 收到的参数 + 被请求的通道名 + 被调到的业务方法。 */
interface IHarness {
	channel: ICodebaseGraphIndexChannel;
	createWorkerCalls: () => number;
	requestedChannelNames: string[];
	createWorkerArgs: unknown[];
	canceledProjects: string[];
	/** 触发**当前** worker 的终止（`reason` 形状 = `{ code?, signal? }`；`undefined` = API 终止 ✓）。 */
	terminate: (reason?: { code?: number; signal?: string }) => void;
}

/**
 * 造一个「假的框架服务 + 真的 IPC 往返」的测试台：
 * 用**真实的** `ProxyChannel.fromService`（worker 侧）与代理内部的 `ProxyChannel.toService`（renderer 侧）
 * 配对 ⇒ 覆盖到真实的序列化路径，而不是自己模拟一层 ✗。
 */
function createHarness(opts: { failFirstCreateWorker?: boolean } = {}): IHarness {
	let calls = 0;
	const requestedChannelNames: string[] = [];
	const createWorkerArgs: unknown[] = [];
	const canceledProjects: string[] = [];
	/** 当前 worker 的终止 resolver（每个 worker 一个 ✓ —— 崩溃后重建会换新的 ✓）。 */
	let terminateCurrent: ((v: { reason: unknown }) => void) | undefined;

	// worker 侧的「服务本体」（对应 `codebaseGraphIndexWorkerMain.ts` 里的类，此处用等价实现）。
	const workerImpl: ICodebaseGraphIndexChannel = {
		runIndex: async request => ({
			success: true,
			kind: request.mode,
			message: 'ok',
			rootPath: request.rootPath,
			nodes: 7,
			edges: 3,
		}),
		cancel: async project => { canceledProjects.push(project); },
		isRunning: async () => true,
		getProgress: async () => ({ stage: '索引', message: '进行中' }),
	};
	const workerSideChannel = ProxyChannel.fromService(workerImpl, new DisposableStore());

	// ⚠ 必须把 worker 侧的 **IServerChannel** 包成 **IChannel** —— 生产里 `IPCClient.getChannel()`
	// 给 renderer 的就是后者（`call(command, arg)`，**没有 ctx 参数** ✓）。
	// 直接拿 IServerChannel 当 IChannel 用会发生**参数错位** ⇒ 宿主报 `Method not found: p`
	// （`p` 就是第一个业务参数 ✗）—— 实测踩过，别省这一步 ✓。
	const workerClientChannel: IChannel = {
		call: (command: string, arg?: unknown, cancellationToken?: never) => workerSideChannel.call(undefined, command, arg, cancellationToken),
		listen: (event: string, arg?: unknown) => workerSideChannel.listen(undefined, event, arg),
	};

	const fakeWorker = {
		client: {
			getChannel: (name: string) => {
				requestedChannelNames.push(name);
				return workerClientChannel;
			},
		},
		// 可触发终止（P0-2 测试用 ✓）：代理的 `worker.onDidTerminate.then(...)` 会收到 ✓
		onDidTerminate: new Promise<{ reason: unknown }>(resolve => { terminateCurrent = resolve; }),
		dispose: () => { /* 无需清理 */ },
	};

	const fakeService = {
		_serviceBrand: undefined,
		createWorker: async (arg: unknown) => {
			calls++;
			createWorkerArgs.push(arg);
			if (opts.failFirstCreateWorker && calls === 1) {
				throw new Error('模拟：入口模块缺失（out 里没有 codebaseGraphIndexWorkerMain.js）');
			}
			return fakeWorker;
		},
		notifyRestored: () => { /* noop */ },
	} as unknown as IUtilityProcessWorkerWorkbenchService;

	// 与生产接线一致：pass 一个 DisposableStore 让 worker 句柄有归属（窗口销毁时终止 ✓）。
	const channel = createCodebaseGraphIndexChannel(fakeService, undefined, new DisposableStore());
	return {
		channel, createWorkerCalls: () => calls, requestedChannelNames, createWorkerArgs, canceledProjects,
		terminate: reason => terminateCurrent?.({ reason }),
	};
}

suite('P2-1 索引代理（方案 B：worker 直连）', () => {

	test('★ 惰性：**构造代理本身不得起进程**（否则打开窗口就多一个 utility process ✗）', async () => {
		const h = createHarness();
		assert.strictEqual(h.createWorkerCalls(), 0, '构造阶段不得调用 createWorker');
		assert.strictEqual(h.requestedChannelNames.length, 0, '构造阶段不得取通道');

		// ⚠ 只查同步是**不够的**：`getDelayedChannel(getWorker().then(...))` 这种写法会「构造期求值 +
		// 让出一个微任务」⇒ 同步断言照样过，进程却已经起了 ✗（实测踩过）。所以这里必须空转事件循环再查 ✓。
		await idleTurns();
		assert.strictEqual(h.createWorkerCalls(), 0, '空转事件循环后仍不得起进程 —— 取通道必须是**函数式惰性**✗');
		assert.strictEqual(h.requestedChannelNames.length, 0, '空转后仍不得取通道');
	});

	test('★ 只起一次：同一窗口对同一 moduleId 重复 createWorker 会**终止前一个进程** ⇒ 必须复用', async () => {
		const h = createHarness();
		assert.strictEqual(await h.channel.isRunning('p'), true);
		assert.strictEqual(h.createWorkerCalls(), 1, '首次调用应起进程');
		assert.strictEqual(await h.channel.isRunning('p'), true);
		assert.strictEqual(h.createWorkerCalls(), 1, '再次调用必须复用（否则前一个进程被终止 ✗）');
	});

	test('★ 四条方法都经真实 IPC 往返（返回值/参数不可丢）', async () => {
		const h = createHarness();
		const result = await h.channel.runIndex({
			rootPath: 'g:\\repo', project: 'repo', mode: 'incremental',
			changeSet: { added: ['a.ts'], modified: [], deleted: [] },
		});
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.kind, 'incremental', 'mode 必须经 IPC 往返不变');
		assert.strictEqual(result.rootPath, 'g:\\repo');
		assert.strictEqual(result.nodes, 7, '数值结果必须回来（漏转发会得到 undefined ✗）');

		await h.channel.cancel('proj-x');
		assert.deepStrictEqual(h.canceledProjects, ['proj-x'], 'cancel 的 project 参数必须送达');

		const progress = await h.channel.getProgress('proj-x');
		assert.strictEqual(progress?.stage, '索引', 'getProgress 是**轮询式**的唯一进度来源 ✓');
	});

	test('★ 取通道用的是**契约里的**通道名（两边各写字符串 ⇒ 漂移后静默拿到 undefined ✗）', async () => {
		const h = createHarness();
		await h.channel.isRunning('p');
		assert.deepStrictEqual(h.requestedChannelNames, [CODEBASE_GRAPH_INDEX_WORKER.channel]);
	});

	test('★ createWorker 的参数同样来自契约常量（moduleId / type / name 都不得硬编码 ✗）', async () => {
		const h = createHarness();
		await h.channel.isRunning('p');
		assert.deepStrictEqual(h.createWorkerArgs, [{
			moduleId: CODEBASE_GRAPH_INDEX_WORKER.moduleId,
			type: CODEBASE_GRAPH_INDEX_WORKER.type,
			name: CODEBASE_GRAPH_INDEX_WORKER.name,
		}]);
		assert.strictEqual(CODEBASE_GRAPH_INDEX_WORKER.moduleId,
			'vs/sessions/contrib/agentStudio/node/codebaseGraphIndexWorkerMain',
			'moduleId 必须是 out 里真实存在的入口模块路径（无 .js ✓）');
	});

	test('★★ 失败不进缓存：首次启动失败后**下一次调用必须能重试**（否则一次瞬时失败永久固化 ✗✓）', async () => {
		const h = createHarness({ failFirstCreateWorker: true });
		await assert.rejects(() => h.channel.isRunning('p'), /入口模块缺失/,
			'首次调用应把失败**抛出**（不得静默返回 false —— 那会被读成"没在跑"✗）');
		assert.strictEqual(h.createWorkerCalls(), 1);

		// 关键：缓存必须已清空 ⇒ 这次会**重新** createWorker 并成功。
		assert.strictEqual(await h.channel.isRunning('p'), true, '重试必须成功（promise 缓存未清空则这里会立刻再抛 ✗）');
		assert.strictEqual(h.createWorkerCalls(), 2, '重试应再次调用 createWorker');
	});

	// ── ★★★ P0-2（2026-09-19）：worker 父侧监督 —— 崩溃分类 + 清缓存重启 + 退避 ──

	test('★★★ 崩溃 ⇒ **清缓存**：下次调用必须重新起进程（Step 3 的"下次会重新拉起"必须真的成立 ✓✓）', async () => {
		const h = createHarness();
		assert.strictEqual(await h.channel.isRunning('p'), true);
		assert.strictEqual(h.createWorkerCalls(), 1);

		// 崩溃（非零退出码）⇒ 代理必须**清掉缓存**，否则下次调用拿到的是死 worker ✗✗。
		h.terminate({ code: 1 });
		await idleTurns();  // 让 onDidTerminate 的回调跑到 ✓

		assert.strictEqual(await h.channel.isRunning('p'), true, '崩溃后下次调用必须能**重新拉起**并工作 ✓✓');
		assert.strictEqual(h.createWorkerCalls(), 2, '崩溃后应**重新** createWorker（缓存已清 ✓）');
	});

	test('★ 正常退出 / API 终止 ⇒ 也清缓存（但**不计**崩溃 ⇒ 不退避 ✓）', async () => {
		const h = createHarness();
		await h.channel.isRunning('p');
		assert.strictEqual(h.createWorkerCalls(), 1);

		h.terminate(undefined);  // API 终止（dispose/窗口关闭 ✓）
		await idleTurns();

		assert.strictEqual(await h.channel.isRunning('p'), true, '正常终止后下次调用应能重启 ✓');
		assert.strictEqual(h.createWorkerCalls(), 2);
	});

	test('★ 退避：崩溃后**立刻**调用 ⇒ 不会立刻重启（不 crash-loop ✗✓）', async () => {
		const h = createHarness();
		await h.channel.isRunning('p');
		assert.strictEqual(h.createWorkerCalls(), 1);

		h.terminate({ signal: 'SIGSEGV' });  // 崩溃 ✗
		await idleTurns();

		// 立刻发起调用：退避生效 ⇒ **此刻不得** createWorker（重启被推迟 ✓）
		const pending = h.channel.isRunning('p');  // 不 await —— 只查它**有没有立刻**起进程
		await idleTurns(30);
		assert.strictEqual(h.createWorkerCalls(), 1, '退避期内不得立刻重启（否则会 crash-loop ✗✗）');
		// 别把这个挂起的调用留到套件外 ✓
		await pending.catch(() => undefined);
	});
});
