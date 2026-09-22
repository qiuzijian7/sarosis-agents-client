/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileAccess, type AppResourcePath } from '../../../../../base/common/network.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { nodeExecPath } from '../../common/configHtmlConfig.js';

/**
 * 知识库 → 飞书同步：核心工具集（内置脚本定位 / CLI 检测 / 参数拼装）。
 *
 * 设计要点（2026-09-21 用户拍板）：
 *  1. **同步脚本内置**：脚本随产品发布（`resources/.agents/kb/feishu-sync.mjs`），
 *     不再要求用户自备外部脚本、也不再暴露「脚本路径」配置项。
 *  2. **飞书 CLI 检测**：lark-cli 是外部依赖 ⇒ 执行前必须探测是否安装，
 *     未安装时给出明确提示与安装指引，避免用户点了按钮只看到失败。
 *
 * 本模块为纯逻辑（除 `resolveSyncScript` / `detectLarkCli` 两个异步 IO 函数），
 * 便于单测；调用方负责把状态呈现到 UI。
 */

/** 内置同步脚本相对产品根目录的路径（相对路径由候选定位函数展开）。 */
export const KB_FEISHU_SYNC_SCRIPT_REL = 'resources/.agents/kb/feishu-sync.mjs';

/** 飞书 CLI 默认可执行名（在 PATH 中查找；可被配置覆盖）。 */
export const DEFAULT_LARK_CLI = 'lark-cli';

/** 同步日志文件名（与内置脚本约定一致）。 */
export const FEISHU_SYNC_LOG_FILE = '.feishu-sync.log';

/** 未检测到 CLI 时的引导文案（多处复用，避免措辞漂移）。 */
export const LARK_CLI_MISSING_HINT =
	'未检测到飞书 CLI（lark-cli）。请先安装该命令行工具并确保它在系统 PATH 中；'
	+ '若安装在非标准位置，可在「运行环境」里填写其可执行文件完整路径。';

export interface IFeishuCliState {
	/** unknown = 尚未检测或无法判定 */
	state: 'unknown' | 'missing' | 'installed';
	/** 版本号（能解析到时） */
	version?: string;
	/** 是否已登录（能判定时；`auth status` 可用的情况下） */
	loggedIn?: boolean;
	/** 原始输出片段（诊断用） */
	raw?: string;
}

export interface IFeishuSyncOptions {
	/** 知识库根目录绝对路径 */
	vaultPath: string;
	/** 要同步的库内相对目录（空数组 = 整个知识库） */
	srcDirs: string[];
	/** 目标位置：my_library 或文件夹 token */
	parent: string;
	/** 远端被手工修改时的策略 */
	onConflict: 'overwrite' | 'skip';
	/** 每篇间隔毫秒 */
	intervalMs: number;
	/** dry-run = 只打印计划；apply = 实际写入 */
	mode: 'dry-run' | 'apply';
	/** 类别层级深度（默认 1：源目录下第 1 级目录 = 一个类别 ⇒ 一个飞书知识库）；0 = 不分类别 */
	categoryDepth?: number;
	/** 未映射的类别是否自动创建同名飞书知识库（默认 true） */
	autoCreateSpaces?: boolean;
	/** 本地已删除的文档是否同时移除远端节点（默认 false） */
	prune?: boolean;
}

/**
 * 拼装内置脚本的 CLI 参数（与 `kb-feishu-sync.mjs` 的契约保持一致）。
 * 抽成纯函数便于单测，避免视图/面板各拼一份而漂移。
 */
