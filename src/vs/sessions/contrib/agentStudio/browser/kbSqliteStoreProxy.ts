/*---------------------------------------------------------------------------------------------
 *  kbSqliteStoreProxy.ts — renderer 侧 KB SQLite 后端代理。
 *
 *  复用 codebaseGraphStoreProxy 的模式：
 *  ProxyChannel.toService + IMainProcessService.getChannel → IPC → main 进程 handler。
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { KB_SQLITE_STORE_CHANNEL, IKbSqliteBackend } from '../common/kbSqliteStoreChannel.js';

/** 创建一个经主进程代理的 KB SQLite FTS5 后端（renderer 侧唯一入口）。 */
export function createKbSqliteStoreProxy(mainProcessService: IMainProcessService): IKbSqliteBackend {
	return ProxyChannel.toService<IKbSqliteBackend>(mainProcessService.getChannel(KB_SQLITE_STORE_CHANNEL));
}
