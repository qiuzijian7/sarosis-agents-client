/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 子代理内核进程档的 IPC 通道名与消息形状（renderer ↔ main 中继；
 * main 再经 utilityProcess 跑 piLoop 内核 —— 见 piLoop/proc/ 的协议与传输缝）。
 *
 * 通道协议（每个 clientId 一个内核进程）：
 *   call   'start'   { clientId }           ⇒ fork utilityProcess（幂等：同 clientId 重复 start 报错）
 *   call   'post'    { clientId, msg }      ⇒ 转发 ToWorkerMessage 给子进程
 *   call   'dispose' { clientId }           ⇒ kill + 清理（幂等）
 *   listen 'events'  { clientId }           ⇒ 子进程消息流（ToParentMessage；附合成
 *                                             `{ __procExit: info }` 表示子进程退出）。
 *   ⚠ 主进程侧对每个 clientId 缓冲消息直到首个 events 监听就位（renderer 的 listen
 *   注册与 start 调用之间存在 IPC 往返时差，不缓冲会丢早期消息）。
 */

export const SUBAGENT_KERNEL_PROC_CHANNEL = 'agentStudio.subAgentKernelProc';

export interface IProcClientRef {
	readonly clientId: string;
}

export interface IProcPostArg extends IProcClientRef {
	readonly msg: unknown;
}

/** 主进程→renderer 的合成退出标记（与 ToParentMessage 区分：无 `t` 字段）。 */
export interface IProcExitMarker {
	readonly __procExit: string;
}

export function isProcExitMarker(v: unknown): v is IProcExitMarker {
	return typeof v === 'object' && v !== null && typeof (v as IProcExitMarker).__procExit === 'string';
}
