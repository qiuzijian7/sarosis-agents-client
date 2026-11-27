/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisablementReason, State, StateType } from '../../../../platform/update/common/update.js';
import { percentFromBytes } from './appUpdateState.js';
import type { IDshUpgradeAppState, IDshUpgradeState } from './dshPageBridgeProtocol.js';
import { decideRestartScope } from './dshRestartScope.js';
import { decideUpgradePolicy } from './dshUpgradePolicy.js';
import { localize } from '../../../../nls.js';

export const DSH_DESKTOP_UPDATE_IPC = 'vssaros:dsh:desktop-update';

export type DesktopUpdateFailure = 'configuration' | 'check' | 'check-network' | 'download' | 'download-network'
	| 'download-space' | 'download-permission' | 'download-busy' | 'install' | 'install-network'
	| 'stop-failed' | 'tasks-changed' | 'tasks-unavailable' | 'fullscreen-timeout';

/** Matches the official dsh Desktop protocol v1, without installer authority or raw diagnostics. */
export interface IDesktopUpdatePresentation {
	readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error';
	readonly version?: string;
	readonly percent?: number;
	readonly failure?: DesktopUpdateFailure;
}

export interface IDesktopUpdateSnapshot {
	readonly seq: number;
	readonly presentation: IDesktopUpdatePresentation;
	/** Only true when the installer has signalled Ready; Downloaded alone does not authorize restart. */
	readonly restartReady?: boolean;
	readonly app: IDshUpgradeAppState;
	readonly metadata?: { readonly minVersion?: string; readonly rolloutPercent?: number };
}

export function mergeDesktopUpdateReplica(state: IDshUpgradeState, snapshot: IDesktopUpdateSnapshot, seq: number): IDshUpgradeState {
	return {
		...state, at: Date.now(), seq, app: snapshot.app,
		policy: decideUpgradePolicy({
			local: snapshot.app.current, remote: snapshot.app.remote, channel: 'saros',
			minRequiredVersion: snapshot.metadata?.minVersion, rolloutPercent: snapshot.metadata?.rolloutPercent,
			notes: snapshot.app.releaseNotes, bucket: snapshot.app.current,
		}),
		restart: decideRestartScope({
			appPhase: snapshot.app.phase,
			appBusy: snapshot.presentation.phase === 'installing' ? 'installing' : undefined,
			jobStatus: state.job?.status, jobDone: state.job?.done, jobFailed: state.job?.failed, jobItems: state.job?.items,
		}),
	};
}

export function classifyDesktopUpdateFailure(message: string, phase: IDesktopUpdatePresentation['phase']): DesktopUpdateFailure {
	if (/tasks-unavailable/.test(message)) { return 'tasks-unavailable'; }
	if (/tasks-changed/.test(message)) { return 'tasks-changed'; }
	if (/stop-failed/.test(message)) { return 'stop-failed'; }
	if (/ENOSPC|no space|磁盘空间/i.test(message)) { return 'download-space'; }
	if (/EACCES|EPERM|permission|拒绝访问/i.test(message)) { return 'download-permission'; }
	if (/EBUSY|locked|占用/i.test(message)) { return 'download-busy'; }
	const category = phase === 'downloading' || phase === 'verifying' ? 'download' : phase === 'installing' || phase === 'ready' ? 'install' : 'check';
	return /network|fetch|ECONN|ENOTFOUND|ETIMEDOUT|timeout|网络|超时/i.test(message) ? `${category}-network` : category;
}

export function desktopUpdatePresentation(state: State, previous: IDesktopUpdatePresentation = { phase: 'idle' }): IDesktopUpdatePresentation {
	const version = 'update' in state ? state.update?.productVersion ?? state.update?.version : undefined;
	switch (state.type) {
		case StateType.Idle:
			return state.error ? { phase: 'error', failure: classifyDesktopUpdateFailure(state.error, previous.phase) } : { phase: 'idle' };
		case StateType.Uninitialized:
			return { phase: 'idle' };
		case StateType.Disabled:
			return { phase: 'error', failure: 'configuration' };
		case StateType.CheckingForUpdates:
			return { phase: 'checking' };
		case StateType.AvailableForDownload:
			return { phase: 'available', version };
		case StateType.Downloading:
			return { phase: state.verifying ? 'verifying' : 'downloading', version, percent: state.verifying ? undefined : percentFromBytes(state.downloadedBytes, state.totalBytes) };
		case StateType.Overwriting:
			return { phase: 'downloading', version };
		case StateType.Updating:
			return { phase: 'installing', version, percent: percentFromBytes(state.currentProgress, state.maxProgress) };
		case StateType.Downloaded:
		case StateType.Ready:
		case StateType.Restarting:
			return { phase: 'ready', version };
	}
}

/** Legacy cards are read-only replicas; manual dialogs belong to the native controller. */
export function desktopUpdateAppState(state: State, presentation: IDesktopUpdatePresentation, current: string, skippedVersion?: string): IDshUpgradeAppState {
	const phase = presentation.phase === 'ready' ? 'downloaded'
		: presentation.phase === 'installing' || presentation.phase === 'verifying' ? 'downloading'
			: state.type === StateType.Disabled ? 'unsupported'
				: presentation.phase !== 'error' && state.type === StateType.Idle && state.notAvailable && !state.error ? 'up-to-date' : presentation.phase;
	return {
		current,
		action: presentation.version ? 'upgrade' : phase === 'up-to-date' ? 'uptodate' : 'unknown',
		phase,
		manual: false,
		availableVersion: presentation.version,
		remote: presentation.version,
		percent: presentation.percent,
		error: state.type === StateType.Idle ? state.error : state.type === StateType.Disabled
			? state.reason === DisablementReason.RunningAsAdmin ? localize('desktopReplicaUpdateAdmin', "请以普通权限重新启动后更新") : localize('desktopReplicaUpdateDisabled', "更新服务已禁用") : undefined,
		skippedVersion,
	};
}
