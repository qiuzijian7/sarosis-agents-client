/*---------------------------------------------------------------------------------------------
 *  Unit test: 聊天卡「节点是否出现」的唯一规则表（2026-09-13 质量评估 P2-6）。
 *
 *  背景：该规则此前分散在 `workflowExecutionService` 的 5 处调用点，各处各写一遍，
 *  已出现漂移（catch 分支漏掉 FLOW 筛选 → 非 FLOW 节点的 subagent_end 被静默丢弃 ✗）。
 *  收敛到 `workflow/cardVisibility.ts` 后，本测试锁定两个维度的语义。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	CARD_EXCLUDED_NODE_TYPES,
	CARD_TEXT_LIMITS,
	isCardEligibleNodeType,
	isNodeVisibleOnCard,
} from '../../browser/workflow/cardVisibility.js';

suite('聊天卡可见性规则（cardVisibility）', () => {

	suite('isCardEligibleNodeType（类型维度）', () => {

		test('★ 排除集恰好是 Agent / Start / AskUser 三个字面量', () => {
			// ⚠ 用字面量而非 `WorkflowNodeType` 枚举：它是 **const enum**（定义于
			//   common/workflowStorage.ts），esbuild 无法跨文件在运行时引用（测试 runner
			//   用 esbuild）→ 本断言与 `cardVisibility.ts` 的注释共同锁定取值一致性。
			assert.strictEqual(CARD_EXCLUDED_NODE_TYPES.size, 3, '排除集应恰好 3 项');
			assert.deepStrictEqual(
				[...CARD_EXCLUDED_NODE_TYPES].sort(),
				['agent', 'askUser', 'start'],
			);
		});

		test('Agent / Start / AskUser → 不出卡（各有专属展示通道）', () => {
			assert.strictEqual(isCardEligibleNodeType('agent'), false);
			assert.strictEqual(isCardEligibleNodeType('start'), false);
			assert.strictEqual(isCardEligibleNodeType('askUser'), false);
		});

		test('业务节点 → 可出卡（comfyStage / script / end / prompt）', () => {
			for (const t of ['comfyStage', 'script', 'end', 'prompt', 'ifElse', 'comfy']) {
				assert.strictEqual(isCardEligibleNodeType(t), true, `${t} 应可出卡`);
			}
		});

		test('undefined / 空串 → 不出卡（无类型信息时不猜）', () => {
			assert.strictEqual(isCardEligibleNodeType(undefined), false);
			assert.strictEqual(isCardEligibleNodeType(''), false);
		});
	});

	suite('isNodeVisibleOnCard（类型 + FLOW 链）', () => {

		const flowConns = [{ from: 'a', to: 'b', fromPort: 'flowOut', toPort: 'flowIn' }];
		const dataConns = [{ from: 'x', to: 'y', fromPort: 'images', toPort: 'images' }];

		test('FLOW 链上的业务节点 → 出卡', () => {
			assert.strictEqual(isNodeVisibleOnCard(flowConns, { id: 'a', type: 'comfyStage' }), true);
			assert.strictEqual(isNodeVisibleOnCard(flowConns, { id: 'b', type: 'comfyStage' }), true);
		});

		test('★ 类型排除优先于 FLOW 链（排除类型即使在 FLOW 链上也不出卡）', () => {
			assert.strictEqual(isNodeVisibleOnCard(flowConns, { id: 'a', type: 'agent' }), false);
			assert.strictEqual(isNodeVisibleOnCard(flowConns, { id: 'b', type: 'askUser' }), false);
			assert.strictEqual(isNodeVisibleOnCard(flowConns, { id: 'b', type: 'start' }), false);
		});

		test('★ 数据连线上的辅助节点 → 不出卡（loader / picker 不占阶段位）', () => {
			assert.strictEqual(isNodeVisibleOnCard(dataConns, { id: 'x', type: 'comfyStage' }), false);
			assert.strictEqual(isNodeVisibleOnCard(dataConns, { id: 'y', type: 'comfyStage' }), false);
		});

		test('★ 端口名缺失（旧工作流）→ 保守视为 FLOW（宁多显示，不误隐藏）', () => {
			const legacy = [{ from: 'p', to: 'q' }];
			assert.strictEqual(isNodeVisibleOnCard(legacy, { id: 'p', type: 'comfyStage' }), true);
			assert.strictEqual(isNodeVisibleOnCard(legacy, { id: 'q', type: 'comfyStage' }), true);
		});

		test('无连接 / undefined → 不出卡（与既有 isNodeOnFlowChain 语义一致，行为不变）', () => {
			assert.strictEqual(isNodeVisibleOnCard([], { id: 'a', type: 'comfyStage' }), false);
			assert.strictEqual(isNodeVisibleOnCard(undefined, { id: 'a', type: 'comfyStage' }), false);
		});
	});

	suite('CARD_TEXT_LIMITS（文本长度上限，P2-5）', () => {

		test('★ 四档语义上限（值锁定：改值需同步评估卡片布局）', () => {
			assert.strictEqual(CARD_TEXT_LIMITS.subtitle, 200);
			assert.strictEqual(CARD_TEXT_LIMITS.nodeOutput, 400);
			assert.strictEqual(CARD_TEXT_LIMITS.orchestrationOutput, 2000);
			assert.strictEqual(CARD_TEXT_LIMITS.agentOutput, 4000);
		});

		test('★ 上限关系合理：副标题 < 节点输出 < 编排输出 < Agent 输出', () => {
			// 副标题只有一行（最少）；Agent 输出是自然语言（最多余量）。
			assert.ok(CARD_TEXT_LIMITS.subtitle < CARD_TEXT_LIMITS.nodeOutput);
			assert.ok(CARD_TEXT_LIMITS.nodeOutput < CARD_TEXT_LIMITS.orchestrationOutput);
			assert.ok(CARD_TEXT_LIMITS.orchestrationOutput < CARD_TEXT_LIMITS.agentOutput);
		});

		test('冻结（防运行时误改）', () => {
			assert.strictEqual(Object.isFrozen(CARD_TEXT_LIMITS), true);
		});
	});
});
