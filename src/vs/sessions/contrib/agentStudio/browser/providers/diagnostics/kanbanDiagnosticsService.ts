/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IAgentTaskBoardService } from '../../../common/agentStudio.js';
import type { TaskBoardRecord } from '../../../common/types.js';
import { TaskBoardStatus } from '../../../common/types.js';
import {
	IKanbanDiagnosticsService,
	Diagnostic,
	DiagnosticRule,
	DiagnosticSeverity,
	DiagnosticAction,
	DIAGNOSTIC_THRESHOLDS,
} from '../../../common/kanbanDiagnosticsService.js';

/** 定时巡检间隔（ms）。默认 5 分钟。 */
const SCAN_INTERVAL_MS = 5 * 60 * 1000;
/** onDidChangeTaskBoard 事件触发后，去抖延迟（ms），避免连续写入触发风暴。 */
const EVENT_DEBOUNCE_MS = 4000;

interface DiagnosticState {
	firstSeenAt: number;
	lastSeenAt: number;
	count: number;
	dismissedUntilResolved: boolean;
}

/**
 * 看板诊断服务实现。
 *
 * 触发方式：
 *  - 定时：每 SCAN_INTERVAL_MS 全量巡检一次。
 *  - 事件：监听 IAgentTaskBoardService.onDidChangeTaskBoard，去抖后巡检。
 *
 * 状态管理：每个诊断项以 `${rule}:${taskId}` 为稳定 id，跨轮次累积
 * firstSeenAt / count；不再满足条件时自动消解（从活跃集合移除）。
 * dismissDiagnostic() 将其标记为"已忽略，直到再次消解"，避免反复打扰。
 */
