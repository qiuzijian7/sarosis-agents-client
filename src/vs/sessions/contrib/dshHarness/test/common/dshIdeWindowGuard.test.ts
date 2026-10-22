/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「desktop 模式 ⇒ IDE 主窗口不露面」的守卫（2026-10-21）。
 *
 * 用户报障原话："在 desktop 模式下，点击登录，不要显示 ide 模式的窗口"。
 *
 * 现场（dev 实例真机日志，2026-10-21 21:04:23）：
 *   21:04:23.574 [dshHarness] page signInIde ⇒ IDE 账号服务 login
 *   21:04:23.662 [dshHarness] window 2 BLUR        ← 桌面窗口失焦（TOF 登录开了系统浏览器）
 *   21:04:25.306 [dshHarness] **window 1 FOCUS**   ← ★ IDE 主窗口被拉到前台 = 用户看到的"冒出一个 IDE 窗口"
 * ⇒ 我们的代码**没有**调用过 showWindow（`signInIde`/`signOutIde` 早已在
 *   `DSH_PAGE_COMMANDS_WITHOUT_IDE_UI` 里）⇒ 是**窗口层面**的外部动作 ⇒ 只在命令分发处拦**拦不住** ✗
 * ⇒ 守卫必须落在**主进程**（那边才观察得到 `show` / `focus` 事件）✓。
 *
 * 本守卫钉三件事：
 *   ① 判定口径（纯函数 `ideWindowGuardAction`）：隐藏态下 show/focus ⇒ 压回去；其余 ⇒ 不插手；
 *   ② 载荷校验（跨进程边界不许进脏值 ⇒ 也不许误伤别的窗口）；
 *   ③ **接线齐**：通道命令 → 主进程装/撤守卫 → 渲染进程下发 → 藏/显两处都调 → 登录分支兜底。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshIdeWindowGuard
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

import { ideWindowGuardAction, validateSetIdeWindowHiddenArgs } from '../../common/dshIdeWindowGuard.js';

const PROTOCOL = 'src/vs/sessions/contrib/dshHarness/common/dshHarness.ts';
const PAGE_PROTOCOL = 'src/vs/sessions/contrib/dshHarness/common/dshPageBridgeProtocol.ts';
const CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';
const SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
const FULL_WINDOW = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshFullWindowContribution.ts';
const CONTRIBUTION = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 去掉注释（防"注释里写了 case xxx"造成假绿）。 */
function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

/**
 * 取某个 case 块（从 `case '<name>':` 起，到下一个**同级** `case '` 之前）。
 *
 * ⚠ `signInIde` / `signOutIde` 是**共用一个块**（两个 case 标签挨着）⇒ 取 `signInIde` 时
 *   必须跨过 `signOutIde` 那个标签，否则拿到的只是一行标签、没有块体 ✗。
 */
function caseBlock(src: string, name: string): string {
	const at = src.indexOf(`case '${name}':`);
	assert.ok(at >= 0, `找不到 case '${name}':`);
	// 紧挨着的下一个 case 标签（共用块的那一族）⇒ 跨过去。
	const sibling = src.slice(at + 1).match(/\n\t\t\tcase '([a-zA-Z]+)':/);
	let end = src.indexOf("\n\t\t\tcase '", at + 1);
	if (sibling) {
		const siblingAt = at + 1 + src.slice(at + 1).indexOf(sibling[0]);
		end = src.indexOf("\n\t\t\tcase '", siblingAt + 1);
	}
	return src.slice(at, end > at ? end : src.length);
}

