/*---------------------------------------------------------------------------------------------
 *  压缩分组的视图层（方案 C「收纳手风琴」+ **移除模式**）。
 *
 *  背景与演进：
 *   · 2026-09-22 方案：用户拍板"收纳手风琴" —— 被压缩区间整体收成一个可展开的块 ✓。
 *   · 2026-09-22 追加要求：**被压缩的内容从聊天框中移除** ✓✓（性能导向 ✓）。
 *     ⇒ 默认进入**移除模式**：原文**不再留在内存**（`archived` 为空 ✓），组体**根本不建**，
 *       整条只占**一个** DOM 元素 + 一行摘要 ✓✓。原文不会丢：磁盘一条没删 ✓，
 *       「↺ 恢复完整历史」= 既有 `/compact-reset` 一键取回 ✓。
 *     ⇒ 保留模式（`archivedKept:true`）仍支持"展开核对原文"，供调试/对照 ✓（同一套代码两条路 ✓）。
 *
 *  ⚠ 四条设计约束：
 *   ① **懒渲染**（保留模式下）：组体默认不渲染归档消息 ✗✓ —— 26 条 × markdown ≈ 上千节点，
 *      与 `lineFoldPlan` 同一条 DOM 预算纪律 ✓。移除模式更强：**连数据都不持有** ✓✓。
 *   ② **滚动锚点**：展开/收起会改变内容高度 ⇒ 必须按本目录既有配方补偿
 *      （贴底用户重新钉底；上滚用户按 ΔscrollHeight 修正 ✓），并重算滚动条标记 ✓。
 *      配方出处：`agentChatPanel.messages.ts` 的懒加载插入段 ✓。
 *   ③ **不撒谎**：只有**可信**边界才收纳/移除（判据唯一真源 = historyCompaction ✓，
 *      在 `compactionGroupPlan` 里 ✓）。边界不可信 ⇒ 只渲染一条**提示行**，
 *      明确告知"模型其实仍看得见全部历史" ✓✗。
 *   ④ **可恢复**：移除是**视图层**动作 ⇒ 必须显式给出恢复入口 ✓（否则用户会以为内容丢了 ✗）。
 *
 *  为什么是独立函数而不是面板方法：本目录的面板类由**多个文件按继承链拼成** ✗ ——
 *  往链上加一层就要改别人的文件（当前这些文件正被并发改动 ✗）。而本模块只依赖
 *  宿主注入的 5 个能力（deps ✓）⇒ 零继承链改动、可独立单测 ✓。
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import type { IAgentChatMessage } from './agentChatTypes.js';
import {
	isCompactionBoundaryMessage,
	isValidBoundaryMessage,
} from '../../contrib/agentStudio/common/compactionGroupPlan.js';

/** 宿主需提供给分组视图的能力（注入 ⇒ 视图零特权 ✓ 可纯测 ✓）。 */
export interface ICompactionGroupViewDeps {
	/** 建一条"归档消息"的只读气泡（宿主复用 `_createMessageElement` ✓；仅保留模式会用到 ✓）。 */
	createArchivedElement(msg: IAgentChatMessage): HTMLElement;
	/** 当前滚动宿主（消息容器 ✓）。 */
	getScrollHost(): HTMLElement | undefined;
	/** 用户此刻是否贴在底部（决定"重新钉底"还是"保持锚点" ✓）。 */
	isAtBottom(): boolean;
	/** 内容高度变化后重算滚动条标记 ✓（offsetTop 全变了 ✓）。 */
	refreshScrollMarkers(): void;
	/** 执行斜杠命令（恢复完整历史 = `/compact-reset` ✓ 复用既有语义 ✓ 不另造去边界逻辑 ✗）。 */
	runSlashCommand(command: string, arg: string): void | Promise<void>;
}

/**
 * 折叠状态（组 id → 是否展开 ✓）。仅**保留模式**会用到 ✓（移除模式没有可折叠的体 ✓）。
 *
 * ⚠ 为什么是模块级 Map 而不是面板字段：面板字段必须声明在 `agentChatPanel.base.ts`
 *   （正被并发改动 ✗）。键是**稳定的合成 id**（`compaction-group:<边界id>` ✓）⇒
 *   跨 rebuild / 懒加载重渲染都能保留用户选择 ✓；条目数 = 会话内压缩次数（个位数 ✓）。
 */
