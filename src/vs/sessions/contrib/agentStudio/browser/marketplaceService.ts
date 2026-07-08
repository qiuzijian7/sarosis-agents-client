/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MarketplaceService 实现 —— 对接 VsSaros 商城服务端。
 *
 * HTTP 通过 IRequestService（无 CORS）。tar 打包/解压需要 Node.js 环境。
 * 四类资源的差异化安装/打包委托给 IPackageInstallerRegistry（按 kind 分发）。
 * 已安装资源统一记录到 ~/.saros/installed-packages.json，供升级检查。
 *
 * 详见 doc/marketplace-integration-analysis.md（方案 A）。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import * as path from '../../../../base/common/path.js';
import {
	IMarketplaceService, IMarketplaceUser, IMarketplacePackage, IMarketplacePackageDetail,
	IUpgradeInfo, IUpgradeCheckItem, IInstallResult, IPublishOptions, IListPackagesOptions,
	PackageKind, MARKETPLACE_URL_SETTING,
} from '../common/marketplace.js';
import { IPackageInstallerRegistry, PackageManifest } from '../common/packageInstaller.js';
import { ITofAuthService } from '../common/tofAuth.js';

const TOKEN_KEY = 'saros.marketplace.token';
const USER_KEY = 'saros.marketplace.user';
const DEFAULT_ENDPOINT = 'http://21.6.92.5:3040';
const INSTALLED_FILE = 'installed-packages.json';

/** installed-packages.json 条目 */
interface IInstalledEntry {
	kind: PackageKind;
	storeId: string;
	version: string;
	installedAt: string;
}

/** 各 kind 的本地安装子目录（回退用，installer 注册后由 installer 决定） */
const KIND_SUBDIR: Record<PackageKind, string> = {
	agent: 'agents',
	skill: 'skills',
	mcp: 'mcp',
	knowledge: 'knowledge-base',
	workflow: 'workflows',
};

