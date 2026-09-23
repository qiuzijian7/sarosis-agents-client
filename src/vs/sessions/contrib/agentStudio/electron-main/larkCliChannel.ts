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
	LARK_CLI_PACKAGE,
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
		validatedIpcMain.removeHandler('vscode:larkCliStatus');
		validatedIpcMain.removeHandler('vscode:larkCliInstall');
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

	private registerChannels(): void {
		// 注意：validatedIpcMain 要求 channel 名以 `vscode:` 开头（见 base/parts/ipc/electron-main/ipcMain.ts）。
		validatedIpcMain.handle('vscode:larkCliStatus', async (): Promise<ILarkCliStatus> => {
			try {
				return await this.status();
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				this.logService.info(`[AgentStudio] larkCli:status 异常：${error}`);
				return { available: true, installed: false, error };
			}
		});

		validatedIpcMain.handle('vscode:larkCliInstall', async (): Promise<ILarkCliRunResult> => {
			try {
				return await this.install();
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				this.logService.info(`[AgentStudio] larkCli:install 异常：${error}`);
				return { ok: false, message: error };
			}
		});
	}
}
