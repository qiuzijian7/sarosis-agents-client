// @vssaros/dsh-workbenches — 工作台宿主（服务端半）。
//
// doc/workbench-refactor-plan.md §4.1 路线 B：与 dsh-desktop 官方宿主 `dsh-desktop-workbenches`
// **同名同形**的兼容宿主。服务端照搬官方 `index.js` 里与市场无关的部分（MIT，见 THIRD_PARTY.md）：
//   · 只读归属服务 `desktopWorkbenchOwnership.read() → { revision, sessionBindings, added }`
//     （业务插件判断"这个会话是不是我的"用它；**不许**另开一套设置命名空间来授权会话）；
//   · `GET  /api/vssaros-workbenches/state`        读 state.json（含 revision）；
//   · `POST /api/vssaros-workbenches/state/write`  带 revision 写入（乐观锁 409 / 校验 400 / 损坏 500）。
// 不搬：市场目录 / 安装 / 投稿状态 / 文档路由（P4 再做，见方案 §6）。
//
// ⚠ 为什么路由前缀不是官方的 `/api/desktop-workbenches/`：官方宿主万一也被装进同一 profile，
//   同一路由会"谁先注册谁赢"静默打架。服务名同官方（业务插件代码零改动可移植），路由各用各的。

import { createStateStore, MAX_STATE_BYTES, StateError } from './state.js';

export const name = 'vssaros-workbenches';
/** 没有硬依赖：connection 走可选注入（同 scheduler / sessions 口径：非 web 模板里不让整包 pending）。 */
export const inject = [];

const PREFIX = '/api/vssaros-workbenches';
const NO_STORE = { 'cache-control': 'no-store' };

async function readPayload(request, maximum = MAX_STATE_BYTES) {
	const contentLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > maximum) { throw new StateError('工作台状态太大。', 413); }
	const reader = request.body?.getReader();
	if (!reader) { throw new StateError('需要 JSON 请求体。'); }
	const chunks = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }
			length += value.length;
			if (length > maximum) {
				await reader.cancel();
				throw new StateError('工作台状态太大。', 413);
			}
			chunks.push(value);
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch {
			throw new StateError('请求体不是合法 JSON。');
		}
	} finally {
		reader.releaseLock();
	}
}

const failure = error => Response.json(
	{ error: error instanceof StateError ? error.message : '读写工作台状态失败。' },
	{ status: error instanceof StateError ? error.status : 500, headers: NO_STORE },
);

export function apply(ctx, config) {
	const root = typeof config?.root === 'string' && config.root.trim() ? config.root.trim() : '';
	if (!root) {
		// 没给数据目录 = 组合写错了 ⇒ 如实报错，不猜一个目录去写（写错位置比不写更糟）。
		try { (typeof ctx.logger === 'function' ? ctx.logger('vssaros-workbenches') : console).warn('config.root 为空：工作台状态不可用（检查 cordis.patch.yml 的 dshHomePath）'); } catch { /* 探针假 ctx */ }
		return;
	}
	const store = createStateStore(root);
	ctx.effect(() => ctx.reflect.provide('desktopWorkbenchOwnership', {
		async read() {
			const { revision, state } = await store.read();
			return { revision, sessionBindings: { ...state.sessionBindings }, added: [...state.added] };
		},
	}));
	// ⚠ 必须把 `webServer` 一起 inject：只 inject `connection` 时，子 ctx 上没有 `webServer`
	//   ⇒ `/link` 里 `ctx.webServer.port` 是 undefined ⇒ origin 拼成 `http://127.0.0.1:undefined`
	//   ⇒ `new URL()` 抛错 ⇒ 路由 500 ⇒ 前端回落成「无 token 链接」⇒ 浏览器报
	//   `dsh web authentication required`（2026-10-26 真机，绕了两轮才定位到）。
	ctx.inject(['connection', 'webServer'], webCtx => registerRoutes(webCtx, store));
}

/**
 * 外开链接的 origin。
 *
 * ⚠ 2026-10-26 真机 bug：曾用 `new URL(request.url, 'http://dsh.internal')` 的 host 当 origin，
 *   而 `request.url` 是相对路径 ⇒ 兜底串 `dsh.internal` 变成真实域名 ⇒
 *   外开打开 `http://dsh.internal/?token=…`，浏览器报「站点无法访问 / DNS_PROBE_FINISHED_NXDOMAIN」。
 *
 * 正确来源：① 请求的 Host 头（用户可能是 localhost / 自定义域名）
 *          ② 该头缺失或仍是内部占位名 ⇒ 回落到 `127.0.0.1:<webServer.port>`
 * dsh 与本机浏览器同机，回环地址永远可达。
 */
export function resolveOrigin(hostHeader, port) {
	const host = String(hostHeader || '').trim();
	if (host && !/^dsh\.internal(:|$)/i.test(host)) { return `http://${host}`; }
	return `http://127.0.0.1:${port}`;
}

