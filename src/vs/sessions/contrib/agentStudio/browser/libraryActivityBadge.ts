/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  资料库 activitybar 徽标聚合。
 *
 *  资料库 sideview 是三合一（资料 / 记忆 / 代码），但左侧栏只有一枚图标 ——
 *  用户没打开该 sideview 时，无法感知「后台正在构建」或「有新内容落库」。
 *  本 contribution 把三个来源的上报聚合成一枚徽标：
 *    • 任一来源 building → ProgressBadge（转圈）
 *    • 有 new 计数       → NumberBadge（数字），转圈优先
 *    • 全部 idle         → removeActivity（清除徽标）
 *
 *  上报入口：IAgentStudioService.requestLibraryBadge()。
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IActivityService, NumberBadge, ProgressBadge } from '../../../../workbench/services/activity/common/activity.js';
import { IAgentStudioService, ILibraryBadgeRequest } from '../../../common/agentStudioService.js';
import { AGENT_STUDIO_KB_VIEW_CONTAINER_ID } from '../common/constants.js';

type LibraryBadgeSource = ILibraryBadgeRequest['source'];

export class LibraryActivityBadgeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.libraryActivityBadge';

	/** 每个来源的当前状态；kind='idle' 的来源直接从这里移除。 */
	private readonly _bySource = new Map<LibraryBadgeSource, { kind: 'building' | 'new'; count: number }>();

	/** 当前挂在「资料库」图标上的活动句柄（每次更新先释放旧的）。 */
	private readonly _current = this._register(new MutableDisposable<IDisposable>());

	constructor(
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IActivityService private readonly activityService: IActivityService,
	) {
		super();
		this._register(this.agentStudioService.onDidRequestLibraryBadge(req => this._onRequest(req)));
	}

	private _onRequest(req: ILibraryBadgeRequest): void {
		if (req.kind === 'idle') {
			// 构建中忽略「已读」：用户即便打开了 sideview，构建仍在进行 ⇒ 徽标继续转圈。
			if (this._bySource.get(req.source)?.kind === 'building') { return; }
			this._bySource.delete(req.source);
		} else if (req.kind === 'building') {
			this._bySource.set(req.source, { kind: 'building', count: 0 });
		} else {
			// 'new'：覆盖 building（构建收尾 → 转为「有新增」），同来源多次新增累加。
			const prev = this._bySource.get(req.source);
			this._bySource.set(req.source, { kind: 'new', count: (prev?.count ?? 0) + (req.count ?? 1) });
		}
		this._updateBadge();
	}

	private _updateBadge(): void {
		const building = [...this._bySource.values()].some(v => v.kind === 'building');
		const pending = [...this._bySource.values()].reduce((sum, v) => sum + (v.kind === 'new' ? v.count : 0), 0);

		if (building) {
			this._current.value = this.activityService.showViewContainerActivity(
				AGENT_STUDIO_KB_VIEW_CONTAINER_ID,
				{ badge: new ProgressBadge(() => '资料库正在构建…') },
			);
			return;
		}
		if (pending > 0) {
			this._current.value = this.activityService.showViewContainerActivity(
				AGENT_STUDIO_KB_VIEW_CONTAINER_ID,
				{ badge: new NumberBadge(pending, n => `资料库有 ${n} 项新增`) },
			);
			return;
		}
		// 无活动 ⇒ 释放句柄即移除徽标
		this._current.clear();
	}
}

registerWorkbenchContribution2(LibraryActivityBadgeContribution.ID, LibraryActivityBadgeContribution, WorkbenchPhase.AfterRestored);
