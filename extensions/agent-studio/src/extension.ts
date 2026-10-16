import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('Agent Studio extension activated');

	// 注册命令：打开 Agent Studio
	const openCommand = vscode.commands.registerCommand('agentStudio.open', async () => {
		await openAgentStudio();
	});

	context.subscriptions.push(openCommand);

	// 打开"未提交改动"的 diff（HEAD ↔ 工作区）—— 2026-10-13，给 dsh 聊天框交付卡的「看改动」按钮用。
	// 返回 true = 已打开 diff；false = 该文件没有未提交改动（或不在 git 仓库里）⇒ 调用方自行回退 ✓。
	const diffCommand = vscode.commands.registerCommand('agentStudio.openUncommittedDiff', (fsPath: string) => openUncommittedDiff(fsPath));
	context.subscriptions.push(diffCommand);

	// ★ 2026-10-14：把这件事拆成"**算**"与"**开**"两步 ——
	//   `getUncommittedDiff` **只算**出两条资源 URI（返回 `toString()` 字符串 ⇒ 可跨扩展宿主边界 ✓），
	//   由**工作台**决定开在哪一组。为什么必须这样拆：`vscode.diff` 会开在**当前活动分组**，
	//   而用户在**聊天列**里点「看改动」⇒ 活动分组就是那条窄的聊天列 ⇒ diff 被挤进聊天框里 ✗✗
	//   （2026-10-14 用户要求：**在文件编辑器窗口中**显示 diff editor pane ✓）。
	//   工作台侧拿不到 git 的 `originalUri`（扩展宿主 API ✗）⇒ 分工只能是"扩展算、工作台开" ✓。
	const getDiffCommand = vscode.commands.registerCommand('agentStudio.getUncommittedDiff', (fsPath: string) => findUncommittedDiff(fsPath));
	context.subscriptions.push(getDiffCommand);

	// [Sarosis] Auto-open disabled — native Agent Studio ViewPane in ChatBar replaces this.
	// The Simple Browser approach is kept only for the manual command `agentStudio.open`.
	// const config = vscode.workspace.getConfiguration('agentStudio');
	// if (config.get('openOnStartup', false)) {
	// 	setTimeout(async () => { await openAgentStudio(); }, 2000);
	// }
}

/**
 * 打开某个文件的「未提交改动」diff（HEAD ↔ 工作区）。
 *
 * **为什么这条命令住在扩展宿主**：dsh 聊天框要的是"这个文件之前长什么样"，而只有 git 知道；而
 * **工作台侧拿不到扩展宿主 API**（`vscode.extensions.getExtension('vscode.git')`）⇒ 只能由扩展代劳 ✓。
 * 代价：改这里要跑扩展编译（`npm run gulp compile-extensions`，或开发时的 `npm run watch` 已含
 * `watch-extensions` ✓）—— 不跑的话工作台那份 `out/extension.js` 还是旧的 ✗。
 *
 * 类型不 import 兄弟扩展：按 git 扩展的**公开 API 类型**写一份最小形状即可（依据
 * `extensions/git/src/api/git.d.ts:111-127` 的 `Change` 与 `:236-247` 的 `Repository` ✓）。
 * 用 `state.indexChanges / workingTreeChanges` 而**不用** `diffWithHEAD(path)`：前者是**同步**的
 * 资源清单（`originalUri` 直接可用 ✓），后者返回 patch **文本**（还要自己落临时文件 ✗）。
 */
async function openUncommittedDiff(fsPath: string): Promise<boolean> {
	const found = await findUncommittedDiff(fsPath);
	if (!found) {
		return false;   // 没有未提交改动 ⇒ 让调用方回退（例如直接打开文件 ✓）
	}
	// ⚠ 这条路径用 `vscode.diff` ⇒ 落在**当前活动分组**（在聊天列里调用时会开进聊天列 ✗）。
	//   要"开在文件编辑区"请用 `agentStudio.getUncommittedDiff` + 工作台自己 openEditor ✓（见 activate 的注释）。
	await vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(found.original), vscode.Uri.parse(found.modified), `${found.name}（未提交改动）`);
	return true;
}

/** 「未提交改动」的两侧资源（`toString()` 形态 ⇒ 可跨扩展宿主边界传给工作台 ✓）。 */
interface IUncommittedDiff {
	/** HEAD 侧（左）。 */
	readonly original: string;
	/** 工作区侧（右）。 */
	readonly modified: string;
	/** 文件名（给 diff 页签标题用 ✓）。 */
	readonly name: string;
}

/**
 * **只算**某文件的「未提交改动」两侧资源，不负责打开。
 *
 * 为什么把"算"和"开"拆开：git 的 `originalUri` 只有扩展宿主拿得到（工作台侧拿不到 ✗），
 * 而"开在哪一组"只有工作台知道（要显式落文件编辑区 `mainPart.activeGroup` ✓）。
 * 两者各做自己那半 ⇒ 才能既拿到 HEAD 内容、又不把 diff 开进聊天列 ✓（2026-10-14 用户要求）。
 */
async function findUncommittedDiff(fsPath: string): Promise<IUncommittedDiff | undefined> {
	if (typeof fsPath !== 'string' || !fsPath.trim()) {
		return undefined;
	}
	interface IGitChange { readonly uri: vscode.Uri; readonly originalUri: vscode.Uri }
	interface IGitRepo {
		readonly rootUri: vscode.Uri;
		readonly state: { readonly indexChanges: readonly IGitChange[]; readonly workingTreeChanges: readonly IGitChange[] };
	}
	interface IGitApi { readonly repositories: readonly IGitRepo[] }
	try {
		const ext = vscode.extensions.getExtension<{ getAPI(version: 1): IGitApi }>('vscode.git');
		if (!ext) {
			return undefined;
		}
		const api = (await ext.activate()).getAPI(1);
		const target = fsPath.toLowerCase();
		for (const repo of api.repositories ?? []) {
			const changes = [...(repo.state.indexChanges ?? []), ...(repo.state.workingTreeChanges ?? [])];
			for (const change of changes) {
				if (change.uri.fsPath.toLowerCase() !== target) {
					continue;
				}
				return {
					original: change.originalUri.toString(),
					modified: change.uri.toString(),
					name: fsPath.replace(/\\/g, '/').split('/').pop() ?? fsPath,
				};
			}
		}
		return undefined;   // 没有未提交改动
	} catch (error) {
		console.warn('[agent-studio] findUncommittedDiff failed:', error);
		return undefined;
	}
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
