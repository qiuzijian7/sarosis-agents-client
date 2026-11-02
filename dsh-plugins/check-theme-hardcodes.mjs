/*
 * 主题守卫：**内联样式里不许写死表面色**（2026-11-02）。
 *
 * ## 为什么需要它（真机事故）
 * 用户报「dsh 侧切换外观后，部分页面没有一起变」。真机取证（dev 实例 CDP 9799）：
 * 把 dsh 调色板切到浅色后，页面里仍有 **50 个元素**保持深底浅字，逐个读内联样式全是
 * 知识库侧栏的写死值 —— 标签胶囊 `background:'#2a2d2e'` / `border:'1px solid #383838'` /
 * `color:'#c8c8c8'`、底栏 `background:'#1a1a1a'`。
 *
 * 这类写死的**表面色**与 `--dsw-alias-*` 令牌的差别是：令牌随 dsh 调色板切换，写死的不动
 * ⇒ 一半界面跟着变、一半不变。而它**不报错、不白屏**，只在切主题时露馅 ⇒ 必须靠守卫拦。
 *
 * ## 判据（刻意收窄，避免误报）
 * 只看 JS 对象字面量里的样式键：`background` / `backgroundColor` / `border*`。
 * 值里出现的**字符串字面量**若以 `#` 或 `rgb(`/`rgba(` 开头 ⇒ 违规；
 * 但下面三类放行：
 *   ① 以 `var(` 开头的字符串（= 令牌 + 兜底，如 `var(--dsw-alias-bg-base, #1e1e1e)`）；
 *   ② 中性叠加 `rgba(127,127,127,α)` / `rgba(128,128,128,α)`（明暗两边都成立）；
 *   ③ `transparent` / `inherit` / `currentColor` / `none`（本来就不是颜色常量）。
 *
 * ⚠ 不覆盖的范围（另有守卫/约定，别把本脚本当成全覆盖）：
 *   · CSS 文本里写死的颜色（模板串里的 `background:#1e1e1e`）—— 由工作台样式守卫与真机验收兜；
 *   · 文字色 `color:'#e06c75'`（强调色，明暗都成立，刻意放行）；
 *   · canvas 绘制用的 JS 调色板（不是 DOM 表面色）。
 *
 * Usage（仓库根）：node dsh-plugins/check-theme-hardcodes.mjs [--self-test]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PLUGINS = path.join(ROOT, 'dsh-plugins');

/** 中性叠加：明暗主题下都是"同一层灰"，不算写死表面色。 */
const NEUTRAL = [/\brgba?\(\s*127\s*,\s*127\s*,\s*127\b/i, /\brgba?\(\s*128\s*,\s*128\s*,\s*128\b/i];

/** 只看这些样式键（`color` 是强调色，刻意不看）。 */
const STYLE_KEY = /\b(background|backgroundColor|border|borderTop|borderBottom|borderLeft|borderRight|borderColor)\s*:\s*/g;

/**
 * 属性边界：扫一个键的值时，遇到**下一个**属性就截断。
 * 必须包含 `color`（不扫它，但要靠它把 `background/border` 的值隔开，否则会把强调色算进来）。
 */
const BOUNDARY = /\b(background|backgroundColor|border[A-Za-z]*|color|outline|boxShadow|filter|opacity|font[A-Za-z]*|padding[A-Za-z]*|margin[A-Za-z]*|width|height|minWidth|maxWidth|minHeight|maxHeight|top|left|right|bottom|zIndex|display|flex[A-Za-z]*|gap|overflow|overflowX|overflowY|position|textAlign|cursor|pointerEvents|userSelect|lineHeight|letterSpacing|transform|transition|whiteSpace|boxSizing|inset)\s*:/g;

function isLiteralColor(literal) {
	const v = literal.trim();
	if (!/^(#[0-9a-fA-F]{3,8}\b|rgba?\()/.test(v)) {
		return false;                       // var(...) / transparent / 其它表达式 ⇒ 放行
	}
	if (NEUTRAL.some((re) => re.test(v))) {
		return false;                       // 中性叠加（明暗都成立）⇒ 放行
	}
	// ⑥ 只抓**表面色**：不透明（或近乎不透明）且**近灰**的才随主题翻车。
	//    强调色（状态灯/头像色/品牌色）与半透明叠加（进度条、选中底、阴影）明暗都成立 ⇒ 放行。
	const rgb = parseRgb(v);
	if (!rgb) {
		return false;                       // 解析不了（如源码里的占位写法）⇒ 不判，避免误报
	}
	const [r, g, b, a] = rgb;
	if (a < 0.6) {
		return false;                       // 半透明：叠在什么上面都还要看底色 ⇒ 不算写死表面色
	}
	return Math.max(r, g, b) - Math.min(r, g, b) <= 24;   // 近灰（饱和色 = 强调色，放行）
}

/** `#rgb/#rrggbb/#rrggbbaa/rgb()/rgba()` → [r,g,b,a]；解析不了返回 undefined。 */
function parseRgb(value) {
	const v = value.trim();
	const hex = /^#([0-9a-fA-F]{3,8})$/.exec(v);
	if (hex) {
		let h = hex[1];
		if (h.length === 3 || h.length === 4) {
			h = h.split('').map((ch) => ch + ch).join('');
		}
		if (h.length !== 6 && h.length !== 8) {
			return undefined;
		}
		const n = parseInt(h.slice(0, 6), 16);
		const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
	}
	const fn = /^rgba?\(([^)]*)\)$/i.exec(v);
	if (!fn) {
		return undefined;
	}
	const parts = fn[1].split(',').map((x) => parseFloat(x));
	if (parts.length < 3 || parts.slice(0, 3).some((x) => Number.isNaN(x))) {
		return undefined;
	}
	const a = parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1;
	return [parts[0], parts[1], parts[2], a];
}

/**
 * 从 `key:` 之后取**这一个属性**的值的窗口（到下一个属性键 / 对象结束为止），
 * 再挑出其中写死的颜色字面量。
 *
 * ⚠ 不能简单取 400 字符：那会把下一个属性（尤其 `color:'#e06c75'` 这类强调色）算进来 ⇒ 误报。
 *   2026-11-02 第一版就是这么误报的，被 `--self-test` 的正对照当场抓住。
 */
function literalsAfter(text, from) {
	BOUNDARY.lastIndex = from;
	const next = BOUNDARY.exec(text);
	const end = Math.min(next ? next.index : text.length, from + 400);
	const window = text.slice(from, end);
	const out = [];
	const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
	let m;
	while ((m = re.exec(window)) !== null) {
		const value = m[2];
		if (isLiteralColor(value)) {
			out.push({ value: value.trim(), at: from + m.index });
		}
	}
	return out;
}

function scanFile(file) {
	const text = fs.readFileSync(file, 'utf8');
	const hits = [];
	STYLE_KEY.lastIndex = 0;
	let m;
	while ((m = STYLE_KEY.exec(text)) !== null) {
		for (const lit of literalsAfter(text, m.index + m[0].length)) {
			const line = text.slice(0, lit.at).split('\n').length;
			hits.push({ line, value: lit.value, key: m[1] });
		}
	}
	return hits;
}

function walk(dir, out) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'node_modules' || e.name === 'mockups' || e.name === 'test' || e.name === 'vendor') { continue; }
			walk(p, out);
			continue;
		}
		if (!e.name.endsWith('.js')) { continue; }
		// 只扫**在页模块**（client*.js）与宿主页脚本：服务端 index.js 不参与页面渲染，写死色影响不到主题
		if (!/^client.*\.js$/.test(e.name) && !/^(pageScript|page-boot|homePage|graphPage)$/.test(e.name)) { continue; }
		out.push(p);
	}
}

