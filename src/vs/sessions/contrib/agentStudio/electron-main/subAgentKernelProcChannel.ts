/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 子代理内核进程档的主进程宿主（P1）：renderer 经 `SUBAGENT_KERNEL_PROC_CHANNEL`
 * 要求 fork/dispose/转发，本通道为每个 clientId 持有一个 Electron `utilityProcess`
 * （跑 piLoop 内核的隔离体；协议见 piLoop/proc/kernelProcProtocol.ts）。
 *
 * 入口路径：`<appPath>/out/vs/sessions/contrib/agentStudio/browser/piLoop/proc/
 * kernelProcWorkerEntry.js`（dev = 仓内 transpile 产物；打包布局的解析在 P1 后续
 * 硬化 —— 当前若产物缺失，start 返回明确错误，renderer 回落进程内档）。
 *
 * 安全面：本通道只搬消息字节 —— 工具执行/审批/凭证全在 renderer 侧的真宿主
 * （kernel 经 RPC 代理回来），子进程无任何额外权限。
 */

import { app } from 'electron';
import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { isProcExitMarker, type IProcClientRef, type IProcPostArg } from '../common/subAgentKernelProcChannel.js';

const KERNEL_ENTRY_REL = 'out/vs/sessions/contrib/agentStudio/browser/piLoop/proc/kernelProcWorkerEntry.js';

interface IChildSlot {
	readonly proc: UtilityProcess;
	/** 首个 events 监听就位前的消息缓冲（防 IPC 往返时差丢消息）。 */
	backlog: unknown[];
	listenerAttached: boolean;
	readonly emitter: Emitter<unknown>;
}

export class SubAgentKernelProcChannel<TContext> extends Disposable implements IServerChannel<TContext> {

	private readonly _children = new Map<string, IChildSlot>();

	constructor(
		private readonly _logService: ILogService,
	) {
		super();
	}

	listen<T>(_ctx: TContext, event: string, arg?: any): Event<T> {
		if (event !== 'events') { throw new Error(`[SubAgentKernelProc] unknown listen event: ${event}`); }
		const { clientId } = (arg ?? {}) as IProcClientRef;
		const slot = this._children.get(clientId);
		if (!slot) { throw new Error(`[SubAgentKernelProc] listen before start: ${clientId}`); }
		slot.listenerAttached = true;
		// flush 缓冲
		for (const m of slot.backlog.splice(0)) { slot.emitter.fire(m); }
		return slot.emitter.event as Event<T>;
	}

	async call(_ctx: TContext, command: string, arg?: any): Promise<any> {
		switch (command) {
			case 'start': return this._start((arg ?? {}) as IProcClientRef);
			case 'post': return this._post(arg as IProcPostArg);
			case 'dispose': return this._dispose((arg ?? {}) as IProcClientRef);
			default: throw new Error(`[SubAgentKernelProc] unknown command: ${command}`);
		}
	}

	private _start({ clientId }: IProcClientRef): void {
		if (this._children.has(clientId)) {
			throw new Error(`[SubAgentKernelProc] duplicate start for ${clientId}`);
		}
		const entry = join(app.getAppPath(), KERNEL_ENTRY_REL);
		if (!existsSync(entry)) {
			throw new Error(`[SubAgentKernelProc] 内核入口不存在：${entry}（dev 需先 npm run transpile-client）`);
		}
		const child = utilityProcess.fork(entry, [], { stdio: ['ignore', 'pipe', 'pipe'] });
		const emitter = new Emitter<unknown>();
		const slot: IChildSlot = { proc: child, backlog: [], listenerAttached: false, emitter };
		this._children.set(clientId, slot);

		child.on('message', (msg: unknown) => {
			if (slot.listenerAttached) { slot.emitter.fire(msg); } else { slot.backlog.push(msg); }
		});
		child.on('exit', (code: number) => {
			const marker = { __procExit: `code=${code}` };
			if (slot.listenerAttached) { slot.emitter.fire(marker); } else { slot.backlog.push(marker); }
			this._children.delete(clientId);
		});
		child.stderr?.on('data', (d: Buffer) => {
			this._logService.warn(`[SubAgentKernelProc][child-stderr] ${String(d).trim().slice(0, 400)}`);
		});
		this._logService.info(`[SubAgentKernelProc] forked kernel proc (clientId=${clientId})`);
	}

	private _post({ clientId, msg }: IProcPostArg): void {
		const slot = this._children.get(clientId);
		if (!slot) { throw new Error(`[SubAgentKernelProc] post to unknown client: ${clientId}`); }
		if (isProcExitMarker(msg)) { return; } // 防御：renderer 不应伪造退出标记
		slot.proc.postMessage(msg);
	}

	private _dispose({ clientId }: IProcClientRef): void {
		const slot = this._children.get(clientId);
		if (!slot) { return; } // 幂等
		this._children.delete(clientId);
		try { slot.proc.kill(); } catch { /* 已退出 */ }
		slot.emitter.dispose();
	}

	override dispose(): void {
		for (const clientId of [...this._children.keys()]) {
			this._dispose({ clientId });
		}
		super.dispose();
	}
}
