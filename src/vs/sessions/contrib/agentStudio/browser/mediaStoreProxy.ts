/*---------------------------------------------------------------------------------------------
 *  mediaStoreProxy.ts — renderer 侧媒体资产库代理。
 *
 *  复用 codebaseGraphStoreProxy / kbSqliteStoreProxy 的模式：
 *  ProxyChannel.toService + IMainProcessService.getChannel → IPC → 主进程 MediaStoreChannel。
 *  renderer（sandbox，无 Node）因此可安全读写真源在主进程的媒体资产库。
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { MEDIA_STORE_CHANNEL, IMediaBackend } from '../common/mediaStoreChannel.js';

/** 创建一个经主进程代理的媒体资产库后端（renderer 侧唯一入口）。 */
export function createMediaStoreProxy(mainProcessService: IMainProcessService): IMediaBackend {
	return ProxyChannel.toService<IMediaBackend>(mainProcessService.getChannel(MEDIA_STORE_CHANNEL));
}
