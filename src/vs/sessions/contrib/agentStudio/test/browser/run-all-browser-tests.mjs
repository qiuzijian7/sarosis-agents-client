/*---------------------------------------------------------------------------------------------
 *  One-shot runner for ALL agentStudio *browser* tests.
 *
 *  Mirrors run-browser-test.mjs but discovers *.test.ts files in this directory
 *  and runs them sequentially under a single Mocha instance.
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-all-browser-tests.mjs
 *      npm run test-agentstudio-browser
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import os from 'node:os';
import fsSync from 'node:fs';
import { spawn } from 'node:child_process';

const testDir = import.meta.dirname;

/**
 * 每个子进程分片承载的测试文件数。
 *
 * 271 个 bundle 全塞进单进程会耗尽 8GB 堆（见 _run-browser-shard.mjs 头注释）。
 * 20 是实测下"进程启动开销"与"峰值内存"的折中点；分片越小，单片超时丢的结果越少。
 */
const SHARD_SIZE = 20;

/**
 * 单片子进程的硬超时（ms）。
 *
 * worker 内已有 120s **文件级**看门狗兜底，这里只需覆盖整片；
 * 留足余量避免正常慢片被误杀，同时又不会让挂起片无限期拖住整批。
 */
const SHARD_TIMEOUT_MS = 420000;

/**
 * 判定测试文件用的框架/接口风格（与 common 侧 runner 同构）。
 *
 * `node:test` 的 `test()` 在导入时注册到 Node 内建 runner，放进 mocha 实例里
 * 不会被统计 —— 表现为"0 passing"的**假绿**，必须交给 `node` 子进程执行。
 */
function detectFramework(file) {
	const src = fsSync.readFileSync(file, 'utf8');
	if (/from\s+['"]node:test['"]/.test(src)) { return 'node:test'; }
	if (/^\s*describe\s*\(/m.test(src) && !/^\s*suite\s*\(/m.test(src)) { return 'mocha-bdd'; }
	return 'mocha-tdd';
}

// Discover all .test.ts files (exclude test-helper / fixture files starting with _)
const testFiles = fsSync
	.readdirSync(testDir)
	.filter(f => /^[a-z].+\.test\.ts$/.test(f))
	.sort()
	.map(f => path.resolve(testDir, f));

if (testFiles.length === 0) {
	console.error('No agentStudio browser test files found.');
	process.exit(1);
}

console.log(`Discovered ${testFiles.length} agentStudio browser test file(s):`);
for (const f of testFiles) {
	console.log(`  ${path.relative(process.cwd(), f)}`);
}

// ─── Bundle each test file with esbuild ──────────────────────────────────────

/** Map explicit `.js` imports to their `.ts` source when present (VS Code style). */
const tsResolvePlugin = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /\.js$/ }, async (args) => {
			if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
				return undefined;
			}
			const candidate = args.path.replace(/\.js$/, '.ts');
			const resolved = path.resolve(args.resolveDir, candidate);
			if (fsSync.existsSync(resolved)) {
				return { path: resolved, namespace: 'file' };
			}
			return undefined;
		});
	},
};

const esbuild = (await import('esbuild')).default;

const tempFiles = [];

let buildOk = 0;
let buildSkipped = 0;
/** 编译失败的测试文件（相对路径，正斜杠）——用于基线比对。 */
const buildFailedFiles = [];
/** @type {{ label: string, out: string, framework: string }[]} */
const built = [];

const stamp = Date.now();

for (const entry of testFiles) {
	const label = path.basename(entry, '.test.ts');
	const framework = detectFramework(entry);
	const out = path.join(os.tmpdir(), `agentstudio-browser-all-${stamp}-${path.basename(entry, '.ts')}.cjs`);

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
			logLevel: 'warning',
			tsconfigRaw: {
				compilerOptions: {
					experimentalDecorators: true,
					useDefineForClassFields: false,
				},
			},
		});
		tempFiles.push(out);
		built.push({ label, out, framework });
		buildOk++;
	} catch (err) {
		buildSkipped++;
		buildFailedFiles.push(path.relative(process.cwd(), entry).replace(/\\/g, '/'));
		console.warn(`  [SKIP] ${path.relative(process.cwd(), entry)} — ${err.message.split('\n')[0]}`);
		// Clean up the partial outfile if esbuild created it
		try { fsSync.unlinkSync(out); } catch { /* ignore */ }
	}
}

if (buildOk === 0) {
	console.error('No test files built successfully — aborting.');
	process.exit(1);
}

console.log(`\nBuilt ${buildOk} test file(s), skipped ${buildSkipped} (pre-existing build issues).`);

