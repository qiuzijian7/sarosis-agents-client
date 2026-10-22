/*
 * 把技能的 `frontmatter.name` 规范成**目录名**（小写连字符）。
 *
 * 为什么必须改（dsh 侧硬约束，源码 `@deepseek-ai/dsh-skill`）：
 *   const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
 * name 含空格/大写/引号的技能在 dsh 侧**既进不了会话目录、也无法 `/name` 调用**
 * （校验不过）⇒ 等于"存在但不可用"。
 *
 * ⚠ 只改 **frontmatter 里第一个 `name:` 行**（不碰正文），且保留原换行风格。
 * ⚠ 技能 id 是**目录名/localId**（IDE 侧 `skillInstaller` 的 `id: localId`），不是这个 name
 *   ⇒ 改它**不影响** agent 的 `skills:` 挂载（挂的是 id）✓
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/fix-skill-names.mjs [--apply]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] && !process.argv[2].startsWith('--')
	? process.argv[2]
	: 'g:/SarosWorkspace/sarosis-agents-client/resources/.agents/skills';
const APPLY = process.argv.includes('--apply');
const LEGAL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const changes = [];
for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
	if (!entry.isDirectory()) { continue; }
	const file = join(ROOT, entry.name, 'SKILL.md');
	if (!existsSync(file)) { continue; }
	const raw = readFileSync(file, 'utf8');
	const lines = raw.split(/\r?\n/);
	// 只在前 12 行里找 frontmatter 的 name（正文里可能有别的 name:）
	const idx = lines.findIndex((line, i) => i < 12 && /^name:\s*\S/.test(line));
	if (idx < 0) { continue; }
	const current = lines[idx].replace(/^name:\s*/, '').trim().replace(/^["']|["']$/g, '');
	if (LEGAL.test(current)) { continue; }          // 已合法 ⇒ 不动
	changes.push({ dir: entry.name, from: current, file, lines, idx });
}

console.log(`扫描：${ROOT}`);
console.log(`非法 name：${changes.length} 个${APPLY ? '（apply 模式，将写盘）' : '（dry-run，加 --apply 才写）'}\n`);
for (const c of changes) {
	console.log(`  ${c.dir.padEnd(20)}  ${JSON.stringify(c.from)}  →  "${c.dir}"`);
}

if (!APPLY) {
	console.log('\n未写盘。确认无误后加 --apply 重跑。');
	process.exit(0);
}

let written = 0;
for (const c of changes) {
	const eol = /\r\n/.test(readFileSync(c.file, 'utf8')) ? '\r\n' : '\n';
	const next = [...c.lines];
	next[c.idx] = `name: ${c.dir}`;
	writeFileSync(c.file, next.join(eol), 'utf8');
	written++;
}
console.log(`\n已改写 ${written} 个文件。`);
