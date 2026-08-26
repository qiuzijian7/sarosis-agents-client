/*---------------------------------------------------------------------------------------------
 *  comfyLauncher — 解析本机 ComfyUI（Comfy Desktop）安装路径，支持一键启动
 *  `python main.py --enable-cors-header`（方案A 直连前置条件）。
 *
 *  纯路径解析逻辑（可单测）：
 *   - parseComfyDesktopConfig：从 Comfy Desktop 的 config.json + extra_models_config.yaml 解析
 *     basePath（用户根，如 D:\ComfyUI）与 desktopRoot（应用根，如 D:\Program Files\ComfyUI）。
 *   - pythonCandidates / mainPyCandidates：按优先级列出可执行文件候选。
 *   - pickComfyLaunchPaths：挑选"存在"的 python 与 main.py（存在性可注入，默认 fs.existsSync）。
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { join } from 'path';

/**
 * 向上推 `levels` 级父目录（同时支持 Windows `\` 与 posix `/` 分隔符）。
 * 不用 node path.dirname：esbuild bundle 后在部分环境对 Windows 反斜杠路径
 * 解析不一致（测试已复现）。
 */
function dirnameUp(p: string, levels: number): string {
	let cur = p.replace(/[\\/]+$/, '');
	for (let i = 0; i < levels; i++) {
		const idx = Math.max(cur.lastIndexOf('\\'), cur.lastIndexOf('/'));
		if (idx < 0) { return cur; }
		cur = cur.slice(0, idx);
	}
	return cur;
}

export interface ComfyDesktopConfig {
	/** Comfy Desktop 用户根（config.json `basePath`），如 D:\ComfyUI（venv 与 custom_nodes 在此）。 */
	basePath?: string;
	/** Comfy Desktop 应用根，如 D:\Program Files\ComfyUI（resources\ComfyUI 程序本体在此）。 */
	desktopRoot?: string;
}

/**
 * 解析 Comfy Desktop 配置。
 * @param configJson `%APPDATA%\ComfyUI\config.json` 内容（{ basePath, installState, ... }）
 * @param extraYaml  `%APPDATA%\ComfyUI\extra_models_config.yaml` 内容，其中
 *   `desktop_extensions.custom_nodes: <desktopRoot>\resources\ComfyUI\custom_nodes`
 *   → 上推 3 级目录即 desktopRoot。
 */
export function parseComfyDesktopConfig(configJson: string | undefined, extraYaml: string | undefined): ComfyDesktopConfig {
	const cfg: ComfyDesktopConfig = {};
	if (configJson) {
		try {
			const parsed = JSON.parse(configJson) as { basePath?: unknown };
			if (typeof parsed.basePath === 'string' && parsed.basePath) { cfg.basePath = parsed.basePath; }
		} catch { /* 忽略损坏的 JSON */ }
	}
	if (extraYaml) {
		// 路径可能含空格（如 D:\Program Files\...），须捕获到行尾（剔除行内 # 注释）。
		const m = /^desktop_extensions:[\s\S]*?^[ \t]*custom_nodes:[ \t]*([^\r\n#]+)/m.exec(extraYaml);
		if (m?.[1]) {
			const customNodes = m[1].trim().replace(/\s+#.*$/, '').replace(/\\$/, '');
			// <desktopRoot>/resources/ComfyUI/custom_nodes → 上推 3 级
			if (customNodes) { cfg.desktopRoot = dirnameUp(customNodes, 3); }
		}
	}
	return cfg;
}

/** 按优先级列出 python.exe 候选（存在即优先）。 */
export function pythonCandidates(cfg: ComfyDesktopConfig): string[] {
	const base = cfg.basePath;
	const root = cfg.desktopRoot;
	const out: string[] = [];
	if (base) {
		out.push(join(base, '.venv', 'Scripts', 'python.exe'));
		out.push(join(base, 'venv', 'Scripts', 'python.exe'));
	}
	if (root) {
		out.push(join(root, 'Comfy Desktop', 'resources', 'bootstrap-python', 'python.exe'));
		out.push(join(root, 'resources', 'python_embeded', 'python.exe'));
	}
	return out;
}

/** 按优先级列出 main.py 候选。 */
export function mainPyCandidates(cfg: ComfyDesktopConfig): string[] {
	const base = cfg.basePath;
	const root = cfg.desktopRoot;
	const out: string[] = [];
	if (root) { out.push(join(root, 'resources', 'ComfyUI', 'main.py')); }
	if (base) {
		out.push(join(base, 'resources', 'ComfyUI', 'main.py'));
		out.push(join(base, 'ComfyUI', 'main.py'));
		out.push(join(base, 'main.py'));
	}
	return out;
}

export interface ComfyLaunchPaths {
	pythonPath?: string;
	mainPyPath?: string;
}

/**
 * 挑选"存在"的 python 与 main.py。overrides 优先（如用户通过环境变量/设置显式指定），
 * 其次按候选优先级第一个存在者。存在性判断可用 `exists` 注入（测试用）。
 */
export function pickComfyLaunchPaths(
	cfg: ComfyDesktopConfig,
	exists: (p: string) => boolean = existsSync,
	overrides?: { pythonPath?: string; mainPyPath?: string },
): ComfyLaunchPaths {
	const out: ComfyLaunchPaths = {};
	const pyOverride = overrides?.pythonPath?.trim();
	const mainOverride = overrides?.mainPyPath?.trim();
	if (pyOverride && exists(pyOverride)) { out.pythonPath = pyOverride; }
	else { out.pythonPath = pythonCandidates(cfg).find(exists); }
	if (mainOverride && exists(mainOverride)) { out.mainPyPath = mainOverride; }
	else { out.mainPyPath = mainPyCandidates(cfg).find(exists); }
	return out;
}

export interface ComfyLaunchResult {
	ok: boolean;
	/** ComfyUI 已在运行（未启动新进程）。 */
	alreadyRunning?: boolean;
	/** 进程已 spawn，但轮询窗口内尚未监听端口（仍在后台加载 torch+模型）。 */
	starting?: boolean;
	/** 新启动子进程 PID。 */
	pid?: number;
	version?: string;
	error?: string;
	/** 解析出的启动路径（错误排查用）。 */
	pythonPath?: string;
	mainPyPath?: string;
	baseUrl?: string;
	/** restart 专用：杀掉以释放端口的进程列表（含 ok/error）。 */
	killed?: { pid: number; ok: boolean; error?: string }[];
}
