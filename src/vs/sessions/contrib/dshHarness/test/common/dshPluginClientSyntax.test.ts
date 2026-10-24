/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ★★ 2026-10-23（真机：启动后白屏 + 状态条永远停在「正在打开会话…（已等待 N 秒）」）：
 *
 * `dsh-plugins/vssaros-agents/lib/client.agents.js` 里 CSS 模板字符串的**注释**用了反引号：
 *
 * ```js
 * const CSS = `
 * /* 共享层没有"遮罩/阴影"令牌（`--wb-*` 只有字号…）*​/
 * `;
 * ```
 *
 * 第一个反引号就把模板**提前闭合**了 ⇒ 后面的 CSS 被当成 JS ⇒
 * `Uncaught SyntaxError: Invalid left-hand side expression in postfix operation`
 * ⇒ 整个 client bundle 加载失败（页面日志：`… loaded without registering …`）
 * ⇒ 它该注册的 UI 组件没注册 ⇒ dsh 页面渲染时抛
 * `scope 'session-maybe' rendered without an installed adapter` ⇒ React 树崩
 * ⇒ 我们的状态条永远停在「正在打开会话…」✗✗（**没有任何一处报错指向真正的文件**）。
 *
 * 这类错误在**编译期抓不到**（插件是纯 `.js`，不参与 `tsc`），只会在页面里炸；
 * 因此这里做一道**语法级守卫**：所有插件的入口/客户端 bundle 都必须能 `node --check` 通过。
 *
 * ⚠ 判据刻意用 `node --check`（真解析），不用正则猜 —— 模板字符串/正则/注释里的反引号
 *   只有真解析器分得清。
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join } from '../../../../../base/common/path.js';

const PLUGINS_ROOT = 'dsh-plugins';

/** 递归收集插件里的运行期 js（排除 test/ 与 vendor/ —— 那些不参与页面加载）。 */
function collectPluginJS(): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 3) { return; }
		for (const name of readdirSync(dir)) {
			if (name === 'node_modules' || name === 'test' || name === 'vendor' || name.startsWith('.')) { continue; }
			const p = join(dir, name);
			let st;
			try { st = statSync(p); } catch { continue; }
			if (st.isDirectory()) { walk(p, depth + 1); continue; }
			if (/\.(js|mjs|cjs)$/.test(name) && !/\.map$/.test(name)) { out.push(p); }
		}
	};
	for (const name of readdirSync(PLUGINS_ROOT)) {
		const p = join(PLUGINS_ROOT, name);
		let st;
		try { st = statSync(p); } catch { continue; }
		if (!st.isDirectory() || name === 'node_modules') { continue; }
		walk(p, 0);
	}
	return out;
}

suite('dsh plugins / client bundle 语法守卫（2026-10-23 「正在打开会话…」白屏事故）', () => {

	test('★ 所有插件的运行期 js 都必须通过 node --check', function () {
		this.timeout(120_000);
		const files = collectPluginJS();
		// 空跑保护：扫不到文件就失去意义
		assert.ok(files.length > 50, `只扫到 ${files.length} 个 js ⇒ 路径/过滤规则写坏了，守卫空跑 ✗`);

		const broken: string[] = [];
		for (const f of files) {
			try {
				execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
			} catch (err) {
				const stderr = String((err as { stderr?: Buffer | string }).stderr ?? '');
				const line = /:(\d+)\r?\n/.exec(stderr)?.[1] ?? '?';
				const kind = stderr.split(/\r?\n/).find(l => /Error/.test(l))?.trim() ?? 'SyntaxError';
				broken.push(`${f}:${line}  ${kind}`);
			}
		}
		assert.deepStrictEqual(broken, [],
			'插件里的 js 有语法错误 ⇒ 页面加载该 bundle 会失败（表现为白屏 / 「正在打开会话…」永远不停，且日志里不指向真凶）✗\n' + broken.join('\n'));
	});
});
