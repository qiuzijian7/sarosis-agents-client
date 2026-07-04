/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */
/**
 * Skill Manager Tool — Agent 驱动的技能创建。
 *
 * 设计参考：Hermes-Agent 的 `tools/skill_manager_tool.py`，
 * 让 Agent 把成功的经验固化为可复用的程序性技能。
 *
 * 技能创建路径：
 *   ~/.saros/skills/<skill-slug>/SKILL.md
 *
 * 关键约束：
 *   - skillname 必须满足 slug 格式（小写字母/数字/连字符，开头为字母或数字）
 *   - 写入前检查命名重复（跨所有 skill 来源目录）
 *   - frontmatter 必须包含 name 与 description 字段
 *   - 原子写入：先写临时文件再 move，避免半写状态
 */

import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { ISkillRegistry } from '../common/skills.js';

/** skill name 最大长度 */
const MAX_NAME_LENGTH = 64;
/** description 最大长度 */
const MAX_DESCRIPTION_LENGTH = 1024;
/** SKILL.md 内容最大字符数（~36k tokens） */
const MAX_SKILL_CONTENT_CHARS = 100_000;

/**
 * slug 校验正则：小写字母、数字、连字符、下划线、点；必须以字母或数字开头。
 * 与 Hermes-Agent 的 VALID_NAME_RE 一致。
 */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

export interface ISkillCreateArgs {
	/** 技能名称（slug 格式） */
	name: string;
	/** 完整 SKILL.md 内容（YAML frontmatter + markdown body） */
	content: string;
	/** 可选分类目录名 */
	category?: string;
}

export interface ISkillCreateResult {
	readonly success: boolean;
	readonly message: string;
	readonly error?: string;
	readonly skillPath?: string;
	readonly skillMdPath?: string;
}

/**
 * 校验 skill name 是否满足 slug 格式。
 * @returns 错误消息（空字符串表示通过）
 */
export function validateSkillSlug(name: string): string {
	if (!name) {
		return 'Skill name is required.';
	}
	if (name.length > MAX_NAME_LENGTH) {
		return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`;
	}
	if (!SLUG_RE.test(name)) {
		return (
			`Invalid skill name '${name}'. Use lowercase letters, numbers, `
			+ `hyphens, dots, and underscores. Must start with a letter or digit.`
		);
	}
	return '';
}

/**
 * 校验可选的 category 名称（作为单一目录段）。
 * @returns 错误消息（空字符串表示通过）
 */
export function validateCategory(category: string | undefined): string {
	if (!category) {
		return '';
	}
	if (typeof category !== 'string') {
		return 'Category must be a string.';
	}
	const trimmed = category.trim();
	if (!trimmed) {
		return '';
	}
	if (trimmed.includes('/') || trimmed.includes('\\')) {
		return `Invalid category '${trimmed}'. Category must be a single directory name (no path separators).`;
	}
	if (trimmed.length > MAX_NAME_LENGTH) {
		return `Category exceeds ${MAX_NAME_LENGTH} characters.`;
	}
	if (!SLUG_RE.test(trimmed)) {
		return `Invalid category '${trimmed}'. Use lowercase letters, numbers, hyphens, dots, and underscores.`;
	}
	return '';
}

/**
 * 极简 YAML frontmatter 校验：要求以 `---` 开头和结尾，且包含 name 与 description 字段。
 * @returns 错误消息（空字符串表示通过）
 */
export function validateFrontmatter(content: string): string {
	if (!content.trim()) {
		return 'Content cannot be empty.';
	}
	if (!content.startsWith('---')) {
		return "SKILL.md must start with YAML frontmatter (---). See existing skills for format.";
	}
	const endMatch = content.indexOf('\n---', 3);
	if (endMatch < 0) {
		return "SKILL.md frontmatter is not closed. Ensure you have a closing '---' line.";
	}
	const yamlBlock = content.slice(3, endMatch);
	const hasName = /^[ \t]*name[ \t]*:/m.test(yamlBlock);
	if (!hasName) {
		return "Frontmatter must include 'name' field.";
	}
	const hasDescription = /^[ \t]*description[ \t]*:/m.test(yamlBlock);
	if (!hasDescription) {
		return "Frontmatter must include 'description' field.";
	}
	// 检查 description 长度（提取首个 description 行的值）
	const descLine = /^[ \t]*description[ \t]*:[ \t]*(.*)$/m.exec(yamlBlock);
	if (descLine && descLine[1]) {
		const descVal = descLine[1].replace(/^["']|["']$/g, '').trim();
		if (descVal.length > MAX_DESCRIPTION_LENGTH) {
			return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`;
		}
	}
	const body = content.slice(endMatch + 4).replace(/^\r?\n/, '').trim();
	if (!body) {
		return 'SKILL.md must have content after the frontmatter (instructions, procedures, etc.).';
	}
	return '';
}

