/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 抓取正文的两条**内容形状防护**（纯字符串逻辑：无 IO、无 VS Code 依赖，可直接单测）。
 *
 * ## 为什么需要（对比 Hermes-Agent 后补上的缺口，2026-09-24）
 *
 * Hermes 在 `tools/web_tools_truncate.py:47-56,161-169` 做了同样两件事，我们此前**完全没有**
 * （实测：`webTools.ts` 与主进程 extractor 里 `base64` / `binary` 零命中）。两个真实后果：
 *
 *   ① **内联 base64 会把正文预算灌满**。带 data-URI 图片的页面（CMS 直出、canvas 导出、
 *      邮件归档很常见）会让 `web_extract` 的字符预算被几 MB 的 base64 占掉，**真正的正文被截掉** ——
 *      模型看到一堆 `iVBORw0KGgo...` 却拿不到内容。这一步把它换成占位符，正文就能进上下文。
 *   ② **二进制载荷会被当文本切片**。URL 指向 PDF/zip/SQLite/ELF 时，我们此前会把字节流塞给模型
 *      （既无用又污染上下文，还可能把二进制当"页面内容"去推理）。这里按魔数识别并**标签化失败**，
 *      让模型改用 `execute_code` + 文件工具去处理。
 *
 * 与 Hermes 的差异（刻意）：他们是"把 `<img>` 换成 `[IMAGE: alt]`"的具体语法转换，这里先用
 * markdown 图片语法保住 alt 文本，再用**与语法无关的通用兜底**清掉任何长 base64 载荷 ——
 * 因为正文可能来自 reader-mode 的 markdown，也可能来自原始 HTML 回退路径，语法不统一。
 */

/** 内联载荷的剥离阈值：短于此长度的 base64 不动它（小图标无害，剥了反而丢信息）。 */
const MIN_BASE64_PAYLOAD_CHARS = 80;

/** markdown 图片 + data URI：尽量保住 alt 文本。 */
function markdownDataUriImageRegex(): RegExp {
	return new RegExp(`!\\[([^\\]]*)\\]\\(\\s*data:([\\w.+-]+\\/[\\w.+-]+);base64,[A-Za-z0-9+/=_-]{${MIN_BASE64_PAYLOAD_CHARS},}\\s*\\)`, 'g');
}

/**
 * 通用兜底：任何 `data:<mime>;base64,<长载荷>`，与它出现在什么语法里无关（HTML 属性、CSS url()、
 * JS 字符串、markdown 皆可）。
 *
 * ⚠ 刻意**不**允许载荷内部出现空白（不做"换行包裹也吃掉"的宽容匹配）：那种写法的贪婪匹配在
 * 载荷未闭合时会一路吃进后面的正文（因为普通英文单词也全是 base64 合法字符）。代价是
 * **被硬换行包裹的 base64 只会被剥掉第一行** —— 真实 data URI 由 `)` / `"` / `'` 闭合、不会被换行，
 * 所以这个取舍只影响不存在的场景。
 */
function genericDataUriRegex(): RegExp {
	return new RegExp(`data:([\\w.+-]+\\/[\\w.+-]+);base64,[A-Za-z0-9+/=_-]{${MIN_BASE64_PAYLOAD_CHARS},}`, 'g');
}

export interface IBase64StripResult {
	readonly text: string;
	/** 被替换掉的载荷数量（用于日志：命中说明这个页面确实有内联资源）。 */
	readonly replaced: number;
	/** 被省下的字符数（≈ 灌进上下文的垃圾量），用于日志。 */
	readonly removedChars: number;
}

/** 把内联 base64 载荷换成占位符。无内联载荷时原样返回（连字符串都不新建）。 */
export function stripInlineBase64(text: string): IBase64StripResult {
	if (!text.includes(';base64,')) { return { text, replaced: 0, removedChars: 0 }; }

	let replaced = 0;
	let removedChars = 0;
	const count = (whole: string): string => { replaced++; removedChars += whole.length; return ''; };

	let out = text.replace(markdownDataUriImageRegex(), (whole, alt: string) => {
		const label = String(alt ?? '').trim();
		count(whole);
		return label ? `[IMAGE: ${label}]` : '[IMAGE]';
	});
	out = out.replace(genericDataUriRegex(), whole => {
		count(whole);
		return `[inline ${getMime(whole)} removed]`;
	});

	return { text: out, replaced, removedChars };
}

