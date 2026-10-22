// @vssaros/dsh-marketplace — Host 半（2026-10-22）：商城工作台的**页面外壳 + 意图转发**。
//
// ★ 设计纪律（与 @vssaros/dsh-market 的分工）：
//   - `vssaros-market` = **第三方工作台目录**（dsh 公开市场）⇒ 装的是别人的包；
//   - `vssaros-marketplace` = **自营商城**（我们的服务端）⇒ agent / skill / 工作台 / 工作流 四类商品。
//   => 两条数据源、两条能力（`workbenches` vs `marketplace`），互不覆盖 ✓。
//
// ★ 为什么 Host 半"什么都不做"：
//   商城认证（JWT）在 IDE 进程 => Host 侧没有票据 ✗；
//   装工作台包必须走主进程那条已验证的通道 => Host 内 pluginManager 在全新 profile 上会剪树失败 ✗；
//   agent/skill/workflow 的落盘与注册表刷新都在 IDE 侧 => Host 写文件也刷不到 ✗。
//   => **Host 只提供路由与转发**；所有有副作用的动作由 IDE 执行（ide.request{capability:'marketplace'}）✓。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包名（与 package.json 一致；也是 ide.request 的 pluginId => 必须与清单里的 ideCapabilities 对上 ✓）。 */
const PLUGIN_PACKAGE = '@vssaros/dsh-marketplace';

/** 页面路由前缀。 */
const ROUTE_PREFIX = '/x/marketplace';

/** 转发给 IDE 的超时（读类给短档，写类给长档 —— 安装可能几分钟 ✓）。 */
const READ_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 8 * 60_000;

/** 商城商品类型（与服务端 packages/kinds.ts 同口径）。 */
const KINDS = ['agent', 'skill', 'mcp', 'knowledge', 'workflow', 'workbench'];

/** 能力层支持的 op（与 IDE 侧 marketplaceAction 同口径）。 */
const OPS = ['list', 'detail', 'install', 'uninstall', 'upgrade', 'publish', 'deletePackage', 'deleteVersion'];

/** 写类 op（需要用户确认 => 走长超时）。 */
const WRITE_OPS = new Set(['install', 'uninstall', 'upgrade', 'publish', 'deletePackage', 'deleteVersion']);

export async function apply(ctx, config) {
	/** IDE 控制桥（可选注入）：不在 => 页面如实报「商城通道不可用」，**不静默失败** ✓。 */
	const state = { bridge: null };
	ctx.inject(['vssarosBridge'], scope => {
		state.bridge = scope.vssarosBridge ?? null;
		return () => { state.bridge = null; };
	});

	/**
	 * 把一个商城动作转给 IDE。
	 *
	 * @param {string} op
	 * @param {object} params
	 */
	async function callIde(op, params) {
		const bridge = state.bridge;
		if (!bridge) {
			return { ok: false, error: '商城通道不可用（IDE 控制桥不在）—— 请确认 IDE 侧已连上 Harness。' };
		}
		if (!OPS.includes(op)) {
			return { ok: false, error: `不认识的商城动作：${op}` };
		}
		const timeoutMs = WRITE_OPS.has(op) ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
		let reply;
		try {
			reply = await bridge.callIDE('ide.request', {
				capability: 'marketplace',
				pluginId: PLUGIN_PACKAGE,
				params: { op, ...params },
			}, { timeoutMs });
		} catch (e) {
			return { ok: false, error: `商城通道出错：${String(e?.message ?? e)}` };
		}
		if (!reply) {
			return { ok: false, error: 'IDE 没有回执（商城动作未执行）' };
		}
		if (reply.ok === false) {
			return { ok: false, error: String(reply.error ?? 'IDE 拒绝了这次商城动作'), declined: reply.declined === true };
		}
		// 执行面把结果放在 result 里（{ ok, ... }）=> 摊平给页面 ✓
		const result = reply.result ?? {};
		return { ok: result.ok !== false, ...result };
	}

	/**
	 * 页面外壳（SSR）：真正的界面由页面自己的 JS 渲染，这里只给挂载点 ✓。
	 *
	 * ⚠ 样式走**独立的 css 文件**（`lib/page.css`）而不是 `pageShell.js` ——
	 *   `lib/pageShell.js` 是**全插件同形拷贝**（守卫 `check-host-config.mjs` 要求逐字节一致）⇒
	 *   商城自己的样式塞进去会当场红 ✗ ⇒ 单独一个文件 ✓。
	 */
	function renderPage() {
		return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>商城工作台</title>
<link rel="stylesheet" href="${ROUTE_PREFIX}/page.css" />
</head>
<body>
<div id="vs-mp-root"><div class="vs-mp-empty">正在装载商城工作台…</div></div>
<script type="module" src="${ROUTE_PREFIX}/client.js"></script>
</body>
</html>`;
	}

	ctx.inject(['webServer', 'connection'], webCtx => webCtx.effect(() => webCtx.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			// 鉴权栅栏（与 vssaros-market 同款 ✓）
			const rejected = webCtx.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const json = (status, body) => {
				res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				res.end(JSON.stringify(body));
			};
			try {
				// ── 页面外壳 ────────────────────────────────────
				if (req.method === 'GET' && (url.pathname === ROUTE_PREFIX || url.pathname === `${ROUTE_PREFIX}/`)) {
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
					res.end(renderPage());
					return;
				}

				// ── 客户端 chunk（页面自己加载）────────────────────
				if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/client.js`) {
					const { readFile } = await import('node:fs/promises');
					const here = path.dirname(fileURLToPath(import.meta.url));
					const body = await readFile(path.join(here, 'client.js'), 'utf8');
					res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
					res.end(body);
					return;
				}

				// ── 页面样式（独立文件：pageShell.js 是全插件同形拷贝，样式不能塞进去）──
				if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/page.css`) {
					const { readFile } = await import('node:fs/promises');
					const here = path.dirname(fileURLToPath(import.meta.url));
					const body = await readFile(path.join(here, 'page.css'), 'utf8');
					res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
					res.end(body);
					return;
				}

				// ── 商城动作（转发 IDE）──────────────────────────
				if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/api/action`) {
					const raw = await readBody(req);
					let parsed = {};
					try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
					const op = String(parsed.op ?? '');
					const result = await callIde(op, parsed.params ?? {});
					json(200, result);
					return;
				}

				// ── 分类常量（页面用来画页签）─────────────────────
				if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/api/meta`) {
					json(200, { ok: true, kinds: KINDS, ops: OPS });
					return;
				}

				json(404, { ok: false, error: `unknown marketplace route: ${url.pathname}` });
			} catch (e) {
				json(500, { ok: false, error: String(e?.message ?? e) });
			}
		},
	})));
}

/** 读请求体（限长，避免无限读）。 */
function readBody(req, limit = 1_000_000) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', chunk => {
			size += chunk.length;
			if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}