/**
 * 校验内容大小。
 * @returns 错误消息（空字符串表示通过）
 */
export function validateContentSize(content: string): string {
	if (content.length > MAX_SKILL_CONTENT_CHARS) {
		return (
			`SKILL.md content is ${content.length.toLocaleString()} characters `
			+ `(limit: ${MAX_SKILL_CONTENT_CHARS.toLocaleString()}). `
			+ `Consider splitting into a smaller SKILL.md with supporting files.`
		);
	}
	return '';
}

/**
 * Skill Manager — 提供 skill_create 工具的核心逻辑。
 *
 * 使用方式：在 BuiltinToolProvider._registerSkillTools() 中实例化并调用 createSkill()。
 * 该类依赖 IFileService / IPathService / ISkillRegistry / ILogService，
 * 与 Hermes-Agent 的 _create_skill() 对应。
 */
export class SkillManagerTool {

	constructor(
		private readonly fileService: IFileService,
		private readonly pathService: IPathService,
		private readonly skillRegistry: ISkillRegistry,
		private readonly logService: ILogService,
	) { }

	/**
	 * 创建一个新技能。
	 *
	 * 流程：
	 * 1. 校验 name（slug 格式）、category、content（frontmatter + size）
	 * 2. 等待 SkillRegistry 加载完成，检查重名
	 * 3. 在 ~/.saros/skills/<name>/SKILL.md 路径下原子写入
	 * 4. 触发 SkillRegistry.reload() 让新技能立即可用
	 *
	 * @returns 结果对象
	 */
	async createSkill(args: ISkillCreateArgs): Promise<ISkillCreateResult> {
		const name = String(args.name ?? '').trim();
		const content = String(args.content ?? '');
		const category = args.category ? String(args.category).trim() || undefined : undefined;

		// 1. 校验 name（slug）
		const nameErr = validateSkillSlug(name);
		if (nameErr) {
			return { success: false, message: nameErr, error: nameErr };
		}

		// 2. 校验 category
		const catErr = validateCategory(category);
		if (catErr) {
			return { success: false, message: catErr, error: catErr };
		}

		// 3. 校验 frontmatter
		const fmErr = validateFrontmatter(content);
		if (fmErr) {
			return { success: false, message: fmErr, error: fmErr };
		}

		// 4. 校验大小
		const sizeErr = validateContentSize(content);
		if (sizeErr) {
			return { success: false, message: sizeErr, error: sizeErr };
		}

		// 5. 检查重名 —— 跨所有 skill 来源（builtin / user / marketplace / runtime）
		try {
			await this.skillRegistry.whenReady();
		} catch {
			// whenReady 失败不阻塞创建 —— 后续重名检查仍基于当前已加载的 skill
		}
		const existing = this.skillRegistry.getSkill(name);
		if (existing) {
			const errMsg = `A skill named '${name}' already exists (source: ${existing.source}). Choose a different name or delete the existing one first.`;
			return { success: false, message: errMsg, error: errMsg };
		}
		// 同时检查 getSkills 列表（防止 id 规范化后与现有 skill 冲突）
		const allSkills = this.skillRegistry.getSkills();
		const conflictByName = allSkills.find(s => s.name.toLowerCase() === name.toLowerCase());
		if (conflictByName) {
			const errMsg = `A skill with name '${name}' already exists (id: ${conflictByName.id}, source: ${conflictByName.source}).`;
			return { success: false, message: errMsg, error: errMsg };
		}

		// 6. 计算目标目录：~/.saros/skills/<name>/
		const userHome = await this.pathService.userHome();
		const skillsRoot = URI.joinPath(userHome, '.saros', 'skills');
		const skillDir = URI.joinPath(skillsRoot, name);
		const skillMd = URI.joinPath(skillDir, 'SKILL.md');

		// 7. 原子写入：先写临时文件，再 move 到目标
		try {
			await this._atomicWriteFile(skillMd, content);
		} catch (err) {
			const msg = `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}`;
			this.logService.error(`[SkillManagerTool] createSkill write failed for '${name}': ${msg}`);
			return { success: false, message: msg, error: msg };
		}

		this.logService.info(`[SkillManagerTool] skill '${name}' created at ${skillDir.fsPath}`);

		// 8. 触发 reload 让新技能立即出现在 registry 中
		try {
			await this.skillRegistry.reload();
		} catch (err) {
			// reload 失败不视为创建失败 —— 文件已落盘，下次 reload 时会加载
			this.logService.warn(`[SkillManagerTool] post-create reload failed (skill still saved): ${err instanceof Error ? err.message : String(err)}`);
		}

		return {
			success: true,
			message: `Skill '${name}' created successfully at ${skillDir.fsPath}.`,
			skillPath: skillDir.fsPath,
			skillMdPath: skillMd.fsPath,
		};
	}

