import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('Agent Studio extension activated');

	// 注册命令：打开 Agent Studio
	const openCommand = vscode.commands.registerCommand('agentStudio.open', async () => {
		await openAgentStudio();
	});

	context.subscriptions.push(openCommand);

	// [Sarosis] Auto-open disabled — native Agent Studio ViewPane in ChatBar replaces this.
	// The Simple Browser approach is kept only for the manual command `agentStudio.open`.
	// const config = vscode.workspace.getConfiguration('agentStudio');
	// if (config.get('openOnStartup', false)) {
	// 	setTimeout(async () => { await openAgentStudio(); }, 2000);
	// }
}

async function openAgentStudio(): Promise<void> {
	const config = vscode.workspace.getConfiguration('agentStudio');
	const url = config.get<string>('url', 'http://localhost:3000/dashboard');

	// 方法 1：使用 Simple Browser 打开（如果可用）
	try {
		await vscode.commands.executeCommand('simpleBrowser.show', url);
		return;
	} catch (error) {
		console.log('Simple Browser not available, trying webview...');
	}

	// 方法 2：创建 Webview 面板
	const panel = vscode.window.createWebviewPanel(
		'agentStudio',
		'Agent Studio',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			enableCommandUris: true,
		}
	);

	// 设置 Webview 内容：加载 Agent Studio URL
	panel.webview.html = `
	<!DOCTYPE html>
	<html>
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Agent Studio</title>
		<style>
			body {
				margin: 0;
				padding: 0;
				height: 100vh;
				overflow: hidden;
			}
			iframe {
				width: 100%;
				height: 100%;
				border: none;
			}
		</style>
	</head>
	<body>
		<iframe src="${url}" allow="clipboard-read; clipboard-write"></iframe>
	</body>
	</html>
	`;
}

export function deactivate() {}
