/*---------------------------------------------------------------------------------------------
 *  workbenchSidePaneHost — 两栏工作台「IDE 侧栏宿主」的共用外壳（2026-10-27）。
 *
 *  背景：窗口里的工作台是「左列表 + 右详情」，到 IDE 侧要拆成「左栏进 sideview、右栏进 editorpane」。
 *  这类 side pane 的 HTML 外壳（CSP / nonce / 内联数据注入 / 双脚本顺序）对每个工作台都一样，
 *  差别只在：① 注入哪个全局变量名；② `__XXX_ACTIONS__` 里挂哪些动作。
 *  ⇒ 外壳收敛到这里；各工作台只提供「数据 + 动作表」，不再各自抄一遍 HTML（抄错的代价是 XSS 或白屏）。
 *
 *  ⚠ 三条不能动的细节（都踩过）：
 *    1. `JSON.stringify(data)` 必须把 `<` 转成 `\\u003c` —— 笔记名里出现 `</script>` 时，
 *       内联脚本会被 HTML 解析器提前截断（表现为后半段动作全丢）。
 *    2. CSP 里 `script-src 'nonce-…'` 是**唯一**允许脚本的来源；内联 `<style>` 仍需 `'unsafe-inline'`，
 *       因为组件用 inline style + 动态 style 标签。
 *    3. 数据脚本必须在**组件脚本之前**执行 —— 组件是从 `window.__X__DATA__` 同步读的。
 *--------------------------------------------------------------------------------------------*/

/** 默认 CSP（与知识库现网一致；工作台若要放宽，通过 options.csp 覆盖并在注释里写清理由）。 */
export const SIDE_PANE_DEFAULT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; ";

/** 把注入数据序列化成**可安全内联**的 JSON（转义 `<`，防止 `</script>` 截断）。 */
export function escapeInlineJson(data: unknown): string {
	return JSON.stringify(data ?? null).replace(/</g, '\\u003c');
}

export interface ISidePaneHtmlOptions {
	/** VS Code webview 的 nonce（每次 setHtml 重新生成）。 */
	readonly nonce: string;
	/** 组件 bundle 源码（读自 media 目录）。 */
	readonly js: string;
	/** 可选样式表内容（组件全用 inline style 时通常为空）。 */
	readonly css?: string;
	/** 数据全局变量名，例如 `__KB_SIDEVIEW_DATA__`（组件从这里同步读）。 */
	readonly dataVar: string;
	/** 要注入的数据（任意可 JSON 序列化对象）。 */
	readonly data: unknown;
	/**
	 * 动作桥代码（一段 JS，通常形如 `window.__KB_SIDEVIEW_ACTIONS__ = { … };`）。
	 * 由各工作台提供 —— 外壳不猜动作名，避免"生成了一个谁都不认的 API"。
	 */
	readonly actionsJs: string;
	/** 覆盖默认 CSP（默认见 {@link SIDE_PANE_DEFAULT_CSP}）。 */
	readonly csp?: string;
}

/**
 * 生成 side pane 的完整 HTML。
 *
 * 结构固定为：CSP → 基础样式 → （可选）bundle 样式 → 数据脚本 → 动作桥脚本 → 组件脚本。
 * 顺序是契约的一部分，见文件头注释第 3 条。
 */
export function buildSidePaneHtml(options: ISidePaneHtmlOptions): string {
	const { nonce, js, css, dataVar, data, actionsJs } = options;
	const csp = options.csp ?? SIDE_PANE_DEFAULT_CSP;
	const styleTag = css ? `<style nonce="${nonce}">${css}</style>` : '';
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}script-src 'nonce-${nonce}';">
<style nonce="${nonce}">html,body{height:100%;margin:0;padding:0;overflow:hidden}</style>
${styleTag}
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
// ── 数据由宿主注入（组件不做任何 IO）──
window.${dataVar} = ${escapeInlineJson(data)};
// ── 动作桥：组件只发消息，由宿主 Pane 决定怎么执行（IDE 走命令 / 插件页走 HTTP）──
${actionsJs}
</script>
<script nonce="${nonce}">${js}</script>
</body>
</html>`;
}
