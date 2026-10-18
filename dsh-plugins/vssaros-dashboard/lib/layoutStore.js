// @vssaros/dsh-dashboard — 首页布局的落盘（数据根侧 I/O）：读 / 原子写 / 写者串行 / 文件锁 / 冲突重试。
//
// ⚠ 2026-10-13 新引入（「dashboard → 可编排首页」P2：持久化）。它让本插件**第一次成为数据根的写者**。
//
// 为什么是这一层（而不是塞进 `store.js`）：`store.js` 读的是 **dsh 自己的家**（`<DSH_HOME>/storages/
// session_projcache/...`，只读 ✓，见 `check-host-config.mjs` 的 `dshHomeOf` 一条）；本文件写的是
// **数据根**（`<数据根>/dashboard/layout.json`）—— 两条**不同的链**，混在一个文件里会让"这个模块到底
// 能不能写"变得看不出 ✓。
//
// 写者归属（**2026-10-13 的决定，见 `dshWriteOwnership.test.ts` 的注释**）：
//   · `layout.json` 的写者**只有 dsh 插件**（本模块）；IDE 侧**不认这个文件**（它没有"首页编排"这件事）✓；
//   · ⇒ **故意不声明 `vssaros.owns`**：那个字段的语义是"**两侧都写**的文件，非 owner 侧停写"
//     （`resolveWriteOwnership` 在插件未启用时会把 writer 翻成 `ide` 并写"仍由旧模块写"）—— 对本文件
//     那句话是**假的** ✗。先例：memory 的 `<数据根>/memory-audit/` 也是 dsh-only、同样不声明 ✓。
//
// 并发保护：**与 kanban `lib/store.js` 同一套协议 v2**（那份已被 `dshWriteOwnership.test.ts` 钉住 ⇒ 是
// 事实上的规范实现）。⚠ 这是第 9 份拷贝、且**不在** `check-host-config.mjs` 的拷贝一致性面内 ⇒ 改这里
// 要想一下 kanban / workflow `lib/lock.js` / IDE `fileWriteLock.ts` 那几份 ✗（将来值得把它登记成契约）。
//   · 进程内：模块级串行队列（同一 Host 内绝不并发写）；
//   · 跨进程：`<layout.json>.lock` 独占创建（`wx`）+ 心跳刷 mtime + 按 pid 判"持有者是否还活着"
//     （**活着就绝不破门**）⇒ 两个 dsh Host 同时开着同一个数据根时，后到的会等/报错，而不是互相覆盖 ✓；
//   · 写入原子：临时文件 + rename ⇒ 读者永远看不到半截 JSON ✓；
//   · 丢更新防护：读时记指纹（mtime:size），写前重新比对；不一致 ⇒ 重做 ✓。

import { mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { foundation } from './foundationRef.js';
import { homedir } from 'node:os';

import { dirname, join } from 'node:path';


/** 数据根下的模块目录名（与其它模块同构：`<根>/knowledge-base/`、`<根>/skills/` …）。 */
export const MODULE_DIR = 'dashboard';
/** 布局文件名。 */
export const LAYOUT_FILE = 'layout.json';

const DEFAULT_LOCK_WAIT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 15000;
const DEFAULT_RETRIES = 3;
/** 心跳间隔（毫秒）：必须**明显小于** `staleMs` ✓（与 kanban / workflow / IDE 侧同值 ✓）。 */
const DEFAULT_LOCK_HEARTBEAT_MS = 2000;

/**
 * 数据根。优先级：行配置 `config.dataRoot` → 环境变量 `VSSAROS_DATA_ROOT` → `~/.vssaros`。
 * VsSaros 的数据根可被设置改动（`.vssaros` / `.vssaros-dev`）：改过时由 VsSaros 经 `--patch`
 * 覆盖本行 config 注入（与 bridge 注入 pipe/token 同一机制）。
 */
export function dataRootOf(config) {
	// 委托到 @vssaros/dsh-foundation（重构 1.3：真源只有一份）；调用签名不变。
	return foundation().dataRootOf(config);
}

export function layoutPath(config) {
	return join(dataRootOf(config), MODULE_DIR, LAYOUT_FILE);
}

export function layoutLockPath(config) {
	return `${layoutPath(config)}.lock`;
}

/** 文件指纹：`mtimeMs:size`；不存在时 `absent`。 */
async function fingerprintOf(file) {
	try {
		const st = await stat(file);
		return `${st.mtimeMs}:${st.size}`;
	} catch (e) {
		return e?.code === 'ENOENT' ? 'absent' : `unknown:${e?.code ?? 'err'}`;
	}
}

/**
 * 读布局。**三种结果都如实返回，不猜**：
 *   · 文件不存在 ⇒ `{ missing, fingerprint: 'absent' }`（首启形态 ✓，调用方用出厂默认 ✓）；
 *   · 文件在但读不了 / 不是合法 JSON ⇒ `{ error, ... }`（调用方回落默认**并说明原因** ✓）；
 *   · 正常 ⇒ `{ layout, fingerprint }`（`layout` 是**原样**的 JSON —— 逐字段 sanitize 是布局层
 *     `layout.js` 的 `normalizeLayout` 的事，本层只管 I/O ✓）。
 */
export async function readLayout(config, options = {}) {
	const file = layoutPath(config);
	let text;
	try {
		text = await readFile(file, { encoding: 'utf8', signal: options.signal });
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { missing: file, fingerprint: 'absent' };
		}
		return { error: `首页布局读取失败（${file}）：${e?.message ?? e}`, fingerprint: 'unknown' };
	}
	try {
		return { layout: JSON.parse(text), file, fingerprint: await fingerprintOf(file) };
	} catch (e) {
		return { error: `首页布局不是合法 JSON（${file}）：${e?.message ?? e}`, file, fingerprint: await fingerprintOf(file) };
	}
}

/** 原子写：临时文件 + rename。失败时清掉临时文件，不留垃圾。 */
async function atomicWrite(file, text) {
	const tmp = `${file}.${process.pid}.vsaros-tmp`;
	try {
		await writeFile(tmp, text, 'utf8');
		await rename(tmp, file);
	} catch (e) {
		await unlink(tmp).catch(() => {});
		throw e;
	}
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** pid 是否还活着：`true` 活 / `false` 死 / `undefined` 不知道（退回只看 mtime ✓）。 */
function isPidAlive(pid) {
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

/**
 * 独占创建锁文件；返回释放函数（释放时停掉心跳 ✓）。
 *
 * **协议 v2**（与 `vssaros-kanban/lib/store.js`、`vssaros-workflow/lib/lock.js`、IDE 侧
 * `agentStudio/common/fileWriteLock.ts` 同款）：
 *   · 持锁期间每 `heartbeatMs` 刷新锁文件 mtime ⇒ "卡死但仍在跑"的持有者不会被误破门 ✓；
 *   · 破门 ＝ mtime 过期 **且** 持有者进程已不在（pid 读不出来 ⇒ 退回只看 mtime ✓）；
 *   · **持有者还活着 ⇒ 绝不破门** ✗（它可能只是慢 ⇒ 等到超时并如实报错 ✓）。
 */
export async function acquireLock(file, { waitMs, staleMs, heartbeatMs = DEFAULT_LOCK_HEARTBEAT_MS }) {
	const content = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			const handle = await open(file, 'wx');
			await handle.writeFile(content);
			await handle.close();
			const timer = setInterval(() => {
				const now = new Date();
				utimes(file, now, now).catch(() => {});
			}, Math.max(50, heartbeatMs));
			timer.unref?.();
			return async () => {
				clearInterval(timer);
				await unlink(file).catch(() => {});
			};
		} catch (e) {
			if (e?.code !== 'EEXIST') {
				throw new Error(`首页布局写锁创建失败（${file}）：${e?.message ?? e}`);
			}
			let ageMs;
			try {
				ageMs = Date.now() - (await stat(file)).mtimeMs;
			} catch {
				continue; // 锁刚好被释放：立刻重试
			}
			let pid;
			try {
				const raw = JSON.parse(await readFile(file, { encoding: 'utf8' }));
				pid = Number.isInteger(raw?.pid) ? raw.pid : undefined;
			} catch {
				pid = undefined;
			}
			const alive = pid === undefined ? undefined : isPidAlive(pid);
			// 破门：**过期且持有者已不在**（或无从得知）才动手 ✓；活着 ⇒ 绝不 ✗
			if (ageMs > staleMs && alive !== true) {
				await unlink(file).catch(() => {});
				continue;
			}
			if (Date.now() > deadline) {
				const holder = pid === undefined ? '持有者未知' : (alive === true ? `持有者进程 ${pid} 仍在运行` : `持有者 ${pid} 已不在（但锁文件删不掉？）`);
				throw new Error(`首页布局正被另一个写者占用（${file}，已等待 ${waitMs}ms；${holder}）。若确认无其它进程在写，删除该锁文件后重试。`);
			}
			await delay(100);
		}
	}
}

