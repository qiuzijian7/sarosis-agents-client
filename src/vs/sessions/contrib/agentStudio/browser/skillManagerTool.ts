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
 *   ~/.vssaros/saros/skills/<skill-slug>/SKILL.md
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

import { ISkillRegistry } from '../common/skills.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../common/sarosPaths.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';

/** skill name 最大长度 */
const MAX_NAME_LENGTH = 64;
/** description 最大长度 */
const MAX_DESCRIPTION_LENGTH = 1024;
/** SKILL.md 内容最大字符数（~36k tokens） */
const MAX_SKILL_CONTENT_CHARS = 100_000;
/** 技能文件备份保留数量 */
const MAX_SKILL_BACKUPS = 3;

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
 * Skill Manager — 提供 skill_manage 工具的核心逻辑（含 create/edit/patch/delete 等 action）。
 *
 * 使用方式：在 BuiltinToolProvider._registerSkillTools() 中实例化并调用 createSkill()。
 * 该类依赖 IFileService / IPathService / ISkillRegistry / ILogService，
 * 与 Hermes-Agent 的 _create_skill() 对应。
 */
export class SkillManagerTool {

	constructor(
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		private readonly fileService: IFileService,
		private readonly skillRegistry: ISkillRegistry,
		private readonly logService: ILogService,
	) { }

