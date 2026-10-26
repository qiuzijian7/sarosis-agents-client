#!/usr/bin/env node
// check-dsw-tokens.mjs —— 插件里用到的 `--dsw-alias-*` 必须是**真实有值**的 token。
//
// 为什么需要：CSS 变量写错名字**不会报错**，只会静默落入 fallback。
//   2026-10-26 真机：「外开」按钮用了不存在的 `--dsw-alias-bg-overlay`（误判过一次）、
//   `--dsw-alias-border-default`、`--dsw-alias-state-warning-primary`，
//   于是背景永远是写死的 #fff、边框永远是 fallback 灰 ⇒ 深色主题下所有工作台里
//   这个按钮都和窗口其余部分不一致，而且没有任何报错提示。
//
// 判定依据（已实测等价）：`dsh-client-ui-theme` 里**有 `--dsw-alias-x:` 定义**
//   ⇔ 运行时 `getComputedStyle(document.body).getPropertyValue('--dsw-alias-x')` 非空。
//   （浅色/深色两套都定义，各出现 2 次；没定义的取到空串。）
//
// 用法：node dsh-plugins/check-dsw-tokens.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

let pass = 0;
let fail = 0;
const ok = (n) => { pass += 1; console.log('  ✓ ' + n); };
const bad = (n, d = '') => { fail += 1; console.log('  ✗ ' + n + (d ? '\n      ' + d : '')); };

/** 找到本仓自带的 dsh 运行时里的主题包（多个版本时取路径最短的，即最新）。 */
function themeFile() {
	const base = path.join(ROOT, 'dsh-runtime');
	if (!fs.existsSync(base)) { return ''; }
	const hits = fs.readdirSync(base)
		.map((v) => path.join(base, v, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'))
		.filter((p) => fs.existsSync(p))
		.sort((a, b) => a.length - b.length);
	return hits[0] || '';
}

const theme = themeFile();
if (!theme) {
	console.log('[dsw-tokens] ✗ 找不到 dsh-client-ui-theme（dsh-runtime 下没有？）');
	process.exit(1);
}

// ── 白名单：主题文件里有定义的全部 alias token ────────────────────────
const themeSrc = fs.readFileSync(theme, 'utf8');
const defined = new Set(
	[...themeSrc.matchAll(/(--dsw-alias-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
);
console.log(`[dsw-tokens] 主题 token 白名单 ${defined.size} 个（来自 ${path.relative(ROOT, theme)}）`);
if (defined.size < 50) { bad('白名单过小，解析可能失败', String(defined.size)); }
else { ok(`解析到 ${defined.size} 个有效 token`); }

// 这几个是"看起来像 token、其实没有定义"的经典笔误，单独钉一条
const KNOWN_BAD = [
	['--dsw-alias-border-default', '--dsw-alias-border-l1 / border-l2'],
	['--dsw-alias-state-warning-primary', '--dsw-alias-state-warn-primary'],
	['--dsw-alias-state-danger-primary', '--dsw-alias-state-error-primary'],
];

// ── 扫描插件源码 ───────────────────────────────────────────────────────
const PLUGIN_DIR = path.join(ROOT, 'dsh-plugins');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
	const p = path.join(dir, e.name);
	if (e.isDirectory()) { return e.name === 'node_modules' ? [] : walk(p); }
	return e.name.endsWith('.js') ? [p] : [];
});

const files = walk(PLUGIN_DIR);
const usedBy = new Map();   // token → Set(相对文件)

/** 剥注释：注释里写 `--dsw-alias-bg-layer-*` 这类通配不该算"使用了"（第一版就误报过）。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

for (const file of files) {
	const src = stripComments(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
	for (const m of src.matchAll(/--dsw-alias-[a-z0-9-]+/g)) {
		const token = m[0];
		if (token.endsWith('-')) { continue; }   // 动态拼接/通配
		if (!usedBy.has(token)) { usedBy.set(token, new Set()); }
		usedBy.get(token).add(path.relative(ROOT, file));
	}
}

console.log(`\n扫描 ${files.length} 个插件文件，用到 ${usedBy.size} 个 alias token`);

/**
 * 全量检查（2026-10-26 清理后已清零 ⇒ 不再分级，任何未定义 token 都判红）。
 * 历史：那天一次清掉 17 个（`label-quaternary` / `text-primary` / `bg-elevated` /
 * `surface-1/2` / `accent` / `bg-selected` / `bg-layer-0` / `font-mono` …），
 * 之后新增一个都要立刻发现，否则又会静默落 fallback。
 */
const unknown = [...usedBy.keys()].filter((t) => !defined.has(t) && t !== '--dsw-alias-x');

if (unknown.length === 0) {
	ok(`全部 ${usedBy.size} 个 alias token 都有定义（不会静默落 fallback）`);
} else {
	for (const token of unknown) {
		const where = [...usedBy.get(token)].slice(0, 3).join(', ');
		const hint = KNOWN_BAD.find(([t]) => t === token);
		bad(`未定义的 token：${token}`, `${where}${hint ? `\n      ⇒ 应改为 ${hint[1]}` : ''}`);
	}
}

// ── 已知笔误（即使白名单将来变宽也要拦住）──────────────────────────────
for (const [token, fix] of KNOWN_BAD) {
	const hits = [...(usedBy.get(token) || [])];
	if (hits.length) { bad(`出现了已知笔误 ${token}`, `${hits.slice(0, 3).join(', ')} ⇒ 应改为 ${fix}`); }
}
if (KNOWN_BAD.every(([t]) => !usedBy.has(t))) { ok('没有已知笔误（border-default / state-warning-* / state-danger-*）'); }

// ── 一体条这个具体控件：背景必须是"表面色"而不是写死 #fff ──────────────
const shell = path.join(ROOT, 'dsh-plugins/vssaros-workbenches/lib/client.js');
if (fs.existsSync(shell)) {
	const src = fs.readFileSync(shell, 'utf8').replace(/\r\n/g, '\n');
	const block = (src.match(/\.vssWbActions\s*\{[^}]*\}/) || [''])[0];
	if (!block) { bad('找不到 .vssWbActions 样式块'); }
	else if (!/background:var\(--dsw-alias-bg-layer-1/.test(block)) {
		bad('.vssWbActions 背景必须用 --dsw-alias-bg-layer-1（跟随主题的表面色）',
			block.slice(0, 160).replace(/\n/g, ' '));
	} else { ok('.vssWbActions 背景用主题表面色 bg-layer-1'); }

	if (/background:var\(--dsw-alias-bg-layer-1[^)]*,\s*#fff/.test(block)) {
		ok('兜底色存在（变量异常时仍是中性白）');
	}
}

console.log(`\n[dsw-tokens] ${pass} passing / ${fail} failing`);
process.exit(fail ? 1 : 0);
