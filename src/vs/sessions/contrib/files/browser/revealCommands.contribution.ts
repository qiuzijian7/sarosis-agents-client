/*---------------------------------------------------------------------------------------------
 *  [Saros 2026-07-04] 修复文本编辑器右键菜单中两个失效命令。
 *
 * 问题：
 *  1. "Reveal in Explorer View" (revealInExplorer) 在 Saros 会话窗口中静默失效。
 *     标准实现在 fileCommands.ts 中先用 `contextService.isInsideWorkspace(uri)` 做判断，
 *     Saros 的 SessionsWorkspaceContextService 是合成的内存 workspace，用户的本地文件
 *     不会落在该 workspace 的 folders 里，导致该检查直接走 else 分支（只 focus
 *     OpenEditorsView），不打开 Explorer。同时即便 isInsideWorkspace 返回 true，
 *     标准实现也只会打开 `workbench.explorer.fileView`，在 Saros 的会话窗口中
 *     标准 Explorer 容器并不总是可见/可达。
 *  2. "Reveal in File Explorer" (revealFileInOS) 也偶发失效。当传进来的 resource
 *     经过 getMultiSelectedResources 推断后落到非 file scheme，或者原生 IPC 失败
 *     时，标准实现会直接 return，没有任何用户反馈。
 *
 * 修复策略：
 *  - 用 CommandsRegistry 重新注册同名命令。由于 CommandsRegistry 用 LinkedList 存储
 *    handler，新注册的会排在最前并被 getCommand 优先返回，从而覆盖标准实现。
 *  - Saros 端实现：
 *      · revealInExplorer：跳过 isInsideWorkspace 检查，优先打开
 *        `sessions.files.explorer`（Saros 自定义 Explorer），回退到标准
 *        `workbench.explorer.fileView`。
 *      · revealFileInOS：复用 getMultiSelectedResources 拿到的 URI 列表，对
 *        `file` / `vscodeUserData` / `vscodeRemote(WSL)` 全部用本地路径走
 *        nativeHostService.showItemInFolder，并把每次调用的结果/失败写到
 *        log service 便于排查。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import {
	IExplorerService,
	getResourceForCommand,
	getMultiSelectedResources,
} from '../../../../workbench/contrib/files/browser/files.js';
import { IListService } from '../../../../platform/list/browser/listService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ExplorerView } from '../../../../workbench/contrib/files/browser/views/explorerView.js';
import { VIEW_ID as STANDARD_EXPLORER_VIEW_ID } from '../../../../workbench/contrib/files/common/files.js';
import { SESSIONS_FILES_VIEW_ID } from './filesView.js';
import { getRemoteName, getRemoteServerRootPath } from '../../../../platform/remote/common/remoteHosts.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';

const REVEAL_IN_EXPLORER_COMMAND_ID = 'revealInExplorer';
const REVEAL_IN_OS_COMMAND_ID = 'revealFileInOS';

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * 把任意 URI 转成本地 fs 路径，覆盖 file / vscodeUserData / vscodeRemote(WSL)。
 * 与标准 fileCommands.ts 中的 toLocalFileUri 行为一致，但额外把任何
 * `vscodeRemote` 的非 WSL 情况也尝试做一次 host 端的 path 还原。
 */
function toLocalPath(resource: URI): string | undefined {
	switch (resource.scheme) {
		case Schemas.file:
		case Schemas.vscodeUserData:
			return resource.fsPath;
		case Schemas.vscodeRemote: {
			const remoteName = getRemoteName(resource.authority);
			if (remoteName === 'wsl') {
				const distro = getRemoteServerRootPath(resource.authority);
				if (distro) {
					// \\wsl$\<distro><resource.path> 在 Windows 资源管理器中是合法 UNC 路径
					return `\\\\wsl$\\${distro}${resource.path.replace(/\//g, '\\')}`;
				}
			}
			return undefined;
		}
		default:
			return undefined;
	}
}

// ─── revealInExplorer override ───────────────────────────────────────────────

CommandsRegistry.registerCommand({
	id: REVEAL_IN_EXPLORER_COMMAND_ID,
	handler: async (accessor, resource: URI | object) => {
		const logService = accessor.get(ILogService);
		const viewService = accessor.get(IViewsService);
		const explorerService = accessor.get(IExplorerService);
		const editorService = accessor.get(IEditorService);
		const listService = accessor.get(IListService);

		const uri = getResourceForCommand(resource, editorService, listService);
		if (!uri) {
			logService.warn('[Saros][revealInExplorer] No resource could be resolved from command arg.');
			return;
		}

		logService.info(`[Saros][revealInExplorer] request for ${uri.toString()}`);

		// 优先尝试 Saros 自定义 Explorer 视图；其次回退到标准 Explorer 视图。
		// Saros 会话窗口的 `isInsideWorkspace` 在大多数本地文件场景下会返回 false，
		// 但 Explorer 视图本身仍然能展示并选中文件，因此这里直接跳过该检查。
		const candidateIds = [SESSIONS_FILES_VIEW_ID, STANDARD_EXPLORER_VIEW_ID];
		for (const id of candidateIds) {
			try {
				const view = await viewService.openView<ExplorerView>(id, false);
				if (view) {
					view.setExpanded(true);
					await explorerService.select(uri, 'force');
					view.focus();
					logService.info(`[Saros][revealInExplorer] revealed in view ${id}`);
					return;
				}
			} catch (err) {
				logService.warn(`[Saros][revealInExplorer] openView ${id} failed:`, err);
			}
		}

		logService.warn('[Saros][revealInExplorer] No explorer view available.');
	},
});

// ─── revealFileInOS override ─────────────────────────────────────────────────

CommandsRegistry.registerCommand({
	id: REVEAL_IN_OS_COMMAND_ID,
	handler: async (accessor, resource: URI | object) => {
		const logService = accessor.get(ILogService);
		const listService = accessor.get(IListService);
		const editorService = accessor.get(IEditorService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const explorerService = accessor.get(IExplorerService);
		const nativeHostService = accessor.get(INativeHostService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);

		const resolved = getMultiSelectedResources(
			resource,
			listService,
			editorService,
			editorGroupsService,
			explorerService
		);

		logService.info(`[Saros][revealFileInOS] resolved ${resolved.length} resources`);

		if (resolved.length) {
			for (const r of resolved) {
				const p = toLocalPath(r);
				if (p) {
					try {
						await nativeHostService.showItemInFolder(p);
					} catch (err) {
						logService.error(`[Saros][revealFileInOS] showItemInFolder failed for ${p}:`, err);
					}
				} else {
					logService.warn(`[Saros][revealFileInOS] skip non-local resource ${r.scheme}:${r.path}`);
				}
			}
			return;
		}

		// 回退：拿不到资源时打开第一个 workspace folder
		const first = workspaceContextService.getWorkspace().folders[0]?.uri;
		if (first) {
			const p = toLocalPath(first);
			if (p) {
				try {
					await nativeHostService.showItemInFolder(p);
				} catch (err) {
					logService.error('[Saros][revealFileInOS] workspace fallback showItemInFolder failed:', err);
				}
			} else {
				logService.warn('[Saros][revealFileInOS] workspace fallback has non-local folder uri:', first.toString());
			}
		} else {
			logService.warn('[Saros][revealFileInOS] no resources and no workspace folders to reveal.');
		}
	},
});


