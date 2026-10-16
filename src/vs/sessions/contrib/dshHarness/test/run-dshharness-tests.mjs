/*---------------------------------------------------------------------------------------------
 *  Runner for dshHarness tests (mocha TDD), bundled on the fly with esbuild.
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs           # common + node
 *      node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs --common  # unit only
 *      node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs --only dshBridgeReverse  # 单个文件
 *
 *  The node/ integration suite boots a real dsh Host; it is skipped (not failed) when no runtime is
 *  installed under poc/dsh-p0/.runtime (or DSH_TEST_RUNTIME_ROOT).
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Mocha = require('mocha');
const esbuild = await import('esbuild');

const here = import.meta.dirname;
const dirs = process.argv.includes('--common') ? ['common'] : ['common', 'node'];
// `--only <substring>`：只跑文件名匹配的测试（迭代时省掉"等 2 分钟集成套件"的时间；
// 交付前仍应跑全量）。
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
const files = dirs.flatMap(d => {
	const dir = path.join(here, d);
	return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.test.ts')).sort().map(f => path.join(dir, f)) : [];
}).filter(f => !only || f.includes(only));

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

const mocha = new Mocha({ ui: 'tdd', timeout: 20_000, reporter: 'spec' });
const outs = [];
for (const f of files) {
	const out = path.join(os.tmpdir(), `dshharness-${Date.now()}-${path.basename(f, '.ts')}.cjs`);
	await esbuild.build({
		entryPoints: [f], bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: 'inline',
		external: ['mocha', 'electron'], outfile: out, plugins: [tsResolve], logLevel: 'error',
		tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
	});
	outs.push(out);
	mocha.addFile(out);
}
const failures = await new Promise(resolve => mocha.run(resolve));
for (const o of outs) { try { fs.unlinkSync(o); } catch { /* ignore */ } }

// ── 收尾（2026-10-13 修：套件**跑完却永不退出**，已堆了 4 个僵尸进程）───────────────────────────
// 现象：`491 passing (8s)` + `1 failing` 打印完后，进程一直挂着（CPU 接近 0 ⇒ 是**等**，不是自旋），
// 每个僵尸进程下面都挂着 `esbuild.exe --service`，另有一个本地监听套接字 + 到 Chrome CDP 的 Established 连接。
// 两个动作缺一个就还会挂：
//   ① `esbuild.stop()`——`esbuild.build()` 会常驻一个**服务子进程**，runner 不调用 stop 就一直握着它的管道；
//   ② **显式退出**——测试本身可能留着活句柄（上面的套接字 / CDP 连接就是）⇒ 只设 `process.exitCode`、
//      等事件循环自己排空是**永远等不到**的（这正是"跑完了却不结束"的机制）。
// ⚠ ② 只是**兜底**，它会掩盖"某个测试没清干净"这件事 ⇒ 所以先把残留句柄类型打出来，便于定位到具体测试。
const code = failures ? 1 : 0;
try { await esbuild.stop?.(); } catch { /* 停不掉也不影响退出 */ }
try {
	const handles = (process._getActiveHandles?.() ?? [])
		.filter(h => h && h.constructor && h !== process.stdout && h !== process.stderr && h !== process.stdin);
	if (handles.length) {
		// 只报"1 个 Socket"没法定位 ⇒ 把**端口/方向**也打出来：是"服务端还在监听"还是"客户端连接没关"，
		// 一眼能区分（例：`Socket(server listening 127.0.0.1:57432)` vs `Socket(127.0.0.1:57432 -> 127.0.0.1:9223)`）。
		const describe = h => {
			const kind = h.constructor.name;
			try {
				if (typeof h.localPort === 'number' || typeof h.remotePort === 'number') {
					const listen = h.listening ? 'server listening ' : '';
					return `${kind}(${listen}${h.localAddress ?? '?'}:${h.localPort ?? '?'} -> ${h.remoteAddress ?? '-'}:${h.remotePort ?? '-'})`;
				}
				if (typeof h._idleTimeout === 'number') { return `${kind}(idle=${h._idleTimeout}ms)`; }
			} catch { /* 取不到细节就退回类型名 */ }
			return kind;
		};
		console.log(`[runner] ⚠ 结束时仍有 ${handles.length} 个活动句柄 ⇒ 有测试没清干净（本次靠显式退出收尾）：${handles.map(describe).join('；')}`);
	}
} catch { /* 内省 API 不可用就跳过 */ }
process.exit(code);
