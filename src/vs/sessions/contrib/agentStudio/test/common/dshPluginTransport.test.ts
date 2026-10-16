/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件安装**通道选择**的真值表守卫（2026-10-13）。
 *
 * 为什么值得一条：这个判据决定"点安装会发生什么"，而它的两个消费点（真安装 / 取消按钮）**必须一致**，
 * 且错法的后果都是"静默的怪"：
 *  · 注册表规格走了商城那条 ⇒ 全新 profile 上 `operation-error`（首启用户装不上，README 4.86 ✗✗）；
 *  · 批准构建脚本后却走主进程那条 ⇒ 用户点了"允许并重装"却**没有构建**（Host 的能力被绕过 ✗）；
 *  · 注册表规格但预检没给名字却走 spec 那条 ⇒ 装完无从核对 ⇒ 可能把"没装上"显示成成功 ✗。
 * 这三条都在这里钉住。
 *
 * 运行：node src/vs/sessions/contrib/agentStudio/test/common/run-all-common-tests.mjs
 */

import assert from 'assert';
import { dshInstallTransport } from '../../common/dshPluginTransport.js';

suite('插件安装通道选择（真值表）', () => {

	test('★ 注册表规格（有名字）⇒ 主进程 spec 那条（全新 profile 上只有它可行）', () => {
		assert.strictEqual(dshInstallTransport({ kind: 'registry', name: '@tt-a1i/archify-dsh' }, false), 'spec');
		assert.strictEqual(dshInstallTransport({ kind: 'registry', name: '@deepseek-ai/dsh-experimental-schedule-bundle' }, false), 'spec');
	});

	test('★ 注册表规格但**没有名字** ⇒ 回落商城那条（装完要按名字核对，没名字就不敢走 spec ✗）', () => {
		assert.strictEqual(dshInstallTransport({ kind: 'registry' }, false), 'marketplace');
		assert.strictEqual(dshInstallTransport({ kind: 'registry', name: '   ' }, false), 'marketplace');
	});

	test('★ 带"已批准的构建脚本"⇒ 一律商城那条（批准构建是 Host 的能力，主进程那条做不到）', () => {
		assert.strictEqual(dshInstallTransport({ kind: 'registry', name: 'x' }, true), 'marketplace');
		assert.strictEqual(dshInstallTransport({ kind: 'path', name: 'x' }, true), 'marketplace');
		assert.strictEqual(dshInstallTransport(undefined, true), 'marketplace',
			'第二次点"允许并重装"必须回到 Host 那条 —— 否则用户批准了却没有构建 ✗');
	});

	test('本地路径 ⇒ 暂存那条（跨盘符安全）；git / tarball / 未知 / 没预检 ⇒ 商城那条', () => {
		assert.strictEqual(dshInstallTransport({ kind: 'path', name: 'x' }, false), 'local');
		assert.strictEqual(dshInstallTransport({ kind: 'git' }, false), 'marketplace',
			'git 要 pnpm 去解析、且要能取消 ⇒ 留在商城那条');
		assert.strictEqual(dshInstallTransport({ kind: 'tarball' }, false), 'marketplace');
		assert.strictEqual(dshInstallTransport({ kind: '以后新加的形态' }, false), 'marketplace',
			'未知形态必须落到"能力最全"的那条（默认安全侧），而不是猜一个 ✗');
		assert.strictEqual(dshInstallTransport(undefined, false), 'marketplace',
			'还没预检就点安装时（界面本来就禁用）不该崩，且落商城那条');
	});

	test('path 判定优先于名字/形态的组合（顺序即语义）', () => {
		assert.strictEqual(dshInstallTransport({ kind: 'path' }, false), 'local',
			'本地目录不需要预检给名字（supervisor 自己读 package.json 的 name ✓）');
	});
});
