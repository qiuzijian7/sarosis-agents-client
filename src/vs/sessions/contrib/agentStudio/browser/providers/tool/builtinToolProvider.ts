/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内置 Tool Provider —— 见 `common/providers.ts` 中的 `IToolProvider` 契约。
 *
 * 设计借鉴 Hermes-Agent `tools/registry.py`：
 *   - 每个工具用一个常量描述符注册（schema + handler + check）。
 *   - `category` 充当 hermes 的 toolset，便于 UI 按组展示与启停。
 *   - `check_fn` 决定该工具在当前环境是否可用（例如 shell_exec 仅在桌面端）。
 *
 * 与 hermes 不同的地方：
 *   - 这里的 handler 是 TS async 函数，返回 IToolResultContent[]（更贴合 IMcpTool 风格）。
 *   - 不做 prompt-cache TTL 缓存（VSCode renderer 周期短，不必要）。
 *   - 文件操作走 IFileService，而非 Node.js fs；所以在 web 端也能跑 file_read/file_write。
 *
 * 工具集合：
 *   utility   : clarify
 *   filesystem: file_read, file_write, search_files, patch
 *   shell     : terminal (仅 desktop)
 *   web       : web_search, web_extract (需外部 provider，未配置则降级提示)
 *
 *   另外，从 Hermes-Agent 迁移了 69 个 bundled tool 定义（schema-only）。
 *   这些工具只有 schema，handler 为存根，返回"未实现"提示。
 *   实际执行需通过 MCP 服务器或后续实现的 Provider。
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IWebContentExtractorService } from '../../../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { ISearchService } from '../../../../../../workbench/services/search/common/search.js';
import { IKbNativeKernelService } from '../../kbNativeKernelService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../../../nls.js';
import { IAiEmbeddingVectorService } from '../../../../../../workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IRequestService } from '../../../../../../platform/request/common/request.js';
import { IToolProvider, IToolDefinition, IToolCall, IToolResult } from '../../../common/providers.js';
import { ISkillRegistry } from '../../../common/skills.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ITerminalService } from '../../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IAgentStudioService, ITaskOrchestrationService, IAgentTaskBoardService } from '../../../../../common/agentStudioService.js';
import { ITriageService } from '../../../common/triageService.js';
import { ISwarmService } from '../../../common/swarmService.js';
import { ICheckpointService } from '../../../common/checkpointService.js';
import { IAgentOSService } from '../../../common/agentOS.js';
import { IWorkflowStorageService } from '../../../common/workflowStorage.js';
import { SkillManagerTool } from '../../skillManagerTool.js';
import { SkillUsageTracker } from '../../skillUsageTracker.js';
import { ICodebaseGraphService } from '../../codebaseGraphService.js';
import { AdrManager } from '../../codebaseGraphAdr.js';
import { registerCodebaseTools } from './codebaseTools.js';
import { registerKanbanTools } from './kanbanTools.js';
import { registerWorkflowTools } from './workflowTools.js';
import { registerCanvasTools } from './canvasTools.js';
import { registerMindmapTools } from './mindmapTools.js';
import { IPlaywrightService } from '../../../../../../platform/browserView/common/playwrightService.js';
import { IEditorService } from '../../../../../../workbench/services/editor/common/editorService.js';
import { ISessionsManagementService } from '../../../../../../sessions/services/sessions/common/sessionsManagement.js';
import { IKanbanRecipeService } from './kanbanRecipeService.js';
import { SearchHelpers } from './searchHelpers.js';
import { registerWebTools, type WebToolContext } from './webTools.js';
import { registerBundledTools, type BundledToolContext } from './bundledTools.js';
import { registerUnifiedMemoryTools, type UnifiedMemoryToolContext } from './unifiedMemoryTools.js';
import { registerMemoryTools, type MemoryToolContext } from './memoryTools.js';
import { registerAdvancedMemoryTools, type AdvancedMemoryToolContext } from './advancedMemoryTools.js';
import { registerRoutineCrystalFacetTools, type RoutineCrystalFacetToolContext } from './routineCrystalFacetTools.js';
import { registerSkillTools, type SkillToolContext } from './skillTools.js';
import { registerCompatibilityTools, type CompatToolContext } from './compatibilityTools.js';
import { registerDelegationTools, type DelegationToolContext } from './delegationTools.js';
import { registerPlanExploreTool } from './planExploreTool.js';
import { registerPlanModeTools } from './planModeTools.js';
import { createKnowledgeStorageRegistrar, type IKnowledgeStorageRegistrar } from './knowledgeStorageTools.js';
import { resolveAndCheckWorkspacePathImpl } from './workspaceSecurity.js';
import { registerCoreTools } from './coreTools.js';
import { executeToolImpl } from './toolExecutor.js';
import { registerHandoffTools } from './handoffTools.js';
import { registerMermaidTools } from './mermaidTools.js';
import { ToolRegistry, type IBuiltinToolRegistration } from './toolRegistry.js';

