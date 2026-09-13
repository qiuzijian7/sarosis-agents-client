/*---------------------------------------------------------------------------------------------
 *  searchRegexStateless — 搜索工具的**逐行匹配函数必须无状态**（源码守卫）。
 *
 *  由来（2026-09-11 真 bug）：`searchHelpers._walkAndGrep` 用
 *  `new RegExp(query, 'gi')` 配合 `.test(line)` 逐行匹配。而**带 g 标志的正则
 *  `.test()` 是有状态的** —— `lastIndex` 会跨行推进，导致**连续命中行隔行漏掉**：
 *
 *      ['foo','foo','foo'].map(l => /foo/gi.test(l))  → [true, false, true]   ✗
 *      逐行独立判定（无 g）                            → [true, true, true]    ✓
 *
 *  影响面：ripgrep 不可用时的 Node-walk 降级模式（`_searchContentWalkFallback`），
 *  内容搜索会**静默丢一半命中且行号错乱** —— 模型据此得出「只有这几处」的错误结论。
 *  已修为 `'i'`（`_grepSingleFile` 早有同样注释并已用 `'i'`，此处是对齐补齐）。
 *
 *  本守卫防止回归：`providers/tool/` 下的 `new RegExp` **不得带 g 标志**，
 *  除非同一行同时用了 `.replace(` / `matchAll(`（那些场景才真正需要全局标志）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const TOOL_DIR = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool';

/** 递归收集目录下的 .ts 文件（跳过 .d.ts）。 */
function collectTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) { out.push(...collectTsFiles(p)); }
		else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) { out.push(p); }
	}
	return out;
}

suite('搜索正则无状态守卫（providers/tool）', () => {

	test('★ new RegExp 不得带 g 标志（逐行 .test() 会因 lastIndex 串味隔行漏匹配）', () => {
		const root = path.join(process.cwd(), TOOL_DIR);
		assert.ok(fs.existsSync(root), `工具目录缺失（需从仓库根目录运行测试）：${TOOL_DIR}`);

		const offenders: string[] = [];
		// 单行形态：new RegExp(<args>, '<flags>')  —— 多行构造不匹配（宁可漏检，不可误报）
		const re = /new RegExp\(([^\n]*?),\s*'([^']*)'\)/g;

		for (const file of collectTsFiles(root)) {
			const src = fs.readFileSync(file, 'utf8');
			for (const raw of src.split('\n')) {
				// 跳过纯注释行：修复说明里常引用出错的写法（如「原为 new RegExp(q, 'gi')」），
				// 那不是代码，不应计入。
				const trimmed = raw.trim();
				if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) { continue; }
				// 去掉行尾注释（本目录内不会出现含 // 的正则字面量；误截只会漏检，不会误报）。
				const line = raw.split('//')[0];
				// 显式豁免：需要全局语义的场景（替换 / 迭代匹配）
				if (line.includes('.replace(') || line.includes('matchAll(') || line.includes('regex-global-ok')) { continue; }
				for (const m of line.matchAll(re)) {
					if (m[2].includes('g')) {
						offenders.push(`${path.relative(process.cwd(), file)}: ${line.trim().slice(0, 120)}`);
					}
				}
			}
		}

		assert.deepStrictEqual(
			offenders,
			[],
			`以下位置使用了带 g 标志的 new RegExp —— 若用于逐行 .test() 会静默漏掉一半命中；`
			+ `如确需全局语义（replace/matchAll），请把该调用与 .replace(/matchAll( 写在同一行，或标注 regex-global-ok：\n`
			+ offenders.join('\n'),
		);
	});
});
