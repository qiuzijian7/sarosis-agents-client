/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Queue } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { folderListsMatch, mergeWorkspaceFolders } from '../../sourceControl/common/workspaceFolderMerge.js';
import { IFolderRequest, IWorkspaceFolderRouter } from '../common/workspaceFolderRouter.js';

/**
 * [Saros] {@link IWorkspaceFolderRouter} 的实现 —— folder 列表的**唯一写入者**。
 *
 * 设计要点（每条都对应一个实测过的故障）：
 *
 * 1. **串行化**（`Queue`）：多个调用方可能在同一 tick 内请求（会话切换 + SCM 同步 +
 *    反向投影）。并发调用 `updateFolders` 会以「读到的旧列表」为基准互相覆盖 ——
 *    这正是 4 写入者时代最难查的一类丢 folder。
 *
 * 2. **追加式合并**（`mergeWorkspaceFolders`）：现有 folder 保位、缺失的 target 追加。
 *    从语义上不可能把多根裁成单根（旧代码用 `updateFolders(0, 全部, [...])` 就会）。
 *
 * 3. **幂等**（`folderListsMatch`）：已在场则不写。folder 变更会触发 git 扩展重扫每个
 *    root，冗余写入代价很高。
 *
 * 4. **`releaseFolders` 只放自己注入的**：在工作区文件 `folders[]` 里声明的 root
 *    永不自动移除 —— 那是用户资产。判据是 `_declaredFolderKeys()`（读 configuration 文件
 *    声明集的**当前内存投影**：`workspace.folders` 中来自文件的部分）。
 */
export class WorkspaceFolderRouter extends Disposable implements IWorkspaceFolderRouter {

	declare readonly _serviceBrand: undefined;

	/** 串行化所有写入 —— 见类注释第 1 条。 */
	private readonly _queue = this._register(new Queue<boolean>());

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async ensureFolders(folders: readonly IFolderRequest[], reason: string): Promise<boolean> {
		if (folders.length === 0) {
			return false;
		}
		return this._queue.queue(() => this._doEnsureFolders(folders, reason));
	}

	private async _doEnsureFolders(folders: readonly IFolderRequest[], reason: string): Promise<boolean> {
		const current = this.workspaceContextService.getWorkspace().folders;
		const merged = mergeWorkspaceFolders(
			current.map(f => ({ uri: f.uri, name: f.name })),
			folders.map(f => ({ uri: f.uri, name: f.name })),
		);

		if (folderListsMatch(current, merged)) {
			return false;
		}

		this.logService.info(
			`[WorkspaceFolderRouter] ensureFolders | reason=${reason} | ` +
			`current=${current.length} → merged=${merged.length}`,
		);

		try {
			if (current.length === 0) {
				await this.workspaceEditingService.addFolders(merged, true);
			} else {
				// 追加语义：只把「新出现的」加到尾部，不动既有 folder 的位置。
				// （`merged` 的前 `current.length` 项与 `current` 同序，由 mergeWorkspaceFolders 保证。）
				await this.workspaceEditingService.addFolders(merged.slice(current.length), true);
			}
			return true;
		} catch (err) {
			this.logService.error(`[WorkspaceFolderRouter] ensureFolders failed (reason=${reason}):`, err);
			return false;
		}
	}

	async releaseFolders(uris: readonly URI[], reason: string): Promise<boolean> {
		if (uris.length === 0) {
			return false;
		}
		return this._queue.queue(() => this._doReleaseFolders(uris, reason));
	}

	private async _doReleaseFolders(uris: readonly URI[], reason: string): Promise<boolean> {
		const declared = this._declaredFolderKeys();
		const removable = uris.filter(uri => !declared.has(this.uriIdentityService.extUri.getComparisonKey(uri)));

		if (removable.length === 0) {
			this.logService.info(
				`[WorkspaceFolderRouter] releaseFolders skipped | reason=${reason} | ` +
				`所有请求移除的 folder 都是工作区文件声明的（用户资产，不自动移除）`,
			);
			return false;
		}

		this.logService.info(
			`[WorkspaceFolderRouter] releaseFolders | reason=${reason} | removing=${removable.length}/${uris.length}`,
		);
		try {
			await this.workspaceEditingService.removeFolders(removable, true);
			return true;
		} catch (err) {
			this.logService.error(`[WorkspaceFolderRouter] releaseFolders failed (reason=${reason}):`, err);
			return false;
		}
	}

	/**
	 * 工作区**文件声明**的 folder 集合（比较键）。
	 *
	 * 判据：`IWorkspaceFolder.raw` 有值即「来自 configuration 文件的声明」——
	 * 由 `toWorkspaceFolders()` 在解析 `.code-workspace` 时填入。运行时注入的 folder
	 * （旧代码 / router 自己加的）也会带 raw，因此这里是**保守**判定：
	 * 宁可不移除，也不误删用户声明的 root（`releaseFolders` 的语义就是"尽力而为"）。
	 *
	 * ⚠ 单根（打开文件夹）与 EMPTY 态下没有 configuration 文件 ⇒ 返回空集，
	 * 此时 `releaseFolders` 可移除任何 folder —— 与原生「关闭文件夹」语义一致。
	 */
	private _declaredFolderKeys(): Set<string> {
		const workspace = this.workspaceContextService.getWorkspace();
		if (!workspace.configuration) {
			return new Set();
		}
		return new Set(
			workspace.folders.map(f => this.uriIdentityService.extUri.getComparisonKey(f.uri)),
		);
	}
}

registerSingleton(IWorkspaceFolderRouter, WorkspaceFolderRouter, InstantiationType.Delayed);
