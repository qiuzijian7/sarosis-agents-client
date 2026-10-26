// 体检**任意一个工作台目录**是否符合制作模板（与 dsh-plugins/check-workbench-style.mjs 同口径）。\n//   用法：node .codebuddy/skills/dsh-workbench-authoring/scripts/audit_workbench.mjs <包目录>\n//   为什么要它：check-workbench-style.mjs 只查**已入库**的包；新建/第三方包（还没进 UNIFIED）用它先过一遍。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) { throw new Error('用法: node wb-audit-scaffold.mjs <包目录>'); }
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const walk = (d, out = []) => {
	if (!existsSync(d)) { return out; }
	for (const n of readdirSync(d)) {
		if (n === 'node_modules') { continue; }
		const p = join(d, n);
		if (statSync(p).isDirectory()) { walk(p, out); } else if (n.endsWith('.js') || n.endsWith('.mjs')) { out.push(p); }
	}
	return out;
};

const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const files = walk(join(dir, 'lib')).filter((p) => p.endsWith('.js'));
const cand = files.map((p) => ({ p, text: strip(readFileSync(p, 'utf8')) }))
	.filter((x) => /desktopWorkbenches\.register\(/.test(x.text))
	.sort((a, b) => (b.text.match(/\bwb-[a-z-]+/g) || []).length - (a.text.match(/\bwb-[a-z-]+/g) || []).length)[0];
const src = cand ? cand.text : '';
const entry = existsSync(join(dir, 'lib/client.js')) ? strip(readFileSync(join(dir, 'lib/client.js'), 'utf8')) : '';
const patch = existsSync(join(dir, 'cordis.patch.yml')) ? readFileSync(join(dir, 'cordis.patch.yml'), 'utf8') : '';
const wbClasses = new Set(src.match(/\bwb(?:-[a-z0-9]+)*\b/g) || []);
const anchors = new Set(src.match(/data-[a-z0-9-]{3,30}/g) || []);
const bare = src.split('\n').filter((l) => !l.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)));
const testFiles = walk(join(dir, 'test'));

const rows = [
	['S1 bundle patch（cordis.patch.yml + insert）', /-\s*insert:/.test(patch)],
	['S2 清单 dsh.bundle.patch + files', !!(pkg.dsh?.bundle?.patch) && (pkg.files || []).includes('cordis.patch.yml')],
	['S3 描述符带 repository', /repository:\s*['"]vssaros:[a-z0-9-]+['"]/.test(src)],
	['S4 入口不写 chunk:', !/^\s*chunk\s*:/m.test(entry)],
	['S5 注册（*register(）', /(desktopWorkbenches|workbenches|dw|c)\s*\.\s*register\(/.test(src)],
	[`S6 ≥10 个 wb-*（实际 ${wbClasses.size}）`, wbClasses.size >= 10],
	[`S7 无裸色（实际 ${bare.length} 行）`, bare.length === 0],
	['S8 data-vssaros-surface="workbench"', /data-vssaros-surface['"]?\s*:\s*['"]workbench/.test(src)],
	['toolbar 锚点恰好 1 个', (src.match(/data-dsh-workbench-toolbar/g) || []).length === 1],
	['S9 有 @container', /@container/.test(src)],
	[`S11 ≥3 个 data-*（实际 ${anchors.size}）`, anchors.size >= 3],
	['S12 零 iframe', !/<iframe|createElement\(['"]iframe/.test(src)],
	[`S15 包内自检（实际 ${testFiles.filter((f) => f.endsWith('.mjs')).length} 个 .mjs）`, testFiles.some((f) => f.endsWith('.mjs'))],
];

let pass = 0;
for (const [name, ok] of rows) {
	if (ok) { pass += 1; }
	console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}`);
}
console.log(`\n脚手架生成物：${pass}/${rows.length} 项达标`);
