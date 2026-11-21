/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 可选组件管理器（媒体 / Office / Whisper）。
 *
 * 媒体工具走官方 Provider（winget / brew / apt / dnf / pacman）和跨平台路径发现，
 * 不在应用里维护 ffmpeg / yt-dlp 的版本；Office Python 运行时随安装包分发；
 * Whisper 模型直接走 HuggingFace 官方文件 + 固定 SHA256，不再依赖组件服务器。
 *
 * 设计约束：
 * - 官方工具只安装到用户级，默认不静默提权；
 * - managed 包下载到同目录临时文件，SHA256 + size 通过后才原子替换；
 * - 已随包的 offline 构建优先，不重复下载；
 * - 安装失败保留上一份可用版本，UI 读状态而不是猜测。
 */
import { createHash, randomUUID } from 'crypto';
import { createWriteStream, existsSync, promises as fsp, readFileSync, statSync } from 'fs';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, join } from '../../../../base/common/path.js';
import { extract } from '../../../../base/node/zip.js';
import { MEDIA_COMPONENT, WHISPER_MODEL_ENTRY } from './dshComponentCatalog.js';
import { DshComponentLocator } from './dshComponentLocator.js';
import { DshCommandRunner, DshComponentProviderRegistry } from './dshComponentProviders.js';
import { FetchLike } from './dshNodeInstaller.js';

export type DshComponentId = 'media' | 'office' | 'whisper';
export type DshComponentState = 'missing' | 'installing' | 'ready' | 'bundled' | 'needs-consent' | 'unavailable' | 'error';

export interface IDshComponentStatus {
	readonly id: DshComponentId;
	readonly label: string;
	readonly state: DshComponentState;
	readonly version?: string;
	readonly source?: string;
	readonly size?: number;
	readonly receivedBytes?: number;
	readonly totalBytes?: number;
	readonly progress: number;
	readonly installedPath?: string;
	readonly binaries?: Readonly<Record<string, string>>;
	readonly error?: string;
}

export interface IDshComponentManifestEntry {
	readonly version: string;
	readonly url: string;
	readonly sha256: string;
	readonly size: number;
	readonly format: 'zip' | 'file';
	/** 可选官方镜像；主 URL 失败后按顺序重试。 */
	readonly urls?: readonly string[];
}

interface IDshComponentManifest {
	readonly schemaVersion: 1;
	readonly platform?: string;
	readonly components: Partial<Record<DshComponentId, IDshComponentManifestEntry>>;
}

export interface IDshComponentManagerOptions {
	/** VsSaros userData 根；组件落到 `<root>/components`。 */
	readonly userDataPath: string;
	/** 更新服务器基址，例如 product.json updateUrl。 */
	readonly updateUrl?: string;
	/** `electron.net.fetch`（走系统代理）或测试替身。 */
	readonly fetch: FetchLike;
	readonly log: (line: string) => void;
	/** 打包形态的应用根（`app.getAppPath()`）与 resources 根，用于识别随包组件。 */
	readonly appPath?: string;
	readonly resourcesPath?: string;
	/** 是否在启动后后台安装缺失组件；默认 true。 */
	readonly autoInstall?: boolean;
	/** 是否启用 winget / brew / apt 等官方 Provider；默认 true。 */
	readonly officialProviders?: boolean;
	/** 是否允许需要管理员权限的 Provider 自动安装；默认 false。 */
	readonly allowElevation?: boolean;
	/** 测试注入的命令执行器。 */
	readonly commandRunner?: DshCommandRunner;
	/** 测试注入的平台/环境/家目录；生产默认 process。 */
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
}

const COMPONENTS: Readonly<Record<DshComponentId, { label: string; defaultSize?: number }>> = {
	media: { label: '媒体工具（ffmpeg / ffprobe / yt-dlp）', defaultSize: 330 * 1024 * 1024 },
	office: { label: 'Office 运行时（Python / 办公技能）', defaultSize: 154 * 1024 * 1024 },
	whisper: { label: 'Whisper 本地语音模型', defaultSize: 141 * 1024 * 1024 },
};
const COMPONENT_IDS: readonly DshComponentId[] = ['media', 'office', 'whisper'];
const MANIFEST_TTL_MS = 5 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

