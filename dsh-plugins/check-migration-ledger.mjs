#!/usr/bin/env node
// 迁移台账守卫（方案 doc/dsh-plugin-paradigm-refactor-plan.html §5-0.2）。
//
// 台账 `migration-ledger.json` 是"哪个能力族归谁"的唯一事实来源。本脚本把它和另外三份
// 机器真源对账，任何一边变了另一边没跟 ⇒ 红：
//   ① 工具快照 tools-snapshot.json —— 每个**注册了工具**的插件必须在台账里有归属族
//      （否则"这个插件的工具面归哪条迁移线管"没有答案 ✗）；
//   ② toolOwnership.ts —— 登记的同名动词两侧的包都必须在台账里出现（对齐契约不能指向
//      "台账不知道的族" ✗）；
//   ③ persistence.json —— 每个 @vssaros/* 写者必须在台账里出现（落盘归属与迁移归属同源 ✓）。
//   ④ owner 状态机合法值 + owner=dsh/removed 的族必须有真实 parityProbe（不许"已迁但没探针" ✗）。
// 跑法：node dsh-plugins/check-migration-ledger.mjs（已并入 npm run check:dsh-plugins）。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

const ledger = JSON.parse(readFileSync(join(ROOT, 'migration-ledger.json'), 'utf8'));
const families = ledger.families;
const owners = new Set(['legacy', 'dual', 'dsh', 'removed']);

// ── 0. 台账自身合法 ──────────────────────────────────────────────────────────
{
	const ids = families.map(f => f.id);
	check('0a. 族 id 唯一', new Set(ids).size === ids.length, ids.join(','));
	const badOwner = families.filter(f => !owners.has(f.owner));
	check('0b. owner 只能是 legacy/dual/dsh/removed', badOwner.length === 0, badOwner.map(f => `${f.id}:${f.owner}`).join(','));
	const missing = families.filter(f => !f.title || !f.dshTarget);
	check('0c. 每族都有 title 与 dshTarget', missing.length === 0, missing.map(f => f.id).join(','));
	const noProbe = families.filter(f => (f.owner === 'dsh' || f.owner === 'removed') && (!f.parityProbe || f.parityProbe === '待写' || f.parityProbe === '—'));
	check('0d. owner=dsh/removed 的族必须有真实 parityProbe（"已迁但没探针"不算迁完）', noProbe.length === 0, noProbe.map(f => f.id).join(','));
}

// 台账全文（供"包名出现与否"判断，指向 dshTarget/notes 任意一处都算登记）。
const ledgerText = JSON.stringify(families);

// ── ① 工具快照：注册工具的插件必须有归属族 ──────────────────────────────────
{
	const snapshot = JSON.parse(readFileSync(join(ROOT, 'tools-snapshot.json'), 'utf8'));
	const toolPlugins = Object.keys(snapshot.plugins ?? {});
	const unmapped = toolPlugins.filter(dir => {
		const pkgName = `@vssaros/dsh-${dir.replace(/^vssaros-/, '')}`;
		return !ledgerText.includes(dir) && !ledgerText.includes(pkgName);
	});
	check('1. 注册了工具的插件都在台账里有归属（快照 plugins ⊆ 台账）', unmapped.length === 0, unmapped.join(','));
}

// ── ② 同名动词登记表：两侧的实现包都在台账里 ────────────────────────────────
{
	const ownershipPath = join(ROOT, '..', 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'common', 'toolOwnership.ts');
	if (existsSync(ownershipPath)) {
		const text = readFileSync(ownershipPath, 'utf8');
		const pkgs = [...text.matchAll(/@vssaros\/dsh-[\w-]+/g)].map(m => m[0]);
		const unmapped = [...new Set(pkgs)].filter(p => !ledgerText.includes(p));
		check('2. toolOwnership 涉及的 dsh 包都在台账里', unmapped.length === 0, unmapped.join(','));
	} else {
		check('2. toolOwnership 涉及的 dsh 包都在台账里', false, 'toolOwnership.ts 不存在（被删了要同步删台账守卫）');
	}
}

// ── ③ 落盘登记册：@vssaros/* 写者都在台账里 ─────────────────────────────────
{
	const catalog = JSON.parse(readFileSync(join(ROOT, 'persistence.json'), 'utf8'));
	const writers = (catalog.entries ?? []).map(e => String(e.writer ?? '')).filter(w => w.startsWith('@vssaros/'));
	const unmapped = [...new Set(writers)].filter(w => !ledgerText.includes(w));
	check('3. persistence.json 的 @vssaros/* 写者都在台账里', unmapped.length === 0, unmapped.join(','));
}

// ── ④ 模块表对齐：台账里的 dshTarget 插件名不得指向不存在的目录 ─────────────
{
	const dirs = new Set(readdirSync(ROOT, { withFileTypes: true })
		.filter(e => e.isDirectory() && existsSync(join(ROOT, e.name, 'package.json')))
		.map(e => e.name));
	const mentioned = [...ledgerText.matchAll(/@vssaros\/dsh-[\w-]+/g)].map(m => m[0]);
	const missingDirs = [...new Set(mentioned)]
		.map(p => ({ p, dir: p.replace(/^@vssaros\/dsh-/, 'vssaros-') }))
		.filter(x => !dirs.has(x.dir));
	// channels 是已登记的 planned 预留位（模块表里有 planned:true）⇒ 不算违规
	const violations = missingDirs.filter(x => x.dir !== 'vssaros-channels');
	check('4. 台账指向的插件目录都存在（channels 是 planned 预留位，豁免）', violations.length === 0, violations.map(x => x.p).join(','));
}

let failed = 0;
for (const r of results) {
	console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail.slice(0, 200)}` : ''}`);
	if (!r.ok) { failed++; }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
