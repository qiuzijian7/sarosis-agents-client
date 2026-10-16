/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天视图 id 分配器（方案第 7 章：同一聊天多处打开时，每个在场的聊天框各要一个视图）。
 *
 * 背景：视图 id 若只按 chatId（`dsh-chat-<chatId>`），同一 chatId 开第二个聊天框
 * （会话历史里同会话双开、分屏恢复等都会复用 chatId）会撞车——主进程 `create` 对已存在
 * 的 id 直接早退，第二个框永远拿不到自己的视图。
 *
 * 口径：
 * - 基础 id 带窗口号（`dsh-chat-w<win>-<chatId>`）：多窗口共用主进程视图表，窗口间不撞。
 * - 每个 pane（token）认领自己在场的视图：主 id 正被别的 token 在场占用时，分配 `-2`、`-3`…。
 * - 同 pane 内切聊天（setChatId）各自保留认领（停用的视图 parked，切回时复用，不重载页面）。
 * - "在场" = pane 可见且布局矩形非零；在场状态每次变化时重新仲裁（冲突自愈）。
 */

export class DshChatViewAllocator {
	private readonly _claims = new Map<object, Map<string, string>>();
	private readonly _present = new Map<string, object>();

	/**
	 * 认领 base 的视图 id。已持有且不冲突时复用；主 id（或自己持有的 id）正被别的 token
	 * 在场占用时分配/改配一个空闲后缀 id。
	 */
	claim(base: string, token: object): string {
		let mine = this._claims.get(token);
		if (!mine) {
			mine = new Map();
			this._claims.set(token, mine);
		}
		const held = mine.get(base);
		if (held !== undefined) {
			const holder = this._present.get(held);
			if (holder === undefined || holder === token) {
				return held;
			}
			// 自己持有的 id 已被别人在场占用（对方后来先在场）：让出并重新分配。
			mine.delete(base);
		}
		let candidate = base;
		for (let n = 2; this._present.has(candidate) && this._present.get(candidate) !== token; n++) {
			candidate = `${base}-${n}`;
		}
		mine.set(base, candidate);
		return candidate;
	}

	/** token 的视图进入在场状态（pane 可见且矩形非零）。 */
	notePresent(viewId: string, token: object): void {
		this._present.set(viewId, token);
	}

	/** token 的视图离开在场状态（只清自己的）。 */
	clearPresent(viewId: string, token: object): void {
		if (this._present.get(viewId) === token) {
			this._present.delete(viewId);
		}
	}

	/** 该视图当前是否被别的 token 在场占用（仲裁用）。 */
	presentHolder(viewId: string): object | undefined {
		return this._present.get(viewId);
	}

	/** 释放 token 的全部认领（pane 销毁）；返回应销毁的视图 id（去重）。 */
	release(token: object): string[] {
		const mine = this._claims.get(token);
		if (!mine) {
			return [];
		}
		this._claims.delete(token);
		const out: string[] = [];
		for (const id of new Set(mine.values())) {
			if (this._present.get(id) === token) {
				this._present.delete(id);
			}
			out.push(id);
		}
		return out;
	}
}
