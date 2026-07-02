/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * WorkflowToolbar —— 工作流编辑器顶部工具栏。
 *
 * 显示：
 *   - 工作流名称 + 版本号 badge
 *   - 删除按钮（始终显示）
 *   - 上传按钮（服务器中无该工作流时显示）
 *   - 升级按钮（服务器版本号 > 本地版本号时显示）
 *
 * 逻辑：
 *   1. 初始化时从 marketplaceService.getPackage(slug) 查询服务器版本
 *   2. 从 installed-packages.json 或 workflow.version 获取本地版本
 *   3. 比较版本，决定显示哪个按钮
 *
 * 用法：
 *   const toolbar = new WorkflowToolbar(parent, workflow, services...);
 *   toolbar.render();
 *   toolbar.onDidRequestDelete(() => { ... });
 *   toolbar.onDidRequestUpload(() => { ... });
 *   toolbar.onDidRequestUpgrade(() => { ... });
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { $ } from '../../../../base/browser/dom.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { IMarketplaceService } from '../common/marketplace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkflowStorageService, IStoredWorkflow } from '../common/workflowStorage.js';
import { ITofAuthService } from '../common/tofAuth.js';
import { WorkflowPublishModal } from './workflowPublishModal.js';

export class WorkflowToolbar extends Disposable {

	private _container!: HTMLElement;
	private _versionBadge!: HTMLElement;
	private _uploadBtn!: HTMLButtonElement;
	private _upgradeBtn!: HTMLButtonElement;
	private _serverVersion: string | undefined;
	private _localVersion: string | undefined;
	private _isLoading = false;

	private readonly _onDidRequestDelete = this._register(new Emitter<IStoredWorkflow>());
	readonly onDidRequestDelete: Event<IStoredWorkflow> = this._onDidRequestDelete.event;

	private readonly _onDidPublish = this._register(new Emitter<IStoredWorkflow>());
	readonly onDidPublish: Event<IStoredWorkflow> = this._onDidPublish.event;

	constructor(
		private readonly parent: HTMLElement,
		private readonly workflow: IStoredWorkflow,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkflowStorageService private readonly workflowStorage: IWorkflowStorageService,
		@ITofAuthService private readonly tofAuthService: ITofAuthService,
	) {
		super();
	}

