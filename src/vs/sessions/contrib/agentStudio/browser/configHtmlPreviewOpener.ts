/*---------------------------------------------------------------------------------------------
 *  ConfigHtml 预览的**共享打开器** —— 设置页（agentSettingsEditorPane）与聊天框
 *  （nativeChatEditorPane 的 onOpenHtmlPreview）共用，保证「按 configHtml 配置启动」
 *  的行为完全一致：探活 → 未运行则拉起（主进程 vscode:configHtmlEnsureServer）→
 *  就绪后打开 URL 预览（UrlPreviewEditorPane）。
 *
 *  ⚠ 不允许任何一侧再各自实现「打开预览」——否则会重演
 *    「设置页按表单开了 URL、聊天框却打开 config.html 文件」的漂移。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { UrlPreviewEditorInput } from './urlPreviewEditorInput.js';
import { buildEnsureSpec, DEFAULT_PANEL_PORT, nativeIpcBridge, normalizePanelUrl, portFromUrl } from '../common/configHtmlConfig.js';

/** server 覆盖项（结构与 AgentConfigHtmlServer / ConfigHtmlServerCfg 一致，走结构类型）。 */
export interface IConfigHtmlServerOverride {
	command?: string;
	args?: string[];
	cwd?: string;
	port?: number;
	healthPath?: string;
	healthExpect?: string;
	readyTimeoutMs?: number;
	env?: Record<string, string>;
}

export interface IEnsureConfigHtmlPreviewDeps {
	/** 面板地址（可缺 scheme，内部 normalizePanelUrl 规范化）。 */
	url: string;
	/** 已保存的 server 配置；未配置的字段用内置默认（node + 仓库内 test-server.mjs）。 */
	server?: IConfigHtmlServerOverride;
	/** 表单端口框实时值（settings 页传，优先于 server.port）。 */
	formPort?: number;
	/** 工作区根（定位内置 test-server.mjs）。 */
	wsRoot: string;
	notificationService: INotificationService;
	logService?: ILogService;
	/**
	 * 可选的模态对话框服务：服务未启动成功（失败/身份不符/异常）时弹**模态**提示，
	 * 确保用户一定看到——右下角 notification 容易被忽略。未提供则只用 notification。
	 */
	dialogService?: { error(message: string): Promise<unknown> };
	/** 打开目标：settings 页开到当前 group；聊天框开到主栏（_openInMainColumn）。 */
	open: (input: EditorInput | { resource: URI }, options?: IEditorOptions) => Promise<unknown>;
}

/**
 * 探活 → 未运行则 spawn（detached + ELECTRON_RUN_AS_NODE）→ 轮询就绪 → 打开 URL 预览。
 * 端口取值优先级：formPort > server.port > url 中端口 > 5600。
 */
export async function ensureConfigHtmlServerAndOpenPreview(deps: IEnsureConfigHtmlPreviewDeps): Promise<void> {
	const url = normalizePanelUrl(deps.url);
	const formPort = Number(deps.formPort ?? NaN);
	const port = (Number.isFinite(formPort) && formPort > 0 ? formPort : undefined)
		?? deps.server?.port
		?? portFromUrl(url)
		?? DEFAULT_PANEL_PORT;
	const server = deps.server ?? {};
	// ★ spec 构造走共享模块：与「启动服务」按钮、webview 侧完全一致。
	const spec = {
		...buildEnsureSpec(url, port, deps.wsRoot),
		// 显式配置了 server 时以配置为准
		...(server.command ? { command: server.command } : {}),
		...(server.args ? { args: server.args } : {}),
		...(server.healthPath ? { healthPath: server.healthPath } : {}),
		...(server.healthExpect ? { healthExpect: server.healthExpect } : {}),
		...(server.readyTimeoutMs ? { readyTimeoutMs: server.readyTimeoutMs } : {}),
		...(server.cwd ? { cwd: server.cwd.replace(/\$\{workspaceRoot\}/g, deps.wsRoot) } : {}),
		...(server.env ? { env: server.env } : {}),
	};

	const previewInput = UrlPreviewEditorInput.getOrCreate(url);
	const bridge = nativeIpcBridge();
	if (!bridge?.ipcRenderer?.invoke) {
		// 无 IPC 通道（非 Electron 环境）→ 直接打开，由页面自行报错
		await deps.open(previewInput, { pinned: true });
		return;
	}

	deps.notificationService.info(`正在启动面板服务 ${url} …`);
	let result: { ok: boolean; alreadyRunning?: boolean; starting?: boolean; error?: string } | undefined;
	try {
		result = await bridge.ipcRenderer.invoke('vscode:configHtmlEnsureServer', spec) as typeof result;
	} catch (err) {
		const msg = `拉起面板服务失败: ${err instanceof Error ? err.message : String(err)}`;
		deps.notificationService.error(msg);
		await deps.dialogService?.error(msg).catch(() => { /* 模态失败则忽略，notification 已弹 */ });
		return;
	}

	if (!result?.ok) {
		// ★ 服务未启动成功 → 弹**模态**提示（含主进程带回的子进程输出尾部），确保用户看到原因
		const msg = `面板服务启动失败：${result?.error ?? '未知错误'}`;
		deps.notificationService.error(msg);
		await deps.dialogService?.error(msg).catch(() => { /* ignore */ });
		return;
	}
	if (result.alreadyRunning) {
		deps.notificationService.info(`面板服务已在运行（${url}）`);
	} else if (result.starting) {
		// 30s 未就绪但进程仍在跑：非模态警告（预览页内有「启动中/重试」提示可跟进）
		deps.notificationService.warn(`面板服务仍在启动中，页面可能需刷新一次：${result.error ?? ''}`);
	} else {
		deps.notificationService.info(`面板服务已就绪（${url}）`);
	}

	await deps.open(previewInput, { pinned: true });
}
