/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ★★ 2026-09-20：图表渲染主题探测（mermaid 卡 / mermaid fence 兜底 / drawio 卡 / 预览标签**共用** ✓）。
 *   2026-10-19：从 `agentChat/agentChatPanel.mermaidCard.ts` 搬到这里。
 *
 * 为什么要独立成一个文件（不只是"整理代码"）：原聊天面板 `AgentChatPanel` 是要退场的 legacy
 * 方案（聊天框已由 dsh 的 `vssaros-chat-surface` 插件承载），而这个判定被**面板之外的代码**依赖
 * （`agentStudio.contribution.ts` 的图表预览标签）。让它留在带 DOM 依赖的卡片模块里，
 * 就等于"删面板前必须先把这个函数抠出来" ⇒ 越晚搬越难搬。现在它是零依赖的纯函数，谁都能引 ✓。
 *
 * 痛点（用户截图：暗色聊天里的 mermaid 卡整块**白色** ✗）：旧判定只看 `body.classList`
 * 有没有 `vs-dark` 等类 ✗ —— 该判定可能为 **false**（主题类不一定挂在 body 上、或类名不同 ✗）
 * ⇒ `theme='default'` ⇒ 渲染**亮色** SVG，且 `renderChart` 会把预览面板**显式刷成 #ffffff** ✗✓。
 *
 * 修法：类名只是**快路径** ✓；不确定时读 **body 的实际计算背景色**做亮度判定
 * （`lum = 0.299R + 0.587G + 0.114B < 128` ⇒ 暗色 ✓ —— 背景色不会骗人 ✓）；
 * 拿不到颜色默认暗色（本聊天 UI 以暗色为主 ✓）。
 * 打一行 `[DiagramTheme]` 诊断（bodyClass + bg + 结论 ✓）—— 下次日志可直接归因 ✓。
 */
export function detectDiagramTheme(container: HTMLElement): 'dark' | 'default' {
	const doc = container.ownerDocument;
	const bodyCls = doc.body.classList;
	let theme: 'dark' | 'default' =
		(bodyCls.contains('vs-dark') || bodyCls.contains('hc-black')
			|| bodyCls.contains('vscode-dark') || bodyCls.contains('vscode-high-contrast'))
			? 'dark'
			: (bodyCls.contains('vs') || bodyCls.contains('hc-light')) ? 'default' : 'dark';
	let bg = 'n/a';
	if (bodyCls.value.trim() === '' || (!bodyCls.contains('vs-dark') && !bodyCls.contains('vs') && !bodyCls.contains('hc-black') && !bodyCls.contains('hc-light'))) {
		// 一个主题类都没命中 ⇒ 类名判定不可信 ✗ ⇒ 用实际背景色复核 ✓
		const view = doc.defaultView;
		bg = view ? view.getComputedStyle(doc.body).backgroundColor : 'n/a';
		const m = bg.match(/-?\d+(?:\.\d+)?/g);
		if (m && m.length >= 3) {
			const lum = (Number(m[0]) * 299 + Number(m[1]) * 587 + Number(m[2]) * 114) / 1000;
			theme = lum < 128 ? 'dark' : 'default';
		}
	}
	try { console.info(`[DiagramTheme] bodyClass="${bodyCls.value}" bg=${bg} → ${theme}`); } catch { /* ignore */ }
	return theme;
}
