/*---------------------------------------------------------------------------------------------
 *  dshHostHttp.ts — 「IDE → dsh Host」的 HTTP 客户端（2026-10-26）。
 *
 *  背景：媒体库真源已在 dsh 侧（`{dataRoot}/media-store/`），但 **ComfyUI / 工作流的产出是 IDE 侧
 *  写进主进程 `MediaStore` 的**（`media.import` → `mediaStoreChannel`）。以前靠 dsh 的 `ideSync`
 *  在"打开页面 / 显式 sync"时**拉**过去 ⇒ 页面开着时新图不会自动出现，且真源里迟迟没有。
 *  这条客户端把"推"补上：主进程写完自己的库之后，**再 POST 一份**给 `/x/media/api/import`。
 *
 *  为什么不复用别的通道：
 *   · 命名管道那条是 **dsh 自己实现的固定协议**（hello / lease / bridge），插件侧无法加动词；
 *   · 渲染进程的 fetch 拿不到 dsh 的 cookie（它在各 `WebContentsView` 的独立分区里）。
 *  ⇒ 只有"主进程 + 认证 cookie"这条路可行。
 *
 *  ⚠ 认证 cookie **约 3 分钟过期**（`dshViewHost` 里也有同款续期逻辑）⇒ 这里自己做一份带 TTL 的
 *    缓存，并在 401/403 时**有界重试一次**（刷新 cookie 再打）。
 *  ⚠ 一切失败都只返回结果 / 记日志：**绝不抛给调用方**（IDE 侧写入是主路径，不能被 dsh 拖下水）。
 *--------------------------------------------------------------------------------------------*/

export interface IDshHostConnection {
	readonly origin: string;
	readonly authUrl: string;
}

export interface IDshHostHttpLog {
	info(message: string): void;
	warn(message: string): void;
}

export interface IDshHostHttpReply {
	/** HTTP 2xx */
	readonly ok: boolean;
	/** 0 = 没发出请求（Host 没起 / 连不上 / 超时） */
	readonly status: number;
	readonly text: string;
}

/** cookie 的默认寿命（秒）：dsh 的认证 cookie 实测约 3 分钟，拿不到 Max-Age 时按它算。 */
const DEFAULT_COOKIE_TTL_S = 180;
/** 提前多少秒续期（别等真的过期那一刻才换，请求正好卡在边界上会白丢一次）。 */
const COOKIE_RENEW_MARGIN_S = 20;

/** 从 `set-cookie` 头里读 TTL（秒）：`Max-Age` 优先，其次 `Expires`，都没有就用默认值。 */
export function cookieTtlSeconds(setCookieHeader: string, now = Date.now()): number {
	const maxAge = /max-age\s*=\s*(\d+)/i.exec(setCookieHeader);
	if (maxAge) {
		const seconds = Number(maxAge[1]);
		if (Number.isFinite(seconds) && seconds > 0) { return seconds; }
	}
	const expires = /expires\s*=\s*([^;]+)/i.exec(setCookieHeader);
	if (expires) {
		const at = Date.parse(expires[1].trim());
		if (Number.isFinite(at)) {
			const seconds = Math.round((at - now) / 1000);
			if (seconds > 0) { return seconds; }
		}
	}
	return DEFAULT_COOKIE_TTL_S;
}

/** `set-cookie` → `name=value`（只要第一段；HttpOnly/Path/SameSite 这些对本客户端没用）。 */
export function cookiePairOf(setCookieHeader: string): string {
	const first = String(setCookieHeader).split('\n')[0] ?? '';
	const pair = first.split(';')[0]?.trim() ?? '';
	return pair.includes('=') ? pair : '';
}

/**
 * 带认证 cookie 缓存的 Host HTTP 客户端（目前只用到 POST JSON，够用就好）。
 *
 * 用法：`new DshHostHttp(() => this._supervisor.connection, log)`；连接是**每次现取**的
 * （Host 会重启换端口，缓存 connection 必然打到旧端口 ✗）。
 */
export class DshHostHttp {

	private _cookie = '';
	private _cookieDeadline = 0;
	private _inflightAuth: Promise<boolean> | undefined;

