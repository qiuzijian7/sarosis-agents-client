/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **孤儿 Host 回收**（2026-10-13）：起新 Host 之前，把"没人再用的"旧 Host 结束掉并清掉它的 run 文件。
 *
 * 为什么要有这一步 ✗：keepAlive 的 Host **故意**活过 IDE 退出（它有自己的空闲 TTL），而"插件换过版本
 * 就不接管旧 Host"也是**有理由的**（旧进程内存里是旧插件代码 ⇒ 接管会白屏 ✗）。两条都对吧？合在一起
 * 就留下**没人管的那一段**✗✗：旧 Host 还活着、还攥着会话写句柄 ✗，新的 Host 又起来了 ✗ ⇒ 同一会话
 * 出现两个写者 ⇒ `SessionAlreadyOwnedError: already owned by an active write handle`（用户端现象是
 * **斜杠命令目录预热直接失败** ✗）。
 *
 * 回收判据只信**拥有者记录**（`common/dshHostRunOwnership.ts` 的 `planOrphanHosts` ✓）：
 * 拥有者 vs 主机进程**已退出**或**就是自己** ⇒ 回收 ✓；拥有者还活着 ⇒ 一律不动 ✓（真·多实例 ✓）。
 *
 * 只依赖 Node 内置模块与 `vs/base`（不 import electron）⇒ 集成探针可直接 import 本文件跑真回收 ✓。
 */

import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import { join } from '../../../../base/common/path.js';
// ⚠ 类型导入必须带 `type` ✓：本文件要能被**探针直接 import**（Node 22 类型剥离 ⇒ 裸的 `import { X }`
// 若 X 只是个 interface，运行时会去要一个不存在的导出 ⇒ SyntaxError ✗）。
import { type IHostRunOwnership, type IHostRunVerdict, hostRunOwnershipFileName, parseHostRunOwnership, planOrphanHosts, runIdOfHostOverlayFile, runIdOfHostRunOwnershipFile } from '../common/dshHostRunOwnership.js';
import { pidAlive } from './dshHostLeaseStore.js';

/** 覆盖层文件被回收的**兜底**年龄：没有拥有者记录（本机制上线前的遗留）且这么老才删。 */
const LEGACY_OVERLAY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 新记录保护期：并发实例刚写下的不抢（与 `acquireStartLock` 的等待窗口同量级 ✓）。 */
const OWNERSHIP_GRACE_MS = 15_000;

export interface IHostReapOptions {
	/** 运行期临时文件目录（覆盖层与拥有者记录所在）。 */
	readonly runDir: string;
	/** 当前 VsSaros 主进程 pid（"就是自己"的判据）。 */
	readonly selfAppPid: number;
	readonly log: (line: string) => void;
	readonly now?: number;
	readonly graceMs?: number;
	/** 进程存活判定（缺省 `pidAlive`；注入以便探针钉住 ✓）。 */
	readonly isAlive?: (pid: number) => boolean;
	/** 结束整棵进程树（缺省 Windows `taskkill /T /F`、其余 SIGKILL ✓）。 */
	readonly killTree?: (pid: number) => Promise<void>;
	/** 无拥有者记录的覆盖层多久算遗留（缺省 7 天）。 */
	readonly legacyMaxAgeMs?: number;
	/**
	 * ★ 2026-10-29：**没有拥有者记录**、但我们已判定"它的宿主已退出、可以回收"的 Host。
	 *
	 * 为什么需要它：租约（`host.json`）只留最后一份 ⇒ "keepAlive 留下的旧 Host"在下一次启动时
	 * 可能既没有 owner 记录、也不在租约里 ⇒ 认不出来 ⇒ 永远回收不掉（真机：同一台机器上三个 Host 并存，
	 * 端口被迫漂移 ⇒ system 提示里的端口每轮都变 ⇒ provider 的 prompt 前缀缓存整段失效 ✗✗）。
	 *
	 * ⚠ 调用方**必须**先确认"宿主已死"（`appPidOfInstanceId` + 存活判定）—— 宿主还活着 ⇒ 多实例 ⇒ 绝不能动 ✓。
	 */
	readonly extraCandidates?: readonly { readonly pid: number; readonly reason: string }[];
	/**
	 * 等进程真的退出（缺省：轮询 `isAlive`，100ms 一次，最多 3s ✓）。
	 *
	 * ★ 2026-10-29：为什么必须有它 —— 原来 `taskkill` 一返回就**无条件**删掉 owner 记录与覆盖层，
	 * 哪怕进程**还活着**（taskkill 失败、或它正在优雅退出）⇒ 那份记录一丢，这个 Host 就**再也没人能认出来**
	 * ⇒ 变成"占着端口、重复干活、永远回收不掉"的僵尸 ✗✗（真机：dev 上留了一个孤儿 Host，
	 * 下次启动被迫 `--port 0` 换端口 ⇒ 前缀缓存全断）。
	 */
	readonly waitExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
}

