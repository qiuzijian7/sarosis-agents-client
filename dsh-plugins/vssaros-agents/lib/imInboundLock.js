/**
 * 飞书（及同类）**入站长连接**的跨进程互斥锁。
 *
 * ## 为什么需要它（2026-10-29 真机定案）
 *
 * 飞书对**同一个应用**只让一条长连接真正收到事件：其余连接会被踢或只拿着心跳、
 * 一个事件帧都收不到。而我们的环境里同时能跑出好几条：
 *
 *   · 每次重启 VsSaros 都会 spawn 一个 dsh Host，**旧 Host 不一定死**
 *     （harness 的 `reapOrphanHosts` 只认 `owner-*.json`，而那份记录会被覆盖/清掉）
 *   · **dev 版与正式版是两个 dataRoot**（`~/.vssaros-dev` / `~/.vssaros`），
 *     两边各存一份凭据文件，谁也看不见谁 —— 只要两边都点过「启动入站」，就都在抢
 *
 * 症状极难查：日志里只有「长连接已就绪」+ 心跳，**零事件**，看起来像"飞书不推"。
 * 实际是事件被投给了另一条连接（往往是某次旧启动留下的、用户以为已经退出的那个）。
 *
 * ## 机制
 *
 * 锁文件**故意不放在 dataRoot 里**（`~/.vssaros-im-<platform>.lock`）—— dev 与正式版
 * 是不同 dataRoot，放进去就互相看不见，等于没锁。
 *
 * 判活：`pid` 还在（`process.kill(pid, 0)`）+ 心跳在 `staleMs` 内。两条都满足才算
 * "别人正占着"；否则视为陈旧锁，可以直接抢（进程被强杀时不会有人删锁，这是常态）。
 *
 * 语义上这是**协作式**锁：它不阻止第二个 Host 起来，只阻止它**去连飞书**
 * （连不上锁 ⇒ 明确记一条日志说明"谁占着"，而不是默默少一个功能）。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 心跳间隔（写锁与续期都用它）。 */
export const IM_LOCK_HEARTBEAT_MS = 30_000;
/** 超过这个时间没续期 ⇒ 视为陈旧锁（比心跳宽 3 倍，容忍 GC / 主线程忙）。 */
export const IM_LOCK_STALE_MS = 90_000;

/** 锁文件路径：**放在 home 下**，跨 dataRoot 互斥（见文件头注释）。 */
export function imLockPath(platform, home = os.homedir()) {
	const p = String(platform ?? '').trim().toLowerCase();
	if (!/^[a-z0-9_-]+$/.test(p)) {
		throw new Error(`非法平台名：${platform}`);
	}
	return path.join(home, `.vssaros-im-${p}.lock`);
}

/** pid 是否还活着（EPERM 说明进程在、只是没权限，同样算活）。 */
export function isPidAlive(pid) {
	const n = Number(pid);
	if (!Number.isFinite(n) || n <= 0) {
		return false;
	}
	try {
		process.kill(n, 0);
		return true;
	} catch (e) {
		return !!e && e.code === 'EPERM';
	}
}

async function readLock(file) {
	try {
		const raw = await fs.readFile(file, 'utf8');
		const j = JSON.parse(raw);
		return j && typeof j === 'object' ? j : null;
	} catch {
		return null;
	}
}

/**
 * 试着拿锁。
 *
 * @returns `{ ok: true, file }` 或 `{ ok: false, holder: { pid, dataRoot, heartbeatAt } }`
 */
export async function tryAcquireImLock(platform, { dataRoot = '', pid = process.pid, home, staleMs = IM_LOCK_STALE_MS, now = Date.now() } = {}) {
	const file = imLockPath(platform, home);
	const cur = await readLock(file);
	if (cur) {
		const holderPid = Number(cur.pid);
		const sameProcess = holderPid === Number(pid);
		const fresh = Number.isFinite(Number(cur.heartbeatAt)) && (now - Number(cur.heartbeatAt)) < staleMs;
		if (!sameProcess && isPidAlive(holderPid) && fresh) {
			return {
				ok: false,
				holder: {
					pid: holderPid,
					dataRoot: String(cur.dataRoot ?? ''),
					heartbeatAt: Number(cur.heartbeatAt ?? 0),
				},
			};
		}
	}
	const body = {
		format: 1,
		platform: String(platform),
		pid: Number(pid),
		dataRoot: String(dataRoot ?? ''),
		acquiredAt: now,
		heartbeatAt: now,
	};
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(body), 'utf8');
	return { ok: true, file };
}

/** 续期（只有自己持有才写，避免覆盖别人的锁）。 */
export async function touchImLock(platform, { pid = process.pid, home, now = Date.now() } = {}) {
	const file = imLockPath(platform, home);
	const cur = await readLock(file);
	if (!cur || Number(cur.pid) !== Number(pid)) {
		return false;
	}
	await fs.writeFile(file, JSON.stringify({ ...cur, heartbeatAt: now }), 'utf8').catch(() => undefined);
	return true;
}

/** 释放（只有自己持有才删）。 */
export async function releaseImLock(platform, { pid = process.pid, home } = {}) {
	const file = imLockPath(platform, home);
	const cur = await readLock(file);
	if (cur && Number(cur.pid) === Number(pid)) {
		await fs.unlink(file).catch(() => undefined);
		return true;
	}
	return false;
}

/**
 * 起一个心跳定时器（返回停止函数）。
 *
 * 为什么要续期：Host 正常活着时锁必须一直"新鲜"，否则被别的实例当成陈旧锁抢走 ——
 * 那正好制造出我们要避免的"两条连接"。
 */
export function startImLockHeartbeat(platform, { pid = process.pid, home, intervalMs = IM_LOCK_HEARTBEAT_MS } = {}) {
	const timer = setInterval(() => { void touchImLock(platform, { pid, home }); }, intervalMs);
	if (typeof timer.unref === 'function') {
		timer.unref();
	}
	return () => clearInterval(timer);
}
