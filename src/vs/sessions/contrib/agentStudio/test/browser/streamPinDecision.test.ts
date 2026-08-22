/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 流式钉底决策回归测试（2026-08-21，日志 1787323320262「后期输出抖动严重」）。
 *
 * 这些断言的作用是把「什么情况下**不写** scrollTop」钉死 —— 不写是本次消除
 * layout thrashing 的核心手段，一旦后续重构让它退回「每帧总是写」，抖动会立刻复现
 * 而单测能当场抓到。
 */

import assert from 'assert';
import {
	decidePinScrollTop, needsPinPass,
	PIN_BOTTOM_EPSILON, PIN_USER_SCROLL_GRACE_MS, PIN_RESTORE_JUMP_THRESHOLD,
	type IPinState,
} from '../../../../browser/agentChat/streamPinDecision.js';

const pinned = (over: Partial<IPinState> = {}): IPinState =>
	({ pinned: true, lastUserTop: 0, lastUserScrollAt: 0, ...over });
const unpinned = (over: Partial<IPinState> = {}): IPinState =>
	({ pinned: false, lastUserTop: 0, lastUserScrollAt: 0, ...over });

suite('streamPinDecision — needsPinPass（干净帧零写入）', () => {

	test('内容未溢出 → 跳过（不可滚动无需钉底）', () => {
		assert.strictEqual(needsPinPass({ scrollHeight: 100, clientHeight: 100 }, undefined), false);
		assert.strictEqual(needsPinPass({ scrollHeight: 80, clientHeight: 100 }, undefined), false);
	});

	test('★ scrollHeight 与上帧相同 → 跳过（内容没长，本帧不该产生任何写入）', () => {
		assert.strictEqual(needsPinPass({ scrollHeight: 500, clientHeight: 100 }, 500), false,
			'这是消除每帧强制重排的关键判据');
	});

	test('scrollHeight 增长 → 需要处理', () => {
		assert.strictEqual(needsPinPass({ scrollHeight: 520, clientHeight: 100 }, 500), true);
	});

	test('首次见到该元素（无缓存）且可滚动 → 需要处理', () => {
		assert.strictEqual(needsPinPass({ scrollHeight: 500, clientHeight: 100 }, undefined), true);
	});

	test('内容缩短（如全量替换后变短）也算变化 → 需要处理', () => {
		assert.strictEqual(needsPinPass({ scrollHeight: 300, clientHeight: 100 }, 500), true);
	});
});

