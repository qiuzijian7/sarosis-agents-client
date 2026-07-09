/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbKernelManager.ts — SiYuan Kernel Sidecar 进程管理器（Electron 主进程）。
 *
 *  负责：
 *   - 从配置路径定位并 spawn SiYuan kernel 二进制
 *   - 端口协商与健康检查轮询
 *   - 进程生命周期管理（启动/重启/关闭）
 *   - 通过 IPC 向渲染进程暴露 kernel 连接信息
 *
 *  使用方式（主进程启动时或 KB View 首次打开时）：
 *   const mgr = new KbKernelManager({ binaryPath: '.../siyuan-kernel.exe', ... });
 *   const { url, authCode } = await mgr.start();
 *   // ... 使用后 ...
 *   await mgr.stop();
 *
 *  依赖：需要在主进程（Node.js child_process）环境运行。在渲染进程中不可用。
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface IKernelSpawnOptions {
	/** kernel 二进制路径（绝对或相对） */
	binaryPath: string;
	/** 工作空间目录（SiYuan 数据目录） */
	workspaceDir: string;
	/** 监听端口（自动分配时传入 0，使用 portHint 获取） */
	portHint: number;
	/** API 鉴权码（空则自动生成） */
	authCode?: string;
	/** 启动超时（毫秒） */
	startupTimeoutMs: number;
	/** 健康检查间隔（毫秒） */
	healthCheckIntervalMs: number;
	/** 可选的额外 kernel 参数 */
	extraArgs?: string[];
}

export const DEFAULT_KERNEL_OPTIONS: Partial<IKernelSpawnOptions> = {
	portHint: 6806,
	startupTimeoutMs: 15000,
	healthCheckIntervalMs: 500,
};

export interface IKernelConnection {
	url: string;
	authCode: string;
	pid: number;
}

export enum KernelStatus {
	Stopped = 'stopped',
	Starting = 'starting',
	Running = 'running',
	Error = 'error',
}

// ---------------------------------------------------------------------------
// KbKernelManager
// ---------------------------------------------------------------------------

export class KbKernelManager extends Disposable {

	private readonly _options: IKernelSpawnOptions;
	private _process: ChildProcess | null = null;
	private _status: KernelStatus = KernelStatus.Stopped;
	private _connection: IKernelConnection | null = null;

	private readonly _onStatusChange = this._register(new Emitter<KernelStatus>());
	readonly onStatusChange: Event<KernelStatus> = this._onStatusChange.event;

	private readonly _onError = this._register(new Emitter<Error>());
	readonly onError: Event<Error> = this._onError.event;

	constructor(options: IKernelSpawnOptions) {
		super();
		this._options = { ...DEFAULT_KERNEL_OPTIONS, ...options };

		// 确保工作空间目录存在
		if (!fs.existsSync(this._options.workspaceDir)) {
			fs.mkdirSync(this._options.workspaceDir, { recursive: true });
		}
	}

	get status(): KernelStatus { return this._status; }
	get connection(): IKernelConnection | null { return this._connection; }

	// -----------------------------------------------------------------------
	// 启动 kernel
	// -----------------------------------------------------------------------

	async start(): Promise<IKernelConnection> {
		if (this._status === KernelStatus.Running && this._connection) {
			return this._connection;
		}

		this._setStatus(KernelStatus.Starting);

		const binaryPath = this._resolveBinary();
		if (!fs.existsSync(binaryPath)) {
			const err = new Error(`Kernel binary not found: ${binaryPath}`);
			this._setStatus(KernelStatus.Error);
			this._onError.fire(err);
			throw err;
		}

		const port = this._options.portHint;
		const authCode = this._options.authCode ?? this._generateAuthCode();

		const args = [
			'--port=' + port,
			'--workspace=' + this._options.workspaceDir,
			'--accessAuthCode=' + authCode,
			'--readonly=false',
			'--ssl=false',
		];
		if (this._options.extraArgs) {
			args.push(...this._options.extraArgs);
		}

		const env = { ...process.env, SIYUAN_LANG: process.env.SIYUAN_LANG ?? 'zh_CN' };

		const proc = spawn(binaryPath, args, {
			cwd: path.dirname(binaryPath),
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});

		this._process = proc;

		// 收集 stderr 用于诊断
		let stderrBuf = '';
		proc.stderr?.on('data', (chunk: Buffer) => {
			stderrBuf += chunk.toString();
		});

		proc.on('error', (err) => {
			this._setStatus(KernelStatus.Error);
			this._onError.fire(err);
		});

		proc.on('exit', (code) => {
			if (code !== 0 && this._status === KernelStatus.Starting) {
				const err = new Error(`Kernel exited with code ${code}: ${stderrBuf.slice(-500)}`);
				this._setStatus(KernelStatus.Error);
				this._onError.fire(err);
			} else {
				this._setStatus(KernelStatus.Stopped);
			}
			this._process = null;
			this._connection = null;
		});

		// 轮询等待 kernel 就绪
		const url = `http://127.0.0.1:${port}`;
		const ready = await this._waitForReady(url, authCode);
		if (!ready) {
			this.kill();
			throw new Error(`Kernel startup timeout after ${this._options.startupTimeoutMs}ms`);
		}

		this._connection = { url, authCode, pid: proc.pid! };
		this._setStatus(KernelStatus.Running);
		return this._connection;
	}

	// -----------------------------------------------------------------------
	// 停止 kernel
	// -----------------------------------------------------------------------

	async stop(): Promise<void> {
		if (!this._process) { return; }
		this.kill();
		this._setStatus(KernelStatus.Stopped);
	}

	kill(): void {
		const proc = this._process;
		if (!proc) { return; }
		try {
			if (os.platform() === 'win32') {
				spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { windowsHide: true });
			} else {
				proc.kill('SIGTERM');
			}
		} catch {
			// best-effort
		}
		this._process = null;
		this._connection = null;
	}

	// -----------------------------------------------------------------------
	// 内部
	// -----------------------------------------------------------------------

	private _resolveBinary(): string {
		const bp = this._options.binaryPath;
		if (path.isAbsolute(bp)) { return bp; }
		// 按平台查找二进制名
		const ext = os.platform() === 'win32' ? '.exe' : '';
		const candidates = [
			bp + ext,
			bp + '/siyuan-kernel' + ext,
			bp + '/kernel' + ext,
			path.join(bp, 'siyuan' + ext),
		];
		for (const c of candidates) {
			if (fs.existsSync(c)) { return c; }
		}
		return bp + ext;
	}

	private _generateAuthCode(): string {
		const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
		let code = '';
		for (let i = 0; i < 16; i++) {
			code += chars[Math.floor(Math.random() * chars.length)];
		}
		return code;
	}

	private async _waitForReady(url: string, authCode: string): Promise<boolean> {
		const deadline = Date.now() + this._options.startupTimeoutMs;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`${url}/api/system/getConf`, {
					method: 'GET',
					headers: { 'Authorization': `Token ${authCode}` },
					signal: AbortSignal.timeout(2000),
				});
				if (res.ok) { return true; }
			} catch {
				// kernel 尚未就绪
			}
			await this._sleep(this._options.healthCheckIntervalMs);
		}
		try {
			const res = await fetch(`${url}/api/system/getConf`, {
				method: 'GET',
				headers: { 'Authorization': `Token ${authCode}` },
				signal: AbortSignal.timeout(2000),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	private _sleep(ms: number): Promise<void> {
		return new Promise(r => setTimeout(r, ms));
	}

	private _setStatus(status: KernelStatus): void {
		this._status = status;
		this._onStatusChange.fire(status);
	}
}
