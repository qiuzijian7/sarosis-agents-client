/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

// ─── Kanban Diagnostics Service ─────────────────────────────────────────────
// 看板健康巡检：定时 + 事件触发地扫描任务板，发现"卡住/失败/不可执行"等异常，
// 产出可消费的诊断项（含建议操作）。对应 Hermes 的 kanban 健康检查机制。

export const IKanbanDiagnosticsService = createDecorator<IKanbanDiagnosticsService>('kanbanDiagnosticsService');

export interface IKanbanDiagnosticsService {
	readonly _serviceBrand: undefined;

	/** 每当检测到一个新的（或再次出现的）诊断项时触发。 */
	readonly onDidDetectDiagnostic: Event<Diagnostic>;

	/** 每当诊断集合发生变化（新增/消解/dismiss）时触发，携带当前活跃诊断快照。 */
	readonly onDidChangeDiagnostics: Event<Diagnostic[]>;

	/**
	 * 立即对指定 workspace（省略=全部）的任务板运行一次完整诊断。
	 * @returns 当前活跃的诊断项列表
	 */
	runDiagnostics(workspaceId?: string): Promise<Diagnostic[]>;

	/** 获取当前活跃（未 dismiss、未消解）的诊断项快照。 */
	getActiveDiagnostics(): Diagnostic[];

	/** 手动忽略一个诊断项（在其再次满足条件前不再提示）。 */
	dismissDiagnostic(diagnosticId: string): void;
}

export enum DiagnosticRule {
	/** triage 任务长期停留、未被 specify/decompose 推进。 */
	TriageNotActionable = 'triage_not_actionable',
	/** 同一任务反复失败（多次回到 todo / 多次取消重试）。 */
	RepeatedFailures = 'repeated_failures',
	/** 任务长期处于 blocked，无人解除。 */
	StuckInBlocked = 'stuck_in_blocked',
	/** 任务长期处于 ready/todo 无人认领执行。 */
	StrandedInReady = 'stranded_in_ready',
}

export type DiagnosticSeverity = 'warning' | 'error' | 'critical';

export type DiagnosticAction =
	| { readonly type: 'unblock'; readonly taskId: string }
	| { readonly type: 'reclaim'; readonly taskId: string }
	| { readonly type: 'specify'; readonly taskId: string }
	| { readonly type: 'decompose'; readonly taskId: string }
	| { readonly type: 'cancel'; readonly taskId: string }
	| { readonly type: 'dismiss' };

export interface Diagnostic {
	readonly id: string;
	readonly kind: DiagnosticRule;
	readonly severity: DiagnosticSeverity;
	readonly title: string;
	readonly detail: string;
	readonly taskId?: string;
	readonly workspaceId?: string;
	readonly actions: DiagnosticAction[];
	readonly firstSeenAt: number;
	readonly lastSeenAt: number;
	/** 该诊断连续被检出的次数（用于升级 severity / 去抖）。 */
	readonly count: number;
	readonly data: Record<string, unknown>;
}

// ─── 诊断阈值（可被实现覆盖；此处为默认值，便于跨层共享）────────────────

export const DIAGNOSTIC_THRESHOLDS = {
	/** triage 任务停留超过此时长（ms）判为 not-actionable。默认 30 分钟。 */
	triageStaleMs: 30 * 60 * 1000,
	/** blocked 任务停留超过此时长（ms）判为 stuck。默认 60 分钟。 */
	blockedStuckMs: 60 * 60 * 1000,
	/** ready/todo 任务停留超过此时长（ms）判为 stranded。默认 120 分钟。 */
	readyStrandedMs: 120 * 60 * 1000,
	/** description 中出现 [BLOCKED] 标记达到此次数判为 repeated failures。默认 3。 */
	repeatedFailureCount: 3,
} as const;