/** Config key controlling where knowledge bases are persisted. Empty = `<userHome>/.saros/kb`. */
const AGENT_STUDIO_KB_STORAGE_PATH = 'agentStudio.knowledge.storage.path';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agentStudio.knowledge',
	properties: {
		[AGENT_STUDIO_KB_STORAGE_PATH]: {
			type: 'string',
			default: '',
			markdownDescription: localize('agentStudio.knowledge.storage.path', "Root directory for persisted knowledge bases. Leave empty to use the default `<userHome>/.saros/kb`. Supports `~` (user home) and absolute paths; relative paths are resolved against the user home. Changing this migrates existing knowledge bases to the new location automatically."),
			tags: ['agentStudio', 'knowledge'],
		},
	},
});



/**
 * Kanban 工具中已实现真实 handler 的名字集合。
 * 这些工具由 _registerKanbanTools() 注册，_registerBundledTools() 会跳过它们的 stub。
 */



/**
 * Module-level Emitter for AI-driven workflow changes.
 * Extracted to workflowShared.ts to break cyclic dependency with workflowTools.ts.
 */
export { workflowAppliedEmitter } from './workflowShared.js';
export { type IBuiltinToolRegistration } from './toolRegistry.js';



/**
 * 安全沙箱违规错误 — 路径不在允许的工作区目录内时抛出。
 * 携带结构化信息（请求路径 / 允许根 / 建议路径），供 agentOSService
 * 检测并向用户弹出确认卡片（而非仅回显一段错误文本）。
 */
export class BuiltinToolProvider extends Disposable implements IToolProvider {

	readonly id: string = 'saros.builtin-tools';
	readonly name: string = 'Saros Built-in Tools';

	/** 工具注册表 —— 封装工具描述符集合、启用状态与变更事件（见 toolRegistry.ts）。 */
	private readonly _registry = new ToolRegistry(this.logService);

	readonly onDidChangeTools = this._registry.onDidChangeTools;

	/** Skill Manager 工具实例 —— 提供 skill_create 能力 */
	private _skillManagerTool!: SkillManagerTool;
	private readonly _skillUsageTracker: SkillUsageTracker;

	// v17: worktree path inherited from the parent agent's execution context.
	// Set by `setParentWorktreePath()` before each turn; cleared on turn end.
	// Used by the `delegate_task` tool to propagate the worktree to sub-agents.
	private _parentWorktreePath: string | undefined;

	/**
	 * v17: set the worktree path inherited from the parent agent's request.
	 * This is consulted by the `delegate_task` tool when dispatching
	 * sub-agents so the entire subagent tree operates in the same worktree.
	 */
	setParentWorktreePath(path: string | undefined): void {
		this._parentWorktreePath = path;
	}

	/**
	 * v17: read the currently-set parent worktree (used by delegate_task).
	 */
	getParentWorktreePath(): string | undefined {
		return this._parentWorktreePath;
	}

