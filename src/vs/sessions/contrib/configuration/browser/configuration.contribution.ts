/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'chat.customizationsMenu.userStoragePath': '~/.copilot',
		'github.copilot.chat.claudeCode.enabled': true,
		// [Saros] In the new three-column layout, editors open directly in the
		// main editor area (center column) instead of a modal overlay.
		'workbench.editor.useModal': 'off',

		// [Saros] ★ 2026-09-15：把 `.worktrees/**` 与 `node_modules/**` 排除出**原生文件 watcher**。
		//
		// 背景：worktree 建在**仓库内**（`<repoRoot>/.worktrees/<name>`，见
		// `sessions/contrib/worktree/browser/worktreeService.ts` 的 `makeWorktreeInfo`）
		// —— 它是**一整份源码副本**。而 VS Code 的默认 `files.watcherExclude`
		// （`workbench/contrib/files/browser/files.contribution.ts`）**只含**
		// `.git/objects/**`、`.git/subtree-cache/**`、`.hg/store/**` 及其 `*/` 变体，
		// **既没有 `.worktrees` 也没有 `node_modules`** ⇒ 递归 watcher 会同时盯着
		// 「当前分支源码 + 每个 worktree 的完整副本 + node_modules」，事件量成倍放大
		// （历史上正是这类膨胀把 renderer 推到 2.6GB）。
		//
		// ⚠ 顺带更正一处错误假设：`sessions/contrib/agentStudio/browser/views/workspaceView.ts`
		// 的注释写着「exclude high-noise directories that the native Explorer also skips via
		// `files.watcherExclude` defaults」—— **原生默认并不包含这些目录**，该视图因此自己
		// 传了一份 excludes。本项把同一组排除补进**原生** watcher，两者才真正一致。
		//
		// 为什么放这里而不是改上游默认值：这是 agents 布局的诉求；改上游默认会影响所有窗口，
		// 并新增与上游同步的冲突面。对象型设置的 defaults override 是**深合并**
		// （见 `platform/configuration/common/configurationModels.ts` 的 `mergeContents`），
		// 所以这里只列新增项，不会丢掉上游那几条。
		'files.watcherExclude': {
			'**/.worktrees/**': true,
			'**/node_modules/**': true,
		},
	},
	donotCache: true,
	preventExperimentOverride: true,
	source: 'sessionsDefaults'
}]);
