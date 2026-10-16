// @vssaros/dsh-kb — 把 **epub / docx**（本质都是 zip 容器）解成 Markdown（2026-10-14，P2 续）。
//
// ⚠ 这是真源 `src/vs/sessions/contrib/agentStudio/common/kbArchiveExtract.ts` 的**逐字移植**
//   （只剥 TS 类型 ✓；逻辑一行不改 ✗），**唯一的有意偏离**：解压从 `inflateRawSync` 改成
//   **`await inflateRaw`**（libuv 线程池 ✓）—— 真源在 IDE 主进程用同步没问题 ✓，但 **dsh Host 是单线程**：
//   同步解压大文件会把**同进程的页面/工具/反向桥一起卡住** ✗（仓里有过 129MB 图谱的真事故 ⇒
//   `dshPluginPackages.test.ts` 有"插件不许用同步解压"的守卫 ✓，本模块必须守它 ✓）。
//   代价如实记 ✗：调用链变成 async ⇒ **真源那套同步测试不能直接跑在本副本上** ⇒ 防漂移改用
//   **黄金表**（p3-82：同一批夹具两边各跑、逐输出比 ✓）。
//
//   真源的其余架构约束（照抄 ✓）：只支持 zip 的 stored(0)/deflate(8) ✓；Zip64 与其它压缩方式
//   **明确报错** ✓；本模块的 I/O 只有"调用侧读文件" ✓（内部仍是纯函数 ✓）。
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflateRawAsync = promisify(inflateRaw);

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/**
 * 读取 zip 的**中央目录**（EOCD → 条目表）。
 *
 * 为什么不逐个读 local header 顺序扫：local header 的 size 字段可能为 0（流式写入），
 * 只有中央目录是可信的。EOCD 也可能带注释 ⇒ 从尾部向前扫描签名。
 */
export function readZipEntries(buf) {
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

	const entries = [];
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

/** 取出某条目的内容（deflate/stored）。⚠ **异步**（见文件头那条偏离 ✓）。 */
export async function readZipEntry(buf, entry) {
	const at = entry.localHeaderOffset;
	if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOC_SIG) { return `本地头损坏：${entry.name}`; }
	const nameLen = buf.readUInt16LE(at + 26);
	const extraLen = buf.readUInt16LE(at + 28);
	const start = at + 30 + nameLen + extraLen;
	const raw = buf.subarray(start, start + entry.compressedSize);
	try {
		if (entry.method === 8) { return await inflateRawAsync(raw); }
		if (entry.method === 0) { return Buffer.from(raw); }
		return `暂不支持的压缩方式（method=${entry.method}）：${entry.name}`;
	} catch (err) {
		return `解压失败（${entry.name}）：${err instanceof Error ? err.message : String(err)}`;
	}
}

/** 从 zip 里按名字取文本（大小写不敏感；找不到 ⇒ undefined）。⚠ 异步（readZipEntry 变了 ✓）。 */
async function textOf(buf, entries, path) {
	const want = path.toLowerCase();
	const entry = entries.find(e => e.name.toLowerCase() === want);
	if (!entry) { return undefined; }
	const content = await readZipEntry(buf, entry);
	return typeof content === 'string' ? undefined : content.toString('utf8');
}

// ─── 文本清洗（HTML/XML → Markdown 的最小实现）────────────────────────────────

const ENTITIES = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
	hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
};

