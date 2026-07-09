/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbLuteRenderer.ts — Lute 块级渲染器：Markdown → Protyle 块 DOM，并应用渲染后处理。
 *
 *  复用 SiYuan 的渲染流程：
 *   1. Lute.SpinBlockDOM(md) → 块级 DOM HTML
 *   2. Protyle.mathRender / mermaidRender / ... 等静态后处理
 *
 *  功能：
 *   - Markdown → 块视图 DOM
 *   - [[双链]] / ((块引用)) / #标签# 实时高亮
 *   - 应用 Protyle 静态后渲染器（当前通过手动高亮处理，完整 Protyle 需要 vendored protyle-html.js）
 *--------------------------------------------------------------------------------------------*/

import { getLute } from './kbLute.js';

// ---------------------------------------------------------------------------
// 渲染结果
// ---------------------------------------------------------------------------

export interface IKbRenderResult {
	/** 渲染后的 HTML 字符串 */
	html: string;
	/** 提取出的双链引用标签列表 */
	wikilinks: string[];
	/** 提取出的块引用 ID 列表 */
	blockrefs: string[];
}

// ---------------------------------------------------------------------------
// Protyle 静态渲染器的声明（来自 SiYuan vendored protyle-html.js）
// ---------------------------------------------------------------------------

interface IProtyleStatic {
	highlightRender?(element: HTMLElement, assetsPath: string): void;
	mathRender?(element: HTMLElement, assetsPath: string, fullWidth?: boolean): void;
	mermaidRender?(element: HTMLElement, assetsPath: string): void;
	flowchartRender?(element: HTMLElement, assetsPath: string): void;
	graphvizRender?(element: HTMLElement, assetsPath: string): void;
	chartRender?(element: HTMLElement, assetsPath: string): void;
	mindmapRender?(element: HTMLElement, assetsPath: string): void;
	abcRender?(element: HTMLElement, assetsPath: string): void;
	plantumlRender?(element: HTMLElement, assetsPath: string): void;
}

function getProtyleStatic(): IProtyleStatic | undefined {
	return (window as unknown as Record<string, IProtyleStatic | undefined>).Protyle;
}

// ---------------------------------------------------------------------------
// 核心渲染
// ---------------------------------------------------------------------------

/**
 * 将 Markdown 渲染为块级 DOM HTML，并应用 Protyle 后处理渲染器。
 *
 * @param markdown - 原始 Markdown 文本
 * @param assetBasePath - Protyle 静态资源根路径（stage/protyle）
 * @returns 渲染结果（HTML + 提取的引用）
 */
export function renderMarkdownToBlocks(
	markdown: string,
	assetBasePath?: string,
): IKbRenderResult {
	const lute = getLute();
	const html = lute.SpinBlockDOM(markdown);

	return {
		html,
		wikilinks: extractWikilinks(markdown),
		blockrefs: extractBlockRefs(markdown),
	};
}

/**
 * 对已渲染的块 DOM 元素应用 Protyle 静态后渲染器
 * （数学公式、Mermaid 图表、高亮代码等）。
 *
 * @param element - 包含渲染结果的 DOM 元素
 * @param assetBasePath - Protyle stage/protyle 资源路径
 */
export function applyProtylePostRenderers(
	element: HTMLElement,
	assetBasePath: string,
): void {
	const Protyle = getProtyleStatic();
	if (!Protyle) { return; }

	// 按 SiYuan export/index.ts 的渲染顺序
	Protyle.highlightRender?.(element, assetBasePath);
	Protyle.mathRender?.(element, assetBasePath, true);
	Protyle.mermaidRender?.(element, assetBasePath);
	Protyle.flowchartRender?.(element, assetBasePath);
	Protyle.graphvizRender?.(element, assetBasePath);
	Protyle.chartRender?.(element, assetBasePath);
	Protyle.mindmapRender?.(element, assetBasePath);
	Protyle.abcRender?.(element, assetBasePath);
	Protyle.plantumlRender?.(element, assetBasePath);
}

// ---------------------------------------------------------------------------
// 引用提取
// ---------------------------------------------------------------------------

/** 从 Markdown 中提取 [[...]] 双链引用 */
const WIKILINK_RE = /(?<!`)\[\[([^\]]+)\]\](?!`)/g;

export function extractWikilinks(markdown: string): string[] {
	const links = new Set<string>();
	let match: RegExpExecArray | null;
	while ((match = WIKILINK_RE.exec(markdown)) !== null) {
		links.add(match[1].trim());
	}
	return [...links];
}

/** 从 Markdown 中提取 ((...)) 块引用 */
const BLOCKREF_RE = /(?<!`)\(\(([^)]+)\)\)(?!`)/g;

export function extractBlockRefs(markdown: string): string[] {
	const refs = new Set<string>();
	let match: RegExpExecArray | null;
	while ((match = BLOCKREF_RE.exec(markdown)) !== null) {
		refs.add(match[1].trim());
	}
	return [...refs];
}

/**
 * 对渲染后的 HTML 进行客户端增强高亮：
 * - [[双链]] → 添加 .kb-wikilink CSS 类
 * - ((块引用)) → 添加 .kb-blockref CSS 类
 */
export function highlightRefsInHtml(html: string): string {
	return html
		.replace(/(?<!<[^>]*?)(\[\[([^\]]+)\]\])(?![^<]*?>)/g,
			'<span class="kb-wikilink" data-ref="$2">$1</span>')
		.replace(/(?<!<[^>]*?)(\(\(([^)]+)\)\))(?![^<]*?>)/g,
			'<span class="kb-blockref" data-ref="$2">$1</span>');
}