	constructor(
		private readonly _connection: () => IDshHostConnection | undefined,
		private readonly _log: IDshHostHttpLog,
	) { }

	/** 当前是否"看起来"有一条可用连接（Host 起了）。不保证认证成功。 */
	get hasConnection(): boolean {
		return !!this._connection();
	}

	/**
	 * POST 一个 JSON 到 Host 的插件路由。
	 * @param path 站内绝对路径（如 `/x/media/api/import`）
	 * @param payload 会被 `JSON.stringify`
	 */
	async postJson(path: string, payload: unknown, timeoutMs = 20_000): Promise<IDshHostHttpReply> {
		const body = JSON.stringify(payload ?? {});
		for (let attempt = 0; attempt < 2; attempt++) {
			// attempt 0：用缓存（必要时先换一次）；attempt 1：强制刷新 cookie（应对 401/403）
			const authed = await this._ensureCookie(attempt > 0);
			if (!authed) {
				return { ok: false, status: 0, text: 'dsh Host 未运行（没有连接信息）' };
			}
			const conn = this._connection();
			if (!conn) {
				return { ok: false, status: 0, text: 'dsh Host 未运行（连接已断开）' };
			}
			try {
				const res = await fetch(`${conn.origin}${path}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', cookie: this._cookie },
					body,
					signal: AbortSignal.timeout(timeoutMs),
				});
				const text = await res.text();
				if (res.status === 401 || res.status === 403) {
					// cookie 提前失效（Host 重启 / 换 token）⇒ 清掉缓存，下一轮强制刷新后再打一次
					this._cookie = '';
					this._cookieDeadline = 0;
					this._log.warn(`[dshHostHttp] ${path} 认证被拒（${res.status}），刷新 cookie 后重试一次`);
					continue;
				}
				return { ok: res.ok, status: res.status, text };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { ok: false, status: 0, text: `请求失败：${message}` };
			}
		}
		return { ok: false, status: 401, text: 'dsh Host 认证失败（两次都 401/403）' };
	}

	/**
	 * 保证手上有一枚没到期的 cookie。
	 * @param force true = 忽略缓存直接重换（401 之后走这条）
	 */
	private async _ensureCookie(force: boolean): Promise<boolean> {
		if (!force && this._cookie && Date.now() < this._cookieDeadline) { return true; }
		if (this._inflightAuth) { return this._inflightAuth; }   // 并发调用只换一次
		this._inflightAuth = this._fetchCookie(force).finally(() => { this._inflightAuth = undefined; });
		return this._inflightAuth;
	}

	private async _fetchCookie(force: boolean): Promise<boolean> {
		const conn = this._connection();
		if (!conn) {
			this._cookie = '';
			this._cookieDeadline = 0;
			return false;
		}
		try {
			// `redirect: 'manual'`：authUrl 是 `/?token=…`，正常回 303 + set-cookie；
			// 跟随后也没问题，但手动拿头更省一跳、也避免被重定向到认证失败的页面。
			const res = await fetch(conn.authUrl, { redirect: 'manual', signal: AbortSignal.timeout(8_000) });
			const raw = res.headers.get('set-cookie') ?? '';
			const pair = cookiePairOf(raw);
			if (!pair) {
				this._log.warn(`[dshHostHttp] authUrl 没给 set-cookie（HTTP ${res.status}）⇒ 本次推送跳过`);
				this._cookie = '';
				this._cookieDeadline = 0;
				return false;
			}
			const ttl = Math.max(COOKIE_RENEW_MARGIN_S + 10, cookieTtlSeconds(raw));
			this._cookie = pair;
			this._cookieDeadline = Date.now() + (ttl - COOKIE_RENEW_MARGIN_S) * 1000;
			this._log.info(`[dshHostHttp] 换到认证 cookie（TTL ${ttl}s${force ? '，强制刷新' : ''}）`);
			return true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this._log.warn(`[dshHostHttp] 换 cookie 失败：${message}`);
			this._cookie = '';
			this._cookieDeadline = 0;
			return false;
		}
	}
}
