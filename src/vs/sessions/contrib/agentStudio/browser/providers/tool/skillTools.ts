/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill Tools — read_skill / list_skills / skill_manage / skill_search。
 *
 * 从 builtinToolProvider.ts 的 _registerSkillTools 抽出，降低主文件体积。
 * 借鉴 OpenClaw / Hermes 的按需加载模式：模型在 systemPrompt 看到轻量目录后，
 * 通过这些工具按需读取完整技能内容（progressive disclosure）。
 * Phase 2: skill_search 用 BM25 算法匹配用户查询与 skill description，
 * 替代简单的关键词字符串匹配，提升 skill 发现精度。
 */

// ── BM25 Skill Search ─────────────────────────────────────────────

interface SkillSearchEntry {
	id: string;
	name: string;
	description: string;
	/** 预计算的分词结果（name + description） */
	tokens: Set<string>;
}

/** 简单 BM25 评分（k1=1.2, b=0.75） */
function bm25Score(queryTokens: Set<string>, doc: SkillSearchEntry, avgDocLen: number, totalDocs: number): number {
	const k1 = 1.2;
	const b = 0.75;
	const docLen = doc.tokens.size;
	let score = 0;
	for (const term of queryTokens) {
		// IDF: log((N - n + 0.5) / (n + 0.5) + 1)
		const n = doc.tokens.has(term) ? 1 : 0;
		if (n === 0) continue;
		const idf = Math.log((totalDocs - n + 0.5) / (n + 0.5) + 1);
		// TF: (f * (k1 + 1)) / (f + k1 * (1 - b + b * docLen / avgDocLen))
		const tf = 1; // 每个 term 在 doc 中出现一次
		const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDocLen));
		score += idf * tfNorm;
	}
	return score;
}

function tokenize(text: string): Set<string> {
	return new Set(
		text.toLowerCase()
			.replace(/[^a-z0-9_\u4e00-\u9fff]/g, ' ')
			.split(/\s+/)
			.filter(w => w.length >= 2)
	);
}

import type { IToolResultContent } from '../../../common/providers.js';
import type { URI } from '../../../../../../base/common/uri.js';
import { SkillManagerTool } from '../../skillManagerTool.js';
import type { ISkillRegistry } from '../../../common/skills.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../../../common/sarosPaths.js';
import { IEnvironmentService } from '../../../../../../platform/environment/common/environment.js';

export interface SkillToolContext {
	register(registration: IBuiltinToolRegistration): void;
	skillRegistry: ISkillRegistry;
	skillManagerTool: SkillManagerTool;
	logService: ILogService;
	environmentService: IEnvironmentService;
	/** 技能读取钩子（read_skill 调用后触发，用于使用追踪） */
	onSkillRead?: (skillId: string, skillResource?: URI) => void;
	/** 技能修改钩子（skill_manage create/edit/patch 成功后触发） */
	onSkillMutated?: (skillName: string, skillDir?: URI) => void;
}

