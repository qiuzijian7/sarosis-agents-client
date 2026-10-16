/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **跨进程写锁**（整文件覆盖写的互斥）：IDE 侧实现，与插件侧 `vssaros-workflow/lib/lock.js` 和
 * `vssaros-kanban/lib/store.js` 的锁**同一套协议**（互通性由 `dshHarness/test/common/dshWorkflowWriteLock.test.ts`
 * 用**真实文件**验证 ✓，且那两个实现都被同一份断言跑 ✓）。
 *
 * ── 为什么需要（README 5.61 / 5.65）───────────────────────────────────────────────
 * `~/.vssaros/workflows/<id>/sessions.json`、`taskboard.json`、`boards.json` 都是**整文件读-改-写**，
 * 而两侧（IDE 与 dsh 插件）都会写 ⇒ 没有互斥就是经典丢更新 ✓。**原子写救不了这条** ✓：它保证
 * "不半截"，**不保证"不丢更新"** ✓。
 *
 * ── 协议（v2，与两个插件实现逐字一致）───────────────────────────────────────────────
 *   · 锁文件 ＝ `<目标文件>.lock` ✓；抢锁 ＝ **独占创建**（已存在即失败 ✓）；内容 `{"pid":…,"at":…}` ✓；
 *   · **心跳**：持锁期间每 {@link FILE_LOCK_HEARTBEAT_MS} 刷新锁文件 mtime ✓（卡死但仍在跑的持有者
 *     因此不会被误破门 ✓）；
 *   · **破门规则（v2 起）**：mtime 年龄超 `staleMs` **且**持有者进程已不在 ⇒ 才删掉重抢 ✓；
 *     pid 读不出来（老格式 / 外部工具）⇒ 退回**只看 mtime** ✓（如实降级，不假装知道 ✓）；
 *     **持有者仍在运行 ⇒ 不许破门** ✗（它可能只是慢 —— 一直等到 `waitMs` 超时并如实报错 ✓）。
 *   · 默认值照抄看板样本：`waitMs 5000` / `staleMs 15000` / 轮询 `100ms`
 *     （`dsh-plugins/vssaros-kanban/lib/store.js:19-20` ✓）。
 *
 * ⚠ 仍有的边界（如实 ✗）：pid 可被**回收/复用**（持锁进程死后 pid 被别的进程占用 ⇒ 我们以为它还活着
 * ⇒ 白等到超时 ✗，但**不会**误破门 ✓ —— 错向"保守"那一侧 ✓）；时钟跳变仍影响 mtime 判定 ✗。
 *
 * ⚠ 这里只用 `IFileService` 的几个操作（独占创建 / 读 / stat / touch / 删除），并抽成 `IExclusiveFileOps`
 * 注入 ⇒ ① 本层不必 import Node 的 fs ✓；② 单元测试可以塞一份 Node fs 实现，与插件侧**真互通** ✓。
 */

import { VSBuffer } from '../../../../base/common/buffer.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';

/** 锁文件后缀（**协议的一部分**，插件侧同名常量必须一致）。 */
export const FILE_LOCK_SUFFIX = '.lock';
/** 抢锁等待上限（毫秒）—— 照抄看板样本。 */
export const FILE_LOCK_WAIT_MS = 5000;
/** 锁过期阈值（毫秒）：超过且**持有者已不在**才允许破门 —— 照抄看板样本。 */
export const FILE_LOCK_STALE_MS = 15000;
/** 抢锁轮询间隔（毫秒）。 */
export const FILE_LOCK_POLL_MS = 100;
/** 心跳间隔（毫秒）：持锁期间按它刷新锁文件 mtime（必须 **明显小于** `staleMs` ✓）。 */
export const FILE_LOCK_HEARTBEAT_MS = 2000;

/** 目标文件 → 锁文件（**协议的一部分**）。 */
export function lockResourceFor(target: URI): URI {
	return target.with({ path: `${target.path}${FILE_LOCK_SUFFIX}` });
}

/** 锁用到的原语；抽出来是为了让"浏览器层"与"单元测试"都能各给一份实现 ✓。 */
export interface IExclusiveFileOps {
	/** 独占创建（已存在 ⇒ 抛）。 */
	createExclusive(resource: URI, text: string): Promise<void>;
	/** 读锁文件内容；读不到 ⇒ `undefined`（老格式 / 竞态都走这里 ✓）。 */
	readText(resource: URI): Promise<string | undefined>;
	/** mtime（毫秒）；文件不存在 ⇒ `undefined`。 */
	mtimeOf(resource: URI): Promise<number | undefined>;
	/**
	 * 把 mtime 刷新成"现在"（心跳 ✓）；文件不在 ⇒ 静默失败。
	 * ⚠ 传 `text` 进来是**必须**的：`IFileService` 没有 `touch` ⇒ 只能"**原样重写**"来刷 mtime ✓
	 * （写别的内容会把锁文件里的 pid 弄坏 ✗ —— 那会让破门判据退回"只看 mtime" ✓，等于白做 ✓）。
	 */
	touchMtime(resource: URI, text: string): Promise<void>;
	/** 删除（不存在也算成功）。 */
	deleteFile(resource: URI): Promise<void>;
	/**
	 * pid 是否还活着：`true` 活 / `false` 死 / `undefined` **不知道**（退回只看 mtime ✓）。
	 *
	 * ⚠ 默认实现用 `process.kill(pid, 0)`；渲染进程里若拿不到 `process.kill` ⇒ 返回 `undefined`
	 *（如实降级 ✗，而不是猜"死了" ⇒ 那会误破门 ✗）。
	 */
	isPidAlive?(pid: number): boolean | undefined;
}

