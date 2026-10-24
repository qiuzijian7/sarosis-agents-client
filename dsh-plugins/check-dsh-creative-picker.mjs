// 创作模型（聊天框模型下拉框里的图片 / 视频 / 音频三行，方案 A + 视觉 S2）的守卫。
//
// 为什么是行为级：这套东西是**DOM 手术**（官方没有开插槽）⇒ "源码里写了注入" 完全可能
//   · 把官方那两行也一起重画（官方二级菜单失去锚点 / 键盘导航断）
//   · 点开二级列表却没有 provider 分组、置灰行点了没反应
//   · 选中之后没落盘（下次又回到默认）
//   这些都能让源码断言全绿而实际全错 ✗。所以这里用 jsdom 真装载 chunk、真造一个"官方菜单"、
//   真派发点击，断言到 DOM 与请求上。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const repo = process.cwd();
const problems = [];
const ok = (name) => console.log('  ✓ ' + name);
const fail = (msg) => { problems.push(String(msg)); console.log('  ✗ ' + String(msg)); };
const read = (rel) => readFileSync(join(repo, rel), 'utf8');
const eq = (name, actual, expected) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { ok(name); } else { fail(name + '：期望 ' + e + '，实际 ' + a); }
};
const truthy = (name, cond, detail) => { if (cond) { ok(name); } else { fail(name + (detail ? '：' + detail : '')); } };

const CHUNK = 'dsh-plugins/vssaros-chat-surface/lib/client.creative.js';