	/**
	 * 沙箱路径解析（委托 workspaceSecurity.resolveAndCheckWorkspacePathImpl）。
	 * 保持为实例方法，以便 ctx 直接传入函数引用并访问 this._sandboxBypassRoots。
	 * @throws SandboxViolationError 如果路径不在任何允许的工作区内
	 */
	private _resolveAndCheckWorkspacePath(agentId: string | undefined, requestedPath: string, checkSandbox: boolean = true): Promise<string> {
		return resolveAndCheckWorkspacePathImpl({
			studioService: this.studioService,
			workspaceService: this.workspaceService,
			environmentService: this.environmentService,
			configurationService: this.configurationService,
			storageService: this.storageService,
			logService: this.logService,
			sandboxBypassRoots: this._sandboxBypassRoots,
			kbStoragePathKey: AGENT_STUDIO_KB_STORAGE_PATH,
		}, agentId, requestedPath, checkSandbox);
	}

	// ─── 沙箱临时放行（对齐 agentOSService 的「允许本次」确认）────────
	// 仅本次工具调用生效：agentOSService 在重试前 addSandboxBypassRoot，
	// 重试后 removeSandboxBypassRoot，避免泄露到后续 turn。
	private readonly _sandboxBypassRoots = new Set<string>();

	/** 临时放行某个精确路径（仅本次工具调用生效）。 */
	addSandboxBypassRoot(path: string): void {
		this._sandboxBypassRoots.add(path.replace(/[\\/]+$/, ''));
	}

	/** 移除临时放行的精确路径（见 addSandboxBypassRoot）。 */
	removeSandboxBypassRoot(path: string): void {
		this._sandboxBypassRoots.delete(path.replace(/[\\/]+$/, ''));
	}

	/** 清空所有临时放行的路径（turn 结束时调用）。 */
	clearSandboxBypassRoots(): void {
		this._sandboxBypassRoots.clear();
	}

	/** Per-turn 状态重置：清空文件读取去重/重复计数 Map。 */
	resetPerTurn(): void {
		this._corePerTurnReset?.();
	}


	/** ADR Manager 实例 —— 提供 manage_adr 能力 */
	private _adrManager!: AdrManager;

	/** 搜索相关 helper 集合（从本文件抽取到 searchHelpers.ts，降低主文件体积） */
	private readonly _searchHelpers: SearchHelpers;

