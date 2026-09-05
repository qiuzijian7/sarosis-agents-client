/*---------------------------------------------------------------------------------------------
 *  Generic esbuild + mocha runner for agentStudio *browser* tests.
 *  Mirrors the common/ run-*-tests.mjs pattern: bundles the .test.ts
 *  (resolving .js -> .ts), then runs it under mocha with the tdd UI
 *  (so `suite`/`test` globals are available).
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/newAgentTool.test.ts
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
// ★ bridge stub 与浏览器 visual harness **共用同一份实现**（webview/visual/bridgeStub.mjs）。
//   bridgeStub 是 `.mjs`（纯 JS）正因为本 runner 不经 esbuild 打包，只能 import `.mjs`。
//   这样才能杜绝「Node mocha / 浏览器 visual」两份 stub 各自演进导致行为漂移。
import { installBridgeMock } from '../../webview/visual/bridgeStub.mjs';

const require = createRequire(import.meta.url);
const Mocha = require('mocha');

const entryArg = process.argv[2];
if (!entryArg) {
	console.error('Usage: node run-browser-test.mjs <path-to-.test.ts>');
	process.exit(2);
}
const entry = path.resolve(process.cwd(), entryArg);

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
			const fs = await import('node:fs');
			if (fs.existsSync(resolved)) {
				return { path: resolved, namespace: 'file' };
			}
			return undefined;
		});
	},
};

const out = path.join(os.tmpdir(), `agentstudio-browser-test-${Date.now()}.cjs`);

await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	sourcemap: 'inline',
	// node:* 始终 external；其余可通过 TEST_EXTERNALS 环境变量追加（逗号分隔），
	// 用于跳过含原生 .node 二进制等无法 bundling 的依赖（运行时由 node 原生 require 加载）。
	external: ['node:*', ...(process.env.TEST_EXTERNALS ? process.env.TEST_EXTERNALS.split(',').map(s => s.trim()).filter(Boolean) : [])],
	outfile: out,
	plugins: [tsResolvePlugin],
	logLevel: 'warning',
	// 项目使用参数装饰器（DI），esbuild 默认不支持，需开启 experimentalDecorators
	// 并关闭 useDefineForClassFields，使其与 VS Code 的 tsc 编译行为一致。
	tsconfigRaw: {
		compilerOptions: {
			experimentalDecorators: true,
			useDefineForClassFields: false,
		},
	},
});

const mocha = new Mocha({ ui: 'tdd', timeout: 10000 });
// 浏览器侧模块（nodeExecutor/comfyRunner/nodeCard/stageWorkflowExecutor 等）在
// import 时读取 globalThis.__vssarosBridge（webview IIFE 副作用挂载）。node 测试
// 环境无该副作用 → 注入 stub。
//   mode='node' → 图片物化 fetch 返回 404，走 materializeComfyImageRefs 容错路径
//   （保留原 ref 不物化），保证 runSingleNode 等执行链可测。
// 仅当测试文件未自行设置时才注入（个别用例会带自己的 fetchLike）。
if (!(globalThis).__vssarosBridge) {
	installBridgeMock('node');
}
mocha.addFile(out);
mocha.run((failures) => {
	process.exit(failures ? 1 : 0);
});
