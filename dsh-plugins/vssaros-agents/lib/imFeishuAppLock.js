// @vssaros/dsh-agents — 按**飞书应用**的入站长连接互斥（2026-11-04）
//
// ── 为什么要按应用、而不是按平台 ─────────────────────────────────────────────
// 飞书长连接是**集群模式、不支持广播**（官方 SDK README：同一应用部署多个客户端，只有随机一个
// 收到消息）⇒ 约束是「**每个 appId** 在整台机器上只能有一条长连接」，而不是「每个平台一条」。
// 一个客户端里不同 bot 用不同应用时，按平台锁会把第二个应用挡在门外；按应用锁才对。
//
// ── 兼容 ────────────────────────────────────────────────────────────────────
//   · 每个应用一把锁：`~/.vssaros-im-feishu-<appId 小写>.lock`；
//   · **默认应用**另外再拿老锁 `~/.vssaros-im-feishu.lock` —— 老版本客户端（以及 dsh-superagent 的探测）
//     只认这一把；锁里写上 `appId`（老锁没有这项时回落到持有者 dataRoot 的默认应用）。
//   · 判定"被别人占着"时两把都看：别人的应用锁，或别人的老锁且其应用相同。
//
// 仍是**协作式**锁：不阻止第二个 Host 起来，只阻止它对同一应用再连一条。
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { IM_LOCK_STALE_MS, imLockPath, isPidAlive, releaseImLock, startImLockHeartbeat, tryAcquireImLock } from './imInboundLock.js';

/** 应用锁的平台键：`feishu-<appId 小写>`（`imLockPath` 只收 `[a-z0-9_-]`）。 */
export function feishuAppLockKey(appId) {
	const id = String(appId ?? '').trim().toLowerCase();
	if (!/^cli_[a-z0-9]+$/.test(id)) {
		throw new Error(`非法飞书 App ID：${appId}`);
	}
	return `feishu-${id}`;
}

async function readJson(file) {
	try {
		const j = JSON.parse(await readFile(file, 'utf8'));
		return j && typeof j === 'object' ? j : null;
	} catch {
		return null;
	}
}

/** 某个 dataRoot 的默认飞书应用（老锁没写 appId 时用它判断"是不是同一个应用"）。 */
export async function defaultFeishuAppOf(dataRoot) {
	const j = await readJson(path.join(dataRoot, 'agent-im-accounts.json'));
	const id = j && j.accounts && j.accounts.feishu && j.accounts.feishu.appId;
	return typeof id === 'string' ? id.trim() : '';
}

/**
 * 别的进程是否正占着 `appId` 的长连接。返回 `{ pid, dataRoot, appId, lock }` 或 `null`。
 * 读不到持有者的应用 ⇒ **不算冲突**（宁可多连一次也不要凭猜测把用户挡住）。
 */
export async function feishuAppHolder(appId, {
	pid = process.pid, home = os.homedir(), now = Date.now(), staleMs = IM_LOCK_STALE_MS,
	isAlive = isPidAlive, defaultAppOf = defaultFeishuAppOf,
} = {}) {
	const want = String(appId ?? '').trim();
	if (!want) { return null; }
	const live = (lock) => {
		if (!lock) { return false; }
		const holderPid = Number(lock.pid);
		const fresh = Number.isFinite(Number(lock.heartbeatAt)) && (now - Number(lock.heartbeatAt)) < staleMs;
		return holderPid !== Number(pid) && fresh && isAlive(holderPid);
	};
	const own = await readJson(imLockPath(feishuAppLockKey(want), home));
	if (live(own)) {
		return { pid: Number(own.pid), dataRoot: String(own.dataRoot ?? ''), appId: want, lock: 'app' };
	}
	const legacy = await readJson(imLockPath('feishu', home));
	if (live(legacy)) {
		const root = String(legacy.dataRoot ?? '') || path.join(home, '.vssaros');
		const held = String(legacy.appId ?? '').trim() || await defaultAppOf(root).catch(() => '');
		if (held && held === want) {
			return { pid: Number(legacy.pid), dataRoot: root, appId: want, lock: 'legacy' };
		}
	}
	return null;
}

/**
 * 为某个应用拿锁（并起心跳）。返回 `{ ok: true, release() }` 或 `{ ok: false, holder }`。
 * `isDefault` ⇒ 另外拿老锁（见文件头「兼容」）；老锁被**别的应用**占着时不强抢、也不算失败。
 */
export async function acquireFeishuAppLock(appId, {
	isDefault = false, dataRoot = '', pid = process.pid, home, now = Date.now(), heartbeat = true, ...rest
} = {}) {
	const id = String(appId ?? '').trim();
	const holder = await feishuAppHolder(id, { pid, home, now, ...rest });
	if (holder) { return { ok: false, holder }; }
	const keys = [];
	const appKey = feishuAppLockKey(id);
	const got = await tryAcquireImLock(appKey, { dataRoot, pid, home, now, appId: id });
	if (!got.ok) { return { ok: false, holder: { ...got.holder, appId: id, lock: 'app' } }; }
	keys.push(appKey);
	if (isDefault) {
		const legacy = await tryAcquireImLock('feishu', { dataRoot, pid, home, now, appId: id });
		if (legacy.ok) { keys.push('feishu'); }
	}
	const stops = heartbeat ? keys.map((key) => startImLockHeartbeat(key, { pid, home })) : [];
	let released = false;
	return {
		ok: true,
		keys,
		async release() {
			if (released) { return; }
			released = true;
			for (const stop of stops) { try { stop(); } catch { /* 忽略 */ } }
			for (const key of keys) { await releaseImLock(key, { pid, home }).catch(() => undefined); }
		},
	};
}

/** 人话：谁占着（UI / 日志用）。 */
export function describeFeishuHolder(holder) {
	const h = holder || {};
	return `飞书应用 ${h.appId || '?'} 已被另一实例（pid ${h.pid ?? '?'}，dataRoot=${h.dataRoot || '?'}）的入站占用 —— `
		+ '同一应用的事件只会推给其中一条连接，所以这里不再连';
}
