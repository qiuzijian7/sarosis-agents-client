/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IModelSelectorService } from '../common/modelSelector.js';
import { IAgentStudioService } from '../../../common/agentStudioService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISkillRegistry } from '../common/skills.js';
import { IAgentOSService } from '../common/agentOS.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { resolveSarosPath, SarosPath } from '../common/sarosPaths.js';
import { buildSkillMd, toSkillSlug, parseSkillMd } from '../common/extractSkill.js';

/**
 * Host bridge so the controller can read/write pane-owned state
 * (current agent + its skill list) and trigger UI refreshes without
 * holding a reference to the EditorPane.
 */
export interface ISkillExtractionHost {
	/** Current chat box's agent id (or null when none selected). */
	getCurrentAgentId(): string | null;
	/** Persist the updated skill list for the current agent back to the pane. */
	setCurrentAgentSkills(skills: string[]): void;
	/** Refresh the open MemoryDetailEditorPane if any. */
	refreshMemoryDetailPane(): Promise<void>;
}

/**
 * SkillExtractionController — extracts "save skill" feature from
 * NativeChatEditorPane (~230 lines). It reads an LLM reply message,
 * asks the model to extract a reusable SKILL.md, writes it atomically
 * to ~/.vssaros/skills/<agentSlug>/SKILL.md, mounts it to the agent,
 * and syncs it to the memory engine.
 */
export class SkillExtractionController extends Disposable {

	constructor(
		private readonly _notificationService: INotificationService,
		private readonly _modelSelector: IModelSelectorService,
		private readonly _agentStudioService: IAgentStudioService,
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
		private readonly _skillRegistry: ISkillRegistry,
		private readonly _agentOSService: IAgentOSService,
		private readonly _envService: INativeEnvironmentService,
		private readonly _host: ISkillExtractionHost,
	) {
		super();
	}