export interface IHostReapReport {
	readonly reaped: readonly IHostRunVerdict[];
	readonly kept: readonly IHostRunVerdict[];
	/** 被清掉的文件名（覆盖层 + 拥有者记录）。 */
	readonly removed: readonly string[];
	/** 读不了/解析不了的记录文件名（**不动**它们，只报 ✓）。 */
	readonly unreadable: readonly string[];
}

/** 读 runDir 下的全部拥有者记录。 */
export async function readHostRunOwnerships(runDir: string): Promise<{ readonly records: readonly IHostRunOwnership[]; readonly unreadable: readonly string[] }> {
	let names: string[];
	try {
		names = await fsp.readdir(runDir);
	} catch {
		return { records: [], unreadable: [] };
	}
	const records: IHostRunOwnership[] = [];
	const unreadable: string[] = [];
	for (const name of names.filter(n => runIdOfHostRunOwnershipFile(n) !== undefined)) {
		let text: string;
		try {
			text = await fsp.readFile(join(runDir, name), 'utf8');
		} catch {
			unreadable.push(name);
			continue;
		}
		const record = parseHostRunOwnership(text);
		if (record) {
			records.push(record);
		} else {
			unreadable.push(name);
		}
	}
	return { records, unreadable };
}

/** 默认的"结束整棵进程树"。 */
function defaultKillTree(pid: number): Promise<void> {
	if (process.platform === 'win32') {
		return new Promise<void>(resolve => {
			execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
		});
	}
	try {
		process.kill(pid, 'SIGKILL');
	} catch { /* 已经没了 */ }
	return Promise.resolve();
}

/** 杀掉进程后，等它真的退出最多这么久（3s 足够 Windows 上一个 node 进程收尾 ✓）。 */
const KILL_EXIT_WAIT_MS = 3_000;

