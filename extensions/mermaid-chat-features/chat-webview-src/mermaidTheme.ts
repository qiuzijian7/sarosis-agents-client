/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Mermaid 外观解析（聊天内联渲染 bundle 与预览 webview 共用一份口径）
 *
 * 背景 —— mermaid 12.0.0 实测（8 条分支 + 2 个 subgraph 的 flowchart，取 SVG <style> 主色）：
 *  · v12 起 flowchart / state / class / er 等图型的**默认**主题是 `redux-color` + `look: neo`，
 *    默认布局是 `elk`（复杂图交叉明显少于 dagre）⇒ 「升级依赖」本身就白拿了
 *    「更好看 + 布局更合理」，不需要额外配置。
 *  · 但**只要显式传全局 `theme`，逐图型默认就被全局值顶掉**。同一个图：
 *      不传 theme                 → #28253D / #E879F9 / #2DD4BF（redux，现代配色）
 *      theme: 'dark'              → #a44141 / #1f2020（旧 dark 配色，等于白升级）
 *      theme: 'redux-dark-color'  → #E879F9 / #2DD4BF / #4ADE80（redux 暗色）
 *    ⇒ 深色模式必须显式映射成 `redux-dark-color`，否则升级后反而比原来更旧。
 *  · `themeVariables` 只在 `theme: 'base'` 下生效（官方约束），用了 base 就丢掉 redux 那套
 *    调过的配色 ⇒ 这里刻意不用 themeVariables，只统一字体。
 */

export type MermaidThemeMode = 'dark' | 'default';

export type MermaidResolvedTheme = 'dark' | 'default' | 'redux-color' | 'redux-dark-color';

/** 现代主题：v12 的默认外观，暗/亮各一套 */
const MODERN_THEME: Record<MermaidThemeMode, MermaidResolvedTheme> = {
	dark: 'redux-dark-color',
	default: 'redux-color',
};

/** 兜底主题：万一现代主题名在后续 mermaid 版本被移除/改名，仍要出图（退回旧外观） */
const LEGACY_THEME: Record<MermaidThemeMode, MermaidResolvedTheme> = {
	dark: 'dark',
	default: 'default',
};

/**
 * 字体栈与宿主编辑器一致。mermaid 默认落到 `trebuchet ms`，中文场景衬线感明显、
 * 与编辑器正文不是一套字，这里显式对齐（SVG 内联给字体，注入宿主 DOM 后即可生效）。
 */
const MERMAID_FONT_FAMILY = '"Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';

/** 按 webview body 上的 VS Code 主题 class 判主题（宿主显式传 theme 时以宿主为准） */
export function getMermaidThemeFromBody(): MermaidThemeMode {
	const c = document.body.classList;
	return (c.contains('vscode-dark') || (c.contains('vscode-high-contrast') && !c.contains('vscode-high-contrast-light')))
		? 'dark'
		: 'default';
}

/** 把宿主传来的（或缺失的）theme 归一到已知取值，缺失时回退到 body class 判定 */
export function getMermaidThemeMode(value: unknown): MermaidThemeMode {
	return value === 'dark' || value === 'default' ? value : getMermaidThemeFromBody();
}

/** 主题模式 → 真正传给 mermaid 的主题名（`legacyTheme` 仅供渲染失败后的兜底重试使用） */
export function resolveMermaidTheme(mode: MermaidThemeMode, legacyTheme = false): MermaidResolvedTheme {
	return legacyTheme ? LEGACY_THEME[mode] : MODERN_THEME[mode];
}

/** 构造 mermaid 初始化配置（两处 webview 必须完全一致，故收在这里） */
export function buildMermaidConfig(mode: MermaidThemeMode, legacyTheme = false): {
	startOnLoad: boolean;
	theme: MermaidResolvedTheme;
	fontFamily: string;
} {
	return {
		startOnLoad: false,
		theme: resolveMermaidTheme(mode, legacyTheme),
		fontFamily: MERMAID_FONT_FAMILY,
	};
}
