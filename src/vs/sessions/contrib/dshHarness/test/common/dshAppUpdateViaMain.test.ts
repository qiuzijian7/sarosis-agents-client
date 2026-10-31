/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「检查更新必须在主进程发请求」的守卫（2026-10-30，真机 P0）。
 *
 * 真机：打包 exe 的「更新管理」检查更新红字 **`Failed to fetch`**。
 *
 * 原因：检查更新原来在**渲染进程**用 `IRequestService`（浏览器 XHR/fetch）直连更新源；
 * 更新源是内网静态托管（蓝盾构件 / 内网 nginx），**不发 CORS 头** ⇒ 浏览器把响应拦掉，
 * JS 只能看到 `Failed to fetch`。旁证：同一次启动里**主进程**的原生更新服务
 * （`update#setState available for download`，走主进程 HTTP）对同一个源**是通的**。
 * 我们自己的 `extensions/saros-pocket/app/app.js`（L2271 附近）早有同一坑的记录与解法：
 * "静态托管方通常不发 CORS 头 ⇒ JS 只能看到 Failed to fetch（真机实测踩到）；原生没有 CORS 概念"
 * ⇒ 它的解法就是经插件桥走**原生 fetch**。
 *
 * 修法：
 *   · 通道加 `CheckAppUpdate` 命令：渲染进程把拼好的 URL 传过来，**主进程**用 `this._fetch`
 *     代为请求（无跨域概念），失败返回 `{ ok:false, error }`（不抛 ⇒ 面板显示精确原因）；
 *   · 渲染进程 `_checkAppUpdate()` 只拼 URL / 解析响应，不再自己发请求；
 *   · URL 必须是 http/https（防把任意地址传进主进程请求）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshAppUpdateViaMain
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const COMMON = 'src/vs/sessions/contrib/dshHarness/common/dshHarness.ts';
const CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';
const SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	// ⚠ 只去"整行 //"：这些文件里有字符串含 `/*`（真机踩过：块注释正则会吞掉半个文件 ⇒ 假绿/假红）
	return s.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('检查更新必须在主进程发请求', () => {

	test('1) 通道命令 CheckAppUpdate 必须存在', () => {
		const src = stripComments(read(COMMON));
		assert.match(src, /CheckAppUpdate = 'checkAppUpdate',/, 'DshHarnessChannelCommand 缺 CheckAppUpdate');
	});

	test('2) 渲染进程不再自己发请求（不许出现 IRequestService / streamToBuffer 的更新取数）', () => {
		const src = stripComments(read(SERVICE));
		assert.ok(!src.includes('_requestService'), '渲染进程不许再用 IRequestService 直连更新源（CORS ⇒ Failed to fetch ✗）');
		assert.ok(!src.includes('IRequestService'), 'IRequestService 的 import 也要清掉');
		assert.ok(!src.includes('streamToBuffer'), 'streamToBuffer 是旧取数路径的残留，请一并清理');
		// 必须经通道：命令 + { url } 实参（⚠ 锚定"命令后面紧跟 { url }"，防止被文件里
		//   其它 `{ url }` 字面量糊弄过去 —— 上一版守卫就是被这个骗成假绿的）
		assert.match(src, /DshHarnessChannelCommand\.CheckAppUpdate,\s*\{\s*url\s*,?\s*\}/,
			'检查更新必须走 CheckAppUpdate 通道命令，且把拼好的更新源 URL 传给主进程');
	});

	test('3) 主进程代为请求：失败必须返回 `{ ok:false, error }`（不抛），且 URL 必须校验 http/https', () => {
		const src = stripComments(read(CHANNEL));
		const iCase = src.indexOf('case DshHarnessChannelCommand.CheckAppUpdate:');
		assert.ok(iCase > 0, '主进程通道缺 CheckAppUpdate 的 case');
		const body = src.slice(iCase, iCase + 1800);
		assert.match(body, /this\._fetch\(url\)/, '必须用主进程的 fetch（无 CORS 概念）');
		assert.match(body, /ok: false, error:/, '失败必须返回 { ok:false, error }');
		assert.match(body, /\^https\?:/, '必须校验 URL 只能是 http/https（防把任意地址传进主进程）');
		const iThrow = body.indexOf('throw ');
		assert.ok(iThrow < 0, 'handler 里不许 throw（否则渲染面板只看到笼统失败，看不到精确原因）');
	});
});
