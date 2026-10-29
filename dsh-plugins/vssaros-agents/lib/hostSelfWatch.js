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
 */

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
 * 起一个看护定时器。
 *
 * @param {object}   [opts]
 * @param {number}   [opts.appPid]      父进程 pid（默认 `process.ppid`）
 * @param {number}   [opts.intervalMs]  巡检间隔
 * @param {number}   [opts.missesToExit] 连续几次判定死亡才退出
 * @param {Function} [opts.log]         日志（`(msg) => void`）
 * @param {Function} [opts.isAlive]     可注入（测试用）
 * @param {Function} [opts.exit]        可注入（测试用）
 * @returns {() => void} 停止函数
 */
export function startAppParentWatch({
	appPid = process.ppid,
	intervalMs = 30_000,
	missesToExit = 2,
	log = () => { },
	isAlive = pidAlive,
	exit = (code) => process.exit(code),
} = {}) {
	const parent = Number(appPid);
	/* ppid <= 1 = 没有父进程（或被 init 收养）：不归本看护管，别乱杀。 */
	if (!Number.isFinite(parent) || parent <= 1) {
		log(`[host] 未启用父进程看护（ppid=${String(appPid)}：没有可跟踪的父进程）`);
		return () => { };
	}
	let misses = 0;
	const timer = setInterval(() => {
		if (isAlive(parent)) {
			misses = 0;
			return;
		}
		misses += 1;
		if (misses === 1) {
			log(`[host] 父进程（app pid ${parent}）暂不可见 —— 可能是 app 正在重启，先观望（再 1 次就退出）`);
			return;
		}
		log(`[host] 父进程（app pid ${parent}）已退出 ⇒ 本 Host 是孤儿，主动退出：`
			+ '继续活着只会占着会话写句柄与 IM 长连接（同一飞书应用多条连接会互相抢事件）');
		try {
			exit(0);
		} catch { /* 忽略：退出失败也不会更糟 */ }
	}, Math.max(200, Number(intervalMs) || 30_000));
	if (typeof timer.unref === 'function') {
		timer.unref();
	}
	return () => clearInterval(timer);
}