/**
 * 综合决定外开链接的 origin（**客户端上报优先**）。
 *
 * ⚠ 2026-10-26 真机 500：`/link` 曾用 `ctx.webServer.port` 兜底，但
 *   `ctx.inject(['connection'])` 拿到的子 ctx **没有 webServer** ⇒ port 是 undefined
 *   ⇒ origin 变成 `http://127.0.0.1:undefined` ⇒ `new URL()` 抛错 ⇒ 500（前端回落成无 token 链接 ⇒ 401）。
 *
 * 现在的优先级：
 *   ① 浏览器上报的 `origin`（同源请求，最可信；dsh 里一定有）
 *   ② 请求的 Host 头（真实地址时）
 *   ③ 回环 + 端口（只有拿到有效端口才用，否则抛明确错误）
 */
export function pickOrigin(claimed, hostHeader, port) {
	for (const raw of [claimed, hostHeader]) {
		const v = String(raw || '').trim();
		if (!v) { continue; }
		const withScheme = /^https?:\/\//i.test(v) ? v : `http://${v}`;
		try {
			const u = new URL(withScheme);
			if (!/^dsh\.internal$/i.test(u.hostname)) { return `${u.protocol}//${u.host}`; }
		} catch { /* 试下一个 */ }
	}
	if (Number.isFinite(port)) { return `http://127.0.0.1:${port}`; }
	throw new Error('拿不到可用 origin：客户端未上报 origin，且本 ctx 无 webServer.port');
}

function registerRoutes(ctx, store) {
	ctx.connection.fetch.register({
		path: `${PREFIX}/state`,
		methods: ['GET'],
		requestBody: 'buffered',
		async fetch() {
			try {
				return Response.json(await store.read(), { headers: NO_STORE });
			} catch (error) {
				return failure(error);
			}
		},
	});
	/**
	 * ★ 2026-10-26「外开」用：返回**带 token** 的工作台深链。
	 *
	 * 为什么必须服务端给：`?token=` 只在"还没有有效 Cookie"时用，认证完会换成 Cookie。
	 * 外开是**另一个浏览器**（没有那份 Cookie），若只拿 `location.search` 里的 token
	 * （认证后早被消费掉）⇒ 打开就是 401/空白（真机 bug：编辑器里显示内容为空）。
	 * `connection.authenticatedUrl()` 会附上**当前进程的新 token**，直接可用。
	 */
	ctx.connection.fetch.register({
		path: `${PREFIX}/link`,
		methods: ['GET'],
		requestBody: 'buffered',
		async fetch(request) {
			try {
				const reqUrl = new URL(request.url, 'http://dsh.internal');
				const wb = String(reqUrl.searchParams.get('wb') || '').trim();
				if (!wb) {
					return Response.json({ error: 'missing-wb' }, { status: 400, headers: NO_STORE });
				}
				/* ⚠ 2026-10-26 真机 bug：**不能用 `new URL(request.url, 'http://dsh.internal')` 的 host**。
				   `request.url` 是相对路径 ⇒ 兜底串 `dsh.internal` 会变成真实 origin，
				   外开就打开 `http://dsh.internal/?token=…`（ERR_NAME_NOT_RESOLVED / 站点无法访问）。
				   正确来源（与 `vssaros-bridge` 同口径）：
				     ① 优先用请求的 Host 头（用户可能用 localhost / 自定义域名访问）
				     ② 该头缺失或仍是内部占位名 ⇒ 回落到 `127.0.0.1:<webServer.port>`
				   dsh 与本机浏览器同机，回环地址永远可达。 */
				let hostHeader = '';
				try { hostHeader = String(request.headers.get('host') || '').trim(); } catch (e) { hostHeader = ''; }
				const claimed = String(reqUrl.searchParams.get('origin') || '').trim();
				const port = ctx.webServer && ctx.webServer.port;
				const origin = pickOrigin(claimed, hostHeader, port);
				const base = ctx.connection.authenticatedUrl(origin + '/');
				// `alone=1`：告诉前端「这是外开，只显示工作台」⇒ 进入后收起左侧会话栏
				return Response.json({ url: base + '#wb=' + encodeURIComponent(wb) + '&alone=1', origin }, { headers: NO_STORE });
			} catch (error) {
				// ⚠ 这里不能复用通用的 failure()（文案是"读写工作台状态失败"，会掩盖真实原因）
				return Response.json({
					error: String((error && error.message) || error || 'unknown'),
					hasWebServer: !!(ctx && ctx.webServer),
					port: ctx && ctx.webServer && ctx.webServer.port,
				}, { status: 500, headers: NO_STORE });
			}
		},
	});
	ctx.connection.fetch.register({
		path: `${PREFIX}/state/write`,
		methods: ['POST'],
		requestBody: 'buffered',
		async fetch(request) {
			try {
				return Response.json(await store.write(await readPayload(request)), { headers: NO_STORE });
			} catch (error) {
				return failure(error);
			}
		},
	});
}
