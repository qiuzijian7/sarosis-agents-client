/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';

/**
 * 主页（dsh dashboard）的**对比度**守卫。
 *
 * 背景（2026-10-22 用户判"颜色不可接受"）：主页的层级不用 `--dsw-alias-bg-layer-1` /
 * `border-l1` / `label-secondary`（它们在真实页面里分别等于 `sideBar.background` 更暗、
 * `panel.border` 1.1:1、以及亮色下等于正文色），而是由 `app.jsx` 的 `deriveTokens()` 按
 * 「页面底 + 前景 × 比例」现算 `--dash-*`。
 *
 * ⇒ 本守卫就是**把"可接受"变成数字**：拿 `RATIOS` × 真实底/前景，重算派生色与 WCAG 比值，
 *    任何一格掉到阈值以下就红。四个场景都要过：
 *      · dsh 官方亮 / 暗（vendor 的 `design-platform.css`）
 *      · **IDE 覆盖后**的亮 / 暗 —— 这才是用户真看到的（13 个 token 被 IDE 主题覆盖，
 *        暗色 base = `editor.background` #1F1F1F、前景 #CCCCCC；亮色 #FFFFFF / #3B3B3B）。
 *    只测官方那套会漏掉最危险的一档：官方暗色底是 rgb(21,21,23)，IDE 是 #1F1F1F，比的不是同一个底。
 *
 * ⚠ 阈值口径别乱套：卡片描边是**装饰**（WCAG 1.4.11 只管"交互件的边界"）⇒ 只要求可感知 ≥1.5；
 *   按钮/输入框那种交互件描边才要 3:1。一律按 3:1 卡会逼出一圈刺眼的亮边。
 */
