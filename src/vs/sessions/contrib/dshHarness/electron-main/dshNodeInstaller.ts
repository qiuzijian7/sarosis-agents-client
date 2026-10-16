/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 托管便携 Node：从官方分发（或镜像）下载、校验 SHA-256、解压到 `<managedRoot>/node/`。
 *
 * 只依赖 Node 内置模块与 vs/base（不 import electron）：下载函数由调用方注入 ——
 * 主进程传 `electron.net.fetch`（走系统代理），测试传全局 fetch。
 *
 * 原子性：先解压到 `node.tmp-<pid>`，自检 `node --version` 通过后再整体替换 `node/`；
 * 任何一步失败都不影响已有的托管 Node。
 */

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, promises as fsp } from 'fs';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { join } from '../../../../base/common/path.js';
import { extract } from '../../../../base/node/zip.js';
import { isSupportedNodeVersion } from '../common/dshCli.js';
import { DEFAULT_NODE_MIRROR, INodeDistEntry, joinUrl, managedNodeLayout, nodeArchiveFor, parseShasums, selectNodeVersion } from '../common/dshNodeDist.js';

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>; body?: unknown }>;

export interface INodeInstallOptions {
	readonly managedRoot: string;
	readonly mirror?: string;
	/** 精确版本（如 `22.23.3`）；省略时取满足 dsh 门槛的最新 LTS。 */
	readonly version?: string;
	readonly fetch: FetchLike;
	readonly log: (line: string) => void;
	readonly platform?: string;
	readonly arch?: string;
}

export interface INodeInstallResult {
	readonly version: string;
	readonly path: string;
	readonly mirror: string;
	readonly bytes: number;
}

export function managedNodePath(managedRoot: string, platform: string = process.platform): string {
	return join(managedRoot, 'node', ...managedNodeLayout(platform).node);
}

function nodeVersionOf(exe: string): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile(exe, ['--version'], { timeout: 15_000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined } }, (err, stdout) => {
			resolve(err ? undefined : String(stdout).trim() || undefined);
		});
	});
}

/**
 * Windows：刚执行过的 node.exe、刚写入的文件常被杀毒软件短暂占用，目录改名会 EPERM / EBUSY（实测）。
 * 与 graceful-fs 相同，按退避重试，最长约 10 秒。
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (let delay = 100; ; delay = Math.min(delay * 2, 1_000)) {
		try {
			await fsp.rename(from, to);
			return;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if ((code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || Date.now() > deadline) {
				throw e;
			}
			await new Promise(r => setTimeout(r, delay));
		}
	}
}

function untarGz(archive: string, target: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile('tar', ['-xzf', archive, '-C', target], { timeout: 5 * 60_000 }, err => err ? reject(err) : resolve());
	});
}

/** 下载到文件，同时计算 SHA-256（不把 30 MB 归档整体放进内存）。 */
async function downloadTo(fetchImpl: FetchLike, url: string, file: string): Promise<{ sha256: string; bytes: number }> {
	const res = await fetchImpl(url);
	if (!res.ok) {
		throw new Error(`下载失败 HTTP ${res.status}：${url}`);
	}
	const hash = createHash('sha256');
	const out = createWriteStream(file);
	let bytes = 0;
	const body = res.body as AsyncIterable<Uint8Array> | undefined;
	try {
		if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
			for await (const chunk of body) {
				hash.update(chunk);
				bytes += chunk.byteLength;
				if (!out.write(chunk)) {
					await new Promise<void>(r => out.once('drain', () => r()));
				}
			}
		} else {
			const buf = Buffer.from(await res.arrayBuffer());
			hash.update(buf);
			bytes = buf.byteLength;
			out.write(buf);
		}
	} finally {
		await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => err ? reject(err) : resolve()));
	}
	return { sha256: hash.digest('hex'), bytes };
}

