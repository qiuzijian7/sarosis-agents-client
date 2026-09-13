/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope } from '../../../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IAgentStudioService } from '../../../../../common/agentStudioService.js';
import { resolveWorkspacePath } from '../../../common/workspacePathResolver.js';
import { realPathBestEffort, realRootsBestEffort, realPathAllowedWithinRoots } from '../../../common/symlinkGuard.js';
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

/**
 * 计算建议路径（2026-09-07 重写）：旧算法 =「basename 重定向到第一个允许根」，
 * 丢弃全部子目录 → 建议路径必然不存在（日志 1788746435013 案例：真实文件在 8 层
 * 子目录下，建议却指向仓库根）——模型/用户按建议重试落空，若改用 file_write 还会
 * 在仓库根制造重复文件，护栏从「拒绝越界」变成「诱导写错位置」。
 *
 * 新算法两级，**建议必须指向真实存在的文件**：
 *  ① 结构修复（零搜索成本）：requestedPath 的路径段中若含某允许根的末段名
 *     （典型：.../AIProjects/AIProjects/sarosis-agents-client/src/... 的重复前缀
 *     幻觉），截取其后全部段拼回该允许根，并用 fileService.exists 验证；
 *  ② basename 限深回溯（≤6 层 / ≤500 目录 / 噪声目录跳过，大小写不敏感）：
 *     仅当**唯一命中**时才建议（多命中无法确定意图，诚实放弃）。
 * 两级都失败 → undefined，由调用方回退为 search_files 定位引导。
 */
/**
 * P2 结构修复（2026-09-07）：requestedPath 的路径段中若锚定到某允许根的末段名
 * （典型：.../AIProjects/AIProjects/sarosis-agents-client/src/... 的重复前缀幻觉），
 * 截取其后全部段拼回该允许根，并用 fileService.exists 验证。
 * 返回修复后的真实路径；无法修复 → undefined。
 *
 * 安全边界（双层）：① 只有路径中**包含**根目录名段才触发——模型想写根外新文件
 * 的路径不含根名段，不会误触发；② 修复结果必须 exists——「写新文件」天然不命中，
 * 只有「读/改已有文件的路径幻觉」会被自愈，意图保留充分。
 */
async function structuralRepairOutOfRootPath(
	fileService: IFileService,
	requestedPath: string,
	candidateRoots: string[],
): Promise<string | undefined> {
	const segs = requestedPath.replace(/\\/g, '/').split('/').filter(s => s.length > 0);
	for (const root of candidateRoots) {
		const rootSegs = root.replace(/\\/g, '/').split('/').filter(s => s.length > 0);
		const rootEnd = (rootSegs[rootSegs.length - 1] || '').toLowerCase();
		if (!rootEnd) { continue; }
		const idx = segs.map(s => s.toLowerCase()).lastIndexOf(rootEnd);
		if (idx >= 0 && idx < segs.length - 1) {
			const candidate = `${root.replace(/[\\/]+$/, '')}/${segs.slice(idx + 1).join('/')}`;
			try {
				if (await fileService.exists(URI.file(candidate))) { return candidate; }
			} catch { /* 探测失败继续 */ }
		}
	}
	return undefined;
}

async function computeSuggestedPath(
	fileService: IFileService,
	requestedPath: string,
	candidateRoots: string[],
): Promise<string | undefined> {
	const segs = requestedPath.replace(/\\/g, '/').split('/').filter(s => s.length > 0);
	const wantedBase = (segs[segs.length - 1] || '').toLowerCase();
	if (!wantedBase) { return undefined; }

	// ① 结构修复（独立函数，与 P2 容错解析共享）
	const structural = await structuralRepairOutOfRootPath(fileService, requestedPath, candidateRoots);
	if (structural) { return structural; }

	// ② basename 限深回溯（唯一命中才建议）
	for (const root of candidateRoots) {
		const hits: string[] = [];
		const seen = new Set<string>();
		let dirs = 0;
		const walk = async (uri: URI, depth: number): Promise<void> => {
			if (hits.length > 1 || dirs >= 500 || depth > 6) { return; }
			const key = uri.toString();
			if (seen.has(key)) { return; }
			seen.add(key);
			dirs++;
			let stat;
			try { stat = await fileService.resolve(uri); } catch { return; }
			for (const child of stat.children ?? []) {
				if (hits.length > 1) { return; }
				if (child.isDirectory) {
					// 噪声目录跳过（核心项对齐 SearchHelpers.NOISE_DIR_NAMES）
					if (/^(node_modules|\.git|out|dist|build|\.next|\.cache|coverage|__pycache__|\.worktrees?|\.vssaros.*|\.venv|target)$/i.test(child.name)) { continue; }
					await walk(child.resource, depth + 1);
				} else if (child.name.toLowerCase() === wantedBase) {
					hits.push(child.resource.fsPath);
				}
			}
		};
		await walk(URI.file(root.replace(/[\\/]+$/, '')), 0);
		if (hits.length === 1) { return hits[0]; }
	}
	return undefined;
}

