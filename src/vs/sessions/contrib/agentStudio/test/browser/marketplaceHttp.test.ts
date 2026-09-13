/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MarketplaceService 发布 / 下载的 **HTTP 链路**测试（2026-09-11 补齐）。
 *
 * 背景：审计发现发布与下载的核心路径（HTTP 上传/下载、打包、安装委托）**零测试覆盖** ——
 * 已有测试只覆盖纯函数（semver / author / manifest 组装）与 installer。
 *
 * 为什么不需要 mock server：`MarketplaceService` 的所有网络与 tar 操作都经
 * `commandService.executeCommand('marketplace.proxyRequest' | 'uploadFromFile' |
 * 'downloadToFile' | 'createTar' | 'extractTar')` 转发给扩展宿主（绕 CORS）——
 * 因此 mock `ICommandService` 即可完整观测/驱动整条链路。
 *
 * 覆盖：
 *   publish  — 未登录拦截 / 成功（URL+鉴权+changelog）/ **元数据随包上传（P0 端到端回归）**
 *              / 版本冲突提前拦截（不发上传请求）/ 上传 400 错误透传
 *   download — 成功（installer.install 收到 force:true）/ 缺 manifest / 下载 404
 */

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { MarketplaceService } from '../../browser/marketplaceService.js';
import type { PackageManifest } from '../../common/packageInstaller.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

interface ICommandCall { cmd: string; args: Record<string, unknown> }

class MockCommandService {
	readonly calls: ICommandCall[] = [];
	private readonly handlers = new Map<string, (args: Record<string, unknown>) => unknown>();

	on(cmd: string, handler: (args: Record<string, unknown>) => unknown): void {
		this.handlers.set(cmd, handler);
	}
	/** 某命令被调用的次数 */
	count(cmd: string): number {
		return this.calls.filter(c => c.cmd === cmd).length;
	}
	/** 某命令最后一次调用的参数 */
	lastArgs(cmd: string): Record<string, unknown> | undefined {
		for (let i = this.calls.length - 1; i >= 0; i--) {
			if (this.calls[i].cmd === cmd) { return this.calls[i].args; }
		}
		return undefined;
	}
	async executeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
		this.calls.push({ cmd, args: args ?? {} });
		const h = this.handlers.get(cmd);
		if (!h) { throw new Error(`[test] no handler registered for ${cmd}`); }
		return h(args ?? {}) as T;
	}
}

class MockFileService {
	private readonly files = new Map<string, string>();
	private readonly folders = new Set<string>();
	/** 所有写过的文件（含后来被删除的）——用于断言「包内 manifest 内容」 */
	readonly writeLog: Array<{ uri: string; content: string }> = [];

	seedFile(path: string, content: string): void { this.files.set(URI.file(path).toString(), content); }
	hasFile(path: string): boolean { return this.files.has(URI.file(path).toString()); }
	getFile(path: string): string | undefined { return this.files.get(URI.file(path).toString()); }

	async exists(uri: URI): Promise<boolean> {
		return this.files.has(uri.toString()) || this.folders.has(uri.toString());
	}
	async readFile(uri: URI): Promise<{ value: VSBuffer }> {
		const c = this.files.get(uri.toString());
		if (c === undefined) { throw new Error(`ENOENT: ${uri.toString()}`); }
		return { value: VSBuffer.fromString(c) };
	}
	async writeFile(uri: URI, content: VSBuffer): Promise<void> {
		const s = content.toString();
		this.files.set(uri.toString(), s);
		this.writeLog.push({ uri: uri.toString(), content: s });
	}
	async del(uri: URI): Promise<void> {
		this.files.delete(uri.toString());
		this.folders.delete(uri.toString());
	}
	async createFolder(uri: URI): Promise<void> { this.folders.add(uri.toString()); }
	async resolve(uri: URI): Promise<{ children: Array<{ isDirectory: boolean; resource: URI }> }> {
		const prefix = uri.toString();
		const children: Array<{ isDirectory: boolean; resource: URI }> = [];
		for (const f of this.folders) {
			if (f.startsWith(prefix + '/') && !f.slice(prefix.length + 1).includes('/')) {
				children.push({ isDirectory: true, resource: URI.parse(f) });
			}
		}
		return { children };
	}
}

