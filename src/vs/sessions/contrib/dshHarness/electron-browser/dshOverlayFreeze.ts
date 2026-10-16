/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 浮层让位时的**冻结帧**（2026-10-15，事故驱动：用户报"选中主页，鼠标 hover 到 workspace 图标 ⇒
 * sideview 内容消失"）。
 *
 * ── 问题 ────────────────────────────────────────────────────────────────────
 * dsh 页面是**原生视图**（`WebContentsView`），永远盖在 DOM 之上 ⇒ 要让 tooltip / 菜单 / 命令面板
 * **看得见**，就只能把视图藏起来（渲染侧两条宿主都这么做：`dshPluginViewPane` 与 `dshChatInstanceHost`）。
 * 而藏起来那一刻，那块区域只剩一个**占位 div** ⇒ 占位没有背景时，用户看到的就是"内容消失（一片空白/黑）"✗✗。
 * 这不是罕见路径：ActivityBar 的 tooltip 用 `HoverPosition.RIGHT`，**必然**落在侧栏页面矩形里
 * （真机实测：页面 x=48..450，第二个图标 `agentStudio.workspace` 的 tooltip 起点 ≈56）⇒ **每次 hover
 * 图标都会踩到**；命令面板压住聊天框则每次 F1 都会踩到。
 *
 * ── 做法 ────────────────────────────────────────────────────────────────────
 * 让位**之前**抓一帧画面贴到占位上 ⇒ 视觉上是"内容一直在 + 浮层浮在上面" ✓；浮层消失、视图回来后
 * 清掉那一帧。抓图走主进程（`DshViewHost.captureView`，只读；失败返回 `undefined`），失败/来不及时
 * 占位显示的是**主题底色**（两条宿主在构造占位时都给了），所以最差也是"空面板"而不是黑洞 ✓。
 *
 * ── 为什么迟到帧必须作废（`_token`）────────────────────────────────────────
 * 抓图是异步的：期间用户可能已经移开鼠标（视图恢复显示）、或换到另一个视图、或又发生了一轮遮挡。
 * 不作废就会出现"恢复显示之后旧画面闪回"——比空白更让人以为坏了 ✗。所以每次请求/清除都 +1，
 * 回来时对不上就丢弃 ✓。
 *
 * 两位宿主共用本类（此前是两份同名实现）：判定口径（`stillValid`）与令牌语义必须**只有一处**，
 * 否则修了一边另一边会静默退化。
 */

/** 占位 / 容器元素最小面（只要 `style`；便于单测传假对象）。 */
export interface IDshFreezeElement {
	readonly style: { backgroundImage: string; backgroundSize: string; backgroundPosition: string; backgroundRepeat: string };
}

export interface IDshOverlayFreezeHost {
	/**
	 * **抓一帧并让位**（隐藏原生视图），返回那一帧（dataURL；抓不到 `undefined`）。
	 *
	 * ⚠ 必须是**一次**调用（`IDshHarnessService.freezeView`）：拆成"抓帧"+"隐藏"两次 IPC 会赛跑，
	 * 抓到的是离屏空帧 ⇒ 帧永远贴不上（2026-10-15 真机复测的第二次失败就是这个 ✗）。
	 */
	freezeView(viewId: string): Promise<string | undefined>;
}

export class DshOverlayFreeze {

	/** 作废令牌：每次 `request` / `clear` 都 +1，异步帧回来对不上就丢弃（见文件头）。 */
	private _token = 0;

	constructor(
		private readonly _element: IDshFreezeElement,
		private readonly _host: IDshOverlayFreezeHost,
		/**
		 * "这一帧**已经过期**了吗"——由调用方回答（判据必须与它自己的让位条件**同向**）：
		 * 通常写成 `() => !this._overlayVisible || this._viewShown`（已恢复显示 / 已不在遮挡 ⇒ 过期 ✓）。
		 *
		 * ⚠ 这个方向的命名是刻意的：收拢两份实现时写成"还有效吗"的**反向**谓词 ⇒ 每帧都被判过期、
		 *   帧永远贴不上（而单元测试传字面量照样绿 ✗✗）。命名带 `Stale` 就是为了让调用点一眼对得上。
		 */
		private readonly _isStale: () => boolean,
		/**
		 * 抓帧失败/被拒时的留痕（可选）。
		 *
		 * ⚠ 为什么要留痕（2026-10-15 事故的教训）：失败原来被完全吞掉 ⇒ 现场只有"内容空白"这一个症状，
		 * 分不清是"主进程还没这个命令（窗口重载不会更新主进程 bundle ✗）"、"抓图抛错"还是"没触发"。
		 * 留一行 warn，排查就从"猜"变成"读日志" ✓。
		 */
		private readonly _log?: (line: string) => void,
	) { }

	/**
	 * **让位**：让主进程抓一帧并隐藏视图（一次调用，顺序由主进程保证），帧回来时贴到占位上。
	 *
	 * ⚠ 调用方**不要**再单独发 `setViewVisible(false)` —— 那会与抓帧赛跑（见 `IDshOverlayFreezeHost`）。
	 * `viewId` 为空 ⇒ 什么都不做（调用方自己负责让位）。
	 */
	hideAndFreeze(viewId: string | undefined): void {
		if (!viewId) {
			return;
		}
		const token = ++this._token;
		void this._host.freezeView(viewId).then(frame => {
			if (token !== this._token || !frame || this._isStale()) {
				return;
			}
			const style = this._element.style;
			style.backgroundImage = `url("${frame}")`;
			style.backgroundSize = 'cover';
			style.backgroundPosition = 'center top';
			style.backgroundRepeat = 'no-repeat';
		}, e => {
			// 不致命（让位照旧、占位显示主题底色）⇒ 只留痕，不抛。
			this._log?.(`浮层让位时抓帧失败（占位只能用主题底色）：${String((e as Error)?.message ?? e)}`);
		});
	}

	/** 恢复显示时调：清掉帧并作废在途请求（原生视图已经盖住占位，留着只是白占内存）。 */
	clear(): void {
		this._token++;
		if (this._element.style.backgroundImage) {
			this._element.style.backgroundImage = '';
		}
	}
}

/**
 * 原生视图**占位**的 css 文本（两条宿主此前各写一份、只差底色 ⇒ 收拢到一处）。
 *
 * `background` **必须**给：它是"视图因浮层让位而隐藏"那一刻唯一露出来的东西（见文件头）——
 * 不给就是整块空白/黑 ✗。侧栏传 `var(--vscode-sideBar-background)`、编辑器区传
 * `var(--vscode-editor-background)`（与该面板的状态框同源 ✓）。
 */
export function dshViewPlaceholderCssText(background: string): string {
	return `position:absolute;inset:0;outline:none;background:${background};`;
}
