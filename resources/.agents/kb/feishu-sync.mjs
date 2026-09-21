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
/** 索引结构版本：v2 起含 `spaces`（类别→知识库映射）与 `files` 明细；读取时兼容 v1 扁平结构。 */
const INDEX_VERSION = 2;

// ─── 参数解析 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const out = {
		src: [], parent: 'my_library', dryRun: false, apply: false, limit: 0, interval: 800,
		vault: '', help: false, onConflict: 'overwrite', cli: '',
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

const IMAGE_EXT = 'png|jpe?g|gif|webp|svg|bmp|tiff?';
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

/** 读取索引并归一化为 v2 结构。v1（扁平 `{路径: {token,hash}}`）自动迁移进 `files`。 */
export function loadIndex(vaultRoot) {
	const out = { version: INDEX_VERSION, spaces: {}, files: {} };
	let raw = null;
	try { raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, INDEX_FILE), 'utf8')); } catch { return out; }
	if (!raw || typeof raw !== 'object') { return out; }
	if (raw.files && typeof raw.files === 'object') {
		out.spaces = (raw.spaces && typeof raw.spaces === 'object') ? raw.spaces : {};
		out.files = raw.files;
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

function lark(args, cwd) {
	const res = spawnSync(CLI, args, { encoding: 'utf8', shell: process.platform === 'win32', cwd });
	return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
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

	console.log(`\n=== kb-feishu-sync ${args.dryRun ? '(DRY-RUN)' : '(APPLY)'} ===`);
	console.log(`vault: ${args.vault}`);
	console.log(`src:   ${args.src.join(', ')}`);
	console.log(`默认落点（无类别文件）: ${args.parent}`);
	console.log(`类别（${args.categoryDepth} 级目录）: ${categories.length} 个`);
	for (const c of categories) {
		const mapped = spaces[c]?.spaceId;
		console.log(`  · ${c} → ${mapped ?? (args.autoCreateSpaces ? '(将创建知识库)' : '(未映射，跳过)')}`);
	}
	if (createdSpaces.length) {
		console.log(`${args.dryRun ? '将创建' : '已创建'}知识库 ${createdSpaces.length} 个：${createdSpaces.join(', ')}`);
	}
	if (unresolved.size) {
		console.warn(`⚠ 未映射的类别（${unresolved.size} 个，其文档本次跳过）：${[...unresolved].join(', ')}`);
	}
	const moves = plan.filter(p => p.needsMove).length;
	if (moves) { console.log(`⚠ 需跨知识库移动 ${moves} 篇（类别变更）：${args.dryRun ? '见下方标注' : ''}`); }
	console.log(`计划: create=${counts.create} update=${counts.update} skip=${counts.skip} (共 ${plan.length})\n`);

	let done = 0;
	const logLines = [];
	for (const p of plan) {
		if (args.limit && done >= args.limit) { break; }
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
			if (prepared.missing?.length) {
				// ⚠ 静默保留会让用户以为「图片已同步」⇒ 必须显式告警（多为引用路径写错/图片在别处）
				console.warn(`      ⚠ ${prepared.missing.length} 处图片引用未找到文件（保留原样，未同步）：${prepared.missing.join(', ')}`);
			}
			if (prepared.inline?.length) {
				console.warn(`      ⚠ ${prepared.inline.length} 处图片为行内/表格内引用（无法自动插入，保留占位）：${prepared.inline.join(', ')}`);
			}
			fs.writeFileSync(path.join(tmpDir, 'note.md'), `${prepared.markdown}\n`, 'utf8');

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
				const r = lark(['wiki', '+node-delete', '--node-token', nodeToken, '--yes']);
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

	if (!args.dryRun) {
		if (logLines.length) {
			fs.appendFileSync(path.join(args.vault, LOG_FILE), logLines.join('\n') + '\n', 'utf8');
		}
		// 索引写回（v2：类别→知识库映射 + 每篇 token/hash/space/node）
		saveIndex(args.vault, idx);
	}
	console.log(`\n完成 ${done} 篇（skip ${counts.skip} 篇无需处理）。`);
}

// 入口守卫：仅在「被当作脚本直接执行」时跑 main（被 import 时 process.argv[1] 是调用方脚本名 ⇒ 不执行）。
// ⚠ 不能写死 `kb-feishu-sync.mjs`：内置副本名为 `feishu-sync.mjs`（资源目录去掉了 kb- 前缀），
//   写死会导致资源副本**静默不执行**（真实故障：dry-run 无任何输出、退出码 0）。
if (process.argv[1] && /(^|[\\/])[^\\/]*feishu-sync\.mjs$/.test(process.argv[1])) { main(); }
