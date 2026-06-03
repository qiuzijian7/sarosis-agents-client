/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IAgentTaskBoardService } from '../../../common/agentStudio.js';
import type { TaskBoardRecord } from '../../../common/types.js';
import { TaskBoardStatus, TaskSource } from '../../../common/types.js';
import {
	IKanbanProvider,
	IKanbanBoard,
	IKanbanColumn,
	IKanbanCard,
	IKanbanCardCreate,
	IKanbanCardUpdate,
	IKanbanFilter,
	IKanbanCardChangeEvent,
	IKanbanBoardChangeEvent,
	KanbanPriority,
} from '../../../common/providers.js';

/** The single default board id surfaced by this provider. */
const DEFAULT_BOARD_ID = 'default';

/**
 * Column definition of the default board. The column id IS the underlying
 * TaskBoardStatus value, so columnId ↔ status mapping is identity.
 */
const BOARD_COLUMNS: IKanbanColumn[] = [
	{ id: TaskBoardStatus.Triage, name: '待规划', order: 0 },
	{ id: TaskBoardStatus.Todo, name: '待执行', order: 1 },
	{ id: TaskBoardStatus.Ready, name: '就绪', order: 2 },
	{ id: TaskBoardStatus.Running, name: '执行中', order: 3 },
	{ id: TaskBoardStatus.Blocked, name: '阻塞中', order: 4 },
	{ id: TaskBoardStatus.Done, name: '已完成', order: 5 },
	{ id: TaskBoardStatus.Cancelled, name: '已取消', order: 6 },
	{ id: TaskBoardStatus.Archived, name: '已归档', order: 7 },
];

const VALID_STATUSES = new Set<string>(BOARD_COLUMNS.map(c => c.id));

/**
 * JSON-file backed Kanban provider.
 *
 * Activates the IKanbanProvider abstraction (previously never registered, so
 * getActiveKanbanProvider() always returned undefined) by delegating all
 * persistence to the existing, battle-tested AgentTaskBoardService. Both share
 * the same taskboard.json — this provider is a thin adapter:
 *   - columnId  ↔ TaskBoardStatus  (identity mapping; column id is the status value)
 *   - IKanbanCard ↔ TaskBoardRecord (field projection)
 *
 * The existing direct-access code path (TaskBoard UI, kanban tools) is left
 * completely untouched; this layer is purely additive for abstraction consumers.
 */
export class JsonFileKanbanProvider extends Disposable implements IKanbanProvider {

	readonly id = 'json-file-kanban';
	readonly name = 'Task Board (JSON)';

	private readonly _onDidChangeCards = this._register(new Emitter<IKanbanCardChangeEvent>());
	readonly onDidChangeCards: Event<IKanbanCardChangeEvent> = this._onDidChangeCards.event;

	private readonly _onDidChangeBoard = this._register(new Emitter<IKanbanBoardChangeEvent>());
	readonly onDidChangeBoard: Event<IKanbanBoardChangeEvent> = this._onDidChangeBoard.event;

	constructor(
		private readonly taskBoardService: IAgentTaskBoardService,
		private readonly logService: ILogService,
	) {
		super();
		// Forward underlying task-board changes as a generic "updated" card event.
		// Consumers that need fine-grained diffs should re-query via listCards.
		this._register(this.taskBoardService.onDidChangeTaskBoard(() => {
			this._onDidChangeCards.fire({ type: 'updated', card: this._emptyCardSignal() });
		}));
	}

	// ─── Board management ─────────────────────────────────────────────

	async listBoards(): Promise<IKanbanBoard[]> {
		return [this._defaultBoard()];
	}

	async getBoard(boardId: string): Promise<IKanbanBoard> {
		if (boardId !== DEFAULT_BOARD_ID) {
			throw new Error(`JsonFileKanbanProvider: unknown board "${boardId}" (only "${DEFAULT_BOARD_ID}" is supported)`);
		}
		return this._defaultBoard();
	}

	// ─── Card CRUD ────────────────────────────────────────────────────

	async createCard(boardId: string, card: IKanbanCardCreate): Promise<IKanbanCard> {
		if (boardId !== DEFAULT_BOARD_ID) {
			throw new Error(`JsonFileKanbanProvider: unknown board "${boardId}"`);
		}
		const status = this._toStatus(card.columnId);
		const record = await this.taskBoardService.createTask({
			title: card.title,
			description: card.description,
			status,
			source: TaskSource.Manual,
			assigneeName: card.assignee,
			priority: this._toRecordPriority(card.priority),
			workspaceId: (card.metadata?.['workspaceId'] as string | undefined) ?? '',
		});
		const result = this._toCard(record);
		this._onDidChangeCards.fire({ type: 'created', card: result });
		return result;
	}

