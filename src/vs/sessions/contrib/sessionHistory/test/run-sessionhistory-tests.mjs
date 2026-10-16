/*---------------------------------------------------------------------------------------------
 *  会话 sideview（sessionHistory）纯逻辑测试运行器。
 *
 *  跑 `src/vs/sessions/contrib/sessionHistory/common/*.test.ts`（分组 / 配额 / 人格表解析）。
 *  这些测试**不依赖 DOM / 服务**，因此可以用 esbuild 现打现跑（秒级），
 *  不必先整仓 `npm run compile` 再 `npm run test-node`（分钟级）。
 *
 *  用法（仓库根）：
 *      node src/vs/sessions/contrib/sessionHistory/test/run-sessionhistory-tests.mjs
 *
 *  ⚠ 这里原本写着"整仓编译后也会被 `npm run test-node` 拾取"——**不成立**（2026-10-12 核实）：
 *     `test/unit/node/index.js:57` 的 TEST_GLOB **要求文件路径里有 `test/` 段**，而本目录的测试文件
 *     在兄弟目录 `../common/` 下 ⇒ 全量套件**够不到**它们。
 *     ⇒ 本 runner（npm script `test-session-history`）是这批测试**唯一**的执行入口，别删。
 *  注（踩过的坑）：写这条注释时不要把那个 glob 字面抄进来 —— 它的通配段含 `*` + `/` 的相邻组合，
 *     会在 JSDoc 块注释里**提前闭合注释**，整文件变语法错误（本次实测过 ✗）。
 *  手法照 `src/vs/sessions/contrib/agentStudio/test/common/_tsa-runner.mjs`（显式 .js → .ts 解析）。
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import fsSync from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const Mocha = require('mocha');

/** `import.meta.dirname` → `.../sessionHistory/test`；被测目录是它的兄弟 `common`。 */
const commonDir = path.resolve(import.meta.dirname, '../common');
const testFiles = fsSync.readdirSync(commonDir)
	.filter(f => /^[a-z][\w.-]*\.test\.ts$/i.test(f))
	.sort()
	.map(f => path.join(commonDir, f));

if (testFiles.length === 0) {
	console.error('No sessionHistory test files found in ' + commonDir);
	process.exit(1);
}

/** VS Code 风格：显式 `.js` 导入实际指向同名 `.ts` 源文件。 */
const tsJsResolve = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /\.js$/ }, (args) => {
			if (!args.path.startsWith('.')) { return undefined; }
			const resolved = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
			return fsSync.existsSync(resolved) ? { path: resolved } : undefined;
		});
	},
};

let failures = 0;
for (const testFile of testFiles) {
	// 产物写到系统临时目录：绝不往源码树里扔 .cjs（免得被误提交 / 被 grep 命中）。
	const out = path.join(os.tmpdir(), `sessionhistory-${path.basename(testFile)}.${process.pid}.cjs`);
	await esbuild.build({
		entryPoints: [testFile],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node20',
		external: ['node:*', 'mocha', 'assert'],
		outfile: out,
		logLevel: 'warning',
		plugins: [tsJsResolve],
	});
	const count = await new Promise((resolve) => {
		const mocha = new Mocha({ ui: 'tdd', reporter: 'spec' });
		mocha.addFile(out);
		mocha.run((f) => resolve(f ?? 0));
	});
	try { fsSync.unlinkSync(out); } catch { /* ignore */ }
	failures += count;
}

process.exit(failures === 0 ? 0 : 1);
