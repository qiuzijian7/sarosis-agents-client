/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE 能力请求的**认领簿**：一次请求只允许**一个** renderer 真正执行。
 *
 * 为什么需要（真缺陷）：`OnIdeRequest` 是**广播**（主进程一个事件源，每个窗口各有一份
 * `DshHarnessService`），所以多窗口时同一个请求会被**执行 N 次**：`browser.click` 会点 N 下、
 * `canvas.apply_ops` 会弹 N 个确认框（并可能写 N 次）、`openFile` 会在每个窗口各开一个标签页。
 * 第一个回执被采纳，其余在 `dshHarnessChannel` 里被丢弃——**副作用已经发生过了**。
 *
 * 修法（最小、不改单窗口行为）：renderer 执行前先向主进程**认领**这一次请求；
 * 认领到的执行，认领失败的**不执行、也不回执**（回执由赢家负责）。于是多窗口从"N 次"
 * 变成"1 次"——注意赢家窗口**不确定**（先到先得）。要做到"就开在用户正在看的那个窗口"是另一个
 * 层次的事（需要"哪个窗口是 IDE 能力宿主"的语义，见 README 4.45 的"仍未做"表）。
 *
 * 纯逻辑、无依赖：策略可单测，通道只做接线（与 `DshIdeRequestGate` 同一套做法）。
 */
export class IdeRequestClaims {

	private readonly _claimed = new Set<number>();

	/** 尝试认领；返回 `false` = 已被别人认领（调用方**不要执行、也不要回执**）。 */
	claim(id: number): boolean {
		if (this._claimed.has(id)) {
			return false;
		}
		this._claimed.add(id);
		return true;
	}

	/** 请求结束（回执到达 / 超时 / 连接断开）时释放，别让集合无限增长。 */
	release(id: number): void {
		this._claimed.delete(id);
	}

	/** 当前在认领中的请求数（诊断用）。 */
	get size(): number {
		return this._claimed.size;
	}

	/** 清空全部认领（Host 重启 / 通道重建时，旧 id 不会再回来）。 */
	clear(): void {
		this._claimed.clear();
	}
}
