#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  kb-feishu-sync.mjs — 知识库 → 飞书（lark-cli）同步工具（C1 阶段，验证规则用）。
 *
 *  规则真源：doc/kb-feishu-sync-spec.md
 *    - 身份锚定：笔记 frontmatter `feishu:` 块（token/hash/url/rev/syncedAt）
 *    - 去重：hash 相同 ⇒ skip（零 API 调用）
 *    - 更新：hash 变化 ⇒ `docs +update --command overwrite --doc-format markdown`
 *    - 单向上行：本地 vault 是 source of truth
 *
 *  用法（先 dry-run！）：
 *    node .codebuddy/kb-feishu-sync.mjs --vault <vault根> --src <相对目录> --dry-run
 *    node .codebuddy/kb-feishu-sync.mjs --vault <vault根> --src <相对目录> --apply --parent my_library
 *
 *  参数：
 *    --vault    vault 根（默认 dev 最近使用的 knowledge-base 目录需显式给）
 *    --src      相对 vault 的源目录（可重复；默认 库），相对路径用于 wiki 层级
 *    --parent   my_library（个人知识库）或 folder token（--parent-token 同义）
 *    --dry-run  只打印计划（推荐先跑；无需登录）
 *    --apply    实际执行（需 lark-cli 已登录 user 身份）
 *    --limit N  最多处理 N 篇（渐进放量）
 *    --interval ms  每篇间隔（默认 800，限速）
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 系统维护文件（不同步正文）。 */
const SYS_FILES = new Set(['index.md', 'overview.md', 'insights.md', 'log.md', 'lint-report.md', 'dedup-report.md']);
/** 目录跳过（工具/配置目录）。 */
const SKIP_DIRS = new Set(['.obsidian', '.workbuddy', '.trash', 'node_modules', '.git']);

const INDEX_FILE = '.feishu-sync.json';
const LOG_FILE = '.feishu-sync.log';
/**
 * 「本次报告」（`--plan-file`）逐篇条目的上限：超出只保留前 N 条 + 一行提示。
 * 报告是给 agent/用户**看计划与结果**用的，不该因为一个超大库变成几 MB。
 */
export const REPORT_MAX_ITEMS = 300;
/** 索引结构版本：v2 起含 `spaces`（类别→知识库映射）与 `files` 明细；读取时兼容 v1 扁平结构。 */
const INDEX_VERSION = 2;

// ─── 参数解析 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const out = {
		src: [], parent: 'my_library', dryRun: false, apply: false, limit: 0, interval: 800,
		vault: '', help: false, onConflict: 'overwrite', cli: '',
		/**
		 * ★ 2026-09-24：**本次运行报告的输出文件**（UTF-8）。
		 *
		 * 为什么需要它：宿主工具（`kb_feishu_sync`）只能拿到主进程按 **GBK 解码**的 stdout ⇒ 中文乱码，
		 * 于是此前改用「读 `.feishu-sync.log` 尾部」回报 —— 但 dry-run **从不写日志**（见本文件末尾：
		 * `if (!args.dryRun) { if (logLines.length) appendFileSync(...) }`）⇒ 预览时工具只能拿到**旧日志**；
		 * apply 时也可能读到与本次无关的旧内容。⇒ 现在由脚本**主动写一份本次报告**（含计划/结果逐篇），
		 * 工具读它即可准确回报「预览了什么 / 实际做了什么、有没有失败」。
		 */
		planFile: '',
		/** 类别 = src 下第 N 级目录（默认 1 级）；0 = 不分类别（全部走 --parent）。 */
		categoryDepth: 1,
		/** 未映射类别是否自动创建飞书知识库（用户 2026-09-21 确认：默认开）。 */
		autoCreateSpaces: true,
		/** 本地已删除的文档是否同时移除远端节点（默认关，安全）。 */
		prune: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === '--vault') { out.vault = next(); }
		else if (a === '--src') { out.src.push(next()); }
		else if (a === '--parent') { out.parent = next(); }
		else if (a === '--dry-run') { out.dryRun = true; }
		else if (a === '--apply') { out.apply = true; }
		else if (a === '--limit') { out.limit = Number(next()) || 0; }
		else if (a === '--interval') { out.interval = Number(next()) || 800; }
		else if (a === '--on-conflict') { out.onConflict = (next() === 'skip' ? 'skip' : 'overwrite'); }
		else if (a === '--cli') { out.cli = next(); }
		else if (a === '--category-depth') { out.categoryDepth = Math.max(0, Number(next()) || 0); }
		else if (a === '--auto-create-spaces') { out.autoCreateSpaces = true; }
		else if (a === '--no-auto-create-spaces') { out.autoCreateSpaces = false; }
		else if (a === '--prune') { out.prune = true; }
		else if (a === '--refresh-remote') { out.refreshRemote = true; }
	else if (a === '--plan-file') { out.planFile = next(); }
		else if (a === '--space-map') { out.spaceMap = next(); }
		else if (a === '--no-mindmap') { out.noMindmap = true; }
		else if (a === '-h' || a === '--help') { out.help = true; }
	}
	if (out.src.length === 0) { out.src = ['库']; }
	if (!out.dryRun && !out.apply) { out.dryRun = true; } // 默认安全：不显式 --apply 一律 dry-run
	return out;
}

/** parent 参数 → CLI 标志（my_library = 个人知识库；其他视为 folder token）。 */
function parentArgs(parent) {
	// ⚠ CLI 1.0.9x（v2 形态）：--parent-position（如 my_library）/ --parent-token（folder 或 wiki node token）
	return parent === 'my_library' ? ['--parent-position', 'my_library'] : ['--parent-token', parent];
}

const USAGE = `kb-feishu-sync — 知识库 → 飞书同步（规则见 doc/kb-feishu-sync-spec.md）

  node .codebuddy/kb-feishu-sync.mjs --vault <vault根> [--src <相对目录>]... [--dry-run | --apply]
                                     [--parent my_library | <folderToken>] [--limit N] [--interval ms]
                                     [--on-conflict overwrite | skip]
                                     [--category-depth N] [--no-auto-create-spaces] [--prune]
                                     [--plan-file <path>（写本次报告：计划/结果逐篇；UTF-8，dry-run 也写）]
                                    [--refresh-remote（配 --apply；重建远端指纹基线）]

  默认 dry-run（只打印计划，不产生任何飞书写操作）。
  --on-conflict：远端被手工修改时（remoteHash 不一致）的策略，默认 overwrite（本地覆盖 + 警告）。

  类别 → 飞书知识库：
    类别 = --src 下第 N 级目录（--category-depth，默认 1）⇒ 每个类别对应一个飞书 wiki 知识库。
    未映射的类别默认**自动创建**同名知识库（--no-auto-create-spaces 可关闭；关闭后其文档将被跳过）。
    src 根下的文件（无类别）仍走 --parent 落点。
    文档换了类别（目标知识库 ≠ 上次记录）⇒ 自动跨知识库移动节点（wiki +move）。
  --prune：本地已删除的文档同时移除远端节点（默认**关**，安全）。`;

// ─── 指纹与 frontmatter ──────────────────────────────────────────────────────

/** 规范化 markdown（spec §2.1）：剥 frontmatter、统一换行、本地绝对路径归一。 */
export function normalizeForHash(raw) {
	let text = raw.replace(/\r\n/g, '\n');
	// 剥离 frontmatter（含 feishu 块与时间字段）
	if (text.startsWith('---\n')) {
		const end = text.indexOf('\n---', 4);
		if (end >= 0) { text = text.slice(text.indexOf('\n', end + 1) + 1); }
	}
	return text
		.split('\n')
		.map(l => l.replace(/\s+$/, '').replace(/file:\/\/\/[^\s)]+/g, '<local>').replace(/[A-Za-z]:\\[^\s)]+/g, '<local>'))
		.join('\n')
		.trim();
}

export function contentHash(raw) {
	return crypto.createHash('sha256').update(normalizeForHash(raw)).digest('hex').slice(0, 16);
}

/**
 * 同步前正文预处理（真机实测暴露的布局问题）：
 *  - `[[a|b]]`（wikilink 别名）在飞书 markdown 导入时，单元格/行内 `|` 会被当表格分隔符，
 *    导致后续内容被截断（实测「[[知识框架思维导图|打开…]]」在表格里被切断）⇒
 *    统一替换为别名文本 `b`（语义不变、可读性最好，飞书里 `[[a]]` 本就是纯文本）。
 *  - 其余 `[[a]]` 保持原样（作为纯文本可被飞书搜索命中，便于人工定位）。
 */
export function prepareMarkdownForSync(markdown) {
	return markdown.replace(/\[\[([^\]\n|]+)\|([^\]\n]+)\]\]/g, (_m, _target, alias) => alias.trim());
}

// ─── 图片链路（实测：飞书 markdown 导入不处理本地图片 ⇒ 需上传后定位插入）────────

/**
 * 可插入飞书的本地图片扩展名。
 *
 * ⚠ **不含 `svg`**：2026-09-23 实测，`<img path="@./x.svg"/>` 会被飞书拒绝：
 *   `local image #1: file is not a supported BMP, GIF, JPEG, PNG, TIFF, or WebP image`
 * 即飞书只认 BMP / GIF / JPEG / PNG / TIFF / WebP。
 * ⇒ mermaid / drawio 这类「源码 → SVG」的图**必须先栅格化成 PNG** 才能同步
 *   （不能直接把渲染出的 SVG 落盘当图片插入）。
 */
const IMAGE_EXT = 'png|jpe?g|gif|webp|bmp|tiff?';
/** Obsidian embed：`![[x.png]]`；标准 md：`![](x.png)` */
const IMAGE_REF_RE = new RegExp(`!\\[\\[([^\\]\\n]+\\.(?:${IMAGE_EXT}))\\]\\]|!\\[[^\\]\\n]*\\]\\(([^)\\s]+\\.(?:${IMAGE_EXT}))\\)`, 'gi');

/**
 * 抽取正文中的本地图片引用并替换为占位标记（飞书导入不认本地路径，实测会渲染成
 * `<image token="">` 空占位）。占位标记随后用 `docs +media-insert --selection-with-ellipsis`
 * 定位插图，再删除占位文本。
 * @returns `{ markdown, images: [{ placeholder, ref, absPath }] }`（absPath 为空 ⇒ 文件不存在，跳过）
 */
export function extractImages(markdown, noteDir) {
	const missing = [];
	const inline = [];
	const images = [];
	let index = 0;
	const out = markdown.replace(IMAGE_REF_RE, (_m, obsRef, mdRef, offset, whole) => {
		const ref = String(obsRef ?? mdRef ?? '').trim();
		if (!ref || /^https?:|^data:|^file:/i.test(ref) || ref.startsWith('/')) { return _m; } // 远程/绝对引用不处理
		const absPath = path.resolve(noteDir, ref);
		if (!fs.existsSync(absPath)) { missing.push(ref); return _m; } // 找不到文件：保留原样并记录（调用方告警）

		// ⚠ 插图用的是 `block_replace`（**整块**替换）⇒ 占位必须独占段落，
		//    否则会把同段的其它文字一起替换掉。判断当前行是否只有这一个引用。
		const lineStart = whole.lastIndexOf('\n', offset - 1) + 1;
		const lineEnd = whole.indexOf('\n', offset);
		const line = whole.slice(lineStart, lineEnd === -1 ? whole.length : lineEnd);
		const standalone = line.trim() === _m.trim() && !line.includes('|');

		const placeholder = `KBSYNCIMG${++index}`;
		images.push({ placeholder, ref, absPath, standalone });
		if (!standalone) { inline.push(ref); }
		return standalone ? `\n\n${placeholder}\n\n` : placeholder;
	});
	// 补空行可能产生连续多余空行 ⇒ 压缩为标准段间空行
	return { markdown: out.replace(/\n{3,}/g, '\n\n'), images, missing, inline };
}

