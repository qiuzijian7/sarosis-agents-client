/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「控制桥连不上的 Host 不许接管」的守卫（2026-10-30，外部机器）。
 *
 * 真机：新包窗口开出来了，但顶部横幅
 *   `会话启动失败（第 3/3 次）：[dshHarness] startSession: 控制桥不可用（未安装伴生插件或 Host 未运行）`，
 * 中间一直是「后台服务已就绪，正在加载界面…」。主进程日志：
 *
 *     reused Host: bridge unavailable, URL-line fallback (控制桥连接超时（10000 ms）：connect ENOENT \\.\pipe\vssaros-dsh-…)
 *     reusing the Host started by pid 56968 at http://127.0.0.1:54980 (bridge: fallback)
 *
 * ⇒ 租约里**登记了控制桥**，但管道已不存在（旧包留下的 Host）。原来照样降级接管 ⇒ 桌面窗口建会话
 *   必须走桥 ⇒ 每次失败，且因为"已接管"永远不会换 Host ✗✗。
 *
 * 修法：`_adoptLease` 里桥连接失败 ⇒ 撤回拥有者记录（让回收器能收掉旧 Host）+ 返回 false
 *   ⇒ 调用方照常 `removeIfStale` → 回收孤儿 → 新起带桥的 Host；锁后的第二次接管跳过同一个 pid。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshNoAdoptBridgelessHost
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SUP = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function code(): string {
	const abs = path.join(process.cwd(), SUP);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	const s = fs.readFileSync(abs, 'utf8');
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

function adoptBody(src: string): string {
	const at = src.indexOf('private async _adoptLease(');
	assert.ok(at > 0, '找不到 _adoptLease');
	const end = src.indexOf('const origin = hello?.host.origin ?? lease.origin;', at);
	assert.ok(end > at, '_adoptLease 结构变了（找不到 origin 赋值）');
	return src.slice(at, end);
}

suite('控制桥连不上的 Host 不许接管', () => {

	test('1) 桥连接失败必须返回 false（不再降级接管）', () => {
		const body = adoptBody(code());
		const iCatch = body.indexOf('} catch (e) {', body.indexOf('DshBridgeClient.connect('));
		assert.ok(iCatch > 0, '找不到桥连接的 catch');
		const tail = body.slice(iCatch);
		assert.match(tail, /return false;/, '桥连不上时必须 return false —— 接管一个没有桥的 Host，会话永远建不起来 ✗');
		assert.ok(!/URL-line fallback/.test(tail), '不许再走"降级接管（URL-line fallback）"');
	});

	test('2) 拒绝接管时必须撤回拥有者记录（否则回收器以为有人在用，旧 Host 永远收不掉）', () => {
		const body = adoptBody(code());
		const iCatch = body.indexOf('} catch (e) {', body.indexOf('DshBridgeClient.connect('));
		const tail = body.slice(iCatch);
		const iDrop = tail.indexOf('this._dropOwnershipRecord();');
		const iRet = tail.indexOf('return false;');
		assert.ok(iDrop > 0 && iDrop < iRet, '必须在 return false 之前 _dropOwnershipRecord()');
	});

	test('3) 拿到启动锁后的第二次接管必须跳过刚拒绝的 pid', () => {
		const src = code();
		assert.match(src, /this\._bridgelessLeasePid = lease\.pid;/, '拒绝时要记下该 pid');
		assert.match(src, /leaseFromLock && leaseFromLock\.pid !== this\._bridgelessLeasePid/,
			'锁后的接管条件必须排除刚判过"桥连不上"的 Host（否则白等 10s 再失败一次）');
	});
});
