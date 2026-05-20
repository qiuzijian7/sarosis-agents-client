/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAgentDriverService, AgentTurnStatus } from '../common/agentDriver.js';
import { IAgentTurnRequest, IMemoryContext } from '../common/providers.js';
import type { IChatStreamDelta } from '../common/providers.js';
import { IAgentOSService } from '../common/agentOS.js';
import type { IChatSendOptions } from '../common/agentStudio.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISkillRegistry } from '../common/skills.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { AGENT_STUDIO_SKILLS_MAX_IN_PROMPT_SETTING, AGENT_STUDIO_SKILLS_MAX_PROMPT_CHARS_SETTING } from '../common/constants.js';

// ─── Agent Driver Service Implementation ────────────────────────

export class AgentDriverService extends Disposable implements IAgentDriverService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTurnStatus = this._register(new Emitter<AgentTurnStatus>());
	readonly onDidChangeTurnStatus = this._onDidChangeTurnStatus.event;

	private readonly _turnStatusMap = new Map<string, AgentTurnStatus>();
	private readonly _activeTurns = new Map<string, AbortController>();
	private readonly _logService: ILogService;

	constructor(
		@IAgentOSService private readonly _agentOS: IAgentOSService,
		@ISkillRegistry private readonly _skillRegistry: ISkillRegistry,
		@ILogService logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
	) {
		super();
		this._logService = logService;
	}

	// ─── 统一执行入口 ─────────────────────────────────────

	async *executeTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta> {
		// Composite turnId: session-scoped to prevent cross-fork cancellation
		const turnId = request.sessionId ? `${request.sessionId}::${request.agentId}` : request.agentId;

		// 如果已有同 ID 的轮次在运行，先取消
		this.cancelTurn(turnId);

		const controller = new AbortController();
		this._activeTurns.set(turnId, controller);

		try {
			this._updateTurnStatus(turnId, AgentTurnStatus.Running);

			// ─── 完整编排逻辑 ─────────────────────────────────
			// 1. Planning Slot 分析意图（如果有 Planning Provider）
			// 2. Memory Slot 加载上下文（如果有 Memory Provider）
			// 3. 委托 AgentOS 执行（ExecutionProvider 或 直通模式）
			// 4. Memory Slot 写回记忆（如果有 Memory Provider）
			// 5. 返回结果给 UI

			// Step 1: 加载 Memory 上下文
			let memoryContext: IMemoryContext | undefined;
			const memoryProvider = this._agentOS.getActiveMemoryProvider();
			if (memoryProvider) {
				try {
					memoryContext = await memoryProvider.loadContext(request.agentId, request.sessionId || '');
					this._logService.debug(`[AgentDriver] Loaded memory context for ${request.agentId}`);
				} catch (error) {
					this._logService.error('[AgentDriver] Failed to load memory context:', error);
				}
			}

			// Step 2: Planning 分析意图（如果有 Planning Provider）
			const planningProvider = this._agentOS.getActivePlanningProvider();
			if (planningProvider && memoryContext) {
				try {
					const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
					if (lastUserMessage) {
						const plan = await planningProvider.analyzeIntent(lastUserMessage.content, memoryContext);
						this._logService.info(`[AgentDriver] Planning result: intent="${plan.intent}", complexity=${plan.estimatedComplexity}, steps=${plan.steps.length}`);

						// 如果规划了复杂任务，yield planning 信息给 UI
						if (plan.estimatedComplexity === 'high' || plan.estimatedComplexity === 'medium') {
							yield {
								type: 'thinking',
								content: `[Planning] Intent: ${plan.intent}\n[Planning] Complexity: ${plan.estimatedComplexity}\n[Planning] Steps: ${plan.steps.length}`,
							};
						}
					}
				} catch (error) {
					this._logService.error('[AgentDriver] Planning analysis failed:', error);
					// Planning 失败不阻塞主流程
				}
			}

		// Step 3: 解析并注入已激活的 Skills + 已安装技能清单
		const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
		let enrichedRequest = request;

		try {
			// 3a. 生成已安装技能清单 —— 借鉴 OpenClaw 轻量目录模式
			// 只在 systemPrompt 中放 name + description + id，让模型通过 read_skill 工具按需读取全文
			const allSkills = [...this._skillRegistry.getSkills()].filter(s => s.enabled !== false);
			let mergedSystemPrompt = request.systemPrompt || '';

			// 注入工作区上下文，让模型始终知晓当前工作区信息
			const workspaceContext = await this._buildWorkspaceContext(request.agentId);
			if (workspaceContext) {
				mergedSystemPrompt = mergedSystemPrompt + '\n\n' + workspaceContext;
			}

		if (allSkills.length > 0) {
			// 预算控制：从配置中读取，失败时使用默认值
			const MAX_SKILLS_IN_PROMPT = this._configurationService.getValue<number>(AGENT_STUDIO_SKILLS_MAX_IN_PROMPT_SETTING) ?? 150;
			const MAX_SKILLS_PROMPT_CHARS = this._configurationService.getValue<number>(AGENT_STUDIO_SKILLS_MAX_PROMPT_CHARS_SETTING) ?? 18000;

			// 分离 always 类型（必须展示）和其他类型
			const alwaysSkills = allSkills.filter(s => s.activation === 'always');
			const onDemandSkills = allSkills.filter(s => s.activation !== 'always');

			// 构建 OpenClaw 风格的 XML 目录
			const buildSkillEntry = (s: typeof allSkills[0], compact: boolean): string => {
				const lines = ['  <skill>'];
				lines.push(`    <name>${s.name}</name>`);
				if (!compact && s.description) {
					lines.push(`    <description>${s.description}</description>`);
				}
				lines.push(`    <id>${s.id}</id>`);
				lines.push(`    <activation>${s.activation}</activation>`);
				lines.push('  </skill>');
				return lines.join('\n');
			};

			// 策略：先尝试完整格式，超预算则降级为 compact（去 description）
			let skillsToInclude = [...alwaysSkills, ...onDemandSkills].slice(0, MAX_SKILLS_IN_PROMPT);
			let compact = false;
			let skillsXml = skillsToInclude.map(s => buildSkillEntry(s, false)).join('\n');
			if (skillsXml.length > MAX_SKILLS_PROMPT_CHARS) {
				// 降级为 compact 模式
				compact = true;
				skillsXml = skillsToInclude.map(s => buildSkillEntry(s, true)).join('\n');
				// 如果仍超限，二分截断
				if (skillsXml.length > MAX_SKILLS_PROMPT_CHARS) {
					let lo = 0, hi = skillsToInclude.length;
					while (lo < hi) {
						const mid = Math.floor((lo + hi + 1) / 2);
						const candidate = skillsToInclude.slice(0, mid).map(s => buildSkillEntry(s, true)).join('\n');
						if (candidate.length <= MAX_SKILLS_PROMPT_CHARS) { lo = mid; } else { hi = mid - 1; }
					}
					skillsToInclude = skillsToInclude.slice(0, lo);
					skillsXml = skillsToInclude.map(s => buildSkillEntry(s, true)).join('\n');
				}
			}

			const skillListSection = [
				'',
				'## Skills',
				'',
				'Scan <available_skills> below. If one clearly applies to the user\'s task, use the `read_skill` tool with the skill id to load its full instructions, then follow them.',
				'If several apply, choose the most specific. If none clearly apply, read none.',
				'One skill at a time max. Never guess/fabricate skill content.',
				'',
				'<available_skills>',
				skillsXml,
				'</available_skills>',
				'',
				compact ? `(${allSkills.length} skills total, showing ${skillsToInclude.length} in compact mode)` : `(${allSkills.length} skills total)`,
				'',
			].join('\n');
			mergedSystemPrompt = mergedSystemPrompt + skillListSection;
		}

			// 3a-2. 注入已启用工具的使用指引（让模型知道有工具可用）
			try {
				const allTools = await this._agentOS.listAllToolsWithState(request.agentId);
				const enabledTools = allTools.filter(t => t.enabled);
				if (enabledTools.length > 0) {
					const toolSection = [
						'',
						'## Available Tools',
						'',
						'You have access to the following tools. When a user asks you to perform an action that requires interacting with the filesystem, executing commands, searching the web, or any other external system, you MUST use the appropriate tool instead of explaining that you cannot do it.',
						'',
						'CRITICAL: You MUST ONLY use the exact tool names listed below. Do NOT invent or guess tool names (e.g., do NOT use "os.getcwd", "read_file", etc.). Use ONLY the names from this list.',
						'',
						'Available tools:',
						'',
						...enabledTools.map(t => `- ${t.name}: ${t.description || 'No description'}`),
						'',
						'Usage rules:',
						'- To execute a shell command (e.g., "print current directory", "list files"), use: **terminal** with {"command": "<your command>"}',
						'- To read a file, use: **file_read** with {"path": "<file path>"}',
						'- To write a file, use: **file_write** with {"path": "<file path>", "content": "<content>"}',
						'- To search files, use: **search_files** with {"path": "<directory>", "pattern": "<pattern>"}',
						'',
						'When you need to use a tool, respond with a function call using the exact tool name and required arguments.',
						'',
						'IMPORTANT: When you need to use a tool, you MUST use the exact tool name from the list above and provide the required arguments.',
						'If your model supports function calling, use the native function_call format.',
						'If your model does NOT support function calling, output a JSON object in this exact format: {"name": "<tool_name>", "arguments": {<args>}}.',
						'Never output tool calls as plain text explanations or code blocks without the proper format.',
						'',
					].join('\n');
					mergedSystemPrompt = mergedSystemPrompt + toolSection;
					this._logService.info(`[AgentDriver] Injected ${enabledTools.length} enabled tools into systemPrompt`);
				}
			} catch (error) {
				this._logService.warn('[AgentDriver] Failed to inject tool inventory:', error);
			}

			// 3b. 解析本轮激活的技能内容并注入
				let mergedMessages = [...request.messages];

				if (lastUserMessage) {
					const injections = await this._skillRegistry.resolveActivations({
						userMessage: lastUserMessage.content,
						agentId: request.agentId,
						sessionId: request.sessionId,
					});

					if (injections.length > 0) {
						// 分离 system 和 user 注入
						const systemInjections = injections.filter(inj => inj.placement === 'system');
						const userInjections = injections.filter(inj => inj.placement === 'user');

						// 将 system 类型的 skill 注入追加到 systemPrompt
						// 借鉴 OpenClaw：短 skill（<500 chars）直接注入，长 skill 只放摘要
						const ALWAYS_SKILL_INLINE_THRESHOLD = 500;
						if (systemInjections.length > 0) {
							const activeParts: string[] = [];
							for (const inj of systemInjections) {
								if (inj.skill.prompt.length <= ALWAYS_SKILL_INLINE_THRESHOLD) {
									// 短 skill：直接内联注入全文
									activeParts.push(inj.content);
								} else {
									// 长 skill：只放摘要，引导模型使用 read_skill
									activeParts.push([
										`### Skill: ${inj.skill.name}`,
										inj.skill.description ? `_${inj.skill.description}_` : '',
										`(Full instructions: use \`read_skill\` tool with skill_id="${inj.skill.id}")`,
									].filter(Boolean).join('\n'));
								}
							}
							const activeSection = [
								'',
								'## Active Skills (this turn)',
								'',
								...activeParts,
							].join('\n');
							mergedSystemPrompt = mergedSystemPrompt + activeSection;
						}

						// 将 user 类型的 skill 注入插入为 user message（在实际用户消息之前）
						if (userInjections.length > 0) {
							const skillMessages = userInjections.map(inj => ({
								role: 'user' as const,
								content: inj.content,
							}));
							// 插入到最后一条用户消息之前
							const lastIdx = mergedMessages.length - 1;
							mergedMessages = [
								...mergedMessages.slice(0, lastIdx),
								...skillMessages,
								mergedMessages[lastIdx],
							];
						}

						this._logService.info(`[AgentDriver] Injected ${injections.length} skills (system: ${systemInjections.length}, user: ${userInjections.length})`);
					}
				}

			enrichedRequest = {
				...request,
				systemPrompt: mergedSystemPrompt,
				messages: mergedMessages,
			};

		this._logService.info(`[AgentDriver] Skill inventory: ${allSkills.length} skills (lightweight XML catalog injected), systemPrompt length: ${mergedSystemPrompt.length}`);
		this._logService.info(`[AgentDriver] systemPrompt preview: ${mergedSystemPrompt.substring(0, 300)}...`);
			} catch (error) {
				this._logService.error('[AgentDriver] Failed to resolve skill activations:', error);
				// Skill 解析失败不阻塞主流程
			}

			// Step 4: 委托 AgentOS 执行（ExecutionProvider 或 直通模式）
			const osStream = this._agentOS.executeAgentTurn(enrichedRequest);

			for await (const delta of osStream) {
				// 检查取消
				if (controller.signal.aborted) {
					yield { type: 'done' };
					break;
				}
				yield delta;
			}

			// Step 5: 写回记忆（如果有 Memory Provider）
			if (memoryProvider) {
				try {
					const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
					if (lastUserMessage) {
						await memoryProvider.writeMemory(request.agentId, {
							id: `memory-${Date.now()}`,
							type: 'short_term',
							content: lastUserMessage.content,
							timestamp: Date.now(),
						});
						this._logService.debug(`[AgentDriver] Wrote memory for ${request.agentId}`);
					}
				} catch (error) {
					this._logService.error('[AgentDriver] Failed to write memory:', error);
				}
			}

			this._updateTurnStatus(turnId, AgentTurnStatus.Done);

		} catch (error) {
			this._logService.error(`[AgentDriver] Turn ${turnId} failed:`, error);
			this._updateTurnStatus(turnId, AgentTurnStatus.Error);
			yield {
				type: 'error',
				content: String(error),
			};
		} finally {
			this._activeTurns.delete(turnId);
		}
	}

	// ─── 取消轮次 ─────────────────────────────────────

	cancelTurn(turnId: string): void {
		const controller = this._activeTurns.get(turnId);
		if (controller) {
			this._logService.info(`[AgentDriver] Cancelling turn ${turnId}`);
			this._updateTurnStatus(turnId, AgentTurnStatus.Cancelling);
			controller.abort();
			this._activeTurns.delete(turnId);
		}
		// NOTE: Do NOT call chatService.cancelStream() here.
		// AgentChatService.sendMessage() already cancels old streams on entry (line 46).
		// Calling cancelStream() here would abort the *new* controller that sendMessage()
		// just created, causing the stream to be killed after the first delta.
	}

	// ─── 查询轮次状态 ─────────────────────────────────

	getTurnStatus(turnId: string): AgentTurnStatus {
		return this._turnStatusMap.get(turnId) ?? AgentTurnStatus.Idle;
	}

	private _updateTurnStatus(turnId: string, status: AgentTurnStatus): void {
		this._turnStatusMap.set(turnId, status);
		this._onDidChangeTurnStatus.fire(status);
	}

	/**
	 * Build a workspace context section for the system prompt.
	 * Resolves the Sarosis workspace that owns the given agent and injects
	 * its path so the model knows exactly what "workspace" means.
	 *
	 * Also includes a sandbox rule: the agent may ONLY operate within the
	 * current workspace directory tree.
	 */
	private async _buildWorkspaceContext(agentId: string): Promise<string | undefined> {
		try {
			const employee = await this._agentStudioService.getEmployee(agentId);
			if (!employee?.workspaceId) {
				return undefined;
			}

			const workspace = await this._agentStudioService.getWorkspace(employee.workspaceId);
			if (!workspace?.path) {
				return undefined;
			}

			const lines: string[] = [
				'## Workspace Context',
				'',
				`You are operating inside the Sarosis workspace "${workspace.name}".`,
				`The workspace root directory is: ${workspace.path}`,
				'',
				'When the user refers to "workspace", "project", "current directory", or asks to print/list the workspace,',
				`they mean this directory: ${workspace.path}`,
				'',
				'### Security Sandbox',
				'',
				`You are ONLY permitted to read, write, search, and execute commands within the workspace directory and its subdirectories.`,
				`You MUST NOT access, modify, or reference any files or directories outside of: ${workspace.path}`,
				'If a user asks you to operate on a path outside this workspace, refuse and explain that you are sandboxed to the current workspace.',
			];

			return lines.join('\n');
		} catch {
			return undefined;
		}
	}

	// ─── 兼容层：将旧 IChatSendOptions 适配为 IAgentTurnRequest ──

	/**
	 * 兼容现有 agentChatService.sendMessage() 调用方式
	 * Phase 2 中 agentChatService 将委托此方法
	 */
	async *executeFromChatOptions(
		employeeId: string,
		message: string,
		options: IChatSendOptions,
	): AsyncIterable<IChatStreamDelta> {
		const request: IAgentTurnRequest = {
			agentId: employeeId,
			sessionId: options.agentSessionId,
			messages: [{ role: 'user', content: message }],
			systemPrompt: options.systemPrompt,
			options: {
				temperature: options.temperature,
			},
		};
		yield* this.executeTurn(request);
	}
}
