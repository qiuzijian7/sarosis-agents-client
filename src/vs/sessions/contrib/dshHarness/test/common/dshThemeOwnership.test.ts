/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「谁决定明暗」的归属守卫（2026-11-02 用户报障的回归）。
 *
 * ## 报障
 * 「dsh 侧，切换外观后，跟随系统 → 浅色，**部分页面没有一起切换**」。
 *
 * ## 根因（真机取证：dev 实例 CDP 9799，dsh 页 `data-ds-theme-source=light`）
 * 宿主把**每条** dsh 视图的 `--dsw-alias-*` 用 `overrideTokens` 钉成 **IDE 主题色**（浅/深同值），
 * 并把 `prefers-color-scheme` emulate 成 IDE 主题的明暗。这在 IDE 内嵌聊天框里是对的，但在
 * **dsh 自主窗口**（桌面 / 分屏 / 全窗）里用户改的是 dsh「外观」⇒ 两套明暗打架，现场量到：
 *   · `--dsw-specific-sidebar-fill` = `#f9fafb`（浅，跟 dsh 外观）
 *   · `--dsw-alias-bg-base` = `#1e1e1e`（深，跟 IDE 主题）
 * ⇒ 侧栏变浅、弹窗/正文仍深（浅底浅字）。
 *
 * ## 修法（本守卫钉住的三件事）
 * 1. 判据只有一处：`common/dshThemeBridge.ts::isDshOwnWindow`（视图窗口 ≠ IDE 主窗口）；
 * 2. 自主窗口的视图**不吃** IDE 主题：不推 token 覆盖层（推空集=撤层）、不推 IDE 的 palette 模式/底色；
 * 3. 自主窗口的 `prefers-color-scheme` 改跟页面自报的 `data-ds-theme-source`（`system` ⇒ 撤模拟）。
 *
 * ## 为什么含**源码级**断言
 * bug 本体在 `dshHarnessService.ts` / `dshViewHost.ts`（electron 依赖，单测跑不起来）与
 * preload（独立脚本）里 ⇒ 纯逻辑用行为测试钉住，接线用精确源码扫描钉住（同 `dshViewLoadRetry`）。
 */

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { isDshOwnWindow } from '../../common/dshThemeBridge.js';

