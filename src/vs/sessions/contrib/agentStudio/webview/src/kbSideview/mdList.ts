/*
 * 编辑态的小工具（纯函数，无 React / 无 DOM）。
 *
 * 为什么单独一个文件：它要被**守卫脚本**直接测（`check-kb-editor-keys.mjs`）。
 * 如果留在 index.tsx 里，测试就得把整个视图（含 React、DOM 桩）拖进来 —— 那是上一个大测试
 * 被删掉的原因之一（太脆）。纯函数单独成文件后，测试只需 bundle 这 40 行。
 */

/**
 * 回车时自动续写 Markdown 列表前缀。
 *
 * 行为（与 Obsidian / 主流编辑器一致）：
 *   · `- 项` 末尾回车 ⇒ 下一行 `- `
 *   · `1. 项` 回车 ⇒ 下一行 `2. `（序号自增）
 *   · `- [ ] 项` 回车 ⇒ 下一行 `- [ ] `（新任务未勾选）
 *   · **空条目**上再回车 ⇒ 删掉该行前缀、跳出列表（否则永远退不出来）
 *   · 不是列表项 ⇒ 返回 `null`，调用方走默认换行
 *
 * @param text 整篇正文
 * @param caret 光标位置（`selectionStart`）
 */
export function continueMarkdownList(text: string, caret: number): { next: string; caret: number } | null {
	const before = text.slice(0, caret);
	const lineStart = before.lastIndexOf('\n') + 1;
	const line = before.slice(lineStart);
	//  ① 缩进  ② 无序符(- * +)  ③ 有序号  ④ 任务框 [ ] / [x]
	const m = /^(\s*)(?:([-*+])|(\d+)\.)\s+(?:\[([ xX])\]\s+)?/.exec(line);
	if (!m) { return null; }
	const indent = m[1] ?? '';
	const bullet = m[2] ? m[2] : String(Number(m[3]) + 1) + '.';
	const rest = line.slice(m[0].length);
	if (!rest.trim()) {
		return { next: text.slice(0, lineStart) + text.slice(caret), caret: lineStart };
	}
	const box = m[4] ? '[ ] ' : '';
	const insert = '\n' + indent + bullet + ' ' + box;
	return { next: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
}

/**
 * Tab 缩进：无选区 ⇒ 插入两个空格；有选区 ⇒ 逐行前缀两空格。
 * 返回新的正文与选区，调用方负责把选区写回 DOM。
 */
export function indentAt(text: string, start: number, end: number): { next: string; start: number; end: number } {
	if (start === end) {
		return { next: text.slice(0, start) + '  ' + text.slice(end), start: start + 2, end: start + 2 };
	}
	const head = text.slice(0, start).replace(/[^\n]*$/, '');
	const body = text.slice(start, end).split('\n').map(l => '  ' + l).join('\n');
	return { next: head + body + text.slice(end), start, end: end + (body.length - (end - start)) };
}
