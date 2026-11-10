/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P0-1（2026-11-10）：`workspace.context` 结构化根集的桥侧校验契约。
 *
 * 兼容期铁律：老载荷（不带 `roots`）必须**逐字照旧**放行；新字段给错了整份拒收
 * （静默丢字段会让"推了但没生效"伪装成成功 ✗，见 foundation 的三条纪律）。
 */

import assert from 'assert';
import { MAX_WORKSPACE_CONTEXT_ROOTS, validateWorkspaceContextArgs } from '../../common/dshBridgeProtocol.js';

suite('dshHarness / workspace context roots (P0-1)', () => {

	test('根上限与 foundation 对账（64）', () => {
		assert.strictEqual(MAX_WORKSPACE_CONTEXT_ROOTS, 64);
	});

	test('老载荷不带 roots ⇒ 照旧放行', () => {
		assert.strictEqual(validateWorkspaceContextArgs({
			workspaceId: 'ws-a', workspaceRoot: 'R:/a', relatedRoots: ['R:/a', 'R:/b'], windowId: 7, at: 123,
		}), true);
		assert.strictEqual(validateWorkspaceContextArgs({ relatedRoots: [] }), true);
	});

	test('结构化 roots 合法 ⇒ 放行', () => {
		assert.strictEqual(validateWorkspaceContextArgs({
			workspaceRoot: 'R:/a', relatedRoots: [],
			roots: [
				{ path: 'R:/a', name: 'frontend', isPrimary: true },
				{ path: 'R:/b', name: 'backend' },
			],
		}), true);
	});

	test('畸形 roots 一律整份拒收', () => {
		const base = { workspaceRoot: 'R:/a', relatedRoots: [] };
		const bad: unknown[] = [
			{ ...base, roots: 'not-an-array' },
			{ ...base, roots: [{ path: 123 }] },
			{ ...base, roots: [{ path: '   ' }] },
			{ ...base, roots: [{ path: 'R:/a', name: null }] },
			{ ...base, roots: [{ path: 'R:/a', name: 7 }] },
			{ ...base, roots: [{ path: 'R:/a', isPrimary: 'yes' }] },
			{ ...base, roots: [null] },
			{ ...base, roots: Array.from({ length: MAX_WORKSPACE_CONTEXT_ROOTS + 1 }, (_, i) => ({ path: `R:/r${i}` })) },
		];
		for (let i = 0; i < bad.length; i++) {
			assert.strictEqual(validateWorkspaceContextArgs(bad[i]), false, `第 ${i + 1} 组畸形载荷被放行了`);
		}
	});

	test('老字段畸形仍拒收（新校验没有放宽旧纪律）', () => {
		assert.strictEqual(validateWorkspaceContextArgs({ relatedRoots: 'not-an-array' }), false);
		assert.strictEqual(validateWorkspaceContextArgs({ workspaceRoot: 123 }), false);
	});
});
