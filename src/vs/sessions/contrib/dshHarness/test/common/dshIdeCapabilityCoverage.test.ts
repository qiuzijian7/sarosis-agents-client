/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VsSaros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE 能力**覆盖**守卫（README 5.123，数据面 E 组）。
 *
 * 反向通道（协议 v2 ✓）里 dsh 插件发起的是 `ide.request` ✓，真正的实现是
 * `common/dshIdeCapabilities.ts` 的 `executeIdeCapability` 里那排 `case '<能力名>':` ✓。
 *
 * 为什么还要一条守卫（相邻守卫都**不覆盖**这一面 ✗）：
 *   · `dshIdeToolContract.test.ts` 钉的是**参数转交与预算** ✓（schema 声明的键必须交给能力 ✓）；
 *   · `dshIdeAuthorization.test.ts` 钉的是**授权与声明** ✓（用夹具 ✓，不看真实仓库 ✓）；
 *   · ⇒ **"工具请求的能力名，派发器里到底有没有对应 case"** 没人钉 ✗ —— 漏了的话只在**运行时**
 *     表现为"能力未实现" ✓（模型拿到一句错 ✓，而本可以在测试期就红 ✓）。
 *
 * ⚠ 只断**覆盖方向**（请求的 ⊆ 已实现 ✓），不断"实现了却没工具" ✗ —— 那可能是给页面/别的插件用的 ✓。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

/** 从 cwd 往上找仓库根（同 `dshWorkflowWriteLock.test.ts` 的约定）。 */
function repoRoot(): string | undefined {
	let dir = path.resolve(process.cwd());
	for (let depth = 0; depth < 6; depth += 1) {
		if (fs.existsSync(path.join(dir, 'dsh-plugins')) && fs.existsSync(path.join(dir, 'src'))) { return dir; }
		const parent = path.dirname(dir);
		if (parent === dir) { break; }
		dir = parent;
	}
	return undefined;
}

suite('dshHarness / IDE 能力覆盖（dsh 工具请求的 capability ⊆ 派发器 case）', () => {

	test('★ 覆盖率：每个请求的 capability 都有已实现的 case（漏了只在运行时红 ✗）', function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const dispatcherSrc = fs.readFileSync(path.join(root!, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'common', 'dshIdeCapabilities.ts'), 'utf8');
		const pluginSrc = fs.readFileSync(path.join(root!, 'dsh-plugins', 'vssaros-ide', 'lib', 'index.js'), 'utf8');

		// 派发器已实现的能力名：`case '<name>':` ✓（只在 `executeIdeCapability` 那个 switch 里 ✓）
		const switchBlock = /export async function executeIdeCapability[\s\S]*?\n\}/.exec(dispatcherSrc)?.[0] ?? dispatcherSrc;
		const implemented = new Set([...switchBlock.matchAll(/case\s+'([A-Za-z][\w.]*)':/g)].map(m => m[1]));

		// dsh 工具请求的能力名：`requestIde(bridge, '<name>'` ✓
		const requested = [...new Set([...pluginSrc.matchAll(/requestIde\([^,]+,\s*'([A-Za-z][\w.]*)'/g)].map(m => m[1]))];

		assert.ok(implemented.size >= 5, `派发器没解析出能力（拿到 ${implemented.size} 个：${[...implemented].join(', ') || '空'}）✗`);
		assert.ok(requested.length >= 5, `vssaros-ide 没解析出请求（拿到 ${requested.length} 个：${requested.join(', ') || '空'}）✗`);

		const missing = requested.filter(name => !implemented.has(name));
		assert.deepStrictEqual(missing, [],
			`dsh 请求了派发器里**没有**的能力 ✗：${missing.join(', ')}（运行时才报"能力未实现" ✓；` +
			`派发器现有：${[...implemented].sort().join(', ')}）`);
	});
});
