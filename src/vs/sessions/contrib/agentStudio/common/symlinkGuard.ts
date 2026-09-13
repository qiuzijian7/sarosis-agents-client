/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { resolveWorkspacePath } from './workspacePathResolver.js';

/**
 * 符号链接逃逸防护 —— **best-effort 真实路径解析**（2026-09-13）。
 *
 * ## 缺口
 *
 * 沙箱边界（`workspacePathResolver`，URI + `isEqualOrParent`）与写黑名单
 * （`writeDenyList`，「纯函数、零 Node 依赖」）**都是纯词法判定** —— 它们
 * **不解析符号链接**。于是下面这一条链可以完全绕开写入侧的全部护栏：
 *
 * ```
 * <workspace>/evil   --symlink-->   ~/.vssaros/User
 * file_write("<workspace>/evil/settings.json")
 * ```
 *
 * 四条判定**全部落空**：
 *   · 沙箱：词法上在允许根内 ✓ 放行；
 *   · `writeDenyList`：按**词法**路径查 `~/.vssaros/User` → 不命中 ✗；
 *   · `sensitiveWriteRejection`：同上 ✗；
 *   · `isProtectedPath`：同上 ✗。
 * ⇒ 最终落到 `isSandboxFileWriteAutoApproved` → **免审批改写 provider apiKey**。
 *
 * ## 本模块的职责（刻意最小）
 *
 * 只做「把词法路径换成真实路径」这一件事，且**失败一律原样返回**：
 *   · 目标不存在（典型：新建文件）→ 逐级向上找**最深的已存在祖先**，解析它，
 *     再把剩余路径段拼回去；
 *   · 任何一步抛错 / 超过 `maxDepth` → 返回原路径。
 *
 * ⇒ 接入它是 **fail-safe** 的：只有「真实路径确实与词法路径不同」（即真的存在
 * symlink）时才可能改变判定；解析失败时行为与不调用本函数**完全一致**。
 *
 * ## 为什么必须连**允许根**一起解析
 *
 * 否则会引入误拒：macOS 上 `/tmp` 是 `/private/tmp` 的符号链接 —— 若只解析目标
 * 不解析根，一个位于 `/tmp/foo` 的工作区会被判成「越界」。故提供
 * {@link realRootsBestEffort}，两侧用同一把尺。
 *
 * ## 不负责什么
 * 不判「是否越界」、不抛错、不读配置 —— 判定仍由 `workspacePathResolver` 做，
 * 本模块只提供「更真实的那条路径」。
 */

/**
 * 注入的 realpath 实现（**唯一**允许的形态）。
 *
 * ⚠ 返回类型是 `Promise<URI | undefined>`，**不是** `Promise<URI>` —— 本项目的
 * `IFileService.realpath` 在「路径不存在 / 平台不支持」时**不抛错，而是返回 undefined**
 * （实测：`workspaceSecurity` 的 4 个调用点曾因写成 `Promise<URI>` 而全部类型不匹配）。
 *
 * 本模块把两种失败形态（**抛错** 与 **返回 undefined**）视为**语义相同** ——
 * 一律按「该级解析失败 → 上溯一级」处理。这样调用方无需各自记得补 `?? u`
 * （那正是「N 处手写 ⇒ 漂移」的典型场景）。
 */
export type RealPathFn = (uri: URI) => Promise<URI | undefined>;

/**
 * 解析真实路径（best-effort）。
 *
 * @param realpath 由调用方注入（生产传 `uri => fileService.realpath(uri)`）——
 *   注入而非直接依赖 `IFileService`，使本模块**可单测**（纯逻辑 + 一个桩函数）。
 * @param p 待解析路径（词法）。
 * @param maxDepth 向上回溯的最多层数（防御性上限，避免病态路径下空转）。
 * @returns 真实路径；无法解析时**原样返回** `p`。
 */
export async function realPathBestEffort(
	realpath: RealPathFn,
	p: string,
	maxDepth: number = 40,
): Promise<string> {
	if (!p) { return p; }
	let cur = p;
	/** 已被剥掉、待拼回的路径段（从近到远）。 */
	const tail: string[] = [];
	for (let i = 0; i < maxDepth; i++) {
		let real: URI | undefined;
		try {
			real = await realpath(URI.file(cur));
		} catch {
			real = undefined; // 抛错与 undefined 同义：该级解析失败
		}
		if (real) {
			// 把剥掉的段按**原顺序**拼回（tail 是自近及远推入的，故逆序取出）
			let joined = real;
			for (let j = tail.length - 1; j >= 0; j--) {
				joined = URI.joinPath(joined, tail[j]);
			}
			return joined.fsPath;
		}
		// 该级不存在（或平台不支持 realpath）→ 上溯一级
		const parent = cur.replace(/[\\/][^\\/]*$/, '');
		if (!parent || parent === cur) { return p; } // 到顶了仍失败 → 放弃
		tail.push(cur.slice(parent.length).replace(/^[\\/]+/, ''));
		cur = parent;
	}
	return p;
}

/**
 * 解析真实路径后，判断它**是否仍落在允许根内**。
 *
 * 用途：沙箱里那些**不是主出口**的 return（例如 P2 结构自愈的 `return repaired`）。
 * 这类出口极易被漏掉 —— 自愈用 `exists` 验证，而 `exists` **会跟随 symlink**
 * （`<ws>/link -> ~/.ssh` 下 `link/id_rsa` 判为存在），于是「自愈 → 返回」就成了
 * 绕过 {@link realPathBestEffort} 防护的第二条路。
 *
 * @returns 真实路径下的边界判定结果；**解析失败时退回词法判定**（fail-safe：
 *          与不调用本函数完全一致，不会凭空拒绝）。
 */
export async function realPathAllowedWithinRoots(
	realpath: RealPathFn,
	p: string,
	roots: readonly string[],
): Promise<boolean> {
	const real = await realPathBestEffort(realpath, p);
	if (real === p) {
		// 解析失败 → 退回词法判定（fail-safe）
		return resolveWorkspacePath(p, roots).isAllowed;
	}
	const realRoots = await realRootsBestEffort(realpath, roots);
	return resolveWorkspacePath(real, realRoots).isAllowed;
}

/**
 * 批量解析允许根的真实路径（best-effort，去尾分隔符）。
 *
 * 与 {@link realPathBestEffort} 配对使用：**两侧都解析**才不会误拒
 * （见模块头注释里 macOS `/tmp` 的例子）。
 */
export async function realRootsBestEffort(
	realpath: RealPathFn,
	roots: readonly string[],
): Promise<string[]> {
	const out: string[] = [];
	for (const r of roots) {
		const real = await realPathBestEffort(realpath, r);
		out.push(real.replace(/[\\/]+$/, ''));
	}
	return out;
}
