/*---------------------------------------------------------------------------------------------
 *  TOF Authentication — 扩展入口
 *
 *  在扩展宿主进程注册 'tof' 身份提供者。扩展宿主是 Node 环境，
 *  LoopbackAuthServer 和 whoami 调用都直接用 Node http，没有
 *  渲染进程的 sandbox / Mixed Content / CORS 限制。
 *
 *  渲染进程通过 vscode.authentication.getSession('tof', [], { createIfNone: true })
 *  触发本扩展的 createSession()。
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { TofAuthenticationProvider } from './tofAuthProvider';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new TofAuthenticationProvider(context);

	context.subscriptions.push(
		vscode.authentication.registerAuthenticationProvider(
			'tof',
			'腾讯 OA (TOF)',
			provider,
			{ supportsMultipleAccounts: false }
		)
	);
	context.subscriptions.push(provider);
}

export function deactivate(): void {
	// provider 在 context.subscriptions 中，会被自动 dispose
}
