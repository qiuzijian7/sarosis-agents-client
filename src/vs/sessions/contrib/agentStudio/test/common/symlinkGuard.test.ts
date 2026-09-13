/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 符号链接逃逸防护 —— `realPathBestEffort` / `realRootsBestEffort`（2026-09-13）。
 *
 * ## 缺口（本模块存在的理由）
 *
 * 沙箱边界（`workspacePathResolver`，URI + `isEqualOrParent`）与写黑名单
 * （`writeDenyList`，「纯函数、零 Node 依赖」）**都是纯词法判定** → **不解析符号链接**：
 *
 * ```
 * <workspace>/evil   --symlink-->   ~/.vssaros/User
 * file_write("<workspace>/evil/settings.json")
 * ```
 * 四条判定全部落空（沙箱判「在根内」✓；写黑名单 / 敏感路径 / 受保护路径按**词法**
 * 路径查 ✗）→ 落到 `isSandboxFileWriteAutoApproved` → **免审批改写 provider apiKey**。
 *
 * ## 本用例钉住的核心性质
 *
 * 1. 真实路径与词法路径不同时**必须**返回真实路径（否则缺口依旧）；
 * 2. **解析失败一律原样返回** —— 这是接入它是 fail-safe 的前提（新建文件、平台不支持）；
 * 3. 允许根与目标用**同一把尺**（两侧都解析），否则会引入误拒
 *    （macOS `/tmp` 是 `/private/tmp` 的符号链接）。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/common/symlinkGuard.test.ts
 */

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { realPathBestEffort, realRootsBestEffort, realPathAllowedWithinRoots } from '../../common/symlinkGuard.js';

/** 与 `URI.file(...).fsPath` 同口径的 key（Windows 盘符会被小写化）。 */
function key(p: string): string {
	return URI.file(p).fsPath.replace(/\\/g, '/');
}

/** 桩：路径 → 真实路径；未登记的路径视为不存在（realpath 抛错，同真实 FS 行为）。 */
function stubRealpath(map: Record<string, string>): (uri: URI) => Promise<URI> {
	const normalized = new Map<string, string>();
	for (const [k, v] of Object.entries(map)) {
		normalized.set(key(k), v);
	}
	return async (uri: URI): Promise<URI> => {
		const hit = normalized.get(uri.fsPath.replace(/\\/g, '/'));
		if (hit === undefined) { throw new Error('ENOENT'); }
		return URI.file(hit);
	};
}

