/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * renderer 侧代理：把 `ICodebaseGraphIndexChannel` 的调用交给 **索引 utility process**
 * （P2-1 Phase 1 目标：把索引编排移出 renderer 主线程 ✓）。
 *
 * ## ★ 2026-09-19（Step 3）：改为 **worker 直连**（契约 header 的「方案 B」✓）
 *
 * 原实现是 `mainProcessService.getChannel(CODEBASE_GRAPH_INDEX_CHANNEL)` → main 进程宿主。
 * 但 main 侧 `createWorker` 是「**服务某个窗口请求的服务端**」（参数含 `reply.windowId`，返回值只有
 * **终止信息**，**不提供 client channel** ✗）⇒ 主进程**无法**替 renderer 起一个可对话的 worker。
 *
 * 框架既定的客户端用法是 **renderer 自己起**，与
 * `workbench/services/files/electron-browser/watcherClient.ts:36` 一致 ✓：
 * ```ts
 * const { client } = await utilityProcessWorkerWorkbenchService.createWorker({ moduleId, type, name });
 * const channel = client.getChannel('index');            // ← IChannel（无 ctx 参数）
 * return ProxyChannel.toService<ICodebaseGraphIndexChannel>(channel);   // ← 同步返回 ✓
 * ```
 * ⇒ 随之删除 main 宿主与 `app.ts` 的注册（否则是死代码 ✗）。
 *
 * ## ★★★ 两个「看起来对、实测全挂」的写法（都踩过，勿回退 ✗✗）
 *
 * ### 坑 1：**不能**把 `toService` 的代理从 async 函数里 return
 *
 * `ProxyChannel.toService` 返回的是 **Proxy**，它的 `get` 陷阱对**任意**字符串键都返回一个函数 ——
 * **包括 `then`** ✗。一旦它被 **Promise 的决议过程**碰到（如 `async () => toService(...)`），
 * JS 会把它当 **thenable 采纳** ⇒ 调 `proxy.then(resolve, reject)` ⇒ 命中 `channel.call('then', …)`
 * ⇒ 宿主抛 `Method not found: then`（`ipc.ts:1212`）⇒ 而 `then` 的返回值**没人看** ✗
 * ⇒ **外层 promise 永不结算** ✓✓（表现：所有调用**永久挂起**，不报错、不超时 ✓）。
 * ⇒ 本工厂**同步**返回；取通道这一步用「延迟通道」包住 ✓（`watcherClient` 同理）。
 *
 * ### 坑 2：**不能**在构造期调用 `getWorker()`（哪怕只是 `.then(...)`）
 *
 * `getDelayedChannel(getWorker().then(...))` 看着很自然，但 `getWorker()` 是**立即求值**的 ✗
 * ⇒ ①**惰性失效**（打开窗口就起进程，正是本设计的反面 ✗）；
 * ②启动失败会变成**无人处理的 rejection** ✗（真机表现：窗口一开就报未处理错误 / 后续永久挂起）。
 * ⇒ 本文件的取通道写成**函数**（`getChannel()`），只在**第一次方法调用**时才真跑 ✓。
 * ⚠ 回归测试 `test/browser/codebaseGraphIndexProxy.test.ts` 同时钉住这两条：构造后**空转若干轮事件循环**
 * 也必须 0 次 `createWorker`；且任何调用必须在 10s 内返回（挂起会超时 ✗）。
 *
 * ## 另外三条必须保持的性质
 *
 * 1. **失败不进缓存**（照抄 store 宿主的 `_opened` 诀窍 ✓）：启动失败时清空 promise，让下次调用能重试；
 *    否则一次瞬时失败（如 out 里缺入口）会让后续**全部**调用立刻失败 ✗✓。
 *    ⚠ 同时这也是**正确性**要求：`createWorker` 的文档写明「同一窗口对同一 `moduleId` 重复调用会
 *    终止前一个进程」⇒ 必须只建一次 ✗✓。
 * 2. **进度是轮询式**（`getProgress`）：`ProxyChannel` 只做请求/响应，**不支持服务端推送** ✗
 *    （契约注释里记着这条：原草案的回调式 `onProgress` 无法被诚实实现 ⇒ 已改轮询 ✓）。
 * 3. worker 非正常退出必须**响亮**（本仓反复踩过"静默"✗）。
 */