	/** 渲染工具栏 */
	render(): HTMLElement {
		this._container = $('div.workflow-toolbar');
		this._container.style.display = 'flex';
		this._container.style.alignItems = 'center';
		this._container.style.gap = '8px';
		this._container.style.padding = '6px 12px';
		this._container.style.background = 'var(--vscode-sideBar-background, #252526)';
		this._container.style.borderBottom = '1px solid var(--vscode-panel-border)';
		this._container.style.flexShrink = '0';
		this._container.style.fontSize = '12px';
		this._container.style.position = 'relative';
		this._container.style.zIndex = '11';

		// ── 工作流名称 ──
		const nameEl = $('span.workflow-toolbar-name');
		nameEl.textContent = this.workflow.name;
		nameEl.style.fontWeight = '600';
		nameEl.style.color = 'var(--vscode-foreground)';
		this._container.appendChild(nameEl);

		// ── 版本号 badge ──
		this._versionBadge = $('span.workflow-toolbar-version');
		this._localVersion = this.workflow.version;
		if (this._localVersion) {
			this._versionBadge.textContent = `v${this._localVersion}`;
			this._versionBadge.classList.add('installed');
		} else {
			this._versionBadge.textContent = '未发布';
			this._versionBadge.classList.add('unpublished');
		}
		this._versionBadge.style.fontSize = '10px';
		this._versionBadge.style.padding = '2px 6px';
		this._versionBadge.style.borderRadius = '3px';
		this._versionBadge.style.fontWeight = '600';
		this._container.appendChild(this._versionBadge);

		// ── Spacer ──
		const spacer = $('div');
		spacer.style.flex = '1';
		this._container.appendChild(spacer);

		// ── 内联删除确认栏（初始隐藏） ──
		const delConfirm = $('div.wpm-del-confirm');
		delConfirm.style.display = 'none';
		delConfirm.style.alignItems = 'center';
		delConfirm.style.gap = '8px';
		delConfirm.style.flex = '1';
		delConfirm.style.justifyContent = 'flex-end';
		const delConfirmText = $('span');
		delConfirmText.textContent = '确认删除此工作流？';
		delConfirmText.style.color = 'var(--vscode-errorForeground)';
		delConfirmText.style.fontSize = '12px';
		delConfirmText.style.fontWeight = '600';
		delConfirm.appendChild(delConfirmText);
		const delOkBtn = $('button') as HTMLButtonElement;
		delOkBtn.textContent = '确认删除';
		delOkBtn.style.background = 'var(--vscode-inputValidation-errorBackground, #5a1d1d)';
		delOkBtn.style.border = '1px solid var(--vscode-inputValidation-errorBorder, #be1100)';
		delOkBtn.style.color = 'var(--vscode-inputValidation-errorForeground, #f48771)';
		delOkBtn.style.padding = '4px 10px';
		delOkBtn.style.borderRadius = '3px';
		delOkBtn.style.cursor = 'pointer';
		delOkBtn.style.fontSize = '11px';
		delOkBtn.style.fontWeight = '600';
		delOkBtn.onclick = () => { void this._executeDelete(); };
		delConfirm.appendChild(delOkBtn);
		const delCancelBtn = $('button') as HTMLButtonElement;
		delCancelBtn.textContent = '取消';
		delCancelBtn.style.background = 'transparent';
		delCancelBtn.style.border = '1px solid var(--vscode-panel-border)';
		delCancelBtn.style.color = 'var(--vscode-foreground)';
		delCancelBtn.style.padding = '4px 10px';
		delCancelBtn.style.borderRadius = '3px';
		delCancelBtn.style.cursor = 'pointer';
		delCancelBtn.style.fontSize = '11px';
		delCancelBtn.style.fontWeight = '600';
		delCancelBtn.onclick = () => { this._cancelDelete(spacer, delConfirm, deleteBtn, this._uploadBtn, this._upgradeBtn); };
		delConfirm.appendChild(delCancelBtn);
		this._container.appendChild(delConfirm);

		// ── 升级按钮（初始隐藏） ──
		this._upgradeBtn = $('button.workflow-toolbar-btn.upgrade') as HTMLButtonElement;
		this._upgradeBtn.textContent = '⬆ 升级';
		this._upgradeBtn.title = '升级到最新版本';
		this._upgradeBtn.style.background = 'var(--vscode-statusBarItem-warningBackground)';
		this._upgradeBtn.style.border = 'none';
		this._upgradeBtn.style.color = 'var(--vscode-statusBarItem-warningForeground)';
		this._upgradeBtn.style.padding = '4px 10px';
		this._upgradeBtn.style.borderRadius = '3px';
		this._upgradeBtn.style.cursor = 'pointer';
		this._upgradeBtn.style.fontSize = '11px';
		this._upgradeBtn.style.fontWeight = '600';
		this._upgradeBtn.style.display = 'none';
		this._upgradeBtn.onclick = () => { void this._handleUpgrade(); };
		this._container.appendChild(this._upgradeBtn);

		// ── 上传按钮（初始隐藏） ──
		this._uploadBtn = $('button.workflow-toolbar-btn.upload') as HTMLButtonElement;
		this._uploadBtn.textContent = '📤 上传';
		this._uploadBtn.title = '上传工作流到商城';
		this._uploadBtn.style.background = 'var(--vscode-button-background)';
		this._uploadBtn.style.border = 'none';
		this._uploadBtn.style.color = 'var(--vscode-button-foreground)';
		this._uploadBtn.style.padding = '4px 10px';
		this._uploadBtn.style.borderRadius = '3px';
		this._uploadBtn.style.cursor = 'pointer';
		this._uploadBtn.style.fontSize = '11px';
		this._uploadBtn.style.fontWeight = '600';
		this._uploadBtn.style.display = 'none';
		this._uploadBtn.onclick = () => { void this._handleUpload(); };
		this._container.appendChild(this._uploadBtn);

		// ── 删除按钮（始终显示） ──
		const deleteBtn = $('button.workflow-toolbar-btn.delete') as HTMLButtonElement;
		deleteBtn.textContent = '🗑 删除';
		deleteBtn.title = '删除此工作流';
		deleteBtn.style.background = 'transparent';
		deleteBtn.style.border = '1px solid var(--vscode-panel-border)';
		deleteBtn.style.color = 'var(--vscode-errorForeground)';
		deleteBtn.style.padding = '4px 10px';
		deleteBtn.style.borderRadius = '3px';
		deleteBtn.style.cursor = 'pointer';
		deleteBtn.style.fontSize = '11px';
		deleteBtn.style.fontWeight = '600';
		deleteBtn.onclick = () => {
			// 隐藏右侧操作按钮 + spacer，显示内联确认栏
			deleteBtn.style.display = 'none';
			this._uploadBtn.style.display = 'none';
			this._upgradeBtn.style.display = 'none';
			spacer.style.display = 'none';
			delConfirm.style.display = 'flex';
		};
		this._container.appendChild(deleteBtn);

		// 查询服务器版本
		void this._checkServerVersion();

		this.parent.appendChild(this._container);
		return this._container;
	}

