/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Centralized path resolution for Saros Agent Studio user data.
 *
 * All Agent Studio data lives directly under the VS Code user data directory
 * (`.vssaros/` or `.vssaros-dev/` in dev mode) — no `saros/` subdirectory.
 *
 * Previously, data lived under `~/.saros/` (user home). This module provides
 * helpers to resolve both new and legacy paths for migration.
 */

import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { ILogService } from '../../../../platform/log/common/log.js';

// ─── Directory name constants ────────────────────────────────────────────────

/** Legacy data directory name (was `~/.saros/` before migration). */
export const LEGACY_SAROS_DIR = '.saros';

// ─── Well-known sub-paths ────────────────────────────────────────────────────

export const SarosPath = {
	/** Agent definitions: `{root}/agents/` */
	agents: 'agents',
	/** Skills: `{root}/skills/` */
	skills: 'skills',
	/** MCP server installations: `{root}/mcp/` */
	mcp: 'mcp',
	/** User-level MCP configuration file: `{root}/mcp.json` */
	mcpConfig: 'mcp.json',
	/** Agent memory (short-term / long-term): `{root}/memory/` */
	memory: 'memory',
	/** Knowledge base vaults: `{root}/knowledge-base/` */
	knowledgeBase: 'knowledge-base',
	/** Workflow backups: `{root}/workflows/` */
	workflows: 'workflows',
	/** Dashboard database and stats: `{root}/dashboard/` */
	dashboard: 'dashboard',
	/** Self-evolution records: `{root}/evolution/` */
	evolution: 'evolution',
	/** Installed package manifest: `{root}/installed-packages.json` */
	installedPackages: 'installed-packages.json',
	/** TOF authentication ticket: `{root}/auth.json` */
	auth: 'auth.json',
	/** Temporary files: `{root}/tmp/` */
	tmp: 'tmp',
	/** Custom agents from marketplace: `{root}/agents/custom/` */
	customAgents: 'agents/custom',
	/** Context persistence (snapshots, summaries, templates): `{root}/context-storage/` */
	contextStorage: 'context-storage',
	/** Pending plan approval records (durable across window refreshes): `{root}/pending-approvals/` */
	pendingApprovals: 'pending-approvals',
	/**
	 * Tool allow-list（「始终允许 / 在工作区允许」的记忆）: `{root}/tool-allow.json`。
	 *
	 * ⚠ 为什么必须放这里（2026-09-13）：本项目**所有**数据都放 `.vssaros/`，不写 `.vscode/`
	 * （那是 VS Code 自己的配置目录）。此前它经 `ConfigurationTarget.WORKSPACE` 落到
	 * `<workspace>/.vscode/settings.json` —— ① 违反本约定；② 该文件在**工作区内、模型可写**
	 * → 「被约束者可以改写约束」（给自己授权）。`.vssaros/` 已被 `writeDenyList` 硬拒。
	 */
	toolAllow: 'tool-allow.json',
} as const;

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a Saros data path from the VS Code user data root directory.
 *
 * The `userDataRoot` is the `.vssaros/` (or `.vssaros-dev/`) directory.
 * In the native process, this is `INativeEnvironmentService.userDataPath`.
 * In the browser renderer, this is the parent of `IWorkbenchEnvironmentService.userRoamingDataHome`.
 *
 * Agent Studio data lives directly under `.vssaros/`, not in a subdirectory.
 *
 * @param userDataRoot - The `.vssaros/` directory URI
 * @param segments - Sub-path segments to append (e.g., SarosPath.agents, 'my-agent')
 * @returns Full URI like `~/.vssaros/agents/my-agent/`
 *
 * @example
 * ```ts
 * const agentsDir = resolveSarosPath(userDataRoot, SarosPath.agents);
 * // → ~/.vssaros/agents/
 * const mcpConfig = resolveSarosPath(userDataRoot, SarosPath.mcpConfig);
 * // → ~/.vssaros/mcp.json
 * ```
 */
export function resolveSarosPath(userDataRoot: URI, ...segments: string[]): URI {
	return joinPath(userDataRoot, ...segments);
}

/**
 * Resolve a legacy Saros path from the user home directory.
 * Used ONLY for data migration from old `~/.saros/` to new `~/.vssaros/`.
 *
 * @param userHome - The user home directory URI
 * @param segments - Sub-path segments
 * @returns Legacy URI like `~/.saros/agents/`
 */
export function resolveLegacyPath(userHome: URI, ...segments: string[]): URI {
	return joinPath(userHome, LEGACY_SAROS_DIR, ...segments);
}

/**
 * Convenience: get the Saros data root from the VS Code user data root.
 * (No longer adds a `saros/` subdirectory — data lives directly under `.vssaros/`.)
 *
 * @example
 * ```ts
 * const sarosRoot = getSarosRoot(userDataRoot);
 * // → ~/.vssaros/
 * ```
 */
