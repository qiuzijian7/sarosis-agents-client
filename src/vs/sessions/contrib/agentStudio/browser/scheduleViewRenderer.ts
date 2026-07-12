/*---------------------------------------------------------------------------------------------
 *  Agent Studio - Schedule View Renderer (Native DOM)
 *
 *  Plan D: the "定时任务" view of the task board (a table-based schedule
 *  management surface) plus the create/edit schedule modal. Rendered with
 *  vanilla DOM (no webview / React), consistent with taskBoardNativeRenderer.
 *
 *  This renderer is a pure view: it renders IScheduleInfo records produced by
 *  IAgentSchedulerService and emits intent events / a draft object that the
 *  owning editor pane turns into real scheduler registrations.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { TaskBoardRecord } from '../../../common/agentStudioTypes.js';
import { CronParser } from '../common/cronParser.js';
import { ScheduleState } from '../common/agentScheduler.js';
import type {
	ScheduleType,
	IScheduleInfo,
	IScheduleInput,
	ICronScheduleConfig,
	IIntervalConfig,
	IOneShotConfig,
} from '../common/agentScheduler.js';

// ─── Schedule draft / prefill (the contract with the editor pane) ─────────

/** A draft produced by the create/edit modal, consumed by the pane. */
export interface ScheduleDraft {
	/** Target task id (also the source of assigneeId / workspaceId in the pane). */
	taskId: string;
	/** Only cron / interval / one-shot are editable through this modal. */
	type: 'cron' | 'interval' | 'one-shot';
	cronExpression?: string;
	intervalMs?: number;
	triggerAt?: number;
	maxRetries: number;
	/** Set when editing an existing schedule — the pane removes + re-registers. */
	existingId?: string;
}

/** Pre-fill values for the edit modal, derived from an existing IScheduleInfo. */
export interface ScheduleEditPrefill {
	id: string;
	taskId: string;
	type: 'cron' | 'interval' | 'one-shot';
	cronExpression?: string;
	intervalMs?: number;
	triggerAt?: number;
	maxRetries: number;
}

// ─── Style Injection ────────────────────────────────────────────────────────

let _stylesInjected = false;

