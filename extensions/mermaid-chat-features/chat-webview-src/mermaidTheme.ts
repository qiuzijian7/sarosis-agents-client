/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* pele 外观解析（预览 webview 与聊天输出项共用一份口径）
 *
 * 2026-10-19：渲染引擎从 mermaid 换成**随包的 pele** ⇒ 这里不再构造 mermaid 配置，
 * 而是把 pele 的颜色变量映射到 **VS Code 的主题变量**上。
 *
 * 为什么用 `var(--vscode-*)` 而不是一组写死的浅/深色值：
 *   · 这是**真实 webview**（不是聊天卡片那种 `<img src="blob:">` 的独立文档）⇒ CSS 变量能正常继承 ✓
 *     ⇒ 主题切换时颜色**自动跟着变，连重渲染都不需要**（pele 只把颜色写成 `var(--pele-*)`，
 *       几何/字宽是渲染时算好的，与颜色无关）；
 *   · 也省掉第三份配色表（另两份是 `dsh-plugins/vssaros-pele/assets/pele-theme.json` 与
 *     IDE 渲染进程读它）—— 这里**不复制**颜色，只做变量转发 ⇒ 不存在"三处配色漂移" ✗。
 *
 * ⚠ pele 的兜底色是**浅色向**的（bg #fff / fg #1f1f1f / border #8a8a8a）⇒ 深色下
 *   bg/fg/line/surface/border 这几条**必须**给值，否则图会保持白底黑字。
 */

/** pele 颜色变量 → VS Code 主题变量（两份都不需要区分明暗：VS Code 侧已经随主题翻转 ✓）。 */
const PELE_THEME_VARS: Readonly<Record<string, string>> = {
	'--pele-bg': 'var(--vscode-editor-background)',
	'--pele-fg': 'var(--vscode-editor-foreground)',
	'--pele-muted': 'var(--vscode-descriptionForeground)',
	'--pele-line': 'var(--vscode-editor-foreground)',
	'--pele-surface': 'var(--vscode-editorWidget-background)',
	'--pele-surface-alt': 'var(--vscode-editor-inactiveSelectionBackground)',
	'--pele-border': 'var(--vscode-editorWidget-border)',
	'--pele-accent': 'var(--vscode-textLink-foreground)',
	'--pele-font': 'var(--vscode-font-family)',
	'--pele-font-mono': 'var(--vscode-editor-font-family)',
	'--pele-radius': '4px',
};

/**
 * 把 pele 的主题变量挂到容器上（自定义属性会继承进 SVG ⇒ 图里的 `var(--pele-*)` 全部解析 ✓）。
 */
export function applyPeleThemeVars(target: HTMLElement): void {
	for (const [name, value] of Object.entries(PELE_THEME_VARS)) {
		target.style.setProperty(name, value);
	}
}
