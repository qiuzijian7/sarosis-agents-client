/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 源码守卫（非空跑）：模块容器的"三处必须一致"——
 * ① 聚合表（common/dshModuleContainers.ts）、② 静态注册（agentStudio.contribution.ts 的
 * `_registerModuleToolIcon`）、③ 动态注册的视图宿主（dshActivityBarContribution.ts 的
 * `MODULE_VIEW_HOSTS`）。
 *
 * 为什么需要：`moduleEngine=dsh` 时静态注册必须让位，一旦有人把某个模块图标改回
 * `_registerToolIcon`（或不给新容器补视图宿主），动态路径就会双注册抛错 / 静默丢图标。
 * 这类缺陷只能靠扫描源码发现（方案 6.11.6 的对账要求）。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { DSH_ALWAYS_REGISTERED_CONTAINERS, DSH_MODULE_CONTAINERS } from '../../common/dshModuleContainers.js';
import { DshOverlayFreeze } from '../../electron-browser/dshOverlayFreeze.js';

const REL_CONTRIBUTION = 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts';
const REL_ACTIVITY_BAR = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshActivityBarContribution.ts';
const REL_PLUGIN_PANE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshPluginViewPane.ts';
const REL_PLUGINS_VIEW = 'src/vs/sessions/contrib/agentStudio/browser/views/pluginsView.ts';
const REL_PLUGIN_CENTER_HOST = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshPluginCenterHost.ts';
const REL_HARNESS_CONTRIBUTION = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts';

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readFromRepoRoot(rel: string): string | undefined {
	// runner 约定从仓库根执行（`node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs`）。
	const abs = path.join(process.cwd(), rel);
	return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
}

