/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkDshRuntime } from './check-dsh-runtime.mjs';

function fixture(t, source) {
	const root = mkdtempSync(join(tmpdir(), 'vssaros-runtime-check-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	if (source !== undefined) {
		const bin = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
		mkdirSync(dirname(bin), { recursive: true });
		writeFileSync(join(dirname(bin), 'package.json'), '{"type":"module"}');
		writeFileSync(bin, source);
	}
	return root;
}

test('入口存在但依赖为空时拒绝打包', t => {
	const root = fixture(t, "import '@deepseek-ai/dsh-app-boot'; console.log('0.2.1-rc.2');");
	mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh-app-boot'), { recursive: true });
	const problem = checkDshRuntime(root, '0.2.1-rc.2');
	assert.match(problem, /运行时无法启动/);
	assert.match(problem, /ERR_MODULE_NOT_FOUND/);
});

test('入口不存在时拒绝打包', t => {
	assert.match(checkDshRuntime(fixture(t), '0.2.1-rc.2'), /运行时入口缺失/);
});

test('依赖可加载且版本匹配时放行', t => {
	assert.equal(checkDshRuntime(fixture(t, "console.log('0.2.1-rc.2');"), '0.2.1-rc.2'), undefined);
});

test('自报版本错误或为空时拒绝打包', t => {
	assert.match(checkDshRuntime(fixture(t, "console.log('0.2.1-alpha.3');"), '0.2.1-rc.2'), /不一致/);
	assert.match(checkDshRuntime(fixture(t, ''), '0.2.1-rc.2'), /不一致/);
});
