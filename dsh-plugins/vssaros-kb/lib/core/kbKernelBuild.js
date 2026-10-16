// @vssaros/dsh-kb — 从盘上**重建 FTS 内核缓存**（`.kbkernel.json` ✓）的纯逻辑 ＋ 最小 I/O（2026-10-13，P1-FTS）。
//
// ## 它复刻的是谁
// 真源 `src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbIndex.ts` 的 `KbFullTextIndex`
// —— 它的 `serialize()`（`:565-578` ✓）写出的磁盘形态是 `{ v:1, docs:[…], avgLen, totalDocs }` ✓。
//
// ## ★ 目标文件是 `.kbkernel.json`（2026-10-13，**第二次取证纠偏** ✓ —— 上一版写 `.ftindex.json` 是错的 ✗）
// 这套索引有**两个写者、两种形态** ✗：
//   · **生产形态**（`uri/title/type/created/…` ✓）：agent 构建管线写 ✓；
//   · **FTS 缓存形态**（本文件 ✓）：`uri/name/path/section/…` ✓。
// 上一版我以为"两个文件、两个用途"（PREBUILT_INDEX_FILES 把两者并列 ✓）⇒ 写 `.ftindex.json` ✗。
// **更深的取证推翻了这个判断** ✓：
//   · 真源**运行时**把 FTS 缓存写到 `.kbkernel.json`（`knowledgeBaseView.ts:3404` 的 persistUri ✓）——
//     `.ftindex.json` 只在"预建索引导入"那条路上被**读** ✓，运行时**没人写它** ✗；
//   · dsh 读侧按 **kernel → ftindex** 顺序试（`store.js:380/420` ✓）⇒ 只要 `.kbkernel.json` 还在，
//     写 `.ftindex.json` 会被**压在下面** ⇒ "dsh 改 ⇒ 检索跟上"**断了** ✗。
// ⇒ 与真源运行时一致的目标 = **`.kbkernel.json`** ✓。覆盖生产形态这件事**真源自己就这么干** ✓
//   （FTS 层 reconcile 后照常写回 ✓），两侧读侧都容忍两种形态 ✓（`parseKernel` ✓）。
//   生产形态的"重建"（title/type/created 来自 frontmatter ✓）属 P1 的另一刀 ✗，本刀不碰 ✓。
//
// ## 口径（逐条照 kbIndex.ts，不是"差不多" ✗ —— 每条都曾被黄金表/集成核对咬过 ✓）
//   · 分区：**库 ＋ 笔记都遍历**（真源 buildRoots 给两个 ✓）；目录递归、**不跳点文件** ✓
//     （真源 walk 不排隐藏件 ✓ —— 我第一版"顺手跳过点文件"是**偏离** ✗，黄金表会咬 ⇒ 去掉 ✓）；
//   · 只收 `TEXT_EXTS`（24 种文本扩展名 ✓ —— 照 `kbIndex.ts:27-30` ✓，PDF 等二进制不收 ✓）；
//   · **>2MB 的文件剔除**（真源 `_reconcileWalk:168` ✓ —— 防大文件把内存索引撑爆 ✓）；
//   · tags = 正文里的 **`#标签#`**（`extractTags` ✓ —— FTS 侧就是这样 ✓；frontmatter 的 tags 属生产形态 ✓）；
//   · length = **`tokenize(name.toLowerCase() + ' ' + cleanText)`** 的词元数（BM25 长度归一 ✓，真源 `:344-345` ✓
//     —— **文件名参与** ✓，我第一版漏了它 ⇒ length 偏小 ✗）；
//   · text = 原文 ✓（真源直接存全文 ✓）；
//   · **mtime = 毫秒**（真源 `c.mtime ?? 0` ✓ —— VS Code FileStat.mtime 就是毫秒 ✓；
//     我第一版 `Math.round(mtimeMs/1000)` 写成**秒** ✗ ⇒ 与真源差 1000 倍，增量 reconcile 全废 ✓）；
//   · **path = fsPath 口径**：Windows 下**小写盘符 ＋ 反斜杠**（`uriToFsPath(keepDriveLetterCasing=false)` ✓
//     `src/vs/base/common/uri.ts:626-650` ✓）—— 我第一版原样写盘 ⇒ 大小写/分隔符都对不上 ✗；
//   · **uri = toString 口径**：`file:///g%3A/…`（**小写盘符** ✓，`_asFormatted` `:700-705` ✓）。
//
// ## ★ 合并形态（2026-10-14，**有意偏离** ✗ —— 摆到台面上 ✓）
// 生产形态（`title/type/created` ✓）在 IDE 代码里**没有写者** ✓ —— 全仓取证：那是 kb_build 子代理按技能手册
// **手写**的（真库 uri 是大写盘符 ⇒ 不是 `URI.file().toString()` ✓）⇒ 没有可逐字搬的构建器 ✓。
// 但 dsh 重建若只写 FTS 形态 ⇒ 这三件展示字段全丢（页面 type 列空、title 退成文件名 ✗）。
// ⇒ 本文件写**合并形态**：9 个 FTS 字段（黄金表钉死 ✓）＋ `title/type/created`（frontmatter 提取 ✓ ——
//   `parseFrontmatter` / `readNoteFrontmatterType` 都是逐字移植且被对账钉过的 ✓）。
//   两侧读侧都容忍多出的键 ✓（`parseKernel` 按键名取 ✓；真源 `deserialize` 只读它认的 ✓）。
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIBRARY_DIR, NOTES_DIR } from './kb.js';
import { extractTags, tokenize } from './kbFulltext.js';
import { parseFrontmatter, readNoteFrontmatterType } from './kbFrontmatter.js';

