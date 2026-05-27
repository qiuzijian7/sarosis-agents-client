/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
// ─── Workspace Adapter (opencode-compatible) ──────────────────────────────────

export const IWorkspaceAdapterService = createDecorator<IWorkspaceAdapterService>('workspaceAdapterService');

/**
 * Information about a workspace that can be adapted for agent isolation.
 * Compatible with opencode's WorkspaceInfo pattern.
 */
export interface IWorkspaceInfo {
	/** Unique identifier */
	id: string;
	/** Workspace type (e.g. "worktree", "local", "remote") */
	type: string;
	/** Display name */
	name: string;
	/** Git branch name (if applicable) */
	branch?: string;
	/** File system directory path */
	directory?: string;
	/** Project ID (typically the git repository root) */
	projectID: string;
}

/**
 * Listed workspace info returned by the adapter's list() method.
 */
export interface IWorkspaceListedInfo {
	/** Workspace type */
	type: string;
	/** Display name */
	name: string;
	/** Git branch name */
	branch?: string;
	/** File system directory path */
	directory?: string;
	/** Project ID */
	projectID: string;
}

/**
 * Target information for a workspace (local directory or remote URL).
 */
export type IWorkspaceTarget =
	| { type: 'local'; directory: string }
	| { type: 'remote'; url: string };

/**
 * Context passed to adapter methods, carrying optional session information.
 */
export interface IWorkspaceAdapterContext {
	/** Associated session ID, if applicable */
	sessionId?: string;
}

/**
 * Service providing workspace adapter implementations for different
 * isolation strategies (worktree, local, remote).
 *
 * Compatible with opencode's WorkspaceAdapter pattern:
 *   configure() → compute workspace info
 *   create()    → materialize the workspace
 *   list()      → enumerate existing workspaces
 *   remove()    → tear down the workspace
 *   target()    → get the connection target
 */
export interface IWorkspaceAdapterService {
	readonly _serviceBrand: undefined;

	/**
	 * Configure workspace info for a given strategy.
	 * Does not create anything — only computes metadata.
	 */
	configure(
		info: IWorkspaceInfo,
		context?: IWorkspaceAdapterContext,
	): Promise<IWorkspaceInfo>;

	/**
	 * Materialize the workspace (create worktree, etc.).
	 */
	create(
		info: IWorkspaceInfo,
		context?: IWorkspaceAdapterContext,
	): Promise<void>;

	/**
	 * List existing workspaces for the current project.
	 */
	list(context?: IWorkspaceAdapterContext): Promise<IWorkspaceListedInfo[]>;

	/**
	 * Remove a workspace.
	 */
	remove(
		info: IWorkspaceInfo,
		context?: IWorkspaceAdapterContext,
	): Promise<void>;

	/**
	 * Get the target (local directory or remote URL) for a workspace.
	 */
	target(info: IWorkspaceInfo): IWorkspaceTarget;

	/**
	 * Reset a workspace to its default state.
	 */
	reset(
		info: IWorkspaceInfo,
		context?: IWorkspaceAdapterContext,
	): Promise<void>;
}
