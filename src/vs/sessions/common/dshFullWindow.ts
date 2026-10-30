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
	/**
	 * **另开一扇**（2026-10-29，桌面窗口多开）。
	 *
	 * 默认（缺省 / false）= **复用**已开着的桌面窗口（只聚焦，不新开）—— 这是 2026-10-17
	 * 修「点 agent 条目弹出一叠透明窗口」时的定稿语义，**不要**改回去。
	 * true = 不复用，**新开一扇**：每扇窗口有自己的一条 dsh 会话（会话 id 按窗口 id 派生）
	 * 与自己的网络分区 ⇒ 多扇并行工作互不干扰 ✓。
	 */
	readonly newWindow?: boolean;
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

/**
 * 打开一扇 dsh 桌面窗口（2026-10-29，桌面窗口多开的对外入口）。
 *
 * 为什么要有这个函数：`DshFullWindowContribution` 在 **electron-browser** 层，而命令面板
 * （`dshHarness.contribution.ts`）也在 electron-browser 层 —— 但它们是两个不同的类，
 * 直接互相 import 会成环（贡献与通道服务之间已有这种约束的先例）⇒ 用这个 common 层的
 * 单例钩子串起来 ✓（与 `setDshFullWindowOpener` 同一套机制）。
 *
 * @param args `newWindow: true` = 另开一扇（不复用）；缺省 = 复用已开着的（只聚焦）。
 * @returns 是否真的打开了（钩子未注册 / engine≠dsh ⇒ false ⇒ 调用方可如实提示）。
 */
export async function openDshFullWindow(args: IDshFullWindowOpenArgs = {}): Promise<boolean> {
	const o = opener;
	if (!o) {
		return false;
	}
	return o(args);
}

/**
 * 「在当前桌面窗口里分屏出一栏新聊天」的跨层入口（2026-10-29）。
 *
 * 为什么与 `openDshFullWindow` 分开：用户要的是**同一个窗口内左右分屏**（像社区的
 * dsh-split-workspace），不是"再弹一扇独立窗口" ⇒ 两者是**不同的产品动作**：
 *   · `openDshFullWindow`  = 另开一扇**独立窗口**（各自的会话与分区）；
 *   · `splitDshChatPane`   = 在**当前窗口**里加一栏（左右分屏，中间可拖动）。
 *
 * @param viewId 发起请求的那个 dsh 视图（宿主从页面命令事件里拿）⇒ 据它定位是哪扇桌面窗口 ✓
 * @returns 是否真的加上了这一栏（找不到所属窗口 / 宿主不支持 ⇒ false ⇒ 调用方如实提示 ✓）。
 */
export type DshSplitPaneOpener = (viewId: string) => Promise<boolean>;

let splitOpener: DshSplitPaneOpener | undefined;

/** 由 dshHarness 的 electron-browser 贡献在启动时注册（dispose 时务必注销）。 */
export function setDshSplitPaneOpener(o: DshSplitPaneOpener | undefined): void {
	splitOpener = o;
}

/** 在发起请求的那扇桌面窗口里加一栏（详见 {@link DshSplitPaneOpener}）。 */
export async function splitDshChatPane(viewId: string): Promise<boolean> {
	const o = splitOpener;
	if (!o) {
		return false;
	}
	return o(viewId);
}

/** 分屏栏的**动作**（页面菜单 ⇒ 宿主）：移到极端位置 / 关掉这一栏（2026-10-29）。 */
export type DshPaneAction = 'moveLeft' | 'moveRight' | 'moveTop' | 'moveBottom' | 'close'
	/** 改两栏比例（33/50/67 = 左栏占 1/3、1/2、2/3）—— 分隔条拖不动（DOM 层收不到事件）⇒ 走菜单 ✓ */
	| 'ratio33' | 'ratio50' | 'ratio67'
	/** 主栏「布局 ▾」菜单（2026-10-30，按效果图）：自动排列 / 平均分配 / 关闭全部右侧格子 */
	| 'arrange' | 'equalize' | 'closeAll';

export type DshPaneActionOpener = (viewId: string, action: DshPaneAction) => Promise<boolean>;

let paneActionOpener: DshPaneActionOpener | undefined;

/** 由 dshHarness 的 electron-browser 贡献在启动时注册（dispose 时务必注销）。 */
export function setDshPaneActionOpener(o: DshPaneActionOpener | undefined): void {
	paneActionOpener = o;
}

/**
 * 对"发起请求的那个视图所在的那一栏"执行动作（移动 / 关闭）。
 *
 * ⚠ **为什么交互放在页面里而不是 DOM 抓手带**（2026-10-29 真机证据）：aux（桌面）窗口的 **DOM 层
 *   收不到鼠标事件** —— 抓手带能建、能看见，但 `mousedown` 从不触发（日志里零 `pane drag`）⇒
 *   拖拽在这条路上**做不到**。页面在**原生视图内部**，事件完全正常 ⇒ 菜单放页面里 ✓。
 */
export async function paneDshChatPane(viewId: string, action: DshPaneAction): Promise<boolean> {
	const o = paneActionOpener;
	return o ? o(viewId, action) : false;
}
