/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 沉淀技能（Extract Skill）—— 从 LLM 对话消息中提取可复用的技能定义。
 *
 * 设计思路：
 *   1. 纯函数，无 DOM / DI 依赖，可单测。
 *   2. 提供给 `NativeChatEditorPane._handleExtractSkill` 使用。
 *   3. 产出的 SKILL.md 格式与 `SkillManagerTool.createSkill()` 兼容。
 */

// ─── 类型定义 ────────────────────────────────────────────────────────────────

/** 从消息内容中提取出的技能组分 */
export interface IExtractedSkillComponents {
	/** 技能名称（slug 格式，如 "git-commit-guide"） */
	readonly name: string;
	/** 一行简短描述 */
	readonly description: string;
	/** 技能正文（markdown，不含 frontmatter） */
	readonly prompt: string;
	/** 可选分类目录名 */
	readonly category?: string;
}

/** buildSkillMd 的输入参数 */
export interface IBuildSkillMdOptions {
	readonly name: string;
	readonly description: string;
	readonly prompt: string;
	readonly category?: string;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const SKILL_NAME_MAX_LENGTH = 64;
const SKILL_DESC_MAX_LENGTH = 1024;

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 从自由文本生成 slug 格式的 skill name。
 * 规则：
 *   - 取小写
 *   - 保留字母、数字、连字符、下划线、点
 *   - 空格/下划线→连字符
 *   - 连续非 slug 字符压缩为单个连字符
 *   - 截断到 64 字符
 *   - 如果为空，返回 "extracted-skill-{timestampHash}"
 */
export function toSkillSlug(raw: string): string {
	let slug = raw.trim();
	if (!slug) {
		return `extracted-skill-${Date.now().toString(36)}`;
	}

	slug = slug.toLowerCase();
	// 空格、中文标点 → 连字符
	slug = slug.replace(/[\s，。！？、：；""''（）【】《》]+/g, '-');
	// 保留 slug 合法字符，其余替换为连字符
	slug = slug.replace(/[^a-z0-9._-]/g, '-');
	// 连续连字符合并
	slug = slug.replace(/-{2,}/g, '-');
	// 首尾去连字符
	slug = slug.replace(/^-+|-+$/g, '');
	// 截断
	if (slug.length > SKILL_NAME_MAX_LENGTH) {
		slug = slug.slice(0, SKILL_NAME_MAX_LENGTH).replace(/-$/, '');
	}
	if (!slug) {
		return `extracted-skill-${Date.now().toString(36)}`;
	}
	return slug;
}

/**
 * 验证 skill name 是否满足 slug 格式要求。
 * 与 SkillManagerTool.validateSkillSlug 一致。
 */
export function isValidSkillSlug(name: string): boolean {
	if (!name || name.length > SKILL_NAME_MAX_LENGTH) { return false; }
	return /^[a-z0-9][a-z0-9._-]*$/.test(name);
}

// ─── 纯函数：构建 SKILL.md ──────────────────────────────────────────────────

/**
 * 从组分构建完整的 SKILL.md 内容（YAML frontmatter + markdown body）。
 *
 * @param name 技能名（slug），用于 frontmatter name 字段
 * @param description 一行描述，用于 frontmatter description 字段
 * @param prompt 技能正文（markdown）
 * @param category 可选分类，写入 frontmatter category 字段
 * @returns 完整 SKILL.md 文本，以换行符 `\n` 分隔
 */
export function buildSkillMd(name: string, description: string, prompt: string, category?: string): string {
	const lines: string[] = ['---'];
	lines.push(`name: "${escapeYamlValue(name)}"`);
	lines.push(`description: "${escapeYamlValue(description.slice(0, SKILL_DESC_MAX_LENGTH))}"`);
	if (category && category.trim()) {
		lines.push(`category: "${escapeYamlValue(category.trim())}"`);
	}
	lines.push('---');
	lines.push('');
	// prompt 正文（保持原始缩进与空行）
	const body = prompt.trim();
	if (body) {
		lines.push(body);
	}
	lines.push(''); // trailing newline
	return lines.join('\n');
}

/**
 * 从 IExtractedSkillComponents 构建 SKILL.md（便捷包装）。
 */
export function buildSkillMdFromComponents(components: IExtractedSkillComponents): string {
	return buildSkillMd(
		components.name,
		components.description,
		components.prompt,
		components.category,
	);
}

// ─── 纯函数：解析 SKILL.md ──────────────────────────────────────────────────

/**
 * 解析 SKILL.md 内容，提取 frontmatter 中各字段及正文。
 * @returns 解析结果，或 null（格式不符合 SKILL.md）
 */
export function parseSkillMd(content: string): IExtractedSkillComponents | null {
	const trimmed = content.trim();
	if (!trimmed.startsWith('---')) { return null; }

	const endIdx = trimmed.indexOf('\n---', 3);
	if (endIdx < 0) { return null; }

	const fmBlock = trimmed.slice(4, endIdx); // 跳过 "---\n"
	const body = trimmed.slice(endIdx + 4).trim();

	const name = extractYamlField(fmBlock, 'name') ?? 'extracted-skill';
	const description = extractYamlField(fmBlock, 'description') ?? '';
	const category = extractYamlField(fmBlock, 'category');

	return { name, description, prompt: body, category: category || undefined };
}

// ─── 纯函数：从原始消息提取 ─────────────────────────────────────────────────

/**
 * 从消息内容中尝试提取技能名称。
 * 启发式优先级：
 *   1. 以 "# " 或 "## " 开头的第一行（去掉前缀）
 *   2. 第一行非空文本（最长 80 字符）
 *   3. 兜底 "extracted-skill"
 */
export function tryExtractSkillName(content: string): string {
	const lines = content.split('\n');
	// 1. 找第一个 # 标题
	for (const line of lines) {
		const m = line.match(/^#{1,3}\s+(.+)/);
		if (m) {
			const title = m[1].trim();
			return title.length > 80 ? title.slice(0, 77) + '...' : title;
		}
	}
	// 2. 第一行非空文本
	for (const line of lines) {
		const t = line.trim();
		if (t.length > 0) {
			return t.length > 80 ? t.slice(0, 77) + '...' : t;
		}
	}
	// 3. 兜底
	return `extracted-skill-${Date.now().toString(36)}`;
}

/**
 * 从消息内容中尝试提取技能描述。
 * 启发式优先级：
 *   1. 第一段非空非标题文本（最多 200 字符）
 *   2. 兜底 "Extracted skill from chat message"
 */
export function tryExtractSkillDescription(content: string): string {
	const lines = content.split('\n');
	const paragraphs: string[] = [];
	let currentPara = '';

	for (const line of lines) {
		const t = line.trim();
		// 跳过标题行
		if (t.startsWith('#')) { continue; }
		// 跳过代码块
		if (t.startsWith('```')) { continue; }

		if (t.length === 0) {
			// 空行 → 段落结束
			if (currentPara.length > 10) {
				paragraphs.push(currentPara);
			}
			currentPara = '';
		} else {
			currentPara += (currentPara ? ' ' : '') + t;
		}
	}
	// 最后一段
	if (currentPara.length > 10) {
		paragraphs.push(currentPara);
	}

	for (const para of paragraphs) {
		if (para.length >= 20) {
			return para.length > 200 ? para.slice(0, 197) + '...' : para;
		}
	}
	return 'Extracted skill from chat message';
}

/**
 * 从消息内容中提取技能正文（prompt，去除 frontmatter 和标题）。
 * 规则：
 *   - 如果内容已经是 SKILL.md 格式（包含 --- frontmatter），返回 body 部分
 *   - 否则返回去除第一行标题后的全文
 */
export function tryExtractSkillPrompt(content: string): string {
	// 如果已经是 SKILL.md 格式
	if (content.trim().startsWith('---')) {
		const parsed = parseSkillMd(content);
		if (parsed) { return parsed.prompt; }
	}
	// 否则：去掉第一行标题后作为正文
	const lines = content.split('\n');
	const startIdx = lines[0]?.startsWith('#') ? 1 : 0;
	return lines.slice(startIdx).join('\n').trim();
}

/**
 * 综合提取：从消息内容中一次性提取技能的所有组分。
 * 这是「沉淀技能」按钮点击后调用的主函数。
 *
 * @param content 消息完整文本
 * @returns 提取出的技能组分（name 已转为 slug 并校验）
 */
export function extractSkillComponents(content: string): IExtractedSkillComponents {
	const rawName = tryExtractSkillName(content);
	const description = tryExtractSkillDescription(content);
	const prompt = tryExtractSkillPrompt(content);

	// 如果 name 已经是 slug 有效的（如 SKILL.md 内已有），直接使用
	let name: string;
	if (isValidSkillSlug(rawName)) {
		name = rawName;
	} else {
		// 否则转 slug
		name = toSkillSlug(rawName);
	}

	return { name, description, prompt };
}

// ─── 内部 helper ─────────────────────────────────────────────────────────────

/**
 * 转义 YAML 双引号字符串中的特殊字符（双引号、反斜杠）。
 */
function escapeYamlValue(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 从 YAML frontmatter 文本中提取指定字段值。
 * 支持带引号和不带引号的值。
 */
function extractYamlField(fmBlock: string, key: string): string | undefined {
	const re = new RegExp(`^${key}:\\s*(.+)`, 'im');
	const m = fmBlock.match(re);
	if (!m) { return undefined; }
	let val = m[1].trim();
	// 去掉首尾引号
	if ((val.startsWith('"') && val.endsWith('"')) ||
		(val.startsWith("'") && val.endsWith("'"))) {
		val = val.slice(1, -1);
	}
	return val || undefined;
}
