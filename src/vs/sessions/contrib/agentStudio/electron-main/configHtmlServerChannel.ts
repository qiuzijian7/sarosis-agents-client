/*---------------------------------------------------------------------------------------------
 *  configHtmlServerChannel — ConfigHTML **URL 模式**下的本地服务「按需拉起 / 停止」。
 *
 *  背景：ConfigHtml 面板（ConfigHtmlPanel.tsx）的 CSP 是 `default-src 'none'`，既不能
 *  iframe 也不能 fetch 本地 http；URL 预览容器（UrlPreviewEditorPane，`frame-src *`）
 *  能渲染本地页面，但自己不会拉起服务。本通道补上「探测 → 拉起 → 等就绪 → 停止」。
 *
 *  设计要点：
 *  - **主进程只负责执行**：command/args/cwd 由 renderer 侧解析好（它有 workspace 上下文，
 *    能展开 `${workspaceRoot}` / `${agentDir}`），主进程不做路径猜测，避免在主进程里
 *    重复实现工作区解析。
 *  - **detached + unref**：服务独立于 VsSaros 生命周期，预览关闭后仍可用（下次预览秒开）。
 *  - **退出时清理**：注册 `onWillShutdown` 按端口查杀，避免进程残留。
 *  - 不抛异常：所有失败以 `{ ok:false, error }` 返回，供前端展示「启动失败 + 重试」。
 *
 *  与 comfyLaunchChannel 的区别：后者是产品级 ComfyUI 启动（含配置解析/uv 引导/模型目录）；
 *  本通道是通用执行器，只认调用方给的命令。
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { exec as execCb } from 'child_process';
import { net } from 'electron';
import { ILogService } from '../../../../platform/log/common/log.js';
import { validatedIpcMain } from '../../../../base/parts/ipc/electron-main/ipcMain.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

const execAsync = (cmd: string, opts: { timeout?: number; windowsHide?: boolean } = {}) =>
	new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		execCb(cmd, { timeout: opts.timeout ?? 8000, windowsHide: opts.windowsHide ?? true }, (err, stdout, stderr) => {
			if (err) { reject(err); return; }
			resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
	});

export interface ConfigHtmlServerSpec {
	/** 目标 URL（如 `http://127.0.0.1:5600`）。 */
	url: string;
	command?: string;
	args?: string[];
	cwd?: string;
	port?: number;
	healthPath?: string;
	/** 可选：探活时响应体必须包含该子串，才算「是我们的服务」（防端口被占用误判）。 */
	healthExpect?: string;
	readyTimeoutMs?: number;
	env?: Record<string, string>;
}

export interface ConfigHtmlEnsureResult {
	ok: boolean;
	url: string;
	alreadyRunning?: boolean;
	starting?: boolean;
	pid?: number;
	error?: string;
	elapsedMs?: number;
}

export class ConfigHtmlServerChannel extends Disposable {

