/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';

/**
 * 主页的「固定」必须是**默认固定且不可取消**（用户 2026-10-21：
 * 「主页page中， 主页item ui中的固定，应该默认固定状态，且不可以取消固定」）。
 *
 * 为什么要有这条守卫：这一行的语义**只体现在 UI 上**（按钮 disabled + 文案「已固定」），
 * 改坏了**不会报错** —— 页面照常渲染，只是又冒出「📌 固定」按钮 ⇒ 用户会以为能取消固定 ⇒
 * 于是出现"点了没反应 / 固定状态自己变了"这类最难查的形态 ✗。
 */
suite('dshHarness / dashboard 工作台卡片：主页恒为固定', () => {
	const repo = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
	const dashDir = join(repo, 'dsh-plugins', 'vssaros-dashboard', 'lib');
	const catalog = readFileSync(join(dashDir, 'catalog.js'), 'utf8');
	const pageClient = readFileSync(join(dashDir, 'pageClient.js'), 'utf8');
	const dashIndex = readFileSync(join(dashDir, 'index.js'), 'utf8');

	test('主页在模块清单里标记为恒固定', () => {
		assert.ok(
			/route:\s*'\/x\/dashboard\/'[^\n]*alwaysPinned:\s*true/.test(catalog),
			'主页条目必须带 alwaysPinned: true（否则卡片上又会出现可点的「📌 固定」✗）',
		);
	});

	test('卡片按钮按 alwaysPinned 分流：主页=禁用的「已固定」，其它=可点的「📌 固定」', () => {
		assert.ok(catalog.includes('alwaysPinned ?'), '卡片模板必须按 alwaysPinned 分流 ✗');
		assert.ok(catalog.includes('📌 已固定'), '主页那张卡必须显示「📌 已固定」✗');
		assert.ok(
			/disabled[^>]*>📌 已固定/.test(catalog),
			'「已固定」按钮必须带 disabled（不可取消固定 ✗）',
		);
		assert.ok(
			/data-dash-action="pin-module"[^>]*>📌 固定/.test(catalog),
			'其它工作台仍要能固定（保留可点的「📌 固定」+ pin 动作 ✓）',
		);
	});

	test('页面脚本兜一层：即便别的入口给主页发 pin，也不生效', () => {
		assert.ok(pageClient.includes('ALWAYS_PINNED_ROUTES'), '页内脚本必须有 ALWAYS_PINNED_ROUTES 白名单 ✗');
		assert.ok(
			/ALWAYS_PINNED_ROUTES\.indexOf\(pinRoute\)/.test(pageClient),
			'pin-module 分派必须先查白名单（否则旧页面/脚本能把主页取消固定 ✗）',
		);
		assert.ok(
			/主页恒为固定，不可取消/.test(pageClient),
			'被拦下时要如实回一句话（不静默 ✗）',
		);
	});

	test('禁用态有样式（别让 hover 边框误导成"可点"）', () => {
		assert.ok(dashIndex.includes('.wb-op[disabled]'), '必须有 .wb-op[disabled] 样式 ✗');
	});
});