	/**
	 * 沉淀技能 —— 从 LLM 回复消息中提取可复用的技能，写入 SKILL.md。
	 *
	 * 流程：
	 *   1. 从消息内容提取 name / description / prompt
	 *   2. 构建 SKILL.md（YAML frontmatter + markdown body）
	 *   3. 原子写入 ~/.vssaros/skills/<name>/SKILL.md
	 *   4. 触发 SkillRegistry.reload()
	 *   5. 通知用户结果
	 *
	 * 同名技能：
	 *   - 如果 SKILL.md 已存在 → 追加 timestamp 后缀创建新版本
	 *   - 如果 skill 已在 registry 中但文件名不冲突 → 更新现有内容
	 */
	async handleExtractSkill(content: string): Promise<void> {
		try {
			const currentAgentId = this._host.getCurrentAgentId();
			if (!currentAgentId) {
				this._notificationService.notify({
					severity: Severity.Error,
					message: '沉淀技能失败：当前未选中 Agent',
					source: 'agent-chat-extract-skill',
				});
				return;
			}

			// 1. 技能名称 = agentId 的 slug 形式
			const agentSlug = toSkillSlug(currentAgentId);

			// 2. Hyper-Extract 风格：LLM structured output 提取 + 意图分类
			const sel = this._modelSelector.getSelection();
			const modelOpts = sel ? { providerId: sel.providerId, modelId: sel.modelId } : undefined;
			const extracted = await this._agentStudioService.extractSkillContent(content, modelOpts);

			if (!extracted.isSkill) {
				// LLM 判定非技能内容 → 拒绝提取并告知原因
				this._notificationService.notify({
					severity: Severity.Warning,
					message: `未沉淀：${extracted.reason}`,
					source: 'agent-chat-extract-skill',
				});
				return;
			}

			const newDescription = extracted.description;
			const newPrompt = extracted.prompt;

			// 3. 确定目标路径 (~/.vssaros/skills/{agentSlug}/SKILL.md)
			const skillsRoot = resolveSarosPath(URI.file(this._envService.userDataPath), SarosPath.skills);
			const skillMdUri = URI.joinPath(skillsRoot, agentSlug, 'SKILL.md');

			let finalSkillMd: string;
			let isNew = false;

			// 4. 检查是否已有同名技能文件
			let existingContent = '';
			try {
				await this._fileService.stat(skillMdUri);  // 检查存在性
				const existingRead = await this._fileService.readFile(skillMdUri);
				existingContent = existingRead.value.toString();
			} catch {
				isNew = true;
			}

			if (isNew) {
				// 无已有文件 → 直接创建
				finalSkillMd = buildSkillMd(agentSlug, newDescription, newPrompt);
			} else {
				// 已有文件 → 调 LLM 融合新旧内容
				finalSkillMd = await this._mergeSkillWithLLM(
					agentSlug, existingContent, newDescription, newPrompt,
				);
			}

			// 5. 原子写入
			const tmpUri = URI.joinPath(skillsRoot, `.skill_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
			try {
				await this._fileService.writeFile(tmpUri, VSBuffer.fromString(finalSkillMd));
				await this._fileService.move(tmpUri, skillMdUri, true);
			} catch (writeErr) {
				try { await this._fileService.del(tmpUri); } catch { /* ignore */ }
				throw writeErr;
			}

			// 6. 写入附属脚本（Hyper-Extract 风格）
			if (extracted.scripts && extracted.scripts.length > 0) {
				for (const script of extracted.scripts) {
					try {
						const scriptUri = URI.joinPath(skillsRoot, agentSlug, 'scripts', script.filename);
						await this._fileService.writeFile(scriptUri, VSBuffer.fromString(script.content));
						this._logService.info(`[SkillExtractionController] wrote skill script: ${scriptUri.fsPath}`);
					} catch (scriptErr) {
						this._logService.warn(`[SkillExtractionController] failed to write skill script ${script.filename}: ${scriptErr instanceof Error ? scriptErr.message : String(scriptErr)}`);
					}
				}
			}

			// 7. 触发 SkillRegistry reload
			try {
				await this._skillRegistry.reload();
			} catch (reloadErr) {
				this._logService.warn(`[SkillExtractionController] skill reload after extract failed: ${reloadErr instanceof Error ? reloadErr.message : String(reloadErr)}`);
			}

			// 7. 同步到记忆引擎
			try {
				const memProvider = this._agentOSService.getActiveMemoryProvider();
				if (memProvider?.writeSkillFile && currentAgentId) {
					await memProvider.writeSkillFile(currentAgentId, agentSlug);
				}
			} catch (syncErr) {
				this._logService.warn(`[SkillExtractionController] skill sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`);
			}

			// 8. 挂载到当前 Agent：如果 Agent 尚未拥有该技能，自动加入其 skills 列表
			if (currentAgentId) {
				try {
					const agent = await this._agentStudioService.getAgent(currentAgentId);
					if (agent && !(agent.skills ?? []).includes(agentSlug)) {
						const newSkills = [...(agent.skills ?? []), agentSlug];
						await this._agentStudioService.updateAgent(currentAgentId, { skills: newSkills } as any);
						this._host.setCurrentAgentSkills(newSkills);
						this._logService.info(`[SkillExtractionController] skill "${agentSlug}" mounted to agent "${currentAgentId}"`);
					}
				} catch (mountErr) {
					this._logService.warn(`[SkillExtractionController] mount skill to agent failed: ${mountErr instanceof Error ? mountErr.message : String(mountErr)}`);
				}
			}

			// 9. 刷新 MemoryDetailEditorPane
			await this._host.refreshMemoryDetailPane();

			// 9. 通知
			const verb = isNew ? '已创建' : '已融合更新';
			this._logService.info(`[SkillExtractionController] ${verb}技能 [name=${agentSlug}]: ${skillMdUri.fsPath}`);
			this._notificationService.notify({
				severity: Severity.Info,
				message: `${verb}技能：${agentSlug}`,
				source: 'agent-chat-extract-skill',
			});

		} catch (err) {
			this._logService.error('[SkillExtractionController] 沉淀技能失败:', err);
			this._notificationService.notify({
				severity: Severity.Error,
				message: `沉淀技能失败：${err instanceof Error ? err.message : String(err)}`,
				source: 'agent-chat-extract-skill',
			});
		}
	}

	/**
	 * 调 LLM 融合已有技能内容和新沉淀内容，生成符合 SKILL.md 格式的合并结果。
	 */
	private async _mergeSkillWithLLM(
		agentSlug: string,
		existingContent: string,
		newDescription: string,
		newPrompt: string,
	): Promise<string> {
		const selection = this._agentOSService.getActiveModelSelection();
		const providers = this._agentOSService.getModelProviders();
		const modelProvider = providers.find(p => p.id === selection?.providerId);
		if (!modelProvider || !selection?.modelId) {
			// 无可用模型 → 退回简单拼接
			const existing = parseSkillMd(existingContent);
			const mergedDesc = existing?.description
				? `${existing.description}; ${newDescription}`
				: newDescription;
			const mergedPrompt = existing?.prompt
				? `${existing.prompt}\n\n---\n\n## 新增内容\n\n${newPrompt}`
				: newPrompt;
			return buildSkillMd(agentSlug, mergedDesc, mergedPrompt);
		}

		const mergePrompt = [
			'You are a skill content merger. Given an existing SKILL.md file and new extracted content,',
			'produce a SINGLE merged SKILL.md file that:',
			'  1. Uses the YAML frontmatter format (name, description, optional category)',
			'  2. The "name" field MUST be exactly: ' + agentSlug,
			'  3. Merges descriptions: keep the best parts of both, produce one concise description (max 200 chars)',
			'  4. Merges the body: deduplicate overlapping instructions, preserve unique steps from both, organize logically',
			'  5. Keeps the output as a valid SKILL.md with frontmatter followed by markdown body',
			'',
			'Output ONLY the merged SKILL.md content (no explanation, no markdown fences around it).',
			'',
			'=== EXISTING SKILL.md ===',
			existingContent,
			'=== NEW CONTENT ===',
			'Description: ' + newDescription,
			'Body:',
			newPrompt,
		].join('\n');

		const t0 = Date.now();
		const stream = modelProvider.chat(
			selection.modelId,
			[{ role: 'user', content: mergePrompt }],
			{ temperature: 0.3, maxTokens: 4000 },
			{},
		);

		let result = '';
		for await (const delta of stream) {
			if (delta.type === 'text' && delta.content) {
				result += delta.content;
			}
			if (delta.type === 'done') { break; }
		}

		const trimmed = result.trim();
		if (!trimmed) {
			throw new Error('LLM 融合返回空结果');
		}

		this._logService.info(`[SkillExtractionController] skill LLM merge completed in ${Date.now() - t0}ms, ${trimmed.length} chars`);

		// 验证输出是有效 SKILL.md 格式
		if (parseSkillMd(trimmed)) {
			return trimmed;
		}

		// LLM 输出格式不符 → 强制纠正：重新构建标准 SKILL.md
		const parts = parseSkillMd(existingContent);
		const mergedDesc = parts?.description
			? `${parts.description}; ${newDescription}`
			: newDescription;
		return buildSkillMd(agentSlug, mergedDesc, trimmed);
	}
}
