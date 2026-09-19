import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { IToolCall } from './agentChatTypes.js';
import { AgentChatPanelDrawioCard } from './agentChatPanel.drawioCard.js';
import { parseToolArgsLoose } from './toolArgsJson.js';


/**
 * Unreal Engine 工具卡片（unreal_*）
 *
 * 与 Mermaid / Draw.io 卡片同构：header（chevron / 图标 / 标题 / 状态 / 耗时）+
 * 可折叠正文（摘要行 + 完整结果）。差异点：
 *   - 无图形预览，正文直接展示 bridge 返回的文本/JSON（结果普遍较短且为纯文本，
 *     无需 Blob URL 或 TrustedHTML）。
 *   - `unreal_exec` 额外展示待执行的 Python 代码片段（LLM 与用户核对实际执行内容
 *     的主要依据 —— 这是本族工具最需要被看清的信息）。
 *
 * 混入位置：`DrawioCard → UnrealCard → Markdown`（在继承链末端，可复用 mermaidCard
 * 的 `_svgIcon` / `_mcBtn` 等 UI 辅助方法）。
 */
export abstract class AgentChatPanelUnrealCard extends AgentChatPanelDrawioCard {

	/** 摘要行最多展示的字符数；超出部分折叠进正文，避免卡片过长。 */
	private static readonly SUMMARY_LIMIT = 160;

	/** `unreal_exec` 代码片段最多展示的字符数。 */
	private static readonly CODE_SNIPPET_LIMIT = 600;

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

		// ── 正文：摘要 + 完整结果（默认折叠，与 mermaid/drawio 一致）──
		const args: Record<string, unknown> = parseToolArgsLoose(tc.args);
		const resultText = typeof tc.result === 'string' ? tc.result : '';
		const summary = AgentChatPanelUnrealCard._summarize(resultText);

		const body = append(wrapper, $('.tool-header-children'));

		// unreal_exec：展示待执行的 Python 代码
		if (key === 'unreal_exec') {
			const code = (args?.code ?? '').toString();
			if (code.trim()) {
				const codeSection = append(body, $('.unreal-code-section'));
				const codeLabel = append(codeSection, $('span.unreal-code-label'));
				codeLabel.textContent = '执行代码';
				const pre = append(codeSection, $('pre.unreal-code-block'));
				pre.textContent = code.length > AgentChatPanelUnrealCard.CODE_SNIPPET_LIMIT
					? code.slice(0, AgentChatPanelUnrealCard.CODE_SNIPPET_LIMIT) + '\n… (已截断)'
					: code;
			}
		}

		if (summary) {
			const summaryEl = append(body, $('.unreal-summary'));
			summaryEl.textContent = summary;
		}

		// 完整结果：默认折叠，点击展开（内容较长时有意义）
		if (resultText.trim()) {
			const resultSection = append(body, $('.unreal-result-section'));
			const toggle = append(resultSection, $('span.unreal-result-toggle'));
			toggle.textContent = '完整结果';
			const pre = append(resultSection, $('pre.unreal-result-block'));
			pre.textContent = resultText;
			pre.style.display = 'none';
			this._register(addDisposableListener(toggle, EventType.CLICK, (e: MouseEvent) => {
				e.stopPropagation();
				const shown = pre.style.display !== 'none';
				pre.style.display = shown ? 'none' : 'block';
				toggle.textContent = shown ? '完整结果' : '收起结果';
			}));
		}

		// ── 折叠策略 ──
		// 与 drawio 卡片完全对齐：整卡 header 点击切换；chevron 同步旋转。
		// unreal_* 无图形预览，无需跨重建保留展开态（那套逻辑是 mermaid/terminal
		// 为「运行中自动展开」准备的，本卡片没有该语义）。
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

	/** 取结果首段非空文本作为摘要。 */
	private static _summarize(resultText: string): string {
		const trimmed = resultText.trim();
		if (!trimmed) { return ''; }
		const firstLine = trimmed.split('\n')[0];
		return firstLine.length > AgentChatPanelUnrealCard.SUMMARY_LIMIT
			? firstLine.slice(0, AgentChatPanelUnrealCard.SUMMARY_LIMIT) + '…'
			: firstLine;
	}
}
