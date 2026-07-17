/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill Tools — read_skill / skill_view / list_skills / skills_list / skill_create / skill_manage。
 *
 * 从 builtinToolProvider.ts 的 _registerSkillTools 抽出，降低主文件体积。
 * 借鉴 OpenClaw / Hermes 的按需加载模式：模型在 systemPrompt 看到轻量目录后，
 * 通过这些工具按需读取完整技能内容（progressive disclosure）。
 */

import { ToolSecurityLevel } from '../../../common/providers.js';
import type { IToolResultContent } from '../../../common/providers.js';
import { SKILL_CREATE_TOOL_SCHEMA, SKILL_CREATE_TOOL_DESCRIPTION, SkillManagerTool } from '../../skillManagerTool.js';
import type { ISkillRegistry } from '../../../common/skills.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

export interface SkillToolContext {
	register(registration: IBuiltinToolRegistration): void;
	skillRegistry: ISkillRegistry;
	skillManagerTool: SkillManagerTool;
	logService: ILogService;
}

export function registerSkillTools(ctx: SkillToolContext): void {
	const source = 'saros.builtin-tools';
		const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];
		const MAX_SKILL_BYTES = 256_000; // 单个 skill 内容上限 256KB

		ctx.register({
			definition: {
				name: 'read_skill',
				description: 'Read the full instructions of an installed skill by its id. Use this when you need detailed instructions from a skill listed in <available_skills>.',
				inputSchema: {
					type: 'object',
					properties: {
						skill_id: {
							type: 'string',
							description: 'The skill id (from <available_skills> in system prompt)',
						},
					},
					required: ['skill_id'],
				},
				category: 'skills',
				source: source,
			},
			handler: async args => {
				const skillId = String(args['skill_id'] ?? '').trim();
				if (!skillId) {
					throw new Error('skill_id is required');
				}

				const skill = ctx.skillRegistry.getSkill(skillId);
				if (!skill) {
					// 尝试模糊匹配（按 name）
					const allSkills = ctx.skillRegistry.getSkills();
					const byName = allSkills.find(s => s.name.toLowerCase() === skillId.toLowerCase());
					if (byName) {
						// 对齐 Hermes 格式：JSON {success, name, description, content, ...}
						return text(JSON.stringify({
							success: true,
							name: byName.name,
							id: byName.id,
							description: byName.description ?? '',
							category: byName.category ?? '',
							activation: byName.activation,
							content: (byName.prompt ?? '').slice(0, MAX_SKILL_BYTES),
							match: byName.match ?? [],
							recommendedTools: byName.recommendedTools ?? [],
						}, null, 2));
					}
					return text(JSON.stringify({
						success: false,
						error: `Skill not found: "${skillId}". Use list_skills to see available skill ids.`,
					}));
				}

				// 对齐 Hermes 格式
				return text(JSON.stringify({
					success: true,
					name: skill.name,
					id: skill.id,
					description: skill.description ?? '',
					category: skill.category ?? '',
					activation: skill.activation,
					content: (skill.prompt ?? '').slice(0, MAX_SKILL_BYTES),
					match: skill.match ?? [],
					recommendedTools: skill.recommendedTools ?? [],
				}, null, 2));
			},
		});

		// ── skill_view 别名（Hermes 命名）──────────────────────────
		ctx.register({
			definition: {
				name: 'skill_view',
				description: 'View the content of a skill or a specific file within a skill directory. (Alias for read_skill)',
				inputSchema: {
					type: 'object',
					properties: {
						name: { type: 'string', description: 'Skill name or ID to view' },
					},
					required: ['name'],
				},
				category: 'skills',
				source: source,
			},
			handler: async (args) => {
				const name = String(args['name'] ?? '').trim();
				if (!name) { return text(JSON.stringify({ success: false, error: 'name is required' })); }
				const skills = ctx.skillRegistry?.getSkills() ?? [];
				const skill = skills.find(s => s.id === name || s.name.toLowerCase() === name.toLowerCase());
				if (!skill) {
					return text(JSON.stringify({
						success: false,
						error: `Skill "${name}" not found. Use skills_list to see available skills.`,
					}));
				}
				return text(JSON.stringify({
					success: true,
					name: skill.name,
					id: skill.id,
					description: skill.description ?? '',
					content: (skill.prompt ?? '').slice(0, MAX_SKILL_BYTES),
				}, null, 2));
			},
		});

		ctx.register({
			definition: {
				name: 'list_skills',
				description: 'List all installed skills with their ids, names, descriptions, and activation modes. Use when you need to browse or search available skills.',
				inputSchema: {
					type: 'object',
					properties: {
						filter: {
							type: 'string',
							description: 'Optional keyword to filter skills by name or description',
						},
						category: {
							type: 'string',
							description: 'Optional category to filter by',
						},
					},
				},
				category: 'skills',
				source: source,
			},
			handler: async args => {
				const filter = String(args['filter'] ?? '').toLowerCase().trim();
				const category = String(args['category'] ?? '').toLowerCase().trim();

				let skills = [...ctx.skillRegistry.getSkills()].filter(s => s.enabled !== false);

				if (filter) {
					skills = skills.filter(s =>
						s.name.toLowerCase().includes(filter) ||
						s.description.toLowerCase().includes(filter) ||
						(s.match?.some(m => m.toLowerCase().includes(filter)) ?? false)
					);
				}
				if (category) {
					skills = skills.filter(s => (s.category ?? '').toLowerCase() === category);
				}

				// 对齐 Hermes skills_list 返回格式：JSON {skills, categories, count, hint}
				// 参考 Hermes tools/skills_tool.py::skills_list()
				const skillItems = skills.map(s => ({
					name: s.name,
					id: s.id,
					description: s.description || '',
					category: s.category ?? '',
					activation: s.activation,
					source: s.source ?? '',
				}));
				const categories = [...new Set(skills.map(s => s.category).filter(Boolean) as string[])].sort();
				const result: Record<string, any> = {
					success: true,
					skills: skillItems,
					categories,
					count: skillItems.length,
				};
				if (skillItems.length === 0) {
					// 对齐 Hermes：空结果时给出存储路径和创建指引，避免 LLM 用 file_list 查错目录
					result.message = 'No skills found. Skills directory is ~/.saros/skills/. Use skill_create to create new skills.';
					result.hint = 'Use skill_create(name="<slug>", content="<SKILL.md>") to create a new skill.';
				} else {
					result.hint = 'Use read_skill or skill_view to see full content';
					result.storagePath = '~/.saros/skills/';
				}
				return text(JSON.stringify(result, null, 2));
			},
		});

		// ── skills_list 别名（Hermes 命名）──────────────────────────
		// Hermes 用 skills_list，Sarosis 用 list_skills。注册别名对齐。
		// 参考 Hermes tools/skills_tool.py::skills_list()
		ctx.register({
			definition: {
				name: 'skills_list',
				description: 'List all available skills (progressive disclosure tier 1 - minimal metadata). Returns only name + description to minimize token usage. (Alias for list_skills)',
				inputSchema: {
					type: 'object',
					properties: {
						category: { type: 'string', description: 'Optional category filter (e.g., "mlops")' },
					},
				},
				category: 'skills',
				source: source,
			},
			handler: async (args) => {
				const category = String(args['category'] ?? '').toLowerCase().trim();
				let skills = [...ctx.skillRegistry.getSkills()].filter(s => s.enabled !== false);
				if (category) {
					skills = skills.filter(s => (s.category ?? '').toLowerCase() === category);
				}
				// 对齐 Hermes 格式：始终返回 message/hint 告知技能存储位置
				// Hermes 在空目录时提示路径，避免 LLM 用 file_list 去猜测目录位置
				const skillItems = skills.map(s => ({
					name: s.name,
					id: s.id,
					description: s.description || '',
					category: s.category ?? '',
				}));
				const categories = [...new Set(skills.map(s => s.category).filter(Boolean) as string[])].sort();
				const base = {
					success: true,
					skills: skillItems,
					categories,
					count: skillItems.length,
				};
				if (skillItems.length === 0) {
					return text(JSON.stringify({
						...base,
						message: 'No skills found. Skills directory is ~/.saros/skills/. Use skill_create to create new skills.',
						hint: 'Use skill_create(name="<slug>", content="<SKILL.md>") to create a new skill.',
					}, null, 2));
				}
				return text(JSON.stringify({
					...base,
					hint: 'Use skill_view(name) to see full content',
					storagePath: '~/.saros/skills/',
				}, null, 2));
			},
		});

		// ── skill_create: 创建新技能 ──────────────────────────────────
		// 参考 Hermes-Agent 的 skill_manage(action="create")。
		// 让 Agent 把成功的经验固化为可复用技能，写入 ~/.saros/skills/<name>/SKILL.md
		ctx.register({
			definition: {
				name: 'skill_create',
				description: SKILL_CREATE_TOOL_DESCRIPTION,
				inputSchema: SKILL_CREATE_TOOL_SCHEMA as Record<string, unknown>,
				category: 'skills',
				source: source,
				securityLevel: ToolSecurityLevel.Dangerous,
			},
			handler: async (args: Record<string, unknown>): Promise<IToolResultContent[]> => {
				const name = String(args['name'] ?? '').trim();
				const content = String(args['content'] ?? '');
				const category = args['category'] ? String(args['category']).trim() || undefined : undefined;

				if (!name) {
					return text('Error: name is required.');
				}
				if (!content) {
					return text('Error: content is required. Provide the full SKILL.md text (frontmatter + body).');
				}

				const result = await ctx.skillManagerTool.createSkill({ name, content, category });
				if (result.success) {
					return text([
						result.message,
						'',
						'The skill is now available for activation via /skill or list_skills.',
						'Use read_skill to verify its content.',
					].join('\n'));
				}
				return text(`Error: ${result.error ?? result.message}`);
			},
		});

		ctx.logService.info('[BuiltinTools] _registerSkillTools: read_skill, list_skills, and skill_create registered');

		// ── skill_manage: 对齐 Hermes skill_manager_tool.py ──────────────────
		// Hermes 支持 6 种 action：create / edit / patch / delete / write_file / remove_file
		// Sarosis 当前支持 create/edit（委托 skill_create），patch/delete 返回友好提示
		ctx.register({
			definition: {
				name: 'skill_manage',
				description: [
					'Manage skills (create, edit, patch, delete). Skills are your procedural memory — reusable approaches for recurring task types.',
					'Actions: create (full SKILL.md + optional category), patch (old_string/new_string for fixes), edit (full rewrite), delete.',
					'Create when: complex task succeeded (5+ calls), errors overcome, user-corrected approach worked.',
					'Update when: instructions stale/wrong, missing steps found during use.',
				].join(' '),
				inputSchema: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['create', 'patch', 'edit', 'delete'], description: 'The action to perform.' },
						name: { type: 'string', description: 'Skill name (lowercase, hyphens/underscores, max 64 chars).' },
						content: { type: 'string', description: 'Full SKILL.md content (YAML frontmatter + markdown body). Required for create and edit.' },
						old_string: { type: 'string', description: 'Text to find in the file (required for patch). Must be unique unless replace_all=true.' },
						new_string: { type: 'string', description: 'Replacement text (required for patch). Can be empty to delete matched text.' },
						replace_all: { type: 'boolean', description: 'For patch: replace all occurrences (default: false).' },
						category: { type: 'string', description: 'Optional category for organizing the skill (e.g., devops, data-science).' },
					},
					required: ['action', 'name'],
				},
				category: 'skills',
				source: source,
			},
			handler: async (args: Record<string, unknown>): Promise<IToolResultContent[]> => {
				const action = String(args['action'] ?? 'create');
				const name = String(args['name'] ?? '').trim();
				const content = String(args['content'] ?? '');
				const category = args['category'] ? String(args['category']).trim() || undefined : undefined;

				if (!name) { return text('Error: name is required'); }

				if (action === 'create' || action === 'edit') {
					if (!content) { return text('Error: content is required for create/edit. Provide the full SKILL.md text (frontmatter + body).'); }
					const result = await ctx.skillManagerTool.createSkill({ name, content, category });
					if (result.success) {
						return text(`${result.message}\n\nThe skill is now available. Use read_skill to verify.`);
					}
					return text(`Error: ${result.error ?? result.message}`);
				}

				if (action === 'patch') {
					const oldString = String(args['old_string'] ?? '');
					const newString = String(args['new_string'] ?? '');
					const replaceAll = Boolean(args['replace_all']);
					if (!oldString) { return text('Error: old_string is required for patch'); }
					// 读取技能文件 → 替换 → 写回
					try {
						const skills = ctx.skillRegistry?.getSkills() ?? [];
						const skill = skills.find(s => s.id === name || s.name.toLowerCase() === name.toLowerCase());
						if (!skill) { return text(`Error: Skill "${name}" not found. Use list_skills to see available skills.`); }
						// 使用 patch 工具的逻辑：读取 → 替换 → 写回
						const path = require('path');
						const os = require('os');
						const fs = await import('fs/promises');
						const skillPath = path.join(os.homedir(), '.saros', 'skills', name, 'SKILL.md');
						let fileContent = await fs.readFile(skillPath, 'utf-8');
						if (replaceAll) {
							fileContent = fileContent.split(oldString).join(newString);
						} else {
							const idx = fileContent.indexOf(oldString);
							if (idx === -1) { return text(`old_string not found in ${name}/SKILL.md`); }
							fileContent = fileContent.slice(0, idx) + newString + fileContent.slice(idx + oldString.length);
						}
						await fs.writeFile(skillPath, fileContent, 'utf-8');
						return text(`Patched skill "${name}" successfully.`);
					} catch (e) {
						return text(`Error patching skill "${name}": ${e instanceof Error ? e.message : String(e)}`);
					}
				}

				if (action === 'delete') {
					try {
						const path = require('path');
						const os = require('os');
						const fs = await import('fs/promises');
						const skillPath = path.join(os.homedir(), '.saros', 'skills', name);
						await fs.rm(skillPath, { recursive: true, force: true });
						return text(`Skill "${name}" deleted successfully.`);
					} catch (e) {
						return text(`Error deleting skill "${name}": ${e instanceof Error ? e.message : String(e)}`);
					}
				}

				return text(`Unknown action: ${action}. Use: create, patch, edit, delete`);
			},
		});}
