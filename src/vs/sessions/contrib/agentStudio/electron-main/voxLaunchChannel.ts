/*---------------------------------------------------------------------------------------------
 *  voxLaunchChannel — Vox 口播视频节点（Vox.DirectorStage）的主进程 IPC channel 宿主。
 *
 *  参照 comfyLaunchChannel 的「webview → renderer 透传 → 主进程 validatedIpcMain.handle」
 *  模式，新增 `vscode:voxRun` / `vscode:voxGetProgress` / `vscode:voxCancel` /
 *  `vscode:voxCheckDeps` 四个 invoke handler。
 *
 *  职责：
 *   - 路径发现：vox 项目路径（settings `sarosis.vox.projectPath` / env `SAROS_VOX_PROJECT`）
 *     与 python 解释器（settings `sarosis.vox.pythonPath` / env `SAROS_VOX_PYTHON` / PATH `python`）；
 *   - 写 `beats.json` 到 `<project>/out/<projectId>/beats.json`；
 *   - spawn `python vox_pipeline.py <outDir>`（stdio pipe），解析 stdout 的
 *     `[PROGRESS] <stage> <i>/<n>` / `[ERROR]` 行维护状态；
 *   - 前端轮询 `vscode:voxGetProgress` 拿阶段进度，`vscode:voxCancel` kill。
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { validatedIpcMain } from '../../../../base/parts/ipc/electron-main/ipcMain.js';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, createReadStream, readdirSync } from 'fs';
import { join, extname, resolve, dirname } from 'path';
import { createInterface } from 'readline';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';

/** 主进程侧 vox 运行状态（前端通过 voxGetProgress 轮询）。 */
export interface VoxRunState {
	projectId: string;
	status: 'running' | 'success' | 'error' | 'canceled';
	/** 当前阶段（keyframes/clips/audio/assemble/done）。 */
	stage: string;
	/** 0-100 整数进度（4 阶段各占 25，done=100）。 */
	progress: number;
	finalMp4Path?: string;
	/** webview 可直接播放的 http 静态 URL（vox 静态服务暴露 out 目录）。 */
	finalMp4Url?: string;
	error?: string;
	/** 关键日志（submit/complete/error 等，用于排查）。 */
	logs: string[];
}

const MIME: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mov': 'video/quicktime',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.m4a': 'audio/mp4',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.json': 'application/json',
	'.txt': 'text/plain',
};

export class VoxLaunchChannel extends Disposable {

	private readonly runs = new Map<string, { state: VoxRunState; child: ChildProcess }>();
	/** 惰性启动的静态文件服务（暴露 vox out 目录，供 webview <video> 播放 final.mp4）。 */
	private _staticServer: Server | undefined;
	private _staticPort = 0;
	/** 静态服务暴露的根目录（vox <project>/out）。 */
	private _staticRoot = '';

	constructor(
		private readonly logService: ILogService,
		private readonly configurationService: IConfigurationService,
	) {
		super();
		this.registerChannels();
	}

	override dispose(): void {
		// 取消所有进行中的子进程
		for (const { child } of this.runs.values()) {
			try { child.kill(); } catch { /* 已退出 */ }
		}
		this.runs.clear();
		this._staticServer?.close();
		this._staticServer = undefined;
		validatedIpcMain.removeHandler('vscode:voxRun');
		validatedIpcMain.removeHandler('vscode:voxGetProgress');
		validatedIpcMain.removeHandler('vscode:voxCancel');
		validatedIpcMain.removeHandler('vscode:voxCheckDeps');
		super.dispose();
	}

	/** 惰性启动静态文件服务，暴露 vox out 目录。返回 `http://127.0.0.1:{port}`。 */
	private ensureStaticServer(): string {
		if (this._staticServer) { return `http://127.0.0.1:${this._staticPort}`; }
		const outRoot = resolve(join(this.resolveProjectPath(), 'out'));
		this._staticRoot = outRoot;
		// 端口：优先 settings `sarosis.vox.staticPort`，否则 0（随机可用端口）。
		const configuredPort = Number(this.configurationService.getValue('sarosis.vox.staticPort') ?? 0);
		const server = createServer((req, res) => this.handleStatic(req, res));
		server.on('error', (err) => {
			this.logService.error(`[AgentStudio] vox static server error: ${err.message}`);
		});
		server.listen(configuredPort || 0, '127.0.0.1', () => {
			const addr = server.address();
			this._staticPort = typeof addr === 'object' && addr ? addr.port : configuredPort;
			this.logService.info(`[AgentStudio] vox static server listening on http://127.0.0.1:${this._staticPort} root=${outRoot}`);
		});
		this._staticServer = server;
		return `http://127.0.0.1:${this._staticPort || configuredPort || 8191}`;
	}

