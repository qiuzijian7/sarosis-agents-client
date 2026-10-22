/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「Host 未运行」时给**插件页**显示的占位页（`data:` URL，零外部资源、不依赖 webServer）。
 *
 * ## 为什么需要它（2026-10-20 真机报障）
 *
 * Host 掉线时 `dshViewHost.setConnection(undefined)` 会把所有插件页清成 `about:blank`
 * ⇒ 用户看到的是**整片纯白**，而 `about:blank` 属于"加载成功"：
 *   · `did-fail-load` 不触发 ⇒ 有界重试（`dshViewLoadRetry`）不启动；
 *   · 白屏看门狗只挂聊天页 ⇒ 插件页没人管；
 *   · IDE 日志里**一行都没有**。
 * 现场（记忆库 sideview 空白）排查时必须靠 Host 日志 + 进程表反推"Host 早就不在了"。
 * ⇒ 换成这张占位页：**为什么空白、会怎么自动恢复**都写在页面上，日志也留一行。
 *
 * ## 为什么用 `data:` 而不是走 Host 的路由
 *
 * 这页的**前提**就是 Host 不在。任何需要 Host 提供资源的方案（静态页、插件路由）在
 * 这个场景下必然同样失败 ⇒ 只能自带内容。`data:` 不经过网络、不受 CSP/分区 cookie 影响。
 *
 * ⚠ 只给**插件页**（`slot.pageSurface` 有值）用；聊天页保持 `about:blank`——它有自己的
 *   白屏看门狗与 `DSH_PAGE_IPC_REBIND` 重绑逻辑，换页面会把那套状态机搅乱。
 */

export interface IUnavailablePageOptions {
	/** 插件页路由（如 `/x/memory/`）；显示在页面上，方便对着日志确认是哪个模块。 */
	readonly route?: string;
	/** 覆盖主标题（默认「页面暂时不可用」）。 */
	readonly title?: string;
}

const DEFAULT_TITLE = '页面暂时不可用';

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[ch],
	);
}

/**
 * 占位页 HTML。
 *
 * 措辞三条硬要求（都是被现场逼出来的）：
 *   ① 说清**谁**不在了（dsh Host），别让人以为插件/数据坏了；
 *   ② 说清**会怎么恢复**（Host 回来就自动重载，不用重开面板）——否则用户只会去重启 IDE；
 *   ③ 带上路由，日志与页面能对上号。
 */
export function unavailablePageHtml(options: IUnavailablePageOptions = {}): string {
	const title = escapeHtml(options.title?.trim() || DEFAULT_TITLE);
	const route = escapeHtml(String(options.route ?? '').trim());
	const routeLine = route
		? `<p class="hint">页面路由 <code>${route}</code></p>`
		: '';
	return [
		'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width,initial-scale=1">',
		`<title>${title}</title>`,
		'<style>',
		':root{color-scheme:light dark}',
		'html,body{height:100%;margin:0}',
		'body{display:flex;align-items:center;justify-content:center;padding:24px;',
		'font:13px/1.65 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#1f1f1f;color:#c8c8c8}',
		'@media (prefers-color-scheme:light){body{background:#f3f3f3;color:#3b3b3b}}',
		'.card{max-width:560px}',
		'h1{margin:0 0 10px;font-size:14px;font-weight:600}',
		'p{margin:0 0 10px}',
		'.hint{opacity:.72}',
		'code{font-family:Consolas,"Courier New",monospace;background:rgba(127,127,127,.18);',
		'padding:1px 5px;border-radius:3px}',
		'</style></head><body><div class="card">',
		`<h1>${title}</h1>`,
		'<p>dsh Host 没有在运行。这个页面由 Host 提供，所以现在没有内容可显示。</p>',
		'<p>Host 恢复后本页会<b>自动重新加载</b>，不需要重开面板；若 VsSaros 已经退出，请重新打开窗口。</p>',
		routeLine,
		'<p class="hint">这条占位由 IDE 显示，不是插件页面报的错 —— 插件与它的数据都没有问题。</p>',
		'</div></body></html>',
	].join('');
}

/** `data:` URL（HTML 需要整体 `encodeURIComponent`，否则 `#`/`&` 会被当成 URL 结构）。 */
export function unavailablePageUrl(options: IUnavailablePageOptions = {}): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(unavailablePageHtml(options))}`;
}
