/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工作区路径解析与沙箱边界校验 —— 纯函数模块（无 service 依赖，便于单元测试）。
 *
 * 设计借鉴 VS Code 原生 chat 的 `WorkingDirectory.resolveRelativePath`
 * （`workbench/contrib/chat/common/workingDirectory.ts`）：用 URI 层面的
 * `isEqualOrParent` 做边界判定，而非手动 `toLowerCase()` + `startsWith` 的
 * 字符串比较。
 *
 * 为何不再用手动 canonicalize（`p.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase()`）：
 *   1. 一刀切 `toLowerCase()` 在 **大小写敏感的文件系统（Linux）** 上会把
 *      `/Foo/secret` 误判为落在 `/foo` 沙箱内 —— 这是一处真实的越界安全隐患。
 *   2. `extUriBiasedIgnorePathCase` 按 scheme + 平台决定是否忽略大小写
 *      （file scheme 在非 Linux 忽略、Linux 保留），与真实文件系统语义一致。
 *   3. `URI.file()` 统一归一化盘符、正/反斜杠，无需手动处理 `\` vs `/`。
 */

import { URI } from '../../../../base/common/uri.js';
import * as path from '../../../../base/common/path.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';

export interface IWorkspacePathResolution {
	/**
	 * 解析后的路径。相对路径已基于第一个允许根拼接并 `normalize`
	 * （`../` 段在此被折叠，逃逸目录会落到沙箱之外，再由 `isAllowed` 拦截）。
	 * 绝对路径原样返回。
	 */
	readonly resolvedPath: string;
	/** 解析后的路径是否落在任一允许根内（含等于根本身）。 */
	readonly isAllowed: boolean;
	/** 去重 + 去尾分隔符后的允许根列表（保持输入顺序，用于错误提示）。 */
	readonly normalizedRoots: readonly string[];
}

/**
 * 去重 + 去尾部分隔符。仅做字符串级去重以保证错误提示整洁；
 * 即便残留重复项也不影响 `isAllowed` 的正确性（`some` 短路）。
 * 对去尾后为空的退化情况（纯盘符 `G:` / posix 根 `/`）保留原值，避免空根。
 */
function normalizeRoots(roots: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of roots) {
		if (!raw) {
			continue;
		}
		const trimmed = raw.replace(/[\\/]+$/, '') || raw;
		if (seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * 将请求路径解析为绝对路径，并判定其是否落在任一允许根的边界内。
 *
 * 纯函数：不抛错、不读文件、不依赖任何 service —— 沙箱越界的决策权交给调用方
 * （由其根据 `isAllowed` 抛出带上下文的业务错误）。
 *
 * @param requestedPath LLM 请求的文件/目录路径（可为相对，如 `"."` / `"./src"`，
 *                      或绝对，如 Windows `"G:\\repo\\a"` / posix `"/repo/a"`）。
 * @param allowedRoots  允许的沙箱根目录列表（worktree 根或工作区根）。
 */
export function resolveWorkspacePath(requestedPath: string, allowedRoots: readonly string[]): IWorkspacePathResolution {
	const normalizedRoots = normalizeRoots(allowedRoots);

	// 相对路径基于第一个允许根解析为绝对路径；`path.normalize` 折叠 `..` 段。
	let resolvedPath = requestedPath;
	if (!path.isAbsolute(requestedPath) && normalizedRoots.length > 0) {
		resolvedPath = path.normalize(path.join(normalizedRoots[0], requestedPath));
	}

	// 边界判定：用 URI + isEqualOrParent，跨平台正确处理大小写与分隔符。
	const requestedUri = URI.file(resolvedPath);
	const isAllowed = normalizedRoots.some(root =>
		extUriBiasedIgnorePathCase.isEqualOrParent(requestedUri, URI.file(root))
	);

	return { resolvedPath, isAllowed, normalizedRoots };
}
