/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 代码图谱 SQLite 后端（renderer ↔ main）的**调用超时**工具（纯函数，无运行时依赖 ⇒ 可直接测）。
 *
 * ★★★ 2026-10-22（用户报"dev 整个 app 卡死"）：为什么需要这一层？
 *
 * 现场取证（2026-10-22 15:11）：代码图谱的一次"全量追平"把 **401,027 节点 + 1,247,209 边**写进
 * 主进程 SQLite（耗时 **551,936ms ≈ 9.2 分钟**），WAL 涨到 **1.2GB**（`wal_autocheckpoint=0` 是既定设置），
 * 写完后主进程**主线程阻塞**：0% CPU、65 个线程全在 Wait、inspector 5875 连得上但**任何命令都超时**、
 * 渲染端 9335 的 HTTP 端点直接不通 ⇒ 主进程僵 ⇒ 渲染进程的 IPC **永不返回** ⇒ **整个 app 无响应**，
 * 且**不会自愈**（SQLite 在等锁时**不回调**，`busy_timeout` 只覆盖 SQLITE_BUSY，不覆盖 checkpoint 的阻塞等待）。
 *
 * 关键点：主线程被堵住时，**连"报错"都发不回来**（IPC 的 reply 要主线程来跑）⇒ 只有**调用方自己
 * 到点放弃**，才能把"整个 app 静默僵死"降级成"本次操作失败 + 可见的日志" ✗✗。
 */

/**
 * 单次 SQLite 后端调用的默认超时（毫秒）。
 *
 * 取值依据：一次合法的大批量写（实测 5 万条边 ≈ 8s）要留足余量；但**必须远小于**"用户以为死机"
 * 的阈值（60s+）。120s ⇒ 一个挂死的调用最多拖一分钟就被打断（而不是永远）。
 * ⚠ 不要调得太紧：大库上全量追平的一批 upsert 可能十几秒。
 */
export const DEFAULT_SQLITE_BACKEND_TIMEOUT_MS = 120_000;

/** 超时（或熔断）后的统一报错文案（调用方据此识别"主进程那侧卡住了"）。 */
export function sqliteBackendTimeoutError(method: string, timeoutMs: number): Error {
	return new Error(`SQLite 后端调用超时（${timeoutMs}ms）：${method} —— 主进程可能卡在 SQLite（WAL/锁）上；`
		+ `本次操作已放弃（后续调用会直接失败，直到主进程恢复）`);
}

/**
 * 给一个 promise 加超时（超时 ⇒ reject）。
 *
 * ⚠ 超时**不取消**底层操作（IPC 取消不了已在主进程跑的语句）⇒ 这里只保证**调用方不再等**。
 *
 * @param label 出错时要指名的操作（如 `upsertEdgesBatch`）
 * @param fn 真正发起的调用
 * @param timeoutMs 超时毫秒
 */
export function withSqliteBackendTimeout<T>(label: string, fn: () => Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) { return; }
			settled = true;
			reject(sqliteBackendTimeoutError(label, timeoutMs));
		}, timeoutMs);
		fn().then(
			v => { if (settled) { return; } settled = true; clearTimeout(timer); resolve(v); },
			e => { if (settled) { return; } settled = true; clearTimeout(timer); reject(e); },
		);
	});
}
