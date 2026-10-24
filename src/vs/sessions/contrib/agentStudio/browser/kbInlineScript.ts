/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内联 `<script>` 里的 JSON 必须转义 `<`（→ `\u003c`）—— 否则内容中的 `</script>`
 * 会被 HTML 解析器当作脚本结束标签，提前截断 JSON（2026-09-24 实测：含 HTML 演示文本的
 * 笔记因此渲染成空白页）。`\u003c` 是 JSON 字符串里的合法转义，解析后语义完全不变。
 *
 * ── 为什么单独一个文件（2026-10-23）──────────────────────────────────────────
 * 这个函数原先住在 `kbBlocksEditorPane.ts` 里，而 `kbMediaViewerPane.ts` 为了用它
 * 反向 import 了那个文件；同时 `kbBlocksEditorPane` 又要 import `kbMediaViewerPane`
 * ⇒ **双向 import = 循环依赖**（`compile-client` 每次报 CYCLIC，且随引用增多打印条数上升）。
 * 把纯函数提到这里后，两边都指向本文件，环即断开 ✓（行为零变化，纯搬家）。
 */
export function escapeJsonForInlineScript(json: string): string {
	return json.replace(/</g, '\\u003c');
}
