/*---------------------------------------------------------------------------------------------
 *  One-shot runner for ALL agentStudio *common* tests.
 *
 *  背景（2026-09-18）：本目录有 81 个 `*.test.ts`，但只有 38 个配了专用
 *  `run-<name>-tests.mjs` —— 余下 43 个**从未被任何命令执行过**。同时本目录
 *  混用两套测试框架，二者输出格式不同：
 *
 *    - mocha/tdd（`suite()` + `test()`）      → "N passing"
 *    - node:test（`import from 'node:test'`） → TAP："# pass N"
 *
 *  于是 `grep passing` 会静默漏掉 node:test 套件并误判为"无输出"。
 *  本聚合器按框架分流执行，统一汇总，让"跑全部 common 测试"成为一条命令。
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/agentStudio/test/common/run-all-common-tests.mjs
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import os from 'node:os';
import fsSync from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Mocha = require('mocha');
const esbuild = await import('esbuild');

const testDir = import.meta.dirname;

/** 仅收 `*.test.ts`；`_` 前缀留给 fixture/helper。 */
const testFiles = fsSync
	.readdirSync(testDir)
	.filter(f => /^[a-z].+\.test\.ts$/i.test(f))
	.sort()
	.map(f => path.resolve(testDir, f));

if (testFiles.length === 0) {
	console.error('No agentStudio common test files found.');
	process.exit(1);
}

/**
 * 判定测试文件用的框架/接口风格。
 *
 * 本目录实际存在三种，各需不同执行方式：
 *  - `node:test`：`test()` 在导入时注册到 Node 内建 runner，放进 mocha 实例
 *    里不会被统计（表现为"0 passing"的假绿），必须交给 `node` 子进程执行。
 *  - mocha BDD（`describe`/`it`）：mocha 实例须用 `ui: 'bdd'`，否则 `describe`
 *    未定义、模块级即崩溃。
 *  - mocha TDD（`suite`/`test`）：VS Code 仓库主流风格，`ui: 'tdd'`。
 *
 * 判定顺序要紧：node:test 优先（它也可能出现 describe 包裹）。
 */
function detectFramework(file) {
	const src = fsSync.readFileSync(file, 'utf8');
	if (/from\s+['"]node:test['"]/.test(src)) { return 'node:test'; }
	// BDD 与 TDD 的区分点是顶层用 describe( 还是 suite(
	if (/^\s*describe\s*\(/m.test(src) && !/^\s*suite\s*\(/m.test(src)) { return 'mocha-bdd'; }
	return 'mocha-tdd';
}

/** VS Code 风格：显式 `.js` 导入实际指向同名 `.ts` 源文件。 */
const tsResolvePlugin = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /\.js$/ }, (args) => {
			if (!args.path.startsWith('.') && !args.path.startsWith('/')) { return undefined; }
			const resolved = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
			return fsSync.existsSync(resolved) ? { path: resolved, namespace: 'file' } : undefined;
		});
	},
};

console.log(`Discovered ${testFiles.length} agentStudio common test file(s).`);

// ─── ① 逐个 bundle ───────────────────────────────────────────────────────────

const stamp = Date.now();
/** @type {{ label: string, out: string, framework: string }[]} */
const built = [];
/** 编译失败的文件（相对路径，正斜杠）—— 用于基线比对。 */
const buildFailedFiles = [];
const tempFiles = [];

for (const entry of testFiles) {
	const label = path.basename(entry, '.test.ts');
	const framework = detectFramework(entry);
	const out = path.join(os.tmpdir(), `agentstudio-common-all-${stamp}-${label}.cjs`);

	try {
		await esbuild.build({
			entryPoints: [entry],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			target: 'node20',
			sourcemap: 'inline',
			external: ['node:*', 'mocha'],
			outfile: out,
			plugins: [tsResolvePlugin],
			logLevel: 'silent',
			tsconfigRaw: {
				compilerOptions: {
					experimentalDecorators: true,
					useDefineForClassFields: false,
				},
			},
		});
		tempFiles.push(out);
		built.push({ label, out, framework });
	} catch (err) {
		buildFailedFiles.push(path.relative(process.cwd(), entry).replace(/\\/g, '/'));
		console.warn(`  [BUILD-FAIL] ${label} — ${String(err.message).split('\n')[0]}`);
		try { fsSync.unlinkSync(out); } catch { /* ignore */ }
	}
}

if (built.length === 0) {
	console.error('No test files built successfully — aborting.');
	process.exit(1);
}

const mochaTargets = built.filter(b => b.framework !== 'node:test');
const nodeTestTargets = built.filter(b => b.framework === 'node:test');
const bddCount = built.filter(b => b.framework === 'mocha-bdd').length;
console.log(`Built ${built.length} (mocha-tdd: ${mochaTargets.length - bddCount}, mocha-bdd: ${bddCount}, node:test: ${nodeTestTargets.length}), build-failed ${buildFailedFiles.length}.\n`);

