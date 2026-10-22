/**
 * 画布路由：画布页本体 + 它的静态资源（Excalidraw 产物）+ 画布状态（推/拉）。
 *
 * 为什么画布页是**插件页**而不是 dsh 客户端页：画布引擎产物 3.4MB ⇒ 放进 dsh 客户端包
 * 就等于"每个聊天框都加载 3.4MB"（tldraw 被否掉的同一个坑）⇒ 独立 webview，按需加载。
 *
 * 鉴权：走官方 `connection.requestRejection(req)`（与 kb / sessions 等插件页同口径 ✓）——
 *   dsh 的 webServer **不提供**服务器级认证（官方文档明说），路由 owner 必须自己实施。
 *
 * 静态资源：从插件目录 `lib/canvas/**` 读（**路径穿越防护**：解析后必须在 canvas 目录内）。
 *   产物 3.4MB ⇒ 首次读进内存缓存（每次请求读盘会把 Host 拖慢）。
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { CANVAS_PAGE_ROUTE, CANVAS_ROUTE_PREFIX, CANVAS_STATE_ROUTE } from './canvasState.js';
import { CANVAS_IMAGE_ROUTE, CANVAS_IMAGES_ROUTE } from './canvasState.js';
import { CANVAS_GRAPH_EXPORT_ROUTE, CANVAS_GRAPH_IMPORT_ROUTE, CANVAS_GRAPH_ROUTE } from './canvasState.js';
import { fromJsonCanvas, toJsonCanvas } from './canvasGraph.js';
import { handleStudioApi } from './studioApi.js';

/** 画布目录（插件包内）。 */
const CANVAS_DIR = fileURLToPath(new URL('./canvas/', import.meta.url));
/** 插件 lib 目录（生图工作台页的静态资源从这里读）。 */
const LIB_DIR = fileURLToPath(new URL('./', import.meta.url));
/** 承载面归一（规范 4.1/9：未知值 => 完整页）。 */
function normalizeSurface(value) {
	const text = String(value || '').trim();
	if (text === 'sideview' || text === 'editor') { return text; }
	return 'full';
}
/**
 * 读生图工作台页的静态资源（page.js / views/**）。
 * views/** 走 lib 根，其余走 lib/studio/（页面 HTML 与 page.js 同目录 => 相对引用才成立）。
 * 路径穿越防护：解析后必须仍在对应根内。
 */
function readStudioAsset(rel) {
	const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
	if (!clean || clean.includes('..') || clean.includes('\0')) { return undefined; }
	const underViews = clean.startsWith('views/');
	const root = underViews ? LIB_DIR : join(LIB_DIR, 'studio');
	const target = join(root, clean);
	if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) { return undefined; }
	try {
		const stat = statSync(target);
		if (!stat.isFile()) { return undefined; }
		const bytes = readFileSync(target);
		const dot = target.lastIndexOf('.');
		const type = CONTENT_TYPES[target.slice(dot)] || 'application/octet-stream';
		return { bytes, type };
	} catch {
		return undefined;
	}
}
/** 静态资源缓存：asset → { bytes, type }。 */
const assetCache = new Map();
/** 状态 POST 的请求体上限（场景里有图，dataURL 会很大）。 */
const MAX_STATE_BYTES = 12 * 1024 * 1024;

const CONTENT_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
};

/** 读一个静态资源（带缓存）；路径穿越 ⇒ undefined。 */
function readAsset(asset) {
	const clean = String(asset || '').replace(/\\/g, '/').replace(/^\/+/, '');
	if (!clean || clean.includes('..') || clean.includes('\0')) { return undefined; }
	const target = resolve(join(CANVAS_DIR, normalize(clean)));
	// 解析后必须仍在 canvas 目录内（双保险：上面已经滤了 '..'）。
	if (target !== CANVAS_DIR && !target.startsWith(CANVAS_DIR.endsWith(sep) ? CANVAS_DIR : CANVAS_DIR + sep)) {
		return undefined;
	}
	const cached = assetCache.get(target);
	if (cached) { return cached; }
	try {
		const stat = statSync(target);
		if (!stat.isFile()) { return undefined; }
		const bytes = readFileSync(target);
		const dot = target.lastIndexOf('.');
		const type = CONTENT_TYPES[dot >= 0 ? target.slice(dot) : ''] || 'application/octet-stream';
		const entry = { bytes, type };
		assetCache.set(target, entry);
		return entry;
	} catch {
		return undefined;
	}
}

/** 画布页 HTML（也缓存：小文件，但每次读盘没必要）。 */
function readCanvasHtml() {
	return readAsset('index.html');
}

function sendBytes(res, status, bytes, type) {
	res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
	res.end(bytes);
}

