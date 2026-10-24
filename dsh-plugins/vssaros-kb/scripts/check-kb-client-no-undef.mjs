/*
 * 守卫：`lib/client.js`（工作台面板单块）**不许有未定义标识符**（2026-10-24）。
 *
 * 起因：真机报「工作台加载失败 · c is not defined」——
 *   设置页里引用了 `c.line` / `c.fgFaint`，而那个组件作用域里从来没有 `c`。
 *   `node --check` 只验语法、tsc 不管这个文件 ⇒ 这类错误**只有渲染时才炸**，
 *   而宿主错误边界会把整个面板换成「渲染时出错」。
 *
 * 做法：用仓库已有的 eslint 跑 `no-undef`（browser + node globals）。
 * 这一条能覆盖"引用了不存在的变量 / 拼错标识符"整类问题。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-client-no-undef.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import globals from 'globals';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FILE = HERE + '../lib/client.js';

const eslint = new ESLint({
	overrideConfigFile: true,
	overrideConfig: [
		{
			files: ['**/*.js'],
			languageOptions: {
				ecmaVersion: 2022,
				sourceType: 'script',      // 它是经装载器执行的脚本，不是 ESM
				globals: { ...globals.browser, ...globals.node },
			},
			rules: { 'no-undef': 'error' },
		},
	],
});

const code = readFileSync(FILE, 'utf8');
const results = await eslint.lintText(code, { filePath: 'client.js' });
const problems = results.flatMap(r => r.messages.map(m => ({ line: m.line, text: m.message, rule: m.ruleId })));

console.log('='.repeat(60));
if (problems.length) {
	console.log(`✗ ${problems.length} 处未定义标识符：`);
	for (const p of problems.slice(0, 20)) {
		console.log(`   L${p.line}  ${p.text}  (${p.rule})`);
	}
	process.exit(1);
}
console.log('✓ client.js 无未定义标识符（no-undef 通过）');