function isComponentId(value: unknown): value is DshComponentId {
	return value === 'media' || value === 'office' || value === 'whisper';
}

function isSha256(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isManifestEntry(value: unknown): value is IDshComponentManifestEntry {
	if (!value || typeof value !== 'object') { return false; }
	const v = value as Record<string, unknown>;
	return typeof v.version === 'string' && v.version.length > 0 && v.version.length <= 200
		&& typeof v.url === 'string' && v.url.length > 0 && v.url.length <= 2048
		&& isSha256(v.sha256)
		&& typeof v.size === 'number' && Number.isSafeInteger(v.size) && v.size > 0
		&& (v.format === 'zip' || v.format === 'file');
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function renameWithRetry(from: string, to: string): Promise<void> {
	let wait = 100;
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			await fsp.rename(from, to);
			return;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if ((code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || Date.now() > deadline) { throw e; }
			await delay(wait);
			wait = Math.min(wait * 2, 1_000);
		}
	}
}

async function sha256File(file: string): Promise<string> {
	const hash = createHash('sha256');
	const handle = await fsp.open(file, 'r');
	try {
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		let position = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) { break; }
			hash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
	} finally {
		await handle.close();
	}
	return hash.digest('hex');
}

export class DshComponentManager extends Disposable {
	private readonly _root: string;
	private readonly _manifestUrl: string | undefined;
	private readonly _manifestFallbackUrl: string | undefined;
	private readonly _fetch: FetchLike;
	private readonly _log: (line: string) => void;
	private readonly _appPath?: string;
	private readonly _resourcesPath?: string;
	private readonly _autoInstall: boolean;
	private readonly _officialProviders: boolean;
	private readonly _allowElevation: boolean;
	private readonly _platform: NodeJS.Platform;
	private readonly _locator: DshComponentLocator;
	private readonly _providerRegistry: DshComponentProviderRegistry;
	private readonly _status = new Map<DshComponentId, IDshComponentStatus>();
	private readonly _controllers = new Map<DshComponentId, AbortController>();
	private _manifest?: IDshComponentManifest;
	private _manifestAt = 0;
	private _manifestError?: string;
	private _autoStarted = false;
	private _disposed = false;

	constructor(options: IDshComponentManagerOptions) {
		super();
		this._root = join(options.userDataPath, 'components');
		this._fetch = options.fetch;
		this._log = options.log;
		this._appPath = options.appPath;
		this._resourcesPath = options.resourcesPath;
		this._autoInstall = options.autoInstall !== false;
		this._officialProviders = options.officialProviders !== false;
		this._allowElevation = options.allowElevation === true;
		this._platform = options.platform ?? process.platform;
		this._locator = new DshComponentLocator({
			userDataPath: options.userDataPath,
			...(options.platform ? { platform: options.platform } : {}),
			...(options.env ? { env: options.env } : {}),
			...(options.home ? { home: options.home } : {}),
			...(options.commandRunner ? { execFile: (file, args, opts) => options.commandRunner!(file, args, opts) } : {}),
		});
		this._providerRegistry = new DshComponentProviderRegistry({
			...(options.platform ? { platform: options.platform } : {}),
			...(options.env ? { env: options.env } : {}),
			...(options.commandRunner ? { run: options.commandRunner } : {}),
		});
		this._manifestUrl = options.updateUrl && /^https?:\/\//i.test(options.updateUrl)
			? new URL('/api/components', options.updateUrl).toString()
			: undefined;
		// 兼容尚未升级的更新服务器：旧服务没有 /api/components，但通常已有 /downloads/**。
		this._manifestFallbackUrl = options.updateUrl && /^https?:\/\//i.test(options.updateUrl)
			? new URL('/downloads/components/manifest.json', options.updateUrl).toString()
			: undefined;
		for (const id of COMPONENT_IDS) {
			this._status.set(id, { id, label: COMPONENTS[id].label, state: 'missing', progress: 0, size: COMPONENTS[id].defaultSize });
		}
	}

