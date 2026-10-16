/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IBridgeWorkspace } from '../../common/dshBridgeProtocol.js';
import { DshWorkspaceSync, MAX_PATHS_PER_WINDOW, sanitizeWorkspacePaths } from '../../electron-main/dshWorkspaceSync.js';

const ABS = process.platform === 'win32' ? ['C:\\w\\a', 'C:\\w\\b', 'C:\\w\\c'] : ['/w/a', '/w/b', '/w/c'];
const [A, B, C] = ABS;

/** 假控制桥：记录每次调用；`reject` 中的路径返回条目级错误；`fail` 为真时整体抛错。 */
function fakeEnsure(opts: { reject?: string[]; fail?: () => boolean; delay?: number } = {}) {
	const calls: string[][] = [];
	const ensure = async (paths: readonly string[]): Promise<IBridgeWorkspace[]> => {
		calls.push([...paths]);
		if (opts.delay) {
			await new Promise(r => setTimeout(r, opts.delay));
		}
		if (opts.fail?.()) {
			throw new Error('bridge call timeout');
		}
		return paths.map(p => opts.reject?.includes(p) ? { path: p, error: 'ENOENT' } : { id: `id:${p.toLowerCase()}`, path: p.toLowerCase(), sessions: 0 });
	};
	return { ensure, calls };
}

suite('dshHarness / workspace sync', () => {
	let sync: DshWorkspaceSync;
	const log: string[] = [];
	setup(() => sync = new DshWorkspaceSync(l => log.push(l)));
	teardown(() => sync.dispose());

	test('sanitize: absolute only, no NUL, de-duplicated, capped', () => {
		assert.deepStrictEqual(sanitizeWorkspacePaths([A, ` ${A} `, 'rel/path', '', 42, `${B}\0x`, B, null]), [A, B]);
		assert.deepStrictEqual(sanitizeWorkspacePaths('not-an-array'), []);
		const many = Array.from({ length: 100 }, (_, i) => `${A}${i}`);
		assert.strictEqual(sanitizeWorkspacePaths(many).length, MAX_PATHS_PER_WINDOW);
	});

	test('reports before connect are held, then registered in one call on connect', async () => {
		const f = fakeEnsure();
		assert.deepStrictEqual(await sync.setWindowWorkspaces(1, [A, B]), []);
		await sync.setWindowWorkspaces(2, [B, C]);
		assert.strictEqual(f.calls.length, 0);
		assert.strictEqual(sync.state.connected, false);
		await sync.connect(f.ensure);
		assert.deepStrictEqual(f.calls, [[A, B, C]], 'union of all windows, each path once');
		assert.deepStrictEqual(sync.state.results.map(r => r.id), [`id:${A.toLowerCase()}`, `id:${B.toLowerCase()}`, `id:${C.toLowerCase()}`]);
	});

	test('while connected only new paths are sent; unchanged reports cost nothing', async () => {
		const f = fakeEnsure();
		await sync.connect(f.ensure);
		await sync.setWindowWorkspaces(1, [A]);
		await sync.setWindowWorkspaces(1, [A, B]);
		const again = await sync.setWindowWorkspaces(1, [A, B]);
		assert.deepStrictEqual(f.calls, [[A], [B]]);
		assert.strictEqual(again.length, 2, 'cached results returned');
		const withNew = await sync.setWindowWorkspaces(1, [A, B, C]);
		assert.deepStrictEqual(f.calls.at(-1), [C]);
		assert.strictEqual(withNew.length, 3, 'returns results for all of the window\'s paths, not only the new one');
	});

	test('rejected paths are reported and retried on the next report; whole-call failures retry too', async () => {
		let failing = true;
		const f = fakeEnsure({ reject: [C], fail: () => failing });
		await sync.setWindowWorkspaces(1, [A, C]);
		await sync.connect(f.ensure);
		assert.strictEqual(sync.state.results.length, 0, 'failed call records nothing');
		failing = false;
		await sync.setWindowWorkspaces(1, [A, C]);
		assert.deepStrictEqual(sync.state.results.map(r => r.error ?? 'ok'), ['ok', 'ENOENT']);
		await sync.setWindowWorkspaces(1, [A, C]);
		assert.deepStrictEqual(f.calls.at(-1), [C], 'only the rejected one is retried');
	});

	test('a new connection re-registers everything (Host restart / upgrade)', async () => {
		const f1 = fakeEnsure();
		await sync.setWindowWorkspaces(1, [A]);
		await sync.connect(f1.ensure);
		const f2 = fakeEnsure();
		await sync.connect(f2.ensure);
		assert.deepStrictEqual(f2.calls, [[A]]);
	});

	test('disconnect while a call is in flight discards its result', async () => {
		const slow = fakeEnsure({ delay: 50 });
		await sync.setWindowWorkspaces(1, [A]);
		const pending = sync.connect(slow.ensure);
		await sync.connect(undefined);
		await pending;
		assert.deepStrictEqual(sync.state, { connected: false, windows: [{ windowId: 1, paths: [A] }], results: [] });
	});

	test('calls are serialized; closing a window does not unregister anything', async () => {
		const f = fakeEnsure({ delay: 20 });
		await sync.connect(f.ensure);
		let inFlight = 0;
		let maxInFlight = 0;
		const wrap = (p: Promise<unknown>) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); return p.finally(() => inFlight--); };
		await Promise.all([wrap(sync.setWindowWorkspaces(1, [A])), wrap(sync.setWindowWorkspaces(2, [B]))]);
		assert.deepStrictEqual(f.calls, [[A], [B]]);
		sync.removeWindow(1);
		assert.deepStrictEqual(sync.state.windows.map(w => w.windowId), [2]);
		assert.strictEqual(sync.state.results.length, 2, 'dsh registrations are kept');
		assert.ok(maxInFlight >= 1);
	});
});
