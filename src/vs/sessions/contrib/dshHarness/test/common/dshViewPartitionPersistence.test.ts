/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh 视图的**网络分区必须持久化**（2026-10-22 用户报障的永久守卫）。
 *
 * ## 报障原文与根因
 *
 * 用户：「主页工作台中的 item，点击固定按钮后，重启 app 后，左侧栏中固定的工作台图标消失了」。
 *
 * 「固定」在 dsh 客户端窗口这一侧做的事是：把该工作台登记成**侧栏的一行**（排在官方「自动化任务」
 * =order 10 下方）。登记清单存在**页面的 localStorage**（键 `vssaros.wb.pinned`）里 ——
 * 页面与清单都在 `desktopSession` 那个分区中。
 *
 * 而那个分区原先是**非 persist** 的 ⇒ Electron 只把它放在内存里 ⇒ **进程一退出数据全没** ⇒
 * 下次启动侧栏读到的清单是空的 ⇒ 固定行长不出来 ⇒ 用户看到的就是「图标自己消失了」✗。
 *
 * 分区隔离（Chromium 对同一 `host:port` 的 6 连接上限）与持久化是**两件独立的事** ⇒
 * 改成 persist 不影响那条隔离修复 ✓。
 *
 * ## 为什么要有这条守卫
 *
 * 这类缺陷**不会报错**：分区名改回非 persist，页面照常渲染，只是重启后固定行不见了 ⇒
 * 只能靠一条钉死「分区必须 persist」的断言把它挡住（断言是**绝对值**，不是相对比较 ⇒ 一定会红 ✓）。
 */

import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { DSH_VIEW_PARTITION, DSH_VIEW_PARTITION_DESKTOP } from '../../common/dshHarness.js';

suite('dshHarness / 视图网络分区：必须持久化', () => {

	test('主分区是 persist（IDE 内嵌的 dsh 页面：会话/人设等 localStorage 状态要跨重启）', () => {
		assert.strictEqual(DSH_VIEW_PARTITION, 'persist:vssaros-dsh');
	});

	test('桌面窗口分区也是 persist（★ 本条守卫的就是「重启后固定行消失」那个报障）', () => {
		assert.strictEqual(
			DSH_VIEW_PARTITION_DESKTOP,
			'persist:vssaros-dsh-desktop',
			'桌面窗口分区必须 persist：侧栏「固定行」清单存在页面 localStorage 里，非 persist 会在进程退出时蒸发 ✗',
		);
	});

	test('桌面窗口分区仍与主分区**分开**（socket 池隔离那条修复不能被顺带弄丢）', () => {
		assert.notStrictEqual(
			DSH_VIEW_PARTITION_DESKTOP,
			DSH_VIEW_PARTITION,
			'桌面窗口必须用自己的分区（同一 host:port 的 6 连接上限会把两个页面饿死 ✗）',
		);
	});
});

suite('dshHarness / 侧栏固定行：启动时必须被重新登记', () => {
	const repo = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
	const nav = readFileSync(join(repo, 'dsh-plugins', 'vssaros-chat-surface', 'lib', 'client.workbenchNav.js'), 'utf8');

	test('清单键固定（localStorage 的键名是跨版本的契约）', () => {
		assert.ok(
			/const LS_PINNED\s*=\s*"vssaros\.wb\.pinned"/.test(nav),
			'固定行清单的 localStorage 键必须固定为 vssaros.wb.pinned ✗',
		);
	});

	test('启动路径会同步固定行（主页行注册时 + 兜底重试时都要调）', () => {
		assert.ok(
			/nav:主页行[\s\S]{0,400}?syncPinnedRows\(\)/.test(nav),
			'主页行注册时必须同步固定行（否则启动后侧栏固定行长不出来 ✗）',
		);
		assert.ok(
			/nav:主页行\(重试\)[\s\S]{0,600}?syncPinnedRows\(\)/.test(nav),
			'兜底重试路径必须同步固定行（原来漏了 ⇒ 第一次 inject 抛了就永远不长固定行 ✗）',
		);
	});
});
