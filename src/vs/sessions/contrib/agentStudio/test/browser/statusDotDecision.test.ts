/*---------------------------------------------------------------------------------------------
 *  statusDotDecision.test.ts — agent 状态圆点决策的回归测试。
 *
 *  背景：聊天框 agent 头像右下角圆点由 `emp.status` 决定，该字段此前全仓无人回写
 *  （只在 agent 定义初始化时赋值），圆点恒为灰色「空闲」。修复方案：发送链路开始置
 *  working、finally（含异常/取消路径）复归 idle。
 *
 *  运行方式:
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/statusDotDecision.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { AgentStatus } from '../../../browser/agentChat/agentChatTypes.js';
import { didAgentStatusChange, resolveSendPhaseStatus } from '../../../browser/agentChat/statusDotDecision.js';

suite('Agent 状态圆点决策', () => {
});
