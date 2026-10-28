// @vssaros/dsh-studio — host half
//
// 只做一件事：把 `/x/studio/` 这个页面发出去（页面见 lib/page.js）。
// 站点数据全部由 iframe 内自己请求（9999 允许被嵌入，且没有 X-Frame-Options）；
// 我们**不代理**站点接口 —— 代理会引入一堆绝对路径/Cookie 问题，收益为零。
//
// 可选配置：`siteUrl`（默认线上站点）。宿主可用 `--patch` 覆盖 cordis 行里的 config。
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderPage } from './page.js';

const PAGE_FILE = fileURLToPath(new URL('./page.js', import.meta.url));

/**
 * 按 **文件 mtime** 缓存 `page.js` 的模块实例。
 *
 * ⚠ 原来写的是 `import('./page.js?t=' + Date.now())`：每次请求都带一个新时间戳 ⇒
 *   Node 把它当成**全新模块**（重新读盘 + 编译 + 执行），而 **ESM 模块实例永远不会被 GC**
 *   ⇒ 请求一次就永久多一份，进程跑久了内存只增不减（2026-10-28 实测：运行 15 分钟已 2.1GB），
 *   切换工作台时 GC 停顿变长，表现为"内容刷新特别慢"。
 *
 * 用 mtime 当 cache-busting：文件没变 ⇒ 复用已加载的模块（零开销）；
 * 改了 page.js ⇒ mtime 变 ⇒ URL 变 ⇒ 正常热更新（保留"改页面只需刷新"的开发便利）。
 */
let pageModuleCache = { mtimeMs: 0, render: null };

async function loadPageRender() {
	try {
		const { mtimeMs } = await stat(PAGE_FILE);
		if (pageModuleCache.render && pageModuleCache.mtimeMs === mtimeMs) { return pageModuleCache.render; }
		const mod = await import('./page.js?t=' + mtimeMs);
		pageModuleCache = { mtimeMs, render: mod.renderPage };
		return pageModuleCache.render;
	} catch {
		// 读不到 stat / 动态 import 失败 ⇒ 用顶部静态 import 的那份（永远可用）
		return renderPage;
	}
}

const ROUTE_PREFIX = '/x/studio';
const DEFAULT_SITE = 'http://saroasisstudiosystem.saroasis.woa.com:9999/';

const state = {
	siteUrl: DEFAULT_SITE,
};

/**
 * @param {object} [config]
 * @param {string} [config.siteUrl] 站点地址（缺省 = 线上 9999）
 */
export function init(config = {}) {
	const url = typeof config.siteUrl === 'string' ? config.siteUrl.trim() : '';
	if (/^https?:\/\//i.test(url)) { state.siteUrl = url; }
	return apply;
}

export function apply(ctx) {
	ctx.inject(['webServer', 'connection'], page => page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			// 只认页面本身；子路径一律 404（这里没有别的资源）
			if (url.pathname !== ROUTE_PREFIX && url.pathname !== ROUTE_PREFIX + '/') {
				res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
				res.end('not found');
				return;
			}
			// 按 mtime 缓存（见 loadPageRender 注释）：文件没变不重新加载，
			// 改了 page.js 仍然下一次请求就生效（无需重启 dsh）。
			let html;
			try {
				const render = await loadPageRender();
				html = render({ siteUrl: state.siteUrl });
			} catch (e) {
				html = renderPage({ siteUrl: state.siteUrl });
			}
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
			});
			res.end(html);
		},
	}), 'vssaros-studio: page route'));
}
