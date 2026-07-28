/*---------------------------------------------------------------------------------------------
 *  subAgentCardReducer — SubAgentEvent → Card State 纯函数
 *
 *  提取自 planExploreTool 内联 inlineTraceSink 的事件→卡片状态映射核心逻辑。
 *  纯函数、无副作用（仅修改传入的 card 对象），可直接单测。
 *
 *  SubAgentEvent 由 unifiedSubAgentDispatch._executeWithBudget 产出，
 *  planExploreTool / delegationTools 的 inlineTraceSink 用此函数驱动卡片快照。
 *--------------------------------------------------------------------------------------------*/

import { SubAgentEventType, type SubAgentEvent } from './unifiedSubAgentDispatch.js';

/**
 * 卡片可变状态（与 planExploreTool 内联 MutableCard 对齐）。
 * reduceCardState 直接原地修改此对象。
 */
export interface MutableCardState {
	readonly id: string;
	/** Agent type badge. 'explore' | 'general' | 'scout' | any registered agent name (e.g. 'code-explorer'). */
	type: string;
	task: string;
	status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	progress?: string;
	output?: string;
	/** 累积的实时文本（TextDelta 事件追加），running 时 UI 显示此字段 */
	streamingOutput?: string;
	error?: string;
	toolTraces: Array<{
		id: string;
		name: string;
		status: 'running' | 'done' | 'error';
		args?: string;
		result?: string;
	}>;
	/** 累积的 thinking 文本（Thinking 事件追加），running 时 UI 显示此字段 */
	thinking?: string;
	/** 子代理开始时间（Spawned/建卡时记录，epoch ms），供 UI 计算时长 */
	startedAt?: number;
	/** 子代理结束时间（Completed/Failed/Interrupted 时记录，epoch ms） */
	completedAt?: number;
}

/**
 * 创建一个空的 running 卡片（Spawned 事件未到达时建卡入口）。
 *
 * @param id   子 agent 唯一标识（dispatch 内部 subAgentId）
 * @param type 子 agent 类型
 * @param task 任务标题
 */
export function createEmptyCard(
	id: string,
	type: MutableCardState['type'],
	task: string,
): MutableCardState {
	return { id, type, task, status: 'running', toolTraces: [], startedAt: Date.now() };
}

/**
 * 根据 SubAgentEvent 原地更新卡片状态（纯函数，仅修改 card 对象）。
 *
 * 覆盖事件类型：
 *   Spawned       → status=running
 *   ToolStarted   → 追加 running trace（幂等：同 traceId 不重复）
 *   ToolCompleted → 按同名+最近原则收敛 running trace 为 done/error（幂等）
 *   Progress      → 更新 progress 文本
 *   Completed     → status=done，output 截断 2000B，收敛残留 running→done
 *   Failed        → status=error，收敛 running→error
 *   Interrupted   → status=cancelled，收敛 running→error
 *
 * @returns 传入的 card 对象（原地修改后返回，链式调用）
 */
export function reduceCardState(
	card: MutableCardState,
	event: SubAgentEvent,
): MutableCardState {
	switch (event.type) {
	case SubAgentEventType.Spawned:
		// Follow-up 复用（2026-07-26）：同一 subAgentId 开启新任务周期——
		// 卡片重置过程数据（保留 id/type；task 更新为新任务），
		// 避免新任务沿用上一周期的 traces/output。
		if (card.status !== 'running' && card.status !== 'pending') {
			card.task = event.task ?? card.task;
			card.output = undefined;
			card.error = undefined;
			card.thinking = undefined;
			card.streamingOutput = undefined;
			card.progress = undefined;
			card.toolTraces = [];
			card.startedAt = Date.now();
			card.completedAt = undefined;
		}
		card.status = 'running';
		break;

	case SubAgentEventType.ToolStarted: {
			const traceId = `${event.subAgentId}-t${event.toolsCompleted ?? card.toolTraces.length}`;
			if (!card.toolTraces.some(t => t.id === traceId)) {
				card.toolTraces.push({
					id: traceId,
					name: event.toolName || 'tool',
					status: 'running',
					args: event.toolArgsPreview,
				});
			}
			card.progress = `正在执行: ${event.toolName || 'tool'}`;
			break;
		}

		case SubAgentEventType.ToolCompleted: {
			// 幂等收敛：优先最近同名 running，否则最近任一 running，否则补一条终态。
			const running = [...card.toolTraces].reverse();
			const hit = running.find(
				t => t.status === 'running' && t.name === (event.toolName || 'tool'),
			) ?? running.find(t => t.status === 'running');

			if (hit) {
				hit.status = event.toolStatus === 'error' ? 'error' : 'done';
				if (event.toolResultPreview) {
					hit.result = event.toolResultPreview;
				}
			} else {
				card.toolTraces.push({
					id: `${event.subAgentId}-t${card.toolTraces.length}`,
					name: event.toolName || 'tool',
					status: event.toolStatus === 'error' ? 'error' : 'done',
					result: event.toolResultPreview,
				});
			}
			break;
		}

		case SubAgentEventType.Progress:
			if (event.progressNote) {
				card.progress = event.progressNote;
			}
			break;

		case SubAgentEventType.Completed:
			card.status = 'done';
			card.progress = undefined;
			card.completedAt = Date.now();
			if (event.output) {
				card.output = event.output.slice(0, 2000);
			}
			// R5: 收敛残留 running trace
			card.toolTraces.forEach(t => {
				if (t.status === 'running') { t.status = 'done'; }
			});
			break;

		case SubAgentEventType.Failed:
			card.status = 'error';
			card.error = event.error;
			card.completedAt = Date.now();
			card.toolTraces.forEach(t => {
				if (t.status === 'running') { t.status = 'error'; }
			});
			break;

		case SubAgentEventType.Interrupted:
			card.status = 'cancelled';
			card.error = event.error || 'Interrupted';
			card.completedAt = Date.now();
			card.toolTraces.forEach(t => {
				if (t.status === 'running') { t.status = 'error'; }
			});
			break;

		case SubAgentEventType.TextDelta:
			// 累积实时文本，running 时 UI 显示 streamingOutput（实时滚动）
			card.streamingOutput = (card.streamingOutput ?? '') + (event.textDelta ?? '');
			// 限制累积长度，避免超长流式输出爆内存
			if (card.streamingOutput.length > 8000) {
				card.streamingOutput = card.streamingOutput.slice(-8000);
			}
			break;

		case SubAgentEventType.Thinking:
			// Thinking 事件累积到卡片 thinking 字段，供 UI 实时显示
			if (event.thinkingText) {
				card.thinking = (card.thinking ?? '') + event.thinkingText;
				if (card.thinking.length > 4000) {
					card.thinking = card.thinking.slice(-4000);
				}
			}
			break;
	}

	return card;
}
