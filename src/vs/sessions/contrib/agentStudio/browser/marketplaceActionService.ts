/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 商城工作台的**执行面**（★ 2026-10-22）。
 * ============================================================
 * dsh 侧的商城工作台**只发意图**（ide.request{capability:'marketplace'}）⇒
 * 全部有副作用的动作都在这里落地 ✓。
 *
 * ## 为什么全部在 IDE 侧（而不是 dsh Host 侧）
 *  ① 商城认证（JWT）在 IDE 进程（IMarketplaceService 复用 TOF 登录态）⇒ Host 没有票据 ✗；
 *  ② 装工作台包必须走主进程那条已验证的通道（暂存 + `dsh plugin add`）⇒
 *     Host 内 pluginManager.installBundle 在全新 profile 上会剪树失败（README 4.86）✗；
 *  ③ agent/skill/workflow 的落盘目录与注册表刷新都在 IDE 侧 ⇒ Host 写文件也刷不到 ✗。
 *
 * ## 四类商品的安装语义
 *  - agent / skill / workflow：商城上的 tar.gz ⇒ 下载 → 解包 → installer 落地 + 刷新注册表
 *  - workbench：**外部发布源**（npm/github）⇒ 本体不在商城服务器上 ⇒ 按 distribution 解析成 spec
 *
 * ★ 失败一律如实回 ok:false + error（**绝不静默成功**）⇒ 否则界面会显示「已安装」实则没装 ✗。
 */

import type { ILogService } from '../../../../platform/log/common/log.js';
import type { IMarketplaceService, PackageKind } from '../common/marketplace.js';
import { distributionOfVersion, resolveDistributionSpec } from '../common/marketplaceDistribution.js';

/** 商城动作的入参（与 dshIdeCapabilities.ts 的 marketplaceAction 同形）。 */
export interface IMarketplaceActionRequest {
	readonly op: 'list' | 'detail' | 'install' | 'uninstall' | 'upgrade' | 'publish' | 'deletePackage' | 'deleteVersion';
	readonly kind?: string;
	readonly slug?: string;
	readonly version?: string;
	readonly localId?: string;
	readonly q?: string;
	readonly category?: string;
	readonly scope?: 'all' | 'mine' | 'review';
	readonly limit?: number;
	readonly changelog?: string;
}

/** 执行面的依赖（由 dshHarnessService 注入）。 */
export interface IMarketplaceActionHost {
	/** 商城服务（认证 + 浏览 + 下载 + 发布 + 卸载） */
	readonly marketplace: IMarketplaceService;
	/** 按 spec 装 dsh 插件（npm / github-source）—— 走主进程已验证通道 ✓ */
	installPluginSpec(spec: string, name: string): Promise<{ readonly ok: boolean; readonly changed: boolean; readonly version?: string; readonly error?: string }>;
	/**
	 * 装一个**外部 tarball**（github-release）：主进程下载 + 校验 sha256 + `dsh plugin add file:<tgz>` ✓。
	 *
	 * 为什么单独一条：spec 通道只收 spec，**不负责取包** ⇒ 商城登记的 GitHub Release 附件没人下载 ✗。
	 * 下载与校验**必须**在主进程（renderer 没有 sha256 实现）✓。
	 */
	installExternalTarball?(args: { readonly url: string; readonly sha256: string; readonly name: string; readonly bytes?: number }): Promise<{ readonly ok: boolean; readonly changed: boolean; readonly version?: string; readonly error?: string }>;
	/** 卸掉已装的 dsh 插件 */
	removePlugin?(name: string): Promise<{ readonly ok: boolean; readonly error?: string }>;
	readonly logService: ILogService;
}

/** 统一回执形状（dsh 侧直接吃，不做二次解析 ✓）。 */
export interface IMarketplaceActionResult {
	readonly ok: boolean;
	readonly error?: string;
	readonly [key: string]: unknown;
}

/**
 * 执行一个商城动作。
 *
 * ⚠️ 未知 op 一律抛错（不静默成功）⇒ 协议两头对不上时能立刻看见 ✓。
 */
