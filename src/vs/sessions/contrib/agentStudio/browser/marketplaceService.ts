/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MarketplaceService 实现 —— 对接 Sarosis 商城服务端。
 *
 * HTTP 通过 IRequestService（无 CORS）。tar 打包/解压需要 Node.js 环境。
 * 四类资源的差异化安装/打包委托给 IPackageInstallerRegistry（按 kind 分发）。
 * 已安装资源统一记录到 ~/.saros/installed-packages.json，供升级检查。
 *
 * 详见 doc/marketplace-integration-analysis.md（方案 A）。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer, streamToBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService, asText } from '../../../../platform/request/common/request.js';
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
	agent: path.join('agents', 'custom'),
	skill: 'skills-library',
	mcp: 'mcp-servers',
	knowledge: 'knowledge-base',
};

export class MarketplaceService extends Disposable implements IMarketplaceService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeLogin = this._register(new Emitter<void>());
	readonly onDidChangeLogin: Event<void> = this._onDidChangeLogin.event;

	private _user: IMarketplaceUser | undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@IPathService private readonly pathService: IPathService,
		@IPackageInstallerRegistry private readonly installerRegistry: IPackageInstallerRegistry,
	) {
		super();
		const userJson = this.storageService.get(USER_KEY, StorageScope.APPLICATION);
		if (userJson) {
			try { this._user = JSON.parse(userJson); } catch { /* ignore */ }
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
			})),
		};
	}

	// ── 下载安装 ──────────────────────────────────────────────
	async download(storeId: string, version: string, kind: PackageKind): Promise<IInstallResult> {
		this.logService.info(`[Marketplace] 下载 ${kind}/${storeId} v${version}`);
		const url = `${this.endpoint}/api/v1/packages/${storeId}/versions/${version}/download`;

		// 1. 下载 tar.gz
		const ctx = await this.requestService.request({ type: 'GET', url, callSite: 'marketplaceService.download' }, CancellationToken.None);
		if (ctx.res.statusCode && ctx.res.statusCode >= 400) {
			throw new Error(`下载失败: HTTP ${ctx.res.statusCode}`);
		}
		const buffer = await streamToBuffer(ctx.stream);

		// 2. 准备临时目录
		const userHome = await this.pathService.userHome();
		const tmpBase = path.join(userHome.fsPath, '.saros', 'tmp');
		await this.fileService.createFolder(URI.file(tmpBase));

		const tmpFile = path.join(tmpBase, `saros-dl-${Date.now()}.tar.gz`);
		const extractDir = path.join(tmpBase, `saros-extract-${Date.now()}`);

		// 写入临时文件
		await this.fileService.writeFile(URI.file(tmpFile), buffer);

		try {
			// 解压 tar.gz（需要 child_process，在浏览器环境中不可用）
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
		const installer = this.installerRegistry.get(kind);
		if (installer) {
			result = await installer.install(manifest, URI.file(extractDir));
		} else {
			// 回退：直接解压到 ~/.saros/{subdir}/{id}/
			const targetDir = await this.resolveInstallDir(kind, storeId);
			await this.fileService.createFolder(targetDir);
			result = { kind, storeId, version, targetDir: targetDir.fsPath };
			this.logService.warn(`[Marketplace] 无 ${kind} installer，回退通用解压到 ${targetDir.fsPath}`);
		}

		// 5. 清理临时目录 + 记录已安装
		try { await this.fileService.del(URI.file(extractDir), { recursive: true }); } catch { /* ignore */ }
		await this.upsertInstalled({ kind, storeId, version, installedAt: new Date().toISOString() });

		this.logService.info(`[Marketplace] 安装完成: ${kind}/${storeId} v${version}`);
		return result;
	}

	// ── 上传发布 ──────────────────────────────────────────────
	async publish(localId: string, kind: PackageKind, opts: IPublishOptions = {}): Promise<{ version: string }> {
		this.logService.info(`[Marketplace] 发布 ${kind}/${localId}`);

		const installer = this.installerRegistry.get(kind);
		if (!installer) {
			throw new Error(`不支持发布 ${kind} 类型资源（未注册 installer）`);
		}

		// 1. 准备本地资源目录 + manifest
		const { localDir, manifest } = await installer.preparePack(localId);
		const version = opts.version || manifest.version;

		// 2. tar 打包
		const userHome = await this.pathService.userHome();
		const tmpBase = path.join(userHome.fsPath, '.saros', 'tmp');
		await this.fileService.createFolder(URI.file(tmpBase));

		const tmpFile = path.join(tmpBase, `saros-pub-${Date.now()}.tar.gz`);
		try {
			await this.execTar(['-czf', tmpFile, '-C', localDir.fsPath, '.']);
		} catch (err) {
			throw new Error(`打包失败: ${err instanceof Error ? err.message : String(err)}`);
		}

		const content = await this.fileService.readFile(URI.file(tmpFile));
		const tarBuffer = content.value;
		try { await this.fileService.del(URI.file(tmpFile)); } catch { /* ignore */ }

		// 3. raw 上传
		const url = `${this.endpoint}/api/v1/packages/${localId}/versions/raw`;
		const headers: Record<string, string> = {
			'Content-Type': 'application/x-gzip',
			'x-changelog': encodeURIComponent(opts.changelog ?? ''),
		};
		const token = this.storageService.get(TOKEN_KEY, StorageScope.APPLICATION);
		if (token) { headers['Authorization'] = `Bearer ${token}`; }

		const { statusCode, text } = await this.rawUpload(url, tarBuffer, headers);
		if (statusCode >= 400) {
			const err = text ? (JSON.parse(text).error || text) : `HTTP ${statusCode}`;
			throw new Error(`发布失败: ${err}`);
		}
		const result = text ? JSON.parse(text) : {};
		const publishedVersion = result.version || version;

		// 4. 记录已安装
		await this.upsertInstalled({ kind, storeId: localId, version: publishedVersion, installedAt: new Date().toISOString() });

		this.logService.info(`[Marketplace] 发布成功: v${publishedVersion}`);
		return { version: publishedVersion };
	}

	// ── 升级检查 ──────────────────────────────────────────────
	async checkUpgrades(items?: readonly IUpgradeCheckItem[]): Promise<readonly IUpgradeInfo[]> {
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
		const ctx = await this.requestService.request({
			type: method as any, url: `${this.apiBase}${urlPath}`, headers, data, callSite: 'marketplaceService.api',
		}, CancellationToken.None);
		const text = await asText(ctx);
		if (ctx.res.statusCode && ctx.res.statusCode >= 400) {
			let msg = `HTTP ${ctx.res.statusCode}`;
			try { msg = text ? JSON.parse(text).error || msg : msg; } catch { /* ignore */ }
			throw new Error(msg);
		}
		return text ? JSON.parse(text) as T : (undefined as T);
	}

	/** 安全地执行 tar 命令（仅在支持 require 的 Node 环境中可用） */
	private async execTar(args: string[]): Promise<void> {
		const g = globalThis as unknown as { require?: (module: string) => unknown };
		if (typeof g.require === 'function') {
			const cp = g.require('child_process') as typeof import('child_process');
			const { promisify } = g.require('util') as typeof import('util');
			await promisify(cp.execFile)('tar', args);
		} else {
			throw new Error('[Marketplace] tar 功能在浏览器环境中不可用，请在支持 Node.js 的环境中运行此功能。');
		}
	}

	/** 用 Node http/https 发送 raw binary body（IRequestService.data 仅支持 string，无法上传二进制） */
	private rawUpload(url: string, body: VSBuffer, headers: Record<string, string>): Promise<{ statusCode: number; text: string }> {
		return new Promise((resolve, reject) => {
			const g = globalThis as unknown as { require?: (module: string) => unknown };
			if (typeof g.require !== 'function') {
				reject(new Error('[Marketplace] rawUpload 需要 Node.js 环境'));
				return;
			}
			const http = g.require('http') as typeof import('http');
			const https = g.require('https') as typeof import('https');
			const lib = url.startsWith('https') ? https : http;
			// 将 VSBuffer 转换为 Node.js Buffer
			const nodeBuffer = Buffer.from(body.buffer);
			const req = lib.request(url, { method: 'POST', headers }, (res) => {
				let data = '';
				res.on('data', (chunk: Buffer) => data += chunk.toString());
				res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, text: data }));
			});
			req.on('error', reject);
			req.write(nodeBuffer);
			req.end();
		});
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
	};
}
