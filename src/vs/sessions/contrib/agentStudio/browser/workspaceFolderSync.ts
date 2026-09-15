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
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	isProjectionUnchanged,
	matchWorkspaceIdentity,
	projectFoldersToRegistry,
	resolveSyncDirection,
	workspaceIdentityFromWindow,
	WORKSPACE_FOLDER_SYNC_DIRECTION_SETTING,
	type WorkspaceFolderSyncDirection,
} from '../common/workspaceFolderSyncPolicy.js';

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

	/**
	 * 反向投影的**重入锁** —— 写 registry 可能（经由其它监听者）间接引发 folder 事件，
	 * 没有它会自激循环。与 `isProjectionUnchanged` 的幂等比较是两道**互补**的闸门：
	 * 锁防「同一轮内递归」，幂等比较防「不同轮之间反复写同样的值」。
	 */
	private _projectingToRegistry = false;

	constructor(
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const initialCtxFolders = this.workspaceContextService.getWorkspace().folders;
		this.logService.info(
			`[WorkspaceFolderSync] contribution constructed | ` +
			`direction=${this._direction()} | ` +
			`inMemoryActiveId=${this.agentStudioService.getActiveWorkspaceId() ?? 'undefined'} | ` +
			`initialContextFolderCount=${initialCtxFolders.length}`,
		);
		for (let i = 0; i < initialCtxFolders.length; i++) {
			this.logService.info(`[WorkspaceFolderSync]   initialCtxFolder[${i}] = ${initialCtxFolders[i].uri.fsPath}`);
		}

		// Trace raw workspace context changes so we can see exactly when
		// the native folders mutate.
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(e => {
			// ★ 诊断：这是**原生 Explorer 唯一认的刷新触发点**。此事件不来 ⇒ sideview 必然不刷新。
			// 打出变更前后的完整 folder 列表，便于与 `[WorkspaceSwitch]` 行对照时间戳。
			const roots = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath);
			this.logService.info(
				`[WorkspaceFolderSync] onDidChangeWorkspaceFolders | ` +
				`added=${e.added.length} removed=${e.removed.length} | ` +
				`now folders=${roots.length} [${roots.join(' | ')}]`,
			);
			// ★ 方案 B' Step 1：窗口是真源 ⇒ folder 变化后写回 registry。
			void this._projectWindowFoldersToRegistry();
		}));

		// ★ 启动时也投影一次 —— 窗口打开 `.code-workspace` 时 folder 列表在
		// contribution 构造**之前**就已就绪（`SessionsWorkspaceContextService.initialize()` /
		// 标准 `WorkspaceService.initialize()` 都在服务图组装阶段完成），
		// 不会再触发 `onDidChangeWorkspaceFolders` ⇒ 只靠事件会漏掉「首次打开」。
		void this._projectWindowFoldersToRegistry();

		// Sync on every active workspace switch
		this._register(this.agentStudioService.onDidChangeActiveWorkspace((workspaceId: string | undefined) => {
			// ★ 诊断核心行：切换后**窗口 folder 是否随之变化**是 sideview 刷不刷新的唯一判据。
			// 若这里的 folders 列表与切换前完全一致 ⇒ 原生侧无变化可刷 ⇒ 问题在「切换入口
			// 没有真的换工作区」，而非 Explorer 的刷新逻辑。
			const ws = this.workspaceContextService.getWorkspace();
			const roots = ws.folders.map(f => f.uri.fsPath);
			this.logService.info(
				`[WorkspaceFolderSync] onDidChangeActiveWorkspace fired | workspaceId=${workspaceId} | ` +
				`window config=${ws.configuration?.fsPath ?? '<none>'} folders=${roots.length} [${roots.join(' | ')}] ` +
				`| direction=${this._direction()}`,
			);
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
	 * 当前的 folder 同步方向（每次读设置，便于运行时切换排障）。
	 * 判据是纯函数 `resolveSyncDirection`，非法值回落默认。
	 */
	private _direction(): WorkspaceFolderSyncDirection {
		return resolveSyncDirection(this.configurationService.getValue(WORKSPACE_FOLDER_SYNC_DIRECTION_SETTING));
	}

	/**
	 * ★★ 方案 B' Step 1 的核心：**窗口 → registry** 反向投影。
	 *
	 * 窗口当前的 folder 列表（由 `.code-workspace` / 打开的文件夹决定）是真源，
	 * 把它写回 Agent Studio 的工作区记录（`path` + `relatedFolders`）。
	 *
	 * ── 为什么这是"结构性"防污染 ─────────────────────────────────────
	 * 旧方向（registry → 窗口）必须靠 `replace` / `union` 分支判断「该不该保留现有 folder」，
	 * 判错就会把**别的工作区**的 root 带进来（实测事故：UE5EA 87.6 万节点图谱 →
	 * renderer 2.6GB 卡死）。反向之后**不存在** registry → 窗口的写路径，
	 * 所以污染在物理上不可能发生 —— 不再依赖任何分支判对。
	 *
	 * 三道闸门（缺一会写盘风暴 / 自激循环）：
	 *   ① 方向不是 `window-drives-registry` → 直接返回；
	 *   ② `_projectingToRegistry` 重入锁 —— 写 registry 可能间接触发 folder 事件；
	 *   ③ `isProjectionUnchanged` 幂等比较 —— 与现值一致则不写。
	 *
	 * 失败只 warn：它是「让 Agent Studio 跟上窗口」的便利同步，
	 * 绝不能影响窗口本身（folder 列表已经是对的）。
	 */
	private async _projectWindowFoldersToRegistry(): Promise<void> {
		if (this._direction() !== 'window-drives-registry') {
			return;
		}
		if (this._projectingToRegistry) {
			return;
		}

		this._projectingToRegistry = true;
		try {
			// ★★★ 2026-09-15：**读窗口状态的唯一入口**，写盘前必须再调一次。
			//
			// ── 为什么不能只在入口读一次（这是个真实的数据丢失事故）─────────────
			// 下面的 `ensureWorkspaceForWindow()` / `getWorkspace()` / `updateWorkspace()`
			// 全是**异步 I/O**，期间窗口 folder 完全可能变化 —— 而「启动补根」
			// （`sidebarPart._applyActiveWorkspaceRootsOnStartup()`）恰好就发生在这个窗口期。
			//
			// 实测（2026-09-15 12:21，用户报「工作区 sideview 未显示多根目录」）：
			//   ① 构造期调用本方法，入口读到的是**启动时的 1 根**快照；
			//   ② await 期间启动补根把窗口从 1 根扩成 3 根（`from=1 to=3` ✓）；
			//   ③ 本方法醒来后拿**过期快照**写盘 ⇒ 记录的 `relatedFolders` 被抹成 `[]`；
			//   ④ 重启后 `_resolveWorkspaceRoots()` 只解析出 1 个 root ⇒ 多根**永久丢失**。
			// 日志铁证：`reverse (window→registry) | relatedFolders=0` 紧跟
			// `onDidChangeWorkspaceFolders | now folders=3` 之后。
			//
			// 教训：**「读—await—写」之间必须重读，或带上版本校验**。
			// 单纯"入口读一次、结尾用同一个变量"在异步 I/O 面前等于用旧状态覆盖新状态。
			const readWindow = () => {
				const ws = this.workspaceContextService.getWorkspace();
				const folders = ws.folders;
				return {
					projection: projectFoldersToRegistry(folders.map(f => ({ fsPath: f.uri.fsPath, name: f.name }))),
					identity: workspaceIdentityFromWindow(ws.configuration?.fsPath, folders.map(f => f.uri.fsPath)),
				};
			};
			const first = readWindow();
			const { projection, identity } = first;

			// ★★ P0 收口点：先确保存在一条**身份与当前窗口一致**的记录。
			//
			// 为什么必须在取 `activeWorkspaceId` **之前**做：
			// 那个游标可能指向一条与当前窗口**无关**的记录（`resolveDefaultActiveWorkspaceId()`
			// 会兜底选「第一个有 path 的记录」）—— 而下面的身份守卫会把它拦掉 ⇒
			// 结果就是「记录永远不同步」（用户报的多根丢失、记录不更新）。
			// upsert 之后，「有没有记录」与「是不是这个窗口」变成同一个问题。
			const ensured = await this.agentStudioService.ensureWorkspaceForWindow(identity, projection);

			const workspaceId = ensured?.id ?? this.agentStudioService.getActiveWorkspaceId();
			if (!workspaceId) {
				// 空窗口且没有活动工作区 —— 没有可投影的东西（等用户打开工作区）。
				return;
			}

			const workspace = ensured ?? await this.agentStudioService.getWorkspace(workspaceId);
			if (!workspace) {
				this.logService.warn(`[WorkspaceFolderSync] reverse: workspace not found: ${workspaceId}`);
				return;
			}

			// 记录已确认与窗口一致，但 registry 游标可能还指着别处 ⇒ 对齐游标，
			// 否则下次启动 `resolveDefaultActiveWorkspaceId()` 的 in-memory 分支仍会拿到错的。
			if (ensured && this.agentStudioService.getActiveWorkspaceId() !== ensured.id) {
				await this.agentStudioService.setActiveWorkspace(ensured.id);
			}

			// ★★ 工作区身份守卫（2026-09-14 事故后新增；2026-09-15 P0 升级为**完整身份匹配**）。
			//
			// 只有当这条记录**确实就是当前窗口**时才允许投影 —— 判据见
			// {@link matchWorkspaceIdentity}：工作区文件 > 主 root > root 集合（顺序不敏感）。
			//
			// 为什么必需：`activeWorkspaceId` 只是 registry 里的一个游标，与「窗口打开的东西」
			// 没有强制对应（`resolveDefaultActiveWorkspaceId()` 会兜底选一条）。无守卫就会把
			// A 窗口的 folder 写进 B 工作区的 `relatedFolders`（09-14 实测：另一个工作区的
			// UE5EA 有 87.6 万节点，被写进来后 renderer 堆到 2.6GB 卡死）。
			//
			// ★ P0 升级点（**这是旧守卫的真 bug**）：旧版只比「窗口主 root == 记录 `path`」，
			// 当记录的 `path` 是 `.code-workspace` **文件**时二者永不相等 ⇒ 守卫**恒跳过** ⇒
			// 记录永远不同步、重启后多根丢失（用户报「多项目工作区只显示一个目录」的另一半原因）。
			// 现在走完整身份匹配，文件态 / 目录态两种记录都能对上。
			//
			// ★★★ 写盘前**重新读一次**窗口状态（原因见上方 `readWindow` 的说明）。
			// 这里之后的所有判断与写入都必须用 `fresh`，不得再用入口的 `projection` / `identity`。
			const fresh = readWindow();
			const rootsOf = (p: { readonly path: string | undefined; readonly relatedFolders: readonly unknown[] }) =>
				(p.path ? 1 : 0) + p.relatedFolders.length;
			if (fresh.projection.path !== first.projection.path
				|| rootsOf(fresh.projection) !== rootsOf(first.projection)) {
				// 这条日志本该在 2026-09-15 的事故里出现 —— 它一句话就能指出「快照过期」。
				this.logService.info(
					`[WorkspaceFolderSync] reverse: window changed during await — using FRESH snapshot | ` +
					`before=roots(${rootsOf(first.projection)}) after=roots(${rootsOf(fresh.projection)})`,
				);
			}

			// 跳过时**只记日志不报错** —— 投影是便利功能，绝不能影响窗口。
			const identityMatch = matchWorkspaceIdentity(workspace, fresh.identity);
			if (identityMatch === 'none') {
				this.logService.info(
					`[WorkspaceFolderSync] reverse skipped (identity mismatch) | ` +
					`windowFile=${fresh.identity.codeWorkspacePath ?? '<none>'} | ` +
					`windowRoots=${fresh.identity.folderPaths.length} [${fresh.identity.folderPaths.join(' | ')}] | ` +
					`registryId=${workspaceId} registryPath=${workspace.path ?? '<none>'}`,
				);
				return;
			}
			this.logService.info(`[WorkspaceFolderSync] reverse identity matched by ${identityMatch}`);

			if (isProjectionUnchanged(fresh.projection, workspace)) {
				return;
			}

			this.logService.info(
				`[WorkspaceFolderSync] reverse (window→registry) | workspaceId=${workspaceId} | ` +
				`path=${fresh.projection.path ?? '<none>'} | relatedFolders=${fresh.projection.relatedFolders.length}`,
			);

			// `RelatedFolder.addedAt` 是必填的 ISO 时间戳。**沿用既有条目的值**，
			// 只给新出现的 folder 打当前时间 —— 否则每次投影都会刷新全部时间戳，
			// 「何时关联」这个信息就永久丢失了（且会让 registry 的 diff 永远非空）。
			const existingAddedAt = new Map(
				(workspace.relatedFolders ?? []).map(f => [f.path.replace(/\\/g, '/').toLowerCase(), f.addedAt]),
			);
			const now = new Date().toISOString();
			await this.agentStudioService.updateWorkspace(workspaceId, {
				path: fresh.projection.path,
				relatedFolders: fresh.projection.relatedFolders.map(f => ({
					path: f.path,
					name: f.name,
					addedAt: existingAddedAt.get(f.path.replace(/\\/g, '/').toLowerCase()) ?? now,
				})),
			});
		} catch (err) {
			this.logService.warn('[WorkspaceFolderSync] reverse projection failed:', err);
		} finally {
			this._projectingToRegistry = false;
		}
	}

	/**
	 * Resolve the active workspace's filesystem roots and update the VS Code
	 * native workspace folders. The native Explorer picks up the change
	 * automatically via {@link IWorkspaceContextService.onDidChangeWorkspaceFolders}.
	 *
	 * ⚠ 这是**旧方向**（registry → 窗口）。方案 B' Step 1 起默认不再走这条路
	 * （见 `_direction()`）；保留它只为「设置切回 `registry-drives-window` 即可回滚」。
	 * 新逻辑请写在 `_projectWindowFoldersToRegistry()` 里。
	 */
	private async _syncWorkspaceFolder(workspaceId: string | undefined): Promise<void> {
		const direction = this._direction();
		if (direction !== 'registry-drives-window') {
			// 新方向下，切换活动工作区**既不改窗口 folder，也不投影回 registry**。
			//
			// ★★ 为什么不能在这里投影（2026-09-14 实测事故，务必保留此注释）：
			// 本方法由 `onDidChangeActiveWorkspace` 驱动 —— 此刻 `activeWorkspaceId` 已是**新**工作区，
			// 但窗口的 folder 列表仍是**上一个**工作区的内容（folder 变化要么不会发生，
			// 要么晚于本事件）。在这里投影 = 把「旧工作区的 root」写进「新工作区的记录」。
			// 实测日志：切到 `sarosis-agents-client-uf2z3` 的同一毫秒就写入了
			// `relatedFolders=4`（含另一个工作区的 S1Game / UE5EA）—— registry 被跨工作区污染。
			//
			// 正确时机只有两个（见构造函数）：① 窗口启动后一次；② `onDidChangeWorkspaceFolders`
			// —— 即「用户真的改了 folder」。切换工作区**不属于**这两者。
			this.logService.info(
				`[WorkspaceFolderSync] _syncWorkspaceFolder skipped (direction=${direction}) | workspaceId=${workspaceId ?? 'undefined'}`,
			);
			return;
		}

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