export interface WorkspacePathDeps {
	studioService: IAgentStudioService;
	workspaceService: IWorkspaceContextService;
	environmentService: INativeEnvironmentService;
	configurationService: IConfigurationService;
	storageService: IStorageService;
	logService: ILogService;
	/** 2026-09-07：建议路径的存在性验证与限深回溯定位（见 computeSuggestedPath）。 */
	fileService: IFileService;
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
	const { studioService, workspaceService, environmentService, configurationService, storageService, logService, sandboxBypassRoots, kbStoragePathKey, fileService } = deps;

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
	let { resolvedPath, isAllowed, normalizedRoots } = resolveWorkspacePath(requestedPath, allowedRoots);

	// ★★ 符号链接逃逸防护（2026-09-13）—— 详见 `common/symlinkGuard` 模块头注释。
	//
	// 上面的边界校验是**纯词法**的（零文件系统访问）→ **不解析符号链接**。于是
	// `<workspace>/evil --symlink--> ~/.vssaros/User` 这类路径会被判为「在允许根内」，
	// 而 `writeDenyList` / `sensitiveWriteRejection` / `isProtectedPath` 三条也按
	// **词法**路径查 → 全部落空 → 写 `<workspace>/evil/settings.json` 可**免审批**
	// 改写 provider apiKey（apiKey 就在 `~/.vssaros/User/settings.json`）。
	//
	// 处置：把**目标**与**允许根**都做一次 best-effort realpath，再重算一次边界。
	//   · 解析失败（新建文件 / 平台不支持）→ 原样返回 → 行为与修正前**完全一致**（fail-safe）；
	//   · 允许根也解析 → 不引入误拒（macOS `/tmp` → `/private/tmp`）；
	//   · 只有「真实路径 ≠ 词法路径」（即真的存在 symlink）时才可能改变判定。
	//
	// 返回的 `resolvedPath` 因此是**真实路径** → 下游的写黑名单、敏感路径硬拒、
	// 受保护路径判定、以及 `file_read` 读守卫，全部自动变成 symlink-aware。
	if (fileService) {
		const realpath = (u: URI) => fileService.realpath(u);
		const realPath = await realPathBestEffort(realpath, resolvedPath);
		if (realPath !== resolvedPath) {
			const realRoots = await realRootsBestEffort(realpath, allowedRoots);
			const recheck = resolveWorkspacePath(realPath, realRoots);
			// ⚠ 差异**未必**是符号链接：Windows 上模型常给出 `/tmp/x` 这类 Unix 风格路径，
			// 而 realpath 会把它规范化成 `g:\tmp\x`（**同一位置**，只是形态不同）。
			// 实测 `vscode-app-1789281483413.log:611` 就打出一条「symlink resolved」误报，
			// 而那次 `file_read` 的报错是 "File not found" —— 与 symlink 无关。
			//
			// ⇒ 判据改成**「边界判定是否真的被改变」**（不依赖任何关于路径形态的假设）：
			//   没改变 → 只记 debug（避免刷屏）；改变了 → warn（这才是真正要看的）。
			if (recheck.isAllowed !== isAllowed) {
				logService.warn(
					`[WorkspaceSecurity] real path changed the sandbox verdict: ` +
					`"${resolvedPath}" → "${realPath}" (allowed ${isAllowed} → ${recheck.isAllowed})`,
				);
			} else {
				logService.debug(
					`[WorkspaceSecurity] real path differs (same verdict): "${resolvedPath}" → "${realPath}"`,
				);
			}
			resolvedPath = realPath;
			isAllowed = recheck.isAllowed;
			normalizedRoots = recheck.normalizedRoots;
		}
	}

	// ── 「合法但可疑」软告警（2026-09-07，借鉴 Hermes-Agent `_path_resolution_warning`）──
	// 场景：相对路径（如 `../other/x` 或模型少写了一级目录）被解析到**所有允许根之外**。
	// 读操作（checkSandbox=false）不判沙箱 → 这类越界会**静默读到工作区外**，日志里
	// 完全无痕，排障时只能看到"读到了奇怪的文件"。Hermes 的做法是明确告警并提示
	// 传绝对路径。此处对齐：警告但不阻断（写操作仍走下方沙箱拒绝，行为不变）。
	if (!isAllowed && !/^[a-zA-Z]:[\\/]/.test(requestedPath) && !requestedPath.startsWith('/')) {
		logService.warn(
			`[WorkspaceSecurity] relative path "${requestedPath}" resolved to "${resolvedPath}", which is OUTSIDE ` +
			`every allowed root (${normalizedRoots.join(' | ')}). The operation will target a directory different ` +
			`from the workspace — if unintended (e.g. a git-worktree session writing into the main checkout), ` +
			`pass an absolute path under the intended root instead.`,
		);
	}

