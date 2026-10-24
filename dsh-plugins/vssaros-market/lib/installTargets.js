// @vssaros/dsh-market — **安装目标解析**（把目录条目变成「可交给安装器的 spec」）。
//
// 语义照 dsh-desktop 的 `packages/dsh-desktop-workbenches/market-install.mjs` 复刻：
//   · 三种发布源各走各的分支，**绝不自动换来源**（Release 包校验不过 = 安装失败，
//     不是"那试试 npm 或仓库"—— 否则用户装的可能不是目录里公示的那份 ✗）；
//   · GitHub Release：下载 .tgz（≤8MiB）→ 校验 sha256 → 读包里的 package.json
//     （名字/版本必须与目录一致）→ 交给安装器装**这个文件**；
//   · GitHub 源码：先取 raw 的 package.json 校验 → spec = `github:owner/repo#commit`；
//   · npm：spec = `name@version`。
//
// ⚠ 这一层**只解析目标**，不真的安装（安装交给 Host 的插件管理器 ⇒ 见 `lib/index.js`）。
// ⚠ 纯逻辑 + 可注入 fetch ⇒ 可单测（不联网）。

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCb } from 'node:zlib';

/** 异步解压（同步版解压会把 Host 主线程卡住 ⇒ `dshPluginPackages` 守卫禁止）。 */
const gunzip = promisify(gunzipCb);

/** 安装包体积上限（8MiB；与 dsh-desktop 同款）。 */
export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
/** 解包后体积上限（64MiB）—— 防止 zip bomb。 */
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
/** package.json 体积上限（1MiB）。 */
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** 下载超时（60s）。 */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/** 安装期错误（带 HTTP 状态与错误码，界面据此区分「要确认」/「不可用」/「失败」）。 */
export class MarketInstallError extends Error {
	constructor(message, status = 400, code, params) {
		super(message);
		this.name = 'MarketInstallError';
		this.status = status;
		this.code = code;
		this.params = params;
	}
}

const fail = (message, status, code) => { throw new MarketInstallError(message, status, code); };

/**
 * 网络错误只暴露**有界诊断码**（不暴露原始消息/地址：原生错误里可能带签名重定向 URL 或代理凭据 ✗）。
 */
export function networkDiagnostic(error) {
	const codes = new Set();
	const seen = new Set();
	const visit = (value, depth = 0) => {
		if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) { return; }
		seen.add(value);
		if (typeof value.code === 'string' && /^(?:E[A-Z0-9_]{1,63}|UND_ERR_[A-Z0-9_]{1,55})$/.test(value.code)) { codes.add(value.code); }
		if (value.name === 'TimeoutError') { codes.add('TIMEOUT'); }
		if (value.name === 'AbortError') { codes.add('ABORTED'); }
		if (typeof value.message === 'string') {
			const match = value.message.match(/\bnet::(ERR_[A-Z0-9_]{1,60})\b/);
			if (match) { codes.add(match[1]); }
		}
		visit(value.cause, depth + 1);
		if (Array.isArray(value.errors)) { value.errors.slice(0, 8).forEach(item => visit(item, depth + 1)); }
	};
	visit(error);
	return codes.size ? [...codes].join(', ') : 'NETWORK_ERROR';
}

