/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **app 开关规则**（2026-10-24 用户明确口径，三条）：
 *
 *   ① 只开了桌面窗口（IDE 被我们藏着 / 没开）⇒ **关窗口 = 关 app**
 *   ② 只开了 IDE（没有桌面窗口）              ⇒ **关 IDE = 关 app**
 *   ③ 两个都开着                              ⇒ 关哪个都**只关它自己**，app 继续活着
 *
 * 为什么值得单独一层纯函数：这个"关窗收场"原先散在三处（主进程 close 拦截、桌面窗口 unload、
 * 渲染侧 `_quitAfterDesktopClosed`）各判一套，改一条就漏一条 ⇒ 真机上出现过
 * "关 IDE 把 desktop 一起带走" 与 "关 desktop 后 IDE 被亮出来" 两种事故 ✗。
 * 现在判据只有一处（本文件）、只吃两个数字（可见的 IDE 窗口数 / 存活的桌面窗口数）⇒ 可表驱动断言 ✓。
 *
 * ⚠ 两个物理约束（决定了规则怎么落地，不能照字面"真关"）：
 *   · 桌面窗口是 IDE 主窗口用 `window.open` 开的**辅助窗口**（没有 `noopener`）⇒ 真销毁主窗口时
 *     Chromium 会把它一起收掉 ⇒ 规则 ③ 里的"关 IDE"只能做成**隐藏**（用户视角一样：那一扇没了）；
 *   · 隐藏窗口不计入 Electron 的 `window-all-closed` ⇒ 规则 ①②的"关 app"必须**显式 quit**，
 *     指望默认退出会留下"没有界面却活着"的隐形进程 ✗。
 */

/** 关窗那一刻的事实（都由主进程数出来，不猜）。 */
export interface IAppWindowFacts {
	/** **可见**的 IDE 主窗口数（正在关的那扇**不算**；被我们藏着的不算 ✓）。 */
	readonly ideVisible: number;
	/** 存活的桌面窗口数（承载 dsh 视图的辅助窗口；正在关的那扇**不算**）。 */
	readonly desktop: number;
}

/** 关窗收场动作。 */
export type AppWindowCloseAction =
	/** 就让它关（不拦、不藏、不退）。 */
	| 'close'
	/** **不能真关**：隐藏起来（否则辅助窗口会被 Chromium 一起收掉）。 */
	| 'hide'
	/** 让它关，关完**退出应用**（它是最后一个界面）。 */
	| 'quit';

/**
 * 关一扇 **IDE 主窗口** 时该怎么做。
 */
export function decideIdeWindowClose(facts: IAppWindowFacts): AppWindowCloseAction {
	if (facts.desktop > 0) {
		// 还有桌面窗口在 ⇒ 应用不能退；
		//   桌面窗口的 opener 就是这扇 IDE 窗口 ⇒ 真关会把它带走 ✗ ⇒ 隐藏（= 用户看到"关了自己"）。
		return facts.ideVisible > 0 ? 'close' : 'hide';
	}
	// 没有桌面窗口 ⇒ 关掉这扇就没有界面了 ⇒ 关完退（规则 ①②）。
	//   还有别的可见 IDE 窗口时只管关自己（规则 ③ 的多窗口形态）。
	return facts.ideVisible > 0 ? 'close' : 'quit';
}

/**
 * 关一扇 **桌面窗口** 时该怎么做。
 */
export function decideDesktopWindowClose(facts: IAppWindowFacts): AppWindowCloseAction {
	// IDE 还可见 ⇒ 只是关掉另一个窗口，应用继续（规则 ③）。
	if (facts.ideVisible > 0) {
		return 'close';
	}
	// IDE 不可见（被藏着 / 没开）：还有别的桌面窗口 ⇒ 只关自己；否则这是最后一个界面 ⇒ 退（规则 ①）。
	return facts.desktop > 0 ? 'close' : 'quit';
}