export function registerSkillTools(ctx: SkillToolContext): void {
	const source = 'saros.builtin-tools';
		const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];
		const MAX_SKILL_BYTES = 256_000; // 单个 skill 内容上限 256KB

	ctx.register({
		definition: {
			name: 'read_skill',
			description: 'Read the full instructions of an installed skill by its id. Use this when you need detailed instructions from a skill. Pass optional "path" to read a support file (references/, scripts/, assets/, templates/) listed in the skill\'s supportFiles.',
			inputSchema: {
				type: 'object',
				properties: {
					skill_id: {
						type: 'string',
						description: 'The skill id (from <available_skills> in this tool\'s description)',
					},
					path: {
						type: 'string',
						description: 'Optional relative path of a support file inside the skill (e.g., "references/api.md", "scripts/run.py"). When provided, returns that file\'s content instead of SKILL.md.',
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
			const supportPath = String(args['path'] ?? '').trim();

			let skill = ctx.skillRegistry.getSkill(skillId);
			if (!skill) {
				// 尝试模糊匹配（按 name）
				const allSkills = ctx.skillRegistry.getSkills();
				skill = allSkills.find(s => s.name.toLowerCase() === skillId.toLowerCase());
			}
			if (!skill) {
				return text(JSON.stringify({
					success: false,
					error: `Skill not found: "${skillId}". Use list_skills to see available skill ids.`,
				}));
			}

			// 使用追踪
			ctx.onSkillRead?.(skill.id, skill.resource);

			// 读取支持目录文件（references/scripts/assets/templates）— 渐进披露
			if (supportPath) {
				try {
					const fileContent = await ctx.skillRegistry.readSkillSupportFile(skill.id, supportPath);
					return text(JSON.stringify({
						success: true,
						name: skill.name,
						id: skill.id,
						path: supportPath,
						content: fileContent.slice(0, MAX_SKILL_BYTES),
					}, null, 2));
				} catch (e) {
					return text(JSON.stringify({
						success: false,
						error: `Failed to read support file "${supportPath}" in skill "${skill.id}": ${e instanceof Error ? e.message : String(e)}`,
						supportFiles: skill.supportFiles ?? [],
					}));
				}
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
			source: skill.source ?? '',
			isWorkflow: skill.source === 'workflow',
			workflowId: skill.workflowId ?? undefined,
			executable: skill.executor?.kind === 'workflow' ? true : undefined,
			supportFiles: skill.supportFiles ?? [],
			allowedTools: skill.allowedTools ?? undefined,
			model: skill.model ?? undefined,
		}, null, 2));
		},
	});

	// ── skill_search: BM25 算法匹配用户查询与 skill description ──
	ctx.register({
		definition: {
			name: 'skill_search',
			description: 'Search for the best matching skill using BM25 algorithm. Use this FIRST when a task might benefit from a specialized workflow. Returns matching skills ranked by relevance. Then use read_skill to load the full instructions of the best match.',
			inputSchema: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The search query describing the task (e.g., "analyze GC mechanism", "review code for bugs", "generate documentation")',
					},
					limit: {
						type: 'number',
						description: 'Maximum number of results to return (default: 3)',
					},
				},
				required: ['query'],
			},
			category: 'skills',
			source: source,
		},
		handler: async args => {
			const query = String(args['query'] ?? '').trim();
			if (!query) {
				return text(JSON.stringify({ success: false, error: 'query is required' }));
			}
			const limit = typeof args['limit'] === 'number' ? Math.max(1, Math.min(10, args['limit'])) : 3;

			const allSkills = ctx.skillRegistry.getSkills().filter(s => s.enabled !== false);
			if (allSkills.length === 0) {
				return text(JSON.stringify({ success: true, matches: [], message: 'No skills installed' }));
			}

			// Build search index
			const entries: SkillSearchEntry[] = allSkills.map(s => ({
				id: s.id,
				name: s.name,
				description: s.description ?? '',
				tokens: tokenize(`${s.name} ${s.description ?? ''} ${s.id}`),
			}));

			const queryTokens = tokenize(query);
			const totalDocs = entries.length;
			const avgDocLen = entries.reduce((sum, e) => sum + e.tokens.size, 0) / totalDocs;

			// Score all skills
			const scored = entries
				.map(e => ({ ...e, score: bm25Score(queryTokens, e, avgDocLen, totalDocs) }))
				.filter(e => e.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit);

			if (scored.length === 0) {
				return text(JSON.stringify({
					success: true,
					matches: [],
					message: `No skills match "${query}". Try different keywords or use list_skills to browse all skills.`,
				}));
			}

			return text(JSON.stringify({
				success: true,
				query,
				matches: scored.map(s => ({
					skill_id: s.id,
					name: s.name,
					description: s.description,
					score: Math.round(s.score * 100) / 100,
				})),
				message: scored.length === 1
					? `Best match: "${scored[0].name}". Use read_skill with skill_id="${scored[0].id}" to load full instructions.`
					: `Top ${scored.length} matches. Use read_skill with the best matching skill_id.`,
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
			isWorkflow: s.source === 'workflow',
			workflowId: s.workflowId ?? undefined,
			executable: s.executor?.kind === 'workflow' ? true : undefined,
			supportFileCount: s.supportFiles?.length || undefined,
			allowedTools: s.allowedTools ?? undefined,
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
					result.message = 'No skills found. Skills directory is ~/.vssaros/saros/skills/. Use skill_manage with action="create" to create new skills.';
					result.hint = 'Use skill_manage(action="create", name="<slug>", content="<SKILL.md>") to create a new skill.';
				} else {
					result.hint = 'Use read_skill to see full content';
					result.storagePath = '~/.vssaros/saros/skills/';
				}
				return text(JSON.stringify(result, null, 2));
			},
		});


		ctx.logService.info('[BuiltinTools] _registerSkillTools: read_skill, list_skills registered (skill creation via skill_manage action=create)');

		// ── skill_manage: 对齐 Hermes skill_manager_tool.py ──────────────────
		// Hermes 支持 6 种 action：create / edit / patch / delete / write_file / remove_file
		// Sarosis 完整支持 create（新建）/ edit（全量覆盖）/ patch（精确替换）/ delete。
		// 相比旧版改进：edit→updateSkill（不再拒绝已存在技能），patch→patchSkill（带唯一性+有效性校验+备份）
		ctx.register({
			definition: {
				name: 'skill_manage',
				description: [
					'Manage skills (create, edit, patch, delete). Skills are your procedural memory — reusable approaches for recurring task types.',
					'create: Write a new SKILL.md. Fails if the skill already exists.',
					'edit: Replace the entire SKILL.md of an existing skill with new content. Use this to update stale/wrong instructions.',
					'patch: Replace a specific text snippet in an existing SKILL.md. Safer than edit for small fixes. old_string must be unique unless replace_all=true.',
					'delete: Remove a skill entirely.',
				].join(' '),
				inputSchema: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['create', 'patch', 'edit', 'delete'], description: 'create=new skill, edit=full rewrite of existing skill, patch=targeted text replacement, delete=remove.' },
						name: { type: 'string', description: 'Skill name (lowercase, hyphens/underscores, max 64 chars).' },
						content: { type: 'string', description: 'Full SKILL.md content (YAML frontmatter + markdown body). Required for create and edit.' },
						old_string: { type: 'string', description: 'Text to find in the file (required for patch). Must be unique unless replace_all=true. Match whitespace and newlines exactly.' },
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

				if (action === 'create') {
					if (!content) { return text('Error: content is required for create. Provide the full SKILL.md text (frontmatter + body).'); }
					const result = await ctx.skillManagerTool.createSkill({ name, content, category });
					if (result.success) {
						return text(`${result.message}\n\nThe skill is now available. Use read_skill to verify.`);
					}
					// 如果是"已存在"错误，提示使用 edit 或 patch
					if (result.error?.includes('already exists')) {
						return text(
							`Error: ${result.error}\n\n`
							+ `Tip: Use skill_manage(action="edit", content="<full SKILL.md>") to rewrite the existing skill, `
							+ `or skill_manage(action="patch", old_string="...", new_string="...") for targeted fixes.`
						);
					}
					return text(`Error: ${result.error ?? result.message}`);
				}

				if (action === 'edit') {
					if (!content) { return text('Error: content is required for edit. Provide the full updated SKILL.md text (frontmatter + body).'); }
					const result = await ctx.skillManagerTool.updateSkill({ name, content, category });
					if (result.success) {
						return text(`${result.message}\n\nThe updated skill is now available. Use read_skill to verify.`);
					}
					return text(`Error: ${result.error ?? result.message}`);
				}

				if (action === 'patch') {
					const oldString = String(args['old_string'] ?? '');
					const newString = String(args['new_string'] ?? '');
					const replaceAll = Boolean(args['replace_all']);
					if (!oldString) { return text('Error: old_string is required for patch. Provide the exact text to replace (matching whitespace and newlines exactly).'); }

					const result = await ctx.skillManagerTool.patchSkill(name, oldString, newString, replaceAll);
					if (result.success) {
						return text(`${result.message}\n\nUse read_skill to verify the patch was applied correctly.`);
					}
					return text(`Error: ${result.error ?? result.message}`);
				}

				if (action === 'delete') {
					try {
						const fs = await import('fs/promises');
						const sarosRoot = userDataRootFromRoamingHome(ctx.environmentService.userRoamingDataHome);
						const skillPath = resolveSarosPath(sarosRoot, SarosPath.skills, name).fsPath;
						await fs.rm(skillPath, { recursive: true, force: true });
						return text(`Skill "${name}" deleted successfully.`);
					} catch (e) {
						return text(`Error deleting skill "${name}": ${e instanceof Error ? e.message : String(e)}`);
					}
				}

				return text(`Unknown action: ${action}. Use: create, patch, edit, delete`);
			},
		});}
