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

/**
 * 拥有者记录的**心跳间隔**：宿主主进程活着就定期碰一下记录的 mtime（只碰 mtime、不改内容 ✓）。
 *
 * 谁在用：桥插件的看门狗（`dsh-plugins/vssaros-bridge/lib/index.js` 的 `OWNER_STALE_MS`）——
 *   · 只信 `appPid` 存活会被 **pid 复用**骗过 ✗；
 *   · 只信 mtime 就需要有人定期"碰"，就是这里 ✓。
 * ★ 两侧是一对常量：插件的陈旧阈值必须 ≥ 本值的 3 倍（留足余量），由
 *   `test/common/dshOwnerWatchdog.test.ts` 的配对守卫钉住 ✓。
 */
export const HOST_RUN_OWNERSHIP_HEARTBEAT_MS = 20_000;

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

/** 单条记录的判定（`keep` = 不许动）。 */
interface IRunOwnershipJudgement {
	readonly keep: boolean;
	readonly reason: string;
}

/** 单条记录的判定规则（文件头那四条；原因必须可解释 ⇒ 原样进日志 ✓）。 */
function judgeRunOwnership(
	record: IHostRunOwnership,
	options: { readonly selfAppPid: number; readonly isAlive: (pid: number) => boolean; readonly now: number; readonly graceMs: number },
): IRunOwnershipJudgement {
	const age = options.now - record.startedAt;
	if (Number.isFinite(record.startedAt) && age >= 0 && age < options.graceMs) {
		return { keep: true, reason: `刚写下 ${age}ms（保护期 ${options.graceMs}ms 内），可能与并发实例正在使用中` };
	}
	if (record.appPid === options.selfAppPid) {
		return { keep: false, reason: `本进程（pid ${record.appPid}）上一轮留下的 Host（已不再使用）` };
	}
	if (!options.isAlive(record.appPid)) {
		return { keep: false, reason: `拥有者 VsSaros（pid ${record.appPid}）已退出 ⇒ 没有窗口接在这个 Host 上` };
	}
	return { keep: true, reason: `拥有者 VsSaros（pid ${record.appPid}）仍在运行，可能正接在它上面（多实例）` };
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
	// ① 先逐条判"这条记录**自己**该不该回收"（规则见文件头）。
	const judged = records.map(record => ({ record, judgement: judgeRunOwnership(record, options) }));
	// ② ★ 2026-10-16：再按 **hostPid 分组**收敛 —— 同一个 Host 可以有**多份**拥有者记录 ✗：
	//   原拥有者优雅分离后，另一个窗口经 `host.json` 接管了它（`dshHostSupervisor._adoptLease` 也会写下
	//   自己那份 ✓）⇒ **只要组里有一条说"还在用"，这个 Host 整体不许动** ✓。
	//   不收敛会怎样（真机可达 ✗✗）：A 优雅退出后 B 接管了同一个 Host；A 的记录里 `appPid` 已死 ⇒
	//   按单条判就是"可回收"⇒ 插件版本变化时新起的 C 走回收分支、`taskkill /T` 掉**B 正在用**的 Host ✗。
	const groups = new Map<number, { record: IHostRunOwnership; judgement: IRunOwnershipJudgement }[]>();
	for (const item of judged) {
		const group = groups.get(item.record.hostPid);
		if (group) {
			group.push(item);
		} else {
			groups.set(item.record.hostPid, [item]);
		}
	}
	const reap: IHostRunVerdict[] = [];
	const keep: IHostRunVerdict[] = [];
	for (const group of groups.values()) {
		const blocker = group.find(item => item.judgement.keep);
		if (!blocker) {
			for (const item of group) {
				reap.push({ record: item.record, reason: item.judgement.reason });
			}
			continue;
		}
		for (const item of group) {
			keep.push({
				record: item.record,
				// 单条时原样透传原因（日志里的关键字与既有排查习惯都依赖它 ✓）；成组时点明是谁挡住的 ✓。
				reason: group.length === 1
					? item.judgement.reason
					: `同一 Host（pid ${item.record.hostPid}）有 ${group.length} 份拥有者记录，其中一份不该动 ⇒ 整组保留：${blocker.judgement.reason}`,
			});
		}
	}
	return { reap, keep };
}

