/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh 插件补丁管理器（插件级升级 P1）——只更新插件，不下载/安装整包 EXE。
 *
 * 与 update feed 的关系：**完全独立的第二条通道**。VS Code 原生 update feed 继续负责内核版本
 * 升级（整包 EXE，见 `updateService.win32.ts`），本管理器负责把 `/api/dsh-plugins` 清单里的
 * 变更插件装进 dsh profile，不动 `<appPath>`、不跑安装器。
 *
 * 安全（P0 生成端对应实现见 `build/saros/package-dsh-plugins.mjs`）：
 *  - manifest 必须 Ed25519 验签通过，公钥内置或由环境变量注入；未签名仅在内网开发开关下放行；
 *  - `requires.bundled` 必须与本机 `dsh-compat.json` 的 pin 一致；
 *  - `requires.minClient` 不得高于当前客户端版本；
 *  - 每个 tgz 按 sha256 校验；归档落 userData（system setup 装在 Program Files，appPath 不可写）。
 *
 * 原子性：先全部下载校验，再逐个安装；**全部成功才写 overrides**（失败保留上一版、下次重试）。
 * `installPluginSpec` 内部会 `_ensureProfile` 并置 `_pluginsStale`，下次启动会起重读磁盘的 Host。
 */

import { createHash, verify as ed25519Verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { comparePluginVersions } from './dshBundledPlugins.js';
import type { FetchLike } from './dshNodeInstaller.js';
import { readOverrides, writeOverrides, type IDshPluginOverride } from './dshPluginOverrides.js';

interface IPluginPatchEntry {
	readonly name: string;
	readonly version: string;
	readonly url: string;
	readonly sha256: string;
	readonly size: number;
	/** 生成端写入 `dsh-plugins/<dirName>`；用于把伴生插件的启动目录一并摘掉。 */
	readonly source?: string;
}

interface IPluginPatchManifest {
	readonly schemaVersion: number;
	readonly generatedAt?: string;
	readonly platform?: string;
	readonly requires?: { readonly minClient?: string; readonly bundled?: string };
	readonly signature?: string | null;
	readonly plugins: readonly IPluginPatchEntry[];
}

export interface IDshPluginPatchResult {
	readonly ok: boolean;
	readonly applied: number;
	readonly error?: string;
}

export interface IDshPluginPatchOptions {
	readonly userDataPath: string;
	readonly updateUrl: string;
	/** `<appPath>/dsh-plugins`，用于读取 dsh-compat.json 的 bundled pin。 */
	readonly bundledPluginsRoot: string;
	readonly clientVersion: string;
	/** dsh runtime pin（通道从 dsh-compat.json 解析，dev 会向上找仓库根）；优先于 manager 自己读文件。 */
	readonly bundledPin?: string;
	readonly platform: string;
	readonly fetch: FetchLike;
	readonly log: (line: string) => void;
	/** 通常为 `supervisor.installPluginSpec(spec, name)`；spec 形如 `file:/<userData>/.../x.tgz`。 */
	readonly install: (name: string, spec: string) => Promise<{ ok: boolean; error?: string }>;
	/** 公钥 PEM；生产必须提供（内置常量或 VSSAROS_DSH_PLUGIN_PATCH_PUBLIC_KEY）。 */
	readonly publicKeyPem?: string;
	/** 仅内网开发：允许未签名清单。生产绝不开启。 */
	readonly allowUnsigned?: boolean;
}

const REQUEST_TIMEOUT_MS = 15_000;

export class DshPluginPatchManager {

	constructor(private readonly _opts: IDshPluginPatchOptions) { }

	/** 由通道在 Host 首次 running 后调用；任何失败都只记日志，绝不阻断启动。 */
	async start(): Promise<IDshPluginPatchResult> {
		try {
			return await this._apply();
		} catch (e) {
			const message = String((e as Error)?.message ?? e);
			this._log(`failed: ${message}（保留现有插件，下次启动重试）`);
			return { ok: false, applied: 0, error: message };
		}
	}

	private _log(line: string): void {
		this._opts.log(`[plugin-patch] ${line}`);
	}

	private _resolveUrl(ref: string): string {
		if (/^https?:\/\//i.test(ref)) {
			return ref;
		}
		const base = this._opts.updateUrl.replace(/\/+$/, '');
		return base + (ref.startsWith('/') ? ref : `/${ref}`);
	}

	private async _fetchWithTimeout(url: string): Promise<Awaited<ReturnType<FetchLike>>> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this._opts.fetch(url),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s）：${url}`)), REQUEST_TIMEOUT_MS);
				}),
			]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
	}

	private _verifySignature(raw: IPluginPatchManifest, canonical: string): void {
		const signature = raw.signature;
		if (!signature || !signature.startsWith('ed25519:')) {
			if (this._opts.allowUnsigned) {
				this._log('⚠ 未签名清单（allowUnsigned 开发开关），仅内网验证可用');
				return;
			}
			throw new Error('manifest 未签名或签名格式不对，拒绝应用插件补丁');
		}
		if (!this._opts.publicKeyPem) {
			throw new Error('缺少验签公钥（VSSAROS_DSH_PLUGIN_PATCH_PUBLIC_KEY / 内置常量），拒绝应用插件补丁');
		}
		const valid = ed25519Verify(
			null,
			Buffer.from(canonical, 'utf8'),
			this._opts.publicKeyPem,
			Buffer.from(signature.slice('ed25519:'.length), 'base64'),
		);
		if (!valid) {
			throw new Error('manifest Ed25519 验签失败，拒绝应用插件补丁');
		}
	}

	private _checkCompatibility(raw: IPluginPatchManifest): void {
		const expectedBundled = this._opts.bundledPin ?? (() => {
			try {
				return JSON.parse(readFileSync(join(this._opts.bundledPluginsRoot, 'dsh-compat.json'), 'utf8')).bundled as string | undefined;
			} catch {
				return undefined;
			}
		})();
		const required = raw.requires;
		if (required?.bundled && (!expectedBundled || required.bundled !== expectedBundled)) {
			throw new Error(`runtime pin 不匹配（本机 ${expectedBundled ?? '未知'} / 清单 ${required.bundled}），拒绝应用`);
		}
		if (required?.minClient && comparePluginVersions(this._opts.clientVersion, required.minClient) < 0) {
			throw new Error(`客户端版本过低（${this._opts.clientVersion} < ${required.minClient}），拒绝应用`);
		}
		if (raw.platform && raw.platform !== this._opts.platform) {
			throw new Error(`平台不匹配（本机 ${this._opts.platform} / 清单 ${raw.platform}），拒绝应用`);
		}
	}

	private async _apply(): Promise<IDshPluginPatchResult> {
		const { updateUrl, userDataPath } = this._opts;
		if (!/^https?:\/\//i.test(updateUrl)) {
			this._log('未配置有效的 updateUrl，跳过');
			return { ok: true, applied: 0 };
		}

		const manifestUrl = `${updateUrl.replace(/\/+$/, '')}/api/dsh-plugins?client=${encodeURIComponent(this._opts.clientVersion)}&platform=${encodeURIComponent(this._opts.platform)}`;
		const response = await this._fetchWithTimeout(manifestUrl);
		if (response.status === 404) {
			this._log('服务器没有插件补丁端点（旧服务器），跳过');
			return { ok: true, applied: 0 };
		}
		if (!response.ok) {
			throw new Error(`清单请求失败 HTTP ${response.status}`);
		}
		const text = await response.text();
		const raw = JSON.parse(text) as IPluginPatchManifest;
		if (raw.schemaVersion !== 1 || !Array.isArray(raw.plugins)) {
			throw new Error('清单 schemaVersion 不合法');
		}
		// 与生成端同一规则：删掉 signature 后按原键序序列化，字节必须完全一致。
		const unsigned: Record<string, unknown> = { ...raw };
		delete unsigned.signature;
		this._verifySignature(raw, JSON.stringify(unsigned));
		this._checkCompatibility(raw);

		const existing = readOverrides(userDataPath);
		const pending = raw.plugins.filter(entry =>
			entry.name && entry.version && entry.url && entry.sha256 && entry.source
			&& !existing.some(o => o.name === entry.name && o.version === entry.version && o.sha256 === entry.sha256));
		if (!pending.length) {
			this._log('插件补丁已是最新，无需操作');
			return { ok: true, applied: 0 };
		}

		// 阶段一：全部下载 + sha256 校验 + 落盘（userData）。任何一步失败都不改 overrides。
		const archives: { entry: IPluginPatchEntry; archive: string }[] = [];
		for (const entry of pending) {
			const download = await this._fetchWithTimeout(this._resolveUrl(entry.url));
			if (!download.ok) {
				throw new Error(`下载失败 HTTP ${download.status}：${entry.name}`);
			}
			const bytes = Buffer.from(await download.arrayBuffer());
			const digest = createHash('sha256').update(bytes).digest('hex');
			if (digest !== entry.sha256) {
				throw new Error(`sha256 不符：${entry.name}（期望 ${entry.sha256}，实得 ${digest}）`);
			}
			const fileName = entry.url.split('/').pop() ?? `${entry.name.replace(/[^a-z0-9._-]/gi, '-')}.tgz`;
			const dir = join(userDataPath, 'dsh-plugin-patches', digest.slice(0, 12));
			mkdirSync(dir, { recursive: true });
			const archive = join(dir, fileName);
			writeFileSync(archive, bytes);
			archives.push({ entry, archive });
			this._log(`downloaded ${entry.name}@${entry.version} (${bytes.length} B)`);
		}

		// 阶段二：交给 supervisor 的 spec 通道（`dsh plugin add file:<tgz>`，内部会 _ensureProfile）。
		const applied: IDshPluginOverride[] = [];
		for (const { entry, archive } of archives) {
			const result = await this._opts.install(entry.name, `file:${archive.replace(/\\/g, '/')}`);
			if (!result.ok) {
				throw new Error(`安装失败 ${entry.name}@${entry.version}：${result.error ?? '未知原因'}`);
			}
			applied.push({
				name: entry.name,
				version: entry.version,
				dirName: entry.source!.split('/').filter(Boolean).pop() ?? entry.name,
				sha256: entry.sha256,
				archive,
				appliedAt: new Date().toISOString(),
			});
			this._log(`applied ${entry.name}@${entry.version}`);
		}

		const names = new Set(applied.map(o => o.name));
		writeOverrides(userDataPath, [...existing.filter(o => !names.has(o.name)), ...applied]);
		this._log(`✅ ${applied.length} 个插件补丁已生效；下次启动的随包清单会跳过它们`);
		return { ok: true, applied: applied.length };
	}
}
