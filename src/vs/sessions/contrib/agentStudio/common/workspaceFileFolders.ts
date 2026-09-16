/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「将文件夹添加到工作区」把新 root **追加**进 `.code-workspace` 的 `folders` 数组。
 *
 * ── 为什么必须是「纯追加」 ────────────────────────────────────────────────
 * 2026-09-14/15 两次「用户资产被程序改坏」事故的形态都是**用窗口的 root 列表覆盖文件**
 * （用户手写的 entries 被清空 / 三根被裁成一根 ✗）。用户 2026-09-16 明确裁决：
 * 加根要**真正写回**原文件，于是口径钉死为：
 *   · 已有 entries **原样保留**（`name` / `uri` / 相对路径等原始写法一个都不动 ✓）；
 *   · 已声明过的路径**跳过**（忽略大小写与尾斜杠）⇒ 幂等，重复添加不会把文件写脏 ✓；
 *   · **只追加**真正新增的 root ✓。
 *
 * 返回的 `folders` 交给 `IJSONEditingService.write(configPath, [{ path: ['folders'], value }], true)` ——
 * 那个通道**只改 `folders` 这一个 key**，`settings` / `launch` / `tasks` / 注释都由容错 JSON
 * 编辑器原样保留 ✓（原生 `StoredWorkspace.setFolders` 用的就是它）。
 */

import { URI } from '../../../../base/common/uri.js';

/** `.code-workspace` 里 `folders[]` 的一条（结构最小子集：只关心我们读写的字段）。 */
export interface IWorkspaceFileFolderEntry {
	/** 目录路径：相对工作区文件或绝对。 */
	readonly path?: string;
	/** 另一种写法：完整 URI（如 `file:///…` 或远程）。 */
	readonly uri?: string;
	/** 显示名（可选，原样保留）。 */
	readonly name?: string;
}

/** 去掉尾部分隔符与大小写差异，仅用于判重。`caseInsensitive` 由调用方按平台决定。 */
export function normalizeFolderPathForCompare(p: string, caseInsensitive: boolean): string {
	const trimmed = p.replace(/[\\/]+$/, '');
	return caseInsensitive ? trimmed.toLowerCase() : trimmed;
}

/** 把相对路径按 `baseDir` 解析成绝对路径（处理 `.` / `..`，两种分隔符都认）。 */
export function resolveFolderPath(baseDir: string, p: string): string {
	// 绝对路径：直接规整。
	if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) {
		return collapseSegments(p);
	}
	const sep = baseDir.includes('\\') ? '\\' : '/';
	return collapseSegments(`${baseDir.replace(/[\\/]+$/, '')}${sep}${p}`);
}

/** 折叠 `.` / `..` 段（不碰盘符与 UNC 前缀）。 */
function collapseSegments(p: string): string {
	const isWin = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
	const sep = isWin || p.includes('\\') ? '\\' : '/';
	const prefixMatch = /^([a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]|\/)/.exec(p);
	const prefix = prefixMatch ? prefixMatch[1] : '';
	const rest = p.slice(prefix.length);
	const out: string[] = [];
	for (const seg of rest.split(/[\\/]+/)) {
		if (!seg || seg === '.') { continue; }
		if (seg === '..') {
			if (out.length > 0) { out.pop(); }
			continue;
		}
		out.push(seg);
	}
	return prefix + out.join(sep);
}

/**
 * `p` 是否位于「工作区文件同目录」之下；是则返回**相对路径**（正斜杠、保留原始大小写）。
 *
 * 归一化只做「去尾斜杠 + 可选小写」，长度与原串一致 ⇒ 可以直接用长度差取回原大小写的尾部 ✓。
 */
function relativeToDir(configDir: string, p: string, caseInsensitive: boolean): string | undefined {
	const dir = normalizeFolderPathForCompare(configDir, caseInsensitive);
	const absOriginal = p.replace(/[\\/]+$/, '');
	const abs = normalizeFolderPathForCompare(absOriginal, caseInsensitive);
	const sep = dir.includes('\\') ? '\\' : '/';
	const prefix = dir + sep;
	if (!abs.startsWith(prefix) || abs.length <= prefix.length) {
		return undefined;
	}
	const tail = absOriginal.slice(absOriginal.length - (abs.length - prefix.length));
	return tail.split(/[\\/]+/).filter(Boolean).join('/');
}

/**
 * 计算「追加后」的 `folders` 数组。
 *
 * @param existingFolders 文件里**现有**的 entries（原样保留）。
 * @param addedFolderPaths 本次新增的 root（绝对路径）。
 * @param configPath `.code-workspace` 文件的绝对路径（用于解析相对条目、决定新条目写法）。
 * @param caseInsensitive Windows/macOS 传 `true`（判重忽略大小写）。
 * @returns `folders` = 可直接写入 `folders` key 的数组；`appended` = 真正追加的绝对路径（空 ⇒ 无需写盘）。
 */
export function planAppendWorkspaceFolders(
	existingFolders: readonly IWorkspaceFileFolderEntry[],
	addedFolderPaths: readonly string[],
	configPath: string,
	caseInsensitive: boolean,
): { folders: IWorkspaceFileFolderEntry[]; appended: string[] } {
	const configDir = configPath.replace(/[\\/][^\\/]*$/, '');

	// 已知 root 的绝对路径（含从相对路径解析出来的）—— 用于判重。
	const known = new Set<string>();
	for (const entry of existingFolders) {
		const abs = entryAbsolutePath(entry, configDir);
		if (abs) {
			known.add(normalizeFolderPathForCompare(abs, caseInsensitive));
		}
	}

	const folders: IWorkspaceFileFolderEntry[] = [...existingFolders];
	const appended: string[] = [];
	for (const raw of addedFolderPaths) {
		if (!raw) { continue; }
		const abs = resolveFolderPath(configDir, raw);
		const key = normalizeFolderPathForCompare(abs, caseInsensitive);
		if (known.has(key)) { continue; } // 已声明 ⇒ 幂等，不追加、也不写盘
		known.add(key);
		// 同目录之下写相对路径（贴近用户手写风格），否则写绝对路径（永不含歧义）。
		const rel = relativeToDir(configDir, abs, caseInsensitive);
		folders.push(rel ? { path: rel } : { path: abs });
		appended.push(abs);
	}

	return { folders, appended };
}

/** 一条既有 entry 的绝对路径（`uri` 优先，其次按文件目录解析 `path`）。 */
function entryAbsolutePath(entry: IWorkspaceFileFolderEntry, configDir: string): string | undefined {
	if (entry.uri) {
		try {
			const parsed = URI.parse(entry.uri);
			return parsed.scheme === 'file' ? parsed.fsPath : undefined; // 远程/其它 scheme 不参与本地判重
		} catch {
			return undefined;
		}
	}
	if (entry.path) {
		return resolveFolderPath(configDir, entry.path);
	}
	return undefined;
}
