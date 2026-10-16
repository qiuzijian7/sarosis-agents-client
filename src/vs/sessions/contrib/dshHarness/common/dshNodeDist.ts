/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 托管便携 Node 的纯函数部分：从官方分发索引（`<mirror>/index.json`）选版本、
 * 计算归档文件名、解析 `SHASUMS256.txt`。不含 I/O。
 *
 * P0-2：VsSaros 自带的 Electron 39 不能以 RunAsNode 运行 dsh，所以 Node 必须独立；
 * dsh 官方要求 22.19+（22 线）或 24+。
 */

import { compareSemver, isSupportedNodeVersion } from './dshCli.js';

export const DEFAULT_NODE_MIRROR = 'https://nodejs.org/dist';

export interface INodeDistEntry {
	readonly version: string;
	readonly lts: string | false;
	readonly files: readonly string[];
}

export interface INodeArchive {
	/** `v22.23.3` */
	readonly version: string;
	/** `node-v22.23.3-win-x64.zip` */
	readonly fileName: string;
	/** 解压后的顶层目录名：`node-v22.23.3-win-x64` */
	readonly topDir: string;
	readonly kind: 'zip' | 'tar.gz';
}

/** index.json 的 `files` 键 → 归档描述。只支持官方提供便携归档的平台。 */
export function nodeArchiveFor(version: string, platform: string, arch: string): INodeArchive | undefined {
	const a = arch === 'x64' || arch === 'arm64' ? arch : undefined;
	if (!a) {
		return undefined;
	}
	switch (platform) {
		case 'win32':
			return { version, fileName: `node-${version}-win-${a}.zip`, topDir: `node-${version}-win-${a}`, kind: 'zip' };
		case 'darwin':
			return { version, fileName: `node-${version}-darwin-${a}.tar.gz`, topDir: `node-${version}-darwin-${a}`, kind: 'tar.gz' };
		case 'linux':
			return { version, fileName: `node-${version}-linux-${a}.tar.gz`, topDir: `node-${version}-linux-${a}`, kind: 'tar.gz' };
		default:
			return undefined;
	}
}

/** index.json 中表示"该平台有便携归档"的 files 键。 */
export function nodeIndexFileKey(platform: string, arch: string): string | undefined {
	switch (platform) {
		case 'win32': return `win-${arch}-zip`;
		case 'darwin': return `osx-${arch}-tar`;
		case 'linux': return `linux-${arch}`;
		default: return undefined;
	}
}

/**
 * 选版本：只考虑 LTS 且满足 dsh 门槛、并且有当前平台归档的版本，取最新。
 * 传入 `pinned`（如 `22.23.3` / `v24.1.0`）时只接受该版本。
 */
export function selectNodeVersion(index: readonly INodeDistEntry[], platform: string, arch: string, pinned?: string): string | undefined {
	const key = nodeIndexFileKey(platform, arch);
	if (!key) {
		return undefined;
	}
	const want = pinned ? (pinned.startsWith('v') ? pinned : `v${pinned}`) : undefined;
	const candidates = index.filter(e =>
		(want ? e.version === want : !!e.lts)
		&& isSupportedNodeVersion(e.version)
		&& e.files.includes(key));
	return candidates.map(e => e.version).sort(compareSemver).at(-1);
}

/** 解析 `SHASUMS256.txt`（每行 `<64 位十六进制>  <文件名>`）。 */
export function parseShasums(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
		if (m) {
			out.set(m[2], m[1].toLowerCase());
		}
	}
	return out;
}

export function joinUrl(base: string, ...parts: string[]): string {
	return [base.replace(/\/+$/, ''), ...parts.map(p => p.replace(/^\/+|\/+$/g, ''))].join('/');
}

/** 托管 Node 目录内的可执行文件与 npm CLI 相对路径（归档顶层目录已剥离）。 */
export function managedNodeLayout(platform: string): { readonly node: readonly string[]; readonly npmCli: readonly string[] } {
	return platform === 'win32'
		? { node: ['node.exe'], npmCli: ['node_modules', 'npm', 'bin', 'npm-cli.js'] }
		: { node: ['bin', 'node'], npmCli: ['lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'] };
}

/** 给定任意 node 可执行文件的绝对路径，推断随附 npm CLI 的位置（官方安装布局）。 */
export function npmCliCandidates(nodeExecPath: string, platform: string): string[] {
	const sep = platform === 'win32' ? '\\' : '/';
	const dir = nodeExecPath.slice(0, Math.max(nodeExecPath.lastIndexOf('/'), nodeExecPath.lastIndexOf('\\')));
	const up = dir.slice(0, Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\')));
	return platform === 'win32'
		? [[dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'].join(sep)]
		: [[up, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'].join(sep), [dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'].join(sep)];
}
