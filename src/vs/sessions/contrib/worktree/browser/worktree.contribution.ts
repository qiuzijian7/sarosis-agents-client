/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorktreeService } from '../common/worktreeService.js';
import { WorktreeService } from './worktreeService.js';
import { IWorkspaceAdapterService } from '../common/workspaceAdapter.js';
import { WorktreeAdapterService } from './worktreeAdapterService.js';
import { IWorktreeCheckpointService } from '../common/worktreeCheckpointService.js';
import { WorktreeCheckpointService } from './worktreeCheckpointServiceImpl.js';
import { registerWorktreeCheckpointContributions } from './worktreeCheckpoint.contribution.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';
import { DEFAULT_WORKTREE_BASE_BRANCH, DEFAULT_WORKTREE_PUSH_BRANCH_ON_CREATE, WORKTREE_BASE_BRANCH_SETTING, WORKTREE_PUSH_BRANCH_ON_CREATE_SETTING } from '../common/worktreeTypes.js';

// --- Register Services ---
// View container and view registrations are now handled by the unified
// sessions Explorer in src/vs/sessions/contrib/files/browser/files.contribution.ts.

registerSingleton(IWorktreeService, WorktreeService, InstantiationType.Delayed);
registerSingleton(IWorkspaceAdapterService, WorktreeAdapterService, InstantiationType.Delayed);
registerSingleton(IWorktreeCheckpointService, WorktreeCheckpointService, InstantiationType.Delayed);

// --- Register Checkpoint Commands ---
// ★ 2026-09-15：补上这行调用。`registerWorktreeCheckpointContributions()` 此前**全仓无调用点**
// ⇒ `worktree.createCheckpoint` / `rollbackToCheckpoint` / `listCheckpoints` / `deleteCheckpoints`
// 这 4 条命令从未注册过，是**死代码**；而它们中的 `rollbackToCheckpoint` 是当时
// `IWorktreeCheckpointService.rollbackToCheckpoint()` 的**唯一调用者**
// ⇒ 那个方法整体不可达（checkpoint "只进不出"）。
registerWorktreeCheckpointContributions();

// --- Register Settings ---
// ★ 2026-09-15：`sessions.worktree.pushBranchOnCreate` 此前**不存在**（推送是硬编码行为）。
// 注册 schema 才能让设置 UI 看到、有补全 —— 与上方 `AGENT_STUDIO_TOOL_SEARCH_*` 的处理一致
// （见 `agentStudio.contribution.ts` 里「键一直存在但从未注册 schema」那条注释）。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sessions.worktree',
	title: localize('sessions.worktree', "Worktrees"),
	// 与 sessions 其它设置一致：机器级（不受工作区设置影响）。
	scope: ConfigurationScope.MACHINE,
	properties: {
		[WORKTREE_PUSH_BRANCH_ON_CREATE_SETTING]: {
			type: 'boolean',
			default: DEFAULT_WORKTREE_PUSH_BRANCH_ON_CREATE,
			description: localize(
				'sessions.worktree.pushBranchOnCreate',
				"创建 worktree 时是否把新分支推送到 origin。默认关闭：worktree 属实验性隔离，推分支是远端可见副作用（团队会看到 worktree/* 分支、可能触发 CI）。上游 agentHost 从不推送。",
			),
		},
		[WORKTREE_BASE_BRANCH_SETTING]: {
			type: 'string',
			enum: ['current', 'default'],
			default: DEFAULT_WORKTREE_BASE_BRANCH,
			enumDescriptions: [
				'从主仓当前 HEAD 建分支（git 默认）。新 worktree 会带上当前分支的未推送状态。',
				'从 origin/<默认分支> 建分支（无远端时退回本地默认分支）。与「Reset Worktree」（重置到默认分支）的基准一致，与上游 agentHost 相同。',
			],
			description: localize(
				'sessions.worktree.baseBranchOnCreate',
				"创建 worktree 时新分支的起点。默认 current（保留 git 原行为）。",
			),
		},
	},
});