export async function runMarketplaceAction(
	host: IMarketplaceActionHost,
	req: IMarketplaceActionRequest,
): Promise<IMarketplaceActionResult> {
	const { marketplace, logService } = host;

	switch (req.op) {
		case 'list': {
			await marketplace.ensureLoggedIn();
			const res = await marketplace.listPackages({
				...(req.kind ? { kind: req.kind as PackageKind } : {}),
				...(req.q ? { q: req.q } : {}),
				...(req.category ? { category: req.category } : {}),
				...(req.scope ? { scope: req.scope } : {}),
				pageSize: req.limit ?? 50,
			});
			return {
				ok: true,
				total: res.total,
				items: res.items.map(pkg => ({
					id: pkg.id,
					kind: pkg.kind,
					slug: pkg.slug,
					name: pkg.name,
					version: pkg.latestVersion ?? '',
					description: pkg.description ?? '',
					author: pkg.authorName ?? '',
					category: pkg.category ?? '',
					icon: pkg.icon ?? '',
					tags: pkg.tags ?? [],
					status: pkg.status ?? 'active',
					distributionType: pkg.distributionType ?? 'bundle',
					distribution: pkg.distribution ?? null,
					permissions: pkg.permissions ?? null,
				})),
			};
		}

		case 'detail': {
			await marketplace.ensureLoggedIn();
			if (!req.slug) { throw new Error('marketplace.detail 需要 slug'); }
			const pkg = await marketplace.getPackage(req.slug);
			return {
				ok: true,
				id: pkg.id,
				kind: pkg.kind,
				slug: pkg.slug,
				name: pkg.name,
				description: pkg.description ?? '',
				category: pkg.category ?? '',
				icon: pkg.icon ?? '',
				tags: pkg.tags ?? [],
				version: pkg.latestVersion ?? '',
				status: pkg.status ?? 'active',
				distributionType: pkg.distributionType ?? 'bundle',
				distribution: pkg.distribution ?? null,
				permissions: pkg.permissions ?? null,
				versions: (pkg.versions ?? []).map(v => ({
					version: v.version,
					changelog: v.changelog ?? '',
					sha256: v.sha256,
					size: v.size,
					isLatest: v.isLatest,
				})),
			};
		}

		case 'install':
		case 'upgrade': {
			await marketplace.ensureLoggedIn();
			if (!req.kind || !req.slug) { throw new Error(`marketplace.${req.op} 需要 kind 与 slug`); }
			const kind = req.kind as PackageKind;
			const detail = await marketplace.getPackage(req.slug);
			const targetVersion = req.version || detail.latestVersion;
			if (!targetVersion) {
				throw new Error(`marketplace.${req.op}：包「${req.slug}」没有可用版本`);
			}

			// ★ workbench 走外部发布源通道（本体不在商城服务器上 ⇒ 没有 tar.gz 可下）✓
			if (kind === 'workbench') {
				const dist = distributionOfVersion(detail, targetVersion);
				if (!dist) {
					throw new Error(`工作台「${req.slug}」没有登记发布源（distribution）⇒ 不知道该从哪儿装`);
				}
				const resolved = resolveDistributionSpec(dist, targetVersion);
				if (resolved.error) {
					return { ok: false, error: resolved.error };
				}
				if (resolved.needsDownload) {
					// github-release：本体是 GitHub Release 上的 tarball ⇒ 走主进程「下载 + 校验 sha256 + file: spec」✓
					if (!host.installExternalTarball) {
						return { ok: false, error: '这台 IDE 没有外部包下载通道（installExternalTarball 缺失）' };
					}
					const url = dist.url;
					const sha = dist.sha256;
					if (!url || !sha) {
						return { ok: false, error: `工作台「${req.slug}」的发布源信息不完整（缺 url 或 sha256）` };
					}
					const tar = await host.installExternalTarball({
						url,
						sha256: sha,
						name: resolved.name ?? dist.name ?? req.slug,
						...(dist.bytes ? { bytes: dist.bytes } : {}),
					});
					logService.info(`[marketplace] ${req.op} workbench ${req.slug} via tarball ${url}: ok=${tar.ok}`);
					if (!tar.ok) {
						return { ok: false, error: tar.error ?? '工作台安装失败（主进程没有给出原因）' };
					}
					return {
						ok: true,
						changed: tar.changed,
						version: tar.version ?? targetVersion,
						restartRequired: true,
					};
				}
				if (!resolved.spec || !resolved.name) {
					return { ok: false, error: `工作台「${req.slug}」的发布源信息不完整（缺 name）` };
				}
				const installResult = await host.installPluginSpec(resolved.spec, resolved.name);
				logService.info(`[marketplace] ${req.op} workbench ${resolved.name} via ${resolved.spec}: ok=${installResult.ok}`);
				if (!installResult.ok) {
					return { ok: false, error: installResult.error ?? '工作台安装失败（主进程没有给出原因）' };
				}
				return {
					ok: true,
					changed: installResult.changed,
					version: installResult.version ?? targetVersion,
					restartRequired: true,
				};
			}

			// agent / skill / workflow 等：下载 tar.gz → 落盘 → 刷新注册表（download 内部已做）✓
			const result = await marketplace.download(detail.slug, targetVersion, kind);
			logService.info(`[marketplace] ${req.op} ${kind}/${detail.slug}@${targetVersion} → ${result.targetDir}`);
			return { ok: true, changed: true, version: result.version, targetDir: result.targetDir };
		}

		case 'uninstall': {
			await marketplace.ensureLoggedIn();
			if (!req.kind || !req.slug) { throw new Error('marketplace.uninstall 需要 kind 与 slug'); }
			const kind = req.kind as PackageKind;
			if (kind === 'workbench') {
				if (!host.removePlugin) {
					throw new Error('这台 IDE 没有卸载工作台的通道（removePlugin 缺失）');
				}
				const r = await host.removePlugin(req.slug);
				return r.ok ? { ok: true, changed: true } : { ok: false, error: r.error ?? '卸载失败' };
			}
			await marketplace.uninstall(req.slug, kind);
			return { ok: true, changed: true };
		}

		case 'publish': {
			await marketplace.ensureLoggedIn();
			if (!req.kind || !req.localId) { throw new Error('marketplace.publish 需要 kind 与 localId'); }
			const published = await marketplace.publish(req.localId, req.kind as PackageKind, {
				...(req.version ? { version: req.version } : {}),
				...(req.changelog ? { changelog: req.changelog } : {}),
			});
			return { ok: true, version: published.version };
		}

		case 'deletePackage': {
			await marketplace.ensureLoggedIn();
			if (!req.slug) { throw new Error('marketplace.deletePackage 需要 slug'); }
			// ★ 判权在服务端（作者或管理员）⇒ 这里只发意图，不在客户端判 ✗
			const detail = await marketplace.getPackage(req.slug);
			await marketplace.uninstall(req.slug, detail.kind);
			return { ok: true };
		}

		case 'deleteVersion': {
			await marketplace.ensureLoggedIn();
			if (!req.slug || !req.version) { throw new Error('marketplace.deleteVersion 需要 slug 与 version'); }
			await marketplace.deleteVersion(req.slug, req.version);
			return { ok: true };
		}

		default:
			// 未知 op ⇒ 抛错（协议两头对不上时能立刻看见 ✗）
			throw new Error(`marketplace 的 op 不认识：${String((req as { op: string }).op)}`);
	}
}
