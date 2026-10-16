/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「dsh 插件商城」**编辑区页面**的源码契约守卫（2026-10-14）。
 *
 * 为什么需要：这类页面有三处"编译期看不出来、运行也不报错"的缺陷：
 *   ① `EditorInput.editorId` 与 `EditorPane.ID` **必须同值**（写错就是"点了按钮没反应"）——跨文件，编译器不查；
 *   ② 页面里的类名**必须有 CSS**（本仓 2026-10-11 那次收敛：dsh 页签整页没样式就是这类）；
 *   ③ 安装**通道判据只许有一处实现**（`common/dshPluginTransport.ts`）——本页若自己写"是不是 path / 有没有名字"，
 *      两条路就会漂成"点了允许还是没建"这类最难查的错觉（该模块头注释记着历史事故）。
 *
 * 口径与 `dshPluginsView.test.ts` 一致：只扫源码形态 + 类名覆盖，不做 DOM 渲染。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const REL_INPUT = 'src/vs/sessions/contrib/agentStudio/browser/dshPluginMarketEditorInput.ts';
const REL_PANE = 'src/vs/sessions/contrib/agentStudio/browser/dshPluginMarketEditorPane.ts';
const REL_CSS = 'src/vs/sessions/contrib/agentStudio/browser/media/dshPluginMarketEditorPane.css';
const REL_CONTRIB = 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts';
const REL_VIEW = 'src/vs/sessions/contrib/agentStudio/browser/views/pluginsView.ts';

/** 不在本页面 CSS 里定义的类名（框架 / 主题负责）。 */
const NOT_OURS = new Set<string>([]);

function readFromRepoRoot(rel: string): string | undefined {
	// runner 约定从仓库根执行（`node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs`）。
	const abs = path.join(process.cwd(), rel);
	return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
}