	async updateCard(cardId: string, updates: Partial<IKanbanCardUpdate>): Promise<IKanbanCard> {
		const patch: Partial<TaskBoardRecord> = {};
		if (updates.title !== undefined) { patch.title = updates.title; }
		if (updates.description !== undefined) { patch.description = updates.description; }
		if (updates.assignee !== undefined) { patch.assigneeName = updates.assignee; }
		if (updates.priority !== undefined) { patch.priority = this._toRecordPriority(updates.priority); }

		const record = await this.taskBoardService.updateTask(cardId, patch);
		const result = this._toCard(record);
		this._onDidChangeCards.fire({ type: 'updated', card: result });
		return result;
	}

	async moveCard(cardId: string, targetColumn: string, _position?: number): Promise<void> {
		const status = this._toStatus(targetColumn);
		const existing = await this.taskBoardService.getTask(cardId);
		const previousColumnId = existing?.status;
		const record = await this.taskBoardService.updateTaskStatus(cardId, status);
		this._onDidChangeCards.fire({ type: 'moved', card: this._toCard(record), previousColumnId });
	}

	async deleteCard(cardId: string): Promise<void> {
		const existing = await this.taskBoardService.getTask(cardId);
		await this.taskBoardService.deleteTask(cardId);
		if (existing) {
			this._onDidChangeCards.fire({ type: 'deleted', card: this._toCard(existing) });
		}
	}

	// ─── Queries ──────────────────────────────────────────────────────

	async listCards(boardId: string, filter?: IKanbanFilter): Promise<IKanbanCard[]> {
		if (boardId !== DEFAULT_BOARD_ID) {
			throw new Error(`JsonFileKanbanProvider: unknown board "${boardId}"`);
		}
		const tasks = await this.taskBoardService.getTasks();
		let cards = tasks.map(t => this._toCard(t));
		if (filter) {
			if (filter.columnId) {
				cards = cards.filter(c => c.columnId === filter.columnId);
			}
			if (filter.assignee) {
				cards = cards.filter(c => c.assignee === filter.assignee);
			}
			if (filter.priority) {
				cards = cards.filter(c => c.priority === filter.priority);
			}
		}
		return cards;
	}

	async getCard(cardId: string): Promise<IKanbanCard> {
		const record = await this.taskBoardService.getTask(cardId);
		if (!record) {
			throw new Error(`JsonFileKanbanProvider: card not found "${cardId}"`);
		}
		return this._toCard(record);
	}

	// ─── Mapping helpers ──────────────────────────────────────────────

	private _defaultBoard(): IKanbanBoard {
		return { id: DEFAULT_BOARD_ID, name: 'Task Board', columns: BOARD_COLUMNS };
	}

	/** Map a column id to a TaskBoardStatus, validating membership. */
	private _toStatus(columnId: string): TaskBoardStatus {
		if (!VALID_STATUSES.has(columnId)) {
			this.logService.warn(`[JsonFileKanbanProvider] unknown columnId "${columnId}", defaulting to triage`);
			return TaskBoardStatus.Triage;
		}
		return columnId as TaskBoardStatus;
	}

	/** Project a TaskBoardRecord into the read-only IKanbanCard shape. */
	private _toCard(record: TaskBoardRecord): IKanbanCard {
		return {
			id: record.id,
			title: record.title,
			description: record.description,
			columnId: record.status,
			assignee: record.assigneeName,
			priority: this._toKanbanPriority(record.priority),
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			metadata: {
				source: record.source,
				sourceId: record.sourceId,
				assigneeId: record.assigneeId,
				workspaceId: record.workspaceId,
				dependencies: record.dependencies,
				completedAt: record.completedAt,
			},
		};
	}

	/** KanbanPriority (critical/high/medium/low) → record priority (low/medium/high). */
	private _toRecordPriority(priority: KanbanPriority | undefined): 'low' | 'medium' | 'high' | undefined {
		switch (priority) {
			case KanbanPriority.Critical:
			case KanbanPriority.High:
				return 'high';
			case KanbanPriority.Medium:
				return 'medium';
			case KanbanPriority.Low:
				return 'low';
			default:
				return undefined;
		}
	}

	/** record priority (low/medium/high) → KanbanPriority. */
	private _toKanbanPriority(priority: 'low' | 'medium' | 'high' | undefined): KanbanPriority | undefined {
		switch (priority) {
			case 'high': return KanbanPriority.High;
			case 'medium': return KanbanPriority.Medium;
			case 'low': return KanbanPriority.Low;
			default: return undefined;
		}
	}

	/**
	 * A synthetic placeholder card used only for the coarse-grained
	 * onDidChangeTaskBoard → onDidChangeCards forwarding. Consumers should
	 * re-query listCards rather than rely on this card's contents.
	 */
	private _emptyCardSignal(): IKanbanCard {
		const now = new Date().toISOString();
		return {
			id: '*',
			title: '',
			columnId: TaskBoardStatus.Triage,
			createdAt: now,
			updatedAt: now,
			metadata: { synthetic: true },
		};
	}
}