	/** 更新工作流数据（编辑器中工作流可能被修改后重新设置） */
	updateWorkflow(workflow: IStoredWorkflow): void {
		(this.workflow as any).version = workflow.version;
		(this.workflow as any).name = workflow.name;
		(this.workflow as any).description = workflow.description;
		if (this._versionBadge && workflow.version) {
			this._versionBadge.textContent = `v${workflow.version}`;
		}
	}

	// ─── 内部逻辑 ──────────────────────────────────────────────────

	/** 查询服务器版本，决定显示上传/升级按钮 */
	private async _checkServerVersion(): Promise<void> {
		if (this._isLoading) { return; }
		this._isLoading = true;

		try {
			const pkg = await this.marketplaceService.getPackage(this.workflow.id);
			this._serverVersion = pkg.latestVersion;

			// 先统一隐藏两个按钮，下面按条件显示
			if (this._uploadBtn) { this._uploadBtn.style.display = 'none'; }
			if (this._upgradeBtn) { this._upgradeBtn.style.display = 'none'; }

			if (!this._versionBadge) {
				return;
			}

			if (this._serverVersion && this._localVersion) {
				const localHigher = this._isVersionHigher(this._localVersion, this._serverVersion);
				const serverHigher = this._isVersionHigher(this._serverVersion, this._localVersion);

				if (serverHigher) {
					// 服务器版本更高 → 显示升级按钮
					this._versionBadge.textContent = `v${this._localVersion} → v${this._serverVersion}`;
					this._versionBadge.classList.remove('installed', 'unpublished');
					this._versionBadge.classList.add('outdated');
					if (this._upgradeBtn) { this._upgradeBtn.style.display = ''; }
				} else if (localHigher) {
					// 本地版本更高（有修改）→ 显示上传按钮
					this._versionBadge.textContent = `v${this._localVersion} (本地已修改)`;
					this._versionBadge.classList.remove('outdated', 'unpublished');
					this._versionBadge.classList.add('installed');
					if (this._uploadBtn) {
						this._uploadBtn.style.display = '';
						this._uploadBtn.textContent = '📤 上传更新';
						this._uploadBtn.title = `将本地修改 (v${this._localVersion}) 上传到服务器 (v${this._serverVersion})`;
					}
			} else {
				// 版本一致 → 隐藏两者
				this._versionBadge.textContent = `v${this._localVersion}`;
				this._versionBadge.classList.remove('outdated', 'unpublished');
				this._versionBadge.classList.add('installed');
			}
		} else if (this._serverVersion) {
			// 服务器有版本但本地无版本号 → 显示服务器版本，不显示升级按钮
			this._versionBadge.textContent = `服务器 v${this._serverVersion}`;
			this._versionBadge.classList.remove('outdated', 'unpublished');
			this._versionBadge.classList.add('installed');
		}
		} catch {
			// 服务器中无该工作流（404 等）→ 显示上传按钮
			if (!this._serverVersion) {
				if (this._uploadBtn) {
					this._uploadBtn.style.display = '';
					this._uploadBtn.textContent = '📤 上传';
					this._uploadBtn.title = '上传工作流到商城';
				}
				if (this._upgradeBtn) { this._upgradeBtn.style.display = 'none'; }
			}
		} finally {
			this._isLoading = false;
		}
	}

