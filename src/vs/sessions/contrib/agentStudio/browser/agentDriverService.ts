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
import { filterToolsByChatMode } from '../common/chatModeConfig.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

// ─── Agent Driver Service Implementation ────────────────────────

export class AgentDriverService extends Disposable implements IAgentDriverService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTurnStatus = this._register(new Emitter<{ status: AgentTurnStatus; turnId: string }>());
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
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
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

		// 提升到 try 外，使 finally 块可访问（用于 Step 5 写回记忆）
		let memoryProvider = this._agentOS.getActiveMemoryProvider();
		const assistantChunks: string[] = [];
		// 【关键】rawDeltaChunks 也提升到 try 外，使 finally 中可访问。
		// 它累积的是"剥离前"的模型原始输出（含 <memory_extract> 标签）。
		// 写回记忆时优先用 raw 喂给 memoryProvider，由 memoryProvider 端做
		// 标签剥离 + L1 注入，避免本地流式剥离器的格式容错问题导致 L1 抓不到。
		const rawDeltaChunks: string[] = [];

		// 临时 worktreePath 覆盖的原始值（per-task），finally 块中恢复用。
		let originalBindingWorktreePath: string | undefined;

		// Step 1 计算出的召回作用域选项 —— 同时被 Step 1 (loadContext) 和
		// Step 6 (enrichedRequest 下传给 AgentOS) 使用，避免重复解析 agent 配置。
		let resolvedMemoryScope: 'agent' | 'workspace' | 'global' = 'agent';
		let resolvedMemoryAllowedKeys: readonly string[] | undefined;

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
			if (memoryProvider) {
				try {
					// 抽取最近一条 user 消息作为召回 query —— 让 vendor 能用真实意图
					// 做 FTS5/embedding 匹配，而不是占位字符串。
					const recallQuery = [...request.messages].reverse().find(m => m.role === 'user')?.content ?? '';

					// ── 召回作用域（2026-06）──────────────────────────────────────
					// 决定本 agent 能看到哪些 agent 的 L1 记忆：
					//   - 'agent'(默认)   → 仅本 agent 自己的
					//   - 'workspace'     → 同 workspace 下所有 agent 共享
					//   - 'global'        → 全库（旧行为）
					// 老 agent 配置缺省值视作 'agent'（C2：严格隔离），与文档
					// Memory-Strategy.md §recall-scope 对齐。
					let recallOptions: { scope: 'agent' | 'workspace' | 'global'; allowedSessionKeys?: readonly string[] } | undefined;
					try {
						// Recall scope + sibling enumeration are per-workspace runtime
						// state → read from the AgentBinding, not the global Agent.
						const wsId = await this._resolveWorkspaceId(request.sessionId);
						const binding = wsId
							? await this._agentStudioService.getAgentBinding(wsId, request.agentId)
							: undefined;
						const scope: 'agent' | 'workspace' | 'global' =
							binding?.memoryConfig?.scope ?? 'agent';

						if (scope === 'workspace') {
							// 拿当前 workspace 下所有有绑定的 agent 的 sessionKey（agent:<id>）
							const siblings = wsId
								? await this._agentStudioService.getAgentBindings(wsId)
								: [];
							const siblingKeys = siblings
								.map(s => s.agentId)
								.filter((id): id is string => typeof id === 'string' && id.length > 0)
								.map(id => `agent:${id}`);
							// 兜底：若 workspace 拉不到任何 sibling（不该发生），至少包含自己
							const selfKey = `agent:${request.agentId}`;
							const allowed = siblingKeys.length > 0 ? siblingKeys : [selfKey];
							recallOptions = { scope: 'workspace', allowedSessionKeys: allowed };
						} else if (scope === 'global') {
							recallOptions = { scope: 'global' };
						} else {
							// 'agent' 或未知值
							recallOptions = { scope: 'agent' };
						}
					} catch (scopeErr) {
						// 解析作用域失败时按最严格策略（agent）兜底，永远不会"误开放"
						this._logService.warn(
							`[AgentDriver] resolve memory scope failed, falling back to 'agent': ${scopeErr instanceof Error ? scopeErr.message : String(scopeErr)}`,
						);
						recallOptions = { scope: 'agent' };
					}

					// 同步到外层变量，让 Step 6 enrichedRequest 复用，避免重复解析。
					resolvedMemoryScope = recallOptions.scope;
					resolvedMemoryAllowedKeys = recallOptions.allowedSessionKeys;

					memoryContext = await memoryProvider.loadContext(
						request.agentId,
						request.sessionId || '',
						recallQuery,
						recallOptions,
					);
					this._logService.debug(
						`[AgentDriver] Loaded memory context for ${request.agentId} ` +
						`(queryLen=${recallQuery.length}, scope=${recallOptions?.scope ?? 'agent'}, ` +
						`allowedKeys=${recallOptions?.allowedSessionKeys?.length ?? 0})`,
					);
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

				// 【关键修复】仅注入 agent 实例中配置的技能，未配置的不要注入
				const agent = await this._agentStudioService.getAgent(request.agentId);
				// Persona memory entries are per-workspace runtime state → from the binding.
				const personaBinding = await this._resolveBinding(request.agentId, request.sessionId);

				// 规范化 skills 格式：处理旧格式（对象数组）和新格式（字符串数组）的混合情况
				const rawSkills = agent?.skills || [];
				const agentSkillIds = new Set(
					rawSkills.map(s => {
						if (typeof s === 'string') {
							return s;  // 新格式：字符串 ID
						} else if (s && typeof s === 'object' && 'id' in s) {
							return (s as { id: string }).id;  // 旧格式：对象，提取 id
						}
						return '';  // 无效格式
					}).filter(Boolean)  // 过滤空字符串
				);

				// 将用户通过 /skill 命令显式选择的技能临时加入 agentSkillIds
				const explicitSkillIds = request.explicitSkillIds || [];
				const newExplicitIds: string[] = [];
				for (const id of explicitSkillIds) {
					if (agentSkillIds.has(id)) {
						this._logService.info(`[AgentDriver] Skill '${id}' already in agent config, skipping duplicate`);
					} else {
						agentSkillIds.add(id);
						newExplicitIds.push(id);
					}
				}
				if (newExplicitIds.length > 0) {
					this._logService.info(`[AgentDriver] Explicit skills added for this turn: ${newExplicitIds.join(', ')}`);
				}

				const allSkills = [...this._skillRegistry.getSkills()]
					.filter(s => s.enabled !== false)
					.filter(s => agentSkillIds.has(s.id));  // 只保留 agent 配置的技能

				let mergedSystemPrompt = request.systemPrompt || '';

				// ── 注入 Persona Memory（永久事实，最高优先级）────────────────────
				//
				// 这些是用户在 Memory Tab 手动维护的硬性事实/规则，与 TDB-AM 的
				// L0/L1 自动召回互补：
				//   - L0/L1：程序性记忆（对话历史/摘要），由模型自动产生，会随时间衰减
				//   - Persona Memory：硬编码事实，由用户显式设定，永不衰减
				//
				// 放在 systemPrompt 最顶部的原因：
				//   1) 这是用户显式设定的"硬规则"，必须在所有其他上下文之前生效
				//   2) 即使后续 prompt 因长度被截断，最重要的事实也保留下来
				//   3) 与 ChatGPT Custom Instructions 的语义一致
				//
				// 仅当 memoryConfig.enabled !== false 且 entries 非空时注入。
				try {
					const personaEntries = (personaBinding?.memoryConfig?.enabled !== false)
						? (personaBinding?.memoryConfig?.entries || [])
						: [];
					if (personaEntries.length > 0) {
						const lines: string[] = [
							'',
							'## Persona Memory (永久事实，最高优先级)',
							'',
							'以下是用户显式设定的硬性事实与规则。在整个对话中，你必须始终把它们当作既定真相对待，优先于其他上下文：',
							'',
						];
						// 按 category 分组展示，更易读
						const grouped = new Map<string, typeof personaEntries>();
						for (const entry of personaEntries) {
							const cat = (entry.category && entry.category.trim()) || '通用';
							if (!grouped.has(cat)) {
								grouped.set(cat, []);
							}
							grouped.get(cat)!.push(entry);
						}
						for (const [cat, items] of grouped) {
							lines.push(`### ${cat}`);
							for (const item of items) {
								// 使用 "标签 = 内容" 的紧凑格式，对 LLM 友好
								lines.push(`- **${item.key}** = ${item.value}`);
							}
							lines.push('');
						}
						lines.push('（以上事实由用户在 Persona Memory 中显式维护，永不衰减；如与你的默认假设冲突，以这些事实为准。）');
						lines.push('');
						const personaSection = lines.join('\n');
						// 放在 systemPrompt 最顶部
						mergedSystemPrompt = personaSection + mergedSystemPrompt;
						this._logService.info(`[AgentDriver] Injected Persona Memory: ${personaEntries.length} entries (${personaSection.length} chars) at top of systemPrompt`);
					}
				} catch (error) {
					this._logService.warn('[AgentDriver] Failed to inject Persona Memory:', error);
					// 非致命错误，不阻塞主流程
				}

				// 注入工作区上下文，让模型始终知晓当前工作区信息
				const workspaceContext = await this._buildWorkspaceContext(request.agentId, request.sessionId, request.worktreePath);
				if (workspaceContext) {
					mergedSystemPrompt = mergedSystemPrompt + '\n\n' + workspaceContext;
				}

				// ── 临时覆盖 AgentBinding.worktreePath（per-task 优先）────────────
				// 当 TaskBoardRecord 指定了 worktreePath 但 agent 绑定未配置时，
				// 需要临时注入到 binding，使 builtinToolProvider 的工具 cwd 解析
				// 也跟随任务的工作区，而非绑定的全局配置。
				// 执行结束后在 finally 中恢复。
				if (request.worktreePath) {
					try {
						const workspaceId = await this._resolveWorkspaceId(request.sessionId);
						if (workspaceId) {
							const binding = await this._resolveBinding(request.agentId, request.sessionId);
							originalBindingWorktreePath = binding?.worktreePath;
							if (binding && originalBindingWorktreePath !== request.worktreePath) {
								await this._agentStudioService.upsertAgentBinding(
									workspaceId,
									request.agentId,
									{ worktreePath: request.worktreePath },
								);
								this._logService.info(`[AgentDriver] Temporarily set binding.worktreePath="${request.worktreePath}" for task execution`);
							} else {
								originalBindingWorktreePath = undefined; // 无需恢复
							}
						}
					} catch (err) {
						this._logService.warn('[AgentDriver] Failed to temporarily set binding worktreePath:', err);
						originalBindingWorktreePath = undefined;
					}
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
				// 【Knot 特殊处理】当使用 Knot 作为 Model Provider 时，不注入 Available Tools
				// 因为 Knot 在服务端处理工具，客户端不需要告诉模型有哪些工具
				const activeModelSelection = this._agentOS.getActiveModelSelection();
				const isKnotProvider = activeModelSelection?.providerId.includes('knot');

				if (!isKnotProvider) {
					try {
						const allTools = await this._agentOS.listAllToolsWithState(request.agentId);
						const enabledToolsRaw = allTools.filter(t => t.enabled);
						const chatMode = request.chatMode || 'craft';

						// Filter tools by chat mode (unified in chatModeConfig)
						const enabledTools = filterToolsByChatMode(enabledToolsRaw, chatMode);

						if (enabledTools.length > 0) {
							const toolSection = [
								'',
								'## Available Tools',
								'',
								(chatMode === 'ask' || chatMode === 'plan')
									? 'You have access to the following READ-ONLY tools. You may use them to read files and search code, but you MUST NOT modify, delete, or create any files.'
									: 'You have access to the following tools. When a user asks you to perform an action that requires interacting with the filesystem, executing commands, searching the web, or any other external system, you MUST use the appropriate tool instead of explaining that you cannot do it.',
								'',
								'Available tools:',
								'',
								...enabledTools.map(t => `- ${t.name}: ${t.description || 'No description'}`),
								'',
							];

							if (chatMode !== 'ask') {
								toolSection.push(
									'Usage rules:',
									'- To execute a shell command (e.g., "print current directory", "list files"), use: **terminal** with {"command": "<your command>"}',
									'- To read a file, use: **file_read** with {"path": "<file path>"}',
									'- To write a file, use: **file_write** with {"path": "<file path>", "content": "<content>"}',
									'- To search files, use: **search_files** with {"path": "<directory>", "pattern": "<pattern>"}',
								);
							}

							toolSection.push(
								'',
								'When you need to use a tool, respond with a function call using the exact tool name and required arguments.',
								'',
								'IMPORTANT: When you need to use a tool, you MUST use the exact tool name from the list above and provide the required arguments.',
								'If your model supports function calling, use the native function_call format.',
								'If your model does NOT support function calling, output a JSON object in this exact format: {"name": "<tool_name>", "arguments": {<args>}}.',
								'DO NOT use XML tags like <tool_call> or <function_call> — they will NOT be recognized.',
								'Example (correct): {"name": "file_list", "arguments": {"path": "."}}',
								'Example (wrong, do NOT use): <tool_call>file_list</tool_call>',
								'Never output tool calls as plain text explanations or code blocks without the proper format.',
								'',
								'## CRITICAL ANTI-HALLUCINATION RULES (MUST FOLLOW)',
								'',
								'1. **NEVER claim you have done something without actually calling a tool.** If the user asks you to create/modify/delete a file, run a command, or perform any side-effect, you MUST emit an actual tool call. Phrases like "文件已创建成功", "已完成", "I have created the file", "Done!" are STRICTLY FORBIDDEN unless they appear AFTER a real tool call returned a successful result.',
								'2. **NEVER fabricate tool execution.** Do not write narrative descriptions like "让我使用 file_write 工具" or "I will use the file_write tool" as a substitute for an actual tool call. Either emit the structured tool call, or do not claim the action was taken.',
								'3. **For ANY filesystem write / command execution / external side-effect: a tool call is MANDATORY.** No exceptions. If you cannot determine the correct tool or arguments, ask the user — do not pretend the action succeeded.',
								'4. **Output format priority** (in order):',
								'   a. PREFERRED: native OpenAI function-call format via the `tools` parameter (the API will route this automatically).',
								'   b. FALLBACK (only if native function-call is unavailable): emit a JSON object in a fenced code block:',
								'      ```json',
								'      {"name": "file_write", "arguments": {"path": "g:/example/test.txt", "content": ""}}',
								'      ```',
								'5. **Do not narrate the tool call.** Do not write "I am calling file_write now" before emitting it. Just emit the tool call directly.',
								'6. **After a tool returns:** you may then summarize what happened in natural language, citing the actual tool result.',
								'',
							);

							const toolSectionStr = toolSection.join('\n');
							mergedSystemPrompt = mergedSystemPrompt + toolSectionStr;
							this._logService.info(`[AgentDriver] Injected ${enabledTools.length} enabled tools into systemPrompt (mode=${chatMode})`);
						}
					} catch (error) {
						this._logService.warn('[AgentDriver] Failed to inject tool inventory:', error);
					}
				} else {
					this._logService.info(`[AgentDriver] Skipped Available Tools injection (Knot provider detected: ${activeModelSelection?.providerId})`);
				}

				// 3b. 解析本轮激活的技能内容并注入
				let mergedMessages = [...request.messages];

				if (lastUserMessage) {
					const injections = await this._skillRegistry.resolveActivations({
						userMessage: lastUserMessage.content,
						agentId: request.agentId,
						sessionId: request.sessionId,
						explicit: explicitSkillIds,
					});

					// 【关键修复】仅保留 agent 实例中配置的技能，未配置的不要注入
					const filteredInjections = injections.filter(inj => agentSkillIds.has(inj.skill.id));

					if (filteredInjections.length > 0) {
						// 分离 system 和 user 注入
						const systemInjections = filteredInjections.filter(inj => inj.placement === 'system');
						const userInjections = filteredInjections.filter(inj => inj.placement === 'user');

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

						this._logService.info(`[AgentDriver] Injected ${filteredInjections.length} skills (system: ${systemInjections.length}, user: ${userInjections.length})`);
					}
				}

				// ── 注入 Memory Extract 提示（TDB-AM L1 写入的唯一上行通道）──
				//
				// 背景：tdb-am-memory 的 L1 持久化依赖模型在回复末尾自行输出
				//   <memory_extract>{...}</memory_extract>
				// 标签。下行解析在 agentDriverService.ts 的 SSE 流式 buffer 和
				// extensions/tdb-am-memory/src/memoryProvider.ts 都已实现，
				// 但**没有任何地方告诉模型要输出这个标签**——除了 Knot 服务端
				// 自己内置的提示词（不可控），其他 Provider 完全不会主动产出，
				// 导致 L1 长期处于"接得到、收不到"的状态。
				//
				// 这里在 systemPrompt 尾部追加一段中性、模型无关的指令，
				// 让所有 Provider 走这条链路时都能稳定写入 L1。
				// 解析端对未输出标签的回复完全无副作用（regex 匹配不到即跳过），
				// 因此即使模型偶尔忽略本指令，也不会破坏正常对话。
				const memoryExtractGuide = [
					'',
					'## Long-term Memory Capture',
					'',
					'When (and only when) the user reveals durable facts worth remembering across sessions — e.g. personal preferences, project conventions, naming rules, environment specifics, long-term goals, or explicit "remember this" instructions — append a memory tag at the very end of your reply (after all normal content). Format:',
					'',
					'```',
					'<memory_extract>{"content":"<concise fact in user\'s language>","type":"<persona|episodic|instruction>","priority":<1-100>,"scene_name":"<short topic label>"}</memory_extract>',
					'```',
					'',
					'Field semantics:',
					'- `content`: a single self-contained sentence the next session can use without extra context. Stay concrete; never copy raw chat fragments.',
					'- `type`: `persona` (who/what the user is), `episodic` (a specific event or decision), `instruction` (a rule the assistant must follow).',
					'- `priority`: 90+ for hard rules ("always do X"), 70–89 for stable preferences, 40–69 for context-bound facts, <40 for trivia. If unsure, use 70.',
					'- `scene_name`: 2–6 words summarising the topic, used as a recall anchor.',
					'',
					'Rules:',
					'1. Output **at most one** `<memory_extract>` tag per reply, only when truly worth persisting.',
					'2. The tag MUST be the **last thing** in your reply, on its own line. Never embed it mid-sentence and never wrap it in code fences.',
					'3. If nothing in this turn warrants long-term memory, omit the tag entirely — do NOT emit empty or speculative tags.',
					'4. Multiple tags in one reply, malformed JSON, or unknown `type` values will be silently dropped.',
					'',
				].join('\n');
				mergedSystemPrompt = mergedSystemPrompt + memoryExtractGuide;

				// ── 【Knot 专用补丁】把 memory_extract 指令追加到 user message 末尾 ──
				//
				// 背景：Knot AG-UI 协议把客户端的 system message 降级为
				// `background_knowledge` 字段（参见 extensions/knot-agui/src/extension.ts
				// 第 261 行附近的注释："不会覆盖 agent 自身的系统提示"）。
				// 实测 hy3-preview 等 Knot Agent 完全无视该字段中的 memory_extract 指令。
				//
				// 而 Knot 对 user message 是必收必应的（input.message 字段直接喂给模型），
				// 因此把指令以"附加上下文"形式追加到最后一条 user message 末尾，
				// 是当前协议下唯一稳定有效的下行通道。
				//
				// 重要：只修改 mergedMessages（送给模型用），不修改 request.messages
				// （Step 5 写 memory 仍用原始 content，L0 SQLite 不会被污染）。
				if (isKnotProvider && mergedMessages.length > 0) {
					const lastIdx = mergedMessages.length - 1;
					const lastMsg = mergedMessages[lastIdx];
					if (lastMsg && lastMsg.role === 'user' && typeof lastMsg.content === 'string') {
						// 用明显的分隔符让模型识别这是"系统补充指令"而非用户原话。
						// 双换行 + 单字符标记 + 简短指令，最大化模型注意力。
						const userInjection = [
							'',
							'',
							'---',
							'',
							'_[System note for assistant — not part of user content]_',
							'',
							'After producing your normal reply, IF the user revealed a durable fact worth remembering across sessions (preferences, conventions, rules, environment specifics, long-term goals, explicit "remember this" instructions), append on a new final line:',
							'',
							'`<memory_extract>{"content":"<one self-contained sentence in the user\'s language>","type":"persona|episodic|instruction","priority":1-100,"scene_name":"<2-6 word topic>"}</memory_extract>`',
							'',
							'Rules: at most one tag per reply; emit nothing if not worth persisting; tag MUST be the last thing in the reply, on its own line, NOT inside code fences.',
						].join('\n');
						mergedMessages = [
							...mergedMessages.slice(0, lastIdx),
							{ ...lastMsg, content: lastMsg.content + userInjection },
						];
						this._logService.info(`[AgentDriver] 🪝 Knot user-message injection applied (+${userInjection.length} chars to last user msg)`);
					}
				}

				// 解析 memoryConfig 中的策略 / 上限，向下游 AgentOS 传递。
				// 注意：旧值 'sliding_window' 视为 'full'（参见 Agent.memoryConfig 注释）。
				//
				// 【B 方案兼容】当 priorMessages 已将完整会话历史灌入 messages 时，
				// L0 短期记忆（即最近几轮 user+assistant 原文）与 messages 中的历史
				// 完全重叠。若仍按 'full' 策略注入 L0，模型会看到两份相同的对话内容
				// → 混淆 → 在回复中重复/回显之前的内容。因此当有历史灌入时，强制
				// 切换为 'summary'（仅注入 L1 长期摘要），避免重复。
				const rawStrategy = personaBinding?.memoryConfig?.strategy;
				const hasHistoryInMessages = mergedMessages.length > 1;
				const memoryStrategy: 'summary' | 'full' =
					hasHistoryInMessages ? 'summary'
						: rawStrategy === 'summary' ? 'summary' : 'full';
				if (hasHistoryInMessages && rawStrategy !== 'summary') {
					this._logService.info(
						`[AgentDriver] B-plan override: memoryStrategy forced to 'summary' ` +
						`(messages=${mergedMessages.length}, L0 would duplicate history)`,
					);
				}
				const memoryMaxEntries = (
					typeof personaBinding?.memoryConfig?.maxEntries === 'number' &&
					personaBinding.memoryConfig.maxEntries > 0
				) ? personaBinding.memoryConfig.maxEntries : undefined;

				enrichedRequest = {
					...request,
					systemPrompt: mergedSystemPrompt,
					messages: mergedMessages,
					memoryStrategy,
					memoryMaxEntries,
					memoryScope: resolvedMemoryScope,
					memoryAllowedSessionKeys: resolvedMemoryAllowedKeys,
				};

				this._logService.info(`[AgentDriver] Injected memory_extract guidance (${memoryExtractGuide.length} chars) — provider=${activeModelSelection?.providerId ?? 'none'}`);
				this._logService.info(`[AgentDriver] Skill inventory: ${allSkills.length} skills (lightweight XML catalog injected), systemPrompt length: ${mergedSystemPrompt.length}`);
				this._logService.info(`[AgentDriver] systemPrompt preview: ${mergedSystemPrompt.substring(0, 300)}...`);
				this._logService.info(`[AgentDriver] Memory injection policy: strategy=${memoryStrategy}, maxEntries=${memoryMaxEntries ?? 'unlimited'}, scope=${resolvedMemoryScope}, allowedKeys=${resolvedMemoryAllowedKeys?.length ?? 0} (raw=${rawStrategy ?? 'undefined'})`);
			} catch (error) {
				this._logService.error('[AgentDriver] Failed to resolve skill activations:', error);
				// Skill 解析失败不阻塞主流程
			}

			// Step 4: 委托 AgentOS 执行（ExecutionProvider 或 直通模式）
			// 同时累积 assistant 文本，便于 Step 5 写回完整一轮的 assistant 记忆。
			const osStream = this._agentOS.executeAgentTurn(enrichedRequest);

			// ── 流式记忆标签剥离缓冲区 ──────────────────────────────────────────
			// Knot 可能在回复末尾输出记忆标签，需要在流式阶段就剥离，避免用户看到。
			// 支持两种格式：
			//   1. <memory_extract>{JSON}</memory_extract>  （图里方案，推荐）
			//   2. [MEMORY:L1:type:priority:scene]内容[/MEMORY]  （旧格式，兼容）
			// 由于标签可能跨多个 delta 分片，使用缓冲区处理跨片情况。
			let tagBuffer = '';
			// 注意：rawDeltaChunks 已提升到 try 外层声明，此处仅引用并清空（防止跨轮残留）。
			rawDeltaChunks.length = 0;
			// 两种格式的开头标记（取最短公共前缀用于快速判断）
			const TAG_OPENS = ['<memory_extract>', '[MEMORY:'];
			const TAG_CLOSES: Record<string, string> = {
				'<memory_extract>': '</memory_extract>',
				'[MEMORY:': '[/MEMORY]',
			};

			const flushTagBuffer = (): string => {
				// 缓冲区里没有完整标签，把内容当普通文本返回
				const result = tagBuffer;
				tagBuffer = '';
				return result;
			};

			/**
			 * 处理一段文本：剥离其中的记忆标签，返回干净文本。
			 * 支持 <memory_extract>...</memory_extract> 和 [MEMORY:...][/MEMORY] 两种格式。
			 * 跨 delta 的标签通过 tagBuffer 缓冲处理。
			 */
			const processTextChunk = (chunk: string): string => {
				let output = '';
				let remaining = tagBuffer + chunk;
				tagBuffer = '';

				while (remaining.length > 0) {
					// 找到最早出现的标签开头
					let earliestOpenIdx = -1;
					let matchedOpen = '';
					for (const tagOpen of TAG_OPENS) {
						const idx = remaining.indexOf(tagOpen);
						if (idx !== -1 && (earliestOpenIdx === -1 || idx < earliestOpenIdx)) {
							earliestOpenIdx = idx;
							matchedOpen = tagOpen;
						}
					}

					if (earliestOpenIdx === -1) {
						// 没有标签开头，但末尾可能是某个标签的前缀（如 "<memo" 或 "[MEM"）
						let prefixLen = 0;
						for (const tagOpen of TAG_OPENS) {
							for (let i = tagOpen.length - 1; i >= 1; i--) {
								if (remaining.endsWith(tagOpen.slice(0, i))) {
									if (i > prefixLen) { prefixLen = i; }
									break;
								}
							}
						}
						if (prefixLen > 0) {
							// 末尾是潜在标签前缀，缓冲起来等待下一个 delta
							output += remaining.slice(0, remaining.length - prefixLen);
							tagBuffer = remaining.slice(remaining.length - prefixLen);
						} else {
							output += remaining;
						}
						remaining = '';
					} else {
						// 找到标签开头
						output += remaining.slice(0, earliestOpenIdx);
						remaining = remaining.slice(earliestOpenIdx);

						const tagClose = TAG_CLOSES[matchedOpen];
						const closeIdx = remaining.indexOf(tagClose);
						if (closeIdx === -1) {
							// 标签未闭合，缓冲整个标签（等待后续 delta）
							// 【诊断】这种情况意味着模型流可能在标签中间被截断，
							// 后续若一直收不到闭合标签会导致 L1 抓不到记忆。
							const seenOpenMsg = `[AgentDriver] ⏳ Memory tag open detected, awaiting close (open="${matchedOpen}", bufferedLen=${remaining.length}, preview="${remaining.replace(/\s+/g, ' ').slice(0, 200)}")`;
							this._logService.info(seenOpenMsg);
							try { console.warn(seenOpenMsg); } catch { /* noop */ }
							tagBuffer = remaining;
							remaining = '';
						} else {
							// 找到完整标签，剥离它（不输出给用户）
							// ── 诊断日志：让 DevTools console 能看到 Knot 是否真的输出了 memory 标签 ──
							const fullTag = remaining.slice(0, closeIdx + tagClose.length);
							const diagMsg = `[AgentDriver] 🧠 Captured memory tag (open="${matchedOpen}", len=${fullTag.length}): ${fullTag.replace(/\s+/g, ' ').slice(0, 300)}`;
							this._logService.info(diagMsg);
							// 镜像到 DevTools console，便于排查（_logService 默认走 OutputChannel/log 文件，DevTools 不可见）
							try { console.warn(diagMsg); } catch { /* noop */ }
							remaining = remaining.slice(closeIdx + tagClose.length);
						}
					}
				}

				return output;
			};

			for await (const delta of osStream) {
				// 检查取消
				if (controller.signal.aborted) {
					// 刷新缓冲区（未完成的标签当普通文本处理）
					const flushed = flushTagBuffer();
					if (flushed.length > 0) {
						assistantChunks.push(flushed);
					}
					yield { type: 'done' };
					break;
				}

				if (delta.type === 'text' && typeof delta.content === 'string' && delta.content.length > 0) {
					// 【诊断】先累积 raw 文本（剥离前），用于流结束后排查标签输出情况
					rawDeltaChunks.push(delta.content);
					// 流式剥离记忆标签：用户看不到标签，assistantChunks 收集干净文本
					const cleanContent = processTextChunk(delta.content);
					if (cleanContent.length > 0) {
						assistantChunks.push(cleanContent);
						yield { ...delta, content: cleanContent };
					}
					// 如果 cleanContent 为空（整个 delta 都是标签），不 yield
				} else if (delta.type === 'content_replace' && typeof delta.content === 'string') {
					// content_replace：用最新内容覆盖整个 assistant 输出
					// 【诊断】content_replace 模式下也累积 raw（覆盖式）
					rawDeltaChunks.length = 0;
					rawDeltaChunks.push(delta.content);
					// 对完整内容做一次全量剥离
					tagBuffer = '';
					const cleanContent = processTextChunk(delta.content) + flushTagBuffer();
					assistantChunks.length = 0;
					assistantChunks.push(cleanContent);
					yield { ...delta, content: cleanContent };
				} else if ((delta as any).type === 'discard_prior_text') {
					// ── Hermes-style synthetic-recovery 续跑信号 ──────────────────
					// 参考 Hermes `conversation_loop.py` 的 `_empty_recovery_synthetic`
					// + while-pop 模式：upstream 检测到 fake-completion / unfinished-intent /
					// 空回，准备注入 nudge 续跑时，要求下游**完全丢弃刚才那段幻觉/过渡文本**，
					// 不能让它进入 memory provider（L0 capture）和 chatService.history。
					//
					// 否则下一轮 `_toDriverMessages(history)` 会把"您完全正确！我犯了严重错误..."
					// 这种道歉幻觉作为 prior driver messages 喂回模型，形成对话循环。
					rawDeltaChunks.length = 0;
					assistantChunks.length = 0;
					tagBuffer = '';
					const reason = (delta as any).metadata?.reason ?? 'unknown';
					this._logService.info(
						`[AgentDriver] 🧹 Received discard_prior_text signal (reason=${reason}) — cleared rawDeltaChunks + assistantChunks to prevent conversation rot`,
					);
					// 把信号原样向上游 yield（chatService 同样需要清空 fullContent/fullThinking）
					yield delta;
				} else if (delta.type === 'done') {
					// 流结束：刷新缓冲区，未完成的标签当普通文本处理
					const flushed = flushTagBuffer();
					if (flushed.length > 0) {
						assistantChunks.push(flushed);
						yield { type: 'text', content: flushed };
					}
					yield delta;
				} else {
					yield delta;
				}
			}

			// 流结束后再次刷新（防止 generator 提前退出时缓冲区有残留）
			const finalFlushed = flushTagBuffer();
			if (finalFlushed.length > 0) {
				assistantChunks.push(finalFlushed);
				// 【诊断】finalFlushed 包含未闭合的标签（如开标签出现但闭合标签没到）
				// 检测开标签字面量是否在最终残留中，以判断是否是被截断的标签。
				if (/<memory_extract>/i.test(finalFlushed) || /\[MEMORY:/i.test(finalFlushed)) {
					const orphanMsg = `[AgentDriver] ⚠️ ORPHAN unfinished memory tag at stream end (len=${finalFlushed.length}): ${finalFlushed.replace(/\s+/g, ' ').slice(0, 400)}`;
					this._logService.warn(orphanMsg);
					try { console.warn(orphanMsg); } catch { /* noop */ }
				}
			}

			// 【诊断】流结束后打印 raw 模型输出的尾部（800 字符），用于排查
			// "Knot 是否真的输出了 <memory_extract> 标签"。
			// 注意：这是剥离前的原始内容，能看到模型最真实的输出格式。
			try {
				const rawFull = rawDeltaChunks.join('');
				const tail = rawFull.length > 800 ? rawFull.slice(-800) : rawFull;
				const hasExtractTag = /<memory_extract>/i.test(rawFull);
				const hasLegacyTag = /\[MEMORY:/i.test(rawFull);
				const statsMsg = `[AgentDriver] 🔍 RAW model output stats: totalLen=${rawFull.length}, hasMemoryExtractTag=${hasExtractTag}, hasLegacyMemoryTag=${hasLegacyTag}`;
				const tailMsg = `[AgentDriver] 🔍 RAW model output tail (last 800 chars): ${JSON.stringify(tail)}`;
				this._logService.info(statsMsg);
				this._logService.info(tailMsg);
				// 同步镜像到 DevTools console
				try { console.warn(statsMsg); console.warn(tailMsg); } catch { /* noop */ }
			} catch (diagErr) {
				this._logService.warn(`[AgentDriver] raw output diagnostic failed: ${(diagErr as Error).message}`);
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

			// ── 恢复 AgentBinding.worktreePath ─────────────────────────
			if (originalBindingWorktreePath !== undefined) {
				try {
					const workspaceId = await this._resolveWorkspaceId(request.sessionId);
					if (workspaceId) {
						await this._agentStudioService.upsertAgentBinding(
							workspaceId,
							request.agentId,
							{ worktreePath: originalBindingWorktreePath || undefined },
						);
						this._logService.info(`[AgentDriver] Restored binding.worktreePath="${originalBindingWorktreePath || '(none)'}" after task execution`);
					}
				} catch (err) {
					this._logService.warn('[AgentDriver] Failed to restore binding worktreePath:', err);
				}
			}

			// Step 5: 写回记忆（放在 finally 确保即使 generator 被外层提前终止也能执行）
			// ⚠ 关键：必须连续写两条——user 一条 + assistant 一条，
			// 这样下游 Memory Provider（如 tdb-am-memory）才能配对成完整一轮，
			// 用于 vendor /capture 接口的 user_content + assistant_content。
			//
			// 🔧 2026-06-10 修复：memory 写回改为 fire-and-forget，不再 await。
			// 原因：async generator 的 finally 块中 await 会阻塞 generator 的 return，
			// 进而阻塞 consumer（agentChatService）的 for-await 循环退出。
			// 当 memoryProvider.writeMemory() 因网络抖动/vendor 超时而长时间
			// 不返回时，整个聊天流会被卡住——用户看到的表现为 "LLM 返回后 app 卡死"。
			// fire-and-forget 不阻塞流退出，写失败由 catch 静默记录日志。
			if (memoryProvider) {
				const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
				const rawAssistantContent = rawDeltaChunks.join('').trim();
				const cleanedAssistantContent = assistantChunks.join('').trim();
				const assistantContent = rawAssistantContent.length > 0 ? rawAssistantContent : cleanedAssistantContent;
				const ts = Date.now();
				const sessionMeta: Record<string, unknown> = {
					owner: 'default',
					userId: 'default',
					agentId: request.agentId,
				};
				if (request.sessionId) {
					sessionMeta['sessionId'] = request.sessionId;
				}

				// Fire-and-forget: 不阻塞 generator cleanup / consumer 的 for-await 退出
				(async () => {
					try {
						if (lastUserMessage) {
							await memoryProvider.writeMemory(request.agentId, {
								id: `memory-user-${ts}`,
								type: 'short_term',
								content: lastUserMessage.content,
								metadata: { ...sessionMeta, role: 'user' },
								timestamp: ts,
							});
						}

						if (assistantContent.length > 0) {
							await memoryProvider.writeMemory(request.agentId, {
								id: `memory-assistant-${ts + 1}`,
								type: 'short_term',
								content: assistantContent,
								metadata: { ...sessionMeta, role: 'assistant' },
								timestamp: ts + 1,
							});
						}

						this._logService.info(`[AgentDriver] Wrote memory for ${request.agentId} (user=${lastUserMessage ? 'yes' : 'no'}, assistantLen=${assistantContent.length})`);
					} catch (error) {
						this._logService.error('[AgentDriver] Failed to write memory:', error);
					}
				})();
			}
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
		this._onDidChangeTurnStatus.fire({ status, turnId });
	}

	/**
	 * Resolve the workspace that owns a given turn.
	 *
	 * `IAgentTurnRequest` only carries agentId + sessionId, never workspaceId.
	 * The owning workspace is recovered via the session record
	 * (`getSession(sessionId).workspaceId`). When there is no sessionId (e.g.
	 * a probe turn) we fall back to the currently-active workspace.
	 *
	 * Returns undefined only when neither path yields a workspace.
	 */
	private async _resolveWorkspaceId(sessionId?: string): Promise<string | undefined> {
		if (sessionId) {
			try {
				const session = await this._agentStudioService.getSession(sessionId);
				if (session?.workspaceId) { return session.workspaceId; }
			} catch (err) {
				this._logService.debug(`[AgentDriver] _resolveWorkspaceId: getSession(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const active = this._agentStudioService.getActiveWorkspaceId();
		return active ?? undefined;
	}

	/**
	 * Resolve the per-workspace runtime binding for an agent in the turn's
	 * workspace. Returns undefined if the agent has never run in this workspace
	 * (no worktree / memoryConfig persisted yet) — callers must treat that as
	 * "use defaults", never as an error.
	 */
	private async _resolveBinding(agentId: string, sessionId?: string) {
		const workspaceId = await this._resolveWorkspaceId(sessionId);
		if (!workspaceId) { return undefined; }
		try {
			return await this._agentStudioService.getAgentBinding(workspaceId, agentId);
		} catch (err) {
			this._logService.debug(`[AgentDriver] _resolveBinding(${agentId}) failed: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	/**
	 * Build a workspace context section for the system prompt.
	 *
	 * Working-directory resolution priority:
	 *   1. `binding.worktreePath` — when the agent is bound to a git
	 *      worktree in this workspace, that worktree directory IS its working
	 *      sandbox. The agent operates entirely inside the worktree (its own
	 *      branch), isolated from the main checkout. This MUST take precedence
	 *      and MUST NOT be auto-synced away to the VS Code open folder.
	 *   2. Otherwise the Sarosis workspace path, kept in sync with the VS Code
	 *      currently-open folder.
	 *
	 * Also includes a sandbox rule: the agent may ONLY operate within the
	 * resolved working directory tree.
	 */
	private async _buildWorkspaceContext(agentId: string, sessionId?: string, taskWorktreePath?: string): Promise<string | undefined> {
		try {
			const workspaceId = await this._resolveWorkspaceId(sessionId);
			if (!workspaceId) {
				return undefined;
			}

			const workspace = await this._agentStudioService.getWorkspace(workspaceId);
			if (!workspace) {
				return undefined;
			}

			const binding = await this._resolveBinding(agentId, sessionId);

			// ── 最高优先级：per-task worktreePath（来自 TaskBoardRecord）────────
			if (taskWorktreePath) {
				const worktreeRoot = taskWorktreePath.replace(/[\\/]+$/, '');
				this._logService.info(`[AgentDriver] Task overrides worktree for agent ${agentId}, working dir = "${worktreeRoot}"`);
				return this._composeWorkspaceContextText(workspace.name, worktreeRoot, /* isWorktree */ true);
			}

			// ── 次优先：agent 实例绑定的 worktree 即其工作沙盒 ──────────────
			// 绑定 worktree 的 agent 完全运行在该 worktree 目录（独立分支）内，
			// 与主仓 checkout 隔离。此时工作根 = worktreePath，且【跳过】下面的
			// auto-sync（否则会被 VS Code 当前打开文件夹覆盖回去），与工具沙箱
			// (_resolveAndCheckWorkspacePath) 的判定口径保持一致。
			const worktreeRoot = binding?.worktreePath?.replace(/[\\/]+$/, '');
			if (worktreeRoot) {
				this._logService.info(`[AgentDriver] Agent ${agentId} bound to worktree, working dir = "${worktreeRoot}"`);
				return this._composeWorkspaceContextText(workspace.name, worktreeRoot, /* isWorktree */ true);
			}

			let workspaceRoot = workspace.path;

			// Auto-sync: if the VS Code currently-open folder differs from the
			// stored workspace path, update the workspace record to match.
			const vsCodeFolders = this._workspaceContextService.getWorkspace().folders;
			const vsCodeFolder = vsCodeFolders.length > 0 ? vsCodeFolders[0].uri.fsPath : undefined;

			if (vsCodeFolder && workspaceRoot !== vsCodeFolder) {
				this._logService.info(
					`[AgentDriver] Syncing workspace path: "${workspaceRoot}" → "${vsCodeFolder}"`
				);
				try {
					await this._agentStudioService.updateWorkspace(workspaceId, { path: vsCodeFolder });
				} catch (err) {
					this._logService.warn('[AgentDriver] Failed to sync workspace path:', err);
				}
				workspaceRoot = vsCodeFolder;
			}

			if (!workspaceRoot) {
				return undefined;
			}

			return this._composeWorkspaceContextText(workspace.name, workspaceRoot, /* isWorktree */ false);
		} catch {
			return undefined;
		}
	}

	/**
	 * Compose the "Workspace Context" system-prompt section for a resolved
	 * working-directory root. Shared by both the worktree-bound path and the
	 * regular workspace path so the sandbox wording stays consistent.
	 *
	 * @param workspaceName Display name of the Sarosis workspace.
	 * @param rootDir The resolved working directory (worktree dir or workspace path).
	 * @param isWorktree Whether `rootDir` is a git worktree the agent is bound to.
	 */
	private async _composeWorkspaceContextText(
		workspaceName: string,
		rootDir: string,
		isWorktree: boolean,
	): Promise<string> {
		// ── .saros/AGENT.md 人写规则注入（借鉴 Claude Code 双系统设计）──
		// 用户可以在工作区根目录放置 .saros/AGENT.md 文件，写入一锤定音的约束
		// （例如"永远用 pnpm"、"提交前跑 npm test"），这些规则会无条件覆盖 AI
		// 自动抽取的偏好，优先级最高。
		// 参见：doc/Memory-Strategy.md §四.4 / §五.3
		let agentMdSection = '';
		try {
			const agentMdUri = URI.joinPath(URI.file(rootDir), '.saros', 'AGENT.md');
			const exists = await this._fileService.exists(agentMdUri);
			if (exists) {
				const buf = await this._fileService.readFile(agentMdUri);
				const content = buf.value.toString().trim();
				if (content.length > 0) {
					agentMdSection = `## Project-level Rules (.saros/AGENT.md)\n\nThe following rules were written by the user and MUST be strictly followed:\n\n${content}`;
					this._logService.info(`[AgentDriver] Loaded .saros/AGENT.md (${content.length} chars)`);
				}
			}
		} catch (err) {
			// 文件不存在或读取失败不影响主流程
			this._logService.debug(`[AgentDriver] .saros/AGENT.md not found or unreadable: ${err instanceof Error ? err.message : String(err)}`);
		}

		const lines: string[] = [
			'## Workspace Context',
			'',
			`You are operating inside the Sarosis workspace "${workspaceName}".`,
		];

		if (isWorktree) {
			lines.push(
				`This agent is bound to a dedicated git worktree. Your working directory is: ${rootDir}`,
				`You operate on this worktree's own branch, isolated from the main checkout. All file reads/writes, searches and commands run inside this worktree.`,
			);
		} else {
			lines.push(`The workspace root directory is: ${rootDir}`);
		}

		lines.push(
			'',
			'When the user refers to "workspace", "project", "current directory", or asks to print/list the workspace,',
			`they mean this directory: ${rootDir}`,
			'',
			'### Security Sandbox',
			'',
			`You are ONLY permitted to read, write, search, and execute commands within the working directory and its subdirectories.`,
			`You MUST NOT access, modify, or reference any files or directories outside of: ${rootDir}`,
			'If a user asks you to operate on a path outside this directory, refuse and explain that you are sandboxed to the current working directory.',
		);

		// 把 AGENT.md 的规则放在工作区上下文最前面（最高优先级）
		const workspaceContextText = lines.join('\n');
		return agentMdSection
			? `${agentMdSection}\n\n${workspaceContextText}`
			: workspaceContextText;
	}

	// ─── 兼容层：将旧 IChatSendOptions 适配为 IAgentTurnRequest ──

	/**
	 * 兼容现有 agentChatService.sendMessage() 调用方式
	 * Phase 2 中 agentChatService 将委托此方法
	 */
	async *executeFromChatOptions(
		agentId: string,
		message: string,
		options: IChatSendOptions,
		priorMessages?: import('../common/providers.js').IChatMessage[],
	): AsyncIterable<IChatStreamDelta> {
		// Build content parts: text + image attachments
		const contentParts: Array<import('../common/providers.js').IChatContentPart> = [];
		if (message.trim()) {
			contentParts.push({ type: 'text', text: message });
		}
		if (options.attachments) {
			for (const att of options.attachments) {
				if (att.type === 'image' && att.mimeType.startsWith('image/')) {
					contentParts.push({
						type: 'image',
						data: att.data,
						mimeType: att.mimeType as import('../common/providers.js').ChatImageMimeType,
					});
				}
				// File attachments: include as text context in the message
				if (att.type === 'file') {
					const fileContext = `\n\n--- File: ${att.name} ---\n${att.data}\n--- End of ${att.name} ---`;
					if (contentParts.length > 0 && contentParts[0].type === 'text') {
						// Append to existing text part
						(contentParts[0] as { type: 'text'; text: string }).text += fileContext;
					} else {
						contentParts.push({ type: 'text', text: fileContext });
					}
				}
			}
		}

		const userMessage: import('../common/providers.js').IChatMessage = {
			role: 'user',
			content: message,
			contentParts: contentParts.length > 0 ? contentParts : undefined,
		};

		const request: IAgentTurnRequest = {
			agentId: agentId,
			sessionId: options.agentSessionId,
			// 完整会话历史（由 chatService 从持久化历史转换并去重当前 user 消息后传入）
			// + 本轮 user 消息。priorMessages 缺省时退化为仅当前消息（旧行为）。
			messages: [...(priorMessages ?? []), userMessage],
			systemPrompt: options.systemPrompt,
			explicitSkillIds: options.explicitSkillIds,
			worktreePath: options.worktreePath,
			// v39: forward per-request model override from workflow node config.
			// When both providerId and model are set, override the global selection.
			modelOverride: (options.providerId && options.model)
				? { providerId: options.providerId, modelId: options.model }
				: undefined,
			options: {
				temperature: options.temperature,
				reasoning: options.reasoning,
			},
		};
		yield* this.executeTurn(request);
	}
}
