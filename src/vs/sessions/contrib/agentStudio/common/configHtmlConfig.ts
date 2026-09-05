/*---------------------------------------------------------------------------------------------
 *  ConfigHTML **配置**的共享逻辑 —— native 设置面板与 webview 均 import 本模块，避免两处实现漂移。
 *
 *  ⚠ 职责边界（容易混淆，务必分清）：
 *    - 本模块只管「预览来源 + 服务拉起参数」：url / htmlPath / 展示模式 / server。
 *    - 「编辑 config.html 的内容」是 webview 的 ConfigHtml 编辑器职责（getHtml / writeHtml /
 *      onHtmlRendered，见 features/configmd/configHtmlBridge.ts），不在这里。
 *
 *  之所以要共享：native DOM 面板与 webview React 组件运行环境不同（前者可直接
 *  ipcRenderer.invoke，后者只能 postMessage），UI 无法复用，但**数据契约与计算逻辑必须一致**。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/** 内置默认：仓库内的测试面板服务（server 未配置时开箱即用）。 */
export const TEST_PANEL_REL_PATH = 'src/vs/sessions/contrib/agentStudio/test/browser/test-server.mjs';

/** 默认面板端口（测试面板 test-server.mjs 的默认端口）。 */
export const DEFAULT_PANEL_PORT = 5600;

/** 展示模式固定为独立页签 —— 不作为可配置项（见需求：移除展示模式选项）。 */
export const FIXED_DISPLAY_MODE = 'tab' as const;

export type ConfigHtmlDisplayMode = 'side' | 'replace' | 'tab';

/** 预览模式：本地 HTML 文件 / URL 面板服务。 */
export type ConfigHtmlPreviewMode = 'local' | 'url';

export interface ConfigHtmlServerCfg {
	command?: string;
	args?: string[];
	cwd?: string;
	port?: number;
	healthPath?: string;
	/**
	 * **可选**的健康检查特征串：探活时响应体必须包含它，才算「是我们的服务」。
	 * 用于防「端口被别的程序占用却被误判为服务已在运行」。不填则不校验身份。
	 */
	healthExpect?: string;
	readyTimeoutMs?: number;
	env?: Record<string, string>;
}

/** 与 `AgentConfigHtml` 对应的最小结构（本模块只依赖这些字段）。 */
export interface ConfigHtmlCfg {
	htmlPath?: string;
	displayMode: ConfigHtmlDisplayMode;
	url?: string;
	server?: ConfigHtmlServerCfg;
}

/** 有 url 即 URL 面板模式，否则本地 HTML 模式。 */
export function previewModeOf(cfg: ConfigHtmlCfg | undefined): ConfigHtmlPreviewMode {
	return cfg?.url ? 'url' : 'local';
}

/**
 * 规范化面板地址：**缺 scheme 时自动补 `http://`**。
 * 用户常直接输入 `127.0.0.1:5600` —— 此时 `new URL()` 会把 `127.0.0.1` 当协议、
 * 端口丢失，探活 URL 拼接全部出错（表现为「地址和端口没有正确拼接」）。
 */
export function normalizePanelUrl(raw: string): string {
	const v = (raw ?? '').trim().replace(/\/+$/, '');
	if (!v) { return ''; }
	return /^https?:\/\//i.test(v) ? v : `http://${v}`;
}

/** 校验面板地址，返回错误文案（通过返回 undefined）。 */
export function validatePanelUrl(url: string): string | undefined {
	const v = normalizePanelUrl(url);
	if (!v) { return '请填写面板地址'; }
	try {
		const u = new URL(v);
		if (!/^https?:$/.test(u.protocol)) { return '面板地址必须是 http:// 或 https://'; }
		if (!u.hostname) { return '面板地址缺少主机名'; }
		return undefined;
	} catch {
		return '面板地址格式不正确';
	}
}

export function portFromUrl(url: string): number | undefined {
	try { return Number(new URL(url).port) || undefined; } catch { return undefined; }
}

/** 端口取值：配置 > URL 中的端口 > 默认 5600。 */
export function defaultPortOf(cfg: ConfigHtmlCfg | undefined, url: string): number {
	return cfg?.server?.port ?? portFromUrl(url) ?? DEFAULT_PANEL_PORT;
}

/**
 * 规范化配置：两种模式字段**互斥**（切模式时对方字段清除，避免残留脏配置）。
 * 展示模式固定 `tab`。
 */
export function normalizeConfigHtml(
	mode: ConfigHtmlPreviewMode,
	form: { url?: string; port?: number; htmlPath?: string; prev?: ConfigHtmlCfg },
): ConfigHtmlCfg {
	if (mode === 'url') {
		const cfg: ConfigHtmlCfg = { displayMode: FIXED_DISPLAY_MODE, url: normalizePanelUrl(form.url ?? '') };
		const port = Number(form.port);
		if (Number.isFinite(port) && port > 0) {
			cfg.server = { ...(form.prev?.server ?? {}), port };
		}
		return cfg;
	}
	return {
		displayMode: FIXED_DISPLAY_MODE,
		htmlPath: (form.htmlPath ?? '').trim() || 'config.html',
	};
}

/**
 * Node 可执行文件路径。本模块是 **common 层**，会被三处引用：node 测试脚本、
 * Electron 主进程、以及 **workbench renderer（浏览器环境，无 `process`）**——
 * 因此必须防御式读取，取不到就返回 undefined，由主进程兜底 `process.execPath`。
 */
export function nodeExecPath(): string | undefined {
	try {
		return typeof process !== 'undefined' ? process.execPath : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 取 preload（contextBridge）暴露的原生 ipcRenderer 桥，用于 renderer → 主进程 invoke。
 * 注意键名：项目 preload 暴露的是 **`globalThis.vscode`**（worktreeService / webTools /
 * compatibilityTools 均如此使用），历史代码里误写成 `vscodeBridge` 导致永远判空
 * （表现为「点了没反应」）。这里两个键都兼容，并统一各处取桥方式。
 */
export function nativeIpcBridge(): { ipcRenderer?: { invoke?: (ch: string, ...args: unknown[]) => Promise<unknown> } } | undefined {
	const g = globalThis as unknown as Record<string, unknown>;
	for (const key of ['vscode', 'vscodeBridge']) {
		const b = g[key] as { ipcRenderer?: { invoke?: (ch: string, ...args: unknown[]) => Promise<unknown> } } | undefined;
		if (b?.ipcRenderer?.invoke) { return b; }
	}
	return undefined;
}

/**
 * 构造「服务拉起参数」，交给主进程 `vscode:configHtmlEnsureServer`。
 * command/args/cwd 的解析放在这里：native 与 webview 两侧得到完全一致的 spec。
 */
export function buildEnsureSpec(
	url: string,
	portRaw: number | undefined,
	workspaceRoot: string,
	healthExpect?: string,
): Record<string, unknown> {
	url = normalizePanelUrl(url);   // ★ 防御：缺 scheme 的输入会导致探活 URL 拼接错乱
	const port = Number(portRaw) || defaultPortOf(undefined, url);
	return {
		url,
		port,
		healthPath: '/',
		// 不填即不校验身份（保持向后兼容）；需要防端口误判时由调用方传入。
		healthExpect: healthExpect || undefined,
		readyTimeoutMs: 30_000,
		command: nodeExecPath(),
		args: workspaceRoot
			? [URI.joinPath(URI.file(workspaceRoot), ...TEST_PANEL_REL_PATH.split('/')).fsPath]
			: [],
		cwd: workspaceRoot || undefined,
	};
}
