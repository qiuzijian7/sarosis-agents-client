/*---------------------------------------------------------------------------------------------
 *  dshHarness *common* 测试的**可复跑入口**（2026-10-20 新增）。
 *
 *  为什么需要它：本目录有 60+ 个 `*.test.ts`（IDE 侧的契约守卫：能力覆盖、授权、工具面、
 *  页面桥、插件清单……），但**一直没有 runner**。官方路径是 `gulp compile` 到 `out/` 再用
 *  `test/unit/node/index.js --run` 跑 —— 而这台机器上 `gulp compile` 会 OOM（大仓 + 12 万文件），
 *  结果是**这些守卫长期没人真正跑过**，只能靠改一处手写一个临时脚本（本轮 IDE 侧的
 *  `executeNode` 就是这么验的，脚本用完即删 ⇒ 下次又得重写）。
 *
 *  做法与 `agentStudio/test/common/run-all-common-tests.mjs` **同构**（那份是既有事实）：
 *    esbuild 现场 bundle（cjs）→ 按框架分流执行（mocha tdd / bdd / node:test）→ 汇总。
 *  ⚠ 两处细节照抄那份的理由（别自己发明）：
 *    ① `external: ['node:*','mocha']` —— mocha 用宿主那份，别被打进 bundle；
 *    ② `ts-js-resolve` 插件 —— VS Code 风格是 `import './x.js'` 实际指向 `x.ts`。
 *
 *  Usage（仓库根）：
 *      node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs            # 全部
 *      node .../run-all-common-tests.mjs dshIdeCapabilities                     # 名字含该串的
 *      node .../run-all-common-tests.mjs --list                                  # 只列出会跑哪些
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import os from 'node:os';
import fsSync from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Mocha = require('mocha');
const esbuild = await import('esbuild');

const testDir = import.meta.dirname;
const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const filters = argv.filter(arg => !arg.startsWith('--'));

/** 仅收 `*.test.ts`（`_` 前缀留给 fixture/helper）。 */
let testFiles = fsSync
	.readdirSync(testDir)
	.filter(file => /^[a-z].+\.test\.ts$/i.test(file))
	.sort()
	.map(file => path.resolve(testDir, file));

if (filters.length > 0) {
	testFiles = testFiles.filter(file => filters.some(f => path.basename(file).includes(f)));
}
if (testFiles.length === 0) {
	console.error(`No test files matched: ${filters.join(', ') || '(none)'}`);
	process.exit(1);
}
if (listOnly) {
	for (const file of testFiles) { console.log(path.relative(process.cwd(), file).replace(/\\/g, '/')); }
	process.exit(0);
}

/** `import './x.js'` 实际指向 `x.ts`（VS Code 风格）。 */
const tsResolvePlugin = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /\.js$/ }, args => {
			if (!args.path.startsWith('.') && !args.path.startsWith('/')) { return undefined; }
			const resolved = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
			return fsSync.existsSync(resolved) ? { path: resolved, namespace: 'file' } : undefined;
		});
	},
};

/** 三种风格各需不同执行方式（见 agentStudio 那份的注释：判定顺序要紧）。 */
function detectFramework(file) {
	const src = fsSync.readFileSync(file, 'utf8');
	if (/from\s+['"]node:test['"]/.test(src)) { return 'node:test'; }
	if (/^\s*describe\s*\(/m.test(src) && !/^\s*suite\s*\(/m.test(src)) { return 'mocha-bdd'; }
	return 'mocha-tdd';
}

const stamp = Date.now();
const built = [];
const buildFailed = [];
const tempFiles = [];

console.log(`[dshHarness common] ${testFiles.length} 个测试文件`);
for (const entry of testFiles) {
	const label = path.basename(entry, '.test.ts');
	const out = path.join(os.tmpdir(), `dsh-harness-${stamp}-${label}.cjs`);
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
			tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
		});
		tempFiles.push(out);
		built.push({ label, out, framework: detectFramework(entry) });
	} catch (err) {
		buildFailed.push({ label, message: String(err?.message ?? err).split('\n')[0] });
		try { fsSync.unlinkSync(out); } catch { /* ignore */ }
	}
}

if (buildFailed.length > 0) {
	console.log(`\n[BUILD-FAIL] ${buildFailed.length} 个文件编译失败（**未执行**，不等于通过）：`);
	for (const item of buildFailed) { console.log(`  · ${item.label} — ${item.message}`); }
}
if (built.length === 0) {
	console.error('没有可执行的测试（全部编译失败）。');
	process.exit(1);
}

let totalPassing = 0;
let totalFailing = 0;
const failedSuites = [];

for (const target of built) {
	process.stdout.write(`\n=== ${target.label} (${target.framework}) ===\n`);
	if (target.framework === 'node:test') {
		// node:test 在导入时就注册到内建 runner ⇒ 必须交给 node 子进程（塞进 mocha 只会"0 passing"假绿）
		const { execFileSync } = await import('node:child_process');
		try {
			const stdout = execFileSync(process.execPath, ['--test', target.out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
			const pass = Number((stdout.match(/# pass (\d+)/) ?? [])[1] ?? 0);
			const fail = Number((stdout.match(/# fail (\d+)/) ?? [])[1] ?? 0);
			totalPassing += pass;
			totalFailing += fail;
			if (fail > 0) { failedSuites.push(target.label); }
			console.log(`  pass ${pass} / fail ${fail}`);
		} catch (err) {
			totalFailing += 1;
			failedSuites.push(target.label);
			console.log(`  FAIL（子进程非 0 退出）：${String(err?.stdout ?? err?.message ?? err).slice(-600)}`);
		}
		continue;
	}
	const mocha = new Mocha({ ui: target.framework === 'mocha-bdd' ? 'bdd' : 'tdd', timeout: 20_000, reporter: 'min' });
	mocha.addFile(target.out);
	const failures = await new Promise(resolve => {
		const runner = mocha.run();
		const list = [];
		runner.on('pass', () => { totalPassing += 1; });
		runner.on('fail', (test, err) => {
			totalFailing += 1;
			list.push(`${test?.fullTitle?.() ?? '(unknown)'} — ${String(err?.message ?? err).split('\n')[0]}`);
		});
		runner.on('end', () => resolve(list));
	});
	if (failures.length > 0) {
		failedSuites.push(target.label);
		for (const line of failures.slice(0, 8)) { console.log(`  ✗ ${line}`); }
		if (failures.length > 8) { console.log(`  … 还有 ${failures.length - 8} 条`); }
	} else {
		console.log('  ✓');
	}
}

for (const file of tempFiles) { try { fsSync.unlinkSync(file); } catch { /* ignore */ } }

console.log(`\n[dshHarness common] passing ${totalPassing} / failing ${totalFailing}（${built.length} 个文件，编译失败 ${buildFailed.length}）`);
if (failedSuites.length > 0) { console.log(`失败套件：${failedSuites.join(', ')}`); }
process.exit(totalFailing > 0 || buildFailed.length > 0 ? 1 : 0);
