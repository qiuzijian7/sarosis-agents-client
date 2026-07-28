/*---------------------------------------------------------------------------------------------
 *  CodebaseGraph SQLite 存储单元测试（esbuild + mocha，纯 Node.js 环境）。
 *
 *  用法：node run-codebaseGraphSqliteStore-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const Mocha = require('mocha');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, 'codebaseGraphSqliteStore.test.ts');

/** Map explicit `.js` imports to their `.ts` source (VS Code style). */
const tsResolvePlugin = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /\.js$/ }, async (args) => {
			if (!args.path.startsWith('.') && !args.path.startsWith('/')) { return undefined; }
			const candidate = args.path.replace(/\.js$/, '.ts');
			const resolved = path.resolve(args.resolveDir, candidate);
			const fs = await import('node:fs');
			if (fs.existsSync(resolved)) { return { path: resolved, namespace: 'file' }; }
			return undefined;
		});
	},
};

// 确保 better-sqlite3 可从编译产物解析（temp dir 不在项目树内）
const projectRoot = path.resolve(__dirname, '../../../../../../..');
const nodeModulesPath = path.join(projectRoot, 'node_modules');

// 直接追加到 Node.js 全局搜索路径（对所有后续 require 生效）
require('module').Module.globalPaths.push(nodeModulesPath);

// 输出到项目内目录（同驱动器，module resolution 可访问 node_modules）
const out = path.join(projectRoot, 'tmp', `codebaseGraphSqliteStore-test-${Date.now()}.cjs`);
fs.mkdirSync(path.join(projectRoot, 'tmp'), { recursive: true });

await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	outfile: out,
	plugins: [tsResolvePlugin],
	external: ['better-sqlite3', '@vscode/sqlite3', '../../node/codebaseGraphSqliteStore.js'],
}).catch(e => { console.error('BUILD FAILED:', e); process.exit(1); });

// 检测 better-sqlite3 是否可用，设置全局标记供测试文件使用
try {
	require('better-sqlite3');
	(globalThis).__KBSQLITE_AVAILABLE__ = true;
} catch {
	(globalThis).__KBSQLITE_AVAILABLE__ = false;
}

const mocha = new Mocha({ ui: 'bdd', timeout: 15000, reporter: 'spec' });
mocha.addFile(out);
mocha.run(failures => {
	process.exitCode = failures ? 1 : 0;
});
