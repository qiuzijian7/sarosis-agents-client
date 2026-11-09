// 本地 Agent 设置页的 SSR 片段与 HTTP API（P2 · 2026-11-09）。
//
// ★ 为什么是「插件自贡献 SSR 页面」而不是独立 section / React chunk：
//   · section 页面要改 `dshModuleContainers.ts` + `vssaros-skills/lib/index.js` + TS 测试 fixtures；
//   · client chunk 卡片要进 boot graph，未收录会让「整批 chunk 被拒」（check-dsh-plugin-sync 事故记录）；
//   · 本方案只改插件自己的文件，无 client chunk、无登记表、无构建步骤，可直接静态验证。
//   ⚠ 代价：没有侧栏入口 —— 由宿主页面嵌入或直接打开 `/x/local-agents/`，
//     侧栏卡片/徽标仍需改既有 React chunk（真机阶段）。
// ★ 零 JS：全部用原生 HTML 表单，CSP `default-src 'none'`；不引框架、不内联脚本。
// ★ 只读展示 + 两个无副作用 POST（重扫 / 校验），不写用户配置、不代管凭据。

export const ROUTE_PREFIX = '/x/local-agents';
export const PAGE_ROUTE = `${ROUTE_PREFIX}/`;
export const STATE_API = `${ROUTE_PREFIX}/api/state`;
export const REFRESH_ACTION = `${ROUTE_PREFIX}/refresh`;
export const VALIDATE_ACTION = `${ROUTE_PREFIX}/validate`;

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'";

export function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** urlencoded 表单解析（只取需要的字段，忽略其余）。 */
export function parseForm(body) {
	const out = {};
	for (const pair of String(body ?? '').split('&')) {
		if (!pair) continue;
		const at = pair.indexOf('=');
		const key = decodeURIComponent((at < 0 ? pair : pair.slice(0, at)).replace(/\+/g, ' '));
		const value = at < 0 ? '' : decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
		try { out[key] = value; } catch { /* 坏编码忽略 */ }
	}
	return out;
}

function engineRows(engines) {
	return engines.map((engine) => `<tr class="${engine.installed ? 'ok' : 'off'}">
  <td>${escapeHtml(engine.name)}<br><code>${escapeHtml(engine.route)}</code></td>
  <td>${escapeHtml(engine.kind)}${engine.custom ? '<br><em>自定义</em>' : ''}</td>
  <td>${engine.installed ? '已安装' : '未检测到'}<br><small>${escapeHtml(engine.version ?? '—')}</small></td>
  <td>${engine.signIn ? `<code>${escapeHtml(engine.signIn)}</code>` : '<small>按 CLI 文档自行登录</small>'}</td>
</tr>`).join('\n');
}

/**
 * 渲染整页。所有动态值一律 escapeHtml（引擎名可来自用户自定义配置）。
 * @param validation `{ error?, results? }`
 */
export function renderPage({ engines = [], routes = [], notice = '', validation } = {}) {
	const validationHtml = validation
		? `<section><h2>自定义 Agent 校验</h2>${validation.error
			? `<p class="warn">${escapeHtml(validation.error)}</p>`
			: `<ul>${(validation.results ?? []).map((row) => `<li class="${row.valid ? 'ok' : 'warn'}">
				<code>${escapeHtml(row.name || row.id || `#${row.index}`)}</code>：${row.valid
					? '通过' : escapeHtml(row.problems.join('；'))}</li>`).join('')}</ul>`}</section>`
		: '';
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>本地 Agent · VsSaros</title>
<style>
body{font:14px/1.55 system-ui,sans-serif;margin:24px;color:#222;max-width:960px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin-top:28px}
p.note{color:#555;margin:0 0 16px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}
th{background:#f6f6f6}code{background:#f2f2f2;padding:1px 4px;border-radius:3px;font-size:12px}
small,em{color:#666}tr.off{color:#888}td.ok,.ok{color:#176b3a}.warn{color:#a33}
button,textarea{font:inherit}button{padding:6px 14px;cursor:pointer}textarea{width:100%;height:90px}
</style></head><body>
<h1>本地 Agent</h1>
<p class="note">这里只做检测与展示：登录命令请复制到系统终端执行。凭据与套餐归 CLI 自己管理，本页不代管 API key、不读写 CLI 配置。</p>
${notice ? `<p class="note">${escapeHtml(notice)}</p>` : ''}
<form method="post" action="${REFRESH_ACTION}"><button type="submit">重新检测并热换路由</button></form>
<h2>引擎列表（${engines.length}）</h2>
<table><thead><tr><th>名称 / 模型路由</th><th>协议</th><th>状态 / 版本</th><th>登录命令</th></tr></thead>
<tbody>${engineRows(engines)}</tbody></table>
<h2>已注册路由（${routes.length}）</h2>
<p class="note"><code>${escapeHtml(routes.join(', ') || '（无）')}</code></p>
<h2>自定义 ACP Agent</h2>
<form method="post" action="${VALIDATE_ACTION}">
<p class="note">粘贴 JSON 数组做<strong>校验</strong>（不会保存、不会生效）：<br>
<code>[{"id":"my","name":"My Agent","command":"mycli","args":["acp"]}]</code></p>
<textarea name="custom" spellcheck="false">[]</textarea><br><button type="submit">校验</button></form>
${validationHtml}
</body></html>`;
}

const json = (status, value) => ({
	status,
	headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	body: JSON.stringify(value),
});
const html = (status, body) => ({
	status,
	headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
	body,
});

/** 纯函数版路由：不碰 req/res，便于单测。 */
export function apiResponse({ method = 'GET', pathname = PAGE_ROUTE, query = {}, body = '', settings }) {
	const snapshot = () => ({ engines: settings.list(), routes: settings.routes() });
	if (method === 'GET' && pathname === STATE_API) return json(200, snapshot());
	if (method === 'GET' && pathname === PAGE_ROUTE) {
		const notice = query.refreshed ? '已重新检测，路由已热换。' : '';
		return html(200, renderPage({ ...snapshot(), notice }));
	}
	if (method === 'POST' && pathname === REFRESH_ACTION) {
		settings.refresh();
		return {
			status: 303,
			headers: { location: `${PAGE_ROUTE}?refreshed=1`, 'cache-control': 'no-store' },
			body: '',
		};
	}
	if (method === 'POST' && pathname === VALIDATE_ACTION) {
		const form = parseForm(body);
		let parsed;
		try { parsed = JSON.parse(form.custom ?? '[]'); } catch { parsed = null; }
		const validation = parsed === null
			? { error: 'JSON 解析失败；请粘贴一个数组。', results: [] }
			: { results: settings.validateCustom(parsed) };
		return html(200, renderPage({ ...snapshot(), validation }));
	}
	return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'not found' };
}
