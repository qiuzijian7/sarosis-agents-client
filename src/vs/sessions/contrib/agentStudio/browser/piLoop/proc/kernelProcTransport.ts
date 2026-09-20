/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内核隔离体的传输缝（P1）。协议（kernelProcProtocol.ts）不随传输变。
 *
 * 父侧两种实现：
 *   · `workerThreadsTransportFactory` —— node worker_threads（测试/脚本可达）；
 *   · `utilityProcessTransportFactory` —— Electron `utilityProcess.fork`（生产；
 *     仅主进程可调，renderer 经 IPC 转发 —— 见 P1 接线注释）。
 * 子侧（隔离体内）：`detectChildPort()` 自动识别 worker_threads.parentPort /
 * utilityProcess 的 process.parentPort。
 *
 * 消息形状差异已内化：worker_threads 直传消息体；utilityProcess 包一层
 * `{ data }` 事件 —— onMessage 统一剥壳。
 */

/** 父侧传输句柄。 */
export interface IKernelProcTransport {
	post(msg: unknown): void;
	onMessage(cb: (msg: never) => void): void;
	/** 隔离体过早退出（崩溃/被杀）。 */
	onExit(cb: (info: string) => void): void;
	dispose(): Promise<void> | void;
}

export type KernelProcTransportFactory = () => Promise<IKernelProcTransport> | IKernelProcTransport;

/** worker_threads 传输（父侧）。 */
export function workerThreadsTransportFactory(entryUrl: URL): KernelProcTransportFactory {
	return async () => {
		const { Worker } = await import('node:worker_threads');
		const worker = new Worker(entryUrl);
		return {
			post: msg => worker.postMessage(msg),
			onMessage: cb => worker.on('message', cb as (m: unknown) => void),
			onExit: cb => worker.on('exit', code => cb(`code=${code}`)),
			dispose: () => { worker.removeAllListeners(); return worker.terminate().then(() => undefined); },
		};
	};
}

/**
 * utilityProcess 传输（父侧，仅 Electron 主进程）。
 * 延迟 import electron —— 本模块在 node 测试里也可加载（该工厂不被调用即可）。
 */
export function utilityProcessTransportFactory(entryPath: string): KernelProcTransportFactory {
	return async () => {
		const { utilityProcess } = await import('electron');
		const child = utilityProcess.fork(entryPath, [], { stdio: ['ignore', 'pipe', 'pipe'] });
		// 子进程 stdout/stderr 打到主进程日志（排障用；协议消息走 message 通道不受影响）
		child.stdout?.on('data', () => { /* 静默：协议在 message 通道 */ });
		child.stderr?.on('data', () => { /* 静默 */ });
		return {
			post: msg => child.postMessage(msg),
			onMessage: cb => child.on('message', (e: unknown) => {
				// Electron utilityProcess 的 message 事件直接就是载荷（不包 data）
				cb(e as never);
			}),
			onExit: cb => child.on('exit', (code: number) => cb(`code=${code}`)),
			dispose: () => { child.kill(); },
		};
	};
}

/** 子侧端口形状（两种运行时共有的最小面）。 */
export interface IChildProcPort {
	postMessage(msg: unknown): void;
	on(event: 'message', cb: (msg: unknown) => void): void;
}

/**
 * 子侧端口探测：worker_threads ⇒ `parentPort`；utilityProcess ⇒ `process.parentPort`。
 * utilityProcess 的消息事件载荷为 `{ data }` 包装 ⇒ 统一剥壳。
 */
export async function detectChildPort(): Promise<IChildProcPort> {
	// utilityProcess 子进程：process.parentPort 存在（Electron 注入）
	const proc = process as unknown as { parentPort?: { postMessage(m: unknown): void; on(ev: string, cb: (e: { data: unknown }) => void): void } };
	if (proc.parentPort) {
		const pp = proc.parentPort;
		return {
			postMessage: msg => pp.postMessage(msg),
			on: (_ev, cb) => pp.on('message', (e: { data: unknown }) => cb(e && typeof e === 'object' && 'data' in e ? e.data : e)),
		};
	}
	const wt = await import('node:worker_threads');
	if (wt.parentPort) {
		return wt.parentPort;
	}
	throw new Error('[proc] 不在任何受支持的隔离体内（需要 worker_threads 或 Electron utilityProcess）');
}
