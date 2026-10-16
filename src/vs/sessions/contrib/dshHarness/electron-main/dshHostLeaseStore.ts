/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `$DSH_HOME/host.json` 的读写、探活与启动锁（方案第 7.5 节）。
 * 只依赖 Node 内置模块，可在纯 Node 下做集成测试。
 */

import { promises as fsp, readFileSync, rmSync } from 'fs';
import { join } from '../../../../base/common/path.js';
import { IDshHostLease, parseHostLease } from '../common/dshHostLease.js';

const HOST_JSON = 'host.json';
const LOCK_FILE = 'host.json.lock';
/** 启动锁超过这么久视为死锁（正常启动最坏一分钟内会释放）。 */
const LOCK_STALE_MS = 120_000;

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM = 进程在但无权发信号（也算活着）；ESRCH = 不存在。
		return (e as NodeJS.ErrnoException)?.code === 'EPERM';
	}
}

export class DshHostLeaseStore {
	constructor(
		private readonly _home: string,
		private readonly _log: (line: string) => void,
	) { }

	private get _leasePath(): string {
		return join(this._home, HOST_JSON);
	}

	private get _lockPath(): string {
		return join(this._home, LOCK_FILE);
	}

	/** 读取租约；不存在或内容无效返回 undefined。 */
	read(): IDshHostLease | undefined {
		let text: string;
		try {
			text = readFileSync(this._leasePath, 'utf8');
		} catch {
			return undefined;
		}
		const lease = parseHostLease(text);
		if (!lease) {
			this._log('host.json 无效，按无租约处理');
		}
		return lease;
	}

	/**
	 * 探活：pid 活着且带 token 的 HTTP 请求得到响应。返回 undefined 表示可复用，否则是原因。
	 * 默认 3 秒超时——本机回环，超过即视为不可用。
	 */
	async probe(lease: IDshHostLease, timeoutMs = 3_000): Promise<string | undefined> {
		if (!pidAlive(lease.pid)) {
			return `pid ${lease.pid} 已不存在`;
		}
		try {
			const res = await fetch(lease.authUrl, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
			// 任何 HTTP 应答都说明 Host 在监听（401/404 也算活着——版本间路由可能不同）。
			return res.status > 0 ? undefined : 'empty status';
		} catch (e) {
			return `HTTP 探测失败：${String((e as Error)?.message ?? e).slice(0, 120)}`;
		}
	}

	/** 写入租约（临时文件 + 改名，避免半截文件；仅当前用户可读写）。 */
	async write(lease: IDshHostLease): Promise<void> {
		await fsp.mkdir(this._home, { recursive: true });
		const tmp = `${this._leasePath}.${process.pid}.tmp`;
		await fsp.writeFile(tmp, JSON.stringify(lease, undefined, 2), { mode: 0o600 });
		await fsp.rename(tmp, this._leasePath);
	}

	/** 仅当租约属于给定 pid 时删除（拥有者退出时调用）。 */
	async removeIfOurs(pid: number): Promise<void> {
		const lease = this.read();
		if (lease && lease.pid !== pid) {
			return;
		}
		await fsp.rm(this._leasePath, { force: true }).catch(() => undefined);
	}

	/** 探测失败后的清理：租约指向的死 pid 才删。 */
	async removeIfStale(): Promise<void> {
		const lease = this.read();
		if (lease && !pidAlive(lease.pid)) {
			await fsp.rm(this._leasePath, { force: true }).catch(() => undefined);
		}
	}

	/** removeIfOurs 的同步版本（应用退出兜底用）。 */
	removeIfOursSync(pid: number): void {
		try {
			const lease = this.read();
			if (!lease || lease.pid === pid) {
				rmSync(this._leasePath, { force: true });
			}
		} catch { /* best effort */ }
	}

	/**
	 * 启动锁：同一 DSH_HOME 上两个实例同时启动时，后到者等待先者写出租约。
	 * 返回 undefined 表示拿到锁；返回租约表示等待期间先者已经就绪（调用方直接复用）。
	 * 死锁（持锁 pid 已死或超时）会被破门。
	 */
	async acquireStartLock(waitMs: number): Promise<IDshHostLease | undefined> {
		const deadline = Date.now() + waitMs;
		for (; ;) {
			try {
				await fsp.mkdir(this._home, { recursive: true });
				const handle = await fsp.open(this._lockPath, 'wx');
				await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
				await handle.close();
				this._lockHeld = true;
				return undefined;
			} catch (e) {
				if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') {
					throw e;
				}
			}
			// 锁已存在：读持锁者。
			let holder: { pid?: number; at?: number } = {};
			try {
				holder = JSON.parse(readFileSync(this._lockPath, 'utf8'));
			} catch { /* 锁文件刚被删掉或写了一半 */ }
			const stale = !holder.pid || !pidAlive(holder.pid) || (typeof holder.at === 'number' && Date.now() - holder.at > LOCK_STALE_MS);
			if (stale) {
				this._log(`host.json.lock 持锁者（pid ${holder.pid ?? '?'}）已不在或超时，破门`);
				await fsp.rm(this._lockPath, { force: true }).catch(() => undefined);
				continue;
			}
			if (Date.now() > deadline) {
				throw new Error(`另一个实例（pid ${holder.pid}）正在启动 Host，等待超时`);
			}
			// 等一等，看先者是否已写好租约。
			await new Promise(r => setTimeout(r, 500));
			const lease = this.read();
			if (lease && pidAlive(lease.pid)) {
				return lease;
			}
		}
	}

	private _lockHeld = false;

	async releaseStartLock(): Promise<void> {
		if (!this._lockHeld) {
			return;
		}
		this._lockHeld = false;
		await fsp.rm(this._lockPath, { force: true }).catch(() => undefined);
	}

	/** 应用退出时的同步兜底（异步 release 来不及跑）。 */
	releaseStartLockSync(): void {
		if (!this._lockHeld) {
			return;
		}
		this._lockHeld = false;
		try {
			rmSync(this._lockPath, { force: true });
		} catch { /* best effort */ }
	}
}
