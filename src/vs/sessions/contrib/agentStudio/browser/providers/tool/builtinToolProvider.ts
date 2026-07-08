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
 *   utility   : echo, get_current_time, math_eval
 *   filesystem: file_read, file_write, file_list, search_files
 *   shell     : shell_exec (仅 desktop)
 *   web       : http_get, web_search (web_search 需要外部 provider，未配置则降级)
 *
 *   另外，从 Hermes-Agent 迁移了 69 个 bundled tool 定义（schema-only）。
 *   这些工具只有 schema，handler 为存根，返回"未实现"提示。
 *   实际执行需通过 MCP 服务器或后续实现的 Provider。
 */

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IRequestService, asText } from '../../../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IToolProvider, IToolDefinition, IToolCall, IToolResult, IToolResultContent, ToolSecurityLevel, IAgentTurnRequest, IChatStreamDelta } from '../../../common/providers.js';
import { getToolsetForTool } from '../../../common/toolsetConfig.js';
import { BUNDLED_TOOL_DEFINITIONS } from '../../../common/bundled-tools/bundledTools.js';
import { ISkillRegistry } from '../../../common/skills.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ITerminalService } from '../../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IAgentStudioService, ITaskOrchestrationService, IAgentTaskBoardService } from '../../../../../common/agentStudioService.js';
import { ITriageService } from '../../../common/triageService.js';
import { ISwarmService } from '../../../common/swarmService.js';
import { ICheckpointService } from '../../../common/checkpointService.js';
import { IAgentOSService } from '../../../common/agentOS.js';
import { SubAgentType, SubAgentResult, UnifiedSubAgentDispatch } from '../../../common/unifiedSubAgentDispatch.js';
import { IterationBudget } from '../../../common/iterationBudget.js';
import { IWorkflowStorageService } from '../../../common/workflowStorage.js';
import { resolveWorkspacePath } from '../../../common/workspacePathResolver.js';
import { IPathService } from '../../../../../../workbench/services/path/common/pathService.js';
import { SkillManagerTool, SKILL_CREATE_TOOL_SCHEMA, SKILL_CREATE_TOOL_DESCRIPTION } from '../../skillManagerTool.js';
import type { Agent } from '../../../../../common/agentStudioTypes.js';
import { AgentType } from '../../../../../common/agentStudioTypes.js';
import { ICodebaseGraphService } from '../../codebaseGraphService.js';
import { AdrManager } from '../../codebaseGraphAdr.js';
import { registerCodebaseTools } from './codebaseTools.js';
import { registerKanbanTools } from './kanbanTools.js';
import { registerWorkflowTools } from './workflowTools.js';
import { IPlaywrightService } from '../../../../../../platform/browserView/common/playwrightService.js';
import { IEditorService } from '../../../../../../workbench/services/editor/common/editorService.js';
import { ISessionsManagementService } from '../../../../../../sessions/services/sessions/common/sessionsManagement.js';
import { IKanbanRecipeService } from './kanbanRecipeService.js';


type ToolHandlerResult = IToolResultContent[] | { content: IToolResultContent[]; details?: Record<string, unknown> };
type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<ToolHandlerResult>;

/**
 * Kanban 工具中已实现真实 handler 的名字集合。
 * 这些工具由 _registerKanbanTools() 注册，_registerBundledTools() 会跳过它们的 stub。
 */
const KANBAN_TOOLS_WITH_HANDLER = new Set<string>([
	'kanban_create',
	'kanban_complete',
	'kanban_block',
	'kanban_unblock',
	'kanban_show',
	'kanban_list',
	'kanban_heartbeat',
	'kanban_comment',
	'kanban_link',
	'kanban_specify',
	'kanban_decompose',
	'kanban_swarm',
	'web_scrape_to_board',
	'web_recipe_create',
	'web_recipe_list',
	'web_recipe_remove',
]);

/**
 * Workflow 工具中已实现真实 handler 的名字集合。
 * 这些工具由 _registerWorkflowTools() 注册，_registerBundledTools() 会跳过它们的 stub。
 */
const WORKFLOW_TOOLS_WITH_HANDLER = new Set<string>([
	'workflow_list',
	'workflow_get',
	'workflow_get_schema',
	'workflow_apply',
]);


/**
 * Module-level Emitter for AI-driven workflow changes.
 * Extracted to workflowShared.ts to break cyclic dependency with workflowTools.ts.
 */
export { workflowAppliedEmitter } from './workflowShared.js';


// ─── new_agent 工具 — 独立导出函数，便于 TDD 测试 ────────────────────────────

/**
 * 将 agent 名称转换为 URL 友好的 slug 格式。
 *
 * 规则：
 *   - 小写字母、数字、连字符
 *   - 空格/下划线 → 连字符
 *   - 移除其他特殊字符
 *   - 去除首尾连字符
 *   - 最多 40 字符
 *
 * 示例：
 *   "Code Reviewer"   → "code-reviewer"
 *   "My Coding Agent"  → "my-coding-agent"
 *   "UI/UX Designer"   → "uiux-designer"
 *
 * 导出为独立函数以便单元测试。
 */
export function slugifyAgentName(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s_-]/g, '')   // 移除特殊字符
		.replace(/[\s_]+/g, '-')          // 空格/下划线 → 连字符
		.replace(/-+/g, '-')              // 去重连字符
		.replace(/^-|-$/g, '')            // 去首尾连字符
		.slice(0, 40);                    // 限制长度
}

/**
 * handleNewAgentTool — 创建持久化 Agent 定义。
 *
 * 与 delegate_task 的区别：
 *   - delegate_task 创建一次性子代理，执行完即销毁
 *   - new_agent 创建持久化 Agent，保存到 ~/.saros/agents/{id}/，可被后续复用
 *
 * Agent 命名规则：
 *   - 名称自动转为 slug 格式（小写、连字符分隔，如 "Code Reviewer" → "code-reviewer"）
 *   - id 与 slug 名称一致，无随机后缀（确保可读性和可预测性）
 *
 * 导出为独立函数以便单元测试（避免实例化整个 BuiltinToolProvider）。
 *
 * @param args LLM 传入的工具参数
 * @param studioService Agent Studio 服务（提供 createAgent）
 * @returns IToolResultContent[] — JSON 格式的创建结果
 */
export async function handleNewAgentTool(
	args: Record<string, unknown>,
	studioService: Pick<IAgentStudioService, 'createAgent'>,
): Promise<IToolResultContent[]> {
	const rawName = args['name'] as string | undefined;
	const role = args['role'] as string | undefined;
	const description = args['description'] as string | undefined;

	// 1. 验证必填字段
	const missing: string[] = [];
	if (!rawName?.trim()) { missing.push('name'); }
	if (!role?.trim()) { missing.push('role'); }
	if (!description?.trim()) { missing.push('description'); }
	if (missing.length > 0) {
		return [{ type: 'text', text: JSON.stringify({
			success: false,
			error: `Missing required parameter(s): ${missing.join(', ')}`,
		}) }];
	}

	// 2. Slug 化名称并对齐 _generateId 的 slug 逻辑（但去掉随机后缀）
	const slugName = slugifyAgentName(rawName!);
	if (!slugName) {
		return [{ type: 'text', text: JSON.stringify({
			success: false,
			error: `Invalid agent name "${rawName}": slug results in empty string after normalization. Use at least one alphanumeric character.`,
		}) }];
	}

	// 3. 构建 Partial<Agent> — 提供 id 以绕过 _generateId 的随机后缀
	const trimmedRole = role!.trim();
	const trimmedDesc = description!.trim();
	const agentData: Partial<Agent> = {
		id: slugName,
		name: slugName,
		role: trimmedRole,
		description: trimmedDesc,
		source: 'custom',
	};
	// systemPrompt: 用户提供则使用，否则基于 role + description 自动生成
	agentData.systemPrompt = args['systemPrompt']
		? (args['systemPrompt'] as string)
		: `You are a ${trimmedRole}. ${trimmedDesc}`;
	if (args['model']) { agentData.model = args['model'] as string; }
	if (args['tools']) { agentData.tools = args['tools'] as string[]; }
	if (args['skills']) { agentData.skills = args['skills'] as string[]; }
	if (args['category']) { agentData.category = args['category'] as string; }
	if (args['agentType']) {
		agentData.agentType = (args['agentType'] === 'planner')
			? AgentType.Planner
			: AgentType.Worker;
	}

	// 4. 调用 studioService.createAgent
	try {
		const agent = await studioService.createAgent(agentData);
		return [{ type: 'text', text: JSON.stringify({
			success: true,
			id: agent.id,
			name: agent.name,
			role: agent.role,
			description: agent.description,
			agentType: agent.agentType ?? 'worker',
			category: agent.category,
			systemPrompt: agent.systemPrompt || '(auto-generated)',
			message: `Agent "${agent.name}" created successfully. Use delegate_task to assign tasks to it.`,
		}) }];
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return [{ type: 'text', text: JSON.stringify({
			success: false,
			error: `Failed to create agent: ${msg}`,
		}) }];
	}
}

interface IToolDescriptor {
	readonly definition: IToolDefinition;
	readonly handler: ToolHandler;
	/** 返回 false 表示当前环境不支持该工具，listTools 会跳过它。 */
	readonly available?: () => boolean;
	/** 标记为 stub — 只有 schema 定义，没有实际 handler 实现。listTools 会跳过这些工具，防止 LLM 看到后尝试调用导致 "not yet implemented" 错误。 */
	readonly isStub?: boolean;
	/**
	 * 动态描述构建器 — 当需要提供动态工具描述时使用。
	 * 参考 Hermes-Agent 的 _build_top_level_description() 设计。
	 * 如果提供此函数，listTools() 会调用它生成动态 description，
	 * 覆盖 definition.description 的静态值。
	 */
	readonly descriptionBuilder?: (agentId: string) => string;
}

/**
 * 公共注册接口 —— 让其他 contribution（如 SkillRegistry / 扩展）也能往中枢加 tool。
 * 通过 `BuiltinToolProvider.register(descriptor)` 调用。
 */
export interface IBuiltinToolRegistration extends IToolDescriptor { }

export class BuiltinToolProvider extends Disposable implements IToolProvider {

	readonly id: string = 'saros.builtin-tools';
	readonly name: string = 'Sarosis Built-in Tools';

	private readonly _tools = new Map<string, IToolDescriptor>();
	private readonly _disabledTools = new Set<string>();
	private readonly _onDidChangeTools = this._register(new Emitter<void>());
	readonly onDidChangeTools: Event<void> = this._onDidChangeTools.event;

	/** Skill Manager 工具实例 —— 提供 skill_create 能力 */
	private _skillManagerTool!: SkillManagerTool;

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

