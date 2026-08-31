/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天框「全量刷新」可观测性（纯逻辑，零 DOM 依赖，可独立单测）。
 *
 * ## 为什么需要它
 *
 * 全量刷新（整条消息重建 / 整卡重建 / markdown 全量替换）是聊天框**抖动的唯一直接
 * 来源** —— 它会丢弃并重建 DOM 子树，导致高度突变、滚动位置跳变、markdown 重解析。
 * 就地更新路径再快，只要有一条全量路径被高频触发，用户就会看到抖动。
 *
 * 但排查此前极其困难，三个原因：
 *
 * 1. **`_rebuildMessageElement` 有 7 个调用点，而它自己的日志不记录调用来源** ——
 *    日志里只能看到「重建了」，看不到「为什么重建」，无法定位到具体规则分支。
 * 2. **工具卡整卡重建（4 处 `oldCard.replaceWith`）完全没有日志**。
 * 3. **`StreamingRenderScheduler` 增量渲染失败回退全量 `replaceChildren` 完全没有
 *    日志** —— 而这条路径正是「markdown 内容整段闪烁」的直接原因（增量失败时会
 *    丢弃并重建整个 markdown 子树）。
 *
 * 结果就是：抖动只能靠用户截图和主观描述反馈，每次都要重新推演一遍链路。
 *
 * ## 设计
 *
 * - `FullRefreshSource` 把**每个调用点**都编码成一个稳定字符串，`_rebuildMessageElement`
 *   的 source 参数是**必填**的 —— TS 会强制所有调用点显式声明来源，新增调用点时不
 *   可能漏。
 * - 日志**默认输出**（不挂在 `__SAROSIS_PARTS_DIAG` 开关后）。理由：全量刷新在健康
 *   状态下应当是低频事件，「高频」本身就是缺陷信号，必须无条件可见；而 PartsDiag 那
 *   类逐帧诊断才需要开关。
 * - 用**聚合**而非逐条打印来控制体积：同一 source 在窗口内反复触发时，只在首次与
 *   每第 N 次输出，并携带累计次数。这样刷屏被抑制，但「某来源触发了 300 次」这个
 *   最关键的事实反而更醒目。
 */

/**
 * 全量刷新的触发来源。每个值对应**唯一一个**调用点。
 *
 * 命名规则：`<层级>-<触发条件>`。修改调用点时必须同步这里的注释，
 * 否则日志会指向错误的位置（比没有日志更糟）。
 */
export type FullRefreshSource =
	// ── 整条消息重建（_rebuildMessageElement / replaceChild）──
	/** 责任链 fast+slow rules 全部未命中的兜底重建（`_updateMessageDom` 末尾）。 */
	| 'msg:slowpath-fallback'
	/** thinking 活跃态翻转（`_ruleThinkingStateChange`）。 */
	| 'msg:thinking-state-change'
	/**
	 * 确认卡片（安全沙箱受限→询问用户）出现或状态翻转（`_ruleConfirmationChange`）。
	 * 需全量重建才能把「允许本次」等按钮挂到 write 工具卡片上（内嵌按钮是创建卡片时
	 * 由 `confirmation` 参数决定的，无法就地补）。低频：一次裁决最多两次。
	 */
	| 'msg:confirmation-change'
	/** 流式结束且消息含结构性内容（工具卡/子代理/确认卡等），做一次干净重建（`_ruleStreamEndTransition`）。 */
	| 'msg:stream-end-structural'
	/** 流式期间检测到结构性变化（`_updateStreamingContentInPlace` → `_hasStreamingStructureChanged`）。 */
	| 'msg:streaming-structure-changed'
	/** 流式期间找不到 `.streaming-container`（`_updateStreamingContentInPlace`）。 */
	| 'msg:streaming-container-missing'
	/** 子代理已到达但对应 delegate 工具卡尚未渲染（`_updateSubAgentCardsInPlace`）。 */
	| 'msg:subagent-card-missing'
	/** 找不到 `.chat-bubble`，无法就地更新（`_reconcileParts` 调用侧）。 */
	| 'msg:bubble-missing'
	/**
	 * keyed diff 后 DOM part 数与期望不一致 → 回退全量重建
	 * （`_finalizeTurnPartsInPlace`）。**出现即说明 keyed diff 有真 bug**，
	 * 应优先排查而非容忍 —— 它同时意味着 per-turn 就地收尾退化成了全量重建。
	 */
	| 'msg:keyed-inconsistent'
	// ── 单张工具卡重建（oldCard.replaceWith）──
	/** 工具卡状态变化（running → success/error 等），整卡重建。 */
	| 'card:status-change'
	/** `tool_args` 后到，补齐占位态卡片（见 toolCardArgsRefresh）。 */
	| 'card:args-arrived'
	/** 卡片此前无进度条，progress 后到需重建补上。 */
	| 'card:progress-row-missing'
	// ── markdown 子树全量替换（replaceChildren）──
	/** 增量渲染失败（块结构失配），回退离屏全量渲染 + 原子替换（`StreamingRenderScheduler._flush`）。 */
	| 'md:incremental-failed';

