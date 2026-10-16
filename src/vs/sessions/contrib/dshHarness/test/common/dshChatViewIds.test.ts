/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DshChatViewAllocator } from '../../common/dshChatViewIds.js';

suite('dshChatViewIds（同一聊天多开时的视图 id 仲裁）', () => {
	const A = {};
	const B = {};
	const C = {};

	test('单 pane 认领与复用主 id', () => {
		const a = new DshChatViewAllocator();
		assert.strictEqual(a.claim('dsh-chat-w1-default', A), 'dsh-chat-w1-default');
		assert.strictEqual(a.claim('dsh-chat-w1-default', A), 'dsh-chat-w1-default');
	});

	test('第二个在场 pane 拿到后缀 id，双方互不干扰', () => {
		const a = new DshChatViewAllocator();
		const vA = a.claim('dsh-chat-w1-c1', A);
		a.notePresent(vA, A);
		const vB = a.claim('dsh-chat-w1-c1', B);
		assert.strictEqual(vB, 'dsh-chat-w1-c1-2');
		a.notePresent(vB, B);
		const vC = a.claim('dsh-chat-w1-c1', C);
		assert.strictEqual(vC, 'dsh-chat-w1-c1-3');
		// 复认自己持有的 id
		assert.strictEqual(a.claim('dsh-chat-w1-c1', B), 'dsh-chat-w1-c1-2');
	});

	test('占用方离场后主 id 可被新 pane 认领；被抢占者下次在场时改配', () => {
		const a = new DshChatViewAllocator();
		const vA = a.claim('dsh-chat-w1-c1', A);
		a.notePresent(vA, A);
		a.clearPresent(vA, A); // A 隐藏
		// B（隐藏中）认领：主 id 没有被在场占用 → B 拿主 id
		const vB = a.claim('dsh-chat-w1-c1', B);
		assert.strictEqual(vB, 'dsh-chat-w1-c1');
		a.notePresent(vB, B);
		// A 重新在场：持有的主 id 被 B 在场占用 → A 改配后缀
		const vA2 = a.claim('dsh-chat-w1-c1', A);
		assert.strictEqual(vA2, 'dsh-chat-w1-c1-2');
	});

	test('释放销毁全部认领并清空在场状态', () => {
		const a = new DshChatViewAllocator();
		const v1 = a.claim('dsh-chat-w1-c1', A);
		const v2 = a.claim('dsh-chat-w1-c2', A);
		a.notePresent(v1, A);
		const freed = a.release(A);
		assert.deepStrictEqual([...freed].sort(), [v1, v2].sort());
		assert.strictEqual(a.presentHolder(v1), undefined);
		// 释放后别人可拿主 id
		assert.strictEqual(a.claim('dsh-chat-w1-c1', B), 'dsh-chat-w1-c1');
		// 重复释放为空
		assert.deepStrictEqual(a.release(A), []);
	});

	test('clearPresent 只清自己的在场记录', () => {
		const a = new DshChatViewAllocator();
		const vA = a.claim('dsh-chat-w1-c1', A);
		a.notePresent(vA, A);
		a.clearPresent(vA, B); // B 无权清 A 的在场
		assert.strictEqual(a.presentHolder(vA), A);
		a.clearPresent(vA, A);
		assert.strictEqual(a.presentHolder(vA), undefined);
	});
});
