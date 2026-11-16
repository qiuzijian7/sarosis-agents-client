/*
 * 2026-11-11：知识库总览卡片图标落地守卫（方案 E + B 的 SVG 图标）。
 *
 * 用户报「doc/kb-card-icon-e-mixed.html 改版未生效」⇒ 根因是那只是 mockup，
 * 生产真源是 lib/homePage.js。本守卫钉住真源里必须有：
 *   · 40px 图标底 + 内联语义 SVG（不再是 78px 纯渐变封面）；
 *   · 状态角标（7 天圆点 / 飞书 link / 空库虚线 / 篇数 chip）且绝对定位；
 *   · 上一轮的主题两档变量不被改版带坏。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-card-icons.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const HERE = new URL('.', import.meta.url);
const SRC = readFileSync(new URL('../lib/homePage.js', HERE), 'utf8');
const icons = await import(new URL('../lib/core/kbCardIcons.js', HERE).href);
const { renderHomePage } = await import(new URL('../lib/homePage.js', HERE).href);

let pass = 0, fail = 0;
const check = (name, fn) => {
	try { fn(); pass++; console.log('PASS  ' + name); }
	catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + String(e?.message ?? e)); }
};

const KBS = [
	{ name: '财经', docs: 1, weekNew: 1, hasFeishu: true, excerpt: '估值模型与财报摘要', updatedAt: Date.now() - 9 * 864e5 },
	{ name: 'AIAgent', docs: 21, weekNew: 1, excerpt: 'Agent 框架与记忆机制', updatedAt: Date.now() - 9 * 864e5 },
	{ name: '游戏设计', docs: 8, excerpt: '玩法拆解与数值', updatedAt: Date.now() - 48 * 864e5 },
	{ name: 'ComfyUI技术', docs: 1, excerpt: '工作流节点与出图参数', updatedAt: Date.now() - 48 * 864e5 },
	{ name: 'UnrealEngine', docs: 45, excerpt: '渲染管线与性能优化', updatedAt: Date.now() - 49 * 864e5 },
	{ name: '未命名知识库', docs: 0, excerpt: '还没有内容' },
];
const HTML = () => renderHomePage({ vaultName: 'V', kbs: KBS });
const count = (s, re) => (s.match(re) || []).length;

// ── 语义映射纯函数 ──────────────────────────────────────────────────────────
check('① 五类语义图标按库名自动推断', () => {
	assert.equal(icons.iconForKb('财经').icon, 'coins');
	assert.equal(icons.iconForKb('AIAgent').icon, 'code');
	assert.equal(icons.iconForKb('游戏设计').icon, 'game');
	assert.equal(icons.iconForKb('ComfyUI技术').icon, 'palette');
	assert.equal(icons.iconForKb('UnrealEngine').icon, 'cube');
});
check('② 防误判：泛词「技术 / 设计」不许抢走更具体的分类', () => {
	assert.equal(icons.iconForKb('ComfyUI技术').icon, 'palette', '被技术类抢走');
	assert.equal(icons.iconForKb('游戏设计').icon, 'game', '被创作类抢走');
	assert.equal(icons.iconForKb('UnrealEngine').icon, 'cube', '被技术类抢走');
});
check('③ 未知库名 / 空名回落默认书本，且颜色各不相同', () => {
	assert.equal(icons.iconForKb('未命名知识库').icon, 'book');
	assert.equal(icons.iconForKb('').icon, 'book');
	assert.equal(icons.iconForKb(null).icon, 'book');
	const colors = ['财经', 'AIAgent', '游戏设计', 'ComfyUI技术', 'UnrealEngine'].map(n => icons.iconForKb(n).color);
	assert.equal(new Set(colors).size, 5, '语义色重复 ⇒ 图标失去辨识度');
});
check('④ svgIcon 输出内联 SVG，图标集 7 枚、无外链图片', () => {
	assert.equal(Object.keys(icons.ICONS).length, 7);
	for (const key of Object.keys(icons.ICONS)) {
		const out = icons.svgIcon(key);
		assert.ok(out.startsWith('<svg viewBox="0 0 24 24"') && out.includes('</svg>'), key + ' 不是内联 SVG');
	}
	assert.ok(!SRC.includes('<img') && !SRC.includes('https://'), '页面引了外链图片');
});

// ── 真源渲染 ────────────────────────────────────────────────────────────────
check('⑤ ★ 改版已落地：每卡 1 个 SVG 图标，旧渐变封面彻底移除', () => {
	const html = HTML();
	assert.equal(count(html, /class="ci"/g), KBS.length, '图标底数量不对');
	assert.equal(count(html, /class="ci"[^>]*>\s*<svg/g), KBS.length, '不是每卡都有内联 SVG');
	// ⚠ `class="bd"` 是页内弹窗（.modal .bd）的合法用法，不能当旧卡片残留来禁。
	for (const forbidden of ['class="cv"', 'linear-gradient(135deg', 'coverOf', '🔗 飞书', 'class="mt"']) {
		assert.ok(!html.includes(forbidden), '仍残留旧版「' + forbidden + '」');
	}
});
check('⑥ ★ 状态角标按真数据出现（不写死数量）', () => {
	const html = HTML();
	assert.equal(count(html, /class="cb-dot"/g), KBS.filter(k => k.weekNew).length, '7 天圆点数量不对');
	assert.equal(count(html, /class="cb-corner"/g), KBS.filter(k => k.hasFeishu && k.docs).length, '飞书角标数量不对');
	assert.equal(count(html, /class="cb-empty"/g), KBS.filter(k => !k.docs).length, '空库角标数量不对');
	assert.equal(count(html, /class="card empty"/g), KBS.filter(k => !k.docs).length, '空库虚线边框数量不对');
	assert.equal(count(html, /class="cb-chip"/g), KBS.length, '篇数 chip 数量不对');
});
check('⑦ 状态角标全部绝对定位（不占 flex 流、不撑高卡片）', () => {
	for (const sel of ['.cb-dot', '.cb-corner', '.cb-empty']) {
		const rule = new RegExp('\\' + sel.replace('.', '.') + '\\{[^}]*position:absolute');
		assert.ok(rule.test(SRC), sel + ' 缺 position:absolute');
	}
	assert.ok(/\.ci svg\{[^}]*stroke:currentColor/.test(SRC), 'SVG 没走 currentColor');
	assert.ok(/\.ci\{[^}]*width:40px;height:40px/.test(SRC), '图标底不是 40px');
});
check('⑧ 结构锚点未回归（check-kb-kblist 同款）', () => {
	const html = HTML();
	for (const needle of ['知识库主页', 'data-kb="财经"', 'id="newCard"', 'id="mask"', 'id="kbname"',
		"source: 'kb-home'", 'window.parent.postMessage', '/api/kb-bind', 'class="ex"']) {
		assert.ok(html.includes(needle), '丢了结构锚点 ' + needle);
	}
});
check('⑨ 上一轮主题修复未被带坏（两档媒体查询 + 父页令牌同步）', () => {
	const html = HTML();
	assert.ok(html.includes('@media (prefers-color-scheme: light)'), '缺浅色档');
	assert.ok(html.includes('syncHostTheme'), '缺父页令牌同步');
	assert.ok(html.includes('--dsw-alias-bg-base') && html.includes('--warn'), '主题变量被改版弄丢');
});
check('⑩ 反向突变自证：检测器能认出旧版渐变封面', () => {
	const old = '<div class="cv" style="background:linear-gradient(135deg, hsl(1 45% 34%), hsl(2 38% 18%))"></div>';
	assert.ok(/class="cv"|linear-gradient\(135deg/.test(old), '检测器失效：旧封面没被识别');
	assert.equal(count(HTML(), /class="cv"|linear-gradient\(135deg/g), 0, '真源里仍检出旧封面');
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { process.exit(1); }
