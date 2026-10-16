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
