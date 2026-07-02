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
 * Render the CodeBuddy Auth status section for codebuddy-provider plugin detail page.
 * This section shows login status and provides login/logout buttons.
 */
export function renderCodebuddyAuthSection(
	plugin: IAgentPlugin,
	commandService: ICommandService,
	configurationService: IConfigurationService,
	rerender: () => void,
): HTMLElement {
	const section = $$('div.plugin-detail-section');
	const sectionTitle = $$('h2.plugin-detail-section-title');
	sectionTitle.textContent = localize('codebuddyAuth', 'Login Status');
	section.appendChild(sectionTitle);

	const card = $$('div.plugin-detail-cli-card');

	// Read current status from configuration
	const statusValue = String(configurationService.getValue('codebuddy.status') ?? '未登录');
	const isLoggedIn = statusValue.includes('已登录') && !statusValue.includes('未登录');

	// Status row: badge + summary text
	const statusRow = $$('div.plugin-detail-cli-status-row');
	const badge = $$('span.plugin-detail-cli-badge');
	if (isLoggedIn) {
		badge.classList.add('installed');
		badge.textContent = localize('codebuddy.loggedIn', '已登录');
	} else {
		badge.classList.add('missing');
		badge.textContent = localize('codebuddy.loggedOut', '未登录');
	}
	statusRow.appendChild(badge);

	const summary = $$('span.plugin-detail-cli-summary');
	summary.textContent = isLoggedIn
		? localize('codebuddy.loggedInSummary', 'CodeBuddy 已认证，可正常使用。')
		: localize('codebuddy.loggedOutSummary', '请登录 CodeBuddy 以使用 AI 聊天功能。');
	statusRow.appendChild(summary);
	card.appendChild(statusRow);

	// Detail line: show user info if logged in
	const detail = $$('div.plugin-detail-cli-detail');
	if (isLoggedIn) {
		const user = String(configurationService.getValue('codebuddy.user') ?? '');
		if (user) {
			detail.textContent = localize('codebuddy.loggedInUser', '用户：{0}', user);
		}
	}
	card.appendChild(detail);

	// Description
	const desc = $$('div.plugin-detail-cli-desc');
	if (!isLoggedIn) {
		desc.appendChild(document.createTextNode(localize(
				'codebuddy.authDesc',
				'未登录时，CodeBuddy 不会出现在聊天 Provider 选择器中。登录成功后自动显示。前往 ',
		)));
		const docLink = document.createElement('a');
		docLink.className = 'plugin-detail-config-link';
		docLink.textContent = 'copilot.tencent.com';
		docLink.href = 'https://copilot.tencent.com';
		docLink.title = 'https://copilot.tencent.com';
		docLink.onclick = (e) => {
			e.preventDefault();
			window.open('https://copilot.tencent.com', '_blank', 'noopener');
		};
		desc.appendChild(docLink);
		desc.appendChild(document.createTextNode(' 获取更多信息。'));
	}
	card.appendChild(desc);

	// Action buttons
	const actions = $$('div.plugin-detail-cli-actions');

	const loginBtn = $$('button.plugin-detail-config-save-btn') as HTMLButtonElement;
	const logoutBtn = $$('button.plugin-detail-config-save-btn.secondary') as HTMLButtonElement;

	loginBtn.textContent = localize('codebuddy.login', '登录 (iOA SSO)');
	logoutBtn.textContent = localize('codebuddy.logout', '登出');

	if (isLoggedIn) {
		loginBtn.disabled = true;
	} else {
		logoutBtn.disabled = true;
	}

	actions.appendChild(loginBtn);
	actions.appendChild(logoutBtn);
	card.appendChild(actions);

	// Inline status / hint message
	const msg = $$('div.plugin-detail-cli-msg');
	card.appendChild(msg);

	const setMsg = (text: string, kind: 'info' | 'success' | 'error' | '' = ''): void => {
		msg.textContent = text;
		msg.className = 'plugin-detail-cli-msg' + (kind ? ' ' + kind : '');
	};

	loginBtn.onclick = async () => {
		loginBtn.disabled = true;
		logoutBtn.disabled = true;
		setMsg(localize('codebuddy.loggingIn', '正在打开浏览器进行 iOA 登录…'), 'info');
		try {
			await commandService.executeCommand('codebuddy.login');
			setMsg(localize('codebuddy.loginSuccess', '✅ 登录成功！'), 'success');
			// Re-render to update status
			setTimeout(() => { rerender(); }, 1000);
		} catch (err) {
			// Node fetch wraps the real network reason (e.g. ECONNREFUSED on a dead
			// system proxy) in err.cause — surface it so the user can see the
			// underlying problem instead of an opaque "fetch failed".
			const cause = (err as { cause?: { code?: string; message?: string; address?: string; port?: number } })?.cause;
			const baseMsg = err instanceof Error ? err.message : String(err);
			const causeMsg = cause
				? ` (cause: ${cause.code ?? ''} ${cause.message ?? ''}${cause.address ? ` at ${cause.address}:${cause.port}` : ''})`
				: '';
			const fullMsg = baseMsg + causeMsg;
			console.error('[CodeBuddy] login button onclick error:', err, 'cause:', cause);
			setMsg(localize('codebuddy.loginFailed', '❌ 登录失败：{0}', fullMsg), 'error');
			loginBtn.disabled = false;
			logoutBtn.disabled = false;
		}
	};

	logoutBtn.onclick = async () => {
		loginBtn.disabled = true;
		logoutBtn.disabled = true;
		setMsg(localize('codebuddy.loggingOut', '正在登出…'), 'info');
		try {
			await commandService.executeCommand('codebuddy.logout');
			setMsg(localize('codebuddy.logoutSuccess', '已登出。'), 'info');
			// Re-render to update status
			setTimeout(() => { rerender(); }, 500);
		} catch (err) {
			setMsg(localize('codebuddy.logoutFailed', '❌ 登出失败：{0}', err instanceof Error ? err.message : String(err)), 'error');
			loginBtn.disabled = false;
			logoutBtn.disabled = false;
		}
	};

	section.appendChild(card);
	return section;
}
