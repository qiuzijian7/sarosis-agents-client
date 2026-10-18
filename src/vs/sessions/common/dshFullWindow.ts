/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「弹出窗口 = dsh 官方客户端完整 UI」的跨层钩子（2026-10-17，用户拍板）。
 *
 * 分层约束与 `dshChatHost.ts` 相同：触发点（`agentStudio.popoutChat` 动作）在 browser 层，
 * dsh 通道服务（`IDshHarnessService`）在 electron-browser 层，browser 不能 import
 * electron-browser。因此本文件只定义接口与注册点：
 *
 *   · electron-browser 的 `DshFullWindowContribution` 在启动时注入实现
 *     （engine=dsh 且总开关打开时）；
 *   · browser 层的 popout 动作先问这个钩子：返回 true = 已由 dsh 全窗接管，
 *     不再走旧的「自绘聊天框 aux 窗口」路径；未注册 / 返回 false / 抛错 ⇒ 旧路径兜底。
 */

export interface IDshFullWindowOpenArgs {
	/** 触发弹窗时活动聊天页签的 chatId（用于解析"跟随当前聊天会话"）；非聊天上下文为 undefined。 */
	readonly chatId?: string;
}

/** 返回 true = 已弹出 dsh 官方全窗；false = 不接管（调用方回落旧实现）。 */
export type DshFullWindowOpener = (args: IDshFullWindowOpenArgs) => Promise<boolean>;

let opener: DshFullWindowOpener | undefined;

/** 由 dshHarness 的 electron-browser 贡献在启动时注册（dispose 时务必注销）。 */
export function setDshFullWindowOpener(o: DshFullWindowOpener | undefined): void {
	opener = o;
}

export function getDshFullWindowOpener(): DshFullWindowOpener | undefined {
	return opener;
}
