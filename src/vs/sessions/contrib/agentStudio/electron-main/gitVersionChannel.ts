/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 主进程侧的 Git 版本管理 channel 宿主。
 *
 * 在 electron-main 内持有 `GitVersionEngine`（isomorphic-git + fs），通过
 * `registerChannel(GIT_VERSION_CHANNEL, this)` 暴露给 renderer；renderer 侧经
 * `ProxyChannel.toService` 透明代理（见 `browser/gitVersionCore.ts`）。
 *
 * 对齐 `electron-main/codebaseGraphStoreChannel.ts` 的 `IServerChannel` 范式，
 * 但方法转发直接复用 `ProxyChannel.fromService`（引擎方法名即 IPC command 名，
 * 无需手写 switch，新增后端方法时零改动）。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { GitVersionEngine } from '../node/gitVersionEngine.js';

export class GitVersionChannel<TContext> extends Disposable implements IServerChannel<TContext> {

	private readonly _delegate: IServerChannel<TContext>;

	constructor() {
		super();
		this._delegate = ProxyChannel.fromService<TContext>(new GitVersionEngine(), this._store);
	}

	call<T>(ctx: TContext, command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T> {
		return this._delegate.call<T>(ctx, command, arg, cancellationToken);
	}

	listen<T>(ctx: TContext, event: string, arg?: any): Event<T> {
		return this._delegate.listen<T>(ctx, event, arg);
	}
}
