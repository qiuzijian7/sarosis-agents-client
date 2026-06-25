/*---------------------------------------------------------------------------------------------.
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IURLHandler, IOpenURLOptions } from '../../../../platform/url/common/url.js';
import { IMarketplaceService } from '../common/marketplace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import type { PackageKind } from '../common/marketplace.js';

/**
 * Handles `vssaros://marketplace/install` URIs triggered from the web marketplace.
 *
 * URL format:
 *   vssaros://marketplace/install?slug=<slug>&version=<version>&kind=<kind>
 *
 * Flow:
 *   1. User clicks "安装到 VsSaros" on the web marketplace detail page
 *   2. Browser opens vssaros:// URL → OS launches VsSaros
 *   3. This handler receives the URI, parses params
 *   4. Calls marketplaceService.download() to download + install
 *   5. Shows progress notification and success/error message
 */
export class MarketplaceUrlHandler extends Disposable implements IURLHandler {

	static readonly ID = 'workbench.handler.marketplace';

	constructor(
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@INotificationService private readonly notificationService: INotificationService,
		@IProgressService private readonly progressService: IProgressService,
	) {
		super();
	}

	async handleURL(uri: URI, _options?: IOpenURLOptions): Promise<boolean> {
		// Only handle vssaros://marketplace/install
		if (uri.authority !== 'marketplace') {
			return false;
		}

		const path = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
		if (path !== 'install') {
			return false;
		}

		// Parse query params
		const params = new URLSearchParams(uri.query);
		const slug = params.get('slug');
		const version = params.get('version');
		const kind = params.get('kind') as PackageKind | null;

		if (!slug || !version || !kind) {
			this.notificationService.error(
				`安装参数不完整。需要 slug、version 和 kind 参数。\nURL: ${uri.toString()}`
			);
			return true;
		}

		const validKinds: PackageKind[] = ['skill', 'mcp', 'agent', 'knowledge'];
		if (!validKinds.includes(kind)) {
			this.notificationService.error(`不支持的资源类型: ${kind}`);
			return true;
		}

		const kindLabel: Record<PackageKind, string> = {
			skill: '技能',
			mcp: 'MCP 服务器',
			agent: 'Agent',
			knowledge: '知识库',
		};

		// Show progress and install
		this.notificationService.info(`正在从商城安装 ${kindLabel[kind]}: ${slug} v${version}...`);

		try {
			const result = await this.progressService.withProgress(
				{
					location: ProgressLocation.Notification,
					title: `安装 ${kindLabel[kind]}: ${slug} v${version}`,
					cancellable: false,
				},
				async () => {
					return await this.marketplaceService.download(slug, version, kind);
				}
			);

			this.notificationService.info(
				`✅ ${kindLabel[kind]} "${slug}" v${result.version} 安装成功！\n` +
				`安装位置: ${result.targetDir}`
			);

			// Installation complete — the Integration view will refresh
			// on next activation; no explicit command needed.

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.notificationService.error(
				`❌ 安装失败: ${kindLabel[kind]} "${slug}" v${version}\n${msg}`
			);
		}

		return true;
	}
}
