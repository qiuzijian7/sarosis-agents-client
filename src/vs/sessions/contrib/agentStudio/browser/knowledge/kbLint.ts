/*---------------------------------------------------------------------------------------------
 *  知识库结构校验（P3-2，对齐 llm_wiki `src/lib/lint.ts`）。
 *
 *  确定性 lint（不依赖 LLM）：检测断链、孤立笔记、缺 sources 溯源，
 *  输出结构化 issue 列表与可读报告。可由 KB 视图「体检」入口或定时任务触发。
 *
 *  扫描根为 `库/` 分区（笔记与库源文件混居模型）：
 *  - 「笔记」= frontmatter 含 `sources` 或 `status` 字段（引擎产出）→ 跑全部规则；
 *  - 「库源文件」= 无 frontmatter，或仅带导入元数据 → 只作为链接目标，不 lint（避免噪音）。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { dirname } from '../../../../../base/common/resources.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { parseFrontmatter, extractSources, type FrontmatterValue } from './frontmatter.js';

export type KbLintSeverity = 'error' | 'warning' | 'info';

export interface KbLintIssue {
	note: URI;
	severity: KbLintSeverity;
	rule: string;
	message: string;
}

const SYS_FILES = new Set(['index.md', 'overview.md', 'insights.md', 'log.md', 'lint-report.md', 'dedup-report.md']);
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

const displayName = (u: URI): string => u.path.split('/').pop()!.replace(/\.(md|markdown)$/i, '');
const normName = (raw: string): string => raw.split(/[|#]/)[0].trim().replace(/\.(md|markdown)$/i, '').toLowerCase().replace(/\s+/g, '-');

/** 递归收集目录下全部 .md（排除系统维护文件）。 */
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

/** 判定「笔记」：frontmatter 含 `sources` 或 `status` 字段（引擎两阶段抽取产出的规整笔记）。 */
function isNoteFrontmatter(fm: Record<string, FrontmatterValue> | null): boolean {
	return !!fm && ('sources' in fm || 'status' in fm);
}

/**
 * 对扫描根（`库/` 分区，笔记与库源文件混居）跑确定性 lint。
 * 兼容旧「笔记」分区目录：库源文件仅作为链接目标登记，不参与规则检查。
 */
