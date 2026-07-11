/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbLuteRenderer.ts — 纯正则的双链/块引用提取与高亮工具。
 *
 *  历史上本文件依赖 SiYuan Lute 引擎做 Markdown → Protyle 块级渲染；随着编辑器
 *  切换到 AFFiNE / BlockSuite（见 doc/affine-replace-siyuan-plan.md），Lute 运行时
 *  已移除。这里仅保留与 Lute 无关的纯函数：从 Markdown 文本提取 [[双链]] / ((块引用))
 *  以及对 HTML 做客户端高亮。
 *--------------------------------------------------------------------------------------------*/

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
