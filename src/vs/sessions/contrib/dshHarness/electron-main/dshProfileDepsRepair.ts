/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh profile 的**依赖自愈**（★ 2026-10-29）。
 *
 * 现象（本机反复出现）：supervisor 每次装插件都会跑一次 `dsh plugin add`（内部 pnpm add），
 * pnpm 会**重物化整棵依赖树** ⇒ `compression/node_modules/negotiator` 这类**嵌套副本**
 * 会被装成**缺文件**的残次品（缺 `lib/accept.js`）⇒ Host 启动时
 * `dsh-host-webserver` / `dsh-web-app` / `dsh-host-directory-picker-auto` 四个插件
 * import 全挂在同一条 require 栈上 ⇒ `webStartup/connection` 服务起不来
 * ⇒ **Host 直接 exit code 1** ⇒ 桌面窗口只会报「控制桥不可用（未安装伴生插件或 Host 未运行）」。
 *
 * 真机时间线：10:01 / 10:06 / 10:55 三次启动全是同一个错（host 日志字节数一模一样）。
 * ⇒ **不是偶发，是"每次装插件后必坏"** ⇒ 光手工补一次没用（下次装插件又被覆盖）⇒ 必须自愈 ✓。
 *
 * 修法：装完插件之后体检一次 —— 凡是"嵌套副本比顶层同名包少文件"的，
 * 就把顶层那份**补齐**（顶层是 pnpm 装出来的那份，通常完整）⇒ 可重复、自愈 ✓。
 *
 * 为什么不用 `pnpm install` 修：pnpm 正是把它装坏的那一方（重装 = 再坏一次）。
 */

import { promises as fsp } from 'fs';
import { join } from '../../../../base/common/path.js';

/** "嵌套副本相对顶层同名包少了哪些文件"的判定（纯逻辑 ⇒ 可单测 ✓）。 */
export function missingFilesInNestedCopy(nestedFiles: readonly string[], topFiles: readonly string[]): string[] {
	const have = new Set(nestedFiles);
	return topFiles.filter(file => !have.has(file));
}

/** 递归列目录下的文件（相对路径，'/' 分隔；跳过 node_modules/.bin）。 */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
	const out: string[] = [];
	let entries;
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const rel = prefix ? prefix + '/' + entry.name : entry.name;
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '.bin') {
				continue;   // 嵌套依赖单独处理（顶层对照用）
			}
			out.push(...await listFiles(join(dir, entry.name), rel));
		} else {
			out.push(rel);
		}
	}
	return out;
}

/** 顶层包名清单（含 @scope/name 形态）。 */
async function topLevelPackages(nmDir: string): Promise<string[]> {
	const out: string[] = [];
	let entries;
	try {
		entries = await fsp.readdir(nmDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === '.bin' || entry.name === '.pnpm') {
			continue;
		}
		if (entry.name.startsWith('@')) {
			let scoped;
			try {
				scoped = await fsp.readdir(join(nmDir, entry.name), { withFileTypes: true });
			} catch {
				continue;
			}
			for (const sub of scoped) {
				if (sub.isDirectory()) {
					out.push(entry.name + '/' + sub.name);
				}
			}
			continue;
		}
		out.push(entry.name);
	}
	return out;
}

export interface IDepsRepairReport {
	/** 补齐的文件（相对 profile 的 node_modules）。 */
	readonly repaired: readonly string[];
	/** 扫过的嵌套副本数。 */
	readonly scanned: number;
}

/**
 * 体检并修好 profile 的依赖树。
 *
 * @param nmDir profile 的 `node_modules` 目录。
 * @param log 日志（每个修复写一行 ⇒ 真机能直接看出修了什么 ✓）。
 */
export async function repairProfileDeps(nmDir: string, log: (line: string) => void): Promise<IDepsRepairReport> {
	const repaired: string[] = [];
	let scanned = 0;
	const top = await topLevelPackages(nmDir);
	const topFiles = new Map<string, readonly string[]>();
	for (const pkg of top) {
		topFiles.set(pkg, await listFiles(join(nmDir, pkg)));
	}
	for (const pkg of top) {
		const nestedDir = join(nmDir, pkg, 'node_modules');
		let nested;
		try {
			nested = await fsp.readdir(nestedDir, { withFileTypes: true });
		} catch {
			continue;   // 没有嵌套依赖 ⇒ 无事可做 ✓
		}
		for (const entry of nested) {
			if (!entry.isDirectory() || entry.name === '.bin') {
				continue;
			}
			const names = entry.name.startsWith('@')
				? await topLevelPackages(nestedDir).then(all => all.filter(n => n.startsWith(entry.name + '/')))
				: [entry.name];
			for (const name of names) {
				const topFilesOf = topFiles.get(name);
				if (!topFilesOf || topFilesOf.length === 0) {
					continue;   // 顶层没有同名包 ⇒ 无从对照 ✓
				}
				scanned += 1;
				const nestedPath = join(nestedDir, name);
				const have = await listFiles(nestedPath);
				const missing = missingFilesInNestedCopy(have, topFilesOf);
				for (const file of missing) {
					const from = join(nmDir, name, file);
					const to = join(nestedPath, file);
					try {
						await fsp.mkdir(join(to, '..'), { recursive: true });
						await fsp.copyFile(from, to);
						repaired.push(pkg + '/node_modules/' + name + '/' + file);
						log(`deps-repair: 补齐 ${pkg}/node_modules/${name}/${file}（嵌套副本缺文件 ⇒ 会让 Host 的插件 import 失败 ✗）`);
					} catch {
						// best effort：补不上就让它在 Host 的失败日志里显形
					}
				}
			}
		}
	}
	return { repaired, scanned };
}
