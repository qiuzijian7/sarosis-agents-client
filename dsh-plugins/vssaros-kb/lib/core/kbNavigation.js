// @vssaros/dsh-kb — 导航文件（`笔记/index.md`、`笔记/overview.md`）的**纯生成逻辑**（零 I/O ✓）。
//
// ## 口径来源：逐字照 VsSaros 真源，不是"我理解的样子"
// 真源 = `KbImportController.maintainKbIndex` / `maintainKbOverview`
//（`src/vs/sessions/contrib/agentStudio/browser/kbImportController.ts:2150-2219` ✓），
// 加上它们依赖的两个纯函数 `collectMdFiles` / `readNoteFrontmatterType`
//（`.../knowledge/kbVaultFs.ts:816-849` ✓）。
//
// ★ 为什么一定要"逐字"：这两个文件是**导航视图**读的东西（IDE 侧与 dsh 侧**都**会列它们 ✓）⇒
//   两边生成的内容只要差一个字符（多一个空行、排序换个比较器、注释没剥），用户看到的就是
//   "同一个库在两个界面里长得不一样" ✗ —— 而且**两边都不报错** ✗。
//   ⇒ 交叉校验写成了 IDE 侧的一个测试：`kbNavigationParity.test.ts`
//     （同一夹具 × **真** `KbImportController` vs 本模块 ⇒ **逐字节**相等 ✓）。
//
// ## 本模块**不做**什么（如实划清）
//   · `insights.md`（要 wikilink 图 + Louvain 社区检测）—— 未做；
//   · 各目录 `.overview.md` 中间层（要 chatModel）—— 未做；
//   · `知识体系.md` —— 真源里它是**子代理**写的（kb-build 手册 Phase 2 ✓），我们在构建任务书里要求子代理写 ✓；
//   · `sources` 来源注入 / 确定性补链 / 去抽象化门控 —— 未做（同属 P2 ✓）。
//   这些在回执里**如实标注**（"要在 IDE 侧刷一次"）✓，不假装同形 ✗。

/**
 * 系统导航文件（真源 `SYS_INDEX_FILES` 逐字 ✓，`kbVaultFs.ts:40`）——
 * 扫描笔记区时**排除**它们（它们不是素材、也不是笔记 ✓）；顺序与真源一致（不排序、不加不减 ✓）。
 */
// 「读 frontmatter type」只有一处实现（门控也用它 ✓）：见 core/kbFrontmatter.js ✓
import { readNoteFrontmatterType } from './kbFrontmatter.js';

export const SYS_INDEX_FILES = ['index.md', 'overview.md', 'insights.md', 'log.md', 'lint-report.md', 'dedup-report.md', '知识体系.md'];

/**
 * 从"笔记区里的所有文件"里挑出**算作笔记**的那些（真源 `collectMdFiles` 的判据，逐条照抄 ✓
 * `kbVaultFs.ts:816-834`）：`rel` 任一层以 `.` 开头 ⇒ 跳过 ✓；不以 `.md` 结尾 ⇒ 跳过 ✓；
 * 文件名（basename，**不按路径** ✓）在 `SYS_INDEX_FILES` 里 ⇒ 跳过 ✓。
 *
 * ★ 为什么这条判据必须放在**纯模块**里（而不是留给读盘那层）：它同样是"口径" ——
 *   两边只要有一处看法不同（少排除一个 `知识体系.md`、或把点目录收进来 ✗），索引内容就会分叉，
 *   而且**两边都不报错** ✓。放在这里 ⇒ 写盘那层与对账探针走**同一个函数**，规则只有一处 ✓。
 * @param {{ rel: string, content: string }[]} entries
 * @returns {{ rel: string, content: string }[]}
 */
export function selectNoteFiles(entries) {
	return (entries ?? []).filter(entry => {
		const rel = String(entry?.rel ?? '').replace(/\\/g, '/');
		if (!rel || rel.endsWith('/')) {
			return false;
		}
		const segments = rel.split('/');
		if (segments.some(segment => segment.startsWith('.'))) {
			return false;
		}
		const name = segments[segments.length - 1];
		return name.endsWith('.md') && !SYS_INDEX_FILES.includes(name);
	});
}

