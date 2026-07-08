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
	BoardLink,
} from '../../../common/agentStudioTypes.js';
import type { TapdImportResult, TapdImportFilter, TapdImportFilterOptions } from './tapdImportService.js';

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
	/** User clicked "🔗 添加看板超链接" — the consumer should open the add-link flow. */
	readonly onAddBoardLinkRequest: Event<void>;
	/** User clicked a board hyperlink chip/tab — the consumer should open the embedded window. */
	readonly onOpenBoardLink: Event<{ linkId: string }>;
	/** User clicked the delete (✕) on a board hyperlink — the consumer should remove it. */
	readonly onDeleteBoardLink: Event<{ linkId: string }>;
	/** User clicked the edit (✎) on a board hyperlink — the consumer should open the edit modal. */
	readonly onEditBoardLink: Event<{ linkId: string; name: string; url: string }>;
}

// ─── Employee / Agent info ──────────────────────────────────────────────────

export interface EmployeeInfo {
	id: string;
	name: string;
	/** Agent's real icon (emoji string like '🦞' or a data-URI image). Used for the card avatar. */
	icon?: string;
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
	/** Pinned board hyperlinks shown as chips/tabs under the header. */
	boardLinks?: BoardLink[];
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
	/** When true (default for "创建并执行"), the task auto-starts after creation. When false ("仅创建"), it stays in 'todo' without auto-execution. */
	execute?: boolean;
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
.native-tb-btn-accent {
	background: #a855f7;
	color: #fff;
}
.native-tb-btn-accent:hover {
	background: #9333ea;
}
.native-tb-btn-primary {
	background: #0e639c;
	color: #fff;
	border-color: #0e639c;
}
.native-tb-btn-primary:hover {
	background: #1177bb;
}
.native-tb-input {
	width: 100%;
	padding: 7px 10px;
	font-size: 13px;
	background: var(--vscode-input-background, #3c3c3c);
	color: var(--vscode-input-foreground, #ddd);
	border: 1px solid var(--vscode-input-border, #3c3c3c);
	border-radius: 5px;
	box-sizing: border-box;
}
.native-tb-input:focus {
	outline: 1px solid #a855f7;
	border-color: #a855f7;
}

/* === Board hyperlink bar === */
.native-tb-links {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	padding: 8px 12px;
	background: #232323;
	border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
	min-height: 36px;
	align-items: center;
}
.native-tb-links-empty {
	font-size: 11px;
	color: var(--vscode-descriptionForeground, #9d9d9d);
	font-style: italic;
}
.native-tb-link-chip {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 6px 4px 10px;
	background: var(--vscode-editorWidget-background, #252526);
	border: 1px solid var(--vscode-panel-border, #2b2b2b);
	border-radius: 6px;
	max-width: 280px;
	cursor: pointer;
	transition: border-color 0.12s, background 0.12s;
}
.native-tb-link-chip:hover {
	border-color: #a855f7;
	background: rgba(168,85,247,0.14);
}
.native-tb-link-icon {
	font-size: 12px;
}
.native-tb-link-label {
	font-size: 12px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 200px;
}
.native-tb-link-del {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 16px;
	height: 16px;
	border-radius: 4px;
	color: var(--vscode-descriptionForeground, #9d9d9d);
	font-size: 12px;
}
.native-tb-link-del:hover {
	background: rgba(255,80,80,0.18);
	color: #ff6b6b;
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
	flex: 1 1 0;
	display: flex;
	gap: 0;
	overflow-x: auto;
	overflow-y: hidden;
	min-height: 0;
	max-height: 100%;
}
.native-tb-column {
	flex: 1 1 0;
	min-width: 240px;
	max-width: 360px;
	display: flex;
	flex-direction: column;
	border-right: 1px solid var(--vscode-panel-border);
	background: var(--vscode-sideBar-background);
	min-height: 0;
	max-height: 100%;
	overflow: hidden;
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
	overflow-x: hidden;
	padding: 4px 6px;
	display: flex;
	flex-direction: column;
	gap: 8px;
	min-height: 0;
	scrollbar-width: thin;
	scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.45)) transparent;
}
.native-tb-cards::-webkit-scrollbar { width: 8px; }
.native-tb-cards::-webkit-scrollbar-thumb {
	background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.45));
	border-radius: 4px;
}
.native-tb-cards::-webkit-scrollbar-thumb:hover {
	background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.65));
}
.native-tb-cards::-webkit-scrollbar-track {
	background: transparent;
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
.native-tb-card-url {
	display: inline-block;
	margin-top: 4px;
	font-size: 11px;
	color: var(--vscode-textLink-foreground, #3794ff);
	text-decoration: none;
	word-break: break-all;
	cursor: pointer;
}
.native-tb-card-url:hover { text-decoration: underline; }
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
@keyframes native-tb-spin {
	to { transform: rotate(360deg); }
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
.native-tb-detail-title-input {
	width: 100%;
	font-size: 16px;
	font-weight: 600;
	color: var(--vscode-foreground);
	background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
	border-radius: 4px;
	padding: 4px 8px;
	font-family: inherit;
}
.native-tb-textarea {
	width: 100%;
	min-height: 90px;
	resize: vertical;
	font-size: 13px;
	line-height: 1.6;
	color: var(--vscode-foreground);
	background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
	border-radius: 4px;
	padding: 8px 10px;
	font-family: inherit;
	box-sizing: border-box;
}
.native-tb-detail-deps-edit {
	display: flex;
	flex-direction: column;
	gap: 4px;
	max-height: 140px;
	overflow-y: auto;
	padding: 6px 8px;
	background: var(--vscode-sideBar-background);
	border: 1px solid var(--vscode-panel-border);
	border-radius: 4px;
}
.native-tb-dep-option {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 13px;
	color: var(--vscode-foreground);
	cursor: pointer;
}
.native-tb-dep-option input { cursor: pointer; }
.native-tb-detail-muted {
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
	opacity: 0.7;
}
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

/* === Edit Task Detail Modal — CreateTaskMirror Styles === */
.edit-task-field { display: flex; flex-direction: column; gap: 5px; flex: 1; }
.edit-task-field-label { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); margin-left: 3px; }
.edit-task-required { color: #f44747; }
.edit-task-input, .edit-task-textarea, .edit-task-select {
	width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 13px;
	color: var(--vscode-foreground);
	background: var(--vscode-input-background,var(--vscode-editor-background));
	border: 1px solid var(--vscode-input-border,var(--vscode-panel-border,rgba(128,128,128,0.4)));
	border-radius: 4px; outline: none; font-family: inherit; transition: border-color 120ms;
}
.edit-task-input:focus,.edit-task-textarea:focus,.edit-task-select:focus { border-color: var(--vscode-focusBorder,#007acc); }
.edit-task-textarea { resize: vertical; min-height: 240px; height: 320px; line-height: 1.5; font-family: var(--vscode-editor-font-family, monospace); }
.edit-task-field-row { display: flex; gap: 12px; }
.edit-task-desc-toolbar { display: flex; gap: 6px; margin-top: 2px; }
.edit-task-desc-btn {
	display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; font-size: 11px;
	border: 1px solid var(--vscode-panel-border,rgba(128,128,128,0.35)); border-radius: 3px;
	background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer;
	transition: background 120ms,color 120ms;
}
.edit-task-desc-btn:hover { background: var(--vscode-toolbar-hoverBackground,rgba(128,128,128,0.15)); color: var(--vscode-foreground); }
.edit-worktree-hint { font-size: 11px; color: var(--vscode-descriptionForeground); opacity: 0.75; margin-top: 2px; padding-left: 3px; }
.edit-task-dep-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.edit-task-dep-chip {
	display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 11px;
	background: var(--vscode-badge-background,rgba(128,128,128,0.15));
	color: var(--vscode-badge-foreground,var(--vscode-foreground));
	border: 1px solid var(--vscode-panel-border,rgba(128,128,128,0.25)); max-width: 220px;
}
.edit-task-dep-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.edit-task-dep-chip-remove {
	flex-shrink: 0; display: flex; align-items: center; justify-content: center;
	width: 14px; height: 14px; border: none; background: transparent;
	color: var(--vscode-descriptionForeground); font-size: 10px; cursor: pointer;
	border-radius: 50%; opacity: 0.7; transition: background 120ms,opacity 120ms;
}
.edit-task-dep-chip-remove:hover { background: rgba(128,128,128,0.35); opacity: 1; }
.edit-task-footer-btn {
	padding: 5px 14px; font-size: 12px; border-radius: 4px;
	border: 1px solid var(--vscode-button-border,rgba(128,128,128,0.4));
	cursor: pointer; transition: background 120ms,opacity 120ms; font-family: inherit;
}
.edit-task-footer-btn-cancel { background: transparent; color: var(--vscode-foreground); }
.edit-task-footer-btn-cancel:hover { background: var(--vscode-toolbar-hoverBackground,rgba(128,128,128,0.15)); }
.edit-task-footer-btn-primary { background: var(--vscode-button-background,#0e639c); color: var(--vscode-button-foreground,#fff); border-color: var(--vscode-button-background,#0e639c); }
.edit-task-footer-btn-primary:hover { background: var(--vscode-button-hoverBackground,#1177bb); }
.edit-task-footer-btn-danger { background: transparent; color: #f44747; border-color: rgba(244,71,71,0.4); }
.edit-task-footer-btn-danger:hover { background: rgba(244,71,71,0.1); }
.edit-task-footer-btn-warning { background: transparent; color: #cca700; border-color: rgba(204,167,0,0.4); }
.edit-task-footer-btn-warning:hover { background: rgba(204,167,0,0.08); }
/* Attachment preview area (below textarea in edit mode) */
.tb-att-preview { margin-top: 6px; padding: 6px; border-radius: 4px; background: var(--vscode-sideBar-background,rgba(128,128,128,0.06)); max-height: 200px; overflow-y: auto; }
.tb-att-preview:empty { display: none; }
/* Clickable attachment link list (below textarea in edit mode) */
.tb-att-links { display: none; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.tb-att-links a.tb-att-link { cursor: pointer; }
/* Markdown edit/preview toggle */
.edit-task-desc-toolbar { flex-wrap: wrap; align-items: center; }
.edit-task-md-toggle { display: inline-flex; gap: 0; margin-left: auto; border: 1px solid var(--vscode-input-border,var(--vscode-panel-border,rgba(128,128,128,0.4))); border-radius: 4px; overflow: hidden; }
.edit-task-md-toggle button { border: none; border-radius: 0; background: transparent; color: var(--vscode-foreground); padding: 3px 10px; font-size: 12px; cursor: pointer; }
.edit-task-md-toggle button.active { background: var(--vscode-button-background,#007acc); color: var(--vscode-button-foreground,#fff); }
/* Markdown preview panel */
.tb-md-preview { box-sizing: border-box; width: 100%; min-height: 240px; height: 320px; overflow-y: auto; padding: 8px 10px; font-size: 13px; line-height: 1.6;
	background: var(--vscode-input-background,var(--vscode-editor-background));
	border: 1px solid var(--vscode-input-border,var(--vscode-panel-border,rgba(128,128,128,0.4))); border-radius: 4px; }
.tb-md-preview .tb-md-h1 { font-size: 1.4em; font-weight: 700; margin: 8px 0 4px; }
.tb-md-preview .tb-md-h2 { font-size: 1.25em; font-weight: 700; margin: 8px 0 4px; }
.tb-md-preview .tb-md-h3,.tb-md-preview .tb-md-h4,.tb-md-preview .tb-md-h5,.tb-md-preview .tb-md-h6 { font-weight: 700; margin: 6px 0 3px; }
.tb-md-preview .tb-md-p { margin: 4px 0; }
.tb-md-preview .tb-md-ul,.tb-md-preview .tb-md-ol { margin: 4px 0; padding-left: 22px; }
.tb-md-preview .tb-md-quote { margin: 4px 0; padding: 2px 10px; border-left: 3px solid var(--vscode-panel-border,rgba(128,128,128,0.5)); color: var(--vscode-descriptionForeground); }
.tb-md-preview .tb-md-pre { background: var(--vscode-textCodeBlock-background,rgba(128,128,128,0.12)); padding: 6px 8px; border-radius: 4px; overflow-x: auto; }
.tb-md-preview .tb-md-pre code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.tb-md-preview .tb-md-code { background: var(--vscode-textCodeBlock-background,rgba(128,128,128,0.12)); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.tb-md-preview hr { border: none; border-top: 1px solid var(--vscode-panel-border,rgba(128,128,128,0.4)); margin: 8px 0; }
.tb-att-img { max-width: 120px; max-height: 120px; margin: 3px 6px 3px 0; border-radius: 4px; border: 1px solid var(--vscode-panel-border,rgba(128,128,128,0.35)); cursor: pointer; object-fit: contain; transition: transform .15s; vertical-align: middle; }
.tb-att-img:hover { transform: scale(1.5); z-index: 10; position: relative; }
.tb-att-link { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--vscode-link-activeForeground,#3794ff); text-decoration: none; margin-right: 8px; padding: 2px 6px; border-radius: 3px; border: 1px solid var(--vscode-input-border,rgba(128,128,128,0.35)); background: var(--vscode-button-secondaryBackground,transparent); }
.tb-att-link:hover { background: var(--vscode-button-secondaryHoverBackground,rgba(56,148,255,0.12); text-decoration: underline; }
/* === Image Lightbox (click-to-zoom overlay) === */
.tb-lightbox-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 2000; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.tb-lightbox-img { max-width: 90vw; max-height: 90vh; object-fit: contain; border-radius: 6px; box-shadow: 0 8px 40px rgba(0,0,0,0.5); }
	`;

	// Append to head
	document.head.appendChild(style);
}

/**
 * Render a task description string as rich HTML inside a container element.
 *
 * Supports:
 * - Markdown image syntax  `![alt](path)` → <img> thumbnail (hover zoom)
 * - Markdown link syntax   `[text](path)` → clickable <a> file link
 * - Relative paths starting with `.sarosworkspace/` are resolved to
 *   absolute `file:///` URLs so the renderer can load local files.
 * - Remaining plain-text lines become <br>-separated text.
 */
function renderDescriptionHtml(container: HTMLElement, descText: string): void {
	DOM.clearNode(container);
	if (!descText) { return; }

	// Split into tokens: markdown images/links and raw text segments.
	const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
	const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
	const tokens: Array<{ type: 'img' | 'link' | 'text'; content: string; alt?: string; linkText?: string }> = [];
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	// Collect all markdown image and link matches, preserving order
	const allMatches: Array<{ index: number; length: number; type: 'img' | 'link'; alt?: string; href: string; linkText?: string }> = [];

	while ((match = imgRe.exec(descText)) !== null) {
		allMatches.push({ index: match.index, length: match[0].length, type: 'img', alt: match[1], href: match[2] });
	}
	while ((match = linkRe.exec(descText)) !== null) {
		// Skip if already captured as image (image regex runs first)
		if (allMatches.some(m => m.index === match!.index)) continue;
		allMatches.push({ index: match.index, length: match[0].length, type: 'link', alt: undefined, href: match[2], linkText: match[1] });
	}
	allMatches.sort((a, b) => a.index - b.index);

	for (const m of allMatches) {
		if (m.index > lastIndex) {
			tokens.push({ type: 'text', content: descText.substring(lastIndex, m.index) });
		}
		tokens.push({ type: m.type, content: m.href, alt: m.alt ?? m.href, ...(m.type === 'link' && m.linkText ? { linkText: m.linkText } : {}) });
		lastIndex = m.index + m.length;
	}
	if (lastIndex < descText.length) {
		tokens.push({ type: 'text', content: descText.substring(lastIndex) });
	}

	for (const token of tokens) {
		switch (token.type) {
			case 'img': {
				const img = document.createElement('img');
				img.className = 'tb-att-img';
				img.alt = token.alt || '';
				// Resolve .sarosworkspace/ relative paths to absolute file:///
				let src = resolveAttachmentSrc(token.content);
				if (!src.startsWith('data:') && !src.startsWith('http') && !src.startsWith('file:')) {
					src = 'file:///' + src.replace(/\\/g, '/');
				}
				img.src = src;
				img.title = `${token.alt} — 点击放大`;
				img.addEventListener('click', () => showImageLightbox(token.content, token.alt));
				container.appendChild(img);
				break;
			}
			case 'link': {
				const a = document.createElement('a');
				a.className = 'tb-att-link';
				let href = resolveAttachmentSrc(token.content);
				if (!href.startsWith('data:') && !href.startsWith('http') && !href.startsWith('file:')) {
					href = 'file:///' + href.replace(/\\/g, '/');
				}
				a.href = href;
				a.target = '_blank';
				const displayText = token.linkText || token.content.split(/[/\\]/).pop() || token.alt || token.content;
				a.textContent = `📎 ${displayText}`;
				container.appendChild(a);
				break;
			}
			case 'text': {
				const text = token.content.trim();
				if (!text) break;
				const lines = text.split('\n');
				for (let i = 0; i < lines.length; i++) {
					const span = document.createElement('span');
					span.textContent = lines[i];
					container.appendChild(span);
					if (i < lines.length - 1) container.appendChild(document.createElement('br'));
				}
				break;
			}
		}
	}
}

/** Open a local attachment path via the provided callback, or fall back to window.open. */
/** Open a local file via OS default app, or fallback to file:// URL. Silently ignores missing files. */
function openAttachmentFromPath(rawPath: string, openFile?: (path: string) => void): void {
	try {
		const absPath = resolveAttachmentSrc(rawPath);
		if (!absPath || absPath.startsWith('data:')) { return; }
		if (openFile) {
			openFile(absPath);
		} else {
			const href = absPath.startsWith('file:') ? absPath : 'file:///' + absPath.replace(/\\/g, '/');
			window.open(href, '_blank');
		}
	} catch {
		/* File missing or path invalid — ignore silently */
	}
}

/** Show a full-size image in an overlay lightbox. Closes on backdrop click / Escape key. */
function showImageLightbox(src: string, alt?: string): void {
	let resolved = resolveAttachmentSrc(src);
	if (!resolved.startsWith('data:') && !resolved.startsWith('http') && !resolved.startsWith('file:')) {
		resolved = 'file:///' + resolved.replace(/\\/g, '/');
	}
	const overlay = DOM.$('div.tb-lightbox-overlay', undefined,
		DOM.$('img.tb-lightbox-img', { src: resolved, alt: alt || '' })
	);
	overlay.addEventListener('click', () => overlay.remove());
	const escHandler = (e: KeyboardEvent) => {
		if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
	};
	document.addEventListener('keydown', escHandler);
	document.body.appendChild(overlay);
}

/** Check whether a file path/URL points to an image by its extension or data-URI MIME type. */
function looksLikeImage(path: string): boolean {
	if (/^data:image\/(png|jpe?g|gif|svg|webp);base64,/i.test(path)) return true;
	const ext = path.split(/[?#]/)[0].split('/').pop()?.split('.').pop() || '';
	return /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i.test(ext);
}

/** Render inline markdown (bold/italic/code) + attachment tokens into a parent element. */
function appendInlineMarkdown(parent: HTMLElement, text: string, openFile?: (path: string) => void): void {
	// First pass: special attachment tokens (![](), [](), @image:/@file:)
	const tokRe = /(!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|@(?:image|file):[^\s(]+\([^)]*\))/g;
	let last = 0;
	let m: RegExpExecArray | null;
	const appendPlain = (s: string) => { if (s) { appendInlineStyles(parent, s); } };
	while ((m = tokRe.exec(text)) !== null) {
		if (m.index > last) { appendPlain(text.substring(last, m.index)); }
		const tok = m[0];
		if (tok.startsWith('@')) {
			const mm = tok.match(/^@(image|file):([^\s(]+)\(([^)]*)\)$/);
			if (mm && mm[3]) {
				const type = mm[1]; const name = mm[2]; const path = mm[3];
				// @image: only renders as <img> when the resolved path actually looks like an image; otherwise degrade to link.
				if (type === 'image' && looksLikeImage(path)) {
					const img = document.createElement('img');
					img.className = 'tb-att-img';
					let src = resolveAttachmentSrc(path);
					if (!src.startsWith('data:') && !src.startsWith('http') && !src.startsWith('file:')) { src = 'file:///' + src.replace(/\\/g, '/'); }
					img.src = src; img.alt = name; img.title = `${name} — 点击放大`;
					img.addEventListener('click', () => showImageLightbox(path, name));
					parent.appendChild(img);
				} else {
					const icon = type === 'image' ? (looksLikeImage(path) ? '🖼️' : '📎') : '📎';
					const a = document.createElement('a');
					a.className = 'tb-att-link'; a.textContent = `${icon} ${name}`; a.href = '#';
					a.addEventListener('click', (e) => { e.preventDefault(); openAttachmentFromPath(path, openFile); });
					parent.appendChild(a);
				}
			} else { appendPlain(tok); }
		} else if (tok.startsWith('![')) {
			const mm = tok.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
			if (mm) {
				// Markdown ![alt](path) only renders as <img> when path looks like an image; otherwise degrade to link.
				if (looksLikeImage(mm[2])) {
					const img = document.createElement('img');
					img.className = 'tb-att-img';
					let src = resolveAttachmentSrc(mm[2]);
					if (!src.startsWith('data:') && !src.startsWith('http') && !src.startsWith('file:')) { src = 'file:///' + src.replace(/\\/g, '/'); }
					img.src = src; img.alt = mm[1] || ''; img.title = `${mm[1]} — 点击放大`;
					img.addEventListener('click', () => showImageLightbox(mm[2], mm[1]));
					parent.appendChild(img);
				} else {
					const label = mm[1] || mm[2].split(/[/\\]/).pop() || mm[2];
					const a = document.createElement('a');
					a.className = 'tb-att-link'; a.textContent = `📎 ${label}`; a.href = '#';
					a.addEventListener('click', (e) => { e.preventDefault(); openAttachmentFromPath(mm[2], openFile); });
					parent.appendChild(a);
				}
			} else { appendPlain(tok); }
		} else {
			const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
			if (mm) {
				const a = document.createElement('a');
				a.className = 'tb-att-link'; a.textContent = mm[1]; a.href = '#';
				a.addEventListener('click', (e) => { e.preventDefault(); openAttachmentFromPath(mm[2], openFile); });
				parent.appendChild(a);
			} else { appendPlain(tok); }
		}
		last = tokRe.lastIndex;
	}
	if (last < text.length) { appendPlain(text.substring(last)); }
}

/** Render **bold**, *italic* and `code` inline syntax into a parent element. */
function appendInlineStyles(parent: HTMLElement, text: string): void {
	const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) { parent.appendChild(document.createTextNode(text.substring(last, m.index))); }
		if (m[2] !== undefined) {
			const b = document.createElement('strong'); b.textContent = m[2]; parent.appendChild(b);
		} else if (m[3] !== undefined) {
			const el = document.createElement('em'); el.textContent = m[3]; parent.appendChild(el);
		} else if (m[4] !== undefined) {
			const c = document.createElement('code'); c.className = 'tb-md-code'; c.textContent = m[4]; parent.appendChild(c);
		}
		last = re.lastIndex;
	}
	if (last < text.length) { parent.appendChild(document.createTextNode(text.substring(last))); }
}

/**
 * Render task description text (with markdown) as rich HTML inside a container.
 * Supports headings, hr, blockquote, lists, code fences, bold/italic/code,
 * and attachment tokens: `![alt](path)`, `[text](path)`, `@image:name(path)`, `@file:name(path)`.
 */
function renderTaskMarkdown(container: HTMLElement, text: string, openFile?: (path: string) => void): void {
	DOM.clearNode(container);
	if (!text) { return; }
	const lines = text.split('\n');
	const frag = document.createDocumentFragment();
	const blockStartRe = /^(#{1,6})\s|^>\s?|^\s*[-*+]\s+|^\s*\d+\.\s+|^\s*```|^---+\s*$|^\*\*\*+\s*$/;
	let i = 0;
	const flushParagraph = (para: string[]) => {
		if (para.length === 0) { return; }
		const p = document.createElement('p');
		p.className = 'tb-md-p';
		appendInlineMarkdown(p, para.join('\n'), openFile);
		frag.appendChild(p);
	};
	while (i < lines.length) {
		const line = lines[i];
		// Code fence
		const fence = line.match(/^\s*```(\w*)\s*$/);
		if (fence) {
			i++;
			const code: string[] = [];
			while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
			i++; // skip closing fence
			const pre = document.createElement('pre'); pre.className = 'tb-md-pre';
			const codeEl = document.createElement('code'); codeEl.textContent = code.join('\n');
			pre.appendChild(codeEl); frag.appendChild(pre);
			continue;
		}
		// Horizontal rule
		if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) { frag.appendChild(document.createElement('hr')); i++; continue; }
		// Heading
		const h = line.match(/^(#{1,6})\s+(.*)$/);
		if (h) {
			const lvl = h[1].length;
			const el = document.createElement('h' + lvl);
			el.className = 'tb-md-h' + lvl;
			appendInlineMarkdown(el, h[2], openFile);
			frag.appendChild(el); i++; continue;
		}
		// Blockquote
		if (/^>\s?/.test(line)) {
			const quoteLines: string[] = [];
			while (i < lines.length && /^>\s?/.test(lines[i])) { quoteLines.push(lines[i].replace(/^>\s?/, '')); i++; }
			const bq = document.createElement('blockquote'); bq.className = 'tb-md-quote';
			appendInlineMarkdown(bq, quoteLines.join('\n'), openFile);
			frag.appendChild(bq); continue;
		}
		// Unordered list
		if (/^\s*[-*+]\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
			const ul = document.createElement('ul'); ul.className = 'tb-md-ul';
			for (const it of items) { const li = document.createElement('li'); appendInlineMarkdown(li, it, openFile); ul.appendChild(li); }
			frag.appendChild(ul); continue;
		}
		// Ordered list
		if (/^\s*\d+\.\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
			const ol = document.createElement('ol'); ol.className = 'tb-md-ol';
			for (const it of items) { const li = document.createElement('li'); appendInlineMarkdown(li, it, openFile); ol.appendChild(li); }
			frag.appendChild(ol); continue;
		}
		// Blank line
		if (line.trim() === '') { i++; continue; }
		// Paragraph: gather consecutive non-block lines
		const para: string[] = [];
		while (i < lines.length && lines[i].trim() !== '' && !blockStartRe.test(lines[i])) { para.push(lines[i]); i++; }
		flushParagraph(para);
	}
	container.appendChild(frag);
}

/** Resolve `.sarosworkspace/...` relative paths using the workspace root. */
function resolveAttachmentSrc(path: string): string {
	if (path.startsWith('.sarosworkspace/') || path.startsWith('.sarosworkspace\\')) {
		// Try to resolve via the active workspace path if available from the global state
		try {
			const wsRoot = (globalThis as any).__sarosWorkspaceRoot as string | undefined;
			if (wsRoot) {
				// Manual path join: ensure exactly one separator between parts.
				// Keep the leading dot — .sarosworkspace is a hidden dir name.
				const relPart = path.startsWith('.') ? path : '.' + path;
				const normalized = wsRoot.replace(/[\\/]+$/, '').replace(/\\/g, '/') + '/' + relPart;
				return normalized.replace(/\//g, '\\');  // Return native-style path for file:///
			}
		} catch { /* ignore */ }
		// Fallback: return as-is; caller may still handle it
	}
	return path;
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

	private readonly _onAddBoardLinkRequest = this._disposables.add(new Emitter<void>());
	readonly onAddBoardLinkRequest = this._onAddBoardLinkRequest.event;

	private readonly _onOpenBoardLink = this._disposables.add(new Emitter<{ linkId: string }>());
	readonly onOpenBoardLink = this._onOpenBoardLink.event;

	private readonly _onDeleteBoardLink = this._disposables.add(new Emitter<{ linkId: string }>());
	readonly onDeleteBoardLink = this._onDeleteBoardLink.event;

	private readonly _onEditBoardLink = this._disposables.add(new Emitter<{ linkId: string; name: string; url: string }>());
	readonly onEditBoardLink = this._onEditBoardLink.event;

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

		// "🔗 添加看板超链接" — replaces the old "📥 导入 TAPD" button.
		// Clicking opens the add-board-link modal; the resulting link is shown
		// as a chip below the header and opens an embedded window on click.
		const addLinkBtn = DOM.$('button.native-tb-btn.native-tb-btn-accent');
		addLinkBtn.textContent = '🔗 添加看板超链接';
		addLinkBtn.title = '绑定一个外部看板网页（如 TAPD / Jira），点击后在内嵌窗口中打开，可右键添加到看板待办';
		addLinkBtn.addEventListener('click', () => this._onAddBoardLinkRequest.fire());
		right.appendChild(addLinkBtn);

		// Diagnostics button
		const diagBtn = DOM.$('button.native-tb-btn');
		diagBtn.textContent = data.isLoading ? '⏳ 巡检中' : '🩺 巡检';
		diagBtn.title = '看板健康巡检';
		diagBtn.addEventListener('click', (e) => this._onDiagnosticsRequest.fire(e as MouseEvent));
		right.appendChild(diagBtn);

		header.appendChild(right);
		root.appendChild(header);

		// Board hyperlink bar (chips). Clicking a chip opens the embedded window.
		this._renderBoardLinkBar(root, data.boardLinks ?? []);
	}

	private _renderBoardLinkBar(root: HTMLElement, links: BoardLink[]): void {
		const bar = DOM.$('div.native-tb-links');
		if (links.length === 0) {
			const empty = DOM.$('span.native-tb-links-empty');
			empty.textContent = '暂无看板超链接 · 点击右上角「🔗 添加看板超链接」绑定外部看板网页';
			bar.appendChild(empty);
		} else {
			for (const link of links) {
				const chip = DOM.$('div.native-tb-link-chip');
				chip.title = `${link.name}\n${link.url}\n点击在内嵌窗口中打开`;
				const icon = DOM.$('span.native-tb-link-icon', undefined, this._linkIcon(link.url));
				const label = DOM.$('span.native-tb-link-label', undefined, link.name);
				const edit = DOM.$('span.native-tb-link-edit', undefined, '✎');
				edit.title = '编辑此看板超链接';
				edit.addEventListener('click', (e) => {
					e.stopPropagation();
					this._onEditBoardLink.fire({ linkId: link.id, name: link.name, url: link.url });
				});
				const del = DOM.$('span.native-tb-link-del', undefined, '✕');
				del.title = '删除此看板超链接';
				del.addEventListener('click', (e) => {
					e.stopPropagation();
					this._onDeleteBoardLink.fire({ linkId: link.id });
				});
				chip.appendChild(icon);
				chip.appendChild(label);
				chip.appendChild(edit);
				chip.appendChild(del);
				chip.addEventListener('click', () => this._onOpenBoardLink.fire({ linkId: link.id }));
				bar.appendChild(chip);
			}
		}
		root.appendChild(bar);
	}

	private _linkIcon(url: string): string {
		if (/tapd/i.test(url)) { return '🟣'; }
		if (/jira/i.test(url)) { return '🔵'; }
		if (/github/i.test(url)) { return '🐙'; }
		return '🌐';
	}

	/**
	 * "🔗 添加看板超链接" modal: collects a board name + URL, then resolves
	 * with `{ name, url }`. The consumer persists it via AgentTaskBoardService.
	 */
	showAddBoardLinkModal(
		parent: HTMLElement,
		onCreate: (name: string, url: string) => Promise<void> | void,
	): void {
		const overlay = DOM.$('div.native-tb-modal-overlay');
		overlay.style.position = 'fixed';
		overlay.style.inset = '0';
		overlay.style.background = 'rgba(0,0,0,0.5)';
		overlay.style.display = 'flex';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.zIndex = '1000';

		const modal = DOM.$('div.native-tb-modal');
		modal.style.cssText = `
			width: 440px; background: var(--vscode-editorWidget-background, #252526);
			border: 1px solid var(--vscode-panel-border, #2b2b2b); border-radius: 8px;
			box-shadow: 0 8px 40px rgba(0,0,0,0.5); overflow: hidden; color: var(--vscode-foreground, #ddd);
		`;

		const header = DOM.$('div.native-tb-modal-header');
		header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--vscode-panel-border,#2b2b2b); font-size:14px; font-weight:600;';
		header.appendChild(DOM.$('span', undefined, '🔗 添加看板超链接'));
		const closeBtn = DOM.$('span', undefined, '✕');
		closeBtn.style.cssText = 'cursor:pointer; color:var(--vscode-descriptionForeground,#9d9d9d);';
		closeBtn.addEventListener('click', () => overlay.remove());
		header.appendChild(closeBtn);
		modal.appendChild(header);

		const body = DOM.$('div');
		body.style.cssText = 'padding:16px; display:flex; flex-direction:column; gap:14px;';
		modal.appendChild(body);

		const mkField = (labelText: string) => {
			const wrap = DOM.$('div');
			wrap.style.cssText = 'display:flex; flex-direction:column; gap:5px;';
			const label = DOM.$('label');
			label.textContent = labelText;
			label.style.cssText = 'font-size:12px; color:var(--vscode-descriptionForeground,#9d9d9d);';
			wrap.appendChild(label);
			return wrap;
		};

		const nameField = mkField('看板名称');
		const nameInput = DOM.$('input.native-tb-input') as HTMLInputElement;
		nameInput.placeholder = '例如：TAPD 迭代看板';
		nameField.appendChild(nameInput);

		const urlField = mkField('看板链接（URL）');
		const urlInput = DOM.$('input.native-tb-input') as HTMLInputElement;
		urlInput.placeholder = 'https://www.tapd.cn/.../iterate/detail/...';
		urlField.appendChild(urlInput);
		const urlHint = DOM.$('span');
		urlHint.textContent = '点击对应超链接将在编辑器内嵌窗口中打开此外部看板网页，可右键添加到看板待办。';
		urlHint.style.cssText = 'font-size:11px; color:var(--vscode-descriptionForeground,#9d9d9d);';
		urlField.appendChild(urlHint);

		body.appendChild(nameField);
		body.appendChild(urlField);

		const errEl = DOM.$('div');
		errEl.style.cssText = 'font-size:12px; color:#f48771; min-height:16px;';
		body.appendChild(errEl);

		const footer = DOM.$('div.native-tb-modal-footer');
		footer.style.cssText = 'display:flex; justify-content:flex-end; gap:8px; padding:12px 16px; border-top:1px solid var(--vscode-panel-border,#2b2b2b);';
		const cancelBtn = DOM.$('button.native-tb-btn', undefined, '取消');
		cancelBtn.addEventListener('click', () => overlay.remove());
		const confirmBtn = DOM.$('button.native-tb-btn.native-tb-btn-primary', undefined, '添加');
		footer.appendChild(cancelBtn);
		footer.appendChild(confirmBtn);
		modal.appendChild(footer);

		overlay.appendChild(modal);
		parent.appendChild(overlay);

		const submit = async () => {
			const name = nameInput.value.trim();
			const url = urlInput.value.trim();
			if (!name) { errEl.textContent = '请填写看板名称'; return; }
			if (!/^https?:\/\//i.test(url)) { errEl.textContent = '请输入合法的 http/https 链接'; return; }
			confirmBtn.toggleAttribute('disabled', true);
			confirmBtn.style.opacity = '0.5';
			try {
				await onCreate(name, url);
				overlay.remove();
			} catch (err) {
				errEl.textContent = err instanceof Error ? err.message : String(err);
				confirmBtn.toggleAttribute('disabled', false);
				confirmBtn.style.opacity = '1';
			}
		};
		confirmBtn.addEventListener('click', submit);
		urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { submit(); } });
		nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { submit(); } });
		overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
		setTimeout(() => nameInput.focus(), 30);
	}

	/**
	 * "🔗 编辑看板超链接" modal: pre-filled with the existing link's name + URL.
	 */
	showEditBoardLinkModal(
		parent: HTMLElement,
		existing: { linkId: string; name: string; url: string },
		onSave: (name: string, url: string) => Promise<void> | void,
	): void {
		const overlay = DOM.$('div.native-tb-modal-overlay');
		overlay.style.position = 'fixed';
		overlay.style.inset = '0';
		overlay.style.background = 'rgba(0,0,0,0.5)';
		overlay.style.display = 'flex';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.zIndex = '1000';

		const modal = DOM.$('div.native-tb-modal');
		modal.style.cssText = `
			width: 440px; background: var(--vscode-editorWidget-background, #252526);
			border: 1px solid var(--vscode-panel-border, #2b2b2b); border-radius: 8px;
			box-shadow: 0 8px 40px rgba(0,0,0,0.5); overflow: hidden; color: var(--vscode-foreground, #ddd);
		`;

		const header = DOM.$('div.native-tb-modal-header');
		header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--vscode-panel-border,#2b2b2b); font-size:14px; font-weight:600;';
		header.appendChild(DOM.$('span', undefined, '✎ 编辑看板超链接'));
		const closeBtn = DOM.$('span', undefined, '✕');
		closeBtn.style.cssText = 'cursor:pointer; color:var(--vscode-descriptionForeground,#9d9d9d);';
		closeBtn.addEventListener('click', () => overlay.remove());
		header.appendChild(closeBtn);
		modal.appendChild(header);

		const body = DOM.$('div');
		body.style.cssText = 'padding:16px; display:flex; flex-direction:column; gap:14px;';
		modal.appendChild(body);

		const mkField = (labelText: string) => {
			const wrap = DOM.$('div');
			wrap.style.cssText = 'display:flex; flex-direction:column; gap:5px;';
			const label = DOM.$('label');
			label.textContent = labelText;
			label.style.cssText = 'font-size:12px; color:var(--vscode-descriptionForeground,#9d9d9d);';
			wrap.appendChild(label);
			return wrap;
		};

		const nameField = mkField('看板名称');
		const nameInput = DOM.$('input.native-tb-input') as HTMLInputElement;
		nameInput.value = existing.name;
		nameField.appendChild(nameInput);

		const urlField = mkField('看板链接（URL）');
		const urlInput = DOM.$('input.native-tb-input') as HTMLInputElement;
		urlInput.value = existing.url;
		urlField.appendChild(urlInput);

		body.appendChild(nameField);
		body.appendChild(urlField);

		const errEl = DOM.$('div');
		errEl.style.cssText = 'font-size:12px; color:#f48771; min-height:16px;';
		body.appendChild(errEl);

		const footer = DOM.$('div.native-tb-modal-footer');
		footer.style.cssText = 'display:flex; justify-content:flex-end; gap:8px; padding:12px 16px; border-top:1px solid var(--vscode-panel-border,#2b2b2b);';
		const cancelBtn = DOM.$('button.native-tb-btn', undefined, '取消');
		cancelBtn.addEventListener('click', () => overlay.remove());
		const saveBtn = DOM.$('button.native-tb-btn.native-tb-btn-primary', undefined, '保存');
		footer.appendChild(cancelBtn);
		footer.appendChild(saveBtn);
		modal.appendChild(footer);

		overlay.appendChild(modal);
		parent.appendChild(overlay);

		const submit = async () => {
			const newName = nameInput.value.trim();
			const newUrl = urlInput.value.trim();
			if (!newName) { errEl.textContent = '请填写看板名称'; return; }
			if (!/^https?:\/\//i.test(newUrl)) { errEl.textContent = '请输入合法的 http/https 链接'; return; }
			saveBtn.toggleAttribute('disabled', true);
			saveBtn.style.opacity = '0.5';
			try {
				await onSave(newName, newUrl);
				overlay.remove();
			} catch (err) {
				errEl.textContent = err instanceof Error ? err.message : String(err);
				saveBtn.toggleAttribute('disabled', false);
				saveBtn.style.opacity = '1';
			}
		};
		saveBtn.addEventListener('click', submit);
		urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { submit(); } });
		nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { submit(); } });
		overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
		setTimeout(() => nameInput.focus(), 30);
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
			const emp = data.employees.find(e => e.id === task.assigneeId);
			const icon = emp?.icon;
			if (icon) {
				if (icon.startsWith('data:')) {
					// Image data-URI icon (e.g. SVG avatar)
					avatar.style.backgroundImage = `url("${icon}")`;
					avatar.style.backgroundSize = 'cover';
					avatar.style.backgroundPosition = 'center';
					avatar.style.backgroundColor = 'transparent';
				} else {
					// Emoji icon — show directly, no colored background
					avatar.textContent = icon;
					avatar.style.backgroundColor = 'transparent';
					avatar.style.fontSize = '11px';
					avatar.style.lineHeight = '14px';
				}
			} else {
				avatar.textContent = assigneeName.slice(0, 2).toUpperCase();
				avatar.style.background = this._avatarColor(assigneeName);
			}
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
		options?: {
			workspaces?: { id: string; name: string }[];
			loadWorktrees?: (workspaceId: string) => Promise<WorktreeInfo[]>;
			/** Download a URL to local disk and return the local file path (or undefined on failure). */
			downloadUrl?: (url: string) => Promise<string | undefined>;
			/** Workspace root path for resolving .sarosworkspace/ relative attachment paths. */
			workspaceRoot?: string;
			/** Open a local file (absolute path or .sarosworkspace/ relative) in the OS default app. */
			openFile?: (path: string) => void;
		},
	): Promise<{ action: 'close' | 'statusChange' | 'delete' | 'archive' | 'block' | 'unblock' | 'edit'; status?: TaskBoardStatus; taskId: string; title?: string; description?: string; assigneeId?: string; assigneeName?: string; priority?: 'low' | 'medium' | 'high'; dependencies?: string[]; workspaceId?: string; worktreePath?: string; url?: string }> {
		return new Promise((resolve) => {
			// Expose workspace root for renderDescriptionHtml to resolve relative paths
			if (options?.workspaceRoot) { (globalThis as any).__sarosWorkspaceRoot = options.workspaceRoot; }
			const overlay = DOM.$('div.native-tb-detail-overlay');
			const modal = DOM.$('div.native-tb-detail-modal');

			// === Header (mirror of CreateTaskModal: fixed title + close) ===
			const header = DOM.$('div.native-tb-detail-header');
			const headerLeft = DOM.$('div.native-tb-detail-header-left');
			headerLeft.appendChild(DOM.$('span.create-task-modal-title', undefined, '📋 编辑任务'));
			const idBadge = DOM.$('span.native-tb-detail-id', undefined, `#${task.id.slice(0, 12)}`);
			idBadge.style.marginTop = '2px';
			headerLeft.appendChild(idBadge);
			header.appendChild(headerLeft);

			const closeBtn = DOM.$('button.native-tb-detail-close', undefined, '✕');
			closeBtn.title = '关闭 (Esc)';
			closeBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'close', taskId: task.id }); });
			header.appendChild(closeBtn);
			modal.appendChild(header);

			// === Body — CreateTaskMirror form layout ===
			const body = DOM.$('div.native-tb-detail-body');

			const editable = task.status === 'todo';
			let titleInput: HTMLInputElement | undefined;
			let assigneeSelect: HTMLSelectElement | undefined;
			let prioSelect: HTMLSelectElement | undefined;
			let statusSelect: HTMLSelectElement | undefined;
			let workspaceSelect: HTMLSelectElement | undefined;
			let worktreeSelect: HTMLSelectElement | undefined;
			let descInput: HTMLTextAreaElement | undefined;
			let depsContainer: HTMLElement | undefined;

			// ── Field: 负责员工 ──────────────────────────────────────
			{
				const field = DOM.$('div.edit-task-field');
				field.appendChild(DOM.$('span.edit-task-field-label', undefined, '负责员工'));
				assigneeSelect = DOM.$('select.edit-task-select') as HTMLSelectElement;
				{
					const opt = document.createElement('option'); opt.value = ''; opt.textContent = '未指派';
					assigneeSelect.appendChild(opt);
				}
				for (const e of employees) {
					const opt = document.createElement('option'); opt.value = e.id; opt.textContent = e.name;
					if (e.id === task.assigneeId) { opt.selected = true; }
					assigneeSelect.appendChild(opt);
				}
				field.appendChild(assigneeSelect);
				body.appendChild(field);
			}

			// ── Field: 任务标题/会话名 (含 URL 后缀) ─────────────────
			{
				const field = DOM.$('div.edit-task-field');
				field.appendChild(DOM.$('span.edit-task-field-label', undefined, editable ? '任务标题 / 会话名' : '任务标题'));
				if (editable) {
					titleInput = DOM.$('input.edit-task-input') as HTMLInputElement;
					// Merge title + url into one input value (title on line 1, URL on line 2 if present)
					const rawTitle = task.title || '';
					const rawUrl = task.url || '';
					titleInput.value = rawUrl ? `${rawTitle}\n${rawUrl}` : rawTitle;
					titleInput.placeholder = '简要描述这个任务\n（可选：第二行填写参考链接如 TAPD 需求地址）';
					field.appendChild(titleInput);
				} else {
					// Read-only: show title + clickable link for URL
					const wrapper = DOM.$('div');
					wrapper.appendChild(DOM.$('div', undefined, task.title));
					if (task.url) {
						const a = DOM.$('a.native-tb-card-url') as HTMLAnchorElement;
						a.href = task.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
						a.textContent = '🔗 ' + task.url; a.title = task.url;
						wrapper.appendChild(a);
					}
					field.appendChild(wrapper);
				}
				body.appendChild(field);
			}

			// ── Field: 任务描述 ──────────────────────────────────────
			{
				const field = DOM.$('div.edit-task-field');
				field.appendChild(DOM.$('span.edit-task-field-label', undefined, '任务描述（支持粘贴图片、拖拽文件）'));

				if (editable) {
					descInput = DOM.$('textarea.edit-task-textarea') as HTMLTextAreaElement;
					let descText = task.description || '';

					// Toolbar: 粘贴图片 / 选择文件
					const toolbar = DOM.$('div.edit-task-desc-toolbar');
					const pasteBtn = DOM.$('button.edit-task-desc-btn', undefined, '📋 粘贴图片');
					pasteBtn.title = '从剪贴板粘贴截图';
					pasteBtn.addEventListener('click', async () => {
						try {
							const clipItems = await navigator.clipboard.read();
							for (const item of clipItems) {
								const imgType = item.types.find(t => t.startsWith('image/'));
								if (imgType) {
									const blob = await item.getType(imgType);
									const reader = new FileReader();
									reader.onload = () => { if (descInput && typeof reader.result === 'string') { descInput.value += `\n![image](data:${imgType};base64,${reader.result.split(',')[1]})`; } };
									reader.readAsDataURL(blob);
									break;
								}
							}
						} catch { /* clipboard API not available */ }
					});
					toolbar.appendChild(pasteBtn);

					const fileBtn = DOM.$('button.edit-task-desc-btn', undefined, '📎 选择文件');
					fileBtn.title = '选择本地文件作为附件引用';
					const fileInput = document.createElement('input');
					fileInput.type = 'file'; fileInput.style.display = 'none';
					fileInput.addEventListener('change', () => {
						if (fileInput.files?.length && descInput) {
							const f = fileInput.files[0];
							descInput.value += `\n📎 ${f.name} (${(f.size / 1024).toFixed(0)}KB)`;
						}
					});
				fileBtn.addEventListener('click', () => fileInput.click());
				toolbar.appendChild(fileBtn);

				// Edit / Preview markdown toggle — default to 预览
				const mdToggle = DOM.$('div.edit-task-md-toggle');
				const editBtn = DOM.$('button.edit-task-desc-btn', undefined, '编辑');
				const prevBtn = DOM.$('button.edit-task-desc-btn.active', undefined, '预览');
				mdToggle.appendChild(editBtn);
				mdToggle.appendChild(prevBtn);
				toolbar.appendChild(mdToggle);
				field.appendChild(toolbar);

					// Clickable attachment link list — parses @image:/@file: inline references
					// from the textarea and renders them as clickable chips that open the file.
					const attLinks = DOM.$('div.tb-att-links') as HTMLElement;
					const openAttachment = (rawPath: string) => {
						const absPath = resolveAttachmentSrc(rawPath);
						if (options?.openFile) {
							options.openFile(absPath);
						} else {
							const href = absPath.startsWith('file:') ? absPath : 'file:///' + absPath.replace(/\\/g, '/');
							window.open(href, '_blank');
						}
					};
					const refreshAttachmentLinks = () => {
						DOM.clearNode(attLinks);
						const text = descInput?.value || '';
						const re = /@(image|file):([^\s(]+)\(([^)]*)\)/g;
						let m: RegExpExecArray | null;
						let count = 0;
						while ((m = re.exec(text)) !== null) {
							const type = m[1];
							const name = m[2];
							const path = m[3];
							if (!path) { continue; }
							// @image: + real image file → render <img> thumbnail
							if (type === 'image' && looksLikeImage(path)) {
								const img = document.createElement('img');
								img.className = 'tb-att-img';
								let src = resolveAttachmentSrc(path);
								if (!src.startsWith('data:') && !src.startsWith('http') && !src.startsWith('file:')) {
									src = 'file:///' + src.replace(/\\/g, '/');
								}
								img.src = src; img.alt = name; img.title = `${name} — 点击放大`;
								img.addEventListener('click', () => showImageLightbox(path, name));
								attLinks.appendChild(img);
							} else {
								const a = DOM.$('a.tb-att-link') as HTMLAnchorElement;
								a.textContent = `${type === 'image' ? '🖼️' : '📎'} ${name}`;
								a.title = `点击打开: ${path}`;
								a.addEventListener('click', (e) => { e.preventDefault(); openAttachment(path); });
								attLinks.appendChild(a);
							}
							count++;
						}
						attLinks.style.display = count > 0 ? '' : 'none';
					};
				descInput.addEventListener('input', () => { refreshAttachmentLinks(); });

				// Markdown preview panel (toggled via the 编辑/预览 buttons)
				const previewEl = DOM.$('div.tb-md-preview') as HTMLElement;
				previewEl.style.display = 'none';

				const showEdit = () => {
					if (descInput) { descInput.style.display = ''; }
					refreshAttachmentLinks();
					previewEl.style.display = 'none';
					editBtn.classList.add('active');
					prevBtn.classList.remove('active');
				};
				const showPreview = () => {
					if (!descInput) { return; }
					descInput.style.display = 'none';
					attLinks.style.display = 'none';
					renderTaskMarkdown(previewEl, descInput.value, options?.openFile);
					previewEl.style.display = '';
					prevBtn.classList.add('active');
					editBtn.classList.remove('active');
				};
				editBtn.addEventListener('click', showEdit);
				prevBtn.addEventListener('click', showPreview);

				// Set textarea value with TAPD description content (including inline @image:/@file: references)
				descInput.value = descText;
				descInput.placeholder = '补充细节、验收标准等…可粘贴图片、拖拽附件';
				field.appendChild(descInput);
				field.appendChild(attLinks);
				field.appendChild(previewEl);

				// Default to 预览 mode: hide textarea/att-links, render markdown
				showPreview();
			} else if (task.description) {
					// Render description as rich HTML: images become <img> thumbnails,
					// file links become clickable <a>, rest as text with line-breaks.
					const descEl = DOM.$('div.native-tb-detail-desc') as HTMLElement;
					renderDescriptionHtml(descEl, task.description);
					field.appendChild(descEl);
				}
				body.appendChild(field);
			}

			// ── Field: 执行环境 (工作区 + Worktree side by side) ────
			{
				const row = DOM.$('div.edit-task-field-row');

				// Workspace selector
				const wsField = DOM.$('div.edit-task-field');
				wsField.appendChild(DOM.$('span.edit-task-field-label', undefined, '工作区'));
				workspaceSelect = DOM.$('select.edit-task-select') as HTMLSelectElement;
				{
					const opt = document.createElement('option'); opt.value = ''; opt.textContent = '— 不变更 —';
					workspaceSelect.appendChild(opt);
				}
				const wsList = options?.workspaces ?? [];
				for (const ws of wsList) {
					const opt = document.createElement('option'); opt.value = ws.id; opt.textContent = ws.name;
					if (ws.id === task.workspaceId) { opt.selected = true; }
					workspaceSelect.appendChild(opt);
				}
				wsField.appendChild(workspaceSelect);
				row.appendChild(wsField);

				// Git Worktree selector
				const wtField = DOM.$('div.edit-task-field');
				wtField.appendChild(DOM.$('span.edit-task-field-label', undefined, 'Git 工作分支'));
				worktreeSelect = DOM.$('select.edit-task-select') as HTMLSelectElement;
				{
					const opt = document.createElement('option'); opt.value = ''; opt.textContent = '不指定（主仓库执行）';
					worktreeSelect.appendChild(opt);
				}

				const refreshWorktrees = async (wsId: string) => {
					while (worktreeSelect.firstChild) { worktreeSelect.removeChild(worktreeSelect.firstChild); }
					{
						const opt = document.createElement('option'); opt.value = ''; opt.textContent = '不指定（主仓库执行）';
						worktreeSelect.appendChild(opt);
					}
					if (!wsId || !options?.loadWorktrees) { return; }
					try {
						const wts = await options.loadWorktrees(wsId);
						for (const wt of wts) {
							const opt = document.createElement('option'); opt.value = wt.path;
							opt.textContent = `🌿 ${wt.branch}${wt.repoName ? ` (${wt.repoName})` : ''}`;
							if (wt.path === task.worktreePath) { opt.selected = true; }
							worktreeSelect.appendChild(opt);
						}
					} catch { /* silent */ }
				};

				const initialWsId = task.workspaceId || workspaceSelect.value;
				if (initialWsId) { void refreshWorktrees(initialWsId); }

				workspaceSelect!.addEventListener('change', () => { void refreshWorktrees(workspaceSelect!.value); });

				wtField.appendChild(worktreeSelect);
				row.appendChild(wtField);
				body.appendChild(row);

				// Worktree path hint
				if (task.worktreePath) {
					const hint = DOM.$('div.edit-worktree-hint', undefined, `ℹ️ 选择 worktree 分支后在此预览路径: ${task.worktreePath}`);
					body.appendChild(hint);
				}
			}

			// ── Field: 优先级 ────────────────────────────────────────
			{
				const field = DOM.$('div.edit-task-field');
				field.appendChild(DOM.$('span.edit-task-field-label', undefined, '优先级'));
				const prioLabels: Record<string, string> = { high: '🔴 高', medium: '🟡 中', low: '🟢 低' };
				if (editable) {
					prioSelect = DOM.$('select.edit-task-select') as HTMLSelectElement;
					for (const p of ['high', 'medium', 'low'] as const) {
						const opt = document.createElement('option'); opt.value = p; opt.textContent = prioLabels[p];
						if (p === (task.priority || 'medium')) { opt.selected = true; }
						prioSelect.appendChild(opt);
					}
					field.appendChild(prioSelect);
				} else {
					const chip = DOM.$(`span.native-tb-priority-chip native-tb-priority-${task.priority || 'medium'}`, undefined, prioLabels[task.priority || 'medium'] ?? task.priority);
					field.appendChild(chip);
				}
				body.appendChild(field);
			}

			// ── Field: 状态 ──────────────────────────────────────────
			{
				const field = DOM.$('div.edit-task-field');
				field.appendChild(DOM.$('span.edit-task-field-label', undefined, '状态'));
				statusSelect = DOM.$('select.edit-task-select') as HTMLSelectElement;
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
					const opt = document.createElement('option'); opt.value = val; opt.textContent = label;
					if (val === task.status) { opt.selected = true; }
					statusSelect.appendChild(opt);
				}
				field.appendChild(statusSelect);
				body.appendChild(field);
			}

			// ── Field: 依赖任务 ──────────────────────────────────────
			{
				const field = DOM.$('div.edit-task-field');
				field.appendChild(DOM.$('span.edit-task-field-label', undefined, '依赖任务'));

				if (editable) {
					const depSelect = DOM.$('select.edit-task-select') as HTMLSelectElement;
					{
						const opt = document.createElement('option'); opt.value = '';
						const availableCount = allTasks.filter(t => t.id !== task.id && t.status !== 'done' && t.status !== 'archived' && t.status !== 'cancelled').length;
						opt.textContent = availableCount > 0 ? '选择需要先完成的任务…' : '无可选任务';
						depSelect.appendChild(opt);
					}
					for (const t of allTasks) {
						if (t.id === task.id) { continue; }
						if (t.status === 'done' || t.status === 'archived' || t.status === 'cancelled') { continue; }
						const opt = document.createElement('option'); opt.value = t.id;
						opt.textContent = t.title ? `${t.title}（${t.id.slice(0, 8)}）` : t.id;
						if (task.dependencies?.includes(t.id)) { opt.disabled = true; }
						depSelect.appendChild(opt);
					}
					field.appendChild(depSelect);

					// Selected dependency chips (like CreateTaskModal)
					depsContainer = DOM.$('div.edit-task-dep-chips');
					const depIds = task.dependencies || [];
					const removeDep = (id: string) => {
						const idx = depIds.indexOf(id);
						if (idx >= 0) { depIds.splice(idx, 1); }
						renderChips();
					};
					const addDep = (id: string) => {
						if (id && !depIds.includes(id)) { depIds.push(id); renderChips(); }
					};
					const renderChips = () => {
						if (!depsContainer) { return; }
						while (depsContainer.firstChild) { depsContainer.removeChild(depsContainer.firstChild); }
						for (const did of depIds) {
							const dt = allTasks.find(t => t.id === did);
							const chip = DOM.$('span.edit-task-dep-chip');
							chip.appendChild(DOM.$('span.edit-task-dep-chip-label', undefined, dt?.title || did));
							const rmBtn = DOM.$('button.edit-task-dep-chip-remove', undefined, '✕');
							rmBtn.addEventListener('click', () => removeDep(did));
							chip.appendChild(rmBtn);
							chip.title = dt ? `状态: ${dt.status}` : did;
							depsContainer.appendChild(chip);
						}
					};
					renderChips();
					depSelect.addEventListener('change', () => {
						if (depSelect.value) { addDep(depSelect.value); depSelect.value = ''; }
					});
					field.appendChild(depsContainer);
				} else if (task.dependencies && task.dependencies.length > 0) {
					const depsChips = DOM.$('div.native-tb-detail-deps');
					for (const depId of task.dependencies) {
						const depTask = allTasks.find(t => t.id === depId);
						const depChip = DOM.$('a.native-tb-detail-dep-chip');
						const dotClass = depTask ? (depTask.status === 'done' ? 'done' : (depTask.status === 'running' ? 'active' : 'waiting')) : 'waiting';
						depChip.appendChild(DOM.$(`span.native-tb-detail-dep-dot.${dotClass}`));
						depChip.appendChild(document.createTextNode(depTask?.title || depId));
						depChip.title = depTask ? `状态: ${depTask.status}` : depId;
						depsChips.appendChild(depChip);
					}
					field.appendChild(depsChips);
				}
				body.appendChild(field);
			}

			// Timestamps
			const ts = DOM.$('div.native-tb-detail-timestamps');
			ts.appendChild(DOM.$('span', undefined, `创建 ${task.createdAt}`));
			ts.appendChild(DOM.$('span', undefined, `更新 ${task.updatedAt}`));
			if (task.completedAt) { ts.appendChild(DOM.$('span', undefined, `完成 ${task.completedAt}`)); }
			body.appendChild(ts);

			modal.appendChild(body);

			// === Footer (screenshot-1 layout: 删除 | 归档 | 标记阻塞 … 取消 | 保存) ===
			const footer = DOM.$('div.native-tb-detail-footer');
			const footerLeft = DOM.$('div.native-tb-detail-footer-left');

			const deleteBtn = DOM.$('button.edit-task-footer-btn edit-task-footer-btn-danger', undefined, '🗑 删除');
			deleteBtn.title = '删除此任务';
			deleteBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'delete', taskId: task.id }); });
			footerLeft.appendChild(deleteBtn);

			const archiveBtn = DOM.$('button.edit-task-footer-btn edit-task-footer-btn-warning', undefined, '📦 归档');
			archiveBtn.title = '归档任务';
			archiveBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'archive', taskId: task.id }); });
			footerLeft.appendChild(archiveBtn);

			if (task.status === 'blocked') {
				const unblockBtn = DOM.$('button.edit-task-footer-btn', undefined, '✅ 取消阻塞');
				unblockBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'unblock', taskId: task.id }); });
				footerLeft.appendChild(unblockBtn);
			} else if (task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'archived') {
				const blockBtn = DOM.$('button.edit-task-footer-btn edit-task-footer-btn-warning', undefined, '🚫 标记阻塞');
				blockBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'block', taskId: task.id }); });
				footerLeft.appendChild(blockBtn);
			}

			footer.appendChild(footerLeft);

			const footerRight = DOM.$('div.native-tb-detail-footer-right');
			const cancelBtn = DOM.$('button.edit-task-footer-btn edit-task-footer-btn-cancel', undefined, '取消');
			cancelBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'close', taskId: task.id }); });
			footerRight.appendChild(cancelBtn);

			const saveBtn = DOM.$('button.edit-task-footer-btn edit-task-footer-btn-primary', undefined, '💾 保存');
			saveBtn.title = editable ? '保存编辑内容' : '保存状态修改';
			saveBtn.addEventListener('click', () => {
				const newStatus = statusSelect?.value as TaskBoardStatus || task.status;
				if (editable) {
					const editedAssigneeId = assigneeSelect?.value || undefined;
					const emp = editedAssigneeId ? employees.find(e => e.id === editedAssigneeId) : undefined;
					// Collect dependency IDs from visible chips
					let depIds: string[] = task.dependencies || [];
					if (depsContainer) {
						const chips = depsContainer.querySelectorAll('.edit-task-dep-chip');
						if (chips.length > 0) {
							depIds = Array.from(chips).map(chip => {
								const label = chip.querySelector('.edit-task-dep-chip-label')?.textContent;
								const found = allTasks.find(t => t.title === label);
								return found?.id || label || '';
							}).filter(Boolean);
						}
					} // end if(depsContainer)
					// Parse title (line 1) and optional URL (line 2) from the combined input
					const rawVal = (titleInput?.value || task.title).trim();
					const lines = rawVal.split('\n');
					const saveTitle = lines[0].trim() || task.title;
					const saveUrl = lines.slice(1).map(s => s.trim()).filter(Boolean)[0] || undefined;
					overlay.remove();
					resolve({
						action: 'edit',
						status: newStatus,
						taskId: task.id,
						title: saveTitle,
						description: descInput?.value,
						assigneeId: editedAssigneeId,
						assigneeName: emp?.name || undefined,
						priority: (prioSelect?.value as 'low' | 'medium' | 'high') || task.priority,
						dependencies: depIds,
						workspaceId: workspaceSelect?.value || undefined,
						worktreePath: worktreeSelect?.value || undefined,
						url: saveUrl,
					});
				} else {
					overlay.remove();
					resolve({ action: 'statusChange', status: newStatus, taskId: task.id });
				}
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
		const createOnlyBtn = DOM.$('button.native-tb-btn', undefined, '📝 仅创建');
		createOnlyBtn.title = '创建任务但不自动执行';

		const buildResult = (execute: boolean): CreateTaskResult => {
			const emp = employees.find(e => e.id === assigneeSelect.value);
			const wtPath = wtSelect.value || undefined;
			const wt = wtPath ? currentWtList.find(w => w.path === wtPath) : undefined;
			const wsId = wsSelect.value || activeWorkspaceId;
			const descText = descEditor.innerText.trim() || undefined;
			return {
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
				execute,
			};
		};

		submitBtn.addEventListener('click', () => {
			if (!titleInput.value.trim()) { return; }
			overlay.remove();
			resolve(buildResult(true));
		});
		createOnlyBtn.addEventListener('click', () => {
			if (!titleInput.value.trim()) { return; }
			overlay.remove();
			resolve(buildResult(false));
		});
		footer.appendChild(createOnlyBtn);
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

	/**
	 * TAPD import modal with filtering + batch creation.
	 *
	 * The data layer is delegated to the consumer via callbacks (wired to
	 * TapdImportService which talks to the TAPD MCP):
	 *   - `onLoadOptions` → dropdown options (status / iteration / priority) from TAPD
	 *   - `onQuery`       → filter the TAPD workitems, returns lightweight list items
	 *   - `onCreate`      → create 'todo' tasks for the selected items (fetches full
	 *                       detail + attachments for each, then persists)
	 */
	showTapdImportModal(
		parent: HTMLElement,
		onLoadOptions: (workspaceId?: string) => Promise<TapdImportFilterOptions>,
		onQuery: (filters: TapdImportFilter) => Promise<TapdImportResult[]>,
		onCreate: (items: TapdImportResult[], workspaceId?: string) => Promise<void>,
		defaultWorkspaceId?: string,
	): void {
		const overlay = DOM.$('div.native-tb-modal-overlay');
		const modal = DOM.$('div.native-tb-modal');
		modal.style.width = '860px';

		// Header
		const header = DOM.$('div.native-tb-modal-header');
		const titleWrap = DOM.$('span');
		titleWrap.textContent = '📥 从 TAPD 批量导入任务';
		const srcBadge = DOM.$('span');
		srcBadge.textContent = '数据来源：TAPD MCP';
		srcBadge.style.fontSize = '11px';
		srcBadge.style.background = '#a855f720';
		srcBadge.style.color = '#c084fc';
		srcBadge.style.padding = '1px 8px';
		srcBadge.style.borderRadius = '10px';
		srcBadge.style.marginLeft = '8px';
		titleWrap.appendChild(srcBadge);
		header.appendChild(titleWrap);
		const closeBtn = DOM.$('button.native-tb-modal-close', undefined, '✕');
		closeBtn.addEventListener('click', () => overlay.remove());
		header.appendChild(closeBtn);
		modal.appendChild(header);

		// Body
		const body = DOM.$('div.native-tb-modal-body');

		// ── Filter panel ──
		const panel = DOM.$('div');
		panel.style.background = 'var(--vscode-editorWidget-background, #2d2d30)';
		panel.style.border = '1px solid var(--vscode-widget-border, #3c3c3c)';
		panel.style.borderRadius = '8px';
		panel.style.padding = '14px';
		panel.style.display = 'flex';
		panel.style.flexDirection = 'column';
		panel.style.gap = '12px';

		// Optional single URL
		const urlField = DOM.$('div');
		urlField.style.display = 'flex';
		urlField.style.flexDirection = 'column';
		urlField.style.gap = '5px';
		const urlLabel = DOM.$('span');
		urlLabel.textContent = '指定 TAPD 链接（可选）';
		urlLabel.style.fontSize = '11px';
		urlLabel.style.color = 'var(--vscode-descriptionForeground)';
		urlField.appendChild(urlLabel);
		const urlRow = DOM.$('div');
		urlRow.style.display = 'flex';
		urlRow.style.gap = '8px';
		const urlInput = DOM.$('input.native-tb-input') as HTMLInputElement;
		urlInput.placeholder = 'https://www.tapd.cn/tapd_fe/30076258/story/detail/1130076258001093952';
		urlRow.appendChild(urlInput);
		const clearUrlBtn = DOM.$('button.native-tb-btn', undefined, '✕');
		clearUrlBtn.title = '清除链接';
		clearUrlBtn.addEventListener('click', () => { urlInput.value = ''; });
		urlRow.appendChild(clearUrlBtn);
		urlField.appendChild(urlRow);
		const urlHint = DOM.$('span');
		urlHint.textContent = '填写后，列表仅显示该链接对应的单个 TAPD 单子，其余过滤条件仍可叠加。';
		urlHint.style.fontSize = '11px';
		urlHint.style.color = 'var(--vscode-descriptionForeground)';
		urlField.appendChild(urlHint);
		panel.appendChild(urlField);

		// 5 filter fields grid
		const grid = DOM.$('div');
		grid.style.display = 'grid';
		grid.style.gridTemplateColumns = 'repeat(5, 1fr)';
		grid.style.gap = '12px';

		const mkField = (labelText: string, withTapdBadge: boolean): { wrap: HTMLElement; control: HTMLElement } => {
			const wrap = DOM.$('div');
			wrap.style.display = 'flex';
			wrap.style.flexDirection = 'column';
			wrap.style.gap = '5px';
			const label = DOM.$('span');
			label.textContent = labelText;
			label.style.fontSize = '11px';
			label.style.color = 'var(--vscode-descriptionForeground)';
			if (withTapdBadge) {
				const badge = DOM.$('span');
				badge.textContent = 'TAPD';
				badge.style.fontSize = '9px';
				badge.style.background = '#a855f720';
				badge.style.color = '#c084fc';
				badge.style.padding = '0 5px';
				badge.style.borderRadius = '8px';
				badge.style.marginLeft = '5px';
				label.appendChild(badge);
			}
			wrap.appendChild(label);
			return { wrap, control: wrap };
		};

		// Project (tree-picker, TAPD) — switching project reloads status / iteration / priority
		const projF = mkField('项目', true);
		projF.wrap.style.gridColumn = '1 / -1';
		// Trigger button showing the current selection.
		const projTrigger = DOM.$('div') as HTMLElement;
		projTrigger.style.cssText = `
			display:flex; align-items:center; gap:6px;
			padding:4px 8px; border:1px solid var(--vscode-input-border, #555); border-radius:4px;
			cursor:pointer; font-size:12px; min-height:26px;
			background:var(--vscode-input-background, #3c3c3c);
			color:var(--vscode-input-foreground, #ccc);
		`;
		const projIcon = DOM.$('span', undefined, '📂');
		projTrigger.appendChild(projIcon);
		const projLabel = DOM.$('span', undefined, '加载中…');
		projLabel.style.flex = '1';
		projLabel.style.overflow = 'hidden';
		projLabel.style.textOverflow = 'ellipsis';
		projLabel.style.whiteSpace = 'nowrap';
		projTrigger.appendChild(projLabel);
		const projArrow = DOM.$('span', undefined, '▾');
		projArrow.style.fontSize = '10px';
		projTrigger.appendChild(projArrow);
		projF.wrap.appendChild(projTrigger);
		grid.appendChild(projF.wrap);

		// ── Project tree dropdown (popover) ──
		let projDropdown: HTMLElement | null = null;
		const closeProjDropdown = () => { if (projDropdown) { projDropdown.remove(); projDropdown = null; } };

		const openProjTree = (projects: import('./tapdImportService.js').TapdImportProject[]) => {
			closeProjDropdown();
			const dd = DOM.$('div');
			dd.style.cssText = `
				position:absolute; z-index:1000;
				border:1px solid var(--vscode-widget-border, #454545);
				border-radius:8px; padding:0;
				background:var(--vscode-sideBar-background, #252526);
				box-shadow:0 6px 24px rgba(0,0,0,0.5);
				min-width:280px; max-width:360px;
			`;
			// Search bar.
			const searchRow = DOM.$('div');
			searchRow.style.padding = '8px 8px 4px';
			const searchInput = DOM.$('input') as HTMLInputElement;
			searchInput.type = 'text';
			searchInput.placeholder = '🔍 搜索项目…';
			searchInput.style.cssText = `width:100%; box-sizing:border-box; padding:4px 8px; border:1px solid var(--vscode-input-border,#555); border-radius:4px; background:var(--vscode-input-background,#3c3c3c); color:var(--vscode-input-foreground,#ccc); font-size:12px; outline:none;`;
			searchRow.appendChild(searchInput);
			dd.appendChild(searchRow);

			// Tree container.
			const treeArea = DOM.$('div');
			treeArea.style.cssText = `max-height:220px; overflow-y:auto; padding:4px 0;`;
			dd.appendChild(treeArea);

			// Footer.
			const ddFooter = DOM.$('div');
			ddFooter.style.cssText = `display:flex; justify-content:flex-end; gap:6px; padding:6px 8px; border-top:1px solid var(--vscode-widget-border,#454545);`;
			const ddOk = DOM.$('button', undefined, '确定');
			Object.assign(ddOk.style, { fontSize:'12px', padding:'2px 14px', borderRadius:'4px', background:'#a855f7', color:'#fff', border:'none', cursor:'pointer' });
			const ddCancel = DOM.$('button', undefined, '取消');
			Object.assign(ddCancel.style, { fontSize:'12px', padding:'2px 14px', borderRadius:'4px', background:'transparent', color:'var(--vscode-foreground,#ccc)', border:'1px solid var(--vscode-widget-border,#454545)', cursor:'pointer' });
			ddFooter.appendChild(ddOk);
			ddFooter.appendChild(ddCancel);
			dd.appendChild(ddFooter);

			// Track selected id.
			let selectedId = currentWsId || '';
			const expandedSet = new Set<string>();

			// Render tree node.
			const renderNode = (
				p: import('./tapdImportService.js').TapdImportProject,
				depth: number,
			): HTMLElement => {
				const row = DOM.$('div');
				row.dataset.pid = p.id;
				row.style.cssText = `display:flex; align-items:center; gap:4px; padding:3px 8px; cursor:pointer; font-size:12px; color:var(--vscode-foreground,#ccc);`;
				if (selectedId === p.id) {
					row.style.background = 'rgba(168,85,247,0.18)';
					row.style.color = '#c084fc';
				}

				// Indent + expand toggle.
				const indent = depth * 18;
				const hasChildren = !!(p.children && p.children.length);
				if (hasChildren) {
					const twist = DOM.$('span', undefined, expandedSet.has(p.id) ? '▾' : '▶');
					twist.style.fontSize = '9px';
					twist.style.width = `${indent + 12}px`;
					twist.style.textAlign = 'center';
					twist.style.flexShrink = '0';
					twist.style.cursor = 'pointer';
					row.appendChild(twist);
					twist.addEventListener('click', (e) => {
						e.stopPropagation();
						if (expandedSet.has(p.id)) { expandedSet.delete(p.id); } else { expandedSet.add(p.id); }
						rebuildTree();
					});
				} else {
					const spacer = DOM.$('span');
					spacer.style.width = `${indent + 12}px`;
					spacer.style.flexShrink = '0';
					row.appendChild(spacer);
				}

				// Radio.
				const radio = DOM.$('input') as HTMLInputElement;
				radio.type = 'radio';
				radio.name = '__tapd_proj_tree__';
				radio.checked = selectedId === p.id;
				radio.style.accentColor = '#a855f7';
				radio.style.cursor = 'pointer';
				row.appendChild(radio);

				// Label.
				const lbl = DOM.$('span', undefined, p.name);
				lbl.style.overflow = 'hidden';
				lbl.style.textOverflow = 'ellipsis';
				lbl.style.whiteSpace = 'nowrap';
				lbl.style.flex = '1';
				row.appendChild(lbl);

				// Click row → select.
				row.addEventListener('click', () => {
					selectedId = p.id;
					rebuildTree();
				});

				return row;
			};

			const renderTreeRecursive = (
				nodes: import('./tapdImportService.js').TapdImportProject[],
				container: HTMLElement,
				depth: number,
			) => {
				for (const p of nodes) {
					container.appendChild(renderNode(p, depth));
					if (p.children?.length && expandedSet.has(p.id)) {
						renderTreeRecursive(p.children, container, depth + 1);
					}
				}
			};

			const rebuildTree = () => {
				DOM.clearNode(treeArea);
				renderTreeRecursive(projects.filter(p =>
					!searchInput.value.trim() || p.name.toLowerCase().includes(searchInput.value.toLowerCase())
				), treeArea, 0);
			};

			// Initial render.
			rebuildTree();

			// Search filter.
			searchInput.addEventListener('input', () => { rebuildTree(); });

			// Confirm → apply & reload filters.
			const findProjName = (nodes: import('./tapdImportService.js').TapdImportProject[], id: string): string | undefined => {
				for (const n of nodes) { if (n.id === id) { return n.name; } const c = n.children ? findProjName(n.children, id) : undefined; if (c) return c; }
				return undefined;
			};
			ddOk.addEventListener('click', () => {
				currentWsId = selectedId;
				projLabel.textContent = selectedId
					? (findProjName(projects, selectedId) ?? selectedId)
					: '未选择';
				closeProjDropdown();
				void loadOptionsInto(currentWsId);
			});
			ddCancel.addEventListener('click', () => { closeProjDropdown(); });

			// Position below the trigger.
			const rect = projTrigger.getBoundingClientRect();
			dd.style.top = `${rect.bottom + 4}px`;
			dd.style.left = `${rect.left}px`;

			document.body.appendChild(dd);
			projDropdown = dd;

			// Auto-close on outside click.
			const onDocClick = (e: MouseEvent) => {
				if (!dd.contains(e.target as Node)) { closeProjDropdown(); document.removeEventListener('click', onDocClick); }
			};
			setTimeout(() => document.addEventListener('click', onDocClick), 0);
		};

		// Click trigger → open the tree (projects are loaded async, so we store them).
		let cachedProjects: import('./tapdImportService.js').TapdImportProject[] = [];
		projTrigger.addEventListener('click', (e) => {
			e.stopPropagation();
			if (cachedProjects.length) { openProjTree(cachedProjects); }
		});

		// 标题 (text)
		const titleF = mkField('标题', false);
		const titleInput = DOM.$('input.native-tb-input') as HTMLInputElement;
		titleInput.placeholder = '关键字…';
		titleF.wrap.appendChild(titleInput);
		// 处理人 (text)
		const ownerF = mkField('处理人', false);
		const ownerInput = DOM.$('input.native-tb-input') as HTMLInputElement;
		ownerInput.placeholder = '如：张伟';
		ownerF.wrap.appendChild(ownerInput);
		// 状态 (select, TAPD)
		const statusF = mkField('状态', true);
		const statusSelect = DOM.$('select.native-tb-input') as HTMLSelectElement;
		statusF.wrap.appendChild(statusSelect);
		// 迭代 (select, TAPD)
		const iterF = mkField('迭代', true);
		const iterSelect = DOM.$('select.native-tb-input') as HTMLSelectElement;
		iterF.wrap.appendChild(iterSelect);
		// 优先级 (select, TAPD)
		const prioF = mkField('优先级', true);
		const prioSelect = DOM.$('select.native-tb-input') as HTMLSelectElement;
		prioF.wrap.appendChild(prioSelect);

		grid.appendChild(titleF.wrap);
		grid.appendChild(ownerF.wrap);
		grid.appendChild(statusF.wrap);
		grid.appendChild(iterF.wrap);
		grid.appendChild(prioF.wrap);
		panel.appendChild(grid);

		// Filter actions
		const actions = DOM.$('div');
		actions.style.display = 'flex';
		actions.style.alignItems = 'center';
		actions.style.gap = '8px';
		const queryBtn = DOM.$('button.native-tb-btn.native-tb-btn-primary', undefined, '🔍 查询');
		const resetBtn = DOM.$('button.native-tb-btn', undefined, '重置');
		const actionsHint = DOM.$('span');
		actionsHint.textContent = '状态 / 迭代 / 优先级下拉项由 TAPD MCP 拉取；查询经 stories_get / bugs_get / tasks_get 带参执行。';
		actionsHint.style.fontSize = '12px';
		actionsHint.style.color = 'var(--vscode-descriptionForeground)';
		actions.appendChild(queryBtn);
		actions.appendChild(resetBtn);
		actions.appendChild(actionsHint);
		panel.appendChild(actions);
		body.appendChild(panel);

		// Parsing indicator
		const parsingBox = DOM.$('div');
		parsingBox.style.display = 'none';
		parsingBox.style.alignItems = 'center';
		parsingBox.style.gap = '8px';
		parsingBox.style.color = 'var(--vscode-editorWarning-foreground, #cca700)';
		parsingBox.style.fontSize = '13px';
		const spinner = DOM.$('span');
		spinner.style.width = '13px';
		spinner.style.height = '13px';
		spinner.style.border = '2px solid var(--vscode-editorWarning-foreground, #cca700)';
		spinner.style.borderTopColor = 'transparent';
		spinner.style.borderRadius = '50%';
		spinner.style.display = 'inline-block';
		spinner.style.animation = 'native-tb-spin .7s linear infinite';
		parsingBox.appendChild(spinner);
		parsingBox.appendChild(DOM.$('span', undefined, '正在通过 TAPD MCP 拉取匹配的单子…'));
		body.appendChild(parsingBox);

		// Result header
		const resultHead = DOM.$('div');
		resultHead.style.display = 'flex';
		resultHead.style.alignItems = 'center';
		resultHead.style.gap = '10px';
		resultHead.style.fontSize = '12px';
		resultHead.style.color = 'var(--vscode-descriptionForeground)';
		const selectAll = DOM.$('input') as HTMLInputElement;
		selectAll.type = 'checkbox';
		selectAll.style.width = '16px';
		selectAll.style.height = '16px';
		selectAll.style.accentColor = '#a855f7';
		resultHead.appendChild(selectAll);
		resultHead.appendChild(DOM.$('span', undefined, '全选'));
		const resultCount = DOM.$('span');
		resultCount.style.color = 'var(--vscode-foreground)';
		resultCount.style.fontWeight = '600';
		resultHead.appendChild(resultCount);
		resultHead.appendChild(DOM.$('span', undefined, '条匹配'));
		const singleNote = DOM.$('span');
		singleNote.textContent = '· 已按指定链接过滤';
		singleNote.style.color = '#c084fc';
		singleNote.style.fontSize = '11px';
		singleNote.style.display = 'none';
		resultHead.appendChild(singleNote);
		const headSpacer = DOM.$('span');
		headSpacer.style.flex = '1';
		resultHead.appendChild(headSpacer);
		const selectedCount = DOM.$('span');
		selectedCount.style.color = '#c084fc';
		selectedCount.style.fontWeight = '600';
		resultHead.appendChild(DOM.$('span', undefined, '已选 '));
		resultHead.appendChild(selectedCount);
		resultHead.appendChild(DOM.$('span', undefined, ' 条'));
		body.appendChild(resultHead);

		// Result list
		const resultList = DOM.$('div');
		resultList.style.border = '1px solid var(--vscode-widget-border, #3c3c3c)';
		resultList.style.borderRadius = '8px';
		resultList.style.overflow = 'hidden';
		resultList.style.maxHeight = '300px';
		resultList.style.overflowY = 'auto';
		resultList.appendChild(DOM.$('div', undefined, '输入过滤条件后点击「查询」'));
		(resultList.firstChild as HTMLElement).style.padding = '28px';
		(resultList.firstChild as HTMLElement).style.textAlign = 'center';
		(resultList.firstChild as HTMLElement).style.color = 'var(--vscode-descriptionForeground)';
		(resultList.firstChild as HTMLElement).style.fontSize = '13px';
		body.appendChild(resultList);

		modal.appendChild(body);

		// Footer
		const footer = DOM.$('div.native-tb-modal-footer');
		const footerHint = DOM.$('span');
		footerHint.textContent = '勾选的单子将创建为「待执行」任务，assigneeId 留空，描述图与附件下载到本地。';
		footerHint.style.fontSize = '12px';
		footerHint.style.color = 'var(--vscode-descriptionForeground)';
		footer.appendChild(footerHint);
		const footerRight = DOM.$('span');
		footerRight.style.display = 'flex';
		footerRight.style.gap = '8px';
		const cancelBtn = DOM.$('button.native-tb-btn', undefined, '取消');
		cancelBtn.addEventListener('click', () => overlay.remove());
		const createBtn = DOM.$('button.native-tb-btn.native-tb-btn-primary', undefined, '＋ 批量创建待执行任务 (0)');
		createBtn.toggleAttribute('disabled', true);
		createBtn.style.opacity = '0.5';
		footerRight.appendChild(cancelBtn);
		footerRight.appendChild(createBtn);
		footer.appendChild(footerRight);
		modal.appendChild(footer);

		overlay.appendChild(modal);
		parent.appendChild(overlay);

		// ── State ──
		let items: TapdImportResult[] = [];
		let creating = false;
		// Workspace (project) currently selected for TAPD queries.
		let currentWsId = defaultWorkspaceId || '';

		// ── Helpers ──
		const TYPE_LABEL: Record<string, string> = { story: '需求', bug: '缺陷', task: '任务' };
		const addOption = (sel: HTMLSelectElement, label: string, value: string) => {
			const opt = document.createElement('option');
			opt.value = value;
			opt.textContent = label;
			sel.appendChild(opt);
		};
		const fillSelect = (sel: HTMLSelectElement, values: string[]) => {
			DOM.clearNode(sel);
			addOption(sel, '全部', '');
			for (const v of values) { addOption(sel, v, v); }
		};
		const updateCounts = () => {
			const chks = Array.from(resultList.querySelectorAll('input[type=checkbox].rowchk')) as HTMLInputElement[];
			const n = chks.filter(c => c.checked).length;
			selectedCount.textContent = String(n);
			createBtn.textContent = `＋ 批量创建待执行任务 (${n})`;
			createBtn.toggleAttribute('disabled', n === 0 || creating);
			createBtn.style.opacity = (n === 0 || creating) ? '0.5' : '1';
		};

		// ── Load TAPD dropdown options (projects + status/iteration/priority) ──
		/** Flatten a project tree into a flat list for name lookups. */
		const flattenProjects = (nodes: import('./tapdImportService.js').TapdImportProject[]): import('./tapdImportService.js').TapdImportProject[] => {
			const out: import('./tapdImportService.js').TapdImportProject[] = [];
			const walk = (n: import('./tapdImportService.js').TapdImportProject) => { out.push(n); n.children?.forEach(walk); };
			nodes.forEach(walk);
			return out;
		};

		const loadOptionsInto = async (requestedWs: string) => {
			statusSelect.disabled = true;
			iterSelect.disabled = true;
			prioSelect.disabled = true;
			projTrigger.style.opacity = '0.5';
			projTrigger.style.pointerEvents = 'none';
			try {
				const first = await onLoadOptions(requestedWs);
				const projects = (first.projects && first.projects.length) ? first.projects : [];

				// Cache for the tree picker.
				cachedProjects = projects;

				// Update trigger label.
				if (projects.length) {
					const flat = flattenProjects(projects);
					const picked = requestedWs ? flat.find(p => p.id === requestedWs) ?? null : null;
					currentWsId = picked?.id || projects[0].id || requestedWs;
					projLabel.textContent = picked?.name || projects[0]?.name || currentWsId || '未选择';
				} else {
					currentWsId = requestedWs;
					projLabel.textContent = requestedWs ? `项目 ${requestedWs}` : '默认项目';
				}

				// Load status / iteration / priority for the resolved workspace.
				const opts = (currentWsId === requestedWs) ? first : await onLoadOptions(currentWsId);
				fillSelect(statusSelect, opts.statuses);
				fillSelect(iterSelect, opts.iterations);
				fillSelect(prioSelect, opts.priorities);
			} catch (err) {
				console.error('[TaskBoardNativeRenderer] load TAPD options failed:', err);
			} finally {
				statusSelect.disabled = false;
				iterSelect.disabled = false;
				prioSelect.disabled = false;
				projTrigger.style.opacity = '1';
				projTrigger.style.pointerEvents = '';
			}
		};

		// Initial load (uses defaultWorkspaceId when provided).
		void loadOptionsInto(currentWsId);

		// ── Query ──
		const runQuery = async () => {
			items = [];
			DOM.clearNode(resultList);
			parsingBox.style.display = 'flex';
			queryBtn.toggleAttribute('disabled', true);
			try {
				const filters: TapdImportFilter = {
					url: urlInput.value.trim() || undefined,
					name: titleInput.value.trim() || undefined,
					owner: ownerInput.value.trim() || undefined,
					status: statusSelect.value || undefined,
					iteration: iterSelect.value || undefined,
					priority: prioSelect.value || undefined,
					workspaceId: currentWsId || undefined,
				};
				items = await onQuery(filters);
				singleNote.style.display = urlInput.value.trim() ? 'inline' : 'none';
				renderList();
			} catch (err) {
				DOM.clearNode(resultList);
				const e = DOM.$('div');
				e.textContent = `⚠ ${err instanceof Error ? err.message : String(err)}`;
				e.style.padding = '20px';
				e.style.color = 'var(--vscode-errorForeground, #f48771)';
				resultList.appendChild(e);
			} finally {
				parsingBox.style.display = 'none';
				queryBtn.toggleAttribute('disabled', false);
			}
		};

		const renderList = () => {
			DOM.clearNode(resultList);
			if (!items.length) {
				const empty = DOM.$('div', undefined, '没有匹配的单子');
				empty.style.padding = '28px';
				empty.style.textAlign = 'center';
				empty.style.color = 'var(--vscode-descriptionForeground)';
				empty.style.fontSize = '13px';
				resultList.appendChild(empty);
			} else {
				items.forEach((it) => {
					const row = DOM.$('div');
					row.style.display = 'flex';
					row.style.alignItems = 'flex-start';
					row.style.gap = '10px';
					row.style.padding = '10px 12px';
					row.style.borderBottom = '1px solid var(--vscode-widget-border, #3c3c3c)';
					row.style.background = 'var(--vscode-editorWidget-background, #252526)';
					row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground, #2d2d30)'; });
					row.addEventListener('mouseleave', () => { row.style.background = row.classList.contains('selected') ? '#a855f70d' : 'var(--vscode-editorWidget-background, #252526)'; });
					const chk = DOM.$('input') as HTMLInputElement;
					chk.type = 'checkbox';
					chk.className = 'rowchk';
					chk.style.width = '16px';
					chk.style.height = '16px';
					chk.style.marginTop = '2px';
					chk.style.accentColor = '#a855f7';
					chk.addEventListener('change', () => {
						row.classList.toggle('selected', chk.checked);
						row.style.background = chk.checked ? '#a855f70d' : 'var(--vscode-editorWidget-background, #252526)';
						updateCounts();
					});
					row.appendChild(chk);
					const main = DOM.$('div');
					main.style.flex = '1';
					main.style.minWidth = '0';
					const titleLine = DOM.$('div');
					titleLine.style.fontSize = '13px';
					titleLine.style.fontWeight = '500';
					titleLine.style.lineHeight = '1.4';
					titleLine.style.display = 'flex';
					titleLine.style.gap = '8px';
					titleLine.style.alignItems = 'center';
					const typeTag = DOM.$('span', undefined, TYPE_LABEL[it.type || 'task'] || '任务');
					typeTag.style.fontSize = '11px';
					typeTag.style.padding = '1px 7px';
					typeTag.style.borderRadius = '10px';
					typeTag.style.background = it.type === 'bug' ? '#f4474720' : it.type === 'story' ? '#4ec9b020' : '#0e639c20';
					typeTag.style.color = it.type === 'bug' ? '#f44747' : it.type === 'story' ? '#4ec9b0' : '#6cb6e6';
					titleLine.appendChild(typeTag);
					titleLine.appendChild(DOM.$('span', undefined, it.title || '(无标题)'));
					main.appendChild(titleLine);
					const meta = DOM.$('div');
					meta.style.marginTop = '6px';
					meta.style.display = 'flex';
					meta.style.gap = '6px';
					meta.style.flexWrap = 'wrap';
					meta.style.fontSize = '11px';
					meta.style.color = 'var(--vscode-descriptionForeground)';
					const tag = (text: string, color?: string) => {
						const t = DOM.$('span', undefined, text);
						t.style.background = 'var(--vscode-chip-background, #3a3d41)';
						t.style.padding = '1px 7px';
						t.style.borderRadius = '10px';
						if (color) { t.style.color = color; t.style.background = color + '20'; }
						return t;
					};
					if (it.id) { meta.appendChild(tag(`#${it.id}`)); }
					if (it.priority) { meta.appendChild(tag(`📝 ${it.priority}`, '#cca700')); }
					if (it.status) { meta.appendChild(tag(`● ${it.status}`, '#6cb6e6')); }
					if (it.assigneeName) { meta.appendChild(tag(`👤 ${it.assigneeName}`)); }
					if (it.iteration) { meta.appendChild(tag(`🔁 ${it.iteration}`)); }
					main.appendChild(meta);
					row.appendChild(main);
					resultList.appendChild(row);
				});
			}
			resultCount.textContent = String(items.length);
			selectAll.checked = false;
			updateCounts();
		};

		queryBtn.addEventListener('click', () => void runQuery());
		resetBtn.addEventListener('click', () => {
			urlInput.value = '';
			titleInput.value = '';
			ownerInput.value = '';
			statusSelect.value = '';
			iterSelect.value = '';
			prioSelect.value = '';
			singleNote.style.display = 'none';
		});
		selectAll.addEventListener('change', () => {
			const chks = Array.from(resultList.querySelectorAll('input[type=checkbox].rowchk')) as HTMLInputElement[];
			chks.forEach(c => {
				c.checked = selectAll.checked;
				const row = c.closest('div') as HTMLElement;
				row.classList.toggle('selected', c.checked);
				row.style.background = c.checked ? '#a855f70d' : 'var(--vscode-editorWidget-background, #252526)';
			});
			updateCounts();
		});

		createBtn.addEventListener('click', async () => {
			const chks = Array.from(resultList.querySelectorAll('input[type=checkbox].rowchk')) as HTMLInputElement[];
			const chosen = items.filter((_, i) => chks[i]?.checked);
			if (!chosen.length || creating) { return; }
			creating = true;
			createBtn.textContent = '⏳ 创建中…';
			createBtn.toggleAttribute('disabled', true);
			createBtn.style.opacity = '0.5';
			try {
				await onCreate(chosen, currentWsId);
				overlay.remove();
			} catch (err) {
				console.error('[TaskBoardNativeRenderer] TAPD batch create failed:', err);
			} finally {
				creating = false;
			}
		});

		// Close on overlay click / Escape
		overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
		const escHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
		};
		document.addEventListener('keydown', escHandler);

		urlInput.focus();
	}

	/**
	 * Shown when the user clicks "📥 导入 TAPD" but no TAPD MCP server is
	 * connected locally. Explains the requirement and offers a one-click jump
	 * into the MCP marketplace (filtered to the TAPD MCP) via `onGotoStore`.
	 *
	 * @param reason 'no-server' = no TAPD MCP installed at all;
	 *               'not-running' = installed but failed to connect.
	 */
	showTapdMcpNotConnectedModal(
		parent: HTMLElement,
		opts: {
			reason: 'no-server' | 'not-running';
			onGotoStore: () => void;
		},
	): void {
		const overlay = DOM.$('div.native-tb-modal-overlay');
		const modal = DOM.$('div.native-tb-modal');
		modal.style.width = '440px';

		// Header
		const header = DOM.$('div.native-tb-modal-header');
		const title = DOM.$('span');
		title.textContent = '⚠ TAPD MCP 未连接';
		header.appendChild(title);
		const closeBtn = DOM.$('button.native-tb-modal-close', undefined, '✕');
		closeBtn.addEventListener('click', () => overlay.remove());
		header.appendChild(closeBtn);
		modal.appendChild(header);

		// Body
		const body = DOM.$('div.native-tb-modal-body');

		const desc = DOM.$('div');
		desc.textContent = opts.reason === 'no-server'
			? '本地未检测到 TAPD MCP 服务器。导入 TAPD 单子需要先安装并连接 TAPD MCP，才能读取需求 / 缺陷 / 任务数据。'
			: '本地 TAPD MCP 服务器已存在，但未能正常连接（启动失败或连接中断）。请确认其配置无误后，从商城重新安装或重连。';
		desc.style.fontSize = '13px';
		desc.style.lineHeight = '1.6';
		desc.style.color = 'var(--vscode-foreground)';
		body.appendChild(desc);

		const hint = DOM.$('div');
		hint.style.marginTop = '4px';
		hint.style.fontSize = '12px';
		hint.style.lineHeight = '1.6';
		hint.style.color = 'var(--vscode-descriptionForeground)';
		hint.style.background = 'var(--vscode-editorWidget-background, #2d2d30)';
		hint.style.border = '1px solid var(--vscode-widget-border, #3c3c3c)';
		hint.style.borderRadius = '6px';
		hint.style.padding = '10px 12px';
		hint.textContent = '💡 可前往 MCP 商城搜索 “tapd”，安装官方 TAPD MCP 服务器，安装后在集成视图中启动即可。';
		body.appendChild(hint);

		modal.appendChild(body);

		// Footer
		const footer = DOM.$('div.native-tb-modal-footer');
		const cancelBtn = DOM.$('button.native-tb-btn', undefined, '取消');
		cancelBtn.addEventListener('click', () => overlay.remove());
		const gotoBtn = DOM.$('button.native-tb-btn.native-tb-btn-primary', undefined, '🛒 前往 MCP 商城安装');
		gotoBtn.addEventListener('click', () => {
			overlay.remove();
			try {
				opts.onGotoStore();
			} catch (err) {
				console.error('[TaskBoardNativeRenderer] open MCP store failed:', err);
			}
		});
		footer.appendChild(cancelBtn);
		footer.appendChild(gotoBtn);
		modal.appendChild(footer);

		overlay.appendChild(modal);
		parent.appendChild(overlay);

		// Close on overlay click / Escape
		overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });
		const escHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
		};
		document.addEventListener('keydown', escHandler);
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