/**
 * 从 `instanceId` 解析出**宿主主进程** pid。
 *
 * 格式：`vssaros-<appPid>-<rand8>`（见 `dshHarnessChannel.ts` 里生成 instanceId 的那行）⇒
 * 租约（`host.json`）里虽然没有独立的 appPid 字段，但**能从 instanceId 反解出来** ✓。
 *
 * 为什么需要它 ★ 2026-10-29（孤儿 Host 治理）：租约（host.json）只留**最后一份** ⇒
 * "keepAlive 留下的旧 Host"在**下一次**启动时可能既没有 owner 记录（被误删）、
 * 又不在租约里（被后一次覆盖）⇒ 认不出来 ⇒ 永远回收不掉。
 * 但只要还留着租约（或 owner 记录），就能用这个函数判它的宿主是否已死 ⇒ 死了才可回收 ✓。
 *
 * @returns 宿主主进程 pid；格式不认识时返回 undefined（**保守**：调用方据此判"别动" ✓）。
 */
export function appPidOfInstanceId(instanceId: string): number | undefined {
	const match = /^vssaros-(\d+)-/.exec(String(instanceId ?? ''));
	if (!match) {
		return undefined;
	}
	const pid = Number(match[1]);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * 租约里那个 Host 能不能当"可回收的孤儿"（★ 2026-10-29，孤儿 Host 治理）。
 *
 * 背景：回收器只认 runDir 里的**拥有者记录** ⇒ 记录一丢（keepAlive 的 Host 常常没有；
 * 旧版逻辑还会在"没杀掉"时误删），那个 Host 就再也没人能认出来 ⇒ 永远占着端口 ✗。
 * 租约（`host.json`）里还有 pid + instanceId ⇒ 至少能判"它的宿主还在不在" ✓。
 *
 * 三条判据（缺一不可）：
 *   ① **我们明确不复用它**（`notReusableReason` 为空 ⇒ 不动：可能只是"探活失败"，进程未必死 ✗）；
 *   ② **认得出宿主**（instanceId 解析不出 appPid ⇒ 不动：保守 ✓）；
 *   ③ **宿主已退出**（宿主还活着 ⇒ 多实例，另一个窗口正接在上面 ⇒ 绝不能动 ✗✗）。
 *
 * @returns 回收候选（空数组 = 不动）。
 */
export function orphanLeaseCandidates(
	lease: { readonly pid: number; readonly instanceId: string } | undefined,
	options: {
		/** 本实例为什么**不复用**这个 Host；空 = 没有明确理由 ⇒ 不当候选 ✓。 */
		readonly notReusableReason: string | undefined;
		/** 本进程 pid（"就是自己上一轮留下的"也算可回收 ✓）。 */
		readonly selfAppPid: number;
		/** 进程存活判定（注入以便钉住 ✓）。 */
		readonly isAlive: (pid: number) => boolean;
	},
): { pid: number; reason: string }[] {
	if (!lease || !options.notReusableReason || !Number.isInteger(lease.pid) || lease.pid <= 0) {
		return [];
	}
	const appPid = appPidOfInstanceId(lease.instanceId ?? '');
	if (!appPid) {
		return [];   // 认不出宿主 ⇒ 保守：不动 ✓
	}
	if (appPid !== options.selfAppPid && options.isAlive(appPid)) {
		return [];   // 宿主还活着 ⇒ 多实例 ⇒ 绝不能动 ✓
	}
	return [{
		pid: lease.pid,
		reason: `租约里的 Host（pid ${lease.pid}）的宿主 VsSaros（pid ${appPid}）已退出，且本实例不复用它（${options.notReusableReason}）`,
	}];
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
