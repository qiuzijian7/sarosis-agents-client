/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Host 监听端口的**读写与探测**（`$DSH_HOME/host-port.json`）。
 *
 * 纯逻辑（解析/序列化/取端口）在 `common/dshHostPortPreference.ts`；本文件只做 I/O。
 * 动机与真机证据见那边的头注释：**端口漂移会让 system 提示逐字节变化 ⇒ prompt 前缀缓存全失效**。
 *
 * ## 两条纪律
 *
 * ① **失败一律回落 0**（`--port 0` = OS 分配）：端口稳定是**优化**，不是启动前置条件。
 *    读不到文件、探测报错、端口被占 —— 全部走 0，绝不因此让 Host 起不来。
 * ② **只在真正 ready 之后写**：偏好值必须来自 `connection.origin`（模型看到的那一份），
 *    而不是我们请求的端口 —— 否则"请求 X 但实际监听 Y"时会把错的端口记下来，
 *    下次探测到 Y 空闲却拿到 X，反而更不稳定。
 */

import { promises as fsp } from 'fs';
import { createServer } from 'net';
import { spawnSync } from 'child_process';
import { join } from '../../../../base/common/path.js';
import { HOST_PORT_PREFERENCE_FILE, parseHostPortPreference, portOfOrigin, serializeHostPortPreference } from '../common/dshHostPortPreference.js';

/** 偏好文件路径（与 dsh 自己的 `host.json` 同目录）。 */
function preferencePath(dshHome: string): string {
	return join(dshHome, HOST_PORT_PREFERENCE_FILE);
}

/** 读上次用过的端口；任何异常都当"没有"（不是错误）。 */
export async function readPreferredHostPort(dshHome: string): Promise<number | undefined> {
	try {
		return parseHostPortPreference(await fsp.readFile(preferencePath(dshHome), 'utf8'));
	} catch {
		return undefined;
	}
}

/** 记下这次真正监听到的端口。写失败不影响任何行为（下次回落 0 而已）。 */
export async function writePreferredHostPort(dshHome: string, port: number): Promise<void> {
	try {
		await fsp.writeFile(preferencePath(dshHome), serializeHostPortPreference(port, Date.now()), { mode: 0o600 });
	} catch {
		/* 偏好写不进去只是退化成"端口每次变"，不能影响启动 */
	}
}

/**
 * 从 ready 后的 `origin` 记下本次端口。
 *
 * 为什么收在这里（而不是让调用方自己 `portOfOrigin` + `write`）：**"记哪个端口"必须只有一处口径**
 * —— supervisor 只需要把 `connection.origin` 递进来，解析与落盘都不外泄。
 */
export async function rememberHostPort(dshHome: string, origin: string | undefined): Promise<void> {
	const port = portOfOrigin(origin);
	if (port === undefined) { return; }
	await writePreferredHostPort(dshHome, port);
}

/**
 * 回环端口是否可绑定。
 *
 * ⚠ 探测与真正 spawn 之间仍有窗口期（可能被别的进程抢）⇒ 调用方必须保留
 * "启动失败/不可用"的兜底路径，本函数只做**尽力而为**的判断。
 */
export async function isLoopbackPortFree(port: number): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		const server = createServer();
		let settled = false;
		const finish = (free: boolean): void => {
			if (settled) { return; }
			settled = true;
			try { server.close(); } catch { /* 未监听或已关 */ }
			resolve(free);
		};
		server.once('error', () => finish(false));
		server.once('listening', () => finish(true));
		try {
			server.listen(port, '127.0.0.1');
		} catch {
			finish(false);
		}
	});
}

/**
 * 决定本次 Host 的监听端口：上次用过的端口若仍空闲就复用它，否则回落 0。
 *
 * **为什么要复用**：dsh 把 `http://127.0.0.1:<port>` 写进每一条 system 提示 ⇒ 端口一变，
 * 前缀缓存全断（实测同一会话 6 次请求的 system 提示里 299/302 行逐字相同，唯一差异就是端口，
 * 累计命中率 6.4%；端口未变的那次调用能到 98.6%）。
 *
 * 复用**不保证**端口恒定（多实例并发、端口被占时仍会变），但消除了"每次重启都变"这一
 * 必然漂移 —— 而长会话的每一次 resume 都伴随 Host 重启，正是缓存反复失效的来源。
 */
