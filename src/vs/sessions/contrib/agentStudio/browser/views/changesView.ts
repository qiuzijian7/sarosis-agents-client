/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { $ } from '../../../../../base/browser/dom.js';
import { IGitCommitService, IGitRemote, IGitStatus } from '../gitCommitService.js';

/**
 * Changes View - 变更管理面板
 * 功能：
 * - 查看 Git 仓库状态
 * - 一键提交（git add -A + git commit）
 * - 自动推送到所有 remote（主仓库 + mirror 仓库）
 */
export class ChangesViewPane extends ViewPane {

	private _container!: HTMLElement;
	private _statusContainer!: HTMLElement;
	private _remotesContainer!: HTMLElement;
	private _logContainer!: HTMLElement;
	private _commitBtn!: HTMLButtonElement;
	private _commitMsgInput!: HTMLInputElement;

	private _isOperating = false;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
		@IGitCommitService private readonly _gitCommitService: IGitCommitService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('changes-view');
		this._container = container;

		// --- Header section ---
		const header = $('div.changes-header');
		const title = $('h3.changes-title');
		title.textContent = '📝 Source Control';
		header.appendChild(title);
		container.appendChild(header);

		// --- Commit message input ---
		const commitSection = $('div.changes-commit-section');

		this._commitMsgInput = document.createElement('input');
		this._commitMsgInput.type = 'text';
		this._commitMsgInput.placeholder = 'Commit message (leave empty for auto)';
		this._commitMsgInput.className = 'changes-commit-input';
		this._commitMsgInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !this._isOperating) {
				this._commitAndPushAll();
			}
		});
		commitSection.appendChild(this._commitMsgInput);

		// --- Action buttons ---
		const actions = $('div.changes-actions');

		this._commitBtn = document.createElement('button');
		this._commitBtn.className = 'changes-action-btn primary';
		this._commitBtn.textContent = '✓ Commit & Push All';
		this._commitBtn.title = 'Commit all changes and push to all remotes (main + mirror)';
		this._commitBtn.onclick = () => this._commitAndPushAll();
		actions.appendChild(this._commitBtn);

		const refreshBtn = document.createElement('button');
		refreshBtn.className = 'changes-action-btn';
		refreshBtn.textContent = '↻ Refresh';
		refreshBtn.onclick = () => this._refreshStatus();
		actions.appendChild(refreshBtn);

		commitSection.appendChild(actions);
		container.appendChild(commitSection);

		// --- Status section ---
		this._statusContainer = $('div.changes-status');
		container.appendChild(this._statusContainer);

		// --- Remotes section ---
		this._remotesContainer = $('div.changes-remotes');
		container.appendChild(this._remotesContainer);

		// --- Operation log ---
		this._logContainer = $('div.changes-log');
		container.appendChild(this._logContainer);

		// Initial load
		this._initWorkingDirectory();
		this._refreshStatus();
	}

	private _initWorkingDirectory(): void {
		// Try to determine the working directory from the workspace
		// In the sessions workbench, this is typically the opened folder
		const folders = this.configurationService.getValue<string>('agentStudio.dataPath');

		// Use a heuristic: check common locations
		// The actual cwd should come from the workspace context
		// For now, we use the first workspace folder or a configured path
		let cwd = '';

		if (folders) {
			cwd = folders;
		} else if (typeof process !== 'undefined' && process.cwd) {
			cwd = process.cwd();
		}

		if (cwd) {
			this._gitCommitService.setWorkingDirectory(cwd);
		}
	}

	private async _refreshStatus(): Promise<void> {
		try {
			const [status, remotes] = await Promise.all([
				this._gitCommitService.getStatus(),
				this._gitCommitService.getRemotes(),
			]);

			this._renderStatus(status);
			this._renderRemotes(remotes);
		} catch (err) {
			this._logService.error('[ChangesView] Failed to refresh status:', err);
			this._statusContainer.innerHTML = `<div class="changes-error">⚠️ Unable to read git status</div>`;
		}
	}

	private _renderStatus(status: IGitStatus): void {
		this._statusContainer.innerHTML = '';

		if (!status.hasChanges && status.ahead === 0) {
			const clean = $('div.changes-clean');
			clean.innerHTML = `
				<div class="clean-icon">✨</div>
				<p>Working tree clean</p>
				<p class="clean-branch">Branch: <strong>${status.branch || '(unknown)'}</strong></p>
			`;
			this._statusContainer.appendChild(clean);
			return;
		}

		const info = $('div.changes-info');

		// Branch info
		const branchLine = $('div.changes-branch');
		branchLine.innerHTML = `<strong>Branch:</strong> ${status.branch || '(unknown)'}`;
		if (status.ahead > 0) {
			branchLine.innerHTML += ` <span class="ahead-badge">${status.ahead}↑</span>`;
		}
		if (status.behind > 0) {
			branchLine.innerHTML += ` <span class="behind-badge">${status.behind}↓</span>`;
		}
		info.appendChild(branchLine);

		// File counts
		if (status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0) {
			const stats = $('div.changes-file-stats');
			const parts: string[] = [];
			if (status.staged.length > 0) { parts.push(`<span class="stat-staged">● ${status.staged.length} staged</span>`); }
			if (status.unstaged.length > 0) { parts.push(`<span class="stat-unstaged">● ${status.unstaged.length} modified</span>`); }
			if (status.untracked.length > 0) { parts.push(`<span class="stat-untracked">● ${status.untracked.length} untracked</span>`); }
			stats.innerHTML = parts.join(' &nbsp; ');
			info.appendChild(stats);
		}

		// File list (limited)
		const allFiles = [...status.staged, ...status.unstaged, ...status.untracked];
		if (allFiles.length > 0) {
			const fileList = $('div.changes-file-list');
			const maxShow = 10;
			const filesToShow = allFiles.slice(0, maxShow);
			fileList.innerHTML = filesToShow.map(f => `<div class="change-file">• ${f}</div>`).join('');
			if (allFiles.length > maxShow) {
				fileList.innerHTML += `<div class="change-file more">... and ${allFiles.length - maxShow} more</div>`;
			}
			info.appendChild(fileList);
		}

		this._statusContainer.appendChild(info);
	}

	private _renderRemotes(remotes: IGitRemote[]): void {
		this._remotesContainer.innerHTML = '';

		if (remotes.length === 0) {
			this._remotesContainer.innerHTML = '<div class="changes-no-remotes">No remotes configured</div>';
			return;
		}

		const title = $('div.remotes-title');
		title.innerHTML = `<strong>Push targets:</strong> ${remotes.length} remote(s)`;
		this._remotesContainer.appendChild(title);

		const list = $('div.remotes-list');
		for (const remote of remotes) {
			const item = $('div.remote-item');
			const shortUrl = remote.url.replace(/https?:\/\//, '').replace(/\.git$/, '');
			item.innerHTML = `<span class="remote-name">${remote.name}</span> <span class="remote-url">${shortUrl}</span>`;
			list.appendChild(item);
		}
		this._remotesContainer.appendChild(list);
	}

	private async _commitAndPushAll(): Promise<void> {
		if (this._isOperating) {
			return;
		}

		this._isOperating = true;
		this._commitBtn.disabled = true;
		this._commitBtn.textContent = '⏳ Committing & Pushing...';
		this._clearLog();
		this._appendLog('Starting commit & push to all remotes...', 'info');

		try {
			const message = this._commitMsgInput.value.trim() || undefined;

			const result = await this._gitCommitService.commitAndPushAll(message);

			// Display results
			if (result.commitResult.success) {
				if (result.commitResult.stdout.includes('Nothing to commit')) {
					this._appendLog('No new changes to commit (checking for unpushed commits...)', 'info');
				} else {
					this._appendLog('✓ Committed successfully', 'success');
				}
			} else {
				this._appendLog(`✗ Commit failed: ${result.commitResult.stderr}`, 'error');
			}

			for (const [remote, pushResult] of result.pushResults) {
				if (pushResult.success) {
					this._appendLog(`✓ Pushed to "${remote}" successfully`, 'success');
				} else {
					this._appendLog(`✗ Push to "${remote}" failed: ${pushResult.stderr}`, 'error');
				}
			}

			// Show notification
			const allSuccess = result.commitResult.success &&
				Array.from(result.pushResults.values()).every(r => r.success);

			if (allSuccess) {
				this._notificationService.notify({
					severity: Severity.Info,
					message: `Commit & Push completed: ${result.pushResults.size} remote(s) updated`,
				});
			} else {
				this._notificationService.notify({
					severity: Severity.Warning,
					message: result.summary,
				});
			}

			// Clear commit message on success
			if (result.commitResult.success) {
				this._commitMsgInput.value = '';
			}

			// Refresh status
			await this._refreshStatus();

		} catch (err) {
			this._appendLog(`Error: ${err}`, 'error');
			this._notificationService.notify({
				severity: Severity.Error,
				message: `Commit & Push failed: ${err}`,
			});
		} finally {
			this._isOperating = false;
			this._commitBtn.disabled = false;
			this._commitBtn.textContent = '✓ Commit & Push All';
		}
	}

	private _appendLog(message: string, type: 'info' | 'success' | 'error'): void {
		const line = $('div.log-line');
		line.classList.add(`log-${type}`);
		const time = new Date().toLocaleTimeString();
		line.textContent = `[${time}] ${message}`;
		this._logContainer.appendChild(line);
		this._logContainer.scrollTop = this._logContainer.scrollHeight;
	}

	private _clearLog(): void {
		this._logContainer.innerHTML = '';
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._container) {
			this._container.style.height = `${height}px`;
			this._container.style.overflow = 'auto';
		}
	}
}