	/** 启动后延迟一点再探测/安装，避免与窗口/DSH Host 启动争用磁盘和网络。 */
	async startAutoInstall(): Promise<void> {
		if (!this._autoInstall || this._autoStarted || this._disposed) { return; }
		this._autoStarted = true;
		await delay(2000);
		if (this._disposed) { return; }
		try {
			const statuses = await this.status();
			for (const item of statuses) {
				if (this._disposed) { return; }
				if (item.state === 'missing') {
					await this.install(item.id);
				}
			}
		} catch (e) {
			this._log(`[components] auto-install stopped: ${String((e as Error)?.message ?? e)}`);
		}
	}

	/** 当前状态；媒体/Whisper 不依赖组件服务器，Office 优先随包。 */
	async status(): Promise<readonly IDshComponentStatus[]> {
		const result: IDshComponentStatus[] = [await this._mediaStatus()];
		for (const id of COMPONENT_IDS) {
			if (id === 'media') { continue; }
			result.push(id === 'whisper' ? this._whisperStatus() : this._refreshStatus(id));
		}
		return result;
	}

	/** 启动安装并立即返回；进度通过后续 status() 读取。 */
	async install(id: DshComponentId, options: { allowElevation?: boolean } = {}): Promise<readonly IDshComponentStatus[]> {
		if (!isComponentId(id)) { throw new Error(`unknown component: ${String(id)}`); }
		if (id === 'media') {
			const current = await this._mediaStatus();
			if (current.state === 'installing' || current.state === 'bundled' || current.state === 'ready') {
				return this.status();
			}
			void this._runOfficialMediaInstall(this._allowElevation || options.allowElevation === true);
			return this.status();
		}
		if (id === 'whisper') {
			const current = this._whisperStatus();
			if (current.state === 'installing' || current.state === 'bundled' || current.state === 'ready') {
				return this.status();
			}
			void this._runInstall('whisper', WHISPER_MODEL_ENTRY);
			return this.status();
		}
		// Office 优先随包；旧构建或未随包的安装包允许从已配置的外部清单回退。
		if (id === 'office') {
			const current = this._refreshStatus('office');
			if (current.state === 'installing' || current.state === 'bundled' || current.state === 'ready') {
				return this.status();
			}
			await this._ensureManifest();
			const entry = this._manifest?.components.office;
			if (!entry) {
				this._setStatus('office', {
					state: 'error', progress: 0,
					error: 'Office 运行时未随安装包分发，且当前没有可用的外部 Office 包；请使用包含 Office 的完整安装包',
				});
				return this.status();
			}
			void this._runInstall('office', entry);
			return this.status();
		}
		const current = this._refreshStatus(id);
		if (current.state === 'installing' || current.state === 'bundled' || current.state === 'ready') {
			return this.status();
		}
		await this._ensureManifest();
		const entry = this._manifest?.components[id];
		if (!entry) {
			// 设置页可能缓存了旧的 available 状态；这里返回受控的 unavailable，而不是
			// 把异常抛到 IPC（否则界面显示 "Error invoking remote method..."）。
			this._setStatus(id, {
				state: 'unavailable', progress: 0,
				error: `组件清单中没有 ${id}（服务器尚未部署组件清单或该组件）`,
			});
			return this.status();
		}
		void this._runInstall(id, entry);
		return this.status();
	}

	private _whisperStatus(): IDshComponentStatus {
		const previous = this._status.get('whisper')!;
		if (previous.state === 'installing') { return previous; }
		if (previous.state === 'error' && previous.error) { return previous; }
		const bundled = this._bundledPath('whisper');
		if (bundled) {
			return this._setStatus('whisper', {
				state: 'bundled', progress: 100, source: 'bundled',
				version: WHISPER_MODEL_ENTRY.version, size: WHISPER_MODEL_ENTRY.size,
				installedPath: bundled, error: undefined,
			});
		}
		const installed = join(this._root, 'whisper', WHISPER_MODEL_ENTRY.sha256, WHISPER_MODEL_ENTRY.fileName);
		try {
			if (existsSync(installed) && statSync(installed).size === WHISPER_MODEL_ENTRY.size) {
				return this._setStatus('whisper', {
					state: 'ready', progress: 100, source: 'huggingface',
					version: WHISPER_MODEL_ENTRY.version, size: WHISPER_MODEL_ENTRY.size,
					installedPath: installed, error: undefined,
				});
			}
		} catch { /* 读取失败按未安装处理 */ }
		return this._setStatus('whisper', {
			state: 'missing', progress: 0, source: 'huggingface',
			version: WHISPER_MODEL_ENTRY.version, size: WHISPER_MODEL_ENTRY.size,
			installedPath: undefined, error: undefined,
		});
	}

