/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { renderSessionIdentityPreload } from '../../common/dshSessionIdentity.js';

suite('dshHarness / Session module identity', () => {
	let root: string;
	let bin: string;
	let runtimeEntry: string;
	let profileEntry: string;
	let preload: string;

	function writeSession(home: string, version = '0.2.2-rc.2'): string {
		const pkg = join(home, 'node_modules', '@deepseek-ai', 'dsh-session');
		mkdirSync(join(pkg, 'lib'), { recursive: true });
		writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version, type: 'module', main: 'lib/index.js' }));
		const entry = join(pkg, 'lib', 'index.js');
		writeFileSync(entry, 'export class Session { #log = []; append(value) { this.#log.push(value); return this.#log.length; } } export function appendPluginRecord(session, value) { return Session.prototype.append.call(session, value); }');
		return entry;
	}

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'dsh-session-identity-'));
		bin = join(root, 'host', 'bin.mjs');
		runtimeEntry = writeSession(join(root, 'host'));
		profileEntry = writeSession(join(root, 'profile'));
		writeFileSync(bin, '');
		preload = join(root, 'identity.mjs');
		writeFileSync(preload, renderSessionIdentityPreload(bin));
	});

	teardown(() => rmSync(root, { recursive: true, force: true }));

	function run(withPreload: boolean, script: string) {
		return spawnSync(process.execPath, [...(withPreload ? ['--import', pathToFileURL(preload).href] : []), '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
	}

	function script(): string {
		return `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const host = await import(${JSON.stringify(pathToFileURL(runtimeEntry).href)});
const profile = await import(${JSON.stringify(pathToFileURL(profileEntry).href)});
const byName = await createRequire(${JSON.stringify(join(root, 'profile', 'consumer.mjs'))})('@deepseek-ai/dsh-session');
assert.equal(host.Session, profile.Session);
assert.equal(host.Session, byName.Session);
assert.equal(profile.appendPluginRecord(new host.Session(), 'request'), 1);
console.log('shared identity and record append OK');`;
	}

	test('双实体副本未修复时会触发私有字段品牌错误', () => {
		const result = run(false, `const host = await import(${JSON.stringify(pathToFileURL(runtimeEntry).href)}); const profile = await import(${JSON.stringify(pathToFileURL(profileEntry).href)}); profile.appendPluginRecord(new host.Session(), 'request');`);
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /private|Receiver|class Session/);
	});

	test('Host preload 对齐 ESM 绝对路径及 CJS 包名解析，写入只发生一次', () => {
		const result = run(true, script());
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /shared identity and record append OK/);
	});

	test('版本不一致明确拒绝，不跨版本替换 Session 类', () => {
		writeSession(join(root, 'profile'), '0.2.1-rc.2');
		const result = run(true, script());
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /profile\/runtime version mismatch/);
	});

	(process.env.DSH_TEST_PROFILE_DIR && process.env.DSH_TEST_BIN ? test : test.skip)('真实已安装包：请求/取消记录成功且不写用户会话文件', () => {
		const realBin = process.env.DSH_TEST_BIN!;
		const realProfile = process.env.DSH_TEST_PROFILE_DIR!;
		writeFileSync(preload, renderSessionIdentityPreload(realBin));
		const source = `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
const host = await import(pathToFileURL(createRequire(${JSON.stringify(realBin)}).resolve('@deepseek-ai/dsh-session')).href);
const forgeEntry = realpathSync(${JSON.stringify(join(realProfile, 'node_modules', '@deepseek-ai', 'dsh-experimental-client-ui-forge', 'lib', 'index.js'))});
const profile = await import(pathToFileURL(createRequire(forgeEntry).resolve('@deepseek-ai/dsh-session')).href);
const session = host.Session.create('session-identity-regression');
profile.appendPluginRecord(session, 'plugin:forge/worktree', {action:'request', from:'main'});
profile.appendPluginRecord(session, 'plugin:forge/worktree', {action:'cancel'});
assert.equal(host.Session, profile.Session);
assert.equal(session.snapshotEvents().length, 2);
console.log('real Session request/cancel OK');`;
		const before = run(false, source);
		assert.notStrictEqual(before.status, 0);
		assert.match(before.stderr, /Receiver must be an instance of class Session/);
		const after = run(true, source);
		assert.strictEqual(after.status, 0, after.stderr);
		assert.match(after.stdout, /real Session request\/cancel OK/);
	});
});