export async function resolveHostPort(dshHome: string): Promise<number> {
	const preferred = await readPreferredHostPort(dshHome);
	if (preferred === undefined) { return 0; }
	return await isLoopbackPortFree(preferred) ? preferred : 0;
}

/** `netstat -ano` 里监听该回环端口的 pid（拿不到就 undefined）。 */
export function findLoopbackPortOwner(port: number): number | undefined {
	if (!Number.isInteger(port) || port <= 0) { return undefined; }
	let out = '';
	try {
		const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
		out = String(r.stdout || '');
	} catch {
		return undefined;
	}
	for (const line of out.split(/\r?\n/)) {
		//   TCP    127.0.0.1:4109    0.0.0.0:0    LISTENING    12345
		if (!/LISTENING/i.test(line)) { continue; }
		const cols = line.trim().split(/\s+/);
		const local = cols[1] ?? '';
		if (!local.endsWith(`:${port}`)) { continue; }
		if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\])/.test(local)) { continue; }
		const pid = Number(cols[cols.length - 1]);
		if (Number.isInteger(pid) && pid > 0) { return pid; }
	}
	return undefined;
}

/** 进程命令行（wmic；读不到就 undefined）。 */
export function processCommandLine(pid: number): string | undefined {
	try {
		const r = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/format:list'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
		const m = /CommandLine=(.+)/i.exec(String(r.stdout || ''));
		return m ? m[1].trim() : undefined;
	} catch {
		return undefined;
	}
}

/** 结束一棵进程树（残留 Host 与其子进程）。 */
function killTree(pid: number): void {
	try {
		spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
	} catch {
		/* 杀不掉就算了 —— 端口回收只是优化 */
	}
}

/**
 * 偏好端口被占用时的**回收尝试**（2026-11-02，P0）。
 *
 * ## 为什么需要
 * 端口漂移有两个代价，都是实测过的：
 *   ① dsh 把 `http://127.0.0.1:<port>` 写进每条 system 提示 ⇒ 端口变 ⇒ **前缀缓存整段失效**
 *      （真机：同一会话 6 次请求，302 行里 299 行逐字相同，唯一差异就是端口 ⇒ 命中率 6.4% vs 98.6%）；
 *   ② 前端资源按 origin 缓存 ⇒ 端口变 ⇒ **每次冷启动重新下载/解析 chunk**（对比 `dsh-desktop`
 *      固定 43129 优先："Prefer a stable loopback origin so Chromium can reuse the Harness frontend cache"）。
 * 而 `resolveHostPort` 只在端口**空闲**时才复用，一旦上次的 Host 没退干净（僵尸/keepAlive 残留）
 * 就回落 `--port 0` ⇒ 实测四次启动拿到 4109 / 12637 / 53383 / 54980，等于稳定性没生效。
 *
 * ## 纪律（安全边界）
 * **只回收"我们自己的" Host**：命令行里必须含本次运行的 dsh `bin.js` 绝对路径。
 * 别的程序占着端口 —— 一律不动，回落 0（**绝不**为了端口稳定去杀无关进程）。
 *
 * @returns `free` 本来空闲 / `reclaimed` 回收成功 / `foreign` 被别人占（不动）/ `unknown` 探测不出来
 */
export async function reclaimLoopbackPort(
	port: number,
	ownDshBinPath: string,
): Promise<'free' | 'reclaimed' | 'foreign' | 'unknown'> {
	if (await isLoopbackPortFree(port)) {
		return 'free';
	}
	if (!ownDshBinPath) {
		return 'unknown';
	}
	const owner = findLoopbackPortOwner(port);
	if (owner === undefined) {
		return 'unknown';
	}
	const cmd = processCommandLine(owner);
	if (!cmd) {
		return 'unknown';
	}
	const norm = (s: string): string => s.replace(/\//g, '\\').toLowerCase();
	if (!norm(cmd).includes(norm(ownDshBinPath))) {
		return 'foreign';   // ⚠ 别人的进程：动都不要动
	}
	killTree(owner);
	const deadline = Date.now() + 2500;
	while (Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 150));
		if (await isLoopbackPortFree(port)) {
			return 'reclaimed';
		}
	}
	return 'unknown';
}
