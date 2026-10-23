/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 主 frame 导航决策的表驱动测试（2026-10-23）。
 *
 * 这张表的每一行都对应真机发生过（或极易发生）的一件事：
 *  · `/x/dashboard/` ⇒ 必须 **block** —— 它是"主页被切成会话页"的直接起因
 *    （视图整页被导航走 ⇒ 我们的插件不加载 ⇒ 白屏看门狗 reload ⇒ 中栏面板状态丢）；
 *  · `/?token=…` ⇒ 必须 **allow** —— 认证回退（401 后换带 token 的 authUrl）走的就是它；
 *  · 跨源 http(s) ⇒ **external**（交给系统浏览器，不留在视图里）；
 *  · `javascript:` / `file:` / 解析失败 ⇒ **block** 且**不**外开。
 */
import assert from 'assert';
import { decideMainFrameNavigation } from '../../common/dshViewNavigation.js';

const ORIGIN = 'http://127.0.0.1:7583';

suite('dshHarness / 视图主 frame 导航决策', () => {

	test('同源根路径放行（含带 token 的认证回退）', () => {
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/`, ORIGIN), 'allow');
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/?token=abc.def&x=1`, ORIGIN), 'allow');
	});

	test('同源非根路径一律 block（/x/dashboard/ 就是这条）', () => {
		for (const path of ['/x/dashboard/', '/x/dashboard', '/x/media/', '/x/kb/', '/settings']) {
			assert.strictEqual(decideMainFrameNavigation(ORIGIN + path, ORIGIN), 'block', path);
		}
		// 尾斜杠 / 大小写都不该被当成"根"
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}//`, ORIGIN), 'block');
	});

	test('跨源 http(s) 交给系统浏览器', () => {
		assert.strictEqual(decideMainFrameNavigation('https://example.com/doc', ORIGIN), 'external');
		assert.strictEqual(decideMainFrameNavigation('http://127.0.0.1:9999/', ORIGIN), 'external', '端口不同也算跨源');
		assert.strictEqual(decideMainFrameNavigation('http://localhost:7583/', ORIGIN), 'external', '主机名不同也算跨源');
	});

	test('非 http(s) 与非法地址：拦下且不外开', () => {
		for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'about:blank', 'not a url', '']) {
			assert.strictEqual(decideMainFrameNavigation(bad, ORIGIN), 'block', bad);
		}
	});

	test('没有连接时任何导航都不留在视图里（与改动前一致）', () => {
		for (const url of [`${ORIGIN}/`, `${ORIGIN}/x/dashboard/`, 'https://example.com/']) {
			assert.strictEqual(decideMainFrameNavigation(url, undefined), 'external', url);
		}
	});

	test('子域/协议变化都算跨源（不给"看起来像同源"的地址开后门）', () => {
		assert.strictEqual(decideMainFrameNavigation('https://127.0.0.1:7583/', ORIGIN), 'external', '协议不同');
		assert.strictEqual(decideMainFrameNavigation('http://evil.example.com:7583/', ORIGIN), 'external', '主机不同');
	});

	test('"看起来像 IP 但非法"的地址要按解析失败处理（block，不外开）', () => {
		// ⚠ `http://evil.127.0.0.1:7583/` 在 URL 解析里是**非法**的（末段是类数字 ⇒ 被当 IPv4 校验）
		//   ⇒ 走不到"跨源 ⇒ external"那条，而是解析失败 ⇒ block。这是对的：不该把没解析出来的地址丢给系统。
		assert.strictEqual(decideMainFrameNavigation('http://evil.127.0.0.1:7583/', ORIGIN), 'block');
	});

	// ★ 2026-10-23：**插件页路由子树**放行（真机：「记忆库」页「查看完整记忆」按钮点了没反应）
	//   根因 = "同源只放行 `/`" 把插件页下钻 `/x/memory/detail` 一起拦了 ✗
	test('插件页视图：自己路由子树内的同源导航要放行（含下钻页）', () => {
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/detail`, ORIGIN, '/x/memory/'), 'allow');
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/`, ORIGIN, '/x/memory/'), 'allow');
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/detail?tool=export-json`, ORIGIN, '/x/memory/'), 'allow');
	});

	test('插件页视图：路由子树**之外**的同源地址仍要拦（防整页被导航走）', () => {
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/dashboard/`, ORIGIN, '/x/memory/'), 'block',
			'别的模块页不在 /x/memory/ 子树里 ⇒ 必须拦（否则又回到"主页被导航成工作台页" ✗）');
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memoryx/`, ORIGIN, '/x/memory/'), 'block',
			'前缀相近但不同路由 ⇒ 不能误放行');
	});

	test('不传 currentPathname ⇒ 行为与改动前一致：只放行 `/`', () => {
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/detail`, ORIGIN), 'block');
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/`, ORIGIN), 'block');
	});

	// ★ 2026-10-23（真机日志坐实）：`blocked a main-frame navigation to /x/memory/detail`
	//   当年视图是 **chat**（id `dsh-desk-chat-*`）而不是 plugin-page ⇒ 按表面判会漏 ⇒ 按"当前 URL"判 ✓
	test('当前在模块页 ⇒ 同模块**子树内**的下钻放行（这正是「查看完整记忆」那一次点击）', () => {
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/detail`, ORIGIN, '/x/memory/'), 'allow');
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/detail?tool=export-md`, ORIGIN, '/x/memory/'), 'allow');
		// 当前已在详情页再点别的详情参数也放行（幂等）
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/detail?session=x`, ORIGIN, '/x/memory/detail'), 'allow');
	});

	// ★ 2026-10-23（真机日志）：`current` 实测是 **`/`**，页面其实是 `/#/x/memory/`（hash 路由）
	//   ⇒ 判据必须把 hash 归一成路径，否则"同一模块的下钻"永远判 block ✗✗
	test('模块页走 hash 路由时（`/#/x/memory/`）⇒ 同模块下钻也要放行', () => {
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/detail`, ORIGIN, `${ORIGIN}/#/x/memory/`), 'allow');
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/detail`, ORIGIN, '/#/x/memory/detail'), 'allow');
		// 只在根（`/`，没有 hash）⇒ 仍然拦（防"主页被导航成模块页"）
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/detail`, ORIGIN, `${ORIGIN}/`), 'block');
		// hash 在别的模块 ⇒ 跨模块 ⇒ 拦
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/detail`, ORIGIN, `${ORIGIN}/#/x/dashboard/`), 'block');
	});

	test('跨模块 / 从根跳模块页仍拦（「主页突然变成会话页」那个 bug 的防线）', () => {
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/dashboard/`, ORIGIN, '/x/memory/'), 'block',
			'跨模块必须拦');
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/dashboard/`, ORIGIN, '/'), 'block',
			'从根路径跳模块页必须拦（否则又回到"主页被导航成会话页"）');
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memoryx/`, ORIGIN, '/x/memory/'), 'block',
			'前缀相近但不是同一模块 ⇒ 不能误放行');
	});

	// ★★ 2026-10-23（真机定案）：记忆库页是**客户端 `/` 里的一屏**（主 frame、URL 仍为 `/`）
	//   ⇒ 用户点「查看完整记忆」= 主 frame 从 `/` 导航到 `/x/memory/detail` ⇒ 必须放行；
	//   而「主页突然变成会话页」那次是**页面自己**导航（无用户手势）⇒ 必须继续拦 ✓
	test('用户刚点出来的模块页导航 ⇒ 放行（记忆库「查看完整记忆」就是这种）', () => {
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/detail`, ORIGIN, `${ORIGIN}/`, true), 'allow');
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/dashboard/`, ORIGIN, `${ORIGIN}/`, true), 'allow');
	});

	test('**没有**用户手势的模块页导航 ⇒ 仍然拦（「主页突然变成会话页」的防线）', () => {
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/dashboard/`, ORIGIN, `${ORIGIN}/`, false), 'block');
		assert.strictEqual(decideMainFrameNavigation(`${ORIGIN}/x/memory/detail`, ORIGIN, `${ORIGIN}/`, false), 'block');
	});

	test('用户手势**不能**放宽跨源 / 非 http(s)（安全性不受影响）', () => {
		assert.strictEqual(decideMainFrameNavigation('https://example.com/x/memory/', ORIGIN, `${ORIGIN}/`, true), 'external');
		assert.strictEqual(decideMainFrameNavigation('javascript:alert(1)', ORIGIN, `${ORIGIN}/`, true), 'block');
	});
});
