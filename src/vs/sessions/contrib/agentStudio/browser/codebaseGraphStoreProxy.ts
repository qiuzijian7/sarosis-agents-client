/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * renderer 侧代理：把 `ICodebaseGraphSqliteBackend` 调用经 `mainProcessService` 的
 * `CODEBASE_GRAPH_STORE_CHANNEL` 透明转发到 main 进程内的 `CodebaseGraphStoreChannel`。
 *
 * 使用 VS Code 内置 `ProxyChannel.toService`：方法调用 → `channel.call(method, args)`，
 * 返回值经 IPC 反序列化。renderer 无需感知 SQLite / 原生模块（sandbox 安全）。
 */

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { CODEBASE_GRAPH_STORE_CHANNEL, ICodebaseGraphSqliteBackend } from '../common/codebaseGraphStoreChannel.js';

/** 创建一个经主进程代理的 SQLite 后端（renderer 侧唯一入口） */
export function createCodebaseGraphSqliteBackend(mainProcessService: IMainProcessService): ICodebaseGraphSqliteBackend {
	return ProxyChannel.toService<ICodebaseGraphSqliteBackend>(mainProcessService.getChannel(CODEBASE_GRAPH_STORE_CHANNEL));
}
