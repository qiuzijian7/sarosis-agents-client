/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 每次 Host run 的**拥有者记录**（`<runDir>/owner-<runId>.json`）。
 *
 * 为什么必须有它 ✗：`$DSH_HOME/host.json` 只留**最后一份**租约 ⇒ 应用重启后没人知道
 * "runDir 里那些老 run 是谁拉起的、那个人还在不在" ✗ ⇒ 于是"插件换过版本就不接管旧 Host、
 * 也不杀它"（supervisor 里的 `_pluginsStale` 取舍）会**累积**出同一会话的多个写者 ✗✗。
 * 真机症状（2026-10-13）：会话写句柄被另一个 Host 占着 ⇒ 斜杠命令目录预热直接失败 ✗
 * `SessionAlreadyOwnedError: session "…" is already owned by an active write handle`。
 *
 * 本文件是**纯逻辑** ✓（不碰文件、不杀进程）⇒ 判定可被探针直接钉住 ✓；读写与回收在
 * `electron-main/dshHostReaper.ts`。
 *
 * 判定规则（贴住"多实例复用"的既有约束 ✗：**别的 IDE 窗口可能正接在那个 Host 上**）：
 *   · 记录太新（`startedAt` 在 grace 之内）⇒ **保留** ✓（可能是并发实例刚写下的，别跟它抢 ✓）；
 *   · `appPid === selfAppPid` ⇒ **可回收** ✓（就是**本进程**上一轮留下的 Host：重启后我们已不再用它 ✓）；
 *   · `appPid` 已死 ⇒ **可回收** ✓（没有窗口在用它 ⇒ "别的窗口可能还在用"这条理由不成立 ✓）；
 *   · `appPid` 活着且不是自己 ⇒ **保留** ✓（真·多实例：另一个 VsSaros 正接在上面 ✓）。
 */

/** 拥有者记录的文件名前缀。 */
export const HOST_RUN_OWNERSHIP_PREFIX = 'owner-';
/** 拥有者记录的扩展名。 */
export const HOST_RUN_OWNERSHIP_EXT = '.json';

/** 一次 Host run 的拥有者（由拉起它的 VsSaros 主进程写下）。 */
export interface IHostRunOwnership {
	readonly format: 1;
	readonly runId: string;
	/** 拉起这个 Host 的 VsSaros **主进程** pid（不是 Host 自己的 pid ✗——那个在 `hostPid`）。 */
	readonly appPid: number;
	/** Host 自己的 pid（回收时按它结束整棵进程树）。 */
	readonly hostPid: number;
	readonly instanceId: string;
	readonly profile: string;
	readonly startedAt: number;
	/** 本次 run 落盘的覆盖层**文件名**（相对 runDir；回收时一并删除 ✓）。 */
	readonly files: readonly string[];
}

/** 拥有者记录的文件名。 */
export function hostRunOwnershipFileName(runId: string): string {
	return `${HOST_RUN_OWNERSHIP_PREFIX}${runId}${HOST_RUN_OWNERSHIP_EXT}`;
}

/** 从文件名反解 runId；不是拥有者记录返回 undefined。 */
export function runIdOfHostRunOwnershipFile(name: string): string | undefined {
	if (!name.startsWith(HOST_RUN_OWNERSHIP_PREFIX) || !name.endsWith(HOST_RUN_OWNERSHIP_EXT)) {
		return undefined;
	}
	const runId = name.slice(HOST_RUN_OWNERSHIP_PREFIX.length, name.length - HOST_RUN_OWNERSHIP_EXT.length);
	return runId ? runId : undefined;
}

/**
 * 解析拥有者记录；结构不完整一律视为无效（调用方按"没有记录"处理 ⇒ 保守地**不动**那个 run ✓）。
 * ⚠ 故意**不**把 `files` 缺失当无效：老记录/手工写的记录只要身份齐全就能用于回收 ✓（清不掉的文件由 sweep 兜 ✓）。
 */
