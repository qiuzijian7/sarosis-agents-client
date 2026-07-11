/*---------------------------------------------------------------------------------------------
 *  Kanban Example Plugin
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../src/vs/base/common/lifecycle.js';
import { Emitter } from '../../../src/vs/base/common/event.js';
import { IAgentCapabilityPlugin, IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { IKanbanProvider, IKanbanBoard, IKanbanCard, KanbanPriority } from '../../../src/vs/sessions/contrib/agentStudio/common/providers.js';

export class KanbanExampleProvider implements IKanbanProvider {
	readonly id = 'kanban-example';
	readonly name = 'Kanban Example';

	private readonly _onDidChangeCards = new Emitter<any>();
	readonly onDidChangeCards = this._onDidChangeCards.event;

	private readonly _onDidChangeBoard = new Emitter<any>();
	readonly onDidChangeBoard = this._onDidChangeBoard.event;

	private readonly _boards: IKanbanBoard[] = [{
		id: 'board-1',
		name: 'Default Board',
		columns: [
			{ id: 'col-1', name: 'To Do', order: 0 },
			{ id: 'col-2', name: 'In Progress', order: 1 },
			{ id: 'col-3', name: 'Done', order: 2 }
		]
	}];

	private readonly _cards: IKanbanCard[] = [];

	async listBoards(): Promise<IKanbanBoard[]> {
		return this._boards;
	}

	async getBoard(boardId: string): Promise<IKanbanBoard> {
		const board = this._boards.find(b => b.id === boardId);
		if (!board) throw new Error(`Board not found: ${boardId}`);
		return board;
	}

	async createCard(boardId: string, card: any): Promise<IKanbanCard> {
		const newCard: IKanbanCard = {
			id: `card-${Date.now()}`,
			title: card.title || 'Untitled',
			description: card.description,
			columnId: card.columnId || 'col-1',
			priority: card.priority || KanbanPriority.Medium,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		this._cards.push(newCard);
		this._onDidChangeCards.fire({ type: 'created', card: newCard });
		return newCard;
	}

	async updateCard(cardId: string, updates: any): Promise<IKanbanCard> {
		const card = this._cards.find(c => c.id === cardId);
		if (!card) throw new Error(`Card not found: ${cardId}`);
		Object.assign(card, updates, { updatedAt: new Date().toISOString() });
		this._onDidChangeCards.fire({ type: 'updated', card });
		return card;
	}

	async moveCard(cardId: string, targetColumn: string, position?: number): Promise<void> {
		const card = this._cards.find(c => c.id === cardId);
		if (card) {
			const oldColumn = card.columnId;
			card.columnId = targetColumn;
			card.updatedAt = new Date().toISOString();
			this._onDidChangeCards.fire({ type: 'moved', card, previousColumnId: oldColumn });
		}
	}

	async deleteCard(cardId: string): Promise<void> {
		const idx = this._cards.findIndex(c => c.id === cardId);
		if (idx >= 0) {
			const card = this._cards[idx];
			this._cards.splice(idx, 1);
			this._onDidChangeCards.fire({ type: 'deleted', card });
		}
	}

	async listCards(boardId: string, filter?: any): Promise<IKanbanCard[]> {
		return this._cards;
	}

	async getCard(cardId: string): Promise<IKanbanCard> {
		const card = this._cards.find(c => c.id === cardId);
		if (!card) throw new Error(`Card not found: ${cardId}`);
		return card;
	}
}

export class KanbanExamplePlugin extends Disposable implements IAgentCapabilityPlugin {
	private readonly _provider: KanbanExampleProvider;
	private _agentOS: IAgentOSPluginContext['agentOSService'] | undefined;

	constructor() {
		super();
		this._provider = new KanbanExampleProvider();
	}

	async activate(context: IAgentOSPluginContext): Promise<void> {
		console.log('[KanbanExample] Activating...');
		// NOTE: do NOT inject IAgentOSService via constructor DI. This plugin is
		// loaded as a separate module realm from the host bundle, so its
		// `IAgentOSService` service-identifier object differs from the one the
		// host registered via registerSingleton — causing createInstance() to
		// fail with "UNKNOWN service agentOSService". The host passes the live
		// service instance through IAgentOSPluginContext.agentOSService instead.
		this._agentOS = context.agentOSService;
		this._agentOS.registerKanbanProvider(this._provider, 50);
	}

	async deactivate(): Promise<void> {
		console.log('[KanbanExample] Deactivating...');
	}
}

export function activate(pluginContext: IAgentOSPluginContext): IAgentCapabilityPlugin {
	const plugin = new KanbanExamplePlugin();
	void plugin.activate(pluginContext);
	return plugin;
}
