/*
 * 守卫：**全路由冒烟**（2026-10-25）。
 *
 * 前面的守卫都是"某个功能对不对"，这条反过来问："**有没有路由已经坏了/被忘了**"。
 * 能力堆到 20+ 条路由之后，最容易出现的是"某条路由没人调、悄悄 500"——
 * 单看代码看不出来，只能真打一遍。
 *
 * 对每条 GET 路由断言三件事：HTTP 状态、`ok` 字段、以及**关键字段存在**。
 * 外部依赖（lark-cli / 真实库）缺失时，允许 `ok:false` 但**必须给出 error 文案**。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-routes-smoke.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KB = new URL('../lib/index.js', import.meta.url).href;
const FND = new URL('../../vssaros-foundation/lib/index.js', import.meta.url).href;
const mod = await import(KB);
const fnd = await import(FND);
const foundation = fnd.createFoundationService();

let handler;
const noop = () => () => {};
const ctx = new Proxy({}, {
	get(_t, key) {
		if (key === 'inject') {
			return (deps, cb) => {
				if (Array.isArray(deps) && deps.includes('webServer')) {
					cb({
						effect: fn => { fn(); return noop(); },
						connection: { requestRejection: () => undefined },
						webServer: { register: spec => { handler = spec.handler; return noop(); } },
					});
				} else if (Array.isArray(deps) && deps.includes('vssarosFoundation')) {
					cb({ vssarosFoundation: foundation });
				}
				return noop();
			};
		}
		if (key === 'effect') { return fn => { try { const d = fn(); return typeof d === 'function' ? d : noop(); } catch { return noop(); } }; }
		if (key === 'get') { return n => (n === 'vssarosFoundation' ? foundation : null); }
		if (key === 'tools') { return { register: noop }; }
		if (key === 'on') { return noop; }
		return undefined;
	},
});

// 临时库（自带一篇笔记 + 一份 canvas，保证依赖数据的路由有东西可读）
const vault = mkdtempSync(join(tmpdir(), 'kb-smoke-'));
mkdirSync(join(vault, '库'), { recursive: true });
mkdirSync(join(vault, '笔记'), { recursive: true });
const notePath = join(vault, '笔记', 'smoke.md');
writeFileSync(notePath, '---\ntitle: smoke\n---\n\n# smoke\n\n一段正文，含 [[smoke2]] 与 `code`。\n', 'utf8');
writeFileSync(join(vault, '笔记', 'smoke2.md'), '# smoke2\n\n另一段。\n', 'utf8');
writeFileSync(join(vault, '笔记', 'd.canvas'), JSON.stringify({
	nodes: [{ id: 'n1', type: 'text', width: 200, height: 60, x: 0, y: 0, content: 'A', source: { file: 'smoke.md', line: 1 } }],
	edges: [],
}), 'utf8');

mod.apply(ctx, {
	dataRoot: mkdtempSync(join(tmpdir(), 'kb-smoke-root-')),
	hostHalf: true,
	kbVaults: JSON.stringify([{ id: 'demo', name: '临时库', path: vault }]),
});

const call = async (path, method = 'GET', body = '') => {
	const out = [];
	const req = { method, url: path };
	if (method === 'POST') {
		req[Symbol.asyncIterator] = async function* () { if (body) { yield Buffer.from(body); } };
	}
	let status = 0;
	await handler(req, {
		writeHead(code) { status = code; },
		end(b) { out.push(String(b ?? '')); },
	});
	let parsed = {};
	try { parsed = JSON.parse(out.join('') || '{}'); } catch { parsed = { __raw: out.join('') }; }
	return { status, body: parsed };
};

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

/** 路由白名单：允许依赖外部能力，但**失败必须带 error** */
const cases = [
	{ name: 'GET /api/view-data', path: '/x/kb/api/view-data', expect: b => b.ok === true && b.data && typeof b.data.noteCount === 'number' },
	{ name: 'GET /api/kb-settings', path: '/x/kb/api/kb-settings', expect: b => b.ok === true && b.settings && b.settings.feishu },
	{ name: 'GET /api/graph', path: '/x/kb/api/graph', expect: b => b.ok === true && Array.isArray(b.nodes) },
	{ name: 'GET /api/search?q=smoke', path: '/x/kb/api/search?q=smoke', expect: b => b.ok === true && Array.isArray(b.hits || b.results || []) },
	{ name: 'GET /api/doc', path: '/x/kb/api/doc?uri=' + encodeURIComponent(notePath.replace(/\\/g, '/')), expect: b => b.ok === true && typeof b.html === 'string' && b.html.includes('smoke') },
	{ name: 'GET /api/health', path: '/x/kb/api/health', expect: b => b.ok === true && b.report && typeof b.report.total === 'number' },
	{ name: 'GET /api/dedupe', path: '/x/kb/api/dedupe', expect: b => b.ok === true && typeof b.scanned === 'number' },
	{ name: 'GET /api/review', path: '/x/kb/api/review', expect: b => b.ok === true && typeof b.unreviewedCount === 'number' },
	{ name: 'GET /api/canvas-list', path: '/x/kb/api/canvas-list', expect: b => b.ok === true && Array.isArray(b.files) },
	{ name: 'GET /api/canvas', path: '/x/kb/api/canvas?uri=' + encodeURIComponent(join(vault, '笔记', 'd.canvas').replace(/\\/g, '/')), expect: b => b.ok === true && Array.isArray(b.nodes) },
	{ name: 'GET /api/reindex', path: '/x/kb/api/reindex', expect: b => b.ok === true && b.vector && b.vector.supported === false },
	{ name: 'GET /api/feishu-schedule', path: '/x/kb/api/feishu-schedule', expect: b => b.ok === true && typeof b.everyMinutes === 'number' },
	{ name: 'GET /api/feishu-log', path: '/x/kb/api/feishu-log', expect: b => b.ok === true && Array.isArray(b.lines) },
	{ name: 'GET /api/feishu-cli', path: '/x/kb/api/feishu-cli', expect: b => (b.ok === true && typeof b.version === 'string') || (b.ok === false && !!b.error) },
	{ name: 'GET /vendor/katex/katex.min.css', path: '/x/kb/vendor/katex/katex.min.css', raw: true, expect: b => !!b.__raw },
	{ name: 'POST /api/mindmap', method: 'POST', path: '/x/kb/api/mindmap', body: JSON.stringify({ vaultId: 'demo' }), expect: b => (b.ok === true && !!b.path) || (b.ok === false && !!b.error) },
	// 页面（静态资源）也要打一遍：它不返回 JSON，只看能否拿到且含关键脚本
	{ name: '/x/kb/ 页面可访问', path: '/x/kb/', raw: true, expect: b => !!b.__raw },
	// ★ 2026-10-25（真机：知识库中的文档未渲染）：`/x/kb/doc` 必须有真路由，
	//   且输出的是**渲染后的 HTML**（有 h1/段落结构、没有外露的 [!callout]）。
	{
		name: '/x/kb/doc 页面已渲染（非纯文本）',
		path: '/x/kb/doc?uri=' + encodeURIComponent(notePath.replace(/\\/g, '/')),
		expect: b => typeof b.__raw === 'string' && b.__raw.includes('data-kb-doc-page')
			&& /<h1|<p>|<blockquote/.test(b.__raw) && !b.__raw.includes('[!'),
	},
	// 负例：越界路径必须被拒（不是 500，而是 4xx + error）
	{ name: 'GET /api/doc 拒绝库外路径', path: '/x/kb/api/doc?uri=' + encodeURIComponent('C:/Windows/win.ini'), expect: b => b.ok === false && !!b.error },
];