function sendJson(res, status, payload) {
	sendBytes(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

/**
 * 读请求体（JSON 文本）。
 * @returns {Promise<{raw: string, error?: string}>}
 */
async function readBody(req, limit = MAX_STATE_BYTES) {
	let raw = '';
	try {
		for await (const chunk of req) {
			raw += chunk;
			if (raw.length > limit) {
				return { raw: '', error: '请求体太大' };
			}
		}
	} catch (e) {
		return { raw: '', error: String((e && e.message) || e) };
	}
	return { raw };
}

/**
 * 注册画布路由。
 * @param {object} ctx 插件 ctx
 * @param {object} state 宿主侧状态（`state.canvas` = 画布镜像）
 */
export function registerCanvasRoutes(ctx, state) {
	// webServer / connection 都是**可选**注入：headless profile 没有 webServer ⇒ 只少画布页面。
	ctx.inject(['webServer', 'connection'], scope => scope.effect(() => scope.webServer.register({
		kind: 'prefix',
		path: CANVAS_ROUTE_PREFIX,
		handler: async (req, res) => {
			// ① 鉴权：官方连接服务的拒绝策略（没有它 = 本机任何进程都能读写画布 ✗）。
			const rejected = scope.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			let url;
			try {
				url = new URL(req.url || '/', 'http://localhost');
			} catch {
				res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
				res.end('URL 解析失败');
				return;
			}
			const pathname = url.pathname;

			// ② 画布状态：画布页推（POST）/ 拉（GET）。
			if (pathname === CANVAS_STATE_ROUTE) {
				if (req.method === 'POST') {
					let raw = '';
					try {
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > MAX_STATE_BYTES) {
								sendJson(res, 413, { ok: false, error: '画布状态太大（场景里有图）' });
								return;
							}
						}
					} catch (e) {
						sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
						return;
					}
					let payload;
					try {
						payload = JSON.parse(raw || '{}');
					} catch {
						sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
						return;
					}
					const applied = state.canvas?.apply?.(payload) === true;
					sendJson(res, 200, { ok: true, applied });
					return;
				}
				const entry = state.canvas?.latest?.();
				if (!entry) {
					sendJson(res, 200, { ok: true, connected: false, scene: null });
					return;
				}
				sendJson(res, 200, {
					ok: true,
					connected: true,
					elementCount: entry.elementCount,
					selectedIds: entry.selectedIds,
					selection: entry.selection,
					scene: entry.scene,
					sceneOmitted: entry.sceneOmitted,
					// ★ 节点工作流模式：画布页要知道自己处在哪个模式、选中的是哪个节点。
					mode: entry.mode,
					selectedNodeId: entry.selectedNodeId,
					graphRevision: state.canvasGraph?.getRevision?.() ?? 0,
				});
				return;
			}

			// ②d **节点图**（节点工作流模式）：推（POST）/ 拉（GET）/ 导入 / 导出。
			//     与自由绘制的"场景"是两条独立通道（互不覆盖 ⇒ 切模式不丢东西 ✓）。
			if (pathname === CANVAS_GRAPH_ROUTE) {
				const store = state.canvasGraph;
				if (req.method === 'POST') {
					const body = await readBody(req);
					if (body.error) {
						sendJson(res, 413, { ok: false, error: body.error });
						return;
					}
					let payload = {};
					try {
						payload = JSON.parse(body.raw || '{}');
					} catch {
						sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
						return;
					}
					if (!store) {
						sendJson(res, 503, { ok: false, error: '节点图仓库没装好' });
						return;
					}
					// baseRevision 对不上 ⇒ 合并（不丢任何一边）+ conflict 标记（要如实告诉用户）。
					const result = store.apply(payload?.graph, { baseRevision: payload?.baseRevision });
					sendJson(res, 200, {
						ok: true,
						revision: result.revision,
						conflict: result.conflict === true,
						// ★ 回传**合并后**的图：页面据此收敛（否则页面手上的图和宿主不一致 ⇒ 下次推又冲突 ✗）。
						graph: result.graph,
						nodes: result.graph.nodes.length,
						edges: result.graph.edges.length,
					});
					return;
				}
				const graph = store?.get?.() || { nodes: [], edges: [] };
				sendJson(res, 200, {
					ok: true,
					revision: store?.getRevision?.() ?? 0,
					conflict: store?.hasConflict?.() === true,
					graph,
					nodes: graph.nodes.length,
					edges: graph.edges.length,
				});
				return;
			}
			// ②e 导出 JSON Canvas 1.0（通用格式 ⇒ Obsidian Canvas / dsh-noteboard 互通）。
			if (pathname === CANVAS_GRAPH_EXPORT_ROUTE) {
				const graph = state.canvasGraph?.get?.() || { nodes: [], edges: [] };
				sendJson(res, 200, toJsonCanvas(graph));
				return;
			}
			// ②f 导入 JSON Canvas 1.0（外来文件 ⇒ 节点图）。
			if (pathname === CANVAS_GRAPH_IMPORT_ROUTE) {
				if (req.method !== 'POST') {
					sendJson(res, 405, { ok: false, error: '导入只认 POST' });
					return;
				}
				const body = await readBody(req);
				if (body.error) {
					sendJson(res, 413, { ok: false, error: body.error });
					return;
				}
				let payload;
				try {
					payload = JSON.parse(body.raw || '{}');
				} catch {
					sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
					return;
				}
				const graph = fromJsonCanvas(payload);
				const result = state.canvasGraph?.set?.(graph);
				sendJson(res, 200, {
					ok: true,
					revision: result?.revision ?? 0,
					nodes: graph.nodes.length,
					edges: graph.edges.length,
				});
				return;
			}

			// ②b 「最近出图」：画布页轮询（?since=<毫秒时间戳>）⇒ 生成结果自动落画布。
			//     图**本体**走另一个路由（②c）按 id 取字节 ⇒ 这里只回元信息 + 相对 URL。
			if (pathname === CANVAS_IMAGES_ROUTE) {
				const since = Number(url.searchParams.get('since') ?? 0) || 0;
				const items = (state.canvasImages?.since?.(since) ?? []).map(item => ({
					id: item.id,
					url: CANVAS_IMAGE_ROUTE + '/' + item.id,
					mimeType: item.mediaType,
					width: item.width, height: item.height,
					prompt: item.prompt,
					at: item.at,
				}));
				sendJson(res, 200, { ok: true, images: items });
				return;
			}

			// ②c 图字节：画布页拿到元信息后按 id 取图（base64 dataURL 塞给 Excalidraw 的 addFiles）。
			if (pathname.startsWith(CANVAS_IMAGE_ROUTE + '/')) {
				const id = decodeURIComponent(pathname.slice(CANVAS_IMAGE_ROUTE.length + 1));
				const item = state.canvasImages?.get?.(id);
				if (!item) {
					res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					res.end('这张图已经不在「最近出图」账本里了（只留最近 50 张）');
					return;
				}
				const attachments = state.attachments;
				if (!attachments || typeof attachments.readImage !== 'function') {
					res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
					res.end('attachments 服务不在（读不到图字节）');
					return;
				}
				try {
					// readImage 的返回形状：{ bytes } / { data } / 直接 Buffer —— 三种都认（别猜）。
					const raw = await attachments.readImage(item.attachment);
					const bytes = raw && raw.bytes ? raw.bytes : (raw && raw.data ? raw.data : raw);
					if (!bytes) {
						res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
						res.end('readImage 没给出字节');
						return;
					}
					sendBytes(res, 200, bytes, item.mediaType || 'image/png');
				} catch (e) {
					res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(String((e && e.message) || e));
				}
				return;
			}
			// ③ 生图工作台（`/x/imagegen/`）：**一个路由 + 三个承载面**（规范 4.1）。
			//    surface 由**服务端**注入 HTML 的 data 属性（探针要踩这两个锚点，规范 7.4）。
			//    ⚠ 路由尾斜杠：模块页表登记的是 `/x/imagegen/` ⇒ 这里两个形态都认。
			if (pathname === '/x/imagegen' || pathname === '/x/imagegen/') {
				const surface = normalizeSurface(url.searchParams.get('surface'));
				const html = readStudioAsset('index.html');
				if (!html) {
					res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					res.end('生图工作台页面文件缺失（lib/studio/index.html）');
					return;
				}
				const markup = String(html.bytes).replace('__SURFACE__', surface);
				sendBytes(res, 200, Buffer.from(markup, 'utf8'), 'text/html; charset=utf-8');
				return;
			}

			// ③b 生图工作台的 API（画廊 / 能力表 / 生成 / 批量 / 存盘）。
			if (pathname.startsWith('/x/imagegen/api/')) {
				const handled = await handleStudioApi(state, { pathname, req, res, url });
				if (handled) { return; }
			}

			// ③c 工作台页的静态资源（page.js / views/**）。
			if (pathname.startsWith('/x/imagegen/')
				&& !pathname.startsWith('/x/imagegen/canvas')
				&& !pathname.startsWith('/x/imagegen/api/')) {
				const rel = pathname.slice('/x/imagegen/'.length);
				const found = readStudioAsset(rel);
				if (!found) {
					res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					res.end('找不到这个资源：' + rel);
					return;
				}
				sendBytes(res, 200, found.bytes, found.type);
				return;
			}

			// ④ 画布页 HTML。
			if (pathname === CANVAS_PAGE_ROUTE || pathname === CANVAS_PAGE_ROUTE.replace(/\/$/, '')) {
				const html = readCanvasHtml();
				if (!html) {
					res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					res.end('画布页文件缺失（lib/canvas/index.html）');
					return;
				}
				sendBytes(res, 200, html.bytes, html.type);
				return;
			}

			// ⑤ 画布页的静态资源（Excalidraw 产物）。
			if (pathname.startsWith(CANVAS_PAGE_ROUTE)) {
				const asset = pathname.slice(CANVAS_PAGE_ROUTE.length);
				const found = readAsset(asset);
				if (!found) {
					res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					res.end('找不到这个资源：' + asset);
					return;
				}
				sendBytes(res, 200, found.bytes, found.type);
				return;
			}

			// ⑤ 其它（本插件还没别的路由）。
			res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
			res.end('没有这个路由：' + pathname);
		},
	})));
}
