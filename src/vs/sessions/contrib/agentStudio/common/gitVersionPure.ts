/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Git 版本管理的**纯函数**（无 fs / 无 git / 无 DI），renderer 与主进程共用。
 *
 * 放在 common 是为了让 `browser/gitVersionCore.ts`（渲染侧门面，需对外导出
 * `parseUnifiedDiff` / `simpleDiffText` 等）与 `node/gitVersionEngine.ts`
 * （主进程实现，需 `joinRepoPath` / `defaultAutoMessage` / `simpleDiffResult`）
 * 共享同一份实现，避免两侧漂移。
 */

import * as path from '../../../../base/common/path.js';
import type { GitDiffHunk, GitDiffLine, GitDiffResult } from './gitVersionBackend.js';

/**
 * 拼接仓库内路径。使用 VS Code 自带的 path 实现（`vs/base/common/path`），
 * 沙箱 renderer 与主进程均可用，无需 Node `require('path')`。
 */
export function joinRepoPath(dir: string, ...parts: string[]): string {
	return path.join(dir, ...parts);
}

/** 默认自动提交消息（UTC）：`auto: 2026-07-31 12:34:56` */
export function defaultAutoMessage(): string {
	const now = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	return `auto: ${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())} ${p(now.getUTCHours())}:${p(now.getUTCMinutes())}:${p(now.getUTCSeconds())}`;
}

/** 解析 unified diff 文本为结构化 hunks（跳过 +++/---/diff/index 头行）。 */
export function parseUnifiedDiff(unified: string): GitDiffHunk[] {
	const hunks: GitDiffHunk[] = [];
	let current: GitDiffHunk | null = null;
	for (const line of unified.split('\n')) {
		const hm = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
		if (hm) {
			current = { oldStart: +hm[1], oldLines: +hm[2], newStart: +hm[3], newLines: +hm[4], lines: [] };
			hunks.push(current);
			continue;
		}
		if (!current) { continue; }
		if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('\\ ')) { continue; }
		if (line.startsWith('+')) { current.lines.push({ kind: 'add', text: line.slice(1) }); }
		else if (line.startsWith('-')) { current.lines.push({ kind: 'remove', text: line.slice(1) }); }
		else if (line.startsWith(' ')) { current.lines.push({ kind: 'context', text: line.slice(1) }); }
	}
	return hunks;
}

/** 无 diff 库时的结构化兜底（返回完整 GitDiffResult）。 */
export function simpleDiffResult(fromSha: string | null, toSha: string, oldContent: string, newContent: string): GitDiffResult {
	const oldLines = oldContent.split('\n');
	const newLines = newContent.split('\n');
	const lines: GitDiffLine[] = [];
	const maxLen = Math.max(oldLines.length, newLines.length);
	for (let i = 0; i < maxLen; i++) {
		const ol = oldLines[i]; const nl = newLines[i];
		if (i < oldLines.length && i < newLines.length) {
			if (ol === nl) { lines.push({ kind: 'context', text: ol }); }
			else { lines.push({ kind: 'remove', text: ol }); lines.push({ kind: 'add', text: nl }); }
		} else if (i < oldLines.length) { lines.push({ kind: 'remove', text: ol }); }
		else { lines.push({ kind: 'add', text: nl }); }
	}
	const hunk: GitDiffHunk = { oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length, lines };
	const unified = lines.map(l => (l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' ') + l.text).join('\n');
	return { fromSha, toSha, hunks: [hunk], unified };
}

/** 逐行 diff 的纯文本形式（`+`/`-`/两空格前缀），兼容旧 agent/workflow 导出与测试。 */
export function simpleDiffText(oldText: string, newText: string): string {
	const oldLines = oldText.split('\n');
	const newLines = newText.split('\n');
	const result: string[] = [];
	const maxLen = Math.max(oldLines.length, newLines.length);
	for (let i = 0; i < maxLen; i++) {
		const ol = oldLines[i] ?? '';
		const nl = newLines[i] ?? '';
		if (ol === nl) { result.push(`  ${ol}`); }
		else {
			if (ol) { result.push(`- ${ol}`); }
			if (nl) { result.push(`+ ${nl}`); }
		}
	}
	return result.join('\n');
}
