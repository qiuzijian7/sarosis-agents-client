/*---------------------------------------------------------------------------------------------
 *  Agent Studio - Native Task Board Renderer
 *
 *  Replaces the webview-based React TaskBoardPanel with VS Code native DOM rendering.
 *  No webview, no React, no postMessage overhead — just fast DOM manipulation with
 *  CSS variables for theming.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import {
	TaskBoardRecord,
	TaskBoardStatus,
	TaskSource,
} from '../../../common/agentStudioTypes.js';

// ─── Column Configuration ──────────────────────────────────────────────────

export interface ColumnDef {
	readonly key: string;
	readonly statuses: TaskBoardStatus[];
	readonly dropStatus: TaskBoardStatus | null;
	readonly label: string;
	readonly icon: string;
	readonly color: string;
}

export const COLUMNS: readonly ColumnDef[] = [
	{ key: 'triage', statuses: ['triage' as TaskBoardStatus], dropStatus: 'triage' as TaskBoardStatus, label: '待规划', icon: '🗂', color: '#a855f7' },
	{ key: 'todo', statuses: ['todo' as TaskBoardStatus, 'ready' as TaskBoardStatus], dropStatus: 'todo' as TaskBoardStatus, label: '待执行', icon: '📋', color: '#f59e0b' },
	{ key: 'running', statuses: ['running' as TaskBoardStatus, 'blocked' as TaskBoardStatus], dropStatus: 'running' as TaskBoardStatus, label: '执行中', icon: '⚡', color: '#3b82f6' },
	{ key: 'done', statuses: ['done' as TaskBoardStatus], dropStatus: 'done' as TaskBoardStatus, label: '执行结束', icon: '✅', color: '#10b981' },
	{ key: 'cancelled', statuses: ['cancelled' as TaskBoardStatus], dropStatus: 'cancelled' as TaskBoardStatus, label: '取消执行', icon: '⏹', color: '#6b7280' },
	{ key: 'archived', statuses: ['archived' as TaskBoardStatus], dropStatus: 'archived' as TaskBoardStatus, label: '归档', icon: '📦', color: '#8b5cf6' },
];

// ─── Filter State ───────────────────────────────────────────────────────────

export interface TaskBoardFilter {
	boardFilterWsId: string; // 'all' or a workspaceId
	employeeFilter: string;  // 'all' or an assigneeId
	hiddenColumnKeys: Set<string>;
}

// ─── Events ─────────────────────────────────────────────────────────────────

export interface TaskBoardEvents {
	readonly onStatusChange: Event<{ taskId: string; status: TaskBoardStatus; source: TaskSource }>;
	readonly onDelete: Event<{ taskId: string; source: TaskSource }>;
	readonly onArchive: Event<{ taskId: string; source: TaskSource }>;
	readonly onCreateRequest: Event<void>;
	// onPlanRequest removed — task orchestration entry point is now closed
	readonly onDiagnosticsRequest: Event<MouseEvent>;
	readonly onTaskOpen: Event<{ taskId: string; taskTitle: string }>;
	readonly onFilterChange: Event<TaskBoardFilter>;
	readonly onBoardFilterChange: Event<string>;
	readonly onSwarmCancel: Event<string>;
}

// ─── Employee / Agent info ──────────────────────────────────────────────────

export interface EmployeeInfo {
	id: string;
	name: string;
}

// ─── Swarm info ─────────────────────────────────────────────────────────────

export interface SwarmInfo {
	swarmId: string;
	title: string;
	phase: string;
	isActive: boolean;
	totalWorkers: number;
	doneWorkers: number;
}

// ─── Render Data ────────────────────────────────────────────────────────────

export interface TaskBoardRenderData {
	tasks: TaskBoardRecord[];
	employees: EmployeeInfo[];
	workspaces: { id: string; name: string }[];
	swarms: SwarmInfo[];
	filter: TaskBoardFilter;
	isLoading: boolean;
	collapsed: boolean;
	draggingTaskId: string | null;
	dragOverColumn: string | null;
	focusedTaskId: string | null;
}

/** Result from showCreateTaskModal. */
export interface CreateTaskResult {
	title: string;
	description?: string;
	assigneeId?: string;
	assigneeName?: string;
	priority?: 'low' | 'medium' | 'high';
	dependencies?: string[];
	workspaceId?: string;
	worktreePath?: string;
	worktreeBranch?: string;
	/** Selected chat session ID (used to link task to existing agent conversation). */
	agentSessionId?: string;
	/** Session name for new sessions. */
	agentSessionName?: string;
	/** Attachments collected from rich description editor. */
	attachments?: { name: string; mimeType: string; base64Content: string }[];
}

/** Worktree info for the create task modal dropdown. */
export interface WorktreeInfo {
	path: string;
	branch: string;
	repoRoot?: string;
	repoName?: string;
}

// ─── Style Injection ────────────────────────────────────────────────────────

let _stylesInjected = false;