	/** 静态文件处理（含 Range 支持，供 <video> seek）。 */
	private handleStatic(req: IncomingMessage, res: ServerResponse): void {
		try {
			const url = (req.url ?? '/').split('?')[0];
			const decoded = decodeURIComponent(url);
			// 路径穿越防护：解析后必须仍在 staticRoot 内
			const target = resolve(join(this._staticRoot, decoded.replace(/^\//, '')));
			if (!target.startsWith(resolve(this._staticRoot))) {
				res.writeHead(403); res.end('Forbidden'); return;
			}
			if (!existsSync(target) || !statSync(target).isFile()) {
				res.writeHead(404); res.end('Not found'); return;
			}
			const stat = statSync(target);
			const ext = extname(target).toLowerCase();
			const contentType = MIME[ext] ?? 'application/octet-stream';
			const range = req.headers.range;
			if (range) {
				const m = /bytes=(\d*)-(\d*)/.exec(range);
				const total = stat.size;
				let start = 0;
				let end = total - 1;
				if (m) {
					if (m[1]) { start = parseInt(m[1], 10); }
					if (m[2]) { end = Math.min(parseInt(m[2], 10), total - 1); }
				}
				if (start >= total || start > end) {
					res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return;
				}
				res.writeHead(206, {
					'Content-Type': contentType,
					'Content-Range': `bytes ${start}-${end}/${total}`,
					'Accept-Ranges': 'bytes',
					'Content-Length': end - start + 1,
				});
				createReadStream(target, { start, end }).pipe(res);
			} else {
				res.writeHead(200, {
					'Content-Type': contentType,
					'Content-Length': stat.size,
					'Accept-Ranges': 'bytes',
				});
				createReadStream(target).pipe(res);
			}
		} catch (err) {
			res.writeHead(500); res.end('Internal error');
		}
	}

	/** 解析 vox 项目根路径（优先 settings/env，兜底固定路径）。 */
	private resolveProjectPath(): string {
		const configured = (this.configurationService.getValue('sarosis.vox.projectPath') as string | undefined)?.trim();
		const fromEnv = process.env['SAROS_VOX_PROJECT']?.trim();
		return configured || fromEnv || 'G:\\CustomWorkspaces\\AIProjects\\vox-ai-motion-graphics-generator';
	}

	/** 解析 python 解释器（优先 settings/env，兜底 PATH `python`）。 */
	private resolvePythonPath(): string {
		const configured = (this.configurationService.getValue('sarosis.vox.pythonPath') as string | undefined)?.trim();
		const fromEnv = process.env['SAROS_VOX_PYTHON']?.trim();
		return configured || fromEnv || 'python';
	}

	private resolveApiKey(): string | undefined {
		const configured = (this.configurationService.getValue('sarosis.vox.apiKey') as string | undefined)?.trim();
		return process.env['MUAPI_API_KEY'] || configured || undefined;
	}

	/**
	 * 查找内置二进制（ffmpeg/ffprobe）。优先级：
	 *   1. 打包后 resources/saros/bin/（安装包自带，零用户操作）；
	 *   2. dev 模式：从 __dirname 向上查找 build/saros/bin/。
	 */
	private findBuiltinBin(name: string): string | undefined {
		const exe = process.platform === 'win32' ? `${name}.exe` : name;
		const packaged = join(this.resourcesPath(), 'saros', 'bin', exe);
		if (existsSync(packaged)) { return packaged; }
		let dir = __dirname;
		for (let i = 0; i < 8; i++) {
			const candidate = join(dir, 'build', 'saros', 'bin', exe);
			if (existsSync(candidate)) { return candidate; }
			const parent = dirname(dir);
			if (parent === dir) { break; }
			dir = parent;
		}
		return undefined;
	}

	/**
	 * 探测 winget 安装的 ffmpeg（`%LOCALAPPDATA%\Microsoft\WinGet\Packages\*ffmpeg*\...\bin\`）。
	 * winget 装 ffmpeg 不写 PATH，用户常「装了但找不到」——这里作为 PATH 之外的兜底，
	 * 让 winget 用户开箱即用（零下载、零安装包体积）。
	 */
	private findWingetBin(name: string): string | undefined {
		if (process.platform !== 'win32') { return undefined; }
		const exe = `${name}.exe`;
		const localAppData = process.env['LOCALAPPDATA'];
		if (!localAppData) { return undefined; }
		const pkgsRoot = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
		let pkgNames: string[] = [];
		try {
			pkgNames = readdirSync(pkgsRoot).filter(n => n.toLowerCase().includes('ffmpeg'));
		} catch { return undefined; }
		for (const pkg of pkgNames) {
			const pkgDir = join(pkgsRoot, pkg);
			let versionDirs: string[] = [];
			try { versionDirs = readdirSync(pkgDir); } catch { continue; }
			for (const vd of versionDirs) {
				const candidate = join(pkgDir, vd, 'bin', exe);
				if (existsSync(candidate)) { return candidate; }
			}
		}
		return undefined;
	}

	/**
	 * 解析 ffmpeg 二进制路径（多级优先级）：
	 *   1. settings `sarosis.vox.ffmpegPath` / env `FFMPEG_PATH`；
	 *   2. 内置 resources/saros/bin/ffmpeg.exe（安装包自带）；
	 *   3. winget 安装目录（本机已装但不在 PATH 的常见情况）；
	 *   4. undefined（调用方降级 PATH `ffmpeg`）。
	 */
	private resolveFfmpegPath(): string | undefined {
		const configured = (this.configurationService.getValue('sarosis.vox.ffmpegPath') as string | undefined)?.trim();
		const fromEnv = process.env['FFMPEG_PATH']?.trim();
		if (configured) { return configured; }
		if (fromEnv) { return fromEnv; }
		return this.findBuiltinBin('ffmpeg') ?? this.findWingetBin('ffmpeg');
	}

	/** 解析 ffprobe（同 ffmpeg 多级优先级）。 */
	private resolveFfprobePath(): string | undefined {
		const configured = (this.configurationService.getValue('sarosis.vox.ffprobePath') as string | undefined)?.trim();
		const fromEnv = process.env['FFPROBE_PATH']?.trim();
		if (configured) { return configured; }
		if (fromEnv) { return fromEnv; }
		return this.findBuiltinBin('ffprobe') ?? this.findWingetBin('ffprobe');
	}

	/** 安装包资源根（process.resourcesPath；dev 下回退 appRoot）。 */
	private resourcesPath(): string {
		const rp = (process as unknown as { resourcesPath?: string }).resourcesPath;
		return rp || resolve(__dirname, '../../../../..');
	}

	private registerChannels(): void {
		// 启动 vox pipeline（异步 spawn，立即返回 projectId，进度走 voxGetProgress）。
		validatedIpcMain.handle('vscode:voxRun', async (_event, payload: { projectId: string; beats: unknown } | undefined) => {
			const projectId = payload?.projectId?.trim();
			const beats = payload?.beats;
			if (!projectId || !beats) {
				return { ok: false, error: 'projectId 与 beats 必填' };
			}
			// 已存在同 projectId 运行 → 拒绝重复
			if (this.runs.has(projectId)) {
				return { ok: false, error: `项目 ${projectId} 已在运行中` };
			}
			try {
				const projectPath = this.resolveProjectPath();
				const scriptsDir = join(projectPath, 'scripts');
				const pipeline = join(scriptsDir, 'vox_pipeline.py');
				if (!existsSync(pipeline)) {
					return { ok: false, error: `未找到 vox 入口脚本 ${pipeline}（请确认 sarosis.vox.projectPath 指向 vox-ai-motion-graphics-generator）` };
				}
				const python = this.resolvePythonPath();
				// 输出目录：<project>/out/<projectId>/
				const outDir = join(projectPath, 'out', projectId);
				mkdirSync(outDir, { recursive: true });
				writeFileSync(join(outDir, 'beats.json'), JSON.stringify(beats, null, 2), 'utf-8');

				const state: VoxRunState = { projectId, status: 'running', stage: 'keyframes', progress: 0, logs: [] };
				const env: Record<string, string> = {
					...process.env as Record<string, string>,
					PYTHONIOENCODING: 'utf-8',
					PYTHONUTF8: '1',
				};
				const apiKey = this.resolveApiKey();
				if (apiKey) { env['MUAPI_API_KEY'] = apiKey; }
				// ★ 注入 ffmpeg/ffprobe 绝对路径（LocalProvider + assemble.py 依赖）：
				//   优先内置 resources/saros/bin，确保「vssaros 默认自带 ffmpeg」。
				const ffmpeg = this.resolveFfmpegPath();
				const ffprobe = this.resolveFfprobePath();
				if (ffmpeg) { env['FFMPEG_PATH'] = ffmpeg; }
				if (ffprobe) { env['FFPROBE_PATH'] = ffprobe; }
				this.logService.info(`[AgentStudio] vox:run ffmpeg=${ffmpeg ?? '(PATH)'} ffprobe=${ffprobe ?? '(PATH)'}`);

				this.logService.info(`[AgentStudio] vox:run spawn python=${python} pipeline=${pipeline} out=${outDir}`);
				const child = spawn(python, [pipeline, outDir], {
					cwd: scriptsDir,
					env,
					stdio: ['ignore', 'pipe', 'pipe'],
					windowsHide: true,
				});

				// stdout 行解析 [PROGRESS] / [ERROR]
				const rl = createInterface({ input: child.stdout! });
				rl.on('line', (line: string) => {
					state.logs.push(line);
					const pm = /^\[PROGRESS\]\s+(\S+)\s+(\d+)\/(\d+)\s*(.*)$/.exec(line.trim());
					if (pm) {
						const stage = pm[1];
						const i = Number(pm[2]);
						const n = Number(pm[3]);
						state.stage = stage;
						state.progress = stage === 'done' ? 100 : Math.max(0, Math.min(100, Math.round(((i - 1) / n) * 100)));
						this.logService.info(`[AgentStudio] vox:progress ${projectId} ${stage} ${state.progress}%`);
					} else if (line.trim().startsWith('[ERROR]')) {
						state.error = line.trim().slice('[ERROR]'.length).trim();
					}
				});
				const errLines: string[] = [];
				const errRl = createInterface({ input: child.stderr! });
				errRl.on('line', (line: string) => { errLines.push(line); state.logs.push(line); });

				child.on('error', (err) => {
					state.status = 'error';
					state.error = `spawn python 失败：${err.message}`;
				});
				child.on('exit', (code) => {
					rl.close();
					errRl.close();
					if (state.status === 'canceled') { return; }
					if (code === 0 && !state.error) {
						const final = join(outDir, 'final.mp4');
						state.status = 'success';
						state.progress = 100;
						state.stage = 'done';
						state.finalMp4Path = final;
						// ★ 暴露 webview 可播放的 http URL（静态服务暴露 out 目录，
						//   相对路径 = <projectId>/final.mp4）。file:// 在 webview 被 CSP 拦。
						const base = this.ensureStaticServer();
						state.finalMp4Url = `${base}/${projectId}/final.mp4`;
						this.logService.info(`[AgentStudio] vox:done ${projectId} → ${final} (url ${state.finalMp4Url})`);
					} else {
						state.status = 'error';
						state.error = state.error || (errLines.join('\n').slice(-500) || `pipeline 退出码 ${code}`);
					}
					// 完成后保留状态供前端拉取；延迟清理
					setTimeout(() => { this.runs.delete(projectId); }, 60_000);
				});

				this.runs.set(projectId, { state, child });
				return { ok: true, projectId };
			} catch (err) {
				return { ok: false, error: `vox:run 启动失败：${err instanceof Error ? err.message : String(err)}` };
			}
		});

		// 查询运行状态/进度（前端 1s 轮询）。
		validatedIpcMain.handle('vscode:voxGetProgress', async (_event, payload: { projectId: string } | undefined) => {
			const projectId = payload?.projectId?.trim();
			const run = projectId ? this.runs.get(projectId) : undefined;
			if (!run) { return { ok: true, state: undefined }; }
			return { ok: true, state: run.state };
		});

		// 取消运行（kill 子进程）。
		validatedIpcMain.handle('vscode:voxCancel', async (_event, payload: { projectId: string } | undefined) => {
			const projectId = payload?.projectId?.trim();
			const run = projectId ? this.runs.get(projectId) : undefined;
			if (!run) { return { ok: true }; }
			run.state.status = 'canceled';
			run.state.error = '已取消';
			try { run.child.kill(); } catch { /* 已退出 */ }
			return { ok: true };
		});

		// 依赖检测：python / vox 项目 / 入口脚本 / ffmpeg / MUAPI_API_KEY。
		validatedIpcMain.handle('vscode:voxCheckDeps', async () => {
			const projectPath = this.resolveProjectPath();
			const scriptsDir = join(projectPath, 'scripts');
			const pipeline = join(scriptsDir, 'vox_pipeline.py');
			const python = this.resolvePythonPath();
			const apiKey = this.resolveApiKey();
			const ffmpeg = this.resolveFfmpegPath();
			const ffprobe = this.resolveFfprobePath();
			const hasFfmpeg = (() => {
				if (ffmpeg) { return true; }
				try {
					execSync('ffmpeg -version', { stdio: 'ignore' });
					return true;
				} catch { return false; }
			})();
			return {
				ok: true,
				vox: {
					projectPath,
					pipelineExists: existsSync(pipeline),
					pipeline,
					python,
					hasApiKey: !!apiKey,
					hasFfmpeg,
					ffmpegPath: ffmpeg,
					ffprobePath: ffprobe,
				},
			};
		});
	}
}

/** 读取文件为字符串（供 channel 内部/测试复用）。 */
export function readTextFile(path: string): string | undefined {
	try { return readFileSync(path, 'utf-8'); } catch { return undefined; }
}