export class MarketplaceService extends Disposable implements IMarketplaceService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeLogin = this._register(new Emitter<void>());
	readonly onDidChangeLogin: Event<void> = this._onDidChangeLogin.event;

	private _user: IMarketplaceUser | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@IPathService private readonly pathService: IPathService,
		@IPackageInstallerRegistry private readonly installerRegistry: IPackageInstallerRegistry,
		@ITofAuthService private readonly tofAuthService: ITofAuthService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.logService.info('[Marketplace] Constructor: 初始化开始');

		const userJson = this.storageService.get(USER_KEY, StorageScope.APPLICATION);
		if (userJson) {
			try {
				this._user = JSON.parse(userJson);
				this.logService.info(`[Marketplace] Constructor: 从 storage 恢复用户: ${this._user?.username}`);
			} catch { /* ignore */ }
		} else {
			this.logService.info('[Marketplace] Constructor: storage 中无用户信息');
		}

		const tofUser = this.tofAuthService.currentUser;
		const tofTicket = this.tofAuthService.currentTicket;
		this.logService.info(`[Marketplace] Constructor: TOF currentUser=${tofUser?.login_name ?? 'null'}, ticket=${tofTicket ? '有' : '无'}`);

		// ── 监听 TOF 登录态变化，自动同步商城登录 ──
		this._register(this.tofAuthService.onDidChangeUser(user => {
			this.logService.info(`[Marketplace] onDidChangeUser: user=${user?.login_name ?? 'null'}`);
			if (user) {
				// TOF 用户登录/恢复 → 自动登录商城
				this._syncTofLogin().catch(err => {
					this.logService.warn('[Marketplace] TOF 自动登录失败:', err);
				});
			} else {
				// TOF 用户登出 → 清除商城登录态
				this.logout();
			}
		}));

		// ── 启动时检查 TOF 是否已登录（Delayed 实例化可能错过 onDidChangeUser 事件）──
		if (tofUser && tofTicket) {
			this.logService.info(`[Marketplace] Constructor: TOF 已登录 (${tofUser.login_name})，检查是否需要同步`);
			if (!this._user || this._user.username !== tofUser.login_name) {
				this.logService.info('[Marketplace] Constructor: 商城未登录或用户名不一致，触发同步');
				this._syncTofLogin().catch(err => {
					this.logService.warn('[Marketplace] 启动时 TOF 同步失败:', err);
				});
			} else {
				this.logService.info('[Marketplace] Constructor: 商城已登录且用户名一致，跳过同步');
			}
		} else {
			this.logService.info('[Marketplace] Constructor: TOF 未登录，等待 onDidChangeUser 事件');
		}
	}

	get endpoint(): string {
		return this.configService.getValue<string>(MARKETPLACE_URL_SETTING) || DEFAULT_ENDPOINT;
	}

	// ── 认证 ──────────────────────────────────────────────────
	isLoggedIn(): boolean { return !!this._user; }
	getCurrentUser(): IMarketplaceUser | undefined { return this._user; }

	async login(username: string, password: string): Promise<void> {
		const res = await this.api<{ token: string; user: any }>('POST', '/auth/login', { username, password });
		this.storageService.store(TOKEN_KEY, res.token, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._user = {
			id: res.user.id, username: res.user.username,
			displayName: res.user.display_name ?? undefined, role: res.user.role,
			avatarUrl: res.user.avatar_url ?? undefined,
		};
		this.storageService.store(USER_KEY, JSON.stringify(this._user), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChangeLogin.fire();
		this.logService.info(`[Marketplace] 登录成功: ${username}`);
	}

	logout(): void {
		this.storageService.remove(TOKEN_KEY, StorageScope.APPLICATION);
		this.storageService.remove(USER_KEY, StorageScope.APPLICATION);
		this._user = undefined;
		this._onDidChangeLogin.fire();
	}

	/**
	 * 用 TOF 票据登录商城（复用 VsSaros 登录态）。
	 * 用 x-tai-identity ticket 调 /auth/tof，服务端验证后返回商城 JWT。
	 * 通过扩展宿主代理请求，绕过渲染进程 CORS 限制。
	 */
	async loginWithTof(): Promise<void> {
		const ticket = this.tofAuthService.currentTicket;
		if (!ticket) {
			this.logService.warn('[Marketplace] loginWithTof: currentTicket 为空');
			throw new Error('未找到 TOF 登录票据，请先登录 VsSaros');
		}
		const tofUser = this.tofAuthService.currentUser;
		const url = `${this.endpoint}/api/v1/auth/tof`;
		// 同时发送 ticket + 用户信息（服务端网关不可达时作为 fallback）
		const body = JSON.stringify({
			ticket,
			loginName: tofUser?.login_name,
			staffId: tofUser?.staff_id,
			isAdmin: tofUser?.is_admin ?? false,
		});
		this.logService.info(`[Marketplace] loginWithTof: 调用代理请求 POST ${url}, ticket 长度=${ticket.length}, user=${tofUser?.login_name ?? 'null'}`);

		// 使用扩展宿主代理请求（Node.js 环境，无 CORS 限制）
		const resp = await this.commandService.executeCommand<{
			statusCode: number; body: string; headers: Record<string, string>;
		}>('marketplace.proxyRequest', {
			url, method: 'POST', body,
			headers: { 'Content-Type': 'application/json' },
		});

		this.logService.info(`[Marketplace] loginWithTof: 代理响应 statusCode=${resp?.statusCode}, body 长度=${resp?.body?.length ?? 0}`);

		if (!resp || resp.statusCode >= 400) {
			const errMsg = resp ? (JSON.parse(resp.body || '{}').error || `HTTP ${resp.statusCode}`) : '代理请求无响应';
			this.logService.error(`[Marketplace] loginWithTof: 登录失败 - ${errMsg}`);
			throw new Error(`TOF 登录失败: ${errMsg}`);
		}
		const res = JSON.parse(resp.body) as { token: string; user: any; tofUser?: { staff_id: string; team: string | null } };
		this.storageService.store(TOKEN_KEY, res.token, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._user = {
			id: res.user.id, username: res.user.username,
			displayName: res.user.display_name ?? undefined, role: res.user.role,
			avatarUrl: res.user.avatar_url ?? undefined,
		};
		this.storageService.store(USER_KEY, JSON.stringify(this._user), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChangeLogin.fire();
		this.logService.info(`[Marketplace] loginWithTof: 登录成功 user=${res.user.username}, fire onDidChangeLogin`);
	}

	/**
	 * 同步 TOF 登录态到商城（内部方法）。
	 * 当 TOF 用户变化时自动调用，静默处理失败。
	 */
	private async _syncTofLogin(): Promise<void> {
		// 已登录且用户名一致则跳过
		const tofUser = this.tofAuthService.currentUser;
		if (!tofUser) {
			this.logService.info('[Marketplace] _syncTofLogin: TOF currentUser 为空，跳过');
			return;
		}
		if (this._user && this._user.username === tofUser.login_name) {
			this.logService.info(`[Marketplace] _syncTofLogin: 已登录 (${this._user.username})，跳过`);
			return;
		}
		this.logService.info(`[Marketplace] _syncTofLogin: 需要同步, tofUser=${tofUser.login_name}, currentMarketplaceUser=${this._user?.username ?? 'null'}`);
		try {
			await this.loginWithTof();
		} catch (err) {
			this.logService.warn('[Marketplace] _syncTofLogin: 失败:', err);
		}
	}

	/**
	 * 确保已登录商城（下载/升级前调用）。
	 * 优先复用 TOF 登录态，未登录则尝试同步。
	 */
	private async _ensureLoggedIn(): Promise<void> {
		if (this._user && this.storageService.get(TOKEN_KEY, StorageScope.APPLICATION)) {
			return; // 已登录且有 token
		}
		// 尝试用 TOF 票据登录
		const tofUser = this.tofAuthService.currentUser;
		const ticket = this.tofAuthService.currentTicket;
		if (tofUser && ticket) {
			await this.loginWithTof();
			return;
		}
		throw new Error('未登录商城，请先在 VsSaros 中完成 TOF 登录');
	}

	// ── 浏览 ──────────────────────────────────────────────────
	async listPackages(opts: IListPackagesOptions = {}): Promise<{ items: readonly IMarketplacePackage[]; total: number }> {
		const qs = new URLSearchParams();
		if (opts.kind) { qs.set('kind', opts.kind); }
		if (opts.q) { qs.set('q', opts.q); }
		if (opts.category) { qs.set('category', opts.category); }
		if (opts.page) { qs.set('page', String(opts.page)); }
		if (opts.pageSize) { qs.set('pageSize', String(opts.pageSize)); }
		if (opts.sort) { qs.set('sort', opts.sort); }
		const res = await this.api<{ items: any[]; total: number }>('GET', `/packages?${qs.toString()}`);
		return { items: res.items.map(mapPackage), total: res.total };
	}

	async getPackage(slug: string): Promise<IMarketplacePackageDetail> {
		const res = await this.api<any>('GET', `/packages/${slug}`);
		return {
			...mapPackage(res),
			author: res.author ? { id: res.author.id, username: res.author.username, displayName: res.author.display_name ?? undefined } : undefined,
			versions: (res.versions ?? []).map((v: any) => ({
				id: v.id, version: v.version, changelog: v.changelog ?? undefined,
				sha256: v.sha256, size: v.asset_size, isLatest: Boolean(v.is_latest), createdAt: v.created_at,
				manifest: v.manifest,
			})),
		};
	}

	// ── 下载安装 ──────────────────────────────────────────────
	async download(storeId: string, version: string, kind: PackageKind): Promise<IInstallResult> {
		this.logService.info(`[Marketplace] 下载 ${kind}/${storeId} v${version}`);

		// 确保已登录（复用 TOF 登录态）
		await this._ensureLoggedIn();

		// MCP 特殊路径：MCP 只是配置（transport/url/command/env），不需要下载和解压 tar.gz
		// 直接从 API 获取 manifest（含 MCP 配置），写入本地 config.json + 注册到 mcp.json
		if (kind === 'mcp') {
			return this._installMcpFromApi(storeId, version);
		}

		// 确保已登录（复用 TOF 登录态）
		await this._ensureLoggedIn();

		const url = `${this.endpoint}/api/v1/packages/${storeId}/versions/${version}/download`;

		// 1. 准备临时目录
		const userHome = await this.pathService.userHome();
		const tmpBase = path.join(userHome.fsPath, '.saros', 'tmp');
		await this.fileService.createFolder(URI.file(tmpBase));

		const tmpFile = path.join(tmpBase, `saros-dl-${Date.now()}.tar.gz`);
		const extractDir = path.join(tmpBase, `saros-extract-${Date.now()}`);

		// 2. 流式下载 tar.gz 到临时文件（通过扩展宿主，不经 IPC 传二进制）
		const token = this.storageService.get(TOKEN_KEY, StorageScope.APPLICATION);
		const headers: Record<string, string> = {};
		if (token) { headers['Authorization'] = `Bearer ${token}`; }
		const dlResp = await this.commandService.executeCommand<{ statusCode: number }>(
			'marketplace.downloadToFile', { url, headers, savePath: tmpFile }
		);
		if (!dlResp || dlResp.statusCode >= 400) {
			throw new Error(`下载失败: HTTP ${dlResp?.statusCode || '无响应'}`);
		}

		try {
			// 3. 解压 tar.gz（通过扩展宿主执行 tar 命令）
			await this.execTar(['-xzf', tmpFile, '-C', extractDir]);
		} catch (err) {
			throw new Error(`解压失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			try { await this.fileService.del(URI.file(tmpFile)); } catch { /* ignore */ }
		}

		// 3. 读 manifest
		const manifestPath = path.join(extractDir, 'manifest.json');
		let manifest: PackageManifest;
		try {
			const content = await this.fileService.readFile(URI.file(manifestPath));
			manifest = JSON.parse(content.value.toString());
		} catch {
			throw new Error('包内缺少 manifest.json');
		}

		// 4. 委托 installer 安装；无 installer 则回退到通用解压
		let result: IInstallResult;
		// 防御性检查：manifest 包含 mcp 配置（即使 kind 被错分类为 skill 等）→ 走 MCP 路径
		// 解决：商城把 MCP 包错误注册为 skill 类型时，SkillInstaller 会报"包内缺少 SKILL.md"
		const isMcpByManifest = !!(manifest as any).mcp || !!(manifest as any).config;
		if (isMcpByManifest) {
			this.logService.info(`[Marketplace] manifest 含 mcp/config 字段，按 MCP 路径安装（kind=${kind} → mcp）`);
			result = await this._installMcpFromManifest(storeId, version, manifest);
		} else {
			const installer = this.installerRegistry.get(kind);
			try {
				if (installer) {
					result = await installer.install(manifest, URI.file(extractDir), { force: true });
				} else {
					// 回退：直接解压到 ~/.saros/{subdir}/{id}/
					const targetDir = await this.resolveInstallDir(kind, storeId);
					await this.fileService.createFolder(targetDir);
					result = { kind, storeId, version, targetDir: targetDir.fsPath };
					this.logService.warn(`[Marketplace] 无 ${kind} installer，回退通用解压到 ${targetDir.fsPath}`);
				}
			} catch (installErr) {
				// 安装失败：回滚临时解压目录
				try { await this.fileService.del(URI.file(extractDir), { recursive: true }); } catch { /* ignore */ }
				throw installErr;
			}
		}

		// 5. 清理临时目录 + 记录已安装
		try { await this.fileService.del(URI.file(extractDir), { recursive: true }); } catch { /* ignore */ }
		// 记录已安装时使用 result.kind（而非参数 kind），解决商城 API 把 MCP 包错误标记为 skill 的情况
		const installedKind = result.kind;
		await this.upsertInstalled({ kind: installedKind, storeId, version: result.version, installedAt: new Date().toISOString() });

		this.logService.info(`[Marketplace] 安装完成: ${installedKind}/${storeId} v${result.version}`);
		return result;
	}

	/**
	 * MCP 专用安装：直接从 API 获取配置，无需下载和解压 tar.gz。
	 * MCP 本质上是连接配置（transport/url/command/env），不需要二进制文件。
	 */
	private async _installMcpFromApi(storeId: string, version: string): Promise<IInstallResult> {
		this.logService.info(`[Marketplace] MCP 直接安装: ${storeId} v${version}`);

		// 1. 获取包详情（含版本 manifest）
		const detail = await this.getPackage(storeId);
		const ver = detail.versions.find(v => v.version === version) || detail.versions.find(v => v.isLatest);
		if (!ver || !ver.manifest) {
			throw new Error('未找到版本或 manifest 信息');
		}

		return this._installMcpFromManifest(storeId, ver.version, ver.manifest);
	}

	/**
	 * 从 manifest 安装 MCP（已被 _installMcpFromApi 和 download fallback 共用）。
	 * 处理 manifest.mcp 或整个 manifest 即为 mcp config 的情况。
	 */
	private async _installMcpFromManifest(storeId: string, version: string, manifest: any): Promise<IInstallResult> {
		const mcpConfig = manifest.mcp || manifest; // manifest.mcp 或 manifest 本身
		const actualVersion = version;

		// 2. 写入 ~/.saros/mcp/{storeId}/
		const userHome = await this.pathService.userHome();
		const targetDir = URI.joinPath(userHome, '.saros', 'mcp', storeId);
		await this.fileService.createFolder(targetDir);

		// config.json（MCP 连接配置）
		const configJson = {
			id: storeId,
			name: manifest.name || mcpConfig.name || storeId,
			description: manifest.description || mcpConfig.description || '',
			transport: mcpConfig.transport || 'http',
			command: mcpConfig.command,
			args: mcpConfig.args,
			url: mcpConfig.url,
			env: mcpConfig.env || mcpConfig.headers,
			version: actualVersion,
		};
		await this.fileService.writeFile(
			URI.joinPath(targetDir, 'config.json'),
			VSBuffer.fromString(JSON.stringify(configJson, null, 2))
		);

		// manifest.json（包元数据）
		await this.fileService.writeFile(
			URI.joinPath(targetDir, 'manifest.json'),
			VSBuffer.fromString(JSON.stringify(manifest, null, 2))
		);

		// 3. 注册到 ~/.saros/mcp.json（IntegrationView 白名单）
		await this._registerMcpToConfig(storeId, configJson);

		// 4. 记录已安装
		await this.upsertInstalled({ kind: 'mcp', storeId, version: actualVersion, installedAt: new Date().toISOString() });

		this.logService.info(`[Marketplace] MCP 安装完成: ${storeId} v${actualVersion} → ${targetDir.fsPath}`);
		this.logService.info(`[Marketplace] 已注册到 ~/.saros/mcp.json`);

		return { kind: 'mcp', storeId, version: actualVersion, targetDir: targetDir.fsPath };
	}

	/** 将 MCP 配置注册到 ~/.saros/mcp.json */
	private async _registerMcpToConfig(serverId: string, config: any): Promise<void> {
		const userHome = await this.pathService.userHome();
		const mcpJsonUri = URI.joinPath(userHome, '.saros', 'mcp.json');

		// 读取现有配置
		let mcpConfig: { servers: Record<string, any> } = { servers: {} };
		try {
			if (await this.fileService.exists(mcpJsonUri)) {
				const raw = await this.fileService.readFile(mcpJsonUri);
				mcpConfig = JSON.parse(raw.value.toString());
				if (!mcpConfig.servers) { mcpConfig.servers = {}; }
			}
		} catch { /* 文件不存在或解析失败 */ }

		// 转换为 mcp.json 格式
		const transport = config.transport || 'stdio';
		const entry: Record<string, unknown> = { disabled: false };
		if (transport === 'stdio') {
			entry.type = 'stdio';
			if (config.command) { entry.command = config.command; }
			if (config.args) { entry.args = config.args; }
			if (config.env) { entry.env = config.env; }
		} else {
			entry.type = transport;
			if (config.url) { entry.url = config.url; }
			if (config.env) { entry.headers = config.env; }
		}

		mcpConfig.servers[serverId] = entry;

		// 写回
		await this.fileService.createFolder(URI.joinPath(mcpJsonUri, '..'));
		await this.fileService.writeFile(mcpJsonUri, VSBuffer.fromString(JSON.stringify(mcpConfig, null, 2)));
	}

	// ── 上传发布 ──────────────────────────────────────────────
	async publish(localId: string, kind: PackageKind, opts: IPublishOptions = {}): Promise<{ version: string }> {
		this.logService.info(`[Marketplace] 发布 ${kind}/${localId}`);

		// 确保已登录
		await this._ensureLoggedIn();

		const installer = this.installerRegistry.get(kind);
		if (!installer) {
			throw new Error(`不支持发布 ${kind} 类型资源（未注册 installer）`);
		}

		// 1. 准备本地资源目录 + manifest
		const { localDir, manifest } = await installer.preparePack(localId);

		// Apply user-provided overrides to manifest
		const finalManifest: Record<string, unknown> = {
			...manifest,
			name: opts.name || manifest.name,
			version: opts.version || manifest.version,
			description: opts.description ?? manifest.description,
			category: opts.category ?? manifest.category,
			author: opts.author ?? manifest.author,
		};
		// Inject skillRefs/mcpRefs if provided
		if (kind === 'agent') {
			if (opts.skillRefs?.length) { finalManifest.skillRefs = opts.skillRefs; }
			if (opts.mcpRefs?.length) { finalManifest.mcpRefs = opts.mcpRefs; }
		}
		const version = finalManifest.version;

		// 1.5 预检：如果服务器已有同版本，拒绝上传；如果包不存在，先创建
		let packageExists = false;
		try {
			const existing = await this.getPackage(localId);
			packageExists = true;
			if (existing.latestVersion === version) {
				throw new Error(`版本 v${version} 已存在于商城，请递增版本号后重试`);
			}
		} catch (err) {
			// 版本冲突错误直接抛出
			if (err instanceof Error && err.message.includes('已存在于商城')) {
				throw err;
			}
			// 404 = 包不存在，需要先创建
			if (!packageExists) {
				try {
					await this.api('POST', '/packages', {
						slug: localId,
						name: finalManifest.name,
						kind: finalManifest.kind,
						description: finalManifest.description ?? '',
						category: finalManifest.category ?? 'other',
					});
					this.logService.info(`[Marketplace] 已创建新包: ${localId}`);
				} catch (createErr) {
					const msg = createErr instanceof Error ? createErr.message : String(createErr);
					// 服务端校验失败（slug 冲突/格式非法等）→ 直接抛出让客户端处理
					if (/slug|conflict|already exists|409|conflict/i.test(msg)) {
						throw createErr;
					}
					// 其他错误（网络抖动/并发创建）→ 忽略，继续上传
					this.logService.info(`[Marketplace] 创建包跳过: ${msg}`);
				}
			}
		}

		// 2. tar 打包（包含 manifest.json）
		const userHome = await this.pathService.userHome();
		const tmpBase = path.join(userHome.fsPath, '.saros', 'tmp');
		await this.fileService.createFolder(URI.file(tmpBase));

		// 2.1 将 manifest.json 写入技能目录（临时，打包后删除）
		const manifestFile = URI.joinPath(localDir, 'manifest.json');
		const hadManifestBefore = await this.fileService.exists(manifestFile);
		await this.fileService.writeFile(manifestFile, VSBuffer.fromString(JSON.stringify(finalManifest, null, 2)));

		const tmpFile = path.join(tmpBase, `saros-pub-${Date.now()}.tar.gz`);
		try {
			await this.execTar(['-czf', tmpFile, '-C', localDir.fsPath, '.']);
		} catch (err) {
			throw new Error(`打包失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			// 清理临时 manifest.json（如果之前不存在的话）
			if (!hadManifestBefore) {
				try { await this.fileService.del(manifestFile); } catch { /* ignore */ }
			}
		}

		// 3. 流式上传 tar.gz（通过扩展宿主，不经 IPC 传二进制）
		const url = `${this.endpoint}/api/v1/packages/${localId}/versions/raw`;
		const headers: Record<string, string> = {
			'Content-Type': 'application/x-gzip',
			'x-changelog': encodeURIComponent(opts.changelog ?? ''),
		};
		const token = this.storageService.get(TOKEN_KEY, StorageScope.APPLICATION);
		if (token) { headers['Authorization'] = `Bearer ${token}`; }

		const { statusCode, text } = await this.commandService.executeCommand<{ statusCode: number; text: string }>(
			'marketplace.uploadFromFile', { url, filePath: tmpFile, headers }
		) ?? { statusCode: 0, text: '' };

		// 删除临时 tar 文件
		try { await this.fileService.del(URI.file(tmpFile)); } catch { /* ignore */ }
		if (statusCode >= 400) {
			const err = text ? (JSON.parse(text).error || text) : `HTTP ${statusCode}`;
			throw new Error(`发布失败: ${err}`);
		}
		const result = text ? JSON.parse(text) : {};
		const publishedVersion = result.version || version;

		// 4. 记录已安装
		await this.upsertInstalled({ kind, storeId: localId, version: publishedVersion, installedAt: new Date().toISOString() });

		// 4.5 同步本地 SKILL.md 的版本号，避免上传后显示"升级"按钮
		const skillMdUri = URI.joinPath(localDir, 'SKILL.md');
		if (await this.fileService.exists(skillMdUri)) {
			try {
				const mdContent = (await this.fileService.readFile(skillMdUri)).value.toString();
				// Replace version in YAML frontmatter
				const updated = mdContent.replace(
					/(\n\s*version\s*:\s*).+/,
					`$1${publishedVersion}`
				);
				if (updated !== mdContent) {
					await this.fileService.writeFile(skillMdUri, VSBuffer.fromString(updated));
					this.logService.info(`[Marketplace] 同步本地 SKILL.md 版本: ${publishedVersion}`);
				}
			} catch { /* non-critical */ }
		}

		this.logService.info(`[Marketplace] 发布成功: v${publishedVersion}`);
		return { version: publishedVersion };
	}

	// ── 升级检查 ──────────────────────────────────────────────
	async checkUpgrades(items?: readonly IUpgradeCheckItem[]): Promise<readonly IUpgradeInfo[]> {
		// 确保已登录
		await this._ensureLoggedIn();

		// 未传 items 时，从 installed-packages.json 统一读取
		const checkItems = items ?? await this.readInstalled();
		const res = await this.api<{ updates: any[] }>('POST', '/upgrade/check', { items: checkItems });
		return res.updates.map((u: any) => ({
			kind: u.kind as PackageKind, storeId: u.storeId, current: u.current, latest: u.latest,
			changelog: u.changelog ?? undefined, downloadUrl: u.downloadUrl, sha256: u.sha256, size: u.size,
		}));
	}

	// ── 内部：HTTP ────────────────────────────────────────────
	private get apiBase(): string { return `${this.endpoint}/api/v1`; }

	private async api<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = {};
		let data: string | undefined;
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
			data = JSON.stringify(body);
		}
		const token = this.storageService.get(TOKEN_KEY, StorageScope.APPLICATION);
		if (token) { headers['Authorization'] = `Bearer ${token}`; }

		const url = `${this.apiBase}${urlPath}`;
		// 使用扩展宿主代理请求，绕过渲染进程 CORS 限制
		const resp = await this.commandService.executeCommand<{
			statusCode: number; body: string;
		}>('marketplace.proxyRequest', { url, method, body: data, headers });

		if (!resp) {
			throw new Error('代理请求无响应（marketplace.proxyRequest 命令未注册或扩展未激活）');
		}
		if (resp.statusCode >= 400) {
			let msg = `HTTP ${resp.statusCode}`;
			try { msg = resp.body ? JSON.parse(resp.body).error || msg : msg; } catch { /* ignore */ }
			throw new Error(msg);
		}
		return resp.body ? JSON.parse(resp.body) as T : (undefined as T);
	}

	/** 安全地执行 tar 命令（仅在支持 require 的 Node 环境中可用） */
	private async execTar(args: string[]): Promise<void> {
		// Route tar operations through the extension host (Node.js environment)
		// via commands registered in tof-authentication extension
		if (args[0] === '-xzf') {
			// Extract: tar -xzf <tarFile> -C <extractDir>
			const tarFile = args[1];
			const extractDir = args[args.indexOf('-C') + 1];
			await this.commandService.executeCommand('marketplace.extractTar', { tarFile, extractDir });
		} else if (args[0] === '-czf') {
			// Compress: tar -czf <outputFile> -C <sourceDir> .
			const outputFile = args[1];
			const sourceDir = args[args.indexOf('-C') + 1];
			await this.commandService.executeCommand('marketplace.createTar', { sourceDir, outputFile });
		} else {
			throw new Error(`[Marketplace] Unsupported tar args: ${args.join(' ')}`);
		}
	}



	// ── 卸载 ──────────────────────────────────────────────
	async uninstall(storeId: string, kind: PackageKind): Promise<void> {
		this.logService.info(`[Marketplace] 卸载 ${kind}/${storeId}`);

		// 1. 删除安装目录
		const installDir = await this.resolveInstallDir(kind, storeId);
		if (await this.fileService.exists(installDir)) {
			await this.fileService.del(installDir, { recursive: true });
		}
		// agent 可能安装在 agents/custom/{id} 子目录（installer 路径）
		if (kind === 'agent') {
			const customDir = URI.joinPath(await this.pathService.userHome(), '.saros', 'agents', 'custom', storeId);
			if (await this.fileService.exists(customDir)) {
				await this.fileService.del(customDir, { recursive: true });
			}
			// Also clean up the unified agent directory ~/.saros/agents/{agentId}/
			const agentDir = URI.joinPath(await this.pathService.userHome(), '.saros', 'agents', storeId);
			if (await this.fileService.exists(agentDir)) {
				await this.fileService.del(agentDir, { recursive: true });
			}
		}

		// 2. 从 installed-packages.json 中移除
		await this.removeInstalled(kind, storeId);

		this.logService.info(`[Marketplace] 卸载完成: ${kind}/${storeId}`);
	}

	async getInstalled(): Promise<readonly { kind: PackageKind; storeId: string; version: string }[]> {
		return this.readInstalled();
	}

	// ── 内部：installed-packages.json ─────────────────────────
	private async getInstalledFileUri(): Promise<URI> {
		const userHome = await this.pathService.userHome();
		return URI.joinPath(userHome, '.saros', INSTALLED_FILE);
	}

	private async readInstalled(): Promise<IUpgradeCheckItem[]> {
		try {
			const installedFileUri = await this.getInstalledFileUri();
			if (!await this.fileService.exists(installedFileUri)) {
				return [];
			}
			const content = await this.fileService.readFile(installedFileUri);
			const entries: IInstalledEntry[] = JSON.parse(content.value.toString());
			return entries.map(e => ({ kind: e.kind, storeId: e.storeId, version: e.version }));
		} catch {
			return [];
		}
	}

	private async upsertInstalled(entry: IInstalledEntry): Promise<void> {
		let entries: IInstalledEntry[] = [];
		const installedFileUri = await this.getInstalledFileUri();
		try {
			if (await this.fileService.exists(installedFileUri)) {
				const content = await this.fileService.readFile(installedFileUri);
				entries = JSON.parse(content.value.toString());
			}
		} catch { /* ignore */ }
		// 按 kind+storeId 去重更新
		entries = entries.filter(e => !(e.kind === entry.kind && e.storeId === entry.storeId));
		entries.push(entry);
		await this.fileService.createFolder(URI.joinPath(installedFileUri, '..'));
		await this.fileService.writeFile(installedFileUri, VSBuffer.fromString(JSON.stringify(entries, null, 2)));
	}

	private async removeInstalled(kind: PackageKind, storeId: string): Promise<void> {
		const installedFileUri = await this.getInstalledFileUri();
		try {
			if (!await this.fileService.exists(installedFileUri)) { return; }
			const content = await this.fileService.readFile(installedFileUri);
			const entries: IInstalledEntry[] = JSON.parse(content.value.toString());
			const filtered = entries.filter(e => !(e.kind === kind && e.storeId === storeId));
			if (filtered.length === entries.length) { return; }
			await this.fileService.writeFile(installedFileUri, VSBuffer.fromString(JSON.stringify(filtered, null, 2)));
		} catch { /* ignore */ }
	}

	// ── 内部：目录解析（回退用）──────────────────────────────
	private async resolveInstallDir(kind: PackageKind, id: string): Promise<URI> {
		const userHome = await this.pathService.userHome();
		return URI.joinPath(userHome, '.saros', KIND_SUBDIR[kind], id);
	}
}

function mapPackage(p: any): IMarketplacePackage {
	return {
		id: p.id, kind: p.kind as PackageKind, slug: p.slug, name: p.name,
		description: p.description ?? undefined, category: p.category ?? undefined, icon: p.icon ?? undefined,
		visibility: p.visibility, tags: p.tags ?? [],
		latestVersion: p.latest_version ?? undefined, downloads: p.downloads ?? p.downloadCount,
		useGuide: p.use_guide ?? p.useGuide ?? undefined,
		authorName: p.author ?? (p.author_info?.username ?? p.author_info?.display_name) ?? undefined,
		updatedAt: p.updated_at ?? p.updatedAt ?? undefined,
		versions: p.versions ? p.versions.map((v: any) => ({
			id: v.id, version: v.version, changelog: v.changelog ?? undefined,
			sha256: v.sha256, size: v.asset_size ?? v.size, isLatest: Boolean(v.is_latest), createdAt: v.created_at ?? v.createdAt,
			manifest: v.manifest,
		})) : undefined,
	};
}