export function getSarosRoot(userDataRoot: URI): URI {
	return userDataRoot;
}

/**
 * Convenience: get the legacy root for existence checks during migration.
 *
 * @example
 * ```ts
 * const legacyRoot = getLegacyRoot(userHome);
 * // → ~/.saros/
 * ```
 */
export function getLegacyRoot(userHome: URI): URI {
	return joinPath(userHome, LEGACY_SAROS_DIR);
}

// ─── Root extraction helpers for common DI sources ───────────────────────────

/**
 * Extract the VS Code user data root from the browser renderer's
 * `IWorkbenchEnvironmentService.userRoamingDataHome`.
 *
 * `userRoamingDataHome` points to `~/.vssaros/User/` (vscode-userdata scheme).
 * Its parent is the `.vssaros/` directory we need as the root.
 */
export function userDataRootFromRoamingHome(userRoamingDataHome: URI): URI {
	return joinPath(userRoamingDataHome, '..');
}

/**
 * Extract the VS Code user data root from a native environment service's
 * `userDataPath` string.
 */
export function userDataRootFromPath(userDataPath: string): URI {
	return URI.file(userDataPath);
}

// ─── Agent Studio service data root（2026-09-20 统一） ────────────────────────

/**
 * Resolve the Agent Studio service data root directory.
 *
 * Single entry point for the service-level JSON stores (`taskboard.json`,
 * `boards.json`, `boardlinks.json`, `orchestration-plans.json`, `swarms.json`,
 * `delegations.json`, …).
 *
 * - `sessions.agentStudio.dataPath` set → that directory（自定义行为不变）。
 * - Otherwise the VS Code user data root（`~/.vssaros/`，dev 为 `~/.vssaros-dev/`），
 *   与 `AgentStudioService` 的 `workspaces.json` / `sessions.json` 同根
 *   ⇒ 天然获得 dev/prod 隔离。
 *
 * ⚠ 已废弃旧约定：`userHome + .agent-studio/data`（2026-09-20 用户指正）——
 * 它脱离 `.vssaros/` 根且 dev/prod 共用同一目录。新代码一律走本函数。
 */
export function resolveAgentStudioDataRoot(customPath: string | undefined, userRoamingDataHome: URI): URI {
	return customPath ? URI.file(customPath) : userDataRootFromRoamingHome(userRoamingDataHome);
}

/**
 * One-time best-effort migration of service data files from the legacy
 * `~/.agent-studio/data/` directory to the unified data root.
 *
 * Copies only when the target does not exist（绝不覆盖新数据），重跑天然幂等。
 * 仅在默认落盘根下调用（自定义 dataPath 时用户已显式指定目录，不做隐式迁移）。
 * Fire-and-forget 或 await 均可；错误只记日志。
 *
 * @param userHome - 用户主目录（`INativeEnvironmentService.userHome`）
 * @param targetRoot - 统一后的数据根（`resolveAgentStudioDataRoot` 的返回值）
 * @param entries - 旧数据目录下的文件/目录名（目录会递归复制）
 */
export async function migrateLegacyAgentStudioData(
	fileService: IFileService,
	logService: ILogService,
	userHome: URI,
	targetRoot: URI,
	entries: readonly string[],
): Promise<void> {
	try {
		const legacyDir = joinPath(userHome, '.agent-studio', 'data');
		if (!(await fileService.exists(legacyDir))) {
			return;
		}
		for (const entry of entries) {
			const from = joinPath(legacyDir, entry);
			const to = joinPath(targetRoot, entry);
			try {
				if (!(await fileService.exists(from)) || (await fileService.exists(to))) {
					continue;
				}
				await copyTree(fileService, from, to);
				logService.info(`[sarosPaths] Migrated legacy Agent Studio data '${entry}' (~/.agent-studio/data → ${targetRoot.path})`);
			} catch (err) {
				logService.warn(`[sarosPaths] Failed to migrate legacy data entry '${entry}': ${err}`);
			}
		}
	} catch (err) {
		logService.debug(`[sarosPaths] Legacy Agent Studio data dir not accessible: ${err}`);
	}
}

/** 跨 provider 安全的递归复制（read + write，经 fileService 总线，不用 provider 级 copy）。 */
async function copyTree(fileService: IFileService, from: URI, to: URI): Promise<void> {
	const stat = await fileService.resolve(from);
	if (stat.isDirectory) {
		if (!(await fileService.exists(to))) {
			await fileService.createFolder(to);
		}
		for (const child of stat.children ?? []) {
			await copyTree(fileService, child.resource, joinPath(to, child.name));
		}
	} else {
		const content = await fileService.readFile(from);
		await fileService.writeFile(to, content.value);
	}
}
