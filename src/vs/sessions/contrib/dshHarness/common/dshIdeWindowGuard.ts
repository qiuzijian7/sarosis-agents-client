/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「desktop 模式 ⇒ IDE 主窗口**不露面**」的守卫策略（2026-10-21）。
 *
 * 背景（用户报障："在 desktop 模式下，点击登录，不要显示 ide 模式的窗口"）：
 *   · desktop 模式 = 启动时把 **IDE 主窗口整个藏起来**、只留 dsh 桌面窗口
 *     （`dshFullWindowContribution.ts` 的 `_settleIdeWindowAfterStartup` ⇒ `hideWindow`）；
 *   · 用户在桌面窗口点「登录」⇒ 走 `signInIde` ⇒ IDE 起 TOF/OA 流程（起 loopback →
 *     **开系统浏览器** → 等回调 → whoami）；
 *   · 真机日志（dev 实例 2026-10-21 21:04:23）：
 *       21:04:23.574 page signInIde ⇒ IDE 账号服务 login
 *       21:04:23.662 window 2 BLUR          ← 桌面窗口失焦（浏览器抢了焦点）
 *       21:04:25.306 **window 1 FOCUS**     ← ★ IDE 主窗口被拉到前台（= 用户看到的"冒出一个 IDE 窗口"）
 *     ⇒ 我们的代码**没有**调用过 showWindow（`DSH_PAGE_COMMANDS_WITHOUT_IDE_UI` 里已排除
 *     `signInIde`/`signOutIde`）⇒ 是**窗口层面的外部动作**（系统把焦点还给本应用的窗口 /
 *     Electron 自己把它 show 出来）⇒ **只在命令分发处拦是拦不住的** ✗。
 *
 * ⇒ 策略：**"我们藏起来的窗口"就是不许露面** —— 状态放在主进程（那里才观察得到
 *   `show` / `focus` 事件），一旦它在隐藏态下被显示或聚焦 ⇒ **立刻再藏回去** ✓。
 *
 * ⚠ 这条守卫只在**我们主动藏起来**（`hiddenByUs`）时生效 ⇒ 用户自己点「回到 IDE」时
 *   必须**先撤守卫再显示**（否则窗口刚 show 就被藏回去 ⇒ "点了没反应" ✗）。
 */

/** 主进程观察到的 IDE 主窗口事件。 */
export type DshIdeWindowGuardEvent =
	/** 窗口被显示（`win.on('show')`）。 */
	| 'show'
	/** 窗口获得焦点（`win.on('focus')`）—— 隐藏态下拿到焦点 = 它被系统拉到了前台 ✗。 */
	| 'focus'
	/** 窗口被隐藏。 */
	| 'hide'
	/** 窗口失去焦点。 */
	| 'blur';

/** 守卫状态（渲染进程同步给主进程的那份"意图"）。 */
export interface IDshIdeWindowGuardState {
	/**
	 * true = **我们**把 IDE 主窗口藏起来了（desktop 模式）⇒ 它不许露面。
	 * false = 窗口该露着（正常 IDE 模式 / 用户点了「回到 IDE」）。
	 */
	readonly hiddenByUs: boolean;
}

/** 守卫动作。 */
export type DshIdeWindowGuardAction =
	/** 立刻再藏回去（并记一行日志）。 */
	| 'rehide'
	/** 什么都不做。 */
	| 'ignore';

/**
 * 守卫判定：**纯函数**（主进程与单测共用；不引 Electron ⇒ 可 in-process 断言 ✓）。
 *
 * @param state 守卫状态
 * @param event 窗口事件
 */
export function ideWindowGuardAction(state: IDshIdeWindowGuardState, event: DshIdeWindowGuardEvent): DshIdeWindowGuardAction {
	if (!state.hiddenByUs) {
		// 不是我们藏的 ⇒ 窗口该露着（用户在用 IDE 模式）⇒ 不许插手 ✗。
		return 'ignore';
	}
	// 只有"被显示 / 被聚焦"才是要压回去的两种；'hide'/'blur' 本来就是我们要的状态 ✓。
	return event === 'show' || event === 'focus' ? 'rehide' : 'ignore';
}

/** 通道负载（渲染进程 → 主进程）："IDE 主窗口现在是我们藏着的 / 不藏了"。 */
export interface IDshSetIdeWindowHiddenArgs {
	/** true = 我们藏起来了（装守卫）；false = 不藏了（撤守卫）。 */
	readonly hidden: boolean;
	/** 被守卫的窗口 id（渲染进程的 `nativeHostService.windowId` = Electron 窗口 id ✓）。 */
	readonly windowId: number;
}

/** 负载校验（跨进程边界必须收紧 ⇒ 脏值不许进主进程 ✗）。 */
export function validateSetIdeWindowHiddenArgs(raw: unknown): raw is IDshSetIdeWindowHiddenArgs {
	if (!raw || typeof raw !== 'object') {
		return false;
	}
	const o = raw as { hidden?: unknown; windowId?: unknown };
	if (typeof o.hidden !== 'boolean') {
		return false;
	}
	// 窗口 id 必须是**正整数**（0 / 负数 / 非数都不许 ⇒ 避免误伤别的窗口 ✗）。
	return typeof o.windowId === 'number' && Number.isInteger(o.windowId) && o.windowId > 0;
}
