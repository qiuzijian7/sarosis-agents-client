/*---------------------------------------------------------------------------------------------
 * Copyright (c) Saros. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('plugin startup rejects unsafe writes, repairs local packages without CLI and retains atomic rollback', { timeout: 90_000 }, () => {
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	const result = spawnSync(process.execPath, [
		'src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs',
		'dshPluginStartupSync', 'dshPluginDirectInstall', 'dshProfileRuntimeSync', 'dshHostReaper',
	], { cwd: root, env, encoding: 'utf8', timeout: 80_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
	assert.equal(result.status, 0, result.stdout || result.stderr || result.error?.message);
	const summary = /passing (\d+) \/ failing (\d+)（(\d+) 个文件，编译失败 (\d+)）/.exec(result.stdout);
	assert.ok(summary, result.stdout);
	assert.ok(Number(summary[1]) >= 43, result.stdout);
	assert.equal(summary[2], '0', result.stdout);
	assert.equal(summary[3], '4', result.stdout);
	assert.equal(summary[4], '0', result.stdout);
});
