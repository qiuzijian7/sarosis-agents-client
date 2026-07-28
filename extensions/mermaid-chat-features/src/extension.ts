/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { registerChatSupport } from './chatOutputRenderer';
import { MermaidEditorManager } from './editorManager';
import { MermaidWebviewManager } from './webviewManager';


export function activate(context: vscode.ExtensionContext) {
	const webviewManager = new MermaidWebviewManager();

	const editorManager = new MermaidEditorManager(context.extensionUri, webviewManager);
	context.subscriptions.push(editorManager);

	// Register chat support
	context.subscriptions.push(registerChatSupport(context, webviewManager, editorManager));

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('_mermaid-chat.resetPanZoom', (ctx?: { mermaidWebviewId?: string }) => {
			webviewManager.resetPanZoom(ctx?.mermaidWebviewId);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('_mermaid-chat.copySource', (ctx?: { mermaidWebviewId?: string }) => {
			const webviewInfo = ctx?.mermaidWebviewId ? webviewManager.getWebview(ctx.mermaidWebviewId) : webviewManager.activeWebview;
			if (webviewInfo) {
				vscode.env.clipboard.writeText(webviewInfo.mermaidSource);
			}
		})
	);

	// 公共命令：外部（如 agent 工具卡片）打开指定源码的 Mermaid 预览
	context.subscriptions.push(
		vscode.commands.registerCommand('_mermaid-chat.openPreview', (markup: string, title?: string) => {
			if (typeof markup !== 'string' || !markup.trim()) {
				vscode.window.showWarningMessage('Mermaid 源码为空，无法预览');
				return;
			}
			editorManager.openPreview(markup, title || 'Mermaid 预览');
		})
	);
}
