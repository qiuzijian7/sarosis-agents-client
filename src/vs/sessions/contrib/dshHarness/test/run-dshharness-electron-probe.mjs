/*---------------------------------------------------------------------------------------------
 *  Bundle test/electron/channelProbe.ts and run it in VsSaros' own Electron (.build/electron).
 *  Requires a dsh runtime: DSH_TEST_RUNTIME_ROOT (default poc/dsh-p0/.runtime).
 *
 *      node src/vs/sessions/contrib/dshHarness/test/run-dshharness-electron-probe.mjs
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const esbuild = await import('esbuild');
const here = import.meta.dirname;
const repo = path.resolve(here, '../../../../../..');
const runtimeRoot = process.env.DSH_TEST_RUNTIME_ROOT ?? path.join(repo, 'poc', 'dsh-p0', '.runtime');
const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'state.json'), 'utf8')); } catch { return {}; } })();
const versions = fs.existsSync(runtimeRoot) ? fs.readdirSync(runtimeRoot).filter(v => fs.existsSync(path.join(runtimeRoot, v, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) : [];
const version = state.current && versions.includes(state.current) ? state.current : versions.sort().at(-1);
if (!version) {
	console.log(`SKIP: no dsh runtime under ${runtimeRoot}`);
	process.exit(0);
}
const exe = path.join(repo, '.build', 'electron', process.platform === 'win32' ? 'VsSaros.exe' : 'VsSaros');
if (!fs.existsSync(exe)) {
	console.log(`SKIP: Electron not found at ${exe}`);
	process.exit(0);
}

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshharness-probe-'));
const tsResolve = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /\.js$/ }, args => {
			if (!args.path.startsWith('.')) { return undefined; }
			const ts = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
			return fs.existsSync(ts) ? { path: ts } : undefined;
		});
	},
};
await esbuild.build({
	entryPoints: [path.join(here, 'electron', 'channelProbe.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22',
	external: ['electron'], outfile: path.join(appDir, 'main.cjs'), plugins: [tsResolve], logLevel: 'error',
	tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
});
// Preload: same options as build/next/index.ts compileStandaloneFiles (non-bundled CJS script).
const preloadOut = path.join(appDir, 'preload-dshView.js');
await esbuild.build({
	entryPoints: [path.join(here, '..', 'electron-browser', 'preload-dshView.ts')], outfile: preloadOut,
	bundle: false, format: 'cjs', platform: 'node', target: ['es2024'], logLevel: 'error',
});
// app.getAppPath() → appDir; the channel looks for <appPath>/dsh-plugins/vssaros-bridge like the product does.
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'dshharness-probe', main: 'main.cjs' }));
fs.cpSync(path.join(repo, 'dsh-plugins'), path.join(appDir, 'dsh-plugins'), { recursive: true });

const env = { ...process.env, DSH_TEST_RUNTIME_ROOT: runtimeRoot, DSH_TEST_PRELOAD: preloadOut, DSH_TEST_BIN: path.join(runtimeRoot, version, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), DSH_TEST_VIEW_PARTITION: `persist:vssaros-dsh-probe-${Date.now().toString(36)}` };
delete env.ELECTRON_RUN_AS_NODE;
// 仅诊断（README 4.57）：给 Host 挂"加载期插桩"——本机对依赖产物（node_modules/.runtime）的写入会被
// 静默回滚，所以插桩走我们自己的 preload + loader hook（磁盘上的包不动），输出同时进 stderr 与这个日志。
const instrLog = path.join(repo, 'poc', 'dsh-p0', '.out', 'dsh-host-instr.log');
env.VSSAROS_DSH_HOST_PRELOAD = path.join(here, 'electron', 'dshHostInstrument.preload.mjs');
env.VSSAROS_DSH_INSTR_LOG = instrLog;
// 每次跑**先清空**：日志是追加的，不清空会把上一轮的行混进来（首次实测就被混了，浪费一轮）。
fs.rmSync(instrLog, { force: true });
// DSH_TEST_NPM_INSTALL=1 adds a real npm install of a dsh version (~1 min).
const r = spawnSync(exe, [appDir], { env, encoding: 'utf8', timeout: process.env.DSH_TEST_NPM_INSTALL === '1' ? 420_000 : 180_000 });
const stdout = (r.stdout ?? '').split('\n').filter(l => /^(PASS|FAIL|\d+\/\d+|  |ERR|WARN|\[)/.test(l) || l.trim() === '').join('\n');
// 子进程的 stderr 不能丢：崩溃/启动失败时它才是唯一线索（曾因丢掉而只看到"没有输出"）。
const stderr = (r.stderr ?? '').split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-15).join('\n');
process.stdout.write(stdout + (stdout.endsWith('\n') || !stdout ? '' : '\n'));
if (stderr) {
	process.stdout.write(`--- probed app stderr (tail) ---\n${stderr}\n`);
}
if (r.error) {
	process.stdout.write(`--- spawn error: ${r.error.message} ---\n`);
}
// 插桩回收（诊断用）：确认 preload 真的生效了——没有这段，"没输出"会与"没插桩"混为一谈。
try {
	const lines = fs.readFileSync(instrLog, 'utf8').split('\n').filter(l => l.includes('[vssaros-instr]'));
	process.stdout.write(lines.length
		? `--- Host 插桩（${lines.length} 行）---\n${lines.join('\n')}\n`
		: '--- Host 插桩：日志为空（preload 未生效，或那两处没被走到）---\n');
} catch {
	process.stdout.write('--- Host 插桩：日志文件未生成（preload 未生效）---\n');
}
process.stdout.write(`--- exit code: ${r.status ?? 'signal ' + r.signal}${r.error ? ` (${r.error.code})` : ''} ---\n`);
// `--keep`：保留 appDir（调试/排查用——harness 落盘日志在 `<appDir>/dsh-run/harness-*.log` 里，
// 默认删掉是为了不留垃圾）。其余照旧。
if (process.argv.includes('--keep')) {
	process.stdout.write(`--- keeping appDir: ${appDir} ---\n`);
} else {
	fs.rmSync(appDir, { recursive: true, force: true });
}
process.exitCode = r.status ?? 1;
