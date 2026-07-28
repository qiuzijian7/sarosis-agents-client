/*---------------------------------------------------------------------------------------------
 *  审核队列（P2-1，对齐 llm_wiki `review-store`）。
 *
 *  低置信度归类/抽取结果先写入 `<vault>/.review/` 待人工确认，确认后移动到正式分区。
 *  触发点 TODO：当前 agent 归类不返回置信度，需后续在 agent 返回结构化置信度或
 *  由 kbLint 检测低质量笔记时调用 writeReviewNote。本模块提供后端工具与 API。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import type { KbLintIssue, KbLintSeverity } from './kbLint.js';

/** 审核目录：<vault>/.review/ */
export function reviewDir(vaultRoot: URI): URI {
	return URI.joinPath(vaultRoot, '.review');
}

/** 写入待审核笔记。<id> 通常是 `<date>_<hash>.md`。 */
export async function writeReviewNote(
	fileService: IFileService,
	vaultRoot: URI,
	id: string,
	content: string,
): Promise<URI> {
	const dir = reviewDir(vaultRoot);
	await fileService.createFolder(dir).catch(() => undefined);
	const uri = URI.joinPath(dir, id);
	await fileService.writeFile(uri, VSBuffer.fromString(content));
	return uri;
}

/** 列出待审核笔记。 */
export async function listReviewNotes(fileService: IFileService, vaultRoot: URI): Promise<URI[]> {
	const dir = reviewDir(vaultRoot);
	const stat = await fileService.resolve(dir).catch(() => undefined);
	if (!stat || !stat.children) { return []; }
	return stat.children.filter(c => !c.isDirectory && c.name.toLowerCase().endsWith('.md')).map(c => c.resource);
}

/**
 * 确认审核笔记：从 .review/<id> 移动到 destDir/<id>，删除原审核文件。
 * 返回目标 URI。调用方负责后续 maintainKbNavigation 刷新。
 */
export async function approveReviewNote(
	fileService: IFileService,
	vaultRoot: URI,
	id: string,
	destDir: URI,
): Promise<URI> {
	const src = URI.joinPath(reviewDir(vaultRoot), id);
	const content = (await fileService.readFile(src)).value.toString();
	await fileService.createFolder(destDir).catch(() => undefined);
	const dest = URI.joinPath(destDir, id);
	await fileService.writeFile(dest, VSBuffer.fromString(content));
	await fileService.del(src).catch(() => undefined);
	return dest;
}

export interface RouteLintResult {
	/** 已移入 .review/ 的笔记（返回其审核队列 URI）。 */
	routed: URI[];
	/** 因严重度低于阈值或已隔离而跳过的笔记数。 */
	skipped: number;
}

const REVIEW_SEV_RANK: Record<KbLintSeverity, number> = { info: 1, warning: 2, error: 3 };

/**
 * P1 人环（落实本模块顶部 TODO）：kbLint 检出低质量笔记时，将其隔离进 `.review/` 审核队列，
 * 等待人工确认/修正后通过 `approveReviewNote` 回流。采用与视图 `_moveToReview` 一致的「隔离」模型：
 * 在笔记内容前注入 `review_reason` 注释，复制到 .review/<name> 后删除原笔记。
 *
 * 幂等：仅处理 max(severity) ≥ threshold 的笔记；路径已含 `/.review/` 的笔记视为已隔离，跳过。
 * @param threshold 隔离阈值（默认 `warning`：broken-link/error 触发；`info` 的 no-sources/orphan 不自动隔离，避免过度打扰）。
 */
export async function routeLintToReview(
	fileService: IFileService,
	vaultRoot: URI,
	issues: KbLintIssue[],
	threshold: KbLintSeverity = 'warning',
): Promise<RouteLintResult> {
	const maxSev = new Map<string, KbLintSeverity>();
	const byNote = new Map<string, KbLintIssue[]>();
	for (const i of issues) {
		const k = i.note.toString();
		const arr = byNote.get(k) ?? [];
		arr.push(i);
		byNote.set(k, arr);
		const cur = maxSev.get(k);
		if (!cur || REVIEW_SEV_RANK[i.severity] > REVIEW_SEV_RANK[cur]) { maxSev.set(k, i.severity); }
	}
	const routed: URI[] = [];
	let skipped = 0;
	for (const [k, sev] of maxSev) {
		if (REVIEW_SEV_RANK[sev] < REVIEW_SEV_RANK[threshold]) { skipped++; continue; }
		const noteUri = URI.parse(k);
		if (noteUri.path.includes('/.review/')) { skipped++; continue; }
		try {
			const content = (await fileService.readFile(noteUri)).value.toString();
			const name = noteUri.path.split('/').pop() ?? 'note.md';
			const summary = byNote.get(k)!.map(i => `- [${i.rule}] ${i.message}`).join('\n');
			const header = `<!-- review_reason:\n${summary}\n-->\n\n`;
			await writeReviewNote(fileService, vaultRoot, name, header + content);
			await fileService.del(noteUri, { recursive: true }).catch(() => undefined);
			routed.push(URI.joinPath(reviewDir(vaultRoot), name));
		} catch { skipped++; }
	}
	return { routed, skipped };
}