/**
 * 在 DocxXML（`--detail with-ids`）里找「文本恰为占位」的块 id。
 * 占位在正文里独占一个段落 ⇒ 形如 `<p id="doxcn…">KBSYNCIMG1</p>`。
 */
export function findBlockIdByText(xml, text) {
	if (!xml || !text) { return ''; }
	const esc = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`<(p|h\\d)\\s+id="([^"]+)"[^>]*>\\s*${esc}\\s*</\\1>`, 'i');
	const m = re.exec(xml);
	return m ? m[2] : '';
}

/**
 * 图片链路（CLI 1.0.9x 适配，**已实测**）。
 *
 * 旧 CLI 用 `docs +media-insert --selection-with-ellipsis` 按占位定位；新 CLI 已移除该参数
 * （只能插到文档末尾）⇒ 改为：**占位文本 → `block_replace` 为 DocxXML `<img path="@./x.png"/>`**，
 * 由 CLI 自动上传本地图片并原位替换（实测返回 `block_type: "image"`）。
 *
 * ⚠ 三条硬约束（实测）：
 *  1. 本地图片只支持 `append` / `block_insert_after` / `block_replace` / `overwrite`
 *     （`str_replace` 会报错）。
 *  2. `--content @file` 与 `<img path="…">` 的相对路径都基于 **cwd** ⇒ cwd 设为笔记目录，
 *     临时 xml 也写到该目录（用完即删）。
 *  3. `path` 必须是**本地相对路径**（`<img img_key="token">` 会报 `Image resource resolve failed`）。
 */
function insertImages(docToken, images, noteDir, interval) {
	let ok = 0;
	if (!images.length) { return ok; }

	// 取带块 id 的文档结构（定位占位块）
	const f = lark(['docs', '+fetch', '--doc', docToken, '--detail', 'with-ids', '--as', 'user'], noteDir);
	const xml = extractJson(f.stdout)?.data?.document?.content ?? '';
	if (!xml) {
		console.warn('        ↳ ⚠ 无法获取文档结构（with-ids）⇒ 图片未插入');
		return 0;
	}

	for (const img of images) {
		if (!img.standalone) {
			console.warn(`        ↳ ⚠ 行内/表格内图片无法自动插入（占位 ${img.placeholder} 保留）：${img.ref}`);
			continue;
		}
		try {
			const blockId = findBlockIdByText(xml, img.placeholder);
			if (!blockId) {
				console.warn(`        ↳ ⚠ 未找到占位块（${img.placeholder}）⇒ 跳过 ${img.ref}`);
				continue;
			}
			const replFile = `.kbsync-img-${img.placeholder}.xml`;
			const replPath = path.join(noteDir, replFile);
			fs.writeFileSync(replPath, `<img path="@./${img.ref}"/>`, 'utf8');
			try {
				const r = lark(['docs', '+update', '--doc', docToken, '--command', 'block_replace',
					'--block-id', blockId, '--content', `@./${replFile}`, '--doc-format', 'xml', '--as', 'user'], noteDir);
				const payload = extractJson(r.stdout);
				if (!payload || payload.ok === false) {
					throw new Error(String(payload?.error?.message ?? (r.stderr || r.stdout).slice(0, 200)));
				}
				ok++;
				console.log(`        ↳ 图片已插入: ${img.ref}`);
			} finally {
				try { fs.unlinkSync(replPath); } catch { /* 清理失败忽略 */ }
			}
			if (interval > 0) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, interval); }
		} catch (e) {
			console.warn(`        ↳ ⚠ 图片插入失败（占位 ${img.placeholder} 保留）: ${e.message}`);
		}
	}
	return ok;
}

/**
 * ★ 2026-09-24：**本地 HTML 附件链路**（实测确认的机制）。
 *
 * 用户实测 + 我方探针（`docs +create --doc-format xml`）双重确认：
 *   `<source path="@./x.html" name="x.html"/>` 上传后飞书落成
 *   `<figure view-type="Preview"><source name="x.html" mime="text/html" size="…" token="…"/></figure>`
 *   —— 即 **file block + Preview 视图**，飞书对 `text/html` 会直接**渲染页面预览**
 *   （这就是「html 作为附件传入即可正常渲染」的实现依据）。
 *
 * 链路与图片完全同构：正文里的 `![[x.html]]` → 占位 `KBSYNCFILE<n>` → 导入后
 * 用 `block_replace` 把占位块换成 `<figure view-type="Preview"><source …/></figure>`。
 *
 * ⚠ 路径约束与图片相同：`path="@./…"` 基于 **cwd（= 笔记目录）** 且必须是**本地相对路径**
 *   （实测：绝对路径会被判 `file does not exist or its path is unsafe`；跨目录 `../..`
 *   有「越界」风险）⇒ **宿主侧负责把 html 复制到笔记同级 `<note>.attachments/`
 *   并把引用改写成该相对路径**（见 kb-feishu-sync-spec §16）。
 */
const ATTACH_EXT = 'html?|htm';
/** Obsidian embed：`![[x.html]]` */
const ATTACH_REF_RE = new RegExp(`!\\[\\[([^\\]\\n]+\\.(?:${ATTACH_EXT}))\\]\\]`, 'gi');

/**
 * 抽取正文中的本地 HTML 附件引用并替换为占位标记。
 * @returns `{ markdown, attachments: [{ placeholder, ref, absPath, name, standalone }], missing, inline }`
 */
export function extractAttachments(markdown, noteDir) {
	const missing = [];
	const inline = [];
	const attachments = [];
	let index = 0;
	const out = markdown.replace(ATTACH_REF_RE, (_m, ref0, offset, whole) => {
		const ref = String(ref0 ?? '').trim();
		if (!ref || /^https?:|^data:|^file:/i.test(ref) || ref.startsWith('/')) { return _m; } // 远程/绝对引用不处理
		const absPath = path.resolve(noteDir, ref);
		if (!fs.existsSync(absPath)) { missing.push(ref); return _m; } // 找不到文件：保留原样并记录

		// 与图片同理：block_replace 是**整块**替换 ⇒ 占位必须独占段落
		const lineStart = whole.lastIndexOf('\n', offset - 1) + 1;
		const lineEnd = whole.indexOf('\n', offset);
		const line = whole.slice(lineStart, lineEnd === -1 ? whole.length : lineEnd);
		const standalone = line.trim() === _m.trim() && !line.includes('|');

		const placeholder = `KBSYNCFILE${++index}`;
		attachments.push({ placeholder, ref, absPath, name: path.basename(ref), standalone });
		if (!standalone) { inline.push(ref); }
		return standalone ? `\n\n${placeholder}\n\n` : placeholder;
	});
	return { markdown: out.replace(/\n{3,}/g, '\n\n'), attachments, missing, inline };
}

/** 把占位块替换为 `<figure view-type="Preview"><source/></figure>`（与 insertImages 同构）。 */
function insertAttachments(docToken, attachments, noteDir, interval) {
	let ok = 0;
	if (!attachments.length) { return ok; }

	const f = lark(['docs', '+fetch', '--doc', docToken, '--detail', 'with-ids', '--as', 'user'], noteDir);
	const xml = extractJson(f.stdout)?.data?.document?.content ?? '';
	if (!xml) {
		console.warn('        ↳ ⚠ 无法获取文档结构（with-ids）⇒ 附件未插入');
		return 0;
	}

	for (const att of attachments) {
		if (!att.standalone) {
			console.warn(`        ↳ ⚠ 行内/表格内附件无法自动插入（占位 ${att.placeholder} 保留）：${att.ref}`);
			continue;
		}
		try {
			const blockId = findBlockIdByText(xml, att.placeholder);
			if (!blockId) {
				console.warn(`        ↳ ⚠ 未找到占位块（${att.placeholder}）⇒ 跳过 ${att.ref}`);
				continue;
			}
			const replFile = `.kbsync-file-${att.placeholder}.xml`;
			const replPath = path.join(noteDir, replFile);
			// 显示名做 XML 转义（文件名里的 & < > 会让 XML 非法）
			const safeName = att.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
			fs.writeFileSync(replPath, `<figure view-type="Preview"><source path="@./${att.ref}" name="${safeName}"/></figure>`, 'utf8');
			try {
				const r = lark(['docs', '+update', '--doc', docToken, '--command', 'block_replace',
					'--block-id', blockId, '--content', `@./${replFile}`, '--doc-format', 'xml', '--as', 'user'], noteDir);
				const payload = extractJson(r.stdout);
				if (!payload || payload.ok === false) {
					throw new Error(String(payload?.error?.message ?? (r.stderr || r.stdout).slice(0, 200)));
				}
				ok++;
				console.log(`        ↳ 附件已插入（Preview）: ${att.ref}`);
			} finally {
				try { fs.unlinkSync(replPath); } catch { /* 清理失败忽略 */ }
			}
			if (interval > 0) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, interval); }
		} catch (e) {
			console.warn(`        ↳ ⚠ 附件插入失败（占位 ${att.placeholder} 保留）: ${e.message}`);
		}
	}
	return ok;
}

/** 提取 frontmatter（首个 --- 块）与正文。 */
export function splitFrontmatter(raw) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	if (!m) { return { frontmatter: null, body: raw, header: '' }; }
	return { frontmatter: m[1], body: raw.slice(m[0].length), header: m[0] };
}

/** 从 frontmatter 文本解析 feishu 块（简化 YAML：只取两层键值）。 */
export function parseFeishuBlock(frontmatter) {
	if (!frontmatter) { return null; }
	const lines = frontmatter.split('\n');
	const start = lines.findIndex(l => /^feishu:\s*$/.test(l));
	if (start < 0) { return null; }
	const out = {};
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^\S/.test(line)) { break; } // 回到顶层键
		const m = /^\s+([A-Za-z][\w]*):\s*(.*)$/.exec(line);
		if (m) { out[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
	}
	return Object.keys(out).length ? out : null;
}

