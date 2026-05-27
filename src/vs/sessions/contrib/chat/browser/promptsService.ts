/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { FileAccess } from '../../../../base/common/network.js';
import { SKILL_FILENAME } from '../../../../workbench/contrib/chat/common/promptSyntax/config/promptFileLocations.js';
import { PromptsType } from '../../../../workbench/contrib/chat/common/promptSyntax/promptTypes.js';
import { IAgentSkill, IPromptPath, PromptsStorage } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { BUILTIN_STORAGE, IBuiltinPromptPath } from '../common/builtinPromptsStorage.js';

/** URI root for built-in skills bundled with the Agents app. */
// 技能现在存储在 resources/.agents/skills/ 目录
// 使用 FileAccess.asFileUri 获取 vs/ 目录，然后向上导航到项目根目录
// 注意：FileAccess.asFileUri 返回的是 vscode-file:// 协议的 URI，在浏览器环境中可用
export const BUILTIN_SKILLS_URI = FileAccess.asFileUri('vs/../../resources/.agents/skills');

/**
 * Sessions-specific PromptsService that additionally discovers built-in skills
 * bundled at `vs/sessions/skills/{folder}/SKILL.md`.
 *
 * Built-in skills are merged into `findAgentSkills()` and exposed via
 * `listPromptFilesForStorage(skill, BUILTIN_STORAGE)` so that the existing
 * AI customization UI (groups, badges, overrides) picks them up naturally.
 *
 * User/workspace skills with the same folder name take precedence (built-ins
 * are appended last and filtered when overridden).
 */
export class AgenticPromptsService extends PromptsService {

	private _builtinSkillsCache: Promise<readonly IAgentSkill[]> | undefined;

	private async getBuiltinSkills(): Promise<readonly IAgentSkill[]> {
		if (!this._builtinSkillsCache) {
			this._builtinSkillsCache = this.discoverBuiltinSkills();
		}
		return this._builtinSkillsCache;
	}

	private async discoverBuiltinSkills(): Promise<readonly IAgentSkill[]> {
		try {
			this.logger.info(`[AgenticPromptsService] discoverBuiltinSkills: resolving ${BUILTIN_SKILLS_URI}`);
			const stat = await this.fileService.resolve(BUILTIN_SKILLS_URI);
			if (!stat.children) {
				this.logger.info(`[AgenticPromptsService] discoverBuiltinSkills: no children found`);
				return [];
			}

			this.logger.info(`[AgenticPromptsService] discoverBuiltinSkills: found ${stat.children.length} children`);
			const skills: IAgentSkill[] = [];
			for (const child of stat.children) {
				if (!child.isDirectory) {
					continue;
				}
				const skillFileUri = joinPath(child.resource, SKILL_FILENAME);
				try {
					const parsed = await this.parseNew(skillFileUri, CancellationToken.None);
					const rawName = parsed.header?.name;
					const rawDescription = parsed.header?.description;
					if (!rawName || !rawDescription) {
						this.logger.info(`[AgenticPromptsService] discoverBuiltinSkills: skill ${skillFileUri} missing name or description, skipping`);
						continue;
					}
					const name = sanitizeSkillText(rawName, 64);
					const description = sanitizeSkillText(rawDescription, 1024);
					const folderName = basename(child.resource);
					if (name !== folderName) {
						this.logger.info(`[AgenticPromptsService] discoverBuiltinSkills: skill ${skillFileUri} name ${name} !== folderName ${folderName}, skipping`);
						continue;
					}
					skills.push({
						uri: skillFileUri,
						storage: BUILTIN_STORAGE as PromptsStorage,
						name,
						description,
						disableModelInvocation: parsed.header?.disableModelInvocation === true,
						userInvocable: parsed.header?.userInvocable !== false,
					});
				} catch (e) {
					this.logger.warn(`[AgenticPromptsService] Failed to parse built-in skill: ${skillFileUri}`, e instanceof Error ? e.message : String(e));
				}
			}
			this.logger.info(`[AgenticPromptsService] discoverBuiltinSkills: discovered ${skills.length} skills`);
			return skills;
		} catch (e) {
			this.logger.error(`[AgenticPromptsService] discoverBuiltinSkills: error`, e instanceof Error ? e.message : String(e));
			return [];
		}
	}