import { Event, Relay } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { ILogService } from '../../../../platform/log/common/log.js';
import type { IUtilityProcessWorker, IUtilityProcessWorkerWorkbenchService } from '../../../../workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import type { IUtilityProcessWorkerProcessExit } from '../../../../platform/utilityProcess/common/utilityProcessWorkerService.js';
import { CODEBASE_GRAPH_INDEX_WORKER, ICodebaseGraphIndexChannel } from '../common/codebaseGraphIndexChannel.js';

/**
 * 创建一个「直连索引 worker」的通道（renderer 侧唯一入口）。
 *
 * @param utilityProcessWorkerWorkbenchService 起进程的框架服务（DI 注入；两个 renderer 入口都已注册 ✓）。
 * @param logService 可选：用于报告 worker 的**非正常退出**（不静默 ✗）。
 * @param disposables 可选：把 worker 句柄登记进去，窗口销毁时随之终止（缺省则由框架在窗口关闭/重载时终止 ✓）。
 */
export function createCodebaseGraphIndexChannel(
	utilityProcessWorkerWorkbenchService: IUtilityProcessWorkerWorkbenchService,
	logService?: ILogService,
	disposables?: DisposableStore,
): ICodebaseGraphIndexChannel {

	let workerPromise: Promise<IUtilityProcessWorker> | undefined;
	// ⚠ 必须先声明（`getWorker` 的终止回调会清它 ✓；`let` 先声明后闭包引用才不踩 TDZ ✗）。
	let channelPromise: Promise<IChannel> | undefined;

	// ★★★ P0-2（2026-09-19）：worker **父侧监督** —— 崩溃分类 + 退避重启（对齐外部引擎的 index_supervisor ✓）。
	/** 连续**非正常**终止次数（正常退出 / API 终止会归零 ✓）。 */
	let crashStreak = 0;
	/** 退避：到点之前**不再**起进程（防 crash-loop ✗✓）。 */
	let notBefore = 0;
	const BACKOFF_BASE_MS = 1500;
	const BACKOFF_CAP_MS = 8000;

	/** 把终止原因**分类**（供日志与退避判定 ✓）。`undefined` = 经 API（dispose/窗口关闭）正常终止 ✓。 */
	const classifyTermination = (reason: IUtilityProcessWorkerProcessExit | undefined): { text: string; crash: boolean } => {
		if (!reason) { return { text: 'API 终止（dispose/窗口关闭）', crash: false }; }
		if (reason.code === 0) { return { text: '正常退出（code=0）', crash: false }; }
		if (reason.signal) { return { text: `崩溃（signal=${reason.signal}）`, crash: true }; }
		return { text: `非零退出（code=${reason.code}）`, crash: true };
	};

	const getWorker = (): Promise<IUtilityProcessWorker> => {
		if (!workerPromise) {
			workerPromise = (async () => {
				// ★ P0-2 退避：连续崩溃 ⇒ 每次重启间隔指数拉长（1500→3000→6000→封顶 8000 ✗ 不 crash-loop ✓）。
				const wait = notBefore - Date.now();
				if (wait > 0) {
					logService?.info('[CodebaseGraph]', `[index-worker] 连续崩溃 ${crashStreak} 次 ⇒ 退避 ${wait}ms 后重启 ✓`);
					await new Promise<void>(r => setTimeout(r, wait));
				}
				const worker = await utilityProcessWorkerWorkbenchService.createWorker({
					moduleId: CODEBASE_GRAPH_INDEX_WORKER.moduleId,
					type: CODEBASE_GRAPH_INDEX_WORKER.type,
					name: CODEBASE_GRAPH_INDEX_WORKER.name,
				});
				disposables?.add(worker);

				// ★★ P0-2 **关键修复**（Step 3 的 bug）：进程死了 ⇒ **清缓存** —— 否则后续调用会拿到一个
				//   **死 worker** ✗✗（Step 3 注释写「下次调用会重新拉起 ✓」，但**没人清缓存** ⇒
				//   崩溃之后所有调用都打向死进程、表现为"索引无声地不再工作" ✗✗）。
				worker.onDidTerminate.then(({ reason }) => {
					workerPromise = undefined;
					channelPromise = undefined;
					const cls = classifyTermination(reason);
					if (cls.crash) {
						crashStreak++;
						notBefore = Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (crashStreak - 1), BACKOFF_CAP_MS);
						// 非正常退出必须**响亮**（本仓反复踩过"静默"✗）。
						logService?.warn('[CodebaseGraph]', `[index-worker] 索引进程${cls.text}（连续崩溃 ${crashStreak} 次；下次调用会重新拉起 ✓，退避已生效 ✓）`);
					} else {
						crashStreak = 0;
						notBefore = 0;
						logService?.trace('[CodebaseGraph]', `[index-worker] 索引进程${cls.text}`);
					}
				});

				return worker;
			})().catch(err => {
				// ★ 失败不进缓存：否则一次失败会永久固化 ✗✓
				workerPromise = undefined;
				throw err;
			});
		}
		return workerPromise;
	};

	/**
	 * ★ **惰性取通道**：写成函数（而不是在构造期求值的 promise）——
	 * 只有**第一次调用方法**时才会走到这里 ⇒ 构造代理零成本、也不起进程 ✓（见文件头「坑 2」）。
	 * （⚠ `channelPromise` 的声明在 `getWorker` 之前 —— 终止回调要清它 ⇒ 必须先声明 ✓。）
	 */
	const getChannel = (): Promise<IChannel> => {
		if (!channelPromise) {
			channelPromise = getWorker()
				.then(worker => worker.client.getChannel(CODEBASE_GRAPH_INDEX_WORKER.channel))
				.catch(err => {
					// 取通道失败同样要能重试（与 worker 启动失败同一条纪律 ✓）
					channelPromise = undefined;
					throw err;
				});
		}
		return channelPromise;
	};

	// 延迟通道：形状与 `getDelayedChannel(...)` 相同（`call` 把工作推到首次调用 ✓），
	// 但**promise 本身也是惰性创建的** —— 这一点 `getDelayedChannel` 做不到（它要求传入已建好的 promise ✗）。
	const delayedChannel: IChannel = {
		call: (command, arg, cancellationToken) => getChannel().then(c => c.call(command, arg, cancellationToken)),
		// ⚠ 必须写成**泛型函数**：`IChannel.listen<T>(event, arg?): Event<T>` 是泛型签名，
		// 写成 `(event, arg) => Event<unknown>` 会 TS2322（`T` 无法由 `unknown` 满足）✗ —— 实测报过。
		listen: <T>(event: string, arg?: unknown): Event<T> => {
			// 本服务**没有事件**（进度是轮询式 ✓）⇒ 这里只是把 `IChannel` 的形状补完整。
			const relay = new Relay<T>();
			void getChannel().then(
				c => { relay.input = c.listen<T>(event, arg); },
				() => { /* 通道未接通 ⇒ 无事件可推（调用方此时也该收到 call 的 rejection ✓） */ },
			);
			return relay.event;
		},
	};

	// ★ **同步**返回 —— 绝不能改成 async 包装（then 陷阱 ⇒ 所有调用永久挂起 ✗✗，见文件头「坑 1」）。
	return ProxyChannel.toService<ICodebaseGraphIndexChannel>(delayedChannel);
}
