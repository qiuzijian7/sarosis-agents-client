/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DSH_PLUGIN_ROUTE_MAX, resolveViewUrl, validatePluginRoute } from '../../common/dshPluginPage.js';

suite('dshPluginPage（插件页面路由与 URL 解析）', () => {

	test('接受站内绝对路径（含结尾斜杠、多段、点号/波浪号/下划线）', () => {
		for (const ok of ['/', '/x/vssaros-kanban/', '/x/kb', '/x/a.b/c_d~e/', '/a/b/c']) {
			assert.strictEqual(validatePluginRoute(ok), ok, ok);
		}
		assert.strictEqual(validatePluginRoute('  /x/kb  '), '/x/kb', '两端空白被裁掉');
	});

	test('拒绝协议相对地址、越界、空段、查询串与怪异字符', () => {
		for (const bad of [
			'//evil.example/x',      // 协议相对地址
			'x/y',                    // 非绝对
			'/x/../y',                // 越界
			'/..',                    // 越界
			'/x//y',                  // 中间空段
			'/x/y?token=1',           // 查询串由 authUrl 负责，路由不带
			'/x/y#frag',
			'/x/y%2e%2e',             // 百分号不在允许字符集
			'/x\\y',                  // 反斜杠
			'/x/ y',                  // 空白
			'',
			'/'.repeat(DSH_PLUGIN_ROUTE_MAX + 1),
			undefined, 42, {}, null,
		]) {
			assert.strictEqual(validatePluginRoute(bad), undefined, JSON.stringify(bad));
		}
	});

	test('有 Cookie：直接打 origin + 路由（不经过 token 交换）', () => {
		const origin = 'http://127.0.0.1:34567';
		const authUrl = `${origin}/?token=secret`;
		assert.strictEqual(resolveViewUrl({ origin, authUrl, route: '/x/kb/', hasAuth: true }), `${origin}/x/kb/`);
		assert.strictEqual(resolveViewUrl({ origin, authUrl, route: '/', hasAuth: true }), `${origin}/`);
	});

	test('无 Cookie：把 authUrl 的 pathname 换成路由，token 与 hash 保留', () => {
		const origin = 'http://127.0.0.1:34567';
		const authUrl = `${origin}/?token=secret`;
		assert.strictEqual(resolveViewUrl({ origin, authUrl, route: '/x/kb/', hasAuth: false }), `${origin}/x/kb/?token=secret`);
		assert.strictEqual(resolveViewUrl({ origin, authUrl, route: '/x/a/b', hasAuth: false }), `${origin}/x/a/b?token=secret`);
		const withHash = `${origin}/?token=secret#frag`;
		assert.strictEqual(resolveViewUrl({ origin, authUrl: withHash, route: '/x/kb/', hasAuth: false }), `${origin}/x/kb/?token=secret#frag`);
	});

	test('回归保护：route="/" 且无 Cookie 时逐字符原样返回 authUrl（既有行为不变）', () => {
		const authUrl = 'http://127.0.0.1:34567/?token=secret';
		assert.strictEqual(resolveViewUrl({ origin: 'http://127.0.0.1:34567', authUrl, route: '/', hasAuth: false }), authUrl);
		// 非法路由按官方整页处理，不把奇怪路径拼进 URL
		assert.strictEqual(resolveViewUrl({ origin: 'http://127.0.0.1:34567', authUrl, route: 'x/../y', hasAuth: false }), authUrl);
	});

	test('承载表面（2026-10-13）：`surface` 只追加给插件页、保留 token，官方整页逐字符不变', () => {
		const origin = 'http://127.0.0.1:34567';
		const authUrl = `${origin}/?token=secret`;
		// 有 Cookie：origin + route + `?surface=`（侧栏 / 编辑区承载同一个页面的分版依据）
		assert.strictEqual(resolveViewUrl({ origin, authUrl, route: '/x/dashboard/', hasAuth: true, surface: 'sideview' }),
			`${origin}/x/dashboard/?surface=sideview`);
		// 无 Cookie：**token 必须保留**（认证交换不能被打断），surface 追加在其后
		assert.strictEqual(resolveViewUrl({ origin, authUrl, route: '/x/dashboard/', hasAuth: false, surface: 'editor' }),
			`${origin}/x/dashboard/?token=secret&surface=editor`);
		const withHash = `${origin}/?token=secret#frag`;
		assert.strictEqual(resolveViewUrl({ origin, authUrl: withHash, route: '/x/dashboard/', hasAuth: false, surface: 'sideview' }),
			`${origin}/x/dashboard/?token=secret&surface=sideview#frag`);
		// ⚠ 回归：`route='/'` 是官方 Web Client 那条路 ⇒ 一个字符都不多
		assert.strictEqual(resolveViewUrl({ origin, authUrl, route: '/', hasAuth: false, surface: 'sideview' }), authUrl);
		assert.strictEqual(resolveViewUrl({ origin, authUrl, route: '/', hasAuth: true, surface: 'sideview' }), `${origin}/`);
		// 不传 surface ⇒ 与改造前逐字符相同（上面 4 个既有用例也在盯这一点）
		assert.strictEqual(resolveViewUrl({ origin, authUrl, route: '/x/dashboard/', hasAuth: false }), `${origin}/x/dashboard/?token=secret`);
		// 值一律 encode（宿主传白名单枚举，这里是防呆）
		assert.strictEqual(resolveViewUrl({ origin, authUrl, route: '/x/d/', hasAuth: true, surface: 'a b' }), `${origin}/x/d/?surface=a%20b`);
		// 退回分支（authUrl 不可解析）也要带上 surface
		assert.strictEqual(resolveViewUrl({ origin, authUrl: 'not a url', route: '/x/d/', hasAuth: false, surface: 'sideview' }),
			`${origin}/x/d/?surface=sideview`);
	});

	test('authUrl 不可解析时退回 origin + 路由（不打错站点）', () => {
		assert.strictEqual(
			resolveViewUrl({ origin: 'http://127.0.0.1:34567', authUrl: 'not a url', route: '/x/kb/', hasAuth: false }),
			'http://127.0.0.1:34567/x/kb/');
	});
});
