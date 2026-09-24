/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import mermaid from 'mermaid';
import { buildMermaidConfig, getMermaidThemeMode, resolveMermaidTheme, MermaidThemeMode } from './mermaidTheme';
import { VsCodeApi } from './vscodeApi';

declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

/**
 * Best-effort normalization of common LLM-generated Mermaid mistakes that make
 * the jison grammar choke even though a human would read them fine:
 *  - self-closing/space-padded HTML breaks `<br/>` / `<br />` → `<br>`
 *    (mermaid's parser only accepts `<br>`, the trailing slash breaks it)
 *  - reserved keywords used as classDef / class names (e.g. `classDef subgraph`)
 *    → rename to `<word>_c` consistently across the definition and assignments.
 * These are safe transforms: `<br/>` is never valid Mermaid grammar, and a
 * reserved word can never be a legitimate class name, so renaming cannot
 * corrupt a diagram that would otherwise parse.
 */
const MERMAID_RESERVED = new Set([
	'subgraph', 'end', 'graph', 'flowchart', 'default', 'style', 'click',
	'linkStyle', 'class', 'classDef', 'direction',
]);

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMermaidSource(src: string): string {
	let out = src.replace(/<br\s*\/?>/gi, '<br>');

	// Find reserved words actually used as `classDef <name>`, then rename both
	// the definition and the matching `class <nodes> <name>` assignments.
	// 允许行首缩进：LLM 常把 classDef 写在缩进/子图层级里，`^classDef` 会漏掉它们
	// （漏掉 ⇒ 规范化前后完全一致 ⇒ 第 ② 层重试形同虚设，实测踩坑）。
	const reservedUsed = new Map<string, string>();
	const defRe = /^[ \t]*classDef\s+([A-Za-z_]\w*)/gm;
	let m: RegExpExecArray | null;
	while ((m = defRe.exec(out))) {
		const name = m[1];
		if (MERMAID_RESERVED.has(name) && !reservedUsed.has(name)) {
			reservedUsed.set(name, name + '_c');
		}
	}
	if (reservedUsed.size > 0) {
		for (const [orig, renamed] of reservedUsed) {
			// classDef orig -> classDef renamed
			out = out.replace(
				new RegExp('(classDef\\s+)' + escapeRe(orig) + '(\\b)', 'g'),
				'$1' + renamed + '$2',
			);
			// class <nodes> orig -> class <nodes> renamed
			out = out.replace(
				new RegExp('(class\\s+[\\w,\\s]+?)\\b' + escapeRe(orig) + '(\\b)', 'g'),
				'$1' + renamed + '$2',
			);
		}
	}
	return out;
}

/**
 * mermaid.render() returns an HTML-serialized SVG string: void elements such as
 * <br> inside foreignObject labels are left UNclosed. That string is NOT
 * well-formed XML, so loading it as an <img> (which parses as XML) fails outright.
 * Re-serialize through XMLSerializer (after an HTML parse that tolerates the void
 * elements) to emit well-formed XML with self-closed tags and proper namespaces.
 */
function toWellFormedSvg(svg: string): string {
	try {
		const doc = new DOMParser().parseFromString(svg, 'text/html');
		const svgEl = doc.querySelector('svg');
		if (!svgEl) {
			return svg;
		}
		return new XMLSerializer().serializeToString(svgEl);
	} catch {
		return svg;
	}
}

/**
 * mermaid 渲染失败时可能在 body 里留下 `#d<renderId>` 临时容器；重试前先清掉，
 * 否则上一次的残留会让下一次渲染拿到脏 DOM。
 */
function cleanupTempElement(renderId: string): void {
	document.getElementById('d' + renderId)?.remove();
}

async function renderOnce(renderId: string, code: string, mode: MermaidThemeMode, legacyTheme: boolean): Promise<string> {
	cleanupTempElement(renderId);
	mermaid.initialize(buildMermaidConfig(mode, legacyTheme));
	try {
		const { svg } = await mermaid.render(renderId, code);
		return svg ? toWellFormedSvg(svg) : '';
	} finally {
		cleanupTempElement(renderId);
	}
}

window.addEventListener('message', async (event: MessageEvent) => {
	const msg = event.data;
	if (!msg || msg.type !== 'render' || typeof msg.source !== 'string') {
		return;
	}

	const requestId = msg.requestId;
	const code = msg.source;
	// 主题解析见 mermaidTheme.ts：深色必须映射成 redux-dark-color，
	// 直接传 'dark' 会让 v12 的逐图型默认（redux-color + neo + elk）失效。
	const mode = getMermaidThemeMode(msg.theme);
	const diag = {
		codeLen: code.length,
		hasSvg: false,
		err: '',
		normalized: false,
		theme: resolveMermaidTheme(mode),
		themeFallback: false,
		attempts: 0,
	};
	try {
		const renderIdBase = 'mermaid-render-' + String(requestId).replace(/[^a-zA-Z0-9_-]/g, '');
		const normalized = normalizeMermaidSource(code);
		diag.normalized = normalized !== code;

		// 三层重试：
		//   ① 原样 —— 现代主题（redux-*）+ ELK 默认布局；
		//   ② 规范化源码 —— 修 LLM 常见写法错（<br/>、保留字 classDef）；
		//   ③ 旧主题名兜底 —— 防后续 mermaid 版本移除 redux-* 主题名时整图不出（宁可旧皮肤也别空白）。
		const attempts: Array<{ code: string; legacyTheme: boolean }> = [{ code, legacyTheme: false }];
		if (diag.normalized) {
			attempts.push({ code: normalized, legacyTheme: false });
		}
		attempts.push({ code: normalized, legacyTheme: true });

		let lastErr: unknown;
		for (let i = 0; i < attempts.length; i++) {
			diag.attempts = i + 1;
			try {
				const svg = await renderOnce(`${renderIdBase}-${i + 1}`, attempts[i].code, mode, attempts[i].legacyTheme);
				if (!svg) {
					throw new Error('渲染得到空 SVG');
				}
				diag.theme = resolveMermaidTheme(mode, attempts[i].legacyTheme);
				diag.themeFallback = attempts[i].legacyTheme;
				diag.hasSvg = svg.indexOf('<svg') === 0;
				vscode.postMessage({ type: 'rendered', requestId, svg, diag });
				return;
			} catch (err) {
				lastErr = err;
			}
		}
		throw lastErr;
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		diag.err = message;
		vscode.postMessage({ type: 'rendered', requestId, svg: '', error: message, diag });
	}
});

// Signal the host that the render webview is ready to accept requests.
vscode.postMessage({ type: 'ready' });
