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
import { AgentNetworkDomainSettingId } from '../../../../../../platform/networkFilter/common/settings.js';
import { resolveKbRoot } from '../../knowledge/knowledgeStorage.js';
import { LEGACY_SAROS_DIR } from '../../../common/sarosPaths.js';
import { checkWriteDenied, WriteDeniedError } from '../../../common/writeDenyList.js';
import { resolveEffectiveWorktreeRoot, detectStaleWorktreeAccess, staleWorktreeWarning } from '../../../common/worktreeBinding.js';

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
 * 同时检查 VS Code 工作区文件夹和 Saros Agent 工作区路径。Windows 路径大小写不敏感。
 *
 * 从 builtinToolProvider._resolveAndCheckWorkspacePath 抽取为纯函数，
 * 由主文件薄包装（持有 _sandboxBypassRoots 字段）经 ctx 复用。
 *
 * @param agentId 当前 agent 的 ID，用于查找 Saros workspace 路径
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
	let activeWorkspacePath: string | undefined;
	if (agentId) {
		try {
			activeWsId = studioService.getActiveWorkspaceId();
			if (activeWsId) {
				const binding = await studioService.getAgentBinding(activeWsId, agentId);
				if (binding?.worktreePath) {
					// 先取 workspace 主路径，用于「绑定目标是否就是主仓」的等价判定。
					// ⚠ 2026-08-20（日志 1787211923566）：worktreePath 可以等于主仓路径
					// （用户把 agent 绑回主仓 / 选 "main"），此时**不是** worktree 隔离；
					// 若仍走下面的独占沙箱分支，`worktreeStrictIsolation=true` 会少放行
					// VS Code 工作区文件夹与 relatedFolders，多根工程（引擎 + 项目）读
					// 引擎源码会被误拦。判定口径与 agentDriverService 共用
					// resolveEffectiveWorktreeRoot，确保沙箱边界与提示词工作根一致。
					try {
						activeWorkspacePath = (await studioService.getWorkspace(activeWsId))?.path;
					} catch { /* 主路径拿不到时退化为按原样处理 */ }
					worktreeRoot = resolveEffectiveWorktreeRoot(binding.worktreePath, activeWorkspacePath);
				}
			}
		} catch (err) {
			logService.warn(`[BuiltinTools] Failed to resolve worktree for agent ${agentId}:`, err);
		}
	}

	if (worktreeRoot) {
		// 独占模式：worktree 是主沙箱，但仍放行 VS Code 工作区文件夹和关联
		// 文件夹——多文件夹工作区（如 UE5EA 引擎 + S1Game 项目）中，agent 需要
		// 读取引擎源码等非 worktree 目录进行代码分析。worktree 绑定限制的是
		// 写入目标，不应阻断对工作区其他合法文件夹的访问。
		allowedRoots.push(worktreeRoot);
		logService.info(`[BuiltinTools] Agent ${agentId} is worktree-sandboxed to: ${worktreeRoot}`);

		const worktreeStrictIsolation = configurationService.getValue<boolean>(
			AgentNetworkDomainSettingId.WorktreeStrictIsolation,
		) ?? true;

		// 严格隔离关闭（默认）时放行 VS Code 工作区文件夹 + Saros 主仓 + 关联文件夹，便于多根代码分析
		if (!worktreeStrictIsolation) {
			// 同时放行 VS Code 工作区文件夹
			const vscodeFolders = workspaceService.getWorkspace().folders;
			for (const folder of vscodeFolders) {
				allowedRoots.push(folder.uri.fsPath.replace(/[\\/]+$/, ''));
			}

			// 同时放行 Saros 工作区路径 + 关联文件夹
			if (activeWsId) {
				try {
					const workspace = await studioService.getWorkspace(activeWsId);
					if (workspace?.path) {
						allowedRoots.push(workspace.path.replace(/[\\/]+$/, ''));
					}
					for (const rf of workspace?.relatedFolders ?? []) {
						if (rf?.path) {
							allowedRoots.push(rf.path.replace(/[\\/]+$/, ''));
						}
					}
				} catch (err) {
					logService.warn(`[BuiltinTools] Failed to resolve workspace folders for worktree-sandboxed agent ${agentId}:`, err);
				}
			}
		}
	} else {
		// ─── 常规模式：未绑定 worktree，沿用多根工作区 ───────────────
		// 1. VS Code 工作区文件夹
		const vscodeFolders = workspaceService.getWorkspace().folders;
		for (const folder of vscodeFolders) {
			allowedRoots.push(folder.uri.fsPath.replace(/[\\/]+$/, ''));
		}

		// 2. Saros Agent 工作区路径（agent 是全局，运行 workspace 取自
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
				logService.warn(`[BuiltinTools] Failed to resolve Saros workspace for agent ${agentId}:`, err);
			}
		}
	}

	// 3. ~/.vssaros/ — Agent 自身数据目录，脱离沙箱限制（2026-07-13）
	//   技能（skills/）、记忆（memory/）、Agent 定义（agents/）、会话（sessions/）、
	//   知识库（kb/）等 LLM 工具需要读写的内部数据都在此目录下。worktree 沙箱和
	//   常规工作区沙箱都不应限制 Agent 访问自己的配置/数据文件。
	{
		const userDataPath = (environmentService as INativeEnvironmentService).userDataPath;
		if (userDataPath) {
			allowedRoots.push(userDataPath);
		}
	}

	// 3.5 知识库根目录 — 脱离沙箱限制（2026-07-14）
	//   无论 KB 存储配置指向何处（默认 ~/.vssaros/knowledge-base 或用户自定义路径），
	//   Agent 读写知识库、笔记等文件时不应受工作区沙箱拦截。
	{
		const userDataPath = (environmentService as INativeEnvironmentService).userDataPath;
		if (userDataPath) {
			// a) KB 存储根（来自配置 agentStudio.knowledge.storage.path）
			const kbStoragePath = configurationService.getValue<string>(kbStoragePathKey);
			const kbRoot = resolveKbRoot(kbStoragePath, userDataPath);
			allowedRoots.push(kbRoot.replace(/[\\/]+$/, ''));

			// b) KB 视图根（来自持久化存储 agentStudio.kb.kbDir，可能指向自定义路径）
			const kbViewRoot = storageService.get('agentStudio.kb.kbDir', StorageScope.APPLICATION);
			if (kbViewRoot && typeof kbViewRoot === 'string' && kbViewRoot.length > 0) {
				allowedRoots.push(kbViewRoot.replace(/[\\/]+$/, ''));
			}
		}

		// c) 各 Vault 的自定义根目录（vault.customPath / vault.id 笔记目录）也纳入允许范围
		try {
			const vaultsJson = storageService.get('agentStudio.kb.vaults', StorageScope.APPLICATION);
			if (vaultsJson) {
				const vaults: Array<{ customPath?: string; id?: string }> = JSON.parse(vaultsJson);
				for (const v of vaults) {
					// 自定义 Vault 根目录（vault.customPath）
					if (typeof v.customPath === 'string' && v.customPath.length > 0) {
						allowedRoots.push(v.customPath.replace(/[\\/]+$/, ''));
					}
				}
			}
		} catch (err) {
			logService.warn(`[BuiltinTools] Failed to resolve KB vault paths:`, err);
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

	// 计算建议路径：把请求文件名重定向到第一个非 saros 数据目录的允许根下。
	const requestedBase = (requestedPath.split(/[\\/]/).pop() || 'file')
		.replace(/[<>:"/\\|?*]/g, '_');
	const candidateRoots = allowedRoots.filter(r => {
		const normalized = r.replace(/\\/g, '/').toLowerCase();
		// Exclude legacy ~/.saros and the app data root (~/.vssaros) as suggestion targets
		return !normalized.includes(`/${LEGACY_SAROS_DIR}`) && !normalized.endsWith('/.vssaros') && !normalized.endsWith('/.vssaros-dev');
	});
	const suggestedPath = candidateRoots.length > 0
		? join(candidateRoots[0], requestedBase)
		: undefined;

	// 仅写/删操作触发沙箱判定，读操作直接返回已解析路径
	if (checkSandbox && !isAllowed) {
		const allowedList = normalizedRoots.length > 0
			? normalizedRoots.map(r => `  - ${r}`).join('\n')
			: '  (无 — 请确认已正确配置工作区)';
		const baseMessage = worktreeRoot
			? `安全沙箱限制：该 Agent 实例已绑定 worktree。\n` +
				`路径 "${requestedPath}" (解析后: "${resolvedPath}") 超出了允许范围。\n` +
				`当前允许的目录：\n${allowedList}\n` +
				`请在上述目录内操作。如需写入其它目录，可在确认卡片中选择「允许本次」/「允许此工作区」，或解除该 Agent 的 worktree 绑定。`
			: `安全沙箱限制：路径 "${requestedPath}" (解析后: "${resolvedPath}") 不在允许的工作区目录内。\n` +
				`当前允许的工作区目录：\n${allowedList}\n` +
				`请在上述目录内操作，或在 Saros 工作区设置中配置正确的路径。`;
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

	// ─── 写黑名单（2026-08-22，闭合 MEMORY 记录的 ★★ 安全缺口）──────────────
	// 位置至关重要：**必须排在允许根判定之后** —— 黑名单是「硬拒」而非「征求同意」，
	// 放在前面会被 `sandboxBypassRoots`（用户「允许本次」）与 `~/.vssaros` 允许根
	// 一并绕过，而后者恰恰是本护栏要防的目标（provider apiKey 就在
	// `~/.vssaros/User/settings.json`，它**在**允许根内、且写操作已免审批）。
	//
	// 只在写/删路径（checkSandbox=true）生效；读/搜索不受影响（本项目 file_read
	// 一律不过沙箱，且 terminal 以同一 OS 用户运行、cat 随时可绕 —— 读侧拦截
	// 只是 defense-in-depth 而非边界，见 writeDenyList 模块注释）。
	if (checkSandbox) {
		const denied = checkWriteDenied(resolvedPath, {
			userHome: (environmentService as INativeEnvironmentService).userHome?.fsPath,
			appDataRoot: (environmentService as INativeEnvironmentService).userDataPath,
		});
		if (denied) {
			// 日志只记规则标识与原因，不回显完整路径以外的内容（路径本身已在 message 里）。
			logService.warn(`[BuiltinTools] write denied by denylist: rule=${denied.rule} reason=${denied.reason} path=${resolvedPath}`);
			throw new WriteDeniedError(resolvedPath, denied.reason, denied.rule, denied.message);
		}
	}

	// ─── 越界访问未绑定 worktree 副本（2026-08-20，日志 1787217670299）──────────
	// `.worktrees/**` 对搜索/索引硬排除，但对 file_read/file_write/patch 完全可达
	// （读操作不做沙箱判定；写操作因主仓根是 allowedRoot 而放行其子目录）。这种
	// 不对称让模型在过期分支副本里工作而搜索永远无法印证（详见 detectStaleWorktreeAccess）。
	//
	// 处置分级：
	//   - 写/删（checkSandbox=true）→ 直接拦下。写进过期副本是明确错误，且会被
	//     下一次 worktree 重建/合并悄悄丢弃；错误信息给出主仓等价路径供其重试。
	//   - 读 → 不拦（用户可能确实要求排查某个 worktree），仅 warn 日志留痕。
	const staleWorktree = detectStaleWorktreeAccess(resolvedPath, worktreeRoot);
	if (staleWorktree) {
		if (checkSandbox) {
			throw new SandboxViolationError(
				requestedPath,
				resolvedPath,
				[...normalizedRoots],
				staleWorktree.mainRepoEquivalent,
				!!worktreeRoot,
				`拒绝写入未绑定的 git worktree 副本。\n` +
				`路径 "${requestedPath}" (解析后: "${resolvedPath}") 位于 worktree "${staleWorktree.branchName}"，` +
				`而该 Agent 未绑定此 worktree${worktreeRoot ? `（当前绑定：${worktreeRoot}）` : '（当前工作在主仓）'}。\n` +
				`该目录是另一个分支的独立检出，通常是过期代码，且已从 search_code / search_files / 代码图中排除。\n` +
				`请改写主仓对应路径：${staleWorktree.mainRepoEquivalent}`,
			);
		}
		logService.warn(
			`[BuiltinTools] ${staleWorktreeWarning(staleWorktree, 'read')} ` +
			`(agent=${agentId ?? '<none>'}, requested="${requestedPath}")`,
		);
	}

	return resolvedPath;
}
