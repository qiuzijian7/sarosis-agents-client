/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * "一次 IDE 能力该投给哪个窗口"的策略单测（`common/dshIdeTargeting.ts`）。
 *
 * 三条边界，各自对应一种**明确**的处理（没有"猜"这一档）：
 * ① 能定位 ⇒ `window`（正在跑这个会话的窗口：模型在这个会话里干活，结果就该落在用户看得见的地方）；
 * ② **同会话同时在两窗口** ⇒ `ambiguous` ⇒ 调用方**拒绝**这次请求（README 4.49：不取第一个、不聚焦优先，
 *    两者都是猜，猜错就是用户直接看到的错；而"两窗口开同一工作区会派生同一会话"有据可查，说得清）；
 * ③ 判不出来（没带会话 id / 没有窗口绑它 / 视图没绑会话）⇒ `none` ⇒ 调用方退回广播（与从前一致）。
 */

import assert from 'assert';
import { pickIdeTargetWindow } from '../../common/dshIdeTargeting.js';

suite('dshHarness / IDE request targeting（落对窗口）', () => {

	test('★ 带 sessionId 且窗口绑着该会话 ⇒ 定向到那个窗口', () => {
		const slots = [{ ownerWindowId: 1, sessionId: 's-other' }, { ownerWindowId: 2, sessionId: 's-target' }];
		assert.deepStrictEqual(pickIdeTargetWindow(slots, 's-target'), { kind: 'window', windowId: 2 });
	});

	test('★★ 同一个会话同时在两个窗口开着 ⇒ `ambiguous`（调用方**拒绝**，不猜）', () => {
		const slots = [
			{ ownerWindowId: 7, sessionId: 's' },
			{ ownerWindowId: 8, sessionId: 's' },
			{ ownerWindowId: 7, sessionId: 's' },   // 同窗口的重复不算新增
		];
		assert.deepStrictEqual(pickIdeTargetWindow(slots, 's'), { kind: 'ambiguous', windowIds: [7, 8] });
	});

	test('同一窗口内多个视图绑同一会话 ⇒ 不算歧义（都指向同一个窗口）', () => {
		const slots = [{ ownerWindowId: 3, sessionId: 's' }, { ownerWindowId: 3, sessionId: 's' }];
		assert.deepStrictEqual(pickIdeTargetWindow(slots, 's'), { kind: 'window', windowId: 3 });
	});

	test('★ 判不出来就 `none`（调用方退回广播，不猜）', () => {
		const slots = [{ ownerWindowId: 2, sessionId: 's-target' }];
		assert.deepStrictEqual(pickIdeTargetWindow(slots, undefined), { kind: 'none' }, '老版本 dsh 不传 sessionId');
		assert.deepStrictEqual(pickIdeTargetWindow(slots, ''), { kind: 'none' }, '空串不是有效会话 id');
		assert.deepStrictEqual(pickIdeTargetWindow(slots, 's-missing'), { kind: 'none' }, '没有窗口绑着这个会话');
		assert.deepStrictEqual(pickIdeTargetWindow([], 's-target'), { kind: 'none' }, '一个 dsh 视图都没有');
		assert.deepStrictEqual(pickIdeTargetWindow([{ ownerWindowId: 3 }], 's-target'), { kind: 'none' }, '视图存在但没绑会话');
	});
});
