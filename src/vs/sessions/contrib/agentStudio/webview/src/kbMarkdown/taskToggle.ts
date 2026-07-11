/* Pure helper backing `onToggleTask`: flip `- [ ]` ↔ `- [x]` (tolerating
 * uppercase `[X]`) on a single 1-based source line. Returns the new markdown,
 * or `null` when the line isn't a task checkbox (nothing to do). The markdown
 * rewrite is the single source of truth for both persistence and the
 * re-render, mirroring Glyph's `onTaskToggle(line)`.
 */

export function toggleTaskCheckbox(markdown: string, line: number): string | null {
	const lines = markdown.split('\n');
	const i = line - 1;
	if (i < 0 || i >= lines.length) return null;
	const cur = lines[i];
	const next = cur.replace(
		/^(\s*[-*+]\s+\[)([ xX])(\])/,
		(_m, a: string, b: string, c: string) => a + (b === ' ' ? 'x' : ' ') + c,
	);
	if (next === cur) return null;
	lines[i] = next;
	return lines.join('\n');
}
