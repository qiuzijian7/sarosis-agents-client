/* KB 预览（kbblocks webview）的**诊断日志通道**。
 *
 * ★ 2026-09-24：为什么不用 `console.*` —— `build:kbblocks` 的生产打包配置里有
 *   `drop: ['console','debugger']` + `pure: ['console.*']`（esbuild.kbblocks.config.mjs L73-74），
 *   webview 里的 console 调用会被**整体剥掉**，所以在发布版里在 DevTools 看到的是"什么都没发生"，
 *   排查嵌入/解析问题时完全失去线索（用户实测：加了日志仍然看不到任何输出）。
 *
 * 这里的做法：把诊断信息**转发给宿主**，由宿主写进它自己的日志
 * （`_logService.info('[KB webview] ...')`）⇒ 双端日志落在同一处，一眼看到链路断在哪一环。
 * 失败（桥未就绪等）静默忽略 —— 诊断不能影响渲染。
 */

import { postMessage } from '../bridge/messageClient';

/**
 * 上报一条诊断日志。
 *
 * @param scope 链路环节（如 `wikilink` / `html-embed` / `getNoteContent`），便于过滤
 * @param message 内容（自包含：带 target / path / uri / error 等关键值）
 */
export function kbLog(scope: string, message: string): void {
	try {
		postMessage('kbblocks.debugLog', { scope, message: String(message) });
	} catch { /* 桥未就绪：忽略 */ }
}