/** XML/HTML 实体解码（含 `&#NN;` / `&#xNN;`；未识别的一律还原成空格，避免残留 `&xxx;` 噪声）。 */
export function decodeEntities(text) {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
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
function stripScripts(html) {
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
export function htmlToMarkdown(html) {
	let s = stripScripts(html);
	// 结构性标签 → markdown（顺序敏感：先块级后行内）
	s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, inner) => `\n\n${'#'.repeat(Number(lvl))} ${inner}\n\n`);
	s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${inner}`);
	s = s.replace(/<\/(p|div|section|article|blockquote|tr|figure|figcaption)>/gi, '\n\n');
	s = s.replace(/<br\s*\/?>/gi, '\n');
	s = s.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');
	s = s.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_m, alt) => (alt ? `（图：${alt}）` : ''));
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
export function docxToMarkdown(documentXml) {
	const out = [];
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
function tableToMarkdown(tblXml) {
	const rows = [];
	for (const rowXml of tblXml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? []) {
		const cells = (rowXml.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) ?? [])
			.map(cellXml => runsToText(cellXml).trim());
		if (cells.length) { rows.push(cells); }
	}
	if (!rows.length) { return ''; }
	const width = Math.max(...rows.map(r => r.length));
	const line = (cells) =>
		`| ${Array.from({ length: width }, (_, i) => (cells[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`;
	return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

/** 提取一段 WordprocessingML 里的可见文本（`w:t` 内容 + `w:br`/`w:tab`）。 */
function runsToText(xml) {
	return decodeEntities(
		xml
			.replace(/<w:br\s*\/>/g, '\n')
			.replace(/<w:tab\s*\/>/g, ' ')
			.replace(/<[^>]+>/g, ''),
	).replace(/\s+\n/g, '\n');
}

// ─── epub ────────────────────────────────────────────────────────────────────

/** OPF（`content.opf`）里 spine 顺序的正文文件列表。 */
export function epubSpine(opfXml, opfDir) {
	const manifest = new Map();
	for (const item of opfXml.match(/<item[\s>][^>]*>/gi) ?? []) {
		const id = /\bid=["']([^"']+)["']/i.exec(item)?.[1];
		const href = /\bhref=["']([^"']+)["']/i.exec(item)?.[1];
		if (id && href) { manifest.set(id, href); }
	}
	const ids = [...(opfXml.match(/<itemref[\s>][^>]*>/gi) ?? [])]
		.map(ref => /\bidref=["']([^"']+)["']/i.exec(ref)?.[1])
		.filter(v => !!v);
	const resolve = (href) => {
		const clean = decodeEntities(href.split('#')[0]);
		if (!opfDir) { return clean; }
		// epub 里 href 相对 OPF 所在目录
		const parts = `${opfDir}/${clean}`.split('/');
		const stack = [];
		for (const p of parts) {
			if (!p || p === '.') { continue; }
			if (p === '..') { stack.pop(); continue; }
			stack.push(p);
		}
		return stack.join('/');
	};
	const list = ids.map(id => manifest.get(id)).filter(v => !!v).map(resolve);
	// spine 为空（不规范 epub）⇒ 退回 manifest 里全部 xhtml/html，保持顺序
	if (!list.length) {
		return [...manifest.values()].filter(h => /\.x?html?$/i.test(h)).map(resolve);
	}
	return list;
}

/** epub → Markdown（按 spine 顺序逐章转，章标题取 `<title>` 或首个标题）。⚠ 异步（textOf 变了 ✓）。 */
export async function epubToMarkdown(buf, entries) {
	// ① container.xml → OPF 路径（epub 规范入口）
	const container = await textOf(buf, entries, 'META-INF/container.xml');
	const opfPath = container
		? /<rootfile[^>]*full-path=["']([^"']+)["']/i.exec(container)?.[1]
		: (entries.find(e => /\.opf$/i.test(e.name))?.name);
	if (!opfPath) { return { ok: false, error: 'epub 缺少 OPF（container.xml/rootfile 未找到）' }; }

	const opfXml = await textOf(buf, entries, decodeEntities(opfPath));
	if (!opfXml) { return { ok: false, error: `epub 内找不到 OPF：${opfPath}` }; }

	const spine = epubSpine(opfXml, opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '');
	if (!spine.length) { return { ok: false, error: 'epub 的 spine 为空（无法确定阅读顺序）' }; }

	const chapters = [];
	for (const file of spine) {
		const html = await textOf(buf, entries, file);
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
 * 按扩展名把 epub/docx 解成 Markdown。⚠ **异步**（见文件头那条偏离 ✓）。
 *
 * @param filePath 仅用于判定类型与报错文案（内容由 `buf` 给出，便于单测）
 */
export async function extractArchiveMarkdown(filePath, buf) {
	const ext = (filePath.split('.').pop() ?? '').toLowerCase();
	if (ext !== 'epub' && ext !== 'docx') { return { ok: false, error: `不支持的类型：.${ext}（仅 epub/docx）` }; }
	if (!buf.length) { return { ok: false, error: '文件为空' }; }

	const entries = readZipEntries(buf);
	if (typeof entries === 'string') { return { ok: false, error: entries }; }

	try {
		if (ext === 'docx') {
			const xml = await textOf(buf, entries, 'word/document.xml');
			if (!xml) { return { ok: false, error: 'docx 缺少 word/document.xml（不是有效的 .docx）' }; }
			const markdown = docxToMarkdown(xml);
			return { ok: true, markdown, chapters: 1 };
		}
		return await epubToMarkdown(buf, entries);
	} catch (err) {
		return { ok: false, error: `解析失败：${err instanceof Error ? err.message : String(err)}` };
	}
}