export class KanbanDiagnosticsService extends Disposable implements IKanbanDiagnosticsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidDetectDiagnostic = this._register(new Emitter<Diagnostic>());
	readonly onDidDetectDiagnostic: Event<Diagnostic> = this._onDidDetectDiagnostic.event;

	private readonly _onDidChangeDiagnostics = this._register(new Emitter<Diagnostic[]>());
	readonly onDidChangeDiagnostics: Event<Diagnostic[]> = this._onDidChangeDiagnostics.event;

	/** 活跃诊断：id → Diagnostic */
	private readonly _active = new Map<string, Diagnostic>();
	/** 诊断状态（跨轮次累积）：id → state */
	private readonly _state = new Map<string, DiagnosticState>();

	private _scanTimer: ReturnType<typeof setInterval> | undefined;
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _running = false;

	constructor(
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// 事件触发（去抖）。
		this._register(this.taskBoardService.onDidChangeTaskBoard(() => {
			this._scheduleDebouncedScan();
		}));

		// 定时触发。
		this._scanTimer = setInterval(() => {
			void this.runDiagnostics();
		}, SCAN_INTERVAL_MS);
		this._register({ dispose: () => { if (this._scanTimer) { clearInterval(this._scanTimer); } } });
		this._register({ dispose: () => { if (this._debounceTimer) { clearTimeout(this._debounceTimer); } } });
	}

	private _scheduleDebouncedScan(): void {
		if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
		this._debounceTimer = setTimeout(() => {
			this._debounceTimer = undefined;
			void this.runDiagnostics();
		}, EVENT_DEBOUNCE_MS);
	}

	getActiveDiagnostics(): Diagnostic[] {
		return Array.from(this._active.values());
	}

	dismissDiagnostic(diagnosticId: string): void {
		const state = this._state.get(diagnosticId);
		if (state) {
			state.dismissedUntilResolved = true;
		}
		if (this._active.delete(diagnosticId)) {
			this._onDidChangeDiagnostics.fire(this.getActiveDiagnostics());
		}
	}

	async runDiagnostics(workspaceId?: string): Promise<Diagnostic[]> {
		if (this._running) {
			// 避免并发巡检；返回当前快照。
			return this.getActiveDiagnostics();
		}
		this._running = true;
		try {
			const tasks = await this.taskBoardService.getTasks(workspaceId);
			const now = Date.now();

			// 收集本轮命中的诊断 id，用于消解不再命中的旧诊断。
			const hitIds = new Set<string>();

			for (const rule of this._rules()) {
				const findings = rule(tasks, now);
				for (const finding of findings) {
					hitIds.add(finding.id);
					this._upsertDiagnostic(finding, now);
				}
			}

			// 消解：本轮未命中的活跃诊断 → 移除并清除 dismiss 标记。
			let changed = false;
			for (const id of Array.from(this._active.keys())) {
				if (!hitIds.has(id)) {
					this._active.delete(id);
					this._state.delete(id); // 完全消解后清空状态（允许将来重新提示）
					changed = true;
				}
			}
			if (changed) {
				this._onDidChangeDiagnostics.fire(this.getActiveDiagnostics());
			}

			return this.getActiveDiagnostics();
		} catch (err) {
			this.logService.error('[KanbanDiagnostics] runDiagnostics failed', err);
			return this.getActiveDiagnostics();
		} finally {
			this._running = false;
		}
	}

	/**
	 * upsert 一个本轮命中的诊断（finding 为不含累积字段的草案）。
	 */
	private _upsertDiagnostic(finding: RawFinding, now: number): void {
		let state = this._state.get(finding.id);
		if (!state) {
			state = { firstSeenAt: now, lastSeenAt: now, count: 1, dismissedUntilResolved: false };
			this._state.set(finding.id, state);
		} else {
			state.lastSeenAt = now;
			state.count += 1;
		}

		// 被 dismiss 的诊断在再次消解前不重新提示。
		if (state.dismissedUntilResolved) {
			return;
		}

		const diagnostic: Diagnostic = {
			id: finding.id,
			kind: finding.kind,
			severity: finding.severity,
			title: finding.title,
			detail: finding.detail,
			taskId: finding.taskId,
			workspaceId: finding.workspaceId,
			actions: finding.actions,
			firstSeenAt: state.firstSeenAt,
			lastSeenAt: state.lastSeenAt,
			count: state.count,
			data: finding.data,
		};

		const existed = this._active.has(finding.id);
		this._active.set(finding.id, diagnostic);
		if (!existed) {
			// 仅在首次进入活跃集合时 fire detect（避免每轮刷屏）。
			this._onDidDetectDiagnostic.fire(diagnostic);
			this._onDidChangeDiagnostics.fire(this.getActiveDiagnostics());
		}
	}

	// ─── 规则集 ───────────────────────────────────────────────────────────

	private _rules(): Array<(tasks: TaskBoardRecord[], now: number) => RawFinding[]> {
		return [
			this._ruleTriageNotActionable.bind(this),
			this._ruleStuckInBlocked.bind(this),
			this._ruleStrandedInReady.bind(this),
			this._ruleRepeatedFailures.bind(this),
		];
	}

	private _ageMs(task: TaskBoardRecord, now: number): number {
		const ts = Date.parse(task.updatedAt ?? task.createdAt ?? '');
		if (Number.isNaN(ts)) { return 0; }
		return now - ts;
	}

	private _ruleTriageNotActionable(tasks: TaskBoardRecord[], now: number): RawFinding[] {
		const out: RawFinding[] = [];
		for (const t of tasks) {
			if (t.status !== TaskBoardStatus.Triage) { continue; }
			const age = this._ageMs(t, now);
			if (age >= DIAGNOSTIC_THRESHOLDS.triageStaleMs) {
				out.push({
					id: `${DiagnosticRule.TriageNotActionable}:${t.id}`,
					kind: DiagnosticRule.TriageNotActionable,
					severity: 'warning',
					title: `待规划任务未推进`,
					detail: `任务「${t.title}」已在「待规划」停留 ${this._fmtAge(age)}，尚未细化或分解。`,
					taskId: t.id,
					workspaceId: t.workspaceId,
					actions: [
						{ type: 'specify', taskId: t.id },
						{ type: 'decompose', taskId: t.id },
						{ type: 'dismiss' },
					],
					data: { ageMs: age },
				});
			}
		}
		return out;
	}

	private _ruleStuckInBlocked(tasks: TaskBoardRecord[], now: number): RawFinding[] {
		const out: RawFinding[] = [];
		for (const t of tasks) {
			if (t.status !== TaskBoardStatus.Blocked) { continue; }
			const age = this._ageMs(t, now);
			if (age >= DIAGNOSTIC_THRESHOLDS.blockedStuckMs) {
				out.push({
					id: `${DiagnosticRule.StuckInBlocked}:${t.id}`,
					kind: DiagnosticRule.StuckInBlocked,
					severity: 'error',
					title: `任务长期阻塞`,
					detail: `任务「${t.title}」已阻塞 ${this._fmtAge(age)} 无人解除。`,
					taskId: t.id,
					workspaceId: t.workspaceId,
					actions: [
						{ type: 'unblock', taskId: t.id },
						{ type: 'cancel', taskId: t.id },
						{ type: 'dismiss' },
					],
					data: { ageMs: age },
				});
			}
		}
		return out;
	}

	private _ruleStrandedInReady(tasks: TaskBoardRecord[], now: number): RawFinding[] {
		const out: RawFinding[] = [];
		for (const t of tasks) {
			if (t.status !== TaskBoardStatus.Ready && t.status !== TaskBoardStatus.Todo) { continue; }
			const age = this._ageMs(t, now);
			if (age >= DIAGNOSTIC_THRESHOLDS.readyStrandedMs) {
				out.push({
					id: `${DiagnosticRule.StrandedInReady}:${t.id}`,
					kind: DiagnosticRule.StrandedInReady,
					severity: 'warning',
					title: `任务长期未认领`,
					detail: `任务「${t.title}」已就绪 ${this._fmtAge(age)} 但一直未开始执行。`,
					taskId: t.id,
					workspaceId: t.workspaceId,
					actions: [
						{ type: 'reclaim', taskId: t.id },
						{ type: 'dismiss' },
					],
					data: { ageMs: age, status: t.status },
				});
			}
		}
		return out;
	}

	private _ruleRepeatedFailures(tasks: TaskBoardRecord[], _now: number): RawFinding[] {
		const out: RawFinding[] = [];
		for (const t of tasks) {
			// 启发式：description 中 [BLOCKED] 标记出现次数 ≥ 阈值 → 反复失败。
			const desc = t.description ?? '';
			const blockedMarks = (desc.match(/\[BLOCKED\]/g) || []).length;
			if (blockedMarks >= DIAGNOSTIC_THRESHOLDS.repeatedFailureCount) {
				out.push({
					id: `${DiagnosticRule.RepeatedFailures}:${t.id}`,
					kind: DiagnosticRule.RepeatedFailures,
					severity: 'error',
					title: `任务反复失败`,
					detail: `任务「${t.title}」已被阻塞标记 ${blockedMarks} 次，可能需要重新分解或人工介入。`,
					taskId: t.id,
					workspaceId: t.workspaceId,
					actions: [
						{ type: 'decompose', taskId: t.id },
						{ type: 'cancel', taskId: t.id },
						{ type: 'dismiss' },
					],
					data: { blockedMarks },
				});
			}
		}
		return out;
	}

	private _fmtAge(ms: number): string {
		const min = Math.floor(ms / 60000);
		if (min < 60) { return `${min} 分钟`; }
		const hr = Math.floor(min / 60);
		const rem = min % 60;
		return rem ? `${hr} 小时 ${rem} 分钟` : `${hr} 小时`;
	}
}

/** 规则函数产出的原始 finding（不含跨轮次累积字段）。 */
interface RawFinding {
	readonly id: string;
	readonly kind: DiagnosticRule;
	readonly severity: DiagnosticSeverity;
	readonly title: string;
	readonly detail: string;
	readonly taskId?: string;
	readonly workspaceId?: string;
	readonly actions: DiagnosticAction[];
	readonly data: Record<string, unknown>;
}