export async function lintVault(fileService: IFileService, scanRoot: URI): Promise<KbLintIssue[]> {
	const allMd = await collectMd(fileService, scanRoot);
	const nameToUri = new Map<string, URI>();
	for (const n of allMd) { nameToUri.set(normName(displayName(n)), n); }

	// 读取 + 分类：笔记 vs 库源文件
	const notes: { uri: URI; body: string; content: string }[] = [];
	for (const n of allMd) {
		let content: string;
		try { content = (await fileService.readFile(n)).value.toString(); } catch { continue; }
		const { frontmatter, body } = parseFrontmatter(content);
		if (isNoteFrontmatter(frontmatter)) { notes.push({ uri: n, body, content }); }
	}

	const issues: KbLintIssue[] = [];
	// 图统计（用于孤立检测，仅统计笔记之间的链）
	const outDeg = new Map<string, number>();
	const inDeg = new Map<string, number>();
	for (const n of notes) { outDeg.set(n.uri.toString(), 0); inDeg.set(n.uri.toString(), 0); }

	// 带路径链接目标（如 [[库/概念/x/y.html]]）的存在性探测缓存
	const vaultRoot = dirname(scanRoot);
	const existsCache = new Map<string, boolean>();
	const pathTargetExists = async (rawTarget: string): Promise<boolean> => {
		const clean = rawTarget.split(/[|#]/)[0].trim();
		if (!clean || clean.includes('..')) { return false; }
		const cached = existsCache.get(clean);
		if (cached !== undefined) { return cached; }
		const parts = clean.split('/').filter(Boolean);
		const candidates: URI[] = [];
		for (const base of [vaultRoot, scanRoot]) {
			candidates.push(URI.joinPath(base, ...parts));
			if (!/\.[a-z0-9]+$/i.test(clean)) { candidates.push(URI.joinPath(base, ...parts.slice(0, -1), parts[parts.length - 1] + '.md')); }
		}
		let ok = false;
		for (const c of candidates) {
			if (await fileService.resolve(c).then(() => true, () => false)) { ok = true; break; }
		}
		existsCache.set(clean, ok);
		return ok;
	};

	for (const { uri: n, body, content } of notes) {
		// 规则 1：断链（[[x]] 目标不存在——先按文件名匹配，带路径的目标再按 vault 相对路径探测）
		const links = extractWikilinks(body);
		for (const l of links) {
			const tn = normName(l);
			if (!tn || nameToUri.has(tn)) { continue; }
			const base = normName(l.split(/[|#]/)[0].split('/').pop() ?? '');
			if (base && nameToUri.has(base)) { continue; }
			if (l.includes('/') && await pathTargetExists(l)) { continue; }
			issues.push({ note: n, severity: 'warning', rule: 'broken-link', message: `断链 [[${l}]]` });
		}
		// 出度（仅指向库内笔记的链）
		const selfId = n.toString();
		const seen = new Set<string>();
		for (const l of links) {
			const target = nameToUri.get(normName(l)) ?? nameToUri.get(normName(l.split(/[|#]/)[0].split('/').pop() ?? ''));
			if (target && target.toString() !== selfId && !seen.has(target.toString())) {
				seen.add(target.toString());
				outDeg.set(selfId, (outDeg.get(selfId) ?? 0) + 1);
				if (inDeg.has(target.toString())) { inDeg.set(target.toString(), (inDeg.get(target.toString()) ?? 0) + 1); }
			}
		}

		// 规则 2：缺 sources 溯源
		if (extractSources(content).length === 0) {
			issues.push({ note: n, severity: 'info', rule: 'no-sources', message: '笔记缺少 sources 溯源（未关联库源文件）' });
		}
	}

	// 规则 3：孤立笔记（无入链无出链）
	for (const { uri: n } of notes) {
		const id = n.toString();
		if ((outDeg.get(id) ?? 0) === 0 && (inDeg.get(id) ?? 0) === 0) {
			issues.push({ note: n, severity: 'info', rule: 'orphan', message: '孤立笔记（无入链无出链）' });
		}
	}

	return issues;
}

function extractWikilinks(body: string): string[] {
	const out: string[] = [];
	let m: RegExpExecArray | null;
	const re = new RegExp(WIKILINK_RE);
	while ((m = re.exec(body))) { out.push(m[1]); }
	return out;
}

/** 把 issue 列表格式化为可读的 lint 报告 markdown。 */
export function formatLintReport(notesDir: URI, issues: KbLintIssue[]): string {
	const bySeverity = new Map<KbLintSeverity, KbLintIssue[]>();
	for (const i of issues) {
		const arr = bySeverity.get(i.severity) ?? [];
		arr.push(i);
		bySeverity.set(i.severity, arr);
	}
	const out: string[] = [
		'# 知识库体检报告',
		'',
		`> 由 KbLint 确定性生成（${new Date().toISOString()}）。目录：\`${notesDir.fsPath}\``,
		`> 共 **${issues.length}** 项（error ${bySeverity.get('error')?.length ?? 0} / warning ${bySeverity.get('warning')?.length ?? 0} / info ${bySeverity.get('info')?.length ?? 0}）`,
		'',
	];
	const order: KbLintSeverity[] = ['error', 'warning', 'info'];
	const label: Record<KbLintSeverity, string> = { error: '错误', warning: '警告', info: '提示' };
	for (const sev of order) {
		const arr = bySeverity.get(sev);
		if (!arr || arr.length === 0) { continue; }
		out.push(`## ${label[sev]}（${arr.length}）`);
		for (const i of arr) {
			const name = displayName(i.note);
			out.push(`- \`${name}\` — [${i.rule}] ${i.message}`);
		}
		out.push('');
	}
	if (issues.length === 0) { out.push('_体检通过，未发现问题。_'); }
	return out.join('\n');
}