	private async getBuiltinSkillPaths(): Promise<readonly IBuiltinPromptPath[]> {
		const skills = await this.getBuiltinSkills();
		return skills.map(s => ({
			uri: s.uri,
			storage: BUILTIN_STORAGE,
			type: PromptsType.skill,
			name: s.name,
			description: s.description,
		}));
	}

	public override async findAgentSkills(token: CancellationToken): Promise<IAgentSkill[] | undefined> {
		const baseResult = await super.findAgentSkills(token);
		if (baseResult === undefined) {
			return undefined;
		}

		const builtinSkills = await this.getBuiltinSkills();
		if (builtinSkills.length === 0) {
			return baseResult;
		}

		const existingNames = new Set(
			baseResult
				.filter(s => s.storage === PromptsStorage.local || s.storage === PromptsStorage.user)
				.map(s => s.name)
		);
		const disabledSkills = this.getDisabledPromptFiles(PromptsType.skill);
		const nonOverridden = builtinSkills.filter(s => !existingNames.has(s.name) && !disabledSkills.has(s.uri));
		if (nonOverridden.length === 0) {
			return baseResult;
		}

		return [...baseResult, ...nonOverridden];
	}

	public override async listPromptFiles(type: PromptsType, token: CancellationToken): Promise<readonly IPromptPath[]> {
		this.logger.info(`[AgenticPromptsService] listPromptFiles(type=${type}) called`);
		const baseResults = await super.listPromptFiles(type, token);
		this.logger.info(`[AgenticPromptsService] listPromptFiles(type=${type}): baseResults count=${baseResults.length}`);

		if (type !== PromptsType.skill) {
			this.logger.info(`[AgenticPromptsService] listPromptFiles(type=${type}): not skill type, returning baseResults`);
			return baseResults;
		}

		const builtinItems = await this.getBuiltinSkillPaths();
		this.logger.info(`[AgenticPromptsService] listPromptFiles(type=skill): builtinItems count=${builtinItems.length}`);

		if (builtinItems.length === 0) {
			this.logger.info(`[AgenticPromptsService] listPromptFiles(type=skill): no builtin items, returning baseResults`);
			return baseResults;
		}

		// Filter out built-ins overridden by user/workspace skills of the same folder name.
		const overriddenNames = new Set<string>();
		for (const p of baseResults) {
			if (p.storage === PromptsStorage.local || p.storage === PromptsStorage.user) {
				overriddenNames.add(basename(dirname(p.uri)));
			}
		}
		const nonOverridden = builtinItems.filter(p => !overriddenNames.has(basename(dirname(p.uri))));
		this.logger.info(`[AgenticPromptsService] listPromptFiles(type=skill): nonOverridden builtin count=${nonOverridden.length}`);

		// Built-in items use BUILTIN_STORAGE ('builtin') which is not in the core
		// IPromptPath union but is handled by the sessions UI layer.
		const result = [...baseResults, ...nonOverridden] as readonly IPromptPath[];
		this.logger.info(`[AgenticPromptsService] listPromptFiles(type=skill): final result count=${result.length}`);
		return result;
	}

	public override async listPromptFilesForStorage(type: PromptsType, storage: PromptsStorage, token: CancellationToken): Promise<readonly IPromptPath[]> {
		if ((storage as PromptsStorage | typeof BUILTIN_STORAGE) === BUILTIN_STORAGE) {
			if (type === PromptsType.skill) {
				return this.getBuiltinSkillPaths() as Promise<readonly IPromptPath[]>;
			}
			return [];
		}
		return super.listPromptFilesForStorage(type, storage, token);
	}
}

/**
 * Strips XML tags and truncates to the given max length.
 * Matches the sanitization applied by PromptsService for other skill sources.
 */
function sanitizeSkillText(text: string, maxLength: number): string {
	const sanitized = text.replace(/<[^>]+>/g, '');
	return sanitized.length > maxLength ? sanitized.substring(0, maxLength) : sanitized;
}
