/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 桌面窗口：**窗口尺寸变化（含全屏）后原生视图必须实时重排**（2026-10-24 用户："切换到全屏时，没有实时刷新 UI"）。
 *
 * 机理：桌面窗口里的 dsh 是 `WebContentsView`（原生层），**不会**跟着窗口自动缩放 ——
 *   它的矩形完全由渲染侧 `layout()` 通过 `layoutView` 告诉主进程。原来只有
 *   `ResizeObserver(container)` + `auxWindow.onDidLayout` 两个触发点；Windows 全屏是
 *   "系统动画 + 0~2 次尺寸变化"，实测会出现 RO 在容器换尺寸前先触发一次、之后不再触发
 *   ⇒ 视图停在全屏前的矩形上，右边/下边露出一块空底色 ✗。
 *
 * 这份守卫钉住"四保险 + 防抖"：
 *   ① 窗口 `resize`；② 文档 `fullscreenchange`（含延迟重排）；③ 保留 RO / onDidLayout；
 *   ④ 500ms 轻量自愈；并且每次"矩形没变就不发"，自愈不许刷 IPC。
 */
import assert from 'assert';
import fs from 'node:fs';

const FULL_WINDOW = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshFullWindowContribution.ts';
/** 主进程侧的"就地跟随"（本轮新增；渲染侧重排要等一次 IPC + 一帧，窗口拖小时会露出旧尺寸）。 */
const VIEW_HOST = 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

suite('dshHarness / 桌面窗口：全屏后视图实时重排', () => {

	test('① 三个新触发点：窗口 resize / fullscreenchange / 500ms 自愈（两个布局点各一份）', () => {
		const src = strip(fs.readFileSync(FULL_WINDOW, 'utf8'));
		// ⚠ 必须**按数量**断言：只查"存在"会被"删掉其中一处"骗过（实测漏过一次）
		for (const [needle, label] of [
			["win.addEventListener('resize', layout)", '窗口 resize 监听'],
			["win.addEventListener('fullscreenchange', layoutSoon)", '全屏变化重排'],
			['win.setInterval(layout, 500)', '500ms 自愈'],
		] as const) {
			const n = (src.split(needle).length - 1);
			assert.strictEqual(n, 2,
				`${label} 必须在**两个**布局点各出现一次（实际 ${n} 次）⇒ 漏的那个形态全屏后原生视图仍停在旧矩形 ✗`);
		}
	});

	test('② 两个布局点都要挂（拼装式 / 整页式），卸载都要清掉', () => {
		const src = strip(fs.readFileSync(FULL_WINDOW, 'utf8'));
		const count = (re: RegExp) => (src.match(re) || []).length;
		assert.strictEqual(count(/win\.addEventListener\('fullscreenchange', layoutSoon\)/g), 2,
			'拼装式与整页式两个布局点都必须挂全屏重排（漏一个 ⇒ 那个形态全屏后不刷新 ✗）');
		assert.strictEqual(count(/win\.setInterval\(layout, 500\)/g), 2, '两个布局点都要有自愈定时器 ✗');
		assert.strictEqual(count(/win\.clearInterval\(layoutTimer\)/g), 2,
			'卸载时必须清掉自愈定时器（否则关窗后还在跑 ✗）');
		assert.strictEqual(count(/win\.removeEventListener\('resize', layout\)/g), 2,
			'卸载时必须摘掉 resize 监听 ✗');
	});

	test('③ 防抖：矩形没变不许重发（否则 500ms 自愈会一直刷 IPC）', () => {
		const src = strip(fs.readFileSync(FULL_WINDOW, 'utf8'));
		assert.strictEqual((src.match(/if \(key === lastLayoutKey\) \{ return; \}/g) || []).length, 2,
			'两个布局点都必须做"矩形没变就不发"的防抖 ✗');
		assert.ok(/const key = \[Math\.round\(rect\.left\)[^\]]*zoom\]\.join\(','\)/.test(src),
			'防抖的 key 必须含位置/尺寸（以及 zoom），只比宽度会漏掉"只挪动"的情况 ✗');
	});

	// ★ 2026-10-24（用户："窗口缩小时，没有及时刷新UI，导致内容被截断"）：
	//   渲染侧重排要「resize → layout() → IPC → setBounds」⇒ 拖动缩小至少差一帧（右边被窗口边缘切掉）。
	//   ⇒ 主进程补一条**就地跟随**（按上次布局时的窗口尺寸加增量），这里把它的三条关键约束钉住。
	test('④ 主进程必须就地跟随窗口尺寸（不等渲染侧 IPC）', () => {
		const src = strip(fs.readFileSync(VIEW_HOST, 'utf8'));
		assert.ok(/private _followWindowSize\(win: BrowserWindow\)/.test(src),
			'缺少主进程跟随函数（只靠渲染侧重排 ⇒ 拖动缩小时会露出旧尺寸 / 内容被截断 ✗）');

		// ① 窗口级事件必须挂全（resize 是主路径；全屏/最大化本质也是内容尺寸变化）
		const at = src.indexOf('private _watchWindow(win: BrowserWindow)');
		assert.ok(at > 0, '找不到 _watchWindow ✗');
		const watch = src.slice(at, at + 2200);
		for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
			assert.ok(watch.includes(`win.on('${ev}', follow)`),
				`_watchWindow 没挂 ${ev} ⇒ 那种尺寸变化仍会滞后再纠正 ✗`);
		}

		// ② 增量口径 + 防重复放大
		const followAt = src.indexOf('private _followWindowSize(');
		const follow = src.slice(followAt, followAt + 2400);
		assert.ok(/const dw = size\[0\] - baseW;/.test(follow) && /const dh = size\[1\] - baseH;/.test(follow),
			'必须按"与上次布局时窗口尺寸的增量"缩放（拿绝对尺寸硬设会在拼装布局下撑歪 ✗）');
		assert.ok(/slot\.lastWindowContent = \[size\[0\], size\[1\]\];/.test(follow),
			'跟随完必须更新 lastWindowContent（否则连续 resize 会重复放大 ✗）');

		// ③ 只跟随"视图铺满窗口宽"的形态：IDE 里的小聊天框宽度对不上，乱缩会撑歪
		assert.ok(/Math\.abs\(slot\.lastBounds\.width - baseW\) > 8/.test(follow),
			'必须跳过"视图只占窗口一部分"的形态（否则 IDE 里的聊天框会被撑出编辑器区域 ✗）');

		// ④ layout() 必须记下设备像素矩形与当时的窗口尺寸（跟随的唯一数据源）
		assert.ok(/slot\.lastBounds = px;/.test(src), 'layout() 必须记 lastBounds（跟随靠它）✗');
		assert.ok(/slot\.lastWindowContent = \[size\[0\], size\[1\]\];/.test(src),
			'layout() 必须记当时的窗口内容尺寸（跟随的基准）✗');
	});
});