	/** Core tools per-turn reset 回调（清空读去重/重复计数 Map）。 */
	private _corePerTurnReset?: () => void;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IAgentStudioService private readonly studioService: IAgentStudioService,
		@IAgentOSService private readonly agentOS: IAgentOSService,
		@ITaskOrchestrationService private readonly orchestrationService: ITaskOrchestrationService,
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
		@ITriageService private readonly triageService: ITriageService,
		@ISwarmService private readonly swarmService: ISwarmService,
	@ICheckpointService private readonly checkpointService: ICheckpointService,
	@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
	@IWorkflowStorageService private readonly workflowStorageService: IWorkflowStorageService,
		@ICodebaseGraphService private readonly codebaseGraphService: ICodebaseGraphService,
	@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	@IEditorService private readonly editorService: IEditorService,
	@ISessionsManagementService private readonly sessionsManagement: ISessionsManagementService,
		@IKanbanRecipeService private readonly recipeService: IKanbanRecipeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IAiEmbeddingVectorService private readonly embeddingService: IAiEmbeddingVectorService,
		@IRequestService private readonly requestService: IRequestService,
		@IWebContentExtractorService private readonly webContentExtractorService: IWebContentExtractorService,
		@ISearchService private readonly searchService: ISearchService,
		@IKbNativeKernelService private readonly kbKernelService: IKbNativeKernelService,
	) {
		super();
		this._skillManagerTool = new SkillManagerTool(
			this.environmentService,
			this.fileService,
			this.skillRegistry,
			this.logService,
		);
		this._skillUsageTracker = new SkillUsageTracker(this.fileService, this.logService);
		this._adrManager = new AdrManager(this.fileService);
		this._searchHelpers = new SearchHelpers(this.fileService, this.searchService, this.logService);
		// Phase 1: 注册内置 embedding provider（复用 BYOK API → /v1/embeddings）
		// 使 kb_* 工具无需扩展即可工作
		this._registerEmbeddingProvider();
		this._registerCoreTools();
		this._registerWebTools();
		this._registerCompatibilityTools();
		this._registerUnifiedMemoryTools(); // G12: recall/improve/forget
		this._registerMemoryTools(); // remember/search/delete/list（真实 handler，须在 bundled stub 之前注册）
		this._registerAdvancedMemoryTools(); // 接入引擎编排/治理能力：governance/team/mesh/sentinel/obsidian/cascade
		this._registerRoutineCrystalFacetTools(); // 接入高阶记忆能力：routine/crystal/facet
		this._registerSkillTools();
		this._registerBundledTools();
		this._registerDelegationTools();
		this._registerPlanExploreTool(); // WorkBuddy-style plan mode: parallel exploration
		this._registerPlanModeTools(); // MiMo-style plan_enter/plan_exit tools
		this._registerKanbanTools();
		this._registerMindmapTools();
		this._registerWorkflowTools();
		this._registerCanvasTools();
		this._registerCodebaseTools();
		this._registerKnowledgeTools(); // llm-wiki 知识内核（kb_search 工具）
		this._registerHandoffTools(); // supervisor 交接工具 transfer_to_agent（Step B）
		this._registerMermaidTools(); // Mermaid 图示渲染工具
		// _registerMcpBridgeTools() 已废弃 — MCP 工具统一走 tool_search/tool_describe/tool_call
		// 保留方法定义以备审计/兼容老调用
	}

	// ─── MCP Bridge Tools (DEPRECATED) ───────────────────────────────────────
	// 2026-07-03: 统一为单套桥接 tool_search/tool_describe/tool_call（对齐 Hermes-Agent）
	// MCP 工具现在通过 'mcp' toolset 纳入 deferrable 池，
	// LLM 通过统一的 tool_search → tool_describe → tool_call 路径发现和调用。
	// 原 _registerMcpBridgeTools() 方法体已删除，MCP 桥接工具不再注册。


	// ─── IToolProvider 实现（委托 ToolRegistry）───────────────────────

	async listTools(_agentId: string): Promise<IToolDefinition[]> {
		return this._registry.listTools(_agentId);
	}

	async getAllToolDefinitions(_agentId: string): Promise<IToolDefinition[]> {
		return this._registry.getAllToolDefinitions(_agentId);
	}

	async isToolEnabled(_agentId: string, toolName: string): Promise<boolean> {
		return this._registry.isToolEnabled(_agentId, toolName);
	}

	async enableTool(_agentId: string, toolName: string): Promise<void> {
		return this._registry.enableTool(_agentId, toolName);
	}

	async disableTool(_agentId: string, toolName: string): Promise<void> {
		return this._registry.disableTool(_agentId, toolName);
	}

	async getToolsEnabledState(_agentId: string): Promise<Record<string, boolean>> {
		return this._registry.getToolsEnabledState(_agentId);
	}

	async setToolsEnabledState(_agentId: string, state: Record<string, boolean>): Promise<void> {
		return this._registry.setToolsEnabledState(_agentId, state);
	}

	async executeTool(_agentId: string, toolCall: IToolCall, signal?: AbortSignal): Promise<IToolResult> {
		return executeToolImpl({
			resolveTool: name => this._registry.resolveTool(name),
			listToolNames: () => this._registry.toolNames(),
			logService: this.logService,
		}, _agentId, toolCall, signal);
	}


	// ─── 公共注册接口（委托 ToolRegistry）────────────────────────────

	register(descriptor: IBuiltinToolRegistration) {
		return this._registry.register(descriptor);
	}

	// ─── Knowledge tools (llm-wiki 知识内核：kb_search) ───────────────────

	// ─── Phase 1: 内置 Embedding Provider（激活 RAG 引擎）──────────────────

	/**
	 * 注册内置 BYOK embedding provider，使 `isEnabled()` 返回 true
	 * 并解除 `createEmbedder()` 的硬错误。该 provider 复用用户已配置的
	 * OpenAI-compatible API（OpenRouter / 自定义）的 `/v1/embeddings` 端点。
	 */
	private _knowledgeStorage?: IKnowledgeStorageRegistrar;

	private _getKnowledgeStorage(): IKnowledgeStorageRegistrar {
		if (!this._knowledgeStorage) {
			this._knowledgeStorage = createKnowledgeStorageRegistrar({
				register: reg => this.register(reg),
				addDisposable: d => this._register(d),
				configurationService: this.configurationService,
				fileService: this.fileService,
				embeddingService: this.embeddingService,
				studioService: this.studioService,
				workspaceService: this.workspaceService,
				environmentService: this.environmentService,
				logService: this.logService,
				kernelService: this.kbKernelService,
				kbStoragePathKey: AGENT_STUDIO_KB_STORAGE_PATH,
			});
		}
		return this._knowledgeStorage;
	}

	private _registerEmbeddingProvider(): void {
		this._getKnowledgeStorage().registerEmbeddingProvider();
	}

	private _registerKnowledgeTools(): void {
		this._getKnowledgeStorage().registerKnowledgeTools();
	}


	// ─── 内置工具集 ─────────────────────────────────────────────────────

	private _registerCoreTools(): void {
		const coreControl = registerCoreTools({
			register: reg => this.register(reg),
			logService: this.logService,
			id: this.id,
			resolveAndCheckWorkspacePath: (agentId, p, req) => this._resolveAndCheckWorkspacePath(agentId, p, req),
			fileService: this.fileService,
			searchHelpers: this._searchHelpers,
			checkpointService: this.checkpointService,
			terminalService: this.terminalService,
			workspaceService: this.workspaceService,
		});
		this._corePerTurnReset = coreControl.resetPerTurn;
	}


	private _registerWebTools(): void {
		const ctx: WebToolContext = {
			register: (d) => this.register(d),
			requestService: this.requestService,
			logService: this.logService,
			webContentExtractorService: this.webContentExtractorService,
		};
		registerWebTools(ctx);
	}

	// ─── Memory 召回工具 ─────────────────────────────────────────────

	/**
	 * 注册 Memory 相关工具。
	 *
	 * 设计动机：LLM 在 system prompt 里反复看到 “recall / 召回 / save and recall” 等字眼
	 * （来自 agentmemory-memory 扩展描述、bundledTools 描述、builtinMemoryProvider 提示等），
	 * 经常会幻觉调用一个不存在的 `recall` 工具，导致 toolCallUtils 抛出
	 * `Tool "recall" does not exist` 错误。
	 *
	 * 这里把幻觉变成实际能力：通过 IAgentOSService.getActiveMemoryProvider().searchMemory()
	 * 调用当前活跃的 Memory Provider（统一为 AgentMemoryProviderV2，renderer 代理
	 * → 网关宿主引擎 → KV 存储 + BM25/Vector/Graph 混合召回）。
	 *
	 * 懒查询：在 handler 内部解析 provider，避免构造期循环依赖（builtinToolProvider 自身
	 * 也是 IToolProvider，会被 IAgentOSService 注册）。
	 */

	/**
	 * 注册兼容性工具 — Hermes 命名对齐 + 缺失核心工具。
	 *
	 * 问题：bundledTools.ts 中某些工具名与实际 handler 注册名不一致，
	 * 或 Hermes 核心工具在 Saros 中缺少 handler。这导致 LLM 调用时
	 * 报 "Tool does not exist"。
	 *
	 * 修复策略：
	 * 1. 命名不匹配 → 注册别名 handler（schema 用 Hermes 名，handler 委托给真实实现）
	 * 2. 缺失核心工具 → 实现基础 handler（todo 用 in-memory，patch 用文件读写）
	 * 3. 平台不适用 → 返回友好提示（web_search/web_extract 建议配置 MCP server，process 建议 terminal）
	 */
	private _registerCompatibilityTools(): void {
		const folders = this.workspaceService.getWorkspace().folders;
		const workspaceRoot = folders.length > 0 ? folders[0].uri.fsPath : undefined;
		const ctx: CompatToolContext = {
			register: (d) => this.register(d),
			agentOS: this.agentOS,
			fileService: this.fileService,
			logService: this.logService,
			id: this.id,
			workspaceRoot,
			resolveAndCheckWorkspacePath: (agentId, p, req) => this._resolveAndCheckWorkspacePath(agentId, p, req),
		};
		registerCompatibilityTools(ctx);
	}

	// ─── G12: Unified Memory API (recall/improve/forget) ─────────────

	/**
	 * G12: 注册统一记忆 API 工具 — 对齐 cognee remember/recall/improve/forget
	 */
	private _registerUnifiedMemoryTools(): void {
		const ctx: UnifiedMemoryToolContext = {
			register: (d) => this.register(d),
			agentOS: this.agentOS,
			logService: this.logService,
		};
		registerUnifiedMemoryTools(ctx);
	}

	/**
	 * 基础记忆工具（memory_remember/search/delete/list）。
	 * 必须在 _registerBundledTools 之前注册——否则 bundled 目录中的
	 * memory_remember/memory_list 会被注册为 stub（isStub=true，LLM 不可调用）。
	 */
	private _registerMemoryTools(): void {
		const ctx: MemoryToolContext = {
			register: (d) => this.register(d),
			agentOS: this.agentOS,
			logService: this.logService,
		};
		registerMemoryTools(ctx);
	}

	/**
	 * 高级记忆工具 — 接入引擎已移植但休眠的编排/治理能力：
	 * governance（删除/批量/审计）、team（共享池）、mesh（对等节点）、
	 * sentinel（条件监视）、obsidianExport（导出）、cascade（级联修复）。
	 */
	private _registerAdvancedMemoryTools(): void {
		const ctx: AdvancedMemoryToolContext = {
			register: (d) => this.register(d),
			agentOS: this.agentOS,
			logService: this.logService,
		};
		registerAdvancedMemoryTools(ctx);
	}

	/**
	 * 注册高阶记忆工具：routine（可复用工作流）、crystal（行动链结晶）、facet（多维标签）。
	 * 引擎方法由 AgentMemoryProviderV2 暴露 + 网关转发，此处注册为 LLM 内置工具。
	 */
	private _registerRoutineCrystalFacetTools(): void {
		const ctx: RoutineCrystalFacetToolContext = {
			register: (d) => this.register(d),
			agentOS: this.agentOS,
			logService: this.logService,
		};
		registerRoutineCrystalFacetTools(ctx);
	}

	// ─── Skill 按需读取工具（已抽到 skillTools.ts）───────────────

	private _registerSkillTools(): void {
		const tracker = this._skillUsageTracker;
		const ctx: SkillToolContext = {
			register: (d) => this.register(d),
			skillRegistry: this.skillRegistry,
			skillManagerTool: this._skillManagerTool,
			logService: this.logService,
			environmentService: this.environmentService,
			onSkillRead: (skillId, skillResource) => {
				if (skillResource) {
					tracker.recordRead(skillResource).catch(err =>
						this.logService.warn(`[BuiltinToolProvider] onSkillRead fail: ${err}`)
					);
				}
			},
			onSkillMutated: (_skillName, skillDir) => {
				if (skillDir) {
					tracker.recordPatch(skillDir).catch(err =>
						this.logService.warn(`[BuiltinToolProvider] onSkillMutated fail: ${err}`)
					);
				}
			},
		};
		registerSkillTools(ctx);
	}


	private _registerBundledTools(): void {
		const ctx: BundledToolContext = {
			register: (d) => this.register(d),
			logService: this.logService,
			hasTool: (name) => this._registry.hasTool(name),
		};
		registerBundledTools(ctx);
	}

	/**
	 * 注册委派/子代理相关工具（delegate_task, new_agent）。
	 * 这些工具需要真实的 handler，不能只是 stub。
	 */
	private _registerDelegationTools(): void {
		const ctx: DelegationToolContext = {
			register: (d) => this.register(d),
			id: this.id,
			agentOS: this.agentOS,
			orchestrationService: this.orchestrationService,
			getParentWorktreePath: () => this.getParentWorktreePath(),
			studioService: this.studioService,
			logService: this.logService,
			codebaseGraphService: this.codebaseGraphService,
			workspaceService: this.workspaceService,
		};
		registerDelegationTools(ctx);
	}

	private _registerPlanExploreTool(): void {
		registerPlanExploreTool({
			register: (d) => this.register(d),
			id: this.id,
			agentOS: this.agentOS,
			orchestrationService: this.orchestrationService,
			logService: this.logService,
			getParentWorktreePath: () => this.getParentWorktreePath(),
		});
	}

	private _registerPlanModeTools(): void {
		registerPlanModeTools({
			register: (d) => this.register(d),
			source: 'saros.builtin-tools',
		});
	}

	/**
	 * 注册看板（kanban）核心工具的真实 handler。
	 * 参考 Hermes-Agent 的 kanban 工具语义，落地到本项目的 IAgentTaskBoardService。
	 *
	 * 实现的 9 个工具（Hermes 全集）：
	 *  - kanban_create：创建任务卡（编排者用），默认进入 triage 待规划
	 *  - kanban_complete：标记任务完成（写入 result 摘要）
	 *  - kanban_block：阻塞任务（记录原因），状态 → blocked
	 *  - kanban_unblock：解除阻塞，状态 → todo
	 *  - kanban_show：查看单个任务详情
	 *  - kanban_list：列出当前 workspace 任务（可按状态过滤）
	 *  - kanban_heartbeat：刷新任务活跃时间（updatedAt），避免被诊断判为 stranded/stuck
	 *  - kanban_comment：向任务追加一条结构化评论（写入 description）
	 *  - kanban_link：建立父子依赖（child.dependencies += parent）
	 *
	 * agentId → workspaceId 通过 studioService.getAgent(agentId) 解析。
	 */
	private _registerKanbanTools(): void {
		registerKanbanTools({
			register: (def) => this.register(def),
			studioService: this.studioService,
			taskBoardService: this.taskBoardService,
			orchestrationService: this.orchestrationService,
			swarmService: this.swarmService,
			triageService: this.triageService,
			logService: this.logService,
			playwrightService: this.playwrightService,
			editorService: this.editorService,
			sessionsManagement: this.sessionsManagement,
			agentOS: this.agentOS,
			recipeService: this.recipeService,
		});
	}

	private _registerMindmapTools(): void {
		registerMindmapTools({
			register: (def) => this.register(def),
			logService: this.logService,
		});
	}

	private _registerWorkflowTools(): void {
		registerWorkflowTools({
			register: (def) => this.register(def),
			workflowStorageService: this.workflowStorageService,
			studioService: this.studioService,
			logService: this.logService,
		});
	}

	private _registerCanvasTools(): void {
		registerCanvasTools({
			register: (def) => this.register(def),
			logService: this.logService,
		});
	}


	// ─── Codebase Tools (built-in, no external MCP binary) ─────────────────
	//
	// Extracted to codebaseTools.ts for maintainability.
	// See codebaseTools.ts for the full implementation.
	//
	private _registerCodebaseTools(): void {
		registerCodebaseTools({
			register: (def) => this.register(def),
			codebaseGraphService: this.codebaseGraphService,
			workspaceService: this.workspaceService,
			fileService: this.fileService,
			logService: this.logService,
			adrManager: this._adrManager,
			searchHelpers: this._searchHelpers,
			id: this.id,
			resolveAndCheckWorkspacePath: (agentId, p, req) => this._resolveAndCheckWorkspacePath(agentId, p, req),
			// 2026-08-09：注入 studioService，让搜索/索引根基于当前激活的 agent 工作区
			//（用户在工作区下拉中选定的 sarosis-agents-client），避免 multi-workspace folders
			// 合并把已切换走的工作区如 S1Game/UE5EA 一起带回来。
			studioService: this.studioService,
		});
	}

	// ── Memory helpers ──────────────────────────────────────────
	// ── Memory helpers ──────────────────────────────────────────


	// ── handoff: supervisor 交接工具（Step B, 设计 §3.3）─────────────
	// 该工具由 agentOSService 的 loop 在工具分发阶段拦截（不真正执行），
	// 生成 AgentCommand 路由到下一节点。仅多节点图模式（`request.agentGraph`
	// 节点 ≥ 2）才暴露给模型（由 _getEnabledTools 过滤），单 agent 模式不可见。
	// 实现见 handoffTools.ts（保持与其它 registerXxxTools(ctx) 模块一致）。
	private _registerMermaidTools(): void {
		registerMermaidTools({
			register: d => this.register(d),
			logService: this.logService,
		});
	}

	private _registerHandoffTools(): void {
		registerHandoffTools({
			register: d => this.register(d),
			id: this.id,
		});
	}
}

