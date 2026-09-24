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
 * 对扫描根跑确定性 lint。
 *
 * 语义（2026-09-23 起）：`scanRoot` = **笔记区**（知识体系层，构建产物落这里），
 * `sourceRoot` = **库**（数据源层）。二者分离后，笔记里的 `sources` 与 `[[库内路径]]`
 * 都指向扫描根**之外** ⇒ 必须显式告知来源目录，否则规则 1/4 会把所有来源误报为「已失效」。
 *
 * 兼容两种布局：只传 `scanRoot` 时退化为旧的「笔记与源文件混居」模型（规则 1 用
 * `vaultRoot` + `scanRoot` 两个基准探测路径即可覆盖）。
 */
export async function lintVault(fileService: IFileService, scanRoot: URI, sourceRoot?: URI): Promise<KbLintIssue[]> {
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
		// ★ 2026-09-23：多一个 `sourceRoot`（库）基准 —— 笔记里的来源链接形如 `[[raw/x.md]]`，
		//   那是**库内相对路径**；扫描根变成笔记区后，只有加上库这个基准才解析得到。
		for (const base of [vaultRoot, scanRoot, ...(sourceRoot ? [sourceRoot] : [])]) {
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

	// 规则 4：**来源已失效**（2026-09-23）
	// 背景：库源文件被删除后（尤其「在系统资源管理器/手机端删」——不经知识库视图，没有删除收口），
	// 笔记 frontmatter 的 `sources` 会留着已不存在的文件名。原来没有任何规则管这件事：
	//  · 规则 2 的 `no-sources` 只查「**有没有** sources」，不查「**在不在**」；
	//  · 规则 1 的 `broken-link` 只看**正文**的 `[[x]]`，而 sources 是 frontmatter 字段。
	// ⚠ 口径：`extractSources` 归一为**小写 basename（带扩展名）**，不能用 `nameToUri`
	//   （它经 `normName` 把扩展名去掉了）⇒ 这里单独建一份「现有文件名（小写）」集合。
	const existingBasenames = new Set<string>();
	for (const n of allMd) { existingBasenames.add((n.path.split('/').pop() ?? '').toLowerCase()); }
	// ★ 2026-09-23：来源文件住**库**（`sourceRoot`），不在扫描根（笔记区）里 ——
	//   不把库的文件名并进来，每一条 `sources` 都会被误报成「来源已失效」。
	if (sourceRoot) {
		for (const n of await collectMd(fileService, sourceRoot)) {
			existingBasenames.add((n.path.split('/').pop() ?? '').toLowerCase());
		}
	}
	for (const { uri: n, content } of notes) {
		const missing = extractSources(content).filter(s => !existingBasenames.has(s));
		if (missing.length > 0) {
			issues.push({
				note: n, severity: 'warning', rule: 'missing-source',
				message: `来源已失效（源文件不存在）：${missing.join('、')}`,
			});
		}
	}

	// 规则 5：**构建缓存孤儿**（2026-09-23）
	issues.push(...await collectStaleCacheIssues(fileService, scanRoot));

	return issues;
}

/**
 * 规则 5 的实现：读 `<vault>/.kb-build-cache.json`（`{源绝对路径: 已建笔记绝对路径}`），
 * 报告其中「源」或「笔记」已不存在的条目。
 *
 * 为什么重要：缓存是**纯路径映射、不看内容**，且只有在「知识库视图内删除」时才被收口清理；
 * 在系统资源管理器里删文件则会永久残留 ⇒
 *  · 源条目残留 → 同名素材重新出现时被误判「已构建」而跳过重建；
 *  · 笔记条目残留 → `_buildAllPendingCore` 的 pending 过滤会把它的源**永久**排除，删了笔记就再也建不出来。
 */
async function collectStaleCacheIssues(fileService: IFileService, scanRoot: URI): Promise<KbLintIssue[]> {
	const out: KbLintIssue[] = [];
	const cacheUri = URI.joinPath(dirname(scanRoot), '.kb-build-cache.json');
	let cache: Record<string, string>;
	try {
		cache = JSON.parse((await fileService.readFile(cacheUri)).value.toString());
	} catch {
		return out; // 无缓存文件 / 解析失败 ⇒ 不算问题
	}
	if (!cache || typeof cache !== 'object') { return out; }

	const exists = async (p: string): Promise<boolean> => fileService.resolve(URI.file(p)).then(() => true, () => false);
	let missingSources = 0;
	let missingNotes = 0;
	for (const [src, note] of Object.entries(cache)) {
		if (typeof note !== 'string') { continue; }
		if (!(await exists(src))) { missingSources++; }
		if (!(await exists(note))) { missingNotes++; }
	}
	if (missingSources > 0) {
		out.push({
			note: cacheUri, severity: 'info', rule: 'stale-cache',
			message: `构建缓存有 ${missingSources} 条「源文件已不存在」的残留记录（同名素材重新出现时会被误判为已构建）`,
		});
	}
	if (missingNotes > 0) {
		out.push({
			note: cacheUri, severity: 'warning', rule: 'stale-cache',
			message: `构建缓存有 ${missingNotes} 条「已建笔记已不存在」的残留记录（会让对应素材无法被批量重建）`,
		});
	}
	return out;
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
