/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ComfyUI 一键启动的主进程 IPC channel 宿主。
 *
 * 从 `app.ts` 的内联 handler 抽离为独立模块：通过 `validatedIpcMain.handle` 注册
 * `vscode:comfyLaunch` / `vscode:comfyGetLaunchPaths` / `vscode:comfySetLaunchPaths`
 * 三个 invoke handler，依赖注入 `ILogService` 与 `IConfigurationService`，
 * 使 `CodeApplication` 无需再内联这一大段逻辑（app.ts 只保留一行注册）。
 *
 * 纯路径解析逻辑仍在 `comfyLauncher.ts`（可单测）；本类只负责 IPC 生命周期
 * 与「探测已运行 → 解析路径 → spawn → 轮询」的编排。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { validatedIpcMain } from '../../../../base/parts/ipc/electron-main/ipcMain.js';
import { net } from 'electron';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { existsSync, readFileSync, createWriteStream, mkdirSync, readdirSync } from 'fs';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { parseComfyDesktopConfig, pickComfyLaunchPaths, type ComfyLaunchResult } from './comfyLauncher.js';

const execAsync = promisify(exec);

interface DownloadState {
	taskId: string;
	url: string;
	filename: string;
	destPath: string;
	status: 'running' | 'success' | 'error';
	downloaded: number;
	total: number; // -1 = 未知
	message?: string;
}

export class ComfyLaunchChannel extends Disposable {

	private readonly downloads = new Map<string, DownloadState>();

	constructor(
		private readonly logService: ILogService,
		private readonly configurationService: IConfigurationService,
	) {
		super();
		this.registerChannels();
	}

	override dispose(): void {
		validatedIpcMain.removeHandler('vscode:comfyLaunch');
		validatedIpcMain.removeHandler('vscode:comfyRestart');
		validatedIpcMain.removeHandler('vscode:comfyGetLaunchPaths');
		validatedIpcMain.removeHandler('vscode:comfySetLaunchPaths');
		validatedIpcMain.removeHandler('vscode:comfyCheckDeps');
		validatedIpcMain.removeHandler('vscode:comfyDownloadModel');
		validatedIpcMain.removeHandler('vscode:comfyGetDownloadProgress');
		super.dispose();
	}

	/** 解析 Comfy Desktop 配置（含 basePath），供路径解析复用。 */
	private resolveDesktopConfig(): { basePath?: string } {
		const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
		const configPath = join(appData, 'ComfyUI', 'config.json');
		const extraYamlPath = join(appData, 'ComfyUI', 'extra_models_config.yaml');
		return parseComfyDesktopConfig(
			existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined,
			existsSync(extraYamlPath) ? readFileSync(extraYamlPath, 'utf8') : undefined,
		);
	}