// ─── ② 破损测试基线校验 ──────────────────────────────────────────────────────
// 与 browser 侧同构：已知破损固化为基线（存量待修），**新增破损立即失败**，
// 避免"编译失败只打一条 warn、退出码仍 0"导致破损测试静默潜伏。
const baselineFile = path.join(testDir, 'build-failure-baseline.json');
let baseline = [];
try { baseline = JSON.parse(fsSync.readFileSync(baselineFile, 'utf8')); } catch { /* 无基线 = 零容忍 */ }

const newlyBroken = buildFailedFiles.filter(f => !baseline.includes(f));
const fixedFiles = baseline.filter(f => !buildFailedFiles.includes(f));

// ─── ③ 执行 ──────────────────────────────────────────────────────────────────

let totalPassing = 0;
let totalFailing = 0;
let runtimeCrashed = 0;
/** @type {string[]} */
const failedLabels = [];

// node:test → 子进程，解析 TAP 计数
for (const { label, out } of nodeTestTargets) {
	let stdout = '';
	try {
		stdout = execFileSync(process.execPath, [out], {
			encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
		});
	} catch (err) {
		// node:test 有失败时退出码非 0，输出仍在 stdout 里 —— 不能当崩溃处理。
		stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`;
	}
	const pass = Number(/^# pass (\d+)$/m.exec(stdout)?.[1] ?? 0);
	const fail = Number(/^# fail (\d+)$/m.exec(stdout)?.[1] ?? 0);
	if (pass === 0 && fail === 0) {
		runtimeCrashed++;
		failedLabels.push(`${label} (node:test 无计数输出)`);
		console.warn(`  [RUNTIME-FAIL] ${label} — TAP 无 "# pass/# fail" 计数`);
		continue;
	}
	totalPassing += pass;
	totalFailing += fail;
	if (fail > 0) { failedLabels.push(`${label} (${fail} failing)`); }
	console.log(`  ${fail > 0 ? '✗' : '✓'} ${label.padEnd(34)} ${pass} pass, ${fail} fail   [node:test]`);
}

// mocha → 每文件独立实例，单文件模块级崩溃不拖垮整批。
// ui 必须随文件风格切换：BDD 文件在 tdd 接口下 `describe` 未定义会直接崩溃。
for (const { label, out, framework } of mochaTargets) {
	const ui = framework === 'mocha-bdd' ? 'bdd' : 'tdd';
	const mocha = new Mocha({ ui, timeout: 15000, reporter: 'min' });
	mocha.addFile(out);
	try {
		const failCount = await new Promise((resolve, reject) => {
			const runner = mocha.run(resolve);
			if (!runner) { reject(new Error('mocha.run() returned no runner')); }
		});
		const total = mocha.suite.total();
		totalPassing += total - failCount;
		totalFailing += failCount;
		if (failCount > 0) { failedLabels.push(`${label} (${failCount} failing)`); }
		console.log(`  ${failCount > 0 ? '✗' : '✓'} ${label.padEnd(34)} ${total - failCount} pass, ${failCount} fail   [mocha-${ui}]`);
	} catch (err) {
		runtimeCrashed++;
		failedLabels.push(`${label} (运行时崩溃)`);
		console.warn(`  [RUNTIME-FAIL] ${label} — ${String(err.message).split('\n')[0]}`);
	}
}

// ─── ④ 清理 + 汇总 ───────────────────────────────────────────────────────────

for (const f of tempFiles) {
	try { fsSync.unlinkSync(f); } catch { /* ignore */ }
}

if (fixedFiles.length > 0) {
	console.log(`\n✓ ${fixedFiles.length} 个基线破损测试已修复（请从 build-failure-baseline.json 移除）：`);
	for (const f of fixedFiles) { console.log(`    ${f}`); }
}
if (newlyBroken.length > 0) {
	console.error(`\n✗ ${newlyBroken.length} 个测试文件**新增**编译失败（不在基线内）——视为失败：`);
	for (const f of newlyBroken) { console.error(`    ${f}`); }
	console.error('  修复导入/符号后重跑；确属预期请显式加入 build-failure-baseline.json。');
}
if (failedLabels.length > 0) {
	console.error(`\n✗ ${failedLabels.length} 个套件未通过：`);
	for (const l of failedLabels) { console.error(`    ${l}`); }
}

console.log('\n---');
console.log(`Total: ${totalPassing} passing, ${totalFailing} failing`);
console.log(`Files: ${testFiles.length} discovered | ${built.length} built | ${buildFailedFiles.length} build-failed | ${runtimeCrashed} runtime-failed`);
if (baseline.length > 0) {
	console.log(`Build-failure baseline: ${baseline.length} known broken (see build-failure-baseline.json)`);
}
console.log('---');

process.exit((totalFailing || newlyBroken.length || runtimeCrashed) ? 1 : 0);