suite('streamPinDecision — decidePinScrollTop', () => {

	test('pinned 且未贴底 → 置底', () => {
		const top = decidePinScrollTop(
			{ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 }, pinned(), 10_000);
		assert.strictEqual(top, 1000);
	});

	test('★ pinned 且已贴底 → 不写（省掉一次布局失效）', () => {
		// distFromBottom = 1000 - 800 - 200 = 0
		const top = decidePinScrollTop(
			{ scrollHeight: 1000, clientHeight: 200, scrollTop: 800 }, pinned(), 10_000);
		assert.strictEqual(top, undefined);
	});

	test('pinned 且距底刚好等于容差 → 不写（边界含等号）', () => {
		const scrollTop = 1000 - 200 - PIN_BOTTOM_EPSILON;
		const top = decidePinScrollTop(
			{ scrollHeight: 1000, clientHeight: 200, scrollTop }, pinned(), 10_000);
		assert.strictEqual(top, undefined);
	});

	test('pinned 且距底刚好超过容差 → 置底', () => {
		const scrollTop = 1000 - 200 - PIN_BOTTOM_EPSILON - 1;
		const top = decidePinScrollTop(
			{ scrollHeight: 1000, clientHeight: 200, scrollTop }, pinned(), 10_000);
		assert.strictEqual(top, 1000);
	});

	test('★ 用户刚上滚（宽限期内）→ 不写，把滚动位置交还用户', () => {
		const now = 10_000;
		const top = decidePinScrollTop(
			{ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
			pinned({ lastUserScrollAt: now - (PIN_USER_SCROLL_GRACE_MS - 1) }),
			now);
		assert.strictEqual(top, undefined, '拖拽期间强制置底会导致「滚动条拖不动」');
	});

	test('宽限期已过 → 恢复置底跟随', () => {
		const now = 10_000;
		const top = decidePinScrollTop(
			{ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
			pinned({ lastUserScrollAt: now - PIN_USER_SCROLL_GRACE_MS }),
			now);
		assert.strictEqual(top, 1000);
	});

	test('非 pinned + scrollTop 大幅归零（replaceChildren）→ 恢复用户位置', () => {
		const top = decidePinScrollTop(
			{ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
			unpinned({ lastUserTop: 400 }),
			10_000);
		assert.strictEqual(top, 400);
	});

	test('★ 非 pinned + 正常拖拽小步增量 → 不写（绝不干扰用户拖动）', () => {
		const top = decidePinScrollTop(
			{ scrollHeight: 1000, clientHeight: 200, scrollTop: 400 - (PIN_RESTORE_JUMP_THRESHOLD - 1) },
			unpinned({ lastUserTop: 400 }),
			10_000);
		assert.strictEqual(top, undefined);
	});

	test('非 pinned + 向下滚动 → 不写', () => {
		const top = decidePinScrollTop(
			{ scrollHeight: 1000, clientHeight: 200, scrollTop: 600 },
			unpinned({ lastUserTop: 400 }),
			10_000);
		assert.strictEqual(top, undefined);
	});

	test('决策为纯函数：同输入同输出，且不依赖调用次数', () => {
		const m = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
		const s = pinned();
		const a = decidePinScrollTop(m, s, 10_000);
		const b = decidePinScrollTop(m, s, 10_000);
		assert.strictEqual(a, b);
		assert.strictEqual(a, 1000);
	});
});

suite('streamPinDecision — 抖动场景整体推演', () => {

	/**
	 * 复现日志场景：一条消息有 81 个可滚动工具卡，其中只有最后一个在增长。
	 * 修复前每个元素都会走「读→写→读」→ 约 81 次强制重排；
	 * 修复后只有真正增长的那个产生写入。
	 */
	test('★ 81 个卡片仅 1 个增长 → 只产生 1 次写入（修复前为 81 次）', () => {
		const CARD_COUNT = 81;
		const lastSeen = new Map<number, number>();
		// 首帧：全部首次见到，都会被处理并记录基线
		for (let i = 0; i < CARD_COUNT; i++) {
			assert.strictEqual(needsPinPass({ scrollHeight: 500, clientHeight: 100 }, lastSeen.get(i)), true);
			lastSeen.set(i, 500);
		}
		// 稳态帧：只有最后一个卡片内容增长
		let writes = 0;
		for (let i = 0; i < CARD_COUNT; i++) {
			const scrollHeight = i === CARD_COUNT - 1 ? 520 : 500;
			if (!needsPinPass({ scrollHeight, clientHeight: 100 }, lastSeen.get(i))) { continue; }
			lastSeen.set(i, scrollHeight);
			const top = decidePinScrollTop({ scrollHeight, clientHeight: 100, scrollTop: 0 }, pinned(), 10_000);
			if (top !== undefined) { writes++; }
		}
		assert.strictEqual(writes, 1, '每帧写入数必须与「增长的卡片数」成正比，而非与卡片总数成正比');
	});

	test('★ 完全没有内容变化的帧 → 零写入', () => {
		const lastSeen = new Map<number, number>();
		for (let i = 0; i < 40; i++) { lastSeen.set(i, 500); }
		let writes = 0;
		for (let i = 0; i < 40; i++) {
			if (!needsPinPass({ scrollHeight: 500, clientHeight: 100 }, lastSeen.get(i))) { continue; }
			writes++;
		}
		assert.strictEqual(writes, 0);
	});
});
