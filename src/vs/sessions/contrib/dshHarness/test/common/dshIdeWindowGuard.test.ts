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
const VIEW_HOST = 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts';
const CONTRIBUTION = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts';
const WINDOW_IMPL = 'src/vs/platform/windows/electron-main/windowImpl.ts';
const WINDOWS_MAIN = 'src/vs/platform/windows/electron-main/windowsMainService.ts';

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

	// ★★ 2026-10-23 用户口径（三条规则）：**按"还剩几个可见窗口"判定**，各关各的
	//   ① 只有桌面窗口 ⇒ 关桌面 ⇒ 退应用；② 只有 IDE ⇒ 关 IDE ⇒ 退应用；
	//   ③ 两个都在 ⇒ 关哪个只关它自己，应用保持。
	test('⑤ 关窗规则：三条口径（只桌面 / 只 IDE / 都开着），判据只允许一处', () => {
		const channel = stripComments(read(CHANNEL));
		const at = channel.indexOf('const onClose = (event: Electron.Event) => {');
		assert.ok(at > 0, '找不到 IDE 主窗口的 close 拦截 ✗');
		// ⚠ 只取 onClose 本体：紧邻的 rehide（show/focus 守卫）**合法**地调 win.hide()，别混进来
		const endAt = channel.indexOf('const state = {', at);
		assert.ok(endAt > at, '找不到 onClose 的结束位置（切片口径要靠它）✗');
		const body = channel.slice(at, endAt);

		// ① 退出中必须放行
		assert.match(body, /if \(this\._appQuitting\) \{\s*return;\s*\}/,
			'应用正在退出时必须直接放行（否则关不掉应用 ✗）');

		// ② 判据只能来自规则表（`common/dshAppLifecycle.ts`），不许再内联一套
		assert.match(body, /decideIdeWindowClose\(facts\)/,
			'关 IDE 的收场必须由 decideIdeWindowClose 决定（规则只允许一处，内联会与规则漂移 ✗）');
		assert.match(body, /desktop: this\._liveDesktopWindows\(windowId\)/,
			'facts 必须包含"还有几个桌面窗口"（漏了它 ⇒ 关 IDE 会把桌面窗口一起带走 ✗）');
		assert.match(body, /ideVisible: this\._visibleIdeWindows\(windowId\)/,
			'facts 必须包含"还有几个**可见** IDE 窗口"（隐藏窗口不算"还在"✗）');

		// ③ 三个分支都要在：只关自己 / 隐藏（保住桌面窗口）/ 关完退出
		assert.match(body, /action === 'close'/,
			"缺少 'close' 分支（规则③：都开着时关 IDE 只关它自己）✗");
		assert.match(body, /action === 'hide'[\s\S]{0,260}event\.preventDefault\(\)[\s\S]{0,140}win\.hide\(\)/,
			"缺少 'hide' 分支，或没真 preventDefault+hide —— 桌面窗口的 opener 就是 IDE ⇒ 真关会把它一起带走 ✗");
		// ★★ 2026-10-27（用户报「IDE 点关闭按钮无法关闭 app」）：'quit' 分支**不许再干等窗口关掉**。
		//   旧写法 `win.once('closed', () => app.quit())` 在本仓根本不成立 —— VS Code 的
		//   `LifecycleMainService` 在 `win.on('close')` 里无条件 `preventDefault()` 再走 `unload()`
		//   （要 renderer 回话）⇒ renderer 不回话时 `closed` 永不发生 ⇒ `app.quit()` 永远不被调用 ✗
		//   （真机：13s 内 22 条"关闭后退出应用"，一条 before-quit 都没有）。
		assert.ok(!/win\.once\('closed'/.test(body),
			"'quit' 分支不许再挂 win.once('closed') 干等（VS Code 的 close 被 preventDefault + unload 卡住时它永不发生 ✗）");
		assert.match(body, /this\._requestAppQuit\(\)/,
			'判定该退时必须**主动发起**退出（等窗口自己关掉 = 点了关不掉 ✗）');

		// ④ 负对照：旧的内联判据不许复活
		assert.ok(!/const others = this\._windowsMainService\.getWindows\(\)\.filter/.test(body),
			'内联的"数可见窗口"又回来了 ⇒ 会与 common/dshAppLifecycle 的规则表漂移 ✗');

		// ⑤ 桌面窗口那一侧同样走规则函数（规则①③）
		assert.match(channel, /decideDesktopWindowClose\(facts\)/,
			'桌面窗口关闭的收场也必须走 decideDesktopWindowClose（规则①）✗');

		// ⑥ 拦截挂的是**这一扇**窗口，dispose 要摘掉
		assert.match(channel, /win\.on\('close', onClose\)/, 'close 拦截必须挂在 IDE 主窗口上 ✗');
		assert.match(channel, /win\.off\('close', onClose\)/,
			'dispose 必须摘掉 close 拦截（否则换窗口后旧守卫还在 ✗）');
		// ⑦ 负对照：`hidden` 与否都要装（用户可能先「回到 IDE」再关窗）
		assert.match(channel, /const state = \{ hiddenByUs: hidden \};/,
			'守卫状态必须跟随 hidden 参数（写死 true ⇒ 点「回到 IDE」后窗口一显示又被藏回去 ✗）');
	});

	test('⑤b 桌面窗口侧（渲染进程）：IDE 仍可见时不许退', () => {
		const full = stripComments(read(FULL_WINDOW));
		const qAt = full.indexOf('private _quitAfterDesktopClosed(');
		assert.ok(qAt > 0, '找不到 _quitAfterDesktopClosed ✗');
		const qBody = full.slice(qAt, qAt + 1200);
		assert.match(qBody, /if \(!this\._ideHiddenByStartup\) \{/,
			'IDE 仍可见时必须先判 _ideHiddenByStartup 并 return（否则关桌面窗口会连带退应用 ✗）');
		assert.match(qBody, /_quit\(/,
			'IDE 不可见（桌面模式下被藏着）时关闭桌面窗口必须退出应用（规则①）✗');
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

	// ★ 2026-10-22（用户："启动 app 时，能否仅启动窗口版"）：真机日志 `logs/20261022T084749` ——
	//   请求开窗 08:47:57.58 → Host 冷启动到 08:48:13.6 才就绪 → 08:48:14.19 渲染侧 20s 兜底把 IDE 亮出来
	//   → 08:48:15.59 桌面窗口才出现、再藏 IDE ⇒ **IDE 闪了 1.4s** ✗。
	//   根因 = `_open` 先 `ensureStarted()`（等 Host）再建窗口 ⇒ 桌面窗口出现时间被 Host 冷启动绑死。
	//   修 = **先建窗口壳（带占位）再等 Host**，壳一出现就藏 IDE ⇒ 这里把这条顺序与配套闸门钉住。
	test('⑥ 启动：桌面窗口壳必须先于 Host 就绪出现（否则 Host 冷启动期间 IDE 会被兜底亮出来）', () => {
		const full = stripComments(read(FULL_WINDOW));
		const openAt = full.indexOf('private async _open(');
		assert.ok(openAt >= 0, '找不到 _open ✗');
		const open = full.slice(openAt, full.indexOf('\n\tprivate ', openAt + 1));
		const iShell = open.indexOf('_auxWindowService.open(');
		const iNotify = open.indexOf('onShellOpened?.()');
		const iHost = open.indexOf('ensureStarted(');
		assert.ok(iShell >= 0, '_open 里没有建窗口壳 ✗');
		assert.ok(iHost >= 0, '_open 里没有等 Host（ensureStarted）✗');
		assert.ok(iShell < iHost,
			'窗口壳必须在 ensureStarted **之前**建（反了 = Host 冷启动 17s+ 期间没有桌面窗口 ⇒ IDE 被兜底亮出来 ✗）');
		assert.ok(iNotify > iShell && iNotify < iHost,
			'"壳已出现"的回调必须在建壳之后、等 Host 之前触发（启动流程靠它尽早藏 IDE ✗）');
		// ★ 2026-10-22（用户："关闭 desktop 窗口时，更不要打开 IDE"）：
		//   壳在 Host 就绪前被关 ⇒ **退出应用**（以前是"无条件显示 IDE"⇒ 用户看到关窗反而冒出 IDE ✗）
		const bootClose = open.slice(iShell, iHost);
		assert.match(bootClose, /onUnload\([\s\S]*?_quit\(/,
			'Host 就绪前关掉桌面窗口 ⇒ 必须退出应用 ✗');
		assert.ok(!/onUnload\([\s\S]*?_showIdeWindow\(/.test(bootClose),
			'启动期关窗**不许**再调 _showIdeWindow（关窗反而冒出 IDE ✗）');

		// 关掉桌面窗口 ⇒ 退出应用，而不是把藏起来的 IDE 还回来
		const closeAt = full.indexOf('private _quitAfterDesktopClosed(');
		assert.ok(closeAt >= 0, '找不到 _quitAfterDesktopClosed（关窗收场不见了 ✗）');
		const onClose = full.slice(closeAt, full.indexOf('\n\tprivate ', closeAt + 1));
		assert.match(onClose, /this\._quit\('/, '关闭桌面窗口后必须退出应用 ✗');
		assert.ok(!/_showIdeWindow\(/.test(onClose),
			'关闭桌面窗口后**不许**把 IDE 亮出来（本次报障就是这条 ✗）');
		// 手动 popout（IDE 与桌面窗口并排）时关窗不能退：用户还在 IDE 里 ⇒ 只在我们藏过 IDE 时退
		assert.match(onClose, /if \(!this\._ideHiddenByStartup\)/,
			'关窗退出必须只在"IDE 是我们藏起来的"时发生（否则并排模式会被误退 ✗）');

		// 启动流程必须把回调传进去（只改 _open 不接线 = 照旧等到 Host 就绪才藏 ✗）
		assert.match(full, /this\._open\(\{\}, settle\)/, '启动流程没把"壳已出现"回调传给 _open ✗');

		// "藏"与"显"会交错（壳先出现、Host 可能秒挂）⇒ 等待期间有人要求显示，就不许再藏
		const settleAt = full.indexOf('private async _settleIdeWindowAfterStartup(');
		const settle = full.slice(settleAt, full.indexOf('\n\tprivate ', settleAt + 1));
		const iEpoch = settle.indexOf('showEpoch !== this._ideShowEpoch');
		const iHide = settle.indexOf('hideWindow(');
		assert.ok(iEpoch >= 0 && iHide >= 0 && iEpoch < iHide,
			'隐藏前必须先检查"等待期间是否被要求显示"（否则 Host 失败时 IDE 刚露面又被藏回去 ✗）');
		const showAt = full.indexOf('private async _showIdeWindow(');
		const show = full.slice(showAt, full.indexOf('\n\tprivate ', showAt + 1));
		assert.match(show, /this\._ideShowEpoch\+\+/, '_showIdeWindow 必须推进显示代数（否则上面那道闸永远不触发 ✗）');
	});

	// ★ 2026-10-26（用户："当前F5启动后，没有打开 vssaros desktop窗口"）：真机 `logs/20261026T211749/main.log` ——
	//   21:17:54.5 桌面窗口建好 → 21:18:00.156「IDE 主窗口被显示 ⇒ 立刻再藏起来」→ window 2 BLUR → devtools_app 装载
	//   → 桌面窗口再没拿回焦点（用户 50s 后自己从任务栏点出来）。当天 6 次启动**全部**在窗口加载 +10s 出现同一序列。
	//   拉出 IDE 的是上游 `windowImpl.load()` 的 dev 兜底（10s 没显示 ⇒ show + Force focus + 开 DevTools）；
	//   守卫把它藏回去后焦点交给了别的应用 ⇒ 桌面窗口被压到后面。
	test('⑦ 启动：dev 10s 兜底不许拉出隐藏的 IDE；压回 / 启动藏 IDE 后必须把桌面窗口提到前台', () => {
		const impl = stripComments(read(WINDOW_IMPL));
		const devAt = impl.indexOf('this._win.webContents.openDevTools();');
		assert.ok(devAt > 0, '找不到 load() 里的 dev 兜底（openDevTools）——上游改形态了？断言要跟着改 ✗');
		const schedAt = impl.lastIndexOf('new RunOnceScheduler(', devAt);
		assert.ok(schedAt > 0 && devAt - schedAt < 1500, 'dev 兜底不在 RunOnceScheduler 里了（切片口径失效）✗');
		const block = impl.slice(schedAt, devAt);
		const iGate = block.indexOf('if (this._startHidden) {');
		const iShow = block.indexOf('this._win.show();');
		assert.ok(iShow >= 0, 'dev 兜底里没有 show（切片口径失效）✗');
		assert.ok(iGate >= 0 && iGate < iShow,
			'dev 兜底必须在 show **之前**判 _startHidden（否则每次 F5 都在 +10s 把隐藏的 IDE 拉出来 ⇒ 桌面窗口被压到后面 ✗）');
		assert.match(block.slice(iGate, iShow), /return;/,
			'隐藏启动下 dev 兜底必须直接 return（只打日志不 return = 照样 show + 开 DevTools ✗）');

		const channel = stripComments(read(CHANNEL));
		const rAt = channel.indexOf('const rehide = (event');
		const rEnd = channel.indexOf('const onShow = ', rAt);
		assert.ok(rAt > 0 && rEnd > rAt, '找不到守卫的 rehide ✗');
		const rehide = channel.slice(rAt, rEnd);
		const iHide = rehide.indexOf('win.hide();');
		const iRaise = rehide.indexOf('this._raiseDesktopWindow(windowId,');
		assert.ok(iHide >= 0, 'rehide 里没有 win.hide() ✗');
		assert.ok(iRaise > iHide,
			'压回 IDE 之后必须把桌面窗口提到前台（只 hide ⇒ 前台交给别的应用，桌面窗口被压到后面 ✗）');

		// ★★ 必须是**轮询**，不能只提一次：真机 2026-10-26 21:59:05.3 装守卫时辅助窗口已建
		//   （21:59:04.78）却还不可见（21:59:25.7 才 materialize）⇒ 一次性提窗落空 ✗。
		assert.match(channel, /raiseTimer = setInterval\(/,
			'启动提窗必须轮询（窗口要十几秒才可见，只提一次会落空 ✗）');
		assert.match(channel, /_raiseDesktopWindow\(windowId, '启动：IDE 已藏，桌面窗口提到前台'\) \|\| tries >= 26/,
			'轮询必须在"提到前台 / 已在前台"时收工（无限重试会在用户切走后反复抢焦点 ✗）');
		// ⚠ 必须**按位置**断言 dispose 里那一次：文件里另有"轮询收工"那一次 clearInterval
		//   ⇒ 只查"出现过"时，把 dispose 里那行删掉也照样绿（实测假绿 ✗）。
		const gAt = channel.indexOf('this._ideWindowGuard = {');
		assert.ok(gAt > 0, '找不到守卫对象 ✗');
		const gBody = channel.slice(gAt, channel.indexOf('};', gAt));
		assert.match(gBody, /if \(raiseTimer\) \{[\s\S]{0,80}clearInterval\(raiseTimer\)/,
			'dispose 里必须清定时器（漏了 ⇒ 撤守卫后仍会反复抢焦点 ✗）');

		// 视图 attach（SetViewVisible）时再提一次：这是窗口真正可见的那一刻，最准 ✓
		const svAt = channel.indexOf('case DshHarnessChannelCommand.SetViewVisible:');
		assert.ok(svAt > 0, '找不到 SetViewVisible ✗');
		const sv = channel.slice(svAt, channel.indexOf('case DshHarnessChannelCommand.', svAt + 1));
		assert.match(sv, /if \(a\.visible && this\._ideHiddenByUs\)/,
			'attach 时提窗必须先判"IDE 是不是我们藏着的"（否则正常 IDE 模式会被抢焦点 ✗）');
		assert.match(sv, /ownerWindowOfView\(a\.viewId\)/, 'attach 时必须按视图定位它自己那扇窗口 ✗');
		assert.match(sv, /_raiseDesktopWindow\(guard\.windowId, '桌面视图已就位 ⇒ 提到前台', desk\)/,
			'attach 时必须提一次桌面窗口（窗口十几秒后才可见，靠这一脚才准 ✗）');
	});

	// ★★ 2026-10-28（用户：「第一次启动，dsh desktop 会**闪一下 dsh web profile 的默认样式**，
	//   然后才切到 vssaros 的 profile」）：视图创建时本来不可见，只要**等换皮就位再显示**就不会闪。
	test('⑪ 桌面视图必须"等换皮就位 → 再显示 → 最后撤占位"（不许先显示官方默认样式）', () => {
		const full = stripComments(read(FULL_WINDOW));
		const iWait = full.indexOf("waitViewSelector(chatViewId, '[data-vssaros-wb-tabstrip]'");
		const iShow = full.indexOf('setViewVisible(chatViewId, true, true)');
		assert.ok(iWait > 0, '显示视图前必须等换皮就位（`waitViewSelector`）—— 否则用户会看到官方默认样式闪一下 ✗');
		assert.ok(iShow > iWait, '顺序必须是"先等就位、再显示"（反了等于没等 ✗）');

		// 锚点必须是**常驻**的页签条外壳：里面的 `[data-vssaros-wb-tabs]` 只在"有页签"时才存在 ⇒
		// 拿它当锚点会让新会话首屏每次都白等满超时 ✗。
		assert.match(full, /'\[data-vssaros-wb-tabstrip\]'/,
			'锚点必须是常驻的 `[data-vssaros-wb-tabstrip]`（页签条外壳）✗');
		assert.ok(!/waitViewSelector\([^)]*'\[data-vssaros-wb-tabs\]'/.test(full),
			'不许拿 `[data-vssaros-wb-tabs]` 当锚点（只在有页签时存在 ⇒ 新会话首屏永远等不到 ✗）');

		// 超时兜底：等不到也必须显示（页面出问题时不许白屏）
		assert.match(full, /waitViewSelector\([\s\S]{0,120}\.catch\(\(\) => false\)/,
			'等不到/抛错必须 `catch(() => false)`（不许把显示流程一起抛掉 ✗）');
		assert.match(full, /if \(!vssarosReady\) \{[\s\S]{0,200}仍然显示视图/,
			'超时必须**照常显示**并留日志（否则页面一出问题就永远白屏 ✗）');

		// 占位必须先盖着：撤占位必须排在"显示视图"之后
		const iRemove = full.indexOf('booting?.remove();', iShow);
		assert.ok(iRemove > iShow, '`booting?.remove()` 必须在显示视图**之后**（提前撤 ⇒ 中间那段露官方默认样式 ✗）');
		const firstRemove = full.indexOf('booting?.remove();');
		assert.strictEqual(firstRemove, iRemove,
			'`_openComposed` 里只许在"显示之后"撤一次占位（createView 之后那次是 2026-10-28 修的闪烁成因 ✗）');

		// 主进程：命令落点 + 轮询实现 + 超时返回 false
		const channel = stripComments(read(CHANNEL));
		assert.ok(channel.includes('case DshHarnessChannelCommand.WaitViewSelector:'), '主进程缺少 WaitViewSelector 落点 ✗');
		const host = stripComments(read(VIEW_HOST));
		const implAt = host.indexOf('async waitForSelector(');
		assert.ok(implAt > 0, '`dshViewHost` 必须有 `waitForSelector` 实现 ✗');
		const impl = host.slice(implAt, host.indexOf('\n\tasync ', implAt + 1) > 0 ? host.indexOf('\n\tasync ', implAt + 1) : implAt + 2000);
		assert.match(impl, /document\.querySelector/, '必须真的查 DOM ✗');
		assert.match(impl, /Date\.now\(\) >= deadline[\s\S]{0,80}return false/, '超时必须返回 false（不许无限轮询 ✗）');

		const service = stripComments(read(SERVICE));
		assert.match(service, /waitViewSelector\(viewId: string, selector: string, timeoutMs = 9_000\): Promise<boolean> \{[\s\S]{0,200}WaitViewSelector/,
			'渲染侧服务实现必须真发 WaitViewSelector 命令 ✗');
	});

	// ★★ 2026-10-28（用户：「打包出的 exe 打开后会闪一下 IDE 窗口」）：隐藏启动判据不许只认
	//   `isEmbeddedApp`（间接证据 + 依赖 main.ts 赋值时机 ⇒ 打包版判 false ⇒ IDE 建出来就可见）。
	test('⑩ 打包版也要建窗即隐藏（不许先闪一下 IDE）+ 首启等待要有阶段文案', () => {
		const wms = stripComments(read(WINDOWS_MAIN));
		const at = wms.indexOf('private _wantsHiddenStart(): boolean {');
		assert.ok(at > 0, '找不到 _wantsHiddenStart ✗');
		const body = wms.slice(at, wms.indexOf('\n\tprivate ', at + 1));
		assert.match(body, /this\.environmentMainService\.isBuilt/,
			'隐藏启动判据必须包含 `environmentMainService.isBuilt`（打包版直接判据；只认 isEmbeddedApp ⇒ 打包版会闪 IDE ✗）');
		assert.match(body, /const hidden = !hasTarget && \(isBuilt \|\| isEmbedded\)/,
			'判据必须是「无目标参数 && (打包版 || isEmbeddedApp)」（带目录/文件的启动仍要露 IDE ✗）');
		assert.match(body, /wantsHiddenStart=\$\{hidden\}/,
			'必须有可诊断日志（再出"闪 IDE"时能直接看出是哪个判据没成立 ✗）');

		const full = stripComments(read(FULL_WINDOW));
		// 首启等待要分阶段：Host 就绪后换文案（否则用户看不出是卡住还是在干活）
		assert.match(full, /后台服务已就绪，正在加载界面/, 'Host 就绪后必须更新占位文案（阶段感）✗');
		// 延时缩短之后必须等工作区，不能把"还没到"当成"没打开工作区"
		assert.match(full, /await this\._waitForWorkspaceCwd\(3_000\)/,
			'会话解析必须等工作区就绪（延时缩到 800ms 后工作区可能还没落定 ✗）');
		assert.match(full, /private async _waitForWorkspaceCwd\(/, '必须有 _waitForWorkspaceCwd ✗');
	});

	// ★ 2026-10-27（真机：一次启动出现**两扇**桌面窗口）：启动自动开窗必须"每窗口只一次"。
	test('⑨ 启动自动开窗只做一次（渲染进程重载不该再开第二扇桌面窗口）', () => {
		const full = stripComments(read(FULL_WINDOW));
		const timerAt = full.indexOf('const timer = setTimeout(');
		assert.ok(timerAt > 0, '找不到启动开窗的定时器 ✗');
		// ⚠ 锚点跟着延时走：2026-10-28 把启动开窗延时从 2500ms 缩到 800ms（首启等待优化）
		const timerBody = full.slice(timerAt, full.indexOf('}, 800);', timerAt));
		const iClaim = timerBody.indexOf('claimDesktopAutoOpen(');
		const iLog = timerBody.indexOf("startup: open the dsh desktop window by default");
		assert.ok(iClaim >= 0, '启动开窗前必须 claim（否则渲染进程重载会再开一扇 ✗）');
		assert.ok(iLog > iClaim, 'claim 必须排在"开窗"之前（顺序反了 = 先开再问，白问 ✗）');
		assert.match(timerBody, /if \(!first\) \{[\s\S]{0,200}return;/, 'claim 说"已做过"时必须 return（不许继续开 ✗）');
		assert.match(timerBody, /async \(\) =>/, '这个回调必须是 async（要 await claim）✗');

		// 状态必须在主进程（进程级）：放渲染侧会随重载丢失 = 本缺陷成因
		const channel = stripComments(read(CHANNEL));
		assert.match(channel, /private readonly _desktopAutoOpened = new Set<number>\(\)/,
			'"已自动开窗"的状态必须是主进程的进程级集合（渲染侧重载不清零）✗');
		const caseAt = channel.indexOf('case DshHarnessChannelCommand.ClaimDesktopAutoOpen:');
		assert.ok(caseAt > 0, '主进程缺少 ClaimDesktopAutoOpen 的落点 ✗');
		const caseBody = channel.slice(caseAt, channel.indexOf('case DshHarnessChannelCommand.', caseAt + 1));
		assert.match(caseBody, /this\._desktopAutoOpened\.has\(windowId\)/, '必须按 windowId 判重 ✗');
		assert.match(caseBody, /this\._desktopAutoOpened\.add\(windowId\)/, '判过之后必须占位（否则每次都说"第一次"✗）');
		assert.match(caseBody, /Number\.isInteger\(a\.windowId\) && a\.windowId > 0/,
			'windowId 必须校验（跨进程边界 ⇒ 脏值不许进 ✗）');

		// ⚠ 必须断言**实现里真的发了这条命令**：只查签名会被"接口声明还在、实现被删掉"骗过（实测假绿 ✗）。
		const service = stripComments(read(SERVICE));
		assert.match(service, /claimDesktopAutoOpen\(windowId: number\): Promise<boolean>;/, '渲染侧服务接口必须声明这个方法 ✗');
		assert.match(service, /claimDesktopAutoOpen\(windowId: number\): Promise<boolean> \{[\s\S]{0,200}DshHarnessChannelCommand\.ClaimDesktopAutoOpen/,
			'实现里必须发 ClaimDesktopAutoOpen 这条命令（只留接口声明 = 调用静默失败 ✗）');
	});
	test('⑧ 判定该退 ⇒ 主动请求退出（不等窗口自己关掉）+ 只武装一次 + 卡住时强退', () => {
		const channel = stripComments(read(CHANNEL));
		const qAt = channel.indexOf('private _requestAppQuit(');
		assert.ok(qAt > 0, '找不到 _requestAppQuit ✗');
		const q = channel.slice(qAt, channel.indexOf('\n\tprivate ', qAt + 1));

		// ① 幂等：连点关闭不许叠加（真机 22 次点击 ⇒ 22 个定时器/22 次 quit ✗）
		assert.match(q, /if \(this\._appQuitting \|\| this\._quitRequested\) \{\s*return;\s*\}/,
			'退出请求必须幂等（连点关闭会叠加调用/定时器 ✗）');
		assert.match(q, /this\._quitRequested = true;/, '武装后必须置位（否则下一次点击又来一遍 ✗）');

		// ② 优先用注入的生命周期服务（VS Code 自己的退出流程：处理 joiner / 弹确认框）
		assert.match(q, /const hook = this\._requestQuit;/, '必须优先用注入的 requestQuit ✗');
		assert.match(q, /const veto = await hook\(false\);/, '调 requestQuit 必须带 willRestart=false（不是重启）✗');
		assert.match(q, /app\.quit\(\)/, '没有注入钩子时必须退回 app.quit()（老宿主/测试不能变成关不掉 ✗）');

		// ③ 被 veto ⇒ 撤掉强退并**解除武装**（用户处理完弹窗后还能再点一次）
		const vetoAt = q.indexOf('if (veto) {');
		assert.ok(vetoAt > 0, '缺少 veto 分支 ✗');
		const vetoBody = q.slice(vetoAt, q.indexOf('\n\t\t\t\t\t}', vetoAt));
		assert.match(vetoBody, /this\._cancelForceQuit\(\)/, '被 veto 时必须撤掉强退兜底 ✗');
		assert.match(vetoBody, /this\._quitRequested = false;/, '被 veto 后必须解除武装（否则用户处理完弹窗也关不掉 ✗）');

		// ④ 超时强退：VS Code 的退出流程本身卡住（renderer 不回话）时的最后手段
		assert.match(channel, /QUIT_FORCE_AFTER_MS = 6_000/, '强退兜底的超时必须是 6s（太长 = 用户盯着不动的窗口 ✗）');
		assert.match(q, /setTimeout\(\(\) => \{[\s\S]{0,200}app\.exit\(0\);/, '兜底必须真的 app.exit(0)（否则还是关不掉 ✗）');

		// ⑤ 退出流程真往下走 ⇒ 撤掉强退（不能把正常退出也打断 ✗）
		assert.match(channel, /app\.on\('will-quit', \(\) => \{ this\._cancelForceQuit\(\); \}\)/,
			'will-quit 时必须撤掉强退兜底 ✗');
		assert.match(channel, /private _cancelForceQuit\(\)/, '必须有撤掉兜底定时器的方法 ✗');

		// ⑥ 接线：`app.ts` 真的把生命周期服务注入进去了（没注入 ⇒ 走 app.quit 这条弱路径 ✗）
		const appTs = stripComments(read('src/vs/code/electron-main/app.ts'));
		assert.match(appTs, /requestQuit: \(willRestart: boolean\) => \w+\.quit\(willRestart\)/,
			'app.ts 必须把 ILifecycleMainService.quit 注入给 dsh 通道 ✗');
		assert.match(appTs, /accessor\.get\(ILifecycleMainService\)/, 'app.ts 里要取到生命周期服务 ✗');

		const hAt = channel.indexOf('private _raiseDesktopWindow(');
		assert.ok(hAt > 0, '找不到 _raiseDesktopWindow ✗');
		const helper = channel.slice(hAt, channel.indexOf('\n\tprivate ', hAt + 1));
		assert.match(helper, /desktopWindowsOtherThan\(ideWindowId\)/,
			'候选必须优先取承载 dsh 视图的窗口 ✗');
		assert.match(helper, /!ideWins\.has\(w\)/,
			'兜底候选必须排除 IDE 主窗口（否则可能把藏着的 IDE 当成桌面窗口 ✗）');
		assert.match(helper, /\.filter\(w => !w\.isDestroyed\(\) && w\.isVisible\(\)\)/,
			'只许提**可见**且未销毁的窗口 ✗');
		const iTopOn = helper.indexOf('setAlwaysOnTop(true)');
		const iFocus = helper.indexOf('desk.focus()');
		const iTopOff = helper.indexOf('setAlwaysOnTop(false)');
		assert.ok(iTopOn >= 0 && iFocus > iTopOn && iTopOff > iFocus,
			'顺序必须是 置顶 → focus → 取消置顶（漏了取消 = 桌面窗口永久置顶；漏了置顶 = 前台锁下提不上来 ✗）');
	});
});
