/**
 * @vssaros/dsh-skills — 技能注入预算（纯函数，零 dsh / 零 IDE 依赖）。
 *
 * ★ 2026-11-08（P0）：把 IDE 侧 `src/vs/.../skillInjectionBudget.ts` 的**算法与常量语义**下沉到
 *   宿主插件可 import 的 JS 模块。IDE 侧那份属于已退役的注入链（`check-ide-skill-retirement.mjs`
 *   钉住 `@ISkillRegistry` 注入数 = 0），本项目**不 import、不接回**它 —— 复用的是算法，不是退役文件。
 *   同名的纯函数在这里独立实现，守卫 `check-agent-skills.mjs` 断言两侧算法同形。
 *
 * 边界对齐 `skill_context` 工具（`lib/index.js`）：单条正文 4000 字、总量 20000 字。
 */

/** 完整正文注入的预算（与 IDE 侧 DEFAULT_SKILL_BUDGET 同值）。 */
export const DEFAULT_SKILL_BUDGET = Object.freeze({ maxFullSkills: 10, maxPromptChars: 48_000 });
/** 单条技能正文的字符上限（skill_context 内联预算的原值，不改动语义）。 */
export const SKILL_BODY_MAX = 4_000;
/** 一次取回的技能正文总字符上限。 */
export const SKILL_TOTAL_MAX = 20_000;
/** `<available_skills>` 清单的总字符上限；超出时降级为「省略 N 条」而不是静默丢弃。 */
export const SKILL_CATALOG_MAX_CHARS = 20_000;

/**
 * 按优先级分配「注入完整正文」的预算。
 * 排序确定性：先 priority，再 id 字典序（否则 Map/目录顺序变化会让「谁被降级」无谓漂移）。
 * 填充语义 = 能塞则塞：某条超限就跳过它、继续尝试后面的，不因一条大而停止。
 * @param candidates `{ skill: { id: string }, priority: number, contentChars: number }[]`
 * @returns `{ full, summary }`
 */
export function planSkillInjections(candidates, budget = DEFAULT_SKILL_BUDGET) {
	const full = [];
	const summary = [];
	let usedChars = 0;
	const sorted = [...(Array.isArray(candidates) ? candidates : [])].sort((a, b) =>
		(Number(a?.priority) || 0) - (Number(b?.priority) || 0) || String(a?.skill?.id ?? '').localeCompare(String(b?.skill?.id ?? '')));
	for (const candidate of sorted) {
		const chars = Math.max(0, Number(candidate?.contentChars) || 0);
		const withinCount = full.length < (budget?.maxFullSkills ?? DEFAULT_SKILL_BUDGET.maxFullSkills);
		const withinChars = usedChars + chars <= (budget?.maxPromptChars ?? DEFAULT_SKILL_BUDGET.maxPromptChars);
		if (withinCount && withinChars) {
			full.push(candidate.skill);
			usedChars += chars;
		} else {
			summary.push(candidate.skill);
		}
	}
	return { full, summary };
}

/** 预算降级说明（「结果被削弱必须明说」）。 */
export function buildSkillBudgetNote(summaryCount) {
	return Number(summaryCount) > 0
		? `(note: ${summaryCount} skill(s) injected as SUMMARY only — full body omitted by the prompt budget. Call \`read_skill\` with the skill id to load the full text.)`
		: '';
}

/**
 * 清单行预算：逐行累加字符数，超限的行降级（不静默丢）。
 * @param lines `string[]`（已格式化的一行摘要）
 * @returns `{ kept: string[], omitted: number, chars: number }`
 */
export function planCatalogLines(lines, maxChars = SKILL_CATALOG_MAX_CHARS) {
	const kept = [];
	let chars = 0;
	let omitted = 0;
	for (const line of Array.isArray(lines) ? lines : []) {
		const text = String(line ?? '');
		if (chars + text.length > maxChars) { omitted += 1; continue; }
		kept.push(text);
		chars += text.length;
	}
	return { kept, omitted, chars };
}
