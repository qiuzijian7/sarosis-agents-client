// @vssaros/dsh-workflow — 跨进程写锁（协议 v2；与 IDE 侧 `agentStudio/common/fileWriteLock.ts` 和
// `vssaros-kanban/lib/store.js` 的锁**同一套协议**，互通性由 `dshHarness/test/common/dshWorkflowWriteLock.test.ts`
// 用**真实文件**验证 ✓（那两个插件实现被同一份断言跑 ✓）。
//
// 为什么要它（README 5.61 / 5.65）：`~/.vssaros/workflows/` 与看板数据都由 **IDE 与 dsh 两侧写** ✓ ⇒
// 没有互斥就是丢更新（A 读旧数组 → B 追加写回 → A 用自己的旧数组整表覆盖 ⇒ B 那条没了 ✗）。
// **原子写救不了这条** ✓：它保证"不半截"，**不保证"不丢更新"** ✓。
//
// 协议（与 IDE 侧逐字一致）：
//   · 锁文件 ＝ `<目标文件>.lock` ✓；抢锁 ＝ **独占创建**（`'wx'`，已存在即失败 ✓）；内容 `{"pid":…,"at":…}` ✓；
//   · **心跳**：持锁期间每 `FILE_LOCK_HEARTBEAT_MS` 刷新锁文件 mtime ✓（卡死但仍在跑的持有者不会被误破门 ✓）；
//   · **破门规则（v2 起）**：mtime 年龄超 `staleMs` **且**持有者进程已不在 ⇒ 才删掉重抢 ✓；
//     pid 读不出来（老格式 / 外部工具）⇒ 退回**只看 mtime** ✓（如实降级 ✓）；
//     **持有者仍在运行 ⇒ 不许破门** ✗（可能只是慢 ⇒ 一直等到 `waitMs` 超时并如实报错 ✓）。
//   · 默认值照抄看板样本（`vssaros-kanban/lib/store.js:19-20` ✓）：`5000` / `15000` / 轮询 `100ms` ✓。
//
// ⚠ 仍有的边界（如实 ✗）：pid 可被**回收/复用** ⇒ 持锁进程死后 pid 被别人占用，我们会以为它还活着 ⇒
// 白等到超时 ✗（但**不会**误破门 ✓ —— 错向"保守"那一侧 ✓）；时钟跳变仍影响 mtime 判定 ✗。

import { open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';

/** 锁文件后缀（**协议的一部分**，IDE 侧同名常量必须一致）。 */
export const FILE_LOCK_SUFFIX = '.lock';
/** 抢锁等待上限（毫秒）—— 照抄看板样本。 */
export const FILE_LOCK_WAIT_MS = 5000;
/** 锁过期阈值（毫秒）：超过且**持有者已不在**才允许破门 —— 照抄看板样本。 */
export const FILE_LOCK_STALE_MS = 15000;
/** 抢锁轮询间隔（毫秒）。 */
export const FILE_LOCK_POLL_MS = 100;
/** 心跳间隔（毫秒）：必须**明显小于** `staleMs` ✓。 */
export const FILE_LOCK_HEARTBEAT_MS = 2000;
/** 原子写的临时文件后缀（与 IDE 侧的 `.vsctmp` 区分开，便于事后分辨是谁留下的 ✓）。 */
export const ATOMIC_TMP_POSTFIX = '.vssaros-tmp';

/** 目标文件 → 锁文件（**协议的一部分**）。 */
export function lockFileFor(target) {
	return `${target}${FILE_LOCK_SUFFIX}`;
}

/** pid 是否还活着：`true` 活 / `false` 死 / `undefined` 不知道（退回只看 mtime ✓）。 */
export function isPidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM = 活着但没权限（活着 ✓）；ESRCH = 不存在（死了 ✓）；其它 ⇒ 不知道 ✓
		return e?.code === 'EPERM' ? true : (e?.code === 'ESRCH' ? false : undefined);
	}
}

/** 读锁文件里的 pid（读不到 / 不是整数 ⇒ `undefined` ⇒ 退回只看 mtime ✓）。 */
async function pidOf(lock) {
	try {
		const raw = JSON.parse(await readFile(lock, { encoding: 'utf8' }));
		return Number.isInteger(raw?.pid) ? raw.pid : undefined;
	} catch {
		return undefined;
	}
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 抢锁；返回**释放函数**（务必放进 `finally` ✓；释放会同时停掉心跳 ✓）。
 *
 * @throws 等到 `waitMs` 仍被别人持有 ⇒ 抛错（持有者还活着时会带上 pid ✓）；创建失败但锁文件**不在**
 *         ⇒ 权限/磁盘类真错误，**如实抛**（不当成"被占用"重试 ✗）
 */
export async function acquireFileLock(lock, {
	waitMs = FILE_LOCK_WAIT_MS,
	staleMs = FILE_LOCK_STALE_MS,
	pollMs = FILE_LOCK_POLL_MS,
	heartbeatMs = FILE_LOCK_HEARTBEAT_MS,
	label = '文件',
} = {}) {
	const content = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			const handle = await open(lock, 'wx');
			await handle.writeFile(content);
			await handle.close();
			// 心跳：持锁期间刷新 mtime ⇒ "卡死但仍在跑"的持有者不会被误破门 ✓
			const timer = setInterval(() => {
				const now = new Date();
				utimes(lock, now, now).catch(() => {});
			}, Math.max(50, heartbeatMs));
			timer.unref?.();
			return async () => {
				clearInterval(timer);
				await unlink(lock).catch(() => {});
			};
		} catch (e) {
			if (e?.code !== 'EEXIST') {
				throw new Error(`写锁创建失败（${lock}）：${e?.message ?? e}`);
			}
			let heldSince;
			try {
				heldSince = (await stat(lock)).mtimeMs;
			} catch {
				continue; // 锁刚好被释放：立刻重试，不必等一轮轮询
			}
			const pid = await pidOf(lock);
			const alive = pid === undefined ? undefined : isPidAlive(pid);
			const stale = Date.now() - heldSince > staleMs;
			// 破门：**过期且持有者已不在**（或无从得知）才动手 ✓；活着 ⇒ 绝不 ✗
			if (stale && alive !== true) {
				await unlink(lock).catch(() => {});
			} else if (Date.now() > deadline) {
				const holder = pid === undefined ? '持有者未知' : (alive === true ? `持有者进程 ${pid} 仍在运行` : `持有者 ${pid} 已不在（但锁文件删不掉？）`);
				throw new Error(`${label}正被另一个写者占用（${lock}，已等待 ${waitMs}ms；${holder}）。若确认无其它进程在写，删除该锁文件后重试。`);
			} else {
				await delay(pollMs);
			}
		}
	}
}

/**
 * 原子写：临时文件 + rename。临时文件名带 **pid** ⇒ 两个写者不会撞同一个 tmp ✗。
 * 失败时清掉临时文件，不留垃圾 ✓。
 */
export async function atomicWriteFile(file, text, { tmpPostfix = ATOMIC_TMP_POSTFIX } = {}) {
	const tmp = `${file}.${process.pid}${tmpPostfix}`;
	try {
		await writeFile(tmp, text, 'utf8');
		await rename(tmp, file);
	} catch (e) {
		await unlink(tmp).catch(() => {});
		throw e;
	}
}