	private async _mediaStatus(): Promise<IDshComponentStatus> {
		const previous = this._status.get('media')!;
		if (previous.state === 'installing') {
			// winget 可能已经落盘但安装子进程还没退出（或卡住）；优先识别真实文件，
			// 避免界面永远停在“安装中”。缓存由 locator 自己控制，避免每次 2s 深扫。
			const located = await this._locator.find(MEDIA_COMPONENT);
			if (located) {
				return this._setStatus('media', {
					state: 'ready', progress: 100, version: located.version,
					source: located.source, installedPath: located.path,
					binaries: located.binaries, error: undefined,
				});
			}
			return previous;
		}
		if (previous.state === 'error' || previous.state === 'needs-consent') { return previous; }
		const located = await this._locator.find(MEDIA_COMPONENT);
		if (located) {
			return this._setStatus('media', {
				state: 'ready', progress: 100, version: located.version,
				source: located.source, installedPath: located.path,
				binaries: located.binaries, error: undefined,
			});
		}
		return this._refreshStatus('media');
	}

	/** 官方媒体安装：winget / brew / apt 等；不可用时回退 managed 清单。 */
	private async _runOfficialMediaInstall(allowElevation: boolean): Promise<void> {
		if (this._controllers.has('media')) { return; }
		const controller = new AbortController();
		this._controllers.set('media', controller);
		this._setStatus('media', { state: 'installing', progress: 0, installedPath: undefined, binaries: undefined, error: undefined });
		try {
			if (this._officialProviders) {
				for (const provider of this._providerRegistry.list()) {
					if (!await provider.available()) { continue; }
					if (provider.requiresElevation() && !allowElevation) {
						this._setStatus('media', { state: 'needs-consent', error: `${provider.label} 安装需要管理员权限；请在设置页点击“授权安装”` });
						return;
					}
					try {
						this._log(`[components] media install via ${provider.id}`);
						const specProvider = MEDIA_COMPONENT.providers[this._platform as 'win32' | 'darwin' | 'linux']?.find(item => item.type === provider.id);
						if (specProvider) { await provider.install(MEDIA_COMPONENT, specProvider, controller.signal); }
						const located = await this._locator.find(MEDIA_COMPONENT, [], { fresh: true });
						if (located) {
							this._setStatus('media', {
								state: 'ready', progress: 100, version: located.version,
								source: located.source, installedPath: located.path,
								binaries: located.binaries, error: undefined,
							});
							return;
						}
					} catch (e) {
						this._log(`[components] media provider ${provider.id} failed: ${String((e as Error)?.message ?? e)}`);
						// 部分包可能已经落地（例如 ffmpeg 成功、yt-dlp 失败）：仍重新探测一次。
						const located = await this._locator.find(MEDIA_COMPONENT, [], { fresh: true });
						if (located && Object.keys(located.binaries).length === 3) {
							this._setStatus('media', {
								state: 'ready', progress: 100, version: located.version,
								source: located.source, installedPath: located.path,
								binaries: located.binaries, error: undefined,
							});
							return;
						}
					}
				}
			}

			// 兼容旧构建：官方 Provider 都不可用时，仍允许 managed 媒体包兜底。
			await this._ensureManifest();
			const entry = this._manifest?.components.media;
			if (entry) {
				await this._installManaged('media', entry, controller);
				return;
			}
			this._setStatus('media', { state: 'error', error: '没有可用的官方包管理器，也没有 managed 媒体包；请在设置页指定 ffmpeg 路径' });
		} finally {
			this._controllers.delete('media');
		}
	}

	private async _runInstall(id: DshComponentId, entry: IDshComponentManifestEntry): Promise<void> {
		if (this._controllers.has(id)) { return; }
		const controller = new AbortController();
		this._controllers.set(id, controller);
		try {
			await this._installManaged(id, entry, controller);
		} finally {
			this._controllers.delete(id);
		}
	}

