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
			// Pass a Playwright-based downloadFn so attachments are downloaded internally
			// with auth cookies — eliminates the old dual download path (P2-4 fix).
			const result = await tapd.importFromBrowser(SAROS_CLAW_AGENT_ID, viewId, rawUrl, {
				downloadAttachments: true,
				downloadFn: async (url: string) => {
					const dl = await this.taskBoardService.downloadUrlForAttachment(url, {
						sessionId: SAROS_CLAW_AGENT_ID,
						viewId,
						subDir: 'tapd-inline',
					});
					return dl?.tempPath;
				},
			});
				this.logService.info(`[BrowserKanban] TAPD import result: id=${result.id ?? '?'} type=${result.type ?? '?'} title="${result.title}" attachments=${(result.attachments || []).length} error=${result.error ?? 'none'}`);
				this.logService.info(`[BrowserKanban] attachment list: ${JSON.stringify((result.attachments || []).map(a => ({ name: a.name, hasUrl: !!a.downloadUrl, url: a.downloadUrl, mime: a.mimeType })))}`);
				if (result.error) {
					throw new Error(result.error);
				}

			let description = result.description || '';
			this.logService.info(`[BrowserKanban] TAPD description (raw, first 800 chars): ${description.slice(0, 800)}`);

			const atts = (result.attachments || []).filter(a => !!a.downloadUrl);
			this.logService.info(`[BrowserKanban] attachments with downloadUrl (to fetch locally): ${atts.length}`);
			/** Downloaded attachment data collected for later `addAttachment` calls. */
			const attachmentData: { name: string; mimeType: string; base64: string }[] = [];
			if (atts.length) {
				progress.report({ message: `正在下载 ${atts.length} 个附件到本地…` });
				const lines: string[] = [];
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
					// subDir namespaces attachments per TAPD task; filename uses the
					// real TAPD attachment name (e.g. 20260706T103214.zip) instead of
					// the opaque URL-derived name (e.g. "story").
					const dl = await this.taskBoardService.downloadUrlForAttachment(url, {
						sessionId: SAROS_CLAW_AGENT_ID,
						viewId,
						filename: att.name,
						subDir: result.id,
					});
					this.logService.info(`[BrowserKanban] download result: ${att.name} → ${dl?.tempPath ?? 'FAILED (undefined)'}`);
					if (dl) {
						// Use relative path (.sarosworkspace/tmp/task-downloads/<taskId>/...) so the
						// task detail UI can resolve + render thumbnails / clickable links.
						const relPath = `.sarosworkspace/tmp/task-downloads/${result.id}/${dl.name}`;
						const isImage = dl.mimeType.startsWith('image/');
						// For images, embed as data URI to bypass CSP blocking of
						// file:// protocol in the renderer webview context.
						// Non-image attachments still use the local file path (opened
						// via shell/VS Code APIs that are not subject to img-src CSP).
						const inlineSrc = isImage && dl.base64
							? `data:${dl.mimeType};base64,${dl.base64}`
							: relPath;

						// TAPD description images keep their original CDN URL
						// (e.g. https://file.tapd.cn/compress/...?src=...) because
						// the import runs with downloadAttachments:false. The
						// `att.downloadUrl` returned by tapdImportService is the
						// raw <img src> from the page, but after the playwright
						// download round-trip the URL may be normalized/redirected
						// so a plain `description.includes(url)` check misses.
						//
						// Strategy: rewrite any markdown image/link reference whose
						// URL **contains** the download URL (or vice-versa) to the
						// local path. Also handle the common case where TAPD wraps
						// the real image in a `?src=...` query — strip the query
						// string and match on the base path.
						let replacedInline = false;
						const tryReplace = (needle: string) => {
							if (needle && description.includes(needle)) {
								const before = description.length;
								description = description.split(needle).join(inlineSrc);
								replacedInline = true;
								this.logService.info(`[BrowserKanban] inline REPLACED with needle "${needle.length > 80 ? needle.slice(0, 80) + '…' : needle}" → ${isImage ? 'data:image/…;base64,…' : relPath} (len ${before} → ${description.length})`);
							} else {
								this.logService.info(`[BrowserKanban] inline miss for needle "${needle.length > 80 ? needle.slice(0, 80) + '…' : needle}"`);
							}
						};
						tryReplace(url);
						if (!replacedInline) {
							// Match the URL without query string
							const base = url.split('?')[0];
							if (base !== url) { tryReplace(base); }
						}
						if (!replacedInline) {
							// Also try the URL-decoded form (TAPD often embeds
							// `?src=/tfl/captures/.../tapd_xxx.png` whose slashes
							// get URL-encoded in the description).
							try { tryReplace(decodeURIComponent(url)); } catch { /* not decodable */ }
						}
						if (!replacedInline && isImage) {
							// Last-resort: match by the TAPD base64 file id
							// pattern `tapd_<digits>_base64_<digits>_<digits>.<ext>`
							// embedded in the description's `![...](...)` URLs.
							const idMatch = url.match(/(tapd_\d+_base64_\d+_\d+\.\w+)/);
							if (idMatch) { tryReplace(idMatch[1]); }
						}

						// File attachments (not already shown inline) get a
						// dedicated entry in an "附件" section. Inline description
						// images are skipped here to avoid duplicating what's
						// already rendered above.
						if (!replacedInline) {
							if (lines.length === 0) {
								lines.push('', '### 📎 附件（已下载到本地）', '');
							}
							// Compressed files: list the auto-extracted entries
							// (images embedded as data URIs, others as file links).
							if (dl.isZip && dl.extractedFiles && dl.extractedFiles.length) {
								for (const f of dl.extractedFiles) {
									lines.push(f.isImage && f.dataUri
										? `![${f.name}](${f.dataUri})`
										: `[${f.name}](${f.relPath})`);
								}
							} else {
								lines.push(isImage ? `![${att.name}](${inlineSrc})` : `[${att.name}](${relPath})`);
							}
						}

						// Always attach the binary so it appears in the card's
						// attachment list regardless of where it's rendered.
						attachmentData.push({ name: dl.name, mimeType: dl.mimeType, base64: dl.base64 });
					}
				}
				if (lines.length > 0) {
					description += '\n' + lines.join('\n');
				}
			}
			this.logService.info(`[BrowserKanban] TAPD description FINAL (first 800 chars): ${description.slice(0, 800)}`);

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
