/*---------------------------------------------------------------------------------------------
 *  remote-control 扩展 —— 远程被控端的 UI 层。
 *
 *  ⚠ 职责边界（关键，务必分清）：
 *   本扩展**只做 UI 与配置**，不承载任何采集/键鼠/WebRTC 逻辑。原因：
 *    - 扩展宿主是 utilityProcess（ELECTRON_RUN_AS_NODE=1），没有 WebContents，
 *      既拿不到 desktopCapturer，也没有 getUserMedia / RTCPeerConnection；
 *    - nut-js 键鼠注入必须在 Electron 主进程。
 *   ⇒ 真正的能力在 `src/vs/sessions/contrib/agentStudio/electron-main/remoteControlChannel.ts`，
 *     由 app.ts 常驻注册。
 *
 *  通信链路（与仓库既有 vox/comfy 模式一致）：
 *    webview → postMessage → 本扩展 → vscode.ipcRenderer.invoke('vscode:sarosRemote*')
 *    → 主进程 RemoteControlChannel
 *   注意：webview 是 iframe，validatedIpcMain 会因其非 main frame 而拒绝调用，
 *   因此**必须由扩展宿主（renderer main frame）中转**，webview 不能直接 invoke。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** 与主进程 RemoteControlChannel 约定的通道名。 */
const IPC = {
	getSources: 'vscode:sarosRemoteGetSources',
	start: 'vscode:sarosRemoteStart',
	stop: 'vscode:sarosRemoteStop',
	checkInput: 'vscode:sarosRemoteCheckInput',
} as const;

/** 访问 preload 暴露的 ipcRenderer 桥（仅 Electron 桌面端可用）。 */
function getIpcBridge(): { invoke(channel: string, ...args: unknown[]): Promise<unknown> } | undefined {
	return (globalThis as unknown as { vscode?: { ipcRenderer?: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } } }).vscode?.ipcRenderer;
}

let statusBarItem: vscode.StatusBarItem | undefined;
let currentPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'sarosRemote.openPanel';
	statusBarItem.text = '$(broadcast) 未被控';
	statusBarItem.tooltip = '远程控制：点击打开被控面板';
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	context.subscriptions.push(
		vscode.commands.registerCommand('sarosRemote.openPanel', () => openPanel(context)),
		vscode.commands.registerCommand('sarosRemote.start', () => void startRemote(context)),
		vscode.commands.registerCommand('sarosRemote.stop', () => void stopRemote(context))
	);
}

export function deactivate(): void {
	currentPanel?.dispose();
	currentPanel = undefined;
}

// ──────────────────────────────── 面板 ────────────────────────────────

function openPanel(context: vscode.ExtensionContext): void {
	if (currentPanel) {
		currentPanel.reveal();
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'sarosRemotePanel',
		'远程控制（被控端）',
		vscode.ViewColumn.Beside,
		{ enableScripts: true, retainContextWhenHidden: true }
	);
	currentPanel = panel;

	panel.webview.html = getHtml(context);

	panel.webview.onDidReceiveMessage(async (msg: { type: string; payload?: unknown }) => {
		switch (msg.type) {
			case 'start': {
				const res = await startRemote(context);
				void panel.webview.postMessage({ type: 'startResult', payload: res });
				break;
			}
			case 'stop': {
				const res = await stopRemote(context);
				void panel.webview.postMessage({ type: 'stopResult', payload: res });
				break;
			}
			case 'getSources': {
				const res = await invokeMain(IPC.getSources, undefined);
				void panel.webview.postMessage({ type: 'sourcesResult', payload: res });
				break;
			}
			case 'checkInput': {
				const res = await invokeMain(IPC.checkInput, undefined);
				void panel.webview.postMessage({ type: 'checkInputResult', payload: res });
				break;
			}
		}
	});

	panel.onDidDispose(() => {
		currentPanel = undefined;
	});
}

// ──────────────────────────────── 主控逻辑 ────────────────────────────────

