/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * App 自身更新的**状态机**（2026-11-05，复刻 dsh-desktop 的更新实现）。
 *
 * 对齐 `G:\CustomWorkspaces\AIProjects\dsh-desktop\src\main\update\update-state.ts`
 * 的 `reduceUpdateStatus()`：一次迁移只由「当前状态 + 一个事件」决定，不做任何 IO ⇒
 * 可以用假状态序列做行为测试。
 *
 * ⚠ 边界：本文件零 VS Code 依赖、不 import `update.ts`、不读配置、不碰 IPC。
 *   `IUpdateService.State` → 事件的映射在 `dshHarnessService._onUpdateServiceState()`
 *   （那里才能拿到平台服务）；页面侧的可见性判据在 `appUpdateView.ts`。
 *
 * 与官方的差别（刻意的）：
 *   · `downgrade` / `locale` / `downloaded` 等字段不进状态对象 —— 本项目的
 *     `decideAppUpdate()` 已经硬性防降级，界面只有中文，不需要这两条语义。
 *   · 新增 `percentFromBytes()`：VS Code win32 更新服务给的是字节数而不是百分比。
 */

export type AppUpdatePhase =
	| 'idle'
	| 'checking'
	| 'available'
	| 'downloading'
	| 'downloaded'
	| 'up-to-date'
	| 'error'
	| 'unsupported';

export type AppUpdateSource = 'startup' | 'runtime' | 'manual';

/** 信任边界用：页面桥收到外部数据时先验值域，不许把任意字符串当 phase 下发。 */
export function isAppUpdatePhase(value: unknown): value is AppUpdatePhase {
	return value === 'idle' || value === 'checking' || value === 'available'
		|| value === 'downloading' || value === 'downloaded' || value === 'up-to-date'
		|| value === 'error' || value === 'unsupported';
}

/** 一次「应用更新呈现」的完整状态。所有字段可序列化（要过 dataset 推给页面）。 */
export interface IAppUpdateStatus {
	readonly phase: AppUpdatePhase;
	readonly currentVersion: string;
	readonly availableVersion?: string;
	readonly percent?: number;
	readonly message?: string;
	readonly manual: boolean;
	readonly source?: AppUpdateSource;
	/** 每次用户显式请求新呈现才变化；用于区分新旧请求、避免历史快照重放弹窗。 */
	readonly presentationId?: number;
	/** 纯文本，渲染时必须用 textContent（不许 innerHTML）。 */
	readonly releaseNotes?: string;
}

export type AppUpdateEvent =
	| { type: 'check'; manual: boolean; source?: AppUpdateSource }
	| { type: 'available'; version: string; releaseNotes?: string }
	/** percent 可缺省：更新源没给 Content-Length 时 UI 走不确定进度条，不猜百分比。 */
	| { type: 'downloading'; percent?: number }
	| { type: 'downloaded'; version: string }
	| { type: 'not-available' }
	| { type: 'error'; message: string }
	| { type: 'unsupported'; message: string }
	| { type: 'present-manual' }
	| { type: 'reset' };

export function initialAppUpdateStatus(currentVersion: string): IAppUpdateStatus {
	return { phase: 'idle', currentVersion, manual: false };
}

/** 0..100，保留一位小数；非有限值一律 0。 */
export function clampPercent(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/**
 * `updateService.win32.ts:332-348` 每 500ms 把 `downloadedBytes/totalBytes` 写进
 * `State.Downloading`。这里折算成官方 UI 需要的 `percent`。
 *
 * 拿不到总大小（服务端没给 Content-Length）⇒ undefined ⇒ UI 走不确定进度条，
 * **不要猜一个假百分比**（真机上 477MB 安装包慢网时会看很久）。
 */
export function percentFromBytes(downloadedBytes?: number, totalBytes?: number): number | undefined {
	if (!Number.isFinite(totalBytes) || !totalBytes || totalBytes <= 0) {
		return undefined;
	}
	const downloaded = Number.isFinite(downloadedBytes) ? Math.max(0, downloadedBytes!) : 0;
	return clampPercent(downloaded / totalBytes! * 100);
}

/** 把不可信的更新元数据收敛成有上限的纯文本。 */
export function normalizeReleaseNotes(value: unknown): string | undefined {
	const notes = typeof value === 'string'
		? [value]
		: Array.isArray(value)
			? value.flatMap(entry => {
				if (!entry || typeof entry !== 'object' || !('note' in entry)) {
					return [];
				}
				const note = (entry as { note?: unknown }).note;
				return typeof note === 'string' ? [note] : [];
			})
			: [];
	const text = notes.join('\n\n').replace(/\r\n?/g, '\n').trim().slice(0, 20_000);
	return text || undefined;
}

/**
 * 状态迁移。`base` 只保留「跨阶段要活下来」的字段，避免上一条 `available` 的
 * releaseNotes/version 泄漏到无关的后续阶段（官方同款做法）。
 */
export function reduceAppUpdateStatus(current: IAppUpdateStatus, event: AppUpdateEvent): IAppUpdateStatus {
	const base = {
		currentVersion: current.currentVersion,
		manual: current.manual,
		source: current.source,
		presentationId: current.presentationId,
	};
	switch (event.type) {
		case 'check':
			return {
				...base,
				phase: 'checking',
				manual: event.manual,
				source: event.source ?? (event.manual ? 'manual' : 'runtime'),
			};
		case 'available':
			return {
				...base,
				phase: 'available',
				availableVersion: event.version,
				...(event.releaseNotes ? { releaseNotes: event.releaseNotes } : {}),
			};
		case 'downloading':
			// 每次重建（不 spread current）⇒ 上一轮的 percent 不会残留到「拿不到进度」的这一轮。
			return {
				...base,
				phase: 'downloading',
				...(event.percent !== undefined ? { percent: clampPercent(event.percent) } : {}),
				...(current.availableVersion ? { availableVersion: current.availableVersion } : {}),
				...(current.releaseNotes ? { releaseNotes: current.releaseNotes } : {}),
			};
		case 'downloaded':
			return {
				...base,
				phase: 'downloaded',
				availableVersion: event.version,
				...(current.releaseNotes ? { releaseNotes: current.releaseNotes } : {}),
			};
		case 'not-available':
			return { ...base, phase: 'up-to-date' };
		case 'error':
			return { ...base, phase: 'error', message: event.message };
		case 'unsupported':
			return { ...base, phase: 'unsupported', message: event.message };
		case 'present-manual':
			return { ...current, manual: true, source: 'manual' };
		case 'reset':
			return initialAppUpdateStatus(current.currentVersion);
	}
}
