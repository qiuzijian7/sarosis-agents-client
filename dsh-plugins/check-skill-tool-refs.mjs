/*
 * 守卫：技能正文引用的工具名必须**在当前环境真实存在**。
 *
 * 为什么必须有：技能是给模型看的操作手册，正文里写 `` `read_file` `` 就是在教模型调它。
 * 工具名不存在时不会报错 —— 模型拿到 "unknown tool" 后开始瞎猜替代方案，
 * 比"不给提示"更糟（bunnyseek 源码注释原话）。而迁移/改名一次就会静默产生这种悬空引用。
 *
 * 判据刻意窄到零假阳性：只有**出现在工具清单里**的标识符才算工具引用
 * （清单 = resources/.agents/tools/*.json + dsh-plugins/tools-snapshot.json + bunnyseek 的旧名表）。
 * 所以 `main.py`、`git_commit` 这类普通标识符永不误报。
 *
 * 扫描面：随包技能（顶层 `<name>/SKILL.md`）+ 用户技能根（`<数据根>/skills`，两套数据根）。
 * ⚠ 只认顶层 —— dsh 的 skill provider 是单层 readdir（`segments.length===2`），
 *   藏在容器目录里的技能 IDE 看得见、dsh 看不见。
 *
 * 跑法：node dsh-plugins/check-skill-tool-refs.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import { BUNNYSEEK_ONLY, dshToolNames, ROOT, scanToolRefs } from './scripts/skill-tool-map.mjs';

const SKILL_ROOTS = [
	join(ROOT, 'resources', '.agents', 'skills'),
	join(homedir(), '.vssaros-dev', 'skills'),
	join(homedir(), '.vssaros', 'skills'),
];

/**
 * 有意保留的旧工具名（文件相对路径 → 工具名 → 理由）。
 * 守卫纪律：**有意不同必须登记**，否则下一个人会以为又是漏改。
 */
const DELIBERATE = [
	// 例：{ file: 'resources/.agents/skills/xxx/SKILL.md', tool: 'read_file', why: '正文是"从 bunnyseek 迁移"的对照说明' }
];

const dshTools = dshToolNames();
const problems = [];
let scanned = 0;
const danglingRows = [];

for (const root of SKILL_ROOTS) {
	if (!existsSync(root)) {
		continue;
	}
	const dirs = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
	for (const dir of dirs) {
		const file = join(root, dir, 'SKILL.md');
		if (!existsSync(file)) {
			continue;
		}
		scanned += 1;
		const text = readFileSync(file, 'utf8');
		const { referenced, dangling } = scanToolRefs(text, dshTools);
		// 用户技能根在工作区**之外** ⇒ `relative` 会给出 `../../..` 开头，用更短的 `~/<后缀>` 显示。
		const inside = relative(ROOT, file);
		const rel = (inside.startsWith('..') ? `~/${relative(root, file)}` : inside).replace(/\\/g, '/');
		const real = dangling.filter(tool => !DELIBERATE.some(d => d.file === rel && d.tool === tool));
		if (real.length) {
			danglingRows.push({ rel, tools: real, referenced: referenced.length });
		}
	}
}

// 假绿防线：一个技能都没扫到，说明路径或判据失效 —— 这种守卫"永远绿"比没有更坏。
if (scanned === 0) {
	console.error('[check-skill-tool-refs] ✗ 一个技能都没扫到（路径或顶层判据失效）');
	process.exit(1);
}

console.log('[check-skill-tool-refs] 技能正文 → 工具名 引用守卫');
console.log(`  工具清单：dsh 内建 + 插件共 ${dshTools.size} 个；可识别的旧名 ${BUNNYSEEK_ONLY.size} 个`);
console.log(`  受检技能：${scanned} 个（随包 + 用户技能根）`);

if (danglingRows.length === 0) {
	console.log('  ✓ 所有引用的工具名都在清单里');
	process.exit(0);
}

console.log(`  ✗ ${danglingRows.length} 个技能引用了不存在的工具：`);
for (const row of danglingRows) {
	problems.push(row.rel);
	console.log(`    · ${row.rel}　${row.tools.join(', ')}`);
}
console.log(`\n[check-skill-tool-refs] ✗ ${problems.length} 项问题`);
console.log('修法：把正文里的旧工具名换成本环境的（映射表见 dsh-plugins/scripts/skill-tool-map.mjs）；');
console.log('      映射为 null 的（tapd_*/p4_*/unreal_screenshot 等）要么补工具，要么删掉该技能。');
process.exit(1);
