/*---------------------------------------------------------------------------------------------
 *  LightAI 侧边栏状态面板（WebviewView）
 *
 *  插件详情页的「登录按钮」在 VsSaros 里是内核硬编码特例（见
 *  pluginDetailEditorPane.ts 中 `if (plugin.label === 'codebuddy-provider')`），
 *  新增同类按钮需要改内核。为保持「零内核改动」，这里改用扩展自带的
 *  WebviewView（`contributes.views`）承载登录按钮与参数展示——
 *  完全由本扩展拥有，行为与 CodeBuddy 的登录按钮一致（点击执行命令）。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const LIGHTAI_VIEW_ID = 'lightaiStatus';

function cfg<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration().get<T>(`lightai.${key}`, fallback);
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export class LightAIStatusView implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.onDidReceiveMessage(async (msg) => {
			switch (msg?.command) {
				case 'login':
					await vscode.commands.executeCommand('lightai.login');
					break;
				case 'logout':
					await vscode.commands.executeCommand('lightai.logout');
					break;
				case 'refresh':
					this.refresh();
					break;
				case 'openSettings':
					await vscode.commands.executeCommand('workbench.action.openSettings', 'lightai');
					break;
				case 'fetchModels':
					await vscode.commands.executeCommand('lightai.refreshModels');
					break;
			}
		});
		this.refresh();
	}

	refresh(): void {
		if (this._view) {
			this._view.webview.html = this._html();
		}
	}

	private _html(): string {
		const cookie = cfg<string>('cookie', '');
		const userId = cfg<string>('userId', '');
		const loggedIn = !!cookie && !!userId;
		const endpoint = cfg<string>('floodApiBase', 'https://lightai-lightflood-v1-sd.aigclsp.com');

		const list = (key: 'imageModels' | 'videoModels' | 'model3dModels' | 'audioModels'): string =>
			(cfg<string[]>(key, []) || []).join(', ') || '—';

		const rows: Array<[string, string]> = [
			['状态', loggedIn ? '已登录' : '未登录'],
			['用户 (x-user-id)', userId || '—'],
			['应用 ID', cfg<string>('appId', '') || '—'],
			['应用名称', cfg<string>('appName', '') || '—'],
			['项目 ID', cfg<string>('bizId', '') || '—'],
			['项目名称', cfg<string>('projectName', '') || '—'],
			['图片模型', list('imageModels')],
			['视频模型', list('videoModels')],
			['3D 模型', list('model3dModels')],
			['音频模型', list('audioModels')],
			['端点', endpoint],
		];

		const rowsHtml = rows
			.map(
				([k, v]) =>
					`<div class="row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`,
			)
			.join('');

		const cookieMasked = cookie
			? cookie.replace(/(sessionid=)([^;]{4})[^;]*/, '$1$2****')
			: '—';

		return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<style>
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 10px; }
	.badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; margin-bottom:10px; }
	.on  { background: var(--vscode-testing-iconPassed); color:#000; }
	.off { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }
	.row { display:flex; justify-content:space-between; gap:8px; padding:4px 0; border-bottom:1px solid var(--vscode-panel-border); }
	.k { color: var(--vscode-descriptionForeground); flex:0 0 auto; }
	.v { text-align:right; word-break:break-all; }
	button {
		width:100%; margin-top:8px; padding:6px 10px; cursor:pointer;
		background: var(--vscode-button-background); color: var(--vscode-button-foreground);
		border:none; border-radius:4px;
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button:disabled { opacity:.5; cursor:default; }
	.hint { color: var(--vscode-descriptionForeground); font-size:11px; margin-top:10px; line-height:1.5; }
</style>
</head>
<body>
	<span class="badge ${loggedIn ? 'on' : 'off'}">${loggedIn ? '已登录' : '未登录'}</span>
	${rowsHtml}
	<div class="row"><span class="k">Cookie</span><span class="v">${escapeHtml(cookieMasked)}</span></div>

	<button id="login" ${loggedIn ? 'disabled' : ''}>登录（自动获取 Cookie / User ID）</button>
	<button id="fetch" class="secondary" ${loggedIn ? '' : 'disabled'}>获取模型信息</button>
	<button id="logout" class="secondary" ${loggedIn ? '' : 'disabled'}>登出</button>
	<button id="settings" class="secondary">打开设置</button>

	<div class="hint">
		点击「登录」会打开浏览器，完成一次 Oasis/QQ 登录后自动抓取会话 Cookie、
		User ID，并从 k 参数回填应用/项目信息。登录态保存在扩展 profile 中，之后可静默复用。
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		document.getElementById('login').onclick = () => vscode.postMessage({ command:'login' });
		document.getElementById('fetch').onclick = () => vscode.postMessage({ command:'fetchModels' });
		document.getElementById('logout').onclick = () => vscode.postMessage({ command:'logout' });
		document.getElementById('settings').onclick = () => vscode.postMessage({ command:'openSettings' });
	</script>
</body>
</html>`;
	}
}