const groupOpenState = new Map<string, boolean>();

/** 仅供单测复位（生产路径不需要 ✓）。 */
export function _resetCompactionGroupStateForTest(): void {
	groupOpenState.clear();
}

/** 折叠态切换 + 滚动锚点保持（本目录标准配方 ✓，见文件头约束 ②）。 */
function toggleWithScrollAnchor(
	host: HTMLElement | undefined,
	deps: ICompactionGroupViewDeps,
	mutate: () => void,
): void {
	if (!host) { mutate(); return; }
	const prevScrollHeight = host.scrollHeight;
	const prevScrollTop = host.scrollTop;
	mutate();
	const wasAtBottom = deps.isAtBottom();
	if (wasAtBottom) {
		// 贴底用户：内容变了也要继续贴底 ✓（否则会看到"上方空出来一块" ✗）
		host.scrollTop = host.scrollHeight;
	} else {
		// 上滚用户：保持锚点（视口里那条消息不动 ✓），而不是保持绝对 scrollTop ✗
		const diff = host.scrollHeight - prevScrollHeight;
		if (diff !== 0) { host.scrollTop = prevScrollTop + diff; }
	}
	deps.refreshScrollMarkers();
}

/** 指标 chip（缺失/0 ⇒ 不显示空 chip ✗）。 */
function chip(text: string, extraClass?: string): HTMLElement {
	const el = $(`.chat-compaction-chip${extraClass ? '.' + extraClass : ''}`);
	el.textContent = text;
	return el;
}

