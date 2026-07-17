/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from '../../../../../../base/common/path.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope } from '../../../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IAgentStudioService } from '../../../../../common/agentStudioService.js';
import { resolveWorkspacePath } from '../../../common/workspacePathResolver.js';
import { resolveKbRoot } from '../../knowledge/knowledgeStorage.js';

/**
 * 安全沙箱违规错误。executeTool / agentOSService 会检测 isSandboxViolation
 * 以弹出确认卡片（而非让 agent loop 无效重试）。
 */
export class SandboxViolationError extends Error {
	readonly isSandboxViolation = true;
	constructor(
		readonly requestedPath: string,
		readonly resolvedPath: string,
		readonly allowedRoots: string[],
		readonly suggestedPath: string | undefined,
		readonly isWorktree: boolean,
		message: string,
	) {
		super(message);
		this.name = 'SandboxViolationError';
	}
}

export interface WorkspacePathDeps {
	studioService: IAgentStudioService;
	workspaceService: IWorkspaceContextService;
	environmentService: INativeEnvironmentService;
	configurationService: IConfigurationService;
	storageService: IStorageService;
	logService: ILogService;
	/** 本次工具调用临时放行的精确路径集合（按引用传入，重试期增删即时生效）。 */
	sandboxBypassRoots: Set<string>;
	/** Config key controlling where knowledge bases are persisted. */
	kbStoragePathKey: string;
}

/**
 * 检查请求的路径是否在允许的工作区目录内，并将相对路径解析为绝对路径。
 * 同时检查 VS Code 工作区文件夹和 Sarosis Agent 工作区路径。Windows 路径大小写不敏感。
 *
 * 从 builtinToolProvider._resolveAndCheckWorkspacePath 抽取为纯函数，
 * 由主文件薄包装（持有 _sandboxBypassRoots 字段）经 ctx 复用。
 *
 * @param agentId 当前 agent 的 ID，用于查找 Sarosis workspace 路径
 * @param requestedPath 请求的文件/目录路径（支持相对路径，如 "."、"./src"）
 * @returns 解析后的绝对路径
 * @throws SandboxViolationError 如果路径不在任何允许的工作区内
 */