// ── ① 注册与清单 ────────────────────────────────────────────────────────────
{
	const entry = read('dsh-plugins/vssaros-chat-surface/lib/client.js');
	const pkg = JSON.parse(read('dsh-plugins/vssaros-chat-surface/package.json'));
	truthy('① chunk 挂在 ALWAYS_CHUNKS（有桥/无桥两种模式都要有这三行）',
		/ALWAYS_CHUNKS\s*=\s*\[[^\]]*"\.\/client\.creative\.js"/.test(entry), '没在 ALWAYS_CHUNKS 里');
	truthy('① 随包文件清单登记了 client.creative.js（漏了 ⇒ 装上去没有这个文件）',
		(Array.isArray(pkg.files) ? pkg.files : []).includes('lib/client.creative.js'));
	truthy('① 入口构建指纹提到这次改动（浏览器才会重新取 chunk）',
		/CLIENT_BUILD_STAMP[\s\S]{0,600}创作模型三行/.test(entry), String(entry.match(/CLIENT_BUILD_STAMP\s*=\s*"([^"]*)"/)?.[1] ?? '').slice(0, 80));
}

// ── 装载 chunk（真 factory，真 install）────────────────────────────────────────
const src = read(CHUNK);
const fakeRequire = (name) => {
	if (name === 'react') { return { createElement: () => null, useState: v => [v, () => { }], useEffect: () => { } }; }
	throw new Error('unexpected require: ' + name);
};
/**
 * 装载 chunk。⚠ `window` 是 chunk 的**形参**（会遮蔽全局）⇒ 真跑 DOM 时必须把 jsdom 的 window
 * 传进去（传个只有 `__ModuleLoader__` 的假对象，`install()` 里 `window.addEventListener` 就没了）。
 */
const loadChunk = (win) => {
	let captured = null;
	const host = win || {};
	host.__ModuleLoader__ = { load: m => { captured = m; } };
	new Function('window', 'require', src)(host, fakeRequire);
	if (!captured) { throw new Error('chunk 没有调用 __ModuleLoader__.load'); }
	return captured.factory(fakeRequire);
};
const api = loadChunk();
const T = api.__test;

// ── ② 纯函数 ────────────────────────────────────────────────────────────────
{
	const lightai = (status) => ({ id: 'lightai', name: 'LightAI', route: 'dsh 直连', unit: '灯火', status, kinds: {} });
	eq('② 能用 ⇒ 原因为空', T.reasonFor({ id: 'a', routable: true }, lightai({ signedIn: true })), '');
	eq('② 未登录 ⇒ 需登录', T.reasonFor({ id: 'a', routable: true }, lightai({ signedIn: false })), '需登录 LightAI');
	eq('② 登录中 ⇒ 正在登录', T.reasonFor({ id: 'a', routable: true }, lightai({ signedIn: false, signingIn: true })), '正在登录 LightAI…');
	truthy('② 已失效 ⇒ 让人去重新登录', /重新登录/.test(T.reasonFor({ id: 'a', routable: true }, lightai({ signedIn: true, expired: true }))));
	eq('② 路由表没接 ⇒ 明说没接入', T.reasonFor({ id: 'a', routable: false }, lightai({ signedIn: true })), 'dsh 侧还没接入这个模型');

	const cat = T.normalizeCatalog({
		providers: [
			{ id: 'lightai', name: 'LightAI', status: { signedIn: true }, kinds: { image: [{ id: 'p1', name: 'P1', routable: true, price: 0.8, unit: '灯火' }] } },
			{ id: 'byok', name: 'BYOK', kinds: { image: [], video: [{ id: 'v1', routable: false }] } },
			{ bogus: true },
		],
		defaults: { image: { provider: 'lightai', model: 'p1' } },
		picked: { image: 'p1' },
	});
	eq('② 目录归一化：丢掉没有 id 的 provider', cat.providers.map(p => p.id), ['lightai', 'byok']);
	eq('② 分组：空组丢掉（byok 的图片是空的）', T.groupModels(cat, 'image').map(g => g.provider.id), ['lightai']);
	eq('② 分组：按 provider 分开（视频只在 byok 有）', T.groupModels(cat, 'video').map(g => g.provider.id), ['byok']);
	eq('② 当前选中：按 defaults 找到 provider + 模型',
		(() => { const s = T.selectedOf(cat, 'image'); return s ? [s.provider.id, s.model.id] : null; })(), ['lightai', 'p1']);
	eq('② 当前选中：找不到就 null', T.selectedOf(cat, 'audio'), null);
	eq('② 菜单三行：值 = 当前模型名 + provider 名',
		T.menuRows(cat).map(r => [r.kind, r.modelName, r.providerName]),
		[['image', 'P1', 'LightAI'], ['video', '', ''], ['audio', '', '']]);
	eq('② 菜单三行：整类都不能用 ⇒ blocked（视频那个没接入）', T.menuRows(cat).map(r => r.blocked), [false, true, true]);
	eq('② 价格文案', T.priceText({ price: 3.2, unit: '灯火' }, { unit: '灯火' }), '3.2 灯火');
	eq('② 没有价 ⇒ 不显示（别编一个 0）', T.priceText({ id: 'x' }, { unit: '灯火' }), '');
	eq('② 搜索命中名字 / id / provider', [
		T.matches({ id: 'p1', name: 'P1' }, { name: 'LightAI' }, 'light'),
		T.matches({ id: 'p1', name: 'P1' }, { name: 'LightAI' }, 'p1'),
		T.matches({ id: 'p1', name: 'P1' }, { name: 'LightAI' }, 'zzz'),
	], [true, true, false]);
}

// ── ③ 真 DOM：注入 / 打开 / 选 / 置灰 / 老桥 ─────────────────────────────────────
const makeDom = () => {
	const dom = new JSDOM('<!doctype html><html><head></head><body>'
		+ '<div role="menu" aria-label="模型与推理等级">'
		+ '<button role="menuitem"><span>模型</span><span>Deepseek-V4-Flash</span></button>'
		+ '<button role="menuitem"><span>推理等级</span><span>Default</span></button>'
		+ '</div></body></html>', { pretendToBeVisual: true });
	return dom;
};

const CATALOG = {
	providers: [{
		id: 'lightai', name: 'LightAI', route: 'dsh 直连', unit: '灯火',
		status: { signedIn: true },
		kinds: {
			image: [
				{ id: 'picture_banana_2', name: 'Nano Banana 2', routable: true, price: 0.8, unit: '灯火' },
				{ id: 'picture_seedream_50', name: '即梦生图 5.0', routable: true, price: 0.2, unit: '灯火' },
				{ id: 'picture_flux_3_0', name: 'Flux 3.0', routable: false },
			],
			video: [{ id: 'video_minimax_h3', name: 'MiniMax H3', routable: true, price: 3.2, unit: '灯火' }],
			audio: [{ id: 'audio_speech_28', name: 'Speech 2.8 HD', routable: true, price: 1, unit: '灯火' }],
		},
	}],
	defaults: { image: { provider: 'lightai', model: 'picture_banana_2' }, video: { provider: 'lightai', model: 'video_minimax_h3' }, audio: { provider: 'lightai', model: 'audio_speech_28' } },
	picked: { image: 'picture_banana_2' },
};

/** 装一个干净的运行环境：真 jsdom + fetch 打桩，返回 { dom, posts, install } */
async function boot({ catalog = CATALOG, catalogStatus = 200, catalogType = 'application/json' } = {}) {
	const dom = makeDom();
	const { window } = dom;
	const posts = [];
	const realFetch = globalThis.fetch;
	globalThis.window = window;
	globalThis.document = window.document;
	globalThis.MutationObserver = window.MutationObserver;
	globalThis.fetch = (url, init) => {
		const u = String(url);
		if (u.endsWith('/media/catalog')) {
			return Promise.resolve({
				status: catalogStatus,
				headers: { get: () => catalogType },
				json: async () => ({ ok: true, ...catalog }),
			});
		}
		if (u.endsWith('/media/default')) {
			const body = JSON.parse(String((init && init.body) || '{}'));
			posts.push(body);
			const next = JSON.parse(JSON.stringify(catalog));
			next.defaults = Object.assign({}, next.defaults, { [body.kind]: { provider: body.provider, model: body.model } });
			return Promise.resolve({ status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, ...next }) });
		}
		return realFetch(url, init);
	};
	const mod = loadChunk(window);
	mod.install();
	mod.__test.scan();
	await new Promise(r => setTimeout(r, 30));
	return {
		window, doc: window.document, posts, mod,
		restore: () => { globalThis.fetch = realFetch; },
	};
}