for (const c of cases) {
	const r = await call(c.path, c.method || 'GET', c.body || '');
	t(c.name, r.status < 500 && c.expect(r.body), 'status=' + r.status + ' body=' + JSON.stringify(r.body).slice(0, 120));
}


// ── 页面 CSP 与脚本外置（2026-10-26，P4）──────────────────────
// 只要还有内联脚本，CSP 就只能写 unsafe-inline（等于没加）⇒ 这里同时钉住三件事：
//   ① 两个 HTML 页面都带 CSP 头；② 页面里没有内联脚本；③ 外置脚本能取到。
const rawCall = async (path) => {
	const out = [];
	let status = 0;
	let headers = {};
	await handler({ method: 'GET', url: path }, {
		writeHead(code, h) { status = code; headers = h || {}; },
		end(b) { out.push(String(b ?? '')); },
	});
	return { status, headers, body: out.join('') };
};

{
	const page = await rawCall('/x/kb/');
	const csp = String(page.headers['content-security-policy'] || '');
	t('页面带 CSP 头', csp.includes("script-src 'self'"), csp.slice(0, 120) || '(无)');
	t('CSP 不允许内联脚本', !/script-src[^;]*unsafe-inline/.test(csp), csp.slice(0, 120));
	t('页面无内联脚本', !/<script(?![^>]*src=)/.test(page.body));
	t('page-boot.js 可访问', (await rawCall('/x/kb/web/page-boot.js')).status === 200);
	t('doc-boot.js 可访问', (await rawCall('/x/kb/web/doc-boot.js')).status === 200);
	// 编辑器 bundle：进入编辑态才会被请求（独立于侧栏，727KB 不进主包）
	t('kbEditor.js 可访问（按需加载的编辑器）', (await rawCall('/x/kb/web/kbEditor.js')).status === 200);
	// mermaid：3.4MB 的图表库，只有正文有 mermaid 块时才被请求
	// 2026-10-26：mermaid 已改为服务端 pele 渲染 ⇒ 客户端引擎不该再被服务出去
	t('客户端 mermaid 引擎已下线（404）', (await rawCall('/x/kb/vendor/mermaid/mermaid.min.js')).status === 404);
	t('vendor 目录非白名单文件被拒', (await rawCall('/x/kb/vendor/mermaid/package.json')).status === 404);
	const docPage = await rawCall('/x/kb/doc?uri=' + encodeURIComponent(notePath.replace(/\\/g, '/')));
	t('文档页带 CSP 头', String(docPage.headers['content-security-policy'] || '').includes("script-src 'self'"));
	t('文档页脚本已外置', docPage.body.includes('doc-boot.js') && !/<script>/.test(docPage.body));
	// 静态资源白名单：不该把任意 lib 文件当 js 吐出去
	t('web 目录非白名单文件被拒', (await rawCall('/x/kb/web/index.js')).status === 404);
}
console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（全路由冒烟）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（全路由冒烟：${cases.length} 条路由）`);
