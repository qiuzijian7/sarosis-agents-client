/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh 宿主（完整面板视图、聊天框 instance）共用的状态区：
 * 按 Host 状态渲染提示与按钮（启动 / 一键准备 / 重试 / 日志 / 设置）。
 */

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDshHostStatus } from '../common/dshHarness.js';
import { DSH_COMMAND_OPEN_SETTINGS, DSH_COMMAND_RESTART_HOST, DSH_COMMAND_SHOW_LOG } from './dshCommands.js';
import { IDshHarnessService } from './dshHarnessService.js';

export class DshStatusBox {

	/** 当前渲染的 starting 状态详情行：启动阶段进度事件直接更新它（不触发整框重渲染）。 */
	private _startingDetail: HTMLElement | undefined;

	constructor(
		private readonly _dsh: IDshHarnessService,
		private readonly _commands: ICommandService,
		private readonly _log: ILogService,
	) {
		_dsh.onDidProgress(text => {
			if (this._startingDetail?.isConnected) {
				this._startingDetail.textContent = text;
			}
		});
	}

	render(box: HTMLElement, status: IDshHostStatus): void {
		clearNode(box);
		const title = append(box, $('div'));
		title.style.cssText = 'font-size:14px;color:var(--vscode-foreground);';
		const detail = append(box, $('div'));
		detail.style.cssText = 'max-width:640px;white-space:pre-wrap;word-break:break-word;font-size:12px;';
		this._startingDetail = status.state === 'starting' ? detail : undefined;
		switch (status.state) {
			case 'starting':
				title.textContent = localize('dshHarness.status.starting', "正在启动 DeepSeek Harness…");
				detail.textContent = localize('dshHarness.status.startingDetail', "首次启动会初始化专属 profile 并安装伴生插件，可能需要几十秒。");
				break;
			case 'stopping':
				title.textContent = localize('dshHarness.status.stopping', "正在停止 DeepSeek Harness…");
				break;
			case 'stopped':
				title.textContent = localize('dshHarness.status.stopped', "DeepSeek Harness 未运行");
				this._button(box, localize('dshHarness.action.start', "启动"), () => this._dsh.ensureStarted());
				break;
			case 'error':
				if (status.errorCode === 'node-missing' || status.errorCode === 'dsh-missing') {
					// 缺运行环境：给出一键准备（只补缺的部分），而不是让用户自己去装。
					title.textContent = localize('dshHarness.status.needSetup', "需要准备 DeepSeek Harness 运行环境");
					detail.textContent = status.errorCode === 'node-missing'
						? localize('dshHarness.status.needNode', "没有找到 Node 22.19+ / 24+。VsSaros 可以下载一份便携 Node（约 30 MB，校验 SHA-256），只供 dsh 使用，不改系统环境；如果也没有安装 dsh，会接着从 npm 安装最新版本。")
						: localize('dshHarness.status.needDsh', "没有找到 dsh。VsSaros 会从 npm 安装 @deepseek-ai/dsh 的最新版本到自己的托管目录（首次约 1–2 分钟），不安装到全局。");
					this._button(box, localize('dshHarness.action.bootstrap', "自动准备并启动"), () => this._runBootstrap(box, detail));
					this._button(box, localize('dshHarness.action.settings', "打开设置"), () => this._commands.executeCommand(DSH_COMMAND_OPEN_SETTINGS));
					break;
				}
				title.textContent = localize('dshHarness.status.error', "DeepSeek Harness 启动失败");
				detail.textContent = status.error ?? '';
				this._button(box, localize('dshHarness.action.retry', "重试"), () => this._commands.executeCommand(DSH_COMMAND_RESTART_HOST));
				this._button(box, localize('dshHarness.action.log', "查看日志"), () => this._commands.executeCommand(DSH_COMMAND_SHOW_LOG));
				this._button(box, localize('dshHarness.action.settings', "打开设置"), () => this._commands.executeCommand(DSH_COMMAND_OPEN_SETTINGS));
				break;
			case 'running':
				title.textContent = localize('dshHarness.status.loading', "正在加载页面…");
				break;
		}
	}

	private async _runBootstrap(box: HTMLElement, detail: HTMLElement): Promise<void> {
		for (const b of box.querySelectorAll('button')) {
			(b as HTMLButtonElement).disabled = true;
		}
		const sub = this._dsh.onDidProgress(text => detail.textContent = text);
		try {
			const s = await this._dsh.bootstrap();
			if (s.state === 'error') {
				this.render(box, s);
			}
		} catch (e) {
			this.render(box, { state: 'error', bridge: 'none', error: String((e as Error)?.message ?? e), errorCode: 'start-failed' });
		} finally {
			sub.dispose();
		}
	}

	private _button(box: HTMLElement, label: string, run: () => unknown): void {
		const b = append(box, $('button.monaco-button.monaco-text-button')) as HTMLButtonElement;
		b.textContent = label;
		b.style.cssText = 'padding:4px 14px;cursor:pointer;';
		b.onclick = () => void Promise.resolve(run()).catch(e => this._log.error('[dshHarness] action failed', e));
	}
}