async function invokeMain(channel: string, payload: unknown): Promise<unknown> {
	const bridge = getIpcBridge();
	if (!bridge) {
		return { ok: false, error: '主进程 IPC 不可用（非 Electron 环境或 preload 未注入）' };
	}
	try {
		return await bridge.invoke(channel, payload);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function resolveConfig(): {
	signalingUrl: string;
	coturnUrl: string;
	deskUserUuid: string;
	maxFramerate: number;
	maxBitrate: number;
} {
	const cfg = vscode.workspace.getConfiguration('sarosRemote');
	return {
		signalingUrl: cfg.get<string>('signalingUrl') ?? 'wss://srs-pull.hsslive.cn',
		coturnUrl: cfg.get<string>('coturnUrl') ?? 'turn:hk.hsslive.cn',
		deskUserUuid: cfg.get<string>('deskUserUuid') ?? '',
		maxFramerate: cfg.get<number>('maxFramerate') ?? 60,
		maxBitrate: cfg.get<number>('maxBitrate') ?? 8000,
	};
}

async function startRemote(context: vscode.ExtensionContext): Promise<unknown> {
	const cfg = resolveConfig();

	// 设备码留空时生成一个稳定的本机标识并写回全局配置。
	let deskUserUuid = cfg.deskUserUuid;
	if (!deskUserUuid) {
		deskUserUuid = context.globalState.get<string>('sarosRemote.deskUserUuid') ?? generateDeviceCode();
		await context.globalState.update('sarosRemote.deskUserUuid', deskUserUuid);
		await vscode.workspace.getConfiguration('sarosRemote').update('deskUserUuid', deskUserUuid, vscode.ConfigurationTarget.Global);
	}

	const res = await invokeMain(IPC.start, {
		signalingUrl: cfg.signalingUrl,
		coturnUrl: cfg.coturnUrl,
		deskUserUuid,
		maxFramerate: cfg.maxFramerate,
		maxBitrate: cfg.maxBitrate,
	}) as { ok: boolean; error?: string };

	if (res?.ok) {
		setStatus('$(broadcast) 被控中', '远程控制：正在被控，点击打开面板');
	} else {
		void vscode.window.showErrorMessage(`启动被控失败：${res?.error ?? '未知错误'}`);
	}
	return res;
}

async function stopRemote(_context: vscode.ExtensionContext): Promise<unknown> {
	const res = await invokeMain(IPC.stop, undefined) as { ok: boolean; error?: string };
	if (res?.ok) {
		setStatus('$(broadcast) 未被控', '远程控制：点击打开被控面板');
	}
	return res;
}

function setStatus(text: string, tooltip: string): void {
	if (!statusBarItem) {
		return;
	}
	statusBarItem.text = text;
	statusBarItem.tooltip = tooltip;
}

function generateDeviceCode(): string {
	const chars = '0123456789';
	let code = '';
	for (let i = 0; i < 9; i++) {
		code += chars[Math.floor(Math.random() * chars.length)];
	}
	return code;
}

// ──────────────────────────────── 面板 HTML ────────────────────────────────

function getHtml(context: vscode.ExtensionContext): string {
	const cfg = resolveConfig();
	const safeCfg = JSON.stringify(cfg).replace(/</g, '\\u003c');

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>远程控制（被控端）</title>
<style>
	body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
	h2 { margin-top: 0; }
	.row { margin: 10px 0; }
	button {
		background: var(--vscode-button-background); color: var(--vscode-button-foreground);
		border: none; padding: 6px 14px; cursor: pointer; margin-right: 8px;
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
	code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; }
	#log { margin-top: 14px; white-space: pre-wrap; font-size: 12px; opacity: .85; }
	.status { font-weight: 600; }
</style>
</head>
<body>
<h2>远程控制（被控端）</h2>
<div class="row">设备码：<code id="uuid">${escapeHtml(cfg.deskUserUuid || '(启动后生成)')}</code></div>
<div class="row">信令：<code>${escapeHtml(cfg.signalingUrl)}</code></div>
<div class="row">状态：<span class="status" id="status">未启动</span></div>
<div class="row">
	<button id="btnStart">启动被控</button>
	<button id="btnStop">停止被控</button>
	<button id="btnCheck">键鼠自检</button>
</div>
<div id="log"></div>

<script>
	const vscodeApi = acquireVsCodeApi();
	const cfg = ${safeCfg};

	function log(msg) {
		document.getElementById('log').textContent += msg + '\\n';
	}
	function setStatus(s) { document.getElementById('status').textContent = s; }

	document.getElementById('btnStart').onclick = () => {
		log('启动中...'); setStatus('启动中');
		vscodeApi.postMessage({ type: 'start' });
	};
	document.getElementById('btnStop').onclick = () => {
		log('停止中...'); setStatus('停止中');
		vscodeApi.postMessage({ type: 'stop' });
	};
	document.getElementById('btnCheck').onclick = () => {
		log('检查 nut-js 键鼠注入...');
		vscodeApi.postMessage({ type: 'checkInput' });
	};

	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg || !msg.type) { return; }
		if (msg.type === 'startResult') {
			const p = msg.payload || {};
			log('启动结果：' + (p.ok ? '成功' : ('失败 - ' + (p.error || '未知'))));
			setStatus(p.ok ? '被控中' : '启动失败');
		} else if (msg.type === 'stopResult') {
			const p = msg.payload || {};
			log('停止结果：' + (p.ok ? '已停止' : ('失败 - ' + (p.error || '未知'))));
			setStatus(p.ok ? '未启动' : '停止失败');
		} else if (msg.type === 'checkInputResult') {
			const p = msg.payload || {};
			log('键鼠自检：' + (p.ok ? 'nut-js 可用（mouse=' + p.hasMouse + ' keyboard=' + p.hasKeyboard + '）' : ('不可用 - ' + (p.error || '未知'))));
		} else if (msg.type === 'sourcesResult') {
			const p = msg.payload || {};
			log('屏幕源：' + ((p.sources || []).length) + ' 个');
		}
	});
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
