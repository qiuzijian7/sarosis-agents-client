/*
 * 守卫：codicon 子集与页面引用必须对得上。
 *
 * ★ 它守的是一个**静默失败** ✗：页面用 codicon('xxx') 出一个空 span，字形由 CSS 的
 *   ::before content 给；若 xxx 不在子集里，CSS 里就没有那条规则 ⇒ content 缺省为空
 *   ⇒ **页面上什么都没有**（不是报错、不是豆腐块，就是空白 ✗）—— 这种错在真机上
 *   最难发现（还会被"图标本来就小"糊过去 ✓）。
 *
 * 因此：① 页面引用的每个名字都必须在 `CODICON_SUBSET_NAMES` 里；
 *       ② 页面 CSS 必须真的把 `CODICON_FONT_CSS` 拼进去（漏了 ⇒ 全站没有字体）；
 *       ③ 产物 CSS 必须给每个名字都产出一条 ::before 规则；
 *       ④ package.json 的 files 必须带上产物（漏 files ⇒ 插件加载即失败 ✗）。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-codicon-subset.mjs
 * 反向突变（必须变红）：把 index.js 里任一 codicon('file') 改成 codicon('file-xxx') ⇒ ① 应报红。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CODICON_SUBSET_NAMES, CODICON_FONT_CSS } from '../lib/codiconSubset.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const INDEX = HERE + '../lib/index.js';
const PKG = HERE + '../package.json';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
	if (ok) { pass++; console.log('PASS  ' + name + (detail ? '  — ' + detail : '')); }
	else { fail++; console.log('FAIL  ' + name + '  — ' + detail); }
};

const src = readFileSync(INDEX, 'utf8');
const pkg = JSON.parse(readFileSync(PKG, 'utf8'));

// ① 页面引用的名字 ⊇ 检查（含三元里的两个分支：codicon(isLibrary ? 'book' : 'note') ✓）
const used = new Set();
for (const m of src.matchAll(/codicon\(([^()]*)\)/g)) {
	for (const q of m[1].matchAll(/'([a-z][a-z-]*)'/g)) { used.add(q[1]); }
}
check('① 页面确实用到了 codicon()（不是死代码）', used.size > 0, used.size + ' 个名字');
const missing = [...used].filter(n => !CODICON_SUBSET_NAMES.includes(n));
check('① 用到的字形全部在子集里（缺 ⇒ 页面空白 ✗ 静默失败）',
	missing.length === 0, missing.length ? '缺：' + missing.join(', ') : [...used].sort().join(', '));

// ② CSS 真的拼进去了
check('② 页面 CSS 拼了 CODICON_FONT_CSS', src.includes('${CODICON_FONT_CSS}'),
	src.includes('${CODICON_FONT_CSS}') ? 'PAGE_CSS 内' : '找不到拼接 ✗');

// ③ 产物 CSS 内含 @font-face + 每个名字一条 ::before
check('③ 产物含 @font-face（woff2 data URI）',
	CODICON_FONT_CSS.includes('@font-face') && CODICON_FONT_CSS.includes('data:font/woff2;base64,'));
const noRule = CODICON_SUBSET_NAMES.filter(n => !CODICON_FONT_CSS.includes('.dsh-cod-' + n + '::before'));
check('③ 每个字形都有 ::before 规则', noRule.length === 0, noRule.length ? '缺：' + noRule.join(', ') : CODICON_SUBSET_NAMES.length + ' 条');

// ④ 随包白名单
check('④ package.json 的 files 带上了产物',
	(pkg.files ?? []).includes('lib/codiconSubset.js'), (pkg.files ?? []).filter(f => f.includes('codicon')).join(',') || '（无）');

console.log(`\n${pass}/${pass + fail} passed` + (fail ? `  ✗ ${fail} 条红` : '  ✓'));
process.exit(fail ? 1 : 0);
