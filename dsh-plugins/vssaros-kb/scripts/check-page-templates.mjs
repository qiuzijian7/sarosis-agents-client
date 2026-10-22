/*
 * 守卫：页面模板串不许被"注释里的反引号"提前闭合，且必须能**真的求值**。
 *
 * ★ 为什么需要它（2026-10-19 的真实事故 ✗）：我把 `.dsh-search-ico` 连同反引号写进了
 *   `toolbar` 模板串里的 HTML 注释 ⇒ 模板串在 `.dsh` 前就被闭合，
 *   接着 `dsh-search-ico` 被当成 **JS 减法表达式**（dsh - search - ico）⇒
 *   服务端渲染时抛 `search is not defined`，整个页面只剩一行错误文字 ✗。
 *   ⚠ 关键：`node --check` **抓不到** —— 它是合法语法 ✓（所以"语法通过"不等于"能渲染"✗）。
 *
 * 本脚本查四件事：
 *   ① 任何 HTML 注释里都**不许出现反引号**（事故直接原因）；
 *   ② 关键模板串能完整提取 ＋ **内容里不许有反引号**（被提前闭合后长度反而可能更大 ⇒ 只看长度抓不到）；
 *   ③ index.js 里那三处树/分区模板串的锚点还在（改名/重构时提醒）；
 *   ④ **运行时求值冒烟**：把模板串真的求值一次（唯一能抓住 ReferenceError 的办法）。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-page-templates.mjs
 * 反向突变：往任一 HTML 注释里加一对反引号 ⇒ ① 应报红。
 *
 * ★ 2026-10-19：从"只查 index.js"扩成"多文件" —— 关系图谱页面（`lib/graphPage.js`，
 *   从 IDE 侧迁来）同样把 CSS/JS 以模板串拼进页面，同样会因为一个反引号整页白屏。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LIB = HERE + '../lib/';

/** 每个文件要校验的模板串（min 是"被提前闭合时长度会骤降"的经验下限） */
const FILES = [
	{
		file: 'index.js',
		templates: [
			{ name: 'PAGE_CSS', min: 10000, vars: ['CODICON_FONT_CSS'] },
			{ name: 'toolbar', min: 800, vars: ['escapeHtml', 'codicon', 'tagOptions'] },
			// ★ 2026-10-19（第 5 次踩同一坑后补的）：**页内脚本也要查"内容里没有反引号"**。
			//   本轮我在 KB_SCRIPT 的注释里写了 `` `location.href` `` ⇒ 模板串提前闭合、
			//   `node --check` 报错，但**两条守卫当时都是绿的** ✗ ——
			//   因为 ① check-page-templates 只查 PAGE_CSS/toolbar（不覆盖 KB_SCRIPT）；
			//       ② check-page-script 抽到的是**截断后**的脚本，no-undef 自然干净。
			//   ⇒ 把脚本也纳入"内容无反引号"这条（`noEval: true`：脚本里有插值，不做整串求值）。
			{ name: 'KB_SCRIPT', min: 60000, vars: [], noEval: true },
			{ name: 'DOC_PREVIEW_SCRIPT', min: 1500, vars: [], noEval: true },
		],
		// 三处树/分区模板串（三元/return 形式）：只查锚点还在（防重构后守卫静默失效）
		spots: [
			{ name: 'treeDirHtml 返回值', anchor: 'return `<li class="dsh-node dir"' },
			{ name: 'treeFileHtml 返回值', anchor: 'return `<li class="dsh-node${ctx.pendingSet' },
			{ name: 'sectionHtml 返回值', anchor: 'return `<section class="dsh-section open' },
		],
	},
	{
		file: 'graphPage.js',
		templates: [
			// 页面 CSS / 页内脚本都刻意**不用 ${} 插值**（见文件头注释）⇒ vars 为空
			{ name: 'GRAPH_CSS', min: 500, vars: [] },
			{ name: 'GRAPH_SCRIPT', min: 10000, vars: [] },
		],
		spots: [],
	},
];

/** 求值冒烟用的桩（新增插值变量时要跟着补 —— 报红是提示，不是误报） */
const STUBS = {
	escapeHtml: (s) => String(s ?? ''),
	codicon: (n) => '<span class="dsh-cod dsh-cod-' + n + '"></span>',
	CODICON_FONT_CSS: '/*font*/',
	tagOptions: '',
};

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
	if (ok) { pass++; console.log('PASS  ' + name + (detail ? '  — ' + detail : '')); }
	else { fail++; console.log('FAIL  ' + name + '  — ' + detail); }
};

const grab = (src, name) => src.match(new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*`([\\s\\S]*?)`;'));

for (const target of FILES) {
	let src;
	try {
		src = readFileSync(LIB + target.file, 'utf8');
	} catch (e) {
		check('① ' + target.file + ' 能读取', false, String(e?.message ?? e));
		continue;
	}

	// ① HTML 注释里禁反引号（附行号便于定位）
	const bad = [];
	for (const m of src.matchAll(/<!--[\s\S]*?-->/g)) {
		if (!m[0].includes('`')) { continue; }
		bad.push('第 ' + src.slice(0, m.index).split('\n').length + ' 行');
	}
	check('① ' + target.file + ' 的 HTML 注释里没有反引号',
		bad.length === 0, bad.length ? bad.join('; ') : '干净');

	for (const tpl of target.templates) {
		const m = grab(src, tpl.name);
		check('② ' + target.file + ' :: ' + tpl.name + ' 能完整提取（长度 ≥ ' + tpl.min + '）',
			!!m && m[1].length >= tpl.min, m ? m[1].length + ' 字符' : '提取失败（被提前闭合 ✗）');
		check('② ' + target.file + ' :: ' + tpl.name + ' 内容里没有反引号',
			!!m && !m[1].includes('`'), m && m[1].includes('`') ? '含反引号 ⇒ 已被提前闭合' : '干净');
		// `noEval` 的（页内脚本）只做"无反引号"这一条：脚本里有插值，整串求值没意义
		if (!m || tpl.noEval) { continue; }
		// ④ 真求值（唯一能抓住 search is not defined 的那一步）
		try {
			const out = new Function(...tpl.vars, 'return `' + m[1] + '`;')(...tpl.vars.map(v => STUBS[v]));
			check('④ ' + target.file + ' :: ' + tpl.name + ' 求值冒烟（渲染期不抛 ReferenceError）',
				true, out.length + ' 字符');
		} catch (e) {
			check('④ ' + target.file + ' :: ' + tpl.name + ' 求值冒烟（渲染期不抛 ReferenceError）',
				false, e.name + ': ' + e.message);
		}
	}

	for (const spot of target.spots) {
		const at = src.indexOf(spot.anchor);
		check('③ ' + target.file + ' :: ' + spot.name + ' 起点存在', at >= 0, at >= 0 ? 'ok' : '锚点找不到（改名了？）');
	}
}

console.log(`\n${pass}/${pass + fail} passed` + (fail ? `  ✗ ${fail} 条红` : '  ✓'));
process.exit(fail ? 1 : 0);