suite('desktop 模式：IDE 主窗口不许露面（点登录也不许）', () => {

	test('① 判定口径：只有"我们藏起来的"窗口，在 show/focus 时才压回去', () => {
		const hidden = { hiddenByUs: true };
		assert.strictEqual(ideWindowGuardAction(hidden, 'show'), 'rehide',
			'隐藏态下被 show ⇒ 必须压回去（否则 IDE 窗口就露面了 ✗）');
		assert.strictEqual(ideWindowGuardAction(hidden, 'focus'), 'rehide',
			'隐藏态下拿到焦点 ⇒ 必须压回去（系统把焦点还给本应用窗口时的典型形态 ✗）');
		assert.strictEqual(ideWindowGuardAction(hidden, 'hide'), 'ignore',
			'已经是隐藏态 ⇒ 什么都不做 ✓');
		assert.strictEqual(ideWindowGuardAction(hidden, 'blur'), 'ignore',
			'失焦不影响"藏不藏" ⇒ 什么都不做 ✓');

		// ⚠ 非隐藏态（用户在用 IDE 模式 / 已点「回到 IDE」）⇒ **一律不插手**
		//   （插手 = 把用户正在用的窗口藏起来 ✗）。
		const shown = { hiddenByUs: false };
		for (const ev of ['show', 'focus', 'hide', 'blur'] as const) {
			assert.strictEqual(ideWindowGuardAction(shown, ev), 'ignore',
				`非隐藏态下的 '${ev}' 不该触发守卫（会把用户正在用的窗口藏掉 ✗）`);
		}
	});

	test('② 载荷校验：跨进程边界不许进脏值（也不许误伤别的窗口）', () => {
		assert.ok(validateSetIdeWindowHiddenArgs({ hidden: true, windowId: 1 }),
			'合法负载必须通过 ✓');
		assert.ok(!validateSetIdeWindowHiddenArgs({ hidden: 'true', windowId: 1 }),
			'hidden 必须是布尔 ✗');
		assert.ok(!validateSetIdeWindowHiddenArgs({ hidden: true }),
			'缺 windowId ⇒ 不许进（不知道该守哪个窗口 ✗）');
		assert.ok(!validateSetIdeWindowHiddenArgs({ hidden: true, windowId: 0 }),
			'windowId 必须是正整数（0 / 负数都不许 ✗）');
		assert.ok(!validateSetIdeWindowHiddenArgs({ hidden: true, windowId: 1.5 }),
			'windowId 必须是整数 ✗');
		assert.ok(!validateSetIdeWindowHiddenArgs(undefined),
			'空负载不许进 ✗');
	});

	test('③ 接线：通道命令 + 主进程装/撤守卫 + 渲染进程下发', () => {
		const protocol = stripComments(read(PROTOCOL));
		assert.match(protocol, /SetIdeWindowHidden\s*=\s*'setIdeWindowHidden'/,
			'通道命令没登记 ⇒ 渲染进程下发的开关主进程收不到（守卫永远装不上 ✗）');

		const channel = stripComments(read(CHANNEL));
		assert.match(channel, /case DshHarnessChannelCommand\.SetIdeWindowHidden:/,
			'主进程没有这条命令的落点 ⇒ 守卫装不上 ✗');
		assert.match(channel, /validateSetIdeWindowHiddenArgs\(/,
			'主进程必须校验负载（跨进程边界 ⇒ 脏值不许进来 ✗）');
		// 守卫本体：show / focus 两个事件都要接，且都要把窗口藏回去。
		const guardAt = channel.indexOf('private _setIdeWindowGuard(');
		assert.ok(guardAt >= 0, '主进程里没有 _setIdeWindowGuard（守卫本体不见了 ✗）');
		const guard = channel.slice(guardAt);
		assert.match(guard, /win\.on\('show'/, '守卫必须盯 show 事件（窗口被系统显示出来的那一瞬 ✗）');
		assert.match(guard, /win\.on\('focus'/, '守卫必须盯 focus 事件（系统把焦点还给本应用窗口的那一瞬 ✗）');
		assert.match(guard, /win\.hide\(\)/, '判定为 rehide 时必须真的把窗口藏回去 ✗');
		assert.match(guard, /ideWindowGuardAction\(/,
			'判定必须走 common 的纯函数（口径只有一份，且可单测 ✗）');

		const service = stripComments(read(SERVICE));
		assert.match(service, /setIdeWindowHidden\(hidden: boolean, windowId: number\)/,
			'渲染侧服务没有这个方法 ⇒ 守卫开关发不出去 ✗');
		assert.match(service, /DshHarnessChannelCommand\.SetIdeWindowHidden/,
			'渲染侧服务没走这条通道 ✗');
	});

	test('④ 藏 / 显两处都必须调守卫（藏时装、显时先撤）', () => {
		const full = stripComments(read(FULL_WINDOW));
		assert.match(full, /setIdeWindowHidden\(true,/,
			'藏起 IDE 主窗口后必须**装守卫**（不然它被系统拉出来就没人管 ✗）');
		assert.match(full, /setIdeWindowHidden\(false,/,
			'显示 IDE 主窗口前必须**撤守卫**（不然刚 show 就被藏回去 = "点了没反应" ✗）');
		// ⚠ 顺序：撤守卫必须在 showWindow **之前**（反了 = 窗口刚露面就被藏 ✗）。
		const showAt = full.indexOf('private async _showIdeWindow(');
		assert.ok(showAt >= 0, '找不到 _showIdeWindow ✗');
		const show = full.slice(showAt);
		const iGuard = show.indexOf('setIdeWindowHidden(false');
		const iShow = show.indexOf('showWindow(');
		assert.ok(iGuard >= 0, '显示路径里没有撤守卫 ✗');
		assert.ok(iShow >= 0, '显示路径里没有 showWindow ✗');
		assert.ok(iGuard < iShow, '撤守卫必须排在 showWindow **之前**（反了 = 刚露面就被藏 ✗）');
	});

	test('⑤ 登录分支：desktop 模式下点登录，IDE 主窗口必须保持隐藏', () => {
		const contribution = stripComments(read(CONTRIBUTION));
		const block = caseBlock(contribution, 'signInIde');
		assert.match(block, /dshIdeWindowHidden\.value/,
			'登录分支必须先看"IDE 主窗口是不是我们藏着的"（不然在 IDE 模式下会误藏用户正在用的窗口 ✗）');
		// ⚠ **两条路径都要有**：成功（完成）与失败（失败）—— 只断言"出现过一次"会被"只留失败那条"骗过 ✗
		//   （反向突变实测：删掉成功路径的兜底 ⇒ 旧断言仍绿 ⇒ 假绿 ✗）。
		assert.match(block, /_rehideIdeWindow\(`\$\{command\.method\} 完成`\)/,
			'登录**成功**后必须再藏一次（守卫之外的兜底：守卫没装上/事件漏了时的第二道防线 ✗）');
		assert.match(block, /_rehideIdeWindow\(`\$\{command\.method\} 失败`\)/,
			'登录**失败**后也必须再藏一次（失败路径同样会让浏览器抢焦点 ✗）');

		// ⚠ 回归防护：这两个命令**不许**回到"要把 IDE 出界面"那份名单里
		//   （上一轮修过一次：窗口里点登录会切到 IDE 模式 ⇒ 用户报障两轮 ✗）。
		const pageProtocol = stripComments(read(PAGE_PROTOCOL));
		const listAt = pageProtocol.indexOf('DSH_PAGE_COMMANDS_WITHOUT_IDE_UI');
		assert.ok(listAt >= 0, '找不到 DSH_PAGE_COMMANDS_WITHOUT_IDE_UI ✗');
		const list = pageProtocol.slice(listAt, pageProtocol.indexOf(']);', listAt));
		assert.match(list, /'signInIde'/, "signInIde 必须在'不需要 IDE 主窗口露面'那份名单里 ✗");
		assert.match(list, /'signOutIde'/, "signOutIde 必须在'不需要 IDE 主窗口露面'那份名单里 ✗");
	});
});