// ③a 注入：官方两行原样，我们追加一组
{
	const env = await boot();
	try {
		const menu = env.doc.querySelector('[role="menu"][aria-label="模型与推理等级"]');
		const items = [...menu.querySelectorAll(':scope > button[role="menuitem"]')];
		eq('③a 官方那两行**原样还在**（没被我们重画）', items.map(b => b.textContent.replace(/\s+/g, ' ').trim()),
			['模型Deepseek-V4-Flash', '推理等级Default']);
		const wrap = menu.querySelector('[data-vssaros-creative-wrap]');
		truthy('③a 菜单末尾多了我们的分组', !!wrap);
		eq('③a 分组是 role=group + aria-label（读屏当成一个子组）',
			[wrap.getAttribute('role'), wrap.getAttribute('aria-label')], ['group', '创作模型']);
		const rows = [...wrap.querySelectorAll('[data-vssaros-creative-row]')];
		eq('③a 三行：图片 / 视频 / 音频', rows.map(r => r.getAttribute('data-kind')), ['image', 'video', 'audio']);
		// S2 结构：图标 + 标签 + 值 + 来源徽标 + 箭头
		const first = rows[0];
		truthy('③a S2 结构：图标 + 标签 + 值 + 来源徽标 + 箭头',
			!!first.querySelector('.vc-ico svg') && /图片模型/.test(first.querySelector('.vc-lb').textContent)
			&& /Nano Banana 2/.test(first.querySelector('.vc-val').textContent)
			&& !!first.querySelector('[data-vssaros-creative-badge]')
			&& !!first.querySelector('.vc-chev svg'),
			first.outerHTML.slice(0, 300));
		eq('③a 值里带 provider 名（多 provider 时能分辨来源）',
			first.querySelector('[data-vssaros-creative-badge]').textContent, 'LightAI');
	} finally { env.restore(); }
}

// ③b 打开二级：provider 分组 + 行内名字/徽标/价格
{
	const env = await boot();
	try {
		const row = env.doc.querySelector('[data-vssaros-creative-row][data-kind="image"]');
		row.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
		await new Promise(r => setTimeout(r, 10));
		const pop = env.doc.querySelector('[data-vssaros-creative-pop]');
		truthy('③b 点一下行 ⇒ 弹出我们自己的列表', !!pop && pop.hasAttribute('data-open'));
		const grp = pop.querySelector('.vc-grp');
		truthy('③b 列表里有 provider 组头（名字 + 通路 + 状态）',
			/LightAI/.test(grp.textContent) && /dsh 直连/.test(grp.textContent) && /已登录/.test(grp.textContent),
			grp.textContent);
		const items = [...pop.querySelectorAll('.vc-item')];
		eq('③b 行数 = 这一类全部模型（含没接入的）', items.length, 3);
		truthy('③b 每行：缩略图 + 名字 + 徽标',
			items.every(i => i.querySelector('.vc-thumb svg') && i.querySelector('.vc-l1 .vc-nm') && i.querySelector('[data-vssaros-creative-badge]')));
		truthy('③b 可用的行显示灯火价', /0\.8 灯火/.test(items[0].textContent), items[0].textContent);
		const offRow = items.find(i => i.hasAttribute('data-off'));
		truthy('③b 没接入的行写明原因（且不是 disabled 属性 —— 那样点了没反应）',
			!!offRow && !offRow.hasAttribute('disabled') && /dsh 侧还没接入这个模型/.test(offRow.textContent),
			offRow ? offRow.outerHTML.slice(0, 240) : '(没有置灰行)');
		truthy('③b 当前选中的那行有标记', items[0].hasAttribute('data-on')
			&& items.filter(i => i.hasAttribute('data-on')).length === 1);
	} finally { env.restore(); }
}

