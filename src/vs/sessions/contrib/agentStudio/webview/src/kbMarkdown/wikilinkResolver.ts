/* Resolves a `[[wikilink]]` target against the list of notes in the open vault.
 *
 * Ported from Glyph's `src/lib/wikilinkResolver.ts`, adapted to resolve against
 * {@link WorkspaceFile} entries (which carry an absolute `file://` URI) instead
 * of raw file-path strings. The resolved value is the target note's URI, which
 * the webview later posts to the host via `kbblocks.openDoc`.
 */

import type { WorkspaceFile, ResolvedWikilink } from './types';

const PATH_SEP = /[\\/]/;

export function splitTargetAndHeading(input: string): { target: string; heading?: string } {
	const idx = input.indexOf('#');
	if (idx < 0) return { target: input };
	const heading = input.slice(idx + 1).trim();
	return { target: input.slice(0, idx), heading: heading || undefined };
}

export function stemOf(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

export function dirOf(path: string): string {
	const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return idx >= 0 ? path.slice(0, idx) : '';
}

function normalizeTarget(raw: string): string {
	let t = raw.trim();
	// ★ 2026-09-24（与宿主侧 KbLinkGraph.normalizeTarget 对齐，双链解析错误）：目标是
	//   **file:// URI** 时（如 `[[file:///e:/VsSarosVault/库/raw/UI优化篇.md]]`，中文会被百分号编码
	//   成 `%E5%BA%93`），先解码再取 basename —— 否则永远解析不到，预览/双链面板会显示成乱码 URI。
	//   ⚠ 相对路径形目标（`库/raw/x.md`）**不进**这个分支：它由下面的 path-suffix 匹配处理 ✓。
	if (/^[a-z][a-z0-9+.-]*:/i.test(t)) {
		try { t = decodeURIComponent(t); } catch { /* 裸 % 等非法编码序列 ⇒ 保持原样 */ }
		t = (t.split(/[\\/]/).pop() ?? t).trim();
	}
	if (t.toLowerCase().endsWith('.md')) t = t.slice(0, -3);
	if (t.toLowerCase().endsWith('.markdown')) t = t.slice(0, -8);
	// ★ 2026-09-24（活页面嵌入）：html 同样按 stem 匹配 —— `![[page.html]]` 的 html 判定
	//   需要带扩展名书写，而文件清单匹配是按 stem 的 ⇒ 这里把扩展名归一掉，两者才能同时成立。
	if (t.toLowerCase().endsWith('.html')) t = t.slice(0, -5);
	if (t.toLowerCase().endsWith('.htm')) t = t.slice(0, -4);
	// 图表文件嵌入（![[x.drawio]] / ![[x.mermaid]] / ![[x.canvas]]）同理按 stem 匹配
	if (/\.(drawio|mermaid|mmd|canvas)$/i.test(t)) { t = t.replace(/\.(drawio|mermaid|mmd|canvas)$/i, ''); }
	return t;
}

export function resolveWikilink(
	rawTarget: string,
	workspaceFiles: WorkspaceFile[],
	currentFilePath?: string,
): ResolvedWikilink {
	const { target, heading } = splitTargetAndHeading(rawTarget);
	const cleaned = normalizeTarget(target);
	if (!cleaned || workspaceFiles.length === 0) return { uri: null, heading };

	const lower = cleaned.toLowerCase();

	// Two match modes:
	//  1. relative-path-ish target ("folder/note") → match the suffix of any path
	//  2. bare name → match by stem
	const looksLikePath = cleaned.includes('/') || cleaned.includes('\\');
	// Path-suffix matching normalizes separators: vault URIs arrive with `/`
	// separators, while a wikilink target is authored with `/`, so
	// `[[Notes/Ingredients]]` still matches `…/Notes/Ingredients`.
	const targetSuffix = `/${lower.replace(/\\/g, '/')}`;

	const candidates: WorkspaceFile[] = [];
	for (const file of workspaceFiles) {
		// ★ 2026-09-24（诊断「文件不可用或不在当前库内」）：内核索引可能返回**没有 uri**
		//   （空串）的合成条目。它们永远打不开，却会因为「最短路径优先」的消歧规则**胜出**
		//   并挤掉真正能用的磁盘条目（`''.length === 0` 最小）⇒ 目标"解析成功"但 uri 为空。
		//   ⇒ 这类条目在这里直接丢弃（等价于不存在）。
		if (typeof file.uri !== 'string' || !file.uri) { continue; }
		if (looksLikePath) {
			const noExt = file.uri
				.replace(/\.[^./\\]+$/, '')
				.replace(/\\/g, '/')
				.toLowerCase();
			if (noExt.endsWith(targetSuffix)) {
				candidates.push(file);
			}
		} else if (stemOf(file.name).toLowerCase() === lower) {
			candidates.push(file);
		}
	}

	if (candidates.length === 0) return { uri: null, heading };
	if (candidates.length === 1) return { uri: candidates[0].uri, heading };

	// Disambiguate: prefer same-directory as the current file.
	if (currentFilePath) {
		const currentDir = dirOf(currentFilePath);
		const sameDir = candidates.find((c) => dirOf(c.uri) === currentDir);
		if (sameDir) return { uri: sameDir.uri, heading };
	}
	// Stable fallback: shortest path, then lexicographic.
	candidates.sort((a, b) => a.uri.length - b.uri.length || a.uri.localeCompare(b.uri));
	return { uri: candidates[0].uri, heading };
}