function injectStyles(): void {
	if (_stylesInjected) { return; }
	_stylesInjected = true;

	const style = document.createElement('style');
	style.textContent = /* css */`
/* === Task Board Panel (Native) === */
.native-task-board-panel {
	height: 100%;
	display: flex;
	flex-direction: column;
	background: var(--vscode-editor-background);
	color: var(--vscode-foreground);
	font-size: 12px;
	overflow: hidden;
	font-family: var(--vscode-font-family);
}

/* === Header === */
.native-tb-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 8px 12px;
	border-bottom: 1px solid var(--vscode-panel-border);
	flex-shrink: 0;
	cursor: pointer;
	user-select: none;
}
.native-tb-header-left {
	display: flex;
	align-items: center;
	gap: 6px;
}
.native-tb-title {
	font-weight: 600;
	font-size: 13px;
}
.native-tb-count {
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
	border-radius: 10px;
	padding: 1px 7px;
	font-size: 11px;
}
.native-tb-header-right {
	display: flex;
	align-items: center;
	gap: 6px;
}

/* === Filters === */
.native-tb-filters {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 6px 12px;
	border-bottom: 1px solid var(--vscode-panel-border);
	flex-shrink: 0;
	flex-wrap: wrap;
}
.native-tb-filter-group {
	display: flex;
	align-items: center;
	gap: 4px;
}
.native-tb-filter-label {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	white-space: nowrap;
}
.native-tb-filter-select {
	font-size: 11px;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border);
	border-radius: 3px;
	padding: 2px 4px;
	outline: none;
}
.native-tb-filter-select:focus {
	border-color: var(--vscode-focusBorder);
}
.native-tb-filter-checkbox-label {
	display: flex;
	align-items: center;
	gap: 3px;
	font-size: 11px;
	cursor: pointer;
	white-space: nowrap;
}

/* === Buttons === */
.native-tb-btn {
	font-size: 11px;
	padding: 3px 8px;
	border: none;
	border-radius: 3px;
	cursor: pointer;
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
	white-space: nowrap;
}
.native-tb-btn:hover {
	background: var(--vscode-button-secondaryHoverBackground);
}
.native-tb-btn-primary {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
}
.native-tb-btn-primary:hover {
	background: var(--vscode-button-hoverBackground);
}
.native-tb-btn-danger {
	color: #f48771;
}

/* === Swarms bar === */
.native-tb-swarms {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 12px;
	border-bottom: 1px solid var(--vscode-panel-border);
	flex-shrink: 0;
	overflow-x: auto;
}
.native-tb-swarm-item {
	display: flex;
	align-items: center;
	gap: 4px;
	font-size: 11px;
	padding: 2px 6px;
	border-radius: 10px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
}

/* === Columns === */
.native-tb-columns {
	flex: 1;
	display: flex;
	gap: 0;
	overflow-x: auto;
	overflow-y: hidden;
	min-height: 0;
}
.native-tb-column {
	flex: 1 1 0;
	min-width: 240px;
	max-width: 360px;
	display: flex;
	flex-direction: column;
	border-right: 1px solid var(--vscode-panel-border);
	background: var(--vscode-sideBar-background);
}
.native-tb-column:last-child {
	border-right: none;
}
.native-tb-column.drag-over {
	background: var(--vscode-list-dropBackground);
}
.native-tb-column-header {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 6px 8px;
	border-bottom: 1px solid var(--vscode-panel-border);
	flex-shrink: 0;
	font-weight: 600;
	font-size: 11px;
}
.native-tb-column-icon {
	font-size: 12px;
}
.native-tb-column-label {
	flex: 1;
}
.native-tb-column-count {
	font-size: 11px;
	padding: 1px 5px;
	border-radius: 8px;
	font-weight: 400;
	opacity: 0.8;
}
.native-tb-column-add-btn {
	border: none;
	background: transparent;
	color: var(--vscode-descriptionForeground);
	cursor: pointer;
	font-size: 14px;
	line-height: 1;
	padding: 0 4px;
	border-radius: 3px;
}
.native-tb-column-add-btn:hover {
	background: var(--vscode-toolbar-hoverBackground);
	color: var(--vscode-foreground);
}

/* === Cards (v2) === */
.native-tb-cards {
	flex: 1;
	overflow-y: auto;
	padding: 4px 6px;
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.native-tb-card {
	position: relative;
	overflow: hidden;
	background: linear-gradient(180deg, var(--vscode-editor-background) 0%, var(--vscode-sideBar-background) 100%);
	border: 1px solid var(--vscode-panel-border);
	border-radius: 6px;
	cursor: grab;
	font-size: 12px;
	line-height: 1.4;
	transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
	display: flex;
	flex-direction: column;
	box-shadow: 0 1px 2px rgba(0,0,0,0.15);
}
.native-tb-card::before {
	content: "";
	position: absolute;
	left: 0; top: 0; bottom: 0;
	width: 3px;
	transition: width 0.15s;
}
.native-tb-card.prio-high::before   { background: #f44747; }
.native-tb-card.prio-medium::before { background: #cca700; }
.native-tb-card.prio-low::before    { background: #4ec9b0; }
.native-tb-card:hover {
	border-color: var(--vscode-focusBorder);
	box-shadow: 0 2px 8px rgba(0,0,0,0.25);
	transform: translateY(-1px);
}
.native-tb-card.dragging {
	opacity: 0.5;
	transform: rotate(1deg);
}
.native-tb-card.focused {
	border-color: var(--vscode-focusBorder);
	box-shadow: 0 0 0 1px var(--vscode-focusBorder);
}

/* Card body */
.native-tb-card-body {
	padding: 8px 10px 6px 12px;
	display: flex;
	flex-direction: column;
	gap: 3px;
}
.native-tb-card-id {
	font-size: 10px;
	color: var(--vscode-descriptionForeground);
	opacity: 0.6;
	font-family: var(--vscode-editor-font-family, monospace);
	line-height: 1.2;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.native-tb-card-title {
	font-size: 12.5px;
	font-weight: 500;
	color: var(--vscode-foreground);
	line-height: 1.35;
	word-break: break-word;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
}
.native-tb-card-desc {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	opacity: 0.85;
	line-height: 1.4;
	word-break: break-word;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
}
.native-tb-card-done .native-tb-card-title,
.native-tb-card-done .native-tb-card-desc {
	text-decoration: line-through;
	opacity: 0.6;
}
.native-tb-card-done { opacity: 0.65; }
.native-tb-card-archived .native-tb-card-title,
.native-tb-card-archived .native-tb-card-desc { opacity: 0.5; }

/* Tags row */
.native-tb-card-tags {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	margin-top: 1px;
}
.native-tb-card-tag {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 10px;
	padding: 2px 6px;
	border-radius: 8px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
	white-space: nowrap;
	max-width: 140px;
	overflow: hidden;
	text-overflow: ellipsis;
}
.native-tb-card-tag.assignee {
	background: var(--vscode-badge-background);
	color: var(--vscode-foreground);
}
.native-tb-card-avatar {
	width: 14px;
	height: 14px;
	border-radius: 50%;
	flex-shrink: 0;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	font-size: 8px;
	font-weight: 700;
	color: #fff;
}
.native-tb-card-priority {
	display: inline-flex;
	align-items: center;
	gap: 2px;
	font-size: 10px;
	padding: 2px 6px;
	border-radius: 8px;
	font-weight: 500;
	white-space: nowrap;
}
.native-tb-card-priority.prio-high   { background: #f4474720; color: #f44747; }
.native-tb-card-priority.prio-medium { background: #cca70020; color: #cca700; }
.native-tb-card-priority.prio-low    { background: #4ec9b020; color: #4ec9b0; }

/* Footer bar */
.native-tb-card-footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 5px 10px 6px 12px;
	border-top: 1px solid var(--vscode-panel-border);
	background: rgba(0,0,0,0.12);
	font-size: 11px;
}
.native-tb-card-status {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--vscode-descriptionForeground);
}
.native-tb-card-status-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	flex-shrink: 0;
}
.native-tb-card-status-dot.blocked  { background: var(--vscode-errorForeground, #f44747); }
.native-tb-card-status-dot.running  { background: #cca700; animation: ntb-pulse 1.5s infinite; }
.native-tb-card-status-dot.ready    { background: #4ec9b0; }
.native-tb-card-status-dot.todo     { background: var(--vscode-focusBorder, #007acc); }
.native-tb-card-status-dot.done     { background: #4ec9b0; }
@keyframes ntb-pulse {
	0%, 100% { opacity: 1; }
	50%      { opacity: 0.3; }
}
.native-tb-card-meta-icons {
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--vscode-descriptionForeground);
	opacity: 0.7;
}
.native-tb-card-meta-icons > span {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-width: 22px;
	height: 20px;
	padding: 0 5px;
	border-radius: 4px;
	cursor: default;
	font-size: 11px;
}
.native-tb-card-meta-icons > span[title*="跳转"] {
	cursor: pointer;
}
.native-tb-card-meta-icons > span[title*="跳转"]:hover {
	background: var(--vscode-toolbar-hoverBackground);
	opacity: 1;
}

/* Hover actions (top-right) */
.native-tb-card-actions {
	position: absolute;
	top: 4px;
	right: 4px;
	display: none;
	gap: 2px;
	background: var(--vscode-editor-background);
	border: 1px solid var(--vscode-panel-border);
	border-radius: 4px;
	padding: 2px;
	box-shadow: 0 1px 4px rgba(0,0,0,0.2);
}
.native-tb-card:hover .native-tb-card-actions {
	display: flex;
}
.native-tb-card action-btn {
	font-size: 13px;
	padding: 3px 6px;
	border: none;
	border-radius: 3px;
	cursor: pointer;
	line-height: 1;
	background: transparent;
	color: var(--vscode-descriptionForeground);
}
.native-tb-card action-btn:hover {
	background: var(--vscode-toolbar-hoverBackground);
	color: var(--vscode-foreground);
}
.native-tb-card action-btn.action-danger:hover {
	color: var(--vscode-errorForeground, #f44747);
}

/* === Empty column === */
.native-tb-column-empty {
	color: var(--vscode-descriptionForeground);
	font-size: 11px;
	text-align: center;
	padding: 20px 8px;
	opacity: 0.6;
}

/* === Modal/Dialog === */
.native-tb-modal-overlay {
	position: fixed;
	inset: 0;
	background: rgba(0,0,0,0.4);
	z-index: 1000;
	display: flex;
	align-items: center;
	justify-content: center;
}
.native-tb-modal {
	background: var(--vscode-editor-background);
	border: 1px solid var(--vscode-panel-border);
	border-radius: 6px;
	width: 420px;
	max-height: 80vh;
	overflow-y: auto;
	box-shadow: 0 8px 32px rgba(0,0,0,0.3);
}
.native-tb-modal-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 12px 16px;
	border-bottom: 1px solid var(--vscode-panel-border);
	font-weight: 600;
	font-size: 13px;
}
.native-tb-modal-close {
	border: none;
	background: transparent;
	color: var(--vscode-descriptionForeground);
	cursor: pointer;
	font-size: 16px;
	line-height: 1;
	padding: 0 4px;
}
.native-tb-modal-close:hover {
	color: var(--vscode-foreground);
}
.native-tb-modal-body {
	padding: 16px;
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.native-tb-modal-footer {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	padding: 12px 16px;
	border-top: 1px solid var(--vscode-panel-border);
}
.native-tb-field {
	display: flex;
	flex-direction: column;
	gap: 3px;
}
.native-tb-field-label {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
}
.native-tb-input {
	font-size: 12px;
	padding: 5px 8px;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border);
	border-radius: 3px;
	outline: none;
	font-family: var(--vscode-font-family);
}
.native-tb-input:focus {
	border-color: var(--vscode-focusBorder);
}
.native-tb-textarea {
	font-size: 12px;
	padding: 5px 8px;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border);
	border-radius: 3px;
	outline: none;
	resize: vertical;
	font-family: var(--vscode-font-family);
}
.native-tb-textarea:focus {
	border-color: var(--vscode-focusBorder);
}
.native-tb-field-row {
	display: flex;
	gap: 12px;
}

/* === Rich description editor === */
.native-tb-rich-desc {
	min-height: 80px;
	max-height: 180px;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border);
	border-radius: 3px;
	padding: 8px 10px;
	font-size: 12px;
	line-height: 1.6;
	outline: none;
	overflow-y: auto;
	cursor: text;
	font-family: var(--vscode-font-family);
	word-break: break-word;
}
.native-tb-rich-desc:focus {
	border-color: var(--vscode-focusBorder);
}
.native-tb-rich-desc:empty::before {
	content: "补充细节、验收标准等… 可粘贴图片、拖拽文件";
	color: var(--vscode-descriptionForeground);
	opacity: 0.6;
	pointer-events: none;
}
.native-tb-rich-desc.drag-over {
	border-style: dashed;
	border-color: var(--vscode-focusBorder);
	background: #007acc10;
}
.native-tb-rich-desc img.inline-img {
	max-width: 280px;
	max-height: 160px;
	border-radius: 4px;
	border: 1px solid var(--vscode-panel-border);
	margin: 4px 4px 0 0;
	vertical-align: middle;
	cursor: pointer;
}
/* File chip inside rich editor */
.native-tb-file-chip {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 3px 8px;
	border-radius: 10px;
	background: var(--vscode-sideBar-background);
	border: 1px solid var(--vscode-panel-border);
	font-size: 11px;
	color: var(--vscode-foreground);
	cursor: default;
	margin: 2px 4px 2px 0;
	vertical-align: middle;
	white-space: nowrap;
}
.native-tb-file-chip .f-name {
	max-width: 120px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.native-tb-file-chip .f-size {
	font-size: 10px;
	color: var(--vscode-descriptionForeground);
}
.native-tb-file-chip .f-remove {
	border: none;
	background: transparent;
	color: var(--vscode-descriptionForeground);
	cursor: pointer;
	font-size: 11px;
	padding: 0;
	line-height: 1;
}
/* Desc toolbar */
.native-tb-desc-toolbar {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 3px 0 0;
}
.native-tb-desc-toolbar-btn {
	font-size: 10px;
	padding: 2px 6px;
	border-radius: 3px;
	border: 1px solid var(--vscode-panel-border);
	background: var(--vscode-sideBar-background);
	color: var(--vscode-descriptionForeground);
	cursor: pointer;
	font-family: var(--vscode-font-family);
	display: inline-flex;
	align-items: center;
	gap: 3px;
}
.native-tb-desc-toolbar-btn:hover {
	background: var(--vscode-input-background);
	color: var(--vscode-foreground);
}
.native-tb-desc-file-input {
	display: none;
}

/* === Task Detail Modal === */
.native-tb-detail-overlay {
	position: fixed;
	inset: 0;
	background: rgba(0,0,0,0.55);
	backdrop-filter: blur(2px);
	z-index: 1000;
	display: flex;
	align-items: center;
	justify-content: center;
}
.native-tb-detail-modal {
	background: var(--vscode-editor-background);
	border: 1px solid var(--vscode-panel-border);
	border-radius: 8px;
	width: 560px;
	max-width: 95vw;
	max-height: 85vh;
	display: flex;
	flex-direction: column;
	box-shadow: 0 8px 32px rgba(0,0,0,0.5);
	animation: ntb-modal-in 0.15s ease;
}
@keyframes ntb-modal-in {
	from { opacity: 0; transform: translateY(-8px) scale(0.98); }
	to   { opacity: 1; transform: translateY(0) scale(1); }
}
.native-tb-detail-header {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	padding: 16px 20px 12px;
	border-bottom: 1px solid var(--vscode-panel-border);
	flex-shrink: 0;
}
.native-tb-detail-header-left {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
	flex: 1;
}
.native-tb-detail-id {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	opacity: 0.7;
	font-family: var(--vscode-editor-font-family, monospace);
}
.native-tb-detail-title {
	font-size: 16px;
	font-weight: 600;
	color: var(--vscode-foreground);
	line-height: 1.3;
	word-break: break-word;
}
.native-tb-detail-close {
	border: none;
	background: transparent;
	color: var(--vscode-descriptionForeground);
	font-size: 18px;
	cursor: pointer;
	padding: 2px 6px;
	border-radius: 3px;
	line-height: 1;
	flex-shrink: 0;
	margin-left: 12px;
}
.native-tb-detail-close:hover {
	background: var(--vscode-toolbar-hoverBackground);
	color: var(--vscode-foreground);
}
.native-tb-detail-body {
	padding: 16px 20px;
	overflow-y: auto;
	flex: 1;
	display: flex;
	flex-direction: column;
	gap: 14px;
}
.native-tb-detail-body::-webkit-scrollbar { width: 6px; }
.native-tb-detail-body::-webkit-scrollbar-thumb {
	background: var(--vscode-scrollbarSlider-background);
	border-radius: 3px;
}
.native-tb-detail-row {
	display: flex;
	align-items: center;
	gap: 10px;
}
.native-tb-detail-row-label {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	white-space: nowrap;
	min-width: 42px;
}
.native-tb-detail-section-label {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	text-transform: uppercase;
	letter-spacing: 0.4px;
}
.native-tb-detail-meta-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 10px 16px;
}
.native-tb-detail-meta-item {
	display: flex;
	flex-direction: column;
	gap: 2px;
}
.native-tb-detail-meta-item .ntb-meta-label {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	opacity: 0.8;
}
.native-tb-detail-meta-item .ntb-meta-value {
	font-size: 13px;
	color: var(--vscode-foreground);
	display: flex;
	align-items: center;
	gap: 6px;
}
.native-tb-priority-chip {
	display: inline-flex;
	padding: 2px 8px;
	border-radius: 10px;
	font-size: 12px;
	font-weight: 500;
}
.native-tb-priority-high   { background: #f4474720; color: #f44747; }
.native-tb-priority-medium { background: #cca70020; color: #cca700; }
.native-tb-priority-low    { background: #4ec9b020; color: #4ec9b0; }
.native-tb-detail-desc {
	font-size: 13px;
	color: var(--vscode-foreground);
	line-height: 1.6;
	background: var(--vscode-sideBar-background);
	border-radius: 4px;
	padding: 10px 12px;
	white-space: pre-wrap;
	word-break: break-word;
	max-height: 140px;
	overflow-y: auto;
	border: 1px solid var(--vscode-panel-border);
}
.native-tb-detail-deps {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}
.native-tb-detail-dep-chip {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	padding: 3px 8px;
	border-radius: 10px;
	font-size: 11px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
	border: 1px solid var(--vscode-panel-border);
	text-decoration: none;
}
.native-tb-detail-dep-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	flex-shrink: 0;
}
.native-tb-detail-dep-dot.done    { background: #4ec9b0; }
.native-tb-detail-dep-dot.active  { background: #cca700; }
.native-tb-detail-dep-dot.waiting { background: var(--vscode-descriptionForeground); opacity: 0.5; }
.native-tb-detail-timestamps {
	display: flex;
	gap: 20px;
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	opacity: 0.7;
	padding-top: 4px;
	border-top: 1px solid var(--vscode-panel-border);
}
.native-tb-detail-timestamps span {
	font-family: var(--vscode-editor-font-family, monospace);
	color: var(--vscode-descriptionForeground);
}
.native-tb-detail-footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 12px 20px;
	border-top: 1px solid var(--vscode-panel-border);
	flex-shrink: 0;
}
.native-tb-detail-footer-left,
.native-tb-detail-footer-right {
	display: flex;
	gap: 8px;
}
`;

	// Append to head
	document.head.appendChild(style);
}

