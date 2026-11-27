/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { blockingSessions, IHostActivity } from './dshUpgrade.js';
import { localize } from '../../../../nls.js';

export function assertIdleForUpdate(activity: IHostActivity | undefined): void {
	if (!activity || !Number.isFinite(activity.live) || !Array.isArray(activity.sessions)
		|| activity.sessions.some(session => typeof session?.sessionId !== 'string' || !Array.isArray(session.kinds) || session.kinds.some((kind: string) => typeof kind !== 'string'))) {
		throw new Error(localize('updateTasksUnavailable', "tasks-unavailable: 无法确认运行任务状态，请稍后重试"));
	}
	if (blockingSessions(activity).length) {
		throw new Error(localize('updateTasksChanged', "tasks-changed: 仍有任务正在运行，请等待任务完成后再安装更新"));
	}
}

export interface IDshUpdatePreparation {
	hasHost(): boolean;
	ownsHost(): boolean;
	getActivity(): Promise<IHostActivity | undefined>;
	stopHost(): Promise<void>;
	hostStopped(): boolean;
}

/** Unknown tasks, shared Hosts and unconfirmed exits never authorize installation. */
export async function prepareDshHostForUpdate(host: IDshUpdatePreparation, token: CancellationToken): Promise<void> {
	const checkCancellation = () => {
		if (token.isCancellationRequested) { throw new Error(localize('updatePreparationCancelled', "stop-failed: 安装准备已取消")); }
	};
	checkCancellation();
	if (!host.hasHost()) { return; }
	if (!host.ownsHost()) { throw new Error(localize('updateHostShared', "stop-failed: Host 被其他实例共享，请关闭其他实例后重试")); }
	assertIdleForUpdate(await host.getActivity());
	checkCancellation();
	assertIdleForUpdate(await host.getActivity());
	checkCancellation();
	await host.stopHost();
	if (!host.hostStopped()) { throw new Error(localize('updateHostStopFailed', "stop-failed: 无法确认 Host 已退出，已阻止安装")); }
	checkCancellation();
}
