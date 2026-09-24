/*---------------------------------------------------------------------------------------------
 *  kbArchiveExtract —— 把 **epub / docx**（本质都是 zip 容器）解成 Markdown（★ 2026-09-24）。
 *
 *  背景（用户需求）：知识库/聊天框里的 epub、pdf、doc 无法被 LLM 直接解读。
 *    · PDF ⇒ 走既有主进程 python（pymupdf4llm/pypdf，见 kbDocConvertChannel）；
 *    · epub/docx ⇒ 本模块，**纯 TS + Node 内置 `zlib`**，不引第三方依赖、也**不需要本机装 python**。
 *
 *  为什么自己解析 zip（而不是用 jszip / python zipfile）：
 *    · jszip 在本仓库只是 webview 自身 node_modules 里的**传递依赖**（无声明、不进主进程打包）；
 *      引它要动依赖清单 + 打包清单（本仓库打包不随主进程带 node_modules）。
 *    · python zipfile 要依赖用户机器装了 python —— 而 epub/docx 只是「解压 + 读 XML」，
 *      Node 内置 `zlib.inflateRawSync` 足够 ⇒ 让这条链路**零外部依赖**。
 *
 *  ⚠ 只支持 zip 的 stored(0) / deflate(8) 两种压缩方式（epub/docx 规范即此两种）；
 *     Zip64（>4GB）与其它压缩方式明确报错，不做静默降级。
 *  ⚠ 本模块被 electron-main 引用 ⇒ **不能 import 任何 browser / DOM 模块**（只有纯函数）。
 *--------------------------------------------------------------------------------------------*/

import { inflateRawSync } from 'zlib';

/** 解析出的结果（与 `IKbExtractDocTextResult` 的字段语义对齐）。 */
export interface IArchiveExtractResult {
	ok: boolean;
	/** Markdown 正文（`ok=true` 时给出，可能为空串 —— 例如 docx 只有图片）。 */
	markdown?: string;
	/** 章节数（epub 的 spine 项数 / docx 的段落组数，仅用于「空文档」判定与展示）。 */
	chapters?: number;
	error?: string;
}

/** zip 中的一条条目（只保留解出来需要的字段）。 */
interface IZipEntry {
	name: string;
	compressedSize: number;
	method: number;
	localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/**
 * 读取 zip 的**中央目录**（EOCD → 条目表）。
 *
 * 为什么不逐个读 local header 顺序扫：local header 的 size 字段可能为 0（流式写入），
 * 只有中央目录是可信的。EOCD 也可能带注释 ⇒ 从尾部向前扫描签名。
 */
export function readZipEntries(buf: Buffer): IZipEntry[] | string {
	// ① 找 EOCD（签名出现在最后 64KB 内，最多 65535 字节注释 + 22 字节固定头）
	const minEocd = Math.max(0, buf.length - (22 + 0xffff));
	let eocd = -1;
	for (let i = buf.length - 22; i >= minEocd; i--) {
		if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
	}
	if (eocd < 0) { return '不是有效的 zip 容器（未找到 EOCD）'; }

	const total = buf.readUInt16LE(eocd + 10);
	let offset = buf.readUInt32LE(eocd + 16);
	if (total === 0xffff || offset === 0xffffffff) { return '暂不支持 Zip64 格式的压缩包'; }

	const entries: IZipEntry[] = [];
	for (let i = 0; i < total; i++) {
		if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) {
			return `中央目录损坏（第 ${i + 1} 条）`;
		}
		const method = buf.readUInt16LE(offset + 10);
		const compressedSize = buf.readUInt32LE(offset + 20);
		const nameLen = buf.readUInt16LE(offset + 28);
		const extraLen = buf.readUInt16LE(offset + 30);
		const commentLen = buf.readUInt16LE(offset + 32);
		const localHeaderOffset = buf.readUInt32LE(offset + 42);
		const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
		if (compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
			return `暂不支持 Zip64 条目：${name}`;
		}
		entries.push({ name, compressedSize, method, localHeaderOffset });
		offset += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

/** 取出某条目的内容（deflate/stored）。 */
export function readZipEntry(buf: Buffer, entry: IZipEntry): Buffer | string {
	const at = entry.localHeaderOffset;
	if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOC_SIG) { return `本地头损坏：${entry.name}`; }
	const nameLen = buf.readUInt16LE(at + 26);
	const extraLen = buf.readUInt16LE(at + 28);
	const start = at + 30 + nameLen + extraLen;
	const raw = buf.subarray(start, start + entry.compressedSize);
	try {
		if (entry.method === 8) { return inflateRawSync(raw); }
		if (entry.method === 0) { return Buffer.from(raw); }
		return `暂不支持的压缩方式（method=${entry.method}）：${entry.name}`;
	} catch (err) {
		return `解压失败（${entry.name}）：${err instanceof Error ? err.message : String(err)}`;
	}
}

/** 从 zip 里按名字取文本（大小写不敏感；找不到 ⇒ undefined）。 */
function textOf(buf: Buffer, entries: IZipEntry[], path: string): string | undefined {
	const want = path.toLowerCase();
	const entry = entries.find(e => e.name.toLowerCase() === want);
	if (!entry) { return undefined; }
	const content = readZipEntry(buf, entry);
	return typeof content === 'string' ? undefined : content.toString('utf8');
}

// ─── 文本清洗（HTML/XML → Markdown 的最小实现）────────────────────────────────

const ENTITIES: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
	hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
};

