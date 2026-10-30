// @vssaros/dsh-chat-surface — host half.
//
// 从前这里是**纯 inert**（页面侧不需要宿主能力）。2026-10-30 起多了**一条**能力：
// 会话的**真删除**（用户要求「右键菜单增加删除按钮」）。
//
// ── 为什么"删除"必须落在宿主侧 ────────────────────────────────────────────────
// dsh 官方**没有删除会话的 API**（`deleteSession` / `removeSession` / `session/delete` 在
// 客户端与 host 包里 0 命中）——它只有 `archive`（归档 = 从列表移除，数据仍在）。
// 而用户要的是"点了就别再出现"，且明确与「归档」并列 ⇒ 删除必须真删磁盘：
//   · `<DSH_HOME>/sessions/<cwd 编码>/<sessionId>/`（会话日志，zstd）
//   · `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`（列表用的投影缓存）
// 页面是浏览器上下文（没有文件系统），所以只能经宿主。
//
// ── 安全边界（这条路由是**写**操作，必须钉死）────────────────────────────────
// ① 会话 id 白名单 `^session-[A-Za-z0-9][A-Za-z0-9_-]{6,}$` ⇒ 从根上排除 `..` / 绝对路径 / 盘符；
// ② 每个待删路径都 `resolve` 后校验**确实在以 DSH_HOME 下 sessions 目录为前缀**（防符号链接绕出）；
// ③ 只删"名字等于会话 id 的那一层目录"，**从不递归删父目录**、从不按通配删；
// ④ 请求必须过 `connection.requestRejection(req)`（与其它页面路由同一条围栏）；
// ⑤ body 上限 4KB（这里只需要一个 id）。
//
// ⚠ `webServer` / `connection` **不许**写进静态 inject：它们只在 web 模板里存在，
//   写死会让插件在 headless/tui profile 永久 pending（见 `vssaros-dashboard/lib/index.js:26-29`）⇒ 走 `ctx.inject`。
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const name = 'vssaros-chat-surface';

/** 本插件挂在自己前缀下（与 `vssaros-sessions` 的 `/x/sessions` 同形，互不重叠）。 */
const ROUTE_PREFIX = '/x/chat-surface';
/** 只认 dsh 自己的会话 id 形状（`session-<uuid>` / `session-<uuid>--preset` 之类都过）。 */
const SESSION_ID_RE = /^session-[A-Za-z0-9][A-Za-z0-9_-]{6,}$/;
/** 请求体上限（只需 `{"sessionId":"…"}`）。 */
const BODY_LIMIT = 4096;

/**
 * DSH_HOME：`config.dshHome` → `env.DSH_HOME` → `~/.dsh`（与 `vssaros-sessions/lib/store.js` 同一条链，
 * 但本插件**不**依赖 `@vssaros/dsh-foundation`：那是可选服务，缺席时也要能删）。
 */
function dshHomeOf(config) {
	const fromConfig = config && typeof config.dshHome === 'string' ? config.dshHome.trim() : '';
	if (fromConfig) { return fromConfig; }
	const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
	if (fromEnv) { return fromEnv; }
	return join(homedir(), '.dsh');
}

/** 读请求体（超限直接拒绝，不缓存大 payload）。 */
function readBody(req) {
	return new Promise((ok, bad) => {
		const chunks = [];
		let size = 0;
		req.on('data', (c) => {
			size += c.length;
			if (size > BODY_LIMIT) {
				bad(new Error('请求体过大'));
				try { req.destroy(); } catch { /* 已经断了 */ }
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => { ok(Buffer.concat(chunks).toString('utf8')); });
		req.on('error', (e) => { bad(e); });
	});
}

/** 路径是否**确实**落在 root 之内（`root` 自身不算）。 */
function insideOf(root, target) {
	const base = resolve(root);
	const full = resolve(target);
	return full.length > base.length && full.startsWith(base + sep);
}

/**
 * 删一条会话的本地数据。
 * @returns `{ removed: string[], missing: string[] }`（都相对 DSH_HOME，便于回显；不含绝对路径细节之外的信息）
 */
async function deleteSessionData(home, sessionId) {
	if (!SESSION_ID_RE.test(sessionId)) {
		throw Object.assign(new Error('非法的会话 id（只接受 dsh 自己的 session-<id> 形状）'), { status: 400 });
	}
	const removed = [];
	const missing = [];
	// ① 会话日志目录：`<home>/sessions/<cwd 编码>/<sessionId>/`
	//    ⚠ cwd 的编码规则**不自己猜**（`--G-WS-x--` 这种形态各版本可能变）⇒ 扫一层子目录找同名目录。
	const sessionsRoot = join(home, 'sessions');
	let cwdDirs = [];
	try { cwdDirs = await readdir(sessionsRoot, { withFileTypes: true }); } catch { cwdDirs = []; }
	for (const entry of cwdDirs) {
		if (!entry.isDirectory()) { continue; }
		const target = join(sessionsRoot, entry.name, sessionId);
		if (!insideOf(sessionsRoot, target)) { continue; }
		let info = null;
		try { info = await stat(target); } catch { info = null; }
		if (!info || !info.isDirectory()) { continue; }
		await rm(target, { recursive: true, force: true });
		removed.push(join('sessions', entry.name, sessionId));
	}
	// ② 投影缓存文件（列表就是用它的 mtime 排序的）
	const cacheDir = join(home, 'storages', 'session_projcache', 'sessions');
	const cacheFile = join(cacheDir, sessionId + '.json');
	if (insideOf(cacheDir, cacheFile)) {
		let info = null;
		try { info = await stat(cacheFile); } catch { info = null; }
		if (info && info.isFile()) {
			await rm(cacheFile, { force: true });
			removed.push(join('storages', 'session_projcache', 'sessions', sessionId + '.json'));
		}
	}
	if (removed.length === 0) { missing.push(sessionId); }
	return { removed, missing };
}

export function apply(ctx, config) {
	// 页面路由（**可选**依赖；不在 web 模板 ⇒ 只是没有这条 API，不影响插件激活）
	ctx.inject(['webServer', 'connection'], (page) => page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const json = (status, body) => {
				res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				res.end(JSON.stringify(body));
			};
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			// 只提供一条写操作；其它路径如实 404（不吞、不漏）。
			if (url.pathname !== `${ROUTE_PREFIX}/api/delete-session`) {
				json(404, { ok: false, error: 'unknown route' });
				return;
			}
			if (req.method !== 'POST') {
				json(405, { ok: false, error: '只接受 POST' });
				return;
			}
			try {
				const raw = await readBody(req);
				let body = null;
				try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
				const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
				if (!sessionId) { json(400, { ok: false, error: '缺 sessionId' }); return; }
				const home = dshHomeOf(config);
				const result = await deleteSessionData(home, sessionId);
				json(200, {
					ok: true,
					home,
					sessionId,
					removed: result.removed,
					missing: result.missing,
					// 一个都没删到 ⇒ 页面要能说清"没找到"（而不是假装删掉了 ✗）
					found: result.removed.length > 0,
				});
			} catch (e) {
				const status = e && typeof e.status === 'number' ? e.status : 500;
				json(status, { ok: false, error: String((e && e.message) || e) });
			}
		},
	}), 'vssaros-chat-surface: delete-session route'));
}
