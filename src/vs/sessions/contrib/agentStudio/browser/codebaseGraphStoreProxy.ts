/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * renderer 侧代理：把 `ICodebaseGraphSqliteBackend` 调用经 `mainProcessService` 的
 * `CODEBASE_GRAPH_STORE_CHANNEL` 透明转发到 main 进程内的 `CodebaseGraphStoreChannel`。
 *
 * 使用 VS Code 内置 `ProxyChannel.toService`：方法调用 → `channel.call(method, args)`，
 * 返回值经 IPC 反序列化。renderer 无需感知 SQLite / 原生模块（sandbox 安全）。
 *
 * ★★★ 2026-10-22：**每次调用都带超时 + 熔断**（"dev 整个 app 卡死"的最后一道保险）。
 *
 * 现场与理由见 `common/codebaseGraphStoreTimeout.ts` 的文件头（一句话版）：主进程在 SQLite 上
 * 阻塞时**连错误都发不回来** ⇒ 只有 renderer 自己到点放弃，才能把"静默僵死"变成"本次失败 + 可见日志"。
 *
 * 两条设计约束：
 *   ① **超时 = 拒绝**（不静默重试）：调用方（`_catchUpSqlite` 等）已有 catch + 日志 ⇒ 能自愈；
 *   ② **熔断**：一旦某次调用超时，后续调用**立即失败**（不再排队等一个同样会卡住的主进程）——
 *      否则会在渲染侧堆出一串永远 pending 的 promise（内存涨 + 永远等不到 ✗）。
 */

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { CODEBASE_GRAPH_STORE_CHANNEL, ICodebaseGraphSqliteBackend } from '../common/codebaseGraphStoreChannel.js';
import { DEFAULT_SQLITE_BACKEND_TIMEOUT_MS, withSqliteBackendTimeout } from '../common/codebaseGraphStoreTimeout.js';

/** 创建一个经主进程代理的 SQLite 后端（renderer 侧唯一入口）。 */
export function createCodebaseGraphSqliteBackend(
	mainProcessService: IMainProcessService,
	opts?: { timeoutMs?: number },
): ICodebaseGraphSqliteBackend {
	const raw = ProxyChannel.toService<ICodebaseGraphSqliteBackend>(mainProcessService.getChannel(CODEBASE_GRAPH_STORE_CHANNEL));
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_SQLITE_BACKEND_TIMEOUT_MS;
	// 熔断标志：一旦有调用超时，后续调用**立即**失败（主进程那侧已经不可信 ⇒ 别再排队等它 ✗）
	let broken = false;
	let brokenReason: string | undefined;
	return new Proxy(raw, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function') {
				return value;
			}
			const method = String(prop);
			return (...args: unknown[]) => {
				if (broken) {
					return Promise.reject(new Error(brokenReason ?? `SQLite 后端已熔断（${method} 不可用）`));
				}
				return withSqliteBackendTimeout(method, () => Promise.resolve(value.apply(target, args)), timeoutMs)
					.catch(err => {
						if (err instanceof Error && err.message.startsWith('SQLite 后端调用超时')) {
							broken = true;
							brokenReason = err.message;
						}
						throw err;
					});
			};
		},
	});
}