function selfTest() {
	// 负对照①：真机事故里的那几行必须被抓到（写死的近灰不透明表面色）
	const bad = `{ style: { background: tagFilter === t.tag ? 'var(--dsw-alias-button-primary-fill, #0e639c)' : '#2a2d2e',` +
		` border: '1px solid ' + (tagFilter === t.tag ? 'transparent' : '#383838'), color: '#c8c8c8' } }`;
	// 负对照②：近乎不透明的深灰底（tooltip / 面板）也算表面色
	const bad2 = `{ style: { background: 'rgba(30,30,30,.95)', color: '#fff' } }`;
	// 正对照：令牌 + 兜底、中性叠加、强调色、半透明叠加、transparent 都必须放行
	const good = `{ style: { background: 'var(--dsw-alias-bg-layer-1, #252526)',` +
		` border: '1px solid rgba(127,127,127,.25)', color: '#e06c75', outline: '2px solid transparent' } }\n` +
		`const a = { background: '#3fb950' };          // 状态灯（强调色）\n` +
		`const b = { background: 'rgba(255,255,255,.10)' };  // 半透明叠加（进度条底）\n` +
		`const c = { backgroundColor: 'rgba(192,139,255,.12)' }; // 头像底（半透明 + 饱和）`;
	const tmp = path.join(ROOT, 'dsh-plugins', '.check-theme-hardcodes.selftest.js');
	const results = [];
	try {
		fs.writeFileSync(tmp, `export const bad = ${bad};\nexport const bad2 = ${bad2};\nexport const good = ${good};\n`, 'utf8');
		const hits = scanFile(tmp);
		const badCaught = hits.some((h) => /#2a2d2e/.test(h.value));
		const borderCaught = hits.some((h) => /#383838/.test(h.value));
		const tooltipCaught = hits.some((h) => /rgba\(30,30,30/.test(h.value));
		const accentPassed = !hits.some((h) => /#3fb950/.test(h.value));
		const translucentPassed = !hits.some((h) => /rgba\(255,255,255/.test(h.value) || /rgba\(192,139,255/.test(h.value));
		const tokenPassed = !hits.some((h) => /var\(|127|128|#e06c75|transparent/.test(h.value));
		results.push(['写死的 chip 底 #2a2d2e 被抓到', badCaught]);
		results.push(['写死的 chip 边 #383838 被抓到', borderCaught]);
		results.push(['近乎不透明的深灰底 rgba(30,30,30,.95) 被抓到', tooltipCaught]);
		results.push(['强调色 #3fb950（状态灯）放行', accentPassed]);
		results.push(['半透明叠加 rgba(255,255,255,.10) / rgba(192,139,255,.12) 放行', translucentPassed]);
		results.push(['var() / 中性叠加 / 文字色 / transparent 放行', tokenPassed]);
	} finally {
		try { fs.unlinkSync(tmp); } catch { /* 已经没了 */ }
	}
	let failed = 0;
	for (const [name, ok] of results) {
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
		if (!ok) { failed++; }
	}
	console.log(failed ? `\n[check-theme-hardcodes] ✗ ${failed} 项自检失败` : `\n[check-theme-hardcodes] ✓ 自检通过（${results.length}/${results.length}）`);
	return failed === 0 ? 0 : 1;
}

if (process.argv.includes('--self-test')) {
	process.exit(selfTest());
}

const files = [];
walk(PLUGINS, files);

let problems = 0;
console.log(`[check-theme-hardcodes] 扫描 ${files.length} 个在页脚本：内联样式里不许写死表面色`);
for (const file of files) {
	const rel = path.relative(ROOT, file).replace(/\\/g, '/');
	let hits;
	try { hits = scanFile(file); } catch (e) {
		console.log(`  FAIL  ${rel}: 读不了（${e && e.message}）`);
		problems++;
		continue;
	}
	for (const h of hits) {
		console.log(`  FAIL  ${rel}:${h.line}  ${h.key} 写死了 ${h.value}`);
		problems++;
	}
}

if (problems) {
	console.log(`\n[check-theme-hardcodes] ✗ ${problems} 处写死的表面色 —— 改成 var(--dsw-alias-*, <兜底>)`);
	console.log('  为什么：写死的表面色不随 dsh「外观」切换 ⇒ 一半界面跟着变、一半不变（2026-11-02 真机事故）');
	process.exit(1);
}
console.log('\n[check-theme-hardcodes] ✓ 没有写死的表面色（全部走 --dsw-alias-* 令牌）');