	// 计算建议路径（2026-09-07 重写，见 computeSuggestedPath）：仅当能定位到
	// 允许根内真实存在的文件时才建议（建议 = 真实路径）；否则 undefined。
	const requestedBase = (requestedPath.split(/[\\/]/).pop() || 'file')
		.replace(/[<>:"/\\|?*]/g, '_');
	const candidateRoots = allowedRoots.filter(r => {
		const normalized = r.replace(/\\/g, '/').toLowerCase();
		// Exclude legacy ~/.saros and the app data root (~/.vssaros) as suggestion targets
		return !normalized.includes(`/${LEGACY_SAROS_DIR}`) && !normalized.endsWith('/.vssaros') && !normalized.endsWith('/.vssaros-dev');
	});
	const suggestedPath = fileService && candidateRoots.length > 0
		? await computeSuggestedPath(fileService, requestedPath, candidateRoots)
		: undefined;

	// P2 自动放行的候选根（2026-09-07 二次收紧）：**排除 worktree 根**。
	// worktree 是主仓的另一份 checkout，同结构文件在两边都存在 → 结构修复的
	// exists 验证无法区分，静默把编辑重定向到「存在但不是用户想改的那一份」
	// 是真实误伤。worktree 场景仍可通过 suggestedPath + 确认卡片让用户显式选择
	//（有人看着），只是不再无声自动放行。
	const autoRepairRoots = worktreeRoot
		? candidateRoots.filter(r => r.replace(/\\/g, '/').toLowerCase() !== worktreeRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())
		: candidateRoots;

	// 仅写/删操作触发沙箱判定，读操作直接返回已解析路径
	if (checkSandbox && !isAllowed) {
		// ── P2 容错解析前置（2026-09-07，拒绝变自愈）────────────────────
		// 抛错前先尝试结构修复：路径幻觉（前缀重复等）若修复后落在允许根内且
		// 文件真实存在，直接放行——省一整轮「拒绝→读建议→重试」往返。
		// 安全边界见 structuralRepairOutOfRootPath（仅修前缀 + exists 硬验证 +
		// basename 不变，写新文件场景天然不触发）。修复全程 warn 留痕（透明）。
		if (fileService && autoRepairRoots.length > 0) {
			const repaired = await structuralRepairOutOfRootPath(fileService, requestedPath, autoRepairRoots);
			if (repaired) {
				// ★★ 2026-09-13：自愈结果是本函数的**第二条出口**，必须过同一套符号链接判定。
				//
				// 自愈的验证用 `fileService.exists`，而 `exists` **会跟随 symlink**
				// （`<ws>/link -> ~/.ssh` 下 `link/id_rsa` 判为存在）→ 若这条出口不解析真实路径，
				// 就等于从它绕过上面刚加的 symlink 防护（「另一条出口没挂检查」是今日最高频的成因）。
				const realpath = (u: URI) => fileService.realpath(u);
				if (await realPathAllowedWithinRoots(realpath, repaired, allowedRoots)) {
					const repairedReal = await realPathBestEffort(realpath, repaired);
					logService.warn(
						`[WorkspaceSecurity] path auto-corrected (out-of-root hallucination, structural repair): ` +
						`"${requestedPath}" → "${repairedReal}"`,
					);
					return repairedReal;
				}
				logService.warn(
					`[WorkspaceSecurity] structural repair REJECTED (real path escapes allowed roots): ` +
					`"${requestedPath}" → "${repaired}"`,
				);
				// 不接受自愈 → 落到下方正常拒绝流程（抛 SandboxViolationError）
			}
		}
		const allowedList = normalizedRoots.length > 0
			? normalizedRoots.map(r => `  - ${r}`).join('\n')
			: '  (无 — 请确认已正确配置工作区)';
		// 2026-09-07：建议/引导拼进消息（同时给用户与模型）。建议路径已验证真实
		// 存在（「改用建议路径」按钮依赖它）；无建议时给可执行的纠错反馈——
		// 引导 search_files 定位（对齐范式），杜绝「basename 重定向」式有损建议。
		const suggestionLine = suggestedPath
			? `\n已定位到可能的目标文件（已验证真实存在）：${suggestedPath}`
			: `\n未能定位该文件的真实位置（可能是路径拼写错误）。请用 search_files 以 filePattern "**/${requestedBase}" 查找真实绝对路径后重试，不要凭记忆拼接路径。`;
		const baseMessage = worktreeRoot
			? `安全沙箱限制：该 Agent 实例已绑定 worktree。\n` +
				`路径 "${requestedPath}" (解析后: "${resolvedPath}") 超出了允许范围。\n` +
				`当前允许的目录：\n${allowedList}\n` +
				`请在上述目录内操作。如需写入其它目录，可在确认卡片中选择「允许本次」/「允许此工作区」，或解除该 Agent 的 worktree 绑定。` +
				suggestionLine
			: `安全沙箱限制：路径 "${requestedPath}" (解析后: "${resolvedPath}") 不在允许的工作区目录内。\n` +
				`当前允许的工作区目录：\n${allowedList}\n` +
				`请在上述目录内操作，或在 Saros 工作区设置中配置正确的路径。` +
				suggestionLine;
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
