/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { INodeDistEntry, joinUrl, managedNodeLayout, nodeArchiveFor, npmCliCandidates, parseShasums, selectNodeVersion } from '../../common/dshNodeDist.js';
import { blockingSessions, snapshotName, snapshotsToPrune, summarizeHealth } from '../../common/dshUpgrade.js';

const INDEX: INodeDistEntry[] = [
	{ version: 'v25.1.0', lts: false, files: ['win-x64-zip', 'linux-x64', 'osx-arm64-tar'] },
	{ version: 'v24.11.1', lts: 'Krypton', files: ['win-x64-zip', 'linux-x64', 'osx-arm64-tar'] },
	{ version: 'v22.23.3', lts: 'Jod', files: ['win-x64-zip', 'win-arm64-zip', 'linux-x64', 'osx-arm64-tar'] },
	{ version: 'v22.18.0', lts: 'Jod', files: ['win-x64-zip', 'linux-x64'] },
	{ version: 'v20.19.0', lts: 'Iron', files: ['win-x64-zip', 'linux-x64'] },
];

suite('dshHarness / managed Node distribution', () => {

	test('picks the newest supported LTS that has an archive for the platform', () => {
		assert.strictEqual(selectNodeVersion(INDEX, 'win32', 'x64'), 'v24.11.1', 'current releases (non-LTS) are skipped');
		assert.strictEqual(selectNodeVersion(INDEX, 'win32', 'arm64'), 'v22.23.3', 'only versions with a win-arm64 zip qualify');
		assert.strictEqual(selectNodeVersion(INDEX, 'freebsd', 'x64'), undefined);
	});

	test('pinned version must exist and meet the dsh floor', () => {
		assert.strictEqual(selectNodeVersion(INDEX, 'linux', 'x64', '22.23.3'), 'v22.23.3');
		assert.strictEqual(selectNodeVersion(INDEX, 'linux', 'x64', 'v25.1.0'), 'v25.1.0', 'pinning may pick a non-LTS release');
		assert.strictEqual(selectNodeVersion(INDEX, 'linux', 'x64', '22.18.0'), undefined, 'below 22.19');
		assert.strictEqual(selectNodeVersion(INDEX, 'linux', 'x64', '20.19.0'), undefined);
		assert.strictEqual(selectNodeVersion(INDEX, 'linux', 'x64', '23.0.0'), undefined, 'not in index');
	});

	test('archive names and layouts follow the official dist', () => {
		assert.deepStrictEqual(nodeArchiveFor('v22.23.3', 'win32', 'x64'), { version: 'v22.23.3', fileName: 'node-v22.23.3-win-x64.zip', topDir: 'node-v22.23.3-win-x64', kind: 'zip' });
		assert.strictEqual(nodeArchiveFor('v22.23.3', 'darwin', 'arm64')?.fileName, 'node-v22.23.3-darwin-arm64.tar.gz');
		assert.strictEqual(nodeArchiveFor('v22.23.3', 'linux', 'ia32'), undefined);
		assert.deepStrictEqual(managedNodeLayout('win32').node, ['node.exe']);
		assert.deepStrictEqual(managedNodeLayout('linux').npmCli, ['lib', 'node_modules', 'npm', 'bin', 'npm-cli.js']);
	});

	test('SHASUMS256 parsing (text and binary markers)', () => {
		const a = 'a'.repeat(64);
		const b = 'B'.repeat(64);
		const sums = parseShasums(`${a}  node-v22.23.3-win-x64.zip\r\n${b} *node-v22.23.3-linux-x64.tar.gz\nnot a line\n`);
		assert.strictEqual(sums.get('node-v22.23.3-win-x64.zip'), a);
		assert.strictEqual(sums.get('node-v22.23.3-linux-x64.tar.gz'), b.toLowerCase());
		assert.strictEqual(sums.size, 2);
	});

	test('npm CLI is located next to the node executable', () => {
		assert.deepStrictEqual(npmCliCandidates('C:\\Program Files\\nodejs\\node.exe', 'win32'), ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js']);
		assert.deepStrictEqual(npmCliCandidates('/usr/local/bin/node', 'linux')[0], '/usr/local/lib/node_modules/npm/bin/npm-cli.js');
		assert.strictEqual(joinUrl('https://x/dist/', '/v22.1.0/', 'SHASUMS256.txt'), 'https://x/dist/v22.1.0/SHASUMS256.txt');
	});
});

suite('dshHarness / upgrade gate rules', () => {

	test('schedules do not block an upgrade; turns, jobs and subagents do', () => {
		const busy = blockingSessions({
			live: 4, sessions: [
				{ sessionId: 's1', kinds: ['schedule'] },
				{ sessionId: 's2', kinds: ['turn'] },
				{ sessionId: 's3', kinds: ['schedule', 'job'] },
				{ sessionId: 's4', kinds: ['subagent'] },
			],
		});
		assert.deepStrictEqual(busy, ['s2', 's3', 's4']);
		assert.deepStrictEqual(blockingSessions({ live: 0, sessions: [] }), []);
	});

	test('snapshot names sort by time; pruning keeps the newest', () => {
		const n = snapshotName(new Date('2026-10-09T06:35:52.123Z'), '0.2.0-rc.2', '0.2.1-alpha.1');
		assert.strictEqual(n, '20261009T063552-0.2.0-rc.2-to-0.2.1-alpha.1');
		const names = ['20261001T000000-a-to-b', 'junk', '20261003T000000-c-to-d', '20261002T000000-b-to-c', '20261004T000000-d-to-e'];
		assert.deepStrictEqual(snapshotsToPrune(names, 3), ['20261001T000000-a-to-b']);
		assert.deepStrictEqual(snapshotsToPrune(names.slice(0, 2), 3), []);
	});

	test('health is ok only when every check passes and there is at least one', () => {
		assert.strictEqual(summarizeHealth([]).ok, false);
		assert.strictEqual(summarizeHealth([{ name: 'a', ok: true }, { name: 'b', ok: false }]).ok, false);
		assert.strictEqual(summarizeHealth([{ name: 'a', ok: true }]).ok, true);
	});
});