// ─── Renderer ───────────────────────────────────────────────────────────────

export class TaskBoardNativeRenderer {
	private readonly _disposables = new DisposableStore();

	private readonly _onStatusChange = this._disposables.add(new Emitter<{ taskId: string; status: TaskBoardStatus; source: TaskSource }>());
	readonly onStatusChange = this._onStatusChange.event;

	private readonly _onDelete = this._disposables.add(new Emitter<{ taskId: string; source: TaskSource }>());
	readonly onDelete = this._onDelete.event;

	private readonly _onArchive = this._disposables.add(new Emitter<{ taskId: string; source: TaskSource }>());
	readonly onArchive = this._onArchive.event;

	private readonly _onCreateRequest = this._disposables.add(new Emitter<void>());
	readonly onCreateRequest = this._onCreateRequest.event;

	// _onPlanRequest removed — task orchestration entry point closed

	private readonly _onDiagnosticsRequest = this._disposables.add(new Emitter<MouseEvent>());
	readonly onDiagnosticsRequest = this._onDiagnosticsRequest.event;

	private readonly _onTaskOpen = this._disposables.add(new Emitter<{ taskId: string; taskTitle: string }>());
	readonly onTaskOpen = this._onTaskOpen.event;

	private readonly _onFilterChange = this._disposables.add(new Emitter<TaskBoardFilter>());
	readonly onFilterChange = this._onFilterChange.event;

	private readonly _onBoardFilterChange = this._disposables.add(new Emitter<string>());
	readonly onBoardFilterChange = this._onBoardFilterChange.event;

	private readonly _onSwarmCancel = this._disposables.add(new Emitter<string>());
	readonly onSwarmCancel = this._onSwarmCancel.event;

	private readonly _onTaskDetailRequest = this._disposables.add(new Emitter<{ task: TaskBoardRecord; employees: EmployeeInfo[]; allTasks: TaskBoardRecord[] }>());
	readonly onTaskDetailRequest = this._onTaskDetailRequest.event;

	private readonly _onChatJump = this._disposables.add(new Emitter<{ agentId: string; agentName: string; taskId: string; workspaceId?: string; worktreePath?: string }>());
	readonly onChatJump = this._onChatJump.event;

	private _rootEl: HTMLElement | null = null;
	private _data: TaskBoardRenderData | null = null;
	private _titleById: Map<string, string> = new Map();

	constructor() {
		injectStyles();
	}

	/** Create the full board element. Call once, then call render() to update. */
	create(container: HTMLElement): HTMLElement {
		const root = DOM.$('div.native-task-board-panel');
		this._rootEl = root;
		container.appendChild(root);
		return root;
	}

	/** Update the board with new data. Efficient incremental DOM update. */
	render(data: TaskBoardRenderData): void {
		this._data = data;
		this._titleById.clear();
		for (const t of data.tasks) {
			this._titleById.set(t.id, t.title);
		}
		if (!this._rootEl) { return; }

		// Full rebuild for simplicity (kanban is relatively lightweight).
		// For production, could do diff-based updates.
		while (this._rootEl.firstChild) {
			this._rootEl.removeChild(this._rootEl.firstChild);
		}
		this._renderHeader(this._rootEl, data);
		if (!data.collapsed) {
			this._renderSwarms(this._rootEl, data.swarms);
			this._renderFilters(this._rootEl, data);
			this._renderColumns(this._rootEl, data);
		}
	}

	updateSwarmBar(swarms: SwarmInfo[]): void {
		if (!this._rootEl || !this._data || this._data.collapsed) { return; }
		const existing = this._rootEl.querySelector('.native-tb-swarms');
		if (existing) { existing.remove(); }
		const afterHeader = this._rootEl.querySelector('.native-tb-header');
		if (afterHeader) {
			const el = this._renderSwarmsEl(swarms);
			afterHeader.after(el);
		}
	}

	dispose(): void {
		this._disposables.dispose();
		this._rootEl = null;
		this._data = null;
	}

	// ─── Header ──────────────────────────────────────────────────────

	private _renderHeader(root: HTMLElement, data: TaskBoardRenderData): void {
		const header = DOM.$('div.native-tb-header');

		const left = DOM.$('div.native-tb-header-left');
		left.appendChild(DOM.$('span.native-tb-title', undefined, '任务看板'));

		const total = data.tasks.length;
		if (total > 0) {
			left.appendChild(DOM.$('span.native-tb-count', undefined, String(total)));
		}
		header.appendChild(left);

		const right = DOM.$('div.native-tb-header-right');

		// Diagnostics button
		const diagBtn = DOM.$('button.native-tb-btn');
		diagBtn.textContent = data.isLoading ? '⏳ 巡检中' : '🩺 巡检';
		diagBtn.title = '看板健康巡检';
		diagBtn.addEventListener('click', (e) => this._onDiagnosticsRequest.fire(e as MouseEvent));
		right.appendChild(diagBtn);

		header.appendChild(right);
		root.appendChild(header);
	}

	// ─── Swarms ───────────────────────────────────────────────────────

	private _renderSwarms(root: HTMLElement, swarms: SwarmInfo[]): void {
		if (swarms.length === 0) { return; }
		root.appendChild(this._renderSwarmsEl(swarms));
	}

