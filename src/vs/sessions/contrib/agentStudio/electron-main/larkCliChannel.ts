/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 飞书 CLI（`@larksuite/cli`）的主进程 IPC 宿主。
 *
 * 为什么放在主进程：探测要跑 `where/which` 与 `lark-cli --version`，安装要跑 `npx … install`，
 * 都需要 child_process —— 渲染进程没有（`gitCommitService` 里的 `require('child_process')`
 * 是历史兜底写法，带 eslint-disable，新功能不该复刻）。
 * 这里沿用 `comfyLaunchChannel.ts` 的既有范式：`validatedIpcMain.handle('vscode:*')` + 一行注册。
 *
 * 注册（`src/vs/code/electron-main/app.ts`）：
 *   this._register(new LarkCliChannel(this.logService));
 *
 * 暴露的 handler：
 *   · `vscode:larkCliStatus` → ILarkCliStatus（探测可执行文件 + 版本 + npm 最新版本，全部 best-effort）
 *   · `vscode:larkCliInstall` → ILarkCliRunResult（安装/升级同一条命令）
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { validatedIpcMain } from '../../../../base/parts/ipc/electron-main/ipcMain.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
	LARK_CLI_BIN,
	LARK_CLI_INSTALL_COMMAND,
	LARK_CLI_INSTALL_CHANNEL,
	LARK_CLI_PACKAGE,
	LARK_CLI_RUN_CHANNEL,
	LARK_CLI_STATUS_CHANNEL,
	type ILarkCliExecResult,
	type ILarkCliRunResult,
	type ILarkCliStatus,
} from '../common/larkCli.js';

const execAsync = promisify(exec);

/** 单条探测命令的超时（`where` / `--version` 都应秒回）。 */
const PROBE_TIMEOUT_MS = 8_000;
/** 查 npm registry 最新版本（网络，best-effort）。 */
const REGISTRY_TIMEOUT_MS = 10_000;
/** 安装/升级可能拉包，给足 5 分钟。 */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** 输出截断上限（写日志/回传 UI，避免巨量输出）。 */
const OUTPUT_TAIL_CHARS = 2_000;

/** 单次通用命令的默认超时（拉正文 / 下载媒体可能较慢）。 */
const RUN_TIMEOUT_MS = 120_000;
/** 单次命令超时的硬上限（防调用方传入离谱值把主进程挂住）。 */
const RUN_TIMEOUT_MAX_MS = 10 * 60_000;
/** 单次命令的参数个数 / 单参数长度上限（防御性，避免被当成通用 shell 通道滥用）。 */
const RUN_MAX_ARGS = 24;
const RUN_MAX_ARG_CHARS = 4_000;

/** 可免引号直接拼接的参数字符集：URL / 本地路径 / token / 选项值都落在这里。 */
const SAFE_ARG_RE = /^[A-Za-z0-9_.,:=@/\\+-]+$/;

/**
 * 把单个参数转成可安全拼进 shell 命令的片段。
 *
 * ⚠ 为什么必须做：`exec` 走 shell（Windows 上 npm 生成的 `.cmd` shim 只能这样调），
 * 参数里的 `&` `|` `"` 等会被 shell 解释 ⇒ 不转义的话，一个精心构造的文档 URL
 * 就能在用户机器上执行任意命令。
 * 策略：安全字符集内原样；否则整体加双引号，并按 Windows 命令行解析规则转义
 * 内部 `"`（→ `\"`）与结尾的连续反斜杠（→ 双写，否则会吃掉收尾引号）。
 *
 * ⚠ 已知边界（2026-09-24 实测）：值里**含双引号**时，这套 `\"` 转义在 **cmd + npm `.cmd` shim**
 * 这条路径上不可靠 —— cmd 会把 `\"` 里的 `"` 当引号开关，引号状态错乱后值里的 `&` 被当作命令
 * 分隔符，目标程序收到被截断的串（实测 `lark-cli --content '<json>'` 报
 * "not valid JSON: unexpected end of JSON input"，stderr 另现「系统找不到指定的路径」）。
 * ⇒ **需要传 JSON/含引号文本的调用方走 `@file`**（把内容写临时文件，argv 里只放路径），
 *   先例见 `browser/providers/tool/feishuDriveTools.ts` 的 `createTempJsonFile`。
 *   根因修复（spawn 真实入口而非 .cmd shim，或给通道加 stdin 支持）留待需要时再做。
 */
function quoteArg(arg: string): string {
	if (SAFE_ARG_RE.test(arg)) { return arg; }
	const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
	return `"${escaped}"`;
}

