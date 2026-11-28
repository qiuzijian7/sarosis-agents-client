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
 *
 * ★ 落位不能只靠目录 rename：Windows 上只要待改名目录树里有任一文件被持有句柄（杀软实时扫描 /
 *   文件监视器 / 刚执行过的 node.exe），`MoveFileEx` 就持续 EPERM，重试也不会好。
 *   见 `publishStagedNode()` 的复制兜底。
 */

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, promises as fsp } from 'fs';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { join } from '../../../../base/common/path.js';
import { extract } from '../../../../base/node/zip.js';
import { isSupportedNodeVersion } from '../common/dshCli.js';
import { DEFAULT_NODE_MIRROR, INodeDistEntry, joinUrl, managedNodeLayout, nodeArchiveFor, parseShasums, selectNodeVersion } from '../common/dshNodeDist.js';
import { copyDirectoryConcurrently } from './dshConcurrentCopy.js';

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>; body?: unknown }>;

export interface INodeInstallOptions {
	readonly managedRoot: string;
	readonly mirror?: string;
	/** 精确版本（如 `24.22.3`）；省略时取满足 dsh 门槛的最新 LTS。 */
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

/** Windows 目录 rename 被占用时的错误码（`MoveFileEx` 的访问拒绝 / 共享冲突）。 */
function isLockedError(e: unknown): boolean {
	const code = (e as NodeJS.ErrnoException | undefined)?.code;
	return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/**
 * Windows：刚执行过的 node.exe、刚写入的文件常被杀毒软件短暂占用，目录改名会 EPERM / EBUSY（实测）。
 * 与 graceful-fs 相同，按退避重试；落位处还有复制兜底，所以那里只给 4 秒，不让首启白等。
 */
async function renameWithRetry(from: string, to: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (let delay = 100; ; delay = Math.min(delay * 2, 1_000)) {
		try {
			await fsp.rename(from, to);
			return;
		} catch (e) {
			if (!isLockedError(e) || Date.now() > deadline) {
				throw e;
			}
			await new Promise(r => setTimeout(r, delay));
		}
	}
}

export interface IPublishStagedNodeOptions {
	/** 已解压并自检过的目录（`<managedRoot>/node.tmp-<pid>/node-vX-win-x64`）。 */
	readonly stagedDir: string;
	/** 落位目标（`<managedRoot>/node`）。 */
	readonly finalDir: string;
	/** 旧目录临时名（`<managedRoot>/node.old-<pid>`）。 */
	readonly oldDir: string;
	readonly log: (line: string) => void;
	/** 仅测试注入：模拟 Windows 上 rename 一直被占用。 */
	readonly rename?: (from: string, to: string) => Promise<void>;
	/** 仅测试注入：替换目录复制实现。 */
	readonly copyDir?: (from: string, to: string) => Promise<void>;
}

/**
 * 把自检过的暂存目录落位到 `<managedRoot>/node`。
 *
 * 常规路径：旧目录先改名让位 → 新目录整体 rename（同卷原子），失败可整体回滚。
 *
 * ★ 2026-11-28（真机：别的机器安装包首启 `EPERM: operation not permitted, rename
 *   '…\node.tmp-<pid>\node-v26.13.1-win-x64' -> '…\dsh-runtime\node'`）：
 *   只要待改名目录树里有**任一文件被持有句柄**（杀软实时扫描、文件监视器、刚执行过的
 *   `node.exe`），或目标目录已存在，Windows `MoveFileEx` 就持续 EPERM —— 本机实测仅一个
 *   `open(path, 'r')` 句柄就能让整目录 rename 永久失败，等 10 秒也不会好。
 *   ⇒ 锁类错误不能只重试：退化为**逐文件复制就位** —— 只读源、只在目标新建/覆盖文件，
 *   不需要源目录的「可删除」句柄。项目里 profile 插件层早已因同一原因改成就地覆盖
 *   （`dshHostSupervisor.ts` 的插件同步），此处同口径。
 */
export async function publishStagedNode(opts: IPublishStagedNodeOptions): Promise<void> {
	const { stagedDir, finalDir, oldDir } = opts;
	const rename = opts.rename ?? ((from: string, to: string) => renameWithRetry(from, to, 4_000));
	// dereference: true —— 官方 Linux 包里 bin/npm 等是符号链接，Windows 非管理员建链接会 EPERM
	// （与 copyProfileSeed 同口径）。解引用后它们变成等价的普通文件，node/npm 仍可用。
	const copyDir = opts.copyDir ?? ((from: string, to: string) => copyDirectoryConcurrently(from, to, { dereference: true }));
	const hadFinal = existsSync(finalDir);
	let finalUsable = hadFinal;
	let oldMoved = false;
	try {
		if (hadFinal) {
			await rename(finalDir, oldDir);
			oldMoved = true;
			finalUsable = false;
		}
		await rename(stagedDir, finalDir);
	} catch (e) {
		if (!isLockedError(e)) {
			if (oldMoved) {
				await rename(oldDir, finalDir).catch(() => undefined);
			}
			throw e;
		}
		// 先把旧目录挪回去，让「就地覆盖」从一份完整的 Node 开始；挪不动也没关系，
		// 旧副本留在 oldDir 当备份，下面会重建 finalDir。
		if (oldMoved && !existsSync(finalDir)) {
			try {
				await rename(oldDir, finalDir);
				oldMoved = false;
				finalUsable = true;
			} catch { /* 旧目录同样被占用：保留备份 */ }
		}
		opts.log(`managed Node: 目录 rename 被占用（${(e as NodeJS.ErrnoException).code}）⇒ 改用逐文件复制落位`);
		try {
			await fsp.mkdir(finalDir, { recursive: true });
			await copyDir(stagedDir, finalDir);
			finalUsable = true;
		} catch (copyError) {
			// 目标里没有一份可用 Node 时删掉半成品，避免下次启动把半份目录当成已安装。
			if (!finalUsable) {
				await rmWithRetry(finalDir);
			}
			throw new Error(`托管 Node 落位失败（目录 rename 被占用，逐文件复制也未完成）：${String((copyError as Error)?.message ?? copyError)}`);
		}
	}
	await rmWithRetry(oldDir);
}

/** 同一批文件被占用时 `rm` 也会 EPERM/EBUSY；清理失败不能盖掉「安装已成功」这个结果。 */
async function rmWithRetry(dir: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (let delay = 100; ; delay = Math.min(delay * 2, 500)) {
		try {
			await fsp.rm(dir, { recursive: true, force: true });
			return;
		} catch (e) {
			if (!isLockedError(e) || Date.now() > deadline) {
				return;
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
			? `镜像中没有 Node ${opts.version} 的 ${platform}-${arch} 便携包，或该版本低于 dsh 要求（>=24.9.0）`
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
	await rmWithRetry(staging);

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

		// 落位：优先原子 rename；Windows 上目录被占用时由 publishStagedNode() 退化为逐文件复制。
		await publishStagedNode({ stagedDir: unpacked, finalDir: final, oldDir: old, log: opts.log });
		opts.log(`managed Node ${version} installed at ${final}`);
		return { version, path: managedNodePath(opts.managedRoot, platform), mirror, bytes };
	} finally {
		await fsp.rm(tmpArchive, { force: true }).catch(() => undefined);
		await rmWithRetry(staging);
	}
}