	private _renderSwarmsEl(swarms: SwarmInfo[]): HTMLElement {
		const bar = DOM.$('div.native-tb-swarms');

		const phaseLabel: Record<string, string> = {
			planning: '规划中', running: '执行中', verifying: '校验中',
			synthesizing: '汇总中', done: '已完成', cancelled: '已取消',
			failed: '失败', interrupted: '已中断',
		};

		for (const s of swarms) {
			const item = DOM.$('div.native-tb-swarm-item');
			item.title = `Swarm: ${s.title}`;

			const icon = DOM.$('span', undefined, '🐝');
			item.appendChild(icon);

			const title = DOM.$('span', undefined, s.title);
			title.style.maxWidth = '150px';
			title.style.overflow = 'hidden';
			title.style.textOverflow = 'ellipsis';
			item.appendChild(title);

			const phase = DOM.$('span', undefined, phaseLabel[s.phase] ?? s.phase);
			item.appendChild(phase);

			const progress = DOM.$('span', undefined, `${s.doneWorkers}/${s.totalWorkers}`);
			item.appendChild(progress);

			if (s.isActive) {
				const cancel = DOM.$('button', undefined, '✕');
				cancel.style.border = 'none';
				cancel.style.background = 'transparent';
				cancel.style.color = 'inherit';
				cancel.style.cursor = 'pointer';
				cancel.style.padding = '0 2px';
				cancel.title = '取消该 Swarm';
				cancel.addEventListener('click', (e) => { e.stopPropagation(); this._onSwarmCancel.fire(s.swarmId); });
				item.appendChild(cancel);
			}

			bar.appendChild(item);
		}

		return bar;
	}

	// ─── Filters ──────────────────────────────────────────────────────

	private _renderFilters(root: HTMLElement, data: TaskBoardRenderData): void {
		const bar = DOM.$('div.native-tb-filters');

		// Board filter
		const boardGroup = DOM.$('div.native-tb-filter-group');
		boardGroup.appendChild(DOM.$('span.native-tb-filter-label', undefined, '看板'));
		const boardSelect = DOM.$('select.native-tb-filter-select') as HTMLSelectElement;
		{
			const opt = document.createElement('option');
			opt.value = 'all';
			opt.textContent = '全部看板';
			boardSelect.appendChild(opt);
		}
		for (const ws of data.workspaces) {
			const opt = document.createElement('option');
			opt.value = ws.id;
			opt.textContent = `${ws.name}工作区的看板`;
			boardSelect.appendChild(opt);
		}
		boardSelect.value = data.filter.boardFilterWsId;
		boardSelect.addEventListener('change', () => this._onBoardFilterChange.fire(boardSelect.value));
		boardGroup.appendChild(boardSelect);
		bar.appendChild(boardGroup);

		// Employee filter
		const employeeOptions = this._deriveEmployeeOptions(data);
		const empGroup = DOM.$('div.native-tb-filter-group');
		empGroup.appendChild(DOM.$('span.native-tb-filter-label', undefined, '员工'));
		const empSelect = DOM.$('select.native-tb-filter-select') as HTMLSelectElement;
		{
			const opt = document.createElement('option');
			opt.value = 'all';
			opt.textContent = '全部员工';
			empSelect.appendChild(opt);
		}
		for (const emp of employeeOptions) {
			const opt = document.createElement('option');
			opt.value = emp.id;
			opt.textContent = emp.name;
			empSelect.appendChild(opt);
		}
		empSelect.value = data.filter.employeeFilter;
		empSelect.addEventListener('change', () => {
			this._onFilterChange.fire({ ...data.filter, employeeFilter: empSelect.value });
		});
		empGroup.appendChild(empSelect);
		bar.appendChild(empGroup);

		// Column toggles
		for (const col of COLUMNS) {
			const label = DOM.$('label.native-tb-filter-checkbox-label');
			const cb = DOM.$('input') as HTMLInputElement;
			cb.type = 'checkbox';
			cb.checked = !data.filter.hiddenColumnKeys.has(col.key);
			cb.addEventListener('change', () => {
				const next = new Set(data.filter.hiddenColumnKeys);
				if (cb.checked) { next.delete(col.key); } else { next.add(col.key); }
				this._onFilterChange.fire({ ...data.filter, hiddenColumnKeys: next });
			});
			label.appendChild(cb);
			label.appendChild(DOM.$('span', undefined, col.icon));
			label.appendChild(DOM.$('span', undefined, col.label));
			bar.appendChild(label);
		}

		root.appendChild(bar);
	}

	private _deriveEmployeeOptions(data: TaskBoardRenderData): EmployeeInfo[] {
		const seen = new Map<string, string>();
		for (const t of data.tasks) {
			if (!t.assigneeId || seen.has(t.assigneeId)) { continue; }
			const emp = data.employees.find(e => e.id === t.assigneeId);
			seen.set(t.assigneeId, emp?.name || t.assigneeName || t.assigneeId);
		}
		return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
	}

	// ─── Columns ──────────────────────────────────────────────────────

	private _renderColumns(root: HTMLElement, data: TaskBoardRenderData): void {
		const colsContainer = DOM.$('div.native-tb-columns');

		const visibleColumns = COLUMNS.filter(c => !data.filter.hiddenColumnKeys.has(c.key));

		for (const col of visibleColumns) {
			const columnTasks = this._getTasksForColumn(data, col);
			const isDragOver = data.dragOverColumn === col.key;

			const colEl = DOM.$(`div.native-tb-column${isDragOver ? '.drag-over' : ''}`);
			colEl.dataset.columnKey = col.key;

			// Drag events
			if (col.dropStatus !== null) {
				colEl.addEventListener('dragover', (e) => {
					e.preventDefault();
					e.dataTransfer!.dropEffect = 'move';
					colEl.classList.add('drag-over');
				});
				colEl.addEventListener('dragleave', () => {
					colEl.classList.remove('drag-over');
				});
				colEl.addEventListener('drop', (e) => {
					e.preventDefault();
					colEl.classList.remove('drag-over');
					const taskId = e.dataTransfer!.getData('text/plain');
					if (taskId && col.dropStatus) {
						const task = data.tasks.find(t => t.id === taskId);
						if (task && task.status !== col.dropStatus) {
							this._onStatusChange.fire({ taskId, status: col.dropStatus, source: task.source });
						}
					}
				});
			}

			// Column header
			this._renderColumnHeader(colEl, col, columnTasks.length, data);

			// Cards
			const cardsEl = DOM.$('div.native-tb-cards');
			if (columnTasks.length === 0) {
				cardsEl.appendChild(DOM.$('div.native-tb-column-empty', undefined, 'No tasks'));
			} else {
				for (const task of columnTasks) {
					cardsEl.appendChild(this._renderCard(task, data));
				}
			}
			colEl.appendChild(cardsEl);

			colsContainer.appendChild(colEl);
		}

		root.appendChild(colsContainer);
	}

	private _renderColumnHeader(colEl: HTMLElement, col: ColumnDef, count: number, data: TaskBoardRenderData): void {
		const header = DOM.$('div.native-tb-column-header');

		const icon = DOM.$('span.native-tb-column-icon', undefined, col.icon);
		header.appendChild(icon);

		const label = DOM.$('span.native-tb-column-label', undefined, col.label);
		header.appendChild(label);

		const countEl = DOM.$('span.native-tb-column-count', undefined, String(count));
		countEl.style.backgroundColor = col.color + '30';
		countEl.style.color = col.color;
		header.appendChild(countEl);

		// Add button
		if (col.key === 'todo') {
			const btn = DOM.$('button.native-tb-column-add-btn', undefined, '＋');
			btn.title = '创建任务';
			btn.addEventListener('click', (e) => { e.stopPropagation(); this._onCreateRequest.fire(); });
			header.appendChild(btn);
		}

		colEl.appendChild(header);
	}

