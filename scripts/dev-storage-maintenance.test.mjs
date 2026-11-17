/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { isBackupProfile, planDiagnostics, planMaintenance, applyPlan } from './dev-storage-maintenance.mjs';

const DAY = 86_400_000;
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-storage-test-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const put = (relative, content = 'diagnostic', age = 40) => {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		const date = new Date(Date.now() - age * DAY);
		fs.utimesSync(file, date, date);
		return file;
	};
	return { root, put };
}

test('backup and staging profiles are excluded without excluding live profiles', () => {
	for (const name of ['vssaros.bak-runtime-0.2.1-rc.2-123', 'vssaros.backup-123', '.trash-123', 'vssaros.staging-1']) {
		assert.equal(isBackupProfile(name), true, name);
	}
	for (const name of ['vssaros', 'desktop', 'backup-agent']) { assert.equal(isBackupProfile(name), false, name); }
	const deploy = fs.readFileSync(new URL('./dsh-plugin-deploy.mjs', import.meta.url), 'utf8');
	assert.match(deploy, /!d\.isDirectory\(\) \|\| isBackupProfile\(d\.name\)/);
});

test('audit is read only and only expired diagnostic names are candidates', t => {
	const { root, put } = fixture(t);
	const old = put('logs/app-stderr-20261101123456.log');
	put('logs/app-stdout-20261117123456.log', 'recent', 1);
	put('logs/main.log');
	put('logs/run-marker.json');
	put('dsh-run/host-aabbccdd.log');
	put('dsh-run/owner-aabb.json');
	put('User/globalStorage/saros.saros-codebuddy-provider/http-debug-2026-08-22.log');
	put('User/globalStorage/saros.saros-codebuddy-provider/auth.json');
	const plan = planDiagnostics(root);
	assert.deepEqual(plan.map(p => p.path.replace(/\\/g, '/')).sort(), [
		'User/globalStorage/saros.saros-codebuddy-provider/http-debug-2026-08-22.log',
		'dsh-run/host-aabbccdd.log', 'logs/app-stderr-20261101123456.log',
	].sort());
	assert.equal(fs.existsSync(old), true);
});

test('recent logs are capped at 50 per group but last 24 hours are protected', t => {
	const { root, put } = fixture(t);
	for (let i = 0; i < 60; i++) { put(`logs/app-stdout-${20261101000000 + i}.log`, 'log', 2); }
	put('logs/app-stdout-20261117000000.log', 'current', 0);
	const plan = planDiagnostics(root);
	assert.equal(plan.length, 11);
	assert.equal(plan.some(p => p.path.includes('20261117000000')), false);
});

test('rotation retains history and never truncates hardlinked source content', t => {
	const { root, put } = fixture(t);
	const file = put('logs/app-exit.log', Buffer.alloc(8 * 1024 * 1024, 97));
	const external = path.join(root, 'protected-copy');
	fs.linkSync(file, external);
	put('logs/app-exit.log.1', 'previous');
	put('logs/app-exit.log.2', 'older');
	put('logs/app-exit.log.3', 'oldest');
	const result = applyPlan(root, planDiagnostics(root));
	assert.equal(result.rotated, 1);
	assert.equal(fs.existsSync(file), false);
	assert.equal(fs.statSync(`${file}.1`).size, 8 * 1024 * 1024);
	assert.equal(fs.statSync(external).size, 8 * 1024 * 1024);
	assert.equal(fs.readFileSync(`${file}.2`, 'utf8'), 'previous');
	assert.equal(fs.readFileSync(`${file}.3`, 'utf8'), 'older');
});

test('linked log directories never cause traversal outside the profile', t => {
	const { root, put } = fixture(t);
	const outside = put('outside/app-stdout-20260101.log');
	fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'logs'), process.platform === 'win32' ? 'junction' : 'dir');
	assert.throws(() => planDiagnostics(root), /Linked path is protected/);
	assert.equal(fs.existsSync(outside), true);
});

test('old linked files are skipped rather than followed', t => {
	const { root, put } = fixture(t);
	const outside = put('outside/keep.log');
	fs.mkdirSync(path.join(root, 'logs'));
	fs.linkSync(outside, path.join(root, 'logs/app-stderr-20260101.log'));
	applyPlan(root, planDiagnostics(root));
	assert.equal(fs.readFileSync(outside, 'utf8'), 'diagnostic');
});

test('changed logs are not deleted after audit', t => {
	const { root, put } = fixture(t);
	const file = put('logs/app-stderr-20260101.log');
	const plan = planDiagnostics(root);
	fs.appendFileSync(file, 'new');
	const result = applyPlan(root, plan);
	assert.equal(result.removed, 0);
	assert.equal(result.skipped.length, 1);
});

test('a forged plan cannot delete user data or escape the root', t => {
	const { root, put } = fixture(t);
	const file = put('dsh-home/sessions/keep.json');
	const result = applyPlan(root, [{ path: 'dsh-home/sessions/keep.json', action: 'delete-file' }, { path: '../outside', action: 'delete-tree' }]);
	assert.equal(result.skipped.length, 2);
	assert.equal(fs.existsSync(file), true);
});

test('only known obsolete runtimes and aged video intermediates are candidates', t => {
	const { root, put } = fixture(t);
	put('dsh-runtime/0.2.1-alpha.3/package.json');
	put('dsh-runtime/0.2.1-rc.2/package.json');
	put('dsh-runtime/node/node.exe');
	put('dsh-runtime/0.2.2-rc.2/package.json');
	put('dsh-home/profiles/vssaros.bak-runtime-123/keep.json');
	put('tmp/video-analyze/task/_src/video.mp4');
	put('tmp/unknown/keep.bin');
	const dir = path.join(root, 'tmp/video-analyze');
	fs.utimesSync(dir, new Date(Date.now() - 40 * DAY), new Date(Date.now() - 40 * DAY));
	for (const d of ['tmp/video-analyze/task', 'tmp/video-analyze/task/_src']) {
		fs.utimesSync(path.join(root, d), new Date(Date.now() - 40 * DAY), new Date(Date.now() - 40 * DAY));
	}
	const plan = planMaintenance(root, { bundledVersion: '0.2.2-rc.2', references: 'C:\\Users\\u\\.vssaros-dev\\dsh-runtime\\0.2.1-rc.2' });
	assert.deepEqual(plan.map(p => p.path.replace(/\\/g, '/')).sort(), ['dsh-runtime/0.2.1-alpha.3', 'tmp/video-analyze']);
	assert.deepEqual(planMaintenance(root, { startup: true }), []);
});

test('linked runtime trees abort the audit rather than deleting the target', t => {
	const { root, put } = fixture(t);
	put('dsh-runtime/0.2.1-alpha.3/package.json');
	put('protected/keep.json');
	fs.symlinkSync(path.join(root, 'protected'), path.join(root, 'dsh-runtime/0.2.1-alpha.3/linked'), process.platform === 'win32' ? 'junction' : 'dir');
	assert.throws(() => planMaintenance(root, { bundledVersion: '0.2.2-rc.2' }), /Linked tree is protected/);
});

test('startup retention runs before launcher handles open and does not rotate during verdict polling', () => {
	const source = fs.readFileSync(new URL('./spawn-detached.mjs', import.meta.url), 'utf8');
	assert.ok(source.indexOf('const maintenance = maintainStartupLogs(') < source.indexOf('const outFd = fs.openSync('));
	assert.ok(source.indexOf('const maintenance = maintainStartupLogs(') < source.indexOf('const child = spawn('));
});