suite('dshHarness / dashboard 主页颜色：派生层级必须过对比度阈值', () => {
	const repo = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
	const dashDir = join(repo, 'dsh-plugins', 'vssaros-dashboard');
	const appSrc = readFileSync(join(dashDir, 'lib', 'app', 'src', 'app.jsx'), 'utf8');
	const appCss = readFileSync(join(dashDir, 'lib', 'app', 'src', 'app.css'), 'utf8');
	const themeCss = readFileSync(join(dashDir, 'vendor', 'dsw-theme', 'design-platform.css'), 'utf8');

	interface Rgb { r: number; g: number; b: number }

	/** `#rgb` / `#rrggbb` / `rgb()` / `rgba()` → 字节三元组（不认识返回 undefined）。 */
	function toRgb(value: string | undefined): Rgb | undefined {
		if (!value) { return undefined; }
		const text = value.trim();
		const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
		if (hex) {
			const h = hex[1];
			if (h.length === 3) {
				return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
			}
			const n = parseInt(h, 16);
			return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
		}
		const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
		if (fn) {
			const parts = fn[1].split(',').map(x => Number.parseFloat(x));
			return { r: parts[0], g: parts[1], b: parts[2] };
		}
		return undefined;
	}

	/** WCAG 相对亮度。 */
	function luminance(c: Rgb): number {
		const channel = (v: number): number => {
			const s = v / 255;
			return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
		};
		return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
	}

	function contrast(a: Rgb, b: Rgb): number {
		const la = luminance(a) + 0.05;
		const lb = luminance(b) + 0.05;
		return la > lb ? la / lb : lb / la;
	}

	/** 与 `app.jsx` 的 `mix()` 同式：`fg * ratio + base * (1 - ratio)`。 */
	function mix(fg: Rgb, base: Rgb, ratio: number): Rgb {
		return {
			r: Math.round(fg.r * ratio + base.r * (1 - ratio)),
			g: Math.round(fg.g * ratio + base.g * (1 - ratio)),
			b: Math.round(fg.b * ratio + base.b * (1 - ratio)),
		};
	}

	/** 把 CSS 拆成 [{ dark, decls }]：`body[data-ds-dark-theme]` 的块算暗色档。 */
	function parseBlocks(css: string): Array<{ dark: boolean; decls: Map<string, string> }> {
		const blocks: Array<{ dark: boolean; decls: Map<string, string> }> = [];
		const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
		const re = /([^{}]+)\{([^{}]*)\}/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(withoutComments)) !== null) {
			const selector = m[1].trim();
			if (!/^body(\[data-ds-dark-theme\])?$/.test(selector)) { continue; }
			const decls = new Map<string, string>();
			for (const piece of m[2].split(';')) {
				const colon = piece.indexOf(':');
				if (colon < 0) { continue; }
				const name = piece.slice(0, colon).trim();
				const value = piece.slice(colon + 1).trim();
				if (name.startsWith('--')) { decls.set(name, value); }
			}
			blocks.push({ dark: selector.includes('data-ds-dark-theme'), decls });
		}
		return blocks;
	}

	/** 按作用域取变量并解开 `var()` 链（后来的块覆盖先前的，与浏览器层叠一致）。 */
	function makeResolver(blocks: Array<{ dark: boolean; decls: Map<string, string> }>) {
		const lookup = (name: string, dark: boolean): string | undefined => {
			let found: string | undefined;
			for (const block of blocks) {
				if (!dark && block.dark) { continue; }
				if (block.decls.has(name)) { found = block.decls.get(name); }
			}
			return found;
		};
		const resolve = (name: string, dark: boolean): Rgb | undefined => {
			let value = lookup(name, dark);
			for (let hop = 0; hop < 8 && value !== undefined; hop++) {
				const varRef = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
				if (!varRef) { return toRgb(value); }
				value = lookup(varRef[1], dark);
			}
			return undefined;
		};
		return { lookup, resolve };
	}

	const blocks = parseBlocks(themeCss);
	const resolver = makeResolver(blocks);

	/** 从 `app.jsx` 抽 `RATIOS`（派生比例的**唯一真源**，守卫必须读它而不是抄一份）。 */
	const ratiosMatch = /const RATIOS = \{([\s\S]*?)\n\};/.exec(appSrc);
	assert.ok(ratiosMatch, 'app.jsx 里找不到 RATIOS 常量（派生比例的真源）✗');

	function parseRatios(source: string): Record<string, Record<string, number>> {
		const out: Record<string, Record<string, number>> = {};
		const armRe = /(\w+):\s*\{([^}]*)\}/g;
		let arm: RegExpExecArray | null;
		while ((arm = armRe.exec(source)) !== null) {
			const entry: Record<string, number> = {};
			for (const piece of arm[2].split(',')) {
				const kv = /(\w+)\s*:\s*([\d.]+)/.exec(piece);
				if (kv) { entry[kv[1]] = Number.parseFloat(kv[2]); }
			}
			out[arm[1]] = entry;
		}
		return out;
	}

	const ratios = parseRatios(ratiosMatch![1]);

	const REQUIRED_KEYS = ['surface', 'surface2', 'stroke', 'stroke2', 'muted', 'faint'];

	test('RATIOS 有暗 / 亮 / 高对比三档，六个键齐全（一套比例打天下会一边过一边红）', () => {
		for (const mode of ['dark', 'light', 'hc']) {
			assert.ok(ratios[mode], `RATIOS 缺 ${mode} 档 ✗`);
			for (const key of REQUIRED_KEYS) {
				const value = ratios[mode][key];
				assert.ok(typeof value === 'number' && value > 0 && value < 1, `RATIOS.${mode}.${key} 不是 0–1 的比例 ✗`);
			}
		}
		assert.notDeepStrictEqual(ratios.dark, ratios.light, '明暗必须是两套比例（同一个比例两边不可能都过）✗');
		// 高对比档必须每一项都**比明暗两档更极端**（否则"高对比"只是换了个名字）
		for (const key of REQUIRED_KEYS) {
			const floor = Math.max(ratios.dark[key], ratios.light[key]);
			assert.ok(
				ratios.hc[key] >= floor,
				`RATIOS.hc.${key} = ${ratios.hc[key]} 没有比明暗两档（${floor}）更极端 ✗`,
			);
		}
	});

	// 四个场景：官方两档 + IDE 覆盖后两档（IDE 那两档才是用户真看到的）
	const officialLight = {
		name: 'dsh 官方 / 亮',
		base: resolver.resolve('--dsw-alias-bg-base', false),
		fg: resolver.resolve('--dsw-alias-label-primary', false),
		mode: 'light',
	};
	const officialDark = {
		name: 'dsh 官方 / 暗',
		base: resolver.resolve('--dsw-alias-bg-base', true),
		fg: resolver.resolve('--dsw-alias-label-primary', true),
		mode: 'dark',
	};
	// IDE 覆盖（VS Code Dark Modern / Light Modern 的真实取值）：
	//   dark = editor.background #1F1F1F / editor.foreground #CCCCCC
	//   light = editor.background #FFFFFF / editor.foreground #3B3B3B
	const ideDark = { name: 'IDE 覆盖 / 暗', base: { r: 31, g: 31, b: 31 }, fg: { r: 204, g: 204, b: 204 }, mode: 'dark' };
	const ideLight = { name: 'IDE 覆盖 / 亮', base: { r: 255, g: 255, b: 255 }, fg: { r: 59, g: 59, b: 59 }, mode: 'light' };

	const baseScenarios = [officialLight, officialDark, ideDark, ideLight];
	// 高对比档不区分明暗（见 RATIOS.hc 的注释）⇒ 四个底各再跑一遍 hc
	const hcScenarios = baseScenarios.map(scenario => ({
		...scenario,
		mode: 'hc',
		name: `${scenario.name.replace('：', '')} + 高对比：`,
	}));

	for (const scenario of [...baseScenarios, ...hcScenarios]) {
		test(`${scenario.name}：派生层级全部过阈值（正文 4.5 / 次要 4.5 / 弱 3.0 / 装饰描边 1.5 / 交互描边 3.0 / 抬升 1.12）`, () => {
			assert.ok(scenario.base, `${scenario.name}：解析不到 --dsw-alias-bg-base ✗`);
			assert.ok(scenario.fg, `${scenario.name}：解析不到 --dsw-alias-label-primary ✗`);
			const base = scenario.base!;
			const fg = scenario.fg!;
			const arm = ratios[scenario.mode];

			const surface = mix(fg, base, arm.surface);
			const stroke = mix(fg, base, arm.stroke);
			const stroke2 = mix(fg, base, arm.stroke2);
			const muted = mix(fg, base, arm.muted);
			const faint = mix(fg, base, arm.faint);

			const cases: Array<[string, number, number]> = [
				['正文 / 卡片底', contrast(fg, surface), 4.5],
				['次要文字 / 卡片底', contrast(muted, surface), 4.5],
				['弱文字 / 卡片底', contrast(faint, surface), 3.0],
				['卡片描边（装饰）/ 卡片底', contrast(stroke, surface), 1.5],
				['交互件描边 / 卡片底', contrast(stroke2, surface), 3.0],
				['卡片底 / 页面底', contrast(surface, base), 1.12],
			];
			const failures = cases
				.filter(([, got, min]) => got < min)
				.map(([label, got, min]) => `${label} ${got.toFixed(2)} < ${min}`);
			assert.deepStrictEqual(failures, [], `${scenario.name} 掉到阈值以下 ⇒ ${failures.join('；')} ✗`);
		});
	}

	test('app.css 的规则里不许出现裸颜色（层级只能来自 `--dash-*` / 官方 alias）', () => {
		// 剥掉注释再看：注释里举例 "#181818" 是允许的（说明用），规则里写死就是硬编码 ✗
		const withoutComments = appCss.replace(/\/\*[\s\S]*?\*\//g, '');
		const offenders = withoutComments
			.split(/\r?\n/)
			.map((line, index) => ({ line, no: index + 1 }))
			.filter(({ line }) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(line))
			.map(({ line, no }) => `第 ${no} 行: ${line.trim().slice(0, 60)}`);
		assert.deepStrictEqual(offenders, [], `app.css 里有写死的颜色（应该用 var(--dash-*) 或官方 alias）⇒ ${offenders.join('；')} ✗`);
	});

	test('派生色必须是**纯色**且由脚本写入（不能退回 CSS color-mix()）', () => {
		// color-mix 的两个问题：① 自定义属性读回的是声明原文（量不了对比度）；
		// ② 需要 Chromium 111+，本仓 Electron 版本不保证 ⇒ 派生一律放 JS、写成纯 hex。
		assert.ok(!/color-mix\(/.test(appCss), 'app.css 里出现了 color-mix() ✗（派生必须在 app.jsx 里算成纯 hex）');
		assert.ok(
			/root\.style\.setProperty\('--dash-surface', hex\(/.test(appSrc),
			'派生色必须由 deriveTokens() 写成纯 hex（CSS 变量内联）✗',
		);
	});
});
