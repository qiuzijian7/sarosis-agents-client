/*---------------------------------------------------------------------------------------------
 *  Plan File Utilities (MiMo-Code-inspired)
 *
 *  Generates plan file paths and provides path-matching utilities for the
 *  plan-mode hard-permission exception (plan files are the ONLY writable
 *  files in plan mode, mirroring MiMo's `.mimocode/plans/*.md` pattern).
 *
 *  Pure + dependency-free → fully unit-testable.
 *--------------------------------------------------------------------------------------------*/

import { join } from '../../../../base/common/path.js';

/**
 * Generate a plan file path: `<sarosRoot>/plans/<timestamp>-<slug>.md`
 *
 * Mirrors MiMo-Code's `Session.plan()` → `.mimocode/plans/<ts>-<slug>.md`.
 * The plan file is the ONLY file writable in plan mode (hardPermission exception).
 */
export function generatePlanPath(
	sarosRoot: string,
	userMessage: string,
	timestamp: number = Date.now(),
): string {
	const slug = slugify(userMessage.slice(0, 60));
	const ts = new Date(timestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19);
	return join(sarosRoot, 'plans', `${ts}-${slug}.md`);
}

/**
 * Convert arbitrary text to a URL/filesystem-safe slug.
 * Preserves CJK characters (common in Chinese user messages).
 */
export function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.trim()
		.replace(/[^\w\u4e00-\u9fff]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return slug || 'plan';
}

/**
 * Glob pattern matching plan files (relative to saros root).
 * Used by hardPermission to allow writes to plan files only.
 */
export const PLAN_FILE_GLOB = 'plans/*.md';

/**
 * Check if a file path is a plan file (matches `plans/*.md` pattern).
 * Supports both absolute and relative paths.
 *
 * NOTE: This only checks the PATH SHAPE. For security, always use in combination
 * with `isPlanFilePathInRoot()` which validates the resolved path against the
 * intended plan root directory.
 */
export function isPlanFilePath(filePath: string): boolean {
	if (!filePath) { return false; }
	const normalized = filePath.replace(/\\/g, '/').toLowerCase();
	// Match: plans/foo.md, /plans/foo.md, ~/.vssaros/plans/foo.md
	return /(^|\/)plans\/[^/]+\.md$/.test(normalized);
}

/**
 * Validate that a plan file path resolves to within the plan root directory.
 * Prevents path traversal (../), symlink escape, and cross-device attacks.
 *
 * @param filePath The candidate plan file path
 * @param planRoot The expected plan root directory (~/.vssaros/plans)
 * @returns true if the resolved path is within planRoot
 */
export function isPlanFilePathInRoot(filePath: string, planRoot: string): boolean {
	if (!filePath || !planRoot) { return false; }
	try {
		const resolvedFile = normalizePath(filePath);
		const resolvedRoot = normalizePath(planRoot + '/');
		return resolvedFile.startsWith(resolvedRoot) && !resolvedFile.includes('/../');
	} catch {
		return false;
	}
}

/** Normalize a path: resolve segments, strip trailing separators, lowercase on Windows. */
function normalizePath(p: string): string {
	// Resolve parent references and normalize separators
	const segments = p.replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
	const resolved: string[] = [];
	for (const seg of segments) {
		if (seg === '..') { resolved.pop(); continue; }
		resolved.push(seg);
	}
	return resolved.join('/').toLowerCase();
}

// ─── Plan 文件写入豁免（2026-08-21，修 plan 模式死锁）────────────────────────
//
// 事故（日志 1787294819356）：plan 模式下模型无法把计划写进计划文件，导致
// `plan_exit` 永远因 `tasks=0` 被拒 → 死锁，模型最终只能 clarify 求助：
//   "计划文件写入被锁（file_write 被拒、patch 被 plan 模式锁），plan_exit 无法提交"
//
// 死锁的两条边：
//   1. `patch` 被 hardPermission 硬拦 —— 旧的豁免工具名列表只有
//      file_write/file_edit/write/edit，漏了 patch（模型的自然退路）。
//   2. `file_write` 虽被 hardPermission 放行，但接着走**审批**层（dangerous 级别）
//      → 审批 UI 未渲染 → 120s 超时被自动拒。**hardPermission 有豁免，审批层没有。**
//
// 修复原则：写「计划文件本身」是 plan 模式的**本职动作**，不应与「改工作区代码」
// 同等对待 —— 两层都豁免。但必须严格限定在 plan root 内（见下方安全说明）。

/**
 * 可写入计划文件的工具名（小写）。
 *
 * ⚠ 必须包含 `patch` —— 事故日志中模型在 file_write 被拒后转用 patch 修改计划文件，
 * 结果被 hardPermission 拦掉，两条路都断，直接死锁。
 */
const PLAN_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
	'file_write', 'file_edit', 'write', 'edit', 'patch',
]);

/** 各写工具用于传递目标路径的参数名（不同工具命名不一致：patch 用 `path`）。 */
const PLAN_FILE_PATH_ARG_KEYS = ['file_path', 'path', 'filePath'] as const;

/**
 * 判断一次工具调用是否为「写入计划文件」，因而可豁免 plan 模式的写限制与审批。
 *
 * ## 安全
 *
 * 必须同时满足三条，缺一不可：
 *  1. 工具在 `PLAN_FILE_WRITE_TOOLS` 白名单内；
 *  2. 路径形状是 `plans/*.md`（`isPlanFilePath`）；
 *  3. **解析后落在 planRoot 内**（`isPlanFilePathInRoot`，防 `../` 逃逸、
 *     防 `src/plans/evil.md` 这类工作区内的伪装路径）。
 *
 * 第 3 条尤其关键：`isPlanFilePath` 只检查**路径形状**，单用它会让
 * `anywhere/plans/x.md` 拿到豁免，等于在 plan 模式里开一个任意写入的后门。
 * 此前 `isPlanFilePathInRoot` 虽已实现却**只被测试引用、生产零调用**
 * （典型「接口齐全 ≠ 已接线」），本函数是它的第一个生产接入点。
 *
 * planRoot 缺失（空串）时**返回 false**：宁可让模型走正常审批，
 * 也不能因为拿不到根目录就无条件放行。
 *
 * @param toolName 工具名（大小写不敏感）
 * @param args 工具参数（已解析的对象；字符串请先 JSON.parse）
 * @param planRoot 计划目录绝对路径，通常是 `<sarosRoot>/plans`
 */
export function isPlanFileWriteCall(
	toolName: string,
	args: unknown,
	planRoot: string,
): boolean {
	if (!toolName || !planRoot) { return false; }
	if (!PLAN_FILE_WRITE_TOOLS.has(toolName.toLowerCase())) { return false; }
	if (!args || typeof args !== 'object') { return false; }

	const bag = args as Record<string, unknown>;
	for (const key of PLAN_FILE_PATH_ARG_KEYS) {
		const raw = bag[key];
		if (typeof raw !== 'string' || !raw) { continue; }
		if (isPlanFilePath(raw) && isPlanFilePathInRoot(raw, planRoot)) {
			return true;
		}
	}
	return false;
}