/** 时间范围文案（缺失 ⇒ 空串 ⇒ 组头不显示 ✓）。 */
function formatRange(from?: number, to?: number): string {
	if (!from || !to) { return ''; }
	const fmt = (t: number): string => {
		const d = new Date(t);
		const hh = String(d.getHours()).padStart(2, '0');
		const mm = String(d.getMinutes()).padStart(2, '0');
		const MM = String(d.getMonth() + 1).padStart(2, '0');
		const DD = String(d.getDate()).padStart(2, '0');
		return `${MM}-${DD} ${hh}:${mm}`;
	};
	// 同一条消息（from===to）时只显示一个时间点 ✓（否则会出现 "10:26 – 10:26" 的噪音 ✗）
	return from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`;
}

/**
 * 建压缩相关元素。返回 `undefined` ⇒ 本条不是压缩消息，调用方应走常规渲染 ✓。
 */
export function createCompactionElement(
	msg: IAgentChatMessage,
	deps: ICompactionGroupViewDeps,
): HTMLElement | undefined {
	if (!isCompactionBoundaryMessage(msg) && !msg.compactionGroup) { return undefined; }
	return msg.compactionGroup
		? createGroupElement(msg, msg.compactionGroup, deps)
		: createBoundaryNoticeElement(msg, deps);
}

/** 组头/组脚的公共部分（两种模式共用 ✓）。 */
function appendMetrics(
	head: HTMLElement,
	rangeText: string,
	group: NonNullable<IAgentChatMessage['compactionGroup']>,
): void {
	if (rangeText) {
		append(head, $('span.chat-compaction-range', undefined, rangeText));
	}
	append(head, $('span.chat-compaction-spacer'));
	if (group.summaryChars > 0) {
		append(head, chip(`摘要 ${group.summaryChars} 字`));
	}
	if (group.tokensSaved > 0) {
		append(head, chip(`省 ${group.tokensSaved.toLocaleString()} tok`, 'ok'));
	}
	if (group.staleBoundaryCount > 0) {
		// 多次压缩：更早的边界只做计数提示 ✓ 绝不重复渲染成多个组 ✗✓
		append(head, chip(`${group.staleBoundaryCount} 处历史边界已失效`));
	}
}

/** 组脚：摘要一行 + 展开摘要 + 恢复完整历史 ✓（两种模式共用 ✓）。 */
function appendFooter(
	card: HTMLElement,
	group: NonNullable<IAgentChatMessage['compactionGroup']>,
	deps: ICompactionGroupViewDeps,
): void {
	const foot = append(card, $('.chat-compaction-foot'));
	append(foot, $('span.chat-compaction-icon', undefined, '⚡'));
	const summaryLine = append(foot, $('span.chat-compaction-summary'));
	summaryLine.textContent = oneLine(group.summary);
	summaryLine.title = group.summary;          // 悬停看全文 ✓（触屏弱 ✓ 故另有"展开摘要" ✓）
	append(foot, $('span.chat-compaction-spacer'));

	const fullBox = append(card, $('.chat-compaction-summary-full'));
	fullBox.textContent = group.summary;
	fullBox.style.display = 'none';

	const toggleBtn = append(foot, $('button.chat-compaction-btn'));
	toggleBtn.textContent = '展开摘要';
	// ⚠ 文案用「恢复完整历史」而非「撤销压缩」✓：移除模式下这才是用户真正理解的动作 ✓
	//   （它复用的仍是既有 `/compact-reset` ✓ 语义完全一致 ✓）。
	const restoreBtn = append(foot, $('button.chat-compaction-btn.primary'));
	restoreBtn.textContent = '↺ 恢复完整历史';
	restoreBtn.title = '移除压缩边界，模型与聊天框都恢复完整历史（/compact-reset）';

	addDisposableListener(toggleBtn, EventType.CLICK, (e: Event) => {
		e.stopPropagation();
		const showing = fullBox.style.display !== 'none';
		toggleWithScrollAnchor(deps.getScrollHost(), deps, () => {
			fullBox.style.display = showing ? 'none' : 'block';
		});
		toggleBtn.textContent = showing ? '展开摘要' : '收起摘要';
	});
	addDisposableListener(restoreBtn, EventType.CLICK, (e: Event) => {
		e.stopPropagation();
		// 只发命令 ✓ —— 真正的去边界与重载历史由宿主完成 ✓（避免两份去边界逻辑漂移 ✗✓）
		void deps.runSlashCommand('compact-reset', '');
	});
}

/**
 * 分组元素 ✓ —— 两条路：
 *   · **移除模式**（默认 ✓）：原文已舍弃 ⇒ 组体**根本不建**，只出一行可读的汇总 + 恢复入口 ✓✓；
 *   · **保留模式**：可展开的手风琴（懒渲染 ✓ 见约束 ①）。
 */
function createGroupElement(
	msg: IAgentChatMessage,
	group: NonNullable<IAgentChatMessage['compactionGroup']>,
	deps: ICompactionGroupViewDeps,
): HTMLElement {
	// ⚠ 判据只看"手上有没有原文"✓：没有原文就不可能展开 ⇒ 自动落回移除模式 ✓
	//   （后端若把 `keepArchived` 打开，视图无需改动即可切回收纳手风琴 ✓ 两种表现都有单测 ✓）
	const removed = !group.archivedKept || group.archived.length === 0;

	const root = $('.chat-message.compaction-group');
	root.setAttribute('data-msg-id', msg.id);
	const card = append(root, $('.chat-compaction-group'));
	const rangeText = formatRange(group.fromTime, group.toTime);

	if (removed) {
		// ── 移除模式：**没有组体**（不建 DOM、也不持有数据 ✓✓ 性能目标的落点）──────────
		const head = append(card, $('.chat-compaction-head.removed'));
		append(head, $('span.chat-compaction-title', undefined, `已压缩的 ${group.count} 条消息已从聊天框移除`));
		appendMetrics(head, rangeText, group);
		const hint = append(card, $('.chat-compaction-removed-hint'));
		hint.textContent = `这 ${group.removedCount} 条原文未丢失：磁盘仍完整保留，模型侧由摘要承载 —— 点「恢复完整历史」可原样取回。`;
		appendFooter(card, group, deps);
		return root;
	}

	// ── 保留模式：收纳手风琴（懒渲染 ✓）──────────────────────────────────────────
	const open = groupOpenState.get(group.id) ?? false;   // 默认**收起** ✓

	const head = append(card, $('.chat-compaction-head'));
	head.setAttribute('role', 'button');
	head.setAttribute('tabindex', '0');
	head.setAttribute('aria-expanded', String(open));
	const caret = append(head, $('.chat-compaction-caret'));
	caret.textContent = '▸';
	append(head, $('span.chat-compaction-title', undefined, `已压缩的 ${group.count} 条消息`));
	appendMetrics(head, rangeText, group);

	const body = append(card, $('.chat-compaction-body'));
	body.style.display = open ? 'block' : 'none';
	if (open) {
		renderArchived(body, group.archived, deps);
	} else {
		body.dataset.rendered = '0';
	}
	appendFooter(card, group, deps);

	const setOpen = (next: boolean): void => {
		toggleWithScrollAnchor(deps.getScrollHost(), deps, () => {
			groupOpenState.set(group.id, next);
			body.style.display = next ? 'block' : 'none';
			caret.textContent = next ? '▾' : '▸';
			head.classList.toggle('open', next);
			head.setAttribute('aria-expanded', String(next));
			if (next && body.dataset.rendered !== '1') {
				renderArchived(body, group.archived, deps);
			}
		});
	};
	const isOpen = (): boolean => body.style.display !== 'none';

	// ⚠ 整行可点，但按钮点击必须 `stopPropagation` ✓（见 appendFooter ✓ 否则点"恢复"会先折叠一次 ✗）
	addDisposableListener(head, EventType.CLICK, () => setOpen(!isOpen()));
	addDisposableListener(head, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!isOpen()); }
	});

	return root;
}

/** 归档消息回放（只读 ✓ 弱化 ✓ 其中的历史边界已降级为普通消息 ⇒ 不会嵌套分组 ✓）。 */
function renderArchived(
	body: HTMLElement,
	archived: readonly IAgentChatMessage[],
	deps: ICompactionGroupViewDeps,
): void {
	body.replaceChildren();
	for (const m of archived) {
		const el = deps.createArchivedElement(m);
		el.classList.add('chat-compaction-archived');
		// 归档区不提供交互动作（编辑/回撤会与"已滚出视野"的语义打架 ✗✓）
		el.querySelectorAll('.chat-msg-actions').forEach(a => a.remove());
		append(body, el);
	}
	body.dataset.rendered = '1';
}

/**
 * 边界提示行（两种情形 ⇒ 都**不收纳也不移除** ✓）：
 *  ① 边界不可信（摘要饥饿 / tokensSaved<=0 ✓）⇒ 模型其实仍看得见全部历史，必须说明 ✗✓；
 *  ② 可信但前面已无消息可处理（边界位于首位 / 区间为空 ✓）⇒ 只报事实，不建空组 ✓。
 */
function createBoundaryNoticeElement(msg: IAgentChatMessage, deps: ICompactionGroupViewDeps): HTMLElement {
	const valid = isValidBoundaryMessage(msg);
	const root = $('.chat-message.compaction-boundary-notice');
	root.setAttribute('data-msg-id', msg.id);
	const card = append(root, $(`.chat-compaction-notice${valid ? '' : '.warn'}`));
	append(card, $('span.chat-compaction-icon', undefined, valid ? '⚡' : '⚠'));
	const text = append(card, $('span.chat-compaction-notice-text'));
	text.textContent = valid
		? '上下文压缩边界（此前已无可移除的消息）'
		: '此压缩边界**未生效**：摘要信息量不足或未省 token ⇒ 模型仍能看到完整历史（未按摘要截断）';
	if (!valid) {
		// 无效边界：给出"恢复"以外的唯一有意义动作 = 重试压缩 ✓（可发现性优先 ✓）
		const retry = append(card, $('button.chat-compaction-btn'));
		retry.textContent = '↻ 重新压缩';
		retry.title = '边界无效时不落任何边界，可直接重试（/compact）';
		addDisposableListener(retry, EventType.CLICK, () => { void deps.runSlashCommand('compact', ''); });
	}
	return root;
}

/** 摘要取首行 + 截断（组脚一行 ✓ 全文在悬停/展开里 ✓）。 */
function oneLine(summary: string, max = 120): string {
	const first = (summary ?? '').split('\n').map(l => l.trim()).filter(l => l.length > 0)[0] ?? '';
	const head = first.length > max ? first.slice(0, max) + '…' : first;
	return head.length > 0 ? `摘要：${head}` : '摘要为空';
}