	/**
	 * 原子写入文件：先写入同目录临时文件，再 move 覆盖目标。
	 * 与 Hermes-Agent 的 _atomic_write_text() 及 builtinToolProvider._writeAtomic() 模式一致。
	 */
	private async _atomicWriteFile(target: URI, text: string): Promise<void> {
		const tmp = URI.joinPath(target, '..', `.skill_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
		try {
			await this.fileService.writeFile(tmp, VSBuffer.fromString(text));
			await this.fileService.move(tmp, target, true);
		} catch (err) {
			try { await this.fileService.del(tmp); } catch { /* ignore */ }
			throw err;
		}
	}
}

/**
 * skill_create 工具的 inputSchema（JSON Schema）。
 * 与 Hermes-Agent 的 SKILL_MANAGE_SCHEMA (action=create) 对齐。
 */
export const SKILL_CREATE_TOOL_SCHEMA = {
	type: 'object',
	properties: {
		name: {
			type: 'string',
			description: (
				'Skill name in slug format (lowercase letters, numbers, hyphens, '
				+ `dots, underscores; max ${MAX_NAME_LENGTH} chars; must start with a letter or digit). `
				+ 'Example: "code-review", "deploy-k8s", "git.rebase-guide".'
			),
		},
		content: {
			type: 'string',
			description: (
				'Full SKILL.md content (YAML frontmatter + markdown body). '
				+ 'Frontmatter must include "name" and "description" fields. '
				+ 'Example:\n'
				+ '---\nname: my-skill\ndescription: What this skill does\n'
				+ 'activation: manual\nmatch: [keyword1, keyword2]\n---\n'
				+ 'Detailed instructions here...'
			),
		},
		category: {
			type: 'string',
			description: (
				'Optional category for organizing the skill (e.g., "devops", "code", "docs"). '
				+ 'Creates a subdirectory grouping under ~/.saros/skills/<category>/<name>/.'
			),
		},
	},
	required: ['name', 'content'],
} as const;

/**
 * skill_create 工具的描述文本（供 LLM 理解何时使用）。
 */
export const SKILL_CREATE_TOOL_DESCRIPTION = [
	'Create a new skill (reusable procedural knowledge) by writing a SKILL.md file.',
	'',
	'IMPORTANT: This is the ONLY tool that can create skills.',
	'Do NOT use file_write or patch to create SKILL.md files — they will be rejected.',
	'Skills are ALWAYS saved to ~/.saros/skills/<name>/SKILL.md (never to workspace .github/skills/ or .agents/skills/).',
	'Created skills become immediately available for activation via /skill or list_skills.',
	'',
	'When to create a skill:',
	'- A complex task succeeded after 5+ tool calls and the approach is reusable.',
	'- You encountered and overcame non-trivial errors worth remembering.',
	'- The user corrected your approach and the corrected version is worth saving.',
	'- You discovered a non-trivial workflow that would help future tasks.',
	'- The user explicitly asks you to remember or create a procedure/skill.',
	'',
	'Skip skill creation for simple one-off tasks.',
	'Confirm with the user before creating a skill.',
	'',
	'SKILL.md format (the content parameter must follow this exact structure):',
	'  ---',
	'  name: skill-slug        # must match the "name" argument, slug format (lowercase, hyphens)',
	'  description: Short summary of what this skill does',
	'  activation: manual       # manual | auto | always',
	'  match: [keyword1, keyword2]  # only for activation=auto',
	'  category: code           # optional',
	'  recommended_tools: [file_read, terminal]  # optional',
	'  ---',
	'  <markdown body with numbered steps, exact commands, pitfalls, verification>',
	'',
	'Good skills include: trigger conditions, numbered steps with exact commands, '
	+ 'a pitfalls section, and verification steps.',
].join('\n');
