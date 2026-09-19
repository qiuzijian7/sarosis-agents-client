/*---------------------------------------------------------------------------------------------
 *  statusDotDecision.test.ts — agent 状态圆点决策的回归测试。
 *
 *  背景：聊天框 agent 头像右下角圆点由 `emp.status` 决定，而该字段此前全仓
 *  无人回写（只在 agent 定义初始化时赋值），圆点恒为灰色「空闲」。
 *  修复方案：发送链路开始置 working、finally（含异常/取消路径）复归 idle。
 *
 *  本测试锁定两条契约：
 *   ① 状态映射只有 working / idle 两态（产品决策：不做 thinking/error 细分）；
 *   ② 幂等守卫，含 undefined 归一（旧数据/自定义 agent 未声明 status）。
 *
 *  运行方式:
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/browser/agentChat/statusDotDecision.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { AgentStatus } from './agentChatTypes.js';
import {
	didAgentStatusChange,
	resolveSendPhaseStatus,
} from './statusDotDecision.js';

suite('Agent 状态圆点决策', () => {

	suite('resolveSendPhaseStatus — 发送链路映射', () => {

		test('★ 发送中 → Working（圆点转绿）', () => {
			assert.strictEqual(resolveSendPhaseStatus(true), AgentStatus.Working);
		});

		test('★ 非发送中 → Idle（圆点转回灰）', () => {
			assert.strictEqual(resolveSendPhaseStatus(false), AgentStatus.Idle);
		});

		test('只有两个返回值：不产生 Thinking / Error（产品决策）', () => {
			const outputs = [resolveSendPhaseStatus(true), resolveSendPhaseStatus(false)];
			for (const status of outputs) {
				assert.ok(
					status === AgentStatus.Working || status === AgentStatus.Idle,
					`不应返回 ${status}`,
				);
			}
			assert.ok(!outputs.includes(AgentStatus.Thinking));
			assert.ok(!outputs.includes(AgentStatus.Error));
		});

		test('幂等：同一输入恒返回同一结果（发送/结束配对的基础）', () => {
			assert.strictEqual(resolveSendPhaseStatus(true), resolveSendPhaseStatus(true));
			assert.strictEqual(resolveSendPhaseStatus(false), resolveSendPhaseStatus(false));
		});
	});

	suite('didAgentStatusChange — 幂等守卫', () => {

		test('同状态 → false（避免每次发送都无谓写 DOM）', () => {
			assert.strictEqual(
				didAgentStatusChange(AgentStatus.Idle, AgentStatus.Idle),
				false,
			);
			assert.strictEqual(
				didAgentStatusChange(AgentStatus.Working, AgentStatus.Working),
				false,
			);
		});

		test('★ 状态真变化 → true（发送/结束必须触发重绘）', () => {
			assert.strictEqual(
				didAgentStatusChange(AgentStatus.Idle, AgentStatus.Working),
				true,
			);
			assert.strictEqual(
				didAgentStatusChange(AgentStatus.Working, AgentStatus.Idle),
				true,
			);
		});

		test('★ undefined 归一为 Idle：旧数据不触发无谓重绘', () => {
			// agent 实体上 status 可能缺失（旧数据 / 自定义 agent 未声明），
			// 视觉上与 Idle 等价，不应判为变化。
			assert.strictEqual(
				didAgentStatusChange(undefined, AgentStatus.Idle),
				false,
			);
		});

		test('undefined → Working 仍算变化', () => {
			assert.strictEqual(
				didAgentStatusChange(undefined, AgentStatus.Working),
				true,
			);
		});

		test('发送→结束的完整往返序列恰好产生两次变化', () => {
			// 模拟一次发送：idle → working → idle
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

		test('发送中重复调用 setAgentStatus(working) 不再产生变化（配对安全性）', () => {
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
