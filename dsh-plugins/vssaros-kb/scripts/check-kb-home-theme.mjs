/*
 * 2026-11-11：知识库总览页（/x/kb/home）配色必须跟随 dsh 外观。
 *
 * 事故：renderHomePage() 自带写死调色板 #15161a/#1c1d22/#22232a/#e8e9ec，
 *   html 钉死 data-theme="dark"，并用页面内「☀ 明暗」按钮独立切档 ⇒
 *   ① 与 dsh 官方深色（#151517/#232324/#2c2c2e/#f9fafb）接近但不等；
 *   ② 切浅色外观时整页不动；③ 点一次按钮就永久反色。
 * 修法照 vssaros-marketplace/lib/page.css：内部语义变量名保留，改成
 *   var(--dsw-alias-*, <兜底>) + prefers-color-scheme 两档；iframe 拿不到
 *   父文档令牌时 fallback 是唯一生效值 ⇒ 深/浅两档都必须给。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-home-theme.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const HERE = new URL('.', import.meta.url);
const SRC = readFileSync(new URL('../lib/homePage.js', HERE), 'utf8');
const { renderHomePage } = await import(new URL('../lib/homePage.js', HERE).href);

let pass = 0, fail = 0;
const check = (name, fn) => {
	try { fn(); pass++; console.log('PASS  ' + name); }
	catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + String(e?.message ?? e)); }
};

const css = SRC.slice(SRC.indexOf('<style>'), SRC.indexOf('</style>'));
const AT_LIGHT = '@media (prefers-color-scheme: light)';

/** 解析一段 CSS 里的 `--x:var(--dsw-alias-y, fallback);`（含 rgba() 兜底）。 */
function fallbacksOf(segment) {
	const out = {};
	for (const line of segment.split('\n')) {
		const m = /^\s*(--[a-z0-9-]+)\s*:\s*var\(\s*(--dsw-alias-[a-z0-9-]+)\s*,\s*(.+?)\s*\)\s*;/.exec(line);
		if (m) { out[m[1]] = { token: m[2], fallback: m[3] }; }
	}
	return out;
}
const dark = fallbacksOf(css.slice(0, css.indexOf(AT_LIGHT)));
const light = fallbacksOf(css.slice(css.indexOf(AT_LIGHT)));
const VARS = ['--bg', '--panel', '--panel2', '--line', '--line2', '--fg', '--fg2', '--fg3', '--accent', '--ok', '--warn'];