/** 写入/更新 frontmatter 的 feishu 块，返回新文件内容。 */
export function upsertFeishuBlock(raw, block) {
	const { frontmatter, body } = splitFrontmatter(raw);
	const blockLines = ['feishu:', ...Object.entries(block).map(([k, v]) => `  ${k}: ${v}`)];
	if (frontmatter == null) {
		return `---\n${blockLines.join('\n')}\n---\n\n${raw}`;
	}
	const lines = frontmatter.split('\n');
	const start = lines.findIndex(l => /^feishu:\s*$/.test(l));
	let end = start;
	if (start >= 0) {
		end = start + 1;
		while (end < lines.length && /^\s/.test(lines[end])) { end++; }
		lines.splice(start, end - start, ...blockLines);
	} else {
		lines.push(...blockLines);
	}
	return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body : '\n' + body}`;
}

// ─── 索引（v2：spaces 映射 + files 明细；读取兼容 v1 扁平结构） ───────────────

/**
 * 把层级节点树写入指定 mindnote（**逐层 BFS**，已实测可行的唯一路径）。
 *
 * ## 为什么必须逐层
 *
 * 2026-09-22 实测的节点接口约束：
 *  · **不接受客户端自定义 `node_id`**（传了就报 `3411001 system internal error`）——
 *    节点 id 只能由服务端生成，并在响应 `data.ids[]` 里按请求顺序返回；
 *  · 子节点要挂到父节点上，`parent_id` 必须是**已存在**的服务端 id。
 * ⇒ 只能「先写父层 → 拿到 id → 再写下一层」。
 *
 * ⚠ 同层**一次批量提交**（而非每节点一次调用）：50 篇笔记的树若逐节点写要 50 次 API 调用，
 *   每次新增笔记都会重来一遍。这里依赖 `data.ids[]` 与请求顺序一致（批量接口的常规约定）；
 *   若数量不符则**中止**（宁可失败重来，也不写出层级错乱的导图）。
 *
 * @returns 写入的节点总数；**-1** 表示失败（调用方跳过本次）
 */
function writeMindmapTree(mindnoteId, nodes, tmpDir) {
	const children = new Map();      // 逻辑 id → 子节点[]
	for (const n of nodes) {
		const key = n.parent_id || '';
		if (!children.has(key)) { children.set(key, []); }
		children.get(key).push(n);
	}

	const serverId = new Map();      // 逻辑 id → 服务端 node_id
	let frontier = children.get('') ?? [];   // 根层（parent_id 为空）
	let total = 0;
	let round = 0;
	const dataFile = 'mind-nodes.json';

	while (frontier.length) {
		const payload = {
			// 每次调用唯一（幂等键；同一棵树不会重试同一 token，故用随机值即可）
			client_token: crypto.randomUUID(),
			nodes: frontier.map(n => ({
				// 根层省略 parent_id（顶层节点）
				...(n.parent_id ? { parent_id: serverId.get(n.parent_id) } : {}),
				texts: [{ element_type: 'text', text: { content: n.text } }],
			})),
		};
		fs.writeFileSync(path.join(tmpDir, dataFile), JSON.stringify(payload), 'utf8');
		const r = lark(['mindnotes', 'nodes', 'create', '--mindnote-id', mindnoteId,
			'--data', `@./${dataFile}`, '--as', 'user'], tmpDir);
		const p = extractJson(r.stdout);
		if (!p || p.ok === false) {
			console.warn(`        ↳ 节点写入失败（第 ${round + 1} 层）：${p?.error?.message ?? (r.stderr || r.stdout).slice(0, 200)}`);
			return -1;
		}
		const ids = Array.isArray(p.data?.ids) ? p.data.ids : [];
		if (ids.length !== frontier.length) {
			console.warn(`        ↳ 返回 id 数（${ids.length}）与请求（${frontier.length}）不符 ⇒ 中止（避免层级错乱）`);
			return -1;
		}
		const next = [];
		frontier.forEach((n, i) => {
			serverId.set(n.node_id, ids[i]);
			next.push(...(children.get(n.node_id) ?? []));
		});
		total += frontier.length;
		frontier = next;
		round++;
	}
	return total;
}

/**
 * 维护各知识库根目录下的「🗺 目录思维导图」（**mindnote**，飞书原生思维导图文档）。
 *
 * 需求来源：同步文件夹（知识库）根目录要有一份「飞书支持的思维导图」，且新增笔记后自动更新。
 *
 * 实现要点：
 *  · 每个 **wiki 知识库** 一篇；`my_library` 不是 wiki space（CLI 无 mindnote 创建途径）⇒ 跳过并提示；
 *  · 首次：`wiki +node-create --space-id <id> --title <MINDMAP_TITLE> --obj-type mindnote`
 *    ⇒ 拿 `obj_token`（= mindnote_id，写节点用）与 `node_token`（记账用）；
 *  · 更新：`mindnotes nodes create --mindnote-id <id> --data @nodes.json`；
 *  · 结构指纹（`mindmapHash`）未变 ⇒ **完全跳过**，不产生任何 API 调用（幂等、不打扰用户）。
 *
 * ⚠ 节点 `node_id` 由结构确定性生成（见 `buildMindmapNodes`）⇒ 重复写入是「更新同一批节点」，
 *   而不是每次追加新节点（否则导图会无限膨胀）。
 */
function updateMindmaps(args, idx, plan, spaces, logLines) {
	idx.mindmaps = idx.mindmaps ?? {};
	const groups = new Map();
	for (const p of plan) {
		const spaceId = p.targetSpace ?? '';
		if (!spaceId || spaceId === 'my_library') { continue; }   // my_library 不是 wiki space
		// 库内相对路径：`p.rel` 是**相对 vault** 的（如 `库/知识库/01-类别/笔记.md`），
		// 需依次剥掉 ①同步源根前缀（`p.src`）②类别目录前缀 —— 否则导图会多出
		// 「库 / 知识库根 / 01-类别」这几层无意义嵌套（真机实测踩到）。
		const relFromSrc = p.rel.startsWith(p.src + '/') ? p.rel.slice(p.src.length + 1) : p.rel;
		const inner = (p.category && relFromSrc.startsWith(p.category + '/'))
			? relFromSrc.slice(p.category.length + 1)
			: relFromSrc;
		if (!groups.has(spaceId)) { groups.set(spaceId, []); }
		groups.get(spaceId).push({ rel: inner, title: p.title });
	}
	if (!groups.size) { return; }

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbmind-'));
	try {
		for (const [spaceId, entries] of groups) {
			const key = Object.keys(spaces).find(k => spaces[k]?.spaceId === spaceId);
			const rootText = spaces[key]?.name || key || '知识库';
			const nodes = buildMindmapNodes(rootText, entries);
			const hash = mindmapHash(nodes);
			const rec = idx.mindmaps[spaceId];
			if (rec?.hash === hash) { continue; }     // 结构未变 ⇒ 跳过

			// ⚠ 节点接口**只增不改**（2026-09-22 实测）：同 `client_token` 重复请求被**忽略**
			//    （既不重复创建、也不更新内容），换 token 则**追加** ⇒ 无法增量更新；
			//    且**不接受自定义 `node_id`**（传了报 3411001）⇒ 只好「删旧文档 + 重建」，
			//    否则每次新增笔记都会让导图累积一批重复节点。
			if (rec?.nodeToken) {
				// ⚠ `wiki +node-delete` **必须带 `--obj-type`**（2026-09-22 实测：缺了会被拒绝，
				//   报 `--obj-type is required (one of: wiki, doc, docx, sheet, bitable, mindnote, slides, file)`）
				const del = lark(['wiki', '+node-delete', '--node-token', rec.nodeToken,
					'--obj-type', 'mindnote', '--yes', '--as', 'user'], tmpDir);
				const dp = extractJson(del.stdout);
				if (!dp || dp.ok === false) {
					console.warn(`[mindmap] ⚠ 旧导图节点删除失败 ⇒ 跳过本次更新（避免累积重复）：${dp?.error?.message ?? (del.stderr || del.stdout).slice(0, 160)}`);
					continue;
				}
			}

			const nc = lark(['wiki', '+node-create', '--space-id', spaceId, '--title', MINDMAP_TITLE,
				'--obj-type', 'mindnote', '--as', 'user'], tmpDir);
			const np = extractJson(nc.stdout);
			if (!np || np.ok === false) {
				console.warn(`[mindmap] ⚠ 无法在知识库「${rootText}」创建思维导图节点：${np?.error?.message ?? (nc.stderr || nc.stdout).slice(0, 160)}`);
				continue;
			}
			const ni = pickNodeInfo(np);
			const mindnoteId = ni.objToken;
			const nodeTokenForRecord = ni.nodeToken;
			if (!mindnoteId) { console.warn(`[mindmap] ⚠ 响应无 obj_token：${nc.stdout.slice(0, 160)}`); continue; }

			// 逐层写入（节点只能挂到已存在的服务端 id 上，见 writeMindmapTree 说明）
			const written = writeMindmapTree(mindnoteId, nodes, tmpDir);
			if (written < 0) {
				console.warn(`[mindmap] ⚠ 节点写入失败（${rootText}）⇒ 本次跳过（下次同步会重建）`);
				continue;
			}
			idx.mindmaps[spaceId] = {
				objToken: mindnoteId,
				nodeToken: nodeTokenForRecord,
				hash,
				title: MINDMAP_TITLE,
				updatedAt: new Date().toISOString(),
			};
			console.log(`[mindmap] ✓ 已重建「${rootText}」的目录思维导图（${written} 个节点）`);
			logLines.push(`${new Date().toISOString()} MINDMAP ${spaceId} ${written} ${hash}`);
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

/** 读取索引并归一化为 v2 结构。v1（扁平 `{路径: {token,hash}}`）自动迁移进 `files`。 */
export function loadIndex(vaultRoot) {
	const out = { version: INDEX_VERSION, spaces: {}, files: {}, mindmaps: {} };
	let raw = null;
	try { raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, INDEX_FILE), 'utf8')); } catch { return out; }
	if (!raw || typeof raw !== 'object') { return out; }
	if (raw.files && typeof raw.files === 'object') {
		out.spaces = (raw.spaces && typeof raw.spaces === 'object') ? raw.spaces : {};
		out.files = raw.files;
		// mindmaps：每个知识库一篇「🗺 目录思维导图」的记账 { nodeToken, objToken, hash, updatedAt }
		out.mindmaps = (raw.mindmaps && typeof raw.mindmaps === 'object') ? raw.mindmaps : {};
		return out;
	}
	for (const [rel, v] of Object.entries(raw)) { // v1 扁平结构
		if (v && typeof v === 'object' && typeof v.token === 'string') { out.files[rel] = v; }
	}
	return out;
}

export function saveIndex(vaultRoot, idx) {
	fs.writeFileSync(path.join(vaultRoot, INDEX_FILE), JSON.stringify({
		version: INDEX_VERSION,
		spaces: idx.spaces ?? {},
		files: idx.files ?? {},
		mindmaps: idx.mindmaps ?? {},
	}, null, 1), 'utf8');
}

/**
 * 从「相对 vault 的路径」推导类别 = src 目录下第 `depth` 级目录名。
 * - depth=0 ⇒ null（不分类别，全部走 --parent 落点）
 * - 文件直接位于 src 根下（如 `00-首页.md`）⇒ null（走默认落点，不新建知识库）
 */
export function categoryOf(relPath, srcDir, depth = 1) {
	if (!depth) { return null; }
	const rel = relPath.replace(/\\/g, '/');
	const prefix = srcDir.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
	if (!rel.startsWith(prefix)) { return null; }
	const dirParts = rel.slice(prefix.length).split('/').slice(0, -1).filter(Boolean);
	if (dirParts.length < depth) { return null; }
	return dirParts.slice(0, depth).join('/');
}

/**
 * 思维导图文档的固定标题（放在知识库根节点下）。
 *
 * ⚠ **不要加 emoji / 非 GBK 字符**（2026-09-22 实测踩坑）：`lark()` 在 Windows 上用
 * `shell: true`（因为 `lark-cli` 是批处理，必须经 cmd.exe 调用），参数会被拼进命令行并由
 * cmd 按**本地代码页**解释 ⇒ emoji（如 🗺）在 GBK 下无法表示 ⇒ 建节点命令静默失败
 * （表现为 `wiki +node-create` 返回解析不出错误细节、导图建不出来）。
 * 纯中文标题实测正常（同步文档标题一直如此），故此处只用中文。
 */
export const MINDMAP_TITLE = '目录思维导图';

/**
 * 生成某知识库的**思维导图节点结构**（纯函数，便于单测）。
 *
 * 结构：根 = 库名 → 目录（逐级嵌套）→ 笔记标题（叶子）。
 * `node_id` 由「层级 + 名称」**确定性哈希**得到 ⇒ 同一结构两次生成得到相同 id
 * （写入时可幂等更新，而不是不断追加新节点）。
 *
 * @param {string} rootText 根节点文字（库名）
 * @param {Array<{rel: string, title: string}>} entries 该库下的笔记（rel = 库内相对路径）
 * @returns {Array<{node_id: string, parent_id: string, text: string}>} 扁平节点列表
 */
export function buildMindmapNodes(rootText, entries) {
	const idFor = (kind, key) => `${kind}_${contentHash(key).slice(0, 10)}`;
	const nodes = [];
	const seen = new Set();
	const rootId = idFor('r', rootText || 'root');
	nodes.push({ node_id: rootId, parent_id: '', text: rootText || '知识库' });
	seen.add(rootId);

	// 目录节点按需创建（逐级向上补齐父目录）
	const dirIds = new Map([['', rootId]]);
	const ensureDir = (dir) => {
		if (dirIds.has(dir)) { return dirIds.get(dir); }
		const parts = dir.split('/');
		const parent = ensureDir(parts.slice(0, -1).join('/'));
		const id = idFor('d', dir);
		if (!seen.has(id)) {
			nodes.push({ node_id: id, parent_id: parent, text: parts[parts.length - 1] });
			seen.add(id);
		}
		dirIds.set(dir, id);
		return id;
	};

	for (const e of [...(entries ?? [])].sort((a, b) => a.rel.localeCompare(b.rel, 'zh'))) {
		const dir = e.rel.includes('/') ? e.rel.slice(0, e.rel.lastIndexOf('/')) : '';
		const parent = ensureDir(dir);
		const id = idFor('f', e.rel);
		if (seen.has(id)) { continue; }
		nodes.push({ node_id: id, parent_id: parent, text: e.title || e.rel });
		seen.add(id);
	}
	return nodes;
}

/** 思维导图**结构指纹**（纯函数）：内容未变 ⇒ 跳过远端更新，避免每次同步都写飞书。 */
export function mindmapHash(nodes) {
	return contentHash(JSON.stringify((nodes ?? []).map(n => `${n.parent_id}>${n.text}`).join('\n')));
}

/**
 * 文件「改名 / 移动」后的索引条目迁移（**纯函数**，便于单测）。
 *
 * 问题：文档改名或换目录后，`files` 里旧路径条目仍会留着 ⇒
 *  ① 同一 token 出现两条记录，索引膨胀；
 *  ② **`--prune` 会把旧路径当成「本地已删除」⇒ 误删远端节点**（数据丢失级问题）。
 * 做法：以 frontmatter 里的 `token` 为锚（token 跟随文件移动），把「token 相同但路径已变」的旧条目删掉。
 *
 * @returns 迁移清单 `[{ from, to, token }]`（供日志/UI 展示）
 */
export function migrateIndexEntries(idx, plan) {
	const tokenToRel = new Map();
	for (const p of plan) {
		if (p.feishu?.token) { tokenToRel.set(p.feishu.token, p.rel); }
	}
	const moved = [];
	for (const rel of Object.keys(idx.files ?? {})) {
		const rec = idx.files[rel];
		const nowRel = rec?.token ? tokenToRel.get(rec.token) : undefined;
		if (nowRel && nowRel !== rel) {
			// ★ 迁移而不是删除：主循环可能因「内容未变、无需搬迁」而 `continue`，
			//   若这里直接删掉，索引记录会**永久丢失** ⇒ 下次同步读不到 prevSpace/prevNode，
			//   位置调整（跨知识库搬迁）将永远不再触发。
			if (!idx.files[nowRel]) { idx.files[nowRel] = { ...rec }; }
			delete idx.files[rel];
			moved.push({ from: rel, to: nowRel, token: rec.token });
		}
	}
	return moved;
}

/**
 * 类别（目录）**改名**时的知识库映射迁移（**纯函数**，便于单测）。
 *
 * 问题：把 `01-基础概念` 改名成 `01-基础概念-新` 后，新类别名没有映射 ⇒
 * 默认会自动**新建一个知识库**，同时旧知识库仍在 ⇒ 空间重复、文档被无谓搬迁。
 * 做法：若某「未映射类别」下的文档此前所在知识库（`prevSpace`）已在映射表中，
 * 说明这是一次**类别重命名** ⇒ 把映射键改名为新类别名（复用同一 spaceId），文档无需搬迁。
 *
 * ⚠ 只处理有历史记录（`prevSpace`）的文档；v1 索引无 space 字段 ⇒ 无法判定，走新建（可接受）。
 * ⚠ 必须在「未映射类别自动建库」**之前**调用，否则会先建出新空间。
 *
 * @returns 重命名清单 `[{ from, to, spaceId }]`
 */
// ─── 用户自定义「本地目录 ↔ 飞书知识库」映射（2026-09-22）────────────────────
// 由来：原先只有「类别层级」自动推导（第 N 级目录名 = 知识库名，未映射则自动建库）。
// 现在支持用户显式指定：配置文件放在 vault 内（`<vault>/.feishu-space-map.json`），
// 由设置面板编辑；**显式映射优先于**类别层级推导。
// 为什么用文件而不是命令行参数：JSON 经 argv 传递在 Windows（shell:true）下会被引号破坏。

/** 映射配置文件（相对 vault 根）。 */
export const SPACE_MAP_FILE = '.feishu-space-map.json';

/**
 * 读取用户映射表（宽容解析：文件不存在/损坏 ⇒ 返回空数组，不影响同步）。
 * 结构：`{ version: 1, mappings: [{ dir: '库/…/01-基础概念', spaceId: '769…', spaceName: '01-基础概念' }] }`
 * 兼容极简写法：`{ mappings: { '库/…/01-基础概念': '769…' } }`（目录 → spaceId）
 */
export function loadSpaceMap(vaultRoot, fileName = SPACE_MAP_FILE) {
	let raw = null;
	try { raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, fileName), 'utf8')); } catch { return []; }
	const src = raw?.mappings;
	const out = [];
	if (Array.isArray(src)) {
		for (const m of src) {
			if (m && typeof m.dir === 'string' && typeof m.spaceId === 'string' && m.dir.trim() && m.spaceId.trim()) {
				out.push({ dir: m.dir, spaceId: m.spaceId, spaceName: typeof m.spaceName === 'string' ? m.spaceName : '' });
			}
		}
	} else if (src && typeof src === 'object') {
		for (const [dir, spaceId] of Object.entries(src)) {
			if (typeof dir === 'string' && typeof spaceId === 'string' && dir.trim() && spaceId.trim()) {
				out.push({ dir, spaceId, spaceName: '' });
			}
		}
	}
	return out;
}

/**
 * 应用「用户自定义映射」（纯函数，便于单测）。
 *
 * 语义：把映射目录（vault 内相对路径）**及其子目录**下的笔记，绑定到指定的飞书知识库；
 * 取**最长前缀**匹配（更具体的目录优先）。命中后：
 *  - `p.category` 设为该目录（类别 = 映射目录本身，而非层级推导的目录名）⇒ 后续搬迁判定自然以它为准；
 *  - `spaces[目录]` 写入 `{ spaceId, name }`（已存在则以用户配置为准覆盖）。
 *
 * ⚠ 必须在 `migrateSpaceMappings`（类别改名复用）与「未映射类别自动建库」**之前**调用，
 *    否则这些目录会先被当成「未映射类别」而新建知识库。
 *
 * @returns 应用清单 `[{ rel, dir, spaceId }]`（供日志/UI 展示）
 */
export function applyExplicitMappings(plan, spaces, mappings) {
	const list = (mappings ?? [])
		.map(m => ({ ...m, dir: String(m?.dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '') }))
		.filter(m => m.dir && m.spaceId)
		.sort((a, b) => b.dir.length - a.dir.length); // 长目录优先 ⇒ 天然实现「最长前缀」
	const applied = [];
	for (const p of plan) {
		const hit = list.find(m => p.rel === m.dir || p.rel.startsWith(m.dir + '/'));
		if (!hit) { continue; }
		p.category = hit.dir;
		spaces[hit.dir] = { spaceId: hit.spaceId, name: hit.spaceName || hit.dir };
		applied.push({ rel: p.rel, dir: hit.dir, spaceId: hit.spaceId });
	}
	return applied;
}

export function migrateSpaceMappings(spaces, plan, opts = {}) {
	// ★ 关键判据：**旧类别目录是否仍存在于本地**。
	//   「目录改名」与「文档换目录」在数据上都会表现为「旧类别无文档 + 新类别有文档 + prevSpace 指向旧类别空间」，
	//   仅凭索引无法区分 ⇒ 必须看文件系统：
	//     · 旧目录不存在  ⇒ 目录改名 ⇒ 复用原知识库（映射键迁移，文档位置不变）
	//     · 旧目录仍存在  ⇒ 文档换了目录 ⇒ **不**迁移，新类别按正常流程新建/复用其自己的知识库
	// 默认视为「旧目录已不存在」= 允许迁移（保守保持旧行为）；main 必须传入真实检查。
	const exists = opts.categoryExists ?? (() => false);
	const renamed = [];
	const handled = new Set();
	for (const p of plan) {
		if (!p.category || spaces[p.category]?.spaceId) { continue; }   // 已有映射 ⇒ 无需迁移
		if (!p.prevSpace || handled.has(p.category)) { continue; }
		const oldKey = Object.keys(spaces).find(k => spaces[k]?.spaceId === p.prevSpace);
		if (!oldKey || exists(oldKey)) { continue; }                    // 旧知识库不在映射表 / 旧目录仍在 ⇒ 不迁移
		spaces[p.category] = { ...spaces[oldKey], name: p.category, renamedFrom: oldKey };
		delete spaces[oldKey];
		handled.add(p.category);
		renamed.push({ from: oldKey, to: p.category, spaceId: p.prevSpace });
	}
	return renamed;
}

/**
 * 计算每篇文档的**目标知识库**与**是否需要跨知识库搬迁**（纯函数，便于单测）。
 *
 * - 有类别：目标 = `spaces[类别].spaceId`（未映射 ⇒ null，调用方决定跳过/建库）
 * - 无类别（src 根下文件）：目标 = null ⇒ 走 `--parent` 默认落点
 * - `needsMove`：上次落点（`prevSpace`）≠ 目标 ⇒ 需 `wiki +move`。
 *   ⚠ v1 索引没有 space 字段（prevSpace 为空）也会判为「需搬迁」：`move` 本身幂等，
 *     已在目标知识库时飞书会报错并记日志，不影响内容更新。
 *   ⚠ `create` 尚无远端节点 ⇒ 不参与搬迁（直接在目标知识库创建即可）。
 */
export function computeTargets(plan, spaces, parentSpace = 'my_library') {
	for (const p of plan) {
		// 无类别（src 根下文件）⇒ 落点是 --parent：`my_library` 可被 wiki +move 识别；
		// 其它（folder token）不属于 wiki ⇒ 传空串表示「无 wiki 目标、不搬迁」。
		p.targetSpace = p.category ? (spaces[p.category]?.spaceId ?? null) : (parentSpace || null);
		p.targetSpaceName = p.category ? (spaces[p.category]?.name ?? p.category) : parentSpace;
		// ⚠ 必须有 prevSpace（历史落点）才谈得上「需要搬迁」：
		//    prevSpace 为空 = 无历史记录（首次同步 / v1 遗留）⇒ 不做无谓 move（也避免刚落点就自我搬迁）。
		p.needsMove = !!p.targetSpace && !!p.prevSpace && p.action !== 'create' && p.prevSpace !== p.targetSpace;
	}
	return plan;
}

/** 创建飞书知识库（wiki space），返回 `{ spaceId, name, createdAt }` 或 null。 */
function createSpace(name) {
	const r = lark(['wiki', '+space-create', '--name', name, '--as', 'user']);
	const payload = extractJson(r.stdout);
	if (!payload || payload.ok === false) {
		console.warn(`[space] ✗ 创建知识库「${name}」失败：${payload?.error?.message ?? (r.stderr || r.stdout).slice(0, 200)}`);
		return null;
	}
	const d = payload.data ?? payload;
	const spaceId = d.space_id ?? d.space?.space_id ?? d.spaceId ?? '';
	if (!spaceId) {
		console.warn(`[space] ✗ 创建知识库「${name}」响应无 space_id：${r.stdout.slice(0, 200)}`);
		return null;
	}
	console.log(`[space] ✓ 已创建知识库「${name}」→ ${spaceId}`);
	return { spaceId, name, createdAt: new Date().toISOString() };
}

/** 反查 wiki 节点的 node_token（记录里可能只有 doc token）。 */
function resolveNodeToken(docToken) {
	if (!docToken) { return ''; }
	// ⚠ CLI 1.0.9x：node-get 统一入参 --node-token（可传 node_token / obj_token / URL）
	const r = lark(['wiki', '+node-get', '--node-token', docToken, '--as', 'user']);
	return pickNodeInfo(extractJson(r.stdout)).nodeToken;
}

// ─── 扫描 ────────────────────────────────────────────────────────────────────

function walk(dir, acc) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
	for (const e of entries) {
		if (e.name.startsWith('.') && !e.name.endsWith('.md')) { continue; }
		if (SKIP_DIRS.has(e.name)) { continue; }
		const full = path.join(dir, e.name);
		if (e.isDirectory()) { walk(full, acc); continue; }
		if (!/\.(md|markdown)$/i.test(e.name)) { continue; }
		if (SYS_FILES.has(e.name)) { continue; }
		acc.push(full);
	}
	return acc;
}

/** 收集待同步笔记（含判定结果、所属类别、历史上报空间）。 */
export function collectPlan(vaultRoot, srcDirs, opts = {}) {
	const depth = opts.categoryDepth ?? 1;
	const idx = opts.index ?? loadIndex(vaultRoot);
	// token → 历史记录：文件被**改名 / 移动**后 rel 变化，新路径在索引里查不到历史 ⇒
	// 用 frontmatter 的 token 反查，即可拿到上次落点（space）与节点（node）。
	// 这是「类别改名后复用原知识库」「搬迁无需额外 API 反查」的前提。
	const byToken = new Map();
	for (const rec of Object.values(idx.files ?? {})) {
		if (rec?.token) { byToken.set(rec.token, rec); }
	}
	const plan = [];
	for (const src of srcDirs) {
		const root = path.join(vaultRoot, ...src.split('/'));
		if (!fs.existsSync(root)) { continue; }
		for (const file of walk(root, [])) {
			let raw;
			try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
			const rel = path.relative(vaultRoot, file).replace(/\\/g, '/');
			const hash = contentHash(raw);
			const feishu = parseFeishuBlock(splitFrontmatter(raw).frontmatter);
			const title = titleOf(rel);
			// 「文件名（= 标题）变化」同样需要同步：CLI 1.0.9x 的 update 不带 --new-title，
			// 需额外调 `drive +update-title`。这里把它**提升为 update 动作**，从而复用同一条通路
			// （冲突检测 / 图片链路 / remoteHash 记录都照常生效）。
			// ⚠ prevTitle 为空 = 老笔记尚未记录标题 ⇒ 不因标题触发全量重写（下次内容变化时自然补记）。
			const prevTitle = feishu?.title ?? '';
			const titleChanged = !!feishu?.token && prevTitle !== '' && prevTitle !== title;
			const action = !feishu?.token ? 'create' : (feishu.hash === hash && !titleChanged ? 'skip' : 'update');
			const category = categoryOf(rel, src, depth);
			// 历史记录：优先按路径取；改名/移动后按 token 兜底（见上 byToken 说明）
			const rec = idx.files[rel] ?? (feishu?.token ? byToken.get(feishu.token) : undefined) ?? {};
			plan.push({
				file, rel, hash, action, feishu, src, category, title, prevTitle,
				prevSpace: rec.space,   // 上次同步落到的知识库（用于检测「换了类别」）
				prevNode: rec.node,     // 上次同步的 wiki 节点（跨知识库移动需要）
			});
		}
	}
	return plan.sort((a, b) => a.rel.localeCompare(b.rel));
}

// ─── lark-cli 调用 ───────────────────────────────────────────────────────────

/** 飞书 CLI 可执行名/路径：默认 `lark-cli`（走 PATH），可由 `--cli <path>` 覆盖（安装在非标准位置时）。 */
let CLI = 'lark-cli';

/**
 * 解析 `lark-cli` 的**真实 node 入口**（绕开 shell 的转义地狱）。
 *
 * ## 为什么必须绕开 shell（2026-09-23 实测事故）
 *
 * Windows 上 `lark-cli` 是 npm 生成的 `.cmd` / `.ps1`（不是可执行文件）⇒ 只能用
 * `shell: true` 经 cmd.exe 调用。而 **cmd.exe 不会为参数补引号** ⇒ 任何**含空格**的参数
 * 都会被拆成多个位置参数：
 *
 * ```
 * --title "工程实践 工具设计与 Harness"
 *   ⇒ positional arguments are not supported (got ["工具设计与" "Harness"])
 * ```
 *
 * 现象极具迷惑性：**标题不含空格的笔记同步成功、含空格的整批失败**（本地看起来「同步了」，飞书里却只多了几篇）。
 *
 * ## 做法
 *
 * 从 `.cmd` / `.ps1` 里抽出 `node_modules/.../*.js` 入口路径（`%dp0%` 等占位符替换为
 * 脚本所在目录），再用 `spawnSync(<node>, [入口, ...args], { shell: false })` 直接调用
 * —— 参数由 CreateProcess **原样传递**，空格 / 中文 / `& | % ^` 全部安全。
 *
 * 解析不出来时返回 null，调用方回退到旧的 shell 方式（手工加引号兜底）。
 */