/** 模块级串行队列：同一进程内的写请求排队（等价 IDE `_withTasks` 的写队列 ✓）。 */
let queue = Promise.resolve();
function serialized(task) {
	const run = queue.then(task, task);
	queue = run.then(() => {}, () => {});
	return run;
}

/**
 * 读-改-写：加锁 → 读（带指纹）→ `mutator(current)` → 指纹未变则原子写回，否则重做。
 *
 * `mutator(current)` 返回 `{ layout, value }`：
 *   · `layout` = 要写回的对象（**字段顺序由调用方定** ⇒ 落盘 JSON 的 diff 稳定 ✓）；返回 `undefined`
 *     ⇒ **不写**（只读路径 / 冲突时只想回报的状态 ✓）；
 *   · `value` = 调用方要拿到的返回值（工具返回值 / HTTP 响应体 ✓）；
 *   · `mutator` 抛错 ⇒ 整体放弃（不写 ✓）。
 *
 * 锁参数取自 **config**（`lockWaitMs` / `lockStaleMs`），`options` 只放调用期的东西（`signal` / `retries`）。
 */
export async function mutateLayout(config, mutator, options = {}) {
	const pick = (key, fallback) => {
		if (Number.isInteger(options[key])) {
			return options[key];
		}
		return Number.isInteger(config?.[key]) ? config[key] : fallback;
	};
	const waitMs = pick('lockWaitMs', DEFAULT_LOCK_WAIT_MS);
	const staleMs = pick('lockStaleMs', DEFAULT_LOCK_STALE_MS);
	const retries = Number.isInteger(options.retries) ? options.retries : DEFAULT_RETRIES;
	const file = layoutPath(config);
	await mkdir(dirname(file), { recursive: true });
	return serialized(async () => {
		const release = await acquireLock(layoutLockPath(config), { waitMs, staleMs });
		try {
			for (let attempt = 1; attempt <= retries; attempt++) {
				const current = await readLayout(config, options);
				const { layout, value } = await mutator(current);
				if (layout === undefined || layout === null) {
					return value;
				}
				if (typeof layout !== 'object') {
					throw new Error('mutator 必须返回 { layout, value }（layout 为对象或 undefined）');
				}
				if (await fingerprintOf(file) !== current.fingerprint) {
					continue; // 读与写之间有别的写者动了文件 → 重做，避免丢更新 ✓
				}
				await atomicWrite(file, `${JSON.stringify(layout, null, 2)}\n`);
				return value;
			}
			throw new Error(`首页布局在写入期间被其它写者反复改动，已放弃（${file}）`);
		} finally {
			await release();
		}
	});
}
