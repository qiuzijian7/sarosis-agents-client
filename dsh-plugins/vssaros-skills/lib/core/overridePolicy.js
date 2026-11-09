/**
 * @vssaros/dsh-skills — 同名技能覆盖的**单一裁决真源**（2026-11-08 P2）。
 *
 * ★ 为什么不照搬 DS Bot：那边用硬编码 rank 550/600 压同名，rank 一改就静默换赢家。
 *   这里只认一个事实：`SKILL_ROOT_SPECS` 的**顺序即优先级**（见 IDE 侧
 *   `src/vs/sessions/contrib/agentStudio/common/skillRoots.ts`），运行时同名裁决由官方
 *   `dsh-skill` 按 layer/rank 做（`compareIndexedCandidates`，本仓不改官方包）。
 *   我们能钉住的是**契约**：
 *     · 随包技能想覆盖同名用户技能，必须在 SKILL.md 显式写 `override: true`；
 *     · `override: true` **只许随包声明**，用户技能写了视为无效并判红；
 *     · 没写 override 的随包技能，同名时用户技能优先（first-wins，根顺序）。
 *
 * 纯函数、零 dsh 依赖 ⇒ 守卫与运行期共用一条口径。
 */

/** 从 SKILL.md 读显式覆盖声明；只认字面 true（避免字符串 "false" 被当成真）。 */
export function overrideOfMd(text) {
	const raw = String(text ?? '');
	if (!raw.startsWith('---')) { return false; }
	const end = raw.indexOf('\n---', 3);
	const head = end < 0 ? '' : raw.slice(raw.indexOf('\n', 3) + 1, end);
	return /^override:\s*true\s*$/m.test(head);
}

/**
 * 单一裁决：随包技能与用户技能同名时谁赢。
 * @param bundled `{ name, override }` | null
 * @param user `{ name }` | null
 * @returns `'user' | 'bundled' | 'none'`
 */
export function resolveSameName(bundled, user) {
	if (!bundled && !user) { return 'none'; }
	if (!user) { return 'bundled'; }
	if (!bundled) { return 'user'; }
	return bundled.override === true ? 'bundled' : 'user';
}

/** 契约违规列表（守卫用）；不硬编码 rank，只查声明位置与取值。 */
export function overrideProblems(bundledEntries, userEntries) {
	const problems = [];
	const userNames = new Set((Array.isArray(userEntries) ? userEntries : []).map(e => String(e?.name ?? '')).filter(Boolean));
	for (const entry of Array.isArray(bundledEntries) ? bundledEntries : []) {
		const name = String(entry?.name ?? '');
		if (entry?.override === true && !userNames.has(name)) {
			problems.push(`随包技能 ${name} 声明 override: true，但没有同名的用户技能（无效声明，删掉）`);
		}
	}
	for (const entry of Array.isArray(userEntries) ? userEntries : []) {
		if (entry?.override === true) {
			problems.push(`用户技能 ${String(entry?.name ?? '')} 不许声明 override: true（只许随包技能声明）`);
		}
	}
	return problems;
}
