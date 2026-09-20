/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * renderer 侧的进程隔离传输：经 `SUBAGENT_KERNEL_PROC_CHANNEL` 让主进程 fork
 * utilityProcess（renderer 无权直接 fork），把通道消息桥成 `IKernelProcTransport`。
 * 与 worker_threads 传输同一协议（kernelProcProtocol.ts）——内核无感知。
 */

import { generateUuid } from '../../../../../../base/common/uuid.js';
import type { IMainProcessService } from '../../../../../../platform/ipc/common/mainProcessService.js';
import { isProcExitMarker, SUBAGENT_KERNEL_PROC_CHANNEL } from '../../../common/subAgentKernelProcChannel.js';
import type { IKernelProcTransport, KernelProcTransportFactory } from './kernelProcTransport.js';

export function createIpcProcTransportFactory(mainProcessService: IMainProcessService): KernelProcTransportFactory {
	return async () => {
		const channel = mainProcessService.getChannel(SUBAGENT_KERNEL_PROC_CHANNEL);
		const clientId = generateUuid();
		// 顺序：先 start（主进程 fork 并对消息做缓冲），再挂 events 监听（挂上即 flush）——
		// 主进程侧 listen-before-start 是错误，本顺序同时避开 IPC 往返时差丢消息。
		await channel.call<void>('start', { clientId });

		const events = channel.listen<unknown>('events', { clientId });
		const msgCbs: Array<(msg: never) => void> = [];
		const exitCbs: Array<(info: string) => void> = [];
		const sub = events(e => {
			if (isProcExitMarker(e)) {
				for (const cb of exitCbs) { cb(e.__procExit); }
			} else {
				for (const cb of msgCbs) { cb(e as never); }
			}
		});

		const transport: IKernelProcTransport = {
			post: msg => { void channel.call('post', { clientId, msg }); },
			onMessage: cb => { msgCbs.push(cb); },
			onExit: cb => { exitCbs.push(cb); },
			dispose: async () => {
				sub.dispose();
				try { await channel.call('dispose', { clientId }); } catch { /* 主进程侧幂等 */ }
			},
		};
		return transport;
	};
}
