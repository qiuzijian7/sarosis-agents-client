/*---------------------------------------------------------------------------------------------
 *  Plan 专属工具门控契约测试.
 *
 *  ## 为什么需要这个文件
 *
 *  `plan_enter` / `plan_exit` / `plan_explore` 原先挂在 core toolset
 *  （`ToolsetPriority.Always`）→ **所有 ChatMode 下都对 LLM 可见**。
 *  后果（日志 1787294819356 实证）：用户在普通模式下提问，模型自行探索 23 轮后
 *  调用 `plan_enter` 转入规划 —— 用户从未要求过，模式选择形同虚设。
 *
 *  修复方式是 `filterPlanExclusiveTools`（`chatModeConfig.ts:837`），
 *  调用点唯一：`agentTurnExecutor.ts:798`。在 `filterToolsByChatMode`
 *  已不再过滤工具（MiMo alignment）之后，**这个函数是 plan 专属工具门控的
 *  唯一防线** —— 它一旦失效，模型会在任何模式下自主进 plan。
 *
 *  此前零测试覆盖（`grep -r filterPlanExclusiveTools test/` 无命中）。
 *
 *  ## 本文件锁死的不变量
 *
 *   1. 非 plan 模式必须移除全部三个 plan 专属工具。
 *   2. plan 模式必须**一个不少**（漏放行 = plan 模式无法进退）。
 *   3. 大小写不敏感 —— 工具名来自模型/配置，大小写漂移不该导致门控失效。
 *   4. 不得误伤通用工具 —— `update_plan` / `plan_register` 名字里带 "plan"
 *      但任何模式都可用（`chatModeConfig.ts:807-810` 明确警示过），
 *      误收会削弱 craft/ask 模式的正常能力。
 *
 *  ## 运行方式（自仓库根）
 *
 *      node src/vs/sessions/contrib/agentStudio/test/common/run-planExclusiveTools-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';

import {
	PLAN_EXCLUSIVE_TOOLS,
	filterPlanExclusiveTools,
	isPlanExclusiveTool,
} from '../../common/chatModeConfig.js';

const tool = (name: string) => ({ name });

/** 一个贴近真实 enabledTools 的样本：plan 专属 + 通用工具混排。 */
const sampleTools = () => [
	tool('plan_enter'),
	tool('read_file'),
	tool('plan_exit'),
	tool('update_plan'),   // 名字含 plan，但**不是** plan 专属
	tool('plan_explore'),
	tool('plan_register'), // 同上
	tool('file_write'),
];

const namesOf = (tools: ReadonlyArray<{ name: string }>) => tools.map(t => t.name);