	/** 本次会话拉起过的端口，供退出时统一清理。 */
	private readonly _spawnedPorts = new Set<number>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
	) {
		super();
		this.registerChannels();
		this.registerShutdown();
	}

	// ── 探测 ─────────────────────────────────────────────────────────────
	/**
	 * 探活 + **可选身份校验**。
	 * ⚠ 只探活是不够的：端口可能被**别的程序**占着（我们自己的服务并没起来），
	 *   此时 HTTP<500 照样命中，ensure 会误判「已在运行」→ 预览打开的是别人的页面。
	 *   配置 `healthExpect` 时，响应体必须包含该子串才算「是我们的服务」。
	 */
	private async probe(spec: ConfigHtmlServerSpec, timeoutMs = 1200): Promise<{ alive: boolean; identityOk: boolean; snippet?: string }> {
		const health = `${spec.url.replace(/\/+$/, '')}${spec.healthPath ?? '/'}`;
		try {
			const r = await net.fetch(health, { signal: AbortSignal.timeout(timeoutMs) });
			const alive = r.ok || r.status < 500;   // 404 也算「服务活着」（只探活，不看业务路径）
			if (!alive) { return { alive, identityOk: false }; }
			if (!spec.healthExpect) { return { alive: true, identityOk: true }; }
			const text = (await r.text()).slice(0, 4096);
			return {
				alive: true,
				identityOk: text.includes(spec.healthExpect),
				snippet: text.slice(0, 200),
			};
		} catch {
			return { alive: false, identityOk: false };
		}
	}

	private portOf(spec: ConfigHtmlServerSpec): number {
		if (typeof spec.port === 'number') { return spec.port; }
		try { return Number(new URL(spec.url).port) || 5600; } catch { return 5600; }
	}

	// ── 拉起 ─────────────────────────────────────────────────────────────
	private async ensure(spec: ConfigHtmlServerSpec): Promise<ConfigHtmlEnsureResult> {
		const started = Date.now();
		const result: ConfigHtmlEnsureResult = { ok: false, url: spec.url };

		// 1) 已在运行 → 直接返回（★ 必须过身份校验：端口被别的程序占用时不能误判）
		const first = await this.probe(spec);
		if (first.alive) {
			if (!first.identityOk) {
				result.error = `端口 ${this.portOf(spec)} 已被其他程序占用：响应中未找到特征串 "${spec.healthExpect}"。请更换面板端口，或关闭占用该端口的程序。`
					+ (first.snippet ? `\n—— 实际响应片段 ——\n${first.snippet}` : '');
				this.logService.info(`[AgentStudio] configHtml:ensure ${result.error}`);
				return result;
			}
			result.ok = true;
			result.alreadyRunning = true;
			result.elapsedMs = Date.now() - started;
			this.logService.info(`[AgentStudio] configHtml:ensure 已在运行 ${spec.url}`);
			return result;
		}

		const command = spec.command || process.execPath;
		const args = spec.args ?? [];
		if (!spec.command && args.length === 0) {
			result.error = '未配置启动命令，且没有内置默认（请在 configHtml.server 中提供 command/args）';
			return result;
		}

		// 子进程输出尾部（诊断用）：超时/未就绪时随 error 带回前端操作日志
		const tail: string[] = [];
		const pushTail = (s: string) => {
			tail.push(s);
			while (tail.join('').length > 4000) { tail.shift(); }
		};

		try {
			// ★ process.execPath 在主进程是 **Electron.exe** 而非 node.exe——直接跑 .mjs
			//   会被当作 app 入口加载并立即退出（表现为「30s 内未响应」）。
			//   ELECTRON_RUN_AS_NODE=1 让它以纯 Node 模式执行脚本（vscode 主进程 spawn
			//   node 子进程的标准做法）。stdio 用 pipe 捕获输出，供诊断。
			const child = spawn(command, args, {
				cwd: spec.cwd || undefined,
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(spec.env ?? {}) },
				detached: true,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
			child.unref();
			child.stdout?.on('data', (c: Buffer) => pushTail(c.toString()));
			child.stderr?.on('data', (c: Buffer) => pushTail(c.toString()));
			child.on('exit', (code) => {
				pushTail(`[子进程退出 code=${code}]`);
				this.logService.info(`[AgentStudio] configHtml:ensure child pid=${String(child.pid)} exited code=${code}`);
			});
			result.pid = child.pid;
			this._spawnedPorts.add(this.portOf(spec));
			this.logService.info(`[AgentStudio] configHtml:ensure spawn pid=${String(child.pid)} cmd=${command} args=${args.join(' ')} cwd=${spec.cwd ?? '(inherit)'}`);
		} catch (err) {
			result.error = `启动失败：${err instanceof Error ? err.message : String(err)}`;
			this.logService.info(`[AgentStudio] configHtml:ensure ${result.error}`);
			return result;
		}

		// 2) 轮询等就绪
		const timeout = spec.readyTimeoutMs ?? 30_000;
		while (Date.now() - started < timeout) {
			await new Promise<void>(r => setTimeout(r, 500));
			const p = await this.probe(spec);
			if (p.alive && p.identityOk) {
				result.ok = true;
				result.elapsedMs = Date.now() - started;
				this.logService.info(`[AgentStudio] configHtml:ensure 就绪 ${spec.url} (${String(result.elapsedMs)}ms)`);
				return result;
			}
		}

		// 3) 超时：进程可能仍在启动（首次构建/扫描节点），标记 starting 让前端继续探测
		result.starting = true;
		result.elapsedMs = Date.now() - started;
		const tailText = tail.join('').trim();
		result.error = `服务仍在启动中（PID ${String(result.pid ?? '-')}），${Math.round(timeout / 1000)}s 内未响应 ${spec.url}。可稍后重试。`
			+ (tailText ? `\n—— 子进程输出尾部 ——\n${tailText}` : '');
		this.logService.info(`[AgentStudio] configHtml:ensure ${result.error}`);
		return result;
	}

	// ── 停止（按端口查杀）─────────────────────────────────────────────────
	private async findListeningPidsOnPort(port: number): Promise<number[]> {
		try {
			if (process.platform === 'win32') {
				const { stdout } = await execAsync('netstat -ano -p TCP');
				return stdout.split('\n')
					.filter(l => l.includes('LISTENING') && new RegExp(`:${port}\\s`).test(l))
					.map(l => Number(l.trim().split(/\s+/).pop()))
					.filter(n => Number.isFinite(n) && n > 0);
			}
			const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
			return stdout.split('\n').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
		} catch {
			return [];
		}
	}

	async stop(url: string, port?: number): Promise<{ ok: boolean; killed: number[]; error?: string }> {
		const p = port ?? this.portOf({ url });
		const pids = await this.findListeningPidsOnPort(p);
		if (pids.length === 0) { return { ok: true, killed: [] }; }
		const killed: number[] = [];
		for (const pid of pids) {
			try {
				if (process.platform === 'win32') {
					await execAsync(`taskkill /pid ${pid} /T /F`);
				} else {
					process.kill(pid, 'SIGTERM');
				}
				killed.push(pid);
			} catch (err) {
				this.logService.info(`[AgentStudio] configHtml:stop kill ${pid} 失败: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		this._spawnedPorts.delete(p);
		return { ok: killed.length > 0, killed };
	}

	// ── 注册 ─────────────────────────────────────────────────────────────
	private registerChannels(): void {
		// validatedIpcMain 要求 channel 以 `vscode:` 开头（见 ipcMain.ts validateEvent）
		validatedIpcMain.handle('vscode:configHtmlEnsureServer', async (_e, spec: ConfigHtmlServerSpec) => {
			return this.ensure(spec ?? {} as ConfigHtmlServerSpec);
		});
		validatedIpcMain.handle('vscode:configHtmlStopServer', async (_e, arg: { url: string; port?: number }) => {
			return this.stop(arg?.url ?? '', arg?.port);
		});
	}

	override dispose(): void {
		// 与 comfyLaunchChannel 一致：注销 handler，避免热重载时重复注册
		validatedIpcMain.removeHandler('vscode:configHtmlEnsureServer');
		validatedIpcMain.removeHandler('vscode:configHtmlStopServer');
		super.dispose();
	}

	private registerShutdown(): void {
		// 退出时杀掉本会话拉起过的服务，避免残留后台进程占端口。
		//
		// ⚠ 不用 e.join（2026-09-05，用户实测「点击关闭无法关闭 app」）：join 会阻塞
		// shutdown 直到清理完成——Windows 上每个端口要串行跑 netstat -ano（1-3s）+
		// taskkill（execAsync 超时上限 8s），拉起过 1-2 个端口时点关闭可卡 10s+。
		// 改为 **fire-and-forget 独立 detached 进程**执行查杀：app 退出不等它、也不
		// 影响它——detached 子进程在主进程退出后仍能完成 taskkill/kill。
		// 权衡：清理结果不再进退出日志；ensure 侧的探活+身份校验仍能兜住残留误判。
		this.lifecycleMainService.onWillShutdown(() => {
			if (this._spawnedPorts.size === 0) { return; }
			const ports = [...this._spawnedPorts];
			this._spawnedPorts.clear();
			for (const p of ports) {
				this._fireAndForgetKillPort(p);
			}
		});
	}

	/** 独立 detached 子进程按端口查杀：不阻塞 shutdown，主进程退出后仍能完成。 */
	private _fireAndForgetKillPort(port: number): void {
		try {
			if (process.platform === 'win32') {
				const cmd = 'powershell -NoProfile -Command "'
					+ `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue `
					+ '| Select-Object -ExpandProperty OwningProcess -Unique '
					+ '| ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"';
				spawn('cmd', ['/d', '/s', '/c', cmd], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
			} else {
				spawn('sh', ['-c', `lsof -nP -iTCP:${port} -sTCP:LISTEN -t | xargs -r kill`],
					{ detached: true, windowsHide: true, stdio: 'ignore' }).unref();
			}
			this.logService.info(`[AgentStudio] configHtml:shutdown fire-and-forget kill on port ${port}`);
		} catch (err) {
			this.logService.info(`[AgentStudio] configHtml:shutdown kill ${port} 失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
