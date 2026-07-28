/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import mermaid from 'mermaid';
import { VsCodeApi } from './vscodeApi';

declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

function getTheme(): 'dark' | 'default' {
	const c = document.body.classList;
	return (c.contains('vscode-dark') || (c.contains('vscode-high-contrast') && !c.contains('vscode-high-contrast-light')))
		? 'dark'
		: 'default';
}

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
	const reservedUsed = new Map<string, string>();
	const defRe = /^classDef\s+([A-Za-z_]\w*)/gm;
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

async function renderOnce(renderId: string, code: string, theme: 'dark' | 'default'): Promise<string> {
	mermaid.initialize({ startOnLoad: false, theme });
	const { svg } = await mermaid.render(renderId, code);
	return svg ? toWellFormedSvg(svg) : '';
}

window.addEventListener('message', async (event: MessageEvent) => {
	const msg = event.data;
	if (!msg || msg.type !== 'render' || typeof msg.source !== 'string') {
		return;
	}

	const requestId = msg.requestId;
	const code = msg.source;
	const diag = { codeLen: code.length, hasSvg: false, err: '', normalized: false };
	try {
		const theme: 'dark' | 'default' = msg.theme ?? getTheme();
		const renderId = 'mermaid-render-' + requestId.replace(/[^a-zA-Z0-9_-]/g, '');

		// First try verbatim; on a parse failure, retry with normalized source.
		let svg = '';
		try {
			svg = await renderOnce(renderId, code, theme);
		} catch (firstErr) {
			const normalized = normalizeMermaidSource(code);
			if (normalized === code) {
				throw firstErr;
			}
			diag.normalized = true;
			svg = await renderOnce(renderId, normalized, theme);
		}

		diag.hasSvg = typeof svg === 'string' && svg.indexOf('<svg') === 0;
		vscode.postMessage({ type: 'rendered', requestId, svg, diag });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		diag.err = message;
		vscode.postMessage({ type: 'rendered', requestId, svg: '', error: message, diag });
	}
});

// Signal the host that the render webview is ready to accept requests.
vscode.postMessage({ type: 'ready' });