suite('filterPlanExclusiveTools — plan 专属工具门控', () => {

	test('非 plan 模式移除全部 plan 专属工具', () => {
		// craft 是普通模式的默认档：模型在此若能看到 plan_enter，就会重现
		// 「用户没要求、模型自主进 plan」的原始缺陷。
		const result = filterPlanExclusiveTools(sampleTools(), 'craft');
		for (const exclusive of PLAN_EXCLUSIVE_TOOLS) {
			assert.ok(
				!namesOf(result).includes(exclusive),
				`craft 模式下 ${exclusive} 必须不可见（实际仍在，模型可自主进 plan）`,
			);
		}
	});

	test('ask / workflow / undefined 模式同样移除', () => {
		// chatMode 缺省（undefined）是真实存在的路径 —— `agentTurnExecutor.ts:801`
		// 的日志模板就带 `chatMode ?? 'unset'` 兜底。缺省时**必须**按非 plan 处理，
		// 否则「未指定」会静默变成「放开全部限制」。
		for (const mode of ['ask', 'workflow', undefined]) {
			const result = filterPlanExclusiveTools(sampleTools(), mode);
			for (const exclusive of PLAN_EXCLUSIVE_TOOLS) {
				assert.ok(
					!namesOf(result).includes(exclusive),
					`chatMode=${String(mode)} 下 ${exclusive} 必须不可见`,
				);
			}
		}
	});

	test('plan 模式一个不少地放行', () => {
		// 反向失效模式：过滤过头会让 plan 模式连 plan_exit 都没有 →
		// 模型无法提交计划、无法退出 → 死锁在 plan WorkMode。
		const result = filterPlanExclusiveTools(sampleTools(), 'plan');
		assert.deepStrictEqual(
			namesOf(result), namesOf(sampleTools()),
			'plan 模式必须原样保留全部工具（含三个 plan 专属）',
		);
	});

	test('不得误伤通用工具：update_plan / plan_register 任何模式都保留', () => {
		// 这两个名字含 "plan" 但属于通用能力（`chatModeConfig.ts:807-810` 明确警示）。
		// 若实现改成 `name.includes('plan')` 之类的模糊匹配，本条立刻失败。
		for (const mode of ['craft', 'ask', 'plan', undefined]) {
			const result = namesOf(filterPlanExclusiveTools(sampleTools(), mode));
			assert.ok(result.includes('update_plan'), `chatMode=${String(mode)} 下 update_plan 必须保留`);
			assert.ok(result.includes('plan_register'), `chatMode=${String(mode)} 下 plan_register 必须保留`);
		}
	});

	test('返回新数组，不修改入参', () => {
		// 调用点 `agentTurnExecutor.ts:798` 直接赋值给 enabledTools；
		// 若实现就地 splice，会污染上游 ctx.enabledTools（同一数组被多处持有）。
		const input = sampleTools();
		const snapshot = namesOf(input);
		const result = filterPlanExclusiveTools(input, 'craft');

		assert.notStrictEqual(result, input, '必须返回新数组而非原引用');
		assert.deepStrictEqual(namesOf(input), snapshot, '入参不得被修改');
	});

	test('空数组与全 plan 专属数组的边界', () => {
		assert.deepStrictEqual(filterPlanExclusiveTools([], 'craft'), []);
		assert.deepStrictEqual(filterPlanExclusiveTools([], 'plan'), []);

		// 全部被移除 → 空数组。此时必须仍能正常返回（不能抛异常），
		// 因为 :798 之后还有 chatOnly / trivialRequest 等后续过滤依赖它。
		const allExclusive = [tool('plan_enter'), tool('plan_exit'), tool('plan_explore')];
		assert.deepStrictEqual(filterPlanExclusiveTools(allExclusive, 'craft'), []);
		assert.strictEqual(filterPlanExclusiveTools(allExclusive, 'plan').length, 3);
	});

	test('isPlanExclusiveTool 大小写不敏感', () => {
		// 工具名可能来自模型输出或外部配置，大小写漂移不该让门控失效。
		assert.strictEqual(isPlanExclusiveTool('plan_enter'), true);
		assert.strictEqual(isPlanExclusiveTool('PLAN_ENTER'), true);
		assert.strictEqual(isPlanExclusiveTool('Plan_Exit'), true);
		assert.strictEqual(isPlanExclusiveTool('read_file'), false);
		assert.strictEqual(isPlanExclusiveTool('update_plan'), false);
	});

	test('isPlanExclusiveTool 对空值返回 false 而非抛异常', () => {
		// 守卫顺序是 `!!toolName && ...`：若写成 `PLAN_EXCLUSIVE_TOOLS.has(toolName.toLowerCase())`，
		// 空串/undefined 会在 toLowerCase 处抛 TypeError。
		assert.strictEqual(isPlanExclusiveTool(''), false);
		assert.strictEqual(isPlanExclusiveTool(undefined as unknown as string), false);
		assert.strictEqual(isPlanExclusiveTool(null as unknown as string), false);
	});

	test('大小写漂移的工具名同样被过滤（与 isPlanExclusiveTool 同口径）', () => {
		// 两条判据必须同源：`isPlanExclusiveTool` 大小写不敏感，而 filter 若用
		// 精确 Set.has，会出现「单独判定说该过滤、批量过滤却放过」的分裂。
		const result = namesOf(filterPlanExclusiveTools(
			[tool('PLAN_ENTER'), tool('Plan_Exit'), tool('read_file')],
			'craft',
		));
		assert.deepStrictEqual(result, ['read_file'],
			'大小写漂移的 plan 专属工具必须与规范写法同样被过滤');
	});

	test('PLAN_EXCLUSIVE_TOOLS 恰好含三个工具，不多不少', () => {
		// 名单扩容是敏感操作：误加通用工具会静默削弱其它模式的能力。
		assert.deepStrictEqual(
			[...PLAN_EXCLUSIVE_TOOLS].sort(),
			['plan_enter', 'plan_exit', 'plan_explore'],
		);
	});

	test('过滤保持原有相对顺序', () => {
		// 顺序影响 prompt 前缀稳定性（prefix cache）。过滤后若顺序被打乱，
		// 每轮 prompt 前缀变化会导致缓存全部失效。
		const result = namesOf(filterPlanExclusiveTools(sampleTools(), 'craft'));
		assert.deepStrictEqual(result, ['read_file', 'update_plan', 'plan_register', 'file_write']);
	});
});