export function parseHostRunOwnership(text: string): IHostRunOwnership | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	const o = raw as Record<string, unknown>;
	if (!o || typeof o !== 'object' || o.format !== 1) {
		return undefined;
	}
	if (typeof o.runId !== 'string' || !o.runId
		|| typeof o.appPid !== 'number' || !Number.isInteger(o.appPid) || o.appPid <= 0
		|| typeof o.hostPid !== 'number' || !Number.isInteger(o.hostPid) || o.hostPid <= 0
		|| typeof o.instanceId !== 'string' || !o.instanceId
		|| typeof o.profile !== 'string' || !o.profile
		|| typeof o.startedAt !== 'number') {
		return undefined;
	}
	const files = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string' && f !== '') : [];
	return {
		format: 1,
		runId: o.runId,
		appPid: o.appPid,
		hostPid: o.hostPid,
		instanceId: o.instanceId,
		profile: o.profile,
		startedAt: o.startedAt,
		files,
	};
}

/** 一条记录的判定结果。 */
export interface IHostRunVerdict {
	readonly record: IHostRunOwnership;
	readonly reason: string;
}

/** 判定输出：`reap` = 可回收（拥有者已死或就是自己）✓；`keep` = 别动 ✓。 */
export interface IHostRunPlan {
	readonly reap: readonly IHostRunVerdict[];
	readonly keep: readonly IHostRunVerdict[];
}

/**
 * 把拥有者记录分成"可回收"与"别动"两堆。
 *
 * @param records - runDir 里读到的全部拥有者记录。
 * @param options - `selfAppPid` 本进程 pid；`isAlive` 进程存活判定（注入以便探针钉住 ✓）；
 *   `now` 当前时间；`graceMs` 新记录保护期（并发实例刚写下的不抢 ✓）。
 * @returns 两堆记录 + 各自原因（原因会进日志 ⇒ 回收**必须**可解释 ✓）。
 */
export function planOrphanHosts(
	records: readonly IHostRunOwnership[],
	options: { readonly selfAppPid: number; readonly isAlive: (pid: number) => boolean; readonly now: number; readonly graceMs: number },
): IHostRunPlan {
	const reap: IHostRunVerdict[] = [];
	const keep: IHostRunVerdict[] = [];
	for (const record of records) {
		const age = options.now - record.startedAt;
		if (Number.isFinite(record.startedAt) && age >= 0 && age < options.graceMs) {
			keep.push({ record, reason: `刚写下 ${age}ms（保护期 ${options.graceMs}ms 内），可能与并发实例正在使用中` });
			continue;
		}
		if (record.appPid === options.selfAppPid) {
			reap.push({ record, reason: `本进程（pid ${record.appPid}）上一轮留下的 Host（已不再使用）` });
			continue;
		}
		if (!options.isAlive(record.appPid)) {
			reap.push({ record, reason: `拥有者 VsSaros（pid ${record.appPid}）已退出 ⇒ 没有窗口接在这个 Host 上` });
			continue;
		}
		keep.push({ record, reason: `拥有者 VsSaros（pid ${record.appPid}）仍在运行，可能正接在它上面（多实例）` });
	}
	return { reap, keep };
}

/**
 * 从覆盖层文件名（`<kind>-<runId>.yml`）取 runId；不是覆盖层返回 undefined。
 *
 * 用途：老 run 目录里积着**没有拥有者记录**的覆盖层（本机制上线前的遗留 ✗）⇒ 只能用"够老就删"兜 ✓
 * （覆盖层只在 Host **启动时**被读一次 ⇒ 删掉不会影响任何正在跑的 Host ✓；绝不删新的 ✓）。
 */
export function runIdOfHostOverlayFile(name: string): string | undefined {
	const match = /^[a-z][a-z0-9-]*-([0-9a-f]{12,})\.ya?ml$/i.exec(name);
	return match ? match[1] : undefined;
}
