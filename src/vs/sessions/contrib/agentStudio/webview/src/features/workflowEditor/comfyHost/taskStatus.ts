/*---------------------------------------------------------------------------------------------
 *  Task Status — pure model for cross-session run/task tracking (P1).
 *
 *  Docs: docs/Agent-画布编排设计方案.md P1 → taskId + canvas_get_task_status.
 *
 *  `runGraphExecution` returns a GraphRunResult with a stable taskId; this module
 *  turns that result into a serializable TaskStatus consumed by the host's
 *  canvas_get_task_status tool and the <canvas_context> tag. Pure + DOM-free.
 *--------------------------------------------------------------------------------------------*/

import type { GraphRunResult } from './workflowRun.js';

export type TaskState = 'running' | 'success' | 'error';

export interface TaskStepStatus {
	nodeId: string;
	label: string;
	runState: 'success' | 'error';
	durationMs?: number;
	errorMsg?: string;
	/** Snapshot refs produced by this node (for "结果归属"). */
	snapshotRefs: string[];
}

export interface TaskStatus {
	taskId: string;
	state: TaskState;
	/** ISO time the task was created. */
	createdAt: string;
	/** Optional ISO time the task finished (running tasks omit this). */
	finishedAt?: string;
	ran: number;
	total: number;
	failed: number;
	steps: TaskStepStatus[];
	/** First error message, when state === 'error'. */
	error?: string;
	layerStats?: { layer: number; total: number; ran: number; failed: number }[];
	/** Generic progress 0–100 (best-effort: finished steps / total). */
	progress: number;
}

/**
 * Build a TaskStatus from a GraphRunResult.
 * When `isRunning` is true (a run is in-flight) the task is reported as
 * 'running' with steps completed so far.
 *
 * `snapshotRefsFor` is injected so the module stays storage-agnostic: the
 * caller (webview) maps a node id → the snapshot refs in MediaSnapshotStore.
 */
export function buildTaskStatus(
	taskId: string,
	result: GraphRunResult,
	options: {
		isRunning?: boolean;
		createdAt?: string;
		snapshotRefsFor?: (nodeId: string) => string[];
		labels?: Record<string, string>;
	} = {},
): TaskStatus {
	const createdAt = options.createdAt ?? new Date().toISOString();
	const steps: TaskStepStatus[] = [];
	const ran = result.ran.length;
	const failed = result.failed ? 1 : 0;

	for (const id of result.ran) {
		const r = result.results[id];
		steps.push({
			nodeId: id,
			label: options.labels?.[id] ?? id,
			runState: 'success',
			durationMs: r?.durationMs,
			snapshotRefs: options.snapshotRefsFor?.(id) ?? [],
		});
	}
	if (result.failed) {
		steps.push({
			nodeId: result.failed.nodeId,
			label: options.labels?.[result.failed.nodeId] ?? result.failed.nodeId,
			runState: 'error',
			errorMsg: result.failed.error,
			snapshotRefs: options.snapshotRefsFor?.(result.failed.nodeId) ?? [],
		});
	}

	const total = options.isRunning ? ran + failed + 1 : ran + failed;
	const state: TaskState = options.isRunning ? 'running' : result.success ? 'success' : 'error';

	return {
		taskId,
		state,
		createdAt,
		...(state === 'success' || state === 'error' ? { finishedAt: new Date().toISOString() } : {}),
		ran,
		total,
		failed,
		steps,
		...(result.failed ? { error: result.failed.error } : {}),
		...(result.layerStats ? { layerStats: result.layerStats } : {}),
		progress: total > 0 ? Math.round((ran / total) * 100) : 100,
	};
}

/**
 * Format a TaskStatus into tool text. Pure.
 */
export function formatTaskStatus(status: TaskStatus): string {
	const stateLabel = status.state === 'running' ? '运行中'
		: status.state === 'success' ? '成功'
		: '失败';
	const lines: string[] = [
		`任务 ${status.taskId}：${stateLabel}（进度 ${status.progress}%，完成 ${status.ran}/${status.total}，失败 ${status.failed}）`,
	];
	for (const s of status.steps) {
		const state = s.runState === 'success' ? '✓' : '✗';
		const dur = s.durationMs != null ? `，${s.durationMs}ms` : '';
		const err = s.errorMsg ? `：${s.errorMsg}` : '';
		const refs = s.snapshotRefs.length ? `，产物: ${s.snapshotRefs.join(', ')}` : '';
		lines.push(`  ${state} ${s.label}${dur}${err}${refs}`);
	}
	return lines.join('\n');
}