/** 默认的 pid 存活判据（拿不到 `process.kill` 就返回"不知道" ✓）。 */
export function defaultIsPidAlive(pid: number): boolean | undefined {
	if (!Number.isInteger(pid) || pid <= 0) { return undefined; }
	const kill = (typeof process !== 'undefined' ? (process as { kill?: (pid: number, signal?: number | string) => boolean }).kill : undefined);
	if (typeof kill !== 'function') { return undefined; }
	try {
		kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM = 进程活着但没权限（活着 ✓）；ESRCH = 不存在（死了 ✓）；其它错误 ⇒ 不知道 ✓
		const code = (e as { code?: string })?.code;
		return code === 'EPERM' ? true : (code === 'ESRCH' ? false : undefined);
	}
}

/** `IFileService` → 原语（生产用这份）。 */
export function fileServiceOps(fileService: IFileService): IExclusiveFileOps {
	return {
		async createExclusive(resource, text) {
			await fileService.createFile(resource, VSBuffer.fromString(text), { overwrite: false });
		},
		async readText(resource) {
			try {
				return (await fileService.readFile(resource)).value.toString();
			} catch {
				return undefined;
			}
		},
		async mtimeOf(resource) {
			try {
				return (await fileService.stat(resource)).mtime;
			} catch {
				return undefined;
			}
		},
		async touchMtime(resource, text) {
			// "原样重写"＝刷 mtime ✓（内容一模一样 ⇒ pid 不丢 ✓）；失败静默（心跳丢一拍不致命 ✓，
			// 下一拍会补上 ✓，实在不行还有 `staleMs` 兜底 ✓）
			await fileService.writeFile(resource, VSBuffer.fromString(text)).catch(() => undefined);
		},
		async deleteFile(resource) {
			await fileService.del(resource, { recursive: false }).catch(() => undefined);
		},
	};
}

/** 读锁文件里的 pid（读不到/不是整数 ⇒ `undefined` ⇒ 退回只看 mtime ✓）。 */
function pidOf(text: string | undefined): number | undefined {
	if (!text) { return undefined; }
	try {
		const raw = JSON.parse(text) as { pid?: unknown };
		return typeof raw?.pid === 'number' && Number.isInteger(raw.pid) ? raw.pid : undefined;
	} catch {
		return undefined;
	}
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * 抢锁；返回**释放函数**（调用方务必放进 `finally` ✓；释放会同时停掉心跳 ✓）。
 *
 * @throws 等到 `waitMs` 仍被别人持有 ⇒ 抛错。若那时**持有者还活着**，错误信息会带上 pid ✓
 *         （"它可能只是慢"与"它已经死了但你删不掉锁文件"是两种不同的处置 ✓）；
 *         创建失败但锁文件**不在** ⇒ 那是权限/磁盘类真错误，**如实抛**（不当成"被占用"重试 ✗）
 */
export async function acquireFileLock(lock: URI, ops: IExclusiveFileOps, {
	waitMs = FILE_LOCK_WAIT_MS,
	staleMs = FILE_LOCK_STALE_MS,
	pollMs = FILE_LOCK_POLL_MS,
	heartbeatMs = FILE_LOCK_HEARTBEAT_MS,
	label = '文件',
}: { waitMs?: number; staleMs?: number; pollMs?: number; heartbeatMs?: number; label?: string } = {}): Promise<() => Promise<void>> {
	const selfPid = typeof process !== 'undefined' ? process.pid : 0;
	const isAlive = ops.isPidAlive ?? defaultIsPidAlive;
	const content = JSON.stringify({ pid: selfPid, at: new Date().toISOString() });
	const deadline = Date.now() + waitMs;
	for (; ;) {
		try {
			await ops.createExclusive(lock, content);
			// 心跳：持锁期间刷新 mtime ⇒ "卡死但仍在跑"的持有者不会被误破门 ✓
			const timer = setInterval(() => { void ops.touchMtime(lock, content); }, Math.max(50, heartbeatMs));
			(timer as unknown as { unref?: () => void }).unref?.();
			return async () => {
				clearInterval(timer);
				await ops.deleteFile(lock);
			};
		} catch (err) {
			const heldSince = await ops.mtimeOf(lock);
			if (heldSince === undefined) {
				throw new Error(`写锁创建失败（${lock.toString()}）：${err instanceof Error ? err.message : String(err)}`);
			}
			const pid = pidOf(await ops.readText(lock));
			const alive = pid === undefined ? undefined : isAlive(pid);
			const stale = Date.now() - heldSince > staleMs;
			// 破门：**过期且持有者已不在**（或无从得知）才动手 ✓；活着 ⇒ 绝不 ✗
			if (stale && alive !== true) {
				await ops.deleteFile(lock);
			} else if (Date.now() > deadline) {
				const holder = pid === undefined ? '持有者未知' : (alive === true ? `持有者进程 ${pid} 仍在运行` : `持有者 ${pid} 已不在（但锁文件删不掉？）`);
				throw new Error(`${label}正被另一个写者占用（${lock.toString()}，已等待 ${waitMs}ms；${holder}）。若确认无其它进程在写，删除该锁文件后重试。`);
			} else {
				await sleep(pollMs);
			}
		}
	}
}