	/** ADR Manager 实例 —— 提供 manage_adr 能力 */
	private _adrManager!: AdrManager;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IRequestService private readonly requestService: IRequestService,
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
	@IPathService private readonly pathService: IPathService,
	@ICodebaseGraphService private readonly codebaseGraphService: ICodebaseGraphService,
	@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	@IEditorService private readonly editorService: IEditorService,
	@ISessionsManagementService private readonly sessionsManagement: ISessionsManagementService,
	@IKanbanRecipeService private readonly recipeService: IKanbanRecipeService,
	) {
		super();
		this._skillManagerTool = new SkillManagerTool(
			this.fileService,
			this.pathService,
			this.skillRegistry,
			this.logService,
		);
		this._adrManager = new AdrManager(this.fileService);
		this._registerCoreTools();
		this._registerCompatibilityTools();
		this._registerMemoryTools();
		this._registerUnifiedMemoryTools(); // G12: recall/improve/forget
		this._registerSkillTools();
		this._registerBundledTools();
		this._registerDelegationTools();
		this._registerKanbanTools();
		this._registerWorkflowTools();
		this._registerCodebaseTools();
		// _registerMcpBridgeTools() 已废弃 — MCP 工具统一走 tool_search/tool_describe/tool_call
		// 保留方法定义以备审计/兼容老调用
	}

	// ─── MCP Bridge Tools (DEPRECATED) ───────────────────────────────────────
	// 2026-07-03: 统一为单套桥接 tool_search/tool_describe/tool_call（对齐 Hermes-Agent）
	// MCP 工具现在通过 'mcp' toolset 纳入 deferrable 池，
	// LLM 通过统一的 tool_search → tool_describe → tool_call 路径发现和调用。
	// 原 _registerMcpBridgeTools() 方法体已删除，MCP 桥接工具不再注册。

	/**
	 * 检查请求的路径是否在允许的工作区目录内，并将相对路径解析为绝对路径。
	 * 同时检查 VS Code 工作区文件夹和 Sarosis Agent 工作区路径。
	 * Windows 路径大小写不敏感。
	 *
	 * @param agentId 当前 agent 的 ID，用于查找 Sarosis workspace 路径
	 * @param requestedPath 请求的文件/目录路径（支持相对路径，如 "."、"./src"）
	 * @returns 解析后的绝对路径
	 * @throws Error 如果路径不在任何允许的工作区内
	 */
	private async _resolveAndCheckWorkspacePath(agentId: string | undefined, requestedPath: string): Promise<string> {
		// 收集所有允许的根路径
		const allowedRoots: string[] = [];

		// ─── 优先判定：worktree 独占沙箱 ───────────────────────────────
		// 沙箱边界【只】取决于 AgentBinding.worktreePath（per-workspace × agent
		// 的运行时实例状态）。Agent 本身是全局定义，不携带 worktreePath；
		// 同一 agent 在不同 workspace 下可绑定不同 worktree，故必须按
		// (workspaceId × agentId) 查 binding。
		// 这是一条独立逻辑——表示"该 agent 运行时被限制在此 worktree 内"。
		// 切勿 fallback 到 Workspace.worktreePath：后者是【另一条独立逻辑】
		// （用户切换当前工作区的 SCM 视角，由 sourceControl.contribution 处理），
		// 与 agent 沙箱无关，二者不可耦合。
		// 工具执行无 sessionId 上下文，按 Q2 兜底用 getActiveWorkspaceId() 解析
		// 当前运行 workspace。
		let worktreeRoot: string | undefined;
		let activeWsId: string | undefined;
		if (agentId) {
			try {
				activeWsId = this.studioService.getActiveWorkspaceId();
				if (activeWsId) {
					const binding = await this.studioService.getAgentBinding(activeWsId, agentId);
					if (binding?.worktreePath) {
						worktreeRoot = binding.worktreePath.replace(/[\\/]+$/, '');
					}
				}
			} catch (err) {
				this.logService.warn(`[BuiltinTools] Failed to resolve worktree for agent ${agentId}:`, err);
			}
		}

		if (worktreeRoot) {
			// 独占模式：仅允许 worktree 目录
			allowedRoots.push(worktreeRoot);
			this.logService.info(`[BuiltinTools] Agent ${agentId} is worktree-sandboxed to: ${worktreeRoot}`);
		} else {
			// ─── 常规模式：未绑定 worktree，沿用多根工作区 ───────────────
			// 1. VS Code 工作区文件夹
			const vscodeFolders = this.workspaceService.getWorkspace().folders;
			for (const folder of vscodeFolders) {
				allowedRoots.push(folder.uri.fsPath.replace(/[\\/]+$/, ''));
			}

			// 2. Sarosis Agent 工作区路径（agent 是全局，运行 workspace 取自
			//    getActiveWorkspaceId — 已在上面解析为 activeWsId）。
			if (activeWsId) {
				try {
					const workspace = await this.studioService.getWorkspace(activeWsId);
					if (workspace?.path) {
						allowedRoots.push(workspace.path.replace(/[\\/]+$/, ''));
					}
					// 关联代码仓库（多仓库管理）— 全部纳入沙箱允许根
					for (const rf of workspace?.relatedFolders ?? []) {
						if (rf?.path) {
							allowedRoots.push(rf.path.replace(/[\\/]+$/, ''));
						}
					}
				} catch (err) {
					this.logService.warn(`[BuiltinTools] Failed to resolve Sarosis workspace for agent ${agentId}:`, err);
				}
			}
		}

		// 边界校验：用 URI + isEqualOrParent（见 workspacePathResolver.ts），
		// 替代旧的手动 `canonicalize`（一刀切 toLowerCase + startsWith）。
		// 后者在大小写敏感文件系统（Linux）上会把 `/Foo/x` 误判为落在 `/foo`
		// 沙箱内，是一处跨平台越界隐患；新实现按 scheme/平台正确处理大小写、
		// 盘符与正/反斜杠归一化。
		const { resolvedPath, isAllowed, normalizedRoots } = resolveWorkspacePath(requestedPath, allowedRoots);

		if (!isAllowed) {
			const allowedList = normalizedRoots.length > 0
				? normalizedRoots.map(r => `  - ${r}`).join('\n')
				: '  (无 — 请确认已正确配置工作区)';
			if (worktreeRoot) {
				throw new Error(
					`安全沙箱限制：该 Agent 实例已绑定 worktree，仅允许在 worktree 目录内操作。\n` +
					`路径 "${requestedPath}" (解析后: "${resolvedPath}") 超出了 worktree 边界。\n` +
					`当前 worktree 工作区：\n${allowedList}\n` +
					`请在该 worktree 目录内操作。如需访问其它目录，请解除该 Agent 的 worktree 绑定。`
				);
			}
			throw new Error(
				`安全沙箱限制：路径 "${requestedPath}" (解析后: "${resolvedPath}") 不在允许的工作区目录内。\n` +
				`当前允许的工作区目录：\n${allowedList}\n` +
				`请在上述目录内操作，或在 Sarosis 工作区设置中配置正确的路径。`
			);
		}

		return resolvedPath;
	}

	// ─── IToolProvider 实现 ─────────────────────────────────────────────

	async listTools(_agentId: string): Promise<IToolDefinition[]> {
		const out: IToolDefinition[] = [];
		for (const [name, t] of this._tools) {
			// 检查环境可用性
			if (t.available && !t.available()) { continue; }
			// 检查用户是否禁用了该工具
			if (this._disabledTools.has(name)) { continue; }
		// 跳过 stub 工具 — 它们只有 schema 定义，没有实际 handler 实现
		// 暴露 stub 工具给 LLM 会导致 LLM 尝试调用，返回 "not yet implemented" 错误
		if (t.isStub) { continue; }
		// 自动推断 toolset（如果 definition 中未显式设置）
		const toolset = t.definition.toolset ?? getToolsetForTool(name);
		// 如果工具有动态描述构建器，使用它生成动态描述
		if (t.descriptionBuilder) {
			const dynamicDesc = t.descriptionBuilder(_agentId);
			out.push({ ...t.definition, description: dynamicDesc, toolset });
		} else {
			out.push({ ...t.definition, toolset });
		}
	}
	return out;
}

	/**
	 * 获取所有工具定义（包括被禁用的，供 UI 显示）
	 */
	async getAllToolDefinitions(_agentId: string): Promise<IToolDefinition[]> {
		const out: IToolDefinition[] = [];
		let stubCount = 0;
		let unavailableCount = 0;
		for (const [name, t] of this._tools) {
			if (t.available && !t.available()) { unavailableCount++; continue; }
			if (t.isStub) { stubCount++; continue; }
			const toolset = t.definition.toolset ?? getToolsetForTool(name);
			out.push({ ...t.definition, toolset });
		}
		this.logService.info(`[BuiltinTools] getAllToolDefinitions: ${out.length} tools (skipped ${stubCount} stubs, ${unavailableCount} unavailable), total registered=${this._tools.size}`);
		return out;
	}

	/**
	 * 获取工具的启用状态
	 */
	async isToolEnabled(_agentId: string, toolName: string): Promise<boolean> {
		return !this._disabledTools.has(toolName);
	}

	/**
	 * 启用工具
	 */
	async enableTool(_agentId: string, toolName: string): Promise<void> {
		if (this._disabledTools.has(toolName)) {
			this._disabledTools.delete(toolName);
			this._onDidChangeTools.fire();
			this.logService.info(`[BuiltinTools] Enabled tool: ${toolName}`);
		}
	}

	/**
	 * 禁用工具
	 */
	async disableTool(_agentId: string, toolName: string): Promise<void> {
		if (this._tools.has(toolName) && !this._disabledTools.has(toolName)) {
			this._disabledTools.add(toolName);
			this._onDidChangeTools.fire();
			this.logService.info(`[BuiltinTools] Disabled tool: ${toolName}`);
		}
	}

	/**
	 * 获取所有工具的启用状态
	 */
	async getToolsEnabledState(_agentId: string): Promise<Record<string, boolean>> {
		const state: Record<string, boolean> = {};
		for (const name of this._tools.keys()) {
			state[name] = !this._disabledTools.has(name);
		}
		return state;
	}

	/**
	 * 批量设置工具的启用状态
	 */
	async setToolsEnabledState(_agentId: string, state: Record<string, boolean>): Promise<void> {
		let changed = false;
		for (const [name, enabled] of Object.entries(state)) {
			if (!this._tools.has(name)) { continue; }
			const currentlyEnabled = !this._disabledTools.has(name);
			if (enabled && !currentlyEnabled) {
				this._disabledTools.delete(name);
				changed = true;
			} else if (!enabled && currentlyEnabled) {
				this._disabledTools.add(name);
				changed = true;
			}
		}
		if (changed) {
			this._onDidChangeTools.fire();
			this.logService.info(`[BuiltinTools] Batch updated tool enabled state`);
		}
	}

	async executeTool(_agentId: string, toolCall: IToolCall, signal?: AbortSignal): Promise<IToolResult> {
		const t = this._tools.get(toolCall.name);
		if (!t) {
			this.logService.warn(`[BuiltinTools] executeTool: tool "${toolCall.name}" NOT FOUND (callId=${toolCall.id}). Registered tools: ${[...this._tools.keys()].slice(0, 20).join(', ')}${this._tools.size > 20 ? '...' : ''}`);
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [],
				error: `Unknown tool: ${toolCall.name}`,
			};
		}
		if (t.isStub) {
			this.logService.warn(`[BuiltinTools] executeTool: tool "${toolCall.name}" is a STUB — should have been filtered by listTools. Args: ${JSON.stringify(toolCall.arguments).slice(0, 200)}`);
		}
		if (t.available && !t.available()) {
			this.logService.warn(`[BuiltinTools] executeTool: tool "${toolCall.name}" not available in this environment`);
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [],
				error: `Tool not available in this environment: ${toolCall.name}`,
			};
		}
		// 检查 abort signal
		if (signal?.aborted) {
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [],
				error: 'Tool execution was cancelled',
				metadata: { timedOut: true, retryable: true },
			};
		}
		const startTime = Date.now();
		const argKeys = Object.keys(toolCall.arguments ?? {});
		this.logService.info(`[BuiltinTools] executeTool: "${toolCall.name}" (callId=${toolCall.id}, args=[${argKeys.join(',')}])`);
		try {
			const raw = await t.handler(toolCall.arguments ?? {}, signal, _agentId);
			const content = Array.isArray(raw) ? raw : raw.content;
			const details = Array.isArray(raw) ? undefined : raw.details;
			const result: IToolResult = {
				toolCallId: toolCall.id,
				success: true,
				content,
				metadata: { executionTimeMs: Date.now() - startTime },
				...(details ? { details } : {}),
			};
			const contentSummary = content.map(c => c.type === 'text' ? (c.text ?? '').slice(0, 100) : `[${c.type}]`).join(' | ');
			this.logService.info(`[BuiltinTools] executeTool: "${toolCall.name}" OK (${Date.now() - startTime}ms) → ${contentSummary}`);
			return result;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[BuiltinTools] executeTool: "${toolCall.name}" FAILED (${Date.now() - startTime}ms): ${msg}`);
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [],
				error: msg,
				metadata: { executionTimeMs: Date.now() - startTime, retryable: true },
			};
		}
	}


	// ─── 公共注册接口 ───────────────────────────────────────────────────

	register(descriptor: IBuiltinToolRegistration): IDisposable {
		const name = descriptor.definition.name;
		if (this._tools.has(name)) {
			this.logService.warn(`[BuiltinTools] overwriting existing tool: ${name}`);
		}
		this._tools.set(name, descriptor);
		this._onDidChangeTools.fire();
		return toDisposable(() => {
			if (this._tools.get(name) === descriptor) {
				this._tools.delete(name);
				this._onDidChangeTools.fire();
			}
		});
	}

	// ─── 内置工具集 ─────────────────────────────────────────────────────

	private _registerCoreTools(): void {
		this.logService.info('[BuiltinTools] _registerCoreTools: starting to register core tools');
		const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

		// ── clarify: 向用户提问 ─────────────────────────────────────────
		// 参考 Hermes-Agent tools/clarify_tool.py。
		// 工具返回结构化 JSON，UI 端 nativeChatEditorPane 的 onClarifySubmit 回调
		// 将用户选择作为新消息发送给 LLM（fire-and-forget 模式）。
		this.register({
			definition: {
				name: 'clarify',
				description: [
					'Ask the user a clarifying question with optional multiple-choice options.',
					'Use this when requirements are ambiguous and you need user input to proceed.',
					'The question is presented to the user; their response will arrive as a new message.',
				].join(' '),
				inputSchema: {
					type: 'object',
					properties: {
						question: { type: 'string', description: 'The question to ask the user' },
						options: {
							type: 'array',
							items: { type: 'string' },
							description: 'Multiple-choice options (1-4 items). Omit for open-ended questions.',
							maxItems: 4,
						},
					},
					required: ['question'],
				},
				category: 'clarify',
				source: this.id,
			},
			handler: async args => {
				const question = String(args['question'] ?? '').trim();
				if (!question) {
					return text('Error: question parameter is required');
				}
				const options = Array.isArray(args['options']) ? (args['options'] as unknown[]).map(String) : undefined;
				// 返回结构化内容 — webview 端检测 clarify 卡片并渲染交互 UI
				return [{
					type: 'text' as const,
					text: JSON.stringify({ __clarify__: true, question, options }),
				}];
			},
		});

		// ── utility ─────────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'echo',
				description: 'Echo back the input text. Mostly used to verify tool plumbing.',
				inputSchema: {
					type: 'object',
					properties: { text: { type: 'string', description: 'Text to echo' } },
					required: ['text'],
				},
				category: 'utility',
				source: this.id,
			},
			handler: async args => text(String(args['text'] ?? '')),
		});

		this.register({
			definition: {
				name: 'get_current_time',
				description: 'Return the current date/time. Optionally formatted in UTC.',
				inputSchema: {
					type: 'object',
					properties: { utc: { type: 'boolean', description: 'Use UTC formatting' } },
				},
				category: 'utility',
				source: this.id,
			},
			handler: async args => {
				const now = new Date();
				return text(args['utc'] ? now.toISOString() : now.toLocaleString());
			},
		});

		this.register({
			definition: {
				name: 'math_eval',
				description: 'Evaluate a simple arithmetic expression. Only +,-,*,/,(),. and digits are allowed.',
				inputSchema: {
					type: 'object',
					properties: { expr: { type: 'string', description: 'Arithmetic expression' } },
					required: ['expr'],
				},
				category: 'utility',
				source: this.id,
			},
			handler: async args => {
				const expr = String(args['expr'] ?? '');
				if (!/^[\d+\-*/().\s]+$/.test(expr)) {
					throw new Error('expression contains forbidden characters');
				}
				// eslint-disable-next-line no-new-func
				const fn = new Function(`"use strict"; return (${expr});`);
				return text(String(fn()));
			},
		});

		// ── clarify（用户交互：LLM 需要用户澄清意图）──
		this.register({
			definition: {
				name: 'clarify',
				description: 'Ask the user to clarify their intent when the LLM is uncertain or needs to choose between options. ' +
					'The question is displayed to the user as an interactive card with selectable options. ' +
					'The options parameter should be a JSON array of strings. ' +
					'Use this when: (1) requirements are ambiguous, (2) multiple valid approaches exist, ' +
					'or (3) the user needs to choose between workflow/configuration options. ' +
					'Example: clarify({question: "Which approach?", options: ["Approach A", "Approach B"]})',
				inputSchema: {
					type: 'object',
					properties: {
						question: { type: 'string', description: 'The question to ask the user.' },
						options: { type: 'string', description: 'JSON array of option strings, e.g. ["Option A", "Option B"].' },
					},
					required: ['question', 'options'],
				},
				category: 'utility',
				source: this.id,
			},
			handler: async args => {
				const question = args['question'] as string | undefined;
				const optionsRaw = args['options'] as string | undefined;
				if (!question || !optionsRaw) {
					throw new Error('clarify: "question" and "options" are required');
				}
				let options: string[] = [];
				try {
					options = JSON.parse(optionsRaw);
				} catch {
					throw new Error('clarify: "options" must be a valid JSON array of strings');
				}
				const preview = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
				return text(`Waiting for user to choose from:\n${preview}\n\n(The user will see an interactive card and their selection will be sent as a new message.)`);
			},
		});

		// ── filesystem ─────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'file_read',
				description: 'Read a UTF-8 text file. Returns the full file content (max 256 KiB).',
				inputSchema: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Absolute path or workspace-relative path' },
					},
					required: ['path'],
				},
				category: 'filesystem',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const requestedPath = String(args['path'] || '');
				if (!requestedPath) {
					throw new Error('path is required');
				}

				// 路径遍历保护：检查请求的路径是否在工作区目录内，并将相对路径解析为绝对路径
				const resolvedPath = await this._resolveAndCheckWorkspacePath(agentId, requestedPath);

				const normalizedUri = URI.file(resolvedPath);
				const buf = await this.fileService.readFile(normalizedUri);
				if (buf.value.byteLength > 256 * 1024) {
					throw new Error(`file too large (${buf.value.byteLength} bytes), use a streaming tool`);
				}
				return text(buf.value.toString());
			},
		});

		this.register({
			definition: {
				name: 'file_write',
				description: 'Write a UTF-8 text file (overwrites). Creates parent directories as needed.',
				inputSchema: {
					type: 'object',
					properties: {
						path: { type: 'string' },
						content: { type: 'string' },
					},
					required: ['path', 'content'],
				},
				category: 'filesystem',
				source: this.id,
				securityLevel: ToolSecurityLevel.Dangerous,
			},
			handler: async (args, _signal, agentId) => {
				const requestedPath = String(args['path'] || '');
				if (!requestedPath) {
					throw new Error('path is required');
				}

				// 路径遍历保护：检查请求的路径是否在工作区目录内，并将相对路径解析为绝对路径
				const resolvedPath = await this._resolveAndCheckWorkspacePath(agentId, requestedPath);

				const normalizedUri = URI.file(resolvedPath);
				const content = String(args['content'] ?? '');
				// Checkpoint (Void-inspired): snapshot the file's current content
				// BEFORE overwriting, so the user can time-travel back to this state.
				// Pass the new content so the checkpoint can compute +N/-N diff stats.
				if (agentId) {
					await this.checkpointService.captureBeforeToolEdit(agentId, normalizedUri.toString(), content);
				}
				await this.fileService.writeFile(normalizedUri, VSBuffer.fromString(content));
				return text(`wrote ${content.length} chars to ${normalizedUri.fsPath}`);
			},
		});

		this.register({
			definition: {
				name: 'file_list',
				description: 'List entries in a directory. Returns an array of { name, type, size }.',
				inputSchema: {
					type: 'object',
					properties: { path: { type: 'string' } },
					required: ['path'],
				},
				category: 'filesystem',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const requestedPath = String(args['path'] || '');
				if (!requestedPath) {
					throw new Error('path is required');
				}

				// 路径遍历保护：检查请求的路径是否在工作区目录内，并将相对路径解析为绝对路径
				const resolvedPath = await this._resolveAndCheckWorkspacePath(agentId, requestedPath);

				const normalizedUri = URI.file(resolvedPath);
				const stat = await this.fileService.resolve(normalizedUri);
				const rows = (stat.children ?? []).map(c => ({
					name: c.name,
					type: c.isDirectory ? 'dir' : 'file',
					size: typeof c.size === 'number' ? c.size : 0,
				}));
				return [{ type: 'text', text: JSON.stringify(rows, null, 2) }];
			},
		});

		this.register({
			definition: {
				name: 'search_files',
				description: 'Recursively grep a directory for a literal substring. Returns matching path:line snippets.',
				inputSchema: {
					type: 'object',
					properties: {
						path: { type: 'string' },
						query: { type: 'string' },
						maxResults: { type: 'number', description: 'Default 50' },
					},
					required: ['path', 'query'],
				},
				category: 'filesystem',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const requestedPath = String(args['path'] || '');
				if (!requestedPath) {
					throw new Error('path is required');
				}

				// 路径遍历保护：检查请求的路径是否在工作区目录内，并将相对路径解析为绝对路径
				const resolvedPath = await this._resolveAndCheckWorkspacePath(agentId, requestedPath);

				const normalizedUri = URI.file(resolvedPath);
				const query = String(args['query'] ?? '');
				const limit = Math.min(Math.max(Number(args['maxResults'] ?? 50), 1), 500);
				if (!query) { throw new Error('query is required'); }
				const hits: string[] = [];
				await this._walkAndGrep(normalizedUri, query, hits, limit, _signal);
				return [{ type: 'text', text: hits.join('\n') || '(no matches)' }];
			},
		});

		// ── terminal ────────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'terminal',
				description: 'Execute a shell command and return the output. Works on desktop only. Returns stdout, stderr, and exit code.',
				inputSchema: {
					type: 'object',
					properties: {
						command: { type: 'string', description: 'Shell command to execute' },
						cwd: { type: 'string', description: 'Working directory (defaults to workspace root)' },
						timeout: { type: 'number', description: 'Command timeout in seconds (default: 30)' },
					},
					required: ['command'],
				},
				category: 'terminal',
				source: this.id,
				securityLevel: ToolSecurityLevel.Dangerous,
			},
			available: () => typeof process !== 'undefined' || typeof navigator !== 'undefined',
			handler: async (args, signal, agentId) => {
				const command = String(args['command'] ?? '').trim();
				if (!command) { throw new Error('command is required'); }
				// cwd 必须落在 agent 的允许工作区内：传了就校验越界，没传则解析为有效根
				// （绑定 worktree 的 agent 即 worktree 根，否则为工作区根）。
				const requestedCwd = args['cwd'] ? String(args['cwd']) : '.';
				const resolvedCwd = await this._resolveAndCheckWorkspacePath(agentId, requestedCwd);
				const timeoutSec = Math.min(Math.max(Number(args['timeout'] ?? 30), 1), 300);

				return this._executeTerminalCommand(command, resolvedCwd, timeoutSec, signal);
			},
		});

		// ── web ────────────────────────────────────────────────────────
		this.register({
			definition: {
				name: 'http_get',
				description: 'HTTP GET request. Returns response body as text (max 1 MiB).',
				inputSchema: {
					type: 'object',
					properties: {
						url: { type: 'string' },
						headers: { type: 'object', additionalProperties: { type: 'string' } },
					},
					required: ['url'],
				},
				category: 'web',
				source: this.id,
				securityLevel: ToolSecurityLevel.Cautious,
			},
			handler: async args => {
				const url = String(args['url'] ?? '');
				if (!/^https?:\/\//i.test(url)) {
					throw new Error('url must start with http:// or https://');
				}
				const headers = (args['headers'] as Record<string, string> | undefined) ?? {};
				const ctx = await this.requestService.request({ type: 'GET', url, headers, callSite: 'saros.builtinTool.http_get' }, CancellationToken.None);
				const body = (await asText(ctx)) ?? '';
				if (body.length > 1024 * 1024) {
					throw new Error('response body exceeded 1 MiB');
				}
				return text(`HTTP ${ctx.res.statusCode}\n\n${body.slice(0, 1024 * 1024)}`);
			},
		});
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
	 * 调用当前活跃的 Memory Provider（默认 builtinMemoryProvider；接入 AgentMemory 后是
	 * AgentMemoryProvider，会走 vendor /search/memories）。
	 *
	 * 懒查询：在 handler 内部解析 provider，避免构造期循环依赖（builtinToolProvider 自身
	 * 也是 IToolProvider，会被 IAgentOSService 注册）。
	 */

	/** 记忆去重相似度阈值（Jaccard 相似度 ≥ 此值视为重复） */
	private static readonly MEMORY_DUPLICATE_THRESHOLD = 0.85;

	/**
	 * 计算两段文本的相似度（基于字符 3-gram 的 Jaccard 相似度）。
	 * 返回值范围 [0, 1]，1 表示完全相同。
	 *
	 * 选择 Jaccard + 字符 n-gram 的原因：
	 *   - 实现简单，无外部依赖；
	 *   - 对短文本（记忆条目通常 < 500 字）效果较好；
	 *   - 对拼写错误、词序变化有一定鲁棒性。
	 */
	private _computeTextSimilarity(text1: string, text2: string): number {
		const s1 = text1.toLowerCase().trim();
		const s2 = text2.toLowerCase().trim();
		if (s1 === s2) { return 1.0; }
		if (Math.abs(s1.length - s2.length) > Math.max(s1.length, s2.length) * 0.3) {
			// 长度差异超过 30% 大概率不相似，快速返回 0 以节省计算
			return 0.0;
		}

		const n = 3; // character n-gram size
		const getNgrams = (s: string): Set<string> => {
			if (s.length < n) { return new Set([s]); }
			const grams = new Set<string>();
			for (let i = 0; i <= s.length - n; i++) {
				grams.add(s.slice(i, i + n));
			}
			return grams;
		};

		const g1 = getNgrams(s1);
		const g2 = getNgrams(s2);
		const intersection = new Set([...g1].filter(g => g2.has(g)));
		const union = new Set([...g1, ...g2]);
		if (union.size === 0) { return 1.0; }
		return intersection.size / union.size;
	}

	/**
	 * 检查新记忆内容是否与已有记忆重复。
	 * 返回重复记忆的 id；若无重复返回 null。
	 */
	private _findDuplicateMemory(entries: Array<{ id: string; content: string; [key: string]: unknown }>, newContent: string): string | null {
		for (const entry of entries) {
			const sim = this._computeTextSimilarity(entry.content, newContent);
			if (sim >= BuiltinToolProvider.MEMORY_DUPLICATE_THRESHOLD) {
				return entry.id;
			}
		}
		return null;
	}

	/**
	 * 注册兼容性工具 — Hermes 命名对齐 + 缺失核心工具。
	 *
	 * 问题：bundledTools.ts 中某些工具名与实际 handler 注册名不一致，
	 * 或 Hermes 核心工具在 Sarosis 中缺少 handler。这导致 LLM 调用时
	 * 报 "Tool does not exist"。
	 *
	 * 修复策略：
	 * 1. 命名不匹配 → 注册别名 handler（schema 用 Hermes 名，handler 委托给真实实现）
	 * 2. 缺失核心工具 → 实现基础 handler（todo 用 in-memory，patch 用文件读写）
	 * 3. 平台不适用 → 返回友好提示（web_search 建议 http_get，process 建议 terminal）
	 */
	private _registerCompatibilityTools(): void {
		const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

		// skills_list 和 skill_view 已在 _registerSkillTools 中注册（含 Hermes 兼容格式）

		// ── 别名: memory → memory_remember (Hermes 旧名) ───────────
		const memStore = new Map<string, string>();
		this.register({
			definition: {
				name: 'memory',
				description: 'Save or recall persistent memory. Action "save" stores content; "recall" retrieves by key.',
				inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['save', 'recall', 'search', 'clear'], description: 'Action to perform' }, key: { type: 'string' }, content: { type: 'string' }, query: { type: 'string' } }, required: ['action'] },
				category: 'memory', source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const action = String(args['action'] ?? 'save');
				if (action === 'save') {
					const content = String(args['content'] ?? '');
					const key = String(args['key'] ?? 'default');
					if (!content) { return text('Error: content is required for save action'); }
					const provider = this.agentOS?.getActiveMemoryProvider?.();
					if (provider) {
						try {
							await provider.writeMemory(agentId ?? '', { id: `mem_${key}`, type: 'episodic', content, timestamp: Date.now() });
							return text(`Memory saved under key "${key}" (${content.length} chars).`);
						} catch { /* fallback */ }
					}
					memStore.set(key, content);
					return text(`Memory saved under key "${key}" (local only, ${content.length} chars).`);
				}
				if (action === 'search' || action === 'recall') {
					const query = String(args['query'] ?? args['key'] ?? '');
					if (!query) { return text('Error: query is required for search/recall action'); }
					const provider = this.agentOS?.getActiveMemoryProvider?.();
					if (provider) {
						try {
							const results = await provider.searchMemory(agentId ?? '', query);
							if (results.length) { return text(results.map(r => `- [${r.type}] ${r.content}`).join('\n')); }
						} catch { /* fallback */ }
					}
					// local fallback
					const found = memStore.get(query);
					return found ? text(`Found: ${found}`) : text('No memories found.');
				}
				return text(`Unknown action: ${action}`);
			},
		});

	// ── update_plan: LLM 自主规划（对齐 OpenClaw update_plan）─────────
	// 极简模型：LLM 传入完整步骤列表（替换语义），系统仅校验约束。
	// 步骤状态：pending | in_progress | completed
	// 约束：最多一个 in_progress（对齐 OpenClaw PLAN_STEP_STATUSES）
	// 2026-07-04: 替代旧的 todo 工具（CRUD 式 task list），
	// 对齐 OpenClaw 的交织式规划：update_plan → 执行工具 → update_plan（更新状态）
	this.register({
		definition: {
			name: 'update_plan',
			displaySummary: 'Track short work plan.',
			replaySafe: true,
			description: 'Update current run plan. ' +
				'Use for non-trivial multi-step work; keep plan current while executing. ' +
				'Short steps; max one in_progress; skip for simple one-step work.',
			inputSchema: {
				type: 'object',
				properties: {
					plan: {
						type: 'array',
						description: 'Ordered list of steps (replaces previous plan).',
						minItems: 1,
						items: {
							type: 'object',
							properties: {
								step: { type: 'string', description: 'Short step description.' },
								status: {
									type: 'string',
									enum: ['pending', 'in_progress', 'completed'],
									description: 'pending | in_progress | completed.',
								},
							},
							required: ['step', 'status'],
							additionalProperties: true,
						},
					},
					explanation: {
						type: 'string',
						description: 'Optional short note explaining what changed.',
					},
				},
				required: ['plan'],
			},
			category: 'todo', source: this.id,
		},
		handler: async (args) => {
			const plan = args['plan'];
			if (!Array.isArray(plan) || plan.length === 0) {
				return text('update_plan error: "plan" must be a non-empty array of steps');
			}
			// 校验约束：最多一个 in_progress（对齐 OpenClaw）
			const inProgressCount = plan.filter(
				(s: any) => s?.status === 'in_progress'
			).length;
			if (inProgressCount > 1) {
				return text(`update_plan error: at most one step may be in_progress (found ${inProgressCount})`);
			}
			// 校验每个步骤
			for (const s of plan) {
				if (!s || typeof s.step !== 'string' || !s.step.trim()) {
					return text('update_plan error: each step must have a non-empty "step" string');
				}
				if (!['pending', 'in_progress', 'completed'].includes(s.status)) {
					return text(`update_plan error: invalid status "${s.status}" for step "${s.step}"`);
				}
			}
			const explanation = args['explanation'] as string | undefined;
			// 对齐 OpenClaw: content: [] — LLM 不重复看到计划文本
			// details 供 UI 渲染结构化计划卡片（进度条 + 步骤状态）
			return {
				content: [] as IToolResultContent[],
				details: {
					status: 'updated' as const,
					plan: plan as Array<{ step: string; status: string }>,
					...(explanation ? { explanation } : {}),
				},
			};
		},
	});

		// ── patch: 基础文件补丁 ──────────────────────────────────
		this.register({
			definition: {
				name: 'patch',
				description: 'Apply a patch to a file by searching for text and replacing it. Safer than file_write for targeted edits.',
				inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path to patch' }, search: { type: 'string', description: 'Text to search for' }, replace: { type: 'string', description: 'Replacement text' }, replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' } }, required: ['path', 'search', 'replace'] },
				category: 'file', source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const filePath = String(args['path'] ?? '');
				const search = String(args['search'] ?? '');
				const replace = String(args['replace'] ?? '');
				const replaceAll = Boolean(args['replace_all']);
				if (!filePath || !search) { return text('Error: path and search are required'); }
				try {
					const resolved = await this._resolveAndCheckWorkspacePath(agentId, filePath);
					const fileUri = URI.file(resolved);
					const buf = await this.fileService.readFile(fileUri);
					let content = buf.value.toString();
					if (replaceAll) {
						content = content.split(search).join(replace);
					} else {
						const idx = content.indexOf(search);
						if (idx === -1) { return text(`Search text not found in ${filePath}`); }
						content = content.slice(0, idx) + replace + content.slice(idx + search.length);
					}
					await this.fileService.writeFile(fileUri, VSBuffer.fromString(content));
					return text(`Patched ${filePath} (${replaceAll ? 'all occurrences' : 'first occurrence'})`);
				} catch (e) {
					return text(`Error patching ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
				}
			},
		});

		// ── web_search / web_extract / process / session_search / execute_code ──
		// 平台不适用 — 返回友好提示
		for (const [name, desc, msg] of [
			['web_search', 'Search the web for information.', 'Web search is not natively available. Use http_get for specific URLs or configure an MCP search server.'],
			['web_extract', 'Extract content from a web page.', 'Use http_get to fetch web page content. web_extract is not natively available.'],
			['process', 'Manage background processes.', 'Process management is not available. Use terminal with background=true.'],
			['session_search', 'Search past conversation sessions.', 'Session search is not yet available. Past conversations are stored in ~/.saros/sessions/.'],
			['execute_code', 'Execute a Python script in a sandbox.', 'Code execution sandbox is not available. Use the terminal tool to run scripts.'],
		] as const) {
			this.register({
				definition: { name, description: desc, inputSchema: { type: 'object', properties: {} }, category: 'utility', source: this.id },
				handler: async () => text(msg),
			});
		}

		this.logService.info('[BuiltinTools] _registerCompatibilityTools: registered aliases + missing core tools');
	}

	private _registerMemoryTools(): void {
		const self = this;
		this.register({
			definition: {
				name: 'memory_remember',
				description: 'Save a memory entry (short-term or long-term). Use this to persist important information across sessions. Automatically detects and merges duplicate content (similarity >= 0.85) by updating the existing entry.',
				inputSchema: { type: 'object', properties: {
					content: { type: 'string', description: 'Memory content to save' },
					memory_type: { type: 'string', enum: ['working', 'episodic', 'semantic', 'procedural'], description: 'Memory type (default: episodic)' },
					tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering' },
					importance: { type: 'number', description: 'Importance score 0-10 (default: 5)' },
					slot_id: { type: 'string', description: 'If set, write to a specific memory slot (persona/user_preferences/project_context/tool_guidelines/guidance) instead of creating a memory entry' },
				}, required: ['content'] },
				category: 'memory',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				if (!agentId) { return [{ type: 'text', text: 'memory_remember error: agentId is required' }]; }
				const content = args['content'] as string;
				if (!content) { return [{ type: 'text', text: 'memory_remember error: content is required' }]; }
				const slotId = args['slot_id'] as string | undefined;

				// R2: slot_id 支持 — LLM 可直接编辑记忆槽位（对齐 agentmemory memory_slot_set）
				if (slotId) {
					const validSlots = ['persona', 'user_preferences', 'project_context', 'tool_guidelines', 'guidance', 'pending_items', 'session_patterns', 'self_notes'];
					if (!validSlots.includes(slotId)) {
						return [{ type: 'text', text: `memory_remember error: invalid slot_id "${slotId}". Valid: ${validSlots.join(', ')}` }];
					}
					const memProvider = this.agentOS.getActiveMemoryProvider();
					if (memProvider) {
						try {
							await memProvider.writeMemory(agentId, {
								id: `slot-${slotId}-${Date.now()}`,
								type: 'episodic',
								content,
								timestamp: Date.now(),
								importance: 8,
								metadata: { slot_id: slotId, source: 'llm_slot_edit' },
							});
							return [{ type: 'text', text: `Slot "${slotId}" updated: ${content.slice(0, 100)}` }];
						} catch (err) {
							this.logService.warn('[BuiltinTools] memory_remember slot write failed:', err);
							return [{ type: 'text', text: `Failed to update slot "${slotId}": ${err}` }];
						}
					}
					return [{ type: 'text', text: 'memory_remember error: no memory provider available for slot write' }];
				}
				const memType: 'working' | 'episodic' = (args['memory_type'] as string || 'episodic') === 'working' ? 'working' : 'episodic';
				const tags = Array.isArray(args['tags']) ? args['tags'] as string[] : undefined;
				const importance = typeof args['importance'] === 'number' ? Math.max(0, Math.min(10, args['importance'] as number)) : 5;
				const entry = {
					id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
					type: memType as 'working' | 'episodic' | 'semantic' | 'procedural',
					content,
					timestamp: Date.now(),
					importance,
					metadata: tags ? { tags } : undefined,
				};

				// ── 优先通过 IMemoryProvider 写入（同步到 provider 的索引/向量存储）──
				const memProvider = this.agentOS.getActiveMemoryProvider();
				if (memProvider) {
					try {
						await memProvider.writeMemory(agentId, entry);
						return [{ type: 'text', text: `Memory saved (${memType}, importance=${importance}): ${content.slice(0, 100)}` }];
					} catch (err) {
						this.logService.warn('[BuiltinTools] memory_remember: provider write failed, falling back to local:', err);
					}
				}

				// ── 降级：本地 JSONL 写入 ─────────────────────────────────
				const file = self._getMemFile(agentId, memType === 'working' ? 'short-term.jsonl' : 'long-term.jsonl');
				try { await self.fileService.createFolder(URI.joinPath(file, '..')); } catch {}
				const existing = await self._readJsonl(file);

				// 去重检查：若与新内容相似的记忆已存在，则更新已有记忆而非重复写入
				const dupId = self._findDuplicateMemory(existing, content);
				if (dupId) {
					// 更新已有记忆：刷新时间戳，若新重要性更高则覆盖
					const idx = existing.findIndex((e: any) => e.id === dupId);
					if (idx >= 0) {
						existing[idx].timestamp = Date.now();
						if (importance > (existing[idx].importance ?? 5)) {
							existing[idx].importance = importance;
						}
						if (tags) { existing[idx].metadata = { ...(existing[idx].metadata ?? {}), tags }; }
					}
					if (memType === 'working') { while (existing.length > 200) existing.shift(); }
					await self._writeAtomic(file, existing);
					return [{ type: 'text', text: `Memory updated (duplicate detected, similarity >= ${BuiltinToolProvider.MEMORY_DUPLICATE_THRESHOLD}): ${content.slice(0, 100)}\n[memory_file: ${file.toString()}]` }];
				}

				// 无重复，写入新记忆
				existing.push(entry);
				if (memType === 'working') { while (existing.length > 200) existing.shift(); }
				await self._writeAtomic(file, existing);
				return [{ type: 'text', text: `Memory saved (${memType}, importance=${importance}): ${content.slice(0, 100)}\n[memory_file: ${file.toString()}]` }];
			},
		});

		// ── memory_search ──────────────────────────────────────
		this.register({
			definition: {
				name: 'memory_search',
				description: 'Search memories by keyword, tag, or time range. Returns matching entries sorted by relevance (semantic search when available, falls back to keyword matching).',
				inputSchema: { type: 'object', properties: {
					query: { type: 'string', description: "Search query. Supports prefixes: tag:foo, type:short, type:long, after:YYYY-MM-DD, before:YYYY-MM-DD, recent:7d (or 24h)" },
					limit: { type: 'number', description: 'Max results (default: 10)' },
				}, required: ['query'] },
				category: 'memory',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				if (!agentId) { return [{ type: 'text', text: 'memory_search error: agentId is required' }]; }
				const query = (args['query'] as string) || '';
				const limit = typeof args['limit'] === 'number' ? Math.min(args['limit'] as number, 50) : 10;

				// ── 优先使用 IMemoryProvider（支持语义搜索：BM25 + Vector + Graph 混合搜索）──
				const memProvider = this.agentOS.getActiveMemoryProvider();
				if (memProvider) {
					try {
						const results = await memProvider.searchMemory(agentId, query);
						if (results.length > 0) {
							const slice = results.slice(0, limit);
							const lines = slice.map(e => {
								const score = e.score !== undefined ? ` (score: ${e.score.toFixed(2)})` : '';
								const imp = e.importance !== undefined ? ` [importance: ${e.importance}]` : '';
								const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
								return `- [${e.type}]${imp}${score} ${ts}: ${e.content.slice(0, 200)}`;
							});
							return [{ type: 'text', text: `Found ${slice.length} matching memories (semantic search):\n${lines.join('\n')}` }];
						}
						// Provider returned empty — fall through to local search
					} catch (err) {
						this.logService.warn('[BuiltinTools] memory_search: provider search failed, falling back to local:', err);
					}
				}

				// ── 降级：本地 JSONL 子串匹配 ──────────────────────────────
				let typeFilter: 'working' | 'episodic' | 'semantic' | 'procedural' | undefined;
				let tagFilter: string | undefined;
				const tokens = query.split(/\s+/);
				const remaining: string[] = [];
				for (const tok of tokens) {
					if (tok.startsWith('type:')) {
						const v = tok.slice(5);
						typeFilter = v === 'working' ? 'working' : v === 'episodic' ? 'episodic' : v === 'semantic' ? 'semantic' : v === 'procedural' ? 'procedural' : undefined;
					} else if (tok.startsWith('tag:')) {
						tagFilter = tok.slice(4);
					} else {
						remaining.push(tok);
					}
				}
				const textQuery = remaining.join(' ').trim().toLowerCase();
				const [shortTerm, longTerm] = await Promise.all([
					typeFilter === 'episodic' ? Promise.resolve([] as any[]) : self._readJsonl(self._getMemFile(agentId, 'short-term.jsonl')),
					typeFilter === 'working' ? Promise.resolve([] as any[]) : self._readJsonl(self._getMemFile(agentId, 'long-term.jsonl')),
				]);
				const all = [...shortTerm, ...longTerm];
				const matched = all.filter(e => {
					if (textQuery && !e.content.toLowerCase().includes(textQuery)) { return false; }
					if (tagFilter) {
						const tags = (e.metadata?.['tags'] as string[] | undefined) ?? [];
						if (!Array.isArray(tags) || !tags.includes(tagFilter)) { return false; }
					}
					return true;
				});
				matched.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
				const slice = matched.slice(0, limit);
			if (slice.length === 0) { return [{ type: 'text', text: 'No matching memories found.' }]; }
			const lines = slice.map(e => `- [${e.type}] ${new Date(e.timestamp).toLocaleString()}: ${e.content.slice(0, 200)}`);
			return [{ type: 'text', text: `Found ${slice.length} matching memories:\n${lines.join('\n')}` }];
			},
		});

		// ── memory_delete ──────────────────────────────────────
		this.register({
			definition: {
				name: 'memory_delete',
				description: 'Delete a memory entry by its ID. Use memory_search first to find the entry ID.',
				inputSchema: { type: 'object', properties: {
					id: { type: 'string', description: 'Memory entry ID to delete' },
					memory_type: { type: 'string', enum: ['working', 'episodic', 'semantic', 'procedural'], description: 'Memory type to delete from' },
				}, required: ['id', 'memory_type'] },
				category: 'memory',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				if (!agentId) { return [{ type: 'text', text: 'memory_delete error: agentId is required' }]; }
				const id = args['id'] as string;
				const memType = (args['memory_type'] as string || 'episodic') === 'working' ? 'working' : 'episodic';
				if (!id) { return [{ type: 'text', text: 'memory_delete error: id is required' }]; }
				const file = self._getMemFile(agentId, memType === 'working' ? 'short-term.jsonl' : 'long-term.jsonl');
				const existing = await self._readJsonl(file);
				const before = existing.length;
				const filtered = existing.filter(e => e.id !== id);
			if (filtered.length === before) {
				return [{ type: 'text', text: `Memory entry ${id} not found in ${memType}.\n[memory_file: ${file.toString()}]` }];
			}
			await self._writeAtomic(file, filtered);
			return [{ type: 'text', text: `Deleted memory entry ${id} from ${memType}.\n[memory_file: ${file.toString()}]` }];
			},
		});

		// ── memory_list ────────────────────────────────────────
		this.register({
			definition: {
				name: 'memory_list',
				description: 'List all memory entries of a given type.',
				inputSchema: { type: 'object', properties: {
					memory_type: { type: 'string', enum: ['working', 'episodic', 'semantic', 'procedural'], description: 'Memory type to list (default: episodic)' },
					limit: { type: 'number', description: 'Max entries to return (default: 20)' },
				} },
				category: 'memory',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				if (!agentId) { return [{ type: 'text', text: 'memory_list error: agentId is required' }]; }
				const memType = (args['memory_type'] as string || 'episodic') === 'working' ? 'working' : 'episodic';
				const limit = typeof args['limit'] === 'number' ? Math.min(args['limit'] as number, 50) : 20;
				const file = self._getMemFile(agentId, memType === 'working' ? 'short-term.jsonl' : 'long-term.jsonl');
				const entries = await self._readJsonl(file);
				entries.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
				const slice = entries.slice(0, limit);
			if (slice.length === 0) { return [{ type: 'text', text: `No ${memType} memories found.\n[memory_file: ${file.toString()}]` }]; }
			const lines = slice.map(e => `[${e.id.slice(-8)}] ${new Date(e.timestamp).toLocaleString()}: ${e.content.slice(0, 200)}`);
			return [{ type: 'text', text: `${memType} memories (${slice.length}/${entries.length}):\n${lines.join('\n')}\n[memory_file: ${file.toString()}]` }];
			},
		});

		this.logService.info('[BuiltinTools] _registerMemoryTools: 4 memory tools registered');
	}

	// ─── G12: Unified Memory API (recall/improve/forget) ─────────────

	/**
	 * G12: 注册统一记忆 API 工具 — 对齐 cognee remember/recall/improve/forget
	 */
	private _registerUnifiedMemoryTools(): void {
		const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

		// memory_recall: 语义化检索 (比 memory_search 更智能，支持多策略 + reranker)
		this.register({
			definition: {
				name: 'memory_recall',
				description: 'Recall memories using semantic search with multi-strategy support. More intelligent than memory_search — supports hybrid (BM25+Vector), graph-first, and vector-first strategies with automatic re-ranking.',
				inputSchema: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'What to recall (natural language query)' },
						strategy: { type: 'string', enum: ['hybrid', 'graph_first', 'vector_first', 'graph_only', 'vector_only'], description: 'Search strategy (default: hybrid)' },
						limit: { type: 'number', description: 'Max results (default: 10)' },
					},
					required: ['query'],
				},
				category: 'memory',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				if (!agentId) { return text('memory_recall error: agentId is required'); }
				const query = args['query'] as string;
				if (!query) { return text('memory_recall error: query is required'); }
				const memProvider = this.agentOS.getActiveMemoryProvider();
				if (!memProvider) { return text('memory_recall: no memory provider available'); }
				const strategy = (args['strategy'] as string) ?? 'hybrid';
				const limit = (args['limit'] as number) ?? 10;
				try {
					// G8/G9/G10/G2: 多策略召回 + rerank + GraphRAG + 长结果分块
					const recallFn = (memProvider as any).recallFormatted;
					if (typeof recallFn === 'function') {
						return text(await recallFn.call(memProvider, agentId, query, strategy, limit));
					}
					// 回退：provider 不支持多策略时退回普通 searchMemory
					const results = await memProvider.searchMemory(agentId, query);
					const limited = results.slice(0, limit);
					if (limited.length === 0) { return text('memory_recall: no results found'); }
					const summary = limited.map((r: any, i: number) =>
						`[${i + 1}] ${r.content?.slice(0, 200) ?? ''}`
					).join('\n');
					return text(`Recalled ${limited.length} memories:\n${summary}`);
				} catch (err) {
					return text(`memory_recall failed: ${err}`);
				}
			},
		});

		// memory_improve: 改进/强化已有记忆
		this.register({
			definition: {
				name: 'memory_improve',
				description: 'Improve an existing memory by reinforcing its importance or updating its content. Use this when you encounter information that confirms or enhances a previously saved memory.',
				inputSchema: {
					type: 'object',
					properties: {
						memory_id: { type: 'string', description: 'ID of the memory to improve' },
						action: { type: 'string', enum: ['reinforce', 'update', 'merge'], description: 'reinforce=boost importance, update=replace content, merge=append content' },
						new_content: { type: 'string', description: 'New or additional content (for update/merge actions)' },
					},
					required: ['memory_id', 'action'],
				},
				category: 'memory',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				if (!agentId) { return text('memory_improve error: agentId is required'); }
				const memId = args['memory_id'] as string;
				const action = args['action'] as string;
				const newContent = args['new_content'] as string | undefined;
				const memProvider = this.agentOS.getActiveMemoryProvider();
				if (!memProvider) { return text('memory_improve: no memory provider available'); }

				// reinforce: 通过 writeMemory 重新写入相同内容 (触发 accessCount++)
				// update/merge: 写入新内容
				try {
					if (action === 'reinforce') {
						// 强化 = 提升重要性/访问度（不再覆盖原内容）
						const fn = (memProvider as any).reinforceMemory;
						if (typeof fn === 'function') {
							const ok = await fn.call(memProvider, agentId, memId);
							return ok ? text(`Memory ${memId} reinforced.`) : text(`memory_improve: memory ${memId} not found`);
						}
						// 回退（旧行为，可能覆盖原内容）
						await memProvider.writeMemory(agentId, {
							id: memId,
							type: 'episodic',
							content: '(reinforced)',
							metadata: { reinforced: true, source: 'memory_improve' },
						});
						return text(`Memory ${memId} reinforced.`);
					}
					if ((action === 'update' || action === 'merge') && newContent) {
						await memProvider.writeMemory(agentId, {
							id: `${memId}-${action}-${Date.now()}`,
							type: 'episodic',
							content: newContent,
							metadata: { improves: memId, action, source: 'memory_improve' },
						});
						return text(`Memory ${memId} ${action}d with new content.`);
					}
					return text(`memory_improve: unknown action "${action}"`);
				} catch (err) {
					return text(`memory_improve failed: ${err}`);
				}
			},
		});

		// memory_forget: 删除记忆 (软删除)
		this.register({
			definition: {
				name: 'memory_forget',
				description: 'Forget (soft-delete) a memory entry. The memory is marked as deleted but not physically removed, preserving audit history.',
				inputSchema: {
					type: 'object',
					properties: {
						memory_id: { type: 'string', description: 'ID of the memory to forget' },
						reason: { type: 'string', description: 'Optional reason for forgetting' },
					},
					required: ['memory_id'],
				},
				category: 'memory',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				if (!agentId) { return text('memory_forget error: agentId is required'); }
				const memId = args['memory_id'] as string;
				const reason = args['reason'] as string | undefined;
				const memProvider = this.agentOS.getActiveMemoryProvider();
				if (!memProvider) { return text('memory_forget: no memory provider available'); }
				try {
					// 软删除：标记原记忆为 superseded（不再被召回）
					const fn = (memProvider as any).forgetMemory;
					if (typeof fn === 'function') {
						const ok = await fn.call(memProvider, agentId, memId, reason);
						return ok
							? text(`Memory ${memId} has been forgotten.${reason ? ` Reason: ${reason}` : ''}`)
							: text(`memory_forget: memory ${memId} not found`);
					}
					// 回退（旧行为：仅写 forget 标记，原记忆仍可被召回）
					await memProvider.writeMemory(agentId, {
						id: `forget-${memId}-${Date.now()}`,
						type: 'episodic',
						content: `(forgotten: ${memId})`,
						metadata: { forgets: memId, reason: reason ?? 'user_request', source: 'memory_forget' },
					});
					return text(`Memory ${memId} has been forgotten.${reason ? ` Reason: ${reason}` : ''}`);
				} catch (err) {
					return text(`memory_forget failed: ${err}`);
				}
			},
		});
	}

	// ─── Skill 按需读取工具 ───────────────────────────────────────

	/**
	 * 注册 Skill 相关工具 —— 借鉴 OpenClaw 的按需加载模式。
	 * 模型在 systemPrompt 中看到轻量目录后，通过这些工具按需读取完整内容。
	 */
	private _registerSkillTools(): void {
		const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];
		const MAX_SKILL_BYTES = 256_000; // 单个 skill 内容上限 256KB

		this.register({
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
				source: this.id,
			},
			handler: async args => {
				const skillId = String(args['skill_id'] ?? '').trim();
				if (!skillId) {
					throw new Error('skill_id is required');
				}

				const skill = this.skillRegistry.getSkill(skillId);
				if (!skill) {
					// 尝试模糊匹配（按 name）
					const allSkills = this.skillRegistry.getSkills();
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
		this.register({
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
				source: this.id,
			},
			handler: async (args) => {
				const name = String(args['name'] ?? '').trim();
				if (!name) { return text(JSON.stringify({ success: false, error: 'name is required' })); }
				const skills = this.skillRegistry?.getSkills() ?? [];
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

		this.register({
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
				source: this.id,
			},
			handler: async args => {
				const filter = String(args['filter'] ?? '').toLowerCase().trim();
				const category = String(args['category'] ?? '').toLowerCase().trim();

				let skills = [...this.skillRegistry.getSkills()].filter(s => s.enabled !== false);

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
		this.register({
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
				source: this.id,
			},
			handler: async (args) => {
				const category = String(args['category'] ?? '').toLowerCase().trim();
				let skills = [...this.skillRegistry.getSkills()].filter(s => s.enabled !== false);
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
		this.register({
			definition: {
				name: 'skill_create',
				description: SKILL_CREATE_TOOL_DESCRIPTION,
				inputSchema: SKILL_CREATE_TOOL_SCHEMA as Record<string, unknown>,
				category: 'skills',
				source: this.id,
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

				const result = await this._skillManagerTool.createSkill({ name, content, category });
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

		this.logService.info('[BuiltinTools] _registerSkillTools: read_skill, list_skills, and skill_create registered');

		// ── skill_manage: 对齐 Hermes skill_manager_tool.py ──────────────────
		// Hermes 支持 6 种 action：create / edit / patch / delete / write_file / remove_file
		// Sarosis 当前支持 create/edit（委托 skill_create），patch/delete 返回友好提示
		this.register({
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
				source: this.id,
			},
			handler: async (args: Record<string, unknown>): Promise<IToolResultContent[]> => {
				const action = String(args['action'] ?? 'create');
				const name = String(args['name'] ?? '').trim();
				const content = String(args['content'] ?? '');
				const category = args['category'] ? String(args['category']).trim() || undefined : undefined;

				if (!name) { return text('Error: name is required'); }

				if (action === 'create' || action === 'edit') {
					if (!content) { return text('Error: content is required for create/edit. Provide the full SKILL.md text (frontmatter + body).'); }
					const result = await this._skillManagerTool.createSkill({ name, content, category });
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
						const skills = this.skillRegistry?.getSkills() ?? [];
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
		});
	}

	/**
	 * 执行终端命令并收集输出。
	 * 创建一个临时终端实例，发送命令，收集输出，然后销毁终端。
	 */
	private async _executeTerminalCommand(
		command: string,
		cwd: string | undefined,
		timeoutSec: number,
		signal?: AbortSignal,
	): Promise<IToolResultContent[]> {
		// 如果已被取消，直接返回
		if (signal?.aborted) {
			return [{ type: 'text', text: 'Command execution was cancelled before it started.' }];
		}

		try {
			// 工作目录：调用方已通过 _resolveAndCheckWorkspacePath 校验为允许根内的绝对路径。
			// 仅在异常缺失时回退到 VS Code 工作区文件夹（不应发生）。
			const workspaceFolders = this.workspaceService.getWorkspace().folders;
			const effectiveCwd = cwd ?? (workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined);

			// 创建临时终端实例
			const instance = await this.terminalService.createTerminal({
				config: {
					type: 'Task',
					name: `Agent: ${command.slice(0, 40)}`,
					cwd: effectiveCwd,
					isFeatureTerminal: true,
					hideFromUser: false,
				},
			});

			if (!instance) {
				return [{ type: 'text', text: `Error: Failed to create terminal instance for command execution.` }];
			}

			// 收集输出数据
			const outputChunks: string[] = [];
			let dataListener: IDisposable | undefined;
			let exitListener: IDisposable | undefined;

			const IDLE_TIMEOUT_MS = 1500; // 1.5s 无新输出视为命令完成

			const outputPromise = new Promise<string>((resolve) => {
				let idleTimer: ReturnType<typeof setTimeout>;

				const markIdle = () => {
					clearTimeout(idleTimer);
					idleTimer = setTimeout(() => resolve(''), IDLE_TIMEOUT_MS);
				};

				// 监听数据输出
				dataListener = instance.onData((data: string) => {
					// 去除 ANSI 转义序列和终端垃圾信息
					const clean = data
						// ANSI SGR (颜色、样式)
						.replace(/\x1b\[[0-9;:?]*[a-zA-Z]/g, '')
						// ANSI OSC (窗口标题等)
						.replace(/\x1b\][^\x07]*\x07/g, '')
						.replace(/\x1b\][^\x1b]*\x1b\\/g, '')
						// 其他控制字符
						.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
						.replace(/\r\n/g, '\n')
						.replace(/\r/g, '\n');
					outputChunks.push(clean);
					markIdle();
				});

				// 监听退出（非交互式 shell 可能触发）
				exitListener = instance.onExit((e) => {
					clearTimeout(idleTimer);
					const code = typeof e === 'number' ? e : (e as any).exitCode;
					resolve(`Exit code: ${code}\n`);
				});

				// 初始 idle 计时器（处理无输出命令）
				idleTimer = setTimeout(() => resolve(''), IDLE_TIMEOUT_MS);
			});

			// v27: hard cap timeout at 60s regardless of user input. Reasons:
			// 1. Long-running interactive commands (REPL, watch, tail -f) can
			//    keep onData firing and starve the 1.5s idle timer; the user
			//    asked for 300s but the actual hang is unbounded.
			// 2. If the host event loop is saturated (e.g. WorkspaceExplorer
			//    re-render loop flooding the log), setTimeout callbacks can
			//    be delayed for many seconds — `Math.min(maxSec, 60)` ensures
			//    the tool always returns within a reasonable time.
			// 3. Per the user's stuck-terminal bug report, default 30s
			//    wasn't enough because the timeout itself didn't fire while
			//    the event loop was busy. Capping at 60s gives the underlying
			//    Promise.race a tight bound that will fire under load.
			const hardCapMs = 60_000;
			const timeoutMs = Math.min(timeoutSec * 1000, hardCapMs);

			// v27: log the actual command at the start of execution so the
			// log shows what was sent (currently only the tool name is
			// logged, which makes debugging hangs like this one painful —
			// we can't tell from the log whether the agent sent `dir`,
			// `tail -f`, or an interactive command).
			this.logService.info(
				`[BuiltinTools] terminal: command="${command.slice(0, 200)}" cwd=${effectiveCwd ?? '(none)'} ` +
				`timeout=${timeoutSec}s hardCap=${hardCapMs}ms`,
			);

			// v27: defensive `await instance.sendText(command, true)` — if
			// the underlying transport hangs, the abort/timeout promises
			// can't be set up because we never reach `Promise.race`. We
			// race the sendText itself against a 5s cushion past the
			// hard cap to ensure no matter which sub-step hangs, the tool
			// always returns.
			const sendTextTimeoutMs = hardCapMs + 5_000;
			const sendTextTimeout = new Promise<void>((resolve) => {
				setTimeout(() => resolve(), sendTextTimeoutMs);
			});
			await Promise.race([instance.sendText(command, true), sendTextTimeout]);

			// 等待输出或超时
			let result = '';

			const abortPromise = signal
				? new Promise<string>((resolve) => {
					const onAbort = () => resolve('[CANCELLED] Command execution was cancelled by user.\n');
					signal.addEventListener('abort', onAbort, { once: true });
				})
				: new Promise<string>(() => { /* never resolves */ });

			const timeoutPromise = new Promise<string>((resolve) => {
				setTimeout(() => resolve(`[TIMEOUT] Command timed out after ${timeoutMs / 1000}s\n`), timeoutMs);
			});

			result = await Promise.race([outputPromise, timeoutPromise, abortPromise]);

			// 等待一小段时间让剩余数据到达
			await new Promise<void>(resolve => setTimeout(resolve, 300));

			// 清理监听器
			dataListener?.dispose();
			exitListener?.dispose();

			// 合并输出
			let fullOutput = outputChunks.join('') + result;

			// 后处理：去除 PowerShell 欢迎信息、提示符重复等多余内容
			fullOutput = fullOutput
				// PowerShell 版本提示行
				.replace(/PowerShell\s+\d+\.\d+\.\d+.*\n?/gi, '')
				// 升级通知
				.replace(/A new PowerShell stable release is available:.*\n?/gi, '')
				.replace(/Upgrade now, or check out the release page at:.*\n?/gi, '')
				.replace(/https:\/\/aka\.ms\/PowerShell-Release\?tag=.*\n?/gi, '')
				// 多余的空行压缩
				.replace(/\n{3,}/g, '\n\n')
				.trim();

			// 尝试销毁终端实例
			try {
				if (instance) {
					instance.dispose();
				}
			} catch { /* ignore */ }

			// 截断过长输出
			const maxLen = 65536;
			const truncated = fullOutput.length > maxLen;
			const finalOutput = truncated
				? fullOutput.slice(0, maxLen) + `\n... (output truncated, ${fullOutput.length - maxLen} chars omitted)`
				: fullOutput;

			return [{ type: 'text', text: finalOutput || '(no output)' }];
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return [{ type: 'text', text: `Error executing command: ${msg}` }];
		}
	}

	/**
	 * 加载从 Hermes-Agent 迁移的打包工具定义。
	 * 这些工具只有 schema，handler 为存根，引导用户配置 MCP 服务器。
	 * 同名工具（已有原生 handler）不会被覆盖。
	 */
	private _registerBundledTools(): void {
		this.logService.info(`[BuiltinTools] _registerBundledTools: loading ${BUNDLED_TOOL_DEFINITIONS.length} bundled tool definitions`);
		for (const def of BUNDLED_TOOL_DEFINITIONS) {
			if (this._tools.has(def.name)) {
				// 原生工具优先，不覆盖
				continue;
			}
			// delegate_task 有真实 handler，不在 bundled 中注册 stub
			if (def.name === 'delegate_task') {
				continue;
			}
			// kanban_* 核心工具有真实 handler（见 _registerKanbanTools），不注册 stub
			if (KANBAN_TOOLS_WITH_HANDLER.has(def.name)) {
				continue;
			}
			// workflow_* 工具有真实 handler（见 _registerWorkflowTools），不注册 stub
			if (WORKFLOW_TOOLS_WITH_HANDLER.has(def.name)) {
				continue;
			}
			this.register({
				definition: { ...def, source: this.id },
				handler: async () => [{

					type: 'text' as const,
					text: `Tool "${def.name}" is defined but not yet implemented natively. ` +
						`Configure an MCP server that provides this tool, or it will be available ` +
						`when a matching provider is registered.`,
				}],
				isStub: true, // 标记为 stub — listTools 会跳过，防止 LLM 尝试调用
			});
		}
	}

	/**
	 * 注册委派/子代理相关工具（delegate_task, new_agent）。
	 * 这些工具需要真实的 handler，不能只是 stub。
	 */
	private _registerDelegationTools(): void {
		// delegate_task — LLM 自主委派任务给子代理
		this.register({
			definition: {
				name: 'delegate_task',
				displaySummary: 'Delegate to sub-agent(s) for parallel execution.',
				description: 'Delegate task(s) to a sub-agent. **PREFER BATCH MODE** (tasks: [...]) when you have 2+ independent investigations — ' +
					'this runs them in parallel and aggregates results. ' +
					'Use single mode (task: "...") only for one-off delegations. ' +
					'Each sub-agent runs independently in its own context.',
				inputSchema: {
					type: 'object',
					properties: {
						task: { type: 'string', description: 'Single task description to delegate' },
						tasks: { type: 'array', items: { type: 'string' }, description: 'Multiple task descriptions to delegate in parallel' },
						model: { type: 'string', description: 'Optional model to use for the sub-agent' },
						toolsets: { type: 'array', items: { type: 'string' }, description: 'Optional tool sets to enable for the sub-agent' },
					},
					required: [],
				},
				category: 'delegation',
				source: this.id,
			},
			handler: async (args, _signal, agentId) => {
				const task = args['task'] as string | undefined;
				const tasks = args['tasks'] as string[] | undefined;

				if (!task && (!tasks || tasks.length === 0)) {
					throw new Error('delegate_task: either "task" or "tasks" must be provided');
				}

				// v17: inherit the parent agent's worktree so the subagent tree
				// operates in the same working directory.
				const inheritedWorktree = this.getParentWorktreePath();

				// Build executeFn that delegates to AgentOS
				const executeFn = (request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> => {
					return this.agentOS.executeAgentTurn(request);
				};

				try {
					if (task) {
						// Single task mode — use dispatch()
						const result = await (this.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch).dispatch(
							agentId ?? 'unknown',
							task,
							executeFn,
							{ type: SubAgentType.General, worktreePath: inheritedWorktree },
						);
						if (result.success) {
							return [{ type: 'text', text: result.output ?? '(no output)' }];
						} else {
							return [{ type: 'text', text: `Sub-agent failed: ${result.error ?? 'unknown error'}` }];
						}
					} else {
						// Batch tasks mode — use dispatchParallelExplore()
						// v17: per-task worktree inherited from the parent agent.
						const perTaskOptions = inheritedWorktree
							? tasks!.map(() => ({ worktreePath: inheritedWorktree }))
							: undefined;
						const results = await (this.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch).dispatchParallelExplore(
							agentId ?? 'unknown',
							tasks!,
							executeFn,
							undefined, // context
							perTaskOptions as Array<{ priority?: 'low' | 'medium' | 'high'; maxIterations?: number; timeout?: number }> | undefined,
							undefined, // eventSink
						);
						const lines = results.map((r: SubAgentResult, i: number) => [
							`Task ${i + 1}: ${r.success ? 'SUCCESS' : 'FAILED'}`,
							r.success ? `  Output: ${r.output ?? '(empty)'}` : `  Error: ${r.error ?? 'unknown'}`,
						].join('\n'));
						return [{ type: 'text', text: lines.join('\n\n') }];
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return [{ type: 'text', text: `delegate_task error: ${msg}` }];
				}
			},
			descriptionBuilder: (agentId: string) => {
				try {
					const dispatch = this.orchestrationService.subAgentDispatch as UnifiedSubAgentDispatch;
					const config = dispatch.getConfig();
					return `Delegate a task (or multiple tasks) to a sub-agent. ` +
						`The sub-agent runs independently and returns its result. ` +
						`Use this when the task can be decomposed into independent parallel subtasks, ` +
						`or when the task requires a separate context window. ` +
						`Supports both single task (task) and batch tasks (tasks). ` +
						`You can run up to ${config.maxConcurrent} sub-agents in parallel ` +
						`(max ${config.maxSpawnDepth} levels deep). ` +
						`\n\n` +
						`## When to use:\n` +
						`- The task can be decomposed into 2+ independent subtasks\n` +
						`- You need to run multiple independent investigations simultaneously\n` +
						`- The subtask is complex enough to benefit from a dedicated context\n` +
						`\n\n` +
						`## When NOT to use:\n` +
						`- The task is simple and can be completed in one turn\n` +
						`- You need to maintain ongoing context/memory across steps\n` +
						`- You are already at maximum spawn depth\n`;
				} catch {
					return 'Delegate a task (or multiple tasks) to a sub-agent. ' +
						'The sub-agent runs independently and returns its result. ' +
						'Use this when a task can be performed in parallel or requires a separate context. ' +
						'Supports both single task (task) and batch tasks (tasks).';
				}
			},
		});
		this.logService.info('[BuiltinTools] _registerDelegationTools: delegate_task registered');

		// ── new_agent — 创建持久化 Agent 定义 ──────────────────────────────
		// 与 delegate_task 的区别：new_agent 创建可复用的持久化 Agent，
		// 而 delegate_task 创建一次性子代理。详见 handleNewAgentTool 文档。
		this.register({
			definition: {
				name: 'new_agent',
				description: [
					'Create a new persistent agent definition that can be reused for future tasks.',
					'',
					'The created agent is saved to ~/.saros/agents/{agentId}/ and becomes available',
					'for delegation (delegate_task), orchestration plans, and manual invocation.',
					'',
					'## When to use:',
					'- You need a specialized agent that does not exist yet',
					'- A task requires a role/toolset combination not covered by existing agents',
					'- You want to create a reusable team member for ongoing work',
					'',
					'## When NOT to use:',
					'- For a one-off task (use delegate_task instead)',
					'- The agent already exists (use delegate_task to invoke it)',
				].join('\n'),
				inputSchema: {
					type: 'object',
					properties: {
						name: { type: 'string', description: 'Human-readable agent name (e.g. "Code Reviewer")' },
						role: { type: 'string', description: 'Agent role/specialty (e.g. "Reviewer", "Researcher", "Developer")' },
						description: { type: 'string', description: 'What this agent does and when to use it' },
						systemPrompt: { type: 'string', description: 'Custom system prompt for the agent' },
						model: { type: 'string', description: 'LLM model (default: inherits workspace default)' },
						tools: {
							type: 'array',
							items: { type: 'string' },
							description: 'Enabled tool names (default: all core tools)',
						},
						skills: {
							type: 'array',
							items: { type: 'string' },
							description: 'Skill names to enable',
						},
						category: { type: 'string', description: 'Category label (default: "General")' },
						agentType: {
							type: 'string',
							enum: ['planner', 'worker'],
							description: 'planner = can orchestrate sub-tasks; worker = executes tasks (default: worker)',
						},
					},
					required: ['name', 'role', 'description'],
				},
				category: 'delegation',
				source: this.id,
				securityLevel: ToolSecurityLevel.Cautious,
			},
			handler: async (args) => {
				return handleNewAgentTool(args, this.studioService);
			},
		});
		this.logService.info('[BuiltinTools] _registerDelegationTools: new_agent registered');
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


	private async _walkAndGrep(dir: URI, query: string, out: string[], limit: number, signal?: AbortSignal): Promise<void> {
		// Hard global cap on files we will read+grep regardless of `limit`.
		// This protects against pathological recursion (huge build trees, symlink
		// loops, accidentally pointing at C:\) which can OOM the renderer because
		// each file we open allocates a UTF-8 string copy of the buffer.
		const MAX_FILES_VISITED = 5_000;
		const filesVisited = { count: 0 };
		const seenDirs = new Set<string>();
		const NOISE_DIRS = new Set<string>([
			'node_modules', '.git', 'out', 'dist', 'build', '.build',
			'.next', '.cache', '.vscode-test', 'coverage', '__pycache__',
			'target', '.gradle', '.idea', 'bin', 'obj', '.pnpm-store',
			'.yarn', '.parcel-cache', '.turbo', '.nuxt', '.svelte-kit',
			'.angular', 'venv', '.venv', 'env', '.env',
		]);
		// Extension blacklist — we never grep into binary-shaped files. The toString()
		// on a 500KB binary creates a large garbage string + thousands of split parts,
		// which is a major contributor to OOM under parallel execution.
		const BINARY_EXT_RE = /\.(?:exe|dll|so|dylib|node|pak|asar|wasm|bin|obj|lib|a|o|class|jar|pyc|pyo|whl|zip|tar|gz|tgz|bz2|7z|rar|xz|zst|png|jpe?g|gif|bmp|ico|webp|tif|tiff|svg|psd|mp3|wav|ogg|flac|mp4|mov|avi|mkv|webm|pdf|docx?|xlsx?|pptx?|sqlite|db|map|woff2?|ttf|eot|otf)$/i;

		const walk = async (current: URI): Promise<void> => {
			if (signal?.aborted) { return; }
			if (out.length >= limit) { return; }
			if (filesVisited.count >= MAX_FILES_VISITED) { return; }
			const key = current.toString();
			if (seenDirs.has(key)) { return; }
			seenDirs.add(key);

			let stat;
			try { stat = await this.fileService.resolve(current); } catch { return; }
			if (!stat.isDirectory || !stat.children) { return; }

			for (const child of stat.children) {
				if (signal?.aborted) { return; }
				if (out.length >= limit) { return; }
				if (filesVisited.count >= MAX_FILES_VISITED) { return; }

				if (child.isDirectory) {
					if (NOISE_DIRS.has(child.name) || child.name.startsWith('.')) { continue; }
					await walk(child.resource);
					continue;
				}
				if (!child.isFile) { continue; }
				// Skip binary files by extension before any I/O.
				if (BINARY_EXT_RE.test(child.name)) { continue; }
				// Existing 512 KiB safety net (we keep it as a second line of defense).
				if (typeof child.size === 'number' && child.size > 512 * 1024) { continue; }

				filesVisited.count++;

				try {
					const buf = await this.fileService.readFile(child.resource);
					// Quick binary-content sniff: if the first 1 KiB contains a NUL byte,
					// treat as binary. UTF-8 / UTF-16 text never legitimately contains NUL
					// in real source files; this catches cases the extension list missed.
					const raw = buf.value.buffer;
					const sniffLen = Math.min(raw.length, 1024);
					let isBinary = false;
					for (let i = 0; i < sniffLen; i++) {
						if (raw[i] === 0) { isBinary = true; break; }
					}
					if (isBinary) { continue; }

					const text = buf.value.toString();
					// Hard cap per-file string size to keep heap pressure bounded even
					// if the size hint was missing/wrong.
					const safeText = text.length > 256 * 1024 ? text.substring(0, 256 * 1024) : text;
					const lines = safeText.split('\n');
					for (let i = 0; i < lines.length; i++) {
						if (signal?.aborted) { return; }
						if (lines[i].includes(query)) {
							out.push(`${child.resource.fsPath}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
							if (out.length >= limit) { return; }
						}
					}
				} catch { /* unreadable / binary — skip */ }
			}
		};

		await walk(dir);
	}

	// ─── Workflow AI Editing Tools (extracted to workflowTools.ts) ──────

	private _registerWorkflowTools(): void {
		registerWorkflowTools({
			register: (def) => this.register(def),
			workflowStorageService: this.workflowStorageService,
			studioService: this.studioService,
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
		});
	}

	// ── Memory helpers ──────────────────────────────────────────
	// ── Memory helpers ──────────────────────────────────────────

	private _getMemFile(agentId: string, fileName: string): URI {
		const safe = agentId.replace(/[^A-Za-z0-9_.-]/g, '_');
		return URI.joinPath(this.environmentService.userHome, '.saros', 'memory', safe, fileName);
	}

	private async _readJsonl(file: URI): Promise<any[]> {
		try {
			const buf = await this.fileService.readFile(file);
			const text = buf.value.toString();
			const out: any[] = [];
			for (const raw of text.split('\n')) {
				const line = raw.trim();
				if (!line) { continue; }
				try { out.push(JSON.parse(line)); } catch {}
			}
			return out;
		} catch {
			return [];
		}
	}

	private async _writeAtomic(file: URI, entries: any[]): Promise<void> {
		const text = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
		const tmpFile = URI.joinPath(file, '..', `.mem_${Date.now()}_${Math.random().toString(36).slice(2)}`);
		try {
			await this.fileService.writeFile(tmpFile, VSBuffer.fromString(text));
			await this.fileService.move(tmpFile, file, true);
		} catch (err) {
			try { await this.fileService.del(tmpFile); } catch {}
			throw err;
		}
	}
}