let CLI_LAUNCH_CACHE;
function resolveCliLaunch() {
	if (CLI_LAUNCH_CACHE !== undefined) { return CLI_LAUNCH_CACHE; }
	CLI_LAUNCH_CACHE = null;
	try {
		const candidates = [];
		if (/[\\/]/.test(CLI)) {
			candidates.push(CLI);                       // 用户自定义 CLI 绝对路径
		} else {
			candidates.push(`${CLI}.cmd`, `${CLI}.ps1`); // 同目录/ PATH 下的 shim
			const npmDir = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
			candidates.push(path.join(npmDir, `${CLI}.cmd`), path.join(npmDir, `${CLI}.ps1`));
		}
		for (const shim of candidates) {
			let text;
			try { text = fs.readFileSync(shim, 'utf8'); } catch { continue; }
			// 抽第一个指向 node_modules 的 .js 入口（npm shim 的固定形态）
			const m = /([^\s"']*node_modules[^\s"']*\.js)/.exec(text);
			if (!m) { continue; }
			const dir = path.dirname(shim);
			const entry = m[1]
				.replace(/%~dp0%?/gi, dir)
				.replace(/^\$basedir[\\/]?/i, dir + path.sep);
			const abs = path.isAbsolute(entry) ? entry : path.join(dir, entry);
			if (!fs.existsSync(abs)) { continue; }
			CLI_LAUNCH_CACHE = { exe: process.execPath, prefix: [abs] };
			return CLI_LAUNCH_CACHE;
		}
	} catch { /* 解析失败 ⇒ 回退 shell 方式 */ }
	return CLI_LAUNCH_CACHE;
}

/**
 * 执行 lark-cli。
 *
 * 优先走「node 入口 + `shell:false`」（见 {@link resolveCliLaunch}，参数无需转义）；
 * 解析失败时回退旧的 `shell:true`，并**对含空格的参数手工加引号**尽量兜住。
 */
function lark(args, cwd) {
	const launch = resolveCliLaunch();
	if (launch) {
		const res = spawnSync(launch.exe, [...launch.prefix, ...args], {
			encoding: 'utf8',
			shell: false,
			cwd,
			// process.execPath 在 Electron 里是 Electron 本体 ⇒ 需以纯 node 模式运行入口脚本
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		});
		return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
	}
	// 回退：shell 模式下 cmd 不会补引号 ⇒ 含空格/特殊字符的参数手工加引号
	const safe = args.map(a => {
		const s = String(a);
		return /[\s"&|^<>]/.test(s) ? `"${s.replace(/"/g, '')}"` : s;
	});
	const res = spawnSync(CLI, safe, { encoding: 'utf8', shell: process.platform === 'win32', cwd });
	return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * 检测笔记里「飞书不会渲染」的图表源码（纯函数，便于单测）。
 *
 * ★★ 2026-09-24 实测更新（结论收敛）：
 *   · ```mermaid 围栏 —— **飞书会渲染成图**：markdown 导入（`docs +create/+update --doc-format markdown`）
 *     把它转成 `whiteboard type="mermaid"` 画板（飞书原生「文本绘图」能力，官方帮助
 *     《使用文本绘图小组件》同源；实测缩略图确认为真实图表）⇒ **不再告警、也不再转 PNG**
 *     （抢转 PNG 会把可编辑活图变成死图）。
 *     ⚠ 官方帮助 FAQ 说「Markdown 导入不支持自动识别 mermaid」——那指的是**文档 UI 上传 .md**
 *     那条通道；我们走的 CLI 服务端导入实测会转画板，以实测为准。
 *   · ```drawio / ```xml(<mxfile>) / 裸 mxGraphModel —— 仍然只会显示为**代码块**（飞书无
 *     drawio 对应格式，官方文档亦未提及）⇒ 仍需先**栅格化成 PNG** 再插入（飞书图片格式不含 SVG）。
 *
 * 本函数只负责**如实告警**（避免用户以为已经渲染好了），不改变正文。
 *
 * @returns 检测到的种类标签（当前只会是 `['drawio']`），去重
 */
export function detectUnrenderableDiagrams(markdown) {
	const kinds = new Set();
	if (!markdown) { return []; }
	// drawio 可能以 ```drawio / ```xml 代码块或裸 XML 形式出现
	// ⚠ 容忍自闭合写法（`<mxGraphModel/>`）：只写 `[\s>]` 会漏掉 `/`
	if (/<mxfile[\s/>]|<mxGraphModel[\s/>]/i.test(markdown)) { kinds.add('drawio'); }
	const fenceRe = /^[ \t]*(?:`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)/gm;
	let m;
	while ((m = fenceRe.exec(markdown))) {
		if ((m[1] ?? '').toLowerCase() === 'drawio') { kinds.add('drawio'); }
	}
	return [...kinds];
}

/** 从输出中提取首个 JSON 对象（CLI 可能混有提示行/彩色码）。 */
function extractJson(text) {
	const clean = text.replace(/\u001b\[[0-9;]*m/g, '');
	const start = clean.indexOf('{');
	const end = clean.lastIndexOf('}');
	if (start < 0 || end <= start) { return null; }
	try { return JSON.parse(clean.slice(start, end + 1)); } catch { return null; }
}

/**
 * fetch 远端文档并算「远端态指纹」（读操作；失败返回 '' 表示无法判定，不阻塞同步）。
 * 远端 markdown 是飞书转换后的形态（表格变 lark-table 等），故必须与同样是
 * 「远形态」的 remoteHash 比对，不能拿本地原文 hash 比。
 */
function fetchRemoteHash(token) {
	try {
		// ⚠ CLI 1.0.9x：fetch 需显式 --doc-format markdown；返回结构为 data.document.content
		// （旧形态是 data.markdown ⇒ 兼容两者，否则 remoteHash 永远为空、冲突检测静默失效）
		const r = lark(['docs', '+fetch', '--doc', token, '--doc-format', 'markdown', '--as', 'user']);
		const payload = extractJson(r.stdout);
		const md = payload?.data?.document?.content ?? payload?.data?.markdown;
		if (typeof md !== 'string' || !md.trim()) { return ''; }
		return contentHash(md);
	} catch { return ''; }
}

/** 宽松解析 wiki 节点信息（node-create / node-get 的返回形态：node_token / obj_token / space_id / url）。 */
export function pickNodeInfo(payload) {
	const found = { nodeToken: '', objToken: '', spaceId: '', url: '' };
	const seen = new Set();
	const walk = (node, depth) => {
		if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) { return; }
		seen.add(node);
		for (const [k, v] of Object.entries(node)) {
			if (typeof v === 'string') {
				if (!found.nodeToken && /^(node_token|nodeToken)$/.test(k) && v.length > 6) { found.nodeToken = v; }
				if (!found.objToken && /^(obj_token|objToken)$/.test(k) && v.length > 6) { found.objToken = v; }
				if (!found.spaceId && /^(space_id|spaceId|resolved_space_id)$/.test(k) && v.length > 4) { found.spaceId = v; }
				if (!found.url && /^(url|node_url)$/.test(k) && /^https?:/.test(v)) { found.url = v; }
			} else if (Array.isArray(v)) {
				v.forEach(x => walk(x, depth + 1));
			} else {
				walk(v, depth + 1);
			}
		}
	};
	walk(payload, 0);
	return found;
}

/** 宽松提取文档标识（v1/v2 返回形态不同：document_id / objToken / token / url）。 */
export function pickDocInfo(payload) {
	const found = { token: '', url: '', rev: '' };
	const seen = new Set();
	const walk = (node, depth) => {
		if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) { return; }
		seen.add(node);
		for (const [k, v] of Object.entries(node)) {
			if (typeof v === 'string') {
				if (!found.token && /^(document_id|documentId|doc_id|objToken|obj_token|node_token|token)$/.test(k) && v.length > 6) { found.token = v; }
				if (!found.url && /^(url|doc_url|node_url)$/.test(k) && /^https?:/.test(v)) { found.url = v; }
				if (!found.rev && /^(revision_id|revisionId|revision)$/.test(k)) { found.rev = v; }
			} else if (Array.isArray(v)) {
				v.forEach(x => walk(x, depth + 1));
			} else {
				walk(v, depth + 1);
			}
		}
	};
	walk(payload, 0);
	return found;
}

function titleOf(relOrBody) {
	const base = relOrBody.split('/').pop().replace(/\.(md|markdown)$/i, '');
	return base;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.cli) { CLI = args.cli; }
	if (args.help || !args.vault) { console.log(USAGE); process.exit(args.help ? 0 : 2); }
	if (!fs.existsSync(args.vault)) { console.error(`vault 不存在: ${args.vault}`); process.exit(2); }

	const idx = loadIndex(args.vault);
	const plan = collectPlan(args.vault, args.src, { categoryDepth: args.categoryDepth, index: idx });

	// ── 刷新远端基线（--refresh-remote）：把 remoteHash 更新为当前远端实算值 ──
	// 用途：① lark-cli 升级改变 fetch 导出格式后重建基线（否则下次同步会**大面积误报**「远端被手工修改」）；
	//      ② 用户确认远端无手工改动后清除既有误报。
	// ⚠ 只改本地 frontmatter 的 remoteHash，不写远端、不改索引；顺带为缺失该字段的老笔记补记。
	if (args.refreshRemote) {
		let refreshed = 0, sameCount = 0, failed = 0;
		for (const p of plan) {
			if (!p.feishu?.token) { continue; }
			const now = fetchRemoteHash(p.feishu.token);
			if (!now) { failed++; console.warn(`[refresh] ⚠ ${p.rel}: 无法获取远端内容，跳过`); continue; }
			if (now === p.feishu.remoteHash) { sameCount++; continue; }
			if (args.dryRun) {
				console.log(`[refresh] ${p.rel}: ${p.feishu.remoteHash || '(空)'} → ${now}`);
				refreshed++;
				continue;
			}
			const raw = fs.readFileSync(p.file, 'utf8');
			fs.writeFileSync(p.file, upsertFeishuBlock(raw, { ...p.feishu, remoteHash: now }), 'utf8');
			console.log(`[refresh] ✓ ${p.rel}: ${p.feishu.remoteHash || '(空)'} → ${now}`);
			refreshed++;
			if (args.interval > 0) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, args.interval); }
		}
		console.log(`\n${args.dryRun ? '(DRY-RUN) ' : ''}刷新远端基线：${refreshed} 篇${sameCount ? `（另有 ${sameCount} 篇已一致）` : ''}${failed ? `，失败 ${failed} 篇` : ''}。`);
		return;
	}
	const counts = { create: 0, update: 0, skip: 0 };
	for (const p of plan) { counts[p.action]++; }

	// ── 类别 → 飞书知识库（wiki space）：已映射直接用；未映射按开关自动创建 ──
	// 用户 2026-09-21 确认：类别 = 同步源目录下的一级目录；未映射类别默认自动建同名知识库。
	const spaces = idx.spaces;
	const createdSpaces = [];
	const unresolved = new Set();
	// ── 用户自定义映射优先（vault 内 `.feishu-space-map.json`，由设置面板维护）──
	// 用户显式指定的「本地目录 → 飞书知识库」会**覆盖**类别层级推导结果。
	// ⚠ 必须**最早**执行：后面的 `categories`（未映射类别）与「自动建库」都基于它改写后的 `p.category`，
	//    否则映射目录会先被当成一个「新类别」而多建一个无用知识库（真机验证踩到）。
	const spaceMap = loadSpaceMap(args.vault, args.spaceMap);
	const explicit = applyExplicitMappings(plan, spaces, spaceMap);
	if (explicit.length) {
		const dirs = [...new Set(explicit.map(e => e.dir))];
		console.log(`[map] 应用用户自定义映射 ${dirs.length} 条（命中 ${explicit.length} 篇）：`);
		for (const d of dirs) {
			const sp = spaces[d];
			console.log(`  · ${d} → ${sp?.spaceId}${sp?.name ? `（${sp.name}）` : ''}`);
		}
	} else if (spaceMap.length) {
		console.log(`[map] 已配置 ${spaceMap.length} 条映射，但本次没有文档命中（检查目录是否在 --src 范围内）`);
	}

	const categories = [...new Set(plan.map(p => p.category).filter(Boolean))].sort();

	// 类别（目录）**改名** ⇒ 复用原知识库映射，而不是新建一个。
	// ⚠ 必须在「未映射类别自动建库」之前执行，否则会先建出一个多余的知识库。

	// 旧类别目录是否仍存在于本地（用于区分「目录改名」与「文档换目录」）
	const categoryExists = (cat) => args.src.some(dir => fs.existsSync(path.join(args.vault, dir, ...String(cat).split('/'))));
	const renamedSpaces = migrateSpaceMappings(spaces, plan, { categoryExists });
	for (const r of renamedSpaces) {
		console.log(`[space] 类别改名：映射「${r.from}」→「${r.to}」（复用知识库 ${r.spaceId}）`);
	}

	for (const cat of categories) {
		if (spaces[cat]?.spaceId) { continue; }
		if (!args.autoCreateSpaces) { unresolved.add(cat); continue; }
		if (args.dryRun) {
			// 预览：不动远端，但填占位 spaceId —— 否则后续「是否需要跨库搬迁」无法判定、预告会失真。
			// （dry-run 不写索引，占位不会持久化）
			spaces[cat] = { spaceId: '(将创建)', name: cat };
			createdSpaces.push(cat);
			continue;
		}
		const created = createSpace(cat);
		if (created) { spaces[cat] = created; createdSpaces.push(cat); }
		else { unresolved.add(cat); }
	}

	// 每篇的目标知识库与搬迁判定（纯函数，见 computeTargets —— 单测覆盖此处语义）
	computeTargets(plan, spaces, args.parent === 'my_library' ? 'my_library' : '');

	// ── 本次报告（`--plan-file`）────────────────────────────────────────────────
	// stdout 经主进程按 GBK 解码会乱码，所以「预览了什么 / 实际做了什么」写进 UTF-8 文件给宿主工具读。
	const report = [];
	const reportItems = [];
	const say = (line) => { console.log(line); report.push(line); };
	const noteItem = (p) => {
		if (reportItems.length >= REPORT_MAX_ITEMS) { return; }
		reportItems.push(
			`${args.dryRun ? '计划' : '结果'} ${p.action} ${p.rel} → ${p.targetSpace ?? '(未映射，跳过)'}`
			+ `${p.needsMove ? ` [换知识库 ← ${p.prevSpace ?? '?'}]` : ''}`,
		);
	};

	say(`\n=== kb-feishu-sync ${args.dryRun ? '(DRY-RUN)' : '(APPLY)'} ===`);
	say(`vault: ${args.vault}`);
	say(`src:   ${args.src.join(', ')}`);
	say(`默认落点（无类别文件）: ${args.parent}`);
	say(`类别（${args.categoryDepth} 级目录）: ${categories.length} 个`);
	for (const c of categories) {
		const mapped = spaces[c]?.spaceId;
		say(`  · ${c} → ${mapped ?? (args.autoCreateSpaces ? '(将创建知识库)' : '(未映射，跳过)')}`);
	}
	if (createdSpaces.length) {
		say(`${args.dryRun ? '将创建' : '已创建'}知识库 ${createdSpaces.length} 个：${createdSpaces.join(', ')}`);
	}
	if (unresolved.size) {
		const line = `⚠ 未映射的类别（${unresolved.size} 个，其文档本次跳过）：${[...unresolved].join(', ')}`;
		console.warn(line);
		report.push(line);
	}
	const moves = plan.filter(p => p.needsMove).length;
	if (moves) { say(`⚠ 需跨知识库移动 ${moves} 篇（类别变更）：${args.dryRun ? '见下方标注' : ''}`); }
	say(`计划: create=${counts.create} update=${counts.update} skip=${counts.skip} (共 ${plan.length})\n`);

	let done = 0;
	const logLines = [];
	for (const p of plan) {
		if (args.limit && done >= args.limit) { break; }
		noteItem(p);
		const title = titleOf(p.rel);
		// 内容未变且类别也没变 ⇒ 真正跳过；「内容未变但换了类别」⇒ 仍需把节点搬到新知识库
		const moveOnly = p.action === 'skip' && p.needsMove;
		if (p.action === 'skip' && !p.needsMove) { continue; }

		// 目标落点：类别已映射 ⇒ 该知识库（wiki +node-create）；否则走 --parent 默认落点
		const spaceArg = p.targetSpace ? [`(wiki +node-create --space-id ${p.targetSpace})`] : parentArgs(args.parent);
		const dryCmd = p.action === 'create'
			? `docs +create --title "${title}" --doc-format markdown --content @./note.md ${spaceArg.join(' ')}`
			: `docs +update --doc ${p.feishu?.token ?? '(无 token)'} --command overwrite --doc-format markdown --content @./note.md`;
		const dryMove = p.needsMove
			? `\n        ⤳ 换知识库: wiki +move --node-token ${p.prevNode || '(自动反查)'} --target-space-id ${p.targetSpace}`
			: '';

		if (args.dryRun) {
			const tag = moveOnly ? 'move' : p.action;
			console.log(`[${tag}] ${p.rel}  (${p.hash})${p.category ? `  [类别 ${p.category}]` : ''}`);
			console.log(`        → ${moveOnly ? '（内容未变，仅搬迁节点）' : dryCmd}${dryMove}`);
			done++;
			continue;
		}

		// 类别未映射（自动创建被关闭或创建失败）⇒ 跳过，避免落到错误的知识库
		if (p.category && !p.targetSpace) {
			console.warn(`[skip] ⊘ ${p.rel}: 类别「${p.category}」未映射飞书知识库`);
			logLines.push(`${new Date().toISOString()} SKIP-NO-SPACE ${p.rel} ${p.category}`);
			done++;
			continue;
		}

		// 仅搬迁（内容未变，只是类别变了）：不重写正文，只移动 wiki 节点 + 更新 frontmatter/索引
		if (moveOnly) {
			const moveNode = p.prevNode || resolveNodeToken(p.feishu?.token);
			let moved = false;
			if (moveNode) {
				const mv = lark(['wiki', '+move', '--node-token', moveNode, '--target-space-id', p.targetSpace, '--as', 'user']);
				const mp = extractJson(mv.stdout);
				if (mp && mp.ok !== false) {
					moved = true;
					console.log(`[move] ✓ ${p.rel} → 知识库「${p.targetSpaceName}」`);
					logLines.push(`${new Date().toISOString()} MOVE ${p.rel} ${p.prevSpace ?? '(unknown)'} -> ${p.targetSpace}`);
				} else {
					const msg = mp?.error?.message ?? (mv.stderr || mv.stdout).slice(0, 200);
					console.warn(`[move] ⚠ ${p.rel} 移动失败（下次重试）：${msg}`);
					logLines.push(`${new Date().toISOString()} MOVE-FAILED ${p.rel} ${msg}`);
				}
			} else {
				console.warn(`[move] ⚠ ${p.rel}: 无法解析 node_token，跳过搬迁`);
			}
			if (moved) {
				const rawMove = fs.readFileSync(p.file, 'utf8');
				const blockMove = {
					token: p.feishu?.token ?? '',
					url: p.feishu?.url ?? '',
					hash: p.feishu?.hash ?? p.hash,
					remoteHash: p.feishu?.remoteHash ?? '',
					space: p.targetSpace ?? '',
					node: moveNode,
					syncedAt: p.feishu?.syncedAt ?? new Date().toISOString(),
				};
				fs.writeFileSync(p.file, upsertFeishuBlock(rawMove, blockMove), 'utf8');
				idx.files[p.rel] = {
					token: p.feishu?.token, hash: p.feishu?.hash ?? p.hash,
					space: p.targetSpace ?? '', node: moveNode, url: p.feishu?.url ?? '',
				};
			}
			done++;
			if (args.interval > 0) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, args.interval);
			}
			continue;
		}

		// apply：正文写临时文件（CLI 的 @file 要求「当前目录内的相对路径」⇒ cwd 指向临时目录）
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbsync-'));
		try {
			const raw = fs.readFileSync(p.file, 'utf8');
			const { body } = splitFrontmatter(raw);

			// 远端手改检测（规格 §2.2）：比对「远端态指纹」——同步完成后记录的 remoteHash
			// 与当前 fetch 到的远端指纹。⚠ 不能拿本地原文 hash 比（飞书 markdown 是转换后形态，
			// 表格变 lark-table、编号重排 ⇒ 两端天然不同，会比出 100% 误报）。
			// ⚠ v1 API 不返回 revision_id（实测），故用远端内容指纹替代 rev 比对。
			let conflict = '';
			if (p.action === 'update' && p.feishu?.token && p.feishu?.remoteHash) {
				const remoteNow = fetchRemoteHash(p.feishu.token);
				if (remoteNow && remoteNow !== p.feishu.remoteHash) {
					conflict = `远端已被手工修改（远端 ${remoteNow} ≠ 记录 ${p.feishu.remoteHash}）`;
					if (args.onConflict === 'skip') {
						console.warn(`[update] ⊘ ${p.rel}: ${conflict} ⇒ 按 --on-conflict skip 跳过`);
						logLines.push(`${new Date().toISOString()} CONFLICT-SKIP ${p.rel} ${conflict}`);
						continue;
					}
					console.warn(`[update] ⚠ ${p.rel}: ${conflict} ⇒ 本地覆盖（--on-conflict ${args.onConflict}）`);
					logLines.push(`${new Date().toISOString()} CONFLICT-OVERWRITE ${p.rel} ${conflict}`);
				}
			}

			// 跨知识库移动（类别变更）：先把已有节点移到目标知识库。
			// 失败**不中断** —— 内容仍照常更新，位置留待下次重试（避免因移动失败丢掉内容更新）。
			if (p.needsMove) {
				const nodeToken = p.prevNode || resolveNodeToken(p.feishu?.token);
				if (nodeToken) {
					const mv = lark(['wiki', '+move', '--node-token', nodeToken, '--target-space-id', p.targetSpace, '--as', 'user']);
					const mp = extractJson(mv.stdout);
					if (mp && mp.ok !== false) {
						console.log(`      ⤳ 已移动到知识库「${p.targetSpaceName}」`);
						logLines.push(`${new Date().toISOString()} MOVE ${p.rel} ${p.prevSpace} -> ${p.targetSpace}`);
					} else {
						const msg = mp?.error?.message ?? (mv.stderr || mv.stdout).slice(0, 200);
						console.warn(`      ⚠ 移动失败（下次重试）：${msg}`);
						logLines.push(`${new Date().toISOString()} MOVE-FAILED ${p.rel} ${msg}`);
					}
				} else {
					console.warn(`      ⚠ 无法解析 node_token，跳过移动：${p.rel}`);
				}
			}

			// 正文预处理：不注入 `# ${title}`（文档标题已由 --title 设置，注入会造成重复 H1）
			// 图片链路：本地图片引用 → 占位标记（同步后逐张处理）
			const prepared = extractImages(prepareMarkdownForSync(body.trim()), path.dirname(p.file));
			// ★ 2026-09-24：HTML 附件链路（飞书把 text/html 附件渲染成可预览的 file block ⇒
			//   「html 作为附件传入即可正常渲染」）—— 在图片抽取之后跑，两者引号不重叠。
			const preparedFiles = extractAttachments(prepared.markdown, path.dirname(p.file));
			// 2026-09-23：mermaid / drawio 在飞书里只会显示为**代码块源码**（飞书不渲染、且图片不支持 SVG）
			// ⇒ 如实告警，避免用户以为「图已经同步过去了」。
			const diagrams = detectUnrenderableDiagrams(body);
			if (diagrams.length) {
				console.warn(`      ⚠ 含 ${diagrams.join(' / ')} 图表源码：飞书会显示为代码块（不渲染成图）。`
					+ '如需图，请先渲染为 PNG 再插入（见 doc/kb-feishu-sync-spec.md §8#21）。');
				logLines.push(`${new Date().toISOString()} DIAGRAM-UNRENDERED ${p.rel} ${diagrams.join(',')}`);
			}
			if (prepared.missing?.length) {
				// ⚠ 静默保留会让用户以为「图片已同步」⇒ 必须显式告警（多为引用路径写错/图片在别处）
				console.warn(`      ⚠ ${prepared.missing.length} 处图片引用未找到文件（保留原样，未同步）：${prepared.missing.join(', ')}`);
			}
			if (prepared.inline?.length) {
				console.warn(`      ⚠ ${prepared.inline.length} 处图片为行内/表格内引用（无法自动插入，保留占位）：${prepared.inline.join(', ')}`);
			}
			if (preparedFiles.missing?.length) {
				console.warn(`      ⚠ ${preparedFiles.missing.length} 处 HTML 附件引用未找到文件（保留原样）：${preparedFiles.missing.join(', ')}`
					+ '　提示：同步前会由「附件准备」把 html 复制到笔记同级 .attachments/ 并改写引用。');
			}
			if (preparedFiles.inline?.length) {
				console.warn(`      ⚠ ${preparedFiles.inline.length} 处 HTML 附件为行内引用（无法自动插入，保留占位）：${preparedFiles.inline.join(', ')}`);
			}
			fs.writeFileSync(path.join(tmpDir, 'note.md'), `${preparedFiles.markdown}\n`, 'utf8');

			// ⚠ CLI 1.0.9x（v2 形态）命令契约：
			//   create → --title + --doc-format markdown + --content @file
			//   update → --command overwrite + --doc-format markdown + --content @file
			//   类别（wiki space）落点：先在 space 内建节点（自动建空 docx），再写入正文
			let token = '';
			let newNodeToken = '';
			if (p.action === 'create' && p.targetSpace) {
				const nc = lark(['wiki', '+node-create', '--space-id', p.targetSpace, '--title', title, '--as', 'user'], tmpDir);
				const np = extractJson(nc.stdout);
				if (!np || np.ok === false) {
					throw new Error(String(np?.error?.message ?? (nc.stderr || nc.stdout).slice(0, 300)));
				}
				const ni = pickNodeInfo(np);
				if (!ni.objToken) { throw new Error('node-create 响应无 obj_token: ' + nc.stdout.slice(0, 200)); }
				token = ni.objToken;
				newNodeToken = ni.nodeToken;
			}

			const cmdArgs = token
				? ['docs', '+update', '--doc', token, '--command', 'overwrite', '--doc-format', 'markdown', '--content', '@./note.md', '--as', 'user']
				: (p.action === 'create'
					? ['docs', '+create', '--title', title, '--doc-format', 'markdown', '--content', '@./note.md', '--as', 'user', ...parentArgs(args.parent)]
					: ['docs', '+update', '--doc', p.feishu.token, '--command', 'overwrite', '--doc-format', 'markdown', '--content', '@./note.md', '--as', 'user']);
			const r = lark(cmdArgs, tmpDir);
			const payload = extractJson(r.stdout);
			if (!payload || payload.ok === false) {
				const detail = payload?.error?.message ?? (r.stderr || r.stdout).slice(0, 300);
				throw new Error(String(detail));
			}
			const info = pickDocInfo(payload);
			token = token || info.token || p.feishu?.token;
			if (!token) { throw new Error('响应中无文档标识: ' + r.stdout.slice(0, 200)); }

			// 图片插入必须在「记录 remoteHash」之前 —— 否则远端内容已被插图改变，
			// 记录的指纹与实际不符，下次同步会误报「远端被手工修改」。
			if (prepared.images.length) {
				const inserted = insertImages(token, prepared.images, path.dirname(p.file), args.interval);
				console.log(`      ${inserted}/${prepared.images.length} 张图片插入完成`);
			}
			// HTML 附件插入（同为 block_replace 链路；必须在「记录 remoteHash」之前）
			if (preparedFiles.attachments.length) {
				const insertedFiles = insertAttachments(token, preparedFiles.attachments, path.dirname(p.file), args.interval);
				console.log(`      ${insertedFiles}/${preparedFiles.attachments.length} 个 HTML 附件插入完成`);
			}

			// 标题同步：文件名变动 ⇒ `drive +update-title`（新 CLI 无 --new-title 的替代方案）。
			// ⚠ 必须在「记录 remoteHash」之前 —— 标题会进入远端 markdown 的 <title> 行。
			if (token && p.prevTitle !== p.title) {
				const tr = lark(['drive', '+update-title', '--token', token, '--type', 'docx', '--title', p.title, '--as', 'user'], tmpDir);
				const tp = extractJson(tr.stdout);
				if (tp && tp.ok !== false && tp.data?.updated !== false) {
					console.log(`        ↳ 标题已更新: ${p.prevTitle || '(未记录)'} → ${p.title}`);
					logLines.push(`${new Date().toISOString()} TITLE ${p.rel} ${p.prevTitle || ''} -> ${p.title}`);
				} else {
					console.warn(`        ↳ ⚠ 标题更新失败（不影响正文）: ${tp?.error?.message ?? (tr.stderr || tr.stdout).slice(0, 160)}`);
				}
			}

			// 记录「远端态指纹」：后续 update 前比对它即可发现远端手工修改
			const remoteHash = fetchRemoteHash(token) || p.feishu?.remoteHash || '';
			// 记录 wiki 节点（跨知识库移动需要 node_token）：
			// 新建场景由 node-create 直接返回；更新场景反查（无类别文档不在 wiki 内 ⇒ 空）
			const nodeToken = newNodeToken || (p.targetSpace ? (resolveNodeToken(token) || p.prevNode || '') : '');
			const block = {
				token,
				url: info.url || p.feishu?.url || '',
				hash: p.hash,
				remoteHash,
				title: p.title,          // 记录本次同步的标题 ⇒ 下次改名时据此判断是否需 update-title
				space: p.targetSpace ?? '',
				node: nodeToken,
				syncedAt: new Date().toISOString(),
			};
			fs.writeFileSync(p.file, upsertFeishuBlock(raw, block), 'utf8');
			idx.files[p.rel] = { token, hash: p.hash, space: p.targetSpace ?? '', node: nodeToken, url: block.url };
			console.log(`[${p.action}] ✓ ${p.rel} → ${token}`);
			logLines.push(`${new Date().toISOString()} ${p.action} ${p.rel} ${token}`);
			done++;
			if (args.interval > 0) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, args.interval); // 同步限速
			}
		} catch (e) {
			console.error(`[${p.action}] ✗ ${p.rel}: ${e.message}`);
			logLines.push(`${new Date().toISOString()} FAILED ${p.rel} ${e.message}`);
			if (reportItems.length < REPORT_MAX_ITEMS) { reportItems.push(`失败 ${p.action} ${p.rel} — ${e.message}`); }
			// ⚠ 失败也必须计入 done：否则 `--limit 1` 会因计数不增而把全部笔记都试一遍，
			// 在「创建成功但解析失败」的场景下**批量产生孤儿文档**（真实事故：61 篇重复）。
			done++;
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	// 改名 / 移动 ⇒ 先把索引里「同一 token 的旧路径」条目去掉（否则 prune 会把旧路径当成
	// 「本地已删除」而误删远端节点 —— 数据丢失级问题）。
	const movedEntries = migrateIndexEntries(idx, plan);
	for (const m of movedEntries) {
		console.log(`[索引] 迁移改名/移动记录：${m.from} → ${m.to}`);
	}

	// prune 保险丝：任何仍被现存文档引用的 token 绝不删除
	const liveTokens = new Set(plan.map(p => p.feishu?.token).filter(Boolean));

	// ── prune（可选，默认关；用户 2026-09-21 确认「默认保留远端，可显式开启清理」） ──
	if (args.prune) {
		const localRels = new Set(plan.map(p => p.rel));
		const orphans = Object.keys(idx.files).filter(rel => !localRels.has(rel));
		if (orphans.length) {
			console.log(`\n[prune] 本地已删除 ${orphans.length} 篇${args.dryRun ? '（预览，不执行）' : ''}：`);
			for (const rel of orphans) {
				const rec = idx.files[rel];
				// 保险丝：该记录仍被现存文档引用（改名/移动残留）⇒ 绝不删远端
				if (rec?.token && liveTokens.has(rec.token)) {
					console.warn(`  · ⊘ ${rel}: 仍被现存文档引用（疑似改名残留），跳过删除`);
					continue;
				}
				if (args.dryRun) { console.log(`  · ${rel} → 将移除远端节点`); continue; }
				const nodeToken = rec?.node || (rec?.token ? resolveNodeToken(rec.token) : '');
				if (!nodeToken) { console.warn(`  · ⚠ ${rel}: 无 node_token，跳过（远端保留）`); continue; }
				// ⚠ 必须带 `--obj-type`（缺了 CLI 直接拒绝，见 mindmap 删除处的实测说明）；
				//   被同步的笔记统一是 docx。
				const r = lark(['wiki', '+node-delete', '--node-token', nodeToken, '--obj-type', 'docx', '--yes']);
				const pl = extractJson(r.stdout);
				if (pl && pl.ok !== false) {
					console.log(`  · ✓ 已移除远端节点：${rel}`);
					logLines.push(`${new Date().toISOString()} PRUNE ${rel} ${nodeToken}`);
					delete idx.files[rel];
				} else {
					console.warn(`  · ✗ ${rel}: ${pl?.error?.message ?? (r.stderr || r.stdout).slice(0, 200)}`);
				}
			}
		} else {
			console.log('\n[prune] 无本地已删除的条目。');
		}
	}

	if (!args.dryRun && !args.noMindmap) {
		// 知识库根目录的「🗺 目录思维导图」（mindnote）：新增/改名/移动后自动重建（结构未变则零调用）
		try {
			updateMindmaps(args, idx, plan, spaces, logLines);
		} catch (e) {
			console.warn(`[mindmap] ⚠ 思维导图更新失败（不影响同步结果）：${e.message}`);
		}
	}

	if (!args.dryRun) {
		if (logLines.length) {
			fs.appendFileSync(path.join(args.vault, LOG_FILE), logLines.join('\n') + '\n', 'utf8');
		}
		// 索引写回（v2：类别→知识库映射 + 每篇 token/hash/space/node + 每库思维导图）
		saveIndex(args.vault, idx);
	}
	console.log(`\n完成 ${done} 篇（skip ${counts.skip} 篇无需处理）。`);

	// ── 落盘「本次报告」：宿主工具/agent 据此回报预览计划与实际结果（不依赖 stdout 编码）──
	if (args.planFile) {
		try {
			fs.writeFileSync(args.planFile, formatSyncReport({
				dryRun: args.dryRun, vault: args.vault, src: args.src,
				done, skip: counts.skip, total: plan.length,
				summary: report, items: reportItems,
			}), 'utf8');
		} catch (e) {
			console.warn(`[report] ⚠ 写报告文件失败（不影响同步）：${e.message}`);
		}
	}
}

// 入口守卫：仅在「被当作脚本直接执行」时跑 main（被 import 时 process.argv[1] 是调用方脚本名 ⇒ 不执行）。
/**
 * 组装「本次运行报告」文本（★ 2026-09-24，配合 `--plan-file`）。
 *
 * 为什么需要：宿主工具 `kb_feishu_sync` 拿不到可用 stdout（主进程按 GBK 解码中文会乱码），
 * 而 `.feishu-sync.log` 在 **dry-run 下根本不写** ⇒ 预览时工具只能读到旧日志，agent 无从向用户
 * 交代「将创建/更新哪些篇」。⇒ 由脚本主动写这份 UTF-8 报告，工具读它并原样回传。
 *
 * 纯函数（导出以便单测）：头部（模式/vault/src/完成数）+ 汇总 + 逐篇（`计划|结果` 前缀）。
 */
export function formatSyncReport(o) {
	const header = [
		`# kb-feishu-sync ${o.dryRun ? 'DRY-RUN（预览：未写任何远端）' : 'APPLY（已写远端）'}`,
		`# 时间: ${o.at ?? new Date().toISOString()}`,
		`# vault: ${o.vault ?? ''}`,
		`# src: ${(o.src ?? []).join(', ')}`,
		`# 完成 ${o.done ?? 0} 篇（skip ${o.skip ?? 0} 篇无需处理，计划共 ${o.total ?? 0} 篇）`,
		'',
	];
	const items = o.items ?? [];
	const capped = items.length > REPORT_MAX_ITEMS
		? [...items.slice(0, REPORT_MAX_ITEMS), `…（其余 ${items.length - REPORT_MAX_ITEMS} 条见 ${LOG_FILE}）`]
		: items;
	return [...header, ...(o.summary ?? []), '', `── 逐篇（最多 ${REPORT_MAX_ITEMS} 条）──`, ...capped].join('\n') + '\n';
}


// ⚠ 不能写死 `kb-feishu-sync.mjs`：内置副本名为 `feishu-sync.mjs`（资源目录去掉了 kb- 前缀），
//   写死会导致资源副本**静默不执行**（真实故障：dry-run 无任何输出、退出码 0）。
if (process.argv[1] && /(^|[\\/])[^\\/]*feishu-sync\.mjs$/.test(process.argv[1])) { main(); }