suite('dshActivityBar 源码守卫（表 / 静态注册 / 动态宿主 三处一致）', () => {
	const contribution = readFromRepoRoot(REL_CONTRIBUTION);
	const activityBar = readFromRepoRoot(REL_ACTIVITY_BAR);

	test('仓库根可解析出两个源文件（否则本守卫是空跑，必须显式跳过而不是静默通过）', function () {
		if (!contribution || !activityBar) {
			this.skip();
		}
		assert.ok(contribution && activityBar);
	});

	test('静态侧三分：existing 走 _registerModuleToolIcon；planned / page-only 完全不存在', () => {
		for (const container of DSH_MODULE_CONTAINERS) {
			const id = escapeRegExp(container.containerId);
			const viaModule = new RegExp(`_registerModuleToolIcon\\(viewContainerRegistry, viewsRegistry, \\{\\s*id: '${id}',`);
			const viaStatic = new RegExp(`_registerToolIcon\\(viewContainerRegistry, viewsRegistry, \\{\\s*id: '${id}',`);
			assert.doesNotMatch(contribution!, viaStatic, `${container.containerId} 不能走静态 _registerToolIcon（engine=dsh 会双注册）`);
			if (container.status === 'planned' || container.status === 'page-only') {
				// planned：还没有页面；page-only：页面**只**由插件承载，legacy 侧故意没有
				//（如代码图谱——那儿的 graphView 是 Git 历史图）。两者都不该在静态侧出现，
				// 否则等于凭空多一个点了没东西的图标。
				assert.doesNotMatch(contribution!, new RegExp(`id: '${id}',`),
					`${container.containerId}（${container.status}）不应出现在静态注册里`);
			} else {
				assert.match(contribution!, viaModule, `${container.containerId} 应经 _registerModuleToolIcon 注册`);
			}
		}
	});

	test('常驻容器不受模块引擎影响（仍是静态注册）', () => {
		// 侧栏常驻项里，Workspace 走手工注册块，Search / Plugins 走 _registerToolIcon。
		assert.match(contribution!, /id: 'agentStudio\.workspace',/, 'Workspace 容器应静态注册');
		for (const id of ['agentStudio.search', 'agentStudio.plugins']) {
			const viaStatic = new RegExp(`_registerToolIcon\\(viewContainerRegistry, viewsRegistry, \\{\\s*id: '${escapeRegExp(id)}',`);
			assert.match(contribution!, viaStatic, `${id} 应保持静态注册`);
		}
		// 常驻集合与模块容器表不得重叠（重叠即"两套机制争同一个容器"）
		for (const container of DSH_MODULE_CONTAINERS) {
			assert.ok(!DSH_ALWAYS_REGISTERED_CONTAINERS.includes(container.containerId),
				`${container.containerId} 同时出现在常驻集合与模块容器表`);
		}
	});

	test('动态注册为每个可注册容器都备了 page 宿主；planned 容器必须没有宿主', () => {
		for (const container of DSH_MODULE_CONTAINERS) {
			const host = new RegExp(`'${escapeRegExp(container.containerId)}': pageHost\\(`);
			if (container.status === 'planned') {
				assert.doesNotMatch(activityBar!, host, `${container.containerId} 尚无页面，不应有视图宿主`);
			} else {
				assert.match(activityBar!, host, `${container.containerId} 缺少 MODULE_VIEW_HOSTS 条目`);
			}
		}
	});

	// ⚠ 必须 `function ()` 而非箭头函数：`this.skip()` 用的是 mocha 注入的 Context，箭头函数的 `this` 是模块
	// 顶层（`undefined`）⇒ watch-client 报 TS2532；而 `--common` 的 esbuild 不做类型检查 ⇒ 抓不到 ✗（2026-10-12）。
	test('★ dsh 自建容器（vssaros.dsh.*）必须用 vssaros.dsh.* 的视图 id；constants.ts 不许有重复声明', function () {
		// 起因（2026-10-12）：给新容器"画布"接线时，我先用了 `AGENT_STUDIO_CANVAS_VIEW_ID` —— 那名字
		// **早就存在**（= legacy 的 `agentStudio.canvasView`）。后果有两层：
		//   ① 直接重复声明 ⇒ 编译器 TS2451；② 更险的是我**import 的正是 legacy 那个常量** ⇒ 会拿 legacy 的
		//      视图 id 去注册 dsh 容器（撞 id / 注册错视图）。
		// ⚠ **这两条 `--common` 都抓不到**（esbuild 不做类型检查 ✗）—— 只有 watch-client 会报 ✓。所以补这条
		// 源码守卫：**同一文件不许重复声明** ＋ **dsh 自建容器的视图 id 必须同前缀**。
		const constants = readFromRepoRoot('src/vs/sessions/contrib/agentStudio/common/constants.ts');
		if (!constants) {
			this.skip();
		}
		const values = new Map<string, string>();
		const seen = new Set<string>();
		const dupes = new Set<string>();
		for (const m of constants!.matchAll(/export const (\w+)\s*=\s*(?:'([^']*)'|\{)/g)) {
			if (seen.has(m[1])) {
				dupes.add(m[1]);
			}
			seen.add(m[1]);
			if (m[2] !== undefined) {
				values.set(m[1], m[2]);
			}
		}
		assert.deepStrictEqual([...dupes], [],
			`constants.ts 里有重复声明（编译器报 TS2451，而 --common 不会）：${[...dupes].join(', ')}`);
		assert.ok(seen.size > 20, `常量表看起来没读全（只有 ${seen.size} 个），守卫别空跑`);
		let checked = 0;
		for (const container of DSH_MODULE_CONTAINERS) {
			if (!container.containerId.startsWith('vssaros.dsh.')) {
				continue;
			}
			const call = new RegExp(`'${escapeRegExp(container.containerId)}': pageHost\\(\\s*(\\w+)`).exec(activityBar!);
			assert.ok(call, `${container.containerId} 的 pageHost 行解析不出来（守卫会空跑）`);
			const viewId = values.get(call![1]);
			assert.ok(viewId !== undefined, `${call![1]} 在 constants.ts 里找不到字面值（改过名？）`);
			assert.ok(String(viewId).startsWith('vssaros.dsh.'),
				`${container.containerId} 用了 legacy 风格的视图 id「${String(viewId)}」（${call![1]}）：dsh 自建容器必须 vssaros.dsh.*，否则与 legacy 视图撞 id`);
			checked++;
		}
		assert.ok(checked >= 1, '至少应有一个 dsh 自建容器（防空转）');
	});

	test('page 宿主**不烘焙路由**：由 Pane 按已激活模块懒解析（共容器才不会 404）', () => {
		// 起因（README 4.64）：共容器（integration = skills + mcp、knowledgeBase = kb + memory）里若只装了
		// **另一个**模块，`defaultPageRoute()` 那条路由属于**没装**的插件 ⇒ 这个面板点开必然是 404。
		// 所以动态注册这一侧只认容器 id；"该显示哪一页"由 Pane 现算（可随插件组合变化）。
		const pane = readFromRepoRoot(REL_PLUGIN_PANE);
		assert.ok(pane, '读不到 page 宿主源码（守卫会变成空跑）');
		assert.match(activityBar!, /new SyncDescriptor\(DshPluginViewPane, \[containerId\]\)/,
			'page 宿主的 ctor 参数只应有 containerId（路由不烘焙）');
		assert.doesNotMatch(activityBar!, /defaultPageRoute/, '路由推导不得留在动态注册里');
		assert.doesNotMatch(activityBar!, /'\/x\//, '路由字面量不得写在动态注册里');
		// Pane 一侧：向服务要页面（按已激活模块现算）→ 有 route 才建视图/拉 Host → 没有就给说明
		assert.match(pane!, /resolveModulePage\(/, 'Pane 必须经 `resolveModulePage` 解析路由');
		// 2026-10-13：建视图的调用多了一个"承载表面"实参（侧栏 = `sideview`，编辑区 = `editor`）
		// ⇒ 断言跟着改，但**意图不变**：route 必须是解析出来的那个、且表面必须显式给（不能默认）
		assert.match(pane!, /undefined, this\._route, 'sideview'\)/, '建视图用的是解析出来的路由，并显式声明承载在侧栏');
		assert.match(pane!, /_renderNoPage\(/, '没有可显示页面时必须给说明（而不是让用户对着 404 猜）');
	});

	test('插件中心「DSH」页签：经钩子取实现，browser 层不得引用 electron-browser', function () {
		const view = readFromRepoRoot(REL_PLUGINS_VIEW);
		const centerHost = readFromRepoRoot(REL_PLUGIN_CENTER_HOST);
		if (!view || !centerHost) {
			this.skip();
		}
		assert.match(view!, /getDshPluginCenterHost/, '页签数据必须经 browser 层钩子取');
		assert.doesNotMatch(view!, /dshHarness\/electron-browser/, 'browser 层不得直接 import electron-browser 层');
		// 「DSH 页签必须接进 tab 切换」：**意图不变**，但 2026-10-14 页签工厂化后（S1：三段 + ARIA +
		// 计数/状态点，见 `doc/dsh-plugin-center-ia-tabs-mockup.html`）onclick 由 `makeTab(key)` 统一接线，
		// 源码里不再逐个写字面量 `_switchTab('dsh')` ⇒ 断言改钉**结构**：页签由工厂建 + 切换顺序里含 dsh。
		assert.match(view!, /makeTab\('dsh'/, 'DSH 页签必须由页签工厂建（否则切换/ARIA/计数都会漏）');
		assert.match(view!, /['"]installed['"],\s*['"]extensions['"],\s*['"]dsh['"]/,
			'切换顺序（含键盘方向键/Home/End）必须把 dsh 算进去');
		assert.match(centerHost!, /setDshPluginCenterHostFactory/, '钩子必须由 electron-browser 侧注册（否则页签永不出现）');
		assert.match(centerHost!, /setEnabled\(/, '钩子必须提供启停开关');
		assert.match(readFromRepoRoot(REL_HARNESS_CONTRIBUTION) ?? '', /DshPluginCenterHostContribution/, '贡献必须在 dshHarness 里注册');
	});

	test('动态注册的开关口径与方案一致：moduleEngine=dsh 才介入、不主动拉起 Host', () => {
		assert.match(activityBar!, /DshHarnessSettings\.ModuleEngine/, '需按 moduleEngine 决定是否介入');
		assert.match(activityBar!, /DshHarnessSettings\.Enabled/, '需尊重 dsh 总开关');
		assert.doesNotMatch(activityBar!, /ensureStarted\(|bootstrap\(/, '显示图标不应在启动期拉起 Host');
	});
});

/**
 * ★ 浮层让位**不能变成黑洞**（2026-10-15 用户报："选中主页，鼠标 hover 到 workspace 图标 ⇒ sideview 内容消失"）。
 *
 * 现场与真机取证：ActivityBar 的 tooltip 用 `HoverPosition.RIGHT`，**必然**落在侧栏页面矩形里
 * （实测页面 x=48..450，第二个图标 `agentStudio.workspace` 的 tooltip 起点 ≈56）；`overlayManager`
 * 认 `.monaco-hover` ⇒ `dshPluginViewPane` 按设计把原生视图藏起来让 tooltip 可见（注入一个
 * `.monaco-hover` 后 250ms 内 `data-overlay=true, data-shown=false` ✓）。**问题在那一块画什么**：
 * 占位 `.dsh-plugin-view` 原本**没有背景**、`.part.sidebar` 也是 transparent ⇒ 整块空白/黑 ✗✗。
 *
 * 不变量（改动前请先读 `_freezeToken` / `_freezeForOverlay` 的注释）：
 *   ① 占位必须有**主题底色** —— 抓帧失败/来不及时的兜底，也保证"藏起来 ≠ 黑洞"；
 *   ② 让位前必须**抓一帧**贴回占位（`captureView` → backgroundImage），且只在**浮层**这一条原因上做；
 *   ③ 迟到的帧必须作废（令牌比对）——否则恢复显示后旧帧闪回；
 *   ④ 主进程的 `captureView` 必须**只读**（视图销毁/空帧/抛错一律 `undefined`）：抓图失败绝不能
 *      把页面留在隐藏状态（那是"内容永久消失"，比一闪严重得多 ✗）。
 */
suite('dshActivityBar 源码守卫 / 浮层让位不是黑洞（冻结帧）', () => {
	const REL_VIEW_HOST = 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts';
	const REL_CHAT_HOST = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshChatInstanceHost.ts';
	const REL_CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';
	const REL_SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
	const REL_COMMON = 'src/vs/sessions/contrib/dshHarness/common/dshHarness.ts';
	const REL_FREEZE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshOverlayFreeze.ts';

	const pane = readFromRepoRoot(REL_PLUGIN_PANE);
	const chatHostSource = readFromRepoRoot(REL_CHAT_HOST);
	const viewHost = readFromRepoRoot(REL_VIEW_HOST);
	const channel = readFromRepoRoot(REL_CHANNEL);
	const service = readFromRepoRoot(REL_SERVICE);
	const common = readFromRepoRoot(REL_COMMON);
	const helper = readFromRepoRoot(REL_FREEZE);

	test('守卫前置：七个源文件都能读到（读不到就显式跳过，不许静默通过）', function () {
		if (!pane || !chatHostSource || !viewHost || !channel || !service || !common || !helper) {
			this.skip();
		}
		assert.ok(pane && chatHostSource && viewHost && channel && service && common && helper);
	});

	test('★ 占位要有主题底色（藏起来时露的是它，不能是透明）', () => {
		assert.match(pane!, /dshViewPlaceholderCssText\('var\(--vscode-sideBar-background\)'\)/,
			'侧栏占位必须给侧栏主题底色 —— 不给就是"浮层一出现整块变黑"（2026-10-15 用户报的那个现象）');
		assert.match(chatHostSource!, /dshViewPlaceholderCssText\('var\(--vscode-editor-background\)'\)/,
			'编辑器区占位要给编辑器主题底色（与大宿主的状态框同源）');
		assert.match(helper!, /background:\$\{background\}/, 'helper 必须把底色写进占位样式里（两条宿主共用一处）');
	});

	test('★ 两条宿主都在"因浮层让位"这一步用同一个 helper（且让位与抓帧合成一次调用）', () => {
		for (const [name, src] of [['侧栏 pane', pane!], ['聊天宿主', chatHostSource!]] as const) {
			assert.match(src, /const freezeHide = !show && this\._overlayVisible && this\._viewShown;/,
				`${name} 要能认出"这一次隐藏是浮层让位"（其余隐藏原因不该抓帧）`);
			assert.ok(src.includes('this._freeze.hideAndFreeze(this._viewId)'),
				`${name} 让位必须走 \`hideAndFreeze\`（**一次**调用；否则抓帧与隐藏赛跑 ⇒ 抓到离屏空帧 ✗✗）`);
			assert.match(src, /\} else if \(freezeHide\) \{[\s\S]{0,200}?this\._freeze\.hideAndFreeze\(this\._viewId\);/,
				`${name} 只有 freezeHide 那条分支才走抓帧让位（` +
				'其它隐藏原因照常 setViewVisible(false)）');
			// ★ 这条是那次事故的直接形态：让位分支里**不许**再单独发 setViewVisible(false)（与抓帧赛跑）
			assert.match(src, /\} else if \(freezeHide\) \{[\s\S]{0,200}?this\._freeze\.hideAndFreeze\(this\._viewId\);[\s\S]{0,200}?\} else \{\s*void this\._dsh\.setViewVisible\(this\._viewId, false\);/,
				`${name} 让位分支里不许再发 setViewVisible(false)（hideAndFreeze 自己会藏；再发一次就是那次赛跑 ✗）`);
			assert.ok(src.includes('this._freeze.clear()'), `${name} 恢复显示时要清帧`);
			assert.ok(src.includes('new DshOverlayFreeze('), `${name} 必须用共用实现（各写一份 ⇒ 修一边另一边静默退化 ✗）`);
			assert.ok(!src.includes('_freezeForOverlay'), `${name} 不许再自带一份抓帧实现（令牌语义必须只有一处）`);
		}
	});

	test('★ 谓词方向：两条宿主传的是"**已过期**"式判据（`!overlayVisible || viewShown`）', () => {
		// 这条是 2026-10-15 那次事故的正面钉：把两份内联实现收拢进 helper 时，参数被当成"还有效吗"的
		// **反向**谓词 ⇒ 每帧都被判过期、帧永远贴不上 ⇒ 真机上表现为"浮层一出现内容就空白"
		// （而行为测试里传字面量照样绿 ✗✗：它测的是 helper 自己，测不到调用点传反）。
		for (const [name, src] of [['侧栏 pane', pane!], ['聊天宿主', chatHostSource!]] as const) {
			assert.match(src, /new DshOverlayFreeze\([^;]*?\(\) => !this\._overlayVisible \|\| this\._viewShown,/,
				`${name} 必须传"已过期"式判据（已恢复显示 / 已不在遮挡 ⇒ 过期）；传反了帧永远贴不上 ✗`);
			assert.match(src, /line => this\._log\.warn\(/, `${name} 要把抓帧失败留痕（否则现场只剩"内容空白"一个症状 ✗）`);
		}
		assert.match(helper!, /this\._isStale\(\)/, 'helper 必须按"过期"语义调用它（名字带 Stale 就是防传反）');
	});

	test('★★ 主进程 captureAndHide：**先抓后藏**（这一版的关键次序），且抓图失败仍照常让位', () => {
		const at = viewHost!.indexOf('async captureAndHide(');
		assert.ok(at > 0, '找不到 captureAndHide（守卫不能空跑）');
		const body = viewHost!.slice(at, at + 1600);
		assert.match(body, /isDestroyed\(\)/, '视图已销毁必须判掉（对销毁的 webContents 抓图会抛）');
		assert.match(body, /image\.isEmpty\(\)/, '空帧必须判掉（贴一张空图 = 又把那块变黑 ✗）');
		assert.match(body, /\} catch \{|\} catch \(/, '抓图要 try/catch（原生抛错不能冒到通道调用方）');
		// ★ 次序：抓图必须在 `setVisible(viewId, false)` **之前** —— 反过来的话（先藏后抓）抓到的是
		//   离屏空帧，真机上表现为"完全没做这件事"（2026-10-15 复测现场就是这个 ✗✗）
		const grabAt = body.indexOf('capturePage()');
		const hideAt = body.lastIndexOf('this.setVisible(viewId, false)');
		assert.ok(grabAt > 0, '必须调用 capturePage()（守卫不能空跑）');
		assert.ok(hideAt > grabAt, '必须先抓（此刻视图还可见）再藏；顺序反了 ⇒ 抓到离屏空帧 ✗✗');
		assert.match(body, /return frame;/, '把抓到的那一帧返回给渲染侧（贴到占位上）');
	});

	test('★ 三层接线齐全：协议枚举 + 通道处理 + 渲染侧方法', () => {
		assert.match(common!, /FreezeView = 'freezeView'/, '协议枚举缺 FreezeView ⇒ 通道调用会被拒（"未知道命令"）');
		assert.match(channel!, /case DshHarnessChannelCommand\.FreezeView/, '通道必须处理 FreezeView');
		assert.match(channel!, /await this\._views\.captureAndHide\(a\.viewId\)/, '通道要转发到视图宿主（抓帧+让位一次完成）');
		assert.match(service!, /freezeView\(viewId: string\): Promise<string \| undefined>/, '渲染侧服务要有 freezeView（含返回类型）');
	});
});

/**
 * ★ 冻结帧 helper 的**行为**测试（不是源码 grep）：令牌作废是这套东西唯一容易写错的地方 ——
 * 写错的表现是"恢复显示之后旧画面闪回"或"贴了一张空图 ⇒ 又把那块变黑"，两者都只在真机上偶发。
 * 这里用假元素 + 假 host 把时序钉死（helper 无任何运行时依赖 ⇒ 能直接在 node 里跑 ✓）。
 */
suite('dshHarness / DshOverlayFreeze（冻结帧 helper 的行为）', () => {

	/** 假占位（只用到 style 的四个属性，与 helper 的接口一致）。 */
	const fakeElement = () => ({ style: { backgroundImage: '', backgroundSize: '', backgroundPosition: '', backgroundRepeat: '' } });
	const flush = () => new Promise<void>(r => setTimeout(r, 0));

	test('抓到的帧会贴到占位上（cover + 顶端对齐），dataURL 原样进 url()', async () => {
		const el = fakeElement();
		// 第三个参数是"**已经过期**了吗" ⇒ 还在遮挡期间（没过期）传 false ✓
		const freeze = new DshOverlayFreeze(el, { freezeView: async () => 'data:image/jpeg;base64,AAA' }, () => false);
		freeze.hideAndFreeze('v1');
		await flush();
		assert.strictEqual(el.style.backgroundImage, 'url("data:image/jpeg;base64,AAA")');
		assert.strictEqual(el.style.backgroundSize, 'cover');
		assert.strictEqual(el.style.backgroundPosition, 'center top');
		assert.strictEqual(el.style.backgroundRepeat, 'no-repeat');
	});

	test('★ 迟到帧作废：`clear()` 之后回来的帧不许贴（否则恢复显示后闪回旧画面）', async () => {
		const el = fakeElement();
		let release!: (v: string) => void;
		const pending = new Promise<string>(r => { release = r; });
		const freeze = new DshOverlayFreeze(el, { freezeView: () => pending }, () => true);
		freeze.hideAndFreeze('v1');
		freeze.clear();                 // 用户已经移开鼠标、视图恢复显示
		release('data:image/jpeg;base64,LATE');
		await flush();
		assert.strictEqual(el.style.backgroundImage, '', 'clear 之后回来的帧必须丢弃');
	});

	test('★ 后一轮请求作废前一轮：只有最新那一帧能贴上（连续遮挡不闪回）', async () => {
		const el = fakeElement();
		const resolvers: ((v: string) => void)[] = [];
		const freeze = new DshOverlayFreeze(el, { freezeView: () => new Promise<string>(r => resolvers.push(r)) }, () => false);
		freeze.hideAndFreeze('v1');
		freeze.hideAndFreeze('v1');
		resolvers[0]('data:image/jpeg;base64,FIRST');   // 第一轮迟到
		await flush();
		assert.strictEqual(el.style.backgroundImage, '', '第一轮的帧必须被第二轮作废');
		resolvers[1]('data:image/jpeg;base64,SECOND');
		await flush();
		assert.strictEqual(el.style.backgroundImage, 'url("data:image/jpeg;base64,SECOND")', '最新那一帧才是有效的');
	});

	test('★ 判据失效 / 空帧 / 抓图失败 / 没 viewId ⇒ 都不贴（宁可露主题底色，也不贴错东西）', async () => {
		const el = fakeElement();
		// ① isStale=true（例如已经恢复显示 / 早就不在遮挡）
		new DshOverlayFreeze(el, { freezeView: async () => 'data:image/jpeg;base64,X' }, () => true).hideAndFreeze('v1');
		await flush();
		assert.strictEqual(el.style.backgroundImage, '');
		// ② 空帧
		new DshOverlayFreeze(el, { freezeView: async () => undefined }, () => true).hideAndFreeze('v1');
		await flush();
		assert.strictEqual(el.style.backgroundImage, '');
		// ③ 抓图 reject（主进程通道异常）⇒ 静默（不冒到调用方，也不卡住让位流程）
		new DshOverlayFreeze(el, { freezeView: async () => { throw new Error('boom'); } }, () => true).hideAndFreeze('v1');
		await flush();
		assert.strictEqual(el.style.backgroundImage, '');
		// ④ viewId 为空 ⇒ 连抓都不抓
		let called = 0;
		new DshOverlayFreeze(el, { freezeView: async () => { called++; return 'data:image/jpeg;base64,Y'; } }, () => true).hideAndFreeze(undefined);
		await flush();
		assert.strictEqual(called, 0, '没有视图 id 时不该发抓帧请求');
	});

	test('★ 抓帧失败要留痕（不吞异常，也不影响让位）', async () => {
		const el = fakeElement();
		const lines: string[] = [];
		// 未果：主进程还没这个命令（窗口重载不更新主进程 bundle）/ 通道报错 —— 现场必须能从日志看出是哪一类 ✗
		new DshOverlayFreeze(el, { freezeView: async () => { throw new Error('unknown command: freezeView'); } }, () => false, l => lines.push(l))
			.hideAndFreeze('v1');
		await flush();
		assert.strictEqual(lines.length, 1, '失败要留一行痕（否则只剩"内容空白"这一个症状）');
		assert.match(lines[0], /unknown command: freezeView/, '痕里要带上原始原因');
		assert.strictEqual(el.style.backgroundImage, '', '失败时不该贴任何东西（占位保持主题底色）');
	});

	test('clear() 只清 backgroundImage（尺寸/位置留着，下次 request 会重设）', () => {
		const el = fakeElement();
		el.style.backgroundImage = 'url("x")';
		el.style.backgroundSize = 'cover';
		new DshOverlayFreeze(el, { freezeView: async () => undefined }, () => true).clear();
		assert.strictEqual(el.style.backgroundImage, '');
		assert.strictEqual(el.style.backgroundSize, 'cover');
	});
});
