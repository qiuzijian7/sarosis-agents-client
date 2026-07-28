/*---------------------------------------------------------------------------------------------
 *  去重检测（P3-1，对齐 llm_wiki `src/lib/dedup.ts`）。
 *
 *  确定性检测重复笔记：① 标题归一化碰撞（同文名/同 frontmatter.title）
 *  ② 内容指纹重复（body 前 500 字符指纹 + 长度）。输出报告供手动确认。
 *  不做自动引用重写（高风险，需人工确认），仅检测 + 报告。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { parseFrontmatter } from './frontmatter.js';

export interface DedupGroup {
	key: string;
	notes: URI[];
	reason: 'title-collision' | 'content-fingerprint';
}

const SYS_FILES = new Set(['index.md', 'overview.md', 'insights.md', 'log.md']);
const displayName = (u: URI): string => u.path.split('/').pop()!.replace(/\.(md|markdown)$/i, '');

async function collectMd(fileService: IFileService, dir: URI): Promise<URI[]> {
	const out: URI[] = [];
	const walk = async (u: URI): Promise<void> => {
		const stat = await fileService.resolve(u).catch(() => undefined);
		if (!stat || !stat.children) { return; }
		for (const c of stat.children) {
			if (c.isDirectory) { await walk(c.resource); }
			else if (c.name.toLowerCase().endsWith('.md') && !SYS_FILES.has(c.name)) { out.push(c.resource); }
		}
	};
	await walk(dir);
	return out;
}

function fingerprint(text: string): string {
	const s = text.trim().slice(0, 500);
	const h = Math.abs(s.split('').reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0)).toString(36);
	return `${h}:${s.length}`;
}

/** 检测重复笔记分组。 */
export async function detectDuplicates(fileService: IFileService, notesDir: URI): Promise<DedupGroup[]> {
	const notes = await collectMd(fileService, notesDir);
	const byTitle = new Map<string, URI[]>();
	const byFp = new Map<string, URI[]>();

	for (const n of notes) {
		let content: string;
		try { content = (await fileService.readFile(n)).value.toString(); } catch { continue; }
		const { frontmatter, body } = parseFrontmatter(content);
		const title = (typeof frontmatter?.['title'] === 'string' && frontmatter['title'].trim())
			? frontmatter['title'].trim().toLowerCase()
			: displayName(n).toLowerCase();
		const arr1 = byTitle.get(title) ?? [];
		arr1.push(n);
		byTitle.set(title, arr1);

		const fp = fingerprint(body);
		const arr2 = byFp.get(fp) ?? [];
		arr2.push(n);
		byFp.set(fp, arr2);
	}

	const groups: DedupGroup[] = [];
	const seen = new Set<string>();
	for (const [key, arr] of byTitle) {
		if (arr.length > 1) {
			const gkey = 'title:' + key;
			if (!seen.has(gkey)) { seen.add(gkey); groups.push({ key: `标题碰撞: ${key}`, notes: arr, reason: 'title-collision' }); }
		}
	}
	for (const [key, arr] of byFp) {
		if (arr.length > 1) {
			const gkey = 'fp:' + key;
			if (!seen.has(gkey)) { seen.add(gkey); groups.push({ key: `内容重复: ${key}`, notes: arr, reason: 'content-fingerprint' }); }
		}
	}
	return groups;
}

/** 格式化去重报告。 */
export function formatDedupReport(notesDir: URI, groups: DedupGroup[]): string {
	const out: string[] = [
		'# 知识库去重报告',
		'',
		`> 由 Dedup 确定性生成（${new Date().toISOString()}）。目录：\`${notesDir.fsPath}\``,
		`> 共 **${groups.length}** 组疑似重复（含 ${groups.reduce((s, g) => s + g.notes.length, 0)} 篇笔记）。`,
		'',
		'> 仅检测，未自动合并/重写引用。请人工确认后处理（合并或删除）。',
		'',
	];
	if (groups.length === 0) { out.push('_未检测到重复笔记。_'); return out.join('\n'); }
	for (const g of groups) {
		out.push(`## ${g.key}（${g.notes.length} 篇，${g.reason}）`);
		for (const n of g.notes) { out.push(`- \`${displayName(n)}\` — \`${n.fsPath}\``); }
		out.push('');
	}
	return out.join('\n');
}

export interface MergeResult {
	deleted: URI[];
	rewritten: URI[];
}

/**
 * P3-1：合并一组重复笔记——删除非 keep 的笔记，并把所有指向被删笔记的 `[[wikilink]]`
 * 重写为指向 keep。返回被删笔记与被重写引用的笔记列表。
 *
 * ⚠️ 高风险：会删除笔记并改写其他笔记的 wikilink。**必须由用户确认 keep 项后调用**，
 * 不建议在导入流程自动执行。
 */
export async function mergeDuplicates(
	fileService: IFileService,
	notesDir: URI,
	group: DedupGroup,
	keepUri: URI,
): Promise<MergeResult> {
	// keep 必须在 group 内，否则不操作（避免误删整组）
	if (!group.notes.some(n => n.toString() === keepUri.toString())) {
		return { deleted: [], rewritten: [] };
	}
	const deleted: URI[] = [];
	const deletedNames = new Map<string, string>(); // lower → 原 display
	for (const n of group.notes) {
		if (n.toString() === keepUri.toString()) { continue; }
		deletedNames.set(displayName(n).toLowerCase(), displayName(n));
		deleted.push(n);
	}
	if (deleted.length === 0) { return { deleted, rewritten: [] }; }

	// 1. 删除非 keep 笔记
	for (const n of deleted) {
		await fileService.del(n, { recursive: true }).catch(() => undefined);
	}

	// 2. 重写所有笔记中指向被删笔记的 [[wikilink]] → [[keep]]
	const keepName = displayName(keepUri);
	const allNotes = await collectMd(fileService, notesDir);
	const rewritten: URI[] = [];
	for (const n of allNotes) {
		if (deleted.some(d => d.toString() === n.toString())) { continue; }
		if (n.toString() === keepUri.toString()) { continue; }
		let content: string;
		try { content = (await fileService.readFile(n)).value.toString(); } catch { continue; }
		const { newContent, changed } = rewriteRefs(content, deletedNames, keepName);
		if (changed) {
			await fileService.writeFile(n, VSBuffer.fromString(newContent));
			rewritten.push(n);
		}
	}
	return { deleted, rewritten };
}

/**
 * 纯函数：把 content 中 `[[被删名]]`（含 `[[被删名|别名]]`）重写为 `[[keep名]]`。
 * 同时覆盖 frontmatter 的 related 等 wikilink-list 字段（它们也是笔记间引用）。
 * sources 字段是库文件溯源（`[[库/x.md]]`），不匹配笔记名，不受影响。
 */
export function rewriteRefs(
	content: string,
	deletedNames: Map<string, string>,
	keepName: string,
): { newContent: string; changed: boolean } {
	let changed = false;
	const newContent = content.replace(/\[\[([^\]\n|]+)(?:\|[^\]]+)?\]\]/g, (full, target) => {
		const t = target.trim().toLowerCase();
		if (deletedNames.has(t)) {
			changed = true;
			return `[[${keepName}]]`;
		}
		return full;
	});
	return { newContent, changed };
}
