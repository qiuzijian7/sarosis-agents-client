/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill 注入预算 —— **纯函数层**（2026-09-11 补齐「Skill 注入零预算」缺口）。
 *
 * 背景：`SkillRegistry.resolveActivations` 此前**不排序、不限量、不限字符** ——
 * 每个命中的技能都把**完整正文**（`renderSkillBody`）注入为独立 user message。
 * 多 `always` 技能或多 `required` 配置下每轮 prompt 会无界膨胀；而 `constants.ts`
 * 里预留的两个预算开关（`maxSkillsInPrompt` / `maxSkillsPromptChars`）
 * **从未接线**（死常量，全仓零消费）。
 *
 * 本模块只做「候选 → 预算分配」的纯决策，不碰 DI / IO：
 *  - **优先级**：required（agent 强制）> explicit（`/skill`）> always > auto（关键词）
 *  - **预算**：完整正文的**数量 + 字符双上限**
 *  - **超出者降级为摘要**（name + description + 目录路径 + `read_skill` 提示），
 *    **不丢弃** —— 这样 `always` 的语义（「模型总能看到它」）不被预算破坏，
 *    同时把体积压回可控范围。
 */

import type { ISkillDefinition } from './skills.js';

/** 激活优先级（数值越小越优先占用预算）。 */
export const SKILL_PRIORITY_REQUIRED = 0;
export const SKILL_PRIORITY_EXPLICIT = 1;
export const SKILL_PRIORITY_ALWAYS = 2;
export const SKILL_PRIORITY_AUTO = 3;

export interface ISkillBudget {
	/** 注入**完整正文**的技能数量上限。 */
	readonly maxFullSkills: number;
	/** 注入**完整正文**的字符总预算。 */
	readonly maxPromptChars: number;
}

/**
 * 默认预算（宽松，避免改变常见配置的行为）。
 *
 * 48_000 字符 ≈ 12k tokens（按 4 chars/token）—— 占 200k 上下文的约 6%。
 * 正常 agent 配 1–3 个 required + 少数 always，远不会触顶；触顶时降级为摘要，
 * 信息不丢（模型仍能看到技能存在并 `read_skill` 读全文）。
 */
export const DEFAULT_SKILL_BUDGET: ISkillBudget = { maxFullSkills: 10, maxPromptChars: 48_000 };

export interface ISkillBudgetCandidate {
	readonly skill: ISkillDefinition;
	readonly priority: number;
	/** 该技能**完整正文**的字符数（调用方算好传入，避免本模块重复渲染）。 */
	readonly contentChars: number;
}

export interface ISkillInjectionPlan {
	/** 注入完整正文（按优先级排序）。 */
	readonly full: readonly ISkillDefinition[];
	/** 降级为摘要（超预算）。 */
	readonly summary: readonly ISkillDefinition[];
}

/**
 * 按优先级分配注入预算。
 *
 * 排序保证**确定性**：先按优先级，再按 `id` 字典序 —— 否则 `Map` 迭代顺序虽稳定，
 * 但不同来源（内置/用户/workflow）的插入顺序变化会让「谁被降级」无谓漂移。
 *
 * 逐条累加字符数（不预判总量），因此「一个大技能」不会挤掉后面所有小技能之外的
 * 东西 —— 排在它后面的条目会因 `used + chars > 预算` 而降级，符合「优先级优先」。
 */
export function planSkillInjections(
	candidates: readonly ISkillBudgetCandidate[],
	budget: ISkillBudget = DEFAULT_SKILL_BUDGET,
): ISkillInjectionPlan {
	const sorted = [...candidates].sort((a, b) =>
		a.priority - b.priority || a.skill.id.localeCompare(b.skill.id));

	const full: ISkillDefinition[] = [];
	const summary: ISkillDefinition[] = [];
	let usedChars = 0;

	// ★ 填充语义 = 「能塞则塞」（贪心）：单条放不下就跳过它、继续尝试后面的条目
	// （**不因某条超限而停止**）。因此可能看到「高优先级的大块头被降级、低优先级的
	// 小条目进了完整正文」—— 这是**有意**的：预算首要目标是控制体积，贪心能最大化
	// 利用率；而「高优先级技能自身超出字符预算」属**预算配置过小**（把
	// `maxSkillsPromptChars` 调到比单个技能正文还小），应在设置侧解决。
	for (const c of sorted) {
		const withinCount = full.length < budget.maxFullSkills;
		const withinChars = usedChars + c.contentChars <= budget.maxPromptChars;
		if (withinCount && withinChars) {
			full.push(c.skill);
			usedChars += c.contentChars;
		} else {
			summary.push(c.skill);
		}
	}
	return { full, summary };
}

/**
 * 预算降级说明（注入进摘要条，遵循「结果被削弱必须明说」的诚实性原则）。
 */
export function buildSkillBudgetNote(summaryCount: number): string {
	return summaryCount > 0
		? `(note: ${summaryCount} skill(s) injected as SUMMARY only — full body omitted by the prompt budget. Call \`read_skill\` with the skill id to load the full content before following it.)`
		: '';
}
