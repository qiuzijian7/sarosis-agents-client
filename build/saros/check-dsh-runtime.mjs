/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 检查复制后的运行时能否加载依赖，并核对其自报版本。 */
export function checkDshRuntime(runtimeDir, expectedVersion) {
	const bin = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
	if (!existsSync(bin)) {
		return `运行时入口缺失：${bin}`;
	}
	const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
	delete env.NODE_OPTIONS;
	const result = spawnSync(process.execPath, [bin, '--version'], {
		cwd: runtimeDir, env, encoding: 'utf8', timeout: 15_000, windowsHide: true,
	});
	if (result.error || result.status !== 0) {
		return `运行时无法启动：${bin}\n${result.error?.message ?? ''}\n${(result.stderr ?? '').slice(-4000)}\n${(result.stdout ?? '').slice(-1200)}`.trim();
	}
	const actualVersion = result.stdout.trim().split(/\r?\n/).pop();
	if (actualVersion !== expectedVersion) {
		return `运行时自报版本 ${actualVersion || '(空)'} 与随包版本 ${expectedVersion} 不一致：${runtimeDir}`;
	}
	return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [runtimeDir, expectedVersion] = process.argv.slice(2);
	if (!runtimeDir || !expectedVersion) {
		console.error('用法：node build/saros/check-dsh-runtime.mjs <运行时目录> <预期版本>');
		process.exitCode = 1;
	} else {
		const problem = checkDshRuntime(resolve(runtimeDir), expectedVersion);
		if (problem) { console.error(problem); }
		else { console.log(`运行时检查通过：${expectedVersion}`); }
		process.exitCode = problem ? 1 : 0;
	}
}