suite('symlinkGuard — 符号链接逃逸防护', () => {

	suite('realPathBestEffort', () => {

		test('★★ 已存在的 symlink 目标必须返回真实路径（缺口的核心）', async () => {
			const realpath = stubRealpath({
				'/ws/evil': '/home/u/.vssaros/User',
				'/ws/evil/settings.json': '/home/u/.vssaros/User/settings.json',
			});
			const out = await realPathBestEffort(realpath, '/ws/evil/settings.json');
			assert.strictEqual(out.replace(/\\/g, '/'), '/home/u/.vssaros/User/settings.json');
		});

		test('★★ 目标**不存在**时：解析最深的已存在祖先并拼回剩余段（新建文件场景）', async () => {
			// /ws/evil 是 symlink，但 /ws/evil/new.json 还不存在 → 必须上溯一级
			const realpath = stubRealpath({ '/ws/evil': '/home/u/.vssaros/User' });
			const out = await realPathBestEffort(realpath, '/ws/evil/new.json');
			assert.strictEqual(out.replace(/\\/g, '/'), '/home/u/.vssaros/User/new.json');
		});

		test('★★ 控制组：无 symlink 时原样返回（不得改变正常路径）', async () => {
			const realpath = stubRealpath({ '/ws/src/a.ts': '/ws/src/a.ts' });
			assert.strictEqual((await realPathBestEffort(realpath, '/ws/src/a.ts')).replace(/\\/g, '/'), '/ws/src/a.ts');
		});

		test('★★ 解析失败一律原样返回（fail-safe：行为与不调用本函数一致）', async () => {
			const alwaysThrow = async (): Promise<URI> => { throw new Error('EACCES'); };
			for (const p of ['/ws/src/a.ts', '/ws/evil/settings.json', '/nonexistent/deep/x']) {
				assert.strictEqual(await realPathBestEffort(alwaysThrow, p), p, p);
			}
		});

		test('★ 超过 maxDepth 时放弃并原样返回', async () => {
			const alwaysThrow = async (): Promise<URI> => { throw new Error('ENOENT'); };
			const deep = '/a/b/c/d/e/f/g/h';
			assert.strictEqual(await realPathBestEffort(alwaysThrow, deep, 3), deep);
		});

		test('★ 空路径不崩', async () => {
			const alwaysThrow = async (): Promise<URI> => { throw new Error('ENOENT'); };
			assert.strictEqual(await realPathBestEffort(alwaysThrow, ''), '');
		});
	});

	/**
	 * ★★ 沙箱里那些**不是主出口**的 return（如 P2 结构自愈的 `return repaired`）。
	 *
	 * 自愈用 `exists` 验证，而 `exists` **跟随 symlink**（`<ws>/link -> ~/.ssh` 下
	 * `link/id_rsa` 判为存在）→ 这条出口若不解析真实路径，就成了绕过主防护的第二条路。
	 */
	suite('realPathAllowedWithinRoots — 非主出口的二次校验', () => {

		test('★★ symlink 逃逸到允许根外 → false（自愈出口的护栏）', async () => {
			const realpath = stubRealpath({ '/ws/link': '/home/u/.ssh' });
			assert.strictEqual(
				await realPathAllowedWithinRoots(realpath, '/ws/link/id_rsa', ['/ws']),
				false,
				'真实路径落在 ~/.ssh → 必须拒绝',
			);
		});

		test('★★ 控制组：根内 symlink 解析后仍在根内 → true（不得误拒）', async () => {
			const realpath = stubRealpath({ '/ws/alias': '/ws/real' });
			assert.strictEqual(await realPathAllowedWithinRoots(realpath, '/ws/alias/a.ts', ['/ws']), true);
		});

		test('★★ 解析失败 → 退回词法判定（fail-safe，既不凭空拒绝也不凭空放行）', async () => {
			const alwaysThrow = async (): Promise<URI> => { throw new Error('ENOENT'); };
			assert.strictEqual(await realPathAllowedWithinRoots(alwaysThrow, '/ws/src/a.ts', ['/ws']), true);
			assert.strictEqual(await realPathAllowedWithinRoots(alwaysThrow, '/etc/passwd', ['/ws']), false);
		});
	});

	/**
	 * ⚠ 曾经的 `isSameLocation`（用 `URI.file` 比较两个路径是否同一位置）已**删除**：
	 * 测试当场证伪了它的前提 —— `URI.file('/tmp/v6.txt')` 在 Windows 上**并不**等于
	 * `URI.file('g:\\tmp\\v6.txt')`（前导 `/` 不会被映射到当前盘根）。
	 *
	 * 现改为**不依赖路径形态假设**的判据（在 `workspaceSecurity` 内）：
	 * 只在「真实路径**改变了边界判定**」时 warn，否则只记 debug。
	 */

	suite('realRootsBestEffort', () => {

		test('★★ 允许根必须与目标用同一把尺（防 macOS `/tmp` 式误拒）', async () => {
			// /tmp 是 /private/tmp 的符号链接；若只解析目标不解析根，
			// 位于 /tmp/foo 的工作区会被判成「越界」—— 本用例钉住两侧都解析。
			const realpath = stubRealpath({
				'/tmp/foo': '/private/tmp/foo',
				'/ws': '/ws',
			});
			const roots = await realRootsBestEffort(realpath, ['/tmp/foo', '/ws']);
			assert.deepStrictEqual(roots.map(r => r.replace(/\\/g, '/')), ['/private/tmp/foo', '/ws']);
		});

		test('★ 解析失败时保留原根（不丢根，否则会凭空拒绝一切）', async () => {
			const alwaysThrow = async (): Promise<URI> => { throw new Error('ENOENT'); };
			const roots = await realRootsBestEffort(alwaysThrow, ['/ws', '/other']);
			assert.deepStrictEqual(roots.map(r => r.replace(/\\/g, '/')), ['/ws', '/other']);
		});
	});
});