class MockStorageService {
	// 注意：字段名不能叫 `store` —— IStorageService 的方法就叫 store(key, value)。
	private readonly map = new Map<string, string>();
	get(key: string): string | undefined { return this.map.get(key); }
	store(key: string, value: string): void { this.map.set(key, value); }
	remove(key: string): void { this.map.delete(key); }
	onDidChangeStorage(): { dispose(): void } { return { dispose() { /* noop */ } }; }
	/** 测试预置（登录态等） */
	seed(key: string, value: string): void { this.map.set(key, value); }
}

class MockConfigService {
	getValue<T>(_key: string): T | undefined { return undefined; }   // → 使用 DEFAULT_ENDPOINT
}

class MockEnvironmentService {
	get userRoamingDataHome(): URI { return URI.file('/test-root/.vssaros/User'); }
}

class MockTofAuthService {
	currentUser: { login_name: string } | undefined = undefined;
	currentTicket: string | undefined = undefined;
	onDidChangeUser(): { dispose(): void } { return { dispose() { /* noop */ } }; }
}

class MockLogService {
	info(_m: string, ..._a: unknown[]): void { /* noop */ }
	warn(_m: string, ..._a: unknown[]): void { /* noop */ }
	error(_m: string, ..._a: unknown[]): void { /* noop */ }
	debug(_m: string, ..._a: unknown[]): void { /* noop */ }
	trace(_m: string, ..._a: unknown[]): void { /* noop */ }
}

interface IInstallCall { manifest: PackageManifest; opts?: { force?: boolean } }

