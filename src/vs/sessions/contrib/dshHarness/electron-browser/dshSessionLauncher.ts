/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `dshSessionLauncher` 的宿主实现（方案 5.15 / 7.6 的统一新建会话入口）。
 *
 * 通过 `setDshSessionLauncher` 注入到 `src/vs/sessions/common` 的中立层钩子，
 * 让 browser 层的 IDE 后台入口（知识库构建、渠道 / 看板 / 调度 / Pocket 等）能经控制桥
 * `session.start` / `session.run` 起会话，**不再走 IDE 的 `IAgentChatService.sendMessage`**。
 *
 * ⚠ 不在这里重做桥协议：三个桥方法、主进程通道与 `IDshHarnessService` 的包装都已存在。
 *   cwd 解析 / 会话 id 派生 / 入参拼装是纯逻辑，抽在 `common/dshSessionLauncherCore.ts`
 *   （可在纯 node 单测里验证）；本文件只负责 DI 接线、注册与结果收敛。
 */

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import {
	IDshBackgroundTurnOptions, IDshBackgroundTurnResult,
	IDshSessionLaunchOptions, IDshSessionLaunchResult, IDshSessionLauncher,
	setDshSessionLauncher,
} from '../../../common/dshSessionLauncher.js';
import { resolveLaunchCwd, toSessionRunArgs, toSessionStartArgs } from '../common/dshSessionLauncherCore.js';
import { IDshHarnessService } from './dshHarnessService.js';

export class DshSessionLauncherContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.dshHarness.sessionLauncher';

	constructor(
		@IDshHarnessService private readonly dsh: IDshHarnessService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		const impl: IDshSessionLauncher = {
			start: options => this._start(options),
			runTurn: options => this._runTurn(options),
		};
		setDshSessionLauncher(impl);
		this._register(toDisposable(() => setDshSessionLauncher(undefined)));
	}

	private _cwd(): string {
		return resolveLaunchCwd(this.workspace.getWorkspace().folders);
	}

	private async _start(options: IDshSessionLaunchOptions): Promise<IDshSessionLaunchResult> {
		return this.dsh.startSession(toSessionStartArgs(this._cwd(), options));
	}

	private async _runTurn(options: IDshBackgroundTurnOptions): Promise<IDshBackgroundTurnResult> {
		if (options.signal?.aborted) { throw new Error('后台回合已取消（signal 在启动前就 aborted）'); }
		let args = toSessionRunArgs(this._cwd(), options);
		// ★ 有取消需求但没显式会话 id 时，先自己铸一个确定性 id：
		//   桥侧分配的 id 要等 runSession 返回才拿得到，那时回合已经结束、取消无意义。
		if (options.signal && !args.sessionId) {
			args = { ...args, sessionId: `vssaros-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
		}
		const onAbort = () => {
			if (args.sessionId) {
				void this.dsh.cancelSession({ sessionId: args.sessionId }).catch(() => undefined);
			}
		};
		options.signal?.addEventListener('abort', onAbort, { once: true });
		try {
			const result = await this.dsh.runSession(args);
			return {
				sessionId: result.sessionId,
				finalText: result.finalText,
				stopReason: result.stopReason,
				interrupted: result.interrupted,
				elapsedMs: result.elapsedMs,
			};
		} finally {
			options.signal?.removeEventListener('abort', onAbort);
		}
	}
}
