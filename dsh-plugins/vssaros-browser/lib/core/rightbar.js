/**
 * 右栏浏览器（2026-11-07，P0 · 单一实例）：**人在右栏看见的那一页，就是工具操作的那一页**。
 *
 * 之前右栏是 IDE 的 WebContentsView（Global 登录态），`browser` 工具却驱动另一个 Chrome ⇒ 两个页面、两套登录、
 * 互相看不见。现在主进程把右栏视图当 CDP 端点中转出来（`src/vs/sessions/contrib/dshHarness/electron-main/
 * dshRightbarCdpRelay.ts`：loopback + 每次启动随机 token + 方法白名单），把端点写在
 * `<数据根>/dsh-run/rightbar-cdp.json`；本模块读它、并给出"右栏模式"下的 target 管理。
 *
 * 右栏模式的规矩（与 Chrome 模式**刻意不同**，全部由守卫钉住）：
 *  · **不建页**：只用右栏已有的那一页（中转也拒 `Target.createTarget`）——不另开 profile、不复制 cookie；
 *  · **不关页**：那是人的视图（中转也拒 `Target.closeTarget`）；会话结束什么都不回收；
 *  · **所有会话共用**：用户定的口径是「不做 per-Bot 隔离」⇒ 不分归属；可见的那个视图排在最前；
 *  · **不切有头/无头**：右栏本来就可见。
 * 右栏没打开（没有视图）⇒ 回到原来的 Chrome 路径，行为与以前一致。
 *
 * ★ 2026-11-07（组合方案，参考 DS Bot 的「主进程按需建隐藏视图」）：要**操作**页面而右栏一个视图都没有时，请中转用
 *   `VsSaros.ensureRightbarPage` 建一条**隐藏**的共享视图（同一个 id，人打开右栏「浏览器」页签看到的就是它）——
 *   不弹界面、不切页签；人要看 / 要接手，就打开页签（或在交接提示上点「接管」）。只读的 `status` 不建。
 *   这仍不是"建第二页"：中转只在右栏**没有任何页**时才建，`Target.createTarget` 照旧拒。
 *   VsSaros 没开（没有发现文件 / 中转建不了）⇒ 照旧回到 Chrome。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 中转自有命令：右栏没有页时建隐藏的共享视图（与主进程 `RIGHTBAR_ENSURE_PAGE_METHOD` 同名，测试比对）。 */
export const RIGHTBAR_ENSURE_PAGE_METHOD = 'VsSaros.ensureRightbarPage';
/** 建视图的等待上限（主进程建视图是毫秒级；给宽一点）。 */
const ENSURE_PAGE_TIMEOUT_MS = 10_000;

/** 发现文件名（与主进程 `common/dshRightbarCdp.ts` 的 `RIGHTBAR_CDP_FILE` 同名，守卫比对）。 */
export const RIGHTBAR_CDP_FILE = 'rightbar-cdp.json';
/** 端点 URL 的形状：只认本机。 */
const WS_URL = /^ws:\/\/127\.0\.0\.1:\d{1,5}\/devtools\/browser\/vssaros-rightbar\/[0-9a-f]{16,}$/;

/** 数据根下的发现文件路径。 */
export const rightbarCdpFile = dataRoot => join(dataRoot, 'dsh-run', RIGHTBAR_CDP_FILE);

/**
 * 读发现文件 ⇒ `{ wsUrl, pid }`；文件不在 / 坏了 / 进程已不在 ⇒ `undefined`（调用方走 Chrome）。
 * @param {string} file
 * @param {(pid: number) => boolean} [alive]
 */
export function readRightbarEndpoint(file, alive = pidAlive) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
	if (parsed?.version !== 1 || typeof parsed.wsUrl !== 'string' || !WS_URL.test(parsed.wsUrl)) { return undefined; }
	if (!Number.isInteger(parsed.pid) || !alive(parsed.pid)) { return undefined; }
	return { wsUrl: parsed.wsUrl, pid: parsed.pid };
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === 'EPERM';
	}
}

/**
 * 右栏模式的 target 管理：与 `CdpTargetManager` **同一套方法**（`CdpHost` 不用分支），但不建页、不关页、不分归属。
 */
export class RightbarTargetManager {
	constructor(conn, logger) {
		this._conn = conn;
		this._logger = logger;
		this._sessions = new Map();
		this.rightbar = true;
	}

	get ownedCount() { return 0; }
	ownedCountOf() { return 0; }
	/** 右栏的页不归任何会话 ⇒ 会话结束不回收任何东西。 */
	ownedTargetsOf() { return []; }

	async list() {
		const res = await this._conn.send('Target.getTargets');
		const infos = Array.isArray(res?.targetInfos) ? res.targetInfos : [];
		return infos
			.filter(t => t?.type === 'page')
			.map(t => ({ targetId: String(t?.targetId ?? ''), url: String(t?.url ?? ''), title: String(t?.title ?? ''), type: 'page' }))
			.filter(t => !!t.targetId);
	}

	async ensureSession(targetId) {
		const cached = this._sessions.get(targetId);
		if (cached) { return cached; }
		const res = await this._conn.send('Target.attachToTarget', { targetId, flatten: true });
		const sessionId = res?.sessionId;
		if (!sessionId) { throw new Error('Target.attachToTarget returned no sessionId'); }
		this._sessions.set(targetId, sessionId);
		return sessionId;
	}

	forgetTarget(targetId) { this._sessions.delete(targetId); }
	clearSessions() { this._sessions.clear(); }

	/** 右栏那一页（可见的排最前，中转已排好序）；`url` 不用于建页 —— 导航由调用方 `Page.navigate` 做。 */
	/** 右栏一页都没有 ⇒ 请中转建隐藏的共享视图（2026-11-07）。建不了 ⇒ 抛错（调用方回到 Chrome）。 */
	async ensureView() {
		const res = await this._conn.send(RIGHTBAR_ENSURE_PAGE_METHOD, {}, undefined, ENSURE_PAGE_TIMEOUT_MS);
		if (res?.created) { this._logger?.info?.('[vssaros-browser] 右栏还没有浏览器视图 ⇒ 已在右栏建一个（隐藏；打开右栏「浏览器」页签就能看到）'); }
		return res;
	}

	async ensurePage(_url, ownerKey) {
		let [page] = await this.list();
		if (!page) {
			await this.ensureView().catch(() => undefined);
			[page] = await this.list();
		}
		if (!page) {
			throw new Error('右栏浏览器没有打开（没有可操作的页面）：在右栏打开「浏览器」页签后重试');
		}
		const sessionId = await this.ensureSession(page.targetId);
		// ★ 2026-11-07（真机）：右栏页签开着但还没打开过网页时，视图的地址是空的、**没有渲染进程** ——
		//   浏览器层的命令（getNavigationHistory）照回，渲染层的（Runtime.evaluate / getLayoutMetrics）一律不回、
		//   每条等满超时。先导航一次 about:blank 把渲染进程拉起来（本来就是空白页，人看到的不变）。
		if (!page.url) {
			try { await this._conn.send('Page.navigate', { url: 'about:blank' }, sessionId, 10_000); } catch { /* 下一条命令会如实报错 */ }
			page.url = 'about:blank';
		}
		return { targetId: page.targetId, sessionId, url: page.url, ...(ownerKey ? { owner: ownerKey } : {}), reused: true, rightbar: true };
	}

	async closeOwned(targetId) {
		throw new Error(`拒绝关闭 ${targetId}：那是右栏里人正在看的页面`);
	}
}