// ─── ★ 破损测试基线校验（2026-09-09）────────────────────────────────────────
// 背景：build 失败此前只打一条 [SKIP] warn、不影响退出码 —— 于是
// `workflowComfyNodeEditorForm.test.ts`（199 行）因品牌改名漏改导入符号，
// **从未执行过**却一直"绿"，既掩盖真实缺陷又给虚假安全感。
// 现在：已知破损清单固化为基线（存量待修），**新增破损立即失败**。
// 修好一个就从 BUILD_FAILURE_BASELINE 删一行；清单归零后可改为零容忍。
const baselineFile = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'build-failure-baseline.json');
let baseline = [];
try {
	baseline = JSON.parse(fsSync.readFileSync(baselineFile, 'utf8'));
} catch { /* 无基线文件 = 零容忍 */ }
const newlyBroken = buildFailedFiles.filter(f => !baseline.includes(f));
const fixedFiles = baseline.filter(f => !buildFailedFiles.includes(f));
if (fixedFiles.length > 0) {
	console.log(`\n✓ ${fixedFiles.length} 个基线破损测试已修复（请从 build-failure-baseline.json 移除）：`);
	for (const f of fixedFiles) { console.log(`    ${f}`); }
}
if (newlyBroken.length > 0) {
	console.error(`\n✗ ${newlyBroken.length} 个测试文件**新增**编译失败（不在基线内）——视为测试失败：`);
	for (const f of newlyBroken) { console.error(`    ${f}`); }
	console.error('  修复导入/符号后重跑；确属预期请显式加入 build-failure-baseline.json。');
}

// ─── Run bundles in child-process shards ────────────────────────────────────
// 此前 271 个 bundle 全 `require` 进本进程且从不清 require.cache，8GB 堆耗尽后
// 整批 OOM（FATAL ERROR: Ineffective mark-compacts）。改为分片跑子进程：
// 内存随进程退出释放，峰值只与 SHARD_SIZE 成正比。

let totalPassing = 0;
let totalFailing = 0;
let totalSkippedRuntime = 0;
let globFailures = 0;
/** @type {string[]} */
const failedLabels = [];

const mochaTargets = built.filter(b => b.framework !== 'node:test');
const nodeTestTargets = built.filter(b => b.framework === 'node:test');

/**
 * 异步跑一个子进程，把 stdout 全部收集起来。
 *
 * 用 `spawn`（异步）而非 `execFileSync`（同步）：同步版在超时时虽然会 kill 子进程，
 * 但父进程仍阻塞在管道读取上，Windows 下句柄未及时回收时会**永久挂住**整批
 * （实测 `graphParallelRun.test.ts` 触发过）。异步版的超时是真正可中断的。
 *
 * @param {string} script 要执行的脚本绝对路径
 * @param {string[]} scriptArgs 传给脚本的参数
 * @param {number} timeoutMs 硬超时
 * @returns {Promise<{ stdout: string, timedOut: boolean, code: number|null }>}
 */
function runChildCollect(script, scriptArgs, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [script, ...scriptArgs], {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});

		let stdout = '';
		let settled = false;
		child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
		// stderr 一并并入，避免 TAP 计数写在 stderr 的套件被漏读。
		child.stderr.on('data', (chunk) => { stdout += chunk.toString(); });

		const timer = setTimeout(() => {
			if (settled) { return; }
			settled = true;
			// Windows 上 kill 默认只发 SIGTERM，进程树里的孙进程可能残留，故强杀。
			try { child.kill('SIGKILL'); } catch { /* ignore */ }
			resolve({ stdout, timedOut: true, code: null });
		}, timeoutMs);

		child.on('close', (code) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, timedOut: false, code });
		});
		child.on('error', () => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, timedOut: false, code: -1 });
		});
	});
}

