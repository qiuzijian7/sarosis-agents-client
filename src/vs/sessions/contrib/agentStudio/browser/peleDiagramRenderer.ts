/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */

/**
 * **本项目所有 Mermaid 图表的唯一渲染引擎**（2026-10-19）。
 *
 * 引擎是随包的 **pele**（`dsh-plugins/vssaros-pele/assets/pele.global.js`，MIT，上游 v1.6.0）：
 * 一个**同步、零 DOM 依赖**的 Mermaid → SVG 渲染器（文本宽度走内置字宽表，不需要 canvas/DOM）。
 *
 * 为什么替掉原来的「隐藏 webview + mermaid 12」：
 *   · 那条路要先 `npm run build-chat-webview` 才有 `index-render-inline.js`，**产物不在就是整片空白**，
 *     而症状离真因很远（只看到"图表 Tab 空白"）✗；
 *   · 它还要 20s/30s 超时、webview 生命周期、postMessage 往返 —— 而渲染本身只是字符串运算。
 *   ⇒ 现在：读一次 bundle → 经 `shared/trustedScript.ts` 求值（间接 `eval` + TrustedScript）
 *     → 同步 `render()` 出 SVG。⚠ 别改回 `new Function`：Chromium 的 TT 校验不认它的
 *     TrustedScript 实参（见该文件头）。
 *
 * 两个消费方共用**同一份产物**（dsh Host 的 `render_diagram` 工具也读它）⇒ 不存在"两个渲染器"。
 *
 * ⚠ 主题必须**内联进根 `<svg>` 的 style**：聊天卡片把 SVG 放进 `<img src="blob:">`（规避本 fork 的
 *   Trusted Types），那是**独立文档**，宿主页面的 CSS 变量传不进去 ⇒ 只写在父元素上会"深色下还是白底" ✗。
 *   预设的真源是随包的 `assets/pele-theme.json`（与插件侧 `withThemeVars` 同一口径；改一边要改另一边）。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService, type INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { evaluateScriptBody, isTrustedTypesBlock, trustedTypesHint } from './shared/trustedScript.js';

export const IDiagramRenderer = createDecorator<IDiagramRenderer>('diagramRenderer');

export interface IDiagramRenderer {
	readonly _serviceBrand: undefined;

	/**
	 * Renders Mermaid source markup to an SVG string (pele engine).
	 * Rejects when the markup cannot be drawn.
	 *
	 * @param maxWidth 宿主给这张图的可用宽度（px）。pele 相对 Mermaid 的一大差别就在这里：
	 *   窄容器下它是**改排版**（能竖排的图改竖排 / 换行），而不是把整张图等比缩小到看不清 ✗。
	 *   ⚠ 不传（或 0）就按不限宽渲染 —— 聊天侧栏那种窄容器里会得到一张"缩得很小"的图。
	 */
	renderToSvg(markup: string, theme?: 'dark' | 'default', maxWidth?: number): Promise<string>;
}

/** pele 暴露的那几个 API（只声明我们用到的）。 */
interface IPele {
	render(source: string, options?: { limit?: number; maxWidth?: number; fontFamily?: string }): { svg: string; width: number; height: number; type: string };
}

/** 主题预设：CSS 变量名 → 值（真源 `assets/pele-theme.json`）。 */
type ThemeVars = Record<string, string>;

/** pele 源码上限（与插件侧 `SOURCE_LIMIT` 同值）。 */
const SOURCE_LIMIT = 50_000;

interface IPeleEngine {
	pele: IPele;
	themes: Record<string, ThemeVars>;
}

export class PeleDiagramRenderer extends Disposable implements IDiagramRenderer {
	declare readonly _serviceBrand: undefined;