/**
 * 把一篇笔记拆成真源要的三段：`rel`（相对笔记区、含扩展名、`/` 分隔 ✓）、`relNoExt`、`segs`。
 * 真源在 `maintainKbIndex` / `maintainKbOverview` 里各写了一遍同样的拆法 ✓ ⇒ 这里抽成一处 ✓
 *（**行为**必须与真源一致：`rel` 到根为止、`\` 归一成 `/`、末尾 `.md` 不分大小写地剥掉 ✓）。
 * @param {string} rel 相对笔记区的路径（含 `.md`）
 */
function segmentsOf(rel) {
	const relNoExt = String(rel ?? '').replace(/\\/g, '/').replace(/\.md$/i, '');
	return { relNoExt, segs: relNoExt.split('/') };
}

/** 真源的 `dirType` 判据：层级 > 1 ⇒ 顶层目录名；否则 `(root)` ✓。 */
const dirTypeOf = segs => (segs.length > 1 ? segs[0] : '(root)');

/**
 * 生成 `笔记/index.md` 的内容（真源 `maintainKbIndex` 逐字 ✓）。
 *
 * ⚠ 排序口径要**分开**照抄 ✗：分组键（类型）用 **默认 `sort()`**（UTF-16 码元序 ✓），
 *   而组内条目用 **`localeCompare`**（本地化序 ✓）—— 两者换用会让同一份笔记生成不同顺序 ✓。
 * @param {{ rel: string, content: string }[]} notes 笔记区里的文件（已排除系统导航文件 ✓）
 * @returns {string}
 */
export function buildIndexFile(notes) {
	const groups = new Map();
	for (const note of notes) {
		const { relNoExt, segs } = segmentsOf(note.rel);
		const type = readNoteFrontmatterType(note.content) || dirTypeOf(segs);
		if (!groups.has(type)) {
			groups.set(type, []);
		}
		groups.get(type).push({ rel: relNoExt, name: segs[segs.length - 1] });
	}
	const types = [...groups.keys()].sort();
	const out = [
		'# 知识库索引', '',
		'> 按 frontmatter `type` 语义分组。请勿手改。', '',
		'- 高层导航：[[overview]]　·　图谱洞察：[[insights]]', '',
	];
	for (const type of types) {
		out.push(`## ${type}`);
		for (const item of groups.get(type).sort((a, b) => a.rel.localeCompare(b.rel))) {
			out.push(`- [[${item.rel}|${item.name}]]`);
		}
		out.push('');
	}
	return out.join('\n');
}

/**
 * 生成 `笔记/overview.md` 的内容（真源 `maintainKbOverview` 逐字 ✓）。
 *
 * ⚠ 主题取的是**第二层目录名**；层级 ≤ 2 时算 `(直接)` ✓；`(直接)` 的链接指回 `[[index#<类型>]]` ✓
 *   （其余指 `[[<类型>/<主题>]]` ✓）。主题排序 = **篇数降序、同数按名字 `localeCompare`** ✓。
 * @param {{ rel: string, content: string }[]} notes
 * @returns {string}
 */
export function buildOverviewFile(notes) {
	const typeStats = new Map();
	let total = 0;
	for (const note of notes) {
		const { segs } = segmentsOf(note.rel);
		const type = readNoteFrontmatterType(note.content) || dirTypeOf(segs);
		const topic = segs.length > 2 ? segs[1] : '(直接)';
		total++;
		let stat = typeStats.get(type);
		if (!stat) {
			stat = { count: 0, topics: new Map() };
			typeStats.set(type, stat);
		}
		stat.count++;
		stat.topics.set(topic, (stat.topics.get(topic) ?? 0) + 1);
	}
	const types = [...typeStats.keys()].sort();
	const out = [
		'# 知识库总览', '',
		'> 按 frontmatter `type` 语义分组。全量见 [[index]]，图谱洞察见 [[insights]]。', '',
		`> 共 **${total}** 篇笔记，**${types.length}** 个类型。`, '',
	];
	for (const type of types) {
		const stat = typeStats.get(type);
		out.push(`## ${type}（${stat.count} 篇）`);
		const topics = [...stat.topics.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
		for (const [topic, count] of topics) {
			const link = topic === '(直接)' ? `[[index#${type}]]` : `[[${type}/${topic}]]`;
			out.push(`- ${topic}：${count} 篇 → ${link}`);
		}
		out.push('');
	}
	return out.join('\n');
}

/**
 * 一次算好两份导航内容。
 * @param {{ rel: string, content: string }[]} notes
 * @returns {{ index: string, overview: string }}
 */
export function buildNavigationFiles(notes) {
	return { index: buildIndexFile(notes), overview: buildOverviewFile(notes) };
}
