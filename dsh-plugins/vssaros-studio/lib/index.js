// @vssaros/dsh-studio — host half
//
// 只做一件事：把 `/x/studio/` 这个页面发出去（页面见 lib/page.js）。
// 站点数据全部由 iframe 内自己请求（9999 允许被嵌入，且没有 X-Frame-Options）；
// 我们**不代理**站点接口 —— 代理会引入一堆绝对路径/Cookie 问题，收益为零。
//
// 可选配置：`siteUrl`（默认线上站点）。宿主可用 `--patch` 覆盖 cordis 行里的 config。
import { renderPage } from './page.js';

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
			// ★ 每次请求都**重新加载 page.js**（带时间戳 query 绕过 ESM 模块缓存）：
			//   host 侧是 node 模块，改 page.js 后原本必须重启 dsh 才生效 —— 这正是
			//   "改了页面却还是老 UI"的原因。动态 import 之后，改页面只需刷新页面即可。
			let html;
			try {
				const mod = await import('./page.js?t=' + Date.now());
				html = mod.renderPage({ siteUrl: state.siteUrl });
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