	/** 解析 ComfyUI 模型根目录（basePath/models，兜底 main.py 同目录 / APPDATA）。 */
	private resolveModelsDir(): string {
		const cfg = this.resolveDesktopConfig();
		if (cfg.basePath) { return join(cfg.basePath, 'models'); }
		const paths = pickComfyLaunchPaths(cfg, existsSync, {});
		if (paths.mainPyPath) { return join(dirname(paths.mainPyPath), 'models'); }
		return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'ComfyUI', 'models');
	}

	/** 列目录内文件名（不存在返回空数组）。 */
	private listModelFiles(subdir: string): string[] {
		const dir = join(this.resolveModelsDir(), subdir);
		if (!existsSync(dir)) { return []; }
		try {
			return readdirSync(dir).filter(f => f.endsWith('.safetensors') || f.endsWith('.ckpt') || f.endsWith('.pt') || f.endsWith('.pth') || f.endsWith('.bin'));
		} catch {
			return [];
		}
	}

	/** 流式下载文件并更新进度（跟随重定向，最多 5 次）。 */
	private startDownload(taskId: string, url: string, destDir: string, filename: string): void {
		const destPath = join(destDir, filename);
		const state: DownloadState = { taskId, url, filename, destPath, status: 'running', downloaded: 0, total: -1 };
		this.downloads.set(taskId, state);
		try { mkdirSync(destDir, { recursive: true }); } catch { /* 目录已存在/权限不足稍后报 */ }

		const attempt = (currentUrl: string, redirectsLeft: number): void => {
			if (redirectsLeft <= 0) {
				state.status = 'error';
				state.message = '重定向次数过多';
				this.logService.info(`[AgentStudio] comfy:download ${taskId} 重定向过多`);
				return;
			}
			const mod = currentUrl.startsWith('https:') ? httpsRequest : httpRequest;
			const req = mod(currentUrl, { headers: { 'User-Agent': 'VsSaros/1.0' } }, (res) => {
				const code = res.statusCode ?? 0;
				if (code === 301 || code === 302 || code === 303 || code === 307 || code === 308) {
					res.resume();
					const loc = res.headers.location;
					if (loc) { attempt(new URL(loc, currentUrl).toString(), redirectsLeft - 1); }
					else { state.status = 'error'; state.message = '重定向缺少 Location'; }
					return;
				}
				if (code < 200 || code >= 300) {
					res.resume();
					state.status = 'error';
					state.message = `HTTP ${code}`;
					this.logService.info(`[AgentStudio] comfy:download ${taskId} HTTP ${code}`);
					return;
				}
				const total = Number(res.headers['content-length'] ?? -1);
				state.total = Number.isFinite(total) && total > 0 ? total : -1;
				const file = createWriteStream(destPath);
				res.on('data', (chunk: Buffer) => {
					state.downloaded += chunk.length;
				});
				res.on('error', (err) => {
					state.status = 'error';
					state.message = err.message;
					file.destroy();
				});
				res.on('end', () => {
					state.status = 'success';
					state.message = `已保存 ${filename}`;
					this.logService.info(`[AgentStudio] comfy:download ${taskId} 完成 ${destPath}`);
				});
				res.pipe(file);
			});
			req.on('error', (err) => {
				state.status = 'error';
				state.message = err.message;
				this.logService.info(`[AgentStudio] comfy:download ${taskId} 失败: ${err.message}`);
			});
			req.end();
		};
		attempt(url, 5);
	}

	/**
	 * 查找占 baseUrl 端口的 LISTENING 进程 PID（跨平台）。
	 * Windows: `netstat -ano` 解析；Unix: `lsof -t -iTCP:PORT -sTCP:LISTEN`。
	 * 失败（命令不存在 / 超时 / 权限）返回空数组 → 上层 fallback 走 doLaunch。
	 * 排除自身 PID（杀自己 = 进程自杀）。
	 */
	private async findListeningPidsOnPort(port: number): Promise<number[]> {
		const cmd = process.platform === 'win32'
			? `netstat -ano -p TCP`
			: `lsof -nP -iTCP:${port} -sTCP:LISTEN -t`;
		try {
			const { stdout } = await execAsync(cmd, { timeout: 5000, windowsHide: true });
			const pids = new Set<number>();
			const portStr = `:${port}`;
			for (const line of stdout.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) { continue; }
				if (process.platform === 'win32') {
					// 形如 `TCP    0.0.0.0:8188    0.0.0.0:0    LISTENING    12345` —— 限定 LISTENING + 端口列匹配
					if (!trimmed.includes('LISTENING') || !trimmed.includes(portStr)) { continue; }
					const m = /\sLISTENING\s+(\d+)\s*$/.exec(trimmed);
					if (m?.[1]) { pids.add(Number(m[1])); }
				} else {
					// Unix: lsof -t 每行一个 PID
					const pid = Number(trimmed);
					if (Number.isFinite(pid) && pid > 0) { pids.add(pid); }
				}
			}
			pids.delete(process.pid);  // 不杀自己
			return Array.from(pids);
		} catch (err) {
			this.logService.info(`[AgentStudio] comfy:restart findPids ${cmd} 失败: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	/**
	 * 杀一组 PID（含子进程）。跨平台：
	 * - Windows: `taskkill /pid <pid> /T /F`（/T 杀进程树）
	 * - Unix: SIGTERM → 3s 后检查存活 → 仍活则 SIGKILL
	 * 返回每个 PID 的结果（成功/失败 + 错误），不抛。
	 */
	private async killPids(pids: number[]): Promise<{ pid: number; ok: boolean; error?: string }[]> {
		const results: { pid: number; ok: boolean; error?: string }[] = [];
		for (const pid of pids) {
			try {
				if (process.platform === 'win32') {
					await execAsync(`taskkill /pid ${pid} /T /F`, { timeout: 5000, windowsHide: true });
				} else {
					// Unix: 先 SIGTERM，3s 后还活就 SIGKILL。
					try {
						process.kill(pid, 'SIGTERM');
					} catch (e) {
						// ESRCH = 进程已不存在，视为成功（其他错误继续抛）
						if ((e as NodeJS.ErrnoException).code === 'ESRCH') { results.push({ pid, ok: true }); continue; }
						throw e;
					}
					await new Promise<void>(r => setTimeout(r, 3000));
					try {
						process.kill(pid, 0);  // signal 0 = 仅检查存活
						// 还活着 → SIGKILL
						process.kill(pid, 'SIGKILL');
					} catch (e) {
						// ESRCH = 3s 内已自然退出；其他错误抛
						if ((e as NodeJS.ErrnoException).code !== 'ESRCH') { throw e; }
					}
				}
				results.push({ pid, ok: true });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logService.info(`[AgentStudio] comfy:restart kill PID ${pid} 失败: ${msg}`);
				results.push({ pid, ok: false, error: msg });
			}
		}
		return results;
	}

	/**
	 * 等 baseUrl 端口释放（net.fetch 失败 = 端口空）。timeoutMs 超时返回 false。
	 */
	private async waitPortFree(baseUrl: string, timeoutMs = 10_000): Promise<boolean> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try {
				const r = await net.fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(800) });
				if (!r.ok) { /* 非 2xx = 端口开了但服务异常，仍占着 → 继续等 */ }
			} catch {
				// fetch 失败（ECONNREFUSED 等）= 端口已空
				return true;
			}
			await new Promise<void>(r => setTimeout(r, 200));
		}
		return false;
	}

	/**
	 * 共享启动逻辑（vscode:comfyLaunch 与 vscode:comfyRestart 都调用）。
	 * 流程：探测是否已在运行 → 解析路径 → spawn → 轮询等待可连。
	 * 已被占用的端口（alreadyRunning）由调用方先杀进程后调用本方法。
	 */
	private async doLaunch(baseUrl: string, payload?: { port?: number }): Promise<ComfyLaunchResult> {
		const result: ComfyLaunchResult = { ok: false, baseUrl };
		this.logService.info(`[AgentStudio] comfy:doLaunch baseUrl=${baseUrl}, payload=${JSON.stringify(payload ?? {})}`);

		// 1) 已在运行？→ 直接返回（不重复启动）。
		try {
			const probe = await net.fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(1500) });
			if (probe.ok) {
				const body = await probe.json().catch(() => undefined) as { system?: { comfyui_version?: string } } | undefined;
				result.ok = true;
				result.alreadyRunning = true;
				result.version = body?.system?.comfyui_version;
				this.logService.info(`[AgentStudio] comfy:doLaunch 已在运行, version=${result.version}`);
				return result;
			}
		} catch { /* 未运行 → 继续启动 */ }

		try {
			// 2) 解析 Comfy Desktop 安装路径。
			const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
			const configPath = join(appData, 'ComfyUI', 'config.json');
			const extraYamlPath = join(appData, 'ComfyUI', 'extra_models_config.yaml');
			const cfg = parseComfyDesktopConfig(
				existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined,
				existsSync(extraYamlPath) ? readFileSync(extraYamlPath, 'utf8') : undefined,
			);
			// 优先级：环境变量 > 用户设置 > 自动解析
			const configPython = (this.configurationService.getValue('sarosis.comfyui.pythonPath') as string | undefined)?.trim();
			const configMain = (this.configurationService.getValue('sarosis.comfyui.mainPath') as string | undefined)?.trim();
			const paths = pickComfyLaunchPaths(cfg, existsSync, {
				pythonPath: process.env['SAROS_COMFYUI_PYTHON'] || configPython || undefined,
				mainPyPath: process.env['SAROS_COMFYUI_MAIN'] || configMain || undefined,
			});
			if (!paths.pythonPath || !paths.mainPyPath) {
				result.error = `未找到 ComfyUI 启动文件（python: ${paths.pythonPath ?? '无'}；main.py: ${paths.mainPyPath ?? '无'}）。已解析 ${configPath} 与 ${extraYamlPath}；也可用环境变量 SAROS_COMFYUI_PYTHON / SAROS_COMFYUI_MAIN 指定。`;
				this.logService.info(`[AgentStudio] comfy:doLaunch 路径缺失: ${result.error}`);
				return result;
			}
			result.pythonPath = paths.pythonPath;
			result.mainPyPath = paths.mainPyPath;

			// 3) spawn 独立子进程（detached：VsSaros 退出后 ComfyUI 仍运行）。
			const port = payload?.port ?? (Number(new URL(baseUrl).port) || 8188);
			// Comfy Desktop 的模型/自定义节点在用户根（basePath），而非 main.py 同目录（只读应用根）。
			// 缺了 --base-directory，ComfyUI 会找不到 checkpoints（/object_info 的 ckpt_name 列表为空），
			// 导致 /prompt 提交时报 value_not_in_list。basePath 从 Comfy Desktop config.json 解析。
			const spawnArgs = ['main.py', '--enable-cors-header', '--listen', '127.0.0.1', '--port', String(port)];
			if (cfg.basePath) { spawnArgs.push('--base-directory', cfg.basePath); }
			this.logService.info(`[AgentStudio] comfy:doLaunch spawn: python=${paths.pythonPath}, main=${paths.mainPyPath}, port=${port}, baseDir=${cfg.basePath ?? '(default)'}`);
			const child = spawn(paths.pythonPath, spawnArgs, {
				cwd: dirname(paths.mainPyPath),
				detached: true,
				env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
				stdio: 'ignore',
				windowsHide: true,
			});
			child.unref();
			result.pid = child.pid;

			// 4) 轮询等待可连（最长 ~120s；ComfyUI 首次加载 torch+模型可能 >60s）。
			const started = Date.now();
			while (Date.now() - started < 120_000) {
				await new Promise(r => setTimeout(r, 800));
				try {
					const probe = await net.fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(1500) });
					if (probe.ok) {
						const body = await probe.json().catch(() => undefined) as { system?: { comfyui_version?: string } } | undefined;
						result.ok = true;
						result.version = body?.system?.comfyui_version;
						return result;
					}
				} catch { /* 继续等待 */ }
			}
			// 轮询超时但进程已 spawn（.venv 的 python 是 uv 引导器）。标记 starting，前端继续探测。
			result.ok = true;
			result.starting = true;
			result.error = `ComfyUI 仍在后台启动中（PID ${result.pid ?? '-'}），尚未监听 ${baseUrl}。首次加载模型可能需要 1-3 分钟，请稍后点击「重新检测」。`;
			this.logService.info(`[AgentStudio] comfy:doLaunch 仍在后台启动: ${result.error}`);
			return result;
		} catch (err) {
			result.error = `启动失败：${err instanceof Error ? err.message : String(err)}`;
			this.logService.info(`[AgentStudio] comfy:doLaunch ${result.error}`);
			return result;
		}
	}

	private registerChannels(): void {
		// ComfyUI 一键启动（方案A 前置：--enable-cors-header 允许 webview 直连）。
		// 注意：validatedIpcMain 要求 channel 以 `vscode:` 开头（见 ipcMain.ts validateEvent），
		// 因此命名 `vscode:comfyLaunch`（不是 comfy:launch）。
		// renderer → webview → 本 handler：
		//   1) 探测 baseUrl 是否已在运行（避免与 Comfy Desktop 双实例抢 8188）；
		//   2) 解析 Comfy Desktop config（%APPDATA%\ComfyUI\config.json + extra_models_config.yaml）
		//      → 挑选存在的 python 与 main.py（环境变量 SAROS_COMFYUI_PYTHON / SAROS_COMFYUI_MAIN 可覆盖）；
		//   3) spawn `python main.py --enable-cors-header --listen 127.0.0.1 --port <port>`（detached）；
		//   4) 轮询等待 /system_stats 可连。
				validatedIpcMain.handle('vscode:comfyLaunch', async (_event, payload: { baseUrl?: string; port?: number } | undefined) => {
			const baseUrl = (payload?.baseUrl ?? 'http://127.0.0.1:8188').replace(/\/+$/, '');
			return await this.doLaunch(baseUrl, payload);
		});

		// ComfyUI 重启为跨域直连模式：探测占 baseUrl 端口的 PID → 杀进程（含子进程）→
		// 等端口释放 → 用 --enable-cors-header 重新启动（共享 doLaunch）。
		// 用于 Comfy Desktop 已开但未带 --enable-cors-header 的场景：「代理」模式下
		// 「重启为跨域直连」一键触发，无需手动开命令行 + 杀进程 + 启动。
		validatedIpcMain.handle('vscode:comfyRestart', async (_event, payload: { baseUrl?: string; port?: number } | undefined) => {
			const baseUrl = (payload?.baseUrl ?? 'http://127.0.0.1:8188').replace(/\/+$/, '');
			const port = payload?.port ?? (Number(new URL(baseUrl).port) || 8188);
			this.logService.info(`[AgentStudio] comfy:restart 收到 baseUrl=${baseUrl} port=${port}`);
			const result: ComfyLaunchResult = { ok: false, baseUrl };

			// 1) 探测占端口的 PID（跨平台 netstat / lsof）。无占用 → 跳过杀进程。
			const pids = await this.findListeningPidsOnPort(port);
			if (pids.length === 0) {
				this.logService.info(`[AgentStudio] comfy:restart 端口 ${port} 无占用进程，跳过杀进程`);
			} else {
				this.logService.info(`[AgentStudio] comfy:restart 杀掉占 ${port} 的 PID ${pids.join(',')}`);
				result.killed = await this.killPids(pids);
				const killedOk = result.killed.every(k => k.ok);
				if (!killedOk) {
					const failed = result.killed.filter(k => !k.ok).map(k => `${k.pid}(${k.error})`).join(', ');
					result.error = `杀掉 PID 失败：${failed}。请手动 taskkill 后重试。`;
					this.logService.info(`[AgentStudio] comfy:restart ${result.error}`);
					return result;
				}
				// 2) 等端口释放（杀完到 TCP TIME_WAIT 完结可能 ~10s）。
				const freed = await this.waitPortFree(baseUrl, 10_000);
				if (!freed) {
					result.error = `杀掉 PID ${pids.join(',')} 后端口 ${port} 仍未释放（10s 超时）`;
					this.logService.info(`[AgentStudio] comfy:restart ${result.error}`);
					return result;
				}
			}

			// 3) 复用 doLaunch 启动（带 --enable-cors-header）。
			const launched = await this.doLaunch(baseUrl, { port });
			return { ...launched, killed: result.killed };
		});

		;

		// 查询主进程解析的当前 ComfyUI 启动路径（含 overrides 来源），
		// 用于 Runner 面板「EXE 路径」区域显示与编辑。
		validatedIpcMain.handle('vscode:comfyGetLaunchPaths', async () => {
			const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
			const configPath = join(appData, 'ComfyUI', 'config.json');
			const extraYamlPath = join(appData, 'ComfyUI', 'extra_models_config.yaml');
			const cfg = parseComfyDesktopConfig(
				existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined,
				existsSync(extraYamlPath) ? readFileSync(extraYamlPath, 'utf8') : undefined,
			);
			const overridePy = (process.env['SAROS_COMFYUI_PYTHON'] ?? (this.configurationService.getValue('sarosis.comfyui.pythonPath') as string | undefined) ?? '').trim();
			const overrideMain = (process.env['SAROS_COMFYUI_MAIN'] ?? (this.configurationService.getValue('sarosis.comfyui.mainPath') as string | undefined) ?? '').trim();
			const source: 'env' | 'override' | 'auto' = (process.env['SAROS_COMFYUI_PYTHON'] || process.env['SAROS_COMFYUI_MAIN'])
				? 'env'
				: (overridePy || overrideMain)
					? 'override'
					: 'auto';
			const paths = pickComfyLaunchPaths(cfg, existsSync, {
				pythonPath: overridePy || undefined,
				mainPyPath: overrideMain || undefined,
			});
			return { ok: true, pythonPath: paths.pythonPath, mainPyPath: paths.mainPyPath, source, overrides: { pythonPath: overridePy, mainPyPath: overrideMain } };
		});

		// 写入 ComfyUI 启动路径配置（持久化到用户 settings）；空串视为清除（回退自动解析）。
		validatedIpcMain.handle('vscode:comfySetLaunchPaths', async (_event, payload: { pythonPath?: string; mainPyPath?: string } | undefined) => {
			const py = (payload?.pythonPath ?? '').trim();
			const main = (payload?.mainPyPath ?? '').trim();
			await this.configurationService.updateValue('sarosis.comfyui.pythonPath', py);
			await this.configurationService.updateValue('sarosis.comfyui.mainPath', main);
			return { ok: true };
		});

		// 依赖检测：ComfyUI 是否安装（能否解析到 python+main.py）、是否在运行（8188），
		// 以及本地模型目录已有哪些模型文件。前端据此引导「安装 ComfyUI / 下载模型」。
		validatedIpcMain.handle('vscode:comfyCheckDeps', async (_event, payload: { baseUrl?: string } | undefined) => {
			const baseUrl = (payload?.baseUrl ?? 'http://127.0.0.1:8188').replace(/\/+$/, '');
			const cfg = this.resolveDesktopConfig();
			const configPython = (this.configurationService.getValue('sarosis.comfyui.pythonPath') as string | undefined)?.trim();
			const configMain = (this.configurationService.getValue('sarosis.comfyui.mainPath') as string | undefined)?.trim();
			const paths = pickComfyLaunchPaths(cfg, existsSync, {
				pythonPath: process.env['SAROS_COMFYUI_PYTHON'] || configPython || undefined,
				mainPyPath: process.env['SAROS_COMFYUI_MAIN'] || configMain || undefined,
			});
			const installed = !!(paths.pythonPath && paths.mainPyPath);
			let running = false;
			let version: string | undefined;
			try {
				const probe = await net.fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(1500) });
				if (probe.ok) {
					running = true;
					const body = await probe.json().catch(() => undefined) as { system?: { comfyui_version?: string } } | undefined;
					version = body?.system?.comfyui_version;
				}
			} catch { /* 未运行 */ }
			return {
				ok: true,
				comfyui: {
					installed,
					running,
					version,
					pythonPath: paths.pythonPath,
					mainPyPath: paths.mainPyPath,
					baseUrl,
				},
				models: {
					dir: this.resolveModelsDir(),
					checkpoints: this.listModelFiles('checkpoints'),
					diffusion_models: this.listModelFiles('diffusion_models'),
					loras: this.listModelFiles('loras'),
					vae: this.listModelFiles('vae'),
				},
			};
		});

		// 模型下载：从 URL 流式下载到 models/<type>/<filename>，返回 taskId 供进度查询。
		// type 合法值：checkpoints / diffusion_models / loras / vae / clip_vision / controlnet。
		validatedIpcMain.handle('vscode:comfyDownloadModel', async (_event, payload: { url: string; filename: string; type?: string } | undefined) => {
			const url = payload?.url?.trim();
			const filename = payload?.filename?.trim();
			if (!url || !filename) {
				return { ok: false, error: 'url 与 filename 必填' };
			}
			const type = (payload?.type ?? 'checkpoints').trim();
			const destDir = join(this.resolveModelsDir(), type);
			const taskId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			this.logService.info(`[AgentStudio] comfy:download 开始 taskId=${taskId} url=${url} → ${join(destDir, filename)}`);
			this.startDownload(taskId, url, destDir, filename);
			return { ok: true, taskId };
		});

		// 查询模型下载进度（前端轮询，1s 间隔）。返回所有进行中的下载任务。
		validatedIpcMain.handle('vscode:comfyGetDownloadProgress', async () => {
			const list = Array.from(this.downloads.values()).map(d => ({
				taskId: d.taskId,
				url: d.url,
				filename: d.filename,
				status: d.status,
				downloaded: d.downloaded,
				total: d.total,
				message: d.message,
			}));
			return { ok: true, downloads: list };
		});
	}
}
