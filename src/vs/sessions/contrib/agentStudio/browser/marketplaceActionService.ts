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
	readonly op: 'list' | 'detail' | 'installed' | 'install' | 'uninstall' | 'upgrade' | 'publish' | 'deletePackage' | 'deleteVersion';
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
/**
 * **已被 dsh 侧接管**的 op（★ 2026-10-22 S1/S2/S2c）。
 *
 * 这些能力已经搬进 `dsh-plugins/vssaros-marketplace`（认证、list/detail/installed、
 * skill/workflow 的装升卸、publish/delete*）⇒ 走到 IDE 侧说明**调用方是旧版或走错路**。
 *
 * ⚠ 必须**立刻报错**而不是"顺手也做一遍"：
 *   两套逻辑都活着时，谁都不知道实际生效的是哪一套 —— 这正是要消掉的状态 ✗
 *   （而且 dsh 侧的台账/备份语义与这里不同，双写会打架）。
 *
 * ⚠ 这里**暂时保留**旧实现（不物理删除），原因：dsh 侧的 S1/S2 尚未真机验收。
 *   验收通过后应整段删除，并把下面这些 op 从 `IMarketplaceActionRequest` 里去掉。
 *   待办登记在 `doc/`（见提交说明）。
 */
const OPS_TAKEN_OVER_BY_DSH = new Set([
	'list', 'detail', 'installed',
	'deletePackage', 'deleteVersion',
]);

/**
 * dsh 侧只接管了 **skill / workflow** 的装升卸；`agent` 与 `workbench` 仍必须由 IDE 做。
 *
 * ⚠ `agent` 为什么搬不走（**不是懒，是有硬理由**）：
 *   · **安装**：dsh 侧装完 preset 不会即时注册（`syncPresets` 只在"打开 agents 页面"时跑），
 *     而且丢了内置 id 冲突保护（装同 id 会被启动期清理 ⇒ "装了又消失"）；
 *   · **发布**：agent 的包格式是 `agent.json`（`AgentExportData`），只有 IDE 的
 *     `agentInstaller.preparePack` 会正确组装（含嵌套 `configHtml`）⇒ dsh 侧反解 YAML 必漂。
 */
const KIND_TAKEN_OVER_BY_DSH = new Set(['skill', 'workflow']);

/**
 * `publish` 里 dsh 侧能自己打包的 kind。
 *
 * ★ 2026-10-23：**加回 `agent`** —— 当年把 agent 的发布留在 IDE 的理由是
 *   "商城包格式是 `agent.json`，只有 IDE 的 `preparePack` 会组装"；现在
 *   `agentInstaller.install` 已支持**目录镜像**（认 `.agent.md`）⇒ 那个理由消失了 ✓
 *   （dsh 侧打目录镜像，IDE 侧也能装；两侧都能发布 ⇒ 不留两套）
 */
const PUBLISH_KINDS_TAKEN_OVER_BY_DSH = new Set(['skill', 'workflow', 'agent']);