export async function installManagedNode(opts: INodeInstallOptions): Promise<INodeInstallResult> {
	const platform = opts.platform ?? process.platform;
	const arch = opts.arch ?? process.arch;
	const mirror = (opts.mirror?.trim() || DEFAULT_NODE_MIRROR).replace(/\/+$/, '');

	const indexRes = await opts.fetch(joinUrl(mirror, 'index.json'));
	if (!indexRes.ok) {
		throw new Error(`读取 Node 分发索引失败 HTTP ${indexRes.status}：${mirror}`);
	}
	const index = JSON.parse(await indexRes.text()) as INodeDistEntry[];
	const version = selectNodeVersion(index, platform, arch, opts.version);
	if (!version) {
		throw new Error(opts.version
			? `镜像中没有 Node ${opts.version} 的 ${platform}-${arch} 便携包，或该版本低于 dsh 要求（22.19+ / 24+）`
			: `镜像中找不到满足 dsh 要求的 ${platform}-${arch} LTS 便携包`);
	}
	const archive = nodeArchiveFor(version, platform, arch);
	if (!archive) {
		throw new Error(`不支持的平台：${platform}-${arch}`);
	}

	const sumsRes = await opts.fetch(joinUrl(mirror, version, 'SHASUMS256.txt'));
	if (!sumsRes.ok) {
		throw new Error(`读取校验和失败 HTTP ${sumsRes.status}`);
	}
	const expected = parseShasums(await sumsRes.text()).get(archive.fileName);
	if (!expected) {
		throw new Error(`SHASUMS256.txt 中没有 ${archive.fileName}`);
	}

	await fsp.mkdir(opts.managedRoot, { recursive: true });
	const tmpArchive = join(opts.managedRoot, `.${archive.fileName}.${process.pid}.part`);
	const staging = join(opts.managedRoot, `node.tmp-${process.pid}`);
	const final = join(opts.managedRoot, 'node');
	const old = join(opts.managedRoot, `node.old-${process.pid}`);
	await fsp.rm(staging, { recursive: true, force: true });

	try {
		opts.log(`downloading ${archive.fileName} from ${mirror}`);
		const { sha256, bytes } = await downloadTo(opts.fetch, joinUrl(mirror, version, archive.fileName), tmpArchive);
		if (sha256 !== expected) {
			throw new Error(`校验和不符：期望 ${expected}，实际 ${sha256}`);
		}
		opts.log(`verified ${archive.fileName} (${Math.round(bytes / 1024 / 1024)} MB, sha256 ok)`);

		// 原样解压，再取归档内的顶层目录。不用 zip 的 sourcePath 剥前缀：顶层目录条目剥完是空名，
		// vs/base/node/zip 会把它当文件打开（实测 EISDIR）。
		await fsp.mkdir(staging, { recursive: true });
		if (archive.kind === 'zip') {
			await extract(tmpArchive, staging, {}, CancellationToken.None);
		} else {
			await untarGz(tmpArchive, staging);
		}
		const unpacked = join(staging, archive.topDir);
		if (!existsSync(unpacked)) {
			throw new Error(`归档中缺少顶层目录 ${archive.topDir}`);
		}

		const stagedExe = join(unpacked, ...managedNodeLayout(platform).node);
		const actual = await nodeVersionOf(stagedExe);
		if (actual !== version || !isSupportedNodeVersion(actual)) {
			throw new Error(`解压后的 Node 自检失败：期望 ${version}，实际 ${actual ?? '无法执行'}`);
		}
		if (!existsSync(join(unpacked, ...managedNodeLayout(platform).npmCli))) {
			throw new Error('解压后的 Node 缺少 npm');
		}
		await fsp.writeFile(join(unpacked, '.vssaros-node.json'), JSON.stringify({ version, mirror, sha256, installedAt: new Date().toISOString() }, undefined, 2));

		// 原子替换：旧目录先改名，新目录就位后再删旧目录；替换失败时恢复旧目录。
		if (existsSync(final)) {
			await renameWithRetry(final, old);
		}
		try {
			await renameWithRetry(unpacked, final);
		} catch (e) {
			if (existsSync(old)) {
				await renameWithRetry(old, final).catch(() => undefined);
			}
			throw e;
		}
		await fsp.rm(old, { recursive: true, force: true }).catch(() => undefined);
		opts.log(`managed Node ${version} installed at ${final}`);
		return { version, path: managedNodePath(opts.managedRoot, platform), mirror, bytes };
	} finally {
		await fsp.rm(tmpArchive, { force: true }).catch(() => undefined);
		await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
	}
}