	private _renderCard(task: TaskBoardRecord, data: TaskBoardRenderData): HTMLElement {
		const card = DOM.$('div.native-tb-card');
		card.dataset.taskId = task.id;
		card.draggable = true;

		// Priority left-border accent class
		if (task.priority) {
			card.classList.add(`prio-${task.priority}`);
		}

		// Status-modifier class
		if (task.status === 'done' || task.status === 'cancelled') {
			card.classList.add('native-tb-card-done');
		}
		if (task.status === 'archived') {
			card.classList.add('native-tb-card-archived');
		}

		// Drag start
		card.addEventListener('dragstart', (e) => {
			e.dataTransfer!.setData('text/plain', task.id);
			e.dataTransfer!.effectAllowed = 'move';
			card.classList.add('dragging');
		});
		card.addEventListener('dragend', () => {
			card.classList.remove('dragging');
		});

		// Focus highlight
		if (data.focusedTaskId === task.id) {
			card.classList.add('focused');
		}

		// Hover actions (top-right corner)
		const actions = DOM.$('div.native-tb-card-actions');
		const deleteBtn = document.createElement('action-btn');
		deleteBtn.textContent = '🗑';
		deleteBtn.title = '删除';
		deleteBtn.classList.add('action-danger');
		deleteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this._onDelete.fire({ taskId: task.id, source: task.source });
		});
		actions.appendChild(deleteBtn);
		if (task.status !== 'archived') {
			const archiveBtn = document.createElement('action-btn');
			archiveBtn.textContent = '📦';
			archiveBtn.title = '归档';
			archiveBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this._onArchive.fire({ taskId: task.id, source: task.source });
			});
			actions.appendChild(archiveBtn);
		}
		card.appendChild(actions);

		// === Body ===
		const body = DOM.$('div.native-tb-card-body');

		// Task ID (shortened)
		const idEl = DOM.$('div.native-tb-card-id', undefined, `#${task.id.slice(0, 12)}`);
		body.appendChild(idEl);

		// Title
		const title = DOM.$('div.native-tb-card-title', undefined, task.title);
		body.appendChild(title);

		// Description
		if (task.description && task.description !== task.title) {
			const desc = DOM.$('div.native-tb-card-desc', undefined, task.description);
			body.appendChild(desc);
		}

		// Tags: assignee + priority
		const tags = DOM.$('div.native-tb-card-tags');

		// Assignee with avatar
		if (task.assigneeName || task.assigneeId) {
			const assigneeName = task.assigneeName || task.assigneeId || '';
			const assigneeTag = DOM.$('span.native-tb-card-tag.assignee');
			const avatar = DOM.$('span.native-tb-card-avatar');
			avatar.textContent = assigneeName.slice(0, 2).toUpperCase();
			avatar.style.background = this._avatarColor(assigneeName);
			assigneeTag.appendChild(avatar);
			assigneeTag.appendChild(document.createTextNode(assigneeName.length > 12 ? assigneeName.slice(0, 12) + '…' : assigneeName));
			tags.appendChild(assigneeTag);
		}

		// Priority badge
		if (task.priority) {
			const prioLabels: Record<string, string> = { high: '🔴 高', medium: '🟡 中', low: '🟢 低' };
			const prioEl = DOM.$(`span.native-tb-card-priority.prio-${task.priority}`, undefined, prioLabels[task.priority] ?? task.priority);
			tags.appendChild(prioEl);
		}

		// Blocked indicator (on tags row)
		if (task.status === 'blocked') {
			const blockedTag = DOM.$('span.native-tb-card-tag');
			blockedTag.style.background = '#f4474720';
			blockedTag.style.color = '#f44747';
			blockedTag.textContent = '🚫 阻塞';
			tags.appendChild(blockedTag);
		}

		body.appendChild(tags);
		card.appendChild(body);

		// === Footer ===
		const footer = DOM.$('div.native-tb-card-footer');

		// Status dot only (no text label)
		const statusEl = DOM.$('span.native-tb-card-status');
		const dotClass = task.status === 'running' ? 'running' : (task.status === 'blocked' ? 'blocked' : (task.status === 'done' ? 'done' : (task.status === 'ready' ? 'ready' : 'todo')));
		const dot = DOM.$(`span.native-tb-card-status-dot.${dotClass}`);
		statusEl.appendChild(dot);
		footer.appendChild(statusEl);

		// Meta icons: dependencies count, attachments
		const metaIcons = DOM.$('span.native-tb-card-meta-icons');
		if (task.dependencies && task.dependencies.length > 0) {
			const depsIcon = DOM.$('span', undefined, `🔗${task.dependencies.length}`);
			depsIcon.title = task.dependencies.map(id => this._titleById.get(id) || id).join(', ');
			metaIcons.appendChild(depsIcon);
		}
		if (task.attachments && task.attachments.length > 0) {
			metaIcons.appendChild(DOM.$('span', undefined, `📎${task.attachments.length}`));
		}
		// Chat jump button
		if (task.assigneeId) {
			const chatBtn = DOM.$('span', undefined, '💬');
			chatBtn.title = '跳转到该Agent的聊天窗口';
			// 内联样式仅设 cursor；size/padding/hover 由 .native-tb-card-meta-icons > span[title*="跳转"] 统一样式提供
			chatBtn.style.cursor = 'pointer';
			chatBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this._onChatJump.fire({
					agentId: task.assigneeId!,
					agentName: task.assigneeName || task.assigneeId!,
					taskId: task.id,
					workspaceId: task.workspaceId,
					worktreePath: task.worktreePath,
				});
			});
			metaIcons.appendChild(chatBtn);
		}
		footer.appendChild(metaIcons);

		card.appendChild(footer);

		// Click to open detail modal (click on the whole card, but not action buttons)
		card.addEventListener('click', (e) => {
			// Don't fire if clicking action buttons
			const target = e.target as HTMLElement;
			if (target.closest('action-btn')) { return; }
			this._onTaskDetailRequest.fire({ task, employees: data.employees, allTasks: data.tasks });
		});
		card.style.cursor = 'pointer';

		return card;
	}

	/** Deterministic color from string (for avatar background). */
	private _avatarColor(name: string): string {
		const colors = ['#4fc1ff', '#4ec9b0', '#c586c0', '#ce9178', '#f44747', '#569cd6', '#dcdcaa', '#6a9955'];
		let hash = 0;
		for (let i = 0; i < name.length; i++) {
			hash = ((hash << 5) - hash) + name.charCodeAt(i);
			hash |= 0;
		}
		return colors[Math.abs(hash) % colors.length];
	}

	private _getTasksForColumn(data: TaskBoardRenderData, col: ColumnDef): TaskBoardRecord[] {
		return data.tasks.filter(t => {
			if (!col.statuses.includes(t.status)) { return false; }
			if (data.filter.employeeFilter !== 'all' && t.assigneeId !== data.filter.employeeFilter) { return false; }
			return true;
		});
	}

	// ─── Task Detail Modal ────────────────────────────────────────────

	showTaskDetailModal(
		parent: HTMLElement,
		task: TaskBoardRecord,
		employees: EmployeeInfo[],
		allTasks: TaskBoardRecord[],
	): Promise<{ action: 'close' | 'statusChange' | 'delete' | 'archive' | 'block' | 'unblock'; status?: TaskBoardStatus; taskId: string }> {
		return new Promise((resolve) => {
			const overlay = DOM.$('div.native-tb-detail-overlay');
			const modal = DOM.$('div.native-tb-detail-modal');

			// === Header ===
			const header = DOM.$('div.native-tb-detail-header');
			const headerLeft = DOM.$('div.native-tb-detail-header-left');
			headerLeft.appendChild(DOM.$('span.native-tb-detail-id', undefined, `#${task.id.slice(0, 12)}`));
			headerLeft.appendChild(DOM.$('h2.native-tb-detail-title', undefined, task.title));
			header.appendChild(headerLeft);

			const closeBtn = DOM.$('button.native-tb-detail-close', undefined, '✕');
			closeBtn.title = '关闭 (Esc)';
			closeBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'close', taskId: task.id }); });
			header.appendChild(closeBtn);
			modal.appendChild(header);

			// === Body ===
			const body = DOM.$('div.native-tb-detail-body');

			// Status row (editable) + Priority
			const statusRow = DOM.$('div.native-tb-detail-row');
			statusRow.appendChild(DOM.$('span.native-tb-detail-row-label', undefined, '状态'));

			const statusSelect = DOM.$('select.native-tb-filter-select') as HTMLSelectElement;
			const statusLabels: [TaskBoardStatus, string][] = [
				['triage' as TaskBoardStatus, '🗂 待规划'],
				['todo' as TaskBoardStatus, '📋 待执行'],
				['ready' as TaskBoardStatus, '✅ 就绪'],
				['running' as TaskBoardStatus, '⚡ 执行中'],
				['blocked' as TaskBoardStatus, '🚫 阻塞'],
				['done' as TaskBoardStatus, '✔ 已完成'],
				['cancelled' as TaskBoardStatus, '⏹ 取消'],
				['archived' as TaskBoardStatus, '📦 归档'],
			];
			for (const [val, label] of statusLabels) {
				const opt = document.createElement('option');
				opt.value = val;
				opt.textContent = label;
				if (val === task.status) { opt.selected = true; }
				statusSelect.appendChild(opt);
			}
			statusRow.appendChild(statusSelect);

			statusRow.appendChild(document.createTextNode('  '));
			statusRow.appendChild(DOM.$('span.native-tb-detail-row-label', undefined, '优先级'));
			const prioLabels: Record<string, string> = { high: '🔴 高', medium: '🟡 中', low: '🟢 低' };
			const prioChip = DOM.$(`span.native-tb-priority-chip native-tb-priority-${task.priority || 'medium'}`, undefined, prioLabels[task.priority || 'medium'] ?? task.priority);
			statusRow.appendChild(prioChip);
			body.appendChild(statusRow);

			// Meta grid
			const meta = DOM.$('div.native-tb-detail-meta-grid');
			const emp = employees.find(e => e.id === task.assigneeId);
			meta.appendChild(this._detailMetaItem('负责人', emp?.name || task.assigneeName || task.assigneeId || '未指派'));
			meta.appendChild(this._detailMetaItem('来源', task.source === 'delegation' ? '🤖 Agent委派' : '✋ 手动创建'));
			meta.appendChild(this._detailMetaItem('看板', task.boardId || '默认看板'));
			if (task.worktreePath) {
				meta.appendChild(this._detailMetaItem('Worktree', task.worktreePath.split('/').pop() || task.worktreePath));
			}
			body.appendChild(meta);

			// Description
			if (task.description) {
				const descSection = DOM.$('div');
				descSection.appendChild(DOM.$('span.native-tb-detail-section-label', undefined, '描述'));
				const descEl = DOM.$('div.native-tb-detail-desc', undefined, task.description);
				descSection.appendChild(descEl);
				body.appendChild(descSection);
			}

			// Dependencies
			if (task.dependencies && task.dependencies.length > 0) {
				const depsSection = DOM.$('div');
				depsSection.appendChild(DOM.$('span.native-tb-detail-section-label', undefined, `依赖任务 (${task.dependencies.length})`));
				const depsChips = DOM.$('div.native-tb-detail-deps');
				for (const depId of task.dependencies) {
					const depTask = allTasks.find(t => t.id === depId);
					const depChip = DOM.$('a.native-tb-detail-dep-chip');
					const dotClass = depTask ? (depTask.status === 'done' ? 'done' : (depTask.status === 'running' ? 'active' : 'waiting')) : 'waiting';
					const dot = DOM.$(`span.native-tb-detail-dep-dot.${dotClass}`);
					depChip.appendChild(dot);
					depChip.appendChild(document.createTextNode(depTask?.title || depId));
					depChip.title = depTask ? `状态: ${depTask.status}` : depId;
					depsChips.appendChild(depChip);
				}
				depsSection.appendChild(depsChips);
				body.appendChild(depsSection);
			}

			// Timestamps
			const ts = DOM.$('div.native-tb-detail-timestamps');
			ts.appendChild(DOM.$('span', undefined, `创建 ${task.createdAt}`));
			ts.appendChild(DOM.$('span', undefined, `更新 ${task.updatedAt}`));
			if (task.completedAt) {
				ts.appendChild(DOM.$('span', undefined, `完成 ${task.completedAt}`));
			}
			body.appendChild(ts);

			modal.appendChild(body);

			// === Footer ===
			const footer = DOM.$('div.native-tb-detail-footer');
			const footerLeft = DOM.$('div.native-tb-detail-footer-left');

			const deleteBtn = DOM.$('button.native-tb-btn.native-tb-btn-danger', undefined, '🗑 删除');
			deleteBtn.title = '删除此任务';
			deleteBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'delete', taskId: task.id }); });
			footerLeft.appendChild(deleteBtn);

			const archiveBtn = DOM.$('button.native-tb-btn', undefined, '📦 归档');
			archiveBtn.title = '归档任务';
			archiveBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'archive', taskId: task.id }); });
			footerLeft.appendChild(archiveBtn);

			if (task.status === 'blocked') {
				const unblockBtn = DOM.$('button.native-tb-btn', undefined, '✅ 取消阻塞');
				unblockBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'unblock', taskId: task.id }); });
				footerLeft.appendChild(unblockBtn);
			} else if (task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'archived') {
				const blockBtn = DOM.$('button.native-tb-btn', undefined, '🚫 标记阻塞');
				blockBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'block', taskId: task.id }); });
				footerLeft.appendChild(blockBtn);
			}

			footer.appendChild(footerLeft);

			const footerRight = DOM.$('div.native-tb-detail-footer-right');
			const cancelBtn = DOM.$('button.native-tb-btn', undefined, '取消');
			cancelBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'close', taskId: task.id }); });
			footerRight.appendChild(cancelBtn);

			const saveBtn = DOM.$('button.native-tb-btn.native-tb-btn-primary', undefined, '💾 保存');
			saveBtn.title = '保存状态修改';
			saveBtn.addEventListener('click', () => {
				const newStatus = statusSelect.value as TaskBoardStatus;
				overlay.remove();
				resolve({ action: 'statusChange', status: newStatus, taskId: task.id });
			});
			footerRight.appendChild(saveBtn);

			footer.appendChild(footerRight);
			modal.appendChild(footer);

			overlay.appendChild(modal);

			// Close on overlay click
			overlay.addEventListener('click', (e) => {
				if (e.target === overlay) { overlay.remove(); resolve({ action: 'close', taskId: task.id }); }
			});

			// Close on Escape
			const escHandler = (e: KeyboardEvent) => {
				if (e.key === 'Escape') { overlay.remove(); resolve({ action: 'close', taskId: task.id }); document.removeEventListener('keydown', escHandler); }
			};
			document.addEventListener('keydown', escHandler);

			parent.appendChild(overlay);
		});
	}

	private _detailMetaItem(label: string, value: string): HTMLElement {
		const item = DOM.$('div.native-tb-detail-meta-item');
		item.appendChild(DOM.$('span.ntb-meta-label', undefined, label));
		item.appendChild(DOM.$('span.ntb-meta-value', undefined, value));
		return item;
	}

	// ─── Create Task Modal ────────────────────────────────────────────

	/** Renders the create-task modal overlay and returns a promise that resolves when submitted or cancelled. */
	showCreateTaskModal(
		parent: HTMLElement,
		employees: EmployeeInfo[],
		allTasks: TaskBoardRecord[],
		workspaces: { id: string; name: string }[],
		activeWorkspaceId: string,
		loadWorktrees: (workspaceId: string) => Promise<WorktreeInfo[]>,
		loadSessions: (agentId: string) => Promise<{ id: string; name: string; messageCount: number; updatedAt: string }[]>,
	): Promise<CreateTaskResult | null> {
		return new Promise((resolve) => {
			const overlay = DOM.$('div.native-tb-modal-overlay');
			const modal = DOM.$('div.native-tb-modal');

			// Header
			const header = DOM.$('div.native-tb-modal-header');
			header.appendChild(DOM.$('span', undefined, '📋 创建任务'));
			const closeBtn = DOM.$('button.native-tb-modal-close', undefined, '✕');
			closeBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });
			header.appendChild(closeBtn);
			modal.appendChild(header);

			// Body
			const body = DOM.$('div.native-tb-modal-body');

			// ★ 1. Assignee — top of form
			const assigneeField = DOM.$('div.native-tb-field');
			const assigneeLabel = DOM.$('span.native-tb-field-label');
			assigneeLabel.appendChild(document.createTextNode('负责员工'));
			assigneeLabel.style.fontSize = '12px';
			assigneeLabel.style.fontWeight = '500';
			assigneeField.appendChild(assigneeLabel);
			const assigneeSelect = DOM.$('select.native-tb-filter-select') as HTMLSelectElement;
			{
				const opt = document.createElement('option');
				opt.value = '';
				opt.textContent = '未指派（自动分配）';
				assigneeSelect.appendChild(opt);
			}
			for (const emp of employees) {
				const opt = document.createElement('option');
				opt.value = emp.id;
				opt.textContent = emp.name;
				assigneeSelect.appendChild(opt);
			}
			assigneeField.appendChild(assigneeSelect);
			body.appendChild(assigneeField);

			// ★ 2. Session selector (shown after agent selected)
			const sessionSection = DOM.$('div');
			const sessionLabel = DOM.$('span.native-tb-field-label', undefined, '关联会话');
			sessionLabel.style.fontSize = '11px';
			sessionLabel.style.color = 'var(--vscode-descriptionForeground)';
			sessionLabel.style.textTransform = 'uppercase';
			sessionLabel.style.letterSpacing = '0.4px';
			sessionSection.appendChild(sessionLabel);

			const sessionList = DOM.$('div');
			sessionList.style.maxHeight = '120px';
			sessionList.style.overflowY = 'auto';
			sessionList.style.marginTop = '4px';
			let selectedSessionId: string | undefined;
			let selectedSessionName: string | undefined;

			const sessionNewBtn = DOM.$('div');
			sessionNewBtn.textContent = '＋ 新建会话（输入任务标题作为会话名）';
			sessionNewBtn.style.fontSize = '11px';
			sessionNewBtn.style.color = 'var(--vscode-focusBorder)';
			sessionNewBtn.style.padding = '4px 8px';
			sessionNewBtn.style.borderRadius = '4px';
			sessionNewBtn.style.cursor = 'pointer';
			sessionNewBtn.style.border = '1px dashed var(--vscode-panel-border)';
			sessionNewBtn.addEventListener('click', () => {
				selectedSessionId = undefined;
				selectedSessionName = undefined;
				titleInput.value = '';
				titleInput.placeholder = '输入任务描述，将作为新会话名称';
				// Highlight new session button
				for (const child of Array.from(sessionList.children)) {
					(child as HTMLElement).style.borderColor = 'transparent';
					(child as HTMLElement).style.background = '';
				}
				sessionNewBtn.style.borderColor = 'var(--vscode-focusBorder)';
				sessionNewBtn.style.background = '#007acc15';
			});
			sessionSection.appendChild(sessionList);
			sessionSection.appendChild(sessionNewBtn);
			body.appendChild(sessionSection);

			const refreshSessions = async (agentId: string) => {
				while (sessionList.firstChild) { sessionList.removeChild(sessionList.firstChild); }
				sessionSection.style.display = 'block';
				try {
					const sessions = await loadSessions(agentId);
					if (sessions.length === 0) {
						const emptyMsg = DOM.$('div');
						emptyMsg.textContent = '📭 该 Agent 暂无历史会话';
						emptyMsg.style.fontSize = '11px';
						emptyMsg.style.color = 'var(--vscode-descriptionForeground)';
						emptyMsg.style.padding = '4px 0';
						sessionList.appendChild(emptyMsg);
						sessionNewBtn.textContent = '＋ 输入标题后将自动创建新会话';
					} else {
						for (const s of sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
							const item = DOM.$('div');
							item.style.display = 'flex';
							item.style.alignItems = 'center';
							item.style.gap = '6px';
							item.style.padding = '4px 8px';
							item.style.borderRadius = '4px';
							item.style.fontSize = '11px';
							item.style.cursor = 'pointer';
							item.style.border = '1px solid transparent';
							item.appendChild(DOM.$('span', undefined, '💬'));
							item.appendChild(DOM.$('span', undefined, s.name));
							item.appendChild(DOM.$('span', undefined, `${s.messageCount}条`));
							const timeStr = s.updatedAt.slice(11, 16);
							item.appendChild(DOM.$('span', undefined, timeStr));
							item.addEventListener('click', () => {
								selectedSessionId = s.id;
								selectedSessionName = s.name;
								titleInput.value = s.name;
								titleInput.placeholder = s.name;
								for (const c of Array.from(sessionList.children)) {
									(c as HTMLElement).style.borderColor = 'transparent';
									(c as HTMLElement).style.background = '';
								}
								item.style.borderColor = 'var(--vscode-focusBorder)';
								item.style.background = '#007acc15';
								sessionNewBtn.style.borderColor = '1px dashed var(--vscode-panel-border)';
								sessionNewBtn.style.background = '';
							});
							sessionList.appendChild(item);
						}
						sessionNewBtn.textContent = '＋ 新建会话…';
					}
				} catch {
					sessionList.appendChild(DOM.$('div', undefined, '加载会话失败'));
				}
			};
			assigneeSelect.addEventListener('change', () => {
				const agentId = assigneeSelect.value;
				if (agentId) {
					void refreshSessions(agentId);
				} else {
					sessionSection.style.display = 'none';
					selectedSessionId = undefined;
					selectedSessionName = undefined;
					titleInput.placeholder = '简要描述这个任务';
				}
			});
			// Hide session section initially
			sessionSection.style.display = 'none';

			const divider0 = DOM.$('div');
			divider0.style.borderTop = '1px solid var(--vscode-panel-border)';
			divider0.style.margin = '2px 0';
			body.appendChild(divider0);

			// ★ 3. Title / Session name
			const titleField = DOM.$('div.native-tb-field');
			const titleLabel = DOM.$('span.native-tb-field-label');
			titleLabel.appendChild(document.createTextNode('任务标题 / 会话名'));
			const titleRequired = DOM.$('span', undefined, ' *');
			titleRequired.style.color = '#f87171';
			titleLabel.appendChild(titleRequired);
			titleField.appendChild(titleLabel);
			const titleInput = DOM.$('input.native-tb-input') as HTMLInputElement;
			titleInput.placeholder = '简要描述这个任务';
			// Sync title changes back to the selected session item
			titleInput.addEventListener('input', () => {
				if (!selectedSessionId || !selectedSessionName) { return; }
				if (titleInput.value === selectedSessionName) { return; }
				selectedSessionName = titleInput.value;
				// Update the selected session item's displayed name
				for (const child of Array.from(sessionList.children)) {
					if ((child as HTMLElement).style.borderColor?.includes('var(--vscode-focusBorder)') ||
						(child as HTMLElement).style.borderColor === 'rgb(0, 122, 204)') {
						const spans = (child as HTMLElement).querySelectorAll('span');
						if (spans.length >= 2) { spans[1].textContent = selectedSessionName; }
					}
				}
			});
			titleField.appendChild(titleInput);
			body.appendChild(titleField);

			// Description — rich contenteditable with image paste & file drop support
			const descField = DOM.$('div.native-tb-field');
			descField.appendChild(DOM.$('span.native-tb-field-label', undefined, '任务描述 (支持粘贴图片、拖拽文件)'));
			const descEditor = DOM.$('div.native-tb-rich-desc');
			descEditor.contentEditable = 'true';
			descEditor.setAttribute('role', 'textbox');
			descEditor.setAttribute('aria-multiline', 'true');

			// Collected attachments
			const descAttachments: { name: string; mimeType: string; base64Content: string }[] = [];

			// Paste handler — detect images
			descEditor.addEventListener('paste', (e: ClipboardEvent) => {
				const items = e.clipboardData?.items;
				if (!items) { return; }
				for (const item of Array.from(items)) {
					if (item.type.startsWith('image/')) {
						e.preventDefault();
						const file = item.getAsFile();
						if (!file) { continue; }
						const reader = new FileReader();
						reader.onload = () => {
							const img = document.createElement('img');
							img.src = reader.result as string;
							img.className = 'inline-img';
							img.title = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
							descAttachments.push({ name: file.name, mimeType: file.type, base64Content: (reader.result as string).split(',')[1] || '' });
							// Insert at cursor
							const sel = window.getSelection();
							if (sel && sel.rangeCount > 0 && descEditor.contains(sel.anchorNode)) {
								sel.getRangeAt(0).insertNode(img);
								sel.collapseToEnd();
							} else {
								descEditor.appendChild(img);
							}
						};
						reader.readAsDataURL(file);
						return;
					}
				}
			});

			// Drag-and-drop files
			descEditor.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); descEditor.classList.add('drag-over'); });
			descEditor.addEventListener('dragleave', () => { descEditor.classList.remove('drag-over'); });
			descEditor.addEventListener('drop', (e: DragEvent) => {
				e.preventDefault();
				descEditor.classList.remove('drag-over');
				const files = e.dataTransfer?.files;
				if (!files) { return; }
				for (const file of Array.from(files)) {
					if (file.type.startsWith('image/')) {
						const reader = new FileReader();
						reader.onload = () => {
							const img = document.createElement('img');
							img.src = reader.result as string;
							img.className = 'inline-img';
							img.title = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
							descAttachments.push({ name: file.name, mimeType: file.type, base64Content: (reader.result as string).split(',')[1] || '' });
							const sel = window.getSelection();
							if (sel && sel.rangeCount > 0 && descEditor.contains(sel.anchorNode)) {
								sel.getRangeAt(0).insertNode(img);
								sel.collapseToEnd();
							} else {
								descEditor.appendChild(img);
							}
						};
						reader.readAsDataURL(file);
					} else {
						const chip = document.createElement('span');
						chip.className = 'native-tb-file-chip';
						const fIcon = document.createElement('span');
						fIcon.style.fontSize = '14px';
						fIcon.textContent = '📄';
						chip.appendChild(fIcon);
						const fName = document.createElement('span');
						fName.className = 'f-name';
						fName.title = file.name;
						fName.textContent = file.name;
						chip.appendChild(fName);
						const fSize = document.createElement('span');
						fSize.className = 'f-size';
						fSize.textContent = `${(file.size / 1024).toFixed(1)} KB`;
						chip.appendChild(fSize);
						const rmBtn = document.createElement('button');
						rmBtn.className = 'f-remove';
						rmBtn.textContent = '✕';
						rmBtn.addEventListener('click', () => {
							const idx = descAttachments.findIndex(a => a.name === file.name);
							if (idx !== -1) { descAttachments.splice(idx, 1); }
							chip.remove();
						});
						chip.appendChild(rmBtn);
						// Read as base64 for attachment storage
						const reader = new FileReader();
						reader.onload = () => descAttachments.push({ name: file.name, mimeType: file.type, base64Content: (reader.result as string).split(',')[1] || '' });
						reader.readAsDataURL(file);
						descEditor.appendChild(chip);
						descEditor.appendChild(document.createTextNode(' '));
					}
				}
			});
			descField.appendChild(descEditor);

			// Toolbar
			const toolbar = DOM.$('div.native-tb-desc-toolbar');
			const hiddenFileInput = document.createElement('input');
			hiddenFileInput.type = 'file';
			hiddenFileInput.multiple = true;
			hiddenFileInput.accept = 'image/*,.pdf,.md,.txt,.doc,.docx,.xls,.xlsx';
			hiddenFileInput.className = 'native-tb-desc-file-input';
			hiddenFileInput.addEventListener('change', () => {
				const files = hiddenFileInput.files;
				if (!files) { return; }
				for (const file of Array.from(files)) {
					const reader = new FileReader();
					reader.onload = () => {
						const content = reader.result as string;
						if (file.type.startsWith('image/')) {
							const img = document.createElement('img');
							img.src = content;
							img.className = 'inline-img';
							img.title = file.name;
							descAttachments.push({ name: file.name, mimeType: file.type, base64Content: content.split(',')[1] || '' });
							descEditor.appendChild(img);
						} else {
							const chip = document.createElement('span');
							chip.className = 'native-tb-file-chip';
							const fIcon2 = document.createElement('span');
							fIcon2.style.fontSize = '14px';
							fIcon2.textContent = '📄';
							chip.appendChild(fIcon2);
							const fName2 = document.createElement('span');
							fName2.className = 'f-name';
							fName2.title = file.name;
							fName2.textContent = file.name;
							chip.appendChild(fName2);
							const fSize2 = document.createElement('span');
							fSize2.className = 'f-size';
							fSize2.textContent = `${(file.size / 1024).toFixed(1)} KB`;
							chip.appendChild(fSize2);
							const rmBtn2 = document.createElement('button');
							rmBtn2.className = 'f-remove';
							rmBtn2.textContent = '✕';
							rmBtn2.addEventListener('click', () => { chip.remove(); });
							chip.appendChild(rmBtn2);
							descAttachments.push({ name: file.name, mimeType: file.type, base64Content: content.split(',')[1] || '' });
							descEditor.appendChild(chip);
						}
					};
					reader.readAsDataURL(file);
				}
			});
			toolbar.appendChild(hiddenFileInput);

			const pasteBtn = DOM.$('button.native-tb-desc-toolbar-btn');
			pasteBtn.textContent = '🖼 粘贴图片';
			pasteBtn.title = '提示: 直接从剪贴板 Ctrl+V 粘贴图片';
			pasteBtn.addEventListener('click', () => { descEditor.focus(); });
			toolbar.appendChild(pasteBtn);

			const fileBtn = DOM.$('button.native-tb-desc-toolbar-btn');
			fileBtn.textContent = '📎 选择文件';
			fileBtn.title = '选择图片或文档文件';
			fileBtn.addEventListener('click', () => { hiddenFileInput.click(); });
			toolbar.appendChild(fileBtn);
			descField.appendChild(toolbar);
			body.appendChild(descField);

			// Divider
			const divider = DOM.$('div');
			divider.style.borderTop = '1px solid var(--vscode-panel-border)';
			divider.style.margin = '2px 0';
			body.appendChild(divider);

			// ═══ Workspace + Worktree ═══
			const envSection = DOM.$('div');
			const envLabel = DOM.$('span.native-tb-field-label', undefined, '🏢 执行环境');
			envLabel.style.fontSize = '11px';
			envLabel.style.color = 'var(--vscode-descriptionForeground)';
			envLabel.style.textTransform = 'uppercase';
			envLabel.style.letterSpacing = '0.4px';
			envSection.appendChild(envLabel);
			envSection.appendChild(document.createElement('br'));
			envSection.appendChild(document.createElement('br'));

			const wsWtRow = DOM.$('div.native-tb-field-row');

			const wsField = DOM.$('div.native-tb-field');
			wsField.appendChild(DOM.$('span.native-tb-field-label', undefined, '工作区'));
			const wsSelect = DOM.$('select.native-tb-filter-select') as HTMLSelectElement;
			{
				const opt = document.createElement('option');
				opt.value = '';
				opt.textContent = '当前工作区';
				wsSelect.appendChild(opt);
			}
			for (const ws of workspaces) {
				const opt = document.createElement('option');
				opt.value = ws.id;
				opt.textContent = ws.name;
				if (ws.id === activeWorkspaceId) { opt.selected = true; }
				wsSelect.appendChild(opt);
			}
			wsField.appendChild(wsSelect);
			wsWtRow.appendChild(wsField);

			const wtField = DOM.$('div.native-tb-field');
			wtField.appendChild(DOM.$('span.native-tb-field-label', undefined, 'Git 工作分支'));
			const wtSelect = DOM.$('select.native-tb-filter-select') as HTMLSelectElement;
			{
				const opt = document.createElement('option');
				opt.value = '';
				opt.textContent = '不指定（主仓库执行）';
				wtSelect.appendChild(opt);
			}
			// Load worktrees on workspace change
			const wtLoading = document.createElement('option');
			wtLoading.value = '';
			wtLoading.textContent = '加载中…';
			wtLoading.disabled = true;

			let currentWtList: WorktreeInfo[] = [];
			const refreshWorktrees = async (wsId: string) => {
				while (wtSelect.options.length > 1) { wtSelect.remove(1); }
				wtSelect.appendChild(wtLoading);
				wtSelect.disabled = true;
				try {
					currentWtList = await loadWorktrees(wsId);
					while (wtSelect.firstChild) { wtSelect.removeChild(wtSelect.firstChild); }
					const noOpt = document.createElement('option');
					noOpt.value = '';
					noOpt.textContent = currentWtList.length > 0 ? '不指定（主仓库执行）' : '无可用 worktree';
					wtSelect.appendChild(noOpt);
					for (const wt of currentWtList) {
						const opt = document.createElement('option');
						opt.value = wt.path;
						opt.textContent = `${wt.branch}`;
						wtSelect.appendChild(opt);
					}
				} catch {
					while (wtSelect.firstChild) { wtSelect.removeChild(wtSelect.firstChild); }
					const opt = document.createElement('option');
					opt.value = '';
					opt.textContent = '加载失败';
					wtSelect.appendChild(opt);
				} finally {
					wtSelect.disabled = false;
				}
			};
			wsSelect.addEventListener('change', () => {
				const wsId = wsSelect.value || activeWorkspaceId;
				void refreshWorktrees(wsId);
			});
			// Initial load
			void refreshWorktrees(activeWorkspaceId);

			wtField.appendChild(wtSelect);
			wsWtRow.appendChild(wtField);
			envSection.appendChild(wsWtRow);

			// Worktree preview
			const wtPreview = DOM.$('div');
			wtPreview.style.background = 'var(--vscode-sideBar-background)';
			wtPreview.style.border = '1px solid var(--vscode-panel-border)';
			wtPreview.style.borderRadius = '4px';
			wtPreview.style.padding = '6px 10px';
			wtPreview.style.fontSize = '11px';
			wtPreview.style.display = 'flex';
			wtPreview.style.alignItems = 'center';
			wtPreview.style.gap = '8px';
			wtPreview.style.marginTop = '6px';
			wtPreview.style.color = 'var(--vscode-descriptionForeground)';
			wtPreview.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
			wtPreview.textContent = 'ℹ 选择 worktree 分支后在此预览路径';
			wtSelect.addEventListener('change', () => {
				const wtPath = wtSelect.value;
				const wt = currentWtList.find(w => w.path === wtPath);
				if (wt) {
					wtPreview.textContent = `🌿 ${wt.path}  (${wt.branch})`;
					wtPreview.style.color = '#cca700';
				} else {
					wtPreview.textContent = 'ℹ 未选择 worktree — 任务将在主仓库中执行';
					wtPreview.style.color = 'var(--vscode-descriptionForeground)';
				}
			});
			envSection.appendChild(wtPreview);
			body.appendChild(envSection);

			const divider2 = DOM.$('div');
			divider2.style.borderTop = '1px solid var(--vscode-panel-border)';
			divider2.style.margin = '2px 0';
			body.appendChild(divider2);

			// Row: priority + deps
			const row = DOM.$('div.native-tb-field-row');

			const priorityField = DOM.$('div.native-tb-field');
			priorityField.appendChild(DOM.$('span.native-tb-field-label', undefined, '优先级'));
			const prioritySelect = DOM.$('select.native-tb-filter-select') as HTMLSelectElement;
			for (const [val, label] of [['medium', '中'], ['high', '高'], ['low', '低']] as const) {
				const opt = document.createElement('option');
				opt.value = val;
				opt.textContent = label;
				prioritySelect.appendChild(opt);
			}
			prioritySelect.value = 'medium';
			priorityField.appendChild(prioritySelect);
			row.appendChild(priorityField);

			body.appendChild(row);

			// Dependencies
			const depsField = DOM.$('div.native-tb-field');
			depsField.appendChild(DOM.$('span.native-tb-field-label', undefined, '依赖任务'));
			const selectedDeps: string[] = [];
			const depsChips = DOM.$('div');
			depsChips.style.display = 'flex';
			depsChips.style.flexWrap = 'wrap';
			depsChips.style.gap = '4px';
			depsChips.style.marginTop = '3px';

			const depsSelect = DOM.$('select.native-tb-filter-select') as HTMLSelectElement;
			depsSelect.addEventListener('change', () => {
				const id = depsSelect.value;
				if (id && !selectedDeps.includes(id)) {
					selectedDeps.push(id);
					this._updateDepsChips(depsChips, selectedDeps, allTasks, (id) => {
						const idx = selectedDeps.indexOf(id);
						if (idx !== -1) { selectedDeps.splice(idx, 1); }
						this._updateDepsChips(depsChips, selectedDeps, allTasks, () => {});
						this._updateDepsOptions(depsSelect, allTasks, selectedDeps);
					});
					this._updateDepsOptions(depsSelect, allTasks, selectedDeps);
				}
				depsSelect.value = '';
			});
			this._updateDepsOptions(depsSelect, allTasks, selectedDeps);
			depsField.appendChild(depsSelect);
			depsField.appendChild(depsChips);
			body.appendChild(depsField);

			modal.appendChild(body);

			// Footer
			const footer = DOM.$('div.native-tb-modal-footer');
			const cancelBtn = DOM.$('button.native-tb-btn', undefined, '取消');
			cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });
			footer.appendChild(cancelBtn);

			const submitBtn = DOM.$('button.native-tb-btn.native-tb-btn-primary', undefined, '🚀 创建并执行');
			submitBtn.addEventListener('click', () => {
				if (!titleInput.value.trim()) { return; }
				const emp = employees.find(e => e.id === assigneeSelect.value);
				const wtPath = wtSelect.value || undefined;
				const wt = wtPath ? currentWtList.find(w => w.path === wtPath) : undefined;
				const wsId = wsSelect.value || activeWorkspaceId;
				const descText = descEditor.innerText.trim() || undefined;
				overlay.remove();
				resolve({
					title: titleInput.value.trim(),
					description: descText,
					assigneeId: assigneeSelect.value || undefined,
					assigneeName: emp?.name || undefined,
					priority: prioritySelect.value as 'low' | 'medium' | 'high',
					dependencies: selectedDeps.length > 0 ? selectedDeps : undefined,
					workspaceId: wsId,
					worktreePath: wt?.path,
					worktreeBranch: wt?.branch,
					agentSessionId: selectedSessionId,
					attachments: descAttachments.length > 0 ? descAttachments.slice() : undefined,
					agentSessionName: selectedSessionId ? selectedSessionName : undefined,
				});
			});
			footer.appendChild(submitBtn);
			modal.appendChild(footer);

			overlay.appendChild(modal);

			// Close on overlay click
			overlay.addEventListener('click', (e) => {
				if (e.target === overlay) { overlay.remove(); resolve(null); }
			});

			// Close on Escape
			const escHandler = (e: KeyboardEvent) => {
				if (e.key === 'Escape') { overlay.remove(); resolve(null); document.removeEventListener('keydown', escHandler); }
			};
			document.addEventListener('keydown', escHandler);

			parent.appendChild(overlay);
			titleInput.focus();
		});
	}

	private _updateDepsOptions(select: HTMLSelectElement, allTasks: TaskBoardRecord[], selected: string[]): void {
		while (select.firstChild) {
			select.removeChild(select.firstChild);
		}
		const available = allTasks.filter(t => !selected.includes(t.id));
		const placeholder = document.createElement('option');
		placeholder.value = '';
		placeholder.textContent = available.length > 0 ? '选择需要先完成的任务…' : '无可选任务';
		select.appendChild(placeholder);
		for (const t of available) {
			const opt = document.createElement('option');
			opt.value = t.id;
			opt.textContent = t.title ? `${t.title}（${t.id}）` : t.id;
			select.appendChild(opt);
		}
	}

	private _updateDepsChips(
		container: HTMLElement,
		selected: string[],
		allTasks: TaskBoardRecord[],
		onRemove: (id: string) => void,
	): void {
		while (container.firstChild) {
			container.removeChild(container.firstChild);
		}
		for (const id of selected) {
			const chip = DOM.$('span');
			chip.style.display = 'inline-flex';
			chip.style.alignItems = 'center';
			chip.style.gap = '3px';
			chip.style.padding = '2px 6px';
			chip.style.borderRadius = '3px';
			chip.style.fontSize = '10px';
			chip.style.background = 'var(--vscode-badge-background)';
			chip.style.color = 'var(--vscode-badge-foreground)';
			const title = allTasks.find(t => t.id === id)?.title || id;
			chip.appendChild(DOM.$('span', undefined, title));
			const rmBtn = DOM.$('button');
			rmBtn.textContent = '✕';
			rmBtn.style.border = 'none';
			rmBtn.style.background = 'transparent';
			rmBtn.style.color = 'inherit';
			rmBtn.style.cursor = 'pointer';
			rmBtn.style.fontSize = '10px';
			rmBtn.style.padding = '0 2px';
			rmBtn.addEventListener('click', () => onRemove(id));
			chip.appendChild(rmBtn);
			container.appendChild(chip);
		}
	}
}
