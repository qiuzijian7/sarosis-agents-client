// pele 渲染内核：Mermaid 源码 →（主题化的）SVG 字符串。
//
// 三件事只在这里做一次，两侧（dsh Host 的工具 / IDE 渲染进程）共用同一份产物与同一套口径：
//   ① 装载：`assets/pele.global.js`（IIFE，全局 `pele`）经 `new Function` 求值一次并缓存。
//      ⇒ 与 IDE 侧**同一个文件**（IDE 也是 `new Function` 注入），不存在"两边引擎版本不同"。
//   ② 渲染：`pele.render()` 是**同步、零 DOM 依赖**的（pele 用内置字宽表测文本）⇒ Node 里直接跑 ✓。
//   ③ 主题：pele 的颜色全是 `var(--pele-*, 兜底)` ⇒ 把预设变量**内联进根 `<svg>` 的 style**。
//      ⚠ 必须内联而不能靠父元素继承：聊天卡片把 SVG 放进 `<img src="blob:">`，那是**独立文档**，
//      宿主页面的 CSS 变量传不进去 ✗（这正是"深色下图还是白底"的成因）。
//
// ⚠ `withThemeVars()` 在 IDE 侧有一份 TS 孪生实现（`peleDiagramRenderer.ts`）⇒ **改这里必须同步改那边**
//   （两侧行为不一致会直接表现为"同一张图两个配色"）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assetsDir, themeVars } from './theme.js';

/** 源码上限（与 pele 默认一致：50000 字符；超限 pele 会抛 limit）。 */
export const SOURCE_LIMIT = 50000;

let peleModule = null;

/**
 * 装载 pele（一次）。
 *
 * 失败要**说清是哪个文件**而不是笼统的"渲染器不可用"——`assets/` 漏进 `files` 时，
 * 症状是"所有图表都渲染不出来"，提示必须能一步定位到漏打包 ✗。
 */
export function loadPele() {
	if (peleModule) { return peleModule; }
	const file = join(assetsDir(), 'pele.global.js');
	let code;
	try {
		code = readFileSync(file, 'utf8');
	} catch (e) {
		throw new Error(`pele 产物读不到：${file}（${e?.message ?? e}）—— 插件包的 files 里漏了 assets/pele.global.js？`);
	}
	// esbuild iife + globalName 的产物是 `var pele = (() => { ... })();` ⇒ 函数作用域里可 return ✓。
	const mod = new Function(code + '\nreturn pele;')();
	if (typeof mod?.render !== 'function') {
		throw new Error(`pele 产物格式不对（没有 render）：${file}`);
	}
	peleModule = mod;
	return mod;
}

/**
 * 把 CSS 变量内联进根 `<svg>` 的 style 属性。
 *
 * 只动**开标签**：pele 的 SVG 根标签自带 `style="max-width:100%;height:auto;--_bg:var(--pele-bg,#fff);..."`，
 * 追加到它后面即可（`var()` 在同一元素上声明+使用是合法的 ✓）。
 */
export function withThemeVars(svg, vars) {
	if (!svg || !vars) { return svg; }
	const decl = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
	if (!decl) { return svg; }
	const open = /<svg\b[^>]*>/u.exec(svg);
	if (!open) { return svg; }
	const tag = open[0];
	let next;
	if (/\sstyle\s*=\s*"/u.test(tag)) {
		next = tag.replace(/\sstyle\s*=\s*"([^"]*)"/u, (_all, value) => ` style="${String(value).replace(/;\s*$/u, '')};${decl}"`);
	} else {
		next = tag.replace(/>$/u, ` style="${decl}">`);
	}
	return svg.slice(0, open.index) + next + svg.slice(open.index + tag.length);
}

/** pele 的错误码 → 给模型/用户看的下一步（不同成因不同建议，混成一句会让模型在死路上重试 ✗）。 */
function hintFor(code) {
	switch (code) {
		case 'unsupported-diagram': return '这段文本没识别出图种（pele 覆盖 Mermaid 12.1.0 的全部图种）—— 检查首行是否是图种关键字（flowchart / sequenceDiagram / classDiagram / erDiagram ...），以及是否夹了散文或多余的代码围栏。';
		case 'syntax': return '语法错误：按 pele 报的位置改那一处即可（常见于节点文本里未转义的括号 / 引号、以及 ``` 围栏被一起贴进来）。';
		case 'semantic': return '语义错误（结构能解析但画不出来）：检查引用的节点 id 是否存在、子图是否闭合。';
		case 'limit': return '超出 pele 的大小上限：把图拆成几张，或减少节点/边（一行 `A & B --> C & D` 会乘出大量边）。';
		default: return '渲染失败：简化后重试，或改用另一种图种表达同样的信息。';
	}
}

/**
 * 渲染一张图。
 *
 * 返回 `{ ok, type, width, height, svg, links, error }`；失败时 `ok:false` 且带 `code` / `hint`
 * （**不抛** —— 工具层要给模型一条能照着改的提示，抛异常只会变成一句 "tool failed" ✗）。
 */
export function renderDiagram(source, options = {}) {
	const text = typeof source === 'string' ? source : '';
	if (!text.trim()) {
		return { ok: false, code: 'empty', message: '图源码为空', hint: '把 Mermaid 源码放进 source 参数。' };
	}
	const theme = options.theme === 'dark' ? 'dark' : 'default';
	let pele;
	try {
		pele = loadPele();
	} catch (e) {
		return { ok: false, code: 'loader', message: String(e?.message ?? e), hint: 'pele 产物没随包 —— 重装 @vssaros/dsh-pele。' };
	}
	let result;
	try {
		result = pele.render(text, {
			limit: SOURCE_LIMIT,
			...(typeof options.maxWidth === 'number' && options.maxWidth > 0 ? { maxWidth: options.maxWidth } : {}),
			...(typeof options.fontFamily === 'string' && options.fontFamily.trim() ? { fontFamily: options.fontFamily.trim() } : {}),
		});
	} catch (e) {
		const code = typeof e?.code === 'string' ? e.code : 'render';
		return { ok: false, code, message: String(e?.message ?? e), hint: hintFor(code) };
	}
	const svg = withThemeVars(result.svg, themeVars(theme));
	return {
		ok: true,
		type: result.type,
		width: result.width,
		height: result.height,
		svg,
		svgChars: svg.length,
		links: Array.isArray(result.links) ? result.links.length : 0,
		theme,
	};
}