/** 默认的"等进程退出"：轮询 `isAlive`，100ms 一次。 */
async function defaultWaitExit(isAlive: (pid: number) => boolean, pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!isAlive(pid)) {
			return true;
		}
		if (Date.now() >= deadline) {
			return false;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

/**
 * 回收孤儿 Host：结束进程树 + 删掉它的覆盖层与拥有者记录；顺带清理**够老的**遗留覆盖层。
 *
 * ⚠ 调用时机**必须**在"复用判定之后" ✗：先试复用、判定不复用才回收 —— 否则会把想接管的那份杀掉 ✗✗。
 * @param options - 见 {@link IHostReapOptions}。
 * @returns 回收/保留/删除清单（调用方可据此记日志；本函数自己也逐条 `log` ✓）。
 */
export async function reapOrphanHosts(options: IHostReapOptions): Promise<IHostReapReport> {
	const now = options.now ?? Date.now();
	const isAlive = options.isAlive ?? pidAlive;
	const killTree = options.killTree ?? defaultKillTree;
	const waitExit = options.waitExit ?? ((pid: number, timeoutMs: number) => defaultWaitExit(isAlive, pid, timeoutMs));
	const { records, unreadable } = await readHostRunOwnerships(options.runDir);
	const plan = planOrphanHosts(records, { selfAppPid: options.selfAppPid, isAlive, now, graceMs: options.graceMs ?? OWNERSHIP_GRACE_MS });
	const removed: string[] = [];

	for (const verdict of plan.keep) {
		options.log(`orphan-reap: keep run ${verdict.record.runId} (host pid ${verdict.record.hostPid}) — ${verdict.reason}`);
	}
	const liveRunIds = new Set(plan.keep.map(v => v.record.runId));
	for (const verdict of plan.reap) {
		const { record, reason } = verdict;
		options.log(`orphan-reap: reap run ${record.runId} (host pid ${record.hostPid}, profile ${record.profile}) — ${reason}`);
		let gone = true;
		if (isAlive(record.hostPid)) {
			await killTree(record.hostPid);
			// ★ 2026-10-29：**必须确认它真的退出了**才能删记录 —— 原来 taskkill 一返回就删，
			//   哪怕进程还活着 ⇒ 记录一丢就再也没人能认出来 ⇒ 变成永远回收不掉的僵尸 ✗✗。
			gone = await waitExit(record.hostPid, KILL_EXIT_WAIT_MS);
			options.log(gone
				? `orphan-reap: killed process tree of pid ${record.hostPid}（已退出 ✓）`
				: `orphan-reap: pid ${record.hostPid} 仍未退出 ⇒ 保留它的拥有者记录与覆盖层，下轮再试（删了记录它就再也认不出来了 ✗）`);
		}
		if (!gone) {
			continue;   // 保留记录与覆盖层 ⇒ 下一轮启动还能认出来并再试 ✓
		}
		// 覆盖层与拥有者记录一起清（**只认 basename** ⇒ 记录里塞路径也指不到目录外 ✗）。
		for (const file of [...record.files, hostRunOwnershipFileName(record.runId)]) {
			const base = file.split(/[\\/]/).pop();
			if (!base || base !== file) {
				continue;
			}
			try {
				await fsp.rm(join(options.runDir, base), { force: true });
				removed.push(base);
			} catch { /* best effort */ }
		}
	}

	// ★ 2026-10-29：额外候选（租约里那个"宿主已死、我们不打算复用"的 Host）—— 没有 owner 记录 ⇒ 只结束进程。
	for (const candidate of options.extraCandidates ?? []) {
		if (!Number.isInteger(candidate.pid) || candidate.pid <= 0 || !isAlive(candidate.pid)) {
			continue;
		}
		options.log(`orphan-reap: reap extra host pid ${candidate.pid} — ${candidate.reason}`);
		await killTree(candidate.pid);
		const gone = await waitExit(candidate.pid, KILL_EXIT_WAIT_MS);
		options.log(gone
			? `orphan-reap: killed extra host pid ${candidate.pid}（已退出 ✓）`
			: `orphan-reap: extra host pid ${candidate.pid} 仍未退出 ⇒ 保留现状（下次启动再试 ✗）`);
	}

	// 遗留兜底：够老的覆盖层、且不属于任何"保留中"的 run（老 run 目录里积了几十份 ✗）。
	const legacyMaxAgeMs = options.legacyMaxAgeMs ?? LEGACY_OVERLAY_MAX_AGE_MS;
	let names: string[] = [];
	try {
		names = await fsp.readdir(options.runDir);
	} catch { /* 目录不存在 ⇒ 没有可清的 */ }
	for (const name of names) {
		const runId = runIdOfHostOverlayFile(name);
		if (!runId || liveRunIds.has(runId)) {
			continue;
		}
		const full = join(options.runDir, name);
		try {
			const stat = await fsp.stat(full);
			if (now - stat.mtimeMs < legacyMaxAgeMs) {
				continue;
			}
			await fsp.rm(full, { force: true });
			removed.push(name);
		} catch { /* best effort */ }
	}

	if (removed.length > 0) {
		options.log(`orphan-reap: removed ${removed.length} stale run file(s) from ${options.runDir}`);
	}
	return { reaped: plan.reap, kept: plan.keep, removed, unreadable };
}