export async function resolveAndCheckWorkspacePathImpl(
	deps: WorkspacePathDeps,
	agentId: string | undefined,
	requestedPath: string,
	checkSandbox: boolean = true,
): Promise<string> {
	const { studioService, workspaceService, environmentService, configurationService, storageService, logService, sandboxBypassRoots, kbStoragePathKey } = deps;

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
			activeWsId = studioService.getActiveWorkspaceId();
			if (activeWsId) {
				const binding = await studioService.getAgentBinding(activeWsId, agentId);
				if (binding?.worktreePath) {
					worktreeRoot = binding.worktreePath.replace(/[\\/]+$/, '');
				}
			}
		} catch (err) {
			logService.warn(`[BuiltinTools] Failed to resolve worktree for agent ${agentId}:`, err);
		}
	}

	if (worktreeRoot) {
		// 独占模式：仅允许 worktree 目录
		allowedRoots.push(worktreeRoot);
		logService.info(`[BuiltinTools] Agent ${agentId} is worktree-sandboxed to: ${worktreeRoot}`);
	} else {
		// ─── 常规模式：未绑定 worktree，沿用多根工作区 ───────────────
		// 1. VS Code 工作区文件夹
		const vscodeFolders = workspaceService.getWorkspace().folders;
		for (const folder of vscodeFolders) {
			allowedRoots.push(folder.uri.fsPath.replace(/[\\/]+$/, ''));
		}

		// 2. Sarosis Agent 工作区路径（agent 是全局，运行 workspace 取自
		//    getActiveWorkspaceId — 已在上面解析为 activeWsId）。
		if (activeWsId) {
			try {
				const workspace = await studioService.getWorkspace(activeWsId);
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
				logService.warn(`[BuiltinTools] Failed to resolve Sarosis workspace for agent ${agentId}:`, err);
			}
		}
	}

	// 3. ~/.saros — Agent 自身数据目录，脱离沙箱限制（2026-07-13）
	//   技能（skills/）、记忆（memory/）、Agent 定义（agents/）、会话（sessions/）、
	//   知识库（kb/）等 LLM 工具需要读写的内部数据都在此目录下。worktree 沙箱和
	//   常规工作区沙箱都不应限制 Agent 访问自己的配置/数据文件。
	{
		const userHome = (environmentService as any).userHome?.fsPath as string | undefined;
		if (userHome) {
			allowedRoots.push(join(userHome, '.saros'));
		}
	}

	// 3.5 知识库根目录 — 脱离沙箱限制（2026-07-14）
	//   无论 KB 存储配置指向何处（默认 ~/.saros/knowledge-base 或用户自定义路径），
	//   Agent 读写知识库、笔记等文件时不应受工作区沙箱拦截。
	{
		const userHome = (environmentService as any).userHome?.fsPath as string | undefined;
		if (userHome) {
			// a) KB 存储根（来自配置 agentStudio.knowledge.storage.path）
			const kbStoragePath = configurationService.getValue<string>(kbStoragePathKey);
			const kbRoot = resolveKbRoot(kbStoragePath, userHome);
			allowedRoots.push(kbRoot.replace(/[\\/]+$/, ''));

			// b) KB 视图根（来自持久化存储 agentStudio.kb.rootDir，可能指向自定义路径）
			const kbViewRoot = storageService.get('agentStudio.kb.rootDir', StorageScope.APPLICATION);
			if (kbViewRoot && typeof kbViewRoot === 'string' && kbViewRoot.length > 0) {
				allowedRoots.push(kbViewRoot.replace(/[\\/]+$/, ''));
			}
		}

		// c) 笔记根目录 — 每个 Vault 可自定义 notesPath（来自持久化存储 agentStudio.kb.vaults）
		try {
			const vaultsJson = storageService.get('agentStudio.kb.vaults', StorageScope.APPLICATION);
			if (vaultsJson) {
				const vaults: Array<{ notesPath?: string; customPath?: string }> = JSON.parse(vaultsJson);
				for (const v of vaults) {
					if (typeof v.notesPath === 'string' && v.notesPath.length > 0) {
						allowedRoots.push(v.notesPath.replace(/[\\/]+$/, ''));
					}
					// 自定义 Vault 根目录（vault.customPath）也纳入允许范围
					if (typeof v.customPath === 'string' && v.customPath.length > 0) {
						allowedRoots.push(v.customPath.replace(/[\\/]+$/, ''));
					}
				}
			}
		} catch (err) {
			logService.warn(`[BuiltinTools] Failed to resolve KB notes paths:`, err);
		}
	}

	// 4. 用户显式允许的沙箱根（「允许此工作区」持久化到 Workspace.sandboxRoots）
	if (activeWsId) {
		try {
			const ws = await studioService.getWorkspace(activeWsId);
			for (const r of ws?.sandboxRoots ?? []) {
				if (typeof r === 'string' && r.length > 0) {
					allowedRoots.push(r.replace(/[\\/]+$/, ''));
				}
			}
		} catch (err) {
			logService.warn(`[BuiltinTools] Failed to resolve sandboxRoots for workspace ${activeWsId}:`, err);
		}
	}

	// 5. 本次工具调用临时放行的精确路径（「允许本次」）
	for (const r of sandboxBypassRoots) {
		allowedRoots.push(r);
	}

	// 边界校验：用 URI + isEqualOrParent（见 workspacePathResolver.ts），
	// 替代旧的手动 `canonicalize`（一刀切 toLowerCase + startsWith）。
	// 后者在大小写敏感文件系统（Linux）上会把 `/Foo/x` 误判为落在 `/foo`
	// 沙箱内，是一处跨平台越界隐患；新实现按 scheme/平台正确处理大小写、
	// 盘符与正/反斜杠归一化。
	const { resolvedPath, isAllowed, normalizedRoots } = resolveWorkspacePath(requestedPath, allowedRoots);

	// 计算建议路径：把请求文件名重定向到第一个非 ~/.saros 的允许根下。
	const requestedBase = (requestedPath.split(/[\\/]/).pop() || 'file')
		.replace(/[<>:"/\\|?*]/g, '_');
	const candidateRoots = allowedRoots.filter(r =>
		!r.replace(/\\/g, '/').toLowerCase().includes('/.saros'));
	const suggestedPath = candidateRoots.length > 0
		? join(candidateRoots[0], requestedBase)
		: undefined;

	// 仅写/删操作触发沙箱判定，读操作直接返回已解析路径
	if (checkSandbox && !isAllowed) {
		const allowedList = normalizedRoots.length > 0
			? normalizedRoots.map(r => `  - ${r}`).join('\n')
			: '  (无 — 请确认已正确配置工作区)';
		const baseMessage = worktreeRoot
			? `安全沙箱限制：该 Agent 实例已绑定 worktree，仅允许在 worktree 目录内操作。\n` +
				`路径 "${requestedPath}" (解析后: "${resolvedPath}") 超出了 worktree 边界。\n` +
				`当前 worktree 工作区：\n${allowedList}\n` +
				`请在该 worktree 目录内操作。如需访问其它目录，请解除该 Agent 的 worktree 绑定。`
			: `安全沙箱限制：路径 "${requestedPath}" (解析后: "${resolvedPath}") 不在允许的工作区目录内。\n` +
				`当前允许的工作区目录：\n${allowedList}\n` +
				`请在上述目录内操作，或在 Sarosis 工作区设置中配置正确的路径。`;
		// 抛出结构化错误，供 agentOSService 检测并弹出确认卡片
		// （而非仅回显一段错误文本导致 agent loop 无效重试）。
		throw new SandboxViolationError(
			requestedPath,
			resolvedPath,
			[...normalizedRoots],
			suggestedPath,
			!!worktreeRoot,
			baseMessage,
		);
	}

	return resolvedPath;
}
