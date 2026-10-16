/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **一次 IDE 能力该投给哪个窗口**——策略部分（纯逻辑，可单测）。
 *
 * 背景（两步）：
 * 1. `OnIdeRequest` 原本是**广播**（每个窗口一份 `DshHarnessService`）⇒ 多窗口会把同一请求**执行 N 次**
 *    （`browser.click` 点 N 下、`canvas.apply_ops` 弹 N 个确认框）。已由**认领簿**（`dshIdeClaims.ts`）
 *    收口到"只执行一次"。
 * 2. 但认领是"先到先得"⇒ **结果落在哪个窗口不确定**（`openFile` 可能开在用户没看的那个窗口）。
 *    这里补上"落对地方"：请求里带 `sessionId`（Host 侧从 `exec.agent.session.id` 取），
 *    主进程用 `DshViewHost` 记的 `ownerWindowId` 找到**正在跑这个会话的那个窗口**，定向投递。
 *
 * 边界：拿不到 `sessionId`、或没有窗口绑着该会话 ⇒ 返回 `undefined`，调用方**退回广播**
 * （行为与从前完全一致 ⇒ 新机制不会变成"请求发不出去"的新故障源）。
 */

/** dsh 视图槽位里与定位相关的最小投影（真源是 `DshViewHost` 的 `IViewSlot`）。 */
export interface IIdeViewSlotForTargeting {
	readonly ownerWindowId: number;
	readonly sessionId?: string;
}

/**
 * 选窗结果：
 * - `window`：定向到该窗口（正常路径）；
 * - `none`：判不出来（没带会话 id / 没有窗口绑着它 / 视图没绑会话）⇒ 调用方**退回广播**，行为与从前一致；
 * - `ambiguous`：**同一个会话同时在多个窗口开着** ⇒ 调用方**明确拒绝**这次请求，不猜。
 *
 * 为什么 `ambiguous` 不"取第一个"也不是"聚焦优先"：两者都是**猜**，猜错的代价正是用户会直接看到的错
 * （`open_file` 开在他没看的窗口、`canvas` 切在别的窗口）。而"两窗口同开一个会话"这件事本身有据可查
 * （会话 id 不含窗口号，两个窗口开同一工作区就会落到同一会话）⇒ 说得清、就该直接说不清在哪儿。
 */
export type IIdeTargetPick =
	| { readonly kind: 'window'; readonly windowId: number }
	| { readonly kind: 'none' }
	| { readonly kind: 'ambiguous'; readonly windowIds: readonly number[] };

/**
 * 选出发起这次能力请求的**目标窗口**。
 *
 * 语义：**正在跑这个会话的那个窗口**——模型是在这个会话里干活的，结果就该落在用户看得到的地方。
 * 同窗口内多个视图绑同一会话**不算歧义**（都指向同一个窗口），按窗口去重后再判。
 */
export function pickIdeTargetWindow(slots: readonly IIdeViewSlotForTargeting[], sessionId: string | undefined): IIdeTargetPick {
	if (typeof sessionId !== 'string' || !sessionId) {
		return { kind: 'none' };
	}
	const windowIds: number[] = [];
	for (const slot of slots) {
		if (slot.sessionId === sessionId && !windowIds.includes(slot.ownerWindowId)) {
			windowIds.push(slot.ownerWindowId);
		}
	}
	if (windowIds.length === 0) {
		return { kind: 'none' };
	}
	if (windowIds.length > 1) {
		return { kind: 'ambiguous', windowIds };
	}
	return { kind: 'window', windowId: windowIds[0] };
}