/** 下载一个文件（限体积、限超时、只允许无凭据的 https）。 */
export async function download(url, { fetchImpl, maxBytes = MAX_PACKAGE_BYTES, what = '安装包' } = {}) {
	let address;
	try { address = new URL(url); } catch { fail(`${what}的下载地址无效`, 502, 'invalid_download_url'); }
	if (address.protocol !== 'https:' || address.username || address.password || address.port) {
		fail(`${what}的下载地址必须使用 HTTPS，且不能包含凭据或自定义端口`, 502, 'unsafe_download_url');
	}
	let response;
	try {
		response = await (fetchImpl ?? globalThis.fetch)(url, {
			redirect: 'follow',
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
	} catch (error) {
		fail(`无法下载${what}：${networkDiagnostic(error)}`, 502, 'download_failed');
	}
	if (!response.ok) { fail(`下载${what}返回 HTTP ${response.status}`, 502, 'download_failed'); }
	const declared = Number(response.headers?.get?.('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) { fail(`${what}超过 ${maxBytes} 字节上限`, 502, 'package_too_large'); }
	const reader = response.body?.getReader();
	if (!reader) { fail(`${what}是空的`, 502, 'download_failed'); }
	const chunks = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) { break; }
			length += value.length;
			if (length > maxBytes) {
				await reader.cancel();
				fail(`${what}超过 ${maxBytes} 字节上限`, 502, 'package_too_large');
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof MarketInstallError) { throw error; }
		fail(`下载${what}中断：${networkDiagnostic(error)}`, 502, 'download_interrupted');
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}

/**
 * 从 npm 风格的 .tgz 里读 `package/package.json`（**不落盘**）。
 *
 * 为什么要读：目录里公示的版本/包名必须与包里一致，否则装上去的是另一份东西 ✗。
 */
export async function readPackedManifest(tgz) {
	let tar;
	try { tar = await gunzip(tgz, { maxOutputLength: MAX_UNPACKED_BYTES }); } catch {
		fail('Release 安装包不是合法的 .tgz 文件', 502, 'invalid_package');
	}
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) { break; }
		const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/u, '');
		const size = Number.parseInt(text(124, 12).trim() || '0', 8);
		if (!Number.isSafeInteger(size) || size < 0) { break; }
		const prefix = text(345, 155);
		const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
		const type = text(156, 1);
		if ((type === '0' || type === '') && name.split('/').slice(1).join('/') === 'package.json'
			&& !name.slice(0, name.indexOf('/')).includes('..')) {
			if (size > MAX_MANIFEST_BYTES) { fail('Release 包里的 package.json 太大', 502, 'invalid_package'); }
			try {
				return JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString('utf8'));
			} catch {
				fail('Release 包里的 package.json 不是合法 JSON', 502, 'invalid_package');
			}
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	fail('Release 包里没有 package/package.json', 502, 'invalid_package');
}

/** 核对包里的 name/version 与目录一致（不一致 ⇒ 拒绝装）。 */
export function checkManifest(manifest, entry) {
	if (typeof manifest?.name !== 'string' || !manifest.name) { fail('安装包没有声明 name', 502, 'invalid_package'); }
	const expected = entry?.distribution?.version ?? entry?.version ?? '';
	if (manifest.version !== expected) {
		fail(`安装包版本是 ${manifest.version}，但目录登记的是 ${expected}`, 502, 'version_mismatch');
	}
	return manifest.name;
}

/** 解包文件数上限（防止一个包塞几十万个小文件把磁盘与 inode 打满）。 */
const MAX_PACKAGE_FILES = 5000;

/**
 * 把 npm 风格 .tgz 的 `package/**` **完整解到目录**（2026-10-22）。
 *
 * 为什么要解包、不再交 `file:<tgz>`：
 *   · 装完就删 tgz ⇒ profile 依赖里留下指向**不存在文件**的 `file:` 规格 ⇒ 下次 pnpm 解析整树失败 ✗；
 *   · IDE 那条可靠安装通道（`InstallLocalPlugin` = 暂存进 profile + `dsh plugin add`）收的是**目录**；
 *   · 解出来才看得到客户端入口，能做宿主单例检查（React 打进包里 ⇒ 拒装）。
 * 安全：只收普通文件；路径必须落在 `package/` 之下（拒 `..`、绝对路径、盘符）；总量走 gunzip 上限 + 文件数上限。
 * 返回 `{ files: Map<相对路径, Buffer>, manifest }`（`files` 供检查，调用方不必再读盘）。
 */
export async function extractPackage(tgz, destination) {
	let tar;
	try { tar = await gunzip(tgz, { maxOutputLength: MAX_UNPACKED_BYTES }); } catch {
		fail('Release 安装包不是合法的 .tgz 文件', 502, 'invalid_package');
	}
	const files = new Map();
	let longName = null;
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) { break; }
		const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/u, '');
		const size = Number.parseInt(text(124, 12).trim() || '0', 8);
		if (!Number.isSafeInteger(size) || size < 0) { fail('Release 安装包的 tar 头损坏', 502, 'invalid_package'); }
		const body = tar.subarray(offset + 512, offset + 512 + size);
		const type = text(156, 1);
		const prefix = text(345, 155);
		let name = longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
		longName = null;
		if (type === 'L') { longName = body.toString('utf8').replace(/\0[\s\S]*$/u, ''); }
		else if (type === 'x') { const m = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(body.toString('utf8')); if (m) { longName = m[1]; } }
		else if (type === '0' || type === '') {
			name = name.replace(/\\/g, '/');
			const parts = name.split('/');
			const rel = parts.slice(1).join('/');
			if (parts[0] !== 'package' || !rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || parts.slice(1).some(p => p === '..' || p === '.' || p === '')) {
				fail(`Release 安装包里有不安全的路径：${name.slice(0, 120)}`, 502, 'invalid_package');
			}
			files.set(rel, Buffer.from(body));
			if (files.size > MAX_PACKAGE_FILES) { fail(`Release 安装包文件数超过 ${MAX_PACKAGE_FILES}`, 502, 'package_too_large'); }
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	const raw = files.get('package.json');
	if (!raw) { fail('Release 包里没有 package/package.json', 502, 'invalid_package'); }
	let manifest;
	try { manifest = JSON.parse(raw.toString('utf8')); } catch { fail('Release 包里的 package.json 不是合法 JSON', 502, 'invalid_package'); }
	await rm(destination, { recursive: true, force: true });
	for (const [rel, data] of files) {
		const target = join(destination, ...rel.split('/'));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, data);
	}
	return { files, manifest };
}

