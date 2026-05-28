/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { IAgentPlugin } from '../../../../../workbench/contrib/chat/common/plugins/agentPluginService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../../nls.js';

const { $: $$ } = DOM;

/**
 * Render the Knot CLI status section for knot-agui plugin detail page.
 * This section shows whether knot CLI is installed and provides install/recheck buttons.
 */
export function renderKnotCliSection(
	plugin: IAgentPlugin,
	commandService: ICommandService,
	configurationService: IConfigurationService,
	configFieldValues: Map<string, unknown>,
): HTMLElement {
	const section = $$('div.plugin-detail-section');
	const sectionTitle = $$('h2.plugin-detail-section-title');
	sectionTitle.textContent = localize('knotCli', 'Knot CLI');
	section.appendChild(sectionTitle);

	const card = $$('div.plugin-detail-cli-card');

	// Status row: badge + summary text
	const statusRow = $$('div.plugin-detail-cli-status-row');
	const badge = $$('span.plugin-detail-cli-badge.checking');
	badge.textContent = localize('knotCli.checking', '检查中…');
	statusRow.appendChild(badge);

	const summary = $$('span.plugin-detail-cli-summary');
	summary.textContent = localize('knotCli.detectingMsg', '正在检测 knot-cli 是否已安装…');
	statusRow.appendChild(summary);
	card.appendChild(statusRow);

	// Detail line: version / path / error
	const detail = $$('div.plugin-detail-cli-detail');
	card.appendChild(detail);

	// Description
	const desc = $$('div.plugin-detail-cli-desc');
	desc.appendChild(document.createTextNode(localize(
		'knotCli.desc',
		'Knot CLI 是 Knot 平台官方命令行工具，用于在终端 / CI 环境直接调用智能体。详情见 ',
	)));
	const docLink = document.createElement('a');
	docLink.className = 'plugin-detail-config-link';
	docLink.textContent = 'iwiki.woa.com/p/4016884620';
	docLink.href = 'https://iwiki.woa.com/p/4016884620';
	docLink.title = 'https://iwiki.woa.com/p/4016884620';
	docLink.onclick = (e) => {
		e.preventDefault();
		window.open('https://iwiki.woa.com/p/4016884620', '_blank', 'noopener');
	};
	desc.appendChild(docLink);
	desc.appendChild(document.createTextNode('。'));
	card.appendChild(desc);

	// Action buttons
	const actions = $$('div.plugin-detail-cli-actions');
	const recheckBtn = $$('button.plugin-detail-config-save-btn.secondary') as HTMLButtonElement;
	recheckBtn.textContent = localize('knotCli.recheck', '重新检测');
	actions.appendChild(recheckBtn);

	const installBtn = $$('button.plugin-detail-config-save-btn') as HTMLButtonElement;
	installBtn.textContent = localize('knotCli.install', '安装 Knot CLI');
	actions.appendChild(installBtn);

	card.appendChild(actions);

	// Inline status / hint message
	const msg = $$('div.plugin-detail-cli-msg');
	card.appendChild(msg);

	section.appendChild(card);

	// Helper: render current detection result into the badge / summary / detail rows.
	const applyStatus = (status: { installed: boolean; version?: string; path?: string; error?: string } | undefined, errorText?: string): void => {
		badge.classList.remove('checking', 'installed', 'missing', 'error');
		if (errorText) {
			badge.classList.add('error');
			badge.textContent = localize('knotCli.errorBadge', '检测失败');
			summary.textContent = errorText;
			detail.textContent = '';
			installBtn.disabled = false;
			return;
		}
		if (!status) {
			badge.classList.add('checking');
			badge.textContent = localize('knotCli.checking', '检查中…');
			summary.textContent = '';
			detail.textContent = '';
			return;
		}
		if (status.installed) {
			badge.classList.add('installed');
			badge.textContent = localize('knotCli.installedBadge', '已安装');
			summary.textContent = status.version
				? localize('knotCli.installedSummary', 'knot-cli 已就绪：{0}', status.version)
				: localize('knotCli.installedSummaryNoVer', 'knot-cli 已就绪');
			detail.textContent = status.path ? `${status.path}` : '';
			installBtn.textContent = localize('knotCli.reinstall', '重新安装');
		} else {
			badge.classList.add('missing');
			badge.textContent = localize('knotCli.missingBadge', '未安装');
			summary.textContent = localize('knotCli.missingSummary', '未在 PATH 与常见目录中检测到 knot-cli。');
			detail.textContent = status.error ? localize('knotCli.lastError', '上次错误：{0}', status.error) : '';
			installBtn.textContent = localize('knotCli.install', '安装 Knot CLI');
		}
	};

	const setMsg = (text: string, kind: 'info' | 'success' | 'error' | '' = ''): void => {
		msg.textContent = text;
		msg.className = 'plugin-detail-cli-msg' + (kind ? ' ' + kind : '');
	};

	const runCheck = async (): Promise<void> => {
		recheckBtn.disabled = true;
		installBtn.disabled = true;
		applyStatus(undefined);
		try {
			const status = await commandService.executeCommand<{ installed: boolean; version?: string; path?: string; error?: string }>('knot.checkCli');
			applyStatus(status ?? { installed: false, error: 'no result' });
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			applyStatus(undefined, errMsg);
		} finally {
			recheckBtn.disabled = false;
			installBtn.disabled = false;
		}
	};

	recheckBtn.onclick = () => { void runCheck(); };

	installBtn.onclick = async () => {
		// Pull token from the in-memory config field map (so user need not save first)
		// or fall back to the persisted setting.
		let token = '';
		for (const [k, v] of configFieldValues.entries()) {
			if (k.endsWith('.token')) {
				token = String(v ?? '').trim();
				break;
			}
		}
		if (!token) {
			token = String(configurationService.getValue('knot.token') ?? '').trim();
		}
		if (!token) {
			setMsg(localize(
				'knotCli.tokenMissing',
				'⚠️ 请先在下方 Configuration 中填写并保存 Knot Token，然后再点击安装。',
			), 'error');
			return;
		}
		installBtn.disabled = true;
		recheckBtn.disabled = true;
		setMsg(localize('knotCli.installing', '🔄 已在终端中启动安装命令，请在打开的终端中查看进度。安装完成后请点击「重新检测」。'), 'info');
		try {
			const result = await commandService.executeCommand<{ ok: boolean; message: string }>('knot.installCli', token);
			if (result?.ok) {
				setMsg(localize(
					'knotCli.installLaunched',
					'✅ 安装命令已下发到终端。完成后请执行 source ~/.bashrc 或新开终端，再点击「重新检测」。',
				), 'success');
				// Schedule an automatic re-check shortly, in case install finishes quickly.
				setTimeout(() => { void runCheck(); }, 8000);
			} else {
				setMsg(localize('knotCli.installFailed', '⚠️ 安装启动失败：{0}', result?.message || 'unknown'), 'error');
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			setMsg(localize('knotCli.installError', '⚠️ 安装出错：{0}', errMsg), 'error');
		} finally {
			installBtn.disabled = false;
			recheckBtn.disabled = false;
		}
	};

	// Initial check on render
	void runCheck();

	return section;
}