	private async _installManaged(id: DshComponentId, entry: IDshComponentManifestEntry, controller: AbortController): Promise<void> {
		this._setStatus(id, { state: 'installing', progress: 0, receivedBytes: 0, totalBytes: entry.size, error: undefined, version: entry.version, source: id === 'whisper' ? 'huggingface' : 'managed' });
		const staging = join(this._root, '.staging', `${id}-${process.pid}-${randomUUID()}`);
		try {
			await fsp.mkdir(staging, { recursive: true });
			if (id === 'whisper') {
				await this._installWhisper(entry, controller.signal);
			} else {
				await this._installArchive(id, entry, staging, controller.signal);
			}
			this._log(`[components] installed ${id} ${entry.version}`);
		} catch (e) {
			const message = String((e as Error)?.message ?? e);
			this._log(`[components] install ${id} failed: ${message}`);
			this._setStatus(id, { state: 'error', error: message, source: 'managed' });
		} finally {
			await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async _installArchive(id: 'media' | 'office', entry: IDshComponentManifestEntry, staging: string, signal: AbortSignal): Promise<void> {
		const archive = join(staging, 'package.zip');
		await this._download(id, entry, archive, signal);
		const extracted = join(staging, 'content');
		await fsp.mkdir(extracted, { recursive: true });
		await extract(archive, extracted, {}, CancellationToken.None);
		if (!this._validateExtracted(id, extracted)) {
			throw new Error(`${id} 包内容不完整（缺少必需文件）`);
		}
		await fsp.writeFile(join(extracted, 'component.json'), `${JSON.stringify({
			schemaVersion: 1, id, version: entry.version, sha256: entry.sha256, size: entry.size, installedAt: new Date().toISOString(),
		}, null, 2)}\n`, 'utf8');
		await this._publishDir(id, extracted);
		this._setStatus(id, { state: 'ready', progress: 100, version: entry.version, installedPath: this._installedPath(id), error: undefined });
	}

	private async _installWhisper(entry: IDshComponentManifestEntry, signal: AbortSignal): Promise<void> {
		const dir = join(this._root, 'whisper', entry.sha256);
		const target = join(dir, 'ggml-base.bin');
		if (existsSync(target)) {
			const info = await fsp.stat(target);
			if (info.size === entry.size && await sha256File(target) === entry.sha256) {
				this._setStatus('whisper', { state: 'ready', progress: 100, version: entry.version, installedPath: target, error: undefined });
				return;
			}
		}
		await fsp.mkdir(dir, { recursive: true });
		const temp = join(dir, `.download-${randomUUID()}.part`);
		await this._download('whisper', entry, temp, signal);
		await fsp.rm(target, { force: true });
		await renameWithRetry(temp, target);
		this._setStatus('whisper', { state: 'ready', progress: 100, version: entry.version, installedPath: target, error: undefined });
	}

	private _validateExtracted(id: 'media' | 'office', root: string): boolean {
		if (id === 'media') {
			return ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe'].every(name => existsSync(join(root, name)));
		}
		return existsSync(join(root, 'primary-runtime', 'runtime.json'))
			&& existsSync(join(root, 'office-skills', 'office-docx', 'SKILL.md'));
	}

	private async _publishDir(id: 'media' | 'office', content: string): Promise<void> {
		const current = this._installedPath(id);
		const old = `${current}.old-${process.pid}-${randomUUID()}`;
		await fsp.mkdir(dirname(current), { recursive: true });
		if (existsSync(current)) {
			await renameWithRetry(current, old);
		}
		try {
			await renameWithRetry(content, current);
		} catch (e) {
			if (existsSync(old) && !existsSync(current)) {
				await renameWithRetry(old, current).catch(() => undefined);
			}
			throw e;
		}
		await fsp.rm(old, { recursive: true, force: true }).catch(() => undefined);
	}

	private _installedPath(id: DshComponentId): string {
		if (id === 'whisper') {
			return join(this._root, 'whisper', WHISPER_MODEL_ENTRY.sha256, WHISPER_MODEL_ENTRY.fileName);
		}
		return join(this._root, id, 'current');
	}

	private _refreshStatus(id: DshComponentId): IDshComponentStatus {
		const previous = this._status.get(id)!;
		if (previous.state === 'installing') { return previous; }
		// 安装失败要留在卡片上供用户重试；下一次 install 会主动覆盖为 installing。
		if (previous.state === 'error' && previous.error) { return previous; }
		if (this._bundledPath(id)) {
			return this._setStatus(id, { state: 'bundled', progress: 100, source: 'bundled', installedPath: this._bundledPath(id), error: undefined });
		}
		const entry = this._manifest?.components[id];
		const installed = this._installedPath(id);
		if (entry && this._isInstalled(id, installed, entry)) {
			return this._setStatus(id, { state: 'ready', progress: 100, version: entry.version, source: 'managed', installedPath: installed, size: entry.size, error: undefined });
		}
		// 媒体可由官方 Provider 安装，不能因为 managed 清单缺失就显示“服务器不可用”。
		if (this._manifestError && !this._manifest && id !== 'media') {
			return this._setStatus(id, { state: 'unavailable', progress: 0, error: this._manifestError });
		}
		return this._setStatus(id, {
			state: 'missing', progress: 0,
			...(entry ? { version: entry.version, size: entry.size } : {}),
			installedPath: undefined, error: undefined,
		});
	}

	private _isInstalled(id: DshComponentId, installed: string, entry: IDshComponentManifestEntry): boolean {
		if (id === 'whisper') {
			try { return existsSync(installed) && statSync(installed).size === entry.size; } catch { return false; }
		}
		try {
			const meta = JSON.parse(readFileSync(join(installed, 'component.json'), 'utf8')) as { version?: string; sha256?: string };
			// 版本号只用于展示；幂等判据是内容 SHA256。产品每次升级不应重新下载 600MB 组件。
			if (meta.sha256 !== entry.sha256) { return false; }
		} catch { return false; }
		return this._validateExtracted(id, installed);
	}

	private _bundledPath(id: DshComponentId): string | undefined {
		if (id === 'media') {
			const root = this._resourcesPath ? join(this._resourcesPath, 'saros', 'bin') : undefined;
			const names = this._platform === 'win32' ? ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe'] : ['ffmpeg', 'ffprobe', 'yt-dlp'];
			return root && names.every(name => existsSync(join(root, name))) ? root : undefined;
		}
		if (id === 'office') {
			const root = this._appPath ? join(this._appPath, 'office-runtime') : undefined;
			return root && existsSync(join(root, 'primary-runtime', 'runtime.json')) && existsSync(join(root, 'office-skills')) ? root : undefined;
		}
		const model = this._resourcesPath ? join(this._resourcesPath, 'saros', 'models', 'ggml-base.bin') : undefined;
		return model && existsSync(model) ? model : undefined;
	}

	private async _ensureManifest(): Promise<void> {
		if (this._manifest && Date.now() - this._manifestAt < MANIFEST_TTL_MS) { return; }
		if (!this._manifestUrl) {
			this._manifestError = '未配置组件服务器（product.json updateUrl 为空或不是 http/https）';
			return;
		}
		try {
			const response = await this._fetchManifest(this._manifestUrl);
			if (!response.ok) { throw new Error(`组件清单 HTTP ${response.status}`); }
			const raw = JSON.parse(await response.text()) as unknown;
			if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== 1) {
				throw new Error('组件清单 schemaVersion 不合法');
			}
			const data = raw as { platform?: unknown; components?: unknown };
			if (typeof data.platform === 'string' && data.platform !== `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`) {
				throw new Error(`组件清单平台 ${data.platform} 与当前 ${process.platform}-${process.arch} 不一致`);
			}
			const components: Partial<Record<DshComponentId, IDshComponentManifestEntry>> = {};
			if (data.components && typeof data.components === 'object') {
				for (const id of COMPONENT_IDS) {
					const value = (data.components as Record<string, unknown>)[id];
					if (isManifestEntry(value)) { components[id] = value; }
				}
			}
			this._manifest = { schemaVersion: 1, ...(typeof data.platform === 'string' ? { platform: data.platform } : {}), components };
			this._manifestAt = Date.now();
			this._manifestError = undefined;
		} catch (e) {
			this._manifestError = String((e as Error)?.message ?? e);
			this._log(`[components] manifest unavailable: ${this._manifestError}`);
		}
	}

	private async _fetchManifest(url: string): Promise<Awaited<ReturnType<FetchLike>>> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			let response = await Promise.race([
				this._fetch(url),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error('组件清单请求超时（10 秒）')), 10_000);
				}),
			]);
			// 旧服务器返回 404 时再试静态清单；新服务器 /api/components 正常时不会走这里。
			if (!response.ok && response.status === 404 && this._manifestFallbackUrl && url !== this._manifestFallbackUrl) {
				response = await this._fetch(this._manifestFallbackUrl);
			}
			return response;
		} finally {
			if (timer) { clearTimeout(timer); }
		}
	}

	private async _download(id: DshComponentId, entry: IDshComponentManifestEntry, target: string, signal: AbortSignal): Promise<void> {
		const urls = [entry.url, ...(entry.urls ?? [])];
		let lastError: unknown;
		for (const ref of urls) {
			try {
				await this._downloadOne(id, entry, target, signal, this._resolveUrl(ref));
				return;
			} catch (e) {
				lastError = e;
				await fsp.rm(target, { force: true }).catch(() => undefined);
				if (signal.aborted) { throw e; }
			}
		}
		throw lastError instanceof Error ? lastError : new Error('组件下载失败（所有镜像均不可用）');
	}

	private async _downloadOne(id: DshComponentId, entry: IDshComponentManifestEntry, target: string, signal: AbortSignal, url: string): Promise<void> {
		const response = await this._fetchWithTimeout(url, signal);
		if (!response.ok) { throw new Error(`下载失败 HTTP ${response.status}: ${url}`); }
		const total = entry.size;
		const hash = createHash('sha256');
		const output = createWriteStream(target);
		let received = 0;
		const body = response.body as AsyncIterable<Uint8Array> | undefined;
		try {
			if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
				for await (const chunk of body) {
					hash.update(chunk);
					received += chunk.byteLength;
					this._setStatus(id, {
						state: 'installing', progress: total > 0 ? Math.min(99, Math.floor(received / total * 100)) : 0,
						receivedBytes: received, totalBytes: total,
					});
					if (!output.write(chunk)) { await new Promise<void>(resolve => output.once('drain', resolve)); }
				}
			} else {
				const buffer = Buffer.from(await response.arrayBuffer());
				hash.update(buffer);
				received = buffer.byteLength;
				output.write(buffer);
			}
			await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => error ? reject(error) : resolve()));
		} catch (e) {
			output.destroy();
			await fsp.rm(target, { force: true }).catch(() => undefined);
			throw e;
		}
		if (received !== entry.size || hash.digest('hex') !== entry.sha256) {
			await fsp.rm(target, { force: true }).catch(() => undefined);
			throw new Error(received !== entry.size
				? `下载大小不匹配：${received} != ${entry.size}`
				: '下载 SHA256 不匹配');
		}
	}

	private async _fetchWithTimeout(url: string, outerSignal: AbortSignal): Promise<Awaited<ReturnType<FetchLike>>> {
		const controller = new AbortController();
		const abort = () => controller.abort();
		const timeout = setTimeout(abort, DOWNLOAD_TIMEOUT_MS);
		outerSignal.addEventListener('abort', abort, { once: true });
		try {
			return await this._fetchWithSignal(url, controller.signal);
		} finally {
			clearTimeout(timeout);
			outerSignal.removeEventListener('abort', abort);
		}
	}

	private async _fetchWithSignal(url: string, signal: AbortSignal): Promise<Awaited<ReturnType<FetchLike>>> {
		const anyFetch = this._fetch as unknown as (url: string, init?: { signal?: AbortSignal }) => Promise<Awaited<ReturnType<FetchLike>>>;
		return anyFetch(url, { signal });
	}

	private _resolveUrl(ref: string): string {
		if (/^https?:\/\//i.test(ref)) { return ref; }
		if (!this._manifestUrl) { throw new Error('组件服务器地址未配置'); }
		return new URL(ref, this._manifestUrl).toString();
	}

	private _setStatus(id: DshComponentId, patch: Partial<IDshComponentStatus>): IDshComponentStatus {
		const previous = this._status.get(id)!;
		const next: IDshComponentStatus = { ...previous, ...patch, id, label: COMPONENTS[id].label };
		this._status.set(id, next);
		return next;
	}

	override dispose(): void {
		this._disposed = true;
		for (const controller of this._controllers.values()) { controller.abort(); }
		this._controllers.clear();
		super.dispose();
	}
}
