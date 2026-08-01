/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MarketplaceVersionsPanel —— 可复用的「商城版本（Releases）」列表面板。
 *
 * 用于 agent / skill / workflow 各类资源的版本管理界面，展示商城已发布版本：
 *   - 版本号 + latest 徽章 + changelog
 *   - 「安装此版本」：下载指定版本覆盖安装（含旧版本回滚），安装后回调宿主做本地 git 记录
 *   - 「下架」：仅作者可见（canModify），删除商城版本；删 latest 版本时提示服务端会重算
 *
 * 宿主只需提供 storeId / kind / canModify / onAfterInstall，DOM 挂载 `element` 即可。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { $ } from '../../../../base/browser/dom.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IMarketplaceService, IMarketplaceVersion, PackageKind } from '../common/marketplace.js';
import { compareSemver } from './publishVersioning.js';

export interface IMarketplaceVersionsPanelOptions {
	/** 商城包标识（slug / storeId） */
	readonly storeId: string;
	readonly kind: PackageKind;
	/**
	 * 是否显示「下架」按钮（作者/owner）。
	 * 不传时自动判定：installed-packages.json 中该包 source==='published'（本机发布的）。
	 */
	readonly canModify?: boolean;
	/** 「安装此版本」成功后的回调（宿主用于本地 git autoCommit / 刷新界面） */
	readonly onAfterInstall?: (version: string) => Promise<void> | void;
}

export class MarketplaceVersionsPanel extends Disposable {

	/** 挂载此元素到宿主容器 */
	readonly element: HTMLElement;

	private readonly _listContainer: HTMLElement;
	private _loading = false;
	private _canModifyResolved: boolean | undefined;

	constructor(
		private readonly _opts: IMarketplaceVersionsPanelOptions,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();

		this.element = $('div.marketplace-versions-panel');

		const title = $('div');
		title.textContent = '商城版本（Releases）';
		title.style.fontSize = '12px';
		title.style.fontWeight = '600';
		title.style.margin = '4px 0 8px 0';
		title.style.color = 'var(--vscode-foreground)';
		this.element.appendChild(title);

		this._listContainer = $('div.marketplace-versions-list');
		this.element.appendChild(this._listContainer);
	}

	/** 加载（或刷新）商城版本列表 */
	async load(): Promise<void> {
		if (this._loading) { return; }
		this._loading = true;
		this._listContainer.textContent = '⏳ 加载商城版本...';
		this._listContainer.style.padding = '12px 4px';
		this._listContainer.style.color = 'var(--vscode-descriptionForeground)';
		this._listContainer.style.fontSize = '12px';
		try {
			const [detail, canModify] = await Promise.all([
				this.marketplaceService.getPackage(this._opts.storeId),
				this._resolveCanModify(),
			]);
			this._canModifyResolved = canModify;
			this._render(detail.versions ?? []);
		} catch {
			this._listContainer.textContent = '尚未发布到商城（或商城不可达）';
		} finally {
			this._loading = false;
		}
	}

	/** canModify 未显式传入时自动判定：本机发布的（source==='published'）才允许下架 */
	private async _resolveCanModify(): Promise<boolean> {
		if (this._opts.canModify !== undefined) { return this._opts.canModify; }
		try {
			const installed = await this.marketplaceService.getInstalled();
			const entry = installed.find(e => e.kind === this._opts.kind && e.storeId === this._opts.storeId);
			return entry?.source === 'published';
		} catch {
			return false;
		}
	}

	private _render(versions: readonly IMarketplaceVersion[]): void {
		this._listContainer.textContent = '';
		this._listContainer.style.padding = '0';
		if (versions.length === 0) {
			this._listContainer.textContent = '商城暂无已发布版本';
			this._listContainer.style.padding = '12px 4px';
			this._listContainer.style.color = 'var(--vscode-descriptionForeground)';
			this._listContainer.style.fontSize = '12px';
			return;
		}
		// 按版本号降序（最新在前）
		const sorted = [...versions].sort((a, b) => compareSemver(b.version, a.version));
		for (const v of sorted) {
			this._listContainer.appendChild(this._renderRow(v));
		}
	}