export function buildSyncArgs(scriptPath: string, o: IFeishuSyncOptions): string[] {
	const args: string[] = [scriptPath, '--vault', o.vaultPath];
	for (const d of o.srcDirs) {
		if (d) { args.push('--src', d); }
	}
	args.push('--parent', o.parent || 'my_library');
	args.push('--on-conflict', o.onConflict === 'skip' ? 'skip' : 'overwrite');
	const interval = Number.isFinite(o.intervalMs) && o.intervalMs >= 0 ? o.intervalMs : 800;
	args.push('--interval', String(interval));
	// 多类别 → 多知识库：类别层级 / 自动建库 / 删除清理
	const depth = Number.isFinite(o.categoryDepth) && (o.categoryDepth as number) >= 0 ? (o.categoryDepth as number) : 1;
	args.push('--category-depth', String(depth));
	args.push(o.autoCreateSpaces === false ? '--no-auto-create-spaces' : '--auto-create-spaces');
	if (o.prune) { args.push('--prune'); }
	args.push(o.mode === 'apply' ? '--apply' : '--dry-run');
	return args;
}

/** 从 `--src` 逗号串解析目录列表（面板输入 → 参数）。 */
export function parseSrcDirs(raw: string | undefined | null): string[] {
	return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

// ─── 用户自定义「本地目录 ↔ 飞书知识库」映射（2026-09-22）────────────────────
// 由设置面板维护、存放在 vault 内（与脚本 loadSpaceMap / applyExplicitMappings 同一份契约）：
//   { version: 1, mappings: [{ dir: '库/…/01-基础概念', spaceId: '769…', spaceName: '01-基础概念' }] }
// ⚠ 为什么落文件而不是 CLI 参数：JSON 经 argv 在 Windows（shell:true）下会被引号破坏。

/** 映射文件名（与内置脚本 `SPACE_MAP_FILE` 保持一致）。 */
export const FEISHU_SPACE_MAP_FILE = '.feishu-space-map.json';

/** 一条映射：知识库内相对目录 → 飞书 wiki 知识库。 */
export interface IKbSpaceMapping {
	/** 知识库内相对目录（如 `库/AI/01-基础概念`）；其**子目录**也会一同绑定 */
	dir: string;
	/** 飞书 wiki 知识库 id */
	spaceId: string;
	/** 知识库名称（仅用于展示；可缺省） */
	spaceName?: string;
}

/** 解析映射文件内容（宽容：非法项忽略；损坏/空 ⇒ 空数组）。与脚本端语义一致。 */
export function parseSpaceMap(text: string | undefined | null): IKbSpaceMapping[] {
	let raw: unknown;
	try { raw = JSON.parse(((text ?? '').trim() || '{}')); } catch { return []; }
	const src = (raw as { mappings?: unknown } | null)?.mappings;
	const out: IKbSpaceMapping[] = [];
	if (Array.isArray(src)) {
		for (const item of src) {
			const rec = (item ?? {}) as Record<string, unknown>;
			const dir = typeof rec.dir === 'string' ? rec.dir.trim() : '';
			const spaceId = typeof rec.spaceId === 'string' ? rec.spaceId.trim() : '';
			if (dir && spaceId) {
				out.push({ dir, spaceId, spaceName: typeof rec.spaceName === 'string' ? rec.spaceName : '' });
			}
		}
	} else if (src && typeof src === 'object') {
		// 极简写法：{ mappings: { '库/AI/01-x': '<spaceId>' } }
		for (const [dir, spaceId] of Object.entries(src as Record<string, unknown>)) {
			if (dir.trim() && typeof spaceId === 'string' && spaceId.trim()) {
				out.push({ dir, spaceId, spaceName: '' });
			}
		}
	}
	return out;
}

/** 序列化映射（stable 顺序 + version 字段便于后续演进）。 */
export function serializeSpaceMap(list: readonly IKbSpaceMapping[]): string {
	const mappings = list.map(m => ({
		dir: m.dir,
		spaceId: m.spaceId,
		...(m.spaceName ? { spaceName: m.spaceName } : {}),
	}));
	return JSON.stringify({ version: 1, mappings }, null, 2) + '\n';
}

/**
 * 解析 `lark-cli wiki +space-list` 的输出，得到「可选知识库」列表（纯函数，便于单测）。
 * 兼容：顶层为数组 / `{ data: { items: [...] } }` / 任意嵌套；字段名 `space_id` 或 `spaceId`。
 */
export function parseSpaceList(raw: string): Array<{ spaceId: string; name: string }> {
	const text = (raw ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim();
	if (!text) { return []; }
	let root: unknown;
	try { root = JSON.parse(text); } catch { root = extractFirstJsonObject(text); }
	if (!root) { return []; }
	const out: Array<{ spaceId: string; name: string }> = [];
	const seen = new Set<string>();
	const walk = (node: unknown, depth: number): void => {
		if (!node || typeof node !== 'object' || depth > 8) { return; }
		if (Array.isArray(node)) { for (const x of node) { walk(x, depth + 1); } return; }
		const rec = node as Record<string, unknown>;
		const spaceId = typeof rec.space_id === 'string' ? rec.space_id
			: (typeof rec.spaceId === 'string' ? rec.spaceId : '');
		const name = typeof rec.name === 'string' ? rec.name : '';
		if (spaceId && name && !seen.has(spaceId)) { seen.add(spaceId); out.push({ spaceId, name }); }
		for (const v of Object.values(rec)) { walk(v, depth + 1); }
	};
	walk(root, 0);
	return out;
}

/** 列出当前账号可见的飞书知识库（未安装 CLI / 未登录 / 解析失败 ⇒ 空数组，由 UI 兜底提示）。 */
export async function listWikiSpaces(cliPath: string = DEFAULT_LARK_CLI): Promise<Array<{ spaceId: string; name: string }>> {
	const exe = (cliPath ?? '').trim() || DEFAULT_LARK_CLI;
	const res = await execShortCommand(`${exe} wiki +space-list --page-all --format json`, 20000);
	if (!res) { return []; }
	return parseSpaceList(res.stdout || res.stderr);
}

/**
 * 规范化知识库名称：去掉会破坏 shell 引号的字符（`"`、换行/回车）并裁剪空白。
 * ⚠ 命令行经 `shell: true` 执行 ⇒ 名称必须能安全地放进一对双引号里。
 */
export function sanitizeSpaceName(name: string | undefined | null): string {
	return (name ?? '').replace(/["\r\n]/g, '').trim();
}

/** 从 `wiki +space-create` 的输出里提取新建知识库 id（宽松：任意嵌套的 space_id / spaceId）。 */
export function parseCreatedSpaceId(raw: string): string {
	const text = (raw ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim();
	if (!text) { return ''; }
	let root: unknown;
	try { root = JSON.parse(text); } catch { root = extractFirstJsonObject(text); }
	if (!root) { return ''; }
	let found = '';
	const walk = (node: unknown, depth: number): void => {
		if (found || !node || typeof node !== 'object' || depth > 8) { return; }
		if (Array.isArray(node)) { for (const x of node) { walk(x, depth + 1); } return; }
		const rec = node as Record<string, unknown>;
		const id = typeof rec.space_id === 'string' ? rec.space_id
			: (typeof rec.spaceId === 'string' ? rec.spaceId : '');
		if (id) { found = id; return; }
		for (const v of Object.values(rec)) { walk(v, depth + 1); }
	};
	walk(root, 0);
	return found;
}

/**
 * 新建飞书知识库（`wiki +space-create --name <名称> --as user`）。
 * 失败（未安装 CLI / 未登录 / 无权限）⇒ undefined，由 UI 给出提示。
 */
export async function createWikiSpace(name: string, cliPath: string = DEFAULT_LARK_CLI): Promise<{ spaceId: string; name: string } | undefined> {
	const clean = sanitizeSpaceName(name);
	if (!clean) { return undefined; }
	const exe = (cliPath ?? '').trim() || DEFAULT_LARK_CLI;
	const res = await execShortCommand(`${exe} wiki +space-create --name "${clean}" --as user`, 30000);
	if (!res) { return undefined; }
	const spaceId = parseCreatedSpaceId(res.stdout || res.stderr);
	return spaceId ? { spaceId, name: clean } : undefined;
}

/**
 * 内置脚本的候选 URI（按可靠性排序，调用方取第一个存在的）：
 *  1. `FileAccess.asFileUri` —— 基于 vs 源码根推算（dev / 打包通用，与技能目录同策略）
 *  2. `appRoot/resources/...` —— Electron dev 模式 appRoot ≡ 项目根
 *  3. `dirname(appRoot)/resources/...` —— 部分打包布局下 appRoot 位于 out/ 子目录
 *  4. `process.resourcesPath/app/resources/...` —— 安装包布局（代码位于 resources/app）
 */
export function syncScriptCandidates(envService?: INativeEnvironmentService): URI[] {
	const out: URI[] = [];
	const push = (uri: URI) => {
		if (!out.some(u => u.toString() === uri.toString())) { out.push(uri); }
	};
	const rel = KB_FEISHU_SYNC_SCRIPT_REL.split('/');

	try {
		push(FileAccess.asFileUri(('vs/../../' + KB_FEISHU_SYNC_SCRIPT_REL) as AppResourcePath));
	} catch { /* FileAccess 不可用时跳过 */ }

	const appRoot = envService?.appRoot;
	if (appRoot) {
		push(URI.joinPath(URI.file(appRoot), ...rel));
		try {
			push(URI.joinPath(URI.file(path.dirname(appRoot)), ...rel));
		} catch { /* dirname 失败跳过 */ }
	}

	const resourcesPath = (globalThis as { process?: { resourcesPath?: string } }).process?.resourcesPath;
	if (resourcesPath) {
		push(URI.joinPath(URI.file(resourcesPath), 'app', ...rel));
	}
	return out;
}

/** 定位内置同步脚本；全部候选都不存在时返回 undefined（调用方给出诊断提示）。 */
export async function resolveSyncScript(fileService: IFileService, envService?: INativeEnvironmentService): Promise<URI | undefined> {
	for (const candidate of syncScriptCandidates(envService)) {
		try {
			await fileService.stat(candidate);
			return candidate;
		} catch { /* 试下一个候选 */ }
	}
	return undefined;
}

// ─── 主进程命令执行（检测 lark-cli 用） ─────────────────────────────────────

export interface ICommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * 通过 Electron 主进程通道执行命令（`vscode:execCode`，主进程 child_process.spawn）。
 * 与 `execute_code` 工具体系复用同一原语；不可用时返回 undefined（调用方降级）。
 * ⚠ 仅用于**短命令 + 小输出**（版本探测）：主进程该通道为单次缓冲。
 */
export async function execShortCommand(command: string, timeoutMs = 8000): Promise<ICommandResult | undefined> {
	const bridge = (globalThis as { vscode?: { ipcRenderer?: { invoke: (ch: string, payload: unknown) => Promise<unknown> } } }).vscode;
	if (!bridge?.ipcRenderer?.invoke) { return undefined; }
	try {
		const r = await bridge.ipcRenderer.invoke('vscode:execCode', { command, timeoutMs }) as
			{ success?: boolean; stdout?: string; stderr?: string; exitCode?: number } | undefined;
		if (!r) { return undefined; }
		return {
			ok: r.success === true,
			stdout: r.stdout ?? '',
			stderr: r.stderr ?? '',
			exitCode: typeof r.exitCode === 'number' ? r.exitCode : -1,
		};
	} catch {
		return undefined;
	}
}

/** 从版本输出中解析语义化版本号（宽容：取第一处 x.y.z）。 */
export function parseCliVersion(stdout: string): string | undefined {
	const m = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(stdout ?? '');
	return m ? m[1] : undefined;
}

/** 从 `auth status` 输出解析登录态：识别常见的 ok/valid/logged 标记。 */
export function parseLoggedIn(stdout: string): boolean | undefined {
	const text = (stdout ?? '').toLowerCase();
	if (!text.trim()) { return undefined; }
	if (/"tokenstatus"\s*:\s*"(valid|ok)"/.test(text) || /"logged_?in"\s*:\s*true/.test(text)) { return true; }
	if (/"tokenstatus"\s*:\s*"(invalid|expired|none)"/.test(text) || /"logged_?in"\s*:\s*false/.test(text)) { return false; }
	if (/\b(not logged in|no token|unauthenticated)\b/.test(text)) { return false; }
	if (/\b(logged in|authenticated|token valid)\b/.test(text)) { return true; }
	return undefined;
}

/**
 * 检测飞书 CLI：先跑 `--version` 判定是否安装，再（已安装时）跑 `auth status` 判定登录态。
 * 失败语义：命令不存在/无法执行 ⇒ `missing`；通道不可用 ⇒ `unknown`（不误报为未安装）。
 */
export async function detectLarkCli(cliPath: string = DEFAULT_LARK_CLI): Promise<IFeishuCliState> {
	const exe = (cliPath ?? '').trim() || DEFAULT_LARK_CLI;
	const versionRes = await execShortCommand(`${exe} --version`, 8000);
	if (!versionRes) {
		return { state: 'unknown', raw: '主进程执行通道不可用，无法检测' };
	}
	const combined = `${versionRes.stdout}\n${versionRes.stderr}`.trim();
	if (!versionRes.ok || versionRes.exitCode !== 0) {
		// 命令不存在时 spawn 失败（exitCode 非 0 + stderr 含 not recognized / ENOENT 等）
		return { state: 'missing', raw: combined.slice(0, 400) };
	}
	const version = parseCliVersion(combined);
	const authRes = await execShortCommand(`${exe} auth status`, 8000);
	const loggedIn = authRes ? parseLoggedIn(`${authRes.stdout}\n${authRes.stderr}`) : undefined;
	return { state: 'installed', version, loggedIn, raw: combined.slice(0, 400) };
}

// ─── CLI 升级（真机接口：`lark-cli update` / `update --check --json`） ────────

export interface IFeishuCliUpdateInfo {
	/** `update_available` | `up_to_date` | 其它（原样保留，未知取值不当作可升级） */
	action: string;
	currentVersion?: string;
	latestVersion?: string;
	/** Release 页面（可展示 / 打开） */
	releaseUrl?: string;
	/** 更新日志地址 */
	changelogUrl?: string;
	/** CLI 自带提示语（可直接展示） */
	message?: string;
}

/** 是否检测到可升级版本（action 明确为 update_available，或版本号确有差异）。 */
export function hasUpdate(info: IFeishuCliUpdateInfo | undefined): boolean {
	if (!info) { return false; }
	if (info.action === 'update_available') { return true; }
	return !!info.latestVersion && !!info.currentVersion && info.latestVersion !== info.currentVersion;
}

/**
 * 解析 `lark-cli update --check --json` 的输出。
 * 兼容两种形态：
 *  - 结构化 JSON：`{ action, current_version, latest_version, url, changelog, message }`（实测）
 *  - 纯文本提示：`Update available: 1.0.27 -> 1.0.96` / `already up to date`
 */
export function parseUpdateCheck(stdout: string): IFeishuCliUpdateInfo | undefined {
	const text = (stdout ?? '').replace(/\u001b\[[0-9;]*m/g, '');
	const json = extractFirstJsonObject(text);
	if (json) {
		const action = typeof json.action === 'string' ? json.action : '';
		const info: IFeishuCliUpdateInfo = {
			action: action || (json.latest_version ? 'update_available' : 'unknown'),
			currentVersion: typeof json.current_version === 'string' ? json.current_version : undefined,
			latestVersion: typeof json.latest_version === 'string' ? json.latest_version : undefined,
			releaseUrl: typeof json.url === 'string' ? json.url : undefined,
			changelogUrl: typeof json.changelog === 'string' ? json.changelog : undefined,
			message: typeof json.message === 'string' ? json.message : undefined,
		};
		if (info.action !== 'unknown' || info.latestVersion) { return info; }
	}
	// 文本回退
	const m = /(\d+\.\d+\.\d+)\s*->\s*(\d+\.\d+\.\d+)/.exec(text);
	if (m) { return { action: 'update_available', currentVersion: m[1], latestVersion: m[2] }; }
	if (/up[- ]to[- ]date|latest version/i.test(text)) { return { action: 'up_to_date' }; }
	return undefined;
}

/** 从混有日志 / 彩色码的输出中提取首个完整 JSON 对象（括号配对，忽略字符串内的花括号）。 */
function extractFirstJsonObject(text: string): Record<string, unknown> | undefined {
	const start = text.indexOf('{');
	if (start < 0) { return undefined; }
	let depth = 0; let inStr = false; let esc = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inStr) {
			if (esc) { esc = false; }
			else if (ch === '\\') { esc = true; }
			else if (ch === '"') { inStr = false; }
			continue;
		}
		if (ch === '"') { inStr = true; }
		else if (ch === '{') { depth++; }
		else if (ch === '}') {
			depth--;
			if (depth === 0) {
				try { return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>; } catch { return undefined; }
			}
		}
	}
	return undefined;
}

/**
 * 检查 lark-cli 是否有新版本（`update --check --json`，**只读不安装**）。
 * 失败或无法解析 ⇒ undefined（UI 只显示「无法获取版本信息」，不误报可升级）。
 */
export async function checkCliUpdate(cliPath: string = DEFAULT_LARK_CLI): Promise<IFeishuCliUpdateInfo | undefined> {
	const exe = (cliPath ?? '').trim() || DEFAULT_LARK_CLI;
	const res = await execShortCommand(`${exe} update --check --json`, 15000);
	if (!res) { return undefined; }
	return parseUpdateCheck(res.stdout || res.stderr);
}

/**
 * 升级命令的参数（**由调用方在终端执行**：升级可能下载安装包、耗时较长，
 * 终端可见进度且失败可读，优于单次缓冲的短命令通道）。
 */
export function buildUpgradeArgs(): string[] {
	return ['update'];
}

// ─── 执行器：Electron 自带 node（不依赖用户系统 node） ───────────────────────

export interface IElectronNodeLaunch {
	/** 可执行文件路径（Electron 二进制）；取不到时为 undefined ⇒ 调用方回退系统 node */
	executable: string | undefined;
	/** 启动环境（含 ELECTRON_RUN_AS_NODE=1，且保留完整进程环境，脚本仍能调用 lark-cli） */
	env: Record<string, string>;
}

/**
 * 构造「用 Electron 自带 node 执行脚本」的启动参数。
 *
 * 原理（本仓既有范式，见 `electron-main/configHtmlServerChannel.ts:140-146`）：
 * `process.execPath` 在 Electron 里是 **Electron 可执行文件**而非 node —— 直接跑 `.mjs`
 * 会被当作 app 入口加载并立即退出；必须带 **`ELECTRON_RUN_AS_NODE=1`** 让它以纯 Node 模式运行。
 *
 * ⚠ `env` 必须保留完整进程环境：同步脚本内部仍要 `spawn('lark-cli')`，
 * 丢掉 PATH 会导致「CLI 明明装了却找不到」。
 *
 * 取不到 Electron 路径时 `executable` 为 undefined，由调用方回退系统 `node`（保持可用性，不硬失败）。
 */
export function electronNodeLaunch(): IElectronNodeLaunch {
	let env: Record<string, string> = {};
	try {
		if (typeof process !== 'undefined' && process.env) {
			env = { ...(process.env as Record<string, string>) };
		}
	} catch { /* 无 process 环境时留空（仅靠 flag 也足够） */ }
	env['ELECTRON_RUN_AS_NODE'] = '1';
	return { executable: nodeExecPath(), env };
}
