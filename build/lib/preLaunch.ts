/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rootDir = path.resolve(import.meta.dirname, '..', '..');

function runProcess(command: string, args: ReadonlyArray<string> = []) {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { cwd: rootDir, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
		child.on('exit', err => !err ? resolve() : process.exit(err ?? 1));
		child.on('error', reject);
	});
}

async function exists(subdir: string) {
	try {
		await fs.stat(path.join(rootDir, subdir));
		return true;
	} catch {
		return false;
	}
}

async function ensureNodeModules() {
	if (!(await exists('node_modules'))) {
		await runProcess(npm, ['ci']);
	}
}

async function getElectron() {
	await runProcess(npm, ['run', 'electron']);
}

async function ensureCompiled() {
	if (!(await exists('out'))) {
		await runProcess(npm, ['run', 'compile']);
	}
}

/**
 * better-sqlite3 的 native 模块（build/Release/better_sqlite3.node）在
 * `npm install --ignore-scripts` 后缺失（install 脚本 prebuild-install/node-gyp
 * 被跳过），但 vendor 了 Electron-ABI 匹配的编译产物在 build/saros/bin/sqlite/。
 * dev 启动时自动复制到 node_modules，保证 KB 全文检索 / 媒体库 SQLite 可用。
 * （打包时由 build/saros/strip-before-pack.mjs 的 ensureFile 负责，与此互补。）
 */
async function ensureNativeModules() {
	const src = path.join(rootDir, 'build', 'saros', 'bin', 'sqlite', 'better_sqlite3.node');
	const dstDir = path.join(rootDir, 'node_modules', 'better-sqlite3', 'build', 'Release');
	const dst = path.join(dstDir, 'better_sqlite3.node');
	if (await exists(path.relative(rootDir, dst))) {
		return; // 已就位（正常 npm install 已编译，或上次已复制）
	}
	if (!(await exists(path.relative(rootDir, src)))) {
		return; // vendor 缺失（未生成，或非目标平台）
	}
	await fs.mkdir(dstDir, { recursive: true });
	await fs.copyFile(src, dst);
	console.log('[preLaunch] ensured better_sqlite3.node from build/saros/bin/sqlite/');
}

async function main() {
	await ensureNodeModules();
	await getElectron();
	await ensureCompiled();
	await ensureNativeModules();

	// Can't require this until after dependencies are installed
	const { getBuiltInExtensions } = await import('./builtInExtensions.ts');
	await getBuiltInExtensions();
}

if (import.meta.main) {
	main().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
