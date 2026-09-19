/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 回归测试：流式 delta 的会话归属判定（`shouldAcceptStreamDelta`）。
 *
 * 背景事故（同类缺陷已复发两次，此前无任何测试覆盖）：
 *  - 2026-08-08 日志 1786178468122：两个同 agent 不同 session 的 pane 并发时，
 *    A pane 渲染出 B 会话的 LLM 输出（串台）。当时加的守卫是「会话不同则一律忽略」。
 *  - 2026-08-29 日志 20260829T232635：新建聊天窗口 Pane#2 发消息后，LLM 侧完全正常
 *    （ToolAudit iters=10、STREAM_END text=229），但 UI 一条都不显示。
 *  - 2026-09-18（本次）：同一 agent 不同 session，新开窗口不显示 LLM 返回。
 *    根因与上一条相同 —— pane 初始化会自动把 `_currentSessionId` 绑定为
 *    `sessions[0].id`，于是「刚打开、用户还没用」的空壳 pane 也命中「会话不同则忽略」，
 *    把别的 session 的流式 delta 全数静默丢弃；且该 return 位于所有日志打点之前，
 *    现象是「LLM 正常输出 + 界面全白 + 零日志」。
 *
 * 修复原则：区分「用户已占用的 pane」与「只是打开着的空壳 pane」——
 * 前者维持忽略（防串台），后者允许接管并切换会话（多窗口实时同步）。
 */

import * as assert from 'assert';
import { shouldAcceptStreamDelta, shouldReloadAfterPanelSwap } from '../../common/streamDeltaGuards.js';

suite('StreamDeltaSessionGuard — 流式 delta 会话归属判定', () => {

	suite('空壳 pane（用户从未使用）', () => {

		test('★ 回归：新开窗口绑定 sessions[0]、另有会话在流式 → 必须放行（否则界面全白）', () => {
			// pane 初始化自动绑定了 session-A（sessions[0].id），但用户从未使用；
			// 此时 session-B 正在流式输出 → 空壳 pane 应接管，而不是静默丢弃。
			const accepted = shouldAcceptStreamDelta(
				'session-B',   // 广播 delta 所属会话
				'session-A',   // 本 pane 自动绑定的会话
				false,         // 尚未被用户占用
			);
			assert.strictEqual(
				accepted, true,
				'空壳 pane 必须接受其它会话的流，否则「新开窗口不显示 LLM 返回」会复现',
			);
		});

		test('未绑定会话的空壳 pane → 放行（看板任务在空闲 pane 上显示执行流）', () => {
			assert.strictEqual(shouldAcceptStreamDelta('session-B', null, false), true);
			assert.strictEqual(shouldAcceptStreamDelta('session-B', '', false), true);
		});

		test('同一会话 → 放行（多窗口实时同步同一流）', () => {
			assert.strictEqual(shouldAcceptStreamDelta('session-A', 'session-A', false), true);
		});

	});

	suite('已被用户占用的 pane', () => {

		test('★ 串台防护：用户已占用的 pane 收到其它会话的流 → 必须忽略', () => {
			// 用户在 session-A 里正在对话；session-B 的流广播过来必须被丢弃，
			// 否则 A 会话聊天框会渲染出 B 的内容（2026-08-08 串台事故）。
			const accepted = shouldAcceptStreamDelta('session-B', 'session-A', true);
			assert.strictEqual(
				accepted, false,
				'已被用户占用的 pane 必须拒绝其它会话的流，否则会串台',
			);
		});

		test('已被用户占用但收到自身会话的流 → 仍放行', () => {
			assert.strictEqual(shouldAcceptStreamDelta('session-A', 'session-A', true), true);
		});

		test('已占用且未绑定会话 → 放行（边界：占用标志不应凌驾于「无绑定」之上）', () => {
			assert.strictEqual(shouldAcceptStreamDelta('session-A', null, true), true);
		});

	});

	suite('无会话归属的广播', () => {

		test('sessionId 为空串 / null / undefined → 放行（全局 delta 不受会话绑定约束）', () => {
			assert.strictEqual(shouldAcceptStreamDelta('', 'session-A', true), true);
			assert.strictEqual(shouldAcceptStreamDelta(null, 'session-A', true), true);
			assert.strictEqual(shouldAcceptStreamDelta(undefined, 'session-A', true), true);
			assert.strictEqual(shouldAcceptStreamDelta(null, null, false), true);
		});

	});

	suite('判定矩阵（全量组合）', () => {

		test('覆盖所有 (广播会话 × pane 会话 × 占用标志) 组合', () => {
			const cases: Array<{
				broadcast: string | null;
				pane: string | null;
				claimed: boolean;
				expected: boolean;
				why: string;
			}> = [
				{ broadcast: 'A', pane: 'A', claimed: true, expected: true, why: '同会话同步' },
				{ broadcast: 'A', pane: 'A', claimed: false, expected: true, why: '同会话同步' },
				{ broadcast: 'B', pane: 'A', claimed: true, expected: false, why: '已占用 → 防串台' },
				{ broadcast: 'B', pane: 'A', claimed: false, expected: true, why: '空壳 → 接管' },
				{ broadcast: 'A', pane: null, claimed: true, expected: true, why: '未绑定 → 接管' },
				{ broadcast: 'A', pane: null, claimed: false, expected: true, why: '未绑定 → 接管' },
				{ broadcast: null, pane: 'A', claimed: true, expected: true, why: '全局 delta' },
				{ broadcast: null, pane: 'A', claimed: false, expected: true, why: '全局 delta' },
			];

			for (const c of cases) {
				assert.strictEqual(
					shouldAcceptStreamDelta(c.broadcast, c.pane, c.claimed),
					c.expected,
					`broadcast=${c.broadcast} pane=${c.pane} claimed=${c.claimed} → 期望 ${c.expected}（${c.why}）`,
				);
			}
		});

	});

	suite('面板重建后的重载判定（shouldReloadAfterPanelSwap）', () => {

		test('★ 回归：已绑定 agent → 必须重载（否则历史消息写进已销毁的旧面板，界面全白）', () => {
			// setInput 先发起异步 _selectAndLoadAgent，再同步 _syncPanelType 重建面板。
			// 若不重载，在途调用的 setMessages 会落到 dispose() 掉的旧面板上，
			// 新面板永远空白 —— 连用户自己的消息气泡都不渲染。
			assert.strictEqual(
				shouldReloadAfterPanelSwap('vssaros-dev-expert'), true,
				'面板重建后必须重新加载，否则「新开窗口整片空白」会复现',
			);
		});

		test('无 agent → 不重载（无历史可加载，避免空转一次 getHistory）', () => {
			assert.strictEqual(shouldReloadAfterPanelSwap(null), false);
			assert.strictEqual(shouldReloadAfterPanelSwap(undefined), false);
		});

		test('空串 agentId → 不重载（视为未绑定，与 null 同等处理）', () => {
			assert.strictEqual(shouldReloadAfterPanelSwap(''), false);
		});

	});

});