/** 一次全量刷新的规模指标 —— 用于判断「这次重建有多贵」。 */
export interface IFullRefreshMetrics {
	readonly msgId?: string;
	readonly isStreaming?: boolean;
	/** parts 数量：重建成本与它正相关（每个 part 都要重新建 DOM）。 */
	readonly partsLen?: number;
	/** 工具卡数量。 */
	readonly toolCalls?: number;
	/** 文本总长度（字符）—— markdown 重解析成本与它正相关。 */
	readonly contentLen?: number;
	/** 工具卡重建时的卡片标识（便于确认是同一张卡在反复重建）。 */
	readonly toolId?: string;
	/** 补充说明。 */
	readonly note?: string;
}

/** 聚合输出策略：首次必打，之后每第 N 次打一条（携带累计值）。 */
const AGGREGATE_EVERY = 20;

/**
 * 聚合窗口（ms）。超过该间隔未再触发则视为新一轮，计数归零 ——
 * 否则跨 turn 的累计值会掩盖「本轮是否异常」。
 */
const AGGREGATE_WINDOW_MS = 5000;

interface ISourceState {
	count: number;
	lastAt: number;
	/** 本窗口内已输出过的次数，用于决定是否到了该输出的那一条。 */
	printedAtCount: number;
}

/**
 * 全量刷新记录器。
 *
 * 刻意不做成模块级单例：面板可能多开（多个 chat editor），各自独立计数才能反映
 * 单个面板的健康度。
 */
export class FullRefreshLogger {

	private readonly _states = new Map<FullRefreshSource, ISourceState>();

	/**
	 * @param _sink 输出函数。默认 `console.info` —— renderer 的 console 会被
	 *              `platform/log` 转写进 `vscode-app-*.log`（实测 `log.ts:117 INFO`
	 *              前缀即来自此），故用户导出日志时这些记录会一并带上。
	 * @param _now  时间源，便于单测注入。
	 */
	constructor(
		private readonly _sink: (msg: string) => void = (m) => console.info(m),
		private readonly _now: () => number = () => Date.now(),
	) { }

	/**
	 * 记录一次全量刷新。
	 *
	 * @returns 本次是否实际输出了日志（供单测断言聚合行为）。
	 */
	record(source: FullRefreshSource, metrics: IFullRefreshMetrics = {}): boolean {
		const now = this._now();
		let st = this._states.get(source);
		if (!st || now - st.lastAt > AGGREGATE_WINDOW_MS) {
			st = { count: 0, lastAt: now, printedAtCount: 0 };
			this._states.set(source, st);
		}
		st.count++;
		st.lastAt = now;

		// 首次必打；之后每 AGGREGATE_EVERY 次打一条
		const shouldPrint = st.count === 1 || st.count - st.printedAtCount >= AGGREGATE_EVERY;
		if (!shouldPrint) { return false; }
		st.printedAtCount = st.count;
		this._sink(formatFullRefreshLog(source, metrics, st.count));
		return true;
	}

	/**
	 * 输出本轮各来源的累计汇总（建议在流式结束时调用）。
	 *
	 * 这是排查抖动最有价值的一条日志：一眼看出「哪个来源触发最多」。
	 */
	flushSummary(context?: string): void {
		if (this._states.size === 0) { return; }
		const rows = [...this._states.entries()]
			.filter(([, st]) => st.count > 0)
			.sort((a, b) => b[1].count - a[1].count)
			.map(([src, st]) => `${src}×${st.count}`);
		if (rows.length === 0) { return; }
		const total = [...this._states.values()].reduce((s, st) => s + st.count, 0);
		this._sink(`[FullRefresh] SUMMARY${context ? ` (${context})` : ''} total=${total} — ${rows.join(', ')}`);
		this._states.clear();
	}

	/** 当前某来源的累计次数（单测/调试用）。 */
	countOf(source: FullRefreshSource): number {
		return this._states.get(source)?.count ?? 0;
	}
}

/**
 * 格式化单条全量刷新日志。
 *
 * 抽成独立函数以便单测断言格式 —— 日志格式是**对外契约**（我会用 grep/正则从
 * 用户导出的日志里提取统计），随意改动会让既有分析脚本失效。
 */
export function formatFullRefreshLog(
	source: FullRefreshSource,
	m: IFullRefreshMetrics,
	occurrence: number,
): string {
	const parts: string[] = [`[FullRefresh] source=${source}`];
	if (occurrence > 1) { parts.push(`×${occurrence}`); }
	if (m.msgId) { parts.push(`msgId=${m.msgId}`); }
	if (m.toolId) { parts.push(`toolId=${m.toolId}`); }
	if (m.isStreaming !== undefined) { parts.push(`streaming=${m.isStreaming}`); }
	if (m.partsLen !== undefined) { parts.push(`parts=${m.partsLen}`); }
	if (m.toolCalls !== undefined) { parts.push(`toolCalls=${m.toolCalls}`); }
	if (m.contentLen !== undefined) { parts.push(`contentLen=${m.contentLen}`); }
	if (m.note) { parts.push(`note=${m.note}`); }
	return parts.join(' ');
}
