/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Centralized path resolution for Saros Agent Studio user data.
 *
 * All Agent Studio data now lives under the VS Code user data directory
 * (`.vssaros/` or `.vssaros-dev/` in dev mode) in a `saros/` subdirectory.
 *
 * Previously, data lived under `~/.saros/` (user home). This module provides
 * helpers to resolve both new and legacy paths for migration.
 */

import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';

// ─── Directory name constants ────────────────────────────────────────────────

/** Data directory name under the VS Code user data root (e.g., `.vssaros/saros/`). */
export const SAROS_DATA_DIR = 'saros';

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
