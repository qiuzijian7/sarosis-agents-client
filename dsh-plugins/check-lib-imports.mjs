#!/usr/bin/env node
/**
 * ★ 2026-10-26（用户报：「工作流 item 点击删除没有清除」）：
 *
 * 守住这一类 bug —— **调用了兄弟模块的函数，但忘了 import**。
 * 真机表现：`{"ok":false,"error":"trashBundle is not defined"}`；而页面只把错误写进
 * `.tk-card .tk-err`（行式条目没有 `.tk-card`）⇒ 用户看到的是"点了没反应"。
 *
 * 为什么现有检查都拦不住：
 *   · `node --check` 只查语法，`trashBundle(...)` 语法完全合法；
 *   · 这些插件是纯 JS（无 .d.ts），`tsc` 不在链上；
 *   · 「入口能真正 import」只验证模块能加载，**不执行**到那个函数 ⇒ 照样绿。
 *
 * ## 为什么只扫 vssaros-marketplace
 * 通用版试过，误报压不下来（`apply()` 在其它插件里是对象方法/注释里的词、字符串里带 `/*`
 * 会把块注释配对到十万八千里）。与其留一个天天红、大家学会忽略的守卫，不如**扫得准**：
 * 这里只查 marketplace 的「纯函数工具模块」被主模块调用的情况 —— 这次的 bug 正在其中。
 * 将来要扩到别的插件，先确认那个插件的写法不会产生误报。
 */
import fs from 'node:fs';
import path from 'node:path';

const pluginLib = path.resolve(import.meta.dirname, 'vssaros-marketplace', 'lib');
/** 只查这些"纯工具模块"的导出（它们的名字不会与 DOM/对象方法重名）。 */
const HELPER_MODULES = ['installers.js', 'installedLedger.js', 'publisher.js', 'mcpInstall.js', 'shape.js', 'githubSource.js', 'githubInspect.js', 'publishPreflight.js'];

const exportsOf = (text) => {
	const names = new Set();
	for (const m of text.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) { names.add(m[1]); }
	for (const m of text.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) { names.add(m[1]); }
	return names;
};

const importedNamesOf = (text) => {
	const set = new Set();
	for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
		for (const part of m[1].split(',')) {
			const n = part.trim().split(/\s+as\s+/).pop().trim();
			if (n) { set.add(n); }
		}
	}
	for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]/g)) { set.add(m[1]); }
	for (const m of text.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]/g)) { set.add(m[1]); }
	return set;
};

/** 本地声明（function/class/const/let/var/解构/参数）—— 从**原文**算，宁可多算。 */
const localNamesOf = (text) => {
	const set = new Set();
	for (const m of text.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) { set.add(m[1]); }
	for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) { set.add(m[1]); }
	for (const line of text.split('\n')) {
		if (!/\b(?:const|let|var)\b/.test(line)) { continue; }
		const eq = line.indexOf('=');
		if (eq < 0) { continue; }
		for (const m of line.slice(0, eq).matchAll(/([A-Za-z_$][\w$]*)/g)) { set.add(m[1]); }
	}
	for (const m of text.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
		for (const part of m[1].split(',')) {
			const n = part.trim().split('=')[0].trim();
			if (/^[A-Za-z_$][\w$]*$/.test(n)) { set.add(n); }
		}
	}
	return set;
};

/** 只去掉"整行注释"（行注释、docblock 的星号行）与单行 import —— 不碰正文里的字符串。 */
const codeOf = (text) => text.split('\n')
	.filter(l => {
		const t = l.trim();
		if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t === '*/') { return false; }
		if (/^import\b/.test(t)) { return false; }
		return true;
	})
	.join('\n');

const usedAsCall = (code, name) => {
	const re = new RegExp('(?<![.\\w$])' + name.replace(/\$/g, '\\$') + '\\s*\\(', 'g');
	let m;
	while ((m = re.exec(code)) !== null) {
		const after = code.slice(m.index);
		if (/^[A-Za-z_$][\w$]*\s*\([^()]*\)\s*(?:\{|=>)/.test(after)) { continue; }        // 定义
		const lineStart = code.lastIndexOf('\n', m.index) + 1;
		if (/(?:async\s+|get\s+|set\s+)$/.test(code.slice(lineStart, m.index))) { continue; } // async/get/set 定义
		return true;
	}
	return false;
};

const results = [];
let failed = 0;

for (const mod of HELPER_MODULES) {
	const p = path.join(pluginLib, mod);
	if (!fs.existsSync(p)) { continue; }
	const expNames = exportsOf(fs.readFileSync(p, 'utf8'));
	const files = fs.readdirSync(pluginLib).filter(f => f.endsWith('.js') && f !== mod);

	for (const f of files) {
		const text = fs.readFileSync(path.join(pluginLib, f), 'utf8');
		const imported = importedNamesOf(text);
		const local = localNamesOf(text);
		const code = codeOf(text);
		for (const name of expNames) {
			if (imported.has(name) || local.has(name)) { continue; }
			if (!usedAsCall(code, name)) { continue; }
			failed++;
			results.push(`  FAIL ${f}：调用了 ${name}()（导出在 ${mod}）但没 import ⇒ 运行期 "X is not defined"`);
		}
	}
}

console.log('★ 兄弟模块导入守卫（marketplace：调用了就必须 import）');
console.log('');
if (!results.length) {
	console.log('  ok   marketplace 里"调用工具模块导出"的地方都已正确 import');
} else {
	for (const line of results) { console.log(line); }
	console.log('');
	console.log('  ' + failed + ' 处缺失');
}
process.exit(failed ? 1 : 0);
