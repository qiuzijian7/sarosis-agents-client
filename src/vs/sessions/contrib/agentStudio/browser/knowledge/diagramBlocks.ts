/*---------------------------------------------------------------------------------------------
 *  图表代码块（mermaid / drawio）的提取与替换 —— 纯函数（2026-09-23）
 *
 *  背景：飞书 markdown 导入只会把 ```mermaid / ```drawio 当**普通代码块**（显示源码），
 *  且飞书图片格式**不含 SVG**（实测：`file is not a supported BMP, GIF, JPEG, PNG, TIFF, or WebP image`）
 *  ⇒ 想让图在飞书里「正确显示」，必须：
 *      源码 → 渲染 SVG（宿主已有 renderToSvg）→ **栅格化成 PNG**（webview canvas）→
 *      落盘为附件 → 把代码块**替换为 `![[xxx.png]]`** → 走已实测可用的图片插入链路。
 *
 *  本文件只负责其中「找块 / 换块」这一步 —— 纯字符串处理，无 DOM、无 IO ⇒ 易测且稳。
 *--------------------------------------------------------------------------------------------*/

/** 可栅格化的图表源码类型。 */
export type DiagramKind = 'mermaid' | 'drawio';

export interface IDiagramBlock {
	kind: DiagramKind;
	/** 源码正文（不含围栏行） */
	source: string;
	/** 在原文中的区间 `[start, end)`（含围栏行与其后换行） */
	start: number;
	end: number;
	/** 原始片段（便于断言/日志） */
	raw: string;
}

/** 解析围栏起始行：缩进 + 3+ 个反引号/波浪线 + 可选 info string（取第一个词作为语言标签）。 */
function parseFence(line: string): { char: string; len: number; lang: string } | undefined {
	const m = /^[ \t]*(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);
	if (!m) { return undefined; }
	const info = (m[2] ?? '').trim();
	return { char: m[1][0], len: m[1].length, lang: info ? info.split(/\s+/)[0] : '' };
}

/** 判断某语言标签（或空标签 + 内容特征）是否属于可栅格化图表。 */
function diagramKindOf(lang: string, body: string): DiagramKind | undefined {
	const l = (lang ?? '').toLowerCase();
	if (l === 'mermaid') { return 'mermaid'; }
	if (l === 'drawio' || l === 'mxfile') { return 'drawio'; }
	// `xml` / 无标签：只有内容确实是 drawio XML 才算（避免把普通 xml 误当图表）
	// ⚠ 必须容忍**自闭合**写法（`<mxGraphModel/>`）：只写 `[\s>]` 会漏掉 `/`（实测踩到）
	if (l === '' || l === 'xml') {
		if (/<mxfile[\s/>]|<mxGraphModel[\s/>]/i.test(body)) { return 'drawio'; }
	}
	return undefined;
}

/**
 * 提取 markdown 中所有**可栅格化**的图表代码块。
 *
 * ⚠ 只处理围栏代码块（` ``` ` / `~~~`）：裸 XML（没围栏）无法安全定位替换边界，
 *   故不在此处理（同步侧 `detectUnrenderableDiagrams` 仍会如实告警）。
 */
export function extractDiagramBlocks(markdown: string): IDiagramBlock[] {
	const out: IDiagramBlock[] = [];
	if (!markdown) { return out; }
	const lines = markdown.split('\n');
	let offset = 0;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const open = parseFence(line);
		const lineStart = offset;
		offset += line.length + 1;   // +1 = 被 split 掉的 \n
		if (!open) { i++; continue; }

		const fenceChar = open.char;
		const fenceLen = open.len;
		const lang = open.lang;
		const bodyLines: string[] = [];
		let j = i + 1;
		let closed = false;
		while (j < lines.length) {
			const cur = lines[j];
			// 闭合围栏：同字符、长度 >= 起始，且其后只剩空白
			const closeRe = new RegExp(`^[ \\t]*${fenceChar === '`' ? '`' : '~'}{${fenceLen},}[ \\t]*$`);
			if (closeRe.test(cur)) { closed = true; break; }
			bodyLines.push(cur);
			offset += cur.length + 1;
			j++;
		}
		if (!closed) { i = j; continue; }   // 未闭合 ⇒ 不当作代码块

		const body = bodyLines.join('\n');
		const closeEnd = offset + lines[j].length;   // 不含闭合行后的换行
		offset = closeEnd + 1;
		const kind = diagramKindOf(lang, body);
		if (kind) {
			out.push({
				kind, source: body,
				start: lineStart, end: Math.min(closeEnd + 1, markdown.length),
				raw: markdown.slice(lineStart, Math.min(closeEnd + 1, markdown.length)),
			});
		}
		i = j + 1;
	}
	return out;
}

/**
 * 把指定的图表代码块替换为图片引用（其余内容**逐字保留**）。
 *
 * ⚠ 图片引用**独占段落**（前后补空行）：飞书插图走 `block_replace`（整块替换），
 *   占位必须独占一个块，否则会把同段的其它文字一起替换掉（真实踩过）。
 */
export function replaceDiagramBlock(markdown: string, block: IDiagramBlock, imageRelPath: string): string {
	// 先把两侧多余的换行**规范化掉**，再统一按「独占段落」拼接 —— 这样不必去猜原文
	// 究竟有几个空行（不同编辑器/粘贴来源的空行数并不一致）。
	const before = markdown.slice(0, block.start).replace(/\n+$/, '');
	const after = markdown.slice(block.end).replace(/^\n+/, '');
	const head = before.length ? `${before}\n\n` : '';
	const tail = after.length ? `\n\n${after}` : '\n';
	return `${head}![[${imageRelPath}]]${tail}`;
}
