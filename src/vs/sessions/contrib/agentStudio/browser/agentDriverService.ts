/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAgentDriverService, AgentTurnStatus } from '../common/agentDriver.js';
import { IAgentTurnRequest, IMemoryContext, IMemoryProvider, ChatImageMimeType, IChatContentPart } from '../common/providers.js';
import type { IChatStreamDelta } from '../common/providers.js';
import { IAgentOSService } from '../common/agentOS.js';
import type { IChatSendOptions } from '../common/agentStudio.js';
import type { IChatAttachmentSend } from '../../../common/agentStudioService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISkillRegistry } from '../common/skills.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { AGENT_STUDIO_SKILLS_MAX_IN_PROMPT_SETTING, AGENT_STUDIO_SKILLS_MAX_PROMPT_CHARS_SETTING } from '../common/constants.js';
import { filterToolsByChatMode, getModeSystemPrompt, GLOBAL_SYSTEM_SUFFIX } from '../common/chatModeConfig.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { IMcpService, McpConnectionState } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';

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
		@IMcpService private readonly _mcpService: IMcpService,
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
		let resolvedMemoryScope: 'agent' | 'global' = 'agent';

	try {
		this._updateTurnStatus(turnId, AgentTurnStatus.Running);
		this._logService.info(`[AgentDriver] executeTurn START: agentId=${request.agentId}, sessionId=${request.sessionId ?? 'none'}, messages=${request.messages.length}, turnId=${turnId}`);

		// ─── 完整编排逻辑 ─────────────────────────────────
			// 1. Planning Slot 分析意图（如果有 Planning Provider）
			// 2. Memory Slot 加载上下文（如果有 Memory Provider）
			// 3. 委托 AgentOS 执行（ExecutionProvider 或 直通模式）
			// 4. Memory Slot 写回记忆（如果有 Memory Provider）
			// 5. 返回结果给 UI

		// Step 1: 加载 Memory 上下文
		let memoryContext: IMemoryContext | undefined;
		this._logService.info(`[AgentDriver] Step 1: loading memory context (provider=${memoryProvider ? 'yes' : 'no'})`);
		if (memoryProvider) {
				try {
					// 抽取最近一条 user 消息作为召回 query —— 让 vendor 能用真实意图
					// 做 FTS5/embedding 匹配，而不是占位字符串。
					const recallQuery = [...request.messages].reverse().find(m => m.role === 'user')?.content ?? '';

					// ── 召回作用域（2026-06）──────────────────────────────────────
					// 决定本 agent 能看到哪些 agent 的 L1 记忆：
					//   - 'agent'(默认)   → 仅本 agent 自己的
					//   - 'global'        → 全库（跨 agent 共享）
					// 老 agent 配置缺省值视作 'agent'（C2：严格隔离），与文档
					// Memory-Strategy.md §recall-scope 对齐。
				let recallOptions: { scope: 'agent' | 'global' } | undefined;
				try {
					// Recall scope is per-workspace runtime state → read from
					// the AgentBinding, not the global Agent.
					this._logService.info(`[AgentDriver] Step 1a: resolving workspaceId (sessionId=${request.sessionId ?? 'none'})`);
					const wsId = await this._resolveWorkspaceId(request.sessionId);
					this._logService.info(`[AgentDriver] Step 1a: resolved workspaceId=${wsId ?? 'none'}`);
					this._logService.info(`[AgentDriver] Step 1b: getting agent binding (agentId=${request.agentId})`);
					const binding = wsId
						? await this._agentStudioService.getAgentBinding(wsId, request.agentId)
						: undefined;
					this._logService.info(`[AgentDriver] Step 1b: got binding=${binding ? 'yes' : 'no'}`);
					const scope: 'agent' | 'global' = binding?.memoryConfig?.scope ?? 'agent';

					if (scope === 'global') {
						recallOptions = { scope: 'global' };
					} else {
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

				this._logService.info(`[AgentDriver] Step 1c: loading memory context (scope=${recallOptions.scope}, queryLen=${recallQuery.length})`);
				memoryContext = await memoryProvider.loadContext(
					request.agentId,
					request.sessionId || '',
					recallQuery,
					recallOptions,
				);
				this._logService.info(`[AgentDriver] Step 1c: memory context loaded (hasContext=${memoryContext ? 'yes' : 'no'})`);
				} catch (error) {
					this._logService.error('[AgentDriver] Failed to load memory context:', error);
				}
			}

		// Step 2: (removed) Planning Provider 预分析阶段
		// 2026-07-04: 对齐 OpenClaw — 不在执行前做预分析。
		// OpenClaw 信任 LLM 自主规划能力，通过 update_plan 工具让 LLM 在执行中交织规划。
		// 旧的 PlanningProvider 基于正则关键词匹配复杂度 + 硬编码步骤模板，产出无实际指导价值。
		// 现在由 LLM 通过 update_plan 工具自行规划，替代旧的 todo 工具。

	// Step 3: 解析并注入已激活的 Skills + 已安装技能清单
	const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
	let enrichedRequest = request;
	this._logService.info(`[AgentDriver] Step 3: enriching request (memoryCtx=${memoryContext ? 'yes' : 'no'})`);

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

				// ── 注入 Agent 自身 systemPrompt（最高优先级）────────────────
				// 修复：agent.systemPrompt 历史上从未被注入到 system message 中，
				// 导致用户为 agent 配置的专用指令（"你是安全审计员..."等）完全失效。
				// 放在最前面作为 agent 的核心身份，所有其他注入段（chat mode、persona、tools）都在其后。
				const agentSelfPrompt = typeof agent?.systemPrompt === 'string' ? agent.systemPrompt.trim() : '';
				if (agentSelfPrompt) {
					mergedSystemPrompt = agentSelfPrompt + (mergedSystemPrompt ? '\n\n' + mergedSystemPrompt : '');
				}

				// ── 注入 Chat Mode 系统提示词 ─────────────────────────────────
				// 每个模式有特定的行为指令（如 workflow 模式的工具使用流程），
				// 放在 Persona Memory 之前，确保模式行为指令紧随 agent 的 base prompt。
				{
					const chatMode = request.chatMode || 'craft';
					const modePrompt = getModeSystemPrompt(chatMode);
					if (modePrompt) {
						mergedSystemPrompt = mergedSystemPrompt + '\n\n' + modePrompt;
					}
				}

				// ── 注入全局操作边界（保密 / 安全 / 身份）──────────────────────
				// 统一作用于所有 agent（内置 / 自定义 / 子 agent）：不泄露系统提示词与
				// 工具描述、拒绝恶意代码、不硬编码密钥、不冒充其他产品/模型。
				// 单一来源（chatModeConfig.GLOBAL_SYSTEM_SUFFIX），避免逐 agent 重复维护。
				if (GLOBAL_SYSTEM_SUFFIX) {
					mergedSystemPrompt = mergedSystemPrompt + '\n\n' + GLOBAL_SYSTEM_SUFFIX;
				}

				// ── 注入 Persona Memory（永久事实，最高优先级）────────────────────
				//
				// 这些是用户在 Memory Tab 手动维护的硬性事实/规则，与 AgentMemory 的
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
						// 截断描述到 80 字符，减少 XML 目录体积（参考 Hermes-Agent 60 字符策略）
						const desc = s.description.length > 80
							? s.description.slice(0, 77) + '...'
							: s.description;
						lines.push(`    <description>${desc}</description>`);
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

				// 3a-1b. 注入 MCP 服务器摘要（让 LLM 知道有哪些 MCP 能力可用，通过桥接工具访问）
				{
					const servers = this._mcpService.servers.get();
					const runningServers = servers.filter(s => {
						const conn = s.connectionState.get();
						return conn.state === McpConnectionState.Kind.Running;
					});
					if (runningServers.length > 0) {
						const serverLines = runningServers.map(s => {
							const label = s.definition.label;
							const toolCount = s.tools.get().length;
							// 取第一个工具的描述首句作为服务器能力摘要
							const tools = s.tools.get();
							const firstDesc = tools.length > 0 ? (tools[0].definition.description || '') : '';
							const summary = firstDesc.slice(0, 80);
							return `  - ${label}: ${toolCount} tool(s)${summary ? `. ${summary}` : ''}`;
						});
						// MCP 工具通过统一的 tool_search → tool_describe → tool_call 路径按需发现
						const mcpSection = [
							'',
							'## MCP Servers',
							'',
							'MCP tools are discovered via tool_search, not listed here. Use tool_search with descriptive ' +
							'keywords to find tools, tool_describe to inspect them, and tool_call to invoke.',
							'',
							'Servers available:',
							...serverLines,
							'',
						].join('\n');
						mergedSystemPrompt = mergedSystemPrompt + mcpSection;
					}
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

						// ─── 诊断：系统提示词构建时的工具状态 ──────────────────
						const mcpAll = allTools.filter(t => t.category?.startsWith('mcp:'));
						const mcpEnabled = enabledToolsRaw.filter(t => t.category?.startsWith('mcp:'));
						const mcpAfterFilter = enabledTools.filter(t => t.category?.startsWith('mcp:'));
						this._logService.info(
							`[AgentDriver] Tool inventory: all=${allTools.length}, enabled=${enabledToolsRaw.length}, ` +
							`afterChatModeFilter=${enabledTools.length} (mode=${chatMode})\n` +
							`  MCP: all=${mcpAll.length}, enabled=${mcpEnabled.length}, afterFilter=${mcpAfterFilter.length}\n` +
							`  MCP tool names: [${mcpAll.map(t => t.name).join(', ')}]\n` +
							`  MCP securityLevels: [${mcpAll.map(t => `${t.name}=${t.securityLevel ?? 'undefined'}`).join(', ')}]`
						);
						if (mcpAll.length === 0) {
							this._logService.warn(`[AgentDriver] ⚠ NO MCP TOOLS discovered! McpToolProvider._routes may be empty (server not connected).`);
						}
						if (mcpEnabled.length > 0 && mcpAfterFilter.length === 0) {
							this._logService.warn(`[AgentDriver] ⚠ MCP tools exist (${mcpEnabled.length}) but ALL filtered out by chatMode=${chatMode}! Check securityLevel inference.`);
						}

					// MCP 工具不在此清单列出：它们经由 ## MCP Servers 通过 tool_search 桥接暴露，
					// 且不会进入 API 的 tools 参数（agentOSService._getEnabledTools 在 passthrough
					// 模式下已剥离 MCP 直发 schema，避免 API 400）。若在此列出，LLM 会直接调用它们，
					// 而被 AgentOS 识别为"幻觉调用"（hallucinated）并丢弃，最终报错
					// "Tool was not executed (conversation ended before execution)"。
					const nonMcpTools = enabledTools.filter(t => !t.category?.startsWith('mcp:'));

					if (nonMcpTools.length > 0) {
						// ── 工具排序（对齐 OpenClaw toolOrder）─────────────────
						// 将高频分析工具排在前面，避免 LLM 在前几项找到 search_files/terminal 后就停止扫描
						const HIGH_PRIORITY_TOOLS = new Set([
							'search_graph', 'query_graph', 'get_architecture', 'trace_path',
							'search_code', 'get_code_snippet', 'index_repository', 'index_status',
							'detect_changes', 'update_plan',
							'tool_search', 'tool_describe', 'tool_call',
						]);
						const sortedTools = [...nonMcpTools].sort((a, b) => {
								const aPri = HIGH_PRIORITY_TOOLS.has(a.name) ? 0 : 1;
								const bPri = HIGH_PRIORITY_TOOLS.has(b.name) ? 0 : 1;
								return aPri - bPri || a.name.localeCompare(b.name);
							});

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
								...sortedTools.map(t => {
									const desc = (t as any).displaySummary || t.description || 'No description';
									return `- ${t.name}: ${desc}`;
								}),
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

							// ─── 通用执行原则（对齐 OpenClaw — 无领域特定引导）─────────
							// OpenClaw 依赖工具自身的 name+description 让 LLM 自行判断何时使用。
							// system prompt 只提供通用原则，不硬编码 "use X for Y task" 领域引导。
							// 工具列表已在 ## Available Tools 中以 `name: description` 格式列出。
							toolSection.push(
								'',
								'## General Tool Usage',
								'',
								'When a specialized tool exists in the available tools list above, use it directly.',
								'Do not simulate or manually reimplement what a tool does by chaining basic operations.',
								'Review each tool\'s description to understand its capabilities and use the most efficient one.',
								'',
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
						// 强制加载：agent 配置中指定的技能全部注入全文，不依赖 activation/关键词
						required: allSkills.map(s => s.id),
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

				// ── 注入 Memory Extract 提示（AgentMemory L1 写入的唯一上行通道）──
				//
				// 背景：agentmemory-memory 的 L1 持久化依赖模型在回复末尾自行输出
				//   <memory_extract>{...}</memory_extract>
				// 标签。下行解析在 agentDriverService.ts 的 SSE 流式 buffer 和
				// extensions/agentmemory-memory/src/memoryProvider.ts 都已实现，
				// 但**没有任何地方告诉模型要输出这个标签**——除了 Knot 服务端
				// 自己内置的提示词（不可控），其他 Provider 完全不会主动产出，
				// 导致 Episodic 长期处于"接得到、收不到"的状态。
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
				// 切换为 'summary'（仅注入 Episodic 长期摘要），避免重复。
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
				};

				this._logService.info(`[AgentDriver] Injected memory_extract guidance (${memoryExtractGuide.length} chars) — provider=${activeModelSelection?.providerId ?? 'none'}`);
				this._logService.info(`[AgentDriver] Skill inventory: ${allSkills.length} skills (lightweight XML catalog injected), systemPrompt length: ${mergedSystemPrompt.length}`);
				this._logService.info(`[AgentDriver] systemPrompt preview: ${mergedSystemPrompt.substring(0, 300)}...`);
				this._logService.info(`[AgentDriver] Memory injection policy: strategy=${memoryStrategy}, maxEntries=${memoryMaxEntries ?? 'unlimited'}, scope=${resolvedMemoryScope} (raw=${rawStrategy ?? 'undefined'})`);
			} catch (error) {
				this._logService.error('[AgentDriver] Failed to resolve skill activations:', error);
				// Skill 解析失败不阻塞主流程
			}

		// Step 4: 委托 AgentOS 执行（ExecutionProvider 或 直通模式）
		// 同时累积 assistant 文本，便于 Step 5 写回完整一轮的 assistant 记忆。
		this._logService.info(`[AgentDriver] Step 4: delegating to AgentOS (enrichedMsgs=${enrichedRequest.messages.length})`);
		const osStream = this._agentOS.executeAgentTurn(enrichedRequest);

			// ── 流式记忆标签剥离缓冲区 ──────────────────────────────────────────
			// Knot 可能在回复末尾输出记忆标签，需要在流式阶段就剥离，避免用户看到。
			// 支持两种格式：
			//   1. <memory_extract>{JSON}</memory_extract>  （图里方案，推荐）
			//   2. [MEMORY:L1:type:priority:scene]内容[/MEMORY]  （旧格式，兼容）
			// 由于标签可能跨多个 delta 分片，使用缓冲区处理跨片情况。
			let tagBuffer = '';
			let tagOpenLogged = false; // 防止 "awaiting close" 日志在每个 delta 重复刷屏
			/** 收集本次 processTextChunk 调用中捕获的记忆标签，供主循环 yield memory_extracted 事件 */
			const capturedMemoryTags: Array<{ content: string; type?: string; priority?: number; sceneName?: string; raw: string }> = [];
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
				tagOpenLogged = false;
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
							// 标签未闭合，缓冲等待后续 delta
							// 但先检查：内容是否看起来像真正的标签（JSON 开头）
							const afterTag = remaining.slice(matchedOpen.length).trimStart();
							const MAX_BUFFER = 5000; // 安全阀：缓冲区超过此大小则按普通文本处理

							if (matchedOpen === '<memory_extract>' && afterTag.length > 5 && !afterTag.startsWith('{')) {
								// 内容不是 JSON 开头 → 模型只是在文档/讨论中提到了标签名，不是真正的记忆标签
								// 当作普通文本输出，不缓冲
								output += remaining;
								remaining = '';
							} else if (remaining.length > MAX_BUFFER) {
								// 缓冲区过大，可能是模型输出了未闭合的标签 → 当作普通文本
								output += remaining;
								remaining = '';
							} else {
								// 真正的标签等待闭合 — 仅记录一次日志（避免每个 delta 刷屏）
								if (!tagOpenLogged) {
									tagOpenLogged = true;
									const seenOpenMsg = `[AgentDriver] ⏳ Memory tag open detected, awaiting close (open="${matchedOpen}", bufferedLen=${remaining.length}, preview="${remaining.replace(/\s+/g, ' ').slice(0, 200)}")`;
									this._logService.info(seenOpenMsg);
								}
								tagBuffer = remaining;
								remaining = '';
							}
						} else {
							// 找到完整标签，剥离它（不输出给用户）
							const fullTag = remaining.slice(0, closeIdx + tagClose.length);
							// 解析记忆数据，推入 capturedMemoryTags 供主循环 yield
							const tagContent = remaining.slice(matchedOpen.length, closeIdx).trim();
							let parsed: { content?: string; type?: string; priority?: number; scene_name?: string } | null = null;
							if (matchedOpen === '<memory_extract>') {
								try { parsed = JSON.parse(tagContent); } catch { /* noop */ }
							}
							capturedMemoryTags.push({
								content: parsed?.content ?? tagContent,
								type: parsed?.type,
								priority: parsed?.priority,
								sceneName: parsed?.scene_name,
								raw: fullTag,
							});
							const diagMsg = `[AgentDriver] 🧠 Captured memory tag (open="${matchedOpen}", len=${fullTag.length}): ${fullTag.replace(/\s+/g, ' ').slice(0, 300)}`;
							this._logService.info(diagMsg);
							// 镜像到 DevTools console，便于排查（_logService 默认走 OutputChannel/log 文件，DevTools 不可见）
							try { console.warn(diagMsg); } catch { /* noop */ }
							remaining = remaining.slice(closeIdx + tagClose.length);
							tagOpenLogged = false; // 标签已闭合，重置日志标志供下次使用
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
					capturedMemoryTags.length = 0;
					const cleanContent = processTextChunk(delta.content);
					if (cleanContent.length > 0) {
						assistantChunks.push(cleanContent);
						yield { ...delta, content: cleanContent };
					}
					// 捕获到记忆标签 → yield memory_extracted 事件供前端渲染卡片
					for (const mem of capturedMemoryTags) {
						yield { type: 'memory_extracted', content: mem.content, metadata: { memoryType: mem.type, priority: mem.priority, sceneName: mem.sceneName } };
					}
					// 如果 cleanContent 为空（整个 delta 都是标签），不 yield
				} else if (delta.type === 'content_replace' && typeof delta.content === 'string') {
					// content_replace：用最新内容覆盖整个 assistant 输出
					// 【诊断】content_replace 模式下也累积 raw（覆盖式）
					rawDeltaChunks.length = 0;
					rawDeltaChunks.push(delta.content);
					// 对完整内容做一次全量剥离
					tagBuffer = '';
					capturedMemoryTags.length = 0;
					const cleanContent = processTextChunk(delta.content) + flushTagBuffer();
					assistantChunks.length = 0;
					assistantChunks.push(cleanContent);
					yield { ...delta, content: cleanContent };
					for (const mem of capturedMemoryTags) {
						yield { type: 'memory_extracted', content: mem.content, metadata: { memoryType: mem.type, priority: mem.priority, sceneName: mem.sceneName } };
					}
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

			this._logService.info(`[AgentDriver] Before _updateTurnStatus(Done)`);
			this._updateTurnStatus(turnId, AgentTurnStatus.Done);
			this._logService.info(`[AgentDriver] After _updateTurnStatus(Done)`);

		} catch (error) {
			this._logService.error(`[AgentDriver] Turn ${turnId} failed:`, error);
			this._updateTurnStatus(turnId, AgentTurnStatus.Error);
			yield {
				type: 'error',
				content: String(error),
			};
		} finally {
			this._activeTurns.delete(turnId);
			this._logService.info(`[AgentDriver] finally block START (turnId=${turnId})`);

			// ── 恢复 AgentBinding.worktreePath ─────────────────────────
			// ⚠ 同 memory write 的教训（行 861-866 注释）：async generator 的 finally
			// 块中 await 会阻塞 generator 的 return，进而阻塞 consumer（agentChatService）
			// 的 for-await 循环退出。worktree 恢复同样改为 fire-and-forget + 超时保护。
			if (originalBindingWorktreePath !== undefined) {
				const restoreStart = Date.now();
				void (async () => {
					try {
						// 超时保护：5 秒内未完成则放弃，避免 finally 块永远挂起
						const timeoutPromise = new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error('worktree restore timeout (5s)')), 5000)
						);
						const workspaceId = await Promise.race([
							this._resolveWorkspaceId(request.sessionId),
							timeoutPromise,
						]);
						if (workspaceId) {
							await Promise.race([
								this._agentStudioService.upsertAgentBinding(
									workspaceId,
									request.agentId,
									{ worktreePath: originalBindingWorktreePath || undefined },
								),
								timeoutPromise,
							]);
							this._logService.info(
								`[AgentDriver] Restored binding.worktreePath="${originalBindingWorktreePath || '(none)'}" ` +
								`after task execution (${Date.now() - restoreStart}ms)`
							);
						}
					} catch (err) {
						this._logService.warn(
							`[AgentDriver] Failed to restore binding worktreePath (${Date.now() - restoreStart}ms):`,
							err
						);
					}
				})();
			}

			// Step 5: 写回记忆（放在 finally 确保即使 generator 被外层提前终止也能执行）
			// ⚠ 关键：必须连续写两条——user 一条 + assistant 一条，
			// 这样下游 Memory Provider（如 agentmemory-memory）才能配对成完整一轮，
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
			// 生成 noticeId 供 UI 卡片状态跟踪 (pending → saved/failed)
			const noticeId = `mem-l0-${ts}`;
			// yield memory_writing delta：通知 UI 显示 pending 卡片
			yield {
				type: 'memory_writing',
				content: `Working 记忆写入中：用户消息 + 助手回复 (${assistantContent.length} 字符)`,
				metadata: {
					memoryType: 'working',
					sceneName: 'Working 写入',
					priority: 50,
					noticeId,
				},
			} as IChatStreamDelta;
			(async () => {
					try {
						if (lastUserMessage) {
							await memoryProvider.writeMemory(request.agentId, {
								id: `memory-user-${ts}`,
								type: 'working',
								content: lastUserMessage.content,
								metadata: { ...sessionMeta, role: 'user', noticeId },
								timestamp: ts,
							});
						}

						if (assistantContent.length > 0) {
							await memoryProvider.writeMemory(request.agentId, {
								id: `memory-assistant-${ts + 1}`,
								type: 'working',
								content: assistantContent,
								metadata: { ...sessionMeta, role: 'assistant', noticeId },
								timestamp: ts + 1,
							});
						}

						this._logService.info(`[AgentDriver] Wrote memory for ${request.agentId} (user=${lastUserMessage ? 'yes' : 'no'}, assistantLen=${assistantContent.length})`);
					} catch (error) {
						this._logService.error('[AgentDriver] Failed to write memory:', error);
					}
				})();

				// ─── Episodic 自动提取触发（对齐 AgentMemory L0→L1 pipeline）──────────────
				// 每 N 轮对话后，后台调用 LLM 从最近对话中提取结构化长期记忆。
				// 不依赖 LLM 主动调 memory_remember，系统自动提取值得记住的事实。
				// Wrapped in try-catch: L1 extraction is a background optimization
				// and must NEVER break the main turn flow (which would skip assistant
				// message persistence, causing messages to disappear after reload).
				try {
					this._agentOS.triggerEpisodicExtraction(
						request.agentId,
						request.sessionId,
						lastUserMessage?.content ?? '',
						assistantContent,
					);
				} catch (l1Err) {
					this._logService.error('[AgentDriver] triggerEpisodicExtraction failed (non-fatal):', l1Err);
				}
			}
		}
		this._logService.info(`[AgentDriver] finally block END (turnId=${turnId}) — generator returning, for-await loop will exit`);
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

	getActiveMemoryProvider(): IMemoryProvider | undefined {
		return this._agentOS.getActiveMemoryProvider();
	}

	private _updateTurnStatus(turnId: string, status: AgentTurnStatus): void {
		this._turnStatusMap.set(turnId, status);
		try {
			this._onDidChangeTurnStatus.fire({ status, turnId });
		} catch (e) {
			this._logService.warn(`[AgentDriver] _onDidChangeTurnStatus.fire() threw for status=${status}:`, e);
		}
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

			return this._composeWorkspaceContextText(workspace.name, workspaceRoot, /* isWorktree */ false, workspace.relatedFolders);
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
		relatedFolders?: Array<{ path: string; name?: string; isGitRepo?: boolean }>,
	): Promise<string> {
		// ── .saros/AGENT.md 人写规则注入（借鉴 Claude Code 双系统设计）──
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

		// ── 列出所有关联目录 ──────────────────────────────────────────
		// 工作区可能关联多个代码仓库（如 S1Game + UE5EA）。
		// LLM 需要知道所有目录才能正确搜索所有代码。
		const dirs = (relatedFolders ?? []).filter(f => f?.path && f.path !== rootDir);
		if (dirs.length > 0) {
			lines.push('');
			lines.push('### Related Directories');
			lines.push('This workspace also includes the following directories. When searching code or analyzing the project structure, you should search ALL of these:');
			for (const f of dirs) {
				const name = f.name || f.path.split(/[\\/]/).pop() || f.path;
				const gitTag = f.isGitRepo ? ' [git]' : '';
				lines.push(`  - ${name}: ${f.path}${gitTag}`);
			}
		}

		// ── Codebase 工具摘要（对齐 OpenClaw coreToolSummaries — 工具名+用途）─
		// 不写 "use X for Y task" 领域引导，依赖工具描述让 LLM 自行判断。
		lines.push('');
		lines.push('### Codebase Tools (Direct)');
		lines.push('IMPORTANT: The codebase graph persists across sessions and auto-loads on startup. ' +
			'Use index_status to check if the graph is ready. Only call index_repository if the graph is NOT already loaded ' +
			'(it will skip automatically if loaded, but you can avoid wasting a turn by checking first).');
		lines.push('- index_repository: Build code knowledge graph (one-time; skips if already loaded unless force=true).');
		lines.push('- index_status: Check graph status (loaded node/edge/file counts).');
		lines.push('- search_graph: BM25 full-text search or name_pattern regex. query="..." for natural language. file_pattern/label filter. Pagination via limit+offset+hasMore.');
		lines.push('- search_code: Grep-style text search enriched with graph structure. mode=compact|full|files, context lines.');
		lines.push('- query_graph: Cypher queries (MATCH, WHERE, RETURN, ORDER BY, LIMIT).');
		lines.push('- get_architecture: Overview with communities, languages, packages, hotspots. aspects for dimensions.');
		lines.push('- trace_path: Call chain tracing (mode=calls|data_flow|cross_service).');
		lines.push('- get_code_snippet: Read source code by qualifiedName, with neighbor context.');
		lines.push('If a tool returns "no graph loaded", call index_repository first (one-time only).');







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
		// 构建多模态 contentParts：文本 + 图片附件（文件附件以文本上下文内联）。
		// 提取为纯函数 buildUserContentParts 便于单测，且保证与 chat 输入框附件透传逻辑一致。
		const contentParts = buildUserContentParts(message, options.attachments);

		const userMessage: import('../common/providers.js').IChatMessage = {
			role: 'user',
			content: message,
			contentParts,
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

/**
 * 将用户文本消息 + 附件转换为多模态 contentParts（IChatContentPart[]）。
 *
 * 规则：
 * - 无附件时返回 undefined，消息由 IChatMessage.content 字段承载（向后兼容，
 *   避免给每条纯文本消息都附加 contentParts，影响历史序列化/Token 计算）。
 * - 图片附件（type==='image' 且 mimeType 以 image/ 开头）→ image contentPart，
 *   携带 base64 data + mimeType。下游 MessageFormatConverter 会将其转换为对应
 *   LLM API 的多模态格式（OpenAI image_url / Anthropic base64 source / Gemini
 *   inline_data），确保图片真实内容送达 LLM。
 * - 文件附件（type==='file'）→ 以文本块形式内联到 text contentPart
 *   （文本文件为原文，二进制文件为其 base64），供模型作为上下文阅读。
 *
 * 该纯函数同时被 executeFromChatOptions 调用，并被单测直接覆盖，
 * 是"聊天输入框附件能否正确发送给 LLM"的核心逻辑。
 */
export function buildUserContentParts(
	message: string,
	attachments?: readonly IChatAttachmentSend[],
): IChatContentPart[] | undefined {
	if (!attachments || attachments.length === 0) {
		return undefined;
	}

	const contentParts: IChatContentPart[] = [];
	if (message.trim()) {
		contentParts.push({ type: 'text', text: message });
	}

	for (const att of attachments) {
		if (att.type === 'image' && att.mimeType.startsWith('image/')) {
			contentParts.push({
				type: 'image',
				data: att.data,
				mimeType: att.mimeType as ChatImageMimeType,
			});
		} else if (att.type === 'file') {
			const fileContext = `\n\n--- File: ${att.name} ---\n${att.data}\n--- End of ${att.name} ---`;
			if (contentParts.length > 0 && contentParts[0].type === 'text') {
				// 追加到首个 text 块，避免产生过多零散文本块
				(contentParts[0] as { type: 'text'; text: string }).text += fileContext;
			} else {
				contentParts.push({ type: 'text', text: fileContext });
			}
		}
	}

	return contentParts.length > 0 ? contentParts : undefined;
}
