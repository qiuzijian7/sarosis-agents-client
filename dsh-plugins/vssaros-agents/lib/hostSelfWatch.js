/**
 * 父进程看护：**app 没了，Host 自己退出**。
 *
 * ## 为什么需要（2026-10-29 真机定案）
 *
 * 每次重启 VsSaros 都会 spawn 一个新的 dsh Host，而**旧 Host 不会死**：
 * harness 的 `reapOrphanHosts` 只认 `dsh-run/owner-*.json`，那份记录会被后续实例
 * 覆盖/清理 ⇒ 失去归属的 Host 永远回收不掉。真机上攒出过 3 个 Host 同时活着，
 * 于是同一个飞书应用被多条长连接同时挂住 —— 飞书只把事件投给其中一条，
 * 表现是「日志全绿 + 心跳正常 + 零事件」（今天一整天就卡在这）。
 *
 * ## 判据
 *
 * Host 是 app 的子进程。Windows 上父进程退出后，子进程的 `process.ppid` 仍返回
 * **原来的 pid**（不会像 Linux 那样变成 1）⇒ `process.kill(ppid, 0)` 失败就是
 * "我的 app 已经没了"，本进程继续活着只会占着会话写句柄与 IM 长连接。
 *
 * ⚠ **连续两次**（默认约 60s）仍判定死亡才退出：一次失败可能是 app 正在重启，
 *   而 Host 是 keepAlive 复用的 —— 抢在一个正在发生的事件中间退出代价更大。
 *
 * ⚠ 不处理 `ppid <= 1`：那是"没有父进程"（手动从终端起的 Host 也可能落到 1），
 *   这种情况由用户显式管理，不该被自动杀掉。
 *
 * ## ★★ 2026-11-02：被**接管**的 Host 不是孤儿
 *
 * 真机（`20261102T204521`）：F5 新起的 app（pid 121716）按 keepAlive **接管**了上一个 app（pid 42464）
 * 拉起的 Host；旧 app 退出后，本看护只认 spawn 时的 `process.ppid` ⇒ 判"孤儿"⇒ `exit(0)`
 * ⇒ 新 app 的页面连接重试 20s、建会话失败，46s 后才发现 "the reused Host is gone" 重起 ✗✗。
 *
 * "当前谁在用这个 Host"的真源在 `vssaros-bridge`：握手给的**拥有者记录**（`owner-*.json`，
 * 接管者会写自己那份，含 `appPid`，宿主周期性刷新 mtime）+ 已连上的 IDE 客户端数。
 * 桥插件把它发布到 `globalThis[Symbol.for('vssaros.hostOwnership')]`。
 * ⇒ 父进程看不见时**先问当前拥有者**：
 *   · 拥有者记录指向本 Host、心跳新鲜、`appPid` 活着 ⇒ **改看护这个 app**（不退）；
 *   · 仍有 IDE 客户端连着 ⇒ 有人在用 ⇒ 不退（这一轮不计失败）；
 *   · 都不满足 ⇒ 照旧计失败（读不到 / 桥没挂载 ⇒ 行为与改动前一致）。
 */

import { readFileSync, statSync } from 'node:fs';

/** 共享位的钥匙（与 vssaros-bridge 同一个 `Symbol.for` ⇒ 跨插件、跨模块副本都是同一把）。 */
export const HOST_OWNERSHIP_KEY = Symbol.for('vssaros.hostOwnership');

/**
 * 拥有者记录多久没被刷新就不再相信它（与 vssaros-bridge 的 `OWNER_STALE_MS` 同值）。
 * 宿主优雅分离时会把 mtime 推到**未来** ⇒ 那种情况下 `appPid` 已死，判据自然不成立 ✓。
 */
export const OWNER_RECORD_STALE_MS = 3 * 20_000;

/** pid 是否还活着（EPERM = 有进程占着但没权限 ⇒ 同样算活）。 */
export function pidAlive(pid) {
	const n = Number(pid);
	if (!Number.isFinite(n) || n <= 1) {
		return false;
	}
	try {
		process.kill(n, 0);
		return true;
	} catch (e) {
		return !!e && e.code === 'EPERM';
	}
}

/**
 * 读当前拥有者（来自 vssaros-bridge 发布的共享位 + 拥有者记录）。
 *
 * @returns {{ inUse: boolean, appPid?: number } | null} null = 桥插件没发布（没挂载 / 非 VsSaros 托管）
 */
