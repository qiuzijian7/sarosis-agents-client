/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill 注入预算（纯函数层）测试 —— 2026-09-11 补齐「Skill 注入零预算」缺口。
 *
 * 背景：`resolveActivations` 此前不排序/不限量/不限字符，每轮把命中技能的**完整正文**
 * 全部注入；两个预算开关（`maxSkillsInPrompt` / `maxSkillsPromptChars`）是死常量。
 *
 * 本 suite 锁定三条不变量：
 *   ① **优先级**决定谁占预算（required > explicit > always > auto）
 *   ② **数量 / 字符双上限**任一超限即降级
 *   ③ **不丢弃** —— `full + summary` 恒等于候选数（预算不得静默吞技能，
 *      否则 `always` 的语义会被预算悄悄破坏）
 */

import assert from 'assert';
import {
	planSkillInjections, buildSkillBudgetNote, DEFAULT_SKILL_BUDGET,
	SKILL_PRIORITY_REQUIRED, SKILL_PRIORITY_EXPLICIT, SKILL_PRIORITY_ALWAYS, SKILL_PRIORITY_AUTO,
	type ISkillBudgetCandidate,
} from '../../common/skillInjectionBudget.js';

/** 构造候选（skill 只需 id/name，其余字段与本模块无关）。 */
function mk(id: string, priority: number, contentChars = 100): ISkillBudgetCandidate {
	return { skill: { id, name: id } as never, priority, contentChars };
}

suite('skillInjectionBudget', () => {

	test('★ 优先级：required > explicit > always > auto（超限者降级为摘要）', () => {
		const plan = planSkillInjections([
			mk('a-auto', SKILL_PRIORITY_AUTO),
			mk('b-always', SKILL_PRIORITY_ALWAYS),
			mk('c-explicit', SKILL_PRIORITY_EXPLICIT),
			mk('d-required', SKILL_PRIORITY_REQUIRED),
		], { maxFullSkills: 2, maxPromptChars: 1_000_000 });
		assert.deepStrictEqual(plan.full.map(s => s.id), ['d-required', 'c-explicit']);
		assert.deepStrictEqual(plan.summary.map(s => s.id), ['b-always', 'a-auto']);
	});

	test('★ 字符预算：数量未超、字符超限 → 同样降级', () => {
		const plan = planSkillInjections([
			mk('big1', SKILL_PRIORITY_REQUIRED, 600),
			mk('big2', SKILL_PRIORITY_ALWAYS, 600),
		], { maxFullSkills: 10, maxPromptChars: 1_000 });
		assert.deepStrictEqual(plan.full.map(s => s.id), ['big1']);
		assert.deepStrictEqual(plan.summary.map(s => s.id), ['big2']);
	});

	test('★ 不丢弃：full + summary 恒等于候选数', () => {
		const plan = planSkillInjections([
			mk('x1', SKILL_PRIORITY_ALWAYS, 5000),
			mk('x2', SKILL_PRIORITY_ALWAYS, 5000),
			mk('x3', SKILL_PRIORITY_AUTO, 10),
		], { maxFullSkills: 1, maxPromptChars: 100 });
		assert.strictEqual(plan.full.length + plan.summary.length, 3);
		// ★ 填充语义 = 「能塞则塞」：x1/x2 单条就超出字符预算（5000 > 100）→ 跳过，
		// 后面的小条目 x3 仍能进完整正文（**不因前者超限而阻塞**）。见实现处注释。
		assert.deepStrictEqual(plan.full.map(s => s.id), ['x3']);
	});

	test('预算宽松 → 全部完整正文，无摘要', () => {
		const plan = planSkillInjections(
			[mk('s1', SKILL_PRIORITY_AUTO), mk('s2', SKILL_PRIORITY_AUTO)],
			DEFAULT_SKILL_BUDGET,
		);
		assert.strictEqual(plan.full.length, 2);
		assert.strictEqual(plan.summary.length, 0);
	});

	test('确定性：同优先级按 id 字典序（避免「谁被降级」无谓漂移）', () => {
		const plan = planSkillInjections([
			mk('zzz', SKILL_PRIORITY_ALWAYS), mk('aaa', SKILL_PRIORITY_ALWAYS), mk('mmm', SKILL_PRIORITY_ALWAYS),
		], { maxFullSkills: 2, maxPromptChars: 1_000_000 });
		assert.deepStrictEqual(plan.full.map(s => s.id), ['aaa', 'mmm']);
		assert.deepStrictEqual(plan.summary.map(s => s.id), ['zzz']);
	});

	test('空候选 → 空计划', () => {
		const plan = planSkillInjections([]);
		assert.strictEqual(plan.full.length, 0);
		assert.strictEqual(plan.summary.length, 0);
	});

	test('降级说明：有摘要时含 read_skill 指引；无摘要时为空串', () => {
		assert.ok(/read_skill/.test(buildSkillBudgetNote(2)), '应指引模型用 read_skill 取全文');
		assert.strictEqual(buildSkillBudgetNote(0), '');
	});
});
