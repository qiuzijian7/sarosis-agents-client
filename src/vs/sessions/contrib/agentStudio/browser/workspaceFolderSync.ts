/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { IWorkspaceEditingService } from '../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export type WorkspaceFolderDescriptor = { uri: URI; name: string };

/**
 * Union two folder sets: `primary` first (its order is preserved), then any
 * member of `secondary` that is not already present.
 *
 * `keyOf` collapses the different spellings of one path (`.` vs `./` vs
 * absolute, case differences) — callers pass the URI identity service's
 * comparison key so `.code-workspace` entries and Agent Studio roots dedupe to
 * a single folder.
 */
export function unionWorkspaceFolders(
	primary: readonly WorkspaceFolderDescriptor[],
	secondary: readonly WorkspaceFolderDescriptor[],
	keyOf: (uri: URI) => string,
): WorkspaceFolderDescriptor[] {
	const result: WorkspaceFolderDescriptor[] = [];
	const seen = new Set<string>();

	const push = (folder: WorkspaceFolderDescriptor) => {
		const key = keyOf(folder.uri);
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		result.push(folder);
	};

	for (const folder of primary) {
		push(folder);
	}
	for (const folder of secondary) {
		push(folder);
	}

	return result;
}

/**
 * Decide the folder set a sync should apply.
 *
 * ★ 兜底 `agent-sessions.code-workspace` → **替换**：只保留当前活动工作区的 roots。
 *   它一个人服务多个工作区，并上历史 folder 就等于把上一个工作区的 root 带给下一个
 *   工作区（互相污染，且会被写盘、跨重启累积）。
 *
 * 用户自带的 `.code-workspace` → **并集**：它声明的 folders 是权威集合，Agent Studio
 * 的 roots 只能追加、不能替换（`declaredFolders` 在前以保持用户手写的顺序）。
 *
 * 纯函数：不碰服务、不做 I/O，方便直接单测这条产品规则。
 */
export function resolveSyncWorkspaceFolders(
	isFallbackWorkspaceFile: boolean,
	targets: readonly WorkspaceFolderDescriptor[],
	declaredFolders: readonly WorkspaceFolderDescriptor[],
	currentFolders: readonly WorkspaceFolderDescriptor[],
	keyOf: (uri: URI) => string,
): WorkspaceFolderDescriptor[] {
	if (isFallbackWorkspaceFile) {
		return [...targets];
	}
	return unionWorkspaceFolders([...declaredFolders, ...currentFolders], targets, keyOf);
}

/**
 * Synchronizes native VS Code workspace folders (driving the built-in Explorer
 * view) whenever the Agent Studio active workspace changes.
 *
 * This is the central bridge between the Agent Studio workspace concept and the
 * VS Code native file explorer. When the user switches workspaces via the
 * sidebar selector or programmatic {@link IAgentStudioService.setActiveWorkspace},
 * this contribution resolves the workspace's filesystem roots (home directory,
 * related folders, worktree path) and updates {@link IWorkspaceContextService}
 * folders via {@link IWorkspaceEditingService}. The native Explorer view
 * auto-refreshes in response.
 *
 * This is independent of the Source Control workspace sync — it runs regardless
 * of whether SCM is enabled or initialized.
 */
export class WorkspaceFolderSyncContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.agentStudio.workspaceFolderSync';

	constructor(
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const initialCtxFolders = this.workspaceContextService.getWorkspace().folders;
		this.logService.info(
			`[WorkspaceFolderSync] contribution constructed | ` +
			`inMemoryActiveId=${this.agentStudioService.getActiveWorkspaceId() ?? 'undefined'} | ` +
			`initialContextFolderCount=${initialCtxFolders.length}`,
		);
		for (let i = 0; i < initialCtxFolders.length; i++) {
			this.logService.info(`[WorkspaceFolderSync]   initialCtxFolder[${i}] = ${initialCtxFolders[i].uri.fsPath}`);
		}

		// Trace raw workspace context changes so we can see exactly when
		// the native folders mutate.
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(e => {
			this.logService.info(
				`[WorkspaceFolderSync] onDidChangeWorkspaceFolders | ` +
				`added=${e.added.length} removed=${e.removed.length}`,
			);
		}));

		// Sync on every active workspace switch
		this._register(this.agentStudioService.onDidChangeActiveWorkspace((workspaceId: string | undefined) => {
			this.logService.info(`[WorkspaceFolderSync] onDidChangeActiveWorkspace fired | workspaceId=${workspaceId}`);
			void this._syncWorkspaceFolder(workspaceId);
		}));

		// Startup restore: the active workspace is normally set lazily by the
		// webview on first load, but if the user opens the workspace tab
		// BEFORE the webview loads (e.g. directly via the activity bar) the
		// native Explorer has no folders to show. Trigger resolution eagerly
		// here so the Explorer can pick up the last-active workspace as
		// soon as the contribution starts.
		this._restoreActiveWorkspaceOnStartup();
	}

	/**
	 * Resolve and activate the default workspace at startup if no workspace
	 * is currently active. This ensures the native Explorer has workspace
	 * folders to display as soon as the user opens the workspace tab,
	 * independent of webview load timing.
	 */
	private _restoreActiveWorkspaceOnStartup(): void {
		// If an active workspace is already in memory, just sync it.
		const currentId = this.agentStudioService.getActiveWorkspaceId();
		if (currentId) {
			this.logService.info(`[WorkspaceFolderSync] startup: in-memory active workspace → direct sync: ${currentId}`);
			void this._syncWorkspaceFolder(currentId);
			return;
		}

		// No active workspace yet — resolve the default and activate it.
		// setActiveWorkspace() will fire onDidChangeActiveWorkspace, which is
		// caught by our listener above and triggers _syncWorkspaceFolder.
		this.logService.info('[WorkspaceFolderSync] startup: no active workspace in memory, calling resolveDefaultActiveWorkspaceId()');
		this.agentStudioService.resolveDefaultActiveWorkspaceId()
			.then(defaultId => {
				this.logService.info(`[WorkspaceFolderSync] startup: resolveDefaultActiveWorkspaceId() returned: ${defaultId ?? 'null'}`);
				if (defaultId) {
					this.logService.info(`[WorkspaceFolderSync] startup: calling setActiveWorkspace(${defaultId})`);
					return this.agentStudioService.setActiveWorkspace(defaultId).then(() => {
						this.logService.info(`[WorkspaceFolderSync] startup: setActiveWorkspace(${defaultId}) resolved`);
					});
				}
				this.logService.info('[WorkspaceFolderSync] startup: no default workspace to restore');
				return undefined;
			})
			.catch(err => {
				this.logService.error('[WorkspaceFolderSync] startup: failed to restore default workspace:', err);
			});
	}

	/**
	 * Resolve the active workspace's filesystem roots and update the VS Code
	 * native workspace folders. The native Explorer picks up the change
	 * automatically via {@link IWorkspaceContextService.onDidChangeWorkspaceFolders}.
	 */
	private async _syncWorkspaceFolder(workspaceId: string | undefined): Promise<void> {
		this.logService.info(`[WorkspaceFolderSync] _syncWorkspaceFolder START | workspaceId=${workspaceId ?? 'undefined'}`);

		if (!workspaceId) {
			// No active workspace — clear all folders so the Explorer shows empty state
			const currentFolders = this.workspaceContextService.getWorkspace().folders;
			this.logService.info(`[WorkspaceFolderSync] no active workspace, currentFolderCount=${currentFolders.length}`);
			if (currentFolders.length > 0) {
				const uris = currentFolders.map(f => f.uri);
				try {
					await this.workspaceEditingService.removeFolders(uris, true);
					this.logService.info(`[WorkspaceFolderSync] removed ${uris.length} folders`);
				} catch (err) {
					this.logService.error('[WorkspaceFolderSync] Failed to clear folders:', err);
				}
			}
			return;
		}

		let workspace;
		try {
			workspace = await this.agentStudioService.getWorkspace(workspaceId);
		} catch (err) {
			this.logService.error(`[WorkspaceFolderSync] getWorkspace(${workspaceId}) threw:`, err);
			return;
		}
		if (!workspace) {
			this.logService.warn(`[WorkspaceFolderSync] Workspace not found: ${workspaceId}`);
			return;
		}
		this.logService.info(
			`[WorkspaceFolderSync] loaded workspace "${workspace.name}" | ` +
			`path=${workspace.path ?? '<none>'} | ` +
			`relatedFolders=${(workspace.relatedFolders ?? []).length} | ` +
			`worktreePath=${workspace.worktreePath ?? '<none>'}`,
		);

		// Build the target root set: home dir + related folders + worktree path
		const targets: { uri: URI; name: string }[] = [];
		const seen = new Set<string>();

		const pushTarget = (rawPath: string, name: string) => {
			const norm = rawPath.replace(/[\\/]+$/, '').toLowerCase();
			if (!norm || seen.has(norm)) {
				return;
			}
			seen.add(norm);
			targets.push({ uri: URI.file(rawPath), name });
		};

		// Home directory (workspace.path)
		if (workspace.path) {
			pushTarget(workspace.path, workspace.name || this.uriIdentityService.extUri.basenameOrAuthority(URI.file(workspace.path)));
		}

		// Related code repositories
		for (const rf of workspace.relatedFolders ?? []) {
			if (rf?.path) {
				pushTarget(rf.path, rf.name || this.uriIdentityService.extUri.basenameOrAuthority(URI.file(rf.path)));
			}
		}

		// Worktree path (if assigned)
		if (workspace.worktreePath) {
			pushTarget(workspace.worktreePath, workspace.worktreeBranch || 'worktree');
		}

		this.logService.info(`[WorkspaceFolderSync] built ${targets.length} target roots:`);
		for (let i = 0; i < targets.length; i++) {
			this.logService.info(`[WorkspaceFolderSync]   target[${i}] = ${targets[i].uri.fsPath} (name="${targets[i].name}")`);
		}

		if (targets.length === 0) {
			this.logService.info(`[WorkspaceFolderSync] No filesystem roots for workspace: ${workspaceId}`);
			return;
		}

		// Trust all workspace roots before injecting them as folders.
		// This ensures file operations (git, explorer context menus, etc.) work
		// without triggering trust dialogs.
		try {
			const urisToTrust = targets
				.map(t => t.uri)
				.filter(uri => !this._isUriTrusted(uri));
			this.logService.info(`[WorkspaceFolderSync] ${urisToTrust.length}/${targets.length} URIs need trust`);
			if (urisToTrust.length > 0) {
				await this.workspaceTrustManagementService.setUrisTrust(urisToTrust, true);
				this.logService.info(`[WorkspaceFolderSync] setUrisTrust OK for ${urisToTrust.length} URIs`);
			}
		} catch (err) {
			this.logService.warn('[WorkspaceFolderSync] Failed to mark workspace roots as trusted:', err);
		}

		// ── Folders declared by the workspace file are authoritative ─────────
		// The user may hand-author a multi-root `.code-workspace` file with more
		// folders than the Agent Studio workspace model knows about (the model
		// only tracks `path` + `relatedFolders`). Replacing the folder list with
		// the Agent Studio roots alone would silently drop those extra roots, so
		// we UNION the two sets, keeping the file's folders first (stable order)
		// and appending any Agent Studio roots the file does not already cover.
		//
		// Order matters: build the union BEFORE touching the file, otherwise the
		// persist would clobber the very folders we are about to merge in. The
		// in-memory context folders plus the file-declared folders are both read
		// here, then a single persist writes the complete union back.
		const currentFolders = this.workspaceContextService.getWorkspace().folders;
		const declaredFolders = await this._readDeclaredFolders();

		// A user-supplied `.code-workspace` declares the workspace. If it lists
		// folders at all, that list IS the workspace and must not be narrowed to
		// whatever the Agent Studio model happens to know about — the extra roots
		// (`../Saros-agents-pocket`, `../saros-marketplace`, …) would vanish from
		// the Explorer. The sync then only ensures the active workspace's own root
		// is present, leaving every other declared folder untouched.
		const isUserSuppliedFile = this._isUserSuppliedWorkspaceFile();
		if (isUserSuppliedFile && declaredFolders.length > 0) {
			const unionTargets = this._unionWithDeclaredFolders(targets, declaredFolders);
			this.logService.info(
				`[WorkspaceFolderSync] user-supplied workspace file declares ${declaredFolders.length} folder(s); ` +
				`treating them as authoritative | agentStudioTargets=${targets.length} → union=${unionTargets.length}`,
			);

			const sameAsCurrent = currentFolders.length === unionTargets.length &&
				currentFolders.every((cf, i) => this.uriIdentityService.extUri.isEqual(cf.uri, unionTargets[i].uri));
			if (sameAsCurrent) {
				this.logService.info('[WorkspaceFolderSync] folders already match declared set, skipping apply');
				return;
			}

			const declaredFolderData = unionTargets.map(t => ({ uri: t.uri, name: t.name }));
			try {
				if (currentFolders.length === 0) {
					await this.workspaceEditingService.addFolders(declaredFolderData, true);
				} else {
					await this.workspaceEditingService.updateFolders(0, currentFolders.length, declaredFolderData, true);
				}
				this.logService.info(
					`[WorkspaceFolderSync] applied declared folders | before=${currentFolders.length} → after=${this.workspaceContextService.getWorkspace().folders.length}`,
				);
			} catch (err) {
				this.logService.error('[WorkspaceFolderSync] Failed to apply declared folders:', err);
			}
			return;
		}

		// ★ 兜底工作区文件一律「替换」，绝不「并集」—— 否则不同的工作区会互相污染。
		//
		// `agent-sessions.code-workspace` 由本窗口独占管理，不是用户资产。若沿用并集，
		// 从工作区 A 切到 B 时，A 的 root 会经由 `declaredFolders`（上次写盘的）与
		// `currentFolders`（内存里的）被带回来，再被写回磁盘 → **跨工作区污染且跨重启累积**。
		// 实测后果：一个与当前工作区毫无关系的 UE5EA（87.6 万节点图谱）被一起加载并起
		// watcher，renderer 堆到 2.6GB 后 UI 卡死。
		//
		// 用户自带的 `.code-workspace` 不受此约束（见上方早返回分支）：它只被读取，
		// 且它声明的 folders 是权威集合，只允许并入、不允许替换。
		const isFallbackFile = !isUserSuppliedFile;
		const unionTargets = resolveSyncWorkspaceFolders(
			isFallbackFile,
			targets,
			declaredFolders,
			currentFolders,
			uri => this.uriIdentityService.extUri.getComparisonKey(uri),
		);
		this.logService.info(
			`[WorkspaceFolderSync] ${isFallbackFile ? 'replace' : 'union'}: agentStudioTargets=${targets.length} ` +
			`declaredFolders=${declaredFolders.length} contextFolders=${currentFolders.length} → result=${unionTargets.length}`,
		);

		if (isFallbackFile) {
			// 兜底文件始终保持 `{"folders": []}`：它唯一的用途是给窗口一个 configPath，
			// folder 列表的真源是 Agent Studio 的 workspace 模型，不落这个盘。
			await this._ensureFallbackWorkspaceFileEmpty();
		}

		// Skip if already matching (same URIs in same order)
		const sameAsCurrent = currentFolders.length === unionTargets.length &&
			currentFolders.every((cf, i) => this.uriIdentityService.extUri.isEqual(cf.uri, unionTargets[i].uri));
		if (sameAsCurrent) {
			this.logService.info('[WorkspaceFolderSync] folders already match targets, skipping apply');
			return;
		}

		const targetFolderData = unionTargets.map(t => ({ uri: t.uri, name: t.name }));

		try {
			if (currentFolders.length === 0) {
				this.logService.info(`[WorkspaceFolderSync] addFolders(${targetFolderData.length})`);
				await this.workspaceEditingService.addFolders(targetFolderData, true);
			} else {
				this.logService.info(
					`[WorkspaceFolderSync] updateFolders(idx=0, deleteCount=${currentFolders.length}, addCount=${targetFolderData.length})`,
				);
				await this.workspaceEditingService.updateFolders(0, currentFolders.length, targetFolderData, true);
			}
			const after = this.workspaceContextService.getWorkspace().folders;
			this.logService.info(
				`[WorkspaceFolderSync] sync SUCCEEDED for workspace "${workspace.name}" | ` +
				`folderCountBefore=${currentFolders.length} → after=${after.length}`,
			);
		} catch (err) {
			this.logService.error('[WorkspaceFolderSync] Failed to sync workspace folders:', err);
		}
	}

	/**
	 * The `.code-workspace` file this window actually opened.
	 *
	 * Must NOT be confused with `environmentService.agentSessionsWorkspace`, which
	 * is only the *fallback* file used when no workspace was requested. Once a
	 * user opens their own `.code-workspace`, the two diverge, and reading or
	 * writing the fallback would silently ignore (or clobber) the user's file.
	 */
	private _resolveActiveWorkspaceFile(): URI | undefined {
		const configuration = this.workspaceContextService.getWorkspace().configuration;
		if (configuration) {
			return configuration;
		}
		return this.environmentService.agentSessionsWorkspace;
	}

	/**
	 * Whether the window is backed by the built-in fallback workspace file rather
	 * than a user-supplied `.code-workspace`.
	 *
	 * User files are treated as read-only sources of truth: we read their declared
	 * folders so they win in the union, but never write back to them.
	 */
	private _isUserSuppliedWorkspaceFile(): boolean {
		const workspaceFile = this._resolveActiveWorkspaceFile();
		if (!workspaceFile) {
			return false;
		}
		return !this._isFallbackWorkspaceFile(workspaceFile);
	}

	private _isFallbackWorkspaceFile(workspaceFile: URI): boolean {
		const fallback = this.environmentService.agentSessionsWorkspace;
		if (!fallback) {
			return false;
		}
		return this.uriIdentityService.extUri.isEqual(fallback, workspaceFile);
	}

	/**
	 * Normalize the *fallback* `agent-sessions.code-workspace` back to an empty
	 * folder list.
	 *
	 * ★ 该文件**不应**持有 folders：它由本窗口独占管理，而窗口可能先后承载不同的
	 * Agent Studio 工作区。一旦把 folder 写进去，切换工作区时旧 root 就会被读回来
	 * 并参与并集 → **工作区之间互相污染**（详见 `_syncWorkspaceFolder` 的说明）。
	 * folder 列表的真源是 Agent Studio 的 workspace 模型，不落这个盘。
	 *
	 * 用户自带的 `.code-workspace` 永远不被写：它是用户资产、权威定义，同步对它
	 * 只读。写入前先比对，避免无谓的磁盘写入与 watcher 风暴。
	 */
	private async _ensureFallbackWorkspaceFileEmpty(): Promise<void> {
		const workspaceFile = this.environmentService.agentSessionsWorkspace;
		if (!workspaceFile) {
			return;
		}

		// Defensive: never touch a user-supplied workspace file.
		if (!this._isFallbackWorkspaceFile(workspaceFile)) {
			return;
		}

		const content = VSBuffer.fromString(JSON.stringify({ folders: [] }, null, '\t'));

		try {
			const existing = await this._readExistingWorkspaceFile(workspaceFile);
			if (existing && this._hasSameFolders(existing.folders, [])) {
				return;
			}
			await this.fileService.writeFile(workspaceFile, content);
			this.logService.info(`[WorkspaceFolderSync] normalized fallback workspace file to empty folders: ${workspaceFile.fsPath}`);
		} catch (err) {
			// A failure here must never break the in-memory folder sync.
			this.logService.warn('[WorkspaceFolderSync] Failed to normalize fallback workspace file:', err);
		}
	}

	private async _readExistingWorkspaceFile(workspaceFile: URI): Promise<{ folders?: { name?: string; path?: string }[] } | undefined> {
		try {
			if (!await this.fileService.exists(workspaceFile)) {
				return undefined;
			}
			const fileContent = await this.fileService.readFile(workspaceFile);
			return JSON.parse(fileContent.value.toString()) as { folders?: { name?: string; path?: string }[] };
		} catch {
			return undefined;
		}
	}

	/**
	 * Read the folders declared by the backing `.code-workspace` file on disk and
	 * resolve each to a concrete URI.
	 *
	 * Relative paths are resolved against the workspace file's own directory
	 * (mirroring `toWorkspaceFolders`), so a hand-written entry like `../repo`
	 * lands on the same absolute root VS Code would compute.
	 */
	private async _readDeclaredFolders(): Promise<{ uri: URI; name: string }[]> {
		const workspaceFile = this._resolveActiveWorkspaceFile();
		if (!workspaceFile) {
			return [];
		}

		const existing = await this._readExistingWorkspaceFile(workspaceFile);
		if (!existing?.folders?.length) {
			return [];
		}

		const workspaceDir = this.uriIdentityService.extUri.dirname(workspaceFile);
		const result: { uri: URI; name: string }[] = [];

		for (const entry of existing.folders) {
			if (!entry?.path) {
				continue;
			}
			const uri = this.uriIdentityService.extUri.resolvePath(workspaceDir, entry.path);
			const name = entry.name || this.uriIdentityService.extUri.basenameOrAuthority(uri);
			result.push({ uri, name });
		}

		return result;
	}

	private _hasSameFolders(
		a: readonly { name?: string; path?: string }[] | undefined,
		b: readonly { name?: string; path?: string }[],
	): boolean {
		if (!a || a.length !== b.length) {
			return false;
		}
		return a.every((entry, i) => entry.path === b[i].path && entry.name === b[i].name);
	}

	/**
	 * Union the Agent Studio workspace roots with the folders already declared
	 * by the workspace file.
	 *
	 * The declared folders come first so the user-authored ordering (and any
	 * extra roots the Agent Studio model does not track) is preserved; Agent
	 * Studio roots not already present are appended. Comparison is by resolved
	 * URI so `.` vs `./` vs absolute spellings collapse to one entry.
	 */
	private _unionWithDeclaredFolders(
		agentStudioTargets: readonly { uri: URI; name: string }[],
		declaredFolders: readonly { uri: URI; name: string }[],
	): { uri: URI; name: string }[] {
		return unionWorkspaceFolders(
			declaredFolders,
			agentStudioTargets,
			uri => this.uriIdentityService.extUri.getComparisonKey(uri),
		);
	}

	private _isUriTrusted(uri: URI): boolean {
		return this.workspaceTrustManagementService.getTrustedUris().some(
			trustedUri => this.uriIdentityService.extUri.isEqual(trustedUri, uri)
		);
	}
}