export function readHostOwnership({ now = Date.now(), selfPid = process.pid } = {}) {
	let shared;
	try {
		shared = globalThis[HOST_OWNERSHIP_KEY];
	} catch {
		return null;
	}
	if (!shared || typeof shared !== 'object') {
		return null;
	}
	const inUse = Number(shared.clientCount) > 0;
	let appPid;
	const file = typeof shared.ownerRecordPath === 'string' ? shared.ownerRecordPath : '';
	if (file) {
		try {
			// ⚠ 心跳要新鲜：pid 会被复用 ⇒ 只看 pid 活不活会被骗（与桥插件看门狗同一条纪律）
			const fresh = now - statSync(file).mtimeMs <= OWNER_RECORD_STALE_MS;
			const record = JSON.parse(readFileSync(file, 'utf8'));
			// ⚠ 记录必须是**本 Host** 的：路径来自握手，正常一定是；不是就别信
			const forSelf = Number(record?.hostPid) === Number(selfPid);
			const pid = Number(record?.appPid);
			if (fresh && forSelf && Number.isFinite(pid) && pid > 1) {
				appPid = pid;
			}
		} catch { /* 记录还没写 / 已被清 ⇒ 当作没有 */ }
	}
	return { inUse, ...(appPid ? { appPid } : {}) };
}

/**
 * 起一个看护定时器。
 *
 * @param {object}   [opts]
 * @param {number}   [opts.appPid]      父进程 pid（默认 `process.ppid`）
 * @param {number}   [opts.intervalMs]  巡检间隔
 * @param {number}   [opts.missesToExit] 连续几次判定死亡才退出
 * @param {Function} [opts.log]         日志（`(msg) => void`）
 * @param {Function} [opts.isAlive]     可注入（测试用）
 * @param {Function} [opts.exit]        可注入（测试用）
 * @param {Function} [opts.ownership]   当前拥有者（默认 `readHostOwnership`；可注入，测试用）
 * @returns {() => void} 停止函数
 */
export function startAppParentWatch({
	appPid = process.ppid,
	intervalMs = 30_000,
	missesToExit = 2,
	log = () => { },
	isAlive = pidAlive,
	exit = (code) => process.exit(code),
	ownership = () => readHostOwnership(),
} = {}) {
	let parent = Number(appPid);
	/* ppid <= 1 = 没有父进程（或被 init 收养）：不归本看护管，别乱杀。 */
	if (!Number.isFinite(parent) || parent <= 1) {
		log(`[host] 未启用父进程看护（ppid=${String(appPid)}：没有可跟踪的父进程）`);
		return () => { };
	}
	let misses = 0;
	let notedInUse = false;
	const tick = () => {
		if (isAlive(parent)) {
			misses = 0;
			return;
		}
		// ★ 2026-11-02：先问当前拥有者（见文件头"被接管的 Host 不是孤儿"）
		let owner = null;
		try { owner = ownership(); } catch { owner = null; }
		if (owner && owner.appPid && owner.appPid !== parent && isAlive(owner.appPid)) {
			log(`[host] 原父进程（app pid ${parent}）已退出，但本 Host 已被 app pid ${owner.appPid} 接管 ⇒ 改为看护它（不退出）`);
			parent = owner.appPid;
			misses = 0;
			notedInUse = false;
			return;
		}
		if (owner && owner.inUse) {
			if (!notedInUse) {
				notedInUse = true;
				log(`[host] 父进程（app pid ${parent}）不可见，但仍有 IDE 客户端连着本 Host ⇒ 有人在用，不退出`);
			}
			misses = 0;
			return;
		}
		misses += 1;
		if (misses < missesToExit) {
			log(`[host] 父进程（app pid ${parent}）暂不可见 —— 可能是 app 正在重启，先观望（再 ${missesToExit - misses} 次就退出）`);
			return;
		}
		log(`[host] 父进程（app pid ${parent}）已退出 ⇒ 本 Host 是孤儿，主动退出：`
			+ '继续活着只会占着会话写句柄与 IM 长连接（同一飞书应用多条连接会互相抢事件）');
		try {
			exit(0);
		} catch { /* 忽略：退出失败也不会更糟 */ }
	};
	const timer = setInterval(tick, Math.max(200, Number(intervalMs) || 30_000));
	if (typeof timer.unref === 'function') {
		timer.unref();
	}
	return () => clearInterval(timer);
}