/** 参数合法性校验：必须是字符串数组，且不含控制字符（换行/回车/NUL 能拆行注入第二条命令）。 */
function validateArgs(args: unknown): { ok: true; args: string[] } | { ok: false; error: string } {
	if (!Array.isArray(args)) { return { ok: false, error: '参数必须是字符串数组' }; }
	if (args.length === 0 || args.length > RUN_MAX_ARGS) {
		return { ok: false, error: `参数个数需在 1..${RUN_MAX_ARGS} 之间` };
	}
	const out: string[] = [];
	for (const a of args) {
		if (typeof a !== 'string') { return { ok: false, error: '参数必须是字符串数组' }; }
		if (a.length > RUN_MAX_ARG_CHARS) { return { ok: false, error: `单个参数过长（上限 ${RUN_MAX_ARG_CHARS} 字符）` }; }
		if (/[\r\n\0]/.test(a)) { return { ok: false, error: '参数不允许包含换行或 NUL 字符' }; }
		out.push(a);
	}
	return { ok: true, args: out };
}

interface IExecOk { ok: true; stdout: string; stderr: string; }
interface IExecFail { ok: false; error: string; stdout: string; stderr: string; }

export class LarkCliChannel extends Disposable {

	constructor(
		private readonly logService: ILogService,
	) {
		super();
		this.registerChannels();
	}

	override dispose(): void {
		validatedIpcMain.removeHandler(LARK_CLI_STATUS_CHANNEL);
		validatedIpcMain.removeHandler(LARK_CLI_INSTALL_CHANNEL);
		validatedIpcMain.removeHandler(LARK_CLI_RUN_CHANNEL);
		super.dispose();
	}

	/**
	 * 跑一条命令（`exec` 走 shell ⇒ Windows 上 npm 生成的 `.cmd` shim 也能直接调）。
	 * 永不抛：失败也返回结构化结果，交由上层决定文案。
	 */
	private async runCommand(command: string, timeout: number): Promise<IExecOk | IExecFail> {
		try {
			const { stdout, stderr } = await execAsync(command, {
				timeout,
				windowsHide: true,
				maxBuffer: 8 * 1024 * 1024,
				env: { ...process.env, NO_COLOR: '1' },
			});
			return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' };
		} catch (err) {
			const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
			return {
				ok: false,
				error: e.killed ? `命令超时（${Math.round(timeout / 1000)}s）：${command}` : (e.message ?? String(err)),
				stdout: e.stdout ?? '',
				stderr: e.stderr ?? '',
			};
		}
	}

	/** 取输出末尾若干字符（安装日志很长，只回传尾部最有信息量的部分）。 */
	private tail(text: string): string {
		const t = text.trim();
		return t.length <= OUTPUT_TAIL_CHARS ? t : `…${t.slice(-OUTPUT_TAIL_CHARS)}`;
	}