/** XML/HTML 实体解码（含 `&#NN;` / `&#xNN;`；未识别的一律还原成空格，避免残留 `&xxx;` 噪声）。 */
export function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
		if (body.startsWith('#')) {
			const code = body[1] === 'x' || body[1] === 'X'
				? parseInt(body.slice(2), 16)
				: parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
		}
		return ENTITIES[body.toLowerCase()] ?? ' ';
	});
}

/** 去掉脚本/样式块（它们的内容不该进正文）。 */
function stripScripts(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * XHTML/HTML → Markdown（**最小实现**：标题、段落、列表、换行）。
 *
 * 为什么不用现成的 html→md 库：主进程不打包 node_modules（见文件头），
 * 而这里的输入是**受控的**（epub 的 XHTML / docx 的 WordprocessingML 文本），
 * 只需覆盖标题/段落/列表这三种结构即可获得可读、可检索的正文。
 */
export function htmlToMarkdown(html: string): string {
	let s = stripScripts(html);
	// 结构性标签 → markdown（顺序敏感：先块级后行内）
	s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => `\n\n${'#'.repeat(Number(lvl))} ${inner}\n\n`);
	s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inner}`);
	s = s.replace(/<\/(p|div|section|article|blockquote|tr|figure|figcaption)>/gi, '\n\n');
	s = s.replace(/<br\s*\/?>/gi, '\n');
	s = s.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');
	s = s.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_m, alt: string) => (alt ? `（图：${alt}）` : ''));
	// 其余标签丢弃（保内容不保样式）
	s = s.replace(/<[^>]+>/g, '');
	s = decodeEntities(s);
	// 收敛空行：连续 3 个以上换行压成 2 个
	return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── docx ────────────────────────────────────────────────────────────────────

/**
 * docx（`word/document.xml`）→ Markdown。
 *
 * 覆盖：标题样式（`w:pStyle w:val="Heading1"`）、普通段落、制表/换行、
 * 以及**表格**（`w:tbl` → markdown 表格）。图片（`w:drawing`）v1 忽略（记数另由调用方决定）。
 */
export function docxToMarkdown(documentXml: string): string {
	const out: string[] = [];
	// ⚠ 必须**按文档顺序**单趟扫描：把表格先替换成文本、再只遍历 `<w:p>` 的写法会丢掉表格
	//   （替换出的 markdown 不在 `<w:p>` 里 ⇒ 被静默丢弃，实测就是这么丢的）。
	const blocks = documentXml.match(/<w:tbl[\s>][\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>/g) ?? [];
	for (const block of blocks) {
		if (block.startsWith('<w:tbl')) {
			const table = tableToMarkdown(block);
			if (table) { out.push(table); }
			continue;
		}
		const text = runsToText(block).trim();
		if (!text) { continue; }
		const style = /<w:pStyle[^>]*w:val=["']([^"']+)["']/i.exec(block)?.[1] ?? '';
		const level = /^heading\s*([1-6])$/i.exec(style)?.[1] ?? (/^Title$/i.test(style) ? '1' : undefined);
		out.push(level ? `${'#'.repeat(Number(level))} ${text}` : text);
	}
	return out.join('\n\n').trim();
}

/** `w:tbl` → markdown 表格（首行作表头；单元格内的竖线转义，避免破坏表格结构）。 */
function tableToMarkdown(tblXml: string): string {
	const rows: string[][] = [];
	for (const rowXml of tblXml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? []) {
		const cells = (rowXml.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) ?? [])
			.map(cellXml => runsToText(cellXml).trim());
		if (cells.length) { rows.push(cells); }
	}
	if (!rows.length) { return ''; }
	const width = Math.max(...rows.map(r => r.length));
	const line = (cells: string[]): string =>
		`| ${Array.from({ length: width }, (_, i) => (cells[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`;
	return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

/** 提取一段 WordprocessingML 里的可见文本（`w:t` 内容 + `w:br`/`w:tab`）。 */
function runsToText(xml: string): string {
	return decodeEntities(
		xml
			.replace(/<w:br\s*\/>/g, '\n')
			.replace(/<w:tab\s*\/>/g, ' ')
			.replace(/<[^>]+>/g, ''),
	).replace(/\s+\n/g, '\n');
}

// ─── epub ────────────────────────────────────────────────────────────────────

/** OPF（`content.opf`）里 spine 顺序的正文文件列表。 */
export function epubSpine(opfXml: string, opfDir: string): string[] {
	const manifest = new Map<string, string>();
	for (const item of opfXml.match(/<item[\s>][^>]*>/gi) ?? []) {
		const id = /\bid=["']([^"']+)["']/i.exec(item)?.[1];
		const href = /\bhref=["']([^"']+)["']/i.exec(item)?.[1];
		if (id && href) { manifest.set(id, href); }
	}
	const ids = [...(opfXml.match(/<itemref[\s>][^>]*>/gi) ?? [])]
		.map(ref => /\bidref=["']([^"']+)["']/i.exec(ref)?.[1])
		.filter((v): v is string => !!v);
	const resolve = (href: string): string => {
		const clean = decodeEntities(href.split('#')[0]);
		if (!opfDir) { return clean; }
		// epub 里 href 相对 OPF 所在目录
		const parts = `${opfDir}/${clean}`.split('/');
		const stack: string[] = [];
		for (const p of parts) {
			if (!p || p === '.') { continue; }
			if (p === '..') { stack.pop(); continue; }
			stack.push(p);
		}
		return stack.join('/');
	};
	const list = ids.map(id => manifest.get(id)).filter((v): v is string => !!v).map(resolve);
	// spine 为空（不规范 epub）⇒ 退回 manifest 里全部 xhtml/html，保持顺序
	if (!list.length) {
		return [...manifest.values()].filter(h => /\.x?html?$/i.test(h)).map(resolve);
	}
	return list;
}

/** epub → Markdown（按 spine 顺序逐章转，章标题取 `<title>` 或首个标题）。 */
export function epubToMarkdown(buf: Buffer, entries: IZipEntry[]): IArchiveExtractResult {
	// ① container.xml → OPF 路径（epub 规范入口）
	const container = textOf(buf, entries, 'META-INF/container.xml');
	const opfPath = container
		? /<rootfile[^>]*full-path=["']([^"']+)["']/i.exec(container)?.[1]
		: (entries.find(e => /\.opf$/i.test(e.name))?.name);
	if (!opfPath) { return { ok: false, error: 'epub 缺少 OPF（container.xml/rootfile 未找到）' }; }

	const opfXml = textOf(buf, entries, decodeEntities(opfPath));
	if (!opfXml) { return { ok: false, error: `epub 内找不到 OPF：${opfPath}` }; }

	const spine = epubSpine(opfXml, opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '');
	if (!spine.length) { return { ok: false, error: 'epub 的 spine 为空（无法确定阅读顺序）' }; }

	const chapters: string[] = [];
	for (const file of spine) {
		const html = textOf(buf, entries, file);
		if (!html) { continue; }
		const body = htmlToMarkdown(html);
		if (!body) { continue; }
		const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
		// 正文自带标题就不重复加（避免「## 第 3 章」下面又跟一个同名 H1）
		const hasHeading = /^#{1,6}\s/.test(body);
		chapters.push(hasHeading || !title ? body : `## ${decodeEntities(title)}\n\n${body}`);
	}
	if (!chapters.length) { return { ok: false, error: 'epub 各章节均为空或无法解析' }; }
	return { ok: true, markdown: chapters.join('\n\n'), chapters: chapters.length };
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 按扩展名把 epub/docx 解成 Markdown。
 *
 * @param filePath 仅用于判定类型与报错文案（内容由 `buf` 给出，便于单测）
 */
export function extractArchiveMarkdown(filePath: string, buf: Buffer): IArchiveExtractResult {
	const ext = (filePath.split('.').pop() ?? '').toLowerCase();
	if (ext !== 'epub' && ext !== 'docx') { return { ok: false, error: `不支持的类型：.${ext}（仅 epub/docx）` }; }
	if (!buf.length) { return { ok: false, error: '文件为空' }; }

	const entries = readZipEntries(buf);
	if (typeof entries === 'string') { return { ok: false, error: entries }; }

	try {
		if (ext === 'docx') {
			const xml = textOf(buf, entries, 'word/document.xml');
			if (!xml) { return { ok: false, error: 'docx 缺少 word/document.xml（不是有效的 .docx）' }; }
			const markdown = docxToMarkdown(xml);
			return { ok: true, markdown, chapters: 1 };
		}
		return epubToMarkdown(buf, entries);
	} catch (err) {
		return { ok: false, error: `解析失败：${err instanceof Error ? err.message : String(err)}` };
	}
}