	private _engine: Promise<IPeleEngine> | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
	}

	async renderToSvg(markup: string, theme?: 'dark' | 'default', maxWidth?: number): Promise<string> {
		if (!markup || !markup.trim()) {
			throw new Error('图源码为空，无法渲染');
		}
		const engine = await this._loadEngine();
		let rendered: { svg: string; type: string };
		try {
			rendered = engine.pele.render(markup, {
				limit: SOURCE_LIMIT,
				...(typeof maxWidth === 'number' && maxWidth > 0 ? { maxWidth } : {}),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this._logService.error('[PeleDiagramRenderer] render failed: ' + message);
			throw new Error('图表渲染失败：' + message);
		}
		if (!rendered?.svg) {
			throw new Error('图表渲染返回空结果');
		}
		return withThemeVars(rendered.svg, engine.themes[theme === 'dark' ? 'dark' : 'default'] ?? engine.themes['default']);
	}

	/** 读 bundle + 主题预设并求值（一次；失败不缓存，下次重试 ✓）。 */
	private _loadEngine(): Promise<IPeleEngine> {
		if (!this._engine) {
			this._engine = this._createEngine().catch(err => {
				this._engine = undefined;
				throw err;
			});
		}
		return this._engine;
	}

	/**
	 * `dsh-plugins/vssaros-pele/assets/` 的候选位置。
	 *
	 * `appRoot` 是装着运行代码的目录（dev 下是仓库根，打包后是 `resources/app`），而 `dsh-plugins/`
	 * 在两种布局里都**与它同级**（dev：`<repo>/dsh-plugins`；打包：`resources/app/dsh-plugins`）。
	 * 仍多留一个 `../` 候选，与 `DrawioInlineRenderer` 那边的容错口径一致（appRoot 指到 `out/` 时也找得到 ✓）。
	 */
	private _assetPath(file: string): URI[] {
		const appRoot = (this._environmentService as INativeEnvironmentService).appRoot;
		const segments = ['dsh-plugins', 'vssaros-pele', 'assets', file];
		return [
			URI.joinPath(URI.file(appRoot), ...segments),
			URI.joinPath(URI.file(appRoot), '..', ...segments),
		];
	}

	private async _readAsset(file: string): Promise<string> {
		for (const uri of this._assetPath(file)) {
			try {
				const content = await this._fileService.readFile(uri);
				return content.value.toString();
			} catch {
				// try next candidate
			}
		}
		const tried = this._assetPath(file).map(u => u.fsPath).join(' | ');
		throw new Error(`pele 资源读不到（${file}）。试过：${tried} —— 插件没随包？`);
	}

	/**
	 * 求值 pele bundle（esbuild iife + globalName，形如 `var pele = (() => { ... })();`）。
	 *
	 * ⚠ 工作窗口的 CSP 同时有 `script-src 'unsafe-eval'` 与 `require-trusted-types-for 'script'`：
	 *   前者只放行 `new Function` 这个动作，后者额外要求**实参是 TrustedScript** —— 直接喂普通
	 *   字符串会抛 `Evaluating a string as JavaScript violates this document's Trusted Type
	 *   assignment requirements.`（2026-10-20「知识库笔记里 mermaid 全部渲染失败」的真因：该
	 *   错误被原样透传成 `Mermaid 渲染失败：...`，看起来像 mermaid 语法问题，其实图源码一行都
	 *   没被解析）。故经 `shared/trustedScript.ts` 包成 TrustedScript；拿不到策略时把成因说清楚，
	 *   别让用户对着正确的源码找语法错。
	 */
	private _evaluateBundle(bundleJs: string): unknown {
		try {
			return evaluateScriptBody(bundleJs + '\nreturn pele;');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (isTrustedTypesBlock(message)) {
				throw new Error('pele 引擎加载失败：' + trustedTypesHint(message));
			}
			throw err;
		}
	}

	private async _createEngine(): Promise<IPeleEngine> {
		const bundleJs = await this._readAsset('pele.global.js');
		const pele = this._evaluateBundle(bundleJs) as IPele | undefined;
		if (!pele || typeof pele.render !== 'function') {
			throw new Error('pele 产物格式不对（没有 render）—— 重新跑 dsh-plugins/vssaros-pele/tools/build-pele.mjs');
		}

		let themes: Record<string, ThemeVars> = {};
		try {
			const parsed: unknown = JSON.parse(await this._readAsset('pele-theme.json'));
			const presets = (parsed as { presets?: Record<string, Record<string, string>> })?.presets ?? {};
			for (const [name, vars] of Object.entries(presets)) {
				// 以 `$` 开头的键是注释（说明/版本），不是 CSS 变量 ⇒ 过滤掉，否则会写出无效声明。
				themes[name] = Object.fromEntries(Object.entries(vars ?? {}).filter(([k]) => !k.startsWith('$')));
			}
		} catch (err) {
			// 主题读不到**不致命**：pele 的每个变量都自带兜底色 ⇒ 图还是画得出来（只是用默认配色）。
			this._logService.warn('[PeleDiagramRenderer] 主题预设读不到，回退 pele 默认配色: ' + (err instanceof Error ? err.message : String(err)));
			themes = {};
		}

		this._logService.info('[PeleDiagramRenderer] engine ready (pele)');
		return { pele, themes };
	}

	override dispose(): void {
		this._engine = undefined;
		super.dispose();
	}
}

/**
 * 把 CSS 变量内联进根 `<svg>` 的 style 属性。
 *
 * ⚠ 这是插件侧 `lib/core/render.js` 里同名函数的 **TS 孪生实现**——两侧必须同行为
 *   （不一致就是"同一张图两个配色"）。改一边请同步改另一边。
 */
export function withThemeVars(svg: string, vars: ThemeVars | undefined): string {
	if (!svg || !vars) {
		return svg;
	}
	const decl = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
	if (!decl) {
		return svg;
	}
	const open = /<svg\b[^>]*>/u.exec(svg);
	if (!open) {
		return svg;
	}
	const tag = open[0];
	// pele 的根标签自带 style（max-width/height + 一串 --_* 别名）⇒ 追加到它后面即可；
	// 没有 style 属性时（别的来源的 SVG）自己加一个 ✓。
	const next = /\sstyle\s*=\s*"/u.test(tag)
		? tag.replace(/\sstyle\s*=\s*"([^"]*)"/u, (_all, value: string) => ` style="${value.replace(/;\s*$/u, '')};${decl}"`)
		: tag.replace(/>$/u, ` style="${decl}">`);
	return svg.slice(0, open.index) + next + svg.slice(open.index + tag.length);
}
