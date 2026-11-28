/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { classifyDesktopUpdateFailure, desktopUpdateAppState, desktopUpdatePresentation, IDesktopUpdatePresentation, IDesktopUpdateSnapshot } from '../common/dshDesktopUpdate.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IUpdateService, State, StateType } from '../../../../platform/update/common/update.js';
import { parseAppUpdateResponse } from '../common/dshAppUpdate.js';

type DesktopUpdateService = Pick<IUpdateService, 'state' | 'onStateChange' | 'checkForUpdates' | 'downloadUpdate' | 'applyUpdate' | 'quitAndInstall'>;

/**
 * Update state source for a desktop window that does not load UpdateContribution.
 *
 * vssaros: 更新提示**只用 dsh 侧的通知卡片**（`vssaros-chat-surface/client.appUpdate.js`）。
 * 本控制器只负责把原生更新状态推成快照，以及执行卡片按钮下发的动作；
 * 不再弹任何 Electron / IDE messagebox（含「发现新版本」「重启」「已是最新」「失败」）。
 */
export class DshDesktopUpdateController extends Disposable {

	private active = false;
	private advancing = false;
	private opening = false;
	/** 显式发起的检查才允许卡片显示 checking / up-to-date / error 等手动态。 */
	private manual = false;
	private presentationId = 0;
	private sequence = 0;
	private presentation: IDesktopUpdatePresentation = { phase: 'idle' };
	private skippedVersion: string | undefined;
	private errorMessage: string | undefined;
	private readonly changed = this._register(new Emitter<IDesktopUpdateSnapshot>());
	readonly onDidChange = this.changed.event;

	get snapshot(): IDesktopUpdateSnapshot {
		const state = this.updateService.state;
		const metadata = 'update' in state ? parseAppUpdateResponse(state.update) : undefined;
		return {
			seq: this.sequence, presentation: { ...this.presentation },
			restartReady: state.type === StateType.Ready && this.presentation.phase === 'ready',
			app: {
				...desktopUpdateAppState(state, this.presentation, this.options.currentVersion ?? '', this.skippedVersion, this.manual, this.presentationId),
				...(metadata?.notes ? { releaseNotes: metadata.notes } : {}),
				...(this.errorMessage ? { error: this.errorMessage } : {}),
			},
			metadata: metadata ? { minVersion: metadata.minVersion, rolloutPercent: metadata.rolloutPercent } : undefined,
		};
	}

	get ownsFeedback(): boolean { return this.active || this.advancing; }

	private publish(state: State): void {
		this.errorMessage = undefined;
		this.presentation = desktopUpdatePresentation(state, this.presentation);
		this.sequence++;
		this.changed.fire(this.snapshot);
	}

	async skip(version: string): Promise<void> {
		if (this.updateService.state.type !== StateType.AvailableForDownload || version !== this.presentation.version) {
			return;
		}
		await this.options.saveSkippedVersion?.(version);
		this.skippedVersion = version;
		this.active = false;
		this.publish(this.updateService.state);
	}
	private readonly checkTimeout = this._register(new RunOnceScheduler(() => {
		this.showError(localize('desktopUpdateTimeout', "检查更新超时，请检查网络连接后重试。"));
	}, 30_000));

	constructor(
		private readonly updateService: DesktopUpdateService,
		private readonly logError: (message: string) => void,
		private readonly options: { currentVersion?: string; skippedVersion?: string; startupCheck?: boolean; saveSkippedVersion?: (version: string | undefined) => Promise<void> | void } = {},
	) {
		super();
		this.skippedVersion = options.skippedVersion;
		this.publish(updateService.state);
		this._register(updateService.onStateChange(state => {
			this.publish(state);
			if (state.type !== StateType.CheckingForUpdates) { this.checkTimeout.cancel(); }
			if (state.type === StateType.Idle) { this.active = false; }
		}));
		if (options.startupCheck) {
			const startup = this._register(new RunOnceScheduler(() => { void this.checkForUpdates(false); }, 8_000));
			startup.schedule();
		}
	}

	/** 只检查并推状态：自动检查不产生 UI，显式检查由 dsh 通知卡片给出反馈。 */
	async checkForUpdates(explicit = true): Promise<void> {
		const state = this.updateService.state;
		if (this.opening || this.advancing || !explicit && state.type !== StateType.Idle) {
			return;
		}
		this.opening = true;
		this.active = explicit;
		this.manual = explicit;
		if (explicit) { this.presentationId++; }
		try {
			if (explicit) {
				const saved = this.options.saveSkippedVersion?.(undefined);
				if (saved) { await saved; }
				this.skippedVersion = undefined;
			}
			this.publish(state);
			if (state.type === StateType.Idle) {
				if (explicit) { this.checkTimeout.schedule(); }
				await this.updateService.checkForUpdates(explicit);
				if (this.active && this.updateService.state === state) {
					this.showError(localize('desktopUpdateSkipped', "更新检查未启动，请稍后重试。"));
				}
			} else if (explicit && state.type === StateType.CheckingForUpdates) {
				this.checkTimeout.schedule();
			}
		} catch (error) {
			if (explicit) { this.showError(toErrorMessage(error)); }
			else { this.logError(toErrorMessage(error)); }
		} finally {
			this.opening = false;
		}
	}

	/** dsh 通知卡片「重试」：上次动作失败就重做该动作，否则重新检查一次。 */
	async retry(): Promise<void> {
		const state = this.updateService.state;
		if (state.type === StateType.AvailableForDownload || state.type === StateType.Downloaded || state.type === StateType.Ready) {
			await this.confirmUpdate();
			return;
		}
		await this.checkForUpdates();
	}

	/**
	 * dsh 通知卡片按钮（更新 / 重新启动并安装）下发的动作，**不弹二次确认**。
	 * 已有更新就下载；已下载就安装；安装就绪就重启；空闲则重新检查一次。
	 */
	async confirmUpdate(): Promise<void> {
		if (this.opening || this.advancing) { return; }
		const state = this.updateService.state;
		if (state.type === StateType.Idle) {
			await this.checkForUpdates();
			return;
		}
		if (state.type !== StateType.AvailableForDownload && state.type !== StateType.Downloaded && state.type !== StateType.Ready) {
			this.publish(state);
			return;
		}
		this.advancing = true;
		this.active = true;
		// 卡片按钮就是一次用户确认：后续进度/失败都算这次「手动呈现」，卡片必须可见。
		this.manual = true;
		this.presentationId++;
		try {
			if (state.type === StateType.AvailableForDownload) {
				await this.updateService.downloadUpdate(true);
			} else if (state.type === StateType.Downloaded) {
				await this.updateService.applyUpdate();
			} else {
				await this.updateService.quitAndInstall();
			}
		} catch (error) {
			this.showError(toErrorMessage(error));
		} finally {
			this.advancing = false;
		}
	}

	/** 错误只落到快照（卡片显示「更新失败」）和日志，不再弹原生框。 */
	private showError(message: string): void {
		this.active = false;
		this.checkTimeout.cancel();
		// 没有 messagebox / 全屏状态页了：失败必须作为一次新的手动呈现交给 dsh 通知卡片。
		this.manual = true;
		this.presentationId++;
		this.errorMessage = message;
		this.presentation = { phase: 'error', failure: this.presentation.phase === 'error' && this.presentation.failure ? this.presentation.failure : classifyDesktopUpdateFailure(message, this.presentation.phase) };
		this.sequence++;
		this.changed.fire(this.snapshot);
		this.logError(message);
	}
}
