/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * App 更新卡片的**呈现判据与文案**（2026-11-05，复刻 dsh-desktop）。
 *
 * 对齐 `G:\CustomWorkspaces\AIProjects\dsh-desktop\src\preload\update-view.ts`。
 * 全是纯函数，零 VS Code / DOM 依赖 ⇒ 渲染进程和单测共用同一份判断，
 * 不会出现「IDE 面板说该弹、页面说不该弹」。
 *
 * 刻意的差别：界面只有中文 ⇒ 不做 locale 分支；`downgrade` 不搬（本项目
 * `decideAppUpdate()` 已硬性拒绝降级，不会出现「正在降级」这个状态）。
 */

import type { AppUpdatePhase, IAppUpdateStatus } from './appUpdateState.js';

/**
 * 哪些阶段**自动**可见。
 * 其余阶段只在「用户手动发起过检查」时可见 —— 这是本项目「启动时不要弹出升级提示」
 * 的落点：自动检查只更新状态，不弹 UI。
 */
const AUTO_VISIBLE: readonly AppUpdatePhase[] = ['available', 'downloading', 'downloaded'];
const MANUAL_ONLY: readonly AppUpdatePhase[] = ['checking', 'up-to-date', 'error', 'unsupported'];

export function shouldShowAppUpdate(status: IAppUpdateStatus, allowManualPresentation = true): boolean {
	if (AUTO_VISIBLE.includes(status.phase)) {
		return true;
	}
	return allowManualPresentation && status.manual && MANUAL_ONLY.includes(status.phase);
}

/**
 * 忽略的粒度：有版本号就按版本忽略（下次新版本仍然会问）；
 * 没有版本号的瞬态阶段（checking / up-to-date / error）按阶段忽略。
 */
export function isAppUpdateDismissed(
	status: IAppUpdateStatus,
	dismissedVersion: string | null,
	dismissedTransientPhase: AppUpdatePhase | null = null,
): boolean {
	if (status.availableVersion) {
		return status.availableVersion === dismissedVersion;
	}
	return status.phase === dismissedTransientPhase;
}

/**
 * 一次「新的手动呈现」要不要重开面板。
 *
 * ★ `delivery === 'snapshot'` 必须为 false：renderer / Host 重启后读到的历史快照
 *   不是一次新的用户请求，不能把用户之前关掉的弹窗又弹出来（官方同款坑）。
 */
export function isNewManualPresentation(
	status: IAppUpdateStatus,
	previous?: IAppUpdateStatus,
	delivery: 'event' | 'snapshot' = 'event',
): boolean {
	if (delivery === 'snapshot' || !status.manual) {
		return false;
	}
	if (!previous) {
		return true;
	}
	if (status.presentationId !== undefined) {
		return status.presentationId !== previous.presentationId;
	}
	return status.phase === 'checking' && previous.phase !== 'checking';
}

export interface IAppUpdateHeadline {
	readonly title: string;
	readonly description: string;
}

/**
 * 卡片两行：第一行「发生了什么」，第二行「意味着什么」。
 * 版本号放第二行 —— 版本号回答「哪一个」，不回答「现在要做什么」。
 */
export function appUpdateHeadline(status: IAppUpdateStatus): IAppUpdateHeadline {
	const version = status.availableVersion ? `v${status.availableVersion}` : '';
	const percent = status.percent !== undefined ? Math.round(status.percent) : 0;
	switch (status.phase) {
		case 'checking':
			return { title: '正在检查更新', description: `当前 v${status.currentVersion}` };
		case 'available':
			return { title: `检测到新版本 ${version}`, description: `${version} 已发布，同意后开始下载。` };
		case 'downloading':
			return {
				title: '正在下载更新',
				description: status.percent === undefined
					? `${version} · 正在下载…`
					: `${version} · ${percent}%`,
			};
		case 'downloaded':
			return { title: '更新已就绪', description: `${version} 将在重启后生效。` };
		case 'up-to-date':
			return { title: '已是最新版本', description: `当前 v${status.currentVersion}` };
		case 'unsupported':
			return { title: '此版本不支持自动更新', description: '请手动下载安装包覆盖安装。' };
		case 'error':
			return {
				title: '更新失败',
				description: status.message || '无法检查或下载更新。',
			};
		case 'idle':
			return { title: '', description: '' };
	}
}