suite('dshHarness / 主题归属（dsh 外观 vs IDE 主题）', () => {

	const REPO = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
	const read = (rel: string): string => {
		const abs = join(REPO, rel);
		return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
	};

	// ── 判据本体 ──────────────────────────────────────────────────────────────

	test('★ 判据：视图窗口 ≠ IDE 主窗口 ⇒ dsh 自主窗口', () => {
		assert.strictEqual(isDshOwnWindow(1, 1), false, '主窗口里的视图 = IDE 内嵌（跟 IDE 主题）');
		assert.strictEqual(isDshOwnWindow(5, 1), true, 'aux 窗口（桌面 / 分屏 / 全窗）= dsh 自主（跟 dsh 外观）');
		// 拿不到主窗口 id 时**保守**当作内嵌：宁可维持旧行为（跟 IDE），也不要把内嵌聊天框
		// 改成跟 dsh 外观走（那会让"聊天框跟 IDE 一致"这条产品口径凭空消失）
		assert.strictEqual(isDshOwnWindow(5, undefined), false, '主窗口 id 缺失 ⇒ 不当自主窗口（保守）');
	});

	// ── 渲染侧接线：谁不吃 IDE 主题 ───────────────────────────────────────────

	suite('dshHarnessService 接线', () => {
		const REL = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
		const source = read(REL);

		test('★ createView 必须按窗口归属分流：自主窗口不传 IDE 的 colorScheme / 底色', () => {
			assert.ok(source.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）——守卫不能空跑`);
			assert.match(source, /const dshOwnWindow = isDshOwnWindow\(windowId, mainWindow\?\.vscodeWindowId\);/,
				'归属判据必须来自 common/dshThemeBridge（别在这里另写一套比较逻辑）');
			assert.match(source, /\.\.\.\(dshOwnWindow \? \{ dshOwnWindow: true \} : \{ colorScheme: this\._colorScheme\(\) \}\)/,
				'自主窗口**不许**带 IDE 的 palette 模式（带了就会被 emulate 成 IDE 明暗 ⇒ 外观失效）');
			assert.match(source, /\.\.\.\(dshOwnWindow \? \{\} : \{ backgrounds: this\._viewBackgrounds\(\) \}\)/,
				'自主窗口**不许**带 IDE 底色（浅色外观 + 深色 IDE ⇒ 原生视图被染成深色）');
		});

		test('★ pushTheme 对自主窗口只推空集（撤掉 vssaros 覆盖层）', () => {
			assert.ok(source.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）——守卫不能空跑`);
			const at = source.indexOf('private _pushTheme(');
			assert.ok(at > 0, '_pushTheme 不见了（改名/挪走就要同步改这条守卫）');
			const block = source.slice(at, at + 1600);
			assert.match(block, /this\._dshOwnViews\.has\(viewId\)/,
				'必须按 _dshOwnViews 分流（漏了就是原来的"钉死 IDE 主题色"）');
			assert.match(block, /PushTheme, \{ viewId, tokens: \{\} \}/,
				'自主窗口要**显式推空集**（= 撤层）：什么都不推的话，曾叠上的 IDE 色会一直留着');
			assert.doesNotMatch(block.slice(0, block.indexOf('PushTheme, { viewId, tokens: {} }')),
				/colorScheme: this\._colorScheme\(\)/,
				'早退分支里不许带 colorScheme（那是 IDE 的明暗）');
		});

		test('★ disposeView 要回收 _dshOwnViews（否则视图 id 复用时会继承错归属）', () => {
			assert.ok(source.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）——守卫不能空跑`);
			// ⚠ 别按 `disposeView(` 取位置：接口声明比实现靠前，扫描窗口会落在声明上（本守卫第一版就这么假红过）
			const at = source.indexOf('disposeView(viewId: string): Promise<void> {');
			assert.ok(at > 0, 'disposeView 实现不见了（改名/挪走就要同步改这条守卫）');
			assert.match(source.slice(at, at + 400), /this\._dshOwnViews\.delete\(viewId\);/,
				'销毁视图必须把它从自主窗口集合里删掉');
		});
	});

	// ── 主进程接线：prefers-color-scheme 归谁 ─────────────────────────────────

	suite('dshViewHost 接线', () => {
		const REL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts';
		const source = read(REL);

		test('★ IDE 的 palette 模式不许盖自主窗口', () => {
			assert.ok(source.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）——守卫不能空跑`);
			assert.match(source, /if \(colorScheme && !slot\.dshOwnWindow\)/,
				'pushTheme 里必须挡住自主窗口（否则 IDE 主题的明暗会把 dsh 外观盖掉）');
		});

		test('★ 自主窗口改按页面自报的 data-ds-theme-source 对齐', () => {
			assert.ok(source.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）——守卫不能空跑`);
			// ⚠ 锚到**定义签名**：构造函数里的调用 `this.applyPageThemeSource(slot.id, value)` 比它靠前
			const at = source.indexOf('applyPageThemeSource(viewId: string, source: DshPageThemeSource): void {');
			assert.ok(at > 0, 'applyPageThemeSource 定义不见了（页面自报的接线就断了）');
			const block = source.slice(at, at + 900);
			assert.match(block, /!slot\.dshOwnWindow/, '必须只对自主窗口生效（IDE 内嵌视图的明暗归 IDE 主题）');
			assert.match(block, /source === 'system'/, '`跟随系统` 必须单独一条分支');
			assert.match(block, /_clearEmulatedColorScheme\(slot\)/,
				'`system` 要**撤掉** emulation ⇒ 页面读真实系统值（留着模拟值 = 假装跟随系统）');
			assert.match(source, /ipcMain\.on\(DSH_PAGE_IPC_THEME_SOURCE, onThemeSource\)/,
				'页面自报通道必须真的注册（没注册 = 整条链路静默失效）');
			assert.match(source, /ipcMain\.removeListener\(DSH_PAGE_IPC_THEME_SOURCE, onThemeSource\)/,
				'注册要能撤销（多实例/测试里重复注册会叠加）');
		});
	});

	// ── 主进程：建视图时就定明暗（抄官方 dsh-desktop 的时序）────────────────────

	suite('初始明暗的时序（settings.yaml 先于页面自报）', () => {
		const CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';
		const HOST = 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts';

		test('★ CreateView 时必须先读 settings.yaml，再带着 pageColorScheme 建视图', () => {
			const source = read(CHANNEL);
			assert.ok(source.length > 0, `读不到 ${CHANNEL}（cwd=${process.cwd()}）——守卫不能空跑`);
			const at = source.indexOf('case DshHarnessChannelCommand.CreateView');
			assert.ok(at > 0, 'CreateView 分支不见了');
			const block = source.slice(at, at + 2000);
			assert.match(block, /const pageColorScheme = dshOwnWindow \? await this\._dshColorScheme\(\) : undefined;/,
				'自主窗口必须在**建视图之前**取到明暗（等页面自报 = 首帧按错的明暗画）');
			assert.match(block, /this\._views\.create\([\s\S]{0,400}dshOwnWindow, pageColorScheme\);/, '算出来的明暗必须透传给 create');
			assert.match(source, /private async _dshColorScheme\(\)/, '读偏好的实现不见了');
			assert.match(source, /join\(dshHome, 'settings\.yaml'\)/, '真源是 <dshHome>/settings.yaml（dsh 自己的设置，只读）');
			assert.match(source, /parseThemePreference\(text\)/, '必须走 common/dshThemePreference 的容错解析（认不出 ⇒ system）');
		});

		test('★ dshViewHost 建视图时就要 emulate，并在 did-finish-load 补一次', () => {
			const source = read(HOST);
			assert.ok(source.length > 0, `读不到 ${HOST}（cwd=${process.cwd()}）——守卫不能空跑`);
			const at = source.indexOf('if (dshOwnWindow && pageColorScheme) {');
			assert.ok(at > 0, '建视图时的 emulate 不见了');
			assert.match(source.slice(at, at + 200), /void this\._emulateColorScheme\(slot, pageColorScheme\);/,
				'建视图时必须真的设一次（只存字段不设 = 还是等页面自报）');
			assert.match(source, /lastPageThemeSource: pageColorScheme/,
				'要把"建视图时用的明暗"记进 slot（页面就绪后补发给它）');
			assert.match(source, /if \(slot\.dshOwnWindow && slot\.lastPageThemeSource\) \{[\s\S]{0,160}this\.applyPageThemeSource\(slot\.id, slot\.lastPageThemeSource\);/,
				'did-finish-load 的补发里必须重新对齐一次（建视图那一刻页面是 about:blank，CDP 命令可能被丢弃）');
		});
	});

	// ── 页面侧接线：谁把外观报上来 / 谁负责撤层 ───────────────────────────────

	suite('preload 与 chat-surface 接线', () => {
		const PRELOAD = 'src/vs/sessions/contrib/dshHarness/electron-browser/preload-dshView.ts';
		const PROTOCOL = 'src/vs/sessions/contrib/dshHarness/common/dshPageBridgeProtocol.ts';
		const CHAT = 'dsh-plugins/vssaros-chat-surface/lib/client.js';

		test('★ preload 必须盯 documentElement[data-ds-theme-source] 并上报（system 原样报）', () => {
			const source = read(PRELOAD);
			assert.ok(source.length > 0, `读不到 ${PRELOAD}（cwd=${process.cwd()}）——守卫不能空跑`);
			assert.match(source, /const THEME_SOURCE_CH = 'vssaros:dsh:theme-source';/,
				'通道名必须与 common/dshPageBridgeProtocol 的 DSH_PAGE_IPC_THEME_SOURCE 同值');
			assert.match(source, /dataset\.dsThemeSource/, '要读 dsh 官方写的那个属性（别自己再算一遍明暗）');
			assert.match(source, /attributeFilter: \['data-ds-theme-source'\]/, '外观改了要能立刻感知（MutationObserver）');
			assert.match(source, /raw === 'light' \|\| raw === 'dark' \|\| raw === 'system'/,
				'只放行三种取值；`system` **必须原样报**（在页面里解析成 light/dark 会被宿主模拟值自锁）');
		});

		test('★ 通道常量与 preload 的字面量必须同值（页面桥没有编译期共享）', () => {
			const protocol = read(PROTOCOL);
			assert.ok(protocol.length > 0, `读不到 ${PROTOCOL}（cwd=${process.cwd()}）——守卫不能空跑`);
			assert.match(protocol, /export const DSH_PAGE_IPC_THEME_SOURCE = 'vssaros:dsh:theme-source';/,
				'通道常量定义不见了');
		});

		test('★ chat-surface 收到空集要**撤层**（否则曾叠上的 IDE 色永远留在页面上）', () => {
			const source = read(CHAT);
			assert.ok(source.length > 0, `读不到 ${CHAT}（cwd=${process.cwd()}）——守卫不能空跑`);
			assert.match(source, /state\.themeDisposer = ctx\.theme\.overrideTokens\("vssaros", tokens\);/,
				'要自己记着 overrideTokens 返回的 disposer（官方语义：按 source 撤本层）');
			assert.match(source, /if \(!names\.length\) \{[\s\S]{0,120}state\.themeTokens = 0;/,
				'空集分支必须早退（= 只撤层、不叠空层）');
		});
	});
});