	/** 定位可执行文件路径（Windows `where`，其余 `which`）。 */
	private async resolvePath(): Promise<string | undefined> {
		const cmd = process.platform === 'win32' ? `where ${LARK_CLI_BIN}` : `which ${LARK_CLI_BIN}`;
		const r = await this.runCommand(cmd, PROBE_TIMEOUT_MS);
		if (!r.ok) { return undefined; }
		const first = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];
		return first || undefined;
	}

	/** 取已安装版本（`lark-cli --version`，解析首个 x.y.z）。 */
	private async resolveVersion(): Promise<string | undefined> {
		const r = await this.runCommand(`${LARK_CLI_BIN} --version`, PROBE_TIMEOUT_MS);
		const text = `${r.ok ? r.stdout : r.stdout}${r.stderr ?? ''}`;
		const m = /(\d+\.\d+\.\d+)/.exec(text);
		return m?.[1];
	}

	/**
	 * 查 npm registry 上的最新版本（`npm view`）。
	 * 失败/离线一律返回 undefined ⇒ 前端不会误报「可升级」（宁可不提示，也不要假提示）。
	 */
	private async resolveLatestVersion(): Promise<string | undefined> {
		const r = await this.runCommand(`npm view ${LARK_CLI_PACKAGE} version`, REGISTRY_TIMEOUT_MS);
		if (!r.ok) { return undefined; }
		const m = /(\d+\.\d+\.\d+)/.exec(r.stdout);
		return m?.[1];
	}

	private async status(): Promise<ILarkCliStatus> {
		const cliPath = await this.resolvePath();
		if (!cliPath) {
			// 未安装：仍查一次最新版本，便于 UI 显示「将安装 x.y.z」
			const latestVersion = await this.resolveLatestVersion();
			this.logService.info(`[AgentStudio] larkCli:status 未检测到 ${LARK_CLI_BIN}（latest=${latestVersion ?? '未知'}）`);
			return { available: true, installed: false, latestVersion };
		}
		const version = await this.resolveVersion();
		const latestVersion = await this.resolveLatestVersion();
		this.logService.info(`[AgentStudio] larkCli:status path=${cliPath} version=${version ?? '未知'} latest=${latestVersion ?? '未知'}`);
		return { available: true, installed: true, version, path: cliPath, latestVersion };
	}

	/**
	 * 安装 / 升级（同一条命令：`npx @larksuite/cli@latest install`）。
	 * 成功后 UI 会重新探测一次状态以拿到新版本。
	 */
	private async install(): Promise<ILarkCliRunResult> {
		const command = LARK_CLI_INSTALL_COMMAND;
		this.logService.info(`[AgentStudio] larkCli:install 开始：${command}`);
		const r = await this.runCommand(command, INSTALL_TIMEOUT_MS);
		if (r.ok) {
			const version = await this.resolveVersion();
			const message = version ? `安装完成，当前版本 ${version}` : '安装完成（未能解析版本，请点「重新检测」）';
			this.logService.info(`[AgentStudio] larkCli:install 成功：${message}`);
			return { ok: true, message, output: this.tail(`${r.stdout}\n${r.stderr}`) };
		}
		this.logService.info(`[AgentStudio] larkCli:install 失败：${r.error}`);
		return { ok: false, message: r.error, output: this.tail(`${r.stdout}\n${r.stderr}`) };
	}

	/**
	 * 执行任意 `lark-cli <args…>`（2026-09-23：供「飞书文档 → markdown」导入使用）。
	 *
	 * 只回传**原始 stdout/stderr**，不做语义解释 —— 命令与返回 JSON 的形态属于 CLI 契约，
	 * 解析放在渲染侧的纯函数里（`common/larkCli.ts` 的 `parseLarkCliJson` / `larkCliErrorText`），
	 * 那边可单测、也能随 CLI 版本独立演进。
	 */
	private async run(args: string[], timeoutMs?: number): Promise<ILarkCliExecResult> {
		const command = [LARK_CLI_BIN, ...args].map(quoteArg).join(' ');
		const timeout = Math.min(Math.max(timeoutMs ?? RUN_TIMEOUT_MS, 1_000), RUN_TIMEOUT_MAX_MS);
		this.logService.info(`[AgentStudio] larkCli:run ${command}`);
		const r = await this.runCommand(command, timeout);
		if (r.ok) {
			return { ok: true, stdout: r.stdout, stderr: r.stderr };
		}
		this.logService.info(`[AgentStudio] larkCli:run 失败：${r.error}`);
		return { ok: false, stdout: r.stdout, stderr: r.stderr, error: r.error };
	}

	private registerChannels(): void {
		// 注意：validatedIpcMain 要求 channel 名以 `vscode:` 开头（见 base/parts/ipc/electron-main/ipcMain.ts）。
		validatedIpcMain.handle(LARK_CLI_STATUS_CHANNEL, async (): Promise<ILarkCliStatus> => {
			try {
				return await this.status();
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				this.logService.info(`[AgentStudio] larkCli:status 异常：${error}`);
				return { available: true, installed: false, error };
			}
		});

		validatedIpcMain.handle(LARK_CLI_INSTALL_CHANNEL, async (): Promise<ILarkCliRunResult> => {
			try {
				return await this.install();
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				this.logService.info(`[AgentStudio] larkCli:install 异常：${error}`);
				return { ok: false, message: error };
			}
		});

		// 通用执行入口。⚠ 参数先过 `validateArgs`（结构/长度/控制字符），再经 `quoteArg` 转义，
		// 两道都不可省：前者挡住注入用的换行，后者挡住 shell 元字符。
		validatedIpcMain.handle(LARK_CLI_RUN_CHANNEL, async (_e, args: unknown, timeoutMs: unknown): Promise<ILarkCliExecResult> => {
			const checked = validateArgs(args);
			if (!checked.ok) {
				this.logService.info(`[AgentStudio] larkCli:run 参数非法：${checked.error}`);
				return { ok: false, stdout: '', stderr: '', error: `参数非法：${checked.error}` };
			}
			try {
				return await this.run(checked.args, typeof timeoutMs === 'number' ? timeoutMs : undefined);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				this.logService.info(`[AgentStudio] larkCli:run 异常：${error}`);
				return { ok: false, stdout: '', stderr: '', error };
			}
		});
	}
}