	/** 比较 semver 版本，返回 true 如果 a > b */
	private _isVersionHigher(a: string | undefined, b: string | undefined): boolean {
		if (!a) { return false; }
		if (!b) { return true; }
		const parseVer = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
		const sa = parseVer(a);
		const sb = parseVer(b);
		for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
			const av = sa[i] ?? 0;
			const bv = sb[i] ?? 0;
			if (av > bv) { return true; }
			if (av < bv) { return false; }
		}
		return false;
	}

	// ─── 按钮处理 ──────────────────────────────────────────────────

	/** 处理上传按钮点击 — 弹出发布modal */
	private async _handleUpload(): Promise<void> {
		// 读取最新的工作流数据
		let latestWorkflow = this.workflow;
		try {
			const fresh = await this.workflowStorage.getWorkflow(this.workflow.id);
			if (fresh) {
				latestWorkflow = fresh;
			}
		} catch { /* 使用缓存数据 */ }

		const modal = new WorkflowPublishModal(
			latestWorkflow,
			this.marketplaceService,
			this.notificationService,
			this.workflowStorage,
			this.tofAuthService,
		);
		const publishSub = modal.onDidPublish((published) => {
			// 发布成功后同步本地版本号，避免升级按钮误显示
			this._localVersion = published.version || this._localVersion;
			if (this._versionBadge && this._localVersion) {
				this._versionBadge.textContent = `v${this._localVersion}`;
				this._versionBadge.classList.remove('outdated', 'unpublished');
				this._versionBadge.classList.add('installed');
			}
			// 隐藏上传按钮，重新检查服务器版本（版本一致时升级按钮会隐藏）
			if (this._uploadBtn) { this._uploadBtn.style.display = 'none'; }
			void this._checkServerVersion();
			this._onDidPublish.fire(published);
		});
		modal.onDidClose(() => {
			publishSub.dispose();
			modal.dispose();
		});
		modal.show();
	}

	/** 处理升级按钮点击 — 从商城下载最新版本 */
	private async _handleUpgrade(): Promise<void> {
		if (!this._serverVersion) { return; }

		try {
			this.notificationService.info(`正在升级 "${this.workflow.name}" 到 v${this._serverVersion}...`);
			await this.marketplaceService.download(this.workflow.id, this._serverVersion, 'workflow');
			this._localVersion = this._serverVersion;

			// 更新 UI
			if (this._versionBadge) {
				this._versionBadge.textContent = `v${this._serverVersion}`;
				this._versionBadge.classList.remove('outdated', 'unpublished');
				this._versionBadge.classList.add('installed');
			}
			if (this._upgradeBtn) {
				this._upgradeBtn.style.display = 'none';
			}

			this.notificationService.info(`"${this.workflow.name}" 已升级到 v${this._serverVersion}`);
		} catch (err) {
			this.notificationService.error(
				`升级 "${this.workflow.name}" 失败: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/** 执行删除 — 内联确认后调用，通过事件交由 EditorPane 实际执行 */
	private _executeDelete(): void {
		this._onDidRequestDelete.fire(this.workflow);
	}

	/** 取消删除 — 恢复工具栏原貌 */
	private _cancelDelete(
		spacer: HTMLElement,
		delConfirm: HTMLElement,
		deleteBtn: HTMLButtonElement,
		uploadBtn: HTMLButtonElement,
		upgradeBtn: HTMLButtonElement,
	): void {
		deleteBtn.style.display = '';
		if (uploadBtn.style.display !== 'none' || !this._serverVersion) {
			// uploadBtn 的 display 由 _checkServerVersion 控制，可能为空字符串
		}
		upgradeBtn.style.display = '';  // _checkServerVersion 会重新决定
		spacer.style.display = '';
		delConfirm.style.display = 'none';
	}
}
