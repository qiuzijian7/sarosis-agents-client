/*
 * Mermaid → SVG：复用仓库里**已有的 pele 引擎**（2026-10-26）。
 *
 * 为什么用 pele（此前是 vendor 进来的 mermaid.min.js 3.4MB）：
 *   · pele 是**同步、零 DOM 依赖**的（内置字宽表测文本）⇒ 能在服务端渲染，
 *     于是 `/x/kb/doc` 独立页、面板、页面三处**不需要任何客户端脚本**就有图；
 *   · 与 IDE 侧（`peleDiagramRenderer.ts`）和 dsh Host（`@vssaros/dsh-pele`）**同一份产物**；
 *   · 体积 666KB（装一次、服务端用），对比 vendor mermaid 3.4MB × 每个安装副本。
 *
 * 装载方式照抄 pele 自己的 `lib/core/render.js`：esbuild iife + globalName 的产物是
 * `var pele = (() => {...})();` ⇒ `new Function(code + '\nreturn pele;')()` 直接拿 API。
 *
 * ⚠⚠ 2026-10-26 真机事故（图表在面板里显示成源码）：**找资产的路径算错了一层**。
 *   当时写死了两条候选：`../../../@vssaros/dsh-pele/assets`（少一层）与
 *   `../../../../`（少一层）⇒ 仓库里跑对了（命中 `dsh-plugins/vssaros-pele`），
 *   但**安装布局里两条都不命中** ⇒ `pele` 加载失败 ⇒ 静默降级成源码块。
 *   ⇒ 现在改为**从自身所在目录向上逐层探测**（最多 8 层），每层都试四种形态：
 *      `<lvl>/vssaros-pele/assets`
 *      `<lvl>/@vssaros/dsh-pele/assets`
 *      `<lvl>/node_modules/@vssaros/dsh-pele/assets`
 *      `<lvl>` 若是 plugins 目录 ⇒ 取最新的 `vssaros-dsh-pele-<ver>/assets`
 *   这条逻辑**独立成可测函数** `pickAssetsDir(startDir)`，守卫用假目录树验证
 *   （否则又是"仓库里对、装完错"）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));            // vssaros-kb/lib/md

const hasAsset = (dir) => {
	try { return existsSync(join(dir, 'pele.global.js')); } catch { return false; }
};

/**
 * 从 `startDir` 向上逐层找 `assets/`（纯函数，便于测试）。
 * @returns 找到的 assets 目录；找不到返回 `''`
 */
export function pickAssetsDir(startDir) {
	let dir = resolve(startDir);
	for (let depth = 0; depth < 8; depth++) {
		const candidates = [
			join(dir, 'vssaros-pele', 'assets'),
			join(dir, '@vssaros', 'dsh-pele', 'assets'),
			join(dir, 'node_modules', '@vssaros', 'dsh-pele', 'assets'),
		];
		for (const c of candidates) {
			if (hasAsset(c)) { return c; }
		}
		// plugins 目录：`vssaros-dsh-pele-<ver>` 取版本最高的那个
		try {
			const hit = readdirSync(dir)
				.filter(n => /^vssaros-dsh-pele-[0-9]/.test(n))
				.sort()
				.reverse()[0];
			if (hit && hasAsset(join(dir, hit, 'assets'))) { return join(dir, hit, 'assets'); }
		} catch { /* 不是目录 / 无权限 ⇒ 继续向上 */ }

		const parent = dirname(dir);
		if (parent === dir) { break; }
		dir = parent;
	}
	return '';
}

let assetsCached = '';
let assetsResolved = false;

/** 本进程实际使用的 assets 目录（`KB_PELE_ASSETS` 可覆盖，便于诊断/测试）。 */
export function peleAssetsDir() {
	if (!assetsResolved) {
		assetsResolved = true;
		assetsCached = String(process.env.KB_PELE_ASSETS ?? '') || pickAssetsDir(HERE);
	}
	return assetsCached;
}