/** 从 `data:<mime>;base64,…` 里取 mime（供占位符文案用）。 */
function getMime(dataUri: string): string {
	const m = /^data:([\w.+-]+\/[\w.+-]+);/.exec(dataUri);
	return m ? m[1] : 'resource';
}

/**
 * 二进制载荷的魔数表（前缀 → 人读名称）。
 *
 * 命中即**标签化失败**，不再当文本交给模型。仅收录"URL 抓取真会遇到"的类型：文档、压缩包、
 * 可执行、图片、媒体、数据库。刻意不做穷举 —— 剩下的交给下面的不可打印字符启发式。
 */
const BINARY_MAGICS: ReadonlyArray<readonly [string, string]> = [
	['%PDF-', 'PDF'],
	['PK\u0003\u0004', 'ZIP/Office 压缩包'],
	['PK\u0005\u0006', 'ZIP（空归档）'],
	['SQLite format 3', 'SQLite 数据库'],
	['\u007FELF', 'ELF 可执行文件'],
	['MZ', 'Windows 可执行文件'],	// 注意：文本以 "MZ" 开头也会命中，所以下面还有"可打印性"复核
	['\u0089PNG', 'PNG 图片'],
	['\u00FF\u00D8\u00FF', 'JPEG 图片'],
	['GIF8', 'GIF 图片'],
	['\u001F\u008B', 'gzip 压缩流'],
	['Rar!\u001A\u0007', 'RAR 压缩包'],
	['7z\u00BC\u00AF', '7z 压缩包'],
	['\u0000asm', 'WebAssembly 模块'],
	['OggS', 'Ogg 媒体'],
	['ID3', 'MP3 音频'],
	['ftyp', 'MP4/HEIF 媒体'],
];

/** MZ 这类"可能只是碰巧"的前缀，要求同时满足下面的不可打印比例才判定。 */
const AMBIGUOUS_MAGICS = new Set(['MZ', 'ID3', 'ftyp']);

/**
 * 探测二进制载荷。返回人读类型名（如 `'PDF'`），非二进制返回 undefined。
 *
 * 两层：**魔数**（确定性强）+ **不可打印字符比例**（兜住没收录的类型，例如某些编码的响应）。
 * 魔数命中后还要过一遍"可打印性"，避免把一段恰好以 `MZ` 开头的正常文本误判成可执行文件。
 */
export function detectBinaryPayload(text: string): string | undefined {
	if (!text) { return undefined; }
	const decoded = text.slice(0, 512);

	for (const [magic, label] of BINARY_MAGICS) {
		if (!text.startsWith(magic)) { continue; }
		if (AMBIGUOUS_MAGICS.has(magic) && printableRatio(decoded) > 0.9) { continue; }
		return label;
	}

	// 兜底：本应是"网页文本"却大部分不可打印 ⇒ 多半是没收录的二进制/压缩/xml 转码。
	// 阈值取得宽松（>25% 不可打印）：正常中文/emoji 文本几乎全是可打印字符，不会被误伤。
	if (decoded.length >= 64 && printableRatio(decoded) < 0.75) { return '二进制数据（未识别的类型）'; }
	return undefined;
}

/**
 * 可打印字符占比（把 tab/换行/回车算作可打印，它们本就是正文的一部分）。
 *
 * ⚠ 分子分母都按**码点**计：若分母用 `sample.length`（UTF-16 单元），一个 emoji 会被算成
 * "2 个字符、1 个可打印" ⇒ 通篇 emoji 的正文（或大量中日韩扩展字符）比例只有 0.5，会被误判成二进制。
 */
function printableRatio(sample: string): number {
	let printable = 0;
	let total = 0;
	for (const ch of sample) {
		total++;
		const code = ch.codePointAt(0) ?? 0;
		if (code === 9 || code === 10 || code === 13 || code >= 32) { printable++; }
	}
	return total === 0 ? 1 : printable / total;
}

/**
 * 二进制载荷的失败文案（标签化：**不把内容交出去**，并给出可执行的下一步）。
 *
 * 与 `webExtractBlockedMessage` 同一纪律：宁可明确失败，也不要让模型基于垃圾内容作答。
 */
export function binaryPayloadMessage(url: string, kind: string, byteLength: number): string {
	return `Web extract refused: ${url} returned **${kind}**, not a web page `
		+ `(${byteLength} chars of non-text payload were received).`
		+ `\n\nDo NOT treat any part of this response as page content. If you need this file, use \`execute_code\` `
		+ `to download it to the workspace and read it with the file tools instead.`;
}
