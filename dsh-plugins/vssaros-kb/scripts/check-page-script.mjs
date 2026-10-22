/*
 * 守卫：页内脚本不许有**未定义引用**。
 *
 * ★ 为什么需要（本仓真实事故）：页内脚本是一个大 IIFE，**任何一处 ReferenceError 都会让整段死掉** ——
 *   表现不是"某个按钮不能用"，而是"筛选/折叠/拖拽/按钮**全哑**"，用户只会报"点了没反应" ✗。
 *   历史上两次：① `sortSelect` 改名后漏删监听（index.js 里那条注释记着 ✓）；
 *   ② 2026-10-19 模板串被注释里的反引号提前闭合 ⇒ `dsh - search - ico` ⇒ `search is not defined`。
 *   `node --check` 对两者都**无感**（语法合法）⇒ 必须做作用域级检查。
 *
 * 做法：把模板串里的脚本原样抽出来，交给 ESLint 的 no-undef 扫（浏览器全局已开）。
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-page-script.mjs
 * 反向突变：在脚本里加一句 `fooBar();` ⇒ 应报 no-undef。
 *
 * ★ 2026-10-19：从"只扫 index.js"扩成"扫多个页面文件" —— 关系图谱页面（`lib/graphPage.js`，
 *   从 IDE 侧迁来）也有自己的页内脚本，同样一处 ReferenceError 就整页失效。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import globals from 'globals';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LIB = HERE + '../lib/';

/** 要扫的文件 + 其中的脚本模板串名 */
const TARGETS = [
	{ file: 'index.js', names: ['KB_SCRIPT', 'DOC_PREVIEW_SCRIPT'] },
	{ file: 'graphPage.js', names: ['GRAPH_SCRIPT'] },
];

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
	if (ok) { pass++; console.log('PASS  ' + name + (detail ? '  — ' + detail : '')); }
	else { fail++; console.log('FAIL  ' + name + '  — ' + detail); }
};

const lineOf = (source, pos) => source.slice(0, pos).split('\n').length;

/**
 * 从源码里抽出 `const NAME = \`...\`;` 的脚本体。
 * ⚠ 允许 `export ` 前缀（graphPage.js 里的常量是导出的，供守卫与离线 mock 复用）。
 */
function grab(source, name) {
	const marker = new RegExp('(?:^|\\n)(?:export )?const ' + name + ' = `');
	const hit = marker.exec(source);
	if (!hit) { return null; }
	const start = hit.index + hit[0].length;
	const end = source.indexOf('\n`;', start);
	if (end < 0) { return null; }
	return { code: source.slice(start, end), line: lineOf(source, start) };
}

const eslint = new ESLint({
	overrideConfigFile: true,
	overrideConfig: {
		languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser } },
		rules: { 'no-undef': 'error' },
	},
});

for (const target of TARGETS) {
	let source;
	try {
		source = readFileSync(LIB + target.file, 'utf8');
	} catch (e) {
		check('① ' + target.file + ' 能读取', false, String(e?.message ?? e));
		continue;
	}
	for (const name of target.names) {
		const got = grab(source, name);
		if (!got) { check('① ' + target.file + ' :: ' + name + ' 能提取', false, '提取失败（模板串被提前闭合？）'); continue; }
		check('① ' + target.file + ' :: ' + name + ' 能提取', true, got.code.length + ' 字符');
		const results = await eslint.lintText(got.code, { filePath: name + '.js' });
		const msgs = results.flatMap(r => r.messages);
		if (!msgs.length) { check('② ' + target.file + ' :: ' + name + ' 无未定义引用（no-undef）', true, 'clean'); continue; }
		const detail = msgs.slice(0, 6)
			.map(m => `${target.file}:${got.line + m.line - 1} ${m.message}`)
			.join(' ｜ ');
		check('② ' + target.file + ' :: ' + name + ' 无未定义引用（no-undef）', false, detail);
	}
}

console.log(`\n${pass}/${pass + fail} passed` + (fail ? `  ✗ ${fail} 条红` : '  ✓'));
process.exit(fail ? 1 : 0);
