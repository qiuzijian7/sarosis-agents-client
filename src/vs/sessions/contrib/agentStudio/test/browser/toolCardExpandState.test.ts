/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具卡「执行完毕后自动折叠」回归测试（2026-09-13，日志 1789307937031）。
 *
 * 事故：terminal 工具卡片执行完毕（√ 完成、exit code 0、13 行输出）后**不折叠**，
 * 输出区常驻占屏。
 *
 * 根因不在折叠逻辑本身（`fileCards.ts` 第 677 行的
 * `expanded = userChoice ?? (isRunning && !tc.result)` 是对的），而在
 * `_updateToolCardStatuses` 的 status-change 整卡重建分支：它读旧卡展开态后
 * **无条件沿用并写回 `_toolCallExpandState`**。运行中的 terminal 卡默认展开，
 * 于是 `running → success` 时把「自动展开」固化成了「用户选择」= true，
 * 第 677 行的默认值计算从此永久失效。
 *
 * 关键断言：**「用户显式展开」必须保留，「运行中自动展开」必须不被保留**。
 */

import assert from 'assert';
import {
	shouldPreserveExpandedAcrossRebuild, shouldPersistExpandState, IToolCardExpandSnapshot,
} from '../../../../browser/agentChat/toolCardExpandState.js';

/** 运行中的 terminal 卡：DOM 已展开，但用户从未点过 chevron（Map 中无该 id）。 */
const autoExpandedRunning: IToolCardExpandSnapshot = {
	wasExpanded: true,
	userChoseExpandState: false,
};

/** 用户手动点开过的卡：DOM 展开，且 Map 中记录了该 id。 */
const userExpanded: IToolCardExpandSnapshot = {
	wasExpanded: true,
	userChoseExpandState: true,
};

/** 用户手动折叠过的卡。 */
const userCollapsed: IToolCardExpandSnapshot = {
	wasExpanded: false,
	userChoseExpandState: true,
};

/** 从未被触碰过的折叠卡。 */
const untouched: IToolCardExpandSnapshot = {
	wasExpanded: false,
	userChoseExpandState: false,
};

suite('toolCardExpandState — shouldPreserveExpandedAcrossRebuild', () => {

	test('★ 运行中自动展开 → 不保留（本 bug 的核心断言）', () => {
		// running→success 重建时若保留，卡片就永远不折叠。
		assert.strictEqual(
			shouldPreserveExpandedAcrossRebuild(autoExpandedRunning), false,
			'自动展开不是用户选择，status 变化后必须按新状态重算 → 折叠',
		);
	});

	test('用户显式展开 → 保留（避免流式刷新把用户展开的内容合上）', () => {
		assert.strictEqual(shouldPreserveExpandedAcrossRebuild(userExpanded), true);
	});

	test('用户显式折叠 → 不保留', () => {
		assert.strictEqual(shouldPreserveExpandedAcrossRebuild(userCollapsed), false);
	});

	test('从未触碰 → 不保留', () => {
		assert.strictEqual(shouldPreserveExpandedAcrossRebuild(untouched), false);
	});
});

suite('toolCardExpandState — shouldPersistExpandState', () => {

	test('★ 运行中自动展开 → 不写回 Map（写回会让默认值永久失效）', () => {
		assert.strictEqual(
			shouldPersistExpandState(autoExpandedRunning), false,
			'把「自动展开」写回 Map 会把 false 覆盖成 true，等价于伪造用户选择',
		);
	});

	test('用户显式选择（展开或折叠）→ 写回', () => {
		assert.strictEqual(shouldPersistExpandState(userExpanded), true);
		assert.strictEqual(shouldPersistExpandState(userCollapsed), true);
	});

	test('从未触碰 → 不写回', () => {
		assert.strictEqual(shouldPersistExpandState(untouched), false);
	});
});

suite('toolCardExpandState — 完整生命周期', () => {

	test('运行中→执行完毕：卡片折叠且 Map 不被污染', () => {
		// ① 建卡时 status=running → 默认展开，且 terminal 卡**不写** Map。
		const expandState = new Map<string, boolean>();
		const toolCallId = 'tc_1';
		assert.strictEqual(expandState.has(toolCallId), false, 'terminal 卡建卡不写回');

		// ② 旧卡 DOM 展开。
		const snapshot: IToolCardExpandSnapshot = {
			wasExpanded: true,
			userChoseExpandState: expandState.has(toolCallId),
		};

		// ③ running→success 整卡重建。
		const preserved = shouldPreserveExpandedAcrossRebuild(snapshot);
		if (shouldPersistExpandState(snapshot)) {
			expandState.set(toolCallId, !preserved);
		}

		// ④ 断言：卡片折叠，且 Map 仍是干净的（下次重建仍能按状态算默认值）。
		assert.strictEqual(preserved, false, '执行完毕后必须折叠');
		assert.strictEqual(expandState.has(toolCallId), false, 'Map 未被「自动展开」污染');
	});

	test('用户先展开再执行完毕：保持展开且选择持久', () => {
		const expandState = new Map<string, boolean>();
		const toolCallId = 'tc_2';

		// ① 运行中自动展开（不写 Map）。
		// ② 用户点开 chevron → 写入 true。
		expandState.set(toolCallId, true);

		// ③ running→success 重建：旧卡展开 + 用户选择过 → 保留。
		const snapshot: IToolCardExpandSnapshot = {
			wasExpanded: true,
			userChoseExpandState: expandState.has(toolCallId),
		};
		assert.strictEqual(shouldPreserveExpandedAcrossRebuild(snapshot), true, '用户的选择要尊重');
		assert.strictEqual(expandState.get(toolCallId), true, '选择跨重建持久');
	});

	test('用户先折叠再执行完毕：保持折叠', () => {
		const expandState = new Map<string, boolean>();
		const toolCallId = 'tc_3';
		expandState.set(toolCallId, false);

		const snapshot: IToolCardExpandSnapshot = {
			wasExpanded: false,
			userChoseExpandState: expandState.has(toolCallId),
		};
		assert.strictEqual(shouldPreserveExpandedAcrossRebuild(snapshot), false);
		assert.strictEqual(shouldPersistExpandState(snapshot), true, '折叠选择也应写回以持久');
	});
});