/** 真源 `kbIndex.ts:27-30` 的 TEXT_EXTS（逐字 ✓ —— 集合内容变了要跟着改 ✓）。 */
const TEXT_EXTS = new Set([
	'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'html', 'htm', 'css', 'scss',
	'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'sh', 'bat', 'ps1', 'xml', 'csv', 'log',
]);

/** 真源 `_reconcileWalk:168` 的 2MB 上限（超出 ⇒ 剔除 ✓）。 */
const MAX_INDEX_BYTES = 2 * 1024 * 1024;

/** 索引文件落盘名 —— 与真源运行时一致：`.kbkernel.json`（`knowledgeBaseView.ts:3404` 的 persistUri ✓，见文件头 ✓）。 */
export const KERNEL_CACHE_FILE = '.kbkernel.json';

/** `URI.file(path).toString()` 的最小等价（`file:///g%3A/…` —— **小写盘符** ✓，照 `_asFormatted` ✓）。 */
function fileUriOf(absPath) {
	const forward = String(absPath).replace(/\\/g, '/');
	const withSlash = /^[A-Za-z]:/.test(forward) ? '/' + forward : forward;
	const lowered = withSlash.replace(/^\/([A-Z]):/, (m, drive) => '/' + drive.toLowerCase() + ':');
	return 'file://' + encodeURI(lowered).replace(/^(\/[a-z]):/, '$1%3A');
}

/** `URI.file(path).fsPath` 的最小等价（Windows：**小写盘符 ＋ 反斜杠** ✓，照 `uriToFsPath` ✓）。 */
function fsPathOf(absPath) {
	const back = String(absPath).replace(/\//g, '\\');
	return back.replace(/^([A-Z]):/, (m, drive) => drive.toLowerCase() + ':');
}

/** 递归收集 `<dir>` 下 `TEXT_EXTS` 的文本文件（**不跳点文件** ✓ —— 与真源 walk 同口径 ✓）。 */
async function walkText(dir, out = []) {
	let entries = [];
	try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
	for (const entry of entries) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) { await walkText(abs, out); continue; }
		const ext = entry.name.split('.').pop()?.toLowerCase();
		if (ext && TEXT_EXTS.has(ext)) { out.push(abs); }
	}
	return out;
}

/**
 * 重建「库 ＋ 笔记」两分区的 FTS 内核缓存文档记录（**纯 I/O 提取**，不写盘 ✓）。
 * 字段逐条照真源 `kbIndex.ts` 的 `serialize()`（`:566-576` ✓）—— 顺序与键名都不能变 ✗。
 * @param vaultDir 库根（绝对路径）
 * @returns 文档记录数组（按路径升序 ⇒ 输出**确定性** ✓，便于黄金表逐条比 ✓）
 */
