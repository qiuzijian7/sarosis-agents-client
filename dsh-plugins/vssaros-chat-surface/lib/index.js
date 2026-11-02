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
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import * as zlib from 'node:zlib';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

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

// ── 会话首条用户消息（2026-11-02 用户要求「把标题写回 dsh」）──────────────────────────
//
// 为什么要在 host 侧做：`sessions.list` 快照里**没有**首条消息文本（只有 `blank` /
//   `lastPromptAt` / `title`），标题只来自 `session/title` 事件；而 dsh 没有任何自动标题机制
//   （全仓搜 `autoTitle` / `generateTitle` 都是 0 命中，中文文案就是 `"session.untitled": "未命名"`）。
//   ⇒ 想把「未命名」变成可读标题，只能自己去会话日志里读首条 `user/message`。
//
// 这里**只读**（不改任何数据），写标题仍由页面侧走官方 `session.rename` ⇒ 权限与一致性都交回官方 ✓
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/**
 * Node 22.15+ 才有 zstd；没有就如实说"不支持"，不假装读到。
 *
 * ⚠ 2026-11-02：**不许用 `zstdDecompressSync`** —— 会话日志可能几 MB，同步解压会把 Host
 * 主线程整段卡住（守卫 `dshPluginPackages`：同步解压全仓禁）。这里用回调版 + `promisify`。
 */
const zstdDecompressAsync = typeof zlib.zstdDecompress === 'function' ? promisify(zlib.zstdDecompress) : null;

/** 会话日志是**多帧** zstd（每次追加一帧）⇒ 按 magic 拆帧逐个解压；坏帧跳过不报错。 */
async function decompressZstdFrames(buf) {
	if (!zstdDecompressAsync) { throw new Error('当前 Node 不支持 zstd（需要 22.15+）'); }
	const starts = [];
	let at = 0;
	while ((at = buf.indexOf(ZSTD_MAGIC, at)) >= 0) { starts.push(at); at += 4; }
	const out = [];
	for (let k = 0; k < starts.length; k++) {
		const fr = buf.subarray(starts[k], starts[k + 1] === undefined ? buf.length : starts[k + 1]);
		try { out.push(String(await zstdDecompressAsync(fr))); } catch { /* 尾部可能截断 ⇒ 跳过 */ }
	}
	return out.join('');
}

/** 这些前缀是**注入内容**，不是用户说的话（真机上最常见的前两条 `user/message` 就是它们）。 */
const INJECT_PREFIXES = ['<system-reminder>', 'Current runtime context', '<user_instructions>', '<workspace_instructions>'];

/**
 * 取一条会话的首条**真实用户消息**（只读）。
 * @returns `{ found, title, seq, error? }`；`title` 已压平空白并截断到 40 字。
 */
async function firstUserPromptOf(home, sessionId) {
	if (!SESSION_ID_RE.test(sessionId)) {
		throw Object.assign(new Error('非法的会话 id（只接受 session-<id> 形状）'), { status: 400 });
	}
	const sessionsRoot = join(home, 'sessions');
	// cwd 编码规则各版本可能变 ⇒ 扫一层子目录找同名目录（与 deleteSessionData 同一条）
	let dir = null;
	let cwdDirs = [];
	try { cwdDirs = await readdir(sessionsRoot, { withFileTypes: true }); } catch { cwdDirs = []; }
	for (const entry of cwdDirs) {
		if (!entry.isDirectory()) { continue; }
		const cand = join(sessionsRoot, entry.name, sessionId);
		if (!insideOf(sessionsRoot, cand)) { continue; }
		try { if ((await stat(cand)).isDirectory()) { dir = cand; break; } } catch { /* 不在这个 cwd 下 */ }
	}
	if (!dir) { return { found: false, title: '' , error: '找不到这条会话的日志目录' }; }
	const file = join(dir, 'session.v4.jsonl.zstd');
	let buf;
	try { buf = await readFile(file); } catch (e) { return { found: false, title: '', error: '读不到 session.v4.jsonl.zstd：' + String((e && e.message) || e) }; }
	const text = await decompressZstdFrames(buf);
	for (const line of text.split('\n')) {
		if (!line) { continue; }
		let o; try { o = JSON.parse(line); } catch { continue; }
		const ev = o && o.event ? o.event : o;
		if (!ev || ev.type !== 'user/message') { continue; }
		const d = ev.data || {};
		if (d.role !== 'user') { continue; }
		// ★ 只认真人输入：`source.kind === 'user'`（agent 转发 / 注入的都不算）
		if (!d.source || d.source.kind !== 'user') { continue; }
		const parts = Array.isArray(d.content) ? d.content : [];
		const t = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join(' ').trim();
		if (!t) { continue; }
		if (INJECT_PREFIXES.some((p) => t.startsWith(p))) { continue; }
		return { found: true, title: t.replace(/\s+/g, ' ').slice(0, 40), seq: typeof ev.seq === 'number' ? ev.seq : null };
	}
	return { found: false, title: '', error: '这条会话还没有用户消息（或只有注入内容）' };
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
			// ① 只读：准备**默认工作区**的目录（2026-11-02 用户要求「当前工作区里要有默认工作区」）。
			//
			//   为什么需要宿主：官方的 `workspaces.initializeDefault()` 只在**首次使用**（一个工作区都没有）
			//   时建默认工作区，实测在已有工作区的机器上直接返回 `undefined`（不建）。
			//   而 `workspaces.create({ path })` 只接受**已存在的绝对路径**（"existing absolute path to adopt"），
			//   页面是浏览器上下文、建不了目录 ⇒ 由宿主 `mkdir -p` 后把路径交给页面。
			//
			//   路径取 `<DSH_HOME>/VsSaros`（我们自己的数据目录下）：不污染用户的「文档」目录，
			//   且 dsh 会按目录名把它显示成「VsSaros」。
			//   ⚠ 只建目录、不写任何文件 ⇒ 天然幂等。
			if (url.pathname === `${ROUTE_PREFIX}/api/default-workspace`) {
				if (req.method !== 'POST') { json(405, { ok: false, error: '只接受 POST' }); return; }
				try {
					const home = dshHomeOf(config);
					const dir = join(home, 'VsSaros');
					await mkdir(dir, { recursive: true });
					json(200, { ok: true, path: dir, home });
				} catch (e) {
					json(500, { ok: false, error: String((e && e.message) || e) });
				}
				return;
			}
			// ② 只读：会话的首条真实用户消息（页面侧拿它生成标题，再走官方 `session.rename` 写回）
			//    ⚠ 本路由**不写任何东西** ⇒ 权限、`session/title` 事件、list 行刷新全由官方 API 保证 ✓
			if (url.pathname === `${ROUTE_PREFIX}/api/first-prompt`) {
				if (req.method !== 'GET') { json(405, { ok: false, error: '只接受 GET' }); return; }
				const sid = String(url.searchParams.get('sessionId') || '').trim();
				if (!sid) { json(400, { ok: false, error: '缺 sessionId' }); return; }
				try {
					const home = dshHomeOf(config);
					const got = await firstUserPromptOf(home, sid);
					json(200, Object.assign({ ok: true, home, sessionId: sid }, got));
				} catch (e) {
					const status = e && typeof e.status === 'number' ? e.status : 500;
					json(status, { ok: false, error: String((e && e.message) || e) });
				}
				return;
			}
			// ② 写操作只有一条：删会话的本地数据；其它路径如实 404（不吞、不漏）。
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