check('① 深/浅两档都完整定义 10 个内部语义变量', () => {
	assert.deepEqual(Object.keys(dark).sort(), [...VARS].sort());
	assert.deepEqual(Object.keys(light).sort(), [...VARS].sort());
});
check('② 每个变量都挂 dsh 外观令牌，且深/浅用同一组令牌', () => {
	for (const v of VARS) {
		assert.ok(dark[v].token.startsWith('--dsw-alias-'), v + ' 深色档没用令牌');
		assert.equal(light[v].token, dark[v].token, v + ' 两档令牌不一致');
	}
});
check('③ 深色兜底 = dsh 官方深色（bg-base #151517 / layer-1 #232324 / label-primary #f9fafb）', () => {
	assert.equal(dark['--bg'].fallback, '#151517');
	assert.equal(dark['--panel'].fallback, '#232324');
	assert.equal(dark['--panel2'].fallback, '#2c2c2e');
	assert.equal(dark['--fg'].fallback, '#f9fafb');
	assert.equal(dark['--fg2'].fallback, '#cfd3d6');
	assert.equal(dark['--fg3'].fallback, '#adb2b8');
});
check('④ 浅色兜底：页面纯白 + 卡片略灰 + 可见边框（修「白底白卡糊成一片」）', () => {
	assert.equal(light['--bg'].fallback, '#ffffff');
	assert.equal(light['--panel'].fallback, '#f7f8fa', '卡片不该与页面同色');
	assert.equal(light['--panel2'].fallback, '#eceff3');
	assert.equal(light['--line'].fallback, 'rgba(0,0,0,.10)', '边框太淡会看不见卡片');
	assert.equal(light['--fg'].fallback, '#0f1115');
	assert.equal(light['--fg2'].fallback, '#61666b');
	for (const v of VARS) { assert.notEqual(light[v].fallback, dark[v].fallback, v + ' 两档兜底相同 ⇒ 切外观没变化'); }
});
check('⑤ color-scheme 两档都声明（原生控件/滚动条跟随）', () => {
	assert.ok(/color-scheme:\s*dark/.test(css.slice(0, css.indexOf(AT_LIGHT))));
	assert.ok(/color-scheme:\s*light/.test(css.slice(css.indexOf(AT_LIGHT))));
});
check('⑥ 旧写死调色板与独立明暗开关已彻底移除', () => {
	const html = renderHomePage({ vaultName: 'V', kbs: [{ name: 'A', docs: 1 }] });
	// html 根节点不许再钉档位（只抓标签属性，不抓注释里提到这个属性）
	assert.ok(!/<html[^>]*\sdata-theme=/.test(html), 'html 根节点仍写死明暗档');
	for (const forbidden of ['id="theme"', 'dataset.theme', '☀ 明暗',
		'#15161a', '#1c1d22', '#22232a', '#e8e9ec', ':root[data-theme=']) {
		assert.ok(!html.includes(forbidden), '仍残留「' + forbidden + '」');
	}
});
check('⑦ 渲染出的页面带两档媒体查询、父页令牌同步与跟随说明', () => {
	const html = renderHomePage({ vaultName: 'V', kbs: [{ name: 'A', docs: 1 }] });
	assert.ok(html.includes(AT_LIGHT), '缺浅色媒体查询');
	assert.ok(html.includes('syncHostTheme') && html.includes('vssaros-dsh-theme'), '没同步父页令牌');
	assert.ok(html.includes('prefers-color-scheme: dark'), '没监听系统配色变化');
	assert.ok(html.includes('外观跟随宿主'), '没告诉用户明暗已跟随宿主');
	assert.ok(html.includes('getComputedStyle'), '没读父文档计算样式');
	assert.ok(html.includes('setProperty'), '没把父页令牌写进本页根节点');
});
check('⑧ renderHomePage 结构未回归（守卫 check-kb-kblist 的同款锚点）', () => {
	const html = renderHomePage({ vaultName: 'V', kbs: [{ name: 'A', docs: 1 }] });
	for (const needle of ['知识库主页', 'data-kb="A"', 'id="newCard"', 'id="mask"', 'id="kbname"',
		"source: 'kb-home'", 'window.parent.postMessage', '/api/kb-bind']) {
		assert.ok(html.includes(needle), '丢了结构锚点 ' + needle);
	}
});
check('⑨ 反向突变自证：浅色兜底若照抄深色值，④ 的「两档不同」会抓到', () => {
	// 故意把浅色 --bg 污染成深色值，再跑 ④ 的同一组判据 ⇒ 必须抛错
	const broken = { ...light, '--bg': { ...light['--bg'], fallback: dark['--bg'].fallback } };
	assert.throws(() => {
		for (const v of VARS) { assert.notEqual(broken[v].fallback, dark[v].fallback); }
	}, undefined, '浅色兜底写成深色却没报错 ⇒ ④ 无鉴别力');
});

check('⑩ ★ 浅色专属层次样式：父页令牌被注入成同色时仍能撑住卡片', () => {
	const lightCss = css.slice(css.lastIndexOf(AT_LIGHT));
	assert.ok(/\.card,\.st,\.recent\{[^}]*border-color:rgba\(0,0,0,\.12\)/.test(lightCss), '缺可见边框');
	assert.ok(/\.card,\.st,\.recent\{[^}]*box-shadow:0 1px 3px/.test(lightCss), '缺轻阴影');
	assert.ok(/\.cb-chip\{[^}]*background:#eceff3/.test(lightCss), 'chip 没与卡片拉开层次');
	assert.ok(/\.card\.new\{[^}]*border-color/.test(lightCss), '新建卡虚线太淡');
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { process.exit(1); }
