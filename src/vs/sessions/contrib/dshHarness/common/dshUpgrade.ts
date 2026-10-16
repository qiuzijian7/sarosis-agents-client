/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 升级闸门（方案第 3.3 节）的共享类型与纯判定逻辑。
 * 流程：运行中任务检查 → 快照 → 切换指针并重启 → 健康检查 → 失败自动回退。
 */

/** 伴生插件 `host.activity` 的返回：只含会话 id 与活动类别，不含会话内容。 */
export interface IHostActivity {
	/** Host 内存中的活 Agent 数（已加载的会话，不论是否在运行）。 */
	readonly live: number;
	readonly sessions: readonly { readonly sessionId: string; readonly kinds: readonly string[] }[];
}

/**
 * 只有这些类别会阻止升级。`schedule`（会话上挂着定时提醒）不阻止：它持久化在会话里，
 * Host 重启后由 dsh 恢复；而 turn / job / subagent 是正在执行的工作，重启会中断它们。
 */
export function blockingSessions(activity: IHostActivity): string[] {
	return activity.sessions.filter(s => s.kinds.some(k => k !== 'schedule')).map(s => s.sessionId);
}

export type DshUpgradeOutcome = 'switched' | 'unchanged' | 'blocked' | 'rolled-back' | 'failed';

export interface IDshUpgradeRequest {
	readonly version: string;
	/** 用户已确认中断运行中的任务。 */
	readonly force?: boolean;
}

export interface IDshHealthReport {
	readonly ok: boolean;
	readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail?: string }[];
}

export interface IDshUpgradeResult {
	readonly outcome: DshUpgradeOutcome;
	readonly from?: string;
	readonly to: string;
	/** blocked 时：正在运行的会话数；-1 表示控制桥不可用、无法判断。 */
	readonly running?: number;
	readonly snapshot?: string;
	readonly health?: IDshHealthReport;
	readonly error?: string;
}

export function summarizeHealth(checks: IDshHealthReport['checks']): IDshHealthReport {
	return { ok: checks.length > 0 && checks.every(c => c.ok), checks };
}

/** 快照目录名：`20261009T063552-0.2.0-rc.2-to-0.2.1-alpha.1`（可排序、可读）。 */
export function snapshotName(now: Date, from: string | undefined, to: string): string {
	const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
	return `${ts}-${from ?? 'none'}-to-${to}`;
}

/** 保留最近 `keep` 个快照，返回应删除的目录名（名称按时间前缀排序）。 */
export function snapshotsToPrune(names: readonly string[], keep: number): string[] {
	const valid = names.filter(n => /^\d{8}T\d{6}-/.test(n)).sort();
	return valid.slice(0, Math.max(0, valid.length - keep));
}