export async function runMarketplaceAction(
	host: IMarketplaceActionHost,
	req: IMarketplaceActionRequest,
): Promise<IMarketplaceActionResult> {
	const { marketplace, logService } = host;

	// ── 下线闸：已被 dsh 侧接管的 op 一律拒绝（不执行任何逻辑）──────────────
	if (OPS_TAKEN_OVER_BY_DSH.has(req.op)) {
		throw new Error(
			`marketplace 的 ${req.op} 已由 dsh 侧自持（Host 直接完成），不该再走 IDE 反向调用`
			+ '—— 请升级 dsh 侧插件（@vssaros/dsh-marketplace ≥ 0.1.4）',
		);
	}
	if ((req.op === 'install' || req.op === 'upgrade' || req.op === 'uninstall')
		&& KIND_TAKEN_OVER_BY_DSH.has(String(req.kind ?? ''))) {
		throw new Error(
			`${req.kind} 的 ${req.op} 已由 dsh 侧自持（直接落数据根 + 写台账），不该再走 IDE`
			+ '—— 只有 agent（名册刷新 + 内置冲突保护）与 workbench（要 dsh plugin add + 重启）仍需 IDE',
		);
	}
	if (req.op === 'publish' && PUBLISH_KINDS_TAKEN_OVER_BY_DSH.has(String(req.kind ?? ''))) {
		throw new Error(
			`${req.kind} 的 publish 已由 dsh 侧自持（目录镜像打包 + 上传），不该再走 IDE`,
		);
	}

	switch (req.op) {
		case 'list': {
			await marketplace.ensureLoggedIn();
			let res: { items: readonly any[]; total: number };
			try {
				res = await marketplace.listPackages({
					...(req.kind ? { kind: req.kind as PackageKind } : {}),
					...(req.q ? { q: req.q } : {}),
					...(req.category ? { category: req.category } : {}),
					...(req.scope ? { scope: req.scope } : {}),
					pageSize: req.limit ?? 50,
				});
			} catch (e) {
				// ★ 2026-10-22：服务端**版本落后**时会拒收新类别的 kind
				//   （旧服务端只有 agent|skill|mcp|knowledge|workflow；`workbench` 是后加的）
				//   ⇒ 它回 400「参数校验失败」⇒ 用户只看到一句莫名其妙的话 ✗。
				//   这里识别它并给出**可执行**的提示（"服务端还没升级"而不是"参数错了"）✓。
				const msg = String((e as Error)?.message ?? e);
				if (/参数校验失败/.test(msg) && req.kind) {
					throw new Error(
						`商城服务端还不认识「${req.kind}」这一类商品（它可能还没升级到最新版本）—— 详情：${msg}`,
					);
				}
				throw e;
			}
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

		case 'installed': {
			// ★ 本地台账（installed-packages.json）= "我装了什么"的唯一真源 ✓
			//   （服务端不知道谁装了 ⇒ 这个视图只能在客户端算 ✓）。
			//   顺带把「可升级」标出来：跑一次升级检查并按 kind+storeId 对上 ✓。
			await marketplace.ensureLoggedIn();
			const installed = await marketplace.getInstalled();
			let upgradable = new Set<string>();
			try {
				const updates = await marketplace.checkUpgrades(
					installed.map(e => ({ kind: e.kind, storeId: e.storeId, version: e.version })),
				);
				upgradable = new Set(updates.map(u => `${u.kind}:${u.storeId}`));
			} catch (e) {
				// 升级检查失败**不阻断**「已安装」列表（列表本身仍然有用）✓
				logService.warn(`[marketplace] installed: 升级检查失败（不影响已安装列表）：${String((e as Error)?.message ?? e)}`);
			}
			// 取商城条目补名称/描述（失败就退化成台账里的信息，不让整页挂掉）✓
			const items = await Promise.all(installed.map(async e => {
				let name = e.storeId;
				let description = '';
				let latestVersion = '';
				try {
					const detail = await marketplace.getPackage(e.storeId);
					name = detail.name;
					description = detail.description ?? '';
					latestVersion = detail.latestVersion ?? '';
				} catch {
					// 已从商城下架/删除的条目 ⇒ 只显示台账信息 ✓
				}
				return {
					id: e.storeId,
					kind: e.kind,
					slug: e.storeId,
					name,
					version: e.version,
					description,
					latestVersion,
					upgradable: upgradable.has(`${e.kind}:${e.storeId}`),
					installedAt: e.installedAt,
				};
			}));
			return { ok: true, total: items.length, items };
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
					const tarVersion = tar.version ?? targetVersion;
					await marketplace.recordInstalled({
						kind: 'workbench',
						storeId: detail.slug,
						version: tarVersion,
					});
					return {
						ok: true,
						changed: tar.changed,
						version: tarVersion,
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
				// ★ 记账：工作台装进 dsh profile（不是数据根目录）⇒ `download()` 那条链覆盖不到
				//   ⇒ 不显式记一笔，「已安装」页签与升级检查都看不到它 ✗ ✓。
				const installedVersion = installResult.version ?? targetVersion;
				await marketplace.recordInstalled({
					kind: 'workbench',
					storeId: detail.slug,
					version: installedVersion,
				});
				return {
					ok: true,
					changed: installResult.changed,
					version: installedVersion,
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
				if (!r.ok) {
					return { ok: false, error: r.error ?? '卸载失败' };
				}
				// ★ 插件卸了 ⇒ 台账也要清（否则「已安装」页签还挂着它 ✗）✓
				await marketplace.forgetInstalled('workbench', req.slug);
				return { ok: true, changed: true };
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
