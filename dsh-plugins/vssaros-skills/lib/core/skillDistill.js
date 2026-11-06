// @vssaros/dsh-skills — 创建技能时的 SKILL.md 生成器（P1，2026-11-06）。
//
// 迁自 IDE 侧 `agentStudio/common/extractSkill.ts` 的 `buildSkillMd`：把「沉淀技能」
// 的模板生成能力搬到 dsh 侧，让非模型入口（页面 / API）也能产出一份 DSH 能加载的技能。
// 本文件是纯函数、零 I/O ⇒ 干净检出里可单测；真正的落盘由 `skillManage(create)` 负责，
// 且它只写 `<skillsRoot>/.drafts/`，用户 promote 后才进检索面（注入面纪律 ✓）。

import { assertSkillContent, assertSkillName } from './skillManage.js';

/** description 上限（与 IDE 侧 SkillManagerTool 同口径）。 */
export const MAX_DESCRIPTION_CHARS = 1024;

/** 可选的分类字段：只允许简单标识，避免往 frontmatter 里塞 YAML 结构。 */
const CATEGORY_RE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * 结构化字段 → 完整 SKILL.md 文本。
 *
 * ⚠ description **一律用双引号 JSON 字符串**：2026-11-06 真机发现 173 个随包技能里有
 *   45 个因为「description 未加引号又含冒号+空格」被 DSH 的 YAML 解析当成嵌套映射而静默丢弃。
 *   ⇒ 这里从生成侧堵死，`check-skill-frontmatter.mjs` 从存量侧守 ✓。
 *
 * @param {{ name: string, description: string, body?: string, category?: string, tags?: string[] }} input
 * @returns {string} 以 `---` 起头、可被 `assertSkillContent` / DSH 加载的 SKILL.md
 */
export function buildSkillMd(input = {}) {
	const id = assertSkillName(input?.name);
	const description = String(input?.description ?? '').trim();
	if (!description) {
		throw new Error('description 不能为空：dsh 缺了它会静默跳过这个技能（不是报错，是看不见 ✗）');
	}
	if (description.length > MAX_DESCRIPTION_CHARS) {
		throw new Error(`description 太长（${description.length} 字符 > ${MAX_DESCRIPTION_CHARS}）`);
	}
	const lines = [
		'---',
		`name: ${id}`,
		`description: ${JSON.stringify(description)}`,
		'activation: manual',
	];
	if (input?.category !== undefined && input?.category !== '') {
		const category = String(input.category).trim();
		if (!CATEGORY_RE.test(category)) {
			throw new Error(`category 不合法：${category}（只允许字母/数字/短横线/下划线，≤40 字符）`);
		}
		lines.push(`category: ${JSON.stringify(category)}`);
	}
	if (Array.isArray(input?.tags) && input.tags.length) {
		const tags = input.tags.slice(0, 12).map(t => JSON.stringify(String(t ?? '').trim().slice(0, 60)));
		lines.push(`tags: [${tags.join(', ')}]`);
	}
	lines.push('---', '', String(input?.body ?? '').trim() || `请在这里写下 ${id} 的使用指引。`);
	const text = lines.join('\n') + '\n';
	assertSkillContent(text);
	return text;
}
