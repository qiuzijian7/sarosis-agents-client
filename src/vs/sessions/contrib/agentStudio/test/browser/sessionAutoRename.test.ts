/*---------------------------------------------------------------------------------------------
 *  sessionAutoRename.test.ts — 「首条消息自动命名」守卫测试。
 *
 *  回归目标：用户重命名 session 后，名字不应被自动命名覆盖（侧边栏表现为
 *  「item 里显示的名字又被自动刷新回消息内容」）。
 *
 *  根因：自动命名（会话名 = 首条消息前 30 字符）原本只按「是否已有历史消息」
 *  判断，而用户重命名与「发出首条消息」之间没有互斥 —— 对一个空会话先改名
 *  再发首条消息，自动命名就会命中并把用户的名字覆盖掉。
 *
 *  修复：新增 `nameIsCustom` 标志位，自动命名前必须让路（shouldAutoRenameSession）。
 *
 *  运行方式:
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/sessionAutoRename.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { shouldAutoRenameSession } from '../../browser/agentChatService.js';
import { AgentStatus } from '../../../../browser/agentChat/agentChatTypes.js';
import { didAgentStatusChange, resolveSendPhaseStatus } from '../../../../browser/agentChat/statusDotDecision.js';

suite('Session 自动命名守卫（用户重命名不被覆盖）', () => {

	test('★ 回归：用户已手动命名（空会话）→ 不得自动命名覆盖', () => {
		assert.strictEqual(shouldAutoRenameSession(true, 0), false);
	});

	test('★ 回归：用户已手动命名（已有历史）→ 同样不得覆盖', () => {
		assert.strictEqual(shouldAutoRenameSession(true, 5), false);
	});

	test('用户未命名 + 空会话 → 允许自动命名（保留原有便捷行为）', () => {
		assert.strictEqual(shouldAutoRenameSession(false, 0), true);
	});

	test('用户未命名 + 已有历史 → 不自动命名（仅首条消息才取名）', () => {
		assert.strictEqual(shouldAutoRenameSession(false, 1), false);
		assert.strictEqual(shouldAutoRenameSession(false, 42), false);
	});

	test('全量组合矩阵：nameIsCustom 为真时任何 historyLength 都不自动命名', () => {
		for (const historyLength of [0, 1, 2, 99]) {
			assert.strictEqual(shouldAutoRenameSession(true, historyLength), false);
		}
	});
});

suite('Agent 状态圆点决策（status 字段回写）', () => {

	suite('resolveSendPhaseStatus — 发送链路映射', () => {

		test('★ 发送中 → Working（圆点转绿）', () => {
			assert.strictEqual(resolveSendPhaseStatus(true), AgentStatus.Working);
		});

		test('★ 非发送中 → Idle（圆点转回灰）', () => {
			assert.strictEqual(resolveSendPhaseStatus(false), AgentStatus.Idle);
		});

		test('只有两个返回值：不产生 Thinking / Error（产品决策）', () => {
			const outputs = [resolveSendPhaseStatus(true), resolveSendPhaseStatus(false)];
			assert.ok(!outputs.includes(AgentStatus.Thinking));
			assert.ok(!outputs.includes(AgentStatus.Error));
			for (const status of outputs) {
				assert.ok(
					status === AgentStatus.Working || status === AgentStatus.Idle,
					`不应返回 ${status}`,
				);
			}
		});
	});

	suite('didAgentStatusChange — 幂等守卫', () => {

		test('同状态 → false（避免每次发送都无谓写 DOM）', () => {
			assert.strictEqual(didAgentStatusChange(AgentStatus.Idle, AgentStatus.Idle), false);
			assert.strictEqual(didAgentStatusChange(AgentStatus.Working, AgentStatus.Working), false);
		});

		test('★ 状态真变化 → true（发送/结束必须触发重绘）', () => {
			assert.strictEqual(didAgentStatusChange(AgentStatus.Idle, AgentStatus.Working), true);
			assert.strictEqual(didAgentStatusChange(AgentStatus.Working, AgentStatus.Idle), true);
		});

		test('★ undefined 归一为 Idle：旧数据不触发无谓重绘', () => {
			// agent 实体上 status 可能缺失（旧数据 / 自定义 agent 未声明），
			// 视觉上与 Idle 等价，不应判为变化。
			assert.strictEqual(didAgentStatusChange(undefined, AgentStatus.Idle), false);
		});

		test('undefined → Working 仍算变化', () => {
			assert.strictEqual(didAgentStatusChange(undefined, AgentStatus.Working), true);
		});

		test('★ 发送→结束完整往返恰好两次变化，且收尾必回 Idle', () => {
			let status: AgentStatus | undefined = AgentStatus.Idle;
			let changes = 0;
			const apply = (next: AgentStatus): void => {
				if (didAgentStatusChange(status, next)) { changes++; }
				status = next;
			};

			apply(resolveSendPhaseStatus(true));   // 开始发送
			apply(resolveSendPhaseStatus(false));  // finally 收尾

			assert.strictEqual(changes, 2, '应为 working / idle 各触发一次');
			assert.strictEqual(status, AgentStatus.Idle, '收尾后必须回到 Idle');
		});

		test('发送中重复 setAgentStatus(working) 不再产生变化（配对安全性）', () => {
			let status: AgentStatus | undefined = AgentStatus.Working;
			let changes = 0;
			const apply = (next: AgentStatus): void => {
				if (didAgentStatusChange(status, next)) { changes++; }
				status = next;
			};

			apply(resolveSendPhaseStatus(true));
			apply(resolveSendPhaseStatus(true));

			assert.strictEqual(changes, 0, '已是 working 时不应重复触发');
		});
	});
});