// ③c 换个模型 ⇒ POST 落盘 + 菜单行值跟着变
{
	const env = await boot();
	try {
		env.doc.querySelector('[data-vssaros-creative-row][data-kind="image"]').dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
		await new Promise(r => setTimeout(r, 10));
		const pop = env.doc.querySelector('[data-vssaros-creative-pop]');
		const item = [...pop.querySelectorAll('.vc-item')].find(i => /即梦生图 5\.0/.test(i.textContent));
		truthy('③c 列表里有第二个可用模型', !!item);
		item.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
		await new Promise(r => setTimeout(r, 30));
		eq('③c 选中 ⇒ POST /api/media/default（kind / provider / model）',
			env.posts, [{ kind: 'image', provider: 'lightai', model: 'picture_seedream_50' }]);
		truthy('③c 选完把列表收起来', !env.doc.querySelector('[data-vssaros-creative-pop][data-open]'));
		const row = env.doc.querySelector('[data-vssaros-creative-row][data-kind="image"]');
		truthy('③c 菜单行值立刻变成新选的模型（不用重开菜单）',
			/即梦生图 5\.0/.test(row.textContent), row.textContent.replace(/\s+/g, ' ').trim());
	} finally { env.restore(); }
}

// ③d 点置灰行 ⇒ 只提示，不发请求
{
	const env = await boot();
	try {
		env.doc.querySelector('[data-vssaros-creative-row][data-kind="image"]').dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
		await new Promise(r => setTimeout(r, 10));
		const off = env.doc.querySelector('[data-vssaros-creative-pop] .vc-item[data-off]');
		off.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
		await new Promise(r => setTimeout(r, 20));
		eq('③d 置灰行不发请求', env.posts.length, 0);
		const toast = env.doc.querySelector('[data-vssaros-creative-toast]');
		truthy('③d 置灰行给出原因（点了有反馈，不是没反应）',
			!!toast && /dsh 侧还没接入这个模型/.test(toast.textContent), toast ? toast.textContent : '(没有提示元素)');
	} finally { env.restore(); }
}

// ③e 未登录 ⇒ 三个行都带"这一类用不了"的提示点，列表行置灰并说明
{
	const catalog = JSON.parse(JSON.stringify(CATALOG));
	catalog.providers[0].status = { signedIn: false };
	const env = await boot({ catalog });
	try {
		const rows = [...env.doc.querySelectorAll('[data-vssaros-creative-row]')];
		truthy('③e 未登录 ⇒ 每行都带提示点', rows.every(r => !!r.querySelector('.vc-warn')));
		env.doc.querySelector('[data-vssaros-creative-row][data-kind="image"]').dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
		await new Promise(r => setTimeout(r, 10));
		const pop = env.doc.querySelector('[data-vssaros-creative-pop]');
		truthy('③e 列表行置灰 + 原因 = 需登录 LightAI',
			[...pop.querySelectorAll('.vc-item')].every(i => i.hasAttribute('data-off') && /需登录 LightAI/.test(i.textContent)));
		truthy('③e 组头状态显示"未登录"', /未登录/.test(pop.querySelector('.vc-grp').textContent));
	} finally { env.restore(); }
}

// ③f 老桥插件（没有这个 API）⇒ 一行都不加
{
	const env = await boot({ catalogStatus: 404, catalogType: 'text/html' });
	try {
		eq('③f 老桥 ⇒ 菜单里没有我们的分组', env.doc.querySelectorAll('[data-vssaros-creative-wrap]').length, 0);
	} finally { env.restore(); }
}

// ── ④ 源码面：不该出现的东西 ──────────────────────────────────────────────────
{
	// ⚠ 只看**代码**：注释里写着"不经 IDE"是做法的说明，不该被判红（先剥注释）
	const codeOnly = src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
	truthy('④ 代码里没有"经 IDE"这条路（用户已定：provider 一律经 dsh）', !/经\s*IDE/.test(codeOnly));
	truthy('④ 靠官方那个菜单的选择器定位（不是猜别的节点）', src.includes('aria-label="模型与推理等级"'));
	truthy('④ 置灰行不用 disabled 属性（用了点击事件根本不来 ⇒ 点了没反应）',
		!/\bdisabled=/.test(src.split('data-off')[0].slice(-400)) && !/\.disabled\s*=/.test(src));
	truthy('④ 采集数据只走 bridge 的 media 面', /\/x\/vssaros-bridge\/api\/media\//.test(src));
	truthy('④ 有构造 aria（group / menu / aria-disabled）',
		/setAttribute\("role", "group"\)/.test(src) && /setAttribute\("role", "menu"\)/.test(src) && /aria-disabled/.test(src));
}

console.log('');
if (problems.length === 0) {
	console.log('[check-dsh-creative-picker] ✓ 创作模型三行（S2）：注册 / 纯函数 / 注入不碰官方两行 / 分组列表 / 选中落盘 / 置灰说明 / 未登录 / 老桥零痕迹 全部通过');
	process.exit(0);
}
console.log('[check-dsh-creative-picker] ✗ ' + problems.length + ' 处问题：');
for (const p of problems) { console.log('  - ' + p); }
process.exit(1);
