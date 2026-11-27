/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { classifyDesktopUpdateFailure, desktopUpdateAppState, desktopUpdatePresentation, IDesktopUpdatePresentation, IDesktopUpdateSnapshot } from '../common/dshDesktopUpdate.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { DisablementReason, IUpdateService, State, StateType } from '../../../../platform/update/common/update.js';
import { parseAppUpdateResponse } from '../common/dshAppUpdate.js';

type DesktopUpdateService = Pick<IUpdateService, 'state' | 'onStateChange' | 'checkForUpdates' | 'downloadUpdate' | 'applyUpdate' | 'quitAndInstall'>;

/** Native update feedback for a desktop window that does not load UpdateContribution. */
export class DshDesktopUpdateController extends Disposable {

	private active = false;
	private prompting = false;
	private opening = false;
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
			app: {
				...desktopUpdateAppState(state, this.presentation, this.options.currentVersion ?? '', this.skippedVersion),
				...(metadata?.notes ? { releaseNotes: metadata.notes } : {}),
				...(this.errorMessage ? { error: this.errorMessage } : {}),
			},
			metadata: metadata ? { minVersion: metadata.minVersion, rolloutPercent: metadata.rolloutPercent } : undefined,
		};
	}

	get ownsFeedback(): boolean { return this.active || this.prompting; }

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
		void this.showError(localize('desktopUpdateTimeout', "检查更新超时，请检查网络连接后重试。"));
	}, 30_000));

	constructor(
		private readonly updateService: DesktopUpdateService,
		private readonly showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>,
		private readonly logError: (message: string) => void,
		private readonly options: { currentVersion?: string; skippedVersion?: string; startupCheck?: boolean; saveSkippedVersion?: (version: string | undefined) => Promise<void> | void } = {},
	) {
		super();
		this.skippedVersion = options.skippedVersion;
		this.publish(updateService.state);
		this._register(updateService.onStateChange(state => {
			this.publish(state);
			if (state.type !== StateType.CheckingForUpdates) { this.checkTimeout.cancel(); }
			if (this.active && !this.prompting && state.type !== StateType.CheckingForUpdates && state.type !== StateType.Downloading && state.type !== StateType.Updating && state.type !== StateType.Overwriting) {
				void this.handleState(state).catch(error => this.showError(toErrorMessage(error)));
			}
		}));
		if (options.startupCheck) {
			const startup = this._register(new RunOnceScheduler(() => { void this.checkForUpdates(false); }, 8_000));
			startup.schedule();
		}
	}

	async checkForUpdates(explicit = true): Promise<void> {
		if (this.opening || this.prompting || !explicit && this.updateService.state.type !== StateType.Idle) {
			return;
		}
		this.opening = true;
		this.active = explicit;
		try {
			if (explicit) {
				const saved = this.options.saveSkippedVersion?.(undefined);
				if (saved) { await saved; }
				this.skippedVersion = undefined;
			}
			this.publish(this.updateService.state);
			const state = this.updateService.state;
			if (state.type === StateType.Idle) {
				if (explicit) { this.checkTimeout.schedule(); }
				await this.updateService.checkForUpdates(explicit);
				if (this.active && !this.prompting && this.updateService.state === state) {
					await this.showError(localize('desktopUpdateSkipped', "更新检查未启动，请稍后重试。"));
				}
			} else {
				if (state.type === StateType.CheckingForUpdates) {
					this.checkTimeout.schedule();
				}
				if (!this.prompting) { await this.handleState(state, true); }
			}
		} catch (error) {
			if (explicit) { await this.showError(toErrorMessage(error)); }
			else { this.logError(toErrorMessage(error)); }
		} finally {
			this.opening = false;
		}
	}

	private async handleState(state: State, explicit = false): Promise<void> {
		if (state.type !== StateType.CheckingForUpdates) {
			this.checkTimeout.cancel();
		}
		switch (state.type) {
			case StateType.Idle:
				this.active = false;
				if (state.error) {
					await this.showError(state.error);
				} else if (state.notAvailable) {
					await this.prompt({ type: 'info', message: localize('desktopNoUpdates', "当前已是最新版本。") });
				}
				return;
			case StateType.AvailableForDownload: {
				const result = await this.prompt({
					type: 'info',
					message: localize('desktopUpdateAvailable', "发现新版本（{0}），是否更新？", state.update.productVersion ?? state.update.version),
					detail: localize('desktopUpdateDownloadDetail', "确认后将下载更新；安装版会在后台安装，完成后提示重启。"),
					buttons: [localize('desktopUpdateNow', "立即更新"), localize('desktopUpdateLater', "暂不更新")],
					cancelId: 1,
				});
				this.active = result.response === 0;
				if (this.active && this.updateService.state.type === StateType.AvailableForDownload) {
					await this.updateService.downloadUpdate(true);
				}
				return;
			}
			case StateType.Downloaded: {
				if (!explicit) {
					return;
				}
				const result = await this.prompt({
					type: 'info',
					message: localize('desktopUpdateDownloaded', "更新已下载，是否安装？"),
					buttons: [localize('desktopUpdateInstall', "立即安装"), localize('desktopUpdateLater', "暂不更新")],
					cancelId: 1,
				});
				this.active = result.response === 0;
				if (this.active && this.updateService.state.type === StateType.Downloaded) {
					await this.updateService.applyUpdate();
				}
				return;
			}
			case StateType.Ready: {
				const result = await this.prompt({
					type: 'info',
					message: localize('desktopUpdateReady', "更新已安装，是否立即重启？"),
					buttons: [localize('desktopUpdateRestart', "立即重启"), localize('desktopUpdateRestartLater', "稍后重启")],
					cancelId: 1,
				});
				this.active = false;
				if (result.response === 0 && this.updateService.state.type === StateType.Ready) {
					await this.updateService.quitAndInstall();
				}
				return;
			}
			case StateType.Disabled:
				await this.showError(state.reason === DisablementReason.RunningAsAdmin
					? localize('desktopUpdateAdmin', "用户级安装版以管理员身份运行时无法更新，请以普通权限重新启动后重试。")
					: localize('desktopUpdateDisabled', "更新服务已禁用，请检查更新设置和安装配置。"));
				return;
			case StateType.Uninitialized:
				await this.showError(localize('desktopUpdateInitializing', "更新服务尚未就绪，请稍后重试。"));
				return;
			default:
				if (explicit) {
					await this.prompt({
						type: 'info',
						message: state.type === StateType.CheckingForUpdates
							? localize('desktopUpdateChecking', "正在检查更新，请稍候。")
							: localize('desktopUpdateInProgress', "更新正在下载、安装或重启中，请稍候。"),
					});
					if (this.active && this.updateService.state !== state) {
						await this.handleState(this.updateService.state);
					}
				}
		}
	}

	private async prompt(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
		this.prompting = true;
		try {
			return await this.showMessageBox({
				title: localize('desktopUpdateTitle', "检查更新"),
				buttons: [localize('desktopUpdateOk', "确定")],
				noLink: true,
				...options,
			});
		} finally {
			this.prompting = false;
		}
	}

	private async showError(message: string): Promise<void> {
		this.active = false;
		this.checkTimeout.cancel();
		this.errorMessage = message;
		this.presentation = { phase: 'error', failure: this.presentation.phase === 'error' && this.presentation.failure ? this.presentation.failure : classifyDesktopUpdateFailure(message, this.presentation.phase) };
		this.sequence++;
		this.changed.fire(this.snapshot);
		this.logError(message);
		try {
			await this.prompt({ type: 'warning', message: localize('desktopUpdateFailed', "无法完成更新检查或安装。"), detail: message });
		} catch (error) {
			this.logError(toErrorMessage(error));
		}
	}
}