function makeInstaller(installCalls: IInstallCall[], localDir: URI, manifest: PackageManifest) {
	return {
		kind: 'workflow' as const,
		async preparePack(_localId: string) { return { localDir, manifest }; },
		async install(m: PackageManifest, _dir: URI, opts?: { force?: boolean }) {
			installCalls.push({ manifest: m, opts });
			return { kind: 'workflow' as const, storeId: m.id, version: m.version, targetDir: '/installed' };
		},
		async getInstalledVersion() { return undefined; },
	};
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_ENDPOINT = 'http://21.6.92.5:3040';

function makeBaseManifest(overrides: Partial<PackageManifest> = {}): PackageManifest {
	return {
		kind: 'workflow',
		id: 'wf-pub',
		name: 'Pub Test',
		version: '1.0.0',
		description: 'd',
		category: 'other',
		files: ['workflow.json'],
		...overrides,
	} as PackageManifest;
}

function setup(opts?: { loggedIn?: boolean; manifest?: PackageManifest }) {
	const command = new MockCommandService();
	const files = new MockFileService();
	const storage = new MockStorageService();
	const log = new MockLogService();
	const tof = new MockTofAuthService();
	const installCalls: IInstallCall[] = [];
	const localDir = URI.file('/tmp/pack');
	const manifest = opts?.manifest ?? makeBaseManifest();

	if (opts?.loggedIn !== false) {
		// 预置登录态：_user 从 USER_KEY 恢复 + TOKEN_KEY 存在（TOF 未登录时走
		// `_ensureLoggedIn` 的「沿用已有商城会话」分支）。
		storage.seed('saros.marketplace.user', JSON.stringify({ id: '1', username: 'tester', role: 'user' }));
		storage.seed('saros.marketplace.token', 'tok-123');
	}
	const installer = makeInstaller(installCalls, localDir, manifest);
	const registry = { get: (k: string) => (k === 'workflow' ? installer : undefined) };

	const service = new MarketplaceService(
		files as never, log as never, storage as never, new MockConfigService() as never,
		new MockEnvironmentService() as never, registry as never, tof as never, command as never,
	);
	return { service, command, files, storage, installCalls, localDir, manifest, installer };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('MarketplaceHttp', () => {

	// ── publish ─────────────────────────────────────────────────────────────

	test('publish: 未登录 → 抛错且不发起任何命令', async () => {
		const { service, command } = setup({ loggedIn: false });
		await assert.rejects(() => service.publish('wf-pub', 'workflow', {}), /未登录商城/);
		assert.strictEqual(command.calls.length, 0, '未登录时不应发起任何 HTTP/tar 命令');
	});

	test('publish: 成功 → 创建包 + 打包 + 上传（URL/鉴权/changelog 正确）', async () => {
		const { service, command } = setup();
		command.on('marketplace.proxyRequest', args => {
			const url = String(args.url);
			if (url.endsWith('/packages/wf-pub')) { throw new Error('HTTP 404'); }        // 包不存在
			if (url.includes('/packages?')) { return { statusCode: 200, body: JSON.stringify({ items: [], total: 0 }) }; }
			if (url.endsWith('/packages')) { return { statusCode: 201, body: '{}' }; }     // 创建包
			throw new Error(`unexpected url ${url}`);
		});
		command.on('marketplace.createTar', () => ({}));
		command.on('marketplace.uploadFromFile', () => ({ statusCode: 200, text: JSON.stringify({ version: '1.0.1' }) }));

		const res = await service.publish('wf-pub', 'workflow', { changelog: '首个版本' });

		assert.strictEqual(res.version, '1.0.1', '应返回服务端确认的版本');
		assert.strictEqual(command.count('marketplace.createTar'), 1, '应打包一次');
		assert.strictEqual(command.count('marketplace.uploadFromFile'), 1, '应上传一次');
		const up = command.lastArgs('marketplace.uploadFromFile')!;
		assert.strictEqual(
			up.url, `${DEFAULT_ENDPOINT}/api/v1/packages/wf-pub/versions/raw`,
			'上传 URL 应指向 raw 版本端点',
		);
		const headers = up.headers as Record<string, string>;
		assert.strictEqual(headers['Authorization'], 'Bearer tok-123', '应带 Bearer 鉴权');
		assert.strictEqual(headers['x-changelog'], encodeURIComponent('首个版本'), 'changelog 走请求头');
	});

	// ★ P0 端到端回归：元数据必须真的写进包内 manifest.json
	test('publish: visibility / tags / useGuide 写进包内 manifest（P0 端到端回归）', async () => {
		const { service, command, files } = setup();
		command.on('marketplace.proxyRequest', args => {
			const url = String(args.url);
			if (url.endsWith('/packages/wf-pub')) { throw new Error('HTTP 404'); }
			if (url.includes('/packages?')) { return { statusCode: 200, body: JSON.stringify({ items: [], total: 0 }) }; }
			if (url.endsWith('/packages')) { return { statusCode: 201, body: '{}' }; }
			throw new Error(`unexpected url ${url}`);
		});
		command.on('marketplace.createTar', () => ({}));
		command.on('marketplace.uploadFromFile', () => ({ statusCode: 200, text: JSON.stringify({ version: '2.0.0' }) }));

		await service.publish('wf-pub', 'workflow', {
			version: '2.0.0',
			visibility: 'private',
			tags: ['表情包', 'emoji'],
			useGuide: '# 使用说明',
		});

		// manifest.json 在打包后会被删除 → 用 writeLog 检查写过的内容
		const manifestWrites = files.writeLog.filter(w => w.uri.endsWith('/manifest.json'));
		assert.ok(manifestWrites.length > 0, '应写入包内 manifest.json');
		const written = JSON.parse(manifestWrites[manifestWrites.length - 1].content);
		assert.strictEqual(written.visibility, 'private', 'visibility 必须随包上传（曾在此处被丢弃）');
		assert.deepStrictEqual(written.tags, ['表情包', 'emoji'], 'tags 必须随包上传');
		assert.strictEqual(written.useGuide, '# 使用说明', 'useGuide 必须随包上传');
		assert.strictEqual(written.version, '2.0.0');
	});

	test('publish: 版本已存在 → 提前拦截，不发上传请求', async () => {
		const { service, command } = setup();
		command.on('marketplace.proxyRequest', args => {
			const url = String(args.url);
			if (url.endsWith('/packages/wf-pub')) {
				return { statusCode: 200, body: JSON.stringify({ id: 'wf-pub', slug: 'wf-pub', kind: 'workflow', name: 'Pub Test', latest_version: '1.0.0', versions: [{ version: '1.0.0' }] }) };
			}
			if (url.includes('/packages?')) { return { statusCode: 200, body: JSON.stringify({ items: [], total: 0 }) }; }
			throw new Error(`unexpected url ${url}`);
		});
		command.on('marketplace.createTar', () => ({}));

		await assert.rejects(() => service.publish('wf-pub', 'workflow', {}), /已存在于商城/);
		assert.strictEqual(command.count('marketplace.uploadFromFile'), 0, '版本冲突不应发起上传');
		assert.strictEqual(command.count('marketplace.createTar'), 0, '版本冲突不应打包');
	});

	test('publish: 上传 HTTP 400 → 透传服务端错误消息', async () => {
		const { service, command } = setup();
		command.on('marketplace.proxyRequest', args => {
			const url = String(args.url);
			if (url.endsWith('/packages/wf-pub')) { throw new Error('HTTP 404'); }
			if (url.includes('/packages?')) { return { statusCode: 200, body: JSON.stringify({ items: [], total: 0 }) }; }
			if (url.endsWith('/packages')) { return { statusCode: 201, body: '{}' }; }
			throw new Error(`unexpected url ${url}`);
		});
		command.on('marketplace.createTar', () => ({}));
		command.on('marketplace.uploadFromFile', () => ({ statusCode: 400, text: JSON.stringify({ error: '版本号必须递增' }) }));

		await assert.rejects(() => service.publish('wf-pub', 'workflow', {}), /版本号必须递增/);
	});

	// ── download ────────────────────────────────────────────────────────────

	test('download: 成功 → 下载 + 解压 + installer.install(force:true) + 记录已安装', async () => {
		const { service, command, files } = setup();
		const extractDir = { path: '' };
		command.on('marketplace.downloadToFile', args => { extractDir.path = String(args.savePath); return { statusCode: 200 }; });
		command.on('marketplace.extractTar', args => {
			// 解压产物：包内 manifest.json（真实实现从该文件读 manifest）
			const dir = String(args.extractDir);
			files.seedFile(`${dir}/manifest.json`, JSON.stringify(makeBaseManifest({ version: '3.0.0' })));
			return {};
		});

		const res = await service.download('wf-pub', '3.0.0', 'workflow');

		assert.strictEqual(res.storeId, 'wf-pub');
		assert.strictEqual(res.version, '3.0.0');
		assert.strictEqual(command.count('marketplace.downloadToFile'), 1);
		assert.strictEqual(command.count('marketplace.extractTar'), 1);
	});

	test('download: installer 收到 force:true（升级不因「已存在」失败）', async () => {
		const { service, command, files, installCalls } = setup();
		command.on('marketplace.downloadToFile', () => ({ statusCode: 200 }));
		command.on('marketplace.extractTar', args => {
			files.seedFile(`${String(args.extractDir)}/manifest.json`, JSON.stringify(makeBaseManifest({ version: '3.0.0' })));
			return {};
		});

		await service.download('wf-pub', '3.0.0', 'workflow');

		assert.strictEqual(installCalls.length, 1, '应委托 installer 安装一次');
		assert.strictEqual(installCalls[0].opts?.force, true, 'force 必须为 true —— 否则升级会被「已存在」拦截');
	});

	test('download: 空版本号 → 自动解析为最新版', async () => {
		const { service, command, files } = setup();
		command.on('marketplace.proxyRequest', args => {
			const url = String(args.url);
			if (url.endsWith('/packages/wf-pub')) {
				// ⚠ 服务端字段是 snake_case（mapPackage 读 latest_version / is_latest）
				return { statusCode: 200, body: JSON.stringify({ id: 'wf-pub', slug: 'wf-pub', kind: 'workflow', name: 'Pub Test', latest_version: '5.0.0', versions: [{ version: '5.0.0', is_latest: true }] }) };
			}
			throw new Error(`unexpected url ${url}`);
		});
		command.on('marketplace.downloadToFile', args => {
			assert.ok(String(args.url).includes('/versions/5.0.0/download'), '应下载解析出的最新版本');
			return { statusCode: 200 };
		});
		command.on('marketplace.extractTar', args => {
			files.seedFile(`${String(args.extractDir)}/manifest.json`, JSON.stringify(makeBaseManifest({ version: '5.0.0' })));
			return {};
		});

		const res = await service.download('wf-pub', '', 'workflow');
		assert.strictEqual(res.version, '5.0.0');
	});

	test('download: HTTP 404 → 抛「下载失败」', async () => {
		const { service, command } = setup();
		command.on('marketplace.downloadToFile', () => ({ statusCode: 404 }));
		await assert.rejects(() => service.download('wf-pub', '9.9.9', 'workflow'), /下载失败/);
	});

	test('download: 包内缺 manifest.json → 抛错', async () => {
		const { service, command } = setup();
		command.on('marketplace.downloadToFile', () => ({ statusCode: 200 }));
		command.on('marketplace.extractTar', () => ({}));   // 不解压出 manifest
		await assert.rejects(() => service.download('wf-pub', '1.0.0', 'workflow'), /包内缺少 manifest\.json/);
	});
});