// node:test → 独立子进程，解析 TAP 计数。
// 这类文件塞进 mocha 实例不会被统计，此前一直是"0 passing"的假绿。
for (const { label, out } of nodeTestTargets) {
	const { stdout, timedOut } = await runChildCollect(out, [], 120000);
	const pass = Number(/^# pass (\d+)$/m.exec(stdout)?.[1] ?? 0);
	const fail = Number(/^# fail (\d+)$/m.exec(stdout)?.[1] ?? 0);
	if (pass === 0 && fail === 0) {
		totalSkippedRuntime++;
		failedLabels.push(`${label} (node:test 无计数输出${timedOut ? ' — 超时' : ''})`);
		console.warn(`  [RUNTIME-FAIL] ${label} — TAP 无 "# pass/# fail" 计数`);
		continue;
	}
	totalPassing += pass;
	totalFailing += fail;
	globFailures += fail;
	if (fail > 0) { failedLabels.push(`${label} (${fail} failing)`); }
	console.log(`  ${fail > 0 ? '✗' : '✓'} ${label.padEnd(38)} ${pass} pass, ${fail} fail   [node:test]`);
}

// mocha → 按 SHARD_SIZE 切片，每片一个子进程。
const shardWorker = path.resolve(testDir, '_run-browser-shard.mjs');
for (let i = 0; i < mochaTargets.length; i += SHARD_SIZE) {
	const shard = mochaTargets.slice(i, i + SHARD_SIZE);
	const manifest = path.join(os.tmpdir(), `agentstudio-browser-shard-${stamp}-${i}.json`);
	fsSync.writeFileSync(manifest, JSON.stringify(shard), 'utf8');

	const { stdout, timedOut: shardTimedOut } = await runChildCollect(
		shardWorker, [manifest], SHARD_TIMEOUT_MS,
	);
	process.stdout.write(stdout.split('\n').filter(l => !l.startsWith('@@')).join('\n'));

	/** 本片内已明确回报结果的文件（RESULT 或 CRASH）。 */
	const reported = new Set();
	for (const line of stdout.split('\n')) {
		const hit = /^@@RESULT\|(.+)\|(\d+)\|(\d+)$/.exec(line.trim());
		if (hit) {
			const pass = Number(hit[2]);
			const fail = Number(hit[3]);
			totalPassing += pass;
			totalFailing += fail;
			globFailures += fail;
			if (fail > 0) { failedLabels.push(`${hit[1]} (${fail} failing)`); }
			reported.add(hit[1]);
			continue;
		}
		const crash = /^@@CRASH\|(.+)$/.exec(line.trim());
		if (crash) {
			totalSkippedRuntime++;
			failedLabels.push(`${crash[1]} (运行时崩溃)`);
			reported.add(crash[1]);
		}
	}

	// ★ 应到未到核对：分片超时/被杀时，片尾文件从未回报 —— 必须显式记为失败，
	//   否则它们既不计 passing 也不计 failing，成为静默漏测（本仓库历史上已有先例）。
	for (const { label } of shard) {
		if (reported.has(label)) { continue; }
		totalSkippedRuntime++;
		globFailures += 1;
		failedLabels.push(`${label} (分片未回报${shardTimedOut ? ' — 触发片超时' : ''})`);
	}

	try { fsSync.unlinkSync(manifest); } catch { /* ignore */ }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────
const cleanup = () => {
	for (const f of tempFiles) {
		try { fsSync.unlinkSync(f); } catch { /* ignore */ }
	}
};
cleanup();

if (failedLabels.length > 0) {
	console.error(`\n✗ ${failedLabels.length} 个套件未通过：`);
	for (const l of failedLabels) { console.error(`    ${l}`); }
}

// ─── 失败用例基线校验（与 common 侧同构）────────────────────────────────────
// 本目录有 19 个既存功能失败（9 套件）+ 6 个环境崩溃（依赖 window/vssarosBridge）。
// 基线把存量标记为"待修"，**新增失败立即失败**，避免回归被存量噪音淹没。
const failBaselineFile = path.join(testDir, 'failure-baseline.json');
let failBaseline = {};
try {
	const parsed = JSON.parse(fsSync.readFileSync(failBaselineFile, 'utf8'));
	failBaseline = parsed.failingSuites ?? {};
} catch { /* 无基线 = 零容忍 */ }

/** 从 `label (N failing)` 解析出套件名与失败数；崩溃类不计入功能失败基线。 */
const observedFailures = new Map();
for (const l of failedLabels) {
	const m = /^(.+?) \((\d+) failing\)$/.exec(l);
	if (m) { observedFailures.set(m[1], Number(m[2])); }
}

const regressions = [];
for (const [suite, count] of observedFailures) {
	const known = failBaseline[suite]?.failing ?? 0;
	if (count > known) { regressions.push(`${suite} (${count} failing，基线容忍 ${known})`); }
}

const healedSuites = [];
for (const suite of Object.keys(failBaseline)) {
	if (!observedFailures.has(suite)) { healedSuites.push(suite); }
}

if (healedSuites.length > 0) {
	console.log(`\n✓ ${healedSuites.length} 个基线失败套件已修复（请从 failure-baseline.json 移除）：`);
	for (const s of healedSuites) { console.log(`    ${s}`); }
}

const knownFailing = [...observedFailures.values()].reduce((a, b) => a + b, 0);
const knownTolerated = Object.values(failBaseline).reduce((a, s) => a + (s.failing ?? 0), 0);
if (knownFailing > 0 || totalSkippedRuntime > 0) {
	console.log(`\n失败用例基线: ${knownFailing} 个既存失败（基线容忍 ${knownTolerated}）+ ${totalSkippedRuntime} 个环境崩溃 —— 见 failure-baseline.json`);
}
if (regressions.length > 0) {
	console.error(`\n✗ ${regressions.length} 个套件**新增**失败（超出基线）——视为回归：`);
	for (const r of regressions) { console.error(`    ${r}`); }
	console.error('  修复回归后重跑；确属预期请更新 failure-baseline.json。');
}

console.log(`\n---`);
console.log(`Total: ${totalPassing} passing, ${totalFailing} failing`);
console.log(`Built: ${buildOk} | Skipped (build): ${buildSkipped} | Skipped (runtime): ${totalSkippedRuntime}`);
if (baseline.length > 0) {
	console.log(`Build-failure baseline: ${baseline.length} known broken (see build-failure-baseline.json)`);
}
console.log(`---`);
// ★ 既存失败不判失败（基线容忍），但新增回归与新增编译失败必须判失败。
process.exit((regressions.length || newlyBroken.length) ? 1 : 0);