/** Inject the schedule-view + tab-bar + schedule-modal styles once. */
export function injectScheduleStyles(): void {
	if (_stylesInjected) { return; }
	_stylesInjected = true;

	const css = `
/* ===== View Tab Bar (Plan D) ===== */
.sched-tab-bar {
	display: flex; align-items: center; padding: 0 12px;
	background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
	border-bottom: 1px solid var(--vscode-panel-border, #333);
	flex-shrink: 0;
}
.sched-view-tab {
	display: flex; align-items: center; gap: 6px;
	padding: 9px 16px; font-size: 12px; font-weight: 500;
	color: #888; cursor: pointer; border: none; background: transparent;
	border-bottom: 2px solid transparent; transition: all 0.15s; white-space: nowrap;
}
.sched-view-tab:hover { color: #ccc; background: rgba(255,255,255,0.03); }
.sched-view-tab.active { color: #e0e0e0; border-bottom-color: #a855f7; }
.sched-view-tab .sched-tab-icon { font-size: 14px; }
.sched-view-tab .sched-tab-badge {
	font-size: 10px; padding: 1px 6px; border-radius: 8px;
	background: #3a3a3a; color: #888; margin-left: 2px;
}
.sched-view-tab.active .sched-tab-badge { background: rgba(168,85,247,0.2); color: #c4b5fd; }
.sched-tab-spacer { flex: 1; }

/* ===== Schedule View ===== */
.sched-view {
	flex: 1; display: flex; flex-direction: column; min-height: 0;
	overflow: hidden; position: relative;
}
.sched-stats-row {
	display: grid; grid-template-columns: repeat(4, 1fr);
	gap: 12px; padding: 12px 16px;
	border-bottom: 1px solid var(--vscode-panel-border, #333); flex-shrink: 0;
}
.sched-stat-card {
	padding: 12px 14px; border-radius: 8px;
	background: var(--vscode-editorWidget-background, #2a2a2c);
	border: 1px solid var(--vscode-panel-border, #3a3a3a);
	display: flex; flex-direction: column; gap: 4px; transition: border-color 0.15s;
}
.sched-stat-card:hover { border-color: #555; }
.sched-stat-icon { font-size: 15px; }
.sched-stat-value { font-size: 21px; font-weight: 700; color: #e0e0e0; }
.sched-stat-label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
.sched-stat-card.highlight {
	border-color: rgba(245,158,11,0.3);
	background: linear-gradient(135deg, #2a2a2c, rgba(245,158,11,0.06));
}
.sched-stat-card.highlight .sched-stat-value { color: #fbbf24; }

.sched-table-container { flex: 1; overflow-y: auto; padding: 0 16px 16px; }
.sched-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.sched-table thead { position: sticky; top: 0; z-index: 2; }
.sched-table th {
	text-align: left; padding: 10px 12px; font-size: 10px; font-weight: 600; color: #888;
	text-transform: uppercase; letter-spacing: 0.5px;
	border-bottom: 2px solid #3a3a3a; background: var(--vscode-editor-background, #1e1e1e);
}
.sched-table td { padding: 10px 12px; border-bottom: 1px solid #333; vertical-align: middle; }
.sched-table tbody tr { transition: background 0.12s; cursor: default; }
.sched-table tbody tr:hover { background: rgba(255,255,255,0.03); }
.sched-table tbody tr.paused-row { opacity: 0.55; }
.sched-task-col { display: flex; align-items: center; gap: 8px; }
.sched-task-icon {
	width: 28px; height: 28px; border-radius: 7px; display: flex;
	align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0;
}
.sched-task-icon.cron { background: rgba(168,85,247,0.2); }
.sched-task-icon.interval { background: rgba(0,122,204,0.2); }
.sched-task-icon.once { background: rgba(78,201,176,0.2); }
.sched-task-name { font-weight: 500; color: #e0e0e0; }
.sched-task-sub { font-size: 10px; color: #888; }
.sched-rule-col { font-family: 'Cascadia Code', 'Fira Code', monospace; color: #fbbf24; font-size: 11px; }
.sched-time-col { font-family: 'Cascadia Code', monospace; color: #4ec9b0; font-size: 11px; }
.sched-countdown {
	font-size: 11px; color: #f59e0b; background: rgba(245,158,11,0.08);
	padding: 3px 8px; border-radius: 4px; display: inline-block;
}
.sched-status-badge { font-size: 10px; padding: 3px 10px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
.sched-status-badge.active { background: rgba(78,201,176,0.15); color: #4ec9b0; }
.sched-status-badge.paused { background: rgba(204,167,0,0.15); color: #cca700; }
.sched-status-badge.completed { background: rgba(136,136,136,0.15); color: #888; }
.sched-status-badge.error { background: rgba(244,71,71,0.15); color: #f44747; }
.sched-action-col { display: flex; gap: 4px; }
.sched-row-btn {
	padding: 4px 8px; font-size: 11px; border: 1px solid #4a4a4a; border-radius: 4px;
	background: transparent; color: #aaa; cursor: pointer; transition: all 0.12s; white-space: nowrap;
}
.sched-row-btn:hover { border-color: #a855f7; color: #ddd; background: rgba(168,85,247,0.08); }
.sched-row-btn:disabled { opacity: 0.35; cursor: default; border-color: #4a4a4a; color: #666; }
.sched-row-btn:disabled:hover { background: transparent; border-color: #4a4a4a; color: #666; }

.sched-empty {
	flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
	gap: 10px; color: #888; font-size: 13px;
}
.sched-empty .sched-empty-icon { font-size: 40px; opacity: 0.5; }

.sched-view-footer {
	display: flex; align-items: center; justify-content: space-between;
	padding: 10px 16px; border-top: 1px solid var(--vscode-panel-border, #333);
	flex-shrink: 0; background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
	font-size: 11px; color: #888;
}

/* ===== Schedule Modal ===== */
.sched-modal-overlay {
	position: absolute; inset: 0; background: rgba(0,0,0,0.5);
	z-index: 1000; display: flex; align-items: center; justify-content: center;
}
.sched-modal {
	background: var(--vscode-editorWidget-background, #2d2d2d);
	border: 1px solid var(--vscode-widget-border, #454545); border-radius: 8px;
	width: 520px; max-height: 85%; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
.sched-modal-header {
	display: flex; align-items: center; justify-content: space-between;
	padding: 14px 16px; border-bottom: 1px solid #3a3a3a;
}
.sched-modal-header h2 { font-size: 14px; font-weight: 600; color: #e0e0e0; display: flex; align-items: center; gap: 8px; margin: 0; }
.sched-modal-close { background: none; border: none; color: #888; font-size: 18px; cursor: pointer; padding: 4px 8px; border-radius: 4px; }
.sched-modal-close:hover { background: #3a3a3a; color: #ddd; }
.sched-modal-body { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.sched-modal-footer { padding: 12px 16px; border-top: 1px solid #3a3a3a; display: flex; justify-content: flex-end; gap: 8px; }

.sched-form-group { display: flex; flex-direction: column; gap: 6px; }
.sched-form-label { font-size: 11px; font-weight: 500; color: #aaa; }
.sched-form-input, .sched-form-select {
	padding: 8px 10px; font-size: 12px; background: var(--vscode-input-background, #3c3c3c);
	color: var(--vscode-input-foreground, #ddd); border: 1px solid var(--vscode-input-border, #4a4a4a);
	border-radius: 5px; outline: none; font-family: inherit; transition: border-color 0.15s;
}
.sched-form-input:focus, .sched-form-select:focus { border-color: #a855f7; }
.sched-type-tabs { display: flex; gap: 2px; background: #333; border-radius: 6px; padding: 3px; }
.sched-type-tab {
	flex: 1; padding: 7px 4px; font-size: 11px; text-align: center;
	border: none; background: transparent; color: #999; cursor: pointer;
	border-radius: 4px; transition: all 0.15s; white-space: nowrap;
}
.sched-type-tab:hover { color: #ddd; }
.sched-type-tab.active { background: #a855f7; color: #fff; font-weight: 500; }
.sched-field-hint { font-size: 10px; color: #666; }
.sched-cron-presets { display: flex; flex-wrap: wrap; gap: 4px; }
.sched-cron-preset {
	padding: 4px 10px; font-size: 10px; border: 1px solid #4a4a4a; border-radius: 12px;
	background: transparent; color: #aaa; cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.sched-cron-preset:hover { border-color: #a855f7; color: #ddd; background: rgba(168,85,247,0.1); }
.sched-next-preview {
	display: flex; align-items: center; gap: 10px; padding: 10px 12px;
	background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.2); border-radius: 6px;
}
.sched-next-preview .sched-next-time { font-size: 13px; font-weight: 600; color: #fbbf24; font-family: 'Cascadia Code', monospace; }

.sched-btn {
	font-size: 12px; padding: 6px 14px; border: none; border-radius: 5px; cursor: pointer;
	background: #3a3a3a; color: #ccc; transition: background 0.15s;
}
.sched-btn:hover { background: #4a4a4a; }
.sched-btn-primary { background: #a855f7; color: #fff; }
.sched-btn-primary:hover { background: #9333ea; }
`;

	const styleEl = document.createElement('style');
	styleEl.className = 'sched-view-styles';
	styleEl.textContent = css;
	document.head.appendChild(styleEl);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const TYPE_ICON: Record<ScheduleType, string> = {
	cron: '📅', interval: '🔄', 'one-shot': '🎯', 'file-watch': '📁', event: '📡',
};

const TYPE_LABEL: Record<ScheduleType, string> = {
	cron: 'Cron',
	interval: '间隔',
	'one-shot': '一次性',
	'file-watch': '文件监听',
	event: '事件',
};

/** Read the task id stored inside a schedule's input-template context. */
function getScheduleTaskId(rule: IScheduleInfo): string | undefined {
	const tpl = (rule.config as { inputTemplate?: IScheduleInput }).inputTemplate;
	return tpl?.context?.taskId as string | undefined;
}

/** Human-readable rule description for a table cell. */
function describeRule(rule: IScheduleInfo): string {
	switch (rule.type) {
		case 'cron': return (rule.config as ICronScheduleConfig).cronExpression || '(未配置)';
		case 'interval': {
			const ms = (rule.config as IIntervalConfig).intervalMs || 0;
			if (ms >= 3600000) { return `每 ${Math.round(ms / 3600000)} 小时`; }
			if (ms >= 60000) { return `每 ${Math.round(ms / 60000)} 分钟`; }
			return `每 ${Math.round(ms / 1000)} 秒`;
		}
		case 'one-shot': {
			const at = (rule.config as IOneShotConfig).triggerAt;
			return at ? formatDateTime(at) : '(未配置)';
		}
		case 'file-watch': {
			const glob = (rule.config as { globPatterns?: string[] }).globPatterns;
			return glob && glob.length ? glob.join(', ') : '(未配置)';
		}
		case 'event': return (rule.config as { eventType?: string }).eventType || '(未配置)';
		default: return '—';
	}
}

/** Format epoch ms as `YYYY-MM-DD HH:mm`. */
export function formatDateTime(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => (n < 10 ? '0' + n : String(n));
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Format a countdown from now to `ms` as e.g. `6h 32m` / `44m` / `5d`. */
export function formatCountdown(ms: number): string {
	const diff = ms - Date.now();
	if (diff <= 0) { return '即将执行'; }
	const sec = Math.floor(diff / 1000);
	const days = Math.floor(sec / 86400);
	const hrs = Math.floor((sec % 86400) / 3600);
	const mins = Math.floor((sec % 3600) / 60);
	if (days > 0) { return `${days}d ${hrs}h`; }
	if (hrs > 0) { return `${hrs}h ${mins}m`; }
	if (mins > 0) { return `${mins}m`; }
	return `${sec}s`;
}

/** Convert a `datetime-local` input value to epoch ms. */
function parseLocalDateTime(value: string): number | undefined {
	if (!value) { return undefined; }
	const ms = new Date(value).getTime();
	return isNaN(ms) ? undefined : ms;
}

/** Convert epoch ms to a `datetime-local` input value (`YYYY-MM-DDTHH:mm`). */
function toLocalDateTimeValue(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => (n < 10 ? '0' + n : String(n));
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Next-fire preview for the modal, given the current draft type + values. */
function computeNextFire(type: ScheduleType, cronExpr: string, intervalMs: number, fireAt: number): number | undefined {
	const now = Date.now();
	if (type === 'cron') {
		if (!cronExpr) { return undefined; }
		try {
			return new CronParser().getNextFireTime(cronExpr) ?? undefined;
		} catch {
			return undefined;
		}
	}
	if (type === 'interval') { return now + intervalMs; }
	if (type === 'one-shot') { return fireAt > now ? fireAt : undefined; }
	return undefined;
}

// ─── Renderer ─────────────────────────────────────────────────────────────

export class ScheduleViewRenderer {
	private _viewEl: HTMLElement | undefined;

	private readonly _onCreateRequest = new Emitter<void>();
	readonly onCreateRequest: Event<void> = this._onCreateRequest.event;

	private readonly _onEditRequest = new Emitter<{ ruleId: string }>();
	readonly onEditRequest: Event<{ ruleId: string }> = this._onEditRequest.event;

	private readonly _onDeleteRequest = new Emitter<{ ruleId: string }>();
	readonly onDeleteRequest: Event<{ ruleId: string }> = this._onDeleteRequest.event;

	private readonly _onToggleRequest = new Emitter<{ ruleId: string }>();
	readonly onToggleRequest: Event<{ ruleId: string }> = this._onToggleRequest.event;

	constructor() {
		injectScheduleStyles();
	}

	create(parent: HTMLElement): void {
		this._viewEl = DOM.$('div.sched-view');
		parent.appendChild(this._viewEl);
	}

	dispose(): void {
		this._onCreateRequest.dispose();
		this._onEditRequest.dispose();
		this._onDeleteRequest.dispose();
		this._onToggleRequest.dispose();
	}

	/** Render the schedule table from scheduler records + task lookup. */
	render(rules: IScheduleInfo[], tasks: TaskBoardRecord[]): void {
		if (!this._viewEl) { return; }
		DOM.clearNode(this._viewEl);

		const taskById = new Map<string, TaskBoardRecord>();
		for (const t of tasks) { taskById.set(t.id, t); }

		const active = rules.filter(r => r.state === ScheduleState.Active);
		const paused = rules.filter(r => r.state === ScheduleState.Paused);
		const totalFires = rules.reduce((sum, r) => sum + (r.totalExecutions || 0), 0);
		const nextRule = active
			.filter(r => r.nextFireAt && r.nextFireAt > Date.now())
			.sort((a, b) => (a.nextFireAt! - b.nextFireAt!))[0];

		// ── Stats ──
		const stats = DOM.$('div.sched-stats-row');
		stats.appendChild(this._statCard('📅', String(active.length), '活跃定时任务', true));
		stats.appendChild(this._statCard('⏸️', String(paused.length), '已暂停', false));
		stats.appendChild(this._statCard('✅', String(totalFires), '历史执行次数', false));
		stats.appendChild(this._statCard('⏱️', nextRule?.nextFireAt ? formatDateTime(nextRule.nextFireAt).slice(5) : '—', '下次执行', false));
		this._viewEl.appendChild(stats);

		if (rules.length === 0) {
			const empty = DOM.$('div.sched-empty');
			const icon = DOM.$('div.sched-empty-icon', undefined, '⏰');
			empty.appendChild(icon);
			this._viewEl.appendChild(empty);
		} else {
			// ── Table ──
			const container = DOM.$('div.sched-table-container');
			const table = DOM.$('table.sched-table') as HTMLTableElement;
			const thead = DOM.$('thead');
			const headRow = DOM.$('tr');
			for (const h of ['任务', '类型', '调度规则', '下次执行', '倒计时', '状态', '操作']) {
				headRow.appendChild(DOM.$('th', undefined, h));
			}
			thead.appendChild(headRow);
			table.appendChild(thead);

			const tbody = DOM.$('tbody');
			for (const rule of rules) {
				const tid = getScheduleTaskId(rule);
				tbody.appendChild(this._ruleRow(rule, tid ? taskById.get(tid) : undefined));
			}
			table.appendChild(tbody);
			container.appendChild(table);
			this._viewEl.appendChild(container);
		}

		// ── Footer ──
		const footer = DOM.$('div.sched-view-footer');
		const summary = DOM.$('span', undefined, `共 ${rules.length} 条定时任务 · 累计执行 ${totalFires} 次`);
		footer.appendChild(summary);
		const newBtn = DOM.$('button.sched-btn.sched-btn-primary', undefined, '＋ 新建定时任务');
		newBtn.onclick = () => this._onCreateRequest.fire();
		footer.appendChild(newBtn);
		this._viewEl.appendChild(footer);
	}

	private _statCard(icon: string, value: string, label: string, highlight: boolean): HTMLElement {
		const card = DOM.$('div.sched-stat-card' + (highlight ? '.highlight' : ''));
		card.appendChild(DOM.$('span.sched-stat-icon', undefined, icon));
		card.appendChild(DOM.$('span.sched-stat-value', undefined, value));
		card.appendChild(DOM.$('span.sched-stat-label', undefined, label));
		return card;
	}

	private _ruleRow(rule: IScheduleInfo, task: TaskBoardRecord | undefined): HTMLElement {
		const row = DOM.$('tr');
		const isPaused = rule.state === ScheduleState.Paused;
		if (isPaused) { row.classList.add('paused-row'); }

		// Task column
		const taskTd = DOM.$('td');
		const taskCol = DOM.$('div.sched-task-col');
		const iconKindClass = (rule.type === 'cron' || rule.type === 'interval' || rule.type === 'one-shot') ? rule.type : 'cron';
		const iconEl = DOM.$('div.sched-task-icon.' + iconKindClass, undefined, TYPE_ICON[rule.type]);
		taskCol.appendChild(iconEl);
		const nameBox = DOM.$('div');
		const tid = getScheduleTaskId(rule);
		nameBox.appendChild(DOM.$('div.sched-task-name', undefined, rule.name || task?.title || '(未命名)'));
		nameBox.appendChild(DOM.$('div.sched-task-sub', undefined, `${tid ? '#' + tid.slice(0, 10) : '(未关联任务)'}${task?.assigneeName ? ' · ' + task.assigneeName : ''}`));
		taskCol.appendChild(nameBox);
		taskTd.appendChild(taskCol);
		row.appendChild(taskTd);

		// Type
		row.appendChild(DOM.$('td', undefined, TYPE_LABEL[rule.type]));

		// Rule
		const ruleTd = DOM.$('td.sched-rule-col', undefined, describeRule(rule));
		row.appendChild(ruleTd);

		// Next fire
		const showNext = rule.state === ScheduleState.Active && rule.nextFireAt;
		const nextTd = DOM.$('td.sched-time-col', undefined, showNext ? formatDateTime(rule.nextFireAt!) : '—');
		row.appendChild(nextTd);

		// Countdown
		const cdTd = DOM.$('td');
		if (showNext && rule.nextFireAt! > Date.now()) {
			cdTd.appendChild(DOM.$('span.sched-countdown', undefined, '⏳ ' + formatCountdown(rule.nextFireAt!)));
		} else {
			cdTd.textContent = '—';
		}
		row.appendChild(cdTd);

		// Status
		const stTd = DOM.$('td');
		const stClass = rule.state === ScheduleState.Active ? 'active'
			: rule.state === ScheduleState.Paused ? 'paused'
				: rule.state === ScheduleState.Completed ? 'completed' : 'error';
		const stLabel = rule.state === ScheduleState.Active ? '● 活跃'
			: rule.state === ScheduleState.Paused ? '⏸ 暂停'
				: rule.state === ScheduleState.Completed ? '✓ 完成'
					: rule.state === ScheduleState.Expired ? '⏰ 过期' : '⛔ 禁用';
		stTd.appendChild(DOM.$('span.sched-status-badge.' + stClass, undefined, stLabel));
		row.appendChild(stTd);

		// Actions
		const actTd = DOM.$('td');
		const actCol = DOM.$('div.sched-action-col');
		const canToggle = rule.state === ScheduleState.Active || rule.state === ScheduleState.Paused;
		const toggleBtn = DOM.$('button.sched-row-btn', undefined, rule.state === ScheduleState.Active ? '⏸' : '▶️') as HTMLButtonElement;
		toggleBtn.title = rule.state === ScheduleState.Active ? '暂停' : '启用';
		toggleBtn.disabled = !canToggle;
		toggleBtn.onclick = () => this._onToggleRequest.fire({ ruleId: rule.id });
		actCol.appendChild(toggleBtn);

		const editBtn = DOM.$('button.sched-row-btn', undefined, '✏️');
		editBtn.title = '编辑';
		editBtn.onclick = () => this._onEditRequest.fire({ ruleId: rule.id });
		actCol.appendChild(editBtn);

		const delBtn = DOM.$('button.sched-row-btn', undefined, '🗑');
		delBtn.title = '删除';
		delBtn.onclick = () => this._onDeleteRequest.fire({ ruleId: rule.id });
		actCol.appendChild(delBtn);

		actTd.appendChild(actCol);
		row.appendChild(actTd);

		return row;
	}

	// ─── Create / Edit Modal ───────────────────────────────────────────

	/**
	 * Show the create/edit schedule modal.  `onSave` receives the assembled
	 * ScheduleDraft when the user confirms.  `existing` pre-fills the form for
	 * edit mode; `presetTaskId` pre-selects (and locks) a task for the
	 * "schedule this task" entry point.
	 */
	showScheduleModal(
		container: HTMLElement,
		tasks: TaskBoardRecord[],
		onSave: (draft: ScheduleDraft) => void,
		existing?: ScheduleEditPrefill,
		presetTaskId?: string,
	): void {
		injectScheduleStyles();

		const overlay = DOM.$('div.sched-modal-overlay');
		const modal = DOM.$('div.sched-modal');
		overlay.appendChild(modal);

		const close = () => { overlay.remove(); };

		// Header
		const header = DOM.$('div.sched-modal-header');
		const h2 = DOM.$('h2');
		h2.appendChild(DOM.$('span', undefined, '⏰'));
		h2.appendChild(DOM.$('span', undefined, existing ? '编辑定时任务' : '新建定时任务'));
		header.appendChild(h2);
		const closeBtn = DOM.$('button.sched-modal-close', undefined, '✕');
		closeBtn.onclick = close;
		header.appendChild(closeBtn);
		modal.appendChild(header);

		// Body
		const body = DOM.$('div.sched-modal-body');

		// Local form state
		const editableTypes: ScheduleType[] = ['cron', 'interval', 'one-shot'];
		let type: ScheduleType = (existing && editableTypes.includes(existing.type))
			? existing.type : 'cron';
		let cronExpr = existing?.cronExpression ?? '0 9 * * 1-5';
		let intervalMs = existing?.intervalMs ?? 3600000;
		let fireAt = existing?.triggerAt ?? (Date.now() + 3600000);

		// Associated task selector (only tasks with an assigned agent can be scheduled)
		const taskGroup = DOM.$('div.sched-form-group');
		taskGroup.appendChild(DOM.$('label.sched-form-label', undefined, '关联任务'));
		const taskSelect = DOM.$('select.sched-form-select') as HTMLSelectElement;
		const openTasks = tasks.filter(t => t.status !== 'archived' && !!t.assigneeId);
		const lockTaskId = presetTaskId ?? existing?.taskId ?? '';
		if (openTasks.length === 0) {
			const opt = DOM.$('option', undefined, '（暂无可调度任务：请先为任务指派 Agent）') as HTMLOptionElement;
			opt.value = '';
			taskSelect.appendChild(opt);
			taskSelect.disabled = true;
		}
		for (const t of openTasks) {
			const opt = DOM.$('option', undefined, `${t.title} (#${t.id.slice(0, 8)})${t.assigneeName ? ' · ' + t.assigneeName : ''}`) as HTMLOptionElement;
			opt.value = t.id;
			if (lockTaskId ? t.id === lockTaskId : (existing && existing.taskId === t.id)) { opt.selected = true; }
			taskSelect.appendChild(opt);
		}
		if (lockTaskId) { taskSelect.disabled = true; }
		taskGroup.appendChild(taskSelect);
		body.appendChild(taskGroup);

		// Schedule-type tabs (cron / interval / once)
		const typeTabs = DOM.$('div.sched-type-tabs');
		const kindDefs: { k: ScheduleType; label: string }[] = [
			{ k: 'cron', label: '📅 Cron' },
			{ k: 'interval', label: '🔄 固定间隔' },
			{ k: 'one-shot', label: '🎯 一次性' },
		];
		const tabButtons = new Map<ScheduleType, HTMLElement>();
		for (const def of kindDefs) {
			const tab = DOM.$('button.sched-type-tab', undefined, def.label);
			if (def.k === type) { tab.classList.add('active'); }
			tab.onclick = () => {
				type = def.k;
				for (const [k, btn] of tabButtons) { btn.classList.toggle('active', k === type); }
				renderTypeFields();
				updatePreview();
			};
			tabButtons.set(def.k, tab);
			typeTabs.appendChild(tab);
		}
		body.appendChild(typeTabs);

		// Dynamic type-specific fields container
		const fieldsBox = DOM.$('div.sched-form-group');
		body.appendChild(fieldsBox);

		// Preview
		const preview = DOM.$('div.sched-next-preview');
		const previewIcon = DOM.$('span', undefined, '⏱️');
		previewIcon.style.fontSize = '16px';
		const previewTime = DOM.$('span.sched-next-time', undefined, '—');
		const previewCd = DOM.$('span', undefined, '');
		previewCd.style.color = '#888';
		previewCd.style.fontSize = '11px';
		preview.appendChild(previewIcon);
		preview.appendChild(previewTime);
		preview.appendChild(previewCd);
		body.appendChild(preview);

		// Retry count (advanced)
		const retryGroup = DOM.$('div.sched-form-group');
		retryGroup.appendChild(DOM.$('label.sched-form-label', undefined, '失败重试次数'));
		const retryInput = DOM.$('input.sched-form-input') as HTMLInputElement;
		retryInput.type = 'number';
		retryInput.value = String(existing?.maxRetries ?? 0);
		retryInput.min = '0';
		retryInput.style.width = '100px';
		retryGroup.appendChild(retryInput);
		body.appendChild(retryGroup);

		modal.appendChild(body);

		// Footer
		const footer = DOM.$('div.sched-modal-footer');
		const cancelBtn = DOM.$('button.sched-btn', undefined, '取消');
		cancelBtn.onclick = close;
		footer.appendChild(cancelBtn);
		const saveBtn = DOM.$('button.sched-btn.sched-btn-primary', undefined, existing ? '💾 保存' : '💾 创建定时任务');
		saveBtn.onclick = () => {
			const taskId = lockTaskId || taskSelect.value;
			if (!taskId) { return; }
			const draft: ScheduleDraft = {
				taskId,
				type: type as 'cron' | 'interval' | 'one-shot',
				maxRetries: parseInt(retryInput.value, 10) || 0,
			};
			if (type === 'cron') { draft.cronExpression = cronExpr; }
			else if (type === 'interval') { draft.intervalMs = intervalMs; }
			else if (type === 'one-shot') { draft.triggerAt = fireAt; }
			if (existing) { draft.existingId = existing.id; }
			onSave(draft);
			close();
		};
		footer.appendChild(saveBtn);
		modal.appendChild(footer);

		// ── Dynamic field rendering ──
		const updatePreview = () => {
			const next = computeNextFire(type, cronExpr, intervalMs, fireAt);
			if (next) {
				previewTime.textContent = formatDateTime(next);
				previewCd.textContent = '⏳ ' + formatCountdown(next) + ' 后';
			} else {
				previewTime.textContent = '无法计算下次执行时间';
				previewCd.textContent = '';
			}
		};

		const renderTypeFields = () => {
			DOM.clearNode(fieldsBox);
			if (type === 'cron') {
				fieldsBox.appendChild(DOM.$('label.sched-form-label', undefined, 'Cron 表达式'));
				const input = DOM.$('input.sched-form-input') as HTMLInputElement;
				input.type = 'text';
				input.value = cronExpr;
				input.style.fontFamily = "'Cascadia Code', monospace";
				input.style.letterSpacing = '2px';
				input.oninput = () => { cronExpr = input.value.trim(); updatePreview(); };
				fieldsBox.appendChild(input);
				fieldsBox.appendChild(DOM.$('span.sched-field-hint', undefined, '格式: 分 时 日 月 周'));

				const presets = DOM.$('div.sched-cron-presets');
				const presetDefs: { label: string; expr: string }[] = [
					{ label: '每天 02:00', expr: '0 2 * * *' },
					{ label: '工作日 09:00', expr: '0 9 * * 1-5' },
					{ label: '每 4 小时', expr: '0 */4 * * *' },
					{ label: '每周五 17:00', expr: '0 17 * * 5' },
					{ label: '每月 1 日', expr: '0 0 1 * *' },
					{ label: '每 30 分钟', expr: '*/30 * * * *' },
				];
				for (const p of presetDefs) {
					const btn = DOM.$('button.sched-cron-preset', undefined, p.label);
					btn.onclick = () => {
						cronExpr = p.expr;
						input.value = p.expr;
						updatePreview();
					};
					presets.appendChild(btn);
				}
				fieldsBox.appendChild(presets);
			} else if (type === 'interval') {
				fieldsBox.appendChild(DOM.$('label.sched-form-label', undefined, '执行间隔'));
				const row = DOM.$('div');
				row.style.display = 'flex';
				row.style.gap = '8px';
				const numInput = DOM.$('input.sched-form-input') as HTMLInputElement;
				numInput.type = 'number';
				numInput.min = '1';
				numInput.style.flex = '1';
				const unitSelect = DOM.$('select.sched-form-select') as HTMLSelectElement;
				const unitDefs: { label: string; ms: number }[] = [
					{ label: '分钟', ms: 60000 },
					{ label: '小时', ms: 3600000 },
					{ label: '天', ms: 86400000 },
				];
				// Pick a sensible default unit from existing intervalMs
				let unitMs = 3600000;
				if (intervalMs % 86400000 === 0) { unitMs = 86400000; }
				else if (intervalMs % 3600000 === 0) { unitMs = 3600000; }
				else { unitMs = 60000; }
				for (const u of unitDefs) {
					const opt = DOM.$('option', undefined, u.label) as HTMLOptionElement;
					opt.value = String(u.ms);
					if (u.ms === unitMs) { opt.selected = true; }
					unitSelect.appendChild(opt);
				}
				numInput.value = String(Math.max(1, Math.round(intervalMs / unitMs)));
				const recompute = () => {
					const n = parseInt(numInput.value, 10) || 1;
					const um = parseInt(unitSelect.value, 10) || 60000;
					intervalMs = n * um;
					updatePreview();
				};
				numInput.oninput = recompute;
				unitSelect.onchange = recompute;
				row.appendChild(numInput);
				row.appendChild(unitSelect);
				fieldsBox.appendChild(row);
			} else if (type === 'one-shot') {
				fieldsBox.appendChild(DOM.$('label.sched-form-label', undefined, '执行时间'));
				const input = DOM.$('input.sched-form-input') as HTMLInputElement;
				input.type = 'datetime-local';
				input.value = toLocalDateTimeValue(fireAt);
				input.oninput = () => {
					const ms = parseLocalDateTime(input.value);
					if (ms) { fireAt = ms; updatePreview(); }
				};
				fieldsBox.appendChild(input);
			}
		};

		renderTypeFields();
		updatePreview();

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) { close(); }
		});

		container.appendChild(overlay);
	}
}
