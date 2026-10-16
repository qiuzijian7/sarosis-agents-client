/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 真实下载托管 Node（约 30 MB）。默认跳过；设置 DSH_TEST_NODE_DOWNLOAD=1 才运行，
 * DSH_TEST_NODE_MIRROR 可指定镜像。安装到临时目录，结束后删除。
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { managedNodeLayout } from '../../common/dshNodeDist.js';
import { installManagedNode } from '../../electron-main/dshNodeInstaller.js';
import { DshRuntimeManager } from '../../electron-main/dshRuntimeManager.js';

(process.env.DSH_TEST_NODE_DOWNLOAD === '1' ? suite : suite.skip)('dshHarness / managed Node download (network)', function () {
	this.timeout(600_000);
	let root: string;
	const log: string[] = [];

	suiteSetup(() => root = mkdtempSync(join(tmpdir(), 'vssaros-node-dl-')));
	suiteTeardown(() => rmSync(root, { recursive: true, force: true }));

	test('download → sha256 → extract → self-check, then resolveNode prefers it', async () => {
		const t0 = Date.now();
		const r = await installManagedNode({ managedRoot: root, mirror: process.env.DSH_TEST_NODE_MIRROR, fetch: url => fetch(url), log: l => log.push(l) });
		const elapsed = Date.now() - t0;
		assert.ok(existsSync(r.path), r.path);
		assert.strictEqual(execFileSync(r.path, ['--version'], { encoding: 'utf8' }).trim(), r.version);
		assert.ok(existsSync(join(root, 'node', ...managedNodeLayout(process.platform).npmCli)), 'npm shipped');
		const meta = JSON.parse(readFileSync(join(root, 'node', '.vssaros-node.json'), 'utf8'));
		assert.strictEqual(meta.version, r.version);
		assert.match(meta.sha256, /^[0-9a-f]{64}$/);
		assert.ok(!existsSync(join(root, `node.tmp-${process.pid}`)), 'staging cleaned');
		console.log(`      managed Node ${r.version}: ${Math.round(r.bytes / 1024 / 1024)} MB in ${Math.round(elapsed / 1000)} s`);

		const rt = new DshRuntimeManager(root, () => { });
		const node = await rt.resolveNode(undefined);
		assert.strictEqual(node.source, 'managed');
		assert.strictEqual(node.version, r.version);

		// The bundled npm works through `node npm-cli.js` (what install() / distTagVersion() use).
		const latest = await rt.distTagVersion(node, 'latest');
		assert.match(latest, /^\d+\.\d+\.\d+/);
		console.log(`      npm view @deepseek-ai/dsh@latest via managed Node → ${latest}`);
	});

	test('a tampered checksum is rejected and leaves no node/ directory', async () => {
		const other = mkdtempSync(join(tmpdir(), 'vssaros-node-bad-'));
		try {
			const tamper = async (url: string) => {
				const res = await fetch(url);
				if (!url.endsWith('SHASUMS256.txt')) {
					return res;
				}
				const text = (await res.text()).replace(/^[0-9a-f]{64}/gm, '0'.repeat(64));
				return { ok: true, status: 200, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer };
			};
			await assert.rejects(installManagedNode({ managedRoot: other, mirror: process.env.DSH_TEST_NODE_MIRROR, fetch: tamper, log: () => { } }), /校验和不符/);
			assert.ok(!existsSync(join(other, 'node')), 'nothing installed');
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});