/** 收集"会被挂到元素上的类名" → 首次出现的行号（`$('div.a.b')` / `classList.x('y')` / `className = 'y'`）。 */
function classesUsed(source: string): Map<string, number> {
	const found = new Map<string, number>();
	const add = (name: string, line: number) => {
		if (name && !found.has(name)) {
			found.set(name, line);
		}
	};
	source.split(/\r?\n/).forEach((line, index) => {
		const lineNo = index + 1;
		for (const m of line.matchAll(/\$\((['"])([^'"]+)\1\)/g)) {
			for (const c of m[2].matchAll(/\.([A-Za-z][\w-]*)/g)) {
				add(c[1], lineNo);
			}
		}
		for (const m of line.matchAll(/classList\.(?:add|toggle|remove)\(([^)]*)\)/g)) {
			for (const c of m[1].matchAll(/'([A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*)*)'/g)) {
				for (const single of c[1].split(/\s+/)) {
					add(single, lineNo);
				}
			}
		}
		for (const m of line.matchAll(/className\s*=\s*'([^']+)'/g)) {
			for (const single of m[1].split(/\s+/)) {
				add(single, lineNo);
			}
		}
	});
	return found;
}

function classesInCss(source: string): Set<string> {
	const out = new Set<string>();
	for (const m of source.matchAll(/\.([A-Za-z][\w-]*)/g)) {
		out.add(m[1]);
	}
	return out;
}

const PANE_ID = 'workbench.editor.dshPluginMarket';

suite('dsh 插件商城页（编辑区）契约守卫', () => {
	const input = readFromRepoRoot(REL_INPUT);
	const pane = readFromRepoRoot(REL_PANE);
	const css = readFromRepoRoot(REL_CSS);
	const contrib = readFromRepoRoot(REL_CONTRIB);
	const view = readFromRepoRoot(REL_VIEW);

	test('五个相关文件都读得到（守卫自身的前置）', () => {
		for (const [rel, src] of [[REL_INPUT, input], [REL_PANE, pane], [REL_CSS, css], [REL_CONTRIB, contrib], [REL_VIEW, view]] as const) {
			assert.ok(src, `读不到 ${rel}`);
		}
	});

	test('★ input 与 pane 的编辑器 id 必须同值（写错就是"点按钮没反应"，编译器查不到）', () => {
		assert.ok(input!.includes(`static readonly TypeID = 'workbench.editors.dshPluginMarketInput'`),
			'输入类型 id 变了（改它要同步贡献里的类型引用）');
		assert.ok(input!.includes(`return '${PANE_ID}';`), `\`editorId\` 必须是 '${PANE_ID}'`);
		assert.ok(pane!.includes(`static readonly ID = '${PANE_ID}'`), `\`DshPluginMarketEditorPane.ID\` 必须是 '${PANE_ID}'`);
	});

	test('input 是单例语义（重复点按钮只聚焦同一个 tab，不堆页面）', () => {
		assert.ok(input!.includes('static getInstance(): DshPluginMarketEditorInput'), '要有 getInstance()');
		assert.ok(input!.includes('EditorInputCapabilities.Singleton'), 'capabilities 必须含 Singleton');
		assert.ok(input!.includes('EditorInputCapabilities.Readonly'), '页面是只读型（不是文档）');
		assert.ok(/matches\(otherInput[\s\S]{0,120}instanceof DshPluginMarketEditorInput/.test(input!), 'matches() 要按类型判同一页面');
	});

	test('EDITOR-PANE 注册：pane + 它的输入都在贡献里（否则打开会失败）', () => {
		assert.ok(contrib!.includes('DshPluginMarketEditorPane') && contrib!.includes('DshPluginMarketEditorInput'),
			'贡献文件必须 import 这两者');
		assert.ok(/registerEditorPane\([\s\S]{0,240}DshPluginMarketEditorPane\.ID/.test(contrib!),
			'必须 registerEditorPane（用 pane 的 ID）');
		assert.ok(contrib!.includes('new SyncDescriptor(DshPluginMarketEditorInput)'),
			'必须把输入登记为 SyncDescriptor（否则 openEditor 找不到 pane）');
	});

	test('侧栏入口：按钮 → `_openDshPluginMarket()` → openEditor（三步都要在）', () => {
		assert.ok(view!.includes("localize('dshOpenMarket'"), '「添加插件」段里要有入口按钮文案');
		assert.ok(view!.includes('private _openDshPluginMarket(): void'), '要有打开方法');
		assert.ok(/private _openDshPluginMarket[\s\S]{0,400}DshPluginMarketEditorInput\.getInstance\(\)/.test(view!),
			'打开方法里要用单例输入');
		assert.ok(/private _openDshPluginMarket[\s\S]{0,600}openEditor\(input/.test(view!),
			'打开方法里要调 openEditor');
	});

	test('★ 安装通道判据只许一处实现：本页必须 import 共享纯函数，且不得自己判形态', () => {
		assert.ok(pane!.includes("from '../common/dshPluginTransport.js'") && pane!.includes('dshInstallTransport('),
			'本页要走 `common/dshPluginTransport.ts` 的选路纯函数（与侧栏同一判据）');
		assert.ok(!/kind\s*===\s*'path'/.test(pane!) && !/kind\s*===\s*'registry'/.test(pane!),
			'本页不许自己判 `kind` 选通道——那就是第二处实现（会与侧栏漂开）');
	});

	test('数据源复用共享模块（不在页面里另造目录 / 推荐清单）', () => {
		assert.ok(pane!.includes("from './dshMarketCatalog.js'") && pane!.includes('fetchDshMarketCatalog('),
			'社区目录要复用 `browser/dshMarketCatalog.ts`');
		assert.ok(pane!.includes('dshMarketInstallSpec('), '安装 spec 要复用 `dshMarketInstallSpec`（npm 优先策略同源）');
		assert.ok(pane!.includes("from '../common/dshPluginRecommendations.js'") && pane!.includes('dshPluginRecommendations('),
			'官方推荐要复用 `common/dshPluginRecommendations.ts`');
	});

	test('本页无内联静态样式（与大方向一致：静态样式进 CSS）', () => {
		assert.ok(!pane!.includes('style.cssText'), '不许用 `style.cssText`（只有 layout 里的动态尺寸可以写 `.style.x = 值`）');
	});

	test('每个用到的类名都有 CSS 规则（"整页没样式"这种缺陷不许再发生）', () => {
		const used = classesUsed(pane!);
		const defined = classesInCss(css!);
		const missing = [...used.entries()]
			.filter(([name]) => !defined.has(name) && !NOT_OURS.has(name))
			.map(([name, line]) => `${name}(:${line})`)
			.sort();
		assert.deepStrictEqual(missing, [], `这些类名在页面里用了，但 ${REL_CSS} 里没有规则：${missing.join('、')}`);
	});

	test('页面只用 VS Code 主题令牌（深浅主题自动跟随）', () => {
		assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css!.replace(/--vscode-[^;]*/g, '')), '除 `--vscode-*` 的兜底值外不该写死颜色');
		assert.ok(css!.includes('var(--vscode-') && css!.includes(':focus-visible'), '要有主题令牌与可见焦点环');
	});
});