export async function buildKernelDocs(vaultDir) {
	const files = [];
	for (const [dir, section] of [[join(vaultDir, LIBRARY_DIR), 'library'], [join(vaultDir, NOTES_DIR), 'notes']]) {
		for (const abs of await walkText(dir)) { files.push({ abs, section }); }
	}
	files.sort((a, b) => String(a.abs).localeCompare(String(b.abs)));
	const docs = [];
	for (const { abs, section } of files) {
		const st = await stat(abs);
		if (st.size > MAX_INDEX_BYTES) { continue; }   // 真源 2MB 上限 ✓（超出 ⇒ 剔除 ✓）
		const text = await readFile(abs, 'utf8');
		const name = abs.split(/[\\/]/).pop() ?? '';
		// ⚠ 两条口径都照真源 `:343-345`：tags = 正文 #标签#；length 的分词输入**带文件名小写** ✓。
		const { tags, cleanText } = extractTags(text);
		const tokens = tokenize(name.toLowerCase() + ' ' + cleanText);
		// ★ 元数据三件套（合并形态 ✓，见文件头）：title/created 走完整解析器 ✓；type 走**轻量读法** ✓
		//   （真源里"索引用这条" ✓，`readNoteFrontmatterType` 的注释 ✓）。没有 ⇒ 键就不出现 ✓（不塞空串 ✗）。
		const { frontmatter } = parseFrontmatter(text);
		const fmTitle = frontmatter?.['title'];
		const title = typeof fmTitle === 'string' && fmTitle ? fmTitle
			: Array.isArray(fmTitle) ? fmTitle.toString()          // kbGating 同怪癖 ✓（扁平 YAML 的 title: [a,b] ✓）
			: undefined;
		const type = readNoteFrontmatterType(text);
		const fmCreated = frontmatter?.['created'];
		const created = typeof fmCreated === 'string' && fmCreated ? fmCreated : undefined;
		docs.push({
			uri: fileUriOf(abs),
			name,
			path: fsPathOf(abs),
			section,
			...(title !== undefined ? { title } : {}),
			...(type !== undefined ? { type } : {}),
			...(created !== undefined ? { created } : {}),
			mtime: Math.round(st.mtimeMs),   // ⚠ 毫秒 ✓（真源 c.mtime ✓）—— 写成秒会差 1000 倍 ✗
			size: st.size,
			length: tokens.length,
			tags,
			text,
		});
	}
	return docs;
}

/**
 * 序列化为 FTS 缓存形态（逐字照真源 `:577` ✓）。
 * ⚠ `avgLen` 是 **BM25 的全局量** ✓（真源 `_recomputeStats` ✓）—— 缺它检索分数会错 ✗。
 */
export function serializeKernel(docs) {
	const totalDocs = docs.length;
	const totalLen = docs.reduce((sum, doc) => sum + doc.length, 0);
	const avgLen = totalDocs ? totalLen / totalDocs : 0;
	return JSON.stringify({ v: 1, docs, avgLen, totalDocs });
}

/**
 * 脏检查（P3 自动触发的**判据** ✓，照真源 `_reconcile` 的口径 ✓）：盘上文本文件 vs 内核里的文档条目。
 * 只 readdir ＋ stat（**不读正文** ✓ —— 检索前的检查必须便宜 ✓）。
 * 判 stale 的四种情形（与真源 reconcile 一一对应 ✓）：内核读不到 / 盘上有新文件 /
 * mtime 或 size 变了 / 内核里的条目盘上没了 ✓。
 * ⚠ 生产形态（子代理手写、uri 大写盘符 ✓）的内核**首查必 stale**（uri 对不上 ✓）⇒ 重建一次后进入
 *   合并形态即稳定 ✓ —— 自愈，如实记 ✓。
 * @returns `{ stale: boolean, reason?: string, checked?: number }`
 */
export async function kernelStaleCheck(vaultDir) {
	let kernel = null;
	try { kernel = JSON.parse(await readFile(join(vaultDir, KERNEL_CACHE_FILE), 'utf8')); } catch { /* 读不到 ⇒ stale ✓ */ }
	if (!kernel || !Array.isArray(kernel.docs)) { return { stale: true, reason: 'missing-or-unreadable' }; }
	const byUri = new Map();
	for (const doc of kernel.docs) { if (doc && typeof doc.uri === 'string') { byUri.set(doc.uri, doc); } }
	const diskUris = new Set();
	for (const dir of [join(vaultDir, LIBRARY_DIR), join(vaultDir, NOTES_DIR)]) {
		for (const abs of await walkText(dir)) {
			const uri = fileUriOf(abs);
			diskUris.add(uri);
			const st = await stat(abs);
			if (st.size > MAX_INDEX_BYTES) { continue; }   // 超上限的本就不进索引 ✓（与 buildKernelDocs 同口径 ✓）
			const doc = byUri.get(uri);
			if (!doc) { return { stale: true, reason: `new:${uri}` }; }
			if (doc.mtime !== Math.round(st.mtimeMs) || doc.size !== st.size) { return { stale: true, reason: `changed:${uri}` }; }
		}
	}
	for (const uri of byUri.keys()) {
		if (!diskUris.has(uri)) { return { stale: true, reason: `deleted:${uri}` }; }
	}
	return { stale: false, checked: diskUris.size };
}

/**
 * 重建并落盘 `<vaultDir>/.kbkernel.json`（FTS 缓存形态 ✓ —— 与真源运行时同一个文件 ✓，见文件头 ✓）。
 * ⚠ **调用方必须先取 vault 锁** ✗（本模块不加锁 —— 锁的口径在 `lib/lock.js` ✓，由路由/工具层拿 ✓）。
 * @returns `{ docs, path }`
 */
export async function rebuildKernelCache(vaultDir) {
	const docs = await buildKernelDocs(vaultDir);
	const path = join(vaultDir, KERNEL_CACHE_FILE);
	await writeFile(path, serializeKernel(docs), 'utf8');
	return { docs, path };
}
