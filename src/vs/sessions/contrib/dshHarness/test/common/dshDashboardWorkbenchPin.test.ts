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
 *
 * ⚠ 2026-10-22（主页改 React 渲染）：工作台卡片的结构与「固定」分发搬到 `lib/app/src/app.jsx`，
 *   宿主半不再内联这套 HTML/CSS ⇒ 本守卫的文件落点跟着改（**意图一条没减**）。
 */
suite('dshHarness / dashboard 工作台卡片：主页恒为固定', () => {
	const repo = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
	const dashDir = join(repo, 'dsh-plugins', 'vssaros-dashboard', 'lib');
	const catalog = readFileSync(join(dashDir, 'catalog.js'), 'utf8');
	// 渲染层实现源（2026-10-22 起是 React 应用；原先是 pageClient.js，已下线）
	const app = readFileSync(join(dashDir, 'app', 'src', 'app.jsx'), 'utf8');
	const appCss = readFileSync(join(dashDir, 'app', 'src', 'app.css'), 'utf8');

	test('主页在模块清单里标记为恒固定', () => {
		assert.ok(
			/route:\s*'\/x\/dashboard\/'[^\n]*alwaysPinned:\s*true/.test(catalog),
			'主页条目必须带 alwaysPinned: true（否则卡片上又会出现可点的「📌 固定」✗）',
		);
	});

	test('卡片按钮按 alwaysPinned 分流：主页=禁用的「已固定」，其它=可点的「📌 固定」', () => {
		// ⚠ 2026-10-22：卡片的 HTML 不再由 catalog.js 产出（死渲染路径已删）⇒ 模板断言落在 app.jsx 上。
		assert.ok(catalog.includes('alwaysPinned: true'), '卡片数据必须带 alwaysPinned 标记 ✗');
		// ⚠ 2026-10-23：工作台改成磁贴（图标 + 名称 + 描述），不再有「📌 已固定」文字 ——
		//   固定态改成 `is-on` 的图钉（`<span>` 而非按钮 ⇒ 点不了 = 不可取消）。
		assert.ok(app.includes('dash-wb-op is-on'), '主页那张卡必须显示「已固定」态的图钉 ✗');
		assert.ok(
			/主页恒为固定（不可取消）/.test(app),
			'React 版：主页那颗按钮必须 disabled 且写明原因（不可取消固定 ✗）',
		);
		assert.ok(
			/isPinned \? 'unpin-module' : 'pin-module'/.test(app),
			'其它工作台仍要能固定/取消固定（按 isPinned 分流到 unpin / pin 动作 ✓）',
		);
	});

	test('页面脚本兜一层：即便别的入口给主页发 pin，也不生效', () => {
		assert.ok(app.includes('ALWAYS_PINNED_ROUTES'), '页内脚本必须有 ALWAYS_PINNED_ROUTES 白名单 ✗');
		assert.ok(
			/ALWAYS_PINNED_ROUTES\.indexOf\(item\.route\)/.test(app),
			'pin 分派必须先查白名单（否则旧页面/脚本能把主页取消固定 ✗）',
		);
		assert.ok(
			/主页恒为固定，不可取消/.test(app),
			'被拦下时要如实回一句话（不静默 ✗）',
		);
	});

	test('禁用态有样式（别让 hover 边框误导成"可点"）', () => {
		assert.ok(appCss.includes('.dash-wb-op[disabled]'), '必须有 .dash-wb-op[disabled] 样式 ✗');
	});
});
