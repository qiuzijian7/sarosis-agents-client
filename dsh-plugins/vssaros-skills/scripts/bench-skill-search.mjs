/*
 * 真实实现基准：直接 import `vssaros-skills` 的 tokenize / rankSkills，量中文召回。
 *
 * 用途：改分词/改 description 后的**护栏**（改完跑一次就知道好没好）。
 * 跑法：node dsh-plugins/vssaros-skills/scripts/bench-skill-search.mjs
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const SKILLS_ROOT = join(REPO, 'resources', '.agents', 'skills');
const TARGET = 'help-me-understand';

// ⚠ Windows：ESM 动态 import 必须是 file:// URL（直接传盘符路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME）
const { tokenize, rankSkills } = await import(pathToFileURL(join(HERE, '..', 'lib', 'core', 'skillSearch.js')).href);

// ── 载入技能（只收 dsh 侧能识别的合法名字）────────────────────────────
const skills = [];
for (const e of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
	if (!e.isDirectory()) { continue; }
	const f = join(SKILLS_ROOT, e.name, 'SKILL.md');
	if (!existsSync(f)) { continue; }
	const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(f, 'utf8'))?.[1] ?? '';
	const name = (/^name:\s*(.+)$/mi.exec(fm)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
	const description = (/^description:\s*(.+)$/mi.exec(fm)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
	if (name && description && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
		skills.push({ id: name, name, description });
	}
}

// ── 用例 ────────────────────────────────────────────────────────────────
const CASES = [
	{ q: '帮我讲懂一下这个 GC 机制', kind: 'A' },
	{ q: '帮我讲懂这个 GC 机制', kind: 'A' },
	{ q: '看不懂这段代码，解释一下', kind: 'A' },
	{ q: '讲透 UE5 的 GC 到底怎么回事', kind: 'A' },
	{ q: '帮我理解 deepseek harness 的框架原理', kind: 'A' },
	{ q: '解读一下 deepseek harness 的框架原理', kind: 'A' },
	{ q: '这块的原理是什么', kind: 'A' },
	{ q: '我搞不明白这个架构', kind: 'A' },
	{ q: 'help me understand the sync flow', kind: 'A' },
	{ q: 'walk me through the login flow', kind: 'A' },
	{ q: '讲一下这个方案', kind: 'A' },
	{ q: '帮我把这个搞懂', kind: 'A' },

	{ q: '帮我看看这玩意到底干啥的', kind: 'C' },
	{ q: '这个是怎么跑起来的', kind: 'C' },
	{ q: '我想搞明白它是怎么实现的', kind: 'C' },
	{ q: '能不能顺着代码给我捋一遍', kind: 'C' },
	{ q: '这段逻辑我一直没绕明白', kind: 'C' },
	{ q: '它内部是怎么组织的', kind: 'C' },

	{ q: '帮我写一篇笔记', kind: 'B', expect: 'obsidian-markdown' },
	{ q: '把这个同步到飞书', kind: 'B', expect: 'kb-feishu-sync' },
	{ q: '画个流程图', kind: 'B', expect: 'mermaid' },
	{ q: '整理一下知识库', kind: 'B', expect: 'kb-build' },
	{ q: '生成思维导图', kind: 'B', expect: 'json-canvas' },
	{ q: '总结一下这篇笔记', kind: 'B', expect: 'summarize' },
];

const rows = CASES.map(c => ({ ...c, top: rankSkills(skills, c.q, 3) }));
const pick = k => rows.filter(r => r.kind === k);
const A = pick('A'), C = pick('C'), B = pick('B');

const a1 = A.filter(r => r.top[0]?.id === TARGET).length;
const a3 = A.filter(r => r.top.slice(0, 3).some(t => t.id === TARGET)).length;
const c3 = C.filter(r => r.top.slice(0, 3).some(t => t.id === TARGET)).length;
const bWrong = B.filter(r => r.top[0]?.id === TARGET).length;
const bRight = B.filter(r => r.top[0]?.id === r.expect).length;

console.log(`技能池 ${skills.length} 个 · 用例 ${CASES.length} 条（真实 tokenize/rankSkills）\n`);
console.log(`  A 类（应命中）  recall@1 = ${a1}/${A.length}   recall@3 = ${a3}/${A.length}`);
console.log(`  C 类（换说法）  进 top3  = ${c3}/${C.length}`);
console.log(`  B 类（不该命中）误触 top1 = ${bWrong}/${B.length}   命中所属技能 = ${bRight}/${B.length}`);

console.log('\n=== A 类逐条 ===');
for (const r of A) {
	const m = r.top[0]?.id === TARGET ? '✓top1' : (r.top.slice(0, 3).some(t => t.id === TARGET) ? '~top3' : '✗没进');
	console.log(`  ${m.padEnd(6)} ${r.q}   [${r.top[0]?.id ?? '(空)'}]`);
}

console.log('\n=== 分词抽样（确认中文逐字）===');
for (const q of ['帮我讲懂这个 GC 机制', 'UE5的GC到底怎么回事']) {
	console.log(`  "${q}" → ${JSON.stringify([...tokenize(q)])}`);
}

// 失败即非零退出：可当护栏
const strict = process.argv.includes('--strict');
if (strict && (a3 / A.length < 0.66 || c3 / C.length < 0.6 || bWrong > 0)) {
	console.error('\n[strict] 召回低于门槛（A@3 ≥ 66%、C@3 ≥ 60%、B 误触 = 0）');
	process.exit(1);
}