	private _renderRow(v: IMarketplaceVersion): HTMLElement {
		const row = $('div.marketplace-version-row');
		row.style.padding = '8px 12px';
		row.style.marginBottom = '6px';
		row.style.border = '1px solid var(--vscode-panel-border, #3c3c3c)';
		row.style.borderRadius = '6px';
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '8px';

		// 版本号徽章
		const verBadge = $('code');
		verBadge.textContent = `v${v.version}`;
		verBadge.style.fontSize = '11px';
		verBadge.style.fontFamily = 'monospace';
		verBadge.style.background = 'var(--vscode-badge-background, #4d4d4d)';
		verBadge.style.color = 'var(--vscode-badge-foreground, #fff)';
		verBadge.style.padding = '1px 6px';
		verBadge.style.borderRadius = '3px';
		row.appendChild(verBadge);

		if (v.isLatest) {
			const latestBadge = $('span');
			latestBadge.textContent = 'latest';
			latestBadge.style.fontSize = '10px';
			latestBadge.style.padding = '1px 6px';
			latestBadge.style.borderRadius = '3px';
			latestBadge.style.background = 'var(--vscode-testing-iconPassed, #73c991)';
			latestBadge.style.color = '#000';
			row.appendChild(latestBadge);
		}

		// changelog（单行截断）
		const changelog = $('span');
		changelog.textContent = v.changelog || '';
		changelog.style.flex = '1';
		changelog.style.fontSize = '11px';
		changelog.style.color = 'var(--vscode-descriptionForeground)';
		changelog.style.overflow = 'hidden';
		changelog.style.textOverflow = 'ellipsis';
		changelog.style.whiteSpace = 'nowrap';
		changelog.title = v.changelog || '';
		row.appendChild(changelog);

		// 安装此版本
		const installBtn = $('button') as HTMLButtonElement;
		installBtn.textContent = '安装此版本';
		installBtn.style.fontSize = '11px';
		installBtn.style.padding = '2px 10px';
		installBtn.style.cursor = 'pointer';
		installBtn.onclick = (e) => { e.stopPropagation(); void this._install(v); };
		row.appendChild(installBtn);

		// 下架（仅作者）
		if (this._canModifyResolved) {
			const deleteBtn = $('button') as HTMLButtonElement;
			deleteBtn.textContent = '下架';
			deleteBtn.style.fontSize = '11px';
			deleteBtn.style.padding = '2px 10px';
			deleteBtn.style.cursor = 'pointer';
			deleteBtn.style.color = 'var(--vscode-errorForeground, #f14c4c)';
			deleteBtn.onclick = (e) => { e.stopPropagation(); void this._delete(v); };
			row.appendChild(deleteBtn);
		}

		return row;
	}

	/** 安装商城指定版本（含旧版本回滚）：下载覆盖安装 + 回调宿主做本地 git 记录 */
	private async _install(v: IMarketplaceVersion): Promise<void> {
		try {
			this.notificationService.info(`正在安装 v${v.version}...`);
			await this.marketplaceService.download(this._opts.storeId, v.version, this._opts.kind);
			try {
				await this._opts.onAfterInstall?.(v.version);
			} catch { /* non-critical */ }
			this.notificationService.info(`已安装 v${v.version}`);
			await this.load();
		} catch (err) {
			this.notificationService.error(`安装 v${v.version} 失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 下架商城指定版本（仅作者）。删除 latest 版本时提示服务端会重算最新版本。 */
	private async _delete(v: IMarketplaceVersion): Promise<void> {
		const confirm = await this.dialogService.confirm({
			message: `确定下架 v${v.version} 吗？`,
			detail: v.isLatest
				? '该版本是当前最新版本，下架后商城最新版本将回退到次新版本。已安装的用户不受影响。'
				: '下架后其他用户将无法再下载该版本，已安装的用户不受影响。',
			primaryButton: '下架',
			cancelButton: '取消',
		});
		if (!confirm.confirmed) { return; }
		try {
			await this.marketplaceService.deleteVersion(this._opts.storeId, v.version);
			this.notificationService.info(`v${v.version} 已下架`);
			await this.load();
		} catch (err) {
			this.notificationService.error(`下架失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