/** 包名 → 目录名（scope 的 `/` 换成 `__`；其余只留安全字符）。 */
export function packageDirName(name, version) {
	return `${String(name).replace(/^@/, '').replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '_')}-${String(version).replace(/[^A-Za-z0-9._+-]/g, '_')}`;
}

/** npm 注册表上某个版本的 package.json（只读检查用；拿不到 ⇒ null，不阻断安装）。 */
async function registryManifest(name, version, fetchImpl) {
	try {
		const raw = await download(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`, { fetchImpl, maxBytes: MAX_MANIFEST_BYTES, what: 'npm 包信息' });
		return JSON.parse(raw.toString('utf8'));
	} catch {
		return null;
	}
}

/**
 * 解析**唯一**安装目标。
 *
 * 返回 `{ pluginSpec, dir?, manifest, files?, expectedPluginName, expectedVersion, cleanup }`：
 *   · `dir`（仅 Release）：解好的包目录 —— IDE 安装通道收它；`pluginSpec` 是同一目录的 `file:` 规格（Host 回落用）；
 *   · `manifest`：包里的 package.json（npm 来源取注册表那份，取不到为 null）—— 兼容性 / 单例检查用；
 *   · `files`（仅 Release）：解包后的全部文件（检查客户端入口用，不必再读盘）；
 *   · `cleanup`：删掉**临时**下载（`packagesRoot` 给了 ⇒ 解在持久目录里，不删 ⇒ `file:` 依赖不会悬空）。
 */
export async function resolveInstallTarget(entry, { fetchImpl, temporaryRoot = tmpdir(), packagesRoot } = {}) {
	const distribution = entry?.distribution;
	const type = distribution?.type;
	if (type === 'npm') {
		const name = distribution.name;
		if (!name) { fail('目录条目的 npm 发布源缺包名', 502, 'invalid_distribution'); }
		return {
			pluginSpec: `${name}@${distribution.version}`,
			manifest: await registryManifest(name, distribution.version, fetchImpl),
			expectedPluginName: name,
			expectedVersion: distribution.version,
			cleanup: async () => { },
		};
	}
	if (type === 'github-release') {
		const bytes = await download(distribution.url, { fetchImpl, maxBytes: MAX_PACKAGE_BYTES, what: 'Release 安装包' });
		const digest = createHash('sha256').update(bytes).digest('hex');
		if (digest !== distribution.sha256) {
			fail('下载到的 Release 安装包与目录登记的 SHA-256 不一致', 502, 'checksum_mismatch');
		}
		const name = checkManifest(await readPackedManifest(bytes), entry);
		const temporary = packagesRoot ? null : await mkdtemp(join(temporaryRoot, 'vssaros-wb-release-'));
		const directory = packagesRoot ? join(packagesRoot, packageDirName(name, distribution.version)) : join(temporary, 'package');
		const { files, manifest } = await extractPackage(bytes, directory);
		return {
			pluginSpec: `file:${directory}`,
			dir: directory,
			manifest,
			files,
			expectedPluginName: name,
			expectedVersion: distribution.version,
			cleanup: temporary ? () => rm(temporary, { recursive: true, force: true }) : async () => { },
		};
	}
	if (type === 'github-source') {
		const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(distribution.url || '');
		if (!match) { fail('源码仓库地址无效', 502, 'invalid_distribution'); }
		const [, owner, repo] = match;
		const commit = distribution.commit || entry?.sourceCommit || '';
		if (!commit) { fail('源码发布源缺 commit（无法锁定版本）', 502, 'invalid_distribution'); }
		const manifestUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/package.json`;
		const raw = await download(manifestUrl, { fetchImpl, maxBytes: MAX_MANIFEST_BYTES, what: '仓库里的 package.json' });
		let manifest;
		try { manifest = JSON.parse(raw.toString('utf8')); } catch {
			fail('仓库里的 package.json 不是合法 JSON', 502, 'invalid_package');
		}
		return {
			pluginSpec: `github:${owner}/${repo}#${commit}`,
			manifest,
			expectedPluginName: checkManifest(manifest, entry),
			expectedVersion: distribution.version,
			cleanup: async () => { },
		};
	}
	fail(`暂不支持从 ${type || '(未知)'} 安装`, 502, 'unsupported_distribution');
}
