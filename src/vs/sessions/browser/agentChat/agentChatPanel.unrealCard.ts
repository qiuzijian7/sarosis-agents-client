import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { IToolCall } from './agentChatTypes.js';
import { AgentChatPanelDrawioCard } from './agentChatPanel.drawioCard.js';
import { parseToolArgsLoose } from './toolArgsJson.js';
// ★ 2026-09-22：终端风格正文抽成**独立模块**（可 jsdom 单测 ✓ 不进继承链 ✓）
import { createUnrealTerminalBody } from './unrealTerminalView.js';


/**
 * Unreal Engine 工具卡片（unreal_*）—— **终端风格**（2026-09-22 用户要求重新设计 ✓）
 *
 * 定位：只负责**外壳与折叠**（chevron / UE 图标 / UNREAL 徽标 / 标题 / 状态 / 耗时 + 整卡折叠 ✓），
 * 正文（终端块：命令 → 代码 → **结果** → exit 页脚 ✓）全部委派给 `unrealTerminalView` ✓
 * （那样才能在 jsdom 里直接单测 ✓ —— 本卡在继承链末端，直接实例化整条链代价太高 ✗）。
 *
 * ★ 用户硬要求「**要求包含结果的显示**」✓✓：
 *   正文里**没有任何默认折叠** ✗ —— 结果面板一律可见 ✓，只靠**自带滚动**控制高度 ✓；
 *   「看不全」绝不由**隐藏**解决 ✗✓（该不变量已写成单测：正文里不得出现任何隐藏元素 ✓）。
 *
 * ★ 真机契约（`vscode-app-1790084962792.log` 取证 ✓）：`unreal_exec → {ok, repr, output}` ⇒
 *   结果取 **output** ✓；`unreal_health → {status, project, pid, uptime_seconds}` ⇒ 终端 `key = value` ✓；
 *   `ok:false` ⇒ **`exit ✗`** ✗✓（HTTP 200 ≠ Python 成功 ✓）。
 *
 * 混入位置：`DrawioCard → UnrealCard → Markdown`（在继承链末端，可复用 mermaidCard 的
 * `_svgIcon` / `_svgChevron` 等 UI 辅助方法 ✓）。
 */
export abstract class AgentChatPanelUnrealCard extends AgentChatPanelDrawioCard {

	protected override _createUnrealToolCard(tc: IToolCall, key: string): HTMLElement {
		const isRunning = tc.status === 'running';
		const isError = tc.status === 'error';
		const isDone = !isRunning && !isError
			&& tc.status !== 'approval_required'
			&& tc.status !== 'rejected'
			&& tc.status !== 'canceled';

		// 状态驱动外壳类（与 void-tool-card.css 对齐）
		let statusClass = 'tool-card-success';
		if (isError) { statusClass = 'tool-card-error'; }
		else if (isRunning) { statusClass = 'tool-card-running'; }
		else if (tc.status === 'approval_required') { statusClass = 'tool-card-approval'; }
		else if (tc.status === 'rejected' || tc.status === 'canceled') { statusClass = 'tool-card-rejected'; }

		const wrapper = $(`.tool-header-wrapper.${statusClass}.tool-card-unreal`);
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }

		const header = append(wrapper, $('.tool-header'));
		const row = append(header, $('.tool-header-row'));

		// ── 左侧：chevron + UE 图标 + 标题 ──
		const left = append(row, $('.tool-header-left'));
		const chevron = this._svgChevron(left, 'tool-header-chevron', 14);

		// 图标：立体块 SVG，与 drawio 的 emoji 位置等价（drawio 用 '🔷'）
		this._svgUnrealLogo(left, 'tool-header-icon');

		const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable'));

		// kind badge：让卡片在聊天流里一眼可辨属于 UE 族
		const badge = append(titleContainer, $('span.mc-kind-badge'));
		badge.textContent = 'UNREAL';
		badge.style.cssText = 'font-size:10px;font-weight:700;color:var(--accent,#60a5fa);' +
			'text-transform:uppercase;letter-spacing:0.4px;margin-right:4px;';

		const titleEl = append(titleContainer, $('span.tool-header-title'));
		const titleText = this._getToolTitle(key, tc.displayName, tc.name, isRunning);
		titleEl.textContent = titleText;
		if (isRunning) { titleEl.classList.add('shimmer'); }

		// ── 右侧：状态 + 耗时 ──
		const right = append(row, $('.tool-header-right'));
		if (isError) {
			const errBadge = append(right, $('span.tool-status.tool-status.error'));
			errBadge.textContent = '✗';
		} else if (isDone) {
			const check = append(right, $('span.tool-status.tool-status.done'));
			check.textContent = '✓';
		} else if (isRunning) {
			append(right, $('span.tool-header-loading-dots'));
		}
		if (typeof tc.duration === 'number' && tc.duration >= 0) {
			const durEl = append(right, $('span.delegate-time'));
			durEl.textContent = this._formatDuration(tc.duration);
		}

		// ── 正文：终端块（**结果一律可见** ✓ 无任何默认折叠 ✗✓）──────────────────
		const args = parseToolArgsLoose(tc.args);
		const argPairs: Array<readonly [string, string]> = Object.entries(args ?? {})
			.filter(([, v]) => v !== undefined && v !== null)
			.map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as const);

		const body = append(wrapper, $('.tool-header-children'));
		append(body, createUnrealTerminalBody({
			toolName: key,
			args: argPairs,
			code: key === 'unreal_exec' ? String(args?.code ?? '') : '',
			resultText: typeof tc.result === 'string' ? tc.result : '',
			// ⚠ `tc.status` 是**可选**字段 ⇒ 缺省视为 done ✓（与本方法上方 `isDone` 的判定完全一致 ✓
			//   否则同样一条消息会出现"外壳显示 ✓、终端却按运行中渲染"的两套口径 ✗✓）
			status: tc.status ?? 'done',
			durationMs: tc.duration,
		}));

		// ── 折叠策略：整卡 header 点击切换（与 drawio 卡片一致 ✓ chevron 同步旋转 ✓）
		//   ⚠ 折叠只收**整卡**（用户主动 ✓）；正文内部没有任何二级折叠 ✗✓ —— 见文件头硬要求 ✓
		this._register(addDisposableListener(header, EventType.CLICK, () => {
			const nowExpanded = body.classList.toggle('tool-header-children-expanded');
			chevron.classList.toggle('tool-header-chevron-expanded', nowExpanded);
		}));

		return wrapper;
	}

	/**
	 * Unreal 图标：抽象几何「立体块」轮廓，与终端/logo 系列同为手写 path，
	 * 颜色继承父级（currentColor）。
	 */
	private _svgUnrealLogo(container: HTMLElement, className: string): SVGElement {
		const svg = this._svgIcon(
			'M8 1.6l5.6 3.2v6.4L8 14.4 2.4 11.2V4.8L8 1.6z M2.4 4.8L8 8m0 0l5.6-3.2M8 8v6.4',
			14,
		);
		svg.setAttribute('class', className);
		container.appendChild(svg);
		return svg;
	}
}
