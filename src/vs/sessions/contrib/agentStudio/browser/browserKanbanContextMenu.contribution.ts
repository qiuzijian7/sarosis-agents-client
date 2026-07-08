/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wires the integrated browser's "创建看板任务" (Create Kanban Tasks) context-menu
 * action to the kanban pipeline. When the user right-clicks a browser page and
 * picks that item, the main process fires `onDidRequestCreateKanban` (carrying
 * the view id + page URL); this contribution reacts in the renderer:
 *
 *   - TAPD workitem page  → dedicated import path that downloads the workitem's
 *     description images + file attachments to local disk (with a progress modal)
 *     and writes the local file paths into the new task card's description.
 *   - any other page      → falls back to the generic web-scrape path.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IKanbanScrapeService } from './providers/tool/kanbanScrapeService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IAgentTaskBoardService } from '../../../common/agentStudioService.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { TaskBoardStatus, TaskSource } from '../common/types.js';
import { TapdImportService } from './tapdImportService.js';
import { SAROS_CLAW_AGENT_ID } from './providers/tool/kanbanTools.js';

type CardPriority = 'low' | 'medium' | 'high';

class BrowserKanbanContextMenuContribution extends Disposable {
	static readonly ID = 'browserKanbanContextMenu';

	constructor(
		@IBrowserViewWorkbenchService browserViewService: IBrowserViewWorkbenchService,
		@IKanbanScrapeService private readonly scrapeService: IKanbanScrapeService,
		@IProgressService private readonly progressService: IProgressService,
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
		@IFileService private readonly fileService: IFileService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(browserViewService.onDidRequestCreateKanban(async (e) => {
			const url = e.url || '';

			// TAPD workitem (story / bug / task) → extract directly from the
			// browser page DOM via Playwright (no MCP / no API dependency).
			if (TapdImportService.parseTapdUrl(url)) {
				this.logService.info(`[BrowserKanban] TAPD workitem URL detected → extracting via Playwright DOM: ${url}`);
				await this._createFromTapd(url, e.viewId);
				return;
			}

			// Fallback: generic web page scrape (boards / other sites).
			logService.info(`[BrowserKanban] Create Kanban Tasks requested for view ${e.viewId} (${e.url ?? 'no url'})`);
			try {
				const result = await this.scrapeService.scrapeToBoard(e.viewId, e.url);
				const text = result.map(r => r.text).join('\n').trim() || '未从该页面提取到任务。';
				notificationService.info(text);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logService.error('[BrowserKanban] failed to create tasks from page:', err);
				notificationService.error(`创建看板任务失败：${msg}`);
			}
		}));
	}

