/*---------------------------------------------------------------------------------------------
 *  「计划 / 范式注册工具」退役契约（2026-09-21）
 *
 *  本文件原名 `planQueue.test.ts`，测的是 `planQueueRegistry`（turn 级执行队列句柄）的生命周期
 *  与 `plan_register` 工具 handler。两轮退役后：
 *    · 第一轮：`switch_paradigm` / `plan_register`（含其 `if (!isPiKernelEnabled())` 门控）正式退役；
 *    · 第二轮：`planQueueRegistry` **彻底下线** —— 它的唯一生产者就是被退役的那个工具，
 *      生产者消失后句柄再也无人写入（连同 UI 定制卡片一并删除）。
 *  故原「注册表生命周期」用例随机制一并删除（那 3 条断言的正是被删实现），
 *  只保留**反向契约**：这两个名字不得再被注册，注册表不得复活。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { registerCompatibilityTools, type CompatToolContext } from '../../browser/providers/tool/compatibilityTools.js';
import type { IBuiltinToolRegistration } from '../../browser/providers/tool/toolRegistry.js';

/**
 * 用 stub ctx 捕获 `registerCompatibilityTools` 注册的**全部**描述符。
 *
 * 2026-09-21：原名 `capturePlanRegisterTool`（只找 plan_register）—— 该工具退役后改为返回全量，
 * 供「退役契约」断言使用（既要有"不得再注册"，也要有"别把相邻工具一起误伤"）。
 */
function captureCompatibilityTools(): IBuiltinToolRegistration[] {
	const registrations: IBuiltinToolRegistration[] = [];
	const stubCtx: CompatToolContext = {
		register: (d) => { registrations.push(d); },
		agentOS: {} as CompatToolContext['agentOS'],
		fileService: {} as CompatToolContext['fileService'],
		logService: { info: () => { }, warn: () => { }, error: () => { } } as unknown as CompatToolContext['logService'],
		id: 'test.compat',
		resolveAndCheckWorkspacePath: async (_a, p) => p,
	};
	registerCompatibilityTools(stubCtx);
	return registrations;
}

suite('【已正式退役】switch_paradigm / plan_register（2026-09-21）', () => {

	test('★★★ 退役契约：registerCompatibilityTools 不得再注册这两个工具', () => {
		const names = captureCompatibilityTools().map(r => r.definition.name);
		assert.ok(!names.includes('plan_register'),
			'plan_register 已正式退役 —— 不得再注册（pi 内核自带有序任务队列；回归须按 pi 契约重新引入）✗');
		assert.ok(!names.includes('switch_paradigm'),
			'switch_paradigm 已正式退役 —— 不得再注册（pi 路径没有范式机制，注册等于空承诺）✗');
	});

	test('★ 退役不误伤：update_plan / patch / execute_code 等仍在注册', () => {
		const names = captureCompatibilityTools().map(r => r.definition.name);
		assert.ok(names.includes('update_plan'), 'update_plan 是软追踪工具，不属退役范围 ✗');
		assert.ok(names.includes('patch') && names.includes('execute_code'),
			'退役不得影响其余 compat 工具 ✗');
	});

	test('★★★ 机制契约：planQueueRegistry 已彻底下线（生产者消失 ⇒ 不得复活）', () => {
		// 为什么单独立一条：这个注册表是「工具 → 本 turn 队列」的桥。工具退役后它没有任何生产者，
		// 留着只会让后来者以为它还是活的（上一轮我就是这么判断失误的）。要重新引入，
		// 应按 **pi 契约**（工具 schema + 事件）接线，而不是恢复一个 module 级注册表。
		const registry = path.join(process.cwd(),
			'src/vs/sessions/contrib/agentStudio/common/planQueueRegistry.ts');
		assert.ok(!fs.existsSync(registry),
			'planQueueRegistry.ts 已删除 —— 不得复活（turn 队列已无生产者）✗');
		const executor = fs.readFileSync(path.join(process.cwd(),
			'src/vs/sessions/contrib/agentStudio/browser/agentTurnExecutor.ts'), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		assert.ok(!executor.includes('registerPlanQueueHandle'),
			'executor 不得再注册队列句柄（那会与已下线的机制重复）✗');
	});
});
