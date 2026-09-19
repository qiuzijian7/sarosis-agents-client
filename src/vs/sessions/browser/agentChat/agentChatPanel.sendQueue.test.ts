/*---------------------------------------------------------------------------------------------
 *  agentChatPanel.sendQueue.test.ts — 发送时的排队判定测试。
 *
 *  回归目标：「流式进行中快速连打两条消息时，第二条打断第一条」。
 *
 *  根因：面板层的 `_isSending` 是 UI 状态，会在 `cancelStream()` 之后立即复位，
 *  而底层流要到下一次 `for await` 迭代才 break、`finally` 才收尾。这段窗口期内
 *  `_isSending === false` 但流仍在跑 —— 只按 `_isSending` 判定就会漏判「应排队」，
 *  第二条消息直接走发送路径并再次 cancelStream，把未收尾的第一条打断。
 *
 *  修复：判定改为「UI 状态 or 服务层有活跃流」（shouldQueueOutgoingMessage）。
 *
 *  运行方式:
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/browser/agentChat/agentChatPanel.sendQueue.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { shouldQueueOutgoingMessage } from './agentChatPanel.send.js';

suite('AgentChatPanelSend — 发送排队判定（连发打断回归）', () => {

	test('★ 回归：_isSending=false 但服务层仍有活跃流 → 必须排队（否则第二条打断第一条）', () => {
		// 这正是竞态窗口：cancelStream 已把 UI 复位，但旧流还没跑完 finally。
		// 修复前只看 _isSending（false）→ 不排队 → 直接发送 → 打断第一条。
		assert.strictEqual(
			shouldQueueOutgoingMessage(false, () => true),
			true,
		);
	});

	test('_isSending=true → 排队（无论服务层如何回答）', () => {
		assert.strictEqual(shouldQueueOutgoingMessage(true, () => true), true);
		assert.strictEqual(shouldQueueOutgoingMessage(true, () => false), true);
	});

	test('_isSending=true 且未接入服务层 → 仍排队（回退路径不弱化原有行为）', () => {
		assert.strictEqual(shouldQueueOutgoingMessage(true, undefined), true);
	});

	test('干净空闲（UI 未发送 + 服务层无活跃流）→ 不排队，直接发送', () => {
		assert.strictEqual(
			shouldQueueOutgoingMessage(false, () => false),
			false,
		);
	});

	test('未接入服务层（回调缺省）+ 空闲 → 只按 UI 状态判定', () => {
		assert.strictEqual(shouldQueueOutgoingMessage(false, undefined), false);
	});

	test('服务层回调抛错时不应吞掉异常语义（由调用方负责，这里锁定返回布尔契约）', () => {
		// 契约：正常路径必须返回布尔；这里显式验证 true/false 两态均被如实透传。
		const answers = [true, false, true];
		let callIndex = 0;
		const isStreamActive = (): boolean => answers[callIndex++];

		assert.strictEqual(shouldQueueOutgoingMessage(false, isStreamActive), true);
		assert.strictEqual(shouldQueueOutgoingMessage(false, isStreamActive), false);
		assert.strictEqual(shouldQueueOutgoingMessage(false, isStreamActive), true);
		assert.strictEqual(callIndex, 3, '每次判定应恰好查询一次服务层');
	});

	test('_isSending=true 时短路：不应查询服务层', () => {
		let queried = false;
		const isStreamActive = (): boolean => {
			queried = true;
			return true;
		};

		assert.strictEqual(shouldQueueOutgoingMessage(true, isStreamActive), true);
		assert.strictEqual(queried, false, 'UI 已知在发送时不必要地查询服务层');
	});
});