	/**
	 * Full TAPD import flow for the right-click "创建看板任务" action:
	 *   1. read the workitem detail (title / description / priority / owner)
	 *   2. download every description image + file attachment to a local temp dir
	 *      (a modal progress dialog reports each download)
	 *   3. append the local file paths to the card description
	 *   4. create the task card on the default board's 待办 column
	 */
	private async _createFromTapd(rawUrl: string, viewId: string): Promise<void> {
		const tapd = new TapdImportService(this.logService, this.playwrightService, this.fileService, this.environmentService);
		try {
			const task = await this.progressService.withProgress({
				location: ProgressLocation.Dialog,
				title: '从 TAPD 创建看板任务',
				cancellable: false,
			}, async (progress) => {
				progress.report({ message: '正在读取 TAPD 单子详情…' });

				// Extract TAPD workitem data directly from the browser page DOM via Playwright.
				const result = await tapd.importFromBrowser(SAROS_CLAW_AGENT_ID, viewId, rawUrl, { downloadAttachments: false });
				this.logService.info(`[BrowserKanban] TAPD import result: id=${result.id ?? '?'} type=${result.type ?? '?'} title="${result.title}" attachments=${(result.attachments || []).length} error=${result.error ?? 'none'}`);
				this.logService.info(`[BrowserKanban] attachment list: ${JSON.stringify((result.attachments || []).map(a => ({ name: a.name, hasUrl: !!a.downloadUrl, url: a.downloadUrl, mime: a.mimeType })))}`);
				if (result.error) {
					throw new Error(result.error);
				}

			let description = result.description || '';

			const atts = (result.attachments || []).filter(a => !!a.downloadUrl);
			this.logService.info(`[BrowserKanban] attachments with downloadUrl (to fetch locally): ${atts.length}`);
			/** Downloaded attachment data collected for later `addAttachment` calls. */
			const attachmentData: { name: string; mimeType: string; base64: string }[] = [];
			if (atts.length) {
				progress.report({ message: `正在下载 ${atts.length} 个附件到本地…` });
				const lines: string[] = ['', '### 📎 附件（已下载到本地）', ''];
				const seenUrls = new Set<string>();
				const total = atts.length;
				let downloaded = 0;
				for (let i = 0; i < total; i++) {
					const att = atts[i];
					const url = att.downloadUrl!;
					// TAPD may return the same attachment URL twice in the
					// parsed list. The download endpoint is one-shot (second
					// request returns an HTML login page), so skip it.
					if (seenUrls.has(url)) {
						this.logService.info(`[BrowserKanban] skipping att ${i + 1}/${total}: duplicate url ${url}`);
						continue;
					}
					seenUrls.add(url);
					downloaded++;
					progress.report({
						message: `下载附件 (${downloaded}/${total})：${att.name}`,
						increment: Math.floor(100 / total),
					});
					this.logService.info(`[BrowserKanban] downloading att ${i + 1}/${total}: name=${att.name} url=${att.downloadUrl}`);
					const dl = await this.taskBoardService.downloadUrlForAttachment(url, { sessionId: SAROS_CLAW_AGENT_ID, viewId });
					this.logService.info(`[BrowserKanban] download result: ${att.name} → ${dl?.tempPath ?? 'FAILED (undefined)'}`);
					if (dl) {
						// Use relative path (.sarosworkspace/tmp/task-downloads/...) and
						// markdown image/link syntax so the task detail UI can render
						// thumbnails or clickable links.
						const relPath = `.sarosworkspace/tmp/task-downloads/${dl.name}`;
						const isImage = dl.mimeType.startsWith('image/');
						lines.push(isImage ? `![${att.name}](${relPath})` : `[${att.name}](${relPath})`);
						attachmentData.push({ name: dl.name, mimeType: dl.mimeType, base64: dl.base64 });
					}
				}
				description += lines.join('\n');
			}

			progress.report({ message: '正在创建任务卡片…' });
			const priority = (['low', 'medium', 'high'].includes(result.priority ?? '')
				? result.priority
				: 'medium') as CardPriority;

			const created = await this.taskBoardService.createTask({
				title: result.title,
				description,
				source: TaskSource.Tapd,
				tapdUrl: rawUrl,
				sourceId: result.id,
				priority,
				assigneeName: result.assigneeName,
				status: TaskBoardStatus.Todo,
			});

			// Attach downloaded files as proper card attachments so they
			// appear in the kanban card UI (not just as text paths).
			if (attachmentData.length > 0) {
				progress.report({ message: `正在添加 ${attachmentData.length} 个附件到卡片…` });
				for (const att of attachmentData) {
					try {
						await this.taskBoardService.addAttachment(created.id, att.name, att.mimeType, att.base64);
						this.logService.info(`[BrowserKanban] attached ${att.name} (${att.mimeType}) to task ${created.id}`);
					} catch (err) {
						this.logService.warn(`[BrowserKanban] failed to attach ${att.name}:`, err);
					}
				}
			}

			return created;
			});

			this.notificationService.info(`已创建 TAPD 看板任务：${task.title}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.error('[BrowserKanban] TAPD create failed:', err);
			this.notificationService.error(`创建 TAPD 看板任务失败：${msg}`);
		}
	}
}

registerWorkbenchContribution2(
	BrowserKanbanContextMenuContribution.ID,
	BrowserKanbanContextMenuContribution,
	WorkbenchPhase.AfterRestored,
);