let cached;   // undefined = 还没试；null = 不可用；{ render, ... }
let themeCached = null;

/** 以 `$` 开头的键是注释而不是 CSS 变量 */
const isNoteKey = (k) => k.startsWith('$');

/**
 * 取一个预设的 CSS 变量表。读不到就回空对象（**不抛**：缺主题只影响配色）。
 */
export function themeVars(theme) {
	const key = theme === 'dark' ? 'dark' : 'default';
	if (themeCached) { return themeCached[key] ?? {}; }
	themeCached = {};
	try {
		const dir = peleAssetsDir();
		if (dir) {
			const parsed = JSON.parse(readFileSync(join(dir, 'pele-theme.json'), 'utf8'));
			for (const [name, vars] of Object.entries(parsed?.presets ?? {})) {
				themeCached[name] = Object.fromEntries(Object.entries(vars ?? {}).filter(([k]) => !isNoteKey(k)));
			}
		}
	} catch { /* 主题不可用 ⇒ 用 pele 自带兜底色 */ }
	return themeCached[key] ?? {};
}

/** 把 CSS 变量内联进根 `<svg>` 的 style（pele 的颜色都是 `var(--pele-*, 兜底)`）。 */
function withThemeVars(svg, vars) {
	const decl = Object.entries(vars ?? {}).map(([k, v]) => `${k}:${v}`).join(';');
	if (!decl) { return svg; }
	const open = /<svg\b[^>]*>/u.exec(svg);
	if (!open) { return svg; }
	const tag = open[0];
	const next = /\sstyle\s*=\s*"/u.test(tag)
		? tag.replace(/\sstyle\s*=\s*"([^"]*)"/u, (_all, value) => ` style="${String(value).replace(/;\s*$/u, '')};${decl}"`)
		: tag.replace(/>$/u, ` style="${decl}">`);
	return svg.slice(0, open.index) + next + svg.slice(open.index + tag.length);
}

/** 装载 pele（一次，同步）。不可用时返回 null（调用方降级为源码显示）。 */
function loadPele() {
	if (cached !== undefined) { return cached; }
	try {
		const dir = peleAssetsDir();
		if (!dir) { cached = null; return cached; }
		const code = readFileSync(join(dir, 'pele.global.js'), 'utf8');
		const api = new Function(code + '\nreturn pele;')();
		cached = typeof api?.render === 'function' ? api : null;
	} catch {
		cached = null;
	}
	return cached;
}

export const MERMAID_SOURCE_LIMIT = 50000;

/**
 * Mermaid 源码 →（主题化的）SVG 字符串。
 *
 * @returns `''` 表示"当前环境渲染不了"（没找到 pele / 语法错 / 超限）
 *          —— 调用方据此**保留源码块**，绝不吞掉内容。
 */
export function renderMermaidSvg(source, theme = 'dark') {
	const src = String(source ?? '');
	if (!src.trim()) { return ''; }
	if (src.length > MERMAID_SOURCE_LIMIT) { return ''; }
	const pele = loadPele();
	if (!pele) { return ''; }
	try {
		const out = pele.render(src, { theme: theme === 'dark' ? 'dark' : 'default' });
		if (!out || out.ok === false || typeof out.svg !== 'string' || !out.svg) { return ''; }
		return withThemeVars(out.svg, themeVars(theme));
	} catch {
		return '';
	}
}

/** 自检用：当前环境是否可用 pele */
export function peleAvailable() {
	return !!loadPele();
}

/** 自检用：不可用时给出**可读原因**（别再静默降级成源码） */
export function peleDiagnostics() {
	const dir = peleAssetsDir();
	if (!dir) { return { ok: false, reason: '没找到 pele 的 assets 目录（pele.global.js）', assetsDir: '' }; }
	if (!loadPele()) { return { ok: false, reason: 'pele.global.js 读到了但装载失败（格式不对？）', assetsDir: dir }; }
	return { ok: true, reason: '', assetsDir: dir };
}
