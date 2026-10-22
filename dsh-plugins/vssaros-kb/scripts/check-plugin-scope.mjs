/*
 * 守卫：插件**服务端代码**里不许有"未定义引用"。
 *
 * ★ 为什么需要（2026-10-19 真机事故）：`/x/kb/graph` 路由 handler 里调了 `vaultDisplayName(vault.id)`，
 *   而那个名字是 `renderPage()` **函数体内**的局部 `const`（依赖它自己的局部 `injectedVaults`）
 *   ⇒ handler 作用域里根本没有 ⇒ 用户**点图谱按钮就 500**：`vaultDisplayName is not defined`。
 *
 *   为什么既有守卫没抓到：
 *     · `node --check` 只查语法 ⇒ 这是**合法语法**（引用一个外层不存在的名字）✗；
 *     · `check-page-script` 扫的是**页内脚本**（浏览器侧），不覆盖服务端模块 ✗；
 *     · `check-page-templates` 只查模板串是否被提前闭合 ✗。
 *   ESLint 的 `no-undef` 带作用域分析 ⇒ 正是这类"跨作用域误用"的对症工具。
 *
 * 扫哪些：插件里**会被 Host 直接加载**的服务端模块（不要扫页内脚本，那些由 check-page-script 管）。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-plugin-scope.mjs
 * 反向突变：在任一 src 里写 `fooBar();` ⇒ 应报 no-undef。
 */
import { ESLint } from 'eslint';
import globals from 'globals';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LIB = HERE + '../lib/';

const FILES = [
	'index.js',
	'graphPage.js',
	'organize.js',
	'store.js',
	'pageShell.js',
	'lock.js',
	'foundationRef.js',
	'codiconSubset.js',
	'core/kbGraphData.js',
	'core/kbMindmap.js',
	'core/kbInsights.js',
	'core/kbNavigation.js',
];

const eslint = new ESLint({
	overrideConfigFile: true,
	overrideConfig: {
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			// 插件同时跑在 Node（Host 进程）与少量浏览器 API（`FileAccess` 之类的全局由 Host 提供，
			// 这里给两套 globals，宁可少报也不误报）
			globals: { ...globals.node, ...globals.browser },
		},
		rules: { 'no-undef': 'error' },
	},
});

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
	if (ok) { pass++; console.log('PASS  ' + name); }
	else { fail++; console.log('FAIL  ' + name + '  — ' + detail); }
};

for (const rel of FILES) {
	let results;
	try {
		results = await eslint.lintFiles([LIB + rel]);
	} catch (e) {
		check(rel + ' 可扫描', false, String(e?.message ?? e));
		continue;
	}
	const msgs = results.flatMap(r => r.messages).filter(m => m.ruleId === 'no-undef');
	if (!msgs.length) { check(rel + ' 无未定义引用', true); continue; }
	const detail = msgs.slice(0, 8).map(m => `${rel}:${m.line}:${m.column} ${m.message}`).join(' ｜ ');
	check(rel + ' 无未定义引用', false, detail);
}

console.log(`\n${pass}/${pass + fail} passed` + (fail ? `  ✗ ${fail} 条红` : '  ✓'));
process.exit(fail ? 1 : 0);
