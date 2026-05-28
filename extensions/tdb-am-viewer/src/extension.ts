/*---------------------------------------------------------------------------------------------
 *  TDB-AM Viewer — extension entry.
 *
 *  Responsibilities (post-slim):
 *    1. Read configuration.
 *    2. Start in-process Knot → OpenAI bridge (port = tdbam.knotBridgePort).
 *    3. Verify the TDB-AM gateway (started by tdb-am-gateway extension) is alive.
 *    4. Register operational commands: restart / stop / healthCheck.
 *
 *  The L0/L1/L2/L3 memory UI has migrated to the Sessions ViewPane
 *  (`src/vs/sessions/contrib/tdbam/browser/tdbamViewPane.ts`); this extension
 *  no longer ships its own TreeView / detail webview to avoid a duplicate UI.
 *
 *  We DO NOT touch any other extension. Failure of any step is logged but
 *  does not throw out of activate().
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { KnotBridge } from './knotBridge.js';

let bridge: KnotBridge | undefined;
let output: vscode.OutputChannel | undefined;

interface ResolvedConfig {
	gatewayPort: number;
	knotBridgePort: number;
	knotEndpoint: string;
	knotToken: string;
	knotUser: string;
	knotAgentId: string;
	dataDir: string;
	recallStrategy: 'keyword' | 'hybrid' | 'embedding';
	autoStart: boolean;
}

function readConfig(): ResolvedConfig {
	const tdbam = vscode.workspace.getConfiguration('tdbam');
	const knot = vscode.workspace.getConfiguration('knot');
	const knotAgentsRaw = knot.get<unknown[]>('agents') ?? [];
	const firstAgentId = (knotAgentsRaw[0] as { id?: string } | undefined)?.id ?? '';
	return {
		gatewayPort: tdbam.get<number>('gatewayPort') ?? 8420,
		knotBridgePort: tdbam.get<number>('knotBridgePort') ?? 8421,
		knotEndpoint: knot.get<string>('endpoint') ?? 'https://knot.woa.com',
		knotToken: knot.get<string>('token') ?? '',
		knotUser: knot.get<string>('user') ?? '',
		knotAgentId: tdbam.get<string>('knotAgentId') || firstAgentId,
		dataDir: tdbam.get<string>('dataDir') ?? '',
		recallStrategy: (tdbam.get<string>('recallStrategy') as 'keyword' | 'hybrid' | 'embedding') ?? 'keyword',
		autoStart: tdbam.get<boolean>('autoStart') ?? true,
	};
}

async function bootServices(cfg: ResolvedConfig): Promise<void> {
	if (!output) return;

	if (!cfg.knotToken) {
		output.appendLine('[boot] knot.token 未配置，Knot 桥仍会启动但调用会被 Knot 拒绝。');
	}
	if (!cfg.knotAgentId) {
		output.appendLine('[boot] tdbam.knotAgentId 未配置（也未在 knot.agents 找到默认 agent）。L1/L2/L3 抽取将失败。');
	}

	bridge = new KnotBridge({
		port: cfg.knotBridgePort,
		knotEndpoint: cfg.knotEndpoint,
		knotToken: cfg.knotToken,
		knotUser: cfg.knotUser,
		knotAgentId: cfg.knotAgentId,
		logger: msg => output!.appendLine(msg),
	});
	try {
		await bridge.start();
	} catch (err) {
		output.appendLine(`[boot] knot bridge 启动失败：${(err as Error).message}`);
		bridge = undefined;
	}

	// 内嵌网关由 tdb-am-gateway 扩展自动启动，这里只检查健康状态
	output.appendLine('[boot] 等待内嵌网关就绪...');
	try {
		const healthUrl = `http://127.0.0.1:${cfg.gatewayPort}/health`;
		const resp = await fetch(healthUrl);
		if (resp.ok) {
			output.appendLine('[boot] 内嵌网关已就绪');
		} else {
			output.appendLine('[boot] 内嵌网关健康检查失败');
		}
	} catch (err) {
		output.appendLine(`[boot] 内嵌网关连接失败：${(err as Error).message}`);
	}
}

async function shutdownServices(): Promise<void> {
	try { await bridge?.stop(); } catch { /* best effort */ }
	bridge = undefined;
	// 内嵌网关由 tdb-am-gateway 扩展自行管理，这里只停止 Knot 桥
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	output = vscode.window.createOutputChannel('TDB-AM Viewer');
	context.subscriptions.push(output);
	output.appendLine('[activate] tdb-am-viewer starting (slim mode, UI moved to ViewPane)...');

	const cfg = readConfig();

	context.subscriptions.push(
		vscode.commands.registerCommand('tdb-am-viewer.restartServices', async () => {
			await shutdownServices();
			await bootServices(readConfig());
		}),
		vscode.commands.registerCommand('tdb-am-viewer.stopServices', async () => {
			await shutdownServices();
			vscode.window.showInformationMessage('Knot 桥已停止（内嵌网关继续运行）');
		}),
		vscode.commands.registerCommand('tdb-am-viewer.healthCheck', async () => {
			const gwUrl = `http://127.0.0.1:${cfg.gatewayPort}/health`;
			const bridgeUrl = `http://127.0.0.1:${cfg.knotBridgePort}/v1/models`;
			const gw = await fetch(gwUrl).then(r => r.ok).catch(() => false);
			const br = await fetch(bridgeUrl).then(r => r.ok).catch(() => false);
			vscode.window.showInformationMessage(
				`内嵌网关(${cfg.gatewayPort}): ${gw ? '✅' : '❌'}   Knot Bridge(${cfg.knotBridgePort}): ${br ? '✅' : '❌'}`
			);
		}),
	);

	context.subscriptions.push({ dispose: () => { void shutdownServices(); } });

	if (cfg.autoStart) {
		void bootServices(cfg).then(() => {
			output?.appendLine('[activate] boot complete');
		});
	} else {
		output.appendLine('[activate] tdbam.autoStart=false，跳过自动拉起。可通过命令面板 "TDB-AM: 重启服务" 手动启动。');
	}
}

export async function deactivate(): Promise<void> {
	await shutdownServices();
}
