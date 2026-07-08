/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Renderer-side bridge that runs the `web_scrape_to_board` logic outside of the
 * agent tool loop — e.g. when the user picks "创建看板任务" from an integrated
 * browser page's context menu.
 *
 * It assembles a {@link KanbanToolContext} from the same services the kanban
 * tools use and delegates to the shared {@link scrapeWebPageToBoard}, so the
 * context-menu path and the agent tool path never drift apart.
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IAgentStudioService, IAgentTaskBoardService, ITaskOrchestrationService } from '../../../../../common/agentStudioService.js';
import { ISwarmService } from '../../../common/swarmService.js';
import { ITriageService } from '../../../common/triageService.js';
import { IAgentOSService } from '../../../common/agentOS.js';
import { IPlaywrightService } from '../../../../../../platform/browserView/common/playwrightService.js';
import { IEditorService } from '../../../../../../workbench/services/editor/common/editorService.js';
import { ISessionsManagementService } from '../../../../../../sessions/services/sessions/common/sessionsManagement.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IKanbanRecipeService } from './kanbanRecipeService.js';
import { KanbanToolContext, scrapeWebPageToBoard, resolveScrapeSessionId } from './kanbanTools.js';
import { DEFAULT_BOARD_ID } from '../../../common/types.js';

export interface IKanbanScrapeService {
	readonly _serviceBrand: undefined;

	/**
	 * Parse the browser page identified by `pageId` (== BrowserEditorInput.id /
	 * the Playwright view id) and create a kanban board with the extracted tasks.
	 * @param pageId The browser view id.
	 * @param pageUrl The page URL (used for recipe auto-matching; may be undefined).
	 * @param options Optional overrides for board name, task cap, recipe, etc.
	 * @returns The same text-result shape as the `web_scrape_to_board` tool.
	 */
	scrapeToBoard(
		pageId: string,
		pageUrl?: string,
		options?: { boardName?: string; maxTasks?: number; recipe?: string; autoMatch?: boolean; boardId?: string },
	): Promise<{ type: 'text'; text: string }[]>;

	/**
	 * Open `url` in a background Playwright page, scrape its task data, and
	 * append the extracted tasks to the workspace's default board (待办 column).
	 * Used by the board-link "创建任务" right-click action, where the page is
	 * rendered inside a sandboxed cross-origin webview and cannot be read directly.
	 * @param url The board hyperlink URL to scrape.
	 * @param options Optional overrides for task cap, recipe, auto-match.
	 * @returns The same text-result shape as the `web_scrape_to_board` tool.
	 */
	scrapeUrlToTasks(
		url: string,
		options?: { maxTasks?: number; recipe?: string; autoMatch?: boolean },
	): Promise<{ type: 'text'; text: string }[]>;
}

export const IKanbanScrapeService = createDecorator<IKanbanScrapeService>('IKanbanScrapeService');

export class KanbanScrapeService extends Disposable implements IKanbanScrapeService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IAgentStudioService private readonly studioService: IAgentStudioService,
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
		@ITaskOrchestrationService private readonly orchestrationService: ITaskOrchestrationService,
		@ISwarmService private readonly swarmService: ISwarmService,
		@ITriageService private readonly triageService: ITriageService,
		@IAgentOSService private readonly agentOS: IAgentOSService,
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
		@IEditorService private readonly editorService: IEditorService,
		@ISessionsManagementService private readonly sessionsManagement: ISessionsManagementService,
		@IKanbanRecipeService private readonly recipeService: IKanbanRecipeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/** Build the tool context the shared scrape function expects. */
	private _toolContext(): KanbanToolContext {
		return {
			register: () => { /* no-op: this path does not register tools */ },
			studioService: this.studioService,
			taskBoardService: this.taskBoardService,
			orchestrationService: this.orchestrationService,
			swarmService: this.swarmService,
			triageService: this.triageService,
			logService: this.logService,
			playwrightService: this.playwrightService,
			editorService: this.editorService,
			sessionsManagement: this.sessionsManagement,
			agentOS: this.agentOS,
			recipeService: this.recipeService,
		};
	}

	async scrapeToBoard(
		pageId: string,
		pageUrl?: string,
		options?: { boardName?: string; maxTasks?: number; recipe?: string; autoMatch?: boolean; boardId?: string },
	): Promise<{ type: 'text'; text: string }[]> {
		// When no board is specified (the common case for the "创建看板任务"
		// context-menu action), append the scraped tasks to the workspace's
		// default board's 待办 column instead of spawning a brand-new board.
		const boardId = options?.boardId ?? (await this._resolveDefaultBoardId());
		return scrapeWebPageToBoard(this._toolContext(), {
			pageId,
			pageUrl,
			boardName: options?.boardName,
			maxTasks: options?.maxTasks,
			recipe: options?.recipe,
			autoMatch: options?.autoMatch,
			boardId,
		});
	}

	/** Resolve the workspace's default board id (falls back to undefined → new board). */
	private async _resolveDefaultBoardId(): Promise<string | undefined> {
		let workspaceId: string | undefined;
		try {
			workspaceId = this.studioService.getActiveWorkspaceId();
		} catch {
			workspaceId = undefined;
		}
		if (!workspaceId) {
			return undefined;
		}
		try {
			const boards = await this.taskBoardService.listBoards(workspaceId);
			return boards.find(b => b.id === DEFAULT_BOARD_ID)?.id;
		} catch {
			return undefined;
		}
	}

	async scrapeUrlToTasks(
		url: string,
		options?: { maxTasks?: number; recipe?: string; autoMatch?: boolean },
	): Promise<{ type: 'text'; text: string }[]> {
		const ctx = this._toolContext();

		// Resolve the workspace the tasks are appended to.
		let workspaceId: string | undefined;
		try {
			workspaceId = this.studioService.getActiveWorkspaceId();
		} catch {
			workspaceId = undefined;
		}
		if (!workspaceId) {
			return [{ type: 'text', text: '创建任务失败：没有激活的工作区，请先打开一个工作区。' }];
		}

		// Resolve the playwright sessionId (defaults to Saros Claw when no
		// active session is focused).
		const sessionId = resolveScrapeSessionId(this._toolContext());
		if (!sessionId) {
			return [{ type: 'text', text: '创建任务失败：没有活跃的 agent 会话。' }];
		}

		// Open the URL in a background Playwright page (cross-origin webview
		// content can't be read from the board-link pane directly) and read it.
		let pageId: string;
		try {
			const opened = await this.playwrightService.openPage(sessionId, url);
			pageId = opened.pageId;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return [{ type: 'text', text: `创建任务失败：无法打开页面 (${msg})。` }];
		}

		// Target the workspace's default board.
		let boardId = DEFAULT_BOARD_ID;
		try {
			const boards = await this.taskBoardService.listBoards(workspaceId);
			const def = boards.find(b => b.id === DEFAULT_BOARD_ID);
			if (def) { boardId = def.id; }
		} catch {
			// Keep DEFAULT_BOARD_ID when the lookup fails.
		}

		return scrapeWebPageToBoard(ctx, {
			pageId,
			pageUrl: url,
			boardId,
			maxTasks: options?.maxTasks,
			recipe: options?.recipe,
			autoMatch: options?.autoMatch ?? true,
		});
	}
}