	/**
	 * 创建一个新技能。
	 *
	 * 流程：
	 * 1. 校验 name（slug 格式）、category、content（frontmatter + size）
	 * 2. 等待 SkillRegistry 加载完成，检查重名
	 * 3. 在 ~/.vssaros/saros/skills/<name>/SKILL.md 路径下原子写入
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

		// 6. 计算目标目录：~/.vssaros/saros/skills/<name>/
		const skillsRoot = resolveSarosPath(this._getSarosRoot(), SarosPath.skills);
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
	 * 更新已有技能（全量覆盖）。
	 *
	 * 与 createSkill 不同的是：
	 * - 不检查重名（要求技能已存在）
	 * - 写入前自动备份（保留最近 MAX_SKILL_BACKUPS 份）
	 * - 写入后触发 reload
	 */
	async updateSkill(args: ISkillCreateArgs): Promise<ISkillCreateResult> {
		const name = String(args.name ?? '').trim();
		const content = String(args.content ?? '');

		const nameErr = validateSkillSlug(name);
		if (nameErr) {
			return { success: false, message: nameErr, error: nameErr };
		}

		const fmErr = validateFrontmatter(content);
		if (fmErr) {
			return { success: false, message: fmErr, error: fmErr };
		}

		const sizeErr = validateContentSize(content);
		if (sizeErr) {
			return { success: false, message: sizeErr, error: sizeErr };
		}

		// 确保技能存在
		try {
			await this.skillRegistry.whenReady();
		} catch { /* ignore */ }
		const existing = this.skillRegistry.getSkill(name);
		if (!existing) {
			return {
				success: false,
				message: `Skill "${name}" does not exist. Use skill_manage with action="create" to create it first, or action="patch" for targeted edits.`,
				error: `Skill "${name}" not found.`,
			};
		}

		// 内置技能不允许编辑（防止用户覆写污染产品源）
		if (existing.source === 'builtin') {
			return {
				success: false,
				message: `Skill "${name}" is a builtin skill and cannot be modified. Create a new skill with a different name instead.`,
				error: `Builtin skill "${name}" is read-only.`,
			};
		}

		const skillsRoot = resolveSarosPath(this._getSarosRoot(), SarosPath.skills);
		const skillDir = URI.joinPath(skillsRoot, name);
		const skillMd = URI.joinPath(skillDir, 'SKILL.md');

		// 写入前备份
		try {
			await this._backupSkillFile(skillMd);
		} catch (err) {
			this.logService.warn(`[SkillManagerTool] backup failed before update: ${err instanceof Error ? err.message : String(err)}`);
		}

		try {
			await this._atomicWriteFile(skillMd, content);
		} catch (err) {
			const msg = `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}`;
			this.logService.error(`[SkillManagerTool] updateSkill write failed for '${name}': ${msg}`);
			return { success: false, message: msg, error: msg };
		}

		this.logService.info(`[SkillManagerTool] skill '${name}' updated at ${skillDir.fsPath}`);

		try {
			await this.skillRegistry.reload();
		} catch (err) {
			this.logService.warn(`[SkillManagerTool] post-update reload failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		return {
			success: true,
			message: `Skill '${name}' updated successfully at ${skillDir.fsPath}.`,
			skillPath: skillDir.fsPath,
			skillMdPath: skillMd.fsPath,
		};
	}

	/**
	 * Patch 已有技能（字符串替换）。
	 *
	 * 改进点（相比旧版直接 fs.replace）：
	 * - 校验 old_string 唯一性（replace_all=false 时）
	 * - 校验替换后结果仍是合法 SKILL.md
	 * - 写入前自动备份
	 */
	async patchSkill(
		name: string,
		oldStr: string,
		newStr: string,
		replaceAll: boolean,
	): Promise<ISkillCreateResult> {
		const nameErr = validateSkillSlug(name);
		if (nameErr) {
			return { success: false, message: nameErr, error: nameErr };
		}
		if (!oldStr) {
			return { success: false, message: 'old_string is required for patch.', error: 'Missing old_string.' };
		}

		try {
			await this.skillRegistry.whenReady();
		} catch { /* ignore */ }

		const existing = this.skillRegistry.getSkill(name);
		if (!existing) {
			return {
				success: false,
				message: `Skill "${name}" does not exist.`,
				error: `Skill "${name}" not found.`,
			};
		}

		// 内置技能不允许编辑
		if (existing.source === 'builtin') {
			return {
				success: false,
				message: `Skill "${name}" is a builtin skill and cannot be patched.`,
				error: `Builtin skill "${name}" is read-only.`,
			};
		}

		const skillsRoot = resolveSarosPath(this._getSarosRoot(), SarosPath.skills);
		const skillMd = URI.joinPath(skillsRoot, name, 'SKILL.md');
		let fileContent: string;
		try {
			const raw = await this.fileService.readFile(skillMd);
			fileContent = raw.value.toString();
		} catch (err) {
			return {
				success: false,
				message: `Failed to read "${name}/SKILL.md": ${err instanceof Error ? err.message : String(err)}`,
				error: `Read failed.`,
			};
		}

		// 校验 old_string 唯一性（非 replace_all 模式）
		if (!replaceAll) {
			const firstIdx = fileContent.indexOf(oldStr);
			if (firstIdx === -1) {
				return {
					success: false,
					message: `old_string not found in "${name}/SKILL.md". The text must match exactly (including whitespace and line endings). Check your input and try again.`,
					error: 'old_string not found.',
				};
			}
			const secondIdx = fileContent.indexOf(oldStr, firstIdx + oldStr.length);
			if (secondIdx !== -1) {
				return {
					success: false,
					message: (
						`old_string appears multiple times in "${name}/SKILL.md". `
						+ `To replace all occurrences, set replace_all=true. `
						+ `To replace a single occurrence, provide more surrounding context to make old_string unique.`
					),
					error: 'old_string not unique (appears multiple times).',
				};
			}
		}

		// 替换
		let newContent: string;
		if (replaceAll) {
			newContent = fileContent.split(oldStr).join(newStr);
		} else {
			const idx = fileContent.indexOf(oldStr);
			newContent = fileContent.slice(0, idx) + newStr + fileContent.slice(idx + oldStr.length);
		}

		// 校验替换后结果仍是合法 SKILL.md（至少 frontmatter 完好）
		const fmErr = validateFrontmatter(newContent);
		if (fmErr) {
			return {
				success: false,
				message: `Patch would produce invalid SKILL.md: ${fmErr}. Review your old_string/new_string and ensure you preserve the YAML frontmatter.`,
				error: `Validation failed: ${fmErr}`,
			};
		}

		// 写入前备份
		try {
			await this._backupSkillFile(skillMd);
		} catch (err) {
			this.logService.warn(`[SkillManagerTool] backup failed before patch: ${err instanceof Error ? err.message : String(err)}`);
		}

		try {
			await this._atomicWriteFile(skillMd, newContent);
		} catch (err) {
			const msg = `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}`;
			return { success: false, message: msg, error: msg };
		}

		this.logService.info(`[SkillManagerTool] skill '${name}' patched`);

		try {
			await this.skillRegistry.reload();
		} catch (err) {
			this.logService.warn(`[SkillManagerTool] post-patch reload failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		return {
			success: true,
			message: `Skill '${name}' patched successfully.`,
			skillPath: skillMd.fsPath,
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

	/**
	 * 备份技能文件到 .skill-backup/ 目录（保留最近 MAX_SKILL_BACKUPS 份）。
	 */
	private async _backupSkillFile(skillMd: URI): Promise<void> {
		// 检查源文件是否存在
		let exists = false;
		try {
			await this.fileService.stat(skillMd);
			exists = true;
		} catch {
			return; // 新建文件无需备份
		}
		if (!exists) {
			return;
		}

		const backupDir = URI.joinPath(skillMd, '..', '.skill-backup');
		const baseName = skillMd.path.split('/').pop() ?? 'SKILL.md';
		const ts = new Date().toISOString().replace(/[:.]/g, '-');
		const backupFile = URI.joinPath(backupDir, `${baseName}.${ts}.bak`);

		try {
			await this.fileService.copy(skillMd, backupFile, true);
		} catch (err) {
			throw new Error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		// 清理超出 MAX_SKILL_BACKUPS 的旧备份
		try {
			const children = await this.fileService.resolve(backupDir);
			const backups = (children.children ?? [])
				.filter(c => c.name.startsWith(baseName) && c.name.endsWith('.bak'))
				.sort((a, b) => b.name.localeCompare(a.name)); // 降序排列（最新的在前）
			const toDelete = backups.slice(MAX_SKILL_BACKUPS);
			for (const stale of toDelete) {
				try { await this.fileService.del(stale.resource); } catch { /* ignore */ }
			}
		} catch {
			// 清理失败不影响主流程
		}
	}

	private _getSarosRoot(): URI {
		return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
	}
}


